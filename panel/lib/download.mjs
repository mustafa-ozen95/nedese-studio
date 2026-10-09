/**
 * Model indirici: tek sirada (ag ve disk tek), gercek bayt sayaci, hiz, kalan sure,
 * kaldigi yerden devam (HTTP Range; yarim dosya <hedef>.downloading), iptal, boyut ve
 * SHA-256 dogrulamasi (katalogdaki ya da Hugging Face'in x-linked-etag basligi).
 *
 * Durum <ai>\panel-data\indirmeler.json'da: panel yeniden acilinca yarim kalanlar
 * "paused" olur, "Sürdür" ile devam eder. Bagimlilik yok (fetch + fs).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { UserError } from './errors.mjs';
import { CATALOG, FOLDERS, diskStatus, checkModelExtension, modelPath } from './models.mjs';

const FILE_NAME = /^[\w.-]+$/;
const isYes = (v) => v === true || v === 'true' || v === '1' || v === 1;
const WIN = process.platform === 'win32';
/** Kayit durumu kodunun mesajlardaki adi (durum kodlari: queued | indiriliyor | duraklatildi | done | error | cancelled). */
const STATUS_LABEL = { queued: 'queued', indiriliyor: 'downloading', duraklatildi: 'paused', done: 'done', error: 'failed', cancelled: 'cancelled' };
const statusLabel = (s) => STATUS_LABEL[s] ?? s;

/** yol, kok'un kendisi ya da altinda mi (Windows'ta harf buyuklugu onemsiz). */
function inside(path, root) {
  if (!root) return false;
  const [y, k] = WIN ? [path.toLowerCase(), resolve(root).toLowerCase()] : [path, resolve(root)];
  return y === k || y.startsWith(k.endsWith(sep) ? k : k + sep);
}

/** Tam yol: baglantilar, 8.3 kisa adlar ve harf buyuklugu cozulmus (olmayan dosyada resolve). */
function realPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Iki yol ayni dosya mi: harf buyuklugu, 8.3 kisa ad ya da sert baglanti farkli olsa da. */
function sameFile(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    if (x.ino !== 0n && x.ino === y.ino && x.dev === y.dev) return true;
  } catch {
    /* yola gore karsilastir */
  }
  const [ga, gb] = [realPath(a), realPath(b)];
  return WIN ? ga.toLowerCase() === gb.toLowerCase() : ga === gb;
}

export class Downloader {
  /**
   * { modelKok, kayitYolu, korunanKokler, degisti(), gunluk(metin) }
   * korunanKokler: buralardaki dosyalar (model klasoru haric) yalniz kopyalanir, tasinmaz (panel kurulumu: yazi modeli, egitim, ses).
   */
  constructor({ modelRoot, recordPath, protectedRoots = [], changed = () => {}, log = () => {} }) {
    this.modelRoot = modelRoot;
    this.protectedRoots = protectedRoots;
    this.recordPath = recordPath;
    this.changed = changed;
    this.log = log;
    this.list = [];
    this.active = null;
    this.control = null;
    this.load();
  }

  load() {
    if (!existsSync(this.recordPath)) return;
    try {
      this.list = JSON.parse(readFileSync(this.recordPath, 'utf8')).filter((x) => x && x.id);
    } catch {
      this.list = [];
    }
    for (const i of this.list) {
      if (i.status === 'downloading' || i.status === 'queued') {
        i.status = 'paused';
        i.error = 'It was downloading when the panel closed; "Resume" continues where it left off.';
        i.downloaded = this.partialSize(i);
      }
    }
    this.save();
  }

  save() {
    mkdirSync(dirname(this.recordPath), { recursive: true });
    const temp = `${this.recordPath}.writing`;
    writeFileSync(temp, JSON.stringify(this.list.map((i) => ({ ...i, speed: undefined })), null, 1), 'utf8');
    renameSync(temp, this.recordPath);
  }

  partialPath(i) {
    return `${join(this.modelRoot, i.folder, i.file)}.downloading`;
  }

