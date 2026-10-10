/**
 * A promo's music, synthesised to its cut (user 10.10.2026: the panel makes its promo itself, "kurgu için"): 120 BPM,
 * A minor (Am F C G a bar each), every scene cut on the beat with a whoosh, drops with a crash and an impact, the music
 * ducked under the narration. Nothing downloaded: no copyright claim on the video. With a base (a track made by the
 * music model, already on the grid) only the hits are drawn on it.
 */
import { writeFileSync } from 'node:fs';

export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const SR = 48000;
const SIXTEENTH = BEAT / 4;

// ── building blocks ──
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** RBJ biquad: low, high or band pass. */
class Filter {
  constructor(kind, f, q = 0.707) {
    this.kind = kind;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(f, q);
  }

  set(f, q = this.q) {
    this.q = q;
    const w = (2 * Math.PI * Math.min(Math.max(f, 20), SR * 0.45)) / SR;
    const c = Math.cos(w);
    const a = Math.sin(w) / (2 * q);
    const a0 = 1 + a;
    let b0, b1, b2;
    if (this.kind === 'low') [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
    else if (this.kind === 'high') [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    else [b0, b1, b2] = [a, 0, -a];
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - a) / a0;
  }

  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

const phases = random(97);
/** A band-limited saw (polyBLEP), with a repeatable random start phase. */
function saw(f) {
  let phase = (phases() + 1) / 2;
  const dt = f / SR;
  const blep = (t) => {
    if (t < dt) {
      t /= dt;
      return t + t - t * t - 1;
    }
    if (t > 1 - dt) {
      t = (t - 1) / dt;
      return t * t + t + t + 1;
    }
    return 0;
  };
  return () => {
    const v = 2 * phase - 1 - blep(phase);
    phase += dt;
    if (phase >= 1) phase -= 1;
    return v;
  };
}

const note = (midi) => 440 * 2 ** ((midi - 69) / 12);

class Mix {
  constructor(seconds) {
    this.L = new Float32Array(Math.ceil(seconds * SR));
    this.R = new Float32Array(this.L.length);
  }

  add(sound, t, gain = 1, pan = 0) {
    const start = Math.round(t * SR);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    for (let i = 0; i < sound.length; i++) {
      const j = start + i;
      if (j < 0 || j >= this.L.length) continue;
      this.L[j] += sound[i] * gl;
      this.R[j] += sound[i] * gr;
    }
  }

  addStereo(left, right, t, gain = 1) {
    const start = Math.round(t * SR);
    for (let i = 0; i < left.length; i++) {
      const j = start + i;
      if (j < 0 || j >= this.L.length) continue;
      this.L[j] += left[i] * gain;
      this.R[j] += right[i] * gain;
    }
  }
}

function make(seconds, f) {
  const n = Math.ceil(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i, i / SR);
  return out;
}

// ── instruments ──
function kick(power = 1) {
  const g = random(11);
  let phase = 0;
  return make(0.36, (i, t) => {
    phase += (2 * Math.PI * (50 + 120 * Math.exp(-t * 32))) / SR;
    const body = Math.sin(phase) * Math.exp(-t * 10.5);
    const click = t < 0.004 ? g() * (1 - t / 0.004) * 0.5 : 0;
    return Math.tanh((body + click) * 1.6 * power) * 0.9;
  });
}

function clap(seed = 3) {
  const g = random(seed);
  const bp = new Filter('band', 1250, 0.9);
  const hp = new Filter('high', 500);
  return make(0.32, (i, t) => {
    const burst = [0, 0.011, 0.022].some((d) => t >= d && t < d + 0.008) ? 1 : 0;
    const env = burst ? 1 : t > 0.022 ? Math.exp(-(t - 0.022) * 16) * 0.8 : 0;
    return hp.run(bp.run(g() * env)) * 2.2;
  });
}

function snare(power = 1, seed = 5) {
  const g = random(seed);
  const bp = new Filter('band', 1900, 0.7);
  let phase = 0;
  return make(0.18, (i, t) => {
    phase += (2 * Math.PI * 190) / SR;
    return (bp.run(g()) * 1.6 + Math.sin(phase) * 0.35) * Math.exp(-t * 26) * power;
  });
}

function hat(seconds, cutoff, seed) {
  const g = random(seed);
  const hp = new Filter('high', cutoff);
  const hp2 = new Filter('high', cutoff);
  return make(seconds, (i, t) => hp2.run(hp.run(g())) * Math.exp(-t * (4.5 / seconds)));
}

function crash(seed) {
  const g = random(seed);
  const hp = new Filter('high', 3800);
  return make(1.6, (i, t) => hp.run(g()) * Math.exp(-t * 2.2) * (t < 0.01 ? t / 0.01 : 1));
}

/** An impact: a falling sub and a burst of noise. */
function impact(seed = 21) {
  const g = random(seed);
  const lp = new Filter('low', 900);
  let phase = 0;
  return make(1.4, (i, t) => {
    phase += (2 * Math.PI * (30 + 60 * Math.exp(-t * 6))) / SR;
    return Math.tanh(Math.sin(phase) * Math.exp(-t * 2.4) * 1.8) * 0.9 + lp.run(g()) * Math.exp(-t * 9) * 0.5;
  });
}

/** A chord stab, one channel: every note two slightly detuned saws (the left below, the right above: width). */
function chord(notes, seconds, brightness = 2600, left = true) {
  const detune = left ? [-8, 0] : [0, 8];
  const voices = notes.flatMap((m) => detune.map((c) => saw(note(m) * 2 ** (c / 1200))));
  const lp = new Filter('low', brightness, 0.8);
  return make(seconds, (i, t) => {
    let s = 0;
    for (const o of voices) s += o();
    return lp.run(s / voices.length) * Math.min(1, t / 0.006) * Math.exp(-t * (1.2 / seconds) * 3.2);
  });
}

function bassNote(f, seconds) {
  const osc = saw(f);
  const lp = new Filter('low', 420, 1.1);
  let phase = 0;
  return make(seconds, (i, t) => {
    phase += (2 * Math.PI * (f / 2)) / SR;
    const env = Math.min(1, t / 0.004) * (t > seconds - 0.02 ? (seconds - t) / 0.02 : 1);
    lp.set(250 + 900 * Math.exp(-t * 18));
    return (lp.run(osc()) * 0.8 + Math.sin(phase) * 0.38) * env;
  });
}

function bell(midi) {
  const f = note(midi);
  return make(0.9, (i, t) => (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 6)) * Math.exp(-t * 4.2) * Math.min(1, t / 0.002));
}

function pluck(midi, seconds = 0.14) {
  const osc = saw(note(midi));
  const lp = new Filter('low', 3200);
  return make(seconds, (i, t) => lp.run(osc()) * Math.exp(-t * 22) * Math.min(1, t / 0.002));
}

/** A riser: noise through a band pass going up. */
function riser(seconds, f0, f1, seed = 31) {
  const g = random(seed);
  const bp = new Filter('band', f0, 1.4);
  return make(seconds, (i, t) => {
    const x = t / seconds;
    if (i % 32 === 0) bp.set(f0 * (f1 / f0) ** x);
    return bp.run(g()) * x ** 1.6 * 2.2;
  });
}

/** A whoosh, loudest in its middle (the cut). */
function whoosh(seconds = 0.36, seed = 41) {
  const g = random(seed);
  const bp = new Filter('band', 400, 1.1);
  return make(seconds, (i, t) => {
    const x = t / seconds;
    if (i % 32 === 0) bp.set(350 * (4200 / 350) ** Math.sin((x * Math.PI) / 2));
    return bp.run(g()) * Math.sin(Math.PI * x) ** 2 * 2.4;
  });
}

function reverseCymbal(seconds) {
  const z = hat(seconds, 4200, 77);
  return Float32Array.from(z, (v, i) => z[z.length - 1 - i]);
}

function reverb(input, size = 1) {
  const out = new Float32Array(input.length);
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(Math.round(d * size)), i: 0 }));
  const passes = [225, 556].map((d) => ({ buf: new Float32Array(d), i: 0 }));
  for (let n = 0; n < input.length; n++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.buf[c.i] = input[n] + y * 0.8;
      c.i = (c.i + 1) % c.buf.length;
      s += y;
    }
    s /= 4;
    for (const a of passes) {
      const y = a.buf[a.i];
      a.buf[a.i] = s + y * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      s = y - s * 0.5;
    }
    out[n] = s;
  }
  return out;
}

