// Toplanan örneklerden SEO kurallarına uyanları seçer; yüksek görüntülenen yazıları ağırlıklandırır.
// node veri-sec.mjs <ham.jsonl> <secilmis.jsonl>  -> egit.py hazirla'ya verilecek {"messages": [...]} satırları
import { readFileSync, writeFileSync } from 'node:fs';

const [login, exit] = process.argv.slice(2);
const lines = readFileSync(login, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s));
const h2 = (s) => (String(s ?? '').match(/<h2[\s>]/gi) ?? []).length;
const flat = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const TEXTS = /\p{Script=Hangul}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Cyrillic}|\p{Script=Arabic}|\p{Script=Thai}/u;
const tagsClosed = (s) => {
  const open = (String(s).match(/<(p|h2|h3|ul|ol|li|table|strong|em|a)\b/gi) ?? []).length;
  const close = (String(s).match(/<\/(p|h2|h3|ul|ol|li|table|strong|em|a)>/gi) ?? []).length;
  return Math.abs(open - close) <= 2;
};

const reason = {};
const red = (n) => {
  reason[n] = (reason[n] ?? 0) + 1;
  return false;
};
const metaSuitable = (h) => {
  if (h.meta_title !== undefined && (!h.meta_title || h.meta_title.length > 60)) return red('meta title > 60');
  if (h.meta_description !== undefined && (h.meta_description.length < 120 || h.meta_description.length > 165)) return red('meta description out of range');
  return true;
};
function suitable(o) {
  let h;
  try {
    h = JSON.parse(o.messages[2].content);
  } catch {
    return red('target is not JSON');
  }
  const input = o.messages[1].content;
  if (TEXTS.test(o.messages[2].content) && !TEXTS.test(input)) return red('foreign text');
  if (o.task === 'translate') {
    let source;
    try {
      source = JSON.parse(input.split('\n\nUYARI:')[0]);
    } catch {
      return red('input is not JSON');
    }
    if (!h.title || !h.content) return red('translation missing field');
    if (h2(h.content) !== h2(source.content)) return red('translation H2 count differs');
    const ratio = flat(h.content).length / Math.max(1, flat(source.content).length);
    if (ratio < 0.75 || ratio > 1.6) return red('translation length ratio');
    if (!tagsClosed(h.content)) return red('HTML bozuk');
    return metaSuitable(h);
  }
  if (o.task === 'meta') return metaSuitable(h);
  if (o.task === 'write') {
    if (!h.title || h2(h.content) < 3) return red('original text < 3 subheadings');
    if (flat(h.content).split(' ').length < 500) return red('original text < 500 words');
    if (!tagsClosed(h.content)) return red('HTML bozuk');
    return metaSuitable(h);
  }
  if (o.task === 'section') {
    if (h2(h.section_html) < 1 || flat(h.section_html).split(' ').length < 150) return red('section too short');
    return tagsClosed(h.section_html) || red('HTML bozuk');
  }
  if (o.task === 'refresh') {
    if (!h.content || !tagsClosed(h.content)) return red('refresh content');
    return metaSuitable(h);
  }
  return red('unknown task');
}

// Local generation (source sites -> Gemma, sectioned): the ones rejected at generation are already out; cannot exceed
// the number of real original articles (the hand-written style stays dominant).
const isLocal = (o) => o.sourceType === 'local-generation';
const real = lines.filter((o) => !isLocal(o));
const localRaw = lines.filter((o) => isLocal(o) && !o.red);
// Değerlendirme ayrımı: post kimliği 10'a bölünenler (tüm dil/görevleriyle) eğitime GİRMEZ -> ayrik.jsonl
const isDiscrete = (o) => o.post !== undefined && o.post % 10 === 0;
const discrete = real.filter(isDiscrete);
// Prompt shortening (SHORTEN=1): the guide texts that go verbatim in every request are replaced by a short marker; the
// model internalises the guide through training. The mapping <output>-abbreviations.json: the panel makes the same swap in use.
const ABBREVIATIONS = process.env.SHORTEN === '1' ? {
  '[[kilavuz:nedese-yazim]]': readFileSync(process.env.GUIDE_WRITING ?? new URL('../../data/nedese/kilavuz-yazim.md', import.meta.url), 'utf8'),
  '[[kilavuz:nedese-ceviri]]': readFileSync(process.env.GUIDE_CEVIRI ?? new URL('../../data/nedese/kilavuz-ceviri.md', import.meta.url), 'utf8'),
} : {};
const shorten = (m) => m.map((x) => (x.role === 'system' ? { ...x, content: Object.entries(ABBREVIATIONS).reduce((s, [k, v]) => s.split(v).join(k), x.content) } : x));
// EN_UZUN_KARAKTER: bağlama sığmayacak örnekler (karakter/3,4 ≈ belirteç) seçime girmez (egit.py zaten atlar).
const longest = Number(process.env.LONGEST_CHARACTER || 0);
const fits = (o) => !longest || shorten(o.messages).reduce((t, m) => t + m.content.length, 0) <= longest;
let selectedReal = real.filter((o) => !isDiscrete(o)).filter(suitable).filter(fits);
// CEVIR_EN_FAZLA: çeviri örnekleri dillere eşit, çok okunan önce (çeviri baskın olmasın; asıl kazanç özgün yazı/SEO).
const translateLimit = Number(process.env.TRANSLATE_MAX || 0);
if (translateLimit) {
  const languages = {};
  for (const o of selectedReal.filter((x) => x.task === 'translate').sort((a, b) => (b.view ?? 0) - (a.view ?? 0))) (languages[o.language] ??= []).push(o);
  const selectTranslate = [];
  for (let i = 0; selectTranslate.length < translateLimit && Object.values(languages).some((l) => l.length > i); i++) for (const l of Object.values(languages)) if (l[i] && selectTranslate.length < translateLimit) selectTranslate.push(l[i]);
  selectedReal = [...selectedReal.filter((x) => x.task !== 'translate'), ...selectTranslate];
}
const writeReal = selectedReal.filter((o) => o.task === 'write').length;
const selectedLocal = localRaw.filter(suitable).filter(fits).slice(0, writeReal);
const selected = [...selectedReal, ...selectedLocal];
writeFileSync(exit.replace(/\.jsonl$/, '') + '-ayrik.jsonl', discrete.map((o) => JSON.stringify(o)).join('\n') + '\n');
// Görüntülenmeye göre üst %20'lik yazıların örnekleri iki kez (model iyi performans gösterenleri daha çok görsün)
const threshold = [...selectedReal].map((o) => o.view ?? 0).sort((a, b) => b - a)[Math.floor(selected.length * 0.2)] ?? Infinity;
if (Object.keys(ABBREVIATIONS).length) writeFileSync(exit.replace(/\.jsonl$/, '') + '-kisaltmalar.json', JSON.stringify(ABBREVIATIONS));
const output = [];
for (const o of selected) {
  output.push({ messages: shorten(o.messages) });
  if ((o.view ?? 0) > threshold && threshold > 0) output.push({ messages: shorten(o.messages) });
}
writeFileSync(exit, output.map((o) => JSON.stringify(o)).join('\n') + '\n');
const task = {};
for (const o of selected) task[`${o.task}${o.source ? `/${o.source}` : ''}`] = (task[`${o.task}${o.source ? `/${o.source}` : ''}`] ?? 0) + 1;
console.log(JSON.stringify({ raw: lines.length, discrete: discrete.length, local: selectedLocal.length, selected: selected.length, trainingLine: output.length, opinionThreshold: threshold, task, red: reason }, null, 1));
