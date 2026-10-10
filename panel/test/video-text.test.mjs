/**
 * Video from text alone: without a source image the first frame is drawn with an image model (frame.png, kept in the job
 * folder, not an output), then the image-to-video flow runs on it. Fake ComfyUI, end to end through the API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { imageSize } from '../lib/media.mjs';
import { createPanel } from './env.mjs';
import { setTextModel } from '../lib/prompt-translate.mjs';

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
    // only the video in the preview (user 10.10.2026: "Video önizlemede fotosu da gelmiş saçma")
    assert.deepEqual(last.outputs.map((o) => [o.file, o.type]), [['video.mp4', 'video']], 'the drawn frame is not an output');
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

test('Turkish prompts reach Qwen-Image in English: the image job and the first frame of a video from text (the video keeps its own motion prompt)', async () => {
  // 10.10.2026, same seed: Qwen-Image drew "kızıl bir tilki" (a red fox) as a girl with a hyena; the English came out right
  const asked = [];
  const llm = {
    installed: true,
    info: { name: 'fake' },
    releaseGpu: async () => {},
    req: async (path, body) => {
      const system = body.messages[0]?.content ?? '';
      const input = body.messages.at(-1).content;
      asked.push([/text-to-image/.test(system) ? 'image' : /image-to-video/.test(system) ? 'video' : 'other', input]);
      const content = /text-to-image/.test(system) ? 'a red fox in fresh snow, soft morning light'
        : /image-to-video/.test(system) ? 'The red fox walks slowly through the snow' : 'NONE';
      return { code: 200, json: { choices: [{ message: { content } }] } };
    },
  };
  const p = await createPanel({ llm });
  setTextModel(llm);
  const textOf = (prefix) => {
    const g = p.fake.status.records.filter((x) => x.path === '/prompt').map((x) => JSON.parse(x.prompt).prompt)
      .find((g) => Object.values(g).some((d) => d.class_type === 'SaveImage' && String(d.inputs.filename_prefix).startsWith(prefix)));
    assert.ok(g, `no graph for ${prefix}`);
    return Object.values(g).filter((d) => d.class_type === 'CLIPTextEncode').map((d) => d.inputs.text);
  };
  try {
    const image = p.queue.add('image', { prompt: 'karda kızıl bir tilki, sabah ışığı', model: 'qwen', ratio: '1:1', count: 1 });
    assert.equal((await p.waitUntilDone(image.id, 30000)).status, 'done');
    assert.ok(textOf(`panel/${image.id}/`).includes('a red fox in fresh snow, soft morning light'), 'Qwen-Image got the English');
    assert.match(p.queue.logs.get(image.id).join(String.fromCharCode(10)), /Prompt translated to English: a red fox in fresh snow/);

    const video = p.queue.add('video', { prompt: 'karların içinde yavaşça yürüyen kızıl bir tilki', model: 'wan5', duration: 1 });
    const last = await p.waitUntilDone(video.id, 30000);
    assert.equal(last.status, 'done', last.error);
    assert.ok(textOf(`panel/${video.id}/frame`).includes('a red fox in fresh snow, soft morning light'), 'the first frame is drawn from the English');
    const job = p.queue.jobs.get(video.id);
    assert.equal(job.imageEnglish, 'a red fox in fresh snow, soft morning light');
    assert.deepEqual(job.prompts, ['The red fox walks slowly through the snow'], 'the motion prompt is translated as a motion prompt, not replaced by the frame text');
    assert.deepEqual(asked.filter(([k]) => k !== 'other').map(([k]) => k), ['image', 'image', 'video']);
  } finally {
    setTextModel(null);
    await p.close();
  }
});
