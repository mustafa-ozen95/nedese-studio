# VoxCPM2 Turkce deneme: ayni cumleler, kutuphanedeki "Tok bariton" referansiyla klonlama.
# Kullanim: .venv\Scripts\python.exe dene.py <cikti_klasoru>
import os
import sys
import time

VOICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("HF_HOME", os.path.join(VOICE, "hf"))

import numpy as np
import soundfile as sf
import torch
torch.manual_seed(42)
from voxcpm import VoxCPM

SENTENCES = [
    "Kaplumbağa sakin adımlarla denize doğru yürüdü.",
    "Ağaçlığın ötesinde, eski şöminenin ateşi hâlâ yanıyordu.",
    "Öğretmenlerimizden aldığımız öğütleri hiçbir zaman unutmadık.",
    "Gel otur evlat, sana bir efsane anlatayım. Çok eskiden, dağların ardında, ışıklarla örülmüş bir şehir vardı.",
]
REFERENCE = os.path.join(VOICE, "references", "tok-bariton.wav")

output = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(output, exist_ok=True)
startedAt = time.time()
model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
print(f"yuklendi {time.time() - startedAt:.1f} sn, VRAM {torch.cuda.max_memory_allocated() / 2**30:.1f} GB", flush=True)
sr = model.tts_model.sample_rate
parts = []
for i, text in enumerate(SENTENCES, 1):
    t = time.time()
    wav = model.generate(text=text, reference_wav_path=REFERENCE, cfg_value=2.0, inference_timesteps=10)
    duration = len(wav) / sr
    print(f"cumle {i}: {duration:.1f} sn ses, {time.time() - t:.1f} sn uretim (RTF {(time.time() - t) / duration:.2f})", flush=True)
    sf.write(os.path.join(output, f"voxcpm_{i}.wav"), wav, sr)
    parts += [wav, np.zeros(int(sr * 0.8), dtype=wav.dtype)]
sf.write(os.path.join(output, "voxcpm_hepsi.wav"), np.concatenate(parts), sr)
print(f"VRAM tepe {torch.cuda.max_memory_allocated() / 2**30:.1f} GB", flush=True)
