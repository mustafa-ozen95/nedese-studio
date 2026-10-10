/**
 * Promo video (user 10.10.2026: the panel makes its own promo, "kurgu için"): the script's validation and steps, the
 * script writer's answer, the beat grid of a track (the music model's, stretched onto 120 BPM) and the beat cut.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, promoSteps, PANEL_SECTIONS, samples } from '../lib/jobs/promo.mjs';
import { loadSettings } from '../lib/settings.mjs';
import { parsePromoResponse, promoSchema, usableSections } from '../lib/promo-writer.mjs';
import { makeMusic, beatGrid, BAR, BEAT, SR } from '../lib/promo-music.mjs';
import { beatCut, bigScenes, INTRO, OUTRO } from '../lib/beat-cut.mjs';
import { plan, cornerLayout } from '../lib/jobs/page-video-compose.mjs';
import { SIZES } from '../lib/jobs/page-video.mjs';
import { JOB_TYPES } from '../lib/api.mjs';

const setting = { port: 1071, ffmpeg: 'ffmpeg', outputRoot: 'C:\\nowhere', hasVoice: true };

test('promo: validation, the steps of a panel script per size', () => {
  assert.throws(() => validate({ scenes: [] }, { setting }), /at least one scene/);
  assert.throws(() => validate({ scenes: [{ section: 'kitchen', caption: 'x' }] }, { setting }), /Scene 1: the section is one of/);
  assert.throws(() => validate({ scenes: [{ section: 'chat' }] }, { setting }), /Scene 1 headline cannot be empty/);
  const g = validate({ voice: 'model', lang: 'en', scenes: [{ section: 'chat', caption: 'Ask', narration: 'Ask anything.' }, { section: 'image', caption: 'Draw', demo: 'A fox' }, { section: 'devices', caption: 'Anywhere', narration: 'On every device.' }] }, { setting });
  assert.deepEqual([g.panel, g.sizes, g.music, g.theme, g.title], [true, ['desktop', 'phone'], 'made', 'dark', 'Nedese Studio'], 'both sizes, beat music, the dark theme by default');
  assert.equal(validate({ voice: 'model', sizes: ['phone', 'tablet'], scenes: [{ section: 'chat', caption: 'x' }] }, { setting }).sizes.join(), 'phone');

  const desktop = promoSteps(g, 'desktop', [2.4, 0, 1.8]);
  assert.equal(desktop[0].url, 'http://127.0.0.1:1071/#chat', 'the first step opens the panel at its section');
  assert.ok(desktop.every((a) => a.caption && a.scene !== undefined), 'every step carries its headline and scene');
  assert.deepEqual(desktop.filter((a) => a.audioSeconds).map((a) => [a.scene, a.audioSeconds]), [[0, 2.4], [2, 1.8]], "the first step of a spoken scene lasts its narration");
  assert.equal(desktop.find((a) => a.do === 'type').text, 'A fox', "the scene's own words are typed");
  assert.ok(desktop.some((a) => a.do === 'device'), 'the desktop video shows a phone');
  const phone = promoSteps(g, 'phone', [2.4, 0, 1.8]);
  assert.ok(!phone.some((a) => a.do === 'device'), 'no device change in the phone video');
  assert.ok(phone.some((a) => a.target === '[data-chat-list-toggle]'), "the phone opens the chat list first");

  // another page: own steps are checked as a page video's, a scene without them scrolls on
  const site = validate({ url: 'example.com', voice: 'model', scenes: [{ caption: 'One' }, { caption: 'Two', steps: [{ do: 'click', target: '#buy' }] }, { caption: 'Three', target: 'Pricing' }] }, { setting });
  const s = promoSteps(site, 'desktop', [0, 0, 0]);
  assert.deepEqual(s.map((a) => a.do), ['open', 'wait', 'click', 'hover']);
  assert.equal(s[0].url, 'https://example.com/');
  assert.throws(() => validate({ url: 'example.com', scenes: [{ caption: 'x', steps: [{ do: 'jump' }] }] }, { setting }), /Scene 1: "do" is one of/);

  assert.equal(JOB_TYPES.promo.name, 'Promo video');
  assert.equal(validate(JOB_TYPES.promo.example, { setting }).scenes.length, 3, 'the guide\'s example is valid as it is');
});

test('promo script writer: only sections with something to show, known sections once, the demo only where it is typed', () => {
  assert.ok(!usableSections({}).includes('model3d') && !usableSections({}).includes('film'), 'no result of the kind: no section');
  assert.ok(usableSections({ model3d: 1 }).includes('model3d'));
  assert.ok(usableSections({}).includes('chat') && usableSections({}).includes('gallery'));
  const sections = usableSections({ image: 2 });
  assert.deepEqual(promoSchema(sections, 8).properties.scenes.items.properties.section.enum, sections);
  // the live writer (10.10.2026) wrote the words first and matched sections by list order: the section comes first
  assert.equal(Object.keys(promoSchema(sections, 8).properties.scenes.items.properties)[0], 'section');
  const r = parsePromoResponse(
    'Sure! {"subtitle":"Your own studio","scenes":[{"caption":"Ask **anything**","narration":"Ask.","section":"chat","demo":"no"},{"caption":"Again","narration":"x","section":"chat"},{"caption":"3D","narration":"y","section":"model3d"},{"caption":"Draw","narration":"z","section":"image","demo":"A fox"}]}',
    { panel: true, sections, count: 8 },
  );
  assert.deepEqual(r.scenes, [{ caption: 'Ask *anything*', narration: 'Ask.', section: 'chat' }, { caption: 'Draw', narration: 'z', section: 'image', demo: 'A fox' }]);
  assert.equal(r.subtitle, 'Your own studio');
  assert.throws(() => parsePromoResponse('{"scenes":[]}', { panel: false, sections: null, count: 5 }), /no usable scene/);
});

/** A 16-bit stereo WAV as mono floats. */
function readMono(file) {
  const b = readFileSync(file);
  const n = (b.length - 44) / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (b.readInt16LE(44 + i * 4) + b.readInt16LE(46 + i * 4)) / 65536;
  return out;
}

