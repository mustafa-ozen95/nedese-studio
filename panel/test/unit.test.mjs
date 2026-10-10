/**
 * Pure computations: graph merging, timing/subtitles, friendly error mapping, reading headers.
 *   node --test panel/test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureStep, merge, nodeDurationSummary, nodes, encodingsBefore, modelFiles, addRife, orderedNodes } from '../lib/graph.mjs';
import { subtitleMetrics, subtitleSplit, timeSubtitles, writeAss, inputFps, scenePlan, writeSrt, wanFrame, timeChart } from '../lib/plan.mjs';
import { ComfyRuntimeError, ComfyValidationError, CancelError, UserError, ProcessError, friendlyError } from '../lib/errors.mjs';
import { imageSize, makePng, wavDuration, makeWav, orientation } from '../lib/media.mjs';
import { sourcePath, musicPath, splitLines, slug } from '../lib/jobs/common.mjs';
import { parseSceneResponse } from '../lib/scene-writer.mjs';
import { loadComfyModule, allowedHosts } from '../lib/settings.mjs';
import { cliPathScript, ensureCliOnPath } from '../lib/cli-path.mjs';
import { rifeTemplate } from '../lib/jobs/wan.mjs';
import { lastJobs } from '../lib/service.mjs';
import { REAL_COMFY } from './env.mjs';

const mod = await loadComfyModule(REAL_COMFY);

test('merge: 4 images in a single graph, model loaders once', () => {
  const graphs = [0, 1, 2, 3].map((i) => mod.qwenJob({ text: 'a fox', seed: 10 + i, width: 1664, height: 928, prefix: `panel/x/g${i + 1}` }));
  const { job, match } = merge(graphs);
  const count = (s) => nodes(job, s).length;
  assert.equal(count('UnetLoaderGGUF'), 1);
  assert.equal(count('CLIPLoader'), 1);
  assert.equal(count('VAELoader'), 1);
  assert.equal(count('CLIPTextEncode'), 1, 'positive prompt encoded once (cfg 1: zeroed negative conditioning)');
  assert.equal(count('ConditioningZeroOut'), 1, 'zeroed negative conditioning once');
  assert.equal(count('KSampler'), 4, 'her tohum ayri ornekleyici');
  assert.equal(count('SaveImage'), 4);
  const seeds = nodes(job, 'KSampler').map((id) => job[id].inputs.seed).sort();
  assert.deepEqual(seeds, [10, 11, 12, 13]);
  // Her grafin SaveImage'i kendi on ekine gider.
  graphs.forEach((g, i) => {
    const record = match[i][nodes(g, 'SaveImage')[0]];
    assert.equal(job[record].inputs.filename_prefix, `panel/x/g${i + 1}`);
  });
  assert.doesNotThrow(() => orderedNodes(job));
});

test('merge: scenes with different prompts share loaders, not encodings', () => {
  const g1 = mod.fluxJob({ text: 'castle', seed: 1, width: 1920, height: 1088, prefix: 'a' });
  const g2 = mod.fluxJob({ text: 'dragon', seed: 2, width: 1920, height: 1088, prefix: 'b' });
  const { job } = merge([g1, g2]);
  assert.equal(nodes(job, 'UNETLoader').length, 1);
  assert.equal(nodes(job, 'CLIPLoader').length, 1);
  assert.equal(nodes(job, 'CLIPTextEncode').length, 2, 'iki istem ayri kodlanir');
  assert.equal(nodes(job, 'ConditioningZeroOut').length, 2, 'her istemin sifir olumsuzu kendi kosulundan');
});

// Bir dugumun butun atalari (girdileri, onlarin girdileri ...)
const ancestors = (job, id, set = new Set()) => {
  for (const v of Object.values(job[id].inputs ?? {})) {
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && !set.has(v[0])) {
      set.add(v[0]);
      ancestors(job, v[0], set);
    }
  }
  return set;
};

// 07.10.2026: ComfyUI ciktiya yakin dugumu once calistirdigindan 5 gorselde metin kodlayici 5 kez yeniden yuklendi
// (16 GB RAM'de takas; 892 sn'nin 278'i cizim). Birlesik grafta her ornekleyici butun kodlamalari bekler.
test('merge: with different prompts all encodings first, then sampling (ConditioningAverage 1.0 gate)', () => {
  const graphs = ['a fox', 'a cat', 'a dog'].map((m, i) => mod.qwenJob({ text: m, seed: i, width: 928, height: 1664, prefix: `g${i}` }));
  const { job, match } = merge(graphs);
  const encoders = nodes(job, 'CLIPTextEncode');
  assert.equal(encoders.length, 3);
  assert.equal(nodes(job, 'ConditioningAverage').length, 2 + 3, 'chain (n-1) + one gate per sampler');
  graphs.forEach((g, i) => {
    const ks = match[i][nodes(g, 'KSampler')[0]];
    const gate = job[ks].inputs.positive[0];
    assert.equal(job[gate].class_type, 'ConditioningAverage');
    assert.equal(job[gate].inputs.conditioning_to_strength, 1, 'strength 1: conditioning numerically identical');
    assert.deepEqual(job[gate].inputs.conditioning_to, [match[i][nodes(g, 'CLIPTextEncode')[0]], 0], 'sampler gets its own prompt');
    for (const k of encoders) assert.ok(ancestors(job, ks).has(k), `sampler ${ks} waits for encoding ${k}`);
  });
  assert.doesNotThrow(() => orderedNodes(job));
  // Qwen-Image-Edit (karakter tutarliligi, anahtar kareler): ortak olumsuz kodlama da beklenir
  const d = ['make it night', 'add rain'].map((m, i) => mod.editJob({ pictures: ['k.png'], text: m, seed: i, width: 752, height: 1392, prefix: `d${i}` }));
  const b2 = merge(d).job;
  const k2 = nodes(b2, 'TextEncodeQwenImageEditPlus');
  assert.equal(k2.length, 3, '2 olumlu + ortak olumsuz');
  for (const ks of nodes(b2, 'KSampler')) for (const k of k2) assert.ok(ancestors(b2, ks).has(k), `edit sampler ${ks} waits for encoding ${k}`);
  // Ayni istem (tek kodlama) ve farkli metin kodlayicilar (kosul boyutu farkli): dokunulmaz
  const same = merge([0, 1].map((i) => mod.qwenJob({ text: 'x', seed: i, prefix: 'o' }))).job;
  assert.equal(nodes(same, 'ConditioningAverage').length, 0);
  const mixed = merge([mod.qwenJob({ text: 'x', seed: 1, prefix: 'a' }), mod.fluxJob({ text: 'y', seed: 2, prefix: 'b' })]).job;
  assert.equal(nodes(mixed, 'ConditioningAverage').length, 0, 'conditionings of different sizes are not mixed');
  // Flux (CFGGuider): pozitif kosul kapidan gecer
  const fl = merge(['castle', 'dragon'].map((m, i) => mod.fluxJob({ text: m, seed: i, prefix: `f${i}` }))).job;
  for (const id of nodes(fl, 'CFGGuider')) assert.equal(fl[fl[id].inputs.positive[0]].class_type, 'ConditioningAverage');
});

test('kodlamalarOnce: if an encoding depends on a sampler output (would be a cycle) the graph is left as is', () => {
  const job = {
    1: { class_type: 'CLIPLoader', inputs: { clip_name: 'q.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 0], text: 'a' } },
    3: { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['2', 0] } },
    4: { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
    5: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['1', 0], prompt: 'b', image1: ['4', 0] } },
    6: { class_type: 'KSampler', inputs: { positive: ['5', 0], negative: ['5', 0] } },
  };
  assert.equal(encodingsBefore(job), job);
});

test('dugumSureOzeti: under 1 s skipped, up to 12 nodes listed one by one, beyond that summed by class', () => {
  const cls = { 1: 'CLIPLoader', 2: 'KSamplerAdvanced', 3: 'KSamplerAdvanced', 4: 'SaveImage' };
  assert.equal(nodeDurationSummary([{ id: '1', sec: 0.4 }, { id: '2', sec: 156.2 }, { id: '3', sec: 137 }, { id: '4', sec: 14.6 }], cls), 'KSamplerAdvanced 156 · KSamplerAdvanced 137 · SaveImage 15');
  const cok = Array.from({ length: 15 }, (_, i) => ({ id: String(i), sec: 10 }));
  const s2 = Object.fromEntries(cok.map((x, i) => [x.id, i % 3 ? 'KSampler' : 'VAEDecode']));
  assert.equal(nodeDurationSummary(cok, s2), 'VAEDecode ×5 50 · KSampler ×10 100');
  assert.equal(nodeDurationSummary([], {}), '');
});

test('adimAyarla, modelDosyalari, rifeEkle (Wan 5B)', () => {
  const g = configureStep(mod.qwenJob({ text: 'x', seed: 1, prefix: 'o' }), 12);
  assert.equal(g[nodes(g, 'KSampler')[0]].inputs.steps, 12);
  assert.match(modelFiles(g)[0], /^qwen-image-.*\.gguf$/);
  const template = rifeTemplate(mod);
  assert.equal(template.class_type, 'RIFE VFI');
  const w = addRife(mod.wanJob({ picture: 'k.png', text: 'm', seed: 1, prefix: 'v' }), 2, template);
  const rife = nodes(w, 'RIFE VFI');
  assert.equal(rife.length, 1);
  assert.equal(w[rife[0]].inputs.multiplier, 2);
  assert.deepEqual(w[nodes(w, 'SaveImage')[0]].inputs.images, [rife[0], 0]);
  assert.doesNotThrow(() => orderedNodes(w));
});

test('sahnePlani: short narration is trimmed, medium is slowed down, long is extended', () => {
  const k = scenePlan({ narration: 2, frame: 81, fps: 16 });
  assert.equal(k.part, 1);
  assert.equal(k.truncate, true);
  assert.equal(k.target, 3.3);
  const o = scenePlan({ narration: 6, frame: 81, fps: 16 });
  assert.equal(o.part, 1);
  assert.equal(o.truncate, false);
  assert.ok(o.slowdown > 1.4 && o.slowdown <= 1.6, `yavaslatma ${o.slowdown}`);
  const u = scenePlan({ narration: 14, frame: 81, fps: 16 });
  assert.equal(u.part, 2, '14 sn anlatim iki parca ister');
  assert.ok(u.slowdown >= 1 && u.slowdown <= 1.6);
  // Devam parcasinin ilk karesi atilir: 2 parca = 161 kare.
  assert.equal(u.natural, Math.round((161 / 16) * 1e4) / 1e4);
  // Kirpmada giris hizi dogal hiz; yavaslatmada butun kareler hedefe yayilir.
  assert.equal(inputFps({ frameCount: 161, target: 3, naturalFps: 32, truncate: true }), 32);
  assert.ok(Math.abs(inputFps({ frameCount: 241, target: 7.3, naturalFps: 48, truncate: false }) - 241 / 7.3) < 1e-9);
});

test('zamanCizelgesi and wanKare', () => {
  const z = timeChart([4, 5, 6], 0.5);
  assert.deepEqual(z.starts, [0, 3.5, 8]);
  assert.equal(z.total, 14);
  assert.equal(timeChart([4, 5], 0).total, 9);
  assert.equal(wanFrame(5, 16), 81);
  assert.equal(wanFrame(5, 24), 121);
  assert.equal(wanFrame(3, 16), 49);
});

test('subtitles: line splitting, timing, SRT and ASS', () => {
  const p = subtitleSplit('Bir zamanlar, bloklardan örülmüş sonsuz dünyalar vardı. Minik kahramanlar oralarda kaleler kurar, ejderhalar evcilleştirirdi.', { lineLength: 30 });
  assert.ok(p.length >= 2);
  for (const part of p) {
    const lines = part.split('\n');
    assert.ok(lines.length <= 2);
    for (const s of lines) assert.ok(s.length <= 30, s);
  }
  const z = timeSubtitles(p, 1, 9);
  assert.equal(z[0].startedAt, 1);
  assert.equal(z.at(-1).last, 9);
  for (let i = 1; i < z.length; i++) assert.ok(Math.abs(z[i].startedAt - z[i - 1].last) < 0.002);
  const srt = writeSrt([{ startedAt: 1.5, last: 3.25, text: 'Merhaba\nDünya' }]);
  assert.equal(srt, '1\n00:00:01,500 --> 00:00:03,250\nMerhaba\nDünya\n');
  const ass = writeAss([{ startedAt: 61.5, last: 63, text: 'İki {satır}\nvar' }], { width: 720, height: 1280 });
  assert.match(ass, /PlayResX: 720/);
  assert.match(ass, /Dialogue: 0,0:01:01\.50,0:01:03\.00,Default,,0,0,0,,İki \(satır\)\\Nvar/);
  const portrait = subtitleMetrics(720, 1280);
  const landscape = subtitleMetrics(1280, 720);
  assert.ok(portrait.lineLength < landscape.lineLength, 'dikey videoda satir kisa');
});

test('friendly error mapping', () => {
  const missing = new ComfyValidationError({
    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
    node_errors: { 1: { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "unet_name: 'qwen-image-2512-Q8_0.gguf' not in []" }], class_type: 'UnetLoaderGGUF' } },
  });
  assert.match(friendlyError(missing).message, /Model file not found: qwen-image-2512-Q8_0\.gguf\. Download it in Settings > Models/);
  // MoGe (3D high quality) names its file model_name: the same clear message, not ComfyUI's "Value not in list" (10.10.2026)
  const moge = new ComfyValidationError({
    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
    node_errors: { 37: { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "model_name: 'moge_2_vitl_normal_fp16.safetensors' not in []" }], class_type: 'LoadMoGeModel' } },
  });
  assert.match(friendlyError(moge).message, /^Model file not found: moge_2_vitl_normal_fp16\.safetensors\. Download it in Settings > Models/);
  const oom = new ComfyRuntimeError({ exception_type: 'torch.OutOfMemoryError', exception_message: 'CUDA error: out of memory', node_type: 'KSamplerAdvanced' });
  assert.match(friendlyError(oom).message, /Not enough GPU memory \(KSamplerAdvanced\)/);
  const ram = new ComfyRuntimeError({ exception_message: '[enforce fail at alloc_cpu.cpp:121] DefaultCPUAllocator: not enough memory' });
  assert.match(friendlyError(ram).message, /Not enough system memory \(RAM\)/);
  const cutting = new ComfyRuntimeError({ exception_type: 'interrupted', exception_message: 'Interrupted' });
  assert.match(friendlyError(cutting).message, /stopped/);
  const voice = new ProcessError('voice', 1, ['Traceback (most recent call last):', 'FileNotFoundError: ref.wav']);
  assert.equal(friendlyError(voice).message, 'Voice-over failed: FileNotFoundError: ref.wav');
  const crash = new ProcessError('voice', 3221225477, ['...']);
  assert.match(friendlyError(crash).message, /crashed/);
  const closed = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.match(friendlyError(closed).message, /Could not connect to ComfyUI/);
  assert.equal(friendlyError(new CancelError()).message, 'Cancelled.');
  assert.equal(friendlyError(new UserError('Prompt cannot be empty.')).message, 'Prompt cannot be empty.');
});

test('measures from the header: WAV duration, PNG size, orientation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-panel-birim-'));
  try {
    writeFileSync(join(root, 'a.wav'), makeWav(2.5));
    assert.equal(wavDuration(join(root, 'a.wav')), 2.5);
    writeFileSync(join(root, 'a.png'), makePng(64, 36));
    assert.deepEqual(imageSize(join(root, 'a.png')), { width: 64, height: 36 });
    // JPEG: SOF'tan once ~420 KB ICC (APP2) bolumu; eskiden ilk 256 KB okunup "okunamadi" sayiliyordu
    const parts = [Buffer.from([0xff, 0xd8])];
    for (let i = 0; i < 7; i++) {
      const data = Buffer.alloc(60000, 0x41);
      const startedAt = Buffer.from([0xff, 0xe2, 0, 0]);
      startedAt.writeUInt16BE(data.length + 2, 2);
      parts.push(startedAt, data);
    }
    parts.push(Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]));
    writeFileSync(join(root, 'icc.jpg'), Buffer.concat(parts));
    assert.deepEqual(imageSize(join(root, 'icc.jpg')), { width: 800, height: 600 });
    assert.equal(orientation({ width: 1664, height: 928 }), 'landscape');
    assert.equal(orientation({ width: 928, height: 1664 }), 'portrait');
    assert.equal(orientation({ width: 1328, height: 1328 }), 'square');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source path only inside the panel folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-panel-kaynak-'));
  try {
    assert.throws(() => sourcePath(root, 'job/../../Windows/x.png'), UserError);
    assert.throws(() => sourcePath(root, 'upload/..\\..\\x.png'), UserError);
    assert.throws(() => sourcePath(root, 'C:/Windows/win.ini'), UserError);
    assert.throws(() => sourcePath(root, 'upload/yok.png'), /not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('if a comfy.mjs generator throws (model removed) the option is disabled and no job is created', async () => {
  const { generatorStatus } = await import('../lib/jobs/common.mjs');
  const video = await import('../lib/jobs/video.mjs');
  const fake = { ...mod, wanJob: () => { throw new Error('Wan 5B bu makinede yok (model silindi)'); } };
  assert.deepEqual(generatorStatus(fake, 'wanJob'), { available: false, reason: 'Wan 5B bu makinede yok (model silindi)' });
  assert.equal(generatorStatus(fake, 'wan14Job').available, true);
  assert.equal(generatorStatus({}, 'qwenJob').available, false);
  assert.throws(() => video.validate({ model: 'wan5', source: 'upload/x.png' }, { mod: fake, setting: { outputRoot: tmpdir() } }), /Wan 2\.2 5B \(light\) is not available on this machine: Wan 5B bu makinede yok/);
});

test('slug and line splitting', () => {
  assert.equal(slug('Çılgın Ejderha Şöleni!'), 'cilgin-ejderha-soleni');
  assert.equal(slug('   '), 'film');
  const long = Array.from({ length: 12 }, (_, i) => `Bu ${i + 1}. cümle biraz uzunca yazılmış bir cümledir.`).join(' ');
  const lines = splitLines(long, 220);
  assert.ok(lines.length >= 3);
  for (const s of lines) assert.ok(s.length <= 330);
  assert.equal(lines.join(' '), long);
});

test('scene writer response: extracts JSON from text, trims to the count, drops empties', () => {
  const raw = 'Tabii:\n{"title":"Tilki","scenes":[{"narration":"Bir","image":"a fox","motion":"walks"},{"narration":"","image":"x"},{"narration":"İki","image":"b"},{"narration":"Üç","image":"c"}]}\nBitti.';
  const r = parseSceneResponse(raw, 2);
  assert.equal(r.title, 'Tilki');
  assert.deepEqual(r.scenes.map((s) => s.narration), ['Bir', 'İki']);
  assert.equal(r.scenes[1].motion, '');
  assert.throws(() => parseSceneResponse('yanıt yok', 3), UserError);
  assert.throws(() => parseSceneResponse('{"scenes":[]}', 3), UserError);
});

test('music path: only an audio file in the uploads folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'muzik-'));
  try {
    mkdirSync(join(root, 'uploads'));
    writeFileSync(join(root, 'uploads', 'a-muzik-x.mp3'), 'x');
    writeFileSync(join(root, 'uploads', 'resim.png'), 'x');
    assert.equal(musicPath(root, 'upload/a-muzik-x.mp3'), join(root, 'uploads', 'a-muzik-x.mp3'));
    assert.throws(() => musicPath(root, 'upload/resim.png'), UserError);
    assert.throws(() => musicPath(root, 'upload/../x.mp3'), UserError);
    assert.throws(() => musicPath(root, 'job/1/a.mp3'), UserError);
    assert.throws(() => musicPath(root, 'upload/yok.mp3'), UserError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the nedese command goes on the user PATH at start when missing (an install moved by hand never ran setup)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-path-'));
  try {
    const scripts = [];
    const run = async (s) => {
      scripts.push(s);
      return 'added\r\n';
    };
    const logs = [];
    // no launcher, or not Windows: nothing is run
    assert.equal(await ensureCliOnPath(root, { run, platform: 'win32' }), false);
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'nedese.cmd'), '@echo off');
    assert.equal(await ensureCliOnPath(root, { run, platform: 'linux' }), false);
    assert.equal(scripts.length, 0);
    assert.equal(await ensureCliOnPath(root, { run, platform: 'win32', log: (m) => logs.push(m) }), true);
    assert.equal(scripts[0], cliPathScript(join(root, 'bin')));
    assert.match(logs[0], /bin was added to the user PATH; "nedese" works in new terminal windows\.$/);
    // already there: the script prints nothing and nothing is logged
    assert.equal(await ensureCliOnPath(root, { run: async () => '', platform: 'win32', log: (m) => logs.push(m) }), false);
    assert.equal(logs.length, 1);
    // a folder name with an apostrophe stays one PowerShell string
    assert.match(cliPathScript("C:\\Hasan's ai\\bin"), /^\$b = 'C:\\Hasan''s ai\\bin';/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allowed hosts: local only by default, 0.0.0.0 means the IPv4 addresses of the machine', () => {
  assert.deepEqual(allowedHosts('127.0.0.1'), ['127.0.0.1', 'localhost']);
  assert.deepEqual(allowedHosts('10.0.0.5'), ['127.0.0.1', 'localhost', '10.0.0.5']);
  const all = allowedHosts('0.0.0.0');
  assert.ok(all.includes('127.0.0.1') && all.every((a) => a === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(a)));
});

test('intermediate video encoder: nvenc arguments, no probing when x264 is preferred, x264 when ffmpeg is missing', async () => {
  const { encoderArgs, videoEncoder } = await import('../lib/ffmpeg.mjs');
  assert.deepEqual(encoderArgs('nvenc', 18, 'medium').slice(0, 2), ['-c:v', 'h264_nvenc']);
  assert.ok(encoderArgs('nvenc', 18).includes('19'), 'cq = crf + 1');
  assert.deepEqual(encoderArgs('x264', 16, 'fast'), ['-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p']);
  assert.equal(await videoEncoder('C:/none/ffmpeg.exe', 'x264'), 'x264');
  assert.equal(await videoEncoder('C:/none/ffmpeg.exe', 'automatic'), 'x264', 'broken ffmpeg: falls back to x264');
  assert.equal(await videoEncoder(null, 'nvenc'), 'x264');
});

test('subtitles with word timings: a line starts when its first word is spoken; on a count mismatch falls back to the character ratio', async () => {
  const { sceneWords } = await import('../lib/jobs/common.mjs');
  const parts = ['Bir iki üç', 'dört beş', 'altı'];
  // 6 kelime: ilk üçü hızlı, son üçü yavaş söyleniyor (karakter oranı bunu bilemez).
  const words = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [3, 3.5], [3.5, 4], [6, 7]];
  const z = timeSubtitles(parts, 10, 18, words);
  assert.deepEqual(z.map((p) => p.startedAt), [10, 13, 16]);
  assert.deepEqual(z.map((p) => p.last), [13, 16, 18]);
  const proportional = timeSubtitles(parts, 10, 18, [[0, 1]]);
  assert.equal(proportional[0].startedAt, 10);
  assert.notEqual(proportional[1].startedAt, 13, 'single-word transcript (mismatch) fell back to the character ratio');
  assert.deepEqual(timeSubtitles(parts, 10, 18, null), timeSubtitles(parts, 10, 18));
  // Parça kayması: ikinci parça birincinin süresi + 0,25 sn sonra; hız 2x süreleri yarıya böler.
  const dir = mkdtempSync(join(tmpdir(), 'kelime-'));
  try {
    const wav = (name, sec) => {
      const n = Math.round(24000 * sec);
      const b = Buffer.alloc(44 + n * 2);
      b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
      b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
      writeFileSync(join(dir, name), b);
      return join(dir, name);
    };
    const y = [wav('a.wav', 2), wav('b.wav', 1)];
    assert.deepEqual(sceneWords([[[0, 1]], [[0.5, 0.75]]], y, 1), [[0, 1], [2.75, 3]]);
    assert.deepEqual(sceneWords([[[0, 1]], [[0.5, 0.75]]], y, 2), [[0, 0.5], [1.38, 1.5]]);
    assert.equal(sceneWords([[[0, 1]], []], y, 1), null, 'null if a part has no transcript');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt translation: English left as is, left as is when there is no text model', async () => {
  const { isEnglish, makePromptEnglish } = await import('../lib/prompt-translate.mjs');
  assert.equal(isEnglish('The man takes off his sunglasses'), true);
  assert.equal(isEnglish('Gözlüğü çıkartsın'), false);
  assert.equal(isEnglish('gozlugu cikarsin'), false);
  assert.deepEqual(await makePromptEnglish('The camera slowly zooms in'), { prompt: 'The camera slowly zooms in', translated: false });
  const r = await makePromptEnglish('Gözlüğü çıkartsın');
  assert.deepEqual(r, { prompt: 'Gözlüğü çıkartsın', translated: false, error: 'no text model' });
});

test('part prompts: without a text model continuation parts do not repeat the action; lines are parts', async () => {
  const { partPrompts } = await import('../lib/prompt-translate.mjs');
  const single = await partPrompts('Gözlüğü çıkartsın', 3);
  assert.equal(single.prompts.length, 3);
  assert.equal(single.prompts[0], 'Gözlüğü çıkartsın');
  assert.ok(!single.prompts.slice(1).some((x) => x.includes('Gözlüğü')), 'continuation part does not repeat the action');
  const line = await partPrompts('yürüyor\ndönüp el sallıyor', 3);
  assert.deepEqual(line.prompts.slice(0, 2), ['yürüyor', 'dönüp el sallıyor']);
  assert.equal(line.prompts.length, 3);
  assert.deepEqual((await partPrompts('The camera slowly zooms in', 1)).prompts, ['The camera slowly zooms in']);
  assert.deepEqual((await partPrompts('kar yağıyor', 2, { translate: false })).prompts.length, 2);
});

// 07.10.2026 kullanici: "karakterleri disi-erkek farkini gozeterek konusturmak da lazim, sadece hikaye anlatan tek ses gibi degil".
test('character voices: dialogue parsing, character validation, gender/age of a library voice, voice selection, design description, pitch match', async () => {
  const { splitSpeech, validateCharacters, voiceAttribute, selectVoice, designSpec, pitchFit } = await import('../lib/characters.mjs');
  assert.deepEqual(splitSpeech('Elif: Pamuk!\n\n  Baba : Buradayım: korkma'), [{ who: 'Elif', text: 'Pamuk!' }, { who: 'Baba', text: 'Buradayım: korkma' }]);
  assert.deepEqual(splitSpeech(''), []);
  assert.deepEqual(splitSpeech([{ who: ' Elif ', text: ' Selam ' }]), [{ who: 'Elif', text: 'Selam' }]);
  assert.throws(() => splitSpeech('Merhaba', 2), /Scene 2: dialogue line 1 must be in the form "Name: words"/);
  assert.deepEqual(validateCharacters([{ name: 'Elif', gender: 'female', age: 'child' }, { name: 'Baba', gender: 'male' }], ['elif']), [{ name: 'Elif', gender: 'female', age: 'child', type: 'human', spec: '', voice: '' }, { name: 'Baba', gender: 'male', age: 'adult', type: 'human', spec: '', voice: '' }]);
  assert.throws(() => validateCharacters([{ name: 'Elif', gender: 'female' }], ['Elif', 'Baba']), /"Baba" speaks/);
  assert.throws(() => validateCharacters([{ name: 'Elif', gender: 'female' }, { name: 'elif', gender: 'female' }]), /listed twice/);
  // Turkce degerler (eski is kaydi, yazi modeli): ic deger Ingilizce
  assert.deepEqual(validateCharacters([{ name: 'Nine', gender: 'Kadın', age: 'yaşlı', type: 'insan' }]).map((k) => [k.gender, k.age, k.type]), [['female', 'old', 'human']]);
  // Kutuphane sesleri (gercek kutuphanedeki tariflere benzer): ad + tariften cinsiyet/yas
  assert.deepEqual(voiceAttribute({ name: 'Anlatıcı C2 (derin sinematik)', spec: 'A deep, resonant, authoritative male voice in his fifties' }), { gender: 'male', age: 'adult' });
  assert.deepEqual(voiceAttribute({ name: 'Yaşlı dede (masal anlatıcısı)', spec: 'A very old man in his eighties' }), { gender: 'male', age: 'old' });
  assert.deepEqual(voiceAttribute({ name: 'Turkish female narrator (LoRA)', spec: '' }), { gender: 'female', age: 'adult' });
  assert.deepEqual(voiceAttribute({ name: 'x', spec: 'A cheerful 8-year-old girl' }), { gender: 'female', age: 'child' });
  assert.deepEqual(voiceAttribute({ name: 'x', spec: 'A young woman in her twenties' }), { gender: 'female', age: 'young' });
  assert.equal(voiceAttribute({ name: 'x', spec: 'A cultured, articulate middle-aged British man' }).age, 'adult', 'middle-aged is not old');
  assert.equal(voiceAttribute({ name: 'My voice' }).gender, null);
  const voices = [
    { id: 'narrator', name: 'Anlatıcı', spec: 'adult male narrator' },
    { id: 'tok', name: 'Tok', spec: 'A deep adult man' },
    { id: 'own', name: 'My voice', ownVoice: true, spec: 'man' },
    { id: 'lora-female', name: 'Türkçe kadın anlatıcı', trained: true },
    { id: 'elif-eski', name: 'Elif (karakter)', gender: 'female', age: 'child', character: 'Elif' },
    { id: 'elif', name: 'Elif (karakter)', gender: 'female', age: 'child', character: 'Elif', neutral: true },
  ];
  const father = { name: 'Baba', gender: 'male', age: 'adult' };
  assert.equal(selectVoice({ character: father, voices, narratorId: 'narrator' }).id, 'tok');
  assert.equal(selectVoice({ character: father, voices, narratorId: 'narrator', used: new Set(['tok']) }), null, 'narrator, own voice and a voice given to another character are not selected');
  assert.equal(selectVoice({ character: { name: 'Anne', gender: 'female', age: 'adult' }, voices }), null, 'LoRA voice cannot change per line: not selected');
  assert.equal(selectVoice({ character: { name: 'elif', gender: 'female', age: 'child' }, voices }).id, 'elif', 'voice of the same-named character (same voice across the series)');
  // 07.10.2026: eski (yansiz olmayan, masal metni + "neseli" tarif) karakter tasarimi tonlamasini her replige tasiyordu: verilmez
  assert.equal(selectVoice({ character: { name: 'elif', gender: 'female', age: 'child' }, voices: voices.filter((s) => s.id !== 'elif') }), null, 'old character design is not selected, a new one is designed');
  assert.match(designSpec({ gender: 'female', age: 'child', spec: 'brave' }), /little girl[^;]*; neutral/, 'personality word (brave) does not enter the design');
  assert.match(designSpec({ gender: 'male', age: 'old', spec: 'a deep raspy voice' }), /old man.*; a deep raspy voice; neutral/);
  assert.match(designSpec({ gender: 'male', age: 'old' }), /old man/);
  assert.equal(pitchFit({ gender: 'female', age: 'child' }, 280), ' (in range)');
  assert.match(pitchFit({ gender: 'female', age: 'child' }, 140), /deeper than expected; 200-600 Hz/);
  assert.equal(pitchFit({ gender: 'female', age: 'child' }, 513), ' (in range)', 'calling child (measured 513 Hz) is fine');
  assert.match(pitchFit({ gender: 'male', age: 'adult' }, 230), /higher than expected; 70-175 Hz/);
});

// 07.10.2026 kullanici: "Konusurken yuzu donmus olmali diger karaktere, bosluga konusuyor gibi olmamali" (ilk diyalog
// filminde ikisi de kameraya bakip poz verdi).
test('dialogue layout: in a scene with lines the image prompt turns the speakers toward each other, the motion prompt writer knows the lines', async () => {
  const { sceneImagePrompt } = await import('../lib/jobs/film.mjs');
  const { partPrompts } = await import('../lib/prompt-translate.mjs');
  const { setTextModel } = await import('../lib/text-model.mjs');
  assert.equal(sceneImagePrompt({ image: 'a forest' }), 'a forest', 'repliksiz sahne aynen');
  // Not yoksa genel kural: kime sesleniyorsa ona doner, ifade sozlere uyar ("gozlerinin icine bakar" baba-kizi sevgili gibi gosterdi)
  assert.match(sceneImagePrompt({ image: 'a girl and her father in a forest.', dialogue: [{ who: 'Elif', text: 'a' }, { who: 'Baba', text: 'b' }] }), /^a girl and her father in a forest\. The characters who talk turn toward the one they address, with facial expressions that fit their words, not looking at the camera\.$/);
  assert.match(sceneImagePrompt({ image: 'a girl calling', dialogue: [{ who: 'Elif', text: 'Pamuk!' }] }), /turns toward the one they address, with a facial expression that fits the words, not looking at the camera/);
  // Yonetmen notu varsa (her sahnede, replik olmasa da) onun gorsel cumlesi
  assert.equal(sceneImagePrompt({ image: 'a forest at night.' }, { image: 'The girl lifts the lantern toward the trees, worried.' }), 'a forest at night. The girl lifts the lantern toward the trees, worried.');
  const prompts = [];
  setTextModel({ installed: true, req: async (_y, body) => (prompts.push(body.messages), { code: 200, json: { choices: [{ message: { content: '["the girl turns to the man and talks", "the man answers her"]' } }] } }) });
  try {
    const r = await partPrompts('kız babasına seslenir', 2, { context: { image: 'a girl and a bearded man', dialogue: [{ who: 'Elif', text: 'Baba!' }, { who: 'Baba', text: 'Buradayım.' }] } });
    assert.deepEqual(r.prompts, ['the girl turns to the man and talks', 'the man answers her']);
    const [system, user] = prompts[0];
    // Konusan dinleyene (ya da sahnede olmayanin yonune) doner; "gozlerinin icine bakar" kalkti (baba-kiz sevgili gibi gorundu)
    assert.match(system.content, /turns toward the one they talk to \(or toward where an absent addressee would be\) and speaks with natural mouth movement.*nobody looks at or talks to the camera/);
    assert.doesNotMatch(system.content, /looks into their eyes/);
    assert.match(system.content, /If director notes are given, act them out like a live-action film/);
    assert.match(user.content, /Scene image: a girl and a bearded man\nDialogue in this scene, in order \(speaker: line\):\nElif: "Baba!"\nBaba: "Buradayım\."/);
  } finally {
    setTextModel(null);
  }
});

test('scene writer response: characters (gender required, synonyms), lines only for listed characters; a non-speaking character is not returned', () => {
  const s = parseSceneResponse(JSON.stringify({
    title: 'Pamuk',
    characters: [{ name: 'Elif', gender: 'Female', age: 'Child', spec: 'bright' }, { name: 'Pamuk', gender: 'dişi', age: 'yavru' }, { name: 'Anne', gender: 'female' }, { name: 'Hayalet', gender: '?' }],
    scenes: [
      { narration: '', dialogue: [{ who: 'elif', text: 'Pamuk!' }, { who: 'Yabancı', text: 'x' }, { who: 'Pamuk', text: 'Miyav, buradayım!' }], image: 'g', motion: 'h' },
      { narration: 'Gece oldu.', image: 'g2' },
    ],
  }), 5);
  assert.deepEqual(s.characters, [{ name: 'Elif', gender: 'female', age: 'child', spec: 'bright' }, { name: 'Pamuk', gender: 'female', age: 'child', spec: '' }]);
  assert.deepEqual(s.scenes[0].dialogue, [{ who: 'Elif', text: 'Pamuk!' }, { who: 'Pamuk', text: 'Miyav, buradayım!' }]);
  assert.equal(s.scenes[1].dialogue, undefined);
});

// 07.10.2026 kullanici: "Claude cli olmaz, kendi sahip oldugu modeller ile olmali" (panelde giris yok: yerel agdan
// "Sahneleri yaz" bu bilgisayardaki Claude oturumunu kullandirabiliyordu). Butun yazi isleri yerel modelden.
test('text jobs only with the local model: scene/lyric writer waits for the GPU (JSON), in-job calls do not wait; no Claude path', async () => {
  const { setTextModel } = await import('../lib/text-model.mjs');
  const { writeScenes } = await import('../lib/scene-writer.mjs');
  const { writeLyrics } = await import('../lib/lyricist.mjs');
  const { musicStyles } = await import('../lib/music-plan.mjs');
  const { makePromptEnglish } = await import('../lib/prompt-translate.mjs');
  const sceneWriter = await import('../lib/scene-writer.mjs');
  const { loadSettings } = await import('../lib/settings.mjs');
  const requests = [];
  const responses = [];
  setTextModel({
    installed: true,
    req: async (path, body, option) => {
      requests.push({ path, body, option });
      return { code: 200, json: { choices: [{ message: { content: responses.shift() } }] } };
    },
  });
  try {
    responses.push(JSON.stringify({ title: 'Tilki', scenes: [{ narration: 'Bir tilki.', image: 'a fox', motion: 'runs' }, { narration: 'Eve döndü.', image: 'a home', motion: 'walks' }] }));
    const s = await writeScenes({ topic: 'fox', sceneCount: 2, ratio: '16:9' });
    assert.deepEqual(s.scenes.map((x) => x.narration), ['Bir tilki.', 'Eve döndü.']);
    assert.equal(requests[0].path, '/v1/chat/completions');
    // the answer's shape as a schema (a grammar): exactly the asked number of scenes, characters with the known values
    const format = requests[0].body.response_format;
    assert.equal(format.type, 'json_schema');
    assert.deepEqual([format.json_schema.schema.properties.scenes.minItems, format.json_schema.schema.properties.scenes.maxItems], [2, 2]);
    assert.deepEqual(format.json_schema.schema.properties.characters.items.properties.gender.enum, ['female', 'male']);
    assert.deepEqual(format.json_schema.schema.properties.scenes.items.required, ['narration', 'image', 'motion', 'dialogue']);
    assert.match(requests[0].body.messages[0].content, /narration: Turkish narrator text/, 'Turkish by default');
    assert.doesNotMatch(requests[0].body.messages[0].content, /\{L\}|English narrator/);
    assert.equal(requests[0].option.externalRequest, true, 'from the UI: waits for the GPU while a panel job is running');
    assert.equal(requests[0].option.waitSec, Infinity, 'scene writer waits indefinitely (cancel from Queue)');
    // an English film (the voice language): English title, narration and lines; narrator only: no characters asked
    responses.push(JSON.stringify({ title: 'Fox', scenes: [{ narration: 'A fox.', image: 'a fox', motion: 'runs' }] }));
    await writeScenes({ topic: 'fox', sceneCount: 1, ratio: '16:9', speech: false, lang: 'en' });
    const english = requests.pop().body;
    assert.match(english.messages[0].content, /title: English, at most 60/);
    assert.match(english.messages[0].content, /narration: English voice-over text/);
    assert.doesNotMatch(english.messages[0].content, /Turkish/);
    assert.equal('characters' in english.response_format.json_schema.schema.properties, false);
    assert.deepEqual(english.response_format.json_schema.schema.properties.scenes.items.required, ['narration', 'image', 'motion']);
    responses.push(JSON.stringify({ lyrics: '[verse]\nla la' }));
    assert.equal((await writeLyrics({ topic: 'deniz', style: 'pop', language: 'tr', duration: 30 })).lyrics, '[verse]\nla la');
    assert.deepEqual([requests[1].option.externalRequest, requests[1].option.waitSec], [true, 600]);
    responses.push(JSON.stringify({ general: 'calm piano', sections: ['tense strings'] }));
    await musicStyles({ style: '', sections: [{ duration: 10, narrations: ['x'] }] });
    responses.push('The cat swings a sword.');
    assert.equal((await makePromptEnglish('Kedi kılıç sallasın')).prompt, 'The cat swings a sword.');
    assert.deepEqual(requests.slice(2).map((x) => x.option.externalRequest), [false, false], 'from inside a job (music plan, translation) does not wait');
    // Iptal: istek gitmeden kesilir
    const d = new AbortController();
    d.abort();
    await assert.rejects(writeScenes({ topic: 'x', sceneCount: 1, ratio: '16:9', signal: d.signal }), { name: 'CancelError' });
    // Claude cagrisi kaldirildi
    assert.equal(sceneWriter.runClaude, undefined);
    assert.equal('claudePath' in loadSettings({}), false, 'no Claude path in settings');
  } finally {
    setTextModel(null);
  }
  await assert.rejects(writeScenes({ topic: 'x', sceneCount: 1, ratio: '16:9' }), /The text model is not installed; write the scenes yourself/);
});

test('local model: a JSON object request goes to llama-server as an object schema (it ignores json_object)', async () => {
  const { localFormat } = await import('../lib/llm.mjs');
  const body = { messages: [], temperature: 0.2, response_format: { type: 'json_object' } };
  assert.deepEqual(localFormat(body), { messages: [], temperature: 0.2, response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } } });
  assert.deepEqual(body.response_format, { type: 'json_object' }, 'the caller\'s body is not changed');
  const schema = { type: 'json_schema', json_schema: { name: 'plan', schema: { type: 'object', properties: { a: { type: 'string' } } } } };
  assert.equal(localFormat({ response_format: schema }).response_format, schema, 'a schema goes as it is');
  const plain = { messages: [] };
  assert.equal(localFormat(plain), plain);
});

test("pronunciation: apostrophized proper nouns soften in speech (Kuzguncuk\'u -> Kuzguncuğu), exceptions untouched", async () => {
  const { fixPronunciation } = await import('../lib/pronunciation.mjs');
  assert.equal(fixPronunciation("Bugün Kuzguncuk'u anlatacağım."), 'Bugün Kuzguncuğu anlatacağım.');
  assert.equal(fixPronunciation("Zonguldak'a ve Sinop'a"), 'Zonguldağa ve Sinoba');
  for (const same of ["Türk'ü", "Ahmet'e", "Facebook'u", "Kuzguncuk'tan", "Erzincan'ı", "İstanbul'un"]) assert.equal(fixPronunciation(same), same);
});

test('body writing: a second upload to the same file is rejected (the first file is not deleted), -2 suffix for a taken name, large Content-Length rejected up front', async () => {
  const { PassThrough, Readable } = await import('node:stream');
  const { existsSync, readFileSync } = await import('node:fs');
  const { freePath, writeBody } = await import('../lib/request.mjs');
  const root = mkdtempSync(join(tmpdir(), 'govde-'));
  const req = (parts, headers = {}) => Object.assign(Readable.from(parts), { headers: headers });
  try {
    const path = join(root, 'a.bin');
    const first = Object.assign(new PassThrough(), { headers: {} });
    const s1 = writeBody(first, path, 1e6);
    first.write(Buffer.alloc(10, 1));
    await assert.rejects(writeBody(req([Buffer.alloc(5, 2)]), path, 1e6), (e) => e.detail === 'inUse');
    assert.equal(freePath(root, 'a.bin'), join(root, 'a-2.bin'), 'a name being written counts as taken');
    first.end(Buffer.alloc(10, 1));
    assert.equal(await s1, 20);
    assert.equal(readFileSync(path).length, 20, 'second upload did not delete the first file');
    assert.equal(freePath(root, 'a.bin'), join(root, 'a-2.bin'), 'a name on disk counts as taken');
    assert.equal(freePath(root, 'yeni.bin'), join(root, 'yeni.bin'));
    await assert.rejects(writeBody(req([], { 'content-length': '2000000' }), join(root, 'b.bin'), 1e6), (e) => e.detail === 'tooLarge');
    await assert.rejects(writeBody(req([Buffer.alloc(600000), Buffer.alloc(600000)]), join(root, 'c.bin'), 1e6), (e) => e.detail === 'tooLarge');
    assert.equal(existsSync(join(root, 'b.bin')) || existsSync(join(root, 'c.bin')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audio extraction error: only no audio track / corrupt file is "no audio found"; cancel and missing ffmpeg pass through as is; no voice-over requirement for a film with ready audio', async () => {
  const { voiceExtractionError, voiceInput } = await import('../lib/jobs/common.mjs');
  const noVoice = voiceExtractionError(new ProcessError('ffmpeg', 1, ["Stream map '0:a:0' matches no streams.", 'Error opening output files: Invalid argument']));
  assert.ok(noVoice instanceof UserError && /No audio found/.test(noVoice.message));
  assert.ok(voiceExtractionError(new ProcessError('ffmpeg', 1, ['Error opening input files: Invalid data found when processing input'])) instanceof UserError);
  const cancel = new CancelError();
  assert.equal(voiceExtractionError(cancel), cancel, 'cancel does not count as an error');
  const none = Object.assign(new Error('spawn ffmpeg.exe ENOENT'), { code: 'ENOENT', lastLines: [] });
  assert.equal(voiceExtractionError(none), none);
  const disk = new ProcessError('ffmpeg', 1, ['Error writing trailer: No space left on device']);
  assert.equal(voiceExtractionError(disk), disk, 'disk full does not count as "no audio"');
  const root = mkdtempSync(join(tmpdir(), 'ses-girdi-'));
  try {
    const setting = { hasVoice: false, hasDesign: false, voiceLibrary: root };
    assert.throws(() => voiceInput({ voice: 'model' }, setting), /Voice-over is not installed/);
    assert.equal(voiceInput({ voice: 'model' }, setting, { narration: false }).voice, 'model');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lip sync timing: 25 fps windows, lip-moving sections, whoever speaks first is speaker 1, box pixels', async () => {
  const { lipWindows, lipSections, windowPlan, boxPixel } = await import('../lib/lip.mjs');
  // 8,98 sn = 225 kare: 81 + 72 + 72 (devam penceresi son 9 kareden başlar, onları atar)
  const p = lipWindows(8.98);
  assert.equal(p.total, 225);
  assert.deepEqual(p.windows, [{ no: 1, start: 0, skip: 0 }, { no: 2, start: 72, skip: 9 }, { no: 3, start: 144, skip: 9 }]);
  assert.equal(lipWindows(3.24).windows.length, 1);
  assert.equal(lipWindows(3.25).windows.length, 2);
  // Anlatıcı (ekranda değil) ve dudağı oynamayan karakter dışarıda; sahne klibinin zamanına (onBosluk) kayar
  const lines = [{ who: null, startedAt: 0, last: 2.72 }, { who: 'Elif', startedAt: 3.02, last: 4.62 }, { who: 'Pamuk', startedAt: 4.92, last: 7.16 }];
  // replik: konusmalar icindeki sira (Elif 0., Pamuk 1.; anlatici sayilmaz) — oyunculuk notu bu sirayla
  assert.deepEqual(lipSections(lines, { frontSpace: 0.6, cast: ['Elif'] }), [{ who: 'Elif', startedAt: 3.62, last: 5.22, line: 0 }]);
  assert.deepEqual(lipSections(lines, { frontSpace: 0.6, cast: ['Pamuk'] }).map((b) => b.line), [1]);
  // Elif sonra Baba: bölünme boşluğun ortasında (1,99 sn -> 50. kare)
  const b = [{ who: 'Elif', startedAt: 0.4, last: 1.84 }, { who: 'Baba', startedAt: 2.14, last: 4.99 }];
  assert.deepEqual(windowPlan(b, 0, { names: ['Elif', 'Baba'] }), { first: 'Elif', second: 'Baba', s: 50, covered: 2.54 });
  // Devam penceresinde yalnız Baba: tek ses bütün pencere, öbürü sessiz 2. konuşmacı
  assert.deepEqual(windowPlan(b, 2.88, { names: ['Elif', 'Baba'] }), { first: 'Baba', second: 'Elif', s: 81, covered: 2.11 });
  assert.deepEqual(windowPlan(b, 6, { names: ['Elif', 'Baba'] }), { first: 'Elif', second: 'Baba', s: 81, covered: 0 });
  // Tek karakterli sahne: ikinci yok
  assert.equal(windowPlan([{ who: 'Elif', startedAt: 1, last: 2 }], 0, { names: ['Elif'] }).second, null);
  // A-B-A: B'nin kısa sözü için A'nın uzun sözü feda edilmez
  const aba = [{ who: 'A', startedAt: 0, last: 0.5 }, { who: 'B', startedAt: 0.8, last: 1.2 }, { who: 'A', startedAt: 1.5, last: 3.2 }];
  assert.deepEqual(windowPlan(aba, 0, { names: ['A', 'B'] }), { first: 'A', second: 'B', s: 81, covered: 2.2 });
  // A sonra B: bölünme boşluğun ortasında (1,75 sn -> 44. kare)
  const ab = [{ who: 'A', startedAt: 0.2, last: 1.6 }, { who: 'B', startedAt: 1.9, last: 3.2 }];
  assert.equal(windowPlan(ab, 0, { names: ['A', 'B'] }).s, 44);
  // Kutu: 928x1664 görsel 720x1280 videoya kaplayarak ölçeklenir, dikeyde 5,5 px kırpılır
  const near = (a, e) => a.forEach((v, i) => assert.ok(Math.abs(v - e[i]) <= 1, `${a} ~ ${e}`));
  near(boxPixel([250, 500, 500, 750], { imageWidth: 928, imageHeight: 1664, width: 720, height: 1280, margin: 0 }), [180, 640, 180, 323]);
  assert.deepEqual(boxPixel([0, 0, 1000, 1000], { imageWidth: 928, imageHeight: 1664, width: 720, height: 1280 }), [0, 0, 720, 1280]);
  assert.equal(boxPixel([0, 0, 5, 5], { imageWidth: 928, imageHeight: 1664, width: 720, height: 1280, margin: 0 }), null, 'a very small box does not become a mask');
});

test('speaker positions: text model response (name case, broken box, missing character); request with image, error when there is no image encoder', async () => {
  const { parseSpeakerResponse } = await import('../lib/jobs/lip.mjs');
  // Gemma bicimi [y_min, x_min, y_max, x_max] -> [x0, y0, x1, y1]; insanlik "human" ya da "label" ile (olculen yanitlar)
  const response = 'İşte: {"elif": {"box_2d": [330, 45, 1000, 596], "label": "human"}, "Pamuk": {"box_2d": [254, 100, 938, 788], "human": false}, "Baba": {"box_2d": [900, 500, 100, 400], "human": true}, "Kuş": {"box_2d": [10, 10, 50, 50], "label": "bird"}}';
  assert.deepEqual(parseSpeakerResponse(response, ['Elif', 'Pamuk', 'Baba', 'Kuş', 'Nine']), {
    Elif: { box: [45, 330, 596, 1000], human: true },
    Pamuk: { box: [100, 254, 788, 938], human: false },
    Baba: { box: null, human: true },
    Kuş: { box: [10, 10, 50, 50], human: false },
    Nine: { box: null, human: false },
  });
  // Model Turkce adi aksansiz ya da buyuk harfle yazabilir
  assert.deepEqual(parseSpeakerResponse('{"AYSE": {"box_2d": [10, 20, 30, 40], "human": true}, "Ilkay": {"box_2d": [1, 2, 3, 4], "human": true}}', ['Ayşe', 'İlkay']), { 'Ayşe': { box: [20, 10, 40, 30], human: true }, 'İlkay': { box: [2, 1, 4, 3], human: true } });
  const { setTextModel, runText } = await import('../lib/text-model.mjs');
  const outgoing = [];
  const fake = { installed: true, info: { mmproj: null }, req: async (path, body) => (outgoing.push(body), { code: 200, json: { choices: [{ message: { content: '{"a":1}' } }] } }) };
  try {
    setTextModel(fake);
    await assert.rejects(runText({ system: 's', prompt: 'i', image: 'data:image/jpeg;base64,AAAA' }), /image encoder \(mmproj\) is not installed/);
    fake.info.mmproj = 'mmproj-x.gguf';
    assert.equal(await runText({ system: 's', prompt: 'question', image: 'data:image/jpeg;base64,AAAA', json: true }), '{"a":1}');
    assert.deepEqual(outgoing[0].messages[1].content, [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }, { type: 'text', text: 'question' }]);
    await runText({ system: 's', prompt: 'yalniz metin' });
    assert.equal(outgoing[1].messages[1].content, 'yalniz metin', 'request without image is plain text as before');
  } finally {
    setTextModel(null);
  }
});

test('ComfyUI patch: InfiniteTalk patch is applied with dtype (once); untouched if the block changed or the file is missing', async () => {
  const { comfyPatch } = await import('../lib/comfy-process.mjs');
  const root = mkdtempSync(join(tmpdir(), 'comfy-yama-'));
  try {
    assert.equal(comfyPatch(root), 'none');
    mkdirSync(join(root, 'comfy_extras'));
    const file = join(root, 'comfy_extras', 'nodes_model_patch.py');
    const unpatched = `        elif "audio_proj.proj1.weight" in sd:
            model = MultiTalkModelPatch(
                    audio_window=5, context_tokens=32, vae_scale=4,
                    in_dim=sd["blocks.0.audio_cross_attn.proj.weight"].shape[0],
                    intermediate_dim=sd["audio_proj.proj1.weight"].shape[0],
                    out_dim=sd["audio_proj.norm.weight"].shape[0],
                    device=comfy.model_management.unet_offload_device(),
                    operations=comfy.ops.manual_cast)
        elif 'model.control_model.input_hint_block.0.weight' in sd or 'control_model.input_hint_block.0.weight' in sd:
`;
    writeFileSync(file, unpatched, 'utf8');
    assert.equal(comfyPatch(root), 'applied');
    const after = readFileSync(file, 'utf8');
    assert.match(after, /unet_offload_device\(\),\n {20}dtype=dtype,\n {20}operations=comfy\.ops\.manual_cast\)/);
    assert.equal(comfyPatch(root), 'already');
    assert.equal(readFileSync(file, 'utf8'), after, 'second call does not change the file');
    // ComfyUI guncellenip blok degisti: dokunulmaz
    const different = unpatched.replace('operations=comfy.ops.manual_cast)', 'operations=comfy.ops.disable_weight_init)');
    writeFileSync(file, different, 'utf8');
    assert.equal(comfyPatch(root), 'none');
    assert.equal(readFileSync(file, 'utf8'), different);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lip mask: face box widens for chin and mouth (more downward), clipped at the border; intersection', async () => {
  const { faceMask, intersects } = await import('../lib/lip.mjs');
  assert.deepEqual(faceMask([400, 200, 600, 400]), [370, 180, 630, 460]);
  assert.deepEqual(faceMask([0, 900, 100, 1000]), [0, 890, 115, 1000]);
  assert.equal(intersects([0, 0, 10, 10], [5, 5, 20, 20]), true);
  assert.equal(intersects([0, 0, 10, 10], [10, 0, 20, 10]), false, 'edge contact is not an intersection');
});

// 07.10.2026 olculdu: tek istekte ComfyUI ozel bellegi 29 GB (16 GB RAM), InfiniteTalk adimi Wan 2.2 adiminin 2,5 kati
test('lip graph split into two requests: Wan 2.2 steps into a latent file, InfiniteTalk steps from it; unused loaders pruned', async () => {
  const { lipStages } = await import('../lib/lip.mjs');
  const { pruned } = await import('../lib/graph.mjs');
  const { lipJob } = await import('../../tools/comfy.mjs');
  const graph = lipJob({ picture: 'r.png', voice1: '1.wav', voice2: '2.wav', mask1: [10, 10, 100, 100], text: 'm', seed: 5, prefix: 'panel/x/d1', motions: ['h1.png', 'h2.png'] });
  const { first, record, last } = lipStages(graph, { prefix: 'panel/x/d1_mid' });
  const cls = (g) => Object.values(g).map((d) => d.class_type).sort();
  assert.equal(first[record].class_type, 'SaveLatent');
  assert.equal(first[record].inputs.filename_prefix, 'panel/x/d1_mid');
  assert.deepEqual(cls(first), ['CLIPLoader', 'CLIPTextEncode', 'ConditioningZeroOut', 'ImageBatch', 'KSamplerAdvanced', 'LoadImage', 'LoadImage', 'ModelSamplingSD3', 'SaveLatent', 'UnetLoaderGGUF', 'VAELoader', 'WanImageToVideo']);
  assert.equal(Object.values(first).find((d) => d.class_type === 'KSamplerAdvanced').inputs.add_noise, 'enable');
  const b = last('panel_x_d1.latent');
  assert.ok(!cls(b).includes('WanImageToVideo') && !cls(b).includes('SaveLatent'));
  assert.deepEqual(Object.values(b).filter((d) => d.class_type === 'UnetLoaderGGUF').map((d) => d.inputs.unet_name), ['wan2.1-i2v-14b-720p-Q4_K_M.gguf']);
  const upload = Object.keys(b).find((id) => b[id].class_type === 'LoadLatent');
  assert.equal(b[upload].inputs.latent, 'panel_x_d1.latent');
  const example = Object.values(b).find((d) => d.class_type === 'KSamplerAdvanced').inputs;
  assert.deepEqual([example.add_noise, example.start_at_step, example.latent_image], ['disable', 2, [upload, 0]]);
  assert.ok(cls(b).includes('SaveImage') && cls(b).includes('ColorTransfer') && cls(b).includes('ImageFromBatch'));
  assert.equal(graph[upload], undefined, 'original graph unchanged');
  assert.throws(() => lipStages({ 1: { class_type: 'KSampler', inputs: {} } }, { prefix: 'x' }), /not two-stage/);
  // budanmis: cikisa gitmeyen dugum kalkar
  assert.deepEqual(Object.keys(pruned({ 1: { inputs: {} }, 2: { inputs: { a: ['1', 0] } }, 3: { inputs: {} } }, ['2'])), ['1', '2']);
});

test('ComfyUI model paths: if the yaml written by kur.ps1 does not know the lip folders they are added (once); other yaml untouched', async () => {
  const { comfyPaths } = await import('../lib/comfy-process.mjs');
  const root = mkdtempSync(join(tmpdir(), 'comfy-yol-'));
  try {
    assert.equal(comfyPaths(root), 'none');
    const file = join(root, 'extra_model_paths.yaml');
    writeFileSync(file, '# kur.bat yazdi\r\nyerel:\r\n  base_path: C:/ai/models/\r\n  checkpoints: checkpoints/\r\n  vae: vae/\r\n', 'utf8');
    assert.equal(comfyPaths(root), 'applied');
    assert.equal(readFileSync(file, 'utf8'), '# kur.bat yazdi\r\nyerel:\r\n  base_path: C:/ai/models/\r\n  checkpoints: checkpoints/\r\n  vae: vae/\r\n  audio_encoders: audio_encoders/\r\n  model_patches: model_patches/\r\n');
    assert.equal(comfyPaths(root), 'already');
    // Kullanicinin kendi yaml'i (baska bicim): dokunulmaz
    writeFileSync(file, 'comfyui:\n  base_path: D:/models/\n', 'utf8');
    assert.equal(comfyPaths(root), 'none');
    assert.equal(readFileSync(file, 'utf8'), 'comfyui:\n  base_path: D:/models/\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 07.10.2026 kullanici: "Kedi mi konusuyor Elif mi, karismis" — kedi "kiz cocugu" tarifiyle tasarlanan sesle konusuyordu.
test('animal character: kind (from the description if not written), only an animal voice for an animal, no animal voice for a human, animal description is not a human child', async () => {
  const { validateCharacters, findType, selectVoice, designSpec, pitchFit } = await import('../lib/characters.mjs');
  const [pamuk, elif] = validateCharacters([{ name: 'Pamuk', gender: 'female', age: 'child', spec: 'a tiny playful kitten, squeaky and cute' }, { name: 'Elif', gender: 'female', age: 'child', type: 'human' }], ['Pamuk', 'Elif']);
  assert.equal(pamuk.type, 'animal', 'tariften: kitten');
  assert.equal(elif.type, 'human');
  assert.equal(findType({ spec: 'scatterbrained and fast' }), 'human', 'word boundary: "scatter" is not a cat');
  assert.equal(findType({ type: 'human', spec: 'a kitten costume' }), 'human', 'written kind takes precedence over the description');
  assert.throws(() => validateCharacters([{ name: 'Robo', gender: 'male', type: 'robot' }]), /must be one of: human, animal/);
  const voices = [
    { id: 'pamuk-old', name: 'Pamuk (karakter)', gender: 'female', age: 'child', character: 'Pamuk', spec: 'A cheerful little girl about 8 years old; a tiny kitten' },
    { id: 'girl', name: 'Kız', gender: 'female', age: 'child' },
    { id: 'kedi', name: 'Kedi (karakter)', gender: 'female', age: 'child', type: 'animal' },
  ];
  // Eski "Pamuk (karakter)" kiz sesiydi (tur yok): ayni adli olsa da hayvana verilmez; tur: hayvan olan secilir
  assert.equal(selectVoice({ character: pamuk, voices }).id, 'kedi');
  assert.equal(selectVoice({ character: pamuk, voices: voices.slice(0, 2) }), null, 'a new voice is designed when there is no animal voice');
  assert.equal(selectVoice({ character: elif, voices: [voices[2], voices[1]] }).id, 'girl', 'insana hayvan sesi verilmez');
  const spec = designSpec(pamuk);
  assert.match(spec, /cartoon animal character.*not a human child.*squeaky/);
  assert.doesNotMatch(spec, /little girl/);
  assert.match(spec, /; a tiny kitten, squeaky; neutral, natural conversational tone, even and clear$/, "mood words (playful, cute) do not enter the design");
  assert.doesNotMatch(designSpec({ gender: "female", age: "child" }), /cheerful|lively|friendly|warm|kind|confident|playful|cute/, "no emotion adjective in the design description (emotion is per line)");
  assert.equal(pitchFit(pamuk, 900), '', 'animal pitch is unconstrained');
});

test('scene writer response: character kind (hayvan / Animal / insan); no field if the kind is not written (derived from the description)', () => {
  const r = parseSceneResponse(JSON.stringify({ title: 'x', characters: [{ name: 'Pamuk', gender: 'dişi', age: 'yavru', type: 'Animal', spec: 'squeaky' }, { name: 'Elif', gender: 'female', age: 'child', type: 'insan' }, { name: 'Baba', gender: 'male', age: 'adult' }], scenes: [{ narration: 'a', dialogue: [{ who: 'Pamuk', text: 'Miyav' }, { who: 'Elif', text: 'Selam' }, { who: 'Baba', text: 'Gel' }], image: 'g', motion: 'h' }] }), 3);
  assert.deepEqual(r.characters.map((k) => [k.name, k.type ?? null]), [['Pamuk', 'animal'], ['Elif', 'human'], ['Baba', null]]);
});

// 07.10.2026 olculdu (kiz + kedi): butun pencerelere "kiz konusuyor" istemi gidince kedi konusurken kizin agzi acikti
// (10'da 6), kedinin hic acilmadi; her pencerede "kamera yaklasir" denince kadraj daraldi.
test('lip window prompt: character definition (kind/age/gender), who is talking, listener keeps the mouth closed, static camera in continuation, part selection', async () => {
  const { characterDefinition, windowPrompt } = await import('../lib/lip.mjs');
  assert.equal(characterDefinition({ gender: 'female', age: 'child', type: 'animal', spec: 'a tiny playful kitten' }), 'the kitten');
  assert.equal(characterDefinition({ type: 'animal', spec: 'küçük bir köpek' }), 'the dog');
  assert.equal(characterDefinition({ type: 'animal', spec: 'squeaky and cute' }), 'the animal');
  assert.equal(characterDefinition({ gender: 'female', age: 'child' }), 'the girl');
  assert.equal(characterDefinition({ gender: 'male', age: 'old' }), 'the old man');
  assert.equal(characterDefinition({ gender: 'male', age: 'adult' }), 'the man');
  const definition = { Elif: 'the girl', Pamuk: 'the kitten' };
  const prompts = ['The girl hugs the kitten and speaks happily, the camera gently pushes in.', 'The kitten looks up at the girl and meows.'];
  const common = { prompts, target: 8.78, definition, names: ['Elif', 'Pamuk'] };
  // Anlatim penceresi: kimse konusmuyor; ilk parca, ilk pencerede kamera serbest
  const p1 = windowPrompt({ ...common, t0: 0, plan: { first: 'Elif', second: 'Pamuk', s: 81, covered: 0 }, proceed: false });
  assert.equal(p1, "Nobody is talking: everyone's mouth stays closed. The girl hugs the kitten and speaks happily, the camera gently pushes in. Keep the girl and the kitten fully in the frame.");
  // Kedinin penceresi: ortasi 2. parcaya duser; dinleyen kiz agzi kapali; devamda kamera sabit
  const p3 = windowPrompt({ ...common, t0: 5.76, plan: { first: 'Pamuk', second: 'Elif', s: 81, covered: 2.3 }, proceed: true });
  assert.equal(p3, 'Only the kitten is talking, mouth moving with the words; the girl listens with a closed mouth, looking at the kitten. The kitten looks up at the girl and meows. Keep the girl and the kitten fully in the frame. The camera holds still: no zoom, no camera movement.');
  // Pencerenin sonunda baslayan kisa konusma (0,34 sn): "konusuyor" denmez (Wan butun pencerede agzi oynatirdi)
  assert.match(windowPrompt({ ...common, t0: 0, plan: { first: 'Elif', second: 'Pamuk', s: 81, covered: 0.34 }, proceed: false }), /^Nobody is talking/);
  // Iki konusan: once kiz sonra kedi
  assert.match(windowPrompt({ ...common, t0: 2.88, plan: { first: 'Elif', second: 'Pamuk', s: 62, covered: 2.1 }, proceed: true }), /^The girl talks first, then the kitten answers; whoever is not talking keeps the mouth closed/);
  // Tek karakterli sahne: dinleyen yok, kadraj cumlesi yok
  assert.equal(windowPrompt({ prompts: ['A man walks.'], target: 3, definition: { Baba: 'the man' }, names: ['Baba'], t0: 0, plan: { first: 'Baba', second: null, s: 81, covered: 1 }, proceed: false }), 'Only the man is talking, mouth moving with the words. A man walks.');
});

// 07.10.2026 kullanici (orman sahnesi): "Pamuk nerdesin diyor ama guluyor, sevgili gibiler".
// "Duygu-dusunce-davranis-tavir-mimik ... gercek insan videosu-filmi olmalidir".
test('director note: response (moment, image, characters, per-line acting/voice/listener; missing line empty); window prompt with notes carries the listener reaction', async () => {
  const { parseDirectorNote } = await import('../lib/prompt-translate.mjs');
  const y = parseDirectorNote('İşte: {"an": "They search the dark forest for the lost kitten, tense.", "image": "The girl lifts the lantern toward the trees, worried.", "characters": [{"who": "the girl", "emotion": "deeply worried", "thought": "what if Pamuk is hurt", "attitude": "determined"}, {"emotion": "adsız atılır"}], "lines": [{"acting": "calls out into the dark trees, brow furrowed", "voice": "loud, urgent, trembling", "listener": "the man watches her with a concerned frown"}]}', 2);
  assert.equal(y.an, 'They search the dark forest for the lost kitten, tense.');
  assert.deepEqual(y.characters, [{ who: 'the girl', emotion: 'deeply worried', thought: 'what if Pamuk is hurt', attitude: 'determined' }]);
  assert.deepEqual(y.lines, [{ acting: 'calls out into the dark trees, brow furrowed', voice: 'loud, urgent, trembling', listener: 'the man watches her with a concerned frown' }, { acting: '', voice: '', listener: '' }]);
  assert.throws(() => parseDirectorNote('{"an": "", "image": "", "lines": []}', 1), /empty/);
  const { windowPrompt } = await import('../lib/lip.mjs');
  const common = { prompts: ['They search the forest.'], target: 6, definition: { Elif: 'the girl', Baba: 'the man' }, names: ['Elif', 'Baba'], sections: [{ who: 'Elif', startedAt: 0.5, last: 2.9, line: 0 }, { who: 'Baba', startedAt: 3.3, last: 6, line: 1 }], acting: [{ acting: 'calls out worriedly into the dark forest', voice: 'loud', listener: 'the man watches her with a concerned frown' }, 'looks down at the girl and reassures her calmly'] };
  // Ormana seslenen kiz: dinleyenin tepkisi nottan (adam "ona bakar" diye zorlanmaz)
  assert.equal(windowPrompt({ ...common, t0: 0, plan: { first: 'Elif', second: 'Baba', s: 81, covered: 2.4 }, proceed: false }), 'Only the girl is talking (calls out worriedly into the dark forest), mouth moving with the words; the man listens with a closed mouth (the man watches her with a concerned frown). They search the forest. Keep the girl and the man fully in the frame.');
  assert.match(windowPrompt({ ...common, t0: 1.8, plan: { first: 'Elif', second: 'Baba', s: 35, covered: 2.9 }, proceed: true }), /^The girl talks first \(calls out worriedly into the dark forest\), then the man answers \(looks down at the girl and reassures her calmly\); whoever is not talking keeps the mouth closed\./);
});

// 07.10.2026 user: "temp is bloating, needlessly": browser profiles that could not be deleted on close piled up in Temp
// (55 profiles). 09.10.2026: profiles under the prefix of the Turkish-named versions go as well.
test('browser profile: old profiles left over from previous runs are deleted; new and unrelated folders remain', async () => {
  const { deleteOldProfiles } = await import('../lib/browser.mjs');
  const { utimesSync, existsSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'browser-cleanup-'));
  const names = ['aipanel-browser-old', 'aipanel-tarayici-old', 'aipanel-browser-new', 'other-folder'];
  try {
    for (const name of names) {
      mkdirSync(join(root, name, 'Default'), { recursive: true });
      writeFileSync(join(root, name, 'Default', 'Cookies'), 'x');
    }
    const twoHoursBefore = new Date(Date.now() - 2 * 3600000);
    for (const name of ['aipanel-browser-old', 'aipanel-tarayici-old', 'other-folder']) utimesSync(join(root, name), twoHoursBefore, twoHoursBefore);
    assert.equal(deleteOldProfiles(root), 2);
    assert.deepEqual(names.map((name) => existsSync(join(root, name))), [false, false, true, true]);
    assert.equal(deleteOldProfiles(join(root, 'none')), 0, 'no error when the folder is missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 07.10.2026: agiz duzeltme (LatentSync) ComfyUI grafi degil; modelleri katalogda "kullanan" ile is akisina baglanir
test('mouth correction: LatentSync files are in the catalog and used by mouthJob; hasMouth is false when not installed; the command uses the lip environment', async () => {
  const { CATALOG, usedFiles, GENERATOR_NAMES } = await import('../lib/models.mjs');
  const { loadSettings } = await import('../lib/settings.mjs');
  const user = usedFiles({});
  for (const d of ['latentsync_unet.pt', 'whisper-tiny.pt', 'sd-vae-ft-mse.safetensors', 'face_landmarker.task']) {
    assert.deepEqual(user[`latentsync/${d}`], ['mouthJob'], d);
    const k = CATALOG.find((x) => x.file === d);
    assert.match(k.sha256, /^[0-9a-f]{64}$/);
    assert.ok(k.size > 0 && /^https:\/\//.test(k.url));
  }
  assert.equal(GENERATOR_NAMES.mouthJob, 'Mouth correction: LatentSync');
  const root = mkdtempSync(join(tmpdir(), 'mouth-settings-'));
  try {
    const a = loadSettings({ aiRoot: root, ffmpeg: null });
    assert.equal(a.hasMouth, false, 'off when the environment and models are missing');
    const k = a.mouthCommand(['--video', 'v.mp4']);
    assert.match(k.command, /lip[\\/]\.venv[\\/]Scripts[\\/]python\.exe$/);
    assert.match(k.args[0], /lip[\\/]mouth\.py$/);
    assert.match(k.env.AI_LATENTSYNC_MODEL, /models[\\/]latentsync$/);
    // Modeller sonradan inince (Ayarlar > Modeller) panel yeniden baslatilmadan acilir
    mkdirSync(join(root, 'lip', '.venv', 'Scripts'), { recursive: true });
    mkdirSync(join(root, 'models', 'latentsync'), { recursive: true });
    for (const d of [join('lip', '.venv', 'Scripts', 'python.exe'), join('lip', 'mouth.py'), ...['latentsync_unet.pt', 'whisper-tiny.pt', 'sd-vae-ft-mse.safetensors', 'face_landmarker.task'].map((x) => join('models', 'latentsync', x))]) writeFileSync(join(root, d), 'x');
    assert.equal(a.hasMouth, true, 'the same settings object sees the files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 07.10.2026 kullanici: "Ses motoru EMA olmayacak miydi": EMA motor listesinde; EMA tek ses ve klonlamaz
test('voice engine EMA: in the engine list; the EMA script only for lines without a reference, lines with a reference (clone, character) use VoxCPM2', async () => {
  const { VOICE_ENGINES } = await import('../lib/settings-file.mjs');
  const { loadSettings } = await import('../lib/settings.mjs');
  assert.ok(VOICE_ENGINES.ema);
  const root = mkdtempSync(join(tmpdir(), 'ema-motor-'));
  try {
    for (const path of [['voice', 'ema'], ['voice', 'voxcpm'], ['voice']]) mkdirSync(join(root, ...path), { recursive: true });
    for (const bat of [['voice', 'ema', 'speak.bat'], ['voice', 'voxcpm', 'speak.bat'], ['voice', 'speak.bat']]) writeFileSync(join(root, ...bat), '@echo off');
    const a = loadSettings({ aiRoot: root, ffmpeg: null });
    a.selectVoiceEngine = () => 'ema';
    const which = (k) => k.args.join(' ');
    assert.match(which(a.voiceCommand(['--job', 'x.json'], 'ema')), /voice[\\/]ema[\\/]speak\.bat/);
    assert.match(which(a.voiceCommand(['--job', 'x.json'], null)), /voice[\\/]voxcpm[\\/]speak\.bat/, 'line without an engine (cloned) uses VoxCPM2');
    assert.match(which(a.voiceCommand(['--job', 'x.json'], 'voxcpm')), /voice[\\/]voxcpm[\\/]speak\.bat/);
    a.selectVoiceEngine = () => 'chatterbox';
    assert.match(which(a.voiceCommand(['--job', 'x.json'], null)), /voice[\\/]speak\.bat/);
    assert.equal(a.designEngine(), 'qwen', 'Qwen3-TTS when the design script is missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resuming: half-written frames after the checkpoint are deleted, intermediate files do not count as frames', async () => {
  const { deleteExtraFrames, pngs } = await import('../lib/jobs/common.mjs');
  const k = mkdtempSync(join(tmpdir(), 'kare-'));
  try {
    for (let i = 1; i <= 7; i++) writeFileSync(join(k, `${String(i).padStart(5, '0')}.png`), 'x');
    writeFileSync(join(k, '_skip_0.png'), 'x');
    writeFileSync(join(k, 'checkpoint.json'), '{}');
    assert.equal(pngs(k).length, 7, '_skip_0.png does not count as a frame');
    // 2. pencere kareleri yazilirken hata: kayitta 5 kare
    assert.equal(deleteExtraFrames(k, 5), 2);
    assert.deepEqual(pngs(k), ['00001.png', '00002.png', '00003.png', '00004.png', '00005.png']);
    assert.ok(!readdirSync(k).includes('_skip_0.png'));
    assert.equal(deleteExtraFrames(k, undefined), 0, 'untouched when there is no checkpoint (old job)');
    assert.equal(pngs(k).length, 5);
    assert.equal(deleteExtraFrames(k, 0), 5, 'all of them if no window finished');
  } finally {
    rmSync(k, { recursive: true, force: true });
  }
});


test('atomikYaz: the file is written under a temporary name, on an error while writing the target is not created (a half file does not count as "done")', async () => {
  const { writeAtomic } = await import('../lib/jobs/common.mjs');
  const k = mkdtempSync(join(tmpdir(), 'atomik-'));
  try {
    const target = join(k, 'sahne01.wav');
    await assert.rejects(writeAtomic(target, async (g) => {
      assert.equal(g, join(k, 'sahne01.writing.wav'), 'extension preserved (ffmpeg format)');
      writeFileSync(g, 'partial');
      throw new Error('process killed');
    }));
    assert.deepEqual(readdirSync(k).filter((d) => d === 'sahne01.wav'), []);
    await writeAtomic(target, async (g) => writeFileSync(g, 'full'));
    assert.equal(readFileSync(target, 'utf8'), 'full');
    assert.deepEqual(readdirSync(k), ['sahne01.wav'], 'no intermediate file left behind');
  } finally {
    rmSync(k, { recursive: true, force: true });
  }
});

test('picture search: a stock photo site (watermarked preview) ranks after a clean picture of the same thing', async () => {
  const { createServer } = await import('node:http');
  const { searchImages } = await import('../lib/agent/image-search.mjs');
  let at = '';
  const item = (image, page, title) => `<a class="iusc" m="${JSON.stringify({ murl: image, purl: page, t: title }).replace(/"/g, '&quot;')}"></a>`;
  const site = createServer((i, y) => {
    y.writeHead(i.url.startsWith('/bing') ? 200 : 404, { 'Content-Type': 'text/html' });
    // Bing's first result is an Alamy preview (with "alamy" across it, 08.10.2026), the second a clean one
    y.end(i.url.startsWith('/bing') ? `${item('https://c8.alamy.com/comp/JK1A19/galata-tower-night.jpg', 'https://www.alamy.com/galata', 'Galata Tower at night')}${item(`${at}/galata.jpg`, `${at}/page.html`, 'Galata Tower at night')}` : '');
  });
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
  at = `http://127.0.0.1:${site.address().port}`;
  try {
    const r = await searchImages('Galata Tower at night', { urls: { bing: `${at}/bing`, brave: `${at}/brave`, openverse: `${at}/openverse`, commons: `${at}/commons` } });
    assert.deepEqual(r.results.map((x) => x.image), [`${at}/galata.jpg`, 'https://c8.alamy.com/comp/JK1A19/galata-tower-night.jpg']);
  } finally {
    site.close();
  }
});

test('recent jobs: the newest ones and the last 4 of every type besides (a section showed none of its older jobs)', () => {
  const jobs = [{ id: 'w', type: 'image', status: 'running' }, ...Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, type: 'image', status: 'done' })), ...Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, type: 'model3d', status: i ? 'done' : 'error' }))];
  assert.deepEqual(lastJobs(jobs, 3, 4).map((job) => job.id), ['i0', 'i1', 'i2', 'i3', 'm0', 'm1', 'm2', 'm3']);
  assert.deepEqual(lastJobs(jobs, 7, 4).map((job) => job.id), ['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'm0', 'm1', 'm2', 'm3'], 'the newest ones whatever their type');
});
