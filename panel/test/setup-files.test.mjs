/**
 * Setup (setup\setup.ps1 + setup\tools.json): every tool it extracts is listed with its size and SHA-256, and the text
 * model it downloads first is the one the panel picks when nothing is chosen (user 10.10.2026: the fresh install had only
 * Gemma, "Bonsai varsayılan yapmıştık").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findLlm } from '../lib/llm.mjs';

const setup = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'setup');

test('setup: the tools it extracts are in tools.json; Bonsai and its PrismML server are installed and Bonsai is the default', () => {
  const script = readFileSync(join(setup, 'setup.ps1'), 'utf8');
  const tools = JSON.parse(readFileSync(join(setup, 'tools.json'), 'utf8'));
  const named = [...script.matchAll(/'([\w.+-]+\.(?:zip|7z|tar\.gz|exe))'/g)].map((m) => m[1]).filter((n) => !/^llama-server\.exe$/.test(n));
  for (const n of ['llama-prism-b10754-2459f68-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip']) assert.ok(named.includes(n), `setup extracts ${n}`);
  for (const n of named) {
    const t = tools.find((x) => x.file.split('/').at(-1) === n);
    assert.ok(t && t.size > 0 && /^[0-9a-f]{64}$/.test(t.sha256), `tools.json lists ${n}`);
  }
  assert.match(script, /Join-Path \$Root 'llm\\bin-prism'/);
  // the text models setup saves: Bonsai (with its encoder) before Gemma
  const models = [...script.matchAll(/'llm\\models\\([\w.-]+\.gguf)'/g)].map((m) => m[1]);
  assert.deepEqual(models, ['Ternary-Bonsai-2-27B-PQ2_0.gguf', 'mmproj-Ternary-Bonsai-2-27B-PQ2_0.gguf', 'gemma-4-26B-qat-q4_0.gguf', 'mmproj-gemma-4-26B-qat-q4_0.gguf']);
  // with both saved and nothing chosen, the panel opens Bonsai on PrismML's server
  const root = mkdtempSync(join(tmpdir(), 'setup-models-'));
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  for (const d of ['bin', 'bin-prism']) {
    mkdirSync(join(root, 'llm', d), { recursive: true });
    writeFileSync(join(root, 'llm', d, exe), '');
  }
  mkdirSync(join(root, 'llm', 'models'));
  for (const m of models) writeFileSync(join(root, 'llm', 'models', m), 'x');
  const llm = findLlm(root, '');
  assert.deepEqual([llm.file, llm.bin, llm.mmproj], [models[0], join(root, 'llm', 'bin-prism', exe), join(root, 'llm', 'models', models[1])]);
});
