/**
 * Panel hizmetleri: arayuzun (/api/*) ve API'nin (/api/v1/*) ORTAK kullandigi islemler.
 * HTTP ayrintisi (yetki, yanit bicimi) http.mjs'te; is kurallari burada ve kuyruk.mjs'te.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { UserError } from './errors.mjs';
import { gpuStatus, ramStatus } from './gpu.mjs';
import { systemDetail } from './system-detail.mjs';
import { modelFiles } from './graph.mjs';
import { exifOrientation, imageSize } from './media.mjs';
import { DEFAULTS, UPLOAD_FOLDER, allowedHosts } from './settings.mjs';
import { toReference, fixOrientation } from './ffmpeg.mjs';
import { addVoice, listVoices, voicePath } from './voices.mjs';
import { moveToRecycleBin } from './deletion.mjs';
import { closeComfy } from './comfy-process.mjs';
import { freePath, writeBody, stamp } from './request.mjs';
import { diskStatus, catalogStatus, isDefaultModel, installedModels, deleteModel, checkModelExtension, modelPath } from './models.mjs';
import { FAMILIES, checkQuantization, quantizationOptions } from './quantization.mjs';
import { IMAGE_MODELS, QUALITY, MUSIC_EXTENSIONS, RATIOS, VIDEO_MODELS, text, number, choice, slug, generatorStatus } from './jobs/common.mjs';
import { writeScenes } from './scene-writer.mjs';
import { Tasks } from './tasks.mjs';
import { hasText } from './text-model.mjs';
import { findLlm } from './llm.mjs';
import { writeLyrics } from './lyricist.mjs';
import { RECORD_EXTENSIONS } from './jobs/clone.mjs';
import { collections as dataCollections } from './jobs/data.mjs';
import { FIELDS as TRAINING_FIELDS, SIZES as TRAINING_SIZES, IMAGE_RESOLUTIONS, MUSIC_LANGUAGES, QUANTIZATIONS as TRAINING_QUANTIZATIONS, DATA_EXTENSIONS, trainedModels, baseModelStatuses, videoResolutions, videoTrainingMissing, videoFrames } from './jobs/training.mjs';
import { browse, folderEstimate } from './file-browser.mjs';
import { IDLE_CLOSE_MIN, TEXT_MODEL_IDLE_MIN, VOICE_ENGINES } from './settings-file.mjs';
import { AgentManager, RULE_FILES } from './agent/agent.mjs';
import { readableKind } from './attachments.mjs';
import { SEARCH_SERVICES, checkServiceValue, maskAddress, maskKey, maskedServices, serviceList } from './agent/web-search.mjs';
import { REMOTE_MODEL, checkRemote, checkRemoteAddress, checkRemoteKey, checkRemoteModelName } from './remote-llm.mjs';
import { FINE_SETTINGS, fineSettingValues, validateFineSettings, fineSettingsStatus, againMustStart } from './fine-settings.mjs';
import { mcpServerList } from './agent/mcp.mjs';
import { findSkills } from './agent/skills.mjs';
import { ENGINE_NAMES, SERVICE_ENGINES } from './data-sources.mjs';
import { SEARCH_ENGINES } from './data-collection.mjs';

const UPLOAD_LIMIT = 60 * 2 ** 20;
// Kendi sesi icin kayit (video olabilir): telefon videosu yuzlerce MB.
const RECORD_LIMIT = 4 * 2 ** 30;
// A chat attachment (a long PDF with pictures, a workbook): as large as a document is read (lib/attachments.mjs)
const FILE_LIMIT = 100 * 2 ** 20;

export function notFound(message) {
  return new UserError(message, 'notFound');
}

/**
 * The finished jobs the page shows as recent: the last 40, and the last 4 of every type besides (a section's Recent
 * panel was empty when its jobs were older than the last 40: "Recent 3D models: nothing yet" with a model in the gallery).
 */
export function lastJobs(jobs, newest = 40, perType = 4) {
  const count = {};
  return jobs.filter((job) => !['waiting', 'running'].includes(job.status)).filter((job, i) => {
    const keep = i < newest || (count[job.type] ?? 0) < perType;
    if (keep) count[job.type] = (count[job.type] ?? 0) + 1;
    return keep;
  });
}

/** Settings › Remote model as the page sees it: the key masked (last 4 characters), a password in the address hidden. */
function maskedRemote(r) {
  return { url: maskAddress(r?.url), key: maskKey(r?.key), model: r?.model ?? '', whenBusy: Boolean(r?.whenBusy), ready: Boolean(r?.url && r?.model) };
}

