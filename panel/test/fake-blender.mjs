/**
 * Fake Blender (tests): takes the arguments of tools\blender\model3d.py, writes the export files and the turntable
 * frames (PNG) and prints RESULT on the last line. The options, the printed token and the result keys are checked
 * against the real script (script-contract.mjs).
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makePng } from '../lib/media.mjs';
import { expectArgs, expectKeys, expectSource } from './script-contract.mjs';

const SCRIPT = 'tools/blender/model3d.py';
// Like the real call (lib/blender.mjs): blender -b ... -P model3d.py -- --input <glb> --output <folder> --name --frames ...
const a = process.argv.slice(process.argv.indexOf('--') + 1);
expectArgs(SCRIPT, a);
expectSource(SCRIPT, "'RESULT '");
expectKeys(SCRIPT, 'blender', 'triangles', 'files', 'print', 'height', 'size', 'volume', 'watertight', 'solid', 'openEdges', 'engine', 'frames');
const s = {};
for (let i = 0; i < a.length - 1; i += 2) s[a[i].replace(/^--/, '')] = a[i + 1];
if (!existsSync(s.input)) {
  console.error(`GLB missing: ${s.input}`);
  process.exit(1);
}
const files = {};
for (const b of (s.formats ?? '').split(',').filter(Boolean)) {
  const name = b === 'obj' ? `${s.name}-obj.zip` : `${s.name}.${b}`;
  writeFileSync(join(s.output, name), `fake ${b}`);
  files[b] = name;
}
const result = { blender: 'fake 9.9', objects: 1, triangles: 1234, size: [1, 1, 1], files };
if (files.stl) {
  const height = Number(s['print-height']);
  result.print = { file: files.stl, height, size: [height * 0.35, height * 0.21, height], triangles: 5000, openEdges: 0, watertight: true, solid: true, crumbs: 0, volume: 12.5 };
}
const frames = Number(s.frames);
if (frames > 0) {
  const folder = join(s.output, 'frames');
  mkdirSync(folder, { recursive: true });
  for (let i = 1; i <= frames; i++) {
    writeFileSync(join(folder, `${String(i).padStart(4, '0')}.png`), makePng(64, 64, [(i * 7) % 255, 80, 140]));
    console.log(`Fra:${i} Mem:1M | Rendering`);
  }
  result.frames = folder;
  result.engine = 'FAKE';
}
console.log(`RESULT ${JSON.stringify(result)}`);
