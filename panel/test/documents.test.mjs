/**
 * Documents in the chat (user request 08.10.2026: "Pdf exel vs desteği yok"): PDF pages, Excel sheets by name,
 * PowerPoint slides and Word read as text with markers; the attachment's text with the message, cut to the room the
 * context has, the rest with read_file on the same lines; uploads of any file for the chat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentParts, pdfPages, pdfText } from '../lib/read-document.mjs';
import { attachmentText, fileText, readableKind } from '../lib/attachments.mjs';
import { LocalLlm } from '../lib/llm.mjs';
import { createPanel } from './env.mjs';
import { makeDocx, makeLoosePdf, makePdf, makePptx, makeXlsx } from './document-fixtures.mjs';

const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const freePort = () => new Promise((ok) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});

test('document parts: PDF pages through the page tree (nested, packed in an object stream), XLSX sheets by name, PPTX slides, DOCX; a PDF without a page tree is one part', () => {
  const pdf = makePdf([['First page starts here.', 'It has two lines.'], ['Second page text.'], ['Third (and last) page.']]);
  assert.deepEqual(documentParts(pdf, '.pdf'), { unit: 'page', parts: [{ label: 'Page 1', text: 'First page starts here.\n\nIt has two lines.' }, { label: 'Page 2', text: 'Second page text.' }, { label: 'Page 3', text: 'Third (and last) page.' }] });
  // the whole text is what pdfText read before (training data and the knowledge base keep it)
  assert.equal(pdfText(pdf), 'First page starts here.\n\nIt has two lines.\n\nSecond page text.\n\nThird (and last) page.');
  assert.deepEqual(pdfPages(makePdf([['Packed page one.'], ['Packed page two.']], { packed: true })), ['Packed page one.', 'Packed page two.']);
  assert.equal(pdfPages(makeLoosePdf(['Loose text here.'])), null);
  assert.deepEqual(documentParts(makeLoosePdf(['Loose text here.']), '.pdf'), { unit: null, parts: [{ label: null, text: 'Loose text here.' }] });
  // a page without text stays a page (its number still counts)
  assert.deepEqual(pdfPages(makePdf([['Words on one.'], ['12'], ['Words on three.']])), ['Words on one.', '', 'Words on three.']);
  assert.deepEqual(documentParts(makeXlsx({ Sales: [['Month', 'Total'], ['May', 120]], 'Q&A 2024': [['Question'], ['Why?']] }), '.xlsx'), { unit: 'sheet', parts: [{ label: 'Sheet: Sales', text: 'Month | Total\nMay | 120' }, { label: 'Sheet: Q&A 2024', text: 'Question\nWhy?' }] });
  const slides = Array.from({ length: 11 }, (_, i) => [`Slide text ${i + 1}`]);
  assert.deepEqual(documentParts(makePptx(slides), '.pptx').parts.map((p) => p.label + ':' + p.text).slice(8), ['Slide 9:Slide text 9', 'Slide 10:Slide text 10', 'Slide 11:Slide text 11'], 'slides in number order (10 after 9)');
  assert.deepEqual(documentParts(makeDocx(['# Heading', 'Body text & more.']), '.docx'), { unit: null, parts: [{ label: null, text: '## Heading\n\nBody text & more.' }] });
  assert.deepEqual(documentParts(Buffer.from('not a zip'), '.xlsx'), { unit: 'sheet', parts: [] }, 'a broken file has no text (no error)');
  assert.equal(documentParts(Buffer.from('x'), '.txt'), null);
});

test('attachment text: head line, cut at a line end with what is left (lines, pages) and the read_file call; text files, UTF-16, binary and empty files', () => {
  const folder = mkdtempSync(join(tmpdir(), 'attachments-'));
  const pdf = join(folder, 'r.pdf');
  writeFileSync(pdf, makePdf([['First page starts here.', 'It has two lines.'], ['Second page text.'], ['Third (and last) page.']]));
  assert.equal(readableKind(pdf), 'document');
  const t = fileText(pdf);
  assert.deepEqual(t.lines, ['--- Page 1 ---', 'First page starts here.', '', 'It has two lines.', '--- Page 2 ---', 'Second page text.', '--- Page 3 ---', 'Third (and last) page.']);
  assert.deepEqual(t.units.map((u) => u.line), [1, 5, 7]);
  assert.equal(attachmentText(pdf, { source: 'upload/r.pdf', name: 'report.pdf' }), `[Attachment report.pdf · PDF · 3 pages, 81 characters · source upload/r.pdf]\n${t.lines.join('\n')}\n[End of the attachment report.pdf]`);
  const cut = attachmentText(pdf, { source: 'upload/r.pdf', name: 'report.pdf', limit: 50 });
  assert.equal(cut, '[Attachment report.pdf · PDF · 3 pages, 81 characters · source upload/r.pdf]\n--- Page 1 ---\nFirst page starts here.\n\n[… 89 more characters not shown (lines 4-8, pages 1-3). To go on: read_file with path "upload/r.pdf" and start_line=4.]\n[End of the attachment report.pdf as shown]');
  assert.match(attachmentText(pdf, { source: 'upload/r.pdf', limit: 50, full: false }), /To go on: the rest is not readable in this chat \(no file access\)\.\]/);
  // sheets are named in what is left
  const xlsx = join(folder, 'b.xlsx');
  writeFileSync(xlsx, makeXlsx({ Sales: [['Month', 'Total'], ['May', 120]], Costs: [['Rent', 900]] }));
  assert.match(attachmentText(xlsx, { limit: 25 }), /\(lines 2-5, sheets "Sales" to "Costs"\)/);
  // a text file as it is; a minified one-line file shows its start
  const code = join(folder, 'app.js');
  writeFileSync(code, 'const a = 1;\nconsole.log(a);\n');
  assert.equal(readableKind(code), 'text');
  assert.equal(attachmentText(code, { source: 'upload/app.js' }), '[Attachment app.js · JS file · 29 characters · source upload/app.js]\nconst a = 1;\nconsole.log(a);\n\n[End of the attachment app.js]');
  const min = join(folder, 'min.js');
  writeFileSync(min, 'x'.repeat(100));
  assert.match(attachmentText(min, { limit: 10 }), /\nxxxxxxxxxx\n\[… 91 more characters not shown \(lines 1-1\)\. To go on: read_file with path "[^"]+" and start_line=1\.\]/);
  // Windows-1254 Turkish (a few invalid UTF-8 bytes) is still text; UTF-16 with its mark is read
  const legacy = join(folder, 'eski.txt');
  writeFileSync(legacy, Buffer.concat([Buffer.from('Merhaba d'), Buffer.from([0xfc]), Buffer.from('nya, bu bir deneme metnidir ve uzundur.')]));
  assert.equal(readableKind(legacy), 'text');
  const utf16 = join(folder, 'u.txt');
  writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Günaydın', 'utf16le')]));
  assert.match(attachmentText(utf16), /\nGünaydın\n/);
  const binary = join(folder, 'a.bin');
  writeFileSync(binary, Buffer.from([1, 0, 2, 0, 3]));
  assert.equal(readableKind(binary), null);
  assert.equal(fileText(binary), null);
  assert.equal(attachmentText(binary, { source: 'upload/a.bin' }), '[Attachment a.bin (upload/a.bin): a binary file; it cannot be read as text, but tools can use it by its path.]');
  const scanned = join(folder, 'scan.pdf');
  writeFileSync(scanned, makePdf([['12'], ['34']]));
  assert.match(attachmentText(scanned), /\n\[No text could be read from it \(a scanned or encrypted document has none\)\.\]$/);
});

/** A panel with the fake text model; send waits for the answer. */
async function documentPanel() {
  const llm = new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', image: true, models: [{ file: 'a.gguf', name: 'a', gib: 1, image: true }], command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port), 'a.gguf'] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
  const p = await createPanel({ server: true, llm, setting: { agentPollingMs: 50, agentBrowser: false } });
  const call = async (path, { method = 'GET', body, raw } = {}) => {
    const h = { Accept: 'application/json', Authorization: `Bearer ${p.settingFile.apiKey}` };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (raw !== undefined) h['Content-Type'] = 'application/octet-stream';
    const r = await fetch(p.address + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : raw });
    return { code: r.status, json: await r.json().catch(() => ({})) };
  };
  const send = async (id, text, attachments) => {
    const r = await call(`/api/v1/chat/${id}/message`, { method: 'POST', body: { text, attachments, wait: true } });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    return r.json.response;
  };
  return { p, call, send, agent: p.http.agent, async close() { await llm.close(); await p.close(); } };
}

