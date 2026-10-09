/**
 * HTTP istek govdesi yardimcilari: JSON / form okuma, ikili govdeyi dosyaya yazma, zaman damgasi.
 */
import { createWriteStream, existsSync, rmSync, statfsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { UserError } from './errors.mjs';

/** JSON ya da x-www-form-urlencoded govde; sinir (bayt) asilirsa hata. */
export async function readJson(req, limit = 16 * 2 ** 20) {
  const parts = [];
  let height = 0;
  for await (const p of req) {
    height += p.length;
    if (height > limit) throw new UserError(`Request too large (max ${Math.round(limit / 2 ** 20)} MB).`, 'tooLarge');
    parts.push(p);
  }
  const text = parseText(Buffer.concat(parts));
  if (!text) return {};
  const type = req.headers['content-type'] ?? '';
  if (/application\/x-www-form-urlencoded/.test(type)) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError('The request body is not JSON.');
  }
}

/**
 * Govde UTF-8 degilse (Windows konsolundan curl vb.) Turkce Windows kodlamasi (1254) ile cozulur;
 * boylece "ı ğ ş" bozulup "�" olarak kaydedilmez.
 */
export function parseText(b) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1254').decode(b);
  }
}

const DISK_SHARE = 2 * 2 ** 30;
// Su an govdesi yazilan dosyalar: ayni dosyaya iki yukleme karismasin, yarim dosya otekinin elinden silinmesin
const writing = new Set();
const key = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));

function freeDisk(folder) {
  try {
    const s = statfsSync(folder);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Klasorde kullanilmayan ad: ayni saniyede ayni adli ikinci yuklemeye -2, -3 ... eki. */
export function freePath(folder, name) {
  const uz = extname(name);
  const body = name.slice(0, name.length - uz.length);
  for (let n = 1; ; n++) {
    const path = join(folder, n === 1 ? name : `${body}-${n}${uz}`);
    if (!existsSync(path) && !writing.has(key(path))) return path;
  }
}

/**
 * Ham govdeyi dosyaya akitir. Sinir asilirsa, disk dolmak uzereyse (Content-Length'siz govdede de),
 * govde bosKalmaMs boyunca durursa ya da bos ise dosya silinir ve hata atilir. Content-Length varsa
 * sinir ve bos yer govde okunmadan denetlenir.
 */
export async function writeBody(req, path, limit, { freeStayingMs = 5 * 60000 } = {}) {
  const k = key(path);
  if (writing.has(k)) throw new UserError('This file is currently uploading; wait for it to finish.', 'inUse');
  const mb = (x) => Math.round(x / 2 ** 20);
  const gb = (x) => (x / 2 ** 30).toFixed(1);
  const len = Number(req.headers?.['content-length'] ?? NaN);
  if (len > limit) throw new UserError(`File too large (max ${mb(limit)} MB).`, 'tooLarge');
  const firstFree = freeDisk(dirname(path));
  if (firstFree !== null && len > 0 && firstFree < len + DISK_SHARE) throw new UserError(`Not enough disk space: ${gb(len)} GB needed, ${gb(firstFree)} GB free (a 2 GB margin is kept).`, 'disk');
  writing.add(k);
  // Sunucuda istek suresi sinirsiz (buyuk model yuklemesi): yalniz bosta kalma sinirli; dolunca Node baglantiyi keser
  req.socket?.setTimeout(freeStayingMs);
  let height = 0;
  let checked = 0;
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const p of source) {
          height += p.length;
          if (height > limit) throw new UserError(`File too large (max ${mb(limit)} MB).`, 'tooLarge');
          if (height - checked >= 64 * 2 ** 20) {
            checked = height;
            const free = freeDisk(dirname(path));
            if (free !== null && free < DISK_SHARE) throw new UserError(`Disk is full (${gb(free)} GB left); upload stopped.`, 'disk');
          }
          yield p;
        }
      },
      createWriteStream(path),
    );
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  } finally {
    writing.delete(k);
    req.socket?.setTimeout(0);
  }
  if (!height) {
    rmSync(path, { force: true });
    throw new UserError('The file is empty.');
  }
  return height;
}

export function stamp() {
  const s = new Date();
  const iki = (n) => String(n).padStart(2, '0');
  return `${s.getFullYear()}${iki(s.getMonth() + 1)}${iki(s.getDate())}-${iki(s.getHours())}${iki(s.getMinutes())}${iki(s.getSeconds())}`;
}
