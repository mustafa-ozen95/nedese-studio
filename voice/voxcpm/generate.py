# Voice-over takes with VoxCPM2 (same --job contract as the panel's voice\speak.py):
#   job.json: { reference?, referenceText?, lora?, language, emotionMode?, lines: [{ id, text, cfg?, reference?, referenceText?, directive? }] }
#   output:   <folder>\<id>_<k>.wav (k = 0..trial-1), a "generated <name> (<seconds> s)" line for each.
# Picking the best take (Whisper) is done by voice\speak.py --check-only (speak.bat).
# Usage: .venv\Scripts\python.exe generate.py --job job.json --folder shots --trial 3
import argparse
import hashlib
import json
import os
from pathlib import Path

os.environ.setdefault("HF_HOME", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hf"))

import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from voxcpm import VoxCPM  # noqa: E402

# Without a reference ("the model's own voice") a consistent narrator: a voice design description.
# Model: VoxCPM2 or a Turkish fine-tune of the same architecture (Kizagan-TTS; the panel gives it with VOXCPM_MODEL).
MODEL = os.environ.get("VOXCPM_MODEL") or "openbmb/VoxCPM2"

DEFAULT_SPEC = "A warm, clear, mature male narrator with a calm and confident storytelling voice, measured pace"

# Emotion sample sentences ("bank" mode): a sentence OTHER than the line itself that fits the emotion of the directive.
# The sample is read in the same voice with the directive; the line takes its intonation. The FIRST emotion named in the
# directive counts ("joyful, ... a little tearful": joy).
BANK = [
    (("scream", "shout", "call", "urgent", "frantic", "desperate", "worri", "anxious", "panic"), "Neredesin? Lütfen sesini duyur bana!"),
    (("scared", "afraid", "fear", "terrif", "trembl", "frighten", "nervous"), "Burası çok karanlık, eve gitmek istiyorum."),
    (("sad", "tear", "cry", "sorrow", "grief", "heartbro", "lonely"), "Artık hiçbir şey eskisi gibi olmayacak."),
    (("angry", "furious", "annoy", "irritat", "frustrat"), "Bunu bir daha asla yapma, anladın mı?"),
    (("surpris", "amaz", "shock", "astonish"), "Gerçekten mi? Buna hiç inanamıyorum!"),
    (("joy", "happy", "excit", "delight", "reliev", "cheer", "laugh", "glad"), "Çok mutluyum, sonunda buradasın!"),
    (("calm", "warm", "gentle", "reassur", "soft", "tender", "kind", "soothing"), "Merak etme, her şey yoluna girecek."),
]
BANK_DEFAULT = "Bugün hava güzel, biraz dışarıda yürüyelim."


def write(path, wav, sr):
    # First to a temporary file, then into place: a half WAV of a process killed while writing must not count as done
    temp = Path(path).with_name(Path(path).stem + ".writing.wav")
    sf.write(str(temp), wav, sr)
    os.replace(temp, path)


def bank_sentence(directive):
    d = directive.lower()
    candidates = [(min(d.index(k) for k in keys if k in d), c) for keys, c in BANK if any(k in d for k in keys)]
    return min(candidates)[1] if candidates else BANK_DEFAULT


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--job", required=True)
    p.add_argument("--folder", default="shots")
    p.add_argument("--trial", type=int, default=1)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--reference")
    p.add_argument("--step", type=int, default=10, help="inference_timesteps (quality/speed)")
    # The panel passes the same arguments to speak.py (--vary, --naturalness): those are not for this script
    a, _ = p.parse_known_args()

    path = Path(a.job)
    job = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent
    reference = a.reference or job.get("reference")
    if reference and not Path(reference).is_absolute():
        reference = str(base / reference)
    folder = Path(a.folder)
    if not folder.is_absolute():
        folder = base / folder
    folder.mkdir(parents=True, exist_ok=True)

    # Own voice (voice\clone): with the reference text a "full clone" (reference + continuation prompt; timbre and
    # speaking style together), a trained LoRA is loaded when given.
    reference_text = job.get("referenceText") or None
    lora = job.get("lora") or None
    if lora and not Path(lora).is_absolute():
        lora = str(base / lora)
    if lora:
        # The LoRA settings of the training (r, alpha, target layers) come from lora_config.json; without them
        # VoxCPM builds it with the default r and the weights do not fit (tensor 8 != 32).
        from voxcpm.model.voxcpm2 import LoRAConfig

        lora_setting = None
        setting_file = Path(lora) / "lora_config.json"
        if setting_file.exists():
            lora_setting = LoRAConfig(**json.loads(setting_file.read_text(encoding="utf-8"))["lora_config"])
        model = VoxCPM.from_pretrained(MODEL, load_denoiser=False, lora_config=lora_setting, lora_weights_path=lora)
    else:
        model = VoxCPM.from_pretrained(MODEL, load_denoiser=False)
    sr = model.tts_model.sample_rate
    # Emotion per line (the voice directive of the director's note, English). A full clone copies the intonation of the
    # reference and does not follow the directive (VoxCPM #210). Measured 07.10.2026 (5 lines x 3 seeds, Whisper +
    # emotion2vec + ECAPA):
    #   "bank" (chosen): first ANOTHER sentence is read in the same voice with the directive (emotion sample); the line is
    #     a full clone, timbre from the reference, intonation from the sample: reading error 0.011, scared line 3/3 "sad".
    #   "controlled": only reference + "(directive)text": reading error 0.07, one take read a different sentence.
    emotion_mode = job.get("emotionMode")
    banks = {}
    for s in job["lines"]:
        # Voice per line (one-piece dialogue: character voices); the reference text belongs to that voice only
        ref = s.get("reference") or reference
        ref_text = s.get("referenceText") if s.get("reference") else reference_text
        if ref and not Path(ref).is_absolute():
            ref = str(base / ref)
        bank = None
        if ref and s.get("directive") and emotion_mode == "bank":
            key = (ref, s["directive"])
            if key not in banks:
                sentence = bank_sentence(s["directive"])
                # Named by a digest of (voice, directive): a running number gave the sample of another voice/emotion
                # when the set of lines changed
                digest = hashlib.sha1(f"{ref}|{s['directive']}".encode("utf-8")).hexdigest()[:12]
                bank_path = folder / f"bank_{digest}.wav"
                if not bank_path.exists():
                    torch.manual_seed(a.seed + 7)
                    write(bank_path, model.generate(text=f"({s['directive']}){sentence}", reference_wav_path=ref, cfg_value=2.0, inference_timesteps=a.step), sr)
                banks[key] = (str(bank_path), sentence)
            bank = banks[key]
        for k in range(a.trial):
            target = folder / f"{s['id']}_{k}.wav"
            if target.exists():
                continue
            torch.manual_seed(a.seed + k * 101)
            # cfg (reading calm 0-1) -> cfg_value 1.5-2.5; low = freer, high = closer to the text
            cfg = 1.5 + float(s.get("cfg", 0.5))
            if bank:
                wav = model.generate(text=s["text"], reference_wav_path=ref, prompt_wav_path=bank[0], prompt_text=bank[1], cfg_value=cfg, inference_timesteps=a.step)
            elif ref and s.get("directive") and emotion_mode == "controlled":
                wav = model.generate(text=f"({s['directive']}){s['text']}", reference_wav_path=ref, cfg_value=cfg, inference_timesteps=a.step)
            elif ref and ref_text:
                wav = model.generate(text=s["text"], reference_wav_path=ref, prompt_wav_path=ref, prompt_text=ref_text, cfg_value=cfg, inference_timesteps=a.step)
            elif ref:
                wav = model.generate(text=s["text"], reference_wav_path=ref, cfg_value=cfg, inference_timesteps=a.step)
            else:
                wav = model.generate(text=f"({DEFAULT_SPEC}){s['text']}", cfg_value=cfg, inference_timesteps=a.step)
            write(target, wav, sr)
            print(f"generated {target.name} ({len(wav) / sr:.2f} s)", flush=True)


if __name__ == "__main__":
    main()
