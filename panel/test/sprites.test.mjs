/**
 * Game assets: the poses, the checks, and the whole job (real graphs on a fake ComfyUI, the fake sprites script that is
 * tied to the real one by script-contract).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { parsePoses } from '../lib/jobs/sprites.mjs';
import * as comfy from '../../tools/comfy.mjs';

const promptList = (p) => p.fake.status.records.filter((x) => x.path === '/prompt').map((x) => Object.values(JSON.parse(x.prompt).prompt));

test('poses: "name: description" lines, defaults per kind, unique file-safe names, at most 12', () => {
  assert.deepEqual(parsePoses(['walk: seen from the side', 'Hurt Badly: knocked back'], 'character'), [
    { name: 'walk', description: 'seen from the side' },
    { name: 'hurt-badly', description: 'knocked back' },
  ]);
  assert.deepEqual(parsePoses('run: fast\nrun: faster; jump high up', 'object').map((p) => p.name), ['run', 'run-2', 'jump-high']);
  assert.deepEqual(parsePoses(undefined, 'vehicle').map((p) => p.name), ['side', 'front', 'back', 'top', 'damaged']);
  assert.deepEqual(parsePoses(['base: x'], 'character').map((p) => p.name), ['base-2'], 'base is the first picture');
  assert.deepEqual(parsePoses(['  ', '??: ???'], 'character').map((p) => p.name), ['pose1'], 'a name without letters falls back');
  assert.throws(() => parsePoses(Array.from({ length: 13 }, (_, i) => `p${i}: x`), 'character'), /At most 12/);
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
    assert.throws(() => p.queue.add('sprites', { prompt: 'a knight', cell: 64 }), /Cell size must be at least 128/);
    const job = p.queue.add('sprites', { prompt: 'chibi knight with a blue sword', poses: ['walk: seen from the side', 'back: seen from behind'], cell: 256, translate: false, seed: 7 });
    assert.match(job.summary.detail, /character · 3 sprites · 256 px cells/);
    const done = await p.waitUntilDone(job.id, 60000);
    assert.equal(done.status, 'done', done.error);

    const [draw, edits, cuts] = promptList(p);
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
    const args = JSON.parse(readFileSync(join(folder, 'sprites-args.json'), 'utf8'));
    assert.deepEqual(args.slice(args.indexOf('--names') + 1), ['base', 'walk', 'back']);
    assert.equal(args[args.indexOf('--anchor') + 1], 'bottom');
    assert.equal(args[args.indexOf('--cell') + 1], '256');
    assert.deepEqual(done.outputs.map((o) => o.file), ['sheet.png', 'sprite_base.png', 'sprite_walk.png', 'sprite_back.png']);
    assert.equal(done.outputs[0].main, true);
    assert.equal(done.outputs[0].atlas, 'atlas.json');
    for (const f of ['base.png', 'pose_walk.png', 'cutout_back.png', 'atlas.json', 'sheet.png']) assert.ok(existsSync(join(folder, f)), f);

    // an object is anchored in the centre, a picture of its own skips the drawing
    const upload = p.queue.add('sprites', { source: `job/${done.id}/base.png`, kind: 'object', poses: ['open: with the lid open'], translate: false });
    const second = await p.waitUntilDone(upload.id, 60000);
    assert.equal(second.status, 'done', second.error);
    const args2 = JSON.parse(readFileSync(join(p.setting.outputRoot, second.id, 'sprites-args.json'), 'utf8'));
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
