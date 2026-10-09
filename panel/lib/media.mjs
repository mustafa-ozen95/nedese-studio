/**
 * Measurements read from the file header (no dependencies): WAV duration, image size.
 * ffprobe is the fallback; when the header cannot be read, the caller falls back to ffprobe.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function readStart(path, byte) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(byte);
    const n = readSync(fd, buffer, 0, byte, 0);
    return buffer.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** The WAV (RIFF) duration in seconds; null when it cannot be read. */
export function wavDuration(path) {
  const b = readStart(path, 1 << 16);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let i = 12;
  let byteRate = null;
  while (i + 8 <= b.length) {
    const name = b.toString('ascii', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (name === 'fmt ') byteRate = b.readUInt32LE(i + 16);
    if (name === 'data') {
      if (!byteRate) return null;
      // some writers leave the data size at 0/0xFFFFFFFF: worked out from the file size.
      const data = size === 0 || size === 0xffffffff ? statSync(path).size - (i + 8) : size;
      return data / byteRate;
    }
    i += 8 + size + (size % 2);
  }
  return null;
}

/**
 * JPEG size: the segments are read from the file by offset up to the SOF. A fixed piece from the start of the file was
 * not enough: valid JPEGs with a big ICC/IRB or XMP segment before the SOF (portraits, professional) counted as unreadable.
 */
function jpegSize(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const t = Buffer.alloc(9);
    let i = 2;
    while (i + 4 <= size) {
      if (readSync(fd, t, 0, 4, i) < 4) return null;
      if (t[0] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = t[1];
      if (marker === 0xff) {
        i += 1; // padding
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        i += 2; // markers without a length
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return null; // image data or the end: no SOF found
      // SOF0..SOF15 (DHT=C4, JPG=C8, DAC=CC haric)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (readSync(fd, t, 0, 9, i) < 9) return null;
        return { height: t.readUInt16BE(5), width: t.readUInt16BE(7) };
      }
      i += 2 + t.readUInt16BE(2);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** PNG / JPEG / WebP boyutu: { en, boy }. Okunamazsa null. */
export function imageSize(path) {
  const b = readStart(path, 64);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const raw = jpegSize(path);
    if (!raw) return null;
    // EXIF 5-8: 90 derece donuk saklanmis (telefon dik cekim); gorunen en/boy yer degistirir.
    return exifOrientation(path) >= 5 ? { width: raw.height, height: raw.width } : raw;
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const type = b.toString('ascii', 12, 16);
    if (type === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (type === 'VP8L') {
      const v = b.readUInt32LE(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
    if (type === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/**
 * The JPEG EXIF orientation (Orientation 1-8; 1 upright, 2 mirrored, 3 upside down, 6/8 shot vertically...). 1 when
 * missing or not a JPEG. A phone photo keeps its pixels unturned; the orientation is only in this tag.
 */
export function exifOrientation(path) {
  const b = readStart(path, 1 << 17);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) break; // SOS: the image data has started
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xe1 && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      const t = i + 10;
      if (t + 8 > b.length) return 1;
      const le = b.toString('latin1', t, t + 2) === 'II';
      const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
      const ifd = t + (le ? b.readUInt32LE(t + 4) : b.readUInt32BE(t + 4));
      if (ifd + 2 > b.length) return 1;
      for (let k = 0, n = u16(ifd); k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > b.length) break;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** Orientation: 'landscape' | 'portrait' | 'square'. */
export function orientation({ width, height }) {
  const ratio = width / height;
  if (ratio > 1.15) return 'landscape';
  if (ratio < 0.87) return 'portrait';
  return 'square';
}

/** A flat colour PNG (for tests and placeholders). */
export function makePng(width, height, [r, g, bl] = [40, 120, 200]) {
  const line = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    line[1 + x * 3] = r;
    line[2 + x * 3] = g;
    line[3 + x * 3] = bl;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => line));
  const part = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    part('IHDR', ihdr),
    part('IDAT', deflateSync(raw)),
    part('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE;
function crc32(b) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** A 16 bit mono WAV (sine): the fake voice-over output in tests. */
export function makeWav(second, { hz = 220, sampling = 24000 } = {}) {
  const n = Math.round(second * sampling);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampling) * 8000), i * 2);
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data.length, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampling, 24);
  b.writeUInt32LE(sampling * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data.length, 40);
  return Buffer.concat([b, data]);
}
