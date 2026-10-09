/**
 * Ses isi: metni secilen sesle seslendirir (Chatterbox, ses\seslendir.bat). Ses "tarif" ise
 * once Qwen3-TTS ile tini tasarlanir, kutuphaneye eklenir ve referans olur.
 * GPU: ComfyUI ile ayni anda calismaz; once ComfyUI /free ile VRAM bosaltilir.
 */
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { QUALITY, text, prepareReference, voiceInput, speak } from './common.mjs';

export const name = 'Voice';

export function validate(g, { setting }) {
  return { text: text(g.text, 'Text', { max: 5000 }), ...voiceInput(g, setting) };
}

export function summary(g) {
  return { title: g.text, detail: `${QUALITY[g.quality]?.name ?? g.quality}${g.speed !== 1 ? ` · speed ${g.speed}×` : ''}` };
}

export async function run(ctx) {
  const g = ctx.job.input;
  await ctx.flushVoiceForGpu();
  const startedAt = Date.now();
  ctx.progress({ percent: 2, stage: 'Preparing voice' });
  const { reference, voiceName, referenceText, lora, engine, timbre, pace } = await prepareReference(ctx, g, ctx.folder);
  ctx.job.voiceName = voiceName;
  const result = await speak(ctx, {
    lines: [{ id: 'voice', text: g.text }],
    reference,
    referenceText,
    lora,
    engine,
    timbre,
    pace,
    select: g,
    folder: join(ctx.folder, 'narration'),
    progress: (ratio, detail) => ctx.progress({ percent: 5 + ratio * 93, stage: 'Voice-over', detail }),
  });
  const s = result.voice;
  // Cikti is klasorunun kokunde (galeri ve indirme icin).
  renameSync(s.path, join(ctx.folder, 'voice.wav'));
  ctx.addOutput({ file: 'voice.wav', type: 'voice', duration: Math.round(s.duration * 100) / 100, heard: s.heard, error: s.error });
  if (s.error != null) ctx.log(`Whisper transcript (error rate ${s.error}): ${s.heard}`);
  ctx.measure(`voice/${g.quality}`, ((Date.now() - startedAt) / 1000 / Math.max(1, g.text.length)) * 100);
}
