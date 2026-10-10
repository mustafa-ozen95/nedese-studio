/**
 * Fake voice\sing.py (YingMusic-SVC): writes the three stems and the converted vocal(s) as short WAVs into the output
 * folder (a stem already there is kept, like the real script on a retry) and appends the call to FAKE_SING_LOG. Like the
 * real one it prints "Separating the vocals" and "Singing <file> in the new voice". With FAKE_SING_ERROR=1 it fails.
 * The options and the printed lines are checked against the real script (script-contract.mjs).
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWav } from '../lib/media.mjs';
import { expectArgs, expectSource } from './script-contract.mjs';

const SCRIPT = 'voice/sing.py';
const argv = process.argv.slice(2);
expectArgs(SCRIPT, argv);
// "automatic pitch shift N semi tones" comes from YingMusic-SVC's my_inference.py, which sing.py calls
expectSource(SCRIPT, "print('Separating the vocals'", "print(f'Singing {source.name} in the new voice'");
if (process.env.FAKE_SING_ERROR) {
  console.log('Traceback (most recent call last): torch.OutOfMemoryError: CUDA out of memory');
  process.exit(1);
}
const [song, reference, output] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--shift'));
const backing = argv.includes('--backing');
const shift = argv.includes('--shift') ? Number(argv[argv.indexOf('--shift') + 1]) : null;
const stems = ['vocals.wav', 'backing.wav', 'instrumental.wav'];
const separated = !stems.every((d) => existsSync(join(output, d)));
if (separated) {
  console.log('Separating the vocals');
  for (const d of stems) writeFileSync(join(output, d), makeWav(3));
}
// FAKE_SING_FAIL_ONCE=<file>: the first call separates, then fails (a retry must not separate again)
if (process.env.FAKE_SING_FAIL_ONCE && !existsSync(process.env.FAKE_SING_FAIL_ONCE)) {
  writeFileSync(process.env.FAKE_SING_FAIL_ONCE, '1');
  if (process.env.FAKE_SING_LOG) appendFileSync(process.env.FAKE_SING_LOG, `${JSON.stringify({ song, reference, output, backing, shift, separated, failed: true })}\n`);
  console.log('Traceback (most recent call last): RuntimeError: interrupted');
  process.exit(1);
}
for (const [source, target] of [['vocals.wav', 'sung.wav'], ...(backing ? [['backing.wav', 'sung-backing.wav']] : [])]) {
  if (existsSync(join(output, target))) continue;
  console.log(`Singing ${source} in the new voice`);
  console.log(`automatic pitch shift ${shift ?? 12} semi tones`);
  writeFileSync(join(output, target), makeWav(3));
}
if (process.env.FAKE_SING_LOG) appendFileSync(process.env.FAKE_SING_LOG, `${JSON.stringify({ song, reference, output, backing, shift, separated })}\n`);
console.log('Done');
