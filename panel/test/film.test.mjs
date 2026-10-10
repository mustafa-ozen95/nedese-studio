/**
 * Tek parca film, bastan sona: sahte ComfyUI + sahte seslendirme + GERCEK ffmpeg.
 * Sureler ffprobe ile olculur (tahmin degil): sahne = anlatim + bosluklar, film = sahneler - gecisler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { setTextModel } from '../lib/prompt-translate.mjs';
import { streams } from '../lib/ffmpeg.mjs';
import { wavDuration } from '../lib/media.mjs';
import { DEFAULT, scenePlan, timeChart } from '../lib/plan.mjs';

const promptCount = (p) => p.fake.status.records.filter((k) => k.path === '/prompt').length;

test('film: 3 scenes (one is extended), resumes where it left off after an interruption, durations are measured', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg || !p.setting.ffprobe) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const scenes = [
      { narration: 'Once upon a time, there were endless worlds made of blocks.', image: 'a world made of blocks', motion: 'slow push in' },
      { narration: 'Kısa.', image: 'a castle' },
      // 9,5 sn anlatim: tek klip (5,06 sn x 1,6) yetmez -> son kareden ikinci parca uretilir.
      { narration: 'Minik kahramanlar oralarda kaleler kurar, ejderhalar evcilleştirir, sandıkları açar ve yumurtaları çatlatırdı; herkes bu sırrı bilirdi.', image: 'tiny heroes' },
    ];
    // 3. ComfyUI istegi (2. sahnenin videosu) VRAM hatasi verir, panelin yeniden denemesi (4.) de: is yarida kalir.
    p.fake.status.errorRequest = [3, 4];
    const job = p.queue.add('film', { title: 'Deneme Filmi', ratio: '16:9', imageModel: 'flux', videoModel: 'wan14', voice: 'model', quality: 'fast', subtitle: true, transition: true, seed: 5, scenes });
    const first = await p.waitUntilDone(job.id, 120000);
    assert.equal(first.status, 'error');
    assert.match(first.error, /Not enough GPU memory/);
    assert.equal(promptCount(p), 4, 'images in one request + scene 1 video + scene 2 (error, retry also fails)');
    assert.match(readFileSync(join(p.setting.outputRoot, job.id, 'log.txt'), 'utf8'), /Not enough GPU memory \([^)]+\); freeing ComfyUI memory and retrying the same step once/);

    p.fake.status.errorRequest = null;
    p.queue.tryAgain(job.id);
    const last = await p.waitUntilDone(job.id, 180000);
    assert.equal(last.status, 'done', last.error);
    // Yeniden denemede ses ve gorseller yeniden uretilmedi; sahne 1 videosu da.
    // Sahne 2: 1 istek; sahne 3: 2 parca = 2 istek.
    assert.equal(promptCount(p), 7);
    const k = join(p.setting.outputRoot, job.id);
    const log = readFileSync(join(k, 'log.txt'), 'utf8');
    const VOICE_LINE = /Voice-over: \d+ lines/;
    assert.equal(log.match(new RegExp(VOICE_LINE.source, 'g')).length, 1, 'voice-over once');
    // Yazi modeli isleri (hareket istemleri) seslendirmeden hemen sonra, gorsellerden once ve bir kez: video
    // asamasinda yazi modeli yeniden yuklenmez (07.10.2026: sahne basina 18-20 sn yukleme + Wan'in bellekten cikmasi).
    const lines = log.split('\n');
    assert.equal(log.match(/Stage: 2\/5 Preparation/g)?.length, 1, 'preparation once (prompts are ready on retry)');
    const preparation = lines.findIndex((s) => /Stage: 2\/5 Preparation/.test(s));
    assert.ok(preparation > lines.findIndex((s) => VOICE_LINE.test(s)), 'preparation after voice-over');
    assert.ok(preparation < lines.findIndex((s) => /ComfyUI request/.test(s)), 'preparation before the first ComfyUI request');

    // Plan: sahne suresi = anlatim + bosluklar; olculen WAV'larla ayni hesap.
    const narrations = [1, 2, 3].map((i) => wavDuration(join(k, `scene0${i}.wav`)));
    const plans = narrations.map((a) => scenePlan({ narration: a, frame: 81, fps: 16 }));
    assert.deepEqual(plans.map((x) => x.part), [1, 1, 2]);
    assert.equal(plans[1].truncate, true, 'short narration is trimmed');
    assert.ok(plans[0].slowdown > 1, 'medium narration is slowed down');
    const { total } = timeChart(plans.map((x) => x.target), DEFAULT.transition);

    // Sahne klipleri ve film: ffprobe ile olcum.
    for (let i = 0; i < 3; i++) {
      const s = await streams(p.setting.ffprobe, join(k, `scene0${i + 1}.mp4`));
      assert.ok(Math.abs(s.duration - plans[i].target) < 0.08, `scene ${i + 1}: ${s.duration} ≈ ${plans[i].target}`);
    }
    const film = await streams(p.setting.ffprobe, join(k, 'deneme-filmi.mp4'));
    assert.ok(Math.abs(film.duration - total) < 0.1, `film ${film.duration} sn ≈ ${total} sn`);
    const v = film.streams.find((a) => a.codec_type === 'video');
    const a = film.streams.find((x) => x.codec_type === 'audio');
    assert.deepEqual([v.width, v.height], [1280, 720]);
    assert.equal(v.r_frame_rate, '30/1');
    assert.equal(a.channels, 2);
    assert.equal(a.sample_rate, '48000');

    const srt = readFileSync(join(k, 'deneme-filmi.srt'), 'utf8');
    assert.match(srt, /^1\n00:00:00,600 --> /, 'first subtitle after the leading gap');
    assert.ok(existsSync(join(k, 'subtitles.ass')));
    for (let i = 1; i <= 3; i++) assert.ok(!existsSync(join(k, `scene0${i}_frames`)), 'frames deleted');
    assert.equal(last.outputs.find((c) => c.main)?.file, 'deneme-filmi.mp4');
    // Uzatma parcasi son kareden basladi: sahne 3 icin iki yukleme (gorsel + son kare).
    assert.ok(p.fake.status.uploaded.some((name) => /s03p2/.test(name)), 'continuation part was uploaded');
    // Uzun sahnenin devam parcasi ayni hareketi tekrarlamaz (yazi modeli yok: sakin devam istemi).
    const call = last.scenePrompts?.[2] ?? last.scenePrompts?.['2'];
    assert.equal(call?.length, 2, JSON.stringify(last.scenePrompts));
    assert.notEqual(call[1], call[0]);
    assert.equal(last.scenePrompts[0][0], 'slow push in');
  } finally {
    await p.close();
  }
});

// 07.10.2026 kullanici: "karakterleri disi-erkek farkini gozeterek konusturmak da lazim, sadece hikaye anlatan tek ses gibi degil".
test('film dialogue: characters with their own voice (from the library or designed from the description), scene audio = lines + gaps, speaker name in subtitles', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg || !p.setting.ffprobe) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const { addVoice, voiceInfo } = await import('../lib/voices.mjs');
    const { makeWav } = await import('../lib/media.mjs');
    const { writeFileSync: write } = await import('node:fs');
    // Kutuphanede yetiskin erkek bir ses var (Baba buradan); kiz cocugu sesi yok (Elif icin tasarlanir)
    const source = join(p.setting.aiRoot, 'tok.wav');
    write(source, makeWav(2));
    const tok = addVoice(p.setting.voiceLibrary, { name: 'Tok erkek', source, description: 'trial', spec: 'A deep, warm adult man in his forties' });
    const scenes = [
      { narration: 'Gece ilerlerken uzaktan tanıdık bir ses duyuldu.', dialogue: 'Elif: Pamuk! Neredesin?\nBaba: Buradayım kızım, korkma.', image: 'forest at night', motion: 'slow push in' },
      { narration: 'Pamuk koşup Elif\'in kollarına atladı.', image: 'girl hugging a kitten' },
      { dialogue: [{ who: 'elif', text: 'Seni çok özledim.' }], image: 'cozy room' },
    ];
    const characters = [{ name: 'Elif', gender: 'female', age: 'child', spec: 'brave and curious' }, { name: 'Baba', gender: 'male', age: 'adult' }];
    const job = p.queue.add('film', { title: 'Diyalog', ratio: '9:16', imageModel: 'flux', videoModel: 'wan14', voice: 'model', quality: 'checked', subtitle: true, transition: true, seed: 3, scenes, characters });
    const last = await p.waitUntilDone(job.id, 180000);
    assert.equal(last.status, 'done', last.error);
    const k = join(p.setting.outputRoot, job.id);
    const log = readFileSync(join(k, 'log.txt'), 'utf8');
    assert.match(log, /Character voice: Elif \(Female, Child\) → Elif \(character\) \(designed from description\)/);
    assert.match(log, /Character voice: Baba \(Male, Adult\) → Tok erkek \(from the library, by gender and age\)/);
    assert.match(log, /scene01 Elif: Whisper error rate 0, pitch 280 Hz \(in range\)/);
    assert.match(log, /scene01 Baba: Whisper error rate 0, pitch 120 Hz \(in range\)/);
    // Tasarlanan ses kutuphanede cinsiyet/yas/karakter adiyla (dizinin sonraki bolumunde ayni ses)
    const elifId = last.characterVoices?.Elif;
    assert.ok(elifId, JSON.stringify(last.characterVoices));
    assert.deepEqual([voiceInfo(p.setting.voiceLibrary, elifId).gender, voiceInfo(p.setting.voiceLibrary, elifId).age, voiceInfo(p.setting.voiceLibrary, elifId).character], ['female', 'child', 'Elif']);
    assert.equal(last.characterVoices.Baba, tok);
    // Satir basina ses: anlatim isin sesiyle (model), replikler karakter sesiyle
    const isJson = JSON.parse(readFileSync(join(k, 'narration', 'job.json'), 'utf8'));
    const line = (id) => isJson.lines.find((s) => s.id === id);
    assert.equal(line('scene01_s1').reference, undefined, 'narration line with the narrator voice');
    assert.match(line('scene01_s2').reference, new RegExp(`${elifId}\\.wav$`));
    assert.match(line('scene01_s3').reference, new RegExp(`${tok}\\.wav$`));
    assert.equal(line('scene02').reference, undefined, 'scene without dialogue is a single line as before');
    assert.match(line('scene03_s1').reference, new RegExp(`${elifId}\\.wav$`), 'scene with lines only (no narration)');
    // Sahne sesi = satirlar + aralarina 0,3 sn (olculur)
    const time = JSON.parse(readFileSync(join(k, 'scene01.lines.json'), 'utf8'));
    assert.deepEqual(time.map((z) => z.who), [null, 'Elif', 'Baba']);
    const expected = time.at(-1).last;
    assert.ok(Math.abs(wavDuration(join(k, 'scene01.wav')) - expected) < 0.05, `scene01.wav ${wavDuration(join(k, 'scene01.wav'))} ≈ ${expected}`);
    assert.ok(Math.abs(time[1].startedAt - time[0].last - 0.3) < 0.01, '0.3 s between lines');
    // Altyazida replik konusanin adiyla
    const srt = readFileSync(join(k, 'diyalog.srt'), 'utf8');
    // Replik cumlelere bolunur (anlatim gibi); konusanin adi replikle baslar
    assert.match(srt, /Elif: Pamuk!\n\n\d+\n[^\n]+\nNeredesin\?/);
    assert.match(srt, /Baba: Buradayım\skızım, korkma\./, 'subtitle line may wrap in a vertical film');
    assert.match(srt, /Elif: Seni çok özledim\./);
    assert.match(srt, /Gece ilerlerken uzaktan/);
    assert.match(last.summary.detail, /2 speaking characters/);
  } finally {
    await p.close();
  }
});

// 07.10.2026 kullanici: "Ema kaliteli begendim". EMA Lightning kutuphanede tek ses (motor: ema): secilince ya da uyan
// karaktere (yetiskin kadin) verilince o satirlar ses\ema betigiyle, digerleri ayarlardaki motorla ayri calistirmada.
test("EMA Lightning voice: in voice jobs and films that voice's lines use the EMA script, the others the usual engine", async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg || !p.setting.ffprobe) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const { makeWav } = await import('../lib/media.mjs');
    const { writeFileSync: write, mkdirSync: openFolder } = await import('node:fs');
    openFolder(p.setting.voiceLibrary, { recursive: true });
    write(join(p.setting.voiceLibrary, 'ema-lightning-kadin.wav'), makeWav(2));
    write(join(p.setting.voiceLibrary, 'ema-lightning-kadin.json'), JSON.stringify({ name: 'EMA Lightning (kadın, çok hızlı)', engine: 'ema', gender: 'female', age: 'adult', spec: 'Turkish adult female voice' }));
    // 1) Ses isi: EMA sesi secilince EMA betigi
    const voice = p.queue.add('voice', { text: 'Merhaba dünya.', voice: 'ref:ema-lightning-kadin', quality: 'checked' });
    const s1 = await p.waitUntilDone(voice.id, 60000);
    assert.equal(s1.status, 'done', s1.error);
    const r1 = JSON.parse(readFileSync(join(p.setting.outputRoot, voice.id, 'narration', 'shots', 'report.json'), 'utf8'));
    assert.equal(r1[0].selected.engine, 'ema');
    // 2) Film: anlatici her zamanki motorla, yetiskin kadin karakter (Anne) kutuphaneden EMA sesini alir, satiri EMA ile
    const job = p.queue.add('film', { title: 'EMA', ratio: '16:9', imageModel: 'flux', videoModel: 'wan14', voice: 'model', quality: 'checked', seed: 4, scenes: [{ narration: 'Akşam oldu.', dialogue: 'Anne: Yemek hazır çocuklar!', image: 'a kitchen' }], characters: [{ name: 'Anne', gender: 'female', age: 'adult' }] });
    const last = await p.waitUntilDone(job.id, 180000);
    assert.equal(last.status, 'done', last.error);
    const k = join(p.setting.outputRoot, job.id);
    assert.match(readFileSync(join(k, 'log.txt'), 'utf8'), /Character voice: Anne \(Female, Adult\) → EMA Lightning \(kadın, çok hızlı\) \(from the library, by gender and age\)/);
    const narrator = JSON.parse(readFileSync(join(k, 'narration', 'shots', 'report.json'), 'utf8'));
    const ema = JSON.parse(readFileSync(join(k, 'narration-2', 'shots', 'report.json'), 'utf8'));
    assert.deepEqual(narrator.map((x) => [x.id, x.selected.engine]), [['scene01_s1', null]], 'narration with the usual engine');
    assert.deepEqual(ema.map((x) => [x.id, x.selected.engine]), [['scene01_s2', 'ema']], 'Anne line with EMA');
    assert.ok(wavDuration(join(k, 'scene01.wav')) > 0, 'scene audio was assembled from the lines of both runs');
  } finally {
    await p.close();
  }
});

// 09.10.2026 user: "Bu sesi ema ile üret erkek sesi". A library voice with engine 'ema' and timbre <id>: EMA reads, then
// voice\convert.py gives the selected takes the timbre of voice <id> (one run for all the lines).
test('EMA voice with a timbre: EMA reads, the takes get the timbre of the library voice (voice job and film narration)', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg || !p.setting.ffprobe) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const { makeWav } = await import('../lib/media.mjs');
    const { writeFileSync: write, mkdirSync: openFolder } = await import('node:fs');
    const library = p.setting.voiceLibrary;
    openFolder(library, { recursive: true });
    write(join(library, 'narrator-a2.wav'), makeWav(3, { hz: 100 }));
    write(join(library, 'narrator-a2.json'), JSON.stringify({ name: 'Narrator A2', gender: 'male', age: 'adult' }));
    write(join(library, 'ema-a2.wav'), makeWav(2, { hz: 100 }));
    // speed: EMA reads this voice a little faster (user 09.10.2026: "Bi tık hızlandırabiliriz konuşmayı")
    write(join(library, 'ema-a2.json'), JSON.stringify({ name: 'EMA + A2', engine: 'ema', timbre: 'narrator-a2', speed: 1.1, gender: 'male', age: 'adult' }));
    write(join(library, 'ema-lost.wav'), makeWav(2));
    write(join(library, 'ema-lost.json'), JSON.stringify({ name: 'EMA lost', engine: 'ema', timbre: 'deleted-voice' }));
    const { listVoices } = await import('../lib/voices.mjs');
    assert.equal(listVoices(library).find((x) => x.id === 'ema-a2')?.timbre, 'narrator-a2', 'the library lists the timbre');

    // 1) Voice job
    const voice = p.queue.add('voice', { text: 'Merhaba dünya. Bugün hava çok güzel.', voice: 'ref:ema-a2', quality: 'checked' });
    const s1 = await p.waitUntilDone(voice.id, 60000);
    assert.equal(s1.status, 'done', s1.error);
    const n = join(p.setting.outputRoot, voice.id, 'narration');
    const read = JSON.parse(readFileSync(join(n, 'shots', 'report.json'), 'utf8'))[0].selected;
    assert.deepEqual([read.engine, read.pace], ['ema', 1.1], "EMA read the text at the voice's pace");
    const converted = JSON.parse(readFileSync(join(n, 'timbre', 'timbre.json'), 'utf8'));
    assert.equal(converted.target, join(library, 'narrator-a2.wav'), 'the timbre of the narrator');
    assert.deepEqual(converted.files.map((f) => f.split(/[\\/]/).pop()), ['voice.wav']);
    assert.match(readFileSync(join(p.setting.outputRoot, voice.id, 'log.txt'), 'utf8'), /Timbre: narrator-a2\.wav/);
    assert.ok(s1.outputs[0].duration > 0);

    // 2) Film: the narrator reads with EMA in A2's timbre, the character with the usual engine in another run
    const job = p.queue.add('film', { title: 'EMA A2', ratio: '16:9', imageModel: 'flux', videoModel: 'wan14', voice: 'ref:ema-a2', quality: 'checked', seed: 4, scenes: [{ narration: 'Akşam oldu.', dialogue: 'Elif: Yemek hazır!', image: 'a kitchen' }], characters: [{ name: 'Elif', gender: 'female', age: 'child' }] });
    const last = await p.waitUntilDone(job.id, 180000);
    assert.equal(last.status, 'done', last.error);
    const k = join(p.setting.outputRoot, job.id);
    const narrator = JSON.parse(readFileSync(join(k, 'narration', 'shots', 'report.json'), 'utf8'));
    assert.deepEqual(narrator.map((x) => [x.id, x.selected.engine, x.selected.pace]), [['scene01_s1', 'ema', 1.1]]);
    assert.deepEqual(JSON.parse(readFileSync(join(k, 'narration', 'timbre', 'timbre.json'), 'utf8')).files.map((f) => f.split(/[\\/]/).pop()), ['scene01_s1.wav']);
    assert.ok(!existsSync(join(k, 'narration-2', 'timbre')), "the character's line keeps its voice");
    assert.ok(wavDuration(join(k, 'scene01.wav')) > 0);

    // 3) The timbre voice was deleted: a clear error before any voice-over
    const lost = p.queue.add('voice', { text: 'Merhaba.', voice: 'ref:ema-lost', quality: 'fast' });
    const s3 = await p.waitUntilDone(lost.id, 60000);
    assert.equal(s3.status, 'error');
    assert.match(s3.error, /The voice "EMA lost" takes the timbre of "deleted-voice", which is not in the voice library/);
  } finally {
    await p.close();
  }
});

test('film dialogue: clear error if the speaking character is not in the list or has no gender', async () => {
  const p = await createPanel();
  try {
    const base = { title: 'x', videoModel: 'wan14', imageModel: 'flux', voice: 'model' };
    const attempt = (input) => assert.throws(() => p.queue.add('film', { ...base, ...input }));
    // Karakter hatalari lib/characters.mjs'ten
    assert.throws(() => p.queue.add('film', { ...base, scenes: [{ dialogue: 'Elif: Merhaba', image: 'g' }] }), /"Elif" speaks: add it to the Characters list and select its gender/);
    assert.throws(() => p.queue.add('film', { ...base, scenes: [{ dialogue: 'Elif: Merhaba', image: 'g' }], characters: [{ name: 'Elif' }] }), /Select a gender for "Elif"/);
    assert.throws(() => p.queue.add('film', { ...base, scenes: [{ dialogue: 'Merhaba nasılsın', image: 'g' }] }), /dialogue line 1 must be in the form "Name: words"/);
    assert.throws(() => p.queue.add('film', { ...base, scenes: [{ image: 'g' }] }), /narration/);
    attempt({ scenes: [{ dialogue: 'Elif: Merhaba', image: 'g' }], characters: [{ name: 'Elif', gender: 'female', voice: 'dosya.wav' }] });
  } finally {
    await p.close();
  }
});

test('film: same character — scene 1 from the prompt, the rest with Qwen-Image-Edit using scene 1 as reference', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const scenes = [
      { narration: 'Yaşlı balıkçı iskelede.', image: 'an old fisherman on a pier' },
      { narration: 'Meyhanede çay içiyor.', image: 'he drinks tea in a tavern' },
      { narration: 'Fırtınada tekne sürüyor.', image: 'he steers a boat in a storm' },
    ];
    const job = p.queue.add('film', { title: 'Balıkçı', ratio: '16:9', imageModel: 'flux', videoModel: 'wan14', voice: 'model', quality: 'fast', character: true, seed: 7, scenes });
    assert.equal(job.input.character, true);
    assert.match(job.summary.detail, /same character/);
    const last = await p.waitUntilDone(job.id, 120000);
    assert.equal(last.status, 'done', last.error);
    const promptList = p.fake.status.records.filter((x) => x.path === '/prompt').map((x) => Object.values(JSON.parse(x.prompt).prompt));
    assert.equal(promptList.length, 1 + 1 + 3, 'scene 1 image + 2 edits in one request + 3 videos');
    assert.ok(promptList[0].some((d) => d.class_type === 'UnetLoaderGGUF' || d.class_type === 'CheckpointLoaderSimple' || d.class_type === 'UNETLoader'), 'scene 1 from text');
    assert.ok(!promptList[0].some((d) => d.class_type === 'TextEncodeQwenImageEditPlus'));
    const edit = promptList[1];
    const prompts = edit.filter((d) => d.class_type === 'TextEncodeQwenImageEditPlus' && d.inputs.prompt).map((d) => d.inputs.prompt);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /^Create a new image of this scene: he drinks tea in a tavern/);
    assert.match(prompts[1], /storm[\s\S]*exactly the same as in image 1/);
    const latents = edit.filter((d) => d.class_type === 'EmptySD3LatentImage');
    // Ayni boyuttaki bos latent birlestirmede tek dugume iner.
    assert.deepEqual(latents.map((d) => [d.inputs.width, d.inputs.height]), [[1392, 752]], 'empty latent in the film aspect ratio');
    assert.ok(p.fake.status.uploaded.some((name) => /_karakter\.png$/.test(name)), 'scene 1 image was uploaded as reference');
    assert.equal(edit.filter((d) => d.class_type === 'LoadImage').every((d) => /_karakter\.png$/.test(d.inputs.image)), true);
  } finally {
    await p.close();
  }
});

test('film: vertical, no transitions (plain concatenation), ready image from the gallery', async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const previous = await p.waitUntilDone(p.queue.add('image', { prompt: 'portrait hero', model: 'flux', ratio: '9:16' }).id);
    assert.equal(previous.status, 'done');
    const ready = `job/${previous.id}/${previous.outputs[0].file}`;
    const job = p.queue.add('film', {
      title: '', ratio: '9:16', imageModel: 'qwen', videoModel: 'wan5', voice: 'model', quality: 'fast', subtitle: 'true', transition: false,
      scenes: [{ narration: 'Birinci sahne burada başlıyor.', source: ready }, { narration: 'İkinci sahne.', image: 'night sky' }],
    });
    const last = await p.waitUntilDone(job.id, 120000);
    assert.equal(last.status, 'done', last.error);
    const k = join(p.setting.outputRoot, job.id);
    const narrations = [1, 2].map((i) => wavDuration(join(k, `scene0${i}.wav`)));
    const targets = narrations.map((x) => scenePlan({ narration: x, frame: 121, fps: 24 }).target);
    const film = await streams(p.setting.ffprobe, join(k, 'film.mp4'));
    assert.ok(Math.abs(film.duration - (targets[0] + targets[1])) < 0.1, `film without transitions ${film.duration} ≈ ${targets[0] + targets[1]}`);
    const v = film.streams.find((x) => x.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [720, 1280]);
    // Hazir gorselli sahne icin gorsel uretilmedi: tek gorsel istegi (sahne 2) + 2 video.
    const requests = p.fake.status.records.filter((x) => x.path === '/prompt').length;
    assert.equal(requests, 1 + 1 + 2, 'previous image job + scene 2 image + 2 videos');
  } finally {
    await p.close();
  }
});

test('film: a scene image written in Turkish is drawn from its English (translated once, kept for a retry)', async (t) => {
  const llm = {
    installed: true,
    info: { name: 'fake' },
    releaseGpu: async () => {},
    req: async (path, body) => {
      const system = body.messages[0]?.content ?? '';
      if (/text-to-image/.test(system)) return { code: 200, json: { choices: [{ message: { content: 'a red fox in fresh snow, soft morning light' } }] } };
      return { code: 500, json: { error: { message: 'not in this test' } } };
    },
  };
  const p = await createPanel({ llm });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  setTextModel(llm);
  try {
    const job = p.queue.add('film', { title: '', ratio: '16:9', imageModel: 'qwen', videoModel: 'wan5', voice: 'model', quality: 'fast', transition: false,
      scenes: [{ narration: 'Bir tilki karda yürüyor.', image: 'karda kızıl bir tilki, sabah ışığı' }, { narration: 'Gece oldu.', image: 'night sky over a frozen lake' }] });
    const last = await p.waitUntilDone(job.id, 120000);
    assert.equal(last.status, 'done', last.error);
    const texts = (n) => p.fake.status.records.filter((x) => x.path === '/prompt').map((x) => Object.values(JSON.parse(x.prompt).prompt))
      .filter((g) => g.some((d) => d.class_type === 'SaveImage' && String(d.inputs.filename_prefix).includes(`/${job.id}/s${n}`)))
      .flatMap((g) => g.filter((d) => d.class_type === 'CLIPTextEncode').map((d) => d.inputs.text));
    assert.ok(texts('01').some((x) => x.startsWith('a red fox in fresh snow, soft morning light')), texts('01').join(' | '));
    assert.ok(texts('02').some((x) => x.startsWith('night sky over a frozen lake')), 'English stays as written');
    assert.deepEqual(p.queue.jobs.get(job.id).sceneImageEnglish, { 0: 'a red fox in fresh snow, soft morning light', 1: 'night sky over a frozen lake' });
    assert.match(p.queue.logs.get(job.id).join(String.fromCharCode(10)), /Scene 1 image prompt translated to English: a red fox in fresh snow/);
  } finally {
    setTextModel(null);
    await p.close();
  }
});

test("film 1080p: Wan produces 720p, each scene's frames are upscaled once to 1920×1080, the film is 1080p; clear error if the model is missing", async (t) => {
  const p = await createPanel();
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const body = {
      title: '', ratio: '16:9', imageModel: 'flux', videoModel: 'wan14', voice: 'model', quality: 'fast', transition: false, resolution: '1080p',
      scenes: [{ narration: 'Birinci sahne.', image: 'castle' }, { narration: 'İkinci sahne.', image: 'forest' }],
    };
    assert.throws(() => p.queue.add('film', body), /No 1080p upscale model/);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(p.setting.upscaleModel), { recursive: true });
    writeFileSync(p.setting.upscaleModel, 'fake');
    const job = p.queue.add('film', body);
    assert.deepEqual([job.input.resolution, job.input.generation1080], ['1080p', 'upscale']);
    assert.match(job.summary.detail, /16:9 · 1080p/);
    const last = await p.waitUntilDone(job.id, 120000);
    assert.equal(last.status, 'done', last.error);
    const graphs = p.fake.status.records.filter((k) => k.path === '/prompt').map((k) => JSON.parse(k.prompt).prompt);
    const wans = graphs.map((g) => Object.values(g).find((x) => x.class_type === 'WanImageToVideo')).filter(Boolean);
    assert.ok(wans.length >= 2 && wans.every((w) => w.inputs.width === 1280 && w.inputs.height === 720), 'Wan produces 720p');
    const k = join(p.setting.outputRoot, job.id);
    const film = await streams(p.setting.ffprobe, join(k, 'film.mp4'));
    const v = film.streams.find((x) => x.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [1920, 1080], 'film 1080p');
    const log = readFileSync(join(k, 'log.txt'), 'utf8');
    assert.equal((log.match(/frames upscaled to 1080p/g) ?? []).length, 2, 'each scene was upscaled once');
    assert.deepEqual([last.outputs.find((c) => c.main).width, last.outputs.find((c) => c.main).height], [1920, 1080]);
  } finally {
    await p.close();
  }
});

// 07.10.2026 kullanici: "dudaklari da yapabilsek iyi olur", "Wan 2.2 daha iyi, digeri baska yerlere bakiyor".
// Olculdu: karma kurulum (Wan 2.2 yuksek gurultu 2 adim + Wan 2.1 InfiniteTalk 2 adim) bakisi ve rengi korur.
// "Hayvan da olsa konusturabilmeliyiz": InfiniteTalk kedinin agzini kendi sesiyle oynatiyor (olculdu), kedi de konusur.
test("film lip sync: speakers are face-masked (animals too), in 25 fps windows; the narrator's lips do not move; scenes without dialogue are normal", async (t) => {
  const mouthRecord = join(mkdtempSync(join(tmpdir(), 'agiz-kayit-')), 'kayit.jsonl');
  // Ses tasarimi VoxCPM2 motoruyla: karakter sesi 3 tohumla uretilip olcumle secilir (fake-voice.mjs --candidate/--report)
  const p = await createPanel({ mouthEnv: { FAKE_MOUTH_RECORD: mouthRecord }, setting: { designEngine: () => 'voxcpm' } });
  if (!p.setting.ffmpeg || !p.setting.ffprobe) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  const { setTextModel } = await import('../lib/text-model.mjs');
  const { lipWindows } = await import('../lib/lip.mjs');
  const boxRequests = [];
  const directorRequests = [];
  // Sahte yazi modeli: gorselde konusanlarin kutusu (0-1000) ve insan mi; diger istekler (hareket istemi) hata
  setTextModel({
    installed: true,
    info: { mmproj: 'mmproj-sahte.gguf' },
    req: async (path, body) => {
      // Yonetmen notu (her sahne, seslendirmeden once): an, gorsel cumlesi, replik basina oyunculuk + ses + dinleyen
      if (/director of a short film/.test(body.messages[0].content)) {
        directorRequests.push(body.messages[1].content);
        const n = (body.messages[1].content.match(/^\d+\. /gm) ?? []).length;
        const response = {
          an: 'AN-NOTU',
          image: 'SAHNE-OYUNCULUK: the girl looks worried',
          characters: [{ who: 'the girl', emotion: 'deeply worried', thought: 'where is she', attitude: 'protective' }],
          lines: Array.from({ length: n }, (_, i) => ({ acting: `NOT-${i + 1}`, voice: `SES-${i + 1}`, listener: `DINLEYEN-${i + 1}` })),
        };
        return { code: 200, json: { choices: [{ message: { content: JSON.stringify(response) } }] } };
      }
      if (!/detect the listed characters/.test(body.messages[0].content)) return { code: 500, json: { error: { message: 'fake' } } };
      const content = body.messages[1].content;
      boxRequests.push(content);
      const text = content.find((x) => x.type === 'text').text;
      const response = /Baba/.test(text)
        ? { Elif: { box_2d: [350, 100, 800, 450], label: 'human' }, Baba: { box_2d: [100, 450, 900, 950], human: true } }
        : { Elif: { box_2d: [50, 400, 500, 950], human: true }, Pamuk: { box_2d: [350, 150, 800, 650], human: false } };
      return { code: 200, json: { choices: [{ message: { content: JSON.stringify(response) } }] } };
    },
  });
  try {
    const scenes = [
      { narration: 'Gece ormanda yürüyorlardı.', dialogue: 'Elif: Pamuk! Neredesin?\nBaba: Buradayım kızım, korkma.', image: 'forest at night' },
      { dialogue: 'Elif: Seni çok özledim!\nPamuk: Miyav! Ben de seni çok ama çok özledim, hep seni bekledim.', image: 'girl hugging a kitten' },
      { narration: 'Sonra hep birlikte eve döndüler.', image: 'a house' },
    ];
    const characters = [{ name: 'Elif', gender: 'female', age: 'child' }, { name: 'Baba', gender: 'male', age: 'adult' }, { name: 'Pamuk', gender: 'female', age: 'child', spec: 'a tiny kitten' }];
    const job = p.queue.add('film', { title: 'Dudak', ratio: '9:16', imageModel: 'flux', videoModel: 'wan14', voice: 'model', quality: 'fast', subtitle: false, transition: true, seed: 3, scenes, characters, lip: true });
    const last = await p.waitUntilDone(job.id, 240000);
    assert.equal(last.status, 'done', last.error);
    assert.match(last.summary.detail, /lip sync/);
    const k = join(p.setting.outputRoot, job.id);
    const log = readFileSync(join(k, 'log.txt'), 'utf8');
    assert.match(log, /Scene 1 speakers: Elif visible; Baba visible/);
    assert.match(log, /Scene 2 speakers: Elif visible; Pamuk visible \(not human\)/);
    // Kedi insan cocugu sesiyle konusmaz: tur tariften ("a tiny kitten") hayvan, ses hayvan tarifiyle tasarlanir,
    // kutuphanede tur: hayvan (07.10.2026 kullanici: "Kedi mi konusuyor Elif mi, karismis")
    assert.match(log, /Voice design \(VoxCPM2, Turkish, 3 candidates measured and selected\): "A tiny cartoon animal character[^"]*not a human child[^"]*a tiny kitten/);
    assert.match(log, /Character voice: Pamuk \(Female, Child, animal\) → Pamuk \(character\) \(designed from description\)/);
    const { voiceInfo, voicePath } = await import('../lib/voices.mjs');
    assert.equal(voiceInfo(p.setting.voiceLibrary, last.characterVoices.Pamuk).type, 'animal');
    // Aday secimi (08.10.2026): 3 tohum olculur, en uyan (hayvan: en ince perde, otekilere en az benzeyen) secilir; olcum
    // kutuphane kaydina yazilir; Pamuk'un tasarimi Elif ve Baba'nin seslerinden ayrismali (--separate)
    assert.match(log, /Voice design candidates: seed 101 pitch 380 Hz[^\n]*seed 303 pitch 500 Hz[^\n]*→ selected seed 303/);
    assert.deepEqual(voiceInfo(p.setting.voiceLibrary, last.characterVoices.Pamuk).measurement, { seed: 303, f0: 500, age: 9, child: 0.98, female: 0.01, male: 0.01, similarity: 0.86, score: 5.14 });
    const pamukReport = JSON.parse(readFileSync(join(k, 'character-voices', 'pamuk', 'report.json'), 'utf8'));
    assert.deepEqual(pamukReport.separate.sort(), [voicePath(p.setting.voiceLibrary, last.characterVoices.Elif), voicePath(p.setting.voiceLibrary, last.characterVoices.Baba)].sort());
    assert.deepEqual([pamukReport.target, pamukReport.gender, pamukReport.type], ['child', 'female', 'animal']);
    // Elif ilk tasarlandi: ayrisacak ses yoktu (anlatici panel sesi)
    assert.deepEqual(JSON.parse(readFileSync(join(k, 'character-voices', 'elif', 'report.json'), 'utf8')).separate, []);
    // Yazi modeline sahne gorseli (JPEG) ve karakterler (cinsiyet, yas, sahne metni) gitti; konusmasiz sahne sorulmadi
    assert.equal(boxRequests.length, 2);
    assert.match(boxRequests[0][0].image_url.url, /^data:image\/jpeg;base64,/);
    assert.match(boxRequests[0][1].text, /- Elif: female child\n- Baba: male adult\n\nScene description: forest at night/);
    assert.match(boxRequests[1][1].text, /- Pamuk: female child; voice: a tiny kitten/);
    // ComfyUI istekleri: konusmali iki sahne pencere pencere InfiniteTalk, ucuncu sahne normal Wan
    const graphs = p.fake.status.records.filter((x) => x.prompt).map((x) => JSON.parse(x.prompt).prompt);
    const node = (g, s) => Object.values(g).filter((d) => d.class_type === s);
    const lipGraphs = graphs.filter((g) => node(g, 'WanInfiniteTalkToVideo').length);
    const windowCount = (i) => lipWindows(Math.max(2.5, DEFAULT.frontSpace + wavDuration(join(k, `scene0${i}.wav`)) + DEFAULT.lastSpace)).windows.length;
    assert.equal(lipGraphs.length, windowCount(1) + windowCount(2));
    for (const g of lipGraphs) {
      const it = node(g, 'WanInfiniteTalkToVideo')[0].inputs;
      assert.equal(it.mode, 'two_speakers');
      assert.equal(it.length, 81);
      assert.equal(it.audio_scale, 2);
      // Renk kaymasi: her kare kaynak gorselin renklerine eslenir
      assert.equal(node(g, 'ColorTransfer')[0].inputs.source_stats, 'per_frame');
    }
    // Pencere istemi kim konusuyor der (Wan 2.2 asamasi sesi bilmez): 2. sahnenin ilk penceresinde once kiz sonra kedi,
    // son penceresinde yalniz kedi (kiz agzi kapali dinler); devam penceresinde kamera sabit
    const prompt = (g) => node(g, 'CLIPTextEncode')[0].inputs.text;
    // Yonetmen notu (yazi modeli, replik sirasiyla): oyunculuk pencere istemine, dinleyenin tepkisi dinleyene, gorsel
    // cumlesi gorsel istemine (konusmasiz sahnede de). Butun sahnelere, seslendirmeden once yazildi.
    assert.equal(directorRequests.length, 3, "one director's note per scene");
    assert.match(directorRequests[1], /Characters: the girl, the kitten\nDialogue in order:\n1\. the girl: "Seni çok özledim!"\n2\. the kitten: "Miyav!/);
    assert.match(directorRequests[2], /No dialogue in this scene\./);
    assert.match(prompt(lipGraphs[windowCount(1)]), /^The girl talks first \(NOT-1\), then the kitten answers \(NOT-2\); whoever is not talking keeps the mouth closed\./);
    assert.ok(graphs.some((g) => node(g, 'CLIPTextEncode').some((d) => /girl hugging a kitten\. SAHNE-OYUNCULUK: the girl looks worried/.test(d.inputs.text))), 'acting sentence in the image prompt');
    assert.ok(graphs.some((g) => node(g, 'CLIPTextEncode').some((d) => /^a house\. SAHNE-OYUNCULUK/.test(d.inputs.text))), "director's note also in the image of a scene without dialogue");
    assert.match(log, /Scene 2 director's note: AN-NOTU \| image: SAHNE-OYUNCULUK: the girl looks worried \| 1\. NOT-1 \(voice: SES-1; listener: DINLEYEN-1\) \| 2\. NOT-2 \(voice: SES-2; listener: DINLEYEN-2\)/);
    assert.ok(log.indexOf("Scene 3 director's note") < log.indexOf('Character voice:'), "director's note before voice-over");
    // Replik satirlari yonetmenin ses yonergesiyle seslendirilir (anlatim satiri yonergesiz)
    const voiceJobs = readdirSync(k).filter((d) => /^narration/.test(d)).map((d) => JSON.parse(readFileSync(join(k, d, 'job.json'), 'utf8')));
    const voiceLines = voiceJobs.flatMap((j) => j.lines);
    const directive = (id) => voiceLines.find((s) => s.id === id)?.directive ?? null;
    assert.deepEqual(['scene01_s1', 'scene01_s2', 'scene01_s3', 'scene02_s1', 'scene02_s2'].map(directive), [null, 'SES-1', 'SES-2', 'SES-1', 'SES-2']);
    // Yonergeli satirlar "banka" kipinde (once ayni sesle duygu ornegi, replik onun tonlamasiyla; ses\voxcpm\uret.py)
    assert.ok(voiceJobs.some((j) => j.lines.some((s) => s.directive)) && voiceJobs.filter((j) => j.lines.some((s) => s.directive)).every((j) => j.emotionMode === 'bank'));
    // Karakter sesi yansiz metinle tasarlandi (kutuphanede yansiz: true)
    const { voiceInfo: info } = await import('../lib/voices.mjs');
    assert.equal(info(p.setting.voiceLibrary, last.characterVoices.Elif).neutral, true);
    assert.doesNotMatch(prompt(lipGraphs[windowCount(1)]), /camera holds still/, 'camera is free in the first window');
    assert.match(prompt(lipGraphs.at(-1)), /^Only the kitten is talking \(NOT-2\), mouth moving with the words; the girl listens with a closed mouth \(DINLEYEN-2\)\./);
    assert.match(prompt(lipGraphs.at(-1)), /The camera holds still: no zoom, no camera movement\.$/);
    assert.match(prompt(lipGraphs[0]), /^Nobody is talking/, 'only the narrator in the first window of scene 1');
    // Iki sahnede de iki maske (kedi de konusur; genisletme hesabi birim testinde)
    const maskCount = (g) => node(g, 'MaskComposite').length;
    assert.equal(maskCount(lipGraphs[0]), 2);
    assert.equal(maskCount(lipGraphs[windowCount(1)]), 2);
    // Devam penceresi son 9 kareden: 9 kare yuklendi, cikti 72 kare
    assert.deepEqual([windowCount(1), windowCount(2)], [3, 3], 'with the fake audio duration (text / 13 s)');
    const proceed = lipGraphs[1];
    assert.equal(node(proceed, 'ImageFromBatch')[0].inputs.length, 72);
    assert.equal(node(proceed, 'WanInfiniteTalkToVideo')[0].inputs.motion_frame_count, 9);
    assert.equal(node(proceed, 'ImageBatch').length, 8, '9 motion frames as a single batch input');
    assert.ok(graphs.some((g) => node(g, 'WanImageToVideo').length && !node(g, 'WanInfiniteTalkToVideo').length && !node(g, 'SaveLatent').length), 'scene without dialogue uses normal Wan');
    // Her pencere iki istek: A) yalniz Wan 2.2 yuksek gurultu -> SaveLatent; B) LoadLatent -> InfiniteTalk (16 GB RAM'de iki
    // 14B model + ses yamasi ayni istekte tutulmasin). B, A'nin latentini yuklenen dosyadan okur.
    const searchGraphs = graphs.filter((g) => node(g, 'SaveLatent').length);
    assert.equal(searchGraphs.length, lipGraphs.length);
    for (const g of searchGraphs) {
      assert.deepEqual(node(g, 'UnetLoaderGGUF').map((d) => d.inputs.unet_name), ['wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf']);
      assert.equal(node(g, 'ModelPatchLoader').length + node(g, 'WanInfiniteTalkToVideo').length + node(g, 'SaveImage').length, 0);
      const example = node(g, 'KSamplerAdvanced')[0].inputs;
      assert.deepEqual([example.add_noise, example.end_at_step, example.return_with_leftover_noise], ['enable', 2, 'enable']);
    }
    for (const g of lipGraphs) {
      assert.ok(!node(g, 'UnetLoaderGGUF').some((d) => /wan2\.2/.test(d.inputs.unet_name)), 'no Wan 2.2 in the InfiniteTalk request');
      const upload = Object.keys(g).filter((id) => g[id].class_type === 'LoadLatent');
      assert.equal(upload.length, 1);
      assert.match(g[upload[0]].inputs.latent, /\.latent$/);
      assert.ok(p.fake.status.uploaded.includes(g[upload[0]].inputs.latent), 'intermediate latent was uploaded to ComfyUI input');
      const example = node(g, 'KSamplerAdvanced')[0].inputs;
      assert.deepEqual([example.add_noise, example.start_at_step, example.latent_image], ['disable', 2, [upload[0], 0]]);
    }
    // Sahne klibi sesle ayni surede (25 fps kareler, yavaslatma yok)
    for (const i of [1, 2]) {
      const target = Math.max(2.5, DEFAULT.frontSpace + wavDuration(join(k, `scene0${i}.wav`)) + DEFAULT.lastSpace);
      const v = await streams(p.setting.ffprobe, join(k, `scene0${i}.mp4`));
      assert.ok(Math.abs(v.duration - target) < 0.08, `scene${i} ${v.duration} ≈ ${target}`);
    }
    // Agiz duzeltme (LatentSync): yalniz konusan INSANLAR (kedi karma sonucuyla kalir), her biri kendi iziyle; iz sahne
    // suresine kirpilir (uzun iz LatentSync'te videoyu uzatirdi). 1. sahne Elif + Baba, 2. sahne yalniz Elif.
    const mouths = readFileSync(mouthRecord, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.equal(mouths.length, 2);
    assert.match(log, /Scene 1 mouth correction \(LatentSync\): Elif, Baba; \d+ s/);
    assert.match(log, /Scene 2 mouth correction \(LatentSync\): Elif; \d+ s/);
    for (const [j, i] of [1, 2].entries()) {
      const target = Math.max(2.5, DEFAULT.frontSpace + wavDuration(join(k, `scene0${i}.wav`)) + DEFAULT.lastSpace);
      const frame = Math.ceil(target * 25 - 1e-6);
      assert.equal(mouths[j].speakers.length, i === 1 ? 2 : 1);
      for (const s of mouths[j].speakers) {
        assert.ok(Math.abs(s.duration - frame / 25) < 0.01, `trace ${s.duration} ≈ ${frame / 25}`);
        assert.equal(s.box.length, 4);
        assert.ok(s.box[2] > s.box[0] && s.box[3] > s.box[1], 'box x0,y0,x1,y1');
      }
    }
    // Pencere gunlugu: 2. sahnenin ilk penceresinde once Elif, bosluk ortasindan sonra Pamuk konusur
    assert.match(log, /3\/5 Video: scene 2\/3: lip window 1\/\d+ \(from 0\.00 s; voice 1 Elif, voice 2 Pamuk from frame \d+\)/);
    assert.ok(p.fake.status.uploaded.some((name) => /_s01d1_1\.wav$/.test(name)), 'window audio was uploaded');
  } finally {
    setTextModel(null);
    await p.close();
  }
});
