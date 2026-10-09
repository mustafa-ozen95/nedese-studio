/**
 * Fake tools\upscale.py: writes the PNG frames of the folder again at --width x --height (a fixed color). Like the real one
 * "progress" and "result" lines; with FAKE_UPSCALE_ERROR=1 it exits with "ERROR:". The options and the printed tokens are
 * checked against the real script (script-contract.mjs).
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePng } from '../lib/media.mjs';
import { expectArgs, expectSource } from './script-contract.mjs';

const SCRIPT = 'tools/upscale.py';
expectArgs(SCRIPT, process.argv.slice(2));
expectSource(SCRIPT, "f'progress {", "'result '", "f'ERROR: {");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
if (process.env.FAKE_UPSCALE_ERROR) {
  console.log('ERROR: Upscale model could not be opened (fake).');
  process.exit(1);
}
const input = arg('--input');
const output = arg('--output') || input;
const width = Number(arg('--width'));
const height = Number(arg('--height'));
if (!arg('--model')) {
  console.log('ERROR: --model missing');
  process.exit(1);
}
const frames = readdirSync(input).filter((d) => d.endsWith('.png')).sort();
frames.forEach((d, i) => {
  writeFileSync(join(output, d), makePng(width, height, [40, 160, 90]));
  if (i % 8 === 0 || i === frames.length - 1) console.log(`progress ${Math.floor((100 * (i + 1)) / frames.length)} ${i + 1}/${frames.length} frames upscaled`);
});
console.log(`result ${JSON.stringify({ frames: frames.length, sec: 0.1 })}`);
