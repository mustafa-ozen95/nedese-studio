/**
 * Model egitimi: yerel yazi modelini kullanicinin verisiyle egitir (egitim\egit.py, egitim\.venv).
 *  yontem 'ince'  : var olan model gelistirilir. Hazir temel (TEMEL_MODELLER, Hugging Face'ten indirilir)
 *                   QLoRA ile; daha once burada egitilmis bir model de temel olabilir (sifirdan egitilmis
 *                   bir model ise tum agirliklariyla egitime devam eder).
 *  yontem 'scratch' : veriden sozluk (SentencePiece) + kucuk Llama mimarisi, rastgele agirlikla egitim.
 * Asamalar: hazirla -> ince|scratch -> gguf (<ai>\llm\modeller\<ad>.gguf: Ayarlar > Yazi modeli'nde
 * secilir) -> ornek (egitilmis modelle birkac yanit). Egitilen HF klasoru egitim\modeller\<kimlik>\hf
 * kalir: sonraki egitimde "temel" olarak secilebilir. GPU: ComfyUI ve yazi modeli once bosaltilir.
 * Yarida kalan is yeniden denenirse biten asamalar atlanir (cikti dosyalari varsa). Egitim ~2 dakikada bir
 * (14B'de her adim) kayit noktasi yazar (egitim\modeller\<kimlik>\nokta.pt): duraklatilan, panel/bilgisayar
 * kapanirken yarida kalan ya da elektrigi kesilen egitim son tamamlanan adimdan surer.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { run as runProcess } from '../process.mjs';
import { CancelError, UserError } from '../errors.mjs';
import { UPLOAD_FOLDER } from '../settings.mjs';
import { text, number, choice, slug, generatorRequired, normalizeSource } from './common.mjs';
import { mergeCaptions } from '../data-collection.mjs';
import { MEDIA_FILES } from './data.mjs';
import { fineSetting } from '../fine-settings.mjs';
import { runFfmpeg, ffprobePath, framesToMp4, makePreview } from '../ffmpeg.mjs';

export const name = 'Model training';
/** Duraklatilabilir: surec durdurulur, "Devam ettir" kayit noktasindan surdurur (kuyruk.duraklat). */
export const pausable = true;

