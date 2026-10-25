/**
 * Fake Blender (tests): runs the script the panel names after -P.
 * - tools\blender\model3d.py: writes the export files and the turntable frames (PNG) and prints RESULT on the last line;
 *   an export of a rigged model says so in its content ("fake fbx rigged").
 * - tools\blender\rig.py: marks each model as rigged (" rigged" appended), writes the test motion frames of --show.
 * - front_projection.py / face_transfer.py append " projected" / " face" to each model; game_copies.py writes each copy
 *   as the full model's content + " copy".
 * The options, the printed token and the result keys are checked against the real script (script-contract.mjs).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePng } from '../lib/media.mjs';
import { expectArgs, expectKeys, expectSource } from './script-contract.mjs';
import { exitIfRunAsTest } from './not-a-test.mjs';

exitIfRunAsTest(import.meta.url);

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
  // Like the real call (lib/jobs/model3d.mjs): -- --picture input.png --fov 39.5 --models model.glb
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

if (/face_transfer\.py$/.test(script)) {
  const SCRIPT = 'tools/blender/face_transfer.py';
  // Like the real call (lib/jobs/model3d.mjs): -- --head head.glb --head-fov 39.5 --head-face [...] --head-size 1024
  //   --fov 39.5 --face [...] --size 1024 --models model.glb
  expectArgs(SCRIPT, a);
  expectSource(SCRIPT, "'RESULT '", 'print(f"Face onto ', "print(f'Head placed");
  expectKeys(SCRIPT, 'device', 'models', 'file', 'moved', 'sampled', 'filled', 'seconds', 'skipped', 'scale', 'residual');
  const value = (name) => a[a.indexOf(name) + 1];
  const head = value('--head');
  // the head is generated and the portrait's picture projected onto it first
  if (!existsSync(head) || !readFileSync(head, 'utf8').endsWith(' projected')) {
    console.error(`Head missing or without its picture: ${head}`);
    process.exit(1);
  }
  for (const name of ['--face', '--head-face']) {
    if (JSON.parse(value(name)).length !== 15) {
      console.error(`Not a face: ${value(name)}`);
      process.exit(1);
    }
  }
  const result = { device: 'FAKE', models: [], scale: 0.42, residual: 0.05 };
  console.log('Head placed: scale 0.420, the face points within 5% of the eye distance');
  for (const m of a.slice(a.indexOf('--models') + 1)) {
    // before the skeleton (exported without an armature)
    if (!existsSync(m) || readFileSync(m, 'utf8').includes(' rigged')) {
      console.error(`Model missing or rigged: ${m}`);
      process.exit(1);
    }
    appendFileSync(m, ' face');
    const file = m.split(/[\\/]/).pop();
    console.log(`Face onto ${file}: 900 vertices, 40000 texels (+120 filled), 2.0 s`);
    result.models.push({ file, moved: 900, sampled: 40000, filled: 120, seconds: 2 });
  }
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

if (/game_copies\.py$/.test(script)) {
  const SCRIPT = 'tools/blender/game_copies.py';
  // Like the real call (lib/jobs/model3d.mjs): -- --full model.glb --copies game.glb:30000:2048 game-lod1.glb:15000:1024
  //   [--focus {"fov":39.5,"face":[...],"size":1024}]
  expectArgs(SCRIPT, a);
  expectSource(SCRIPT, "'RESULT '", 'export_tangents=True', 'Solid shape: ', 'Game copy ');
  expectKeys(SCRIPT, 'device', 'copies', 'file', 'triangles', 'size', 'face', 'seconds', 'fov');
  const value = (name) => a[a.indexOf(name) + 1];
  const full = value('--full');
  // made from the finished model: its picture and face are on it, the skeleton is not yet (the copies get theirs after)
  if (!existsSync(full) || readFileSync(full, 'utf8').includes(' rigged')) {
    console.error(`Model missing or rigged: ${full}`);
    process.exit(1);
  }
  const focus = a.includes('--focus') ? JSON.parse(value('--focus')) : null;
  if (focus && !(focus.fov > 0 && focus.face?.length >= 4 && focus.size > 0)) {
    console.error(`Not a face box: ${value('--focus')}`);
    process.exit(1);
  }
  const end = a.findIndex((x, i) => i > a.indexOf('--copies') && x.startsWith('--'));
  const result = { device: 'FAKE', copies: [] };
  console.log('Solid shape: 500000 triangles, 1.0 s');
  for (const c of a.slice(a.indexOf('--copies') + 1, end < 0 ? a.length : end)) {
    const [, path, triangles, size] = c.match(/^(.+):(\d+):(\d+)$/) ?? [];
    if (!path) {
      console.error(`Not file:triangles:size: ${c}`);
      process.exit(1);
    }
    writeFileSync(path, `${readFileSync(full, 'utf8')} copy`);
    const info = { file: path.split(/[\\/]/).pop(), triangles: Number(triangles), size: Number(size), face: focus ? 100 : 0, seconds: 1 };
    console.log(`Game copy ${info.file}: ${info.triangles} triangles (${info.face} on the face), ${info.size} px, 1.0 s`);
    result.copies.push(info);
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
