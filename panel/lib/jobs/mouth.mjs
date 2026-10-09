/**
 * Mouth correction (LatentSync, lip\mouth.py): in a lip-synced scene the mouth of speaking PEOPLE is redrawn with their
 * own audio track; eyes and gaze (Wan 2.2) do not change. Animal speakers keep the hybrid (InfiniteTalk) result: the face
 * model is for humans. Measured 07.10.2026 (SyncNet LSE-C, same clip): 1.28 -> 5.20; 2.60 -> 4.24; mouth-voice offset
 * -6/-4 frames -> 0.
 *
 * The frames (25 fps, %05d.png) become a temporary mp4, every speaker's track is trimmed to the scene length (LatentSync
 * stretches a longer audio by playing the video back and forth and cuts the video on a shorter one), the output frames
 * are written to the same folder.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runFfmpeg } from '../ffmpeg.mjs';
import { run as runProcess } from '../process.mjs';

/**
 * speakers: [{ name, trace (wav, in scene time), box: [x, y, w, h] video pixels }]; total: frame count of the scene.
 * Returns: { duration (s), speakers: [name] }
 */
export async function fixMouth(ctx, { frameFolder, speakers, total, fps = 25, stage }) {
  const startedAt = Date.now();
  const temp = join(frameFolder, 'mouth');
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  const ff = (a) => runFfmpeg(ctx.setting.ffmpeg, a, { signal: ctx.signal });
  try {
    const input = join(temp, 'input.mp4');
    await ff(['-framerate', String(fps), '-i', join(frameFolder, '%05d.png'), '-frames:v', String(total), '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', input]);
    const duration = total / fps;
    const args = ['--video', input, '--output', join(temp, 'output.mp4')];
    for (const [j, k] of speakers.entries()) {
      const trace = join(temp, `track${j + 1}.wav`);
      await ff(['-i', k.trace, '-af', `apad=whole_dur=${duration}`, '-t', String(duration), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', trace]);
      const [x, y, w, h] = k.box;
      args.push('--speaker', `${trace}@${Math.round(x)},${Math.round(y)},${Math.round(x + w)},${Math.round(y + h)}`);
    }
    const k = ctx.setting.mouthCommand(args);
    await runProcess(k.command, k.args, {
      env: k.env,
      cwd: temp,
      signal: ctx.signal,
      name: 'mouth',
      line: (s) => {
        if (/^(model loaded|speaker \d+\/\d+ done|mouth done)/.test(s)) ctx.progress({ stage, detail: `mouth correction: ${s}` });
        else if (/Error|Traceback/.test(s)) ctx.log(s);
      },
    });
    const output = join(temp, 'output.mp4');
    if (!existsSync(output)) throw new Error('Mouth correction produced no output.');
    // Output frames: first into a folder of their own, in place of the frames when the count matches
    const fresh = join(temp, 'frames');
    mkdirSync(fresh, { recursive: true });
    await ff(['-i', output, '-frames:v', String(total), '-start_number', '1', join(fresh, '%05d.png')]);
    const frames = readdirSync(fresh).filter((d) => /^\d{5}\.png$/.test(d));
    if (frames.length !== total) throw new Error(`Mouth correction returned ${frames.length}/${total} frames.`);
    for (const d of frames) renameSync(join(fresh, d), join(frameFolder, d));
    return { duration: Math.round((Date.now() - startedAt) / 1000), speakers: speakers.map((x) => x.name) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
