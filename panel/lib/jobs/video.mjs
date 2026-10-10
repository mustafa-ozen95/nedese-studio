/**
 * Video isi: kaynak gorselden Wan 2.2 ile klip. Sure sinirsiz: video ~5 sn'lik parcalar
 * halinde uretilir (A14B 81 kare @16 fps en iyi kalite), her parca oncekinin son karesinden
 * surer, bitince parcalar yeniden kodlanmadan eklenir (concat listesi).
 *
 * Uzun is icin dayaniklilik:
 * - Her parca bitince hemen mp4'e kodlanir ve kareleri silinir (parcalar\pNNNN.mp4); PNG'ler
 *   birikmez. Durum parcalar\durum.json'da: yeniden deneme / panel yeniden acilisi son biten
 *   parcadan surer (plan degismediyse).
 * - Her parcadan once bos disk denetlenir (en az 3 GB); azsa acik Turkce hatayla durur,
 *   "Yeniden dene" kaldigi yerden surdurur.
 * - Renk sabitleme: devam parcasinin baslangic karesi kaynak gorselin renk istatistigine
 *   cekilir (biriken renk/parlaklik kaymasi sifirlanir; icerik kaymasi tamamen onlenemez).
 * - Ilerleme "parca 37/720 · kalan ≈ 2 sa 10 dk" (bu isteki olculen parca suresinden).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { merge, nodes } from '../graph.mjs';
import { runFfmpeg, framesToMp4, makePreview, concatParts, matchColor, measureColor, videoEncoder } from '../ffmpeg.mjs';
import { UserError } from '../errors.mjs';
import { imageSize, orientation } from '../media.mjs';
import { diskStatus } from '../models.mjs';
import { partTotalFrame, durationText, videoParts } from '../plan.mjs';
import { IMAGE_MODELS, OUTPUT_1080P, RATIOS, RIFE_MAX, VIDEO_MODELS, yes, validateFps, sourcePath, trimmedSize, rifeFactor, text, number, choice, seed, generatorRequired } from './common.mjs';
import { upscaleModelRequired, upscaleFrames } from './upscale.mjs';
import { runWan } from './wan.mjs';
import { jobPrompt, partPrompts } from '../prompt-translate.mjs';
import { trainedModels } from './training.mjs';
import { fineSetting } from '../fine-settings.mjs';

export const name = 'Video';

const DEFAULT_MOTION = 'natural subtle motion, gentle camera movement, cinematic';
// Kimlik koruma: devam parcasinin baslangic karesi kaynaktaki karakterle yeniden hizalanir (Qwen-Image-Edit, 2 gorsel).
// Kedi videosunda kostum parcalar arasinda kayboluyordu (kare disina cikan karakter geri donunce baska kiyafetle).
const ID_PROMPT = 'Image 1 is a frame from a video. Make every character in image 1 look exactly like the same character in image 2: same face, fur or skin, costume, armor, colors and accessories. Keep everything else in image 1 unchanged: pose, position, size, camera angle, background, lighting and composition.';
const FRAMING_EXTRA = 'Keep the main character fully in frame with the same appearance throughout.';
// Anahtar kare: her parcanin bitis karesi temiz kaynaktan (tek gorsel) duzenlenir, parca ilk-son kare arasinda uretilir;
// kimlik her parcanin iki ucunda kaynaga bagli kalir. Olculdu 06.10.2026: son kareden zincirlemede DINOv2 kaynak
// benzerligi 0-5 / 5-10 / 10-15 sn 0,88 / 0,68 / 0,53; bozulmus kareyi kaynakla birlestiren kimlik koruma karakteri cogaltti.
// "Each character only once": ilk denemede "yana atlayarak siyriliyor" eylemi iki kediyle cizildi (06.10.2026)
const keyPrompt = (s) => `Show the same scene a few seconds later, at the end of this action: ${String(s).replace(/[.\s]+$/, '')}. Show each character only once: do not add new characters, copies or duplicates. Keep every character exactly as in the image: same face, fur or skin, costume, armor, colors and accessories, same art style and lighting. Keep the main character fully in frame.`;
// Kopya denetimi: tek gorselli Qwen-Image-Edit buyuk hareketli eylemde karakteri ikiliyor (06.10.2026: "yana atlayarak
// siyriliyor" 12/12 ornekte iki kedi; istem degisikligi duzeltmedi). Yerel gorsel yazi modeli karakterleri turune gore sayar;
// anahtar karede bir tur kaynaktakinden coksa kare kullanilmaz, o parca bitis karesiz (zincir) uretilir. Model once liste
// yazar, sonra sayar: iki gorselli dogrudan sayi sorusu iki kedili kareleri "1" saymisti; listeli soru 15 karede 15 dogru.
// Tur adi ozel olmali: "animal / creature" denince ejder de "animal" sayiliyordu (06.10.2026 ilk gercek koşu)
const INVENTORY_PROMPT = 'List every character in this image: people, animals, creatures and robots (ignore statues, paintings and reflections). Write one line per character: <kind> | <position> | <appearance>, where <kind> is the most specific everyday noun for it, such as kitten, dragon, girl, old man, horse or robot, never a general word like animal, creature, person or character. Then write one final line per kind: <kind> = <number>.';
const countPrompt = (types) => `Count the characters in this image. Kinds to count: ${types.join(', ')} (use exactly these names). List every one you see, one line each: <kind> | <position> | <appearance>. Then write one final line per kind: <kind> = <number>.`;
// Kalabalik tur (5+) sayilmaz: model sayimi orada guvenilmez, kopya da goze batmaz
const COUNT_MAX = 4;
const typeName = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/(?<=\w{3})s$/, '');
const MIN_FREE_DISK = 3 * 2 ** 30;

/** Yazi modeli yanitindaki "<tur> = <sayi>" satirlari -> { tur: sayi } (tur tekil, kucuk harf). Liste satirlari ("|") ve toplam sayilmaz. */
export function splitCount(text) {
  const result = {};
  for (const m of String(text ?? '').matchAll(/^[\s*•-]*([A-Za-z][A-Za-z '-]{0,40}?)\s*\**\s*[=:]\s*\**\s*(\d{1,3})\s*\**\s*$/gm)) {
    const type = typeName(m[1]);
    if (!/^(total|count|number|character)$/.test(type)) result[type] = Number(m[2]);
  }
  return result;
}

export function validate(g, { mod, setting }) {
  const model = choice(g.model, 'Model', Object.keys(VIDEO_MODELS), 'wan14');
  if (g.lora && model !== 'wan5') throw new UserError('The selected LoRA was trained for Wan 2.2 5B; choose Wan 2.2 5B as the model.');
  generatorRequired(mod, VIDEO_MODELS[model].generator, VIDEO_MODELS[model].name, setting?.modelRoot);
  const source = String(g.source ?? '');
  // Without a source image the video is made from text: an image model draws the first frame (frame.png, kept in the job
  // folder for a retry, not an output), then the usual image-to-video flow runs on it.
  const fromText = source ? null : textFrame(g, { mod, setting });
  const size = fromText ? { width: fromText.width, height: fromText.height } : imageSize(sourcePath(setting.outputRoot, source));
  if (!size) throw new UserError('Could not read the source image size.');
  const resolution = choice(g.resolution, 'Resolution', ['720p', '480p', '1080p'], '720p');
  // 1080p: ince ayar "Dogrudan 1080p" acik (guclu kart) -> Wan 1920x1088 uretir, 1080'e kirpilir. Kapali (12 GB
  // varsayilani; dogrudan 1080p bu kartta sigmadi, olculdu 06.10.2026) -> 720p uretilir, kareler 2x modelle buyutulur.
  const direct = resolution === '1080p' && fineSetting('video1080p');
  const upscale = resolution === '1080p' && !direct;
  const direction = orientation(size);
  const [width, height] = VIDEO_MODELS[model].size[upscale ? '720p' : resolution][direction];
  const [outputWidth, outputHeight] = upscale ? OUTPUT_1080P[direction] : trimmedSize([width, height]);
  if (upscale) upscaleModelRequired(setting);
  // Sure sinirsiz (saniye): uzun video parca parca uretilir.
  const duration = number(g.duration, 'Duration', { min: 1, defaultValue: 5 });
  const vm = VIDEO_MODELS[model];
  // Panelde egitilmis video LoRA'si (Model egitimi > Video): yalniz Wan 2.2 5B ile
  let lora = null;
  if (g.lora) {
    const m = trainedModels(setting?.aiRoot ?? '').find((x) => x.field === 'video' && (x.lora === g.lora || x.id === g.lora || `trained:${x.id}` === g.lora));
    if (!m) throw new UserError(`Trained video LoRA not found: ${String(g.lora).slice(0, 80)}`);
    lora = { file: m.lora, name: m.name, trigger: m.trigger ?? '', strength: number(g.loraStrength, 'LoRA strength', { min: 0, max: 2, defaultValue: 1 }) };
  }
  // fps bos: modelin dogal hizi (eski isler akici ile gelir).
  const fps = validateFps(g.fps);
  const parts = videoParts(duration, vm.frame, vm.fps);
  // Anahtar kare (yalniz A14B: ilk-son kare): cok parcali A14B videoda varsayilan acik. Olculdu 06.10.2026 (60 sn, ayni 12
  // istem, 720p): zincirde kedi 12. sn'den sonra kiyafetini kaybetti (60 karenin 25'inde; ejder kizila dondu, sonda kedi
  // kayboldu), anahtar karede 4'unde; kopya karakter ikisinde 0; sure 4498 -> 6648 sn. Baska modelde ve tek parcada yok
  // sayilir (form kutuyu hep gonderir); Qwen-Image-Edit yoksa zincirle surer. Acikca istenen kimlik koruma varsayilani kapatir.
  const keyRequested = g.keyFrame === undefined || g.keyFrame === null || g.keyFrame === '' ? !yes(g.idProtect) : yes(g.keyFrame);
  let keyFrame = keyRequested && model === 'wan14' && parts.length > 1;
  let noKeyFrame = null;
  if (keyFrame) {
    try {
      generatorRequired(mod, 'editJob', 'Keyframes (Qwen-Image-Edit)', setting?.modelRoot);
    } catch (e) {
      keyFrame = false;
      noKeyFrame = e.message;
    }
  }
  // Kimlik koruma (istege bagli; olculdu: karakteri cogaltti): anahtar kare aciksa kullanilmaz
  const idProtect = yes(g.idProtect) && !keyFrame;
  if (idProtect) generatorRequired(mod, 'editJob', 'Character consistency (Qwen-Image-Edit)', setting?.modelRoot);
  return {
    source: source || null,
    ...(fromText ? { fromText } : {}),
    prompt: text(g.prompt, 'Motion prompt', { required: false, max: 2000 }) || DEFAULT_MOTION,
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    model,
    duration,
    frame: parts[0],
    part: parts.length,
    resolution,
    width,
    height,
    // 1080p: dogrudan (uretim 1088, cikti 1080 kirpilir) ya da 720p uretip buyutme
    ...(upscale ? { upscale: [outputWidth, outputHeight] } : outputWidth !== width || outputHeight !== height ? { truncate: [outputWidth, outputHeight] } : {}),
    smooth: fps ? rifeFactor(vm.fps, fps) : number(g.smooth, 'Interpolation', { min: 1, max: RIFE_MAX, full: true, defaultValue: 1 }),
    fps,
    colorPin: yes(g.colorPin ?? true),
    ...(idProtect ? { idProtect: true } : {}),
    ...(keyFrame ? { keyFrame: true } : noKeyFrame ? { noKeyFrame } : {}),
    // Wan understands Turkish poorly: the prompt is translated to English.
    translate: yes(g.translate ?? true),
    seed: seed(g.seed),
    ...(lora ? { lora } : {}),
  };
}

/** The first frame of a text-only video: { image, imageModel, ratio, width, height } (the image prompt defaults to the motion prompt). */
function textFrame(g, { mod, setting }) {
  const image = String(g.image ?? '').trim() || String(g.prompt ?? '').trim();
  if (!image) throw new UserError('Choose a source image (upload one or pick from the gallery), or write a prompt to make the video from text.');
  text(image, 'Prompt', { max: 2000 });
  // Default image model: Qwen-Image like the film, FLUX.2 klein when Qwen-Image is not on this machine
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
  const ratio = choice(g.ratio, 'Aspect ratio', Object.keys(RATIOS), '16:9');
  const [width, height] = RATIOS[ratio][imageModel];
  return { image, imageModel, ratio, width, height };
}

export function summary(g) {
  return {
    title: g.title || g.prompt,
    detail: `${g.fromText ? 'From text · ' : ''}${VIDEO_MODELS[g.model]?.name ?? g.model}${g.lora ? ` + ${g.lora.name}` : ''} · ${(g.upscale ?? g.truncate ?? [g.width, g.height]).join('×')}${g.upscale ? ' (720p upscale)' : ''} · ${durationText(g.duration)}${g.part > 1 ? ` (${g.part} parts)` : ''}${g.fps ? ` · ${g.fps} fps` : g.smooth > 1 ? ` · RIFE ${g.smooth}×` : ''}${g.idProtect && g.part > 1 ? ' · identity protected' : ''}${g.keyFrame && g.part > 1 ? ' · keyframes' : ''}`,
  };
}

const no4 = (i) => String(i).padStart(4, '0');

export async function run(ctx) {
  const g = ctx.job.input;
  const k = ctx.folder;
  const vm = VIDEO_MODELS[g.model];
  const source = g.fromText ? join(k, 'frame.png') : sourcePath(ctx.setting.outputRoot, g.source);
  if (g.fromText && !existsSync(source)) await drawFrame(ctx, source);
  const parts = videoParts(g.duration, vm.frame, vm.fps);
  const n = parts.length;
  const frameFps = vm.fps * Math.max(1, g.smooth);
  const pFolder = join(k, 'parts');
  const frames = join(pFolder, 'frames');
  const statusPath = join(pFolder, 'checkpoint.json');
  const signature = `${g.model}|${g.width}x${g.height}|${g.smooth}|${g.fps ?? ''}|${parts.join(',')}|${g.colorPin ? 'r' : ''}${g.idProtect ? 'k' : ''}${g.keyFrame ? 'a' : ''}`;
  mkdirSync(pFolder, { recursive: true });

  // Kaldigi yerden: plan ayniysa biten parcalar yerinde (mp4 + son kare).
  let status = { signature, finished: 0, durations: [] };
  try {
    const read = JSON.parse(readFileSync(statusPath, 'utf8'));
    if (read.signature === signature) status = { ...status, ...read };
  } catch {
    /* ilk calisma */
  }
  while (status.finished > 0 && !(existsSync(join(pFolder, `p${no4(status.finished)}.mp4`)) && existsSync(join(pFolder, `p${no4(status.finished)}.last.png`)))) status.finished -= 1;
  if (status.finished > 0) ctx.log(`Resuming: ${status.finished}/${n} parts ready.`);
  else if (g.noKeyFrame) ctx.log(`Keyframes unavailable (${g.noKeyFrame}); parts continue from the last frame (chained).`);
  const save = () => writeFileSync(statusPath, JSON.stringify(status), 'utf8');

  // Parca istemleri bir kez (yeniden denemede saklanan kullanilir): Ingilizce, uzun videoda her parca
  // oncekinin devami (ayni istem her parcada eylemi bastan yaptiriyordu). Eski islerde cevir alani yok: cevrilir.
  if (!Array.isArray(ctx.job.prompts)) {
    if (typeof ctx.job.promptEnglish === 'string') ctx.job.prompts = [ctx.job.promptEnglish];
    else {
      const c = await partPrompts(g.prompt, n, { translate: g.translate !== false, signal: ctx.signal });
      ctx.job.prompts = c.prompts;
      if (c.translated) c.prompts.forEach((x, i) => ctx.log(n > 1 ? `Segment ${i + 1} prompt: ${x}` : `Prompt translated to English: ${x}`));
      else if (c.error) ctx.log(`Prompt could not be translated (${c.error}); ${n > 1 ? 'continuation segments proceed with calm motion' : 'used as is'}.`);
    }
    ctx.save();
  }
  // Egitilmis LoRA'nin tetik kelimesi (Ingilizce istemden sonra) istemde yoksa basa eklenir
  const withTrigger = (s) => (g.lora?.trigger && !s.toLowerCase().includes(g.lora.trigger.toLowerCase()) ? `${g.lora.trigger}, ${s}` : s);
  const getPrompt = (p) => {
    const s_ = withTrigger(ctx.job.prompts[Math.min(p, ctx.job.prompts.length - 1)]);
    return g.idProtect && p > 0 ? `${s_.replace(/[.\s]+$/, '')}. ${FRAMING_EXTRA}` : s_;
  };
  // Parçalar yeniden kodlanmadan eklenir: bir işin bütün parçaları aynı kodlayıcıyla (durumda saklı;
  // kodlayıcı alanı olmayan eski yarım işler x264 ile sürer).
  status.encoder ??= status.finished > 0 ? 'x264' : await videoEncoder(ctx.setting.ffmpeg, ctx.setting.encoder);
  if (status.finished === 0 && status.encoder === 'nvenc') ctx.log('Part encoder: NVENC (graphics card)');

  // Renk sabitleme: kaynak gorselin istatistigi bir kez olculur.
  let sourceColor = null;
  if (g.colorPin && n > 1) {
    try {
      sourceColor = await measureColor(ctx.setting.ffmpeg, source);
    } catch (e) {
      ctx.log(`Color stabilization off (could not measure): ${e.message}`);
    }
  }

  // Anahtar kareler: her parcanin bitis karesi (a0001 = 1. parcanin sonu) kaynaktan; gerektikce 8'erli gruplarla tek ComfyUI
  // isteginde (uzun videoda yuzlercesi tek istekte olmasin; uretilenler diskte kalir, kaldigi yerden surer).
  const KEY_GROUP = 8;
  const keyPath = (i) => join(pFolder, `a${no4(i)}.png`);
  let keySource = null;
  async function prepareKeys(first) {
    const missing = [];
    for (let i = first; i <= n && missing.length < KEY_GROUP; i++) if (!existsSync(keyPath(i))) missing.push(i);
    if (!missing.length) return;
    const kb = Date.now();
    // Once Wan modelleri bellekten: 16 GB RAM'de Wan + Qwen-Image-Edit (12,7 GB) + metin kodlayicisi (7,9 GB) sayfa dosyasina
    // tasiyordu (06.10.2026: Wan yukluyken anahtar kare basina ~150 sn, temiz ComfyUI'de ~80 sn)
    await ctx.comfy.flush().catch(() => {});
    keySource ??= await ctx.comfy.load(source, `panel_${ctx.job.id}_key_source${extname(source).toLowerCase() || '.png'}`);
    const graphs = missing.map((i) => ctx.mod.editJob({ pictures: [keySource], text: keyPrompt(ctx.job.prompts[Math.min(i - 1, ctx.job.prompts.length - 1)]), seed: g.seed + 700 + i, prefix: `panel/${ctx.job.id}/key${no4(i)}` }));
    const { job: combined, match } = merge(graphs);
    const records = graphs.map((gr, j) => match[j][nodes(gr, 'SaveImage')[0]]);
    const rangeStart = (90 * (first - 1)) / n;
    const output = await ctx.runComfy(combined, { stage: `Video · keyframes ${missing[0]}-${missing.at(-1)}/${n}`, range: [rangeStart, rangeStart + 1] });
    for (const [j, i] of missing.entries()) {
      const list = images(output, records[j]);
      if (!list.length) throw new Error(`Keyframe ${i} could not be generated (Qwen-Image-Edit returned no image)`);
      const temp = join(pFolder, `a${no4(i)}.temp.png`);
      await ctx.comfy.getOutput(list[0], temp);
      // Renk sabitleme: anahtar kare de kaynagin renk istatistigine cekilir
      if (sourceColor) {
        try {
          const corrected = join(pFolder, `a${no4(i)}.colour.png`);
          await matchColor(ctx.setting.ffmpeg, temp, corrected, sourceColor, await measureColor(ctx.setting.ffmpeg, temp), { signal: ctx.signal });
          renameSync(corrected, temp);
        } catch (e) {
          ctx.log(`Keyframe ${i}: color correction skipped (${e.message}).`);
        }
      }
      renameSync(temp, keyPath(i));
    }
    ctx.log(`${missing.length} keyframe${missing.length > 1 ? 's' : ''} generated from the source (${missing[0]}-${missing.at(-1)}/${n}, ${Math.round((Date.now() - kb) / 1000)} s).`);
    // Kopya denetimi grup bitince toplu: yazi modeli bir kez yuklenir (ekran karti ComfyUI ile paylasilir)
    for (const i of missing) await checkKey(i);
    // Arayuzdeki sure tahmini icin: anahtar kare basina (uretim + kopya denetimi)
    ctx.measure('video/key', (Date.now() - kb) / 1000 / missing.length);
  }
  // Kopya denetimi (yukarida): karar durumda saklanir, yeniden denemede yeniden sorulmaz
  status.keyControl ??= {};
  let noControl = false;
  async function askImage(path, prompt) {
    const jpg = join(pFolder, 'check.jpg');
    await runFfmpeg(ctx.setting.ffmpeg, ['-y', '-i', path, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', jpg], { signal: ctx.signal });
    const r = await ctx.llm.req('/v1/chat/completions', {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${readFileSync(jpg).toString('base64')}` } }, { type: 'text', text: prompt }] }],
      temperature: 0, max_tokens: 400, chat_template_kwargs: { enable_thinking: false }, stream: false,
    }, { externalRequest: false });
    if (r.code !== 200) throw new Error(r.json?.error?.message ?? `Text model HTTP ${r.code}`);
    return String(r.json?.choices?.[0]?.message?.content ?? '');
  }
  /** Anahtar kare i: 'ok' | 'copy' (kullanilmaz) | 'unchecked' (yazi modeli yok, okunamadi ya da kaynakta karakter yok). */
  async function checkKey(i) {
    if (status.keyControl[i]) return status.keyControl[i];
    let decision = 'unchecked';
    if (!ctx.llm?.installed || !ctx.llm.understandsImages) {
      if (!noControl) ctx.log('Duplicate check unavailable: the selected text model cannot read images (Settings > Text model); keyframes are used unchecked.');
      noControl = true;
    } else {
      try {
        if (!status.characters) {
          const count = splitCount(await askImage(source, INVENTORY_PROMPT));
          status.characters = Object.fromEntries(Object.entries(count).filter(([, s]) => s > 0 && s <= COUNT_MAX));
          save();
          const list = Object.entries(status.characters).map(([t, s]) => `${s} ${t}`).join(', ');
          ctx.log(list ? `Characters in the source: ${list} (keyframes are checked for duplicates).` : 'No countable character in the source; keyframes are not checked for duplicates.');
        }
        const types = Object.keys(status.characters);
        if (types.length) {
          const count = splitCount(await askImage(keyPath(i), countPrompt(types)));
          const max = types.filter((t) => count[t] > status.characters[t]);
          decision = max.length ? 'copy' : types.some((t) => Number.isFinite(count[t])) ? 'ok' : 'unchecked';
          const seen = types.map((t) => `${count[t] ?? '?'} ${t}`).join(', ');
          if (decision === 'copy') ctx.log(`Keyframe ${i}: ${seen} (source: ${max.map((t) => `${status.characters[t]} ${t}`).join(', ')}): character duplicated, not used; part ${i} is generated without an end frame and part ${i + 1} continues from its last frame.`);
          else ctx.log(`Keyframe ${i}: ${seen}${decision === 'ok' ? ', no duplicate.' : ' (count could not be read; used unchecked).'}`);
        }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`Keyframe ${i}: duplicate check failed (${e.message}); used unchecked.`);
      }
    }
    status.keyControl[i] = decision;
    save();
    return decision;
  }
  const partDuration = () => {
    const s = status.durations.slice(-8);
    if (!s.length) return null;
    return s.reduce((t, x) => t + x, 0) / s.length;
  };
  const remainingText = (finished) => {
    const p = partDuration();
    return p ? ` · remaining ≈ ${durationText(p * (n - finished))}` : '';
  };
  // Aşama başlığı parça boyunca güncellenmez: geri sayım yerine bitiş saati (hep doğru kalır).
  const endText = (finished) => {
    const p = partDuration();
    if (!p) return '';
    const end = new Date(Date.now() + p * (n - finished) * 1000);
    const hour = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
    return ` · ends ≈ ${p * (n - finished) >= 86400 ? `${end.toLocaleDateString('tr-TR')} ` : ''}${hour}`;
  };

  for (let p = status.finished; p < n; p++) {
    const disk = diskStatus(k);
    if (disk.freeByte !== null && disk.freeByte < MIN_FREE_DISK) {
      throw new UserError(`Disk space is low (${(disk.freeByte / 2 ** 30).toFixed(1)} GB free, at least 3 GB needed). Free some space and click "Retry"; the job continues from part ${p}/${n}.`);
    }
    // Baslangic karesi: ilk parca kaynak gorsel; devam parcasi onceki parcanin son karesi
    // (renk sabitlemeyle kaynaga cekilmis kopyasi).
    let start = source;
    let lastSource = null;
    // Anahtar kare: parca anahtar kareden baslar (ilk parca kaynaktan), bir sonraki anahtar karede biter. Kopyali anahtar
    // kare kullanilmaz: o parca bitis karesiz uretilir, sonraki parca onun son karesinden (zincir, renk sabitlemeli) surer.
    if (g.keyFrame && n > 1) {
      if (p > 0 && !existsSync(keyPath(p))) await prepareKeys(p);
      if (!existsSync(keyPath(p + 1))) await prepareKeys(p + 1);
      if ((await checkKey(p + 1)) !== 'copy') lastSource = keyPath(p + 1);
    }
    if (p > 0 && g.keyFrame && n > 1 && (await checkKey(p)) !== 'copy') {
      start = keyPath(p);
    } else if (p > 0) {
      let last = join(pFolder, `p${no4(p)}.last.png`);
      if (g.idProtect) {
        const identityPath = join(pFolder, `p${no4(p)}.identity.png`);
        const kb = Date.now();
        try {
          last = await idRefresh(ctx, { frame: last, source, target: identityPath, seed: g.seed + 500 + p, stage: `Video · part ${p + 1}/${n} · character`, range: [(90 * p) / n, (90 * p) / n + 1] });
          ctx.log(`Part ${p + 1}: the character in the starting frame was corrected to match the source (${Math.round((Date.now() - kb) / 1000)} s).`);
        } catch (e) {
          if (ctx.signal?.aborted) throw e;
          ctx.log(`Part ${p + 1}: the character could not be corrected (${e.message}); continuing with the last frame.`);
        }
      }
      start = last;
      if (sourceColor) {
        const corrected = join(pFolder, `p${no4(p)}.start.png`);
        try {
          const frameColor = await measureColor(ctx.setting.ffmpeg, last);
          const { diff } = await matchColor(ctx.setting.ffmpeg, last, corrected, sourceColor, frameColor, { signal: ctx.signal });
          start = corrected;
          if (diff >= 0.02) ctx.log(`Part ${p + 1}: corrected ${Math.round(diff * 100)}% color drift in the first frame.`);
        } catch (e) {
          ctx.log(`Part ${p + 1}: color correction skipped (${e.message}).`);
        }
      }
    }
    rmSync(frames, { recursive: true, force: true });
    const startedAt = Date.now();
    const rangeStart = (90 * p) / n;
    const rangeLast = (90 * (p + 1)) / n;
    const stage = n > 1 ? `Video · part ${p + 1}/${n}${endText(p)}` : 'Video';
    const result = await runWan(ctx, {
      model: g.model, source: start, lastSource, prompt: getPrompt(p), seed: g.seed + p, width: g.width, height: g.height, frame: parts[p], smooth: g.smooth, lora: g.lora ?? null,
      target: frames, startNo: 1, skip: p === 0 ? 0 : 1, stage, range: [rangeStart, rangeLast], prefixExtra: `p${no4(p + 1)}`,
    });
    const generation = (Date.now() - startedAt) / 1000;
    // Son kare zincir icin uretim boyutunda saklanir (buyutmeden once)
    copyFileSync(join(frames, `${String(result.lastNo).padStart(5, '0')}.png`), join(pFolder, `p${no4(p + 1)}.last.png`));
    let upscaleSec = 0;
    if (g.upscale) {
      const b = Date.now();
      await upscaleFrames(ctx, frames, g.upscale, stage);
      upscaleSec = (Date.now() - b) / 1000;
    }
    // Parcayi hemen mp4 yap, PNG'leri sil.
    ctx.progress({ stage, detail: 'writing part mp4' });
    const partMp4 = `parts/p${no4(p + 1)}.mp4`;
    const temp = `parts/p${no4(p + 1)}.writing.mp4`;
    await framesToMp4(ctx.setting.ffmpeg, { cwd: k, pattern: 'parts/frames/%05d.png', fps: frameFps, outputFps: g.fps ?? undefined, output: temp, ready: ctx.setting.x264Ready, encoder: status.encoder, signal: ctx.signal, frameCount: result.frameCount, truncate: g.truncate ?? null });
    rmSync(join(k, partMp4), { force: true });
    renameSync(join(k, temp), join(k, partMp4));
    rmSync(frames, { recursive: true, force: true });
    status.finished = p + 1;
    status.durations.push(Math.round(generation + upscaleSec));
    if (status.durations.length > 16) status.durations.splice(0, status.durations.length - 16);
    save();
    ctx.measure(`video/${g.model}/${g.resolution}`, (generation + upscaleSec) / ((parts[p] - 1) / vm.fps));
    ctx.log(`Part ${p + 1}/${n}: ${result.frameCount} frames, ${generation.toFixed(0)} s${upscaleSec ? ` + 1080p upscaling ${upscaleSec.toFixed(0)} s` : ''}${remainingText(p + 1)}`);
  }

  /* Parcalari ekle (yeniden kodlama yok) */
  const totalFrame = partTotalFrame(parts, g.smooth);
  const videoFps = g.fps ?? frameFps;
  ctx.progress({ percent: 92, stage: n > 1 ? `joining ${n} parts` : 'writing mp4', detail: `${totalFrame} frames, ${videoFps} fps` });
  rmSync(join(k, 'video.mp4'), { force: true });
  if (n === 1) {
    copyFileSync(join(pFolder, 'p0001.mp4'), join(k, 'video.mp4'));
  } else {
    await concatParts(ctx.setting.ffmpeg, { cwd: pFolder, parts: Array.from({ length: n }, (_, i) => `p${no4(i + 1)}.mp4`), output: '../video.mp4', signal: ctx.signal });
  }
  await makePreview(ctx.setting.ffmpeg, 'video.mp4', 'video.preview.jpg', { cwd: k, signal: ctx.signal }).catch((e) => ctx.log(`Could not make a preview: ${e.message}`));
  rmSync(pFolder, { recursive: true, force: true });
  const duration = Math.round((totalFrame / frameFps) * 100) / 100;
  const [outputWidth, outputHeight] = g.upscale ?? g.truncate ?? [g.width, g.height];
  // A video made from text shows only the video: its drawn first frame (frame.png, kept for a retry) is not an output
  // (user 10.10.2026: "Video önizlemede fotosu da gelmiş saçma")
  ctx.addOutput({ file: 'video.mp4', type: 'video', preview: 'video.preview.jpg', width: outputWidth, height: outputHeight, duration, fps: videoFps });
  ctx.log(`Video: ${n} parts, ${totalFrame} frames, ${durationText(duration)}`);
}

/** Draws the first frame of a text-only video into target (a retry reuses it). */
async function drawFrame(ctx, target) {
  const f = ctx.job.input.fromText;
  const startedAt = Date.now();
  // Qwen-Image understands Turkish (not translated); FLUX (T5) does not.
  const prompt = f.imageModel === 'qwen' ? f.image : await jobPrompt(ctx, f.image, 'image', { translate: ctx.job.input.translate !== false });
  const graph = ctx.mod[IMAGE_MODELS[f.imageModel].generator]({ text: prompt, seed: ctx.job.input.seed + 900, width: f.width, height: f.height, prefix: `panel/${ctx.job.id}/frame` });
  const list = images(await ctx.runComfy(graph, { stage: 'Video · first frame', range: [0, 3] }), nodes(graph, 'SaveImage')[0]);
  if (!list.length) throw new Error('The first frame could not be drawn (the image model returned no image).');
  const temp = `${target}.temp.png`;
  await ctx.comfy.getOutput(list[0], temp);
  renameSync(temp, target);
  ctx.measure(`image/${f.imageModel}`, (Date.now() - startedAt) / 1000);
  ctx.log(`First frame drawn from the prompt with ${IMAGE_MODELS[f.imageModel].name} (${Math.round((Date.now() - startedAt) / 1000)} s).`);
}

/** Son kareyi kaynak gorseldeki karakterle hizalar (Qwen-Image-Edit: 1. gorsel kare, 2. gorsel kaynak). Doner: hedef. */
async function idRefresh(ctx, { frame, source, target, seed, stage, range }) {
  const a = await ctx.comfy.load(frame, `panel_${ctx.job.id}_identity_${Date.now().toString(36)}.png`);
  const b = await ctx.comfy.load(source, `panel_${ctx.job.id}_source${extname(source).toLowerCase() || '.png'}`);
  const graph = ctx.mod.editJob({ pictures: [a, b], text: ID_PROMPT, seed, prefix: `panel/${ctx.job.id}/id` });
  const record = nodes(graph, 'SaveImage')[0];
  const list = images(await ctx.runComfy(graph, { stage, range }), record);
  if (!list.length) throw new Error('Qwen-Image-Edit returned no image');
  await ctx.comfy.getOutput(list[0], target);
  return target;
}
