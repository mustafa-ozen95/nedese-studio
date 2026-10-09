/**
 * Page video (user request 09.10.2026: the panel makes a video of a web page or of itself): steps played in a real
 * Edge/Chrome without a window, the screencast frames and a narration clip made into an MP4 with real ffmpeg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { streams } from '../lib/ffmpeg.mjs';
import { UPLOAD_FOLDER } from '../lib/settings.mjs';
import { autoTour, frameList, validate } from '../lib/jobs/page-video.mjs';
import { plan, cameraAt, pairLayout } from '../lib/jobs/page-video-compose.mjs';
import { JOB_TYPES } from '../lib/api.mjs';
import { createPanel } from './env.mjs';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo shop</title>
<style>body{font:18px system-ui;margin:0;background:#f4f4f6}main{padding:40px}section{height:700px;border-bottom:1px solid #ccc}</style></head>
<body><main><h1>Demo shop</h1><button id="buy" onclick="fetch('/clicked?what=buy')">Buy now</button>
<input id="q" placeholder="Search" onchange="fetch('/typed?v=' + encodeURIComponent(this.value))">
<div id="box" style="height:300px;overflow:auto"><div style="height:9000px"></div><button id="far" onclick="fetch('/clicked?what=far')">Far away</button></div>
<section>One</section><section>Two</section><section id="end">The end</section></main>
<script>addEventListener('resize', () => fetch('/width?' + innerWidth))</script></body></html>`;

test('page video: validation, the panel tour, the frame list', () => {
  const setting = { port: 1071, ffmpeg: 'ffmpeg', outputRoot: 'C:\\nowhere' };
  const g = validate({ url: 'panel', lang: 'tr', size: 'phone' }, { setting });
  assert.deepEqual([g.url, g.panel, g.captionPosition], ['http://127.0.0.1:1071/', true, 'top'], 'the panel; captions above the composer on a phone');
  assert.equal(validate({ url: 'example.com' }, { setting }).url, 'https://example.com/');
  assert.throws(() => validate({ url: 'file:///C:/secret.txt' }, { setting }), /Only http and https/);
  assert.throws(() => validate({ steps: [{ do: 'jump' }] }, { setting }), /Step 1: "do" is one of/);
  assert.throws(() => validate({ steps: [{ do: 'click' }] }, { setting }), /Step 1 target cannot be empty/);
  assert.equal(validate({ steps: [{ caption: 'Hello' }] }, { setting }).steps[0].do, 'wait', 'a caption alone is a wait');
  assert.equal(validate({ steps: [{ do: 'open', url: '#gallery' }] }, { setting }).steps[0].url, '#gallery', 'a section of the open page');
  assert.deepEqual(validate({ steps: [{ do: 'device', size: 'tablet' }] }, { setting }).steps[0], { do: 'device', size: 'phone' }, 'an unknown device is a phone');
  const tour = autoTour(g);
  assert.equal(tour[0].url, 'http://127.0.0.1:1071/#chat');
  assert.ok(tour.slice(1).every((a) => a.do === 'open' && a.url.startsWith('#') && a.caption), 'every section with a caption');
  assert.match(tour[1].caption, /^Sohbet:/, 'Turkish captions');
  // each frame lasts until the next, the last until the end, and is named twice (the concat demuxer)
  // the chat's panel guide lists the type with an example body that is valid as it is
  assert.equal(JOB_TYPES.pageVideo.name, 'Page video');
  assert.equal(validate(JOB_TYPES.pageVideo.example, { setting }).steps.length, 4);
  const list = frameList([{ file: 'C:\\f\\a.jpg', t: 0 }, { file: 'C:\\f\\b.jpg', t: 0.5 }], 2);
  assert.equal(list, "ffconcat version 1.0\nfile 'C:/f/a.jpg'\nduration 0.5000\nfile 'C:/f/b.jpg'\nduration 1.5000\nfile 'C:/f/b.jpg'\n");
});

test('page video promo plan: a slide per section change, the camera goes in on a click and wide before a slide, a headline per scene', () => {
  const setting = { port: 1071, ffmpeg: 'ffmpeg', outputRoot: 'C:\\nowhere' };
  assert.equal(validate({}, { setting }).style, 'promo', 'the promo look unless plain is asked for');
  assert.equal(validate({ style: 'plain' }, { setting }).style, 'plain');
  const marks = [
    { start: 0, do: 'open', caption: 'The *shop*', view: 'desktop' },
    { start: 1.2, do: 'click', caption: '', view: 'desktop', focus: { x: 0.3, y: 0.2, w: 0.08, h: 0.05 } },
    { start: 2.5, do: 'open', caption: '', view: 'desktop', ready: 3.1 },
    { start: 4, do: 'device', caption: 'On the phone', view: 'phone', ready: 4.6 },
    { start: 5.5, do: 'scroll', caption: '', view: 'phone' },
  ];
  const p = plan({ marks, end: 8, size: 'desktop' });
  assert.deepEqual(p.scenes.map((s) => s.view), ['desktop', 'desktop', 'phone']);
  const [first, second] = p.transitions;
  const round = (x) => Math.round(x * 100) / 100;
  assert.deepEqual([first.at, round(first.b), round(first.p0)], [2.5, 3.18, 2.38], 'the slide ends when the section has drawn');
  assert.equal(round(second.b), 4.68, 'a device change: when the new size has drawn');
  assert.deepEqual(p.headlines.map((x) => x.text), ['The *shop*', '', 'On the phone'], 'a click keeps the headline; a section without a caption has none');
  assert.equal(p.headlines[1].t, first.p0, 'the headline changes with the slide');
  const zoom = (r) => Math.round(cameraAt(p.camera, r).z * 100) / 100;
  assert.equal(zoom(1.4), 1, 'wide before the click');
  assert.ok(zoom(2) > 1.2, `in on the clicked button (${zoom(2)})`);
  assert.equal(zoom(3.2), 1, 'wide again when the slide ends');
  assert.ok(Math.abs(cameraAt(p.camera, 2.2).x - 0.3) < 0.05, 'towards the button');
  assert.ok(p.camera.every((k, i) => !i || k.t >= p.camera[i - 1].t), 'keys in time order');
});

test('page video promo: a phone part in a wide video stands in front of the bottom right corner of the window, not alone in the middle', () => {
  // 1920×1080 under a 173 px headline band: the window and the phone at their full sizes
  const [W, H, top, bottom] = [1920, 1080, 173, 49];
  const win = { w: 1456, h: 858 };
  const phone = { w: 453, h: 858 };
  const { win: a, phone: b } = pairLayout(W, H, top, bottom, win, phone);
  const box = (q, d) => ({ left: q.cx - (d.w * q.s) / 2, right: q.cx + (d.w * q.s) / 2, top: q.cy - (d.h * q.s) / 2, bottom: q.cy + (d.h * q.s) / 2 });
  const w = box(a, win);
  const f = box(b, phone);
  const round = (x) => Math.round(x);
  assert.equal(round(w.top), top, 'the window under the headline');
  assert.equal(round(f.bottom), H - bottom, 'the phone on the bottom line');
  assert.ok(f.right > w.right && f.bottom > w.bottom, `right of and below the window's corner (${round(f.right)} > ${round(w.right)}, ${round(f.bottom)} > ${round(w.bottom)})`);
  assert.ok(f.left < w.right && f.top < w.bottom, 'in front of the corner, over the window');
  assert.ok(f.right <= W * 0.95 && w.left >= W * 0.05, 'inside the picture');
  assert.ok(Math.abs(w.left - (W - f.right)) < 1, 'the two together in the middle');
  assert.ok(f.bottom - f.top > (H - top - bottom) * 0.85, 'the phone nearly as tall as the room: its page stays readable');
  // a narrow picture: both get smaller and still fit
  const narrow = pairLayout(1200, 1080, top, bottom, win, phone);
  assert.ok(box(narrow.phone, phone).right <= 1200 * 0.95 + 0.5 && box(narrow.win, win).left >= 1200 * 0.05 - 0.5, 'a narrow picture: smaller, inside');
});

test('page video: clicks and typing reach the page, the video has the size, the length and the narration', async () => {
  const seen = [];
  const site = createServer((req, res) => {
    if (req.url.startsWith('/clicked') || req.url.startsWith('/typed') || req.url.startsWith('/width')) {
      seen.push(decodeURIComponent(req.url));
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
  const p = await createPanel();
  try {
    // a 2 s narration clip in the uploads
    const uploads = join(p.setting.outputRoot, UPLOAD_FOLDER);
    mkdirSync(uploads, { recursive: true });
    execFileSync(p.setting.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=2', join(uploads, 'narration.wav')]);
    const job = p.queue.add('pageVideo', {
      url: `http://127.0.0.1:${site.address().port}/`,
      size: 'desktop',
      title: 'Demo shop',
      steps: [
        { do: 'open', url: `http://127.0.0.1:${site.address().port}/`, seconds: 1, caption: 'The shop' },
        { do: 'click', target: 'Buy now', seconds: 0.5, audio: 'upload/narration.wav' },
        { do: 'type', target: '#q', text: 'red fox' },
        { do: 'key', key: 'Enter' },
        { do: 'click', target: 'h1', seconds: 0.3 },
        { do: 'click', target: '#far', seconds: 0.3 },
        { do: 'scroll', to: 'end', seconds: 1.5 },
        { do: 'device', size: 'phone', caption: 'On the phone' },
        { do: 'scroll', to: 'top', seconds: 1 },
      ],
    });
    const done = await p.waitUntilDone(job.id, 300000);
    assert.equal(done.status, 'done', done.error);
    assert.ok(seen.includes('/clicked?what=buy'), `the button was clicked by the text on it (${seen.join(', ')})`);
    assert.ok(seen.includes('/typed?v=red fox'), 'typed letter by letter into the box found by its selector');
    // the button far down a scrolling box: a fixed wait read its place mid-scroll and the click missed (09.10.2026: the chat's Preview)
    assert.ok(seen.includes('/clicked?what=far'), `the far button was clicked after the scroll settled (${seen.join(', ')})`);
    assert.ok(seen.includes('/width?432'), `the phone part: the page is 432 px wide (${seen.join(', ')})`);
    const out = done.outputs.find((o) => o.file === 'page-video.mp4');
    const folder = join(p.setting.outputRoot, job.id);
    const info = await streams(p.setting.ffprobe, join(folder, out.file));
    const video = info.streams.find((s) => s.codec_type === 'video');
    assert.deepEqual([video.width, video.height], [1920, 1080]);
    assert.ok(info.streams.some((s) => s.codec_type === 'audio'), 'the narration is in it');
    // promo: opening 3.2 s + open 1 + click (narration 2 s + 0.35) + type + key + click + scroll 1.5 + 0.8 + end card 3.8
    assert.ok(info.duration > 14 && info.duration < 34, `length ${info.duration}`);
    assert.ok(existsSync(join(folder, 'page-video.preview.jpg')), 'gallery preview');
    assert.deepEqual(readdirSync(folder).filter((f) => /frames|compose|timeline/.test(f)), [], 'the frames and the composing page are removed');

    // plain: the screen as it is, no opening
    const plain = p.queue.add('pageVideo', { url: `http://127.0.0.1:${site.address().port}/`, size: 'square', style: 'plain', steps: [{ do: 'open', url: `http://127.0.0.1:${site.address().port}/`, seconds: 1 }, { do: 'scroll', to: 'end', seconds: 1 }] });
    const plainDone = await p.waitUntilDone(plain.id, 120000);
    assert.equal(plainDone.status, 'done', plainDone.error);
    const plainInfo = await streams(p.setting.ffprobe, join(p.setting.outputRoot, plain.id, 'page-video.mp4'));
    assert.deepEqual([plainInfo.streams[0].width, plainInfo.streams[0].height], [1080, 1080]);
    assert.ok(plainInfo.duration < 6, `plain length ${plainInfo.duration}`);
  } finally {
    await p.close();
    site.close();
  }
});
