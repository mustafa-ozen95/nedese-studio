/**
 * Yerel kareden video (Wan 2.2 I2V A14B, lightx2v 720p damitilmis 4 adim), RTX 5070.
 *
 *   node video.mjs kare.png "hareket istemi (Ingilizce)" cikti_klasoru [--kare 81 --en 1280 --boy 720 --tohum 42 --akici 3]
 *
 * Cikti: cikti_klasoru/0001.png ... (16 fps; --akici N ile RIFE ara karelerle 16*N fps).
 * 81 kare = 5 sn. 720p bir klip RTX 5070'te birkac dakika surer.
 * mp4 icin: ffmpeg -framerate 16 -i klasor/%04d.png -c:v libx264 -pix_fmt yuv420p out.mp4
 */
import { mkdirSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { run, files, toInputPut, isReady, wan14Job } from './comfy.mjs';

const VALUABLE = new Set(['--frame', '--en', '--height', '--seed', '--smooth']);
const option = {};
const ordered = [];
const input = process.argv.slice(2);
for (let i = 0; i < input.length; i++) {
  if (VALUABLE.has(input[i])) option[input[i].slice(2)] = Number(input[++i]);
  else ordered.push(input[i]);
}
const [picturePath, prompt, folder] = ordered;
if (!picturePath || !prompt || !folder) {
  console.log('usage: node video.mjs frame.png "motion" output_folder [--kare 81 --en 1280 --boy 720 --tohum 42 --akici 3]');
  process.exit(1);
}
if (!(await isReady())) {
  console.error('ComfyUI kapali: C:\\Users\\root\\ai\\baslat_comfyui.bat');
  process.exit(1);
}
const startedAt = Date.now();
const picture = toInputPut(resolve(picturePath), `arac_${Date.now()}_${basename(picturePath)}`);
const job = wan14Job({
  picture, text: prompt, seed: option.seed ?? Math.floor(Math.random() * 1e9),
  width: option.width ?? 1280, height: option.height ?? 720, frame: option.frame ?? 81, smooth: option.smooth ?? 1, prefix: 'tools/video',
});
const target = resolve(folder);
mkdirSync(target, { recursive: true });
const list = files(await run(job));
list.forEach((d, i) => renameSync(d, join(target, `${String(i + 1).padStart(4, '0')}.png`)));
console.log(`${target}: ${list.length} kare, ${((Date.now() - startedAt) / 1000).toFixed(0)} sn`);
