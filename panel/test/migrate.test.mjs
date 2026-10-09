/**
 * Legacy (Turkish-named) data migration: an install written by the old version must open in the new one.
 *   node --test panel/test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateLegacyData, migrateObject, migrateJobRecord, englishText, migrateCollectedRecord } from '../lib/migrate.mjs';
import { translate } from '../lib/language.mjs';
import * as videoJob from '../lib/jobs/video.mjs';
import * as musicJob from '../lib/jobs/music.mjs';
import * as cloneJob from '../lib/jobs/clone.mjs';
import * as songJob from '../lib/jobs/song.mjs';
import * as voiceJob from '../lib/jobs/voice.mjs';
import * as describeJob from '../lib/jobs/describe.mjs';
import * as model3dJob from '../lib/jobs/model3d.mjs';
import * as videoEditJob from '../lib/jobs/video-edit.mjs';
import { Database } from '../lib/database.mjs';
import { listVoices, voiceInfo } from '../lib/voices.mjs';
import { collections, summary as dataSummary } from '../lib/jobs/data.mjs';
import { collectionMedia } from '../lib/jobs/training.mjs';
import { makeWav } from '../lib/media.mjs';

// schema of the old version (before the rename), as it created panel.db
const OLD_SCHEMA = `
  CREATE TABLE meta (anahtar TEXT PRIMARY KEY, deger TEXT);
  CREATE TABLE isler (id TEXT PRIMARY KEY, tur TEXT NOT NULL, durum TEXT NOT NULL, olusturma TEXT NOT NULL, sira TEXT NOT NULL, kayit TEXT NOT NULL);
  CREATE INDEX isler_olusturma ON isler (olusturma DESC);
  CREATE INDEX isler_tur ON isler (tur, olusturma DESC);
  CREATE INDEX isler_durum ON isler (durum, olusturma DESC);
  CREATE TABLE olcumler (id INTEGER PRIMARY KEY AUTOINCREMENT, anahtar TEXT NOT NULL, deger REAL NOT NULL, is_id TEXT);
  CREATE INDEX olcumler_anahtar ON olcumler (anahtar, id DESC);
  CREATE TABLE yuklemeler (dosya TEXT PRIMARY KEY, tur TEXT NOT NULL, ad TEXT, boyut INTEGER, en INTEGER, boy INTEGER, olusturma TEXT NOT NULL);
  CREATE INDEX yuklemeler_olusturma ON yuklemeler (olusturma DESC);
`;

test('migration: an old-version install opens with the new database and file names', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const outputRoot = join(root, 'outputs');
  mkdirSync(join(dataRoot, 'sohbet'), { recursive: true });
  mkdirSync(join(outputRoot, '20261001-120000-gorsel-ab12'), { recursive: true });
  try {
    const old = new DatabaseSync(join(dataRoot, 'panel.db'));
    old.exec(OLD_SCHEMA);
    old.prepare('INSERT INTO meta (anahtar, deger) VALUES (?, ?)').run('surum', '1');
    const record = { id: '20261001-120000-gorsel-ab12', tur: 'gorsel', durum: 'bitti', olusturma: '2026-10-01T12:00:00.000Z', ciktilar: [] };
    old.prepare('INSERT INTO isler VALUES (?, ?, ?, ?, ?, ?)').run(record.id, 'gorsel', 'bitti', record.olusturma, record.olusturma, JSON.stringify(record));
    old.prepare('INSERT INTO olcumler (anahtar, deger, is_id) VALUES (?, ?, ?)').run('gorsel', 12.5, record.id);
    old.prepare('INSERT INTO yuklemeler VALUES (?, ?, ?, ?, ?, ?, ?)').run('a.png', 'gorsel', 'a.png', 10, 64, 64, '2026-10-01T11:00:00.000Z');
    old.close();
    writeFileSync(join(outputRoot, record.id, 'is.json'), JSON.stringify(record));
    writeFileSync(join(dataRoot, 'ayar.json'), JSON.stringify({ port: 1165 }));
    writeFileSync(join(dataRoot, 'sohbet', 'x.json'), JSON.stringify({ id: 'x', mesajlar: [] }));

    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), true);

    // the new code opens the migrated database (fails with "no such column" if a column name differs)
    const db = new Database(join(dataRoot, 'panel.db'));
    try {
      assert.equal(db.jobCount(), 1);
      const q = db.jobQuery({ statuses: ['done'] });
      assert.deepEqual(q.ids, [record.id]);
      const job = db.jobs()[0];
      assert.equal(job.type, 'image');
      assert.equal(job.status, 'done');
      assert.equal(job.creation, record.olusturma);
      assert.equal(db.uploadCount(), 1);
      assert.equal(db.uploads()[0].creation, '2026-10-01T11:00:00.000Z');
    } finally {
      db.close();
    }
    const indexes = (() => {
      const raw = new DatabaseSync(join(dataRoot, 'panel.db'));
      const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      raw.close();
      return names;
    })();
    assert.deepEqual(indexes.filter((n) => /isler|olcumler|yuklemeler/.test(n)), [], 'no index keeps an old name');

    assert.ok(existsSync(join(dataRoot, 'settings.json')) && !existsSync(join(dataRoot, 'ayar.json')));
    assert.ok(existsSync(join(dataRoot, 'chat', 'x.json')));
    const jobFile = JSON.parse(readFileSync(join(outputRoot, record.id, 'job.json'), 'utf8'));
    assert.equal(jobFile.status, 'done');
    // runs once
    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), false);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8'))).sort(), ['chatFiles', 'collectionNames', 'collections', 'dataKeys', 'editPlans', 'english', 'fileLinks', 'jobKeys', 'jobProgress', 'jobRecords', 'measurementKeys', 'values', 'versionFile', 'voiceLibrary']);
    // a fresh install (no panel-data yet) starts without error
    const fresh = join(root, 'fresh');
    assert.equal(migrateLegacyData({ dataRoot: join(fresh, 'panel-data'), outputRoot: join(fresh, 'outputs'), aiRoot: fresh }), false);
    assert.ok(existsSync(join(fresh, 'panel-data', 'migration.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 09.10.2026: the first migration missed the voice library and the collected data; an install it already migrated
 * (migration.json has only "english") gets them once on the next start.
 */
