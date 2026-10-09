"""Music LoRA training (panel "Model training" > Field: Music). Trains a LoRA on ACE-Step 1.5 base with Side-Step
(training\\sidestep, its own .venv; the command line trainer of the official ACE-Step 1.5 documentation); the LoRA is
exported to the ComfyUI format into models\\loras and chosen with ACE-Step 1.5 turbo in Music generation (tried: the
keys load, the output changes with the same seed).

Commands (printed lines follow the protocol of train.py: "progress <percent> <text>", "result <json>", "ERROR: <text>"):
  prepare --output <folder> [--trigger <word>] [--description <style>] [--language tr] <audio|txt|zip|folder>...
      Collects the audio files (wav/mp3/flac/ogg/opus/m4a; also from zips) under <folder>/audio; a .txt or .lyrics.txt
      of the same name gives the lyrics, .caption.txt the description (otherwise the general description);
      dataset.json (ACE-Step format, trigger).
  train --data <folder> --output <model folder> --name <lora name> --lora-folder <models\\loras> [--epoch N] ...
      Preprocessing (tensors), training (gradient checkpointing, AdamW 8-bit, encoder on the CPU; goes on from a
      checkpoint), export to ComfyUI (native, alpha = rank).
"""
from __future__ import annotations

import argparse
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
SIDESTEP = HERE / 'sidestep'
BASE = HERE / 'bases' / 'acestep'
AUDIO_EXTENSIONS = ('.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a')


def progress(percent: float, text: str) -> None:
    print(f'progress {int(max(0, min(100, percent)))} {text}', flush=True)


def error(text: str) -> None:
    print(f'ERROR: {text}', flush=True)
    sys.exit(2)


def result(data: dict) -> None:
    print('result ' + json.dumps(data, ensure_ascii=False), flush=True)


def clean(s: str) -> str:
    return re.sub(r'[ \t]+', ' ', str(s or '')).strip()


# ── Data ──────────────────────────────────────────────────────────────────

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
    folder = output / 'audio'
    folder.mkdir(parents=True, exist_ok=True)
    sounds: list[tuple[str, str, object]] = []  # (real name, extension, reader): read in turn, not all into memory
    zips: list[zipfile.ZipFile] = []
    texts: dict[str, str] = {}  # "<name>" or "<name>.lyrics" / "<name>.caption" -> text
    actual = lambda s: re.sub(r'^\d{8}-\d{6}-veri-', '', s)  # prefix of a panel upload
    for d in open_files(a.files):
        p = Path(d)
        if p.suffix.lower() == '.zip':
            z = zipfile.ZipFile(p)
            zips.append(z)
            for name in z.namelist():
                sub = Path(name)
                if name.endswith('/') or sub.name.startswith('.') or '__MACOSX' in name:
                    continue
                if sub.suffix.lower() in AUDIO_EXTENSIONS:
                    sounds.append((sub.stem, sub.suffix.lower(), lambda z=z, name=name: z.read(name)))
                elif sub.suffix.lower() == '.txt':
                    texts[actual(sub.name[:-4])] = z.read(name).decode('utf-8', 'replace')
        elif p.suffix.lower() in AUDIO_EXTENSIONS:
            sounds.append((actual(p.stem), p.suffix.lower(), p.read_bytes))
        elif p.suffix.lower() == '.txt':
            texts[actual(p.name[:-4])] = p.read_text(encoding='utf-8', errors='replace')
    trigger = clean(a.trigger)
    examples = []
    for no, (name, ext, reader) in enumerate(sounds, 1):
        file = f'{no:04d}{ext}'
        (folder / file).write_bytes(reader())
        lyric = texts.get(f'{name}.lyrics') or texts.get(name) or ''
        # The style description starts every song's description: the file's own (in a collection often only
        # "Song by Artist") may not describe the style; otherwise the style description, otherwise the file name
        custom = clean(texts.get(f'{name}.caption') or '')
        general = clean(a.description)
        if custom and general and general.lower() not in custom.lower():
            spec = f'{general}, {custom}'
        else:
            spec = custom or general or clean(name.replace('_', ' ').replace('-', ' '))
        lyric = lyric.strip()
        examples.append({
            'audio_path': f'./audio/{file}', 'filename': file, 'caption': spec, 'lyrics': lyric or '[Instrumental]',
            'language': a.language, 'is_instrumental': not lyric, 'custom_tag': trigger, 'labeled': True,
        })
    if len(examples) < 2:
        error(f'At least 2 songs/audio files are needed ({len(examples)} found). Upload WAV/MP3/FLAC/OGG/M4A or a .zip of them.')
    data_json = {'metadata': {'name': output.name, 'custom_tag': trigger, 'tag_position': 'prepend', 'num_samples': len(examples),
                              'all_instrumental': all(o['is_instrumental'] for o in examples)}, 'samples': examples}
    (output / 'dataset.json').write_text(json.dumps(data_json, ensure_ascii=False, indent=1), encoding='utf-8')
    summary = {'songs': len(examples), 'spoken': sum(not o['is_instrumental'] for o in examples), 'trigger': trigger, 'exampleSpec': examples[0]['caption'], 'language': a.language}
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False), encoding='utf-8')
    progress(100, f'{len(examples)} audio files ready ({summary["spoken"]} with lyrics)')
    result(summary)


