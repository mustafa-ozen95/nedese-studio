/**
 * Yerel veritabani (SQLite) ve ComfyUI aktaricisinin ag denetimi.
 *   node --test panel/test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../lib/database.mjs';
import { isCustomNetwork } from '../lib/comfy-proxy.mjs';

test('database: jobs filtered, paginated, newest to oldest; measurement median', () => {
  const root = mkdtempSync(join(tmpdir(), 'db-'));
  const db = new Database(join(root, 'panel.db'));
  try {
    for (let i = 0; i < 30; i++) {
      const type = i % 3 === 0 ? 'video' : 'image';
      const status = i % 5 === 0 ? 'error' : 'done';
      db.writeJob({ id: `job${String(i).padStart(2, '0')}`, type, status, creation: new Date(2026, 9, 4, 0, i).toISOString(), outputs: [] });
    }
    assert.equal(db.jobCount(), 30);
    const first = db.jobQuery({ limit: 5 });
    assert.equal(first.total, 30);
    assert.deepEqual(first.ids, ['job29', 'job28', 'job27', 'job26', 'job25']);
    const video = db.jobQuery({ type: 'video', statuses: ['done'] });
    assert.equal(video.total, 8);
    assert.deepEqual(db.jobQuery({ statuses: ['error', 'cancelled'], limit: 2, skip: 1 }).ids, ['job20', 'job15']);
    // Güncelleme aynı satırı değiştirir
    db.writeJob({ id: 'job29', type: 'video', status: 'done', creation: new Date(2026, 9, 4, 0, 29).toISOString() });
    assert.equal(db.jobCount(), 30);
    db.deleteJob('job29');
    assert.equal(db.jobCount(), 29);
    for (const d of [10, 30, 20, 40, 50]) db.writeMeasurement('image/qwen', d, 'x');
    assert.deepEqual(db.averages(), { 'image/qwen': 30 });
    db.writeUpload({ file: '20261004-010000-kare.png', type: 'image', name: 'kare.png', size: 10, width: 32, height: 18 });
    db.writeUpload({ file: '20261004-010100-muzik-tema.mp3', type: 'music', name: 'tema.mp3', size: 5 });
    assert.equal(db.uploadCount(), 2);
    assert.deepEqual(db.uploads({ type: 'music' }).map((y) => y.name), ['tema.mp3']);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('database chats: an older panel.db gets the pinned and archived columns (its chats neither); the shelves: main, pinned, archived; the archived count', () => {
  const root = mkdtempSync(join(tmpdir(), 'db-'));
  const path = join(root, 'panel.db');
  // the chats table as it was before pinned and archived chats
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE chats (num INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, updated TEXT NOT NULL, parent TEXT, summary TEXT NOT NULL)');
  old.prepare('INSERT INTO chats (id, updated, parent, summary) VALUES (?, ?, ?, ?)').run('old1', '2026-10-01T00:00:00.000Z', null, JSON.stringify({ id: 'old1', title: 'Old chat', update: '2026-10-01T00:00:00.000Z' }));
  old.close();
  const db = new Database(path);
  try {
    const page = (shelf) => db.chatPage({ shelf }).summaries.map((s) => s.id);
    assert.deepEqual(page('main'), ['old1'], 'an older chat is on the main shelf');
    const summary = (id, update, extra = {}) => ({ id, title: id, update, parent: null, ...extra });
    db.writeChat(summary('p1', '2026-10-02T00:00:00.000Z', { pinned: true }), { title: 'p1', body: '' });
    db.writeChat(summary('a1', '2026-10-03T00:00:00.000Z', { archived: true }), { title: 'a1', body: '' });
    db.writeChat(summary('n1', '2026-10-04T00:00:00.000Z'), { title: 'n1', body: '' });
    assert.deepEqual([page('main'), page('pinned'), page('archived'), page(null)], [['n1', 'old1'], ['p1'], ['a1'], ['n1', 'a1', 'p1', 'old1']]);
    assert.equal(db.chatPage({ shelf: 'main' }).total, 2);
    assert.equal(db.archivedChatCount(), 1);
    // written again: the columns follow the summary
    db.writeChat(summary('a1', '2026-10-05T00:00:00.000Z'), { title: 'a1', body: '' });
    assert.deepEqual([page('main'), db.archivedChatCount()], [['a1', 'n1', 'old1'], 0]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ComfyUI forwarder open only to the local/private network (Tailscale and external address closed)', () => {
  for (const a of ['127.0.0.1', '::1', '10.0.0.5', '::ffff:192.168.1.20', '172.16.4.1']) assert.ok(isCustomNetwork(a), a);
  for (const a of ['100.78.75.99', '8.8.8.8', '172.32.0.1', '::ffff:100.64.0.1', '']) assert.ok(!isCustomNetwork(a), a);
});
