/**
 * The shared parts of the job runners: input checks, size presets, the source image,
 * voice-over (voice\speak.bat) and voice design from a description (VoxCPM2 / Qwen3-TTS).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { CancelError, UserError } from '../errors.mjs';
import { run as runProcess } from '../process.mjs';
import { runFfmpeg, audioSpeed } from '../ffmpeg.mjs';
import { wavDuration } from '../media.mjs';
import { UPLOAD_FOLDER } from '../settings.mjs';
import { voiceInfo, addVoice, voiceLoraPath, voicePath, voicePace, voiceTimbre, defaultVoice } from '../voices.mjs';
import { usedFiles, graphFiles, SAMPLE_INPUT } from '../models.mjs';
import { fixPronunciation } from '../pronunciation.mjs';
import { makePromptEnglish } from '../prompt-translate.mjs';

/* ── Input checks ───────────────────────────────────────────────────── */

export function text(value, name, { required = true, max = 4000 } = {}) {
  const s = String(value ?? '').trim();
  if (required && !s) throw new UserError(`${name} cannot be empty.`);
  if (s.length > max) throw new UserError(`${name} can be at most ${max} characters (${s.length}).`);
  return s;
}

export function number(value, name, { min, max, defaultValue, full = false } = {}) {
  if (value === '' || value === null || value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new UserError(`${name} is required.`);
  }
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) throw new UserError(`${name} must be a number.`);
  if (full && !Number.isInteger(n)) throw new UserError(`${name} must be a whole number.`);
  if (min !== undefined && n < min) throw new UserError(`${name} must be at least ${min}.`);
  if (max !== undefined && n > max) throw new UserError(`${name} can be at most ${max}.`);
  return n;
}

export function choice(value, name, allowed, defaultValue) {
  const d = value === undefined || value === '' ? defaultValue : value;
  if (!allowed.includes(d)) throw new UserError(`${name} is invalid: ${d}`);
  return d;
}

export function seed(value) {
  if (value === '' || value === null || value === undefined) return Math.floor(Math.random() * 1e9);
  return number(value, 'Seed', { min: 0, max: 2 ** 48, full: true });
}

export function yes(value) {
  return value === true || value === 'true' || value === '1' || value === 'on' || value === 1;
}

/* ── Size presets (the page's presets; not model names) ─────────────────── */

// The sizes Qwen-Image officially recommends; for FLUX their ~2 MP equivalents (multiples of 16).
export const RATIOS = {
  '16:9': { qwen: [1664, 928], flux: [1920, 1088], name: '16:9 landscape' },
  '9:16': { qwen: [928, 1664], flux: [1088, 1920], name: '9:16 portrait' },
  '1:1': { qwen: [1328, 1328], flux: [1440, 1440], name: '1:1 square' },
  '4:3': { qwen: [1472, 1104], flux: [1664, 1248], name: '4:3' },
  '3:4': { qwen: [1104, 1472], flux: [1248, 1664], name: '3:4' },
  '3:2': { qwen: [1584, 1056], flux: [1728, 1152], name: '3:2' },
  '2:3': { qwen: [1056, 1584], flux: [1152, 1728], name: '2:3' },
};

// Wan: 16 fps (A14B) / 24 fps (5B); 5B wants multiples of 32. 1080p is not official (the model was trained up to
// 720p): 1920x1088 is generated and the output is cut to 1080 (trimmedSize).
export const VIDEO_MODELS = {
  wan14: { generator: 'wan14Job', name: 'Wan 2.2 A14B (best)', fps: 16, frame: 81, size: { '1080p': { landscape: [1920, 1088], portrait: [1088, 1920], square: [1440, 1440] }, '720p': { landscape: [1280, 720], portrait: [720, 1280], square: [960, 960] }, '480p': { landscape: [832, 480], portrait: [480, 832], square: [640, 640] } } },
  wan5: { generator: 'wanJob', name: 'Wan 2.2 5B (light)', fps: 24, frame: 121, size: { '1080p': { landscape: [1920, 1088], portrait: [1088, 1920], square: [1440, 1440] }, '720p': { landscape: [1280, 704], portrait: [704, 1280], square: [960, 960] }, '480p': { landscape: [832, 480], portrait: [480, 832], square: [640, 640] } } },
};

