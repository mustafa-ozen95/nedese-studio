/**
 * Test ortami: gecici ai koku + sahte ComfyUI + sahte seslendirme + gercek panel parcalari.
 * Gercek araclar\comfy.mjs'in is akisi ureticileri kullanilir (graf bicimi gercek).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { bindFineSettings } from '../lib/fine-settings.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_ROOT, loadSettings, loadComfyModule } from '../lib/settings.mjs';
import { SettingsFile } from '../lib/settings-file.mjs';
import { DATA_FILES } from '../lib/data-files.mjs';
import { ComfyClient } from '../lib/comfy-client.mjs';
import { Downloader } from '../lib/download.mjs';
import { Queue } from '../lib/queue.mjs';
import { wrapModule } from '../lib/quantization.mjs';
import { createPanelServer } from '../lib/http.mjs';
import * as image from '../lib/jobs/image.mjs';
import * as video from '../lib/jobs/video.mjs';
import * as voice from '../lib/jobs/voice.mjs';
import * as speech from '../lib/jobs/speech.mjs';
import * as clone from '../lib/jobs/clone.mjs';
import * as film from '../lib/jobs/film.mjs';
import * as music from '../lib/jobs/music.mjs';
import * as song from '../lib/jobs/song.mjs';
import * as sing from '../lib/jobs/sing.mjs';
import * as model3d from '../lib/jobs/model3d.mjs';
import * as training from '../lib/jobs/training.mjs';
import * as data from '../lib/jobs/data.mjs';
import * as describe from '../lib/jobs/describe.mjs';
import * as pageVideo from '../lib/jobs/page-video.mjs';
import { Database } from '../lib/database.mjs';
import { startFakeComfy } from './fake-comfy.mjs';

export const FAKE_VOICE = fileURLToPath(new URL('./fake-voice.mjs', import.meta.url));
export const FAKE_UPSCALE = fileURLToPath(new URL('./fake-upscale.mjs', import.meta.url));
export const FAKE_BLENDER = fileURLToPath(new URL('./fake-blender.mjs', import.meta.url));
export const FAKE_TRAINING = fileURLToPath(new URL('./fake-training.mjs', import.meta.url));
export const FAKE_IMAGE_TRAINING = fileURLToPath(new URL('./fake-image-training.mjs', import.meta.url));
export const FAKE_MUSIC_TRAINING = fileURLToPath(new URL('./fake-music-training.mjs', import.meta.url));
export const FAKE_MOUTH = fileURLToPath(new URL('./fake-mouth.mjs', import.meta.url));
export const FAKE_SING = fileURLToPath(new URL('./fake-sing.mjs', import.meta.url));
export const FAKE_CLONE = fileURLToPath(new URL('./fake-clone.mjs', import.meta.url));
export const REAL_COMFY = resolve(PANEL_ROOT, '..', 'tools', 'comfy.mjs');

export async function createPanel({ mode = 'normal', voiceEnv = {}, comfyClosed = false, stepDuration = 5, server: openServer = false, imageData = null, port = 0, blender = false, llm = null, trainingEnv = null, imageTrainingEnv = null, musicTrainingEnv = null, generalTrainingEnv = null, mouthEnv = null, singEnv = null, cloneEnv = null, setting: extraSetting = {}, setupUpdater = null, restart = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-panel-test-'));
  const fake = await startFakeComfy({ mode, stepDuration, imageData });
  let comfyAddress = fake.address;
  if (comfyClosed) {
    await fake.close();
    comfyAddress = fake.address; // artik kimse dinlemiyor: ECONNREFUSED
  }
  const starts = [];
  // Sahte seslendirme hangi motorla cagrildigini rapora yazar (EMA Lightning sesi: 'ema')
  const voiceCommand = (args, engine = null) => ({ command: process.execPath, args: [FAKE_VOICE, ...args], env: { ...process.env, ...voiceEnv, FAKE_VOICE_ENGINE: engine ?? '' } });
  const setting = loadSettings({
    aiRoot: root,
    port: 0,
    comfyAddress,
    comfyModule: REAL_COMFY,
    voiceCommand,
    designCommand: voiceCommand,
    voiceScriptCommand: (script, args) => ({ command: process.execPath, args: [FAKE_VOICE, '--script', script, ...args], env: { ...process.env, ...voiceEnv } }),
    deletionMethod: 'permanent',
    // Blender: varsayilan yok (makinedeki gercek Blender'a baglanmasin); blender: true sahte betik.
    blender: blender ? (args) => ({ command: process.execPath, args: [FAKE_BLENDER, ...args] }) : null,
    // Model egitimi: egitimOrtami verilirse sahte egit.py (env: SAHTE_EGITIM_HATA, SAHTE_EGITIM_GUNLUK); yoksa kurulu degil.
    ...(trainingEnv ? { trainingCommand: (args) => ({ command: process.execPath, args: [FAKE_TRAINING, ...args], env: { ...process.env, ...trainingEnv } }) } : {}),
    // Gorsel LoRA egitimi: gorselEgitimOrtami verilirse sahte gorsel.py (env: SAHTE_GORSEL_GUNLUK, SAHTE_GORSEL_HATA).
    // Muzik LoRA egitimi: muzikEgitimOrtami verilirse sahte muzik.py (env: SAHTE_MUZIK_GUNLUK).
    ...(musicTrainingEnv ? { musicTrainingCommand: (args) => ({ command: process.execPath, args: [FAKE_MUSIC_TRAINING, ...args], env: { ...process.env, ...musicTrainingEnv } }) } : {}),
    ...(imageTrainingEnv ? { imageTrainingCommand: (args) => ({ command: process.execPath, args: [FAKE_IMAGE_TRAINING, ...args], env: { ...process.env, ...imageTrainingEnv } }) } : { imageTrainingCommand: null, hasImageTraining: false }),
    // Genel model egitimi: genelEgitimOrtami verilirse sahte genel.py (sahte-egitim.mjs, SAHTE_GENEL); yoksa kurulu degil.
    ...(generalTrainingEnv ? { generalTrainingCommand: (args) => ({ command: process.execPath, args: [FAKE_TRAINING, ...args], env: { ...process.env, ...generalTrainingEnv, FAKE_GENERAL: '1' } }) } : { generalTrainingCommand: null, hasGeneralTraining: false }),
    // Agiz duzeltme (LatentSync): agizOrtami verilirse sahte agiz.py (SAHTE_AGIZ_KAYIT, SAHTE_AGIZ_HATA); yoksa kurulu degil.
    ...(mouthEnv ? { mouthCommand: (args) => ({ command: process.execPath, args: [FAKE_MOUTH, ...args], env: { ...process.env, ...mouthEnv } }) } : {}),
    // Own voice (voice\clone): with cloneEnv the fake prepare.py / train.py (FAKE_CLONE_SPEECH, FAKE_CLONE_LOG); otherwise not installed.
    // Singing in a voice (voice\sing.py): with singEnv the fake sing.py (FAKE_SING_LOG, FAKE_SING_ERROR); otherwise not installed.
    ...(singEnv ? { singCommand: (args) => ({ command: process.execPath, args: [FAKE_SING, ...args], env: { ...process.env, ...singEnv } }) } : {}),
    ...(cloneEnv ? { cloneCommand: (stage, args) => ({ command: process.execPath, args: [FAKE_CLONE, stage, ...args], env: { ...process.env, ...cloneEnv } }) } : {}),
    // Video 1080p buyutme: sahte buyut.py (SAHTE_BUYUT_HATA ile hata); model dosyasi gecici kokte
    upscaleCommand: (args) => ({ command: process.execPath, args: [FAKE_UPSCALE, ...args], env: { ...process.env } }),
    upscaleModel: join(root, 'fake-upscale', 'sahte-2x.safetensors'),
    startComfy: () => starts.push(Date.now()),
    comfyReadyWait: 2500,
    // Veri toplama: sahte siteler 127.0.0.1'de (ozel ag reddi kapali), site basina bekleme kisa, gercek tarayici acilmasin
    dataPrivateNetworkAllowed: true,
    dataMinDelayMs: 30,
    // media downloads keep a 10 GB margin on the disk; the tests must not depend on how full this disk is
    mediaDiskMarginGb: 0,
    browserPath: null,
    x264Ready: 'ultrafast',
    encoder: 'x264', // testler ekran kartı kodlayıcısına bağlı kalmasın
    ...extraSetting, // teste ozel ek ayarlar (or. veriAramaSablonu)
    gpuStatus: async () => ({ name: 'fake', memoryUsedMb: fake.status.flushes ? 900 : 9000, memoryTotalMb: 12227, usagePercent: 3, temperature: 40 }),
    closeComfy: async () => {
      closings.push(Date.now());
      return [4242];
    },
  });
  const closings = [];
  const settingFile = new SettingsFile(join(setting.dataRoot, 'ayar.json'));
  // Sunucudaki gibi: ince ayarlar bu panelin ayar dosyasindan
  bindFineSettings(() => settingFile.fineSettings);
  // Settings › Web search for the data collection job, as on the server
  setting.webSearchServices = () => settingFile.webSearch;
  const mod = wrapModule(await loadComfyModule(setting.comfyModule), () => settingFile.modelChoices);
  const comfy = new ComfyClient({ address: comfyAddress, comfyFolder: null });
  // Testler de gerçek kurulum gibi veritabanıyla çalışır (liste, sayfa, ortalamalar sorgudan).
  const db = new Database(join(setting.dataRoot, 'panel.db'));
  const queue = new Queue({ setting, comfy, mod, db, runners: { image, video, voice, speech, clone, film, music, song, sing, model3d, training, data, describe, pageVideo } });
  queue.load();
  queue.start();
  const downloader = new Downloader({ modelRoot: setting.modelRoot, protectedRoots: [setting.aiRoot], recordPath: join(setting.dataRoot, DATA_FILES.downloads), changed: () => queue.changed() });

  // Ayni anda iki is calisti mi? (GPU tek sira kurali)
  const observation = { twoRunning: false, details: [] };
  const changed = queue.changed.bind(queue);
  queue.changed = () => {
    const running = [...queue.jobs.values()].filter((job) => job.status === 'running').length;
    if (running > 1) observation.twoRunning = true;
    const a = queue.active?.job?.progress?.detail;
    if (a && observation.details.at(-1) !== a) observation.details.push(a);
    changed();
  };

  if (llm) queue.llm = llm;
  let http = null;
  let address = null;
  if (openServer) {
    http = createPanelServer({ setting, queue, comfy, mod, settingFile, downloader, llm, updater: setupUpdater ? setupUpdater({ setting, settingFile, queue }) : null, restart });
    await new Promise((ok) => http.listen(port, '127.0.0.1', ok));
    address = `http://127.0.0.1:${http.address().port}`;
  }

  return {
    root,
    setting,
    fake,
    comfy,
    queue,
    mod,
    settingFile,
    downloader,
    observation,
    starts,
    closings,
    http,
    address,
    async waitUntilDone(id, timeTimeout = 60000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeTimeout) {
        const job = queue.jobs.get(id);
        if (job && !['waiting', 'running'].includes(job.status)) return job;
        await new Promise((ok) => setTimeout(ok, 50));
      }
      throw new Error(`Job did not finish: ${id} ${queue.jobs.get(id)?.status}`);
    },
    async waitForState(condition, timeTimeout = 20000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeTimeout) {
        if (condition()) return;
        await new Promise((ok) => setTimeout(ok, 20));
      }
      throw new Error('Expected state did not occur');
    },
    async close() {
      await queue.stop();
      for (const i of downloader.list) if (i.status === 'downloading') downloader.cancel(i.id);
      comfy.close();
      db.close();
      if (http) await new Promise((ok) => http.close(ok));
      if (!comfyClosed) await fake.close();
      await new Promise((ok) => setTimeout(ok, 100));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
