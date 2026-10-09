/**
 * The lip sync (InfiniteTalk) runner: where the speakers are in the scene image (the local text model reading the image)
 * and a talking scene made window by window at 25 fps (the model module's lipJob). Timing and measurements: lib/lip.mjs.
 * A RETRY RESUMES WHERE IT LEFT OFF: a finished window (checkpoint.json) is not made again.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { images } from '../comfy-client.mjs';
import { nodes } from '../graph.mjs';
import { runFfmpeg } from '../ffmpeg.mjs';
import { LIP, lipStages, lipSections, lipWindows, windowPrompt, windowPlan } from '../lip.mjs';
import { runText } from '../text-model.mjs';
import { writeAtomic, deleteExtraFrames, pngs } from './common.mjs';

const GENDER_EN = { female: 'female', male: 'male' };
const AGE_EN = { child: 'child', young: 'young', adult: 'adult', old: 'elderly' };

// Gemma gives the box in its own shape: [y_min, x_min, y_max, x_max], 0-1000 (measured 07.10.2026: y came first even
// when [x0, y0, x1, y1] was asked). Asked for "head and shoulders" it gave full body boxes (the box of the cat on her lap
// held the girl's mouth); asked for "the face only" it boxes the faces apart and right (the cat too).
const BOX_SYSTEM = 'You look at an illustration and detect the listed characters. For each character detect their FACE only (forehead to chin, including the mouth; for an animal its face and muzzle). Give the bounding box as [y_min, x_min, y_max, x_max] normalized to 0-1000, and whether the character is a human. If a character is not visible, use null for the box. Answer with JSON only: {"<name>": {"box_2d": [y_min, x_min, y_max, x_max], "human": true}}';
// It may write "label": "human" instead of "human": true (measured)
const HUMAN_TAG = /^(human|person|man|woman|girl|boy|child|people)$/i;

// Name matching ignores case, accents and the ı/i difference (the model may write "Ayşe" as "Ayse")
const nameFormat = (s) => String(s).toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/**
 * The text model's answer -> { [name]: { box: [x0, y0, x1, y1] (0-1000) | null, human } }; only the asked names, a
 * broken box (not 4 numbers, reversed or empty) counts as not visible.
 */
export function parseSpeakerResponse(text, names) {
  const startedAt = text.indexOf('{');
  const j = JSON.parse(text.slice(startedAt, text.lastIndexOf('}') + 1));
  const key = Object.fromEntries(Object.keys(j).map((k) => [nameFormat(k), k]));
  const result = {};
  for (const name of names) {
    const v = j[key[nameFormat(name)]] ?? null;
    const raw = v?.box_2d ?? v?.box;
    const b = Array.isArray(raw) ? raw.map(Number) : null;
    const valid = b?.length === 4 && b.every((x) => Number.isFinite(x) && x >= 0 && x <= 1000) && b[2] > b[0] && b[3] > b[1];
    result[name] = { box: valid ? [b[1], b[0], b[3], b[2]] : null, human: v?.human === true || (v?.human !== false && HUMAN_TAG.test(String(v?.label ?? '').trim())) };
  }
  return result;
}

/**
 * In a talking scene, where the speakers' faces are in the image (the InfiniteTalk mask) and whether each is a human
 * (for the log; animals talk too). characters: [{ name, gender, age, spec }]. Returns: parseSpeakerResponse's output.
 */
export async function findSpeakers(ctx, { image, characters, sceneText = '' }) {
  // The image encoder scales it down anyway: a 768 px JPEG is enough and keeps the request small
  const jpg = join(ctx.folder, `speakers-${process.pid}-${Date.now()}.jpg`);
  await runFfmpeg(ctx.setting.ffmpeg, ['-i', image, '-vf', 'scale=768:-2', '-frames:v', '1', '-q:v', '3', jpg], { signal: ctx.signal });
  let url;
  try {
    url = `data:image/jpeg;base64,${readFileSync(jpg).toString('base64')}`;
  } finally {
    rmSync(jpg, { force: true });
  }
  const list = characters.map((k) => `- ${k.name}: ${[GENDER_EN[k.gender], AGE_EN[k.age]].filter(Boolean).join(' ')}${k.spec ? `; voice: ${k.spec}` : ''}`).join('\n');
  const prompt = `Characters in this image:\n${list}${sceneText ? `\n\nScene description: ${sceneText}` : ''}`;
  return runText({ system: BOX_SYSTEM, prompt, image: url, json: true, temperature: 0, maxToken: 400, signal: ctx.signal, parse: (m) => parseSpeakerResponse(m, characters.map((k) => k.name)), name: 'Speaker positions' });
}

