"""Local Turkish voice-over: Chatterbox Multilingual (Resemble AI, MIT) + Whisper check, on the RTX 5070.
User, 29.09.2026: "let's use a strong local model for voice too, we'll use it later".

One line:
    python speak.py --text "Merhaba." --reference ref.wav --output merhaba.wav

Job file (each line its own WAV; N takes per line, the take whose Whisper transcript is closest to the text wins):
    python speak.py --job job.json --folder shots --trial 3

job.json (written by the panel, lib/jobs/common.mjs speak()):
    {"reference": "ref.wav", "language": "tr",
     "lines": [{"id": "intro", "text": "...", "exaggeration": 0.6, "cfg": 0.35, "temperature": 0.8,
                "reference": "voice of this line.wav", "expected": "how it sounds, when the spelling differs"}]}

- reference: the voice to clone (~10 s of clean speech). Without one, the model's own voice.
- exaggeration (0.25-2): strength of emotion/emphasis; 0.5 natural, 0.8+ epic.
- cfg (0-1): low = slower, more measured reading; 0.3 suits a narrator.
- Output 24 kHz mono WAV. Report: <folder>/report.json (transcript and error rate of every take).
- More natural (user 30.09.2026: "it's obvious it's AI"): --trial 6 --vary --naturalness
  -> every take with other settings; among the takes read correctly, the highest UTMOS naturalness wins.
- --check-only: no generation, picks again among the existing <id>_<k>.wav takes (VoxCPM2 and EMA write the takes,
  this script picks: voxcpm\\speak.bat, ema\\speak.bat).

Lines printed for the panel: "generated <file> (<seconds> s)" per take, "<id> error <rate> ... <- <heard>" per line.
"""
import argparse
import json
import os
import re
import shutil
import unicodedata
from pathlib import Path

ROOT = Path(__file__).parent
os.environ.setdefault('HF_HOME', str(ROOT / 'hf'))

import soundfile as sf  # noqa: E402
import torch  # noqa: E402

# torchaudio 2.9+ ties saving to torchcodec (FFmpeg DLLs); soundfile is enough.


def plain(s: str) -> str:
    s = s.replace('İ', 'i').replace('I', 'ı').lower()
    s = unicodedata.normalize('NFC', s)
    return re.sub(r'\s+', ' ', re.sub(r'[^0-9a-zçğıöşüâîû ]', ' ', s)).strip()


