/**
 * The fixed choices of the job forms (index.html selects and radios) are values the job's validate accepts.
 * 09.10.2026: after the English conversion the film form sent musicLevel "medium" and "distinct" while the job took
 * light / middle / distinct, and the song form sent strength "cok"; every such job was refused with "is invalid".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const JOBS = new URL('../lib/jobs/', import.meta.url);
const FORM_MODULE = { audioEdit: 'audio-edit', videoEdit: 'video-edit', song: 'song', edit: 'edit', image: 'image', video: 'video', voice: 'voice', music: 'music', model3d: 'model3d', film: 'film', training: 'training', data: 'data' };

/** [{ type, fields: { name: Set(values) } }] of the job forms. */
function forms() {
  const out = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const type = /data-job-form="(\w+)"/.exec(m[1])?.[1] ?? (m[1].includes('data-training-form') ? 'training' : m[1].includes('data-data-form') ? 'data' : null);
    if (!FORM_MODULE[type]) continue;
    const fields = {};
    for (const s of m[2].matchAll(/<select\b[^>]*name="(\w+)"[^>]*>([\s\S]*?)<\/select>/g)) for (const o of s[2].matchAll(/<option\b[^>]*value="([^"]*)"/g)) (fields[s[1]] ??= new Set()).add(o[1]);
    for (const r of m[2].matchAll(/<input\b[^>]*type="radio"[^>]*>/g)) {
      const name = /name="(\w+)"/.exec(r[0])?.[1];
      const value = /value="([^"]*)"/.exec(r[0])?.[1];
      if (name && value !== undefined) (fields[name] ??= new Set()).add(value);
    }
    out.push({ type, fields });
  }
  return out;
}

/**
 * The allowed lists of choice(g.<name>, 'Label', <allowed>, ...) calls in a job module: a literal array (with
 * ...Object.keys(X) spread in), Object.keys(X) or X(), an exported list. X is exported by the module or common.mjs, or
 * a literal object of the module.
 */
function allowedLists(src, mod, common, name) {
  const value = (id) => {
    const v = mod[id] ?? common[id];
    if (v !== undefined) return v;
    const lit = new RegExp(`const ${id} = (\\{[^;]+\\});`).exec(src);
    try {
      return lit ? new Function(`return (${lit[1]});`)() : undefined;
    } catch {
      return undefined;
    }
  };
  const keysOf = (id, call) => {
    const v = value(id);
    return v === undefined ? null : Object.keys(call ? v() : v);
  };
  const lists = [];
  for (const c of src.matchAll(new RegExp(`choice\\((?:String\\()?g\\.${name}\\b[^,]*,\\s*'[^']*',\\s*(Object\\.keys\\(\\w+(?:\\(\\))?\\)|\\[[^\\]]*\\]|\\w+(?:\\.map\\(String\\))?)`, 'g'))) {
    const expr = c[1];
    const keys = /^Object\.keys\((\w+)(\(\))?\)$/.exec(expr);
    let list = null;
    if (keys) list = keysOf(keys[1], keys[2]);
    else if (expr.startsWith('[')) {
      list = [...expr.matchAll(/'([^']*)'/g)].map((x) => x[1]);
      for (const s of expr.matchAll(/\.\.\.Object\.keys\((\w+)\)/g)) list.push(...(keysOf(s[1]) ?? []));
    } else {
      const v = value(expr.replace(/\.map\(String\)$/, ''));
      list = Array.isArray(v) ? v : null;
    }
    if (list) lists.push(list.map(String));
  }
  return lists;
}

test('job forms: every fixed choice is a value the job accepts', async () => {
  const common = await import(new URL('common.mjs', JOBS).href);
  const problems = [];
  let checked = 0;
  for (const f of forms()) {
    const url = new URL(`${FORM_MODULE[f.type]}.mjs`, JOBS);
    const src = readFileSync(url, 'utf8');
    const mod = await import(pathToFileURL(url.pathname.replace(/^\/([A-Z]:)/, '$1')).href);
    for (const [name, values] of Object.entries(f.fields)) {
      const lists = allowedLists(src, mod, common, name);
      if (!lists.length) continue;
      checked += 1;
      const wanted = [...values].filter((v) => v !== '');
      if (!lists.some((l) => wanted.every((v) => l.includes(v)))) problems.push(`${f.type}.${name}: the form sends ${wanted.join(', ')}; the job accepts ${lists.map((l) => l.join(', ')).join(' / ')}`);
    }
  }
  assert.ok(checked >= 10, `checked ${checked} fields`);
  assert.deepEqual(problems, []);
});
