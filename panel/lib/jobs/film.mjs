/**
 * Tek parca film: sahne listesinden (gorsel istemi, hareket istemi, anlatim) tek mp4.
 *
 * Sira (GPU tek is): 1) butun anlatimlar tek seslendirmede (sureler belli olsun),
 * 2) eksik gorseller tek ComfyUI isteginde, 3) her sahnenin videosu (anlatim uzunsa klip
 * yavaslatilir, yetmezse son kareden devam parcasi uretilir), 4) sahne klipleri (anlatim
 * sahneye esitlenir), 5) yumusak gecisle birlestirme + istege bagli altyazi.
 *
 * YENIDEN DENEME KALDIGI YERDEN SURER: var olan ses/gorsel/kare/klip yeniden uretilmez.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { merge as mergeGraph, nodes } from '../graph.mjs';
import { merge as mergeVideo, runFfmpeg, mergeMusic, makePreview, sceneClip, videoEncoder } from '../ffmpeg.mjs';
import { CancelError, UserError } from '../errors.mjs';
import { imageSize, wavDuration } from '../media.mjs';
import { LIP, lipWindows, characterDefinition, intersects, boxPixel, faceMask } from '../lip.mjs';
import { lipVideo, findSpeakers } from './lip.mjs';
import { fixMouth } from './mouth.mjs';
import { DEFAULT, subtitleMetrics, subtitleSplit, timeSubtitles, writeAss, inputFps, scenePlan, writeSrt, durationText, timeChart } from '../plan.mjs';
import { IMAGE_MODELS, MUSIC_LEVEL, RATIOS, VIDEO_MODELS, yes, validateFps, sourcePath, text, musicPath, writeAtomic, deleteExtraFrames, pngs, prepareReference, rifeFactor, choice, voiceInput, speak, voiceDesign, slug, seed, generatorRequired, mergeWavs } from './common.mjs';
import { voiceInfo, updateVoiceInfo, listVoices, voicePace, voicePath, voiceTimbre } from '../voices.mjs';
import { GENDERS, AGES, nameKey, findCharacter, validateCharacters, splitSpeech, pitchFit, selectVoice, designSpec } from '../characters.mjs';
import { runWan } from './wan.mjs';
import { upscaleModelRequired, upscaleFrames } from './upscale.mjs';
import { fineSetting } from '../fine-settings.mjs';
import { partPrompts, directorNote, anatomyPhrase } from '../prompt-translate.mjs';
import { hasText } from '../text-model.mjs';
import { MUSIC_LONGEST, musicRequired, generateMusic } from './music.mjs';
import { SECTION_TRANSITION, musicSections, musicStyles } from '../music-plan.mjs';

export const name = 'Film';

/** Üretim önceliği: Wan çözünürlüğü ve en çok yavaşlatma (fazlası için sahneye parça eklenir, her parça ≈ 6 dk). */
export const PRIORITY = {
  quality: { name: 'Quality', resolution: '720p', slowdown: 1.6 },
  speed: { name: 'Speed (fewer parts)', resolution: '720p', slowdown: 2 },
  draft: { name: 'Draft (480p, fastest)', resolution: '480p', slowdown: 2 },
};

const OUTPUT = { '16:9': [1280, 720], '9:16': [720, 1280] };
// 1080p film: Wan 720p uretir, sahne kareleri 2x modelle buyutulur (ince ayar "Dogrudan 1080p" acikken Wan 1088 uretir)
const OUTPUT_1080 = { '16:9': [1920, 1080], '9:16': [1080, 1920] };
// Karakter tutarliligi: Qwen-Image-Edit ~1 MP'de (Kontext olcegi) calisir; Wan 720p'ye olcekler.
const CHARACTER_SIZE = { '16:9': [1392, 752], '9:16': [752, 1392] };

/** Karakterli sahne istemi: referanstaki (1. gorsel) kisiler aynen kalir, sahne istemdeki gibi kurulur. */
export function characterPrompt(image) {
  return `Create a new image of this scene: ${image}\nAny character from image 1 who appears in this scene must look exactly the same as in image 1 (same face, hair, body and clothing). Do not copy the background, pose or framing of image 1; build the setting, pose and camera angle the scene describes.`;
}
const DEFAULT_MOTION = 'natural subtle motion, slow cinematic camera movement';
const IMAGE_CHUNK = 8;
// Capraz gecisli birlestirme en cok bu kadar sahneyi tek suzgec grafinda yapar; fazlasi
// obek obek ara mp4'lere, sonra ara mp4'ler yine gecisle birlestirilir (binlerce sahne).
const MERGE_CHUNK = 30;

/**
 * Film cozunurlugu: { cozunurluk, uretim1080 }. 1080p'de ince ayar "Dogrudan 1080p" acik ve oncelik 720p ise Wan
 * 1920x1088 uretir ('dogrudan'); degilse 720p (taslakta 480p) uretilip sahne kareleri buyutulur ('buyutme').
 */
function film1080(g, setting) {
  const resolution = choice(g.resolution, 'Resolution', ['720p', '1080p'], '720p');
  if (resolution !== '1080p') return { resolution };
  const priority = PRIORITY[g.priority] ?? PRIORITY.quality;
  const generation1080 = fineSetting('video1080p') && priority.resolution === '720p' ? 'direct' : 'upscale';
  if (generation1080 === 'upscale') upscaleModelRequired(setting);
  return { resolution, generation1080 };
}

