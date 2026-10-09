/**
 * The local AI system (the <install folder>; RTX 5070 12 GB) - ComfyUI API client and ready workflows.
 * Projects import it (single source):
 *   import { run, qwenJob, wan14Job } from 'file:///<install folder>/tools/comfy.mjs';
 * Paths are computed from this file's location: it works wherever the install folder is.
 *
 * Workflows (all Apache 2.0):
 * - qwenIsi   Qwen-Image 20B (GGUF Q4_K_M) + Lightning 8 adim: en guclu gorsel (~1 dk/kare)
 * - fluxIsi   FLUX.1-schnell fp8: hizli gorsel (~16 sn/kare)
 * - wan14Isi  Wan 2.2 I2V A14B, lightx2v 720p damitilmis (GGUF): kareden 5 sn video, 16 fps
 * - wanIsi    Wan 2.2 TI2V-5B: daha hafif kareden video, 24 fps
 * - muzikIsi  ACE-Step 1.5 Turbo: metinden muzik (sarkili ya da enstrumantal), MP3
 * - trellis2Isi TRELLIS.2 (MIT): gorselden dokulu 3D model, GLB
 * ComfyUI kapaliysa: <ai>\baslat_comfyui.bat
 */
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMFY = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'ComfyUI_windows_portable', 'ComfyUI');
const ADDRESS = 'http://127.0.0.1:8188';
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

export async function isReady() {
  try {
    return (await fetch(`${ADDRESS}/system_stats`)).ok;
  } catch {
    return false;
  }
}