# ── Training ──────────────────────────────────────────────────────────────

def download_bases() -> None:
    """ACE-Step 1.5 base DiT (4.5 GB) + Qwen3-Embedding 0.6B + VAE: once, on the first training (not gated)."""
    from huggingface_hub import snapshot_download

    if not (BASE / 'acestep-v15-base' / 'model.safetensors').exists():
        progress(1, 'Downloading ACE-Step 1.5 base (first time, ~4.5 GB)')
        snapshot_download('ACE-Step/acestep-v15-base', local_dir=str(BASE / 'acestep-v15-base'))
    if not (BASE / 'vae').exists() or not (BASE / 'Qwen3-Embedding-0.6B').exists():
        progress(1, 'Downloading the text encoder and the VAE (first time, ~1.4 GB)')
        snapshot_download('ACE-Step/Ace-Step1.5', allow_patterns=['Qwen3-Embedding-0.6B/*', 'vae/*', 'config.json'], local_dir=str(BASE))


def sidestep(args: list[str], stage: str, started: float, last: float, total: int = 0, loss_file: Path | None = None) -> list[float]:
    """Runs the Side-Step command line; progress from its "Epoch X/Y ... Loss" lines. Returns the losses in epoch
    order. With loss_file the losses are written there too: a paused and resumed training keeps the earlier ones."""
    exe = SIDESTEP / '.venv' / 'Scripts' / 'sidestep.exe'
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'PYTHONUNBUFFERED': '1', 'NO_COLOR': '1'}
    s = subprocess.Popen([str(exe), '--plain', '--yes', *args], cwd=str(SIDESTEP), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    last_lines: list[str] = []
    losses: dict[int, float] = {}  # epoch -> loss (two lines of the same epoch are one value)
    if loss_file and loss_file.exists():
        try:
            losses = {int(k): float(v) for k, v in json.loads(loss_file.read_text(encoding='utf-8')).items()}
        except (ValueError, OSError):
            losses = {}
    save = lambda: loss_file and loss_file.write_text(json.dumps(losses), encoding='utf-8')
    first: tuple[int, float] | None = None  # first epoch seen and its time: the speed leaves out the model loading
    last_written = 0.0
    for raw in iter(s.stdout.readline, b''):
        line = raw.decode('utf-8', 'replace').strip()
        if not line:
            continue
        last_lines = (last_lines + [line])[-40:]
        m = re.search(r'Epoch (\d+)/(\d+).*?Loss: ([\d.]+)', line)
        if m:
            n, t, loss = int(m.group(1)), int(m.group(2)), float(m.group(3))
            losses[n] = loss
            if first is None:
                first = (n, time.time())
            if time.time() - last_written > 3:
                t = total or t
                text = f'{stage} {n}/{t} · loss {loss:.4f}'
                if n > first[0]:
                    remaining = (time.time() - first[1]) / (n - first[0]) * max(0, t - n)
                    text += f' · ~{int(remaining // 60)} min {int(remaining % 60)} s left'
                progress(started + (last - started) * n / max(1, t), text)
                save()
                last_written = time.time()
        elif re.search(r'Error|Traceback|out of memory|\[ERROR\]|\[FAIL', line):
            print(line, flush=True)
    code = s.wait()
    if code != 0:
        text = '\n'.join(last_lines)
        reason = next((x for x in reversed(last_lines) if re.search(r'Error|ERROR|FAIL|memory', x)), last_lines[-1] if last_lines else f'code {code}')
        if re.search(r'out of memory', text, re.I):
            error(f'{stage}: the graphics card ran out of memory; try shorter songs or a smaller LoRA size. ({reason[:200]})')
        error(f'{stage} failed: {reason[:300]}')
    save()
    return [losses[k] for k in sorted(losses)]


def last_checkpoint(output: Path) -> tuple[Path | None, int]:
    """Checkpoint: <output>/checkpoints/epoch_N (the largest N with a training_state)."""
    latest, epoch = None, 0
    for d in (output / 'checkpoints').glob('epoch_*'):
        m = re.fullmatch(r'epoch_(\d+)', d.name)
        if m and (d / 'training_state.pt').exists() and int(m.group(1)) > epoch:
            latest, epoch = d, int(m.group(1))
    return latest, epoch


def train_command(a) -> None:
    if not (SIDESTEP / '.venv' / 'Scripts' / 'sidestep.exe').exists():
        error('The music training environment is not installed (training\\sidestep\\.venv; setup\\setup.ps1).')
    try:
        download_bases()
    except Exception as e:
        error(f'The ACE-Step training files could not be downloaded: {str(e)[:200]}')
    data, output = Path(a.data), Path(a.output)
    output.mkdir(parents=True, exist_ok=True)
    tensor = output / 'tensor'
    training = output / 'training'
    common = ['--checkpoint-dir', str(BASE), '--model', 'base']
    o = json.loads((data / 'summary.json').read_text(encoding='utf-8'))
    if not (tensor / 'preprocess_meta.json').exists():
        progress(3, f'Preprocessing {o["voice"]} audio files (VAE + text encoder; two passes)')
        sidestep(['preprocess', *common, '--audio-dir', str(data / 'audio'), '--dataset-json', str(data / 'dataset.json'),
                  '--output', str(tensor), '--normalize', 'peak', '--max-duration', str(a.longest)], 'Preprocessing', 3, 12)
    # Epochs: the ACE-Step guide says ~10-20 songs 800, ~100 songs 500 (one update per epoch)
    epoch = a.epoch or (800 if o['voice'] <= 20 else 500 if o['voice'] <= 100 else 300)
    checkpoint, done = last_checkpoint(training)
    loss_file = output / 'losses.json'
    if not checkpoint:
        loss_file.unlink(missing_ok=True)  # a new training: the losses of an earlier try must not mix in
    arg = ['train', *common, '--dataset-dir', str(tensor), '--adapter', 'lora', '--rank', str(a.rank), '--alpha', str(a.rank * 2),
           '--lr', str(a.ratio), '--epochs', str(epoch), '--batch-size', '1', '--optimizer-type', 'adamw8bit',
           *([] if a.no_gradient else ['--gradient-checkpointing']), *([] if a.encoder_gpu else ['--offload-encoder']),
           '--output-dir', str(training), '--save-every', str(max(10, epoch // 10)),
           '--run-name', a.name, '--log-every', '1', '--seed', '42']
    if checkpoint:
        progress(12, f'Resuming from checkpoint: epoch {done}/{epoch}')
        arg += ['--resume-from', str(checkpoint)]
    elif a.previous:
        arg += ['--resume-from', str(a.previous)]  # from an existing LoRA (improve)
    started = time.time()
    losses = sidestep(arg, 'Training epoch', 12, 92, total=epoch, loss_file=loss_file)
    last = next((d for d in (training / 'final', training / 'early_exit') if (d / 'adapter_model.safetensors').exists()), None)
    if not last:
        error('Training finished but no LoRA was found (final/).')
    target_folder = Path(a.lora_folder)
    target_folder.mkdir(parents=True, exist_ok=True)
    target = target_folder / f'{a.name}.safetensors'
    temp = target_folder / f'{a.name}.writing.safetensors'
    progress(94, 'Exporting to the ComfyUI format')
    sidestep(['export', str(last), '--output', str(temp), '--target', 'native', '--normalize-alpha'], 'Export', 94, 96)
    os.replace(temp, target)
    shutil.copytree(last, output / 'adaptor', dirs_exist_ok=True)  # the PEFT form: "Improve with this" goes on from it
    for d in (training / 'checkpoints').glob('epoch_*'):
        shutil.rmtree(d, ignore_errors=True)
    info = {'lora': target.name, 'epoch': epoch, 'durationSec': round(time.time() - started), 'losses': losses[-200:],
            'songs': o['songs'], 'rank': a.rank, 'sizeMb': round(target.stat().st_size / 2 ** 20, 1)}
    (output / 'training.json').write_text(json.dumps(info, ensure_ascii=False), encoding='utf-8')
    progress(97, f'LoRA ready: {target.name} ({info["sizeMb"]} MB)')
    result(info)


def main() -> None:
    p = argparse.ArgumentParser(description='Music LoRA training (Side-Step, ACE-Step 1.5)')
    sub = p.add_subparsers(dest='command', required=True)
    h = sub.add_parser('prepare')
    h.add_argument('--output', required=True)
    h.add_argument('--trigger', default='')
    h.add_argument('--description', default='')
    h.add_argument('--language', default='tr')
    h.add_argument('files', nargs='+')
    e = sub.add_parser('train')
    e.add_argument('--data', required=True)
    e.add_argument('--output', required=True)
    e.add_argument('--name', required=True)
    e.add_argument('--lora-folder', required=True)
    e.add_argument('--epoch', type=int, default=0)
    e.add_argument('--rank', type=int, default=32)
    e.add_argument('--ratio', type=float, default=1e-4)
    e.add_argument('--longest', type=int, default=240, help='seconds: longer audio is cut')
    e.add_argument('--previous', default='')
    e.add_argument('--no-gradient', action='store_true', help='gradient checkpointing off (large card)')
    e.add_argument('--encoder-gpu', action='store_true', help='the encoder stays on the graphics card (no --offload-encoder)')
    a = p.parse_args()
    if a.command == 'prepare':
        prepare_command(a)
    else:
        if not re.fullmatch(r'[\w.-]+', a.name):
            error('The LoRA name may have only letters, digits, dot, dash and underscore.')
        train_command(a)


if __name__ == '__main__':
    main()
