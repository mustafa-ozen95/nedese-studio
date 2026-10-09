/**
 * Headless browser driver (no dependencies; Chrome DevTools Protocol over WebSocket): opens this computer's
 * Edge/Chrome in a hidden window; goes to a page, clicks with the mouse, types, scrolls, takes screenshots and returns
 * the rendered HTML/text. Data collection uses it on script-heavy sites (single-page apps, endless scrolling, cookie
 * notices); in "agent" mode the local model picks which interactive item on the screen to click. No GPU
 * (--disable-gpu): the graphics card stays free for generation and training.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { killTree } from './process.mjs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BROWSER_PATHS = [
  process.env.AI_PANEL_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function browserPath() {
  return BROWSER_PATHS.find((y) => existsSync(y)) ?? null;
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const freePort = () => new Promise((ok, error) => {
  const s = createServer();
  s.once('error', error);
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});

/** Consent buttons of cookie/subscription notices, in several languages (the first visible one is clicked). */
const CONSENT_PATTERN = 'kabul|accept|agree|tamam|anladım|anladim|got it|allow all|consent|onayl|izin ver|devam et|continue|okay|^ok$|schließen|akzeptieren|aceptar|accepter|accetta';

export class Browser {
  // lang: Chrome's --lang (the languages a page is asked in; on Windows its own buttons keep the system's language)
  constructor({ path = browserPath(), log = () => {}, userAgent = '', width = 1366, height = 2000, lang = 'tr-TR,tr,en' } = {}) {
    Object.assign(this, { path, log, userAgent, width, height, lang });
    this.proc = null;
    this.ws = null;
    this.counter = 0;
    this.pending = new Map();
    this.events = new Map();
    this.profile = null;
  }

