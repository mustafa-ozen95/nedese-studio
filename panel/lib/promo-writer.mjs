/**
 * Promo script writer (Production › Promo video › Write the script): the local text model turns a short brief into the
 * scenes of a promo job ({ caption, narration, section, demo }). For the panel it is told what every section shows and
 * which of them have results to show (a section of a kind never made is left out: an empty card in a promo).
 */
import { UserError } from './errors.mjs';
import { runText, hasText } from './text-model.mjs';
import { PANEL_SECTIONS } from './jobs/promo.mjs';

const SYSTEM = [
  'You write the script of a short, punchy product promo video. Return only the requested JSON object; no explanation, markdown or code block.',
  '- Each scene has a headline shown on screen (caption, 2-6 words, one or two key words wrapped in *asterisks* for the accent colour) and one spoken sentence (narration, 6-16 words, natural and confident, never the product name).',
  '- The narration sentences together tell one story: a hook first, then what it does, and a short closing line.',
  '- Never invent features that are not in the list you are given.',
  '- Write the captions and the narration in the requested language; in Turkish use the Turkish characters (ç, ğ, ı, ö, ş, ü).',
].join('\n');

/** The JSON schema of the answer (sections: the allowed panel sections, or none for another page). */
export function promoSchema(sections, count) {
  const scene = { caption: { type: 'string' }, narration: { type: 'string' } };
  if (sections) Object.assign(scene, { section: { type: 'string', enum: sections }, demo: { type: 'string' } });
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      scenes: { type: 'array', minItems: Math.min(3, count), maxItems: count, items: { type: 'object', properties: scene, required: sections ? ['caption', 'narration', 'section'] : ['caption', 'narration'] } },
    },
    required: ['subtitle', 'scenes'],
  };
}

/** The sections worth showing: those without a kind of result, or with at least one result of their kind. */
export function usableSections(counts = {}) {
  return Object.keys(PANEL_SECTIONS).filter((s) => !PANEL_SECTIONS[s].jobs || (counts[PANEL_SECTIONS[s].jobs] ?? 0) > 0);
}

export function promoPrompt({ brief, lang, panel, url, sections, count }) {
  return [
    `Brief: ${brief || (panel ? 'A promo of this AI studio that runs on your own computer: show everything it can do.' : 'A promo of this web page.')}`,
    panel
      ? `The product is a local AI studio. Its sections (use these ids as "section", in the order that tells the story best; use each at most once; "devices" shows the same studio on a phone):\n${sections.map((s) => `- ${s}: ${PANEL_SECTIONS[s].about}`).join('\n')}\n"demo" (image, edit, videoEdit only): the short English request typed in that section's form.`
      : `The page: ${url}`,
    `Language: ${lang === 'en' ? 'English' : 'Turkish'}`,
    `Scenes: ${count} or fewer. Also a "subtitle": one short line under the title.`,
    'Return the JSON object.',
  ].join('\n');
}

/** Reads the model's answer: scenes with a known section (panel), at most `count`; the demo only where it is typed. */
export function parsePromoResponse(text, { panel, sections, count }) {
  const s = String(text ?? '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  let data;
  try {
    data = JSON.parse(s.slice(first, last + 1));
  } catch {
    throw new UserError("Could not read the script writer's answer; try again.");
  }
  const seen = new Set();
  const scenes = [];
  for (const x of Array.isArray(data?.scenes) ? data.scenes : []) {
    const caption = String(x?.caption ?? '').trim().slice(0, 120);
    const narration = String(x?.narration ?? '').trim().slice(0, 400);
    if (!caption) continue;
    const scene = { caption, narration };
    if (panel) {
      if (!sections.includes(x?.section) || seen.has(x.section)) continue;
      seen.add(x.section);
      scene.section = x.section;
      if (['image', 'edit', 'videoEdit'].includes(x.section) && x?.demo) scene.demo = String(x.demo).trim().slice(0, 300);
    }
    scenes.push(scene);
    if (scenes.length >= count) break;
  }
  if (!scenes.length) throw new UserError('The script writer wrote no usable scene; describe the promo in more detail.');
  return { ...(data?.title ? { title: String(data.title).trim().slice(0, 80) } : {}), subtitle: String(data?.subtitle ?? '').trim().slice(0, 160), scenes };
}

/** From the interface or the API: waits for the graphics card while a job runs (at most 10 min). */
export function writePromo({ brief, lang, url, panel, counts, count = 10, signal = null, waiting = null }) {
  if (!hasText()) throw new UserError('The text model is not installed; write the scenes yourself.');
  const sections = panel ? usableSections(counts) : null;
  return runText({
    system: SYSTEM,
    prompt: promoPrompt({ brief, lang, panel, url, sections, count }),
    json: true,
    schema: promoSchema(sections, count),
    temperature: 0.7,
    maxToken: 4000,
    externalRequest: true,
    waitSec: 600,
    signal,
    waiting,
    name: 'Promo script writer',
    parse: (text) => parsePromoResponse(text, { panel, sections, count }),
  });
}
