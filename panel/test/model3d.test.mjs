/**
 * 3D model: sahte ComfyUI (TRELLIS.2 grafi gercek) + sahte Blender + GERCEK ffmpeg (tanitim videosu, videodan kare).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPanel } from './env.mjs';
import { streams } from '../lib/ffmpeg.mjs';
import { COMPLETE_PROMPT } from '../lib/jobs/model3d.mjs';

const promptList = (p) => p.fake.status.records.filter((x) => x.path === '/prompt').map((x) => Object.values(JSON.parse(x.prompt).prompt));

test('3D model: full-body completion + TRELLIS.2 + Blender (showcase video, FBX/OBJ/STL)', async (t) => {
  const p = await createPanel({ blender: true, server: true });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const previous = await p.waitUntilDone(p.queue.add('image', { prompt: 'old fisherman portrait', model: 'flux', ratio: '1:1' }).id);
    const source = `job/${previous.id}/${previous.outputs[0].file}`;
    assert.throws(() => p.queue.add('model3d', { source, printHeight: 5 }), /Print height/);
    const job = p.queue.add('model3d', { source, complete: true, title: 'Balıkçı', seed: 3, printHeight: 60 });
    assert.deepEqual(job.input.formats, ['fbx', 'obj', 'stl'], 'three formats by default when Blender is present');
    assert.equal(job.input.intro, true);
    assert.match(job.summary.detail, /full body.*print 60 mm/);
    const last = await p.waitUntilDone(job.id, 120000);
    assert.equal(last.status, 'done', last.error);

    const [, complete, trellis] = promptList(p);
    const prompt = complete.find((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && d.inputs.prompt)?.inputs.prompt;
    assert.equal(prompt, COMPLETE_PROMPT);
    assert.deepEqual(complete.filter((d) => d.class_type === 'EmptySD3LatentImage').map((d) => [d.inputs.width, d.inputs.height]), [[832, 1248]], 'vertical full-body frame');
    assert.ok(trellis.some((d) => d.class_type === 'Pixal3DConditioning'), 'high quality Pixal3D');
    assert.equal(trellis.find((d) => d.class_type === 'UNETLoader').inputs.unet_name, 'pixal3d_int8_convrot.safetensors');
    assert.match(trellis.find((d) => d.class_type === 'LoadImage').inputs.image, /_3d\.png$/, 'model from the full-body image');
    assert.equal(trellis.find((d) => d.class_type === 'Trellis2UpsampleStage').inputs.target_resolution, 2048, 'high quality by default');

    const k = join(p.setting.outputRoot, job.id);
    assert.ok(existsSync(join(k, 'full-size.png')));
    assert.equal(readFileSync(join(k, 'model.glb'), 'utf8'), 'glTF fake model');
    const files = last.outputs.map((c) => c.file);
    assert.deepEqual(files, ['turntable.mp4', 'model.glb', 'model.fbx', 'model-obj.zip', 'model.stl']);
    assert.equal(last.outputs.find((c) => c.main)?.file, 'turntable.mp4');
    assert.deepEqual(last.outputs.filter((c) => c.type === 'model').map((c) => c.format), ['glb', 'fbx', 'obj', 'stl']);
    // STL is the print copy: its height (the fake Blender takes it from --print-height), size and volume
    assert.deepEqual(last.outputs.find((c) => c.format === 'stl').print, { height: 60, size: [21, 12.6, 60], volume: 12.5, watertight: true, solid: true });
    const v = await streams(p.setting.ffprobe, join(k, 'turntable.mp4'));
    assert.ok(Math.abs(v.duration - 4) < 0.1, `showcase ${v.duration} s ≈ 4`);
    assert.ok(!existsSync(join(k, 'frames')), 'Blender frames deleted');
    // Dosyalar HTTP'den iner (is kimliginde "model3d" rakam icerir) ve dogru turle.
    const glb = await fetch(`${p.address}/file/job/${job.id}/model.glb`);
    assert.equal(glb.status, 200);
    assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
    assert.equal((await fetch(`${p.address}/file/job/${job.id}/turntable.preview.jpg`)).status, 200);
    // Panel yeniden acilinca is diskten geri yuklenir.
    p.queue.jobs.clear();
    p.queue.load();
    assert.equal(p.queue.jobs.get(job.id)?.status, 'done');
  } finally {
    await p.close();
  }
});

test('3D model: frame from video, GLB only without Blender; clear error if a showcase is requested', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const uploads = join(p.setting.outputRoot, 'uploads');
    mkdirSync(uploads, { recursive: true });
    const r = spawnSync(p.setting.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=3', '-pix_fmt', 'yuv420p', join(uploads, 'v.mp4')]);
    assert.equal(r.status, 0);
    assert.throws(() => p.queue.add('model3d', { source: 'upload/v.mp4', intro: true }), /Blender is required/);
    assert.throws(() => p.queue.add('model3d', { source: 'upload/v.mp4', formats: ['dwg'] }), /Invalid export format/);
    const job = p.queue.add('model3d', { source: 'upload/v.mp4', time: 1.5, quality: 'fast' });
    assert.deepEqual([job.input.intro, job.input.formats, job.input.time], [false, [], 1.5]);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const [trellis] = promptList(p);
    assert.equal(trellis.find((d) => d.class_type === 'Trellis2UpsampleStage').inputs.target_resolution, 1536);
    assert.ok(trellis.some((d) => d.class_type === 'Trellis2Conditioning'), 'fast: TRELLIS.2');
    assert.equal(trellis.find((d) => d.class_type === 'DecimateMesh').inputs.target_face_count, 500000);
    assert.ok(existsSync(join(p.setting.outputRoot, job.id, 'frame.png')), 'frame was taken from the video');
    assert.deepEqual(last.outputs.map((c) => [c.file, c.main]), [['model.glb', true]]);
  } finally {
    await p.close();
  }
});
