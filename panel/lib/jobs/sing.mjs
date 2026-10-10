/**
 * Sing in a voice: an existing song sung again in a library voice (an own voice, a designed or uploaded one); the
 * melody, words and instruments stay. YingMusic-SVC (voice\sing.py, voice\svc): its BS-RoFormer separator splits the
 * lead vocal, backing vocals and instrumental, the lead vocal is converted to the voice (zero-shot, from the voice's
 * library WAV), then ffmpeg mixes it back with the rest. A retry continues: the stems and converted vocal stay in work\.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run as runProcess } from '../process.mjs';
import { runFfmpeg, measureDuration } from '../ffmpeg.mjs';
import { UserError } from '../errors.mjs';
import { voicePath, voiceInfo } from '../voices.mjs';
import { text, musicPath, voiceExtractionError, yes } from './common.mjs';
import { MUSIC_LONGEST } from './music.mjs';

export const name = 'Sing in a voice';

export function validate(g, { setting }) {
  if (!setting.hasSing) throw new UserError('Singing in a voice is not installed: download "Singing voice (YingMusic-SVC)" in Settings > Models.');
  const source = String(g.source ?? '').trim();
  if (!source) throw new UserError('Pick the song.');
  musicPath(setting.outputRoot, source);
  const voice = String(g.voice ?? '').trim();
  if (!voice.startsWith('ref:')) throw new UserError('Pick the voice to sing in from the voice library.');
  if (!voicePath(setting.voiceLibrary, voice.slice(4))) throw new UserError('The selected voice is not in the library (it may have been deleted).');
  return {
    source,
    voice,
    // shown on the job card (the summary has no access to the library)
    voiceName: voiceInfo(setting.voiceLibrary, voice.slice(4)).name ?? voice.slice(4),
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    // Octave change in semitones (-12, 0, 12); empty: chosen from the two voices (a man singing a woman's song an octave
    // lower). Only whole octaves: the instrumental is not moved, so any other shift would sing out of key.
    shift: octave(g.shift),
    backing: g.backing === undefined ? true : yes(g.backing),
  };
}

function octave(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (![-12, 0, 12].includes(n)) throw new UserError('Octave: -12 (an octave lower), 0 (as sung) or 12 (an octave higher).');
  return n;
}

const OCTAVE_NAMES = { '-12': 'an octave lower', 0: 'as sung', 12: 'an octave higher' };

export function summary(g) {
  return { title: g.title || `Sung by ${g.voiceName}`, detail: `${g.shift == null ? 'Octave: automatic' : `Octave: ${OCTAVE_NAMES[g.shift]}`}${g.backing ? ' · backing vocals too' : ''}` };
}

export async function run(ctx) {
  const g = ctx.job.input;
  const path = musicPath(ctx.setting.outputRoot, g.source);
  const reference = voicePath(ctx.setting.voiceLibrary, g.voice.slice(4));
  if (!reference) throw new UserError('The selected voice is not in the library (it may have been deleted).');
  const duration = await measureDuration(ctx.setting.ffprobe, path);
  if (duration > MUSIC_LONGEST) throw new UserError(`Song is ${Math.round(duration / 60)} min; at most ${MUSIC_LONGEST / 60} min can be sung. Shorten it first.`);
  const work = join(ctx.folder, 'work');
  mkdirSync(work, { recursive: true });
  const song = join(work, 'song.wav');
  if (!existsSync(song)) {
    ctx.progress({ percent: 2, stage: 'Preparing the song' });
    const temp = join(work, 'song.writing.wav');
    await runFfmpeg(ctx.setting.ffmpeg, ['-y', '-i', path, '-vn', '-map', '0:a:0', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', temp], { cwd: work, signal: ctx.signal }).catch((e) => {
      throw voiceExtractionError(e);
    });
    renameSync(temp, song);
  }

  await ctx.flushVoiceForGpu();
  const startedAt = Date.now();
  ctx.progress({ percent: 5, stage: 'Separating the vocals' });
  const args = [song, reference, work, ...(g.shift == null ? [] : ['--shift', String(g.shift)]), ...(g.backing ? ['--backing'] : [])];
  const command = ctx.setting.singCommand(args);
  await runProcess(command.command, command.args, {
    env: command.env,
    cwd: work,
    signal: ctx.signal,
    name: 'sing',
    line: (s) => {
      if (/^Separating/.test(s)) ctx.progress({ percent: 8, stage: 'Separating the vocals' });
      else if (/^Singing vocals/.test(s)) ctx.progress({ percent: 40, stage: 'Singing in the new voice' });
      else if (/^Singing backing/.test(s)) ctx.progress({ percent: 75, stage: 'Singing the backing vocals' });
      else if (/^automatic pitch shift/.test(s)) ctx.log(`Octave: moved ${s.match(/-?\d+/)?.[0] ?? 0} semitones`);
      else if (/Error|Traceback/.test(s)) ctx.log(s);
    },
  });
  const sung = join(work, 'sung.wav');
  if (!existsSync(sung)) throw new Error('The singing voice conversion produced no output.');
  const backing = join(work, g.backing ? 'sung-backing.wav' : 'backing.wav');

  // The converted vocal (mono) in the middle, the backing vocals and instrumental as they were
  ctx.progress({ percent: 95, stage: 'Mixing' });
  const output = join(ctx.folder, 'song.mp3');
  const temp = join(ctx.folder, 'song.writing.mp3');
  rmSync(temp, { force: true });
  await runFfmpeg(ctx.setting.ffmpeg, ['-y', '-i', join(work, 'instrumental.wav'), '-i', backing, '-i', sung, '-filter_complex',
    '[1:a]aformat=channel_layouts=stereo[b];[2:a]aformat=channel_layouts=stereo[v];[0:a][b][v]amix=inputs=3:normalize=0:duration=first,alimiter=limit=0.97[o]',
    '-map', '[o]', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '0', temp], { cwd: ctx.folder, signal: ctx.signal });
  renameSync(temp, output);
  await runFfmpeg(ctx.setting.ffmpeg, ['-y', '-i', sung, '-c:a', 'libmp3lame', '-q:a', '0', join(ctx.folder, 'vocal.mp3')], { cwd: ctx.folder, signal: ctx.signal });
  const seconds = Math.round(duration);
  ctx.addOutput({ file: 'song.mp3', type: 'voice', duration: seconds, main: true });
  ctx.addOutput({ file: 'vocal.mp3', type: 'voice', duration: seconds });
  ctx.measure('sing', (Date.now() - startedAt) / 1000 / Math.max(1, duration));
  ctx.log(`Song: ${seconds} s, sung in ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
}
