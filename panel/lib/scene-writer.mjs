/**
 * Scene list from a topic (Film): the local text model (Gemma; lib/text-model.mjs) writes a JSON object:
 * { title, scenes: [{ narration, image, motion }] }. Only the panel's own models are used (07.10.2026). Without an
 * installed text model the feature appears disabled.
 * Called from the interface: while an image/video job runs it waits until the graphics card is free (shown in the queue, can be cancelled).
 */
import { UserError } from './errors.mjs';
import { runText, hasText } from './text-model.mjs';
import { GENDERS, TYPES, AGES, nameKey, normalizeGender, normalizeAge, normalizeType } from './characters.mjs';

// Istem Ingilizce, uretilen metin (baslik, anlatim, replikler) Turkce. Alan adlari ve cinsiyet/yas/tur degerleri
// Ingilizce istenir; model yine de Turkce yazarsa sahneYanitiniCoz ic degere cevirir (karakterler.mjs normalize*).
// The spoken and shown text (title, narration, lines) is written in the film's language (lang: tr | en, the voice language).
const LANGUAGES = { tr: 'Turkish', en: 'English' };
const SYSTEM_BASE = [
  'You are a scene writer for short narrated films. Return only the requested JSON object; no explanation, markdown or code block.',
  '- title: {L}, at most 60 characters.',
  '- image: ENGLISH, detailed image prompt (subject, setting, light, camera angle, style). Keep characters and style the same in every scene: describe the appearance of the character again with the same words in every scene. Do not ask for text in the image.',
];
// Yalniz anlatim (tek ses) ya da karakterlerin de konustugu yazim. 07.10.2026 kullanici: "karakterleri disi-erkek
// farkini gozeterek konusturmak da lazim, sadece hikaye anlatan tek ses gibi degil".
const SYSTEM = [
  ...SYSTEM_BASE,
  'Format: {"title": "...", "scenes": [{"narration": "...", "image": "...", "motion": "..."}]}',
  '- narration: {L} voice-over text, 1-3 sentences, at most 220 characters; the scenes should tell one story that flows together.',
  '- motion: ENGLISH, short motion prompt; describe the motion and camera movement that will happen, not what is in the image.',
].join('\n');
const SYSTEM_DIALOG = [
  ...SYSTEM_BASE,
  'Format: {"title": "...", "characters": [{"name": "...", "gender": "female|male", "age": "child|young|adult|old", "type": "human|animal", "spec": "..."}], "scenes": [{"narration": "...", "dialogue": [{"who": "...", "text": "..."}], "image": "...", "motion": "..."}]}',
  // 07.10.2026 olculdu: Gemma tarife gorunusu de yaziyordu ("yellow raincoat ... high-pitched voice"); tarif ses tasariminda kullanilir
  '- characters: the SPEAKING characters in the story (not the narrator); gender and age must be correct for voice selection and use exactly these English values. spec: ENGLISH, VOICE description ONLY, at most 8 words; do NOT write appearance such as clothes, hair, color (example: "soft and shy", "deep and calm", "squeaky and playful"). Talking animals are characters too (type: animal; humans type: human); an animal is not an object or a toy.',
  '- narration: {L} narrator text, 1-2 sentences, at most 180 characters; in a scene with dialogue it may be short or empty.',
  "- dialogue: the characters' {L} lines, 0-3 short lines per scene (each at most 100 characters); who is a name from the characters list. Let the characters speak at the important moments of the story.",
  // 07.10.2026 kullanici: "Konusurken yuzu donmus olmali diger karaktere, bosluga konusuyor gibi olmamali" (ilk denemede
  // ikisi de kameraya bakip poz veriyordu)
  // 07.10.2026 kullanici: "Gozler de karsiya degil konustuguna bakmali"
  '- image (in a scene with dialogue): speaking characters face each other, half profile; their EYES look at each other (eye contact); they must not look at the camera or straight ahead. If a character is calling to someone outside the frame, their face and eyes should be turned that way.',
  '- motion: ENGLISH, short motion prompt; describe the motion and camera movement that will happen. The speaking character should turn to the listener and talk looking into their eyes, and the listener should look back at them (example: "the girl turns to her father and talks to him, looking into his eyes; he looks down at her and answers"); nobody talks to the camera.',
].join('\n');
const systemFor = (speech, lang) => (speech ? SYSTEM_DIALOG : SYSTEM).replaceAll('{L}', LANGUAGES[lang] ?? LANGUAGES.tr);

