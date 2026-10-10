"""Singing voice conversion: an existing song sung in another voice (e.g. an own voice from the library).

    python sing.py song.wav reference.wav output_folder [--steps 50] [--shift N] [--backing]

YingMusic-SVC (GiantAILab; code MIT, weights CC BY-NC 4.0; zero-shot, built on Seed-VC) in voice\\svc:
1. its BS-RoFormer separator splits the song into the lead vocal, backing vocals and the instrumental,
2. the lead vocal (and with --backing the backing vocals) is sung again in the reference's timbre; the melody stays,
   moved a whole octave into the reference voice's range (or not) unless --shift gives -12, 0 or 12; the
   instrumental keeps its key, so only octaves keep the vocal in tune.
Writes vocals.wav, backing.wav, instrumental.wav (44.1 kHz stereo) and sung.wav (+ sung-backing.wav; 44.1 kHz mono)
to the output folder; the panel mixes them with ffmpeg. A step whose file exists is skipped (a retry continues).
"""
import argparse
import os
import shutil
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent / 'svc'
SEPARATOR = ROOT / 'accom_separation'
# YingMusic-SVC-full.pt and bs_roformer.ckpt (the panel's models\singing; Settings > Models downloads them). The small
# helper models (RMVPE, CAM++, BigVGAN, Whisper small) are in svc\checkpoints (setup: voice-models.py svc).
MODELS = Path(os.environ.get('AI_SVC_MODEL') or ROOT / 'checkpoints')


def separate(song, out):
    """The song -> vocals.wav, backing.wav, instrumental.wav (the separator's three stems)."""
    import librosa
    import numpy as np
    import soundfile as sf
    import torch

    sys.modules.setdefault('wandb', types.ModuleType('wandb'))  # imported by the separator's training settings only
    sys.path.insert(0, str(SEPARATOR))
    from utils.model_utils import demix
    from utils.settings import get_model_from_config

    model, config = get_model_from_config('bs_roformer', str(SEPARATOR / 'ckpt' / 'bs_roformer' / 'config_bd_roformer.yaml'))
    state = torch.load(str(MODELS / 'bs_roformer.ckpt'), map_location='cpu', weights_only=False)
    model.load_state_dict(state['state_dict'] if 'state_dict' in state else state)
    model = model.to('cuda').eval()
    mix, sr = librosa.load(str(song), sr=44100, mono=False)
    if mix.ndim == 1:
        mix = np.stack([mix, mix])
    print('Separating the vocals', flush=True)
    stems = demix(config, model, mix, torch.device('cuda'), model_type='bs_roformer')
    for name, file in (('vocals', 'vocals.wav'), ('backing_vocal', 'backing.wav'), ('instrumental', 'instrumental.wav')):
        sf.write(str(out / file), stems[name].T, sr, subtype='FLOAT')
    del model
    torch.cuda.empty_cache()
    # The separator's top-level packages (utils, models) must not shadow the converter's
    for key in [k for k in sys.modules if k.split('.')[0] in ('utils', 'models')]:
        del sys.modules[key]
    sys.path.remove(str(SEPARATOR))


def convert(sources, reference, steps, shift):
    """Each (source, target) pair: the source vocal sung in the reference's timbre."""
    import torch

    # my_inference mixes the result with the accompaniment through torchaudio's sox effects (not on Windows): the
    # panel mixes with ffmpeg, so that module is not needed
    remix = types.ModuleType('Remix.auger')
    remix.echo_then_reverb_save = None
    sys.modules['Remix'] = types.ModuleType('Remix')
    sys.modules['Remix.auger'] = remix
    os.chdir(ROOT)  # the converter keeps its helper models under .\checkpoints
    sys.path.insert(0, str(ROOT))
    import soundfile as sf
    import torchaudio

    # torchaudio 2.9+ saves through torchcodec (not installed); the converter only writes WAVs
    torchaudio.save = lambda path, wave, sr: sf.write(str(path), wave.squeeze(0).numpy(), sr, subtype='FLOAT')
    import my_inference

    device = torch.device('cuda')
    args = argparse.Namespace(checkpoint=str(MODELS / 'YingMusic-SVC-full.pt'), config=str(ROOT / 'configs' / 'YingMusic-SVC.yml'),
                              fp16=True, f0_condition=True, length_adjust=1.0, inference_cfg_rate=0.7, diffusion_steps=steps,
                              semi_tone_shift=shift, target=str(reference), output=str(ROOT / 'outputs'), expname='panel')
    bundle = my_inference.load_models_api(args, device=device)
    for source, target in sources:
        print(f'Singing {source.name} in the new voice', flush=True)
        args.source = str(source)
        args.uuid = 'panel'
        written = my_inference.run_inference(args, bundle, device=device)
        match_level(source, written)
        shutil.move(written, target)


def match_level(stem, converted):
    """The converted vocal gets the separated stem's loudness (over the sung parts), so the mix keeps its balance."""
    import numpy as np
    import soundfile as sf

    def level(x):
        x = x.mean(axis=1) if x.ndim > 1 else x
        frames = x[: len(x) // 2048 * 2048].reshape(-1, 2048)
        rms = np.sqrt((frames ** 2).mean(axis=1))
        loud = rms[rms > rms.max() * 0.1]
        return float(np.sqrt((loud ** 2).mean())) if loud.size else 0.0

    a, _ = sf.read(str(stem))
    b, sr = sf.read(str(converted))
    want, have = level(a), level(b)
    if want > 0 and have > 0:
        b = np.clip(b * (want / have), -1, 1)
        sf.write(str(converted), b, sr, subtype='FLOAT')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('song')
    p.add_argument('reference', help='the voice to sing in (1-25 s of clean speech or singing)')
    p.add_argument('output')
    p.add_argument('--steps', type=int, default=50, help='diffusion steps (30-100)')
    p.add_argument('--shift', type=int, default=None, choices=(-12, 0, 12), help='octave change; automatic when left out')
    p.add_argument('--backing', action='store_true', help='sing the backing vocals in the new voice too')
    a = p.parse_args()
    out = Path(a.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    song, reference = Path(a.song).resolve(), Path(a.reference).resolve()
    if not all((out / f).exists() for f in ('vocals.wav', 'backing.wav', 'instrumental.wav')):
        separate(song, out)
    pairs = [(out / 'vocals.wav', out / 'sung.wav')] + ([(out / 'backing.wav', out / 'sung-backing.wav')] if a.backing else [])
    pairs = [x for x in pairs if not x[1].exists()]
    if pairs:
        convert(pairs, reference, a.steps, a.shift)
    print('Done', flush=True)


if __name__ == '__main__':
    main()