/** Egitim verisi olarak kabul edilen bicimler (egit.py hazirla). */
/** Kod egitimi icin kaynak dosyalar; .zip: depo arsivi (egit.py node_modules/vendor/.git/derleme ciktilarini atlar). */
export const CODE_EXTENSIONS = ['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.php', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.swift', '.dart', '.sql', '.sh', '.ps1', '.bat', '.vue', '.svelte', '.css', '.scss', '.yaml', '.yml', '.toml', '.xml', '.gradle', '.lua', '.r', '.scala'];
export const DATA_EXTENSIONS = ['.txt', '.md', '.html', '.htm', '.jsonl', '.json', '.csv', '.tsv', '.zip', ...CODE_EXTENSIONS, '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.mp4', '.mov', '.webm', '.mkv', '.avi'];

/**
 * Egitim alanlari (yol haritasi: metin, kod, gorsel, ses, video, genel). Su an metin ve kod (ayni QLoRA akisi);
 * digerleri ayri egitim yollariyla eklenecek.
 */
export const FIELDS = { text: 'Text', code: 'Code (software)', image: 'Image', music: 'Music', video: 'Video', general: 'General (image + text)' };
/** Muzik egitim verisi (muzik.py hazirla): sesler, ayni adli .txt sozler, .caption.txt tarif ve bunlari iceren .zip. */
export const MUSIC_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a'];
/** Muzik sarki dilleri (ACE-Step 1.5). */
export const MUSIC_LANGUAGES = ['tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'zh'];
/** Gorsel egitim verisi (gorsel.py hazirla): resimler, ayni adli .txt altyazilar ve bunlari iceren .zip. */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
/** Video egitim verisi: klipler (gorseller tek kare olarak da), ayni adli .txt altyazilar ve bunlari iceren .zip. */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.ogv'];
/** Video LoRA ornek boyutlari (Wan 2.2 5B: 32'nin katlari). 480p olculdu: 33 kare 3,4 sn/adim, tepe 8,4 GB. */
export const VIDEO_RESOLUTIONS = { '480p': { landscape: [832, 480], portrait: [480, 832], square: [640, 640] }, '320p': { landscape: [576, 320], portrait: [320, 576], square: [448, 448] } };
/** 720p (Wan 5B'nin dogal boyutu): 12 GB'ta sigmaz; ince ayar egitimVideo720p ile secilir (24 GB ve ustu kart). */
const VIDEO_720P = { '720p': { landscape: [1280, 704], portrait: [704, 1280], square: [960, 960] } };
/** Ornek klip uzunlugu (kare, 24 fps; Wan VAE 4n+1 ister). */
export const VIDEO_FRAMES = [17, 33, 49];

/** Secilebilir video LoRA cozunurlukleri / kareleri: ince ayar egitimVideo720p acikken 720p ve 81 kare de. */
export const videoResolutions = () => ({ ...(fineSetting('trainingVideo720p') ? VIDEO_720P : {}), ...VIDEO_RESOLUTIONS });
export const videoFrames = () => (fineSetting('trainingVideo720p') ? [...VIDEO_FRAMES, 81] : VIDEO_FRAMES);
const VIDEO_FPS = 24;
/** Veri seti ComfyUI'de RAM'de durur (T5 kosulu ~4 MB/ornek): en cok bu kadar ornek (ince ayar egitimVideoOrnek kapaliysa 1000). */
const videoMostExample = () => (fineSetting('trainingVideoExample') ? 120 : 1000);
/**
 * Egitim betiklerine ince ayar bayraklari (varsayilanda hicbiri: 12 GB ayari betiklerin kendi varsayilani).
 * fp8: gorsel LoRA temel modeli; dortBit: yazi/genel QLoRA; muzik: kodlayici ekran kartinda.
 */
export function trainingFlags({ fp8 = false, fourBit = false, music = false } = {}) {
  return [
    ...(fp8 && !fineSetting('trainingFp8') ? ['--full-precision'] : []),
    ...(fourBit && !fineSetting('trainingText4bit') ? ['--full-precision'] : []),
    ...(music && !fineSetting('trainingMusicEncoder') ? ['--encoder-gpu'] : []),
    ...(fineSetting('trainingGradient') ? [] : ['--no-gradient']),
  ];
}

/** Egitim dilimi (adim): her dilim LoRA'yi kaydeder; duraklatma/kesintide en cok bir dilim tekrarlanir. */
export const VIDEO_SLICE = 150;
/** Gorsel LoRA cozunurlukleri (12 GB: 1024 olculdu; 768/512 daha hizli ve az bellek). */
export const IMAGE_RESOLUTIONS = [512, 768, 1024];

/**
 * Hazir temeller: yalniz metin (CausalLM), lisans onayi istemeyen, 12 GB'ta QLoRA ile egitilebilen (14B dahil).
 * Cok kipli (Gemma 4 E4B, Qwen3.5: ConditionalGeneration) modeller bu yolda egitilemez. alan: listede hangi alanda.
 */
export const BASE_MODELS = {
  // 14B: 12 GB'ta 4-bit + embedding RAM'de + 4-bit çıktı katmanı + parçalı kayıp ile eğitilir (ölçüldü, egit.py).
  'Qwen/Qwen3-14B': { name: 'Qwen3 14B (recommended, best writing)', downloadGib: 30, field: 'text' },
  'Qwen/Qwen3-8B': { name: 'Qwen3 8B (balanced)', downloadGib: 17, field: 'text' },
  'Qwen/Qwen3-4B-Instruct-2507': { name: 'Qwen3 4B Instruct (fast)', downloadGib: 8, field: 'text' },
  'Qwen/Qwen3-1.7B': { name: 'Qwen3 1.7B (trial, very fast)', downloadGib: 4, field: 'text' },
  // Kod: Qwen2 mimarisi (14B ile ayni bellek ayarlari gecerli); Qwen3-Coder yalniz 30B (sigmaz).
  'Qwen/Qwen2.5-Coder-14B-Instruct': { name: 'Qwen2.5 Coder 14B (recommended for code)', downloadGib: 30, field: 'code' },
  'Qwen/Qwen2.5-Coder-7B-Instruct': { name: 'Qwen2.5 Coder 7B (fast code)', downloadGib: 16, field: 'code' },
  // Gorsel: musubi-tuner ile LoRA (egitim\gorsel.py). Egitim damitilmamis base 4B'de, kullanim 4 adimlik klein'da.
  'flux2-klein-4b': { name: 'FLUX.2 klein 4B (image LoRA; style, product, character)', downloadGib: 15, field: 'image', lora: true },
  // Muzik: Side-Step ile ACE-Step 1.5 base uzerinde LoRA (egitimmuzik.py); kullanim ComfyUI'de turbo ile.
  'acestep-15': { name: 'ACE-Step 1.5 (music LoRA; style, vocals, instrument)', downloadGib: 6, field: 'music', lora: true },
  // Video: ComfyUI'nin yerlesik egitim dugumleri (TrainLoraNode) ile kurulu Wan 2.2 TI2V 5B uzerinde LoRA (fp8, bypass,
  // blok basina gradyan checkpoint); indirme yok. Kullanim: Video > Wan 2.2 5B.
  'wan22-5b': { name: 'Wan 2.2 TI2V 5B (video LoRA; motion, style, character)', downloadGib: 0, field: 'video', lora: true },
  // Genel (cok kipli): Qwen3.5 gorsel + metin (Apache 2.0), egitim\genel.py QLoRA; sonuc yazi modeli GGUF + gorsel
  // kodlayici (mmproj). Olculdu 05.10.2026: 4B 19 ornek 3 devir 56 sn, tepe 5,8 GB.
  'Qwen/Qwen3.5-4B': { name: 'Qwen3.5 4B (image + text, recommended)', downloadGib: 9, field: 'general' },
  'Qwen/Qwen3.5-2B': { name: 'Qwen3.5 2B (image + text, fast)', downloadGib: 5, field: 'general' },
};
// The keys are train.py's --size choices.
export const SIZES = { small: 'Small (~30M parameters)', medium: 'Medium (~100M parameters)', large: 'Large (~240M parameters)' };
export const QUANTIZATIONS = ['Q4_K_M', 'Q5_K_M', 'Q8_0', 'F16'];
const HF_ID = /^[\w.-]+\/[\w.-]+$/;
const SAFE = /^[\w.-]+$/;

const recordPath = (aiRoot) => join(aiRoot, 'training', 'models', 'registry.json');

/** Burada egitilmis modeller (yeniden egitimde temel). En yeni basta. */
export function trainedModels(aiRoot) {
  try {
    const list = JSON.parse(readFileSync(recordPath(aiRoot), 'utf8'));
    // Ince ayarli model LoRA eklentisiyle (temel + adaptor), sifirdan egitilmis model kendi HF klasoruyle,
    // gorsel LoRA ComfyUI'nin LoRA klasorundeki dosyasiyla yasar.
    const exists = (m) => (['image', 'music', 'video'].includes(m.field) ? Boolean(m.loraPath) && existsSync(m.loraPath) : existsSync(join(aiRoot, 'training', 'models', m.id, ...(m.method === 'scratch' ? ['hf', 'config.json'] : ['adaptor', 'adapter_config.json']))));
    return (Array.isArray(list) ? list : []).filter((m) => m && SAFE.test(m.id ?? '') && exists(m));
  } catch {
    return [];
  }
}

/** Klasordeki dosyalarin toplam boyutu (bayt); alt klasorler dahil, baglantilar sayilmaz. */
function folderSize(path, depth = 0) {
  let total = 0;
  let names = [];
  try {
    names = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const a of names) {
    const y = join(path, a.name);
    if (a.isSymbolicLink()) continue;
    if (a.isDirectory()) {
      if (depth < 4) total += folderSize(y, depth + 1);
    } else {
      try {
        total += statSync(y).size;
      } catch {}
    }
  }
  return total;
}

/**
 * Hugging Face onbellegi (egitim\hf\hub\models--Kurum--Ad): indirilmis depolar -> { 'Kurum/Ad': { boyutBayt } }.
 * Kullanici 08.10.2026: "burada olanlar listelensin / sonradan dahil olanlar en ustte": temel model listesinde kurulu
 * olanlar (sonradan girilen ozel HF modelleri dahil) en ustte, boyutuyla.
 */
export function hfCache(aiRoot) {
  const hub = join(aiRoot, 'training', 'hf', 'hub');
  const result = {};
  let names = [];
  try {
    names = readdirSync(hub);
  } catch {
    return result;
  }
  for (const name of names) {
    const m = /^models--([\w.-]+)--([\w.-]+)$/.exec(name);
    if (!m) continue;
    const root = join(hub, name);
    let full = false;
    try {
      // En az bir anlik goruntude config.json ve agirlik dosyasi: indirme bitmis
      for (const s of readdirSync(join(root, 'snapshots'))) {
        const k = join(root, 'snapshots', s);
        if (existsSync(join(k, 'config.json')) && readdirSync(k).some((d) => /\.(safetensors|bin|gguf)$/.test(d))) full = true;
      }
    } catch {}
    if (!full) continue;
    // Windows'ta (baglanti yetkisi yok) gercek dosyalar snapshots'ta, blobs bos; Linux'ta tersi. Baglantilar sayilmaz: her dosya bir kez.
    result[`${m[1]}/${m[2]}`] = { sizeByte: folderSize(root) };
  }
  return result;
}

/** Hazir olmayan temellerin yerel klasoru (egitim\temeller\…); wan22-5b ComfyUI modelidir (videoKurulu). */
const BASE_FOLDER = { 'flux2-klein-4b': 'flux2-klein-base-4b', 'acestep-15': 'acestep' };

/** Temel modeller kurulu bilgisiyle + onbellekteki ozel (listede olmayan) depolar. */
export function baseModelStatuses(aiRoot, { videoInstalled = false } = {}) {
  const cache = hfCache(aiRoot);
  const gib = (b) => Math.round((b / 2 ** 30) * 10) / 10;
  const bases = Object.entries(BASE_MODELS).map(([id, m]) => {
    let installed = false;
    let sizeGib = null;
    if (cache[id]) {
      installed = true;
      sizeGib = gib(cache[id].sizeByte);
    } else if (BASE_FOLDER[id]) {
      const k = join(aiRoot, 'training', 'bases', BASE_FOLDER[id]);
      if (existsSync(k) && readdirSync(k).length) {
        installed = true;
        sizeGib = gib(folderSize(k));
      }
    } else if (id === 'wan22-5b') installed = videoInstalled;
    return { id, ...m, installed, sizeGib };
  });
  const custom = Object.entries(cache).filter(([k]) => !BASE_MODELS[k]).map(([id, v]) => ({ id, name: id, installed: true, sizeGib: gib(v.sizeByte), custom: true }));
  return { bases, customBases: custom };
}

function saveModel(aiRoot, record) {
  const path = recordPath(aiRoot);
  mkdirSync(join(aiRoot, 'training', 'models'), { recursive: true });
  let list = [];
  try {
    list = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  list = [record, ...(Array.isArray(list) ? list : []).filter((m) => m?.id !== record.id)];
  writeFileSync(`${path}.tmp`, JSON.stringify(list, null, 1));
  renameSync(`${path}.tmp`, path);
}

/** Veri: yuklenen dosya (yukleme/<ad>) ya da toplanan koleksiyon (koleksiyon/<kimlik>, Veri toplama isi). */
function dataPath(setting, ref) {
  const outputRoot = setting.outputRoot;
  const part = normalizeSource(ref).split('/');
  // collection/<kimlik> (ham yazilar: yazilar.jsonl) ya da collection/<kimlik>/<training-meta|training-translation|...> (egitime hazir sohbet dosyasi)
  if (part[0] === 'collection' && (part.length === 2 || part.length === 3) && SAFE.test(part[1]) && !/^\.+$/.test(part[1]) && (part.length === 2 || /^(articles|training-[a-z]+)$/.test(part[2]))) {
    const file = join(setting.aiRoot, 'data', 'collections', part[1], `${part[2] ?? 'articles'}.jsonl`);
    if (!existsSync(file)) throw new UserError(`Collection not found: ${part.slice(1).join('/')}`);
    return file;
  }
  if (part[0] !== 'upload' || part.length !== 2 || !SAFE.test(part[1])) throw new UserError('Invalid data file.');
  const full = resolve(join(outputRoot, UPLOAD_FOLDER, part[1]));
  if (!full.startsWith(resolve(outputRoot) + sep)) throw new UserError('Data file is outside the panel folder.');
  if (!DATA_EXTENSIONS.includes(extname(full).toLowerCase())) throw new UserError(`Unsupported data format (${extname(full) || 'no extension'}).`);
  if (!existsSync(full)) throw new UserError('Data file not found (it may have been deleted).');
  return full;
}

/** Veri toplama koleksiyonunun indirilen medyasi: collection/<kimlik>/images | videolar | voices (diskte MEDIA_FILES adlari). */
// captions: indirilen gorseller, altyazi yerine yazi modelinin betimlemesiyle (Image captioning isi, describe.mjs)
const MEDIA_TYPES = { images: 'image', videos: 'video', audio: 'audio', captions: 'captioned image' };

export function mediaRef(ref) {
  const p = normalizeSource(ref).split('/');
  return p.length === 3 && p[0] === 'collection' && SAFE.test(p[1]) && !/^\.+$/.test(p[1]) && MEDIA_TYPES[p[2]] ? { id: p[1], type: p[2] } : null;
}

/**
 * Koleksiyonun betimleri (captions.jsonl): Map dosya -> betim; ayni gorselin son betimi gecerli. dil verilirse yalniz o dil.
 * Konu denetiminde uygun olmayan (uygun: false) gorsel atlanir (egitime girmez); hepsi: true ile dahil (kaldigi yerden surme).
 */
export function readCaptions(root, language = null, { all = false } = {}) {
  const map = new Map();
  const file = join(root, 'captions.jsonl');
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let b;
    try {
      b = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof b?.file !== 'string' || typeof b.caption !== 'string' || !b.caption || (language && b.language !== language)) continue;
    if (b.suitable === false && !all) map.delete(b.file);
    else map.set(b.file, b.caption);
  }
  return map;
}

/**
 * Koleksiyonun indirilmis medyasi: [{ yol, dosya, metin }]. Altyazi: gorselde altyazi/alt metin, video ve seste aciklama
 * ya da baslik; betimlerde yazi modelinin betimlemesi (betimlenmemis gorsel alinmaz).
 */
export function collectionMedia(setting, { id, type }) {
  if (type === 'captions') {
    const captions = readCaptions(join(setting.aiRoot, 'data', 'collections', id));
    const list = collectionMedia(setting, { id, type: 'images' }).filter((m) => captions.has(m.file)).map((m) => ({ ...m, text: captions.get(m.file) }));
    if (!list.length) throw new UserError(`Collection "${id}" has no captioned images (Training > Collected collections > "Describe images").`);
    return list;
  }
  const root = join(setting.aiRoot, 'data', 'collections', id);
  const file = join(root, `${MEDIA_FILES[type]}.jsonl`);
  if (!existsSync(file)) throw new UserError(`Collection not found: ${id}`);
  const list = [];
  const seen = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let k;
    try {
      k = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof k?.file !== 'string' || seen.has(k.file)) continue;
    const path = resolve(root, k.file);
    if (!path.startsWith(resolve(root, 'media') + sep) || !existsSync(path)) continue;
    seen.add(k.file);
    // Caption: title/alt text + description, cleaned (no licence sentence, Wikidata leftovers or camera file name)
    const text = type === 'images' ? mergeCaptions(k.alt, k.caption || k.text) : mergeCaptions(k.title, k.description || k.text);
    list.push({ path, file: k.file, text });
  }
  if (!list.length) throw new UserError(`No downloaded ${MEDIA_TYPES[type]} files in collection "${id}" (select "Media: download" in Data collection).`);
  return list;
}

/**
 * Egitime klasor: koleksiyonun medyasi (ayni surucude sert baglanti, yer kaplamaz; olmazsa kopya) + ayni adli altyazi
 * .txt (seste tarif: .caption.txt). Hazirlik betikleri klasoru dosyalarina acar.
 */
function collectionFolder(setting, ref, target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const { path, text } of collectionMedia(setting, ref)) {
    const name = basename(path).replace(/\.oga$/i, '.ogg'); // Ogg ses: egitim uzanti listesinde .ogg
    try {
      linkSync(path, join(target, name));
    } catch {
      copyFileSync(path, join(target, name));
    }
    if (text) writeFileSync(join(target, `${basename(name, extname(name))}${ref.type === 'audio' ? '.caption' : ''}.txt`), text, 'utf8');
  }
  return target;
}

/** Medya koleksiyonu bu alanda kullanilabilir mi (dogrulamada): uygun degilse acik hata, uygunsa true. */
function mediaSuitable(ref, types, fieldName) {
  const m = mediaRef(ref);
  if (!m) return false;
  if (!types.includes(m.type)) throw new UserError(`${fieldName} training uses the ${types.map((t) => MEDIA_TYPES[t]).join(' or ')} files of the collection: ${String(ref).slice(0, 80)}`);
  return true;
}

/** Betige verilecek yol: yuklenen dosya / metin koleksiyonu ya da medya koleksiyonunun is klasorunde hazirlanan kopyasi. */
function workPath(ctx, v) {
  const m = mediaRef(v);
  return m ? collectionFolder(ctx.setting, m, join(ctx.folder, 'collection', `${m.id}-${m.type}`)) : dataPath(ctx.setting, v);
}

