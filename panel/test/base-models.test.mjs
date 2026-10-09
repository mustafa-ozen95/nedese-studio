/**
 * Temel model listesi: HF onbellegindeki (indirilmis) depolar "kurulu" ve boyutuyla; listede olmayan ozel depolar
 * ozelTemeller'de; yarim indirme (config.json ya da agirlik yok) sayilmaz (kullanici 08.10.2026: kurulu olanlar en ustte).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hfCache, baseModelStatuses } from '../lib/jobs/training.mjs';

function repo(root, name, { full = true, byte = 1024 } = {}) {
  const s = join(root, 'training', 'hf', 'hub', `models--${name.replace('/', '--')}`, 'snapshots', 'abc');
  mkdirSync(s, { recursive: true });
  mkdirSync(join(root, 'training', 'hf', 'hub', `models--${name.replace('/', '--')}`, 'blobs'), { recursive: true });
  if (full) {
    writeFileSync(join(s, 'config.json'), '{}');
    writeFileSync(join(s, 'model.safetensors'), Buffer.alloc(byte));
  } else writeFileSync(join(s, 'config.json'), '{}');
}

test('base models: downloaded ones are installed + size, private repositories separate, partial downloads do not count, local base models from the folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'temeller-'));
  repo(root, 'Qwen/Qwen3-14B', { byte: 3 * 2 ** 20 });
  repo(root, 'Kurum/Ozel-Model', { byte: 2 ** 20 });
  repo(root, 'Qwen/Qwen3-8B', { full: false });
  mkdirSync(join(root, 'training', 'bases', 'acestep'), { recursive: true });
  writeFileSync(join(root, 'training', 'bases', 'acestep', 'model.bin'), Buffer.alloc(2 ** 20));
  const on = hfCache(root);
  assert.deepEqual(Object.keys(on).sort(), ['Kurum/Ozel-Model', 'Qwen/Qwen3-14B']);
  assert.equal(on['Qwen/Qwen3-14B'].sizeByte, 3 * 2 ** 20 + 2, 'weights + config.json ("{}")');
  const d = baseModelStatuses(root, { videoInstalled: true });
  const find = (k) => d.bases.find((t) => t.id === k);
  assert.equal(find('Qwen/Qwen3-14B').installed, true);
  assert.equal(find('Qwen/Qwen3-14B').sizeGib, 0);
  assert.equal(find('Qwen/Qwen3-8B').installed, false, 'config present but no weights: partial');
  assert.equal(find('acestep-15').installed, true, 'local base models folder');
  assert.equal(find('flux2-klein-4b').installed, false);
  assert.equal(find('wan22-5b').installed, true, 'ComfyUI modeli: videoKurulu');
  assert.deepEqual(d.customBases.map((o) => o.id), ['Kurum/Ozel-Model']);
  assert.equal(d.customBases[0].custom, true);
  assert.deepEqual(baseModelStatuses(mkdtempSync(join(tmpdir(), 'bos-'))).customBases, [], 'empty when there is no cache');
});
