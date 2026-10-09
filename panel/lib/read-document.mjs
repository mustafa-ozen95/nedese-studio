/**
 * Belgelerden metin (bagimliliksiz): PDF (FlateDecode akislarindaki metin islecleri), DOCX / PPTX / XLSX
 * (ZIP icindeki XML). Elden geldigince: sifreli, taranmis (OCR'siz) ya da ozel kodlamali PDF'lerde metin
 * bos ya da eksik cikabilir; cagiran kelime sayisina gore eler.
 */
import { inflateRawSync, inflateSync } from 'node:zlib';

/** ZIP girdileri: ad -> Buffer (yalniz saklama ve deflate; merkezi dizin okunur). */
export function zipInputs(buf, { maxByte = 64 * 2 ** 20 } = {}) {
  const inputs = new Map();
  const last = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= last; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return inputs;
  let position = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  let total = 0;
  for (let k = 0; k < count && position + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(position) !== 0x02014b50) break;
    const method = buf.readUInt16LE(position + 10);
    const cramped = buf.readUInt32LE(position + 20);
    const isOpen = buf.readUInt32LE(position + 24);
    const nameLength = buf.readUInt16LE(position + 28);
    const extraLength = buf.readUInt16LE(position + 30);
    const commentLength = buf.readUInt16LE(position + 32);
    const local = buf.readUInt32LE(position + 42);
    const name = buf.toString('utf8', position + 46, position + 46 + nameLength);
    position += 46 + nameLength + extraLength + commentLength;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    total += isOpen;
    if (total > maxByte) break;
    const raw = buf.subarray(dataStart, dataStart + cramped);
    try {
      inputs.set(name, method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null);
    } catch {
      /* bozuk girdi */
    }
  }
  return inputs;
}

const parseXml = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&(amp|lt|gt|quot|apos);/g, (_, a) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[a]);

