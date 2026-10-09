/**
 * The audio / video edit plan from an instruction: turns the user's natural language request (Turkish or English) into
 * a list of the allowed operations (the local text model). The answer is checked:
 * an unknown operation is dropped, numbers are limited. Applied with ffmpeg (jobs/audio-edit.mjs, jobs/video-edit.mjs).
 * The operation and field names in the prompt are the names the plan keeps (steps / operation / start ...).
 */
import { UserError } from './errors.mjs';
import { runText, hasText } from './text-model.mjs';

const limit = (v, min, max, defaultValue) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaultValue;
};

const DIRECTIONS = ['horizontal', 'vertical'];
const POSITIONS = ['top', 'middle', 'bottom'];
const MUSIC_LEVELS = ['light', 'middle', 'distinct'];
const cutRange = (a, b) => ({ start: limit(a.start, 0, b.duration, 0), end: a.end == null ? null : limit(a.end, 0, b.duration, b.duration) });
const fadeRange = (a) => ({ in: limit(a.in, 0, 10, 0), out: limit(a.out, 0, 10, 0) });

/** The operations: description (for the text model), validate (cleans the step of the answer; null when invalid). */
const VOICE_OPERATIONS = {
  cut: { description: 'cut {start, end}: keep only this range (seconds; no end = up to the end)', validate: cutRange },
  speed: { description: 'speed {ratio}: 0.5-2 (pitch kept; 1.2 = 20% faster)', validate: (a) => ({ ratio: limit(a.ratio, 0.5, 2, 1) }) },
  pitch: { description: 'pitch {semitones}: -12..12 (duration kept; + higher, - deeper voice)', validate: (a) => ({ semitones: limit(a.semitones, -12, 12, 0) }) },
  clean: { description: 'clean {}: reduce background noise, hum and crackle', validate: () => ({}) },
  trimSilence: { description: 'trimSilence {}: shorten leading/trailing and long (0.7 s+) silences', validate: () => ({}) },
  normalize: { description: 'normalize {}: normalize loudness (broadcast standard -16 LUFS)', validate: () => ({}) },
  volume: { description: 'volume {factor}: volume down/up (0.1-4; 2 = twice as loud)', validate: (a) => ({ factor: limit(a.factor, 0.1, 4, 1) }) },
  echo: { description: 'echo {amount}: 0.1-1 (room/hall echo)', validate: (a) => ({ amount: limit(a.amount, 0.1, 1, 0.4) }) },
  fade: { description: 'fade {in, out}: fade in at the start / fade out at the end (seconds, 0-10)', validate: fadeRange },
  changeVoice: {
    description: 'changeVoice {voice}: convert the speaking voice into another voice from the library (words and intonation are kept); voice = one of the ids below',
    validate: (a, b) => (b.voices?.some((s) => s.id === a.voice) ? { voice: a.voice } : null),
  },
};

const VIDEO_OPERATIONS = {
  cut: { description: 'cut {start, end}: keep only this range (seconds)', validate: cutRange },
  speed: { description: 'speed {ratio}: 0.25-4 (2 = twice as fast, 0.5 = slow motion); audio follows', validate: (a) => ({ ratio: limit(a.ratio, 0.25, 4, 1) }) },
  rotate: { description: 'rotate {degree}: 90, 180 or 270 (clockwise)', validate: (a) => ([90, 180, 270].includes(Number(a.degree)) ? { degree: Number(a.degree) } : null) },
  flip: { description: 'flip {direction}: "horizontal" (mirror) or "vertical" (upside down)', validate: (a) => (DIRECTIONS.includes(a.direction) ? { direction: a.direction } : null) },
  crop: { description: 'crop {ratio}: crop from the center to "9:16" (portrait/Reels), "16:9", "1:1" or "4:5"', validate: (a) => (['9:16', '16:9', '1:1', '4:5', '4:3', '3:4'].includes(a.ratio) ? { ratio: a.ratio } : null) },
  scale: { description: 'scale {height}: 360-2160 (e.g. 720, 1080)', validate: (a) => ({ height: Math.round(limit(a.height, 360, 2160, 720) / 2) * 2 }) },
  mute: { description: 'mute {}: remove the audio completely', validate: () => ({}) },
  volume: { description: 'volume {factor}: volume down/up (0.1-4)', validate: (a) => ({ factor: limit(a.factor, 0.1, 4, 1) }) },
  text: {
    description: 'text {text, position, start, end}: text over the video; position "top" | "middle" | "bottom"; start/end in seconds (omit for the whole video)',
    validate: (a, b) => (typeof a.text === 'string' && a.text.trim() ? { text: a.text.trim().slice(0, 200), position: POSITIONS.includes(a.position) ? a.position : 'bottom', ...cutRange(a, b) } : null),
  },
  color: { description: 'color {brightness, contrast, saturation}: brightness -0.5..0.5 (0 = same), contrast 0.5-2 (1 = same), saturation 0-3 (1 = same)', validate: (a) => ({ brightness: limit(a.brightness, -0.5, 0.5, 0), contrast: limit(a.contrast, 0.5, 2, 1), saturation: limit(a.saturation, 0, 3, 1) }) },
  blackWhite: { description: 'blackWhite {}', validate: () => ({}) },
  fade: { description: 'fade {in, out}: fade from black at the start / to black at the end (seconds, 0-10)', validate: fadeRange },
  reverse: { description: 'reverse {}: play the video backwards (only under 60 s)', validate: (a, b) => (b.duration <= 60 ? {} : null) },
  fps: { description: 'fps {value}: 12-60 frames/s', validate: (a) => ({ value: Math.round(limit(a.value, 12, 60, 30)) }) },
  music: {
    description: 'music {level}: put the music file given by the user under the video; level "light" | "middle" | "distinct" (only if musicFileGiven is true)',
    validate: (a, b) => (b.hasMusic ? { level: MUSIC_LEVELS.includes(a.level) ? a.level : 'middle' } : null),
  },
};