/**
 * The frames of a talking scene (25 fps, %05d.png in targetFolder): window by window with the model module's lipJob.
 * sceneVoice: the scene's WAV; lines: the scene's line file; cast: [{ name, box: video pixels [x, y, w, h] }].
 * Each speaker's trace is a WAV in the scene clip's time (frontSpace late) where only their own sections are heard.
 * Returns: { frameCount, windowCount, traces, speakers }
 */
export async function lipVideo(ctx, { source, sceneVoice, lines, cast, frontSpace, target, prompts, definition, acting = [], seed, width, height, targetFolder, prefixExtra, stage, range, measurement }) {
  const { total, windows } = lipWindows(target);
  mkdirSync(targetFolder, { recursive: true });
  const statusPath = join(targetFolder, 'checkpoint.json');
  let status = null;
  try {
    status = JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch {
    /* none */
  }
  // A changed plan (length, speakers) starts over
  const signature = JSON.stringify({ total, cast });
  if (!status?.lip || status.signature !== signature) {
    for (const d of pngs(targetFolder)) rmSync(join(targetFolder, d), { force: true });
    rmSync(join(targetFolder, 'traces'), { recursive: true, force: true });
    status = { lip: true, signature, window: 0, frame: 0 };
    writeFileSync(statusPath, JSON.stringify(status), 'utf8');
  }
  const deleted = deleteExtraFrames(targetFolder, status.window === 0 ? 0 : status.frame);
  if (deleted) ctx.log(`${stage}: ${deleted} frames removed from the unfinished window (resuming where it left off).`);
  const names = cast.map((o) => o.name);
  const box = Object.fromEntries(cast.map((o) => [o.name, o.box]));
  const sections = lipSections(lines, { frontSpace, cast: names });
  const ff = (a) => runFfmpeg(ctx.setting.ffmpeg, a, { signal: ctx.signal });
  const traceFolder = join(targetFolder, 'traces');
  mkdirSync(traceFolder, { recursive: true });
  const trace = {};
  for (const [j, name] of names.entries()) {
    trace[name] = join(traceFolder, `k${j + 1}.wav`);
    if (existsSync(trace[name])) continue;
    const isOpen = sections.filter((b) => b.who === name).map((b) => `between(t,${b.startedAt},${b.last})`).join('+') || '0';
    await ff(['-i', sceneVoice, '-af', `adelay=${Math.round(frontSpace * 1000)}:all=1,apad=whole_dur=${(total + LIP.frame) / LIP.fps},volume=enable='not(${isOpen})':volume=0`, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', `${trace[name]}.writing.wav`]);
    renameSync(`${trace[name]}.writing.wav`, trace[name]);
  }
  const silent = join(traceFolder, 'silence.wav');
  if (!existsSync(silent)) await writeAtomic(silent, (g) => ff(['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.2', '-c:a', 'pcm_s16le', g]));
  const namePrefix = `panel_${ctx.job.id}_${prefixExtra}`;
  const picture = await ctx.comfy.load(source, `${namePrefix}${extname(source).toLowerCase() || '.png'}`);
  for (const w of windows.slice(status.window)) {
    const startedAt = Date.now();
    const t0 = w.start / LIP.fps;
    const p = windowPlan(sections, t0, { names });
    const slice = async (sourceTrace, a, duration, name) => {
      const path = join(traceFolder, `p${w.no}_${name}`);
      await ff(['-i', sourceTrace, '-af', `atrim=start=${a},asetpts=N/SR/TB,apad=whole_dur=${duration}`, '-t', String(duration), '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', path]);
      return ctx.comfy.load(path, `${namePrefix}d${w.no}_${name}`);
    };
    const voice1 = await slice(trace[p.first], t0, p.s / LIP.fps, '1.wav');
    const voice2 = p.s < LIP.frame ? await slice(trace[p.second], t0 + p.s / LIP.fps, (LIP.frame - p.s) / LIP.fps, '2.wav') : await ctx.comfy.load(silent, `${namePrefix}d${w.no}_2.wav`);
    const existing = pngs(targetFolder);
    const motions = w.no === 1 ? null : await Promise.all(existing.slice(-LIP.motion).map((d, j) => ctx.comfy.load(join(targetFolder, d), `${namePrefix}d${w.no}_m${j + 1}.png`)));
    // The prompt fits the window: who is talking (the Wan 2.2 stage does not hear the audio), a still camera when continuing
    const text = windowPrompt({ prompts, t0, target, plan: p, definition, names, proceed: w.no > 1, sections, acting });
    const graph = ctx.mod.lipJob({ picture, motions, voice1, voice2, mask1: box[p.first] ?? null, mask2: p.second ? (box[p.second] ?? null) : null, text, seed: seed + w.no, width, height, voice: LIP.voiceStrength, prefix: `panel/${ctx.job.id}/${prefixExtra}d${w.no}` });
    const record = nodes(graph, 'SaveImage')[0];
    const [a0, a1] = range;
    const [p0, p1] = [a0 + ((a1 - a0) * (w.no - 1)) / windows.length, a0 + ((a1 - a0) * w.no) / windows.length];
    // Two requests (lipStages): the Wan 2.2 steps into a latent file, the InfiniteTalk steps from it; one 14B model in RAM at a time
    const stages = lipStages(graph, { prefix: `panel/${ctx.job.id}/${prefixExtra}d${w.no}_mid` });
    const middle = await ctx.runComfy(stages.first, { stage: `${stage} · lip ${w.no}/${windows.length}`, range: [p0, p0 + (p1 - p0) * 0.3] });
    const latent = middle?.[stages.record]?.latents?.[0];
    if (!latent) throw new Error('ComfyUI did not return the intermediate latent of the lip window.');
    const latentPath = join(traceFolder, `p${w.no}.latent`);
    await ctx.comfy.getOutput(latent, latentPath);
    const latentName = await ctx.comfy.load(latentPath, `${namePrefix}d${w.no}.latent`);
    const outputs = await ctx.runComfy(stages.last(latentName), { stage: `${stage} · lip ${w.no}/${windows.length}`, range: [p0 + (p1 - p0) * 0.3, p1] });
    const list = images(outputs, record);
    if (!list.length) throw new Error('ComfyUI did not return the frames of the lip-sync window.');
    let no = existing.length;
    for (const c of list) {
      no += 1;
      await ctx.comfy.getOutput(c, join(targetFolder, `${String(no).padStart(5, '0')}.png`));
    }
    // The first window's first frame comes out broken (the mixed setup; InfiniteTalk rebuilds the first frame at every
    // step): the second frame is copied over it. In a continuing window the broken frames are the dropped motion frames.
    if (w.no === 1 && no >= 2) copyFileSync(join(targetFolder, '00002.png'), join(targetFolder, '00001.png'));
    status.window = w.no;
    status.frame = no;
    writeFileSync(statusPath, JSON.stringify(status), 'utf8');
    ctx.log(`${stage}: lip window ${w.no}/${windows.length} (from ${(t0 + (w.skip / LIP.fps)).toFixed(2)} s; voice 1 ${p.first}${p.s < LIP.frame ? `, voice 2 ${p.second} from frame ${p.s}` : ''}) ${Math.round((Date.now() - startedAt) / 1000)} s; prompt: ${text}`);
    if (measurement) ctx.measure(measurement, (Date.now() - startedAt) / 1000 / (list.length / LIP.fps));
  }
  // The last window runs past the scene's length: the extra frames are deleted
  for (const d of pngs(targetFolder).slice(total)) rmSync(join(targetFolder, d), { force: true });
  // traces: each speaker's audio trace in the scene's time (the mouth fix works with its own voice); speakers: the cast who talk in the scene
  return { frameCount: Math.min(total, pngs(targetFolder).length), windowCount: windows.length, traces: trace, speakers: [...new Set(sections.map((b) => b.who))] };
}
