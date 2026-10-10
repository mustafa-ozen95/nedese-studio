/**
 * The beat cut of a promo (user 10.10.2026: the panel cuts its promo itself, as the scratch cut of the first promos
 * did): the recording's timeline (page-video-compose plan + frames) becomes blocks, one per headline or section; a block
 * is sped up where the page only waits, every scene cut lands on the 120 BPM grid (a whip for a section change of the
 * same device, a bar line for the big ones), and the narration of a scene starts with its block. Returns the composing
 * page's timeline (with the whips, flashes, shakes and the beat pulse) and the music's plan.
 */
import { BAR } from './promo-music.mjs';

export const INTRO = 2 * BAR;
export const OUTRO = 2 * BAR;
// a whip lasts twice this, the device change this
const WHIP = 0.18;
const DEVICE = 0.5;
// waiting is kept at this part of its length before the rest is sped up
const IDLE = 0.2;

const near = (a, b) => Math.abs(a - b) < 0.006;

/**
 * Blocks of the recording R ({ end, scenes, transitions, headlines: [{ t, text, scene }], frames }): a slide inside the
 * recording is a cut (a whip on the same device, else a device change), a headline change a cut without a change.
 */
export function blocksOf(R) {
  const from = 0;
  const to = R.end;
  const sceneAt = (s) => R.scenes.reduce((k, sc, i) => (sc.start <= s + 1e-6 ? i : k), 0);
  const tiedTo = (h) => R.transitions.find((x) => near(h.t, x.p0));
  const firstHeadline = [...R.headlines].filter((h) => h.t <= from + 0.1).at(-1);
  let caption = firstHeadline?.text ?? '';
  let scene = firstHeadline?.scene;
  const cuts = [];
  for (const x of R.transitions) {
    if (x.at <= from + 0.05 || x.b >= to - 0.05) continue;
    const h = R.headlines.find((y) => near(y.t, x.p0));
    cuts.push({ end: x.out, start: x.b, change: R.scenes[x.from].view === R.scenes[x.to].view ? 'whip' : 'device', caption: h?.text, scene: h?.scene });
  }
  for (const h of R.headlines) if (h.t > from + 0.1 && h.t < to - 0.01 && !tiedTo(h)) cuts.push({ end: h.t, start: h.t, change: null, caption: h.text, scene: h.scene });
  cuts.sort((a, b) => a.start - b.start);
  const blocks = [];
  let s0 = from;
  let change = null;
  for (const c of [...cuts, { end: to, start: null }]) {
    const sc = R.scenes[sceneAt(s0 + 0.01)];
    blocks.push({ s0, s1: c.end, caption, scene, change, view: sc.view, tint: sc.tint });
    if (c.start === null) break;
    s0 = c.start;
    change = c.change;
    if (c.caption !== undefined) {
      caption = c.caption;
      scene = c.scene;
    }
  }
  // a scene's narration is said once, when its first block comes
  let last;
  for (const b of blocks) {
    b.key = b.scene !== undefined && b.scene !== null && b.scene !== last ? b.scene : undefined;
    if (b.scene !== undefined && b.scene !== null) last = b.scene;
  }
  return blocks;
}

/** Seconds of the block the page moves (two frames or more in a half second) and only waits. */
function activity(b, times) {
  let active = 0;
  let idle = 0;
  const bins = [];
  for (let t = b.s0; t < b.s1 - 1e-6; t += 0.5) {
    const e = Math.min(t + 0.5, b.s1);
    const n = times.filter((x) => x >= t && x < e).length;
    const on = n >= 2 * ((e - t) / 0.5);
    bins.push({ t, e, on });
    if (on) active += e - t;
    else idle += e - t;
  }
  return { active, idle, bins };
}

/**
 * Places the blocks on the grid: a block lasts its narration (+ a breath) or what its activity needs, sped up 1.5×,
 * and ends where the next cut lands (a half beat; a beat for a change; a bar for a big scene). Returns the end.
 */
