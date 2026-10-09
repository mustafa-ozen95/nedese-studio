/**
 * Page video: a screen-recorded tour of a web page or of this panel (user request 09.10.2026: "panel istersem bir
 * panelin videosunu oluşturabiliyor mu, yapamıyorsa yapabilsin"). Edge/Chrome without a window plays the steps (open,
 * click, type, key, scroll, hover, wait) with a drawn pointer, click ripples and captions on the page itself (page
 * fonts, Turkish letters), and the browser's screencast frames become the video. A narration clip given to a step is
 * laid at the step's start and lengthens it; background music goes under the narration. Without steps it makes a
 * tour on its own: the panel's sections, or a slow scroll through any other page.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser } from '../browser.mjs';
import { UserError, CancelError } from '../errors.mjs';
import { runFfmpeg, makePreview, measureDuration, streams } from '../ffmpeg.mjs';
import { text, number, musicPath } from './common.mjs';
import { compose } from './page-video-compose.mjs';

export const name = 'Page video';
// The browser and ffmpeg work on the CPU: the GPU guard does not hold this job (an image job can run meanwhile)
export const gpuNotNeeded = true;

const FPS = 30;
const MAX_STEPS = 200;
const MAX_SECONDS = 15 * 60;
// CSS viewport and the device scale that gives the output size (sharp text, as a screen at that size shows it)
export const SIZES = {
  desktop: { width: 1280, height: 720, scale: 1.5, out: [1920, 1080], mobile: false },
  phone: { width: 432, height: 768, scale: 2.5, out: [1080, 1920], mobile: true },
  square: { width: 800, height: 800, scale: 1.35, out: [1080, 1080], mobile: false },
};
const SIZE_NAMES = { desktop: 'Desktop 1920×1080', phone: 'Phone 1080×1920', square: 'Square 1080×1080' };
// promo: the page is recorded sharper, the camera goes in on it and the window is smaller than the video
const PROMO_SCALE = { desktop: 2, phone: 3, square: 2 };
export const STYLES = ['promo', 'plain'];
export const ACTIONS = ['open', 'click', 'type', 'key', 'scroll', 'hover', 'drag', 'wait', 'device'];
// How long a step stays when it gives no seconds (the pointer and the page need a moment to be seen)
const DEFAULT_SECONDS = { open: 2.5, click: 1.6, type: 1, key: 1.2, scroll: 4, hover: 1.4, drag: 2.5, wait: 2, device: 1 };
// a drag without "by" moves this far to the right (CSS pixels): about half a turn of a 3D model
const DRAG_BY = 360;

/** The panel's own tour (no steps given, the address is this panel): every section with what it does, in the menu's order. */
const PANEL_TOUR = [
  ['chat', 'Chat: an assistant that makes images, videos, voices and music, works on files and searches the web.', 'Sohbet: görsel, video, ses ve müzik üreten, dosyalarla çalışan, webde arayan asistan.'],
  ['image', 'Image: Qwen-Image and FLUX, with LoRAs trained in the panel.', 'Görsel: Qwen-Image ve FLUX, panelde eğitilen LoRA\'larla.'],
  ['video', 'Video from an image with Wan 2.2, of any length.', 'Görselden video: Wan 2.2, istenen uzunlukta.'],
  ['voice', 'Voice: reading, voice design and your own cloned voice.', 'Ses: seslendirme, ses tasarımı ve kendi klonlanmış sesin.'],
  ['music', 'Music and songs with ACE-Step.', 'ACE-Step ile müzik ve şarkı.'],
  ['film', 'Film: a whole story from one sentence, with scenes, voices and music.', 'Film: tek cümleden sahneli, seslendirmeli, müzikli bir hikâye.'],
  ['edit', 'Edit with words: an image, a song, a voice recording or a video.', 'Sözle düzenle: görsel, şarkı, ses kaydı ya da video.'],
  ['model3d', '3D model from an image, with a turntable video and a print-ready STL.', 'Görselden 3D model: dönen tanıtım videosu ve baskıya hazır STL.'],
  ['training', 'Training: your own text, image, music and video models.', 'Eğitim: kendi yazı, görsel, müzik ve video modellerin.'],
  ['gallery', 'Gallery: everything made, in one place.', 'Galeri: üretilen her şey tek yerde.'],
  ['settings', 'Settings: models, the text model, the network and the API.', 'Ayarlar: modeller, yazı modeli, ağ ve API.'],
];

