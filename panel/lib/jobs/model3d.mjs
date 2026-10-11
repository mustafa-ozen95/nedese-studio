/**
 * 3D model: a textured 3D model (TRELLIS.2 / Pixal3D, tools\comfy.mjs trellis2Job; MIT) from one input (user 11.10.2026:
 * no tabs, a photo, a 3D model or a description in the same place):
 * - an image is modeled as it is; with a description Qwen-Image-Edit first changes the image as described;
 * - a 3D model file (GLB, FBX, OBJ, STL, PLY; read by Blender) without a description is only converted (the GLB the
 *   viewer shows and the exports); with one the description is an edit of it ("3d girdi verilirse düzenleme promtu
 *   olur"): Blender pictures it from the front, Qwen-Image-Edit changes that picture and the model is made again;
 * - a description alone: the image model first draws the subject whole on a plain background.
 * The output is a GLB (PBR textures). With Blender (lib/blender.mjs) also a turntable video and exports: FBX
 * (textures embedded), OBJ (ZIP: OBJ + MTL + textures) and STL, a solid print copy printHeight mm tall.
 * TRELLIS models only what the image shows (a portrait cut at the chest -> a bust). complete: Qwen-Image-Edit first
 * draws the person or object whole, looking the same, on a plain background; the model is made from that image.
 * game: low-poly copies for game engines made in the same ComfyUI run (GAME): the dense mesh decimated, unwrapped
 * again, its detail baked into a normal map (game.glb and a lighter LOD, game-lod1.glb; game.fbx with FBX).
 */
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { images } from '../comfy-client.mjs';
import { modelFiles, nodes } from '../graph.mjs';
import { framesToMp4, makePreview } from '../ffmpeg.mjs';
import { blenderPresentation } from '../blender.mjs';
import { UserError } from '../errors.mjs';
import { UPLOAD_FOLDER } from '../settings.mjs';
import { jobPrompt } from '../prompt-translate.mjs';
import { yes, sourcePath, normalizeSource, text, number, choice, seed, generatorRequired, IMAGE_MODELS, RATIOS } from './common.mjs';

export const name = '3D model';
export const MODEL_EXTENSIONS = ['.glb', '.fbx', '.obj', '.stl', '.ply'];
export const FORMATS = ['fbx', 'obj', 'stl'];
// mode: trellis (TRELLIS.2) | pixal (Pixal3D); detail: shape upscale (colour detail follows it); mesh: remesh grid;
// surface: target triangles; texture: texture edge. Measured 04.10.2026 (a full-body fisherman, RTX 5070): TRELLIS
// 1024 80 s (blurred face), 1536 113 s / 8.5 GB, 2048 162 s (little gain); Pixal3D 2048 184 s / 8.4 GB: face,
// wrinkles and mesh detail clearly the best -> high (the default).
export const QUALITY = {
  fast: { mode: 'trellis', detail: 1536, mesh: 768, surface: 500000, texture: 4096 },
  high: { mode: 'pixal', detail: 2048, mesh: 1024, surface: 1000000, texture: 4096 },
};
const MODEL_NAME = { trellis: 'TRELLIS.2', pixal: 'Pixal3D' };
// The game copies (user 11.10.2026: "3d alanımız oyunlar için asset üretiyo dimi"): a main game mesh and one LOD.
// Measured on a snowy cabin: 30k midpoint ≈ the full model on screen; the LOD needs QEM (midpoint broke it into
// shards) and comes out at ~4.6k triangles (the target is a maximum). Both add ~2 min to the generation.
export const GAME = [
  { file: 'game.glb', surface: 30000, texture: 2048, placement: 'midpoint' },
  { file: 'game-lod1.glb', surface: 8000, texture: 1024, placement: 'qem' },
];
const INTRO = { frames: 120, fps: 30, size: 1024 };
// The front view of a given model (the gallery picture; the picture an edit starts from)
const VIEW_SIZE = 1024;
// Full body: a vertical frame (Qwen-Image-Edit, ~1 MP); it may be an object too, the prompt covers both.
const COMPLETE_SIZE = [832, 1248];
// Arms away from the body, hands open (A-pose): hands and armpits come out much cleaner in 3D from one image.
export const COMPLETE_PROMPT = 'Show the main subject of image 1 complete and whole: if it is a person or creature, as a full-body figure from head to toe (legs and feet visible), standing upright facing the camera in a relaxed A-pose with the arms held slightly away from the body, hands open and relaxed with all fingers clearly visible and separated; if it is an object, the entire object. Centered with empty space around it, on a plain light grey studio background, soft even lighting. Keep exactly the same face, hair, clothing, materials and colors as in image 1.';
// A description alone: one subject drawn whole, the way the 3D generation reads it best
export const DRAW_SUFFIX = 'One single subject shown complete and whole (a person or creature as a full-body figure from head to toe in a relaxed A-pose, arms slightly away from the body), centered with empty space around it, on a plain light grey studio background, soft even lighting, no other objects, no text.';
// The edit of a given model: its front view changed as described, still one whole subject
export const MODEL_EDIT_PROMPT = (instruction) => `Image 1 is a front view of a 3D model. ${instruction}. Keep everything else about it the same and show it whole from the same front view, centered on the same plain light grey background with soft even lighting.`;

