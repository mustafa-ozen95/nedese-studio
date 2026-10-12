/**
 * 3D model: fake ComfyUI (the real TRELLIS.2 graph) + fake Blender + REAL ffmpeg (turntable video, previews).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { streams } from '../lib/ffmpeg.mjs';
import { fileURLToPath } from 'node:url';
import { COMPLETE_PROMPT, DRAW_SUFFIX, GAME, MODEL_EDIT_PROMPT, PORTRAIT_PROMPT, QUALITY, validate } from '../lib/jobs/model3d.mjs';
import { graphFiles, SAMPLE_INPUT } from '../lib/models.mjs';
import * as comfy from '../../tools/comfy.mjs';

const FAKE_FACE = fileURLToPath(new URL('./fake-face.mjs', import.meta.url));
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
    const job = p.queue.add('model3d', { source, complete: true, title: 'Balıkçı', seed: 3, printHeight: 60, intro: true });
    // Default: no turntable video (user 10.10.2026: "3d için video üretmeye gerek olduğunu düşünmüyorum"), all exports
    const plain = p.queue.add('model3d', { source, seed: 3 });
    assert.deepEqual([plain.input.intro, plain.input.formats], [false, ['fbx', 'obj', 'stl']], 'three formats, no video by default when Blender is present');
    assert.equal(job.input.intro, true, 'the turntable when ticked');
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
    // User 11.10.2026: "Gözler düzeltilmeli" — Pixal3D's voxel colours lost a woman's irises; the model is pixel aligned
    // with input.png through MoGe's field of view, read from the graph, and the picture is projected onto its front
    const graph = JSON.parse(p.fake.status.records.filter((x) => x.path === '/prompt')[2].prompt).prompt;
    const fov = Object.values(graph).find((d) => d.class_type === 'PreviewAny');
    assert.equal(graph[fov.inputs.source[0]].class_type, 'MoGeGeometryToFOV');
    assert.deepEqual(JSON.parse(readFileSync(join(k, 'camera.json'), 'utf8')), { fov: 39.53125 });
    assert.equal(readFileSync(join(k, 'model.glb'), 'utf8'), 'glTF fake model projected');
    assert.deepEqual(JSON.parse(readFileSync(join(k, 'front-projection.json'), 'utf8')).models.map((m) => m.file), ['model.glb']);
    assert.match(p.queue.logs.get(job.id).join('\n'), /Picture projected onto the front \(FAKE, fov 39\.5°\): model\.glb 12%/);
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
    const plainLast = await p.waitUntilDone(plain.id, 120000);
    assert.equal(plainLast.status, 'done', plainLast.error);
    assert.deepEqual(plainLast.outputs.map((c) => c.file), ['model.glb', 'model.fbx', 'model-obj.zip', 'model.stl']);
    assert.equal(plainLast.outputs.find((c) => c.main)?.file, 'model.glb');
    assert.ok(!existsSync(join(p.setting.outputRoot, plain.id, 'turntable.mp4')), 'no turntable rendered');
    p.queue.jobs.clear();
    p.queue.load();
    assert.equal(p.queue.jobs.get(job.id)?.status, 'done');
  } finally {
    await p.close();
  }
});

// One input (user 11.10.2026: "3d için videodan kareye gerek yok, fotoğraf, 3d görüntü veya tarif versin"; "3d girdi
// verilirse düzenleme promtu olur"): a 3D model file is converted, or edited by the description; a description alone
// is drawn first; a video is no longer a source.
test('3D model: a 3D model file is converted without a description and edited with one; a description alone is drawn first', async (t) => {
  const p = await createPanel({ blender: true, server: true });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const uploads = join(p.setting.outputRoot, 'uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'owl.obj'), 'v 0 0 0\n');
    writeFileSync(join(uploads, 'owl.dwg'), 'x');
    assert.throws(() => p.queue.add('model3d', {}), /Give an image or a 3D model, or describe what to make/);
    assert.throws(() => p.queue.add('model3d', { source: 'upload/owl.dwg' }), /The source image must be PNG, JPEG or WebP/);

    // without a description: Blender reads it and writes the GLB, the exports and a front view for the gallery
    const plain = p.queue.add('model3d', { source: 'upload/owl.obj', formats: ['stl'] });
    assert.deepEqual([plain.input.kind, plain.input.prompt, plain.summary.detail], ['model', null, 'converted · STL · print 100 mm']);
    const plainLast = await p.waitUntilDone(plain.id, 60000);
    assert.equal(plainLast.status, 'done', plainLast.error);
    assert.equal(promptList(p).length, 0, 'nothing generated');
    assert.deepEqual(plainLast.outputs.map((c) => [c.file, Boolean(c.main)]), [['model.glb', true], ['model.stl', false]]);
    assert.equal(plainLast.outputs[0].preview, 'view.preview.jpg', 'the gallery card has a picture');
    assert.ok(existsSync(join(p.setting.outputRoot, plain.id, 'view.preview.jpg')));

    // with a description: its front view is edited as described and the model is made again from it
    const edited = p.queue.add('model3d', { source: 'upload/owl.obj', prompt: 'make it golden', translate: false, formats: [], quality: 'fast', seed: 4 });
    assert.equal(edited.summary.title, 'make it golden');
    const editedLast = await p.waitUntilDone(edited.id, 60000);
    assert.equal(editedLast.status, 'done', editedLast.error);
    const [edit, trellis] = promptList(p);
    assert.equal(edit.find((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && d.inputs.prompt)?.inputs.prompt, MODEL_EDIT_PROMPT('make it golden'));
    assert.match(trellis.find((d) => d.class_type === 'LoadImage').inputs.image, /_3d\.png$/);
    const k = join(p.setting.outputRoot, edited.id);
    assert.ok(existsSync(join(k, 'view.png')) && existsSync(join(k, 'edited.png')), 'view, then the edit');
    assert.deepEqual(editedLast.outputs.map((c) => c.file), ['model.glb']);

    // a description alone: the subject is drawn whole first
    const drawn = p.queue.add('model3d', { prompt: 'a ceramic owl', translate: false, imageModel: 'flux', formats: [], quality: 'fast', complete: true });
    assert.deepEqual([drawn.input.kind, drawn.input.complete, drawn.input.draw.imageModel], ['text', false, 'flux'], 'completion is for images only');
    const drawnLast = await p.waitUntilDone(drawn.id, 60000);
    assert.equal(drawnLast.status, 'done', drawnLast.error);
    const [draw] = promptList(p).slice(2);
    const texts = draw.filter((d) => d.class_type === 'CLIPTextEncode').map((d) => d.inputs.text);
    assert.ok(texts.includes(`a ceramic owl. ${DRAW_SUFFIX}`), texts.join(' | '));
    assert.ok(existsSync(join(p.setting.outputRoot, drawn.id, 'drawn.png')));
  } finally {
    await p.close();
  }
});

// User 11.10.2026: "3d alanımız oyunlar için asset üretiyo dimi" — the million-triangle model is too heavy for a game.
test('3D model: game copies (low poly + LOD) from the same generation, with FBX; none for a converted file', async (t) => {
  const p = await createPanel({ blender: true, server: true });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const uploads = join(p.setting.outputRoot, 'uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'owl.glb'), 'glTF');
    assert.throws(() => p.queue.add('model3d', { source: 'upload/owl.glb', game: true }), /Game copies are made while generating/);
    const job = p.queue.add('model3d', { prompt: 'a wooden barrel', translate: false, imageModel: 'flux', quality: 'fast', formats: ['fbx'], game: true });
    assert.equal(job.input.game, true);
    assert.match(job.summary.detail, /game copies/);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const trellis = promptList(p).at(-1);
    assert.deepEqual(trellis.filter((d) => d.class_type === 'DecimateMesh').map((d) => d.inputs.target_face_count), [500000, ...GAME.map((l) => l.surface)]);
    assert.deepEqual(trellis.filter((d) => d.class_type === 'SaveGLB').map((d) => d.inputs.filename_prefix), [`panel/${job.id}/model`, `panel/${job.id}/model_game0`, `panel/${job.id}/model_game1`]);
    // the copies with QEM placement, creases weighted (midpoint broke a knight's 30k copy into shards); each in its own
    // texture size, its normal map and AO baked from the main 1M mesh (the remesh took twice as long for the same look)
    assert.deepEqual(trellis.filter((d) => d.class_type === 'DecimateMesh').map((d) => d.inputs.placement_mode), ['midpoint', 'qem', 'qem']);
    assert.ok(trellis.filter((d) => d.class_type === 'DecimateMesh').slice(1).every((d) => d.inputs['placement_mode.feature_edge_quadric_weight'] > 0));
    const graph = JSON.parse(p.fake.status.records.filter((x) => x.path === '/prompt').at(-1).prompt).prompt;
    const main = Object.keys(graph).find((id) => graph[id].class_type === 'DecimateMesh' && graph[id].inputs.target_face_count === 500000);
    // the first copy from the remesh, the LOD from the first copy (a second pass over a furry dwarf's remesh ran out of VRAM)
    const copies = GAME.map((l) => Object.keys(graph).find((id) => graph[id].class_type === 'DecimateMesh' && graph[id].inputs.target_face_count === l.surface));
    assert.deepEqual(copies.map((id) => graph[graph[id].inputs.mesh[0]].class_type), ['RemeshMesh', 'DecimateMesh']);
    assert.equal(graph[copies[1]].inputs.mesh[0], copies[0]);
    for (const [i, level] of GAME.entries()) {
      const normal = trellis.filter((d) => d.class_type === 'BakeNormalMapFromMesh')[i + 1];
      assert.equal(normal.inputs.resolution, level.texture);
      assert.equal(normal.inputs.high_poly[0], main);
    }
    assert.deepEqual(last.outputs.map((c) => [c.file, c.format, c.game?.lod ?? null]), [['model.glb', 'glb', null], ['model.fbx', 'fbx', null], ['game.glb', 'glb', 0], ['game.fbx', 'fbx', 0], ['game-lod1.glb', 'glb', 1], ['game-lod1.fbx', 'fbx', 1]]);
    assert.equal(last.outputs.find((c) => c.main)?.file, 'model.glb', 'the gallery still shows the full model');
    assert.equal(last.outputs.find((c) => c.file === 'game.glb').game.triangles, 1234, 'the count Blender read');
    const k = join(p.setting.outputRoot, job.id);
    // User 11.10.2026: "3d model güzel ama oyun hali kötü" — ComfyUI's normal map did not match the copies' tangents
    // (patchy face): each copy's map is baked again in Blender from model.glb (game-normals.json: a retry does not bake again)
    for (const f of ['game.glb', 'game-lod1.glb']) assert.equal(readFileSync(join(k, f), 'utf8'), 'glTF fake model normals', f);
    assert.equal(readFileSync(join(k, 'model.glb'), 'utf8'), 'glTF fake model');
    assert.ok(!existsSync(join(k, 'camera.json')), 'TRELLIS.2 (fast) is not pixel aligned: nothing projected');
    assert.deepEqual(JSON.parse(readFileSync(join(k, 'game-normals.json'), 'utf8')).copies.map((c) => c.file), ['game.glb', 'game-lod1.glb']);
    assert.match(p.queue.logs.get(job.id).join('\n'), /Game copy normal maps baked again \(FAKE\): game\.glb 2048 px, game-lod1\.glb 2048 px/);
    assert.equal(last.outputs.find((c) => c.file === 'game-lod1.glb').game.triangles, 617);
    // a furry dwarf (11.10.2026): the fur's small pieces dropped, the copy ended at 9711 of 30000 triangles and the LOD
    // made from it was the same mesh: no second file of the same thing
    process.env.FAKE_BLENDER_TRIANGLES = JSON.stringify({ game: 9711, 'game-lod1': 9711 });
    try {
      const furry = await p.waitUntilDone(p.queue.add('model3d', { prompt: 'a furry dwarf', translate: false, imageModel: 'flux', quality: 'fast', formats: ['fbx'], game: true }).id, 60000);
      assert.equal(furry.status, 'done', furry.error);
      assert.deepEqual(furry.outputs.map((c) => c.file), ['model.glb', 'model.fbx', 'game.glb', 'game.fbx']);
      const f = join(p.setting.outputRoot, furry.id);
      assert.ok(!existsSync(join(f, 'game-lod1.glb')) && !existsSync(join(f, 'game-lod1.fbx')));
      assert.match(p.queue.logs.get(furry.id).join('\n'), /game-lod1\.glb left out: game\.glb has only 9711 triangles/);
    } finally {
      delete process.env.FAKE_BLENDER_TRIANGLES;
    }
    // without game: the graph has a single bake and a single SaveGLB
    const plain = p.queue.add('model3d', { prompt: 'a wooden barrel', translate: false, imageModel: 'flux', quality: 'fast', formats: [] });
    assert.equal((await p.waitUntilDone(plain.id, 60000)).status, 'done');
    assert.equal(promptList(p).at(-1).filter((d) => d.class_type === 'SaveGLB').length, 1);
  } finally {
    await p.close();
  }
});

// User 11.10.2026, the eyes projected from the picture: "yeterli değil". A full-body figure's face (~10% of input.png)
// is generated again from a close portrait: a Pixal3D head, its face put on the model and its game copies.
test("3D model: a full-body figure's small face is generated again from a portrait and put on the model and its game copies; a large face is left", async (t) => {
  const faceModel = join(mkdtempSync(join(tmpdir(), 'yunet-')), 'face_detection_yunet_2023mar.onnx');
  writeFileSync(faceModel, 'onnx');
  const p = await createPanel({ blender: true, setting: { faceModel, faceCommand: (args) => ({ command: process.execPath, args: [FAKE_FACE, ...args], env: { ...process.env } }) } });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  const small = [477.3, 75.6, 75.5, 107.0, 497.2, 116.3, 531.2, 116.4, 513.3, 136.5, 499.2, 152.8, 529.3, 153.1, 0.9];
  const portraitFace = [358.6, 173.7, 292.4, 424.8, 442.1, 342.8, 576.2, 335.6, 519.6, 418.8, 459.3, 491.9, 572.5, 484.9, 0.9];
  try {
    const previous = await p.waitUntilDone(p.queue.add('image', { prompt: 'a woman in a leather jacket, full body', model: 'flux', ratio: '1:1' }).id);
    const source = `job/${previous.id}/${previous.outputs[0].file}`;
    process.env.FAKE_FACES = JSON.stringify({ 'input.png': [small], 'head-input.png': [portraitFace] });
    const before = promptList(p).length;
    const job = p.queue.add('model3d', { source, seed: 5, formats: ['fbx'], game: true });
    assert.equal(job.input.face, true, 'on by default');
    const last = await p.waitUntilDone(job.id, 120000);
    assert.equal(last.status, 'done', last.error);
    const [body, portrait, head] = promptList(p).slice(before);
    assert.ok(body.some((d) => d.class_type === 'Pixal3DConditioning'));
    assert.equal(portrait.find((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && d.inputs.prompt)?.inputs.prompt, PORTRAIT_PROMPT);
    assert.match(head.find((d) => d.class_type === 'LoadImage').inputs.image, /_head\.png$/, 'the head from the portrait');
    assert.ok(head.some((d) => d.class_type === 'Pixal3DConditioning'), 'the head in high quality');
    assert.equal(head.filter((d) => d.class_type === 'SaveGLB').length, 1, 'no game copies of the head');
    const k = join(p.setting.outputRoot, job.id);
    // the face after the picture's projection, before the copies' normal maps (baked from the new face) and the exports
    assert.equal(readFileSync(join(k, 'model.glb'), 'utf8'), 'glTF fake model projected face');
    for (const f of ['game.glb', 'game-lod1.glb']) assert.equal(readFileSync(join(k, f), 'utf8'), 'glTF fake model projected face normals', f);
    assert.deepEqual(JSON.parse(readFileSync(join(k, 'face-transfer.json'), 'utf8')).models.map((m) => m.file), ['model.glb', 'game.glb', 'game-lod1.glb']);
    assert.ok(existsSync(join(k, 'portrait.png')), 'the portrait stays');
    assert.ok(!existsSync(join(k, 'head.glb')) && !existsSync(join(k, 'head-input.png')), 'the head (80 MB) is deleted once its face is on the model');
    const log = p.queue.logs.get(job.id).join('\n');
    assert.match(log, /Head placed: scale 0\.420/);
    assert.match(log, /Face transferred from a separately generated head \(FAKE\): model\.glb, game\.glb, game-lod1\.glb/);
    assert.deepEqual(last.outputs.map((c) => c.file), ['model.glb', 'model.fbx', 'game.glb', 'game.fbx', 'game-lod1.glb', 'game-lod1.fbx']);

    // a bust: its face is already large, nothing is generated again
    process.env.FAKE_FACES = JSON.stringify({ 'input.png': [portraitFace] });
    const count = promptList(p).length;
    const bust = await p.waitUntilDone(p.queue.add('model3d', { source, seed: 6, formats: [] }).id, 120000);
    assert.equal(bust.status, 'done', bust.error);
    assert.equal(promptList(p).length, count + 1, 'only the model itself');
    assert.equal(readFileSync(join(p.setting.outputRoot, bust.id, 'model.glb'), 'utf8'), 'glTF fake model projected');
    assert.match(p.queue.logs.get(bust.id).join('\n'), /Face transfer skipped: the face is large enough/);
  } finally {
    delete process.env.FAKE_FACES;
    await p.close();
  }
});

test('3D model: GLB only without Blender; a 3D model file needs Blender; clear error if a showcase is requested', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const uploads = join(p.setting.outputRoot, 'uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'owl.glb'), 'glTF');
    assert.throws(() => p.queue.add('model3d', { source: 'upload/owl.glb' }), /Blender is required to read a 3D model file/);
    assert.throws(() => p.queue.add('model3d', { prompt: 'a lamp', intro: true }), /Blender is required/);
    assert.throws(() => p.queue.add('model3d', { prompt: 'a lamp', formats: ['dwg'] }), /Invalid export format/);
    const job = p.queue.add('model3d', { prompt: 'a lamp', translate: false, quality: 'fast' });
    assert.deepEqual([job.input.intro, job.input.formats], [false, []]);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const trellis = promptList(p).at(-1);
    assert.equal(trellis.find((d) => d.class_type === 'Trellis2UpsampleStage').inputs.target_resolution, 1536);
    assert.ok(trellis.some((d) => d.class_type === 'Trellis2Conditioning'), 'fast: TRELLIS.2');
    assert.equal(trellis.find((d) => d.class_type === 'DecimateMesh').inputs.target_face_count, 500000);
    assert.deepEqual(last.outputs.map((c) => [c.file, c.main]), [['model.glb', true]]);
  } finally {
    await p.close();
  }
});

// 10.10.2026: a fresh install's 3D jobs started while Pixal3D and MoGe were still downloading reached ComfyUI ("Value not
// in list"); the check before the queue looked only at the default (TRELLIS.2) graph's files.
test("3D model: the chosen quality's own model files are checked before the queue (high: Pixal3D + MoGe)", () => {
  const modelRoot = mkdtempSync(join(tmpdir(), 'ai-panel-models-'));
  try {
    const put = (key) => {
      mkdirSync(join(modelRoot, key.split('/')[0]), { recursive: true });
      writeFileSync(join(modelRoot, ...key.split('/')), '');
    };
    const fast = graphFiles(comfy.trellis2Job({ ...SAMPLE_INPUT, ...QUALITY.fast }));
    const high = graphFiles(comfy.trellis2Job({ ...SAMPLE_INPUT, ...QUALITY.high }));
    assert.ok(high.includes('diffusion_models/pixal3d_int8_convrot.safetensors') && high.includes('geometry_estimation/moge_2_vitl_normal_fp16.safetensors'), high.join(', '));
    for (const key of fast) put(key);
    const setting = { modelRoot, outputRoot: modelRoot, blender: null };
    assert.throws(() => validate({ quality: 'high' }, { mod: comfy, setting }), /Model files missing for 3D model \(Pixal3D\): .*pixal3d_int8_convrot\.safetensors.*moge_2_vitl_normal_fp16\.safetensors\. Download them in Settings > Models/);
    // fast (TRELLIS.2) has its files: the check passes and the next one (the source) speaks
    assert.throws(() => validate({ quality: 'fast' }, { mod: comfy, setting }), /Give an image or a 3D model, or describe what to make/);
    for (const key of high) put(key);
    assert.throws(() => validate({ quality: 'high' }, { mod: comfy, setting }), /Give an image or a 3D model, or describe what to make/);
  } finally {
    rmSync(modelRoot, { recursive: true, force: true });
  }
});
