/**
 * Model egitimi: sahte egit.py (asama ciktilari + ilerleme/sonuc/HATA satirlari), veri yukleme, egitilmis modeli
 * temel secme (sifirdan egitilmis model --devam ile, ince ayarli model QLoRA ile), hata iletimi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPanel } from './env.mjs';
import { makePng, makeWav } from '../lib/media.mjs';

const loadData = async (p, name, body) => {
  const r = await fetch(`${p.address}/api/v1/uploads/data?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Authorization: `Bearer ${p.settingFile.apiKey}` }, body: body });
  return { status: r.status, json: await r.json() };
};
const args = (file) => readFileSync(file, 'utf8').trim().split('\n').map((s) => JSON.parse(s));

test('job is rejected when model training is not installed', async () => {
  const p = await createPanel();
  try {
    assert.throws(() => p.queue.add('training', { name: 'x', dataItems: ['upload/a.txt'] }), /Model training not installed/);
  } finally {
    await p.close();
  }
});

test('model training: upload data, train from scratch, GGUF + sample; pick the trained model as base and continue', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'egitim-gunluk-')), 'arg.jsonl');
  const p = await createPanel({ server: true, trainingEnv: { FAKE_TRAINING_LOG: log } });
  try {
    // Yalniz metin bicimleri kabul edilir
    assert.equal((await loadData(p, 'program.exe', 'x')).status, 400);
    const y = await loadData(p, 'yazılar.jsonl', '{"prompt":"a","response":"b"}\n');
    assert.equal(y.status, 200, JSON.stringify(y.json));
    const source = y.json.data.source;
    assert.match(source, /^upload\/\d{8}-\d{6}-data-yazilar\.jsonl$/);

    // Dogrulama
    assert.throws(() => p.queue.add('training', { name: 'x', dataItems: [] }), /Upload at least one data file/);
    assert.throws(() => p.queue.add('training', { name: 'x', dataItems: [source], base: 'olmayan model' }), /Hugging Face name/);
    assert.throws(() => p.queue.add('training', { name: 'x', dataItems: [source], base: 'trained:yok' }), /trained model was not found/);
    assert.throws(() => p.queue.add('training', { name: 'x', dataItems: ['upload/../../gizli.txt'] }), /Invalid data file/);

    const job = p.queue.add('training', { name: 'Küçük yazar', method: 'scratch', dataItems: [source], examplePrompt: 'Merhaba?' });
    assert.deepEqual([job.input.size, job.input.epoch, job.input.context, job.input.quantization], ['small', 3, 512, 'Q8_0'], 'from-scratch defaults');
    assert.match(job.summary.detail, /from scratch · Small/);
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'done', last.error);
    const c = last.outputs.find((x) => x.type === 'training');
    assert.match(c.gguf, /^kucuk-yazar-trained-\d{8}-\d{6}-q8_0\.gguf$/, 'date + time: the same name on the same day does not clash');
    assert.ok(existsSync(join(p.root, 'llm', 'models', c.gguf)), 'GGUF llm\\modeller\'de');
    assert.deepEqual(c.examples.map((o) => o.prompt), ['Merhaba?', 'Panel hangi portta?'], 'user prompt + question from the data');
    assert.deepEqual(c.losses, [2.5, 2, 1.5]);
    const logLines = (await (await fetch(`${p.address}/api/v1/jobs/${job.id}`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json()).job.log;
    assert.ok(logLines.some((s) => /Data: 3 samples/.test(s)), 'data summary in the log');
    const first = args(log);
    assert.deepEqual(first.map((a) => a[0]), ['prepare', 'scratch', 'example', 'gguf'], 'sample before GGUF (the merged copy of the fine-tune is deleted afterwards)');
    assert.equal(first[3][first[3].indexOf('--quantization') + 1], 'Q8_0');

    // GET /egitim: egitilmis model listede, temel olarak secilebilir
    const info = await (await fetch(`${p.address}/api/v1/training`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json();
    assert.equal(info.installed, true);
    assert.equal(info.bases[0].id, 'Qwen/Qwen3-14B', 'recommended 14B comes first');
    const trained = info.trained.find((m) => m.name === 'Küçük yazar');
    assert.ok(trained?.id.startsWith('trained:'));

    // Sifirdan egitilmis modeli gelistir: LoRA degil, tum agirliklarla devam (--devam)
    const is2 = p.queue.add('training', { name: 'Küçük yazar 2', method: 'fine', base: trained.id, dataItems: [source], epoch: 1 });
    const last2 = await p.waitUntilDone(is2.id);
    assert.equal(last2.status, 'done', last2.error);
    const second = args(log).slice(4);
    assert.equal(second[1][0], 'scratch');
    assert.match(second[1][second[1].indexOf('--resume') + 1], /kucuk-yazar-\d{8}-\d{6}[\\/]hf$/);

    // Ince ayarli bir modelin uzerine yeniden ince ayar: temel olarak onun HF klasoru
    const is3 = p.queue.add('training', { name: 'Qwen yazar', dataItems: [source] });
    assert.equal(is3.input.base, 'Qwen/Qwen3-14B', 'fine-tune default base');
    assert.equal((await p.waitUntilDone(is3.id)).status, 'done');
    const qwen = (await (await fetch(`${p.address}/api/v1/training`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json()).trained.find((m) => m.name === 'Qwen yazar');
    const is4 = p.queue.add('training', { name: 'Qwen yazar 2', base: qwen.id, dataItems: [source] });
    assert.equal((await p.waitUntilDone(is4.id)).status, 'done');
    const fourth = args(log).at(-3);
    assert.equal(fourth[0], 'fine');
    // Gelistirme: ayni temel + onceki LoRA egitime devam eder; birlesik kopya saklanmaz
    assert.equal(fourth[fourth.indexOf('--base') + 1], 'Qwen/Qwen3-14B');
    assert.match(fourth[fourth.indexOf('--previous-adaptor') + 1], /qwen-yazar-\d{8}-\d{6}[\\/]adaptor$/);
    const qwenFolder = join(p.root, 'training', 'models', qwen.id.slice('trained:'.length));
    assert.ok(!existsSync(join(qwenFolder, 'hf')), 'merged copy of the fine-tune deleted');
    assert.ok(existsSync(join(qwenFolder, 'adaptor', 'adapter_config.json')), 'LoRA adapter kept');
  } finally {
    await p.close();
  }
});

test('model training: pause (process stops, GPU is freed), resume continues from the checkpoint', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'egitim-gunluk-')), 'arg.jsonl');
  const p = await createPanel({ server: true, trainingEnv: { FAKE_TRAINING_LOG: log, FAKE_TRAINING_STEP_MS: '300' } });
  const authority = { Authorization: `Bearer ${p.settingFile.apiKey}` };
  const req = async (path, method = 'GET') => {
    const r = await fetch(`${p.address}/api/v1${path}`, { method: method, headers: authority });
    return { status: r.status, json: await r.json() };
  };
  try {
    const source = (await loadData(p, 'veri.txt', 'Merhaba dünya.')).json.data.source;
    const job = p.queue.add('training', { name: 'Uzun eğitim', dataItems: [source] });
    await p.waitForState(() => /step [2-5]\/6/.test(p.queue.jobs.get(job.id).progress?.detail ?? ''));
    assert.equal((await req(`/jobs/${job.id}`)).json.job.pausable, true);
    const d = await req(`/jobs/${job.id}/pause`, 'POST');
    assert.equal(d.status, 200, JSON.stringify(d.json));
    const stopped = await p.waitUntilDone(job.id);
    assert.equal(stopped.status, 'paused');
    assert.equal(stopped.progress.stage, 'Paused');
    assert.equal(p.queue.active, null, 'no running job left: GPU is free');
    const point = join(p.root, 'training', 'models', stopped.trainingId, 'checkpoint.json');
    const left = JSON.parse(readFileSync(point, 'utf8')).step;
    assert.ok(left >= 2 && left < 6, `checkpoint step ${left}`);
    assert.equal((await req(`/jobs/${job.id}/pause`, 'POST')).status, 400, 'a paused job cannot be paused again');
    assert.equal((await req('/jobs?status=unfinished&page=1')).json.jobs.some((x) => x.id === job.id), true, 'among the unfinished');

    const proceed = await req(`/jobs/${job.id}/retry`, 'POST');
    assert.match(proceed.json.message, /where it left off/);
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'done', last.error);
    assert.ok((await req(`/jobs/${job.id}`)).json.job.log.some((s) => s.includes(`Going on from the checkpoint: step ${left}/6`)), 'continued from the step it left off at');
    assert.deepEqual(args(log).map((a) => a[0]), ['prepare', 'fine', 'fine', 'example', 'gguf'], 'data not prepared again');
    assert.ok(!existsSync(point), 'checkpoint deleted when done');
    assert.throws(() => p.queue.pause(job.id), /Only a running job/);
  } finally {
    await p.close();
  }
});

test('image LoRA training: images -> LoRA into the ComfyUI folder, record, sample images; in the Image job the LoRA is wired into the graph', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'gorsel-egitim-')), 'arg.jsonl');
  const p = await createPanel({ server: true, imageTrainingEnv: { FAKE_IMAGE_LOG: log } });
  try {
    const load = async (name) => (await loadData(p, name, Buffer.from('sahte görsel'))).json.data.source;
    const images = [await load('a.png'), await load('b.jpg'), await load('c.webp'), await load('a.txt')];
    // Dogrulama: gorsel disi veri, bosluklu tetik, yok
    const jsonl = (await loadData(p, 'x.jsonl', '{"a":1}\n')).json.data.source;
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'image', dataItems: [jsonl] }), /PNG\/JPEG\/WebP/);
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'image', dataItems: images, trigger: 'iki kelime' }), /Trigger word/);
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'image', dataItems: [] }), /at least 3 images/);
    const job = p.queue.add('training', { name: 'Nedese stili', field: 'image', dataItems: images, trigger: 'nedesestil', description: 'flat illustration', resolution: '768' });
    assert.deepEqual([job.input.method, job.input.base, job.input.rank, job.input.resolution], ['fine', 'flux2-klein-4b', '16', 768]);
    assert.match(job.summary.detail, /Image LoRA · FLUX\.2 klein 4B · trigger "nedesestil"/);
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'done', last.error);
    const c = last.outputs.find((x) => x.type === 'training');
    assert.match(c.lora, /^nedese-stili-\d{8}-\d{6}\.safetensors$/);
    assert.ok(existsSync(join(p.setting.modelRoot, 'loras', c.lora)), 'LoRA in the ComfyUI LoRA folder');
    assert.deepEqual(args(log).map((a) => a[0]), ['prepare', 'train']);
    const train = args(log)[1];
    assert.equal(train[train.indexOf('--resolution') + 1], '768');
    assert.match(train[train.indexOf('--vae') + 1], /flux2-vae\.safetensors$/);
    // Ornek gorseller: LoRA'siz ve LoRA'li (karsilastirma); LoRA'li grafta LoraLoaderModelOnly
    assert.deepEqual(last.outputs.filter((x) => x.type === 'image').map((x) => x.file), ['example-without-lora.png', 'example-with-lora.png']);
    const graphs = [...p.fake.status.requests.values()].map((x) => x.graph);
    assert.ok(graphs.some((gr) => Object.values(gr).some((d) => d.class_type === 'LoraLoaderModelOnly' && d.inputs.lora_name === c.lora)), 'LoRA in the sample graph');
    // GET /egitim: gorsel LoRA listede (tetik ile); Gorsel isinde secilir
    const info = await (await fetch(`${p.address}/api/v1/training`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json();
    const m = info.trained.find((x) => x.field === 'image');
    assert.deepEqual([m.lora, m.trigger], [c.lora, 'nedesestil']);
    assert.throws(() => p.queue.add('image', { prompt: 'kedi', model: 'qwen', lora: c.lora }), /trained for FLUX\.2 klein 4B/);
    // LoRA klasoru acilinca model klasoru var sayilir ve dosya denetimi calisir: FLUX.2 klein dosyalari (sahte)
    for (const [k, d] of [['diffusion_models', 'flux-2-klein-4b-fp8.safetensors'], ['text_encoders', 'qwen_3_4b_fp4_flux2.safetensors'], ['vae', 'flux2-vae.safetensors']]) {
      mkdirSync(join(p.setting.modelRoot, k), { recursive: true });
      writeFileSync(join(p.setting.modelRoot, k, d), 'x');
    }
    assert.throws(() => p.queue.add('image', { prompt: 'kedi', model: 'flux', lora: 'olmayan.safetensors' }), /not found/);
    const g = p.queue.add('image', { prompt: 'a cat on a sofa', model: 'flux', lora: c.lora, loraStrength: '0.8', translate: false });
    assert.match(g.summary.detail, /\+ Nedese stili/);
    const gs = await p.waitUntilDone(g.id);
    assert.equal(gs.status, 'done', gs.error);
    const graph = [...p.fake.status.requests.values()].at(-1).graph;
    const lora = Object.values(graph).find((d) => d.class_type === 'LoraLoaderModelOnly');
    assert.deepEqual([lora?.inputs.lora_name, lora?.inputs.strength_model], [c.lora, 0.8]);
    const redirecting = Object.values(graph).find((d) => d.class_type === 'CFGGuider');
    assert.equal(graph[redirecting.inputs.model[0]].class_type, 'LoraLoaderModelOnly', 'model is fed through the LoRA');
    assert.match(Object.values(graph).find((d) => d.class_type === 'CLIPTextEncode').inputs.text, /^nedesestil, /, 'trigger word at the start of the prompt');
  } finally {
    await p.close();
  }
});

test('music LoRA training: songs -> LoRA, record, sample songs; in the Music job the LoRA is wired to the turbo model, trigger at the start of the style', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'muzik-egitim-')), 'arg.jsonl');
  const p = await createPanel({ server: true, musicTrainingEnv: { FAKE_MUSIC_LOG: log } });
  try {
    const load = async (name) => (await loadData(p, name, Buffer.from('sahte ses'))).json.data.source;
    const songs = [await load('sarki1.mp3'), await load('sarki2.wav'), await load('sarki1.txt')];
    const png = await load('kapak.png');
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'music', dataItems: [png] }), /audio files/);
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'music', dataItems: [] }), /at least 2 songs/);
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'music', dataItems: songs, lang: 'xx' }), /Lyrics language/);
    const job = p.queue.add('training', { name: 'Nedese müziği', field: 'music', dataItems: songs, trigger: 'nedesemuzik', description: 'turkish pop, warm vocals', lang: 'tr', rank: '16' });
    assert.deepEqual([job.input.base, job.input.rank, job.input.lang], ['acestep-15', '16', 'tr']);
    assert.match(job.summary.detail, /Music LoRA · ACE-Step 1\.5 · trigger "nedesemuzik"/);
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'done', last.error);
    const c = last.outputs.find((x) => x.type === 'training');
    assert.match(c.lora, /^nedese-muzigi-\d{8}-\d{6}\.safetensors$/);
    assert.ok(existsSync(join(p.setting.modelRoot, 'loras', c.lora)));
    const arg = args(log);
    assert.deepEqual(arg.map((a) => a[0]), ['prepare', 'train']);
    assert.equal(arg[0][arg[0].indexOf('--language') + 1], 'tr');
    assert.deepEqual(last.outputs.filter((x) => x.type === 'voice').map((x) => x.file), ['example-without-lora.mp3', 'example-with-lora.mp3']);
    // Muzik isi: LoRA secilir, tetik tarzin basina, LoraLoaderModelOnly turbo UNETLoader'dan beslenir
    for (const [k, d] of [['diffusion_models', 'acestep_v1.5_turbo.safetensors'], ['text_encoders', 'qwen_0.6b_ace15.safetensors'], ['text_encoders', 'qwen_1.7b_ace15.safetensors'], ['vae', 'ace_1.5_vae.safetensors']]) {
      mkdirSync(join(p.setting.modelRoot, k), { recursive: true });
      writeFileSync(join(p.setting.modelRoot, k, d), 'x');
    }
    assert.throws(() => p.queue.add('music', { style: 'pop', lora: 'olmayan.safetensors' }), /not found/);
    const m = p.queue.add('music', { style: 'upbeat summer pop', lora: c.lora, loraStrength: '0.8', duration: 20, lang: 'en', translate: false });
    assert.match(m.summary.detail, /\+ Nedese müziği/);
    const ms = await p.waitUntilDone(m.id);
    assert.equal(ms.status, 'done', ms.error);
    const graph = [...p.fake.status.requests.values()].at(-1).graph;
    const lora = Object.values(graph).find((d) => d.class_type === 'LoraLoaderModelOnly');
    assert.deepEqual([lora?.inputs.lora_name, lora?.inputs.strength_model], [c.lora, 0.8]);
    const unet = Object.entries(graph).find(([, d]) => d.class_type === 'UNETLoader')[0];
    assert.equal(lora.inputs.model[0], unet);
    const encoder = Object.values(graph).find((d) => d.class_type === 'TextEncodeAceStepAudio1.5').inputs;
    assert.match(encoder.tags, /^nedesemuzik, upbeat summer pop/);
    assert.equal(encoder.language, 'en', 'the lyrics language of the API (lang) reaches ACE-Step');
    // Song edit: the title is on the cards, lang reaches ACE-Step, strength "much" as the API lists it
    writeFileSync(join(p.setting.outputRoot, ms.id, 'source.wav'), makeWav(3));
    const song = await p.waitUntilDone(p.queue.add('song', { source: `job/${ms.id}/source.wav`, style: 'lo-fi piano', title: 'Sakin yorum', strength: 'much', lang: 'en' }).id);
    assert.equal(song.status, 'done', song.error);
    assert.equal(song.summary.title, 'Sakin yorum');
    assert.equal(Object.values([...p.fake.status.requests.values()].at(-1).graph).find((d) => d.class_type === 'TextEncodeAceStepAudio1.5').inputs.language, 'en');
    // Kayitta olculmus onerilen guc varsa guc verilmeyen iste o kullanilir; verilen guc onceliklidir
    const recordFile = join(p.setting.aiRoot, 'training', 'models', 'registry.json');
    writeFileSync(recordFile, JSON.stringify(JSON.parse(readFileSync(recordFile, 'utf8')).map((x) => (x.lora === c.lora ? { ...x, recommendedStrength: 2 } : x))));
    assert.equal(p.queue.add('music', { style: 'pop', lora: c.lora, duration: 10, translate: false }).input.lora.strength, 2);
    // Arayuz onerilen gucu /egitim yanitindan okur (Muzik formu LoRA secilince gucu ona ayarlar)
    const trainingResponse = await (await fetch(`${p.address}/api/v1/training`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json();
    assert.equal(trainingResponse.trained.find((x) => x.lora === c.lora)?.recommendedStrength, 2);
    assert.equal(p.queue.add('music', { style: 'pop', lora: c.lora, loraStrength: '1', duration: 10, translate: false }).input.lora.strength, 1);
  } finally {
    await p.close();
  }
});

/** Video egitimi icin: Wan 2.2 5B dosyalari (yer tutucu), 2 sn'lik klip + altyazi + gorsel yuklenir. Doner: veri kaynaklari. */
async function videoData(p) {
  for (const [k, d] of [['diffusion_models', 'wan2.2_ti2v_5B_fp16.safetensors'], ['text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'], ['vae', 'wan2.2_vae.safetensors']]) {
    mkdirSync(join(p.setting.modelRoot, k), { recursive: true });
    writeFileSync(join(p.setting.modelRoot, k, d), 'x');
  }
  const clip = join(mkdtempSync(join(tmpdir(), 'video-egitim-')), 'klip.mp4');
  execFileSync(p.setting.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-t', '2', '-pix_fmt', 'yuv420p', clip]);
  const load = async (name, body) => (await loadData(p, name, body)).json.data.source;
  return [await load('klip.mp4', readFileSync(clip)), await load('klip.txt', 'a red ball bouncing'), await load('kare.png', makePng(64, 48))];
}

test('video LoRA training: clips into the ComfyUI dataset, sliced training (intermediate LoRA name _steps_), record, sample videos; in the Video job the LoRA only with 5B, trigger at the start of the prompt', async () => {
  const p = await createPanel({ server: true });
  try {
    const dataItems = await videoData(p);
    const voice = (await loadData(p, 'sarki.mp3', 'x')).json.data.source;
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'video', dataItems: [voice] }), /clips/);
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'video', dataItems, frame: '20' }), /Clip length/);
    const job = p.queue.add('training', { name: 'Nedese video', field: 'video', dataItems, trigger: 'nedesevideo', frame: '17', step: '200', rank: '8' });
    assert.deepEqual([job.input.base, job.input.resolution, job.input.frame, job.input.step, job.input.rank], ['wan22-5b', '480p', 17, 200, '8']);
    assert.match(job.summary.detail, /Video LoRA · Wan 2\.2 5B · trigger "nedesevideo"/);
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'done', last.error);
    // Dilimler 150 + 50: ikincisi birincinin LoRA'si ustune (TrainLoraNode adim sayisini addaki _<n>_steps_'ten okur)
    const loraName = `nedese-video-${job.id.slice(0, 15)}`;
    assert.deepEqual(p.fake.status.trainings.map((x) => [x.steps, x.existing_lora]), [[150, '[None]'], [50, `${loraName}-part_150_steps_.safetensors`]]);
    assert.ok(p.fake.status.trainings.every((x) => x.bypass_mode && x.checkpoint_depth === 2 && x.rank === 8 && x.learning_rate === 1e-4));
    // Ornekler ComfyUI input'ta isin alt klasorune: 2 sn klipten 17 karelik parca + tek kare gorsel, altyazilar tetikle
    const uploaded = p.fake.status.uploaded.filter((y) => y.startsWith(`aipanel-training-${job.id}/`));
    assert.deepEqual(uploaded.map((y) => y.split('/')[1]).sort(), ['0001.mp4', '0001.txt', '0002.mp4', '0002.txt']);
    const data = join(p.setting.outputRoot, job.id, 'data', 'clips');
    assert.equal(readFileSync(join(data, '0002.txt'), 'utf8'), 'nedesevideo, a red ball bouncing');
    const c = last.outputs.find((x) => x.type === 'training');
    assert.equal(c.lora, `${loraName}.safetensors`);
    assert.ok(existsSync(join(p.setting.modelRoot, 'loras', c.lora)));
    assert.ok(!readdirSync(join(p.setting.modelRoot, 'loras')).some((f) => f.includes('-ara_')), 'no intermediate LoRA left');
    assert.equal(c.losses.length, 200);
    assert.deepEqual(last.outputs.filter((x) => x.type === 'video').map((x) => x.file), ['example-without-lora.mp4', 'example-with-lora.mp4']);
    // Video isi: LoRA yalniz 5B ile; LoraLoaderModelOnly UNETLoader'dan, tetik istemin basinda
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261005-120000-kare.png'), makePng(160, 90));
    assert.throws(() => p.queue.add('video', { source: 'upload/20261005-120000-kare.png', model: 'wan14', lora: c.lora }), /Wan 2\.2 5B/);
    const v = await p.waitUntilDone(p.queue.add('video', { source: 'upload/20261005-120000-kare.png', prompt: 'slow push in', model: 'wan5', duration: 1, lora: c.lora, loraStrength: '0.7', translate: false }).id);
    assert.equal(v.status, 'done', v.error);
    assert.match(v.summary.detail, /\+ Nedese video/);
    const graph = [...p.fake.status.requests.values()].at(-1).graph;
    const lora = Object.values(graph).find((d) => d.class_type === 'LoraLoaderModelOnly');
    assert.deepEqual([lora?.inputs.lora_name, lora?.inputs.strength_model], [c.lora, 0.7]);
    assert.equal(lora.inputs.model[0], Object.entries(graph).find(([, d]) => d.class_type === 'UNETLoader')[0]);
    assert.ok(Object.values(graph).some((d) => d.class_type === 'CLIPTextEncode' && d.inputs.text === 'nedesevideo, slow push in'));
  } finally {
    await p.close();
  }
});

