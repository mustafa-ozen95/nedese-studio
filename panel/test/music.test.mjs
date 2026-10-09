/**
 * Filme gore muzik: bolumleme, plan cozumu, bolumlerin yumusak gecisle birlesmesi.
 *   node --test panel/test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpeg, mergeMusic } from '../lib/ffmpeg.mjs';
import { UserError } from '../lib/errors.mjs';
import { musicSections, parseMusicPlan, musicStyles } from '../lib/music-plan.mjs';

test('music sections at scene boundaries, at most as many as boundaries', () => {
  // 6 sahne x 100 sn, sınır 240: [0,1] [2,3] [4,5]
  const durations = [100, 100, 100, 100, 100, 100];
  const starts = durations.map((_, i) => i * 100);
  const b = musicSections(starts, durations, 600, 240);
  assert.deepEqual(b.map((x) => x.scenes), [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(b.map((x) => x.duration), [200, 200, 200]);
  // Sınırdan uzun tek sahne kendi bölümü
  const long = musicSections([0, 30], [30, 500], 530, 240);
  assert.deepEqual(long.map((x) => x.scenes), [[0], [1]]);
  // Kısa film tek bölüm
  assert.equal(musicSections([0], [5], 5).length, 1);
});

test('music plan response: missing sections are filled with the general style, a broken response is an error', () => {
  const p = parseMusicPlan('Plan:\n{"general":"calm piano","sections":["tense strings"]}', 3);
  assert.equal(p.general, 'calm piano');
  assert.deepEqual(p.sections, ['tense strings', 'calm piano', 'calm piano']);
  assert.throws(() => parseMusicPlan('none', 2), UserError);
});

test("without a text model the music style is the user's style or the default", async () => {
  const b = [{ duration: 10, narrations: ['x'] }, { duration: 10, narrations: ['y'] }];
  assert.deepEqual((await musicStyles({ style: 'lofi', sections: b })).sections, ['lofi', 'lofi']);
  const v = await musicStyles({ style: '', sections: b });
  assert.match(v.general, /cinematic/);
});

test('music sections are joined with crossfades (duration = total - crossfades)', async (t) => {
  const ffmpeg = findFfmpeg('C:/Users/root/ai');
  if (!ffmpeg) return t.skip('no ffmpeg');
  const k = mkdtempSync(join(tmpdir(), 'muzik-'));
  try {
    for (const [name, hz] of [['a.mp3', 300], ['b.mp3', 500], ['c.mp3', 700]]) execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=f=${hz}:d=10`, join(k, name)]);
    await mergeMusic(ffmpeg, { cwd: k, parts: ['a.mp3', 'b.mp3', 'c.mp3'], transition: 3, output: 'music.mp3' });
    const duration = Number(execFileSync(ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(k, 'music.mp3')]).toString());
    assert.ok(Math.abs(duration - 24) < 0.3, `duration ${duration}`);
  } finally {
    rmSync(k, { recursive: true, force: true });
  }
});
