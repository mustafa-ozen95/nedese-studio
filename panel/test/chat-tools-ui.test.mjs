/**
 * Chat tools in the browser (headless Edge/Chrome, CDP) with the fake text model: files and documents in the chat
 * (user requests 08.10.2026). No uncaught exception, console.error or red notification may happen. Skipped when the
 * machine has no Edge/Chrome. NEDESE_SHOTS=<folder> saves screenshots (phone and desktop, light and dark).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKIP, chatPage, pickFiles } from './chat-page.mjs';
import { makePdf, makeXlsx } from './document-fixtures.mjs';

const FAKE_EMBED = fileURLToPath(new URL('./fake-embed.mjs', import.meta.url));

test('UI files in the chat (phone 402 px): a PDF and a file without extension picked in the composer show as file chips (type over name, removable); sent, the model reads the PDF\'s pages and the message shows the files as links named as they were; after reopening too; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    const pdf = makePdf([['Quarterly report for the board.'], ['Costs stayed flat this quarter.']]).toString('base64');
    await pickFiles(t, [{ name: 'Q3 report.pdf', type: 'application/pdf', data: pdf }, { name: 'README', type: '', data: Buffer.from('Read me first.\n').toString('base64') }]);
    const composer = "[...document.querySelectorAll('[data-chat-attachments] .attachment-chip')]";
    assert.ok(await until(`${composer}.length === 2 && !document.querySelector('.attachment-chip--uploading')`, 10000), 'both uploaded');
    assert.deepEqual(await t.evaluate(`${composer}.map((c) => [c.classList.contains('attachment-chip--file'), c.querySelector('.file-chip__type').textContent, c.querySelector('.file-chip__name').textContent, Boolean(c.querySelector('button'))])`), [[true, 'PDF', 'Q3 report.pdf', true], [true, 'File', 'README', true]]);
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no sideways scroll');
    await o.shots('files-composer');
    await o.send('summarize this');
    assert.ok(await until(`${o.answers}.some((x) => x.includes('[Attachment Q3 report.pdf · PDF · 2 pages'))`), await t.evaluate(`${o.answers}.join('|')`));
    const answer = await t.evaluate(`${o.answers}.at(-1)`);
    // (the answer is shown as Markdown: its line breaks are not in the text)
    assert.match(answer, /--- Page 2 ---\s*Costs stayed flat this quarter\.\s*\[End of the attachment Q3 report\.pdf\]/);
    assert.match(answer, /\[Attachment README · Text file · 15 characters · source upload\/\d{8}-\d{6}-file-readme\]\s*Read me first\./);
    assert.equal(await t.evaluate(`${composer}.length`), 0, 'the composer is empty again');
    const chips = "[...document.querySelectorAll('.message--user .message__files a.file-chip')].map((a) => [a.querySelector('.file-chip__type').textContent, a.querySelector('.file-chip__name').textContent, new URL(a.href).pathname.replace(/\\/\\d{8}-\\d{6}-/, '/<time>-'), a.target])";
    const expected = [['PDF', 'Q3 report.pdf', '/file/upload/<time>-file-q3-report.pdf', '_blank'], ['File', 'README', '/file/upload/<time>-file-readme', '_blank']];
    assert.deepEqual(await t.evaluate(chips), expected);
    // the link opens the file itself
    const href = await t.evaluate("document.querySelector('.message--user .message__files a.file-chip').href");
    const got = await fetch(href);
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(await got.arrayBuffer()).toString('base64'), pdf);
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no sideways scroll');
    await o.shots('files-sent');
    // reopened: the stored names
    await t.evaluate('location.reload(), true');
    assert.ok(await until(`${o.answers}.length === 1 && document.querySelectorAll('.message__files a.file-chip').length === 2`), 'after reopening');
    assert.deepEqual(await t.evaluate(chips), expected);
    // Turkish: the attach button and the type of a file without extension
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until("document.querySelector('[data-chat-attach]').title === 'Dosya ekle: görsel, PDF, Word, Excel, PowerPoint, metin ve kod (ya da görseli Ctrl+V ile yapıştırın)'", 5000));
    assert.deepEqual((await t.evaluate(chips)).map((c) => c[0]), ['PDF', 'Dosya']);
    await o.shots('files-sent-tr');
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI Knowledge (phone 402 px): Options › Knowledge… opens its window; documents added there (search by meaning with the fake embedding model), a search shows passages, a box leaves a document out of this chat, Remove asks first; the options count them; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860, setting: { embedCommand: (port) => ({ command: process.execPath, args: [FAKE_EMBED, String(port)] }) } });
  const { t, until } = o;
  try {
    mkdirSync(join(o.p.setting.aiRoot, 'llm', 'embed'), { recursive: true });
    writeFileSync(join(o.p.setting.aiRoot, 'llm', 'embed', 'multilingual-e5-small-q8_0.gguf'), Buffer.alloc(16));
    await o.send('hello');
    assert.ok(await until(`${o.answers}.includes('EN: hello')`), 'a chat is open');
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    assert.ok(await until("document.querySelector('[data-knowledge-note]')?.textContent === 'No documents yet'", 5000));
    await t.evaluate("document.querySelector('[data-knowledge-manage]').click(), true");
    const modal = "document.querySelector('#modal-chat-knowledge')";
    assert.ok(await until(`${modal} && !${modal}.hidden`, 5000), 'the window opens');
    assert.match(await t.evaluate("document.querySelector('[data-knowledge-status]').textContent"), /^Search: by words and by meaning \(multilingual-e5-small-q8_0, on the CPU\)/);
    const pdf = makePdf([['The board met in March.'], ['The new car fleet arrives in May.']]).toString('base64');
    const xlsx = makeXlsx({ Costs: [['Rent', 900]] }).toString('base64');
    await t.evaluate(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob('${pdf}'), (c) => c.charCodeAt(0))], 'Fleet plan.pdf', { type: 'application/pdf' }));
      dt.items.add(new File([Uint8Array.from(atob('${xlsx}'), (c) => c.charCodeAt(0))], 'budget.xlsx', { type: '' }));
      const input = document.querySelector('[data-knowledge-file]');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const rows = "[...document.querySelectorAll('[data-knowledge-list] .knowledge__item')].map((r) => [r.querySelector('.knowledge__name').textContent, r.querySelector('.knowledge__meta').textContent, r.querySelector('[data-knowledge-use]')?.checked])";
    assert.ok(await until(`${rows}.length === 2 && !${rows}.some((r) => /Vectors/.test(r[1]))`, 15000), JSON.stringify(await t.evaluate(rows)));
    assert.deepEqual(await t.evaluate(rows), [['budget.xlsx', 'Excel workbook · 1 sheet · 1 passage', true], ['Fleet plan.pdf', 'PDF · 2 pages · 1 passage', true]]);
    assert.match(await t.evaluate("document.querySelector('[data-knowledge-status]').textContent"), /every passage has its vector\.$/);
    assert.equal(await t.evaluate("document.querySelector('[data-knowledge-scope]').textContent"), 'This chat searches all documents (uncheck the ones it should leave out).');
    // a search by meaning: "automobile" finds the car fleet
    await t.evaluate("(() => { const q = document.querySelector('[data-knowledge-query]'); q.value = 'automobile'; q.form.requestSubmit(); return true; })()");
    assert.ok(await until("document.querySelector('[data-knowledge-results] .knowledge__name')?.textContent === 'Fleet plan.pdf'", 5000));
    assert.match(await t.evaluate("document.querySelector('[data-knowledge-results] .knowledge__result-text').textContent"), /car fleet/);
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no sideways scroll');
    await o.shots('knowledge-window');
    // leave the fleet plan out of this chat
    await t.evaluate("(() => { const b = document.querySelector('[data-knowledge-id] [data-knowledge-use]:not(:first-child)') ?? [...document.querySelectorAll('[data-knowledge-use]')][1]; b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    const budget = (await (await fetch(`${o.p.address}/api/v1/knowledge`, { headers: { Authorization: `Bearer ${o.p.settingFile.apiKey}` } })).json()).documents.find((d) => d.name === 'budget.xlsx').id;
    assert.ok(await until(`document.querySelector('[data-knowledge-scope]').textContent === 'This chat searches only the checked documents.'`, 5000));
    assert.deepEqual(o.chat('hello').knowledge, [budget]);
    // the last box cannot be cleared
    await t.evaluate("(() => { const b = document.querySelector('[data-knowledge-use]'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    assert.ok(await until("document.querySelector('.toast')?.textContent.includes('A chat searches at least one document.')", 5000));
    assert.equal(await t.evaluate("document.querySelector('[data-knowledge-use]').checked"), true);
    // Remove asks first
    await t.evaluate("[...document.querySelectorAll('[data-knowledge-delete]')].at(-1).click(), true");
    assert.ok(await until("!document.querySelector('[data-confirm-dialog]').hidden", 5000), 'asks first');
    assert.equal(await t.evaluate("document.querySelector('[data-confirm-message]').textContent"), 'Remove "Fleet plan.pdf" from Knowledge? The file itself stays.');
    await t.evaluate("document.querySelector('[data-confirm-accept]').click(), true");
    assert.ok(await until(`${rows}.length === 1`, 5000));
    // the options count the documents of this chat
    await t.evaluate("document.querySelector('#modal-chat-knowledge [data-modal-close]').click(), true");
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    assert.ok(await until("document.querySelector('[data-knowledge-note]')?.textContent === 'This chat: 1 of 1 documents'", 5000), await t.evaluate("document.querySelector('[data-knowledge-note]')?.textContent"));
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until("document.querySelector('[data-knowledge-note]')?.textContent === 'Bu sohbet: 1 belgeden 1'", 5000), await t.evaluate("document.querySelector('[data-knowledge-note]')?.textContent"));
    await t.evaluate("document.querySelector('[data-knowledge-manage]').click(), true");
    assert.ok(await until(`${rows}.length === 1 && ${rows}[0][1] === 'Excel çalışma kitabı · 1 çalışma sayfası · 1 parça'`, 5000), JSON.stringify(await t.evaluate(rows)));
    assert.equal(await t.evaluate("document.querySelector('#chat-knowledge-title').textContent"), 'Bilgi Bankası');
    assert.match(await t.evaluate("document.querySelector('[data-knowledge-status]').textContent"), /^Arama: kelimeyle ve anlamla \(multilingual-e5-small-q8_0, işlemcide\); her parçanın vektörü hazır\.$/);
    await o.shots('knowledge-window-tr');
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI message actions (phone 402 px): code blocks in colors with Copy; under an answer Copy (its Markdown) and Read aloud (English or Turkish voice, Stop); a selection in an answer offers Quote, which puts it into the composer as a quote; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    // the clipboard and the voices are the page's: recorded here instead
    await t.evaluate(`(() => {
      window.__copied = [];
      navigator.clipboard.writeText = async (text) => { window.__copied.push(text); };
      window.__spoken = [];
      speechSynthesis.speak = (u) => window.__spoken.push(u);
      speechSynthesis.cancel = () => { window.__cancelled = (window.__cancelled ?? 0) + 1; };
      return true;
    })()`);
    await o.send('preview sample');
    assert.ok(await until(`${o.answers}.some((a) => a.startsWith('A page:'))`), 'answered');
    const blocks = "[...document.querySelectorAll('.message__code')]";
    assert.deepEqual(await t.evaluate(`${blocks}.map((b) => [b.querySelector('.message__code-lang').textContent, [...b.querySelectorAll('.message__code-buttons button')].map((x) => x.textContent)])`), [['HTML', ['Copy', 'Preview']], ['SVG', ['Copy', 'Preview']], ['js', ['Copy']]]);
    // colors: the tokens are spans, the text is the code as written
    assert.deepEqual(await t.evaluate(`[...${blocks}[2].querySelectorAll('[class^="hl-"]')].map((s) => s.className + ':' + s.textContent)`), ['hl-fn:log', "hl-string:'no preview'"]);
    assert.equal(await t.evaluate(`${blocks}[2].querySelector('code').textContent`), "console.log('no preview');");
    assert.ok(await t.evaluate(`${blocks}[0].querySelectorAll('.hl-tag').length > 4 && ${blocks}[0].querySelectorAll('.hl-keyword').length > 0`), 'HTML tags and the script inside');
    await t.evaluate(`${blocks}[2].querySelector('[data-code-copy]').click(), true`);
    assert.ok(await until("window.__copied.length === 1", 5000));
    assert.deepEqual(await t.evaluate('window.__copied'), ["console.log('no preview');"]);
    assert.equal(await t.evaluate(`${blocks}[2].querySelector('[data-code-copy]').textContent`), 'Copied');
    // Copy answer: its Markdown, as the model wrote it
    const bar = "document.querySelector('.message--assistant:not(.message--live) .message__actions')";
    assert.deepEqual(await t.evaluate(`[...${bar}.children].map((b) => b.getAttribute('aria-label'))`), ['Copy answer', 'Read aloud', 'Good answer', 'Bad answer', 'Fork chat from here', 'Regenerate the answer']);
    await t.evaluate(`${bar}.querySelector('[data-message-copy]').click(), true`);
    assert.ok(await until('window.__copied.length === 2', 5000));
    assert.equal(await t.evaluate('window.__copied[1]'), o.chat('preview sample').messages.at(-1).content);
    // Read aloud: English, the code left out; the button stops it; it ends by itself
    const speakButton = `${bar}.querySelector('[data-message-speak]')`;
    await t.evaluate(`${speakButton}.click(), true`);
    assert.deepEqual(await t.evaluate(`[${speakButton}.getAttribute('aria-pressed'), ${speakButton}.getAttribute('aria-label'), window.__spoken.length > 0, window.__spoken[0].lang, window.__spoken.map((u) => u.text).join(' ')]`), ['true', 'Stop reading', true, 'en-US', 'A page: A circle: And a script:']);
    await t.evaluate(`${speakButton}.click(), true`);
    assert.deepEqual(await t.evaluate(`[${speakButton}.getAttribute('aria-pressed'), ${speakButton}.getAttribute('aria-label')]`), ['false', 'Read aloud']);
    await t.evaluate(`(window.__spoken = [], ${speakButton}.click(), window.__spoken.at(-1).dispatchEvent(new Event('end')), true)`);
    assert.equal(await t.evaluate(`${speakButton}.getAttribute('aria-pressed')`), 'false', 'ended by itself');
    // a Turkish answer gets the Turkish voice
    await o.send('bu çok güzel bir örnek, teşekkürler');
    assert.ok(await until(`${o.answers}.some((a) => a.startsWith('EN: bu çok güzel'))`), 'answered');
    await t.evaluate("(window.__spoken = [], [...document.querySelectorAll('[data-message-speak]')].at(-1).click(), true)");
    assert.equal(await t.evaluate('window.__spoken[0].lang'), 'tr-TR');
    await t.evaluate("[...document.querySelectorAll('[data-message-speak]')].at(-1).click(), true");
    // Quote: select a part of an answer
    await t.evaluate("(() => { const p = document.querySelector('.message--assistant .message__bubble p'); p.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()");
    const quote = "document.querySelector('[data-chat-quote]')";
    assert.ok(await until(`!${quote}.hidden`, 5000), 'Quote shows beside the selection');
    assert.equal(await t.evaluate(`(() => { const r = ${quote}.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`), true, 'inside the screen');
    await o.shots('message-actions');
    await t.evaluate("(() => { const i = document.querySelector('[data-chat-input]'); i.value = 'About this:'; return true; })()");
    await t.evaluate(`${quote}.click(), true`);
    assert.equal(await t.evaluate("document.querySelector('[data-chat-input]').value"), 'About this:\n\n> A page:\n\n');
    assert.equal(await t.evaluate(`${quote}.hidden`), true);
    // a selection outside the answers shows nothing
    await t.evaluate("(() => { const p = document.querySelector('.message--user .message__bubble'); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()");
    await new Promise((ok) => setTimeout(ok, 400));
    assert.equal(await t.evaluate(`${quote}.hidden`), true);
    // Turkish labels
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until(`${bar}.querySelector('[data-message-copy]').getAttribute('aria-label') === 'Yanıtı kopyala'`, 5000));
    assert.deepEqual(await t.evaluate(`[${speakButton}.title, ${blocks}[1].querySelector('[data-code-copy]').textContent]`), ['Sesli oku', 'Kopyala']);
    await t.evaluate("(() => { const p = document.querySelector('.message--assistant .message__bubble p'); p.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()");
    assert.ok(await until(`!${quote}.hidden && ${quote}.textContent === 'Alıntıla'`, 5000));
    await o.shots('message-actions-tr');
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI regenerate (phone 402 px): only the last answer offers Regenerate, never while the chat runs; a click writes it again, the request shows 2/2 and the previous version brings the first answer back; a stopped answer offers it too; /regenerate in the composer; Turkish label (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    const shown = "[...document.querySelectorAll('[data-regenerate]')].filter((b) => !b.hidden)";
    const lastMessage = "[...document.querySelector('[data-chat-messages]').children].at(-1)";
    const lastBar = `${lastMessage}.querySelector('[data-rate-id]')`;
    await o.send('first question');
    assert.ok(await until(`${o.answers}.includes('EN: first question') && ${shown}.length === 1`), 'the first answer offers it');
    await o.send('second question');
    assert.ok(await until(`${o.answers}.includes('EN: second question') && ${shown}.length === 1 && ${lastMessage}.contains(${shown}[0])`), 'only the last answer');
    const oldAnswer = await t.evaluate(`${lastBar}.dataset.rateId`);
    await t.evaluate(`${shown}[0].click(), true`);
    assert.ok(await until(`document.querySelector('[data-branch-label]')?.textContent === '2/2' && ${lastBar}?.dataset.rateId !== ${JSON.stringify(oldAnswer)} && ${shown}.length === 1`), 'a new answer, the request shows 2/2');
    assert.deepEqual(await t.evaluate(`${o.answers}.filter((a) => a.startsWith('EN:'))`), ['EN: first question', 'EN: second question']);
    await o.shots('regenerate');
    // the previous version: the first answer comes back
    await t.evaluate("document.querySelector('[data-branch=\"previous\"]').click(), true");
    assert.ok(await until(`document.querySelector('[data-branch-label]')?.textContent === '1/2' && ${lastBar}?.dataset.rateId === ${JSON.stringify(oldAnswer)}`), 'version 1');
    // while the chat runs (here: it asks the user) nothing offers it
    await o.send('ask me');
    assert.ok(await until("document.querySelector('[data-question-card]') !== null"));
    assert.equal(await t.evaluate(`${shown}.length`), 0);
    // a stopped answer has no thumbs: Regenerate in a bar of its own
    await t.evaluate("document.querySelector('[data-chat-stop]').click(), true");
    assert.ok(await until(`${o.answers}.at(-1) === '(stopped)' && ${shown}.length === 1 && ${lastMessage}.querySelector('[data-regenerate-bar]') !== null`), 'the stopped answer offers it');
    // /regenerate: the question is asked again, as a second version of "ask me"
    await o.send('/regenerate');
    assert.ok(await until("document.querySelector('[data-question-card]') !== null && [...document.querySelectorAll('[data-branch-label]')].some((l) => l.textContent === '2/2')"), 'asked again');
    assert.equal(await t.evaluate(`${shown}.length`), 0);
    await t.evaluate("document.querySelector('[data-chat-stop]').click(), true");
    assert.ok(await until(`${shown}.length === 1`));
    // Turkish label
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until(`${shown}[0].title === 'Yanıtı yeniden yazdır'`, 5000));
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI edited files (phone 402 px): a turn that wrote and edited files ends with "Edited N files +X −Y" under its answer, a row per file (type mark, name, its own totals, New for a created file), three rows then "Show N more"; a row opens its diffs; the same after reopening; Undo takes an edit out of it (a created file undone leaves the list); Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    const idle = "document.querySelector('[data-chat-stop]').hidden";
    await o.send('write several files');
    assert.ok(await until(`document.querySelector('[data-edits]') !== null && ${idle}`), 'the summary comes when the turn ends');
    const s = o.chat('write several files');
    const edits = s.messages.filter((x) => x.role === 'tool' && x.extra?.edit).map((x) => x.extra.edit);
    assert.equal(edits.length, 5, 'four writes and an edit');
    const stat = (list) => `+${list.reduce((n, e) => n + e.added, 0)} −${list.reduce((n, e) => n + e.removed, 0)}`;
    const of = (name) => edits.filter((e) => e.path.endsWith(name));
    const read = `(() => {
      const box = document.querySelector('[data-edits]');
      if (!box) return null;
      const answer = [...document.querySelectorAll('.message__bubble')].find((b) => b.textContent.includes('Four files written'));
      return {
        title: box.querySelector('.edits__title').textContent,
        stat: box.querySelector('.edits__head .diff__stat').textContent,
        rows: [...box.querySelectorAll('[data-edits-file]')].map((r) => [r.querySelector('.edits__mark').textContent, r.querySelector('.edits__name').textContent, r.querySelector('.diff__stat').textContent, r.querySelector('.edits__tag')?.textContent ?? '', !r.hidden]),
        more: box.querySelector('[data-edits-more]')?.textContent ?? null,
        afterAnswer: Boolean(answer && answer.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING),
        wide: document.documentElement.scrollWidth > innerWidth + 1,
      };
    })()`;
    const first = {
      title: 'Edited 4 files',
      stat: stat(edits),
      rows: [['JS', 'app.js', stat(of('app.js')), 'New', true], ['#', 'style.css', stat(of('style.css')), 'New', true], ['{}', 'data.json', stat(of('data.json')), 'New', true], ['MD', 'notes.md', stat(of('notes.md')), 'New', false]],
      more: 'Show 1 more',
      afterAnswer: true,
      wide: false,
    };
    assert.deepEqual(await t.evaluate(read), first);
    assert.notEqual(stat(of('app.js')), stat([of('app.js')[0]]), 'the row of the file written and edited sums both');
    await o.shots('edited-files');
    // Show 1 more, then Show less
    await t.evaluate("document.querySelector('[data-edits-more]').click(), true");
    assert.deepEqual((await t.evaluate(read)).rows.map((r) => r[4]), [true, true, true, true]);
    assert.equal((await t.evaluate(read)).more, 'Show less');
    // a row opens the diffs of its file (the write and the edit of app.js)
    await t.evaluate("document.querySelector('[data-edits-file$=\"app.js\"] > summary').click(), true");
    assert.deepEqual(await t.evaluate("(() => { const r = document.querySelector('[data-edits-file$=\"app.js\"]'); return [r.open, r.querySelectorAll('.diff__body').length, r.querySelectorAll('.diff__line--add').length > 0]; })()"), [true, 2, true]);
    assert.equal((await t.evaluate(read)).wide, false, 'an open diff scrolls inside its box');
    await o.shots('edited-files-open');
    // reopened: the same summary from the saved messages
    await t.evaluate(`localStorage.setItem('chat.current', ${JSON.stringify(s.id)}); true`);
    await t.goto(`${o.p.address}/?r=2#chat`);
    assert.ok(await until("document.querySelector('[data-edits]') !== null"));
    assert.deepEqual(await t.evaluate(read), first);
    // Turkish labels
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until("document.querySelector('.edits__title')?.textContent === '4 dosya düzenlendi'", 5000), 'Turkish title');
    assert.equal(await t.evaluate("document.querySelector('[data-edits-more]').textContent"), '1 tane daha göster');
    assert.equal(await t.evaluate("document.querySelector('.edits__tag').textContent"), 'Yeni');
    // Undo of the edit: app.js keeps only its write
    const undoOf = (tool, name) => `(() => { const card = [...document.querySelectorAll('.tool')].find((c) => c.querySelector('.tool__name').title === ${JSON.stringify(tool)} && c.querySelector('.tool__summary').textContent.endsWith(${JSON.stringify(name)})); card.closest('.message').querySelector('[data-undo]').click(); return true; })()`;
    await t.evaluate(undoOf('edit_file', 'app.js'));
    assert.ok(await until(`document.querySelector('[data-edits-file$="app.js"] .diff__stat')?.textContent === ${JSON.stringify(stat([of('app.js')[0]]))}`, 5000), 'the undone edit left the row');
    assert.equal(await t.evaluate("document.querySelector('.edits__head .diff__stat').textContent"), stat(edits.filter((e) => e !== of('app.js')[1])));
    // Undo of a created file: it leaves the list
    await t.evaluate(undoOf('write_file', 'notes.md'));
    assert.ok(await until("document.querySelectorAll('[data-edits-file]').length === 3", 5000), 'the removed file left the list');
    assert.equal(await t.evaluate("document.querySelector('.edits__title').textContent"), '3 dosya düzenlendi');
    assert.equal(await t.evaluate("document.querySelector('[data-edits-more]')"), null, 'three rows need no more');
    await o.shots('edited-files-tr');
    assert.deepEqual(o.errors, []);
  } finally {
    for (const s of o.agent.chats.values()) if (s.work) o.agent.stop(s.id);
    await o.close();
  }
});

test('UI always allow (phone 402 px): in Manual mode a file write\'s approval card offers Always allow with the rule it keeps; a click approves and the next write runs without a card; Options lists the rule and its × removes it; an irreversible call (delete) offers none; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  const asked = [];
  o.agent.events.on('event', (e) => e.type === 'approval' && asked.push(e));
  try {
    const written = `${o.answers}.filter((a) => a === 'Written.').length`;
    const idle = "!document.querySelector('[data-approval-card]') && document.querySelector('[data-chat-stop]').hidden";
    await o.send('/mode manual');
    assert.ok(await until("document.querySelector('[data-chat-options-label]').textContent.includes('Manual')", 5000));
    await o.send('write first');
    assert.ok(await until("document.querySelector('[data-approval-always]') !== null"), 'the card offers Always allow');
    assert.equal(await t.evaluate("document.querySelectorAll('[data-approval-allow] [data-allow-chip]').length"), 1);
    assert.deepEqual(await t.evaluate("[...document.querySelector('[data-approval-card]').querySelectorAll('button')].map((b) => b.textContent)"), ['Approve', 'Always allow', 'Reject']);
    await o.shots('always-allow-card');
    await t.evaluate("document.querySelector('[data-approval-always]').click(), true");
    assert.ok(await until(`${written} === 1 && ${idle}`), 'approved and answered');
    const chat = () => [...o.agent.chats.values()].find((c) => c.title?.startsWith('write'));
    assert.deepEqual(chat().allow, [{ tool: 'write_file' }]);
    // the next write runs without a card
    await o.send('write second');
    assert.ok(await until(`${written} === 2`), 'answered');
    assert.equal(asked.length, 1, 'no second approval');
    // Options: the rule, and its × removes it
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    assert.ok(await until("document.querySelector('[data-allow-list]') !== null", 5000));
    assert.equal(await t.evaluate("document.querySelectorAll('[data-allow-rule]').length"), 1);
    await o.shots('always-allow-options');
    await t.evaluate("document.querySelector('[data-allow-remove]').click(), true");
    assert.ok(await until("document.querySelector('[data-allow-list]') === null", 5000), 'removed');
    assert.equal(chat().allow, undefined);
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    // an irreversible call: approve or reject, nothing for good
    await o.send('delete yazilan.txt');
    assert.ok(await until("document.querySelector('[data-approval-card]') !== null"));
    assert.equal(await t.evaluate("document.querySelector('[data-approval-always]')"), null);
    await t.evaluate("[...document.querySelectorAll('[data-approval-card] button')].find((b) => b.textContent === 'Reject').click(), true");
    assert.ok(await until(idle), 'rejected');
    // Turkish labels: the card and Options
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    await o.send('write third');
    assert.ok(await until("document.querySelector('[data-approval-always]')?.textContent === 'Her zaman izin ver'"), 'Turkish card');
    await o.shots('always-allow-card-tr');
    await t.evaluate("document.querySelector('[data-approval-always]').click(), true");
    assert.ok(await until(idle));
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    assert.ok(await until("document.querySelector('[data-allow-list] .chat__options-title')?.textContent === 'Her zaman izinli'", 5000));
    await o.shots('always-allow-options-tr');
    assert.deepEqual(o.errors, []);
  } finally {
    for (const s of o.agent.chats.values()) if (s.work) o.agent.stop(s.id);
    await o.close();
  }
});
