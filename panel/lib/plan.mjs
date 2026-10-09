/**
 * Timing for a one-piece film (pure math, tested):
 * - scenePlan: the scene lasts as long as its narration. A short clip is slowed down first (RIFE in-between
 *   frames keep it smooth); if that is not enough the clip is EXTENDED from its last frame (Wan continues the
 *   same scene with a second part); a long one is cut.
 * - timeChart: the scene starts with soft transitions.
 * - subtitles: the text is split into lines and spread over the speech by character count.
 */

export const DEFAULT = {
  frontSpace: 0.6, // silence at the scene's start (the transition must be shorter: speech stays out of it)
  lastSpace: 0.7, // the scene stays a little after the narration ends
  maxSlowdown: 1.6, // beyond this the clip is extended
  minDuration: 2.5,
  transition: 0.5,
};

/**
 * narration: the narration's length (s); frame/fps: one clip of the model (Wan A14B 81/16, Wan 5B 121/24).
 * Returns: { target, part, natural, slowdown (>=1), truncate }
 */
export function scenePlan({ narration, frame, fps, frontSpace = DEFAULT.frontSpace, lastSpace = DEFAULT.lastSpace, maxSlowdown = DEFAULT.maxSlowdown, minDuration = DEFAULT.minDuration }) {
  const target = Math.max(minDuration, frontSpace + narration + lastSpace);
  // k parts: a continuing part's first frame is the previous part's last frame, so it is dropped.
  const naturalDuration = (k) => (k * frame - (k - 1)) / fps;
  let part = 1;
  while (target > naturalDuration(part) * maxSlowdown + 1e-9 && part < 12) part += 1;
  const natural = naturalDuration(part);
  const ratio = target / natural;
  return { target: round(target, 3), part, natural: round(natural, 4), slowdown: round(Math.max(1, ratio), 4), truncate: ratio < 1 };
}

/**
 * The ffmpeg input rate of the frame sequence: all frames spread over the target length (slowdown),
 * or the natural rate when it is cut (the rest is cut with -t).
 */
export function inputFps({ frameCount, target, naturalFps, truncate }) {
  if (truncate) return naturalFps;
  return frameCount / target;
}

/** The scene starts and the total length (transition: the crossfade length, 0 = a cut). */
export function timeChart(durations, transition) {
  const starts = [];
  let t = 0;
  durations.forEach((s, i) => {
    starts.push(round(t, 4));
    t += s - (i < durations.length - 1 ? transition : 0);
  });
  return { starts, total: round(t, 4) };
}

