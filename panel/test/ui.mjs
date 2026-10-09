/**
 * Arayuz denetimi (elle calistirilir): Edge/Chrome'u gorunmez acar (CDP, bagimliliksiz),
 * her bolumun ekran goruntusunu alir ve OLCER: konsol hatasi, yuklenemeyen dosya, yatay
 * tasma, yerel yazi tiplerinin yuklenmesi. Ekran karti kullanmaz (--disable-gpu).
 *
 *   node panel\test\ui.mjs --address http://127.0.0.1:1071/ --output <folder> [--interaction] [--lang en|tr] [--prefix <ad>]
 *
 * Cikti: <folder>\*.png + report.json. Hata varsa cikis kodu 1.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killTree } from '../lib/process.mjs';

const a = process.argv.slice(2);
const value = (name, v) => {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : v;
};
const address = value('--address', 'http://127.0.0.1:1071/');
const output = value('--output', join(process.cwd(), 'ui-output'));
const interaction = a.includes('--interaction');
const prefix = value('--prefix', '');
// --lang en (varsayilan): kaynak dil Ingilizce; her sahnede Turkce kalinti aranir. --lang tr: sozlukle cevrilmis sayfa.
const languageChoice = value('--lang', 'en');
const missingTranslation = new Set();
mkdirSync(output, { recursive: true });

const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const browser = browsers.find(existsSync);
if (!browser) {
  console.error('Edge/Chrome not found');
  process.exit(2);
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const trace = (m) => process.env.TRACE && console.log(`[iz ${new Date().toISOString().slice(11, 23)}] ${m}`);
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'ai-panel-arayuz-'));
const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });

let target;
for (let i = 0; i < 60 && !target; i++) {
  await wait(250);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((h) => h.type === 'page');
  } catch {
    /* acilmadi */
  }
}
if (!target) {
  console.error('Browser debugging endpoint did not open');
  killTree(proc.pid);
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, red) => {
  ws.addEventListener('open', ok, { once: true });
  ws.addEventListener('error', red, { once: true });
});
let counter = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (m) => {
  const j = JSON.parse(m.data);
  if (j.id && pending.has(j.id)) {
    pending.get(j.id)(j);
    pending.delete(j.id);
  } else if (j.method) events.push(j);
});
const send = (method, params = {}) =>
  new Promise((ok, red) => {
    const id = ++counter;
    trace(`> ${method}`);
    pending.set(id, (j) => (j.error ? red(new Error(`${method}: ${j.error.message}`)) : ok(j.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`Sayfada hata: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');

async function size(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: mobile });
}

async function open(hash = '') {
  const loaded = new Promise((ok) => {
    const t = setInterval(() => {
      if (events.some((o) => o.method === 'Page.loadEventFired' && !o.seen)) {
        events.filter((o) => o.method === 'Page.loadEventFired').forEach((o) => {
          o.seen = true;
        });
        clearInterval(t);
        ok();
      }
    }, 50);
  });
  // Her seferinde TAM yukleme: ayni adres + yalniz # degisirse yukleme olayi gelmez.
  await send('Page.navigate', { url: `${address}?y=${Date.now()}${hash}` });
  await loaded;
  await run('document.fonts.ready.then(() => true)');
  // Durum yoklamasi bir kez gelsin (ust cubuk dolsun).
  for (let i = 0; i < 40; i++) {
    if (await run("document.querySelector('[data-status-ram]')?.textContent !== 'RAM –'")) break;
    await wait(100);
  }
  await wait(500);
}

const MEASURE = `(() => {
  const d = document.documentElement;
  const page = document.querySelector('.page');
  const overflowing = [...document.querySelectorAll('body *')].filter((e) => {
    if (e.closest('[hidden], .modal[hidden], template')) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.topbar__nav, .tabs, .table-wrap, .config-preview, .columns');
  }).slice(0, 6).map((e) => (e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().right));
  const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '') + ' ' + f.weight);
  return {
    title: document.title,
    theme: d.dataset.theme,
    visible: [...document.querySelectorAll('[data-section]')].filter((s) => !s.hidden).map((s) => s.dataset.section),
    horizontalOverflow: d.scrollWidth > d.clientWidth + 1 || (page && page.scrollWidth > page.clientWidth + 1),
    overflowing,
    fonts: [...new Set(loaded)],
    bodyFont: getComputedStyle(document.body).fontFamily,
    status: [...document.querySelectorAll('.topbar__counts > *')].map((e) => e.textContent.trim().replace(/\\s+/g, ' ')),
  };
})()`;

const report = { address, browser, scenes: [], errors: [] };

async function frame(name, { full = false } = {}) {
  const measurement = await run(MEASURE);
  let params = { format: 'png' };
  if (full) {
    // Uzun sayfa: kaydirilan .page'in tam boyu.
    const height = await run("Math.max(innerHeight, document.querySelector('.page').scrollHeight + document.querySelector('.topbar').offsetHeight)");
    const width = await run('innerWidth');
    await send('Emulation.setDeviceMetricsOverride', { width: width, height: Math.min(height, 4000), deviceScaleFactor: 1, mobile: width < 500 });
    await wait(300);
    params = { format: 'png' };
  }
  if (languageChoice === 'en') for (const m of (await run('JSON.stringify(window.NedeseLang ? NedeseLang.missing() : [])').then(JSON.parse))) missingTranslation.add(m);
  const r = await send('Page.captureScreenshot', params);
  const file = join(output, `${prefix}${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  report.scenes.push({ name, file, ...measurement });
  console.log(`${name}: theme ${measurement.theme}, section ${measurement.visible.join(',')}, overflow ${measurement.horizontalOverflow ? 'YES ' + measurement.overflowing.join(' | ') : 'none'}`);
}

try {
  await size(1440, 1000);
  await open('#image');
  await run("localStorage.removeItem('aiPanel.draft.v1'); localStorage.setItem('theme', 'dark'); localStorage.setItem('lang', '" + languageChoice + "'); true");
  await open('#image');
  for (const b of ['image', 'video', 'voice', 'music', 'film', 'gallery', 'settings']) {
    await run(`location.hash = '#${b}'; true`);
    await wait(700);
    if (b === 'film' && interaction) {
      await run(`(() => {
        const ekle = document.querySelector('[data-scene-add]');
        ekle.click(); ekle.click();
        const s = document.querySelectorAll('[data-scene]');
        const yaz = (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
        yaz(s[0].querySelector('[data-field="narration"]'), 'Gel otur evlat... Sana bir efsane anlatayım.');
        yaz(s[0].querySelector('[data-field="image"]'), 'An old storyteller by a campfire at night, children listening, 3D family animation');
        yaz(s[1].querySelector('[data-field="narration"]'), 'Bir zamanlar, bloklardan örülmüş sonsuz dünyalar vardı.');
        yaz(s[1].querySelector('[data-field="image"]'), 'Endless worlds built from colorful blocks at sunrise');
        return true;
      })()`);
      await wait(300);
    }
    // Etkilesimde ince ayarlar acik cekilir (kaydiricilar, model ekleme gorunsun).
    if (interaction) await run("document.querySelectorAll('[data-section]:not([hidden]) details.fine-setting').forEach((d) => { d.open = true; }); true");
    await frame(`desktop-dark-${b}`, { full: interaction || b === 'film' || b === 'settings' });
    await size(1440, 1000);
  }
  if (interaction) {
    await run(`location.hash = '#voice'; true`);
    await wait(400);
    await run(`(() => { const s = document.querySelector('[data-job-form="voice"] [data-voice-choice]'); s.value = 'spec'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await wait(300);
    await frame('desktop-dark-voice-spec');
    await run(`location.hash = '#video'; true`);
    await wait(400);
    await run(`document.querySelector('[data-picker-target="video"]').click(); true`);
    await wait(1200);
    await frame('desktop-dark-video-picker');
    await run(`document.querySelector('#modal-picker [data-modal-close]').click(); true`);
    const preview = await run(`(() => { location.hash = '#gallery'; return true; })()`);
    await wait(1200);
    if (await run(`Boolean(document.querySelector('[data-gallery] [data-preview]'))`)) {
      await run(`document.querySelector('[data-gallery] [data-preview]').click(); true`);
      await wait(1500);
      await frame('desktop-dark-preview');
      await run(`document.querySelector('#modal-preview [data-modal-close]').click(); true`);
    }
    void preview;
    // Sistem durumu penceresi
    await run(`document.querySelector('[data-modal-open="modal-system"]').click(); true`);
    await wait(1500);
    await frame('desktop-dark-system');
    await run(`document.querySelector('#modal-system [data-modal-close]').click(); true`);
    // Sahne sürükleme: 1. sahne tutamaktan tutulup 2. sahnenin altına sürüklenir (yarı yolda kare).
    await run(`(() => { location.hash = '#film'; document.querySelector('[data-scene-mode] input[value="manual"]').click(); return true; })()`);
    await wait(500);
    const position = await run(`(() => {
      const s = [...document.querySelectorAll('[data-scene]')];
      const t = s[0].querySelector('[data-scene-handle]').getBoundingClientRect();
      const target = s[1].getBoundingClientRect();
      const first = s[0].querySelector('[data-field="narration"]').value;
      const handle = s[0].querySelector('[data-scene-handle]');
      const ev = (type, y) => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: t.x + 5, clientY: y, pointerId: 7, button: 0 }));
      ev('pointerdown', t.y + 5);
      ev('pointermove', target.bottom - 10);
      window.__drag = { ev, last: target.bottom - 10 };
      return first;
    })()`);
    await wait(200);
    await frame('desktop-dark-drag');
    const after = await run(`(() => { const { ev, last } = window.__drag; ev('pointerup', last); return [...document.querySelectorAll('[data-scene]')].map((x) => x.querySelector('[data-field="narration"]').value); })()`);
    if (after[1] !== position) report.errors.push(`Drag and drop did not change the order: ${JSON.stringify(after)}`);
    else console.log('Drag and drop: scene 1 moved to position 2.');
  }
  // Acik tema
  await run("localStorage.setItem('theme', 'light'); true");
  for (const b of ['image', 'film', 'gallery']) {
    await open(`#${b}`);
    await frame(`desktop-light-${b}`);
  }
  // Telefon
  await run("localStorage.setItem('theme', 'dark'); true");
  await size(390, 844, true);
  for (const b of ['image', 'film', 'gallery']) {
    await open(`#${b}`);
    await frame(`mobile-dark-${b}`);
  }
} catch (e) {
  report.errors.push(`Script: ${e.message}`);
  console.error(e);
}

// Konsol hatalari ve yuklenemeyen dosyalar
for (const o of events) {
  if (o.method === 'Runtime.exceptionThrown') report.errors.push(`Exception: ${o.params.exceptionDetails?.exception?.description ?? o.params.exceptionDetails?.text}`);
  if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') report.errors.push(`console.error: ${o.params.args.map((x) => x.value ?? x.description).join(' ')}`);
  if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') report.errors.push(`Log: ${o.params.entry.text} ${o.params.entry.url ?? ''}`);
  if (o.method === 'Network.loadingFailed' && !o.params.canceled) report.errors.push(`Failed to load: ${o.params.errorText} ${o.params.requestId}`);
  if (o.method === 'Network.responseReceived' && o.params.response.status >= 400) report.errors.push(`HTTP ${o.params.response.status}: ${o.params.response.url}`);
  if (o.method === 'Network.requestWillBeSent' && !/^(http:\/\/(127\.0\.0\.1|localhost)|data:|about:|blob:)/.test(o.params.request.url)) report.errors.push(`External request: ${o.params.request.url}`);
}
const overflow = report.scenes.filter((s) => s.horizontalOverflow).map((s) => `${s.name}: ${s.overflowing.join(' | ')}`);
if (overflow.length) report.errors.push(...overflow.map((t) => `Horizontal overflow: ${t}`));
const fonts = report.scenes[0]?.fonts ?? [];
if (!fonts.some((y) => y.startsWith('Public Sans'))) report.errors.push(`Public Sans not loaded: ${fonts.join(', ')}`);
if (missingTranslation.size) report.errors.push(...[...missingTranslation].map((m) => `Turkish leftover on the English page: ${m}`));
writeFileSync(join(output, `${prefix}report.json`), JSON.stringify(report, null, 1), 'utf8');
console.log(`Fonts: ${fonts.join(', ')}`);
console.log(report.errors.length ? `ERRORS (${report.errors.length}):\n  ${report.errors.join('\n  ')}` : 'No errors: 0 console errors, 0 failed loads, 0 external requests, 0 horizontal overflows.');
ws.close();
// Edge alt surecleri profili tutar: agacin tamami kapanmadan klasor silinmez.
killTree(proc.pid);
await wait(800);
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch {
  /* tarayici dosyayi tutuyor olabilir */
}
process.exit(report.errors.length ? 1 : 0);