test('video LoRA training: pause in the second slice, resume continues from the intermediate LoRA without re-encoding the dataset', async () => {
  const p = await createPanel({ server: true, stepDuration: 15 });
  try {
    const dataItems = await videoData(p);
    const job = p.queue.add('training', { name: 'Long video', field: 'video', dataItems, frame: '17', step: '300' });
    await p.waitForState(() => /step 150\/300/.test(p.queue.jobs.get(job.id).progress?.stage ?? '') && /LoRA training · ([2-9]\d|1[0-3]\d)\/150/.test(p.queue.jobs.get(job.id).progress?.detail ?? ''));
    p.queue.pause(job.id);
    const stopped = await p.waitUntilDone(job.id);
    assert.equal(stopped.status, 'paused');
    const d = JSON.parse(readFileSync(join(p.setting.outputRoot, job.id, 'video-training.json'), 'utf8'));
    const search = `long-video-${job.id.slice(0, 15)}-part_150_steps_.safetensors`;
    assert.deepEqual([d.done, d.partLora, d.dataSet], [150, search, true]);
    assert.ok(existsSync(join(p.setting.modelRoot, 'loras', search)));
    p.queue.tryAgain(job.id);
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'done', last.error);
    const graphs = [...p.fake.status.requests.values()].map((x) => Object.values(x.graph).map((n) => n.class_type));
    assert.equal(graphs.filter((s) => s.includes('MakeTrainingDataset')).length, 1, 'dataset encoded once');
    assert.equal(graphs.filter((s) => s.includes('TrainLoraNode')).length, 3, 'interrupted slice ran again');
    assert.deepEqual(p.fake.status.trainings.map((x) => [x.steps, x.existing_lora]), [[150, '[None]'], [150, search]]);
    assert.equal(last.outputs.find((x) => x.type === 'training').losses.length, 300);
  } finally {
    await p.close();
  }
});

