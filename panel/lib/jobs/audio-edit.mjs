/**
 * Edit audio: edits the given audio (or a video's audio) by an instruction. The text model turns the instruction into
 * a list of operations (lib/edit-plan.mjs) and the steps run one after another with ffmpeg; "changeVoice" uses the
 * Chatterbox voice conversion (voice\convert.py). The plan is saved in the job: a retry does not ask again.
 */
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run as runProcess } from '../process.mjs';
import { streams, runFfmpeg, measureDuration } from '../ffmpeg.mjs';
import { UserError } from '../errors.mjs';
import { plan } from '../edit-plan.mjs';
import { hasText } from '../text-model.mjs';
import { listVoices, voicePath } from '../voices.mjs';
import { text, voiceExtractionError } from './common.mjs';
import { recordPath } from './clone.mjs';

export const name = 'Edit audio';

export function validate(g, { setting }) {
  if (!hasText() && !setting.editPlan) throw new UserError('The instruction interpreter (text model) is not on this machine; audio editing is unavailable.');
  const source = String(g.source ?? '').trim();
  if (!source) throw new UserError('Pick the audio to edit.');
  recordPath(setting.outputRoot, source);
  return { source, instruction: text(g.instruction, 'Instruction', { max: 2000 }) };
}

export function summary(g) {
  return { title: g.instruction, detail: 'Audio editing by instruction' };
}

/** A step's ffmpeg audio filter (not changeVoice). duration: the length at that point. */
function filter(a, duration) {
  switch (a.operation) {
    case 'speed': return `atempo=${a.ratio}`;
    case 'pitch': {
      const k = 2 ** (a.semitones / 12);
      // Brought to 44.1 kHz first: after a voice change (24 kHz) asetrate used the wrong base and sped it up 1.84 times
      return `aresample=44100,asetrate=44100*${k.toFixed(5)},aresample=44100,atempo=${(1 / k).toFixed(5)}`;
    }
    case 'clean': return 'highpass=f=70,lowpass=f=14000,afftdn=nf=-25';
    case 'trimSilence': return 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15:stop_periods=-1:stop_duration=0.7:stop_threshold=-45dB';
    case 'normalize': return 'loudnorm=I=-16:TP=-1.5:LRA=11';
    case 'volume': return `volume=${a.factor}`;
    case 'echo': return `aecho=0.8:0.85:${Math.round(40 + a.amount * 80)}|${Math.round(80 + a.amount * 140)}:${(0.2 + a.amount * 0.3).toFixed(2)}|${(0.1 + a.amount * 0.2).toFixed(2)}`;
    case 'fade': {
      const s = [];
      if (a.in > 0) s.push(`afade=t=in:d=${a.in}`);
      if (a.out > 0) s.push(`afade=t=out:st=${Math.max(0, duration - a.out).toFixed(2)}:d=${a.out}`);
      return s.join(',') || 'anull';
    }
    default: return null;
  }
}

export async function run(ctx) {
  const g = ctx.job.input;
  const source = recordPath(ctx.setting.outputRoot, g.source);
  const ff = ctx.setting.ffmpeg;
  const k = ctx.folder;

  // 0. The source -> a 44.1 kHz WAV (only the audio track of a video)
  const original = join(k, 'step_00.wav');
  if (!existsSync(original)) {
    ctx.progress({ percent: 2, stage: 'Preparing audio' });
    await runFfmpeg(ff, ['-i', source, '-vn', '-map', '0:a:0', '-ar', '44100', '-c:a', 'pcm_s16le', original], { cwd: k, signal: ctx.signal }).catch((e) => {
      throw voiceExtractionError(e);
    });
  }

  // 1. The plan (text model); a retry uses the saved plan
  if (!ctx.job.plan) {
    ctx.progress({ percent: 5, stage: 'Understanding the instruction' });
    const duration = await measureDuration(ctx.setting.ffprobe, original);
    const a = await streams(ctx.setting.ffprobe, original).catch(() => ({ streams: [] }));
    const voices = listVoices(ctx.setting.voiceLibrary).map((s) => ({ id: s.id, name: s.name }));
    const info = { duration, voices, summary: { durationSec: Math.round(duration * 10) / 10, channel: a.streams[0]?.channels ?? null } };
    const planner = ctx.setting.editPlan ?? plan;
    ctx.job.plan = await planner({ type: 'voice', instruction: g.instruction, info, signal: ctx.signal });
    ctx.save();
  }
  const plan = ctx.job.plan;
  ctx.log(`Plan: ${plan.description || plan.steps.map((a) => a.operation).join(', ')}`);
  if (plan.impossible) ctx.log(`Not possible: ${plan.impossible}`);

  // 2. The steps in order
  let current = original;
  for (const [i, a] of plan.steps.entries()) {
    const target = join(k, `step_${String(i + 1).padStart(2, '0')}.wav`);
    ctx.progress({ percent: 10 + (i / plan.steps.length) * 85, stage: `Editing (${i + 1}/${plan.steps.length})`, detail: a.operation });
    if (!existsSync(target)) {
      // Written under a temporary name and renamed when done: a WAV cut off halfway does not count as finished
      const temp = target.replace(/\.wav$/, '.writing.wav');
      rmSync(temp, { force: true });
      if (a.operation === 'cut') {
        await runFfmpeg(ff, ['-i', current, '-ss', String(a.start), ...(a.end != null ? ['-to', String(a.end)] : []), '-c:a', 'pcm_s16le', temp], { cwd: k, signal: ctx.signal });
      } else if (a.operation === 'changeVoice') {
        const timbre = voicePath(ctx.setting.voiceLibrary, a.voice);
        if (!timbre) throw new UserError('Target voice not found in the library.');
        await ctx.flushVoiceForGpu();
        const command = ctx.setting.voiceScriptCommand('convert.py', [current, timbre, temp]);
        await runProcess(command.command, command.args, { env: command.env, cwd: k, signal: ctx.signal, name: 'voice-convert', line: (s) => /Error|Traceback/.test(s) && ctx.log(s) });
        if (!existsSync(temp)) throw new Error('Voice conversion produced no output.');
      } else {
        const duration = await measureDuration(ctx.setting.ffprobe, current);
        await runFfmpeg(ff, ['-i', current, '-af', filter(a, duration), '-ar', '44100', '-c:a', 'pcm_s16le', temp], { cwd: k, signal: ctx.signal });
      }
      renameSync(temp, target);
    }
    current = target;
  }
  copyFileSync(current, join(k, 'edited.wav'));
  for (const d of readdirSync(k)) if (/^step_\d+\.wav$/.test(d)) rmSync(join(k, d), { force: true }); // the in-between steps are not needed
  const duration = await measureDuration(ctx.setting.ffprobe, join(k, 'edited.wav'));
  ctx.addOutput({ file: 'edited.wav', type: 'voice', duration: Math.round(duration * 100) / 100, main: true });
  if (plan.impossible) ctx.job.warning = `Not possible: ${plan.impossible}`;
}
