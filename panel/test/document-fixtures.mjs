/**
 * Small documents for the tests, written here (no files in the repo): a ZIP (DOCX, XLSX, PPTX are ZIPs of XML) and PDFs
 * with a page tree, with page objects packed in an object stream (PDF 1.5) and without a page tree.
 */
import { deflateSync } from 'node:zlib';

/** A ZIP of { name: content } (deflated). */
export function makeZip(files) {
  const parts = [];
  const center = [];
  let position = 0;
  const crc = (b) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = deflateSync(data).subarray(2, -4); // raw deflate (no zlib head and adler)
    const nameB = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const m = Buffer.alloc(46);
    m.writeUInt32LE(0x02014b50, 0);
    m.writeUInt16LE(8, 10);
    m.writeUInt32LE(crc(data), 16);
    m.writeUInt32LE(packed.length, 20);
    m.writeUInt32LE(data.length, 24);
    m.writeUInt16LE(nameB.length, 28);
    m.writeUInt32LE(position, 42);
    center.push(Buffer.concat([m, nameB]));
    parts.push(local, nameB, packed);
    position += local.length + nameB.length + packed.length;
  }
  const centerB = Buffer.concat(center);
  const last = Buffer.alloc(22);
  last.writeUInt32LE(0x06054b50, 0);
  last.writeUInt16LE(center.length, 8);
  last.writeUInt16LE(center.length, 10);
  last.writeUInt32LE(centerB.length, 12);
  last.writeUInt32LE(position, 16);
  return Buffer.concat([...parts, centerB, last]);
}

const escapePdf = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);
const contentStream = (lines) => deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td ${lines.map((s) => `(${escapePdf(s)}) Tj T*`).join(' ')} ET`, 'latin1'));

/**
 * A PDF of pages (each a list of lines), with a catalog and a page tree: the page tree in two levels (a /Pages node
 * inside the root's /Kids). packed: the page dictionaries go in an object stream (/Type /ObjStm), as PDF 1.5 writers do.
 */
export function makePdf(pages, { packed = false } = {}) {
  const objects = new Map(); // number -> body (string) or { dictionary, data }
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const pageNumbers = [];
  let n = 4;
  const contents = [];
  for (const lines of pages) {
    const page = n++;
    const content = n++;
    pageNumbers.push(page);
    contents.push([page, content]);
    const data = contentStream(lines);
    objects.set(content, { dictionary: `<< /Length ${data.length} /Filter /FlateDecode >>`, data });
  }
  // the first page under a /Pages node of its own (a tree, not a flat list)
  objects.set(2, `<< /Type /Pages /Kids [3 0 R ${pageNumbers.slice(1).map((p) => `${p} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.set(3, `<< /Type /Pages /Parent 2 0 R /Kids [${pageNumbers[0]} 0 R] /Count 1 >>`);
  const pageBodies = contents.map(([page, content]) => [page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R >>`]);
  if (packed) {
    let head = '';
    let body = '';
    for (const [page, text] of pageBodies) {
      head += `${page} ${body.length} `;
      body += `${text}\n`;
    }
    const data = deflateSync(Buffer.from(head + body, 'latin1'));
    objects.set(n++, { dictionary: `<< /Type /ObjStm /N ${pageBodies.length} /First ${head.length} /Length ${data.length} /Filter /FlateDecode >>`, data });
  } else for (const [page, text] of pageBodies) objects.set(page, text);
  const chunks = [Buffer.from('%PDF-1.5\n', 'latin1')];
  for (const [number, o] of [...objects].sort((a, b) => a[0] - b[0])) {
    if (typeof o === 'string') chunks.push(Buffer.from(`${number} 0 obj\n${o}\nendobj\n`, 'latin1'));
    else chunks.push(Buffer.from(`${number} 0 obj\n${o.dictionary}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  }
  chunks.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(chunks);
}

/** A PDF with only a content stream (no catalog, no page tree): read as one part. */
export function makeLoosePdf(lines) {
  const data = contentStream(lines);
  return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1')]);
}

const xmlEscape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A DOCX of paragraphs ("# " starts a heading). */
export function makeDocx(paragraphs) {
  const body = paragraphs.map((p) => (p.startsWith('# ') ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xmlEscape(p.slice(2))}</w:t></w:r></w:p>` : `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)).join('');
  return makeZip({ 'word/document.xml': `<w:document><w:body>${body}</w:body></w:document>` });
}

/** An XLSX of named sheets ({ name: [[cell, …], …] }), the workbook naming them in order; numbers stay numbers. */
export function makeXlsx(sheets) {
  const shared = [];
  const index = (s) => (shared.includes(s) ? shared.indexOf(s) : shared.push(s) - 1);
  const files = {};
  const names = Object.keys(sheets);
  names.forEach((name, i) => {
    const rows = sheets[name].map((row) => `<row>${row.map((c) => (typeof c === 'number' ? `<c><v>${c}</v></c>` : `<c t="s"><v>${index(String(c))}</v></c>`)).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });
  files['xl/sharedStrings.xml'] = `<sst>${shared.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join('')}</sst>`;
  files['xl/workbook.xml'] = `<workbook><sheets>${names.map((name, i) => `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  return makeZip(files);
}

/** A PPTX of slides (each a list of paragraphs). */
export function makePptx(slides) {
  const files = {};
  slides.forEach((paragraphs, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs.map((p) => `<a:p><a:r><a:t>${xmlEscape(p)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  });
  return makeZip(files);
}
