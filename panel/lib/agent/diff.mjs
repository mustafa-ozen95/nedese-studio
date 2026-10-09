/**
 * Line diff for the chat's file edit cards (user request 08.10.2026: show what changed, undo it). Common lines at both
 * ends are cut first; the middle is matched with a longest-common-subsequence table when it is small enough (2000 x
 * 2000 lines), otherwise the whole middle counts as replaced. Output: unified diff hunks with 3 lines of context.
 */

const MAX_CELLS = 4_000_000;

/** Edit script: [[' ' | '-' | '+', line], ...] turning a into b. */
export function lineOps(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops = a.slice(0, start).map((l) => [' ', l]);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n && m && (n + 1) * (m + 1) <= MAX_CELLS) {
    // table[i][j]: LCS length of midA[i..] and midB[j..]
    const width = m + 1;
    const table = n < 65535 && m < 65535 ? new Uint16Array((n + 1) * width) : new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push([' ', midA[i]]);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        ops.push(['-', midA[i]]);
        i += 1;
      } else {
        ops.push(['+', midB[j]]);
        j += 1;
      }
    }
    while (i < n) ops.push(['-', midA[i++]]);
    while (j < m) ops.push(['+', midB[j++]]);
  } else {
    for (const l of midA) ops.push(['-', l]);
    for (const l of midB) ops.push(['+', l]);
  }
  for (const l of a.slice(endA)) ops.push([' ', l]);
  return ops;
}

const splitLines = (s) => {
  if (s === null || s === undefined || s === '') return [];
  const lines = String(s).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/**
 * Unified diff of two texts (null = the file did not exist). Returns { text, added, removed, truncated }; at most
 * maxLines lines of hunks.
 */
export function unifiedDiff(before, after, { context = 3, maxLines = 400 } = {}) {
  const ops = lineOps(splitLines(before), splitLines(after));
  const added = ops.filter((o) => o[0] === '+').length;
  const removed = ops.filter((o) => o[0] === '-').length;
  const changed = ops.map((o, i) => (o[0] !== ' ' ? i : -1)).filter((i) => i >= 0);
  const out = [];
  let truncated = false;
  let k = 0;
  while (k < changed.length) {
    // one hunk: changes closer than 2 x context lines are joined
    let from = Math.max(0, changed[k] - context);
    let last = changed[k];
    while (k + 1 < changed.length && changed[k + 1] - last <= context * 2 + 1) last = changed[++k];
    const to = Math.min(ops.length, last + context + 1);
    let lineA = 1;
    let lineB = 1;
    for (let i = 0; i < from; i++) {
      if (ops[i][0] !== '+') lineA += 1;
      if (ops[i][0] !== '-') lineB += 1;
    }
    const part = ops.slice(from, to);
    const countA = part.filter((o) => o[0] !== '+').length;
    const countB = part.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${countA ? lineA : lineA - 1},${countA} +${countB ? lineB : lineB - 1},${countB} @@`);
    for (const [kind, line] of part) out.push(`${kind}${line}`);
    k += 1;
    if (out.length > maxLines) {
      truncated = true;
      out.length = maxLines;
      break;
    }
    from = to;
  }
  return { text: out.join('\n'), added, removed, truncated };
}
