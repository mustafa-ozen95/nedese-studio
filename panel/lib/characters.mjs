/**
 * Karakter sesleri (Tek parca diyalog): anlaticinin yaninda karakterler kendi sesiyle, cinsiyetine ve yasina uygun
 * konusur. 07.10.2026 kullanici: "karakterleri disi-erkek farkini gozeterek konusturmak da lazim, sadece hikaye anlatan
 * tek ses gibi degil".
 * - konusmaAyir: sahnenin replikleri ("Ad: soz" satirlari ya da [{ kim, metin }])
 * - karakterleriDogrula: [{ ad, cinsiyet, yas, tarif?, ses? }]; konusan her ad listede olmali (cinsiyet sart)
 * - sesNiteligi: kutuphane sesinin cinsiyet/yasi (json'da yoksa ad/tarif/aciklama sozcuklerinden)
 * - sesSec: karaktere uygun kutuphane sesi; yoksa null (karakterin tarifinden yeni ses tasarlanir)
 * - tasarimTarifi: cinsiyet/yas/tariften Ingilizce ses tarifi (VoxCPM2 ses tasarimi)
 */
import { UserError } from './errors.mjs';

export const GENDERS = { female: 'Female', male: 'Male' };
export const AGES = { child: 'Child', young: 'Young', adult: 'Adult', old: 'Elderly' };
// Tur: konusan hayvan insan sesiyle konusmasin. 07.10.2026 kullanici (kedi Pamuk, "kiz cocugu" tarifiyle tasarlanan ses
// 494 Hz, Elif 445-513 Hz): "Kedi mi konusuyor Elif mi, karismis".
export const TYPES = { human: 'Human', animal: 'Animal' };

// Ic degerler Ingilizce anahtar (female/male, child/young/adult/old, human/animal). Yazi modeli (Gemma), eski is kayitlari
// ve kutuphane json'lari ayni alani Turkce ("kadın", "çocuk", "hayvan") ya da esanlamliyla ("dişi", "yavru", "boy") yazabilir:
// hepsi ic degere cevrilir; bilinmeyen sozcuk kucuk harfle oldugu gibi kalir (dogrulama onu reddeder).
const ascii = (v) => String(v ?? '').trim().toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ö/g, 'o').replace(/ü/g, 'u');
const GENDER_WORDS = { female: 'female', woman: 'female', girl: 'female', kadin: 'female', disi: 'female', kiz: 'female', male: 'male', man: 'male', boy: 'male', erkek: 'male', oglan: 'male' };
const AGE_WORDS = { child: 'child', kid: 'child', cub: 'child', cocuk: 'child', yavru: 'child', young: 'young', teen: 'young', genc: 'young', adult: 'adult', yetiskin: 'adult', old: 'old', elderly: 'old', yasli: 'old' };
const TYPE_WORDS = { human: 'human', person: 'human', insan: 'human', animal: 'animal', hayvan: 'animal' };
export const normalizeGender = (v) => GENDER_WORDS[ascii(v)] ?? ascii(v);
export const normalizeAge = (v) => AGE_WORDS[ascii(v)] ?? ascii(v);
export const normalizeType = (v) => TYPE_WORDS[ascii(v)] ?? ascii(v);

// Tur yazilmamissa (eski girdi) tariften: "a tiny playful kitten" -> hayvan
const ANIMAL_WORD = /\b(kitten|kitty|cat|puppy|dog|bunny|rabbit|bird|parrot|owl|fox|bear|cub|mouse|squirrel|duck|duckling|chick|frog|lion|tiger|horse|pony|monkey|penguin|dragon|animal)s?\b|kedi|köpek|tavşan|kuş|tilki|sincap|ördek|civciv|kurbağa|aslan|kaplan|maymun|penguen|ejderha|hayvan/;
export function findType(x) {
  const type = x?.type ? normalizeType(x.type) : '';
  if (TYPES[type]) return type;
  return ANIMAL_WORD.test(String(x?.spec ?? '').toLocaleLowerCase('tr')) ? 'animal' : 'human';
}
export const SCENE_LINE_MAX = 12;

