"""Of N takes of a sentence, picks the one with the deepest silence at the split point and splits it in two.

    python divide_select.py folder id "text of the first part" output1.wav output2.wav [--lang tr]

Reads folder/id_0.wav, id_1.wav ... (the takes of speak.py). In each take the first part's last word is found with
Whisper word times and the quietest 20 ms between it and the next word is measured. Both parts must match the text; the
take with the deepest boundary (on a tie the longer natural pause) is picked.
Why: read alone, a short line ("O gun...", "Ama yanildilar.") makes the model invent; read inside a sentence and split,
the boundary must be real silence so the last syllable is not cut (measured 30.09.2026: only one of 6 takes at
-77 dBFS, the others -30..-40).
"""
import argparse
import os
import re
import unicodedata
from pathlib import Path

os.environ.setdefault('HF_HOME', str(Path(__file__).parent / 'hf'))
os.environ['PATH'] += os.pathsep + os.path.expandvars(
    r'%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin')
os.environ['PATH'] = str(Path(__file__).resolve().parents[1] / 'ffmpeg' / 'bin') + os.pathsep + os.environ['PATH']  # the setup's portable ffmpeg first

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402


def plain(s: str) -> str:
    s = unicodedata.normalize('NFC', s.replace('İ', 'i').replace('I', 'ı').lower())
    return re.sub(r'[^0-9a-zçğıöşüâîû]', '', s)


def distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        now = [i]
        for j, cb in enumerate(b, 1):
            now.append(min(previous[j] + 1, now[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = now
    return previous[-1]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('folder')
    p.add_argument('id')
    p.add_argument('first', help='text of the first part')
    p.add_argument('output1')
    p.add_argument('output2')
    p.add_argument('--lang', default='tr')
    a = p.parse_args()

    import whisper
    stt = whisper.load_model('large-v3', device='cuda')
    target = plain(a.first)
    candidates = []
    for f in sorted(Path(a.folder).glob(f'{a.id}_*.wav')):
        if not re.fullmatch(rf'{re.escape(a.id)}_\d+', f.stem):
            continue
        s = stt.transcribe(str(f), language=a.lang, condition_on_previous_text=False, word_timestamps=True)
        k = [w for seg in s['segments'] for w in seg.get('words', [])]
        if len(k) < 2:
            continue
        m = min(range(1, len(k)), key=lambda j: distance(plain(''.join(w['word'] for w in k[:j])), target))
        error = distance(plain(''.join(w['word'] for w in k[:m])), target) / max(1, len(target))
        y, sr = sf.read(str(f))
        w = int(0.02 * sr)
        start, last = max(0.0, k[m - 1]['end'] - 0.05), k[m]['start'] + 0.05
        quietest, at = None, int(start * sr)
        for j in range(int(start * sr), max(int(start * sr) + 1, min(len(y) - w, int(last * sr))), w // 2):
            e = float(np.mean(y[j:j + w] ** 2))
            if quietest is None or e < quietest:
                quietest, at = e, j + w // 2
        # The pause length: how long it stays under -50 dBFS around the boundary.
        threshold = 10 ** (-50 / 10)
        left = at
        while left - w > 0 and np.mean(y[left - w:left] ** 2) < threshold:
            left -= w // 2
        right = at
        while right + w < len(y) and np.mean(y[right:right + w] ** 2) < threshold:
            right += w // 2
        db = 10 * np.log10(quietest + 1e-12)
        print(f'{f.name}: "{s["text"].strip()}"  first part error {error:.2f}, boundary {db:.0f} dBFS, pause {(right - left) / sr:.2f} s')
        if error <= 0.15:
            candidates.append((round(db / 6), -(right - left), f, at, sr))
    if not candidates:
        raise SystemExit('no suitable take')
    _, _, f, at, sr = min(candidates)
    y, _ = sf.read(str(f))
    b1, b2 = y[:at].copy(), y[at:].copy()
    n = int(0.015 * sr)
    b1[-n:] *= np.linspace(1, 0, n)
    b2[:n] *= np.linspace(0, 1, n)
    sf.write(a.output1, b1, sr)
    sf.write(a.output2, b2, sr)
    print(f'picked {f.name} -> {a.output1}, {a.output2}')


if __name__ == '__main__':
    main()
