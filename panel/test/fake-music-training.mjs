/**
 * Fake training\music.py: prepare (summary.json) and train (the LoRA file, training.json, progress / result lines).
 * Every option the panel passes is checked against the real script (script-contract.mjs).
 * FAKE_MUSIC_LOG=<file>: the arguments, one call per line.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectArgs, expectKeys, expectSource } from './script-contract.mjs';

const SCRIPT = 'training/music.py';
const [command, ...args] = process.argv.slice(2);
expectArgs(SCRIPT, [command, ...args], { subcommand: true });
expectSource(SCRIPT, "print(f'progress ", "print('result ' + json.dumps", "print(f'ERROR: ");
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.FAKE_MUSIC_LOG) appendFileSync(process.env.FAKE_MUSIC_LOG, `${JSON.stringify([command, ...args])}\n`);
const result = (v) => console.log(`result ${JSON.stringify(v)}`);
if (command === 'prepare') {
  expectKeys(SCRIPT, 'songs', 'spoken', 'trigger', 'exampleSpec', 'language');
  expectSource(SCRIPT, "'summary.json'");
  const output = value('--output');
  mkdirSync(output, { recursive: true });
  const files = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const summary = { songs: files.filter((d) => /\.(wav|mp3|flac|ogg|opus|m4a)$/i.test(d)).length, spoken: files.filter((d) => /\.txt$/i.test(d)).length, trigger: value('--trigger'), exampleSpec: value('--description') || 'song', language: value('--language') };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary));
  console.log(`progress 100 ${summary.songs} songs ready`);
  result(summary);
} else if (command === 'train') {
  expectKeys(SCRIPT, 'lora', 'epoch', 'durationSec', 'losses', 'songs', 'rank', 'sizeMb');
  expectSource(SCRIPT, "'training.json'");
  const output = value('--output');
  const name = value('--name');
  mkdirSync(output, { recursive: true });
  mkdirSync(value('--lora-folder'), { recursive: true });
  for (let i = 1; i <= 3; i++) console.log(`progress ${12 + i * 25} Training epoch ${i * 4}/12 · loss ${(1.2 - i * 0.1).toFixed(4)}`);
  writeFileSync(join(value('--lora-folder'), `${name}.safetensors`), Buffer.from('fake music lora'));
  const info = { lora: `${name}.safetensors`, epoch: 12, durationSec: 1, losses: [1.1, 1.0, 0.9], songs: 2, rank: Number(value('--rank')), sizeMb: 0.1 };
  writeFileSync(join(output, 'training.json'), JSON.stringify(info));
  result(info);
} else {
  console.log(`ERROR: unknown command ${command}`);
  process.exit(2);
}