  /**
   * Ayni hedefe (klasor + dosya; Windows'ta harf buyuklugu onemsiz) yazan, durmamis kayit (haric disinda).
   * Yarim dosya hedefin adina bagli: boyle kayit varken ikinci indirme baslamaz, eski kayit silinince yarim dosya silinmez.
   */
  enabledRecord(folder, file, exclude = null) {
    const name = (x) => (WIN ? String(x).toLowerCase() : String(x));
    return this.list.find((i) => i !== exclude && i.folder === folder && name(i.file) === name(file) && ['queued', 'downloading', 'paused'].includes(i.status)) ?? null;
  }

  partialSize(i) {
    try {
      return statSync(this.partialPath(i)).size;
    } catch {
      return 0;
    }
  }

  find(id) {
    const i = this.list.find((x) => x.id === id);
    if (!i) throw new UserError('Download not found.', 'notFound');
    return i;
  }

  /** Arayuz icin ozet listesi. */
  summaries() {
    return this.list.map((i) => this.summary(i));
  }

  summary(i) {
    const remaining = i.expected && i.speed > 0 ? Math.round((i.expected - i.downloaded) / i.speed) : null;
    return { ...i, percent: i.expected ? Math.round((i.downloaded / i.expected) * 1000) / 10 : null, remainingSec: remaining };
  }

  /**
   * Yeni indirme: { katalog: 'qwen-q8' } ya da { url, klasor, dosya, beklenen?, sha256? }.
   * Ayni dosya zaten indiriliyorsa hata; kurulu ve boyutu dogruysa hata.
   */
  add(g = {}) {
    let record;
    if (g.catalog) {
      const k = CATALOG.find((x) => x.id === g.catalog);
      if (!k) throw new UserError(`Not in the catalog: ${g.catalog}`);
      record = { name: k.name, url: k.url, folder: k.folder, file: k.file, expected: k.size, sha256: k.sha256, catalog: k.id };
    } else {
      let url;
      try {
        url = new URL(String(g.url ?? ''));
      } catch {
        throw new UserError('Invalid download URL (must be https://…).');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserError('Only http/https URLs can be downloaded.');
      const folder = String(g.folder ?? '');
      if (!FOLDERS[folder]) throw new UserError(`Choose a model folder: ${Object.keys(FOLDERS).join(', ')}`);
      const file = String(g.file || decodeURIComponent(url.pathname.split('/').pop() || '')).trim();
      if (!FILE_NAME.test(file)) throw new UserError('Invalid file name (letters, digits, dot, hyphen, underscore only).');
      checkModelExtension(file);
      const expected = g.expected ? Number(g.expected) : null;
      if (expected !== null && !(Number.isInteger(expected) && expected > 0)) throw new UserError('The expected size must be a whole number of bytes.');
      const sha256 = g.sha256 ? String(g.sha256).toLowerCase() : null;
      if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) throw new UserError('SHA-256 must be 64 hexadecimal characters.');
      record = { name: g.name ? String(g.name).slice(0, 120) : file, url: url.href, folder, file, expected, sha256, catalog: null };
    }
    modelPath(this.modelRoot, record.folder, record.file);
    const target = join(this.modelRoot, record.folder, record.file);
    if (existsSync(target)) {
      const size = statSync(target).size;
      if (!record.expected || size === record.expected) throw new UserError(`${record.file} is already installed.`);
      throw new UserError(`${record.file} is installed but its size differs (${size} ≠ ${record.expected}). Delete it first, then download again.`);
    }
    const same = this.enabledRecord(record.folder, record.file);
    if (same) throw new UserError(`${record.file} is already in the download list (${statusLabel(same.status)}).`);
    const disk = diskStatus(this.modelRoot);
    if (record.expected && disk.freeByte !== null && disk.freeByte < record.expected + 2 * 2 ** 30) {
      throw new UserError(`Not enough disk space: ${gb(record.expected)} needed, ${gb(disk.freeByte)} free (2 GB is kept in reserve).`);
    }
    const i = { id: `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`, ...record, status: 'queued', downloaded: this.partialSize(record), speed: 0, error: null, creation: new Date().toISOString(), start: null, end: null };
    this.list.unshift(i);
    this.save();
    this.changed();
    this.run();
    return this.summary(i);
  }

