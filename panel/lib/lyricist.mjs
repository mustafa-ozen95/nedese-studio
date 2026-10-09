/**
 * Song lyricist (Music > Let the panel write the lyrics): asks the local text model (lib/text-model.mjs) for lyrics
 * tagged [verse]/[chorus] the way ACE-Step reads them, as { lyrics } JSON.
 */
import { UserError } from './errors.mjs';
import { runText, hasText } from './text-model.mjs';

const SYSTEM = [
  'You are a songwriter. Return only the requested JSON object; no explanation, markdown or code block.',
  'Format: {"lyrics": "..."}',
  '- Separate the sections with square tags on their own lines: [verse], [chorus], [bridge], [outro]. The tags always stay in English.',
  '- Keep the lines short and singable (around 6-10 syllables); the chorus should be catchy and repeat.',
  '- Write the lyrics in the requested language; in Turkish, use the Turkish characters (ç, ğ, ı, ö, ş, ü) correctly.',
  '- No square brackets other than the tags, no emoji, stage directions or chords in the lyrics.',
].join('\n');

/** Section plan by duration (s): a short song is one verse + chorus, a long one has more sections. */
export function sectionPlan(duration) {
  if (duration <= 30) return '[verse] (4 lines) and [chorus] (4 lines)';
  if (duration <= 75) return '[verse], [chorus], [verse], [chorus] (4 lines each)';
  if (duration <= 150) return '[verse], [chorus], [verse], [chorus], [bridge], [chorus] (4 lines each)';
  return '[verse], [chorus], [verse], [chorus], [bridge], [verse], [chorus], [outro] (4 lines each)';
}

export function lyricPrompt({ topic, style, language, duration }) {
  return [
    topic ? `Topic: ${topic}` : 'Topic: your choice, fitting the style.',
    style ? `Music style: ${style}` : null,
    `Language: ${language === 'en' ? 'English' : 'Turkish'}`,
    `Song length: about ${duration} seconds. Sections: ${sectionPlan(duration)}.`,
    'Return the JSON object.',
  ].filter(Boolean).join('\n');
}

/** Takes the lyrics out of the model's answer; an answer without tags gets [verse]. */
export function parseLyricResponse(text) {
  const s = String(text ?? '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) throw new UserError('The lyricist did not return a valid answer; try again.');
  let data;
  try {
    data = JSON.parse(s.slice(first, last + 1));
  } catch {
    throw new UserError("Could not read the lyricist's answer; try again.");
  }
  let lyrics = String(data?.lyrics ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
  if (!lyrics) throw new UserError('The lyricist produced no lyrics; describe the topic in more detail.');
  if (!/^\[[a-z ]+\]/i.test(lyrics)) lyrics = `[verse]\n${lyrics}`;
  return { lyrics };
}

/** From the interface: while a job runs it waits for the graphics card to be free (at most 10 min, then an error). */
export function writeLyrics({ topic, style, language, duration, signal = null }) {
  if (!hasText()) throw new UserError('The text model is not installed; write the lyrics yourself.');
  return runText({ system: SYSTEM, prompt: lyricPrompt({ topic, style, language, duration }), json: true, temperature: 0.8, maxToken: 3000, externalRequest: true, waitSec: 600, signal, name: 'Lyricist', parse: parseLyricResponse });
}
