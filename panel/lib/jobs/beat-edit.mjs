/**
 * Beat cut (Edit › Beat cut, user 10.10.2026: "Ritme kes", the promo's engine on your own videos): one or more videos
 * cut to the beat of a music. The music is your own file, made by the music model, or drawn by the panel to the cut
 * (120 BPM); a file's or the model's tempo and first bar line are measured (lib/promo-music.mjs beatGrid) and the cut
 * follows them. Every shot is the window of a source with the most motion that does not run over a cut of its own
 * (lib/beat-edit-plan.mjs), cut to another shape where its motion is; flashes and a punch-in on the drops, the last
 * shot held and faded. The sources' own sound
 * is left out; the music at −14 LUFS. A retry keeps the music and the finished shots.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { UserError } from '../errors.mjs';
import { runFfmpeg, makePreview } from '../ffmpeg.mjs';
import { text, choice, number, seed, musicPath } from './common.mjs';
import { recordPath } from './clone.mjs';
import { musicRequired, generateMusic } from './music.mjs';
import { jobPrompt } from '../prompt-translate.mjs';
import { makeMusic, beatGrid, BPM } from '../promo-music.mjs';
import { samples, finishSound } from './promo.mjs';
import { cutPlan, musicPlan, pickShots, outputSize, musicStart } from '../beat-edit-plan.mjs';

export const name = 'Beat cut';
// ffmpeg only, unless the music model makes the music
export const gpuNotNeeded = (g) => g.music !== 'generate';
const FPS = 30;
const MAX_SOURCES = 30;
// the crop follows the motion seen 8 times a second, 160 pixels along the side it cuts
const LOOK_FPS = 8;
const LOOK = 160;
const VIDEO_EXTENSION = /\.(mp4|mov|mkv|webm|avi|m4v|3gp)$/i;
export const BEAT_SIZES = ['source', '16:9', '9:16', '1:1'];
export const BEAT_MUSIC = ['made', 'generate', 'file'];
export const BEAT_PACES = ['calm', 'medium', 'fast'];
const DEFAULT_STYLE = 'energetic electronic pop, punchy drums, driving bass, bright synths, instrumental';

export function validate(g, { mod, setting }) {
  if (!setting.ffmpeg) throw new UserError('ffmpeg not found (<ai>\\ffmpeg\\bin); a beat cut cannot be made.');
  const raw = (Array.isArray(g.sources) ? g.sources : [g.sources]).map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!raw.length) throw new UserError('Pick at least one video.');
  if (raw.length > MAX_SOURCES) throw new UserError(`At most ${MAX_SOURCES} videos.`);
  for (const s of raw) if (!VIDEO_EXTENSION.test(recordPath(setting.outputRoot, s))) throw new UserError('Pick a video file (MP4, MOV, MKV, WebM…).');
  const music = choice(g.music, 'Music', BEAT_MUSIC, g.musicFile ? 'file' : 'made');
  if (music === 'generate') musicRequired(mod, setting);
  const musicFile = music === 'file' ? String(g.musicFile ?? '').trim() : '';
  if (music === 'file') {
    if (!musicFile) throw new UserError('Pick the music.');
    musicPath(setting.outputRoot, musicFile);
  }
  return {
    sources: raw,
    music,
    musicFile: musicFile || null,
    musicStyle: music === 'generate' ? text(g.musicStyle, 'Music style', { required: false, max: 500 }) : '',
    size: choice(g.size, 'Size', BEAT_SIZES, 'source'),
    pace: choice(g.pace, 'Pace', BEAT_PACES, 'medium'),
    // 0: as long as the videos (at most 30 s) or the music
    length: number(g.length, 'Length', { min: 0, max: 180, defaultValue: 0 }),
    seed: seed(g.seed),
    // an edit handed over by its description keeps the description as its title
    title: text(g.title, 'Title', { required: false, max: 120 }) || null,
  };
}

export function summary(g) {
  const n = g.sources.length;
  return { title: g.title || 'Beat cut', detail: [n === 1 ? '1 video' : `${n} videos`, g.size === 'source' ? 'source size' : g.size, { made: 'beat music', generate: 'music model', file: 'your music' }[g.music], { calm: 'calm', medium: 'medium pace', fast: 'fast' }[g.pace]].join(' · ') };
}

/** Width, height (as shown: a phone's rotation counted) and length of a video. */
function probe(ffprobe, file) {
  return new Promise((ok, no) => {
    execFile(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration', '-of', 'json', file], { windowsHide: true, timeout: 30000 }, (err, out) => {
      if (err) return no(new UserError('A video could not be read.'));
      try {
        const j = JSON.parse(out);
        const v = j.streams?.[0];
        if (!v) return no(new UserError('No video found in the file.'));
        const rotation = Math.abs(Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
        ok({ width: rotation === 90 ? v.height : v.width, height: rotation === 90 ? v.width : v.height, duration: Number(j.format?.duration ?? 0) });
      } catch {
        no(new UserError('A video could not be read.'));
      }
    });
  });
}