const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** Karakter adi karsilastirma anahtari (buyuk/kucuk harf, bosluk duyarsiz). */
export const nameKey = (name) => clean(name, 40).toLocaleLowerCase('tr');

/**
 * Ses perdesi (F0 ortancasi, Hz) araliklari; seslendirmeden sonra olculen perde bununla karsilastirilir, gunluge yazilir.
 * Olculdu 07.10.2026 (gercek diyalog filmi): erkek anlatici 90-94, yetiskin erkek karakter 110; tasarlanan kiz cocugu
 * 445 (normal) - 513 (seslenirken), kedi 494 Hz. Cocukta ust sinir genis (heyecanli satir yuksek); asil denetim alt sinir:
 * cocuga/kadina kalin ses verilmesi.
 */
const PITCH_RANGE = { child: [200, 600], female: [150, 350], male: [70, 175] };
export function pitchRange(character) {
  // Hayvan karakterin perdesi serbest (cizgi film hayvani)
  if (character.type === 'animal') return null;
  return character.age === 'child' ? PITCH_RANGE.child : PITCH_RANGE[character.gender] ?? null;
}
/** Gunluk eki: " (in range)" ya da " (deeper/higher than expected; A-B Hz expected)". */
export function pitchFit(character, f0) {
  const a = pitchRange(character);
  if (!a || !Number.isFinite(f0)) return '';
  if (f0 < a[0]) return ` (deeper than expected; ${a[0]}-${a[1]} Hz expected)`;
  if (f0 > a[1]) return ` (higher than expected; ${a[0]}-${a[1]} Hz expected)`;
  return ' (in range)';
}

/**
 * Sahnenin replikleri. Metin: her dolu satir "Ad: söz" (iki nokta ilk ayirac). Dizi: [{ kim, metin }].
 * Doner: [{ kim, metin }] (bos girdi: []). sahne: hata mesajindaki sahne numarasi.
 */
export function splitSpeech(input, scene = null) {
  if (input === undefined || input === null || input === '') return [];
  const place = scene ? `Scene ${scene}: ` : '';
  let list;
  if (Array.isArray(input)) {
    list = input.map((x) => ({ who: clean(x?.who, 40), text: clean(x?.text, 300) }));
  } else {
    list = String(input)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s, i) => {
        const m = s.match(/^([^:]{1,40}):\s*(.+)$/);
        if (!m) throw new UserError(`${place}dialogue line ${i + 1} must be in the form "Name: words" ("${s.slice(0, 40)}").`);
        return { who: clean(m[1], 40), text: clean(m[2], 300) };
      });
  }
  if (list.some((x) => !x.who || !x.text)) throw new UserError(`${place}every line must have the speaker's name and words.`);
  if (list.length > SCENE_LINE_MAX) throw new UserError(`${place}at most ${SCENE_LINE_MAX} lines.`);
  return list;
}

/**
 * Karakter listesi; konusanlar (butun sahnelerin kim'leri) listede olmali. ses: '' (kendiliginden) ya da 'ref:<kimlik>'.
 * Doner: [{ ad, cinsiyet, yas, tur, tarif, ses }] (yalniz konusanlar ve listedekiler; ayni ad bir kez).
 */
