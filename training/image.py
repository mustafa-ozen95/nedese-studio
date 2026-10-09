"""Image LoRA training (panel "Model training" > Field: Image). Trains a LoRA for FLUX.2 [klein] 4B with musubi-tuner
(training\\musubi, its own .venv); the result goes to the LoRA folder of ComfyUI (models\\loras) and is chosen with
FLUX.2 klein in Image generation.

Commands (printed lines follow the protocol of train.py: "progress <percent> <text>", "result <json>", "ERROR: <text>"):
  prepare --output <folder> [--trigger <word>] [--description <text>] <file|zip|folder>...
      Collects the images (png/jpg/jpeg/webp; also from zips) under <folder>/images, shrinks the long side to 2048,
      takes the caption from the .txt of the same name (otherwise "<trigger>, <description>"). The trigger word starts
      every caption.
  train --data <folder> --output <model folder> --name <lora name> --lora-folder <models\\loras> [--step N] ...
      Caches the latents (VAE, text encoder), trains the LoRA. Training runs on the base (undistilled) model (as musubi
      recommends); the LoRA also works with the 4-step distilled klein. A checkpoint every N steps: a stopped job goes on
      from its step. --previous <lora>: improves an existing LoRA.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MUSUBI = HERE / 'musubi'
IMAGE_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp')
MODELS = {
    # model_version, DiT (base, for training), first part of the text encoder, default resolution
    'klein-4b': {
        'version': 'klein-base-4b',
        'dit': HERE / 'bases' / 'flux2-klein-base-4b' / 'flux-2-klein-base-4b.safetensors',
        'text': HERE / 'bases' / 'flux2-klein-4b' / 'text_encoder' / 'model-00001-of-00002.safetensors',
        'resolution': 1024,
        'max_swap': 13,
    },
}


def progress(percent: float, text: str) -> None:
    print(f'progress {int(max(0, min(100, percent)))} {text}', flush=True)


def error(text: str) -> None:
    print(f'ERROR: {text}', flush=True)
    sys.exit(2)


def result(data: dict) -> None:
    print('result ' + json.dumps(data, ensure_ascii=False), flush=True)


# ── Data ──────────────────────────────────────────────────────────────────

def clean_caption(s: str) -> str:
    return re.sub(r'\s+', ' ', str(s or '')).strip()


def save_image(data: bytes, target: Path) -> bool:
    """Opens the image to see that it reads, shrinks it when the long side is over 2048, writes it as PNG."""
    from PIL import Image, ImageOps

    try:
        g = Image.open(io.BytesIO(data))
        g = ImageOps.exif_transpose(g)
        g.load()
    except Exception:
        return False
    if min(g.size) < 256:
        return False  # icon/thumbnail: teaches nothing, spoils
    if max(g.size) > 2048:
        g.thumbnail((2048, 2048))
    if g.mode not in ('RGB', 'L'):
        back = Image.new('RGB', g.size, (255, 255, 255))
        back.paste(g, mask=g.split()[-1] if g.mode in ('RGBA', 'LA') else None)
        g = back
    g.convert('RGB').save(target.with_suffix('.png'))
    return True


def open_files(paths):
    """A folder gives the files in it (a data collection: media + a caption .txt of the same name)."""
    for d in paths:
        p = Path(d)
        if p.is_dir():
            yield from sorted(str(q) for q in p.rglob('*') if q.is_file() and not q.name.startswith('.'))
        else:
            yield d


def prepare_command(a) -> None:
    output = Path(a.output)
    folder = output / 'images'
    folder.mkdir(parents=True, exist_ok=True)
    trigger = clean_caption(a.trigger)
    description = clean_caption(a.description)
    # (name, reader): files are not read into memory at once but in turn (a big collection raised MemoryError)
    inputs: list[tuple[str, object]] = []
    captions: dict[str, str] = {}
    zips: list[zipfile.ZipFile] = []
    for d in open_files(a.files):
        p = Path(d)
        if p.suffix.lower() == '.zip':
            z = zipfile.ZipFile(p)
            zips.append(z)
            for name in z.namelist():
                sub = Path(name)
                if name.endswith('/') or sub.name.startswith('.') or '__MACOSX' in name:
                    continue
                if sub.suffix.lower() in IMAGE_EXTENSIONS:
                    inputs.append((sub.stem, lambda z=z, name=name: z.read(name)))
                elif sub.suffix.lower() == '.txt':
                    captions[sub.stem] = z.read(name).decode('utf-8', 'replace')
        elif p.suffix.lower() in IMAGE_EXTENSIONS:
            inputs.append((p.stem, p.read_bytes))
        elif p.suffix.lower() == '.txt':
            captions[p.stem] = p.read_text(encoding='utf-8', errors='replace')
    # A panel upload is named "<stamp>-veri-<name>": captions match by the real name
    actual = lambda s: re.sub(r'^\d{8}-\d{6}-veri-', '', s)
    captions = {actual(k): v for k, v in captions.items()}
    count, captioned = 0, 0
    for no, (name, reader) in enumerate(inputs, 1):
        target = folder / f'{no:04d}.png'
        if not save_image(reader(), target):
            continue
        text = clean_caption(captions.get(actual(name), ''))
        if text:
            captioned += 1
        parts = [trigger] if trigger and not text.lower().startswith(trigger.lower()) else []
        parts += [text or description]
        (folder / f'{no:04d}.txt').write_text(', '.join(x for x in parts if x) or 'image', encoding='utf-8')
        count += 1
        progress(100 * no / max(1, len(inputs)), f'{count} images ready')
    if count < 3:
        error(f'At least 3 images are needed ({count} could be read). Upload PNG/JPEG/WebP or a .zip of them; the short side at least 256 pixels.')
    summary = {'image': count, 'captioned': captioned, 'trigger': trigger, 'exampleCaption': (folder / '0001.txt').read_text(encoding='utf-8') if (folder / '0001.txt').exists() else ''}
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False), encoding='utf-8')
    result(summary)


# ── Training ──────────────────────────────────────────────────────────────

def run(args: list[str], stage: str, started: float, last: float, step_total: int = 0, step_start: int = 0) -> list[str]:
    """Runs a musubi script; progress and loss come from its tqdm lines. Returns the last 40 lines."""
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'PYTHONUNBUFFERED': '1'}
    s = subprocess.Popen(args, cwd=str(MUSUBI), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    last_lines: list[str] = []
    buffer = b''
    last_written = 0.0
    start = time.time()
    losses: list[float] = []
    while True:
        part = s.stdout.read1(4096) if hasattr(s.stdout, 'read1') else s.stdout.read(4096)
        if not part:
            break
        buffer += part
        lines = re.split(rb'[\r\n]', buffer)
        buffer = lines.pop()
        for raw in lines:
            line = raw.decode('utf-8', 'replace').strip()
            if not line:
                continue
            last_lines = (last_lines + [line])[-40:]
            m = re.search(r'(\d+)/(\d+) \[[^\]]*?(?:avr_loss=([\d.]+))?\]', line)
            if m and time.time() - last_written > 3:
                n, t = int(m.group(1)), int(m.group(2))
                loss = m.group(3)
                if loss:
                    losses.append(float(loss))
                elapsed = time.time() - start
                remaining = elapsed / max(1, n) * (t - n) if n else 0
                real = step_start + n
                total = step_total or t
                text = f'{stage} {real}/{total}' if step_total else f'{stage} {n}/{t}'
                if loss:
                    text += f' · loss {float(loss):.4f}'
                if n:
                    text += f' · ~{int(remaining // 60)} min {int(remaining % 60)} s left'
                progress(started + (last - started) * n / max(1, t), text)
                last_written = time.time()
            elif re.search(r'Error|error:|Traceback|out of memory', line):
                print(line, flush=True)
    code = s.wait()
    if code != 0:
        reason = next((x for x in reversed(last_lines) if re.search(r'Error|error|memory', x)), last_lines[-1] if last_lines else f'code {code}')
        if re.search(r'out of memory|CUDA error: out of memory', '\n'.join(last_lines)):
            error(f'{stage}: the graphics card ran out of memory. Lower the resolution (e.g. 768) or the LoRA size. ({reason[:200]})')
        error(f'{stage} failed: {reason[:300]}')
    run.losses = losses
    return last_lines


def last_state(output: Path, name: str) -> tuple[Path | None, int]:
    """The latest checkpoint folder and its step (musubi: <name>-step00000100-state)."""
    latest, step = None, 0
    for d in output.glob(f'{name}-step*-state'):
        m = re.search(r'-step(\d+)-state$', d.name)
        if m and d.is_dir() and int(m.group(1)) > step:
            latest, step = d, int(m.group(1))
    return latest, step


def bfl_vae(vae: Path) -> Path:
    """musubi wants the VAE with the original (BFL) names; flux2-vae.safetensors of ComfyUI has diffusers names.
    Converted once (training\\bases\\flux2-ae\\ae.safetensors; same weights, round trip 41 dB PSNR)."""
    target = HERE / 'bases' / 'flux2-ae' / 'ae.safetensors'
    if target.exists():
        return target
    from safetensors import safe_open

    with safe_open(str(vae), 'pt') as f:
        diffusers = any(k.startswith('encoder.down_blocks.') for k in f.keys())
    if not diffusers:
        return vae
    progress(1, 'Converting the VAE to the training format (once)')
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + '.writing')
    r = subprocess.run([str(MUSUBI / '.venv' / 'Scripts' / 'python.exe'), str(HERE / 'vae_convert.py'), str(vae), str(temp)], cwd=str(MUSUBI / 'src'), capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        temp.unlink(missing_ok=True)
        error('The VAE could not be converted: ' + ((r.stderr or r.stdout).strip().splitlines() or ['?'])[-1][:200])
    os.replace(temp, target)
    return target


def download_bases(m: dict) -> None:
    """The training files come from Hugging Face when missing (Apache 2.0, no approval): base 4B DiT ~7.2 GB +
    Qwen3 4B text encoder ~7.5 GB. Once, on the first image training."""
    from huggingface_hub import hf_hub_download, snapshot_download

    if not m['dit'].exists():
        progress(1, f'Downloading the training model (first time, ~7 GB): {m["dit"].name}')
        hf_hub_download('black-forest-labs/FLUX.2-klein-base-4B', m['dit'].name, local_dir=str(m['dit'].parent))
    if not m['text'].exists():
        progress(1, 'Downloading the text encoder (first time, ~7.5 GB): Qwen3 4B')
        snapshot_download('black-forest-labs/FLUX.2-klein-4B', allow_patterns=['text_encoder/*', 'tokenizer/*'], local_dir=str(m['text'].parent.parent))


def train_command(a) -> None:
    m = MODELS[a.model]
    if not m['dit'].exists() or not m['text'].exists():
        try:
            download_bases(m)
        except Exception as e:  # no network etc.
            error(f'The training files could not be downloaded: {str(e)[:200]}')
    if Path(a.vae).exists():
        a.vae = str(bfl_vae(Path(a.vae)))
    for name, path in (('Base model for training', m['dit']), ('Text encoder', m['text']), ('VAE', Path(a.vae))):
        if not Path(path).exists():
            error(f'{name} not found: {path} (setup: the image training part of setup\\setup.ps1)')
    py = MUSUBI / '.venv' / 'Scripts' / 'python.exe'
    if not py.exists():
        error('The image training environment is not installed (training\\musubi\\.venv; setup\\setup.ps1).')
    data = Path(a.data)
    output = Path(a.output)
    output.mkdir(parents=True, exist_ok=True)
    images = sorted((data / 'images').glob('*.png'))
    if not images:
        error('No prepared images (run prepare first).')
    resolution = a.resolution or m['resolution']
    # Steps: ~60 per image (at least 400, at most 2000). Measured 05.10.2026 (RTX 5070, 1024 px, fp8): ~5 s/step,
    # peak 7.3 GB; 20 images 1200 steps ~1.7 hours.
    total = a.step or max(400, min(2000, 60 * len(images)))
    toml = output / 'dataset.toml'
    toml.write_text(
        '[general]\n'
        f'resolution = [{resolution}, {resolution}]\n'
        'caption_extension = ".txt"\nbatch_size = 1\nenable_bucket = true\nbucket_no_upscale = true\n\n'
        '[[datasets]]\n'
        f'image_directory = "{(data / "images").as_posix()}"\n'
        f'cache_directory = "{(output / "cache").as_posix()}"\n'
        'num_repeats = 1\n', encoding='utf-8')
    source = MUSUBI / 'src' / 'musubi_tuner'
    common = ['--dataset_config', str(toml), '--model_version', m['version']]
    progress(2, f'{len(images)} images; computing the latents (VAE)')
    run([str(py), str(source / 'flux_2_cache_latents.py'), *common, '--vae', str(a.vae), '--vae_dtype', 'bfloat16', '--skip_existing'], 'Encoding images', 2, 8)
    progress(8, 'Encoding captions (Qwen3 4B, fp8)')
    # --full-precision (panel fine setting, large card): text encoder and base model not in fp8
    fp8 = [] if a.full_precision else ['--fp8_text_encoder']
    run([str(py), str(source / 'flux_2_cache_text_encoder_outputs.py'), *common, '--text_encoder', str(m['text']), '--batch_size', '4', *fp8, '--skip_existing'], 'Encoding captions', 8, 12)

    training = output / 'training'
    state, done = last_state(training, a.name)
    remaining = max(1, total - done)
    if state:
        progress(12, f'Resuming from checkpoint: step {done}/{total}')
    save_every = max(50, min(250, total // 10))
    swap = max(0, min(m['max_swap'], a.swap))
    arg = [str(py), '-m', 'accelerate.commands.launch', '--num_processes', '1', '--num_cpu_threads_per_process', '1', '--mixed_precision', 'bf16',
           str(source / 'flux_2_train_network.py'), *common,
           '--dit', str(m['dit']), '--vae', str(a.vae), '--text_encoder', str(m['text']), '--vae_dtype', 'bfloat16',
           '--sdpa', '--mixed_precision', 'bf16', *([] if a.full_precision else ['--fp8_base', '--fp8_scaled']),
           *([] if a.no_gradient else ['--gradient_checkpointing']),
           '--timestep_sampling', 'flux2_shift', '--weighting_scheme', 'none',
           '--optimizer_type', 'adamw8bit', '--learning_rate', str(a.ratio),
           '--network_module', 'networks.lora_flux_2', '--network_dim', str(a.rank), '--network_alpha', str(a.rank),
           '--max_train_steps', str(remaining), '--save_every_n_steps', str(save_every), '--save_state', '--save_last_n_steps_state', '1',
           '--max_data_loader_n_workers', '1', '--seed', '42', '--output_dir', str(training), '--output_name', a.name]
    if swap:
        arg += ['--blocks_to_swap', str(swap)]
    if state:
        arg += ['--resume', str(state)]
    elif a.previous:
        arg += ['--network_weights', str(a.previous)]
    start_time = time.time()
    run(arg, 'Training step', 12, 95, step_total=total, step_start=done)
    result_file = training / f'{a.name}.safetensors'
    if not result_file.exists():
        candidates = sorted(training.glob(f'{a.name}*.safetensors'), key=lambda p: p.stat().st_mtime)
        if not candidates:
            error('Training finished but the LoRA file was not found.')
        result_file = candidates[-1]
    target_folder = Path(a.lora_folder)
    target_folder.mkdir(parents=True, exist_ok=True)
    target = target_folder / f'{a.name}.safetensors'
    temp = target.with_name(target.name + '.writing')
    shutil.copyfile(result_file, temp)
    os.replace(temp, target)
    for d in training.glob(f'{a.name}-step*-state'):  # done: the checkpoints are not needed
        shutil.rmtree(d, ignore_errors=True)
    info = {'lora': target.name, 'step': total, 'durationSec': round(time.time() - start_time), 'losses': getattr(run, 'losses', [])[-200:],
            'image': len(images), 'resolution': resolution, 'rank': a.rank, 'sizeMb': round(target.stat().st_size / 2 ** 20, 1)}
    (output / 'training.json').write_text(json.dumps(info, ensure_ascii=False), encoding='utf-8')
    progress(96, f'LoRA ready: {target.name} ({info["sizeMb"]} MB)')
    result(info)


def main() -> None:
    p = argparse.ArgumentParser(description='Image LoRA training (musubi-tuner, FLUX.2 klein)')
    sub = p.add_subparsers(dest='command', required=True)
    h = sub.add_parser('prepare')
    h.add_argument('--output', required=True)
    h.add_argument('--trigger', default='')
    h.add_argument('--description', default='')
    h.add_argument('files', nargs='+')
    e = sub.add_parser('train')
    e.add_argument('--data', required=True)
    e.add_argument('--output', required=True)
    e.add_argument('--name', required=True)
    e.add_argument('--lora-folder', required=True)
    e.add_argument('--vae', required=True)
    e.add_argument('--model', default='klein-4b', choices=list(MODELS))
    e.add_argument('--step', type=int, default=0)
    e.add_argument('--rank', type=int, default=16)
    e.add_argument('--ratio', type=float, default=1e-4)
    e.add_argument('--resolution', type=int, default=0)
    e.add_argument('--swap', type=int, default=0, help='blocks moved to the CPU (when memory is short)')
    e.add_argument('--previous', default='')
    e.add_argument('--full-precision', action='store_true', help='base model not in fp8 (large card)')
    e.add_argument('--no-gradient', action='store_true', help='gradient checkpointing off (large card)')
    a = p.parse_args()
    if a.command == 'prepare':
        prepare_command(a)
    else:
        if not re.fullmatch(r'[\w.-]+', a.name):
            error('The LoRA name may have only letters, digits, dot, dash and underscore.')
        train_command(a)


if __name__ == '__main__':
    main()
