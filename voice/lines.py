"""Splits a narration read in one breath into its lines (Whisper word times + the quietest moment between lines).

    python lines.py reading.wav lines.json output_folder [--lang en]

lines.json: {"lines": [{"id": "intro", "text": "..."}, ...]} (the narration.json form).
Output: <folder>/<id>.wav (each line, 10 ms soft ends) + <folder>/lines.json (the boundaries, dBFS).
Why: in a voice made line by line the timbre and intonation drift from line to line; splitting one reading gives a
consistent, natural narrator (Qwen3-TTS VoiceDesign one-pass reading, 30.09.2026).
"""
import argparse
import json
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
    s = unicodedata.normalize('NFKD', s.replace('İ', 'i').replace('I', 'ı').lower())
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return re.sub(r'[^0-9a-zı]', '', s)


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
    p.add_argument('reading')
    p.add_argument('lines')
    p.add_argument('folder')
    p.add_argument('--lang', default='en')
    p.add_argument('--device', default='cuda', help='cpu when the graphics card is full (slow but works)')
    p.add_argument('--model', default='large-v3', help='small.en is enough and fast for English on the cpu')
    a = p.parse_args()
    lines = json.loads(Path(a.lines).read_text(encoding='utf-8'))['lines']

    import whisper
    stt = whisper.load_model(a.model, device=a.device)
    result = stt.transcribe(a.reading, language=a.lang, condition_on_previous_text=False, word_timestamps=True)
    words = [w for seg in result['segments'] for w in seg.get('words', [])]
    y, sr = sf.read(a.reading)
    if y.ndim > 1:
        y = y.mean(axis=1)

    # The lines are matched to the words in order: for each line, the prefix of the remaining words that fits its text best.
    i = 0
    ranges = []
    for k, s in enumerate(lines):
        target = plain(s['text'])
        last_line = k == len(lines) - 1
        candidates = range(i + 1, len(words) + 1) if not last_line else [len(words)]
        m = min(candidates, key=lambda j: (distance(plain(''.join(w['word'] for w in words[i:j])), target), j))
        heard = ''.join(w['word'] for w in words[i:m]).strip()
        ranges.append((i, m, heard))
        i = m

    # The boundaries: the quietest 20 ms between a line's last word and the next line's first word.
    w = int(0.02 * sr)

    def quietest(start, last):
        lowest, at = None, int(start * sr)
        for j in range(int(start * sr), max(int(start * sr) + 1, min(len(y) - w, int(last * sr))), w // 2):
            e = float(np.mean(y[j:j + w] ** 2))
            if lowest is None or e < lowest:
                lowest, at = e, j + w // 2
        return at, 10 * np.log10((lowest or 0) + 1e-12)

    cuts = [0]
    report = []
    for k in range(len(lines) - 1):
        previous_last = words[ranges[k][1] - 1]['end']
        next_start = words[ranges[k + 1][0]]['start']
        at, db = quietest(max(0.0, previous_last - 0.05), max(previous_last + 0.02, next_start + 0.05))
        cuts.append(at)
        report.append({'boundary': f"{lines[k]['id']}|{lines[k + 1]['id']}", 'sec': round(at / sr, 3), 'dbfs': round(db, 1)})
    cuts.append(len(y))

    folder = Path(a.folder)
    folder.mkdir(parents=True, exist_ok=True)
    f = int(0.01 * sr)
    for k, s in enumerate(lines):
        part = y[cuts[k]:cuts[k + 1]].copy()
        part[:f] *= np.linspace(0, 1, f)
        part[-f:] *= np.linspace(1, 0, f)
        sf.write(str(folder / f"{s['id']}.wav"), part, sr)
        error = distance(plain(ranges[k][2]), plain(s['text'])) / max(1, len(plain(s['text'])))
        print(f"{s['id']:11s} {len(part) / sr:5.2f} s  error {error:.2f}  <- {ranges[k][2]}")
    for r in report:
        warning = '  <- NOT SILENT' if r['dbfs'] > -40 else ''
        print(f"boundary {r['boundary']:22s} {r['sec']:7.2f} s {r['dbfs']:6.1f} dBFS{warning}")
    (folder / 'lines.json').write_text(json.dumps({'text': result['text'], 'boundaries': report}, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
