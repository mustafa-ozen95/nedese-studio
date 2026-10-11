/**
 * Edit by description: a plan that is another job type's work (beatCut, sing, restyle) hands the job over; the queue
 * runs it as that type in the same folder. Real ffmpeg and real queue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '../lib/settings.mjs';
import { parsePlan } from '../lib/edit-plan.mjs';
import { Queue } from '../lib/queue.mjs';
import * as videoEdit from '../lib/jobs/video-edit.mjs';
import * as audioEdit from '../lib/jobs/audio-edit.mjs';
import * as beatEdit from '../lib/jobs/beat-edit.mjs';
import * as sing from '../lib/jobs/sing.mjs';

const finished = async (queue, id) => {
  for (let i = 0; i < 2400; i++) {
    const job = queue.jobs.get(id);
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error('job did not finish');
};

test('plan: another job type\'s work goes alone; several videos can only be cut to the beat; restyle / sing only when installed', () => {
  const video = { duration: 10, hasMusic: false, summary: {} };
  const p = parsePlan('video', JSON.stringify({ steps: [{ operation: 'blackWhite' }, { operation: 'beatCut', pace: 'fast', size: '9:16', length: 15 }] }), video);
  assert.deepEqual(p.steps, [{ operation: 'beatCut', pace: 'fast', size: '9:16', length: 15 }]);
  assert.match(p.impossible, /blackWhite/, 'the dropped step is told');
  assert.deepEqual(parsePlan('video', JSON.stringify({ steps: [{ operation: 'text', text: 'x' }] }), { ...video, sourceCount: 3 }).steps, [{ operation: 'beatCut', pace: 'medium', size: 'source', length: 0 }]);
  const voice = { duration: 60, voices: [{ id: 'ada', name: 'Ada' }], summary: {} };
  const plan = (step, b) => parsePlan('voice', JSON.stringify({ steps: [step] }), { ...voice, ...b });
  assert.throws(() => plan({ operation: 'restyle', style: 'lo-fi' }, {}), /No applicable edit/, 'no song editing installed');
  assert.deepEqual(plan({ operation: 'restyle', style: ' lo-fi ', strength: 'x' }, { canRestyle: true }).steps, [{ operation: 'restyle', style: 'lo-fi', strength: 'medium' }]);
  assert.throws(() => plan({ operation: 'sing', voice: 'ada' }, {}), /No applicable edit/, 'no singing installed');
  assert.deepEqual(plan({ operation: 'sing', voice: 'ada', octave: -12 }, { canSing: true }).steps, [{ operation: 'sing', voice: 'ada', octave: -12 }]);
  assert.equal(plan({ operation: 'sing', voice: 'ada' }, { canSing: true }).steps[0].octave, null, 'no octave: automatic');
  assert.throws(() => plan({ operation: 'sing', voice: 'nobody' }, { canSing: true }), /No applicable edit/);
});

test('two videos with "cut them to the beat" in Edit video: the job becomes a Beat cut and makes the montage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'handover-'));
  const base = loadSettings({ aiRoot: root });
  const trial = join(base.outputRoot, 'trial');
  mkdirSync(trial, { recursive: true });
  for (const [name, src] of [['a.mp4', 'testsrc2'], ['b.mp4', 'rgbtestsrc']]) {
    execFileSync(base.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${src}=s=320x240:r=30:d=4`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(trial, name)]);
  }
  const instructions = [];
  const setting = {
    ...base,
    gpuWatchdog: null,
    ramWatchdog: null,
    editPlan: async ({ instruction, info }) => {
      instructions.push([instruction, info.sourceCount]);
      return { steps: [{ operation: 'beatCut', pace: 'fast', size: '9:16', length: 4 }], description: 'beat cut', impossible: '' };
    },
  };
  const queue = new Queue({ setting, comfy: null, mod: null, runners: { videoEdit, beatEdit } });
  queue.start();
  try {
    const job = queue.add('videoEdit', { sources: ['job/trial/a.mp4', 'job/trial/b.mp4'], instruction: 'bunları müzikle ritme kes' });
    assert.equal(job.summary.detail, 'Video editing by instruction · 2 videos');
    const done = await finished(queue, job.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.deepEqual(instructions, [['bunları müzikle ritme kes', 2]]);
    assert.equal(done.type, 'beatEdit');
    assert.equal(done.handedFrom, 'videoEdit');
    assert.deepEqual(done.input.sources, ['job/trial/a.mp4', 'job/trial/b.mp4']);
    assert.equal(done.input.size, '9:16');
    assert.equal(done.input.music, 'made');
    const main = done.outputs.find((o) => o.main);
    assert.ok(main && existsSync(join(queue.folder(job.id), main.file)), 'the montage is in the job folder');
    assert.equal(main.width / main.height, 9 / 16);
    assert.match(readFileSync(join(queue.folder(job.id), 'log.txt'), 'utf8'), /Handed over: Edit video → Beat cut/);
  } finally {
    await queue.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a song with "sing it in Ada\'s voice" in Edit audio: the job becomes Sing in a voice with the voice and octave of the plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'handover-'));
  const base = loadSettings({ aiRoot: root });
  const trial = join(base.outputRoot, 'trial');
  mkdirSync(trial, { recursive: true });
  mkdirSync(base.voiceLibrary, { recursive: true });
  execFileSync(base.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=3', join(trial, 'song.mp3')]);
  execFileSync(base.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=3', '-ar', '24000', join(base.voiceLibrary, 'ada.wav')]);
  writeFileSync(join(base.voiceLibrary, 'ada.json'), JSON.stringify({ name: 'Ada' }));
  const sung = [];
  const setting = {
    ...base,
    hasSing: true,
    gpuWatchdog: null,
    ramWatchdog: null,
    editPlan: async ({ info }) => {
      assert.equal(info.canSing, true, 'the planner is told singing is possible');
      assert.deepEqual(info.voices, [{ id: 'ada', name: 'Ada' }]);
      return { steps: [{ operation: 'sing', voice: 'ada', octave: 12 }], description: 'sing', impossible: '' };
    },
  };
  // the real check of Sing in a voice; the singing model itself is not run here
  const singing = { ...sing, run: async (ctx) => sung.push(ctx.job.input) };
  const queue = new Queue({ setting, comfy: null, mod: null, runners: { audioEdit, sing: singing } });
  queue.start();
  try {
    const job = queue.add('audioEdit', { source: 'job/trial/song.mp3', instruction: "bu şarkıyı Ada'nın sesiyle söylet" });
    const done = await finished(queue, job.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.type, 'sing');
    assert.deepEqual(sung, [{ source: 'job/trial/song.mp3', voice: 'ref:ada', voiceName: 'Ada', title: "bu şarkıyı Ada'nın sesiyle söylet", shift: 12, backing: true }]);
    assert.equal(done.summary.title, "bu şarkıyı Ada'nın sesiyle söylet");
  } finally {
    await queue.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// 11.10.2026: since the English conversion (08.10) both edit jobs declared "const plan" under the imported plan(), so
// with the real planner (no setting.editPlan, the tests' stand-in) every audio and video edit stopped with "Cannot
// access 'plan' before initialization". Here the real planner runs: without a text model it says so.
test('the edit jobs reach the real planner (no stand-in): without a text model the job says the interpreter is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'handover-'));
  const base = loadSettings({ aiRoot: root });
  const trial = join(base.outputRoot, 'trial');
  mkdirSync(trial, { recursive: true });
  execFileSync(base.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(trial, 'a.mp4')]);
  execFileSync(base.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2', join(trial, 'a.mp3')]);
  // the stand-in only lets the jobs in (validate asks for a text model); it is gone before they run
  const setting = { ...base, gpuWatchdog: null, ramWatchdog: null, editPlan: async () => assert.fail('the stand-in must not run') };
  const queue = new Queue({ setting, comfy: null, mod: null, runners: { audioEdit, videoEdit } });
  const jobs = [queue.add('videoEdit', { source: 'job/trial/a.mp4', instruction: 'make it black and white' }), queue.add('audioEdit', { source: 'job/trial/a.mp3', instruction: 'cut the first second' })];
  delete setting.editPlan;
  queue.start();
  try {
    for (const job of jobs) {
      const done = await finished(queue, job.id);
      assert.equal(done.status, 'error');
      assert.match(done.error, /instruction interpreter \(text model\) is not on this machine/, `${job.type}: ${done.error}`);
    }
  } finally {
    await queue.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
