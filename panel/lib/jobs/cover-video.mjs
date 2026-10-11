/**
 * Song with a cover: an MP4 of a song (or any audio) over a still square cover picture, to send where only videos
 * play (WhatsApp, Instagram, YouTube). The cover is the given picture, else drawn by the image model from the
 * description, else from the song's own style and title. H.264 + AAC, yuv420p, faststart: phones play it as it is.
 * Also reached from Edit audio with a description such as "make an mp4 with a cover" (lib/edit-plan.mjs coverVideo).
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { modelFiles, nodes } from '../graph.mjs';
import { makePreview, measureDuration, runFfmpeg } from '../ffmpeg.mjs';
import { UserError } from '../errors.mjs';
import { jobPrompt } from '../prompt-translate.mjs';
import { recordPath } from './clone.mjs';
import { IMAGE_MODELS, RATIOS, generatorRequired, seed, sourcePath, text } from './common.mjs';

export const name = 'Song with a cover';

/** The video's side (square) and frame rate: a still picture, so the frames cost almost nothing. */
export const SIDE = 1080;
const FPS = 25;

/** The image model that can draw the cover on this machine (Qwen-Image first), else null. */
function coverModel(mod, modelRoot) {
  for (const model of ['qwen', 'flux']) {
    try {
      generatorRequired(mod, IMAGE_MODELS[model].generator, IMAGE_MODELS[model].name, modelRoot);
      return model;
    } catch {}
  }
  return null;
}

/** The song job behind a "job/<id>/<file>" source: its style, title and lyrics, for the cover. */
export function songInfo(outputRoot, source) {
  const part = String(source ?? '').split('/');
  if (part[0] !== 'job' || part.length !== 3) return null;
  try {
    const job = JSON.parse(readFileSync(join(outputRoot, part[1], 'job.json'), 'utf8'));
    const g = job.input ?? {};
    const style = [g.style, g.prompt].find((x) => typeof x === 'string' && x.trim())?.trim() ?? '';
    const lyrics = typeof g.lyrics === 'string' ? g.lyrics.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const title = typeof g.title === 'string' ? g.title.trim() : '';
    return style || lyrics || title ? { style, title, lyrics } : null;
  } catch {
    return null;
  }
}

/** The cover description when none is given: from the song itself. */
export function defaultPrompt(info) {
  const about = info?.lyrics ? `, inspired by the lyrics: ${info.lyrics.slice(0, 200)}` : '';
  return `Album cover art for a ${info?.style || 'music'} song${info?.title ? ` called "${info.title}"` : ''}${about}. Atmospheric, cinematic lighting, rich colours, square composition, no text, no letters.`;
}

export function validate(g, { mod, setting }) {
  const source = String(g.source ?? '').trim();
  if (!source) throw new UserError('Pick the song.');
  recordPath(setting.outputRoot, source);
  const picture = String(g.picture ?? '').trim();
  if (picture) sourcePath(setting.outputRoot, picture);
  else if (!coverModel(mod, setting.modelRoot)) throw new UserError('No image model on this machine to draw the cover; give a cover picture.');
  return {
    source,
    picture: picture || null,
    prompt: text(g.prompt, 'Cover description', { required: false, max: 2000 }) || null,
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    seed: seed(g.seed),
  };
}

export function summary(g) {
  return { title: g.title || g.prompt || 'Song with a cover', detail: `MP4 ${SIDE}×${SIDE} · ${g.picture ? 'given cover' : 'drawn cover'}` };
}

/** Draws the cover with the image model into cover.png. */
async function drawCover(ctx, g) {
  const model = coverModel(ctx.mod, ctx.setting.modelRoot);
  if (!model) throw new UserError('No image model on this machine to draw the cover.');
  const prompt = await jobPrompt(ctx, g.prompt || defaultPrompt(songInfo(ctx.setting.outputRoot, g.source)), 'image');
  const [width, height] = RATIOS['1:1'][model];
  const graph = ctx.mod[IMAGE_MODELS[model].generator]({ text: prompt, seed: g.seed, width, height, prefix: `panel/${ctx.job.id}/cover` });
  ctx.job.modelFiles = modelFiles(graph);
  const outputs = await ctx.runComfy(graph, { stage: 'Drawing the cover', range: [0, 80] });
  const list = images(outputs, nodes(graph, 'SaveImage')[0]);
  if (!list.length) throw new Error('ComfyUI did not return the cover.');
  await ctx.comfy.getOutput(list[0], join(ctx.folder, 'cover.png'));
}

export async function run(ctx) {
  const g = ctx.job.input;
  const k = ctx.folder;
  const ff = ctx.setting.ffmpeg;
  const audio = recordPath(ctx.setting.outputRoot, g.source);
  const cover = join(k, 'cover.png');
  if (!existsSync(cover)) {
    if (g.picture) await runFfmpeg(ff, ['-i', sourcePath(ctx.setting.outputRoot, g.picture), '-frames:v', '1', cover], { cwd: k, signal: ctx.signal });
    else await drawCover(ctx, g);
  }
  if (!g.picture) {
    await makePreview(ff, 'cover.png', 'cover.preview.jpg', { cwd: k, signal: ctx.signal }).catch((e) => ctx.log(`Could not make a preview: ${e.message}`));
    ctx.addOutput({ file: 'cover.png', type: 'image', preview: existsSync(join(k, 'cover.preview.jpg')) ? 'cover.preview.jpg' : undefined, width: SIDE, height: SIDE });
  }

  ctx.progress({ percent: 85, stage: 'Making the video' });
  const duration = await measureDuration(ctx.setting.ffprobe, audio);
  // Any picture fills the square (cropped from the centre); the first audio track only (a video source has one too)
  const fit = `scale=${SIDE}:${SIDE}:force_original_aspect_ratio=increase,crop=${SIDE}:${SIDE},setsar=1,format=yuv420p`;
  const temp = join(k, 'cover.writing.mp4');
  await runFfmpeg(ff, [
    '-loop', '1', '-framerate', String(FPS), '-i', cover, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0', '-vf', fit, '-t', duration.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '20', '-profile:v', 'high', '-level', '4.0', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', temp,
  ], { cwd: k, signal: ctx.signal, totalDuration: duration, progress: (p) => ctx.progress({ percent: 85 + p * 14 }) });
  renameSync(temp, join(k, 'cover.mp4'));
  await makePreview(ff, 'cover.mp4', 'cover-video.preview.jpg', { cwd: k, signal: ctx.signal }).catch(() => {});
  ctx.addOutput({ file: 'cover.mp4', type: 'video', preview: existsSync(join(k, 'cover-video.preview.jpg')) ? 'cover-video.preview.jpg' : undefined, duration: Math.round(duration * 100) / 100, width: SIDE, height: SIDE, fps: FPS, main: true });
}
