/**
 * Game assets: the poses, the checks, and the whole job (real graphs on a fake ComfyUI, the fake sprites script that is
 * tied to the real one by script-contract).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { animationSize, parseAnimations, parsePoses, pickFrames } from '../lib/jobs/sprites.mjs';
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
    assert.throws(() => p.queue.add('sprites', { prompt: 'a knight', cell: 32 }), /Cell size must be at least 64/);
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
    const args = JSON.parse(readFileSync(join(folder, 'sprites-calls.json'), 'utf8'))[0];
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
  assert.deepEqual(parseAnimations(undefined), [], 'none unless asked');
  assert.deepEqual(parseAnimations(['walk: walking in place']).map((a) => a.name), ['walk']);
  assert.throws(() => parseAnimations(Array.from({ length: 5 }, (_, i) => `a${i}: x`)), /At most 4 animations/);
});

test('Game assets: an animation starts from a picture of the motion, Wan plays it, the loop is closed, its frames are cut out and packed on their own', async () => {
  const p = await createPanel();
  try {
    const job = p.queue.add('sprites', { prompt: 'a robot', kind: 'character', poses: ['side: from the side'], animations: ['walk: walking in place seen from the side'], frames: 6, cell: 256, translate: false, seed: 2 });
    assert.match(job.summary.detail, /character · 2 sprites · 1 animation · 256 px cells/);
    const done = await p.waitUntilDone(job.id, 90000);
    assert.equal(done.status, 'done', done.error);
    const requests = promptList(p);
    // draw, poses, cut-outs, the starting picture (an edit), the clip, the frame cut-outs
    const start = requests.find((r) => r.some((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && /shown in the middle of that motion/.test(d.inputs.prompt ?? '')));
    assert.ok(start, 'the starting picture is the base picture changed as the animation describes');
    assert.match(start.find((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && d.inputs.prompt).inputs.prompt, /^The same character as in image 1, walking in place seen from the side, shown in the middle of that motion. Only this one character is in the picture, alone, with no other character, opponent, target or object\./);
    const wan = requests.find((r) => r.some((d) => d.class_type === 'WanImageToVideo'));
    assert.ok(wan, 'one start picture, no last frame: a first = last frame clip hardly moved on the real machine');
    assert.equal(wan.some((d) => d.class_type === 'WanFirstLastFrameToVideo'), false);
    assert.equal(wan.find((d) => d.class_type === 'WanImageToVideo').inputs.length, 49);
    assert.match(wan.find((d) => d.class_type === 'CLIPTextEncode').inputs.text, /^The character walking in place seen from the side. Only this one character is in the scene, alone: no second character, opponent, target or object appears. It stays in the same place with a static camera/);
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
    assert.match(texts[0], /mossy cobblestone ground. Seamless tileable texture, flat top-down orthographic view/);
    assert.equal(requests[0].filter((d) => d.class_type === 'KSampler').length, 3, 'three seeds');
    const call = JSON.parse(readFileSync(join(p.setting.outputRoot, done.id, 'sprites-calls.json'), 'utf8'))[0];
    assert.equal(call[call.indexOf('--mode') + 1], 'tiles');
    assert.deepEqual(call.slice(call.indexOf('--names') + 1), ['t1', 't2', 't3']);
    assert.deepEqual(done.outputs.map((o) => o.file), ['sheet.png', 'tile_t1.png', 'tile_t2.png', 'tile_t3.png', 'tile-preview.png']);
    assert.throws(() => p.queue.add('sprites', { kind: 'tile', prompt: 'x', variants: 9 }), /Tile variants can be at most 8/);
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
  assert.deepEqual(whole.files, ['00001.png', '00004.png', '00007.png']);
});
