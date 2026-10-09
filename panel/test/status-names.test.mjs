// Every status the server writes has a name in the page (09.10.2026: the page knew "cancel", the server wrote
// "cancelled", so a cancelled job and a paused download showed the raw word, untranslated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const written = (src) => new Set([...src.matchAll(/\.status = '(\w+)'/g)].map((m) => m[1]));
const keys = (src, name) => {
  const block = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`))?.[1];
  assert.ok(block, `${name} not found`);
  return new Set([...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
};

test('the page names every job and download status the server writes', () => {
  const jobs = keys(read('web/app.js'), 'STATUS_NAME');
  for (const s of written(read('lib/queue.mjs'))) assert.ok(jobs.has(s), `job status "${s}" has no name in web/app.js STATUS_NAME`);
  const downloads = keys(read('web/settings.js'), 'DOWNLOAD_STATUS');
  for (const s of written(read('lib/download.mjs'))) assert.ok(downloads.has(s), `download status "${s}" has no name in web/settings.js DOWNLOAD_STATUS`);
});