export const OPERATIONS = { voice: VOICE_OPERATIONS, video: VIDEO_OPERATIONS };

function system(type, info) {
  const operations = OPERATIONS[type];
  const voices = type === 'voice' && info.voices?.length ? `\nVoices in the library (ids for changeVoice): ${info.voices.map((s) => `${s.id} = "${s.name}"`).join('; ')}` : '';
  return `You are a ${type === 'voice' ? 'voice' : 'video'} editing planner. Convert the user's instruction (Turkish or English) into an ORDERED list of the operations below.
Only these operations exist:
${Object.values(operations).map((x) => `- ${x.description}`).join('\n')}${voices}
File: ${JSON.stringify(info.summary)}
Rules: Return JSON only, no other text. Format:
{"steps":[{"operation":"<name>", ...fields}], "description":"<what will be done, one sentence in the language of the instruction>", "impossible":"<if part of the request cannot be done with these operations, a short note in the language of the instruction; otherwise empty>"}
Durations and seconds refer to the real duration of the file. The order of the operations matters (e.g. cut first, then speed). Do not add operations that were not requested.`;
}

/** Checks the text model's answer: { steps, description, impossible }. */
export function parsePlan(type, text, info) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) throw new UserError('The edit plan could not be understood; write the instruction more clearly.');
  let j;
  try {
    j = JSON.parse(m[0]);
  } catch {
    throw new UserError('The edit plan could not be understood; write the instruction more clearly.');
  }
  const operations = OPERATIONS[type];
  const steps = [];
  // Each step works on the previous one's output: cut and speed change the length (e.g. "cut, then play backwards" on a long video)
  let now = info;
  for (const a of Array.isArray(j.steps) ? j.steps : []) {
    const t = operations[a?.operation];
    if (!t) continue;
    const d = t.validate(a, now);
    if (!d) continue;
    steps.push({ operation: a.operation, ...d });
    if (a.operation === 'cut') now = { ...now, duration: Math.max(0, (d.end ?? now.duration) - d.start) };
    else if (a.operation === 'speed' && d.ratio > 0) now = { ...now, duration: now.duration / d.ratio };
  }
  const impossible = String(j.impossible ?? '').trim();
  if (!steps.length) throw new UserError(impossible ? `This request cannot be done: ${impossible}` : 'No applicable edit was found in the instruction.');
  return { steps: steps.slice(0, 20), description: String(j.description ?? '').trim().slice(0, 300), impossible };
}

/** From inside a job (audio/video editing): does not wait for the graphics card. */
export async function plan({ type, instruction, info, signal = null }) {
  if (!hasText()) throw new UserError('The instruction interpreter (text model) is not on this machine; editing by instruction is unavailable.');
  return runText({ system: system(type, info), prompt: instruction, json: true, temperature: 0.2, maxToken: 2048, signal, name: 'Edit plan', parse: (m) => parsePlan(type, m, info) });
}
