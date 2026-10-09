/**
 * One-time migration of data written by the Turkish-named versions (before the English rename, October 2026):
 * panel-data\ayar.json keys, panel.db table/column names and the JSON job records inside, outputs\<job>\is.json files,
 * chat sessions, downloads and sessions files. Runs at startup before anything opens the files; idempotent (a marker in
 * panel-data\migration.json records what was done). legacy-map.json: old key -> new key (object fields) and old enum
 * values -> new values (type, status, kind, gender, age, engine, field).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_FILES, LEGACY_DATA_FILES } from './data-files.mjs';
import '../web/lang/dictionary.js';

const MAP = JSON.parse(readFileSync(new URL('./legacy-map.json', import.meta.url), 'utf8'));
const KEYS = Object.assign(Object.create(null), MAP.keys);
const VALUES = MAP.values;
// fields whose string values are enumerations
const VALUE_FIELDS = { type: 'type', tur: 'type', status: 'status', durum: 'status', kind: 'kind', gender: 'gender', cinsiyet: 'gender', age: 'age', yas: 'age', engine: 'engine', motor: 'engine', field: 'field', alan: 'field', voiceEngine: 'engine', sesMotoru: 'engine' };
const SOURCE_DIRS = { is: 'job', yukleme: 'upload', koleksiyon: 'collection' };

/** A whole source reference: "is/<id>/<file>", "yukleme/<file>", "koleksiyon/<id>", "/dosya/..." -> the English one. */
function legacySource(ref) {
  return ref.replace(/^\/dosya\//, '/file/').replace(/^(\/file\/)?(is|yukleme|koleksiyon)\//, (_, file = '', dir) => `${file}${SOURCE_DIRS[dir]}/`);
}

/** File links inside a text (a chat message, a summary): "/dosya/is/…", "/dosya/yukleme/…", "/dosya/…" -> "/file/…". */
export function migrateFileLinks(text) {
  return text.replace(/\/dosya\/(?:(is|yukleme|koleksiyon)\/)?/g, (_, dir) => `/file/${dir ? `${SOURCE_DIRS[dir]}/` : ''}`);
}

/** Deep copy with renamed keys and translated enum values. */
export function migrateObject(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => migrateObject(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[KEYS[k] ?? k] = migrateObject(v, KEYS[k] ?? k);
    return out;
  }
  if (typeof value === 'string' && VALUE_FIELDS[key]) {
    const table = VALUES[VALUE_FIELDS[key]];
    if (table && table[value] !== undefined) return table[value];
  }
  // Source references and file links: "is/<id>/<file>", "yukleme/<file>", "koleksiyon/<id>", "/dosya/..."
  if (typeof value === 'string' && /^(is\/\d{8}-|yukleme\/[\w.-]+$|koleksiyon\/|\/dosya\/)/.test(value)) return legacySource(value);
  return value;
}

/** True when the object (recursively) has at least one key known to be old. */
export function needsMigration(value) {
  if (Array.isArray(value)) return value.some(needsMigration);
  if (value && typeof value === 'object') return Object.keys(value).some((k) => KEYS[k] !== undefined && KEYS[k] !== k) || Object.values(value).some(needsMigration);
  return false;
}

function migrateJsonFile(path, log) {
  if (!existsSync(path)) return false;
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  if (!needsMigration(data)) return false;
  writeFileSync(path, JSON.stringify(migrateObject(data), null, 2));
  log(`migrated ${path}`);
  return true;
}

/** panel.db: Turkish table/column names -> English, job records inside rewritten. */
function migrateDatabase(path, log) {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (!tables.has('isler') && !tables.has('yuklemeler') && !tables.has('olcumler')) return false;
    db.exec('BEGIN');
    if (tables.has('meta')) {
      const cols = db.prepare('PRAGMA table_info(meta)').all().map((c) => c.name);
      if (cols.includes('anahtar')) db.exec('ALTER TABLE meta RENAME COLUMN anahtar TO key; ALTER TABLE meta RENAME COLUMN deger TO value');
    }
    if (tables.has('isler')) {
      db.exec('DROP INDEX IF EXISTS isler_olusturma; DROP INDEX IF EXISTS isler_tur; DROP INDEX IF EXISTS isler_durum');
      db.exec('ALTER TABLE isler RENAME TO jobs; ALTER TABLE jobs RENAME COLUMN tur TO type; ALTER TABLE jobs RENAME COLUMN durum TO status; ALTER TABLE jobs RENAME COLUMN olusturma TO creation; ALTER TABLE jobs RENAME COLUMN sira TO position; ALTER TABLE jobs RENAME COLUMN kayit TO record');
      const rows = db.prepare('SELECT id, type, status, record FROM jobs').all();
      const upd = db.prepare('UPDATE jobs SET type = ?, status = ?, record = ? WHERE id = ?');
      for (const r of rows) {
        let record;
        try {
          record = JSON.parse(r.record);
        } catch {
          continue;
        }
        const fresh = migrateObject(record);
        upd.run(VALUES.type[r.type] ?? r.type, VALUES.status[r.status] ?? r.status, JSON.stringify(fresh), r.id);
      }
      log(`migrated ${rows.length} job records`);
    }
    if (tables.has('olcumler')) {
      db.exec('DROP INDEX IF EXISTS olcumler_anahtar; ALTER TABLE olcumler RENAME TO measurements; ALTER TABLE measurements RENAME COLUMN anahtar TO key; ALTER TABLE measurements RENAME COLUMN deger TO value; ALTER TABLE measurements RENAME COLUMN is_id TO job_id');
    }
    if (tables.has('yuklemeler')) {
      const cols = db.prepare('PRAGMA table_info(yuklemeler)').all().map((c) => c.name);
      db.exec('DROP INDEX IF EXISTS yuklemeler_olusturma; ALTER TABLE yuklemeler RENAME TO uploads');
      for (const c of cols) if (KEYS[c] && KEYS[c] !== c) db.exec(`ALTER TABLE uploads RENAME COLUMN ${c} TO ${KEYS[c]}`);
      const typeCol = KEYS.tur ?? 'type';
      const rows = db.prepare(`SELECT rowid AS rid, ${typeCol} AS t FROM uploads`).all();
      const upd = db.prepare(`UPDATE uploads SET ${typeCol} = ? WHERE rowid = ?`);
      for (const r of rows) if (VALUES.kind[r.t]) upd.run(VALUES.kind[r.t], r.rid);
    }
    db.exec('COMMIT');
    log('migrated panel.db (tables, columns, records)');
    return true;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw e;
  } finally {
    db.close();
  }
}

/** Rewrites a JSON file with fix(data) when it has old keys. */
function rewriteJson(path, fix) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  if (!needsMigration(data)) return false;
  writeFileSync(path, JSON.stringify(fix(data), null, 1));
  return true;
}