/** Gorsel LoRA egitimi girdisi: resimler (+ .txt altyazi, .zip), tetik kelime, adim, LoRA boyutu, cozunurluk. */
function validateImage(g, setting, dataItems) {
  if (!setting.hasImageTraining) throw new UserError('Image training not installed (training\\musubi\\.venv, training\\image.py and the FLUX.2 klein training files; setup\\setup.ps1).');
  for (const v of dataItems) {
    if (mediaSuitable(v, ['images', 'captions'], 'Image')) {
      collectionMedia(setting, mediaRef(v));
      continue;
    }
    const path = dataPath(setting, v);
    if (![...IMAGE_EXTENSIONS, '.txt', '.zip'].includes(extname(path).toLowerCase())) throw new UserError(`For image training, upload PNG/JPEG/WebP images (optionally same-named .txt captions) or a .zip containing them: ${String(v).slice(0, 80)}`);
  }
  const name = text(g.name, 'Model name', { max: 60 });
  let base = String(g.base ?? '').trim() || 'flux2-klein-4b';
  let previous = null;
  if (base.startsWith('trained:')) {
    previous = trainedModels(setting.aiRoot).find((m) => m.id === base.slice('trained:'.length) && m.field === 'image');
    if (!previous) throw new UserError('Image LoRA to improve not found (it may have been deleted).');
    base = previous.base ?? 'flux2-klein-4b';
  }
  if (BASE_MODELS[base]?.field !== 'image') throw new UserError(`Base model for image training: ${Object.entries(BASE_MODELS).filter(([, m]) => m.field === 'image').map(([k]) => k).join(', ')}`);
  // Tetik kelime: istemde LoRA'yi cagiran ozel kelime (varsayilan addan; harf, rakam, tire)
  const trigger = String(g.trigger ?? '').trim() || previous?.trigger || `${slug(name, 'stil').replace(/-/g, '').slice(0, 12)}stil`;
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(trigger)) throw new UserError('Trigger word must be 2-32 letters/digits with no spaces (e.g. nedesestil).');
  return {
    name: name,
    field: 'image',
    method: 'fine',
    base: previous ? `trained:${previous.id}` : base,
    dataItems: dataItems.map((v) => String(v).trim()),
    trigger,
    description: text(g.description, 'General description', { required: false, max: 300 }),
    step: number(g.step, 'Steps', { min: 0, max: 10000, full: true, defaultValue: 0 }),
    rank: choice(String(g.rank ?? '16'), 'LoRA size', ['8', '16', '32', '64'], '16'),
    resolution: Number(choice(String(g.resolution ?? '1024'), 'Resolution', IMAGE_RESOLUTIONS.map(String), '1024')),
    ratio: number(g.ratio, 'Learning rate', { min: 0, max: 0.01, defaultValue: 0 }),
  };
}

/** Muzik LoRA egitimi girdisi: sesler (+ .txt sozler / .caption.txt tarif, .zip), tetik, tarif, dil, devir, LoRA boyutu. */
function validateMusic(g, setting, dataItems) {
  if (!setting.hasMusicTraining) throw new UserError('Music training not installed (training\\sidestep\\.venv and training\\music.py; setup\\setup.ps1).');
  for (const v of dataItems) {
    if (mediaSuitable(v, ['audio'], 'Music')) {
      collectionMedia(setting, mediaRef(v));
      continue;
    }
    const path = dataPath(setting, v);
    if (![...MUSIC_EXTENSIONS, '.txt', '.zip'].includes(extname(path).toLowerCase())) throw new UserError(`For music training, upload audio files (WAV, MP3, FLAC, OGG, M4A; same-named .txt lyrics optional) or a .zip containing them: ${String(v).slice(0, 80)}`);
  }
  const name = text(g.name, 'Model name', { max: 60 });
  let base = String(g.base ?? '').trim() || 'acestep-15';
  let previous = null;
  if (base.startsWith('trained:')) {
    previous = trainedModels(setting.aiRoot).find((m) => m.id === base.slice('trained:'.length) && m.field === 'music');
    if (!previous) throw new UserError('Music LoRA to improve not found (it may have been deleted).');
    base = previous.base ?? 'acestep-15';
  }
  if (BASE_MODELS[base]?.field !== 'music') throw new UserError('Base model for music training: acestep-15');
  const trigger = String(g.trigger ?? '').trim() || previous?.trigger || `${slug(name, 'style').replace(/-/g, '').slice(0, 12)}style`;
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(trigger)) throw new UserError('Trigger word must be 2-32 letters/digits with no spaces (e.g. nedesemuzik).');
  return {
    name: name,
    field: 'music',
    method: 'fine',
    base: previous ? `trained:${previous.id}` : base,
    dataItems: dataItems.map((v) => String(v).trim()),
    trigger,
    description: text(g.description, 'Style description', { required: false, max: 300 }),
    lang: choice(g.lang, 'Lyrics language', MUSIC_LANGUAGES, previous?.language ?? 'tr'),
    epoch: number(g.epoch, 'Epochs', { min: 0, max: 5000, full: true, defaultValue: 0 }),
    rank: choice(String(g.rank ?? '32'), 'LoRA size', ['16', '32', '64'], '32'),
  };
}

/** Video LoRA egitimi icin eksik (bos: hazir): comfy.mjs wanIsi + Wan 2.2 5B, T5, VAE dosyalari + ffmpeg. */
export function videoTrainingMissing(mod, setting) {
  if (!setting.ffmpeg) return 'ffmpeg not found (setup\\setup.ps1).';
  try {
    generatorRequired(mod, 'wanJob', 'Video training (Wan 2.2 5B)', setting.modelRoot);
  } catch (e) {
    return e.message;
  }
  return '';
}

/** Video LoRA egitimi girdisi: klipler/gorseller (+ .txt altyazi, .zip), tetik, cozunurluk, klip uzunlugu, adim, LoRA boyutu. */
function validateVideo(g, setting, mod, dataItems) {
  const missing = videoTrainingMissing(mod, setting);
  if (missing) throw new UserError(missing);
  for (const v of dataItems) {
    if (mediaSuitable(v, ['videos', 'images'], 'Video')) {
      collectionMedia(setting, mediaRef(v));
      continue;
    }
    const path = dataPath(setting, v);
    if (![...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, '.txt', '.zip'].includes(extname(path).toLowerCase())) throw new UserError(`For video training upload clips (MP4, MOV, WebM, MKV, AVI; images and same-name .txt captions optional) or a .zip containing them: ${String(v).slice(0, 80)}`);
  }
  const name = text(g.name, 'Model name', { max: 60 });
  let base = String(g.base ?? '').trim() || 'wan22-5b';
  let previous = null;
  if (base.startsWith('trained:')) {
    previous = trainedModels(setting.aiRoot).find((m) => m.id === base.slice('trained:'.length) && m.field === 'video');
    if (!previous) throw new UserError('Video LoRA to improve not found (it may have been deleted).');
    base = previous.base ?? 'wan22-5b';
  }
  if (BASE_MODELS[base]?.field !== 'video') throw new UserError('Base model for video training: wan22-5b');
  const trigger = String(g.trigger ?? '').trim() || previous?.trigger || `${slug(name, 'video').replace(/-/g, '').slice(0, 12)}video`;
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(trigger)) throw new UserError('The trigger word must be 2-32 letters/digits, no spaces (e.g. nedesevideo).');
  return {
    name: name,
    field: 'video',
    method: 'fine',
    base: previous ? `trained:${previous.id}` : base,
    dataItems: dataItems.map((v) => String(v).trim()),
    trigger,
    description: text(g.description, 'General description', { required: false, max: 300 }),
    resolution: choice(g.resolution, 'Resolution', Object.keys(videoResolutions()), '480p'),
    frame: Number(choice(String(g.frame ?? '33'), 'Clip length (frames)', videoFrames().map(String), '33')),
    step: number(g.step, 'Steps', { min: 0, max: 10000, full: true, defaultValue: 0 }),
    // Gelistirmede LoRA boyutu oncekiyle ayni olmali (agirliklar ustune egitilir)
    rank: previous?.training?.rank ? String(previous.training.rank) : choice(String(g.rank ?? '16'), 'LoRA size', ['8', '16', '32'], '16'),
    ratio: number(g.ratio, 'Learning rate', { min: 0, max: 0.01, defaultValue: 0 }),
  };
}

/** Genel (cok kipli) model girdisi: gorseller + ayni adli .txt yanitlar, gorselli sohbet JSONL, metin/soru-cevap, .zip. */
function validateGeneral(g, setting, dataItems) {
  if (!setting.hasGeneralTraining) throw new UserError('General model training not installed (training\\.venv and training\\general.py; setup\\setup.ps1).');
  if (!dataItems.length) throw new UserError('Upload at least one data file: images with same-name .txt answers, chat JSONL with images, text or Q&A files (or a .zip).');
  if (dataItems.length > 500) throw new UserError('At most 500 files (use a .zip for more).');
  const base = String(g.base ?? '').trim() || 'Qwen/Qwen3.5-4B';
  if (base.startsWith('trained:')) {
    if (!trainedModels(setting.aiRoot).some((m) => m.id === base.slice('trained:'.length) && m.field === 'general')) throw new UserError('The general model to improve was not found (it may have been deleted).');
  } else if (BASE_MODELS[base]?.field !== 'general') {
    throw new UserError(`Base for the general model: ${Object.entries(BASE_MODELS).filter(([, m]) => m.field === 'general').map(([k]) => k).join(', ')} or a general model trained here.`);
  }
  return {
    name: text(g.name, 'Model name', { max: 60 }),
    field: 'general',
    method: 'fine',
    base,
    dataItems: dataItems.map((v) => (mediaSuitable(v, ['images', 'captions'], 'General model') ? collectionMedia(setting, mediaRef(v)) : dataPath(setting, v), String(v).trim())),
    epoch: number(g.epoch, 'Epochs', { min: 0.1, max: 50, defaultValue: 2 }),
    context: number(g.context, 'Context length', { min: 256, max: 8192, full: true, defaultValue: 2048 }),
    ratio: number(g.ratio, 'Learning rate', { min: 0, max: 0.01, defaultValue: 0 }),
    quantization: choice(g.quantization, 'Quantization', QUANTIZATIONS, 'Q4_K_M'),
    examplePrompt: text(g.examplePrompt, 'Sample prompt', { required: false, max: 500 }),
    imagePrompt: text(g.imagePrompt, 'Image question', { required: false, max: 300 }),
  };
}

