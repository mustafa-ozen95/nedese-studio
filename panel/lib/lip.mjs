/**
 * Lip sync (InfiniteTalk) timing: pure math, tested.
 *
 * Measured 07.10.2026, 720x1280, 81 frames (README "Lip sync"):
 * - Wan 2.1 I2V + InfiniteTalk alone: the lips follow (mouth motion ~ audio r 0.59) but the speaker lifts the head and
 *   looks at the camera (in 3 of 14 frames); the user: "Wan 2.2 is better, the other one looks elsewhere".
 * - The InfiniteTalk patch on the Wan 2.2 experts: no sync (r 0.31; shuffled audio control 0.43), the colours drift.
 * - Mixed (chosen): the first 2 steps with the Wan 2.2 high noise expert (motion, gaze, colour), the last 2 steps with
 *   Wan 2.1 + InfiniteTalk: the gaze is on the listener in 13 of 14 frames.
 * - Audio strength 2 (SyncNet LSE-C, higher is better; same image and audio): Elif's line 3 -> 2.08, 2 -> 2.94; dense
 *   talk 3 -> 1.22, 2 -> 2.60. The earlier 3 was chosen by the old mouth motion ~ audio correlation (r 0.64).
 */

import { isConnection, pruned } from './graph.mjs';

export const LIP = Object.freeze({ frame: 81, motion: 9, fps: 25, voiceStrength: 2 });

const round = (x, b = 3) => Math.round(x * 10 ** b) / 10 ** b;

/**
 * Splits the mixed lip graph into two requests: A) the Wan 2.2 high noise steps -> SaveLatent; B) LoadLatent ->
 * the InfiniteTalk steps -> frames. In one request ComfyUI keeps every model of the graph in RAM. Measured 07.10.2026
 * (16 GB RAM): in the InfiniteTalk stage ComfyUI's private memory was 29 GB with a 1.7 GB working set (Wan 2.2 10.6 +
 * Wan 2.1 10.9 + audio patch 4.7 GB + text encoder); Windows compressed memory and paged it to disk, the graphics card
 * waited for weights (power 56-90 W). With --cache-none Wan 2.2 leaves memory when A ends.
 * Returns: { first: graph A, record: A's SaveLatent node, last: (latentFile) => graph B }
 */
export function lipStages(graph, { prefix }) {
  const samplers = Object.entries(graph).filter(([, d]) => d.class_type === 'KSamplerAdvanced');
  const a = samplers.find(([, d]) => d.inputs.add_noise === 'enable');
  const b = samplers.find(([, d]) => d.inputs.add_noise === 'disable' && isConnection(d.inputs.latent_image) && d.inputs.latent_image[0] === a?.[0]);
  if (!a || !b) throw new Error('Lip graph is not two-stage.');
  const newId = (base) => {
    let i = base;
    while (graph[String(i)]) i += 1;
    return String(i);
  };
  const record = newId(900);
  const upload = newId(950);
  const first = pruned({ ...structuredClone(graph), [record]: { class_type: 'SaveLatent', inputs: { samples: [a[0], 0], filename_prefix: prefix } } }, [record]);
  const exits = Object.keys(graph).filter((id) => graph[id].class_type === 'SaveImage');
  const last = (latent) => {
    const g = structuredClone(graph);
    g[upload] = { class_type: 'LoadLatent', inputs: { latent } };
    g[b[0]].inputs.latent_image = [upload, 0];
    return pruned(g, exits);
  };
  return { first, record, last };
}

/**
 * The scene's frame count at 25 fps and its windows. The first window is 81 frames (from the source image); the next
 * ones go on from the previous window's last 9 frames and the output's first 9 frames (the motion frames) are
 * dropped: 72 new frames per window.
 * Returns: { total, windows: [{ no, start, skip }] }  (start: the scene index of the window's first frame, from 0)
 */
export function lipWindows(target, { frame = LIP.frame, motion = LIP.motion, fps = LIP.fps } = {}) {
  const total = Math.max(1, Math.ceil(target * fps - 1e-6));
  const windows = [{ no: 1, start: 0, skip: 0 }];
  for (let finished = frame; finished < total; finished += frame - motion) windows.push({ no: windows.length + 1, start: finished - motion, skip: motion });
  return { total, windows };
}

/**
 * The speech sections whose lips move, in the scene clip's time (the narration starts frontSpace late).
 * lines: the scene's line file ([{ who, startedAt, last }]; who null: the narrator, off screen, so no lips move).
 * cast: the names of the characters whose lips move (the people seen in the scene image).
 */