/** 1080p output sizes (the target when 720p is generated and upscaled). */
export const OUTPUT_1080P = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1440, 1440] };

/** The output size from the generated size: 1088 (a multiple of 16/32) is cut to 1080 around the middle. */
export function trimmedSize([width, height]) {
  return [width === 1088 ? 1080 : width, height === 1088 ? 1080 : height];
}

/**
 * Output frame rate: a preset 24 / 30 / 60 or a custom one (1-240). Above the model's natural rate RIFE makes
 * in-between frames (a whole factor, at most RIFE_MAX), then ffmpeg brings it to the exact target.
 */
export const FPS_PRESETS = [24, 30, 60];
export const FPS_MAX = 240;
export const RIFE_MAX = 8;
export function validateFps(value, { defaultValue = null } = {}) {
  if (value === '' || value === null || value === undefined) return defaultValue;
  return number(value, 'Frame rate (FPS)', { min: 1, max: FPS_MAX, full: true });
}
export function rifeFactor(native, target, slowdown = 1) {
  return Math.min(RIFE_MAX, Math.max(1, Math.ceil((target * slowdown) / native - 0.01)));
}

export const IMAGE_MODELS = {
  qwen: { generator: 'qwenJob', name: 'Qwen-Image 2512 (strongest)', step: 8 },
  flux: { generator: 'fluxJob', name: 'FLUX.2 klein 4B (very fast)', step: 4 },
};

/**
 * Can the comfy.mjs generator be used on this machine? Not when it is missing or throws while building a
 * sample graph (e.g. "the 5B model is not on this machine"); with the reason.
 */
export function generatorStatus(mod, generator) {
  if (typeof mod?.[generator] !== 'function') return { available: false, reason: `${generator} is not in comfy.mjs` };
  try {
    mod[generator]({ text: 'x', seed: 0, prefix: 'x', picture: 'x.png', width: 1280, height: 720, frame: 81, smooth: 1 });
    return { available: true, reason: '' };
  } catch (e) {
    return { available: false, reason: String(e?.message ?? e) };
  }
}

/**
 * In validation: when the generator cannot be used, an error before the job is created. input: the job's own graph
 * parameters, whose files are checked too (3D high quality loads Pixal3D and MoGe, not the default TRELLIS.2; a job
 * started while they were still downloading reached ComfyUI and failed there, 10.10.2026).
 */
export function generatorRequired(mod, generator, name, modelRoot = null, input = null) {
  const d = generatorStatus(mod, generator);
  if (!d.available) throw new UserError(`${name} is not available on this machine: ${d.reason}`);
  // Model files: a missing file is reported before the job enters the queue (before ComfyUI).
  // RIFE (checkpoints/rife49.pth) lives in the extension's own folder, which downloads it on first use.
  if (modelRoot && existsSync(modelRoot)) {
    const files = input
      ? graphFiles(mod[generator]({ ...SAMPLE_INPUT, ...input }))
      : Object.entries(usedFiles(mod)).filter(([, generators]) => generators.includes(generator)).map(([key]) => key);
    const missing = files
      .filter((key) => !/^checkpoints\/rife/.test(key))
      .filter((key) => !existsSync(join(modelRoot, ...key.split('/'))));
    if (missing.length) throw new UserError(`Model files missing for ${name}: ${missing.map((e) => e.split('/')[1]).join(', ')}. Download them in Settings > Models or move your own files.`);
  }
}

export function on16(n) {
  return Math.max(256, Math.min(2048, Math.round(n / 16) * 16));
}

/* ── Source image (from the gallery / uploaded) ────────────────────────── */

const SAFE = /^[\w.-]+$/;

/** A source reference as given ("job/<id>/<file>", "upload/<file>", "collection/<id>"), trimmed. */
export function normalizeSource(ref) {
  return String(ref ?? '').trim();
}

/**
 * A source from the page: "job/<id>/<file>" or "upload/<file>". Only files inside the panel's
 * output folder are allowed.
 */
