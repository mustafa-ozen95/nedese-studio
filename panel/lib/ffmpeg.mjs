/**
 * ffmpeg work: mp4 from frames, previews, audio speed/conversion, scene clips, merging.
 *
 * The ffmpeg path is FOUND per machine (never hard-coded): <ai>\ffmpeg\bin (a remote machine),
 * PATH, then the winget package (this machine: Gyan.FFmpeg). Commands run in the job folder (cwd)
 * with relative paths: no "C\:" escaping trouble in the subtitles filter.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { run } from './process.mjs';

export function findFfmpeg(aiRoot) {
  const candidates = [join(aiRoot, 'ffmpeg', 'bin', 'ffmpeg.exe'), join(aiRoot, 'ffmpeg', 'ffmpeg.exe')];
  for (const d of (process.env.PATH ?? '').split(';')) if (d) candidates.push(join(d, 'ffmpeg.exe'));
  for (const a of candidates) if (existsSync(a)) return a;
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(packages)) {
    for (const p of readdirSync(packages).filter((n) => /ffmpeg/i.test(n))) {
      const root = join(packages, p);
      let subs = [];
      try {
        subs = readdirSync(root);
      } catch {
        continue;
      }
      for (const a of subs) {
        const y = join(root, a, 'bin', 'ffmpeg.exe');
        if (existsSync(y)) return y;
      }
    }
  }
  return null;
}

export function ffprobePath(ffmpeg) {
  if (!ffmpeg) return null;
  const y = join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return existsSync(y) ? y : null;
}

/**
 * Runs ffmpeg; with totalDuration it reports progress(0..1).
 */
export async function runFfmpeg(ffmpeg, args, { cwd, signal, totalDuration, progress } = {}) {
  if (!ffmpeg) throw new Error('ffmpeg not found (<ai>\\ffmpeg\\bin, PATH or winget Gyan.FFmpeg).');
  const full = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args];
  return run(ffmpeg, full, {
    cwd,
    signal,
    name: 'ffmpeg',
    line: (s, stream) => {
      if (stream !== 'stdout' || !totalDuration || !progress) return;
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(s);
      if (m) progress(Math.min(1, Number(m[1]) / 1e6 / totalDuration));
    },
  });
}

/** The duration (s) from ffprobe. */
export function measureDuration(ffprobe, path) {
  return new Promise((ok, red) => {
    if (!ffprobe) {
      red(new Error('ffprobe missing'));
      return;
    }
    execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], { windowsHide: true, timeout: 30000 }, (h, output) => {
      if (h) red(h);
      else ok(Number(String(output).trim()));
    });
  });
}

/** The streams from ffprobe ({ duration, streams: [{ codec_type, width, height, duration, r_frame_rate, ... }] }). */
export function streams(ffprobe, path) {
  return new Promise((ok, red) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,pix_fmt,duration,r_frame_rate,sample_rate,channels', '-show_entries', 'format=duration', '-of', 'json', path],
      { windowsHide: true, timeout: 30000 },
      (h, output) => {
        if (h) {
          red(h);
          return;
        }
        const j = JSON.parse(String(output));
        ok({ duration: Number(j.format?.duration), streams: j.streams ?? [] });
      },
    );
  });
}

const X264 = (crf, ready) => ['-c:v', 'libx264', '-preset', ready, '-crf', String(crf), '-pix_fmt', 'yuv420p'];

/**
 * Encoder arguments for intermediate files (video parts, scene clips). nvenc: the graphics card's
 * encoder (ComfyUI is idle then; ~200 MB VRAM, no RAM cost), much faster than x264;
 * close in quality at the same crf (-cq ≈ crf + 1). The final film is always x264.
 */
export function encoderArgs(encoder, crf, ready) {
  if (encoder === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(crf + 1), '-b:v', '0', '-pix_fmt', 'yuv420p'];
  return X264(crf, ready);
}

const encoderCache = new Map();

