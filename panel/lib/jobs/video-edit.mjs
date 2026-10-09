/**
 * Edit video: edits the given video by an instruction (cut, speed, rotate, flip, crop/ratio, scale, mute/volume,
 * text, colour, black and white, fade, reverse, fps, add music). The text model turns the instruction into a list of
 * operations (lib/edit-plan.mjs); filter steps in a row share one ffmpeg pass (crf 18), cut / audio / music get a
 * pass of their own.
 * Music can be added only when the user gave a music file. The plan is saved in the job (for a retry).
 */
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { streams, runFfmpeg, makePreview } from '../ffmpeg.mjs';
import { UserError } from '../errors.mjs';
import { plan } from '../edit-plan.mjs';
import { hasText } from '../text-model.mjs';
import { text, musicPath, MUSIC_LEVEL } from './common.mjs';
import { recordPath } from './clone.mjs';

export const name = 'Edit video';
// ffmpeg only: the graphics card guard does not hold this job back.
export const gpuNotNeeded = true;
const VIDEO_EXTENSION = /\.(mp4|mov|mkv|webm|avi|m4v|3gp)$/i;
const X264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'];
// The font: Arial on Windows (Turkish letters); ':' is escaped in the filter path.
const TEXT_TYPE = process.platform === 'win32' ? 'C\\:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
// The text position: top | middle | bottom.
const TEXT_Y = { top: 'h*0.07', middle: '(h-th)/2', bottom: 'h-th-h*0.08' };

export function validate(g, { setting }) {
  if (!hasText() && !setting.editPlan) throw new UserError('The instruction interpreter (text model) is not on this machine; video editing is unavailable.');
  const source = String(g.source ?? '').trim();
  if (!source) throw new UserError('Pick the video to edit.');
  if (!VIDEO_EXTENSION.test(recordPath(setting.outputRoot, source))) throw new UserError('Pick a video file (MP4, MOV, MKV, WebM…).');
  const music = String(g.music ?? '').trim();
  if (music) musicPath(setting.outputRoot, music);
  return { source, instruction: text(g.instruction, 'Instruction', { max: 2000 }), music: music || null };
}

export function summary(g) {
  return { title: g.instruction, detail: `Video editing by instruction${g.music ? ' · with music' : ''}` };
}

/** The steps that need a pass of their own (input cut, the audio stream, the music mix); the others join the filter chain. */
const SEPARATE_STEPS = new Set(['cut', 'mute', 'volume', 'music']);