/**
 * voice\references\*.json, the voice library: name, engine, gender, age, reference text, measurements. Missed by the
 * first migration (09.10.2026: every voice showed its id as its name, the EMA voice did not go to EMA, a character got no
 * voice by gender and age, an own voice lost its reference text).
 */
function migrateVoiceLibrary(dir, log) {
  if (!existsSync(dir)) return false;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const ok = rewriteJson(join(dir, f), (data) => {
      const fresh = migrateObject(data);
      // a character voice: human / animal (tur is a job type elsewhere)
      if (typeof fresh.type === 'string' && VALUES.kind[fresh.type]) fresh.type = VALUES.kind[fresh.type];
      return fresh;
    });
    if (ok) n += 1;
  }
  if (n) log(`migrated ${n} voices of the library`);
  return n > 0;
}

// Collection summary maps keyed by data (file names, languages, sources, categories): their keys stay as they are
const DATA_KEYED = new Set(['files', 'languages', 'sources', 'categories']);

/**
 * data\toplanan\<collection>\: the collected data (ozet.json, site-kuyrugu.json, the *.jsonl records the training reads).
 * File names stay (the code still uses yazilar.jsonl, egitim-*.jsonl); keys inside ozet.json maps keyed by data stay too
 * ("yazilar" in files is a file name, "tarih" in categories a category).
 */
function migrateCollections(root, log) {
  if (!existsSync(root)) return false;
  let n = 0;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const folder = join(root, d.name);
    for (const f of readdirSync(folder)) {
      const path = join(folder, f);
      if (f === 'ozet.json') {
        if (rewriteJson(path, (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => {
          const key = KEYS[k] ?? k;
          return [key, DATA_KEYED.has(key) ? v : migrateObject(v, key)];
        })))) n += 1;
      } else if (f.endsWith('.json') || f.endsWith('.json.bak')) {
        if (rewriteJson(path, (data) => migrateObject(data))) n += 1;
      } else if (f.endsWith('.jsonl')) {
        const lines = readFileSync(path, 'utf8').split('\n');
        let changed = false;
        const fresh = lines.map((line) => {
          if (!line.trim()) return line;
          try {
            const v = JSON.parse(line);
            if (!needsMigration(v)) return line;
            changed = true;
            return JSON.stringify(migrateObject(v));
          } catch {
            return line;
          }
        });
        if (changed) {
          writeFileSync(path, fresh.join('\n'));
          n += 1;
        }
      }
    }
  }
  if (n) log(`migrated ${n} files of the collected data`);
  return n > 0;
}

/*
 * The second English pass (09.10.2026): enum values the first one left in Turkish or translated word by word, the
 * training registry and the files of the models trained here.
 */
const INPUT_VALUES = {
  quality: { denetimli: 'checked', dogal: 'natural', hizli: 'fast' },
  musicLevel: { light: 'low', middle: 'medium', distinct: 'high', hafif: 'low' },
  musicMode: { uret: 'generate', yok: 'none' },
  priority: { kalite: 'quality' },
  strength: { cok: 'much', orta: 'medium', az: 'little' },
  browser: { hep: 'always', otomatik: 'automatic' },
  extract: { kural: 'rule' },
  media: { indir: 'download' },
  method: { sifir: 'scratch', ince: 'fine' },
  size: { middle: 'medium', tooLarge: 'large' },
};
const STATUS_VALUES = { duraklatildi: 'paused', indiriliyor: 'downloading' };
const TRAINED = /^egitilmis:/;

/** A job record with the values of 09.10.2026 (status, input values, trained:<id>, outputs[].main, yielded). */
export function migrateJobValues(record) {
  const fix = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => fix(x, key));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const name = k === 'pathGave' ? 'yielded' : k === 'ana' && key === 'outputs' ? 'main' : k;
        out[name] = fix(x, name);
      }
      return out;
    }
    if (typeof v !== 'string') return v;
    if (key === 'status') return STATUS_VALUES[v] ?? v;
    if (INPUT_VALUES[key]?.[v]) return INPUT_VALUES[key][v];
    if ((key === 'base' || key === 'lora') && TRAINED.test(v)) return v.replace(TRAINED, 'trained:');
    return v;
  };
  return fix(record, '');
}

const renameIfThere = (from, to) => {
  if (!existsSync(from) || existsSync(to)) return false;
  renameSync(from, to);
  return true;
};

