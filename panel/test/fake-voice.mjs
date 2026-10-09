/**
 * Fake voice-over / voice design (for the tests; no graphics card). Checked against the real scripts
 * (script-contract.mjs): the options, the job.json keys, the printed lines and the report keys.
 *
 * Like voice\speak.py (and voxcpm\generate.py, ema\generate.py):  --job job.json --folder out --trial N [--vary --naturalness]
 *   per line <id>_<k>.wav + the selected <id>.wav + report.json; "generated ..." lines.
 *   Duration: text length / 13 s (close to Turkish reading speed).
 * Like voice\voxcpm\description.py / voice\design\design.py:  --spec @s.txt --text @t.txt --output timbre.wav [...]
 * Like voice\convert.py (timbre transfer):  --script convert.py [--folder] source target output
 *
 * Environment: FAKE_VOICE_ERROR=1 -> prints a Python trace and exits with 1; WAIT_FAKE_VOICE=ms -> waits on every take;
 * FAKE_VOICE_ENGINE: the engine the panel chose (voxcpm, kizagan, ema, qwen or empty).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { makeWav, wavDuration } from '../lib/media.mjs';
import { expectArgs, expectKeys, expectKeysInAny, expectSource } from './script-contract.mjs';

const a = process.argv.slice(2);
const value = (name) => {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
};
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const engine = process.env.FAKE_VOICE_ENGINE || '';

if (process.env.FAKE_VOICE_ERROR === '1') {
  console.error('Traceback (most recent call last):');
  console.error('  File "speak.py", line 66, in generate');
  console.error('torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB');
  process.exit(1);
}

// Like voice\convert.py (settings voiceScriptCommand: --script convert.py ...): source target output, or --folder
// input target output; the output keeps the source's length in a low voice. Fake only: <output folder>\timbre.json
// says whose timbre it took.
if (a[0] === '--script' && a[1] === 'convert.py') {
  const rest = a.slice(2);
  expectArgs('voice/convert.py', rest);
  expectSource('voice/convert.py', "f'{output} {");
  const [source, target, output] = rest.filter((x) => x !== '--folder');
  const jobs = rest.includes('--folder') ? readdirSync(source).filter((f) => f.endsWith('.wav')).map((f) => [join(source, f), join(output, f)]) : [[source, output]];
  mkdirSync(rest.includes('--folder') ? output : dirname(output), { recursive: true });
  for (const [from, to] of jobs) {
    const seconds = wavDuration(from);
    writeFileSync(to, makeWav(seconds, { hz: 100 }));
    console.log(`${to} ${seconds.toFixed(2)} s`);
  }
  writeFileSync(join(rest.includes('--folder') ? output : dirname(output), 'timbre.json'), JSON.stringify({ target, files: jobs.map(([, to]) => to) }));
  process.exit(0);
}

if (value('--spec')) {
  const script = engine === 'voxcpm' ? 'voice/voxcpm/description.py' : 'voice/design/design.py';
  expectArgs(script, a);
  const output = value('--output');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, makeWav(2.5, { hz: 140 }));
  // Like description.py --candidate N --report r.json: the candidates are measured and the best fit wins (type animal:
  // high pitch; --separate: similarity)
  const candidate = Number(value('--candidate') ?? 1);
  if (candidate > 1 && value('--report')) {
    const i = a.indexOf('--separate');
    const separate = [];
    for (let j = i + 1; i >= 0 && j < a.length && !a[j].startsWith('--'); j++) separate.push(a[j]);
    const animal = value('--type') === 'animal';
    const candidates = Array.from({ length: candidate }, (_, k) => {
      const seed = 101 + k * 101;
      const f0 = (animal ? 380 : 240) + k * 60;
      const o = { seed, file: `timbre_${seed}.wav`, duration: 2.5, f0, age: 9, female: 0.01, male: 0.01, child: 0.98, ...(separate.length ? { similarity: 0.9 - k * 0.02 } : {}) };
      o.score = Math.round((f0 / 100 + (o.similarity ? 1 - o.similarity : 0)) * 1000) / 1000;
      console.log(`candidate seed=${seed} f0=${f0} age=9 child=0.98 female=0.01 male=0.01${o.similarity ? ` similarity=${o.similarity}` : ''} score=${o.score}`);
      return o;
    });
    const selected = candidates.reduce((e, x) => (x.score > e.score ? x : e));
    console.log(`selected seed=${selected.seed} score=${selected.score}`);
    const report = { target: value('--target'), gender: value('--gender'), type: value('--type') ?? 'human', separate, candidates, selected: selected.seed };
    expectKeys(script, ...Object.keys(report), ...Object.keys(candidates[0]));
    writeFileSync(value('--report'), JSON.stringify(report, null, 1));
  }
  console.log(`${output} 2.50 s`);
  process.exit(0);
}

// Every engine goes through speak.py (strict parse_args): directly (Chatterbox) or after the engine's generate.py with
// the same arguments + --check-only (voxcpm\speak.bat, ema\speak.bat). generate.py takes its part (parse_known_args).
expectArgs('voice/speak.py', [...a, ...(engine ? ['--check-only'] : [])]);
const generator = engine === 'ema' ? 'voice/ema/generate.py' : engine ? 'voice/voxcpm/generate.py' : 'voice/speak.py';
expectArgs(generator, a.filter((x) => !x.startsWith('--') || ['--job', '--folder', '--trial'].includes(x)));
expectSource(generator, 'generated {');
expectSource('voice/speak.py', ' error {', "'report.json'");

const jobPath = value('--job');
const job = JSON.parse(readFileSync(jobPath, 'utf8'));
// Every key the panel writes is read by a script (EMA reads only the text: one voice, no cloning)
const readers = ['voice/speak.py', 'voice/voxcpm/generate.py', 'voice/ema/generate.py'];
expectKeysInAny(readers, ...Object.keys(job));
for (const s of job.lines) expectKeysInAny(readers, ...Object.keys(s));
if (engine === 'ema') expectKeys('voice/ema/generate.py', 'lines', 'id', 'text', ...(job.speed ? ['speed'] : []));
// EMA reads at the voice's pace (job speed); the others do not know it
const pace = engine === 'ema' && job.speed ? job.speed : 1;

let folder = value('--folder');
if (!isAbsolute(folder)) folder = join(dirname(jobPath), folder);
mkdirSync(folder, { recursive: true });
const trial = Number(value('--trial') ?? 1);
const report = [];
for (const s of job.lines) {
  const duration = Math.max(0.6, s.text.length / 13 / pace);
  for (let k = 0; k < trial; k++) {
    if (process.env.WAIT_FAKE_VOICE) await wait(Number(process.env.WAIT_FAKE_VOICE));
    writeFileSync(join(folder, `${s.id}_${k}.wav`), makeWav(duration, { hz: 200 + k * 20 }));
    console.log(`generated ${s.id}_${k}.wav (${duration.toFixed(2)} s)`);
  }
  writeFileSync(join(folder, `${s.id}.wav`), makeWav(duration));
  // Pitch (speak.py measures it while checking): high when the voice of the line has "elif" (the girl of the tests) in
  // its name, low otherwise
  const reference = s.reference ?? job.reference ?? null;
  const selected = { file: `${s.id}_0.wav`, heard: s.text, error: 0, duration: Math.round(duration * 100) / 100, f0: /elif/i.test(reference ?? '') ? 280 : 120 };
  expectKeys('voice/speak.py', 'id', 'text', 'selected', 'candidates', ...Object.keys(selected), 'words');
  // Fake only: which voice and engine read the line (the tests check it)
  Object.assign(selected, { reference, engine: engine || null, pace });
  report.push({ id: s.id, text: s.text, selected, candidates: [selected] });
  console.log(`${s.id.padEnd(10)} error 0.000 ${duration.toFixed(2)} s  <- ${s.text}`);
}
// One take ("Fast"): speak.py writes no report (no Whisper)
if (trial > 1 || a.includes('--naturalness')) writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 1), 'utf8');
