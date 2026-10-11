/**
 * Fake Blender (tests): runs the script the panel names after -P.
 * - tools\blender\model3d.py: writes the export files and the turntable frames (PNG) and prints RESULT on the last line;
 *   an export of a rigged model says so in its content ("fake fbx rigged").
 * - tools\blender\rig.py: marks each model as rigged (" rigged" appended), writes the test motion frames of --show.
 * The options, the printed token and the result keys are checked against the real script (script-contract.mjs).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePng } from '../lib/media.mjs';
import { expectArgs, expectKeys, expectSource } from './script-contract.mjs';

const script = process.argv[process.argv.indexOf('-P') + 1] ?? '';
const a = process.argv.slice(process.argv.indexOf('--') + 1);

function writeFrames(output, frames) {
  const folder = join(output, 'frames');
  mkdirSync(folder, { recursive: true });
  for (let i = 1; i <= frames; i++) {
    writeFileSync(join(folder, `${String(i).padStart(4, '0')}.png`), makePng(64, 64, [(i * 7) % 255, 80, 140]));
    console.log(`Fra:${i} Mem:1M | Rendering`);
  }
  return folder;
}

if (/rig\.py$/.test(script)) {
  const SCRIPT = 'tools/blender/rig.py';
  // Like the real call (lib/jobs/model3d.mjs): -- --npz rig.npz --models a.glb b.glb --show a.glb --output <folder> ...
  expectArgs(SCRIPT, a);
  expectSource(SCRIPT, "'RESULT '", 'print(f"Rigged ');
  expectKeys(SCRIPT, 'bones', 'models', 'file', 'vertices', 'weighted', 'frames');
  const value = (name) => a[a.indexOf(name) + 1];
  if (!existsSync(value('--npz'))) {
    console.error(`Analysis missing: ${value('--npz')}`);
    process.exit(1);
  }
  const start = a.indexOf('--models') + 1;
  const end = a.findIndex((x, i) => i >= start && x.startsWith('--'));
  const result = { bones: 52, models: [] };
  for (const m of a.slice(start, end < 0 ? a.length : end)) {
    if (!existsSync(m)) {
      console.error(`Model missing: ${m}`);
      process.exit(1);
    }
    appendFileSync(m, ' rigged');
    const file = m.split(/[\\/]/).pop();
    console.log(`Rigged ${file}: 100/100 vertices`);
    result.models.push({ file, vertices: 100, weighted: 100 });
  }
  if (a.includes('--show')) result.frames = writeFrames(value('--output'), Number(value('--frames')));
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

if (/front_projection\.py$/.test(script)) {
  const SCRIPT = 'tools/blender/front_projection.py';
  // Like the real call (lib/jobs/model3d.mjs): -- --picture input.png --fov 39.5 --models model.glb game.glb ...
  expectArgs(SCRIPT, a);
  expectSource(SCRIPT, "'RESULT '");
  expectKeys(SCRIPT, 'device', 'fov', 'models', 'file', 'size', 'share', 'seconds', 'skipped');
  const value = (name) => a[a.indexOf(name) + 1];
  if (!existsSync(value('--picture')) || !(Number(value('--fov')) > 0)) {
    console.error(`Picture or field of view missing: ${value('--picture')} ${value('--fov')}`);
    process.exit(1);
  }
  const result = { device: 'FAKE', fov: Number(value('--fov')), models: [] };
  for (const m of a.slice(a.indexOf('--models') + 1)) {
    // the real script exports a model without an armature: a rigged model would lose its skeleton
    if (!existsSync(m) || readFileSync(m, 'utf8').includes(' rigged')) {
      console.error(`Model missing or rigged: ${m}`);
      process.exit(1);
    }
    appendFileSync(m, ' projected');
    const file = m.split(/[\\/]/).pop();
    console.log(`Projected onto ${file}: 12% of 2048 px, 1.0 s`);
    result.models.push({ file, size: 2048, share: 0.12, seconds: 1 });
  }
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

if (/game_normals\.py$/.test(script)) {
  const SCRIPT = 'tools/blender/game_normals.py';
  // Like the real call (lib/jobs/model3d.mjs): -- --full model.glb --copies game.glb game-lod1.glb
  expectArgs(SCRIPT, a);
  expectSource(SCRIPT, "'RESULT '", 'export_tangents=True');
  expectKeys(SCRIPT, 'device', 'copies', 'file', 'size', 'seconds', 'skipped');
  const full = a[a.indexOf('--full') + 1];
  if (!existsSync(full)) {
    console.error(`Model missing: ${full}`);
    process.exit(1);
  }
  const result = { device: 'FAKE', copies: [] };
  for (const m of a.slice(a.indexOf('--copies') + 1)) {
    // the real script exports a copy without an armature: a rigged copy would lose its skeleton
    if (!existsSync(m) || readFileSync(m, 'utf8').includes(' rigged')) {
      console.error(`Copy missing or rigged: ${m}`);
      process.exit(1);
    }
    appendFileSync(m, ' normals');
    const file = m.split(/[\\/]/).pop();
    console.log(`Normal map ${file}: 2048 px, 1.0 s`);
    result.copies.push({ file, size: 2048, seconds: 1 });
  }
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

const SCRIPT = 'tools/blender/model3d.py';
// Like the real call (lib/blender.mjs): blender -b ... -P model3d.py -- --input <glb> --output <folder> --name --frames ...
expectArgs(SCRIPT, a);
expectSource(SCRIPT, "'RESULT '");
expectKeys(SCRIPT, 'blender', 'triangles', 'files', 'print', 'height', 'size', 'volume', 'watertight', 'solid', 'openEdges', 'engine', 'frames', 'view');
const s = {};
for (let i = 0; i < a.length - 1; i += 2) s[a[i].replace(/^--/, '')] = a[i + 1];
if (!existsSync(s.input)) {
  console.error(`Model missing: ${s.input}`);
  process.exit(1);
}
// like the real import: a model it cannot read stops the run
if (!/\.(glb|gltf|fbx|obj|stl|ply)$/i.test(s.input)) {
  console.error('Unsupported 3D model format');
  process.exit(1);
}
// like the real export: the skeleton of a rigged model goes into its exports
const rigged = readFileSync(s.input, 'utf8').endsWith(' rigged') ? ' rigged' : '';
const files = {};
for (const b of (s.formats ?? '').split(',').filter(Boolean)) {
  const name = b === 'obj' ? `${s.name}-obj.zip` : `${s.name}.${b}`;
  writeFileSync(join(s.output, name), `fake ${b}${rigged}`);
  files[b] = name;
}
// the triangles Blender reads: a LOD half of its copy; FAKE_BLENDER_TRIANGLES ({"name": n}) sets them per export name
const triangles = JSON.parse(process.env.FAKE_BLENDER_TRIANGLES || '{}')[s.name] ?? (/lod/.test(s.name ?? '') ? 617 : 1234);
const result = { blender: 'fake 9.9', objects: 1, triangles, size: [1, 1, 1], files };
if (s.view) {
  writeFileSync(s.view, makePng(64, 64, [200, 200, 200]));
  result.view = s.view.split(/[\\/]/).pop();
}
if (files.stl) {
  const height = Number(s['print-height']);
  result.print = { file: files.stl, height, size: [height * 0.35, height * 0.21, height], triangles: 5000, openEdges: 0, watertight: true, solid: true, crumbs: 0, volume: 12.5 };
}
const frames = Number(s.frames);
if (frames > 0) {
  result.frames = writeFrames(s.output, frames);
  result.engine = 'FAKE';
}
console.log(`RESULT ${JSON.stringify(result)}`);
