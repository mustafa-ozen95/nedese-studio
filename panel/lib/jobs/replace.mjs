/**
 * Replace a person: the person in a video replaced by the person in a photo (Wan 2.2 Animate, replacement mode; the
 * model module's replaceJob). The video is made window by window at 16 fps (~400k pixels, its own shape): each window
 * after the first starts with the previous window's last 5 frames (continue_motion), so the motion and the new person
 * run on without a jump. The background, the camera and the other people stay; the largest person of the first frame
 * is replaced. The video's own sound is put back.
 * A RETRY RESUMES WHERE IT LEFT OFF: a finished window (checkpoint.json) is not made again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { nodes } from '../graph.mjs';
import { runFfmpeg, streams, makePreview } from '../ffmpeg.mjs';
import { UserError } from '../errors.mjs';
import { text, seed, sourcePath, generatorRequired, deleteExtraFrames, pngs } from './common.mjs';
import { recordPath } from './clone.mjs';

export const name = 'Replace a person';
const VIDEO_EXTENSION = /\.(mp4|mov|mkv|webm|avi|m4v|3gp)$/i;
export const REPLACE = { fps: 16, window: 77, motion: 5, pixels: 832 * 480, longest: 60 };

/** The size the video is made at: its own shape, ~400k pixels, both sides a multiple of 16. */
export function replaceSize(width, height) {
  const k = Math.sqrt(REPLACE.pixels / (width * height));
  const side = (n) => Math.max(256, Math.min(1280, Math.round((n * k) / 16) * 16));
  return { width: side(width), height: side(height) };
}

/**
 * The windows over `total` frames: [{ no, start, length }]. The first starts at 0; each later one 5 frames (the motion
 * frames) before the end of the previous and gives length - 5 new frames. length is 4n + 1 (Wan); the last window runs
 * past the end with the last frame repeated, the extra frames are dropped.
 */
export function replaceWindows(total) {
  const list = [];
  let done = 0;
  while (done < total) {
    const first = !list.length;
    const start = first ? 0 : done - REPLACE.motion;
    let length = Math.min(REPLACE.window, total - start);
    length = Math.max(first ? 5 : 9, Math.ceil((length - 1) / 4) * 4 + 1);
    list.push({ no: list.length + 1, start, length });
    done = start + length;
  }
  return list;
}

export function validate(g, { setting, mod }) {
  generatorRequired(mod, 'replaceJob', 'Replacing a person', setting?.modelRoot);
  const source = String(g.source ?? '').trim();
  if (!source) throw new UserError('Pick the video whose person is replaced.');
  if (!VIDEO_EXTENSION.test(recordPath(setting.outputRoot, source))) throw new UserError('Pick a video file (MP4, MOV, MKV, WebM…).');
  const picture = String(g.picture ?? '').trim();
  if (!picture) throw new UserError('Pick the photo of the person who takes their place.');
  sourcePath(setting.outputRoot, picture);
  return {
    source,
    picture,
    // English (the model's language): what happens in the video with the new person; the motion comes from the video
    prompt: text(g.prompt, 'Prompt', { required: false, max: 500 }) || 'a person moving naturally, realistic, consistent identity',
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    seed: seed(g.seed),
  };
}

export function summary(g) {
  return { title: g.title || 'Person replaced', detail: 'Wan 2.2 Animate · the person from the photo' };
}

