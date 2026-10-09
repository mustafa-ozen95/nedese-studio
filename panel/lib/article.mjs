/**
 * Bolum bolum ozgun makale (yerel yazi modeli). Tek seferde Gemma 4 26B 550-850 kelimede kaliyor,
 * kurgusu kaynagi izliyordu; bolumlu akisla (olculdu 04.10.2026, nedese botunun DeepSeek'e giden
 * birebir istemleriyle) 1230 kelime, anlati sirasi kaynaktan farkli, abarti/uydurma yok (DeepSeek 1059).
 *
 *  1) Plan (JSON semasi): bot kilavuzundaki meta alanlari + giris + 5-7 bolum; her bolume YALNIZ ona
 *     ait kaynak bilgileri (bilgi listesi verilmeyen bolum konudan sapiyordu).
 *  2) Her bolum ayri cagri, sema {"html"} (semasiz model bolum yerine makale JSON'u donuyordu); tek <h2>.
 *  3) Onceki bolumlerle kelime uclusu ortusmesi %12'yi asarsa uyariyla yeniden yazilir.
 * Cikti: botun bekledigi JSON (title, excerpt, content, meta_*, tag_keywords_en, category_name).
 */

const S = { type: 'string' };
const PLAN_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'plan',
    schema: {
      type: 'object',
      properties: {
        title: S, excerpt: S, meta_title: S, meta_description: S, meta_keywords: S, tag_keywords_en: S, category_name: S, intro: S,
        sections: { type: 'array', minItems: 5, maxItems: 7, items: { type: 'object', properties: { title: S, content_plan: S, infos: { type: 'array', minItems: 1, items: S } }, required: ['title', 'content_plan', 'infos'] } },
      },
      required: ['title', 'excerpt', 'meta_title', 'meta_description', 'meta_keywords', 'tag_keywords_en', 'category_name', 'intro', 'sections'],
    },
  },
};
const SECTION_SCHEMA = { type: 'json_schema', json_schema: { name: 'section', schema: { type: 'object', properties: { html: S }, required: ['html'] } } };

const EXAGGERATION = 'Exaggerated expressions are FORBIDDEN: huge, revolution, radical, magnificent, a whole new level, turning point. Calm, informative editorial tone.';

