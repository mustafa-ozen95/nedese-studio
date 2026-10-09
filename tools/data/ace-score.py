"""ACE-Step ciktilarini puanlar: audiobox-aesthetics (CE keyif, CU yarar, PC karmasiklik, PQ yapim kalitesi; 1-10).
python ace-puanla.py <klasor> <ffmpeg> -> aes.json
Soz dogrulugu ayri: ses\\.venv Whisper (ace-whisper.py)."""
import json
import subprocess
import sys
from pathlib import Path

folder, ffmpeg = Path(sys.argv[1]), sys.argv[2]
wavs = []
for mp3 in sorted(folder.glob('*.mp3')):
    wav = mp3.with_suffix('.wav')
    if not wav.exists():
        subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', str(mp3), '-ac', '2', '-ar', '48000', str(wav)], check=True)
    wavs.append(wav)

# Yeni torchaudio dosya okumak icin torchcodec istiyor (Windows'ta FFmpeg DLL'leri gerekir): WAV'lari soundfile okur
import soundfile  # noqa: E402
import torch  # noqa: E402
import torchaudio  # noqa: E402


def _read(path, frame_offset=0, num_frames=-1, **_):
    data, sr = soundfile.read(str(path), dtype='float32', always_2d=True, start=int(frame_offset), frames=int(num_frames) if num_frames and num_frames > 0 else -1)
    return torch.from_numpy(data.T.copy()), sr


class _Info:
    def __init__(self, path):
        self.sample_rate = soundfile.info(str(path)).samplerate


torchaudio.load = _read
torchaudio.info = _Info
from audiobox_aesthetics.infer import initialize_predictor  # noqa: E402

p = initialize_predictor()
scores = p.forward([{'path': str(w)} for w in wavs])
result = {w.stem: {k: round(float(v), 3) for k, v in s.items()} for w, s in zip(wavs, scores)}
Path(folder / 'aes.json').write_text(json.dumps(result, indent=1), encoding='utf-8')
print(json.dumps(result, indent=1))
