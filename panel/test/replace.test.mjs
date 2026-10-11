/**
 * Replace a person (Wan 2.2 Animate): the windows over the video, the size it is made at, the plan step that needs a
 * photo, and a video with photos in Edit video handed over and made window by window, one pass per person (fake
 * ComfyUI, real ffmpeg and the real comfy.mjs graph).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan } from '../lib/edit-plan.mjs';
import { streams } from '../lib/ffmpeg.mjs';
import { makePng } from '../lib/media.mjs';
import { replaceWindows, replaceSize, nextTarget, REPLACE, DEFAULT_PROMPT } from '../lib/jobs/replace.mjs';
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

test('plan: replacePerson only with a photo, one prompt per photo, and it goes alone', () => {
  const video = { duration: 10, hasMusic: false, summary: {} };
  const answer = JSON.stringify({ steps: [{ operation: 'blackWhite' }, { operation: 'replacePerson', prompts: [' an old fisherman smiling '] }] });
  const p = parsePlan('video', answer, { ...video, hasPhoto: true, photoCount: 1 });
  assert.deepEqual(p.steps, [{ operation: 'replacePerson', prompts: ['an old fisherman smiling'], area: 'person' }]);
  const face = parsePlan('video', JSON.stringify({ steps: [{ operation: 'replacePerson', prompts: ['an old man with a grey beard'], area: 'face' }] }), { ...video, hasPhoto: true, photoCount: 1 });
  assert.equal(face.steps[0].area, 'face', 'only the face');
  assert.equal(parsePlan('video', JSON.stringify({ steps: [{ operation: 'replacePerson', prompts: ['a'], area: 'hands' }] }), { ...video, hasPhoto: true, photoCount: 1 }).steps[0].area, 'person');
  assert.match(p.impossible, /blackWhite/);
  assert.deepEqual(parsePlan('video', answer, video).steps, [{ operation: 'blackWhite' }], 'no photo: no replacing');
  const two = parsePlan('video', JSON.stringify({ steps: [{ operation: 'replacePerson', prompts: ['a girl', 'a man', 'a third'] }] }), { ...video, hasPhoto: true, photoCount: 2 });
  assert.deepEqual(two.steps[0].prompts, ['a girl', 'a man'], 'one per photo');
  const short = parsePlan('video', JSON.stringify({ steps: [{ operation: 'replacePerson', prompt: 'a girl' }] }), { ...video, hasPhoto: true, photoCount: 2 });
  assert.deepEqual(short.steps[0].prompts, ['a girl', ''], 'a missing one is left to the default');
});

test("next window follows the person: the prep node's box at the frame the next window starts", () => {
  const graph = replaceJob({ clip: 'c.mp4', picture: 'p.png', target: { order: 2 }, text: 'a', seed: 1, prefix: 'x' });
  const prep = Object.entries(graph).find(([, d]) => d.class_type === 'NedeseReplacePrep');
  assert.deepEqual(JSON.parse(prep[1].inputs.target), { order: 2 });
  const boxes = Array.from({ length: 77 }, (_, i) => [i / 100, 0, 1, 1]);
  const outputs = { [prep[0]]: { boxes: [JSON.stringify(boxes)], look: ['[0.5,0.5]'], place: ['[2,2]'] } };
  const [w1, w2] = replaceWindows(96);
  assert.deepEqual(nextTarget(outputs, graph, w1, w2), { box: [0.72, 0, 1, 1], look: [0.5, 0.5], place: [2, 2] });
  assert.deepEqual(nextTarget(outputs, graph, w2, undefined), { box: null, look: null, place: null }, 'the last window');
  assert.deepEqual(nextTarget({}, graph, w1, w2), { box: null, look: null, place: null }, 'nothing from an older node');
  // the person left the shot before the next window starts: the last box where they were seen
  const gone = boxes.map((b, i) => (i >= 60 ? null : b));
  assert.deepEqual(nextTarget({ [prep[0]]: { boxes: [JSON.stringify(gone)] } }, graph, w1, w2), { box: [0.59, 0, 1, 1], look: null, place: null });
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

test('a video and two photos in Edit video: the job becomes Replace a person, one pass per person from the left, in windows that follow the person, the sound kept', async () => {
  const instructions = [];
  const p = await createPanel();
  p.setting.editPlan = async ({ instruction, info, image }) => {
    instructions.push([instruction, info.hasPhoto, info.photoCount, info.summary.photosGiven, String(image).startsWith('data:image/jpeg;base64,/9j/')]);
    return { steps: [{ operation: 'replacePerson', prompts: ['a little girl in a yellow dress talking', ''] }], description: 'replace', impossible: '' };
  };
  try {
    const trial = join(p.setting.outputRoot, 'trial');
    mkdirSync(trial, { recursive: true });
    // 6 s at 25 fps with sound -> 96 frames at 16 fps: two windows (77, then 25 from frame 72)
    execFileSync(p.setting.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(trial, 'man.mp4')]);
    writeFileSync(join(trial, 'fisherman.png'), makePng(40, 60, [200, 60, 40]));
    writeFileSync(join(trial, 'girl.png'), makePng(30, 70, [240, 220, 40]));
    for (const f of Object.keys(usedFiles(p.mod)).filter((k) => usedFiles(p.mod)[k].includes('replaceJob'))) {
      mkdirSync(join(p.setting.modelRoot, f.split('/')[0]), { recursive: true });
      writeFileSync(join(p.setting.modelRoot, ...f.split('/')), 'x');
    }
    const job = p.queue.add('videoEdit', { source: 'job/trial/man.mp4', pictures: ['job/trial/girl.png', 'job/trial/fisherman.png'], instruction: 'fotoğraftaki kişileri onların yerine koy' });
    assert.equal(job.summary.detail, 'Video editing by instruction · with 2 photos');
    const done = await p.waitUntilDone(job.id, 120000);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.deepEqual(instructions, [['fotoğraftaki kişileri onların yerine koy', true, 2, 2, true]], 'the planner sees the photos (one JPEG side by side) to describe those people');
    assert.equal(done.type, 'replace');
    assert.equal(done.handedFrom, 'videoEdit');
    assert.equal(done.summary.detail, 'Wan 2.2 Animate · 2 people from the photos');
    assert.deepEqual([done.input.source, done.input.people], ['job/trial/man.mp4', [{ picture: 'job/trial/girl.png', prompt: 'a little girl in a yellow dress talking' }, { picture: 'job/trial/fisherman.png', prompt: DEFAULT_PROMPT }]]);
    const prompts = p.fake.status.records.filter((r) => r.path === '/prompt').map((r) => JSON.parse(r.prompt).prompt);
    assert.equal(prompts.length, 4, 'two people, two windows each');
    const of = (g, t) => Object.values(g).find((d) => d.class_type === t).inputs;
    const animate = (g) => of(g, 'WanAnimateToVideo');
    assert.deepEqual(prompts.map((g) => [animate(g).length, animate(g).width, animate(g).height, Boolean(animate(g).continue_motion)]), [[77, 848, 480, false], [25, 848, 480, true], [77, 848, 480, false], [25, 848, 480, true]]);
    // window 1 picks the person from the left, window 2 follows them from the box at frame 72 (fake: x = 72 / 1000)
    // and by their look and place (each pass its own person's)
    assert.deepEqual(prompts.map((g) => JSON.parse(of(g, 'NedeseReplacePrep').target)), [{ order: 1 }, { box: [0.072, 0.2, 0.372, 0.9], look: [1], place: [1, 2] }, { order: 2 }, { box: [0.072, 0.2, 0.372, 0.9], look: [2], place: [2, 2] }]);
    assert.deepEqual(prompts.map((g) => of(g, 'CLIPTextEncode').text), ['a little girl in a yellow dress talking', 'a little girl in a yellow dress talking', DEFAULT_PROMPT, DEFAULT_PROMPT]);
    assert.equal(Object.values(prompts[1]).filter((d) => d.class_type === 'LoadImage').length, 6, 'the photo and the 5 motion frames');
    const photo = (g) => Object.values(g).filter((d) => d.class_type === 'LoadImage').map((d) => d.inputs.image.match(/person\d/)?.[0]).find(Boolean);
    assert.deepEqual(prompts.map(photo), ['person1', 'person1', 'person2', 'person2'], 'each pass its own photo');
    const main = done.outputs.find((o) => o.main);
    assert.equal(main.file, 'replaced.mp4');
    const s = await streams(p.setting.ffprobe, join(p.queue.folder(job.id), 'replaced.mp4'));
    assert.ok(s.streams.some((x) => x.codec_type === 'audio'), 'the video keeps its sound');
    const frames = execFileSync(p.setting.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', join(p.queue.folder(job.id), 'replaced.mp4')], { encoding: 'utf8' });
    assert.equal(Number(frames.trim()), 96, 'every frame of the video once');
    assert.deepEqual([done.input.area, ...prompts.map((g) => of(g, 'NedeseReplacePrep').area)], ['person', 'person', 'person', 'person', 'person']);

    // only the face: the planner says so ("sadece yüzünü"), the prep node gets area face
    p.setting.editPlan = async () => ({ steps: [{ operation: 'replacePerson', prompts: ['an old man with a grey beard'], area: 'face' }], description: 'face', impossible: '' });
    const faceJob = p.queue.add('videoEdit', { source: 'job/trial/man.mp4', pictures: ['job/trial/fisherman.png'], instruction: 'sadece yüzünü fotoğraftaki adamın yüzüyle değiştir' });
    const faceDone = await p.waitUntilDone(faceJob.id, 120000);
    assert.equal(faceDone.status, 'done', faceDone.error ?? '');
    assert.deepEqual([faceDone.input.area, faceDone.summary.detail], ['face', 'Wan 2.2 Animate · the face from the photo']);
    const later = p.fake.status.records.filter((r) => r.path === '/prompt').map((r) => JSON.parse(r.prompt).prompt).slice(4);
    assert.deepEqual(later.map((g) => of(g, 'NedeseReplacePrep').area), ['face', 'face']);
    assert.throws(() => p.queue.add('replace', { source: 'job/trial/man.mp4', people: [{ picture: 'job/trial/girl.png' }], area: 'hands' }), /Area: one of person, face/);
  } finally {
    await p.close();
  }
});
