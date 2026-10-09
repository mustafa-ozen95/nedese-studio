/**
 * Sunucu tarafi iki dil: API istemcilerine (program, curl) yanit metinleri istenen dilde.
 *
 * Kaynak metinler Ingilizce; sozluk web\lang\dictionary.js (tarayici ile ORTAK dosya, en -> tr).
 * Tarayici arayuzu X-Panel-Lang: en gonderir ve metni kendisi cevirir (web\js\lang.js); program
 * istemcileri ?lang=en|tr, X-Panel-Lang ya da Accept-Language ile secer, varsayilan Ingilizce.
 */
import '../web/lang/dictionary.js';

const LANGUAGES = ['en', 'tr'];
const FIELDS = new Set(['error', 'message', 'stage', 'detail', 'note', 'group', 'name', 'description', 'log', 'reason']);

const full = new Map();
const patterns = [];
// English source text -> Turkish translation
for (const [en, tr] of Object.entries(globalThis.NedeseDictionary?.tr ?? {})) {
  if (/\{\d+\}/.test(en)) {
    const position = [];
    const pattern = en
      .split(/(\{\d+\})/)
      .map((p) => {
        const m = /^\{(\d+)\}$/.exec(p);
        if (m) {
          position.push(Number(m[1]));
          return '([\\s\\S]*?)';
        }
        return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    patterns.push({ re: new RegExp(`^${pattern}$`), position, tr, len: en.replace(/\{\d+\}/g, '').length, dot: en.includes(' · ') });
  } else {
    full.set(en, tr);
  }
}
patterns.sort((a, b) => b.len - a.len);

const HOUR = /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+)([\s\S]+)$/;

/** Ingilizce kaynak metni secilen dile cevirir (web\js\lang.js translate() ile ayni kurallar); 'en' aynen doner. */
export function translate(text, language = 'en', depth = 0) {
  if (language === 'en' || typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!trimmed || depth > 4) return text;
  const startedAt = text.slice(0, text.indexOf(trimmed));
  const last = text.slice(startedAt.length + trimmed.length);
  const find = (t) => {
    if (full.has(t)) return full.get(t);
    const hour = HOUR.exec(t);
    if (hour) {
      const back = find(hour[2]);
      return back === null ? null : hour[1] + back;
    }
    for (const k of patterns) {
      const m = k.re.exec(t);
      // A part caught across " · " belongs to the split below: "… (best) · 1280×720 · 5 s (2 parts)" matched
      // "{0} ({1} parts)" with {1} = "best) · … · 5 s (2" and stayed English (09.10.2026)
      if (!m || (!k.dot && m.slice(1).some((v) => v.includes(' · ')))) continue;
      const values = {};
      k.position.forEach((no, i) => {
        values[no] = translate(m[i + 1], language, depth + 1);
      });
      return k.tr.replace(/\{(\d+)\}/g, (_, no) => values[no] ?? '');
    }
    const split = (separator) => {
      const parts = t.split(separator);
      if (parts.length < 2) return null;
      const translated = parts.map((p) => (/^\s*$/.test(p) || separator.test?.(p) ? p : translate(p, language, depth + 1)));
      return translated.some((p, i) => p !== parts[i]) ? translated.join('') : null;
    };
    // Birlesik metin: satirlar, " · " ile dizilenler, " — " aciklamalar, cumleler ayri ayri.
    return split(/(\n)/) ?? split(/( · )/) ?? split(/( — )/) ?? split(/(?<=[.!?])(\s+)(?=\S)/);
  };
  const result = find(trimmed);
  return result === null ? text : startedAt + result + last;
}

/** Istegin dili: ?lang= > X-Panel-Lang > Accept-Language > en (kaynak dil). */
export function requestLanguage(req) {
  try {
    const q = new URL(req.url, 'http://x').searchParams.get('lang');
    if (LANGUAGES.includes(q)) return q;
  } catch {
    /* gecersiz url: basliklara bak */
  }
  const b = String(req.headers['x-panel-lang'] ?? '').toLowerCase();
  if (LANGUAGES.includes(b)) return b;
  const get = String(req.headers['accept-language'] ?? '').toLowerCase();
  const first = get.split(',')[0].trim();
  return first.startsWith('tr') ? 'tr' : 'en';
}

/** Yanit nesnesindeki insan metinlerini (hata, mesaj, asama, gunluk...) cevirir; kopya doner. */
export function translateData(data, language) {
  if (language === 'en') return data;
  const walk = (v, key) => {
    if (typeof v === 'string') return FIELDS.has(key) ? translate(v, language) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x, k);
      return o;
    }
    return v;
  };
  return walk(data, '');
}