/** DOCX: paragraflar (basliklar "## " ile), tablolar satir satir. */
export function docxText(buf) {
  const z = zipInputs(buf);
  const doc = z.get('word/document.xml')?.toString('utf8');
  if (!doc) return '';
  const paragraphs = [];
  for (const m of doc.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const text = parseXml([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((t) => (t[0].startsWith('<w:tab') ? '\t' : t[0].startsWith('<w:br') ? '\n' : t[1])).join('')).trim();
    if (!text) continue;
    const styling = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    paragraphs.push(/heading|baslik|başlık|title/i.test(styling) ? `## ${text}` : /ListParagraph|liste/i.test(styling) ? `- ${text}` : text);
  }
  return paragraphs.join('\n\n');
}

/** PPTX: slayt sirasina gore metinler (slayt basligi "## "). */
export function pptxText(buf) {
  const z = zipInputs(buf);
  const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  const parts = [];
  for (const s of slides) {
    const xml = z.get(s)?.toString('utf8') ?? '';
    const paragraphs = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((m) => parseXml([...m[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join('')).trim()).filter(Boolean);
    if (paragraphs.length) parts.push(`## ${paragraphs[0]}`, ...paragraphs.slice(1));
  }
  return parts.join('\n\n');
}

/** XLSX: sayfa sayfa, satirlar "hucre | hucre" (en cok 2000 satir). */
export function xlsxText(buf) {
  const z = zipInputs(buf);
  const shared = [...(z.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => parseXml([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')));
  const pages = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  const lines = [];
  for (const s of pages) {
    const xml = z.get(s)?.toString('utf8') ?? '';
    lines.push(`## ${s.replace(/^xl\/worksheets\/|\.xml$/g, '')}`);
    for (const r of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
      const cells = [...r[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((c) => {
        const v = /<v>([^<]*)<\/v>/.exec(c[2])?.[1] ?? /<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(c[2])?.[1] ?? '';
        return /t="s"/.test(c[1]) ? shared[Number(v)] ?? '' : parseXml(v);
      }).filter((h) => h !== '');
      if (cells.length) lines.push(cells.join(' | '));
      if (lines.length > 2000) break;
    }
  }
  return lines.join('\n');
}

/* ── PDF ─────────────────────────────────────────────────────────────── */

function parsePdfString(s) {
  // Parantezli dizge: \n \r \t \( \) \\ \ddd kacislari; UTF-16BE (FEFF) ise cozulur
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (/[0-7]/.test(n)) {
      let number = n;
      while (number.length < 3 && /[0-7]/.test(s[i + 1] ?? '')) number += s[++i];
      out += String.fromCharCode(parseInt(number, 8));
    } else if (n !== undefined) out += n;
  }
  if (out.charCodeAt(0) === 0xfe && out.charCodeAt(1) === 0xff) {
    let u = '';
    for (let i = 2; i + 1 < out.length; i += 2) u += String.fromCharCode((out.charCodeAt(i) << 8) | out.charCodeAt(i + 1));
    return u;
  }
  return out;
}

function parsePdfHex(h) {
  const clean = h.replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let u = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) u += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return u;
  }
  // 2 baytlik CID kodlamasi (ToUnicode olmadan) coğunlukla anlamsiz: yalniz ASCII araligi okunur
  return String.fromCharCode(...bytes.filter((b) => b >= 32 && b < 127 || b === 10));
}

/** Icerik akisindaki metin islecleri (Tj, TJ, ', ") -> satirlar; TD, Td, T-yildiz ve ET satir sonu sayilir. */
function pdfStreamText(stream) {
  const s = stream.toString('latin1');
  const parts = [];
  let line = '';
  const finish = () => {
    if (line.trim()) parts.push(line.replace(/\s+/g, ' ').trim());
    line = '';
  };
  // Sayidan sonra rakam / nokta gelemez: yoksa "586" "58"+"6" diye de bolunur, TJ'siz uzun sayi dizisinde (yazi tipi
  // genislikleri) geri izleme usel buyur (olculdu: 12 sayi 335 ms, her 2 sayida ~16 kat; gercek kosuda olay dongusu kilitlendi)
  const pattern = /\((?:\\.|[^\\)])*\)\s*Tj|\[((?:\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|-?[\d.]+(?![\d.])|\s)*)\]\s*TJ|<([0-9a-fA-F\s]+)>\s*Tj|\((?:\\.|[^\\)])*\)\s*['"]|\bT\*|\bTd\b|\bTD\b|\bET\b|\bTm\b/g;
  for (const m of s.matchAll(pattern)) {
    const tok = m[0];
    if (/^\(/.test(tok)) {
      const ic = /^\(((?:\\.|[^\\)])*)\)/.exec(tok)[1];
      if (/['"]$/.test(tok)) finish();
      line += parsePdfString(ic);
    } else if (tok.startsWith('[')) {
      for (const p of m[1].matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]*)>|(-?[\d.]+)/g)) {
        if (p[1] !== undefined) line += parsePdfString(p[1]);
        else if (p[2] !== undefined) line += parsePdfHex(p[2]);
        else if (Number(p[3]) < -200) line += ' '; // buyuk geri bosluk: kelime arasi
      }
    } else if (tok.startsWith('<')) line += parsePdfHex(m[2]);
    else finish();
  }
  finish();
  return parts;
}

/** Text lines of a page into paragraphs: short lines join a paragraph, a word split with a hyphen is joined again. */
function paragraphs(lines) {
  const out = [];
  let p = '';
  for (const sat of lines) {
    if (!sat) continue;
    if (p && /[.!?:;»"”]$/.test(p) && /^[A-ZÇĞİÖŞÜ0-9•\-–]/.test(sat)) {
      out.push(p);
      p = sat;
    } else p = p ? (p.endsWith('-') ? p.slice(0, -1) + sat : `${p} ${sat}`) : sat;
  }
  if (p) out.push(p);
  return out.filter((x) => /\p{L}{3,}/u.test(x));
}

/** A stream's bytes as its filter leaves them (FlateDecode inflated); null for another filter (LZW, DCT…) or broken data. */
function streamData(raw, dictionary) {
  if (/\/FlateDecode/.test(dictionary)) {
    try {
      return inflateSync(raw);
    } catch {
      try {
        return inflateSync(raw.subarray(0, raw.length - 1));
      } catch {
        return null;
      }
    }
  }
  return /\/Filter/.test(dictionary) ? null : raw;
}

/**
 * The PDF's text page by page (the chat shows page markers; user request 08.10.2026): the page tree from the catalog
 * (/Root › /Pages › /Kids, in order), each page's /Contents streams read like pdfText. Page dictionaries packed in object
 * streams (PDF 1.5+) are read too. null when the page tree cannot be followed (the caller falls back to pdfText);
 * pages without text are empty strings.
 */
export function pdfPages(buf, { maxPage = 5000 } = {}) {
  const s = buf.toString('latin1');
  if (!s.startsWith('%PDF')) return null;
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(s) || /\/Encrypt\b/.test(s.slice(-4096))) return null;
  // where each object starts (a later definition, from an incremental update, wins)
  const at = new Map();
  for (const m of s.matchAll(/(?<![\d.])(\d+)\s+(\d+)\s+obj\b/g)) at.set(Number(m[1]), m.index + m[0].length);
  const packed = new Map(); // objects inside object streams: number -> text
  const object = (n) => {
    if (packed.has(n)) return { dictionary: packed.get(n), stream: null };
    const start = at.get(n);
    if (start === undefined) return null;
    const end = s.indexOf('endobj', start);
    const body = s.slice(start, end < 0 ? undefined : end);
    const k = /(?<!end)stream\r?\n/.exec(body);
    if (!k) return { dictionary: body, stream: null };
    const from = start + k.index + k[0].length;
    const to = s.indexOf('endstream', from);
    return { dictionary: body.slice(0, k.index), stream: to < 0 ? null : buf.subarray(from, to) };
  };
  for (const [n] of at) {
    const o = object(n);
    if (!o?.stream || !/\/Type\s*\/ObjStm\b/.test(o.dictionary)) continue;
    const data = streamData(o.stream, o.dictionary)?.toString('latin1');
    const first = Number(/\/First\s+(\d+)/.exec(o.dictionary)?.[1]);
    if (!data || !Number.isFinite(first)) continue;
    const pairs = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const next = i + 3 < pairs.length ? pairs[i + 3] : data.length - first;
      if (!at.has(pairs[i])) packed.set(pairs[i], data.slice(first + pairs[i + 1], first + next));
    }
  }
  const refs = (text) => [...String(text).matchAll(/(\d+)\s+\d+\s+R\b/g)].map((m) => Number(m[1]));
  // the catalog of the last trailer (or cross-reference stream), then its page tree
  const root = [...s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].at(-1)?.[1];
  const pagesRef = root === undefined ? undefined : /\/Pages\s+(\d+)\s+\d+\s+R/.exec(object(Number(root))?.dictionary ?? '')?.[1];
  if (pagesRef === undefined) return null;
  const pages = [];
  const seen = new Set();
  const walk = (n, depth) => {
    if (seen.has(n) || depth > 64 || pages.length >= maxPage) return;
    seen.add(n);
    const d = object(n)?.dictionary ?? '';
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(d);
    if (kids) for (const k of refs(kids[1])) walk(k, depth + 1);
    else if (/\/Type\s*\/Page(?![s\w])/.test(d)) pages.push(d);
  };
  walk(Number(pagesRef), 0);
  if (!pages.length) return null;
  return pages.map((d) => {
    const direct = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(d)?.[1] ?? '';
    // an indirect /Contents may itself be an array of streams
    const list = refs(direct).flatMap((n) => {
      const o = object(n);
      return o && !o.stream && /^\s*\[/.test(o.dictionary) ? refs(o.dictionary) : [n];
    });
    const lines = [];
    for (const n of list) {
      const o = object(n);
      const data = o?.stream ? streamData(o.stream, o.dictionary) : null;
      if (data && /\bBT\b/.test(data.toString('latin1', 0, Math.min(data.length, 200000)))) lines.push(...pdfStreamText(data));
    }
    return paragraphs(lines).join('\n\n');
  });
}

/** PDF metni: akislar (FlateDecode) acilir, metin islecleri okunur; satirlar paragraflara birlestirilir. */
export function pdfText(buf, { maxStream = 2000 } = {}) {
  const s = buf.toString('latin1');
  if (!s.startsWith('%PDF')) return '';
  if (/\/Encrypt\b/.test(s.slice(-4096)) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(s)) return '';
  const lines = [];
  let counter = 0;
  // "endstream"in sonu akis baslangici sayilmaz (yoksa iki akis arasindaki duz nesneler icerik gibi okunur)
  for (const m of s.matchAll(/(?<!end)stream\r?\n/g)) {
    if (++counter > maxStream) break;
    const startedAt = m.index + m[0].length;
    const end = s.indexOf('endstream', startedAt);
    if (end < 0) break;
    // Akis sozlugu: bu nesnenin "obj"undan (ya da onceki "endobj"den) itibaren; onceki nesnenin sozlugu karismaz
    const previous = s.slice(Math.max(0, m.index - 400), m.index);
    const dictionary = previous.slice(Math.max(0, previous.lastIndexOf('obj')));
    // Gorsel, gomulu yazi tipi, nesne akisi (ObjStm) ve capraz basvuru (XRef) sayfa metni tasimaz
    if (/\/Subtype\s*\/Image|\/FontFile|\/XObject\s*\/Image|\/Type\s*\/(?:ObjStm|XRef)\b/.test(dictionary)) continue;
    let raw = buf.subarray(startedAt, end);
    if (/\/FlateDecode/.test(dictionary)) {
      try {
        raw = inflateSync(raw);
      } catch {
        try {
          raw = inflateSync(raw.subarray(0, raw.length - 1));
        } catch {
          continue;
        }
      }
    } else if (/\/Filter/.test(dictionary)) continue; // LZW, DCT vb.
    if (!/\bBT\b/.test(raw.toString('latin1', 0, Math.min(raw.length, 200000)))) continue;
    lines.push(...pdfStreamText(raw));
  }
  // Satirlar: kisa satirlar paragrafa eklenir; tireyle bolunen kelimeler birlesir
  return paragraphs(lines).join('\n\n');
}

/** XLSX sheet files with their names, in the workbook's order ([{ file, name }]; sheetN when workbook.xml is missing). */
function xlsxSheets(z) {
  const workbook = z.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = z.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/\bId="([^"]+)"/.exec(m[0])?.[1], /\bTarget="([^"]+)"/.exec(m[0])?.[1]]));
  const named = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const rel = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const t = String(target.get(rel) ?? '').replace(/^\/?(xl\/)?/, 'xl/');
    return { file: t, name: parseXml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? '') };
  }).filter((x) => z.has(x.file));
  if (named.length) return named;
  return [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1])).map((file) => ({ file, name: file.replace(/^xl\/worksheets\/|\.xml$/g, '') }));
}