export function sourcePath(outputRoot, ref) {
  const s = normalizeSource(ref);
  const part = s.split('/');
  let path = null;
  if (part[0] === 'job' && part.length === 3 && part.slice(1).every((p) => SAFE.test(p))) path = join(outputRoot, part[1], part[2]);
  if (part[0] === 'upload' && part.length === 2 && SAFE.test(part[1])) path = join(outputRoot, UPLOAD_FOLDER, part[1]);
  if (!path) throw new UserError('Invalid source image.');
  const full = resolve(path);
  if (!full.startsWith(resolve(outputRoot) + sep)) throw new UserError('The source image is outside the panel folder.');
  if (!existsSync(full)) throw new UserError('Source image not found (it may have been deleted).');
  if (!/\.(png|jpe?g|webp)$/i.test(full)) throw new UserError('The source image must be PNG, JPEG or WebP.');
  return full;
}

/** Music: "upload/<file>" (MP3, WAV, M4A, OGG, FLAC) inside the panel folder. */
// A video works too (MP4, MOV…): ffmpeg uses only its audio track.
export const MUSIC_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.mp4', '.mov', '.mkv', '.webm', '.m4v'];
export function musicPath(outputRoot, ref) {
  // "upload/<file>" (uploaded) or "job/<id>/<file>" (from the gallery: the output of a music or voice job)
  const part = normalizeSource(ref).split('/');
  let path = null;
  if (part[0] === 'upload' && part.length === 2 && SAFE.test(part[1])) path = join(outputRoot, UPLOAD_FOLDER, part[1]);
  if (part[0] === 'job' && part.length === 3 && part.slice(1).every((p) => SAFE.test(p))) path = join(outputRoot, part[1], part[2]);
  if (!path) throw new UserError('Invalid music file.');
  const full = resolve(path);
  if (!full.startsWith(resolve(outputRoot) + sep)) throw new UserError('The music file is outside the panel folder.');
  if (!MUSIC_EXTENSIONS.includes(extname(full).toLowerCase())) throw new UserError('Music must be an audio or video file (MP3, WAV, M4A, OGG, FLAC, MP4, MOV…).');
  if (!existsSync(full)) throw new UserError('Music file not found (it may have been deleted).');
  return full;
}

/** Music level: it stays under the narration (the sidechain lowers it further). */
export const MUSIC_LEVEL = { low: 0.12, medium: 0.2, high: 0.32 };

/* ── File name ─────────────────────────────────────────────────────────── */

export function slug(s, defaultValue = 'film') {
  const tr = { ç: 'c', ğ: 'g', ı: 'i', İ: 'I', ö: 'o', ş: 's', ü: 'u', Ç: 'C', Ğ: 'G', Ö: 'O', Ş: 'S', Ü: 'U', â: 'a', î: 'i', û: 'u' };
  const d = String(s ?? '')
    .replace(/[çğıİöşüÇĞÖŞÜâîû]/g, (h) => tr[h])
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return d || defaultValue;
}

/* ── Voice options (shared by Voice and Film) ─────────────────────────── */

export const QUALITY = {
  fast: { trial: 1, args: [], name: 'Fast (reads once)' },
  checked: { trial: 3, args: [], name: 'Checked (reads 3 times, keeps the most accurate)' },
  natural: { trial: 6, args: ['--vary', '--naturalness'], name: 'Most natural (reads 6 times, keeps the most natural; slow)' },
};

/**
 * An audio extraction error from ffmpeg: "no audio found" only when the file has no audio track or is broken;
 * a cancel, a missing ffmpeg, a full disk and the like pass as they are (otherwise even a cancel looked like an error).
 */
export function voiceExtractionError(e) {
  if (e instanceof CancelError) return e;
  const text = `${e?.message ?? ''}\n${(e?.lastLines ?? []).join('\n')}`;
  if (/matches no streams|does not contain any stream|Invalid data found|Output file (is empty|does not contain any stream)/i.test(text)) return new UserError('No audio found in the file or it could not be read.');
  return e;
}

/**
 * Checks the voice fields: { voice, spec, recordName, lang, speed, quality, exaggeration, cfg }. narration: false
 * (every scene has its own audio) skips the install and voice checks.
 */
