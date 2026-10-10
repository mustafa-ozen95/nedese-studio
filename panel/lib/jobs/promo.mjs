/**
 * Promo video (user 10.10.2026: the panel makes its own promo, from the script to the cut, "kurgu için"): a script of
 * scenes (an on-screen headline, a narration line and what the page shows), each scene read aloud in the chosen voice,
 * the page recorded once per size (desktop 16:9, phone 9:16) with the page video's browser, then cut to a 120 BPM grid
 * (lib/beat-cut.mjs) and drawn with the promo look; the music is either made to the cut (lib/promo-music.mjs) or made
 * by the music model at 120 BPM and laid on the grid, ducked under the narration. A retry keeps what is done (the
 * narration and the finished sizes).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { UserError } from '../errors.mjs';
import { runFfmpeg, makePreview, streams } from '../ffmpeg.mjs';
import { wavDuration } from '../media.mjs';
import { text, choice, seed, voiceInput, prepareReference, speak } from './common.mjs';
import { SIZES, ACTIONS, record, pageAddress, validate as validatePageVideo } from './page-video.mjs';
import { recordingTimeline, draw } from './page-video-compose.mjs';
import { beatCut } from '../beat-cut.mjs';
import { makeMusic, beatGrid, BPM, BAR, SR } from '../promo-music.mjs';
import { musicRequired, generateMusic } from './music.mjs';
import { jobPrompt } from '../prompt-translate.mjs';

export const name = 'Promo video';

const FPS = 30;
const MAX_SCENES = 40;
export const PROMO_SIZES = ['desktop', 'phone'];
export const MUSIC_MODES = ['made', 'generate', 'none'];
// the music model's style when none is given (instrumental, steady, the tempo is given separately)
const DEFAULT_STYLE = 'modern upbeat electronic pop, punchy drums, bright synths, driving bass, instrumental, energetic product commercial';
const RADIO = (v) => `[data-edit-type] label:has(input[value="${v}"])`;

/**
 * What a section of this panel shows (phone: the video is a phone's): steps of the page video without captions (the
 * scene's headline is put on every step). demo: words typed into a form (the scene's own, or an example).
 */