/** A 3D model file: "upload/<file>" or "job/<id>/<file>" (a 3D model from the gallery) inside the panel folder. */
export function modelPath(outputRoot, ref) {
  const part = normalizeSource(ref).split('/');
  const safe = (p) => /^[\w.-]+$/.test(p);
  let path = null;
  if (part[0] === 'upload' && part.length === 2 && safe(part[1])) path = join(outputRoot, UPLOAD_FOLDER, part[1]);
  if (part[0] === 'job' && part.length === 3 && part.slice(1).every(safe)) path = join(outputRoot, part[1], part[2]);
  if (!path) throw new UserError('Invalid 3D model file.');
  const full = resolve(path);
  if (!full.startsWith(resolve(outputRoot) + sep)) throw new UserError('The 3D model file is outside the panel folder.');
  if (!MODEL_EXTENSIONS.includes(extname(full).toLowerCase())) throw new UserError(`Unsupported 3D model format (${extname(full) || 'no extension'}); GLB, FBX, OBJ, STL or PLY.`);
  if (!existsSync(full)) throw new UserError('3D model file not found (it may have been deleted).');
  return full;
}

const BLENDER_MISSING = 'not found on this machine (install it from blender.org or give its path with AI_PANEL_BLENDER).';

export function validate(g, { mod, setting }) {
  const source = String(g.source ?? '').trim();
  const prompt = text(g.prompt, 'Description', { required: false, max: 2000 }) || null;
  const kind = !source ? 'text' : MODEL_EXTENSIONS.includes(extname(source).toLowerCase()) ? 'model' : 'image';
  // a model given without a description is only converted: nothing is generated
  const generate = kind !== 'model' || Boolean(prompt);
  const quality = choice(g.quality, 'Quality', Object.keys(QUALITY), 'high');
  if (generate) generatorRequired(mod, 'trellis2Job', `3D model (${MODEL_NAME[QUALITY[quality].mode]})`, setting?.modelRoot, QUALITY[quality]);
  if (!source && !prompt) throw new UserError('Give an image or a 3D model, or describe what to make.');
  if (kind === 'model') {
    modelPath(setting.outputRoot, source);
    if (!setting.blender) throw new UserError(`Blender is required to read a 3D model file; ${BLENDER_MISSING}`);
  }
  if (kind === 'image') sourcePath(setting.outputRoot, source);
  const complete = kind === 'image' && yes(g.complete);
  if (complete || (prompt && kind !== 'text')) generatorRequired(mod, 'editJob', 'Image edit (Qwen-Image-Edit)', setting?.modelRoot);
  // the game copies are baked from the generation's own voxels: a converted file has none
  const game = yes(g.game);
  if (game && !generate) throw new UserError('Game copies are made while generating; a 3D model file without a description is only converted. Describe a change or give an image.');
  // The turntable video is off unless asked for (user 10.10.2026: "3d için video üretmeye gerek olduğunu düşünmüyorum");
  // without Blender the exports are off by default too; asked for explicitly, an error.
  const intro = yes(g.intro);
  const formats = g.formats === undefined ? (setting.blender ? [...FORMATS] : []) : (Array.isArray(g.formats) ? g.formats : String(g.formats).split(',')).map((b) => String(b).trim().toLowerCase()).filter(Boolean);
  for (const b of formats) if (!FORMATS.includes(b)) throw new UserError(`Invalid export format: ${b} (fbx, obj, stl).`);
  if ((intro || formats.length) && !setting.blender) throw new UserError(`Blender is required for the showcase video and FBX/OBJ/STL; ${BLENDER_MISSING}`);
  return {
    source: source || null,
    kind,
    prompt,
    ...(kind === 'text' ? { draw: drawModel(g, { mod, setting }) } : {}),
    // the description goes to the image models in English (Qwen-Image does not understand Turkish, 10.10.2026)
    translate: g.translate === undefined ? true : yes(g.translate),
    title: text(g.title, 'Title', { required: false, max: 120 }),
    quality,
    deleteBackPlan: g.deleteBackPlan === undefined ? true : yes(g.deleteBackPlan),
    complete,
    game,
    intro,
    formats: [...new Set(formats)],
    printHeight: number(g.printHeight, 'Print height (mm)', { min: 10, max: 1000, defaultValue: 100 }),
    seed: seed(g.seed),
  };
}