/**
 * The answer's shape as a JSON schema: llama-server writes only what fits it (a grammar), so a scene can no longer
 * come back broken or outside the list (10.10.2026: one answer in three was unreadable).
 */
export function sceneSchema(speech, sceneCount) {
  const str = { type: 'string' };
  const scene = { narration: str, image: str, motion: str, ...(speech ? { dialogue: { type: 'array', items: { type: 'object', properties: { who: str, text: str }, required: ['who', 'text'] } } } : {}) };
  const character = { name: str, gender: { enum: Object.keys(GENDERS) }, age: { enum: Object.keys(AGES) }, type: { enum: Object.keys(TYPES) }, spec: str };
  return {
    type: 'object',
    properties: {
      title: str,
      ...(speech ? { characters: { type: 'array', items: { type: 'object', properties: character, required: Object.keys(character) } } } : {}),
      scenes: { type: 'array', minItems: sceneCount, maxItems: sceneCount, items: { type: 'object', properties: scene, required: Object.keys(scene) } },
    },
    required: ['title', ...(speech ? ['characters'] : []), 'scenes'],
  };
}

/**
 * Model yanitindan JSON nesnesini cikarir ve dogrular. Karakter: cinsiyeti gecerliyse (yas yoksa yetiskin);
 * replik: konusan karakter listede olmali (yoksa atilir). Doner: { baslik, sahneler, karakterler (yalniz konusanlar) }.
 */
export function parseSceneResponse(text, sceneCount) {
  const s = String(text ?? '');
  const startedAt = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (startedAt < 0 || last <= startedAt) throw new UserError('The scene writer did not return a valid answer; try again.');
  let data;
  try {
    data = JSON.parse(s.slice(startedAt, last + 1));
  } catch {
    throw new UserError("Could not read the scene writer's answer; try again.");
  }
  const cut = (v, n) => String(v ?? '').trim().slice(0, n);
  // Modelin yazimi Turkce ("kadın", "Çocuk", "dişi", "yavru", "hayvan") ya da Ingilizce olabilir: ic deger Ingilizce anahtar
  const characters = [];
  for (const x of Array.isArray(data?.characters) ? data.characters : []) {
    const type = x?.type ? normalizeType(cut(x.type, 12)) : '';
    const k = { name: cut(x?.name, 40), gender: normalizeGender(cut(x?.gender, 12)), age: normalizeAge(cut(x?.age, 12)), ...(TYPES[type] ? { type } : {}), spec: cut(x?.spec, 300) };
    if (!k.name || !GENDERS[k.gender] || characters.some((y) => nameKey(y.name) === nameKey(k.name))) continue;
    if (!AGES[k.age]) k.age = 'adult';
    characters.push(k);
  }
  const names = new Map(characters.map((k) => [nameKey(k.name), k.name]));
  const scenes = (Array.isArray(data?.scenes) ? data.scenes : [])
    .map((x) => {
      const dialogue = (Array.isArray(x?.dialogue) ? x.dialogue : [])
        .map((r) => ({ who: names.get(nameKey(r?.who)), text: cut(r?.text, 300) }))
        .filter((r) => r.who && r.text)
        .slice(0, 6);
      return { narration: cut(x?.narration, 1500), image: cut(x?.image, 2000), motion: cut(x?.motion, 1000), ...(dialogue.length ? { dialogue } : {}) };
    })
    .filter((x) => (x.narration || x.dialogue) && x.image)
    .slice(0, Math.max(1, sceneCount ?? 20));
  if (!scenes.length) throw new UserError('The scene writer produced no scenes; describe the topic in more detail.');
  const speaker = new Set(scenes.flatMap((x) => (x.dialogue ?? []).map((r) => nameKey(r.who))));
  return { title: cut(data?.title, 80), scenes, characters: characters.filter((k) => speaker.has(nameKey(k.name))) };
}

