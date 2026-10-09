// The job docs name only fields the jobs read (09.10.2026: after the English renaming the docs still named "en" for
// the image width, "lang" for describe and the film's Turkish voice fields; the chat agent builds its job bodies
// from these docs, so such a field was silently ignored).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JOB_TYPES } from '../lib/api.mjs';

const dir = new URL('../lib/jobs/', import.meta.url);
const code = readdirSync(dir).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n') + readFileSync(new URL('../lib/queue.mjs', import.meta.url), 'utf8');

test('every documented job field is read by the job code, and the examples use documented fields', () => {
  const unread = [];
  for (const [type, d] of Object.entries(JOB_TYPES)) {
    const names = d.fields.flatMap((f) => f.name.split(/,\s*/));
    for (const name of names) {
      if (!/^\w+$/.test(name)) continue;
      if (!new RegExp(`\\b(g|a|x|s|input)\\??\\.${name}\\b`).test(code)) unread.push(`${type}.${name}`);
    }
    for (const k of Object.keys(d.example ?? {})) if (k !== 'type') assert.ok(names.includes(k), `${type} example uses undocumented field "${k}"`);
  }
  assert.deepEqual(unread, []);
});