/** The image model that draws a description: Qwen-Image like the video, FLUX.2 klein when it is not on this machine. */
function drawModel(g, { mod, setting }) {
  let imageModel = g.imageModel ? choice(g.imageModel, 'Image model', Object.keys(IMAGE_MODELS), 'qwen') : null;
  if (!imageModel) {
    try {
      generatorRequired(mod, IMAGE_MODELS.qwen.generator, IMAGE_MODELS.qwen.name, setting?.modelRoot);
      imageModel = 'qwen';
    } catch {
      imageModel = 'flux';
    }
  }
  generatorRequired(mod, IMAGE_MODELS[imageModel].generator, IMAGE_MODELS[imageModel].name, setting?.modelRoot);
  const [width, height] = RATIOS['1:1'][imageModel];
  return { imageModel, width, height };
}

export function summary(g) {
  const generate = g.kind !== 'model' || g.prompt;
  const parts = generate ? [MODEL_NAME[QUALITY[g.quality].mode], g.quality === 'high' ? 'high quality' : 'fast'] : ['converted'];
  if (g.kind === 'text') parts.push('from a description');
  else if (g.prompt) parts.push(g.kind === 'model' ? 'model edited' : 'image edited');
  if (g.complete) parts.push('full body');
  if (g.game) parts.push('game copies');
  if (g.intro) parts.push('turntable video');
  if (g.formats.length) parts.push(g.formats.map((b) => b.toUpperCase()).join('/'));
  if (g.formats.includes('stl')) parts.push(`print ${g.printHeight ?? 100} mm`);
  return { title: g.title || (g.prompt ? g.prompt.slice(0, 120) : '3D model'), detail: parts.join(' · ') };
}

