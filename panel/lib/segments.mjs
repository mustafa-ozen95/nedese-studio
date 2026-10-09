/**
 * Segmented download shared by the panel's downloader (Settings > Models) and setup\download-models.mjs: several
 * connections at once (the CDN hands out fast and slow connections at random: 0.7 to 25 MB/s to the same file within
 * a minute, 09.10.2026; 8 connections gave 22 MB/s where one gave 1-2), each fetching 64 MB segments with HTTP Range
 * into one partial file; the finished segments are listed in <partial>.map so an interrupted download continues
 * where it stopped. A connection that stops delivering for stallMs, or that crawls compared with the fastest one
 * (StreamJudge), is cut and its segment resumed on a fresh connection.
 *
 *   await fetchSegments({ url, path, size, signal, judge, onProgress }) -> resolves when the file is complete
 *   (the map is deleted); throws when it could not be completed ('cancelled' when the signal aborted).
 *   bytesDone(path, size) -> bytes of the partial file that are complete (for progress after a restart).
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';

export const SEGMENT = 64 * 2 ** 20;
const SLOW_CUTS = 30;

/** The segments of a file: [start, end] byte ranges (inclusive). */
function segmentsOf(size, segment) {
  const out = [];
  for (let start = 0; start < size; start += segment) out.push([start, Math.min(size, start + segment) - 1]);
  return out;
}

/** Finished segments of a partial file: from the map, else (a contiguous single-stream file) whatever fits its size. */
function readMap(path, size, mapPath, fallback = SEGMENT) {
  if (!existsSync(path)) return { segment: fallback, done: new Set() };
  if (existsSync(mapPath)) {
    try {
      const map = JSON.parse(readFileSync(mapPath, 'utf8'));
      const segment = Number(map.segment) > 0 ? Number(map.segment) : fallback;
      const count = segmentsOf(size, segment).length;
      return { segment, done: new Set((map.done ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < count)) };
    } catch {
      return { segment: fallback, done: new Set() };
    }
  }
  const have = statSync(path).size;
  const done = new Set();
  segmentsOf(size, fallback).forEach(([, end], i) => { if (end < have) done.add(i); });
  return { segment: fallback, done };
}

export function bytesDone(path, size, mapPath = `${path}.map`) {
  if (!size || !existsSync(path)) return 0;
  const { segment, done } = readMap(path, size, mapPath);
  const parts = segmentsOf(size, segment);
  return [...done].reduce((a, i) => a + parts[i][1] - parts[i][0] + 1, 0);
}

export async function fetchSegments({ url, path, size, mapPath = `${path}.map`, signal = null, judge = null, workers = 8, segment = SEGMENT, stallMs = 30000, retryDelayMs = 10000, attempts = 6, log = () => {}, onProgress = () => {} }) {
  if (existsSync(path) && statSync(path).size > size) {
    rmSync(path);
    rmSync(mapPath, { force: true });
  }
  const known = readMap(path, size, mapPath, segment);
  const parts = segmentsOf(size, known.segment);
  const done = known.done;
  const pending = parts.map((_, i) => i).filter((i) => !done.has(i));
  let downloaded = [...done].reduce((a, i) => a + parts[i][1] - parts[i][0] + 1, 0);
  onProgress(downloaded);
  if (!pending.length) {
    rmSync(mapPath, { force: true });
    return;
  }
  const fd = openSync(path, existsSync(path) ? 'r+' : 'w');
  const saveMap = () => writeFileSync(mapPath, JSON.stringify({ segment: parts[0][1] - parts[0][0] + 1, done: [...done].sort((a, b) => a - b) }));
  let slowCuts = 0;
  let failed = null;
  const controls = new Set();
  const cancel = () => { for (const c of controls) c.abort(new Error('cancelled')); };
  signal?.addEventListener('abort', cancel, { once: true });
  const sleep = (ms) => new Promise((ok) => { const t = setTimeout(ok, ms); signal?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });

  // One segment: up to `attempts` connections, resumed from the last byte written; a slow cut costs no attempt.
  const fetchSegment = async (s) => {
    const [start, end] = parts[s];
    let position = start;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (signal?.aborted) throw new Error('cancelled');
      if (failed) throw failed;
      const control = new AbortController();
      controls.add(control);
      let watchdog = setTimeout(() => control.abort(new Error(`no data for ${Math.round(stallMs / 1000)} s`)), stallMs);
      let received = 0;
      let slow = null;
      try {
        const y = await fetch(url, { headers: { Range: `bytes=${position}-${end}` }, redirect: 'follow', signal: control.signal });
        if (y.status !== 206) throw new Error(y.status === 200 ? 'the server does not support resuming (no Range)' : `HTTP ${y.status}`);
        const connection = judge?.connection();
        for await (const p of y.body) {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => control.abort(new Error(`no data for ${Math.round(stallMs / 1000)} s`)), stallMs);
          const n = Math.min(p.length, end + 1 - position);
          writeSync(fd, p, 0, n, position);
          position += n;
          received += n;
          downloaded += n;
          onProgress(downloaded);
          if (n < p.length) break;
          const verdict = connection?.feed(n);
          if (verdict && slowCuts < SLOW_CUTS) {
            slowCuts++;
            slow = `${verdict}; reconnecting (${slowCuts}/${SLOW_CUTS})`;
            judge.cut();
            control.abort(new Error(slow));
          }
        }
        if (position === end + 1) return;
        throw new Error(`the connection ended after ${received} bytes`);
      } catch (e) {
        if (signal?.aborted) throw new Error('cancelled');
        if (slow) {
          log(slow);
          attempt--;
          continue;
        }
        const reason = control.signal.aborted ? control.signal.reason?.message ?? 'stalled' : e.message;
        if (/does not support resuming|^HTTP 4/.test(reason)) throw new Error(reason);
        log(`interrupted (${reason}); attempt ${attempt}/${attempts}, resuming in ${Math.round(retryDelayMs / 1000)} s`);
        await sleep(retryDelayMs);
      } finally {
        clearTimeout(watchdog);
        controls.delete(control);
      }
    }
    throw new Error(`segment ${s + 1}/${parts.length} could not be downloaded after ${attempts} attempts`);
  };
  const worker = async () => {
    while (pending.length && !failed) {
      const s = pending.shift();
      try {
        await fetchSegment(s);
        done.add(s);
        saveMap();
      } catch (e) {
        failed ??= e;
        cancel();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, worker));
  } finally {
    closeSync(fd);
    signal?.removeEventListener('abort', cancel);
  }
  if (failed) throw failed;
  rmSync(mapPath, { force: true });
}
