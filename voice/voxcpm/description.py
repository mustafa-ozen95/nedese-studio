# VoxCPM2 voice design (panel "New voice from a description", voice engine VoxCPM2): a Turkish reference voice from a description.
# Qwen3-TTS (voice\design) does not read Turkish; VoxCPM2 takes the description as "(description)text" and reads Turkish.
#
# Candidate choice (08.10.2026): the same description differs a lot by seed (measured 07.10: child probability 0.51 / 0.78 / 0.99).
# --candidate N generates N seeds, every candidate is measured and the one closest to the target wins:
#   pitch: median librosa pyin F0 (Hz)
#   age/gender: audeering/wav2vec2-large-robust-6-ft-age-gender (CC BY-NC-SA 4.0, non-commercial use) -> age, female/male/child
#   distinctness: microsoft/wavlm-base-plus-sv (MIT) x-vector cosine to the voices given with --separate (the other characters
#     of the same film), highest similarity; above the threshold counts as "same voice" (calibration: ECAPA 0.60-0.87 mixed-up pairs / 0.16-0.40 distinct pairs)
# Usage: .venv\Scripts\python.exe description.py --spec "@spec.txt" --text "@text.txt" --output timbre.wav [--seed 101]
#          [--candidate 3 --target child|young|adult|old --gender female|male --type human|animal --separate a.wav b.wav --report report.json]
#        .venv\Scripts\python.exe description.py --measure a.wav b.wav [--separate ref.wav]     (measuring only; no graphics card needed)
import argparse
import json
import os
import shutil
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hf"))

AGE_MODEL = "audeering/wav2vec2-large-robust-6-ft-age-gender"
SIMILARITY_MODEL = "microsoft/wavlm-base-plus-sv"
# The WavLM-sv cosine is compressed (all 0.85+). Calibration 08.10.2026 (same clips, compared with ECAPA, reference neutral Elif):
#   ECAPA 0.27-0.35 (distinct) -> WavLM 0.877-0.896;  ECAPA 0.74-0.87 (mixed up) -> WavLM 0.956-0.994;  in between 0.93 (ECAPA 0.16 / 0.60).
SIMILARITY_THRESHOLD = 0.94  # above counts as "same voice"; the penalty scales with (similarity - 0.85) / 0.1
TARGET_AGE = {"child": 8, "young": 22, "adult": 40, "old": 68}
# Expected pitch (Hz): a candidate outside it loses points
PITCH = {("human", "child"): (280, 450), ("animal", None): (380, 700), ("female", None): (150, 300), ("male", None): (80, 170)}


def read(value: str) -> str:
    # "@file" form: no escaping trouble with Turkish/long text on the command line.
    return Path(value[1:]).read_text(encoding="utf-8").strip() if value.startswith("@") else value


class Meter:
    """Pitch, age/gender and speaker similarity (CPU; the models load on first use)."""

    def __init__(self):
        self._age = None
        self._similarity = None

    def load(self, path, sr=16000):
        import librosa

        x, _ = librosa.load(path, sr=sr, mono=True)
        return x

    def pitch(self, x16):
        import librosa
        import numpy as np

        f0, voiced, _ = librosa.pyin(x16, fmin=60, fmax=900, sr=16000, frame_length=1024, hop_length=256)
        f = f0[voiced & np.isfinite(f0)]
        return round(float(np.median(f)), 1) if len(f) > 5 else None

    def age(self, x16):
        import numpy as np
        import torch

        if self._age is None:
            import torch.nn as nn
            from transformers import Wav2Vec2FeatureExtractor
            from transformers.models.wav2vec2.modeling_wav2vec2 import Wav2Vec2Model, Wav2Vec2PreTrainedModel

            class Head(nn.Module):
                def __init__(self, config, n):
                    super().__init__()
                    self.dense = nn.Linear(config.hidden_size, config.hidden_size)
                    self.dropout = nn.Dropout(config.final_dropout)
                    self.out_proj = nn.Linear(config.hidden_size, n)

                def forward(self, x):
                    return self.out_proj(self.dropout(torch.tanh(self.dense(self.dropout(x)))))

            class AgeGender(Wav2Vec2PreTrainedModel):
                def __init__(self, config):
                    super().__init__(config)
                    self.wav2vec2 = Wav2Vec2Model(config)
                    self.age = Head(config, 1)
                    self.gender = Head(config, 3)
                    self.post_init()

                def forward(self, x):
                    h = self.wav2vec2(x)[0].mean(dim=1)
                    return self.age(h), torch.softmax(self.gender(h), dim=1)

            self._age = (Wav2Vec2FeatureExtractor.from_pretrained(AGE_MODEL), AgeGender.from_pretrained(AGE_MODEL).eval())
        extractor, model = self._age
        g = extractor(np.asarray(x16, dtype=np.float32), sampling_rate=16000, return_tensors="pt")["input_values"]
        with torch.no_grad():
            age, c = model(g)
        p = c[0].tolist()
        return {"age": round(float(age[0][0]) * 100, 1), "female": round(p[0], 3), "male": round(p[1], 3), "child": round(p[2], 3)}

    def embedding(self, x16):
        import numpy as np
        import torch

        if self._similarity is None:
            from transformers import AutoFeatureExtractor, WavLMForXVector

            self._similarity = (AutoFeatureExtractor.from_pretrained(SIMILARITY_MODEL), WavLMForXVector.from_pretrained(SIMILARITY_MODEL).eval())
        extractor, model = self._similarity
        g = extractor(np.asarray(x16, dtype=np.float32), sampling_rate=16000, return_tensors="pt")
        with torch.no_grad():
            e = model(**g).embeddings[0]
        return torch.nn.functional.normalize(e, dim=0)

    def similarity(self, x16, embeddings):
        import torch

        if not embeddings:
            return None
        g = self.embedding(x16)
        return round(max(float(torch.dot(g, r)) for r in embeddings), 3)

    def measure(self, path, embeddings=()):
        x = self.load(path)
        o = {"file": os.path.basename(path), "duration": round(len(x) / 16000, 2), "f0": self.pitch(x), **self.age(x)}
        b = self.similarity(x, list(embeddings))
        if b is not None:
            o["similarity"] = b
        return o