export function layout(blocks, { times, narration, big }) {
  let cursor = 0;
  blocks.forEach((b, i) => {
    const next = blocks[i + 1];
    const a = activity(b, times);
    b.bins = a.bins;
    b.narr = b.key !== undefined ? narration[b.key] ?? 0 : 0;
    const need = b.narr ? b.narr + 0.45 : 0.8;
    const squeezed = a.active + IDLE * a.idle;
    b.want = Math.min(Math.max(squeezed / 1.5, need), Math.max(need, b.narr ? b.narr + 2.5 : 1.6));
    const lead = next?.change === 'device' ? DEVICE : 0;
    const grid = !next ? BAR : next.change || next.key !== undefined ? (big.has(next.key) ? BAR : 1) : 0.5;
    b.o0 = cursor;
    const e = cursor + b.want + lead;
    let stop = Math.ceil(e / grid - 1e-6) * grid;
    if (stop - grid >= cursor + need + lead - 0.15 && e - (stop - grid) <= 0.15) stop -= grid;
    b.o1 = stop - lead;
    cursor = stop;
  });
  return cursor;
}

/** The output time of a recording second inside its block: waiting squeezed first, then everything sped up. */
export function warp(b) {
  const L = b.o1 - b.o0;
  const raw = b.s1 - b.s0;
  if (raw <= L) return { at: (s) => b.o0 + (s - b.s0), speed: 1 };
  let wOn = 1;
  let wOff = 1;
  const on = b.bins.filter((x) => x.on).reduce((s, x) => s + (x.e - x.t), 0);
  const off = raw - on;
  if (on + IDLE * off <= L) wOff = off > 0 ? (L - on) / off : 1;
  else {
    wOn = L / (on + IDLE * off);
    wOff = IDLE * wOn;
  }
  const at = (s) => {
    let o = b.o0;
    for (const x of b.bins) {
      if (s <= x.t) break;
      o += (Math.min(s, x.e) - x.t) * (x.on ? wOn : wOff);
    }
    return o;
  };
  return { at, speed: 1 / Math.min(wOn, 1) };
}

/** The scenes whose cut is a bar line with a drop: about a quarter in, about two thirds in, and the last two. */
export function bigScenes(count) {
  if (count < 4) return { drops: count > 1 ? [count - 1] : [], rest: null };
  const first = Math.max(1, Math.round(count * 0.25));
  const second = Math.max(first + 1, Math.round(count * 0.65));
  const rest = count >= 6 ? count - 2 : null;
  return { drops: second < (rest ?? count) ? [first, second] : [first], rest };
}

/**
 * The cut: R the recording's timeline, narration[scene] its clip's seconds, card: { title, subtitle, closeTitle,
 * closeSub, panel, host }. Returns { T (the composing page's timeline, times from the video start), music (the plan
 * of promo-music), narration: [{ scene, t, length }], blocks }.
 */
