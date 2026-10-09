/**
 * Fake voice\clone\prepare.py and train.py (own voice): argv is <stage> <options...> like the panel's cloneCommand.
 * Checked against the real scripts (script-contract.mjs): the options, the printed lines and the summary.json keys.
 *   prepare: summary.json + reference.wav + reference.txt in --output; FAKE_CLONE_SPEECH: seconds of speech (75)
 *   train:   <data>\lora\latest\lora_weights.safetensors + lora_config.json
 * FAKE_CLONE_LOG=<file>: appends every call (stage and options) as a JSON line.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWav } from '../lib/media.mjs';
import { expectArgs, expectKeys, expectSource } from './script-contract.mjs';

const [stage, ...args] = process.argv.slice(2);
const script = `voice/clone/${stage}.py`;
expectArgs(script, args);
expectSource(script, "f'progress {", 'ERROR: ');
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.FAKE_CLONE_LOG) appendFileSync(process.env.FAKE_CLONE_LOG, `${JSON.stringify([stage, ...args])}\n`);

if (stage === 'prepare') {
  const output = value('--output');
  mkdirSync(output, { recursive: true });
  const speech = Number(process.env.FAKE_CLONE_SPEECH ?? 75);
  console.log('progress 5 Converting the recordings');
  writeFileSync(join(output, 'reference.wav'), makeWav(9));
  writeFileSync(join(output, 'reference.txt'), 'Merhaba, bu bir deneme kaydı.');
  const summary = { recordSec: speech + 5, speechSec: speech, parts: Math.round(speech / 6), referenceSec: 9, referenceText: 'Merhaba, bu bir deneme kaydı.', enoughForTraining: speech >= 60, trainingMinSec: 60 };
  expectKeys(script, ...Object.keys(summary));
  expectSource(script, "'summary.json'", "'reference.wav'", "'reference.txt'");
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary));
  console.log(`progress 100 ${summary.parts} parts, ${speech} s of speech`);
} else if (stage === 'train') {
  const data = value('--data');
  const summary = JSON.parse(readFileSync(join(data, 'summary.json'), 'utf8'));
  expectKeys(script, 'enoughForTraining', 'trainingMinSec', 'speechSec');
  if (!summary.enoughForTraining) {
    console.log(`ERROR: Training needs at least ${summary.trainingMinSec} s of clean speech; the recording has ${summary.speechSec} s.`);
    process.exit(1);
  }
  const latest = join(data, 'lora', 'latest');
  mkdirSync(latest, { recursive: true });
  for (const p of [25, 50, 75]) console.log(`progress ${p} Training: step ${p * 4}/300`);
  writeFileSync(join(latest, 'lora_weights.safetensors'), 'fake lora');
  writeFileSync(join(latest, 'lora_config.json'), JSON.stringify({ lora_config: { r: 32, alpha: 32 } }));
  writeFileSync(join(latest, 'optimizer.pth'), 'left out of the library');
  console.log('progress 100 Training done');
} else {
  console.log(`ERROR: unknown stage ${stage}`);
  process.exit(2);
}
