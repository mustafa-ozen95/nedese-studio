/**
 * Model yonetimi: listeleme (kullanan is akisi), silme kurallari, niceleme sarmalayici,
 * indirici (yerel sahte HTTP sunucusu: Range ile surdurme, iptal, boyut ve SHA-256 dogrulama).
 * Gercek model indirilmez, gercek dosya silinmez: her sey gecici klasorde.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserError } from '../lib/errors.mjs';
import { Downloader, StreamJudge } from '../lib/download.mjs';
import { fakeServer } from './fake-model-server.mjs';
import { CATALOG, usedFiles, installedModels, deleteModel, modelPath } from '../lib/models.mjs';
import { wrapModule, parseQuantization, quantizationOptions, applyQuantization } from '../lib/quantization.mjs';
import { loadComfyModule } from '../lib/settings.mjs';
import { REAL_COMFY } from './env.mjs';
import { request } from 'node:http';

const mod = await loadComfyModule(REAL_COMFY);

test('catalog: every entry is complete (url, bytes, sha256), ids are unique, file name matches the catalog', () => {
  const ids = new Set();
  for (const k of CATALOG) {
    // Hugging Face; MediaPipe yuz isaretleri Google'in resmi model deposundan (agiz duzeltme)
    assert.match(k.url, /^https:\/\/(huggingface\.co\/.+\/resolve\/main\/.+|storage\.googleapis\.com\/mediapipe-models\/.+)/, k.id);
    assert.ok(Number.isInteger(k.size) && k.size > 1e6, k.id);
    assert.match(k.sha256, /^[0-9a-f]{64}$/, k.id);
    // urlDosyasi: uzaktaki ad yereldekinden farkliysa (model klasorunde alt klasor yok: whisper/tiny.pt -> whisper-tiny.pt)
    assert.ok(k.url.endsWith(`/${k.urlFile ?? k.file}`), `${k.id}: url must end with the file name`);
    assert.ok(!ids.has(k.id));
    ids.add(k.id);
  }
  // Bu makinedeki gercek dosyalar katalogla ayni boyutta (indirme dogrulamasi gercekci).
  const root = join(REAL_COMFY, '..', '..', 'models');
  for (const k of CATALOG) {
    const y = join(root, k.folder, k.file);
    if (existsSync(y)) assert.equal(statSync(y).size, k.size, `${k.file} size matches the catalog`);
  }
});

test('installed models: workflow that uses them, quantization options, deletion rules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-panel-model-'));
  try {
    mkdirSync(join(root, 'diffusion_models'), { recursive: true });
    mkdirSync(join(root, 'loras'), { recursive: true });
    writeFileSync(join(root, 'diffusion_models', 'qwen-image-2512-Q4_K_M.gguf'), 'aaaa');
    writeFileSync(join(root, 'diffusion_models', 'qwen-image-2512-Q8_0.gguf'), 'bbbbbb');
    writeFileSync(join(root, 'diffusion_models', 'wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf'), 'c');
    writeFileSync(join(root, 'diffusion_models', 'baska.downloading'), 'x');
    const k = usedFiles(mod);
    assert.deepEqual(k['diffusion_models/qwen-image-2512-Q4_K_M.gguf'], ['qwenJob']);
    assert.deepEqual(k['diffusion_models/wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf'], ['wan14Job']);
    assert.ok(k['text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'].includes('wan14Job') && k['text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'].includes('wanJob'));
    const m = installedModels(root, mod);
    const dm = m.folders.find((x) => x.name === 'diffusion_models');
    assert.deepEqual(dm.files.map((d) => d.file), ['qwen-image-2512-Q4_K_M.gguf', 'qwen-image-2512-Q8_0.gguf', 'wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf'], 'partial file is not listed');
    assert.deepEqual(dm.files[0].user, ['Image: Qwen-Image 2512']);
    assert.deepEqual(dm.files[1].user, []);
    assert.equal(dm.totalByte, 11);
    assert.ok(m.disk.freeByte > 0);
    const s = quantizationOptions(root, mod);
    assert.deepEqual(s.qwen.installed, ['Q4_K_M', 'Q8_0']);
    assert.deepEqual(s.wan14.installed, [], 'Wan needs both High and Low');
    assert.equal(s.wan14.defaultValue, 'Q5_K_M');
    assert.deepEqual(parseQuantization('wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q8_0.gguf'), { family: 'wan14', quantization: 'Q8_0' });
    assert.equal(parseQuantization('flux-2-klein-4b-fp8.safetensors'), null);

    // Silme: kullanimda zorlamadan silinmez; zorla silinir; calisan isin dosyasi hic silinmez; yol disi reddedilir.
    await assert.rejects(() => deleteModel({ modelRoot: root, mod, folder: 'diffusion_models', file: 'qwen-image-2512-Q4_K_M.gguf', deletionMethod: 'permanent' }), (e) => e instanceof UserError && e.detail === 'inUse');
    assert.ok(existsSync(join(root, 'diffusion_models', 'qwen-image-2512-Q4_K_M.gguf')));
    await assert.rejects(() => deleteModel({ modelRoot: root, mod, folder: 'diffusion_models', file: 'qwen-image-2512-Q8_0.gguf', runningFiles: ['qwen-image-2512-Q8_0.gguf'], deletionMethod: 'permanent' }), /running job/);
    await deleteModel({ modelRoot: root, mod, folder: 'diffusion_models', file: 'qwen-image-2512-Q8_0.gguf', deletionMethod: 'permanent' });
    assert.ok(!existsSync(join(root, 'diffusion_models', 'qwen-image-2512-Q8_0.gguf')));
    await deleteModel({ modelRoot: root, mod, folder: 'diffusion_models', file: 'qwen-image-2512-Q4_K_M.gguf', zorla: true, deletionMethod: 'permanent' });
    assert.ok(!existsSync(join(root, 'diffusion_models', 'qwen-image-2512-Q4_K_M.gguf')));
    assert.throws(() => modelPath(root, 'diffusion_models', '..'), UserError);
    assert.throws(() => modelPath(root, 'bilinmeyen', 'x.gguf'), UserError);
    assert.throws(() => modelPath(root, 'vae', 'a/b.gguf'), UserError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quantization wrapper: only the GGUF name changes in the graph, the comfy.mjs file does not change, an empty selection touches nothing', () => {
  const choice = { qwen: 'Q8_0', wan14: 'Q6_K' };
  const g = applyQuantization(mod.wan14Job({ picture: 'k.png', text: 'm', seed: 1, prefix: 'v' }), choice);
  const names = Object.values(g).filter((d) => d.class_type === 'UnetLoaderGGUF').map((d) => d.inputs.unet_name).sort();
  assert.deepEqual(names, ['wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q6_K.gguf', 'wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q6_K.gguf']);
  assert.ok(!Object.values(g).some((d) => d.class_type === 'LoraLoaderModelOnly'), 'distilled model: no LoRA');
  let current = {};
  const wrapped = wrapModule(mod, () => current);
  assert.equal(wrapped.COMFY, mod.COMFY);
  assert.equal(Object.values(wrapped.qwenJob({ text: 'x', seed: 1, prefix: 'o' }))[0].inputs.unet_name, 'qwen-image-2512-Q4_K_M.gguf');
  current = { qwen: 'Q6_K' };
  assert.equal(Object.values(wrapped.qwenJob({ text: 'x', seed: 1, prefix: 'o' }))[0].inputs.unet_name, 'qwen-image-2512-Q6_K.gguf', 'selection is read live');
  assert.equal(Object.values(wrapped.fluxJob({ text: 'x', seed: 1, prefix: 'o' }))[0].inputs.unet_name, 'flux-2-klein-4b-fp8.safetensors');
  assert.match(readFileSync(REAL_COMFY, 'utf8'), /qwen-image-2512-Q4_K_M\.gguf/, 'comfy.mjs unchanged');
});

test('stream judge: a crawl against the best rate seen is cut; the expectation decays with every cut; nothing below the floor', () => {
  const j = new StreamJudge({ bucketMs: 1000, buckets: 3, floor: 1000, ratio: 0.15, probes: 1 });
  let t = 0;
  j.start(t);
  const bucket = (bytes) => j.feed(bytes, (t += 1000));
  // Nothing fast seen yet: one probe reconnection, then a slow line is accepted.
  bucket(100); bucket(100);
  assert.equal(bucket(100), 'slow stream (0.0 MB/s; trying a fresh connection)');
  j.cut(t);
  bucket(100); bucket(100);
  assert.equal(bucket(100), null, 'no probes left');
  j.start(t);
  assert.equal(bucket(20000), null, 'first bucket: 20 KB/s becomes the best');
  assert.equal(bucket(1000), null, 'window not full yet');
  assert.equal(bucket(1000), null);
  assert.match(bucket(1000), /^slow stream \(0\.0 MB\/s against 0\.0 MB\/s seen before\)$/, 'three slow buckets after the fast one');
  j.cut(t);
  assert.equal(j.best, 14000, 'expectation decayed by 30 %');
  assert.equal(bucket(2000), null, 'fresh window after the cut');
  assert.equal(bucket(2000), null);
  assert.match(bucket(2000), /^slow stream/, '2 KB/s is below 15 % of 14 KB/s');
  for (let n = 0; n < 8; n++) j.cut(t);
  assert.ok(j.best < 1000, 'after enough cuts the best falls below the floor');
  bucket(100); bucket(100); assert.equal(bucket(100), null, 'below the floor (and no probes left) nothing is cut');
});


const wait = (condition, ms = 10000) =>
  new Promise((ok, red) => {
    const startedAt = Date.now();
    const t = setInterval(() => {
      if (condition()) {
        clearInterval(t);
        ok();
      } else if (Date.now() - startedAt > ms) {
        clearInterval(t);
        red(new Error('expected state not reached'));
      }
    }, 20);
  });

test('downloader: byte counter, resume after disconnect (Range), SHA-256 and size verification, cancel, record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-panel-indir-'));
  const data = Buffer.alloc(300000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 251;
  const server = await fakeServer(data);
  try {
    const record = join(root, 'data', 'indirmeler.json');
    const logs = [];
    const ind = new Downloader({ modelRoot: join(root, 'models'), recordPath: record, stallMs: 500, retryDelayMs: 100, log: (s) => logs.push(s), slow: { bucketMs: 50, buckets: 3, floor: 1 } });
    assert.throws(() => ind.add({ url: 'ftp://x/y.gguf', folder: 'vae' }), /http/);
    assert.throws(() => ind.add({ url: `${server.address}/m.gguf`, folder: 'none' }), /Choose a model folder/);
    assert.throws(() => ind.add({ url: `${server.address}/m.exe`, folder: 'vae' }), /extensions/);
    assert.throws(() => ind.add({ catalog: 'yok-boyle' }), /Not in the catalog/);
    // First attempt: the server breaks the connection after 100000 bytes -> the segment resumes by itself (Range)
    // from the last byte written (segments.mjs; a retry inside the segment, not a record retry), SHA-256 checked below.
    server.status.cut = 100000;
    const i = ind.add({ url: `${server.address}/model.gguf`, folder: 'vae', expected: data.length, name: 'Deneme' });
    assert.ok(['queued', 'downloading'].includes(i.status));
    await wait(() => ['done', 'error'].includes(ind.find(i.id).status));
    const last = ind.find(i.id);
    assert.equal(last.status, 'done', last.error);
    assert.equal(last.retries, undefined, 'the segment resumed by itself');
    assert.ok(logs.some((s) => /Download model\.gguf: interrupted \(.*\); attempt 1\/6, resuming in 0 s\./.test(s)), logs.join('\n'));
    assert.ok(server.status.requests.some((r) => /^bytes=[1-9]\d+-\d+$/.test(r)), `resumed inside the segment: ${server.status.requests.join(' ')}`);
    const partial = join(root, 'models', 'vae', 'model.gguf.downloading');
    const target = join(root, 'models', 'vae', 'model.gguf');
    assert.ok(existsSync(target) && !existsSync(partial));
    assert.equal(statSync(target).size, data.length);
    assert.equal(last.downloaded, data.length);
    assert.equal(last.validated, createHash('sha256').update(data).digest('hex'));
    assert.equal(ind.summary(last).percent, 100);
    assert.ok(existsSync(record), 'state was written to disk');
    assert.throws(() => ind.add({ url: `${server.address}/model.gguf`, folder: 'vae' }), /already installed/);
    // A stream that stops delivering (CDN stall, 09.10.2026): cut after stallMs without data, resumed by itself.
    server.status.stall = 120000;
    const st = ind.add({ url: `${server.address}/stalled.gguf`, folder: 'vae', expected: data.length, name: 'Stall' });
    await wait(() => ['done', 'error'].includes(ind.find(st.id).status));
    assert.equal(ind.find(st.id).status, 'done', ind.find(st.id).error);
    assert.ok(logs.some((s) => /Download stalled\.gguf: interrupted \(no data for 1 s\); attempt 1\/6/.test(s)), logs.join('\n'));
    assert.equal(statSync(join(root, 'models', 'vae', 'stalled.gguf')).size, data.length);
    // A stream that only crawls (2 MB/s against 20 MB/s on a fresh connection, 09.10.2026): cut and reconnected at
    // once; this does not use up the retries.
    server.status.slow = 200000;
    const sl = ind.add({ url: `${server.address}/slow.gguf`, folder: 'vae', expected: data.length, name: 'Slow' });
    await wait(() => ['done', 'error'].includes(ind.find(sl.id).status));
    assert.equal(ind.find(sl.id).status, 'done', ind.find(sl.id).error);
    assert.ok(logs.some((s) => /slow\.gguf: slow stream \([\d.]+ MB\/s against [\d.]+ MB\/s seen before\); reconnecting \(1\/30\)/.test(s)), logs.join('\n'));
    assert.equal(ind.find(sl.id).retries, undefined, 'a slow cut is not a retry');
    assert.equal(statSync(join(root, 'models', 'vae', 'slow.gguf')).size, data.length);
    assert.equal(createHash('sha256').update(readFileSync(join(root, 'models', 'vae', 'slow.gguf'))).digest('hex'), createHash('sha256').update(data).digest('hex'));
    // Xet: CDN'in ETag'i SHA-256 sanilmaz; gercek ozet yonlendirmeden once okunur.
    const x = ind.add({ url: `${server.address}/hf/xet.gguf`, folder: 'vae' });
    await wait(() => ['done', 'error'].includes(ind.find(x.id).status));
    assert.equal(ind.find(x.id).status, 'done', ind.find(x.id).error);
    assert.equal(ind.find(x.id).validated, createHash('sha256').update(data).digest('hex'));
    // Yanlis sha256: dosya reddedilir, yarim silinir.
    const bad = ind.add({ url: `${server.address}/model2.gguf`, folder: 'vae', sha256: 'ab'.repeat(32) });
    await wait(() => ['done', 'error'].includes(ind.find(bad.id).status));
    assert.equal(ind.find(bad.id).status, 'error');
    assert.match(ind.find(bad.id).error, /SHA-256/);
    assert.ok(!existsSync(join(root, 'models', 'vae', 'model2.gguf')));
    // Yanlis beklenen boyut: sunucu boyutu farkli -> hata.
    const height = ind.add({ url: `${server.address}/model3.gguf`, folder: 'vae', expected: 12345 });
    await wait(() => ['done', 'error'].includes(ind.find(height.id).status));
    assert.match(ind.find(height.id).error, /size on the server differs/);
    // Sil: kayit ve yarim gider.
    ind.remove(height.id);
    assert.ok(!ind.list.some((x) => x.id === height.id));
    // Yeniden yukleme: "downloading" kalan kayit duraklatildi olur.
    writeFileSync(record, JSON.stringify([{ id: 'eski-1', name: 'x', url: `${server.address}/m4.gguf`, folder: 'vae', file: 'm4.gguf', status: 'downloading', downloaded: 10, expected: 100 }]));
    const ind2 = new Downloader({ modelRoot: join(root, 'models'), recordPath: record });
    assert.equal(ind2.find('eski-1').status, 'paused');
    // Katalogdan ekleme kaydi dogru kurar (gercek indirme yapilmaz: hemen iptal).
    const floor = ind2.add({ catalog: 'qwen-vae' });
    assert.deepEqual([floor.folder, floor.file, floor.expected], ['vae', 'qwen_image_vae.safetensors', 253806246]);
    ind2.cancel(floor.id);
    await wait(() => ind2.active === null, 5000);
    assert.equal(ind2.find(floor.id).status, 'cancelled');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('downloader API: start, progress, status list, record deletion (authorized request)', async () => {
  const { createPanel } = await import('./env.mjs');
  const data = Buffer.alloc(50000, 7);
  const server = await fakeServer(data);
  const p = await createPanel({ server: true });
  const authorized = { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body) =>
    new Promise((ok, red) => {
      const u = new URL(p.address);
      const r = request({ host: u.hostname, port: u.port, path: path, method: method, headers: authorized }, (y) => {
        let s = '';
        y.on('data', (x) => (s += x));
        y.on('end', () => ok({ code: y.statusCode, json: JSON.parse(s) }));
      });
      r.on('error', red);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  try {
    const b = await call('/api/v1/models/downloads', 'POST', { url: `${server.address}/kucuk.safetensors`, folder: 'loras' });
    assert.equal(b.code, 200, JSON.stringify(b.json));
    const id = b.json.download.id;
    await wait(() => p.downloader.find(id).status === 'done');
    const d = await call(`/api/v1/models/downloads/${id}`);
    assert.deepEqual([d.json.download.status, d.json.download.downloaded, d.json.download.percent], ['done', 50000, 100]);
    assert.ok(existsSync(join(p.setting.modelRoot, 'loras', 'kucuk.safetensors')));
    const floor = await call('/api/v1/models/catalog');
    assert.ok(floor.json.catalog.length > 15 && floor.json.catalog.every((k) => k.installed === false));
    assert.equal((await call('/api/v1/models/downloads')).json.downloads.length, 1);
    // "Varsayılan modelleri indir" (08.10.2026): katalogda is akislarinin kullandigi dosyalar varsayilan: true; eksik olanlar
    // tek istekle siraya alinir, zaten listedekiler atlanir. Gercek indirme baslamasin: ekle stub'lanir, sonra geri alinir.
    const defaults = floor.json.catalog.filter((k) => k.defaultValue);
    assert.ok(defaults.length >= 10 && defaults.length < floor.json.catalog.length, `default set: ${defaults.length}`);
    assert.ok(['qwen-vae', 'wan-umt5', 'flux2-vae'].every((k) => defaults.some((x) => x.id === k)));
    const addActual = p.downloader.add;
    const actualSummaries = p.downloader.summaries;
    const added = [];
    p.downloader.add = (g) => (added.push(g.catalog), { id: `sahte-${added.length}`, status: 'queued', catalog: g.catalog });
    const inList = defaults[0];
    p.downloader.summaries = () => [{ status: 'downloading', folder: inList.folder, file: inList.file }];
    try {
      const v = await call('/api/v1/models/downloads/defaults', 'POST');
      assert.equal(v.code, 200, JSON.stringify(v.json));
      assert.equal(added.length, defaults.length - 1, 'already listed ones are skipped');
      assert.ok(!added.includes(inList.id));
      assert.match(v.json.message, new RegExp(`^${defaults.length - 1} models queued \\(\\d+\\.\\d GB\\)\\. Voice and text models are installed by setup\\.bat\\.$`));
      assert.equal(v.json.downloads.length, defaults.length - 1);
      p.downloader.summaries = () => defaults.map((k) => ({ status: 'queued', folder: k.folder, file: k.file }));
      const v2 = await call('/api/v1/models/downloads/defaults', 'POST');
      assert.equal(v2.json.message, 'All default models are installed or already in the download list.');
      assert.equal(v2.json.downloads.length, 0);
    } finally {
      p.downloader.add = addActual;
      p.downloader.summaries = actualSummaries;
    }
    assert.equal((await call(`/api/v1/models/downloads/${id}`, 'DELETE')).code, 200);
    assert.equal((await call(`/api/v1/models/downloads/${id}`)).code, 404);
    assert.ok(existsSync(join(p.setting.modelRoot, 'loras', 'kucuk.safetensors')), 'finished file is not touched');
    const remove = await call('/api/v1/models/loras/kucuk.safetensors', 'DELETE');
    assert.equal(remove.code, 200, JSON.stringify(remove.json));
    assert.ok(!existsSync(join(p.setting.modelRoot, 'loras', 'kucuk.safetensors')));
    assert.equal((await call('/api/v1/models/loras/kucuk.safetensors', 'DELETE')).code, 404, 'unknown model gives 404');
  } finally {
    await p.close();
    await server.close();
  }
});

test('my own model: move locally (instant), copy (with progress), overwrite confirmation, extension; streamed upload from the browser', async () => {
  const { createPanel } = await import('./env.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const p = await createPanel({ server: true });
  const dis = mkdtempSync(join(tmpdir(), 'ai-panel-disardan-'));
  const authorized = { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body, headers = authorized) =>
    new Promise((ok, red) => {
      const u = new URL(p.address);
      const r = request({ host: u.hostname, port: u.port, path: path, method: method, headers: headers }, (y) => {
        let s = '';
        y.on('data', (x) => (s += x));
        y.on('end', () => ok({ code: y.statusCode, json: JSON.parse(s) }));
      });
      r.on('error', red);
      if (body) r.write(Buffer.isBuffer(body) ? body : JSON.stringify(body));
      r.end();
    });
  try {
    const data = Buffer.alloc(120000, 3);
    writeFileSync(join(dis, 'disardan.gguf'), data);
    writeFileSync(join(dis, 'yanlis.exe'), 'x');
    // Uzanti / yol denetimi.
    assert.equal((await call('/api/v1/models/add', 'POST', { path: join(dis, 'yanlis.exe'), folder: 'vae' })).code, 400);
    assert.equal((await call('/api/v1/models/add', 'POST', { path: 'goreli.gguf', folder: 'vae' })).code, 400);
    assert.equal((await call('/api/v1/models/add', 'POST', { path: join(dis, 'yok.gguf'), folder: 'vae' })).code, 400);
    // Kopyala: kaynak kalir, hedef ayni boyut, ilerleme listede.
    const k = await call('/api/v1/models/add', 'POST', { path: join(dis, 'disardan.gguf'), folder: 'loras', method: 'copy' });
    assert.equal(k.code, 200, JSON.stringify(k.json));
    assert.equal(k.json.download.type, 'local');
    await wait(() => p.downloader.find(k.json.download.id).status === 'done');
    assert.ok(existsSync(join(dis, 'disardan.gguf')), 'source remains when copying');
    assert.equal(statSync(join(p.setting.modelRoot, 'loras', 'disardan.gguf')).size, data.length);
    assert.equal(p.downloader.find(k.json.download.id).downloaded, data.length);
    // Ayni ad yeniden: ustune yazma onayi gerekir (409), onayla tasi: kaynak silinir.
    const red = await call('/api/v1/models/add', 'POST', { path: join(dis, 'disardan.gguf'), folder: 'loras' });
    assert.deepEqual([red.code, red.json.code], [409, 'inUse']);
    const t = await call('/api/v1/models/add', 'POST', { path: join(dis, 'disardan.gguf'), folder: 'loras', writeOnto: true });
    assert.equal(t.code, 200, JSON.stringify(t.json));
    await wait(() => ['done', 'error'].includes(p.downloader.find(t.json.download.id).status));
    assert.equal(p.downloader.find(t.json.download.id).status, 'done', p.downloader.find(t.json.download.id).error);
    assert.ok(!existsSync(join(dis, 'disardan.gguf')), 'source is deleted when moving');
    assert.ok(existsSync(join(p.setting.modelRoot, 'loras', 'disardan.gguf')));
    // Kaynak da model uzantili olmali: hedef adi degistirilerek belge / veritabani tasinamaz
    writeFileSync(join(dis, 'belge.txt'), 'hidden');
    const doc = await call('/api/v1/models/add', 'POST', { path: join(dis, 'belge.txt'), folder: 'vae', file: 'belge.safetensors' });
    assert.equal(doc.code, 400);
    assert.ok(existsSync(join(dis, 'belge.txt')));
    // Ayni dosya farkli harf buyuklugunle: "ustune yaz" kaynagi silmesin (Windows)
    if (process.platform === 'win32') {
      const same = await call('/api/v1/models/add', 'POST', { path: join(p.setting.modelRoot, 'LORAS', 'DISARDAN.GGUF'), folder: 'loras', file: 'disardan.gguf', writeOnto: true });
      assert.deepEqual([same.code, same.json.error], [400, 'The file is already in that folder.']);
      assert.equal(statSync(join(p.setting.modelRoot, 'loras', 'disardan.gguf')).size, data.length);
    }
    // Panel kurulumundaki dosya (or. yazi modeli) tasinmaz, kopyalanir: kurulum bozulmasin
    mkdirSync(join(p.setting.aiRoot, 'llm', 'models'), { recursive: true });
    writeFileSync(join(p.setting.aiRoot, 'llm', 'models', 'yazi.gguf'), 'gguf');
    const ic = await call('/api/v1/models/add', 'POST', { path: join(p.setting.aiRoot, 'llm', 'models', 'yazi.gguf'), folder: 'text_encoders' });
    assert.equal(ic.code, 200, JSON.stringify(ic.json));
    await wait(() => p.downloader.find(ic.json.download.id).status === 'done');
    assert.ok(existsSync(join(p.setting.aiRoot, 'llm', 'models', 'yazi.gguf')), 'source stays in place');
    assert.ok(existsSync(join(p.setting.modelRoot, 'text_encoders', 'yazi.gguf')));
    // Model klasorleri arasinda tasima serbest
    const search = await call('/api/v1/models/add', 'POST', { path: join(p.setting.modelRoot, 'text_encoders', 'yazi.gguf'), folder: 'vae' });
    await wait(() => p.downloader.find(search.json.download.id).status === 'done');
    assert.ok(!existsSync(join(p.setting.modelRoot, 'text_encoders', 'yazi.gguf')) && existsSync(join(p.setting.modelRoot, 'vae', 'yazi.gguf')));
    // Yeni dosya listede ve niceleme secimi olarak gorunur (ad desene uyuyorsa).
    writeFileSync(join(dis, 'qwen-image-2512-Q8_0.gguf'), 'q8');
    const q = await call('/api/v1/models/add', 'POST', { path: join(dis, 'qwen-image-2512-Q8_0.gguf'), folder: 'diffusion_models' });
    await wait(() => p.downloader.find(q.json.download.id).status === 'done');
    const settings = (await call('/api/v1/settings')).json;
    assert.deepEqual(settings.quantizations.qwen.installed, ['Q8_0']);
    const list = (await call('/api/v1/models')).json.folders.find((x) => x.name === 'diffusion_models').files.map((d) => d.file);
    assert.deepEqual(list, ['qwen-image-2512-Q8_0.gguf']);

    // Tarayicidan yukleme: ham govde akar; var olana 409; ustuneYaz=1 ile gecer; yanlis uzanti 400.
    const raw = { Authorization: authorized.Authorization, 'Content-Type': 'application/octet-stream' };
    const y = await call('/api/v1/models/upload?folder=vae&file=yuklenen.safetensors', 'POST', Buffer.alloc(70000, 9), raw);
    assert.equal(y.code, 200, JSON.stringify(y.json));
    assert.equal(statSync(join(p.setting.modelRoot, 'vae', 'yuklenen.safetensors')).size, 70000);
    assert.ok(!existsSync(join(p.setting.modelRoot, 'vae', 'yuklenen.safetensors.uploading')));
    const y2 = await call('/api/v1/models/upload?folder=vae&file=yuklenen.safetensors', 'POST', Buffer.alloc(10, 1), raw);
    assert.deepEqual([y2.code, y2.json.code], [409, 'inUse']);
    const y3 = await call('/api/v1/models/upload?folder=vae&file=yuklenen.safetensors&writeOnto=1', 'POST', Buffer.alloc(10, 1), raw);
    assert.equal(y3.code, 200);
    assert.equal(statSync(join(p.setting.modelRoot, 'vae', 'yuklenen.safetensors')).size, 10);
    assert.equal((await call('/api/v1/models/upload?folder=vae&file=kotu.exe', 'POST', Buffer.alloc(10, 1), raw)).code, 400);
    assert.equal((await call('/api/v1/models/upload?folder=vae&file=..%2Fx.gguf', 'POST', Buffer.alloc(10, 1), raw)).code, 400);
  } finally {
    await p.close();
    rmSync(dis, { recursive: true, force: true });
  }
});

test("downloader: two records for the same target — resuming the old one is refused, deleting it does not remove the active record's partial file; no resume over an installed file", () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-panel-cakisma-'));
  try {
    const ind = new Downloader({ modelRoot: join(root, 'm'), recordPath: join(root, 'indirmeler.json') });
    mkdirSync(join(root, 'm', 'vae'), { recursive: true });
    const partial = join(root, 'm', 'vae', 'a.safetensors.downloading');
    writeFileSync(partial, 'partial');
    ind.list = [
      { id: 'fresh', type: 'url', name: 'a', url: 'https://ornek.invalid/a.safetensors', folder: 'vae', file: 'a.safetensors', status: 'paused', downloaded: 5 },
      { id: 'old', type: 'url', name: 'a', url: 'https://ornek.invalid/a.safetensors', folder: 'vae', file: 'a.safetensors', status: 'error', downloaded: 0 },
    ];
    assert.throws(() => ind.resume('old'), /another entry for a\.safetensors \(paused\)/);
    assert.throws(() => ind.add({ url: 'https://ornek.invalid/a.safetensors', folder: 'vae' }), /already in the download list/);
    ind.remove('old');
    assert.ok(existsSync(partial), 'partial file of the active record is still there');
    ind.remove('fresh');
    assert.ok(!existsSync(partial), 'partial file goes when the last record is deleted');
    writeFileSync(join(root, 'm', 'vae', 'b.safetensors'), 'full');
    ind.list.push({ id: 'b', type: 'url', name: 'b', url: 'https://ornek.invalid/b.safetensors', folder: 'vae', file: 'b.safetensors', status: 'cancelled', downloaded: 0 });
    assert.throws(() => ind.resume('b'), /already installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
