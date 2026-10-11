/**
 * 3D model > Character skeleton (user 11.10.2026: "İskelet (rig) henüz yok, yani karakter oyunda animasyonla hareket
 * ettirilemez ... yap"): fake ComfyUI + fake tools\rig\infer.py + fake Blender (model3d.py and rig.py) + REAL ffmpeg
 * (the test motion video).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { streams } from '../lib/ffmpeg.mjs';
import { CATALOG, GENERATOR_NAMES, usedFiles } from '../lib/models.mjs';
import { loadSettings } from '../lib/settings.mjs';
import { COMPLETE_PROMPT, DRAW_SUFFIX, RIG_MOTION, RIG_POSE } from '../lib/jobs/model3d.mjs';

const promptList = (p) => p.fake.status.records.filter((x) => x.path === '/prompt').map((x) => Object.values(JSON.parse(x.prompt).prompt));
const editText = (graph) => graph.find((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && d.inputs.prompt)?.inputs.prompt;
const calls =(log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)) : []);

async function panel(t, rigEnv, options = {}) {
  const p = await createPanel({ blender: true, server: true, rigEnv, ...options });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return null;
  }
  return p;
}

test('skeleton: analysed once on the full model, put into the model and both game copies before the FBX; a test motion video', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'rig-'));
  const log = join(folder, 'calls.jsonl');
  const p = await panel(t, { FAKE_RIG_LOG: log });
  if (!p) return;
  try {
    const job = p.queue.add('model3d', { prompt: 'a knight in armour', translate: false, imageModel: 'flux', quality: 'fast', formats: ['fbx'], game: true, rig: true });
    assert.equal(job.input.rig, true);
    assert.match(job.summary.detail, /game copies · skeleton/);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const k = join(p.setting.outputRoot, job.id);
    // drawn in the pose for rigging (the relaxed A-pose often came out with the arms against the body)
    const texts = promptList(p)[0].filter((d) => d.class_type === 'CLIPTextEncode').map((d) => d.inputs.text);
    assert.ok(texts.some((x) => x.startsWith('a knight in armour. ') && x.includes(RIG_POSE)), texts.join(' | '));
    assert.ok(!texts.some((x) => x.includes(DRAW_SUFFIX)));
    assert.deepEqual(calls(log).map((c) => c.input), [join(k, 'model.glb')], 'one analysis, on the full model');
    // the copies' normal maps baked again before the skeleton (the bake writes a copy without its armature)
    assert.equal(readFileSync(join(k, 'model.glb'), 'utf8'), 'glTF fake model rigged');
    for (const f of ['game.glb', 'game-lod1.glb']) assert.equal(readFileSync(join(k, f), 'utf8'), 'glTF fake model normals rigged', f);
    // the FBX are written from the rigged GLB: the skeleton is in them
    for (const f of ['model.fbx', 'game.fbx', 'game-lod1.fbx']) assert.equal(readFileSync(join(k, f), 'utf8'), 'fake fbx rigged', f);
    assert.deepEqual(last.outputs.map((c) => c.file), ['model.glb', 'model.fbx', 'game.glb', 'game.fbx', 'game-lod1.glb', 'game-lod1.fbx', 'skeleton.mp4']);
    assert.equal(last.outputs.find((c) => c.main)?.file, 'model.glb', 'the gallery shows the model, not the test motion');
    assert.deepEqual(last.outputs[0].rig, { bones: 52 });
    const motion = last.outputs.at(-1);
    assert.deepEqual([motion.type, motion.rig, motion.preview], ['video', { bones: 52 }, 'skeleton.preview.jpg']);
    const v = await streams(p.setting.ffprobe, join(k, 'skeleton.mp4'));
    assert.ok(Math.abs(v.duration - RIG_MOTION.frames / RIG_MOTION.fps) < 0.1, `test motion ${v.duration} s`);
    assert.ok(!existsSync(join(k, 'rig')) && !existsSync(join(k, 'rig.npz')), 'the frames and the analysis are deleted');
    assert.deepEqual(JSON.parse(readFileSync(join(k, 'rig.json'), 'utf8')).models.map((m) => m.file), ['model.glb', 'game.glb', 'game-lod1.glb']);
    assert.match(p.queue.logs.get(job.id).join('\n'), /Skeleton in 3 model file\(s\): 52 bones/);
    assert.equal((await fetch(`${p.address}/file/job/${job.id}/skeleton.mp4`)).status, 200);
  } finally {
    await p.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('skeleton: a given picture is posed for rigging first (Qwen-Image-Edit), also without "full body"; the model is made from the posed picture', async (t) => {
  const p = await panel(t, {});
  if (!p) return;
  try {
    const previous = await p.waitUntilDone(p.queue.add('image', { prompt: 'a soldier', model: 'flux', ratio: '1:1' }).id);
    const source = `job/${previous.id}/${previous.outputs[0].file}`;
    const job = p.queue.add('model3d', { source, quality: 'fast', formats: [], rig: true });
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const [, pose, trellis] = promptList(p);
    const prompt = editText(pose);
    assert.ok(prompt.includes(RIG_POSE) && prompt !== COMPLETE_PROMPT, prompt);
    assert.match(prompt, /Keep exactly the same face/);
    assert.match(trellis.find((d) => d.class_type === 'LoadImage').inputs.image, /_3d\.png$/);
    assert.ok(existsSync(join(p.setting.outputRoot, job.id, 'full-size.png')), 'the posed picture');
    assert.match(p.queue.logs.get(job.id).join('\n'), /Posing for the skeleton: \d+ s/);
    // with "full body" too: one edit, the skeleton's pose
    const both = await p.waitUntilDone(p.queue.add('model3d', { source, quality: 'fast', formats: [], rig: true, complete: true, seed: 2 }).id, 60000);
    assert.equal(both.status, 'done', both.error);
    const edits = promptList(p).slice(3).map(editText).filter(Boolean);
    assert.equal(edits.length, 1);
    assert.ok(edits[0].includes(RIG_POSE));
  } finally {
    await p.close();
  }
});

test('skeleton: a converted 3D model file gets one too (GLB first, then the skeleton, then the exports from it)', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'rig-'));
  const log = join(folder, 'calls.jsonl');
  const p = await panel(t, { FAKE_RIG_LOG: log });
  if (!p) return;
  try {
    const uploads = join(p.setting.outputRoot, 'uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'hero.fbx'), 'fbx');
    const job = p.queue.add('model3d', { source: 'upload/hero.fbx', formats: ['fbx', 'stl'], rig: true });
    assert.equal(job.summary.detail, 'converted · skeleton · FBX/STL · print 100 mm');
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const k = join(p.setting.outputRoot, job.id);
    assert.deepEqual(calls(log).map((c) => c.input), [join(k, 'model.glb')]);
    assert.equal(readFileSync(join(k, 'model.glb'), 'utf8'), 'fake glb rigged');
    assert.equal(readFileSync(join(k, 'model.fbx'), 'utf8'), 'fake fbx rigged');
    assert.deepEqual(last.outputs.map((c) => c.file), ['model.glb', 'model.fbx', 'model.stl', 'skeleton.mp4']);
    assert.equal(last.outputs[0].preview, 'view.preview.jpg', 'the gallery card still has the front view');
  } finally {
    await p.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('skeleton: refused before the queue when not installed or without Blender; a failing analysis fails the job with its error', async (t) => {
  const bare = await createPanel({ blender: true });
  try {
    assert.throws(() => bare.queue.add('model3d', { prompt: 'a knight', rig: true }), /character skeleton is not installed: download "Character skeleton \(Make-It-Animatable\)" in Settings > Models/);
  } finally {
    await bare.close();
  }
  const noBlender = await createPanel({ rigEnv: {} });
  try {
    assert.throws(() => noBlender.queue.add('model3d', { prompt: 'a knight', rig: true, formats: [] }), /Blender is required for the character skeleton/);
  } finally {
    await noBlender.close();
  }
  const p = await panel(t, { FAKE_RIG_ERROR: '1' });
  if (!p) return;
  try {
    const job = await p.waitUntilDone(p.queue.add('model3d', { prompt: 'a knight', translate: false, imageModel: 'flux', quality: 'fast', formats: [], rig: true }).id, 60000);
    assert.equal(job.status, 'error');
    assert.match(p.queue.logs.get(job.id).join('\n'), /CUDA out of memory/);
  } finally {
    await p.close();
  }
});

test('skeleton: the four checkpoints are in the catalog for rigJob; hasRig follows the files without a restart; the command uses rig\\.venv', () => {
  const user = usedFiles({});
  const files = ['joints_coarse.pth', 'bw.pth', 'bw_normal.pth', 'joints.pth'];
  for (const d of files) {
    assert.deepEqual(user[`rigging/${d}`], ['rigJob'], d);
    const k = CATALOG.find((x) => x.folder === 'rigging' && x.file === d);
    assert.match(k.sha256, /^[0-9a-f]{64}$/);
    // pinned to a revision: a new upload under the same name cannot change what the checksum was taken from
    assert.match(k.url, /\/resolve\/[0-9a-f]{40}\/output\/best\/new\//);
  }
  assert.equal(GENERATOR_NAMES.rigJob, 'Character skeleton: Make-It-Animatable');
  const root = mkdtempSync(join(tmpdir(), 'rig-settings-'));
  try {
    const a = loadSettings({ aiRoot: root, ffmpeg: null });
    assert.equal(a.hasRig, false);
    const k = a.rigCommand(['--input', 'model.glb']);
    assert.match(k.command, /rig[\\/]\.venv[\\/]Scripts[\\/]python\.exe$/);
    assert.match(k.args[0], /tools[\\/]rig[\\/]infer\.py$/);
    assert.equal(k.env.AI_RIG_CODE, join(root, 'rig'));
    assert.equal(k.env.AI_RIG_MODEL, join(root, 'models', 'rigging'));
    for (const d of [['rig', '.venv', 'Scripts'], ['tools', 'rig'], ['models', 'rigging']]) mkdirSync(join(root, ...d), { recursive: true });
    for (const d of [join('rig', '.venv', 'Scripts', 'python.exe'), join('tools', 'rig', 'infer.py'), ...files.map((x) => join('models', 'rigging', x))]) writeFileSync(join(root, d), 'x');
    assert.equal(a.hasRig, true, 'the same settings object sees the downloaded files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