function audioPath(outputRoot, ref, name) {
  try {
    return musicPath(outputRoot, ref);
  } catch (e) {
    throw new UserError(`${name}: ${e.message}`);
  }
}

/** Address of the page: "panel" (or nothing) is this panel. */
function pageAddress(value, setting) {
  const s = String(value ?? '').trim();
  if (!s || /^panel$/i.test(s)) return { url: `http://127.0.0.1:${setting.port ?? 1071}/`, panel: true };
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new UserError(`Not a web address: ${s.slice(0, 200)}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new UserError('Only http and https pages can be recorded.');
  const own = ['127.0.0.1', 'localhost'].includes(u.hostname) && Number(u.port || 80) === Number(setting.port ?? 1071);
  return { url: u.href, panel: own };
}

export function validate(g, { setting }) {
  if (!setting.ffmpeg) throw new UserError('ffmpeg not found (<ai>\\ffmpeg\\bin); a page video cannot be made.');
  const { url, panel } = pageAddress(g.url, setting);
  const size = String(g.size ?? 'desktop');
  if (!SIZES[size]) throw new UserError(`Size: ${Object.keys(SIZES).join(', ')}.`);
  const raw = Array.isArray(g.steps) ? g.steps : [];
  if (raw.length > MAX_STEPS) throw new UserError(`At most ${MAX_STEPS} steps.`);
  const steps = raw.map((a, i) => {
    const n = `Step ${i + 1}`;
    const action = String(a?.do ?? a?.action ?? '').trim() || (a?.caption || a?.audio ? 'wait' : '');
    if (!ACTIONS.includes(action)) throw new UserError(`${n}: "do" is one of ${ACTIONS.join(', ')}.`);
    const step = { do: action };
    // "#section" moves inside the page that is open (the panel's sections), anything else opens that address
    if (action === 'open') step.url = /^#[\w/-]*$/.test(String(a.url ?? '')) ? a.url : pageAddress(a.url ?? a.target ?? url, setting).url;
    if (['click', 'type', 'hover', 'drag'].includes(action)) step.target = text(a.target, `${n} target`, { max: 500 });
    if (action === 'scroll' && a.target) step.target = text(a.target, `${n} target`, { max: 500 });
    if (action === 'scroll') step.to = ['end', 'top'].includes(a.to) ? a.to : a.by != null ? null : 'end';
    if (action === 'scroll' && a.by != null) step.by = number(a.by, `${n} by`, { min: -20000, max: 20000 });
    // drag: pressed on the target, moved "by" pixels sideways (negative: to the left), released
    if (action === 'drag') step.by = a.by != null && a.by !== '' ? number(a.by, `${n} by`, { min: -2000, max: 2000 }) : DRAG_BY;
    if (action === 'type') step.text = text(a.text, `${n} text`, { max: 2000 });
    if (action === 'key') step.key = text(a.key ?? a.text ?? 'Enter', `${n} key`, { max: 30 });
    // the page is shown as on another device from here on (a phone part in a desktop video); the video keeps its size
    if (action === 'device') step.size = SIZES[a.size] ? a.size : 'phone';
    if (a?.seconds != null && a.seconds !== '') step.seconds = number(a.seconds, `${n} seconds`, { min: 0, max: 120 });
    if (a?.caption) step.caption = text(a.caption, `${n} caption`, { max: 300 });
    if (a?.audio) {
      audioPath(setting.outputRoot, a.audio, `${n} audio`);
      step.audio = String(a.audio).trim();
    }
    return step;
  });
  const music = String(g.music ?? '').trim();
  if (music) audioPath(setting.outputRoot, music, 'Music');
  const lang = ['tr', 'en'].includes(g.lang) ? g.lang : 'tr';
  return {
    url,
    panel,
    steps,
    size,
    // promo: a window on a moving backdrop, camera moves, slides, headlines, logo opening; plain: the screen as it is
    style: STYLES.includes(g.style) ? g.style : 'promo',
    theme: ['light', 'dark'].includes(g.theme) ? g.theme : 'auto',
    lang,
    title: g.title ? text(g.title, 'Title', { max: 120 }) : null,
    subtitle: g.subtitle ? text(g.subtitle, 'Subtitle', { max: 200 }) : null,
    endTitle: g.endTitle ? text(g.endTitle, 'End title', { max: 120 }) : null,
    music: music || null,
    musicLevel: g.musicLevel != null && g.musicLevel !== '' ? number(g.musicLevel, 'Music level', { min: 0, max: 1 }) : null,
    cursor: g.cursor !== false,
    captionPosition: ['top', 'bottom'].includes(g.captionPosition) ? g.captionPosition : size === 'phone' ? 'top' : 'bottom',
    // without a choice the caption follows the device shown (above the composer on a phone)
    captionChosen: ['top', 'bottom'].includes(g.captionPosition),
  };
}

export function summary(g) {
  return { title: g.title ?? (g.panel ? 'Nedese Studio' : g.url), detail: [g.steps.length ? `${g.steps.length} steps` : 'Automatic tour', SIZE_NAMES[g.size], g.style === 'plain' ? 'Plain' : 'Promo'].join(' · ') };
}

/** Steps of a tour without steps: the panel's sections, or a slow scroll through the page. */
export function autoTour(g) {
  if (g.panel) {
    const steps = [{ do: 'open', url: `${g.url}#chat`, seconds: 1 }];
    for (const [section, en, tr] of PANEL_TOUR) steps.push({ do: 'open', url: `#${section}`, seconds: 3.5, caption: g.lang === 'tr' ? tr : en });
    return steps;
  }
  return [{ do: 'open', url: g.url, seconds: 2.5 }, { do: 'scroll', to: 'end', seconds: 12 }, { do: 'wait', seconds: 1.5 }, { do: 'scroll', to: 'top', seconds: 2 }];
}

