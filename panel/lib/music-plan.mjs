/**
 * Filme gore muzik (Tek parca "Muzik: Uretilsin"):
 * - Sure: film sahne sinirlarinda bolumlere ayrilir (her bolum en cok BOLUM_EN_UZUN sn);
 *   her bolume ayri muzik uretilir, bolumler yumusak gecisle (acrossfade) birlesir.
 *   Uzun filmde ayni parca donup durmaz.
 * - Icerik: tarz bossa genel tarz ve her bolumun havasi sahnelerin anlatimindan cikarilir
 *   (yerel yazi modeli); tarz verilmisse temel odur, bolumler yine sahnelere gore renk alir.
 *   Yazi modeli yoksa tarz ya da varsayilan sinematik tarz kullanilir.
 */
import { CancelError, UserError } from './errors.mjs';
import { runText, hasText } from './text-model.mjs';

export const SECTION_LONGEST = 240;
export const SECTION_TRANSITION = 3;
const DEFAULT_STYLE = 'cinematic ambient background score, emotional, warm strings and piano, no vocals';

/**
 * Sahne baslangiclari ve sureleriyle (sn) bolumler: [{ bas, sure, sahneler: [i...] }].
 * Bir sahne BOLUM_EN_UZUN'dan uzunsa tek basina bir bolumdur.
 */
export function musicSections(starts, durations, total, longest = SECTION_LONGEST) {
  const sections = [];
  let current = null;
  for (let i = 0; i < durations.length; i++) {
    const last = i + 1 < starts.length ? starts[i + 1] : total;
    if (current && last - current.startedAt > longest) {
      sections.push(current);
      current = null;
    }
    if (!current) current = { startedAt: starts[i], scenes: [] };
    current.scenes.push(i);
    current.last = last;
  }
  if (current) sections.push(current);
  return sections.map((b) => ({ startedAt: b.startedAt, duration: Math.max(1, b.last - b.startedAt), scenes: b.scenes }));
}

const SYSTEM = [
  'Sen film muzigi yonetmenisin. Yalnizca istenen JSON nesnesini dondur; aciklama, markdown ya da kod blogu yazma.',
  'Bicim: {"general": "...", "sections": ["...", "..."]}',
  '- Her deger ACE-Step muzik modeli icin INGILIZCE etiket listesidir: tur, enstrumanlar, tempo hissi, duygu; en cok 25 sozcuk.',
  '- Hepsi arka plan film muzigi: sozsuz (no vocals), anlatimin altinda kalacak sekilde sakin dinamik.',
  '- genel: a shared style for the whole film. bolumler: for each section, a style that keeps the general style but is adapted to the mood of that section (tension, hope, sorrow, finale...); same order and count as the given sections.',
].join('\n');

export function musicPlanPrompt({ style, sections }) {
  return [
    style ? `Kullanicinin istedigi temel tarz (koru): ${style}` : 'Temel tarzi sen sec (filmin konusuna gore).',
    `Bolum sayisi: ${sections.length}`,
    ...sections.map((b, i) => `Bolum ${i + 1} (${Math.round(b.duration)} sn): ${b.narrations.join(' ').slice(0, 900)}`),
    'JSON nesnesini dondur.',
  ].join('\n');
}

export function parseMusicPlan(text, count) {
  const s = String(text ?? '');
  const startedAt = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (startedAt < 0 || last <= startedAt) throw new UserError('Could not read the music plan.');
  const v = JSON.parse(s.slice(startedAt, last + 1));
  const general = String(v?.general ?? '').trim().slice(0, 400);
  const list = (Array.isArray(v?.sections) ? v.sections : []).map((x) => String(x ?? '').trim().slice(0, 400));
  return { general, sections: Array.from({ length: count }, (_, i) => list[i] || general) };
}

/** Bolum tarzlari: yazi modeliyle (varsa) sahnelere gore; yoksa tarz ya da varsayilan. Is icinden: ekran kartini beklemez. */
export async function musicStyles({ style, sections, log = () => {}, signal = null }) {
  const backupDir = () => ({ general: style || DEFAULT_STYLE, sections: sections.map(() => style || DEFAULT_STYLE) });
  if (!hasText()) return backupDir();
  try {
    const p = await runText({ system: SYSTEM, prompt: musicPlanPrompt({ style, sections }), json: true, maxToken: 4096, signal, name: 'Music plan', parse: (m) => parseMusicPlan(m, sections.length) });
    // Kullanicinin tarzi her bolumun basinda kalir (model kaydirmasin).
    if (style) p.sections = p.sections.map((b) => (b.toLowerCase().includes(style.toLowerCase()) ? b : `${style}, ${b}`));
    return p;
  } catch (e) {
    if (e instanceof CancelError) throw e; // is iptal: temel tarzla devam edilmez
    log(`Could not write the music plan, using the base style: ${e.message}`);
    return backupDir();
  }
}