export const PANEL_SECTIONS = {
  chat: { about: 'Chat: an assistant that writes code with a live preview, searches the web, runs sub-agents and makes images, videos, voices and music', steps: ({ phone }) => [
    { do: 'open', url: '#chat', seconds: 1.5 },
    ...(phone ? [{ do: 'click', target: '[data-chat-list-toggle]', seconds: 1 }] : []),
    { do: 'click', target: '[data-chat-items] .chat__item' },
    { do: 'scroll', to: 'top', seconds: 3 },
    { do: 'scroll', to: 'end', seconds: 3.5 },
  ] },
  image: { about: 'Image: realistic images from a sentence (Qwen-Image, FLUX)', jobs: 'image', steps: ({ demo }) => [
    { do: 'open', url: '#image', seconds: 1 },
    { do: 'type', target: '[data-job-form="image"] [name="prompt"]', text: demo || 'Sunset over the sea, cinematic' },
  ] },
  video: { about: 'Video: a video from an image (Wan 2.2)', jobs: 'video', steps: () => [
    { do: 'open', url: '#video', seconds: 1.5 },
    { do: 'hover', target: '[data-last="video"] .media', seconds: 1.5 },
  ] },
  voice: { about: 'Voice: voice-overs, voice design and your own cloned voice', steps: () => [{ do: 'open', url: '#voice', seconds: 2.2 }] },
  music: { about: 'Music: music and songs, with or without vocals (ACE-Step)', jobs: 'music', steps: () => [
    { do: 'open', url: '#music', seconds: 1.5 },
    { do: 'hover', target: '[data-last="music"] .media', seconds: 1.2 },
  ] },
  film: { about: 'Film: a short film with scenes, voices and music from one sentence', jobs: 'film', steps: () => [
    { do: 'open', url: '#film', seconds: 1 },
    { do: 'hover', target: '[data-last="film"] .media', seconds: 2 },
  ] },
  edit: { about: 'Edit: change an image with one sentence', steps: ({ demo }) => [
    { do: 'open', url: '#edit', seconds: 1 },
    { do: 'click', target: RADIO('image'), seconds: 0.6 },
    { do: 'type', target: '[data-job-form="edit"] [name="prompt"]', text: demo || 'Turn the sky into a sunset' },
  ] },
  song: { about: 'Song edit: give a song a new style', steps: () => [
    { do: 'open', url: '#edit', seconds: 0.8 },
    { do: 'click', target: RADIO('song'), seconds: 1.6 },
  ] },
  videoEdit: { about: 'Audio and video edit: cut and shape a recording or a video with words', steps: ({ demo }) => [
    { do: 'open', url: '#edit', seconds: 0.8 },
    { do: 'click', target: RADIO('video'), seconds: 1 },
    { do: 'type', target: '[data-job-form="videoEdit"] [name="instruction"]', text: demo || 'Make it vertical, add a caption' },
  ] },
  model3d: { about: '3D: a 3D model from an image, turned around, an STL for a 3D printer', jobs: 'model3d', steps: ({ phone }) => [
    { do: 'open', url: '#model3d', seconds: 1.2 },
    { do: 'click', target: '[data-last="model3d"] [data-preview]', seconds: 2.4 },
    { do: 'drag', target: '#modal-preview model-viewer', by: phone ? 260 : 420, seconds: 2.8 },
    { do: 'hover', target: '#modal-preview [data-print-info]', seconds: 1.8 },
    { do: 'click', target: '#modal-preview .modal__close', seconds: 0.8 },
  ] },
  training: { about: 'Training: train your own text, image, music and video models', steps: ({ phone }) => [
    { do: 'open', url: '#training', seconds: 1.2 },
    { do: 'scroll', by: phone ? 900 : 600, seconds: 2 },
  ] },
  gallery: { about: 'Gallery: everything made, in one place', steps: ({ phone }) => [
    { do: 'open', url: '#gallery', seconds: 1.2 },
    { do: 'scroll', by: phone ? 1100 : 700, seconds: 3 },
  ] },
  devices: { about: 'Every device: the same panel on a phone, from any device on the network', steps: ({ phone }) => [
    ...(phone ? [] : [{ do: 'device', size: 'phone' }]),
    { do: 'open', url: '#chat', seconds: 1.5 },
    { do: 'open', url: '#gallery', seconds: 1.2 },
    { do: 'scroll', by: phone ? 1600 : 1400, seconds: 3.5 },
  ] },
  settings: { about: 'Settings: models, the text model, the network and the API', steps: () => [
    { do: 'open', url: '#settings', seconds: 1.2 },
    { do: 'scroll', by: 600, seconds: 2.5 },
  ] },
};

/** Steps of a scene on another page: the part with the target text or element comes into view, else a scroll on. */
function pageSteps(scene, index) {
  if (scene.target) return [{ do: 'hover', target: scene.target, seconds: 2.5 }];
  return index ? [{ do: 'scroll', by: 600, seconds: 3 }] : [{ do: 'wait', seconds: 2.5 }];
}

