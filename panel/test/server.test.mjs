/**
 * HTTP: arayuz dosyalari, JSON API, guvenlik (Host / Origin), dosya sunumu (Range, yol disi).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { exifOrientation, imageSize, makePng } from '../lib/media.mjs';

/** Ham istek (fetch Host/Origin basligini degistirtmez). */
function req(address, path, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(address);
  return new Promise((ok, red) => {
    const r = request({ host: u.hostname, port: u.port, path: path, method: method, headers: headers }, (y) => {
      const parts = [];
      y.on('data', (p) => parts.push(p));
      y.on('end', () => ok({ code: y.statusCode, headers: y.headers, body: Buffer.concat(parts) }));
    });
    r.on('error', red);
    if (body) r.write(body);
    r.end();
  });
}

test('UI, API and security', async () => {
  const p = await createPanel({ server: true });
  const host = new URL(p.address).host;
  try {
    const ana = await req(p.address, '/');
    assert.equal(ana.code, 200);
    assert.match(ana.headers['content-type'], /text\/html/);
    const html = ana.body.toString('utf8');
    assert.match(html, /<link rel="stylesheet" href=".\/css\/app.css">/);
    // Yüklenen kaynak (betik, stil, görsel, yazı tipi) dışarıdan gelmez; düz bağlantı (<a href>, alt bilgi) serbest.
    assert.doesNotMatch(html, /fonts\.googleapis|cdn\.|<(?:script|link|img|source|iframe)\b[^>]*\b(?:src|href)="https?:\/\/(?!127)/, 'offline: no external resources');

    const css = await req(p.address, '/css/app.css');
    assert.match(css.headers['content-type'], /text\/css/);
    const font = await req(p.address, '/fonts/public-sans-latin-ext.woff2');
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.equal(font.body.subarray(0, 4).toString('ascii'), 'wOF2');
    for (const js of ['/lang/dictionary.js', '/js/lang.js', '/js/design.js', '/js/modal.js', '/js/image-viewer.js', '/app.js', '/settings.js', '/js/markdown.js', '/chat.js']) assert.equal((await req(p.address, js)).code, 200, js);
    assert.equal((await req(p.address, '/favicon.ico')).code, 200);

    // Host basligi: yalnizca 127.0.0.1/localhost (DNS yeniden baglama).
    assert.equal((await req(p.address, '/api/status', { headers: { Host: 'kotu.example:80' } })).code, 403);

    const status = JSON.parse((await req(p.address, '/api/status')).body);
    assert.equal(status.comfy.running, true);
    assert.ok(status.ram.totalMb > 0);
    const option = JSON.parse((await req(p.address, '/api/options')).body);
    assert.deepEqual(option.imageModels.map((m) => m.id), ['qwen', 'flux']);
    assert.match(option.imageModels[0].files[0], /^qwen-image-.*\.gguf$/, 'model name from comfy.mjs');

    // POST: Origin yoksa X-Panel sart; baska kaynak reddedilir.
    const body = JSON.stringify({ type: 'image', prompt: 'x', model: 'flux' });
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await req(p.address, '/api/job', { method: 'POST', headers: json, body })).code, 403);
    assert.equal((await req(p.address, '/api/job', { method: 'POST', headers: { ...json, Origin: 'https://kotu.example' }, body })).code, 403);
    const failed = await req(p.address, '/api/job', { method: 'POST', headers: { ...json, 'X-Panel': '1' }, body: JSON.stringify({ type: 'image', prompt: ' ' }) });
    assert.equal(failed.code, 400);
    assert.equal(JSON.parse(failed.body).error, 'Prompt cannot be empty.');
    const ok = await req(p.address, '/api/job', { method: 'POST', headers: { ...json, Origin: `http://${host}` }, body });
    assert.equal(ok.code, 200);
    const job = JSON.parse(ok.body).job;
    await p.waitUntilDone(job.id);

    // Dosya: Range (video atlatma icin), indirme basligi, yol disina cikis yok.
    const path = `/file/job/${job.id}/image_1.png`;
    const full = await req(p.address, path);
    assert.equal(full.code, 200);
    const part = await req(p.address, path, { headers: { Range: 'bytes=0-9' } });
    assert.equal(part.code, 206);
    assert.equal(part.body.length, 10);
    assert.equal(part.headers['content-range'], `bytes 0-9/${full.body.length}`);
    assert.match((await req(p.address, `${path}?download=1`)).headers['content-disposition'], /attachment; filename\*=UTF-8''image_1\.png/);
    // (URL'deki duz "/../" tarayicida ve Node'da zaten cozulur; kacisli bicimler sunucuya ulasir.)
    for (const bad of [`/file/job/${job.id}/..%2F..%2Fis.json`, '/file/job/../../Windows/win.ini', `/file/job/${job.id}/alt%2F..%2F..%2F..%2Fx`, '/file/upload/..%5C..%5Cx', '/../../Windows/win.ini', '/file/voice/..%2F..%2Fx', '/%2E%2E/%2E%2E/Windows/win.ini']) {
      assert.equal((await req(p.address, bad)).code, 404, bad);
    }
    // A type with a capital letter (pageVideo): its video and preview answered 404 (09.10.2026)
    const pageVideo = join(p.setting.outputRoot, '20261009-093820-pageVideo-ab74');
    mkdirSync(pageVideo, { recursive: true });
    writeFileSync(join(pageVideo, 'page-video.preview.jpg'), 'jpg');
    assert.equal((await req(p.address, '/file/job/20261009-093820-pageVideo-ab74/page-video.preview.jpg')).code, 200);
    assert.equal((await req(p.address, '/file/job/20261009-093820-PageVideo-ab74/page-video.preview.jpg')).code, 404, 'the type still starts in lower case');

    // Betiksiz form gonderimi: islem yapilir, panele bildirimle donulur.
    const remove = await req(p.address, `/api/job/${job.id}/delete`, { method: 'POST', headers: { Origin: `http://${host}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
    assert.equal(remove.code, 303);
    assert.match(remove.headers.location, /^\/\?notification=Deleted\.&type=success/);

    // Gorsel yukleme: yalnizca gorsel uzantisi ve gercek gorsel.
    const png = makePng(32, 18);
    const y = await req(p.address, '/api/upload?name=kare%C3%A7.png', { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'image/png' }, body: png });
    assert.equal(y.code, 200);
    const g = JSON.parse(y.body).image;
    assert.match(g.source, /^upload\/\d{8}-\d{6}-karec\.png$/);
    assert.deepEqual([g.width, g.height], [32, 18]);
    const fake = await req(p.address, '/api/upload?name=x.png', { method: 'POST', headers: { 'X-Panel': '1' }, body: Buffer.from('not') });
    assert.equal(fake.code, 400);
    assert.equal((await req(p.address, '/api/upload?name=x.exe', { method: 'POST', headers: { 'X-Panel': '1' }, body: png })).code, 400);
    const images = JSON.parse((await req(p.address, '/api/images')).body).images;
    assert.ok(images.some((x) => x.source === g.source));

    // ComfyUI baslat: calisiyorsa dokunmaz.
    const b = JSON.parse((await req(p.address, '/api/comfy/start', { method: 'POST', headers: { 'X-Panel': '1' } })).body);
    assert.equal(b.message, 'ComfyUI is already running.');
    assert.equal(p.starts.length, 0);
  } finally {
    await p.close();
  }
});

test('voice library: upload (24 kHz WAV via ffmpeg), list, serve, remove', async (t) => {
  const p = await createPanel({ server: true });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  try {
    const { makeWav } = await import('../lib/media.mjs');
    const y = await req(p.address, '/api/voices/upload?name=Tok%20ses.wav', { method: 'POST', headers: { 'X-Panel': '1' }, body: makeWav(3, { sampling: 44100 }) });
    assert.equal(y.code, 200, y.body.toString());
    const { id } = JSON.parse(y.body);
    const voices = JSON.parse((await req(p.address, '/api/voices')).body).voices;
    assert.equal(voices.length, 1);
    assert.equal(voices[0].name, 'Tok ses');
    assert.ok(Math.abs(voices[0].duration - 3) < 0.05);
    const file = await req(p.address, `/file/voice/${id}.wav`);
    assert.equal(file.code, 200);
    assert.equal(file.body.readUInt32LE(24), 24000, '24 kHz');
    const remove = await req(p.address, `/api/voices/${id}/delete`, { method: 'POST', headers: { 'X-Panel': '1' } });
    assert.equal(remove.code, 200);
    assert.equal(JSON.parse((await req(p.address, '/api/voices')).body).voices.length, 0);
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', 'x.txt'), 'x');
    assert.equal((await req(p.address, '/api/voices/upload?name=x.txt', { method: 'POST', headers: { 'X-Panel': '1' }, body: Buffer.from('x') })).code, 400);
  } finally {
    await p.close();
  }
});

/** JPEG'e EXIF yon etiketi ekler (SOI'den hemen sonra APP1; telefon fotografi gibi). */
function addExif(jpeg, direction) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // 1 kayit
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(direction, 18);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const startedAt = Buffer.from([0xff, 0xe1, 0, 0]);
  startedAt.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), startedAt, body, jpeg.subarray(2)]);
}

test('phone photo: EXIF orientation is applied to the pixels on upload (ComfyUI read mirrored images the wrong way)', async (t) => {
  const p = await createPanel({ server: true });
  try {
    if (!p.setting.ffmpeg) return t.skip('no ffmpeg');
    const root = join(p.setting.dataRoot, 'exif');
    mkdirSync(root, { recursive: true });
    // Sol yari kirmizi, sag yari mavi; 40x20
    execFileSync(p.setting.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=40x20,drawbox=x=20:y=0:w=20:h=20:c=blue:t=fill', '-frames:v', '1', join(root, 'a.jpg')]);
    const jpeg = readFileSync(join(root, 'a.jpg'));
    const pixel = (path, x, y) => [...execFileSync(p.setting.ffmpeg, ['-v', 'error', '-i', path, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];

    for (const [direction, name] of [[2, 'aynali'], [6, 'dik']]) {
      writeFileSync(join(root, `${name}.jpg`), addExif(jpeg, direction));
      assert.equal(exifOrientation(join(root, `${name}.jpg`)), direction);
    }
    assert.equal(exifOrientation(join(root, 'a.jpg')), 1);
    // Dik cekimde gorunen olcu yer degistirir
    assert.deepEqual(imageSize(join(root, 'dik.jpg')), { width: 20, height: 40 });

    const load = async (name) => {
      const y = await req(p.address, `/api/upload?name=${name}.jpg`, { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'image/jpeg' }, body: readFileSync(join(root, `${name}.jpg`)) });
      assert.equal(y.code, 200);
      return JSON.parse(y.body).image;
    };
    // Aynali (iPhone on kamera): sol artik mavi; PNG, etiketsiz
    const a = await load('aynali');
    assert.match(a.source, /^upload\/.*-aynali\.png$/);
    assert.deepEqual([a.width, a.height], [40, 20]);
    const aPath = join(p.setting.outputRoot, 'uploads', a.source.slice('upload/'.length));
    const [r, , b] = pixel(aPath, 2, 10);
    assert.ok(b > 200 && r < 60, `sol piksel mavi olmali: ${r},${b}`);
    // Dik (90 derece saat yonu): 20x40, ust yari kirmizi
    const d = await load('dik');
    assert.deepEqual([d.width, d.height], [20, 40]);
    const dPath = join(p.setting.outputRoot, 'uploads', d.source.slice('upload/'.length));
    assert.ok(pixel(dPath, 10, 2)[0] > 200, 'top should be red');
    // Etiketsiz JPEG oldugu gibi kalir
    assert.match((await load('a')).source, /-a\.jpg$/);
  } finally {
    await p.close();
  }
});
