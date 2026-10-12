/**
 * Fake tools\face_points.py: the faces of each picture from FAKE_FACES ({"<file name>": [[x, y, w, h, ..., score]]});
 * a picture not named there has none. The options and the printed token are checked against the real script
 * (script-contract.mjs).
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { expectArgs, expectKeys, expectSource } from './script-contract.mjs';

const SCRIPT = 'tools/face_points.py';
const a = process.argv.slice(2);
expectArgs(SCRIPT, a);
expectSource(SCRIPT, "'RESULT '");
expectKeys(SCRIPT, 'pictures', 'file', 'width', 'height', 'faces');
const model = a[a.indexOf('--model') + 1];
if (!existsSync(model)) {
  console.log(`ERROR: no model ${model}`);
  process.exit(1);
}
const faces = JSON.parse(process.env.FAKE_FACES || '{}');
const pictures = [];
for (const path of a.slice(a.indexOf('--pictures') + 1)) {
  if (!existsSync(path)) {
    console.log(`ERROR: cannot read ${path}`);
    process.exit(1);
  }
  pictures.push({ file: basename(path), width: 1024, height: 1024, faces: faces[basename(path)] ?? [] });
}
console.log(`RESULT ${JSON.stringify({ pictures })}`);
