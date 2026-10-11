/**
 * Replace a person (Wan 2.2 Animate): the windows over the video, the size it is made at, the plan step that needs a
 * photo, and a video with a photo in Edit video handed over and made window by window (fake ComfyUI, real ffmpeg and
 * the real comfy.mjs graph).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan } from '../lib/edit-plan.mjs';
import { streams } from '../lib/ffmpeg.mjs';
import { makePng } from '../lib/media.mjs';
import { replaceWindows, replaceSize, REPLACE } from '../lib/jobs/replace.mjs';
import { usedFiles, CATALOG, FOLDERS } from '../lib/models.mjs';
import { replaceJob } from '../../tools/comfy.mjs';
import { createPanel } from './env.mjs';

test('replace windows: 77 frames, each later one starts 5 frames back, every length 4n + 1, the video covered', () => {
  assert.deepEqual(replaceWindows(40), [{ no: 1, start: 0, length: 41 }]);
  assert.deepEqual(replaceWindows(77), [{ no: 1, start: 0, length: 77 }]);
  assert.deepEqual(replaceWindows(96), [{ no: 1, start: 0, length: 77 }, { no: 2, start: 72, length: 25 }]);
  for (const total of [1, 5, 78, 150, 400, 960]) {
    const w = replaceWindows(total);
    let made = 0;
    for (const [i, x] of w.entries()) {
      assert.equal((x.length - 1) % 4, 0, `${total}: length 4n + 1`);
      assert.ok(x.length <= REPLACE.window);
      if (i) assert.equal(x.start, made - REPLACE.motion, `${total}: continues from the last 5 frames`);
      made = x.start + x.length;
    }
    assert.ok(made >= total, `${total}: covered`);
  }
});

test('replace size: the video\'s own shape at ~400k pixels, sides a multiple of 16', () => {
  assert.deepEqual(replaceSize(1280, 720), { width: 848, height: 480 });
  assert.deepEqual(replaceSize(1080, 1920), { width: 480, height: 848 });
  assert.deepEqual(replaceSize(1000, 1000), { width: 624, height: 624 });
});

test('plan: replacePerson only with a photo, and it goes alone', () => {
  const video = { duration: 10, hasMusic: false, summary: {} };
  const answer = JSON.stringify({ steps: [{ operation: 'blackWhite' }, { operation: 'replacePerson', prompt: ' an old fisherman smiling ' }] });
  const p = parsePlan('video', answer, { ...video, hasPhoto: true });
  assert.deepEqual(p.steps, [{ operation: 'replacePerson', prompt: 'an old fisherman smiling' }]);
  assert.match(p.impossible, /blackWhite/);
  assert.deepEqual(parsePlan('video', answer, video).steps, [{ operation: 'blackWhite' }], 'no photo: no replacing');
});

test('replace graph: Wan Animate with the prep node, the photo and the motion frames; the model files are known', () => {
  const g = replaceJob({ clip: 'c.mp4', picture: 'p.png', motions: ['m1.png', 'm2.png', 'm3.png', 'm4.png', 'm5.png'], text: 'a man', seed: 7, width: 848, height: 480, frame: 25, prefix: 'x' });
  const by = (t) => Object.values(g).filter((d) => d.class_type === t);
  const animate = by('WanAnimateToVideo')[0].inputs;
  assert.equal(animate.length, 25);
  assert.deepEqual([animate.pose_video, animate.face_video, animate.background_video, animate.character_mask].map((x) => x[1]), [0, 1, 2, 3]);
  assert.ok(animate.continue_motion, 'a later window continues from the motion frames');
  assert.equal(by('LoadImage').length, 6);
  assert.deepEqual(by('ImageFromBatch')[0].inputs.batch_index, 5, 'the 5 motion frames are dropped');
  assert.equal(by('ImageFromBatch')[0].inputs.length, 20);
  assert.equal(by('NedeseReplacePrep').length, 1);
  assert.equal(replaceJob({ clip: 'c.mp4', picture: 'p.png', text: 'a', seed: 1, prefix: 'x' })[24], undefined, 'the first window keeps every frame');
  const used = usedFiles({ replaceJob });
  for (const f of ['diffusion_models/Wan2.2-Animate-14B-Q4_K_M.gguf', 'clip_vision/clip_vision_h.safetensors', 'loras/WanAnimate_relight_lora_fp16_resized_from_128_to_dynamic_22.safetensors', 'pose/yolox_l.torchscript.pt', 'pose/dw-ll_ucoco_384_bs5.torchscript.pt', 'background_removal/birefnet.safetensors']) {
    assert.ok(used[f]?.includes('replaceJob'), `${f} is used by replaceJob`);
    const [folder, file] = f.split('/');
    assert.ok(CATALOG.some((k) => k.folder === folder && k.file === file), `${f} can be downloaded`);
    assert.ok(FOLDERS[folder], `${folder} is a model folder`);
  }
});

test('a video and a photo with "put the person in the photo in place of the man" in Edit video: the job becomes Replace a person, made in windows with the sound kept', async () => {
  const instructions = [];
  const p = await createPanel();
  p.setting.editPlan = async ({ instruction, info }) => {
    instructions.push([instruction, info.hasPhoto, info.summary.photoGiven]);
    return { steps: [{ operation: 'replacePerson', prompt: 'an old fisherman talking' }], description: 'replace', impossible: '' };
  };
  try {
    const trial = join(p.setting.outputRoot, 'trial');
    mkdirSync(trial, { recursive: true });
    // 6 s at 25 fps with sound -> 96 frames at 16 fps: two windows (77, then 25 from frame 72)
    execFileSync(p.setting.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(trial, 'man.mp4')]);
    writeFileSync(join(trial, 'fisherman.png'), makePng(40, 60, [200, 60, 40]));
    for (const f of Object.keys(usedFiles(p.mod)).filter((k) => usedFiles(p.mod)[k].includes('replaceJob'))) {
      mkdirSync(join(p.setting.modelRoot, f.split('/')[0]), { recursive: true });
      writeFileSync(join(p.setting.modelRoot, ...f.split('/')), 'x');
    }
    const job = p.queue.add('videoEdit', { source: 'job/trial/man.mp4', picture: 'job/trial/fisherman.png', instruction: 'fotoğraftaki kişiyi adamın yerine koy' });
    assert.equal(job.summary.detail, 'Video editing by instruction · with a photo');
    const done = await p.waitUntilDone(job.id, 120000);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.deepEqual(instructions, [['fotoğraftaki kişiyi adamın yerine koy', true, true]]);
    assert.equal(done.type, 'replace');
    assert.equal(done.handedFrom, 'videoEdit');
    assert.deepEqual([done.input.source, done.input.picture, done.input.prompt], ['job/trial/man.mp4', 'job/trial/fisherman.png', 'an old fisherman talking']);
    const prompts = p.fake.status.records.filter((r) => r.path === '/prompt').map((r) => JSON.parse(r.prompt).prompt);
    assert.equal(prompts.length, 2, 'two windows');
    const animate = (g) => Object.values(g).find((d) => d.class_type === 'WanAnimateToVideo').inputs;
    assert.deepEqual(prompts.map((g) => [animate(g).length, animate(g).width, animate(g).height, Boolean(animate(g).continue_motion)]), [[77, 848, 480, false], [25, 848, 480, true]]);
    assert.equal(Object.values(prompts[1]).filter((d) => d.class_type === 'LoadImage').length, 6, 'the photo and the 5 motion frames');
    const main = done.outputs.find((o) => o.main);
    assert.equal(main.file, 'replaced.mp4');
    const s = await streams(p.setting.ffprobe, join(p.queue.folder(job.id), 'replaced.mp4'));
    assert.ok(s.streams.some((x) => x.codec_type === 'audio'), 'the video keeps its sound');
    const frames = execFileSync(p.setting.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', join(p.queue.folder(job.id), 'replaced.mp4')], { encoding: 'utf8' });
    assert.equal(Number(frames.trim()), 96, 'every frame of the video once');
  } finally {
    await p.close();
  }
});
