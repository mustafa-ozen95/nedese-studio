/**
 * Fake lip\mouth.py (LatentSync): copies --video to --output; appends the call to the FAKE_MOUTH_RECORD file (speakers:
 * audio track, its duration, face box). Like the real one "model loaded", "speaker n/m done", "mouth done".
 * With FAKE_MOUTH_ERROR=1 it exits with an error. The options and the printed lines are checked against the real script
 * (script-contract.mjs).
 */
import { appendFileSync, copyFileSync } from 'node:fs';
import { wavDuration } from '../lib/media.mjs';
import { expectArgs, expectSource } from './script-contract.mjs';

const SCRIPT = 'lip/mouth.py';
expectArgs(SCRIPT, process.argv.slice(2));
expectSource(SCRIPT, 'f"model loaded (', 'f"speaker {n}/{len(speakers)} done (', 'f"mouth done (');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
if (process.env.FAKE_MOUTH_ERROR) {
  console.log('Traceback (most recent call last): RuntimeError: Face not detected');
  process.exit(1);
}
const speakers = process.argv.flatMap((a, i) => (a === '--speaker' ? [process.argv[i + 1]] : [])).map((k) => {
  const [voice, box] = [k.slice(0, k.lastIndexOf('@')), k.slice(k.lastIndexOf('@') + 1)];
  return { duration: wavDuration(voice), box: box.split(',').map(Number) };
});
console.log('model loaded (0 s)');
copyFileSync(arg('--video'), arg('--output'));
speakers.forEach((_, i) => console.log(`speaker ${i + 1}/${speakers.length} done (0 s)`));
if (process.env.FAKE_MOUTH_RECORD) appendFileSync(process.env.FAKE_MOUTH_RECORD, `${JSON.stringify({ video: arg('--video'), speakers })}\n`);
console.log('mouth done (0 s)');
