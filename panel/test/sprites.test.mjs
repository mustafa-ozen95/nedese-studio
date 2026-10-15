/**
 * Game assets: the poses, the checks, and the whole job (real graphs on a fake ComfyUI, the fake sprites script that is
 * tied to the real one by script-contract).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { makePng } from '../lib/media.mjs';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { actionPose, animationSize, animationView, baseSize, parseAnimations, parsePoses, pickFrames } from '../lib/jobs/sprites.mjs';
import * as comfy from '../../tools/comfy.mjs';

const promptList = (p) => p.fake.status.records.filter((x) => x.path === '/prompt').map((x) => Object.values(JSON.parse(x.prompt).prompt));

test('poses: "name: description" lines, defaults per kind, unique file-safe names, at most 12', () => {
  const hurt = parsePoses(undefined, 'character').find((p) => p.name === 'hurt');
  assert.ok(!/knocked|dizzy/.test(hurt.description), 'a still flinch: a knock-back was drawn with a ghost shield');
  assert.deepEqual(parsePoses(['walk: seen from the side', 'Hurt Badly: knocked back'], 'character'), [
    { name: 'walk', description: 'seen from the side' },
    { name: 'hurt-badly', description: 'knocked back' },
  ]);
  assert.deepEqual(parsePoses('run: fast\nrun: faster; jump high up', 'object').map((p) => p.name), ['run', 'run-2', 'jump-high']);
  assert.deepEqual(parsePoses(undefined, 'vehicle').map((p) => p.name), ['side', 'front', 'back', 'top', 'damaged']);
  assert.deepEqual(parsePoses(['base: x'], 'character').map((p) => p.name), ['base-2'], 'base is the first picture');
  assert.deepEqual(parsePoses(['  ', '??: ???'], 'character').map((p) => p.name), ['pose1'], 'a name without letters falls back');
  assert.throws(() => parsePoses(Array.from({ length: 13 }, (_, i) => `p${i}: x`), 'character'), /At most 12/);
  assert.deepEqual(parsePoses([], 'character'), [], 'an empty list on purpose: the first picture only');
  assert.deepEqual(parsePoses(['', ' '], 'character'), []);
  assert.equal(parsePoses('', 'character').length, 5, 'an empty form field: the defaults');
  // the form job.json keeps, sent through the API: was drawn as "[object Object]" (15.10.2026)
  assert.deepEqual(parsePoses([{ name: 'h1', description: 'flinching in pain' }, { description: 'kneeling' }], 'character'), [
    { name: 'h1', description: 'flinching in pain' },
    { name: 'kneeling', description: 'kneeling' },
  ]);
  assert.deepEqual(parseAnimations([{ name: 'run', description: 'running fast' }]), [{ name: 'run', description: 'running fast' }]);
  assert.throws(() => parsePoses([{ name: 'h1' }], 'character'), /name: description/);
});

test('an attack pose that names no pose is drawn in a big action pose (it was drawn standing, the blade twice)', () => {
  assert.equal(actionPose('character', 'a sword slash'), 'in a big action pose: a sword slash');
  assert.equal(actionPose('character', 'punching forward with one arm extended'), 'in a big action pose: punching forward with one arm extended');
  assert.equal(actionPose('character', 'casting a fireball'), 'in a big action pose: casting a fireball');
  // its own pose, not an attack, or not a character: as written
  const attack = parsePoses(undefined, 'character').find((p) => p.name === 'attack').description;
  assert.equal(actionPose('character', attack), attack);
  assert.equal(actionPose('character', 'a fighting pose with the sword raised'), 'a fighting pose with the sword raised');
  assert.equal(actionPose('character', 'walking seen from the side'), 'walking seen from the side');
  assert.equal(actionPose('character', 'a hitch in the step'), 'a hitch in the step');
  assert.equal(actionPose('vehicle', 'shooting its cannon'), 'shooting its cannon');
});

test('the cut-out graph inverts the subject mask before it becomes the alpha channel', () => {
  const g = comfy.cutoutJob({ picture: 'a.png', prefix: 'panel/x/cutout_a' });
  const by = (type) => Object.entries(g).find(([, d]) => d.class_type === type);
  const [remove] = by('RemoveBackground');
  const [invert, inv] = by('InvertMask');
  assert.deepEqual(inv.inputs.mask, [remove, 0], 'the mask of the background model (1 = subject) is what gets inverted');
  assert.deepEqual(by('JoinImageWithAlpha')[1].inputs.alpha, [invert, 0], 'JoinImageWithAlpha takes 1 = transparent');
  assert.equal(g[by('LoadBackgroundRemovalModel')[0]].inputs.bg_removal_name, 'birefnet.safetensors');
});

test('Game assets: base picture, one edit request for the poses, one cut-out request, sprites and a sheet', async () => {
  const p = await createPanel();
  try {
    assert.throws(() => p.queue.add('sprites', {}), /Description cannot be empty/);
    assert.throws(() => p.queue.add('sprites', { prompt: 'a knight', kind: 'ship' }), /Kind is invalid/);
    assert.throws(() => p.queue.add('sprites', { prompt: 'a knight', cell: 32 }), /Cell size must be at least 64/);
    const job = p.queue.add('sprites', { prompt: 'chibi knight with a blue sword', poses: ['walk: seen from the side', 'back: seen from behind'], cell: 256, translate: false, seed: 7 });
    assert.match(job.summary.detail, /character · 3 sprites · 256 px cells/);
    const done = await p.waitUntilDone(job.id, 60000);
    assert.equal(done.status, 'done', done.error);

    const [draw, edits, cuts] = promptList(p);
    // drawn by FLUX.2 klein unless asked (it kept the details better, 17 s against 68), at 1 MP for a 256 px cell (not
    // 1440 x 1440); its time measured apart from Image's
    const latent = draw.find((d) => d.class_type === 'EmptyFlux2LatentImage').inputs;
    assert.deepEqual([latent.width, latent.height], [1024, 1024]);
    assert.equal(job.input.imageModel, 'flux');
    assert.ok('sprites/base/flux' in p.queue.averages(), 'the first picture is measured on its own');
    const text = draw.find((d) => d.class_type === 'CLIPTextEncode').inputs.text;
    assert.match(text, /chibi knight with a blue sword\. One single character shown complete and whole/);
    assert.match(text, /no ground, no cast shadow/);
    const instructions = edits.filter((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && d.inputs.prompt).map((d) => d.inputs.prompt);
    assert.equal(instructions.length, 2, 'both poses in one request');
    assert.match(instructions[0], /^The same character as in image 1, seen from the side\./);
    assert.match(instructions[1], /seen from behind/);
    assert.equal(cuts.filter((d) => d.class_type === 'RemoveBackground').length, 3, 'the base and both poses are cut out in one request');
    assert.equal(cuts.filter((d) => d.class_type === 'LoadBackgroundRemovalModel').length, 1, 'the model loads once');
    assert.equal(p.fake.status.records.filter((x) => x.path === '/prompt').length, 3, 'three ComfyUI requests in all');

    const folder = join(p.setting.outputRoot, done.id);
    const args = JSON.parse(readFileSync(join(folder, 'sprites-calls.json'), 'utf8'))[0];
    assert.deepEqual(args.slice(args.indexOf('--names') + 1), ['base', 'walk', 'back']);
    assert.equal(args[args.indexOf('--anchor') + 1], 'bottom');
    assert.equal(args[args.indexOf('--cell') + 1], '256');
    assert.deepEqual(done.outputs.map((o) => o.file), ['sheet.png', 'sprite_base.png', 'sprite_walk.png', 'sprite_back.png']);
    assert.equal(done.outputs[0].main, true);
    assert.equal(done.outputs[0].atlas, 'atlas.json');
    for (const f of ['base.png', 'pose_walk.png', 'cutout_back.png', 'atlas.json', 'sheet.png']) assert.ok(existsSync(join(folder, f)), f);

    // an object is anchored in the centre, a picture of its own skips the drawing
    // asked for: Qwen-Image; tiles: Qwen-Image (their prompts were tuned on it)
    const { validate } = await import('../lib/jobs/sprites.mjs');
    assert.equal(validate({ prompt: 'a knight', imageModel: 'qwen' }, { mod: p.mod, setting: p.setting }).imageModel, 'qwen');
    assert.equal(validate({ prompt: 'grass', kind: 'tile' }, { mod: p.mod, setting: p.setting }).imageModel, 'qwen');
    const upload = p.queue.add('sprites', { source: `job/${done.id}/base.png`, kind: 'object', poses: ['open: with the lid open'], translate: false });
    const second = await p.waitUntilDone(upload.id, 60000);
    assert.equal(second.status, 'done', second.error);
    const args2 = JSON.parse(readFileSync(join(p.setting.outputRoot, second.id, 'sprites-calls.json'), 'utf8'))[0];
    assert.equal(args2[args2.indexOf('--anchor') + 1], 'center');
    assert.equal(promptList(p).length, 3 + 2, 'no drawing request this time: edit and cut-out only');
  } finally {
    await p.close();
  }
});

test('Game assets: an error of the sprite script is shown as a message of the job', async () => {
  process.env.FAKE_SPRITES_ERROR = '1';
  const p = await createPanel();
  try {
    const job = p.queue.add('sprites', { prompt: 'a barrel', kind: 'object', poses: ['side: from the side'], translate: false });
    const done = await p.waitUntilDone(job.id, 60000);
    assert.equal(done.status, 'error');
    assert.match(done.error, /Sprites: base: nothing is left after the background removal/);
  } finally {
    delete process.env.FAKE_SPRITES_ERROR;
    await p.close();
  }
});

test('animation helpers: a loop leaves out its last frame, the size fits Wan, the list is capped at 4', () => {
  assert.deepEqual(pickFrames(33, 8), [0, 4, 8, 12, 16, 20, 24, 28], 'evenly spaced, never the last (= the first again)');
  assert.deepEqual(pickFrames(5, 12).every((i) => i >= 0 && i <= 4), true, 'fewer frames than wanted: indexes stay inside');
  assert.deepEqual(animationSize(1328, 1328), [640, 640]);
  assert.deepEqual(animationSize(1200, 800), [640, 432], 'both sides on 16');
  assert.deepEqual(baseSize(1328, 1328, 512), [1024, 1024], 'about 1 MP for a cell up to 512');
  assert.deepEqual(baseSize(1664, 928, 256), [1376, 768]);
  assert.deepEqual(baseSize(1328, 1328, 1024), [1328, 1328], 'a 1024 cell keeps the full size');
  assert.deepEqual(baseSize(800, 800, 256), [800, 800], 'never larger');
  assert.deepEqual(parseAnimations(undefined), [], 'none unless asked');
  assert.deepEqual(parseAnimations(['walk: walking in place']).map((a) => a.name), ['walk']);
  assert.throws(() => parseAnimations(Array.from({ length: 5 }, (_, i) => `a${i}: x`)), /At most 4 animations/);
});

test('Game assets: an animation starts from the base picture, Wan plays it, the loop is closed, its frames are cut out and packed on their own', async () => {
  const p = await createPanel();
  try {
    const job = p.queue.add('sprites', { prompt: 'a robot', kind: 'character', poses: ['side: from the side'], animations: ['walk: walking in place seen from the side'], frames: 6, cell: 256, translate: false, seed: 2 });
    assert.match(job.summary.detail, /character · 2 sprites · 1 animation · 256 px cells/);
    const done = await p.waitUntilDone(job.id, 90000);
    assert.equal(done.status, 'done', done.error);
    const requests = promptList(p);
    // draw (in profile: the walk is seen from the side), poses, cut-outs, the clip, the frame cut-outs: no edit drawing the
    // motion (it came with swoosh arcs), no turn (the base is in profile already)
    assert.match(requests[0].find((d) => d.class_type === 'CLIPTextEncode').inputs.text, /^a robot\. One single character shown complete and whole, full body from head to toe, seen exactly from the side in profile, facing right, standing still, centered with empty space around it\. The character floats on a plain, even, solid light grey background, no text\.$/);
    const edits = requests.filter((r) => r.some((d) => d.class_type === 'TextEncodeQwenImageEditPlus'));
    assert.equal(edits.length, 1, 'the poses only');
    assert.ok(edits.every((e) => !e.some((d) => /walking in place/.test(d.inputs?.prompt ?? ''))));
    assert.equal(existsSync(join(p.setting.outputRoot, done.id, 'view_right.png')), false);
    const wan = requests.find((r) => r.some((d) => d.class_type === 'WanImageToVideo'));
    assert.ok(wan, 'one start picture, no last frame: a first = last frame clip hardly moved on the real machine');
    assert.equal(wan.some((d) => d.class_type === 'WanFirstLastFrameToVideo'), false);
    assert.equal(wan.find((d) => d.class_type === 'WanImageToVideo').inputs.length, 49);
    assert.match(wan.find((d) => d.class_type === 'CLIPTextEncode').inputs.text, /^The character in the picture: walking in place seen from the side. Only this one character is in the scene, alone: no second character, opponent, target or object appears. It stays in the same place with a static camera/);
  assert.match(wan.find((d) => d.class_type === 'CLIPTextEncode').inputs.text, /no motion lines or speed trails/);
  assert.match(wan.find((d) => d.class_type === 'CLIPTextEncode').inputs.text, /keeps facing the same way, its face, clothes and colours unchanged from start to end/, 'no turning to the camera, no drifting look');
    const cuts = requests.at(-1).filter((d) => d.class_type === 'RemoveBackground');
    assert.equal(cuts.length, 6, 'the six frames in one cut-out request');
    const calls = JSON.parse(readFileSync(join(p.setting.outputRoot, done.id, 'sprites-calls.json'), 'utf8'));
    assert.ok(calls.some((c) => c.includes('--mode') && c[c.indexOf('--mode') + 1] === 'loop'), 'the loop is closed by the script');
    const anim = calls.at(-1);
    assert.equal(anim[anim.indexOf('--prefix') + 1], 'walk_');
    assert.ok(anim.includes('--union'), 'the frames keep their place in the cell');
    assert.equal(anim[anim.indexOf('--fps') + 1], '3.2', '6 frames over the 30-frame loop at 16 fps');
    assert.deepEqual(anim.slice(anim.indexOf('--names') + 1), ['walk-01', 'walk-02', 'walk-03', 'walk-04', 'walk-05', 'walk-06']);
    const sheet = done.outputs.find((o) => o.animation === 'walk' && o.atlas);
    assert.equal(sheet.file, 'walk_sheet.png');
    assert.equal(sheet.archive, 'walk_sprites.zip');
    assert.equal(sheet.loop, 30);
    assert.ok(done.outputs.some((o) => o.file === 'walk_animation.webp'));
    assert.equal(done.outputs[0].file, 'sheet.png', 'the pose sheet stays the main output');
    assert.equal(existsSync(join(p.setting.outputRoot, done.id, 'frames_walk')), false, 'the raw frames are removed');
    assert.ok(existsSync(join(p.setting.outputRoot, done.id, 'loop_walk.json')), 'the loop is kept: a retried job does not play the clip again');
    assert.ok('sprites/animation' in p.queue.averages(), 'a whole animation is measured (the 2D form\'s estimate)');
  } finally {
    await p.close();
  }
});

test('Game assets: a running animation starts from a running picture (the pose of its name, or one edit); a walk from the base; what is held is said', async () => {
  const { isRunning } = await import('../lib/jobs/sprites.mjs');
  assert.ok(isRunning('running fast seen from the side') && isRunning('a horse galloping') && isRunning('sprints'));
  assert.ok(!isRunning('walking in place') && !isRunning('swinging an axe') && !isRunning('runic glow'));
  const p = await createPanel();
  try {
    const edits = (from) => promptList(p).slice(from).filter((r) => r.some((d) => d.class_type === 'TextEncodeQwenImageEditPlus'));
    // no pose of its name: one edit draws it running, from the base, in the same view
    let before = promptList(p).length;
    let done = await p.waitUntilDone(p.queue.add('sprites', { prompt: 'a knight', kind: 'character', poses: [], animations: ['run: running fast seen from the side'], frames: 6, cell: 128, translate: false, seed: 5 }).id, 90000);
    assert.equal(done.status, 'done', done.error);
    let list = edits(before);
    assert.equal(list.length, 1, 'the start picture only (drawn in profile: no turn)');
    const text = list[0].find((d) => d.class_type === 'TextEncodeQwenImageEditPlus').inputs.prompt;
    assert.match(text, /^The same character as in image 1, running fast seen from the side, caught mid-stride\. The character keeps holding everything it holds, in the same hands, each held item whole and fully visible\./);
    assert.ok(existsSync(join(p.setting.outputRoot, done.id, 'start_run.png')));
    const wan = promptList(p).slice(before).find((r) => r.some((d) => d.class_type === 'WanImageToVideo'));
    assert.match(wan.find((d) => d.class_type === 'CLIPTextEncode').inputs.text, /The character keeps holding everything it holds/);
    // a pose of the same name showing running: it is the start, no extra edit
    before = promptList(p).length;
    done = await p.waitUntilDone(p.queue.add('sprites', { prompt: 'a knight', kind: 'character', poses: ['run: running fast with a forward lean'], animations: ['run: running fast seen from the side'], frames: 6, cell: 128, translate: false, seed: 5 }).id, 90000);
    assert.equal(done.status, 'done', done.error);
    list = edits(before);
    assert.equal(list.length, 1, 'the poses only');
    assert.match(list[0].find((d) => d.class_type === 'TextEncodeQwenImageEditPlus').inputs.prompt, /running fast with a forward lean\. The character keeps holding everything it holds/);
    assert.equal(existsSync(join(p.setting.outputRoot, done.id, 'start_run.png')), false);
    // a walk: from the base picture, no edit
    before = promptList(p).length;
    done = await p.waitUntilDone(p.queue.add('sprites', { prompt: 'a knight', kind: 'character', poses: [], animations: ['walk: walking seen from the side'], frames: 6, cell: 128, translate: false, seed: 5 }).id, 90000);
    assert.equal(done.status, 'done', done.error);
    assert.equal(edits(before).length, 0);
  } finally {
    await p.close();
  }
});

test('Game assets: the view an animation asks for: from the side (right unless left is said), from behind, or the base picture\'s own', () => {
  assert.equal(animationView('walking in place seen from the side'), 'right');
  assert.equal(animationView('walking from the side, mid stride loop'), 'right');
  assert.equal(animationView('A side view of the knight running'), 'right');
  assert.equal(animationView('runs to the left, facing left'), 'left');
  assert.equal(animationView('walking away, seen from behind'), 'back');
  assert.equal(animationView('The person swings an axe in a looping attack motion'), null);
  assert.equal(animationView('breathing idle, steps aside'), null, '"aside" is not a side view');
});

test('Game assets: a side animation of a drawn character or a vehicle starts from its base (drawn so); a back view, or a given picture, is turned first', async () => {
  const p = await createPanel();
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', 'front.png'), makePng(64, 96));
    let profile = null;
    for (const [input, edits] of [[{ prompt: 'an orc', kind: 'character', animations: ['attack: swinging an axe'] }, 0], [{ prompt: 'a red car', kind: 'vehicle', animations: ['drive: driving, seen from the side'] }, 0], [{ prompt: 'a pixel wizard', kind: 'character', animations: ['walk: walking seen from the side'] }, 0], [{ prompt: 'a pixel wizard', kind: 'character', animations: ['walk: walking away, seen from behind'] }, 1], [{ prompt: 'x', source: 'upload/front.png', kind: 'character', animations: ['walk: walking seen from the side'] }, 1]]) {
      const before = promptList(p).length;
      const job = p.queue.add('sprites', { ...input, poses: [], frames: 6, cell: 128, translate: false, seed: 3 });
      const done = await p.waitUntilDone(job.id, 90000);
      assert.equal(done.status, 'done', done.error);
      assert.equal(promptList(p).slice(before).filter((r) => r.some((d) => d.class_type === 'TextEncodeQwenImageEditPlus')).length, edits, input.prompt);
      if (input.prompt === 'a pixel wizard' && edits === 0) profile = done.id;
    }
    // the first picture of a job drawn in profile, given again (the chat agent made the walk again from sprite_base.png): not
    // turned a second time; a front-facing one from the same kind of job still is
    for (const [source, edits] of [[`job/${profile}/sprite_base.png`, 0], [`job/${profile}/base.png`, 0]]) {
      const before = promptList(p).length;
      const done = await p.waitUntilDone(p.queue.add('sprites', { source, kind: 'character', poses: [], animations: ['walk: walking seen from the side'], frames: 6, cell: 128, translate: false, seed: 3 }).id, 90000);
      assert.equal(done.status, 'done', done.error);
      assert.equal(done.baseView, 'right');
      assert.equal(promptList(p).slice(before).filter((r) => r.some((d) => d.class_type === 'TextEncodeQwenImageEditPlus')).length, edits, source);
    }
    const orc = p.queue.list({ type: 'sprites' }).find((j) => j.input.prompt === 'an orc');
    const before = promptList(p).length;
    const again = await p.waitUntilDone(p.queue.add('sprites', { source: `job/${orc.id}/sprite_base.png`, kind: 'character', poses: [], animations: ['walk: walking seen from the side'], frames: 6, cell: 128, translate: false, seed: 3 }).id, 90000);
    assert.equal(again.status, 'done', again.error);
    assert.equal(promptList(p).slice(before).filter((r) => r.some((d) => d.class_type === 'TextEncodeQwenImageEditPlus')).length, 1, 'the orc was drawn facing front: turned');
  } finally {
    await p.close();
  }
});

test('Game assets: tiles are drawn as variants in one request and made seamless by the script', async () => {
  const p = await createPanel();
  try {
    const job = p.queue.add('sprites', { prompt: 'mossy cobblestone ground', kind: 'tile', variants: 3, cell: 128, translate: false, seed: 4, poses: ['ignored: x'] });
    assert.match(job.summary.detail, /tiles · 3 variants · 128 px/);
    assert.deepEqual(job.input.poses, [], 'no poses for tiles');
    const done = await p.waitUntilDone(job.id, 60000);
    assert.equal(done.status, 'done', done.error);
    const requests = promptList(p);
    assert.equal(requests.length, 1, 'one request draws all variants');
    const texts = requests[0].filter((d) => d.class_type === 'CLIPTextEncode').map((d) => d.inputs.text);
    assert.equal(texts.length, 1, 'the same prompt: the nodes are shared');
    assert.match(texts[0], /^2D game tileset ground tile seen straight from above, orthographic top-down view: mossy cobblestone ground. The surface fills the whole square edge to edge/);
    assert.doesNotMatch(texts[0], /\bno (trees|trunks|shadows|vignette|objects)\b/i, 'no thing named as absent: the model draws it');
    assert.equal(requests[0].filter((d) => d.class_type === 'KSampler').length, 3, 'three seeds');
    const call = JSON.parse(readFileSync(join(p.setting.outputRoot, done.id, 'sprites-calls.json'), 'utf8'))[0];
    assert.equal(call[call.indexOf('--mode') + 1], 'tiles');
    assert.deepEqual(call.slice(call.indexOf('--names') + 1), ['t1', 't2', 't3']);
    assert.deepEqual(done.outputs.map((o) => o.file), ['sheet.png', 'tile_t1.png', 'tile_t2.png', 'tile_t3.png', 'tile-preview.png']);
    assert.throws(() => p.queue.add('sprites', { kind: 'tile', prompt: 'x', variants: 9 }), /Tile variants can be at most 8/);
    const wall = await p.waitUntilDone(p.queue.add('sprites', { prompt: 'red brick wall', kind: 'tile', variants: 1, cell: 128, translate: false, seed: 4 }).id, 60000);
    assert.equal(wall.status, 'done', wall.error);
    const wallText = promptList(p).at(-1).find((d) => d.class_type === 'CLIPTextEncode').inputs.text;
    assert.match(wallText, /^2D game tileset tile, a square texture swatch seen straight on, filled edge to edge with one repeating surface: red brick wall\. [\s\S]*orthographic view, the surface only/, 'a wall is seen straight on');
  } finally {
    await p.close();
  }
});

test('tiles: the real script makes a pattern that wraps (the difference across the border is that of the texture) and keeps its detail', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'tiles-'));
  // a brick-like pattern with a gradient: not periodic in the picture size, so only the script can make it wrap
  const make = `
import numpy as np, sys
from PIL import Image
y, x = np.mgrid[0:256, 0:256]
v = 90 + 60 * ((x // 20 + (y // 20) % 2 * 10) % 2) + x * 0.4
Image.fromarray(np.stack([v, v * 0.8, v * 0.6], -1).clip(0, 255).astype('uint8')).save(sys.argv[1])
check = None
`;
  writeFileSync(join(folder, 'make.py'), make);
  execFileSync(python, [join(folder, 'make.py'), join(folder, 'source_a.png')]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--folder', folder, '--names', 'a', '--cell', '256', '--mode', 'tiles']);
  const measure = `
import numpy as np, sys
from PIL import Image
t = np.asarray(Image.open(sys.argv[1])).astype(float)
wrap = (abs(t[:, 0] - t[:, -1]).mean() + abs(t[0] - t[-1]).mean()) / 2
inner = (abs(np.diff(t, axis=1)).mean() + abs(np.diff(t, axis=0)).mean()) / 2
print(wrap / inner)
`;
  writeFileSync(join(folder, 'measure.py'), measure);
  const ratio = Number(execFileSync(python, [join(folder, 'measure.py'), join(folder, 'tile_a.png')], { encoding: 'utf8' }));
  const raw = Number(execFileSync(python, [join(folder, 'measure.py'), join(folder, 'source_a.png')], { encoding: 'utf8' }));
  assert.ok(ratio < 3, `the border difference is ${ratio.toFixed(1)}× the usual one`);
  assert.ok(ratio < raw, `the source's border difference was ${raw.toFixed(1)}×`);
});

test('Game assets: the art style is written into the first picture and every pose, and an unknown style is refused', async () => {
  const p = await createPanel();
  try {
    assert.throws(() => p.queue.add('sprites', { prompt: 'a knight', style: 'oil' }), /Style is invalid/);
    const job = p.queue.add('sprites', { prompt: 'orc with a club', style: 'pixel', poses: ['walk: seen from the side'], cell: 128, translate: false, seed: 3 });
    const done = await p.waitUntilDone(job.id, 60000);
    assert.equal(done.status, 'done', done.error);
    const [draw, edits] = promptList(p);
    assert.match(draw.find((d) => d.class_type === 'CLIPTextEncode').inputs.text, /orc with a club\. pixel art, limited colour palette.*One single character/);
    const pose = edits.find((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && d.inputs.prompt).inputs.prompt;
    assert.match(pose, /same art style \(pixel art, limited colour palette/);
  } finally {
    await p.close();
  }
});

test('pixel art: the real script turns a smooth cut-out into hard blocks (every 4x4 block one colour, alpha 0 or 255)', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'pixel-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys
from PIL import Image
y, x = np.mgrid[0:200, 0:200]
rgb = np.stack([x * 1.2, y * 1.2, (x + y) * 0.6], -1)
a = (((x - 100) ** 2 + (y - 100) ** 2) < 80 ** 2) * 255
Image.fromarray(np.dstack([rgb, a]).clip(0, 255).astype('uint8'), 'RGBA').save(sys.argv[1])
`);
  writeFileSync(join(folder, 'check.py'), `
import numpy as np, sys
from PIL import Image
t = np.asarray(Image.open(sys.argv[1]).convert('RGBA')).astype(int)
alphas = set(np.unique(t[..., 3]).tolist())
bad = 0
ys, xs = np.nonzero(t[..., 3])
x0, y0 = xs.min(), ys.min()
for by in range(y0, ys.max() - 4, 4):
    for bx in range(x0, xs.max() - 4, 4):
        b = t[by:by + 4, bx:bx + 4].reshape(-1, 4)
        if b[:, 3].min() == 255 and (b[:, :3].max(0) - b[:, :3].min(0)).max() > 0:
            bad += 1
print(sorted(alphas), len(np.unique(t[t[..., 3] == 255][:, :3], axis=0)), bad)
`);
  execFileSync(python, [join(folder, 'make.py'), join(folder, 'cutout_a.png')]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--folder', folder, '--names', 'a', '--cell', '256', '--padding', '0', '--pixel', '64']);
  const out = execFileSync(python, [join(folder, 'check.py'), join(folder, 'sheet.png')], { encoding: 'utf8' }).trim();
  const m = out.match(/^(\[.*\]) (\d+) (\d+)$/);
  const [alphas, colours, bad] = [m[1], Number(m[2]), Number(m[3])];
  assert.ok(colours <= 32, `${colours} colours: one shared palette of 32`);
  assert.equal(alphas, '[0, 255]', 'only fully opaque or empty pixels');
  assert.ok(bad <= 4, `${bad} blocks are not one colour (the block grid may be offset by the crop)`);
});

test('sprites --match: a frame whose colours drifted (lighter, more saturated) is brought back to the base; a frame showing more of one colour (another pose) is left as it is', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'match-'));
  // a figure of four colour bands (cape red, skin, steel, robe blue); "pose": the same colours, the red band wide, the skin
  // narrow; "drift": the base's bands 12 levels lighter and 12% more saturated (the loop's closing clip, 15.10.2026)
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys, cv2
from PIL import Image
colours = [(150, 30, 35), (225, 175, 135), (140, 150, 165), (35, 50, 120)]
def figure(widths, drift=False):
    a = np.zeros((260, 260, 4), np.uint8)
    x = 50
    for c, w in zip(colours, widths):
        a[30:230, x:x + w, :3] = c
        x += w
    a[30:230, 50:x, 3] = 255
    if drift:
        lab = cv2.cvtColor(np.ascontiguousarray(a[..., :3]), cv2.COLOR_RGB2LAB).astype(np.float32)
        lab[..., 0] += 12
        lab[..., 1:] = (lab[..., 1:] - 128) * 1.12 + 128
        a[..., :3] = cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)
    return Image.fromarray(a, 'RGBA')
folder = sys.argv[1]
figure([40, 40, 40, 40]).save(folder + '/cutout_base.png')
figure([40, 40, 40, 40]).save(folder + '/cutout_w-01.png')
figure([80, 12, 40, 28]).save(folder + '/cutout_w-02.png')
figure([40, 40, 40, 40], True).save(folder + '/cutout_w-03.png')
`);
  // the largest RGB distance of a frame's colours (each texel to the nearest of the four) from those four
  writeFileSync(join(folder, 'check.py'), `
import numpy as np, sys
from PIL import Image
colours = np.array([(150, 30, 35), (225, 175, 135), (140, 150, 165), (35, 50, 120)], float)
for f in sys.argv[1:]:
    t = np.asarray(Image.open(f).convert('RGBA')).astype(float)
    px = t[t[..., 3] == 255][:, :3]
    near = np.argmin(((px[:, None] - colours[None]) ** 2).sum(2), 1)
    print(round(max(np.linalg.norm(px[near == i].mean(0) - colours[i]) for i in range(4) if (near == i).any()), 1))
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  const sprites = join(import.meta.dirname, '..', '..', 'tools', 'sprites.py');
  const files = ['cutout_w-02.png', 'cutout_w-03.png', 'sprite_w-02.png', 'sprite_w-03.png'].map((f) => join(folder, f));
  execFileSync(python, ['-s', sprites, '--folder', folder, '--names', 'w-01', 'w-02', 'w-03', '--cell', '256', '--prefix', 'w_', '--union', '--match']);
  const [posed, drifted, posedOut, driftedOut] = execFileSync(python, [join(folder, 'check.py'), ...files], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  assert.ok(posed < 1 && drifted > 15, `the made frames: ${posed}, ${drifted}`);
  assert.ok(posedOut < 3, `the other pose was changed by ${posedOut}`);
  assert.ok(driftedOut < drifted / 3, `the drifted frame is still ${driftedOut} off (was ${drifted})`);
});

test('sprites: floor bits and a streak stuck to the feet are removed, effects around the body stay', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'specks-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys
from PIL import Image
def figure():
    a = np.zeros((300, 400, 4), np.uint8)
    a[40:260, 150:250] = (200, 40, 40, 255)
    return a
a = figure()
a[270:280, 20:80] = (120, 120, 120, 255)      # a separate bit of floor
b = figure()
b[248:258, 40:150] = (120, 120, 120, 255)     # a streak touching the feet
c = figure()
c[60:68, 100:108] = (60, 160, 220, 255)       # a sweat drop beside the head
for name, im in zip('abc', (a, b, c)):
    Image.fromarray(im, 'RGBA').save(sys.argv[1] + '/cutout_' + name + '.png')
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--folder', folder, '--names', 'a', 'b', 'c', '--cell', '256']);
  const sizes = ['a', 'b', 'c'].map((n) => execFileSync(python, ['-c', 'from PIL import Image; import sys; print(*Image.open(sys.argv[1]).size)', join(folder, `sprite_${n}.png`)], { encoding: 'utf8' }).trim());
  assert.deepEqual(sizes, ['100 220', '100 220', '150 220'], 'floor bit gone, streak gone, the drop stays');
});

test('sprites: background kept around a figure that has the background\'s colour inside (a shake halo around a grey knight) is removed with its strokes; inside the outline, or on a figure whose own edge is that colour, it stays', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, mkdirSync: mkdir, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'halo-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys, os
from PIL import Image
GREY = (220, 220, 222)
def figure(rim):
    a = np.zeros((400, 400, 4), np.uint8)
    a[..., :3] = GREY                              # the cleared background keeps its colour under alpha 0
    a[80:320, 140:260] = (30, 30, 40, 255)         # the outline
    a[84:316, 144:256] = (90, 100, 140, 255)       # the body
    a[150:200, 170:230] = GREY + (255,)            # a highlight of the background's colour, inside the outline
    if rim:
        a[80:320, 140:150] = GREY + (255,)         # a white figure: its own edge is the background's colour
    return a
for case in ('grey', 'white'):
    d = os.path.join(sys.argv[1], case)
    os.makedirs(d, exist_ok=True)
    base = figure(case == 'white')
    hurt = figure(case == 'white')
    hurt[100:250, 260:300] = GREY + (255,)         # the halo the cut-out kept between the shake strokes and the body
    hurt[110:240, 296:298] = (30, 30, 40, 255)     # a shake stroke at its outer side
    Image.fromarray(base, 'RGBA').save(d + '/cutout_base.png')
    Image.fromarray(hurt, 'RGBA').save(d + '/cutout_hurt.png')
`);
  writeFileSync(join(folder, 'check.py'), `
import sys
from PIL import Image
im = Image.open(sys.argv[1])
print(*im.size, im.getpixel((im.width // 2, 95))[3])
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  const sprites = join(import.meta.dirname, '..', '..', 'tools', 'sprites.py');
  const result = {};
  for (const c of ['grey', 'white']) {
    execFileSync(python, ['-s', sprites, '--folder', join(folder, c), '--names', 'base', 'hurt', '--cell', '256']);
    result[c] = ['base', 'hurt'].map((n) => execFileSync(python, [join(folder, 'check.py'), join(folder, c, `sprite_${n}.png`)], { encoding: 'utf8' }).trim());
  }
  assert.deepEqual(result.grey, ['120 240 255', '120 240 255'], 'the halo and its stroke are gone, the highlight inside stays');
  assert.deepEqual(result.white, ['120 240 255', '160 240 255'], 'a figure whose edge is the background\'s colour: nothing is cut');
});

test('Game assets: the first sentence of the job description (all the chat agent sees, 140 characters) names game characters and single poses', () => {
  const source = readFileSync(new URL('../lib/api.mjs', import.meta.url), 'utf8');
  const description = source.match(/name: 'Game assets',\s+description: '([^\r\n]*?)\. /)[1];
  assert.ok(description.length <= 140, `${description.length} characters`);
  assert.match(description, /any game character/);
  assert.match(description, /even one pose/);
});

test('Game assets: a motion that does not come back to its start (an attack ending mid-strike) gets a clip from its last frame back to its first, the loop runs over both', async () => {
  process.env.FAKE_SPRITES_CLOSURE = '19.8';
  const p = await createPanel();
  try {
    const job = p.queue.add('sprites', { prompt: 'an orc', kind: 'character', poses: ['side: from the side'], animations: ['attack: swinging an axe'], frames: 6, cell: 256, translate: false, seed: 2 });
    const done = await p.waitUntilDone(job.id, 90000);
    assert.equal(done.status, 'done', done.error);
    const requests = promptList(p);
    const clips = requests.filter((r) => r.some((d) => ['WanImageToVideo', 'WanFirstLastFrameToVideo'].includes(d.class_type)));
    assert.equal(clips.length, 2, 'the motion, then the way back');
    assert.ok(clips[0].some((d) => d.class_type === 'WanImageToVideo'), 'the motion has one start picture');
    const back = clips[1].find((d) => d.class_type === 'WanFirstLastFrameToVideo');
    assert.ok(back, 'the way back ends on the first frame');
    assert.equal(back.inputs.length, 17);
    assert.match(clips[1].find((d) => d.class_type === 'CLIPTextEncode').inputs.text, /^The character moves smoothly back into its starting pose\. Only this one character is in the scene, alone/);
    const loops = JSON.parse(readFileSync(join(p.setting.outputRoot, done.id, 'sprites-calls.json'), 'utf8')).filter((c) => c[c.indexOf('--mode') + 1] === 'loop');
    assert.equal(loops.length, 2);
    assert.ok(loops[1].includes('--whole'), 'the second loop takes the whole clip');
    const loop = JSON.parse(readFileSync(join(p.setting.outputRoot, done.id, 'loop_attack.json'), 'utf8'));
    assert.equal(loop.frames, 49 + 16, 'the way back without its first frame (the motion\'s last)');
    assert.equal(loop.length, 64);
    assert.equal(loop.back, true);
    assert.equal(requests.at(-1).filter((d) => d.class_type === 'RemoveBackground').length, 6);
  } finally {
    delete process.env.FAKE_SPRITES_CLOSURE;
    await p.close();
  }
});

test('sprites: --whole takes the loop over the whole clip (its last frame, the first again, left out)', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = join(mkdtempSync(join(tmpdir(), 'whole-')), 'frames');
  mkdirSync(folder);
  execFileSync(python, ['-c', 'import sys\nfrom PIL import Image\nfor i in range(10): Image.new("RGB", (32, 32), (i * 20, 0, 0)).save(sys.argv[1] + "/%05d.png" % (i + 1))', folder]);
  const run = (...extra) => JSON.parse(/RESULT (.*)/.exec(execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--mode', 'loop', '--frames', folder, '--count', '3', ...extra], { encoding: 'utf8' }))[1]);
  const whole = run('--whole');
  assert.equal(whole.length, 9);
  assert.equal(whole.files.length, 3);
  assert.equal(whole.files[0], '00001.png');
  assert.ok(!whole.files.includes('00010.png'), 'the last frame (the first again) left out');
});

test('Game assets: poses [] with an animation makes the first picture and the animation only (the chat agent asked for no extra poses)', async () => {
  const p = await createPanel();
  try {
    const job = p.queue.add('sprites', { prompt: 'an orc', kind: 'character', poses: [], animations: ['attack: swinging an axe'], frames: 6, cell: 256, translate: false, seed: 2 });
    assert.match(job.summary.detail, /character · 1 sprites · 1 animation/);
    const done = await p.waitUntilDone(job.id, 90000);
    assert.equal(done.status, 'done', done.error);
    const files = done.outputs.map((o) => o.file);
    assert.ok(files.includes('sprite_base.png') && files.includes('attack_sheet.png'), files.join(', '));
    assert.ok(!files.some((f) => /^sprite_(?!base)/.test(f)), 'no other pose');
  } finally {
    await p.close();
  }
});

test('sprites: the loop holds the main motion, not a still start that came back early', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = join(mkdtempSync(join(tmpdir(), 'peak-')), 'frames');
  mkdirSync(folder);
  // 49 frames: still (a shake of 1-2) until 24, a big swing 25-36, back at 44
  execFileSync(python, ['-c', [
    'import sys',
    'from PIL import Image',
    'def level(i):',
    '    if i < 25: return 100 + i % 2 * 2',
    '    if i <= 36: return 100 + (i - 24) * 12',
    '    return max(100, 244 - (i - 36) * 18)',
    'for i in range(49): Image.new("RGB", (32, 32), (level(i), level(i), level(i))).save(sys.argv[1] + "/%05d.png" % (i + 1))',
  ].join('\n'), folder]);
  const out = execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--mode', 'loop', '--frames', folder, '--count', '8'], { encoding: 'utf8' });
  const loop = JSON.parse(/RESULT (.*)/.exec(out)[1]);
  assert.ok(loop.length >= 44, `the loop ends after the swing came back, not at ${loop.length}`);
  assert.ok(loop.closure < 3, String(loop.closure));
});

test('sprites: the loop\'s frames catch the far poses of a motion (a short blow between evenly spaced frames), the first frame kept', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = join(mkdtempSync(join(tmpdir(), 'keys-')), 'frames');
  mkdirSync(folder);
  // 65 frames, the last the first again: two short blows at 13 and 29 (index 12 and 28), between frames 1, 9, 17, 25...
  execFileSync(python, ['-c', [
    'import sys',
    'from PIL import Image',
    'def level(i):',
    '    return int(100 + 140 * max(0, 1 - abs(i - 12) / 3) + 140 * max(0, 1 - abs(i - 28) / 3))',
    'for i in range(65): Image.new("RGB", (32, 32), (level(i),) * 3).save(sys.argv[1] + "/%05d.png" % (i + 1))',
  ].join('\n'), folder]);
  const out = execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--mode', 'loop', '--frames', folder, '--count', '8', '--whole'], { encoding: 'utf8' });
  const loop = JSON.parse(/RESULT (.*)/.exec(out)[1]);
  const index = loop.files.map((f) => Number.parseInt(f, 10) - 1);
  assert.equal(index[0], 0, 'the first frame first');
  assert.ok(index.includes(12) && index.includes(28), `both blows: ${index}`);
  for (let i = 1; i <= index.length; i++) {
    const gap = (index[i] ?? 64) - index[i - 1];
    assert.ok(gap >= 4 && gap <= 16, `gap ${gap} in ${index}`);
  }
});

test('sprites: background left inside a swoosh is taken out of the frames, unless the first picture has the background\'s colour itself', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const make = (baseGrey) => {
    const folder = mkdtempSync(join(tmpdir(), 'swoosh-'));
    writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys
from PIL import Image
GREY = (165, 178, 178)
def picture(swoosh, grey_body):
    a = np.zeros((300, 300, 4), np.uint8)
    a[..., :3] = GREY                                   # the background, cleared (alpha 0) but its colour kept
    a[60:280, 120:180] = (60, 140, 40, 255)             # the figure
    if grey_body:
        a[60:120, 120:180] = GREY + (255,)              # a helmet of the background's grey
    if swoosh:
        a[20:120, 180:280] = GREY + (255,)              # the background inside a swoosh, kept
        a[20:120, 178:180] = (20, 20, 20, 255)          # its line
    return a
Image.fromarray(picture(False, sys.argv[2] == '1'), 'RGBA').save(sys.argv[1] + '/cutout_base.png')
Image.fromarray(picture(True, sys.argv[2] == '1'), 'RGBA').save(sys.argv[1] + '/cutout_a-01.png')
`);
    execFileSync(python, [join(folder, 'make.py'), folder, baseGrey ? '1' : '0']);
    execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--folder', folder, '--names', 'a-01', '--cell', '256', '--union', '--prefix', 'a_']);
    return execFileSync(python, ['-c', 'from PIL import Image; import sys; print(*Image.open(sys.argv[1]).size)', join(folder, 'sprite_a-01.png')], { encoding: 'utf8' }).trim();
  };
  assert.equal(make(false), '60 220', 'the grey patch is gone and so is its line where it sticks out of the figure');
  assert.equal(make(true), '160 260', 'a figure with the background\'s grey: nothing taken');
});

test('tiles: a texture drawn with dark edges and a lit middle gives an evenly lit tile (no dark cross repeated on the floor), its detail kept', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'vignette-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys
from PIL import Image
n = 512
y, x = np.mgrid[0:n, 0:n] / n
vignette = 1 - 0.6 * (((x - 0.5) ** 2 + (y - 0.5) ** 2) * 4)                       # 1 in the middle, 0.4 in the corners
stones = 0.75 + 0.25 * ((np.floor(x * 16) + np.floor(y * 16)) % 2)                    # a fine checker of stones
a = (np.stack([200 * stones, 180 * stones, 140 * stones], -1) * vignette[..., None]).clip(0, 255).astype(np.uint8)
Image.fromarray(a, 'RGB').save(sys.argv[1] + '/source_t1.png')
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--mode', 'tiles', '--folder', folder, '--names', 't1', '--cell', '256']);
  const measure = (file) => execFileSync(python, ['-c', [
    'import sys, numpy as np, cv2',
    'from PIL import Image',
    'g = np.asarray(Image.open(sys.argv[1]).convert("L")).astype(np.float32)',
    'b = cv2.GaussianBlur(g, (0, 0), g.shape[0] / 8, borderType=cv2.BORDER_REFLECT)',
    'print(round(float(b.max() - b.min()), 1), round(float(np.abs(g - cv2.GaussianBlur(g, (0, 0), 2)).mean()), 1))',
  ].join('\n'), file], { encoding: 'utf8' }).trim().split(' ').map(Number);
  const [sourceRange] = measure(join(folder, 'source_t1.png'));
  const [tileRange, detail] = measure(join(folder, 'tile_t1.png'));
  assert.ok(sourceRange > 60, `the source is unevenly lit: ${sourceRange}`);
  assert.ok(tileRange < sourceRange / 4, `the tile's broad light varies ${tileRange} (source ${sourceRange})`);
  assert.ok(detail > 3, `the stones are still there: ${detail}`);
});

test('sprites: thin floating speed lines go, a thick drop beside the figure stays', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'lines-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys, cv2
from PIL import Image
a = np.zeros((400, 400, 4), np.uint8)
a[60:340, 150:250] = (60, 140, 40, 255)                                              # the figure, 280 tall
cv2.ellipse(a, (200, 200), (150, 150), 0, 150, 210, (20, 20, 20, 255), 2)            # a speed line, 2 px, left of it
a[100:116, 268:284] = (60, 160, 220, 255)                                             # a 16 px drop on the right
Image.fromarray(a, 'RGBA').save(sys.argv[1] + '/cutout_a.png')
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--folder', folder, '--names', 'a', '--cell', '512']);
  const size = execFileSync(python, ['-c', 'from PIL import Image; import sys; print(*Image.open(sys.argv[1]).size)', join(folder, 'sprite_a.png')], { encoding: 'utf8' }).trim();
  assert.equal(size, '134 280', 'the line on the left is gone, the drop on the right stays');
});

test('tiles: stones are cut between, not faded into each other (no half-see-through ghost stones), and the tile still wraps', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'ghost-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys, cv2
from PIL import Image
n = 512
a = np.zeros((n, n, 3), np.uint8)
a[:] = (40, 60, 200)                                                                  # blue mortar
rng = np.random.default_rng(3)
for y in range(0, n, 64):                                                             # red stones, rows shifted at random
    shift = int(rng.integers(0, 64))
    for x in range(-64, n, 64):
        cv2.rectangle(a, (x + shift + 6, y + 6), (x + shift + 57, y + 57), (210, 50, 40), -1)
Image.fromarray(a, 'RGB').save(sys.argv[1] + '/source_t1.png')
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--mode', 'tiles', '--folder', folder, '--names', 't1', '--cell', '448']);
  const [ghost, wrap] = execFileSync(python, ['-c', [
    'import sys, numpy as np',
    'from PIL import Image',
    'a = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(int)',
    'mixed = (a[..., 0] > 90) & (a[..., 2] > 90)',
    'print(round(float(mixed.mean() * 100), 2), round(float(max(np.abs(a[0] - a[-1]).mean(), np.abs(a[:, 0] - a[:, -1]).mean())), 1))',
  ].join('\n'), join(folder, 'tile_t1.png')], { encoding: 'utf8' }).trim().split(' ').map(Number);
  assert.ok(ghost < 1.5, `${ghost}% of the tile is a red-blue mix (a ghost stone)`);
  assert.ok(wrap < 40, `the opposite edges differ ${wrap}`);
});

test('sprites: a swoosh outline joined to the figure goes with the swoosh, a thin antenna away from it stays', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'stroke-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys, cv2
from PIL import Image
def canvas():
    a = np.zeros((400, 400, 4), np.uint8)
    a[..., :3] = 200                                                                      # the grey background, cleared
    return a
base = canvas()
base[55:340, 150:250] = (60, 140, 40, 255)
Image.fromarray(base, 'RGBA').save(sys.argv[1] + '/cutout_base.png')
a = canvas()
cv2.ellipse(a, (200, 200), (134, 134), 0, 180, 250, (200, 200, 200, 255), 28)             # the swoosh's grey inside, kept opaque
a[55:340, 150:250] = (60, 140, 40, 255)                                                   # the figure, 285 tall
a[25:55, 230:233] = (60, 140, 40, 255)                                                    # a thin antenna, 30 long
cv2.ellipse(a, (200, 200), (150, 150), 0, 180, 270, (20, 20, 20, 255), 3)                 # the swoosh's outline, touching the figure
Image.fromarray(a, 'RGBA').save(sys.argv[1] + '/cutout_a.png')
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--folder', folder, '--names', 'a', '--cell', '512']);
  const size = execFileSync(python, ['-c', 'from PIL import Image; import sys; print(*Image.open(sys.argv[1]).size)', join(folder, 'sprite_a.png')], { encoding: 'utf8' }).trim();
  const [w, h] = size.split(' ').map(Number);
  assert.ok(w <= 106, `the outline is gone (a stub where it met the corner may stay): ${w} wide, the figure is 100`);
  assert.equal(h, 315, 'the antenna stays');
});

test('sprites: a floating stroke thicker at one end goes, a small drop of blood stays', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'stroke-end-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys, cv2
from PIL import Image
a = np.zeros((400, 400, 4), np.uint8)
a[60:340, 150:250] = (60, 140, 40, 255)                                              # the figure, 280 tall
cv2.ellipse(a, (200, 200), (150, 150), 0, 150, 210, (20, 20, 20, 255), 2)             # a stroke on the left
cv2.circle(a, (70, 125), 3, (20, 20, 20, 255), -1)                                    # its thicker end
cv2.circle(a, (290, 120), 3, (150, 20, 20, 255), -1)                                  # a drop of blood on the right
Image.fromarray(a, 'RGBA').save(sys.argv[1] + '/cutout_a.png')
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--folder', folder, '--names', 'a', '--cell', '512']);
  const size = execFileSync(python, ['-c', 'from PIL import Image; import sys; print(*Image.open(sys.argv[1]).size)', join(folder, 'sprite_a.png')], { encoding: 'utf8' }).trim();
  assert.equal(size, '144 280', 'the stroke on the left is gone, the drop on the right stays');
});

test('tiles: every part of the drawn texture is used once (a tile does not repeat its own pattern inside)', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'repeat-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys, cv2
from PIL import Image
rng = np.random.default_rng(5)
a = cv2.GaussianBlur(rng.random((512, 512, 3)).astype(np.float32), (0, 0), 6)        # blotches that are nowhere the same
a = ((a - a.min()) / (a.max() - a.min()) * 255).astype(np.uint8)
Image.fromarray(a, 'RGB').save(sys.argv[1] + '/source_t1.png')
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--mode', 'tiles', '--folder', folder, '--names', 't1', '--cell', '256']);
  const same = Number(execFileSync(python, ['-c', [
    'import sys, numpy as np',
    'from PIL import Image',
    'g = np.asarray(Image.open(sys.argv[1]).convert("L")).astype(np.float32)',
    'g -= g.mean()',
    'print(max(float((g * np.roll(g, s, 1)).mean() / (g * g).mean()) for s in range(96, 161)))',
  ].join('\n'), join(folder, 'tile_t1.png')], { encoding: 'utf8' }).trim());
  assert.ok(same < 0.5, `the tile matches itself shifted by about half its width: ${same}`);
});

test('tiles: a source drawn as two panels side by side becomes one panel; a single picture stays whole', { skip: !existsSync('C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe') }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const python = 'C:/Users/root/nedese-studio/ComfyUI_windows_portable/python_embeded/python.exe';
  const folder = mkdtempSync(join(tmpdir(), 'panels-'));
  writeFileSync(join(folder, 'make.py'), `
import numpy as np, sys
from PIL import Image
n = 512
y, x = np.mgrid[0:n, 0:n].astype(np.float32)
stripes = np.where(x < n / 2, np.sin(x / 3), np.sin(y / 3)) * 40 + 150           # upright stripes on the left, lying on the right
def vignette(x, y, w, h):
    return 1 - 0.5 * (((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2) / 2
two = stripes * np.where(x < n / 2, vignette(x, y, n / 2, n), vignette(x - n / 2, y, n / 2, n))
two[:, n // 2 - 3:n // 2 + 3] = 40                                                # the joint between the two panels
one = stripes * vignette(x, y, n, n)
for name, a in (('two', two), ('one', one)):
    Image.fromarray(np.repeat(np.clip(a, 0, 255).astype(np.uint8)[..., None], 3, 2), 'RGB').save(sys.argv[1] + f'/source_{name}.png')
`);
  execFileSync(python, [join(folder, 'make.py'), folder]);
  execFileSync(python, ['-s', join(import.meta.dirname, '..', '..', 'tools', 'sprites.py'), '--mode', 'tiles', '--folder', folder, '--names', 'two', 'one', '--cell', '256']);
  const lying = (name) => Number(execFileSync(python, ['-c', [
    'import sys, numpy as np',
    'from PIL import Image',
    'g = np.asarray(Image.open(sys.argv[1]).convert("L")).astype(np.float32)',
    'print(np.abs(np.diff(g, axis=0)).mean() / np.abs(np.diff(g, axis=1)).mean())',
  ].join('\n'), join(folder, `tile_${name}.png`)], { encoding: 'utf8' }).trim());
  assert.ok(lying('two') < 0.3, `only the first panel (upright stripes) is in the tile: ${lying('two')}`);
  assert.ok(lying('one') > 0.5, `a single picture keeps both halves: ${lying('one')}`);
});