def error_ratio(heard: str, expected: str) -> float:
    a, b = plain(heard), plain(expected)
    if not b:
        return 0.0
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        now = [i]
        for j, cb in enumerate(b, 1):
            now.append(min(previous[j] + 1, now[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = now
    return previous[-1] / len(b)


# --vary: every take with other settings (temperature, exaggeration, cfg); one setting reads monotonous, "artificial".
VARIETY = [(0, 0, 0), (-0.1, 0.1, 0.1), (0.1, -0.1, 0), (-0.05, 0.05, 0.2), (0.05, -0.05, 0.1), (0, 0.15, 0)]


def generate(lines, language, reference, folder: Path, trial: int, seed: int, vary: bool = False, device: str = 'cuda'):
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    shots = {}
    for s in lines:
        shots[s['id']] = []
        for k in range(trial):
            torch.manual_seed(seed + k)
            dt, de, dc = VARIETY[k % len(VARIETY)] if vary else (0, 0, 0)
            wav = model.generate(
                # Voice per line (one-piece dialogue: character voices); otherwise the job's reference
                s['text'], language_id=language, audio_prompt_path=s.get('reference') or reference,
                exaggeration=max(0.25, float(s.get('exaggeration', 0.5)) + de), cfg_weight=min(1.0, float(s.get('cfg', 0.5)) + dc),
                temperature=max(0.5, float(s.get('temperature', 0.8)) + dt),
            )
            path = folder / f"{s['id']}_{k}.wav"
            sf.write(str(path), wav.squeeze(0).cpu().numpy(), model.sr)
            shots[s['id']].append(path)
            print(f"generated {path.name} ({wav.shape[-1] / model.sr:.2f} s)", flush=True)
    del model
    torch.cuda.empty_cache()
    return shots


def naturalness_meter(device: str = 'cuda'):
    """UTMOS22 strong (SpeechMOS, MIT): 1-5 naturalness estimate. Trained on English; in Turkish not an absolute value,
    used to rank the takes of the same line (a metallic/artificial take scores low)."""
    import librosa

    os.environ.setdefault('TORCH_HOME', str(ROOT / 'torch_hub'))
    m = torch.hub.load('tarepan/SpeechMOS:v1.2.0', 'utmos22_strong', trust_repo=True).to(device).eval()

    def score(path):
        y, _ = librosa.load(str(path), sr=16000)
        with torch.no_grad():
            return float(m(torch.from_numpy(y).unsqueeze(0).to(device), 16000))
    return score


def cut_excess(path: Path, result, expected: str):
    """On short lines the model adds made-up syllables/words at the end ("Ama yanıldılar. Ama vay!").
    Finds the prefix of Whisper's words that best matches the expected text; if there is more, cuts after the end of
    the last word (+0.12 s, 30 ms before the next word) and writes it with a 30 ms fade. Returns the cut path or None."""
    words = [w for seg in result['segments'] for w in seg.get('words', [])]
    target = plain(expected).replace(' ', '')
    best = None
    for m in range(1, len(words) + 1):
        e = error_ratio(plain(''.join(w['word'] for w in words[:m])).replace(' ', ''), target)
        if best is None or e < best[1] - 1e-9:
            best = (m, e)
    if not best or best[0] >= len(words):
        return None
    m = best[0]
    cut = min(words[m - 1]['end'] + 0.12, words[m]['start'] - 0.03)
    y, sr = sf.read(str(path))
    n = int(cut * sr)
    if n <= int(0.2 * sr) or n >= len(y):
        return None
    y = y[:n].copy()
    fade = int(0.03 * sr)
    y[-fade:] *= [1 - i / fade for i in range(fade)]
    cut_path = path.with_name(f'{path.stem}_k{path.suffix}')
    sf.write(str(cut_path), y, sr)
    return cut_path


def pitch(path: Path):
    """Median pitch (F0) of the selected take, Hz (librosa pYIN, voiced frames). Measured (not guessed) to check the
    gender/age of a character voice: adult male ~85-155, female ~165-255, child ~250-400 Hz."""
    import librosa
    import numpy as np

    y, sr = librosa.load(str(path), sr=16000)
    f0, voiced, _ = librosa.pyin(y, fmin=60, fmax=600, sr=sr, frame_length=1024)
    f0 = f0[voiced & ~np.isnan(f0)]
    return round(float(np.median(f0)), 1) if len(f0) else None


def check(lines, shots, language, folder: Path, naturalness: bool = False, device: str = 'cuda'):
    import whisper

    stt = whisper.load_model('large-v3', device=device)

    def listen(path):
        return stt.transcribe(str(path), language=language, condition_on_previous_text=False, word_timestamps=True,
                              fp16=device != 'cpu')

    def word_times(result):
        # For subtitle timing (one-piece panel job): [start, end] seconds of every word.
        return [[round(w['start'], 2), round(w['end'], 2)] for seg in result.get('segments', []) for w in seg.get('words', [])]

    candidates_all = {}
    for s in lines:
        # 'expected': for lines that sound different from their spelling (e.g. text "Praym.", heard "Prime").
        expected = s.get('expected', s['text'])
        candidates = []
        for path in shots[s['id']]:
            result = listen(path)
            heard = result['text'].strip()
            candidates.append({'file': path.name, 'heard': heard, 'error': round(error_ratio(heard, expected), 3),
                               'duration': round(sf.info(str(path)).duration, 2), 'words': word_times(result)})
            cut = cut_excess(path, result, expected)
            if cut:
                # The cut take is listened to again: the error is measured, not assumed.
                cut_result = listen(cut)
                heard = cut_result['text'].strip()
                candidates.append({'file': cut.name, 'heard': heard, 'error': round(error_ratio(heard, expected), 3),
                                   'duration': round(sf.info(str(cut)).duration, 2), 'trimmed': True,
                                   'words': word_times(cut_result)})
        candidates_all[s['id']] = candidates
    if naturalness:
        del stt
        torch.cuda.empty_cache()
        score = naturalness_meter(device)
        for s in lines:
            for c in candidates_all[s['id']]:
                c['naturalness'] = round(score(folder / c['file']), 3)
    report = []
    for s in lines:
        candidates = candidates_all[s['id']]
        if naturalness:
            # The most natural among the takes read correctly (within +0.03 of the best error).
            threshold = min(c['error'] for c in candidates) + 0.03
            best = max((c for c in candidates if c['error'] <= threshold), key=lambda c: c['naturalness'])
        else:
            # Lowest error; on a tie the shorter one (less risk of stretching/repeating).
            best = min(candidates, key=lambda c: (c['error'], c['duration']))
        shutil.copyfile(folder / best['file'], folder / f"{s['id']}.wav")
        try:
            best['f0'] = pitch(folder / best['file'])
        except Exception as e:  # noqa: BLE001 - the choice stands when the pitch cannot be measured
            print(f"pitch not measured {s['id']}: {e}", flush=True)
        report.append({'id': s['id'], 'text': s['text'], 'selected': best, 'candidates': candidates})
        extra = f" naturalness {best['naturalness']:.2f}" if naturalness else ''
        print(f"{s['id']:10s} error {best['error']:.3f}{extra} {best['duration']:5.2f} s  <- {best['heard']}", flush=True)
    (folder / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--text')
    p.add_argument('--output')
    p.add_argument('--job', help='job.json: several lines in one run (the model loads once)')
    p.add_argument('--folder', default='shots')
    p.add_argument('--reference')
    p.add_argument('--language', default='tr')
    p.add_argument('--exaggeration', type=float, default=0.5)
    p.add_argument('--cfg', type=float, default=0.5)
    p.add_argument('--trial', type=int, default=1)
    p.add_argument('--seed', type=int, default=7)
    p.add_argument('--vary', action='store_true', help='every take with other temperature/exaggeration/cfg')
    p.add_argument('--naturalness', action='store_true', help='pick the most natural (UTMOS) among the takes read correctly')
    p.add_argument('--check-only', action='store_true', help='no generation: pick again among the existing <id>_<k>.wav takes')
    p.add_argument('--device', default='cuda', help='cpu when the graphics card is busy with other work (slow)')
    a = p.parse_args()

    if a.job:
        job = json.loads(Path(a.job).read_text(encoding='utf-8'))
        base = Path(a.job).parent
        reference = a.reference or job.get('reference')
        if reference and not Path(reference).is_absolute():
            reference = str(base / reference)
        folder = Path(a.folder)
        if not folder.is_absolute():
            folder = base / folder
        folder.mkdir(parents=True, exist_ok=True)
        lines = job['lines']
        language = job.get('language', a.language)
    else:
        if not (a.text and a.output):
            p.error('--text and --output, or --job, are required')
        reference = a.reference
        folder = Path(a.output).resolve().parent
        lines = [{'id': Path(a.output).stem, 'text': a.text, 'exaggeration': a.exaggeration, 'cfg': a.cfg}]
        language = a.language

    if a.check_only:
        shots = {s['id']: sorted(p for p in folder.glob(f"{s['id']}_*.wav") if re.fullmatch(rf"{re.escape(s['id'])}_\d+", p.stem))
                 for s in lines}
    else:
        shots = generate(lines, language, reference, folder, a.trial, a.seed, a.vary, a.device)
    if a.trial > 1 or a.naturalness:
        check(lines, shots, language, folder, a.naturalness, a.device)
    else:
        # One take ("Fast"): nothing to choose, Whisper is not loaded (~30 s + 3 GB VRAM saved);
        # no report.json (the panel shows no transcript).
        for s in lines:
            shutil.copyfile(shots[s['id']][0], folder / f"{s['id']}.wav")


if __name__ == '__main__':
    main()