  get isOpen() {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  async open({ timeMs = 20000 } = {}) {
    if (!this.path) throw new Error('Edge/Chrome not found (a path can be given with AI_PANEL_BROWSER).');
    if (this.isOpen) return;
    const port = await freePort();
    deleteOldProfiles();
    this.profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    const arg = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio', '--hide-scrollbars', `--lang=${this.lang}`, `--window-size=${this.width},${this.height}`, `--remote-debugging-port=${port}`, `--user-data-dir=${this.profile}`, ...(this.userAgent ? [`--user-agent=${this.userAgent}`] : []), 'about:blank'];
    this.proc = spawn(this.path, arg, { windowsHide: true, stdio: 'ignore' });
    this.proc.on('exit', () => {
      this.proc = null;
    });
    const last = Date.now() + timeMs;
    let target = null;
    while (Date.now() < last && !target) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
        target = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
      } catch {}
      if (!target) await wait(250);
    }
    if (!target) {
      await this.close();
      throw new Error('Browser did not open (DevTools connection could not be established).');
    }
    try {
      await this.connect(target);
    } catch (e) {
      // A connection / DevTools error leaves no process and no profile behind
      await this.close();
      throw e;
    }
  }

  async connect(target) {
    await new Promise((ok, error) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.addEventListener('open', () => {
        this.ws = ws;
        ok();
      });
      ws.addEventListener('error', () => error(new Error('DevTools WebSocket error')));
      ws.addEventListener('message', (m) => this.message(JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString())));
      ws.addEventListener('close', () => {
        for (const [, b] of this.pending) b.error(new Error('Browser connection closed'));
        this.pending.clear();
        this.ws = null;
      });
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false });
  }

  message(m) {
    if (m.id && this.pending.has(m.id)) {
      const b = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) b.error(new Error(`${m.error.message ?? 'CDP error'}`));
      else b.ok(m.result ?? {});
    } else if (m.method) {
      for (const d of this.events.get(m.method) ?? []) d(m.params ?? {});
    }
  }

  send(method, params = {}, timeMs = 30000) {
    if (!this.isOpen) return Promise.reject(new Error('Browser is not open'));
    const id = ++this.counter;
    return new Promise((ok, error) => {
      const z = setTimeout(() => {
        this.pending.delete(id);
        error(new Error(`CDP timeout: ${method}`));
      }, timeMs);
      this.pending.set(id, { ok: (r) => { clearTimeout(z); ok(r); }, error: (e) => { clearTimeout(z); error(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  event(method, timeMs) {
    return new Promise((ok) => {
      const list = this.events.get(method) ?? [];
      const d = (p) => {
        clearTimeout(z);
        this.events.set(method, (this.events.get(method) ?? []).filter((x) => x !== d));
        ok(p);
      };
      const z = setTimeout(() => d(null), timeMs);
      list.push(d);
      this.events.set(method, list);
    });
  }

  /** Goes to the page; waits for its load event (at most waitMs), then settleMs for its scripts to settle. */
  async goto(url, { waitMs = 12000, settleMs = 1200 } = {}) {
    const loaded = this.event('Page.loadEventFired', waitMs);
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error(`Page could not be opened: ${r.errorText}`);
    await loaded;
    await wait(settleMs);
    return this.address();
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'Script error');
    return r.result?.value;
  }

  address() {
    return this.evaluate('location.href');
  }

  html() {
    return this.evaluate('document.documentElement.outerHTML');
  }

  text() {
    return this.evaluate('document.body ? document.body.innerText : ""');
  }

  /** JPEG screenshot (base64); written to the file when a path is given. */
  async screenshot(path = null, { quality = 70, fullPage = false } = {}) {
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: quality, captureBeyondViewport: fullPage, ...(fullPage ? { clip: await this.fullPageClip() } : {}) });
    if (path) writeFileSync(path, Buffer.from(r.data, 'base64'));
    return r.data;
  }

  async fullPageClip() {
    const { width, height } = await this.evaluate('({ width: document.documentElement.scrollWidth, height: Math.min(document.documentElement.scrollHeight, 8000) })');
    return { x: 0, y: 0, width, height, scale: 1 };
  }

  async mouse(x, y, type, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type: type, x, y, button: 'left', clickCount: 1, ...extra });
  }

  /** A mouse click (move + press + release). */
  async click(x, y) {
    await this.mouse(x, y, 'mouseMoved');
    await this.mouse(x, y, 'mousePressed');
    await this.mouse(x, y, 'mouseReleased');
    await wait(400);
  }

  /** Scrolls the element of the CSS selector into view and clicks its middle. */
  async clickSelector(selector) {
    const k = await this.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
    if (!k || !k.w) return false;
    await this.click(k.x, k.y);
    return true;
  }

  async write(text) {
    await this.send('Input.insertText', { text: String(text) });
  }

  async key(key = 'Enter') {
    const code = { Enter: 13, Escape: 27, Tab: 9, PageDown: 34, End: 35 }[key] ?? 0;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  }

  async scroll(dy = 800) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.width / 2, y: this.height / 2, deltaX: 0, deltaY: dy });
    await wait(500);
  }

  /** Scrolls to the end of the page step by step (lazy content, endless scrolling); stops when the height stops growing. */
  async scrollToEnd({ maxSteps = 8 } = {}) {
    let previous = -1;
    for (let i = 0; i < maxSteps; i++) {
      const y = await this.evaluate('(() => { window.scrollBy(0, Math.max(600, innerHeight * 0.9)); return document.documentElement.scrollHeight; })()');
      await wait(700);
      if (y === previous) break;
      previous = y;
    }
    await this.evaluate('window.scrollTo(0, 0)');
    return previous;
  }

  /** Clicks the consent button of a cookie / notice window; false when there is none. */
  async dismissCookies() {
    const k = await this.evaluate(`(() => {
      const d = new RegExp(${JSON.stringify(CONSENT_PATTERN)}, 'i');
      const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 20 && r.height > 10 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const candidates = [...document.querySelectorAll('button, [role=button], a, input[type=button], input[type=submit]')].filter((e) => d.test((e.innerText || e.value || e.getAttribute('aria-label') || '').trim()) && (e.innerText || e.value || '').trim().length < 40 && visible(e));
      const e = candidates.sort((a, b) => (getComputedStyle(b).position === 'fixed') - (getComputedStyle(a).position === 'fixed'))[0];
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!k) return false;
    await this.click(k.x, k.y);
    return true;
  }

  /** Visible interactive items (a numbered list for the model): [{ i, tag, text, href, x, y }]: buttons, links, tabs, "more"… */
  async interactions(max = 60) {
    return this.evaluate(`(() => {
      const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight * 3 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const list = [];
      for (const e of document.querySelectorAll('a[href], button, [role=button], [role=tab], summary, input[type=submit], [onclick]')) {
        if (!visible(e)) continue;
        const text = (e.innerText || e.value || e.getAttribute('aria-label') || e.title || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        if (!text) continue;
        const r = e.getBoundingClientRect();
        list.push({ i: list.length, tag: e.tagName.toLowerCase(), text, href: e.href || null, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2 + scrollY) });
        if (list.length >= ${Number(max)}) break;
      }
      return list;
    })()`);
  }

  /** Clicks a numbered interactive item (the page is scrolled to bring it into view). */
  async clickItem(item) {
    await this.evaluate(`window.scrollTo(0, Math.max(0, ${Number(item.y)} - innerHeight / 2))`);
    await wait(300);
    const y = await this.evaluate(`${Number(item.y)} - scrollY`);
    await this.click(item.x, y);
    await wait(1200);
  }

  async close() {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    if (this.proc) {
      // The process tree first (while the PID is still valid; once dead it can go to another process), then the exit
      killTree(this.proc.pid);
      try {
        this.proc.kill();
      } catch {}
      for (let i = 0; i < 20 && this.proc; i++) await wait(100);
    }
    if (this.profile) {
      const p = this.profile;
      this.profile = null;
      deleteProfile(p);
    }
  }
}

const PROFILE_PREFIX = 'aipanel-browser-';
// profiles the Turkish-named versions left in Temp go with the old ones
const LEFTOVER_PREFIX = 'aipanel-tarayici-';

/**
 * Profiles left by earlier runs are deleted (older than 1 hour; one in use is skipped). Deleting on close runs on a
 * timer, so a profile stayed in Temp when the panel restarted meanwhile or Chrome did not let go of a file.
 * Measured 07.10.2026: 55 profiles in Temp, ~0.5 GB (user: "temp is bloating, needlessly"). Returns: how many were deleted.
 */
export function deleteOldProfiles(root = tmpdir(), now = Date.now()) {
  let deleted = 0;
  let names = [];
  try {
    names = readdirSync(root).filter((name) => name.startsWith(PROFILE_PREFIX) || name.startsWith(LEFTOVER_PREFIX));
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs < 3600000) continue;
      rmSync(path, { recursive: true, force: true });
      deleted += 1;
    } catch {
      /* in use: at the next start */
    }
  }
  return deleted;
}

/**
 * The temporary browser profile: tried 6 times at growing intervals until the child processes let go of the files,
 * otherwise it stays in Temp. An error thrown on a timer would bring the panel down (05.10.2026: a crash with EPERM),
 * so it never throws.
 */
function deleteProfile(p, trial = 0) {
  const t = setTimeout(() => {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 });
    } catch {
      if (trial < 5) deleteProfile(p, trial + 1);
    }
  }, 1500 * (trial + 1));
  t.unref?.();
}

/**
 * Works a page in the browser: open -> dismiss the cookie notice -> scroll to the end -> (agent: the model decides) ->
 * HTML. shotPath(step) given: each step is captured to that file. decision({ title, text, items, step }) ->
 * { action, target } ('click' target = item number | 'scroll' | 'done'); without it only the automatic steps run.
 */
export async function processWithBrowser(browser, url, { shotPath = null, decision = null, maxSteps = 4, signal = null } = {}) {
  const steps = [];
  await browser.goto(url);
  const closed = await browser.dismissCookies();
  if (closed) steps.push('cookie notice dismissed');
  await browser.scrollToEnd();
  if (shotPath) await browser.screenshot(shotPath(0));
  for (let step = 1; decision && step <= maxSteps; step++) {
    if (signal?.aborted) break;
    const items = await browser.interactions();
    const text = String(await browser.text()).slice(0, 3000);
    const title = await browser.evaluate('document.title');
    let k;
    try {
      k = await decision({ title, text, items, step });
    } catch {
      break;
    }
    if (!k || k.action === 'done') break;
    if (k.action === 'scroll') {
      await browser.scrollToEnd({ maxSteps: 4 });
      steps.push('scrolled');
    } else if (k.action === 'click' && items[Number(k.target)]) {
      const o = items[Number(k.target)];
      await browser.clickItem(o);
      steps.push(`clicked: ${o.text.slice(0, 40)}`);
    } else break;
    if (shotPath) await browser.screenshot(shotPath(step));
  }
  return { html: await browser.html(), url: await browser.address(), steps };
}
