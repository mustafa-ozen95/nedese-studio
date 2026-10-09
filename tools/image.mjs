/**
 * Yerel gorsel uretimi (Qwen-Image 20B ya da FLUX.1-schnell), RTX 5070.
 *
 *   node gorsel.mjs "istem (Ingilizce en iyisi)" cikti.png [--en 1664 --boy 928 --tohum 42 --hizli]
 *
 * --hizli: FLUX.1-schnell (~16 sn); varsayilan Qwen-Image (~1 dk, daha guclu).
 * Oneri boyutlar (Qwen): 1664x928 (16:9), 928x1664 (9:16), 1328x1328 (1:1).
 */
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run, files, fluxJob, isReady, qwenJob } from './comfy.mjs';

// Degerli bayraklar (--en 1664) ve tek bayrak (--hizli); geri kalan sirali argumanlar.
const VALUABLE = new Set(['--en', '--height', '--seed']);
const option = {};
const ordered = [];
const input = process.argv.slice(2);
for (let i = 0; i < input.length; i++) {
  if (VALUABLE.has(input[i])) option[input[i].slice(2)] = input[++i];
  else if (input[i].startsWith('--')) option[input[i].slice(2)] = true;
  else ordered.push(input[i]);
}
const flag = (name, v) => option[name] ?? v;
const [prompt, output] = ordered;
if (!prompt || !output) {
  console.log('kullanim: node gorsel.mjs "istem" cikti.png [--en 1664 --boy 928 --tohum 42 --hizli]');
  process.exit(1);
}
if (!(await isReady())) {
  console.error('ComfyUI kapali: C:\\Users\\root\\ai\\baslat_comfyui.bat');
  process.exit(1);
}
const fast = option.fast === true;
const width = Number(flag('en', fast ? 1920 : 1664));
const height = Number(flag('height', fast ? 1088 : 928));
const seed = Number(flag('seed', Math.floor(Math.random() * 1e9)));
const startedAt = Date.now();
const job = (fast ? fluxJob : qwenJob)({ text: prompt, seed, width, height, prefix: 'tools/image' });
copyFileSync(files(await run(job))[0], resolve(output));
console.log(`${resolve(output)} (${width}x${height}, tohum ${seed}, ${((Date.now() - startedAt) / 1000).toFixed(0)} sn)`);
