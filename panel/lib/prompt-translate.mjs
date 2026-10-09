/**
 * Translates prompts into English (the local text model). Wan 2.2 understands Turkish poorly: with the same image and
 * seed "Gözlüğü çıkartsın" did not take the glasses off, its English did. Without a text model, or when it fails, the
 * prompt is used as written.
 */
import { CancelError } from './errors.mjs';
import { runText, setTextModel, hasText } from './text-model.mjs';

export { setTextModel };

/** Settings > "Translate prompts to English": when off, prompts go to the model as written (server.mjs ties it to the settings file). */
let translateOpen = () => true;
export function setPromptTranslation(isOpen) {
  translateOpen = typeof isOpen === 'function' ? isOpen : () => isOpen !== false;
}
export const promptTranslationOpen = () => translateOpen() !== false;

const SYSTEM = [
  'You translate prompts for an image-to-video model (Wan 2.2) into English.',
  'Return ONLY the English prompt text: no quotes, no explanation, no markdown.',
  'If the input is already English, return it unchanged.',
  'Keep the meaning. Phrase it as what happens in the video, present tense, with the subject doing the action',
  '("Gözlüğü çıkartsın" -> "The person takes off their glasses."). Be clear and concise; do not add new subjects, objects or events.',
].join('\n');

/** Already English (roughly): ASCII only, with common English words. */
export function isEnglish(text) {
  return /^[\x20-\x7e\s]*$/.test(text) && /\b(the|a|an|and|with|his|her|their|is|are|of|to|in|on|slowly|camera)\b/i.test(text);
}

/**
 * The translation instruction by job type. Measured 04.10.2026 (same image and seed): Qwen-Image-Edit did not follow
 * "Gözlüğü çıkar", it followed the English; Qwen-Image understands Turkish (not translated), FLUX (T5) does not; ACE-Step
 * was trained with English style tags.
 */
const COMMON = 'Return ONLY the English text: no quotes, no explanation, no markdown. If the input is already English, return it unchanged.';
export const SYSTEMS = {
  video: SYSTEM,
  edit: ['You translate image-editing instructions for Qwen-Image-Edit into English.', COMMON,
    'Keep it an imperative instruction with the same meaning; keep references like "image 1", "the second image".',
    // In 4 steps Qwen-Edit shifted the face (the nose grew when the glasses came off): name what must not change.
    'Then append one sentence telling the model to keep everything else unchanged; if a person is in the image, explicitly keep their face, facial features (nose, eyes, mouth), skin and identity exactly the same.',
    'Text that should appear in the image (usually in quotes) stays exactly as written, untranslated.'].join('\n'),
  image: ['You translate text-to-image prompts into English.', COMMON,
    'Keep every detail, style and composition word; do not add or remove content.',
    'Text that should appear in the image (usually in quotes) stays exactly as written, untranslated.'].join('\n'),
  music: ['You translate music style descriptions for the ACE-Step music model into English style tags.', COMMON,
    'Output comma-separated English tags (genre, mood, instruments, vocals, tempo feel). Keep proper names. Do not invent new elements.'].join('\n'),
};