/** A filter step's video/audio filter parts; b: the info at that point (after the earlier steps of the chain). */
function filterPart(a, b, k) {
  const hasVoice = b.voice;
  const v = [];
  let af = null;
  switch (a.operation) {
    case 'speed':
      v.push(`setpts=PTS/${a.ratio}`);
      // atempo 0.5-2 araliginda; disindakiler zincirle
      if (hasVoice) {
        const z = [];
        let r = a.ratio;
        while (r > 2) { z.push('atempo=2'); r /= 2; }
        while (r < 0.5) { z.push('atempo=0.5'); r /= 0.5; }
        z.push(`atempo=${r.toFixed(4)}`);
        af = z.join(',');
      }
      break;
    case 'rotate':
      v.push({ 90: 'transpose=1', 180: 'transpose=1,transpose=1', 270: 'transpose=2' }[a.degree]);
      break;
    case 'flip':
      v.push(a.direction === 'horizontal' ? 'hflip' : 'vflip');
      break;
    case 'crop': {
      const [x, y] = a.ratio.split(':').map(Number);
      const r = x / y;
      v.push(`crop='if(gt(a,${r}),ih*${r},iw)':'if(gt(a,${r}),ih,iw/${r})'`, 'scale=trunc(iw/2)*2:trunc(ih/2)*2', 'setsar=1');
      break;
    }
    case 'scale':
      v.push(`scale=-2:${a.height}`);
      break;
    case 'text': {
      const file = join(k, `text_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
      writeFileSync(file, a.text, 'utf8');
      const path = file.replaceAll('\\', '/').replace(/^([A-Za-z]):/, '$1\\:');
      const yy = TEXT_Y[a.position] ?? TEXT_Y.bottom;
      const time = a.start != null || a.end != null ? `:enable='between(t,${a.start ?? 0},${a.end ?? 1e6})'` : '';
      // expansion=none: % and \ in the text are written as they are (else "%50 indirim" breaks ffmpeg)
      v.push(`drawtext=fontfile='${TEXT_TYPE}':textfile='${path}':expansion=none:fontsize=h/16:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=18:x=(w-tw)/2:y=${yy}${time}`);
      break;
    }
    case 'color':
      v.push(`eq=brightness=${a.brightness}:contrast=${a.contrast}:saturation=${a.saturation}`);
      break;
    case 'blackWhite':
      v.push('hue=s=0');
      break;
    case 'fade':
      if (a.in > 0) v.push(`fade=t=in:d=${a.in}`);
      if (a.out > 0) v.push(`fade=t=out:st=${Math.max(0, b.duration - a.out).toFixed(2)}:d=${a.out}`);
      if (hasVoice) af = [a.in > 0 ? `afade=t=in:d=${a.in}` : '', a.out > 0 ? `afade=t=out:st=${Math.max(0, b.duration - a.out).toFixed(2)}:d=${a.out}` : ''].filter(Boolean).join(',') || null;
      break;
    case 'reverse':
      v.push('reverse');
      if (hasVoice) af = 'areverse';
      break;
    case 'fps':
      v.push(`fps=${a.value}`);
      break;
    default:
      throw new Error(`Unknown operation: ${a.operation}`);
  }
  return { v, af };
}

/**
 * Filter steps in a row in ONE pass (one encode: no generation loss, as fast as one step).
 * A speed step changes the length: the later steps (fade) use the current length.
 */
export function chainArgs(steps, b, { input, output, k }) {
  const v = [];
  const af = [];
  let now = { ...b };
  for (const a of steps) {
    const p = filterPart(a, now, k);
    v.push(...p.v);
    if (p.af) af.push(p.af);
    if (a.operation === 'speed') now = { ...now, duration: now.duration / a.ratio };
  }
  const audio = af.length ? ['-af', af.join(','), '-c:a', 'aac', '-b:a', '192k'] : b.voice ? ['-c:a', 'copy'] : [];
  return ['-i', input, ...(v.length ? ['-vf', v.join(',')] : []), ...X264, ...audio, '-movflags', '+faststart', output];
}

/** The ffmpeg arguments of a step with its own pass (input -> output). b: the video info at that point. */
function separateStepArgs(a, b, { input, output, music }) {
  const hasVoice = b.voice;
  switch (a.operation) {
    case 'cut':
      return ['-ss', String(a.start), ...(a.end != null ? ['-to', String(a.end)] : []), '-i', input, ...X264, '-c:a', 'aac', '-b:a', '192k', output];
    case 'mute':
      return ['-i', input, '-c:v', 'copy', '-an', output];
    case 'volume':
      return ['-i', input, '-c:v', 'copy', ...(hasVoice ? ['-af', `volume=${a.factor}`, '-c:a', 'aac', '-b:a', '192k'] : []), output];
    case 'music': {
      // The music under the video: looped for the length, at its level; speech stays on top.
      const level = MUSIC_LEVEL[a.level] ?? MUSIC_LEVEL.middle;
      const mix = hasVoice
        ? `[1:a]volume=${level * 2.5},aloop=loop=-1:size=2e9[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]`
        : `[1:a]volume=${level * 4},aloop=loop=-1:size=2e9,atrim=0:${b.duration.toFixed(2)}[a]`;
      return ['-i', input, '-i', music, '-filter_complex', mix, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', output];
    }
    default:
      throw new Error(`Unknown operation: ${a.operation}`);
  }
}

/** Bytes per pixel of a raw frame: 1.5 for 8 bit 4:2:0; more for 10+ bit (phone HDR) or 4:2:2 / 4:4:4 / RGB. */
function pixelByte(pix = '') {
  const depth = /p(9|1[0-6])(le|be)$/.test(pix) ? 2 : 1;
  const channel = /444|gbr|rgb|bgr|argb|rgba|abgr/.test(pix) ? 3 : /422/.test(pix) ? 2 : 1.5;
  return depth * channel;
}

/**
 * The estimated memory (bytes) of reverse playback in the chain: ffmpeg reverse keeps every frame raw in memory.
 * The earlier steps count (rotate/crop/scale change the size, fps the frame count; speed does not). 0 without a reverse.
 */
export function reverseMemory(steps, b) {
  let { width, height } = b;
  let duration = b.duration;
  let frame = b.duration * b.fps;
  for (const a of steps) {
    switch (a.operation) {
      case 'reverse':
        return Math.round(width * height * pixelByte(b.pix) * frame);
      case 'rotate':
        if (a.degree !== 180) [width, height] = [height, width];
        break;
      case 'crop': {
        const [x, y] = a.ratio.split(':').map(Number);
        if (width / height > x / y) width = (height * x) / y;
        else height = (width * y) / x;
        break;
      }
      case 'scale':
        width = (width * a.height) / height;
        height = a.height;
        break;
      case 'speed':
        duration /= a.ratio;
        break;
      case 'fps':
        frame = a.value * duration;
        break;
    }
  }
  return 0;
}

/** Splits the plan's steps into passes: a separate step alone, the filter steps between them together. */
export function groupPasses(steps) {
  const passes = [];
  for (const a of steps) {
    const lastPass = passes[passes.length - 1];
    if (!SEPARATE_STEPS.has(a.operation) && lastPass?.chain) lastPass.steps.push(a);
    else passes.push({ chain: !SEPARATE_STEPS.has(a.operation), steps: [a] });
  }
  return passes;
}

async function videoInfo(ffprobe, path) {
  const a = await streams(ffprobe, path);
  const v = a.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new UserError('No video found in the file.');
  const [p, q] = String(v.r_frame_rate ?? '30/1').split('/').map(Number);
  return { duration: a.duration, width: v.width, height: v.height, fps: q ? Math.round((p / q) * 100) / 100 : 30, pix: v.pix_fmt ?? '', voice: a.streams.some((s) => s.codec_type === 'audio') };
}

export async function run(ctx) {
  const g = ctx.job.input;
  const source = recordPath(ctx.setting.outputRoot, g.source);
  const music = g.music ? musicPath(ctx.setting.outputRoot, g.music) : null;
  const ff = ctx.setting.ffmpeg;
  const k = ctx.folder;

  // 1. Plan
  if (!ctx.job.plan) {
    ctx.progress({ percent: 3, stage: 'Understanding the instruction' });
    const b = await videoInfo(ctx.setting.ffprobe, source);
    if (b.duration > 3 * 3600) throw new UserError('The video is longer than 3 hours.');
    const info = { duration: b.duration, hasMusic: Boolean(music), summary: { durationSec: Math.round(b.duration * 10) / 10, width: b.width, height: b.height, fps: b.fps, hasVoice: b.voice, musicFileGiven: Boolean(music) } };
    const planner = ctx.setting.editPlan ?? plan;
    ctx.job.plan = await planner({ type: 'video', instruction: g.instruction, info, signal: ctx.signal });
    ctx.save();
  }
  const plan = ctx.job.plan;
  ctx.log(`Plan: ${plan.description || plan.steps.map((a) => a.operation).join(', ')}`);
  if (plan.impossible) ctx.log(`Not possible: ${plan.impossible}`);

  // 2. The passes: filter steps in a row in one ffmpeg pass (a retry skips a finished pass)
  let current = source;
  const passes = groupPasses(plan.steps);
  for (const [i, gc] of passes.entries()) {
    const target = join(k, `pass_${String(i + 1).padStart(2, '0')}.mp4`);
    const names = gc.steps.map((a) => a.operation).join(' + ');
    ctx.progress({ percent: 8 + (i / passes.length) * 88, stage: `Editing (${i + 1}/${passes.length})`, detail: names });
    if (!existsSync(target)) {
      if (!gc.chain && gc.steps[0].operation === 'music' && !music) {
        ctx.log('No music file was given, so no music was added.');
        continue;
      }
      const b = await videoInfo(ctx.setting.ffprobe, current);
      if (gc.chain) {
        // Without enough memory ffmpeg must not die halfway or push the machine into swap: a clear error before the start (2 GB left for the system)
        const required = reverseMemory(gc.steps, b);
        const free = (ctx.setting.freeMemory ?? freemem)();
        if (required > free - 2 * 2 ** 30) {
          const gb = (x) => (x / 2 ** 30).toFixed(1);
          throw new UserError(`Reverse playback loads every frame into memory: this video needs ~${gb(required)} GB, free memory is ${gb(free)} GB. Shorten or downscale the video first (e.g. "take the first 10 seconds, make it 720p, then reverse").`);
        }
      }
      // Written under a temporary name and renamed when done: a file cut off halfway (without moov) does not count as finished
      const temp = target.replace(/\.mp4$/, '.writing.mp4');
      rmSync(temp, { force: true });
      const args = gc.chain ? chainArgs(gc.steps, b, { input: current, output: temp, k }) : separateStepArgs(gc.steps[0], b, { input: current, output: temp, music });
      await runFfmpeg(ff, args, { cwd: k, signal: ctx.signal, totalDuration: b.duration });
      renameSync(temp, target);
    }
    current = target;
  }
  copyFileSync(current, join(k, 'edited.mp4'));
  // The in-between passes are not needed any more (~8 GB each for a 3 hour 1080p video)
  for (const d of readdirSync(k)) if (/^pass_\d+\.mp4$/.test(d)) rmSync(join(k, d), { force: true });
  const last = await videoInfo(ctx.setting.ffprobe, join(k, 'edited.mp4'));
  await makePreview(ff, 'edited.mp4', 'edited.preview.jpg', { cwd: k, signal: ctx.signal }).catch(() => {});
  ctx.addOutput({ file: 'edited.mp4', type: 'video', preview: existsSync(join(k, 'edited.preview.jpg')) ? 'edited.preview.jpg' : undefined, duration: Math.round(last.duration * 100) / 100, width: last.width, height: last.height, fps: last.fps, main: true });
  if (plan.impossible) ctx.job.warning = `Not possible: ${plan.impossible}`;
}