test('migration: the voice library and the collected data of an install migrated before them', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const library = join(root, 'voice', 'references');
  const collection = join(root, 'data', 'toplanan', 'osmanli');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(library, { recursive: true });
  mkdirSync(collection, { recursive: true });
  try {
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify({ english: '2026-10-08T05:55:39.623Z' }));
    writeFileSync(join(library, 'ema.json'), JSON.stringify({ ad: 'EMA Lightning (kadın)', aciklama: 'tek ses', tarif: 'Turkish adult female voice', motor: 'ema', cinsiyet: 'kadin', yas: 'yetiskin', olusturma: '2026-10-07T10:48:46Z', panel: 1 }));
    writeFileSync(join(library, 'pamuk.json'), JSON.stringify({ ad: 'Pamuk', karakter: 'Pamuk', tur: 'hayvan', cinsiyet: 'kadin', yas: 'cocuk', yansiz: true, referansMetni: 'Bugün okuldan sonra parka gittim.', olcum: { tohum: 202, f0: 391.2, yas: 9.1, cocuk: 0.99, kadin: 0.01, erkek: 0, benzerlik: 0.9, puan: 3.2 } }));
    writeFileSync(join(library, 'benim.json'), JSON.stringify({ ad: 'Benim sesim', kendiSesi: true, referansMetni: 'Bu mail üzerinde.', konusmaSn: 42.7 }));
    for (const id of ['ema', 'pamuk', 'benim']) writeFileSync(join(library, `${id}.wav`), makeWav(1));
    writeFileSync(join(collection, 'ozet.json'), JSON.stringify({ ad: 'Osmanlı', konu: 'Osmanlı minyatürleri', toplam: 34, diller: { tr: 33 }, kategoriler: { tarih: 1, 'kültür-sanat': 12 }, dosyalar: { yazilar: 34, sesler: 2, 'egitim-soru': 18 }, istek: { istek: 10, hata: 1 }, sonGuncelleme: '2026-10-05T20:08:43.251Z' }));
    writeFileSync(join(collection, 'yazilar.jsonl'), `${JSON.stringify({ url: 'https://a.example/x', kaynak: 'arama:a.example', baslik: 'Minyatür', metin: 'Uzun yazı', dil: 'tr' })}\n${JSON.stringify({ url: 'https://a.example/y', title: 'already new', text: 'x' })}\n`);
    writeFileSync(join(collection, 'site-kuyrugu.json'), JSON.stringify({ kuyruk: [['a.example', 2, 'https://a.example/', []]] }));

    assert.equal(migrateLegacyData({ dataRoot, outputRoot: join(root, 'outputs'), aiRoot: root }), true);

    const voices = listVoices(library);
    const ema = voices.find((v) => v.id === 'ema');
    assert.deepEqual([ema.name, ema.engine, ema.gender, ema.age, ema.spec], ['EMA Lightning (kadın)', 'ema', 'female', 'adult', 'Turkish adult female voice']);
    const pamuk = voices.find((v) => v.id === 'pamuk');
    assert.deepEqual([pamuk.name, pamuk.type, pamuk.gender, pamuk.age, pamuk.neutral, pamuk.character], ['Pamuk', 'animal', 'female', 'child', true, 'Pamuk']);
    assert.deepEqual(voiceInfo(library, 'pamuk').measurement, { seed: 202, f0: 391.2, age: 9.1, child: 0.99, female: 0.01, male: 0, similarity: 0.9, score: 3.2 });
    assert.equal(voiceInfo(library, 'benim').referenceText, 'Bu mail üzerinde.');
    assert.equal(voices.find((v) => v.id === 'benim').ownVoice, true);

    const [c] = collections(root);
    assert.deepEqual([c.name, c.topic, c.total, c.languages, c.categories], ['Osmanlı', 'Osmanlı minyatürleri', 34, { tr: 33 }, { tarih: 1, 'kültür-sanat': 12 }], 'maps keyed by data keep their keys');
    assert.deepEqual(c.files.find((f) => f.name === 'articles'), { name: 'articles', count: 34 }, 'file counts are found by file name');
    // 09.10.2026: data\collections with English file names
    const moved = join(root, 'data', 'collections', 'osmanli');
    assert.ok(!existsSync(collection));
    const records = readFileSync(join(moved, 'articles.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(records[0], { url: 'https://a.example/x', source: 'arama:a.example', title: 'Minyatür', text: 'Uzun yazı', language: 'tr' });
    assert.deepEqual(records[1], { url: 'https://a.example/y', title: 'already new', text: 'x' });
    assert.deepEqual(JSON.parse(readFileSync(join(moved, 'site-queue.json'), 'utf8')), { queue: [['a.example', 2, 'https://a.example/', []]] });
    // once
    assert.equal(migrateLegacyData({ dataRoot, outputRoot: join(root, 'outputs'), aiRoot: root }), false);
    assert.equal(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8')).english, '2026-10-08T05:55:39.623Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 09.10.2026, the second English pass: enum values the first migration left in Turkish (paused, checked, scratch,
 * trained:<id>, the main output...), the download states and half files, settings.json values, the training registry
 * (kayit.json -> registry.json) with the GGUF files and the files in the model folders.
 */
test('migration: values of 09.10.2026 in job records, downloads, settings and the trained models', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const outputRoot = join(root, 'outputs');
  const models = join(root, 'training', 'models');
  try {
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(join(models, 'yazar-1', 'egitim'), { recursive: true });
    mkdirSync(join(root, 'llm', 'models'), { recursive: true });
    mkdirSync(join(root, 'models', 'checkpoints'), { recursive: true });
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify({ english: '2026-10-08T05:55:39.623Z', voiceLibrary: '2026-10-09T05:02:18.979Z', collections: '2026-10-09T05:02:18.979Z' }));
    const db = new Database(join(dataRoot, 'panel.db'));
    const film = { id: '20261009-080000-film-aa11', type: 'film', status: 'done', creation: '2026-10-09T08:00:00.000Z', input: { quality: 'denetimli', musicLevel: 'distinct' }, outputs: [{ file: 'film.mp4', type: 'video', ana: true }] };
    const training = { id: '20261009-081000-training-bb22', type: 'training', status: 'duraklatildi', pathGave: true, creation: '2026-10-09T08:10:00.000Z', input: { method: 'sifir', size: 'tooLarge', base: 'egitilmis:yazar-1' }, outputs: [] };
    const song = { id: '20261009-082000-song-cc33', type: 'song', status: 'done', creation: '2026-10-09T08:20:00.000Z', input: { strength: 'cok', lora: 'egitilmis:caz-1' }, outputs: [] };
    for (const j of [film, training, song]) db.writeJob(j);
    db.close();
    mkdirSync(join(outputRoot, film.id), { recursive: true });
    writeFileSync(join(outputRoot, film.id, 'job.json'), JSON.stringify(film));
    writeFileSync(join(dataRoot, 'downloads.json'), JSON.stringify([{ id: 'd1', folder: 'checkpoints', file: 'a.safetensors', status: 'duraklatildi' }, { id: 'd2', folder: 'checkpoints', file: 'b.safetensors', status: 'done' }]));
    writeFileSync(join(root, 'models', 'checkpoints', 'a.safetensors.indiriliyor'), 'half');
    writeFileSync(join(dataRoot, 'settings.json'), JSON.stringify({ port: 1071, textModel: 'yazar-egitim-20261005-120000-q4_k_m.gguf', fineSettings: { trainingYazi4bit: false } }));
    writeFileSync(join(models, 'kayit.json'), JSON.stringify([
      { id: 'yazar-1', name: 'Yazar', field: 'text', method: 'sifir', size: 'middle', gguf: 'yazar-egitim-20261005-120000-q4_k_m.gguf' },
      { id: 'genel-1', name: 'Genel', field: 'general', method: 'ince', gguf: 'genel-egitim-20261005-130000-q4_k_m.gguf', mmproj: 'mmproj-genel-egitim-20261005-130000-q4_k_m.gguf' },
      { id: 'caz-1', name: 'Caz', field: 'music', method: 'lora', data: { voice: 30, spoken: 0 } },
      { id: 'stil-1', name: 'Stil', field: 'image', method: 'lora', data: { image: 12, subtitled: 10 } },
    ]));
    for (const f of ['egitim.json', 'kisaltmalar.json', 'nokta.pt']) writeFileSync(join(models, 'yazar-1', f), '{}');
    for (const f of ['yazar-egitim-20261005-120000-q4_k_m.gguf', 'genel-egitim-20261005-130000-q4_k_m.gguf', 'mmproj-genel-egitim-20261005-130000-q4_k_m.gguf']) writeFileSync(join(root, 'llm', 'models', f), 'GGUF');

    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), true);

    const after = new Database(join(dataRoot, 'panel.db'));
    try {
      const jobs = Object.fromEntries(after.jobs().map((j) => [j.type, j]));
      assert.deepEqual([jobs.film.input, jobs.film.outputs], [{ quality: 'checked', musicLevel: 'high' }, [{ file: 'film.mp4', type: 'video', main: true }]]);
      assert.deepEqual([jobs.training.status, jobs.training.yielded, jobs.training.input], ['paused', true, { method: 'scratch', size: 'large', base: 'trained:yazar-1' }]);
      assert.deepEqual(jobs.song.input, { strength: 'much', lora: 'trained:caz-1' });
      assert.deepEqual(after.jobQuery({ statuses: ['paused'] }).ids, [training.id]);
    } finally {
      after.close();
    }
    assert.deepEqual(JSON.parse(readFileSync(join(outputRoot, film.id, 'job.json'), 'utf8')).outputs, [{ file: 'film.mp4', type: 'video', main: true }]);
    assert.deepEqual(JSON.parse(readFileSync(join(dataRoot, 'downloads.json'), 'utf8')).map((i) => i.status), ['paused', 'done']);
    assert.ok(existsSync(join(root, 'models', 'checkpoints', 'a.safetensors.downloading')), 'the half file goes on downloading');
    const settings = JSON.parse(readFileSync(join(dataRoot, 'settings.json'), 'utf8'));
    assert.deepEqual([settings.textModel, settings.fineSettings], ['yazar-trained-20261005-120000-q4_k_m.gguf', { trainingText4bit: false }]);
    assert.ok(!existsSync(join(models, 'kayit.json')));
    const registry = JSON.parse(readFileSync(join(models, 'registry.json'), 'utf8'));
    assert.deepEqual(registry.map((m) => [m.method, m.size ?? null, m.gguf ?? null, m.mmproj ?? null, m.data ?? null]), [
      ['scratch', 'medium', 'yazar-trained-20261005-120000-q4_k_m.gguf', null, null],
      ['fine', null, 'genel-trained-20261005-130000-q4_k_m.gguf', 'mmproj-genel-trained-20261005-130000-q4_k_m.gguf', null],
      ['lora', null, null, null, { spoken: 0, songs: 30 }],
      ['lora', null, null, null, { image: 12, captioned: 10 }],
    ]);
    assert.deepEqual(readdirSync(join(root, 'llm', 'models')).sort(), ['genel-trained-20261005-130000-q4_k_m.gguf', 'mmproj-genel-trained-20261005-130000-q4_k_m.gguf', 'yazar-trained-20261005-120000-q4_k_m.gguf']);
    assert.deepEqual(readdirSync(join(models, 'yazar-1')).sort(), ['abbreviations.json', 'checkpoint.pt', 'training', 'training.json']);
    // once
    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 09.10.2026: the panel serves /file/ only (the /dosya/ alias is gone); links the Turkish-named versions wrote inside
 * chat messages, their summaries, the search index and job records point to /file/job/… after the next start.
 */
test('migration: old /dosya/ file links inside chats, the chat index and job records', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const outputRoot = join(root, 'outputs');
  const id = '20261008-015227-gorsel-44c5';
  const old = `/dosya/is/${id}/gorsel_1.png`;
  const fresh = `/file/job/${id}/gorsel_1.png`;
  try {
    mkdirSync(join(dataRoot, 'chat'), { recursive: true });
    mkdirSync(join(outputRoot, id), { recursive: true });
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify({ english: '2026-10-08T05:55:39.623Z', voiceLibrary: '2026-10-09T05:02:18.979Z', collections: '2026-10-09T05:02:18.979Z', values: '2026-10-09T05:02:18.979Z', collectionNames: '2026-10-09T05:02:18.979Z' }));
    const chat = { id: 'c1', messages: [{ role: 'assistant', content: `Ready: ![image](${old}) and [the upload](/dosya/yukleme/a.png)` }] };
    writeFileSync(join(dataRoot, 'chat', 'c1.json'), JSON.stringify(chat));
    writeFileSync(join(dataRoot, 'chat', 'c2.json'), JSON.stringify({ id: 'c2', messages: [{ role: 'user', content: 'no links' }] }));
    const job = { id, type: 'image', status: 'done', creation: '2026-10-08T01:52:27.000Z', input: { prompt: `like ${old}` }, outputs: [] };
    writeFileSync(join(outputRoot, id, 'job.json'), JSON.stringify(job));
    const db = new Database(join(dataRoot, 'panel.db'));
    db.writeJob(job);
    db.writeChat({ id: 'c1', update: '2026-10-08T02:00:00.000Z', title: 'Owl', last: `![image](${old})` }, { title: 'owl', body: `ready image ${old}` });
    db.close();

    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), true);

    assert.equal(JSON.parse(readFileSync(join(dataRoot, 'chat', 'c1.json'), 'utf8')).messages[0].content, `Ready: ![image](${fresh}) and [the upload](/file/upload/a.png)`);
    assert.deepEqual(JSON.parse(readFileSync(join(dataRoot, 'chat', 'c2.json'), 'utf8')), { id: 'c2', messages: [{ role: 'user', content: 'no links' }] });
    assert.equal(JSON.parse(readFileSync(join(outputRoot, id, 'job.json'), 'utf8')).input.prompt, `like ${fresh}`);
    const after = new Database(join(dataRoot, 'panel.db'));
    try {
      assert.equal(after.jobs()[0].input.prompt, `like ${fresh}`);
      assert.equal(after.chatSummaries()[0].last, `![image](${fresh})`);
      // the search index finds the chat by the new link and no longer by the old one
      assert.deepEqual(after.chatPage({ match: '"file job"' }).summaries.map((s) => s.id), ['c1']);
      assert.deepEqual(after.chatPage({ match: 'dosya' }).summaries, []);
    } finally {
      after.close();
    }
    // once
    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), false);
    assert.ok(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8')).fileLinks);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 09.10.2026: the first English pass read "en" in istemEn as width, so a job kept its translated prompt under
 * promptWidth (and a music job its style under styleWidth) while the code reads promptEnglish / styleEnglish: a retried
 * job translated again. The keys are renamed in panel.db and job.json; an old-version record goes straight to the new key.
 */
test('migration: the translated prompt and style keys of job records (promptWidth, styleWidth)', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const outputRoot = join(root, 'outputs');
  try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify({ english: '2026-10-08T05:55:39.623Z', voiceLibrary: '2026-10-09T05:02:18.979Z', collections: '2026-10-09T05:02:18.979Z', values: '2026-10-09T05:02:18.979Z', collectionNames: '2026-10-09T05:02:18.979Z', fileLinks: '2026-10-09T15:00:00.000Z' }));
    const image = { id: '20261005-222315-gorsel-6945', type: 'image', status: 'done', creation: '2026-10-05T22:23:15.000Z', input: { prompt: 'Sultanın şahin avı' }, promptWidth: 'The sultan hunting with a falcon', outputs: [] };
    const music = { id: '20261009-072646-music-82d8', type: 'music', status: 'done', creation: '2026-10-09T07:26:46.000Z', input: { style: 'umut veren elektronik' }, styleWidth: 'uplifting electronic', outputs: [] };
    // written by both versions: the new key wins and the old one goes
    const both = { id: '20261009-100000-video-dd44', type: 'video', status: 'done', creation: '2026-10-09T10:00:00.000Z', input: {}, promptWidth: 'old', promptEnglish: 'new', outputs: [] };
    const plain = { id: '20261009-110000-image-ee55', type: 'image', status: 'done', creation: '2026-10-09T11:00:00.000Z', input: { prompt: 'a cat' }, promptEnglish: 'a cat', outputs: [] };
    const db = new Database(join(dataRoot, 'panel.db'));
    for (const j of [image, music, both, plain]) {
      db.writeJob(j);
      mkdirSync(join(outputRoot, j.id), { recursive: true });
      writeFileSync(join(outputRoot, j.id, 'job.json'), JSON.stringify(j, null, 2));
    }
    db.close();

    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), true);

    const expected = {
      [image.id]: ['The sultan hunting with a falcon', undefined, undefined, undefined],
      [music.id]: [undefined, undefined, 'uplifting electronic', undefined],
      [both.id]: ['new', undefined, undefined, undefined],
      [plain.id]: ['a cat', undefined, undefined, undefined],
    };
    const keys = (j) => [j.promptEnglish, j.promptWidth, j.styleEnglish, j.styleWidth];
    const after = new Database(join(dataRoot, 'panel.db'));
    try {
      assert.deepEqual(Object.fromEntries(after.jobs().map((j) => [j.id, keys(j)])), expected);
    } finally {
      after.close();
    }
    for (const [id, want] of Object.entries(expected)) assert.deepEqual(keys(JSON.parse(readFileSync(join(outputRoot, id, 'job.json'), 'utf8'))), want, id);
    // a job.json without the old keys is left byte for byte
    assert.equal(readFileSync(join(outputRoot, plain.id, 'job.json'), 'utf8'), JSON.stringify(plain, null, 2));
    // a record of the Turkish-named version goes straight to the right key
    assert.deepEqual(migrateObject({ istemEn: 'a falcon' }), { promptEnglish: 'a falcon' });
    // once
    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), false);
    assert.ok(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8')).jobKeys);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * 09.10.2026: the English promo showed "5 sn" on a video card (the server wrote its durations in Turkish) and the jobs
 * made before the English rename kept a Turkish summary line ("20 sn · enstrümantal"), their language under "language"
 * (the code reads "lang") and values such as "hizli" and "orta". The line is written again from the input by the type's
 * summary(); an input that summary() cannot read keeps its line with the units translated. The title (renamed by the
 * user) stays.
 */
test('migration: the language key, the old values and the Turkish summary line of job records', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const outputRoot = join(root, 'outputs');
  const summaries = { video: videoJob.summary, music: musicJob.summary, clone: cloneJob.summary, song: songJob.summary, voice: voiceJob.summary, describe: describeJob.summary, model3d: model3dJob.summary };
  try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify({ english: '2026-10-08T05:55:39.623Z', voiceLibrary: '2026-10-09T05:02:18.979Z', collections: '2026-10-09T05:02:18.979Z', values: '2026-10-09T05:02:18.979Z', collectionNames: '2026-10-09T05:02:18.979Z', fileLinks: '2026-10-09T15:00:00.000Z', jobKeys: '2026-10-09T16:00:00.000Z' }));
    const job = (id, type, input, summary) => ({ id, type, status: 'done', creation: '2026-10-04T00:00:00.000Z', input, summary, outputs: [] });
    const records = [
      job('20261003-230904-video-eb1b', 'video', { prompt: 'Kaplumbağa kıyıdan yürüyüp denize girsin', model: 'wan14', duration: 5, frame: 81, resolution: '720p', width: 1280, height: 720, smooth: 1, seed: 1 }, { title: 'Kaplumbağa', detail: 'Wan 2.2 A14B (en iyi) · 1280×720 · 5 sn' }),
      // made after the rename: English but for the duration; the title was renamed by hand
      job('20261009-164438-video-2124', 'video', { prompt: 'slow push in', title: null, model: 'wan14', duration: 5, frame: 81, part: 1, resolution: '480p', width: 832, height: 480, smooth: 2, fps: 30, seed: 2 }, { title: 'Lighthouse at dusk, slow push-in', detail: 'Wan 2.2 A14B (best) · 832×480 · 5 sn · 30 fps' }),
      job('20261004-010613-muzik-5e4c', 'music', { style: 'epic orchestral', lyrics: '', duration: 20, bpm: 110, language: 'tr', seed: 7 }, { title: 'Destansı orkestra', detail: '20 sn · enstrümantal · 110 BPM' }),
      job('20261006-110504-klon-cff9', 'clone', { name: 'Musto', records: ['upload/a.mov'], train: true, step: 0, language: 'tr' }, { title: 'Musto', detail: '1 kayıt · hızlı klon (kayıt kısa)' }),
      job('20261004-040029-sarki-d367', 'song', { source: 'job/x/music.mp3', style: 'folk', lyrics: '', strength: 'orta', bpm: 110, language: 'tr', seed: 3 }, { title: 'folk', detail: 'Değişim: orta' }),
      job('20261004-053121-ses-9b82', 'voice', { text: 'Merhaba', voice: 'ref:a', language: 'tr', speed: 1, quality: 'hizli' }, { title: 'Merhaba', detail: 'Hızlı (bir kez okur)' }),
      job('20261005-230941-betimle-7e23', 'describe', { collection: 'minyatur-commons', language: 'tr', prompt: 'Bu görseli betimle.', max: 3, total: 296 }, { title: 'Image captioning', detail: 'en çok 3 · Türkçe · "Bu görseli betimle."' }),
      // summary() cannot read this old input (no formats): the units are translated, the rest stays
      job('20261004-150536-model3d-9e28', 'model3d', { source: 'job/y/image_1.png', quality: 'hizli', time: null }, { title: 'Yaşlı balıkçı', detail: 'TRELLIS.2 · hızlı · 12 sn' }),
    ];
    const db = new Database(join(dataRoot, 'panel.db'));
    for (const j of records) {
      db.writeJob(j);
      mkdirSync(join(outputRoot, j.id), { recursive: true });
      writeFileSync(join(outputRoot, j.id, 'job.json'), JSON.stringify(j, null, 2));
    }
    db.close();

    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root, summaries }), true);

    const expected = {
      '20261003-230904-video-eb1b': ['Kaplumbağa', 'Wan 2.2 A14B (best) · 1280×720 · 5 s'],
      '20261009-164438-video-2124': ['Lighthouse at dusk, slow push-in', 'Wan 2.2 A14B (best) · 832×480 · 5 s · 30 fps'],
      '20261004-010613-muzik-5e4c': ['Destansı orkestra', '20 s · instrumental · 110 BPM'],
      '20261006-110504-klon-cff9': ['Musto', '1 recording · quick clone (recording too short)'],
      '20261004-040029-sarki-d367': ['folk', 'Change: medium'],
      '20261004-053121-ses-9b82': ['Merhaba', 'Fast (reads once)'],
      '20261005-230941-betimle-7e23': ['Image captioning', 'at most 3 · Turkish · "Bu görseli betimle."'],
      '20261004-150536-model3d-9e28': ['Yaşlı balıkçı', 'TRELLIS.2 · hızlı · 12 s'],
    };
    const after = new Database(join(dataRoot, 'panel.db'));
    let stored;
    try {
      stored = Object.fromEntries(after.jobs().map((j) => [j.id, j]));
    } finally {
      after.close();
    }
    for (const [id, [title, detail]] of Object.entries(expected)) {
      for (const [where, j] of [['panel.db', stored[id]], ['job.json', JSON.parse(readFileSync(join(outputRoot, id, 'job.json'), 'utf8'))]]) {
        assert.deepEqual([j.summary.title, j.summary.detail], [title, detail], `${where} ${id}`);
      }
    }
    // the language under the key the code reads (describe keeps "language": its own key)
    for (const id of ['20261004-010613-muzik-5e4c', '20261006-110504-klon-cff9', '20261004-040029-sarki-d367', '20261004-053121-ses-9b82']) {
      assert.equal(stored[id].input.lang, 'tr', id);
      assert.equal('language' in stored[id].input, false, id);
    }
    assert.equal(stored['20261005-230941-betimle-7e23'].input.language, 'tr');
    assert.equal(stored['20261004-040029-sarki-d367'].input.strength, 'medium');
    assert.equal(stored['20261004-150536-model3d-9e28'].input.quality, 'fast');
    // once
    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root, summaries }), false);
    assert.ok(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8')).jobRecords);
    // an English line is left as it is; a record written by both versions keeps "lang"
    const english = job('20261009-170000-music-aa11', 'music', { style: 'jazz', lang: 'en', language: 'tr', duration: 30, bpm: 90 }, { title: 'jazz', detail: '30 s · instrumental · 90 BPM' });
    const fresh = migrateJobRecord(english, summaries);
    assert.equal(fresh.summary.detail, '30 s · instrumental · 90 BPM');
    assert.equal(fresh.input.lang, 'en');
    assert.equal('language' in fresh.input, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration: the Turkish stage, warning and error of job records come back in English; a second pass runs on an install that had the first', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const outputRoot = join(root, 'outputs');
  try {
    mkdirSync(dataRoot, { recursive: true });
    // the first pass (jobRecords) already ran here, as on the live panel
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify({ english: '2026-10-08T05:55:39.623Z', voiceLibrary: '2026-10-09T05:02:18.979Z', collections: '2026-10-09T05:02:18.979Z', values: '2026-10-09T05:02:18.979Z', collectionNames: '2026-10-09T05:02:18.979Z', fileLinks: '2026-10-09T15:00:00.000Z', jobKeys: '2026-10-09T16:00:00.000Z', jobRecords: '2026-10-09T17:54:50.246Z' }));
    const job = (id, status, progress, extra = {}) => ({ id, type: 'clone', status, creation: '2026-10-04T00:00:00.000Z', input: { name: 'A', records: ['upload/a.mov'], train: true, lang: 'tr' }, summary: { title: 'A', detail: '1 recording · trained' }, progress, outputs: [], ...extra });
    const records = [
      job('20261004-010101-klon-aaaa', 'done', { percent: 100, stage: 'Bitti' }, { warning: 'Eğitim için kayıt kısa (12 sn; en az 60 sn). Ses hızlı klon olarak eklendi.' }),
      job('20261004-010102-klon-bbbb', 'cancelled', { percent: 40, stage: 'İptal edildi', detail: '' }),
      job('20261004-010103-klon-cccc', 'failed', { percent: 10, stage: 'Örnek okunuyor', detail: 'Merhaba, bu benim sesim.' }),
      // already English: "Done" is a dictionary key, a text the dictionary does not know stays as it is
      job('20261009-010104-clone-dddd', 'done', { percent: 100, stage: 'Done', detail: 'GPU' }),
    ];
    const db = new Database(join(dataRoot, 'panel.db'));
    for (const j of records) {
      db.writeJob(j);
      mkdirSync(join(outputRoot, j.id), { recursive: true });
      writeFileSync(join(outputRoot, j.id, 'job.json'), JSON.stringify(j, null, 2));
    }
    db.close();

    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), true);
    const after = new Database(join(dataRoot, 'panel.db'));
    let stored;
    try {
      stored = Object.fromEntries(after.jobs().map((j) => [j.id, j]));
    } finally {
      after.close();
    }
    const expected = {
      '20261004-010101-klon-aaaa': ['Done', undefined, 'Recording too short for training (12 s; at least 60 s). Voice added as a quick clone.'],
      '20261004-010102-klon-bbbb': ['Cancelled', '', undefined],
      '20261004-010103-klon-cccc': ['Reading sample', 'Merhaba, bu benim sesim.', undefined],
      '20261009-010104-clone-dddd': ['Done', 'GPU', undefined],
    };
    for (const [id, [stage, detail, warning]] of Object.entries(expected)) {
      for (const [where, j] of [['panel.db', stored[id]], ['job.json', JSON.parse(readFileSync(join(outputRoot, id, 'job.json'), 'utf8'))]]) {
        assert.deepEqual([j.progress.stage, j.progress.detail, j.warning], [stage, detail, warning], `${where} ${id}`);
        assert.equal('error' in j, false, `${where} ${id}: no field added`);
      }
    }
    // the warning reads Turkish again on a Turkish page
    assert.equal(translate(stored['20261004-010101-klon-aaaa'].warning, 'tr'), 'Eğitim için kayıt kısa (12 sn; en az 60 sn). Ses hızlı klon olarak eklendi.');
    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), false);
    assert.ok(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8')).jobProgress);
    assert.equal(englishText('Panel kapandı; açılınca sürer'), 'Panel kapandı; açılınca sürer', 'unknown text stays');
    assert.equal(englishText('Yarıda kaldı'), 'Interrupted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration: the data collection keys of job records and the fields, values and summary of collected data (09.10.2026)', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const outputRoot = join(root, 'outputs');
  try {
    mkdirSync(dataRoot, { recursive: true });
    // every earlier step already ran here, as on the live panel
    const earlier = Object.fromEntries(['english', 'voiceLibrary', 'collections', 'values', 'collectionNames', 'fileLinks', 'jobKeys', 'jobRecords', 'jobProgress'].map((k) => [k, '2026-10-09T15:00:00.000Z']));
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify(earlier));
    // a data job and a film as the Turkish-named versions left them (taken from the live records)
    const data = {
      id: '20261006-020805-veri-c8e4', type: 'data', status: 'done', creation: '2026-10-05T23:08:05.914Z', pathDoesNotGive: true,
      input: { name: 'Caz', topic: 'Osmanlı minyatürleri', sources: [], target: 0, max: 50, extract: 'model', skipSite: true, ceviriPairs: true, personalDataMaskOut: true, onlyFields: ['a.example'], blockedFields: [], durationMin: 20 },
      summary: { title: 'Caz', detail: 'topic: Osmanlı minyatürleri · unlimited · site to site · extraction: local model · 20 min' },
      outputs: [
        { file: 'ekran/001-adim0.jpg', type: 'image' },
        { file: 'veri.json', type: 'data', collection: 'Caz', folder: 'C:\\Users\\root\\ai\\veri\\toplanan\\caz', total: 0, files: { texts: 0, images: 0, videolar: 0, voices: 30, 'egitim-baslik': 0 }, added: 0, articleNot: 2, topicExternal: 1, fieldExternal: 0, modelConnection: 3, management: 1, wikiExternal: 4, searchTopicExternal: 5, frontElimination: 6, ceviri: 7, voice: 30, nearCopy: 1 },
      ],
    };
    const film = { id: '20261007-082359-tekparca-852d', type: 'film', status: 'done', creation: '2026-10-07T05:23:59.000Z', input: { title: 'Pamuk' }, summary: { title: 'Pamuk', detail: '' }, outputs: [{ file: 'pamuk.mp4', type: 'video', main: true }, { file: 'pamuk.srt', type: 'altyazi' }, { file: 'sahne01.mp4', type: 'sahne', scene: 1 }] };
    const db = new Database(join(dataRoot, 'panel.db'));
    for (const j of [data, film]) {
      db.writeJob(j);
      mkdirSync(join(outputRoot, j.id), { recursive: true });
      writeFileSync(join(outputRoot, j.id, 'job.json'), JSON.stringify(j, null, 2));
    }
    db.close();
    // a collection with the old record fields
    const folder = join(root, 'data', 'collections', 'caz');
    mkdirSync(join(folder, 'media', 'images'), { recursive: true });
    writeFileSync(join(folder, 'media', 'images', '1.jpg'), 'x');
    const article = { url: 'https://a.example/1', title: 'Levnî', language: 'tr', writer: 'Ayşe', update: '2026-01-02', word: 320, extraction: 'kural', method: 'tarayici', gathering: '2026-10-05T23:10:00.000Z', summary: 'a1b2c3', simhash: 'ff00', text: 'Yazın: [e-posta], [telefon], [kimlik-no].', questionAnswers: [{ question: 'Kim?', cevap: 'Levnî' }], media: { image: 1, video: 0, voice: 2 } };
    writeFileSync(join(folder, 'articles.jsonl'), `${JSON.stringify(article)}\n`);
    writeFileSync(join(folder, 'images.jsonl'), `${JSON.stringify({ url: 'https://a.example/1.jpg', sub: 'Levni 1', subtitle: 'Açıklama 1 & minyatür.', text: 'Açıklama 1 & minyatür.', file: 'media/images/1.jpg', writer: 'Levnî', gathering: '2026-10-05T23:10:00.000Z', sourceType: 'commons' })}\n`);
    writeFileSync(join(folder, 'videos.jsonl'), [{ url: 'https://a.example/v.mp4', smallPicture: 'https://a.example/v.jpg', sourceType: 'video-etiketi', direct: true }, { url: 'https://youtube.com/embed/x', sourceType: 'gomulu', direct: false }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    writeFileSync(join(folder, 'audio.jsonl'), [{ url: 'https://a.example/s.mp3', sourceType: 'audio-etiketi' }, { url: 'https://a.example/f.mp3', sourceType: 'besleme-eki' }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    writeFileSync(join(folder, 'training-write.jsonl'), `${JSON.stringify({ messages: [{ role: 'assistant', content: 'Yazın: [e-posta]' }] })}\n`);
    writeFileSync(join(folder, 'summary.json'), JSON.stringify({ name: 'Caz', topic: 'Osmanlı minyatürleri', total: 1, avgWord: 320, metaBeing: 0, ceviriGroups: 0, files: { texts: 1, images: 1, voices: 2, 'egitim-baslik': 0 }, sonIs: data.id, lastUpdate: '2026-10-05T23:38:47.467Z' }, null, 1));

    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), true);
    const after = new Database(join(dataRoot, 'panel.db'));
    let stored;
    try {
      stored = Object.fromEntries(after.jobs().map((j) => [j.id, j]));
    } finally {
      after.close();
    }
    const files = Object.fromEntries([data, film].map((j) => [j.id, JSON.parse(readFileSync(join(outputRoot, j.id, 'job.json'), 'utf8'))]));
    for (const [where, jobs] of [['panel.db', stored], ['job.json', files]]) {
      const d = jobs[data.id];
      assert.deepEqual([d.noYield, 'pathDoesNotGive' in d], [true, false], where);
      assert.deepEqual(Object.keys(d.input), ['name', 'topic', 'sources', 'target', 'max', 'extract', 'hopSites', 'translationPairs', 'maskPersonalData', 'onlyDomains', 'blockedDomains', 'durationMin'], `${where}: input keys in their place`);
      const out = d.outputs[1];
      assert.deepEqual([out.notArticle, out.offTopic, out.blockedDomain, out.modelLinks, out.managerRounds, out.wikiNonContent, out.offTopicResults, out.prefiltered, out.translation, out.audio, out.nearCopy], [2, 1, 0, 3, 1, 4, 5, 6, 7, 30, 1], `${where}: counters`);
      assert.ok(!['articleNot', 'topicExternal', 'ceviri', 'voice'].some((k) => k in out), `${where}: no old counter left`);
      assert.deepEqual(out.files, { articles: 0, images: 0, videos: 0, audio: 30, 'training-title': 0 }, `${where}: file counts`);
      assert.equal(out.folder, 'C:\\Users\\root\\ai\\data\\collections\\caz');
      assert.deepEqual(d.outputs[0], data.outputs[0], `${where}: a screenshot output stays`);
      assert.deepEqual(jobs[film.id].outputs.map((o) => o.type), ['video', 'subtitle', 'scene'], `${where}: film output types`);
      // the summary line reads the new keys
      assert.match(dataSummary(d.input).detail, /unlimited · site to site/, where);
    }
    const lines = (f) => readFileSync(join(folder, f), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.deepEqual(lines('articles.jsonl')[0], { url: 'https://a.example/1', title: 'Levnî', language: 'tr', author: 'Ayşe', modified: '2026-01-02', words: 320, extraction: 'rule', method: 'browser', collectedAt: '2026-10-05T23:10:00.000Z', digest: 'a1b2c3', simhash: 'ff00', text: 'Yazın: [email], [phone], [id-number].', questionAnswers: [{ question: 'Kim?', answer: 'Levnî' }], media: { image: 1, video: 0, audio: 2 } });
    assert.deepEqual(lines('images.jsonl')[0], { url: 'https://a.example/1.jpg', alt: 'Levni 1', caption: 'Açıklama 1 & minyatür.', text: 'Açıklama 1 & minyatür.', file: 'media/images/1.jpg', author: 'Levnî', collectedAt: '2026-10-05T23:10:00.000Z', sourceType: 'commons' });
    assert.deepEqual(lines('videos.jsonl').map((o) => [o.sourceType, o.thumbnail ?? null]), [['video-tag', 'https://a.example/v.jpg'], ['embed', null]]);
    assert.deepEqual(lines('audio.jsonl').map((o) => o.sourceType), ['audio-tag', 'feed-attachment']);
    assert.equal(lines('training-write.jsonl')[0].messages[0].content, 'Yazın: [email]');
    const summary = JSON.parse(readFileSync(join(folder, 'summary.json'), 'utf8'));
    assert.deepEqual([summary.avgWords, summary.withMetaDescription, summary.translationGroups, summary.lastJob, summary.files], [320, 0, 0, data.id, { articles: 1, images: 1, audio: 2, 'training-title': 0 }]);
    assert.ok(!['avgWord', 'metaBeing', 'ceviriGroups', 'sonIs'].some((k) => k in summary));
    // the code reads them: the caption of an image for training, the article count of the collection list
    assert.deepEqual(collectionMedia({ aiRoot: root }, { id: 'caz', type: 'images' }).map((m) => m.text), ['Açıklama 1 & minyatür.']);
    assert.equal(collections(root).find((c) => c.id === 'caz').files.find((f) => f.name === 'articles').count, 1);
    // a record already in English stays the same object
    const fresh = { url: 'https://a.example/2', alt: 'x', caption: 'y' };
    assert.equal(migrateCollectedRecord(fresh, 'images'), fresh);

    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), false, 'a second start has nothing to do');
    assert.ok(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8')).dataKeys);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration: the Turkish duration measurement keys join the English keys of the averages (09.10.2026)', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  try {
    mkdirSync(dataRoot, { recursive: true });
    const earlier = Object.fromEntries(['english', 'voiceLibrary', 'collections', 'values', 'collectionNames', 'fileLinks', 'jobKeys', 'jobRecords', 'jobProgress', 'dataKeys'].map((k) => [k, '2026-10-09T15:00:00.000Z']));
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify(earlier));
    // the keys as the live panel.db held them
    const db = new Database(join(dataRoot, 'panel.db'));
    for (const [key, value] of [['gorsel/qwen', 70], ['gorsel/qwen', 74], ['image/qwen', 80], ['duzenle', 38], ['muzik', 0.8], ['music', 1.9], ['sahne-yaz', 11], ['ses/hizli', 104], ['ses/denetimli', 91], ['voice/denetimli', 95], ['video/anahtar', 162], ['video/dudak/720p', 30], ['model3d/hizli', 80], ['gorsel/flux', 14], ['video/wan14/720p', 60]]) db.writeMeasurement(key, value, null);
    db.close();

    assert.equal(migrateLegacyData({ dataRoot, outputRoot: join(root, 'outputs'), aiRoot: root }), true);
    const after = new Database(join(dataRoot, 'panel.db'));
    let averages;
    try {
      averages = after.averages();
    } finally {
      after.close();
    }
    assert.deepEqual(Object.keys(averages).sort(), ['edit', 'image/flux', 'image/qwen', 'model3d/fast', 'music', 'video/key', 'video/lip/720p', 'video/wan14/720p', 'voice/checked', 'voice/fast', 'write-scenes']);
    // the old values count in the new key's median: 70, 74, 80 -> 74
    assert.equal(averages['image/qwen'], 74);
    assert.equal(averages['voice/checked'], 95);
    assert.equal(migrateLegacyData({ dataRoot, outputRoot: join(root, 'outputs'), aiRoot: root }), false, 'a second start has nothing to do');
    assert.ok(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8')).measurementKeys);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration: a chat message keeps its tool outputs under extra, the notes and schedules get English file names (09.10.2026)', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const chat = join(dataRoot, 'chat');
  try {
    mkdirSync(chat, { recursive: true });
    const earlier = Object.fromEntries(['english', 'voiceLibrary', 'collections', 'values', 'collectionNames', 'fileLinks', 'jobKeys', 'jobRecords', 'jobProgress', 'dataKeys', 'measurementKeys'].map((k) => [k, '2026-10-09T15:00:00.000Z']));
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify(earlier));
    // a session as the live panel kept it
    const outputs = { job: '20261008-015227-image-44c5', outputs: [{ type: 'image', url: '/file/job/20261008-015227-image-44c5/image_1.png' }] };
    writeFileSync(join(chat, 'muypc3nlaeda.json'), JSON.stringify({ id: 'muypc3nlaeda', title: 'Cat', messages: [{ role: 'user', text: 'draw a cat' }, { role: 'tool', name: 'generate_image', text: 'done', ek: outputs }, { role: 'tool', text: 'both', ek: { job: 'old' }, extra: { job: 'new' } }] }));
    writeFileSync(join(chat, 'mv0e1pd330a7.json'), JSON.stringify({ id: 'mv0e1pd330a7', messages: [{ role: 'user', text: 'hello' }] }));
    writeFileSync(join(chat, 'hafiza.md'), '- [n1] 2026-10-08: the user likes cats\n');
    writeFileSync(join(chat, 'zamanlamalar.json'), '[]');
    writeFileSync(join(chat, 'watches.json'), '{"watches":[]}');
    const untouched = readFileSync(join(chat, 'mv0e1pd330a7.json'), 'utf8');

    assert.equal(migrateLegacyData({ dataRoot, outputRoot: join(root, 'outputs'), aiRoot: root }), true);
    const messages = JSON.parse(readFileSync(join(chat, 'muypc3nlaeda.json'), 'utf8')).messages;
    assert.deepEqual(messages[1].extra, outputs);
    assert.equal('ek' in messages[1], false);
    assert.deepEqual(messages[2].extra, { job: 'new' }, 'the new key stays');
    assert.equal('ek' in messages[2], false);
    assert.equal(readFileSync(join(chat, 'mv0e1pd330a7.json'), 'utf8'), untouched, 'a chat without ek is not written');
    assert.equal(readFileSync(join(chat, 'memory.md'), 'utf8'), '- [n1] 2026-10-08: the user likes cats\n');
    assert.equal(readFileSync(join(chat, 'schedules.json'), 'utf8'), '[]');
    assert.equal(existsSync(join(chat, 'hafiza.md')) || existsSync(join(chat, 'zamanlamalar.json')), false);
    assert.equal(migrateLegacyData({ dataRoot, outputRoot: join(root, 'outputs'), aiRoot: root }), false, 'a second start has nothing to do');
    assert.ok(JSON.parse(readFileSync(join(dataRoot, 'migration.json'), 'utf8')).chatFiles);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration: a saved edit plan keeps the operation, field and value names of the prompt; the version file gets an English name (09.10.2026)', () => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'));
  const dataRoot = join(root, 'panel-data');
  const outputRoot = join(root, 'outputs');
  try {
    mkdirSync(dataRoot, { recursive: true });
    const earlier = Object.fromEntries(['english', 'voiceLibrary', 'collections', 'values', 'collectionNames', 'fileLinks', 'jobKeys', 'jobRecords', 'jobProgress', 'dataKeys', 'measurementKeys', 'chatFiles'].map((k) => [k, '2026-10-09T15:00:00.000Z']));
    writeFileSync(join(dataRoot, 'migration.json'), JSON.stringify(earlier));
    // the two plans as the live panel.db held them, and an 08.10 plan
    const job = (id, type, steps) => ({ id, type, status: 'done', creation: '2026-10-04T04:09:47.000Z', input: {}, plan: { steps, description: 'x', impossible: '' } });
    const video = job('20261004-040947-videoduzenle-d5f9', 'videoEdit', [{ operation: 'kirp', ratio: '9:16' }, { operation: 'yazi', text: 'Deneme', position: 'alt', startedAt: null, last: null }, { operation: 'siyahBeyaz' }, { operation: 'solma', login: 0, exit: 1 }]);
    const audio = job('20261004-040947-sesduzenle-b626', 'audioEdit', [{ operation: 'kes', startedAt: 2, last: 111.8 }, { operation: 'hiz', ratio: 1.1 }, { operation: 'perde', partialTone: 2 }, { operation: 'yanki', amount: 0.2 }]);
    const recent = job('20261008-120000-videoEdit-a1b2', 'videoEdit', [{ operation: 'translate', direction: 'landscape' }, { operation: 'truncate', ratio: '1:1' }, { operation: 'closeVoice' }, { operation: 'text', text: 'Hi', position: 'parent', startedAt: 1, last: 3 }]);
    const image = { id: '20261004-050000-image-c3d4', type: 'image', status: 'done', creation: '2026-10-04T05:00:00.000Z', input: { prompt: 'a cat' } };
    const db = new Database(join(dataRoot, 'panel.db'));
    for (const j of [video, audio, recent, image]) db.writeJob(j);
    db.close();
    mkdirSync(join(outputRoot, video.id), { recursive: true });
    writeFileSync(join(outputRoot, video.id, 'job.json'), JSON.stringify(video, null, 1));
    writeFileSync(join(root, 'surum.json'), JSON.stringify({ sha: 'a'.repeat(40), dateText: 't', files: ['panel/server.mjs'] }));

    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), true);
    const after = new Database(join(dataRoot, 'panel.db'));
    let jobs;
    try {
      jobs = Object.fromEntries(after.jobs().map((j) => [j.id, j]));
    } finally {
      after.close();
    }
    const expected = [{ operation: 'crop', ratio: '9:16' }, { operation: 'text', text: 'Deneme', position: 'bottom', start: null, end: null }, { operation: 'blackWhite' }, { operation: 'fade', in: 0, out: 1 }];
    assert.deepEqual(jobs[video.id].plan.steps, expected);
    assert.deepEqual(JSON.parse(readFileSync(join(outputRoot, video.id, 'job.json'), 'utf8')).plan.steps, expected, 'the job.json copy too');
    assert.deepEqual(jobs[audio.id].plan.steps, [{ operation: 'cut', start: 2, end: 111.8 }, { operation: 'speed', ratio: 1.1 }, { operation: 'pitch', semitones: 2 }, { operation: 'echo', amount: 0.2 }]);
    assert.deepEqual(jobs[recent.id].plan.steps, [{ operation: 'flip', direction: 'horizontal' }, { operation: 'crop', ratio: '1:1' }, { operation: 'mute' }, { operation: 'text', text: 'Hi', position: 'top', start: 1, end: 3 }]);
    assert.deepEqual(jobs[image.id], image, 'a job without a plan is not touched');
    // the migrated plan runs: every step is an operation the editor knows
    const args = videoEditJob.chainArgs(jobs[video.id].plan.steps.filter((a) => a.operation !== 'text'), { duration: 4, width: 320, height: 240, fps: 30, voice: true }, { input: 'in.mp4', output: 'out.mp4', k: root });
    assert.match(args.join(' '), /crop=.*hue=s=0,fade=t=out:st=3\.00:d=1/);
    assert.equal(existsSync(join(root, 'surum.json')), false);
    assert.equal(JSON.parse(readFileSync(join(root, 'version.json'), 'utf8')).sha, 'a'.repeat(40));
    assert.equal(migrateLegacyData({ dataRoot, outputRoot, aiRoot: root }), false, 'a second start has nothing to do');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
