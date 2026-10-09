/**
 * Fake training\train.py (and training\general.py with FAKE_GENERAL=1): the files the subcommands write and their
 * "progress" / "result" / "ERROR:" lines. Every option and subcommand the panel passes is checked against the real
 * script (script-contract.mjs).
 * FAKE_TRAINING_ERROR=<subcommand>: ERROR at that stage. FAKE_TRAINING_LOG=<file>: the arguments, one call per line.
 * FAKE_TRAINING_STEP_MS=<ms>: training takes 6 steps of this long, writes checkpoint.json after each and goes on from
 * it (the pause / resume test).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expectArgs, expectKeys, expectSource } from './script-contract.mjs';

const [command, ...args] = process.argv.slice(2);
// gguf is train.py's also for the general model (the panel runs it with the text training command)
const script = process.env.FAKE_GENERAL && command !== 'gguf' ? 'training/general.py' : 'training/train.py';
expectArgs(script, [command, ...args], { subcommand: true });
// general.py prints with train.py's progress / result / error
expectSource('training/train.py', "print(f'progress ", "print('result ' + json.dumps", "print(f'ERROR: ");
if (script === 'training/general.py') expectSource(script, 'from train import HERE, error, progress, result');
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.FAKE_TRAINING_LOG) appendFileSync(process.env.FAKE_TRAINING_LOG, `${JSON.stringify([command, ...args])}\n`);
if (process.env.FAKE_TRAINING_ERROR === command) {
  console.log('progress 5 Starting');
  console.log('ERROR: Not enough GPU memory: reduce the context (e.g. 1024) or the model size.');
  process.exit(2);
}
const result = (v) => console.log(`result ${JSON.stringify(v)}`);

if (command === 'prepare' && process.env.FAKE_GENERAL) {
  // general.py prepare: a sample with an image + a question and answer; the sample image under data\images
  expectKeys(script, 'example', 'withImage', 'chat', 'text', 'skipped', 'examplePrompts', 'exampleImage', 'exampleImagePrompt');
  expectSource(script, "'summary.json'", "'data.jsonl'");
  const output = value('--output');
  mkdirSync(join(output, 'images'), { recursive: true });
  writeFileSync(join(output, 'images', '00001.png'), 'png');
  writeFileSync(join(output, 'data.jsonl'), '{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}\n');
  const summary = { example: 2, withImage: 1, chat: 1, text: 0, image: 1, skipped: 0, files: 3, examplePrompts: ['Nedese nedir?'], exampleImage: 'images/00001.png', exampleImagePrompt: value('--prompt') || 'Describe this image in detail.' };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary));
  console.log('progress 100 2 samples (1 with images, 1 chat, 0 plain text)');
  result(summary);
} else if (command === 'mmproj') {
  const target = value('--output');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from('GGUF mmproj fake'));
  result({ mmproj: target, gib: 0.01 });
} else if (command === 'prepare') {
  expectKeys(script, 'example', 'chat', 'text', 'tokenEstimate', 'examplePrompts');
  expectSource(script, "'summary.json'", "'data.jsonl'");
  const output = value('--output');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'data.jsonl'), '{"text":"merhaba"}\n');
  const summary = { example: 3, chat: 1, text: 2, characters: 4000, tokenEstimate: 1000, files: 1, examplePrompts: ['Panel hangi portta?'] };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary));
  console.log('progress 100 3 samples');
  result(summary);
} else if (command === 'fine' || command === 'scratch') {
  expectSource(script, "'training.json'", "'adaptor'");
  // the shared training loop of train.py returns them (general.py runs it too)
  expectKeys('training/train.py', 'step', 'losses', 'durationSec');
  const output = value('--output');
  mkdirSync(join(output, 'hf'), { recursive: true });
  const stepMs = Number(process.env.FAKE_TRAINING_STEP_MS ?? 0);
  if (stepMs) {
    const point = join(output, 'checkpoint.json');
    const startedAt = existsSync(point) ? JSON.parse(readFileSync(point, 'utf8')).step : 0;
    if (startedAt) console.log(`progress ${8 + startedAt * 12} Going on from the checkpoint: step ${startedAt}/6`);
    for (let i = startedAt + 1; i <= 6; i++) {
      await new Promise((r) => setTimeout(r, stepMs));
      writeFileSync(point, JSON.stringify({ step: i }));
      console.log(`progress ${8 + i * 12} Training step ${i}/6 · loss 1.000`);
    }
    rmSync(point, { force: true });
  } else {
    for (let i = 1; i <= 3; i++) console.log(`progress ${8 + i * 20} Training step ${i}/3 · loss ${(3 - i * 0.5).toFixed(3)}`);
  }
  const info = { step: 3, totalStep: 3, losses: [2.5, 2, 1.5], durationSec: 1, ...(command === 'scratch' ? { param: 29000000, validationLoss: 1.7 } : {}) };
  writeFileSync(join(output, 'hf', 'config.json'), JSON.stringify({ command, resume: value('--resume') ?? null, base: value('--base') ?? null }));
  if (command === 'fine') {
    mkdirSync(join(output, 'adaptor'), { recursive: true });
    writeFileSync(join(output, 'adaptor', 'adapter_config.json'), JSON.stringify({ r: 16, previous: value('--previous-adaptor') ?? null }));
  }
  writeFileSync(join(output, 'training.json'), JSON.stringify(info));
  result({ hf: join(output, 'hf'), ...info });
} else if (command === 'gguf') {
  expectKeys(script, 'gguf', 'gib');
  const target = value('--output');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from('GGUF fake'));
  console.log('progress 98 GGUF ready');
  result({ gguf: target, gib: 0.01 });
} else if (command === 'example') {
  expectKeys(script, 'examples');
  const prompts = args.filter((_, i) => args[i - 1] === '--prompt');
  const image = value('--image') ? [{ prompt: value('--image-prompt'), image: '00001.png', response: 'Görselde bir kedi var.' }] : [];
  result({ examples: [...prompts.map((prompt) => ({ prompt, response: `Example response: ${prompt}` })), ...image] });
} else {
  console.log(`ERROR: unknown command ${command}`);
  process.exit(2);
}
