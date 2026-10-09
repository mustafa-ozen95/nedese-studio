/**
 * The panel's local database (SQLite, Node's built-in node:sqlite; no extra dependency): <ai>\panel-data\panel.db.
 * Jobs and uploads are indexed here; the list, pages, gallery and duration averages come from queries instead of
 * folder scans (fast with thousands of jobs too).
 * Chats: list summary per chat (paged by update time) and a full-text index (FTS5) over titles and messages; the
 * messages themselves stay in panel-data/chat/<id>.json.
 *
 * The job.json files stay (a job's folder can be moved and is read on a retry); when the database is damaged or
 * deleted it is rebuilt from the folders at the next start.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 1;

export class Database {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
        creation TEXT NOT NULL, position TEXT NOT NULL, record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_created ON jobs (creation DESC);
      CREATE INDEX IF NOT EXISTS jobs_type ON jobs (type, creation DESC);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, creation DESC);
      CREATE INDEX IF NOT EXISTS jobs_type_status ON jobs (type, status, creation DESC);
      CREATE TABLE IF NOT EXISTS measurements (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value REAL NOT NULL, job_id TEXT);
      CREATE INDEX IF NOT EXISTS measurements_key ON measurements (key, id DESC);
      CREATE INDEX IF NOT EXISTS measurements_job ON measurements (job_id);
      CREATE TABLE IF NOT EXISTS uploads (
        file TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, size INTEGER, width INTEGER, height INTEGER, creation TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS uploads_created ON uploads (creation DESC);
      CREATE INDEX IF NOT EXISTS uploads_type ON uploads (type, creation DESC);
      CREATE TABLE IF NOT EXISTS chats (
        num INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, updated TEXT NOT NULL, parent TEXT, summary TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chats_updated ON chats (updated DESC, id DESC);
      CREATE INDEX IF NOT EXISTS chats_parent ON chats (parent);
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_search USING fts5 (title, body, tokenize = 'unicode61 remove_diacritics 2');
    `);
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('version', String(VERSION));
    // Pinned and archived chats (user request 08.10.2026) have columns of their own, so the list keeps them apart
    // without reading every summary; a DB from before them gets the columns (0: neither)
    const chatColumns = this.db.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);
    if (!chatColumns.includes('pinned')) this.db.exec('ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    if (!chatColumns.includes('archived')) this.db.exec('ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS chats_shelf ON chats (archived, pinned, updated DESC, id DESC)');
    this.s = {
      writeJob: this.db.prepare('INSERT INTO jobs (id, type, status, creation, position, record) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, status = excluded.status, creation = excluded.creation, position = excluded.position, record = excluded.record'),
      deleteJob: this.db.prepare('DELETE FROM jobs WHERE id = ?'),
      countJob: this.db.prepare('SELECT COUNT(*) AS n FROM jobs'),
      all: this.db.prepare('SELECT record FROM jobs'),
      writeMeasurement: this.db.prepare('INSERT INTO measurements (key, value, job_id) VALUES (?, ?, ?)'),
      deleteMeasurement: this.db.prepare('DELETE FROM measurements WHERE job_id = ?'),
      keys: this.db.prepare('SELECT DISTINCT key FROM measurements'),
      lastMeasurements: this.db.prepare('SELECT value FROM measurements WHERE key = ? ORDER BY id DESC LIMIT 8'),
      writeUpload: this.db.prepare('INSERT OR REPLACE INTO uploads (file, type, name, size, width, height, creation) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      countUpload: this.db.prepare('SELECT COUNT(*) AS n FROM uploads'),
      readMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      writeMeta: this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      writeChat: this.db.prepare('INSERT INTO chats (id, updated, parent, summary, pinned, archived) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, parent = excluded.parent, summary = excluded.summary, pinned = excluded.pinned, archived = excluded.archived RETURNING num'),
      archivedCount: this.db.prepare('SELECT COUNT(*) AS n FROM chats WHERE archived = 1'),
      chatNum: this.db.prepare('SELECT num FROM chats WHERE id = ?'),
      deleteChat: this.db.prepare('DELETE FROM chats WHERE id = ?'),
      deleteSearch: this.db.prepare('DELETE FROM chat_search WHERE rowid = ?'),
      writeSearch: this.db.prepare('INSERT INTO chat_search (rowid, title, body) VALUES (?, ?, ?)'),
      chatChildren: this.db.prepare('SELECT id FROM chats WHERE parent = ?'),
      chatCount: this.db.prepare('SELECT COUNT(*) AS n FROM chats'),
    };
    this.queries = new Map();
  }

  /** Prepared statement cache for the queries built from filters. */
  query(sql) {
    let q = this.queries.get(sql);
    if (!q) this.queries.set(sql, (q = this.db.prepare(sql)));
    return q;
  }

  meta(key, value) {
    if (value === undefined) return this.s.readMeta.get(key)?.value ?? null;
    this.s.writeMeta.run(key, String(value));
    return value;
  }

  /* ── Isler ── */

  writeJob(job) {
    this.s.writeJob.run(job.id, job.type, job.status, job.creation, job.creationPosition ?? job.creation, JSON.stringify(job));
  }

  deleteJob(id) {
    this.s.deleteJob.run(id);
    this.s.deleteMeasurement.run(id);
  }

  jobCount() {
    return this.s.countJob.get().n;
  }

  /** Every job (taken into memory at start). */
  jobs() {
    return this.s.all.all().map((r) => JSON.parse(r.record));
  }

  /** Suzgecli, yeniden eskiye; { kimlikler, toplam }. durumlar dizi olabilir. */
  jobQuery({ type, statuses, limit = 500, skip = 0 } = {}) {
    const condition = [];
    const value = [];
    if (type) {
      condition.push('type = ?');
      value.push(type);
    }
    if (statuses?.length) {
      condition.push(`status IN (${statuses.map(() => '?').join(',')})`);
      value.push(...statuses);
    }
    const where = condition.length ? `WHERE ${condition.join(' AND ')}` : '';
    const total = this.query(`SELECT COUNT(*) AS n FROM jobs ${where}`).get(...value).n;
    const ids = this.query(`SELECT id FROM jobs ${where} ORDER BY creation DESC LIMIT ? OFFSET ?`).all(...value, limit, skip).map((r) => r.id);
    return { ids, total };
  }

  /* ── Sure olcumleri (tahminler) ── */

  writeMeasurement(key, value, jobId) {
    this.s.writeMeasurement.run(key, value, jobId ?? null);
  }

  /** Her anahtarin son 8 olcumunun ortancasi. */
  averages() {
    const result = {};
    for (const { key } of this.s.keys.all()) {
      const last = this.s.lastMeasurements.all(key).map((r) => r.value).sort((a, b) => a - b);
      if (last.length) result[key] = Math.round(last[Math.floor(last.length / 2)] * 10) / 10;
    }
    return result;
  }

  /* ── Yuklemeler ── */

  writeUpload({ file, type, name, size = null, width = null, height = null, creation = new Date().toISOString() }) {
    this.s.writeUpload.run(file, type, name ?? file, size, width, height, creation);
  }

  uploadCount() {
    return this.s.countUpload.get().n;
  }

  uploads({ type, limit = 1000 } = {}) {
    return type ? this.query('SELECT * FROM uploads WHERE type = ? ORDER BY creation DESC LIMIT ?').all(type, limit) : this.query('SELECT * FROM uploads ORDER BY creation DESC LIMIT ?').all(limit);
  }

  /* ── Chats ── */

  /** Writes a chat's list summary and its search text (title and body already folded for search). */
  writeChat(summary, { title, body }) {
    const { num } = this.s.writeChat.get(summary.id, summary.update, summary.parent ?? null, JSON.stringify(summary), summary.pinned ? 1 : 0, summary.archived ? 1 : 0);
    this.s.deleteSearch.run(num);
    this.s.writeSearch.run(num, title, body);
  }

  deleteChat(id) {
    const r = this.s.chatNum.get(id);
    if (!r) return;
    this.s.deleteSearch.run(r.num);
    this.s.deleteChat.run(id);
  }

  chatChildren(id) {
    return this.s.chatChildren.all(id).map((r) => r.id);
  }

  chatCount() {
    return this.s.chatCount.get().n;
  }

  archivedChatCount() {
    return this.s.archivedCount.get().n;
  }

  /** Every chat's list summary (parsed): totals over all chats without reading their files (rated answers). */
  chatSummaries() {
    return this.query('SELECT summary FROM chats').all().map((r) => {
      try {
        return JSON.parse(r.summary);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  /**
   * One page of chats, newest update first. match: FTS5 query (null = all). after: cursor of the previous page's last
   * item ({ updated, id }). Returns { summaries, total, next } (next: cursor or null).
   * sort 'relevance' (with match; user request 08.10.2026): best match first (FTS5 bm25, a title hit weighs 5 times a
   * message hit, then the newer chat); its cursor is { offset }. exclude: a chat id left out (the one searching).
   * shelf: 'main' (neither pinned nor archived), 'pinned' (pinned, not archived), 'archived'; null: every chat.
   */
  chatPage({ match = null, after = null, limit = 30, sort = 'recent', exclude = null, shelf = null } = {}) {
    const condition = [];
    const value = [];
    if (shelf === 'main') condition.push('c.archived = 0 AND c.pinned = 0');
    else if (shelf === 'pinned') condition.push('c.archived = 0 AND c.pinned = 1');
    else if (shelf === 'archived') condition.push('c.archived = 1');
    if (match) {
      condition.push('c.num IN (SELECT rowid FROM chat_search WHERE chat_search MATCH ?)');
      value.push(match);
    }
    if (exclude) {
      condition.push('c.id != ?');
      value.push(exclude);
    }
    const where = condition.length ? `WHERE ${condition.join(' AND ')}` : '';
    const total = this.query(`SELECT COUNT(*) AS n FROM chats c ${where}`).get(...value).n;
    if (match && sort === 'relevance') {
      const skip = Math.max(0, Math.floor(Number(after?.offset) || 0));
      const rows = this.query(`SELECT c.id, c.updated, c.summary FROM chat_search s JOIN chats c ON c.num = s.rowid WHERE chat_search MATCH ?${exclude ? ' AND c.id != ?' : ''} ORDER BY bm25(chat_search, 5.0, 1.0), c.updated DESC, c.id DESC LIMIT ? OFFSET ?`).all(match, ...(exclude ? [exclude] : []), limit + 1, skip);
      return { summaries: rows.slice(0, limit).map((r) => JSON.parse(r.summary)), total, next: rows.length > limit ? { offset: skip + limit } : null };
    }
    if (after) {
      // row value: SQLite seeks straight to the cursor in chats_updated (an OR condition scanned the index from the top)
      condition.push('(c.updated, c.id) < (?, ?)');
      value.push(after.updated, after.id);
    }
    const rows = this.query(`SELECT c.id, c.updated, c.summary FROM chats c ${condition.length ? `WHERE ${condition.join(' AND ')}` : ''} ORDER BY c.updated DESC, c.id DESC LIMIT ?`).all(...value, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { summaries: page.map((r) => JSON.parse(r.summary)), total, next: rows.length > limit && last ? { updated: last.updated, id: last.id } : null };
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* zaten kapali */
    }
  }
}
