// Generates the target article for the source articles' bot prompt LOCALLY (panel /llm/v1/responses, sectioned),
// checks it with the SEO rules, and turns the passing ones into training examples. NO request to DeepSeek. Resumes
// where it stopped if interrupted.
// node generate-targets.mjs <source-articles.jsonl> <output.jsonl> [max] [sectioned=1]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const [login, exit, maxS = '100000', sectionedS = '1'] = process.argv.slice(2);
const K = JSON.parse(readFileSync(`${ROOT}panel-data/settings.json`, 'utf8')).apiKey;
const done = new Set(existsSync(exit) ? readFileSync(exit, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s).link) : []);
const records = readFileSync(login, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)).filter((o) => o.prompt && !done.has(o.link));
const h2 = (s) => (String(s ?? '').match(/<h2[\s>]/gi) ?? []).length;
const flat = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const TEXTS = /\p{Script=Hangul}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Cyrillic}|\p{Script=Arabic}|\p{Script=Thai}/u;

function check(h) {
  if (!h?.title || !h?.content) return 'alan eksik';
  if (h2(h.content) < 3) return '< 3 subheadings';
  if (flat(h.content).split(' ').length < 500) return '< 500 kelime';
  if (!h.meta_title || h.meta_title.length > 60) return 'meta title';
  if (!h.meta_description || h.meta_description.length < 120 || h.meta_description.length > 165) return 'meta description';
  if (TEXTS.test(JSON.stringify(h))) return 'foreign text';
  return null;
}

let n = 0;
const counter = { passed: 0, remained: 0 };
for (const o of records.slice(0, Number(maxS))) {
  const startedAt = Date.now();
  let h = null;
  let reason = null;
  try {
    const r = await fetch('http://127.0.0.1:1165/llm/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${K}` },
      body: JSON.stringify({ model: 'local', instructions: o.prompt.system, input: o.prompt.user, text: { format: { type: 'json_object' } }, temperature: 0.7, max_output_tokens: 8192, metadata: { sectioned: sectionedS === '1' } }),
    });
    const j = await r.json();
    const text = j.output?.find((x) => x.type === 'message')?.content?.find((c) => c.type === 'output_text')?.text;
    h = JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
    reason = check(h);
  } catch (e) {
    reason = `error: ${e.message.slice(0, 80)}`;
  }
  n++;
  counter[reason ? 'remained' : 'passed']++;
  // Kalan da kaydedilir (neden ile): seçim betiği yalnız geçenleri alır; kaldığı yerden sürme için link gerekli.
  appendFileSync(exit, JSON.stringify({ task: 'write', sourceType: 'local-generation', link: o.link, source: o.source, red: reason,
    messages: [{ role: 'system', content: o.prompt.system }, { role: 'user', content: o.prompt.user }, { role: 'assistant', content: JSON.stringify(h) }] }) + '\n');
  console.log(`${n}/${records.length} ${o.source} · ${((Date.now() - startedAt) / 1000).toFixed(0)} sn · ${reason ?? `geçti (${flat(h.content).split(' ').length} kelime, ${h2(h.content)} başlık)`}`);
}
console.log(JSON.stringify(counter));