/** One sheet's rows as "cell | cell" lines (at most rowLimit rows). */
function sheetRows(xml, shared, rowLimit) {
  const rows = [];
  for (const r of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
    const cells = [...r[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((c) => {
      const v = /<v>([^<]*)<\/v>/.exec(c[2])?.[1] ?? /<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(c[2])?.[1] ?? '';
      return /t="s"/.test(c[1]) ? shared[Number(v)] ?? '' : parseXml(v);
    }).filter((h) => h !== '');
    if (cells.length) rows.push(cells.join(' | '));
    if (rows.length >= rowLimit) break;
  }
  return rows;
}

/**
 * A document in parts for the chat (user request 08.10.2026: "Pdf exel vs desteği yok"): PDF pages, XLSX sheets by
 * name, PPTX slides, DOCX as one part. { unit: 'page' | 'sheet' | 'slide' | null, parts: [{ label, text }] }; null for
 * a format this does not read. A PDF whose page tree cannot be followed comes as one part (pdfText).
 */
export function documentParts(buf, extension) {
  const ext = String(extension ?? '').toLowerCase();
  try {
    if (ext === '.pdf') {
      const pages = pdfPages(buf);
      if (pages && pages.some((p) => p.trim())) return { unit: 'page', parts: pages.map((text, i) => ({ label: `Page ${i + 1}`, text })) };
      return { unit: null, parts: [{ label: null, text: pdfText(buf) }] };
    }
    if (ext === '.docx') return { unit: null, parts: [{ label: null, text: docxText(buf) }] };
    if (ext === '.pptx') {
      const z = zipInputs(buf);
      const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
      return {
        unit: 'slide',
        parts: slides.map((k, i) => {
          const xml = z.get(k)?.toString('utf8') ?? '';
          const text = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((m) => parseXml([...m[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join('')).trim()).filter(Boolean).join('\n');
          return { label: `Slide ${i + 1}`, text };
        }),
      };
    }
    if (ext === '.xlsx') {
      const z = zipInputs(buf);
      const shared = [...(z.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => parseXml([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')));
      return { unit: 'sheet', parts: xlsxSheets(z).map((x) => ({ label: `Sheet: ${x.name}`, text: sheetRows(z.get(x.file)?.toString('utf8') ?? '', shared, 20000).join('\n') })) };
    }
  } catch {
    return { unit: null, parts: [{ label: null, text: '' }] };
  }
  return null;
}

export const DOCUMENT_EXTENSIONS = { '.pdf': pdfText, '.docx': docxText, '.pptx': pptxText, '.xlsx': xlsxText };
export const DOCUMENT_TYPES = { 'application/pdf': '.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx' };

/** Uzanti ya da icerik turune gore belge metni; desteklenmiyorsa null. */
export function documentText(buf, { extension = '', type = '' } = {}) {
  const u = (extension || DOCUMENT_TYPES[String(type).split(';')[0].trim().toLowerCase()] || '').toLowerCase();
  const reader = DOCUMENT_EXTENSIONS[u];
  if (!reader) return null;
  try {
    return { extension: u, text: reader(buf) };
  } catch {
    return { extension: u, text: '' };
  }
}