/**
 * Drawn on the page (every document, also after a navigation): the pointer, click ripples, captions and the title
 * card. Above everything, never catches the pointer; sizes follow the viewport so phone and desktop both read well.
 */
const OVERLAY = String.raw`(() => {
  if (window.__pageVideo) return;
  const root = () => document.documentElement;
  const css = (e, s) => { e.style.cssText = s; return e; };
  let pointer = null; let caption = null; let card = null;
  const z = 'z-index:2147483647;pointer-events:none;';
  window.__pageVideo = {
    pointer(x, y, ms) {
      if (!pointer) {
        pointer = css(document.createElement('div'), 'position:fixed;left:0;top:0;width:26px;height:26px;' + z + 'transition:transform 0ms;will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));');
        pointer.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2.5v17.2l4.6-4.3 2.9 6.6 2.9-1.3-2.9-6.5h6.3z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
        root().appendChild(pointer);
      }
      pointer.style.transition = 'transform ' + (ms || 0) + 'ms cubic-bezier(.4,0,.2,1)';
      pointer.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 3) + 'px)';
    },
    ripple(x, y) {
      const r = css(document.createElement('div'), 'position:fixed;left:' + (x - 22) + 'px;top:' + (y - 22) + 'px;width:44px;height:44px;border-radius:50%;' + z + 'background:rgba(120,170,255,.35);border:2px solid rgba(120,170,255,.9);transform:scale(.3);opacity:1;transition:transform .45s ease-out,opacity .5s ease-out;');
      root().appendChild(r);
      requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.25)'; r.style.opacity = '0'; }));
      setTimeout(() => r.remove(), 700);
    },
    caption(textValue, position) {
      if (!caption) {
        caption = css(document.createElement('div'), 'position:fixed;left:50%;max-width:86vw;' + z + 'transform:translateX(-50%);opacity:0;transition:opacity .35s ease;background:rgba(12,12,16,.82);color:#fff;font:600 clamp(17px,2.3vw,30px)/1.35 "Segoe UI",system-ui,sans-serif;padding:.55em .95em;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.35);text-align:center;letter-spacing:.01em;');
        root().appendChild(caption);
      }
      caption.style.top = position === 'top' ? '5vh' : '';
      caption.style.bottom = position === 'top' ? '' : '6vh';
      if (textValue) caption.textContent = textValue;
      caption.style.opacity = textValue ? '1' : '0';
    },
    card(title, subtitle, show) {
      if (!card) {
        card = css(document.createElement('div'), 'position:fixed;inset:0;' + z + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.2vh;background:radial-gradient(120% 90% at 50% 40%,#1d2433 0%,#0b0d12 70%);color:#fff;text-align:center;padding:6vw;opacity:0;transition:opacity .6s ease;font-family:"Segoe UI",system-ui,sans-serif;');
        root().appendChild(card);
      }
      if (title !== null) {
        card.innerHTML = '';
        const t = css(document.createElement('div'), 'font-weight:700;font-size:clamp(30px,6vw,84px);letter-spacing:-.01em;line-height:1.1;');
        t.textContent = title;
        card.appendChild(t);
        if (subtitle) {
          const s = css(document.createElement('div'), 'font-weight:400;font-size:clamp(16px,2.4vw,32px);opacity:.82;max-width:80vw;line-height:1.35;');
          s.textContent = subtitle;
          card.appendChild(s);
        }
      }
      card.style.opacity = show ? '1' : '0';
    },
  };
})()`;

