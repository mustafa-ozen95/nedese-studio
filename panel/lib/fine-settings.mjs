/**
 * Ince ayarlar: bu makineye (RTX 5070 12 GB, 16 GB RAM) gore secilmis bellek onlemleri ve sinirlar. Varsayilanlar bu
 * makinede olculmus ayardir; daha guclu kartta Ayarlar > Ince ayarlar'dan kapatilir (ya da acilir). Degerler
 * <ai>\panel-data\ayar.json'da inceAyarlar altinda (yalniz varsayilandan farkli olanlar). Kullanan kod her seferinde
 * inceAyar() ile okur: degisiklik yeniden baslatmadan gecerli (ComfyUI bayraklari ComfyUI yeniden acilinca).
 */
import { UserError } from './errors.mjs';

export const FINE_SETTING_GROUPS = ['General', 'ComfyUI', 'Text model', 'Video', 'Training'];

export const FINE_SETTINGS = [
  {
    key: 'gpuShare', group: 'General', type: 'tick', defaultValue: true,
    name: 'The text model and ComfyUI take turns on the graphics card',
    description: 'When one loads, the other is unloaded from memory; bot requests wait while the graphics card is busy. Can be turned off on 24 GB and larger cards: both stay loaded together.',
  },
  {
    key: 'flushGpu', group: 'General', type: 'tick', defaultValue: true,
    name: 'Free the graphics card before voice, training and image description',
    description: 'ComfyUI models and the text model are unloaded (/free). When off, ComfyUI models stay on the card; on a large card the next image or video job starts without waiting.',
  },
  {
    key: 'waitRam', group: 'General', type: 'tick', defaultValue: true,
    name: 'Hold the job while free RAM is below 4 GB (up to 1 min)',
    description: 'For 16 GB RAM: when the model was moved to RAM, the job took 3 times longer.',
  },
  {
    key: 'foreignGpu', group: 'General', type: 'tick', defaultValue: true,
    name: 'Wait if another program is using more than 4 GB on the GPU',
    description: 'With a game or another AI program open, two large models do not fit.',
  },
  {
    key: 'noComfyCache', group: 'ComfyUI', type: 'tick', defaultValue: true, flag: '--cache-none',
    name: 'Model cache off (--cache-none)',
    description: 'For 16 GB RAM: every request reads the models from disk. Turn off with 32 GB RAM or more: consecutive jobs start faster.',
  },
  {
    key: 'noComfyPinned', group: 'ComfyUI', type: 'tick', defaultValue: true, flag: '--disable-pinned-memory',
    name: 'Pinned memory off (--disable-pinned-memory)',
    description: 'With 16 GB RAM the Wan text encoder crashed with pinned memory (29.09.2026). Turn off with plenty of RAM: models move to the GPU faster.',
  },
  {
    key: 'noComfyDynamic', group: 'ComfyUI', type: 'tick', defaultValue: true, flag: '--disable-dynamic-vram',
    name: 'Dynamic VRAM off (--disable-dynamic-vram)',
    description: 'Measured off on this machine (the only setup that worked together with the other two flags).',
  },
  {
    key: 'llmVram', group: 'Text model', type: 'choice', defaultValue: 'oto',
    options: [['oto', "From the card's memory (automatic)"], ['8', '8 GB'], ['12', '12 GB'], ['16', '16 GB'], ['24', '24 GB'], ['32', '32 GB'], ['48', '48 GB'], ['80', '80 GB']],
    name: 'Graphics card memory (text model budget)',
    description: 'The model and context are fitted into this memory minus ~1.2 GB (10.8 GB on a 12 GB GPU); MoE expert layers that do not fit run in RAM. The text model loads with the new budget on its next start.',
  },
  {
    key: 'mmprojProcessor', group: 'Text model', type: 'tick', defaultValue: true,
    name: 'Vision encoder (mmproj) on the CPU (MoE models)',
    description: 'On a 12 GB GPU, moving it to the GPU sends 3 more expert layers to RAM and text gets 16% slower; on the CPU a response with an image takes ~18 s. Turn off on a large GPU: response with an image ~4 s.',
  },
  {
    key: 'shrinkCaption', group: 'Text model', type: 'tick', defaultValue: true,
    name: 'Images are scaled down to 896 pixels for description',
    description: 'Large images are very slow while the vision encoder is on the CPU. When off, up to 1536 pixels (recommended with the vision encoder on the graphics card).',
  },
  {
    key: 'video1080p', group: 'Video', type: 'tick', defaultValue: false,
    name: 'Direct 1080p video (strong card)',
    description: 'When on, Wan generates 1920×1088 and the output is cropped to 1080 (Wan was trained up to 720p; not official). When off, 720p is generated and upscaled to 1920×1080 with a 2x AI model (a 5 s part: 377 + 53 s). Direct 1080p did not fit on a 12 GB GPU: the Wan model was moved entirely to RAM and the first step did not finish in 26 minutes (71-85 s at 720p).',
  },
  {
    key: 'trainingFp8', group: 'Training', type: 'tick', defaultValue: true,
    name: 'Image and video LoRA: base model in fp8',
    description: 'The base model is kept at 8 bit to fit in 12 GB. When off, bf16: slightly more precise, about twice the memory.',
  },
  {
    key: 'trainingGradient', group: 'Training', type: 'tick', defaultValue: true,
    name: 'Gradient checkpointing',
    description: 'In all trainings: intermediate values are not kept but recomputed during backpropagation (~30% slower, much less memory). Turn off on a large card.',
  },
  {
    key: 'trainingVideoDepth', group: 'Training', type: 'tick', defaultValue: true,
    name: 'Video LoRA: checkpoint depth 2',
    description: 'Depth 1 is faster but exceeds 12 GB.',
  },
  {
    key: 'trainingVideo720p', group: 'Training', type: 'tick', defaultValue: false,
    name: 'Video LoRA: 720p and 81-frame options',
    description: '480p, 33 frames was measured on a 12 GB card (peak 8.4 GB). 720p or 81 frames needs a 24 GB or larger card.',
  },
  {
    key: 'trainingVideoExample', group: 'Training', type: 'tick', defaultValue: true,
    name: 'Video LoRA: at most 120 samples',
    description: 'Samples stay in RAM throughout training (16 GB RAM). When off, at most 1000.',
  },
  {
    key: 'trainingMusicEncoder', group: 'Training', type: 'tick', defaultValue: true,
    name: 'Music LoRA: encoders stay off the graphics card',
    description: '--offload-encoder: the text and audio encoders stay in CPU memory during training.',
  },
  {
    key: 'trainingText4bit', group: 'Training', type: 'tick', defaultValue: true,
    name: 'Text and general model: 4-bit (QLoRA)',
    description: 'Fits up to 14B in 12 GB. When off, bf16 LoRA: more precise, ~2x the model size in memory (4B ~10 GB, 14B ~30 GB).',
  },
  {
    key: 'voiceCloneBatch', group: 'Training', type: 'tick', defaultValue: true,
    name: 'Voice clone: small batch (1 × 4, 4096 tokens)',
    description: 'When off, the original VoxCPM setting: batch 2, accumulation 8, 8192 tokens (faster, more memory).',
  },
];