export function voiceInput(g, setting, { narration = true } = {}) {
  // Without a voice, the library's default narrator: the "model" path may give another timbre on every call.
  const voice = g.voice === undefined || g.voice === null || g.voice === '' ? defaultVoice(setting.voiceLibrary) : String(g.voice);
  const result = {
    voice,
    lang: choice(g.lang, 'Language', ['tr', 'en'], 'tr'),
    speed: number(g.speed, 'Speed', { min: 0.7, max: 1.3, defaultValue: 1 }),
    quality: choice(g.quality, 'Quality', Object.keys(QUALITY), 'checked'),
    exaggeration: number(g.exaggeration, 'Emotion', { min: 0.25, max: 2, defaultValue: 0.5 }),
    cfg: number(g.cfg, 'Reading pace', { min: 0, max: 1, defaultValue: 0.5 }),
  };
  if (!narration) return result;
  if (!setting.hasVoice) throw new UserError('Voice-over is not installed (voice\\speak.bat missing).');
  if (voice === 'spec') {
    if (!setting.hasDesign) throw new UserError('Voice design is not installed (VoxCPM2 or Qwen3-TTS).');
    result.spec = text(g.spec, 'Voice description', { max: 1000 });
    result.recordName = text(g.recordName, 'Voice name', { required: false, max: 60 }) || `Design ${new Date().toLocaleString('tr-TR')}`;
  } else if (voice.startsWith('ref:')) {
    if (!voicePath(setting.voiceLibrary, voice.slice(4))) throw new UserError('The selected voice is not in the library (it may have been deleted).');
  } else if (voice !== 'model') {
    throw new UserError('Invalid voice selection.');
  }
  return result;
}

/** Splits a long text into voice-over lines (a TTS model makes things up on long input). */
export function splitLines(m, max = 220) {
  const sentences = String(m).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/);
  const lines = [];
  let now = '';
  for (const c of sentences) {
    if (!now) now = c;
    else if (now.length + 1 + c.length <= max) now = `${now} ${c}`;
    else {
      lines.push(now);
      now = c;
    }
  }
  if (now) lines.push(now);
  // Lines with a very long sentence are split at commas.
  return lines.flatMap((s) => (s.length <= max * 1.5 ? [s] : s.split(/(?<=,)\s+/)));
}

const SPEC_EXAMPLE_TEXT =
  'The old stories say that the river remembers every traveler. Sit down, listen closely, and I will tell you how it all began, long before the first light of morning.';
// The VoxCPM2 design reads Turkish: this text becomes the voice's reference text (a full clone: timbre + speaking style).
const SPEC_EXAMPLE_TEXT_TR = 'Gel otur evlat, sana bir efsane anlatayım. Çok eskiden, dağların ardında, ışıklarla örülmüş bir şehir vardı. Kaplumbağa sakin adımlarla denize doğru yürüdü.';
// A character voice is designed with a neutral (everyday) text: a full clone carries the reference's intonation into
// every line. Measured 07.10.2026: Elif, designed with a fairy-tale text + a "cheerful" description, had her worried
// and scared lines classed "happy" (emotion2vec); user: "Pamuk nerdesin diyor ama guluyor". The emotion comes per
// line from the director's note (voxcpm\\generate.py bank mode).
const SPEC_NEUTRAL_TEXT_TR = 'Bugün okuldan sonra parka gittim. Orada bir kuş gördüm, sonra eve döndüm. Akşam yemeğinde makarna yedik ve biraz kitap okudum.';
const SPEC_NEUTRAL_TEXT = 'After school today I went to the park. I saw a bird there, and then I walked back home. We had pasta for dinner and I read a little.';
// A voice for English work reads English while it is designed (user 09.10.2026: the English promo in a voice designed on
// Turkish text "did not suit": the clone carried the Turkish reading into English).
function designText(engine, lang, neutral) {
  if (engine !== 'voxcpm') return SPEC_EXAMPLE_TEXT;
  if (lang === 'en') return neutral ? SPEC_NEUTRAL_TEXT : SPEC_EXAMPLE_TEXT;
  return neutral ? SPEC_NEUTRAL_TEXT_TR : SPEC_EXAMPLE_TEXT_TR;
}

// The seeds tried when a character voice is designed (VoxCPM2): one description changes a lot by seed (measured
// 07.10.2026: child probability 0.51 / 0.78 / 0.99). The design script measures the candidates (pitch, age/gender,
// likeness to the other characters) and picks the best fit.
const DESIGN_CANDIDATE_COUNT = 3;
const DESIGN_TARGETS = new Set(['child', 'young', 'adult', 'old']);

