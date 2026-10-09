/**
 * 3D model: a textured 3D model from an image (or a frame chosen from a video), TRELLIS.2 (tools\comfy.mjs trellis2Job;
 * MIT). The output is a GLB (PBR textures). With Blender (lib/blender.mjs) also a turntable video and exports: FBX
 * (textures embedded), OBJ (ZIP: OBJ + MTL + textures) and STL, a solid print copy printHeight mm tall.
 * From a video: the frame at the given second is taken with ffmpeg, the rest is as with an image.
 * TRELLIS models only what the image shows (a portrait cut at the chest -> a bust). complete: Qwen-Image-Edit first
 * draws the person or object whole, looking the same, on a plain background; the model is made from that image.
 */
import { existsSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { modelFiles } from '../graph.mjs';
import { runFfmpeg, framesToMp4, makePreview } from '../ffmpeg.mjs';
import { blenderPresentation } from '../blender.mjs';
import { UserError } from '../errors.mjs';
import { recordPath } from './clone.mjs';
import { yes, sourcePath, text, number, choice, seed, generatorRequired } from './common.mjs';

export const name = '3D model';
const VIDEO_EXTENSION = /\.(mp4|mov|mkv|webm|avi|m4v|3gp)$/i;
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
const INTRO = { frames: 120, fps: 30, size: 1024 };
// Full body: a vertical frame (Qwen-Image-Edit, ~1 MP); it may be an object too, the prompt covers both.
const COMPLETE_SIZE = [832, 1248];
// Arms away from the body, hands open (A-pose): hands and armpits come out much cleaner in 3D from one image.
export const COMPLETE_PROMPT = 'Show the main subject of image 1 complete and whole: if it is a person or creature, as a full-body figure from head to toe (legs and feet visible), standing upright facing the camera in a relaxed A-pose with the arms held slightly away from the body, hands open and relaxed with all fingers clearly visible and separated; if it is an object, the entire object. Centered with empty space around it, on a plain light grey studio background, soft even lighting. Keep exactly the same face, hair, clothing, materials and colors as in image 1.';

export function validate(g, { mod, setting }) {
  generatorRequired(mod, 'trellis2Job', '3D model (TRELLIS.2 / Pixal3D)', setting?.modelRoot);
  const complete = yes(g.complete);
  if (complete) generatorRequired(mod, 'editJob', 'Full-body completion (Qwen-Image-Edit)', setting?.modelRoot);
  const source = String(g.source ?? '').trim();
  if (!source) throw new UserError('Choose an image or a video.');
  const video = VIDEO_EXTENSION.test(source);
  if (video) recordPath(setting.outputRoot, source);
  else sourcePath(setting.outputRoot, source);
  // Without Blender the turntable and the exports are off by default; asked for explicitly, an error.
  const intro = g.intro === undefined ? Boolean(setting.blender) : yes(g.intro);
  const formats = g.formats === undefined ? (setting.blender ? [...FORMATS] : []) : (Array.isArray(g.formats) ? g.formats : String(g.formats).split(',')).map((b) => String(b).trim().toLowerCase()).filter(Boolean);
  for (const b of formats) if (!FORMATS.includes(b)) throw new UserError(`Invalid export format: ${b} (fbx, obj, stl).`);
  if ((intro || formats.length) && !setting.blender) throw new UserError('Blender is required for the showcase video and FBX/OBJ/STL; not found on this machine (install it from blender.org or give its path with AI_PANEL_BLENDER).');
  return {
    source,
    time: video ? number(g.time, 'Frame time (s)', { min: 0, max: 36000, defaultValue: 0 }) : null,
    title: text(g.title, 'Title', { required: false, max: 120 }),
    quality: choice(g.quality, 'Quality', Object.keys(QUALITY), 'high'),
    deleteBackPlan: g.deleteBackPlan === undefined ? true : yes(g.deleteBackPlan),
    complete,
    intro,
    formats: [...new Set(formats)],
    printHeight: number(g.printHeight, 'Print height (mm)', { min: 10, max: 1000, defaultValue: 100 }),
    seed: seed(g.seed),
  };
}

export function summary(g) {
  const parts = [MODEL_NAME[QUALITY[g.quality].mode], g.quality === 'high' ? 'high quality' : 'fast'];
  if (g.time !== null) parts.push(`second ${g.time} of the video`);
  if (g.complete) parts.push('full body');
  if (g.intro) parts.push('turntable video');
  if (g.formats.length) parts.push(g.formats.map((b) => b.toUpperCase()).join('/'));
  if (g.formats.includes('stl')) parts.push(`print ${g.printHeight ?? 100} mm`);
  return { title: g.title || '3D model', detail: parts.join(' · ') };
}

export async function run(ctx) {
  const g = ctx.job.input;
  const k = ctx.folder;

  // The source image: the frame chosen from the video or the given image.
  let source;
  if (g.time !== null) {
    source = join(k, 'frame.png');
    if (!existsSync(source)) {
      ctx.progress({ percent: 0, stage: 'Grabbing the frame from the video' });
      await runFfmpeg(ctx.setting.ffmpeg, ['-y', '-ss', String(g.time), '-i', recordPath(ctx.setting.outputRoot, g.source), '-frames:v', '1', 'frame.png'], { cwd: k, signal: ctx.signal });
      if (!existsSync(source)) throw new UserError(`No frame at second ${g.time} of the video (the video may be shorter).`);
      ctx.log(`Frame grabbed: ${g.time} s`);
    }
  } else {
    source = sourcePath(ctx.setting.outputRoot, g.source);
  }

  // Full-body completion (when asked): Qwen-Image-Edit, the source only as a reference.
  if (g.complete) {
    const full = join(k, 'full-size.png');
    if (!existsSync(full) && !existsSync(join(k, 'model.glb'))) {
      const picture = await ctx.comfy.load(source, `panel_${ctx.job.id}_complete${extname(source).toLowerCase() || '.png'}`);
      const graph = ctx.mod.editJob({ pictures: [picture], text: COMPLETE_PROMPT, seed: g.seed, prefix: `panel/${ctx.job.id}/full-size`, width: COMPLETE_SIZE[0], height: COMPLETE_SIZE[1] });
      const record = Object.keys(graph).find((id) => graph[id].class_type === 'SaveImage');
      const startedAt = Date.now();
      const c = await ctx.runComfy(graph, { stage: 'Completing to full body', range: [0, 15] });
      const list = images(c, record);
      if (!list.length) throw new Error('ComfyUI did not return the full-body image.');
      await ctx.comfy.getOutput(list[0], full);
      ctx.measure('edit', (Date.now() - startedAt) / 1000);
      ctx.log(`Full-body image ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
    }
    if (existsSync(full)) source = full;
  }

  // 1) TRELLIS.2: the GLB (a retried job does not make a finished model again).
  const glb = join(k, 'model.glb');
  const lastPercent = g.intro || g.formats.length ? 80 : 97;
  if (!existsSync(glb)) {
    const picture = await ctx.comfy.load(source, `panel_${ctx.job.id}_3d${extname(source).toLowerCase() || '.png'}`);
    const graph = ctx.mod.trellis2Job({ picture, seed: g.seed, prefix: `panel/${ctx.job.id}/model`, deleteBackPlan: g.deleteBackPlan, ...QUALITY[g.quality] });
    ctx.job.modelFiles = modelFiles(graph);
    const record = Object.keys(graph).find((id) => graph[id].class_type === 'SaveGLB');
    const inputRecord = Object.keys(graph).find((id) => graph[id].class_type === 'SaveImage');
    const startedAt = Date.now();
    const outputs = await ctx.runComfy(graph, { stage: 'Generating the 3D model', range: [g.complete ? 15 : 2, lastPercent] });
    const model = outputs?.[record]?.['3d']?.[0];
    if (!model) throw new Error('ComfyUI did not return the 3D model.');
    const input = inputRecord && images(outputs, inputRecord)[0];
    if (input) await ctx.comfy.getOutput(input, join(k, 'input.png'));
    await ctx.comfy.getOutput(model, glb);
    const duration = (Date.now() - startedAt) / 1000;
    ctx.measure(`model3d/${g.quality}`, duration);
    ctx.log(`3D model ${duration.toFixed(0)} s`);
  }
  let preview = null;
  if (existsSync(join(k, 'input.png'))) {
    preview = 'input.preview.jpg';
    await makePreview(ctx.setting.ffmpeg, 'input.png', preview, { cwd: k, signal: ctx.signal }).catch((e) => {
      preview = null;
      ctx.log(`Could not make a preview: ${e.message}`);
    });
  }
  const outputs = [{ file: 'model.glb', type: 'model', format: 'glb', main: !g.intro, preview }];

  // 2) Blender: exports + turntable frames; the video with the panel's ffmpeg.
  if (g.intro || g.formats.length) {
    const startedAt = Date.now();
    ctx.progress({ percent: lastPercent, stage: g.intro ? 'Blender: turntable video' : 'Blender: export', detail: '' });
    const result = await blenderPresentation(ctx.setting.blender, {
      script: join(ctx.setting.aiRoot, 'tools', 'blender', 'model3d.py'),
      input: glb,
      output: k,
      name: 'model',
      frames: g.intro ? INTRO.frames : 0,
      size: INTRO.size,
      formats: g.formats,
      printHeight: g.printHeight ?? 100,
      signal: ctx.signal,
      progress: (ratio) => ctx.progress({ percent: lastPercent + (97 - lastPercent) * ratio * 0.9, detail: `Frame ${Math.round(ratio * INTRO.frames)}/${INTRO.frames}` }),
    });
    const files = result.files ?? {};
    ctx.log(`Blender ${result.blender}: ${result.triangles} triangles, ${(Date.now() - startedAt) / 1000 | 0} s`);
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
      outputs.unshift({ file: 'turntable.mp4', type: 'video', main: true, duration: INTRO.frames / INTRO.fps, preview: existsSync(join(k, vPreview)) ? vPreview : preview, width: INTRO.size, height: INTRO.size });
    }
    ctx.measure('blender3d', (Date.now() - startedAt) / 1000);
  }
  ctx.addOutputs(outputs);
}
