/**
 * The chat in a headless browser for the UI tests (chat-ui.test.mjs, chat-tools-ui.test.mjs): a test panel with the fake
 * text model (fake-llm.mjs) and Edge/Chrome on its chat page, in English. Every uncaught exception, console.error and
 * red notification is recorded (a test expects none).
 */
import { createServer as netServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanel } from './env.mjs';
import { Browser, browserPath } from '../lib/browser.mjs';
import { LocalLlm } from '../lib/llm.mjs';

export const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
export const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
export const SKIP = { skip: browserPath() ? false : 'Edge/Chrome not found' };
export const freePort = () => new Promise((ok) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});

/**
 * A panel with the fake text model and a browser on its chat, in English (the browser starts in tr-TR; the stored
 * choice is written and the page opened again). until: waits for an expression in the page to be true.
 */
export async function chatPage({ width = 1366, height = 900, setting = {}, panel = {} } = {}) {
  const llm = new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', image: true, models: [{ file: 'a.gguf', name: 'a', gib: 1, image: true }], command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port), 'a.gguf'] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
  // a home folder of its own: the user's skills and MCP servers (~/.claude) stay out of the tests
  const p = await createPanel({ server: true, llm, ...panel, setting: { agentBrowser: false, agentPollingMs: 50, ...setting } });
  const t = new Browser({ width, height });
  const errors = [];
  await t.open();
  t.events.set('Runtime.exceptionThrown', [(o) => errors.push(`exception: ${o.exceptionDetails?.exception?.description ?? o.exceptionDetails?.text}`)]);
  t.events.set('Runtime.consoleAPICalled', [(o) => {
    if (o.type === 'error') errors.push(`console.error: ${o.args.map((a) => a.value ?? a.description).join(' ')}`);
  }]);
  // A red notification is an error too (an attribute the page already used made a click open a job that is not there):
  // every page records the danger toasts it shows
  await t.send('Page.addScriptToEvaluateOnNewDocument', { source: "new MutationObserver((list) => { for (const r of list) for (const n of r.addedNodes) if (n.classList?.contains('toast--danger')) console.error('toast: ' + n.textContent); }).observe(document, { childList: true, subtree: true });" });
  await t.goto(`${p.address}/#chat`);
  await t.evaluate("localStorage.setItem('lang', 'en'); true");
  await t.goto(`${p.address}/#chat`);
  const until = async (expression, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return true;
    return false;
  };
  const send = (text) => t.evaluate(`(() => { const i = document.querySelector('[data-chat-input]'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-chat-form]').requestSubmit(); return true; })()`);
  // the finished answers in the page (not the one being written)
  const answers = "[...document.querySelectorAll('.message--assistant:not(.message--live) .message__bubble')].map((b) => b.textContent)";
  const agent = p.http.agent;
  return {
    p, t, llm, errors, until, send, answers, agent,
    chat: (title) => [...agent.chats.values()].find((x) => x.title === title),
    shots: (name) => shots(t, name),
    async close() {
      await t.close();
      await llm.close();
      await p.close();
    },
  };
}

/**
 * Screenshots to check a new screen by eye (NEDESE_SHOTS=<folder>; nothing without it): the page as it is now on a phone
 * (402 px) and a desktop, light and dark, in the language it shows. The size and theme are set back after.
 */
export async function shots(t, name) {
  const folder = process.env.NEDESE_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  const theme = await t.evaluate('document.documentElement.dataset.theme ?? null');
  for (const [size, w, h, mobile] of [['phone', 402, 860, true], ['desktop', 1366, 900, false]]) {
    await t.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    for (const scheme of ['light', 'dark']) {
      await t.evaluate(`document.documentElement.dataset.theme = '${scheme}', true`);
      await wait(400);
      await t.screenshot(join(folder, `${name}-${size}-${scheme}.jpg`), { quality: 80 });
    }
  }
  await t.evaluate(theme ? `document.documentElement.dataset.theme = '${theme}', true` : 'delete document.documentElement.dataset.theme, true');
  await t.send('Emulation.clearDeviceMetricsOverride');
  await wait(300);
}

/** Puts files into the composer as the file picker does (name, type and base64 bytes for each). */
export function pickFiles(t, files) {
  return t.evaluate(`(() => {
    const dt = new DataTransfer();
    for (const f of ${JSON.stringify(files)}) dt.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const input = document.querySelector('[data-chat-file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}
