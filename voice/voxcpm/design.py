# VoxCPM2 ses tasarimi: tariften "Alistair benzeri" anlatici adaylari (Turkce metinle).
# Kullanim: .venv\Scripts\python.exe tasarla.py <cikti_klasoru>
import os
import sys

os.environ.setdefault("HF_HOME", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hf"))

import numpy as np
import soundfile as sf
import torch
from voxcpm import VoxCPM

TEXT = "Gel otur evlat, sana bir efsane anlatayım. Çok eskiden, dağların ardında, ışıklarla örülmüş bir şehir vardı. Kaplumbağa sakin adımlarla denize doğru yürüdü."
SPECS = {
    "a": "A cultured, articulate middle-aged British man, warm and deep voice, calm and confident documentary narrator, clear diction, measured pace",
    "b": "A warm, charming mature male narrator with a rich, smooth baritone, gentle storytelling tone, slow and soothing, like an audiobook reader",
    "c": "A deep, resonant, authoritative male voice in his fifties, cinematic trailer narrator, slightly husky, slow and dramatic with meaningful pauses",
    "d": "A clear, neutral and informative male voice, middle-aged, smooth and friendly, professional news and documentary narration, steady pace",
}

output = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(output, exist_ok=True)
model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
sr = model.tts_model.sample_rate
for name, spec in SPECS.items():
    for trial in (1, 2):
        torch.manual_seed(100 + trial)
        wav = model.generate(text=f"({spec}){TEXT}", cfg_value=2.0, inference_timesteps=10)
        sf.write(os.path.join(output, f"tasarim_{name}{trial}.wav"), wav, sr)
        print(f"{name}{trial}: {len(wav) / sr:.1f} sn", flush=True)
