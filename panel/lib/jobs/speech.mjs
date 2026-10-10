/**
 * Read aloud: a chat answer read in the panel's own voice (user 10.10.2026: the browser's voice "çok robotik"). The job
 * stays out of the gallery and the job pages (queue.page), only the queue shows it while it runs. The chat keeps the
 * file per answer, so playing it again needs no new job.
 * Turkish goes to EMA Lightning on the CPU (user 10.10.2026: "Ema ile seslendirilebilir"; VoxCPM2 spent 52 s loading
 * for a 3 s answer): one take, no Whisper check, the graphics card and the text model stay where they are, and it runs
 * beside a job that is already running (queue side lane). English: the voice job's flow with VoxCPM2's own voice.
 */
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../errors.mjs';
import { text, speak } from './common.mjs';
import * as voice from './voice.mjs';

export const name = 'Read aloud';

export function validate(g, ctx) {
  const lang = g.lang === 'en' ? 'en' : g.lang === 'tr' || g.lang === undefined ? 'tr' : null;
  if (!lang) throw new UserError('Language must be tr or en.');
  const engine = lang === 'tr' && ctx.setting?.hasEma ? 'ema' : null;
  return { ...voice.validate({ text: text(g.text, 'Text', { max: 5000 }), voice: 'model', lang, quality: 'fast' }, ctx), title: 'Read aloud', engine };
}

export function summary(g) {
  return { title: g.text, detail: `Read aloud · ${g.lang === 'en' ? 'English' : 'Turkish'}` };
}

export const gpuNotNeeded = (g) => g.engine === 'ema';
export const sideLane = (g) => g.engine === 'ema';

export async function run(ctx) {
  const g = ctx.job.input;
  if (g.engine !== 'ema') return voice.run(ctx);
  const startedAt = Date.now();
  ctx.job.voiceName = 'EMA Lightning';
  ctx.progress({ percent: 5, stage: 'Reading aloud' });
  const result = await speak(ctx, {
    lines: [{ id: 'voice', text: g.text }],
    engine: 'ema',
    quick: true,
    select: g,
    folder: join(ctx.folder, 'narration'),
    progress: (ratio, detail) => ctx.progress({ percent: 5 + ratio * 93, stage: 'Reading aloud', detail }),
  });
  const s = result.voice;
  renameSync(s.path, join(ctx.folder, 'voice.wav'));
  ctx.addOutput({ file: 'voice.wav', type: 'voice', duration: Math.round(s.duration * 100) / 100 });
  ctx.log(`Read aloud with EMA Lightning (CPU): ${Math.round(s.duration * 10) / 10} s of audio in ${Math.round((Date.now() - startedAt) / 100) / 10} s.`);
}
