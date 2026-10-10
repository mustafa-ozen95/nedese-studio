/**
 * Sing in a voice (lib/jobs/sing.mjs + the fake voice\sing.py): a song sung again in a library voice. The panel passes
 * the song as a 44.1 kHz WAV and the voice's library WAV, mixes the converted vocal with the backing vocals and
 * instrumental, and a retry does not separate the song again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeWav } from '../lib/media.mjs';
import { createPanel } from './env.mjs';

const SONG = 'upload/20261010-130000-song.wav';

async function panel(t, singEnv) {
  const p = await createPanel({ singEnv });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return null;
  }
  mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
  writeFileSync(join(p.setting.outputRoot, 'uploads', '20261010-130000-song.wav'), makeWav(3));
  mkdirSync(p.setting.voiceLibrary, { recursive: true });
  writeFileSync(join(p.setting.voiceLibrary, 'my-voice-1a2b.wav'), makeWav(5));
  writeFileSync(join(p.setting.voiceLibrary, 'my-voice-1a2b.json'), JSON.stringify({ name: 'My voice', ownVoice: true }));
  return p;
}
const temp = (name) => join(tmpdir(), `sing-${process.pid}-${Date.now()}-${name}`);
const calls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((x) => JSON.parse(x)) : []);

test('sing: the song is sung in the library voice and mixed back; the backing vocals too by default', async (t) => {
  const log = temp('1');
  const p = await panel(t, { FAKE_SING_LOG: log });
  if (!p) return;
  try {
    const job = await p.waitUntilDone(p.queue.add('sing', { source: SONG, voice: 'ref:my-voice-1a2b' }).id);
    assert.equal(job.status, 'done', job.error);
    const [call] = calls(log);
    assert.equal(call.reference, join(p.setting.voiceLibrary, 'my-voice-1a2b.wav'));
    assert.ok(call.song.endsWith('song.wav') && call.backing && call.shift === null, JSON.stringify(call));
    const folder = join(p.setting.outputRoot, job.id);
    assert.deepEqual(job.outputs.map((x) => x.file), ['song.mp3', 'vocal.mp3']);
    assert.ok(existsSync(join(folder, 'song.mp3')) && existsSync(join(folder, 'vocal.mp3')));
    const lines = p.queue.logs.get(job.id).join('\n');
    assert.match(lines, /Octave: moved 12 semitones/);
    assert.equal(p.queue.jobs.get(job.id).summary.title, 'Sung by My voice');
  } finally {
    await p.close();
  }
});

test('sing: an octave down and lead vocal only are passed; a retry after a failure does not separate again', async (t) => {
  const log = temp('2');
  const p = await panel(t, { FAKE_SING_LOG: log, FAKE_SING_FAIL_ONCE: temp('2-once') });
  if (!p) return;
  try {
    const job = await p.waitUntilDone(p.queue.add('sing', { source: SONG, voice: 'ref:my-voice-1a2b', shift: -12, backing: false }).id);
    assert.equal(job.status, 'error');
    p.queue.tryAgain(job.id);
    const again = await p.waitUntilDone(job.id);
    assert.equal(again.status, 'done', again.error);
    assert.deepEqual(calls(log).map((c) => [c.shift, c.backing, c.separated, c.failed ?? false]), [[-12, false, true, true], [-12, false, false, false]]);
  } finally {
    await p.close();
  }
});

test('sing: without a library voice, with a deleted voice or with a shift that is not an octave or without the models it is refused before the queue', async (t) => {
  const p = await panel(t, { FAKE_SING_LOG: '' });
  if (!p) return;
  try {
    assert.throws(() => p.queue.add('sing', { source: SONG }), /voice library/);
    assert.throws(() => p.queue.add('sing', { source: SONG, voice: 'model' }), /voice library/);
    assert.throws(() => p.queue.add('sing', { source: SONG, voice: 'ref:gone-0000' }), /not in the library/);
    assert.throws(() => p.queue.add('sing', { voice: 'ref:my-voice-1a2b' }), /Pick the song/);
    // only whole octaves: the instrumental stays in its key
    assert.throws(() => p.queue.add('sing', { source: SONG, voice: 'ref:my-voice-1a2b', shift: 5 }), /Octave/);
  } finally {
    await p.close();
  }
  const bare = await createPanel();
  try {
    assert.throws(() => bare.queue.add('sing', { source: SONG, voice: 'ref:x' }), /Settings > Models/);
  } finally {
    await bare.close();
  }
});

test('sing: a failing conversion fails the job with the script error in the log', async (t) => {
  const p = await panel(t, { FAKE_SING_ERROR: '1' });
  if (!p) return;
  try {
    const job = await p.waitUntilDone(p.queue.add('sing', { source: SONG, voice: 'ref:my-voice-1a2b' }).id);
    assert.equal(job.status, 'error');
    assert.match(p.queue.logs.get(job.id).join('\n'), /CUDA out of memory/);
  } finally {
    await p.close();
  }
});
