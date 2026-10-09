/**
 * Model downloader (called by setup.bat): downloads the model files the panel's workflows use from the CATALOG in
 * panel/lib/models.mjs, several connections per file (setup/fetch-file.mjs). A half-finished file (.part + .part.map)
 * resumes where it stopped; the size and SHA-256 of every finished file are compared with the catalog.
 *
 *   node setup/download-models.mjs                       download what is missing
 *   node setup/download-models.mjs --list                only print what would be downloaded
 *   node setup/download-models.mjs --skip wanJob,fluxJob skip the models of these workflows
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadFile } from './fetch-file.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ROOT = join(ROOT, 'models');
const { CATALOG, usedFiles, isDefaultModel } = await import(pathToFileURL(join(ROOT, 'panel', 'lib', 'models.mjs')).href);
const comfy = await import(pathToFileURL(join(ROOT, 'tools', 'comfy.mjs')).href);
const { StreamJudge } = await import(pathToFileURL(join(ROOT, 'panel', 'lib', 'download.mjs')).href);

const arg = process.argv.slice(2);
const skipPlace = arg.indexOf('--skip');
const skip = new Set(skipPlace >= 0 ? (arg[skipPlace + 1] ?? '').split(',').filter(Boolean) : []);
const onlyList = arg.includes('--list');

// RIFE frame interpolation model (ComfyUI-Frame-Interpolation looks for it in its own folder).
const RIFE = {
  name: 'RIFE 4.9 (frame interpolation)',
  target: join(ROOT, 'ComfyUI_windows_portable', 'ComfyUI', 'custom_nodes', 'ComfyUI-Frame-Interpolation', 'ckpts', 'rife', 'rife49.pth'),
  url: 'https://huggingface.co/marduk191/rife/resolve/main/rife49.pth',
  size: 21345274,
  sha256: 'e55fd00f3cc184e3c65961f4bb827a9da022e78eed36b055242c0ac30000d533',
};

// The default set (every model except alternative quantizations); --skip drops the models only the skipped workflows use.
const used = usedFiles(comfy);
const list = [];
for (const k of CATALOG) {
  if (!isDefaultModel(k)) continue;
  const generators = used[`${k.folder}/${k.file}`];
  if (generators && generators.every((u) => skip.has(u))) continue;
  list.push({ name: k.name, target: join(MODEL_ROOT, k.folder, k.file), url: k.url, size: k.size, sha256: k.sha256 });
}
list.push(RIFE);

const gb = (b) => `${(b / 2 ** 30).toFixed(1)} GB`;
const missing = list.filter((m) => !(existsSync(m.target) && statSync(m.target).size === m.size));
console.log(`Models: ${list.length} files, ${gb(list.reduce((a, m) => a + m.size, 0))}; to download ${missing.length} files, ${gb(missing.reduce((a, m) => a + m.size, 0))}.`);
for (const m of missing) console.log(`  - ${m.name} (${gb(m.size)})`);
if (onlyList) process.exit(0);

// The best speed seen is shared across files: a connection that crawls compared with it is cut and reconnected.
const judge = new StreamJudge();
let error = 0;
for (const m of missing) if (!(await downloadFile(m, { judge }))) error++;
if (error) {
  console.log(`ERROR: ${error} models could not be downloaded. Run setup.bat again; the downloaded parts are kept.`);
  process.exit(1);
}
console.log('Models done.');
