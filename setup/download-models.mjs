/**
 * Model downloader (called by setup.bat): downloads the model files the panel's workflows use from the CATALOG in
 * panel/lib/models.mjs. A half-finished file (.part) resumes where it stopped (HTTP Range); the size and SHA-256 of
 * every finished file are compared with the catalog.
 *
 *   node setup/download-models.mjs                       download what is missing
 *   node setup/download-models.mjs --list                only print what would be downloaded
 *   node setup/download-models.mjs --skip wanJob,fluxJob skip the models of these workflows
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ROOT = join(ROOT, 'models');
const { CATALOG, usedFiles } = await import(pathToFileURL(join(ROOT, 'panel', 'lib', 'models.mjs')).href);
const comfy = await import(pathToFileURL(join(ROOT, 'tools', 'comfy.mjs')).href);

const STALL_MS = 30000;
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

const used = usedFiles(comfy);
const list = [];
for (const k of CATALOG) {
  const generators = used[`${k.folder}/${k.file}`];
  if (!generators || generators.every((u) => skip.has(u))) continue;
  list.push({ name: k.name, target: join(MODEL_ROOT, k.folder, k.file), url: k.url, size: k.size, sha256: k.sha256 });
}
list.push(RIFE);

const gb = (b) => `${(b / 2 ** 30).toFixed(1)} GB`;
const missing = list.filter((m) => !(existsSync(m.target) && statSync(m.target).size === m.size));
console.log(`Models: ${list.length} files, ${gb(list.reduce((a, m) => a + m.size, 0))}; to download ${missing.length} files, ${gb(missing.reduce((a, m) => a + m.size, 0))}.`);
for (const m of missing) console.log(`  - ${m.name} (${gb(m.size)})`);
if (onlyList) process.exit(0);

async function computeSha(path) {
  const h = createHash('sha256');
  for await (const p of createReadStream(path, { highWaterMark: 8 * 2 ** 20 })) h.update(p);
  return h.digest('hex');
}

async function download(m) {
  mkdirSync(dirname(m.target), { recursive: true });
  const part = `${m.target}.part`;
  for (let trial = 1; trial <= 6; trial++) {
    const exists = existsSync(part) ? statSync(part).size : 0;
    if (exists > m.size) rmSync(part);
    const startedAt = existsSync(part) ? statSync(part).size : 0;
    if (startedAt < m.size) {
      // A stream that stops delivering (a CDN connection decaying to a few KB/s, seen 09.10.2026) is cut after
      // STALL_MS without data and resumed with Range on a fresh connection.
      const control = new AbortController();
      let watchdog = setTimeout(() => control.abort(new Error('no data for 30 s')), STALL_MS);
      try {
        const y = await fetch(m.url, { headers: startedAt ? { Range: `bytes=${startedAt}-` } : {}, redirect: 'follow', signal: control.signal });
        if (!(y.status === 200 || y.status === 206)) throw new Error(`HTTP ${y.status}`);
        // If the server ignores the Range (200) the file is written from the start.
        const add = startedAt > 0 && y.status === 206;
        const printer = createWriteStream(part, { flags: add ? 'a' : 'w' });
        let downloaded = add ? startedAt : 0;
        let lastText = 0;
        let lastDownloaded = downloaded;
        let lastTime = Date.now();
        for await (const p of y.body) {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => control.abort(new Error('no data for 30 s')), STALL_MS);
          if (!printer.write(p)) await new Promise((ok) => printer.once('drain', ok));
          downloaded += p.length;
          const now = Date.now();
          if (now - lastText > 5000) {
            const speed = (downloaded - lastDownloaded) / ((now - lastTime) / 1000);
            process.stdout.write(`\r  ${m.name}: ${gb(downloaded)} / ${gb(m.size)}  ${(speed / 2 ** 20).toFixed(1)} MB/s   `);
            lastText = now;
            lastDownloaded = downloaded;
            lastTime = now;
          }
        }
        await new Promise((ok, red) => printer.end((h) => (h ? red(h) : ok())));
        process.stdout.write('\n');
      } catch (e) {
        const reason = control.signal.aborted ? control.signal.reason?.message ?? 'stalled' : e.message;
        console.log(`\n  ${m.name}: interrupted (${reason}); attempt ${trial}, resuming in 10 s.`);
        await new Promise((ok) => setTimeout(ok, 10000));
        continue;
      } finally {
        clearTimeout(watchdog);
      }
    }
    const size = statSync(part).size;
    if (size !== m.size) {
      console.log(`  ${m.name}: size ${size} != ${m.size}, trying again.`);
      continue;
    }
    process.stdout.write(`  ${m.name}: checking SHA-256... `);
    const sha = await computeSha(part);
    if (sha !== m.sha256) {
      console.log(`MISMATCH (${sha.slice(0, 12)}...), the file is deleted and downloaded again.`);
      rmSync(part);
      continue;
    }
    renameSync(part, m.target);
    console.log('done.');
    return true;
  }
  return false;
}

let error = 0;
for (const m of missing) if (!(await download(m))) error++;
if (error) {
  console.log(`ERROR: ${error} models could not be downloaded. Run setup.bat again; the downloaded parts are kept.`);
  process.exit(1);
}
console.log('Models done.');
