/**
 * Gorsel isi: istemden N gorsel. Graf araclar\comfy.mjs'ten (qwenIsi / fluxIsi, gorsel.mjs ile
 * ayni is akisi); N gorsel TEK istekte birlestirilir: modeller bir kez yuklenir.
 */
import { join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { configureStep, merge, nodes, addLora, modelFiles } from '../graph.mjs';
import { trainedModels } from './training.mjs';
import { UserError } from '../errors.mjs';
import { makePreview } from '../ffmpeg.mjs';
import { IMAGE_MODELS, RATIOS, text, on16, number, choice, seed, generatorRequired } from './common.mjs';
import { jobPrompt } from '../prompt-translate.mjs';

export const name = 'Image';

export function validate(g, { mod, setting }) {
  const model = choice(g.model, 'Model', Object.keys(IMAGE_MODELS), 'qwen');
  // Egitilmis LoRA yalniz FLUX.2 klein ile (once bu: model dosyasi denetiminden daha belirgin hata)
  if (g.lora && model !== 'flux') throw new UserError('The selected LoRA was trained for FLUX.2 klein 4B; choose FLUX.2 klein as the model.');
  generatorRequired(mod, IMAGE_MODELS[model].generator, IMAGE_MODELS[model].name, setting?.modelRoot);
  const ratio = choice(g.ratio, 'Aspect ratio', [...Object.keys(RATIOS), 'custom'], '16:9');
  let [width, height] = ratio === 'custom' ? [0, 0] : RATIOS[ratio][model];
  if (ratio === 'custom') {
    width = on16(number(g.width, 'Width', { min: 256, max: 2048 }));
    height = on16(number(g.height, 'Height', { min: 256, max: 2048 }));
  }
  // Panelde egitilmis gorsel LoRA'si (Model egitimi > Gorsel): yalniz FLUX.2 klein ile
  let lora = null;
  if (g.lora) {
    const m = trainedModels(setting?.aiRoot ?? '').find((x) => x.field === 'image' && (x.lora === g.lora || x.id === g.lora || `trained:${x.id}` === g.lora));
    if (!m) throw new UserError(`Trained image LoRA not found: ${String(g.lora).slice(0, 80)}`);
    lora = { file: m.lora, name: m.name, trigger: m.trigger ?? '', strength: number(g.loraStrength, 'LoRA strength', { min: 0, max: 2, defaultValue: 1 }) };
  }
  return {
    prompt: text(g.prompt, 'Prompt'),
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    model,
    ratio,
    width,
    height,
    step: number(g.step, 'Steps', { min: 1, max: 12, full: true, defaultValue: IMAGE_MODELS[model].step }),
    seed: seed(g.seed),
    count: number(g.count, 'Count', { min: 1, max: 8, full: true, defaultValue: 1 }),
    ...(lora ? { lora } : {}),
  };
}

export function summary(g) {
  return { title: g.title || g.prompt, detail: `${IMAGE_MODELS[g.model]?.name ?? g.model}${g.lora ? ` + ${g.lora.name}` : ''} · ${g.width}×${g.height} · ${g.count} image${g.count > 1 ? 's' : ''}` };
}

export async function run(ctx) {
  const g = ctx.job.input;
  const generator = ctx.mod[IMAGE_MODELS[g.model].generator];
  // Qwen-Image Turkceyi anliyor (cevrilmez, yerel baglami koruyor); FLUX (T5) anlamaz.
  let prompt = g.model === 'qwen' ? g.prompt : await jobPrompt(ctx, g.prompt, 'image', { translate: g.translate !== false });
  // Egitilmis LoRA'nin tetik kelimesi istemde yoksa basa eklenir (egitim altyazilari onunla basliyordu)
  if (g.lora?.trigger && !prompt.toLowerCase().includes(g.lora.trigger.toLowerCase())) prompt = `${g.lora.trigger}, ${prompt}`;
  const graphs = Array.from({ length: g.count }, (_, i) => {
    const job = generator({ text: prompt, seed: g.seed + i, width: g.width, height: g.height, prefix: `panel/${ctx.job.id}/g${i + 1}` });
    if (g.step !== IMAGE_MODELS[g.model].step) configureStep(job, g.step);
    if (g.lora) addLora(job, g.lora.file, g.lora.strength);
    return job;
  });
  ctx.job.modelFiles = modelFiles(graphs[0]);
  const { job, match } = merge(graphs);
  const records = graphs.map((gr, i) => match[i][nodes(gr, 'SaveImage')[0]]);
  const startedAt = Date.now();
  const outputs = await ctx.runComfy(job, { stage: g.count > 1 ? `Images (${g.count})` : 'Image', range: [0, 95] });
  for (let i = 0; i < g.count; i++) {
    const list = images(outputs, records[i]);
    if (!list.length) throw new Error(`ComfyUI did not return image ${i + 1}.`);
    const file = `image_${i + 1}.png`;
    await ctx.comfy.getOutput(list[0], join(ctx.folder, file));
    const preview = `image_${i + 1}.preview.jpg`;
    await makePreview(ctx.setting.ffmpeg, file, preview, { cwd: ctx.folder, signal: ctx.signal }).catch((e) => ctx.log(`Could not make a preview: ${e.message}`));
    ctx.addOutput({ file, type: 'image', preview, width: g.width, height: g.height, seed: g.seed + i });
  }
  const duration = (Date.now() - startedAt) / 1000;
  ctx.measure(`image/${g.model}`, duration / g.count);
  ctx.log(`${g.count} images ${duration.toFixed(0)} s`);
}
