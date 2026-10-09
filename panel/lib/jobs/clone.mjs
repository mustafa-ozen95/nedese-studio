/**
 * Kendi sesim: kullanicinin kaydindan (video ya da ses, her format) ses klonu.
 *  1. voice\clone\prepare.py (Whisper): recording -> clean parts + training list + reference (8-16 s) and its text
 *  2. The voice is added to the library (ownVoice + referenceText): usable at once ("full clone")
 *  3. When asked, voice\clone\train.py: VoxCPM2 LoRA fine-tune (the recording needs at least 1 min of speech) ->
 *     library\<id>.lora; loaded automatically whenever that voice speaks
 *  4. A sample sentence is read in that voice (to listen to the result)
 * GPU: does not run together with ComfyUI (flushVoiceForGpu).
 */
import { cpSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { fineSetting } from '../fine-settings.mjs';
import { extname, join, resolve, sep } from 'node:path';
import { run as runProcess } from '../process.mjs';
import { UserError } from '../errors.mjs';
import { UPLOAD_FOLDER } from '../settings.mjs';
import { updateVoiceInfo, addVoice } from '../voices.mjs';
import { yes, text, number, speak, normalizeSource } from './common.mjs';

export const name = 'My voice';

/** Formats accepted as a recording (ffmpeg takes the audio track). */
export const RECORD_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wma', '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.3gp'];
const SAFE = /^[\w.-]+$/;
const EXAMPLE_TEXT = 'Merhaba, bu benim sesim. Artık yazdığım her şeyi bu sesle okuyabilirim.';

export function recordPath(outputRoot, ref) {
  const part = normalizeSource(ref).split('/');
  let path = null;
  if (part[0] === 'upload' && part.length === 2 && SAFE.test(part[1])) path = join(outputRoot, UPLOAD_FOLDER, part[1]);
  if (part[0] === 'job' && part.length === 3 && part.slice(1).every((p) => SAFE.test(p))) path = join(outputRoot, part[1], part[2]);
  if (!path) throw new UserError('Recording file is invalid.');
  const full = resolve(path);
  if (!full.startsWith(resolve(outputRoot) + sep)) throw new UserError('Recording file is outside the panel folder.');
  if (!RECORD_EXTENSIONS.includes(extname(full).toLowerCase())) throw new UserError(`Unsupported recording format (${extname(full) || 'no extension'}).`);
  if (!existsSync(full)) throw new UserError('Recording file not found (it may have been deleted).');
  return full;
}

export function validate(g, { setting }) {
  if (!setting.hasClone) throw new UserError('Voice cloning not installed (voice\\clone or the voice environment is missing; setup.bat).');
  const records = Array.isArray(g.records) ? g.records : g.record ? [g.record] : [];
  if (!records.length) throw new UserError('Upload at least one recording (video or audio).');
  if (records.length > 50) throw new UserError('At most 50 recordings.');
  const train = g.train === undefined ? true : yes(g.train);
  if (train && !setting.hasTraining) throw new UserError('Voice training not installed (no VoxCPM2 environment); try with "train" off.');
  return {
    name: text(g.name, 'Voice name', { max: 60 }),
    records: records.map((k) => (recordPath(setting.outputRoot, k), String(k).trim())),
    train,
    // 0: from the amount of data (train.py: 300-1000)
    step: number(g.step, 'Training steps', { min: 0, max: 5000, full: true, defaultValue: 0 }),
    lang: 'tr',
  };
}

export function summary(g) {
  return { title: g.name, detail: `${g.records.length} recording${g.records.length > 1 ? 's' : ''}${g.train ? ' · trained' : ' · quick clone'}` };
}

/** Runs a voice\clone script; passes its "progress <percent> <text>" lines to the panel. */
async function script(ctx, stage, args, { startedAt, last }) {
  const k = ctx.setting.cloneCommand(stage, args);
  let lastLines = [];
  await runProcess(k.command, k.args, {
    env: k.env,
    cwd: ctx.folder,
    signal: ctx.signal,
    name: `clone-${stage}`,
    line: (s) => {
      lastLines = [...lastLines, s].slice(-12);
      const m = /^progress (\d+) (.*)$/.exec(s);
      if (m) {
        ctx.progress({ percent: startedAt + (Number(m[1]) / 100) * (last - startedAt), stage: stage === 'train' ? 'Training' : 'Preparing recording', detail: m[2] });
        ctx.log(m[2]);
      } else if (/^ERROR:|Error|Traceback/.test(s)) ctx.log(s);
    },
  }).catch((e) => {
    const error = lastLines.find((s) => s.startsWith('ERROR:'));
    throw error ? new UserError(error.slice(6).trim()) : e;
  });
}

export async function run(ctx) {
  const g = ctx.job.input;
  await ctx.flushVoiceForGpu();
  const data = join(ctx.folder, 'ready');
  const records = g.records.map((k) => recordPath(ctx.setting.outputRoot, k));
  const trainingEnd = g.train ? 92 : 30;

  // 1. Prepare (skipped on a retry when summary.json is there)
  if (!existsSync(join(data, 'summary.json'))) await script(ctx, 'prepare', ['--output', data, ...records], { startedAt: 2, last: g.train ? 20 : 60 });
  const o = JSON.parse(readFileSync(join(data, 'summary.json'), 'utf8'));
  ctx.log(`Recording ${o.recordSec} s, speech ${o.speechSec} s, ${o.parts} segments; reference ${o.referenceSec} s.`);

  // 2. Add to the library (usable at once)
  if (!ctx.job.voiceId) {
    ctx.job.voiceId = addVoice(ctx.setting.voiceLibrary, {
      name: g.name,
      source: join(data, 'reference.wav'),
      description: `Own voice: from ${Math.round(o.speechSec)} s of recording`,
      extra: { ownVoice: true, referenceText: o.referenceText, speechSec: o.speechSec },
    });
    ctx.save();
    ctx.log(`Voice added to library: ${g.name} (${ctx.job.voiceId})`);
  }
  const id = ctx.job.voiceId;

  // 3. Training (optional; skipped with too little recording, the quick clone stays)
  if (g.train) {
    if (!o.enoughForTraining) {
      ctx.log(`Training skipped: at least ${o.trainingMinSec} s of speech required, the recording has ${o.speechSec} s. Using quick clone.`);
      ctx.job.warning = `Recording too short for training (${Math.round(o.speechSec)} s; at least ${o.trainingMinSec} s). Voice added as a quick clone.`;
      // The summary said "trained" when the job was queued; show what was really done.
      ctx.job.summary = { ...ctx.job.summary, detail: `${g.records.length} recording${g.records.length > 1 ? 's' : ''} · quick clone (recording too short)` };
    } else {
      const loraTarget = join(ctx.setting.voiceLibrary, `${id}.lora`);
      if (!existsSync(loraTarget)) {
        const args = ['--data', data];
        if (g.step) args.push('--step', String(g.step));
        // Fine setting voiceCloneBatch off (large card): the original batch setting of VoxCPM
        if (!fineSetting('voiceCloneBatch')) args.push('--large-batch');
        await script(ctx, 'train', args, { startedAt: 20, last: trainingEnd });
        // Only weights + settings (optimizer/scheduler are for resuming training, hundreds of MB).
        cpSync(join(data, 'lora', 'latest'), loraTarget, { recursive: true, filter: (k) => !/(optimizer|scheduler)\.pth$|training_state\.json$/.test(k) });
        updateVoiceInfo(ctx.setting.voiceLibrary, id, { lora: `${id}.lora` });
        ctx.log('Trained model linked to the voice.');
      }
    }
  }

  // 4. Sample: one sentence in the new voice (reference + text + the LoRA when there is one)
  ctx.progress({ percent: trainingEnd + 1, stage: 'Reading sample', detail: EXAMPLE_TEXT });
  const result = await speak(ctx, {
    lines: [{ id: 'example', text: EXAMPLE_TEXT }],
    reference: join(ctx.setting.voiceLibrary, `${id}.wav`),
    referenceText: o.referenceText,
    lora: existsSync(join(ctx.setting.voiceLibrary, `${id}.lora`)) ? join(ctx.setting.voiceLibrary, `${id}.lora`) : null,
    select: { lang: 'tr', quality: 'checked', exaggeration: 0.5, cfg: 0.5, speed: 1 },
    folder: join(ctx.folder, 'example'),
    progress: (ratio, detail) => ctx.progress({ percent: trainingEnd + 1 + ratio * (99 - trainingEnd - 1), stage: 'Reading sample', detail }),
  });
  renameSync(result.example.path, join(ctx.folder, 'example.wav'));
  ctx.addOutput({ file: 'example.wav', type: 'voice', duration: Math.round(result.example.duration * 100) / 100, heard: result.example.heard, error: result.example.error });
  ctx.job.voiceName = g.name;
}
