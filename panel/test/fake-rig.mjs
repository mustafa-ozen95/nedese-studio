/**
 * Fake tools\rig\infer.py (Make-It-Animatable): writes a stand-in analysis at --output (the fake Blender only checks it
 * is there) and appends the call to FAKE_RIG_LOG. Prints "Joints", "Weights", "Bones" and "Done" like the real one; with
 * FAKE_RIG_ERROR=1 it fails like a GPU out of memory. Checked against the real script (script-contract.mjs).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { expectArgs, expectSource } from './script-contract.mjs';
import { exitIfRunAsTest } from './not-a-test.mjs';

exitIfRunAsTest(import.meta.url);

const SCRIPT = 'tools/rig/infer.py';
const argv = process.argv.slice(2);
expectArgs(SCRIPT, argv);
expectSource(SCRIPT, "print('Joints'", "print('Weights'", "print('Bones'", "print(f'Done ");
const value = (name) => argv[argv.indexOf(name) + 1];
console.log('Joints');
if (process.env.FAKE_RIG_ERROR) {
  console.log('Traceback (most recent call last): torch.OutOfMemoryError: CUDA out of memory');
  process.exit(1);
}
console.log('Weights');
console.log('Bones');
writeFileSync(value('--output'), 'fake analysis');
if (process.env.FAKE_RIG_LOG) appendFileSync(process.env.FAKE_RIG_LOG, `${JSON.stringify({ input: value('--input'), output: value('--output') })}\n`);
console.log('Done 100 vertices, 1.0 s');
