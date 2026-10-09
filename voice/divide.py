"""Splits one take in two at a sentence boundary (Whisper word times + the quietest moment).

    python divide.py input.wav "text of the first part" output1.wav output2.wav [--lang tr]

Why: on very short lines ("O gun...", "Ama yanildilar.") Chatterbox adds a made-up syllable at the end, and cutting it
leaves the last syllable half (measured 30.09.2026: the last window at -27 dBFS). Reading the short line inside a natural
sentence ("O gun... bugundur!") and splitting at the silence between them prevents both; the two parts come from one
breath, so the intonation matches too.
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
    s = s.replace('İ', 'i').replace('I', 'ı').lower()
    s = unicodedata.normalize('NFC', s)
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
    p.add_argument('input')
    p.add_argument('first', help='text of the first part')
    p.add_argument('output1')
    p.add_argument('output2')
    p.add_argument('--lang', default='tr')
    a = p.parse_args()

    import whisper
    stt = whisper.load_model('large-v3', device='cuda')
    result = stt.transcribe(a.input, language=a.lang, condition_on_previous_text=False, word_timestamps=True)
    words = [w for seg in result['segments'] for w in seg.get('words', [])]
    target = plain(a.first)
    m = min(range(1, len(words)), key=lambda k: distance(plain(''.join(w['word'] for w in words[:k])), target))
    y, sr = sf.read(a.input)
    # The boundary: the quietest 20 ms between the first part's last word and the next one.
    start = max(0.0, words[m - 1]['end'] - 0.05)
    last = max(start + 0.04, words[m]['start'] + 0.05)
    w = int(0.02 * sr)
    best, cut = None, int(start * sr)
    for i in range(int(start * sr), min(len(y) - w, int(last * sr)), w // 2):
        e = float(np.mean(y[i:i + w] ** 2))
        if best is None or e < best:
            best, cut = e, i + w // 2
    y1, y2 = y[:cut].copy(), y[cut:].copy()
    f = int(0.01 * sr)
    y1[-f:] *= np.linspace(1, 0, f)
    y2[:f] *= np.linspace(0, 1, f)
    sf.write(a.output1, y1, sr)
    sf.write(a.output2, y2, sr)
    db = 10 * np.log10(best + 1e-12)
    print(f"{' '.join(w['word'].strip() for w in words[:m])} | {' '.join(w['word'].strip() for w in words[m:])}"
          f"  (boundary {cut / sr:.2f} s, {db:.0f} dBFS)")


if __name__ == '__main__':
    main()