export function validate(g, { mod, setting }) {
  const imageModel = choice(g.imageModel, 'Image model', Object.keys(IMAGE_MODELS), 'qwen');
  const videoModel = choice(g.videoModel, 'Video model', Object.keys(VIDEO_MODELS), 'wan14');
  // Gorsel modeli yalniz gorseli uretilecek sahne varsa gerekli (hepsi galeriden olabilir).
  if ((Array.isArray(g.scenes) ? g.scenes : []).some((x) => !String(x?.source ?? '').trim())) generatorRequired(mod, IMAGE_MODELS[imageModel].generator, IMAGE_MODELS[imageModel].name, setting?.modelRoot);
  generatorRequired(mod, VIDEO_MODELS[videoModel].generator, VIDEO_MODELS[videoModel].name, setting?.modelRoot);
  const character = yes(g.character);
  if (character) generatorRequired(mod, 'editJob', 'Character consistency (Qwen-Image-Edit)', setting?.modelRoot);
  // Dudak esleme (InfiniteTalk, lib/dudak.mjs): ilk adimlari Wan 2.2 A14B'nin uzmani atar
  const lip = yes(g.lip);
  if (lip && videoModel !== 'wan14') throw new UserError('Lip sync only works with the Wan 2.2 A14B video model.');
  if (lip) generatorRequired(mod, 'lipJob', 'Lip sync (InfiniteTalk)', setting?.modelRoot);
  const characterSource = character ? String(g.characterSource ?? '').trim() : '';
  if (characterSource) sourcePath(setting.outputRoot, characterSource);
  const raw = Array.isArray(g.scenes) ? g.scenes : [];
  if (!raw.length) throw new UserError('Add at least one scene.');
  // Sahne sayisinda ust sinir yok (istek govdesi siniri 16 MB; ~10.000 sahne).
  const scenes = raw.map((s, i) => {
    const no = i + 1;
    const source = String(s?.source ?? '').trim();
    if (source) sourcePath(setting.outputRoot, source);
    // Anlatim: metinden seslendirilir ya da galeriden hazir ses (sesKaynak); hazir seste metin
    // yalniz altyazi icindir (istege bagli).
    const voiceSource = String(s?.voiceSource ?? '').trim();
    if (voiceSource) musicPath(setting.outputRoot, voiceSource);
    // Replikler (karakterler kendi sesiyle): "Ad: söz" satirlari ya da [{ kim, metin }]; varsa anlatim istege bagli
    const dialogue = splitSpeech(s?.dialogue, no);
    if (dialogue.length && voiceSource) throw new UserError(`Scene ${no}: dialogue cannot be added while a ready audio file from the gallery is selected.`);
    return {
      image: text(s?.image, `Scene ${no}: image prompt`, { required: !source, max: 2000 }),
      motion: text(s?.motion, `Scene ${no}: motion prompt`, { required: false, max: 1000 }) || DEFAULT_MOTION,
      narration: text(s?.narration, `Scene ${no}: narration`, { required: !voiceSource && !dialogue.length, max: 1500 }),
      source: source || null,
      voiceSource: voiceSource || null,
      ...(dialogue.length ? { dialogue } : {}),
    };
  });
  // Konusan her ad karakter listesinde (cinsiyet, yas: ses buna gore secilir ya da tasarlanir)
  const characters = validateCharacters(g.characters, [...new Set(scenes.flatMap((s) => (s.dialogue ?? []).map((x) => x.who)))]);
  // Replikteki ad listedeki yazimla (altyazi ve gunlukte "elif" degil "Elif")
  for (const s of scenes) for (const x of s.dialogue ?? []) x.who = findCharacter(characters, x.who).name;
  // Film muzigi: yok | dosya (yuklenen ya da galeriden) | uret (ACE-Step, film boyunca)
  // Arayüz sekmeleri: galeri / yukle = dosya.
  const musicRaw = ['gallery', 'load'].includes(g.musicMode) ? 'file' : g.musicMode;
  const musicMode = choice(musicRaw ?? (g.music ? 'file' : 'none'), 'Music', ['none', 'file', 'generate'], 'none');
  if (musicMode === 'generate') musicRequired(mod, setting);
  return {
    title: text(g.title, 'Title', { required: false, max: 80 }) || 'Film',
    ratio: choice(g.ratio, 'Format', Object.keys(OUTPUT), '16:9'),
    imageModel,
    videoModel,
    // Karakter tutarliligi: 2. sahneden itibaren gorseller referanstaki kisiyle (Qwen-Image-Edit).
    character,
    characterSource: characterSource || null,
    subtitle: yes(g.subtitle),
    transition: yes(g.transition ?? true),
    // Konusmali sahnede konusanin agzi kendi sesiyle oynar (konusma yoksa etkisiz)
    lip: lip && scenes.some((s) => s.dialogue?.length),
    musicMode,
    music: musicMode === 'file' ? (musicPath(setting.outputRoot, g.music), String(g.music).trim()) : null,
    musicName: musicMode === 'file' ? text(g.musicName, 'Music name', { required: false, max: 120 }) : '',
    // Bossa tarz filmin sahnelerinden cikarilir (music-plan.mjs).
    musicStyle: musicMode === 'generate' ? text(g.musicStyle, 'Music style', { required: false, max: 1000 }) : '',
    fps: validateFps(g.fps, { defaultValue: 30 }),
    // Üretim önceliği: kalite (720p, ≤1,6× yavaş) | hiz (720p, ≤2× yavaş: daha az parça) | taslak (480p, ≤2×).
    priority: choice(g.priority, 'Production priority', Object.keys(PRIORITY), 'quality'),
    // Cikti 720p ya da 1080p. 1080p: dogrudan (ince ayar, guclu kart; taslakta yok) ya da sahne sahne 2x buyutme
    ...film1080(g, setting),
    musicLevel: choice(g.musicLevel, 'Music level', Object.keys(MUSIC_LEVEL), 'low'),
    seed: seed(g.seed),
    scenes,
    ...(characters.length ? { characters } : {}),
    // Butun sahnelerde hazir anlatim sesi varsa seslendirme kurulu olmasa da film yapilir
    ...voiceInput(g, setting, { narration: scenes.some((s) => !s.voiceSource) }),
  };
}

export function summary(g) {
  return { title: g.title, detail: `${g.scenes.length} scene${g.scenes.length > 1 ? 's' : ''} · ${g.ratio}${g.resolution === '1080p' ? ' · 1080p' : ''} · ${VIDEO_MODELS[g.videoModel]?.name ?? g.videoModel}${g.priority && g.priority !== 'quality' ? ` · ${PRIORITY[g.priority].name}` : ''}${g.character ? ' · same character' : ''}${g.characters?.length ? ` · ${g.characters.length} speaking character${g.characters.length > 1 ? 's' : ''}` : ''}${g.lip ? ' · lip sync' : ''}${g.subtitle ? ' · subtitled' : ''}${g.music || g.musicMode === 'generate' ? ' · with music' : ''}` };
}

// Sahne dosya adlari: 2 basamak (sahne01) 99'a kadar, sonrasi 4 basamak (sahne0100); siralama
// dosya adina bagli degil (dizinle calisilir).
const no2 = (i) => String(i + 1).padStart(i + 1 > 99 ? 4 : 2, '0');

/** Konusmali sahnede satirlar (anlatim, replikler) arasi sessizlik, sn. */
const LINE_SPACE = 0.3;

/**
 * Gorsel istemi: replikli sahnede konusanlar birbirine donuk, kameraya bakmaz. Olculdu 07.10.2026 (ilk diyalog filmi):
 * "kiz babasinin yaninda" istemiyle ikisi de kameraya bakip poz verdi; kullanici: "Konusurken yuzu donmus olmali diger
 * karaktere, bosluga konusuyor gibi olmamali".
 */
export function sceneImagePrompt(s, note = null) {
  if (!s.image) return s.image;
  // Yonetmen notunun gorsel cumlesi (kim nereye bakiyor, ifade, beden dili) her sahnede. 07.10.2026: genel kural ("birbirlerinin
  // gozlerine bakarak") kayip kediye seslenen kizi babasina gulerek baktirdi (kullanici: "sevgili gibiler").
  if (note?.image) return `${s.image.replace(/[.\s]+$/, '')}. ${note.image}`;
  const speaker = [...new Set((s.dialogue ?? []).map((x) => x.who))];
  if (!speaker.length) return s.image;
  // Not yoksa (yazi modeli yok): konusan kime sesleniyorsa ona doner, ifadesi sozlerine uyar
  const extra = speaker.length > 1
    ? 'The characters who talk turn toward the one they address, with facial expressions that fit their words, not looking at the camera.'
    : 'The speaking character turns toward the one they address, with a facial expression that fits the words, not looking at the camera.';
  return `${s.image.replace(/[.\s]+$/, '')}. ${extra}`;
}