test('general model training: image + text -> GGUF and image encoder into llm\\modeller, record; sample response with image; image-aware in the text model list', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'genel-egitim-')), 'arg.jsonl');
  const p = await createPanel({ server: true, trainingEnv: { FAKE_TRAINING_LOG: log }, generalTrainingEnv: { FAKE_TRAINING_LOG: log } });
  try {
    const load = async (name, body) => (await loadData(p, name, body)).json.data.source;
    const dataItems = [await load('kedi.png', makePng(32, 32)), await load('kedi.txt', 'Turuncu bir kedi.'), await load('sorular.jsonl', '{"prompt":"Nedese nedir?","response":"Oyun sitesi."}\n')];
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'general', dataItems, base: 'Qwen/Qwen3-14B' }), /Base for the general model/);
    const job = p.queue.add('training', { name: 'Nedese genel', field: 'general', dataItems, imagePrompt: 'Ne görüyorsun?' });
    assert.deepEqual([job.input.base, job.input.method, job.input.quantization, job.input.epoch], ['Qwen/Qwen3.5-4B', 'fine', 'Q4_K_M', 2]);
    assert.match(job.summary.detail, /^General \(image \+ text\) · Qwen3\.5 4B · 3 data files/);
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'done', last.error);
    const arg = args(log);
    assert.deepEqual(arg.map((a) => a[0]), ['prepare', 'fine', 'example', 'mmproj', 'gguf'], 'image encoder before the text GGUF');
    assert.equal(arg[0][arg[0].indexOf('--prompt') + 1], 'Ne görüyorsun?');
    assert.equal(arg[1][arg[1].indexOf('--base') + 1], 'Qwen/Qwen3.5-4B');
    assert.equal(arg[2][arg[2].indexOf('--image-prompt') + 1], 'Ne görüyorsun?');
    const c = last.outputs.find((x) => x.type === 'training');
    assert.match(c.gguf, /^nedese-genel-trained-\d{8}-\d{6}-q4_k_m\.gguf$/);
    assert.equal(c.mmproj, `mmproj-${c.gguf}`);
    assert.ok(c.examples.some((o) => o.image && o.response), 'sample response with image');
    const llmFolder = join(p.root, 'llm', 'models');
    assert.ok(existsSync(join(llmFolder, c.gguf)) && existsSync(join(llmFolder, c.mmproj)));
    assert.ok(!existsSync(join(p.root, 'training', 'models', last.trainingId, 'hf')), 'merged copy deleted');
    const b = (await (await fetch(`${p.address}/api/v1/training`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json());
    assert.equal(b.generalInstalled, true);
    assert.ok(b.trained.some((m) => m.field === 'general' && m.gguf === c.gguf), 'listed for further training');
    // Liste: llm.bin olunca gorsel anlar ve --mmproj
    mkdirSync(join(p.root, 'llm', 'bin'), { recursive: true });
    writeFileSync(join(p.root, 'llm', 'bin', 'llama-server.exe'), '');
    const { findLlm } = await import('../lib/llm.mjs');
    assert.equal(findLlm(p.root, c.gguf).mmproj, join(llmFolder, c.mmproj));
  } finally {
    await p.close();
  }
});