/**
 * Makes a reference voice from a description (VoxCPM2 or Qwen3-TTS VoiceDesign) and adds it to the library. neutral:
 * a character voice. With a character ({ age, gender, type }) (VoxCPM2) several seeds are made and one is picked by
 * measurement; separate: the wav paths of voices it must differ from (the other characters of the film, the narrator).
 * Returns the voice id.
 */
export async function voiceDesign(ctx, { spec, recordName, folder, neutral = false, character = null, separate = [], lang = 'tr' }) {
  mkdirSync(folder, { recursive: true });
  // The design models take English descriptions (Qwen3-TTS VoiceDesign: English/Chinese); the form asks for English but a
  // Turkish one went through as written, like the Turkish image prompts Qwen-Image misread (10.10.2026).
  const english = await makePromptEnglish(spec, { type: 'voice', signal: ctx.signal });
  if (english.translated) ctx.log(`Voice description translated to English: ${english.prompt}`);
  else if (english.error) ctx.log(`Voice description could not be translated; using it as is (${english.error}).`);
  spec = english.prompt;
  writeFileSync(join(folder, 'spec.txt'), spec, 'utf8');
  const engine = ctx.setting.designEngine?.() ?? 'qwen';
  const exampleText = designText(engine, lang, neutral);
  writeFileSync(join(folder, 'spec_text.txt'), exampleText, 'utf8');
  const output = join(folder, 'timbre.wav');
  const report = join(folder, 'report.json');
  rmSync(report, { force: true });
  const commonArg = ['--spec', `@${join(folder, 'spec.txt')}`, '--text', `@${join(folder, 'spec_text.txt')}`, '--output', output];
  const choiceArg = engine === 'voxcpm' && character
    ? [
      '--candidate', String(DESIGN_CANDIDATE_COUNT),
      '--target', DESIGN_TARGETS.has(character.age) ? character.age : 'adult',
      '--gender', character.gender === 'male' ? 'male' : 'female',
      '--type', character.type === 'animal' ? 'animal' : 'human',
      '--report', report,
      ...(separate.length ? ['--separate', ...separate] : []),
    ]
    : [];
  const k = ctx.setting.designCommand(engine === 'voxcpm' ? [...commonArg, ...choiceArg] : [...commonArg, '--count', '1', '--language', 'english'], engine);
  ctx.log(`Voice design (${engine === 'voxcpm' ? `VoxCPM2, ${lang === 'en' ? 'English' : 'Turkish'}` : 'Qwen3-TTS'}${choiceArg.length ? `, ${DESIGN_CANDIDATE_COUNT} candidates measured and selected` : ''}): "${spec}"`);
  await runProcess(k.command, k.args, { env: k.env, cwd: folder, signal: ctx.signal, name: 'design', windowsVerbatimArguments: k.windowsVerbatimArguments, line: (s) => ctx.log(s) });
  if (!existsSync(output)) throw new Error('Voice design produced no output (timbre.wav missing).');
  // The candidate measurements (--report): the selected candidate's values go into the library record (measurement)
  let measurement = null;
  if (choiceArg.length && existsSync(report)) {
    try {
      const r = JSON.parse(readFileSync(report, 'utf8'));
      const s = (r.candidates ?? []).find((a) => a.seed === r.selected);
      if (s) {
        measurement = Object.fromEntries(['seed', 'f0', 'age', 'child', 'female', 'male', 'similarity', 'score'].filter((x) => s[x] != null).map((x) => [x, s[x]]));
        ctx.log(`Voice design candidates: ${r.candidates.map((a) => `seed ${a.seed} pitch ${a.f0 ?? '?'} Hz, child ${a.child}, ${a.gender ?? ''}${a.similarity != null ? `similarity ${a.similarity}, ` : ''}score ${a.score}${a.reason ? ` (${a.reason})` : ''}`).join('; ')} → selected seed ${r.selected}`);
      }
    } catch (e) {
      ctx.log(`Could not read the voice design report: ${e.message}`);
    }
  }
  const id = addVoice(ctx.setting.voiceLibrary, {
    name: recordName,
    source: output,
    description: engine === 'voxcpm' ? 'From description (VoxCPM2 voice design)' : 'From description (Qwen3-TTS VoiceDesign)',
    spec,
    // The text read in a VoxCPM2 design is known: a full clone in voice-over. neutral: the emotion comes per line (character voice)
    extra: { ...(engine === 'voxcpm' ? { referenceText: exampleText } : {}), ...(neutral ? { neutral: true } : {}), ...(measurement ? { measurement } : {}) },
  });
  ctx.log(`Voice added to library: ${recordName} (${id})`);
  return id;
}

