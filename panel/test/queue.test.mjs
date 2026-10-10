/**
 * Kuyruk, iptal ve hata yollari: sahte ComfyUI + sahte seslendirme (ekran karti kullanilmaz).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { setTextModel } from '../lib/prompt-translate.mjs';
import { UserError } from '../lib/errors.mjs';
import { Queue } from '../lib/queue.mjs';
import { makePng, wavDuration } from '../lib/media.mjs';
import * as image from '../lib/jobs/image.mjs';

const promptCount = (p) => p.fake.status.records.filter((k) => k.path === '/prompt').length;

test('image: 3 images in one request, websocket progress, outputs on disk', async () => {
  const p = await createPanel();
  try {
    const job = p.queue.add('image', { prompt: 'a red fox in snow', model: 'qwen', ratio: '16:9', count: 3, seed: 100 });
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'done', last.error);
    assert.equal(last.outputs.length, 3);
    assert.deepEqual(last.outputs.map((c) => c.seed), [100, 101, 102]);
    for (const c of last.outputs) {
      assert.ok(existsSync(join(p.setting.outputRoot, job.id, c.file)), c.file);
      assert.ok(existsSync(join(p.setting.outputRoot, job.id, c.preview)), c.preview);
    }
    assert.equal(promptCount(p), 1, 'three images in ONE ComfyUI request');
    const graph = [...p.fake.status.requests.values()][0].graph;
    assert.equal(Object.values(graph).filter((d) => d.class_type === 'UnetLoaderGGUF').length, 1, 'model is loaded once');
    assert.ok(p.observation.details.some((a) => /Sampling 2\/3 · \d\/8/.test(a)), `websocket step progress not seen: ${p.observation.details.join(' | ')}`);
    assert.equal(last.progress.percent, 100);
    assert.ok(last.measurements['image/qwen'] > 0, 'duration measurement was recorded');
  } finally {
    await p.close();
  }
});

test('a short title is shown on the job and gallery cards instead of the long English prompt (09.10.2026)', async () => {
  const { JOB_TYPES } = await import('../lib/api.mjs');
  for (const type of ['image', 'video', 'edit', 'music']) assert.ok(JOB_TYPES[type].fields.some((f) => f.name === 'title'), `${type} documents title`);
  const p = await createPanel();
  try {
    const prompt = 'Hot air balloons drifting over the fairy chimneys of Cappadocia at sunrise, golden light, cinematic, highly detailed';
    const named = p.queue.add('image', { prompt, title: 'Kapadokya\'da gün doğumu', model: 'qwen' });
    assert.equal(named.summary.title, 'Kapadokya\'da gün doğumu');
    assert.equal(named.input.prompt, prompt, 'the model still gets the whole prompt');
    assert.equal(p.queue.add('image', { prompt, model: 'qwen' }).summary.title, prompt, 'without a title the prompt is shown');
    const music = await import('../lib/jobs/music.mjs');
    assert.equal(music.summary({ style: 'uplifting electronic, warm synths', title: 'Tanıtım müziği', duration: 20, bpm: 110 }).title, 'Tanıtım müziği');
    assert.throws(() => p.queue.add('image', { prompt, title: 'x'.repeat(121), model: 'qwen' }), /Title/);
    const done = await p.waitUntilDone(named.id);
    assert.equal(p.queue.summary(done).summary.title, 'Kapadokya\'da gün doğumu', 'the gallery list carries it');
  } finally {
    await p.close();
  }
});

test('single queue: two jobs never run at the same time, a queued job that is cancelled is never sent', async () => {
  const p = await createPanel({ stepDuration: 40 });
  try {
    const a = p.queue.add('image', { prompt: 'a', model: 'qwen' });
    const b = p.queue.add('image', { prompt: 'b', model: 'flux' });
    const c = p.queue.add('image', { prompt: 'c', model: 'flux' });
    assert.equal(p.queue.pending().length >= 2, true);
    p.queue.cancel(c.id);
    assert.equal(p.queue.jobs.get(c.id).status, 'cancelled');
    const hour = await p.waitUntilDone(a.id);
    const sb = await p.waitUntilDone(b.id);
    assert.equal(hour.status, 'done');
    assert.equal(sb.status, 'done');
    assert.ok(Date.parse(sb.start) >= Date.parse(hour.end), 'second job started after the first finished');
    assert.equal(p.observation.twoRunning, false);
    assert.equal(promptCount(p), 2, 'cancelled job did not go to ComfyUI');
  } finally {
    await p.close();
  }
});

test('cancel a running job: ComfyUI gets an interrupt, the job becomes "cancelled"', async () => {
  const p = await createPanel({ mode: 'slow' });
  try {
    const job = p.queue.add('image', { prompt: 'slow', model: 'qwen' });
    await p.waitForState(() => p.fake.status.running !== null);
    await new Promise((ok) => setTimeout(ok, 400));
    p.queue.cancel(job.id);
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'cancelled');
    assert.ok(p.fake.status.cuts >= 1, 'interrupt was sent');
    const log = readFileSync(join(p.setting.outputRoot, job.id, 'log.txt'), 'utf8');
    assert.match(log, /Cancelled\./);
    // Kuyruk sonraki işe geçer.
    p.fake.status.mode = 'normal';
    const next = p.queue.add('image', { prompt: 'next', model: 'flux' });
    assert.equal((await p.waitUntilDone(next.id)).status, 'done');
  } finally {
    await p.close();
  }
});

test('if VRAM runs out, ComfyUI memory is freed and the same request is retried once', async () => {
  const p = await createPanel();
  try {
    // 1. istek ornekleyicide VRAM hatasi verir; yeniden deneme (2. istek) biter
    p.fake.status.errorRequest = 1;
    const a = await p.waitUntilDone(p.queue.add('image', { prompt: 'x', model: 'flux' }).id);
    assert.equal(a.status, 'done', a.error);
    assert.equal(p.fake.status.records.filter((k) => k.path === '/prompt').length, 2);
    assert.equal(p.fake.status.flushes, 1, '/free once');
    assert.match(readFileSync(join(p.setting.outputRoot, a.id, 'log.txt'), 'utf8'), /Not enough GPU memory \((KSampler|SamplerCustomAdvanced)\); freeing ComfyUI memory and retrying the same step once/);
  } finally {
    await p.close();
  }
});

test('error paths give clear messages: missing model, out of VRAM, job lost', async () => {
  const p = await createPanel({ mode: 'validation' });
  try {
    const a = await p.waitUntilDone(p.queue.add('image', { prompt: 'x', model: 'qwen' }).id);
    assert.equal(a.status, 'error');
    assert.match(a.error, /^Model file not found: qwen-image-2512-Q4_K_M\.gguf/);
    p.fake.status.mode = 'oom';
    const b = await p.waitUntilDone(p.queue.add('image', { prompt: 'y', model: 'flux' }).id);
    assert.equal(b.status, 'error');
    assert.match(b.error, /^Not enough GPU memory \((KSampler|SamplerCustomAdvanced)\)/);
    p.fake.status.mode = 'loss';
    const c = await p.waitUntilDone(p.queue.add('image', { prompt: 'z', model: 'flux' }).id, 30000);
    assert.equal(c.status, 'error');
    assert.match(c.error, /not found in the ComfyUI queue/);
    // Yeniden dene: hata giderilince ayni is biter.
    p.fake.status.mode = 'normal';
    p.queue.tryAgain(c.id);
    assert.equal((await p.waitUntilDone(c.id)).status, 'done');
    assert.throws(() => p.queue.tryAgain(c.id), UserError);
  } finally {
    await p.close();
  }
});

test('ComfyUI is off: the job tries to start it, clear error if it does not come up', async () => {
  const p = await createPanel({ comfyClosed: true });
  try {
    const job = await p.waitUntilDone(p.queue.add('image', { prompt: 'x', model: 'flux' }).id, 20000);
    assert.equal(job.status, 'error');
    assert.equal(p.starts.length, 1, 'start_comfyui.bat was called once');
    assert.match(job.error, /ComfyUI did not start within 3 s|Could not connect to ComfyUI/);
  } finally {
    await p.close();
  }
});

test('ComfyUI is off (closed when idle): ComfyUI is started before the video source is uploaded', async () => {
  const p = await createPanel({ comfyClosed: true });
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261004-120000-kare.png'), makePng(160, 90));
    const job = await p.waitUntilDone(p.queue.add('video', { source: 'upload/20261004-120000-kare.png', prompt: 'x', model: 'wan14', duration: 2 }).id, 20000);
    assert.equal(p.starts.length, 1, 'start_comfyui.bat was called before the upload');
    assert.match(job.error, /ComfyUI did not start within 3 s|Could not connect to ComfyUI/);
    assert.match(p.queue.logs.get(job.id).join('\n'), /ComfyUI was off; started\./);
  } finally {
    await p.close();
  }
});

test('input validation gives a clear error and no job is created', async () => {
  const p = await createPanel();
  try {
    assert.throws(() => p.queue.add('image', { prompt: '  ' }), /Prompt cannot be empty/);
    assert.throws(() => p.queue.add('image', { prompt: 'x', count: 50 }), /Count can be at most 8/);
    assert.throws(() => p.queue.add('video', {}), /Choose a source image/);
    assert.throws(() => p.queue.add('voice', { text: 'Merhaba', voice: 'ref:yok-1234' }), /not in the library/);
    assert.throws(() => p.queue.add('film', { scenes: [] }), /Add at least one scene/);
    assert.throws(() => p.queue.add('film', { scenes: [{ image: 'x', narration: '' }] }), /Scene 1: narration cannot be empty/);
    assert.throws(() => p.queue.add('bilinmeyen', {}), /Unknown job type/);
    assert.equal(p.queue.jobs.size, 0);
  } finally {
    await p.close();
  }
});

test('voice: ComfyUI /free first (VRAM is measured), then voice-over; speed is applied', async () => {
  const p = await createPanel();
  try {
    const text = 'Gel otur evlat, sana bir efsane anlatayım.';
    const job = await p.waitUntilDone(p.queue.add('voice', { text, voice: 'model', quality: 'checked', speed: '1.1' }).id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(p.fake.status.flushes, 1, 'ComfyUI /free was called');
    const log = readFileSync(join(p.setting.outputRoot, job.id, 'log.txt'), 'utf8');
    const free = log.indexOf('VRAM ComfyUI /free: 9000 → 900 MB');
    const voice = log.indexOf('Voice-over: 1 lines × 3 takes');
    assert.ok(free > 0 && voice > free, 'VRAM was freed first, then voice-over started');
    const path = join(p.setting.outputRoot, job.id, 'voice.wav');
    const expected = Math.max(0.6, text.length / 13) / 1.1;
    assert.ok(Math.abs(wavDuration(path) - expected) < 0.05, `speed 1.1×: ${wavDuration(path)} ≈ ${expected}`);
    assert.equal(job.outputs[0].heard, text);
  } finally {
    await p.close();
  }
});

test('voice: the language of the API (lang) reaches the script; English text is not respelled the Turkish way', async () => {
  const p = await createPanel();
  try {
    const text = 'Your own AI studio, on your computer.';
    const job = await p.waitUntilDone(p.queue.add('voice', { text, voice: 'model', lang: 'en', quality: 'fast' }).id);
    assert.equal(job.status, 'done', job.error);
    const sent = JSON.parse(readFileSync(join(p.setting.outputRoot, job.id, 'narration', 'job.json'), 'utf8'));
    assert.deepEqual([job.input.lang, sent.language, sent.lines[0].text], ['en', 'en', text]);
  } finally {
    await p.close();
  }
});

test('voice description: a timbre is designed with Qwen3-TTS, added to the library and used as reference', async () => {
  const p = await createPanel();
  try {
    const job = await p.waitUntilDone(p.queue.add('voice', { text: 'Merhaba dünya.', voice: 'spec', spec: 'A very old man, deep voice', recordName: 'Old narrator' }).id);
    assert.equal(job.status, 'done', job.error);
    const isJson = JSON.parse(readFileSync(join(p.setting.outputRoot, job.id, 'narration', 'job.json'), 'utf8'));
    assert.match(isJson.reference, /references[\\/]old-narrator-[0-9a-f]{4}\.wav$/);
    assert.ok(existsSync(isJson.reference));
    assert.equal(job.voiceName, 'Old narrator');
  } finally {
    await p.close();
  }
});

test('voice description written in Turkish: the design model gets it in English (like Qwen-Image, it misreads Turkish)', async () => {
  const llm = {
    installed: true,
    info: { name: 'fake' },
    releaseGpu: async () => {},
    req: async (path, body) => {
      const system = body.messages[0]?.content ?? '';
      if (/voice descriptions/.test(system)) return { code: 200, json: { choices: [{ message: { content: 'A very old man with a deep, warm voice' } }] } };
      return { code: 500, json: { error: { message: 'not in this test' } } };
    },
  };
  const p = await createPanel({ llm });
  setTextModel(llm);
  try {
    const job = await p.waitUntilDone(p.queue.add('voice', { text: 'Merhaba dünya.', voice: 'spec', spec: 'derin ve sıcak sesli çok yaşlı bir adam', recordName: 'Yaşlı' }).id);
    assert.equal(job.status, 'done', job.error);
    const log = p.queue.logs.get(job.id).join(String.fromCharCode(10));
    assert.match(log, /Voice description translated to English: A very old man with a deep, warm voice/);
    assert.match(log, /Voice design \(Qwen3-TTS\): "A very old man with a deep, warm voice"/);
  } finally {
    setTextModel(null);
    await p.close();
  }
});

test('voice description with VoxCPM2: the voice is designed reading the language of the job (an English voice reads English)', async () => {
  const p = await createPanel({ setting: { designEngine: () => 'voxcpm' } });
  try {
    const read = async (lang) => {
      const job = await p.waitUntilDone(p.queue.add('voice', { text: lang === 'en' ? 'Hello world.' : 'Merhaba dünya.', voice: 'spec', spec: 'A warm adult male narrator', recordName: `Narrator ${lang}`, lang }).id);
      assert.equal(job.status, 'done', job.error);
      const log = readFileSync(join(p.setting.outputRoot, job.id, 'log.txt'), 'utf8');
      return [readFileSync(join(p.setting.outputRoot, job.id, 'design', 'spec_text.txt'), 'utf8'), log];
    };
    const [en, enLog] = await read('en');
    assert.match(en, /^The old stories say that the river remembers/, 'English text for an English voice');
    assert.match(enLog, /Voice design \(VoxCPM2, English\)/);
    const [tr, trLog] = await read('tr');
    assert.match(tr, /^Gel otur evlat/, 'Turkish text for a Turkish voice');
    assert.match(trLog, /Voice design \(VoxCPM2, Turkish\)/);
  } finally {
    await p.close();
  }
});

test('voice-over error: clear message from the Python traceback', async () => {
  const p = await createPanel({ voiceEnv: { FAKE_VOICE_ERROR: '1' } });
  try {
    const job = await p.waitUntilDone(p.queue.add('voice', { text: 'Deneme.', voice: 'model' }).id);
    assert.equal(job.status, 'error');
    assert.match(job.error, /^Voice-over: not enough GPU memory/);
    assert.match(job.errorDetail, /OutOfMemoryError/);
  } finally {
    await p.close();
  }
});

test('cancel a running voice-over: the process tree is killed', async () => {
  const p = await createPanel({ voiceEnv: { WAIT_FAKE_VOICE: '3000' } });
  try {
    const job = p.queue.add('voice', { text: 'Uzun sürecek bir okuma.', voice: 'model', quality: 'natural' });
    await p.waitForState(() => /take \d|Voice-over/.test(JSON.stringify(p.queue.jobs.get(job.id).progress)) && p.queue.active);
    await new Promise((ok) => setTimeout(ok, 300));
    const startedAt = Date.now();
    p.queue.cancel(job.id);
    const last = await p.waitUntilDone(job.id);
    assert.equal(last.status, 'cancelled');
    assert.ok(Date.now() - startedAt < 2500, 'cancel did not wait 6×3 s');
  } finally {
    await p.close();
  }
});

test('video: source is uploaded, frames become mp4 (RIFE 2×), frames are deleted', async () => {
  const p = await createPanel();
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261002-120000-kare.png'), makePng(160, 90));
    const job = await p.waitUntilDone(p.queue.add('video', { source: 'upload/20261002-120000-kare.png', prompt: 'slow push in', model: 'wan14', duration: 2, smooth: 2 }).id);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual([job.input.width, job.input.height, job.input.frame], [1280, 720, 33]);
    assert.equal(p.fake.status.uploaded.length, 1, 'source was uploaded to ComfyUI input');
    const c = job.outputs[0];
    assert.equal(c.fps, 32);
    assert.equal(c.duration, 2.03, '(33-1)*2+1 = 65 kare / 32 fps');
    assert.ok(existsSync(join(p.setting.outputRoot, job.id, 'video.mp4')));
    assert.ok(!existsSync(join(p.setting.outputRoot, job.id, 'frames')), 'frames deleted');
    // Wan 5B: graf comfy.mjs'te RIFE'siz; panel ekler.
    const b = await p.waitUntilDone(p.queue.add('video', { source: 'upload/20261002-120000-kare.png', model: 'wan5', duration: 2, smooth: 2 }).id);
    assert.equal(b.status, 'done', b.error);
    assert.equal(b.outputs[0].fps, 48);
    const graph = [...p.fake.status.requests.values()].at(-1).graph;
    assert.equal(Object.values(graph).filter((d) => d.class_type === 'RIFE VFI').length, 1);
  } finally {
    await p.close();
  }
});

test('when the job finishes, the empty output folder and uploaded input on the ComfyUI side are deleted; non-empty folders and other files are not touched', async () => {
  const p = await createPanel({ stepDuration: 80 });
  try {
    const comfyRoot = join(p.root, 'ComfyUI');
    p.comfy.comfyFolder = comfyRoot;
    const a = p.queue.add('image', { prompt: 'x', model: 'flux' });
    mkdirSync(join(comfyRoot, 'output', 'panel', a.id), { recursive: true });
    mkdirSync(join(comfyRoot, 'input'), { recursive: true });
    writeFileSync(join(comfyRoot, 'input', `panel_${a.id}_v.png`), 'x');
    writeFileSync(join(comfyRoot, 'input', 'kullanicinin.png'), 'x');
    const b = p.queue.add('image', { prompt: 'y', model: 'flux' });
    mkdirSync(join(comfyRoot, 'output', 'panel', b.id), { recursive: true });
    writeFileSync(join(comfyRoot, 'output', 'panel', b.id, 'kalan.png'), 'x');
    assert.equal((await p.waitUntilDone(a.id)).status, 'done');
    assert.equal((await p.waitUntilDone(b.id)).status, 'done');
    assert.ok(!existsSync(join(comfyRoot, 'output', 'panel', a.id)), 'empty folder was deleted');
    assert.ok(!existsSync(join(comfyRoot, 'input', `panel_${a.id}_v.png`)), 'job input was deleted');
    assert.ok(existsSync(join(comfyRoot, 'input', 'kullanicinin.png')), 'other file is still there');
    assert.ok(existsSync(join(comfyRoot, 'output', 'panel', b.id, 'kalan.png')), 'non-empty folder is still there');
  } finally {
    await p.close();
  }
});

test('when the panel restarts: the running job becomes "interrupted", the waiting job continues; deletion only in the panel folder', async () => {
  const p = await createPanel();
  try {
    const k = p.setting.outputRoot;
    const write = (id, status) => {
      mkdirSync(join(k, id), { recursive: true });
      writeFileSync(join(k, id, 'job.json'), JSON.stringify({ panel: 1, id, type: 'image', status, creation: new Date().toISOString(), input: image.validate({ prompt: 'q', model: 'flux' }, { mod: p.queue.mod }), summary: {}, progress: {}, outputs: [], measurements: {} }));
    };
    write('20261001-100000-gorsel-aaaa', 'running');
    write('20261001-100001-gorsel-bbbb', 'waiting');
    mkdirSync(join(k, '20261001-100002-gorsel-cccc'), { recursive: true });
    writeFileSync(join(k, '20261001-100002-gorsel-cccc', 'job.json'), JSON.stringify({ id: 'x' }));
    const fresh = new Queue({ setting: p.setting, comfy: p.comfy, mod: p.queue.mod, runners: p.queue.runners });
    fresh.load();
    assert.equal(fresh.jobs.get('20261001-100000-gorsel-aaaa').status, 'interrupted');
    assert.equal(fresh.jobs.has('20261001-100002-gorsel-cccc'), false, 'folder without the panel marker is not read');
    fresh.start();
    const value = await (async () => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 20000) {
        const job = fresh.jobs.get('20261001-100001-gorsel-bbbb');
        if (job.status === 'done' || job.status === 'error') return job;
        await new Promise((ok) => setTimeout(ok, 50));
      }
      return null;
    })();
    assert.equal(value?.status, 'done', 'waiting job continued at startup');
    await fresh.remove('20261001-100000-gorsel-aaaa');
    assert.ok(!existsSync(join(k, '20261001-100000-gorsel-aaaa')));
    await assert.rejects(() => fresh.remove('20261001-100002-gorsel-cccc'), UserError);
    assert.ok(existsSync(join(k, '20261001-100002-gorsel-cccc')), 'foreign folder is still there');
    // Kayitta panel imi kaybolmussa (elle degistirilmis klasor) silinmez.
    writeFileSync(join(k, '20261001-100001-gorsel-bbbb', 'job.json'), JSON.stringify({ id: 'other' }));
    await assert.rejects(() => fresh.remove('20261001-100001-gorsel-bbbb'), /does not belong to the panel/);
    assert.ok(existsSync(join(k, '20261001-100001-gorsel-bbbb')));
    await fresh.stop();
  } finally {
    await p.close();
  }
});

test('RAM guard: warns when free RAM is low, starts when RAM frees up; if it never does, starts anyway after the timeout', async () => {
  const p = await createPanel();
  try {
    const measurements = [2.1, 2.5, 6];
    p.setting.ramWatchdog = () => measurements.shift() ?? 6;
    p.setting.ramWait = 30000;
    const a = await p.waitUntilDone(p.queue.add('image', { prompt: 'a', model: 'flux' }).id);
    assert.equal(a.status, 'done', a.error);
    const ga = p.queue.logs.get(a.id).join('\n');
    assert.match(ga, /Low free RAM \(2\.1 GB, recommended 4 GB\)/);
    assert.match(ga, /Enough RAM \(6\.0 GB\); job starting\./);

    p.setting.ramWatchdog = () => 1;
    p.setting.ramWait = 50;
    const b = await p.waitUntilDone(p.queue.add('image', { prompt: 'b', model: 'flux' }).id);
    assert.equal(b.status, 'done', b.error);
    assert.match(p.queue.logs.get(b.id).join('\n'), /RAM still low \(1\.0 GB\); starting the job anyway\./);
  } finally {
    await p.close();
  }
});

test('idle ComfyUI shutdown: closes after the timeout once the queue is empty; does not close while the ComfyUI queue has work', async () => {
  const p = await createPanel();
  try {
    const closed = [];
    p.setting.closeComfy = async () => (closed.push(Date.now()), [4242]);
    p.queue.idleCloseMin = () => 0.002; // 120 ms
    const a = await p.waitUntilDone(p.queue.add('image', { prompt: 'a', model: 'flux' }).id);
    assert.equal(a.status, 'done', a.error);
    for (let i = 0; i < 40 && !closed.length; i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(closed.length, 1, 'ComfyUI was closed when idle');
    assert.ok(p.queue.comfyIdleClosed);

    // ComfyUI kendi kuyruğunda iş var (panel dışından kullanılıyor): kapatılmaz.
    const queueReal = p.comfy.queue.bind(p.comfy);
    p.comfy.queue = async () => ({ running: ['dis-job'], pending: [] });
    p.queue.idleCloseMin = () => 0;
    await p.queue.closeIdle();
    assert.equal(closed.length, 1, 'ComfyUI was not closed while busy');
    p.comfy.queue = queueReal;
  } finally {
    await p.close();
  }
});

test('when the panel shuts down: the yielding job (data collection) waits to resume by itself at startup, the other job stays "interrupted"', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'kuyruk-acilis-'));
  try {
    const writeJob = (id, type) => {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, 'job.json'), JSON.stringify({ panel: 1, id, type, status: 'running', creation: new Date().toISOString(), input: {}, summary: {}, progress: { percent: 40, stage: 'Collecting' }, outputs: [] }));
    };
    writeJob('20261005-200000-veri-aaaa', 'data');
    writeJob('20261005-200001-gorsel-bbbb', 'image');
    const k = new Queue({ setting: { outputRoot: root }, comfy: null, mod: null, runners: { data: { yields: true, pausable: true }, image: {} } });
    k.load();
    const data = k.jobs.get('20261005-200000-veri-aaaa');
    const g = k.jobs.get('20261005-200001-gorsel-bbbb');
    assert.deepEqual([data.status, data.yielded, data.error], ['paused', true, null]);
    assert.match(data.progress.stage, /resumes once the queue is empty/);
    assert.deepEqual([g.status, g.yielded], ['interrupted', undefined]);
    assert.equal(JSON.parse(readFileSync(join(root, '20261005-200000-veri-aaaa', 'job.json'), 'utf8')).status, 'paused', 'also written to disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('yielding jobs: an unlimited job gives way to a new bounded job (including another data collection) and resumes by itself when that finishes; two unlimited jobs do not interrupt each other', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'kuyruk-yol-'));
  const events = [];
  // Sahte veri toplama: sinirsiz (konu + hedef 0) iptal sinyali gelene kadar surer; sonu belli olan hemen biter
  const data = {
    name: 'Data collection', yields: true, pausable: true, gpuNotNeeded: true,
    isLong: (g) => Boolean(g?.topic) && !g?.target,
    validate: (g) => ({ ...g }),
    async run(ctx) {
      events.push(`start:${ctx.job.input.name}`);
      if (ctx.job.input.target) return void events.push(`done:${ctx.job.input.name}`);
      await new Promise((ok) => (ctx.signal.aborted ? ok() : ctx.signal.addEventListener('abort', ok, { once: true })));
      events.push(`stopped:${ctx.job.input.name}`);
      throw new (await import('../lib/errors.mjs')).CancelError();
    },
  };
  const k = new Queue({ setting: { outputRoot: root }, comfy: null, mod: null, runners: { data } });
  k.start();
  const wait = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((ok) => setTimeout(ok, 25));
    assert.ok(condition(), `condition not met: ${events.join(', ')}`);
  };
  try {
    const unlimited = k.add('data', { name: 'unlimited', topic: 'kedi', target: 0 });
    await wait(() => k.jobs.get(unlimited.id).status === 'running');
    const secondUnlimited = k.add('data', { name: 'unlimited2', topic: 'köpek', target: 0 });
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal(k.jobs.get(unlimited.id).status, 'running', 'an unlimited job does not yield to another unlimited job');
    const certain = k.add('data', { name: 'certain', sources: ['https://ornek.com'], target: 50 });
    await wait(() => k.jobs.get(certain.id).status === 'done');
    assert.deepEqual([k.jobs.get(unlimited.id).status, k.jobs.get(unlimited.id).yielded], ['paused', true]);
    assert.ok(events.indexOf('stopped:unlimited') < events.indexOf('done:certain'), events.join(', '));
    // Sonra bekleyen sinirsiz is; o da durunca (iptal) sira bos kalir ve yol vermis ilk is kendiliginden surer
    await wait(() => events.includes('start:unlimited2'));
    k.cancel(secondUnlimited.id);
    await wait(() => events.filter((o) => o === 'start:unlimited').length === 2);
    k.cancel(unlimited.id);
  } finally {
    k.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test('when yielded jobs resume, the bounded one (interrupted collection) goes first, the unlimited one last', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'kuyruk-surdur-'));
  const starting = [];
  const data = {
    name: 'Data collection', yields: true, pausable: true, gpuNotNeeded: true,
    isLong: (g) => Boolean(g?.topic) && !g?.target,
    validate: (g) => ({ ...g }),
    async run(ctx) {
      starting.push(ctx.job.input.name);
    },
  };
  try {
    // Panel kapanirken ikisi de calisiyormus gibi (once sinirsiz eklenmis): acilista ikisi de yol vermis bekler
    const write = (id, input, creation) => {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, 'job.json'), JSON.stringify({ panel: 1, id, type: 'data', status: 'running', creation, input, summary: {}, progress: {}, outputs: [] }));
    };
    write('20261005-200000-veri-aaaa', { name: 'unlimited', topic: 'kedi', target: 0 }, '2026-10-05T17:00:00.000Z');
    write('20261005-200500-veri-bbbb', { name: 'certain', sources: ['https://ornek.com'], target: 50 }, '2026-10-05T17:05:00.000Z');
    const k = new Queue({ setting: { outputRoot: root }, comfy: null, mod: null, runners: { data } });
    k.load();
    k.start();
    for (let i = 0; i < 200 && starting.length < 2; i++) await new Promise((ok) => setTimeout(ok, 25));
    assert.deepEqual(starting, ['certain', 'unlimited']);
    k.close?.();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('yielding job: a cancelled one does not come back, a paused one can be cancelled; "resume" also takes a queue slot; after a clean shutdown it continues at startup', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { CancelError } = await import('../lib/errors.mjs');
  const root = mkdtempSync(join(tmpdir(), 'kuyruk-iptal-'));
  const infinite = (ctx) => new Promise((ok, red) => {
    const finish = () => red(new CancelError());
    if (ctx.signal.aborted) return finish();
    ctx.signal.addEventListener('abort', finish, { once: true });
  });
  const data = { name: 'Data collection', yields: true, pausable: true, gpuNotNeeded: true, isLong: (g) => Boolean(g?.topic) && !g?.target, validate: (g) => ({ ...g }), run: infinite };
  const training = { name: 'Training', pausable: true, gpuNotNeeded: true, validate: (g) => ({ ...g }), run: async (ctx) => (ctx.job.input.long ? infinite(ctx) : undefined) };
  const wait = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((ok) => setTimeout(ok, 25));
    assert.ok(condition());
  };
  const k = new Queue({ setting: { outputRoot: root }, comfy: null, mod: null, runners: { data, training } });
  k.start();
  try {
    // Iptal edilen calisan is: ayni anda yeni is gelse de yol verip geri gelmez
    const a = k.add('data', { topic: 'kedi', target: 0 });
    await wait(() => k.jobs.get(a.id).status === 'running');
    k.cancel(a.id);
    const e1 = k.add('training', {});
    await wait(() => k.jobs.get(e1.id).status === 'done');
    assert.deepEqual([k.jobs.get(a.id).status, k.jobs.get(a.id).yielded], ['cancelled', false]);
    // Yol vermis (duraklatilmis) is iptal edilebilir
    const b = k.add('data', { topic: 'köpek', target: 0 });
    await wait(() => k.jobs.get(b.id).status === 'running');
    const e2 = k.add('training', { long: true });
    await wait(() => k.jobs.get(b.id).status === 'paused' && k.jobs.get(e2.id).status === 'running');
    k.cancel(b.id);
    assert.deepEqual([k.jobs.get(b.id).status, k.jobs.get(b.id).yielded], ['cancelled', false]);
    k.cancel(e2.id);
    await wait(() => k.jobs.get(e2.id).status === 'cancelled');
    // "Devam ettir" (yenidenDene) ile giren is de calisan sinirsiz toplamaya sira aldirir
    const c = k.add('data', { topic: 'kuş', target: 0 });
    await wait(() => k.jobs.get(c.id).status === 'running');
    k.tryAgain(e2.id);
    await wait(() => k.jobs.get(c.id).status === 'paused' && k.jobs.get(c.id).yielded === true);
    k.cancel(e2.id);
    await wait(() => k.jobs.get(c.id).status === 'running');
    // Duzgun kapanis: calisan yol veren is "yarida" degil, acilinca surecek sekilde pausable
    k.closed = true;
    k.active.control.abort();
    await wait(() => k.jobs.get(c.id).status !== 'running');
    assert.deepEqual([k.jobs.get(c.id).status, k.jobs.get(c.id).yielded], ['paused', true]);
  } finally {
    k.closed = true;
    rmSync(root, { recursive: true, force: true });
  }
});

test('text model sharing: bot requests are not held while data collection or a job without the GPU runs; they wait during image/training jobs', async () => {
  const data = await import('../lib/jobs/data.mjs');
  const training = await import('../lib/jobs/training.mjs');
  const pageVideo = await import('../lib/jobs/page-video.mjs');
  const videoEdit = await import('../lib/jobs/video-edit.mjs');
  const k = new Queue({ setting: { dataRoot: '.' }, comfy: null, mod: {}, runners: { data, training, image, pageVideo, videoEdit } });
  assert.equal(k.externalRequestShouldWait(), false, 'queue empty');
  k.active = { job: { type: 'data' } };
  assert.equal(k.externalRequestShouldWait(), false, 'data collection uses the text model itself: shares it (so the nedese bot does not fall back to DeepSeek)');
  k.active = { job: { type: 'image' } };
  assert.equal(k.externalRequestShouldWait(), true, 'image job uses the GPU through ComfyUI');
  k.active = { job: { type: 'training' } };
  assert.equal(k.externalRequestShouldWait(), true, 'training fills the GPU');
  // 09.10.2026: the Text page recorded in a page video waited for the recording to end
  k.active = { job: { type: 'pageVideo' } };
  assert.equal(k.externalRequestShouldWait(), false, 'a page video records in a browser: the GPU stays free');
  k.active = { job: { type: 'videoEdit' } };
  assert.equal(k.externalRequestShouldWait(), false, 'a video edit runs ffmpeg: the GPU stays free');
  k.active = null;
});
