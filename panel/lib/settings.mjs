/**
 * The panel's paths and the machine's own settings.
 *
 * No path is written as a constant: the folder above the panel folder is the ai root (C:\Users\root\ai on this
 * machine, C:\ai on another). The model file names (Q4_K_M / Q8_0) live in tools\comfy.mjs; the panel uses that
 * module's workflow builders.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostname, networkInterfaces } from 'node:os';
import { findFfmpeg, ffprobePath } from './ffmpeg.mjs';
import { findBlender } from './blender.mjs';
import { findLlm } from './llm.mjs';
import { batArgs } from './process.mjs';
import { DATA_FILES, LEGACY_DATA_FILES } from './data-files.mjs';

export const PANEL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Defaults written in one place (user request 08.10.2026): panel\defaults.json. The tray, setup and the CLI read the
 * same file; panel-data\settings.json or the environment change them for one installation.
 */
export const DEFAULTS = JSON.parse(readFileSync(join(PANEL_ROOT, 'defaults.json'), 'utf8'));

/**
 * Local install setting (port) from panel-data\settings.json: not in the repository, updates do not touch it.
 * ayar.json is the name used before the English rename (read when settings.json does not exist yet, i.e. before the
 * first start of the new version migrates it).
 */
function localSetting(dataRoot) {
  for (const name of [DATA_FILES.settings, LEGACY_DATA_FILES.settings]) {
    try {
      return JSON.parse(readFileSync(join(dataRoot, name), 'utf8'));
    } catch {}
  }
  return {};
}