/** Qwen-Image-Edit on one picture (target is written once; a retried job does not edit again). */
async function editPicture(ctx, { input, target, prompt, stage, range, size = null }) {
  if (existsSync(target)) return;
  const picture = await ctx.comfy.load(input, `panel_${ctx.job.id}_${Date.now().toString(36)}${extname(input).toLowerCase() || '.png'}`);
  const graph = ctx.mod.editJob({ pictures: [picture], text: prompt, seed: ctx.job.input.seed, prefix: `panel/${ctx.job.id}/${target.split(/[\\/]/).pop().replace(/\.png$/, '')}`, ...(size ? { width: size[0], height: size[1] } : {}) });
  const startedAt = Date.now();
  const list = images(await ctx.runComfy(graph, { stage, range }), nodes(graph, 'SaveImage')[0]);
  if (!list.length) throw new Error('ComfyUI did not return the edited image.');
  await ctx.comfy.getOutput(list[0], `${target}.temp.png`);
  renameSync(`${target}.temp.png`, target);
  ctx.measure('edit', (Date.now() - startedAt) / 1000);
  ctx.log(`${stage}: ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
}

/** A description alone: the subject drawn whole on a plain background (drawn.png). */
async function drawPicture(ctx, target) {
  if (existsSync(target)) return;
  const g = ctx.job.input;
  const startedAt = Date.now();
  const prompt = await jobPrompt(ctx, g.prompt, 'image', { translate: g.translate !== false });
  const graph = ctx.mod[IMAGE_MODELS[g.draw.imageModel].generator]({ text: `${prompt}. ${DRAW_SUFFIX}`, seed: g.seed, width: g.draw.width, height: g.draw.height, prefix: `panel/${ctx.job.id}/drawn` });
  const list = images(await ctx.runComfy(graph, { stage: 'Drawing the subject', range: [0, 15] }), nodes(graph, 'SaveImage')[0]);
  if (!list.length) throw new Error('The subject could not be drawn (the image model returned no image).');
  await ctx.comfy.getOutput(list[0], `${target}.temp.png`);
  renameSync(`${target}.temp.png`, target);
  ctx.measure(`image/${g.draw.imageModel}`, (Date.now() - startedAt) / 1000);
  ctx.log(`Subject drawn with ${IMAGE_MODELS[g.draw.imageModel].name} (${Math.round((Date.now() - startedAt) / 1000)} s).`);
}

/** A gallery preview (JPEG) of a picture in the job folder; null when it cannot be made. */
async function preview(ctx, file) {
  const name = file.replace(/\.png$/, '.preview.jpg');
  try {
    await makePreview(ctx.setting.ffmpeg, file, name, { cwd: ctx.folder, signal: ctx.signal });
    return name;
  } catch (e) {
    ctx.log(`Could not make a preview: ${e.message}`);
    return null;
  }
}

export async function run(ctx) {
  const g = ctx.job.input;
  const k = ctx.folder;
  const glb = join(k, 'model.glb');
  const blenderScript = join(ctx.setting.aiRoot, 'tools', 'blender', 'model3d.py');
  const lastPercent = g.intro || g.formats.length ? 80 : 97;

  // A model given without a description: Blender converts it (the GLB, the exports, its front view for the gallery).
  if (g.kind === 'model' && !g.prompt) {
    const startedAt = Date.now();
    ctx.progress({ percent: 5, stage: 'Blender: reading the model', detail: '' });
    const input = modelPath(ctx.setting.outputRoot, g.source);
    const result = await blenderPresentation(ctx.setting.blender, {
      script: blenderScript, input, output: k, name: 'model', frames: g.intro ? INTRO.frames : 0, size: INTRO.size,
      formats: ['glb', ...g.formats], printHeight: g.printHeight ?? 100, view: join(k, 'view.png'), signal: ctx.signal,
      progress: (ratio) => ctx.progress({ percent: 10 + 85 * ratio, detail: `Frame ${Math.round(ratio * INTRO.frames)}/${INTRO.frames}` }),
    });
    ctx.log(`Blender ${result.blender}: ${result.triangles} triangles, ${(Date.now() - startedAt) / 1000 | 0} s`);
    if (!existsSync(glb) && extname(input).toLowerCase() === '.glb') copyFileSync(input, glb);
    await finish(ctx, result, existsSync(join(k, 'view.png')) ? await preview(ctx, 'view.png') : null, startedAt);
    return;
  }

  // The picture the model is made from.
  let source;
  if (g.kind === 'text') {
    source = join(k, 'drawn.png');
    if (!existsSync(glb)) await drawPicture(ctx, source);
  } else if (g.kind === 'model') {
    // an edit of a model: its front view, changed as described
    source = join(k, 'view.png');
    if (!existsSync(source) && !existsSync(glb)) {
      ctx.progress({ percent: 1, stage: 'Blender: picturing the model', detail: '' });
      await blenderPresentation(ctx.setting.blender, { script: blenderScript, input: modelPath(ctx.setting.outputRoot, g.source), output: k, name: 'source', frames: 0, size: VIEW_SIZE, formats: [], view: source, signal: ctx.signal });
    }
  } else {
    source = sourcePath(ctx.setting.outputRoot, g.source);
  }
  if (g.prompt && g.kind !== 'text') {
    const edited = join(k, 'edited.png');
    if (!existsSync(glb)) {
      const instruction = await jobPrompt(ctx, g.prompt, 'edit', { translate: g.translate !== false });
      await editPicture(ctx, { input: source, target: edited, prompt: g.kind === 'model' ? MODEL_EDIT_PROMPT(instruction.replace(/[.\s]+$/, '')) : instruction, stage: g.kind === 'model' ? 'Editing the model' : 'Editing the image', range: [3, 15] });
    }
    if (existsSync(edited)) source = edited;
  }

  // Full-body completion (when asked): Qwen-Image-Edit, the source only as a reference.
  if (g.complete) {
    const full = join(k, 'full-size.png');
    if (!existsSync(glb)) await editPicture(ctx, { input: source, target: full, prompt: COMPLETE_PROMPT, stage: 'Completing to full body', range: [g.prompt ? 15 : 0, 20], size: COMPLETE_SIZE });
    if (existsSync(full)) source = full;
  }

  // 1) TRELLIS.2: the GLB (a retried job does not make a finished model again).
  if (!existsSync(glb)) {
    const picture = await ctx.comfy.load(source, `panel_${ctx.job.id}_3d${extname(source).toLowerCase() || '.png'}`);
    const prefix = `panel/${ctx.job.id}/model`;
    const graph = ctx.mod.trellis2Job({ picture, seed: g.seed, prefix, deleteBackPlan: g.deleteBackPlan, ...QUALITY[g.quality], game: g.game ? GAME : [] });
    ctx.job.modelFiles = modelFiles(graph);
    const saved = (name) => Object.keys(graph).find((id) => graph[id].class_type === 'SaveGLB' && graph[id].inputs.filename_prefix === name);
    const record = saved(prefix);
    const inputRecord = Object.keys(graph).find((id) => graph[id].class_type === 'SaveImage');
    const startedAt = Date.now();
    const outputs = await ctx.runComfy(graph, { stage: 'Generating the 3D model', range: [g.complete || g.prompt || g.kind === 'text' ? 20 : 2, lastPercent] });
    const model = outputs?.[record]?.['3d']?.[0];
    if (!model) throw new Error('ComfyUI did not return the 3D model.');
    const input = inputRecord && images(outputs, inputRecord)[0];
    if (input) await ctx.comfy.getOutput(input, join(k, 'input.png'));
    // the game copies before model.glb: a retried job that finds model.glb has them too
    if (g.game) {
      for (const [i, level] of GAME.entries()) {
        const copy = outputs?.[saved(`${prefix}_game${i}`)]?.['3d']?.[0];
        if (!copy) throw new Error('ComfyUI did not return the game copy of the 3D model.');
        await ctx.comfy.getOutput(copy, join(k, level.file));
      }
    }
    await ctx.comfy.getOutput(model, glb);
    const duration = (Date.now() - startedAt) / 1000;
    ctx.measure(`model3d/${g.quality}`, duration);
    ctx.log(`3D model ${duration.toFixed(0)} s`);
  }
  const picture = existsSync(join(k, 'input.png')) ? await preview(ctx, 'input.png') : null;

  // 2) Blender: exports + turntable frames; the video with the panel's ffmpeg.
  let result = null;
  const startedAt = Date.now();
  if (g.intro || g.formats.length) {
    ctx.progress({ percent: lastPercent, stage: g.intro ? 'Blender: turntable video' : 'Blender: export', detail: '' });
    result = await blenderPresentation(ctx.setting.blender, {
      script: blenderScript, input: glb, output: k, name: 'model', frames: g.intro ? INTRO.frames : 0, size: INTRO.size,
      formats: g.formats, printHeight: g.printHeight ?? 100, signal: ctx.signal,
      progress: (ratio) => ctx.progress({ percent: lastPercent + (97 - lastPercent) * ratio * 0.9, detail: `Frame ${Math.round(ratio * INTRO.frames)}/${INTRO.frames}` }),
    });
    ctx.log(`Blender ${result.blender}: ${result.triangles} triangles, ${(Date.now() - startedAt) / 1000 | 0} s`);
  }
  // the game copies: their triangle counts and, with FBX, an FBX of each (game engines import FBX first)
  const game = [];
  if (g.game) {
    for (const [i, level] of GAME.entries()) {
      const output = { file: level.file, type: 'model', format: 'glb', game: { lod: i, triangles: level.surface, texture: level.texture } };
      if (ctx.setting.blender) {
        ctx.progress({ percent: 97, stage: 'Blender: game copies', detail: level.file });
        const name = level.file.replace(/\.glb$/, '');
        const copy = await blenderPresentation(ctx.setting.blender, { script: blenderScript, input: join(k, level.file), output: k, name, frames: 0, formats: g.formats.includes('fbx') ? ['fbx'] : [], signal: ctx.signal });
        output.game.triangles = copy.triangles;
        game.push(output);
        if (copy.files?.fbx) game.push({ file: copy.files.fbx, type: 'model', format: 'fbx', game: { ...output.game } });
      } else {
        game.push(output);
      }
    }
    ctx.log(`Game copies: ${game.filter((c) => c.format === 'glb').map((c) => `${c.file} ${c.game.triangles} triangles`).join(', ')}`);
  }
  await finish(ctx, result, picture, startedAt, game);
}

/** The outputs: the GLB (main unless there is a turntable), the exports and the turntable video. */
async function finish(ctx, result, picture, startedAt, game = []) {
  const g = ctx.job.input;
  const k = ctx.folder;
  const outputs = [{ file: 'model.glb', type: 'model', format: 'glb', main: !g.intro, preview: picture }];
  if (result) {
    const files = result.files ?? {};
    const print = result.print;
    if (print) ctx.log(`Print copy: ${print.size.join(' × ')} mm, ${print.volume} cm³, ${print.triangles} triangles, ${print.watertight ? 'watertight' : `${print.openEdges} open edges`}${print.solid ? '' : ', hollow inside (Blender has no OpenVDB module)'}`);
    for (const b of g.formats) {
      if (!files[b]) continue;
      const output = { file: files[b], type: 'model', format: b };
      if (b === 'stl' && print) Object.assign(output, { print: { height: print.height, size: print.size, volume: print.volume, watertight: print.watertight, solid: print.solid } });
      outputs.push(output);
    }
    outputs[0].triangle = result.triangles;
    if (g.intro) {
      await framesToMp4(ctx.setting.ffmpeg, { cwd: k, pattern: 'frames/%04d.png', fps: INTRO.fps, output: 'turntable.mp4', ready: ctx.setting.x264Ready, signal: ctx.signal });
      rmSync(join(k, 'frames'), { recursive: true, force: true });
      const vPreview = 'turntable.preview.jpg';
      await makePreview(ctx.setting.ffmpeg, 'turntable.mp4', vPreview, { cwd: k, signal: ctx.signal }).catch(() => {});
      outputs.unshift({ file: 'turntable.mp4', type: 'video', main: true, duration: INTRO.frames / INTRO.fps, preview: existsSync(join(k, vPreview)) ? vPreview : picture, width: INTRO.size, height: INTRO.size });
    }
    ctx.measure('blender3d', (Date.now() - startedAt) / 1000);
  }
  ctx.addOutputs([...outputs, ...game]);
}
