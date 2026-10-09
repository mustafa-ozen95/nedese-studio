/**
 * Large-file download used by setup\download-models.mjs: several connections per file (panel\lib\segments.mjs) into
 * <target>.part, resumed from <target>.part.map after an interruption; the finished file's size and SHA-256 are
 * checked against the catalog.
 *
 *   await downloadFile({ name, url, target, size, sha256 }, { judge, log, workers, segment })
 *   -> true when the file is complete and verified, false when it could not be downloaded.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchSegments } from '../panel/lib/segments.mjs';

const gb = (b) => `${(b / 2 ** 30).toFixed(1)} GB`;

async function computeSha(path) {
  const h = createHash('sha256');
  for await (const p of createReadStream(path, { highWaterMark: 8 * 2 ** 20 })) h.update(p);
  return h.digest('hex');
}

export async function downloadFile(m, { judge, log = console.log, workers = 8, segment, stallMs, retryDelayMs } = {}) {
  mkdirSync(dirname(m.target), { recursive: true });
  const part = `${m.target}.part`;
  const mapPath = `${part}.map`;
  let downloaded = 0;
  let lastDownloaded = 0;
  let lastTime = Date.now();
  const printer = setInterval(() => {
    const now = Date.now();
    const speed = (downloaded - lastDownloaded) / ((now - lastTime) / 1000);
    lastDownloaded = downloaded;
    lastTime = now;
    process.stdout.write(`\r  ${m.name}: ${gb(downloaded)} / ${gb(m.size)}  ${(speed / 2 ** 20).toFixed(1)} MB/s   `);
  }, 5000);
  try {
    await fetchSegments({
      url: m.url, path: part, size: m.size, mapPath, judge, workers, segment, stallMs, retryDelayMs,
      log: (s) => log(`\n  ${m.name}: ${s}.`),
      onProgress: (n) => { if (!lastDownloaded) lastDownloaded = n; downloaded = n; },
    });
  } catch (e) {
    log(`\n  ${m.name}: ${e.message}.`);
    return false;
  } finally {
    clearInterval(printer);
    process.stdout.write('\n');
  }
  const size = statSync(part).size;
  if (size !== m.size) {
    log(`  ${m.name}: size ${size} != ${m.size}; the file is deleted, run setup.bat again.`);
    rmSync(part);
    rmSync(mapPath, { force: true });
    return false;
  }
  process.stdout.write(`  ${m.name}: checking SHA-256... `);
  const sha = await computeSha(part);
  if (sha !== m.sha256) {
    log(`MISMATCH (${sha.slice(0, 12)}...); the file is deleted, run setup.bat again.`);
    rmSync(part);
    rmSync(mapPath, { force: true });
    return false;
  }
  renameSync(part, m.target);
  log('done.');
  return true;
}
