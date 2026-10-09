# Voice-over takes with EMA Lightning (same --job contract as the panel's voice\speak.py):
#   job.json: { language, speed?, lines: [{ id, text, ... }] }  (references are ignored: EMA is one voice, no cloning)
#   output:   <folder>\<id>_<k>.wav (k = 0..trial-1, 24 kHz), a "generated <name> (<seconds> s)" line for each.
# Picking the best take (Whisper) is done by voice\speak.py --check-only (voice\ema\speak.bat).
# Measured 07.10.2026 (RTX 5070): load 1 s, ~0.05 s per sentence (135x real time); Whisper error 0.2%,
# UTMOS 3.17 (VoxCPM2 3.58); female voice, pitch ~233 Hz. Model: canberkkkkkk/ema-lightning (Apache 2.0).
# Usage: .venv\Scripts\python.exe generate.py --job job.json --folder shots --trial 3
import argparse
import json
import os
from pathlib import Path

os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parents[1] / "hf"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
# The checkpoints hold only tensors/dicts (verified 07.10.2026 by opening them with weights_only=True); the package
# loads with weights_only=False, so safe loading is forced here.
os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"

from ema_lightning import EMA  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--job", required=True)
    p.add_argument("--folder", default="shots")
    p.add_argument("--trial", type=int, default=1)
    p.add_argument("--seed", type=int, default=7)
    # The panel passes the same arguments to speak.py (--vary, --naturalness): those are not for this script
    a, _ = p.parse_known_args()

    path = Path(a.job)
    job = json.loads(path.read_text(encoding="utf-8"))
    folder = Path(a.folder)
    if not folder.is_absolute():
        folder = path.parent / folder
    folder.mkdir(parents=True, exist_ok=True)
    tts = EMA()
    # the pace of the library voice (its "speed"; EMA + A2 reads a little faster): EMA's own, not a stretched recording
    speed = float(job.get("speed") or 1.0)
    for s in job["lines"]:
        for k in range(a.trial):
            target = folder / f"{s['id']}_{k}.wav"
            if target.exists():
                continue
            # In checked quality every take with another seed (Whisper picks the most accurate)
            sp = tts.say(s["text"], speed=speed, path=str(target), seed=a.seed + k * 101, sample_rate=24000)
            print(f"generated {target.name} ({sp.duration:.2f} s)", flush=True)


if __name__ == "__main__":
    main()