export function lipSections(lines, { frontSpace, cast }) {
  const set = new Set(cast);
  // line: the index in the scene's speech list (the acting notes follow this order)
  return (lines ?? [])
    .filter((s) => s.who)
    .map((s, line) => ({ ...s, line }))
    .filter((s) => set.has(s.who) && s.last > s.startedAt)
    .map((s) => ({ who: s.who, startedAt: round(s.startedAt + frontSpace), last: round(s.last + frontSpace), line: s.line }));
}

/**
 * The speaker plan for the window [t0, t0 + frame/fps). ComfyUI WanInfiniteTalkToVideo joins two audios ONE AFTER
 * THE OTHER ("add"): the first speaker's audio drives the window's frames [0, s), the second's [s, frame); each audio
 * moves only the lips of the character in its own mask. With one speaker (or none) in the window, s = frame.
 * The split: the middle of every gap where the speaker changes is a candidate; the one that keeps the most speech
 * wins (with A-B-A in one window the shorter part goes without lips).
 * Returns: { first, second (a name or null), s, covered (s) }
 */
export function windowPlan(sections, t0, { names, frame = LIP.frame, fps = LIP.fps }) {
  const t1 = t0 + frame / fps;
  const inside = sections.filter((b) => b.last > t0 && b.startedAt < t1).sort((a, b) => a.startedAt - b.startedAt);
  const duration = (who, a, b) => inside.filter((x) => x.who === who).reduce((t, x) => t + Math.max(0, Math.min(b, x.last) - Math.max(a, x.startedAt)), 0);
  const other = (who) => names.find((a) => a !== who) ?? null;
  const speakers = [...new Set(inside.map((x) => x.who))];
  let best = null;
  for (const who of speakers.length ? speakers : [names[0]]) {
    const covered = duration(who, t0, t1);
    if (!best || covered > best.covered + 1e-9) best = { first: who, second: other(who), s: frame, covered };
  }
  for (let i = 1; i < inside.length; i++) {
    const [a, b] = [inside[i - 1], inside[i]];
    if (a.who === b.who) continue;
    const s = Math.min(frame - 1, Math.max(1, Math.round(((a.last + b.startedAt) / 2 - t0) * fps)));
    const ts = t0 + s / fps;
    const covered = duration(a.who, t0, ts) + duration(b.who, ts, t1);
    if (covered > best.covered + 1e-9) best = { first: a.who, second: b.who, s, covered };
  }
  return { ...best, covered: round(best.covered) };
}

/**
 * A 0-1000 box on the image -> a pixel box [x, y, w, h] on the video frame. The image is scaled to cover the video
 * and cut in the middle (ComfyUI common_upscale "center"); the box grows by the margin on every side, cut to the frame.
 */
export function boxPixel(box, { imageWidth, imageHeight, width, height, margin = 0.04 }) {
  const o = Math.max(width / imageWidth, height / imageHeight);
  const ox = (imageWidth * o - width) / 2;
  const oy = (imageHeight * o - height) / 2;
  const [x0, y0, x1, y1] = box.map((v) => Math.min(1000, Math.max(0, Number(v))) / 1000);
  const px = (v, len, drift) => v * len * o - drift;
  const left = Math.max(0, Math.floor(px(x0, imageWidth, ox) - margin * width));
  const top = Math.max(0, Math.floor(px(y0, imageHeight, oy) - margin * height));
  const right = Math.min(width, Math.ceil(px(x1, imageWidth, ox) + margin * width));
  const bottom = Math.min(height, Math.ceil(px(y1, imageHeight, oy) + margin * height));
  if (right - left < 8 || bottom - top < 8) return null;
  return [left, top, right - left, bottom - top];
}

/**
 * A mask box from a face box (0-1000): 15% to the sides, 10% up, 30% down (the chin and mouth stay in when the head tilts).
 * Measured 07.10.2026: full body boxes put the girl's mouth into the box of the cat on her lap; face boxes are apart.
 */
export function faceMask([x0, y0, x1, y1]) {
  const w = x1 - x0;
  const h = y1 - y0;
  const s = (v) => Math.min(1000, Math.max(0, Math.round(v)));
  return [s(x0 - 0.15 * w), s(y0 - 0.1 * h), s(x1 + 0.15 * w), s(y1 + 0.3 * h)];
}