  /**
   * Bu bilgisayardaki dosyayi model klasorune TASIR (varsayilan) ya da kopyalar: ayni surucude
   * aninda (rename); baska surucude bayt ilerlemesiyle kopyalanir, boyut dogrulanir, tasimada
   * kaynak silinir. Indirme listesinde "yerel" turuyle gorunur.
   */
  addLocal(g = {}) {
    const path = String(g.path ?? '').trim().replace(/^"|"$/g, '');
    if (!path) throw new UserError('The file path is empty.');
    if (!isAbsolute(path)) throw new UserError('Enter a full path (e.g. C:\\Users\\ad\\Desktop\\model.gguf).');
    let info;
    try {
      info = statSync(path);
    } catch {
      throw new UserError(`File not found: ${path}`);
    }
    if (!info.isFile()) throw new UserError('The path is not a file.');
    // Kaynak da model dosyasi olmali: hedef adi degistirilerek belge, veritabani gibi dosyalar model klasorune alinamaz
    checkModelExtension(basename(path));
    const real = realPath(path);
    const folder = String(g.folder ?? '');
    if (!FOLDERS[folder]) throw new UserError(`Choose a model folder: ${Object.keys(FOLDERS).join(', ')}`);
    const file = String(g.file || basename(path)).trim();
    checkModelExtension(file);
    const target = modelPath(this.modelRoot, folder, file);
    if (real === target || sameFile(real, target)) throw new UserError('The file is already in that folder.');
    if (WIN && inside(real, process.env.SystemRoot || 'C:\\Windows')) throw new UserError('Files cannot be taken from the Windows folder.');
    // Panelin kendi klasorlerinden (model klasoru haric), program klasorlerinden ve baglantidan yalniz kopya: tasima kurulumu bozar
    const safeguarded = [...this.protectedRoots, ...(WIN ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData] : [])].filter(Boolean);
    const onlyCopy = (safeguarded.some((k) => inside(real, k)) && !inside(real, this.modelRoot)) || lstatSync(path).isSymbolicLink();
    const method = g.method === 'copy' || onlyCopy ? 'copy' : 'move';
    if (existsSync(target) && !isYes(g.writeOnto)) throw new UserError(`${file} is already installed; confirm to overwrite.`, 'inUse');
    const same = this.enabledRecord(folder, file);
    if (same) throw new UserError(`${file} is already in the download list.`);
    const i = { id: `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`, type: 'local', name: `${method === 'move' ? 'Move' : 'Copy'}: ${basename(path)}`, url: null, path: real, method, writeOnto: isYes(g.writeOnto), folder, file, expected: info.size, sha256: null, catalog: null, status: 'queued', downloaded: 0, speed: 0, error: null, creation: new Date().toISOString(), start: null, end: null };
    this.list.unshift(i);
    this.save();
    this.changed();
    this.run();
    return this.summary(i);
  }

  async forwardLocal(i, signal) {
    const target = join(this.modelRoot, i.folder, i.file);
    const partial = this.partialPath(i);
    mkdirSync(dirname(target), { recursive: true });
    i.status = 'downloading';
    i.start = new Date().toISOString();
    this.changed();
    if (!existsSync(i.path)) throw new Error(`The source file no longer exists: ${i.path}`);
    const size = statSync(i.path).size;
    i.expected = size;
    // Kaynak hedefin kendisiyse (harf buyuklugu farkli yazilmis) "ustune yaz" kaynagi silerdi
    if (sameFile(i.path, target)) throw new Error('Source and target are the same file.');
    if (i.method === 'move') {
      try {
        if (existsSync(target)) rmSync(target, { force: true });
        renameSync(i.path, target);
        i.downloaded = size;
        i.status = 'done';
        i.end = new Date().toISOString();
        this.log(`Moved (same drive): ${i.folder}/${i.file}`);
        return;
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        /* baska surucu: kopyala + sil */
      }
    }
    const disk = diskStatus(this.modelRoot);
    if (disk.freeByte !== null && disk.freeByte < size + 2 ** 30) throw new Error(`Not enough disk space: ${gb(size)} needed, ${gb(disk.freeByte)} free.`);
    i.stage = 'copying';
    rmSync(partial, { force: true });
    await new Promise((ok, red) => {
      const reader = createReadStream(i.path, { highWaterMark: 4 * 2 ** 20 });
      const printer = createWriteStream(partial);
      let lastTime = Date.now();
      let lastDownloaded = 0;
      let lastRecord = Date.now();
      reader.on('data', (p) => {
        i.downloaded += p.length;
        const now = Date.now();
        if (now - lastTime >= 1000) {
          const instant = ((i.downloaded - lastDownloaded) * 1000) / (now - lastTime);
          i.speed = i.speed ? i.speed * 0.7 + instant * 0.3 : instant;
          lastTime = now;
          lastDownloaded = i.downloaded;
          this.changed();
        }
        if (now - lastRecord >= 5000) {
          lastRecord = now;
          this.save();
        }
      });
      const cancel = () => reader.destroy(new Error('cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      reader.on('error', red);
      printer.on('error', red);
      printer.on('finish', ok);
      reader.pipe(printer);
    });
    if (signal.aborted) {
      rmSync(partial, { force: true });
      return;
    }
    i.stage = '';
    const written = statSync(partial).size;
    if (written !== size) {
      rmSync(partial, { force: true });
      throw new Error(`Copy size mismatch (${written} ≠ ${size}); the source file was left untouched.`);
    }
    if (existsSync(target)) rmSync(target, { force: true });
    renameSync(partial, target);
    if (i.method === 'move') rmSync(i.path, { force: true });
    i.downloaded = size;
    i.status = 'done';
    i.end = new Date().toISOString();
    this.log(`${i.method === 'move' ? 'Moved' : 'Copied'}: ${i.folder}/${i.file} (${gb(size)})`);
  }

  resume(id) {
    const i = this.find(id);
    if (!['paused', 'error', 'cancelled'].includes(i.status)) throw new UserError('This download is already running or finished.');
    const other = this.enabledRecord(i.folder, i.file, i);
    if (other) throw new UserError(`There is another entry for ${i.file} (${statusLabel(other.status)}); finish or delete it first.`, 'inUse');
    // Bu arada baska kayitla (ya da yuklemeyle) kurulduysa uzerine yeniden indirme
    if (existsSync(join(this.modelRoot, i.folder, i.file)) && !(i.type === 'local' && i.writeOnto)) throw new UserError(`${i.file} is already installed.`, 'inUse');
    i.status = 'queued';
    i.error = null;
    i.downloaded = i.type === 'local' ? 0 : this.partialSize(i);
    this.save();
    this.changed();
    this.run();
    return this.summary(i);
  }

  /** Durdurur; yarim dosya kalir (Sürdür kaldigi yerden). */
  cancel(id) {
    const i = this.find(id);
    if (i.status === 'queued') {
      i.status = 'cancelled';
    } else if (i.status === 'downloading' && this.active === i) {
      i.status = 'cancelled';
      this.control?.abort();
    } else throw new UserError('This download is already paused.');
    this.save();
    this.changed();
    return this.summary(i);
  }

  /** Kaydi listeden siler; yarim dosyayi da siler. Bitmis indirmenin dosyasina dokunmaz. */
  remove(id) {
    const i = this.find(id);
    if (i.status === 'downloading') throw new UserError('Cancel it first.');
    // Ayni dosyanin yeni indirmesi suruyorsa yarim dosya onundur
    if (!this.enabledRecord(i.folder, i.file, i)) rmSync(this.partialPath(i), { force: true });
    this.list = this.list.filter((x) => x !== i);
    this.save();
    this.changed();
  }

  run() {
    if (this.active) return;
    const next = [...this.list].reverse().find((i) => i.status === 'queued');
    if (!next) return;
    this.active = next;
    this.control = new AbortController();
    (next.type === 'local' ? this.forwardLocal(next, this.control.signal) : this.download(next, this.control.signal))
      .catch((e) => {
        if (next.status !== 'cancelled') {
          next.status = 'error';
          next.error = String(e?.message ?? e).slice(0, 400);
          this.log(`Download error ${next.file}: ${next.error}`);
        }
      })
      .finally(() => {
        next.speed = 0;
        next.downloaded = next.status === 'done' ? next.downloaded : this.partialSize(next);
        this.active = null;
        this.control = null;
        this.save();
        this.changed();
        this.run();
      });
  }

  async download(i, signal) {
    const target = join(this.modelRoot, i.folder, i.file);
    const partial = this.partialPath(i);
    mkdirSync(dirname(target), { recursive: true });
    i.status = 'downloading';
    i.start = new Date().toISOString();
    i.error = null;
    this.changed();

    // Yarim dosya varsa once onun ozeti hesaplanir (SHA-256 akan veriyle surer).
    let summaryHash = createHash('sha256');
    let startedAt = this.partialSize(i);
    if (startedAt > 0) {
      i.stage = 'verifying partial file';
      this.changed();
      await new Promise((ok, red) => {
        const r = createReadStream(partial);
        r.on('data', (p) => summaryHash.update(p));
        r.on('end', ok);
        r.on('error', red);
        signal.addEventListener('abort', () => r.destroy(new Error('cancelled')), { once: true });
      });
    }
    i.stage = '';
    if (!i.sha256) i.sha256 = await connectionSummary(i.url, signal);
    const headers = startedAt > 0 ? { Range: `bytes=${startedAt}-` } : {};
    const response = await fetch(i.url, { headers: headers, signal: signal, redirect: 'follow' });
    if (!response.ok && response.status !== 206) throw new Error(`The server returned ${response.status} (${response.statusText}).`);
    let total = null;
    if (response.status === 206) {
      const m = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      total = m ? Number(m[1]) : null;
    } else {
      // 200: sunucu Range'i tanimadi, bastan basla (ozet de sifirdan).
      if (startedAt > 0) {
        this.log(`${i.file}: the server does not support resuming; downloading from the start.`);
        startedAt = 0;
        summaryHash = createHash('sha256');
      }
      const cl = response.headers.get('content-length');
      total = cl ? Number(cl) : null;
    }
    if (total && i.expected && total !== i.expected) throw new Error(`The file size on the server differs (${total} ≠ ${i.expected}); the catalog may be outdated.`);
    if (total && !i.expected) i.expected = total;
    const disk = diskStatus(this.modelRoot);
    if (i.expected && disk.freeByte !== null && disk.freeByte < i.expected - startedAt + 2 ** 30) throw new Error(`Not enough disk space: ${gb(i.expected - startedAt)} more needed, ${gb(disk.freeByte)} free.`);

    const printer = createWriteStream(partial, { flags: startedAt > 0 ? 'a' : 'w' });
    i.downloaded = startedAt;
    let lastTime = Date.now();
    let lastDownloaded = startedAt;
    let lastRecord = Date.now();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        summaryHash.update(value);
        if (!printer.write(value)) await new Promise((ok) => printer.once('drain', ok));
        i.downloaded += value.length;
        const now = Date.now();
        if (now - lastTime >= 1000) {
          const instant = ((i.downloaded - lastDownloaded) * 1000) / (now - lastTime);
          i.speed = i.speed ? i.speed * 0.7 + instant * 0.3 : instant;
          lastTime = now;
          lastDownloaded = i.downloaded;
          this.changed();
        }
        if (now - lastRecord >= 5000) {
          lastRecord = now;
          this.save();
        }
      }
    } finally {
      await new Promise((ok) => printer.end(ok));
    }
    if (signal.aborted) return;
    const size = statSync(partial).size;
    if (i.expected && size !== i.expected) throw new Error(`Size mismatch: ${size} bytes downloaded, ${i.expected} expected. "Resume" will complete it.`);
    const summary = summaryHash.digest('hex');
    if (i.sha256 && summary !== i.sha256) {
      rmSync(partial, { force: true });
      i.downloaded = 0;
      throw new Error(`SHA-256 mismatch (corrupt download); the partial file was deleted, download again.`);
    }
    i.validated = summary;
    renameSync(partial, target);
    i.status = 'done';
    i.end = new Date().toISOString();
    i.downloaded = size;
    this.log(`Downloaded: ${i.folder}/${i.file} (${gb(size)}${i.sha256 ? ', SHA-256 verified' : ''})`);
  }
}

function gb(b) {
  return `${(b / 2 ** 30).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB`;
}
/**
 * Hugging Face dosyasinin SHA-256'si: yonlendirmeden ONCEKI yanitin X-Linked-ETag basligi.
 * Yonlendirilen CDN'in (Xet) etag'i de 64 onaltilik ama Xet ozetidir, SHA-256 degil; ona
 * guvenince saglam 10 GB'lik dosya "SHA-256 uyusmuyor" ile siliniyordu. Yoksa null.
 */
async function connectionSummary(url, signal) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: signal });
    const e = (r.headers.get('x-linked-etag') ?? '').replace(/"/g, '').replace(/^W\//, '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(e) ? e : null;
  } catch {
    return null;
  }
}