/**
 * Reads the lines aloud (one speak.bat run, the model loads once).
 * lines: [{ id, text, reference?, referenceText? }]: a line with a voice is read in that voice (film dialogue:
 * character voices), otherwise in the job's reference. Returns { [id]: { path, duration, heard, error, words, f0 } };
 * f0: the median pitch of the selected take, Hz (checked/natural quality; the gender/age check of a character voice).
 * progress(ratio 0..1, text). quick: EMA reads once on the CPU without the Whisper check (read aloud: ~0.3 s a sentence,
 * the graphics card stays with the running job).
 */
export async function speak(ctx, { lines, reference, referenceText = null, lora = null, engine = null, timbre = null, pace = null, select, folder, quick = false, progress = () => {} }) {
  mkdirSync(folder, { recursive: true });
  const quality = QUALITY[select.quality];
  // A long line: split into sub-lines, then joined.
  const subs = [];
  for (const s of lines) {
    const parts = splitLines(s.text);
    parts.forEach((p, i) => subs.push({ parent: s.id, id: parts.length > 1 ? `${s.id}_p${i + 1}` : s.id, text: p, reference: s.reference ?? null, referenceText: s.referenceText ?? null, directive: s.directive ?? null }));
  }
  const jobFile = join(folder, 'job.json');
  writeFileSync(
    jobFile,
    // emotionMode "bank": a line with a directive first has the same voice read an emotion sample, then follows its intonation (voice\voxcpm\generate.py)
    // speed: the pace of an EMA library voice (user 09.10.2026: "Bi tık hızlandırabiliriz konuşmayı"), EMA's own
    JSON.stringify({ reference: reference ?? undefined, referenceText: referenceText ?? undefined, lora: lora ?? undefined, language: select.lang, speed: pace && pace !== 1 ? pace : undefined, ...(subs.some((a) => a.directive) ? { emotionMode: 'bank' } : {}), lines: subs.map((a) => ({ id: a.id, text: select.lang === 'tr' ? fixPronunciation(a.text) : a.text, exaggeration: select.exaggeration, cfg: select.cfg, ...(a.reference ? { reference: a.reference, referenceText: a.referenceText ?? undefined } : {}), ...(a.directive ? { directive: a.directive } : {}) })) }, null, 1),
    'utf8',
  );
  const total = subs.length * quality.trial;
  let generated = 0;
  // engine 'ema': the EMA Lightning script (a library voice with "engine: ema"); otherwise the engine of the settings.
  // When the settings engine is EMA (07.10.2026 user: "Ses motoru EMA olmayacak miydi"): lines without a reference go
  // to EMA; EMA does not clone, so lines with a reference (a chosen voice, a character) go to VoxCPM2 in voiceCommand.
  const cloned = Boolean(reference) || subs.some((a) => a.reference);
  const enabledEngine = engine ?? (ctx.setting.selectVoiceEngine?.() === 'ema' && ctx.setting.hasEma && !cloned ? 'ema' : null);
  const fast = quick && enabledEngine === 'ema' ? ['--no-check', '--device', 'cpu'] : [];
  const k = ctx.setting.voiceCommand(['--job', jobFile, '--folder', join(folder, 'shots'), '--trial', String(quality.trial), ...quality.args, ...fast], enabledEngine);
  ctx.log(`Voice-over: ${subs.length} lines × ${quality.trial} takes (${quality.name})${reference ? `, reference ${basename(reference)}` : ", the model's own voice"}`);
  await runProcess(k.command, k.args, {
    env: k.env,
    cwd: folder,
    signal: ctx.signal,
    name: 'voice',
    windowsVerbatimArguments: k.windowsVerbatimArguments,
    line: (s) => {
      if (/^generated /.test(s)) {
        generated += 1;
        progress(Math.min(0.9, (generated / total) * 0.85), `take ${generated}/${total}`);
        ctx.log(s);
      } else if (/ error \d/.test(s)) {
        progress(0.95, 'Whisper check');
        ctx.log(s);
      } else if (/Error|Traceback|error/.test(s)) {
        ctx.log(s);
      }
    },
  });
  // Selected takes <folder>/shots/<id>.wav; report.json: the Whisper transcript.
  let report = [];
  try {
    report = JSON.parse(readFileSync(join(folder, 'shots', 'report.json'), 'utf8'));
  } catch {
    /* no report for a single take */
  }
  // A voice with a timbre (user request 09.10.2026: "Bu sesi ema ile üret erkek sesi"): EMA reads in its one voice,
  // then the selected takes take the timbre of a library voice (voice\convert.py, Chatterbox VC) in one run
  const takes = timbre ? 'timbre' : 'shots';
  if (timbre) {
    const input = join(folder, 'timbre-input');
    mkdirSync(input, { recursive: true });
    for (const a of subs) copyFileSync(join(folder, 'shots', `${a.id}.wav`), join(input, `${a.id}.wav`));
    progress(0.92, 'timbre');
    ctx.log(`Timbre: ${basename(timbre)}`);
    const c = ctx.setting.voiceScriptCommand('convert.py', ['--folder', input, timbre, join(folder, takes)]);
    await runProcess(c.command, c.args, { env: c.env, cwd: folder, signal: ctx.signal, name: 'voice-convert', line: (s) => /Error|Traceback/.test(s) && ctx.log(s) });
  }
  const result = {};
  for (const s of lines) {
    const parts = subs.filter((a) => a.parent === s.id);
    const paths = parts.map((p) => join(folder, takes, `${p.id}.wav`));
    for (const y of paths) if (!existsSync(y)) throw new Error(`No voice-over output: ${basename(y)}`);
    let raw = join(folder, `${s.id}_raw.wav`);
    if (paths.length === 1) copyFileSync(paths[0], raw);
    else await mergeWav(ctx, paths, raw);
    const last = join(folder, `${s.id}.wav`);
    if (Math.abs(select.speed - 1) > 0.001) await audioSpeed(ctx.setting.ffmpeg, raw, last, select.speed, { cwd: folder, signal: ctx.signal });
    else renameSync(raw, last);
    if (existsSync(raw) && raw !== last) rmSync(raw, { force: true });
    const r = parts.map((p) => report.find((x) => x.id === p.id)?.selected).filter(Boolean);
    result[s.id] = {
      path: last,
      duration: wavDuration(last),
      heard: r.map((x) => x.heard).join(' ') || null,
      error: r.length ? Math.round((r.reduce((t, x) => t + x.error, 0) / r.length) * 1000) / 1000 : null,
      words: r.length === parts.length ? sceneWords(r.map((x) => x.words), paths, select.speed) : null,
      // the pitch was measured before a timbre changed it
      f0: (() => {
        const f = timbre ? [] : r.map((x) => x.f0).filter((x) => Number.isFinite(x));
        return f.length ? Math.round(f.reduce((t, x) => t + x, 0) / f.length) : null;
      })(),
    };
  }
  progress(1, 'done');
  return result;
}

