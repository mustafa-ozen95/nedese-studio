/**
 * Game assets (2D): a character, vehicle or object drawn once, shown in more poses or views with the same design
 * (Qwen-Image-Edit from the first picture), every picture cut out of its background (BiRefNet), trimmed into sprites and
 * packed into a sprite sheet with an atlas (tools\sprites.py).
 * Steps: base picture (drawn from the description, or the given source) -> one edit per pose (one ComfyUI request) ->
 * one cut-out request -> sprites, sheet.png, atlas.json. Files already written are not made again (a retried job resumes).
 * Animations: the base picture moved by Wan 2.2 from the base picture to the same picture (first = last frame: a loop),
 * evenly spaced frames cut out and packed as their own sheet with an animated preview.
 * Kind "tile": seamless ground/wall textures (drawn variants made tileable by tools\sprites.py).
 */
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
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
const MAX_POSES = 12;
const MAX_ANIMATIONS = 4;
const ANIMATION = { frame: 33, fps: 16, size: 640 };
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
  vehicle: 'One single vehicle shown complete and whole, centered with empty space around it, on a plain solid light grey background, no ground, no cast shadow, no text.',
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

export function parsePoses(value, kind) {
  const list = parseList(value, DEFAULT_POSES[kind] ?? [], MAX_POSES, 'poses or views');
  if (!list.length) throw new UserError('Give at least one pose or view.');
  return list;
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
  if (poses.length) {
    generatorRequired(mod, 'editJob', 'Image editing', setting?.modelRoot);
  }
  if (animations.length) generatorRequired(mod, 'wan14Job', 'Animation (Wan 2.2 A14B)', setting?.modelRoot);
  if (kind !== 'tile') generatorRequired(mod, 'cutoutJob', 'Background removal', setting?.modelRoot);
  const ratio = kind === 'tile' ? '1:1' : choice(g.ratio, 'Aspect ratio', Object.keys(RATIOS), '1:1');
  const [width, height] = RATIOS[ratio][model];
  return {
    kind,
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
  await runProcess(k.command, k.args, {
    env: k.env,
    cwd: ctx.folder,
    signal: ctx.signal,
    name: 'sprites',
    line: (s) => { last = [...last, s].slice(-12); },
  }).catch((e) => {
    const h = last.find((s) => s.startsWith('ERROR:'));
    throw h ? new UserError(`Sprites: ${h.slice(6).trim()}`) : e;
  });
}

/** The first picture(s) drawn from the description: one request, `count` different seeds. */
async function draw(ctx, { count, prefix, suffix, stage, range, files }) {
  const g = ctx.job.input;
  const prompt = await jobPrompt(ctx, g.prompt, 'image', { translate: g.translate !== false });
  const generator = ctx.mod[IMAGE_MODELS[g.imageModel].generator];
  const written = g.lora?.trigger && !prompt.toLowerCase().includes(g.lora.trigger.toLowerCase()) ? `${g.lora.trigger}, ${prompt}` : prompt;
  const graphs = Array.from({ length: count }, (_, i) => {
    const graph = generator({ text: `${written}. ${suffix}`, seed: g.seed + i, width: g.width, height: g.height, prefix: `panel/${ctx.job.id}/${prefix}${i + 1}` });
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

/** One animation: Wan from the base picture back to itself, the frames cut out and packed as <name>_sheet.png. */
async function runAnimation(ctx, animation, baseFile, index) {
  const g = ctx.job.input;
  const folder = ctx.folder;
  const sheet = join(folder, `${animation.name}_sheet.png`);
  const names = Array.from({ length: g.frames }, (_, i) => `${animation.name}-${String(i + 1).padStart(2, '0')}`);
  const frameDir = join(folder, `frames_${animation.name}`);
  const size = imageSize(baseFile) ?? { width: 1, height: 1 };
  const [width, height] = animationSize(size.width, size.height);
  const total = ANIMATION.frame;
  if (!names.every((n) => existsSync(join(folder, `cutout_${n}.png`)))) {
    if (!existsSync(frameDir) || readdirSync(frameDir).length < total) {
      rmSync(frameDir, { recursive: true, force: true });
      const instruction = await jobPrompt(ctx, animation.description, 'video', { field: `animation_${animation.name}`, translate: g.translate !== false });
      const prompt = `The ${g.kind} ${instruction}. It stays in the same place with a static camera, on the same plain light grey background, no ground, no cast shadow, smooth looping motion.`;
      await runWan(ctx, {
        model: 'wan14', source: baseFile, lastSource: baseFile, prompt, seed: g.seed + index, width, height, frame: total, smooth: 1,
        target: frameDir, stage: `Animation: ${animation.name}`, range: [0, 60], prefixExtra: `anim_${animation.name}`,
      });
    }
    const frames = readdirSync(frameDir).filter((f) => f.endsWith('.png')).sort();
    const picked = pickFrames(frames.length, g.frames).map((i) => join(frameDir, frames[i]));
    const graphs = [];
    for (const [i, file] of picked.entries()) {
      const picture = await ctx.comfy.load(file, `panel_${ctx.job.id}_${names[i]}.png`);
      graphs.push(ctx.mod.cutoutJob({ picture, prefix: `panel/${ctx.job.id}/cutout_${names[i]}` }));
    }
    const { job, match } = merge(graphs);
    const outputs = await ctx.runComfy(job, { stage: `Removing the backgrounds (${animation.name})`, range: [60, 90] });
    for (const [i, n] of names.entries()) await saveFirst(ctx, images(outputs, match[i][nodes(graphs[i], 'SaveImage')[0]]), join(folder, `cutout_${n}.png`), `the cut-out ${n}`);
    rmSync(frameDir, { recursive: true, force: true });
  }
  if (!existsSync(sheet)) {
    const fps = Math.round((g.frames / ((total - 1) / ANIMATION.fps)) * 10) / 10;
    await packer(ctx, ['--folder', folder, '--cell', String(g.cell), '--anchor', g.kind === 'object' ? 'center' : 'bottom', '--prefix', `${animation.name}_`, '--union', '--fps', String(fps), '--columns', '6', '--names', ...names]);
  }
  return [
    { file: `${animation.name}_sheet.png`, type: 'image', atlas: `${animation.name}_atlas.json`, archive: `${animation.name}_sprites.zip`, animation: animation.name, sprites: names.length, cell: g.cell, seed: g.seed },
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
      const prompt = `The same ${g.kind} as in image 1, ${instruction}. Keep exactly the same design, colours, clothing or parts and art style. Plain solid light grey background, no ground, no cast shadow, nothing else in the picture.`;
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
  await packer(ctx, ['--folder', folder, '--cell', String(g.cell), '--anchor', g.kind === 'object' ? 'center' : 'bottom', '--names', ...names]);
  const outputs = [{ file: 'sheet.png', type: 'image', main: true, atlas: 'atlas.json', archive: 'sprites.zip', sprites: names.length, cell: g.cell, seed: g.seed }];
  for (const n of names) outputs.push({ file: `sprite_${n}.png`, type: 'image', sprite: n, seed: g.seed });

  // 5. the animations
  for (const [i, animation] of g.animations.entries()) outputs.push(...(await runAnimation(ctx, animation, baseFile, i)));
  ctx.addOutputs(outputs);
  ctx.log(`${names.length} sprites${hasAnimations ? `, ${g.animations.length} animation(s)` : ''} ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
}