export function validate(g, { mod, setting }) {
  if (!setting.ffmpeg) throw new UserError('ffmpeg not found (<ai>\\ffmpeg\\bin); a promo video cannot be made.');
  const { url, panel } = pageAddress(g.url, setting);
  const raw = Array.isArray(g.scenes) ? g.scenes : [];
  if (!raw.length) throw new UserError('Add at least one scene (or write the script first).');
  if (raw.length > MAX_SCENES) throw new UserError(`At most ${MAX_SCENES} scenes.`);
  const scenes = raw.map((s, i) => {
    const n = `Scene ${i + 1}`;
    const section = String(s?.section ?? '').trim();
    if (panel && !s?.steps && !PANEL_SECTIONS[section]) throw new UserError(`${n}: the section is one of ${Object.keys(PANEL_SECTIONS).join(', ')}.`);
    const scene = {
      caption: text(s?.caption, `${n} headline`, { max: 120 }),
      narration: text(s?.narration, `${n} narration`, { required: false, max: 400 }),
      ...(panel && PANEL_SECTIONS[section] ? { section } : {}),
      ...(s?.demo ? { demo: text(s.demo, `${n} example text`, { max: 300 }) } : {}),
      ...(s?.target ? { target: text(s.target, `${n} target`, { max: 300 }) } : {}),
    };
    // own steps: checked as a page video's (the open steps keep their address)
    if (Array.isArray(s?.steps) && s.steps.length) {
      for (const a of s.steps) if (!ACTIONS.includes(String(a?.do ?? ''))) throw new UserError(`${n}: "do" is one of ${ACTIONS.join(', ')}.`);
      scene.steps = validatePageVideo({ url, steps: s.steps }, { setting }).steps.map(({ caption, audio, ...a }) => a);
    }
    return scene;
  });
  const sizes = (Array.isArray(g.sizes) ? g.sizes : [g.sizes ?? 'desktop', ...(g.sizes ? [] : ['phone'])]).filter((x) => PROMO_SIZES.includes(x));
  if (!sizes.length) throw new UserError(`Sizes: ${PROMO_SIZES.join(', ')}.`);
  const music = choice(g.music, 'Music', MUSIC_MODES, 'made');
  if (music === 'generate') musicRequired(mod, setting);
  return {
    url,
    panel,
    sizes: [...new Set(sizes)],
    theme: ['light', 'dark'].includes(g.theme) ? g.theme : 'dark',
    title: text(g.title, 'Title', { required: false, max: 80 }) || (panel ? 'Nedese Studio' : ''),
    subtitle: text(g.subtitle, 'Subtitle', { required: false, max: 160 }),
    endTitle: text(g.endTitle, 'Closing line', { required: false, max: 160 }),
    music,
    musicStyle: music === 'generate' ? text(g.musicStyle, 'Music style', { required: false, max: 500 }) : '',
    seed: seed(g.seed),
    scenes,
    ...voiceInput(g, setting, { narration: scenes.some((s) => s.narration) }),
  };
}

export function summary(g) {
  return { title: g.title || 'Promo', detail: [`${g.scenes.length} scene${g.scenes.length > 1 ? 's' : ''}`, g.sizes.map((s) => (s === 'phone' ? '9:16' : '16:9')).join(' + '), g.music === 'generate' ? 'music model' : g.music === 'made' ? 'beat music' : 'no music'].join(' · ') };
}

const no2 = (i) => String(i + 1).padStart(2, '0');

/** The steps of one size: every step carries its scene's headline and number, the first its narration's seconds. */
export function promoSteps(g, size, narration) {
  const phone = size === 'phone';
  const steps = [];
  g.scenes.forEach((s, i) => {
    const own = s.steps ?? (g.panel ? PANEL_SECTIONS[s.section].steps({ phone, demo: s.demo }) : pageSteps(s, i));
    // a phone video has no device step (it is the phone already)
    const list = own.filter((a) => !(phone && a.do === 'device')).map((a) => ({ ...a }));
    if (!list.length) list.push({ do: 'wait', seconds: 2 });
    list.forEach((a, k) => {
      a.caption = s.caption;
      a.scene = i;
      if (k === 0 && narration[i]) a.audioSeconds = narration[i];
    });
    steps.push(...list);
  });
  // the first step opens the page (a panel's section or the page itself)
  if (g.panel && steps[0]?.do === 'open' && steps[0].url.startsWith('#')) steps[0] = { ...steps[0], url: new URL(steps[0].url, g.url).href };
  if (!g.panel && steps[0]?.do !== 'open') steps.unshift({ do: 'open', url: g.url, seconds: 1.5, caption: g.scenes[0].caption, scene: 0 });
  return steps;
}

/** Integrated loudness (LUFS) of a file. */
export function loudness(ffmpeg, file) {
  return new Promise((ok) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-6000)));
    p.on('close', () => ok(Number(/I:\s*(-?[\d.]+) LUFS/.exec(err)?.[1] ?? -70)));
  });
}

