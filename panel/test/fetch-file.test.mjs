/** setup/fetch-file.mjs: several connections per file, segment map, resume, cut/stall/slow connections, SHA-256. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFile } from '../../setup/fetch-file.mjs';
import { StreamJudge } from '../lib/download.mjs';
import { fakeServer } from './fake-model-server.mjs';

const data = Buffer.alloc(300000);
for (let i = 0; i < data.length; i++) data[i] = (i * 13) % 251;
const sha256 = createHash('sha256').update(data).digest('hex');
const quiet = { log: () => {} };

async function withServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'nedese-fetch-'));
  const server = await fakeServer(data);
  const logs = [];
  const model = (name) => ({ name, url: `${server.address}/${name}.gguf`, target: join(root, 'models', `${name}.gguf`), size: data.length, sha256 });
  try {
    await fn({ root, server, model, logs, options: { log: (s) => logs.push(s), workers: 3, segment: 50000, stallMs: 500, retryDelayMs: 50 } });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('parallel download: 6 segments over 3 connections, verified, map removed', () =>
  withServer(async ({ server, model, options }) => {
    const m = model('plain');
    assert.equal(await downloadFile(m, options), true);
    assert.equal(readFileSync(m.target).equals(data), true);
    assert.ok(!existsSync(`${m.target}.part`) && !existsSync(`${m.target}.part.map`));
    const ranges = server.status.requests.filter((r) => /^bytes=\d+-\d+$/.test(r));
    assert.equal(ranges.length, 6, server.status.requests.join(' '));
    assert.deepEqual(ranges.sort(), ['bytes=0-49999', 'bytes=100000-149999', 'bytes=150000-199999', 'bytes=200000-249999', 'bytes=250000-299999', 'bytes=50000-99999']);
  }));

test('resume: finished segments in the map are not fetched again; an older contiguous .part counts as finished segments', () =>
  withServer(async ({ server, model, options }) => {
    // With a map: segments 0 and 3 done.
    const m = model('mapped');
    const part = `${m.target}.part`;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(m.target, '..'), { recursive: true });
    const scratch = Buffer.alloc(data.length);
    data.copy(scratch, 0, 0, 50000);
    data.copy(scratch, 150000, 150000, 200000);
    writeFileSync(part, scratch.subarray(0, 200000));
    writeFileSync(`${part}.map`, JSON.stringify({ done: [0, 3] }));
    assert.equal(await downloadFile(m, options), true);
    assert.equal(readFileSync(m.target).equals(data), true);
    const ranges = server.status.requests.filter((r) => /^bytes=/.test(r)).sort();
    assert.deepEqual(ranges, ['bytes=100000-149999', 'bytes=200000-249999', 'bytes=250000-299999', 'bytes=50000-99999']);
    // Without a map (a single-stream run of an older version): 120000 contiguous bytes = segments 0 and 1.
    server.status.requests.length = 0;
    const old = model('older');
    writeFileSync(`${old.target}.part`, data.subarray(0, 120000));
    assert.equal(await downloadFile(old, options), true);
    assert.equal(readFileSync(old.target).equals(data), true);
    assert.deepEqual(server.status.requests.filter((r) => /^bytes=/.test(r)).sort(), ['bytes=100000-149999', 'bytes=150000-199999', 'bytes=200000-249999', 'bytes=250000-299999']);
  }));

test('a cut connection resumes its segment from the last byte written; a stalled one is cut after stallMs', () =>
  withServer(async ({ server, model, options, logs }) => {
    server.status.cut = 20000;
    const m = model('cut');
    assert.equal(await downloadFile(m, { ...options, workers: 1 }), true);
    assert.equal(readFileSync(m.target).equals(data), true);
    assert.ok(logs.some((s) => /cut: interrupted \(.*\); attempt 1\/6, resuming in 0 s\./.test(s)), logs.join('\n'));
    assert.ok(server.status.requests.some((r) => /^bytes=[1-9]\d+-49999$/.test(r)), `resumed inside the first segment: ${server.status.requests.join(' ')}`);
    logs.length = 0;
    server.status.stall = 10000;
    const st = model('stalled');
    assert.equal(await downloadFile(st, { ...options, workers: 1 }), true);
    assert.equal(readFileSync(st.target).equals(data), true);
    assert.ok(logs.some((s) => /stalled: interrupted \(no data for 1 s\)/.test(s)), logs.join('\n'));
  }));

test('a crawling connection is cut against the best rate seen and reconnected without using an attempt', () =>
  withServer(async ({ server, model, options, logs }) => {
    const judge = new StreamJudge({ bucketMs: 50, buckets: 3, floor: 1, probes: 0 });
    judge.best = 10 * 2 ** 20; // 10 MB/s seen on an earlier connection
    server.status.slow = 20000;
    const m = model('slow');
    assert.equal(await downloadFile(m, { ...options, judge, workers: 1 }), true);
    assert.equal(readFileSync(m.target).equals(data), true);
    assert.ok(logs.some((s) => /slow: slow stream \([\d.]+ MB\/s against [\d.]+ MB\/s seen before\); reconnecting \(1\/30\)/.test(s)), logs.join('\n'));
    assert.ok(!logs.some((s) => /attempt/.test(s)), 'no attempt used');
  }));

test('wrong SHA-256 or size: the file is deleted and false returned; a server without Range support is an error', () =>
  withServer(async ({ server, model, options, logs }) => {
    const m = { ...model('bad'), sha256: '0'.repeat(64) };
    assert.equal(await downloadFile(m, options), false);
    assert.ok(!existsSync(m.target) && !existsSync(`${m.target}.part`) && !existsSync(`${m.target}.part.map`));
    assert.ok(logs.some((s) => /MISMATCH/.test(s)), logs.join('\n'));
    const noRange = await fakeServer(data, { noRange: true });
    try {
      const n = { ...model('norange'), url: `${noRange.address}/x.gguf` };
      assert.equal(await downloadFile(n, options), false);
      assert.ok(logs.some((s) => /does not support resuming/.test(s)), logs.join('\n'));
      assert.ok(existsSync(`${n.target}.part`), 'the partial file is kept for the next run');
    } finally {
      await noRange.close();
    }
  }));