def score(o, target, gender, type):
    """Score of the fit to the target (higher is better) and a short reason. A candidate outside the expected pitch, of the wrong gender/age or sounding like another voice drops."""
    score = 0.0
    reason = []
    f0 = o.get("f0") or 0
    if type == "animal":
        sub, parent = PITCH[("animal", None)]
        # Animal: very high and distinct from the other characters; it may sound like a human child but not like an adult woman
        score += min(f0 / sub, 1.0) * 2 + (1 - o["female"] - o["male"]) * 0.5
        if f0 < sub:
            reason.append(f"pitch {f0} < {sub}")
    elif target == "child":
        sub, parent = PITCH[("human", "child")]
        score += o["child"] * 2 + min(max((f0 - 200) / (sub - 200), 0.0), 1.0)
        if o["child"] < 0.9:
            reason.append(f"child {o['child']}")
        if f0 < sub:
            reason.append(f"pitch {f0} < {sub}")
    else:
        sub, parent = PITCH[(gender, None)]
        p_kind = o["female"] if gender == "female" else o["male"]
        age_target = TARGET_AGE.get(target, 40)
        score += p_kind * 2 + (1 - min(abs(o["age"] - age_target), 30) / 30)
        if p_kind < 0.8:
            reason.append(f"{gender} {p_kind}")
        if f0 and not sub <= f0 <= parent:
            reason.append(f"pitch {f0} ∉ {sub}-{parent}")
    if f0 and not (sub <= f0 <= parent):
        score -= 0.5
    if o.get("similarity") is not None:
        score += 1 - min(max((o["similarity"] - 0.85) / 0.1, 0.0), 1.0)
        if o["similarity"] >= SIMILARITY_THRESHOLD:
            score -= 1.0
            reason.append(f"similarity {o['similarity']} ≥ {SIMILARITY_THRESHOLD}")
    return round(score, 3), ", ".join(reason)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--spec", help="description of the voice (English works best)")
    p.add_argument("--text", help="Turkish text to read (becomes the reference text)")
    p.add_argument("--output")
    p.add_argument("--seed", type=int, default=101)
    p.add_argument("--candidate", type=int, default=1, help="how many seeds to try (the best fit wins)")
    p.add_argument("--target", choices=sorted(TARGET_AGE), help="age group")
    p.add_argument("--gender", choices=["female", "male"])
    p.add_argument("--type", choices=["human", "animal"], default="human")
    p.add_argument("--separate", nargs="*", default=[], help="voices to stay distinct from (wav)")
    p.add_argument("--report", help="candidate measurements (JSON)")
    p.add_argument("--measure", nargs="*", help="measuring only: the given wavs")
    a = p.parse_args()

    meter = Meter()
    if a.measure:
        embeddings = [meter.embedding(meter.load(y)) for y in a.separate]
        for y in a.measure:
            print(json.dumps(meter.measure(y, embeddings), ensure_ascii=False), flush=True)
        return
    if not (a.spec and a.text and a.output):
        p.error("--spec, --text and --output are required")

    import soundfile as sf
    import torch
    from voxcpm import VoxCPM

    spec, text = read(a.spec), read(a.text)
    output = Path(a.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
    sr = model.tts_model.sample_rate
    measurement = a.candidate > 1 or a.report
    embeddings = [meter.embedding(meter.load(y)) for y in a.separate] if measurement else []
    candidates = []
    for i in range(max(1, a.candidate)):
        seed = a.seed + i * 101
        b = time.time()
        torch.manual_seed(seed)
        wav = model.generate(text=f"({spec}){text}", cfg_value=2.0, inference_timesteps=10)
        path = output if a.candidate <= 1 else output.with_name(f"{output.stem}_{seed}{output.suffix}")
        temp = path.with_name(f".writing-{path.name}")
        sf.write(str(temp), wav, sr)
        os.replace(temp, path)
        candidate = {"seed": seed, "file": path.name, "duration": round(len(wav) / sr, 2), "generation_sec": round(time.time() - b, 1)}
        if measurement:
            candidate.update(meter.measure(str(path), embeddings))
            candidate["score"], candidate["reason"] = score(candidate, a.target, a.gender, a.type)
            print(f"candidate seed={seed} f0={candidate.get('f0')} age={candidate['age']} child={candidate['child']} female={candidate['female']} male={candidate['male']}"
                  f"{' similarity=' + str(candidate['similarity']) if 'similarity' in candidate else ''} score={candidate['score']}{' (' + candidate['reason'] + ')' if candidate['reason'] else ''}", flush=True)
        candidates.append(candidate)
    selected = max(candidates, key=lambda x: x.get("score", 0)) if measurement else candidates[0]
    if a.candidate > 1:
        shutil.copyfile(output.with_name(selected["file"]), output)
        print(f"selected seed={selected['seed']} score={selected.get('score')}", flush=True)
    if a.report:
        Path(a.report).write_text(json.dumps({"target": a.target, "gender": a.gender, "type": a.type, "separate": a.separate, "candidates": candidates, "selected": selected["seed"]}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"design: {selected['duration']} s -> {output}", flush=True)


if __name__ == "__main__":
    main()
