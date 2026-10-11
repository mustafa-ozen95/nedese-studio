/**
 * Replace a person: the person in a video replaced by the person in a photo (Wan 2.2 Animate, replacement mode; the
 * model module's replaceJob). The video is made window by window at 16 fps (~400k pixels, its own shape): each window
 * after the first starts with the previous window's last 5 frames (continue_motion), so the motion and the new person
 * run on without a jump, and follows the person the previous window followed (the prep node's boxes). The background,
 * the camera and the other people stay. One photo: the largest person of the first frame is replaced. Several photos
 * (people, up to 4): they replace the people of the first frame from left to right, one pass each (the model replaces
 * one person at a time; each pass works on the previous pass's frames). area "face": only the face is repainted (a face
 * swap: the body, clothes and hair of the video stay). The video's own sound is put back.
 * A RETRY RESUMES WHERE IT LEFT OFF: a finished window or pass (checkpoint.json) is not made again.
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
export const REPLACE = { fps: 16, window: 77, motion: 5, pixels: 832 * 480, longest: 60, people: 4 };
export const DEFAULT_PROMPT = 'a person moving naturally, realistic, consistent identity';
export const AREAS = ['person', 'face'];

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

/**
 * Whom the next window follows: the prep node returns the person's box in every frame of the window (0-1, null where
 * they are not in the shot) and their look (a colour histogram), JSON in its ui output. box: the box at the start of
 * the next window, or the last one before it where the person was seen; look: the histogram. Each is null when there
 * is no next window or the node did not give it.
 */
export function nextTarget(outputs, graph, window, next) {
  const none = { box: null, look: null };
  if (!next) return none;
  const ui = outputs?.[nodes(graph, 'NedeseReplacePrep')[0]];
  const parse = (v) => {
    try {
      return JSON.parse(v ?? 'null');
    } catch {
      return null;
    }
  };
  const boxes = parse(ui?.boxes?.[0]);
  const look = parse(ui?.look?.[0]);
  let box = null;
  if (Array.isArray(boxes)) for (let i = Math.min(next.start - window.start, boxes.length - 1); i >= 0 && !box; i--) box = boxes[i] ?? null;
  return { box, look: Array.isArray(look) && look.length ? look : null };
}

export function validate(g, { setting, mod }) {
  generatorRequired(mod, 'replaceJob', 'Replacing a person', setting?.modelRoot);
  const source = String(g.source ?? '').trim();
  if (!source) throw new UserError('Pick the video whose person is replaced.');
  if (!VIDEO_EXTENSION.test(recordPath(setting.outputRoot, source))) throw new UserError('Pick a video file (MP4, MOV, MKV, WebM…).');
  const list = Array.isArray(g.people) ? g.people : [];
  if (!list.length) throw new UserError('Pick the photo of the person who takes their place.');
  if (list.length > REPLACE.people) throw new UserError(`At most ${REPLACE.people} people can be replaced at once.`);
  const people = list.map((p) => {
    const picture = String(p?.picture ?? '').trim();
    if (!picture) throw new UserError('Pick the photo of the person who takes their place.');
    sourcePath(setting.outputRoot, picture);
    // English (the model's language): the person and what they do in the video; the motion comes from the video
    return { picture, prompt: text(p.prompt, 'Prompt', { required: false, max: 500 }) || DEFAULT_PROMPT };
  });
  // person: the whole person is repainted; face: only the face (the body, clothes and hair of the video stay)
  const area = g.area ?? 'person';
  if (!AREAS.includes(area)) throw new UserError(`Area: one of ${AREAS.join(', ')}.`);
  return {
    source,
    people,
    area,
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
    seed: seed(g.seed),
  };
}

export function summary(g) {
  const many = g.people?.length > 1;
  if (g.area === 'face') return { title: g.title || (many ? 'Faces replaced' : 'Face replaced'), detail: many ? `Wan 2.2 Animate · ${g.people.length} faces from the photos` : 'Wan 2.2 Animate · the face from the photo' };
  return { title: g.title || (many ? 'People replaced' : 'Person replaced'), detail: many ? `Wan 2.2 Animate · ${g.people.length} people from the photos` : 'Wan 2.2 Animate · the person from the photo' };
}

