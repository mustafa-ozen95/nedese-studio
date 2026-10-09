/**
 * Turkish pronunciation fix: only the text that is read aloud (the written text does not change).
 * Proper names do not soften in writing (Kuzguncuk'u, Zonguldak'a) but do when read (Kuzguncuğu,
 * Zonguldağa); TTS saw the apostrophe and read them as written ("Kuzguncuku" - user report).
 * Rule: a suffix starting with a vowel + a name of several syllables: k -> ğ (g after n), p -> b, ç -> c.
 * Left alone: one syllable (Türk'ü), t (Ahmet'e, Kuveyt'e: the reading varies), foreign looking
 * (Facebook'u: w/x/q or oo/ee).
 */
const VOWEL = /[aeıioöuüâîû]/gi;

export function fixPronunciation(text) {
  return String(text ?? '').replace(/([A-Za-zÇĞİÖŞÜÂÎÛçğıöşüâîû]+)['’]([aeıioöuüâîû][a-zçğıöşüâîû]*)/g, (all, root, suffix) => {
    const last = root.slice(-1);
    if (!'kpç'.includes(last)) return all;
    if ((root.match(VOWEL) ?? []).length < 2) return all;
    if (/[wxq]|oo|ee/i.test(root)) return all;
    const fresh = last === 'k' ? (root.slice(-2, -1).toLowerCase() === 'n' ? 'g' : 'ğ') : last === 'p' ? 'b' : 'c';
    return `${root.slice(0, -1)}${fresh}${suffix}`;
  });
}
