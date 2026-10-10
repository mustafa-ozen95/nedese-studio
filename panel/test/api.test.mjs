/**
 * API v1: yetki (Bearer / tarayici), yanit bicimi, rota tablosu ile belgelerin tutarliligi,
 * ayarlar (niceleme secimi), ComfyUI durdur, galeri/yukleme/ses rotalari.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { makePng } from '../lib/media.mjs';
import { apiRoutes, pathPattern, JOB_TYPES } from '../lib/api.mjs';
import { docsPage, openapi, curlExample } from '../lib/documents.mjs';

function req(address, path, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(address);
  return new Promise((ok, red) => {
    const r = request({ host: u.hostname, port: u.port, path: path, method: method, headers: headers }, (y) => {
      const parts = [];
      y.on('data', (p) => parts.push(p));
      y.on('end', () => {
        const raw = Buffer.concat(parts);
        let json = null;
        try {
          json = JSON.parse(raw.toString('utf8'));
        } catch {
          /* ikili */
        }
        ok({ code: y.statusCode, headers: y.headers, body: raw, json });
      });
    });
    r.on('error', red);
    if (body) r.write(body);
    r.end();
  });
}

test('route table: every route documented, paths unique, OpenAPI and HTML docs generated from the table', () => {
  const routes = apiRoutes({});
  const keys = new Set();
  for (const r of routes) {
    assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(r.method), r.path);
    assert.ok(r.summary && r.description && r.group, `belgesiz rota: ${r.method} ${r.path}`);
    assert.ok(r.response !== undefined, `no example response: ${r.path}`);
    assert.ok(r.handler || r.file || r.direct || r.path === '/openapi.json', `no handler: ${r.path}`);
    const k = `${r.method} ${r.path}`;
    assert.ok(!keys.has(k), `duplicate route: ${k}`);
    keys.add(k);
    for (const p of r.params ?? []) if (p.place === 'path') assert.ok(r.path.includes(`{${p.name}}`), `${r.path}: {${p.name}} yolda yok`);
    for (const name of pathPattern(r.path).names) assert.ok((r.params ?? []).some((p) => p.name === name && p.place === 'path'), `${r.path}: ${name} undocumented`);
    assert.match(curlExample(r, 'http://127.0.0.1:1071/'), /^curl /);
  }
  assert.ok(routes.length >= 30);
  const o = openapi(routes);
  assert.equal(o.openapi, '3.0.3');
  const opCount = Object.values(o.paths).reduce((t, p) => t + Object.keys(p).length, 0);
  assert.equal(opCount, routes.length, 'OpenAPI includes every route');
  assert.equal(o.components.securitySchemes.key.scheme, 'bearer');
  for (const type of Object.keys(JOB_TYPES)) assert.ok(o.components.schemas[`Is_${type}`], type);
  const html = docsPage(routes);
  for (const r of routes) assert.ok(html.includes(`/api/v1${r.path}`), `HTML docs do not include ${r.path}`);
  assert.doesNotMatch(html, /aip_[A-Za-z0-9_-]{20,}/, 'no real key in the docs');
  // On a phone a table cell shows its label and the value follows it on the left (user report 09.10.2026)
  assert.doesNotMatch(html, /<td(?![^>]*data-label)/, 'every table cell has a label');
  assert.match(html, /<code>type: "image"<\/code>/, 'the job body field is type');
  assert.doesNotMatch(html, /class="(?:belge|zorunlu)|id="(?:is|grup)-/, 'English names on the page');
  assert.doesNotMatch(html, /10\.0\.0\.|100\.\d+\.\d+\.\d+/, 'examples use 127.0.0.1 only');
  assert.deepEqual(o.servers, [{ url: 'http://127.0.0.1:1071/api/v1' }]);
  const d = pathPattern('/jobs/{id}/file/{file}');
  assert.deepEqual(d.names, ['id', 'file']);
  assert.ok(d.pattern.test('/jobs/20261003-120000-image-abcd/file/image_1.png'));
});

