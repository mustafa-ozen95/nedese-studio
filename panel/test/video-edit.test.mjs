/**
 * Video duzenle: art arda suzgec adimlari tek ffmpeg gecisinde; kes/ses/muzik ayri. Gercek ffmpeg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '../lib/settings.mjs';
import { streams } from '../lib/ffmpeg.mjs';
import { parsePlan } from '../lib/edit-plan.mjs';
import { run, groupPasses, reverseMemory, chainArgs } from '../lib/jobs/video-edit.mjs';

test('splitting into passes: filter steps merge, cut / audio / music stay separate', () => {
  const step = (operation, extra = {}) => ({ operation, ...extra });
  const g = groupPasses([step('speed', { ratio: 2 }), step('blackWhite'), step('cut', { start: 0, end: 1 }), step('text'), step('color'), step('music'), step('reverse')]);
  assert.deepEqual(g.map((x) => [x.chain, x.steps.map((a) => a.operation).join('+')]), [
    [true, 'speed+blackWhite'],
    [false, 'cut'],
    [true, 'text+color'],
    [false, 'music'],
    [true, 'reverse'],
  ]);
});

test('chain: speed + black and white + fade in a single pass; fade based on the sped-up duration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vd-root-'));
  const setting = loadSettings({ aiRoot: root });
  const dir = mkdtempSync(join(tmpdir(), 'vd-'));
  try {
    execFileSync(setting.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', join(dir, 'input.mp4')]);
    const b = { duration: 4, width: 320, height: 240, fps: 30, voice: true };
    const steps = [{ operation: 'speed', ratio: 2 }, { operation: 'blackWhite' }, { operation: 'fade', in: 0.5, out: 0.5 }];
    const arg = chainArgs(steps, b, { input: join(dir, 'input.mp4'), output: join(dir, 'cikis.mp4'), k: dir });
    const vf = arg[arg.indexOf('-vf') + 1];
    assert.match(vf, /setpts=PTS\/2,hue=s=0,fade=t=in:d=0\.5,fade=t=out:st=1\.50:d=0\.5/, 'fade out 4/2 - 0.5 = 1.5 s');
    assert.match(arg[arg.indexOf('-af') + 1], /^atempo=2\.0000,afade=t=in:d=0\.5,afade=t=out:st=1\.50:d=0\.5$/);
    assert.equal(arg.filter((x) => x === '-i').length, 1, 'single input, single pass');
    execFileSync(setting.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...arg]);
    const s = await streams(setting.ffprobe, join(dir, 'cikis.mp4'));
    assert.ok(Math.abs(s.duration - 2) < 0.15, `duration ≈ 2 s (${s.duration})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('reverse playback memory: previous scale / rotate / fps taken into account, speed does not change the frame count', () => {
  const b = { duration: 45, width: 3840, height: 2160, fps: 30, pix: 'yuv420p' };
  const reverse = { operation: 'reverse' };
  // 4K30, 45 sn telefon videosu: 1350 kare x 12,4 MB ~ 15,6 GB
  assert.equal(reverseMemory([reverse], b), 3840 * 2160 * 1.5 * 1350);
  assert.equal(reverseMemory([reverse], { ...b, pix: 'yuv420p10le' }), 3840 * 2160 * 3 * 1350, '10 bit (HDR) is double');
  assert.equal(reverseMemory([{ operation: 'scale', height: 720 }, reverse], b), 1280 * 720 * 1.5 * 1350);
  assert.equal(reverseMemory([{ operation: 'rotate', degree: 90 }, { operation: 'scale', height: 1280 }, reverse], b), 720 * 1280 * 1.5 * 1350, 'after rotating, scale applies to the new height');
  assert.equal(reverseMemory([{ operation: 'speed', ratio: 2 }, reverse], b), reverseMemory([reverse], b), 'speed does not drop frames');
  assert.equal(reverseMemory([{ operation: 'speed', ratio: 2 }, { operation: 'fps', value: 24 }, reverse], b), 3840 * 2160 * 1.5 * 24 * 22.5);
  assert.equal(reverseMemory([reverse, { operation: 'scale', height: 360 }], b), reverseMemory([reverse], b), 'steps after reverse have no effect');
  assert.equal(reverseMemory([{ operation: 'blackWhite' }], b), 0);
});

test('plan: steps after cut and speed are validated against the new duration (cut + reverse on a long video)', () => {
  const info = { duration: 300, hasMusic: false, summary: {} };
  const plan = (steps) => parsePlan('video', JSON.stringify({ steps }), info);
  assert.throws(() => plan([{ operation: 'reverse' }]), /No applicable edit/, 'a 5-minute video is not reversed without cutting');
  const p = plan([{ operation: 'cut', start: 10, end: 20 }, { operation: 'reverse' }, { operation: 'text', text: 'x', start: 0, end: 50 }]);
  assert.deepEqual(p.steps.map((a) => a.operation), ['cut', 'reverse', 'text']);
  assert.equal(p.steps[2].end, 10, 'text end limited to the cut 10 s');
  assert.deepEqual(plan([{ operation: 'speed', ratio: 4 }, { operation: 'reverse' }]).steps.map((a) => a.operation), ['speed'], '75 s at 4x speed: still over 60 s');
  assert.deepEqual(parsePlan('video', JSON.stringify({ steps: [{ operation: 'speed', ratio: 4 }, { operation: 'reverse' }] }), { ...info, duration: 200 }).steps.map((a) => a.operation), ['speed', 'reverse'], '200 s at 4x speed = 50 s');
});

test('reverse playback job: clear error before ffmpeg starts when memory is insufficient; reversed video when it suffices', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vd-root-'));
  const setting = loadSettings({ aiRoot: root });
  try {
    mkdirSync(join(setting.outputRoot, 'trial'), { recursive: true });
    execFileSync(setting.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', join(setting.outputRoot, 'trial', 'input.mp4')]);
    const outputs = [];
    const ctx = (free) => {
      const folder = join(setting.outputRoot, `job-${free}`);
      mkdirSync(folder, { recursive: true });
      return {
        job: { input: { source: 'job/trial/input.mp4', instruction: 'tersten oynat', music: null } },
        setting: { ...setting, editPlan: async () => ({ steps: [{ operation: 'reverse' }], description: 'reverse', impossible: '' }), freeMemory: () => free },
        folder,
        signal: new AbortController().signal,
        progress: () => {},
        log: () => {},
        save: () => {},
        addOutput: (c) => outputs.push(c),
      };
    };
    // 2 GB sisteme pay: bos 2 GB iken 320x240 bile sigmaz
    await assert.rejects(run(ctx(2 * 2 ** 30)), /Reverse playback loads every frame into memory: this video needs ~0\.0 GB, free memory is 2\.0 GB/);
    assert.equal(existsSync(join(setting.outputRoot, `job-${2 * 2 ** 30}`, 'pass_01.writing.mp4')), false, 'ffmpeg never started');
    await run(ctx(3 * 2 ** 30));
    assert.equal(outputs.length, 1);
    assert.ok(Math.abs(outputs[0].duration - 3) < 0.15, `duration ≈ 3 s (${outputs[0].duration})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