export async function run(ctx) {
  const g = ctx.job.input;
  const source = recordPath(ctx.setting.outputRoot, g.source);
  const ff = (a, o = {}) => runFfmpeg(ctx.setting.ffmpeg, a, { cwd: ctx.folder, signal: ctx.signal, ...o });
  const info = await streams(ctx.setting.ffprobe, source);
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new UserError('No video found in the file.');
  if (info.duration > REPLACE.longest) throw new UserError(`The video is ${Math.round(info.duration)} s; a person can be replaced in at most ${REPLACE.longest} s. Cut it first (Edit: "take the first 20 seconds").`);
  // a phone video stands upright through its rotation: the frames come out turned, so the shape follows them
  const turned = [90, 270].includes(Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? 0)) % 360);
  const { width, height } = replaceSize(turned ? v.height : v.width, turned ? v.width : v.height);

  // 1. The frames at 16 fps in the made size (cropped to fill)
  const work = join(ctx.folder, 'work');
  const sourceFolder = join(work, 'source');
  const passFolder = (p) => join(work, `pass${p}`);
  mkdirSync(sourceFolder, { recursive: true });
  if (!existsSync(join(work, 'source.done'))) {
    ctx.progress({ percent: 2, stage: 'Reading the video' });
    for (const d of pngs(sourceFolder)) rmSync(join(sourceFolder, d), { force: true });
    await ff(['-i', source, '-vf', `fps=${REPLACE.fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`, join(sourceFolder, '%05d.png')], { totalDuration: info.duration });
    writeFileSync(join(work, 'source.done'), '');
  }
  const frames = pngs(sourceFolder);
  if (!frames.length) throw new UserError('No frames could be read from the video.');

  // 2. Each person a pass, each pass window by window (a retry continues after the last finished window)
  const windows = replaceWindows(frames.length);
  const passes = g.people.length;
  const statusPath = join(work, 'checkpoint.json');
  let status = null;
  try {
    status = JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch {
    /* none */
  }
  const signature = JSON.stringify({ frames: frames.length, width, height, people: g.people.map((p) => p.picture), area: g.area ?? 'person' });
  const save = (s) => {
    status = s;
    writeFileSync(statusPath, JSON.stringify(status), 'utf8');
  };
  if (status?.signature !== signature) {
    for (let p = 1; p <= REPLACE.people; p++) rmSync(passFolder(p), { recursive: true, force: true });
    save({ signature, pass: 1, window: 0, frame: 0, box: null });
  }
  ctx.log(`${frames.length} frames (${(frames.length / REPLACE.fps).toFixed(1)} s) at ${width}x${height}, ${windows.length} window${windows.length > 1 ? 's' : ''}${passes > 1 ? `, ${passes} people (from the left)` : ''}.`);
  const namePrefix = `panel_${ctx.job.id}_`;
  for (let p = status.pass; p <= passes; p++) {
    // the pass works on the previous pass's frames
    const inputFolder = p === 1 ? sourceFolder : passFolder(p - 1);
    const input = pngs(inputFolder).slice(0, frames.length);
    const targetFolder = passFolder(p);
    mkdirSync(targetFolder, { recursive: true });
    const deleted = deleteExtraFrames(targetFolder, status.frame);
    if (deleted) ctx.log(`${deleted} frames removed from the unfinished window (resuming where it left off).`);
    // the photo letterboxed to the made size (the model crops to fill)
    const reference = join(work, `person${p}.png`);
    if (!existsSync(reference)) await ff(['-i', sourcePath(ctx.setting.outputRoot, g.people[p - 1].picture), '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white`, '-frames:v', '1', reference]);
    const picture = await ctx.comfy.load(reference, `${namePrefix}person${p}.png`);
    const who = passes > 1 ? `p${p}` : '';
    for (const w of windows.slice(status.window)) {
      const startedAt = Date.now();
      // the window's frames as a video for ComfyUI (the last frame repeated past the end)
      const list = join(work, `w${w.no}.txt`);
      writeFileSync(list, Array.from({ length: w.length }, (_, i) => `file '${join(inputFolder, input[Math.min(w.start + i, input.length - 1)]).replaceAll('\\', '/')}'\nduration ${1 / REPLACE.fps}`).join('\n'), 'utf8');
      const clipPath = join(work, `w${w.no}.mp4`);
      await ff(['-f', 'concat', '-safe', '0', '-i', list, '-frames:v', String(w.length), '-r', String(REPLACE.fps), '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', clipPath]);
      const clip = await ctx.comfy.load(clipPath, `${namePrefix}${who}w${w.no}.mp4`);
      const existing = pngs(targetFolder);
      const motions = w.no === 1 ? null : await Promise.all(existing.slice(-REPLACE.motion).map((d, j) => ctx.comfy.load(join(targetFolder, d), `${namePrefix}${who}w${w.no}_m${j + 1}.png`)));
      // the first window picks the person (one photo: the largest; several: the p-th from the left), later ones follow them
      // (and look like them: a window can start in a shot without them)
      const target = w.no > 1 && status.box ? { box: status.box, ...(status.look ? { look: status.look } : {}) } : passes > 1 ? { order: p } : {};
      const graph = ctx.mod.replaceJob({ clip, picture, motions, target, text: g.people[p - 1].prompt, area: g.area ?? 'person', seed: g.seed, width, height, frame: w.length, prefix: `panel/${ctx.job.id}/${who}w${w.no}` });
      const record = nodes(graph, 'SaveImage')[0];
      const part = (k) => 5 + (90 * (p - 1 + k / windows.length)) / passes;
      const stage = passes > 1 ? `Replacing person ${p}/${passes} · ${w.no}/${windows.length}` : `Replacing the person ${w.no}/${windows.length}`;
      const outputs = await ctx.runComfy(graph, { stage, range: [part(w.no - 1), part(w.no)] });
      const got = images(outputs, record);
      if (!got.length) throw new Error('ComfyUI did not return the frames of the window.');
      let no = existing.length;
      for (const c of got) {
        no += 1;
        await ctx.comfy.getOutput(c, join(targetFolder, `${String(no).padStart(5, '0')}.png`));
      }
      const next = nextTarget(outputs, graph, w, windows[w.no]);
      save({ ...status, window: w.no, frame: no, box: next.box ?? status.box, look: next.look ?? status.look ?? null });
      rmSync(clipPath, { force: true });
      const seconds = (Date.now() - startedAt) / 1000;
      ctx.log(`${passes > 1 ? `Person ${p}/${passes}, window` : 'Window'} ${w.no}/${windows.length} (frames ${w.start + 1}-${w.start + w.length}): ${Math.round(seconds)} s`);
      ctx.measure('replace', seconds / ((w.no === 1 ? w.length : w.length - REPLACE.motion) / REPLACE.fps));
    }
    // the last window ran past the end: its extra frames go
    for (const d of pngs(targetFolder).slice(frames.length)) rmSync(join(targetFolder, d), { force: true });
    save({ ...status, pass: p + 1, window: 0, frame: 0, box: null, look: null });
    if (p > 1) rmSync(inputFolder, { recursive: true, force: true });
  }

  // 3. The video with its own sound
  ctx.progress({ percent: 96, stage: 'Putting the video together' });
  const targetFolder = passFolder(passes);
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