test('model training: the HATA line of the script becomes the job error', async () => {
  const p = await createPanel({ server: true, trainingEnv: { FAKE_TRAINING_ERROR: 'fine' } });
  try {
    const source = (await loadData(p, 'veri.txt', 'Merhaba dünya.')).json.data.source;
    const last = await p.waitUntilDone(p.queue.add('training', { name: 'Failed', dataItems: [source] }).id);
    assert.equal(last.status, 'error');
    assert.match(last.error, /Not enough GPU memory/);
  } finally {
    await p.close();
  }
});

test('data-collection collection: downloaded images with their captions become image LoRA data; field match; media count in the list', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'koleksiyon-egitim-')), 'arg.jsonl');
  const p = await createPanel({ server: true, trainingEnv: {}, imageTrainingEnv: { FAKE_IMAGE_LOG: log } });
  try {
    const root = join(p.setting.aiRoot, 'data', 'collections', 'manzara');
    mkdirSync(join(root, 'media', 'images'), { recursive: true });
    writeFileSync(join(root, 'articles.jsonl'), '{"title":"x"}\n');
    writeFileSync(join(p.setting.aiRoot, 'data', 'collections', 'gizli.png'), makePng(8, 8));
    const records = [
      { url: 'https://ornek.invalid/1.png', text: 'Karlı dağ\n ve  göl', file: 'media/images/1.png' },
      { url: 'https://ornek.invalid/2.jpg', alt: 'gün batımı', file: 'media/images/2.jpg' },
      { url: 'https://ornek.invalid/3.webp', text: '', file: 'media/images/3.webp' },
      // Eski Commons kaydi: gizli Wikidata satirlari metne karismis, alt cizgili dosya adi
      { url: 'https://commons.invalid/wiki/File:6.jpg', alt: 'Siege_of_Belgrade_(Nándorfehérvár)_1456 label QS:Len,"Siege_of_Belgrade_(Nándorfehérvár)_1456" label QS:Lhu,"Nándorfehérvár ostroma"', subtitle: '', text: 'Siege_of_Belgrade_(Nándorfehérvár)_1456 label QS:Len,"Siege_of_Belgrade_(Nándorfehérvár)_1456"', file: 'media/images/6.png' },
      { url: 'https://ornek.invalid/4.png', text: 'indirilmemiş', file: null },
      { url: 'https://ornek.invalid/5.png', text: 'kaçak yol', file: 'media/../../gizli.png' },
      { url: 'https://ornek.invalid/1b.png', text: 'repeat', file: 'media/images/1.png' },
    ];
    for (const k of records.slice(0, 4)) writeFileSync(join(root, k.file), makePng(32, 32));
    writeFileSync(join(root, 'images.jsonl'), `${records.map((k) => JSON.stringify(k)).join('\n')}\n`);
    // Bos koleksiyon (yalniz meta, indirilmemis)
    mkdirSync(join(p.setting.aiRoot, 'data', 'collections', 'free'), { recursive: true });
    writeFileSync(join(p.setting.aiRoot, 'data', 'collections', 'free', 'articles.jsonl'), '{"title":"x"}\n');
    writeFileSync(join(p.setting.aiRoot, 'data', 'collections', 'free', 'images.jsonl'), '{"url":"https://ornek.invalid/a.png","text":"a","file":null}\n');

    // Listede indirilen medya sayisi (arayuz secenekleri buradan)
    const info = await (await fetch(`${p.address}/api/v1/training`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json();
    assert.deepEqual(info.collections.find((k) => k.id === 'manzara').media, { images: 4, videos: 0, audio: 0, captions: 0 });

    // Alan uyumu: gorselde ses koleksiyonu, metinde medya, indirilmemis medya
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'image', dataItems: ['collection/manzara/audio'] }), /Image training uses the image or captioned image files of the collection/);
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'text', dataItems: ['collection/manzara/images'] }), /Invalid data file/);
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'image', dataItems: ['collection/free/images'] }), /No downloaded image files in collection "free"/);
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'image', dataItems: ['collection/../images'] }), /Invalid/);

    const job = p.queue.add('training', { name: 'Manzara', field: 'image', dataItems: ['collection/manzara/images'], trigger: 'manzarastil' });
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'done', last.error);
    // Hazirlik betigine koleksiyon klasoru gider: 4 indirilmis gorsel (tekrar, indirilmemis, kok disi atlanir), 3 altyazi
    // (eski kaydin altyazisi temizlenmis: Wikidata satiri yok, alt cizgi bosluk)
    const summary = JSON.parse(readFileSync(join(p.queue.folder(job.id), 'data', 'summary.json'), 'utf8'));
    assert.deepEqual([summary.image, summary.captioned, summary.captions.sort()], [4, 3, ['Karlı dağ ve göl', 'Siege of Belgrade (Nándorfehérvár) 1456', 'gün batımı']]);
    assert.match(readFileSync(join(p.queue.folder(job.id), 'log.txt'), 'utf8'), /Data: 4 images \(3 captioned\)/);
    assert.ok(!existsSync(join(p.queue.folder(job.id), 'collection')), 'preparation folder deleted after preparation');
    assert.ok(existsSync(join(root, 'media', 'images', '1.png')), 'original collection files still in place');
  } finally {
    await p.close();
  }
});

