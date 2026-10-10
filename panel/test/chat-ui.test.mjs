/**
 * Chat features in the browser (headless Edge/Chrome, CDP) with the fake text model (fake-llm.mjs): rating answers,
 * editing and forking, previews, presets, templates, management screens (user requests 08.10.2026). No uncaught
 * exception or console.error may happen. Skipped when the machine has no Edge/Chrome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeRemote } from './fake-remote-llm.mjs';
import { SKIP, chatPage, wait } from './chat-page.mjs';

test('UI chat rating: thumbs under each answer (also the one just streamed), saved with the message, shown again after reopening; counted in Settings and offered in Training; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage();
  const { t, until } = o;
  try {
    // the recorder of red notifications works
    await t.evaluate("window.NedesePanel.notify('Sample failure.', 'danger'), true");
    for (let i = 0; i < 20 && !o.errors.length; i++) await wait(50);
    assert.deepEqual(o.errors.splice(0), ['console.error: toast: Sample failure.']);
    await o.send('rate me');
    assert.ok(await until(`${o.answers}.includes('EN: rate me')`), 'the answer is there');
    // the answer that just arrived has the thumbs (no reload)
    const bar = "document.querySelector('.message--assistant:not(.message--live) .message__actions')";
    assert.ok(await until(`Boolean(${bar})`, 5000), 'thumbs under the answer');
    const pressed = `[...${bar}.querySelectorAll('[data-rate]')].map((b) => [b.dataset.rate, b.getAttribute('aria-pressed'), b.getAttribute('aria-label')])`;
    assert.deepEqual(await t.evaluate(pressed), [['1', 'false', 'Good answer'], ['-1', 'false', 'Bad answer']]);
    const answer = () => o.chat('rate me').messages.find((m) => m.role === 'assistant');
    assert.equal(await t.evaluate(`${bar}.dataset.rateId`), answer().id, 'the bar is for that message');
    // thumbs up: saved; the same again: taken back; thumbs down
    const click = (rate) => t.evaluate(`${bar}.querySelector('[data-rate="${rate}"]').click(), true`);
    await click(1);
    for (let i = 0; i < 50 && answer().rating !== 1; i++) await wait(100);
    assert.equal(answer().rating, 1);
    assert.deepEqual((await t.evaluate(pressed)).map((x) => x[1]), ['true', 'false']);
    await click(1);
    for (let i = 0; i < 50 && 'rating' in answer(); i++) await wait(100);
    assert.ok(!('rating' in answer()), 'pressed again: no rating');
    await click(-1);
    for (let i = 0; i < 50 && answer().rating !== -1; i++) await wait(100);
    assert.equal(answer().rating, -1);
    // a rating made elsewhere (API, another device) shows at once
    o.agent.rate(o.chat('rate me').id, answer().id, 1);
    assert.ok(await until(`${bar}.querySelector('[data-rate="1"]').getAttribute('aria-pressed') === 'true'`, 5000), 'the rating event updates the thumbs');
    // reopened: the thumbs show the stored rating
    await t.goto(`${o.p.address}/#chat`);
    assert.ok(await until(`${o.answers}.includes('EN: rate me')`), 'the chat opens again');
    assert.ok(await until(`${bar}?.querySelector('[data-rate="1"]').getAttribute('aria-pressed') === 'true'`, 5000), 'after reopening');
    // Settings: the count and the download; Training: the good answers as a data choice
    await t.evaluate("location.hash = '#settings'; true");
    assert.ok(await until("document.querySelector('[data-ratings-count]')?.textContent === 'Rated answers: 1 good, 0 bad' && !document.querySelector('[data-ratings]').hidden", 5000), 'Settings shows the count');
    assert.equal(await t.evaluate("document.querySelector('[data-ratings-download]').disabled"), false);
    await t.evaluate("location.hash = '#training'; true");
    assert.ok(await until("[...document.querySelectorAll('[data-training-collection-choice] label')].some((l) => l.textContent === 'Good answers from rated chats (1)' && l.querySelector('input').value === 'chats/rated')", 5000), 'Training offers the good answers');
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(); location.hash = '#chat'; true");
    assert.ok(await until(`${bar}?.querySelector('[data-rate="1"]').getAttribute('aria-label') === 'İyi yanıt'`, 5000), 'Turkish label');
    assert.equal(await t.evaluate(`${bar}.querySelector('[data-rate="-1"]').title`), 'Kötü yanıt');
    await t.evaluate("location.hash = '#settings'; true");
    assert.ok(await until("document.querySelector('[data-ratings-count]')?.textContent === 'Puanlanan yanıtlar: 1 iyi, 0 kötü'", 5000), await t.evaluate("document.querySelector('[data-ratings-count]')?.textContent"));
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI chat edit and fork (phone 402 px): a message is edited in place and sent again, the switcher under it shows 2/2 and brings version 1 back, Escape cancels; Fork opens a new chat with the messages up to that answer; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    await o.send('one');
    assert.ok(await until(`${o.answers}.includes('EN: one')`));
    await o.send('two');
    assert.ok(await until(`${o.answers}.includes('EN: two')`));
    const users = "[...document.querySelectorAll('.message--user .message__bubble')].map((b) => b.textContent)";
    // Edit the first message: the box shows its text; Escape puts the message back
    const firstEdit = "document.querySelectorAll('.message--user [data-message-edit-button]')[0]";
    await t.evaluate(`${firstEdit}.click(), true`);
    assert.equal(await t.evaluate("document.querySelector('[data-message-edit-input]')?.value"), 'one');
    assert.equal(await t.evaluate("document.activeElement === document.querySelector('[data-message-edit-input]')"), true, 'the box has the focus');
    await t.evaluate("document.querySelector('[data-message-edit-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true");
    assert.equal(await t.evaluate("Boolean(document.querySelector('[data-message-edit]'))"), false, 'Escape cancels');
    assert.equal(await t.evaluate("document.querySelector('.message--user .message__bubble').hidden"), false, 'the message is back');
    // edit and send
    await t.evaluate(`${firstEdit}.click(), true`);
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'the editor fits the phone');
    await t.evaluate("(() => { document.querySelector('[data-message-edit-input]').value = 'one edited'; document.querySelector('[data-message-edit]').requestSubmit(); return true; })()");
    assert.ok(await until(`${o.answers}.join('|') === 'EN: one edited'`), await t.evaluate(`${o.answers}.join('|')`));
    assert.deepEqual(await t.evaluate(users), ['one edited']);
    const label = "document.querySelector('[data-branch-label]')?.textContent";
    assert.equal(await t.evaluate(label), '2/2');
    assert.equal(await t.evaluate("document.querySelector('[data-branch=\"next\"]').disabled"), true);
    // version 1 back with what followed it
    await t.evaluate("document.querySelector('[data-branch=\"previous\"]').click(), true");
    assert.ok(await until(`${label} === '1/2'`, 5000));
    assert.deepEqual(await t.evaluate(users), ['one', 'two']);
    assert.deepEqual(await t.evaluate(o.answers), ['EN: one', 'EN: two']);
    assert.equal(o.chat('one').messages[0].content, 'one');
    // reopened: the same version and switcher
    await t.goto(`${o.p.address}/#chat`);
    assert.ok(await until(`${label} === '1/2'`, 10000), 'after reopening');
    // Fork from the first answer: a new chat with those two messages
    await t.evaluate("document.querySelector('.message--assistant [data-fork]').click(), true");
    assert.ok(await until("document.querySelector('[data-chat-title]').textContent === 'one (2)'", 5000), await t.evaluate("document.querySelector('[data-chat-title]').textContent"));
    assert.ok(await until(`${o.answers}.join('|') === 'EN: one'`, 5000));
    assert.deepEqual(await t.evaluate(users), ['one']);
    assert.ok(await until("[...document.querySelectorAll('[data-chat-items] .chat__item-name')].some((x) => x.textContent === 'one (2)')", 5000), 'in the chat list');
    await o.send('three');
    assert.ok(await until(`${o.answers}.join('|') === 'EN: one|EN: three'`));
    assert.deepEqual(o.chat('one').messages.filter((m) => m.role === 'user').map((m) => m.content), ['one', 'two'], 'the first chat stays');
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until("document.querySelector('.message--user [data-message-edit-button]')?.getAttribute('aria-label') === 'Mesajı düzenle'", 5000));
    assert.equal(await t.evaluate("document.querySelector('[data-fork]').title"), 'Sohbeti buradan ayır');
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI chat presets (phone 402 px): added in their window from Options, chosen for a new chat (its settings show beside the options), the chat starts with its instructions; changed and deleted (with the confirm dialog); Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    const options = "document.querySelector('[data-chat-options]')";
    await t.evaluate(`${options}.click(), true`);
    assert.ok(await until("document.querySelector('[data-chat-options-panel]').textContent.includes('No presets yet')", 5000));
    await t.evaluate("document.querySelector('[data-presets-manage]').click(), true");
    const modal = "document.getElementById('modal-chat-presets')";
    assert.ok(await until(`${modal} && !${modal}.hidden`, 5000), 'the window opens');
    assert.equal(await t.evaluate("document.querySelector('[data-chat-options-panel]').hidden"), true, 'the options close');
    assert.match(await t.evaluate("document.querySelector('[data-preset-list]').textContent"), /No presets yet/);
    // add one
    const fillForm = (values) => t.evaluate(`(() => { const f = document.querySelector('[data-preset-form]'); for (const [k, v] of Object.entries(${JSON.stringify(values)})) f.elements[k].value = v; f.requestSubmit(); return true; })()`);
    await fillForm({ name: 'Coder', prompt: 'Answer with code first.', thinking: 'high', approvalMode: 'manual' });
    assert.ok(await until("[...document.querySelectorAll('[data-preset-list] .preset-list__name')].map((x) => x.textContent).join() === 'Coder'", 5000));
    assert.equal(await t.evaluate("document.querySelector('[data-preset-form-title]').textContent"), 'Edit preset', 'the saved one is open for editing');
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'the window fits the phone');
    const p = o.agent.presets()[0];
    assert.deepEqual([p.name, p.prompt, p.thinking, p.approvalMode, p.model, p.cwd], ['Coder', 'Answer with code first.', 'high', 'manual', null, null]);
    await t.evaluate(`${modal}.querySelector('[data-modal-close]').click(), true`);
    // choose it for a new chat: the label beside the options shows it and its settings
    await t.evaluate(`${options}.click(), true`);
    assert.ok(await until(`Boolean(document.querySelector('input[name="chat-preset"][value="${p.id}"]'))`, 5000));
    await t.evaluate(`(() => { const r = document.querySelector('input[name="chat-preset"][value="${p.id}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    assert.equal(await t.evaluate("document.querySelector('[data-chat-options-label]').textContent"), 'Coder · Manual · Thinking: Long');
    assert.equal(await t.evaluate("localStorage.getItem('chat.preset')"), p.id, 'remembered on this device');
    await t.evaluate(`${options}.click(), true`);
    await o.send('which preset');
    assert.ok(await until(`${o.answers}.includes('Preset Coder: Answer with code first.')`), await t.evaluate(`${o.answers}.join('|')`));
    const chat = o.chat('which preset');
    assert.deepEqual([chat.preset.name, chat.approvalMode, chat.thinking], ['Coder', 'manual', 'high']);
    await t.evaluate(`${options}.click(), true`);
    assert.ok(await until("[...document.querySelectorAll('.chat__options-note')].some((x) => x.textContent === 'Coder')", 5000), 'the open chat shows its preset');
    // change it: click it in the list, a new text, save
    await t.evaluate("document.querySelector('[data-presets-manage]').click(), true");
    assert.ok(await until(`!${modal}.hidden`, 5000));
    await t.evaluate("document.querySelector('[data-preset-id]').click(), true");
    assert.equal(await t.evaluate("document.querySelector('[data-preset-form]').elements.prompt.value"), 'Answer with code first.');
    await fillForm({ prompt: 'Be brief.' });
    for (let i = 0; i < 50 && o.agent.presets()[0].prompt !== 'Be brief.'; i++) await wait(100);
    assert.equal(o.agent.presets()[0].prompt, 'Be brief.');
    assert.equal(o.agent.presets()[0].thinking, 'high', 'the other fields stay');
    // delete: the confirm dialog first
    await t.evaluate("document.querySelector('[data-preset-delete]').click(), true");
    assert.ok(await until("!document.querySelector('[data-confirm-dialog]').hidden", 5000), 'asks first');
    assert.match(await t.evaluate("document.querySelector('[data-confirm-message]').textContent"), /^Delete the preset "Coder"\?/);
    await t.evaluate("document.querySelector('[data-confirm-accept]').click(), true");
    for (let i = 0; i < 50 && o.agent.presets().length; i++) await wait(100);
    assert.deepEqual(o.agent.presets(), []);
    assert.ok(await until("document.querySelector('[data-preset-list]').textContent.includes('No presets yet')", 5000));
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until(`${modal}.querySelector('.modal__title').textContent === 'Asistan ön ayarları'`, 5000));
    assert.equal(await t.evaluate("document.querySelector('[data-preset-save]').textContent"), 'Ön ayarı kaydet');
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI projects (phone 402 px, user request 10.10.2026): made in the Projects window from the chat list, which then shows that project and puts the next chat in it (its instructions reach the model); All chats tags the chat with its project; Options moves it out; the window keeps the project\'s notes; deleting asks first and keeps the chat; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    await t.evaluate("document.querySelector('[data-chat-list-toggle]').click(), true");
    assert.ok(await until("document.querySelector('[data-chat-project]')?.offsetParent !== null", 5000), 'the project bar shows in the open list');
    assert.deepEqual(await t.evaluate("[...document.querySelector('[data-chat-project]').options].map((x) => x.textContent)"), ['All chats']);
    await t.evaluate("document.querySelector('[data-projects-manage]').click(), true");
    const modal = "document.getElementById('modal-chat-projects')";
    assert.ok(await until(`${modal} && !${modal}.hidden`, 5000), 'the window opens');
    assert.match(await t.evaluate("document.querySelector('[data-project-list]').textContent"), /No projects yet/);
    assert.equal(await t.evaluate("document.querySelector('[data-project-notes-field]').hidden"), true, 'notes only for a saved project');
    const fillForm = (values) => t.evaluate(`(() => { const f = document.querySelector('[data-project-form]'); for (const [k, v] of Object.entries(${JSON.stringify(values)})) f.elements[k].value = v; f.requestSubmit(); return true; })()`);
    await fillForm({ name: 'Website', description: 'The shop site', instructions: 'Use plain HTML only.' });
    assert.ok(await until("[...document.querySelectorAll('[data-project-list] .preset-list__name')].map((x) => x.textContent).join() === 'Website'", 5000));
    assert.equal(await t.evaluate("document.querySelector('[data-project-form-title]').textContent"), 'Edit project');
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'the window fits the phone');
    const p = o.agent.projects()[0];
    assert.deepEqual([p.name, p.description, p.instructions], ['Website', 'The shop site', 'Use plain HTML only.']);
    // its notes, kept in the window
    await t.evaluate("(() => { document.querySelector('[data-project-form]').elements.note.value = 'the shop sells tea'; document.querySelector('[data-project-note-add]').click(); return true; })()");
    assert.ok(await until("[...document.querySelectorAll('[data-project-note]')].map((x) => x.textContent).join() === 'the shop sells tea×'", 5000));
    assert.deepEqual(o.agent.notes(o.agent.projectMemoryFile(p.id)).map((n) => n.text), ['the shop sells tea']);
    assert.deepEqual(o.agent.notes(), [], 'not a panel note');
    await t.evaluate(`${modal}.querySelector('[data-modal-close]').click(), true`);
    // the list now shows the new project, and the next chat goes into it
    assert.equal(await t.evaluate("document.querySelector('[data-chat-project]').value"), p.id);
    assert.equal(await t.evaluate("localStorage.getItem('chat.project')"), p.id);
    assert.equal(await t.evaluate("document.querySelector('[data-chat-project-info]').textContent"), 'The shop site');
    assert.match(await t.evaluate("document.querySelector('[data-chat-items]').textContent"), /No chats in this project yet/);
    await o.send('which project');
    assert.ok(await until(`${o.answers}.includes('Project Website: Use plain HTML only.')`), await t.evaluate(`${o.answers}.join('|')`));
    assert.equal(o.chat('which project').project, p.id);
    assert.equal(await t.evaluate("document.querySelector('[data-chat-options-label]').textContent.startsWith('Website · ')"), true, 'the options label names the project');
    await t.evaluate("document.querySelector('[data-chat-list-toggle]').click(), true");
    assert.ok(await until("[...document.querySelectorAll('[data-chat-item] .chat__item-name')].map((x) => x.textContent).join() === 'which project'", 5000));
    assert.ok(await until(`[...document.querySelector('[data-chat-project]').options].map((x) => x.textContent).join('|') === 'All chats|Website (1)'`, 5000), 'the count');
    // All chats: the chat carries its project's name
    await t.evaluate("(() => { const s = document.querySelector('[data-chat-project]'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    assert.ok(await until("document.querySelector('[data-chat-item] .chat__item-project')?.textContent === 'Website'", 5000), 'tagged in All chats');
    // Options › Project: out of the project
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    assert.ok(await until(`Boolean(document.querySelector('input[name="chat-project"][value="${p.id}"]')?.checked)`, 5000));
    await t.evaluate("(() => { const r = document.querySelector('input[name=\"chat-project\"][value=\"\"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    for (let i = 0; i < 50 && o.chat('which project').project; i++) await wait(100);
    assert.equal(o.chat('which project').project, undefined);
    assert.ok(await until("!document.querySelector('[data-chat-item] .chat__item-project')", 5000), 'no tag any more');
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    // delete: asks first; the chat stays
    await t.evaluate("document.querySelector('[data-chat-list-toggle]').click(), true");
    await t.evaluate("document.querySelector('[data-projects-manage]').click(), true");
    assert.ok(await until(`!${modal}.hidden`, 5000));
    await t.evaluate("document.querySelector('[data-project-id]').click(), true");
    await t.evaluate("document.querySelector('[data-project-delete]').click(), true");
    assert.ok(await until("!document.querySelector('[data-confirm-dialog]').hidden", 5000), 'asks first');
    assert.match(await t.evaluate("document.querySelector('[data-confirm-message]').textContent"), /^Delete the project "Website"\?/);
    await t.evaluate("document.querySelector('[data-confirm-accept]').click(), true");
    for (let i = 0; i < 50 && o.agent.projects().length; i++) await wait(100);
    assert.deepEqual(o.agent.projects(), []);
    assert.ok(o.chat('which project'), 'the chat stays');
    assert.ok(await until("document.querySelector('[data-project-list]').textContent.includes('No projects yet')", 5000));
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until(`${modal}.querySelector('.modal__title').textContent === 'Projeler' && document.querySelector('[data-project-save]').textContent === 'Projeyi kaydet'`, 5000));
    assert.equal(await t.evaluate("document.querySelector('[data-chat-project]').options[0].textContent"), 'Tüm sohbetler');
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI prompt templates: managed in the /templates window, offered under "/" after the commands; picking one asks for its variables (Enter goes on, Escape cancels) and puts the filled text in the box without sending; one without variables fills the box at once; typed in full it works too (headless browser)', SKIP, async () => {
  const o = await chatPage();
  const { t, until } = o;
  try {
    const type = (text) => t.evaluate(`(() => { const i = document.querySelector('[data-chat-input]'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const key = (k, target = '[data-chat-input]') => t.evaluate(`document.querySelector(${JSON.stringify(target)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })), true`);
    const box = "document.querySelector('[data-chat-input]').value";
    // /templates opens the window
    await type('/templates');
    await key('Enter');
    const modal = "document.getElementById('modal-prompt-templates')";
    assert.ok(await until(`${modal} && !${modal}.hidden`, 5000), 'the window opens');
    assert.equal(await t.evaluate(box), '', 'the command left the box');
    const add = async (values) => {
      await t.evaluate(`(() => { const f = document.querySelector('[data-template-edit]'); for (const [k, v] of Object.entries(${JSON.stringify(values)})) f.elements[k].value = v; f.requestSubmit(); return true; })()`);
      for (let i = 0; i < 200 && !o.agent.templates().some((x) => x.name === values.name); i++) await wait(100);
      // "New template" empties the form for the next one
      await t.evaluate("[...document.querySelectorAll('[data-template-edit] button')].find((b) => b.textContent === 'New template').click(), true");
    };
    await add({ name: 'bug', description: 'Find a bug', text: 'Find the bug in {{file}}. It {{what happens}}.' });
    await add({ name: 'hello', description: '', text: 'Say hello to the team.' });
    assert.deepEqual(o.agent.templates().map((x) => [x.name, x.variables]), [['bug', ['file', 'what happens']], ['hello', []]]);
    assert.ok(await until("[...document.querySelectorAll('[data-template-list] .preset-list__name')].map((x) => x.textContent).join() === '/bug,/hello'", 5000));
    await t.evaluate(`${modal}.querySelector('[data-modal-close]').click(), true`);
    // "/" lists the commands, then the templates
    await type('/');
    const items = "[...document.querySelectorAll('.chat__commands [data-command]')].map((x) => x.dataset.command)";
    assert.ok(await until(`${items}.includes('/bug')`, 5000));
    const all = await t.evaluate(items);
    assert.deepEqual(all.slice(-2), ['/bug', '/hello']);
    assert.ok(all.indexOf('/compact') < all.indexOf('/bug'));
    await type('/b');
    assert.deepEqual(await t.evaluate(items), ['/bug']);
    assert.equal(await t.evaluate("document.querySelector('[data-command=\"/bug\"] .chat__command-note').textContent"), 'Find a bug');
    // pick it: its variables are asked for; Enter goes to the next field, then inserts
    await key('Enter');
    const form = "document.querySelector('[data-template-form]')";
    assert.ok(await until(`!${form}.hidden`, 5000), 'the variables are asked for');
    assert.deepEqual(await t.evaluate(`[...${form}.querySelectorAll('[data-template-variable]')].map((x) => x.dataset.templateVariable)`), ['file', 'what happens']);
    assert.equal(await t.evaluate("document.activeElement.dataset.templateVariable"), 'file');
    await t.evaluate("document.activeElement.value = 'app.js'; true");
    await key('Enter', '[data-template-variable="file"]');
    assert.equal(await t.evaluate("document.activeElement.dataset.templateVariable"), 'what happens');
    await t.evaluate("document.activeElement.value = 'crashes on start'; true");
    await key('Enter', '[data-template-variable="what happens"]');
    assert.equal(await t.evaluate(`${form}.hidden`), true);
    assert.equal(await t.evaluate(box), 'Find the bug in app.js. It crashes on start.');
    assert.equal(await t.evaluate("document.activeElement === document.querySelector('[data-chat-input]')"), true);
    assert.equal(o.agent.list().total, 0, 'nothing was sent');
    // typed in full and sent: the form again; Escape closes it and sends nothing
    await type('/bug');
    await t.evaluate("document.querySelector('[data-chat-form]').requestSubmit(), true");
    assert.ok(await until(`!${form}.hidden`, 5000));
    await key('Escape', '[data-template-variable="file"]');
    assert.equal(await t.evaluate(`${form}.hidden`), true);
    assert.equal(o.agent.list().total, 0);
    // no variables: the text at once
    await type('/hello');
    await key('Enter');
    assert.ok(await until(`${box} === 'Say hello to the team.'`, 5000));
    // then it is sent like any message
    await t.evaluate("document.querySelector('[data-chat-form]').requestSubmit(), true");
    assert.ok(await until(`${o.answers}.includes('EN: Say hello to the team.')`));
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI Settings › Assistant (phone 402 px): scheduled tasks, lasting notes, skills and MCP servers listed, added, changed and deleted from their parts (deleting asks first); Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until, agent } = o;
  try {
    const FAKE_MCP = fileURLToPath(new URL('./fake-mcp.mjs', import.meta.url));
    writeFileSync(join(o.p.setting.dataRoot, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP] } } }));
    mkdirSync(join(o.p.setting.dataRoot, 'skills', 'own-skill'), { recursive: true });
    writeFileSync(join(o.p.setting.dataRoot, 'skills', 'own-skill', 'SKILL.md'), '---\nname: own-skill\ndescription: Installed by the panel\n---\nDo it.\n');
    agent.addMemory('The user likes cats.');
    await t.evaluate("location.hash = '#settings'; true");
    const part = (name) => `document.querySelector('[data-assistant-part="${name}"]')`;
    assert.ok(await until(`!document.querySelector('[data-setting-assistant]').hidden && ${part('mcp')}.textContent.includes('fake')`, 10000), 'the panel shows');
    await t.evaluate("document.querySelectorAll('[data-assistant-part]').forEach((d) => { d.open = true; }); true");
    assert.deepEqual(await t.evaluate("[...document.querySelectorAll('[data-assistant-count]')].map((x) => x.textContent)"), ['', '', '1', '1', '1', '']);
    const submit = (form, values) => t.evaluate(`(() => { const f = ${form}; for (const [k, v] of Object.entries(${JSON.stringify(values)})) f.elements[k].value = v; f.requestSubmit(); return true; })()`);
    const confirm = async () => {
      assert.ok(await until("!document.querySelector('[data-confirm-dialog]').hidden", 5000), 'asks first');
      await t.evaluate("document.querySelector('[data-confirm-accept]').click(), true");
    };
    // a scheduled task: added, changed, deleted
    await submit("document.querySelector('[data-schedule-form=\"new\"]')", { task: 'Check the disk', repeatMin: '1440' });
    for (let i = 0; i < 50 && !agent.schedules().length; i++) await wait(100);
    assert.deepEqual(agent.schedules().map((z) => [z.task, z.repeatMin, z.approvalMode]), [['Check the disk', 1440, 'edits']]);
    assert.ok(await until(`${part('schedules')}.querySelector('[data-schedule-id] .assistant-item__meta')?.textContent.includes('every 1440 min')`, 5000));
    await t.evaluate("document.querySelector('[data-schedule-edit]').click(), true");
    await submit(`document.querySelector('[data-schedule-form="${agent.schedules()[0].id}"]')`, { task: 'Check the disk again', repeatMin: '' });
    for (let i = 0; i < 50 && agent.schedules()[0].task !== 'Check the disk again'; i++) await wait(100);
    assert.deepEqual([agent.schedules()[0].task, agent.schedules()[0].repeatMin], ['Check the disk again', null]);
    assert.ok(await until(`${part('schedules')}.querySelector('[data-schedule-id] .assistant-item__meta')?.textContent.includes('once')`, 5000));
    await t.evaluate(`${part('schedules')}.querySelector('.assistant-item__delete button').click(), true`);
    await confirm();
    for (let i = 0; i < 50 && agent.schedules().length; i++) await wait(100);
    assert.deepEqual(agent.schedules(), []);
    // notes: added, searched, changed, deleted
    await submit("document.querySelector('[data-memory-add]')", { text: 'Answer in Turkish.' });
    assert.ok(await until(`${part('memory')}.querySelectorAll('[data-note-id]').length === 2`, 5000));
    assert.deepEqual(await t.evaluate(`[...${part('memory')}.querySelectorAll('[data-note-id] .assistant-item__text')].map((x) => x.textContent)`), ['Answer in Turkish.', 'The user likes cats.'], 'newest first');
    await t.evaluate("(() => { const i = document.querySelector('[data-memory-search]'); i.value = 'cats'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    assert.ok(await until(`${part('memory')}.querySelectorAll('[data-note-id]').length === 1`, 5000), 'searched');
    await t.evaluate("document.querySelector('[data-note-edit=\"n1\"]').click(), true");
    await t.evaluate("(() => { const f = document.querySelector('[data-note-form=\"n1\"]'); f.querySelector('input').value = 'The user likes dogs.'; f.requestSubmit(); return true; })()");
    for (let i = 0; i < 50 && agent.notes().find((n) => n.id === 'n1')?.text !== 'The user likes dogs.'; i++) await wait(100);
    assert.equal(agent.notes().find((n) => n.id === 'n1').text, 'The user likes dogs.');
    await t.evaluate("(() => { const i = document.querySelector('[data-memory-search]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    assert.ok(await until(`${part('memory')}.querySelectorAll('[data-note-id]').length === 2`, 5000));
    await t.evaluate("document.querySelector('[data-note-id=\"n2\"] .assistant-item__delete button').click(), true");
    await confirm();
    for (let i = 0; i < 50 && agent.notes().length !== 1; i++) await wait(100);
    assert.deepEqual(agent.notes().map((n) => n.text), ['The user likes dogs.']);
    // skills: the panel's own one is removed
    assert.equal(await t.evaluate("Boolean(document.querySelector('[data-skill=\"own-skill\"] .assistant-item__delete'))"), true);
    await t.evaluate("document.querySelector('[data-skill=\"own-skill\"] .assistant-item__delete button').click(), true");
    await confirm();
    assert.ok(await until(`${part('skills')}.textContent.includes('No skills installed.')`, 15000), 'removed');
    // MCP: check, off, time limit, on; add one and remove it
    await t.evaluate("document.querySelector('[data-mcp-check=\"fake\"]').click(), true");
    assert.ok(await until("document.querySelector('[data-mcp-server=\"fake\"] .badge--green')?.textContent === '1 tool'", 15000), 'started, its tools counted');
    await t.evaluate("(() => { const c = document.querySelector('[data-mcp-on=\"fake\"]'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    assert.ok(await until("document.querySelector('[data-mcp-server=\"fake\"] .badge')?.textContent === 'off'", 5000));
    assert.ok(!('fake' in agent.mcp.servers()));
    await t.evaluate("(() => { const i = document.querySelector('[data-mcp-timeout=\"fake\"]'); i.value = '90'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    for (let i = 0; i < 50 && agent.mcp.list()[0].timeoutSec !== 90; i++) await wait(100);
    await t.evaluate("(() => { const c = document.querySelector('[data-mcp-on=\"fake\"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    for (let i = 0; i < 50 && !('fake' in agent.mcp.servers()); i++) await wait(100);
    assert.equal(agent.mcp.servers().fake.timeout, 90000);
    await submit("document.querySelector('[data-mcp-form]')", { name: 'two', command: process.execPath, args: FAKE_MCP, timeoutSec: '45' });
    assert.ok(await until("Boolean(document.querySelector('[data-mcp-server=\"two\"]'))", 15000), 'added');
    assert.equal(agent.mcp.list().find((s) => s.name === 'two').timeoutSec, 45);
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'fits the phone');
    await t.evaluate("document.querySelector('[data-mcp-server=\"two\"] .assistant-item__delete button').click(), true");
    await confirm();
    assert.ok(await until("!document.querySelector('[data-mcp-server=\"two\"]')", 5000));
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until(`${part('memory')}.querySelector('summary').textContent.startsWith('Kalıcı notlar')`, 5000));
    assert.equal(await t.evaluate("document.querySelector('[data-mcp-check=\"fake\"]').textContent"), 'Dene');
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('web app: the manifest, its icons (real PNG sizes) and the iPhone home screen tags; the service worker keeps the app shell (never the API, files or event streams), the page opens from it without the network; the bar color follows the theme (headless browser)', SKIP, async () => {
  const o = await chatPage();
  const { t, until, p } = o;
  try {
    const manifest = await fetch(`${p.address}/manifest.webmanifest`);
    assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);
    const m = await manifest.json();
    assert.deepEqual([m.name, m.short_name, m.display, m.start_url, m.scope], ['Nedese Studio', 'Nedese', 'standalone', '/#chat', '/']);
    // each PNG is the size it claims (width and height from the IHDR chunk)
    const pngSize = async (path) => {
      const r = await fetch(`${p.address}${path}`);
      assert.equal(r.headers.get('content-type'), 'image/png', path);
      const b = Buffer.from(await r.arrayBuffer());
      assert.equal(b.subarray(1, 4).toString(), 'PNG');
      return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
    };
    for (const icon of m.icons.filter((i) => i.type === 'image/png')) assert.equal(await pngSize(icon.src), icon.sizes, icon.src);
    assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
    const head = await t.evaluate("({ manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'), apple: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href'), capable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content, title: document.querySelector('meta[name=apple-mobile-web-app-title]')?.content })");
    assert.deepEqual(head, { manifest: './manifest.webmanifest', apple: './icons/apple-touch-icon.png', capable: 'yes', title: 'Nedese' });
    assert.equal(await pngSize('/icons/apple-touch-icon.png'), '180x180');
    // this computer is a secure origin: the service worker runs and keeps the shell
    assert.ok(await until("navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true)", 10000));
    assert.equal(await t.evaluate("navigator.serviceWorker.ready.then((r) => r.scope)"), `${p.address}/`);
    await o.send('hello app');
    assert.ok(await until(`${o.answers}.includes('EN: hello app')`));
    await t.goto(`${p.address}/#chat`);
    assert.ok(await until('Boolean(navigator.serviceWorker.controller)', 10000), 'the page is under the worker');
    await t.evaluate("fetch('/api/v1/status', { headers: { 'X-Panel': '1' } }).then((r) => r.status)");
    const cached = await t.evaluate("caches.open('nedese-shell-v1').then((c) => c.keys()).then((k) => k.map((r) => new URL(r.url).pathname))");
    for (const path of ['/', '/app.js', '/chat.js', '/css/app.css', '/lang/dictionary.js']) assert.ok(cached.includes(path), `${path} kept: ${cached.join(', ')}`);
    assert.deepEqual(cached.filter((x) => /^\/(api|file|dosya|llm)\//.test(x)), [], 'never the API or files');
    // without the network the page still opens (from the shell)
    await t.send('Network.enable');
    await t.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    // (the page's own load never finishes without the network: no waiting for it)
    await t.evaluate('window.__before = 1; true');
    await t.send('Page.navigate', { url: `${p.address}/?offline=1#chat` });
    assert.ok(await until('window.__before === undefined', 10000), 'a new page');
    assert.ok(await until("document.title.endsWith('Nedese Studio') && typeof window.NedesePanel === 'object' && Boolean(document.querySelector('[data-chat-form]'))", 10000), 'opened offline');
    // the page says the panel cannot be reached (expected without the network)
    assert.ok(o.errors.some((e) => /Cannot reach the panel server/.test(e)));
    await t.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    // the bar color follows the theme
    await t.goto(`${p.address}/#chat`);
    assert.equal(await t.evaluate("document.querySelector('meta[name=theme-color]').content"), '#212426');
    await t.evaluate("document.documentElement.dataset.theme = 'light'; true");
    assert.ok(await until("document.querySelector('meta[name=theme-color]').content === '#ffffff'", 3000));
    assert.deepEqual(o.errors.filter((e) => !/Cannot reach the panel server|Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(e)), []);
  } finally {
    await o.close();
  }
});

test('UI chat previews: an HTML or SVG code block in an answer runs in a sandboxed frame beside the chat (full screen on phones) that cannot reach the panel or send data; Escape and Close close it; other code gets no Preview; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage();
  const { t, until } = o;
  try {
    await o.send('preview sample');
    assert.ok(await until(`${o.answers}.some((a) => a.startsWith('A page:'))`));
    assert.deepEqual(await t.evaluate("[...document.querySelectorAll('[data-code-preview]')].map((b) => b.dataset.codePreview)"), ['html', 'svg'], 'the script block has no preview');
    // what the page in the frame reports back (postMessage is the only way out)
    await t.evaluate("window.__messages = []; addEventListener('message', (e) => window.__messages.push(e.data)); true");
    await t.evaluate("document.querySelector('[data-code-preview=\"html\"]').click(), true");
    const panel = "document.querySelector('[data-code-preview-panel]')";
    assert.ok(await until(`Boolean(${panel})`, 5000));
    const frame = await t.evaluate(`(() => { const f = ${panel}.querySelector('iframe'); const r = ${panel}.getBoundingClientRect(); return { sandbox: f.getAttribute('sandbox'), policy: /Content-Security-Policy[^>]*connect-src 'none'/.test(f.srcdoc), title: f.srcdoc.includes('<title>Sample</title>'), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height), focus: document.activeElement?.dataset.codePreviewClose !== undefined }; })()`);
    assert.deepEqual(frame, { sandbox: 'allow-scripts', policy: true, title: true, right: 1366, width: 683, height: 900, focus: true });
    assert.ok(await until("window.__messages.some((m) => m.ran) && window.__messages.some((m) => m.fetch)", 10000), 'the page ran and reported');
    const reports = await t.evaluate('window.__messages');
    assert.deepEqual(reports.find((m) => m.ran), { ran: 'Ran 2', parentRead: 'blocked', storage: 'blocked' }, 'no access to the panel page or its storage');
    assert.deepEqual(reports.find((m) => m.fetch), { fetch: 'blocked' }, 'no requests');
    // Escape closes and gives the focus back to its button
    await t.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true");
    assert.equal(await t.evaluate(`Boolean(${panel})`), false);
    assert.equal(await t.evaluate("document.activeElement?.dataset.codePreview"), 'html');
    // SVG on a phone: its own page, the whole screen; Close closes
    await t.send('Emulation.setDeviceMetricsOverride', { width: 402, height: 860, deviceScaleFactor: 1, mobile: true });
    await t.evaluate("document.querySelector('[data-code-preview=\"svg\"]').click(), true");
    assert.ok(await until(`Boolean(${panel})`, 5000));
    const svg = await t.evaluate(`(() => { const r = ${panel}.getBoundingClientRect(); const f = ${panel}.querySelector('iframe'); return { left: r.left, width: Math.round(r.width), svg: f.srcdoc.includes('<circle'), page: f.srcdoc.startsWith('<!doctype html>'), overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
    assert.deepEqual(svg, { left: 0, width: 402, svg: true, page: true, overflow: false });
    await t.evaluate("document.querySelector('[data-code-preview-close]').click(), true");
    assert.equal(await t.evaluate(`Boolean(${panel})`), false);
    // Turkish: the button in the (untranslated) answer and the panel
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until("document.querySelector('[data-code-preview=\"html\"]').textContent === 'Önizle'", 5000));
    assert.equal(await t.evaluate("document.querySelector('.message__code-lang').textContent"), 'HTML');
    assert.ok(await t.evaluate(`${o.answers}.some((a) => a.includes('A page:'))`), 'the answer itself stays as written');
    await t.evaluate("document.querySelector('[data-code-preview=\"html\"]').click(), true");
    assert.ok(await until("document.querySelector('[data-code-preview-close]')?.getAttribute('aria-label') === 'Önizlemeyi kapat'", 5000));
    // the page's own title (untranslated), its kind beside it
    assert.deepEqual(await t.evaluate("[document.querySelector('.artifact__title').textContent, document.querySelector('.artifact__kind').textContent, document.querySelector('[data-artifact-code]').textContent]"), ['Sample', 'HTML', 'Kod']);
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI artifacts (user request 10.10.2026, like Claude): an HTML page the agent writes opens beside the chat by itself, without taking the focus, and gets a card with Open; an edit is version 2 (previous and next); Code shows the source, Download saves the version shown, Full screen covers the chat; reopened from the saved chat; code blocks with one page title are versions of one; a phone keeps the card and opens it full screen; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage();
  const { t, until } = o;
  try {
    const idle = "document.querySelector('[data-chat-stop]').hidden";
    const panel = "document.querySelector('[data-code-preview-panel]')";
    const view = `(() => { const p = ${panel}; if (!p) return null; const f = p.querySelector('iframe'); return { title: p.querySelector('.artifact__title').textContent, version: p.querySelector('[data-artifact-version]')?.textContent ?? null, page: f ? (/<h1>(\\w+)<\\/h1>/.exec(f.srcdoc)?.[1] ?? '') : null, source: p.querySelector('[data-artifact-source]')?.textContent ?? null }; })()`;
    const page = (h) => `<!doctype html><html><head><title>Shop</title></head><body><h1>${h}</h1></body></html>`;
    await o.send(`call tool write_file ${JSON.stringify({ path: 'site.html', text: page('First') })}`);
    assert.ok(await until(`Boolean(${panel}) && ${idle}`), 'opens by itself');
    assert.deepEqual(await t.evaluate(view), { title: 'site.html', version: null, page: 'First', source: null });
    assert.equal(await t.evaluate("document.activeElement?.dataset.codePreviewClose"), undefined, 'the composer keeps the focus');
    assert.deepEqual(await t.evaluate("[...document.querySelectorAll('.artifact-card')].map((c) => [c.querySelector('.artifact-card__name').textContent, c.querySelector('.artifact-card__kind').textContent])"), [['site.html', 'Web page']]);
    // an edit: version 2 of 2 shown at once; the previous one is still there
    await o.send(`call tool edit_file ${JSON.stringify({ path: 'site.html', search: 'First', replace: 'Second' })}`);
    assert.ok(await until(`(${view})?.version === 'Version 2 of 2' && ${idle}`));
    assert.equal((await t.evaluate(view)).page, 'Second');
    assert.equal(await t.evaluate("document.querySelector('[data-artifact-next]').disabled"), true);
    await t.evaluate("document.querySelector('[data-artifact-previous]').click(), true");
    assert.deepEqual(await t.evaluate(view), { title: 'site.html', version: 'Version 1 of 2', page: 'First', source: null });
    assert.equal(await t.evaluate("document.querySelector('[data-artifact-previous]').disabled"), true);
    // Code: the source of the version shown
    await t.evaluate("document.querySelector('[data-artifact-code]').click(), true");
    assert.deepEqual(await t.evaluate(`[(${view}).source, (${view}).page, document.querySelector('[data-artifact-code]').textContent, document.querySelector('[data-artifact-code]').getAttribute('aria-pressed')]`), [page('First'), null, 'Preview', 'true']);
    // Download: the version shown, under the file's name
    await t.evaluate("window.__download = null; HTMLAnchorElement.prototype.click = function () { window.__download = { name: this.download, href: this.href }; }; document.querySelector('[data-artifact-download]').click(); true");
    assert.deepEqual(await t.evaluate("fetch(window.__download.href).then((r) => r.text()).then((text) => [window.__download.name, text])"), ['site.html', page('First')]);
    // Full screen covers the chat; again gives it back
    await t.evaluate("document.querySelector('[data-artifact-full]').click(), true");
    assert.deepEqual(await t.evaluate(`(() => { const r = ${panel}.getBoundingClientRect(); return [r.left, Math.round(r.width), document.querySelector('[data-artifact-full]').textContent]; })()`), [0, 1366, 'Exit full screen']);
    await t.evaluate("document.querySelector('[data-artifact-full]').click(), true");
    assert.equal(await t.evaluate(`Math.round(${panel}.getBoundingClientRect().width)`), 683);
    // the saved chat keeps every version
    const s = o.chat(`call tool write_file ${JSON.stringify({ path: 'site.html', text: page('First') })}`.slice(0, 60));
    assert.deepEqual(s.messages.filter((m) => m.role === 'tool').map((m) => [m.extra?.artifact?.kind, /<h1>(\w+)/.exec(m.extra?.artifact?.content)?.[1]]), [['html', 'First'], ['html', 'Second']]);
    await t.evaluate(`localStorage.setItem('chat.current', ${JSON.stringify(s.id)}); true`);
    await t.goto(`${o.p.address}/?reopen=1#chat`);
    assert.ok(await until("document.querySelectorAll('[data-artifact-open]').length === 2"), 'a card per version');
    assert.equal(await t.evaluate(`Boolean(${panel})`), false, 'a reopened chat does not open it by itself');
    await t.evaluate("document.querySelectorAll('[data-artifact-open]')[0].click(), true");
    assert.deepEqual(await t.evaluate(view), { title: 'site.html', version: 'Version 1 of 2', page: 'First', source: null });
    // code blocks with one page title: versions of one (the last one first when opened from the panel's own card)
    await t.evaluate("document.querySelector('[data-code-preview-close]').click(), true");
    for (let i = 1; i <= 2; i++) {
      await o.send('preview sample');
      assert.ok(await until(`document.querySelectorAll('.message--assistant:not(.message--live) [data-code-preview="html"]').length === ${i} && ${idle}`));
    }
    await t.evaluate("document.querySelectorAll('[data-code-preview=\"html\"]')[0].click(), true");
    assert.deepEqual(await t.evaluate(`[(${view}).title, (${view}).version]`), ['Sample', 'Version 1 of 2']);
    await t.evaluate("document.querySelector('[data-artifact-next]').click(), true");
    assert.equal(await t.evaluate(`(${view}).version`), 'Version 2 of 2');
    await t.evaluate("document.querySelector('[data-code-preview-close]').click(), true");
    // a phone: the card only; Open shows it on the whole screen
    await t.send('Emulation.setDeviceMetricsOverride', { width: 402, height: 860, deviceScaleFactor: 1, mobile: true });
    await o.send(`call tool write_file ${JSON.stringify({ path: 'logo.svg', text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' })}`);
    assert.ok(await until(`document.querySelectorAll('[data-artifact-open]').length === 3 && ${idle}`));
    assert.equal(await t.evaluate(`Boolean(${panel})`), false);
    assert.equal(await t.evaluate("document.querySelectorAll('.artifact-card__kind')[2].textContent"), 'SVG image');
    await t.evaluate("document.querySelectorAll('[data-artifact-open]')[2].click(), true");
    assert.deepEqual(await t.evaluate(`(() => { const p = ${panel}; const r = p.getBoundingClientRect(); return [r.left, Math.round(r.width), p.querySelector('.artifact__title').textContent, p.querySelector('.artifact__kind').textContent, p.querySelector('iframe').srcdoc.includes('<circle'), document.documentElement.scrollWidth > innerWidth]; })()`), [0, 402, 'logo.svg', 'SVG', true, false]);
    await o.shots('artifact');
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until("document.querySelector('[data-artifact-download]').textContent === 'İndir'", 5000));
    assert.deepEqual(await t.evaluate("[document.querySelector('[data-artifact-code]').textContent, document.querySelector('[data-artifact-full]').textContent, document.querySelectorAll('[data-artifact-open]')[2].textContent, document.querySelectorAll('.artifact-card__kind')[0].textContent]"), ['Kod', 'Tam ekran', 'Aç', 'Web sayfası']);
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI Settings › Remote model (phone 402 px): address, key (shown masked, never filled back) and model saved, Test asks it; a chat chooses it in Options and gets its answer; removing asks first and the chat shows it is gone; Turkish labels (headless browser)', SKIP, async () => {
  const KEY = 'sk-fakeRemoteKey-1234';
  const remote = await startFakeRemote({ key: KEY });
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    await t.evaluate("location.hash = '#settings'; true");
    const box = "document.querySelector('[data-setting-remote]')";
    assert.ok(await until(`!${box}.hidden`, 10000), 'the panel shows');
    assert.equal(await t.evaluate(`${box}.querySelector('[data-remote-key-hint]').textContent`), 'Not set (a server without a key needs none)');
    assert.equal(await t.evaluate(`${box}.querySelector('[data-remote-check]').disabled`), true, 'nothing to test yet');
    assert.equal(await t.evaluate("document.querySelector('[data-remote-remove-form]').hidden"), true);
    // Quick fill (user request 10.10.2026): Claude and DeepSeek fill the address and model, the key is left to the user
    const filled = (name) => t.evaluate(`(() => { document.querySelector('[data-remote-preset="${name}"]').click(); const f = document.querySelector('[data-remote-form]').elements; return [f.url.value, f.model.value, document.activeElement === f.key]; })()`);
    assert.deepEqual(await filled('claude'), ['https://api.anthropic.com/v1', 'claude-sonnet-5-5', true]);
    assert.deepEqual(await filled('deepseek'), ['https://api.deepseek.com', 'deepseek-flash', true]);
    await t.evaluate(`(() => { const f = document.querySelector('[data-remote-form]'); f.elements.url.value = ${JSON.stringify(`${remote.address}/v1`)}; f.elements.key.value = ${JSON.stringify(KEY)}; f.elements.model.value = 'gpt-test-mini'; f.requestSubmit(); return true; })()`);
    for (let i = 0; i < 50 && o.p.settingFile.remoteModel.model !== 'gpt-test-mini'; i++) await wait(100);
    assert.deepEqual(o.p.settingFile.remoteModel, { url: `${remote.address}/v1`, key: KEY, model: 'gpt-test-mini', whenBusy: false });
    assert.ok(await until(`${box}.querySelector('[data-remote-key-hint]').textContent === 'Saved: ••••1234'`, 5000), 'the key shows masked');
    assert.equal(await t.evaluate("document.querySelector('[data-remote-form]').elements.key.value"), '', 'the key field is not filled back');
    assert.ok(await until("[...document.querySelectorAll('.toast--success')].some((x) => x.textContent.includes('Chats can choose gpt-test-mini (remote) as their text model.'))", 5000));
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'fits the phone');
    // Test
    await t.evaluate(`${box}.querySelector('[data-remote-check]').click(), true`);
    assert.ok(await until("[...document.querySelectorAll('.toast--success')].some((x) => /^gpt-test-mini answered in \\d+\\.\\d s\\.$/.test(x.textContent))", 10000), 'the test answer');
    // Saving again with the key field empty keeps the key; the tick is saved
    await t.evaluate("(() => { const f = document.querySelector('[data-remote-form]'); f.elements.whenBusy.checked = true; f.requestSubmit(); return true; })()");
    for (let i = 0; i < 50 && !o.p.settingFile.remoteModel.whenBusy; i++) await wait(100);
    assert.deepEqual(o.p.settingFile.remoteModel, { url: `${remote.address}/v1`, key: KEY, model: 'gpt-test-mini', whenBusy: true });
    // A new chat on the remote model: chosen in Options, answered by it
    await t.evaluate("location.hash = '#chat'; true");
    const options = "document.querySelector('[data-chat-options]')";
    await t.evaluate(`${options}.click(), true`);
    const radio = "document.querySelector('input[name=\"chat-model\"][value=\"remote\"]')";
    assert.ok(await until(`Boolean(${radio})`, 5000), 'the remote model is in the list');
    assert.equal(await t.evaluate(`${radio}.closest('.chat__option').textContent`), 'gpt-test-mini (remote)Remote · OpenAI-compatible (Settings › Remote model)');
    await t.evaluate(`(() => { const r = ${radio}; r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    assert.match(await t.evaluate("document.querySelector('[data-chat-options-label]').textContent"), /gpt-test-mini \(remote\)$/);
    await t.evaluate(`${options}.click(), true`);
    await o.send('hello remote');
    assert.ok(await until(`${o.answers}.includes('Remote answer from gpt-test-mini')`), await t.evaluate(`${o.answers}.join('|')`));
    assert.equal(o.chat('hello remote').model, 'remote');
    assert.equal(remote.requests.at(-1).authorization, `Bearer ${KEY}`);
    // Removed (asks first): the chat shows that its remote model is gone
    await t.evaluate("location.hash = '#settings'; true");
    assert.ok(await until("!document.querySelector('[data-remote-remove-form]').hidden", 5000));
    await t.evaluate("document.querySelector('[data-remote-remove]').click(), true");
    assert.ok(await until("!document.querySelector('[data-confirm-dialog]').hidden", 5000), 'asks first');
    await t.evaluate("document.querySelector('[data-confirm-accept]').click(), true");
    for (let i = 0; i < 50 && o.p.settingFile.remoteModel.url; i++) await wait(100);
    assert.deepEqual(o.p.settingFile.remoteModel, { url: '', key: '', model: '', whenBusy: false });
    assert.ok(await until("document.querySelector('[data-remote-form]').elements.url.value === '' && document.querySelector('[data-remote-remove-form]').hidden", 5000));
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until(`${box}.querySelector('.panel__title').textContent === 'Uzak model'`, 5000));
    assert.equal(await t.evaluate(`${box}.querySelector('[data-remote-check]').textContent`), 'Dene');
    await t.evaluate("location.hash = '#chat'; true");
    assert.ok(await until("document.querySelector('[data-chat-options-label]').textContent.endsWith('Uzak model (ayarlı değil)')", 10000), await t.evaluate("document.querySelector('[data-chat-options-label]').textContent"));
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
    await remote.close();
  }
});

test('UI pinned, archived and temporary chats (phone 402 px): the chat menu pins a chat above the others and archives one out of the list; Archived lists it and Back returns; a temporary chat says so, is not saved, is deleted when left and saved with Keep; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until, agent } = o;
  try {
    // a few ms apart: the list is newest first (the same millisecond falls back to the id)
    for (const title of ['Alpha', 'Beta', 'Gamma']) {
      agent.create({ title });
      await wait(5);
    }
    // the page again (the same address with its #chat is no new page load)
    await t.evaluate('location.reload(), true');
    await wait(500);
    const openList = () => t.evaluate("document.querySelector('[data-chat-list]').classList.contains('open') || document.querySelector('[data-chat-list-toggle]').click(), true");
    const listText = "[...document.querySelectorAll('[data-chat-items] > *')].map((x) => x.textContent).join('|')";
    const pick = async (title) => {
      await openList();
      assert.ok(await until(`[...document.querySelectorAll('[data-chat-item]')].some((b) => b.textContent === ${JSON.stringify(title)})`, 5000), `${title} in the list: ${await t.evaluate(listText)}`);
      await t.evaluate(`[...document.querySelectorAll('[data-chat-item]')].find((b) => b.textContent === ${JSON.stringify(title)}).click(), true`);
      assert.ok(await until(`document.querySelector('[data-chat-title]').textContent === ${JSON.stringify(title)} && !document.querySelector('[data-chat-menu]').hidden`, 5000));
    };
    const menu = async (action) => {
      await t.evaluate("document.querySelector('[data-chat-menu]').click(), true");
      assert.ok(await until(`Boolean(document.querySelector('[data-chat-menu-action="${action}"]'))`, 5000), `${action} in the menu`);
      await t.evaluate(`document.querySelector('[data-chat-menu-action="${action}"]').click(), true`);
    };
    const chatOf = (title) => [...agent.chats.values()].find((x) => x.title === title);
    // Pin Alpha: above the others under Pinned
    await pick('Alpha');
    assert.deepEqual(await t.evaluate("[...document.querySelectorAll('[data-chat-menu-action]')].map((b) => b.textContent)"), [], 'the menu is closed');
    await menu('pin');
    for (let i = 0; i < 50 && !chatOf('Alpha').pinned; i++) await wait(100);
    assert.equal(chatOf('Alpha').pinned, true);
    await openList();
    assert.ok(await until(`${listText} === 'Pinned|Alpha|Chats|Gamma|Beta'`, 5000), await t.evaluate(listText));
    assert.equal(await t.evaluate("Boolean(document.querySelector('[data-chat-item] .chat__item-mark'))"), true, 'a pin beside it');
    assert.ok(await until("[...document.querySelectorAll('.toast--success')].some((x) => x.textContent === 'Pinned to the top of the list.')", 5000));
    // Archive Beta: out of the list, Archived (1) lists it, Back returns
    await pick('Beta');
    await menu('archive');
    for (let i = 0; i < 50 && !chatOf('Beta').archived; i++) await wait(100);
    await openList();
    assert.ok(await until(`${listText} === 'Pinned|Alpha|Chats|Gamma' && document.querySelector('[data-chat-archived]').textContent === 'Archived (1)' && !document.querySelector('[data-chat-archived]').hidden`, 5000), await t.evaluate(listText));
    await t.evaluate("document.querySelector('[data-chat-archived]').click(), true");
    assert.ok(await until(`${listText} === 'Archived chatsBack to chats|Beta'`, 5000), await t.evaluate(listText));
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'fits the phone');
    // opened from the archive, its menu takes it out
    await pick('Beta');
    await menu('unarchive');
    for (let i = 0; i < 50 && chatOf('Beta').archived; i++) await wait(100);
    await openList();
    assert.ok(await until(`${listText} === 'Archived chatsBack to chats|No archived chats.'`, 5000), await t.evaluate(listText));
    await t.evaluate("document.querySelector('[data-chat-archive-back]').click(), true");
    assert.ok(await until(`${listText} === 'Pinned|Alpha|Chats|Beta|Gamma' && document.querySelector('[data-chat-archived]').hidden`, 5000), await t.evaluate(listText));

    // A temporary chat: chosen in Options for a new chat, says so, is not saved, is deleted when left
    await t.evaluate("document.querySelector('[data-chat-new]').click(), true");
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    assert.ok(await until("Boolean(document.querySelector('[data-chat-temporary-choice]'))", 5000));
    await t.evaluate("(() => { const b = document.querySelector('[data-chat-temporary-choice]'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    assert.ok(await until("!document.querySelector('[data-chat-temporary]').hidden && document.querySelector('[data-chat-keep]').hidden", 5000), 'the notice before the first message');
    assert.match(await t.evaluate("document.querySelector('[data-chat-options-label]').textContent"), /^Temporary · /);
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    await o.send('temporary hello');
    assert.ok(await until(`${o.answers}.includes('EN: temporary hello')`), 'it answers');
    const temp = chatOf('temporary hello');
    assert.equal(temp.temporary, true);
    assert.equal(existsSync(join(o.p.setting.dataRoot, 'chat', `${temp.id}.json`)), false, 'not saved');
    assert.ok(await until("!document.querySelector('[data-chat-keep]').hidden", 5000), 'Keep shows');
    await openList();
    assert.ok(await until("[...document.querySelectorAll('[data-chat-item]')].some((b) => b.textContent === 'temporary helloTemporary')", 5000), 'marked in the list while open');
    await t.evaluate("document.querySelector('[data-chat-new]').click(), true");
    for (let i = 0; i < 50 && agent.chats.has(temp.id); i++) await wait(100);
    assert.equal(agent.chats.has(temp.id), false, 'left: deleted');
    assert.ok(await until("![...document.querySelectorAll('[data-chat-item]')].some((b) => b.textContent.startsWith('temporary hello'))", 5000));
    // another one kept: saved, the notice goes
    await o.send('keep me');
    assert.ok(await until(`${o.answers}.includes('EN: keep me')`));
    const keep = chatOf('keep me');
    assert.equal(keep.temporary, true, 'the choice lasts while the page is open');
    await t.evaluate("document.querySelector('[data-chat-keep]').click(), true");
    for (let i = 0; i < 50 && keep.temporary; i++) await wait(100);
    assert.ok(existsSync(join(o.p.setting.dataRoot, 'chat', `${keep.id}.json`)), 'kept: saved');
    assert.ok(await until("document.querySelector('[data-chat-temporary]').hidden", 5000));
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    await t.evaluate("document.querySelector('[data-chat-menu]').click(), true");
    assert.ok(await until("[...document.querySelectorAll('[data-chat-menu-action]')].map((b) => b.textContent).join('|') === 'Yeniden adlandır|Başa sabitle|Arşivle|Markdown olarak dışa aktar|JSON olarak dışa aktar'", 5000), await t.evaluate("[...document.querySelectorAll('[data-chat-menu-action]')].map((b) => b.textContent).join('|')"));
    assert.equal(await t.evaluate("document.querySelector('[data-chat-menu]').getAttribute('aria-label')"), 'Bu sohbet için diğer');
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('the page announces its section after every script has run: a chat.js that arrives after the panel\'s options (as through the web app\'s service worker) still opens the chat with its list (headless browser)', SKIP, async () => {
  const o = await chatPage();
  const { t, until, agent } = o;
  try {
    agent.create({ title: 'Listed chat' });
    // without the service worker the page's own requests can be held here
    await t.evaluate('navigator.serviceWorker.getRegistrations().then((list) => Promise.all(list.map((r) => r.unregister()))).then(() => true)');
    // chat.js comes 1.5 s late: the options answer first
    await t.send('Fetch.enable', { patterns: [{ urlPattern: '*/chat.js*' }] });
    const paused = [];
    t.events.set('Fetch.requestPaused', [(e) => {
      paused.push(e.request.url);
      setTimeout(() => t.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {}), 1500);
    }]);
    await t.evaluate('location.reload(), true');
    assert.ok(await until('performance.getEntriesByType("resource").some((e) => e.name.endsWith("/chat.js"))', 10000));
    assert.equal(paused.length, 1, 'chat.js was held');
    assert.ok(await t.evaluate("(() => { const r = performance.getEntriesByType('resource'); const at = (end) => r.find((e) => e.name.includes(end))?.responseEnd ?? 0; return at('/api/options') < at('/chat.js'); })()"), 'the options came first');
    assert.ok(await until("[...document.querySelectorAll('.chat__item')].some((b) => b.textContent === 'Listed chat')", 15000), 'the list loads');
    await t.send('Fetch.disable');
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI export and import (phone 402 px): the chat menu downloads the chat as Markdown and as JSON (named after the chat); Import a chat makes a new chat of the JSON and opens it; a file that is not JSON is refused; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until, agent } = o;
  try {
    await o.send('export me');
    assert.ok(await until(`${o.answers}.includes('EN: export me')`), 'answered');
    const id = o.chat('export me').id;
    // downloads are caught in the page: the link's name and the file's text
    await t.evaluate("window.downloads = []; HTMLAnchorElement.prototype.click = function () { if (this.download) fetch(this.href).then((r) => r.text()).then((text) => window.downloads.push([this.download, text])); }; true");
    const menu = async (action) => {
      await t.evaluate("document.querySelector('[data-chat-menu]').click(), true");
      assert.ok(await until(`Boolean(document.querySelector('[data-chat-menu-action="${action}"]'))`, 5000));
      await t.evaluate(`document.querySelector('[data-chat-menu-action="${action}"]').click(), true`);
    };
    assert.deepEqual(await t.evaluate("(document.querySelector('[data-chat-menu]').click(), [...document.querySelectorAll('[data-chat-menu-panel] .chat__menu-item')].map((b) => b.textContent))"), ['Rename', 'Pin to the top', 'Archive', 'Export as Markdown', 'Export as JSON']);
    await t.evaluate("document.querySelector('[data-chat-menu]').click(), true");
    await menu('export-md');
    assert.ok(await until('window.downloads.length === 1', 5000), 'the Markdown file');
    const [mdName, md] = await t.evaluate('window.downloads[0]');
    assert.match(mdName, /^export-me-\d{4}-\d{2}-\d{2}\.md$/);
    assert.match(md, /^# export me\n[\s\S]*## You · .+\n\nexport me\n\n## Nedese · .+\n\nEN: export me\n$/);
    await menu('export-json');
    assert.ok(await until('window.downloads.length === 2', 5000), 'the JSON file');
    const [jsonName, json] = await t.evaluate('window.downloads[1]');
    assert.match(jsonName, /^export-me-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(JSON.parse(json).format, 'nedese-chat');
    // Import it: a new chat opens with the same messages
    const pickFile = (name, text) => t.evaluate(`(() => { const input = document.querySelector('[data-chat-import-file]'); const files = new DataTransfer(); files.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'application/json' })); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await t.evaluate("document.querySelector('[data-chat-list-toggle]').click(), true");
    assert.equal(await t.evaluate("!document.querySelector('[data-chat-import]').hidden && document.querySelector('[data-chat-import]').offsetParent !== null"), true, 'Import a chat under the open list');
    await pickFile(jsonName, json);
    assert.ok(await until(`[...document.querySelectorAll('.toast--success')].some((x) => x.textContent === 'Chat imported: 2 messages.')`, 5000));
    const copy = [...agent.chats.values()].find((x) => x.title === 'export me' && x.id !== id);
    assert.ok(copy, 'a new chat');
    assert.ok(await until(`document.querySelector('[data-chat-title]').textContent === 'export me' && ${o.answers}.includes('EN: export me')`, 5000), 'it opens');
    assert.equal(await t.evaluate("localStorage.getItem('chat.current')"), copy.id);
    // not JSON: refused in the page
    await pickFile('notes.txt', 'just text');
    assert.ok(await until("[...document.querySelectorAll('.toast--danger')].some((x) => x.textContent === 'This file is not JSON: choose a chat exported as JSON.')", 5000));
    o.errors.splice(0); // the red toast above is expected
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until("document.querySelector('[data-chat-import]').textContent === 'Sohbet içe aktar'", 5000));
    await t.evaluate("document.querySelector('[data-chat-menu]').click(), true");
    assert.ok(await until("[...document.querySelectorAll('[data-chat-menu-panel] .chat__menu-item')].map((b) => b.textContent).slice(3).join('|') === 'Markdown olarak dışa aktar|JSON olarak dışa aktar'", 5000));
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI source links (phone 402 px): an answer that searched the web and read a page shows its sources under it as links to the sites (read page first, a site seen again numbered, the title on hover, a new tab), above the thumbs, live and after reopening; no other answer has them; they fit the phone; Turkish label (headless browser)', SKIP, async () => {
  // a fake Brave and its pages: nothing reaches the real internet
  const site = createServer((i, y) => {
    const u = new URL(i.url, 'http://x');
    const base = `http://127.0.0.1:${site.address().port}`;
    if (u.pathname === '/brave') {
      y.writeHead(200, { 'Content-Type': 'application/json' });
      return y.end(JSON.stringify({ web: { results: [['Bursa weather today', '/page/1'], ['Bursa forecast for the week', '/page/2']].map(([title, path]) => ({ title, url: base + path, description: title })) } }));
    }
    y.writeHead(200, { 'Content-Type': 'text/html' });
    y.end(`<html><title>Weather in Bursa</title><body><p>${'Bursa weather today: 14 °C, cloudy. '.repeat(30)}</p></body></html>`);
  });
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${site.address().port}`;
  const o = await chatPage({ width: 402, height: 860, setting: { agentSearchApis: { brave: `${base}/brave` }, agentSearchEngines: [] } });
  const { t, until } = o;
  try {
    const saved = await fetch(`${o.p.address}/api/v1/settings`, { method: 'PATCH', headers: { Authorization: `Bearer ${o.p.settingFile.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ webSearch: { brave: 'BSAfakeBraveKey1234' } }) });
    assert.equal(saved.status, 200);
    await o.send('hello first');
    assert.ok(await until(`${o.answers}.includes('EN: hello first')`), 'a plain answer');
    await o.send(`research ${base}/page/read bursa weather`);
    assert.ok(await until(`${o.answers}.some((x) => x.startsWith('From the sources:'))`), 'the answer from the web');
    const row = "document.querySelector('.message--assistant:not(.message--live) .message__sources')";
    const chips = `[...${row}.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.target, a.rel, a.title])`;
    const expected = [
      ['127.0.0.1', `${base}/page/read`, '_blank', 'noopener noreferrer', `Weather in Bursa\n${base}/page/read`],
      ['127.0.0.1 · 2', `${base}/page/1`, '_blank', 'noopener noreferrer', `Bursa weather today\n${base}/page/1`],
      ['127.0.0.1 · 3', `${base}/page/2`, '_blank', 'noopener noreferrer', `Bursa forecast for the week\n${base}/page/2`],
    ];
    // live: the answer that just arrived has them (no reload), between the text and the thumbs
    assert.ok(await until(`Boolean(${row})`, 5000), 'the source links under the live answer');
    assert.deepEqual(await t.evaluate(chips), expected);
    assert.deepEqual(await t.evaluate(`[...${row}.parentElement.children].map((c) => c.className.split(' ')[0]).slice(0, 3)`), ['message__bubble', 'message__sources', 'message__actions'], 'the follow-up suggestions may come after them');
    assert.equal(await t.evaluate("document.querySelectorAll('.message__sources').length"), 1, 'only the answer that used the web');
    assert.equal(await t.evaluate(`${row}.querySelector('.message__sources-label').textContent`), 'Sources');
    // they fit the phone: no sideways scroll, every link inside the message
    assert.equal(await t.evaluate(`document.documentElement.scrollWidth <= innerWidth && [...${row}.querySelectorAll('a')].every((a) => a.getBoundingClientRect().right <= ${row}.getBoundingClientRect().right + 0.5)`), true);
    // reopened: the stored links
    await t.evaluate('location.reload(), true');
    assert.ok(await until(`${o.answers}.some((x) => x.startsWith('From the sources:')) && Boolean(${row})`), 'after reopening');
    assert.deepEqual(await t.evaluate(chips), expected);
    assert.equal(await t.evaluate("document.querySelectorAll('.message__sources').length"), 1);
    // Turkish label; the site names stay as they are
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until(`${row}.querySelector('.message__sources-label').textContent === 'Kaynaklar' && ${row}.getAttribute('aria-label') === 'Kaynaklar'`, 5000));
    assert.deepEqual((await t.evaluate(chips)).map((c) => c[0]), ['127.0.0.1', '127.0.0.1 · 2', '127.0.0.1 · 3']);
    assert.deepEqual(o.errors, []);
  } finally {
    site.close();
    await o.close();
  }
});

