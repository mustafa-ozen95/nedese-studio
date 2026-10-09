/**
 * Fake model server for the downloader tests: supports Range (bytes=start- and bytes=start-end); the first request
 * after a flag is set behaves badly: cut: breaks the connection after N bytes; stall: sends N bytes and then nothing;
 * slow: sends N bytes at once, then a trickle of 1 KB every 20 ms. /hf/... redirects like Hugging Face + Xet.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export function fakeServer(data, { noRange = false } = {}) {
  const status = { requests: [], cut: null, stall: null, slow: null };
  const stalled = [];
  const s = createServer((req, response) => {
    const sha = createHash('sha256').update(data).digest('hex');
    // Like Hugging Face + Xet: /hf/... gives the SHA-256 in X-Linked-Etag and redirects to the CDN, whose ETag is
    // another 64-hex digest (Xet), not the SHA-256.
    if (req.url.startsWith('/hf/')) {
      response.writeHead(302, { Location: req.url.replace('/hf/', '/cdn/'), 'X-Linked-Etag': `"${sha}"`, 'X-Linked-Size': data.length });
      response.end();
      return;
    }
    if (req.url.startsWith('/cdn/')) {
      response.writeHead(200, { 'Content-Length': data.length, ETag: `"${'ab'.repeat(32)}"` });
      response.end(req.method === 'HEAD' ? undefined : data);
      return;
    }
    if (req.method === 'HEAD') {
      response.writeHead(200, { 'Content-Length': data.length, 'X-Linked-Etag': `"${sha}"` });
      response.end();
      return;
    }
    status.requests.push(req.headers.range ?? '');
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    let body = data;
    if (m && !noRange) {
      const startedAt = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
      body = data.subarray(startedAt, end + 1);
      response.writeHead(206, { 'Content-Range': `bytes ${startedAt}-${end}/${data.length}`, 'Content-Length': body.length, 'X-Linked-Etag': `"${sha}"` });
    } else {
      response.writeHead(200, { 'Content-Length': data.length, 'X-Linked-Etag': `"${sha}"` });
    }
    // The misbehaviour hits the first real data request, not the panel downloader's one-byte probe.
    if (body.length <= 1) {
      response.end(body);
      return;
    }
    if (status.cut !== null) {
      const n = status.cut;
      status.cut = null;
      // The break comes after the written piece was really sent: waiting 50 ms alone was not enough under load (with
      // the whole suite running, 65326 bytes reached the client and "partial file >= 100000" failed now and then; 06.10.2026)
      response.write(body.subarray(0, n), () => setTimeout(() => response.destroy(), 50));
      return;
    }
    if (status.stall !== null) {
      const n = status.stall;
      status.stall = null;
      response.write(body.subarray(0, n));
      stalled.push(response);
      return;
    }
    if (status.slow !== null) {
      let at = status.slow;
      status.slow = null;
      response.write(body.subarray(0, at));
      const t = setInterval(() => {
        if (at >= body.length) { clearInterval(t); response.end(); return; }
        response.write(body.subarray(at, at + 1024));
        at += 1024;
      }, 20);
      response.on('close', () => clearInterval(t));
      return;
    }
    response.end(body);
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ address: `http://127.0.0.1:${s.address().port}`, status, close: () => { for (const r of stalled) r.destroy(); return new Promise((r) => s.close(r)); } })));
}
