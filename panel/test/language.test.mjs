/**
 * Iki dil: kaynak metinler Ingilizce, sozluk (web/lang/dictionary.js) en -> tr. Sozluk tutarliligi,
 * sunucu yanitlarinin cevirisi ve belgelerin Ingilizce sayfasinda Turkce kalmamasi.
 *   node --test panel/test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate, requestLanguage, translateData } from '../lib/language.mjs';

const dictionary = globalThis.NedeseDictionary.tr;

test('dictionary: English keys with Turkish values, placeholders identical, no empty translation', () => {
  const placeHolder = (s) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join();
  assert.ok(Object.keys(dictionary).length > 500, 'dictionary loaded');
  for (const [en, tr] of Object.entries(dictionary)) {
    assert.equal(typeof tr, 'string', en);
    if (en !== '') assert.ok(tr.length > 0, `empty translation: ${en}`);
    assert.equal(placeHolder(tr), placeHolder(en), `placeholder differs: ${en}`);
  }
});

// 09.10.2026: the identifier rename of the English conversion also reached Turkish values ("dikey/frame kırpma",
// "ComfyUI/narration", "cancelled" -> "cancel", "medium" -> "middle")
test('dictionary: no renamed identifier left inside a Turkish value', () => {
  const renamed = /(?<![\p{L}_.$/#-])(voice|scene|frame|narration|expected|middle|cancel|motion)(?![\p{L}_(-])/u;
  const turkish = /[çğıöşüÇĞİÖŞÜ]/;
  // code spans, quoted text, placeholders, paths (slash or backslash) and key=value pairs are not translated text
  const left = Object.entries(dictionary).filter(([en, tr]) => tr !== en && turkish.test(tr) && renamed.test(tr.replace(/`[^`]*`|"[^"]*"|\{[^}]*\}|\/\S*|\S*\/|\S*\\\S*|\S+=\S+/g, ' ')));
  assert.deepEqual(left.map(([en]) => en), []);
  const words = { cancelled: 'iptal', path: 'adres', medium: 'orta', 'motion prompt {0}/{1}': 'hareket istemi {0}/{1}' };
  for (const [en, tr] of Object.entries(words)) assert.equal(dictionary[en], tr, en);
  // a renamed word joined to a Turkish one by a slash
  const joined = Object.values(dictionary).filter((tr) => /(dikey|sahne|inen|müzik|görsel\/video|ComfyUI)\/(voice|scene|frame|narration|expected)\b|\/(voice|scene|frame|narration|expected) (kırp|kaynağı|bayt|durdurulur)/u.test(tr));
  assert.deepEqual(joined, []);
  assert.match(dictionary['Possible: cutting, speed and slow motion, rotating, mirroring, vertical/square crop, size, muting/lowering sound, adding text, colour, black and white, fade, reverse, frame rate, adding music.'], /dikey\/kare kırpma/);
});

test('translation: en unchanged; tr by exact match, pattern, nested part, timestamped log line, combined text', () => {
  assert.equal(translate('Add to queue', 'en'), 'Add to queue');
  assert.equal(translate('Add to queue', 'tr'), 'Kuyruğa ekle');
  assert.equal(translate('Scene 3 (12 s)', 'tr'), 'Sahne 3 (12 sn)');
  assert.equal(translate('23:15:01 Added to queue: Image', 'tr'), '23:15:01 Kuyruğa eklendi: Görsel');
  assert.equal(translate('LoRA (speed-up, style) · 3.1 GB', 'tr'), 'LoRA (hızlandırma, stil) · 3.1 GB');
  assert.equal(translate('User text that is not in the dictionary', 'tr'), 'User text that is not in the dictionary');
  assert.equal(translate('Wan 2.2 A14B (best) · 720×1280 · 10 s (2 parts) · 16 fps', 'tr'), 'Wan 2.2 A14B (en iyi) · 720×1280 · 10 sn (2 parça) · 16 fps');
  assert.equal(translate('Wan 2.2 A14B (best) · 1280×720 · 1 min 5 s (13 parts) · RIFE 3×', 'tr'), 'Wan 2.2 A14B (en iyi) · 1280×720 · 1 dk 5 sn (13 parça) · RIFE 3×');
  assert.equal(translate('Wan 2.2 A14B (best) · 1 min 5 s (13 parts)', 'en'), 'Wan 2.2 A14B (best) · 1 min 5 s (13 parts)');
  // the parts last: the pattern must not catch across " · " (09.10.2026)
  assert.equal(translate('Wan 2.2 A14B (best) · 1280×720 · 2 min 05 s (25 parts)', 'tr'), 'Wan 2.2 A14B (en iyi) · 1280×720 · 2 dk 05 sn (25 parça)');
});

test('translation: the stored summary lines of the job types read fully Turkish', () => {
  const lines = {
    '1 source · at most 400 per source · extraction: rule': '1 kaynak · kaynak başına en çok 400 · ayıklama: kural',
    'topic: Ottoman miniatures · unlimited · site to site · extraction: local model · 30 min': 'konu: Ottoman miniatures · sınırsız · siteden siteye · ayıklama: yerel model · 30 dk',
    '1 recording · quick clone (recording too short)': '1 kayıt · hızlı klon (kayıt kısa)',
    'Text · fine-tune · Qwen3 14B (recommended, best writing) · 2 data files · 1 epoch': 'Metin · ince ayar · Qwen3 14B (önerilen, en iyi yazı) · 2 veri dosyası · 1 devir',
    'Wan 2.2 A14B (best) · 832×480 · 5 s · 30 fps · identity protected': 'Wan 2.2 A14B (en iyi) · 832×480 · 5 sn · 30 fps · kimlik korumalı',
    'GPU 0.8/12 GB · 0%': 'GPU 0.8/12 GB · %0',
    '1.2 GB / 3.4 GB (45%)': '1.2 GB / 3.4 GB (%45)',
  };
  for (const [en, tr] of Object.entries(lines)) assert.equal(translate(en, 'tr'), tr);
});

test('request language: ?lang > X-Panel-Lang > Accept-Language > en', () => {
  const req = (url, headers = {}) => ({ url, headers: headers });
  assert.equal(requestLanguage(req('/api/v1/status')), 'en');
  assert.equal(requestLanguage(req('/api/v1/status', { 'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8' })), 'tr');
  assert.equal(requestLanguage(req('/api/v1/status', { 'accept-language': 'en-US,en;q=0.9' })), 'en');
  assert.equal(requestLanguage(req('/api/v1/status', { 'accept-language': 'de-DE' })), 'en', 'unknown language falls back to the source language');
  assert.equal(requestLanguage(req('/api/v1/status?lang=tr', { 'accept-language': 'en-US' })), 'tr');
  assert.equal(requestLanguage(req('/api/v1/status?lang=en', { 'accept-language': 'tr-TR' })), 'en');
  assert.equal(requestLanguage(req('/api/v1/status', { 'x-panel-lang': 'tr', 'accept-language': 'en' })), 'tr');
  assert.equal(requestLanguage(req('/api/v1/status', { 'x-panel-lang': 'en', 'accept-language': 'tr' })), 'en');
});

test('response translation only touches human-readable text', () => {
  const data = { ok: false, error: 'Job not found.', code: 'notFound', job: { title: 'Job not found.', log: ['10:00:00 Started'] } };
  const tr = translateData(data, 'tr');
  assert.equal(tr.error, 'İş bulunamadı.');
  assert.equal(tr.code, 'notFound', 'machine codes are not translated');
  assert.equal(tr.job.title, 'Job not found.', 'user title is not translated');
  assert.deepEqual(tr.job.log, ['10:00:00 Başladı']);
  assert.deepEqual(data.job.log, ['10:00:00 Started'], 'the original object is untouched');
  assert.equal(translateData(data, 'en'), data, 'English is the source language: same object back');
});

test('every server text the Turkish UI and API docs show has a Turkish entry (routes, job types, fine settings, model catalog)', async () => {
  const { apiRoutes, JOB_TYPES } = await import('../lib/api.mjs');
  const texts = new Set();
  // machine values stay as they are: lists of values, JSON shapes, header lines, examples
  const skip = new Set(['example', 'examples', 'exampleCurl', 'response', 'request', 'path', 'method', 'pattern', 'enum', 'default', 'type', 'name', 'id', 'url']);
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.length >= 12 && / /.test(v) && /[a-z]{3,}/.test(v) && !/ \| |^\{|^\d+:/.test(v)) texts.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!skip.has(k)) walk(x);
  };
  walk(apiRoutes(new Proxy({}, { get: () => () => ({}) })));
  walk(JOB_TYPES);
  for (const file of ['fine-settings', 'jobs/training', 'models', 'settings']) {
    for (const v of Object.values(await import(`../lib/${file}.mjs`))) if (v && typeof v === 'object') walk(v);
  }
  assert.ok(texts.size > 300, `server texts found: ${texts.size}`);
  const missing = [...texts].filter((t) => !(t in dictionary) && translate(t, 'tr') === t);
  assert.deepEqual(missing, [], 'add the Turkish of these texts to web/lang/dictionary.js');
});

test('the error messages a job shows have a Turkish entry (a missing model said tools\\comfy.mjs and stayed English)', async () => {
  const { friendlyError, ComfyValidationError, ComfyRuntimeError, ProcessError } = await import('../lib/errors.mjs');
  const rejected = (type, details, field) => new ComfyValidationError({ error: { type: 'prompt_outputs_failed_validation', message: 'x' }, node_errors: { 1: { errors: [{ type, details: `${field}: '${details}' not in []`, message: 'Value not in list' }] } } });
  const errors = [
    rejected('value_not_in_list', 'wan2.2.gguf', 'unet_name'),
    rejected('value_not_in_list', 'panel_x.png', 'image'),
    new ComfyRuntimeError({ exception_type: 'torch.OutOfMemoryError', exception_message: 'CUDA out of memory', node_type: 'KSampler' }),
    new ComfyRuntimeError({ exception_type: 'RuntimeError', exception_message: 'DefaultCPUAllocator: not enough memory', node_type: 'VAEDecode' }),
    new ProcessError('voice', 1, ['RuntimeError: CUDA error: out of memory']),
    new Error('connect ECONNREFUSED 127.0.0.1:8188'),
  ];
  for (const e of errors) {
    const { message } = friendlyError(e);
    assert.notEqual(translate(message, 'tr'), message, `no Turkish for: ${message}`);
  }
  assert.match(friendlyError(errors[0]).message, /tools\\comfy\.mjs/);
});

test('API docs: the English page has no Turkish text; the Turkish page is translated from the dictionary', async () => {
  const { docsPage, openapi } = await import('../lib/documents.mjs');
  const { apiRoutes } = await import('../lib/api.mjs');
  const routes = apiRoutes(new Proxy({}, { get: () => () => ({}) }));
  const strip = (html) =>
    html
      .replace(/<pre[\s\S]*?<\/pre>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, ' ');
  const en = strip(docsPage(routes, { language: 'en' }));
  const turkish = en.split(/\s{2,}|\n/).filter((s) => /[çğıöşüÇĞİÖŞÜ]/.test(s) && !/ÖZEN|panel-data/.test(s));
  assert.deepEqual(turkish, []);
  assert.equal(strip(docsPage(routes)), en, 'default language is English');
  const oa = openapi(routes, { language: 'en' });
  for (const path of Object.values(oa.paths)) for (const op of Object.values(path)) assert.doesNotMatch(op.summary, /[çğıöşüİ]/, op.summary);
  assert.ok(oa.components.responses.Err && oa.components.responses.Unauthorized && oa.components.schemas.Err, 'error components exist');
  for (const path of Object.values(oa.paths)) for (const op of Object.values(path)) assert.equal(op.responses[400].$ref, '#/components/responses/Err');
  // Turkish page: route texts, group names and job type descriptions come from the dictionary
  const tr = strip(docsPage(routes, { language: 'tr' }));
  assert.match(tr, /Oturum durumu/, 'route summary translated');
  assert.match(tr, /Web'den eğitim verisi toplar/, 'data collection description translated');
  assert.match(tr, /Toplanan koleksiyonun indirilen görsellerini/, 'image description job translated');
  assert.doesNotMatch(tr, /Collects training data from the web/, 'no English left where a translation exists');
  assert.equal(openapi(routes, { language: 'tr' }).paths['/api/v1/session'].get.summary, 'Oturum durumu');
});
