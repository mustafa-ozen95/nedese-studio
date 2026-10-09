/**
 * Own voice (voice\clone): the job through the fake prepare.py / train.py and the fake voice-over, both checked against
 * the real scripts (script-contract.mjs). Until 09.10.2026 the job had no test and its scripts no longer took the
 * panel's options after the English conversion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { makeWav } from '../lib/media.mjs';
import { UPLOAD_FOLDER } from '../lib/settings.mjs';
import { voiceInfo, voiceLoraPath } from '../lib/voices.mjs';

async function upload(p, name) {
  mkdirSync(join(p.setting.outputRoot, UPLOAD_FOLDER), { recursive: true });
  writeFileSync(join(p.setting.outputRoot, UPLOAD_FOLDER, name), makeWav(80));
  return `upload/${name}`;
}

test('own voice: prepare + training + a sample in the new voice; the library gets the reference, its text and the LoRA', async () => {
  const log = join(process.env.TEMP ?? '.', `clone-log-${process.pid}.jsonl`);
  const p = await createPanel({ cloneEnv: { FAKE_CLONE_LOG: log } });
  try {
    const record = await upload(p, 'kayit.wav');
    const job = p.queue.add('clone', { name: 'Benim sesim', records: [record], train: true });
    const done = await p.waitUntilDone(job.id, 60000);
    assert.equal(done.status, 'done', done.error);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((c) => c[0]), ['prepare', 'train']);
    assert.equal(calls[0][1], '--output');
    const id = done.voiceId;
    const info = voiceInfo(p.setting.voiceLibrary, id);
    assert.equal(info.name, 'Benim sesim');
    assert.equal(info.referenceText, 'Merhaba, bu bir deneme kaydı.');
    assert.ok(voiceLoraPath(p.setting.voiceLibrary, id), 'the trained LoRA is linked to the voice');
    assert.ok(existsSync(join(voiceLoraPath(p.setting.voiceLibrary, id), 'lora_weights.safetensors')));
    assert.equal(existsSync(join(voiceLoraPath(p.setting.voiceLibrary, id), 'optimizer.pth')), false, 'optimizer state stays out of the library');
    assert.deepEqual(done.outputs.map((o) => [o.file, o.type, o.heard]), [['example.wav', 'voice', 'Merhaba, bu benim sesim. Artık yazdığım her şeyi bu sesle okuyabilirim.']]);
    const text = readFileSync(join(p.queue.folder(job.id), 'log.txt'), 'utf8');
    assert.match(text, /Recording 80 s, speech 75 s, 13 segments; reference 9 s\./);
  } finally {
    await p.close();
  }
});

test('own voice: a recording too short for training stays a quick clone and says so', async () => {
  const p = await createPanel({ cloneEnv: { FAKE_CLONE_SPEECH: '30' } });
  try {
    const record = await upload(p, 'kisa.wav');
    const job = p.queue.add('clone', { name: 'Kısa', records: [record], train: true });
    const done = await p.waitUntilDone(job.id, 60000);
    assert.equal(done.status, 'done', done.error);
    assert.match(done.warning, /Recording too short for training \(30 s; at least 60 s\)/);
    assert.equal(voiceLoraPath(p.setting.voiceLibrary, done.voiceId), null);
  } finally {
    await p.close();
  }
});