/**
 * preference: 'x264' | 'nvenc' | 'automatic'. automatic/nvenc: 'nvenc' when ffmpeg has h264_nvenc and a
 * 5 frame trial encode really works, otherwise 'x264' (no driver or card: it falls back).
 */
export async function videoEncoder(ffmpeg, preference = 'automatic') {
  if (preference === 'x264' || !ffmpeg) return 'x264';
  if (encoderCache.has(ffmpeg)) return encoderCache.get(ffmpeg);
  const result = await new Promise((ok) => {
    execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', '-frames:v', '5', ...encoderArgs('nvenc', 18), '-f', 'null', '-'], { windowsHide: true, timeout: 20000 }, (error) => ok(error ? 'x264' : 'nvenc'));
  });
  encoderCache.set(ffmpeg, result);
  return result;
}

/**
 * An mp4 from a frame sequence (pattern: 'frames/%05d.png'). outputFps: converted to this frame rate, keeping the duration.
 * truncate: [width, height] cropped from the centre (1080p: made at 1920x1088 -> 1920x1080).
 */
export function framesToMp4(ffmpeg, { cwd, pattern, fps, outputFps, output, crf = 18, ready = 'medium', encoder = 'x264', signal, progress, frameCount, truncate = null }) {
  const vf = `${truncate ? `crop=${truncate[0]}:${truncate[1]},` : ''}scale=trunc(iw/2)*2:trunc(ih/2)*2${outputFps && outputFps !== fps ? `,fps=${outputFps}` : ''}`;
  return runFfmpeg(
    ffmpeg,
    ['-framerate', String(fps), '-start_number', '1', '-i', pattern, '-vf', vf, ...encoderArgs(encoder, crf, ready), '-movflags', '+faststart', output],
    { cwd, signal, totalDuration: frameCount ? frameCount / fps : undefined, progress },
  );
}

/**
 * Joins finished mp4 parts one after another without re-encoding (concat demuxer + a list file):
 * the filter graph does not grow even with thousands of parts. The parts must be encoded with the same settings.
 */
export function concatParts(ffmpeg, { cwd, parts, output, listFile = 'part-list.txt', signal }) {
  const escape = (s) => s.replace(/'/g, "'\\''");
  writeFileSync(join(cwd, listFile), `${parts.map((p) => `file '${escape(p)}'`).join('\n')}\n`, 'utf8');
  return runFfmpeg(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', output], { cwd, signal });
}

/**
 * The channel mean and deviation of a picture (0..1): { avg: [r,g,b], deviation: [r,g,b] }. Scaled
 * down to 48x48 and read as raw RGB; to measure colour drift in a long video.
 */
export function measureColor(ffmpeg, path) {
  return new Promise((ok, red) => {
    if (!ffmpeg) {
      red(new Error('no ffmpeg'));
      return;
    }
    execFile(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path, '-frames:v', '1', '-vf', 'scale=48:48', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, timeout: 60000, encoding: 'buffer', maxBuffer: 2 ** 20 }, (h, output) => {
      if (h) {
        red(h);
        return;
      }
      const n = Math.floor(output.length / 3);
      const avg = [0, 0, 0];
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) avg[c] += output[i * 3 + c];
      for (let c = 0; c < 3; c++) avg[c] /= n * 255;
      const deviation = [0, 0, 0];
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) deviation[c] += (output[i * 3 + c] / 255 - avg[c]) ** 2;
      for (let c = 0; c < 3; c++) deviation[c] = Math.sqrt(deviation[c] / n);
      ok({ avg, deviation });
    });
  });
}

/**
 * Brings a frame towards the colour statistics of the source picture (linear per channel: mean and
 * a light deviation match, colorlevels). Pulls back the colour/brightness drift that builds up from part
 * to part in a long video, at the first frame of every continuation part. Returns: { diff } (the largest
 * channel mean difference, 0..1).
 */