export function loadSettings(parent = {}) {
  const aiRoot = parent.aiRoot ?? resolve(PANEL_ROOT, '..');
  const local = localSetting(parent.dataRoot ?? join(aiRoot, 'panel-data'));
  const ffmpeg = parent.ffmpeg !== undefined ? parent.ffmpeg : findFfmpeg(aiRoot);
  const speakBat = join(aiRoot, 'voice', 'speak.bat');
  const voxcpmBat = join(aiRoot, 'voice', 'voxcpm', 'speak.bat');
  // EMA Lightning (one Turkish female voice, very fast): when a library voice with "engine: ema" is chosen
  const emaBat = join(aiRoot, 'voice', 'ema', 'speak.bat');
  const designPython = join(aiRoot, 'voice', 'design', '.venv', 'Scripts', 'python.exe');
  const designPy = join(aiRoot, 'voice', 'design', 'design.py');
  // Turkish voice design with VoxCPM2 (when the engine is VoxCPM2): voice\voxcpm\description.py.
  const voxcpmPython = join(aiRoot, 'voice', 'voxcpm', '.venv', 'Scripts', 'python.exe');
  const voxcpmSpecPy = join(aiRoot, 'voice', 'voxcpm', 'description.py');
  const kizaganFolder = join(aiRoot, 'voice', 'hf', 'Kizagan-TTS-v1.0');
  const hasVoxcpmSpec = () => existsSync(voxcpmPython) && existsSync(voxcpmSpecPy);
  // Mouth fix (LatentSync, lip\): a speaking person's mouth is fitted to their own voice (film lip sync)
  const lipPython = join(aiRoot, 'lip', '.venv', 'Scripts', 'python.exe');
  const mouthPy = join(aiRoot, 'lip', 'mouth.py');
  const latentsyncFolder = join(parent.modelRoot ?? join(aiRoot, 'models'), 'latentsync');
  // Singing in a voice (YingMusic-SVC, voice\svc): voice\sing.py in its own environment, the two model files in models\singing
  const svcPython = join(aiRoot, 'voice', 'svc', '.venv', 'Scripts', 'python.exe');
  const singPy = join(aiRoot, 'voice', 'sing.py');
  const singingFolder = join(parent.modelRoot ?? join(aiRoot, 'models'), 'singing');
  const settings = {
    aiRoot,
    panelRoot: PANEL_ROOT,
    webRoot: parent.webRoot ?? join(PANEL_ROOT, 'web'),
    machine: hostname(),
    // Address: AI_PANEL_ADDRESS > panel-data\settings.json "address" > defaults.json (0.0.0.0: every network of the
    // computer; who reaches it is up to the firewall and the router). 127.0.0.1 keeps it on this computer.
    address: parent.address ?? process.env.AI_PANEL_ADDRESS ?? local.address ?? DEFAULTS.address,
    // Port: --port / AI_PANEL_PORT > panel-data\settings.json "port" (updates keep it) > defaults.json
    port: Number(parent.port ?? process.env.AI_PANEL_PORT ?? (Number(local.port) > 0 ? Number(local.port) : DEFAULTS.port)),
    comfyAddress: parent.comfyAddress ?? process.env.AI_PANEL_COMFY ?? 'http://127.0.0.1:8188',
    // While the panel is open to the network, ComfyUI is relayed to the home network on this port (lib/comfy-proxy.mjs).
    comfyNetworkPort: Number(parent.comfyNetworkPort ?? process.env.AI_PANEL_COMFY_NETWORK_PORT ?? 8189),
    comfyModule: parent.comfyModule ?? join(aiRoot, 'tools', 'comfy.mjs'),
    comfyLauncher: parent.comfyLauncher ?? join(aiRoot, 'start_comfyui.bat'),
    comfyWindow: parent.comfyWindow ?? process.env.AI_PANEL_COMFY_WINDOW === '1',
    // The panel starts ComfyUI: in its own window (the user sees the log and can close it).
    startComfy: parent.startComfy ?? null,
    comfyReadyWait: parent.comfyReadyWait ?? 240000,
    outputRoot: parent.outputRoot ?? join(aiRoot, 'outputs'),
    // The panel's lasting data (API key, model choice, download state): outside the code.
    dataRoot: parent.dataRoot ?? join(aiRoot, 'panel-data'),
    // Logs of the panel, ComfyUI, llama-server and the tray (the tray writes to the same <ai>\logs)
    logRoot: parent.logRoot ?? join(aiRoot, 'logs'),
    // The model files (ComfyUI's extra_model_paths.yaml looks at the same folder).
    modelRoot: parent.modelRoot ?? join(aiRoot, 'models'),
    voiceLibrary: parent.voiceLibrary ?? join(aiRoot, 'voice', 'references'),
    ffmpeg,
    ffprobe: parent.ffprobe !== undefined ? parent.ffprobe : ffprobePath(ffmpeg),
    // Blender (the 3D model job's turntable video and its FBX/OBJ/STL); found by looking for its versions.
    blender: parent.blender !== undefined ? parent.blender : findBlender(),
    x264Ready: parent.x264Ready ?? 'medium',
    // In-between video files: x264 (default) | nvenc | auto (NVENC when there is one). Measured 04.10.2026: on real
    // Wan frames a 720p part takes 1.2 s with x264 / 0.6 s with NVENC (nothing beside 370 s of generation), the NVENC
    // file is 1.75 times bigger; the video job joins the parts without encoding again, so x264 is the default.
    encoder: parent.encoder ?? process.env.AI_PANEL_ENCODER ?? 'x264',
    // Voice-over (Chatterbox) and voice design (Qwen3-TTS): the machine's own scripts.
    hasVoice: parent.voiceCommand ? true : existsSync(speakBat),
    hasEma: parent.hasEma ?? existsSync(emaBat),
    hasDesign: parent.designCommand ? true : (existsSync(designPython) && existsSync(designPy)) || hasVoxcpmSpec(),
    // Which model designs a voice from a description: voxcpm (with Turkish text, when the engine is VoxCPM2 and it is installed) | qwen (Qwen3-TTS, English).
    designEngine:
      parent.designEngine ??
      // With the EMA engine the design is VoxCPM2's too (EMA is one voice, it does not design)
      (() => (['voxcpm', 'kizagan', 'ema'].includes(settings.selectVoiceEngine?.() ?? 'voxcpm') && hasVoxcpmSpec() ? 'voxcpm' : existsSync(designPy) ? 'qwen' : hasVoxcpmSpec() ? 'voxcpm' : 'qwen')),
    voiceCommand:
      parent.voiceCommand ??
      ((args, voiceEngine = null) => {
        // The EMA Lightning voice: its own script (no cloning; a reference is ignored)
        if (voiceEngine === 'ema' && existsSync(emaBat)) {
          const e = batArgs(emaBat, args);
          return { ...e, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PATH: addPath(ffmpeg) } };
        }
        // The voice engine: the line's engine (a library voice's, or the one speak() picked), else the setting's
        // (server.mjs binds selectVoiceEngine). Without the EMA script or with an engine other than 'ema': VoxCPM2;
        // Chatterbox when that is not installed either.
        const engine = voiceEngine && voiceEngine !== 'ema' ? voiceEngine : settings.selectVoiceEngine?.() === 'ema' ? 'voxcpm' : (settings.selectVoiceEngine?.() ?? 'voxcpm');
        // Kizagan: VoxCPM2's Turkish fine-tune (the same script, the model folder through VOXCPM_MODEL); else VoxCPM2.
        const kizagan = engine === 'kizagan' && existsSync(join(kizaganFolder, 'model.safetensors'));
        const bat = (engine === 'voxcpm' || engine === 'kizagan') && existsSync(voxcpmBat) ? voxcpmBat : speakBat;
        const b = batArgs(bat, args);
        return { ...b, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PATH: addPath(ffmpeg), ...(kizagan ? { VOXCPM_MODEL: kizaganFolder } : {}) } };
      }),
    designCommand:
      parent.designCommand ??
      ((args, engine = 'qwen') => ({
        command: engine === 'voxcpm' ? voxcpmPython : designPython,
        args: [engine === 'voxcpm' ? voxcpmSpecPy : designPy, ...args],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PATH: addPath(ffmpeg) },
      })),
    // Mouth fix: the environment, the script and four model files (Settings > Models > "Mouth fix (LatentSync)")
    // Checked on every query: once the files come down from Settings > Models they are used without a restart
    get hasMouth() {
      return parent.mouthCommand
        ? true
        : existsSync(lipPython) && existsSync(mouthPy) && ['latentsync_unet.pt', 'whisper-tiny.pt', 'sd-vae-ft-mse.safetensors', 'face_landmarker.task'].every((d) => existsSync(join(latentsyncFolder, d)));
    },
    mouthCommand:
      parent.mouthCommand ??
      ((args) => ({
        command: lipPython,
        args: [mouthPy, ...args],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PATH: addPath(ffmpeg), AI_LATENTSYNC_MODEL: latentsyncFolder },
      })),
    // Checked on every query like the mouth fix: usable as soon as Settings > Models has downloaded the two files
    get hasSing() {
      return parent.singCommand ? true : existsSync(svcPython) && existsSync(singPy) && ['YingMusic-SVC-full.pt', 'bs_roformer.ckpt'].every((d) => existsSync(join(singingFolder, d)));
    },
    singCommand:
      parent.singCommand ??
      ((args) => ({
        command: svcPython,
        args: [singPy, ...args],
        // HF_HUB_OFFLINE: the helper models are in voice\svc\checkpoints at pinned revisions (setup: voice-models.py svc)
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PATH: addPath(ffmpeg), AI_SVC_MODEL: singingFolder, HF_HUB_OFFLINE: '1' },
      })),
    // Own voice (voice\clone): prepare.py in voice\.venv (Whisper), train.py in the VoxCPM2 environment (LoRA).
    hasClone: parent.cloneCommand ? true : existsSync(join(aiRoot, 'voice', 'clone', 'prepare.py')) && existsSync(join(aiRoot, 'voice', '.venv', 'Scripts', 'python.exe')),
    hasTraining: parent.cloneCommand ? true : existsSync(join(aiRoot, 'voice', 'clone', 'train.py')) && existsSync(join(aiRoot, 'voice', 'voxcpm', '.venv', 'Scripts', 'python.exe')),
    cloneCommand:
      parent.cloneCommand ??
      ((stage, args) => ({
        command: join(aiRoot, 'voice', ...(stage === 'train' ? ['voxcpm', '.venv'] : ['.venv']), 'Scripts', 'python.exe'),
        args: [join(aiRoot, 'voice', 'clone', `${stage}.py`), ...args],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PATH: addPath(ffmpeg) },
      })),
    // Video upscaling to 1080p (tools\upscale.py, ComfyUI's python: torch + spandrel are there). The 2x model is in models\upscale_models.
    upscaleModel: parent.upscaleModel ?? join(parent.modelRoot ?? join(aiRoot, 'models'), 'upscale_models', '2xNomosUni_span_multijpg.safetensors'),
    upscaleCommand:
      parent.upscaleCommand ??
      ((args) => ({
        command: join(aiRoot, 'ComfyUI_windows_portable', 'python_embeded', 'python.exe'),
        args: ['-s', join(aiRoot, 'tools', 'upscale.py'), ...args],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })),
    // Model training (training\train.py, training\.venv: torch cu128 + peft + bitsandbytes + the llama.cpp converter).
    hasTrainingEnv: parent.trainingCommand ? true : existsSync(join(aiRoot, 'training', 'train.py')) && existsSync(join(aiRoot, 'training', '.venv', 'Scripts', 'python.exe')),
    trainingCommand:
      parent.trainingCommand ??
      ((args) => ({
        command: join(aiRoot, 'training', '.venv', 'Scripts', 'python.exe'),
        args: [join(aiRoot, 'training', 'train.py'), ...args],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })),
    // Image LoRA training (training\image.py, training\musubi\.venv: musubi-tuner) + the FLUX.2 klein training files.
    hasImageTraining: parent.imageTrainingCommand
      ? true
      : existsSync(join(aiRoot, 'training', 'image.py')) && existsSync(join(aiRoot, 'training', 'musubi', '.venv', 'Scripts', 'python.exe')), // the bases come down at the first training
    imageTrainingCommand:
      parent.imageTrainingCommand ??
      ((args) => ({
        command: join(aiRoot, 'training', 'musubi', '.venv', 'Scripts', 'python.exe'),
        args: [join(aiRoot, 'training', 'image.py'), ...args],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })),
    // General (multimodal) model training (training\general.py, training\.venv; the GGUF step is train.py's): Qwen3.5 image + text.
    hasGeneralTraining: parent.generalTrainingCommand
      ? true
      : existsSync(join(aiRoot, 'training', 'general.py')) && existsSync(join(aiRoot, 'training', '.venv', 'Scripts', 'python.exe')),
    generalTrainingCommand:
      parent.generalTrainingCommand ??
      ((args) => ({
        command: join(aiRoot, 'training', '.venv', 'Scripts', 'python.exe'),
        args: [join(aiRoot, 'training', 'general.py'), ...args],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })),
    // Music LoRA training (training\music.py, training\sidestep\.venv: Side-Step) + ACE-Step 1.5 (comes down at the first training).
    hasMusicTraining: parent.musicTrainingCommand
      ? true
      : existsSync(join(aiRoot, 'training', 'music.py')) && existsSync(join(aiRoot, 'training', 'sidestep', '.venv', 'Scripts', 'python.exe')),
    musicTrainingCommand:
      parent.musicTrainingCommand ??
      ((args) => ({
        command: join(aiRoot, 'training', 'sidestep', '.venv', 'Scripts', 'python.exe'),
        args: [join(aiRoot, 'training', 'music.py'), ...args],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })),
    // voice\<script>.py in voice\.venv (e.g. convert.py: voice conversion, Chatterbox VC).
    voiceScriptCommand:
      parent.voiceScriptCommand ??
      ((script, args) => ({
        command: join(aiRoot, 'voice', '.venv', 'Scripts', 'python.exe'),
        args: [join(aiRoot, 'voice', script), ...args],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PATH: addPath(ffmpeg) },
      })),
    // Deletion: permanent (user 04.10.2026: "direk silsin"); AI_PANEL_DELETION=recycle-bin moves to the Recycle Bin.
    deletionMethod: parent.deletionMethod ?? (process.env.AI_PANEL_DELETION === 'recycle-bin' ? 'recycle-bin' : 'permanent'),
    openBrowser: parent.openBrowser ?? true,
    gpuStatus: parent.gpuStatus ?? null,
    // The queue's RAM guard (queue.mjs): tests give a fake measurement.
    ramWatchdog: parent.ramWatchdog,
    ramThresholdGb: parent.ramThresholdGb ?? 4,
    ramWait: parent.ramWait ?? 60000,
    // Data collection: requests to private network addresses allowed (tests only; SSRF protection), the least wait per
    // site (ms), the browser path (undefined: Edge/Chrome found by itself; null: no browser), the search template (tests: {q}).
    // Sign-in (API key / session) for network clients: off by default (user: "uyelik yok"); AI_PANEL_LOGIN=1 turns it on.
    loginRequired: parent.loginRequired ?? process.env.AI_PANEL_LOGIN === '1',
    // Browser requests from this machine are free without a key (false: tests; every client counts as a network client)
    localClientTrust: parent.localClientTrust ?? true,
    // Chat / agent (lib/agent): job polling interval, order of the web search engines
    agentPollingMs: parent.agentPollingMs ?? 2000,
    agentSearchEngines: parent.agentSearchEngines ?? ['bing', 'ddg', 'wiki'],
    // Brave Search and Tavily API endpoints for search_web ({ brave, tavily }; tests: a fake server; null = the real ones)
    agentSearchApis: parent.agentSearchApis ?? null,
    // search_web / fetch_web through the headless browser (lib/agent/tools.mjs WebBrowser); off in tests
    agentBrowser: parent.agentBrowser ?? true,
    dataPrivateNetworkAllowed: parent.dataPrivateNetworkAllowed ?? process.env.AI_PANEL_DATA_PRIVATE_NETWORK === '1',
    dataMinDelayMs: parent.dataMinDelayMs ?? 1000,
    // free disk (GB) media downloads leave; null: 10 GB (lib/jobs/data.mjs)
    mediaDiskMarginGb: parent.mediaDiskMarginGb ?? null,
    // Least gap between two searches on one search service (Brave's free plan: 1 per second); tests: shorter
    dataServiceDelayMs: parent.dataServiceDelayMs ?? 1000,
    browserPath: parent.browserPath,
    dataSearchTemplate: parent.dataSearchTemplate ?? process.env.AI_PANEL_DATA_SEARCH ?? null,
    // Extra domains that count as huge general sites (a local site in tests; none in production)
    dataWideSites: parent.dataWideSites ?? null,
    // The Google News resolving address (a fake server in tests; https://news.google.com in production)
    dataGnewsAddress: parent.dataGnewsAddress ?? null,
    // Wikimedia Commons API (the commons: source); a fake server in tests
    commonsApi: parent.commonsApi ?? null,
    // The local text model (llama-server + gguf): <ai>\llm; null in tests.
    llm: parent.llm !== undefined ? parent.llm : findLlm(aiRoot, parent.textModel ?? ''),
    sceneWriter: parent.sceneWriter ?? null,
    lyricWriter: parent.lyricWriter ?? null,
    // Closing ComfyUI (API): tests give a fake.
    closeComfy: parent.closeComfy ?? null,
    // Knowledge's embedding server: (port, model) -> { command, args, env } in place of llama-server (tests: a fake)
    embedCommand: parent.embedCommand ?? null,
  };
  return settings;
}