/** training\models: kayit.json -> registry.json (values and data keys), the GGUF files and the model folders' files. */
function migrateTrainedModels(aiRoot, log) {
  const models = join(aiRoot, 'training', 'models');
  const old = join(models, 'kayit.json');
  let n = 0;
  if (existsSync(old) && !existsSync(join(models, 'registry.json'))) {
    let list = [];
    try {
      list = JSON.parse(readFileSync(old, 'utf8'));
    } catch {}
    const fresh = (Array.isArray(list) ? list : []).map((m) => {
      const r = { ...m };
      r.method = INPUT_VALUES.method[r.method] ?? r.method;
      if (r.size) r.size = INPUT_VALUES.size[r.size] ?? r.size;
      if (r.data && typeof r.data === 'object') {
        const d = { ...r.data };
        if ('subtitled' in d) [d.captioned, d.subtitled] = [d.subtitled, undefined];
        if (r.field === 'music' && 'voice' in d) [d.songs, d.voice] = [d.voice, undefined];
        r.data = JSON.parse(JSON.stringify(d));
      }
      // the GGUF files of the text and general models: <name>-egitim-<job>-<q>.gguf -> -trained-
      for (const k of ['gguf', 'mmproj']) {
        if (typeof r[k] !== 'string' || !r[k].includes('-egitim-')) continue;
        const name = r[k].replace('-egitim-', '-trained-');
        renameIfThere(join(aiRoot, 'llm', 'models', r[k]), join(aiRoot, 'llm', 'models', name));
        r[k] = name;
      }
      return r;
    });
    writeFileSync(join(models, 'registry.json'), JSON.stringify(fresh, null, 1));
    renameSync(old, join(models, 'registry-before-20261009.json'));
    n += fresh.length;
  }
  if (existsSync(models)) {
    for (const d of readdirSync(models, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = join(models, d.name);
      for (const [from, to] of [['egitim.json', 'training.json'], ['kisaltmalar.json', 'abbreviations.json'], ['nokta.pt', 'checkpoint.pt'], ['kayiplar.json', 'losses.json'], ['egitim', 'training'], ['onbellek', 'cache'], ['veri.toml', 'dataset.toml']]) {
        if (renameIfThere(join(f, from), join(f, to))) n += 1;
      }
    }
  }
  if (n) log(`migrated the trained models (${n} records and files)`);
  return n > 0;
}

/** panel.db and the job.json copies, downloads.json (+ the half downloaded files), settings.json, trained models. */
function migrateValues({ dataRoot, outputRoot, aiRoot, modelRoot }, log) {
  let changed = false;
  const db = join(dataRoot, DATA_FILES.database);
  if (existsSync(db)) {
    const d = new DatabaseSync(db);
    try {
      const tables = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      if (tables.has('jobs')) {
        const upd = d.prepare('UPDATE jobs SET status = ?, record = ? WHERE id = ?');
        let n = 0;
        d.exec('BEGIN');
        for (const r of d.prepare('SELECT id, status, record FROM jobs').all()) {
          let record;
          try {
            record = JSON.parse(r.record);
          } catch {
            continue;
          }
          const fresh = JSON.stringify(migrateJobValues(record));
          const status = STATUS_VALUES[r.status] ?? r.status;
          if (fresh === JSON.stringify(record) && status === r.status) continue;
          upd.run(status, fresh, r.id);
          n += 1;
        }
        d.exec('COMMIT');
        if (n) log(`migrated the values of ${n} job records`);
        changed = changed || n > 0;
      }
    } finally {
      d.close();
    }
  }
  if (existsSync(outputRoot)) {
    for (const folder of readdirSync(outputRoot)) {
      const path = join(outputRoot, folder, 'job.json');
      if (!existsSync(path)) continue;
      try {
        const before = JSON.parse(readFileSync(path, 'utf8'));
        const fresh = migrateJobValues(before);
        if (JSON.stringify(fresh) !== JSON.stringify(before)) writeFileSync(path, JSON.stringify(fresh, null, 2));
      } catch {}
    }
  }
  const downloads = join(dataRoot, DATA_FILES.downloads);
  if (existsSync(downloads)) {
    try {
      const list = JSON.parse(readFileSync(downloads, 'utf8'));
      if (Array.isArray(list) && list.some((i) => STATUS_VALUES[i?.status])) {
        for (const i of list) {
          if (!STATUS_VALUES[i?.status]) continue;
          i.status = STATUS_VALUES[i.status];
          if (modelRoot && i.folder && i.file) renameIfThere(join(modelRoot, i.folder, `${i.file}.indiriliyor`), join(modelRoot, i.folder, `${i.file}.downloading`));
        }
        writeFileSync(downloads, JSON.stringify(list, null, 1));
        log('migrated the download states');
        changed = true;
      }
    } catch {}
  }
  const settings = join(dataRoot, DATA_FILES.settings);
  if (existsSync(settings)) {
    try {
      const s = JSON.parse(readFileSync(settings, 'utf8'));
      let touched = false;
      if (s.fineSettings && 'trainingYazi4bit' in s.fineSettings) {
        s.fineSettings.trainingText4bit = s.fineSettings.trainingYazi4bit;
        delete s.fineSettings.trainingYazi4bit;
        touched = true;
      }
      if (s.deletionMethod === 'kalici') [s.deletionMethod, touched] = ['permanent', true];
      if (typeof s.textModel === 'string' && s.textModel.includes('-egitim-')) [s.textModel, touched] = [s.textModel.replace('-egitim-', '-trained-'), true];
      if (touched) {
        writeFileSync(settings, JSON.stringify(s, null, 2));
        log('migrated settings.json values');
        changed = true;
      }
    } catch {}
  }
  return migrateTrainedModels(aiRoot, log) || changed;
}

/*
 * Collected data in English (09.10.2026): data\toplanan -> data\collections, the files and media folders of every
 * collection, the media paths inside the records and the collection/<id>/<part> references of the jobs.
 */
const COLLECTION_FILES = { 'yazilar.jsonl': 'articles.jsonl', 'gorseller.jsonl': 'images.jsonl', 'videolar.jsonl': 'videos.jsonl', 'sesler.jsonl': 'audio.jsonl', 'ozet.json': 'summary.json', 'site-kuyrugu.json': 'site-queue.json', 'site-kuyrugu.json.bak': 'site-queue.json.bak', 'denenen.txt': 'tried.txt', 'betimler.jsonl': 'captions.jsonl', medya: 'media' };
const TRAINING_PARTS = { meta: 'meta', ceviri: 'translation', yaz: 'write', ozet: 'summary', baslik: 'title', soru: 'question', siniflama: 'classification', gorsel: 'image' };
const MEDIA_DIRS = { gorseller: 'images', videolar: 'videos', sesler: 'audio' };
// collection/<id>/<part> in job inputs; the keys of summary.json "files"
const COLLECTION_PARTS = { yazilar: 'articles', gorseller: 'images', videolar: 'videos', sesler: 'audio', voices: 'audio', betimler: 'captions', ...Object.fromEntries(Object.entries(TRAINING_PARTS).map(([k, v]) => [`egitim-${k}`, `training-${v}`])) };
const SUMMARY_FILES = { yazilar: 'articles', gorseller: 'images', videolar: 'videos', sesler: 'audio', ...Object.fromEntries(Object.entries(TRAINING_PARTS).map(([k, v]) => [`egitim-${k}`, `training-${v}`])) };
const mediaPath = (file) => (typeof file === 'string' ? file.replace(/^medya\/(gorseller|videolar|sesler)\//, (_, d) => `media/${MEDIA_DIRS[d]}/`) : file);

/** collection/<id>/<old part> -> the new part, in any string of a job record. */
export function migrateCollectionRefs(value) {
  if (Array.isArray(value)) return value.map(migrateCollectionRefs);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, migrateCollectionRefs(v)]));
  if (typeof value !== 'string') return value;
  const m = /^collection\/([^/]+)\/([\w-]+)$/.exec(value);
  return m && COLLECTION_PARTS[m[2]] ? `collection/${m[1]}/${COLLECTION_PARTS[m[2]]}` : value;
}