test('image captioning: the text model captions collection images with a hint, resumes where it left off; captions serve as training captions', async () => {
  const { fileURLToPath } = await import('node:url');
  const { createServer } = await import('node:net');
  const { LocalLlm } = await import('../lib/llm.mjs');
  const FAKE = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
  const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
  const llm = new LocalLlm({ info: { name: 'fake', image: false, command: (prt) => ({ command: process.execPath, args: [FAKE, String(prt)] }) }, port, readySec: 20 });
  const log = join(mkdtempSync(join(tmpdir(), 'betim-egitim-')), 'arg.jsonl');
  const p = await createPanel({ llm, imageTrainingEnv: { FAKE_IMAGE_LOG: log } });
  try {
    const setup = (id, records) => {
      const root = join(p.setting.aiRoot, 'data', 'collections', id);
      mkdirSync(join(root, 'media', 'images'), { recursive: true });
      for (const k of records) writeFileSync(join(root, k.file), makePng(1200, 800));
      writeFileSync(join(root, 'images.jsonl'), `${records.map((k) => JSON.stringify(k)).join('\n')}\n`);
      return root;
    };
    const root = setup('betim-deneme', [
      { url: 'https://commons.invalid/1', alt: 'Siege_of_Belgrade_1456 label QS:Len,"x"', caption: '', file: 'media/images/1.png' },
      { url: 'https://commons.invalid/2', alt: 'BOZUK görsel', file: 'media/images/2.png' },
      { url: 'https://commons.invalid/3', file: 'media/images/3.png' },
    ]);
    // Betimlenmemis koleksiyon egitimde secilemez; gecersiz koleksiyon
    assert.throws(() => p.queue.add('training', { name: 'x', field: 'image', dataItems: ['collection/betim-deneme/captions'] }), /Collection "betim-deneme" has no captioned images/);
    assert.throws(() => p.queue.add('describe', { collection: '../x' }), /Invalid collection/);
    assert.throws(() => p.queue.add('describe', { collection: 'yok-boyle' }), /Collection not found/);

    // Gorsel okumayan model: acik hata
    const doesNotRead = await p.waitUntilDone(p.queue.add('describe', { collection: 'betim-deneme' }).id, 30000);
    assert.equal(doesNotRead.status, 'error');
    assert.match(doesNotRead.error, /does not read images/);

    llm.info.image = true;
    const is1 = p.queue.add('describe', { collection: 'betim-deneme' });
    assert.equal(p.queue.runners.describe.textModelShares, true, 'captioning shares the text model (the bot is not held up)');
    const last1 = await p.waitUntilDone(is1.id, 60000);
    assert.equal(last1.status, 'done', last1.error);
    const lines = () => readFileSync(join(root, 'captions.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    const b1 = lines();
    assert.deepEqual(b1.map((b) => b.file), ['media/images/1.png', 'media/images/3.png'], 'BOZUK image skipped, job continued');
    // Gorsel kucultulmus JPEG olarak gitti (1200 px -> en cok 896), ipucu temizlenmis altyazi; Markdown ve "Betimleme:" atildi
    const byte = Number(/(\d+) bayt JPEG/.exec(b1[0].caption)?.[1]);
    assert.ok(byte > 0, b1[0].caption);
    assert.match(b1[0].caption, /^Sahte betim, \d+ bayt JPEG\. Soru: Bu görseli betimle\. İpucu: Siege of Belgrade 1456$/);
    assert.match(b1[1].caption, /İpucu: none$/, 'no hint for an image without a caption');
    assert.deepEqual([b1[0].language, b1[0].model, b1[0].hint], ['tr', 'fake', 'Siege of Belgrade 1456']);
    const logText = readFileSync(join(p.queue.folder(is1.id), 'log.txt'), 'utf8');
    assert.match(logText, /3 images; 0 already captioned, 3 to caption/);
    assert.match(logText, /media\/images\/2\.png: could not be captioned/);
    assert.match(logText, /Done: 2 images captioned, 1 could not be captioned/);

    // Kaldigi yerden: yalniz betimlenemeyen yeniden denenir
    const last2 = await p.waitUntilDone(p.queue.add('describe', { collection: 'betim-deneme' }).id, 60000);
    assert.equal(last2.status, 'done', last2.error);
    assert.match(readFileSync(join(p.queue.folder(last2.id), 'log.txt'), 'utf8'), /2 already captioned, 1 to caption/);
    assert.equal(lines().length, 2);

    // Listede betim sayisi; egitimde betim altyazi olur (betimlenmemis gorsel alinmaz)
    const { collections } = await import('../lib/jobs/data.mjs');
    assert.equal(collections(p.setting.aiRoot).find((k) => k.id === 'betim-deneme').media.captions, 2);
    const training = await p.waitUntilDone(p.queue.add('training', { name: 'Betimli', field: 'image', dataItems: ['collection/betim-deneme/captions'], trigger: 'betimstil' }).id, 60000);
    assert.equal(training.status, 'done', training.error);
    const summary = JSON.parse(readFileSync(join(p.queue.folder(training.id), 'data', 'summary.json'), 'utf8'));
    assert.equal(summary.image, 2);
    assert.ok(summary.captions.every((a) => a.startsWith('Sahte betim')), JSON.stringify(summary.captions));

    // Art arda 5 gorselde yanit yoksa is durur (model bozuk)
    setup('hep-bozuk', Array.from({ length: 6 }, (_, i) => ({ url: `https://x.invalid/${i}`, alt: `BOZUK ${i}`, file: `media/images/${i}.png` })));
    const broken = await p.waitUntilDone(p.queue.add('describe', { collection: 'hep-bozuk' }).id, 60000);
    assert.equal(broken.status, 'error');
    assert.match(broken.error, /did not respond on 5 consecutive images/);
  } finally {
    await llm.close();
    await p.close();
  }
});

test('captions: an image failing the topic check (uygun: false, Data Panel) does not enter training; the last record wins', async () => {
  const { readCaptions } = await import('../lib/jobs/training.mjs');
  const root = mkdtempSync(join(tmpdir(), 'betim-uygun-'));
  writeFileSync(join(root, 'captions.jsonl'), [
    { file: 'media/images/1.png', caption: 'Minyatür', language: 'tr', suitable: true },
    { file: 'media/images/2.png', caption: 'Düğün fotoğrafı', language: 'tr', suitable: false },
    { file: 'media/images/3.png', caption: 'Eski betim (denetimsiz)', language: 'tr' },
    { file: 'media/images/3.png', caption: 'Yeni betim: konu dışı', language: 'tr', suitable: false },
  ].map((b) => JSON.stringify(b)).join('\n'));
  assert.deepEqual([...readCaptions(root).keys()], ['media/images/1.png'], 'non-matching and later non-matching are excluded');
  assert.equal(readCaptions(root, null, { all: true }).size, 3);
});

test('captioning topic check: whether it matches the topic in the same call; non-matching is captioned but does not enter training and is not captioned again', async () => {
  const { fileURLToPath } = await import('node:url');
  const { createServer } = await import('node:net');
  const { LocalLlm } = await import('../lib/llm.mjs');
  const { splitControl } = await import('../lib/jobs/describe.mjs');
  const { readCaptions } = await import('../lib/jobs/training.mjs');
  const { collections } = await import('../lib/jobs/data.mjs');
  assert.deepEqual(splitControl('UYGUN\nBir minyatür.'), { suitable: true, text: 'Bir minyatür.' });
  assert.deepEqual(splitControl('**UYGUN DEĞİL**\nBir düğün fotoğrafı.'), { suitable: false, text: 'Bir düğün fotoğrafı.' });
  assert.deepEqual(splitControl('NOT RELEVANT\nA wedding photo.'), { suitable: false, text: 'A wedding photo.' });
  assert.deepEqual(splitControl('Uygunluk belirtmeden betim.'), { suitable: null, text: 'Uygunluk belirtmeden betim.' });
  const FAKE = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
  const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
  const llm = new LocalLlm({ info: { name: 'fake', image: true, command: (prt) => ({ command: process.execPath, args: [FAKE, String(prt)] }) }, port, readySec: 20 });
  const p = await createPanel({ llm });
  try {
    const root = join(p.setting.aiRoot, 'data', 'collections', 'minyatur-karisik');
    mkdirSync(join(root, 'media', 'images'), { recursive: true });
    const records = [
      { url: 'https://x.invalid/1', alt: 'Mohaç Muharebesi minyatürü', file: 'media/images/1.png' },
      { url: 'https://x.invalid/2', alt: 'ALAKASIZ düğün fotoğrafı', file: 'media/images/2.png' },
      { url: 'https://x.invalid/3', alt: 'Surname-i Hümayun', file: 'media/images/3.png' },
    ];
    for (const k of records) writeFileSync(join(root, k.file), makePng(400, 300));
    writeFileSync(join(root, 'images.jsonl'), `${records.map((k) => JSON.stringify(k)).join('\n')}\n`);
    writeFileSync(join(root, 'summary.json'), JSON.stringify({ name: 'Minyatür karışık', topic: 'Osmanlı minyatürleri' }));
    const job = p.queue.add('describe', { collection: 'minyatur-karisik' });
    assert.equal(job.input.topic, 'Osmanlı minyatürleri', 'topic from the collection; check on by default');
    assert.match(job.summary.detail, /topic check: Osmanlı minyatürleri/);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const lines = readFileSync(join(root, 'captions.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    assert.deepEqual(lines.map((b) => [b.file.slice(-5), b.suitable, b.caption.startsWith('Sahte betim')]), [['1.png', true, true], ['2.png', false, true], ['3.png', true, true]], 'decision line separated from the caption');
    assert.deepEqual([...readCaptions(root).keys()], ['media/images/1.png', 'media/images/3.png'], 'training does not take the non-matching');
    assert.equal(collections(p.setting.aiRoot).find((k) => k.id === 'minyatur-karisik').media.captions, 2);
    assert.match(readFileSync(join(p.queue.folder(job.id), 'log.txt'), 'utf8'), /1 off-topic \(excluded from training\); 2 usable captions in the collection/);
    assert.equal(last.outputs.at(-1).toTopicNonMatching, 1);
    // Yeniden: hepsi yapilmis (uymayan da yeniden sorulmaz); denetim kapatilabilir
    const iki = await p.waitUntilDone(p.queue.add('describe', { collection: 'minyatur-karisik', topicControl: false }).id, 30000);
    assert.equal(iki.input.topic, undefined, 'check off');
    assert.match(readFileSync(join(p.queue.folder(iki.id), 'log.txt'), 'utf8'), /3 already captioned, 0 to caption/);
  } finally {
    await p.close();
  }
});