/**
 * Konusan karakterlerin sesleri: secilen (karakter.ses), yeniden denemede ayni ses (ctx.is.karakterSesleri), kutuphaneden
 * cinsiyet + yas uyan ses ya da karakterin tarifinden tasarlanan ses (kutuphaneye cinsiyet/yas/karakter adiyla eklenir;
 * dizinin sonraki bolumlerinde ayni adli karaktere ayni ses). Doner: { [adAnahtari]: { referans, referansMetni, karakter } }.
 */
async function prepareCharacterVoices(ctx, g, scenes, narratorId) {
  const speaker = new Set(scenes.flatMap((i) => (g.scenes[i].dialogue ?? []).map((x) => nameKey(x.who))));
  if (!speaker.size) return {};
  const library = ctx.setting.voiceLibrary;
  ctx.job.characterVoices ??= {};
  const used = new Set(Object.values(ctx.job.characterVoices));
  const result = {};
  for (const kr of (g.characters ?? []).filter((x) => speaker.has(nameKey(x.name)))) {
    const previous = ctx.job.characterVoices[kr.name];
    let id = previous && voicePath(library, previous) ? previous : null;
    let how = 'selected in this job';
    if (!id && kr.voice) {
      id = kr.voice.slice(4);
      if (!voicePath(library, id)) throw new UserError(`The voice selected for "${kr.name}" is not in the library.`);
      how = 'selected';
    }
    if (!id) {
      const s = selectVoice({ character: kr, voices: listVoices(library), used, narratorId });
      if (s) {
        id = s.id;
        how = 'from the library, by gender and age';
      }
    }
    if (!id) {
      if (!ctx.setting.hasDesign) throw new UserError(`No suitable voice in the library for "${kr.name}" and voice design is not installed; pick a voice from the Characters list.`);
      const startedAt = Date.now();
      // Ayrismasi gerekenler: bu filmde oteki karakterlere verilen sesler ve anlatici ("Kedi mi konusuyor Elif mi")
      const separate = [...new Set([...used, narratorId].filter(Boolean))].map((x) => voicePath(library, x)).filter(Boolean);
      id = await voiceDesign(ctx, { spec: designSpec(kr), recordName: `${kr.name} (character)`, folder: join(ctx.folder, 'character-voices', slug(kr.name, 'character')), neutral: true, character: kr, separate, lang: g.lang });
      updateVoiceInfo(library, id, { gender: kr.gender, age: kr.age, character: kr.name, ...(kr.type === 'animal' ? { type: 'animal' } : {}) });
      ctx.job.stages.voiceDesign = (ctx.job.stages.voiceDesign ?? 0) + Math.round((Date.now() - startedAt) / 1000);
      how = 'designed from description';
    }
    used.add(id);
    ctx.job.characterVoices[kr.name] = id;
    ctx.save();
    const b = voiceInfo(library, id);
    result[nameKey(kr.name)] = { reference: voicePath(library, id), referenceText: b.referenceText ?? null, engine: b.engine ?? null, timbre: voiceTimbre(library, b), pace: voicePace(b), character: kr };
    ctx.log(`Character voice: ${kr.name} (${GENDERS[kr.gender]}, ${AGES[kr.age]}${kr.type === 'animal' ? ', animal' : ''}) → ${b.name ?? id} (${how})`);
  }
  return result;
}

/**
 * Sahne kliplerini gecisle birlestirir; cok sahnede obekler halinde (ara mp4'ler ara/ altinda).
 * Altyazi, muzik ve ses normalizasyonu yalniz son asamada uygulanir.
 */
async function mergeChunked(ctx, { scenes, transition, subtitle, music, fps, output, progress, level = 1 }) {
  const k = ctx.folder;
  const common = { cwd: k, transition, fps, ready: ctx.setting.x264Ready, signal: ctx.signal };
  if (scenes.length <= MERGE_CHUNK) {
    await mergeVideo(ctx.setting.ffmpeg, { ...common, scenes, subtitle, music, output, progress });
    return;
  }
  mkdirSync(join(k, 'search'), { recursive: true });
  const searchList = [];
  const chunkCount = Math.ceil(scenes.length / MERGE_CHUNK);
  for (let o = 0; o < chunkCount; o++) {
    const chunk = scenes.slice(o * MERGE_CHUNK, (o + 1) * MERGE_CHUNK);
    // Duzey adda: 900+ sahnede ikinci duzey obekler birinci duzeyin dosyalariyla cakismasin
    const name = `search/${level > 1 ? `d${level}-` : ''}obek${String(o + 1).padStart(4, '0')}.mp4`;
    const duration = chunk.reduce((t, s) => t + s.duration, 0) - (chunk.length - 1) * transition;
    if (!existsSync(join(k, name))) {
      await mergeVideo(ctx.setting.ffmpeg, { ...common, scenes: chunk, subtitle: null, music: null, lastOperation: false, output: `${name}.writing.mp4`, progress: (x) => progress((o + x) / (chunkCount + 1)) });
      renameSync(join(k, `${name}.writing.mp4`), join(k, name));
    }
    searchList.push({ path: name, duration });
  }
  await mergeChunked(ctx, { scenes: searchList, transition, subtitle, music, fps, output, progress: (x) => progress((chunkCount + x) / (chunkCount + 1)), level: level + 1 });
}

