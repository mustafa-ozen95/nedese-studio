/**
 * Model dosyalari: klasor klasor listeleme (boyut, hangi is akisinin kullandigi), bos disk,
 * secili katalog (Hugging Face; boyut ve SHA-256 HEAD ile dogrulandi 03.10.2026), silme
 * (geri donusum kutusuna; kullanimda olani zorlamadan silmez).
 *
 * Model koku <ai>\modeller (ComfyUI extra_model_paths.yaml ayni klasore bakar).
 */
import { existsSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { UserError } from './errors.mjs';
import { moveToRecycleBin } from './deletion.mjs';

export const FOLDERS = {
  diffusion_models: 'Main models (GGUF / UNET)',
  checkpoints: 'Single-file models (checkpoint)',
  loras: 'LoRA (speed-up, style)',
  text_encoders: 'Text encoders',
  vae: 'VAE',
  clip_vision: 'Vision encoders (3D)',
  background_removal: 'Background removal',
  geometry_estimation: 'Geometry estimation',
  upscale_models: 'Upscaling (1080p video)',
  audio_encoders: 'Audio encoders (lip sync)',
  model_patches: 'Model patches (lip sync)',
  latentsync: 'Mouth correction (LatentSync)',
};

const MODEL_FIELDS = { unet_name: 'diffusion_models', ckpt_name: 'checkpoints', lora_name: 'loras', clip_name: 'text_encoders', clip_name1: 'text_encoders', clip_name2: 'text_encoders', vae_name: 'vae', bg_removal_name: 'background_removal', audio_encoder_name: 'audio_encoders' };
// Ayni alan adi farkli klasorde: CLIPVisionLoader'in clip_name'i clip_vision'dan okur.
const CLASS_FIELDS = { CLIPVisionLoader: { clip_name: 'clip_vision' }, LoadMoGeModel: { model_name: 'geometry_estimation' }, ModelPatchLoader: { name: 'model_patches' } };
const FILE_NAME = /^[\w.-]+$/;

export const GENERATOR_NAMES = { qwenJob: 'Image: Qwen-Image 2512', fluxJob: 'Image: FLUX.2 klein', wan14Job: 'Video: Wan 2.2 A14B', wanJob: 'Video: Wan 2.2 5B', musicJob: 'Music: ACE-Step 1.5', songEditJob: 'Song editing: ACE-Step 1.5', editJob: 'Image editing: Qwen-Image-Edit', trellis2Job: '3D model: TRELLIS.2', lipJob: 'Lip sync: InfiniteTalk', mouthJob: 'Mouth correction: LatentSync' };

/** Is akislarinin kullandigi dosyalar: { 'diffusion_models/qwen-image-Q4_K_M.gguf': ['qwenIsi'] }. */
export function usedFiles(mod) {
  const result = {};
  for (const generator of Object.keys(GENERATOR_NAMES)) {
    if (typeof mod?.[generator] !== 'function') continue;
    let graph;
    try {
      graph = mod[generator]({ text: 'x', pictures: ['x.png'], voice: 'x.mp3', style: 'x', lyrics: '', duration: 10, seed: 0, prefix: 'x', picture: 'x.png', width: 1280, height: 720, frame: 81, smooth: 2 });
    } catch {
      continue;
    }
    for (const d of Object.values(graph)) {
      for (const [field, folder] of Object.entries({ ...MODEL_FIELDS, ...CLASS_FIELDS[d?.class_type] })) {
        const name = d?.inputs?.[field];
        if (typeof name !== 'string') continue;
        const key = `${folder}/${name}`;
        (result[key] ??= []).push(generator);
      }
    }
  }
  // ComfyUI grafi olmayan isler (LatentSync, dudak\agiz.py): katalogda "kullanan" ile
  for (const k of CATALOG) for (const u of k.user ?? []) (result[`${k.folder}/${k.file}`] ??= []).push(u);
  return result;
}

export function diskStatus(path) {
  try {
    const s = statfsSync(path);
    return { freeByte: Number(s.bavail) * Number(s.bsize), totalByte: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return { freeByte: null, totalByte: null };
  }
}

/** Kurulu modeller: { klasorler: [{ ad, aciklama, dosyalar: [{ dosya, boyut, degisme, kullanan }], toplamBayt }], disk }. */
export function installedModels(modelRoot, mod) {
  const user = usedFiles(mod);
  const folders = Object.entries(FOLDERS).map(([name, description]) => {
    const path = join(modelRoot, name);
    const files = [];
    if (existsSync(path)) {
      for (const d of readdirSync(path).sort((a, b) => a.localeCompare(b, 'tr'))) {
        if (d.endsWith('.downloading')) continue;
        let info;
        try {
          info = statSync(join(path, d));
        } catch {
          continue;
        }
        if (!info.isFile()) continue;
        const u = user[`${name}/${d}`] ?? [];
        files.push({ file: d, size: info.size, change: info.mtime.toISOString(), user: u.map((x) => GENERATOR_NAMES[x] ?? x) });
      }
    }
    return { name, description, files, totalByte: files.reduce((t, x) => t + x.size, 0) };
  });
  return { root: modelRoot, folders, disk: diskStatus(existsSync(modelRoot) ? modelRoot : resolve(modelRoot, '..')) };
}

export const MODEL_EXTENSIONS = ['.gguf', '.safetensors', '.ckpt', '.pt', '.pth', '.bin'];
export function checkModelExtension(file) {
  if (!MODEL_EXTENSIONS.some((u) => String(file).toLowerCase().endsWith(u))) throw new UserError(`The model file must have one of these extensions: ${MODEL_EXTENSIONS.join(', ')}.`);
}

/** Klasor + dosya adi denetimi; mutlak yol doner. */
export function modelPath(modelRoot, folder, file) {
  if (!FOLDERS[folder]) throw new UserError(`Invalid model folder: ${folder}`);
  if (!FILE_NAME.test(String(file)) || file === '.' || file === '..') throw new UserError('Invalid file name (letters, digits, dot, hyphen, underscore only).');
  const path = resolve(modelRoot, folder, file);
  if (!path.startsWith(resolve(modelRoot, folder) + sep)) throw new UserError('The file is outside the model folder.');
  return path;
}

/**
 * Model siler. Kullanimda (bir is akisi bu dosyayi istiyor) ise zorla=true gerekir;
 * calisan isin kullandigi dosya hicbir sekilde silinmez.
 */
export async function deleteModel({ modelRoot, mod, folder, file, zorla = false, runningFiles = [], deletionMethod = 'recycle-bin' }) {
  const path = modelPath(modelRoot, folder, file);
  if (!existsSync(path)) throw new UserError('Model file not found.', 'notFound');
  if (runningFiles.includes(file)) throw new UserError('This model is used by the running job; delete it when the job finishes.');
  const user = usedFiles(mod)[`${folder}/${file}`] ?? [];
  if (user.length && !zorla) {
    throw new UserError(`This file is used by the ${user.map((x) => GENERATOR_NAMES[x] ?? x).join(', ')} workflow. Choose another quantization in Settings first, or choose "delete anyway".`, 'inUse');
  }
  if (deletionMethod === 'permanent') rmSync(path, { force: true });
  else await moveToRecycleBin(path);
  return { user };
}

/* ── Katalog ─────────────────────────────────────────────────────────────
 * boyut: bayt (HEAD x-linked-size), sha256: HEAD x-linked-etag. Hepsi Apache 2.0 ya da
 * ilgili modelin lisansi; indirme Hugging Face'ten dogrudan.
 */
const HF = 'https://huggingface.co';
export const CATALOG = [
  // Qwen-Image (gorsel)
  { id: 'qwen-q4', group: 'Qwen-Image (image)', name: 'Qwen-Image-2512 Q4_K_M', folder: 'diffusion_models', file: 'qwen-image-2512-Q4_K_M.gguf', url: `${HF}/unsloth/Qwen-Image-2512-GGUF/resolve/main/qwen-image-2512-Q4_K_M.gguf`, size: 13244758560, sha256: 'b2a5f6249eb58ee10c9e2ce8cb1114b89897db23de2fdf7dc49140800aa928fc', note: 'Default (12 GB card, 16 GB RAM).' },
  { id: 'qwen-q4-0', group: 'Qwen-Image (image)', name: 'Qwen-Image-2512 Q4_0', folder: 'diffusion_models', file: 'qwen-image-2512-Q4_0.gguf', url: `${HF}/unsloth/Qwen-Image-2512-GGUF/resolve/main/qwen-image-2512-Q4_0.gguf`, size: 11852773920, sha256: '0b2d5468d9e85a2b1d0310dbf0ac056386302406129a5bb258ce4a7422e2f3fe', note: 'Less RAM.' },
  { id: 'qwen-q5', group: 'Qwen-Image (image)', name: 'Qwen-Image-2512 Q5_K_M', folder: 'diffusion_models', file: 'qwen-image-2512-Q5_K_M.gguf', url: `${HF}/unsloth/Qwen-Image-2512-GGUF/resolve/main/qwen-image-2512-Q5_K_M.gguf`, size: 15000074784, sha256: 'e9ea2c513cf25645829fcccbd0882e821b858f4fabfb48ae1b5f103da68ecd0f', note: 'For 32 GB RAM.' },
  { id: 'qwen-lightning-8', group: 'Qwen-Image (image)', name: 'Qwen-Image-2512 Lightning 8-step LoRA', folder: 'loras', file: 'Qwen-Image-2512-Lightning-8steps-V1.0-bf16.safetensors', url: `${HF}/lightx2v/Qwen-Image-2512-Lightning/resolve/main/Qwen-Image-2512-Lightning-8steps-V1.0-bf16.safetensors`, size: 849608296, sha256: 'b48fb1a8edd939354579c1cf0b403c92f28879b32dddbaaa91b9d424bfc72081' },
  { id: 'qwen-lightning-4', group: 'Qwen-Image (image)', name: 'Qwen-Image-2512 Lightning 4-step LoRA', folder: 'loras', file: 'Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors', url: `${HF}/lightx2v/Qwen-Image-2512-Lightning/resolve/main/Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors`, size: 849608296, sha256: 'de0d236e54ecf2c43b32447d13478c6eae0d361b1fed48c69675b084fa240d87', note: 'Faster, slightly less detail (comfy.mjs uses 8 steps).' },
  { id: 'qwen-clip', group: 'Qwen-Image (image)', name: 'Qwen 2.5 VL 7B text encoder (fp8)', folder: 'text_encoders', file: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', url: `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`, size: 9384670680, sha256: 'cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4' },
  { id: 'qwen-vae', group: 'Qwen-Image (image)', name: 'Qwen-Image VAE', folder: 'vae', file: 'qwen_image_vae.safetensors', url: `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors`, size: 253806246, sha256: 'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f' },
  // Qwen-Image-Edit 2511 (gorsel duzenleme): metin kodlayici + VAE Qwen-Image ile ortak
  { id: 'qwen-edit-q4', group: 'Qwen-Image-Edit (image editing)', name: 'Qwen-Image-Edit 2511 Q4_K_M', folder: 'diffusion_models', file: 'qwen-image-edit-2511-Q4_K_M.gguf', url: `${HF}/unsloth/Qwen-Image-Edit-2511-GGUF/resolve/main/qwen-image-edit-2511-Q4_K_M.gguf`,size: 13244758624, sha256: '8677bac90627adbbc11efab87b1870e701c4eb3689ee865a3de8ab81b705a723', note: 'Edits your image from an instruction; the Qwen text encoder and VAE are also required.' },
  { id: 'qwen-edit-lightning-4', group: 'Qwen-Image-Edit (image editing)', name: 'Qwen-Image-Edit 2511 Lightning 4-step LoRA', folder: 'loras', file: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', url: `${HF}/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`,size: 849608296, sha256: '22226e8d05d354bb356627d428809f5afd7819399b077238a2b70a82883a904f' },
  // Wan 2.2 A14B (video)
  { id: 'wan14-high-q4', group: 'Wan 2.2 A14B (video)', name: 'Wan 2.2 I2V A14B lightx2v 720p HighNoise Q4_K_M', folder: 'diffusion_models', file: 'wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf', url: `${HF}/jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF/resolve/main/high_noise_260412/wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf`, size: 9661569664, sha256: '18fe5780b0eb4ecb7ee88194ce10d78c375295eabadc110f9fd2961f7914cb14', note: 'Less RAM; slightly less detail.' },
  { id: 'wan14-low-q4', group: 'Wan 2.2 A14B (video)', name: 'Wan 2.2 I2V A14B lightx2v 720p LowNoise Q4_K_M', folder: 'diffusion_models', file: 'wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf', url: `${HF}/jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF/resolve/main/low_noise_260412/wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf`, size: 9661569664, sha256: '583d458354129099d5d49e524a857b272007a0cb0ef12dc731f84968521be845' },
  { id: 'wan14-high-q5', group: 'Wan 2.2 A14B (video)', name: 'Wan 2.2 I2V A14B lightx2v 720p HighNoise Q5_K_M', folder: 'diffusion_models', file: 'wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf', url: `${HF}/jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF/resolve/main/high_noise_260412/wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf`, size: 10801896064, sha256: 'e0f6cbc7ee5d61131711dcc3968dae3ecb4c698de73fe07f7a10b99e741606d6', note: 'Default (16 GB RAM). High + Low are both required.' },
  { id: 'wan14-low-q5', group: 'Wan 2.2 A14B (video)', name: 'Wan 2.2 I2V A14B lightx2v 720p LowNoise Q5_K_M', folder: 'diffusion_models', file: 'wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf', url: `${HF}/jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF/resolve/main/low_noise_260412/wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf`, size: 10801896064, sha256: '765205fe4c2b6fc7496509e75754d581e5416ecf0adee15b074545b248ca1371' },
  { id: 'wan14-high-q6', group: 'Wan 2.2 A14B (video)', name: 'Wan 2.2 I2V A14B lightx2v 720p HighNoise Q6_K', folder: 'diffusion_models', file: 'wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q6_K.gguf', url: `${HF}/jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF/resolve/main/high_noise_260412/wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q6_K.gguf`, size: 12013492864, sha256: '871d3de1e7a50355c5b55f12992822290b17080ba56c2d3f1742776614efc769', note: '16 GB RAM is borderline; for 32 GB RAM.' },
  { id: 'wan14-low-q6', group: 'Wan 2.2 A14B (video)', name: 'Wan 2.2 I2V A14B lightx2v 720p LowNoise Q6_K', folder: 'diffusion_models', file: 'wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q6_K.gguf', url: `${HF}/jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF/resolve/main/low_noise_260412/wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q6_K.gguf`, size: 12013492864, sha256: '037a8d0d4d8f05bd17ebc0917bacdb3255002d112be2546e5760efd1467fc034' },
  { id: 'wan-umt5', group: 'Wan 2.2 A14B (video)', name: 'UMT5 XXL text encoder (fp8)', folder: 'text_encoders', file: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', url: `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`, size: 6735906897, sha256: 'c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68' },
  { id: 'wan21-vae', group: 'Wan 2.2 A14B (video)', name: 'Wan 2.1 VAE (used by A14B)', folder: 'vae', file: 'wan_2.1_vae.safetensors', url: `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors`, size: 253815318, sha256: '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b' },
  // Wan 2.2 5B
  { id: 'wan5-fp16', group: 'Wan 2.2 5B (light video)', name: 'Wan 2.2 TI2V 5B fp16', folder: 'diffusion_models', file: 'wan2.2_ti2v_5B_fp16.safetensors', url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`, size: 9999658848, sha256: '456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e' },
  { id: 'wan22-vae', group: 'Wan 2.2 5B (light video)', name: 'Wan 2.2 VAE (used by 5B)', folder: 'vae', file: 'wan2.2_vae.safetensors', url: `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors`, size: 1409400960, sha256: 'e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156' },
  // FLUX
  { id: 'flux2-klein-4b', group: 'FLUX.2 klein 4B (fast image)', name: 'FLUX.2 klein 4B fp8', folder: 'diffusion_models', file: 'flux-2-klein-4b-fp8.safetensors', url: `${HF}/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors`, size: 4070624520, sha256: '97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6', note: 'Apache 2.0; 4 steps, ~8 s.' },
  { id: 'flux2-klein-te', group: 'FLUX.2 klein 4B (fast image)', name: 'Qwen3 4B text encoder (fp4, klein)', folder: 'text_encoders', file: 'qwen_3_4b_fp4_flux2.safetensors', url: `${HF}/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/text_encoders/qwen_3_4b_fp4_flux2.safetensors`, size: 3848213998, sha256: '3eab03a77adb0ee5304a4e677d5c10ac22f9049c1d7c894adca4f8bb39206ca8' },
  { id: 'flux2-vae', group: 'FLUX.2 klein 4B (fast image)', name: 'FLUX.2 VAE', folder: 'vae', file: 'flux2-vae.safetensors', url: `${HF}/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors`, size: 336213556, sha256: 'd64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5' },
  // Muzik: ACE-Step 1.5 Turbo (8 adim) + iki Qwen metin kodlayici (0.6B + 1.7B) + VAE
  { id: 'acestep15-turbo', group: 'ACE-Step 1.5 (music)', name: 'ACE-Step 1.5 Turbo', folder: 'diffusion_models', file: 'acestep_v1.5_turbo.safetensors', url: `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/diffusion_models/acestep_v1.5_turbo.safetensors`, size: 4787825604, sha256: '3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7', note: 'Music from text (with vocals or instrumental).' },
  { id: 'acestep15-qwen06', group: 'ACE-Step 1.5 (music)', name: 'ACE-Step Qwen 0.6B text encoder', folder: 'text_encoders', file: 'qwen_0.6b_ace15.safetensors', url: `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_0.6b_ace15.safetensors`, size: 1191588248, sha256: 'fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7' },
  { id: 'acestep15-qwen17', group: 'ACE-Step 1.5 (music)', name: 'ACE-Step Qwen 1.7B text encoder', folder: 'text_encoders', file: 'qwen_1.7b_ace15.safetensors', url: `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_1.7b_ace15.safetensors`, size: 3708523360, sha256: 'ed63e9247d1f55f3ace04fa11e95b085fc82d459c82c5626f0b2e37b91ebd710' },
  { id: 'acestep15-vae', group: 'ACE-Step 1.5 (music)', name: 'ACE-Step 1.5 VAE', folder: 'vae', file: 'ace_1.5_vae.safetensors', url: `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/vae/ace_1.5_vae.safetensors`, size: 337431732, sha256: '6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb' },

  // Dudak esleme (Tek parca film, konusmali sahne): karma kurulum ilk 2 adimi Wan 2.2 A14B HighNoise ile, son 2 adimi
  // Wan 2.1 I2V + InfiniteTalk ile atar (lib/dudak.mjs). Wan 2.2 HighNoise, UMT5 ve Wan 2.1 VAE yukaridaki gruptan.
  { id: 'dudak-wan21-q4', group: 'Lip sync (InfiniteTalk)', name: 'Wan 2.1 I2V 14B 720p Q4_K_M', folder: 'diffusion_models', file: 'wan2.1-i2v-14b-720p-Q4_K_M.gguf', url: `${HF}/city96/Wan2.1-I2V-14B-720P-gguf/resolve/main/wan2.1-i2v-14b-720p-Q4_K_M.gguf`, size: 11341184384, sha256: 'ffecd91e4b636d8e3e43f3fa388218158ba447109547bde777c6d67ef4fe42a4', note: 'Lips move with the voice in dialogue scenes; the 3 files below and Wan 2.2 A14B HighNoise are also needed.' },
  { id: 'dudak-lightx2v', group: 'Lip sync (InfiniteTalk)', name: 'lightx2v I2V 14B step-distill LoRA (Wan 2.1)', folder: 'loras', file: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', url: `${HF}/Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors`, size: 738005744, sha256: '85c4a61c30e0497aa44b91d93a893b624708461a56fe5485183b28fa07e2dfb3' },
  { id: 'dudak-infinitetalk', group: 'Lip sync (InfiniteTalk)', name: 'InfiniteTalk two-speaker patch', folder: 'model_patches', file: 'wan2.1_infiniteTalk_multi_fp16.safetensors', url: `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/model_patches/wan2.1_infiniteTalk_multi_fp16.safetensors`, size: 5124439112, sha256: '4c2486cdfb6ff9a9f27408e98e11e20619136933b20411e0c365b1e84075d195' },
  // Agiz duzeltme (dudak\agiz.py): LatentSync 1.5 (kod Apache-2.0, agirlik OpenRAIL++), Whisper tiny (MIT), SD VAE ft-mse
  // (MIT), MediaPipe yuz isaretleri (Apache-2.0). Olculdu 07.10.2026: SyncNet LSE-C 1,28 -> 5,20, agiz-ses kaymasi 0.
  { id: 'agiz-latentsync', group: 'Mouth correction (LatentSync)', name: 'LatentSync 1.5 UNet', folder: 'latentsync', file: 'latentsync_unet.pt', url: `${HF}/ByteDance/LatentSync-1.5/resolve/main/latentsync_unet.pt`, size: 5072348184, sha256: '6440b49a7ccceff56cdc001f5f17605216337f5bbd66fa360139768926e23f51', user: ['mouthJob'], note: 'The mouths of speaking people are fitted to their own voice; eyes and gaze stay unchanged. All 3 files below are required.' },
  { id: 'mouth-whisper', group: 'Mouth correction (LatentSync)', name: 'Whisper tiny (audio features)', folder: 'latentsync', file: 'whisper-tiny.pt', urlFile: 'tiny.pt', url: `${HF}/ByteDance/LatentSync-1.5/resolve/main/whisper/tiny.pt`, size: 75572083, sha256: '65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9', user: ['mouthJob'] },
  { id: 'mouth-vae', group: 'Mouth correction (LatentSync)', name: 'SD VAE ft-mse', folder: 'latentsync', file: 'sd-vae-ft-mse.safetensors', urlFile: 'diffusion_pytorch_model.safetensors', url: `${HF}/stabilityai/sd-vae-ft-mse/resolve/main/diffusion_pytorch_model.safetensors`, size: 334643276, sha256: 'a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815', user: ['mouthJob'] },
  { id: 'mouth-face', group: 'Mouth correction (LatentSync)', name: 'MediaPipe face landmarks', folder: 'latentsync', file: 'face_landmarker.task', url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', size: 3758596, sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff', user: ['mouthJob'] },
  { id: 'dudak-wav2vec2', group: 'Lip sync (InfiniteTalk)', name: 'wav2vec2 Chinese base audio encoder (fp16)', folder: 'audio_encoders', file: 'wav2vec2-chinese-base_fp16.safetensors', url: `${HF}/Kijai/wav2vec2_safetensors/resolve/main/wav2vec2-chinese-base_fp16.safetensors`, size: 190115368, sha256: '000813e441020f18cff844c969d2d5d4adc2a5ce46b2db1f23950b05d88805b4' },

  // TRELLIS.2 (gorselden 3D model; Microsoft, MIT). ComfyUI 0.37 yerlesik dugumleri.
  { id: 'trellis2', group: 'TRELLIS.2 (3D model)', name: 'TRELLIS.2 int8', folder: 'diffusion_models', file: 'trellis_2_int8_convrot.safetensors', url: `${HF}/Comfy-Org/TRELLIS.2/resolve/main/diffusion_models/trellis_2_int8_convrot.safetensors`, size: 5253048192, sha256: 'd01952ad137213f6a868f86b6b877026276f84af5eec23069217475a0bad3a31', note: 'Textured 3D model from an image (GLB). The 4 files below are also required.' },
  { id: 'trellis2-sekil-vae', group: 'TRELLIS.2 (3D model)', name: 'TRELLIS.2 shape VAE', folder: 'vae', file: 'trellis_2_shape_vae_bf16.safetensors', url: `${HF}/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_shape_vae_bf16.safetensors`, size: 1095844024, sha256: 'de0cb4949a76c59ee5c091a995a69bcc8c51d5aeda939f0c641a50d2a72341f4' },
  { id: 'trellis2-doku-vae', group: 'TRELLIS.2 (3D model)', name: 'TRELLIS.2 texture VAE', folder: 'vae', file: 'trellis_2_texture_vae_bf16.safetensors', url: `${HF}/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_texture_vae_bf16.safetensors`, size: 948461364, sha256: '714e5ebf094a610e12a8e3b5175c18a62f37f6ea4218acb6073644456b73ab0e' },
  { id: 'trellis2-dino', group: 'TRELLIS.2 (3D model)', name: 'DINOv3 L vision encoder', folder: 'clip_vision', file: 'dino_v3_L_naf_fp32.safetensors', url: `${HF}/Comfy-Org/Pixal3D/resolve/main/clip_vision/dino_v3_L_naf_fp32.safetensors`, size: 1215214176, sha256: '4ad2ec4e0879a5b5b04cd97325cc37da954a7b6edca5170b86510f17f2b2290f' },
  { id: 'pixal3d', group: 'TRELLIS.2 (3D model)', name: 'Pixal3D int8', folder: 'diffusion_models', file: 'pixal3d_int8_convrot.safetensors', url: `${HF}/Comfy-Org/Pixal3D/resolve/main/diffusion_models/pixal3d_int8_convrot.safetensors`, size: 5584555824, sha256: '4621eac3b715484f79303c7152af641fe0b2b14f4d0e3d394fd6922d00f955ec', note: 'Image to 3D, same pipeline as TRELLIS.2; better face and fine detail (high quality).' },
  { id: 'moge2', group: 'TRELLIS.2 (3D model)', name: 'MoGe-2 camera angle (Pixal3D)', folder: 'geometry_estimation', file: 'moge_2_vitl_normal_fp16.safetensors', url: `${HF}/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_2_vitl_normal_fp16.safetensors`, size: 661859924, sha256: 'cb1a692d03235671e959e81360d7b4d9f44aefadb1f852d6ca6aa17799d5e31f' },
  { id: 'birefnet', group: 'TRELLIS.2 (3D model)', name: 'BiRefNet background removal', folder: 'background_removal', file: 'birefnet.safetensors', url: `${HF}/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors`, size: 444473596, sha256: '9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154' },
  { id: 'buyut-span2x', group: 'Video 1080p upscaling', name: '2xNomosUni SPAN (2x, CC-BY-4.0, Philip Hofmann)', folder: 'upscale_models', file: '2xNomosUni_span_multijpg.safetensors', url: `${HF}/Phips/2xNomosUni_span_multijpg/resolve/main/2xNomosUni_span_multijpg.safetensors`, size: 4461056, sha256: 'bee2a9c082f2b8f6e7f5db504b36593c24a1a959511f587114c399ca58b9c92c' },
];

/** Katalog + kurulu mu bilgisi. */
export function catalogStatus(modelRoot) {
  return CATALOG.map((k) => {
    const path = join(modelRoot, k.folder, k.file);
    let installed = false;
    let sizeMismatch = false;
    if (existsSync(path)) {
      installed = true;
      try {
        sizeMismatch = statSync(path).size !== k.size;
      } catch {
        /* */
      }
    }
    return { ...k, installed, sizeMismatch };
  });
}