/** Isi kuyruga koyar, bitince ciktilari doner ({dugum: {images: [...]}}). */
export async function run(job, { timeTimeout = 40 * 60e3 } = {}) {
  const r = await fetch(`${ADDRESS}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: job, client_id: 'nedese-prime' }),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`ComfyUI: ${JSON.stringify(j.node_errors ?? j.error ?? j).slice(0, 1200)}`);
  const id = j.prompt_id;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeTimeout) {
    await wait(2000);
    const h = (await (await fetch(`${ADDRESS}/history/${id}`)).json())[id];
    if (!h) continue;
    if (h.status?.status_str === 'error') throw new Error(`ComfyUI hata: ${JSON.stringify(h.status.messages).slice(0, 2000)}`);
    if (h.status?.completed) return h.outputs;
  }
  throw new Error(`ComfyUI zaman asimi: ${id}`);
}

/** Ciktilarin dosya yollari (ComfyUI/output altinda), sirali. */
export function files(outputs) {
  const list = [];
  for (const d of Object.values(outputs)) {
    for (const g of d.images ?? []) list.push(join(COMFY, g.type ?? 'output', g.subfolder ?? '', g.filename));
  }
  return list.sort();
}

/** Resmi ComfyUI/input'a koyar (LoadImage oradan okur). */
export function toInputPut(path, name) {
  const target = join(COMFY, 'input', name);
  if (!existsSync(target)) copyFileSync(path, target);
  return name;
}

/**
 * FLUX.2 klein 4B (Apache 2.0; fp8 + Qwen3 4B fp4 metin kodlayici): 4 adim, cfg 1 (ComfyUI resmi
 * klein sablonu). Olculdu 04.10.2026 (1664x928): 8-14 sn, ten/doku Qwen'den gercekci; gorsel
 * icindeki yazida zayif ("Denz Kizi"). FLUX.1 schnell'in yerine (hizli secenek).
 */
export function fluxJob({ text, seed, width = 1920, height = 1088, prefix }) {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-4b-fp8.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b_fp4_flux2.safetensors', type: 'flux2', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: text } },
    // cfg 1: olumsuz kosul kullanilmaz; metin kodlayicidan gecirmek yerine sifir kosul.
    5: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    6: { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], cfg: 1 } },
    7: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    8: { class_type: 'Flux2Scheduler', inputs: { steps: 4, width: width, height: height } },
    9: { class_type: 'EmptyFlux2LatentImage', inputs: { width: width, height: height, batch_size: 1 } },
    10: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    11: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['10', 0], guider: ['6', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['9', 0] } },
    12: { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    13: { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: prefix } },
  };
}

/**
 * Qwen-Image-2512 (20B, Aralik 2025 guncellemesi, Apache 2.0; GGUF Q4_K_M: unsloth) + lightx2v
 * 2512 Lightning 8 adim LoRA: cfg 1, AuraFlow kaydirma 3.1 (ComfyUI resmi Qwen-Image is akisi).
 * Olculdu 04.10.2026 (ayni istem/tohum): eski Qwen-Image'a gore ten daha dogal, Turkce tabela
 * yazisi daha dogru, 70 -> 65 sn; dosya boyu ayni. 16:9 icin 1664x928.
 */
export function qwenJob({ text, seed, width = 1664, height = 928, prefix }) {
  return {
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'qwen-image-2512-Q4_K_M.gguf' } },
    2: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'Qwen-Image-2512-Lightning-8steps-V1.0-bf16.safetensors', strength_model: 1 } },
    3: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['2', 0], shift: 3.1 } },
    4: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
    5: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 0], text: text } },
    // cfg 1: olumsuz kosul kullanilmaz; metin kodlayicidan gecirmek yerine sifir kosul.
    7: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } },
    8: { class_type: 'EmptySD3LatentImage', inputs: { width: width, height: height, batch_size: 1 } },
    9: {
      class_type: 'KSampler',
      inputs: {
        model: ['3', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0],
        seed: seed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      },
    },
    10: { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['5', 0] } },
    11: { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: prefix } },
  };
}

/**
 * Gorsel duzenleme: Qwen-Image-Edit-2511 (GGUF Q4_K_M, Apache 2.0) + Lightning 4 adim LoRA.
 * Verilen gorseli (1-3 gorsel; 2. ve 3. referans: "1. gorseldeki koltugu 2. gorseldeki kumasla kapla")
 * talimata gore duzenler. Metin kodlayici ve VAE Qwen-Image ile ortak. ComfyUI resmi 2511 sablonu.
 * resimler: ComfyUI input klasorundeki dosya adlari; cikti boyutu 1. gorselden (~1 MP).
 * en/boy verilirse cikti o boyutta bos latent'ten (denoise 1: 1. gorsel yalniz referans). Tek parca
 * karakter tutarliligi: sahne 1'deki kisiyle yeni sahne, filmin oraninda.
 */
export function editJob({ pictures = [], picture, text, seed, prefix, width, height }) {
  const list = pictures.length ? pictures.slice(0, 3) : [picture];
  const g = {
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'qwen-image-edit-2511-Q4_K_M.gguf' } },
    2: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', strength_model: 1 } },
    3: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['2', 0], shift: 3.1 } },
    4: { class_type: 'CFGNorm', inputs: { model: ['3', 0], strength: 1 } },
    5: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
    6: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  };
  const imageInputs = {};
  list.forEach((name, i) => {
    g[20 + i] = { class_type: 'LoadImage', inputs: { image: name } };
    imageInputs[`image${i + 1}`] = [String(20 + i), 0];
  });
  // 1. gorsel ~1 MP'ye olceklenir (Kontext olcegi); cikti boyutu buradan.
  g[7] = { class_type: 'FluxKontextImageScale', inputs: { image: ['20', 0] } };
  imageInputs.image1 = ['7', 0];
  Object.assign(g, {
    8: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['5', 0], prompt: text, vae: ['6', 0], ...imageInputs } },
    9: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['5', 0], prompt: '', vae: ['6', 0], ...imageInputs } },
    10: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['8', 0], reference_latents_method: 'index_timestep_zero' } },
    11: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['9', 0], reference_latents_method: 'index_timestep_zero' } },
    12: width && height
      ? { class_type: 'EmptySD3LatentImage', inputs: { width: width, height: height, batch_size: 1 } }
      : { class_type: 'VAEEncode', inputs: { pixels: ['7', 0], vae: ['6', 0] } },
    13: {
      class_type: 'KSampler',
      inputs: { model: ['4', 0], positive: ['10', 0], negative: ['11', 0], latent_image: ['12', 0], seed: seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 },
    },
    14: { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['6', 0] } },
    15: { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: prefix } },
  });
  return g;
}

/**
 * Wan 2.2 I2V A14B, lightx2v 720p damitilmis model (260412; GGUF Q5_K_M, jayn7): yuksek + dusuk
 * gurultu uzmani, 2 + 2 adim, cfg 1. Damitma modelin icinde, LoRA yok. Olculdu 04.10.2026 (ayni
 * gorsel/istem/tohum): taban Q5 + lightx2v v1 LoRA'ya gore cilt/sakal dokusu belirgin daha dogal,
 * 458 -> 393 sn; 6-8 adim (LoRA ile) dokuyu duzeltmedi. 16 fps; 81 kare = 5 sn.
 */
// sonResim: anahtar kare (video anahtarKare) -> bitis karesiyle WanFirstLastFrameToVideo (Wan 2.2 A14B I2V ilk-son kare)
export function wan14Job({ picture, lastPicture = null, text, seed, width = 1280, height = 720, frame = 81, smooth = 1, prefix }) {
  // akici > 1: RIFE (ComfyUI-Frame-Interpolation) ara kareleriyle 16 * akici fps.
  // ensemble: eklenti IFNet'e konumsal argumanlari kaydirarak verdigi icin hic uygulanmiyor (fast_mode da
  // 4.7'de etkisiz). Duzeltilip olculdu 04.10.2026 (Wan 720p, silinen gercek karelere karsi): +0,05 dB PSNR,
  // %4 yavas; yama tasimaya degmez, gercekte olan yazildi.
  const exit = smooth > 1 ? ['17', 0] : ['15', 0];
  const rife = smooth > 1
    ? {
        17: {
          class_type: 'RIFE VFI',
          inputs: {
            frames: ['15', 0], ckpt_name: 'rife49.pth', clear_cache_after_n_frames: 10, multiplier: smooth,
            fast_mode: true, ensemble: false, scale_factor: 1, dtype: 'float16', torch_compile: false, batch_size: 4,
          },
        },
      }
    : {};
  return {
    ...rife,
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf' } },
    2: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf' } },
    5: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 5 } },
    6: { class_type: 'ModelSamplingSD3', inputs: { model: ['2', 0], shift: 5 } },
    7: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } },
    8: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    9: { class_type: 'CLIPTextEncode', inputs: { clip: ['7', 0], text: text } },
    // cfg 1 (Lightning): olumsuz kosul kullanilmaz; uzun olumsuz istemi UMT5'ten gecirmek yerine sifir kosul.
    10: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['9', 0] } },
    11: { class_type: 'LoadImage', inputs: { image: picture } },
    ...(lastPicture ? { 18: { class_type: 'LoadImage', inputs: { image: lastPicture } } } : {}),
    12: {
      class_type: lastPicture ? 'WanFirstLastFrameToVideo' : 'WanImageToVideo',
      inputs: { positive: ['9', 0], negative: ['10', 0], vae: ['8', 0], width: width, height: height, length: frame, batch_size: 1, start_image: ['11', 0], ...(lastPicture ? { end_image: ['18', 0] } : {}) },
    },
    13: {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: ['5', 0], add_noise: 'enable', noise_seed: seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
        positive: ['12', 0], negative: ['12', 1], latent_image: ['12', 2], start_at_step: 0, end_at_step: 2, return_with_leftover_noise: 'enable',
      },
    },
    14: {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: ['6', 0], add_noise: 'disable', noise_seed: seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
        positive: ['12', 0], negative: ['12', 1], latent_image: ['13', 0], start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: 'disable',
      },
    },
    15: { class_type: 'VAEDecode', inputs: { samples: ['14', 0], vae: ['8', 0] } },
    16: { class_type: 'SaveImage', inputs: { images: exit, filename_prefix: prefix } },
  };
}

// Wan'in resmi is akisindaki olumsuz istem (Cince, modelin egitildigi dil).
const WAN_NEGATIVE = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

/** Wan 2.2 TI2V-5B: baslangic karesinden video (kareler PNG olarak). */
export function wanJob({ picture, text, seed, width = 1280, height = 704, frame = 121, step = 20, cfg = 5, prefix }) {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
    4: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
    5: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: text } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: WAN_NEGATIVE } },
    7: { class_type: 'LoadImage', inputs: { image: picture } },
    8: { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['3', 0], width: width, height: height, length: frame, batch_size: 1, start_image: ['7', 0] } },
    9: {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['8', 0],
        seed: seed, steps: step, cfg, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1,
      },
    },
    10: { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
    11: { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: prefix } },
  };
}

/**
 * Dudak esleme penceresi (InfiniteTalk, 25 fps, 81 kare): ilk 2 adim Wan 2.2 A14B yuksek gurultu uzmani (yamasiz:
 * hareket, bakis, renk Wan 2.2'den), son 2 adim Wan 2.1 I2V 720p + lightx2v + InfiniteTalk iki konusmaci yamasi.
 * Olculdu 07.10.2026 (BENIOKU "Dudak eşleme"): yalniz Wan 2.1 konusani kameraya dondurur, Wan 2.2'ye yama dudagi
 * oynatmaz; karma ikisini de korur. ses1 pencerenin [0, s) bolumu (1. konusmaci, maske1), ses2 [s, kare) bolumu
 * (2. konusmaci, maske2): ComfyUI iki sesi ardisik ekler. Maske video pikseli [x, y, w, h] ya da null (bos).
 * hareketler: devam penceresinde onceki pencerenin son 9 karesi (yuklenmis dosya adlari); ciktinin ilk 9 karesi
 * atilir. ses: InfiniteTalk ses gucu (3 olculdu: 1'de agiz cok az acilir).
 */
export function lipJob({ picture, motions = null, voice1, voice2, mask1 = null, mask2 = null, text, seed, width = 720, height = 1280, frame = 81, voice = 2, prefix }) {
  const g = {
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf' } },
    2: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 5 } },
    3: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'wan2.1-i2v-14b-720p-Q4_K_M.gguf' } },
    4: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['3', 0], lora_name: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', strength_model: 1 } },
    5: { class_type: 'ModelSamplingSD3', inputs: { model: ['4', 0], shift: 5 } },
    6: { class_type: 'ModelPatchLoader', inputs: { name: 'wan2.1_infiniteTalk_multi_fp16.safetensors' } },
    7: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } },
    8: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    9: { class_type: 'CLIPTextEncode', inputs: { clip: ['7', 0], text: text } },
    10: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['9', 0] } },
    11: { class_type: 'LoadImage', inputs: { image: picture } },
    12: { class_type: 'AudioEncoderLoader', inputs: { audio_encoder_name: 'wav2vec2-chinese-base_fp16.safetensors' } },
    13: { class_type: 'LoadAudio', inputs: { audio: voice1 } },
    14: { class_type: 'LoadAudio', inputs: { audio: voice2 } },
    15: { class_type: 'AudioEncoderEncode', inputs: { audio_encoder: ['12', 0], audio: ['13', 0] } },
    16: { class_type: 'AudioEncoderEncode', inputs: { audio_encoder: ['12', 0], audio: ['14', 0] } },
  };
  // Konusmaci maskeleri: siyah zemine beyaz kutu (bos maske: o konusmaciya hicbir bolge baglanmaz)
  [mask1, mask2].forEach((m, i) => {
    const d = 40 + i * 3;
    g[d] = { class_type: 'SolidMask', inputs: { value: 0, width: width, height: height } };
    if (!m) return;
    g[d + 1] = { class_type: 'SolidMask', inputs: { value: 1, width: m[2], height: m[3] } };
    g[d + 2] = { class_type: 'MaskComposite', inputs: { destination: [String(d), 0], source: [String(d + 1), 0], x: m[0], y: m[1], operation: 'add' } };
  });
  const mask = (i, m) => [String(m ? 42 + i * 3 : 40 + i * 3), 0];
  let previous = null;
  if (motions?.length) {
    motions.forEach((h, i) => {
      g[100 + i] = { class_type: 'LoadImage', inputs: { image: h } };
    });
    previous = ['100', 0];
    for (let i = 1; i < motions.length; i++) {
      g[150 + i] = { class_type: 'ImageBatch', inputs: { image1: previous, image2: [String(100 + i), 0] } };
      previous = [String(150 + i), 0];
    }
  }
  g[20] = {
    class_type: 'WanInfiniteTalkToVideo',
    inputs: {
      mode: 'two_speakers', 'mode.audio_encoder_output_2': ['16', 0], 'mode.mask_1': mask(0, mask1), 'mode.mask_2': mask(1, mask2),
      model: ['5', 0], model_patch: ['6', 0], positive: ['9', 0], negative: ['10', 0], vae: ['8', 0], width: width, height: height, length: frame,
      start_image: ['11', 0], audio_encoder_output_1: ['15', 0], motion_frame_count: motions?.length || 9, audio_scale: voice,
      ...(previous ? { previous_frames: previous } : {}),
    },
  };
  // Wan 2.2 asamasi devam penceresinde hareket karelerinden baslar (InfiniteTalk'in start_image'i hep kaynak gorsel)
  g[21] = { class_type: 'WanImageToVideo', inputs: { positive: ['9', 0], negative: ['10', 0], vae: ['8', 0], width: width, height: height, length: frame, batch_size: 1, start_image: previous ?? ['11', 0] } };
  g[22] = {
    class_type: 'KSamplerAdvanced',
    inputs: {
      model: ['2', 0], add_noise: 'enable', noise_seed: seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
      positive: ['21', 0], negative: ['21', 1], latent_image: ['21', 2], start_at_step: 0, end_at_step: 2, return_with_leftover_noise: 'enable',
    },
  };
  g[23] = {
    class_type: 'KSamplerAdvanced',
    inputs: {
      model: ['20', 0], add_noise: 'disable', noise_seed: seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
      positive: ['20', 1], negative: ['20', 2], latent_image: ['22', 0], start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: 'disable',
    },
  };
  g[24] = { class_type: 'VAEDecode', inputs: { samples: ['23', 0], vae: ['8', 0] } };
  // Renk kaymasi: devam pencereleri oncekinin karelerinden basladigi icin hata birikir (olculdu: 3 pencerede parlaklik
  // 118 -> 95, 2. pencere basinda sicrama). Her kare kaynak gorselin renklerine eslenir; sonraki pencere duzeltilmis
  // karelerden baslar.
  g[27] = { class_type: 'ColorTransfer', inputs: { image_target: ['24', 0], image_ref: ['11', 0], method: 'mkl_lab', source_stats: 'per_frame', strength: 1 } };
  if (previous) g[25] = { class_type: 'ImageFromBatch', inputs: { image: ['27', 0], batch_index: motions.length, length: frame - motions.length } };
  g[26] = { class_type: 'SaveImage', inputs: { images: [previous ? '25' : '27', 0], filename_prefix: prefix } };
  return g;
}

/**
 * ACE-Step 1.5 Turbo: metinden muzik (Comfy-Org sablonu audio_ace_step_1_5_split ile ayni).
 * tarz: tur/enstruman/duygu tarifi (Ingilizce en iyi); sozler: bossa "[Instrumental]" (sozsuz).
 * sure saniye (en cok 1000); 8 adim, cfg 1, AuraFlow kaydirma 3; cikti MP3 (V0).
 */
/**
 * Sarki duzenleme (remiks / cover): verilen sarki ACE-Step VAE'siyle kodlanir, yeni tarz (ve
 * istenirse yeni sozler) ile kismen yeniden uretilir. guc (denoise) 0,2-0,9: dusuk = ozgun sarkiya
 * yakin (sound degisir, melodi kalir), yuksek = serbest yorum. ses: ComfyUI input'taki dosya adi.
 */
export function songEditJob({ voice, style, lyrics = '', duration = 60, seed, bpm = 120, language = 'en', strength = 0.5, prefix }) {
  const g = musicJob({ style, lyrics, duration, seed, bpm, language, prefix });
  g[11] = { class_type: 'LoadAudio', inputs: { audio: voice } };
  g[12] = { class_type: 'VAEEncodeAudio', inputs: { audio: ['11', 0], vae: ['3', 0] } };
  delete g[7];
  g[8].inputs.latent_image = ['12', 0];
  g[8].inputs.denoise = strength;
  return g;
}

export function musicJob({ style, lyrics = '', duration = 60, seed, bpm = 120, language = 'en', prefix }) {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'acestep_v1.5_turbo.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'qwen_0.6b_ace15.safetensors', clip_name2: 'qwen_1.7b_ace15.safetensors', type: 'ace', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'ace_1.5_vae.safetensors' } },
    4: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
    5: {
      class_type: 'TextEncodeAceStepAudio1.5',
      inputs: {
        clip: ['2', 0], tags: style, lyrics: lyrics.trim() || '[Instrumental]', seed: seed, bpm, duration: duration,
        timesignature: '4', language: language, keyscale: 'C major', generate_audio_codes: true,
        cfg_scale: 2, temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0,
      },
    },
    6: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
    7: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: duration, batch_size: 1 } },
    8: {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        seed: seed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      },
    },
    9: { class_type: 'VAEDecodeAudio', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveAudioMP3', inputs: { audio: ['9', 0], filename_prefix: prefix, quality: 'V0' } },
  };
}

/**
 * Gorselden 3D model: TRELLIS.2 (Microsoft, MIT; ComfyUI 0.37 yerlesik dugumleri, Comfy-Org sablonu
 * 3d_pixal3d_trellis2_image_to_model'in Trellis2 kolu). Arka plan BiRefNet ile silinir, nesne
 * kirpilir; yapi -> sekil (512) -> sekil buyutme (ayrinti) -> doku asamalari, sonra yeniden orgu,
 * seyreltme, UV acma ve PBR doku pisirme (renk, metal, puruzluluk, normal, AO). Cikti dokulu GLB.
 * ayrinti: sekil buyutme (1024-2048; renk ayrintisi da buradan); orgu: yeniden orgu izgarasi (sablon 768);
 * yuzey: hedef ucgen sayisi; doku: doku kenari (piksel).
 * kip: 'trellis' (TRELLIS.2) | 'pixal' (Pixal3D, TencentARC, MIT: ayni hat, kosul gorsele piksel hizali; kamera
 * acisi MoGe-2 ile kestirilir; sablonun varsayilan kolu).
 * gorunusler: { left, back, right } (ComfyUI input dosya adlari; resim on gorunus) verilirse Pixal3D cok gorunuslu
 * model: arka ve yanlar tahmin yerine bu gorsellerden (sablon 3d_pixal3d_multi_views; gorus acisi MoGe-2 ile).
 * int8 agirliklar: bf16 (11 GB) 16 GB RAM'de yuklenirken ComfyUI'yi cokertti (access violation, 04.10.2026).
 */
export function trellis2Job({ picture, appearances = null, seed = 0, prefix, mode = 'trellis', detail = 1536, mesh = 768, surface = 500000, texture = 4096, deleteBackPlan = true }) {
  const example = (model, condition, latent, step, cfg, timer = 'normal') => ({
    class_type: 'KSampler',
    inputs: { model, positive: [condition, 0], negative: [condition, 1], latent_image: latent, seed: seed, steps: step, cfg, sampler_name: 'euler', scheduler: timer, denoise: 1 },
  });
  const pixal = mode === 'pixal' || Boolean(appearances);
  const g = {
    1: { class_type: 'LoadImage', inputs: { image: picture } },
    2: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: 'birefnet.safetensors' } },
    3: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['2', 0], image: ['1', 0] } },
    4: { class_type: 'ImageCropToMask', inputs: { images: ['1', 0], masks: deleteBackPlan ? ['3', 0] : ['1', 1], width: 1024, height: 1024, pad_factor: 1.1, grow_mask: 0, background: '#000000' } },
    5: { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'dino_v3_L_naf_fp32.safetensors' } },
    6: { class_type: 'Trellis2Conditioning', inputs: { clip_vision_model: ['5', 0], image: ['4', 0] } },
    7: { class_type: 'UNETLoader', inputs: { unet_name: `${appearances ? 'pixal3d_multiview' : pixal ? 'pixal3d' : 'trellis_2'}_int8_convrot.safetensors`, weight_dtype: 'default' } },
    // Sablonun CFG ayarlari (ozgun hattin varsayilanlari): yapi ve sekil icin ayri.
    8: { class_type: 'CFGOverride', inputs: { model: ['7', 0], cfg: 1, start_percent: 0.667, end_percent: 1 } },
    9: { class_type: 'RescaleCFG', inputs: { model: ['8', 0], multiplier: 0.7 } },
    10: { class_type: 'ModelSamplingSD3', inputs: { model: ['9', 0], shift: 5 } },
    11: { class_type: 'VAELoader', inputs: { vae_name: 'trellis_2_shape_vae_bf16.safetensors' } },
    12: { class_type: 'VAELoader', inputs: { vae_name: 'trellis_2_texture_vae_bf16.safetensors' } },
    13: { class_type: 'EmptyTrellis2LatentStructure', inputs: { batch_size: 1 } },
    14: example(['10', 0], '6', ['13', 0], 12, 7.5),
    15: { class_type: 'VaeDecodeStructureTrellis2', inputs: { samples: ['14', 0], vae: ['11', 0], resolution: '32' } },
    16: { class_type: 'Trellis2ShapeStage', inputs: { positive: ['6', 0], negative: ['6', 1], voxel: ['15', 0] } },
    17: { class_type: 'CFGOverride', inputs: { model: ['7', 0], cfg: 1, start_percent: 0.769, end_percent: 1 } },
    18: { class_type: 'RescaleCFG', inputs: { model: ['17', 0], multiplier: 0.5 } },
    19: example(['18', 0], '16', ['16', 2], 20, 7.5),
    20: { class_type: 'Trellis2UpsampleStage', inputs: { positive: ['16', 0], negative: ['16', 1], shape_latent: ['19', 0], vae: ['11', 0], target_resolution: detail } },
    21: example(['18', 0], '20', ['20', 2], 12, 7.5, 'simple'),
    22: { class_type: 'VaeDecodeShapeTrellis', inputs: { samples: ['21', 0], vae: ['11', 0] } },
    23: { class_type: 'Trellis2TextureStage', inputs: { positive: ['20', 0], negative: ['20', 1], shape_latent: ['21', 0] } },
    24: example(['7', 0], '23', ['23', 2], 12, 1),
    25: { class_type: 'VaeDecodeTextureTrellis', inputs: { samples: ['24', 0], vae: ['12', 0], shape_subdivides: ['22', 1] } },
    26: {
      class_type: 'RemeshMesh',
      inputs: {
        mesh: ['22', 0], resolution: mesh, sign_mode: 'udf', 'sign_mode.qef': false, 'sign_mode.drop_inverted_components': false, 'sign_mode.drop_enclosed_components': false,
        band: 1, project_back: 0, fix_poles: false, smooth_iters: 20, drop_small_components: 0.01, precluster_max_verts: 20000000,
      },
    },
    27: { class_type: 'DecimateMesh', inputs: { mesh: ['26', 0], target_face_count: surface, placement_mode: 'midpoint' } },
    28: { class_type: 'MeshSmoothNormals', inputs: { mesh: ['27', 0], crease_angle: 180 } },
    29: { class_type: 'UnwrapMesh', inputs: { mesh: ['28', 0], segmenter: 'pec', resolution: texture, padding: 1, weld_distance: 0.0002 } },
    30: { class_type: 'BakeTextureFromVoxel', inputs: { mesh: ['29', 0], voxel_colors: ['25', 0], texture_size: texture, reference_mesh: ['22', 0] } },
    31: { class_type: 'BakeNormalMapFromMesh', inputs: { low_poly: ['29', 0], high_poly: ['26', 0], resolution: texture, cage_distance: 0.05, ignore_backfaces: true } },
    32: { class_type: 'BakeAmbientOcclusion', inputs: { low_poly: ['29', 0], high_poly: ['26', 0], resolution: 1024, samples: 64, max_distance: 0.71, strength: 1, bias: 0.01 } },
    33: { class_type: 'ApplyTextureToMesh', inputs: { mesh: ['29', 0], base_color: ['30', 0], metallic: ['30', 1], roughness: ['30', 2], occlusion: ['32', 0], normal_map: ['31', 0] } },
    34: { class_type: 'MeshSmoothNormals', inputs: { mesh: ['33', 0], crease_angle: 180 } },
    35: { class_type: 'SaveGLB', inputs: { mesh: ['34', 0], filename_prefix: prefix } },
    // Kirpilmis girdi (arka plani silinmis): panelde "modelin cikarildigi gorsel" olarak gosterilir.
    36: { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: `${prefix}_girdi` } },
  };
  if (appearances) {
    // Her gorunus ayni hazirlik: arka plan silinir, nesne kareye 1/1.1 olcekle kirpilir.
    // Gorus acisi on gorunusten MoGe-2 ile (uretilmis gorseller fotograf perspektifinde; sabit 20 ile on doku arkaya sizdi).
    const condition = { clip_vision_model: ['5', 0], fov: ['39', 0], front: ['4', 0] };
    ['left', 'back', 'right'].forEach((direction, i) => {
      if (!appearances[direction]) return;
      const [y, a, k] = [40 + i * 3, 41 + i * 3, 42 + i * 3];
      g[y] = { class_type: 'LoadImage', inputs: { image: appearances[direction] } };
      g[a] = { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['2', 0], image: [String(y), 0] } };
      g[k] = { class_type: 'ImageCropToMask', inputs: { images: [String(y), 0], masks: [String(a), 0], width: 1024, height: 1024, pad_factor: 1.1, grow_mask: 0, background: '#000000' } };
      condition[direction] = [String(k), 0];
    });
    g[6] = { class_type: 'Pixal3DMultiViewConditioning', inputs: condition };
  }
  if (pixal) {
    g[37] = { class_type: 'LoadMoGeModel', inputs: { model_name: 'moge_2_vitl_normal_fp16.safetensors' } };
    g[38] = { class_type: 'MoGeInference', inputs: { moge_model: ['37', 0], image: ['4', 0], resolution_level: 9, fov_x_degrees: 0, batch_size: 4, force_projection: true, apply_mask: true, refine_steps: 3 } };
    g[39] = { class_type: 'MoGeGeometryToFOV', inputs: { moge_geometry: ['38', 0], axis: 'horizontal', unit: 'degrees' } };
    if (!appearances) g[6] = { class_type: 'Pixal3DConditioning', inputs: { clip_vision_model: ['5', 0], image: ['4', 0], camera_angle_x: ['39', 0] } };
  }
  return g;
}
