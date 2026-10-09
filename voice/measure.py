"""Voice measurement: pitch (F0), timbre brightness and an optional Whisper transcript.

    python measure.py a.wav b.wav ... [--lang tr] [--transcribe]

F0 median: a deep, full male voice is ~85-110 Hz. A low spectral centroid means a dark, full timbre.
It does not replace listening; it ranks the candidates.
"""
import argparse
import os
from pathlib import Path

os.environ.setdefault('HF_HOME', str(Path(__file__).parent / 'hf'))
# Whisper reads audio through ffmpeg (speak.bat adds the same path).
os.environ['PATH'] += os.pathsep + os.path.expandvars(
    r'%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin')
os.environ['PATH'] = str(Path(__file__).resolve().parents[1] / 'ffmpeg' / 'bin') + os.pathsep + os.environ['PATH']  # the installer's portable ffmpeg first

import librosa  # noqa: E402
import numpy as np  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('files', nargs='+')
    parser.add_argument('--lang', default='tr')
    parser.add_argument('--transcribe', action='store_true')
    args = parser.parse_args()
    model = None
    if args.transcribe:
        import whisper
        model = whisper.load_model('large-v3', device='cuda')
    for f in args.files:
        y, sr = librosa.load(f, sr=24000)
        f0_all, voiced, _ = librosa.pyin(y, fmin=50, fmax=320, sr=sr, frame_length=2048)
        f0 = f0_all[voiced & ~np.isnan(f0_all)]
        # HNR (dB): the normalised autocorrelation at the pitch lag in voiced windows.
        # Low = breathy/husky (a full, rough voice), high = clean/bright.
        hnr = []
        step = 512
        for k, (pitch, v) in enumerate(zip(f0_all, voiced)):
            if not v or np.isnan(pitch):
                continue
            w = y[k * step: k * step + 2048]
            delay = int(round(sr / pitch))
            if len(w) < 2048 or delay >= len(w) // 2:
                continue
            w = w - w.mean()
            first, second = w[:-delay], w[delay:]
            r = float(np.dot(first, second) / (np.sqrt(np.dot(first, first) * np.dot(second, second)) + 1e-12))
            if 0 < r < 1:
                hnr.append(10 * np.log10(r / (1 - r)))
        center = float(np.median(librosa.feature.spectral_centroid(y=y, sr=sr)))
        spec = np.abs(librosa.stft(y, n_fft=4096)) ** 2
        freq = librosa.fft_frequencies(sr=sr, n_fft=4096)
        low = spec[(freq >= 80) & (freq < 400)].sum() / max(spec[(freq >= 400) & (freq < 4000)].sum(), 1e-9)
        # No voiced frame (a whisper, a very short or broken take): F0 cannot be measured; no crash on an empty array.
        f0_median = f'{np.median(f0):5.1f}' if len(f0) else ' none'
        f0_low = f'{np.percentile(f0, 10):5.1f}' if len(f0) else ' none'
        line = (f'{Path(f).name:28s} {len(y) / sr:5.1f} s  F0 median {f0_median} Hz '
                f'(10% {f0_low})  centroid {center:6.0f} Hz  low/mid {low:4.2f}  '
                f'HNR {np.median(hnr) if hnr else float("nan"):4.1f} dB')
        if model:
            s = model.transcribe(f, language=args.lang, condition_on_previous_text=False)
            line += f'\n    "{s["text"].strip()}"'
        print(line, flush=True)


if __name__ == '__main__':
    main()
