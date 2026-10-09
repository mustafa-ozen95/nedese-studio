/**
 * Knowledge (document search; user request 08.10.2026): passages cut at line ends with overlap, the FTS5 index (BM25,
 * Turkish letters folded), the search by meaning through a fake embedding server (fake-embed.mjs in place of
 * llama-server --embedding on the CPU) fused with BM25, documents chosen by name, the API, the agent's
 * search_knowledge tool and the chat's own documents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../lib/database.mjs';
import { CHUNK_SIZE, Knowledge, chunkText, knowledgeQuery } from '../lib/knowledge.mjs';
import { EmbedServer, embedPrefixes, findEmbedModel } from '../lib/embedding.mjs';
import { fileText } from '../lib/attachments.mjs';
import { makePdf, makeXlsx } from './document-fixtures.mjs';
import { LocalLlm } from '../lib/llm.mjs';
import { createPanel } from './env.mjs';
import { freePort } from './chat-page.mjs';

const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const FAKE_EMBED = fileURLToPath(new URL('./fake-embed.mjs', import.meta.url));
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const MODEL = { file: 'multilingual-e5-small-q8_0.gguf', name: 'multilingual-e5-small-q8_0', path: 'unused.gguf' };

test('passages: cut at line ends up to the size, the next one a little back (never the same end), long lines in pieces, the page each starts in; queries folded and OR\'ed', () => {
  const folder = mkdtempSync(join(tmpdir(), 'knowledge-chunks-'));
  const lines = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} of the long report, with some words.`);
  const pdf = join(folder, 'long.pdf');
  writeFileSync(pdf, makePdf([lines.slice(0, 30), lines.slice(30)]));
  const t = fileText(pdf);
  const chunks = chunkText(t);
  assert.ok(chunks.length >= 3, String(chunks.length));
  for (const c of chunks) assert.ok(c.text.length <= CHUNK_SIZE + 1, `${c.text.length}`);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].line > chunks[i - 1].line, 'it moves on');
    assert.ok(chunks[i].line <= chunks[i - 1].line + chunks[i - 1].lines, 'no line is skipped');
    assert.ok(chunks[i].line + chunks[i].lines > chunks[i - 1].line + chunks[i - 1].lines, 'each one ends further on');
  }
  assert.equal(chunks[0].label, 'Page 1');
  assert.equal(chunks.at(-1).label, 'Page 2');
  assert.ok(chunks.some((c) => /--- Page 2 ---/.test(c.text)), 'a page marker stays inside the passage it falls in');
  // the text of every line is in some passage
  const all = chunks.map((c) => c.text).join('\n');
  for (const l of t.lines.filter((x) => x.trim() && !x.startsWith('---'))) assert.ok(all.includes(l), l);
  // a line longer than a passage: in overlapping pieces
  const long = chunkText({ lines: ['x'.repeat(2500)], units: [] });
  assert.deepEqual(long.map((c) => [c.line, c.text.length]), [[1, 1000], [1, 1000], [1, 800]]);
  assert.deepEqual(chunkText({ lines: ['', '  ', '--- Page 1 ---', ''], units: [{ label: 'Page 1', line: 3 }] }), [], 'a marker alone is no passage');
  assert.equal(knowledgeQuery('Gelirler NASIL arttı? İstanbul a'), '"gelirler"* OR "nasil"* OR "artti"* OR "istanbul"*');
  assert.equal(knowledgeQuery('is it ok'), '"is" OR "it" OR "ok"');
  assert.equal(knowledgeQuery('?! -'), null);
});

test('embedding helpers: the model in <ai>\\llm\\embed, the prefixes a model wants, the server (fake) on its own port, closed when idle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-embed-'));
  assert.equal(findEmbedModel(root), null);
  mkdirSync(join(root, 'llm', 'embed'), { recursive: true });
  writeFileSync(join(root, 'llm', 'embed', 'multilingual-e5-small-q8_0.gguf'), Buffer.alloc(1024));
  assert.deepEqual(findEmbedModel(root), { file: 'multilingual-e5-small-q8_0.gguf', path: join(root, 'llm', 'embed', 'multilingual-e5-small-q8_0.gguf'), name: 'multilingual-e5-small-q8_0', mb: 0 });
  assert.deepEqual(embedPrefixes('multilingual-e5-small-q8_0.gguf'), { query: 'query: ', passage: 'passage: ' });
  assert.equal(embedPrefixes('embeddinggemma-300m-Q8_0.gguf').query, 'task: search result | query: ');
  assert.deepEqual(embedPrefixes('bge-m3-Q8_0.gguf'), { query: '', passage: '' });
  // the real command: llama-server on the CPU only (no layer and no CUDA device)
  const real = new EmbedServer({ setting: { aiRoot: root } });
  const c = real.command(12345);
  assert.deepEqual(c.args.slice(0, 5), ['-m', join(root, 'llm', 'embed', 'multilingual-e5-small-q8_0.gguf'), '--embedding', '-ngl', '0']);
  assert.equal(c.env.CUDA_VISIBLE_DEVICES, '-1');
  assert.equal(real.available, false, 'no llama-server in this folder');
  const log = join(root, 'embed.log');
  const e = new EmbedServer({ setting: { aiRoot: root, embedCommand: (port) => ({ command: process.execPath, args: [FAKE_EMBED, String(port)], env: { ...process.env, FAKE_EMBED_LOG: log } }) }, idleMs: 300 });
  assert.equal(e.available, true);
  const [a, b] = await e.embed(['the car is red', 'an automobile'], { kind: 'passage' });
  assert.ok(Math.abs(a.reduce((s, x) => s + x * x, 0) - 1) < 1e-5, 'unit length');
  assert.ok(a.reduce((s, x, i) => s + x * b[i], 0) > 0.3, 'car and automobile are near');
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()), ['passage: the car is red', 'passage: an automobile']);
  assert.ok(e.proc, 'running');
  for (let i = 0; i < 40 && e.proc; i++) await wait(50);
  assert.equal(e.proc, null, 'closed when idle');
  e.close();
});

test('Knowledge: documents indexed (pages, sheets), found by words (folded Turkish, BM25) and by meaning (fused), only in named documents; the same file once; removed', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'knowledge-'));
  const report = join(folder, 'report.pdf');
  writeFileSync(report, makePdf([['The board met in March.', 'Nothing else happened.'], ['Gelirler bu çeyrekte yüzde on iki arttı.', 'Giderler sabit kaldı.'], ['The new car fleet arrives in May.']]));
  const sheet = join(folder, 'budget.xlsx');
  writeFileSync(sheet, makeXlsx({ Costs: [['Item', 'Amount'], ['Rent', 900], ['Fuel for the trucks', 300]] }));
  const db = new Database(':memory:');
  const words = new Knowledge({ db, setting: { aiRoot: folder }, embedder: new EmbedServer({ setting: { aiRoot: folder }, model: null }) });
  try {
    const a = words.add({ path: report, name: 'Q3 report.pdf' });
    assert.equal(a.added, true);
    assert.deepEqual([a.document.name, a.document.type, a.document.unit, a.document.units, a.document.origin, a.document.path, a.document.source], ['Q3 report.pdf', 'PDF', 'page', 3, 'list', report, null]);
    assert.ok(a.document.chunks >= 1);
    assert.equal(words.add({ path: report, name: 'again.pdf' }).added, false, 'the same bytes: the same document');
    words.add({ path: sheet });
    assert.deepEqual(words.list().map((d) => d.name).sort(), ['Q3 report.pdf', 'budget.xlsx']);
    assert.deepEqual(words.status(), { search: 'words', model: null, chunks: words.list().reduce((n, d) => n + d.chunks, 0), embedded: 0, embedding: false, error: null });
    // Turkish without its letters, another form of the word
    const g = await words.search('gelir artışı');
    assert.equal(g.mode, 'words');
    assert.equal(g.results[0].document.name, 'Q3 report.pdf');
    assert.match(g.results[0].text, /Gelirler bu çeyrekte/);
    assert.equal(typeof g.results[0].line, 'number');
    // a sheet passage starts in its sheet
    const r = await words.search('rent amount');
    assert.equal(r.results[0].document.name, 'budget.xlsx');
    assert.equal(r.results[0].label, 'Sheet: Costs');
    assert.deepEqual(r.results[0].ranks, { words: 1, meaning: null });
    // only in a named document (by name, without its extension, or by id)
    assert.deepEqual((await words.search('rent', { documents: ['Q3 report'] })).results, []);
    assert.equal((await words.search('rent', { documents: ['budget'] })).results.length, 1);
    assert.equal((await words.search('rent', { documents: ['nothing like it'] })).note, 'None of the named documents is in Knowledge.');
    // without a model, a word the passages do not have finds nothing
    assert.deepEqual((await words.search('automobile')).results, []);
    words.remove(a.document.id);
    assert.deepEqual(words.list().map((d) => d.name), ['budget.xlsx']);
    assert.deepEqual((await words.search('gelirler')).results, []);
    assert.throws(() => words.remove('nope'), /Document not found/);
    assert.throws(() => words.add({ path: join(folder, 'missing.pdf') }), /A file is needed/);
    const bin = join(folder, 'x.bin');
    writeFileSync(bin, Buffer.from([0, 1, 2]));
    assert.throws(() => words.add({ path: bin }), /no text to search/);
  } finally {
    words.close();
  }
  // with the (fake) embedding model: vectors in the background, then a search by meaning finds the car passage
  const log = join(folder, 'embed.log');
  const embedder = new EmbedServer({ setting: { aiRoot: folder, embedCommand: (port) => ({ command: process.execPath, args: [FAKE_EMBED, String(port)], env: { ...process.env, FAKE_EMBED_LOG: log } }) }, model: MODEL, idleMs: 60000 });
  const k = new Knowledge({ db, setting: { aiRoot: folder }, embedder });
  try {
    k.add({ path: report, name: 'Q3 report.pdf' });
    assert.ok(k.embedding, 'embedding in the background');
    await k.embedding;
    // the sheet added before the model came is embedded too
    const st = k.status();
    assert.deepEqual([st.search, st.model, st.embedded === st.chunks, st.error], ['hybrid', 'multilingual-e5-small-q8_0', true, null]);
    assert.ok(k.list().every((d) => d.embedded === d.chunks));
    const m = await k.search('automobile');
    assert.equal(m.mode, 'hybrid');
    assert.match(m.results[0].text, /car fleet/);
    assert.deepEqual([m.results[0].ranks.words, m.results[0].ranks.meaning], [null, 1]);
    // both lists agree: first; the query went with its prefix
    const both = await k.search('car fleet');
    assert.match(both.results[0].text, /car fleet/);
    assert.ok(both.results[0].ranks.words && both.results[0].ranks.meaning);
    assert.ok(readFileSync(log, 'utf8').includes('"query: car fleet"'));
    // Turkish by meaning: "kazanç" is near "gelir" in the fake model
    assert.match((await k.search('kazanç')).results[0].text, /Gelirler/);
  } finally {
    k.close();
    db.close();
  }
});

/** A panel with the fake text model and the fake embedding model (a model file in <ai>\llm\embed, the fake server). */
async function knowledgePanel() {
  const llm = new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', image: true, models: [{ file: 'a.gguf', name: 'a', gib: 1, image: true }], command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port), 'a.gguf'] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
  const p = await createPanel({ server: true, llm, setting: { agentPollingMs: 50, agentBrowser: false, embedCommand: (port) => ({ command: process.execPath, args: [FAKE_EMBED, String(port)] }) } });
  mkdirSync(join(p.setting.aiRoot, 'llm', 'embed'), { recursive: true });
  writeFileSync(join(p.setting.aiRoot, 'llm', 'embed', 'multilingual-e5-small-q8_0.gguf'), Buffer.alloc(16));
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

test('Knowledge API and agent: documents added (upload or path) and listed, vectors in the background, GET /knowledge/search fused; search_knowledge offered only with documents, finds by meaning, keeps to the chat\'s documents; a chat\'s attachments join and leave with it', async () => {
  const o = await knowledgePanel();
  try {
    const chat = (await o.call('/api/v1/chat', { method: 'POST', body: {} })).json.chat;
    // no documents: no Knowledge tool
    assert.doesNotMatch(await o.send(chat.id, 'which tools'), /search_knowledge|Knowledge/);
    const pdf = makePdf([['The board met in March.'], ['The new car fleet arrives in May.']]);
    const up = await o.call('/api/v1/uploads/file?name=Fleet%20plan.pdf', { method: 'POST', raw: pdf });
    const a = await o.call('/api/v1/knowledge', { method: 'POST', body: { source: up.json.file.source, name: 'Fleet plan.pdf' } });
    assert.equal(a.code, 200, JSON.stringify(a.json));
    assert.match(a.json.message, /^Added to Knowledge: Fleet plan\.pdf \(\d+ passages?\)\.$/);
    assert.equal(a.json.added, true);
    assert.equal((await o.call('/api/v1/knowledge', { method: 'POST', body: { source: up.json.file.source } })).json.message, 'Already in Knowledge: Fleet plan.pdf.');
    const sheet = join(o.p.setting.aiRoot, 'budget.xlsx');
    writeFileSync(sheet, makeXlsx({ Costs: [['Rent', 900], ['Fuel for the trucks', 300]] }));
    const b = await o.call('/api/v1/knowledge', { method: 'POST', body: { path: sheet } });
    assert.equal(b.json.document.name, 'budget.xlsx');
    assert.equal(b.json.document.path, sheet);
    assert.equal((await o.call('/api/v1/knowledge', { method: 'POST', body: { source: 'upload/nope.pdf' } })).code, 404);
    // vectors come in the background
    let list;
    for (let i = 0; i < 100; i++) {
      list = (await o.call('/api/v1/knowledge')).json;
      if (list.status.embedded === list.status.chunks && !list.status.embedding) break;
      await wait(100);
    }
    assert.deepEqual([list.status.search, list.status.model, list.status.embedded === list.status.chunks], ['hybrid', 'multilingual-e5-small-q8_0', true], JSON.stringify(list.status));
    assert.deepEqual(list.documents.map((d) => [d.name, d.origin, d.embedded === d.chunks]), [['budget.xlsx', 'list', true], ['Fleet plan.pdf', 'list', true]]);
    const s = await o.call('/api/v1/knowledge/search?q=automobile&count=3');
    assert.equal(s.json.mode, 'hybrid');
    assert.equal(s.json.results[0].document.name, 'Fleet plan.pdf');
    assert.equal(s.json.results[0].ranks.words, null);
    assert.equal((await o.call('/api/v1/knowledge/search?q=')).code, 400);
    // the agent: offered under More tools, found by meaning, read on with read_file
    assert.match(await o.send(chat.id, 'which tools'), /the user's documents in Knowledge \(2 documents; [^)]*\): search_knowledge/);
    const found = await o.send(chat.id, 'search knowledge automobile');
    assert.match(found, /^Result \(search_knowledge\): \d passages? \(searched by words and by meaning\):\n\n\[1\] Fleet plan\.pdf · Page \d · lines \d+-\d+ · read on: read_file path "upload\/[^"]+" start_line=\d+\n/);
    assert.match(found, /car fleet/);
    assert.match(await o.send(chat.id, 'search knowledge rent in nothing'), /None of these is in Knowledge: nothing\./);
    // a chat set to the budget only: the fleet plan is not searched (the tool list says so until the tool is loaded)
    const fresh = (await o.call('/api/v1/chat', { method: 'POST', body: {} })).json.chat;
    await o.call(`/api/v1/chat/${fresh.id}`, { method: 'PATCH', body: { knowledge: ['budget'] } });
    assert.match(await o.send(fresh.id, 'which tools'), /\(1 of 2 documents chosen for this chat;/);
    const patched = await o.call(`/api/v1/chat/${chat.id}`, { method: 'PATCH', body: { knowledge: ['budget'] } });
    assert.deepEqual(patched.json.chat.knowledge, [b.json.document.id]);
    const kept = await o.send(chat.id, 'search knowledge car fleet');
    assert.doesNotMatch(kept, /Fleet plan/);
    assert.match(await o.send(chat.id, 'search knowledge car in Fleet plan'), /This chat is set to use other documents of Knowledge/);
    assert.equal((await o.call(`/api/v1/chat/${chat.id}`, { method: 'PATCH', body: { knowledge: ['no such'] } })).code, 400);
    assert.equal((await o.call(`/api/v1/chat/${chat.id}`, { method: 'PATCH', body: { knowledge: [] } })).json.chat.knowledge, null);
    // a file attached in another chat joins Knowledge, and leaves with that chat
    const other = (await o.call('/api/v1/chat', { method: 'POST', body: {} })).json.chat;
    const notes = await o.call('/api/v1/uploads/file?name=notes.md', { method: 'POST', raw: Buffer.from('# Notes\nThe office moves to Ankara in June.\n') });
    await o.send(other.id, 'keep this', [{ source: notes.json.file.source, type: 'file', name: 'notes.md' }]);
    let joined;
    for (let i = 0; i < 50 && !joined; i++) {
      joined = (await o.call('/api/v1/knowledge')).json.documents.find((d) => d.name === 'notes.md');
      if (!joined) await wait(100);
    }
    assert.deepEqual([joined.origin, joined.chat], ['chat', other.id]);
    assert.match(await o.send(chat.id, 'search knowledge ankara office'), /notes\.md/);
    assert.equal((await o.call(`/api/v1/chat/${other.id}`, { method: 'DELETE' })).code, 200);
    assert.deepEqual((await o.call('/api/v1/knowledge')).json.documents.map((d) => d.name), ['budget.xlsx', 'Fleet plan.pdf']);
    // a temporary chat leaves nothing
    const temp = (await o.call('/api/v1/chat', { method: 'POST', body: { temporary: true } })).json.chat;
    const secret = await o.call('/api/v1/uploads/file?name=secret.txt', { method: 'POST', raw: Buffer.from('A temporary secret line.\n') });
    await o.send(temp.id, 'look', [{ source: secret.json.file.source, type: 'file', name: 'secret.txt' }]);
    await wait(300);
    assert.ok(!(await o.call('/api/v1/knowledge')).json.documents.some((d) => d.name === 'secret.txt'));
    // removed: no longer found
    const r = await o.call(`/api/v1/knowledge/${a.json.document.id}`, { method: 'DELETE' });
    assert.equal(r.json.message, 'Removed from Knowledge: Fleet plan.pdf.');
    assert.equal((await o.call(`/api/v1/knowledge/${a.json.document.id}`, { method: 'DELETE' })).code, 404);
    assert.ok(!(await o.call('/api/v1/knowledge/search?q=car')).json.results.some((x) => x.document.name === 'Fleet plan.pdf'));
  } finally {
    await o.close();
  }
});
