/**
 * Game assets (2D): a character, vehicle or object drawn once, shown in more poses or views with the same design
 * (Qwen-Image-Edit from the first picture), every picture cut out of its background (BiRefNet), trimmed into sprites and
 * packed into a sprite sheet with an atlas (tools\sprites.py).
 * Steps: base picture (drawn from the description, or the given source) -> one edit per pose (one ComfyUI request) ->
 * one cut-out request -> sprites, sheet.png, atlas.json. Files already written are not made again (a retried job resumes).
 * Animations: a picture of the described motion (Qwen-Image-Edit from the base picture) moved by Wan 2.2 (a 3 second clip),
 * the loop closed where the clip comes back closest to its first frame, evenly spaced frames of the loop cut out and packed
 * as their own sheet with an animated preview. (First = last frame as one picture gave frames that hardly moved: 13.10.2026.)
 * Kind "tile": seamless ground/wall textures (drawn variants made tileable by tools\sprites.py).
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { merge, nodes, modelFiles, addLora } from '../graph.mjs';
import { UserError } from '../errors.mjs';
import { imageSize } from '../media.mjs';
import { run as runProcess } from '../process.mjs';
import { jobPrompt } from '../prompt-translate.mjs';
import { trainedModels } from './training.mjs';
import { runWan } from './wan.mjs';
import { IMAGE_MODELS, RATIOS, text, number, choice, seed, yes, sourcePath, generatorRequired } from './common.mjs';

export const name = 'Game assets';

const KINDS = ['character', 'vehicle', 'object', 'tile'];
// The art style (written into the description of the first picture and of every pose and animation: the models drift to realism otherwise)
export const STYLES = {
  cartoon: '2D cartoon mobile game art, bold clean outlines, flat vibrant colours, simple cel shading, stylised proportions',
  pixel: 'pixel art, limited colour palette, crisp hard pixels, no anti-aliasing, retro game sprite',
  flat: 'flat vector illustration, simple geometric shapes, solid colours, no gradients, no outlines',
  painted: 'hand-painted 2D game art, soft brush strokes, rich colours, painterly shading',
  realistic: 'realistic detailed render, natural lighting and materials',
};
const MAX_POSES = 12;
const MAX_ANIMATIONS = 4;
const ANIMATION = { frame: 49, fps: 16, size: 640 };
/**
 * A loop whose last frame is further from its first than this (mean grey difference 0-255) jumps when it starts again:
 * an attack that ended mid-strike measured 19.8 (14.10.2026), loops that looked closed 2.3-4.4. Such a clip gets a
 * second short clip (back frames) from its last frame to its first; one picture as both ends hardly moved.
 */
const CLOSE_LIMIT = 5;
const BACK_FRAMES = 17;
const DEFAULT_POSES = {
  character: [
    'walk: seen from the side facing right, in the middle of a walking stride',
    'run: seen from the side facing right, running fast with a forward lean',
    'attack: in a big action pose, striking or attacking with force',
    'hurt: knocked back and hurt, with a dizzy pained expression',
    'back: seen from behind, standing',
  ],
  vehicle: [
    'side: seen exactly from the side, facing right',
    'front: seen exactly from the front',
    'back: seen exactly from behind',
    'top: seen from directly above',
    'damaged: damaged, dented and smoking',
  ],
  object: [
    'side: seen exactly from the side',
    'back: seen from behind',
    'top: seen from directly above',
  ],
};
const BASE_SUFFIX = {
  character: 'One single character shown complete and whole, full body from head to toe, standing in a neutral idle pose, centered with empty space around it, on a plain solid light grey background, no ground, no cast shadow, no text.',
  vehicle: 'One single vehicle shown complete and whole, seen exactly from the side facing right, centered with empty space around it, on a plain solid light grey background, no ground, no cast shadow, no text.',
  object: 'One single object shown complete and whole, centered with empty space around it, on a plain solid light grey background, no ground, no cast shadow, no text.',
  tile: 'Seamless tileable texture, flat top-down orthographic view, even lighting without shadows or vignette, the pattern fills the whole picture edge to edge, no border, no frame, no single large object in the middle.',
};