function migrateCollectionNames({ dataRoot, outputRoot, aiRoot }, log) {
  const old = join(aiRoot, 'data', 'toplanan');
  const root = join(aiRoot, 'data', 'collections');
  let n = 0;
  if (existsSync(old) && !existsSync(root)) {
    renameSync(old, root);
    n += 1;
  }
  if (existsSync(root)) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const folder = join(root, d.name);
      for (const f of readdirSync(folder)) {
        const training = /^egitim-([a-z]+)(\.jsonl.*)$/.exec(f);
        const to = COLLECTION_FILES[f] ?? (training && TRAINING_PARTS[training[1]] ? `training-${TRAINING_PARTS[training[1]]}${training[2]}` : null);
        if (to && renameIfThere(join(folder, f), join(folder, to))) n += 1;
      }
      for (const [from, to] of Object.entries(MEDIA_DIRS)) if (renameIfThere(join(folder, 'media', from), join(folder, 'media', to))) n += 1;
      // the records name their downloaded file by its path in the collection
      for (const f of ['images.jsonl', 'videos.jsonl', 'audio.jsonl', 'captions.jsonl']) {
        const path = join(folder, f);
        if (!existsSync(path)) continue;
        const raw = readFileSync(path, 'utf8');
        if (!raw.includes('"medya/')) continue;
        writeFileSync(path, raw.split('\n').map((line) => {
          if (!line.includes('"medya/')) return line;
          try {
            const v = JSON.parse(line);
            return JSON.stringify({ ...v, file: mediaPath(v.file) });
          } catch {
            return line;
          }
        }).join('\n'));
        n += 1;
      }
      const summary = join(folder, 'summary.json');
      if (existsSync(summary)) {
        try {
          const s = JSON.parse(readFileSync(summary, 'utf8'));
          if (s.files && Object.keys(s.files).some((k) => SUMMARY_FILES[k])) {
            s.files = Object.fromEntries(Object.entries(s.files).map(([k, v]) => [SUMMARY_FILES[k] ?? k, v]));
            writeFileSync(summary, JSON.stringify(s, null, 1));
            n += 1;
          }
        } catch {}
      }
    }
  }
  const db = join(dataRoot, DATA_FILES.database);
  if (existsSync(db)) {
    const d = new DatabaseSync(db);
    try {
      if (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()) {
        const upd = d.prepare('UPDATE jobs SET record = ? WHERE id = ?');
        d.exec('BEGIN');
        for (const r of d.prepare('SELECT id, record FROM jobs').all()) {
          if (!r.record.includes('collection/')) continue;
          let record;
          try {
            record = JSON.parse(r.record);
          } catch {
            continue;
          }
          const fresh = JSON.stringify(migrateCollectionRefs(record));
          if (fresh === JSON.stringify(record)) continue;
          upd.run(fresh, r.id);
          n += 1;
        }
        d.exec('COMMIT');
      }
    } finally {
      d.close();
    }
  }
  if (existsSync(outputRoot)) {
    for (const folder of readdirSync(outputRoot)) {
      const path = join(outputRoot, folder, 'job.json');
      if (!existsSync(path)) continue;
      try {
        const raw = readFileSync(path, 'utf8');
        if (!raw.includes('collection/')) continue;
        const before = JSON.parse(raw);
        const fresh = migrateCollectionRefs(before);
        if (JSON.stringify(fresh) !== JSON.stringify(before)) writeFileSync(path, JSON.stringify(fresh, null, 2));
      } catch {}
    }
  }
  if (n) log(`migrated the collected data to English names (${n} folders, files and records)`);
  return n > 0;
}

/**
 * File links written inside texts by the Turkish-named versions ("/dosya/is/<id>/<file>" in a chat message, its
 * summary and search index, a job record) -> "/file/job/…"; the panel serves /file/ only.
 */
function migrateFileLinkTexts({ dataRoot, outputRoot }, log) {
  let n = 0;
  const rewrite = (path) => {
    const raw = readFileSync(path, 'utf8');
    if (!raw.includes('/dosya/')) return;
    const fresh = migrateFileLinks(raw);
    try {
      JSON.parse(fresh);
    } catch {
      return;
    }
    writeFileSync(path, fresh);
    n += 1;
  };
  const chat = join(dataRoot, DATA_FILES.chat);
  if (existsSync(chat)) for (const f of readdirSync(chat)) if (f.endsWith('.json')) rewrite(join(chat, f));
  if (existsSync(outputRoot)) {
    for (const folder of readdirSync(outputRoot)) {
      const path = join(outputRoot, folder, 'job.json');
      if (existsSync(path)) rewrite(path);
    }
  }
  const db = join(dataRoot, DATA_FILES.database);
  if (existsSync(db)) {
    const d = new DatabaseSync(db);
    try {
      const tables = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((r) => r.name));
      d.exec('BEGIN');
      if (tables.has('jobs')) {
        const upd = d.prepare('UPDATE jobs SET record = ? WHERE id = ?');
        for (const r of d.prepare("SELECT id, record FROM jobs WHERE record LIKE '%/dosya/%'").all()) {
          upd.run(migrateFileLinks(r.record), r.id);
          n += 1;
        }
      }
      if (tables.has('chats')) {
        const upd = d.prepare('UPDATE chats SET summary = ? WHERE num = ?');
        for (const r of d.prepare("SELECT num, summary FROM chats WHERE summary LIKE '%/dosya/%'").all()) {
          upd.run(migrateFileLinks(r.summary), r.num);
          n += 1;
        }
      }
      // the search index is written the way the panel writes it: the row deleted, then inserted again
      if (tables.has('chat_search')) {
        const del = d.prepare('DELETE FROM chat_search WHERE rowid = ?');
        const add = d.prepare('INSERT INTO chat_search (rowid, title, body) VALUES (?, ?, ?)');
        for (const r of d.prepare("SELECT rowid, title, body FROM chat_search WHERE title LIKE '%/dosya/%' OR body LIKE '%/dosya/%'").all()) {
          del.run(r.rowid);
          add.run(r.rowid, migrateFileLinks(r.title ?? ''), migrateFileLinks(r.body ?? ''));
          n += 1;
        }
      }
      d.exec('COMMIT');
    } finally {
      d.close();
    }
  }
  if (n) log(`migrated the old file links (/dosya/ -> /file/) in ${n} chats, records and index rows`);
  return n > 0;
}

/*
 * The first English pass read "en" in istemEn as width (09.10.2026): a job kept the prompt and style it translated once
 * under promptWidth / styleWidth, the code reads promptEnglish / styleEnglish. When a record has both, the new one stays.
 */
const JOB_KEYS = { promptWidth: 'promptEnglish', styleWidth: 'styleEnglish' };

/** A job record with the translated prompt and style under their right keys (the same object when nothing changes). */
export function migrateJobKeys(record) {
  if (!record || typeof record !== 'object' || !Object.keys(JOB_KEYS).some((k) => k in record)) return record;
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (!JOB_KEYS[k]) out[k] = v;
    else if (!(JOB_KEYS[k] in record)) out[JOB_KEYS[k]] = v;
  }
  return out;
}

/*
 * The third pass (09.10.2026): the jobs made before the English rename kept the language under "language" (the code reads
 * "lang"), and their summary line was written in Turkish ("5 sn · enstrümantal"); an English page showed it as it was.
 */
const LANG_TYPES = new Set(['clone', 'film', 'music', 'song', 'voice', 'training']);
const TURKISH_DETAIL = /[çğıöşüÇĞİÖŞÜ]|\b\d+ (sn|dk|sa)\b|\b(adet|kaynak|konu|ayıklama|kural|enstrümantal|sözlü|devir|adım|tetik|eğitimli|kayıt|parça)\b/;
const UNITS = [
  [/\b(\d+) sa (\d+) dk\b/g, '$1 h $2 min'],
  [/\b(\d+) dk (\d+) sn\b/g, '$1 min $2 s'],
  [/\b(\d+) sn\b/g, '$1 s'],
  [/\b(\d+) dk\b/g, '$1 min'],
  [/\b(\d+) parça\b/g, '$1 parts'],
];

