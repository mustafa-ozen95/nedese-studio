/**
 * Niceleme (quantization) secimi: comfy.mjs'teki is akislari model dosya adini sabit yazar
 * (qwen-image-Q4_K_M.gguf gibi). Panel bu dosyayi DEGISTIRMEZ; uretilen grafta GGUF yukleyici
 * dugumlerinin dosya adindaki niceleme etiketi, ayarlardaki secimle degistirilir.
 * Geri alinabilir: secim bos ('') = comfy.mjs'teki ad oldugu gibi.
 *
 * Desenler (dosya adi -> aile):
 *   qwen-image-2512-<Q>.gguf                  aile 'qwen'
 *   wan2.2_i2v_A14b_(high|low)_noise_lightx2v_4step_720p_260412-<Q>.gguf  aile 'wan14' (iki dosya birlikte)
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const FAMILIES = {
  qwen: { name: 'Qwen-Image (image)', version: 'Qwen-Image-2512 20B (Alibaba, official, December 2025) · GGUF: unsloth (community quantization) + lightx2v Lightning 8-step LoRA', pattern: /^(qwen-image-2512-)(Q[0-9A-Z_]+)(\.gguf)$/i, folder: 'diffusion_models', files: (q) => [`qwen-image-2512-${q}.gguf`] },
  wan14: {
    name: 'Wan 2.2 A14B (video)',
    version: 'Wan 2.2 I2V A14B · lightx2v 720p distilled model (April 2026, 4-step) · GGUF: jayn7 (community quantization)',
    pattern: /^(wan2\.2_i2v_A14b_(?:high|low)_noise_lightx2v_4step_720p_260412-)(Q[0-9A-Z_]+)(\.gguf)$/i,
    folder: 'diffusion_models',
    files: (q) => [`wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-${q}.gguf`, `wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-${q}.gguf`],
  },
};

const QUANTIZATION_POSITION = ['Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q4_0', 'Q4_K_S', 'Q4_K_M', 'Q5_0', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0'];

/** Dosya adindan { aile, niceleme } ya da null. */
export function parseQuantization(file) {
  for (const [family, a] of Object.entries(FAMILIES)) {
    const m = a.pattern.exec(file);
    if (m) return { family, quantization: m[2].toUpperCase() };
  }
  return null;
}

/** Graftaki GGUF model adlarini secimlere gore degistirir (yerinde). secimler: { qwen: 'Q8_0', wan14: '' }. */
export function applyQuantization(graph, choices = {}) {
  for (const d of Object.values(graph)) {
    const name = d?.inputs?.unet_name;
    if (typeof name !== 'string') continue;
    for (const [family, a] of Object.entries(FAMILIES)) {
      const target = choices[family];
      if (!target) continue;
      const m = a.pattern.exec(name);
      if (m) d.inputs.unet_name = `${m[1]}${target}${m[3]}`;
    }
  }
  return graph;
}

/**
 * comfy.mjs modulunu sarar: her uretec (…Isi) once orijinali cagirir, sonra secimi uygular.
 * secimAl(): o anki secimler (ayar dosyasindan; degisince yeniden yukleme gerekmez).
 */
export function wrapModule(mod, getChoice) {
  const wrapped = {};
  for (const [name, value] of Object.entries(mod)) {
    wrapped[name] = typeof value === 'function' && /Job$/.test(name) ? (...a) => applyQuantization(value(...a), getChoice()) : value;
  }
  return wrapped;
}

/** Her aile icin kurulu nicelemeler (klasordeki dosyalardan) ve comfy.mjs'in varsayilani. */
export function quantizationOptions(modelRoot, mod) {
  const result = {};
  for (const [family, a] of Object.entries(FAMILIES)) {
    const folder = join(modelRoot, a.folder);
    const files = existsSync(folder) ? readdirSync(folder) : [];
    const counter = {};
    for (const d of files) {
      const c = parseQuantization(d);
      if (c?.family === family) counter[c.quantization] = (counter[c.quantization] ?? 0) + 1;
    }
    const required = a.files('X').length;
    const installed = Object.entries(counter).filter(([, n]) => n >= required).map(([q]) => q);
    installed.sort((x, y) => QUANTIZATION_POSITION.indexOf(x) - QUANTIZATION_POSITION.indexOf(y));
    result[family] = { name: a.name, version: a.version ?? '', installed, defaultValue: defaultQuantization(mod, family) };
  }
  return result;
}

/** comfy.mjs'in kendi grafindaki niceleme (secim bosken kullanilan). */
export function defaultQuantization(mod, family) {
  const generator = family === 'qwen' ? mod?.qwenJob : mod?.wan14Job;
  if (typeof generator !== 'function') return null;
  try {
    const g = generator({ text: 'x', seed: 0, prefix: 'x', picture: 'x.png' });
    for (const d of Object.values(g)) {
      const c = typeof d?.inputs?.unet_name === 'string' ? parseQuantization(d.inputs.unet_name) : null;
      if (c?.family === family) return c.quantization;
    }
  } catch {
    /* uretec bu makinede calismiyor */
  }
  return null;
}

/** Secim gecerli mi: bos ya da kurulu bir niceleme. Hata metni doner, gecerliyse ''. */
export function checkQuantization(modelRoot, mod, family, quantization) {
  if (!FAMILIES[family]) return `Unknown model family: ${family}`;
  if (!quantization) return '';
  if (!/^Q[0-9A-Z_]+$/.test(quantization)) return `Invalid quantization name: ${quantization}`;
  const s = quantizationOptions(modelRoot, mod)[family];
  if (!s.installed.includes(quantization)) return `${quantization} files for ${FAMILIES[family].name} are not installed (${FAMILIES[family].files(quantization).join(', ')}).`;
  return '';
}