const CHORDS = {
  Am: { notes: [57, 60, 64, 69], root: 45, arp: [69, 72, 76, 81] },
  F: { notes: [53, 57, 60, 65], root: 41, arp: [65, 69, 72, 77] },
  C: { notes: [55, 60, 64, 67], root: 48, arp: [67, 72, 76, 79] },
  G: { notes: [55, 59, 62, 67], root: 43, arp: [67, 71, 74, 79] },
};
const PROGRESSION = ['Am', 'F', 'C', 'G'];
const chordAt = (t) => PROGRESSION[Math.floor(t / BAR + 1e-6) % 4];

/**
 * plan: { duration, sections: [{ t0, t1, kind: 'intro'|'a'|'b'|'build'|'break' }], cuts: [t] (whoosh), drops: [t]
 * (crash and impact), end: t (the last hit, the end card), duck: [[t0, t1]] (narration: the music goes down) }
 * Times are seconds of the video; t = 0 is a bar line. base: { L, R } (Float32Array, SR) a track already on the grid;
 * the sections are not drawn then, only the whooshes, the drops and the last hit over it.
 */
export function makeMusic(file, plan, { base = null } = {}) {
  const D = plan.duration + 0.5;
  const dry = new Mix(D);
  const wet = new Mix(D);
  if (base) dry.addStereo(base.L, base.R, 0, 2 * (base.gain ?? 1));
  const k1 = kick(1);
  const kSoft = kick(0.7);
  const cl = clap();
  const hClosed = hat(0.05, 7500, 7);
  const hOpen = hat(0.3, 6500, 9);

  const drums = (t0, t1, { open = false, claps = true, kicks = true } = {}) => {
    for (let t = Math.ceil(t0 / SIXTEENTH - 1e-6) * SIXTEENTH; t < t1 - 1e-6; t += SIXTEENTH) {
      const k = Math.round(t / SIXTEENTH) % 16;
      if (kicks && k % 4 === 0) dry.add(k1, t, 0.95);
      if (claps && (k === 4 || k === 12)) {
        dry.add(cl, t, 0.42, 0.05);
        wet.add(cl, t, 0.25);
      }
      if (k % 4 === 2) dry.add(open ? hOpen : hClosed, t, open ? 0.13 : 0.2, 0.25);
      else if (k % 2 === 1) dry.add(hClosed, t, 0.07, -0.25);
    }
  };
  const bass = (t0, t1) => {
    for (let t = Math.ceil((t0 - BEAT / 2) / BEAT - 1e-6) * BEAT + BEAT / 2; t < t1 - 1e-6; t += BEAT) {
      if (t < t0 - 1e-6) continue;
      dry.add(bassNote(note(CHORDS[chordAt(t)].root), BEAT * 0.42), t, 0.34);
    }
  };
  const stabs = (t0, t1, pattern = [0, 6, 10], gain = 0.2) => {
    for (let b = Math.floor(t0 / BAR) * BAR; b < t1 - 1e-6; b += BAR) {
      for (const k of pattern) {
        const t = b + k * SIXTEENTH;
        if (t < t0 - 1e-6 || t >= t1) continue;
        const { notes } = CHORDS[chordAt(t)];
        const len = k === 0 ? 0.42 : 0.26;
        const l = chord(notes, len, 2400, true);
        const r = chord(notes, len, 2400, false);
        dry.addStereo(l, r, t, gain);
        wet.addStereo(l, r, t, gain * 0.8);
      }
    }
  };
  const arpeggio = (t0, t1, gain = 0.055) => {
    for (let t = Math.ceil(t0 / SIXTEENTH - 1e-6) * SIXTEENTH; t < t1 - 1e-6; t += SIXTEENTH) {
      const n = Math.round(t / SIXTEENTH);
      const s = pluck(CHORDS[chordAt(t)].arp[n % 4] + (n % 8 >= 4 ? 12 : 0));
      dry.add(s, t, gain, n % 2 ? 0.45 : -0.45);
      wet.add(s, t, gain * 0.8);
    }
  };
  const pad = (t0, t1, gain, open = [300, 2600]) => {
    // one pad per bar, its filter opening over the whole stretch
    for (let b = Math.floor(t0 / BAR) * BAR; b < t1 - 1e-6; b += BAR) {
      const s0 = Math.max(b, t0);
      const s1 = Math.min(b + BAR, t1);
      const { notes } = CHORDS[chordAt(s0)];
      const voices = notes.flatMap((m) => [-9, 9].map((c) => saw(note(m) * 2 ** (c / 1200))));
      const lp = new Filter('low', open[0], 0.9);
      const len = s1 - s0;
      const s = make(len + 0.05, (i, t) => {
        if (i % 64 === 0) lp.set(open[0] * (open[1] / open[0]) ** ((s0 - t0 + t) / (t1 - t0)));
        let x = 0;
        for (const o of voices) x += o();
        return lp.run(x / voices.length) * Math.min(1, t / 0.04) * Math.min(1, Math.max(0, (len + 0.05 - t) / 0.06));
      });
      dry.add(s, s0, gain);
      wet.add(s, s0, gain * 0.9);
    }
  };
  const roll = (t0, t1, gain = 0.3) => {
    const span = t1 - t0;
    for (let t = t0; t < t1 - 1e-6; t += t < t0 + span / 2 ? BEAT / 2 : SIXTEENTH) dry.add(snare(0.35 + 0.65 * ((t - t0) / span)), t, gain, 0.1);
  };

  for (const s of base ? [] : plan.sections) {
    const { t0, t1 } = s;
    if (s.kind === 'intro') {
      // the logo: an impact, a pad opening, plucks, then a roll and a riser into the first scene
      dry.add(impact(), t0, 0.8);
      dry.add(crash(13), t0, 0.22);
      wet.add(crash(13), t0, 0.12);
      pad(t0, t1, 0.15, [260, 2400]);
      arpeggio(t0 + BAR / 2, t1, 0.03);
      for (let t = t0 + BAR; t < t1 - 1e-6; t += BEAT) dry.add(kSoft, t, 0.75);
      roll(t1 - BAR / 2, t1, 0.28);
      dry.add(riser(BAR, 500, 7000), t1 - BAR, 0.15);
      dry.add(reverseCymbal(0.6), t1 - 0.6, 0.25);
    } else if (s.kind === 'a') {
      // the chat: a light groove under a lot of narration
      drums(t0, t1, { claps: true });
      bass(t0, t1);
      stabs(t0, t1, [0], 0.16);
      arpeggio(t0, t1, 0.03);
    } else if (s.kind === 'b') {
      // the montage: the full groove
      drums(t0, t1, { open: true });
      bass(t0, t1);
      stabs(t0, t1, [0, 6, 10], 0.2);
      arpeggio(t0, t1, 0.055);
    } else if (s.kind === 'build') {
      // into a drop: kicks on every beat, a roll and a riser
      drums(t0, t1, { claps: false });
      bass(t0, t1);
      pad(t0, t1, 0.12, [500, 3600]);
      roll(Math.max(t0, t1 - BAR), t1, 0.3);
      dry.add(riser(t1 - t0, 400, 9000, 33), t0, 0.18);
      dry.add(reverseCymbal(0.5), t1 - 0.5, 0.28);
    } else if (s.kind === 'break') {
      // the phone: no kick, a pad and the plucks
      drums(t0, t1, { kicks: false, claps: false });
      pad(t0, t1, 0.14, [400, 2800]);
      arpeggio(t0, t1, 0.05);
      bass(t0, t1);
    }
  }
  for (const t of plan.cuts ?? []) dry.add(whoosh(0.36, 41 + Math.round(t * 7)), t - 0.18, 0.14);
  for (const t of plan.drops ?? []) {
    dry.add(crash(15), t, 0.26);
    wet.add(crash(15), t, 0.14);
    dry.add(impact(23), t, 0.45);
  }
  if (plan.end !== undefined) {
    // the last hit on the end card, a long chord and its tail
    const t = plan.end;
    dry.add(whoosh(0.4, 43), t - 0.2, 0.18);
    dry.add(kick(1.2), t, 1);
    dry.add(impact(), t, 0.65);
    dry.add(crash(17), t, 0.3);
    wet.add(crash(17), t, 0.2);
    const l = chord(CHORDS.Am.notes, 2.4, 2800, true);
    const r = chord(CHORDS.Am.notes, 2.4, 2800, false);
    dry.addStereo(l, r, t, 0.26);
    wet.addStereo(l, r, t, 0.24);
    [81, 84, 88].forEach((m, i) => {
      const b = bell(m);
      dry.add(b, t + 0.25 + i * 0.25, 0.12, (i - 1) * 0.4);
      wet.add(b, t + 0.25 + i * 0.25, 0.1);
    });
  }

  // ducking under the narration: -9 dB, quick down, slower up
  const n = Math.round(plan.duration * SR);
  const gain = new Float32Array(n).fill(1);
  const low = 10 ** (-9 / 20);
  const target = new Float32Array(n).fill(1);
  for (const [a, b] of plan.duck ?? []) for (let i = Math.max(0, Math.round((a - 0.08) * SR)); i < Math.min(n, Math.round((b + 0.05) * SR)); i++) target[i] = low;
  let g = 1;
  const down = 1 - Math.exp(-1 / (0.06 * SR));
  const up = 1 - Math.exp(-1 / (0.35 * SR));
  for (let i = 0; i < n; i++) {
    g += (target[i] - g) * (target[i] < g ? down : up);
    gain[i] = g;
  }

  const rL = reverb(wet.L, 1);
  const rR = reverb(wet.R, 1.07);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const hl = new Filter('high', 30);
  const hr = new Filter('high', 30);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const fade = t > plan.duration - 0.8 ? Math.max(0, (plan.duration - t) / 0.8) : 1;
    const l = hl.run((dry.L[i] + rL[i] * 0.55) * 0.5) * gain[i];
    const r = hr.run((dry.R[i] + rR[i] * 0.55) * 0.5) * gain[i];
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    L[i] = Math.tanh(l) * fade;
    R[i] = Math.tanh(r) * fade;
  }
  writeWav(file, L, R);
  return { peak };
}

