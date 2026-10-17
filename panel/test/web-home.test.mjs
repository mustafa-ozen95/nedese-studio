/**
 * The panel's home is Chat: the "Nedese Studio" mark and an empty or unknown address open it.
 * 17.10.2026: the mark linked to #image and an empty address fell back to Image (Production).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('home: the brand mark opens Chat', () => {
  const mark = /<a\b[^>]*class="topbar__mark"[^>]*>/.exec(html)?.[0];
  assert.ok(mark, 'brand mark found');
  assert.match(mark, /href="#chat"/);
});

test('home: an empty or unknown address falls back to Chat', () => {
  assert.match(app, /const section = SECTIONS\.includes\(b\) \? b : 'chat';/);
});
