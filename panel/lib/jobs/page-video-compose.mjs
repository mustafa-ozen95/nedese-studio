/**
 * The promo look of a page video (user request 09.10.2026: "Geçişler sahneler reklam gibi profesyonel ve kaliteli
 * olmalı"): the recorded screen in a floating window (a phone for a phone view) on a moving backdrop, the camera easing
 * in on what is clicked or typed, a slide between sections, the captions as headlines that rise word by word, an
 * animated logo and title at the start and an end card. A page in the browser draws every output frame from its time
 * alone (render(t)), and the frames are captured one by one into ffmpeg: the result does not depend on the speed of
 * the machine, and nothing is drawn on the recorded page but the pointer.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '../browser.mjs';
import { CancelError } from '../errors.mjs';

// seconds of the opening (logo and title) and of the end card; without a title only the window flies in
export const INTRO = 3.4;
export const OUTRO = 3.8;
const SHORT_INTRO = 0.9;
const SHORT_OUTRO = 1.2;
// a section change: the slide lasts this long and ends when the new section has drawn
const TRANSITION = 0.8;
// how far the camera goes in on a clicked or typed element, per view
const MAX_ZOOM = { desktop: 1.65, square: 1.5, phone: 1.3 };
// typing is followed on the left part of a wide box, where the text grows
const TYPING_WIDTH = 0.42;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** The camera at time r: every key starts a move from where the camera is then, eased over the key's d seconds. */
export function cameraAt(keys, r) {
  const mix = (a, b, p) => ({ z: a.z + (b.z - a.z) * p, x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p });
  const step = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const part = (t, k) => Math.min(1, Math.max(0, (t - k.t) / k.d));
  let from = { z: 1, x: 0.5, y: 0.5 };
  let key = null;
  for (const k of keys) {
    if (k.t > r) break;
    if (key) from = mix(from, key, step(part(k.t, key)));
    key = k;
  }
  return key ? mix(from, key, step(part(r, key))) : from;
}

/**
 * A phone part in a wide video (user request 09.10.2026: the phone alone in the middle looked lost, "sağ alta koysana
 * düzgün bi yere"): the window steps back to the upper left and the phone stands in front of its bottom right corner.
 * The centres and the scales (to their full sizes) of the two between `top` and `bottom`.
 */
export function pairLayout(W, H, top, bottom, win, phone) {
  const room = H - top - bottom;
  // the phone covers this part of its width of the window; the two are never wider than the picture allows
  const overlap = 0.4;
  let ps = (room * 0.9) / phone.h;
  let ws = (room * 0.86) / win.h;
  const k = Math.min(1, (W * 0.9) / (win.w * ws + phone.w * ps * (1 - overlap)));
  ps *= k;
  ws *= k;
  const ww = win.w * ws, wh = win.h * ws, pw = phone.w * ps, ph = phone.h * ps;
  const left = (W - (ww + pw * (1 - overlap))) / 2;
  return {
    win: { cx: left + ww / 2, cy: top + wh / 2, s: ws },
    phone: { cx: left + ww - pw * overlap + pw / 2, cy: top + room - ph / 2, s: ps },
  };
}

/**
 * The plan of the composed video from the recording's step marks: scenes (a section or a device each), the slides
 * between them, the camera keys and the headline changes. Times are in recording seconds.
 */
export function plan({ marks, end, size }) {
  const scenes = [{ start: 0, view: marks[0]?.view ?? size, tint: marks[0]?.tint ?? null }];
  const transitions = [];
  const camera = [];
  const headlines = [];
  let headline = '';
  for (const [i, m] of marks.entries()) {
    const view = m.view ?? scenes.at(-1).view;
    const sceneChange = i > 0 && ['open', 'device'].includes(m.do);
    if (sceneChange) {
      const last = transitions.at(-1);
      // the new section is still from when it has drawn; the slide ends there and starts a little before the change
      const b = Math.min(Math.max(m.start + 0.55, (m.ready ?? m.start) + 0.08), marks[i + 1]?.start ?? end, end);
      const p0 = Math.max(b - TRANSITION, last ? last.b : 0, 0);
      transitions.push({ at: m.start, out: Math.max(0, m.start - 0.04), p0, b, from: scenes.length - 1, to: scenes.length });
      scenes.push({ start: m.start, view, tint: m.tint ?? null });
      camera.push({ t: p0, z: 1, x: 0.5, y: 0.5, d: 0.6 });
    }
    // a scene keeps its caption until another one is given; a scene without one has no headline
    const text = m.caption ? m.caption : sceneChange ? '' : headline;
    if (text !== headline || (sceneChange && text)) {
      headlines.push({ t: sceneChange ? transitions.at(-1).p0 : m.start, text });
      headline = text;
    }
    // a scene starts wide: no move of its own before its slide has ended
    const after = transitions.at(-1)?.b ?? 0;
    if (m.focus) {
      const typing = m.do === 'type' && m.focus.w > TYPING_WIDTH;
      const f = typing ? { ...m.focus, x: m.focus.x - m.focus.w / 2 + TYPING_WIDTH / 2, w: TYPING_WIDTH } : m.focus;
      const most = MAX_ZOOM[view] ?? 1.4;
      const z = clamp(Math.min((m.do === 'type' ? 0.85 : 0.6) / Math.max(f.w, 0.01), 0.5 / Math.max(f.h, 0.01)), 1, most);
      camera.push({ t: Math.max(m.start + 0.25, after), z, x: f.x, y: f.y, d: 1 });
    } else if (i > 0 && !sceneChange && ['wait', 'key', 'scroll'].includes(m.do)) {
      camera.push({ t: Math.max(m.start + (m.do === 'scroll' ? 0 : 0.5), after), z: 1, x: 0.5, y: 0.5, d: 1.1 });
    }
  }
  camera.sort((a, b) => a.t - b.t);
  return { scenes, transitions, camera, headlines };
}

