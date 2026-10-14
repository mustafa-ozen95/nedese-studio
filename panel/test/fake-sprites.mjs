/**
 * Fake tools\sprites.py: writes sprite_<name>.png for every cut-out (or tile_<name>.png for every source in the tiles
 * mode), a sheet, an atlas and a zip. The options and the printed tokens are checked against the real script
 * (script-contract.mjs). FAKE_SPRITES_ERROR=1: "ERROR:" and exit 1. Every call is appended to sprites-calls.json.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectArgs, expectSource } from './script-contract.mjs';

const SCRIPT = 'tools/sprites.py';
expectArgs(SCRIPT, process.argv.slice(2));
expectSource(SCRIPT, "f'progress {", "'RESULT '", "f'ERROR: {", 'cutout_{name}.png', 'sprite_{name}.png', 'source_{name}.png', 'tile_{name}.png', "{a.prefix}atlas.json", "{a.prefix}sheet.png", "{a.prefix}sprites.zip", "{a.prefix}animation.webp", "'loop'", "'closure'");
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
if (process.env.FAKE_SPRITES_ERROR) {
  console.log('ERROR: base: nothing is left after the background removal');
  process.exit(1);
}
if (arg('--mode') === 'loop') {
  // the picks: evenly spaced files of the first 30 frames (a loop of 30), with --whole of all but the last;
  // FAKE_SPRITES_CLOSURE sets the difference (--whole: 1)
  const dir = arg('--frames');
  const files = readdirSync(dir).filter((x) => x.endsWith('.png')).sort();
  const count = Number(arg('--count'));
  const whole = argv.includes('--whole');
  const length = whole ? files.length - 1 : Math.min(30, files.length);
  const picks = Array.from({ length: count }, (_, i) => files[Math.min(length - 1, Math.round((i * length) / count))]);
  const log = join(dir, '..', 'sprites-calls.json');
  const before = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : [];
  writeFileSync(log, JSON.stringify([...before, argv]));
  console.log('RESULT ' + JSON.stringify({ files: picks, length, closure: whole ? 1 : Number(process.env.FAKE_SPRITES_CLOSURE ?? 3.5), frames: files.length }));
  process.exit(0);
}
const folder = arg('--folder');
const prefix = arg('--prefix') ?? '';
const tiles = arg('--mode') === 'tiles';
const names = argv.slice(argv.indexOf('--names') + 1);
const seen = [];
for (const n of names) {
  const from = join(folder, tiles ? `source_${n}.png` : `cutout_${n}.png`);
  if (!existsSync(from)) {
    console.log(`ERROR: ${n}: no ${tiles ? 'source' : 'cut-out'}`);
    process.exit(1);
  }
  writeFileSync(join(folder, tiles ? `tile_${n}.png` : `sprite_${n}.png`), readFileSync(from));
  seen.push(n);
}
const first = readFileSync(join(folder, tiles ? `source_${seen[0]}.png` : `cutout_${seen[0]}.png`));
writeFileSync(join(folder, `${prefix}sheet.png`), first);
writeFileSync(join(folder, `${prefix}atlas.json`), JSON.stringify({ image: `${prefix}sheet.png`, cell: Number(arg('--cell')), anchor: arg('--anchor'), fps: arg('--fps') ? Number(arg('--fps')) : undefined, frames: seen.map((name) => ({ name })) }));
writeFileSync(join(folder, `${prefix}sprites.zip`), 'zip');
if (arg('--fps')) writeFileSync(join(folder, `${prefix}animation.webp`), first);
if (tiles) writeFileSync(join(folder, 'tile-preview.png'), first);
const calls = existsSync(join(folder, 'sprites-calls.json')) ? JSON.parse(readFileSync(join(folder, 'sprites-calls.json'), 'utf8')) : [];
calls.push(argv);
writeFileSync(join(folder, 'sprites-calls.json'), JSON.stringify(calls));
console.log(`progress ${seen.length}/${seen.length} sheet`);
console.log('RESULT ' + JSON.stringify({ frames: seen.length }));
