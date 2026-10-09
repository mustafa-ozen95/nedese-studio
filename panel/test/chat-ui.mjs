/**
 * Chat UI check (run by hand): test panel with the fake text model + headless Edge in phone size. Sends "generate a cat
 * image" from the chat composer, waits for the tool cards and the final answer, pastes an image (Ctrl+V path via a
 * synthetic paste event), switches to Turkish and saves screenshots.
 *
 *   node panel\test\chat-ui.mjs [--output <folder>]
 */
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLlm } from '../lib/llm.mjs';
import { createPanel } from './env.mjs';

const args = process.argv.slice(2);
const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : join(process.cwd(), 'chat-ui-output');
mkdirSync(output, { recursive: true });
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const freePort = () => new Promise((ok) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});
const llm = new LocalLlm({ info: { name: 'fake-model', image: true, command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port)] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
const p = await createPanel({ server: true, llm, setting: { agentPollingMs: 100 } });

const browserPath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const debugPort = await freePort();
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'chat-ui-'))}`, '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 60 && !target; i++) {
  await wait(250);
  try {
    target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page');
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (m) => {
  const j = JSON.parse(m.data);
  if (j.id && pending.has(j.id)) {
    pending.get(j.id)(j);
    pending.delete(j.id);
  } else if (j.method === 'Runtime.exceptionThrown') errors.push(j.params.exceptionDetails?.exception?.description?.split('\n')[0]);
  else if (j.method === 'Runtime.consoleAPICalled' && j.params.type === 'error') errors.push(j.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((ok) => {
  const n = ++id;
  pending.set(n, (j) => ok(j.result ?? j));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const run = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
const shot = async (name) => writeFileSync(join(output, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const until = async (expression, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await run(expression)) return true;
    await wait(250);
  }
  return false;
};

const report = {};
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${p.address}/#chat` });
  await until("document.querySelector('[data-section=\"chat\"]') && !document.querySelector('[data-section=\"chat\"]').hidden");
  await wait(1500);
  report.topBarHasChat = await run("Boolean(document.querySelector('[data-section-link=\"chat\"]'))");
  report.emptyState = await run("Boolean(document.querySelector('[data-chat-empty]'))");
  await shot('1-empty');
  await run("(() => { const t = document.querySelector('[data-chat-input]'); t.value = 'generate a cat image'; document.querySelector('[data-chat-form]').requestSubmit(); return true; })()");
  report.answered = await until("[...document.querySelectorAll('.message--assistant .message__bubble')].some((b) => /Ready:/.test(b.textContent))", 60000);
  report.toolCards = await run("[...document.querySelectorAll('.tool__name')].map((e) => e.textContent)");
  report.toolStatus = await run("[...document.querySelectorAll('.tool .badge')].map((e) => e.textContent)");
  report.outputMedia = await run("document.querySelectorAll('.tool__outputs img, .message__bubble img').length");
  report.listItems = await run("[...document.querySelectorAll('.chat__item-name')].map((e) => e.textContent)");
  await shot('2-answer');
  // Ctrl+V: synthetic paste event with a PNG file
  report.pasted = await run(`(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#e66'; g.fillRect(0, 0, 64, 64);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    document.querySelector('[data-chat-input]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((ok) => setTimeout(ok, 1500));
    return document.querySelectorAll('.attachment-chip:not(.attachment-chip--uploading)').length;
  })()`);
  await run("(() => { const t = document.querySelector('[data-chat-input]'); t.value = 'what is this'; document.querySelector('[data-chat-form]').requestSubmit(); return true; })()");
  report.sawImage = await until("[...document.querySelectorAll('.message--assistant .message__bubble')].some((b) => /saw image|görsel gördüm/.test(b.textContent))", 30000);
  report.userAttachment = await run("document.querySelectorAll('.message--user .message__attachment').length");
  await shot('3-paste');
  // Turkish
  await run("document.querySelector('[data-language-select=\"tr\"]')?.click()");
  await wait(800);
  report.turkishMissing = await run('window.NedeseLang?.missing?.() ?? null');
  report.turkishNav = await run("document.querySelector('[data-section-link=\"chat\"]').textContent");
  await shot('4-turkish');
  report.horizontalOverflow = await run('document.documentElement.scrollWidth > innerWidth + 1');
} finally {
  report.errors = errors;
  console.log(JSON.stringify(report, null, 1));
  ws.close();
  browser.kill();
  await llm.close();
  await p.close();
}
process.exit(0);