export function validateCharacters(input, speakers = []) {
  const raw = Array.isArray(input) ? input : [];
  if (raw.length > 50) throw new UserError('At most 50 characters.');
  const result = [];
  const seen = new Set();
  for (const x of raw) {
    const name = clean(x?.name, 40);
    if (!name) continue;
    const key = nameKey(name);
    if (seen.has(key)) throw new UserError(`Character "${name}" is listed twice.`);
    seen.add(key);
    const gender = normalizeGender(x?.gender);
    if (!GENDERS[gender]) throw new UserError(`Select a gender for "${name}" (female or male): the voice is chosen accordingly.`);
    const age = normalizeAge(x?.age) || 'adult';
    if (!AGES[age]) throw new UserError(`Age for "${name}" must be one of: ${Object.keys(AGES).join(', ')}.`);
    const voice = String(x?.voice ?? '').trim();
    if (voice && !/^ref:[a-z0-9][a-z0-9_-]{0,80}$/.test(voice)) throw new UserError(`A voice must be selected from the library for "${name}".`);
    const type = x?.type ? normalizeType(x.type) : '';
    if (type && !TYPES[type]) throw new UserError(`Type for "${name}" must be one of: ${Object.keys(TYPES).join(', ')}.`);
    const spec = clean(x?.spec, 300);
    result.push({ name, gender, age, type: findType({ type, spec }), spec, voice });
  }
  for (const who of speakers) {
    if (!seen.has(nameKey(who))) throw new UserError(`"${who}" speaks: add it to the Characters list and select its gender.`);
  }
  return result;
}

/** Adla karakter (buyuk/kucuk harf duyarsiz). */
export function findCharacter(characters, name) {
  const a = nameKey(name);
  return characters.find((k) => nameKey(k.name) === a) ?? null;
}

/**
 * Kutuphane sesinin cinsiyet/yasi: json alanlari (karakter sesi tasarlaninca yazilir) yoksa ad + tarif + aciklama.
 * Doner: { cinsiyet: 'kadin'|'erkek'|null, yas }.
 */
export function voiceAttribute(voice) {
  const gender0 = normalizeGender(voice?.gender);
  const age0 = normalizeAge(voice?.age);
  if (GENDERS[gender0] && AGES[age0]) return { gender: gender0, age: age0 };
  const m = `${voice?.name ?? ''} ${voice?.spec ?? ''} ${voice?.description ?? ''}`.toLocaleLowerCase('tr');
  const female = /\b(woman|women|female|girl|lady|mother|grandmother|actress)\b|kadın|kız|anne|nine|teyze|hanım/.test(m);
  const male = /\b(man|men|male|boy|gentleman|father|grandfather|baritone)\b|erkek|adam|dede|amca|baba|bariton/.test(m);
  const gender = female === male ? null : female ? 'female' : 'male';
  const ageCount = Number(m.match(/\b(\d{1,2})[- ]year[- ]old\b/)?.[1] ?? NaN);
  let age = 'adult';
  if ((Number.isFinite(ageCount) && ageCount <= 12) || /\b(child|kid|little girl|little boy)\b|çocu/.test(m)) age = 'child';
  else if (/\b(elderly|old (man|woman|lady)|very old|seventies|eighties|nineties|grandfather|grandmother)\b|yaşlı|dede|nine/.test(m)) age = 'old';
  else if (/\b(young|teen|teenage|teenager|twenties)\b|genç/.test(m)) age = 'young';
  return { gender, age };
}

/**
 * Karaktere kutuphaneden ses: once ayni adla tasarlanmis ses (dizi boyunca ayni ses), sonra cinsiyet + yas uyan ses.
 * Anlaticinin sesi, kendi kaydi ve LoRA'li sesler (satir basina degismez) secilmez; kullanilan: bu filmde baska karaktere verilenler.
 * Doner: kutuphane kaydi ya da null.
 */
export function selectVoice({ character, voices, used = new Set(), narratorId = null }) {
  // Hayvana yalniz hayvan icin tasarlanmis ses (kutuphanede tur: hayvan), insana hayvan sesi verilmez
  const type = character.type ?? 'human';
  // Eski karakter tasarimlari (masal metni + "neseli" tarif, yansiz degil) verilmez: tonlamalari her replige geciyordu
  // (07.10.2026 olculdu). Karakter icin tasarlanmamis kutuphane sesleri (anlatici, EMA...) secilebilir.
  const candidates = voices.filter((s) => s.id !== narratorId && !used.has(s.id) && !s.ownVoice && !s.trained && (s.type ? normalizeType(s.type) : 'human') === type && (!s.character || s.neutral));
  const sameName = candidates.find((s) => s.character && nameKey(s.character) === nameKey(character.name) && voiceAttribute(s).gender === character.gender);
  if (sameName) return sameName;
  return candidates.find((s) => {
    const n = voiceAttribute(s);
    return n.gender === character.gender && n.age === character.age;
  }) ?? null;
}

