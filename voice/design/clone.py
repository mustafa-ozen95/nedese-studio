"""Continuing a designed voice exactly: Qwen3-TTS Base 1.7B (Apache 2.0) voice cloning, RTX 5070.

    python clone.py --reference ref.wav --reference-text "text spoken in ref" --text "new text" --output out.wav [--count 4] [--language english]

Why: VoiceDesign samples the timbre anew on every generation; even the same description + seed gives another voice on
another text. To read a missing/wrong line of a reading again in the same voice (e.g. "That day... is today!" read
without the pause), a 10-15 s part of that reading becomes the ICL reference (with its text).
No Turkish (the same 10 languages as design.py).
"""
import argparse
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

MODEL = str(Path(__file__).resolve().parents[2] / 'models' / 'voice' / 'Qwen3-TTS-12Hz-1.7B-Base')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--reference', required=True)
    p.add_argument('--reference-text', required=True)
    p.add_argument('--text', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--language', default='english')
    p.add_argument('--count', type=int, default=1)
    p.add_argument('--seed', type=int, default=1)
    a = p.parse_args()
    model = Qwen3TTSModel.from_pretrained(MODEL, device_map='cuda:0', dtype=torch.bfloat16)
    prompt = model.create_voice_clone_prompt(ref_audio=a.reference, ref_text=a.reference_text)
    output = Path(a.output)
    for i in range(a.count):
        torch.manual_seed(a.seed + i)
        wavs, fs = model.generate_voice_clone(text=a.text, language=a.language, voice_clone_prompt=prompt)
        target = output if a.count == 1 else output.with_name(f'{output.stem}_{i}{output.suffix}')
        sf.write(str(target), wavs[0], fs)
        print(f'{target} {len(wavs[0]) / fs:.2f} s', flush=True)


if __name__ == '__main__':
    main()