const DEFINITION = new Map(FINE_SETTINGS.map((t) => [t.key, t]));
const valid = (t, v) => (t.type === 'tick' ? typeof v === 'boolean' : t.options.some(([d]) => d === v));

let source = () => ({});

/** Kayitli degerlerin kaynagi (sunucu: ayar dosyasi; test: nesne). */
export function bindFineSettings(f) {
  source = typeof f === 'function' ? f : () => f ?? {};
}

/** Ayarin gecerli degeri: kayitli ve gecerliyse o, yoksa varsayilan. */
export function fineSetting(key) {
  const t = DEFINITION.get(key);
  if (!t) throw new Error(`Unknown fine setting: ${key}`);
  let v;
  try {
    v = source()?.[key];
  } catch {
    v = undefined;
  }
  return valid(t, v) ? v : t.defaultValue;
}

/** API / arayuz: gruplar ve her ayarin tanimi + gecerli degeri. */
export function fineSettingsStatus() {
  return { groups: FINE_SETTING_GROUPS, settings: FINE_SETTINGS.map(({ flag, ...t }) => ({ ...t, ...(t.options ? { options: t.options.map(([value, name]) => ({ value, name })) } : {}), value: fineSetting(t.key) })) };
}

/** Yalniz degerler: { anahtar: deger } (secenekler: formlar 1080p gibi secenekleri gostersin mi). */
export function fineSettingValues() {
  return Object.fromEntries(FINE_SETTINGS.map((t) => [t.key, fineSetting(t.key)]));
}

/** PATCH govdesi: { anahtar: deger } dogrulanir; bilinmeyen anahtar ya da gecersiz deger hata. */
export function validateFineSettings(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw new UserError('fineSettings must be an object ({ key: value }).');
  const result = {};
  for (const [key, value] of Object.entries(g)) {
    const t = DEFINITION.get(key);
    if (!t) throw new UserError(`Unknown fine setting: ${String(key).slice(0, 60)}`);
    const v = t.type === 'tick' ? value : String(value);
    if (!valid(t, v)) throw new UserError(t.type === 'tick' ? `${t.name}: must be true or false.` : `${t.name}: must be one of: ${t.options.map(([d]) => d).join(', ')}.`);
    result[key] = v;
  }
  if (!Object.keys(result).length) throw new UserError('No fine setting to change.');
  return result;
}

/** ComfyUI bellek bayraklari (baslat_comfyui.bat AI_COMFY_BELLEK ortam degiskeniyle alir). */
export function comfyFlags() {
  return FINE_SETTINGS.filter((t) => t.flag && fineSetting(t.key)).map((t) => t.flag).join(' ');
}

/** Bu ayar degisince ne yeniden baslamali: 'comfy' (ComfyUI bayragi), 'llm' (yazi modeli ayari) ya da null. */
export function againMustStart(key) {
  const t = DEFINITION.get(key);
  if (t?.flag) return 'comfy';
  if (['llmVram', 'mmprojProcessor'].includes(key)) return 'llm';
  return null;
}
