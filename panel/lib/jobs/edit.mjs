/**
 * Gorsel duzenleme: verilen gorseli talimata gore duzenler (Qwen-Image-Edit 2511 + Lightning 4 adim,
 * araclar\comfy.mjs duzenleIsi). Ana gorsel + en cok 2 referans gorsel ("1. gorseldeki kisiye
 * 2. gorseldeki ceketi giydir"). Cikti boyutu ana gorselden (~1 MP). N sonuc TEK istekte.
 */
import { extname, join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { merge, nodes, modelFiles } from '../graph.mjs';
import { makePreview } from '../ffmpeg.mjs';
import { imageSize } from '../media.mjs';
import { yes, sourcePath, text, number, seed, generatorRequired } from './common.mjs';
import { jobPrompt } from '../prompt-translate.mjs';
import { UserError } from '../errors.mjs';

export const name = 'Edit image';

export function validate(g, { mod, setting }) {
  generatorRequired(mod, 'editJob', 'Image editing', setting?.modelRoot);
  const source = String(g.source ?? '').trim();
  if (!source) throw new UserError('Pick the image to edit.');
  sourcePath(setting.outputRoot, source);
  const references = (Array.isArray(g.references) ? g.references : []).map((r) => String(r ?? '').trim()).filter(Boolean);
  if (references.length > 2) throw new UserError('At most 2 reference images.');
  for (const r of references) sourcePath(setting.outputRoot, r);
  return {
    source,
    references,
    prompt: text(g.prompt, 'Instruction', { max: 2000 }),
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    // Qwen-Image-Edit does not follow Turkish instructions: the prompt is translated to English.
    translate: yes(g.translate ?? true),
    seed: seed(g.seed),
    count: number(g.count, 'Count', { min: 1, max: 4, full: true, defaultValue: 1 }),
  };
}

export function summary(g) {
  return { title: g.title || g.prompt, detail: `Qwen-Image-Edit${g.references.length ? ` · ${g.references.length} reference${g.references.length > 1 ? 's' : ''}` : ''} · ${g.count} result${g.count > 1 ? 's' : ''}` };
}

export async function run(ctx) {
  const g = ctx.job.input;
  const paths = [g.source, ...g.references].map((k) => sourcePath(ctx.setting.outputRoot, k));
  const pictures = [];
  for (const [i, path] of paths.entries()) pictures.push(await ctx.comfy.load(path, `panel_${ctx.job.id}_d${i + 1}${extname(path).toLowerCase() || '.png'}`));
  const instruction = await jobPrompt(ctx, g.prompt, 'edit', { translate: g.translate !== false });
  const graphs = Array.from({ length: g.count }, (_, i) => ctx.mod.editJob({ pictures, text: instruction, seed: g.seed + i, prefix: `panel/${ctx.job.id}/d${i + 1}` }));
  ctx.job.modelFiles = modelFiles(graphs[0]);
  const { job, match } = merge(graphs);
  const records = graphs.map((gr, i) => match[i][nodes(gr, 'SaveImage')[0]]);
  const startedAt = Date.now();
  const outputs = await ctx.runComfy(job, { stage: g.count > 1 ? `Editing (${g.count})` : 'Editing', range: [0, 95] });
  for (let i = 0; i < g.count; i++) {
    const list = images(outputs, records[i]);
    if (!list.length) throw new Error(`ComfyUI did not return result ${i + 1}.`);
    const file = `edited_${i + 1}.png`;
    await ctx.comfy.getOutput(list[0], join(ctx.folder, file));
    const preview = `edited_${i + 1}.preview.jpg`;
    await makePreview(ctx.setting.ffmpeg, file, preview, { cwd: ctx.folder, signal: ctx.signal }).catch((e) => ctx.log(`Could not make a preview: ${e.message}`));
    const size = imageSize(join(ctx.folder, file)) ?? {};
    ctx.addOutput({ file, type: 'image', preview, width: size.width ?? null, height: size.height ?? null, seed: g.seed + i });
  }
  const duration = (Date.now() - startedAt) / 1000;
  ctx.measure('edit', duration / g.count);
  ctx.log(`${g.count} edit ${duration.toFixed(0)} s`);
}
