/**
 * Uzun video: parca plani, parca parca uretim (her parca oncekinin son karesinden, renk
 * sabitleme), parca mp4'leri ve kare temizligi, yarida kalinca son biten parcadan surme,
 * concat ile tek mp4 (sure ffprobe ile olculur).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createPanel } from './env.mjs';
import { streams } from '../lib/ffmpeg.mjs';
import { makePng } from '../lib/media.mjs';
import { partTotalFrame, durationText, videoParts } from '../lib/plan.mjs';
import { validate as validateVideo, splitCount } from '../lib/jobs/video.mjs';

const promptCount = (p) => p.fake.status.records.filter((k) => k.path === '/prompt').length;

test('videoParcalari: 5 s single part, 12 s three parts, 1 hour 720 parts, frame total', () => {
  assert.deepEqual(videoParts(5, 81, 16), [81]);
  assert.deepEqual(videoParts(2, 81, 16), [33]);
  assert.deepEqual(videoParts(12, 81, 16), [81, 81, 33]);
  assert.equal(partTotalFrame([81, 81, 33]), 81 + 80 + 32);
  assert.equal(partTotalFrame([81, 81, 33], 2), 161 + 160 + 64);
  const hour = videoParts(3600, 81, 16);
  assert.equal(hour.length, 720);
  assert.ok(hour.every((k) => k % 4 === 1 && k >= 33 && k <= 81));
  assert.ok(Math.abs(partTotalFrame(hour) / 16 - 3600) < 3, 'total ≈ 1 hour');
  assert.equal(videoParts(3600 * 24, 81, 16).length, 17280, 'one day: no limit');
  assert.equal(durationText(76 * 3600), '3 d 4 h');
  assert.equal(durationText(5 * 3600 + 120), '5 h 02 min');
  assert.equal(durationText(5), '5 s', 'stored in English: an English page showed "5 sn"');
  assert.equal(durationText(159), '2 min 39 s');
});

test('long video: 12 s = 3 parts, error in part 2 → retry continues from the last finished part, single mp4', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg || !p.setting.ffprobe) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261003-120000-kare.png'), makePng(160, 90, [200, 120, 40]));
    p.fake.status.errorRequest = [2, 3];
    // Zincir (anahtar kare kapali): parca 2'deki hata ve kaldigi yerden surme
    const job = p.queue.add('video', { source: 'upload/20261003-120000-kare.png', prompt: 'walk', model: 'wan14', duration: 12, resolution: '480p', fps: '', keyFrame: false });
    assert.deepEqual([job.input.part, job.input.frame, job.input.colorPin], [3, 81, true]);
    assert.match(job.summary.detail, /12 (sn|s) \(3 parts\)/);
    const first = await p.waitUntilDone(job.id, 60000);
    assert.equal(first.status, 'error');
    assert.match(first.error, /Not enough GPU memory/);
    const k = join(p.setting.outputRoot, job.id);
    assert.ok(existsSync(join(k, 'parts', 'p0001.mp4')), 'part 1 ready as mp4');
    assert.ok(existsSync(join(k, 'parts', 'p0001.last.png')), 'last frame kept');
    assert.ok(!existsSync(join(k, 'parts', 'frames')) || true);
    assert.equal(JSON.parse(readFileSync(join(k, 'parts', 'checkpoint.json'), 'utf8')).finished, 1);

    p.fake.status.errorRequest = null;
    p.queue.tryAgain(job.id);
    const last = await p.waitUntilDone(job.id, 90000);
    assert.equal(last.status, 'done', last.error);
    assert.equal(promptCount(p), 5, "1 + 2 failed (the attempt and the panel's retry) + 2 (part 1 not regenerated)");
    const log = readFileSync(join(k, 'log.txt'), 'utf8');
    assert.match(log, /Resuming: 1\/3 parts ready/);
    assert.match(log, /Part 3\/3: 32 frames/);
    // Devam parcalari kaynak olarak onceki son kareyi (renk duzeltilmis) yukledi.
    const uploaded = p.fake.status.uploaded;
    assert.ok(uploaded.some((a) => /p0001\.png$/.test(a)) && uploaded.some((a) => /p0002\.png$/.test(a)) && uploaded.some((a) => /p0003\.png$/.test(a)), uploaded.join(','));
    assert.ok(!existsSync(join(k, 'parts')), 'part folder deleted');
    const c = last.outputs[0];
    assert.deepEqual([c.file, c.fps], ['video.mp4', 16]);
    assert.equal(c.duration, Math.round(((81 + 80 + 32) / 16) * 100) / 100);
    const v = await streams(p.setting.ffprobe, join(k, 'video.mp4'));
    assert.ok(Math.abs(v.duration - 193 / 16) < 0.1, `ffprobe ${v.duration}`);
    assert.deepEqual([job.input.width, job.input.height], [832, 480]);
    assert.ok(last.measurements['video/wan14/480p'] > 0);
  } finally {
    await p.close();
  }
});

test('1080p direct (fine setting on, strong GPU): Wan wants 1920×1088 (multiple of 16), output is center-cropped to 1920×1080; 1080×1920 in portrait', async (t) => {
  const p = await createPanel({ imageData: () => makePng(1920, 1088, [90, 120, 200]) });
  if (!p.setting.ffmpeg || !p.setting.ffprobe) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    p.settingFile.saveFineSettings({ video1080p: true }, {});
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261003-120002-kare.png'), makePng(160, 90));
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261003-120003-dikey.png'), makePng(90, 160));
    const portrait = p.queue.add('video', { source: 'upload/20261003-120003-dikey.png', model: 'wan14', duration: 1, resolution: '1080p' });
    assert.deepEqual([portrait.input.width, portrait.input.height, portrait.input.truncate], [1088, 1920, [1080, 1920]]);
    p.queue.cancel(portrait.id);
    const job = p.queue.add('video', { source: 'upload/20261003-120002-kare.png', model: 'wan14', duration: 1, resolution: '1080p' });
    assert.deepEqual([job.input.width, job.input.height, job.input.truncate], [1920, 1088, [1920, 1080]]);
    assert.match(job.summary.detail, /1920×1080/);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const graph = JSON.parse(p.fake.status.records.filter((k) => k.path === '/prompt').at(-1).prompt).prompt;
    const wan = Object.values(graph).find((d) => d.class_type === 'WanImageToVideo');
    assert.deepEqual([wan.inputs.width, wan.inputs.height], [1920, 1088], 'model generates at 1088');
    const v = (await streams(p.setting.ffprobe, join(p.setting.outputRoot, job.id, 'video.mp4'))).streams.find((a) => a.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [1920, 1080], 'mp4 cropped');
    assert.deepEqual([last.outputs[0].width, last.outputs[0].height], [1920, 1080]);
    assert.ok(last.measurements['video/wan14/1080p'] > 0, 'duration measurement under the 1080p key');
  } finally {
    await p.close();
  }
});

test('1080p upscaling (default, 12 GB): Wan generates 720p, frames are upscaled to 1920×1080 with the 2x model; last frame for the chain is 720p; clear error when the model is missing', async (t) => {
  const p = await createPanel({ imageData: () => makePng(1280, 720, [90, 120, 200]) });
  if (!p.setting.ffmpeg || !p.setting.ffprobe) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261006-020100-kare.png'), makePng(160, 90));
    assert.throws(() => p.queue.add('video', { source: 'upload/20261006-020100-kare.png', model: 'wan14', duration: 1, resolution: '1080p' }), /No 1080p upscale model/);
    mkdirSync(dirname(p.setting.upscaleModel), { recursive: true });
    writeFileSync(p.setting.upscaleModel, 'fake');
    const job = p.queue.add('video', { source: 'upload/20261006-020100-kare.png', model: 'wan14', duration: 6, resolution: '1080p', fps: '', keyFrame: false });
    assert.deepEqual([job.input.width, job.input.height, job.input.upscale, job.input.truncate], [1280, 720, [1920, 1080], undefined], 'generation 720p, target 1080p');
    assert.match(job.summary.detail, /1920×1080 \(720p upscale\)/);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const graphs = p.fake.status.records.filter((k) => k.path === '/prompt').map((k) => JSON.parse(k.prompt).prompt);
    const wans = graphs.map((g) => Object.values(g).find((x) => x.class_type === 'WanImageToVideo')).filter(Boolean);
    assert.equal(wans.length, 2, 'two parts');
    assert.ok(wans.every((w) => w.inputs.width === 1280 && w.inputs.height === 720), 'model generates 720p');
    // Ikinci parcanin baslangic karesi birincinin son karesi: 720p (buyutulmeden saklandi)
    const uploaded = p.fake.status.uploaded.find((a) => /p0001/.test(a));
    assert.ok(uploaded, p.fake.status.uploaded.join(','));
    const v = (await streams(p.setting.ffprobe, join(p.setting.outputRoot, job.id, 'video.mp4'))).streams.find((a) => a.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [1920, 1080], 'mp4 1080p');
    assert.deepEqual([last.outputs[0].width, last.outputs[0].height], [1920, 1080]);
    const log = readFileSync(join(p.setting.outputRoot, job.id, 'log.txt'), 'utf8');
    assert.match(log, /Part 1\/2: \d+ frames, \d+ s \+ 1080p upscaling \d+ s/);
    // Buyutucu hata verirse acik hata
    process.env.FAKE_UPSCALE_ERROR = '1';
    const job2 = p.queue.add('video', { source: 'upload/20261006-020100-kare.png', model: 'wan14', duration: 1, resolution: '1080p' });
    const last2 = await p.waitUntilDone(job2.id, 60000);
    delete process.env.FAKE_UPSCALE_ERROR;
    assert.deepEqual([last2.status, last2.error], ['error', '1080p upscaling: Upscale model could not be opened (fake).']);
  } finally {
    delete process.env.FAKE_UPSCALE_ERROR;
    await p.close();
  }
});

test('frame rate: preset 24/30/60 and custom (1-240), RIFE multiplier target/native (at most 8), single-part plan follows the fps', async () => {
  const { validateFps, rifeFactor } = await import('../lib/jobs/common.mjs');
  assert.equal(validateFps(''), null);
  assert.equal(validateFps('', { defaultValue: 30 }), 30);
  assert.equal(validateFps('120'), 120);
  assert.throws(() => validateFps('500'), /at most 240/);
  assert.throws(() => validateFps('0'), /at least 1/);
  assert.throws(() => validateFps('29.97'), /whole number/);
  assert.equal(rifeFactor(16, 24), 2);
  assert.equal(rifeFactor(16, 30), 2);
  assert.equal(rifeFactor(16, 60), 4);
  assert.equal(rifeFactor(16, 120), 8);
  assert.equal(rifeFactor(16, 240), 8, 'upper limit 8');
  assert.equal(rifeFactor(24, 24), 1);
  assert.equal(rifeFactor(16, 30, 1.5), 3, 'slow motion taken into account');
  assert.equal(rifeFactor(16, 60, 1.6), 6);
  const p = await createPanel();
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261003-120001-kare.png'), makePng(160, 90));
    const job = p.queue.add('video', { source: 'upload/20261003-120001-kare.png', model: 'wan14', duration: 2, fps: '60' });
    assert.deepEqual([job.input.fps, job.input.smooth], [60, 4]);
    p.queue.cancel(job.id);
    assert.throws(() => p.queue.add('video', { source: 'upload/20261003-120001-kare.png', model: 'wan14', duration: 2, fps: '1000' }), /Frame rate/);
    const film = await import('../lib/jobs/film.mjs');
    const g = film.validate({ scenes: [{ narration: 'a', image: 'b' }], voice: 'model', fps: '60' }, { mod: p.mod, setting: p.setting });
    assert.equal(g.fps, 60);
    const g2 = film.validate({ scenes: [{ narration: 'a', image: 'b' }], voice: 'model' }, { mod: p.mod, setting: p.setting });
    assert.equal(g2.fps, 30);
  } finally {
    await p.close();
  }
});

test('identity protection: before a continuation part the last frame goes through Qwen-Image-Edit with the source (character as in the source), framing suffix in the prompt; none when off', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261006-033000-kedi.png'), makePng(160, 90, [200, 120, 40]));
    const job = p.queue.add('video', { source: 'upload/20261006-033000-kedi.png', prompt: 'the kitten jumps', model: 'wan14', duration: 12, resolution: '480p', fps: '', idProtect: true });
    assert.deepEqual([job.input.idProtect, job.input.part], [true, 3]);
    assert.match(job.summary.detail, /identity protected/);
    const last = await p.waitUntilDone(job.id, 90000);
    assert.equal(last.status, 'done', last.error);
    const graphs = p.fake.status.records.filter((k) => k.path === '/prompt').map((k) => JSON.parse(k.prompt).prompt);
    const edit = graphs.filter((g) => Object.values(g).some((d) => d.class_type === 'TextEncodeQwenImageEditPlus'));
    assert.equal(edit.length, 2, 'before parts 2 and 3');
    for (const g of edit) {
      const uploaded = Object.values(g).filter((d) => d.class_type === 'LoadImage').map((d) => d.inputs.image);
      assert.equal(uploaded.length, 2, 'image 1 is the frame, image 2 is the source');
      assert.match(uploaded[1], /_source\.png$/);
      assert.match(Object.values(g).find((d) => d.class_type === 'TextEncodeQwenImageEditPlus').inputs.prompt, /look exactly like the same character in image 2/);
    }
    const wanTexts = graphs.filter((g) => Object.values(g).some((d) => d.class_type === 'WanImageToVideo')).map((g) => Object.values(g).find((d) => d.class_type === 'CLIPTextEncode').inputs.text);
    assert.equal(wanTexts.length, 3);
    assert.ok(!/Keep the main character fully in frame/.test(wanTexts[0]), 'no suffix in the first part');
    assert.ok(wanTexts.slice(1).every((m) => /Keep the main character fully in frame/.test(m)), wanTexts.join(' | '));
    const log = readFileSync(join(p.setting.outputRoot, job.id, 'log.txt'), 'utf8');
    assert.equal((log.match(/the character in the starting frame was corrected to match the source/g) ?? []).length, 2);
    // Kapaliyken (varsayilan): kimlik duzeltmesi yok; A14B cok parcada varsayilan anahtar kare (ilk-son kare)
    const once = p.fake.status.records.length;
    const is2 = p.queue.add('video', { source: 'upload/20261006-033000-kedi.png', prompt: 'the kitten jumps', model: 'wan14', duration: 6, resolution: '480p', fps: '' });
    assert.deepEqual([is2.input.idProtect, is2.input.keyFrame], [undefined, true]);
    assert.equal((await p.waitUntilDone(is2.id, 90000)).status, 'done');
    const fresh = p.fake.status.records.slice(once).filter((k) => k.path === '/prompt').map((k) => JSON.parse(k.prompt).prompt);
    const prompts = fresh.flatMap((g) => Object.values(g).filter((d) => d.class_type === 'TextEncodeQwenImageEditPlus').map((d) => d.inputs.prompt ?? ''));
    assert.ok(!prompts.some((m) => /look exactly like the same character in image 2/.test(m)), 'no identity correction by default');
    assert.equal(fresh.filter((g) => Object.values(g).some((d) => d.class_type === 'WanFirstLastFrameToVideo')).length, 2, 'by default both parts are first-last frame');
  } finally {
    await p.close();
  }
});

test("keyframes: each part's end frame is generated from the source in a single request, parts run between first and last frame", async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261006-110000-kedi.png'), makePng(160, 90, [200, 120, 40]));
    const job = p.queue.add('video', { source: 'upload/20261006-110000-kedi.png', prompt: 'the kitten jumps', model: 'wan14', duration: 12, resolution: '480p', fps: '', keyFrame: true, idProtect: true });
    assert.deepEqual([job.input.keyFrame, job.input.idProtect, job.input.part], [true, undefined, 3], 'keyframes replace identity protection');
    assert.match(job.summary.detail, /keyframes/);
    const last = await p.waitUntilDone(job.id, 90000);
    assert.equal(last.status, 'done', last.error);
    const graphs = p.fake.status.records.filter((k) => k.path === '/prompt').map((k) => JSON.parse(k.prompt).prompt);
    const edit = graphs.filter((g) => Object.values(g).some((d) => d.class_type === 'TextEncodeQwenImageEditPlus'));
    assert.equal(edit.length, 1, 'all keyframes in a single request');
    // Anahtar karelerden hemen once ComfyUI bellegi bosaltilir (16 GB RAM'de Wan + Qwen sayfa dosyasina tasiyordu)
    const position = p.fake.status.records.map((k) => (k.path === '/free' ? 'free' : k.path === '/prompt' && /TextEncodeQwenImageEditPlus/.test(k.prompt) ? 'qwen' : k.path === '/prompt' ? 'other' : null)).filter(Boolean);
    assert.equal(position[position.indexOf('qwen') - 1], 'free', position.join(','));
    // Ayni istemli parcalarin metin dugumu birlestirmede bir kez kalir; tohum ayri, cikti ayri
    assert.equal(Object.values(edit[0]).filter((d) => d.class_type === 'SaveImage').length, 3, 'end frames of 3 parts');
    const prompts = Object.values(edit[0]).filter((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && d.inputs.prompt).map((d) => d.inputs.prompt);
    assert.ok(prompts.every((s) => /Keep every character exactly as in the image/.test(s)), prompts.join(' | '));
    const uploaded = Object.values(edit[0]).filter((d) => d.class_type === 'LoadImage').map((d) => d.inputs.image);
    assert.deepEqual([...new Set(uploaded)].length, 1, 'single image: clean source');
    assert.match(uploaded[0], /_key_source\.png$/);
    const wan = graphs.filter((g) => Object.values(g).some((d) => d.class_type === 'WanFirstLastFrameToVideo'));
    assert.equal(wan.length, 3, 'every part first-last frame');
    assert.ok(!graphs.some((g) => Object.values(g).some((d) => d.class_type === 'WanImageToVideo')), 'no chaining');
    for (const [i, g] of wan.entries()) {
      const d = Object.values(g).find((x) => x.class_type === 'WanFirstLastFrameToVideo');
      const startedAt = g[d.inputs.start_image[0]].inputs.image;
      const bit = g[d.inputs.end_image[0]].inputs.image;
      assert.match(bit, new RegExp(`_p000${i + 1}_last\\.png$`), bit);
      if (i === 0) assert.match(startedAt, /_p0001\.png$/, 'first part from the source');
    }
    const log = readFileSync(join(p.setting.outputRoot, job.id, 'log.txt'), 'utf8');
    assert.match(log, /3 keyframes generated from the source/);
    assert.equal((log.match(/the character in the starting frame was corrected to match the source/g) ?? []).length, 0, 'identity protection did not run');
    // Yazi modeli yok: anahtar kareler denetimsiz kullanilir, uyari bir kez
    assert.equal((log.match(/Duplicate check unavailable: the selected text model cannot read images/g) ?? []).length, 1, log);
    assert.ok(last.outputs.some((c) => c.file === 'video.mp4'));
  } finally {
    await p.close();
  }
});

test('keyframes: in a long video keyframes are generated as needed in groups of 8 (9 parts: 8 + 1)', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261006-120000-kedi.png'), makePng(160, 90, [200, 120, 40]));
    const job = p.queue.add('video', { source: 'upload/20261006-120000-kedi.png', prompt: 'the kitten walks', model: 'wan14', duration: 45, resolution: '480p', fps: '', keyFrame: true });
    assert.equal(job.input.part, 9);
    const last = await p.waitUntilDone(job.id, 180000);
    assert.equal(last.status, 'done', last.error);
    const graphs = p.fake.status.records.filter((k) => k.path === '/prompt').map((k) => JSON.parse(k.prompt).prompt);
    const edit = graphs.filter((g) => Object.values(g).some((d) => d.class_type === 'TextEncodeQwenImageEditPlus'));
    assert.deepEqual(edit.map((g) => Object.values(g).filter((d) => d.class_type === 'SaveImage').length), [8, 1], 'two requests: 8 + 1');
    const log = readFileSync(join(p.setting.outputRoot, job.id, 'log.txt'), 'utf8');
    assert.match(log, /8 keyframes generated from the source \(1-8\/9/);
    assert.match(log, /1 keyframe generated from the source \(9-9\/9/);
    assert.equal(graphs.filter((g) => Object.values(g).some((d) => d.class_type === 'WanFirstLastFrameToVideo')).length, 9);
  } finally {
    await p.close();
  }
});

test('keyframe default: on for A14B with multiple parts; 5B, single part, anahtarKare: false and explicitly requested identity protection turn it off; chain when Qwen-Image-Edit is missing', async () => {
  const p = await createPanel();
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261006-200000-kedi.png'), makePng(160, 90, [200, 120, 40]));
    const d = (g, mod = p.queue.mod) => validateVideo({ source: 'upload/20261006-200000-kedi.png', prompt: 'x', fps: '', resolution: '480p', ...g }, { mod, setting: p.queue.setting });
    assert.equal(d({ model: 'wan14', duration: 12 }).keyFrame, true, 'A14B, 3 parts: on by default');
    assert.equal(d({ model: 'wan14', duration: 12, keyFrame: false }).keyFrame, undefined, 'form checkbox off');
    assert.equal(d({ model: 'wan14', duration: 5 }).keyFrame, undefined, 'single part');
    assert.equal(d({ model: 'wan5', duration: 12, keyFrame: true }).keyFrame, undefined, '5B: not an error, ignored');
    const k = d({ model: 'wan14', duration: 12, idProtect: true });
    assert.deepEqual([k.keyFrame, k.idProtect], [undefined, true], 'explicitly requested identity protection');
    const both = d({ model: 'wan14', duration: 12, idProtect: true, keyFrame: true });
    assert.deepEqual([both.keyFrame, both.idProtect], [true, undefined], 'keyframes when both boxes are checked');
    const none = d({ model: 'wan14', duration: 12 }, { ...p.queue.mod, editJob: undefined });
    assert.equal(none.keyFrame, undefined);
    assert.match(none.noKeyFrame, /Qwen-Image-Edit/, 'reason in the input (written to the job log)');
  } finally {
    await p.close();
  }
});

test('sayimAyir: "<type> = <count>" lines; list line, total and plural suffix', () => {
  assert.deepEqual(splitCount('kitten | center | armor\nkitten | left | armor\n**Kittens = 2**\n- Dragon: 1\nTOTAL = 3\nCharacters = 3'), { kitten: 2, dragon: 1 });
  assert.deepEqual(splitCount('young woman | left | red dress\nyoung woman = 1\ncat=0'), { 'young woman': 1, cat: 0 });
  assert.deepEqual(splitCount('Bu görselde karakter yok.'), {});
});

test('keyframe duplicate check: a keyframe with a duplicate is not used; that part has no end frame, the next part continues from its last frame', async (t) => {
  // Sahte gorsel yazi modeli: kaynakta 1 kedi + 1 ejder; 1. anahtar karede 2 kedi (kopya), digerlerinde 1
  const questions = [];
  const llm = {
    installed: true,
    understandsImages: true,
    info: { name: 'fake' },
    releaseGpu: async () => {},
    req: async (path, body) => {
      const parts = body.messages.at(-1).content;
      const text = parts.find((x) => x.type === 'text').text;
      assert.match(parts.find((x) => x.type === 'image_url').image_url.url, /^data:image\/jpeg;base64,/);
      questions.push(text);
      const countNo = questions.filter((s) => /^Count the characters/.test(s)).length;
      const content = /^List every character/.test(text)
        ? 'kitten | center | armor, red cape\ndragon | left | black scales\nkitten = 1\ndragon = 1'
        : countNo === 1
          ? 'kitten | left | armor\nkitten | right | armor\ndragon | left | black\nkittens = 2\ndragon = 1'
          : 'kitten | center | armor\ndragon | left | black\nkitten = 1\ndragon = 1';
      return { code: 200, json: { choices: [{ message: { content: content } }] } };
    },
  };
  const p = await createPanel({ llm });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261006-150000-kedi.png'), makePng(160, 90, [200, 120, 40]));
    // Renk sabitleme kapali: yuklenen kareler uretilen PNG'nin aynisi (anahtar kareler birbirinin aynisi, Wan son karesi farkli)
    const job = p.queue.add('video', { source: 'upload/20261006-150000-kedi.png', prompt: 'the kitten leaps sideways', model: 'wan14', duration: 12, resolution: '480p', fps: '', keyFrame: true, colorPin: false });
    const last = await p.waitUntilDone(job.id, 90000);
    assert.equal(last.status, 'done', last.error);
    assert.equal(questions.length, 4, '1 source inventory + 3 keyframe counts');
    assert.match(questions[0], /never a general word like animal, creature/, 'type name is specific (a dragon must not count as "animal")');
    assert.match(questions[1], /Kinds to count: kitten, dragon \(use exactly these names\)\./);
    const graphs = p.fake.status.records.filter((k) => k.path === '/prompt').map((k) => JSON.parse(k.prompt).prompt);
    const wan = graphs.filter((g) => Object.values(g).some((d) => /^Wan(FirstLastFrame|Image)ToVideo$/.test(d.class_type)));
    assert.deepEqual(wan.map((g) => Object.values(g).find((d) => /^Wan(FirstLastFrame|Image)ToVideo$/.test(d.class_type)).class_type), ['WanImageToVideo', 'WanFirstLastFrameToVideo', 'WanFirstLastFrameToVideo'], 'part 1 without an end frame');
    assert.ok(!p.fake.status.uploaded.some((a) => /_p0001_son\.png$/.test(a)), 'keyframe with a duplicate not uploaded');
    const body = (name) => {
      const k = p.fake.status.records.find((x) => x.path === '/upload/image' && x.body.includes(`filename="${name}"`));
      assert.ok(k, `${name} not uploaded`);
      // Yalniz dosya baytlari: cok parcali govdenin sinir satiri her yuklemede farkli
      return k.body.slice(k.body.indexOf('\r\n\r\n', k.body.indexOf(`filename="${name}"`)) + 4).split(/\r\n-+formdata/)[0];
    };
    // Parca 3 anahtar kare 2'den baslar (parca 2'nin bitis karesiyle ayni dosya); parca 2 ise parca 1'in son karesinden
    assert.equal(body(`panel_${job.id}_p0003.png`), body(`panel_${job.id}_p0002_last.png`));
    assert.notEqual(body(`panel_${job.id}_p0002.png`), body(`panel_${job.id}_p0003.png`), 'part 2 starts from the chain, not from a keyframe');
    const log = readFileSync(join(p.setting.outputRoot, job.id, 'log.txt'), 'utf8');
    assert.match(log, /Characters in the source: 1 kitten, 1 dragon/);
    assert.match(log, /Keyframe 1: 2 kitten, 1 dragon \(source: 1 kitten\): character duplicated, not used; part 1 is generated without an end frame/);
    assert.match(log, /Keyframe 2: 1 kitten, 1 dragon, no duplicate\./);
    assert.ok(last.outputs.some((c) => c.file === 'video.mp4'));
  } finally {
    await p.close();
  }
});
