/**
 * Fake tools\sprites.py: writes sprite_<name>.png for every cut-out, a sheet.png and an atlas.json. The options and the
 * printed tokens are checked against the real script (script-contract.mjs). FAKE_SPRITES_ERROR=1: "ERROR:" and exit 1.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectArgs, expectSource } from './script-contract.mjs';

const SCRIPT = 'tools/sprites.py';
expectArgs(SCRIPT, process.argv.slice(2));
expectSource(SCRIPT, "f'progress {", "'RESULT '", "f'ERROR: {", 'cutout_{name}.png', 'sprite_{name}.png', "'atlas.json'", "'sheet.png'");
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
if (process.env.FAKE_SPRITES_ERROR) {
  console.log('ERROR: base: nothing is left after the background removal');
  process.exit(1);
}
const folder = arg('--folder');
const names = argv.slice(argv.indexOf('--names') + 1).filter((a) => !a.startsWith('--') && !/^\d+$/.test(a) && a !== 'center' && a !== 'bottom');
const seen = [];
for (const n of names) {
  const cut = join(folder, `cutout_${n}.png`);
  if (!existsSync(cut)) {
    console.log(`ERROR: ${n}: no cut-out`);
    process.exit(1);
  }
  writeFileSync(join(folder, `sprite_${n}.png`), readFileSync(cut));
  seen.push(n);
}
writeFileSync(join(folder, 'sheet.png'), readFileSync(join(folder, `cutout_${seen[0]}.png`)));
writeFileSync(join(folder, 'atlas.json'), JSON.stringify({ image: 'sheet.png', cell: Number(arg('--cell')), anchor: arg('--anchor'), frames: seen.map((name) => ({ name })) }));
writeFileSync(join(folder, 'sprites-args.json'), JSON.stringify(argv));
console.log(`progress ${seen.length}/${seen.length} sheet`);
console.log('RESULT ' + JSON.stringify({ frames: seen.length }));