export function beatCut(R, narration, card = {}) {
  const blocks = blocksOf(R);
  const count = narration.length;
  const { drops, rest } = bigScenes(count);
  const last = count - 1;
  const big = new Set([...drops, ...(rest !== null ? [rest] : []), last]);
  const end = layout(blocks, { times: R.frames.times, narration, big });
  const frames = [];
  const scenes = [];
  const transitions = [];
  const camera = [];
  const headlines = [];
  let caption = null;
  const resets = R.transitions.map((x) => x.p0);
  for (const [i, b] of blocks.entries()) {
    const w = warp(b);
    b.speed = w.speed;
    const c = b.o0;
    if (i === 0) scenes.push({ start: 0, view: b.view, tint: b.tint });
    else if (b.change) {
      const from = scenes.length - 1;
      scenes.push({ start: c, view: b.view, tint: b.tint });
      if (b.change === 'whip') {
        transitions.push({ at: c, out: c, p0: c - WHIP, b: c + WHIP, from, to: from + 1, kind: 'whip' });
        camera.push({ t: c, z: 1, x: 0.5, y: 0.5, d: 0.04 });
      } else {
        transitions.push({ at: c - DEVICE / 2, out: c - DEVICE, p0: c - DEVICE, b: c, from, to: from + 1, kind: 'device' });
        camera.push({ t: c - DEVICE, z: 1, x: 0.5, y: 0.5, d: DEVICE });
      }
    }
    // frames: the one on screen when the block starts, then the block's own
    const ts = R.frames.times;
    let k = 0;
    while (k + 1 < ts.length && ts[k + 1] <= b.s0) k++;
    frames.push({ t: b.o0, file: R.frames.files[k] });
    for (let j = k + 1; j < ts.length && ts[j] < b.s1; j++) frames.push({ t: w.at(ts[j]), file: R.frames.files[j] });
    // the block's own camera moves (not the resets of the recording's slides)
    for (const key of R.camera) {
      if (key.t < b.s0 || key.t >= b.s1) continue;
      if (resets.some((p) => near(p, key.t)) && key.z === 1 && key.x === 0.5 && key.y === 0.5) continue;
      const t = Math.min(Math.max(w.at(key.t), b.o0 + (b.change ? WHIP + 0.05 : 0)), b.o1 - 0.05);
      camera.push({ t, z: key.z, x: key.x, y: key.y, d: Math.min(key.d, Math.max(0.35, key.d / w.speed)) });
    }
    if (b.caption !== caption) {
      headlines.push({ t: i === 0 ? 0.05 : b.change === 'device' ? c - DEVICE : c - 0.12, text: b.caption });
      caption = b.caption;
    }
  }
  frames.sort((a, b) => a.t - b.t);
  camera.sort((a, b) => a.t - b.t);

  // the music's plan and the drawn hits, in video seconds
  const abs = (r) => INTRO + r;
  const startOf = (scene) => blocks.find((b) => b.key === scene);
  const at = (scene) => (startOf(scene) ? abs(startOf(scene).o0) : null);
  const finish = abs(end);
  const marks = [...drops.map(at), rest !== null ? at(rest) : null].filter((t) => t !== null);
  const [d1 = finish, d2 = null] = drops.map(at).filter((t) => t !== null);
  const breakAt = rest !== null ? at(rest) ?? finish : finish;
  const sections = [{ t0: 0, t1: INTRO, kind: 'intro' }, { t0: INTRO, t1: d1, kind: 'a' }];
  if (d2 !== null) {
    const buildFrom = Math.max(d1, d2 - 2 * BAR);
    sections.push({ t0: d1, t1: buildFrom, kind: 'b' }, { t0: buildFrom, t1: d2, kind: 'build' }, { t0: d2, t1: breakAt, kind: 'b' });
  } else sections.push({ t0: d1, t1: breakAt, kind: 'b' });
  sections.push({ t0: breakAt, t1: finish, kind: 'break' });
  const music = {
    duration: INTRO + end + OUTRO,
    sections: sections.filter((s) => s.t1 - s.t0 > 0.01),
    cuts: blocks.filter((b, i) => i > 0 && b.change).map((b) => abs(b.change === 'device' ? b.o0 - DEVICE / 2 : b.o0)),
    drops: [INTRO, ...drops.map(at).filter((t) => t !== null)],
    end: finish,
    duck: blocks.filter((b) => b.narr).map((b) => [abs(b.o0) + 0.1, abs(b.o0) + 0.1 + b.narr]),
  };
  const pulses = [];
  if (d2 !== null) pulses.push([d1, Math.max(d1, d2 - 2 * BAR)], [d2, breakAt]);
  else pulses.push([d1, breakAt]);
  const T = {
    width: R.width,
    height: R.height,
    intro: INTRO,
    outro: OUTRO,
    end,
    duration: INTRO + end + OUTRO,
    panel: Boolean(card.panel),
    host: card.host ?? R.host ?? '',
    title: card.title ?? '',
    subtitle: card.subtitle ?? '',
    closeTitle: card.closeTitle ?? card.title ?? '',
    closeSub: card.closeSub ?? '',
    views: R.views,
    frames: { files: frames.map((f) => f.file), times: frames.map((f) => Math.round(f.t * 10000) / 10000) },
    scenes,
    transitions,
    camera,
    headlines,
    // the promo's look on the composing page (page-video-compose): the window and the phone side by side in a wide
    // video, quicker headlines, the end card on the last hit, flashes and shakes on the drops, a pulse on the beat
    pair: 'corner',
    wordGap: 0.045,
    wordTime: 0.36,
    closeDelay: 0,
    closeShow: 0.45,
    leaveLead: 0.2,
    leaveTime: 0.45,
    flashes: [[INTRO, 0.22, 0.2], ...marks.slice(0, 2).map((t) => [t, 0.3, 0.2]), [finish, 0.3, 0.25]],
    shakes: [...marks.slice(0, 2).map((t) => [t, 7]), [finish, 9]],
    pulses: pulses.filter(([a, b]) => b - a > 0.01),
  };
  const spoken = blocks.filter((b) => b.narr).map((b) => ({ scene: b.key, t: abs(b.o0) + 0.1, length: b.narr }));
  return { T, music, narration: spoken, blocks };
}