export function validate(g, { setting, mod }) {
  const dataItems = Array.isArray(g.dataItems) ? g.dataItems : g.data ? [g.data] : [];
  if (g.field === 'general') return validateGeneral(g, setting, dataItems);
  if (g.field === 'video') {
    if (!dataItems.length) throw new UserError('Upload at least one video clip (MP4, MOV, WebM, MKV, AVI; same-name .txt captions optional) or a .zip containing the clips.');
    if (dataItems.length > 500) throw new UserError('At most 500 files (use a .zip for more).');
    return validateVideo(g, setting, mod, dataItems);
  }
  if (g.field === 'music') {
    if (!dataItems.length) throw new UserError('Upload at least 2 songs (WAV, MP3, FLAC, OGG, M4A; same-named .txt lyrics optional) or a .zip containing the songs.');
    if (dataItems.length > 500) throw new UserError('At most 500 files (use a .zip for more).');
    return validateMusic(g, setting, dataItems);
  }
  if (g.field === 'image') {
    if (!dataItems.length) throw new UserError('Upload at least 3 images (PNG, JPEG, WebP; same-named .txt captions optional) or a .zip containing the images.');
    if (dataItems.length > 500) throw new UserError('At most 500 files (use a .zip for more).');
    return validateImage(g, setting, dataItems);
  }
  if (!setting.hasTrainingEnv) throw new UserError('Model training not installed (training\\.venv or training\\train.py missing; setup.bat).');
  if (!dataItems.length) throw new UserError('Upload at least one data file (TXT, MD, HTML, JSONL, JSON, CSV; code files or a repository .zip).');
  if (dataItems.length > 50) throw new UserError('At most 50 data files.');
  const field = choice(g.field, 'Field', Object.keys(FIELDS), 'text');
  const method = choice(g.method, 'Method', ['fine', 'scratch'], 'fine');
  const scratch = method === 'scratch';
  let base = null;
  if (!scratch) {
    base = String(g.base ?? '').trim() || Object.entries(BASE_MODELS).find(([, m]) => m.field === field)[0];
    if (base.startsWith('trained:')) {
      const id = base.slice('trained:'.length);
      if (!trainedModels(setting.aiRoot).some((m) => m.id === id)) throw new UserError('The selected trained model was not found (it may have been deleted).');
    } else if (!HF_ID.test(base)) {
      throw new UserError('The base model must be a Hugging Face name like "org/model" or a trained model.');
    }
  }
  const name = text(g.name, 'Model name', { max: 60 });
  return {
    name: name,
    field,
    method,
    ...(scratch ? { size: choice(g.size, 'Model size', Object.keys(SIZES), 'small') } : { base }),
    dataItems: dataItems.map((v) => (dataPath(setting, v), String(v).trim())),
    epoch: number(g.epoch, 'Epochs', { min: 0.1, max: 50, defaultValue: scratch ? 3 : 2 }),
    context: number(g.context, 'Context length', { min: 128, max: 8192, full: true, defaultValue: scratch ? 512 : 2048 }),
    ratio: number(g.ratio, 'Learning rate', { min: 0, max: 0.01, defaultValue: 0 }),
    quantization: choice(g.quantization, 'Quantization', QUANTIZATIONS, scratch ? 'Q8_0' : 'Q4_K_M'),
    examplePrompt: text(g.examplePrompt, 'Sample prompt', { required: false, max: 500 }),
  };
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Veri kaynaklari metni: "2 files", "collection "x" (downloaded images)", ikisi birlikte. */
function dataText(dataItems, unit = 'file') {
  const collections = dataItems.filter((v) => String(v).startsWith('collection/'));
  const name = { images: 'downloaded images', videos: 'downloaded videos', audio: 'downloaded audio', captions: 'captioned images' };
  const parts = [];
  if (dataItems.length - collections.length) parts.push(plural(dataItems.length - collections.length, unit));
  if (collections.length) parts.push(collections.length === 1 ? `collection "${String(collections[0]).split('/')[1]}"${name[String(collections[0]).split('/')[2]] ? ` (${name[String(collections[0]).split('/')[2]]})` : ''}` : plural(collections.length, 'collection'));
  return parts.join(' + ');
}

export function summary(g) {
  if (g.field === 'general') return { title: g.name, detail: `General (image + text) · ${BASE_MODELS[g.base]?.name?.replace(/ \(.*$/, '') ?? 'improve'} · ${dataText(g.dataItems, 'data file')} · ${plural(g.epoch, 'epoch')}` };
  if (g.field === 'video') return { title: g.name, detail: `Video LoRA · Wan 2.2 5B · trigger "${g.trigger}" · ${dataText(g.dataItems)} · ${g.resolution} · ${g.frame} frames${g.step ? ` · ${g.step} steps` : ''}` };
  if (g.field === 'music') return { title: g.name, detail: `Music LoRA · ACE-Step 1.5 · trigger "${g.trigger}" · ${dataText(g.dataItems)} · ${g.lang}${g.epoch ? ` · ${plural(g.epoch, 'epoch')}` : ''}` };
  if (g.field === 'image') return { title: g.name, detail: `Image LoRA · ${BASE_MODELS[g.base]?.name?.replace(/ \(.*$/, '') ?? 'FLUX.2 klein 4B'} · trigger "${g.trigger}" · ${dataText(g.dataItems)} · ${g.resolution} px${g.step ? ` · ${g.step} steps` : ''}` };
  const how = g.method === 'scratch' ? `from scratch · ${SIZES[g.size] ?? g.size}` : `fine-tune · ${BASE_MODELS[g.base]?.name ?? g.base}`;
  return { title: g.name, detail: `${FIELDS[g.field] ?? 'Text'} · ${how} · ${dataText(g.dataItems, 'data file')} · ${plural(g.epoch, 'epoch')}` };
}

/** train.py'yi (gorsel: image.py) calistirir; betigin "ilerleme"/"HATA:"/"sonuc" satirlarini isler, sonuc nesnesini dondurur. */
async function script(ctx, args, stage, { image = false, music = false, general = false } = {}) {
  const k = general ? ctx.setting.generalTrainingCommand(args) : music ? ctx.setting.musicTrainingCommand(args) : image ? ctx.setting.imageTrainingCommand(args) : ctx.setting.trainingCommand(args);
  let lastLines = [];
  let output = null;
  await runProcess(k.command, k.args, {
    env: k.env,
    cwd: ctx.folder,
    signal: ctx.signal,
    name: `training-${args[0]}`,
    line: (s) => {
      lastLines = [...lastLines, s].slice(-12);
      const m = /^progress (\d+) (.*)$/.exec(s);
      if (m) {
        ctx.progress({ percent: Number(m[1]), stage, detail: m[2] });
        // Adim satirlari 5 sn'de bir gelir: gunluge yalniz asama degisimleri ve her ~%10
        if (!/^Training step/.test(m[2]) || Number(m[1]) % 10 === 0) ctx.log(m[2]);
      } else if (s.startsWith('result ')) {
        try {
          output = JSON.parse(s.slice(7));
        } catch {}
      } else if (/^ERROR:|Error|Traceback/.test(s)) ctx.log(s);
    },
  }).catch((e) => {
    const error = lastLines.find((s) => s.startsWith('ERROR:'));
    throw error ? new UserError(error.slice(6).trim()) : e;
  });
  return output ?? {};
}

/**
 * Gorsel LoRA: hazirla (resimler + altyazilar) -> egit (musubi; kayit noktasi, duraklat/devam) -> LoRA ComfyUI'nin
 * LoRA klasorune -> kayit (Gorsel uretiminde FLUX.2 klein ile secilir) -> ornek gorseller (tetik kelimeyle, ComfyUI).
 */
async function runImage(ctx) {
  const g = ctx.job.input;
  const aiRoot = ctx.setting.aiRoot;
  const id = ctx.job.trainingId ?? `${slug(g.name, 'model').slice(0, 40)}-${ctx.job.id.slice(0, 15)}`;
  if (!ctx.job.trainingId) {
    ctx.job.trainingId = id;
    ctx.save();
  }
  const modelFolder = join(aiRoot, 'training', 'models', id);
  const data = join(ctx.folder, 'data');
  const previous = g.base?.startsWith('trained:') ? trainedModels(aiRoot).find((m) => m.id === g.base.slice('trained:'.length)) : null;
  const loraName = `${slug(g.name, 'lora').slice(0, 50)}-${ctx.job.id.slice(0, 15)}`;
  const loraFolder = join(ctx.setting.modelRoot, 'loras');
  if (!existsSync(join(data, 'summary.json'))) {
    ctx.progress({ percent: 0, stage: 'Preparing images' });
    await script(ctx, ['prepare', '--output', data, '--trigger', g.trigger, '--description', g.description ?? '', ...g.dataItems.map((v) => workPath(ctx, v))], 'Preparing images', { image: true });
    rmSync(join(ctx.folder, 'collection'), { recursive: true, force: true }); // koleksiyon hazirligi (sert baglantilar) artik veri klasorunde
  }
  const o = JSON.parse(readFileSync(join(data, 'summary.json'), 'utf8'));
  ctx.log(`Data: ${o.image} images (${o.captioned} captioned); sample caption: "${String(o.exampleCaption).slice(0, 120)}"`);
  let info = existsSync(join(modelFolder, 'training.json')) && existsSync(join(loraFolder, `${loraName}.safetensors`)) ? JSON.parse(readFileSync(join(modelFolder, 'training.json'), 'utf8')) : null;
  if (!info) {
    await ctx.flushVoiceForGpu();
    const arg = ['train', '--data', data, '--output', modelFolder, '--name', loraName, '--lora-folder', loraFolder,
      '--vae', join(ctx.setting.modelRoot, 'vae', 'flux2-vae.safetensors'), '--rank', String(g.rank), '--resolution', String(g.resolution),
      ...(g.step ? ['--step', String(g.step)] : []), ...(g.ratio ? ['--ratio', String(g.ratio)] : []), ...(previous?.loraPath ? ['--previous', previous.loraPath] : []), ...trainingFlags({ fp8: true })];
    info = await script(ctx, arg, 'Image LoRA training', { image: true });
  }
  const record = {
    id, name: g.name, field: 'image', method: 'lora', base: previous?.base ?? (g.base?.startsWith('trained:') ? 'flux2-klein-4b' : g.base), improved: previous?.id ?? null,
    lora: `${loraName}.safetensors`, loraPath: join(loraFolder, `${loraName}.safetensors`), trigger: g.trigger, jobId: ctx.job.id, dateText: new Date().toISOString(),
    data: { image: o.image, captioned: o.captioned }, training: { step: info.step, durationSec: info.durationSec, lastLoss: info.losses?.at(-1) ?? null, resolution: info.resolution, rank: info.rank, sizeMb: info.sizeMb },
  };
  saveModel(aiRoot, record);
  // Ornek gorseller: ayni istem LoRA'siz ve LoRA'li (fark gorulsun); ComfyUI yoksa atlanir
  const examples = [];
  if (ctx.runComfy && ctx.mod?.fluxJob) {
    try {
      const { addLora, merge, nodes } = await import('../graph.mjs');
      const { images } = await import('../comfy-client.mjs');
      const prompt = `${g.trigger}, ${o.exampleCaption?.replace(new RegExp(`^${g.trigger},?\\s*`, 'i'), '') || g.description || 'a detailed photo'}`;
      const graphs = [false, true].map((withLora, i) => {
        const gr = ctx.mod.fluxJob({ text: prompt, seed: 2026, width: 1024, height: 1024, prefix: `panel/${ctx.job.id}/example${i + 1}` });
        if (withLora) addLora(gr, record.lora, 1);
        return gr;
      });
      const { job, match } = merge(graphs);
      const records = graphs.map((gr, i) => match[i][nodes(gr, 'SaveImage')[0]]);
      ctx.progress({ percent: 97, stage: 'Sample images', detail: prompt.slice(0, 120) });
      const outputs = await ctx.runComfy(job, { stage: 'Sample images', range: [97, 99] });
      for (const [i, name] of ['example-without-lora.png', 'example-with-lora.png'].entries()) {
        const list = images(outputs, records[i]);
        if (!list.length) continue;
        await ctx.comfy.getOutput(list[0], join(ctx.folder, name));
        ctx.addOutput({ file: name, type: 'image', name: i ? `With LoRA: ${prompt.slice(0, 60)}` : `Without LoRA (comparison)`, main: i === 1 });
        examples.push(name);
      }
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log(`Could not generate sample image: ${e.message}`);
    }
  }
  writeFileSync(join(ctx.folder, 'training.json'), JSON.stringify({ ...record, examples, losses: info.losses ?? [] }, null, 1));
  ctx.addOutput({ file: 'training.json', type: 'training', lora: record.lora, trigger: g.trigger, examples, losses: info.losses ?? [], ...record.training });
  ctx.log(`Image LoRA ready: ${record.lora} (trigger "${g.trigger}"). Select it with FLUX.2 klein in the Image tab.`);
  ctx.progress({ percent: 100, stage: 'Done', detail: record.lora });
}

/**
 * Muzik LoRA: hazirla (sesler + sozler) -> egit (Side-Step; on isleme, egitim, kayit noktasi, ComfyUI'ye aktarma) ->
 * kayit (Muzik uretiminde ACE-Step turbo ile secilir) -> ornek sarkilar (ayni tarz/tohum, LoRA'siz ve LoRA'li).
 */
async function runMusic(ctx) {
  const g = ctx.job.input;
  const aiRoot = ctx.setting.aiRoot;
  const id = ctx.job.trainingId ?? `${slug(g.name, 'model').slice(0, 40)}-${ctx.job.id.slice(0, 15)}`;
  if (!ctx.job.trainingId) {
    ctx.job.trainingId = id;
    ctx.save();
  }
  const modelFolder = join(aiRoot, 'training', 'models', id);
  const data = join(ctx.folder, 'data');
  const previous = g.base?.startsWith('trained:') ? trainedModels(aiRoot).find((m) => m.id === g.base.slice('trained:'.length)) : null;
  const loraName = `${slug(g.name, 'lora').slice(0, 50)}-${ctx.job.id.slice(0, 15)}`;
  const loraFolder = join(ctx.setting.modelRoot, 'loras');
  if (!existsSync(join(data, 'summary.json'))) {
    ctx.progress({ percent: 0, stage: 'Preparing songs' });
    await script(ctx, ['prepare', '--output', data, '--trigger', g.trigger, '--description', g.description ?? '', '--language', g.lang, ...g.dataItems.map((v) => workPath(ctx, v))], 'Preparing songs', { music: true });
    rmSync(join(ctx.folder, 'collection'), { recursive: true, force: true }); // koleksiyon hazirligi (sert baglantilar) artik veri klasorunde
  }
  const o = JSON.parse(readFileSync(join(data, 'summary.json'), 'utf8'));
  ctx.log(`Data: ${o.songs} audio files (${o.spoken} with lyrics); description: "${String(o.exampleSpec).slice(0, 120)}"`);
  let info = existsSync(join(modelFolder, 'training.json')) && existsSync(join(loraFolder, `${loraName}.safetensors`)) ? JSON.parse(readFileSync(join(modelFolder, 'training.json'), 'utf8')) : null;
  if (!info) {
    await ctx.flushVoiceForGpu();
    const arg = ['train', '--data', data, '--output', modelFolder, '--name', loraName, '--lora-folder', loraFolder, '--rank', String(g.rank),
      ...(g.epoch ? ['--epoch', String(g.epoch)] : []), ...(previous ? ['--previous', join(aiRoot, 'training', 'models', previous.id, 'adaptor')] : []), ...trainingFlags({ music: true })];
    info = await script(ctx, arg, 'Music LoRA training', { music: true });
  }
  const record = {
    id, name: g.name, field: 'music', method: 'lora', base: 'acestep-15', improved: previous?.id ?? null,
    lora: `${loraName}.safetensors`, loraPath: join(loraFolder, `${loraName}.safetensors`), trigger: g.trigger, language: g.lang, jobId: ctx.job.id, dateText: new Date().toISOString(),
    data: { songs: o.songs, spoken: o.spoken }, training: { epoch: info.epoch, durationSec: info.durationSec, lastLoss: info.losses?.at(-1) ?? null, rank: info.rank, sizeMb: info.sizeMb },
  };
  saveModel(aiRoot, record);
  // Ornek sarkilar: ayni tarz ve tohum, LoRA'siz ve LoRA'li (30 sn); ComfyUI yoksa atlanir
  const examples = [];
  if (ctx.runComfy && ctx.mod?.musicJob) {
    try {
      const { addLora, merge, nodes } = await import('../graph.mjs');
      const { voiceOutputs } = await import('../comfy-client.mjs');
      const style = `${g.trigger}, ${o.exampleSpec || g.description || 'song'}`;
      const graphs = [false, true].map((withLora, i) => {
        const gr = ctx.mod.musicJob({ style, lyrics: '', duration: 30, seed: 2026, bpm: 110, language: g.lang === 'tr' ? 'tr' : 'en', prefix: `panel/${ctx.job.id}/example${i + 1}` });
        if (withLora) addLora(gr, record.lora, 1);
        return gr;
      });
      const { job, match } = merge(graphs);
      const records = graphs.map((gr, i) => match[i][nodes(gr, 'SaveAudioMP3')[0]]);
      ctx.progress({ percent: 97, stage: 'Sample songs', detail: style.slice(0, 120) });
      const outputs = await ctx.runComfy(job, { stage: 'Sample songs', range: [97, 99] });
      for (const [i, name] of ['example-without-lora.mp3', 'example-with-lora.mp3'].entries()) {
        const list = voiceOutputs(outputs, records[i]);
        if (!list.length) continue;
        await ctx.comfy.getOutput(list[0], join(ctx.folder, name));
        ctx.addOutput({ file: name, type: 'voice', duration: 30, name: i ? `With LoRA: ${style.slice(0, 60)}` : `Without LoRA (comparison)`, main: i === 1 });
        examples.push(name);
      }
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log(`Could not generate sample song: ${e.message}`);
    }
  }
  writeFileSync(join(ctx.folder, 'training.json'), JSON.stringify({ ...record, examples, losses: info.losses ?? [] }, null, 1));
  ctx.addOutput({ file: 'training.json', type: 'training', lora: record.lora, trigger: g.trigger, examples, losses: info.losses ?? [], ...record.training });
  ctx.log(`Music LoRA ready: ${record.lora} (trigger "${g.trigger}"). Select it in the Music tab.`);
  ctx.progress({ percent: 100, stage: 'Done', detail: record.lora });
}

/** ffprobe: { en, boy, sure } (telefon videosunun donme bilgisiyle; okunamazsa null). */
function videoSize(ffprobe, path) {
  return new Promise((ok) => {
    execFile(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration:stream_side_data=rotation:format=duration', '-of', 'json', path], { windowsHide: true, timeout: 30000 }, (h, output) => {
      if (h) return ok(null);
      try {
        const j = JSON.parse(String(output));
        const a = j.streams?.[0];
        if (!a?.width || !a?.height) return ok(null);
        const rotated = Math.abs(Number(a.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? 0)) % 180 === 90;
        ok({ width: rotated ? a.height : a.width, height: rotated ? a.width : a.height, duration: Number(a.duration) || Number(j.format?.duration) || 0 });
      } catch {
        ok(null);
      }
    });
  });
}

