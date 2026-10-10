/**
 * Turkish music styles reach ACE-Step as English tags (it was trained with them): the song edit and a film's generated
 * music, like the music job. 10.10.2026: after Qwen-Image misread a Turkish image prompt, the other places where
 * user text went to a model as written were found (song style, film music style).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWav } from '../lib/media.mjs';
import { setTextModel } from '../lib/prompt-translate.mjs';
import { MUSIC_FILES } from '../lib/jobs/music.mjs';
import { usedFiles } from '../lib/models.mjs';
import { createPanel } from './env.mjs';

const STYLE = 'calm acoustic guitar, warm, slow';
const llm = {
  installed: true,
  info: { name: 'fake' },
  releaseGpu: async () => {},
  req: async (path, body) => {
    const system = body.messages[0]?.content ?? '';
    if (/music style descriptions/.test(system)) return { code: 200, json: { choices: [{ message: { content: STYLE } }] } };
    return { code: 500, json: { error: { message: 'not in this test' } } };
  },
};
/** ACE-Step's files in the test model folder (the panel checks them before the queue); all: every graph's files too. */
function musicModel(p, { all = false } = {}) {
  const keys = [...MUSIC_FILES.map(([folder, file]) => `${folder}/${file}`), ...(all ? Object.keys(usedFiles(p.mod)) : [])];
  for (const key of keys) {
    mkdirSync(join(p.setting.modelRoot, key.split('/')[0]), { recursive: true });
    writeFileSync(join(p.setting.modelRoot, ...key.split('/')), 'x');
  }
}
const tagsOf = (p) => [...p.fake.status.requests.values()].map((r) => Object.values(r.graph).find((d) => d.class_type === 'TextEncodeAceStepAudio1.5')?.inputs.tags).filter(Boolean);

test('song edit: a Turkish style reaches ACE-Step in English', async (t) => {
  const p = await createPanel({ llm });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  setTextModel(llm);
  musicModel(p);
  try {
    mkdirSync(join(p.setting.outputRoot, 'uploads'), { recursive: true });
    writeFileSync(join(p.setting.outputRoot, 'uploads', '20261010-120000-sarki.wav'), makeWav(3));
    const song = await p.waitUntilDone(p.queue.add('song', { source: 'upload/20261010-120000-sarki.wav', style: 'sakin akustik gitar, sıcak, yavaş', strength: 'medium' }).id);
    assert.equal(song.status, 'done', song.error);
    assert.deepEqual(tagsOf(p), [STYLE]);
    assert.equal(p.queue.jobs.get(song.id).styleEnglish, STYLE, 'kept for a retry');
  } finally {
    setTextModel(null);
    await p.close();
  }
});

test('film music: a Turkish style is translated before the music plan (the plan puts it in front of every section)', async (t) => {
  const p = await createPanel({ llm });
  if (!p.setting.ffmpeg) {
    await p.close();
    t.skip('no ffmpeg');
    return;
  }
  setTextModel(llm);
  musicModel(p, { all: true }); // with a model folder every image and video model file is checked too
  try {
    const job = p.queue.add('film', { title: '', ratio: '16:9', imageModel: 'flux', videoModel: 'wan5', voice: 'model', quality: 'fast', transition: false, musicMode: 'generate', musicStyle: 'sakin akustik gitar, sıcak, yavaş',
      scenes: [{ narration: 'Bir tilki karda yürüyor.', image: 'a red fox in the snow' }] });
    // The fake ComfyUI returns no real audio for the film's mix, so only the request to ACE-Step is checked here
    await p.waitUntilDone(job.id, 120000);
    assert.match(p.queue.logs.get(job.id).join(' '), /Stage: 5\/5 Music/);
    const tags = tagsOf(p);
    assert.ok(tags.length && tags.every((x) => x.startsWith(STYLE) && !/akustik|gitar/.test(x)), tags.join(' | '));
    assert.equal(p.queue.jobs.get(job.id).musicStyleEnglish, STYLE);
  } finally {
    setTextModel(null);
    await p.close();
  }
});
