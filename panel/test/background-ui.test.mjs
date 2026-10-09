/**
 * The chat's background work in the browser (headless Edge/Chrome, CDP) at phone width, with the fake text model
 * (fake-llm.mjs "call tool <name> <json>"; user request 09.10.2026): the line above the composer counts the chat's
 * sub-agents and background items, opens their list (Open, Stop, a clock while it runs), what finished leaves the line
 * when the user writes again, the Running list nests them under their chat and stops all; Turkish labels. No uncaught
 * exception or console.error may happen. Skipped when the machine has no Edge/Chrome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createPanel } from './env.mjs';
import { Browser, browserPath } from '../lib/browser.mjs';
import { LocalLlm } from '../lib/llm.mjs';

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const SKIP = { skip: browserPath() ? false : 'Edge/Chrome not found' };
const freePort = () => new Promise((ok) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const tool = (name, input) => `call tool ${name} ${JSON.stringify(input)}`;

test('UI background line (phone 402 px): "2 sub-agents (1 running)" opens a list of both, Open goes to a sub-agent and back, Stop on the running one stops it and the line follows; what finished leaves the line when the user writes again; the Running list nests the chat\'s items and Stop all stops them; Turkish labels (headless browser)', SKIP, async () => {
  const llm = new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', image: true, models: [{ file: 'a.gguf', name: 'a', gib: 1, image: true }], command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port), 'a.gguf'] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
  const p = await createPanel({ server: true, llm, setting: { agentBrowser: false, agentPollingMs: 50 } });
  const agent = p.http.agent;
  const t = new Browser({ width: 402, height: 860 });
  const errors = [];
  try {
    await t.open();
    t.events.set('Runtime.exceptionThrown', [(o) => errors.push(`exception: ${o.exceptionDetails?.exception?.description ?? o.exceptionDetails?.text}`)]);
    t.events.set('Runtime.consoleAPICalled', [(o) => {
      if (o.type === 'error') errors.push(`console.error: ${o.args.map((a) => a.value ?? a.description).join(' ')}`);
    }]);
    // a red notification is an error too
    await t.send('Page.addScriptToEvaluateOnNewDocument', { source: "new MutationObserver((list) => { for (const r of list) for (const n of r.addedNodes) if (n.classList?.contains('toast--danger')) console.error('toast: ' + n.textContent); }).observe(document, { childList: true, subtree: true });" });
    await t.goto(`${p.address}/#chat`);
    await t.evaluate("localStorage.setItem('lang', 'en'); true");
    await t.goto(`${p.address}/#chat`);
    const until = async (expression, what, ms = 20000) => {
      for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return;
      assert.fail(`timed out: ${what} (${expression})`);
    };
    const waitFor = async (fn, what, ms = 30000) => {
      for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (fn()) return;
      assert.fail(`timed out: ${what}`);
    };
    const send = (text) => t.evaluate(`(() => { const i = document.querySelector('[data-chat-input]'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-chat-form]').requestSubmit(); return true; })()`);
    const counts = "[...document.querySelectorAll('[data-chat-background] .chat__background-count')].map((x) => x.textContent)";
    const rows = "[...document.querySelectorAll('[data-chat-background-list] [data-background-item]')]";
    const toggle = "document.querySelector('[data-chat-background]')";
    const toast = (text) => `[...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(${JSON.stringify(text)}))`;
    const idle = (id) => agent.get(id)?.status === 'idle';
    const subs = (parent) => [...agent.chats.values()].filter((c) => c.parent === parent);

    // a sub-agent that works (a long command)
    await send(tool('sub_agent', { task: tool('run_command', { command: 'Start-Sleep -Seconds 60', duration_sec: 120 }), wait: false }));
    await waitFor(() => [...agent.chats.values()].some((c) => c.parent), 'the first sub-agent');
    const parent = [...agent.chats.values()].find((c) => !c.parent).id;
    const long = subs(parent)[0].id;
    await waitFor(() => agent.get(long).work?.tool === 'run_command' && idle(parent), 'the sub-agent runs its command');
    await until(`${counts}.join('|') === '1 sub-agent running'`, 'one running sub-agent');
    assert.equal(await t.evaluate(`${toggle}.getAttribute('aria-expanded')`), 'false');
    assert.ok(await t.evaluate(`${toggle}.textContent.startsWith('Spent in this chat: ')`), 'the tokens stay on the line');
    // a second one that finishes: its result wakes the chat, and it stays on the line
    await send(tool('sub_agent', { task: 'count apples', wait: false }));
    await waitFor(() => subs(parent).length === 2, 'the second sub-agent');
    const apples = subs(parent).find((c) => c.id !== long).id;
    await waitFor(() => idle(apples) && idle(parent) && agent.get(parent).messages.at(-1).content.startsWith('EN: [Sub-agent'), 'the parent got the result');
    await until(`${counts}.join('|') === '2 sub-agents (1 running)'`, 'the line counts both');

    // the list: newest first, a clock for the running one, Open for both, Stop for the running one only
    await t.evaluate(`${toggle}.click(), true`);
    await until(`${toggle}.getAttribute('aria-expanded') === 'true' && !document.querySelector('[data-chat-background-list]').hidden && ${rows}.length === 2`, 'the list opens');
    assert.deepEqual(await t.evaluate(`${rows}.map((r) => [r.dataset.backgroundItem, r.dataset.backgroundKind, Boolean(r.querySelector('[data-background-open]')), Boolean(r.querySelector('[data-background-stop]'))])`), [[apples, 'agent', true, false], [long, 'agent', true, true]]);
    const meta = (id) => `[...document.querySelector('[data-chat-background-list] [data-background-item="${id}"] .chat__background-meta').children].map((x) => x.textContent)`;
    const done = await t.evaluate(meta(apples));
    assert.deepEqual(done.slice(0, 2), ['Sub-agent', 'done']);
    assert.match(done[2], /^\d+(\.\d)?k? tokens$/);
    assert.deepEqual((await t.evaluate(meta(long))).slice(0, 2), ['Sub-agent', 'running']);
    assert.equal(await t.evaluate(`document.querySelector('[data-background-item="${apples}"] .chat__background-name').textContent`), 'count apples');
    // the clock counts on
    const clock = `document.querySelector('[data-background-item="${long}"] [data-since]').textContent`;
    const before = await t.evaluate(clock);
    assert.match(before, /^\d+:\d\d$/);
    await until(`${clock} !== ${JSON.stringify(before)}`, 'the clock counts', 5000);
    // phone width: the long task is cut with an ellipsis, nothing scrolls sideways
    assert.equal(await t.evaluate(`getComputedStyle(document.querySelector('[data-background-item="${long}"] .chat__background-name')).textOverflow`), 'ellipsis');
    assert.ok(await t.evaluate(`document.documentElement.scrollWidth <= innerWidth && ${rows}.every((r) => r.getBoundingClientRect().right <= innerWidth && r.getBoundingClientRect().left >= 0)`), 'no horizontal scroll');

    // Open goes to the sub-agent, its line leads back to the parent
    await t.evaluate(`document.querySelector('[data-background-open="${apples}"]').click(), true`);
    await until("!document.querySelector('[data-chat-parent]').hidden", 'the sub-agent shows its parent');
    assert.ok(await t.evaluate("[...document.querySelectorAll('.message--assistant .message__bubble')].some((b) => b.textContent === 'EN: count apples')"), 'the sub-agent\'s answer');
    await t.evaluate("document.querySelector('[data-chat-parent]').click(), true");
    await until(`document.querySelector('[data-chat-parent]').hidden && ${counts}.join('|') === '2 sub-agents (1 running)'`, 'back in the parent');

    // Stop on the running row: the sub-agent and its command stop, the line follows
    if ((await t.evaluate(`${toggle}.getAttribute('aria-expanded')`)) !== 'true') await t.evaluate(`${toggle}.click(), true`);
    await until(`Boolean(document.querySelector('[data-background-stop="${long}"]'))`, 'its Stop');
    assert.equal(await t.evaluate(`document.querySelector('[data-background-stop="${long}"]').getAttribute('aria-label')`), 'Stop');
    await t.evaluate(`document.querySelector('[data-background-stop="${long}"]').click(), true`);
    await waitFor(() => idle(long), 'the sub-agent stopped');
    assert.equal(agent.get(long).messages.at(-1).content, '(stopped)');
    await until(`${counts}.join('|') === '2 sub-agents'`, 'the line follows');
    await until(`${meta(long)}[1] === 'stopped' && !document.querySelector('[data-background-stop="${long}"]')`, 'its row says stopped');
    await until(toast('Stopped: 1 sub-agent.'), 'the notification');
    await wait(1000);
    assert.equal(agent.get(parent).messages.filter((m) => m.wake).length, 1, 'a stopped sub-agent does not wake its chat');

    // writing again (user request 09.10.2026): the finished sub-agents leave the line, their chats stay
    // a background command and a wake-up of the chat: on the line, in the Running list under the chat; Stop all
    await send(tool('run_command', { command: 'Start-Sleep -Seconds 60', back_plan: true }));
    await until(`!${counts}.some((x) => x.includes('sub-agent'))`, 'the finished sub-agents leave the line');
    assert.ok(agent.peek(apples) && agent.peek(long), 'their chats stay');
    await waitFor(() => agent.processes.map.has('k1') && idle(parent), 'the background command');
    const pid = agent.processes.get('k1').proc.pid;
    await send(tool('schedule', { task: 'wake me', minute_after: 30 }));
    await waitFor(() => agent.schedules().length === 1 && idle(parent), 'the wake-up');
    const wakeup = agent.schedules()[0].id;
    await until(`${counts}.join('|') === '1 background command running|1 wake-up'`, 'the line counts them, the running command stays');
    if ((await t.evaluate(`${toggle}.getAttribute('aria-expanded')`)) !== 'true') await t.evaluate(`${toggle}.click(), true`);
    await until(`${rows}.length === 2 && ${meta('k1')}.slice(0, 2).join('|') === 'Background command|running' && ${meta(wakeup)}[0] === 'Wake-up'`, 'their rows');
    await until("!document.querySelector('[data-chat-running]').hidden && document.querySelector('[data-chat-running-count]').textContent === '2'", 'the Running button counts them');
    await t.evaluate("document.querySelector('[data-chat-running]').click(), true");
    const running = "[...document.querySelectorAll('[data-chat-running-panel] [data-running-chat], [data-chat-running-panel] [data-running-item]')].map((r) => [r.dataset.runningChat ?? r.dataset.runningItem, r.style.getPropertyValue('--depth').trim()])";
    // newest first
    const nested = [[parent, ''], [wakeup, '1'], ['k1', '1']];
    for (let i = 0; i < 100 && JSON.stringify(await t.evaluate(running)) !== JSON.stringify(nested); i++) await wait(100);
    assert.deepEqual(await t.evaluate(running), nested, 'the chat with its items under it');
    assert.ok(await t.evaluate(`document.querySelector('[data-running-chat="${parent}"]').textContent.includes('In the background')`), 'the idle chat');
    assert.ok(await t.evaluate("document.documentElement.scrollWidth <= innerWidth"), 'no horizontal scroll with the Running list');
    await t.evaluate("document.querySelector('[data-chat-stop-all]').click(), true");
    await until(toast('Stopped: 1 background command · 1 wake-up.'), 'Stop all says what it stopped');
    await waitFor(() => !alive(pid) && agent.schedules().length === 0, 'the command process and the wake-up are gone', 10000);
    await until("document.querySelector('[data-chat-running]').hidden", 'nothing runs');
    await until(`${counts}.join('|') === '1 background command'`, 'the stopped command stays listed until the next message');

    // the next message: the stopped command leaves, a new finished sub-agent shows
    await send(tool('sub_agent', { task: 'count pears', wait: false }));
    await waitFor(() => subs(parent).length === 3, 'the third sub-agent');
    const pears = subs(parent).find((c) => c.id !== long && c.id !== apples).id;
    await waitFor(() => idle(pears) && idle(parent), 'the third sub-agent finished');
    await until(`${counts}.join('|') === '1 sub-agent'`, 'only the new sub-agent');

    // Turkish
    await t.evaluate("document.querySelector('[data-language-select=\"tr\"]').click(), true");
    await until(`${counts}.join('|') === '1 alt ajan'`, 'Turkish counts');
    if ((await t.evaluate(`${toggle}.getAttribute('aria-expanded')`)) !== 'true') await t.evaluate(`${toggle}.click(), true`);
    await until(`${rows}.length === 1 && ${meta(pears)}.slice(0, 2).join('|') === 'Alt ajan|bitti'`, 'Turkish rows');
    assert.equal(await t.evaluate(`document.querySelector('[data-background-open="${pears}"]').textContent`), 'Aç');
    assert.equal(await t.evaluate("document.querySelector('[data-chat-background-list]').getAttribute('aria-label')"), 'Arka planda');
    // closed again
    await t.evaluate(`${toggle}.click(), true`);
    await until(`${toggle}.getAttribute('aria-expanded') === 'false' && document.querySelector('[data-chat-background-list]').hidden`, 'the list closes');
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await llm.close();
    await p.close();
  }
});
