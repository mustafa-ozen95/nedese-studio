/**
 * The Python scripts the panel runs, checked as source (no Python needed):
 *  - every attribute the script reads from its parsed arguments (a.output) is declared by its argparse (--output);
 *    after the English conversion (08.10.2026) the code read a.output while argparse still declared --cikti, so every
 *    voice, lip, upscale and training script stopped at its first line, and the tests with fake scripts all passed
 *  - the fake scripts of the tests refuse an option the real script does not declare (script-contract.mjs)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_ROOT, scriptInterface } from './script-contract.mjs';
import { QUALITY } from '../lib/jobs/common.mjs';

/** Every Python script the panel starts (lib/settings.mjs commands, jobs) and the helpers that share their contract. */
export const PANEL_SCRIPTS = [
  'voice/speak.py',
  'voice/voxcpm/generate.py',
  'voice/ema/generate.py',
  'voice/voxcpm/description.py',
  'voice/design/design.py',
  'voice/design/clone.py',
  'voice/clone/prepare.py',
  'voice/clone/train.py',
  'voice/convert.py',
  'lip/mouth.py',
  'tools/upscale.py',
  'training/train.py',
  'training/image.py',
  'training/general.py',
  'training/music.py',
  'tools/blender/model3d.py',
];

/** Attribute names read from the parsed arguments and the dests argparse declares. */
function argumentUse(script) {
  // without docstrings and comments (usage lines like "--separate a.wav b.wav" are no argument reads)
  const s = readFileSync(resolve(AI_ROOT, script), 'utf8').replace(/("""|''')[\s\S]*?\1/g, '').replace(/^\s*#.*$/gm, '');
  const dests = new Set();
  for (const m of s.matchAll(/add_argument\(([^)]*)\)/g)) {
    const call = m[1];
    const dest = /dest\s*=\s*(['"])(\w+)\1/.exec(call);
    if (dest) {
      dests.add(dest[2]);
      continue;
    }
    const names = [...call.matchAll(/(['"])([^'"]+)\1/g)].map((x) => x[2]);
    const long = names.find((n) => n.startsWith('--')) ?? names.find((n) => !n.startsWith('-'));
    if (long) dests.add(long.replace(/^--?/, '').replace(/-/g, '_'));
  }
  for (const m of s.matchAll(/add_subparsers\([^)]*dest\s*=\s*(['"])(\w+)\1/g)) dests.add(m[2]);
  // the variables that hold the parsed arguments: a = p.parse_args() / a, _ = p.parse_known_args()
  const vars = new Set([...s.matchAll(/^\s*(\w+)(?:\s*,\s*_)?\s*=\s*\w+\.parse_(?:known_)?args\(/gm)].map((m) => m[1]));
  const used = new Set();
  for (const v of vars) for (const m of s.matchAll(new RegExp(`\\b${v}\\.(\\w+)`, 'g'))) used.add(m[1]);
  for (const x of ['add_argument', 'add_subparsers', 'add_parser', 'parse_args', 'parse_known_args', 'error', 'print_help']) used.delete(x);
  return { dests, used, vars };
}

test('Python scripts of the panel: every argument the code reads is declared (no a.output with --cikti)', () => {
  const problems = [];
  for (const script of PANEL_SCRIPTS) {
    const { dests, used, vars } = argumentUse(script);
    assert.ok(vars.size, `${script}: parse_args found`);
    for (const u of used) if (!dests.has(u)) problems.push(`${script}: reads ${u}, argparse declares ${[...dests].join(' ')}`);
  }
  assert.deepEqual(problems, []);
});

test('Python scripts of the panel: options in English (no Turkish leftovers like --cikti, --tohum, --gradyan-yok)', () => {
  const turkish = /^--?(cikti|girdi|klasor|tohum|adim|deneme|metin|referans|dil|ayri|rapor|aday|olc|cihaz|cesitle|dogallik|sadece|konusmaci|yonlendirme|en|boy|veri|temel|devir|oran|baglam|onceki|tam|gradyan|kodlayici|tetik|aciklama|ad|istem|uzunluk|niceleme|boyut|devam|gorsel|lora-klasoru|takas|cozunurluk|buyuk|bicim|kare|zemin)(-|$)/;
  const found = PANEL_SCRIPTS.flatMap((s) => [...scriptInterface(s).options].filter((o) => turkish.test(o)).map((o) => `${s}: ${o}`));
  assert.deepEqual(found, []);
});

test('the voice quality flags of the panel are options of speak.py', () => {
  const { options } = scriptInterface('voice/speak.py');
  for (const q of Object.values(QUALITY)) for (const f of q.args) assert.ok(options.has(f), f);
});

test('a fake script refuses an option the real script does not declare', () => {
  const fake = fileURLToPath(new URL('./fake-upscale.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [fake, '--girdi', 'x', '--model', 'm', '--width', '1', '--height', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /CONTRACT tools\/upscale\.py: the panel passes --girdi/);
});