/** The motion of a video (8 times a second, ffmpeg's scene score on a small picture) and its own cuts. */
export function motionOf(ffmpeg, file, { signal } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-an', '-vf', "fps=8,scale=128:-2,select='gte(scene,0)',metadata=print:file=-", '-f', 'null', '-'], { windowsHide: true, signal });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', () => {});
    p.on('error', no);
    p.on('close', () => ok(parseMotion(out)));
  });
}

/** ffmpeg's metadata print ("pts_time:1.25" then "lavfi.scene_score=0.12") as motion and cuts (score over 0.35). */
export function parseMotion(textOut) {
  const motion = [];
  let t = null;
  for (const line of textOut.split(/\r?\n/)) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) t = Number(m[1]);
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (s && t !== null) motion.push({ t, v: Number(s[1]) });
  }
  return { motion, cuts: motion.filter((m) => m.v > 0.35 && m.t > 0.2).map((m) => m.t) };
}

/** Gray frames of a window of a video, 8 a second at cols × rows, for the crop to follow its motion. */
function framesOf(ffmpeg, file, start, length, cols, rows, { signal } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', file, '-an', '-vf', `fps=${LOOK_FPS},scale=${cols}:${rows},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true, signal });
    const parts = [];
    p.stdout.on('data', (d) => parts.push(d));
    p.stderr.on('data', () => {});
    p.on('error', no);
    p.on('close', () => {
      const all = Buffer.concat(parts);
      const size = cols * rows;
      ok(Array.from({ length: Math.floor(all.length / size) }, (_, i) => all.subarray(i * size, (i + 1) * size)));
    });
  });
}

/**
 * Where a crop that keeps `keep` of one side (x or y) stands in each frame, 0 at the start of the free room and 1 at
 * its end (user 10.10.2026: a fox walking right lost its head to the middle of a 16:9 picture cut to 9:16). Each change
 * between two frames votes for the window holding most of it; change spread over the whole picture (a camera move,
 * noise) has no say. The votes are smoothed over half a second; with too little of them the crop holds the shot's
 * average, and with none the middle.
 */
export function followCrop(frames, cols, rows, along, keep) {
  const n = along === 'x' ? cols : rows;
  const win = Math.max(1, Math.round(n * keep));
  if (win >= n || frames.length < 2) return frames.map(() => 0.5);
  const votes = [];
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1];
    const b = frames[f];
    const profile = new Float64Array(n);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) profile[along === 'x' ? x : y] += Math.abs(b[y * cols + x] - a[y * cols + x]);
    const median = [...profile].sort((p, q) => p - q)[n >> 1];
    let total = 0;
    for (let i = 0; i < n; i++) total += profile[i] = Math.max(0, profile[i] - median);
    let sum = 0;
    for (let i = 0; i < win; i++) sum += profile[i];
    let top = sum;
    let at = 0;
    for (let i = win; i < n; i++) {
      sum += profile[i] - profile[i - win];
      if (sum > top) [top, at] = [sum, i - win + 1];
    }
    const share = total > 0 ? top / total : 0;
    votes.push({ t: f - 0.5, at: at / (n - win), w: total * Math.max(0, (share - keep) / (1 - keep)) });
  }
  // a quarter of a grey level over the whole picture, held by the window: less than that is noise
  const least = 0.25 * cols * rows;
  const all = votes.reduce((s, v) => s + v.w, 0);
  const average = (votes.reduce((s, v) => s + v.w * v.at, 0) + least * 0.5) / (all + least);
  const sigma = LOOK_FPS / 2;
  return frames.map((_, j) => {
    let s = least * average;
    let w = least;
    for (const v of votes) {
      const k = Math.exp(-((j - v.t) ** 2) / (2 * sigma * sigma)) * v.w;
      s += k * v.at;
      w += k;
    }
    return s / w;
  });
}

