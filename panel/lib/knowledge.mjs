/**
 * Knowledge (user request 08.10.2026: search in my documents, on the CPU): the documents added in the Knowledge window
 * and the files attached to chats are cut into passages and indexed in panel.db. Always a full-text index (SQLite FTS5,
 * BM25, Turkish letters folded); when an embedding model is in <ai>\llm\embed, also each passage's vector (lib/
 * embedding.mjs, a llama-server of its own on the CPU), and a search ranks by both (reciprocal rank fusion: a passage
 * high in either list comes up, one high in both comes first). The agent searches with search_knowledge; a chat can be
 * told to use only some documents.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { UserError } from './errors.mjs';
import { fileText } from './attachments.mjs';
import { EmbedServer } from './embedding.mjs';

// A passage: up to CHUNK_SIZE characters cut at line ends, the next one starting up to CHUNK_OVERLAP characters back
// (a sentence cut at the border is whole in one of them). ~1000 characters stay under 512 tokens, the input limit of
// the small embedding models.
export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 150;
const SEARCH_POOL = 50; // candidates from each ranking before they are fused
const FUSION_K = 60; // reciprocal rank fusion: 1 / (k + rank), the usual k
const EMBED_BATCH = 16;
export const DOCUMENT_LIMIT = 2000;

/** Folded for the index and the query: lower case (Turkish), dotless i and diacritics folded, like the chat search. */
const fold = (t) => String(t ?? '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * A question as an FTS5 query: its words OR'ed (a question rarely has all of its words in one passage; BM25 puts the
 * passages with more and rarer ones first); a word of 4+ letters also matches its longer forms (Turkish suffixes:
 * "gelir" finds "gelirler", "gelirin").
 */
export function knowledgeQuery(text) {
  const words = [...new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))].slice(0, 16);
  return words.length ? words.map((w) => (w.length >= 4 ? `"${w}"*` : `"${w}"`)).join(' OR ') : null;
}

/**
 * The passages of a file's text (fileText): { line, lines, label, text } in order. label: the page, sheet or slide the
 * passage starts in. A line longer than a passage (a minified file, a long table row) is cut in pieces.
 */
export function chunkText(t, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  const unitAt = (line) => t.units.filter((u) => u.line <= line).at(-1)?.label ?? null;
  const chunks = [];
  const lines = t.lines;
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;
    if (lines[i].length > size) {
      for (let at = 0; at < lines[i].length; at += size - overlap) {
        chunks.push({ line: i + 1, lines: 1, label: unitAt(i + 1), text: lines[i].slice(at, at + size) });
        if (at + size >= lines[i].length) break;
      }
      i++;
      continue;
    }
    let j = i;
    let used = 0;
    while (j < lines.length && lines[j].length <= size && used + lines[j].length + 1 <= size + 1) {
      used += lines[j].length + 1;
      j++;
    }
    const text = lines.slice(i, j).join('\n').trim();
    // a passage that is only a page marker says nothing
    if (text && !/^--- [^\n]* ---$/.test(text)) chunks.push({ line: i + 1, lines: j - i, label: unitAt(i + 1), text });
    if (j >= lines.length) break;
    // the next starts a few lines back (never at the same line: it always moves on), only as far back as still leaves
    // room for the line that did not fit (else it would end where this one did)
    let k = j;
    let back = 0;
    const room = Math.min(overlap, size - lines[j].length - 1);
    while (k - 1 > i && back + lines[k - 1].length + 1 <= room) {
      k--;
      back += lines[k].length + 1;
    }
    i = k;
  }
  return chunks;
}

