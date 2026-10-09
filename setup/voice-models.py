# Downloads the voice models ahead of time (called by setup.bat). Each environment runs it with its own python:
#   voice\.venv          python voice-models.py voice     Chatterbox, Whisper large-v3, UTMOS
#   voice\voxcpm\.venv   python voice-models.py voxcpm    VoxCPM2
#   voice\design\.venv   python voice-models.py design    Qwen3-TTS VoiceDesign + Base + Tokenizer
#   voice\ema\.venv      python voice-models.py ema       EMA Lightning + its single library voice
# The revisions were taken from the copies running on the development machine (04.10.2026).
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VOICE = ROOT / "voice"
os.environ.setdefault("HF_HOME", str(VOICE / "hf"))
os.environ.setdefault("TORCH_HOME", str(VOICE / "torch_hub"))
# On Windows the HF cache wants symbolic links; without the privilege it copies (instead of warning).
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from huggingface_hub import snapshot_download  # noqa: E402

mode = sys.argv[1] if len(sys.argv) > 1 else ""

if mode == "voice":
    # Chatterbox Multilingual (speak.py) + voice conversion (convert.py: s3gen.safetensors)
    snapshot_download(
        "ResembleAI/chatterbox",
        allow_patterns=["ve.pt", "t3_mtl23ls_v2.safetensors", "s3gen.pt", "s3gen.safetensors", "grapheme_mtl_merged_expanded_v1.json", "conds.pt", "Cangjie5_TC.json"],
    )
    print("Chatterbox done", flush=True)
    import whisper

    # Default folder (~/.cache/whisper); whisper checks the SHA-256 itself.
    whisper._download(whisper._MODELS["large-v3"], os.path.join(os.path.expanduser("~"), ".cache", "whisper"), False)
    print("Whisper large-v3 done", flush=True)
    import torch

    torch.hub.load("tarepan/SpeechMOS:v1.2.0", "utmos22_strong", trust_repo=True)
    print("UTMOS done", flush=True)
elif mode == "voxcpm":
    snapshot_download("openbmb/VoxCPM2", revision="32279effe8c19989596f05d353d1447f51d9e915")
    print("VoxCPM2 done", flush=True)
    # Candidate selection in voice design (design.py --candidate): age/gender (audeering, CC BY-NC-SA 4.0: noncommercial
    # use) and speaker similarity (WavLM-SV, MIT). Measurement only; not part of generation.
    snapshot_download("audeering/wav2vec2-large-robust-6-ft-age-gender", revision="a681b720dafd12b9dd7b6d13fb437c7b6b197fd3")
    snapshot_download("microsoft/wavlm-base-plus-sv", revision="feb593a6c23c1cc3d9510425c29b0a14d2b07b1e")
    print("Voice measurement models done", flush=True)
elif mode == "design":
    # local_dir: the HF cache on Windows may ask for symbolic links and fail with WinError 1314.
    for repo, version in [
        ("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "5ecdb67327fd37bb2e042aab12ff7391903235d3"),
        ("Qwen/Qwen3-TTS-12Hz-1.7B-Base", "fd4b254389122332181a7c3db7f27e918eec64e3"),
        ("Qwen/Qwen3-TTS-Tokenizer-12Hz", "7dd38ad4e9bad454aae9cd937d0cd577604fe229"),
    ]:
        snapshot_download(repo, revision=version, local_dir=str(ROOT / "models" / "voice" / repo.split("/")[1]))
        print(repo, "ok", flush=True)
elif mode == "ema":
    # EMA Lightning (Apache 2.0): the model downloads on first use; the library's single voice (engine: ema) is created if missing.
    # The checkpoints are tensors/dicts only (verified 07.10.2026 by loading with weights_only=True).
    import datetime
    import json

    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    from ema_lightning import EMA

    tts = EMA()
    library = VOICE / "references"
    library.mkdir(parents=True, exist_ok=True)
    wav = library / "ema-lightning-female.wav"
    info = library / "ema-lightning-female.json"
    if not info.exists():
        tts.say("Merhaba, ben EMA Lightning. Türkçe metinleri çok hızlı ve net okurum.", path=str(wav), seed=7, sample_rate=24000)
        info.write_text(json.dumps({
            "name": "EMA Lightning (female, very fast)",
            "description": "EMA Lightning (Apache 2.0): a single Turkish female voice, no cloning; ~0.05 s per line (measured 07.10.2026)",
            "spec": "Turkish adult female voice, clear and neutral (EMA Lightning)",
            "engine": "ema",
            "gender": "female",
            "age": "adult",
            "creation": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "panel": 1,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
    print("EMA Lightning done", flush=True)
else:
    sys.exit("usage: voice-models.py voice|voxcpm|design|ema")
