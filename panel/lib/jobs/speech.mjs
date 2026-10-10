/**
 * Read aloud: a chat answer read in the panel's own voice (user 10.10.2026: the browser's voice "çok robotik"). The voice
 * job's flow with the default voice, one take; the job stays out of the gallery and the job pages (queue.page), only the
 * queue shows it while it runs. The chat keeps the file per answer, so playing it again needs no new job.
 */
import { UserError } from '../errors.mjs';
import { text } from './common.mjs';
import * as voice from './voice.mjs';

export const name = 'Read aloud';

export function validate(g, ctx) {
  const lang = g.lang === 'en' ? 'en' : g.lang === 'tr' || g.lang === undefined ? 'tr' : null;
  if (!lang) throw new UserError('Language must be tr or en.');
  return { ...voice.validate({ text: text(g.text, 'Text', { max: 5000 }), voice: 'model', lang, quality: 'fast' }, ctx), title: 'Read aloud' };
}

export function summary(g) {
  return { title: g.text, detail: `Read aloud · ${g.lang === 'en' ? 'English' : 'Turkish'}` };
}

export const run = voice.run;
