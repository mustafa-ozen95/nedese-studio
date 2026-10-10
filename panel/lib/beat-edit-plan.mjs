/**
 * Beat cut of your own videos (Edit › Beat cut, user 10.10.2026: "Ritme kes", the promo's engine on any footage): the
 * cut points on the music's beat grid (longer shots in the intro, half as long after a drop, a held last shot), the
 * music's plan when the panel draws the music, and for every shot the window of a source video with the most motion
 * that does not run over a cut of its own.
 */

// beats a shot lasts in the main part
export const PACES = { calm: 4, medium: 2, fast: 1 };
// a shot is never shorter than this many beats
const SHORTEST = 0.5;

/**
 * The cut: length (seconds wanted), most (seconds there is music for), beat (seconds), pace. Returns { total, bar, bars, sections: [{ t0, t1, kind }],
 * shots: [{ t0, t1, kind, flash, punch, last }], drops: [t], end } with t = 0 on a bar line of the music.
 */
export function cutPlan({ length, most = Infinity, beat, pace = 'medium' }) {
  const bar = 4 * beat;
  const bars = Math.max(3, Math.min(Math.round(length / bar), Math.floor(most / bar + 1e-6)));
  const base = PACES[pace] ?? PACES.medium;
  const intro = bars >= 8 ? 2 : 1;
  const final = bars - 1;
  // the drops: a quarter and two thirds in (whole bars between the intro and the last shot)
  const wanted = bars >= 8 ? [Math.round(bars * 0.25), Math.round(bars * 0.65)] : bars >= 4 ? [Math.round(bars / 3)] : [];
  const drops = [...new Set(wanted.map((b) => Math.min(Math.max(b, intro + 1), final - 1)))].filter((b) => b > intro && b < final);
  const marks = [];
  marks.push({ at: 0, kind: 'intro' }, { at: intro, kind: 'a' });
  for (const [i, d] of drops.entries()) {
    // a bar of build-up before the second drop (or the only one, when there is room)
    const build = d - 1;
    if ((i > 0 || drops.length === 1) && build > (i ? drops[i - 1] : intro)) marks.push({ at: build, kind: 'build' });
    marks.push({ at: d, kind: 'b' });
  }
  marks.push({ at: final, kind: 'final' }, { at: bars, kind: null });
  const sections = [];
  for (let i = 0; i + 1 < marks.length; i++) if (marks[i + 1].at > marks[i].at) sections.push({ t0: marks[i].at * bar, t1: marks[i + 1].at * bar, kind: marks[i].kind });
  const length_ = { intro: Math.min(2 * base, 4), a: base, b: Math.max(base / 2, SHORTEST), build: Math.max(base / 4, SHORTEST), final: 4 };
  const dropTimes = drops.map((d) => d * bar);
  const shots = [];
  for (const s of sections) {
    const step = length_[s.kind] * beat;
    for (let t = s.t0; t < s.t1 - 1e-6; t += step) {
      const t1 = Math.min(s.t1, t + step);
      const first = Math.abs(t - s.t0) < 1e-6;
      const drop = first && (s.kind === 'b' || s.kind === 'a');
      shots.push({ t0: round(t), t1: round(t1), kind: s.kind, flash: drop, punch: drop || (first && s.kind === 'final'), last: s.kind === 'final' });
    }
  }
  return { total: round(bars * bar), bar, bars, beat, sections: sections.map((s) => ({ ...s, kind: s.kind === 'final' ? 'break' : s.kind })), shots, drops: dropTimes, end: round(final * bar) };
}

const round = (x) => Math.round(x * 10000) / 10000;

/** The plan of lib/promo-music.mjs makeMusic for a cut at 120 BPM: an intro hit, the drops, the last hit on the held shot. */
export function musicPlan(cut) {
  return { duration: cut.total, sections: cut.sections, cuts: [], drops: [cut.sections[1]?.t0 ?? 0, ...cut.drops].filter((t, i, a) => a.indexOf(t) === i), end: cut.end, duck: [] };
}

