"""Cloning your own voice, step 1: turns the recordings into training data (voice\\.venv: Whisper + ffmpeg).

    python prepare.py --output <folder> recording1.mp4 recording2.m4a ...

Any format (video or audio: mp4, mov, mkv, webm, mp3, m4a, ogg, opus, wav, flac...) is accepted; ffmpeg takes only the
audio track. Steps:
  1. ffmpeg: mono, 24 kHz, 70 Hz high-pass (hum), loudness levelling -> full.wav
  2. Whisper large-v3 (Turkish): text + word times; silent/uncertain segments are dropped
  3. 3-12 s sentences (split at the gaps between words) -> parts\\NNNN.wav (16 kHz) + training.jsonl
  4. The cleanest 8-16 s stretch -> reference.wav (24 kHz) + reference.txt (for the instant clone)
  5. summary.json: total speech time, part count, whether it is enough for training

Lines printed for the panel: "progress <percent> <description>", "ERROR: <message>" on failure.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('HF_HOME', str(ROOT / 'hf'))
os.environ['PATH'] = str(ROOT.parent / 'ffmpeg' / 'bin') + os.pathsep + os.environ['PATH'] + os.pathsep + os.path.expandvars(
    r'%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin')

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

# Training needs at least ~1 min of clean speech; 5-10 min and more is best (VoxCPM LoRA).
TRAINING_MIN_SEC = 60
PART_SHORTEST, PART_LONGEST = 3.0, 12.0


def progress(percent, text):
    print(f'progress {percent} {text}', flush=True)


def convert_with_ffmpeg(sources, target: Path):
    """Turns all recordings into one mono 24 kHz wav (0.5 s of silence between them)."""
    parts = []
    for i, k in enumerate(sources):
        temp = target.parent / f'_source{i}.wav'
        command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(k), '-vn', '-map', '0:a:0',
                   '-ac', '1', '-ar', '24000', '-af', 'highpass=f=70,loudnorm=I=-20:TP=-2:LRA=11', str(temp)]
        r = subprocess.run(command, capture_output=True, text=True)
        if r.returncode != 0 or not temp.exists():
            sys.exit(f'ERROR: {Path(k).name} could not be read (no audio track or damaged): {r.stderr.strip()[-300:]}')
        parts.append(temp)
    silent = np.zeros(12000, dtype=np.float32)
    combined = []
    for p in parts:
        v, sr = sf.read(str(p), dtype='float32')
        combined += [v, silent]
        p.unlink()
    voice = np.concatenate(combined)
    sf.write(str(target), voice, 24000)
    return voice


def sentences(result):
    """3-12 s training parts from the Whisper segments: joined/split at word boundaries."""
    words = []
    for b in result['segments']:
        # Uncertain segments or ones without speech spoil the training.
        if b.get('no_speech_prob', 0) > 0.5 or b.get('avg_logprob', 0) < -1.0:
            continue
        for k in b.get('words', []):
            words.append(k)
    parts, current = [], []
    for k in words:
        if current:
            duration = k['end'] - current[0]['start']
            space = k['start'] - current[-1]['end']
            sentence_end = current[-1]['word'].strip()[-1:] in '.!?'
            # Long gap (>0.7 s), or sentence end + enough length, or the upper limit: close the part.
            if space > 0.7 or duration > PART_LONGEST or (sentence_end and current[-1]['end'] - current[0]['start'] >= PART_SHORTEST):
                parts.append(current)
                current = []
        current.append(k)
    if current:
        parts.append(current)
    result = []
    for p in parts:
        start, end = p[0]['start'], p[-1]['end']
        if end - start < PART_SHORTEST or end - start > PART_LONGEST + 2:
            continue
        probability = float(np.mean([k.get('probability', 0) for k in p]))
        result.append({'start': start, 'end': end, 'text': ''.join(k['word'] for k in p).strip(), 'probability': probability})
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--output', required=True)
    p.add_argument('--language', default='tr')
    p.add_argument('records', nargs='+')
    a = p.parse_args()
    folder = Path(a.output)
    (folder / 'parts').mkdir(parents=True, exist_ok=True)

    progress(5, 'Converting the recordings')
    voice = convert_with_ffmpeg(a.records, folder / 'full.wav')
    total_sec = len(voice) / 24000
    progress(15, f'{total_sec:.0f} s in total; transcribing the speech (Whisper)')

    import whisper
    import torch

    model = whisper.load_model('large-v3', device='cuda' if torch.cuda.is_available() else 'cpu')
    result = model.transcribe(str(folder / 'full.wav'), language=a.language, word_timestamps=True, condition_on_previous_text=False, verbose=False)
    del model
    torch.cuda.empty_cache()
    progress(70, 'Splitting into sentences')

    found = sentences(result)
    if not found:
        sys.exit('ERROR: No clear speech found in the recording (silent, noisy or mostly music).')
    import librosa

    voice16 = librosa.resample(voice, orig_sr=24000, target_sr=16000)
    lines = []
    for i, p in enumerate(found):
        # 0.1 s margin at the word boundaries: the first/last syllable is not cut.
        b16, e16 = max(0, int((p['start'] - 0.1) * 16000)), int((p['end'] + 0.15) * 16000)
        path = folder / 'parts' / f'{i:04d}.wav'
        sf.write(str(path), voice16[b16:e16], 16000)
        lines.append({'audio': str(path.resolve()), 'text': p['text']})
    with open(folder / 'training.jsonl', 'w', encoding='utf-8') as f:
        for s in lines:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')

    # Reference: the most clearly read window of consecutive parts, 8-16 s.
    best = None
    for i in range(len(found)):
        j = i
        while j < len(found) and found[j]['end'] - found[i]['start'] < 8 and (j == i or found[j]['start'] - found[j - 1]['end'] < 1.0):
            j += 1
        if j >= len(found) or found[j]['end'] - found[i]['start'] > 16:
            j = min(j, len(found) - 1)
        window = found[i:j + 1]
        duration = window[-1]['end'] - window[0]['start']
        if duration < 5 or duration > 16:
            continue
        score = float(np.mean([p['probability'] for p in window])) + min(duration, 12) / 100
        if not best or score > best[0]:
            best = (score, window)
    if not best:
        best = (0, [max(found, key=lambda p: p['end'] - p['start'])])
    window = best[1]
    b, e = max(0, int((window[0]['start'] - 0.1) * 24000)), int((window[-1]['end'] + 0.2) * 24000)
    sf.write(str(folder / 'reference.wav'), voice[b:e], 24000)
    reference_text = ' '.join(p['text'] for p in window)
    (folder / 'reference.txt').write_text(reference_text, encoding='utf-8')

    speech_sec = sum(p['end'] - p['start'] for p in found)
    summary = {
        'recordSec': round(total_sec, 1),
        'speechSec': round(float(speech_sec), 1),
        'parts': len(found),
        'referenceSec': round((e - b) / 24000, 1),
        'referenceText': reference_text,
        'enoughForTraining': bool(speech_sec >= TRAINING_MIN_SEC),
        'trainingMinSec': TRAINING_MIN_SEC,
    }
    (folder / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')
    progress(100, f"{len(found)} parts, {speech_sec:.0f} s of speech")
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