export function matchColor(ffmpeg, input, output, source, frame, { cwd, signal } = {}) {
  const names = ['r', 'g', 'b'];
  const parts = [];
  let diff = 0;
  for (let c = 0; c < 3; c++) {
    const a = frame.deviation[c] > 0.02 ? Math.max(0.85, Math.min(1.18, source.deviation[c] / frame.deviation[c])) : 1;
    const b = source.avg[c] - a * frame.avg[c];
    // y = a*x + b  ==  colorlevels: y = (x - imin) / (imax - imin)
    const imin = Math.max(-1, Math.min(1, -b / a));
    const imax = Math.max(-1, Math.min(1, imin + 1 / a));
    diff = Math.max(diff, Math.abs(source.avg[c] - frame.avg[c]));
    parts.push(`${names[c]}imin=${imin.toFixed(4)}:${names[c]}imax=${imax.toFixed(4)}`);
  }
  return runFfmpeg(ffmpeg, ['-i', input, '-frames:v', '1', '-vf', `colorlevels=${parts.join(':')}`, output], { cwd, signal }).then(() => ({ diff: Math.round(diff * 1000) / 1000 }));
}

/** Small JPEG preview (gallery). The input may be a picture or a video (its first frame, or the frame at `at` seconds). */
export function makePreview(ffmpeg, input, output, { width = 480, cwd, signal, at = 0 } = {}) {
  return runFfmpeg(ffmpeg, [...(at > 0 ? ['-ss', at.toFixed(2)] : []), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', output], { cwd, signal });
}

/** EXIF orientation (2-8) -> the filter that makes the pixels upright (the same as PIL ImageOps.exif_transpose). */
export const ORIENTATION_FILTER = { 2: 'hflip', 3: 'hflip,vflip', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };

/**
 * Makes a photo with an EXIF orientation an upright PNG without the tag. ComfyUI 0.37 LoadImage (PyAV) reads a mirrored
 * orientation (iPhone front camera: 2) turned 180 degrees; Wan made a video from an upside-down frame.
 * -noautorotate: the same result whether or not the ffmpeg version turns it itself. sidedata=delete: ffmpeg 9
 * carried the orientation tag into the PNG (eXIf) and the reader turned it a second time.
 */
export function fixOrientation(ffmpeg, input, output, direction, { cwd, signal } = {}) {
  return runFfmpeg(ffmpeg, ['-noautorotate', '-i', input, '-frames:v', '1', '-vf', `${ORIENTATION_FILTER[direction]},sidedata=mode=delete`, '-map_metadata', '-1', output], { cwd, signal });
}

/** Speech speed (the pitch is kept). atempo between 0.5 and 2 in one filter. */
export function audioSpeed(ffmpeg, input, output, speed, { cwd, signal } = {}) {
  return runFfmpeg(ffmpeg, ['-i', input, '-filter:a', `atempo=${speed}`, '-c:a', 'pcm_s16le', output], { cwd, signal });
}

/** A reference voice: mono 24 kHz WAV, at most 30 s (Chatterbox wants ~10 s). */
export function toReference(ffmpeg, input, output, { cwd, signal } = {}) {
  return runFfmpeg(ffmpeg, ['-i', input, '-t', '30', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output], { cwd, signal });
}

/**
 * A scene clip: the frame sequence plays at the input frame rate (slowed down), cut to the target duration;
 * the narration starts after frontSpace and is padded with silence to the target duration.
 */
export function sceneClip(ffmpeg, { cwd, pattern, inputFps, voice, frontSpace, target, width, height, output, fps = 30, crf = 16, ready = 'medium', encoder = 'x264', signal, progress }) {
  const delay = Math.round(frontSpace * 1000);
  const v = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=3,format=yuv420p[v]`;
  const a = `[1:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay=${delay}:all=1,apad[a]`;
  return runFfmpeg(
    ffmpeg,
    [
      '-framerate', String(Math.round(inputFps * 10000) / 10000), '-start_number', '1', '-i', pattern,
      '-i', voice,
      '-filter_complex', `${v};${a}`,
      '-map', '[v]', '-map', '[a]', '-t', String(target),
      ...encoderArgs(encoder, crf, ready), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output,
    ],
    { cwd, signal, totalDuration: target, progress },
  );
}

/**
 * Merges the scenes into one video. transition > 0: crossfade (xfade + acrossfade),
 * transition = 0: plain joins. subtitle: an .ass file relative to cwd (burned into the video).
 * music: { path, level } background music; looped over the film, faded in and out,
 * ducked by itself while the narration speaks (sidechain).
 */
export function merge(ffmpeg, { cwd, scenes, transition, subtitle, music, output, fps = 30, crf = 18, ready = 'medium', lastOperation = true, signal, progress }) {
  const inputs = scenes.flatMap((s) => ['-i', s.path]);
  if (music) inputs.push('-stream_loop', '-1', '-i', music.path);
  const n = scenes.length;
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(`[${i}:v]settb=AVTB,fps=${fps},format=yuv420p[v${i}]`);
  let vSon = 'v0';
  let aSon = '0:a';
  if (n > 1 && transition > 0) {
    let accumulation = scenes[0].duration;
    for (let i = 1; i < n; i++) {
      const offset = Math.max(0, accumulation - transition);
      parts.push(`[${vSon}][v${i}]xfade=transition=fade:duration=${transition}:offset=${offset.toFixed(3)}[x${i}]`);
      parts.push(`[${aSon}][${i}:a]acrossfade=d=${transition}:c1=tri:c2=tri[y${i}]`);
      vSon = `x${i}`;
      aSon = `y${i}`;
      accumulation = offset + scenes[i].duration;
    }
  } else if (n > 1) {
    const list = scenes.map((_, i) => `[v${i}][${i}:a]`).join('');
    parts.push(`${list}concat=n=${n}:v=1:a=1[xc][yc]`);
    vSon = 'xc';
    aSon = 'yc';
  }
  if (subtitle) {
    parts.push(`[${vSon}]ass=${subtitle}[vs]`);
    vSon = 'vs';
  }
  const total = scenes.reduce((t, s) => t + s.duration, 0) - (n > 1 ? (n - 1) * transition : 0);
  if (music) {
    const atEnd = Math.max(0, total - 2.5).toFixed(3);
    parts.push(`[${aSon}]aresample=48000,asplit=2[an][ak]`);
    parts.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(3)},afade=t=in:d=1.5,afade=t=out:st=${atEnd}:d=2.5,volume=${music.level}[mz]`);
    parts.push(`[mz][ak]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=500[mk]`);
    parts.push(`[an][mk]amix=inputs=2:duration=first:normalize=0[am]`);
    aSon = 'am';
  }
  // Intermediate batches (lastOperation=false) are not loudness-measured: normalised once, on the final film only.
  parts.push(lastOperation ? `[${aSon}]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[ason]` : `[${aSon}]aresample=48000[ason]`);
  return runFfmpeg(
    ffmpeg,
    [...inputs, '-filter_complex', parts.join(';'), '-map', `[${vSon}]`, '-map', '[ason]', ...X264(crf, ready), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', output],
    { cwd, signal, totalDuration: total, progress },
  );
}

/**
 * Merges the music sections in order with soft transitions (acrossfade, transition s) into one MP3.
 * A single part is only copied.
 */
export function mergeMusic(ffmpeg, { cwd, parts, transition = 3, output, signal }) {
  if (parts.length === 1) return runFfmpeg(ffmpeg, ['-y', '-i', parts[0], '-c', 'copy', output], { cwd, signal });
  const inputs = parts.flatMap((p) => ['-i', p]);
  const filter = [];
  let last = '0:a';
  for (let i = 1; i < parts.length; i++) {
    const name = i === parts.length - 1 ? 'mz' : `m${i}`;
    filter.push(`[${last}][${i}:a]acrossfade=d=${transition}:c1=tri:c2=tri[${name}]`);
    last = name;
  }
  return runFfmpeg(ffmpeg, ['-y', ...inputs, '-filter_complex', filter.join(';'), '-map', '[mz]', '-c:a', 'libmp3lame', '-q:a', '2', output], { cwd, signal });
}
