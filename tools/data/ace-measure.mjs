// ACE-Step 1.5 turbo (2B) / XL turbo (4B): generates with the same style/lyrics/seed/duration, measures time and peak VRAM.
// Output: ComfyUI/output/aceolc/<model>_<n>_<seed>*.mp3 ; summary ace-olc.json
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { run, musicJob } from '../comfy.mjs';

const PROMPTS = [
  { style: 'turkish pop, melancholic, acoustic guitar, warm female vocals, soft strings, slow tempo', bpm: 84, language: 'tr',
    lyrics: '[verse]\nAkşam olunca deniz kenarında\nSeni düşünürüm sessizce\n[chorus]\nGel bu gece, kalbim seninle\nYıldızlar kadar uzak değilsin' },
  { style: 'anatolian rock, electric guitar, saz, powerful male vocals, driving drums, energetic', bpm: 120, language: 'tr',
    lyrics: '[verse]\nYollar uzun, dağlar yüksek\nYürürüm yine de durmadan\n[chorus]\nBu toprak benim, bu şarkı senin\nSes ver bana uzaklardan' },
  { style: 'lofi hip hop, instrumental, mellow piano, vinyl crackle, soft drums, chill', bpm: 78, language: 'tr', lyrics: '' },
  { style: 'epic cinematic orchestral, instrumental, strings, brass, timpani, heroic, trailer', bpm: 96, language: 'tr', lyrics: '' },
  { style: 'english pop, upbeat, synth, catchy female vocals, dance beat, bright', bpm: 118, language: 'en',
    lyrics: '[verse]\nCity lights are calling out my name\nEvery night we never feel the same\n[chorus]\nHold on tight, we are dancing in the light\nNothing gonna stop us tonight' },
];
const MODELS = [['turbo', 'acestep_v1.5_turbo.safetensors'], ['xl', 'acestep_v1.5_xl_turbo_bf16.safetensors']];
const SEEDS = [2026, 7];
const vram = () => Number(execSync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits').toString().trim());

const result = [];
for (const [name, file] of MODELS) {
  for (const [n, i] of PROMPTS.entries()) {
    for (const seed of SEEDS) {
      const g = musicJob({ style: i.style, lyrics: i.lyrics, duration: 30, seed, bpm: i.bpm, language: i.language, prefix: `aceolc/${name}_${n}_${seed}` });
      g[1].inputs.unet_name = file;
      let peak = 0;
      const watch = setInterval(() => { try { peak = Math.max(peak, vram()); } catch {} }, 1000);
      const startedAt = Date.now();
      try {
        await run(g, { timeTimeout: 1800e3 });
        result.push({ model: name, prompt: n, seed, sec: (Date.now() - startedAt) / 1000, peakMb: peak });
      } catch (e) {
        result.push({ model: name, prompt: n, seed, error: e.message.slice(0, 300) });
      }
      clearInterval(watch);
      console.log(JSON.stringify(result.at(-1)));
      writeFileSync(new URL('../../araclar/veri/ace-olc.json', import.meta.url), JSON.stringify(result, null, 1));
    }
  }
}