const id = () => `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const vectorBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const blobVector = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export class Knowledge {
  /**
   * db: the panel's Database (panel.db; its tables are made here). resolve(source) -> a panel source's file path
   * (upload/…, job/…) or null. embedder: an EmbedServer (made from setting when not given; without a model file it
   * is unavailable and the search uses BM25 alone).
   */
  constructor({ db, setting, resolve = () => null, embedder = null, log = () => {} }) {
    Object.assign(this, { db: db.db, setting, resolve, log });
    this.embedder = embedder ?? new EmbedServer({ setting, log });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT, path TEXT, hash TEXT NOT NULL UNIQUE, type TEXT,
        unit TEXT, units INTEGER NOT NULL DEFAULT 0, chars INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
        chunks INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL, chat TEXT, added TEXT NOT NULL, embed_model TEXT
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT NOT NULL, n INTEGER NOT NULL, line INTEGER NOT NULL,
        lines INTEGER NOT NULL, label TEXT, text TEXT NOT NULL, vector BLOB
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunks_document ON knowledge_chunks (document, n);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5 (name, body, tokenize = 'unicode61 remove_diacritics 2');
    `);
    this.vectors = null; // cache: { model, ids: Int32Array, documents: [], matrix: Float32Array, dim }
    this.embedding = null; // the background embedding run (a promise)
    this.embedError = null;
    this.closed = false;
  }

  /** Status for the list: the model (null: words only), how many passages have vectors, the last error. */
  status() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get().n;
    const model = this.embedder.available ? this.embedder.model.name : null;
    const embedded = model ? this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document WHERE c.vector IS NOT NULL AND d.embed_model = ?').get(model).n : 0;
    return { search: model ? 'hybrid' : 'words', model, chunks: total, embedded, embedding: Boolean(this.embedding), error: this.embedError };
  }

  row(d) {
    return { id: d.id, name: d.name, source: d.source ?? null, path: d.source ? null : d.path, type: d.type, unit: d.unit, units: d.units, chars: d.chars, size: d.size, chunks: d.chunks, origin: d.origin, chat: d.chat ?? null, added: d.added, embedded: this.embedder.available && d.embed_model === this.embedder.model.name ? this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE document = ? AND vector IS NOT NULL').get(d.id).n : 0 };
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get().n;
  }

  /** The documents a deleted chat brought (attached in it, never added in the list) leave with it. */
  removeChat(chatId) {
    for (const { id: d } of this.db.prepare("SELECT id FROM knowledge_documents WHERE origin = 'chat' AND chat = ?").all(String(chatId))) this.remove(d);
  }

  list() {
    return this.db.prepare('SELECT * FROM knowledge_documents ORDER BY added DESC, id DESC').all().map((d) => this.row(d));
  }

  get(documentId) {
    const d = this.db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(String(documentId));
    return d ? this.row(d) : null;
  }

  /** Document ids by id or name (the agent names them as the list shows them); unknown ones are left out. */
  match(list) {
    const all = this.db.prepare('SELECT id, name FROM knowledge_documents').all();
    const want = (Array.isArray(list) ? list : [list]).map((x) => String(x ?? '').trim()).filter(Boolean);
    return [...new Set(want.flatMap((w) => all.filter((d) => d.id === w || fold(d.name) === fold(w) || fold(d.name.replace(/\.[^.]+$/, '')) === fold(w)).map((d) => d.id)))];
  }

  /**
   * Adds a file: { source } (a panel source: an upload, a job's file) or { path } (a file on this computer). The same
   * file again (same bytes) gives the document it already is. origin: 'list' (the Knowledge window) | 'chat' (an
   * attachment; chat: its id). Its passages are searchable by words at once; vectors follow in the background.
   */
  add({ source = null, path = null, name = null, origin = 'list', chat = null } = {}) {
    const file = source ? this.resolve(source) : path;
    if (!file || !existsSync(file)) throw new UserError(source ? `File not found: ${source}` : 'A file is needed: source (an upload) or path.', source ? 'notFound' : undefined);
    const st = statSync(file);
    if (!st.isFile()) throw new UserError('This is a folder: add the files in it one by one.');
    const t = fileText(file);
    if (!t) throw new UserError('This file has no text to search (a picture, an archive or another binary file).');
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    const known = this.db.prepare('SELECT * FROM knowledge_documents WHERE hash = ?').get(hash);
    if (known) {
      // attached in a chat after it was added in the list: it stays a list document
      if (origin === 'list' && known.origin !== 'list') this.db.prepare("UPDATE knowledge_documents SET origin = 'list', chat = NULL, name = ? WHERE id = ?").run(String(name || known.name).slice(0, 200), known.id);
      return { document: this.get(known.id), added: false };
    }
    if (this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get().n >= DOCUMENT_LIMIT) throw new UserError(`Knowledge holds at most ${DOCUMENT_LIMIT} documents; delete some first.`);
    const chunks = chunkText(t);
    const doc = { id: id(), name: String(name || basename(file)).slice(0, 200) };
    const insertChunk = this.db.prepare('INSERT INTO knowledge_chunks (document, n, line, lines, label, text) VALUES (?, ?, ?, ?, ?, ?)');
    const insertSearch = this.db.prepare('INSERT INTO knowledge_search (rowid, name, body) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO knowledge_documents (id, name, source, path, hash, type, unit, units, chars, size, chunks, origin, chat, added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(doc.id, doc.name, source, source ? null : file, hash, t.type, t.unit ?? null, t.unitCount, t.chars, st.size, chunks.length, origin === 'chat' ? 'chat' : 'list', chat, new Date().toISOString());
      const folded = fold(doc.name);
      for (const [n, c] of chunks.entries()) {
        const { lastInsertRowid } = insertChunk.run(doc.id, n, c.line, c.lines, c.label, c.text);
        insertSearch.run(Number(lastInsertRowid), folded, fold(c.text));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.log(`[knowledge] ${doc.name}: ${chunks.length === 1 ? '1 passage' : `${chunks.length} passages`}`);
    this.embedLater();
    return { document: this.get(doc.id), added: true };
  }

  remove(documentId) {
    const d = this.db.prepare('SELECT id, name FROM knowledge_documents WHERE id = ?').get(String(documentId));
    if (!d) throw new UserError('Document not found.', 'notFound');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM knowledge_search WHERE rowid IN (SELECT id FROM knowledge_chunks WHERE document = ?)').run(d.id);
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document = ?').run(d.id);
      this.db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(d.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.vectors = null;
    return { id: d.id, name: d.name };
  }

  /**
   * Vectors for the passages that have none from the current model, in the background (one run at a time; a document
   * added meanwhile is taken by the same run). A failure is kept for the status and the search goes on by words.
   */
  embedLater() {
    if (!this.embedder.available || this.embedding || this.closed) return this.embedding;
    const model = this.embedder.model.name;
    this.embedding = (async () => {
      // a document indexed by another model (or none yet: also one added while this runs) starts again with this one
      const stale = this.db.prepare('SELECT id FROM knowledge_documents WHERE embed_model IS NULL OR embed_model != ?');
      const restart = () => {
        for (const { id: d } of stale.all(model)) {
          this.db.prepare('UPDATE knowledge_chunks SET vector = NULL WHERE document = ?').run(d);
          this.db.prepare('UPDATE knowledge_documents SET embed_model = ? WHERE id = ?').run(model, d);
        }
      };
      const next = this.db.prepare('SELECT id, text FROM knowledge_chunks WHERE vector IS NULL ORDER BY id LIMIT ?');
      const write = this.db.prepare('UPDATE knowledge_chunks SET vector = ? WHERE id = ?');
      restart();
      for (let batch = next.all(EMBED_BATCH); batch.length && !this.closed; restart(), batch = next.all(EMBED_BATCH)) {
        const vectors = await this.embedder.embed(batch.map((c) => c.text), { kind: 'passage' });
        // a document deleted while its batch was embedded: its rows are gone, the update touches nothing
        for (const [k, c] of batch.entries()) write.run(vectorBlob(vectors[k]), c.id);
        this.vectors = null;
      }
      this.embedError = null;
    })()
      .catch((e) => {
        this.embedError = e.message;
        this.log(`[knowledge] embedding failed: ${e.message}`);
      })
      .finally(() => {
        this.embedding = null;
      });
    return this.embedding;
  }

  /** Every passage vector of the current model (read once, again after a change). */
  vectorTable() {
    const model = this.embedder.model?.name;
    if (this.vectors?.model === model) return this.vectors;
    const rows = this.db.prepare('SELECT c.id, c.document, c.vector FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document WHERE c.vector IS NOT NULL AND d.embed_model = ?').all(model);
    const dim = rows[0] ? rows[0].vector.byteLength / 4 : 0;
    const matrix = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => matrix.set(blobVector(r.vector), i * dim));
    this.vectors = { model, dim, ids: rows.map((r) => r.id), documents: rows.map((r) => r.document), matrix };
    return this.vectors;
  }

  /**
   * The best passages for a query: [{ document: { id, name, source, path }, label, line, lines, text, score, ranks:
   * { words, meaning } }]. documents: ids or names to search only in (null: all). mode: 'hybrid' (BM25 and vectors) or
   * 'words' (no model, or its vectors are not there yet, or it failed now).
   */
  async search(query, { documents = null, count = 5, signal = null } = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new UserError('A search query is needed.');
    const only = documents?.length ? this.match(documents) : null;
    if (only && !only.length) return { mode: 'words', results: [], note: 'None of the named documents is in Knowledge.' };
    const count2 = Math.max(1, Math.min(20, Number(count) || 5));
    const inDocs = only ? ` AND c.document IN (${only.map(() => '?').join(',')})` : '';
    const ranked = new Map(); // chunk id -> { words, meaning }
    const match = knowledgeQuery(q);
    if (match) {
      const rows = this.db.prepare(`SELECT s.rowid AS id FROM knowledge_search s JOIN knowledge_chunks c ON c.id = s.rowid WHERE knowledge_search MATCH ?${inDocs} ORDER BY bm25(knowledge_search, 2.0, 1.0) LIMIT ?`).all(match, ...(only ?? []), SEARCH_POOL);
      rows.forEach((r, i) => ranked.set(r.id, { words: i + 1, meaning: null }));
    }
    let mode = 'words';
    let note = null;
    if (this.embedder.available) {
      try {
        const table = this.vectorTable();
        if (table.ids.length) {
          const [v] = await this.embedder.embed([q], { kind: 'query', signal });
          if (v.length === table.dim) {
            const scores = [];
            const allowed = only ? new Set(only) : null;
            for (let i = 0; i < table.ids.length; i++) {
              if (allowed && !allowed.has(table.documents[i])) continue;
              let dot = 0;
              for (let k = 0, at = i * table.dim; k < table.dim; k++) dot += v[k] * table.matrix[at + k];
              scores.push([table.ids[i], dot]);
            }
            scores.sort((a, b) => b[1] - a[1]);
            scores.slice(0, SEARCH_POOL).forEach(([chunk], i) => ranked.set(chunk, { words: ranked.get(chunk)?.words ?? null, meaning: i + 1 }));
            mode = 'hybrid';
          } else note = 'The embedding model changed; the passages get new vectors in the background.';
        }
        const st = this.status();
        if (st.embedded < st.chunks) {
          this.embedLater();
          note ??= 'Some passages have no vectors yet (they are made in the background); those are found by words only.';
        }
      } catch (e) {
        note = `Search by meaning failed (${e.message}); by words only.`;
      }
    }
    const fused = [...ranked.entries()].map(([chunk, r]) => ({ chunk, ranks: r, score: (r.words ? 1 / (FUSION_K + r.words) : 0) + (r.meaning ? 1 / (FUSION_K + r.meaning) : 0) }));
    fused.sort((a, b) => b.score - a.score || (a.ranks.words ?? 1e9) - (b.ranks.words ?? 1e9));
    const top = fused.slice(0, count2);
    const read = this.db.prepare('SELECT c.*, d.name, d.source, d.path FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document WHERE c.id = ?');
    const results = top.map((f) => {
      const c = read.get(f.chunk);
      return { document: { id: c.document, name: c.name, source: c.source ?? null, path: c.source ? null : c.path }, label: c.label, line: c.line, lines: c.lines, text: c.text, score: Math.round(f.score * 10000) / 10000, ranks: f.ranks };
    });
    return { mode, results, ...(note ? { note } : {}) };
  }

  close() {
    this.closed = true;
    this.embedder.close();
  }
}