// Yalniz tini (yas, cinsiyet, ses rengi): duygu sifati yok. Duygu replik basina yonetmen notundan gelir; tasarimdaki
// "cheerful" her replige nese tasiyordu (07.10.2026 olculdu, kullanici: "Pamuk nerdesin diyor ama guluyor").
const BASE_SPEC = {
  female: {
    child: 'A little girl about 8 years old with a bright, high-pitched child voice',
    young: 'A young woman in her early twenties with a light, clear voice',
    adult: 'An adult woman in her late thirties with a clear, natural voice',
    old: 'An old woman in her seventies with a soft, slightly shaky voice',
  },
  male: {
    child: 'A little boy about 8 years old with a bright, high child voice',
    young: 'A young man in his early twenties with a clear voice',
    adult: 'An adult man in his forties with a medium-deep voice',
    old: 'An old man in his seventies with a deep, slightly raspy voice',
  },
};

// Hayvan: insan cocugu tarifi verilmez (once "little girl about 8 years old" + "kitten" kiz sesi uretti)
const ANIMAL_SPEC = {
  child: 'A tiny cartoon animal character from an animated film, not a human child: a very high, squeaky voice with a light nasal tone',
  young: 'A young cartoon animal character from an animated film, not a human: a bright, quick voice',
  adult: 'A cartoon animal character from an animated film, not a human: a characterful, slightly gravelly voice',
  old: 'An old cartoon animal character from an animated film, not a human: a slow, croaky voice',
};

// Karakter tarifindeki ruh hali / kisilik sozcukleri tasarima girmez (sahne yazari "sweet and cheerful" yaziyor); tini
// sozcukleri (squeaky, deep, raspy, high-pitched...) kalir.
// Sozcuk siniri Unicode harfe gore (JS'te \b Turkce harfi sozcuk saymaz: "tatlı")
const word = (list) => new RegExp(`(?<![\\p{L}\\p{N}])(${list})(?![\\p{L}\\p{N}])`, 'giu');
const MOOD_STATE = word('cheerful|happy|joyful|sad|angry|excited|playful|calm|reassuring|sweet|kind|warm|friendly|lively|confident|cute|gentle|serious|grumpy|mischievous|brave|shy|curious|caring|loving|energetic|neşeli|mutlu|sakin|tatlı|sevimli|oyuncu|şefkatli|nazik');
const CONJUNCTION = word('and|ve|ile');
export function fromTimbreSpec(spec) {
  return String(spec ?? '')
    .replace(MOOD_STATE, ' ')
    .replace(CONJUNCTION, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,(\s*,)+/g, ',')
    .replace(/(^[\s,;]+|[\s,;]+$)/g, '')
    .replace(/\s+,/g, ',');
}

/** Karakterin ses tarifi (Ingilizce; VoxCPM2 tasarimi Turkce, yansiz gundelik metinle okur). */
export function designSpec(character) {
  const base = character.type === 'animal'
    ? `${ANIMAL_SPEC[character.age] ?? ANIMAL_SPEC.adult}, ${character.gender === 'male' ? 'male' : 'female'}`
    : BASE_SPEC[character.gender]?.[character.age] ?? BASE_SPEC[character.gender]?.adult;
  const timbre = fromTimbreSpec(character.spec);
  return `${base}${timbre ? `; ${timbre}` : ''}; neutral, natural conversational tone, even and clear`;
}
