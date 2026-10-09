/**
 * Nedese Studio: gorsel, video, ses ve tek parca film uretimi (yerel, yalnizca 127.0.0.1).
 *
 *   ..\panel.bat                      (masaustundeki "Nedese Studio" kisayolu bunu calistirir)
 *   node panel\sunucu.mjs [--port 1071] [--no-browser]
 *
 * Ayni makinede iki kurulum ayni kodu calistirir: yollar bu dosyanin konumundan
 * (panel klasorunun bir ustu = ai koku), model adlari araclar\comfy.mjs'ten gelir.
 * Panel zaten aciksa ikinci kez baslatmaz, tarayicida acar.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadSettings, loadComfyModule, migrateOldFolders, allowedHosts } from './lib/settings.mjs';
import { SettingsFile } from './lib/settings-file.mjs';
import { DATA_FILES } from './lib/data-files.mjs';
import { migrateLegacyData } from './lib/migrate.mjs';
import { ComfyClient } from './lib/comfy-client.mjs';
import { Downloader } from './lib/download.mjs';
import { Queue } from './lib/queue.mjs';
import { LocalLlm, findLlm } from './lib/llm.mjs';
import { setPromptTranslation, setTextModel } from './lib/prompt-translate.mjs';
import { Updater } from './lib/update.mjs';
import { fineSetting, bindFineSettings } from './lib/fine-settings.mjs';
import { measureGpu } from './lib/gpu.mjs';
import { Database } from './lib/database.mjs';
import { createComfyProxy } from './lib/comfy-proxy.mjs';
import { wrapModule } from './lib/quantization.mjs';
import { createPanelServer } from './lib/http.mjs';
import { ensureCliOnPath } from './lib/cli-path.mjs';
import { killTree, runningProcesses } from './lib/process.mjs';
import * as image from './lib/jobs/image.mjs';
import * as video from './lib/jobs/video.mjs';
import * as voice from './lib/jobs/voice.mjs';
import * as film from './lib/jobs/film.mjs';
import * as music from './lib/jobs/music.mjs';
import * as clone from './lib/jobs/clone.mjs';
import * as edit from './lib/jobs/edit.mjs';
import * as song from './lib/jobs/song.mjs';
import * as audioEdit from './lib/jobs/audio-edit.mjs';
import * as videoEdit from './lib/jobs/video-edit.mjs';
import * as model3d from './lib/jobs/model3d.mjs';
import * as training from './lib/jobs/training.mjs';
import * as data from './lib/jobs/data.mjs';
import * as describe from './lib/jobs/describe.mjs';
import * as pageVideo from './lib/jobs/page-video.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const setting = loadSettings({ port: value('--port'), comfyAddress: value('--comfy'), openBrowser: !args.includes('--no-browser') });
const address = `http://127.0.0.1:${setting.port}/`;

function openInBrowser() {
  if (!setting.openBrowser) return;
  spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `start "" "${address}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
}

async function isAlreadyOpen() {
  try {
    const r = await fetch(`${address}api/id`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json()).application === 'ai-panel';
  } catch {
    return false;
  }
}

if (await isAlreadyOpen()) {
  console.log(`Nedese Studio zaten açık: ${address}${setting.openBrowser ? ' (opening in the browser)' : ''}`);
  openInBrowser();
  process.exit(0);
}

// comfy.mjs'in grafları ayarlardaki niceleme secimiyle sarilir (Q4_K_M / Q8_0; comfy.mjs degismez).
// Eski Turkce klasor adlari (ciktilar, panel-veri) yenilerine bir kez tasinir.
migrateOldFolders(setting, (m) => console.log(m));
// Data written by the Turkish-named versions (ayar.json keys, panel.db columns, is.json): renamed once (lib/migrate.mjs).
const runners = { image, video, voice, film, music, clone, edit, song, audioEdit, videoEdit, model3d, training, data, describe, pageVideo };
migrateLegacyData({ dataRoot: setting.dataRoot, outputRoot: setting.outputRoot, aiRoot: setting.aiRoot, modelRoot: setting.modelRoot, summaries: Object.fromEntries(Object.entries(runners).map(([k, m]) => [k, m.summary])), log: (m) => console.log(`[migration] ${m}`) });
const settingFile = new SettingsFile(join(setting.dataRoot, DATA_FILES.settings));
// Ayarlar > "İstemleri İngilizceye çevir" (kapaliysa istemler modele yazildigi gibi gider)
setPromptTranslation(() => settingFile.translatePrompt);
// Ayarlar > Ince ayarlar (donanima gore): kullanan kod her seferinde ayar dosyasindan okur
bindFineSettings(() => settingFile.fineSettings);
setting.selectVoiceEngine = () => settingFile.voiceEngine;
// Settings › Web search: the data collection job uses the same search services as search_web
setting.webSearchServices = () => settingFile.webSearch;
const mod = wrapModule(await loadComfyModule(setting.comfyModule), () => settingFile.modelChoices);
const comfy = new ComfyClient({ address: setting.comfyAddress, comfyFolder: mod.COMFY ?? null });
// Yerel veritabani (panel-data\panel.db): isler, yuklemeler, sure olcumleri.
const db = new Database(join(setting.dataRoot, DATA_FILES.database));
const queue = new Queue({ setting, comfy, mod, db, runners });
queue.idleCloseMin = () => settingFile.comfyIdleCloseMin;
queue.load();
// Yerel yazi modeli (Gemma 4): ekran kartini ComfyUI ile paylasir; botlar /llm/v1 ile kullanir.
const llm = new LocalLlm({
  info: setting.llm ? findLlm(setting.aiRoot, settingFile.textModel) : null,
  // Ekran karti baska iste (ComfyUI, egitim) ise bot istegi bekler; yazi modelini kullanan is (veri toplama) paylasir
  gpuBusy: () => queue.externalRequestShouldWait(),
  gpuJob: () => (queue.active ? { typeName: queue.summary(queue.active.job).typeName, percent: queue.active.job.progress?.percent ?? 0 } : null),
  // Ince ayar gpuPaylas kapali (buyuk kart): yazi modeli acilirken ComfyUI bellegi bosaltilmaz
  flushGpu: async () => {
    if (!fineSetting('gpuShare') || !(await comfy.isReady())) return;
    const q = await comfy.queue().catch(() => null);
    if (q && !q.running.length && !q.pending.length) await comfy.flush().catch(() => false);
  },
  // Ince ayar llmVram 'oto': VRAM butcesi kartin toplam belleginden
  gpuTotalMb: async () => (await (setting.gpuStatus ?? measureGpu)())?.memoryTotalMb ?? null,
  // Settings > Text model memory: minutes idle before it is unloaded, 0 = keep loaded
  keepFor: () => settingFile.textModelIdleMin * 60,
  log: (m) => console.log(m),
  // llama-server's own output (prompt cache reuse, timings), written again at each start
  logFile: join(setting.logRoot, 'llama-server.log'),
});
queue.llm = llm;
// "Keep loaded": the model comes back once the GPU has been free for a minute (image/video jobs still unload it)
let gpuLastBusy = Date.now();
const keepTimer = setInterval(() => {
  if (queue.active || queue.pending().length || queue.externalRequestShouldWait()) gpuLastBusy = Date.now();
  else if (llm.keepLoaded && Date.now() - gpuLastBusy > 60000) llm.preload().catch((e) => console.log(`Text model could not be kept loaded: ${e.message}`));
}, 15000);
keepTimer.unref?.();
setTextModel(llm);
// Kuyruk yazi modeli baglandiktan sonra baslar: acilista kendiliginden suren veri toplama modelsiz (yalniz kural) kaliyordu
queue.start();
const downloader = new Downloader({ modelRoot: setting.modelRoot, protectedRoots: [setting.aiRoot], recordPath: join(setting.dataRoot, DATA_FILES.downloads), changed: () => queue.changed(), log: (m) => console.log(m) });

// Guncelleme (GitHub): gunde bir denetim; uygulaninca panel yeniden baslar (kapat -> tepsi ya da yardimci acar)
const updater = new Updater({ setting, settingFile, queue, log: (m) => console.log(m), startAgain: () => startAgain() });
const server = createPanelServer({ setting, queue, comfy, mod, settingFile, downloader, llm, updater, restart: () => startAgain('restart') });
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${setting.port} is in use by another program. Another port: panel.bat --port 1166`);
  else console.error(e);
  process.exit(1);
});
// When the panel is open to the network, ComfyUI is relayed to the home network too (the firewall blocks python).
const comfyProxy = setting.address !== '127.0.0.1' ? createComfyProxy({ target: setting.comfyAddress, port: setting.comfyNetworkPort, log: (m) => console.log(m) }) : null;
server.listen(setting.port, setting.address, () => {
  const pending = queue.pending().length;
  console.log('Nedese Studio');
  console.log(`  Address   : ${address}`);
  if (setting.address !== '127.0.0.1') {
    const network = allowedHosts(setting.address).filter((a) => a !== '127.0.0.1' && a !== 'localhost');
    console.log(`  Network   : ${network.map((a) => `http://${a}:${setting.port}/`).join('  ')}`);
  }
  console.log(`  ai folder : ${setting.aiRoot}`);
  console.log(`  Outputs   : ${setting.outputRoot}`);
  console.log(`  ComfyUI   : ${setting.comfyAddress}  (models: ${setting.comfyModule})`);
  console.log(`  ffmpeg    : ${setting.ffmpeg ?? 'NOT FOUND'}`);
  console.log(`  Blender   : ${setting.blender ?? 'none (3D model GLB only)'}`);
  console.log(`  Voice     : ${setting.hasVoice ? 'available' : 'none'}, voice design: ${setting.hasDesign ? 'available' : 'none'}`);
  console.log(`  API       : ${address}api/documents  (key: Settings page; file ${settingFile.path})`);
  if (pending) console.log(`  ${pending} jobs waiting in the queue; they will run in order.`);
  console.log('Closing this window closes the panel (the running job becomes "interrupted" and resumes with Retry).');
  openInBrowser();
  updater.start();
  ensureCliOnPath(setting.aiRoot, { log: (m) => console.log(m) }).catch(() => {});
});

let closing = false;
async function close(signal) {
  if (closing) return;
  closing = true;
  console.log(`\nShutting down (${signal})…`);
  // Sohbet/ajan: calisan oturumlar durur, arka plan komutlari ve MCP sunuculari kapanir
  server.agent?.close();
  await queue.stop();
  await llm.close();
  for (const c of runningProcesses) killTree(c.pid);
  // Calisan isin durumu diske yazilsin (durdur -> iptal -> "yarida").
  const startedAt = Date.now();
  while (queue.active && Date.now() - startedAt < 4000) await new Promise((ok) => setTimeout(ok, 100));
  comfy.close();
  comfyProxy?.close();
  db.close();
  server.close();
  process.exit(0);
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => close(s));

/**
 * Guncellemeden sonra yeniden basla. Tepsi yonetiyorsa (AI_PANEL_TEPSI=1) yalniz kapanir: bekci 10 sn'de acar.
 * Degilse (panel.bat penceresi, uzaktan baslatma) ayri yardimci bu surec kapaninca paneli ayni arguman ve ortamla acar.
 */
function startAgain(reason = 'update') {
  if (process.env.AI_PANEL_TRAY !== '1') {
    spawn(process.execPath, [join(setting.aiRoot, 'panel', 'lib', 'restart.mjs'), String(process.pid), ...process.argv.slice(1)], { detached: true, stdio: 'ignore', windowsHide: true, cwd: process.cwd(), env: process.env }).unref();
  }
  updater.stop();
  close(reason);
}
// Son savunma: islenmemis Promise reddi paneli dusurmesin (Node varsayilani surec sonu; calisan is "yarida" kalirdi).
// Gunluge yigin iziyle yazilir; kok sebep ayrica duzeltilir.
process.on('unhandledRejection', (e) => console.error('Unhandled error (panel keeps running):', e));
