// yerel-eski.php çıktısını özetler: DeepSeek'in geçmişte yazdığı ile yerelin bugün yazdığı yan yana.
// node eski-ozet.mjs <eski.json> [--metin]   (--metin: kısaltılmış metinleri de basar)
import { readFileSync } from 'node:fs';
const [file, flag] = process.argv.slice(2);
const v = JSON.parse(readFileSync(file, 'utf8'));
const flat = (h) => String(h ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const word = (h) => flat(h).split(' ').filter(Boolean).length;
const h2 = (h) => (String(h ?? '').match(/<h2/gi) ?? []).length;
const short = (s, n = 300) => { s = flat(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const duration = (o) => o.calls.reduce((t, i) => t + (v.calls[i]?.local?.duration ?? 0), 0).toFixed(0);
// Kaynakta/girdide geçmeyen ve tuhaf görünen sözcükler (yazım kayması adayı): karışık yazı veya aynı harf 3 kez.
const odd = (output, input) => {
  const g = new Set(flat(input).toLocaleLowerCase('tr').match(/[\p{L}]+/gu) ?? []);
  return [...new Set((flat(output).match(/[\p{L}]+/gu) ?? []).filter((w) => !g.has(w.toLocaleLowerCase('tr')) && (/(\p{L})\1\1/u.test(w) || /[^\p{Script=Latin}]/u.test(w) && /\p{Script=Latin}/u.test(w))))];
};
for (const o of v.examples) {
  const startedAt = `\n== ${o.task} ${JSON.stringify({ run: o.run, post: o.post, language: o.language, query: o.query })} · yerel ${duration(o)} sn`;
  console.log(startedAt);
  if (o.error || o.skipped) { console.log('  HATA/ATLANDI:', o.error ?? o.skipped); continue; }
  const input = o.calls.map((i) => v.calls[i]?.user ?? '').join(' ');
  if (o.task === 'section') {
    console.log(`  DeepSeek: ${word(o.deepseek)} words, ${h2(o.deepseek)} headings (${o.deepseek_source})`);
    console.log(`  yerel   : ${o.local_applied ? `${word(o.local)} kelime, ${h2(o.local)} başlık` : 'UYGULANMADI — ' + o.local_message}`);
    console.log('  tuhaf:', odd(o.local, input).join(', ') || '-');
    if (flag) { console.log('  DS  :', short(o.deepseek, 600)); console.log('  YRL :', short(o.local, 600)); }
  } else if (o.task === 'meta') {
    for (const k of ['once', 'deepseek', 'local']) console.log(`  ${k.padEnd(8)}: [${(o[k]?.meta_title ?? '').length}] ${o[k]?.meta_title} | [${(o[k]?.meta_description ?? '').length}] ${o[k]?.meta_description}`);
    if (!o.local_applied) console.log('  yerel UYGULANMADI —', o.local_message);
  } else if (o.task === 'refresh') {
    console.log(`  period: ${o.tag}`);
    for (const k of ['once', 'deepseek', 'local']) console.log(`  ${k.padEnd(8)}: ${word(o[k]?.content)} words, ${h2(o[k]?.content)} headings | ${o[k]?.title}`);
    if (!o.local_applied) console.log('  yerel UYGULANMADI —', o.local_message);
    console.log('  tuhaf:', odd(o.local?.content, input).join(', ') || '-');
  } else if (o.task === 'write') {
    console.log(`  kaynak: ${o.source_title} (${o.source_length} karakter)`);
    console.log(`  DeepSeek: ${word(o.deepseek?.content)} words, ${h2(o.deepseek?.content)} headings | ${o.deepseek?.title}`);
    console.log(`  yerel   : ${o.local ? `${word(o.local.content)} kelime, ${h2(o.local.content)} başlık | ${o.local.title}` : 'YOK'}`);
    console.log(`  meta DS : ${o.deepseek?.meta_title} | ${o.deepseek?.meta_description}`);
    console.log(`  meta YRL: ${o.local?.meta_title} | ${o.local?.meta_description}`);
    console.log('  tuhaf:', odd(o.local?.content, input).join(', ') || '-');
    if (flag) { console.log('  DS  :', short(o.deepseek?.content, 700)); console.log('  YRL :', short(o.local?.content, 700)); }
  } else if (o.task === 'translate') {
    const t = word(o.tr?.content);
    console.log(`  TR ${t} words, ${h2(o.tr?.content)} headings`);
    console.log(`  DeepSeek: ${word(o.deepseek?.content)} words, ${h2(o.deepseek?.content)} headings | ${o.deepseek?.title}`);
    console.log(`  yerel   : ${o.local ? `${word(o.local.content)} kelime, ${h2(o.local.content)} başlık | ${o.local.title}` : 'YOK'}`);
    console.log(`  meta DS : ${o.deepseek?.meta_title} | ${o.deepseek?.meta_description}`);
    console.log(`  meta YRL: ${o.local?.meta_title} | ${o.local?.meta_description}`);
    console.log('  tuhaf:', odd(o.local?.content, input).join(', ') || '-');
    if (flag) { console.log('  DS  :', short(o.deepseek?.content, 500)); console.log('  YRL :', short(o.local?.content, 500)); }
  }
}