/** The fonts of the panel inside the page (a file page may not load fonts from another file). */
function fontFaces() {
  const web = fileURLToPath(new URL('../../web/', import.meta.url));
  const css = readFileSync(join(web, 'css', 'fonts.css'), 'utf8');
  return css.replace(/url\('\.\.\/fonts\/([\w.-]+\.woff2)'\)/g, (_, file) => `url(data:font/woff2;base64,${readFileSync(join(web, 'fonts', file)).toString('base64')})`);
}

const PAGE = (fonts) => `<!doctype html>
<html><head><meta charset="utf-8"><title>compose</title>
<style>
${fonts}
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #0b0d0e; }
body { font-family: 'Public Sans', 'Segoe UI', system-ui, sans-serif; -webkit-font-smoothing: antialiased; color: #fff; }
#stage { position: absolute; inset: 0; overflow: hidden; }
.blob { position: absolute; left: 0; top: 0; border-radius: 50%; }
.grid { position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,.075) 1.1px, transparent 1.4px); background-size: 34px 34px; -webkit-mask-image: radial-gradient(ellipse 70% 65% at 50% 45%, #000 20%, transparent 80%); }
.vignette { position: absolute; inset: 0; background: radial-gradient(ellipse 85% 80% at 50% 48%, transparent 55%, rgba(0,0,0,.6) 100%); }
.device { position: absolute; left: 0; top: 0; transform-origin: 50% 50%; will-change: transform, opacity; }
.window { background: #16181a; border-radius: 18px; overflow: hidden; box-shadow: 0 50px 120px -20px rgba(0,0,0,.7), 0 18px 40px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.09), 0 0 140px rgba(184,241,60,.07); }
.bar { position: relative; display: flex; align-items: center; gap: 9px; padding: 0 18px; background: linear-gradient(#24272a, #1b1d1f); border-bottom: 1px solid rgba(255,255,255,.06); box-sizing: border-box; }
.bar i { width: 12px; height: 12px; border-radius: 50%; display: block; }
.address { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); height: 62%; padding: 0 16px; border-radius: 8px; background: rgba(255,255,255,.06); color: rgba(255,255,255,.62); font: 500 13px/1 'Public Sans', sans-serif; display: flex; align-items: center; gap: 7px; letter-spacing: .01em; }
.address svg { width: 11px; height: 11px; opacity: .7; }
.screen { position: relative; overflow: hidden; background: #0b0d0e; }
.page { position: absolute; left: 0; overflow: hidden; }
.status { position: absolute; left: 0; right: 0; top: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; color: #fff; font-weight: 600; letter-spacing: -.01em; }
.status svg { height: .8em; width: auto; margin-left: .3em; }
.home { position: absolute; left: 50%; transform: translateX(-50%); border-radius: 99px; background: rgba(255,255,255,.55); }
.page img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; transform-origin: 0 0; will-change: transform, opacity; }
.phone { background: linear-gradient(145deg, #2b2f33, #0d0f10 40%, #1d2023); box-shadow: 0 60px 120px -25px rgba(0,0,0,.75), 0 0 0 2px rgba(255,255,255,.08), inset 0 0 0 2px rgba(255,255,255,.06), 0 0 160px rgba(184,241,60,.08); box-sizing: border-box; }
.island { position: absolute; left: 50%; transform: translateX(-50%); background: #000; border-radius: 999px; z-index: 3; }
.headline { position: absolute; left: 0; right: 0; top: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; font-weight: 700; letter-spacing: -.022em; line-height: 1.1; will-change: transform, opacity; }
.headline .lines { max-width: 86%; }
.word { display: inline-block; overflow: hidden; vertical-align: bottom; padding: 0 .02em .1em; margin-bottom: -.1em; }
.word > span { display: inline-block; will-change: transform; }
.mark { color: #b8f13c; }
.accent { height: 6px; border-radius: 3px; background: linear-gradient(90deg, #b8f13c, #5eead4); margin-top: .42em; }
.card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; will-change: transform, opacity; }
.card .title { font-weight: 700; letter-spacing: -.03em; line-height: 1.05; }
.card .sub { font-weight: 400; color: rgba(255,255,255,.78); line-height: 1.3; max-width: 82%; }
.logo { overflow: visible; filter: drop-shadow(0 18px 40px rgba(184,241,60,.18)); }
#black { position: absolute; inset: 0; background: #000; }
</style></head>
<body><div id="stage"></div><script src="timeline.js"></script><script>
(() => {
  var T = window.TIMELINE;
  var W = T.width, H = T.height;
  var portrait = H > W * 1.2, square = !portrait && W < H * 1.2;
  var clamp = function (x, a, b) { a = a === undefined ? 0 : a; b = b === undefined ? 1 : b; return Math.min(b, Math.max(a, x)); };
  var lerp = function (a, b, p) { return a + (b - a) * p; };
  var ease = ${ease.toString()};
  var out = function (p) { return 1 - Math.pow(1 - p, 3); };
  var back = function (p) { var c = 1.5; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
  var span = function (t, a, d) { return clamp((t - a) / d); };
  var cameraAt = ${cameraAt.toString()};
  var pairLayout = ${pairLayout.toString()};
  var stage = document.getElementById('stage');
  var make = function (tag, cls, parent, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; (parent || stage).appendChild(e); return e; };
  var STATUS = '<span>9:41</span><span><svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor"/><rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg><svg viewBox="0 0 16 12"><path d="M8 11.5 5.6 8.8a3.4 3.4 0 0 1 4.8 0zM3.4 6.6a6.5 6.5 0 0 1 9.2 0l-1.4 1.5a4.5 4.5 0 0 0-6.4 0zM1.2 4.3a9.6 9.6 0 0 1 13.6 0l-1.4 1.5a7.6 7.6 0 0 0-10.8 0z" fill="currentColor"/></svg><svg viewBox="0 0 27 12"><rect x=".5" y=".5" width="23" height="11" rx="3.2" fill="none" stroke="currentColor" stroke-opacity=".45"/><rect x="2.2" y="2.2" width="19.6" height="7.6" rx="1.8" fill="currentColor"/><path d="M25 4v4a2 2 0 0 0 0-4z" fill="currentColor" fill-opacity=".5"/></svg></span>';
  var LOGO = '<svg class="logo" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d2023" stroke="rgba(255,255,255,.12)" stroke-width="1"/><path d="M12 48V16l16 32V16M49.66 18.34A8 8 0 1 0 44 32a8 8 0 1 1-5.66 13.66" fill="none" stroke="#b8f13c" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // backdrop: graphite with slow coloured light and a faint dot grid
  var blobs = [
    { c: 'rgba(184,241,60,.22)', s: 0.8, x: 0.16, y: 0.2, ax: 0.07, ay: 0.06, f: 0.05, ph: 0 },
    { c: 'rgba(45,212,191,.17)', s: 0.9, x: 0.88, y: 0.28, ax: 0.06, ay: 0.08, f: 0.04, ph: 2 },
    { c: 'rgba(99,102,241,.2)', s: 1.05, x: 0.62, y: 0.98, ax: 0.08, ay: 0.05, f: 0.035, ph: 4 },
  ].map(function (b) { b.e = make('div', 'blob'); var d = b.s * Math.max(W, H); b.d = d; b.e.style.width = d + 'px'; b.e.style.height = d + 'px'; b.e.style.background = 'radial-gradient(circle, ' + b.c + ' 0%, transparent 62%)'; return b; });
  make('div', 'grid');
  make('div', 'vignette');

  // layout: the headline band on top, the device below; without a headline the device grows into the middle
  var band = H * (portrait ? 0.215 : square ? 0.17 : 0.16);
  var fontSize = Math.round(portrait ? W * 0.066 : square ? H * 0.05 : H * 0.054);
  function fit(view, withHeadline) {
    var v = T.views[view], a = v.width / v.height;
    var top = withHeadline ? band : H * 0.075;
    var bottom = H * (withHeadline ? (portrait ? 0.07 : 0.045) : 0.075);
    var availW = W * (portrait ? 0.88 : 0.9), availH = H - top - bottom;
    var g = { mobile: v.mobile, status: 0 };
    if (v.mobile) {
      // a phone: the page between a status bar (under the island) and the home bar, clear of the round corners
      var k = 0.032, st = 0.12, hb = 0.05;
      g.sw = Math.min(availW / (1 + 2 * k), availH / (1 / a + st + hb + 2 * k));
      g.ph = g.sw / a; g.status = g.sw * st; g.home = g.sw * hb; g.sh = g.status + g.ph + g.home;
      g.pad = g.sw * k; g.w = g.sw + 2 * g.pad; g.h = g.sh + 2 * g.pad;
    } else {
      g.bar = Math.round(Math.max(30, Math.min(W, H) * 0.036));
      g.sw = Math.min(availW, (availH - g.bar) * a); g.sh = g.sw / a; g.ph = g.sh; g.w = g.sw; g.h = g.sh + g.bar;
    }
    g.x = (W - g.w) / 2; g.y = top + (availH - g.h) / 2;
    return g;
  }
  var devices = {};
  Object.keys(T.views).forEach(function (view) {
    var g1 = fit(view, true), g0 = fit(view, false);
    var e = make('div', 'device ' + (g1.mobile ? 'phone' : 'window'));
    e.style.width = g1.w + 'px'; e.style.height = g1.h + 'px';
    var screen;
    if (g1.mobile) {
      e.style.padding = g1.pad + 'px'; e.style.borderRadius = (g1.sw * 0.14 + g1.pad) + 'px';
      screen = make('div', 'screen', e); screen.style.borderRadius = (g1.sw * 0.14) + 'px';
      var island = make('div', 'island', screen); island.style.width = (g1.sw * 0.27) + 'px'; island.style.height = (g1.sw * 0.075) + 'px'; island.style.top = (g1.sw * 0.03) + 'px';
      var status = make('div', 'status', screen, STATUS); status.style.height = g1.status + 'px'; status.style.fontSize = (g1.sw * 0.042) + 'px'; status.style.padding = '0 ' + (g1.sw * 0.085) + 'px';
      var home = make('i', 'home', screen); home.style.width = (g1.sw * 0.34) + 'px'; home.style.height = Math.max(3, g1.sw * 0.013) + 'px'; home.style.bottom = (g1.home * 0.38) + 'px';
    } else {
      var bar = make('div', 'bar', e); bar.style.height = g1.bar + 'px';
      ['#ff5f57', '#febc2e', '#28c840'].forEach(function (c) { make('i', '', bar).style.background = c; });
      if (T.host) make('div', 'address', bar, '<svg viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg><span></span>').lastChild.textContent = T.host;
      screen = make('div', 'screen', e);
    }
    screen.style.width = g1.sw + 'px'; screen.style.height = g1.sh + 'px';
    var page = make('div', 'page', screen); page.style.top = g1.status + 'px'; page.style.width = g1.sw + 'px'; page.style.height = g1.ph + 'px';
    var imgs = [make('img', '', page), make('img', '', page)];
    imgs.forEach(function (i) { i.decoding = 'sync'; });
    devices[view] = { e: e, g1: g1, g0: g0, imgs: imgs, screen: screen, status: g1.mobile ? status : null, home: g1.mobile ? home : null };
  });

  // headlines: two layers (the one leaving, the one coming) of words that rise out of a mask
  var layers = [make('div', 'headline'), make('div', 'headline')];
  layers.forEach(function (l) { l.style.height = band + 'px'; l.style.fontSize = fontSize + 'px'; l.style.paddingTop = (portrait ? band * 0.08 : band * 0.06) + 'px'; l.style.boxSizing = 'border-box'; });
  function fill(layer, text) {
    if (layer.dataset.text === text) return;
    layer.dataset.text = text;
    layer.innerHTML = '';
    if (!text) return;
    var lines = make('div', 'lines', layer);
    // *a few words* are drawn in the accent colour
    var on = false;
    text.split(/\\s+/).forEach(function (w, i) {
      if (i) lines.appendChild(document.createTextNode(' '));
      if (/^\\*/.test(w)) on = true;
      var marked = on;
      if (/\\*[.,!?:;]*$/.test(w)) on = false;
      var outer = make('span', 'word' + (marked ? ' mark' : ''), lines);
      make('span', '', outer).textContent = w.replace(/\\*/g, '');
    });
    var accent = make('div', 'accent', layer);
    accent.style.width = '0px';
  }

  // opening and end cards
  function card(title, sub, logo) {
    var c = make('div', 'card');
    var l = null;
    if (logo) {
      var wrap = make('div', '', c, LOGO); l = wrap.firstChild;
      var s = Math.round(Math.min(W, H) * (portrait ? 0.2 : 0.15)); l.setAttribute('width', s); l.setAttribute('height', s);
      wrap.style.lineHeight = '0'; wrap.style.marginBottom = (s * 0.3) + 'px';
    }
    var t = make('div', 'title', c); t.style.fontSize = Math.round(portrait ? W * 0.105 : Math.min(W, H) * 0.11) + 'px';
    var letters = [];
    Array.from(title || '').forEach(function (ch) {
      var o = make('span', 'word', t); var i = make('span', '', o); i.textContent = ch === ' ' ? '\\u00a0' : ch; letters.push(i);
    });
    var bar = make('div', 'accent', c); bar.style.width = '0px'; bar.style.marginTop = (Math.min(W, H) * 0.035) + 'px';
    var u = null;
    if (sub) { u = make('div', 'sub', c); u.textContent = sub; u.style.fontSize = Math.round(portrait ? W * 0.045 : Math.min(W, H) * 0.036) + 'px'; u.style.marginTop = (Math.min(W, H) * 0.03) + 'px'; }
    var path = l ? l.querySelector('path') : null;
    var length = path ? path.getTotalLength() : 0;
    if (path) path.style.strokeDasharray = length + ' ' + length;
    return { e: c, logo: l, path: path, length: length, letters: letters, bar: bar, sub: u };
  }
  var opening = T.intro > 1.5 ? card(T.title, T.subtitle, T.panel) : null;
  var closing = T.outro > 1.5 ? card(T.closeTitle, T.closeSub, T.panel) : null;
  function playCard(k, t, show, hide) {
    // t: seconds since the card started; hide: seconds when it leaves (null: stays)
    if (!k) return;
    // it leaves forward and out of focus before the window comes in
    var gone = hide === null ? 0 : ease(span(t, hide, 0.45));
    k.e.style.opacity = String(clamp(span(t, 0, 0.35) * (1 - gone)));
    k.e.style.transform = 'translateY(' + (-gone * H * 0.03) + 'px) scale(' + lerp(1, 1.08, gone) + ')';
    k.e.style.filter = gone > 0.001 ? 'blur(' + (gone * 14).toFixed(2) + 'px)' : 'none';
    if (k.logo) {
      var p = back(span(t, 0.1, 0.75));
      k.logo.style.transform = 'scale(' + lerp(0.45, 1, p) + ') rotate(' + lerp(-8, 0, out(span(t, 0.1, 0.8))) + 'deg)';
      k.path.style.strokeDashoffset = String(k.length * (1 - out(span(t, 0.3, 0.9))));
    }
    var start = k.logo ? show : show - 0.4;
    k.letters.forEach(function (e, i) { e.style.transform = 'translateY(' + (110 * (1 - out(span(t, start + i * 0.025, 0.6)))) + '%)'; });
    k.bar.style.width = (out(span(t, start + 0.4, 0.8)) * Math.min(W, H) * 0.16) + 'px';
    if (k.sub) { var q = out(span(t, start + 0.5, 0.7)); k.sub.style.opacity = String(q); k.sub.style.transform = 'translateY(' + ((1 - q) * 18) + 'px)'; }
  }

  var black = make('div', '');
  black.id = 'black';

  // frames of the recording
  var times = T.frames.times, files = T.frames.files;
  function frameAt(r) {
    var lo = 0, hi = times.length - 1;
    if (r <= times[0]) return files[0];
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (times[mid] <= r) lo = mid; else hi = mid - 1; }
    return files[lo];
  }
  var waiting = [];
  function show(img, file) {
    if (img.dataset.file === file) return;
    img.dataset.file = file;
    img.src = 'frames/' + file;
    waiting.push(img.decode().catch(function () {}));
  }
  function place(img, g, cam, slide, opacity) {
    var z = cam.z, x = clamp(cam.x, 0.5 / z, 1 - 0.5 / z), y = clamp(cam.y, 0.5 / z, 1 - 0.5 / z);
    img.style.transform = 'translate(' + (-(x - 0.5 / z) * g.sw * z + slide * g.sw) + 'px,' + (-(y - 0.5 / z) * g.ph * z) + 'px) scale(' + z + ')';
    img.style.opacity = String(opacity);
  }
  function headlineAt(r) {
    var list = T.headlines, j = -1;
    for (var i = 0; i < list.length; i++) if (list[i].t <= r) j = i;
    return { cur: j >= 0 ? list[j] : { t: -99, text: '' }, prev: j > 0 ? list[j - 1] : { t: -99, text: '' } };
  }
  function layoutAt(r) {
    var h = headlineAt(r);
    return lerp(h.prev.text ? 1 : 0, h.cur.text ? 1 : 0, ease(span(r, h.cur.t, 0.7)));
  }
  function sceneAt(r) {
    var s = 0;
    for (var i = 0; i < T.scenes.length; i++) if (T.scenes[i].start <= r) s = i;
    return s;
  }
  // a phone's status bar has the colour of the top of its page, with dark text on a light page
  function light(c) { var m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/.exec(c || ''); return Boolean(m) && (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255 > 0.6; }
  function tint(d, s) {
    if (!d.status) return;
    var c = T.scenes[s].tint || '#0b0d0e';
    if (d.tint === c) return;
    d.tint = c;
    d.screen.style.background = c;
    d.status.style.color = light(c) ? '#111' : '#fff';
    d.home.style.background = light(c) ? 'rgba(0,0,0,.35)' : 'rgba(255,255,255,.55)';
  }
  // the window itself comes a little closer while the camera is in
  function lean(cam) { return 1 + (cam.z - 1) * 0.08; }
  // where a device stands alone: its centre and scale, with the headline band (L = 1) or without
  function pose(d, L) {
    return { cx: lerp(d.g0.x + d.g0.w / 2, d.g1.x + d.g1.w / 2, L), cy: lerp(d.g0.y + d.g0.h / 2, d.g1.y + d.g1.h / 2, L), s: lerp(d.g0.w / d.g1.w, 1, L) };
  }
  function between(a, b, p) { return { cx: lerp(a.cx, b.cx, p), cy: lerp(a.cy, b.cy, p), s: lerp(a.s, b.s, p) }; }
  function put(d, q, s, dx, dy, opacity, dim) {
    d.e.style.transform = 'translate(' + (q.cx + dx - d.g1.w / 2) + 'px,' + (q.cy + dy - d.g1.h / 2) + 'px) scale(' + (q.s * s) + ')';
    d.e.style.opacity = String(opacity);
    d.e.style.visibility = opacity > 0.001 ? 'visible' : 'hidden';
    d.e.style.filter = dim > 0.001 ? 'brightness(' + (1 - dim).toFixed(3) + ')' : 'none';
  }
  function posture(d, L, s, dx, dy, opacity) { put(d, pose(d, L), s, dx, dy, opacity, 0); }

  // a phone part in a wide video of a window: the window stays behind on the upper left (darker, with its last
  // picture from before the phone came) and the phone stands in front of its bottom right corner
  var home = T.scenes[0].view;
  var paired = !portrait && !square && !T.views[home].mobile && T.scenes.every(function (s) { return s.view === home || T.views[s.view].mobile; });
  var DIM = 0.4;
  function mobileAt(view) { return paired && T.views[view].mobile; }
  function pairOf(L, view) {
    var a = devices[home].g1, b = devices[view].g1;
    var p1 = pairLayout(W, H, band, H * 0.045, a, b), p0 = pairLayout(W, H, H * 0.075, H * 0.075, a, b);
    return { win: between(p0.win, p1.win, L), phone: between(p0.phone, p1.phone, L) };
  }
  function behind(rr) {
    var t0 = 0;
    T.transitions.forEach(function (x) { if (x.p0 <= rr && T.scenes[x.from].view === home && mobileAt(T.scenes[x.to].view)) t0 = x.out; });
    return frameAt(t0);
  }
  function stand(view, rr, L, s, gs, dy, opacity) {
    var w = devices[home];
    w.used = true;
    show(w.imgs[0], behind(rr));
    place(w.imgs[0], w.g1, { z: 1, x: 0.5, y: 0.5 }, 0, 1);
    w.imgs[1].style.opacity = '0';
    var pr = pairOf(L, view);
    put(w, pr.win, gs, 0, dy, opacity, DIM);
    put(devices[view], pr.phone, s, 0, dy, opacity, 0);
  }

  window.render = function (t) {
    waiting = [];
    var r = t - T.intro;
    var end = T.end;
    // backdrop drifts slowly
    blobs.forEach(function (b) {
      var x = b.x * W + Math.sin(t * b.f * 6.283 + b.ph) * b.ax * W - b.d / 2;
      var y = b.y * H + Math.cos(t * b.f * 5.1 + b.ph) * b.ay * H - b.d / 2;
      b.e.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    });
    // device: flies in at the end of the opening, leaves at the end
    var enter = out(span(t, T.intro - 0.55, 0.95));
    var leave = ease(span(r, end, 0.7));
    var gs = lerp(0.88, 1, enter) * lerp(1, 0.86, leave);
    var gy = (1 - enter) * H * 0.22 - leave * H * 0.04;
    var go = clamp(enter * (1 - leave));
    var L = layoutAt(Math.max(r, 0)) * (1 - leave);
    var rr = clamp(r, 0, end);
    var tr = null;
    for (var i = 0; i < T.transitions.length; i++) { var x = T.transitions[i]; if (rr >= x.p0 && rr < x.b) tr = x; }
    Object.keys(devices).forEach(function (v) { devices[v].used = false; });
    if (tr) {
      var p = ease(span(rr, tr.p0, tr.b - tr.p0));
      var fromView = T.scenes[tr.from].view, toView = T.scenes[tr.to].view;
      var outFrame = frameAt(Math.min(rr, tr.out)), inFrame = frameAt(tr.b);
      // the leaving section only goes wide; the coming one's own moves start after the slide
      var cam = cameraAt(T.camera.filter(function (k) { return k.t <= tr.p0; }), rr);
      if (fromView === toView) {
        var d = devices[toView];
        d.used = true;
        show(d.imgs[0], outFrame); show(d.imgs[1], inFrame);
        tint(d, p < 0.5 ? tr.from : tr.to);
        place(d.imgs[0], d.g1, cam, -0.16 * p, 1 - p);
        place(d.imgs[1], d.g1, { z: 1, x: 0.5, y: 0.5 }, 0.16 * (1 - p), p);
        if (mobileAt(toView)) stand(toView, rr, L, gs * lean(cam) * (1 - 0.045 * Math.sin(Math.PI * p)), gs, gy, go);
        else posture(d, L, gs * lean(cam) * (1 - 0.045 * Math.sin(Math.PI * p)), 0, gy, go);
      } else if (mobileAt(toView) || mobileAt(fromView)) {
        // the window steps back and the phone comes up in front of its corner (or goes, and the window comes forward)
        var coming = mobileAt(toView), view = coming ? toView : fromView, u = coming ? p : 1 - p;
        var w = devices[home], f = devices[view], pr = pairOf(L, view);
        w.used = f.used = true;
        show(w.imgs[0], coming ? outFrame : inFrame);
        place(w.imgs[0], w.g1, coming ? cam : { z: 1, x: 0.5, y: 0.5 }, 0, 1);
        show(f.imgs[0], coming ? inFrame : outFrame);
        place(f.imgs[0], f.g1, coming ? { z: 1, x: 0.5, y: 0.5 } : cam, 0, 1);
        w.imgs[1].style.opacity = f.imgs[1].style.opacity = '0';
        tint(f, coming ? tr.to : tr.from);
        put(w, between(pose(w, L), pr.win, u), gs * (coming ? lerp(lean(cam), 1, u) : 1), 0, gy, go, DIM * u);
        put(f, pr.phone, gs * lerp(0.9, 1, u), 0, gy + (1 - u) * H * 0.12, go * u, 0);
      } else {
        var a = devices[fromView], b = devices[toView];
        a.used = b.used = true;
        show(a.imgs[0], outFrame); show(b.imgs[0], inFrame);
        tint(a, tr.from); tint(b, tr.to);
        place(a.imgs[0], a.g1, cam, 0, 1); a.imgs[1].style.opacity = '0';
        place(b.imgs[0], b.g1, { z: 1, x: 0.5, y: 0.5 }, 0, 1); b.imgs[1].style.opacity = '0';
        posture(a, L, gs * lean(cam) * lerp(1, 0.9, p), -p * W * 0.05, gy, go * (1 - p));
        posture(b, L, gs * lerp(0.9, 1, p), (1 - p) * W * 0.05, gy, go * p);
      }
    } else {
      var v2 = T.scenes[sceneAt(rr)].view, d2 = devices[v2];
      d2.used = true;
      tint(d2, sceneAt(rr));
      show(d2.imgs[0], frameAt(rr));
      var cam2 = cameraAt(T.camera, rr);
      place(d2.imgs[0], d2.g1, cam2, 0, 1);
      d2.imgs[1].style.opacity = '0';
      if (mobileAt(v2)) stand(v2, rr, L, gs * lean(cam2), gs, gy, go);
      else posture(d2, L, gs * lean(cam2), 0, gy, go);
    }
    Object.keys(devices).forEach(function (v) { if (!devices[v].used) { devices[v].e.style.opacity = '0'; devices[v].e.style.visibility = 'hidden'; } });
    // headline: the new words rise one after another, the old ones lift away
    var h = headlineAt(Math.max(r, 0));
    fill(layers[0], h.cur.text); fill(layers[1], h.prev.text);
    var hv = clamp(enter * 1.4 - 0.4) * (1 - leave);
    var words = layers[0].querySelectorAll('.word > span');
    for (var k = 0; k < words.length; k++) words[k].style.transform = 'translateY(' + (110 * (1 - out(span(r, h.cur.t + 0.12 + k * 0.055, 0.6)))) + '%)';
    var acc = layers[0].querySelector('.accent');
    if (acc) acc.style.width = (out(span(r, h.cur.t + 0.35, 0.7)) * Math.min(W, H) * 0.09) + 'px';
    layers[0].style.opacity = String(hv);
    layers[0].style.transform = 'none';
    var q = ease(span(r, h.cur.t, 0.4));
    layers[1].style.opacity = String((1 - q) * hv);
    layers[1].style.transform = 'translateY(' + (-q * fontSize * 0.5) + 'px)';
    // cards
    if (opening) { opening.e.style.visibility = t < T.intro ? 'visible' : 'hidden'; playCard(opening, t, 0.55, T.intro - 1); }
    if (closing) { closing.e.style.visibility = r > end ? 'visible' : 'hidden'; playCard(closing, Math.max(0, r - end - 0.3), 0.75, null); }
    // from black at the start, to black at the end
    black.style.opacity = String(Math.max(1 - span(t, 0, 0.5), span(t, T.duration - 0.6, 0.6)));
    return Promise.all(waiting).then(function () { return new Promise(function (ok) { requestAnimationFrame(function () { ok(true); }); }); });
  };
  window.ready = document.fonts.ready.then(function () { return document.fonts.load('700 40px "Public Sans"'); }).then(function () { return true; });
})();
</script></body></html>
`;

