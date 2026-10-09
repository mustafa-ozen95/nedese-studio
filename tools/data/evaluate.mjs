// Tests the active text model with the examples held out of training (evaluation-holdout.jsonl); compares with
// DeepSeek's real output. The panel's /llm/v1/responses is used (with a trained model active the panel shortens the prompt).
// node evaluate.mjs <holdout.jsonl> <tag> [max per task=6] [sectioned=1: sectioned flow for original writing]
// Output: <tag>.json (measurements per example + summary)
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const [login, tag, maxS = '6', sectionedS = '1'] = process.argv.slice(2);
const K = JSON.parse(readFileSync(`${ROOT}panel-data/settings.json`, 'utf8')).apiKey;
const all = readFileSync(login, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s));
// Görev başına sabit sıralı alt küme (her çalıştırmada aynı örnekler)
const choice = [];
for (const g of ['write', 'translate', 'meta', 'refresh', 'section']) choice.push(...all.filter((o) => o.task === g).sort((a, b) => a.post - b.post || String(a.language).localeCompare(String(b.language))).slice(0, Number(maxS)));

const flat = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const word = (s) => flat(s).split(' ').filter(Boolean).length;
const h2 = (s) => (String(s ?? '').match(/<h2[\s>]/gi) ?? []).length;
const FOREIGN = /\p{Script=Hangul}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Cyrillic}|\p{Script=Arabic}|\p{Script=Thai}/u;
/** chrF (karakter 1-6 gram F-skoru, beta=2): çeviride referansa yakınlık, 0-100. */
function chrf(hip, ref, n = 6, beta = 2) {
  const a = flat(hip).toLowerCase().replace(/\s/g, '');
  const b = flat(ref).toLowerCase().replace(/\s/g, '');
  let p = 0;
  let r = 0;
  let count = 0;
  for (let k = 1; k <= n; k++) {
    const count1 = new Map();
    for (let i = 0; i + k <= a.length; i++) count1.set(a.slice(i, i + k), (count1.get(a.slice(i, i + k)) ?? 0) + 1);
    const count2 = new Map();
    for (let i = 0; i + k <= b.length; i++) count2.set(b.slice(i, i + k), (count2.get(b.slice(i, i + k)) ?? 0) + 1);
    let common = 0;
    for (const [g, c] of count1) common += Math.min(c, count2.get(g) ?? 0);
    const ta = Math.max(1, a.length - k + 1);
    const tb = Math.max(1, b.length - k + 1);
    p += common / ta;
    r += common / tb;
    count++;
  }
  p /= count;
  r /= count;
  return p + r === 0 ? 0 : Math.round((((1 + beta ** 2) * p * r) / (beta ** 2 * p + r)) * 1000) / 10;
}
const metaScore = (h) => ({
  metaTitleSuitable: typeof h.meta_title === 'string' && h.meta_title.length > 0 && h.meta_title.length <= 60,
  metaDescriptionSuitable: typeof h.meta_description === 'string' && h.meta_description.length >= 140 && h.meta_description.length <= 160 && /[.!?]$/.test(h.meta_description.trim()),
});