/** "name: description" lines (or a plain description); a list or a text split at line breaks and semicolons. */
function parseList(value, defaults, max, label) {
  let list = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? value.split(/[\r\n;]+/) : null;
  if (!list) list = defaults;
  list = list.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (list.length > max) throw new UserError(`At most ${max} ${label}.`);
  const used = new Set(['base']);
  return list.map((s, i) => {
    const m = /^([\p{L}\p{N} _-]{1,24}):\s*(.+)$/su.exec(s);
    const description = (m ? m[2] : s).slice(0, 300);
    let slug = (m ? m[1] : s.split(/\s+/).slice(0, 2).join('-')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || `pose${i + 1}`;
    if (!/^[a-z0-9-]+$/.test(slug)) slug = `pose${i + 1}`;
    let unique = slug;
    for (let n = 2; used.has(unique); n++) unique = `${slug}-${n}`;
    used.add(unique);
    return { name: unique, description };
  });
}

/**
 * An empty list given on purpose: the first picture only (14.10.2026: the chat agent sent [] for "only an attack
 * animation, no extra poses", was refused and added a pose nobody asked for). Nothing given: the defaults.
 */
export function parsePoses(value, kind) {
  if (Array.isArray(value) && !value.some((s) => String(s ?? '').trim())) return [];
  return parseList(value, DEFAULT_POSES[kind] ?? [], MAX_POSES, 'poses or views');
}

/** Animations: none by default; the names may not clash with the poses' (their files differ by prefix, so they cannot). */
export function parseAnimations(value) {
  return parseList(value, [], MAX_ANIMATIONS, 'animations');
}

/** The picture's size for Wan: the long side ANIMATION.size, both multiples of 16. */
export function animationSize(width, height) {
  const k = ANIMATION.size / Math.max(width, height);
  const on16 = (n) => Math.max(256, Math.round((n * k) / 16) * 16);
  return [on16(width), on16(height)];
}

/** The frames of a loop: evenly spaced, the last one left out (it is the first again). */
export function pickFrames(total, wanted) {
  return Array.from({ length: wanted }, (_, i) => Math.min(total - 1, Math.round((i * (total - 1)) / wanted)));
}

export function validate(g, { mod, setting }) {
  const kind = choice(g.kind, 'Kind', KINDS, 'character');
  const source = kind === 'tile' ? '' : String(g.source ?? '').trim();
  if (source) sourcePath(setting.outputRoot, source);
  const model = choice(g.imageModel, 'Image model', Object.keys(IMAGE_MODELS), 'qwen');
  if (!source) {
    generatorRequired(mod, IMAGE_MODELS[model].generator, IMAGE_MODELS[model].name, setting?.modelRoot);
    // the description is required when there is no picture to start from
    text(g.prompt, 'Description');
  }
  let lora = null;
  if (g.lora) {
    if (model !== 'flux') throw new UserError('The selected LoRA was trained for FLUX.2 klein 4B; choose FLUX.2 klein as the image model.');
    const m = trainedModels(setting?.aiRoot ?? '').find((x) => x.field === 'image' && (x.lora === g.lora || x.id === g.lora || `trained:${x.id}` === g.lora));
    if (!m) throw new UserError(`Trained image LoRA not found: ${String(g.lora).slice(0, 80)}`);
    lora = { file: m.lora, name: m.name, trigger: m.trigger ?? '', strength: number(g.loraStrength, 'LoRA strength', { min: 0, max: 2, defaultValue: 1 }) };
  }
  const poses = kind === 'tile' ? [] : parsePoses(g.poses, kind);
  const animations = kind === 'tile' ? [] : parseAnimations(g.animations);
  if (poses.length || animations.length) generatorRequired(mod, 'editJob', 'Image editing', setting?.modelRoot);
  if (animations.length) generatorRequired(mod, 'wan14Job', 'Animation (Wan 2.2 A14B)', setting?.modelRoot);
  if (kind !== 'tile') generatorRequired(mod, 'cutoutJob', 'Background removal', setting?.modelRoot);
  const ratio = kind === 'tile' ? '1:1' : choice(g.ratio, 'Aspect ratio', Object.keys(RATIOS), '1:1');
  const [width, height] = RATIOS[ratio][model];
  return {
    kind,
    style: g.style ? choice(g.style, 'Style', Object.keys(STYLES), '') : '',
    prompt: text(g.prompt, 'Description', { required: !source }),
    source,
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    poses,
    animations,
    frames: number(g.frames, 'Animation frames', { min: 4, max: 24, full: true, defaultValue: 12 }),
    variants: number(g.variants, 'Tile variants', { min: 1, max: 8, full: true, defaultValue: 4 }),
    imageModel: model,
    ratio,
    width,
    height,
    cell: number(g.cell, 'Cell size', { min: 64, max: 1024, full: true, defaultValue: 512 }),
    ...(lora ? { lora } : {}),
    translate: yes(g.translate ?? true),
    seed: seed(g.seed),
  };
}

export function summary(g) {
  if (g.kind === 'tile') return { title: g.title || g.prompt || 'Game assets', detail: `tiles · ${g.variants} variants · ${g.cell} px` };
  const more = g.animations?.length ? ` · ${g.animations.length} animation${g.animations.length > 1 ? 's' : ''}` : '';
  return { title: g.title || g.prompt || 'Game assets', detail: `${g.kind} · ${g.poses.length + 1} sprites${more} · ${g.cell} px cells` };
}

async function saveFirst(ctx, list, target, what) {
  if (!list.length) throw new Error(`ComfyUI did not return ${what}.`);
  await ctx.comfy.getOutput(list[0], `${target}.temp.png`);
  renameSync(`${target}.temp.png`, target);
}

async function packer(ctx, args) {
  const k = ctx.setting.spritesCommand(args);
  let last = [];
  let result = null;
  await runProcess(k.command, k.args, {
    env: k.env,
    cwd: ctx.folder,
    signal: ctx.signal,
    name: 'sprites',
    line: (s) => {
      last = [...last, s].slice(-12);
      if (s.startsWith('RESULT ')) result = JSON.parse(s.slice(7));
    },
  }).catch((e) => {
    const h = last.find((s) => s.startsWith('ERROR:'));
    throw h ? new UserError(`Sprites: ${h.slice(6).trim()}`) : e;
  });
  return result;
}

/** The first picture(s) drawn from the description: one request, `count` different seeds. */
async function draw(ctx, { count, prefix, suffix, stage, range, files }) {
  const g = ctx.job.input;
  const prompt = await jobPrompt(ctx, g.prompt, 'image', { translate: g.translate !== false });
  const generator = ctx.mod[IMAGE_MODELS[g.imageModel].generator];
  const written = g.lora?.trigger && !prompt.toLowerCase().includes(g.lora.trigger.toLowerCase()) ? `${g.lora.trigger}, ${prompt}` : prompt;
  const graphs = Array.from({ length: count }, (_, i) => {
    const graph = generator({ text: `${written}. ${g.style ? `${STYLES[g.style]}. ` : ''}${suffix}`, seed: g.seed + i, width: g.width, height: g.height, prefix: `panel/${ctx.job.id}/${prefix}${i + 1}` });
    if (g.lora) addLora(graph, g.lora.file, g.lora.strength);
    return graph;
  });
  ctx.job.modelFiles = modelFiles(graphs[0]);
  const { job, match } = merge(graphs);
  const t = Date.now();
  const outputs = await ctx.runComfy(job, { stage, range });
  for (const [i, file] of files.entries()) await saveFirst(ctx, images(outputs, match[i][nodes(graphs[i], 'SaveImage')[0]]), file, `picture ${i + 1}`);
  ctx.measure(`image/${g.imageModel}`, (Date.now() - t) / 1000 / count);
}

async function runTiles(ctx) {
  const g = ctx.job.input;
  const folder = ctx.folder;
  const names = Array.from({ length: g.variants }, (_, i) => `t${i + 1}`);
  const files = names.map((n) => join(folder, `source_${n}.png`));
  if (files.some((f) => !existsSync(f))) await draw(ctx, { count: g.variants, prefix: 'tile_source_', suffix: BASE_SUFFIX.tile, stage: g.variants > 1 ? `Tiles (${g.variants})` : 'Tile', range: [0, 92], files });
  ctx.progress({ stage: 'Making the tiles seamless', percent: 94 });
  await packer(ctx, ['--folder', folder, '--mode', 'tiles', '--cell', String(g.cell), '--names', ...names]);
  const outputs = [{ file: 'sheet.png', type: 'image', main: true, atlas: 'atlas.json', archive: 'sprites.zip', sprites: names.length, cell: g.cell, seed: g.seed }];
  for (const n of names) outputs.push({ file: `tile_${n}.png`, type: 'image', tile: n, seed: g.seed });
  outputs.push({ file: 'tile-preview.png', type: 'image', seed: g.seed, preview3x3: true });
  ctx.addOutputs(outputs);
}

/** The picture an animation starts from: the base picture changed as the animation describes (written once). */
async function animationPicture(ctx, animation, baseFile, range) {
  const g = ctx.job.input;
  const target = join(ctx.folder, `animpose_${animation.name}.png`);
  if (existsSync(target)) return target;
  const picture = await ctx.comfy.load(baseFile, `panel_${ctx.job.id}_base${extname(baseFile).toLowerCase()}`);
  const instruction = await jobPrompt(ctx, animation.description, 'video', { field: `animation_${animation.name}`, translate: g.translate !== false });
  const prompt = `The same ${g.kind} as in image 1, ${instruction}, shown in the middle of that motion. Only this one ${g.kind} is in the picture, alone, with no other character, opponent, target or object. Keep exactly the same design, colours, clothing or parts and the same art style${g.style ? ` (${STYLES[g.style]})` : ''}. Plain solid light grey background, no ground, no cast shadow, nothing else in the picture.`;
  const graph = ctx.mod.editJob({ pictures: [picture], text: prompt, seed: g.seed + 100, prefix: `panel/${ctx.job.id}/animpose_${animation.name}` });
  const outputs = await ctx.runComfy(graph, { stage: `Animation: the starting picture (${animation.name})`, range });
  await saveFirst(ctx, images(outputs, nodes(graph, 'SaveImage')[0]), target, `the starting picture of ${animation.name}`);
  return target;
}

/** Pixel art is packed as real pixels: 64 pixels across a cell. */
const pixelArgs = (g) => (g.style === 'pixel' ? ['--pixel', '64'] : []);

/** One animation: a picture of the motion moved by Wan, the loop closed, its frames cut out and packed as <name>_sheet.png. */
async function runAnimation(ctx, animation, baseFile, index) {
  const g = ctx.job.input;
  const folder = ctx.folder;
  const sheet = join(folder, `${animation.name}_sheet.png`);
  const names = Array.from({ length: g.frames }, (_, i) => `${animation.name}-${String(i + 1).padStart(2, '0')}`);
  const frameDir = join(folder, `frames_${animation.name}`);
  const loopFile = join(folder, `loop_${animation.name}.json`);
  // this animation's part of the bar (60-95 shared by all): the starting picture, the clip, the cut-outs
  const span = 35 / g.animations.length;
  const part = (from, to) => [60 + index * span + from * span, 60 + index * span + to * span];
  let loop = existsSync(loopFile) ? JSON.parse(readFileSync(loopFile, 'utf8')) : null;
  if (!names.every((n) => existsSync(join(folder, `cutout_${n}.png`)))) {
    if (!loop) {
      const start = await animationPicture(ctx, animation, baseFile, part(0, 0.1));
      const size = imageSize(start) ?? { width: 1, height: 1 };
      const [width, height] = animationSize(size.width, size.height);
      if (!existsSync(frameDir) || readdirSync(frameDir).length < ANIMATION.frame) {
        rmSync(frameDir, { recursive: true, force: true });
        const instruction = await jobPrompt(ctx, animation.description, 'video', { field: `animation_${animation.name}`, translate: g.translate !== false });
        const prompt = `The ${g.kind} ${instruction}${g.style ? `, ${STYLES[g.style]}` : ''}. Only this one ${g.kind} is in the scene, alone: no second character, opponent, target or object appears. It stays in the same place with a static camera, on the same plain light grey background, no ground, no cast shadow, a steady repeating motion.`;
        await runWan(ctx, {
          model: 'wan14', source: start, prompt, seed: g.seed + index, width, height, frame: ANIMATION.frame, smooth: 1,
          target: frameDir, stage: `Animation: ${animation.name}`, range: part(0.1, 0.55), prefixExtra: `anim_${animation.name}`,
        });
      }
      // back frames of a run that stopped before the loop was written are made again
      for (const f of readdirSync(frameDir)) if (Number.parseInt(f, 10) > ANIMATION.frame) rmSync(join(frameDir, f), { force: true });
      loop = await packer(ctx, ['--mode', 'loop', '--frames', frameDir, '--count', String(g.frames)]);
      if (loop.closure > CLOSE_LIMIT) {
        ctx.log(`Animation ${animation.name}: the motion does not come back (closing difference ${loop.closure}), a clip back to the first frame`);
        const files = readdirSync(frameDir).filter((f) => f.toLowerCase().endsWith('.png')).sort();
        const prompt = `The ${g.kind} moves smoothly back into its starting pose${g.style ? `, ${STYLES[g.style]}` : ''}. Only this one ${g.kind} is in the scene, alone: no second character, opponent, target or object appears. It stays in the same place with a static camera, on the same plain light grey background, no ground, no cast shadow.`;
        await runWan(ctx, {
          model: 'wan14', source: join(frameDir, files.at(-1)), lastSource: join(frameDir, files[0]), prompt, seed: g.seed + index + 100, width, height, frame: BACK_FRAMES, smooth: 1,
          target: frameDir, startNo: files.length + 1, skip: 1, stage: `Animation: ${animation.name} (back to the start)`, range: part(0.55, 0.7), prefixExtra: `back_${animation.name}`,
        });
        loop = { ...(await packer(ctx, ['--mode', 'loop', '--frames', frameDir, '--count', String(g.frames), '--whole'])), back: true };
      }
      writeFileSync(loopFile, JSON.stringify(loop));
      ctx.log(`Animation ${animation.name}: loop of ${loop.length} frames of ${loop.frames}, closing difference ${loop.closure}`);
    }
    const graphs = [];
    for (const [i, name] of loop.files.entries()) {
      const picture = await ctx.comfy.load(join(frameDir, name), `panel_${ctx.job.id}_${names[i]}.png`);
      graphs.push(ctx.mod.cutoutJob({ picture, prefix: `panel/${ctx.job.id}/cutout_${names[i]}` }));
    }
    const { job, match } = merge(graphs);
    const outputs = await ctx.runComfy(job, { stage: `Removing the backgrounds (${animation.name})`, range: part(0.7, 1) });
    for (const [i, n] of names.entries()) await saveFirst(ctx, images(outputs, match[i][nodes(graphs[i], 'SaveImage')[0]]), join(folder, `cutout_${n}.png`), `the cut-out ${n}`);
    rmSync(frameDir, { recursive: true, force: true });
  }
  if (!existsSync(sheet)) {
    const fps = Math.round((g.frames / (loop.length / ANIMATION.fps)) * 10) / 10;
    await packer(ctx, ['--folder', folder, '--cell', String(g.cell), '--anchor', g.kind === 'object' ? 'center' : 'bottom', '--prefix', `${animation.name}_`, ...pixelArgs(g), '--union', '--fps', String(fps), '--columns', '6', '--names', ...names]);
  }
  return [
    { file: `${animation.name}_sheet.png`, type: 'image', atlas: `${animation.name}_atlas.json`, archive: `${animation.name}_sprites.zip`, animation: animation.name, sprites: names.length, cell: g.cell, loop: loop.length, seed: g.seed },
    { file: `${animation.name}_animation.webp`, type: 'image', animation: animation.name, seed: g.seed },
  ];
}

export async function run(ctx) {
  const g = ctx.job.input;
  if (g.kind === 'tile') {
    await runTiles(ctx);
    return;
  }
  const folder = ctx.folder;
  const startedAt = Date.now();
  const hasAnimations = g.animations.length > 0;
  // the share of the progress bar: base 0-25, poses to 55, cut-outs to 65, animations to 95 (without them the stages stretch)
  const range = (a, b, c) => (hasAnimations ? [a, b] : [a, c ?? b]);

  // 1. the base picture
  const base = join(folder, 'base.png');
  if (!existsSync(base) && !['.jpg', '.jpeg', '.webp'].some((e) => existsSync(join(folder, `base${e}`)))) {
    if (g.source) {
      const from = sourcePath(ctx.setting.outputRoot, g.source);
      copyFileSync(from, extname(from).toLowerCase() === '.png' ? base : join(folder, `base${extname(from).toLowerCase()}`));
    } else {
      await draw(ctx, { count: 1, prefix: 'base', suffix: BASE_SUFFIX[g.kind], stage: 'Drawing the first picture', range: range(0, 15, 25), files: [base] });
    }
  }
  const baseFile = existsSync(base) ? base : ['.jpg', '.jpeg', '.webp'].map((e) => join(folder, `base${e}`)).find(existsSync);
  if (!baseFile) throw new Error('The first picture is missing.');

  // 2. the poses (one request: the models load once)
  const todo = g.poses.filter((p) => !existsSync(join(folder, `pose_${p.name}.png`)));
  if (todo.length) {
    const picture = await ctx.comfy.load(baseFile, `panel_${ctx.job.id}_base${extname(baseFile).toLowerCase()}`);
    const graphs = [];
    for (const [i, p] of todo.entries()) {
      const instruction = await jobPrompt(ctx, p.description, 'edit', { field: `pose_${p.name}`, translate: g.translate !== false });
      const prompt = `The same ${g.kind} as in image 1, ${instruction}. Keep exactly the same design, colours, clothing or parts and the same art style${g.style ? ` (${STYLES[g.style]})` : ''}. Plain solid light grey background, no ground, no cast shadow, nothing else in the picture.`;
      graphs.push(ctx.mod.editJob({ pictures: [picture], text: prompt, seed: g.seed + i, prefix: `panel/${ctx.job.id}/pose_${p.name}` }));
    }
    ctx.job.modelFiles = modelFiles(graphs[0]);
    const { job, match } = merge(graphs);
    const t = Date.now();
    const outputs = await ctx.runComfy(job, { stage: `Poses (${todo.length})`, range: hasAnimations ? [g.source ? 0 : 15, 50] : [g.source ? 0 : 25, 80] });
    for (const [i, p] of todo.entries()) await saveFirst(ctx, images(outputs, match[i][nodes(graphs[i], 'SaveImage')[0]]), join(folder, `pose_${p.name}.png`), `the pose ${p.name}`);
    ctx.measure('edit', (Date.now() - t) / 1000 / todo.length);
  }

  // 3. the cut-outs
  const names = ['base', ...g.poses.map((p) => p.name)];
  const files = { base: baseFile, ...Object.fromEntries(g.poses.map((p) => [p.name, join(folder, `pose_${p.name}.png`)])) };
  const missing = names.filter((n) => !existsSync(join(folder, `cutout_${n}.png`)));
  if (missing.length) {
    const graphs = [];
    for (const n of missing) {
      const picture = await ctx.comfy.load(files[n], `panel_${ctx.job.id}_${n}${extname(files[n]).toLowerCase()}`);
      graphs.push(ctx.mod.cutoutJob({ picture, prefix: `panel/${ctx.job.id}/cutout_${n}` }));
    }
    const { job, match } = merge(graphs);
    const outputs = await ctx.runComfy(job, { stage: 'Removing the backgrounds', range: hasAnimations ? [50, 58] : [80, 93] });
    for (const [i, n] of missing.entries()) await saveFirst(ctx, images(outputs, match[i][nodes(graphs[i], 'SaveImage')[0]]), join(folder, `cutout_${n}.png`), `the cut-out ${n}`);
  }

  // 4. sprites, sheet, atlas
  ctx.progress({ stage: 'Packing the sprite sheet', percent: hasAnimations ? 60 : 94 });
  await packer(ctx, ['--folder', folder, '--cell', String(g.cell), '--anchor', g.kind === 'object' ? 'center' : 'bottom', ...pixelArgs(g), '--names', ...names]);
  const outputs = [{ file: 'sheet.png', type: 'image', main: true, atlas: 'atlas.json', archive: 'sprites.zip', sprites: names.length, cell: g.cell, seed: g.seed }];
  for (const n of names) outputs.push({ file: `sprite_${n}.png`, type: 'image', sprite: n, seed: g.seed });

  // 5. the animations
  for (const [i, animation] of g.animations.entries()) outputs.push(...(await runAnimation(ctx, animation, baseFile, i)));
  ctx.addOutputs(outputs);
  ctx.log(`${names.length} sprites${hasAnimations ? `, ${g.animations.length} animation(s)` : ''} ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
}