// The stage, detail, warning and error of a job were stored in Turkish before the English rename ("Bitti", "İptal
// edildi", "Eğitim için kayıt kısa (12 sn; …)"); the dictionary read backwards gives the English the code writes now.
let backwards = null;
function dictionaryBackwards() {
  if (backwards) return backwards;
  const raw = globalThis.NedeseDictionary?.tr ?? {};
  const full = new Map();
  const patterns = [];
  for (const [en, tr] of Object.entries(raw)) {
    if (!/\{\d+\}/.test(en)) {
      if (!full.has(tr)) full.set(tr, en);
      continue;
    }
    const position = [];
    const source = tr.split(/(\{\d+\})/).map((p) => {
      const m = /^\{(\d+)\}$/.exec(p);
      if (!m) return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      position.push(m[1]);
      return '([\\s\\S]*?)';
    });
    patterns.push({ re: new RegExp(`^${source.join('')}$`), position, en, len: tr.replace(/\{\d+\}/g, '').length });
  }
  patterns.sort((a, b) => b.len - a.len);
  backwards = { keys: new Set(Object.keys(raw)), full, patterns };
  return backwards;
}

/** A stored Turkish text in English, or the text as it was (an English text, or one the dictionary does not know). */
export function englishText(text) {
  if (typeof text !== 'string' || !text.trim()) return text;
  const { keys, full, patterns } = dictionaryBackwards();
  // an English text that reads like a translation ("GPU", "LoRA") stays
  if (keys.has(text)) return text;
  if (full.has(text)) return full.get(text);
  if (!/[çğıöşüÇĞİÖŞÜ]|\b\d+ (sn|dk|sa)\b/.test(text)) return text;
  for (const k of patterns) {
    const m = k.re.exec(text);
    if (!m) continue;
    const values = {};
    k.position.forEach((no, i) => {
      values[no] = englishText(m[i + 1]);
    });
    return k.en.replace(/\{(\d+)\}/g, (_, no) => values[no] ?? '');
  }
  return text;
}

/**
 * A job record with the values of the third pass and its summary line in English: written again from the input by the
 * type's summary() (summaries: { type: summary }), or, when that cannot read the old input, with the units translated.
 * The stored stage, progress detail, warning and error come back from the dictionary.
 */
export function migrateJobRecord(record, summaries = {}) {
  const out = migrateJobSummary(record, summaries);
  if (!out || typeof out !== 'object') return out;
  const progress = out.progress && typeof out.progress === 'object' ? { ...out.progress } : out.progress;
  for (const k of ['stage', 'detail', 'lastStage']) if (progress && k in progress) progress[k] = englishText(progress[k]);
  const fresh = { ...out, progress, warning: englishText(out.warning), error: englishText(out.error) };
  for (const k of ['progress', 'warning', 'error']) if (!(k in out)) delete fresh[k];
  return ['progress', 'warning', 'error'].some((k) => JSON.stringify(fresh[k]) !== JSON.stringify(out[k])) ? fresh : out;
}