/** Finds the step's element (a CSS selector, else visible text: buttons and links first, the exact text first). */
const FIND = String.raw`((target) => {
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  let list = [];
  try { list = [...document.querySelectorAll(target)].filter(visible); } catch {}
  if (!list.length) {
    const want = target.trim().toLowerCase();
    const all = [...document.querySelectorAll('button,a,[role=tab],[role=button],[role=menuitem],summary,label,input,textarea,select,[data-section],h1,h2,h3,li,span,div,p')].filter(visible);
    const textOf = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.placeholder || '').trim().toLowerCase();
    const interactive = (e) => e.matches('button,a,[role=tab],[role=button],[role=menuitem],summary,label,input,textarea,select,[data-section]');
    const exact = all.filter((e) => textOf(e) === want);
    const part = all.filter((e) => textOf(e).includes(want));
    // the smallest match is the element itself, not a box around it
    const pick = (l) => l.sort((a, b) => (interactive(b) - interactive(a)) || (a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height));
    list = pick(exact).length ? exact : pick(part);
  }
  const e = list[0];
  if (!e) return null;
  e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  window.__pageVideoTarget = e;
  return true;
})`;

/** The colour at the top of the page (a promo's phone status bar takes it). */
const TINT = `(() => { for (let e = document.elementFromPoint(innerWidth / 2, 1); e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'transparent' && !/^rgba\\(.*,\\s*0\\)$/.test(c)) return c; } return 'rgb(255, 255, 255)'; })()`;

const RECT = `(() => { const e = window.__pageVideoTarget; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 40)), w: r.width, h: r.height }; })()`;

/** Smooth scroll of the element (or the biggest scrolling box of the page, or the window) over the given time. */
const SCROLL = String.raw`((target, to, by, ms) => new Promise((done) => {
  let box = null;
  if (target) { try { box = document.querySelector(target); } catch {} }
  if (!box) {
    const boxes = [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 120; });
    boxes.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    box = document.scrollingElement.scrollHeight > innerHeight + 40 ? document.scrollingElement : boxes[0] || document.scrollingElement;
  }
  const from = box.scrollTop;
  const end = box.scrollHeight - box.clientHeight;
  const goal = Math.max(0, Math.min(end, to === 'top' ? 0 : to === 'end' ? end : from + by));
  const start = performance.now();
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / Math.max(1, ms));
    box.scrollTop = from + (goal - from) * ease(t);
    if (t < 1) requestAnimationFrame(tick); else done(true);
  };
  requestAnimationFrame(tick);
}))`;

/** A caption without its *accent* marks (drawn in the accent colour in a promo). */
const unmarked = (s) => String(s ?? '').replace(/\*([^*]+)\*/g, '$1');

const wait = (ms, signal) => new Promise((ok, no) => {
  if (signal?.aborted) return no(new CancelError());
  const t = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    no(new CancelError());
  }, { once: true });
});