// Ayni etiketle iki kopya calismasin (cikti dosyalari karisir)
const lock = `${tag}.kilit`;
if (existsSync(lock)) throw new Error(`${lock} exists: another evaluation with this tag is running (if not, delete the file).`);
writeFileSync(lock, String(process.pid));
process.on('exit', () => rmSync(lock, { force: true }));
rmSync(`${tag}-ciktilar.jsonl`, { force: true });
const results = [];
for (const [i, o] of choice.entries()) {
  const [system, user, target] = o.messages;
  const ref = JSON.parse(target.content);
  const startedAt = Date.now();
  let h = null;
  let error = null;
  try {
    const r = await fetch('http://127.0.0.1:1165/llm/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${K}` },
      body: JSON.stringify({ model: 'local', instructions: system.content, input: user.content, text: { format: { type: 'json_object' } }, temperature: 0.7, max_output_tokens: 8192, metadata: { sectioned: o.task === 'write' && sectionedS === '1' } }),
    });
    const j = await r.json();
    const text = j.output?.find((x) => x.type === 'message')?.content?.find((c) => c.type === 'output_text')?.text;
    // Ham cikti saklanir (kalite elle incelenebilsin): <etiket>-ciktilar.jsonl
    appendFileSync(`${tag}-ciktilar.jsonl`, `${JSON.stringify({ task: o.task, post: o.post, language: o.language, text: text ?? null, error: j.error ?? null })}\n`);
    h = JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  } catch (e) {
    error = e.message.slice(0, 120);
  }
  const sec = Math.round((Date.now() - startedAt) / 100) / 10;
  const measure = { task: o.task, post: o.post, language: o.language, sec, json: Boolean(h), error };
  if (h) {
    const expected = Object.keys(ref).filter((k) => k !== 'translated_tags');
    measure.missingField = expected.filter((k) => h[k] === undefined || h[k] === '');
    measure.foreignScript = FOREIGN.test(JSON.stringify(h)) && !FOREIGN.test(user.content);
    if ('meta_title' in ref) Object.assign(measure, metaScore(h), { refMeta: metaScore(ref) });
    const content = h.content ?? h.section_html;
    const refContent = ref.content ?? ref.section_html;
    if (refContent !== undefined) Object.assign(measure, { word: word(content), refWord: word(refContent), h2: h2(content), refH2: h2(refContent) });
    if (o.task === 'translate') measure.chrf = chrf(content, refContent);
    if (o.task === 'section') measure.hasAlready = h.already_covered === true;
  }
  results.push(measure);
  console.log(`${i + 1}/${choice.length} ${o.task}/${o.language} · ${sec} sn · ${h ? `json ✓ eksik:${measure.missingField.length}${measure.chrf !== undefined ? ` chrF ${measure.chrf}` : ''}${measure.word !== undefined ? ` ${measure.word}/${measure.refWord} kelime, H2 ${measure.h2}/${measure.refH2}` : ''}${'metaTitleSuitable' in measure ? ` meta ${measure.metaTitleSuitable ? '✓' : '✗'}${measure.metaDescriptionSuitable ? '✓' : '✗'}` : ''}` : `HATA ${error}`}`);
}
const avg = (l) => (l.length ? Math.round((l.reduce((a, b) => a + b, 0) / l.length) * 100) / 100 : null);
const ratio = (l) => (l.length ? Math.round((l.filter(Boolean).length / l.length) * 1000) / 10 : null);
const summary = {};
for (const g of [...new Set(results.map((s) => s.task))]) {
  const l = results.filter((s) => s.task === g);
  summary[g] = {
    count: l.length, jsonPercent: ratio(l.map((s) => s.json)), noMissingField: ratio(l.filter((s) => s.json).map((s) => !s.missingField.length)),
    metaTitleSuitable: ratio(l.filter((s) => 'metaTitleSuitable' in s).map((s) => s.metaTitleSuitable)),
    metaDescriptionSuitable: ratio(l.filter((s) => 'metaDescriptionSuitable' in s).map((s) => s.metaDescriptionSuitable)),
    refMetaDescriptionSuitable: ratio(l.filter((s) => s.refMeta).map((s) => s.refMeta.metaDescriptionSuitable)),
    wordRatio: avg(l.filter((s) => s.refWord).map((s) => s.word / s.refWord)),
    h2Equal: ratio(l.filter((s) => s.refH2 !== undefined).map((s) => s.h2 === s.refH2)),
    chrf: avg(l.filter((s) => s.chrf !== undefined).map((s) => s.chrf)),
    foreignScript: ratio(l.filter((s) => s.json).map((s) => s.foreignScript)),
    avgSec: avg(l.map((s) => s.sec)),
  };
}
writeFileSync(`${tag}.json`, JSON.stringify({ tag, dateText: new Date().toISOString(), summary, results }, null, 1));
console.log(JSON.stringify(summary, null, 1));
