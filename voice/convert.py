"""Voice conversion (timbre transfer): Chatterbox VC (MIT), RTX 5070.

    python convert.py source.wav target_timbre.wav output.wav

The words and emphasis of the source stay, the timbre comes from the target. Example: turning a Turkish voice-over
(speak.py) into an old/deep timbre designed with Qwen3-TTS (design\\design.py); the design model knows no Turkish, so
the accent comes from the source this way.
Several sources: python convert.py --folder input_folder target_timbre.wav output_folder
"""
import argparse
import os
from pathlib import Path

ROOT = Path(__file__).parent
os.environ.setdefault('HF_HOME', str(ROOT / 'hf'))

import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from chatterbox.vc import ChatterboxVC  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument('source', help='wav, or a folder with --folder')
    p.add_argument('target', help='voice whose timbre is taken (~10 s)')
    p.add_argument('output', help='wav, or a folder with --folder')
    p.add_argument('--folder', action='store_true')
    a = p.parse_args()
    model = ChatterboxVC.from_pretrained('cuda' if torch.cuda.is_available() else 'cpu')
    model.set_target_voice(a.target)
    if a.folder:
        Path(a.output).mkdir(parents=True, exist_ok=True)
        jobs = [(f, Path(a.output) / f.name) for f in sorted(Path(a.source).glob('*.wav'))]
    else:
        jobs = [(Path(a.source), Path(a.output))]
    for source, output in jobs:
        wav = model.generate(str(source))
        sf.write(str(output), wav.squeeze(0).cpu().numpy(), model.sr)
        print(f'{output} {wav.shape[-1] / model.sr:.2f} s', flush=True)


if __name__ == '__main__':
    main()