/** Klasordeki dosyalar (alt klasorler dahil; gizli ve __MACOSX atlanir). */
function filesCollect(root) {
  const result = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (d.name.startsWith('.') || d.name === '__MACOSX') continue;
    const path = join(root, d.name);
    if (d.isDirectory()) result.push(...filesCollect(path));
    else result.push(path);
  }
  return result;
}

/**
 * Video verisi (ffmpeg): klipler 24 fps, yonune gore sabit boyut (kirpilarak) ve sabit uzunlukta orneklere; uzun klipten
 * esit aralikli en cok 4 parca, kisa klip son kareyle tamamlanir; gorsel tek kare ornek olur. Altyazi: ayni adli .txt
 * (yoksa genel aciklama), basinda tetik kelime. Doner ve veri/ozet.json'a yazar: { ornekler, klip, gorsel, altyazili, ... }.
 */
async function prepareVideoData(ctx, g, data) {
  const { ffmpeg } = ctx.setting;
  const ffprobe = ffprobePath(ffmpeg);
  const raw = join(data, 'raw');
  const clips = join(data, 'clips');
  rmSync(data, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  mkdirSync(clips, { recursive: true });
  ctx.progress({ percent: 0, stage: 'Preparing clips' });
  for (const v of g.dataItems) {
    const m = mediaRef(v);
    if (m) {
      collectionFolder(ctx.setting, m, join(raw, `collection-${m.id}-${m.type}`));
      continue;
    }
    const path = dataPath(ctx.setting, v);
    if (extname(path).toLowerCase() === '.zip') {
      const target = join(raw, basename(path, extname(path)));
      mkdirSync(target, { recursive: true });
      await runProcess('tar', ['-xf', path, '-C', target], { signal: ctx.signal, name: 'zip' });
    } else copyFileSync(path, join(raw, basename(path).replace(/^\d{8}-\d{6}-(?:data|veri)-/, '')));
  }
  const files = filesCollect(raw);
  const root = (y) => basename(y, extname(y)).toLowerCase();
  const captions = new Map(files.filter((y) => extname(y).toLowerCase() === '.txt').map((y) => [root(y), readFileSync(y, 'utf8').replace(/\s+/g, ' ').trim()]));
  const media = files.filter((y) => [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS].includes(extname(y).toLowerCase())).sort();
  if (!media.length) throw new UserError('No video or image in the uploaded files (MP4, MOV, WebM, MKV, AVI, PNG, JPEG, WebP).');
  const sec = g.frame / VIDEO_FPS;
  const examples = [];
  let skipped = 0;
  const mostExample = videoMostExample();
  for (const [i, path] of media.entries()) {
    if (examples.length >= mostExample) {
      ctx.log(`At most ${mostExample} samples: the remaining ${media.length - i} files were not used.`);
      break;
    }
    ctx.progress({ percent: (5 * i) / media.length, stage: 'Preparing clips', detail: `${i + 1}/${media.length} · ${basename(path)}` });
    const video = VIDEO_EXTENSIONS.includes(extname(path).toLowerCase());
    const b = await videoSize(ffprobe, path);
    if (!b) {
      skipped += 1;
      ctx.log(`Could not read, skipped: ${basename(path)}`);
      continue;
    }
    const direction = Math.abs(b.width / b.height - 1) < 0.15 ? 'square' : b.width > b.height ? 'landscape' : 'portrait';
    // Is kuyruga girerken dogrulandi: ince ayar sonradan kapansa da 720p tablosu kullanilir
    const [width, height] = { ...VIDEO_720P, ...VIDEO_RESOLUTIONS }[g.resolution][direction];
    const filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    const partCount = video ? Math.max(1, Math.min(4, Math.floor(b.duration / (sec + 0.5)))) : 1;
    const caption = captions.get(root(path)) || g.description || '';
    const text_ = caption.toLowerCase().startsWith(g.trigger.toLowerCase()) ? caption : [g.trigger, caption].filter(Boolean).join(', ');
    for (let p = 0; p < partCount && examples.length < mostExample; p++) {
      const name = String(examples.length + 1).padStart(4, '0');
      const startedAt = video && b.duration > sec ? ((b.duration - sec) * (p + 0.5)) / partCount : 0;
      const arg = video
        ? ['-ss', startedAt.toFixed(3), '-i', path, '-vf', `fps=${VIDEO_FPS},${filter},tpad=stop_mode=clone:stop=-1`, '-frames:v', String(g.frame)]
        : ['-i', path, '-vf', filter, '-frames:v', '1'];
      try {
        await runFfmpeg(ffmpeg, [...arg, '-an', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', join(clips, `${name}.mp4`)], { signal: ctx.signal });
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        skipped += 1;
        ctx.log(`Could not encode, skipped: ${basename(path)} (${String(e.message).slice(0, 120)})`);
        break;
      }
      writeFileSync(join(clips, `${name}.txt`), text_);
      examples.push({ name, source: basename(path), video, direction, captioned: captions.has(root(path)) });
    }
  }
  if (!examples.length) throw new UserError('No clip could be prepared (the files could not be read or encoded).');
  // Ornek videolarin baslangic karesi: ilk ornegin ilk karesi
  await runFfmpeg(ffmpeg, ['-i', join(clips, `${examples[0].name}.mp4`), '-frames:v', '1', join(data, 'example-frame.png')], { signal: ctx.signal });
  const summary = {
    examples,
    clip: examples.filter((o) => o.video).length,
    image: examples.filter((o) => !o.video).length,
    captioned: examples.filter((o) => o.captioned).length,
    skipped,
    exampleCaption: readFileSync(join(clips, `${examples[0].name}.txt`), 'utf8'),
    direction: examples[0].direction,
  };
  writeFileSync(join(data, 'summary.json'), JSON.stringify(summary));
  rmSync(raw, { recursive: true, force: true });
  return summary;
}

const hourText = (t) => new Date(t).toTimeString().slice(0, 5);
const average = (l) => (l.length ? Math.round((l.reduce((t, x) => t + x, 0) / l.length) * 1e4) / 1e4 : null);

/**
 * Video LoRA (ComfyUI yerlesik egitim dugumleri, Wan 2.2 TI2V 5B): klipler (ffmpeg) -> ComfyUI input'a yukle -> veri seti
 * (Wan VAE + T5, diske; bir kez) -> /free -> egitim VIDEO_DILIM adimlik dilimlerle (her dilim: fp8 5B, bypass LoRA, blok
 * basina gradyan checkpoint; LoRA kaydedilir, sonraki dilim onun ustune egitir) -> kayit (Video > Wan 2.2 5B ile secilir)
 * -> ornek videolar (ilk ornegin karesinden, LoRA'siz ve LoRA'li). Duraklatilan/yarida kalan is son biten dilimden surer
 * (dilim icindeki adimlar ve iyilestirici durumu tekrarlanir).
 */
async function runVideo(ctx) {
  const g = ctx.job.input;
  const aiRoot = ctx.setting.aiRoot;
  const id = ctx.job.trainingId ?? `${slug(g.name, 'model').slice(0, 40)}-${ctx.job.id.slice(0, 15)}`;
  if (!ctx.job.trainingId) {
    ctx.job.trainingId = id;
    ctx.save();
  }
  const data = join(ctx.folder, 'data');
  const previous = g.base?.startsWith('trained:') ? trainedModels(aiRoot).find((m) => m.id === g.base.slice('trained:'.length)) : null;
  const loraName = `${slug(g.name, 'lora').slice(0, 50)}-${ctx.job.id.slice(0, 15)}`;
  const loraFolder = join(ctx.setting.modelRoot, 'loras');
  const finalLora = join(loraFolder, `${loraName}.safetensors`);
  const statusPath = join(ctx.folder, 'video-training.json');
  let d = { dataSet: false, done: 0, losses: [], durations: [], totalSec: 0, partLora: null };
  try {
    d = { ...d, ...JSON.parse(readFileSync(statusPath, 'utf8')) };
  } catch {
    /* ilk calisma */
  }
  const save = () => writeFileSync(statusPath, JSON.stringify(d));
  mkdirSync(loraFolder, { recursive: true });
  const o = existsSync(join(data, 'summary.json')) ? JSON.parse(readFileSync(join(data, 'summary.json'), 'utf8')) : await prepareVideoData(ctx, g, data);
  ctx.log(`Data: ${o.examples.length} samples (${o.clip} clip segments, ${o.image} images; ${o.captioned} captioned${o.skipped ? `, ${o.skipped} files skipped` : ''}); sample caption: "${o.exampleCaption.slice(0, 120)}"`);
  // Varsayilan adim: ornek basina ~100 (300-2000); 480p 33 karede ~3,4 sn/adim
  const total = g.step || Math.max(300, Math.min(2000, o.examples.length * 100));
  // Model dosyalari comfy.mjs'teki 5B grafindan (makineye ozel adlar orada)
  const template = ctx.mod.wanJob({ picture: 'x.png', text: '', seed: 0, width: 832, height: 480, frame: 33, prefix: 'x' });
  const input = (cls) => Object.values(template).find((n) => n.class_type === cls)?.inputs ?? {};
  const unet = input('UNETLoader').unet_name;
  const clip = input('CLIPLoader');
  const vae = input('VAELoader').vae_name;
  const comfyInput = `aipanel-training-${ctx.job.id}`;
  const dataSet = `aipanel/${ctx.job.id}`;

  // 1. Veri seti: ornekler ComfyUI'ye, VAE + T5 ile kodlanip diske (bir kez; egitim dilimleri oradan okur)
  if (!d.dataSet) {
    await ctx.flushVoiceForGpu();
    const files = readdirSync(join(data, 'clips'));
    for (const [i, name] of files.entries()) {
      ctx.progress({ percent: 5, stage: 'Encoding dataset', detail: `Uploading to ComfyUI ${i + 1}/${files.length}` });
      await ctx.comfy.load(join(data, 'clips', name), name, comfyInput);
    }
    await ctx.runComfy({
      1: { class_type: 'LoadVideoTextDataSetFromFolder', inputs: { folder: comfyInput } },
      2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
      3: { class_type: 'VAELoader', inputs: { vae_name: vae } },
      4: { class_type: 'CLIPLoader', inputs: { clip_name: clip.clip_name, type: clip.type ?? 'wan', device: 'default' } },
      5: { class_type: 'MakeTrainingDataset', inputs: { images: ['2', 0], vae: ['3', 0], clip: ['4', 0], texts: ['1', 1] } },
      6: { class_type: 'SaveTrainingDataset', inputs: { latents: ['5', 0], conditioning: ['5', 1], folder_name: dataSet, shard_size: 1000 } },
    }, { stage: 'Encoding dataset', range: [5, 12] });
    d.dataSet = true;
    save();
  }

  // 2. Egitim dilimleri. TrainLoraNode onceki LoRA'yi "existing_lora" olarak adindan okur: ad "<..>_<adim>_steps_" olmali.
  if (d.done < total) {
    // Metin kodlayici ve VAE RAM/VRAM'den cikar: egitimde yalniz 5B (16 GB RAM'de ikisi birlikte sigmaz)
    await ctx.flushVoiceForGpu();
  }
  while (d.done < total) {
    if (d.done > 0 && !(d.partLora && existsSync(join(loraFolder, d.partLora)))) {
      ctx.log('Intermediate LoRA file not found; training starts from the beginning.');
      Object.assign(d, { done: 0, losses: [], durations: [], totalSec: 0, partLora: null });
    }
    if (d.done === 0 && !d.partLora && previous?.loraPath && existsSync(previous.loraPath)) {
      d.partLora = `${loraName}-part_0_steps_.safetensors`;
      copyFileSync(previous.loraPath, join(loraFolder, d.partLora));
      save();
    }
    const n = Math.min(VIDEO_SLICE, total - d.done);
    const speed = average(d.durations.slice(-4));
    const stage = `Video LoRA training · step ${d.done}/${total}${speed ? ` · ends ≈ ${hourText(Date.now() + speed * (total - d.done) * 1000)}` : ''}`;
    const prefix = `panel/${ctx.job.id}/slice${d.done + n}-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const outputs = await ctx.runComfy({
      // Ince ayar egitimFp8 kapali: modelin kendi hassasiyeti (fp16)
      1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: fineSetting('trainingFp8') ? 'fp8_e4m3fn' : 'default' } },
      2: { class_type: 'LoadTrainingDataset', inputs: { folder_name: dataSet } },
      3: {
        class_type: 'TrainLoraNode',
        inputs: {
          model: ['1', 0], latents: ['2', 0], positive: ['2', 1], batch_size: 1, grad_accumulation_steps: 1, steps: n,
          learning_rate: g.ratio || 1e-4, rank: Number(g.rank), optimizer: 'AdamW', loss_function: 'MSE', seed: d.done,
          training_dtype: 'bf16', lora_dtype: 'bf16', quantized_backward: false, algorithm: 'LoRA',
          // Derinlik 2: her blok ayri checkpoint (1 tum modeli tek parca sarar, 12 GB'i asar); bypass: fp8 agirliga dokunmaz.
          // Ince ayarlar: egitimGradyan (denetim noktalari), egitimVideoDerinlik (2 / 1)
          gradient_checkpointing: fineSetting('trainingGradient'), checkpoint_depth: fineSetting('trainingVideoDepth') ? 2 : 1, offloading: false, existing_lora: d.partLora ?? '[None]', bucket_mode: false, bypass_mode: true,
        },
      },
      4: { class_type: 'SaveLoRA', inputs: { lora: ['3', 0], prefix: prefix } },
      5: { class_type: 'PreviewAny', inputs: { source: ['3', 1] } },
    }, { stage, range: [12 + (80 * d.done) / total, 12 + (80 * (d.done + n)) / total] });
    const part = prefix.split('/');
    const fresh = `${loraName}-part_${d.done + n}_steps_.safetensors`;
    await ctx.comfy.getOutput({ filename: `${part.pop()}_00001_.safetensors`, subfolder: part.join('/'), type: 'output' }, join(loraFolder, fresh));
    if (d.partLora && d.partLora !== fresh) rmSync(join(loraFolder, d.partLora), { force: true });
    let loss = [];
    try {
      loss = JSON.parse(outputs['5']?.text?.[0] ?? '{}').loss ?? [];
    } catch {
      /* kayip okunamadi: egitim yine de suruyor */
    }
    const duration = (Date.now() - startedAt) / 1000;
    Object.assign(d, { partLora: fresh, done: d.done + n, losses: [...d.losses, ...loss.map((x) => Math.round(x * 1e4) / 1e4)], durations: [...d.durations, duration / n], totalSec: d.totalSec + duration });
    save();
    ctx.log(`Step ${d.done}/${total}: slice ${Math.round(duration)} s (${(duration / n).toFixed(1)} s/step), average loss ${average(loss) ?? '-'}`);
  }
  if (!existsSync(finalLora)) {
    if (!d.partLora || !existsSync(join(loraFolder, d.partLora))) throw new Error('Training finished but the LoRA file was not found.');
    renameSync(join(loraFolder, d.partLora), finalLora);
  }
  // ComfyUI tarafindaki ara dosyalar (yuklenen ornekler, kodlanmis veri seti)
  const comfyRoot = ctx.comfy.comfyFolder;
  if (comfyRoot) for (const y of [join(comfyRoot, 'input', comfyInput), join(comfyRoot, 'datasets', 'aipanel', ctx.job.id), join(comfyRoot, 'output', 'panel', ctx.job.id)]) rmSync(y, { recursive: true, force: true });

  const record = {
    id, name: g.name, field: 'video', method: 'lora', base: 'wan22-5b', improved: previous?.id ?? null,
    lora: `${loraName}.safetensors`, loraPath: finalLora, trigger: g.trigger, jobId: ctx.job.id, dateText: new Date().toISOString(),
    data: { clip: o.clip, image: o.image, captioned: o.captioned },
    training: { step: total, durationSec: Math.round(d.totalSec), lastLoss: average(d.losses.slice(-20)), resolution: g.resolution, frame: g.frame, rank: Number(g.rank), sizeMb: Math.round((statSync(finalLora).size / 2 ** 20) * 10) / 10 },
  };
  saveModel(aiRoot, record);

  // 3. Ornek videolar: ilk ornegin karesinden, ayni istem ve tohum, LoRA'siz ve LoRA'li (480p, 49 kare)
  const examples = [];
  if (ctx.runComfy && ctx.mod?.wanJob && existsSync(join(data, 'example-frame.png'))) {
    try {
      const { addLora, merge, nodes } = await import('../graph.mjs');
      const { images } = await import('../comfy-client.mjs');
      const picture = await ctx.comfy.load(join(data, 'example-frame.png'), `panel_${ctx.job.id}_example.png`);
      const prompt = o.exampleCaption || `${g.trigger}, cinematic motion`;
      const [width, height] = VIDEO_RESOLUTIONS['480p'][o.direction];
      const graphs = [false, true].map((withLora, i) => {
        const gr = ctx.mod.wanJob({ picture, text: prompt, seed: 2026, width, height, frame: 49, prefix: `panel/${ctx.job.id}/example${i + 1}` });
        if (withLora) addLora(gr, record.lora, 1);
        return gr;
      });
      const { job, match } = merge(graphs);
      const records = graphs.map((gr, i) => match[i][nodes(gr, 'SaveImage')[0]]);
      ctx.progress({ percent: 93, stage: 'Sample videos', detail: prompt.slice(0, 120) });
      const outputs = await ctx.runComfy(job, { stage: 'Sample videos', range: [93, 99] });
      for (const [i, name] of ['example-without-lora.mp4', 'example-with-lora.mp4'].entries()) {
        const list = images(outputs, records[i]);
        if (!list.length) continue;
        const frames = `example${i + 1}-frames`;
        for (const [j, frame] of list.entries()) await ctx.comfy.getOutput(frame, join(ctx.folder, frames, `${String(j + 1).padStart(5, '0')}.png`));
        await framesToMp4(ctx.setting.ffmpeg, { cwd: ctx.folder, pattern: `${frames}/%05d.png`, fps: VIDEO_FPS, output: name, ready: ctx.setting.x264Ready, signal: ctx.signal, frameCount: list.length });
        rmSync(join(ctx.folder, frames), { recursive: true, force: true });
        const preview = name.replace(/\.mp4$/, '.preview.jpg');
        await makePreview(ctx.setting.ffmpeg, name, preview, { cwd: ctx.folder, signal: ctx.signal }).catch(() => {});
        ctx.addOutput({ file: name, type: 'video', ...(existsSync(join(ctx.folder, preview)) ? { preview } : {}), width, height, duration: Math.round((list.length / VIDEO_FPS) * 100) / 100, fps: VIDEO_FPS, name: i ? `With LoRA: ${prompt.slice(0, 60)}` : `Without LoRA (comparison)`, main: i === 1 });
        examples.push(name);
      }
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log(`Could not generate sample video: ${e.message}`);
    }
  }
  writeFileSync(join(ctx.folder, 'training.json'), JSON.stringify({ ...record, examples, losses: d.losses }, null, 1));
  ctx.addOutput({ file: 'training.json', type: 'training', lora: record.lora, trigger: g.trigger, examples, losses: d.losses.slice(-400), ...record.training });
  ctx.log(`Video LoRA ready: ${record.lora} (trigger "${g.trigger}"). Select it in the Video tab with Advanced > Model: Wan 2.2 5B.`);
  ctx.progress({ percent: 100, stage: 'Done', detail: record.lora });
}

/**
 * Genel (cok kipli) model (egitim\genel.py): hazirla (gorseller + ayni adli .txt yanitlar, gorselli sohbet, metin) ->
 * ince (Qwen3.5 QLoRA, gorsel kodlayici donuk; kayit noktasindan surer) -> ornek yanitlar (metin + gorselli) ->
 * gorsel kodlayici GGUF (llm\modeller\mmproj-<gguf>) + metin GGUF (egit.py gguf) -> kayit. Yazi modeli olarak secilince
 * llama-server --mmproj ile gorsel de okur (/llm/v1 chat/completions, image_url). Birlesik bf16 kopya sonda silinir.
 */
async function runGeneral(ctx) {
  const g = ctx.job.input;
  await ctx.flushVoiceForGpu();
  const aiRoot = ctx.setting.aiRoot;
  const data = join(ctx.folder, 'data');
  const id = ctx.job.trainingId ?? `${slug(g.name, 'model').slice(0, 40)}-${ctx.job.id.slice(0, 15)}`;
  if (!ctx.job.trainingId) {
    ctx.job.trainingId = id;
    ctx.save();
  }
  const modelFolder = join(aiRoot, 'training', 'models', id);
  const hf = join(modelFolder, 'hf');
  const ggufName = `${slug(g.name, 'model').slice(0, 50)}-trained-${ctx.job.id.slice(0, 15)}-${g.quantization.toLowerCase()}.gguf`;
  const gguf = join(aiRoot, 'llm', 'models', ggufName);
  const mmproj = join(aiRoot, 'llm', 'models', `mmproj-${ggufName}`);
  const previous = g.base?.startsWith('trained:') ? trainedModels(aiRoot).find((m) => m.id === g.base.slice('trained:'.length)) : null;
  const base = previous ? previous.base : g.base;

  if (!existsSync(join(data, 'summary.json'))) {
    ctx.progress({ percent: 0, stage: 'Preparing data' });
    await script(ctx, ['prepare', '--output', data, ...(g.imagePrompt ? ['--prompt', g.imagePrompt] : []), ...g.dataItems.map((v) => workPath(ctx, v))], 'Preparing data', { general: true });
    rmSync(join(ctx.folder, 'collection'), { recursive: true, force: true }); // koleksiyon hazirligi (sert baglantilar) artik veri klasorunde
  }
  const o = JSON.parse(readFileSync(join(data, 'summary.json'), 'utf8'));
  ctx.log(`Data: ${o.example} samples (${o.withImage} with images, ${o.chat} chat, ${o.text} plain text)${o.skipped ? `; ${o.skipped} images skipped (no answer or could not be opened)` : ''}.`);
  const prompts = [g.examplePrompt || null, ...(o.examplePrompts ?? [])].filter(Boolean).slice(0, 2);
  if (!prompts.length) prompts.push('Introduce yourself briefly.');
  const exampleFile = join(ctx.folder, 'examples.json');
  if (!existsSync(gguf) || !existsSync(mmproj)) {
    // Egitim (betik biten alt asamalari atlar: LoRA varsa egitim, birlesik model varsa birlestirme)
    const extra = previous ? ['--previous-adaptor', join(aiRoot, 'training', 'models', previous.id, 'adaptor')] : [];
    await script(ctx, ['fine', '--data', data, '--output', modelFolder, '--base', base, '--epoch', String(g.epoch), '--context', String(g.context), ...(g.ratio ? ['--ratio', String(g.ratio)] : []), ...extra, ...trainingFlags({ fourBit: true })], 'Fine-tuning (image + text)', { general: true });
    if (!existsSync(exampleFile)) {
      ctx.progress({ percent: 89, stage: 'Sample answers', detail: prompts[0] });
      let examples = [];
      try {
        const image = o.exampleImage ? ['--image', join(data, o.exampleImage), '--image-prompt', o.exampleImagePrompt || 'Describe this image in detail.'] : [];
        examples = (await script(ctx, ['example', '--hf', hf, ...prompts.flatMap((i) => ['--prompt', i]), ...image], 'Sample answers', { general: true })).examples ?? [];
      } catch (e) {
        if (ctx.signal?.aborted || e instanceof CancelError) throw e; // duraklat/iptal: asama bitmis sayilmasin
        ctx.log(`Could not generate sample: ${e.message}`);
      }
      writeFileSync(exampleFile, JSON.stringify(examples));
    }
    // Gorsel kodlayici once: metin GGUF adimi diskte yer yoksa birlesik kopyayi siler
    await script(ctx, ['mmproj', '--hf', hf, '--output', mmproj], 'Image encoder (mmproj)', { general: true });
    const r = await script(ctx, ['gguf', '--hf', hf, '--output', gguf, '--quantization', g.quantization, '--quantize', join(aiRoot, 'llm', 'bin', 'llama-quantize.exe')], 'GGUF');
    ctx.log(`Text model ready: ${ggufName}${r.gib ? ` (${r.gib} GiB)` : ''} + image encoder mmproj-${ggufName}`);
  }
  if (existsSync(hf)) {
    rmSync(hf, { recursive: true, force: true });
    ctx.log('The merged intermediate copy was deleted (the LoRA adapter is kept).');
  }
  ctx.refreshTextModels?.();
  const info = existsSync(join(modelFolder, 'training.json')) ? JSON.parse(readFileSync(join(modelFolder, 'training.json'), 'utf8')) : {};
  const examples = existsSync(exampleFile) ? JSON.parse(readFileSync(exampleFile, 'utf8')) : [];
  const record = {
    id, name: g.name, field: 'general', method: 'fine', base, improved: previous?.id ?? null,
    gguf: ggufName, mmproj: `mmproj-${ggufName}`, jobId: ctx.job.id, dateText: new Date().toISOString(),
    data: { example: o.example, withImage: o.withImage },
    training: { step: info.step, durationSec: info.durationSec, lastLoss: info.losses?.at(-1) ?? null, peakVramGb: info.peakVramGb ?? null },
  };
  saveModel(aiRoot, record);
  writeFileSync(join(ctx.folder, 'training.json'), JSON.stringify({ ...record, examples, losses: info.losses ?? [] }, null, 1));
  ctx.addOutput({ file: 'training.json', type: 'training', gguf: ggufName, mmproj: record.mmproj, examples, losses: info.losses ?? [], ...record.training });
  ctx.log(`General model ready: ${ggufName}. Select it in Settings > Text model; image requests via /llm/v1/chat/completions (image_url).`);
  ctx.progress({ percent: 100, stage: 'Done', detail: ggufName });
}

export async function run(ctx) {
  const g = ctx.job.input;
  if (g.field === 'general') return runGeneral(ctx);
  if (g.field === 'video') return runVideo(ctx);
  if (g.field === 'music') return runMusic(ctx);
  if (g.field === 'image') return runImage(ctx);
  await ctx.flushVoiceForGpu();
  const aiRoot = ctx.setting.aiRoot;
  const data = join(ctx.folder, 'data');
  const id = ctx.job.trainingId ?? `${slug(g.name, 'model').slice(0, 40)}-${ctx.job.id.slice(0, 15)}`;
  if (!ctx.job.trainingId) {
    ctx.job.trainingId = id;
    ctx.save();
  }
  const modelFolder = join(aiRoot, 'training', 'models', id);
  const hf = join(modelFolder, 'hf');
  // Tarih + saat: ayni gun ayni adla iki egitim birbirinin dosyasini ezmesin.
  const ggufName = `${slug(g.name, 'model').slice(0, 50)}-trained-${ctx.job.id.slice(0, 15)}-${g.quantization.toLowerCase()}.gguf`;
  const gguf = join(aiRoot, 'llm', 'models', ggufName);
  const previous = g.base?.startsWith('trained:') ? trainedModels(aiRoot).find((m) => m.id === g.base.slice('trained:'.length)) : null;
  // Ince ayarda asil temel (gelistirmede oncekinin temeli): kayitta ve yeniden egitimde bu kullanilir.
  const base = previous?.method === 'fine' ? previous.base : g.base ?? null;

  // 1. Veri
  if (!existsSync(join(data, 'summary.json'))) {
    ctx.progress({ percent: 0, stage: 'Preparing data' });
    await script(ctx, ['prepare', '--output', data, ...g.dataItems.map((v) => dataPath(ctx.setting, v))], 'Preparing data');
  }
  const o = JSON.parse(readFileSync(join(data, 'summary.json'), 'utf8'));
  ctx.log(`Data: ${o.example} samples (${o.chat} chat, ${o.text} plain text), ~${o.tokenEstimate.toLocaleString('en-US')} tokens.`);
  // Istem kisaltmalari: veriyle gelen ya da gelistirilen modelden miras; panel kullanimda uygular.
  const abbreviationSource = [join(data, 'abbreviations.json'), previous ? join(aiRoot, 'training', 'models', previous.id, 'abbreviations.json') : null].find((d) => d && existsSync(d));
  if (abbreviationSource && !existsSync(join(modelFolder, 'abbreviations.json'))) {
    mkdirSync(modelFolder, { recursive: true });
    copyFileSync(abbreviationSource, join(modelFolder, 'abbreviations.json'));
    ctx.log(`Prompt shorthands: ${Object.keys(JSON.parse(readFileSync(abbreviationSource, 'utf8'))).length} (applied by the panel at use time).`);
  }

  const prompts = [g.examplePrompt || null, ...(o.examplePrompts ?? [])].filter(Boolean).slice(0, 3);
  if (!prompts.length) prompts.push('Introduce yourself briefly.');
  const exampleFile = join(ctx.folder, 'examples.json');
  if (!existsSync(gguf)) {
    // 2. Egitim (betik biten alt asamalari kendisi atlar: LoRA varsa egitim, birlesik model varsa birlestirme)
    const common = ['--data', data, '--output', modelFolder, '--epoch', String(g.epoch), '--context', String(g.context), ...(g.ratio ? ['--ratio', String(g.ratio)] : [])];
    if (g.method === 'scratch') {
      await script(ctx, ['scratch', ...common, '--size', g.size], 'Training from scratch');
    } else if (previous?.method === 'scratch') {
      // Sifirdan egitilmis kucuk model: LoRA yerine tum agirliklariyla egitime devam (kendi sozlugu korunur).
      await script(ctx, ['scratch', ...common, '--resume', join(aiRoot, 'training', 'models', previous.id, 'hf')], 'Continuing training');
    } else {
      // Ince ayarli modeli gelistirme: ayni temel + onceki LoRA egitime devam eder (birlesik kopya saklanmaz).
      const extra = previous ? ['--previous-adaptor', join(aiRoot, 'training', 'models', previous.id, 'adaptor')] : [];
      await script(ctx, ['fine', ...common, '--base', base, ...extra, ...trainingFlags({ fourBit: true })], 'Fine-tuning');
    }

    // 3. Ornek yanitlar (egitilmis HF modeliyle; GGUF'tan once: ince ayarin birlesik kopyasi sonra silinir)
    if (!existsSync(exampleFile)) {
      ctx.progress({ percent: 89, stage: 'Sample answers', detail: prompts[0] });
      let examples = [];
      try {
        examples = (await script(ctx, ['example', '--hf', hf, ...prompts.flatMap((i) => ['--prompt', i])], 'Sample answers')).examples ?? [];
      } catch (e) {
        if (ctx.signal?.aborted || e instanceof CancelError) throw e; // duraklat/iptal: asama bitmis sayilmasin
        ctx.log(`Could not generate sample: ${e.message}`);
      }
      writeFileSync(exampleFile, JSON.stringify(examples));
    }

    // 4. GGUF -> llm\modeller (Ayarlar > Yazi modeli listesinde gorunur)
    const quantize = join(aiRoot, 'llm', 'bin', 'llama-quantize.exe');
    const r = await script(ctx, ['gguf', '--hf', hf, '--output', gguf, '--quantization', g.quantization, '--quantize', quantize], 'GGUF');
    ctx.log(`Text model ready: ${ggufName}${r.gib ? ` (${r.gib} GiB)` : ''}`);
  }
  // Ince ayarda birlesik bf16 kopya (14B'de ~30 GB) tutulmaz: LoRA + temel yeter, GGUF hazir.
  if (g.method === 'fine' && previous?.method !== 'scratch' && existsSync(hf)) {
    rmSync(hf, { recursive: true, force: true });
    ctx.log('The merged intermediate copy was deleted (the LoRA adapter is kept).');
  }
  ctx.refreshTextModels?.();

  const info = existsSync(join(modelFolder, 'training.json')) ? JSON.parse(readFileSync(join(modelFolder, 'training.json'), 'utf8')) : {};
  const examples = existsSync(exampleFile) ? JSON.parse(readFileSync(exampleFile, 'utf8')) : [];
  const record = {
    id,
    name: g.name,
    // Sifirdan egitilmis modelin gelistirilmesi de scratch turunde kalir (kendi sozlugu, LoRA yok).
    field: g.field ?? 'text',
    method: previous?.method === 'scratch' ? 'scratch' : g.method,
    base: g.method === 'scratch' || previous?.method === 'scratch' ? null : base,
    improved: previous?.id ?? null,
    size: g.size ?? previous?.size ?? null,
    gguf: ggufName,
    jobId: ctx.job.id,
    dateText: new Date().toISOString(),
    data: { example: o.example, token: o.tokenEstimate },
    training: { step: info.step, durationSec: info.durationSec, lastLoss: info.losses?.at(-1) ?? null, validationLoss: info.validationLoss ?? null, param: info.param ?? null, peakVramGb: info.peakVramGb ?? null },
  };
  saveModel(aiRoot, record);
  writeFileSync(join(ctx.folder, 'training.json'), JSON.stringify({ ...record, examples, losses: info.losses ?? [] }, null, 1));
  ctx.addOutput({ file: 'training.json', type: 'training', gguf: ggufName, examples, losses: info.losses ?? [], ...record.training });
  ctx.progress({ percent: 100, stage: 'Done', detail: ggufName });
}

const profileCache = new Map();
/**
 * Etkin yazi modeli panelde egitilmisse kullanim profili: { kisaltmalar: {"[[isaret]]": "tam metin"} }.
 * Egitimde istemdeki uzun, sabit metinler (bot kilavuzlari) isaretle degistirildi; kullanimda da ayni degisim
 * yapilir. Egitilmis model degilse null. Kayit dosyasinin degisim zamanina gore onbellekli.
 */
export function trainedModelProfile(aiRoot, ggufFile) {
  if (!ggufFile || !/-trained-/i.test(ggufFile)) return null;
  let stamp = 0;
  try {
    stamp = statSync(recordPath(aiRoot)).mtimeMs;
  } catch {
    return null;
  }
  const key = `${ggufFile}|${stamp}`;
  if (profileCache.has(key)) return profileCache.get(key);
  const m = trainedModels(aiRoot).find((x) => x.gguf === ggufFile);
  let profile = null;
  if (m) {
    let abbreviations = {};
    try {
      abbreviations = JSON.parse(readFileSync(join(aiRoot, 'training', 'models', m.id, 'abbreviations.json'), 'utf8'));
    } catch {}
    profile = { id: m.id, abbreviations };
  }
  profileCache.set(key, profile);
  return profile;
}

/** Istemdeki tam metinleri egitimdeki kisa isaretlerle degistirir (eslesmeyen metin oldugu gibi kalir). */
export function applyAbbreviations(text, abbreviations) {
  let s = String(text ?? '');
  for (const [marker, full] of Object.entries(abbreviations ?? {})) if (full && s.includes(full)) s = s.split(full).join(marker);
  return s;
}
