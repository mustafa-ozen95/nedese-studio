/**
 * Ties the fake scripts of the tests to the real Python scripts they stand in for.
 *
 * The panel talks to its Python scripts through command line options, JSON keys and printed lines. A fake script that
 * accepts what the panel sends proves nothing when the real script expects something else (09.10.2026: after the English
 * conversion every voice, lip, upscale and training script failed on the panel's options while all tests passed). So
 * every fake checks what it receives against the source of the real script:
 *   expectArgs(script, argv)        every --option is declared there (add_argument), a subcommand is one of add_parser
 *   expectSource(script, ...texts)  the real script contains these texts (printed tokens the panel parses)
 *   expectKeys(script, ...keys)     the real script uses these JSON keys ('key' or "key")
 * A mismatch ends the fake with exit code 2 and a CONTRACT line, so the job fails and the test shows why.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const cache = new Map();
function source(script) {
  if (!cache.has(script)) cache.set(script, readFileSync(resolve(AI_ROOT, script), 'utf8'));
  return cache.get(script);
}

function fail(script, message) {
  console.log(`CONTRACT ${script}: ${message}`);
  console.error(`CONTRACT ${script}: ${message}`);
  process.exit(2);
}

/** Options (--name), positional names and subcommands declared in a Python script (argparse). */
export function scriptInterface(script) {
  const s = source(script);
  const options = new Set();
  const positional = new Set();
  for (const m of s.matchAll(/add_argument\(\s*(['"])([^'"]+)\1/g)) (m[2].startsWith('-') ? options : positional).add(m[2]);
  // A second spelling of the same option: add_argument('--a', '-b')
  for (const m of s.matchAll(/add_argument\(\s*(['"])-[^'"]*\1\s*,\s*(['"])(-[^'"]+)\2/g)) options.add(m[3]);
  const subcommands = new Set([...s.matchAll(/add_parser\(\s*(['"])([^'"]+)\1/g)].map((m) => m[2]));
  return { options, positional, subcommands };
}

export function expectArgs(script, argv, { subcommand = false } = {}) {
  const { options, subcommands } = scriptInterface(script);
  if (subcommand && !subcommands.has(argv[0])) fail(script, `no subcommand ${JSON.stringify(argv[0])} (has ${[...subcommands].join(', ')})`);
  for (const a of argv) {
    if (!/^--[A-Za-z]/.test(a)) continue;
    const name = a.split('=')[0];
    if (!options.has(name)) fail(script, `the panel passes ${name}, the script declares ${[...options].join(' ')}`);
  }
}

export function expectSource(script, ...texts) {
  const s = source(script);
  for (const t of texts) if (!s.includes(t)) fail(script, `the script never prints/contains ${JSON.stringify(t)}`);
}

export function usesKey(script, key) {
  const s = source(script);
  return s.includes(`'${key}'`) || s.includes(`"${key}"`);
}

export function expectKeys(script, ...keys) {
  for (const k of keys) if (!usesKey(script, k)) fail(script, `the script does not use the JSON key ${JSON.stringify(k)}`);
}

/** Each key is used by at least one of the scripts (a job file read by two scripts, each taking its part). */
export function expectKeysInAny(scripts, ...keys) {
  for (const k of keys) if (!scripts.some((s) => usesKey(s, k))) fail(scripts.join(' / '), `no script uses the JSON key ${JSON.stringify(k)}`);
}