export function createService({ setting, queue, comfy, mod, settingFile, downloader, llm = null, updater = null, restart = null }) {
  const uploads = join(setting.outputRoot, UPLOAD_FOLDER);
  const tasks = new Tasks();

  // ComfyUI durumu 2 sn onbellekte (her sekme saniyede bir soruyor).
  let comfyStatus = { time: 0, value: null };
  async function getComfyStatus() {
    if (Date.now() - comfyStatus.time < 2000 && comfyStatus.value) return comfyStatus.value;
    const running = await comfy.isReady();
    let queueLength = null;
    if (running) {
      try {
        const q = await comfy.queue();
        queueLength = q.running.length + q.pending.length;
      } catch {
        /* */
      }
    }
    const value = { running, starting: !running && queue.comfyStarting(), queue: queueLength, address: setting.comfyAddress };
    comfyStatus = { time: Date.now(), value };
    return value;
  }

  function findJob(id) {
    const job = queue.jobs.get(String(id));
    if (!job) throw notFound('Job not found.');
    return job;
  }

  /** Yukleme klasorunu tarar (veritabani yoksa ya da ilk dolum). */
  function scanUpload() {
    if (!existsSync(uploads)) return [];
    const list = [];
    for (const d of readdirSync(uploads).sort().reverse()) {
      const extension = extname(d).toLowerCase();
      const image = /\.(png|jpe?g|webp)$/i.test(d);
      const music = MUSIC_EXTENSIONS.includes(extension) && /-muzik-/.test(d);
      if (!image && !music) continue;
      let size = null;
      try {
        size = statSync(join(uploads, d)).size;
      } catch {
        continue;
      }
      const measure = image ? imageSize(join(uploads, d)) ?? {} : {};
      // Dosya adinin damgasi (YYYYAAGG-SSDDss) olusturma zamani olur.
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(d);
      const creation = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : new Date(0).toISOString();
      list.push({ source: `upload/${d}`, url: `/file/upload/${d}`, type: image ? 'image' : 'music', name: d.replace(/^\d{8}-\d{6}-(muzik-)?/, ''), size, creation, ...measure });
    }
    return list;
  }

  const h = {
    id() {
      return { application: 'ai-panel', machine: setting.machine, api: 'v1' };
    },

    async status() {
      const active = queue.active?.job;
      return {
        machine: setting.machine,
        version: queue.version,
        comfy: await getComfyStatus(),
        gpu: await (setting.gpuStatus ?? gpuStatus)(),
        ram: ramStatus(),
        active: active ? { ...queue.summary(active), log: queue.lastLog(active.id, 4) } : null,
        pending: queue.pending().map((job) => queue.summary(job)),
        // short work outside the queue (the scene writer): in the Queue panel with its progress
        tasks: tasks.list(),
        last: lastJobs(queue.list()).map((job) => queue.summary(job)),
        averages: queue.averages(),
        download: downloader ? downloader.summaries().find((i) => i.status === 'downloading') ?? null : null,
        // the top bar badge: is there a new version (null in a development copy)
        update: updater?.summary() ?? null,
      };
    },

    async system() {
      return {
        machine: setting.machine,
        node: process.version,
        panelDurationSec: Math.round(process.uptime()),
        addresses: allowedHosts(setting.address).map((a) => `http://${a}:${setting.port}/`),
        gpu: await (setting.gpuStatus ?? gpuStatus)(),
        ram: ramStatus(),
        // Islemci saati/onbellek/surec ve RAM modulu/taahhut (Windows; yoksa null).
        detail: setting.systemDetail ? await setting.systemDetail() : await systemDetail(),
        disk: { outputs: diskStatus(setting.outputRoot), models: diskStatus(existsSync(setting.modelRoot) ? setting.modelRoot : setting.aiRoot) },
        paths: { aiRoot: setting.aiRoot, outputRoot: setting.outputRoot, modelRoot: setting.modelRoot, voiceLibrary: setting.voiceLibrary, comfyModule: setting.comfyModule, dataRoot: setting.dataRoot },
        tools: { ffmpeg: setting.ffmpeg, ffprobe: setting.ffprobe, blender: typeof setting.blender === 'string' ? setting.blender : null, hasVoice: setting.hasVoice, hasDesign: setting.hasDesign, hasSceneWriter: Boolean(setting.sceneWriter || hasText()) },
        comfy: await getComfyStatus(),
      };
    },

    options() {
      // Model dosya adlari comfy.mjs'in kurdugu ornek graftan okunur (niceleme secimi uygulanmis).
      const model = (m) => {
        const d = generatorStatus(mod, m.generator);
        let files = [];
        if (d.available) files = modelFiles(mod[m.generator]({ text: 'x', seed: 0, prefix: 'x', picture: 'x.png', width: 1280, height: 720, frame: 81, smooth: 1 }));
        return { available: d.available, reason: d.reason, files };
      };
      return {
        machine: setting.machine,
        imageModels: Object.entries(IMAGE_MODELS).map(([id, m]) => ({ id, name: m.name, step: m.step, ...model(m) })),
        videoModels: Object.entries(VIDEO_MODELS).map(([id, m]) => ({ id, name: m.name, fps: m.fps, frame: m.frame, size: m.size, ...model(m) })),
        ratios: RATIOS,
        // Formlar ince ayara gore secenek gosterir (or. 1080p video)
        fineSettings: fineSettingValues(),
        quality: Object.fromEntries(Object.entries(QUALITY).map(([k, v]) => [k, v.name])),
        voices: listVoices(setting.voiceLibrary),
        hasVoice: setting.hasVoice,
        hasDesign: setting.hasDesign,
        hasFfmpeg: Boolean(setting.ffmpeg),
        // 3D model: TRELLIS.2 kurulu mu, Blender var mi (tanitim videosu, FBX/OBJ/STL).
        hasModel3d: generatorStatus(mod, 'trellis2Job').available,
        hasBlender: Boolean(setting.blender),
        // Sing in a voice: the YingMusic-SVC models are downloaded (Settings > Models)
        hasSing: setting.hasSing,
        hasSceneWriter: Boolean(setting.sceneWriter || hasText()),
        // Arayüz motora göre alan gösterir (Duygu şiddeti yalnız Chatterbox'ta etkili).
        voiceEngine: settingFile?.voiceEngine ?? 'voxcpm',
      };
    },

    /* ── Isler ── */
    jobs({ type, status, limit } = {}) {
      return queue.list({ type: type || undefined, status: status || undefined, limit: limit ? number(limit, 'Limit', { min: 1, max: 5000, full: true }) : 500 }).map((job) => queue.summary(job));
    },
    /** Sayfali liste (galeri): durum 'unfinished' = hata + iptal + yarida + duraklatildi. */
    jobsPage({ type, status, page, size } = {}) {
      const b = number(size, 'Page size', { min: 1, max: 200, defaultValue: 24, full: true });
      const group = status === 'unfinished' ? ['error', 'cancelled', 'interrupted', 'paused'] : status ? [status] : null;
      const requested = number(page, 'Page', { min: 1, defaultValue: 1, full: true });
      let v = queue.page({ type: type || undefined, statuses: group, limit: b, skip: (requested - 1) * b });
      const pageCount = Math.max(1, Math.ceil(v.total / b));
      const s = Math.min(requested, pageCount);
      if (s !== requested) v = queue.page({ type: type || undefined, statuses: group, limit: b, skip: (s - 1) * b });
      return { jobs: v.jobs.map((job) => queue.summary(job)), total: v.total, page: s, size: b, pageCount };
    },
    addJob(body) {
      const job = queue.add(String(body?.type ?? ''), body);
      return { message: `${queue.runners[job.type].name} job added to the queue.`, job: queue.summary(job) };
    },
    /** A picture the assistant fetched from the web, as a finished image job in the gallery (show_image). */
    addPicture({ name, data, title = '', detail = '', from = '' }) {
      return queue.summary(queue.addFinished('image', { name, data, summary: { title, detail }, input: { from } }));
    },
    job(id) {
      const job = queue.summary(findJob(id), { log: true });
      // The jobs its input comes from, by name: the window says "Ceramic owl figurine" where it showed
      // "job/<id>/image_1.png" (09.10.2026)
      const sources = {};
      for (const v of Object.values(job.input ?? {}).flat()) {
        const m = typeof v === 'string' ? /^job\/([\w-]+)\//.exec(v) : null;
        const from = m ? queue.jobs.get(m[1]) : null;
        if (from) sources[v] = { title: from.summary?.title ?? '', type: from.type };
      }
      return Object.keys(sources).length ? { ...job, sources } : job;
    },
    jobLog(id, count) {
      findJob(id);
      return queue.lastLog(id, count ? number(count, 'Count', { min: 1, max: 5000, full: true }) : 200);
    },
    cancelJob(id) {
      findJob(id);
      queue.cancel(id);
      return { message: 'Job cancelled.' };
    },
    pauseJob(id) {
      findJob(id);
      queue.pause(id);
      return { message: 'Job paused; "Resume" continues from the last checkpoint.' };
    },
    retryJob(id) {
      const proceed = findJob(id).status === 'paused';
      queue.tryAgain(id);
      return { message: proceed ? 'Job queued to continue where it left off.' : 'Job queued again.' };
    },
    renameJob(id, g) {
      findJob(id);
      const job = queue.rename(id, text(g?.title, 'Title', { max: 120 }));
      return { message: 'Renamed.', job: queue.summary(job) };
    },
    async deleteJob(id) {
      findJob(id);
      await queue.remove(id);
      return { message: setting.deletionMethod === 'permanent' ? 'Deleted.' : 'Moved to the Recycle Bin.' };
    },
    queueStatus() {
      const active = queue.active?.job;
      return { active: active ? queue.summary(active) : null, pending: queue.pending().map((job) => queue.summary(job)), averages: queue.averages() };
    },

    /* ── Galeri ── */
    gallery({ type, limit } = {}) {
      const n = limit ? number(limit, 'Limit', { min: 1, max: 5000, full: true }) : 200;
      const list = [];
      for (const job of queue.page({ type: type || undefined, statuses: ['done'], limit: n }).jobs) {
        const o = queue.summary(job);
        list.push({ id: job.id, type: job.type, creation: job.creation, title: o.summary?.title ?? '', detail: o.summary?.detail ?? '', outputCount: o.outputCount, outputs: o.outputs });
        if (list.length >= n) break;
      }
      return list;
    },
    images() {
      const list = [];
      for (const job of queue.page({ statuses: ['done'], limit: 2000 }).jobs) {
        for (const c of queue.summary(job).outputs) {
          if (c.type === 'image') list.push({ source: c.source, url: c.url, previewUrl: c.previewUrl ?? c.url, name: job.summary?.title ?? '', dateText: job.creation, width: c.width, height: c.height });
        }
      }
      for (const y of h.uploads()) if (y.type === 'image') list.push({ source: y.source, url: y.url, previewUrl: y.url, name: y.name, dateText: null, uploaded: true, width: y.width, height: y.height });
      return list;
    },

    /* ── Yuklemeler ── */
    /** Yuklemeler: veritabanindan (yoksa klasor taranir; ilk acilista tablo klasorden dolar). */
    uploads() {
      const db = queue.db;
      if (db) {
        if (db.uploadCount() === 0 && !db.meta('uploads-scanned')) {
          for (const y of scanUpload()) db.writeUpload({ file: y.source.slice('upload/'.length), type: y.type, name: y.name, size: y.size, width: y.width ?? null, height: y.height ?? null, creation: y.creation });
          db.meta('uploads-scanned', 1);
        }
        return db.uploads().map((y) => ({ source: `upload/${y.file}`, url: `/file/upload/${y.file}`, type: y.type, name: y.name, size: y.size, ...(y.width ? { width: y.width, height: y.height } : {}) }));
      }
      return scanUpload();
    },
    async loadImage(req, name) {
      name = String(name ?? 'image.png');
      const extension = extname(name).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw new UserError('Only PNG, JPEG or WebP can be uploaded.');
      mkdirSync(uploads, { recursive: true });
      let path = freePath(uploads, `${stamp()}-${slug(name.slice(0, -extension.length), 'image')}${extension === '.jpeg' ? '.jpg' : extension}`);
      let file = basename(path);
      await writeBody(req, path, UPLOAD_LIMIT);
      // Telefon fotografi: yon EXIF etiketinde. Pikseller bir kez duzeltilir (PNG, kayipsiz); boylece
      // ComfyUI, ffmpeg ve tarayici hep ayni yonu gorur.
      const direction = exifOrientation(path);
      if (direction !== 1 && setting.ffmpeg) {
        const png = basename(freePath(uploads, file.replace(/\.jpg$/, '.png')));
        try {
          await fixOrientation(setting.ffmpeg, path, join(uploads, png), direction);
          rmSync(path, { force: true });
          file = png;
          path = join(uploads, png);
        } catch (e) {
          rmSync(join(uploads, png), { force: true });
          console.error(`Image orientation could not be fixed (${file}): ${e.message}`);
        }
      }
      const size = imageSize(path);
      if (!size) {
        rmSync(path, { force: true });
        throw new UserError('The file could not be read as an image.');
      }
      queue.db?.writeUpload({ file, type: 'image', name, size: statSync(join(uploads, file)).size, width: size.width ?? null, height: size.height ?? null });
      return { message: 'Image uploaded.', image: { source: `upload/${file}`, url: `/file/upload/${file}`, previewUrl: `/file/upload/${file}`, name, ...size } };
    },
    async loadMusic(req, name) {
      name = String(name ?? 'music.mp3');
      const extension = extname(name).toLowerCase();
      if (!MUSIC_EXTENSIONS.includes(extension)) throw new UserError('Music must be an audio or video file (MP3, WAV, M4A, OGG, FLAC, MP4, MOV…).');
      mkdirSync(uploads, { recursive: true });
      const path = freePath(uploads, `${stamp()}-muzik-${slug(name.slice(0, -extension.length), 'music')}${extension}`);
      const file = basename(path);
      await writeBody(req, path, UPLOAD_LIMIT);
      queue.db?.writeUpload({ file, type: 'music', name: name.slice(0, 120), size: statSync(join(uploads, file)).size });
      return { message: 'Music uploaded.', music: { source: `upload/${file}`, url: `/file/upload/${file}`, name: name.slice(0, 120) } };
    },

    /** Kendi sesi icin kayit: video ya da ses, her bicim (ffmpeg ses izini alir). */
    async loadRecord(req, name) {
      name = String(name ?? 'recording.mp4');
      const extension = extname(name).toLowerCase();
      if (!RECORD_EXTENSIONS.includes(extension)) throw new UserError(`Unsupported recording format (${extension || 'no extension'}). Upload a video or audio file: ${RECORD_EXTENSIONS.join(', ')}.`);
      mkdirSync(uploads, { recursive: true });
      const path = freePath(uploads, `${stamp()}-kayit-${slug(name.slice(0, -extension.length), 'record')}${extension}`);
      const file = basename(path);
      await writeBody(req, path, RECORD_LIMIT);
      queue.db?.writeUpload({ file, type: 'record', name: name.slice(0, 120), size: statSync(join(uploads, file)).size });
      return { message: 'Recording uploaded.', record: { source: `upload/${file}`, url: `/file/upload/${file}`, name: name.slice(0, 120) } };
    },

    /** Model egitimi verisi: metin, Markdown, HTML, JSONL/JSON, CSV/TSV. */
    async loadData(req, name) {
      name = String(name ?? 'data.txt');
      const extension = extname(name).toLowerCase();
      if (!DATA_EXTENSIONS.includes(extension)) throw new UserError(`Unsupported data format (${extension || 'no extension'}). Accepted: ${DATA_EXTENSIONS.join(', ')}.`);
      mkdirSync(uploads, { recursive: true });
      const path = freePath(uploads, `${stamp()}-data-${slug(name.slice(0, -extension.length), 'data')}${extension}`);
      const file = basename(path);
      await writeBody(req, path, RECORD_LIMIT);
      queue.db?.writeUpload({ file, type: 'data', name: name.slice(0, 120), size: statSync(join(uploads, file)).size });
      return { message: 'Data uploaded.', data: { source: `upload/${file}`, name: name.slice(0, 120) } };
    },

    /**
     * What the data collection form offers besides addresses (user request 09.10.2026): the search engines (the
     * services of Settings › Web search with their state, then the free engines), the MCP servers that are on and
     * the installed skills. Keys never leave the panel: only whether a service is set.
     */
    dataSources() {
      const services = settingFile.webSearch ?? {};
      let mcp = [];
      let skills = [];
      try {
        mcp = mcpServerList({ aiRoot: setting.aiRoot, dataRoot: setting.dataRoot }).filter((s) => !s.disabled).map((s) => ({ name: s.name, source: s.source, type: s.type, missing: s.missing ?? [] }));
      } catch {}
      try {
        skills = findSkills({ aiRoot: setting.aiRoot, dataRoot: setting.dataRoot }).map((s) => ({ name: s.name, description: s.description, source: s.source }));
      } catch {}
      return {
        engines: [...SERVICE_ENGINES.map((id) => ({ id, name: ENGINE_NAMES[id], service: true, configured: Boolean(services[id]) })), ...SEARCH_ENGINES.map((id) => ({ id, name: ENGINE_NAMES[id], service: false, configured: true }))],
        mcp,
        skills,
      };
    },

    /**
     * A file for the chat (user request 08.10.2026: "Pdf exel vs desteği yok"): any type up to FILE_LIMIT. The model
     * reads a document (PDF, DOCX, XLSX, PPTX) or a text file (code, CSV, JSON, Markdown) as text, another file by its
     * source with the tools. kind: 'document' | 'text' | 'binary'.
     */
    async loadFile(req, name) {
      name = String(name ?? '').trim().slice(0, 200) || 'file';
      const own = extname(name);
      // the extension only as letters and digits (the stored name must stay a safe source: upload/<file>)
      const extension = own.toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
      mkdirSync(uploads, { recursive: true });
      const path = freePath(uploads, `${stamp()}-file-${slug(name.slice(0, name.length - own.length), 'file')}${extension.length > 1 ? extension : ''}`);
      const file = basename(path);
      await writeBody(req, path, FILE_LIMIT);
      const size = statSync(path).size;
      queue.db?.writeUpload({ file, type: 'file', name: name.slice(0, 120), size });
      return { message: 'File uploaded.', file: { source: `upload/${file}`, url: `/file/upload/${file}`, name, size, kind: readableKind(path) ?? 'binary' } };
    },

    /** Egitim secenekleri: hazir temeller, burada egitilmis modeller (temel olabilir), boyut/niceleme. */
    trainingInfo() {
      return {
        installed: Boolean(setting.hasTrainingEnv),
        // Gorsel LoRA egitimi (musubi-tuner + FLUX.2 klein): ayri ortam
        imageInstalled: Boolean(setting.hasImageTraining),
        musicInstalled: Boolean(setting.hasMusicTraining),
        // Genel (cok kipli) model: egitimgenel.py (egitim ortami); sonuc yazi modeli + gorsel kodlayici
        generalInstalled: Boolean(setting.hasGeneralTraining),
        // Video LoRA: ComfyUI'nin yerlesik egitim dugumleri + kurulu Wan 2.2 5B (ayri ortam yok)
        videoInstalled: !videoTrainingMissing(mod, setting),
        videoMissing: videoTrainingMissing(mod, setting),
        videoResolutions: Object.keys(videoResolutions()),
        videoFrames: videoFrames(),
        musicLanguages: MUSIC_LANGUAGES,
        imageResolutions: IMAGE_RESOLUTIONS,
        fields: Object.entries(TRAINING_FIELDS).map(([id, name]) => ({ id, name })),
        // kurulu: HF onbellegi / temeller klasorunde indirilmis (listede en ustte "Bu bilgisayarda"); ozelTemeller: listede
        // olmayan, daha once indirilmis depolar (kullanici 08.10.2026: "sonradan dahil olanlar en ustte")
        ...baseModelStatuses(setting.aiRoot, { videoInstalled: !videoTrainingMissing(mod, setting) }),
        trained: trainedModels(setting.aiRoot).map((m) => ({ id: `trained:${m.id}`, name: m.name, field: m.field ?? 'text', method: m.method, gguf: m.gguf, dateText: m.dateText, base: m.base, size: m.size, training: m.training, lora: m.lora ?? null, trigger: m.trigger ?? null, language: m.language ?? null, recommendedStrength: m.recommendedStrength ?? null, measurement: m.measurement ?? null })),
        sizes: Object.entries(TRAINING_SIZES).map(([id, name]) => ({ id, name })),
        quantizations: TRAINING_QUANTIZATIONS,
        dataExtensions: DATA_EXTENSIONS,
        // Veri toplama koleksiyonlari: egitimde 'koleksiyon/<kimlik>' olarak veri secilir.
        collections: dataCollections(setting.aiRoot),
        // Answers rated good in the chat: the Training tab offers them as data (POST /chat/ratings/export)
        ratedChats: h.chatRatings(),
      };
    },

    /* ── Sesler ── */
    voices() {
      return listVoices(setting.voiceLibrary);
    },
    async loadVoice(req, name, voiceName) {
      name = String(name ?? 'voice.wav');
      const extension = extname(name).toLowerCase();
      if (!['.wav', '.mp3', '.m4a', '.ogg', '.flac'].includes(extension)) throw new UserError('Audio must be WAV, MP3, M4A, OGG or FLAC.');
      mkdirSync(uploads, { recursive: true });
      const raw = freePath(uploads, `${stamp()}-ses${extension}`);
      await writeBody(req, raw, UPLOAD_LIMIT);
      const wav = `${raw}.24k.wav`;
      try {
        await toReference(setting.ffmpeg, raw, wav);
        const recordName = String(voiceName || name.slice(0, -extension.length)).slice(0, 60);
        const id = addVoice(setting.voiceLibrary, { name: recordName, source: wav, description: 'Uploaded reference' });
        return { message: `Voice added to library: ${recordName}`, id, voice: listVoices(setting.voiceLibrary).find((s) => s.id === id) ?? null };
      } finally {
        rmSync(raw, { force: true });
        rmSync(wav, { force: true });
      }
    },
    async deleteVoice(id) {
      const path = voicePath(setting.voiceLibrary, id);
      if (!path) throw notFound('Voice not found.');
      const info = path.replace(/\.wav$/i, '.json');
      // Kendi sesinin egitilmis modeli (<kimlik>.lora klasoru) da gider.
      const lora = path.replace(/\.wav$/i, '.lora');
      if (setting.deletionMethod === 'permanent') {
        rmSync(path, { force: true });
        rmSync(info, { force: true });
        rmSync(lora, { recursive: true, force: true });
      } else {
        await moveToRecycleBin(path);
        if (existsSync(info)) await moveToRecycleBin(info);
        if (existsSync(lora)) await moveToRecycleBin(lora);
      }
      return { message: 'Voice removed from library.' };
    },

    /* ── Sahne yazari ── */
    // Calisirken Kuyruk panelinde yan gorev olarak gorunur (yerel yazi modeli; panel isi surerken ekran kartini bekler). Ilerleme:
    // bitmis obek payi ve olculen sahne basi sure ('sahne-yaz' olcumu) ile tahmin.
    async writeScene(g) {
      const input = {
        topic: text(g.topic, 'Topic', { max: 2000 }),
        sceneCount: number(g.sceneCount, 'Number of scenes', { min: 1, max: 1000, defaultValue: 5, full: true }),
        ratio: choice(g.ratio, 'Format', ['16:9', '9:16'], '16:9'),
        // Karakterler de konussun (cinsiyet/yasa gore ses); false: yalniz anlatici
        speech: g.speech === undefined || g.speech === null || g.speech === '' ? true : g.speech === true || g.speech === 'true' || g.speech === '1' || g.speech === 1,
      };
      const secScene = queue.averages?.()?.['write-scenes'] ?? null;
      const task = tasks.add({ type: 'write-scenes', title: input.topic, expectedSec: secScene ? secScene * input.sceneCount : null });
      task.advance({ stage: `Writing ${input.sceneCount} scenes` });
      const startedAt = Date.now();
      try {
        const write = setting.sceneWriter ?? writeScenes;
        const result = await write({
          ...input,
          signal: task.signal,
          progress: ({ written, total }) => task.advance({ ratio: written / total, stage: `${written}/${total} scenes written` }),
          // Yerel yazi modeli: panelde gorsel/video isi surerken ekran karti bekleniyor
          waiting: (b, x) => task.advance({ detail: !b ? '' : x?.loading ? 'loading the text model' : 'waiting for the GPU (written once the running job finishes)' }),
        });
        if (result.scenes.length) {
          queue.db?.writeMeasurement('write-scenes', Math.round(((Date.now() - startedAt) / 1000 / result.scenes.length) * 10) / 10, null);
          queue.averageCache = null;
        }
        return { message: `${result.scenes.length} scenes written.`, ...result };
      } catch (e) {
        if (task.signal.aborted) throw new UserError('Scene writing was cancelled.');
        throw e;
      } finally {
        task.finish();
      }
    },

    cancelTask(id) {
      if (!tasks.cancel(id)) throw notFound('No such task (it may have finished).');
      return { message: 'Cancelling the task.' };
    },

    /* ── Soz yazari (Muzik) ── */
    async writeLyric(g) {
      const input = {
        topic: text(g.topic, 'Topic', { required: false, max: 2000 }),
        style: text(g.style, 'Style', { required: false, max: 1000 }),
        language: choice(g.lang, 'Lyrics language', ['tr', 'en'], 'tr'),
        duration: number(g.duration, 'Duration', { min: 5, max: 600, defaultValue: 60, full: true }),
      };
      if (!input.topic && !input.style) throw new UserError('Write a topic or a style for the lyrics.');
      const write = setting.lyricWriter ?? writeLyrics;
      const result = await write(input);
      return { message: 'Lyrics written.', lyrics: result.lyrics };
    },

    /* ── ComfyUI ── */
    comfy: getComfyStatus,
    async startComfy() {
      if (await comfy.isReady()) return { message: 'ComfyUI is already running.', started: false };
      const started = queue.startComfy();
      comfyStatus.time = 0;
      return { message: started ? 'Starting ComfyUI (in the background, may take 1-2 min).' : 'ComfyUI is already starting.', started };
    },
    async stopComfy(g = {}) {
      const force = g?.force === true || g?.force === 'true' || g?.force === '1' || g?.force === 1; // "false" dizesi dogru sayilmasin
      if (queue.active && !force) throw new UserError('A job is running; cancel it first or send force=true.');
      const pids = await (setting.closeComfy ?? closeComfy)();
      // Az once baslatildiysa "zaten başlatılıyor" kilidi kalkar: sonraki is ComfyUI'yi yeniden acar
      // (yoksa is hazirBekleme boyunca bos bekleyip "açılmadı" ile duser).
      queue.comfyStartup = 0;
      comfyStatus.time = 0;
      return { message: pids.length ? `ComfyUI stopped (${pids.length} processes).` : 'No running ComfyUI process found.', closed: pids };
    },
    /** ComfyUI ayrintisi (/system_stats): surum, PyTorch, Python, aygit, baslatma argumanlari, kuyruk. */
    async comfyInfo() {
      const d = await getComfyStatus();
      const info = { ...d, folder: mod.COMFY ?? null, launcher: setting.comfyLauncher, networkPort: setting.address !== '127.0.0.1' ? setting.comfyNetworkPort : null, system: null, devices: [] };
      if (!d.running) return info;
      try {
        const r = await fetch(`${setting.comfyAddress}/system_stats`, { signal: AbortSignal.timeout(3000) });
        const j = await r.json();
        const s = j.system ?? {};
        info.system = {
          version: s.comfyui_version ?? null,
          uiVersion: s.required_frontend_version ?? null,
          python: String(s.python_version ?? '').split(' ')[0] || null,
          pytorch: s.pytorch_version ?? null,
          env: s.deploy_environment ?? null,
          args: (s.argv ?? []).slice(1),
          ramTotal: s.ram_total ?? null,
          ramFree: s.ram_free ?? null,
        };
        info.devices = (j.devices ?? []).map((a) => ({ name: a.name, type: a.type, vramTotal: a.vram_total, vramFree: a.vram_free, torchVramTotal: a.torch_vram_total, torchVramFree: a.torch_vram_free }));
      } catch {
        /* system_stats yanit vermedi: yalniz durum */
      }
      return info;
    },
    async flushComfy() {
      if (!(await comfy.isReady())) throw new UserError('ComfyUI is not running.');
      await comfy.flush();
      return { message: 'ComfyUI unloaded models from memory (/free).' };
    },

    /* ── Ayarlar ── */
    settings() {
      if (!settingFile) throw new UserError('No settings file in this installation.');
      return {
        apiKey: settingFile.apiKey,
        settingFile: settingFile.path,
        modelChoices: settingFile.modelChoices,
        voiceEngine: settingFile.voiceEngine,
        voiceEngines: VOICE_ENGINES,
        comfyIdleCloseMin: settingFile.comfyIdleCloseMin,
        idleCloseOptions: IDLE_CLOSE_MIN,
        comfyIdleClosed: queue.comfyIdleClosed,
        quantizations: quantizationOptions(setting.modelRoot, mod),
        textModel: llm?.installed ? llm.status() : null,
        textModelIdleMin: settingFile.textModelIdleMin,
        textModelIdleOptions: TEXT_MODEL_IDLE_MIN,
        addresses: allowedHosts(setting.address).map((a) => `http://${a}:${setting.port}/`),
        network: setting.address !== '127.0.0.1',
        // Settings › Network: where it listens now, what is saved for the next start, the defaults (panel\defaults.json)
        listen: { address: setting.address, port: setting.port, saved: settingFile.listen, defaults: DEFAULTS, restart: Boolean(restart) },
        translatePrompt: settingFile.translatePrompt,
        networkFullAccess: settingFile.networkFullAccess,
        // Settings › Web search: which services are set; a key never goes back whole (its last 4 characters)
        webSearch: maskedServices(settingFile.webSearch),
        // Settings › Remote model: the key never goes back whole either
        remoteModel: maskedRemote(settingFile.remoteModel),
        // Okuma anahtarinin kendisi donmez: yalniz var mi
        update: updater?.status() ?? null,
        // Donanima gore ince ayarlar: gruplar, tanimlar, gecerli degerler
        fineSettings: fineSettingsStatus(),
      };
    },

    /**
     * Restarts the panel (Settings › Network: a new address or port applies). Not while a job runs or waits, or a chat
     * works: the tray (or the restart helper) opens it again in a few seconds.
     */
    restartPanel() {
      if (!restart) throw new UserError('This panel cannot restart itself; close it and start it again.');
      const chats = h.agent?.running?.().length ?? 0;
      if (queue.active || queue.pending().length || chats) throw new UserError(`Not now: ${queue.active ? 'a job is running' : queue.pending().length ? 'jobs are waiting' : 'a chat is working'}. Restart when it finishes.`, 'inUse');
      setTimeout(() => restart(), 400).unref?.();
      const next = { address: settingFile?.listen.address ?? DEFAULTS.address, port: settingFile?.listen.port ?? DEFAULTS.port };
      return { message: 'Restarting; the panel is back in a few seconds.', port: next.port, address: next.address };
    },

    /* ── Güncelleme (GitHub) ── */
    updateStatus() {
      if (!updater) throw new UserError('Updates are disabled in this installation.');
      return updater.status();
    },
    async checkUpdate() {
      if (!updater) throw new UserError('Updates are disabled in this installation.');
      const d = await updater.check();
      const message = d.fresh
        ? `New version available: ${d.remote.sha.slice(0, 7)} (${d.remote.message}).${d.local.source === 'git' ? ' This installation is a development copy: update with git pull.' : updater.status().auto ? ' Daily check is on: it will be installed automatically.' : ''}`
        : `Up to date: ${d.remote.sha.slice(0, 7)} (${d.remote.message}).`;
      return { message, ...updater.status() };
    },
    async applyUpdate() {
      if (!updater) throw new UserError('Updates are disabled in this installation.');
      const r = await updater.apply();
      return { ...r, ...updater.status() };
    },
    configureUpdate(g) {
      if (!updater || !settingFile) throw new UserError('Updates are disabled in this installation.');
      if (g?.auto === undefined) throw new UserError('No update setting to change (auto expected).');
      const auto = Boolean(g.auto);
      settingFile.saveUpdate({ auto });
      const message = auto ? 'Daily update check on: checked once a day, a new version is installed automatically.' : 'Daily update check off.';
      return { message, ...updater.status() };
    },
    async saveSetting(g) {
      if (!settingFile) throw new UserError('No settings file in this installation.');
      // Ince ayarlar (donanima gore) ayri istekle gelir: Ayarlar > Ince ayarlar kutulari
      if (g?.fineSettings !== undefined) return h.saveFineSettings(g.fineSettings);
      // Settings › Web search comes on its own too (a key is saved from its own field)
      if (g?.webSearch !== undefined) return h.saveWebSearch(g.webSearch);
      if (g?.remoteModel !== undefined) return h.saveRemoteModel(g.remoteModel);
      // Once butun alanlar dogrulanir, sonra uygulanir: gecersiz bir alan digerlerini yarim birakmasin.
      const choices = {};
      for (const [family, q] of Object.entries(g?.modelChoices ?? {})) {
        const value = String(q ?? '').toUpperCase();
        const error = checkQuantization(setting.modelRoot, mod, family, value);
        if (error) throw new UserError(error);
        // Degismeyen secim (arayuz hepsini gonderir) islem sayilmaz; is calisirken de engel olmaz
        if ((settingFile.modelChoices?.[family] ?? '') !== value) choices[family] = value;
      }
      const engine = g?.voiceEngine === undefined ? null : choice(g.voiceEngine, 'Voice engine', Object.keys(VOICE_ENGINES), 'voxcpm');
      const idle = g?.comfyIdleCloseMin === undefined ? null : Number(g.comfyIdleCloseMin);
      if (idle !== null && !IDLE_CLOSE_MIN.includes(idle)) throw new UserError(`The idle close time must be one of: ${IDLE_CLOSE_MIN.join(', ')} min.`);
      const textIdle = g?.textModelIdleMin === undefined ? null : Number(g.textModelIdleMin);
      if (textIdle !== null && !TEXT_MODEL_IDLE_MIN.includes(textIdle)) throw new UserError(`The text model idle time must be one of: ${TEXT_MODEL_IDLE_MIN.join(', ')} min (0 = keep loaded).`);
      let textIdleMessage = '';
      if (textIdle !== null && textIdle !== settingFile.textModelIdleMin) {
        settingFile.saveTextModelIdle(textIdle);
        llm?.idleSchedule?.();
        textIdleMessage = textIdle ? `The text model leaves memory after ${textIdle} min idle.` : 'The text model stays in memory (image/video jobs unload it while they run).';
      }
      let textInfo = null;
      if (g?.textModel !== undefined && llm?.installed) {
        const file = String(g.textModel);
        textInfo = findLlm(setting.aiRoot, file);
        if (!textInfo || textInfo.file !== file) throw new UserError(`Text model not found: ${file}`);
      }
      if (Object.keys(choices).length && queue.active) throw new UserError('The model choice cannot change while a job runs; try again when it finishes.');
      // İstem çevirisi (Ayarlar kutusu): doğrulanacak bir şey yok, hemen uygulanır
      const translate = g?.translatePrompt === undefined ? null : Boolean(g.translatePrompt);
      if (translate !== null) settingFile.savePromptTranslate(translate);
      const translateMessage = translate === null ? '' : translate ? 'Prompts will be translated to English before reaching the model.' : 'Prompt translation is off: prompts will be sent as written.';
      // Assistant access from other devices (Settings › Assistant rules): applied at once
      const network = g?.networkFullAccess === undefined ? null : Boolean(g.networkFullAccess);
      if (network !== null) settingFile.saveNetworkFullAccess(network);
      const networkMessage = network === null ? '' : network ? 'Chats from other devices can use files and commands.' : 'Chats from other devices can only do panel jobs, web search and reading.';
      // Where the panel listens (Settings › Network): saved for this installation, applies after a restart. The port is
      // not a setting (user 08.10.2026): panel\defaults.json (1071)
      let listenMessage = '';
      if (g?.listenAddress !== undefined) {
        const address = choice(String(g.listenAddress), 'Listen on', ['0.0.0.0', '127.0.0.1'], DEFAULTS.address);
        settingFile.saveListen({ address });
        listenMessage = address === '127.0.0.1' ? 'Saved: this computer only; restart the panel to apply.' : 'Saved: all networks of this computer; restart the panel to apply.';
      }
      // Yazi modeli: llm\modeller'deki bir gguf; calisan sunucu kapanir, sonraki istek yenisini yukler.
      if (textInfo) {
        if (textInfo.file !== llm.info?.file) {
          settingFile.saveTextModel(textInfo.file);
          await llm.selectModel(textInfo);
        }
        if (!engine && idle === null && !Object.keys(choices).length) return { message: [`Text model: ${textInfo.name}`, textIdleMessage].filter(Boolean).join(' '), textModel: llm.status() };
      }
      if (!Object.keys(choices).length && !engine && idle === null && textIdleMessage) return { message: textIdleMessage, textModelIdleMin: settingFile.textModelIdleMin };
      if (!Object.keys(choices).length && !engine && idle === null) {
        if (translate !== null || network !== null || listenMessage) return { message: [translateMessage, networkMessage, listenMessage].filter(Boolean).join(' '), translatePrompt: settingFile.translatePrompt, networkFullAccess: settingFile.networkFullAccess, listen: settingFile.listen, restartNeeded: Boolean(listenMessage) };
        if (g?.modelChoices && Object.keys(g.modelChoices).length) return { message: 'Selections are already saved; no change.', modelChoices: settingFile.modelChoices, voiceEngine: settingFile.voiceEngine, comfyIdleCloseMin: settingFile.comfyIdleCloseMin };
        if (textIdle !== null) return { message: 'The text model memory setting is already like this.', textModelIdleMin: settingFile.textModelIdleMin };
        throw new UserError('No setting to change (expected modelChoices, voiceEngine, comfyIdleCloseMin, textModel, textModelIdleMin, translatePrompt, networkFullAccess, listenAddress, webSearch or remoteModel).');
      }
      if (idle !== null) {
        settingFile.saveComfyIdleClose(idle);
        if (!queue.active && !queue.pending().length) queue.idleSchedule();
      }
      if (!Object.keys(choices).length && !engine) return { message: idle ? `ComfyUI will be closed after ${idle} min idle.` : 'ComfyUI will not be closed when idle.', modelChoices: settingFile.modelChoices, voiceEngine: settingFile.voiceEngine, comfyIdleCloseMin: settingFile.comfyIdleCloseMin };
      if (Object.keys(choices).length) settingFile.saveModelChoice(choices);
      if (engine) settingFile.saveVoiceEngine(engine);
      queue.changed();
      return { message: engine && !Object.keys(choices).length ? 'Voice engine saved; new voice-overs use this engine.' : 'Model choice saved; new jobs will use these files.', modelChoices: settingFile.modelChoices, voiceEngine: settingFile.voiceEngine, comfyIdleCloseMin: settingFile.comfyIdleCloseMin };
    },
    /**
     * Settings › Web search (user request 08.10.2026): { brave?, tavily?, searxng? }, '' removes one. All values are
     * checked before any is saved; the answer has the keys masked, like GET /settings.
     */
    saveWebSearch(body) {
      if (!settingFile) throw new UserError('No settings file in this installation.');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UserError('webSearch expects an object: { brave, tavily, searxng }.');
      const changing = {};
      for (const [service, value] of Object.entries(body)) {
        if (value !== null && typeof value !== 'string') throw new UserError(`webSearch.${service} must be text ("" removes it).`);
        try {
          changing[service] = checkServiceValue(service, value);
        } catch (e) {
          throw new UserError(e.message);
        }
      }
      if (!Object.keys(changing).length) throw new UserError('webSearch expects an object: { brave, tavily, searxng }.');
      settingFile.saveWebSearch(changing);
      const active = serviceList(settingFile.webSearch).map((k) => SEARCH_SERVICES[k].name);
      const message = active.length ? `Saved. search_web tries ${active.join(' › ')} first, then the browser and the free engines.` : 'Saved. search_web uses the browser and the free engines.';
      return { message, webSearch: maskedServices(settingFile.webSearch) };
    },
    /**
     * Settings › Remote model (user request 08.10.2026): { url?, key?, model?, whenBusy? }; '' removes a field (all ''
     * removes the remote model). Everything is checked before anything is saved; the answer has the key masked.
     */
    saveRemoteModel(body) {
      if (!settingFile) throw new UserError('No settings file in this installation.');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UserError('remoteModel expects an object: { url, key, model, whenBusy }.');
      const checks = { url: checkRemoteAddress, key: checkRemoteKey, model: checkRemoteModelName };
      const changing = {};
      for (const [field, value] of Object.entries(body)) {
        if (field === 'whenBusy') {
          changing.whenBusy = Boolean(value);
          continue;
        }
        if (!checks[field]) throw new UserError(`Unknown remoteModel field: ${field} (url, key, model or whenBusy).`);
        if (value !== null && typeof value !== 'string') throw new UserError(`remoteModel.${field} must be text ("" removes it).`);
        try {
          changing[field] = checks[field](value);
        } catch (e) {
          throw new UserError(e.message);
        }
      }
      if (!Object.keys(changing).length) throw new UserError('remoteModel expects an object: { url, key, model, whenBusy }.');
      settingFile.saveRemoteModel(changing);
      const r = settingFile.remoteModel;
      let message;
      if (r.url && r.model) message = r.whenBusy ? `Saved. Chats can choose ${r.model} (remote) as their text model; it also answers while the GPU is busy with a job.` : `Saved. Chats can choose ${r.model} (remote) as their text model.`;
      else if (r.url || r.model || r.key) message = `Saved. The remote model needs ${r.url ? 'its model name' : 'its address'} too.`;
      else message = 'Saved. No remote model is set: chats use the local text model.';
      return { message, remoteModel: maskedRemote(r) };
    },
    /** Settings › Remote model › Test: a short question to the saved model; its answer and how long it took. */
    async checkRemoteModel() {
      const r = settingFile?.remoteModel;
      if (!r?.url || !r?.model) throw new UserError('Set the remote model first: its address and model name.');
      try {
        const { text, ms } = await checkRemote(r);
        return { message: `${r.model} answered in ${(ms / 1000).toFixed(1)} s.`, text, ms };
      } catch (e) {
        throw new UserError(e.message);
      }
    },
    /**
     * Ince ayarlari kaydeder. ComfyUI bellek bayragi degistiyse ve is yoksa ComfyUI kapatilir (sonraki is yeni
     * bayraklarla acar); yazi modeli ayari degistiyse ve is yoksa calisan yazi modeli birakilir (sonraki istek yeni
     * butceyle yukler). Is varken ikisi de bir sonraki acilista gecerli olur.
     */
    async saveFineSettings(body) {
      if (!settingFile) throw new UserError('No settings file in this installation.');
      const changing = validateFineSettings(body);
      const previous = fineSettingValues();
      const different = Object.keys(changing).filter((k) => previous[k] !== changing[k]);
      settingFile.saveFineSettings(changing, Object.fromEntries(FINE_SETTINGS.map((t) => [t.key, t.defaultValue])));
      const message = [different.length ? 'Fine settings saved.' : 'The fine settings were already like this.'];
      const free = !queue.active && !queue.pending().length;
      if (different.some((k) => againMustStart(k) === 'comfy')) {
        if (!(await comfy.isReady().catch(() => false))) message.push('ComfyUI will start with the new flags next time.');
        else if (free) {
          await h.stopComfy();
          message.push('ComfyUI was closed: the next job opens it with the new flags.');
        } else message.push('A job is running: ComfyUI will start with the new flags next time.');
      }
      if (different.some((k) => againMustStart(k) === 'llm') && llm?.installed) {
        if (free) await llm.releaseGpu();
        message.push('The text model loads with the new setting next time.');
      }
      queue.changed();
      return { message: message.join(' '), fineSettings: fineSettingsStatus() };
    },
    refreshKey() {
      if (!settingFile) throw new UserError('No settings file in this installation.');
      return { message: 'New API key generated; the old key no longer works.', apiKey: settingFile.refreshKey() };
    },

    /* ── Modeller ── */
    models() {
      const m = installedModels(setting.modelRoot, mod);
      return { ...m, families: Object.fromEntries(Object.entries(FAMILIES).map(([k, a]) => [k, a.name])), choices: settingFile?.modelChoices ?? {} };
    },
    catalog() {
      // defaultValue: the default model set (the same set as setup.bat -Models all; Settings "Download default models")
      return catalogStatus(setting.modelRoot).map((k) => ({ ...k, defaultValue: isDefaultModel(k) }));
    },
    /** Varsayilan model kumesinin eksiklerini indirme sirasina alir (kullanici istegi 07.10.2026: tek tikla varsayilan modeller). */
    downloadDefault() {
      if (!downloader) throw new UserError('No downloader in this installation.');
      const active = new Set(downloader.summaries().filter((i) => ['queued', 'downloading', 'paused'].includes(i.status)).map((i) => `${i.folder}/${i.file}`));
      const missing = h.catalog().filter((k) => k.defaultValue && !k.installed && !active.has(`${k.folder}/${k.file}`));
      const downloads = missing.map((k) => downloader.add({ catalog: k.id }));
      const gb = (missing.reduce((t, k) => t + (k.size ?? 0), 0) / 2 ** 30).toFixed(1);
      return {
        message: downloads.length ? `${downloads.length} models queued (${gb} GB). Voice and text models are installed by setup.bat.` : 'All default models are installed or already in the download list.',
        downloads,
      };
    },
    async deleteModel(folder, file, force) {
      const running = queue.active?.job?.modelFiles ?? [];
      const r = await deleteModel({ modelRoot: setting.modelRoot, mod, folder, file, force: force === true || force === '1' || force === 'true', runningFiles: running, deletionMethod: setting.deletionMethod });
      queue.changed();
      return { message: setting.deletionMethod === 'permanent' ? `${file} deleted.` : `${file} moved to the Recycle Bin.`, ...r };
    },
    /**
     * Tarayicidan model dosyasi yukleme (10-20 GB): govde dogrudan diske akar (bellekte tutulmaz,
     * boyut siniri yok), <dosya>.yukleniyor'a yazilir, bitince adi degisir. Var olan dosyanin
     * ustune yalniz ustuneYaz=1 ile yazilir (409 oncesi govde okunmaz). Baglanti kopunca yarim silinir.
     */
    async loadModel(req, { folder, file, writeOnto }) {
      const name = String(file ?? '').trim();
      checkModelExtension(name);
      const target = modelPath(setting.modelRoot, String(folder ?? ''), name);
      const onto = writeOnto === '1' || writeOnto === 'true';
      // Yukleme uzun surer (10-20 GB): denetimler basta ve yeniden adlandirmadan hemen once
      const check = () => {
        if (existsSync(target) && !onto) throw new UserError(`${name} is already installed; confirm to overwrite.`, 'inUse');
        if (existsSync(target) && (queue.active?.job?.modelFiles ?? []).includes(name)) throw new UserError('This model is used by the running job; upload it when the job finishes.', 'inUse');
        const downloaded = downloader?.enabledRecord(String(folder), name);
        if (downloaded) throw new UserError(`${name} is in the download list (${downloaded.status}); finish or delete it first.`, 'inUse');
      };
      check();
      const expected = Number(req.headers['content-length'] ?? 0) || null;
      mkdirSync(join(setting.modelRoot, String(folder)), { recursive: true });
      const partial = `${target}.uploading`;
      const height = await writeBody(req, partial, Infinity);
      if (expected && height !== expected) {
        rmSync(partial, { force: true });
        throw new UserError(`Upload incomplete (${height} / ${expected} bytes); try again.`);
      }
      try {
        check();
      } catch (e) {
        rmSync(partial, { force: true });
        throw e;
      }
      if (existsSync(target)) rmSync(target, { force: true });
      renameSync(partial, target);
      queue.changed();
      return { message: `${name} added (${(height / 2 ** 30).toFixed(2)} GB).`, model: { folder, file: name, size: height } };
    },
    /** Bu bilgisayardaki klasorleri ve model dosyalarini listeler (Gozat penceresi). */
    browse(path) {
      const g = browse(path);
      return { ...g, files: g.files.map((d) => ({ ...d, folder: folderEstimate(d.name) })) };
    },
    /** Bu bilgisayardaki dosyayi tasir/kopyalar (indirme listesinde ilerler). */
    modelAddLocal(g) {
      if (!downloader) throw new UserError('No downloader in this installation.');
      const i = downloader.addLocal(g);
      return { message: `${i.method === 'move' ? 'Moving' : 'Copying'}: ${i.file}`, download: i };
    },
    downloads() {
      if (!downloader) return [];
      return downloader.summaries();
    },
    addDownload(g) {
      if (!downloader) throw new UserError('No downloader in this installation.');
      const i = downloader.add(g);
      return { message: `Download queued: ${i.file}`, download: i };
    },
    download(id) {
      if (!downloader) throw notFound('Download not found.');
      try {
        return downloader.summary(downloader.find(id));
      } catch (e) {
        throw notFound(e.message);
      }
    },
    cancelDownload(id) {
      return { message: 'Download paused; "Resume" continues where it left off.', download: downloader.cancel(id) };
    },
    resumeDownload(id) {
      return { message: 'Resuming download.', download: downloader.resume(id) };
    },
    deleteDownload(id) {
      downloader.remove(id);
      return { message: 'Download record and partial file deleted.' };
    },

    /* ── Sohbet / ajan (lib/ajan; h.ajan sunucu kurulurken baglanir) ── */
    noAgent() {
      throw new UserError('Chat requires the local text model (<ai>\\llm\\bin\\llama-server.exe and llm\\models\\*.gguf).');
    },
    /** One page of chats (newest first), optionally searched; text models to choose from (remote: Settings › Remote model). */
    chatList({ q = '', after = null, limit = null, sort = null, archived = false } = {}) {
      if (!h.agent) return { chats: [], total: 0, next: null, textModel: false, models: [], defaultModel: null, remote: null };
      const status = llm?.status?.() ?? {};
      const remote = h.agent.remoteConfig();
      return { ...h.agent.list({ query: q ?? '', after, limit: limit ?? undefined, sort: sort || 'recent', archived: archived === true || archived === '1' || archived === 'true' }), textModel: true, models: (status.models ?? []).map((m) => ({ file: m.file, name: m.name, gib: m.gib, image: Boolean(m.image) })), defaultModel: status.file ?? null, remote: remote ? { model: remote.model, whenBusy: remote.whenBusy } : null, translatePrompt: settingFile ? settingFile.translatePrompt : null };
    },
    createChat(g = {}, authority = {}) {
      if (!h.agent) h.noAgent();
      // An assistant preset gives the settings the request leaves out (user request 08.10.2026)
      const preset = g.preset ? h.agent.preset(g.preset) : null;
      // a preset's model that was removed since (a model file, or the remote model of Settings): the default model
      const presetModel = preset?.model && (preset.model === REMOTE_MODEL ? h.agent.remoteConfig() : llm?.modelInfo?.(preset.model)) ? preset.model : null;
      const s = h.agent.create({ title: g.title ?? '', full: Boolean(authority.full), approvalMode: g.approvalMode ?? (g.unattended === undefined ? preset?.approvalMode ?? undefined : undefined), unattended: g.unattended, model: g.model ?? presetModel, cwd: g.cwd ?? preset?.cwd ?? null, thinking: g.thinking ?? preset?.thinking ?? undefined, stepLimit: g.stepLimit, canAsk: g.canAsk !== false, preset, temporary: g.temporary === true });
      return { message: 'Chat opened.', chat: h.agent.summary(s) };
    },
    chatPresets() {
      return { presets: h.agent ? h.agent.presets() : [] };
    },
    saveChatPreset(g = {}, presetId = null) {
      if (!h.agent) h.noAgent();
      return h.agent.savePreset(g, presetId);
    },
    deleteChatPreset(presetId) {
      if (!h.agent) h.noAgent();
      return h.agent.deletePreset(presetId);
    },
    /* Settings › Assistant (user request 08.10.2026): scheduled tasks, lasting notes, skills, MCP servers */
    needsFull(authority) {
      if (!authority?.full) throw new UserError('Changing MCP servers and skills needs full access: use this computer or the API key, or allow other devices (Settings › Assistant rules).', 'forbidden');
    },
    chatSchedules() {
      return { schedules: h.agent ? h.agent.scheduleList() : [] };
    },
    addChatSchedule(g = {}, authority = {}) {
      if (!h.agent) h.noAgent();
      if (!String(g.task ?? '').trim()) throw new UserError('Write the task.');
      const r = AgentManager.userError(() => h.agent.schedule({ task: String(g.task).trim(), minuteAfter: g.minuteAfter, time: g.time, repeatMin: g.repeatMin, full: Boolean(authority.full), approvalMode: g.approvalMode ?? 'edits', cwd: authority.full ? g.cwd ?? null : null }));
      return { message: r.message, schedule: r.scheduleEntry };
    },
    updateChatSchedule(id, g = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.updateSchedule(id, g);
    },
    deleteChatSchedule(id) {
      if (!h.agent) h.noAgent();
      if (!h.agent.schedules().some((z) => z.id === String(id))) throw new UserError('No such schedule.', 'notFound');
      return { message: h.agent.deleteSchedule(id) };
    },
    chatMemory({ q = '' } = {}) {
      return h.agent ? h.agent.memoryNotes(q ?? '') : { notes: [], total: 0 };
    },
    addChatMemory(g = {}) {
      if (!h.agent) h.noAgent();
      return { message: AgentManager.userError(() => h.agent.addMemory(g.text)) };
    },
    updateChatMemory(noteId, g = {}) {
      if (!h.agent) h.noAgent();
      if (!h.agent.notes().some((n) => n.id === noteId)) throw new UserError('No such note.', 'notFound');
      return { message: AgentManager.userError(() => h.agent.updateMemory(noteId, g.text)) };
    },
    deleteChatMemory(noteId) {
      if (!h.agent) h.noAgent();
      // by id only (the tool also deletes by text)
      if (!h.agent.notes().some((n) => n.id === noteId)) throw new UserError('No such note.', 'notFound');
      return { message: AgentManager.userError(() => h.agent.deleteMemory(noteId)) };
    },
    chatSkills() {
      return { skills: h.agent ? h.agent.skillList() : [] };
    },
    removeChatSkill(name, authority = {}) {
      if (!h.agent) h.noAgent();
      h.needsFull(authority);
      return h.agent.removeSkill(name);
    },
    mcpServerList() {
      return { servers: h.agent ? h.agent.mcp.list() : [] };
    },
    chatPlugins() {
      return { plugins: h.agent ? h.agent.pluginList() : [] };
    },
    removeChatPlugin(name, authority = {}) {
      if (!h.agent) h.noAgent();
      h.needsFull(authority);
      return h.agent.removePlugin(name);
    },
    addMcpServer(g = {}, authority = {}) {
      if (!h.agent) h.noAgent();
      h.needsFull(authority);
      return h.agent.addMcpServer(g);
    },
    configureMcpServer(name, g = {}, authority = {}) {
      if (!h.agent) h.noAgent();
      h.needsFull(authority);
      return h.agent.configureMcpServer(name, g);
    },
    checkMcpServer(name, authority = {}) {
      if (!h.agent) h.noAgent();
      h.needsFull(authority);
      return h.agent.checkMcpServer(name);
    },
    removeMcpServer(name, authority = {}) {
      if (!h.agent) h.noAgent();
      h.needsFull(authority);
      return h.agent.removeMcpServer(name);
    },
    promptTemplates() {
      return { templates: h.agent ? h.agent.templates() : [] };
    },
    savePromptTemplate(g = {}, templateId = null) {
      if (!h.agent) h.noAgent();
      return h.agent.saveTemplate(g, templateId);
    },
    deletePromptTemplate(templateId) {
      if (!h.agent) h.noAgent();
      return h.agent.deleteTemplate(templateId);
    },
    chat(id) {
      if (!h.agent) h.noAgent();
      return { chat: h.agent.detail(id) };
    },
    updateChat(id, g = {}) {
      if (!h.agent) h.noAgent();
      return { message: 'Saved.', chat: h.agent.applyUpdate(id, g) };
    },

    /* ── Knowledge (document search; lib/knowledge.mjs) ── */

    knowledgeList() {
      return { documents: h.knowledge.list(), status: h.knowledge.status() };
    },
    /** source: an upload (POST /uploads/file) or a job's file; path: a file on this computer (full access). */
    knowledgeAdd(g = {}, authority = {}) {
      if (g.path && !authority?.full) throw new UserError('A file on this computer needs full access: upload it instead (POST /uploads/file).', 'forbidden');
      const r = h.knowledge.add({ source: g.source ? String(g.source) : null, path: g.path ? String(g.path) : null, name: g.name ? String(g.name) : null, origin: 'list' });
      const passages = r.document.chunks === 1 ? '1 passage' : `${r.document.chunks} passages`;
      return { message: r.added ? `Added to Knowledge: ${r.document.name} (${passages}).` : `Already in Knowledge: ${r.document.name}.`, document: r.document, added: r.added };
    },
    knowledgeRemove(documentId) {
      const d = h.knowledge.remove(documentId);
      return { message: `Removed from Knowledge: ${d.name}.` };
    },
    async knowledgeSearch(g = {}) {
      const documents = Array.isArray(g.documents) ? g.documents : g.documents ? String(g.documents).split(',') : null;
      return await h.knowledge.search(g.query ?? g.q, { documents, count: g.count });
    },
    deleteChat(id, { keepOutputs } = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.remove(id, { keepOutputs: keepOutputs === true || keepOutputs === '1' || keepOutputs === 'true' });
    },
    /** Mesaj: bekle=true son yaniti bekler (API istemcisi), yoksa hemen doner; olaylar SSE ile. */
    async chatMessage(id, g = {}, authority = null) {
      if (!h.agent) h.noAgent();
      // The sender's access decides: a chat opened with fewer rights gets the file and command tools from its next
      // run; a device without them cannot drive a chat that has them
      if (authority) h.agent.setAccess(id, Boolean(authority.full));
      const input = { text: g.text ?? g.message ?? '', attachments: g.attachments ?? [] };
      // While the chat runs the message waits for the model's next step (a waiting question takes it as the answer)
      if (h.agent.get(id).work) {
        const q = h.agent.queueMessage(id, input);
        return { message: q.answered ? 'Answer sent.' : 'Message queued: the assistant reads it at its next step.', queued: Boolean(q.queued), chat: h.agent.summary(q.chat) };
      }
      const s = h.agent.addMessage(id, input);
      const p = h.agent.run(s);
      if (g.wait) {
        const response = await p;
        return { response, chat: h.agent.summary(s) };
      }
      p.catch(() => {});
      return { message: 'Message sent; the reply is in the event stream.', chat: h.agent.summary(s) };
    },
    answerChat(id, g = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.answer(id, g.id, g.answer);
    },
    /**
     * Edit an earlier message of the user and send it again (user request 08.10.2026): what followed it stays as the
     * earlier version. wait=true waits for the answer like POST /chat/{id}/message.
     */
    async editChatMessage(id, g = {}, authority = null) {
      if (!h.agent) h.noAgent();
      if (authority) h.agent.setAccess(id, Boolean(authority.full));
      const s = h.agent.editMessage(id, g.message, { text: g.text ?? '', attachments: Array.isArray(g.attachments) ? g.attachments : undefined });
      const p = h.agent.run(s);
      if (g.wait) {
        const response = await p;
        return { response, chat: h.agent.summary(s) };
      }
      p.catch(() => {});
      return { message: 'Message edited; the reply is in the event stream.', chat: h.agent.summary(s) };
    },
    async regenerateChat(id, g = {}, authority = null) {
      if (!h.agent) h.noAgent();
      if (authority) h.agent.setAccess(id, Boolean(authority.full));
      const s = h.agent.regenerate(id);
      const p = h.agent.run(s);
      if (g.wait) {
        const response = await p;
        return { response, chat: h.agent.summary(s) };
      }
      p.catch(() => {});
      return { message: 'Writing the answer again; it comes in the event stream.', chat: h.agent.summary(s) };
    },
    switchChatBranch(id, g = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.switchBranch(id, g.message, g.version);
    },
    forkChat(id, g = {}, authority = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.fork(id, g.message, { full: Boolean(authority.full) });
    },
    /** Thumbs up / down on an answer (user request 08.10.2026). */
    rateChat(id, g = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.rate(id, g.message, g.rating);
    },
    /** Follow-up suggestions under the last answer (user request 08.10.2026). */
    chatFollowUps(id, g = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.followUps(id, g.message);
    },
    /** How many answers are rated good and bad, in how many chats (from the chat list in panel.db). */
    chatRatings() {
      if (!h.agent) return { good: 0, bad: 0, chats: 0 };
      return h.agent.ratingCounts();
    },
    /** A chat as a file download (user request 08.10.2026): format json (to import again) or md (to read). */
    exportChat(id, format, response) {
      if (!h.agent) h.noAgent();
      const f = h.agent.exportChat(id, format || 'json');
      const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
      response.writeHead(200, { 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(f.text);
    },
    /**
     * A chat from a file (POST /chat/import): the exported JSON as the body, or { data: <it>, approvalMode }. The new
     * chat has the access of the device that imports it.
     */
    importChat(g = {}, authority = {}) {
      if (!h.agent) h.noAgent();
      const wrapped = g && typeof g === 'object' && !Array.isArray(g) && g.data !== undefined;
      const s = h.agent.importChat(wrapped ? g.data : g, { full: Boolean(authority.full), approvalMode: wrapped ? g.approvalMode : undefined });
      const count = s.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).length;
      return { message: `Chat imported: ${count} message${count === 1 ? '' : 's'}.`, chat: h.agent.summary(s) };
    },
    /** The good answers as JSONL, a download ({ messages } per line: the chat format of the Training tab). */
    downloadRatings(req, response) {
      const lines = h.agent ? h.agent.ratedExamples().examples.map((e) => JSON.stringify(e)) : [];
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="rated-chats-${stamp()}.jsonl"`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(lines.length ? `${lines.join('\n')}\n` : '');
    },
    /**
     * The good answers saved as a training data upload (like POST /uploads/data): its source goes into a training job's
     * dataItems (the Training tab's "Good answers from rated chats").
     */
    saveRatings() {
      if (!h.agent) h.noAgent();
      const { examples } = h.agent.ratedExamples();
      if (!examples.length) throw new UserError('No answer is rated good yet: rate answers in the chat with the thumbs up first.');
      mkdirSync(uploads, { recursive: true });
      const path = freePath(uploads, `${stamp()}-data-rated-chats.jsonl`);
      const file = basename(path);
      writeFileSync(path, `${examples.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
      const name = 'rated-chats.jsonl';
      queue.db?.writeUpload({ file, type: 'data', name, size: statSync(path).size });
      return { message: `${examples.length} good answer${examples.length === 1 ? '' : 's'} saved as training data.`, examples: examples.length, data: { source: `upload/${file}`, name } };
    },
    undoChatEdit(id, g = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.undo(id, g.checkpoint, { force: g.force === true });
    },
    chatRules() {
      if (!h.agent) h.noAgent();
      return { text: h.agent.globalRules().trim(), path: h.agent.rulesFile, projectFiles: RULE_FILES };
    },
    saveChatRules(g = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.saveGlobalRules(g.text);
    },
    compactChat(id) {
      if (!h.agent) h.noAgent();
      return h.agent.compact(id);
    },
    stopChat(id) {
      if (!h.agent) h.noAgent();
      return h.agent.stop(id);
    },
    chatApproval(id, g = {}) {
      if (!h.agent) h.noAgent();
      return h.agent.approve(id, g.id, g.yes, { always: g.always === true });
    },
    runningAgents() {
      return { agents: h.agent ? h.agent.running() : [], background: h.agent ? h.agent.backgroundList() : [] };
    },
    /* Background work of the chats (user request 09.10.2026): list, stop one, stop everything */
    chatBackground({ chat = null } = {}) {
      if (!h.agent) return { items: [] };
      if (chat) h.agent.get(chat);
      return { items: h.agent.backgroundList(chat || null) };
    },
    stopChatBackground(itemId) {
      if (!h.agent) h.noAgent();
      return h.agent.stopItem(itemId);
    },
    stopAllChats() {
      if (!h.agent) h.noAgent();
      return h.agent.stopAll();
    },
    agentInfo() {
      if (!h.agent) return { tools: [], mcp: [], skills: [], processes: [], schedules: [], background: [], memory: '', textModel: null, readsImages: false };
      return h.agent.toolInfo();
    },
    /** SSE: tek sohbetin (ya da id "hepsi": tum sohbetlerin) olaylari; ilk olay o anki durum. */
    chatEvents(req, response, id) {
      if (!h.agent) h.noAgent();
      const all = id === 'all';
      if (!all) h.agent.get(id);
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const write = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      write({ type: 'status', time: new Date().toISOString(), ...(all ? { chats: h.agent.list().chats } : { chat: h.agent.detail(id) }) });
      // The all-chats stream (chat list) needs no answer pieces, thinking, token counts, progress texts or the whole
      // conversation of a branch that is shown
      const listen = (event) => {
        if (all ? !['delta', 'reasoning', 'usage', 'progress', 'branch'].includes(event.type) : event.chat === id) write(event);
      };
      h.agent.events.on('event', listen);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
      const close = () => {
        clearInterval(heartbeat);
        h.agent.events.off('event', listen);
      };
      req.on('close', close);
      response.on('close', close);
    },
  };
  h.tasks = tasks;
  h.agent = null;
  return h;
}