export async function run(ctx) {
  const g = ctx.job.input;
  const source = recordPath(ctx.setting.outputRoot, g.source);
  const photo = sourcePath(ctx.setting.outputRoot, g.picture);
  const ff = (a, o = {}) => runFfmpeg(ctx.setting.ffmpeg, a, { cwd: ctx.folder, signal: ctx.signal, ...o });
  const info = await streams(ctx.setting.ffprobe, source);
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new UserError('No video found in the file.');
  if (info.duration > REPLACE.longest) throw new UserError(`The video is ${Math.round(info.duration)} s; a person can be replaced in at most ${REPLACE.longest} s. Cut it first (Edit: "take the first 20 seconds").`);
  // a phone video stands upright through its rotation: the frames come out turned, so the shape follows them
  const turned = [90, 270].includes(Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? 0)) % 360);
  const { width, height } = replaceSize(turned ? v.height : v.width, turned ? v.width : v.height);

  // 1. The frames at 16 fps in the made size (cropped to fill), and the photo letterboxed to it (the model crops to fill)
  const work = join(ctx.folder, 'work');
  const sourceFolder = join(work, 'source');
  const targetFolder = join(work, 'frames');
  mkdirSync(sourceFolder, { recursive: true });
  mkdirSync(targetFolder, { recursive: true });
  if (!existsSync(join(work, 'source.done'))) {
    ctx.progress({ percent: 2, stage: 'Reading the video' });
    for (const d of pngs(sourceFolder)) rmSync(join(sourceFolder, d), { force: true });
    await ff(['-i', source, '-vf', `fps=${REPLACE.fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`, join(sourceFolder, '%05d.png')], { totalDuration: info.duration });
    writeFileSync(join(work, 'source.done'), '');
  }
  const frames = pngs(sourceFolder);
  if (!frames.length) throw new UserError('No frames could be read from the video.');
  const reference = join(work, 'person.png');
  if (!existsSync(reference)) await ff(['-i', photo, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white`, '-frames:v', '1', reference]);

  // 2. The windows (a retry continues after the last finished one)
  const windows = replaceWindows(frames.length);
  const statusPath = join(work, 'checkpoint.json');
  let status = null;
  try {
    status = JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch {
    /* none */
  }
  const signature = JSON.stringify({ frames: frames.length, width, height });
  if (status?.signature !== signature) {
    for (const d of pngs(targetFolder)) rmSync(join(targetFolder, d), { force: true });
    status = { signature, window: 0, frame: 0 };
    writeFileSync(statusPath, JSON.stringify(status), 'utf8');
  }
  const deleted = deleteExtraFrames(targetFolder, status.frame);
  if (deleted) ctx.log(`${deleted} frames removed from the unfinished window (resuming where it left off).`);
  ctx.log(`${frames.length} frames (${(frames.length / REPLACE.fps).toFixed(1)} s) at ${width}x${height}, ${windows.length} window${windows.length > 1 ? 's' : ''}.`);
  const namePrefix = `panel_${ctx.job.id}_`;
  const picture = await ctx.comfy.load(reference, `${namePrefix}person.png`);
  for (const w of windows.slice(status.window)) {
    const startedAt = Date.now();
    // the window's frames as a video for ComfyUI (the last frame repeated past the end)
    const list = join(work, `w${w.no}.txt`);
    writeFileSync(list, Array.from({ length: w.length }, (_, i) => `file '${join(sourceFolder, frames[Math.min(w.start + i, frames.length - 1)]).replaceAll('\\', '/')}'\nduration ${1 / REPLACE.fps}`).join('\n'), 'utf8');
    const clipPath = join(work, `w${w.no}.mp4`);
    await ff(['-f', 'concat', '-safe', '0', '-i', list, '-frames:v', String(w.length), '-r', String(REPLACE.fps), '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', clipPath]);
    const clip = await ctx.comfy.load(clipPath, `${namePrefix}w${w.no}.mp4`);
    const existing = pngs(targetFolder);
    const motions = w.no === 1 ? null : await Promise.all(existing.slice(-REPLACE.motion).map((d, j) => ctx.comfy.load(join(targetFolder, d), `${namePrefix}w${w.no}_m${j + 1}.png`)));
    const graph = ctx.mod.replaceJob({ clip, picture, motions, text: g.prompt, seed: g.seed, width, height, frame: w.length, prefix: `panel/${ctx.job.id}/w${w.no}` });
    const record = nodes(graph, 'SaveImage')[0];
    const [p0, p1] = [5 + (90 * (w.no - 1)) / windows.length, 5 + (90 * w.no) / windows.length];
    const outputs = await ctx.runComfy(graph, { stage: `Replacing the person ${w.no}/${windows.length}`, range: [p0, p1] });
    const got = images(outputs, record);
    if (!got.length) throw new Error('ComfyUI did not return the frames of the window.');
    let no = existing.length;
    for (const c of got) {
      no += 1;
      await ctx.comfy.getOutput(c, join(targetFolder, `${String(no).padStart(5, '0')}.png`));
    }
    status.window = w.no;
    status.frame = no;
    writeFileSync(statusPath, JSON.stringify(status), 'utf8');
    rmSync(clipPath, { force: true });
    const seconds = (Date.now() - startedAt) / 1000;
    ctx.log(`Window ${w.no}/${windows.length} (frames ${w.start + 1}-${w.start + w.length}): ${Math.round(seconds)} s`);
    ctx.measure('replace', seconds / ((w.no === 1 ? w.length : w.length - REPLACE.motion) / REPLACE.fps));
  }

  // 3. The video with its own sound (the last window ran past the end: its extra frames go)
  ctx.progress({ percent: 96, stage: 'Putting the video together' });
  for (const d of pngs(targetFolder).slice(frames.length)) rmSync(join(targetFolder, d), { force: true });
  const count = pngs(targetFolder).length;
  const hasVoice = info.streams.some((s) => s.codec_type === 'audio');
  const temp = join(ctx.folder, 'replaced.writing.mp4');
  await ff([
    '-framerate', String(REPLACE.fps), '-i', join(targetFolder, '%05d.png'), ...(hasVoice ? ['-i', source] : []),
    '-map', '0:v', ...(hasVoice ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k'] : []),
    '-t', String(count / REPLACE.fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temp,
  ]);
  renameSync(temp, join(ctx.folder, 'replaced.mp4'));
  await makePreview(ctx.setting.ffmpeg, 'replaced.mp4', 'replaced.preview.jpg', { cwd: ctx.folder, signal: ctx.signal }).catch(() => {});
  ctx.addOutput({ file: 'replaced.mp4', type: 'video', preview: existsSync(join(ctx.folder, 'replaced.preview.jpg')) ? 'replaced.preview.jpg' : undefined, duration: Math.round((count / REPLACE.fps) * 100) / 100, width, height, fps: REPLACE.fps, main: true });
  rmSync(sourceFolder, { recursive: true, force: true });
}
