/**
 * Fake training\image.py: prepare (summary.json) and train (the LoRA file, training.json, progress / result lines).
 * Every option the panel passes is checked against the real script (script-contract.mjs).
 * FAKE_IMAGE_LOG=<file>: the arguments, one call per line. FAKE_IMAGE_ERROR=<subcommand>: ERROR at that stage.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { expectArgs, expectKeys, expectSource } from './script-contract.mjs';

const SCRIPT = 'training/image.py';
const [command, ...args] = process.argv.slice(2);
expectArgs(SCRIPT, [command, ...args], { subcommand: true });
expectSource(SCRIPT, "print(f'progress ", "print('result ' + json.dumps", "print(f'ERROR: ");
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.FAKE_IMAGE_LOG) appendFileSync(process.env.FAKE_IMAGE_LOG, `${JSON.stringify([command, ...args])}\n`);
if (process.env.FAKE_IMAGE_ERROR === command) {
  console.log('ERROR: GPU memory ran out. Lower the resolution (e.g. 768) or the LoRA size.');
  process.exit(2);
}
const result = (v) => console.log(`result ${JSON.stringify(v)}`);
if (command === 'prepare') {
  expectKeys(SCRIPT, 'image', 'captioned', 'trigger', 'exampleCaption');
  expectSource(SCRIPT, "'summary.json'");
  const output = value('--output');
  mkdirSync(output, { recursive: true });
  // As the real script: a folder given (a data collection) means its files; a caption is the same-named .txt
  const files = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')).flatMap((d) => (existsSync(d) && statSync(d).isDirectory() ? readdirSync(d).map((x) => join(d, x)) : [d]));
  const images = files.filter((d) => /\.(png|jpe?g|webp)$/i.test(d));
  const captions = images.map((d) => join(dirname(d), `${basename(d, extname(d))}.txt`)).filter((t) => existsSync(t)).map((t) => readFileSync(t, 'utf8').trim());
  const summary = { image: images.length, captioned: captions.length, trigger: value('--trigger'), exampleCaption: `${value('--trigger')}, ${captions[0] || value('--description') || 'image'}`, captions };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary));
  console.log(`progress 100 ${summary.image} images ready`);
  result(summary);
} else if (command === 'train') {
  expectKeys(SCRIPT, 'lora', 'step', 'durationSec', 'losses', 'resolution', 'rank', 'sizeMb');
  expectSource(SCRIPT, "'training.json'");
  const output = value('--output');
  const name = value('--name');
  mkdirSync(output, { recursive: true });
  mkdirSync(value('--lora-folder'), { recursive: true });
  for (let i = 1; i <= 3; i++) console.log(`progress ${12 + i * 25} Training step ${i * 100}/300 · loss ${(0.5 - i * 0.1).toFixed(4)}`);
  writeFileSync(join(value('--lora-folder'), `${name}.safetensors`), Buffer.from('fake lora'));
  const info = { lora: `${name}.safetensors`, step: 300, durationSec: 1, losses: [0.4, 0.3, 0.2], image: 3, resolution: Number(value('--resolution')), rank: Number(value('--rank')), sizeMb: 0.1 };
  writeFileSync(join(output, 'training.json'), JSON.stringify(info));
  result(info);
} else {
  console.log(`ERROR: unknown command ${command}`);
  process.exit(2);
}
