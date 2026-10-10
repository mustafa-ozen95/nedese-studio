/**
 * Kareden video (Wan 2.2): kaynak gorsel ComfyUI'ye yuklenir, graf araclar\comfy.mjs'ten
 * (wan14Isi / wanIsi, video.mjs ile ayni is akisi) uretilir, kareler hedef klasore
 * %05d.png olarak TASINIR (ComfyUI output klasoru sismez).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { nodes, addLora, modelFiles, addRife } from '../graph.mjs';
import { VIDEO_MODELS } from './common.mjs';

const NO_WAN_NEGATIVE = '';

/**
 * Wan 2.2 A14B (4 steps, cfg 1) has no negative prompt, so "three legs" in it never applied: a walking fox grew a thin
 * extra leg and melting front legs (user 10.10.2026: "tilkiye örümcek bacağı eklenmiş gibi"). Measured on the same frame
 * and seed: the animal with its leg count in the prompt ("anatomically correct fox with exactly four legs, natural
 * four-legged gait", written by the text model: anatomyPhrase) kept four clean legs at the same picture quality; this
 * general sentence did not fix the failing seed, it is only the fallback without a text model; guidance with the negative
 * on the first step (cfg 3.5) burned the colours.
 */
export const ANATOMY = 'anatomically correct body with the natural number of limbs, natural gait';
/** phrase: the job's sentence ('' = no animal or person: nothing added; null/undefined: the general sentence). */
export function withAnatomy(prompt, phrase = ANATOMY) {
  const p = String(prompt ?? '');
  const add = phrase ?? ANATOMY;
  return !add || /anatomically correct/i.test(p) ? p : `${p.replace(/[.,;\s]+$/, '')}, ${add}`;
}

/** comfy.mjs'teki RIFE dugumunu sablon olarak alir (5B grafina eklemek icin). */
export function rifeTemplate(mod) {
  if (typeof mod.wan14Job !== 'function') return null;
  const g = mod.wan14Job({ picture: 'x.png', text: NO_WAN_NEGATIVE, seed: 0, smooth: 2, prefix: 'x' });
  return Object.values(g).find((d) => d.class_type === 'RIFE VFI') ?? null;
}

/**
 * Doner: { frameCount, fps (akici dahil), lastNo (hedef klasordeki son kare numarasi) }.
 * baslangicNo: hedef klasordeki ilk dosya numarasi; atla: bastan atlanacak kare (devam parcasinda 1).
 */
export async function runWan(ctx, { model, source, lastSource = null, prompt, seed, width, height, frame, smooth, target, startNo = 1, skip = 0, stage, range, prefixExtra = 'v', lora = null, anatomy = null }) {
  const m = VIDEO_MODELS[model];
  const generator = ctx.mod[m.generator];
  if (typeof generator !== 'function') throw new Error(`${m.generator} is not in comfy.mjs`);
  const name = `panel_${ctx.job.id}_${prefixExtra}${extname(source).toLowerCase() || '.png'}`;
  const picture = await ctx.comfy.load(source, name);
  const prefix = `panel/${ctx.job.id}/${prefixExtra}`;
  let graph;
  if (model === 'wan14') {
    // Anahtar kare: bitis karesi de verilirse parca ilk-son kare arasinda uretilir
    const lastPicture = lastSource ? await ctx.comfy.load(lastSource, `panel_${ctx.job.id}_${prefixExtra}_last${extname(lastSource).toLowerCase() || '.png'}`) : null;
    graph = generator({ picture, ...(lastPicture ? { lastPicture } : {}), text: withAnatomy(prompt, anatomy), seed, width, height, frame, smooth, prefix });
  } else {
    graph = generator({ picture, text: prompt, seed, width, height, frame, prefix });
    // Panelde egitilmis video LoRA'si (yalniz 5B): UNETLoader'dan sonra LoraLoaderModelOnly
    if (lora) addLora(graph, lora.file, lora.strength);
    if (smooth > 1) addRife(graph, smooth, rifeTemplate(ctx.mod));
  }
  ctx.job.modelFiles = modelFiles(graph);
  const record = nodes(graph, 'SaveImage')[0];
  const outputs = await ctx.runComfy(graph, { stage, range });
  const list = images(outputs, record);
  if (!list.length) throw new Error('ComfyUI did not return the video frames.');
  mkdirSync(target, { recursive: true });
  let no = startNo;
  for (let i = 0; i < list.length; i++) {
    const file = join(target, `${String(no).padStart(5, '0')}.png`);
    if (i < skip) {
      // Devam parcasinin ilk karesi oncekinin son karesi: atilir (takilma olmasin).
      const temp = join(target, `_skip_${i}.png`);
      await ctx.comfy.getOutput(list[i], temp);
      rmSync(temp, { force: true });
      continue;
    }
    await ctx.comfy.getOutput(list[i], file);
    no += 1;
  }
  return { frameCount: list.length - Math.min(skip, list.length), fps: m.fps * Math.max(1, smooth), lastNo: no - 1 };
}