/** ffmpeg's crop offset for a path of followCrop (frames 1/8 s of the source apart, played at `speed`). */
export function cropOffset(path, speed, room = 'iw-ow') {
  // a key every quarter second, the last frame kept
  const keys = path.map((f, i) => ({ t: i / LOOK_FPS / speed, f })).filter((_, i) => i % 2 === 0 || i === path.length - 1);
  if (!keys.length || keys.every((k) => Math.abs(k.f - keys[0].f) < 0.01)) return `(${room})*${(keys[0]?.f ?? 0.5).toFixed(3)}`;
  let e = keys.at(-1).f.toFixed(3);
  for (let i = keys.length - 2; i >= 0; i--) {
    const [a, b] = [keys[i], keys[i + 1]];
    e = `if(lt(t,${b.t.toFixed(3)}),${a.f.toFixed(3)}+${(b.f - a.f).toFixed(3)}*(t-${a.t.toFixed(3)})/${(b.t - a.t).toFixed(3)},${e})`;
  }
  return `(${room})*max(0,min(1,${e}))`;
}

/**
 * A film from the gallery with its subtitles burned in stands for its scene clips, which have none: a crop to another
 * shape cut the lines in half and every shot carried words of another moment.
 */
export function withoutSubtitles(outputRoot, refs) {
  return refs.flatMap((ref) => {
    const m = /^job\/([^/]+)\/([^/]+)$/.exec(String(ref).replace(/\\/g, '/'));
    if (!m) return [ref];
    let job;
    try {
      job = JSON.parse(readFileSync(join(outputRoot, m[1], 'job.json'), 'utf8'));
    } catch {
      return [ref];
    }
    const main = job.outputs?.find((o) => o.main)?.file;
    const scenes = (job.outputs ?? []).filter((o) => o.type === 'scene' && VIDEO_EXTENSION.test(o.file) && existsSync(join(outputRoot, m[1], o.file)));
    if (job.type !== 'film' || !job.input?.subtitle || main !== m[2] || !scenes.length) return [ref];
    return scenes.map((o) => `job/${m[1]}/${o.file}`);
  });
}