/** Raw float samples of an audio file (ffmpeg), interleaved by channel. */
export function samples(ffmpeg, file, { rate, channels, filter = null, signal }) {
  return new Promise((ok, no) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, ...(filter ? ['-af', filter] : []), '-f', 'f32le', '-ac', String(channels), '-ar', String(rate), '-'], { windowsHide: true, signal });
    const parts = [];
    p.stdout.on('data', (d) => parts.push(d));
    p.on('error', no);
    p.on('close', (code) => {
      if (code !== 0) return no(new Error('ffmpeg could not read the music'));
      const b = Buffer.concat(parts);
      ok(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

/**
 * The music model's track on the video's grid: its tempo and first bar line measured, then stretched to 120 BPM and
 * started on a bar line. Returns { L, R, bpm } (SR).
 */
async function modelTrack(ctx, file) {
  const mono = await samples(ctx.setting.ffmpeg, file, { rate: 11025, channels: 1, signal: ctx.signal });
  const grid = beatGrid(mono, 11025, { around: BPM });
  const speed = BPM / grid.bpm;
  // atempo keeps the pitch; the bar line moves with the speed, then the track starts there
  const start = grid.bar / speed;
  const stereo = await samples(ctx.setting.ffmpeg, file, { rate: SR, channels: 2, filter: `atempo=${speed.toFixed(5)},atrim=start=${start.toFixed(4)},asetpts=PTS-STARTPTS`, signal: ctx.signal });
  const n = stereo.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = stereo[2 * i];
    R[i] = stereo[2 * i + 1];
  }
  ctx.log(`Music model's track: ${grid.bpm} BPM, first bar line at ${grid.bar.toFixed(2)} s → stretched ×${speed.toFixed(3)} to ${BPM} BPM`);
  return { L, R, bpm: grid.bpm };
}

export async function run(ctx) {
  const g = ctx.job.input;
  const k = ctx.folder;

  /* 1) Narration ─────────────────────────────────────────────── */
  const spoken = g.scenes.map((s, i) => (s.narration ? i : null)).filter((i) => i !== null);
  const missing = spoken.filter((i) => !existsSync(join(k, `scene${no2(i)}.wav`)));
  if (missing.length) {
    await ctx.flushVoiceForGpu?.();
    ctx.progress({ percent: 1, stage: '1/4 Voice-over', detail: 'preparing voice' });
    const r = await prepareReference(ctx, g, k);
    ctx.job.voiceName = r.voiceName;
    ctx.save();
    const result = await speak(ctx, {
      lines: missing.map((i) => ({ id: `scene${no2(i)}`, text: g.scenes[i].narration })),
      reference: r.reference,
      referenceText: r.referenceText,
      lora: r.lora ?? null,
      engine: r.engine ?? null,
      timbre: r.timbre ?? null,
      pace: r.pace ?? null,
      select: g,
      folder: join(k, 'narration'),
      progress: (ratio, detail) => ctx.progress({ percent: 1 + ratio * 9, stage: '1/4 Voice-over', detail }),
    });
    for (const i of missing) {
      const s = result[`scene${no2(i)}`];
      if (s.error != null) ctx.log(`Scene ${i + 1} Whisper error rate ${s.error}: ${s.heard}`);
      renameSync(s.path, join(k, `scene${no2(i)}.wav`));
    }
  }
  const narration = g.scenes.map((s, i) => (s.narration ? wavDuration(join(k, `scene${no2(i)}.wav`)) ?? 0 : 0));

  /* 2) Recording and cut, size by size ───────────────────────── */
  const sizes = g.sizes.filter((size) => !existsSync(join(k, `promo-${size}.mp4`)));
  const share = 80 / Math.max(1, sizes.length);
  let host = '';
  try {
    const u = new URL(g.url);
    host = g.panel ? u.host : u.hostname.replace(/^www\./, '');
  } catch {}
  const card = { panel: g.panel, host, title: g.title, subtitle: g.subtitle, closeTitle: g.title, closeSub: g.endTitle || g.subtitle };
  const cuts = {};
  for (const [j, size] of sizes.entries()) {
    const base = 10 + j * share;
    const cutFile = join(k, `cut-${size}.json`);
    // a retry: this size's pictures are drawn already, only its sound is left
    if (existsSync(cutFile) && existsSync(join(k, `promo-${size}.pictures.mp4`))) {
      cuts[size] = JSON.parse(readFileSync(cutFile, 'utf8'));
      continue;
    }
    const frameDir = join(k, 'frames');
    rmSync(frameDir, { recursive: true, force: true });
    mkdirSync(frameDir, { recursive: true });
    // the recording's progress inside this size's share
    const rec = Object.create(ctx);
    rec.progress = (p) => ctx.progress({ ...p, percent: base + ((p.percent ?? 5) / 55) * share * 0.4, stage: `2/4 Recording (${size})` });
    const steps = promoSteps(g, size, narration);
    const { frames, marks, end } = await record(rec, { url: g.url, panel: g.panel, size, style: 'promo', theme: g.theme, lang: g.lang, cursor: true, captionChosen: false, captionPosition: size === 'phone' ? 'top' : 'bottom' }, steps, frameDir);
    ctx.log(`${size}: recorded ${frames.length} frames in ${end.toFixed(1)} s.`);
    const R = recordingTimeline({ marks, end, frames, size, views: SIZES, out: SIZES[size].out, host });
    const cut = beatCut(R, narration, card);
    ctx.log(`${size}: cut to ${cut.T.duration.toFixed(1)} s, ${cut.blocks.length} blocks, ${cut.T.transitions.length} cuts on the beat.`);
    cuts[size] = cut;
    // the frames are drawn now (one size's frames on disk at a time)
    await drawSize(ctx, g, size, cut, { percent: [base + share * 0.4, base + share * 0.95] });
    rmSync(frameDir, { recursive: true, force: true });
  }

  /* 3) Music and 4) mix ──────────────────────────────────────── */
  for (const size of g.sizes) {
    if (existsSync(join(k, `promo-${size}.mp4`))) continue;
    const cut = cuts[size];
    const music = g.music === 'none' ? null : await promoMusic(ctx, g, size, cut);
    ctx.progress({ percent: 94, stage: '4/4 Sound', detail: size });
    await mix(ctx, size, cut, music);
  }
  for (const size of g.sizes) {
    const file = `promo-${size}.mp4`;
    await makePreview(ctx.setting.ffmpeg, file, `promo-${size}.preview.jpg`, { cwd: k, signal: ctx.signal, at: 6 }).catch(() => {});
    const info = await streams(ctx.setting.ffprobe, join(k, file)).catch(() => null);
    const [w, h] = SIZES[size].out;
    ctx.addOutput({ file, type: 'video', preview: existsSync(join(k, `promo-${size}.preview.jpg`)) ? `promo-${size}.preview.jpg` : undefined, duration: info ? Math.round(info.duration * 100) / 100 : undefined, width: w, height: h, fps: FPS, main: size === g.sizes[0] });
  }
  for (const name of ['compose.html', 'timeline.js', 'frames', 'narration']) rmSync(join(k, name), { recursive: true, force: true });
}

async function drawSize(ctx, g, size, cut, { percent }) {
  const k = ctx.folder;
  const output = `promo-${size}.pictures.mp4`;
  rmSync(join(k, output), { force: true });
  const sub = Object.create(ctx);
  sub.progress = (p) => ctx.progress({ ...p, stage: `3/4 Making the video (${size})` });
  await draw(sub, { timeline: cut.T, folder: k, fps: FPS, output, percent });
  writeFileSync(join(k, `cut-${size}.json`), JSON.stringify({ T: { duration: cut.T.duration }, music: cut.music, narration: cut.narration }));
}

/** The music of one size: made to its cut, or the music model's track (made once, the longest size) on its grid. */
async function promoMusic(ctx, g, size, cut) {
  const k = ctx.folder;
  const file = join(k, `music-${size}.wav`);
  let base = null;
  if (g.music === 'generate') {
    const track = join(k, 'music-model.mp3');
    if (!existsSync(track)) {
      ctx.progress({ percent: 90, stage: '3/4 Music', detail: 'music model' });
      const style = await jobPrompt(ctx, g.musicStyle || DEFAULT_STYLE, 'music', { field: 'musicStyleEnglish' });
      // one track for every size: as long as the longest (a little more for the stretch to 120 BPM)
      const longest = Math.max(...g.sizes.map((s) => cutDuration(k, s, cut, size)));
      await generateMusic(ctx, { style, duration: Math.ceil(longest + BAR * 2), bpm: BPM, lang: g.lang, seed: g.seed, file: 'music-model.mp3', stage: '3/4 Music', range: [90, 93] });
    }
    base = await modelTrack(ctx, track);
  }
  ctx.progress({ percent: 93, stage: '3/4 Music', detail: size });
  makeMusic(file, cut.music, { base });
  return file;
}

function cutDuration(k, size, cut, current) {
  if (size === current) return cut.T.duration;
  try {
    return JSON.parse(readFileSync(join(k, `cut-${size}.json`), 'utf8')).T.duration;
  } catch {
    return cut.T.duration;
  }
}

/** The narration clips on their times, the music about 6 dB under them, the whole at −14 LUFS, with the pictures. */
async function mix(ctx, size, cut, music) {
  const k = ctx.folder;
  const ff = ctx.setting.ffmpeg;
  const duration = cut.T.duration.toFixed(3);
  const pictures = `promo-${size}.pictures.mp4`;
  const N = cut.narration;
  const voice = join(k, `voice-${size}.wav`);
  if (N.length) {
    const inputs = N.flatMap((n) => ['-i', join(k, `scene${no2(n.scene)}.wav`)]);
    const chains = N.map((n, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(n.t * 1000)}:all=1[v${i}]`);
    await runFfmpeg(ff, ['-y', ...inputs, '-filter_complex', `${chains.join(';')};${N.map((_, i) => `[v${i}]`).join('')}amix=inputs=${N.length}:normalize=0:dropout_transition=0,apad[o]`, '-map', '[o]', '-t', duration, '-ar', '48000', voice], { cwd: k, signal: ctx.signal });
  }
  const parts = [];
  if (N.length) parts.push(voice);
  if (music) parts.push(music);
  const output = `promo-${size}.mp4`;
  const writing = `promo-${size}.writing.mp4`;
  if (!parts.length) {
    await runFfmpeg(ff, ['-y', '-i', pictures, '-c', 'copy', '-movflags', '+faststart', writing], { cwd: k, signal: ctx.signal });
  } else {
    let filter;
    if (N.length && music) {
      const lv = await loudness(ff, voice);
      const lm = await loudness(ff, music);
      // the music (already ducked under the voice) about 6 dB under the voice overall
      filter = `[2:a]volume=${(lv - 6 - lm).toFixed(2)}dB[m];[1:a][m]amix=inputs=2:normalize=0:dropout_transition=0[s]`;
    } else filter = '[1:a]anull[s]';
    const premix = join(k, `mix-${size}.wav`);
    await runFfmpeg(ff, ['-y', '-i', pictures, ...parts.flatMap((p) => ['-i', p]), '-filter_complex', filter, '-map', '[s]', '-t', duration, premix], { cwd: k, signal: ctx.signal });
    const gain = -14 - (await loudness(ff, premix));
    await runFfmpeg(ff, ['-y', '-i', pictures, '-i', premix, '-filter_complex', `[1:a]volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=false[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', duration, writing], { cwd: k, signal: ctx.signal });
    ctx.log(`${size}: sound at ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB to −14 LUFS.`);
    rmSync(premix, { force: true });
  }
  rmSync(join(k, output), { force: true });
  renameSync(join(k, writing), join(k, output));
  for (const f of [pictures, `voice-${size}.wav`]) rmSync(join(k, f), { force: true });
}
