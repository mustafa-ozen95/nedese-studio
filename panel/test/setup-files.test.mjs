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

test('setup: singing in a voice gets its code, environment and helper models where the panel looks for them', () => {
  const script = readFileSync(join(setup, 'setup.ps1'), 'utf8');
  const settings = readFileSync(join(setup, '..', 'panel', 'lib', 'settings.mjs'), 'utf8');
  // the code (vendored with its commit) goes to voice\svc, the environment to voice\svc\.venv: where settings.mjs runs it
  assert.match(readFileSync(join(setup, 'vendor', 'YingMusic-SVC', 'SOURCE.txt'), 'utf8'), /commit [0-9a-f]{40}/);
  assert.match(script, /\$Svc = Join-Path \$Root 'voice\\svc'/);
  assert.match(script, /Copy-Vendor 'YingMusic-SVC' \$Svc/);
  assert.match(settings, /svcPython = join\(aiRoot, 'voice', 'svc', '\.venv', 'Scripts', 'python\.exe'\)/);
  assert.match(readFileSync(join(setup, 'lock', 'svc.txt'), 'utf8'), /^torch==[\d.]+\+cu130$/m);
  assert.match(script, /voice-models\.py'\), 'svc'\)/);
  // the helpers at pinned revisions, one file at a time: parallel downloads into a new cache folder raced huggingface_hub's
  // symbolic link check and failed with WinError 1314 (10.10.2026)
  const models = readFileSync(join(setup, 'voice-models.py'), 'utf8');
  const svc = models.slice(models.indexOf('elif mode == "svc"'), models.indexOf('else:\n    sys.exit'));
  assert.equal([...svc.matchAll(/"[0-9a-f]{40}"/g)].length, 4);
  assert.match(svc, /snapshot_download\(.*cache_dir=.*max_workers=1\)/);
  assert.match(svc, /refs.*\n.*"main"/);
});
