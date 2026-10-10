/**
 * Read aloud (the chat's speaker button, user 10.10.2026: the browser's voice "çok robotik"): a "speech" job reads the
 * answer in the panel's default voice, one take; it is never in the gallery or the job pages, only when asked by type.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPanel } from './env.mjs';

test('read aloud: one take in the default voice, kept out of the gallery and the job list; a wrong language is a clear error', async (t) => {
  const p = await createPanel({ server: true });
  if (!p.setting.ffmpeg || !p.setting.ffprobe) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  const req = async (path, method = 'GET', body) => {
    const r = await fetch(`${p.address}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, j: await r.json() };
  };
  try {
    const bad = await req('/jobs', 'POST', { type: 'speech', text: 'Hallo', lang: 'de' });
    assert.deepEqual([bad.code, bad.j.error], [400, 'Language must be tr or en.']);
    // the caller's voice choice is ignored: always the default voice, one take
    const r = await req('/jobs', 'POST', { type: 'speech', text: 'Görsel hazır: karda bir kızıl tilki.', lang: 'tr', voice: 'spec', quality: 'natural' });
    assert.equal(r.code, 200, JSON.stringify(r.j));
    const g = p.queue.jobs.get(r.j.job.id).input;
    assert.deepEqual([g.voice, g.quality, g.lang, g.title], ['model', 'fast', 'tr', 'Read aloud']);
    const last = await p.waitUntilDone(r.j.job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    assert.ok(existsSync(join(p.setting.outputRoot, r.j.job.id, 'voice.wav')));
    const job = (await req(`/jobs/${r.j.job.id}`)).j.job;
    assert.match(job.outputs[0].url, /\/voice\.wav$/, 'the chat plays this address');
    // an ordinary voice job for comparison: it is listed, the read-aloud job is not
    const v = p.queue.add('voice', { text: 'Merhaba.', voice: 'model', quality: 'fast' });
    assert.equal((await p.waitUntilDone(v.id, 60000)).status, 'done');
    const gallery = (await req('/gallery')).j.gallery.map((x) => x.id);
    assert.ok(gallery.includes(v.id) && !gallery.includes(r.j.job.id), 'gallery: voice yes, read aloud no');
    const list = (await req('/jobs')).j.jobs.map((x) => x.id);
    assert.ok(list.includes(v.id) && !list.includes(r.j.job.id), 'job list: voice yes, read aloud no');
    assert.deepEqual((await req('/jobs?type=speech')).j.jobs.map((x) => x.id), [r.j.job.id], 'asked by type: listed');
  } finally {
    await p.close();
  }
});