function migrateJobSummary(record, summaries) {
  if (!record || typeof record !== 'object') return record;
  const out = migrateJobValues(record);
  if (LANG_TYPES.has(out.type) && out.input && 'language' in out.input) {
    const { language, ...rest } = out.input;
    out.input = 'lang' in rest ? rest : { ...rest, lang: language };
  }
  const detail = out.summary?.detail;
  if (typeof detail !== 'string' || !TURKISH_DETAIL.test(detail)) return out;
  let fresh = null;
  try {
    fresh = summaries[out.type]?.(out.input ?? {})?.detail ?? null;
  } catch {}
  if (typeof fresh !== 'string' || !fresh.trim() || /undefined|NaN|\[object/.test(fresh)) fresh = UNITS.reduce((t, [re, to]) => t.replace(re, to), detail);
  // a clone whose recording was too short for training said so after the run
  else if (out.type === 'clone' && detail.includes('hızlı klon')) fresh = fresh.replace(' · trained', ' · quick clone (recording too short)');
  return { ...out, summary: { ...out.summary, detail: fresh } };
}

function migrateJobRecords({ dataRoot, outputRoot, summaries }, log) {
  let n = 0;
  const db = join(dataRoot, DATA_FILES.database);
  if (existsSync(db)) {
    const d = new DatabaseSync(db);
    try {
      if (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()) {
        const upd = d.prepare('UPDATE jobs SET record = ? WHERE id = ?');
        d.exec('BEGIN');
        for (const r of d.prepare('SELECT id, record FROM jobs').all()) {
          let record;
          try {
            record = JSON.parse(r.record);
          } catch {
            continue;
          }
          const fresh = JSON.stringify(migrateJobRecord(record, summaries));
          if (fresh === r.record || fresh === JSON.stringify(record)) continue;
          upd.run(fresh, r.id);
          n += 1;
        }
        d.exec('COMMIT');
      }
    } finally {
      d.close();
    }
  }
  if (existsSync(outputRoot)) {
    for (const folder of readdirSync(outputRoot)) {
      const path = join(outputRoot, folder, 'job.json');
      if (!existsSync(path)) continue;
      try {
        const before = JSON.parse(readFileSync(path, 'utf8'));
        const fresh = migrateJobRecord(before, summaries);
        if (JSON.stringify(fresh) !== JSON.stringify(before)) writeFileSync(path, JSON.stringify(fresh, null, 2));
      } catch {}
    }
  }
  if (n) log(`migrated the language key, the summary line and the stage of ${n} job records`);
  return n > 0;
}

function migrateJobKeyNames({ dataRoot, outputRoot }, log) {
  let n = 0;
  const db = join(dataRoot, DATA_FILES.database);
  if (existsSync(db)) {
    const d = new DatabaseSync(db);
    try {
      if (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()) {
        const upd = d.prepare('UPDATE jobs SET record = ? WHERE id = ?');
        d.exec('BEGIN');
        for (const r of d.prepare(`SELECT id, record FROM jobs WHERE record LIKE '%"promptWidth"%' OR record LIKE '%"styleWidth"%'`).all()) {
          let record;
          try {
            record = JSON.parse(r.record);
          } catch {
            continue;
          }
          const fresh = migrateJobKeys(record);
          if (fresh === record) continue;
          upd.run(JSON.stringify(fresh), r.id);
          n += 1;
        }
        d.exec('COMMIT');
      }
    } finally {
      d.close();
    }
  }
  if (existsSync(outputRoot)) {
    for (const folder of readdirSync(outputRoot)) {
      const path = join(outputRoot, folder, 'job.json');
      if (!existsSync(path)) continue;
      try {
        const raw = readFileSync(path, 'utf8');
        if (!raw.includes('"promptWidth"') && !raw.includes('"styleWidth"')) continue;
        const before = JSON.parse(raw);
        const fresh = migrateJobKeys(before);
        if (fresh === before) continue;
        writeFileSync(path, JSON.stringify(fresh, null, 2));
        n += 1;
      } catch {}
    }
  }
  if (n) log(`migrated the translated prompt and style keys of ${n} job records`);
  return n > 0;
}

/*
 * The data collection in English (09.10.2026): data jobs kept their input, counters and file counts under the old keys
 * (skipSite, ceviriPairs, articleNot, files.texts …), a film its outputs as "altyazi" / "sahne", and the collected records
 * their old fields and values (sub, cevap, word, "video-etiketi", "[e-posta]" …); the code reads the new ones.
 */
const DATA_INPUT_KEYS = { skipSite: 'hopSites', ceviriPairs: 'translationPairs', personalDataMaskOut: 'maskPersonalData', onlyFields: 'onlyDomains', blockedFields: 'blockedDomains' };
const DATA_COUNTERS = { articleNot: 'notArticle', topicExternal: 'offTopic', fieldExternal: 'blockedDomain', modelConnection: 'modelLinks', management: 'managerRounds', wikiExternal: 'wikiNonContent', searchTopicExternal: 'offTopicResults', frontElimination: 'prefiltered', ceviri: 'translation', voice: 'audio' };
const DATA_FILE_COUNTS = { ...SUMMARY_FILES, texts: 'articles', voices: 'audio' };
const OUTPUT_TYPES = { altyazi: 'subtitle', sahne: 'scene' };
const RECORD_KEYS = { sub: 'alt', subtitle: 'caption', writer: 'author', update: 'modified', word: 'words', gathering: 'collectedAt', smallPicture: 'thumbnail' };
const RECORD_VALUES = { sourceType: { 'video-etiketi': 'video-tag', 'audio-etiketi': 'audio-tag', gomulu: 'embed', 'besleme-eki': 'feed-attachment' }, extraction: { kural: 'rule' }, method: { tarayici: 'browser' } };
const SUMMARY_KEYS = { avgWord: 'avgWords', metaBeing: 'withMetaDescription', ceviriGroups: 'translationGroups', sonIs: 'lastJob' };
const MASKS = [['[e-posta]', '[email]'], ['[telefon]', '[phone]'], ['[kimlik-no]', '[id-number]']];
const unmask = (s) => MASKS.reduce((t, [from, to]) => t.split(from).join(to), s);
// an old key takes the new name in its place; when the new one is there already, the old one goes
const renameKeys = (o, names) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (!names[k]) out[k] = v;
    else if (!(names[k] in o)) out[names[k]] = v;
  }
  return out;
};
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A job record with the data collection keys and the output types of 09.10.2026 (the same object when nothing changes). */
export function migrateDataJob(record) {
  if (!isObject(record)) return record;
  let out = record;
  if (record.type === 'data') {
    out = renameKeys(record, { pathDoesNotGive: 'noYield' });
    if (isObject(out.input)) out.input = renameKeys(out.input, DATA_INPUT_KEYS);
  }
  if (Array.isArray(out.outputs)) {
    out = {
      ...out,
      outputs: out.outputs.map((o) => {
        if (!isObject(o)) return o;
        let c = OUTPUT_TYPES[o.type] ? { ...o, type: OUTPUT_TYPES[o.type] } : o;
        if (record.type === 'data' && 'collection' in c) {
          c = renameKeys(c, DATA_COUNTERS);
          if (isObject(c.files)) c.files = renameKeys(c.files, DATA_FILE_COUNTS);
          if (typeof c.folder === 'string') c.folder = c.folder.replace(/([\\/])(?:veri|data)([\\/])toplanan([\\/])/, '$1data$2collections$3');
        }
        return c;
      }),
    };
  }
  return JSON.stringify(out) === JSON.stringify(record) ? record : out;
}

/** A collected record (kind: articles, images, videos, audio) with the fields and values of 09.10.2026. */
export function migrateCollectedRecord(record, kind) {
  if (!isObject(record)) return record;
  const out = renameKeys(record, kind === 'articles' ? { ...RECORD_KEYS, summary: 'digest' } : RECORD_KEYS);
  for (const [k, values] of Object.entries(RECORD_VALUES)) if (values[out[k]]) out[k] = values[out[k]];
  if (isObject(out.media)) out.media = renameKeys(out.media, { voice: 'audio' });
  if (Array.isArray(out.questionAnswers)) out.questionAnswers = out.questionAnswers.map((q) => (isObject(q) ? renameKeys(q, { cevap: 'answer' }) : q));
  for (const k of ['text', 'summarySentence', 'metaDescription', 'title', 'description']) if (typeof out[k] === 'string' && out[k].includes('[')) out[k] = unmask(out[k]);
  return JSON.stringify(out) === JSON.stringify(record) ? record : out;
}

function migrateDataKeys({ dataRoot, outputRoot, aiRoot }, log) {
  let n = 0;
  const db = join(dataRoot, DATA_FILES.database);
  if (existsSync(db)) {
    const d = new DatabaseSync(db);
    try {
      if (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()) {
        const upd = d.prepare('UPDATE jobs SET record = ? WHERE id = ?');
        d.exec('BEGIN');
        for (const r of d.prepare("SELECT id, record FROM jobs WHERE type = 'data' OR record LIKE '%\"altyazi\"%' OR record LIKE '%\"sahne\"%'").all()) {
          let record;
          try {
            record = JSON.parse(r.record);
          } catch {
            continue;
          }
          const fresh = migrateDataJob(record);
          if (fresh === record) continue;
          upd.run(JSON.stringify(fresh), r.id);
          n += 1;
        }
        d.exec('COMMIT');
      }
    } finally {
      d.close();
    }
  }
  if (existsSync(outputRoot)) {
    for (const folder of readdirSync(outputRoot)) {
      const path = join(outputRoot, folder, 'job.json');
      if (!existsSync(path)) continue;
      try {
        const before = JSON.parse(readFileSync(path, 'utf8'));
        const fresh = migrateDataJob(before);
        if (fresh !== before) writeFileSync(path, JSON.stringify(fresh, null, 2));
      } catch {}
    }
  }
  const root = join(aiRoot, 'data', 'collections');
  if (existsSync(root)) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const folder = join(root, d.name);
      for (const f of readdirSync(folder)) {
        const path = join(folder, f);
        const kind = /^(articles|images|videos|audio)\.jsonl$/.exec(f)?.[1];
        if (kind) {
          let changed = false;
          const lines = readFileSync(path, 'utf8').split('\n').map((line) => {
            if (!line.trim()) return line;
            try {
              const before = JSON.parse(line);
              const fresh = migrateCollectedRecord(before, kind);
              if (fresh === before) return line;
              changed = true;
              return JSON.stringify(fresh);
            } catch {
              return line;
            }
          });
          if (!changed) continue;
          writeFileSync(`${path}.tmp`, lines.join('\n'));
          renameSync(`${path}.tmp`, path);
          n += 1;
        } else if (/^training-[\w-]+\.jsonl$/.test(f)) {
          // the ready-to-train files carry the masked text as it was collected
          const raw = readFileSync(path, 'utf8');
          const fresh = unmask(raw);
          if (fresh === raw) continue;
          writeFileSync(`${path}.tmp`, fresh);
          renameSync(`${path}.tmp`, path);
          n += 1;
        } else if (f === 'summary.json') {
          try {
            const before = JSON.parse(readFileSync(path, 'utf8'));
            const fresh = renameKeys(before, SUMMARY_KEYS);
            if (isObject(fresh.files)) fresh.files = renameKeys(fresh.files, DATA_FILE_COUNTS);
            if (JSON.stringify(fresh) === JSON.stringify(before)) continue;
            writeFileSync(path, JSON.stringify(fresh, null, 1));
            n += 1;
          } catch {}
        }
      }
    }
  }
  if (n) log(`migrated the data collection keys of ${n} job records and collected files`);
  return n > 0;
}

