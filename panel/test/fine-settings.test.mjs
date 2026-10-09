/**
 * Ince ayarlar (donanima gore): tanim ve dogrulama, ayar dosyasi (yalniz farkli olanlar), ComfyUI bayraklari ve
 * baslat_comfyui.bat, yazi modeli butcesi ve gorsel kodlayici, kuyruk (GPU paylasimi, bosaltma, RAM, yabanci GPU),
 * 1080p kapisi, egitim bayraklari ve secenekleri, API (GET/PATCH /ayarlar, /options, ComfyUI kapatma).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FINE_SETTINGS, comfyFlags, fineSetting, bindFineSettings, validateFineSettings, fineSettingsStatus } from '../lib/fine-settings.mjs';
import { SettingsFile } from '../lib/settings-file.mjs';
import { VRAM_BUDGET, llamaConfig, moeLayers, vramBudget } from '../lib/llm.mjs';
import { trainingFlags, videoResolutions, videoFrames } from '../lib/jobs/training.mjs';
import { makePng } from '../lib/media.mjs';
import { createPanel } from './env.mjs';

const DEFAULTS = Object.fromEntries(FINE_SETTINGS.map((t) => [t.key, t.defaultValue]));

test("definition: defaults are this machine's settings; an invalid entry falls back to the default; validation gives a clear error", () => {
  bindFineSettings({});
  assert.deepEqual([fineSetting('gpuShare'), fineSetting('llmVram'), fineSetting('trainingVideo720p'), fineSetting('video1080p')], [true, 'oto', false, false]);
  bindFineSettings({ gpuShare: 'yes', llmVram: '13' });
  assert.deepEqual([fineSetting('gpuShare'), fineSetting('llmVram')], [true, 'oto'], 'invalid value falls back to the default');
  bindFineSettings(() => {
    throw new Error('settings file could not be read');
  });
  assert.equal(fineSetting('waitRam'), true, 'default if the source throws');
  assert.throws(() => fineSetting('none'), /Unknown fine setting/);
  assert.deepEqual(validateFineSettings({ gpuShare: false, llmVram: 24 }), { gpuShare: false, llmVram: '24' });
  assert.throws(() => validateFineSettings({ fabricated: true }), /Unknown fine setting: fabricated/);
  assert.throws(() => validateFineSettings({ gpuShare: 'no' }), /must be true or false/);
  assert.throws(() => validateFineSettings({ llmVram: '13' }), /must be one of: oto, 8, 12/);
  assert.throws(() => validateFineSettings({}), /No fine setting to change/);
  assert.throws(() => validateFineSettings([]), /must be an object/);
  bindFineSettings({});
  const d = fineSettingsStatus();
  assert.equal(d.settings.length, FINE_SETTINGS.length);
  assert.ok(d.settings.every((a) => d.groups.includes(a.group) && a.name && a.description && 'value' in a && !('flag' in a)), 'every setting has a group, name, description and value; no flags are returned');
  assert.deepEqual(d.settings.find((a) => a.key === 'llmVram').options[0], { value: 'oto', name: "From the card's memory (automatic)" });
});

test('settings file: only values that differ from the default are kept', () => {
  const a = new SettingsFile(join(mkdtempSync(join(tmpdir(), 'ince-')), 'ayar.json'));
  a.saveFineSettings({ gpuShare: false, llmVram: '24' }, DEFAULTS);
  assert.deepEqual(a.fineSettings, { gpuShare: false, llmVram: '24' });
  a.saveFineSettings({ gpuShare: true }, DEFAULTS);
  assert.deepEqual(a.fineSettings, { llmVram: '24' }, 'values reset to the default are removed');
  assert.deepEqual(JSON.parse(readFileSync(a.path, 'utf8')).fineSettings, { llmVram: '24' });
});

test("ComfyUI flags: default is this machine's three, disabled ones are dropped; start_comfyui.bat reads AI_COMFY_MEMORY", (t) => {
  bindFineSettings({});
  assert.equal(comfyFlags(), '--cache-none --disable-pinned-memory --disable-dynamic-vram');
  bindFineSettings({ noComfyCache: false, noComfyPinned: false, noComfyDynamic: false });
  assert.equal(comfyFlags(), '');
  bindFineSettings({ noComfyPinned: false });
  assert.equal(comfyFlags(), '--cache-none --disable-dynamic-vram');
  bindFineSettings({});
  if (process.platform !== 'win32') {
    t.skip('no cmd');
    return;
  }
  // Bat'in bayrak mantigi gercek cmd ile: python satiri yerine echo
  const bat = readFileSync(new URL('../../start_comfyui.bat', import.meta.url), 'utf8');
  const dry = join(mkdtempSync(join(tmpdir(), 'bat-')), 'kuru.bat');
  writeFileSync(dry, bat.split(/\r?\n/).map((l) => (l.startsWith('.\\python_embeded') ? 'echo [%BELLEK%]' : l.startsWith('cd /d') ? 'rem cd' : l)).join('\r\n'));
  const { AI_COMFY_MEMORY: _, ...clean } = process.env;
  const run = (env) => execFileSync('cmd.exe', ['/d', '/c', dry], { encoding: 'utf8', env: { ...clean, ...env }, windowsHide: true }).trim();
  assert.equal(run({}), '[--disable-pinned-memory --disable-dynamic-vram --cache-none]', "manual start uses this machine's setting");
  assert.equal(run({ AI_COMFY_MEMORY: 'none' }), '[]');
  assert.equal(run({ AI_COMFY_MEMORY: '--cache-none' }), '[--cache-none]');
});

test('text model: budget from the GPU memory (12 GB card = 10.8), MoE expert layers by budget; vision encoder on the GPU via fine setting', () => {
  assert.equal(vramBudget('oto', 12227), VRAM_BUDGET, 'bu kart (nvidia-smi 12227 MiB)');
  assert.equal(vramBudget('oto', null), VRAM_BUDGET, 'bilinmiyorsa 12 GB kart');
  assert.equal(vramBudget('12'), 10.8);
  assert.equal(vramBudget('24'), 22.7);
  assert.equal(vramBudget('oto', 24564), 22.8);
  assert.equal(moeLayers(13.45), 11, 'Gemma 26B QAT: 11 layers in RAM on this card (measured)');
  assert.equal(moeLayers(13.45, 22.7), 0, 'on a 24 GB card everything is on the GPU');
  const info = { gib: 13.45, mmprojGib: 1.19 }; // model yolu yok: üst veri okunamaz, MoE yolu
  assert.deepEqual(llamaConfig(info), { ngl: 99, moe: 11, context: 32768, kv: 'f16', mmprojGpu: false });
  assert.deepEqual(llamaConfig(info, 32768, { mmprojProcessor: false }), { ngl: 99, moe: 14, context: 32768, kv: 'f16', mmprojGpu: true }, 'as many layers as the encoder (3) more go to RAM (measured 05.10.2026)');
  assert.deepEqual(llamaConfig(info, 32768, { budget: 22.7, mmprojProcessor: false }), { ngl: 99, moe: 0, context: 32768, kv: 'f16', mmprojGpu: true });
});

test('training: no flags by default; when disabled they are passed to the scripts; video 720p / 81 frames and sample limit via fine settings', () => {
  bindFineSettings({});
  assert.deepEqual([trainingFlags({ fp8: true }), trainingFlags({ fourBit: true }), trainingFlags({ music: true })], [[], [], []]);
  assert.deepEqual([Object.keys(videoResolutions()), videoFrames()], [['480p', '320p'], [17, 33, 49]]);
  bindFineSettings({ trainingFp8: false, trainingText4bit: false, trainingMusicEncoder: false, trainingGradient: false, trainingVideo720p: true });
  assert.deepEqual(trainingFlags({ fp8: true }), ['--full-precision', '--no-gradient']);
  assert.deepEqual(trainingFlags({ fourBit: true }), ['--full-precision', '--no-gradient']);
  assert.deepEqual(trainingFlags({ music: true }), ['--encoder-gpu', '--no-gradient']);
  assert.deepEqual([Object.keys(videoResolutions()), videoFrames()], [['720p', '480p', '320p'], [17, 33, 49, 81]]);
  assert.deepEqual(videoResolutions()['720p'].landscape, [1280, 704], 'Wan 5B: multiple of 32');
  bindFineSettings({});
  // the Python scripts declare the flags (argparse)
  for (const [script, flags] of [['training/image.py', ['--full-precision', '--no-gradient']], ['training/music.py', ['--no-gradient', '--encoder-gpu']], ['training/train.py', ['--full-precision', '--no-gradient']], ['training/general.py', ['--full-precision', '--no-gradient']], ['voice/clone/train.py', ['--large-batch']]]) {
    const source = readFileSync(new URL(`../../${script}`, import.meta.url), 'utf8');
    for (const b of flags) assert.ok(source.includes(`add_argument('${b}'`), `${script}: ${b}`);
  }
});

test('queue: gpuPaylas off → text model is not released, bot does not wait; ramBekle/foreignGpu off → no waiting; gpuBosalt off → no /free', async () => {
  const releases = [];
  const p = await createPanel({ setting: { ramWatchdog: () => 1, ramWait: 600000, gpuWatchdog: async () => ({ reason: 'Another program is using 6 GB on the GPU.' }) } });
  try {
    p.queue.llm = { releaseGpu: async () => releases.push(Date.now()) };
    p.settingFile.saveFineSettings({ gpuShare: false, waitRam: false, foreignGpu: false, flushGpu: false }, DEFAULTS);
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261006-020000-kare.png'), makePng(160, 90));
    const job = p.queue.add('video', { source: 'upload/20261006-020000-kare.png', model: 'wan14', duration: 1, resolution: '480p' });
    let externalWaited = null;
    const wait = setInterval(() => {
      if (p.queue.active && externalWaited === null) externalWaited = p.queue.externalRequestShouldWait();
    }, 5);
    const last = await p.waitUntilDone(job.id, 30000);
    clearInterval(wait);
    assert.equal(last.status, 'done', last.error);
    assert.equal(releases.length, 0, 'text model was not released');
    assert.equal(externalWaited, false, 'bot request did not wait while the job was running');
    // Bosaltma: ComfyUI'ye /free gitmez, gunlukte yazar
    const ctx = p.queue.context({ id: 'bosaltma-deneme' }, new AbortController().signal);
    const once = p.fake.status.flushes ?? 0;
    await ctx.flushVoiceForGpu();
    assert.equal(p.fake.status.flushes ?? 0, once, '/free was not sent');
    assert.match(p.queue.logs.get('bosaltma-deneme').join('\n'), /Fine setting: the graphics card was not freed/);
    // Varsayilan (bu makine): RAM azken bekler (ilerleme asamasi "RAM bekleniyor")
    p.settingFile.saveFineSettings({ gpuShare: true, waitRam: true, foreignGpu: false, flushGpu: true }, DEFAULTS);
    const is2 = p.queue.add('video', { source: 'upload/20261006-020000-kare.png', model: 'wan14', duration: 1, resolution: '480p' });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10000 && p.queue.active?.job?.progress?.stage !== 'Waiting for RAM') await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(p.queue.active?.job?.progress?.stage, 'Waiting for RAM');
    assert.ok(releases.length >= 1, 'text model released while gpuPaylas is on');
    assert.equal(p.queue.externalRequestShouldWait(), true);
    p.queue.cancel(is2.id);
  } finally {
    await p.close();
  }
});

test('API: GET /settings returns fine settings, PATCH saves (invalid → 400), changing a ComfyUI flag closes idle ComfyUI; 1080p gate', async () => {
  const p = await createPanel({ server: true });
  const req = async (path, method = 'GET', body) => {
    const r = await fetch(`${p.address}/api/v1${path}`, { method: method, headers: { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, j: await r.json() };
  };
  try {
    const a = await req('/settings');
    assert.equal(a.j.fineSettings.settings.length, FINE_SETTINGS.length);
    assert.ok(a.j.fineSettings.settings.every((x) => x.value === x.defaultValue));
    const bad = await req('/settings', 'PATCH', { fineSettings: { fabricated: 1 } });
    assert.deepEqual([bad.code, bad.j.error], [400, 'Unknown fine setting: fabricated']);
    // ComfyUI (sahte) açık ve iş yok: bellek bayrağı değişince kapatılır, sonraki iş yeni bayraklarla açar
    const once = p.closings.length;
    const r = await req('/settings', 'PATCH', { fineSettings: { noComfyCache: false } });
    assert.equal(r.code, 200, JSON.stringify(r.j));
    assert.equal(r.j.message, 'Fine settings saved. ComfyUI was closed: the next job opens it with the new flags.');
    assert.equal(p.closings.length, once + 1);
    assert.deepEqual(p.settingFile.fineSettings, { noComfyCache: false });
    assert.equal(comfyFlags(), '--disable-pinned-memory --disable-dynamic-vram');
    assert.equal(r.j.fineSettings.settings.find((x) => x.key === 'noComfyCache').value, false);
    // Ayni deger: kapatma yok
    const same = await req('/settings', 'PATCH', { fineSettings: { noComfyCache: false } });
    assert.equal(same.j.message, 'The fine settings were already like this.');
    assert.equal(p.closings.length, once + 1);
    // 1080p: secenekler formlara ince ayari bildirir; dogrudan kapaliyken (varsayilan) 720p uretip buyutme, aciksa 1088
    assert.equal((await req('/options')).j.fineSettings.video1080p, false);
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261006-020001-kare.png'), makePng(160, 90));
    mkdirSync(dirname(p.setting.upscaleModel), { recursive: true });
    writeFileSync(p.setting.upscaleModel, 'fake');
    const v = await req('/jobs', 'POST', { type: 'video', source: 'upload/20261006-020001-kare.png', resolution: '1080p' });
    assert.equal(v.code, 200, JSON.stringify(v.j));
    const g1 = p.queue.jobs.get(v.j.job.id).input;
    assert.deepEqual([g1.height, g1.upscale], [720, [1920, 1080]]);
    p.queue.cancel(v.j.job.id);
    await req('/settings', 'PATCH', { fineSettings: { video1080p: true } });
    assert.equal((await req('/options')).j.fineSettings.video1080p, true);
    const v2 = await req('/jobs', 'POST', { type: 'video', source: 'upload/20261006-020001-kare.png', resolution: '1080p' });
    const g2 = p.queue.jobs.get(v2.j.job.id).input;
    assert.deepEqual([g2.height, g2.truncate], [1088, [1920, 1080]]);
    p.queue.cancel(v2.j.job.id);
    // Varsayilana donus: dosyada ince ayar kalmaz
    await req('/settings', 'PATCH', { fineSettings: DEFAULTS });
    assert.deepEqual(p.settingFile.fineSettings, {});
  } finally {
    await p.close();
  }
});