/**
 * Moves the parts' Whisper word times ([start, end] s) onto the scene audio's timeline: each part shifts by its
 * own length + a 0.25 s gap (mergeWav), and the speed setting divides the times.
 * When a part has no words (Fast quality: no Whisper) null: the subtitles are placed by character ratio.
 */
export function sceneWords(partWords, paths, speed = 1) {
  if (!partWords.length || partWords.some((k) => !Array.isArray(k) || !k.length)) return null;
  const result = [];
  let drift = 0;
  partWords.forEach((words, i) => {
    for (const [b, s] of words) result.push([Math.round(((drift + b) / speed) * 100) / 100, Math.round(((drift + s) / speed) * 100) / 100]);
    drift += (paths.length > 1 ? (wavDuration(paths[i]) ?? 0) + 0.25 : 0);
  });
  return result;
}

/**
 * Has the file written under a temporary name first (same extension: ffmpeg reads the format from it), then moves it
 * into place: steps that count "the file is there, done" (sceneNN.wav, music.mp3) must not take the half file of a
 * process killed while writing as whole. generate(temp) writes.
 */
export async function writeAtomic(output, generate) {
  const temp = output.replace(/(\.[^.\\/]+)$/, '.writing$1');
  rmSync(temp, { force: true });
  await generate(temp);
  renameSync(temp, output);
  return output;
}