/**
 * Draws the composed video into `output` (pictures only) from the recording; returns its length and the opening's,
 * which the narration is moved by.
 */
export async function compose(ctx, { g, frames, marks, end, out, views, fps, folder, output, percent = [80, 94] }) {
  const [W, H] = out;
  const intro = g.title ? INTRO : SHORT_INTRO;
  const closeTitle = g.title || g.endTitle || '';
  const closeSub = g.endTitle && g.endTitle !== closeTitle ? g.endTitle : g.subtitle || '';
  const outro = closeTitle ? OUTRO : SHORT_OUTRO;
  const duration = intro + end + outro;
  let host = '';
  try {
    const u = new URL(g.url);
    host = g.panel ? u.host : u.hostname.replace(/^www\./, '');
  } catch {}
  const timeline = {
    width: W,
    height: H,
    intro,
    outro,
    end,
    duration,
    panel: Boolean(g.panel),
    host,
    title: g.title || '',
    subtitle: g.subtitle || '',
    closeTitle,
    closeSub,
    views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { width: v.width, height: v.height, mobile: v.mobile }])),
    frames: { files: frames.map((f) => f.file.split(/[\\/]/).pop()), times: frames.map((f) => Math.round(f.t * 10000) / 10000) },
    ...plan({ marks, end, size: g.size }),
  };
  writeFileSync(join(folder, 'compose.html'), PAGE(fontFaces()));
  writeFileSync(join(folder, 'timeline.js'), `window.TIMELINE = ${JSON.stringify(timeline)};\n`);

  const count = Math.ceil(duration * fps);
  const enc = spawn(ctx.setting.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { cwd: folder, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let errorText = '';
  enc.stderr.on('data', (d) => {
    errorText = (errorText + d).slice(-4000);
  });
  enc.stdin.on('error', () => {});
  const closed = new Promise((ok) => enc.on('close', (code) => ok(code)));
  const write = (buffer) => new Promise((ok) => (enc.stdin.write(buffer) ? ok() : enc.stdin.once('drain', ok)));
  const b = new Browser({ width: W, height: H, log: (m) => ctx.log(m) });
  let finished = false;
  try {
    await b.open();
    await b.goto(new URL(`file:///${join(folder, 'compose.html').replaceAll('\\', '/')}`).href, { settleMs: 200 });
    if (!(await b.evaluate('window.ready'))) throw new Error('The composing page did not start.');
    const started = Date.now();
    for (let i = 0; i < count; i++) {
      if (ctx.signal?.aborted) throw new CancelError();
      if (enc.exitCode !== null) throw new Error(`ffmpeg stopped: ${errorText.trim().slice(-400)}`);
      await b.evaluate(`render(${(i / fps).toFixed(5)})`);
      const shot = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 94 });
      await write(Buffer.from(shot.data, 'base64'));
      if (i % 15 === 0) {
        const left = ((Date.now() - started) / Math.max(1, i)) * (count - i) / 1000;
        ctx.progress({ percent: percent[0] + (i / count) * (percent[1] - percent[0]), stage: 'Making the video', detail: `composing ${i}/${count} frames${i > 30 ? ` · ~${Math.ceil(left / 60)} min left` : ''}` });
      }
    }
    enc.stdin.end();
    const code = await closed;
    finished = true;
    if (code !== 0) throw new Error(`ffmpeg: ${errorText.trim().slice(-500)}`);
    ctx.log(`Composed ${count} frames in ${Math.round((Date.now() - started) / 1000)} s.`);
  } finally {
    if (!finished) {
      enc.stdin.destroy();
      enc.kill();
    }
    await b.close();
  }
  return { duration, intro };
}
