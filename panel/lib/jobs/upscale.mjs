/**
 * 1080p upscaling (Video and One piece): the 720p frames of Wan are upscaled in place to the target size with a 2x AI
 * model (2xNomosUni SPAN, CC-BY-4.0): tools\upscale.py, with the Python of ComfyUI (torch + spandrel). Used while the fine
 * setting "Direct 1080p" is off (the 12 GB default); direct 1080p did not fit this card (measured 06.10.2026).
 */
import { existsSync } from 'node:fs';
import { UserError } from '../errors.mjs';
import { run as runProcess } from '../process.mjs';

/** On validation: without the upscale model the job is refused before it starts. */
export function upscaleModelRequired(setting) {
  if (setting?.upscaleModel && !existsSync(setting.upscaleModel)) {
    throw new UserError('No 1080p upscale model (models\\upscale_models\\2xNomosUni_span_multijpg.safetensors): download "2xNomosUni SPAN" from Settings › Models › catalog.');
  }
}

/**
 * Upscales the PNG frames of the folder to [width, height] in place. The graphics card is freed first: ComfyUI keeps Wan
 * in memory (not freed while the fine setting flushGpu is off). Progress "1080p büyütme: 9/161 kare büyütüldü".
 */
export async function upscaleFrames(ctx, folder, [width, height], stage) {
  ctx.progress({ stage, detail: '1080p upscaling: freeing the graphics card' });
  await ctx.flushVoiceForGpu();
  const k = ctx.setting.upscaleCommand(['--input', folder, '--model', ctx.setting.upscaleModel, '--width', String(width), '--height', String(height)]);
  let last = [];
  await runProcess(k.command, k.args, {
    env: k.env,
    cwd: ctx.folder,
    signal: ctx.signal,
    name: 'upscale',
    line: (s) => {
      last = [...last, s].slice(-12);
      const m = /^progress (\d+) (.*)$/.exec(s);
      if (m) ctx.progress({ stage, detail: `1080p upscaling: ${m[2]}` });
    },
  }).catch((e) => {
    const h = last.find((s) => s.startsWith('ERROR:'));
    throw h ? new UserError(`1080p upscaling: ${h.slice(6).trim()}`) : e;
  });
}