/** Splits the text into subtitle parts: each part at most lineCount lines, a line at most lineLength. */
export function subtitleSplit(text, { lineLength = 42, lineCount = 2 } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?…])\s+/);
  const parts = [];
  for (const sentence of sentences) {
    const lines = [];
    let line = '';
    for (const word of sentence.split(' ')) {
      if (!line) line = word;
      else if (`${line} ${word}`.length <= lineLength) line = `${line} ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    for (let i = 0; i < lines.length; i += lineCount) parts.push(balance(lines.slice(i, i + lineCount), lineLength));
  }
  return parts;
}

/** Balances a two-line part: lines of near length instead of "...a long first line\nend." */
function balance(lines, lineLength) {
  if (lines.length !== 2) return lines.join('\n');
  const words = lines.join(' ').split(' ');
  let best = lines;
  let bestDiff = Math.abs(lines[0].length - lines[1].length);
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    if (a.length > lineLength || b.length > lineLength) continue;
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) {
      best = [a, b];
      bestDiff = diff;
    }
  }
  return best.join('\n');
}

/** Spreads the parts over [start, end] by character count. */
export function timeSubtitles(parts, startedAt, last, words = null) {
  // With Whisper word times ([start, end] s in the scene audio): each line shows while its first word is
  // spoken. The heard word count may differ a little from the text: they are matched by position ratio.
  const textWords = parts.map((p) => p.split(/\s+/).filter(Boolean).length);
  const totalWord = textWords.reduce((t, n) => t + n, 0);
  if (Array.isArray(words) && words.length && totalWord && Math.abs(words.length - totalWord) <= Math.max(2, totalWord * 0.3)) {
    const ratio = words.length / totalWord;
    let position = 0;
    const starts = textWords.map((n) => {
      const i = Math.min(words.length - 1, Math.floor(position * ratio));
      position += n;
      return Math.min(last, Math.max(startedAt, startedAt + words[i][0]));
    });
    // No gap between lines (no flicker): each line lasts until the next one starts.
    const result = parts.map((p, i) => ({ startedAt: round(i === 0 ? startedAt : Math.max(starts[i], starts[i - 1]), 3), last: 0, text: p }));
    result.forEach((s, i) => {
      s.last = round(i < result.length - 1 ? Math.max(s.startedAt, result[i + 1].startedAt) : last, 3);
    });
    return result;
  }
  const total = parts.reduce((t, p) => t + p.replace(/\n/g, ' ').length, 0) || 1;
  const duration = Math.max(0, last - startedAt);
  const result = [];
  let t = startedAt;
  for (const p of parts) {
    const share = (duration * p.replace(/\n/g, ' ').length) / total;
    result.push({ startedAt: round(t, 3), last: round(t + share, 3), text: p });
    t += share;
  }
  if (result.length) result[result.length - 1].last = round(last, 3);
  return result;
}

function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const hour = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const remaining = ms % 1000;
  const two = (n) => String(n).padStart(2, '0');
  return `${two(hour)}:${two(min)}:${two(sec)},${String(remaining).padStart(3, '0')}`;
}

export function writeSrt(hints) {
  return `${hints.map((p, i) => `${i + 1}\n${srtTime(p.startedAt)} --> ${srtTime(p.last)}\n${p.text}\n`).join('\n')}`;
}

function assTime(s) {
  const cs = Math.max(0, Math.round(s * 100));
  const hour = Math.floor(cs / 360000);
  const min = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const remaining = cs % 100;
  const two = (n) => String(n).padStart(2, '0');
  return `${hour}:${two(min)}:${two(sec)}.${two(remaining)}`;
}

/** Subtitle sizes in the video's own pixels (PlayRes = the video size): the text does not overflow a portrait video. */
export function subtitleMetrics(width, height) {
  const text = Math.round(Math.min(height * 0.055, width * 0.058));
  const lineLength = Math.max(16, Math.min(42, Math.floor((0.88 * width) / (0.52 * text))));
  return { text, lineLength, edge: Math.round(height * 0.06), line: Math.max(2, Math.round(text / 14)) };
}

export function writeAss(hints, { width, height, textType = 'Arial' }) {
  const o = subtitleMetrics(width, height);
  const escape = (m) => m.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, '\\N');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${textType},${o.text},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${o.line},0,2,${Math.round(width * 0.06)},${Math.round(width * 0.06)},${o.edge},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...hints.map((p) => `Dialogue: 0,${assTime(p.startedAt)},${assTime(p.last)},Default,,0,0,0,,${escape(p.text)}`),
    '',
  ].join('\n');
}

/** A Wan 2.2 frame count must be 4n+1. */
export function wanFrame(second, fps) {
  const n = Math.max(1, Math.round((second * fps) / 4));
  return n * 4 + 1;
}

/**
 * The part plan of a long video: the frame count of each part for the asked length (s). The first part is
 * full length (frame); continuing parts go on from the previous part's last frame, and their first frame is
 * dropped (k frames = k-1 new frames). Each part is 4n+1 frames, at least 33 (2 s); no upper limit.
 */
export function videoParts(duration, frame, fps) {
  const total = Math.max(5, Math.round((duration * fps) / 4) * 4 + 1);
  if (total <= frame) return [total];
  const parts = [frame];
  let remaining = total - frame;
  while (remaining > 0) {
    const k = Math.min(frame, Math.max(33, Math.ceil(remaining / 4) * 4 + 1));
    parts.push(k);
    remaining -= k - 1;
  }
  return parts;
}

/** The total frame count of a part list (RIFE factor included; a continuing part's first frame is dropped). */
export function partTotalFrame(parts, smooth = 1) {
  return parts.reduce((t, k, i) => t + ((k - 1) * smooth + 1) - (i > 0 ? 1 : 0), 0);
}

/** Seconds as "1 min 05 s", in English like the rest of the stored text (the page translates "{0} min {1} s"). */
export function durationText(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ${String(s % 60).padStart(2, '0')} s`;
  const hour = Math.floor(min / 60);
  if (hour < 48) return `${hour} h ${String(min % 60).padStart(2, '0')} min`;
  return `${Math.floor(hour / 24)} d ${hour % 24} h`;
}

function round(x, digit) {
  const k = 10 ** digit;
  return Math.round(x * k) / k;
}
