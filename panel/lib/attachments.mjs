/**
 * Files in the chat as text (user request 08.10.2026: "Pdf exel vs desteği yok"): PDF, DOCX, XLSX and PPTX through
 * lib/read-document.mjs (page, sheet and slide markers), and every text file (code, CSV, JSON, Markdown, logs) as it is.
 * The model gets an attachment's text with the message, cut to the room the context has; read_file reads the rest by
 * line range on the same lines (fileText), so the line number the cut names is the one read_file starts at.
 */
import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { documentParts } from './read-document.mjs';

export const DOCUMENT_TYPES = { '.pdf': 'PDF', '.docx': 'Word document', '.xlsx': 'Excel workbook', '.pptx': 'PowerPoint presentation' };
// The largest file read as text (a log or a CSV dump), and the largest document
const TEXT_LIMIT = 20 * 2 ** 20;
const DOCUMENT_LIMIT = 100 * 2 ** 20;
const CACHE_LIMIT = 24;
const cache = new Map(); // path|size|mtime -> result (least recently used first)

/** 'document' (PDF, DOCX, XLSX, PPTX), 'text' (no NUL in its first 8 KB and valid UTF-8 / UTF-16) or null (binary). */
export function readableKind(path) {
  if (DOCUMENT_TYPES[extname(path).toLowerCase()]) return 'document';
  let fd;
  try {
    fd = openSync(path, 'r');
    const b = Buffer.alloc(8192);
    const n = readSync(fd, b, 0, b.length, 0);
    const head = b.subarray(0, n);
    if (head[0] === 0xff && head[1] === 0xfe) return 'text';
    if (head.includes(0)) return null;
    // a text in another code page (Windows-1254) has a few invalid bytes and is still text; a binary has many
    const text = new TextDecoder('utf-8').decode(head, { stream: true });
    return (text.match(/�/g)?.length ?? 0) > text.length * 0.05 ? null : 'text';
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The text of a file the chat reads: { kind, type, lines, units, unitCount, chars, empty } (lines: the text split in
 * lines, a document's markers ("--- Page 3 ---") on lines of their own; units: [{ label, line }] where each part
 * starts). null for a binary file. Cached by path, size and time.
 */
export function fileText(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const kind = readableKind(path);
  if (!kind) return null;
  const ext = extname(path).toLowerCase();
  let result;
  if (kind === 'document') {
    if (st.size > DOCUMENT_LIMIT) throw new Error(`The document is too large to read (${Math.round(st.size / 2 ** 20)} MB; at most ${DOCUMENT_LIMIT / 2 ** 20} MB).`);
    const d = documentParts(readFileSync(path), ext) ?? { unit: null, parts: [] };
    const lines = [];
    const units = [];
    for (const p of d.parts) {
      if (p.label) {
        units.push({ label: p.label, line: lines.length + 1 });
        lines.push(`--- ${p.label} ---`);
      }
      lines.push(...String(p.text ?? '').split(/\r?\n/));
    }
    const chars = d.parts.reduce((t, p) => t + String(p.text ?? '').length, 0);
    result = { kind, type: DOCUMENT_TYPES[ext], unit: d.unit, units, unitCount: d.unit ? d.parts.length : 0, lines, chars, empty: !d.parts.some((p) => String(p.text ?? '').trim()) };
  } else {
    if (st.size > TEXT_LIMIT) throw new Error(`The file is too large to read as text (${Math.round(st.size / 2 ** 20)} MB; at most ${TEXT_LIMIT / 2 ** 20} MB): read parts of it with run_command.`);
    const raw = readFileSync(path);
    const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString('utf16le') : raw.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/);
    result = { kind, type: `${ext ? ext.slice(1).toUpperCase() : 'Text'} file`, unit: null, units: [], unitCount: 0, lines, chars: text.length, empty: !text.trim() };
  }
  cache.set(key, result);
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_LIMIT) break;
    cache.delete(k);
  }
  return result;
}

/** The units (pages, sheets, slides) the lines from..to (1-based) belong to: "pages 3-7", "sheet "Sales"". */
function unitRange(t, from, to) {
  if (!t.units.length) return '';
  const inside = (line) => t.units.filter((u) => u.line <= line).at(-1);
  const a = inside(from) ?? t.units[0];
  const b = inside(to) ?? a;
  const name = { page: 'page', sheet: 'sheet', slide: 'slide' }[t.unit] ?? 'part';
  const number = (u) => (t.unit === 'sheet' ? `"${u.label.replace(/^Sheet: /, '')}"` : /\d+$/.exec(u.label)?.[0] ?? u.label);
  if (a === b) return `${name} ${number(a)}`;
  return t.unit === 'sheet' ? `sheets ${number(a)} to ${number(b)}` : `${name}s ${number(a)}-${number(b)}`;
}

/**
 * The attachment as the model gets it with the message: a head line (name, type, size in pages / characters, the
 * source read_file takes), the text up to limit characters cut at a line end, and when it is cut, what is left and
 * the read_file call that goes on. limit 0: only the head line and how to read it.
 */
export function attachmentText(path, { source = null, name = null, limit = 30000, full = true } = {}) {
  const label = name || basename(path);
  const where = source ?? path;
  let t;
  try {
    t = fileText(path);
  } catch (e) {
    return `[Attachment ${label}: ${e.message}]`;
  }
  if (!t) return `[Attachment ${label} (${where}): a binary file; it cannot be read as text${full ? ', but tools can use it by its path' : ''}.]`;
  const size = t.unitCount ? `${t.unitCount} ${t.unit}${t.unitCount === 1 ? '' : 's'}, ` : '';
  const head = `[Attachment ${label} · ${t.type} · ${size}${t.chars.toLocaleString('en-US')} characters · source ${where}]`;
  if (t.empty) return `${head}\n[No text could be read from it${t.kind === 'document' ? ' (a scanned or encrypted document has none)' : ''}.]`;
  const shown = [];
  let used = 0;
  let partial = false;
  for (const line of t.lines) {
    if (used + line.length + 1 <= limit) {
      shown.push(line);
      used += line.length + 1;
      continue;
    }
    // a first line longer than the whole room (a minified file): its start
    if (!shown.length && limit > 0) {
      shown.push(line.slice(0, limit));
      used = limit;
      partial = true;
    }
    break;
  }
  // the first line not shown whole: read_file goes on from there
  const from = shown.length - (partial ? 1 : 0) + 1;
  const cut = from <= t.lines.length;
  const read = full ? `read_file with path "${where}" and start_line=${from}` : 'the rest is not readable in this chat (no file access)';
  const left = Math.max(0, t.lines.reduce((n, line) => n + line.length + 1, 0) - used);
  const rest = cut ? `\n[… ${left.toLocaleString('en-US')} more characters not shown (lines ${from}-${t.lines.length}${t.units.length ? `, ${unitRange(t, from, t.lines.length)}` : ''}). To go on: ${read}.]` : '';
  return `${head}\n${shown.join('\n')}${rest}\n[End of the attachment ${label}${cut ? ' as shown' : ''}]`;
}
