/**
 * Game assets (2D): a character, vehicle or object drawn once, shown in more poses or views with the same design
 * (Qwen-Image-Edit from the first picture), every picture cut out of its background (BiRefNet), trimmed into sprites and
 * packed into a sprite sheet with an atlas (tools\sprites.py).
 * Steps: base picture (drawn from the description, or the given source) -> one edit per pose (one ComfyUI request) ->
 * one cut-out request -> sprites, sheet.png, atlas.json. Files already written are not made again (a retried job resumes).
 */
import { copyFileSync, existsSync, renameSync } from 'node:fs';
import { extname, join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { merge, nodes, modelFiles } from '../graph.mjs';
import { UserError } from '../errors.mjs';
import { run as runProcess } from '../process.mjs';
import { jobPrompt } from '../prompt-translate.mjs';
import { IMAGE_MODELS, RATIOS, text, number, choice, seed, yes, sourcePath, generatorRequired } from './common.mjs';

export const name = 'Game assets';

const KINDS = ['character', 'vehicle', 'object'];
const MAX_POSES = 12;
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
};

/** "name: description" lines (or a plain description); a list or a text split at line breaks and semicolons. */
export function parsePoses(value, kind) {
  let list = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? value.split(/[\r\n;]+/) : null;
  if (!list) list = DEFAULT_POSES[kind];
  list = list.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!list.length) throw new UserError('Give at least one pose or view.');
  if (list.length > MAX_POSES) throw new UserError(`At most ${MAX_POSES} poses or views.`);
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

export function validate(g, { mod, setting }) {
  const kind = choice(g.kind, 'Kind', KINDS, 'character');
  const source = String(g.source ?? '').trim();
  if (source) sourcePath(setting.outputRoot, source);
  const model = choice(g.imageModel, 'Image model', Object.keys(IMAGE_MODELS), 'qwen');
  if (!source) {
    generatorRequired(mod, IMAGE_MODELS[model].generator, IMAGE_MODELS[model].name, setting?.modelRoot);
    // the description is required when there is no picture to start from
    text(g.prompt, 'Description');
  }
  generatorRequired(mod, 'editJob', 'Image editing', setting?.modelRoot);
  generatorRequired(mod, 'cutoutJob', 'Background removal', setting?.modelRoot);
  const ratio = choice(g.ratio, 'Aspect ratio', Object.keys(RATIOS), '1:1');
  const [width, height] = RATIOS[ratio][model];
  return {
    kind,
    prompt: text(g.prompt, 'Description', { required: !source }),
    source,
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    poses: parsePoses(g.poses, kind),
    imageModel: model,
    ratio,
    width,
    height,
    cell: number(g.cell, 'Cell size', { min: 128, max: 1024, full: true, defaultValue: 512 }),
    translate: yes(g.translate ?? true),
    seed: seed(g.seed),
  };
}

export function summary(g) {
  return { title: g.title || g.prompt || 'Game assets', detail: `${g.kind} · ${g.poses.length + 1} sprites · ${g.cell} px cells` };
}

async function saveFirst(ctx, list, target, what) {
  if (!list.length) throw new Error(`ComfyUI did not return ${what}.`);
  await ctx.comfy.getOutput(list[0], `${target}.temp.png`);
  renameSync(`${target}.temp.png`, target);
}

export async function run(ctx) {
  const g = ctx.job.input;
  const folder = ctx.folder;
  const noun = g.kind;
  const startedAt = Date.now();

  // 1. the base picture
  const base = join(folder, 'base.png');
  if (!existsSync(base)) {
    if (g.source) {
      const from = sourcePath(ctx.setting.outputRoot, g.source);
      if (extname(from).toLowerCase() === '.png') copyFileSync(from, base);
      else {
        // an uploaded JPEG/WebP goes through ComfyUI's loader like the others; keep its extension
        copyFileSync(from, join(folder, `base${extname(from).toLowerCase()}`));
      }
    } else {
      const prompt = await jobPrompt(ctx, g.prompt, 'image', { translate: g.translate !== false });
      const generator = ctx.mod[IMAGE_MODELS[g.imageModel].generator];
      const graph = generator({ text: `${prompt}. ${BASE_SUFFIX[g.kind]}`, seed: g.seed, width: g.width, height: g.height, prefix: `panel/${ctx.job.id}/base` });
      ctx.job.modelFiles = modelFiles(graph);
      const t = Date.now();
      const list = images(await ctx.runComfy(graph, { stage: 'Drawing the first picture', range: [0, 25] }), nodes(graph, 'SaveImage')[0]);
      await saveFirst(ctx, list, base, 'the first picture');
      ctx.measure(`image/${g.imageModel}`, (Date.now() - t) / 1000);
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
      const prompt = `The same ${noun} as in image 1, ${instruction}. Keep exactly the same design, colours, clothing or parts and art style. Plain solid light grey background, no ground, no cast shadow, nothing else in the picture.`;
      graphs.push(ctx.mod.editJob({ pictures: [picture], text: prompt, seed: g.seed + i, prefix: `panel/${ctx.job.id}/pose_${p.name}` }));
    }
    ctx.job.modelFiles = modelFiles(graphs[0]);
    const { job, match } = merge(graphs);
    const t = Date.now();
    const outputs = await ctx.runComfy(job, { stage: `Poses (${todo.length})`, range: [g.source ? 0 : 25, 80] });
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
    const outputs = await ctx.runComfy(job, { stage: 'Removing the backgrounds', range: [80, 93] });
    for (const [i, n] of missing.entries()) await saveFirst(ctx, images(outputs, match[i][nodes(graphs[i], 'SaveImage')[0]]), join(folder, `cutout_${n}.png`), `the cut-out ${n}`);
  }

  // 4. sprites, sheet, atlas
  ctx.progress({ stage: 'Packing the sprite sheet', percent: 94 });
  const k = ctx.setting.spritesCommand(['--folder', folder, '--cell', String(g.cell), '--anchor', g.kind === 'object' ? 'center' : 'bottom', '--names', ...names]);
  let last = [];
  await runProcess(k.command, k.args, {
    env: k.env,
    cwd: folder,
    signal: ctx.signal,
    name: 'sprites',
    line: (s) => { last = [...last, s].slice(-12); },
  }).catch((e) => {
    const h = last.find((s) => s.startsWith('ERROR:'));
    throw h ? new UserError(`Sprites: ${h.slice(6).trim()}`) : e;
  });

  const outputs = [{ file: 'sheet.png', type: 'image', main: true, atlas: 'atlas.json', sprites: names.length, cell: g.cell, seed: g.seed }];
  for (const n of names) outputs.push({ file: `sprite_${n}.png`, type: 'image', sprite: n, seed: g.seed });
  ctx.addOutputs(outputs);
  ctx.log(`${names.length} sprites ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
}