test('UI follow-up suggestions (phone 402 px): three next messages appear under the answer that just arrived (below the thumbs); a click sends one and a draft in the box stays; the new answer gets its own and the old ones go; shown again after reopening; Options turns them off on this device; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    const rows = "[...document.querySelectorAll('.message__follow-ups')]";
    const chips = `${rows}.map((r) => [...r.querySelectorAll('[data-follow-up]')].map((b) => b.textContent))`;
    await o.send('owls');
    assert.ok(await until(`${o.answers}.includes('EN: owls')`), 'answered');
    assert.ok(await until(`${rows}.length === 1`, 10000), 'suggestions under the answer');
    assert.deepEqual(await t.evaluate(chips), [['Tell me more about owls', 'Give an example (#1)', 'Make it shorter']]);
    const row = "document.querySelector('.message__follow-ups')";
    assert.deepEqual(await t.evaluate(`[[...${row}.parentElement.children].map((c) => c.className.split(' ')[0]), ${row}.querySelector('.message__follow-ups-label').textContent, ${row}.getAttribute('aria-label'), ${row}.dataset.followUps]`),
      [['message__bubble', 'message__actions', 'message__follow-ups'], 'Follow-ups', 'Suggested follow-ups', o.chat('owls').messages.at(-1).id]);
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no sideways scroll');
    // a click sends it; the draft typed in the box stays there
    await t.evaluate("(() => { const i = document.querySelector('[data-chat-input]'); i.value = 'my draft'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    await t.evaluate(`[...${row}.querySelectorAll('[data-follow-up]')].find((b) => b.textContent === 'Make it shorter').click(), true`);
    assert.ok(await until(`${o.answers}.includes('EN: Make it shorter')`), 'the suggestion was sent');
    assert.ok(await until(`JSON.stringify(${chips}) === JSON.stringify([['Tell me more about Make it shorter', 'Give an example (#2)', 'Make it shorter']])`, 10000), 'the new answer has its own; the old ones are gone');
    assert.equal(await t.evaluate("document.querySelector('[data-chat-input]').value"), 'my draft');
    assert.deepEqual(o.chat('owls').messages.filter((m) => m.role === 'user').map((m) => m.content), ['owls', 'Make it shorter']);
    // reopened: the kept suggestions of the last answer (not asked again: still #2)
    await t.evaluate('location.reload(), true');
    assert.ok(await until(`${o.answers}.includes('EN: Make it shorter') && ${rows}.length === 1`), 'after reopening');
    assert.deepEqual(await t.evaluate(chips), [['Tell me more about Make it shorter', 'Give an example (#2)', 'Make it shorter']]);
    // Turkish labels; the suggestions stay as the model wrote them
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until(`${row}.querySelector('.message__follow-ups-label').textContent === 'Devam önerileri' && ${row}.getAttribute('aria-label') === 'Önerilen devam mesajları'`, 5000));
    assert.deepEqual((await t.evaluate(chips))[0], ['Tell me more about Make it shorter', 'Give an example (#2)', 'Make it shorter']);
    // Options › Suggest follow-ups off: they go, and the next answer gets none (none asked for)
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    assert.ok(await until("document.querySelector('[data-chat-follow-ups-choice]')?.closest('label')?.querySelector('.chat__option-name')?.textContent === 'Devam önerileri göster'", 5000));
    assert.equal(await t.evaluate("document.querySelector('[data-chat-follow-ups-choice]').checked"), true, 'on by default');
    await t.evaluate("(() => { const b = document.querySelector('[data-chat-follow-ups-choice]'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    assert.equal(await t.evaluate(`${rows}.length`), 0);
    assert.equal(await t.evaluate("localStorage.getItem('chat.followUps')"), 'off');
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    await o.send('no more');
    assert.ok(await until(`${o.answers}.includes('EN: no more')`), 'answered');
    await wait(1500);
    assert.equal(await t.evaluate(`${rows}.length`), 0);
    assert.equal('followUps' in o.chat('owls').messages.at(-1), false, 'not asked for');
    await t.evaluate('location.reload(), true');
    assert.ok(await until(`${o.answers}.includes('EN: no more')`), 'after reopening');
    assert.equal(await t.evaluate(`${rows}.length`), 0);
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI plan mode (phone 402 px, user request 10.10.2026): Plan in Options; the plan the model presents shows as a card with Approve and run and Keep planning; approving goes back to the earlier mode, sends the go-ahead and hides the buttons; after reopening the card stays without buttons; Turkish labels (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    await o.send('hello plan');
    assert.ok(await until(`${o.answers}.includes('EN: hello plan')`), 'answered');
    const chat = () => o.chat('hello plan');
    const before = chat().approvalMode;
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    assert.ok(await until("Boolean(document.querySelector('input[name=\"chat-mode\"][value=\"plan\"]'))", 5000), 'Plan is a mode');
    await t.evaluate("(() => { const r = document.querySelector('input[name=\"chat-mode\"][value=\"plan\"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    for (let i = 0; i < 50 && chat().approvalMode !== 'plan'; i++) await wait(100);
    assert.equal(chat().approvalMode, 'plan');
    assert.equal(await t.evaluate("localStorage.getItem('chat.newApprovalMode')") === 'plan', false, 'new chats do not start in plan mode');
    await t.evaluate("document.querySelector('[data-chat-options]').click(), true");
    await o.send('call tool present_plan {"plan":"1. **Write** the page\\n2. Check it"}');
    const card = "document.querySelector('[data-plan]')";
    assert.ok(await until(`Boolean(${card}) && !${card}.querySelector('[data-plan-actions]').hidden`, 10000), 'the plan card with its buttons');
    assert.deepEqual(await t.evaluate(`[${card}.querySelector('.plan__title').textContent, ${card}.querySelector('strong')?.textContent, [...${card}.querySelectorAll('[data-plan-actions] button')].map((b) => b.textContent)]`),
      ['Plan', 'Write', ['Approve and run', 'Keep planning']]);
    assert.equal(await t.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no sideways scroll');
    // Keep planning: the box gets the focus, nothing is sent
    await t.evaluate(`${card}.querySelector('[data-plan-keep]').click(), true`);
    assert.equal(await t.evaluate("document.activeElement === document.querySelector('[data-chat-input]')"), true);
    // Approve and run
    await t.evaluate(`${card}.querySelector('[data-plan-approve]').click(), true`);
    for (let i = 0; i < 50 && chat().approvalMode === 'plan'; i++) await wait(100);
    assert.equal(chat().approvalMode, before, 'back to the mode before');
    assert.ok(await until(`${o.answers}.includes('EN: The plan is approved: carry it out.')`, 10000), 'the go-ahead is sent and answered');
    assert.ok(await until(`${card}.querySelector('[data-plan-actions]').hidden`, 5000), 'no buttons once approved');
    await t.evaluate('location.reload(), true');
    assert.ok(await until(`Boolean(${card}) && ${card}.querySelector('[data-plan-actions]').hidden`, 10000), 'after reopening: the card, no buttons');
    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    assert.ok(await until(`[...${card}.querySelectorAll('[data-plan-actions] button')].map((b) => b.textContent).join('|') === 'Onayla ve uygula|Planlamaya devam'`, 5000));
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});

test('UI (phone 402 px): scrolling the chat up and down leaves the tab row, the chat list row and the header where they are, so the text moves only as far as it is scrolled (user report 09.10.2026: the rows hiding and coming back pushed the text) (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { t, until } = o;
  try {
    await o.send('first');
    assert.ok(await until(`${o.answers}.includes('EN: first')`));
    await t.evaluate("(() => { const box = document.querySelector('[data-chat-messages]'); for (let i = 0; i < 80; i++) { const d = document.createElement('div'); d.className = 'message message--assistant'; d.dataset.line = i; d.textContent = 'Line ' + i + ' of a long answer.'; box.append(d); } return true; })()");
    await wait(500);
    const at = await t.evaluate("(() => { const r = document.querySelector('[data-chat-messages]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    const wheel = async (dy, times) => {
      for (let i = 0; i < times; i++) await t.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: dy });
      await wait(600);
    };
    const place = "(() => { const top = (s) => Math.round(document.querySelector(s).getBoundingClientRect().top); const box = document.querySelector('[data-chat-messages]'); const line = box.querySelector('[data-line=\"40\"]'); return { nav: getComputedStyle(document.querySelector('.topbar__nav')).display, list: top('.chat__list'), head: top('.chat__head'), box: top('[data-chat-messages]'), line: Math.round(line.getBoundingClientRect().top + box.scrollTop) }; })()";
    await wheel(-100, 12);
    const before = await t.evaluate(place);
    await wheel(100, 4);
    assert.deepEqual(await t.evaluate(place), before, 'scrolled down: nothing above the messages moved, the text only scrolled');
    await wheel(-100, 2);
    assert.deepEqual(await t.evaluate(place), before, 'scrolled up');
    assert.equal(await t.evaluate("document.querySelector('.topbar').classList.contains('topbar--scrolled')"), false);
    assert.deepEqual(o.errors, []);
  } finally {
    await o.close();
  }
});