/** Splits n shots over the sources by their length (each source at least one when there are enough shots). */
export function share(n, durations) {
  const count = durations.length;
  if (n <= count) return durations.map((_, i) => (i < n ? 1 : 0));
  const sum = durations.reduce((s, d) => s + d, 0) || 1;
  const exact = durations.map((d) => 1 + ((n - count) * d) / sum);
  const out = exact.map(Math.floor);
  let left = n - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % count, left--) out[order[k][1]]++;
  return out;
}

/** Mean motion of a source between a and b (motion: [{ t, v }] in time order). */
function motionIn(motion, a, b) {
  let s = 0;
  let n = 0;
  for (const m of motion) {
    if (m.t < a) continue;
    if (m.t > b) break;
    s += m.v;
    n++;
  }
  return n ? s / n : 0;
}

/**
 * The source window of every shot: sources [{ duration, motion: [{ t, v }], cuts: [t] }] in the order given, each
 * source's shots in its own time order, one slot of the source per shot (as long as the shot). In its slot a shot
 * starts where it moves most without running over a cut of the source (a start right after a cut is fine). A source
 * shorter than its shots is slowed (at most to half speed) and then reused. Returns [{ source, start, speed }].
 */
export function pickShots(shots, sources) {
  const counts = share(shots.length, sources.map((s) => s.duration));
  const out = [];
  let k = 0;
  for (const [si, src] of sources.entries()) {
    const mine = shots.slice(k, k + counts[si]);
    k += counts[si];
    if (!mine.length) continue;
    const need = mine.reduce((s, x) => s + (x.t1 - x.t0), 0);
    const speed = Math.min(1, Math.max(0.5, src.duration / need));
    let cursor = 0;
    for (const shot of mine) {
      const len = (shot.t1 - shot.t0) * speed;
      const slot = (len / (need * speed)) * src.duration;
      const from = Math.min(cursor, Math.max(0, src.duration - len));
      const to = Math.max(from, Math.min(cursor + slot, src.duration) - len);
      let best = { start: from, score: -Infinity };
      const steps = Math.min(60, Math.max(1, Math.round((to - from) / 0.1)));
      for (let j = 0; j <= steps; j++) {
        const s = from + ((to - from) * j) / steps;
        const crossed = src.cuts.some((c) => c > s + 0.05 && c < s + len - 0.05);
        const score = motionIn(src.motion, s, s + len) - (crossed ? 10 : 0);
        if (score > best.score + 1e-9) best = { start: s, score };
      }
      // a cut of the source just inside the window's start: begin right after it
      const cutNear = src.cuts.find((c) => c > best.start && c <= best.start + 0.05);
      const start = cutNear !== undefined ? Math.min(cutNear + 0.04, Math.max(0, src.duration - len)) : best.start;
      out.push({ source: si, start: round(Math.max(0, start)), speed: round(speed) });
      cursor += slot;
    }
  }
  return out;
}

/** The output size: 16:9, 9:16 or 1:1 at 1080p, or the first video's own (the long side at most 1920, even). */
export function outputSize(size, first) {
  if (size === '16:9') return { width: 1920, height: 1080 };
  if (size === '9:16') return { width: 1080, height: 1920 };
  if (size === '1:1') return { width: 1080, height: 1080 };
  const s = Math.min(1, 1920 / Math.max(first.width, first.height));
  const even = (x) => Math.max(2, Math.round((x * s) / 2) * 2);
  return { width: even(first.width), height: even(first.height) };
}

/** Where the music starts: the first bar line from which a bar is at least half as loud as the middle bar (skips a quiet intro). */
export function musicStart(barLoudness, firstBar, bar) {
  const sorted = [...barLoudness].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const i = barLoudness.findIndex((v) => v >= middle * 0.5);
  return round(firstBar + Math.max(0, i) * bar);
}
