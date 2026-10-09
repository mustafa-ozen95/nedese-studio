/**
 * Ag istemcisi yetkisi. Giris varsayilan KAPALI (kullanici: uyelik yok); girisZorunlu=true (AI_PANEL_GIRIS=1) ile ag istemcisi
 * (yerelIstemciGuven=false ile taklit)
 * anahtar ya da oturum cerezi olmadan API, eski /api ve /dosya'ya giremez; giris denemesi sinirli; oturum
 * cerezi dosyada kalici; cikis ve anahtar yenileme oturumu dusurur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginLimiter, Sessions, readCookie, isLocalClient } from '../lib/session.mjs';
import { createPanel } from './env.mjs';

test('session helpers: token is hashed and persisted, expired ones are dropped, cookie is read, login limit', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'oturum-')), 'oturumlar.json');
  const o = new Sessions({ file, lifetimeDay: 1 });
  const b = o.create('127.0.0.1 test');
  assert.ok(b.length >= 40);
  assert.equal(o.validate(b), true);
  assert.equal(o.validate('falseItem'), false);
  assert.ok(!JSON.stringify(JSON.parse(require_(file))).includes(b), 'raw token is not written to disk');
  const o2 = new Sessions({ file, lifetimeDay: 1 });
  assert.equal(o2.validate(b), true, 'session survives a restart');
  writeFileSync(file, JSON.stringify([{ summary: JSON.parse(require_(file))[0].summary, creation: '2020-01-01T00:00:00.000Z', lastUsage: '2020-01-01T00:00:00.000Z' }]));
  assert.equal(new Sessions({ file, lifetimeDay: 1 }).validate(b), false, 'expired session is invalid');
  assert.equal(readCookie('a=1; nedese_session=abc%3D; b=2'), 'abc=');
  assert.equal(readCookie('a=1; aipanel_oturum=abc%3D'), null, 'old cookie name is not read');
  assert.equal(readCookie('a=1'), null);
  assert.deepEqual(['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.5', '100.64.0.9'].map((a) => isLocalClient(a, ['192.168.1.5'])), [true, true, true, true, false]);
  const s = new LoginLimiter({ max: 2, windowMs: 60000 });
  assert.equal(s.allowed('1.1.1.1'), true);
  s.failed('1.1.1.1');
  s.failed('1.1.1.1');
  assert.equal(s.allowed('1.1.1.1'), false);
  assert.equal(s.allowed('2.2.2.2'), true);
  s.successful('1.1.1.1');
  assert.equal(s.allowed('1.1.1.1'), true);
});

function require_(file) {
  return readFileSync(file, 'utf8');
}
import { readFileSync } from 'node:fs';

test('network client: 401 without key or session (giris); login with the key gives a cookie; logout and key renewal drop the session', async () => {
  const p = await createPanel({ server: true, setting: { localClientTrust: false, loginRequired: true } });
  const K = p.settingFile.apiKey;
  const req = (path, { method = 'GET', headers = {}, body } = {}) => fetch(`${p.address}${path}`, { method: method, headers: { 'X-Panel': '1', Origin: new URL(p.address).origin, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  try {
    // Tarayici basliklari (X-Panel, Origin) ag istemcisinde kimlik yerine gecmez
    let r = await req('/api/v1/status');
    assert.equal(r.status, 401);
    const denied = await r.json();
    assert.equal(denied.code, 'login');
    assert.match(denied.error, /^Sign-in is required from this device/);
    assert.equal((await req('/api/status')).status, 401, 'old UI route is closed too');
    assert.equal((await req('/api/job', { method: 'POST', body: { type: 'image' } })).status, 401);
    assert.equal((await req('/file/upload/x.png')).status, 401);
    assert.equal((await req('/llm/v1/models')).status, 401);
    assert.equal((await req('/api/v1/id')).status, 200, 'kimlik yetkisiz');
    assert.equal((await req('/')).status, 200, 'UI files are open (for the login window)');
    assert.deepEqual(await (await req('/api/v1/session')).json(), { ok: true, local: false, withSession: false, withKey: false, loginRequired: true });
    // Anahtarla API eskisi gibi
    assert.equal((await req('/api/v1/status', { headers: { Authorization: `Bearer ${K}` } })).status, 200);
    // Yanlis anahtar: 401; sinir asilinca 429
    r = await req('/api/v1/login', { method: 'POST', body: { key: 'falseItem' } });
    assert.equal(r.status, 401);
    for (let i = 0; i < 8; i++) await req('/api/v1/login', { method: 'POST', body: { key: 'falseItem' } });
    assert.equal((await req('/api/v1/login', { method: 'POST', body: { key: K } })).status, 429, 'kaba kuvvet siniri dogru anahtari da bekletir');
  } finally {
    await p.close();
  }
  // Sinir temiz bir panelde: dogru anahtar -> cerez -> erisim; cikis -> 401; anahtar yenile -> oturum duser
  const p2 = await createPanel({ server: true, setting: { localClientTrust: false, loginRequired: true } });
  const K2 = p2.settingFile.apiKey;
  const request2 = (path, { method = 'GET', headers = {}, body } = {}) => fetch(`${p2.address}${path}`, { method: method, headers: { 'X-Panel': '1', Origin: new URL(p2.address).origin, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const r = await request2('/api/v1/login', { method: 'POST', body: { key: K2 } });
    assert.equal(r.status, 200, await r.text());
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /^nedese_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    const c = cookie.split(';')[0];
    assert.equal((await request2('/api/v1/status', { headers: { Cookie: c } })).status, 200, 'oturumla API');
    assert.equal((await request2('/api/status', { headers: { Cookie: c } })).status, 200, 'oturumla eski rota');
    assert.deepEqual((await (await request2('/api/v1/session', { headers: { Cookie: c } })).json()).withSession, true);
    assert.equal((await request2('/api/v1/status', { headers: { Cookie: 'nedese_session=fake' } })).status, 401, 'made-up cookie');
    const exit = await request2('/api/v1/logout', { method: 'POST', headers: { Cookie: c } });
    assert.match(exit.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request2('/api/v1/status', { headers: { Cookie: c } })).status, 401, 'no session after logout');
    const r2 = await request2('/api/v1/login', { method: 'POST', body: { key: K2 } });
    const c2 = r2.headers.get('set-cookie').split(';')[0];
    assert.equal((await request2('/api/v1/settings/rotate-key', { method: 'POST', headers: { Authorization: `Bearer ${K2}` } })).status, 200);
    assert.equal((await request2('/api/v1/status', { headers: { Cookie: c2 } })).status, 401, 'sessions are dropped when the key is renewed');
  } finally {
    await p2.close();
  }
});

test('login is off by default: network clients also open without a key (user decision: no accounts)', async () => {
  const p = await createPanel({ server: true, setting: { localClientTrust: false } });
  try {
    const r = await fetch(`${p.address}/api/v1/status`, { headers: { 'X-Panel': '1' } });
    assert.equal(r.status, 200);
    assert.equal((await (await fetch(`${p.address}/api/v1/session`)).json()).loginRequired, false);
    assert.equal((await fetch(`${p.address}/api/status`, { headers: { 'X-Panel': '1' } })).status, 200);
  } finally {
    await p.close();
  }
});

test('browser from this machine: free without a key (default behaviour preserved)', async () => {
  const p = await createPanel({ server: true });
  try {
    const r = await fetch(`${p.address}/api/v1/status`, { headers: { 'X-Panel': '1' } });
    assert.equal(r.status, 200);
    assert.deepEqual((await (await fetch(`${p.address}/api/v1/session`)).json()).local, true);
  } finally {
    await p.close();
  }
});
