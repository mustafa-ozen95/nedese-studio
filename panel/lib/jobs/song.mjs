/**
 * Sarki duzenleme (remiks / cover): verilen sarkiyi yeni tarzla (istenirse yeni sozlerle) yeniden
 * yorumlar. ACE-Step 1.5 Turbo audio2audio (araclar\comfy.mjs sarkiDuzenleIsi): sarki kodlanir,
 * "degisim gucu" kadari yeniden uretilir. Az = ses/enstruman degisir, melodi kalir; cok = serbest yorum.
 */
import { join } from 'node:path';
import { voiceOutputs } from '../comfy-client.mjs';
import { nodes, modelFiles } from '../graph.mjs';
import { runFfmpeg, measureDuration } from '../ffmpeg.mjs';
import { UserError } from '../errors.mjs';
import { text, musicPath, number, choice, voiceExtractionError, seed, generatorRequired } from './common.mjs';
import { MUSIC_LONGEST, musicRequired } from './music.mjs';
import { jobPrompt } from '../prompt-translate.mjs';

export const name = 'Edit song';

/** Degisim gucu hazirlari (KSampler denoise). */
export const STRENGTHS = { little: 0.35, medium: 0.5, much: 0.7 };

export function validate(g, { mod, setting }) {
  musicRequired(mod, setting);
  generatorRequired(mod, 'songEditJob', 'Song editing');
  const source = String(g.source ?? '').trim();
  if (!source) throw new UserError('Pick the song to edit.');
  musicPath(setting.outputRoot, source);
  return {
    source,
    style: text(g.style, 'New style', { max: 1000 }),
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    lyrics: text(g.lyrics, 'Lyrics', { required: false, max: 4000 }),
    strength: choice(g.strength, 'Change', Object.keys(STRENGTHS), 'medium'),
    bpm: number(g.bpm, 'Tempo (BPM)', { min: 40, max: 220, full: true, defaultValue: 110 }),
    lang: choice(g.lang, 'Lyrics language', ['tr', 'en'], 'tr'),
    seed: seed(g.seed),
  };
}

export function summary(g) {
  return { title: g.title || g.style, detail: `Change: ${{ little: 'little', medium: 'medium', much: 'a lot' }[g.strength]}${g.lyrics ? ' · new lyrics' : ''}` };
}

export async function run(ctx) {
  const g = ctx.job.input;
  const path = musicPath(ctx.setting.outputRoot, g.source);
  const duration = Math.round(await measureDuration(ctx.setting.ffprobe, path));
  if (duration > MUSIC_LONGEST) throw new UserError(`Song is ${Math.round(duration / 60)} min; at most ${MUSIC_LONGEST / 60} min can be edited. Shorten it first.`);
  // Video (MP4…) ya da her ses bicimi: once 44,1 kHz stereo WAV (ComfyUI LoadAudio her bicimi okumaz).
  const wav = join(ctx.folder, 'source.wav');
  await runFfmpeg(ctx.setting.ffmpeg, ['-i', path, '-vn', '-map', '0:a:0', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', wav], { cwd: ctx.folder, signal: ctx.signal }).catch((e) => {
    throw voiceExtractionError(e);
  });
  const voice = await ctx.comfy.load(wav, `panel_${ctx.job.id}_s.wav`);
  // English style tags like the music job (ACE-Step was trained with them); a Turkish style went through as written (10.10.2026)
  const style = await jobPrompt(ctx, g.style, 'music', { field: 'styleEnglish', translate: g.translate !== false });
  const graph = ctx.mod.songEditJob({ voice, style, lyrics: g.lyrics, duration: Math.max(5, duration), seed: g.seed, bpm: g.bpm, language: g.lang, strength: STRENGTHS[g.strength], prefix: `panel/${ctx.job.id}/song` });
  ctx.job.modelFiles = modelFiles(graph);
  const record = nodes(graph, 'SaveAudioMP3')[0];
  const startedAt = Date.now();
  const outputs = await ctx.runComfy(graph, { stage: 'Re-interpreting the song', range: [0, 95] });
  const list = voiceOutputs(outputs, record);
  if (!list.length) throw new Error('ComfyUI did not return the song.');
  await ctx.comfy.getOutput(list[0], join(ctx.folder, 'song.mp3'));
  ctx.addOutput({ file: 'song.mp3', type: 'voice', duration, main: true });
  ctx.measure('music', (Date.now() - startedAt) / 1000 / duration);
  ctx.log(`Song: ${duration} s, ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
}