/**
 * Joins the line WAVs with space (s) of silence between them; none after the last (scene length = lines + gaps).
 * Film dialogue: the narration and the lines become one scene audio.
 */
export async function mergeWavs(ctx, paths, output, space) {
  const inputs = paths.flatMap((y) => ['-i', y]);
  const filter = `${paths.map((_, i) => `[${i}:a]aresample=24000,aformat=channel_layouts=mono${i < paths.length - 1 ? `,apad=pad_dur=${space}` : ''}[a${i}]`).join(';')};${paths.map((_, i) => `[a${i}]`).join('')}concat=n=${paths.length}:v=0:a=1[o]`;
  await writeAtomic(output, (g) => runFfmpeg(ctx.setting.ffmpeg, ['-y', ...inputs, '-filter_complex', filter, '-map', '[o]', '-ac', '1', '-c:a', 'pcm_s16le', g], { signal: ctx.signal }));
}

/** Joins WAVs with 0.25 s of silence between them. */
async function mergeWav(ctx, paths, output) {
  const inputs = paths.flatMap((y) => ['-i', y]);
  const filter = `${paths.map((_, i) => `[${i}:a]aresample=24000,apad=pad_dur=0.25[a${i}]`).join(';')};${paths.map((_, i) => `[a${i}]`).join('')}concat=n=${paths.length}:v=0:a=1[o]`;
  await writeAtomic(output, (g) => runFfmpeg(ctx.setting.ffmpeg, [...inputs, '-filter_complex', filter, '-map', '[o]', '-ac', '1', '-c:a', 'pcm_s16le', g], { signal: ctx.signal }));
}

/**
 * The reference WAV path for the chosen voice (a description is designed first). Returns { reference, voiceName,
 * voiceId?, referenceText?, lora? }. Description: the designed voice is saved (ctx.job.voiceId); a retry uses the same
 * voice (each try used to add a new voice of the same name and another timbre to the library). A voice designed with
 * VoxCPM also returns its reference text (full clone).
 */
export async function prepareReference(ctx, select, folder) {
  if (select.voice === 'model') return { reference: null, voiceName: "Model's default voice" };
  if (select.voice === 'spec') {
    let id = ctx.job.voiceId && voicePath(ctx.setting.voiceLibrary, ctx.job.voiceId) ? ctx.job.voiceId : null;
    if (id) ctx.log('The voice was already designed in this job; using the same voice.');
    else {
      id = await voiceDesign(ctx, { spec: select.spec, recordName: select.recordName, folder: join(folder, 'design'), lang: select.lang });
      ctx.job.voiceId = id;
      ctx.save();
    }
    return { reference: voicePath(ctx.setting.voiceLibrary, id), voiceName: select.recordName, voiceId: id, referenceText: voiceInfo(ctx.setting.voiceLibrary, id).referenceText ?? null };
  }
  const id = select.voice.slice(4);
  // An own voice: its reference text (full clone) and trained LoRA go too (only VoxCPM2 uses them).
  const b = voiceInfo(ctx.setting.voiceLibrary, id);
  return { reference: voicePath(ctx.setting.voiceLibrary, id), voiceName: b.name ?? id, referenceText: b.referenceText ?? null, lora: voiceLoraPath(ctx.setting.voiceLibrary, id), engine: b.engine ?? null, timbre: voiceTimbre(ctx.setting.voiceLibrary, b), pace: voicePace(b) };
}

/** The frame PNGs of a folder (00001.png ...) in order; helper files such as _skip_0.png do not count. */
export function pngs(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((d) => /^\d+\.png$/i.test(d)).sort();
}

/**
 * On resume, deletes the frames written after the last checkpoint: when an error while a window/part wrote its frames
 * (a full disk, an output timeout) left half of them, the next window was numbered after them and the lips drifted
 * from the voice for good. remaining: the saved frame count (untouched without one). Returns how many were deleted.
 */
export function deleteExtraFrames(folder, remaining) {
  if (!Number.isInteger(remaining) || remaining < 0 || !existsSync(folder)) return 0;
  const max = pngs(folder).slice(remaining);
  for (const d of max) rmSync(join(folder, d), { force: true });
  for (const d of readdirSync(folder).filter((x) => /^_skip_\d+\.png$/.test(x))) rmSync(join(folder, d), { force: true });
  return max.length;
}

export function relativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}