test('documents in a chat: POST /uploads/file takes any file; the model gets a document\'s text with the message (pages marked, named), cut to its room, the rest with read_file on the same lines; older messages keep a short start', async () => {
  const o = await documentPanel();
  try {
    const pdf = makePdf([['Quarterly report for the board.', 'Revenue grew by twelve percent.'], ['Costs stayed flat this quarter.']]);
    const up = await o.call('/api/v1/uploads/file?name=Q3%20report.pdf', { method: 'POST', raw: pdf });
    assert.equal(up.code, 200, JSON.stringify(up.json));
    assert.equal(up.json.file.kind, 'document');
    assert.equal(up.json.file.name, 'Q3 report.pdf');
    assert.match(up.json.file.source, /^upload\/\d{8}-\d{6}-file-q3-report\.pdf$/);
    const chat = (await o.call('/api/v1/chat', { method: 'POST', body: {} })).json.chat;
    const answer = await o.send(chat.id, 'summarize this', [{ source: up.json.file.source, type: 'file', name: 'Q3 report.pdf' }]);
    assert.ok(answer.startsWith(`EN: summarize this\n[Attachment Q3 report.pdf · PDF · 2 pages, 95 characters · source ${up.json.file.source}]\n--- Page 1 ---\nQuarterly report for the board.\n\nRevenue grew by twelve percent.\n--- Page 2 ---\nCosts stayed flat this quarter.\n[End of the attachment Q3 report.pdf]`), answer);
    const stored = o.agent.get(chat.id).messages.find((m) => m.role === 'user');
    assert.deepEqual(stored.attachments, [{ source: up.json.file.source, type: 'file', name: 'Q3 report.pdf' }]);
    // a long text file: cut at a line end to the room of the context (a quarter of it), the rest with read_file
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}: ${'data '.repeat(4)}`);
    const log = await o.call('/api/v1/uploads/file?name=server.log', { method: 'POST', raw: Buffer.from(lines.join('\n')) });
    assert.equal(log.json.file.kind, 'text');
    const long = await o.send(chat.id, 'what failed', [{ source: log.json.file.source, type: 'file', name: 'server.log' }]);
    const next = Number(/start_line=(\d+)\.\]/.exec(long)?.[1]);
    assert.ok(next > 100 && next < 4000, long.slice(-400));
    assert.ok(long.length < 25000, `cut to the room: ${long.length}`);
    assert.match(long, new RegExp(`\\nline ${next - 1}: data data data data \\n\\[… [\\d,]+ more characters not shown \\(lines ${next}-4000\\)\\. To go on: read_file with path "${log.json.file.source}" and start_line=${next}\\.\\]`));
    // read_file reads the attachment by its source, from that line
    const read = await o.send(chat.id, `read file ${log.json.file.source} from ${next}`);
    assert.match(read, new RegExp(`^Result \\(read_file\\): .*server\\.log: lines ${next}-\\d+ of 4000; more: read_file with start_line=\\d+\\n${next}\\tline ${next}: `));
    // a document through read_file: its extracted text on the same lines as in the message
    const page = await o.send(chat.id, `read file ${up.json.file.source} from 5`);
    assert.match(page, /^Result \(read_file\): \S+\.pdf \(PDF, 2 pages; its text\): lines 5-6 of 6\n5\t--- Page 2 ---\n6\tCosts stayed flat this quarter\.$/);
    // the first message is no longer one of the last two: its document keeps a short start (here all of it fits)
    const s = o.agent.get(chat.id);
    const sent = await o.agent.translateMessages(s, null);
    const users = sent.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.at(-1).text));
    assert.match(users[0], /\[End of the attachment Q3 report\.pdf\]/);
    assert.match(users[1], /\[… [\d,]+ more characters not shown \(lines \d+-4000\)\. To go on: read_file with path "[^"]+" and start_line=\d+\.\]/);
    assert.ok(users[1].length < 2000, `an older message keeps a short start: ${users[1].length}`);
    // the context gauge counts the attachments
    assert.ok(o.agent.estimateContext(s) > 1000, String(o.agent.estimateContext(s)));
    // a binary file is listed by its source; an attachment that is no longer on disk says so
    const bin = await o.call('/api/v1/uploads/file?name=blob.bin', { method: 'POST', raw: Buffer.from([0, 1, 2, 3, 0]) });
    assert.equal(bin.json.file.kind, 'binary');
    const b = await o.send(chat.id, 'and this', [{ source: bin.json.file.source, type: 'file', name: 'blob.bin' }]);
    assert.equal(b, `EN: and this\n[Attachments: ${bin.json.file.source} (file, blob.bin) — can be given to tools as "source"]`);
    // the name is cleaned: no path signs in the stored file
    const odd = await o.call(`/api/v1/uploads/file?name=${encodeURIComponent('../../a b?.T X T')}`, { method: 'POST', raw: Buffer.from('hello') });
    assert.match(odd.json.file.source, /^upload\/\d{8}-\d{6}-file-a-b\.txt$/);
    // the Markdown export names the files
    const md = await fetch(`${o.p.address}/api/v1/chat/${chat.id}/export?format=md`, { headers: { Authorization: `Bearer ${o.p.settingFile.apiKey}` } });
    assert.match(await md.text(), new RegExp(`Attachments: Q3 report\\.pdf \\(${up.json.file.source}\\)`));
  } finally {
    await o.close();
  }
});