/** Returns { prompt, translated, error?, closed? }. */
export async function makePromptEnglish(text, { type = 'video', signal = null } = {}) {
  if (!text || isEnglish(text)) return { prompt: text, translated: false };
  if (!promptTranslationOpen()) return { prompt: text, translated: false, closed: true };
  if (!hasText()) return { prompt: text, translated: false, error: 'no text model' };
  try {
    const english = await runText({ system: SYSTEMS[type] ?? SYSTEM, prompt: text, signal, name: 'Prompt translation', parse: (m) => String(m).trim().replace(/^["'“]|["'”]$/g, '') });
    return english ? { prompt: english, translated: english !== text } : { prompt: text, translated: false, error: 'empty response' };
  } catch (e) {
    if (e instanceof CancelError) throw e; // the job was cancelled or paused: it does not go on with the fallback
    return { prompt: text, translated: false, error: e.message };
  }
}

const PART_SYSTEM = [
  'You write prompts for an image-to-video model (Wan 2.2) that makes a long video in consecutive ~5 second parts.',
  'Each part starts from the LAST FRAME of the previous part, so a part must not restart or repeat an action that already happened.',
  'Return ONLY a JSON array of N English strings (one per part), no explanation.',
  'Part 1 does what the user asked. Later parts describe what naturally happens next, consistent with the end state of the',
  'previous part (e.g. once glasses are taken off they stay off). Present tense, subject doing the action, concise.',
  'Do not add new people or objects. If the request is a continuous motion (walking, dancing), later parts simply continue it.',
  'If the user gave several lines, they are the parts in order: translate each, keep its meaning, and fill missing parts with a natural continuation.',
  // 07.10.2026, the user: a speaker must face the other character, not talk into the void; later a "looks into their
  // eyes" rule made a father and daughter look like lovers: gaze and expression come from the director note
  'If a dialogue is given, the parts follow it in order: the speaker turns toward the one they talk to (or toward where an absent addressee would be) and speaks with natural mouth movement; listeners react; nobody looks at or talks to the camera. Refer to characters by how they look in the scene (e.g. "the girl", "the bearded man", "the kitten"), not by name.',
  // 07.10.2026, the user: it must look like a live-action film with real people
  'If director notes are given, act them out like a live-action film: show the emotions, facial expressions, gestures, gaze and listener reactions they describe, with natural micro-movements (blinking, breathing, small shifts of weight). Nobody smiles unless the notes say the moment is happy. Put the acting first in each part, camera movement last.',
].join('\n');

const CONTINUE_DEFAULT = 'natural subtle motion, continuing smoothly from the previous moment';

/** The context of a scene with dialogue (line order, scene image): in the motion prompts, who turns to whom to speak. */
function contextText(context) {
  const y = context?.director;
  const notes = y && !y.error
    ? [
        '\nDirector notes:',
        y.an && `- Moment: ${y.an}`,
        ...(y.characters ?? []).map((k) => `- ${k.who}: ${[k.emotion, k.thought && `thinks: ${k.thought}`, k.attitude].filter(Boolean).join('; ')}`),
        ...(context.dialogue ?? []).map((x, i) => {
          const r = y.lines?.[i];
          return r && (r.acting || r.listener) ? `- Line ${i + 1}: ${[r.acting, r.listener && `listeners: ${r.listener}`].filter(Boolean).join('; ')}` : null;
        }),
      ].filter(Boolean).join('\n')
    : '';
  if (!context?.dialogue?.length) return notes;
  const lines = context.dialogue.map((x) => `${x.who}: "${x.text}"`);
  return `\nScene image: ${context.image ?? ''}\nDialogue in this scene, in order (speaker: line):\n${lines.join('\n')}${notes}`;
}

/**
 * Long video: an English prompt for every part. With the same prompt in every part the model started the action again
 * (once the glasses were off, the second part made up new glasses and took them off again). When the user wrote several
 * lines, the lines are the parts. Without a text model: part 1 is the prompt, the rest a calm continuation.
 * Returns { prompts: string[n], translated, error? }.
 */
export async function partPrompts(text, n, { translate: translateJob = true, signal = null, context = null } = {}) {
  // Turned off in Settings: the prompt as written (several lines are the parts), the later parts calm motion
  const translate = translateJob && promptTranslationOpen();
  const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const fill = (list) => Array.from({ length: n }, (_, i) => list[i] ?? (i === 0 ? text : CONTINUE_DEFAULT));
  if (n <= 1 && !(context?.director && !context.director.error && translate && hasText())) {
    if (!translate) return { prompts: [text], translated: false };
    const c = await makePromptEnglish(text, { signal });
    return { prompts: [c.prompt], translated: c.translated, error: c.error };
  }
  if (!hasText() || !translate) return { prompts: fill(lines.length > 1 ? lines : [text]), translated: false, error: hasText() ? undefined : 'no text model' };
  try {
    const list = await runText({
      system: PART_SYSTEM, json: false,
      prompt: `N = ${n}\nUser request:\n${lines.join('\n')}${contextText(context)}`,
      signal, name: 'Part prompts',
      parse: (m) => {
        const j = JSON.parse(String(m).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
        if (!Array.isArray(j) || !j.length || !j.every((x) => typeof x === 'string' && x.trim())) throw new Error('not a JSON array');
        return j.map((x) => x.trim());
      },
    });
    return { prompts: fill(list), translated: true };
  } catch (e) {
    if (e instanceof CancelError) throw e;
    return { prompts: fill(lines.length > 1 ? lines : [text]), translated: false, error: e.message };
  }
}

/** Translates the job's prompt once and keeps it in ctx.job[field] (a retry does not translate it again). */
export async function jobPrompt(ctx, text, type, { field = 'promptEnglish', translate = true } = {}) {
  if (typeof ctx.job[field] === 'string') return ctx.job[field];
  const c = translate ? await makePromptEnglish(text, { type, signal: ctx.signal }) : { prompt: text, translated: false };
  ctx.job[field] = c.prompt;
  ctx.save();
  if (c.translated) ctx.log(`Prompt translated to English: ${c.prompt}`);
  else if (c.closed) ctx.log('Prompt translation is off (Settings): the prompt is used as written.');
  else if (c.error) ctx.log(`Prompt could not be translated; using it as is (${c.error}).`);
  return c.prompt;
}

/**
 * Director note (every scene): acting as in a real film. 07.10.2026, the user: they search for the lost kitten and
 * call it while smiling, like lovers; emotion, thought, behaviour, attitude and expression must look like a live-action
 * film. Returns { an, image, characters: [{ who, emotion, thought, attitude }], lines: [{ acting, voice, listener }] }
 * (an: the moment). image -> the image prompt; lines -> the lip window prompt and the voice-over; all of it -> the
 * motion prompts (partPrompts).
 */
const DIRECTOR_SYSTEM = [
  'You are the director of a short film. Make every character act like a real person in a live-action film: emotion and its intensity, inner thoughts, attitude, facial expressions, body language, gaze, natural micro-movements (blinking, breathing, small shifts of weight) and how listeners react.',
  'Input: the scene image description, the narration, the characters and the dialogue lines in order.',
  'Answer with JSON only: {"an": "...", "image": "...", "characters": [{"who": "...", "emotion": "...", "thought": "...", "attitude": "..."}], "lines": [{"acting": "...", "voice": "...", "listener": "..."}]}',
  '- an: one English sentence: the story moment and its emotional tone.',
  '- image: ONE English sentence for the still image of this moment: where each character looks, facial expressions and body language.',
  '- characters: each character in the scene: emotion = emotion with intensity (e.g. "deeply worried"), thought = what they think (short subtext), attitude = attitude toward the others (e.g. "protective").',
  '- lines: one object per dialogue line, same order. acting = how the speaker delivers it on screen: to whom, gaze, facial expression, hand and body movement (at most 25 words). voice = how it sounds (at most 8 words, e.g. "loud, urgent, trembling with worry"). listener = how the others react while listening: expression, gaze, small gestures (at most 20 words).',
  'Rules: expressions and gestures follow the meaning of the words and the story (worried while searching for someone lost, joyful when reunited, scared, angry, calm and reassuring). Nobody smiles or laughs unless the moment is happy.',
  'If a line is addressed to someone or something not in the scene (calling a lost pet, shouting into the distance), the speaker looks away toward where they would be, not at the other character.',
  'Family members (parent and child) show care, never a romantic gaze. Nobody looks at the camera.',
  'Do not describe clothing or appearance. Refer to characters only with the given descriptions (for example "the girl", "the man", "the kitten"), not by name.',
  'If there is no dialogue, lines is an empty list; still give an, image and characters.',
].join('\n');

export function parseDirectorNote(text, n) {
  const m = String(text);
  const j = JSON.parse(m.slice(m.indexOf('{'), m.lastIndexOf('}') + 1));
  const clean = (s, k) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, k);
  const an = clean(j.an, 300);
  const image = clean(j.image, 400);
  const characters = (Array.isArray(j.characters) ? j.characters : []).slice(0, 8).map((k) => ({ who: clean(k?.who, 60), emotion: clean(k?.emotion, 80), thought: clean(k?.thought, 160), attitude: clean(k?.attitude, 80) })).filter((k) => k.who);
  const lines = Array.from({ length: n }, (_, i) => {
    const r = Array.isArray(j.lines) ? j.lines[i] : null;
    return typeof r === 'string' ? { acting: clean(r, 200), voice: '', listener: '' } : { acting: clean(r?.acting, 200), voice: clean(r?.voice, 80), listener: clean(r?.listener, 160) };
  });
  if (!an && !image && !lines.some((r) => r.acting)) throw new Error('director note is empty');
  return { an, image, characters, lines };
}

/** dialogue: [{ who, text }] (may be empty); definition: { [name]: "the girl" } (the character descriptions). */
export async function directorNote({ image = '', narration = '', dialogue = [], definition = {}, signal = null }) {
  const prompt = [
    `Scene image: ${image || '(an existing picture)'}`,
    `Narration (Turkish): ${narration || '-'}`,
    `Characters: ${Object.values(definition).join(', ') || '(as in the image)'}`,
    dialogue.length ? 'Dialogue in order:' : 'No dialogue in this scene.',
    ...dialogue.map((k, i) => `${i + 1}. ${definition[k.who] ?? k.who}: "${k.text}"`),
  ].join('\n');
  return runText({ system: DIRECTOR_SYSTEM, prompt, json: true, temperature: 0.4, maxToken: 1200, signal, parse: (m) => parseDirectorNote(m, dialogue.length), name: 'Director note' });
}