/** The recording: steps played in the browser, frames on disk with their times, the start time of every step. */
async function record(ctx, g, steps, frameDir) {
  const size = SIZES[g.size];
  const promo = g.style === 'promo';
  // captions and the title cards are drawn by the composing step in a promo, on the page otherwise
  const onPage = !promo;
  const scaleOf = (name) => (promo ? PROMO_SCALE[name] : SIZES[name].scale);
  const b = new Browser({ width: size.width, height: size.height, lang: g.lang === 'tr' ? 'tr-TR,tr,en' : 'en-US,en', log: (m) => ctx.log(m) });
  const frames = [];
  let first = null;
  const marks = [];
  const now = () => (first ? Date.now() / 1000 - first.wall : 0);
  try {
    await b.open();
    await b.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: scaleOf(g.size), mobile: size.mobile });
    if (size.mobile) await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
    if (g.theme !== 'auto') await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: g.theme }] }).catch(() => {});
    await b.send('Network.enable').catch(() => {});
    await b.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': g.lang === 'tr' ? 'tr-TR,tr;q=0.9,en;q=0.6' : 'en-US,en;q=0.9' } }).catch(() => {});
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY });
    // The panel opens in the chosen language and theme (it keeps them in the page's storage). pageVideo: the panel
    // leaves this recording out of its own queue and gallery (its card has no picture while it runs); the browser's
    // profile is new for every recording, so nothing stays behind.
    if (g.panel) {
      await b.goto(new URL('/?page-video=prepare', g.url).href, { settleMs: 300 });
      await b.evaluate(`localStorage.setItem('lang', ${JSON.stringify(g.lang)}); localStorage.setItem('pageVideo', '1'); ${g.theme !== 'auto' ? `localStorage.setItem('theme', ${JSON.stringify(g.theme)});` : ''} true`);
    }
    b.events.set('Page.screencastFrame', [
      (p) => {
        const i = frames.length;
        const file = join(frameDir, `f${String(i).padStart(6, '0')}.jpg`);
        writeFileSync(file, Buffer.from(p.data, 'base64'));
        const ts = p.metadata?.timestamp ?? Date.now() / 1000;
        if (!first) first = { wall: Date.now() / 1000, ts };
        frames.push({ file, t: ts - first.ts });
        b.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      },
    ]);
    const [outW, outH] = size.out;
    // The first step opens the page before the recording starts (no blank first frames)
    const opening = steps[0]?.do === 'open' ? steps.shift() : { do: 'open', url: g.url, seconds: 1.5 };
    await b.goto(opening.url.startsWith('#') ? new URL(opening.url, g.url).href : opening.url, { settleMs: 1500 });
    await b.evaluate(OVERLAY);
    let view = size;
    let viewName = g.size;
    const pointerAt = { x: size.width * 0.62, y: size.height * 0.72 };
    const place = () => (g.captionChosen ? g.captionPosition : view.mobile ? 'top' : 'bottom');
    if (g.cursor) await b.evaluate(`window.__pageVideo.pointer(${pointerAt.x}, ${pointerAt.y}, 0)`);
    if (onPage && g.title) await b.evaluate(`window.__pageVideo.card(${JSON.stringify(g.title)}, ${JSON.stringify(g.subtitle ?? '')}, true)`);
    await wait(700, ctx.signal);
    // promo: frames as sharp as the page draws (a device change may make them taller), the composing step sizes them
    const most = promo ? 2600 : null;
    await b.send('Page.startScreencast', { format: 'jpeg', quality: promo ? 90 : 88, maxWidth: most ?? outW, maxHeight: most ?? outH, everyNthFrame: 1 });
    // a still page sends no frame: the first one comes from a change
    await b.evaluate('document.documentElement.style.outline = "0px solid transparent"; true');
    for (let i = 0; i < 40 && !first; i++) await wait(50, ctx.signal);
    if (!first) throw new Error('The browser sent no picture of the page.');
    if (onPage && g.title) {
      await wait(2600, ctx.signal);
      await b.evaluate('window.__pageVideo.card(null, null, false)');
      await wait(700, ctx.signal);
    }
    const all = [{ ...opening, seconds: opening.seconds ?? 1.5, opened: true }, ...steps];
    for (const [i, a] of all.entries()) {
      if (now() > MAX_SECONDS) throw new UserError(`The video would be longer than ${MAX_SECONDS / 60} minutes.`);
      ctx.progress({ percent: 5 + (i / all.length) * (promo ? 50 : 75), stage: 'Recording', detail: `${i + 1}/${all.length} ${a.do}${a.caption ? `: ${a.caption}` : ''}` });
      const startedAt = now();
      const audioSec = a.audio ? await measureDuration(ctx.setting.ffprobe, audioPath(ctx.setting.outputRoot, a.audio, 'Audio')).catch(() => 0) : 0;
      // what the composing step needs: the step, its caption, the device shown, where it acts, when the page was ready
      const mark = { step: i, start: startedAt, do: a.do, caption: a.caption ?? '', view: viewName, audio: a.audio ? audioPath(ctx.setting.outputRoot, a.audio, 'Audio') : null };
      marks.push(mark);
      if (a.do === 'device') {
        view = SIZES[a.size];
        viewName = a.size;
        mark.view = viewName;
        await b.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: scaleOf(a.size), mobile: view.mobile });
        await b.send('Emulation.setTouchEmulationEnabled', { enabled: view.mobile, maxTouchPoints: view.mobile ? 5 : 1 }).catch(() => {});
        Object.assign(pointerAt, { x: view.width * 0.62, y: view.height * 0.72 });
        if (g.cursor) await b.evaluate(`window.__pageVideo && window.__pageVideo.pointer(${pointerAt.x}, ${pointerAt.y}, 0)`);
        await wait(500, ctx.signal);
        mark.ready = now();
      }
      if (onPage) await b.evaluate(`window.__pageVideo && window.__pageVideo.caption(${JSON.stringify(unmarked(a.caption))}, ${JSON.stringify(place())})`);
      if (a.do === 'open' && !a.opened && a.url.startsWith('#')) {
        await b.evaluate(`location.hash = ${JSON.stringify(a.url)}; true`);
        await wait(500, ctx.signal);
        mark.ready = now();
      } else if (a.do === 'open' && !a.opened) {
        await b.goto(a.url, { settleMs: 1200 });
        await b.evaluate(OVERLAY);
        if (g.cursor) await b.evaluate(`window.__pageVideo.pointer(${pointerAt.x}, ${pointerAt.y}, 0)`);
        if (onPage && a.caption) await b.evaluate(`window.__pageVideo.caption(${JSON.stringify(unmarked(a.caption))}, ${JSON.stringify(place())})`);
        mark.ready = now();
      }
      if (promo && ['open', 'device'].includes(a.do)) mark.tint = await b.evaluate(TINT).catch(() => null);
      if (['click', 'type', 'hover', 'drag'].includes(a.do)) {
        const found = await b.evaluate(`${FIND}(${JSON.stringify(a.target)})`);
        if (!found) {
          ctx.log(`Step ${i + 1}: "${a.target}" was not found on the page; the step only waits.`);
        } else {
          // FIND scrolls the element into view smoothly; a long scroll outlasts a fixed wait and the click landed where
          // the element was mid-scroll. Its place is read until it stops moving.
          let r = null;
          for (let k = 0; k < 40; k++) {
            await wait(k ? 100 : 300, ctx.signal);
            const next = await b.evaluate(RECT);
            const still = r && next && Math.abs(next.x - r.x) < 1 && Math.abs(next.y - r.y) < 1;
            r = next;
            if (still || !next) break;
          }
          if (r) {
            mark.focus = { x: r.x / view.width, y: r.y / view.height, w: r.w / view.width, h: r.h / view.height };
            const travel = Math.round(Math.min(1100, 350 + Math.hypot(r.x - pointerAt.x, r.y - pointerAt.y) * 0.9));
            if (g.cursor) await b.evaluate(`window.__pageVideo.pointer(${r.x}, ${r.y}, ${travel})`);
            await wait(travel + 120, ctx.signal);
            Object.assign(pointerAt, { x: r.x, y: r.y });
            await b.mouse(r.x, r.y, 'mouseMoved');
            if (a.do === 'drag') {
              // pressed, moved smoothly (eased) over most of the step, released: a 3D model turns under the pointer
              const ms = Math.round((a.seconds ?? DEFAULT_SECONDS.drag) * 1000 * 0.7);
              const count = Math.max(8, Math.round(ms / 33));
              const by = a.by ?? DRAG_BY;
              await b.mouse(r.x, r.y, 'mousePressed', { buttons: 1 });
              let x = r.x;
              for (let s = 1; s <= count; s++) {
                const t = s / count;
                x = r.x + by * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
                await b.mouse(x, r.y, 'mouseMoved', { buttons: 1 });
                if (g.cursor) await b.evaluate(`window.__pageVideo.pointer(${x}, ${r.y}, 0)`);
                await wait(ms / count, ctx.signal);
              }
              await b.mouse(x, r.y, 'mouseReleased', { buttons: 0 });
              pointerAt.x = x;
            } else if (a.do !== 'hover') {
              if (g.cursor) await b.evaluate(`window.__pageVideo.ripple(${r.x}, ${r.y})`);
              await b.mouse(r.x, r.y, 'mousePressed');
              await b.mouse(r.x, r.y, 'mouseReleased');
            }
            if (a.do === 'type') {
              await wait(250, ctx.signal);
              for (const ch of a.text) {
                await b.send('Input.insertText', { text: ch });
                await wait(28 + Math.random() * 55, ctx.signal);
              }
            }
          }
        }
      }
      if (a.do === 'key') await b.key(a.key);
      if (a.do === 'scroll') {
        const ms = Math.round((a.seconds ?? DEFAULT_SECONDS.scroll) * 1000 * 0.85);
        await b.evaluate(`${SCROLL}(${JSON.stringify(a.target ?? '')}, ${JSON.stringify(a.to ?? null)}, ${a.by ?? 0}, ${ms})`);
      }
      // the step lasts its seconds, at least as long as its narration
      const length = Math.max(a.seconds ?? DEFAULT_SECONDS[a.do], audioSec ? audioSec + 0.35 : 0);
      const left = length - (now() - startedAt);
      if (left > 0) await wait(left * 1000, ctx.signal);
    }
    await b.evaluate('window.__pageVideo && window.__pageVideo.caption("", "bottom")');
    if (onPage && g.endTitle) {
      await b.evaluate(`window.__pageVideo.card(${JSON.stringify(g.endTitle)}, ${JSON.stringify(g.title && g.endTitle !== g.title ? g.title : '')}, true)`);
      await wait(3000, ctx.signal);
    } else await wait(800, ctx.signal);
    const end = now();
    await b.send('Page.stopScreencast').catch(() => {});
    return { frames, marks, end };
  } finally {
    await b.close();
  }
}

