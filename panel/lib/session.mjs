/**
 * Oturumlar ve giris denemeleri: panele ag uzerinden (ev agi, Tailscale) tarayiciyla baglanan istemci API
 * anahtarini bir kez girer, HttpOnly + SameSite=Strict cerezle oturum alir. Belirtecler ozetlenerek
 * (SHA-256) panel-data\oturumlar.json'da tutulur: panel yeniden baslayinca oturumlar dusmez.
 * Giris denemeleri IP basina sinirlidir (kaba kuvvete karsi).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const COOKIE_NAME = 'nedese_session';
const summary = (s) => createHash('sha256').update(String(s)).digest('hex');

export class Sessions {
  constructor({ file = null, lifetimeDay = 90, max = 200 } = {}) {
    Object.assign(this, { file, lifetimeMs: lifetimeDay * 86400000, max });
    this.list = []; // { ozet, olusturma, sonKullanim, istemci }
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      this.list = JSON.parse(readFileSync(this.file, 'utf8')).filter((o) => o && typeof o.summary === 'string');
    } catch {
      this.list = [];
    }
    this.clean();
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.writing`;
    writeFileSync(temp, JSON.stringify(this.list, null, 1), 'utf8');
    renameSync(temp, this.file);
  }

  clean() {
    const now = Date.now();
    this.list = this.list.filter((o) => now - Date.parse(o.lastUsage ?? o.creation) < this.lifetimeMs).slice(-this.max);
  }

  /** Yeni oturum; donen ham belirtec yalniz cerezde yasar. */
  create(client = '') {
    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    this.list.push({ summary: summary(token), creation: now, lastUsage: now, client: String(client).slice(0, 120) });
    this.clean();
    this.save();
    return token;
  }

  /** Belirtec gecerli mi; gecerliyse son kullanim en cok saatte bir guncellenir. */
  validate(token) {
    if (!token) return false;
    const o = summary(token);
    const record = this.list.find((x) => x.summary.length === o.length && timingSafeEqual(Buffer.from(x.summary), Buffer.from(o)));
    if (!record) return false;
    if (Date.now() - Date.parse(record.lastUsage ?? record.creation) > this.lifetimeMs) {
      this.list = this.list.filter((x) => x !== record);
      this.save();
      return false;
    }
    if (Date.now() - Date.parse(record.lastUsage) > 3600000) {
      record.lastUsage = new Date().toISOString();
      this.save();
    }
    return true;
  }

  remove(token) {
    if (!token) return;
    const o = summary(token);
    const n = this.list.length;
    this.list = this.list.filter((x) => x.summary !== o);
    if (this.list.length !== n) this.save();
  }

  /** Anahtar yenilenince butun oturumlar duser. */
  deleteAll() {
    this.list = [];
    this.save();
  }
}

/** Cookie basligindan deger. */
export function readCookie(title, name = COOKIE_NAME) {
  for (const part of String(title ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Giris denemesi siniri: IP basina pencere icinde en cok N basarisiz deneme. */
export class LoginLimiter {
  constructor({ max = 8, windowMs = 15 * 60000 } = {}) {
    Object.assign(this, { max, windowMs });
    this.trials = new Map(); // ip -> [zaman]
  }

  allowed(ip) {
    const now = Date.now();
    const l = (this.trials.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    this.trials.set(ip, l);
    return l.length < this.max;
  }

  failed(ip) {
    this.trials.set(ip, [...(this.trials.get(ip) ?? []), Date.now()]);
  }

  successful(ip) {
    this.trials.delete(ip);
  }
}

/** Istemci adresi bu makinenin kendisi mi (dongu ya da kendi arayuz adresleri). */
export function isLocalClient(remoteAddress, ownAddresses = []) {
  let a = String(remoteAddress ?? '').toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a.startsWith('127.')) return true;
  return ownAddresses.includes(a);
}