/** The ffmpeg folder on the child processes' PATH (Whisper reads audio with ffmpeg). */
function addPath(ffmpeg) {
  const path = process.env.PATH ?? '';
  return ffmpeg ? `${dirname(ffmpeg)};${path}` : path;
}

/**
 * The names the Host/Origin check accepts (against DNS rebinding): always 127.0.0.1 / localhost; bound to 0.0.0.0,
 * this machine's IPv4 addresses; bound to one address, that address.
 */
export function allowedHosts(address) {
  const names = ['127.0.0.1', 'localhost'];
  if (address === '0.0.0.0') {
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4') names.push(a.address);
  } else if (address) names.push(address);
  return [...new Set(names)];
}

/** Loads tools\comfy.mjs (the machine's own model names are there). */
export async function loadComfyModule(path) {
  if (!existsSync(path)) throw new Error(`tools\\comfy.mjs not found: ${path}`);
  return import(pathToFileURL(path).href);
}

/** The folder of the uploaded images and music (inside the output folder). */
export const UPLOAD_FOLDER = 'uploads';

/**
 * Moves the old Turkish folder names to the new ones (once, at startup): ciktilar -> outputs,
 * ciktilar\yuklemeler -> outputs\uploads, panel-veri -> panel-data. Does nothing when the new folder already exists.
 * The jobs and sources keep relative addresses (the migration rewrites "is/<id>/...", "yukleme/..."), so nothing
 * else has to change here.
 */
export function migrateOldFolders(setting, log = () => {}) {
  const move = (old, fresh) => {
    if (existsSync(old) && !existsSync(fresh)) {
      renameSync(old, fresh);
      log(`Folder moved: ${old} -> ${fresh}`);
    }
  };
  move(join(setting.aiRoot, 'ciktilar'), setting.outputRoot);
  move(join(setting.outputRoot, 'yuklemeler'), join(setting.outputRoot, UPLOAD_FOLDER));
  move(join(setting.aiRoot, 'panel-veri'), setting.dataRoot);
}