test('beat grid: the tempo and the first bar line of a track, also stretched and late', () => {
  const dir = mkdtempSync(join(tmpdir(), 'promo-'));
  try {
    const file = join(dir, 'm.wav');
    const duration = 12 * BAR;
    makeMusic(file, { duration, sections: [{ t0: 0, t1: 4 * BAR, kind: 'a' }, { t0: 4 * BAR, t1: duration, kind: 'b' }], cuts: [], drops: [], end: duration, duck: [] });
    const mono = readMono(file);
    const g = beatGrid(mono, SR);
    assert.ok(Math.abs(g.bpm - 120) < 0.3, `120 BPM measured as ${g.bpm}`);
    assert.ok(g.bar < 0.05 || g.bar > BAR - 0.05, `the bar line at 0 s, measured at ${g.bar}`);
    // the same track slower (112 BPM: every sample read 120/112 times) with 0.3 s of silence before it
    const speed = 112 / 120;
    const late = 0.3;
    const n = Math.floor(mono.length / speed);
    const slow = new Float32Array(Math.round(late * SR) + n);
    for (let i = 0; i < n; i++) slow[Math.round(late * SR) + i] = mono[Math.floor(i * speed)];
    const s = beatGrid(slow, SR);
    assert.ok(Math.abs(s.bpm - 112) < 0.5, `112 BPM measured as ${s.bpm}`);
    const slowBar = BAR / speed;
    const off = (((s.bar - late) % slowBar) + slowBar) % slowBar;
    assert.ok(off < 0.06 || off > slowBar - 0.06, `the bar line 0.3 s in, measured at ${s.bar}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('beat grid: a music model track whose pattern repeats best at 4/3 of its tempo is still read at its tempo', async () => {
  // 16 s of a 120 BPM track of the music model (10.10.2026): read as 159.8 BPM with nothing asked
  const mono = await samples(loadSettings({}).ffmpeg, fileURLToPath(new URL('./fixtures/model-120bpm.mp3', import.meta.url)), { rate: 11025, channels: 1 });
  const g = beatGrid(mono, 11025);
  assert.ok(Math.abs(g.bpm - 120) < 0.3, `120 BPM measured as ${g.bpm}`);
});

test('beat cut: scene cuts on the grid, the narration with its scene, the length in whole bars', () => {
  const marks = [
    { start: 0, do: 'open', caption: 'Ask', view: 'desktop', scene: 0 },
    { start: 1.5, do: 'click', caption: 'Ask', view: 'desktop', scene: 0, focus: { x: 0.3, y: 0.6, w: 0.2, h: 0.05 } },
    { start: 4, do: 'open', caption: 'Draw', view: 'desktop', ready: 4.4, scene: 1 },
    { start: 7, do: 'open', caption: 'Hear', view: 'desktop', ready: 7.4, scene: 2 },
    { start: 9, do: 'device', caption: 'Anywhere', view: 'phone', ready: 9.5, scene: 3 },
    { start: 10, do: 'open', caption: 'Anywhere', view: 'phone', ready: 10.4, scene: 3 },
    { start: 12, do: 'wait', caption: 'Keep', view: 'phone', scene: 4 },
  ];
  const end = 16;
  const times = Array.from({ length: end * 10 }, (_, i) => i / 10);
  const R = { width: 1920, height: 1080, end, host: '127.0.0.1:1071', views: SIZES, frames: { files: times.map((_, i) => `f${i}.jpg`), times }, ...plan({ marks, end, size: 'desktop' }) };
  const narration = [2.2, 1.6, 0, 2.8, 1.2];
  const cut = beatCut(R, narration, { panel: true, title: 'Studio' });
  const { T, music } = cut;
  assert.ok(Math.abs(T.duration - (INTRO + T.end + OUTRO)) < 1e-9);
  assert.ok(Math.abs(T.end / BAR - Math.round(T.end / BAR)) < 1e-6, `the cut ends on a bar line (${T.end} s)`);
  assert.deepEqual(T.transitions.map((x) => x.kind), ['whip', 'whip', 'device', 'whip'], 'a whip between sections, a device change to the phone');
  for (const b of cut.blocks.filter((x) => x.change || x.key !== undefined)) assert.ok(Math.abs(b.o0 * 2 - Math.round(b.o0 * 2)) < 1e-6, `a scene starts on the beat (${b.o0})`);
  // each spoken scene: its clip starts with its block and ends before the next scene's
  const starts = cut.blocks.filter((b) => b.key !== undefined).map((b) => INTRO + b.o0);
  assert.deepEqual(cut.narration.map((n) => n.scene), [0, 1, 3, 4]);
  for (const n of cut.narration) {
    const next = starts[n.scene + 1] ?? T.duration - OUTRO;
    assert.ok(n.t >= starts[n.scene] && n.t + n.length <= next, `scene ${n.scene}'s narration (${n.t}–${n.t + n.length}) fits before ${next}`);
  }
  assert.ok(music.duck.length === 4 && music.sections[0].kind === 'intro' && music.drops[0] === INTRO, 'the music: ducked four times, the drop after the intro');
  assert.ok(T.frames.times.every((t, i) => i === 0 || t >= T.frames.times[i - 1]), 'frames in time order');
  assert.ok(T.frames.times.at(-1) <= T.end, 'no frame after the cut');
  assert.equal(T.pair, 'corner');
  assert.deepEqual(bigScenes(10), { drops: [3, 7], rest: 8 }, 'drops a quarter and two thirds in, the rest before the last');
  assert.ok(Math.abs(BEAT - 0.5) < 1e-9);
});

test('corner layout: the window in the middle, the phone in front of its bottom right corner', () => {
  const win = { w: 1280, h: 800 };
  const phone = { w: 432, h: 900 };
  const L = cornerLayout(1920, 1080, 120, 120, win, phone);
  const ph = phone.h * L.phone.s;
  const pw = phone.w * L.phone.s;
  const ww = win.w * L.win.s;
  assert.ok(L.phone.cy + ph / 2 <= 1080 && L.phone.cx + pw / 2 <= 1920, 'the phone inside the video');
  assert.ok(L.phone.cx > L.win.cx && L.phone.cx - pw / 2 < L.win.cx + ww / 2, 'in front of the right part of the window');
  assert.ok(Math.abs(ph - 0.6 * 1080) < 2, 'the phone 60% of the height');
});
