/**
 * Video from text alone: without a source image the first frame is drawn with an image model (frame.png, kept as an
 * output), then the image-to-video flow runs on it. Fake ComfyUI, end to end through the API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { imageSize } from '../lib/media.mjs';
import { createPanel } from './env.mjs';

test('video from text: the first frame is drawn from the prompt, the video follows it; no source and no prompt is a clear error', async () => {
  const p = await createPanel({ server: true });
  const req = async (path, method = 'GET', body) => {
    const r = await fetch(`${p.address}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, j: await r.json() };
  };
  try {
    const none = await req('/jobs', 'POST', { type: 'video' });
    assert.equal(none.code, 400);
    assert.match(none.j.error, /or write a prompt to make the video from text/);

    const r = await req('/jobs', 'POST', { type: 'video', prompt: 'a red fox runs through a snowy forest', ratio: '9:16', model: 'wan5', duration: 1 });
    assert.equal(r.code, 200, JSON.stringify(r.j));
    const g = p.queue.jobs.get(r.j.job.id).input;
    assert.equal(g.source, null);
    assert.deepEqual([g.fromText.image, g.fromText.imageModel, g.fromText.ratio], ['a red fox runs through a snowy forest', 'qwen', '9:16']);
    assert.ok(g.height > g.width, 'a portrait frame gives a portrait video');
    assert.match(r.j.job.summary.detail, /^From text · /);
    const last = await p.waitUntilDone(r.j.job.id, 30000);
    assert.equal(last.status, 'done', last.error);
    assert.deepEqual(last.outputs.map((o) => [o.file, o.type]), [['video.mp4', 'video'], ['frame.png', 'image']], 'the video is the main output, the drawn frame follows it');
    const folder = join(p.setting.outputRoot, r.j.job.id);
    assert.ok(existsSync(join(folder, 'video.mp4')));
    assert.ok(imageSize(join(folder, 'frame.png')), 'frame.png is a readable image');
    assert.match(p.queue.logs.get(r.j.job.id).join('\n'), /First frame drawn from the prompt with Qwen-Image/);

    // A separate image description and a chosen image model
    const f = await req('/jobs', 'POST', { type: 'video', image: 'a lighthouse at dusk', prompt: 'slow push in', imageModel: 'flux', duration: 1 });
    assert.equal(f.code, 200, JSON.stringify(f.j));
    const gf = p.queue.jobs.get(f.j.job.id).input;
    assert.deepEqual([gf.fromText.image, gf.fromText.imageModel, gf.prompt], ['a lighthouse at dusk', 'flux', 'slow push in']);
    assert.ok(gf.width > gf.height, '16:9 by default');
    p.queue.cancel(f.j.job.id);
  } finally {
    await p.close();
  }
});