// The duration measurement keys the Turkish-named versions wrote (the queue's averages and time estimates read them)
const MEASUREMENT_KEYS = { duzenle: 'edit', muzik: 'music', 'sahne-yaz': 'write-scenes', 'ses/hizli': 'voice/fast', 'ses/denetimli': 'voice/checked','voice/denetimli': 'voice/checked', 'video/anahtar': 'video/key', 'model3d/hizli': 'model3d/fast' };
const MEASUREMENT_PREFIXES = [['gorsel/', 'image/'], ['video/dudak/', 'video/lip/']];

function measurementKey(key) {
  if (MEASUREMENT_KEYS[key]) return MEASUREMENT_KEYS[key];
  for (const [old, fresh] of MEASUREMENT_PREFIXES) if (key.startsWith(old)) return fresh + key.slice(old.length);
  return key;
}

/** panel.db measurements: the old keys renamed, so their values join the new key's median. */
function migrateMeasurementKeys(dataRoot, log) {
  const path = join(dataRoot, DATA_FILES.database);
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path);
  let n = 0;
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'measurements'").get()) return false;
    const rename = db.prepare('UPDATE measurements SET key = ? WHERE key = ?');
    db.exec('BEGIN');
    for (const { key } of db.prepare('SELECT DISTINCT key FROM measurements').all()) {
      const fresh = measurementKey(key);
      if (fresh !== key) n += Number(rename.run(fresh, key).changes);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  if (n) log(`migrated ${n} duration measurements to English keys`);
  return n > 0;
}

/*
 * A chat message kept its tool outputs under "ek" (09.10.2026: "extra"); the chat folder kept the lasting notes in
 * hafiza.md and the schedules in zamanlamalar.json (memory.md, schedules.json). A message with both keeps the new one.
 */
function migrateChatFiles(dataRoot, log) {
  const chat = join(dataRoot, DATA_FILES.chat);
  if (!existsSync(chat)) return false;
  let n = 0;
  for (const [old, fresh] of [['hafiza.md', 'memory.md'], ['zamanlamalar.json', 'schedules.json']]) {
    if (existsSync(join(chat, old)) && !existsSync(join(chat, fresh))) {
      renameSync(join(chat, old), join(chat, fresh));
      n += 1;
    }
  }
  for (const f of readdirSync(chat)) {
    if (!f.endsWith('.json')) continue;
    const path = join(chat, f);
    let session;
    try {
      session = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(session?.messages) || !session.messages.some((m) => m && 'ek' in m)) continue;
    for (const m of session.messages) {
      if (!m || !('ek' in m)) continue;
      if (!('extra' in m)) m.extra = m.ek;
      delete m.ek;
    }
    writeFileSync(path, JSON.stringify(session));
    n += 1;
  }
  if (n) log(`migrated ${n} chat files to English names (ek -> extra, memory.md, schedules.json)`);
  return n > 0;
}

/*
 * The saved plan of an audio/video edit job (a retry runs it again) keeps the operation, field and value names of the
 * prompt (09.10.2026): the Turkish names of the first plans and the word-for-word English of 08.10 (translate = flip,
 * truncate = crop, login/exit = fade in/out, parent/sub = top/bottom ...).
 */
const EDIT_OPERATIONS = {
  kes: 'cut', hiz: 'speed', perde: 'pitch', temizle: 'clean', sessizlik: 'trimSilence', seviye: 'normalize', ses: 'volume', yanki: 'echo', solma: 'fade',
  sesDegistir: 'changeVoice', dondur: 'rotate', cevir: 'flip', kirp: 'crop', olcek: 'scale', sesKapat: 'mute', yazi: 'text', renk: 'color',
  siyahBeyaz: 'blackWhite', ters: 'reverse', muzik: 'music',
  silence: 'trimSilence', level: 'normalize', voice: 'volume', translate: 'flip', truncate: 'crop', closeVoice: 'mute',
};
const EDIT_FIELDS = {
  startedAt: 'start', last: 'end', login: 'in', exit: 'out', partialTone: 'semitones',
  bas: 'start', son: 'end', giris: 'in', cikis: 'out', yarimTon: 'semitones', oran: 'ratio', carpan: 'factor', miktar: 'amount', derece: 'degree',
  yon: 'direction', yukseklik: 'height', metin: 'text', konum: 'position', parlaklik: 'brightness', kontrast: 'contrast', doygunluk: 'saturation',
  deger: 'value', seviye: 'level', ses: 'voice',
};
const EDIT_VALUES = {
  direction: { landscape: 'horizontal', portrait: 'vertical', yatay: 'horizontal', dikey: 'vertical' },
  position: { parent: 'top', sub: 'bottom', ust: 'top', orta: 'middle', alt: 'bottom' },
  level: { hafif: 'light', orta: 'middle', belirgin: 'distinct' },
};