export async function run(ctx) {
  const g = ctx.job.input;
  const k = ctx.folder;
  const ff = ctx.setting.ffmpeg;
  const refs = withoutSubtitles(ctx.setting.outputRoot, g.sources);
  if (refs.length !== g.sources.length) ctx.log(`Films with subtitles are cut from their scene clips (${refs.length} videos).`);
  const files = refs.map((s) => recordPath(ctx.setting.outputRoot, s));

  /* 1) The videos: size, length, motion ──────────────────────── */
  const infoFile = join(k, 'sources.json');
  let sources;
  // kept with the clips it was made of: a retry after an update may use other clips (a film's scenes)
  const kept = existsSync(infoFile) ? JSON.parse(readFileSync(infoFile, 'utf8')) : null;
  if (kept && JSON.stringify(kept.refs) === JSON.stringify(refs)) sources = kept.sources;
  else {
    sources = [];
    for (const [i, file] of files.entries()) {
      ctx.progress({ percent: 2 + (i / files.length) * 18, stage: '1/4 Watching the videos', detail: `${i + 1}/${files.length}` });
      const info = await probe(ctx.setting.ffprobe, file);
      if (!(info.duration > 0.3)) throw new UserError(`Video ${i + 1} is too short.`);
      sources.push({ ...info, ...(await motionOf(ff, file, { signal: ctx.signal })) });
    }
    writeFileSync(infoFile, JSON.stringify({ refs, sources }));
    rmSync(join(k, 'shots'), { recursive: true, force: true });
  }
  const footage = sources.reduce((s, x) => s + x.duration, 0);

  /* 2) The music and its grid ───────────────────────────────── */
  const wanted = g.length || Math.min(30, Math.max(8, footage));
  let beat = 60 / BPM;
  let musicFile = null;
  let offset = 0;
  let room = Infinity;
  if (g.music !== 'made') {
    if (g.music === 'file') musicFile = musicPath(ctx.setting.outputRoot, g.musicFile);
    else {
      musicFile = join(k, 'music-model.mp3');
      if (!existsSync(musicFile)) {
        ctx.progress({ percent: 22, stage: '2/4 Music', detail: 'music model' });
        const style = await jobPrompt(ctx, g.musicStyle || DEFAULT_STYLE, 'music', { field: 'musicStyleEnglish' });
        await generateMusic(ctx, { style, duration: Math.ceil(wanted + 8), bpm: BPM, lang: 'en', seed: g.seed, file: 'music-model.mp3', stage: '2/4 Music', range: [22, 40] });
      }
    }
    ctx.progress({ percent: 41, stage: '2/4 Music', detail: 'finding the beat' });
    const mono = await samples(ff, musicFile, { rate: 11025, channels: 1, signal: ctx.signal });
    const grid = beatGrid(mono, 11025, g.music === 'generate' ? { around: BPM } : {});
    beat = 60 / grid.bpm;
    const bar = 4 * beat;
    const perBar = [];
    for (let t = grid.bar; t + bar <= mono.length / 11025; t += bar) {
      let s = 0;
      const a = Math.round(t * 11025);
      const b = Math.round((t + bar) * 11025);
      for (let i = a; i < b; i++) s += mono[i] * mono[i];
      perBar.push(Math.sqrt(s / (b - a)));
    }
    offset = musicStart(perBar, grid.bar, bar);
    room = mono.length / 11025 - offset;
    if (room < 3 * bar) throw new UserError('The music is too short for a beat cut (at least three bars).');
    ctx.log(`Music: ${grid.bpm} BPM, cut from ${offset.toFixed(2)} s.`);
  }
  // the cut fits in the music that is left
  const cut = cutPlan({ length: wanted, most: room, beat, pace: g.pace });
  const picks = pickShots(cut.shots, sources);
  ctx.log(`Cut: ${cut.bars} bars, ${cut.total.toFixed(1)} s, ${cut.shots.length} shots, drops at ${cut.drops.map((t) => t.toFixed(1)).join(', ') || '—'}.`);

  /* 3) The shots ─────────────────────────────────────────────── */
  const { width: W, height: H } = outputSize(g.size, sources[0]);
  const shotDir = join(k, 'shots');
  mkdirSync(shotDir, { recursive: true });
  const list = [];
  let following = 0;
  for (const [i, shot] of cut.shots.entries()) {
    const name = `shot${String(i + 1).padStart(3, '0')}.mp4`;
    list.push(`file '${name}'`);
    if (existsSync(join(shotDir, name))) continue;
    ctx.progress({ percent: 42 + (i / cut.shots.length) * 48, stage: '3/4 Cutting', detail: `${i + 1}/${cut.shots.length}` });
    const p = picks[i];
    const frames = Math.round(shot.t1 * FPS) - Math.round(shot.t0 * FPS);
    const d = frames / FPS;
    // a picture of another shape is cut where its motion is, not in the middle
    const src = sources[p.source];
    const zoom = Math.max(W / src.width, H / src.height);
    const along = src.width * zoom - W > 2 ? 'x' : src.height * zoom - H > 2 ? 'y' : null;
    let crop = `crop=${W}:${H}`;
    if (along) {
      const [cols, rows] = along === 'x' ? [LOOK, 2 * Math.max(1, Math.round((LOOK * src.height) / src.width / 2))] : [2 * Math.max(1, Math.round((LOOK * src.width) / src.height / 2)), LOOK];
      const path = followCrop(await framesOf(ff, files[p.source], p.start, d * p.speed, cols, rows, { signal: ctx.signal }), cols, rows, along, along === 'x' ? W / (src.width * zoom) : H / (src.height * zoom));
      if (path.some((f) => Math.abs(f - 0.5) > 0.02)) following++;
      crop = along === 'x' ? `crop=${W}:${H}:x='${cropOffset(path, p.speed)}':y=(ih-oh)/2` : `crop=${W}:${H}:x=(iw-ow)/2:y='${cropOffset(path, p.speed, 'ih-oh')}'`;
    }
    const vf = [`setpts=(PTS-STARTPTS)/${p.speed}`, `fps=${FPS}`, `scale=${W}:${H}:force_original_aspect_ratio=increase`, crop, 'setsar=1'];
    // a punch-in on a drop: 12% closer, back in 0.3 s
    if (shot.punch) vf.push(`zoompan=z='if(lt(on,9),1.12-0.12*on/9,1)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=${FPS}`);
    vf.push(`tpad=stop_mode=clone:stop_duration=${d.toFixed(3)}`);
    if (shot.flash) vf.push('fade=t=in:st=0:d=0.25:color=white');
    if (shot.last) vf.push(`fade=t=out:st=${Math.max(0, d - 0.7).toFixed(3)}:d=0.7`);
    const writing = join(shotDir, `${name}.writing.mp4`);
    await runFfmpeg(ff, ['-ss', p.start.toFixed(3), '-t', (d * p.speed + 0.5).toFixed(3), '-i', files[p.source], '-an', '-vf', vf.join(','), '-frames:v', String(frames), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', writing], { cwd: k, signal: ctx.signal });
    renameSync(writing, join(shotDir, name));
  }
  if (following) ctx.log(`Crop: ${following} of ${cut.shots.length} shots follow the motion.`);
  writeFileSync(join(shotDir, 'list.txt'), list.join('\n') + '\n');
  await runFfmpeg(ff, ['-f', 'concat', '-safe', '0', '-i', join(shotDir, 'list.txt'), '-c', 'copy', join(k, 'pictures.mp4')], { cwd: k, signal: ctx.signal });

  /* 4) The sound ─────────────────────────────────────────────── */
  ctx.progress({ percent: 92, stage: '4/4 Sound' });
  const duration = cut.total.toFixed(3);
  let audio;
  if (g.music === 'made') {
    audio = join(k, 'music.wav');
    makeMusic(audio, musicPlan(cut));
  } else {
    audio = join(k, 'music-cut.wav');
    await runFfmpeg(ff, ['-ss', offset.toFixed(3), '-i', musicFile, '-t', duration, '-af', `afade=t=out:st=${Math.max(0, cut.total - 1.2).toFixed(3)}:d=1.2`, '-ar', '48000', '-ac', '2', audio], { cwd: k, signal: ctx.signal });
  }
  const writing = join(k, 'beat-cut.writing.mp4');
  const gain = await finishSound(ff, join(k, 'pictures.mp4'), audio, writing, duration, { cwd: k, signal: ctx.signal });
  renameSync(writing, join(k, 'beat-cut.mp4'));
  ctx.log(`Sound at ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB to −14 LUFS.`);
  await makePreview(ff, 'beat-cut.mp4', 'beat-cut.preview.jpg', { cwd: k, signal: ctx.signal, at: Math.min(cut.total / 3, 6) }).catch(() => {});
  ctx.addOutput({ file: 'beat-cut.mp4', type: 'video', preview: existsSync(join(k, 'beat-cut.preview.jpg')) ? 'beat-cut.preview.jpg' : undefined, duration: Math.round(cut.total * 100) / 100, width: W, height: H, fps: FPS, main: true });
  for (const name of ['shots', 'pictures.mp4', 'music-cut.wav']) rmSync(join(k, name), { recursive: true, force: true });
}
