/**
 * The voice library: the WAVs that are cloning references (<ai>\voice\references).
 * Each voice is two files: <id>.wav + <id>.json ({ name, description, spec, creation }).
 * The panel writes only the voices it added itself to this folder; deleting happens only here too.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { wavDuration } from './media.mjs';
import { UserError } from './errors.mjs';

const ID = /^[a-z0-9][a-z0-9_-]{0,80}$/;

export function listVoices(library) {
  if (!existsSync(library)) return [];
  return readdirSync(library)
    .filter((d) => d.toLowerCase().endsWith('.wav'))
    .map((d) => {
      const id = d.slice(0, -4);
      let info = {};
      try {
        info = JSON.parse(readFileSync(join(library, `${id}.json`), 'utf8'));
      } catch {
        /* a WAV without info: its name is the file name */
      }
      let duration = null;
      try {
        duration = wavDuration(join(library, d));
      } catch {
        /* */
      }
      const lora = info.lora && existsSync(join(library, info.lora)) ? info.lora : null;
      return {
        id,
        name: info.name ?? id,
        description: info.description ?? '',
        spec: info.spec ?? '',
        creation: info.creation ?? null,
        duration,
        // An own voice (cloned from a recording): the reference text for a full clone, lora a trained model.
        ownVoice: Boolean(info.ownVoice),
        // The narrator used when no voice is chosen (Voice, Film, API).
        defaultValue: Boolean(info.defaultValue),
        trained: Boolean(lora),
        speechSec: info.speechSec ?? null,
        // A character voice (film dialogue): written while it is designed; old voices lack it (read from the name/description)
        gender: info.gender ?? null,
        age: info.age ?? null,
        character: info.character ?? null,
        // "animal": designed for an animal character (never picked for a human character; an animal gets only these)
        type: info.type ?? null,
        // A character voice designed with a neutral text (the emotion comes per line); the old cheerful designs are not given to a character
        neutral: Boolean(info.neutral),
        // "ema": EMA Lightning (one voice, no cloning); its lines are read with voice\ema
        engine: info.engine ?? null,
        // the id of a library voice whose timbre the takes get (voice\convert.py), e.g. EMA in a male narrator's voice
        timbre: info.timbre ?? null,
        // the pace an EMA voice reads at (voicePace)
        speed: voicePace(info),
      };
    })
    .filter((s) => ID.test(s.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

/** The library voice marked as default ("ref:<id>"); otherwise the model's own voice. */
export function defaultVoice(library) {
  const s = listVoices(library).find((x) => x.defaultValue);
  return s ? `ref:${s.id}` : 'model';
}

export function voicePath(library, id) {
  if (!ID.test(String(id))) return null;
  const path = resolve(library, `${id}.wav`);
  if (!path.startsWith(resolve(library) + sep)) return null;
  return existsSync(path) ? path : null;
}

export function generateVoiceId(name) {
  const tr = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u' };
  const root = String(name ?? 'voice')
    .toLowerCase()
    .replace(/[çğıİöşü]/g, (h) => tr[h])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${root || 'voice'}-${randomBytes(2).toString('hex')}`;
}

/** Copies the WAV into the library (the source must already be 24 kHz mono). Returns the id; extra goes into the json. */
export function addVoice(library, { name, source, description = '', spec = '', extra = {} }) {
  mkdirSync(library, { recursive: true });
  const id = generateVoiceId(name);
  copyFileSync(source, join(library, `${id}.wav`));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({ name, description, spec, ...extra, creation: new Date().toISOString(), panel: 1 }, null, 1), 'utf8');
  return id;
}

/** The voice's info file ({ name, referenceText, lora, ... }); {} when there is none. */
export function voiceInfo(library, id) {
  if (!ID.test(String(id))) return {};
  try {
    return JSON.parse(readFileSync(join(library, `${id}.json`), 'utf8'));
  } catch {
    return {};
  }
}

export function updateVoiceInfo(library, id, fields) {
  const info = { ...voiceInfo(library, id), ...fields };
  writeFileSync(join(library, `${id}.json`), JSON.stringify(info, null, 1), 'utf8');
  return info;
}

/** The WAV of the voice whose timbre a voice's takes get (its info's timbre: a library id), or null. */
export function voiceTimbre(library, info) {
  if (!info?.timbre) return null;
  const path = voicePath(library, info.timbre);
  if (!path) throw new UserError(`The voice "${info.name ?? ''}" takes the timbre of "${info.timbre}", which is not in the voice library.`);
  return path;
}

/** The pace an EMA voice reads at (its info's speed, 0.7-1.3; EMA's own speed setting), or null. */
export function voicePace(info) {
  const n = Number(info?.speed);
  return info?.engine === 'ema' && n >= 0.7 && n <= 1.3 && n !== 1 ? n : null;
}

/** The trained LoRA folder (library\<id>.lora) or null. */
export function voiceLoraPath(library, id) {
  const b = voiceInfo(library, id);
  if (!b.lora) return null;
  const path = resolve(library, b.lora);
  return path.startsWith(resolve(library) + sep) && existsSync(path) ? path : null;
}
