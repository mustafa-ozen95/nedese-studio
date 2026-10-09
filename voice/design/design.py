"""Voice design from a description: Qwen3-TTS VoiceDesign 1.7B (Apache 2.0), RTX 5070.

    python design.py --spec "A very old man ..." --text "Come, sit ..." --output elder.wav [--count 3] [--language english]

No Turkish (english, german, french, spanish, italian, portuguese, russian, chinese, japanese, korean). Its job: a
timbre the Turkish model (Chatterbox) lacks (old, deep, husky...) made from a description; the voice becomes a cloning
reference for Chatterbox or the target of voice conversion (voice\\convert.py). User, 30.09.2026: "The voice should be
deep, like an old man's. Like the old men who tell prophecies".
"""
import argparse
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

MODEL = str(Path(__file__).resolve().parents[2] / 'models' / 'voice' / 'Qwen3-TTS-12Hz-1.7B-VoiceDesign')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--spec', required=True, help='description of the voice (English works best)')
    p.add_argument('--text', required=True)
    p.add_argument('--language', default='english')
    p.add_argument('--output', required=True)
    p.add_argument('--count', type=int, default=1, help='how many takes with different seeds')
    p.add_argument('--seed', type=int, default=1)
    a = p.parse_args()
    # '@file.txt': long text/description from a file (no shell quoting trouble).
    for name in ('text', 'spec'):
        v = getattr(a, name)
        if v.startswith('@'):
            setattr(a, name, Path(v[1:]).read_text(encoding='utf-8').strip())
    model = Qwen3TTSModel.from_pretrained(MODEL, device_map='cuda:0', dtype=torch.bfloat16)
    output = Path(a.output)
    for i in range(a.count):
        torch.manual_seed(a.seed + i)
        wavs, fs = model.generate_voice_design(text=a.text, instruct=a.spec, language=a.language)
        target = output if a.count == 1 else output.with_name(f'{output.stem}_{i}{output.suffix}')
        sf.write(str(target), wavs[0], fs)
        print(f'{target} {len(wavs[0]) / fs:.2f} s', flush=True)


if __name__ == '__main__':
    main()