export async function run(ctx) {
  const g = ctx.job.input;
  const k = ctx.folder;
  const n = g.scenes.length;
  const [outWidth, outHeight] = (g.resolution === '1080p' ? OUTPUT_1080 : OUTPUT)[g.ratio];
  const vm = VIDEO_MODELS[g.videoModel];
  const direction = g.ratio === '16:9' ? 'landscape' : 'portrait';
  const priority = PRIORITY[g.priority ?? 'quality'];
  const [wanWidth, wanHeight] = vm.size[g.generation1080 === 'direct' ? '1080p' : priority.resolution][direction];
  ctx.job.stages = ctx.job.stages ?? {};

  /* 0) Yonetmen notu ───────────────────────────────────────────────── */
  // Gercek bir filmdeki gibi oyunculuk: her sahnede an ve duygu, karakterlerin duygu/dusunce/tavri, replik basina oyunculuk,
  // ses ve dinleyenin tepkisi. Seslendirmeden once (replik notunun "ses"i); gorsel ve hareket istemleri bundan.
  // 07.10.2026 kullanici: "Duygu-dusunce-davranis-tavir-mimik ... gercek insan videosu-filmi olmalidir".
  ctx.job.director ??= {};
  const withoutNote = g.scenes.map((_, i) => i).filter((i) => !ctx.job.director[i] && !existsSync(join(k, `scene${no2(i)}.mp4`)));
  if (withoutNote.length && !hasText()) ctx.log('Text model not installed: no director note written; the general dialogue layout is used.');
  for (const [j, i] of (hasText() ? withoutNote : []).entries()) {
    ctx.progress({ percent: 1, stage: "1/5 Director's note", detail: `scene ${j + 1}/${withoutNote.length}` });
    const s = g.scenes[i];
    const definition = Object.fromEntries([...new Set((s.dialogue ?? []).map((x) => x.who))].map((name) => [name, characterDefinition(findCharacter(g.characters, name))]));
    try {
      const y = await directorNote({ image: s.image, narration: s.narration, dialogue: s.dialogue ?? [], definition, signal: ctx.signal });
      ctx.job.director[i] = y;
      ctx.log(`Scene ${i + 1} director's note: ${y.an} | image: ${y.image}${y.lines.map((r, n) => ` | ${n + 1}. ${r.acting} (voice: ${r.voice}; listener: ${r.listener})`).join('')}`);
    } catch (e) {
      if (e instanceof CancelError) throw e;
      ctx.job.director[i] = { an: '', image: '', characters: [], lines: [], error: e.message };
      ctx.log(`Scene ${i + 1}: director note could not be written (${e.message}); the general dialogue layout is used.`);
    }
    ctx.save();
  }

  /* 1) Seslendirme ─────────────────────────────────────────────────── */
  // Galeriden hazir anlatim sesi secilen sahneler seslendirilmez: ses wav'a cevrilir.
  for (let i = 0; i < n; i++) {
    const s = g.scenes[i];
    const target = join(k, `scene${no2(i)}.wav`);
    if (!s.voiceSource || existsSync(target)) continue;
    await writeAtomic(target, (temp) => runFfmpeg(ctx.setting.ffmpeg, ['-y', '-i', musicPath(ctx.setting.outputRoot, s.voiceSource), '-ac', '1', '-ar', '24000', temp], { signal: ctx.signal }));
  }
  // Konusmasiz sahne tek satir (sahneNN, anlatici sesi). Konusmali sahnede anlatim ve replikler ayri satirlar
  // (sahneNN_s1..), her biri kendi sesiyle; sonra aralarina kisa sessizlik konup sahneNN.wav olur (karakterler.mjs).
  const sceneLines = (i) => {
    const s = g.scenes[i];
    const id = `scene${no2(i)}`;
    if (!s.dialogue?.length) return [{ id, scene: i, text: s.narration, who: null }];
    // Replik satirinda yonetmen notunun ses yonergesi ("loud, urgent, worried"): seslendirme duyguyla okur
    const notes = ctx.job.director?.[i]?.lines ?? [];
    const list = [...(s.narration ? [{ text: s.narration, who: null }] : []), ...s.dialogue.map((x, r) => ({ text: x.text, who: x.who, directive: notes[r]?.voice || null }))];
    return list.map((x, j) => ({ ...x, id: `${id}_s${j + 1}`, scene: i }));
  };
  const missingScene = g.scenes.map((_, i) => i).filter((i) => !existsSync(join(k, `scene${no2(i)}.wav`)));
  if (missingScene.length) {
    await ctx.flushVoiceForGpu();
    // ComfyUI (kapaliysa) seslendirme surerken acilsin; gorsel asamasi beklemesin
    await ctx.comfyBeforehand?.();
    const startedAt = Date.now();
    ctx.progress({ percent: 1, stage: '1/5 Voice-over', detail: 'preparing voice' });
    // Tarif: referansHazirla tasarlanan sesi iste saklar, yeniden denemede ayni sesi (referans metniyle) kullanir
    const r = await prepareReference(ctx, g, k);
    const reference = r.reference;
    const clone = { referenceText: r.referenceText, lora: r.lora };
    ctx.job.voiceName = r.voiceName;
    ctx.save();
    // Karakter sesleri (konusan varsa): secilen, kutuphaneden uygun (cinsiyet + yas) ya da karakterin tarifinden tasarlanan
    const narratorId = String(g.voice ?? '').startsWith('ref:') ? String(g.voice).slice(4) : (ctx.job.voiceId ?? null);
    const designBefore = ctx.job.stages.voiceDesign ?? 0;
    const characterVoice = await prepareCharacterVoices(ctx, g, missingScene, narratorId);
    const designSec = (ctx.job.stages.voiceDesign ?? 0) - designBefore;
    // Her satirin motoru ve LoRA'si: anlatici satirlari isin sesiyle (LoRA'li olabilir), replikler karakter sesiyle (LoRA'siz).
    // EMA Lightning sesi (motor 'ema') kendi betigiyle okunur. Ayni (motor, LoRA) satirlari tek calistirmada.
    // Ayardaki motor EMA iken anlatim satirlari (referanssiz) ayri EMA calistirmasinda; karakter satirlari VoxCPM2 (klon)
    const narrationEma = ctx.setting.selectVoiceEngine?.() === 'ema' && ctx.setting.hasEma && !reference;
    const lines = missingScene.flatMap(sceneLines).map((s) => {
      if (!s.who) return { ...s, engine: r.engine ?? (narrationEma ? 'ema' : null), timbre: r.timbre ?? null, pace: r.pace ?? null, lora: clone.lora ?? null };
      const ks = characterVoice[nameKey(s.who)];
      return { ...s, reference: ks.reference, referenceText: ks.referenceText, engine: ks.engine ?? null, timbre: ks.timbre ?? null, pace: ks.pace ?? null, lora: null };
    });
    // a voice with a timbre (EMA in another voice) or its own pace is a run of its own too
    const groups = [];
    for (const s of lines) {
      const key = `${s.engine ?? ''}|${s.lora ?? ''}|${s.timbre ?? ''}|${s.pace ?? ''}`;
      let group = groups.find((x) => x.key === key);
      if (!group) groups.push((group = { key, engine: s.engine ?? null, lora: s.lora ?? null, timbre: s.timbre ?? null, pace: s.pace ?? null, lines: [] }));
      group.lines.push(s);
    }
    const result = {};
    for (const [j, group] of groups.entries()) {
      Object.assign(result, await speak(ctx, {
        lines: group.lines,
        reference,
        // Isin referans metni yalniz anlatici satirlarina (replik satirinda kendi sesi ve metni var)
        referenceText: clone.referenceText,
        lora: group.lora,
        engine: group.engine,
        timbre: group.timbre,
        pace: group.pace,
        select: g,
        folder: join(k, j === 0 ? 'narration' : `narration-${j + 1}`),
        progress: (ratio, detail) => ctx.progress({ percent: 1 + ((j + ratio) / groups.length) * 7, stage: '1/5 Voice-over', detail }),
      }));
    }
    for (const i of missingScene) {
      const ss = lines.filter((s) => s.scene === i);
      const id = `scene${no2(i)}`;
      const wordPath = join(k, `${id}.words.json`);
      if (ss.length === 1 && ss[0].id === id) {
        const s = result[id];
        renameSync(s.path, join(k, `${id}.wav`));
        // Whisper kelime zamanları (denetimli/doğal kalite): altyazı gerçek konuşmaya oturur.
        if (s.words) writeFileSync(wordPath, JSON.stringify(s.words), 'utf8');
        else rmSync(wordPath, { force: true });
        if (s.error != null) ctx.log(`${id} Whisper error rate ${s.error}: ${s.heard}`);
        continue;
      }
      // Konusmali sahne: satirlar SATIR_BOSLUGU sessizlikle birlesir; satir zamanlari (altyazida konusanin adi) ve kelimeler kaydirilir
      await mergeWavs(ctx, ss.map((s) => result[s.id].path), join(k, `${id}.wav`), LINE_SPACE);
      const time = [];
      const words = [];
      let t = 0;
      for (const s of ss) {
        const x = result[s.id];
        time.push({ who: s.who, text: s.text, startedAt: Math.round(t * 1000) / 1000, last: Math.round((t + x.duration) * 1000) / 1000, words: x.words ?? null, f0: x.f0 ?? null });
        if (x.words) for (const [a, b] of x.words) words.push([Math.round((a + t) * 100) / 100, Math.round((b + t) * 100) / 100]);
        t += x.duration + LINE_SPACE;
        const kr = s.who ? characterVoice[nameKey(s.who)].character : null;
        const pitch = x.f0 ? `, pitch ${x.f0} Hz${kr ? pitchFit(kr, x.f0) : ''}` : '';
        ctx.log(`${id} ${s.who ?? 'Narrator'}${x.error != null ? `: Whisper error rate ${x.error}` : ''}${pitch}: ${x.heard ?? s.text}`);
      }
      writeFileSync(join(k, `${id}.lines.json`), JSON.stringify(time), 'utf8');
      if (ss.every((s) => result[s.id].words)) writeFileSync(wordPath, JSON.stringify(words), 'utf8');
      else rmSync(wordPath, { force: true });
    }
    ctx.job.stages.voice = Math.round((Date.now() - startedAt) / 1000);
    // Olcum: 100 karakter basina seslendirme suresi (karakter sesi tasarimi haric)
    ctx.measure(`voice/${g.quality}`, (((Date.now() - startedAt) / 1000 - designSec) / Math.max(1, lines.reduce((t, s) => t + s.text.length, 0))) * 100);
  }
  const narrations = g.scenes.map((_, i) => {
    const duration = wavDuration(join(k, `scene${no2(i)}.wav`));
    if (!duration) throw new Error(`could not read scene${no2(i)}.wav`);
    return duration;
  });
  // Sahne planlari (parca sayisi, yavaslatma, RIFE) ve zaman cizelgesi yalniz anlatim surelerinden
  const plans = narrations.map((a) => {
    const p = scenePlan({ narration: a, frame: vm.frame, fps: vm.fps, maxSlowdown: priority.slowdown });
    // RIFE carpani: yavaslatma sonrasi kare hizi cikti fps'ini karsilasin (30 fps, A14B: kirp 2x, yavas 3x; 60 fps: 4x / 6x).
    const smooth = rifeFactor(vm.fps, g.fps ?? 30, p.truncate ? 1 : p.slowdown);
    return { ...p, smooth, narration: Math.round(a * 1000) / 1000 };
  });
  const transition = g.transition && n > 1 ? DEFAULT.transition : 0;
  const durations = plans.map((p) => p.target);
  const { starts, total } = timeChart(durations, transition);
  // Muzik uretilecekse filme gore: sahne sinirlarinda bolumler (music-plan.mjs), her bolumun tarzi sahnelerin anlatimindan
  const musicToGenerate = g.musicMode === 'generate' && !existsSync(join(k, 'music.mp3'));
  const sections = musicToGenerate ? musicSections(starts, durations, total).map((b) => ({ ...b, narrations: b.scenes.map((i) => g.scenes[i].narration).filter(Boolean) })) : [];

  /* 1b) Yazi modeli isleri ─────────────────────────────────────────── */
  // Hareket istemleri ve muzik plani yalniz metne ve surelere bagli: hepsi seslendirmeden hemen sonra, ComfyUI
  // islerinden once tek yazi modeli oturumunda. Olculdu 07.10.2026: sahne basina yazi modeli yeniden yukleniyordu
  // (5 kez 18-20 sn), her seferinde Wan modelleri bellekten cikiyor, sahnenin ilk parcasi ikinciden ~27 sn yavas kaliyordu.
  // Hareket istemi Ingilizce ve parca parca (uzun sahnede ayni istem eylemi bastan yaptiriyordu); ise kaydedilir.
  ctx.job.scenePrompts ??= {};
  const promptless = plans.map((_, i) => i).filter((i) => !existsSync(join(k, `scene${no2(i)}.mp4`)) && !Array.isArray(ctx.job.scenePrompts[i]));
  for (const [j, i] of promptless.entries()) {
    ctx.progress({ percent: 8, stage: '2/5 Preparation', detail: `motion prompt ${j + 1}/${promptless.length}` });
    // Replikler (kim kime konusuyor) ve yonetmen notu (duygu, mimik, beden dili, dinleyenin tepkisi): her sahnede
    const s = g.scenes[i];
    const context = { dialogue: s.dialogue ?? [], image: s.image, director: ctx.job.director[i] ?? null };
    const c = await partPrompts(s.motion, plans[i].part, { signal: ctx.signal, context });
    ctx.job.scenePrompts[i] = c.prompts;
    ctx.save();
    if (c.translated) ctx.log(`Scene ${i + 1} motion prompt: ${c.prompts.join(' | ')}`);
    else if (c.error && plans[i].part > 1) ctx.log(`Scene ${i + 1}: prompt could not be translated (${c.error}); continuation parts proceed with calm motion.`);
  }
  // A14B has no negative prompt: per scene the animals and people with their leg count, in the same text model session
  // (user 10.10.2026: a fox grew a spider-like extra leg; wan.mjs ANATOMY)
  if (g.videoModel === 'wan14') {
    ctx.job.sceneAnatomy ??= {};
    for (const i of plans.map((_, i) => i).filter((i) => !existsSync(join(k, `scene${no2(i)}.mp4`)) && ctx.job.sceneAnatomy[i] === undefined)) {
      const a = await anatomyPhrase(`${g.scenes[i].image ?? ''} ${(ctx.job.scenePrompts[i] ?? [g.scenes[i].motion]).join(' ')}`.trim(), { signal: ctx.signal });
      ctx.job.sceneAnatomy[i] = a.phrase;
      if (a.phrase) ctx.log(`Scene ${i + 1} body: ${a.phrase}`);
    }
    ctx.save();
  }
  if (musicToGenerate && (!ctx.job.musicPlan || ctx.job.musicPlan.sections.length !== sections.length)) {
    ctx.progress({ percent: 8, stage: '2/5 Preparation', detail: 'music plan' });
    ctx.job.musicPlan = await musicStyles({ style: g.musicStyle, sections, log: ctx.log, signal: ctx.signal });
    ctx.save();
    ctx.log(`Music plan: ${ctx.job.musicPlan.general}`);
  }

  /* 2) Gorseller ────────────────────────────────────────────────────── */
  const imagePath = (i) => {
    const candidates = readdirSync(k).filter((d) => new RegExp(`^scene${no2(i)}\\.(png|jpe?g|webp)$`, 'i').test(d));
    return candidates.length ? join(k, candidates[0]) : null;
  };
  g.scenes.forEach((s, i) => {
    if (s.source && !imagePath(i)) {
      const source = sourcePath(ctx.setting.outputRoot, s.source);
      copyFileSync(source, join(k, `scene${no2(i)}${extname(source).toLowerCase()}`));
    }
  });
  const missingImage = g.scenes.map((s, i) => i).filter((i) => !imagePath(i));
  if (missingImage.length) {
    const startedAt = Date.now();
    const gm = IMAGE_MODELS[g.imageModel];
    const [sceneWidth, sceneHeight] = RATIOS[g.ratio][g.imageModel];
    let finished = 0;
    // En cok GORSEL_OBEGI gorsel tek ComfyUI isteginde (modeller bir kez yuklenir); yuzlerce
    // sahnede obek obek: her obek bitince diske iner, yeniden denemede yeniden uretilmez.
    const generate = async (list, makeGraph, measurement) => {
      const start2 = Date.now();
      for (let o = 0; o < list.length; o += IMAGE_CHUNK) {
        const chunk = list.slice(o, o + IMAGE_CHUNK);
        const graphs = chunk.map(makeGraph);
        const { job, match } = mergeGraph(graphs);
        const search = [8 + (12 * finished) / missingImage.length, 8 + (12 * (finished + chunk.length)) / missingImage.length];
        const outputs = await ctx.runComfy(job, { stage: `2/5 Images (${finished + chunk.length}/${missingImage.length})`, range: search });
        for (let j = 0; j < chunk.length; j++) {
          const i = chunk[j];
          const result = images(outputs, match[j][nodes(graphs[j], 'SaveImage')[0]]);
          if (!result.length) throw new Error(`Scene ${i + 1} image did not arrive.`);
          await ctx.comfy.getOutput(result[0], join(k, `scene${no2(i)}.png`));
        }
        finished += chunk.length;
      }
      ctx.measure(measurement, (Date.now() - start2) / 1000 / list.length);
    };
    const fromText = (i) => ctx.mod[gm.generator]({ text: sceneImagePrompt(g.scenes[i], ctx.job.director[i]), seed: g.seed + i, width: sceneWidth, height: sceneHeight, prefix: `panel/${ctx.job.id}/s${no2(i)}` });
    if (!g.character) {
      await generate(missingImage, fromText, `image/${g.imageModel}`);
    } else {
      // Karakter tutarliligi: referans (karakterKaynak ya da 1. sahnenin gorseli) yoksa 1. sahne
      // istemden uretilir; kalan sahneler Qwen-Image-Edit ile referanstaki karakterle, film oraninda.
      let remaining = missingImage;
      let reference = g.characterSource ? sourcePath(ctx.setting.outputRoot, g.characterSource) : imagePath(0);
      if (!reference) {
        await generate([remaining[0]], fromText, `image/${g.imageModel}`);
        reference = imagePath(remaining[0]);
        remaining = remaining.slice(1);
      }
      if (remaining.length) {
        const picture = await ctx.comfy.load(reference, `panel_${ctx.job.id}_karakter${extname(reference).toLowerCase() || '.png'}`);
        const [characterWidth, characterHeight] = CHARACTER_SIZE[g.ratio];
        await generate(remaining, (i) => ctx.mod.editJob({ pictures: [picture], text: characterPrompt(sceneImagePrompt(g.scenes[i], ctx.job.director[i])), seed: g.seed + i, width: characterWidth, height: characterHeight, prefix: `panel/${ctx.job.id}/s${no2(i)}` }), 'edit');
      }
    }
    ctx.job.stages.image = Math.round((Date.now() - startedAt) / 1000);
  }
  for (let i = 0; i < n; i++) {
    const on = `scene${no2(i)}.preview.jpg`;
    if (!existsSync(join(k, on))) await makePreview(ctx.setting.ffmpeg, imagePath(i), on, { cwd: k, signal: ctx.signal }).catch(() => {});
  }
  ctx.save();

  /* 2b) Dudak esleme: konusanlarin yeri ─────────────────────────────── */
  // Konusmali sahnede konusanlarin yuz kutusu (InfiniteTalk maskesi) yazi modelinin gorsel okumasiyla; ise kaydedilir.
  // Hayvan da konusur (olculdu 07.10.2026: kedinin agzi kendi sesinde 16 karenin 15'inde acik, kiz kapali; kullanici:
  // "Hayvan da olsa konusturabilmeliyiz"). Gorunen konusan yoksa sahne dudak eslemesiz (normal) uretilir.
  const [lipWidth, lipHeight] = vm.size[g.generation1080 === 'direct' ? '720p' : priority.resolution][direction];
  const lipCandidates = g.lip ? g.scenes.map((_, i) => i).filter((i) => g.scenes[i].dialogue?.length && !g.scenes[i].voiceSource) : [];
  // konusanYuzleri: once tam boy kutular "konusanlar"da tutuluyordu; yuz kutusu ayri anahtarda (eski isler yeniden bakar)
  ctx.job.speakerFaces ??= {};
  for (const i of lipCandidates) {
    if (ctx.job.speakerFaces[i] || existsSync(join(k, `scene${no2(i)}.mp4`))) continue;
    const s = g.scenes[i];
    const names = [...new Set(s.dialogue.map((x) => x.who))];
    ctx.progress({ percent: 20, stage: '2/5 Speaker positions', detail: `scene ${i + 1}` });
    try {
      const found = await findSpeakers(ctx, { image: imagePath(i), characters: names.map((name) => findCharacter(g.characters, name)), sceneText: s.image });
      ctx.job.speakerFaces[i] = found;
      ctx.log(`Scene ${i + 1} speakers: ${names.map((name) => `${name} ${!found[name].box ? 'not visible' : found[name].human ? 'visible' : 'visible (not human)'}`).join('; ')}`);
    } catch (e) {
      if (e instanceof CancelError) throw e;
      ctx.job.speakerFaces[i] = { error: e.message };
      ctx.log(`Scene ${i + 1}: speaker positions not found (${e.message}); the scene is made without lip sync.`);
    }
    ctx.save();
  }
  // Dudagi oynayacaklar: gorunen konusanlar (hayvan dahil); maske yuz kutusunun genisletilmisi (cene, agiz), iki maske
  // kesisirse ham yuz kutulari. Kutular video karesinin pikselinde.
  const cast = (i) => {
    const b = ctx.job.speakerFaces[i];
    const size = lipCandidates.includes(i) && b && !b.error ? imageSize(imagePath(i)) : null;
    if (!size) return [];
    const faces = Object.entries(b).filter(([, v]) => v?.box);
    const wide = faces.map(([, v]) => faceMask(v.box));
    const discrete = wide.every((a, x) => wide.every((c, y) => x === y || !intersects(a, c)));
    return faces
      .map(([name, v], x) => ({ name, box: boxPixel(discrete ? wide[x] : v.box, { imageWidth: size.width, imageHeight: size.height, width: lipWidth, height: lipHeight, margin: 0 }) }))
      .filter((o) => o.box);
  };
  const lipPlans = plans.map((p, i) => (cast(i).length ? lipWindows(p.target) : null));

  // Sahne klibi: sahnenin kareleri biter bitmez (3. adim) yazilir, kareler hemen silinir. Eskiden butun sahnelerin
  // PNG'leri film sonuna kadar diskte kaliyordu (720p'de 5 sn ~360 MB; 10 dk'lik film ~27 GB).
  const makeSceneClip = async (i) => {
    const clip = `scene${no2(i)}.mp4`;
    if (existsSync(join(k, clip))) return;
    const start4 = Date.now();
    const p = plans[i];
    const frameFolder = `scene${no2(i)}_frames`;
    const frameCount = pngs(join(k, frameFolder)).length;
    if (!frameCount) throw new Error(`Scene ${i + 1} has no frames.`);
    // Dudak eslemeli sahne sesle kare kare ayni zamanda: dogal 25 fps (fazlasi hedef surede kesilir)
    const speed = lipPlans[i] ? LIP.fps : inputFps({ frameCount, target: p.target, naturalFps: vm.fps * p.smooth, truncate: p.truncate });
    const how = lipPlans[i] ? `, lip sync, ${lipPlans[i].windows.length} windows` : `${p.truncate ? ', cropped' : p.slowdown > 1.001 ? `, ${p.slowdown.toFixed(2)}× slower` : ''}${p.part > 1 ? `, ${p.part} parts` : ''}`;
    ctx.progress({ detail: `Scene ${i + 1} clip: ${p.target.toFixed(1)} s${how}` });
    const temp = `scene${no2(i)}.writing.mp4`;
    await sceneClip(ctx.setting.ffmpeg, {
      cwd: k, pattern: `${frameFolder}/%05d.png`, inputFps: speed, voice: `scene${no2(i)}.wav`, frontSpace: DEFAULT.frontSpace,
      target: p.target, width: outWidth, height: outHeight, fps: g.fps ?? 30, output: temp, ready: ctx.setting.x264Ready, signal: ctx.signal,
      // Sahne klibi ara dosya (birleştirmede yeniden kodlanır): NVENC varsa onunla.
      encoder: await videoEncoder(ctx.setting.ffmpeg, ctx.setting.encoder),
    });
    renameSync(join(k, temp), join(k, clip));
    ctx.job.stages.fiction = (ctx.job.stages.fiction ?? 0) + Math.round((Date.now() - start4) / 1000);
    rmSync(join(k, frameFolder), { recursive: true, force: true });
  };

  /* 3) Videolar ─────────────────────────────────────────────────────── */
  writeFileSync(join(k, 'plan.json'), JSON.stringify({ plans, output: [outWidth, outHeight], wan: [wanWidth, wanHeight], transition: g.transition ? DEFAULT.transition : 0 }, null, 1), 'utf8');
  // Ilerleme birimi: normal sahnede parca, dudak eslemeli sahnede pencere
  const unit = (i) => lipPlans[i]?.windows.length ?? plans[i].part;
  const totalPart = plans.reduce((t, _, i) => t + unit(i), 0);
  let finishedPart = 0;
  for (let i = 0; i < n; i++) {
    const p = plans[i];
    const frameFolder = join(k, `scene${no2(i)}_frames`);
    const statusPath = join(frameFolder, 'checkpoint.json');
    let status = { part: 0, smooth: p.smooth };
    if (existsSync(join(k, `scene${no2(i)}.mp4`))) {
      finishedPart += unit(i);
      continue;
    }
    if (lipPlans[i]) {
      // Konusmali sahne: 25 fps, sesle ayni zamanda (yavaslatma yok); kareler pencere pencere (isler/dudak.mjs)
      const startedAt = Date.now();
      const dv = await lipVideo(ctx, {
        source: imagePath(i),
        sceneVoice: join(k, `scene${no2(i)}.wav`),
        lines: JSON.parse(readFileSync(join(k, `scene${no2(i)}.lines.json`), 'utf8')),
        cast: cast(i),
        frontSpace: DEFAULT.frontSpace,
        target: p.target,
        // Parca istemleri (yazi modeli replik sirasini bilerek yazdi); pencere ortasina dusen parca + kim konusuyor
        prompts: ctx.job.scenePrompts[i]?.length ? ctx.job.scenePrompts[i] : [g.scenes[i].motion],
        definition: Object.fromEntries(cast(i).map((o) => [o.name, characterDefinition(findCharacter(g.characters, o.name))])),
        acting: ctx.job.director[i]?.lines ?? [],
        seed: g.seed + 1000 + i * 10,
        width: lipWidth,
        height: lipHeight,
        targetFolder: frameFolder,
        prefixExtra: `s${no2(i)}`,
        stage: `3/5 Video: scene ${i + 1}/${n}`,
        range: [20 + (72 * finishedPart) / totalPart, 20 + (72 * (finishedPart + unit(i))) / totalPart],
        measurement: `video/lip/${priority.resolution}`,
      });
      // Agiz duzeltme (LatentSync): konusan INSANLARIN agzi kendi sesiyle; hayvan karma sonucuyla kalir. Bir kez (durum.json)
      const humans = cast(i).filter((o) => dv.speakers.includes(o.name) && findCharacter(g.characters, o.name)?.type !== 'animal');
      const dd = JSON.parse(readFileSync(statusPath, 'utf8'));
      // Bir kez denenir: basarisizlik (LatentSync uzun sahnede RAM) kaydedilir, her yeniden denemede dakikalarca
      // tekrarlanmaz. Kareler 1080p'ye buyutulduyse kutular 720p'ye gore: duzeltme yapilmaz.
      const mouthDone = Boolean(dd.mouth || dd.mouthError || dd.upscaled);
      if (humans.length && !mouthDone && !ctx.setting.hasMouth) {
        ctx.log('Mouth correction (LatentSync) not installed: lips with InfiniteTalk only (Settings > Models > "Mouth correction").');
      } else if (humans.length && !mouthDone) {
        try {
          await ctx.flushVoiceForGpu();
          const a = await fixMouth(ctx, { frameFolder, speakers: humans.map((o) => ({ name: o.name, trace: dv.traces[o.name], box: o.box })), total: dv.frameCount, stage: `3/5 Video: scene ${i + 1}/${n}` });
          writeFileSync(statusPath, JSON.stringify({ ...dd, mouth: a.speakers }), 'utf8');
          ctx.log(`Scene ${i + 1} mouth correction (LatentSync): ${a.speakers.join(', ')}; ${a.duration} s`);
          ctx.measure('video/mouth', a.duration / (dv.frameCount / LIP.fps));
        } catch (e) {
          if (e instanceof CancelError) throw e;
          writeFileSync(statusPath, JSON.stringify({ ...dd, mouthError: e.message }), 'utf8');
          ctx.log(`Scene ${i + 1}: mouth correction failed (${e.message}); using the InfiniteTalk result.`);
        }
      }
      finishedPart += unit(i);
      ctx.job.stages.video = (ctx.job.stages.video ?? 0) + Math.round((Date.now() - startedAt) / 1000);
      ctx.save();
      status = JSON.parse(readFileSync(statusPath, 'utf8'));
    } else {
      try {
        status = JSON.parse(readFileSync(statusPath, 'utf8'));
        if (status.smooth !== p.smooth) throw new Error('plan changed');
      } catch {
        rmSync(frameFolder, { recursive: true, force: true });
        status = { part: 0, smooth: p.smooth };
      }
      mkdirSync(frameFolder, { recursive: true });
      const deleted = deleteExtraFrames(frameFolder, status.part === 0 ? 0 : status.frame);
      if (deleted) ctx.log(`Scene ${i + 1}: ${deleted} frames removed from the unfinished part (resuming where it left off).`);
      const scenePrompts = ctx.job.scenePrompts[i];
      for (let part = status.part; part < p.part; part++) {
        const existing = pngs(frameFolder);
        const source = part === 0 ? imagePath(i) : join(frameFolder, existing[existing.length - 1]);
        const startedAt = Date.now();
        const rangeStart = 20 + (72 * finishedPart) / totalPart;
        const rangeLast = 20 + (72 * (finishedPart + 1)) / totalPart;
        const generated = await runWan(ctx, {
          model: g.videoModel,
          source,
          prompt: scenePrompts[Math.min(part, scenePrompts.length - 1)],
          seed: g.seed + 1000 + i * 10 + part,
          width: wanWidth,
          height: wanHeight,
          frame: vm.frame,
          smooth: p.smooth,
          target: frameFolder,
          startNo: existing.length + 1,
          skip: part === 0 ? 0 : 1,
          stage: `3/5 Video: scene ${i + 1}/${n}${p.part > 1 ? ` · part ${part + 1}/${p.part}` : ''}`,
          range: [rangeStart, rangeLast],
          prefixExtra: `s${no2(i)}p${part + 1}`,
          anatomy: ctx.job.sceneAnatomy?.[i],
        });
        status.part = part + 1;
        status.frame = generated.lastNo;
        writeFileSync(statusPath, JSON.stringify(status), 'utf8');
        finishedPart += 1;
        const duration = (Date.now() - startedAt) / 1000;
        ctx.job.stages.video = (ctx.job.stages.video ?? 0) + Math.round(duration);
        ctx.measure(`video/${g.videoModel}/${priority.resolution}`, duration / (vm.frame / vm.fps));
        ctx.save();
      }
    }
    if (g.generation1080 === 'upscale' && !status.upscaled) {
      const b = Date.now();
      await upscaleFrames(ctx, frameFolder, [outWidth, outHeight], `3/5 Video: scene ${i + 1}/${n} · 1080p upscaling`);
      status.upscaled = true;
      writeFileSync(statusPath, JSON.stringify(status), 'utf8');
      const sec = (Date.now() - b) / 1000;
      ctx.job.stages.upscale = (ctx.job.stages.upscale ?? 0) + Math.round(sec);
      ctx.log(`Scene ${i + 1}: ${pngs(frameFolder).length} frames upscaled to 1080p (${Math.round(sec)} s).`);
      ctx.save();
    }
    await makeSceneClip(i);
  }

  /* 4) Sahne klipleri ───────────────────────────────────────────────── */
  for (let i = 0; i < n; i++) await makeSceneClip(i);

  /* 5) Birlestirme + altyazi ─────────────────────────────────────── */
  const name = slug(g.title);
  // Muzik bolumleri ayri uretilip yumusak gecisle birlesir (dongu yok); plan 1b'de yazildi.
  if (musicToGenerate) {
    const startedAt = Date.now();
    const parts = [];
    let totalMusic = 0;
    for (let i = 0; i < sections.length; i++) {
      const name = `muzik_b${String(i + 1).padStart(3, '0')}.mp3`;
      const len = Math.min(MUSIC_LONGEST, Math.max(10, Math.ceil(sections[i].duration + (i < sections.length - 1 ? SECTION_TRANSITION : 0) + 1)));
      totalMusic += len;
      if (!existsSync(join(k, name))) {
        await generateMusic(ctx, { style: ctx.job.musicPlan.sections[i], duration: len, seed: g.seed + 5000 + i, file: name, stage: sections.length > 1 ? `5/5 Music ${i + 1}/${sections.length}` : '5/5 Music', range: [96, 97] });
      }
      parts.push(name);
    }
    await writeAtomic(join(k, 'music.mp3'), (temp) => mergeMusic(ctx.setting.ffmpeg, { cwd: k, parts, transition: SECTION_TRANSITION, output: temp, signal: ctx.signal }));
    ctx.job.stages.music = Math.round((Date.now() - startedAt) / 1000);
    ctx.measure('music', (Date.now() - startedAt) / 1000 / totalMusic);
  }
  const withMusic = Boolean(g.music) || g.musicMode === 'generate';
  const measure = subtitleMetrics(outWidth, outHeight);
  const words = (i) => {
    try {
      return JSON.parse(readFileSync(join(k, `scene${no2(i)}.words.json`), 'utf8'));
    } catch {
      return null; // Hızlı kalite ya da galeriden hazır ses: karakter oranıyla
    }
  };
  // Konusmali sahne: her satir kendi zamaninda (sceneNN.lines.json), replik konusanin adiyla ("Elif: ...")
  const lineTimes = (i) => {
    try {
      return JSON.parse(readFileSync(join(k, `scene${no2(i)}.lines.json`), 'utf8'));
    } catch {
      return null;
    }
  };
  const hints = g.scenes.flatMap((s, i) => {
    const start0 = starts[i] + DEFAULT.frontSpace;
    const time = lineTimes(i);
    if (!time) return timeSubtitles(subtitleSplit(s.narration, { lineLength: measure.lineLength }), start0, start0 + narrations[i], words(i));
    return time.flatMap((z) => timeSubtitles(subtitleSplit(z.who ? `${z.who}: ${z.text}` : z.text, { lineLength: measure.lineLength }), start0 + z.startedAt, start0 + z.last, z.words));
  });
  writeFileSync(join(k, `${name}.srt`), writeSrt(hints), 'utf8');
  let subtitle = null;
  if (g.subtitle) {
    writeFileSync(join(k, 'subtitles.ass'), writeAss(hints, { width: outWidth, height: outHeight }), 'utf8');
    subtitle = 'subtitles.ass';
  }
  ctx.progress({ percent: 97, stage: '5/5 Merging', detail: `${n} scene${n > 1 ? 's' : ''}, ${durationText(total)}${subtitle ? ', subtitled' : ''}${withMusic ? ', with music' : ''}` });
  const temp = `${name}.writing.mp4`;
  const start5 = Date.now();
  await mergeChunked(ctx, {
    scenes: durations.map((duration, i) => ({ path: `scene${no2(i)}.mp4`, duration })),
    transition,
    subtitle,
    music: g.musicMode === 'generate' ? { path: join(k, 'music.mp3'), level: MUSIC_LEVEL[g.musicLevel ?? 'low'] } : g.music ? { path: musicPath(ctx.setting.outputRoot, g.music), level: MUSIC_LEVEL[g.musicLevel ?? 'low'] } : null,
    fps: g.fps ?? 30,
    output: temp,
    progress: (o) => ctx.progress({ percent: 97 + o * 2.5, stage: '5/5 Merging' }),
  });
  renameSync(join(k, temp), join(k, `${name}.mp4`));
  ctx.job.stages.merge = Math.round((Date.now() - start5) / 1000);
  await makePreview(ctx.setting.ffmpeg, `${name}.mp4`, `${name}.preview.jpg`, { cwd: k, signal: ctx.signal }).catch(() => {});

  // Kareler buyuk (720p PNG ~1,5 MB): film bitince silinir; sahne klipleri kalir, ara mp4'ler silinir.
  for (let i = 0; i < n; i++) rmSync(join(k, `scene${no2(i)}_frames`), { recursive: true, force: true });
  rmSync(join(k, 'search'), { recursive: true, force: true });

  ctx.addOutputs([
    { file: `${name}.mp4`, type: 'video', preview: `${name}.preview.jpg`, width: outWidth, height: outHeight, duration: total, main: true },
    { file: `${name}.srt`, type: 'subtitle' },
    ...durations.map((duration, i) => ({ file: `scene${no2(i)}.mp4`, type: 'scene', preview: `scene${no2(i)}.preview.jpg`, duration, scene: i + 1 })),
  ]);
  ctx.log(`Film: ${n} scene${n > 1 ? 's' : ''}, ${durationText(total)}, ${name}.mp4`);
}
