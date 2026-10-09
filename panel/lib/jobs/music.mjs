/**
 * Muzik isi: tarz (ve istege bagli sozler) ile ACE-Step 1.5 Turbo'dan muzik (MP3).
 * Graf araclar\comfy.mjs muzikIsi. Tek parca filmin "Muzik: Uretilsin" secimi de bunu kullanir.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { voiceOutputs } from '../comfy-client.mjs';
import { nodes, addLora, modelFiles } from '../graph.mjs';
import { trainedModels } from './training.mjs';
import { UserError } from '../errors.mjs';
import { text, number, choice, seed, generatorRequired } from './common.mjs';
import { jobPrompt } from '../prompt-translate.mjs';

export const name = 'Music';

/** Muzik uretimi icin gereken dosyalar (Ayarlar > Model indir > ACE-Step 1.5). */
export const MUSIC_FILES = [
  ['diffusion_models', 'acestep_v1.5_turbo.safetensors'],
  ['text_encoders', 'qwen_0.6b_ace15.safetensors'],
  ['text_encoders', 'qwen_1.7b_ace15.safetensors'],
  ['vae', 'ace_1.5_vae.safetensors'],
];

/** ACE-Step tek seferde en cok 1000 sn uretir; daha uzun filmde muzik dongulenir. */
export const MUSIC_LONGEST = 600;

export function musicInstalled(setting) {
  return !setting?.modelRoot || MUSIC_FILES.every(([k, d]) => existsSync(join(setting.modelRoot, k, d)));
}

export function musicRequired(mod, setting) {
  generatorRequired(mod, 'musicJob', 'Music generation');
  if (!musicInstalled(setting)) throw new UserError('The music model is not installed: Settings > Download models > ACE-Step 1.5.');
}

export function validate(g, { mod, setting }) {
  musicRequired(mod, setting);
  // Panelde egitilmis muzik LoRA'si (Model egitimi > Muzik): ACE-Step 1.5 turbo'ya baglanir
  let lora = null;
  if (g.lora) {
    const m = trainedModels(setting?.aiRoot ?? '').find((x) => x.field === 'music' && (x.lora === g.lora || x.id === g.lora || `trained:${x.id}` === g.lora));
    if (!m) throw new UserError(`Trained music LoRA not found: ${String(g.lora).slice(0, 80)}`);
    // Guc verilmezse kayittaki olculmus onerilen guc (Caz: 2; guc 1'de etki tetik kelimeden ayirt edilemiyordu), yoksa 1
    lora = { file: m.lora, name: m.name, trigger: m.trigger ?? '', strength: number(g.loraStrength, 'LoRA strength', { min: 0, max: 2, defaultValue: m.recommendedStrength ?? 1 }) };
  }
  return {
    ...(lora ? { lora } : {}),
    style: text(g.style, 'Style', { max: 1000 }),
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    lyrics: text(g.lyrics, 'Lyrics', { required: false, max: 4000 }),
    duration: number(g.duration, 'Duration', { min: 5, max: MUSIC_LONGEST, full: true, defaultValue: 60 }),
    bpm: number(g.bpm, 'Tempo (BPM)', { min: 40, max: 220, full: true, defaultValue: 110 }),
    lang: choice(g.lang, 'Lyrics language', ['tr', 'en'], 'tr'),
    seed: seed(g.seed),
  };
}

export function summary(g) {
  return { title: g.title || g.style, detail: `${g.duration} s · ${g.lyrics ? 'with vocals' : 'instrumental'} · ${g.bpm} BPM${g.lora ? ` · + ${g.lora.name}` : ''}` };
}

/** Muzigi uretir, klasore yazar; dosya adini doner. Tek parca da cagirir. */
export async function generateMusic(ctx, { style, lyrics = '', duration, bpm = 110, lang = 'tr', seed: t, file = 'music.mp3', stage = 'Music', range = [0, 95], lora = null }) {
  // Egitilmis LoRA: tetik kelime tarzin basina (egitim tarifleri onunla basliyordu), LoRA turbo modele
  const style_ = lora?.trigger && !style.toLowerCase().includes(lora.trigger.toLowerCase()) ? `${lora.trigger}, ${style}` : style;
  const graph = ctx.mod.musicJob({ style: style_, lyrics, duration, seed: t, bpm, language: lang, prefix: `panel/${ctx.job.id}/music` });
  if (lora) addLora(graph, lora.file, lora.strength);
  ctx.job.modelFiles = [...new Set([...(ctx.job.modelFiles ?? []), ...modelFiles(graph)])];
  const record = nodes(graph, 'SaveAudioMP3')[0];
  const outputs = await ctx.runComfy(graph, { stage, range });
  const list = voiceOutputs(outputs, record);
  if (!list.length) throw new Error('ComfyUI did not return the music.');
  await ctx.comfy.getOutput(list[0], join(ctx.folder, file));
  return file;
}

export async function run(ctx) {
  const g = ctx.job.input;
  const startedAt = Date.now();
  // ACE-Step tarz etiketleri Ingilizceyle trained: tarz cevrilir, sozler oldugu gibi.
  const style = await jobPrompt(ctx, g.style, 'music', { field: 'styleEnglish', translate: g.translate !== false });
  const file = await generateMusic(ctx, { ...g, style, seed: g.seed });
  const duration = (Date.now() - startedAt) / 1000;
  ctx.addOutput({ file, type: 'voice', duration: g.duration, main: true });
  ctx.measure('music', duration / g.duration);
  ctx.log(`Music: ${g.duration} s, generated in ${duration.toFixed(0)} s`);
}