/** A job record with its edit plan in the prompt's names; the same object when nothing changes. */
export function migrateEditPlan(record) {
  const steps = record?.plan?.steps;
  if (!Array.isArray(steps)) return record;
  let changed = false;
  const fresh = steps.map((step) => {
    if (!step || typeof step !== 'object') return step;
    const out = {};
    for (const [key, value] of Object.entries(step)) {
      const name = key === 'operation' ? key : (EDIT_FIELDS[key] ?? key);
      let v = key === 'operation' ? (EDIT_OPERATIONS[value] ?? value) : value;
      if (typeof v === 'string' && EDIT_VALUES[name]?.[v]) v = EDIT_VALUES[name][v];
      if (name !== key || v !== value) changed = true;
      if (!(name in out) || name === key) out[name] = v;
    }
    return out;
  });
  return changed ? { ...record, plan: { ...record.plan, steps: fresh } } : record;
}

function migrateEditPlans({ dataRoot, outputRoot }, log) {
  let n = 0;
  const db = join(dataRoot, DATA_FILES.database);
  if (existsSync(db)) {
    const d = new DatabaseSync(db);
    try {
      if (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()) {
        const upd = d.prepare('UPDATE jobs SET record = ? WHERE id = ?');
        d.exec('BEGIN');
        for (const r of d.prepare("SELECT id, record FROM jobs WHERE record LIKE '%\"plan\"%'").all()) {
          let record;
          try {
            record = JSON.parse(r.record);
          } catch {
            continue;
          }
          const fresh = migrateEditPlan(record);
          if (fresh === record) continue;
          upd.run(JSON.stringify(fresh), r.id);
          n += 1;
        }
        d.exec('COMMIT');
      }
    } finally {
      d.close();
    }
  }
  if (existsSync(outputRoot)) {
    for (const folder of readdirSync(outputRoot)) {
      const path = join(outputRoot, folder, 'job.json');
      if (!existsSync(path)) continue;
      try {
        const before = JSON.parse(readFileSync(path, 'utf8'));
        const fresh = migrateEditPlan(before);
        if (fresh !== before) writeFileSync(path, JSON.stringify(fresh, null, 1));
      } catch {}
    }
  }
  if (n) log(`migrated ${n} edit plans to the prompt's names`);
  return n > 0;
}

/* The updater wrote the installed version to <ai>\surum.json (09.10.2026: version.json). */
function migrateVersionFile(aiRoot, log) {
  const [old, fresh] = [join(aiRoot, 'surum.json'), join(aiRoot, 'version.json')];
  if (!existsSync(old) || existsSync(fresh)) return false;
  renameSync(old, fresh);
  log('migrated the installed version file (surum.json -> version.json)');
  return true;
}

/**
 * Runs every migration once. dataRoot: panel-data; outputRoot: outputs; aiRoot: install root; modelRoot: the models.
 * Safe to call on a fresh install (nothing to do). Each step has its own mark in migration.json: a step added later
 * (LATER_STEPS, 09.10.2026) runs once on an install the first steps already migrated. summaries: { job type: its
 * summary(input) } for the summary lines.
 */
const LATER_STEPS = ['voiceLibrary', 'collections', 'values', 'collectionNames', 'fileLinks', 'jobKeys', 'jobRecords', 'jobProgress', 'dataKeys', 'measurementKeys', 'chatFiles', 'editPlans', 'versionFile'];

export function migrateLegacyData({ dataRoot, outputRoot, aiRoot, modelRoot = join(aiRoot, 'models'), voiceLibrary = join(aiRoot, 'voice', 'references'), summaries = {}, log = () => {} }) {
  const marker = join(dataRoot, DATA_FILES.migration);
  let done = {};
  try {
    done = JSON.parse(readFileSync(marker, 'utf8'));
  } catch {}
  const now = new Date().toISOString();
  let changed = false;
  const later = () => {
    if (!done.voiceLibrary) changed = migrateVoiceLibrary(voiceLibrary, log) || changed;
    if (!done.collections) changed = migrateCollections(join(aiRoot, 'data', 'toplanan'), log) || changed;
    if (!done.values) changed = migrateValues({ dataRoot, outputRoot, aiRoot, modelRoot }, log) || changed;
    if (!done.collectionNames) changed = migrateCollectionNames({ dataRoot, outputRoot, aiRoot }, log) || changed;
    if (!done.fileLinks) changed = migrateFileLinkTexts({ dataRoot, outputRoot }, log) || changed;
    if (!done.jobKeys) changed = migrateJobKeyNames({ dataRoot, outputRoot }, log) || changed;
    if (!done.jobRecords || !done.jobProgress) changed = migrateJobRecords({ dataRoot, outputRoot, summaries }, log) || changed;
    if (!done.dataKeys) changed = migrateDataKeys({ dataRoot, outputRoot, aiRoot }, log) || changed;
    if (!done.measurementKeys) changed = migrateMeasurementKeys(dataRoot, log) || changed;
    if (!done.chatFiles) changed = migrateChatFiles(dataRoot, log) || changed;
    if (!done.editPlans) changed = migrateEditPlans({ dataRoot, outputRoot }, log) || changed;
    if (!done.versionFile) changed = migrateVersionFile(aiRoot, log) || changed;
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(marker, JSON.stringify({ ...done, english: done.english ?? now, ...Object.fromEntries(LATER_STEPS.map((k) => [k, done[k] ?? now])) }, null, 2));
    return changed;
  };
  if (done.english) return LATER_STEPS.every((k) => done[k]) ? false : later();
  const L = LEGACY_DATA_FILES;
  for (const f of [L.settings, L.downloads, L.sessions]) changed = migrateJsonFile(join(dataRoot, f), log) || changed;
  for (const key of ['settings', 'downloads', 'sessions', 'chat']) {
    const [old, fresh] = [L[key], DATA_FILES[key]];
    if (existsSync(join(dataRoot, old)) && !existsSync(join(dataRoot, fresh))) {
      renameSync(join(dataRoot, old), join(dataRoot, fresh));
      changed = true;
    }
  }
  const chat = join(dataRoot, DATA_FILES.chat);
  if (existsSync(chat)) for (const f of readdirSync(chat)) if (f.endsWith('.json')) changed = migrateJsonFile(join(chat, f), log) || changed;
  changed = migrateDatabase(join(dataRoot, DATA_FILES.database), log) || changed;
  if (existsSync(outputRoot)) {
    let n = 0;
    for (const d of readdirSync(outputRoot)) {
      const old = join(outputRoot, d, 'is.json');
      if (!existsSync(old)) continue;
      migrateJsonFile(old, () => {});
      if (!existsSync(join(outputRoot, d, 'job.json'))) renameSync(old, join(outputRoot, d, 'job.json'));
      n += 1;
    }
    if (n) {
      log(`migrated ${n} job folders (is.json -> job.json)`);
      changed = true;
    }
  }
  const trainingRecord = join(aiRoot, 'training', 'models', 'kayit.json');
  if (existsSync(trainingRecord)) changed = migrateJsonFile(trainingRecord, log) || changed;
  // a fresh install has no panel-data yet (later() makes it)
  return later();
}