/** Whether two boxes (0-1000 or pixels, [x0, y0, x1, y1]) intersect. */
export function intersects(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

// Character names tell Wan nothing in a motion prompt: an English description from the kind, age and gender
const ANIMAL_NAMES = ['kitten', 'kitty', 'cat', 'puppy', 'dog', 'bunny', 'rabbit', 'bird', 'parrot', 'owl', 'fox', 'bear', 'cub', 'mouse', 'squirrel', 'duckling', 'duck', 'chick', 'frog', 'lion', 'tiger', 'horse', 'pony', 'monkey', 'penguin', 'dragon'];
// A Turkish description (the text model or the user may write Turkish) -> the English animal name
const ANIMAL_TR = { kedi: 'cat', köpek: 'dog', tavşan: 'rabbit', kuş: 'bird', tilki: 'fox', sincap: 'squirrel', ördek: 'duck', civciv: 'chick', kurbağa: 'frog', aslan: 'lion', kaplan: 'tiger', maymun: 'monkey', penguen: 'penguin', ejderha: 'dragon' };

/** The character in a prompt: "the girl", "the old man", "the kitten" (an animal: the animal named in its description, else "the animal"). */
export function characterDefinition(k) {
  if (k?.type === 'animal') {
    const spec = String(k.spec ?? '').toLocaleLowerCase('tr');
    // Plurals too: kittens, puppies
    const name = ANIMAL_NAMES.find((a) => new RegExp(`\\b(${a}s?|${a.replace(/y$/, 'ies')})\\b`).test(spec)) ?? Object.entries(ANIMAL_TR).find(([tr]) => spec.includes(tr))?.[1];
    return `the ${name ?? 'animal'}`;
  }
  const female = k?.gender === 'female';
  return { child: female ? 'the girl' : 'the boy', young: female ? 'the young woman' : 'the young man', old: female ? 'the old woman' : 'the old man' }[k?.age] ?? (female ? 'the woman' : 'the man');
}

const list = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The window prompt (the Wan 2.2 stage does not hear the audio: the prompt decides the mouth and the framing). Measured
 * 07.10.2026 (a girl + cat scene): with the first part's "the girl is talking" prompt on every window the girl's mouth
 * opened while the cat talked too; with "the camera moves in" again on every window the framing got tighter and the cat
 * left the frame while it talked. Now: the prompt of the part at the window's middle, who is talking at the start
 * (whoever is not talking keeps the mouth closed), and a still camera in a continuing window.
 */
export function windowPrompt({ prompts, t0, target, plan, definition, names, proceed, sections = [], acting = [], frame = LIP.frame, fps = LIP.fps }) {
  const middle = t0 + frame / fps / 2;
  const base = String(prompts[Math.min(prompts.length - 1, Math.max(0, Math.floor((middle / target) * prompts.length)))] ?? '').replace(/[.\s]+$/, '');
  const d = (name) => definition[name] ?? name;
  // The acting note of the speaker's (longest) line in this window: to whom, looking where, with which expression
  const t1 = t0 + frame / fps;
  const note = (name) => {
    const b = sections.filter((x) => x.who === name && x.last > t0 && x.startedAt < t1).sort((a, c) => Math.min(t1, c.last) - Math.max(t0, c.startedAt) - (Math.min(t1, a.last) - Math.max(t0, a.startedAt)))[0];
    const o = b ? acting[b.line] : null;
    const n = String((typeof o === 'string' ? o : o?.acting) ?? '').replace(/[.\s]+$/, '');
    return n ? ` (${n})` : '';
  };
  // The listener's reaction (the director's note): from the speaker's line in this window
  const listenerNote = (name) => {
    const b = sections.find((x) => x.who === name && x.last > t0 && x.startedAt < t1);
    const o = b ? acting[b.line] : null;
    return typeof o === 'object' && o?.listener ? String(o.listener).replace(/[.\s]+$/, '') : '';
  };
  let who;
  // Speech shorter than 25% of the window (a line starting or ending at the edge) is not called "talking": Wan would move
  // the mouth through the whole window (during the narration too); the neighbour window that holds the speech takes the rest
  if (plan.covered < 0.25 * (frame / fps)) who = "Nobody is talking: everyone's mouth stays closed.";
  else if (plan.s < frame && plan.second) who = `${capitalize(d(plan.first))} talks first${note(plan.first)}, then ${d(plan.second)} answers${note(plan.second)}; whoever is not talking keeps the mouth closed.`;
  else {
    const listener = names.filter((a) => a !== plan.first).map(d);
    // An acting note decides where the listener looks (when the speaker calls to the forest the listener need not look at them)
    const reaction = listenerNote(plan.first);
    const view = reaction ? ` (${reaction})` : note(plan.first) ? '' : `, looking at ${d(plan.first)}`;
    who = `Only ${d(plan.first)} is talking${note(plan.first)}, mouth moving with the words${listener.length ? `; ${list(listener)} ${listener.length > 1 ? 'listen with closed mouths' : 'listens with a closed mouth'}${view}` : ''}.`;
  }
  const framing = names.length > 1 ? ` Keep ${list(names.map(d))} fully in the frame.` : '';
  const camera = proceed ? ' The camera holds still: no zoom, no camera movement.' : '';
  return `${who} ${base}.${framing}${camera}`;
}