/** Bir obekte en cok bu kadar sahne istenir; uzun filmler obek obek yazilir. */
export const CHUNK = 15;

export function scenePrompt({ topic, sceneCount, ratio, startedAt = 1, total = sceneCount, previous = [], title = '', characters = [] }) {
  const lines = [`Topic: ${topic}`, `Format: ${ratio === '9:16' ? 'portrait 9:16 (phone)' : 'landscape 16:9'}`];
  // Obekler arasinda karakterler (ad, cinsiyet, yas) ayni kalir: ayni karakter ayni sesle konusur
  if (characters.length) lines.push(`Characters (use them as they are; add new characters if needed): ${characters.map((k) => `${k.name} (${k.gender}, ${k.age}${k.type === 'animal' ? ', animal' : ''})`).join(', ')}`);
  if (total > sceneCount) {
    lines.push(`A film of ${total} scenes in total; in this request write only scenes ${startedAt} to ${startedAt + sceneCount - 1} (${sceneCount} scenes).`);
    if (title) lines.push(`Film title (keep it the same): ${title}`);
    if (previous.length) lines.push(`Last narrations of the previous scenes (continue, do not repeat):\n${previous.map((a) => `- ${a}`).join('\n')}`);
    if (startedAt + sceneCount - 1 >= total) lines.push('This is the last chunk: end the story here.');
    else lines.push('Do not end the story; the next chunk will continue.');
  } else lines.push(`Scene count: ${sceneCount}`);
  lines.push('Return the JSON object.');
  return lines.join('\n');
}

/**
 * Yerel yazi modeliyle sahneleri yazar; OBEK'ten cok sahne obek obek (onceki anlatimlarla baglanti kurularak).
 * ilerleme({ yazilan, toplam }) her obekten once ve sonunda; sinyal (Kuyruk'taki Iptal) istegi keser;
 * bekliyor(true|false): panelde is calisirken ekran karti bekleniyor.
 */
export async function writeScenes({ topic, sceneCount, ratio, speech = true, lang = 'tr', chunk = CHUNK, progress = () => {}, signal = null, waiting = null }) {
  if (!hasText()) throw new UserError('The text model is not installed; write the scenes yourself.');
  const system = systemFor(speech, lang);
  if (sceneCount <= chunk) return singleChunk({ system, prompt: scenePrompt({ topic, sceneCount, ratio }), sceneCount, speech, signal, waiting });
  const scenes = [];
  const characters = [];
  let title = '';
  for (let startedAt = 1; startedAt <= sceneCount; startedAt += chunk) {
    const count = Math.min(chunk, sceneCount - startedAt + 1);
    progress({ written: scenes.length, total: sceneCount });
    const prompt = scenePrompt({ topic, sceneCount: count, ratio, startedAt, total: sceneCount, previous: scenes.slice(-3).map((s) => s.narration || (s.dialogue ?? []).map((r) => r.text).join(' ')), title, characters });
    const r = await singleChunk({ system, prompt, sceneCount: count, speech, signal, waiting });
    if (!title) title = r.title;
    scenes.push(...r.scenes);
    for (const k of r.characters) if (!characters.some((y) => nameKey(y.name) === nameKey(k.name))) characters.push(k);
  }
  progress({ written: scenes.length, total: sceneCount });
  return { title, scenes, characters };
}

function singleChunk({ system, prompt, sceneCount, speech, signal = null, waiting = null }) {
  // Yaratici yazi (sicaklik 0.7); 15 sahne ~3.500 token (repliklerle daha cok). The schema keeps the answer to the scene list.
  return runText({ system, prompt, json: true, schema: sceneSchema(speech, sceneCount), temperature: 0.7, maxToken: 8192, externalRequest: true, signal, waiting, name: 'Scene writer', parse: (text) => parseSceneResponse(text, sceneCount) });
}