export const countWords = (h) => String(h ?? '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

function triples(h) {
  const k = String(h).replace(/<[^>]+>/g, ' ').toLocaleLowerCase('tr').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const t = new Set();
  for (let i = 0; i + 2 < k.length; i++) t.add(k.slice(i, i + 3).join(' '));
  return t;
}

/** html'in onceki bolumlerle kelime uclusu ortusme orani (0-1). */
export function repeatRatio(html, previous) {
  const a = triples(html);
  if (!a.size) return 0;
  const o = new Set(previous.flatMap((y) => [...triples(y)]));
  let n = 0;
  for (const t of a) if (o.has(t)) n++;
  return n / a.size;
}

/** Tek bolum: planlanan baslikla baslar, ikinci <h2>'den sonrasi (baska bolumu tekrar) atilir. */
export function editSection(html, title) {
  let h = String(html ?? '').replace(/^\s*<h2[^>]*>.*?<\/h2>/is, '');
  const second = h.search(/<h2[\s>]/i);
  if (second >= 0) h = h.slice(0, second);
  return `<h2>${title}</h2>${h.trim()}`;
}

/**
 * sor(sistem, kullanici, { bicim, maks }): modele bir cagri, cozulmus JSON (bozuksa {}) doner.
 * kilavuz/kaynak: botun system/user istemi. ilerleme(metin): gunluk.
 */
export async function sectionedArticle({ guide, source, ask, temperature = 0.7, progress = () => {} }) {
  const plan = await ask(`${guide}

---
STEP 1 / PLAN: Do NOT write the article yet. Following the guide, first produce the plan. Reply as JSON:
{"title","excerpt","meta_title","meta_description","meta_keywords","tag_keywords_en","category_name",
 "intro": "90-130 word introduction in <p>…</p> form (tell the reader why it matters; do not copy the opening of the source)",
 "sections": [{"title": "subheading", "content_plan": "the angle of this section (1-2 sentences)", "infos": ["concrete fact from the source to be used ONLY in this section 1", "fact 2", "…"]}]}
Rules: 6 sections. Each source fact goes to ONLY ONE section (no repetition between sections). The narrative order must be DIFFERENT from the source (the most important/current point for the reader first). The last section must be an assessment of the "what does it mean for the reader" kind; its facts are the consequences of the previous sections from the reader's point of view. Do not plan facts that are not in the source. Do not write about something not yet released as if it had been. No exaggeration in headings (revolution, huge, radical, magnificent).`, source, { format: PLAN_SCHEMA, max: 6000, temperature });
  if (!Array.isArray(plan.sections) || !plan.sections.length) throw new Error('Could not produce the article plan.');
  progress(`Plan: ${plan.sections.length} sections`);

  const written = [];
  for (const [i, b] of plan.sections.entries()) {
    const last = i === plan.sections.length - 1;
    const previous = written.map((y, k) => `${k + 1}. ${plan.sections[k].title}: ${y.replace(/<[^>]+>/g, ' ').slice(0, 300)}…`).join('\n');
    const infos = b.infos.map((x) => `  • ${x}`).join('\n');
    const getText = (o) => (typeof o?.html === 'string' ? o.html : '');
    let html = getText(await ask(`${guide}

---
STEP 2 / SECTION WRITING: Write ONLY the following section of the article. Reply as JSON: {"html": "<h2>…</h2><p>…</p>…"}
- Heading (h2): "${b.title}"
- The angle of this section: ${b.content_plan}
- Cover ONLY these source facts in this section (do not drift into the topics of other sections):
${infos}
- AT LEAST 250 words (target 250-320), 3-4 full paragraphs; a short <ul> list if needed.
- Rely only on the facts in the source; do NOT INVENT numbers, dates, features, platform/product names that are not in the source. Explain the context and the effect on the reader.
- Write ONLY this single section: one <h2> (the heading above), do not open another <h2>.
- Do NOT REPEAT what earlier sections covered. Do not write an introduction paragraph or a general summary.
- ${EXAGGERATION}
- Do not write a paragraph starting with "In conclusion"${last ? '' : ' (this is not the last section)'}.

ARTICLE PLAN: ${plan.sections.map((x, k) => `${k + 1}. ${x.title}`).join(' | ')}
${previous ? `SECTIONS WRITTEN SO FAR (summary):\n${previous}` : ''}`, source, { format: SECTION_SCHEMA, max: 2000, temperature }));
    const short = countWords(html) < 180;
    const repeat = written.length ? repeatRatio(html, written) : 0;
    if (short || repeat > 0.12) {
      progress(`Section ${i + 1} being rewritten (${short ? `short: ${countWords(html)} words` : `repeat ${Math.round(repeat * 100)}%`})`);
      const fresh = getText(await ask(`${guide}

---
STEP 2 / SECTION WRITING (retry): Write the "${b.title}" section ONLY with the following facts, AT LEAST 250 words, 3-4 paragraphs:
${infos}
Do not write an introduction or general summary paragraph; cover this topic directly. Do not invent facts that are not in the source. ${EXAGGERATION}
Reply JSON: {"html": "<h2>${b.title}</h2><p>…</p>…"}`, source, { format: SECTION_SCHEMA, max: 2000, temperature }));
      const good = (h) => countWords(h) >= 120 && (!written.length || repeatRatio(h, written) <= 0.12);
      if (good(fresh) || countWords(fresh) > countWords(html)) html = fresh;
    }
    written.push(editSection(html, b.title));
    progress(`Section ${i + 1}/${plan.sections.length}: ${countWords(written.at(-1))} words`);
  }
  const { intro, sections, ...meta } = plan;
  return { ...meta, content: `${intro ?? ''}${written.join('')}` };
}