test('API v1: auth, error format, job lifecycle, file download, settings, ComfyUI, voices', async () => {
  const p = await createPanel({ server: true });
  const host = new URL(p.address).host;
  const key = p.settingFile.apiKey;
  const authorized = { Authorization: `Bearer ${key}` };
  const json = { 'Content-Type': 'application/json' };
  try {
    assert.match(key, /^aip_[A-Za-z0-9_-]{30,}$/, 'key generated on first start');
    // Yetkisiz: anahtarsiz betik 401; yanlis anahtar 401; kimlik ve openapi serbest.
    const y = await req(p.address, '/api/v1/status');
    assert.equal(y.code, 401);
    assert.deepEqual([y.json.ok, y.json.code], [false, 'unauthorized']);
    assert.equal((await req(p.address, '/api/v1/status', { headers: { Authorization: 'Bearer aip_yanlis' } })).code, 401);
    assert.equal((await req(p.address, '/api/v1/id')).json.api, 'v1');
    assert.equal((await req(p.address, '/api/v1/openapi.json')).json.openapi, '3.0.3');
    assert.match((await req(p.address, '/api/documents')).headers['content-type'], /text\/html/);
    // The Settings button kept /api/belgeler after the English rename and got a 404 (user report 09.10.2026)
    const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    const links = [...page.matchAll(/\b(?:href|src)="(\/[^"#?]*)/g)].map((m) => m[1]);
    assert.ok(links.includes('/api/documents'), 'the docs button');
    for (const link of links) assert.equal((await req(p.address, link)).code, 200, `index.html links to ${link}`);
    assert.equal((await req(p.address, '/api/v1/yok-boyle')).code, 404);
    assert.equal((await req(p.address, '/api/v1/status', { method: 'DELETE', headers: authorized })).code, 405);
    // Tarayici: X-Panel ile GET; yazan istekte Origin de sart.
    assert.equal((await req(p.address, '/api/v1/status', { headers: { 'X-Panel': '1' } })).code, 200);
    assert.equal((await req(p.address, '/api/v1/status', { headers: { 'Sec-Fetch-Site': 'none' } })).code, 200, 'opening from the address bar');
    assert.equal((await req(p.address, '/api/v1/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).code, 401);
    assert.equal((await req(p.address, '/api/v1/comfy/start', { method: 'POST', headers: { 'X-Panel': '1' } })).code, 401, 'POST: X-Panel alone is not enough');
    assert.equal((await req(p.address, '/api/v1/comfy/start', { method: 'POST', headers: { 'X-Panel': '1', Origin: `http://${host}` } })).code, 200);
    assert.equal((await req(p.address, '/api/v1/comfy/start', { method: 'POST', headers: { 'X-Panel': '1', Origin: 'http://kotu.example' } })).code, 401);
    // Eski arayuz rotasi Bearer ile de calisir (betik uyumu).
    assert.equal((await req(p.address, '/api/comfy/start', { method: 'POST', headers: authorized })).json.message, 'ComfyUI is already running.');

    // Durum / sistem / secenekler
    const status = (await req(p.address, '/api/v1/status', { headers: authorized })).json;
    assert.equal(status.ok, true);
    assert.equal(status.comfy.running, true);
    const system = (await req(p.address, '/api/v1/system', { headers: authorized })).json;
    assert.ok(system.disk.outputs.freeByte > 0);
    assert.equal(system.paths.modelRoot, p.setting.modelRoot);

    // Is: hatali girdi 400 gecersiz; olustur; ayrinti; gunluk; dosya; sil; 404.
    const error = await req(p.address, '/api/v1/jobs', { method: 'POST', headers: { ...authorized, ...json }, body: JSON.stringify({ type: 'image', prompt: ' ' }) });
    assert.equal(error.code, 400);
    assert.deepEqual([error.json.code, error.json.error], ['invalid', 'Prompt cannot be empty.']);
    const create = await req(p.address, '/api/v1/jobs', { method: 'POST', headers: { ...authorized, ...json }, body: JSON.stringify({ type: 'image', prompt: 'api fox', model: 'flux' }) });
    assert.equal(create.code, 200, create.body.toString());
    const id = create.json.job.id;
    await p.waitUntilDone(id);
    const detail = (await req(p.address, `/api/v1/jobs/${id}`, { headers: authorized })).json.job;
    assert.equal(detail.status, 'done');
    assert.equal(detail.outputCount, 1);
    assert.ok(Array.isArray(detail.log) && detail.log.length > 0);
    const log = (await req(p.address, `/api/v1/jobs/${id}/logs?count=2`, { headers: authorized })).json.log;
    assert.equal(log.length, 2);
    const list = (await req(p.address, '/api/v1/jobs?type=image&status=done', { headers: authorized })).json.jobs;
    assert.equal(list.length, 1);
    const gallery = (await req(p.address, '/api/v1/gallery', { headers: authorized })).json.gallery;
    assert.equal(gallery[0].outputs[0].file, 'image_1.png');
    const file = await req(p.address, `/api/v1/jobs/${id}/file/image_1.png?download=1`, { headers: authorized });
    assert.equal(file.code, 200);
    assert.equal(file.body.readUInt32BE(0), 0x89504e47, 'PNG geldi');
    assert.match(file.headers['content-disposition'], /attachment/);
    assert.equal((await req(p.address, `/api/v1/jobs/${id}/file/image_1.png`)).code, 401, 'file route also requires the key');
    assert.equal((await req(p.address, `/api/v1/jobs/${id}/file/..%2Fis.json`, { headers: authorized })).code, 404);
    const again = await req(p.address, `/api/v1/jobs/${id}/retry`, { method: 'POST', headers: authorized });
    assert.equal(again.code, 400, 'finished job is not retried');
    assert.equal((await req(p.address, `/api/v1/jobs/${id}`, { method: 'DELETE', headers: authorized })).json.ok, true);
    const none = await req(p.address, `/api/v1/jobs/${id}`, { headers: authorized });
    assert.deepEqual([none.code, none.json.code], [404, 'notFound']);
    const queue = (await req(p.address, '/api/v1/queue', { headers: authorized })).json;
    assert.deepEqual([queue.active, queue.pending], [null, []]);

    // Yuklemeler: gorsel + muzik, listesi.
    const g = await req(p.address, '/api/v1/uploads/image?name=kare.png', { method: 'POST', headers: { ...authorized, 'Content-Type': 'image/png' }, body: makePng(32, 18) });
    assert.equal(g.code, 200);
    assert.match(g.json.image.source, /^upload\/\d{8}-\d{6}-kare\.png$/);
    const m = await req(p.address, '/api/v1/uploads/music?name=tema.mp3', { method: 'POST', headers: authorized, body: Buffer.from('ID3sahte') });
    assert.equal(m.code, 200);
    const uploads = (await req(p.address, '/api/v1/uploads', { headers: authorized })).json.uploads;
    assert.deepEqual(uploads.map((x) => x.type).sort(), ['image', 'music']);
    assert.ok((await req(p.address, '/api/v1/images', { headers: authorized })).json.images.some((x) => x.source === g.json.image.source));

    // Ayarlar: anahtar gorunur; niceleme secimi yalniz kuruluysa; secim graftaki dosya adini degistirir; anahtar yenileme.
    const settings = (await req(p.address, '/api/v1/settings', { headers: authorized })).json;
    assert.equal(settings.apiKey, key);
    assert.equal(settings.quantizations.qwen.defaultValue, 'Q4_K_M');
    assert.deepEqual(settings.quantizations.qwen.installed, [], 'no model file in the test environment');
    const red = await req(p.address, '/api/v1/settings', { method: 'PATCH', headers: { ...authorized, ...json }, body: JSON.stringify({ modelChoices: { qwen: 'Q8_0' } }) });
    assert.equal(red.code, 400);
    assert.match(red.json.error, /^Q8_0 files for .* are not installed/);
    mkdirSync(join(p.setting.modelRoot, 'diffusion_models'), { recursive: true });
    writeFileSync(join(p.setting.modelRoot, 'diffusion_models', 'qwen-image-2512-Q8_0.gguf'), 'fake');
    const accept = await req(p.address, '/api/v1/settings', { method: 'PATCH', headers: { ...authorized, ...json }, body: JSON.stringify({ modelChoices: { qwen: 'q8_0' } }) });
    assert.equal(accept.code, 200, accept.body.toString());
    assert.equal(accept.json.modelChoices.qwen, 'Q8_0');
    const select = (await req(p.address, '/api/v1/options', { headers: authorized })).json;
    assert.equal(select.imageModels[0].files[0], 'qwen-image-2512-Q8_0.gguf', 'selection is reflected in the generated graph');
    assert.equal(JSON.parse((await req(p.address, '/api/options')).body).imageModels[0].files[0], 'qwen-image-2512-Q8_0.gguf', 'the UI sees the same graph');
    const back = await req(p.address, '/api/v1/settings', { method: 'PATCH', headers: { ...authorized, ...json }, body: JSON.stringify({ modelChoices: { qwen: '' } }) });
    assert.equal(back.json.modelChoices.qwen, '', 'can be reverted');
    assert.equal((await req(p.address, '/api/v1/options', { headers: authorized })).json.imageModels[0].files[0], 'qwen-image-2512-Q4_K_M.gguf');
    const models = (await req(p.address, '/api/v1/models', { headers: authorized })).json;
    const dm = models.folders.find((x) => x.name === 'diffusion_models');
    assert.equal(dm.files[0].file, 'qwen-image-2512-Q8_0.gguf');
    assert.deepEqual(dm.files[0].user, [], 'selection reverted: Q8 not in use');
    const fresh = (await req(p.address, '/api/v1/settings/rotate-key', { method: 'POST', headers: authorized })).json.apiKey;
    assert.notEqual(fresh, key);
    assert.equal((await req(p.address, '/api/v1/status', { headers: authorized })).code, 401, 'old key is invalid');
    assert.equal((await req(p.address, '/api/v1/status', { headers: { Authorization: `Bearer ${fresh}` } })).code, 200);
    const authorized2 = { Authorization: `Bearer ${fresh}` };

    // ComfyUI: durum, bosalt, durdur (sahte kapatici).
    assert.equal((await req(p.address, '/api/v1/comfy', { headers: authorized2 })).json.running, true);
    assert.equal((await req(p.address, '/api/v1/comfy/flush', { method: 'POST', headers: authorized2 })).code, 200);
    assert.equal(p.fake.status.flushes, 1);
    // Baslat + hemen durdur: "başlatılıyor" kilidi kalkar, sonraki baslatma gercekten baslatir.
    assert.equal(p.queue.startComfy(), true);
    assert.equal(p.queue.startComfy(), false, 'no second start inside hazirBekleme');
    const stop = (await req(p.address, '/api/v1/comfy/stop', { method: 'POST', headers: authorized2 })).json;
    assert.deepEqual(stop.closed, [4242]);
    assert.equal(p.closings.length, 1);
    assert.equal(p.queue.startComfy(), true, 'restarts after stopping');

    // Sesler (ffmpeg varsa): yukle, listele, DELETE.
    if (p.setting.ffmpeg) {
      const { makeWav } = await import('../lib/media.mjs');
      const s = await req(p.address, '/api/v1/voices?name=ses.wav&voiceName=API%20sesi', { method: 'POST', headers: authorized2, body: makeWav(2) });
      assert.equal(s.code, 200, s.body.toString());
      assert.equal(s.json.voice.name, 'API sesi');
      assert.equal((await req(p.address, '/api/v1/voices', { headers: authorized2 })).json.voices.length, 1);
      assert.equal((await req(p.address, `/api/v1/voices/${s.json.id}`, { method: 'DELETE', headers: authorized2 })).code, 200);
      assert.equal((await req(p.address, `/api/v1/voices/${s.json.id}`, { method: 'DELETE', headers: authorized2 })).code, 404);
    }
  } finally {
    await p.close();
  }
});

test('scene writer API: chunked writing (15+ scenes) links the previous ones', async () => {
  const { scenePrompt } = await import('../lib/scene-writer.mjs');
  const i1 = scenePrompt({ topic: 'Tilki', sceneCount: 15, ratio: '16:9', startedAt: 16, total: 40, previous: ['Bir', 'İki'], title: 'Tilki' });
  assert.match(i1, /write only scenes 16 to 30 \(15 scenes\)/);
  assert.match(i1, /Last narrations of the previous scenes/);
  assert.match(i1, /the next chunk will continue/);
  const last = scenePrompt({ topic: 'Tilki', sceneCount: 10, ratio: '16:9', startedAt: 31, total: 40, previous: ['x'], title: 'Tilki' });
  assert.match(last, /This is the last chunk/);
  const p = await createPanel({ server: true });
  try {
    // Sahte yazar yok: yazi modeli de yok (test); sahne sayisi siniri 400 (Ingilizce; ?lang=tr ile sozlukten Turkce).
    const r = await req(p.address, '/api/v1/write-scenes', { method: 'POST', headers: { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'x', sceneCount: 2000 }) });
    assert.equal(r.code, 400);
    assert.match(r.json.error, /^Number of scenes can be at most 1000\./);
    const trRes = await req(p.address, '/api/v1/write-scenes?lang=tr', { method: 'POST', headers: { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'x', sceneCount: 2000 }) });
    assert.equal(trRes.code, 400);
    assert.match(trRes.json.error, /^Sahne sayısı en çok 1000/);
  } finally {
    await p.close();
  }
});

// 07.10.2026 kullanici: "Sahneleri yaz'a tiklayinca ilerleme gostergesine dusmuyor". Yazim kuyruga girmez (ekran
// kartini beklemez) ama calisirken /durum gorevler'inde ilerlemesiyle gorunur ve Kuyruk'tan iptal edilir.
test('scene writer: visible with its progress in /status gorevler while running, can be cancelled, per-scene time is measured', async () => {
  const p = await createPanel({ server: true });
  try {
    const b = { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' };
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
    let resume = null;
    const languages = [];
    p.setting.sceneWriter = async ({ sceneCount, lang, progress, signal }) => {
      languages.push(lang);
      progress({ written: 0, total: sceneCount });
      await new Promise((ok, red) => {
        resume = ok;
        signal?.addEventListener('abort', () => red(new Error('process killed')), { once: true });
      });
      progress({ written: sceneCount, total: sceneCount });
      return { title: 'Tilki', scenes: Array.from({ length: sceneCount }, (_, i) => ({ narration: `a${i}`, image: 'g', motion: 'h' })) };
    };
    // 1) Calisirken gorunur, bitince listeden cikar; sahne basi sure olculur
    const writing = req(p.address, '/api/v1/write-scenes', { method: 'POST', headers: b, body: JSON.stringify({ topic: 'Ormanda kaybolan tilki', sceneCount: 3, lang: 'en' }) });
    await wait(300);
    let d = (await req(p.address, '/api/v1/status', { headers: b })).json;
    assert.equal(d.tasks.length, 1, JSON.stringify(d.tasks));
    assert.equal(d.tasks[0].type, 'write-scenes');
    assert.equal(d.tasks[0].status, 'running');
    assert.equal(d.tasks[0].summary.title, 'Ormanda kaybolan tilki');
    assert.equal(d.tasks[0].progress.stage, '0/3 scenes written');
    assert.equal(d.tasks[0].progress.percent, null, 'progress is indeterminate without a measurement');
    resume();
    const r = await writing;
    assert.equal(r.code, 200, JSON.stringify(r.json));
    assert.equal(r.json.scenes.length, 3);
    assert.deepEqual(languages, ['en'], 'the film language reaches the writer');
    d = (await req(p.address, '/api/v1/status', { headers: b })).json;
    assert.deepEqual(d.tasks, [], 'removed from the list when done');
    assert.ok(d.averages['write-scenes'] > 0, `per-scene time measured: ${JSON.stringify(d.averages)}`);
    // 2) Olcum varken ilerleme tahmini; Kuyruk'taki Iptal sureci durdurur, istek Turkce hatayla doner
    const writing2 = req(p.address, '/api/v1/write-scenes', { method: 'POST', headers: b, body: JSON.stringify({ topic: 'İkinci', sceneCount: 2 }) });
    await wait(150);
    d = (await req(p.address, '/api/v1/status', { headers: b })).json;
    assert.equal(d.tasks.length, 1);
    assert.ok(d.tasks[0].progress.percent > 0, `estimate from measurement: ${JSON.stringify(d.tasks[0].progress)}`);
    const ip = await req(p.address, `/api/v1/tasks/${d.tasks[0].id}/cancel`, { method: 'POST', headers: b });
    assert.equal(ip.code, 200, JSON.stringify(ip.json));
    const r2 = await writing2;
    assert.equal(r2.code, 400);
    assert.match(r2.json.error, /^Scene writing was cancelled\./);
    d = (await req(p.address, '/api/v1/status', { headers: b })).json;
    assert.deepEqual(d.tasks, []);
    const none = await req(p.address, '/api/v1/tasks/gorev-yok/cancel', { method: 'POST', headers: b });
    assert.equal(none.code, 404);
  } finally {
    await p.close();
  }
});

test('lyric writer: prompt asks for sections by duration, response is tagged, API returns with the fake writer', async () => {
  const { lyricPrompt, parseLyricResponse, sectionPlan } = await import('../lib/lyricist.mjs');
  assert.match(sectionPlan(20), /^\[verse\] \(4 lines\) and \[chorus\]/);
  assert.match(sectionPlan(200), /\[outro\]/);
  assert.match(lyricPrompt({ topic: '', style: 'pop', language: 'en', duration: 60 }), /Topic: your choice[\s\S]*Language: English/);
  assert.equal(parseLyricResponse('tamam {"lyrics": "Bir satır\\nİki satır"}').lyrics, '[verse]\nBir satır\nİki satır');
  assert.equal(parseLyricResponse('{"lyrics": "[chorus]\\nla"}').lyrics, '[chorus]\nla');
  assert.throws(() => parseLyricResponse('{"lyrics": ""}'), /produced no lyrics/);
  const p = await createPanel({ server: true });
  try {
    let incoming;
    p.setting.lyricWriter = async (g) => ((incoming = g), { lyrics: '[verse]\nmerhaba' });
    const b = { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' };
    const r = await req(p.address, '/api/v1/write-lyrics', { method: 'POST', headers: b, body: JSON.stringify({ style: 'rock', duration: '30', lang: 'en' }) });
    assert.equal(r.code, 200);
    assert.equal(r.json.lyrics, '[verse]\nmerhaba');
    assert.deepEqual(incoming, { topic: '', style: 'rock', language: 'en', duration: 30 });
    const free = await req(p.address, '/api/v1/write-lyrics', { method: 'POST', headers: b, body: '{}' });
    assert.equal(free.code, 400);
    assert.match(free.json.error, /^Write a topic or a style for the lyrics\./);
  } finally {
    await p.close();
  }
});

test('PATCH /jobs/{id}: a new name for the cards (list, details, job record, database); empty name 400, unknown job 404', async () => {
  const p = await createPanel({ server: true });
  try {
    const job = await p.waitUntilDone(p.queue.add('image', { prompt: 'a red fox walking in the snowy forest', model: 'flux', ratio: '1:1' }).id);
    const b = { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' };
    const r = await req(p.address, `/api/v1/jobs/${job.id}`, { method: 'PATCH', headers: b, body: JSON.stringify({ title: 'Karda yürüyen tilki' }) });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.message, r.json.job.summary.title, r.json.job.summary.detail], ['Renamed.', 'Karda yürüyen tilki', job.summary.detail]);
    const list = await req(p.address, '/api/v1/jobs', { headers: b });
    assert.equal(list.json.jobs.find((x) => x.id === job.id).summary.title, 'Karda yürüyen tilki');
    assert.equal(JSON.parse(readFileSync(join(p.setting.outputRoot, job.id, 'job.json'), 'utf8')).summary.title, 'Karda yürüyen tilki');
    assert.equal(p.queue.db.jobs().find((x) => x.id === job.id).summary.title, 'Karda yürüyen tilki', 'the record in panel.db (read at the next start)');
    assert.equal(p.queue.jobs.get(job.id).input.prompt, 'a red fox walking in the snowy forest', 'the input stays');
    assert.equal((await req(p.address, `/api/v1/jobs/${job.id}`, { method: 'PATCH', headers: b, body: JSON.stringify({ title: '  ' }) })).code, 400);
    assert.equal((await req(p.address, '/api/v1/jobs/20990101-000000-image-ffff', { method: 'PATCH', headers: b, body: JSON.stringify({ title: 'x' }) })).code, 404);
  } finally {
    await p.close();
  }
});
