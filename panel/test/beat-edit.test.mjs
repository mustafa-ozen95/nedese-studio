/**
 * Beat cut (Edit › Beat cut, 10.10.2026): the cut on the grid, the shots shared over the videos and placed where they
 * move without running over a cut of their own, and a real run with ffmpeg (drawn music and a music file measured).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '../lib/settings.mjs';
import { streams } from '../lib/ffmpeg.mjs';
import { cutPlan, musicPlan, share, pickShots, outputSize, musicStart } from '../lib/beat-edit-plan.mjs';
import { validate, summary, run, parseMotion } from '../lib/jobs/beat-edit.mjs';
import { finishSound } from '../lib/jobs/promo.mjs';
import { makeMusic, BAR } from '../lib/promo-music.mjs';

test('beat cut plan: whole bars, longer shots in the intro, half as long after a drop, the last shot a bar', () => {
  const c = cutPlan({ length: 30, beat: 0.5, pace: 'medium' });
  assert.equal(c.bars, 15);
  assert.equal(c.total, 30);
  assert.deepEqual(c.drops, [8, 20]);
  assert.deepEqual(c.sections.map((s) => s.kind), ['intro', 'a', 'b', 'build', 'b', 'break']);
  const len = (kind) => [...new Set(c.shots.filter((s) => s.kind === kind).map((s) => s.t1 - s.t0))];
  assert.deepEqual([len('intro'), len('a'), len('b'), len('build'), len('final')], [[2], [1], [0.5], [0.25], [2]]);
  assert.ok(c.shots.every((s, i) => i === 0 || Math.abs(s.t0 - c.shots[i - 1].t1) < 1e-9), 'no gap between shots');
  assert.ok(c.shots.every((s) => Math.abs(s.t0 / 0.25 - Math.round(s.t0 / 0.25)) < 1e-6), 'every cut on a half beat');
  assert.deepEqual(c.shots.filter((s) => s.flash).map((s) => s.t0), [4, 8, 20], 'a flash after the intro and on the drops');
  assert.ok(c.shots.at(-1).last && c.shots.at(-1).punch);
  // the music decides: no more bars than it has; a short cut still has three bars
  assert.equal(cutPlan({ length: 30, most: 13, beat: 0.5 }).bars, 6);
  assert.equal(cutPlan({ length: 2, beat: 0.5 }).bars, 3);
  assert.deepEqual(cutPlan({ length: 30, beat: 0.5, pace: 'fast' }).shots.filter((s) => s.kind === 'b').map((s) => s.t1 - s.t0)[0], 0.25, 'fast: never shorter than half a beat');
  const m = musicPlan(c);
  assert.deepEqual([m.duration, m.drops, m.end], [30, [4, 8, 20], 28]);
});

test('shots over the videos: shared by length, in order, the liveliest window without a cut of the source', () => {
  assert.deepEqual(share(10, [10, 30]), [3, 7]);
  assert.deepEqual(share(2, [5, 5, 5]), [1, 1, 0]);
  assert.equal(share(7, [1, 1, 1]).reduce((a, b) => a + b), 7);
  // one source of 20 s: still until 10 s, moving from 10 s, more after a cut of its own at 12 s
  const motion = Array.from({ length: 160 }, (_, i) => ({ t: i / 8, v: i / 8 >= 12 ? 0.3 : i / 8 >= 10 ? 0.2 : 0.001 }));
  const shots = [{ t0: 0, t1: 1 }, { t0: 1, t1: 2 }];
  const [a, b] = pickShots(shots, [{ duration: 20, motion, cuts: [12] }]);
  assert.equal(a.start, 9, 'the first half of the video: its end, nearest the motion');
  assert.equal(b.start, 12.04, 'the second half: the most motion, just after the cut at 12 s, not over it');
  // a source shorter than its shots is slowed, at most to half speed
  assert.equal(pickShots([{ t0: 0, t1: 4 }], [{ duration: 1, motion: [], cuts: [] }])[0].speed, 0.5);
  assert.deepEqual(outputSize('source', { width: 3840, height: 2160 }), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize('source', { width: 1080, height: 1350 }), { width: 1080, height: 1350 });
  assert.deepEqual(outputSize('9:16', {}), { width: 1080, height: 1920 });
  assert.equal(musicStart([0.01, 0.02, 0.3, 0.4, 0.35], 0.4, 2), 4.4, 'a quiet intro of two bars skipped');
  const p = parseMotion('frame:0 pts:0 pts_time:0\nlavfi.scene_score=0.000\nframe:1 pts:1 pts_time:0.125\nlavfi.scene_score=0.02\nframe:2 pts:2 pts_time:0.25\nlavfi.scene_score=0.61\n');
  assert.deepEqual(p, { motion: [{ t: 0, v: 0 }, { t: 0.125, v: 0.02 }, { t: 0.25, v: 0.61 }], cuts: [0.25] });
});

test('beat cut job: two videos and drawn music, then a music file measured; length in whole bars, the shape of the first video', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bc-root-'));
  const setting = loadSettings({ aiRoot: root });
  try {
    const trial = join(setting.outputRoot, 'trial');
    mkdirSync(trial, { recursive: true });
    const ff = (...a) => execFileSync(setting.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
    ff('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', join(trial, 'a.mp4'));
    ff('-f', 'lavfi', '-i', 'mandelbrot=s=320x240:r=30', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', join(trial, 'b.mp4'));
    assert.throws(() => validate({ sources: [] }, { setting }), /Pick at least one video/);
    assert.throws(() => validate({ sources: ['job/trial/a.mp4'], music: 'file' }, { setting }), /Pick the music/);
    const g = validate({ sources: ['job/trial/a.mp4', 'job/trial/b.mp4'], length: '8', pace: 'fast' }, { setting });
    assert.deepEqual([g.music, g.size, g.pace, g.length], ['made', 'source', 'fast', 8]);
    assert.equal(summary(g).detail, '2 videos · source size · beat music · fast');
    const outputs = [];
    const logs = [];
    const ctx = (input, id) => {
      const folder = join(setting.outputRoot, id);
      mkdirSync(folder, { recursive: true });
      return { job: { id, input }, setting, folder, signal: new AbortController().signal, progress: () => {}, log: (m) => logs.push(m), save: () => {}, addOutput: (c) => outputs.push(c) };
    };
    await run(ctx(g, 'made'));
    const s = await streams(setting.ffprobe, join(setting.outputRoot, 'made', 'beat-cut.mp4'));
    assert.ok(Math.abs(s.duration - 4 * BAR) < 0.1, `four bars: 8 s (${s.duration})`);
    const v = s.streams.find((x) => x.codec_type === 'video');
    assert.deepEqual([v.width, v.height, outputs[0].width], [320, 240, 320]);
    assert.ok(s.streams.some((x) => x.codec_type === 'audio'));

    // the drawn music as a file of the user's: its tempo is found again, the cut on it
    makeMusic(join(trial, 'm.wav'), { duration: 24, sections: [{ t0: 0, t1: 24, kind: 'b' }], cuts: [], drops: [], end: 22, duck: [] });
    await run(ctx(validate({ sources: ['job/trial/b.mp4'], music: 'file', musicFile: 'job/trial/m.wav', size: '1:1', length: 6 }, { setting }), 'file'));
    assert.match(logs.find((m) => m.startsWith('Music:')), /Music: 1(19\.[5-9]\d*|20(\.[0-4]\d*)?) BPM/);
    const f = await streams(setting.ffprobe, join(setting.outputRoot, 'file', 'beat-cut.mp4'));
    assert.ok(Math.abs(f.duration - 3 * BAR) < 0.1, `6 s is three bars (${f.duration})`);
    assert.equal(outputs[1].width, 1080);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finished sound: a minute of drawn music with drops at −14 LUFS stays under full scale after AAC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-peak-'));
  const setting = loadSettings({ aiRoot: dir });
  try {
    // the music of a real promo (10.10.2026): 192k AAC took it over full scale
    const kinds = [[0, 4, 'intro'], [4, 18, 'a'], [18, 32, 'b'], [32, 36, 'build'], [36, 48, 'b'], [48, 60, 'break']];
    const duck = [[4.1, 7.62], [10.1, 13.3], [14.1, 16.18], [18.1, 20.82], [22.1, 25.62], [26.1, 29.46], [30.1, 32.82], [36.1, 40.1], [41.1, 44.46], [48.1, 51.78], [56.1, 59.62]];
    makeMusic(join(dir, 'm.wav'), { duration: 64, sections: kinds.map(([t0, t1, kind]) => ({ t0, t1, kind })), cuts: [10, 14, 18, 22, 26, 30, 36, 41, 47.75, 52, 53, 56], drops: [4, 18, 36], end: 60, duck });
    execFileSync(setting.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=10:d=64', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'p.mp4')]);
    await finishSound(setting.ffmpeg, join(dir, 'p.mp4'), join(dir, 'm.wav'), join(dir, 'o.mp4'), '64', { cwd: dir });
    const meter = spawnSync(setting.ffmpeg, ['-hide_banner', '-nostats', '-i', join(dir, 'o.mp4'), '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const summary = meter.slice(meter.lastIndexOf('Summary'));
    const [loud, peak] = [/I:\s*(-?[\d.]+) LUFS/, /Peak:\s*(-?[\d.]+) dBFS/].map((r) => Number(r.exec(summary)?.[1]));
    assert.ok(Math.abs(loud + 14) < 0.6, `−14 LUFS (${loud})`);
    assert.ok(peak < 0, `true peak under 0 dBFS (${peak}); 192k AAC went to +3 dB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
