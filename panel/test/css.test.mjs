/**
 * The stylesheets after the English rename: it turned :not( into :note( (the rules were dropped by the browser) and
 * is-dragging into job-dragging while the scripts kept is-dragging (user report 09.10.2026).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = new URL('../web/', import.meta.url);
const files = (folder, extension) => readdirSync(folder, { recursive: true }).filter((f) => f.endsWith(extension)).map((f) => join(folder, f));
const webFolder = WEB.pathname.replace(/^\/(\w:)/, '$1');
const css = files(webFolder, '.css').map((f) => ({ f, s: readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));
const scripts = files(webFolder, '.js').filter((f) => !f.includes('dictionary')).map((f) => readFileSync(f, 'utf8')).join('\n');

const PSEUDO = new Set(['not', 'is', 'where', 'has', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'lang', 'dir', 'host', 'state']);

test('stylesheets: only real functional pseudo-classes', () => {
  for (const { f, s } of css) {
    for (const m of s.matchAll(/(?<![\w-]):{1,2}([a-z-]+)\(/g)) {
      if (['url', 'var', 'calc', 'attr', 'min', 'max', 'clamp', 'rgb', 'rgba', 'hsl', 'color-mix', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'translate', 'translateX', 'translateY', 'rotate', 'scale', 'cubic-bezier', 'steps', 'repeat', 'minmax', 'format', 'local', 'env', 'counter', 'blur', 'drop-shadow', 'image-set', 'fit-content'].includes(m[1])) continue;
      if (m[0].startsWith('::')) continue;
      assert.ok(PSEUDO.has(m[1]), `${f}: :${m[1]}( is not a pseudo-class`);
    }
  }
});

test('stylesheets: every class the scripts toggle has a rule', () => {
  const all = css.map((c) => c.s).join('\n');
  const toggled = new Set([...scripts.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([\w-]+)'/g)].map((m) => m[1]));
  assert.ok(toggled.has('is-dragging'), 'the drag highlight is set by the scripts');
  for (const c of toggled) assert.match(all, new RegExp(`\\.${c}(?![\\w-])`), `.${c} is set by a script but no stylesheet styles it`);
});