/** The frames as an ffconcat list: each frame lasts until the next one (a still page sends none). */
export function frameList(frames, end) {
  const lines = ['ffconcat version 1.0'];
  for (const [i, f] of frames.entries()) {
    const next = i + 1 < frames.length ? frames[i + 1].t : end;
    lines.push(`file '${f.file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  }
  // the concat demuxer drops the last duration unless the last file is named again
  if (frames.length) lines.push(`file '${frames.at(-1).file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`);
  return `${lines.join('\n')}\n`;
}

export async function run(ctx) {
  const g = ctx.job.input;
  const k = ctx.folder;
  const frameDir = join(k, 'frames');
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const steps = (g.steps.length ? g.steps : autoTour(g)).map((a) => ({ ...a }));
  ctx.progress({ percent: 2, stage: 'Opening the page', detail: g.url });
  const { frames, marks, end } = await record(ctx, g, steps, frameDir);
  ctx.log(`Recorded ${frames.length} frames in ${end.toFixed(1)} s (${(frames.length / Math.max(1, end)).toFixed(1)} frames/s).`);
  writeFileSync(join(k, 'frames.txt'), frameList(frames, end));

  const [w, h] = SIZES[g.size].out;
  const voices = marks.filter((m) => m.audio);
  const music = g.music ? audioPath(ctx.setting.outputRoot, g.music, 'Music') : null;
  const sound = voices.length > 0 || Boolean(music);
  const pictures = sound ? 'page-video.pictures.mp4' : 'page-video.writing.mp4';
  for (const name of ['page-video.pictures.mp4', 'page-video.writing.mp4']) rmSync(join(k, name), { force: true });
  // the whole video and where the recording starts in it (after the opening in a promo)
  let total = end;
  let offset = 0;
  if (g.style === 'promo') {
    ctx.progress({ percent: 56, stage: 'Making the video', detail: 'composing' });
    ({ duration: total, intro: offset } = await compose(ctx, { g, frames, marks, end, out: [w, h], views: SIZES, fps: FPS, folder: k, output: pictures, percent: [56, sound ? 95 : 98] }));
  } else {
    // Video: frames at their times → 30 fps, padded to the exact size, a short fade in and out
    ctx.progress({ percent: 82, stage: 'Making the video', detail: 'ffmpeg' });
    const fadeOut = Math.max(0, end - 0.8).toFixed(2);
    // A page that does not fill the video (a phone part in a desktop video) sits in the middle of a blurred, darkened
    // copy of itself instead of black bars. Pictures and sound go in two passes: with a narration and a change of
    // frame size in one pass ffmpeg never ended (09.10.2026: it hung at ~95%).
    const video = `[0:v]split=2[bg][fg];[bg]scale=${Math.round(w / 8)}:${Math.round(h / 8)}:force_original_aspect_ratio=increase,crop=${Math.round(w / 8)}:${Math.round(h / 8)},boxblur=6:2,scale=${w}:${h},eq=brightness=-0.18:saturation=0.85[back];[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos[front];[back][front]overlay=(W-w)/2:(H-h)/2,fps=${FPS},fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.8,format=yuv420p[v]`;
    await runFfmpeg(ctx.setting.ffmpeg, ['-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-filter_complex', video, '-map', '[v]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', '-t', end.toFixed(2), pictures], { cwd: k, signal: ctx.signal, totalDuration: end, progress: (r) => ctx.progress({ percent: 82 + r * (sound ? 12 : 16) }) });
  }
  if (sound) {
    ctx.progress({ percent: 96, stage: 'Making the video', detail: 'sound' });
    const args = ['-i', pictures];
    for (const m of voices) args.push('-i', m.audio);
    if (music) args.push('-stream_loop', '-1', '-i', music);
    const filters = [];
    const mix = [];
    voices.forEach((m, i) => {
      const ms = Math.max(0, Math.round((offset + m.start) * 1000));
      filters.push(`[${i + 1}:a]aresample=48000,adelay=${ms}:all=1,apad[a${i}]`);
      mix.push(`[a${i}]`);
    });
    if (music) {
      // under a narration the music stays low
      const level = g.musicLevel ?? (voices.length ? 0.16 : 0.5);
      filters.push(`[${voices.length + 1}:a]aresample=48000,volume=${level},atrim=0:${total.toFixed(2)},afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[m]`);
      mix.push('[m]');
    }
    filters.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=longest,atrim=0:${total.toFixed(2)}[a]`);
    args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', total.toFixed(2), 'page-video.writing.mp4');
    await runFfmpeg(ctx.setting.ffmpeg, args, { cwd: k, signal: ctx.signal });
    rmSync(join(k, pictures), { force: true });
  }
  rmSync(join(k, 'page-video.mp4'), { force: true });
  renameSync(join(k, 'page-video.writing.mp4'), join(k, 'page-video.mp4'));
  for (const name of ['frames', 'frames.txt', 'compose.html', 'timeline.js']) rmSync(join(k, name), { recursive: true, force: true });
  // the first frame is the page before it drew (an empty dark picture in the gallery, 09.10.2026): 2 s in; a promo
  // shows its first section in the window with the headline (the opening is only the title on the backdrop)
  const coverAt = g.style === 'promo' ? offset + Math.min(1.8, end / 2) : Math.min(2, end / 2);
  await makePreview(ctx.setting.ffmpeg, 'page-video.mp4', 'page-video.preview.jpg', { cwd: k, signal: ctx.signal, at: coverAt }).catch(() => {});
  const info = await streams(ctx.setting.ffprobe, join(k, 'page-video.mp4')).catch(() => null);
  ctx.addOutput({ file: 'page-video.mp4', type: 'video', preview: existsSync(join(k, 'page-video.preview.jpg')) ? 'page-video.preview.jpg' : undefined, duration: info ? Math.round(info.duration * 100) / 100 : Math.round(total * 100) / 100, width: w, height: h, fps: FPS, main: true });
}