/**
 * The tempo and the first bar line of a track (mono samples at `rate`): an onset envelope (rises of the energy in
 * 10 ms hops), its autocorrelation over 90–160 BPM, then the beat phase with the most onsets on it and, of the four
 * beats, the one with the most low-end energy as the bar line (the kick). Returns { bpm, bar } (bar: seconds of the
 * first bar line, under one bar).
 */
export function beatGrid(samples, rate, { around = null } = {}) {
  const hop = Math.round(rate / 100);
  // envelope frames per second: not exactly 100 (11025 / 110; measured 10.10.2026: every tempo read 0.23% slow)
  const fps = rate / hop;
  const frames = Math.floor(samples.length / hop);
  const energy = new Float32Array(frames);
  const low = new Float32Array(frames);
  // a 150 Hz low pass at the track's rate (the filter counts in SR)
  const kickFilter = new Filter('low', (150 * SR) / rate);
  for (let i = 0; i < frames; i++) {
    let e = 0;
    let b = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) {
      e += samples[j] * samples[j];
      const y = kickFilter.run(samples[j]);
      b += y * y;
    }
    energy[i] = Math.log1p(e * 1000);
    low[i] = b;
  }
  const onset = new Float32Array(frames);
  for (let i = 1; i < frames; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
  const mean = onset.reduce((t, x) => t + x, 0) / Math.max(1, frames);
  for (let i = 0; i < frames; i++) onset[i] -= mean;
  // tempo: the lag (in 0.1 BPM steps, the envelope read between hops) where the envelope repeats best
  const at = (x, t) => { const i = Math.floor(t); const f = t - i; return i + 1 < x.length ? x[i] * (1 - f) + x[i + 1] * f : 0; };
  // around: the tempo the track was asked for (the music model keeps near it): searched within 12% of it
  const [lo, hi] = around ? [around * 0.88, around * 1.12] : [90, 160];
  let best = { bpm: around ?? BPM, score: -Infinity };
  for (let bpm = lo; bpm <= hi; bpm += 0.1) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (let i = 0; i + lag * 2 < frames; i++) s += onset[i] * (at(onset, i + lag) + 0.5 * at(onset, i + lag * 2));
    if (s > best.score) best = { bpm, score: s };
  }
  // then finer: the tempo and phase whose beats over the whole track land on the most onsets (a 1% error is 0.75 s
  // off after a minute; measured 10.10.2026: 110 BPM read as 111.1 by the lag alone)
  const comb = (beat) => {
    let most = -Infinity;
    let phase = 0;
    for (let p = 0; p < beat; p += 0.5) {
      let s = 0;
      for (let t = p; t < frames - 1; t += beat) s += at(onset, t);
      if (s > most) [most, phase] = [s, p];
    }
    return { most, phase };
  };
  let fine = { bpm: best.bpm, ...comb((60 / best.bpm) * fps) };
  for (let bpm = best.bpm - 1.5; bpm <= best.bpm + 1.5; bpm += 0.02) {
    const c = comb((60 / bpm) * fps);
    if (c.most > fine.most) fine = { bpm, ...c };
  }
  best = { bpm: fine.bpm };
  const beat = (60 / best.bpm) * fps;
  const phase = fine.phase;
  // the bar line: chords change on it (the pitch classes of a beat against the beat before), the kick is on it too;
  // the kick alone cannot tell beat 1 from beat 3 (measured 10.10.2026: the bar line came a half bar late)
  const change = chordChanges(samples, rate, phase / fps, beat / fps);
  const lowAt = (k) => {
    let s = 0;
    let n = 0;
    for (let t = phase + k * beat; t < frames - 1; t += beat * 4, n++) s += at(low, t);
    return n ? s / n : 0;
  };
  const lows = [0, 1, 2, 3].map(lowAt);
  const lowMost = Math.max(...lows) || 1;
  let bar = phase;
  let strongest = -Infinity;
  for (let k = 0; k < 4; k++) {
    const c = change.filter((_, i) => i % 4 === k);
    const s = (c.length ? c.reduce((t, x) => t + x, 0) / c.length : 0) + 0.25 * (lows[k] / lowMost);
    if (s > strongest) [strongest, bar] = [s, phase + k * beat];
  }
  return { bpm: Math.round(best.bpm * 100) / 100, bar: bar / fps };
}

/**
 * How much the harmony changes on every beat (from `start`, every `beat` seconds): the 12 pitch classes of a beat
 * (Goertzel over three octaves, 65-520 Hz, on a copy thinned to ~2.7 kHz) against those of the beat before, 0-1.
 */
function chordChanges(samples, rate, start, beat) {
  const step = Math.max(1, Math.floor(rate / 2700));
  const r = rate / step;
  const thin = new Float32Array(Math.floor(samples.length / step));
  for (let i = 0; i < thin.length; i++) {
    let s = 0;
    for (let j = 0; j < step; j++) s += samples[i * step + j];
    thin[i] = s / step;
  }
  const coefficients = Array.from({ length: 36 }, (_, n) => 2 * Math.cos((2 * Math.PI * 65.41 * 2 ** (n / 12)) / r));
  const out = [];
  let before = null;
  for (let t = start; (t + beat) * r < thin.length; t += beat) {
    const a = Math.round(t * r);
    const b = Math.round((t + beat) * r);
    const chroma = new Float64Array(12);
    coefficients.forEach((c, n) => {
      let s1 = 0;
      let s2 = 0;
      for (let i = a; i < b; i++) {
        const s0 = thin[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      chroma[n % 12] += s1 * s1 + s2 * s2 - c * s1 * s2;
    });
    const size = Math.hypot(...chroma) || 1;
    for (let i = 0; i < 12; i++) chroma[i] /= size;
    out.push(before ? 1 - chroma.reduce((s, x, i) => s + x * before[i], 0) : 0);
    before = chroma;
  }
  return out;
}

function writeWav(path, L, R) {
  const n = L.length;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 4, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  writeFileSync(path, b);
}
