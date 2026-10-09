"""Cloning your own voice, step 2: LoRA fine-tune of VoxCPM2 (voice\\voxcpm\\.venv).

    python train.py --data <prepare.py folder> [--step 400]

Uses training.jsonl of prepare.py; the official training script (upstream\\train_voxcpm_finetune.py, VoxCPM 2.0.3) runs
on one graphics card on Windows (num_workers=0). Output: <data>\\lora\\latest\\ (lora_weights.safetensors +
lora_config.json). Without --step the step count follows the amount of data.
Lines printed for the panel: "progress <percent> <description>", "ERROR: <message>" on failure.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault('HF_HOME', str(HERE.parent / 'hf'))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--data', required=True)
    p.add_argument('--step', type=int, default=0)
    # Panel fine setting (large card): the original batch setting of VoxCPM (1 x 4, 4096 tokens on 12 GB)
    p.add_argument('--large-batch', action='store_true')
    a = p.parse_args()
    data = Path(a.data).resolve()
    summary = json.loads((data / 'summary.json').read_text(encoding='utf-8'))
    if not summary.get('enoughForTraining'):
        sys.exit(f"ERROR: Training needs at least {summary.get('trainingMinSec', 60)} s of clean speech; the recording has {summary.get('speechSec')} s.")

    from huggingface_hub import snapshot_download

    model_path = snapshot_download('openbmb/VoxCPM2', revision='32279effe8c19989596f05d353d1447f51d9e915')
    # Steps: 300 for ~2 min of data, 1000 for 10 min+ (upper limit; more risks memorizing).
    step = a.step or int(min(1000, max(300, summary['speechSec'] * 2)))
    record = data / 'lora'
    setting = f"""pretrained_path: {json.dumps(model_path.replace(os.sep, '/'))}
train_manifest: {json.dumps(str(data / 'training.jsonl').replace(os.sep, '/'))}
val_manifest: ""
sample_rate: 16000
out_sample_rate: 48000
batch_size: {2 if a.large_batch else 1}
grad_accum_steps: {8 if a.large_batch else 4}
num_workers: 0
num_iters: {step}
log_interval: 10
valid_interval: {step + 1}
save_interval: {step}
learning_rate: 0.0001
weight_decay: 0.01
warmup_steps: {max(10, step // 10)}
max_steps: {step}
max_batch_tokens: {8192 if a.large_batch else 4096}
max_grad_norm: 1.0
save_path: {json.dumps(str(record).replace(os.sep, '/'))}
tensorboard: ""
lambdas:
  loss/diff: 1.0
  loss/stop: 1.0
lora:
  enable_lm: true
  enable_dit: true
  enable_proj: false
  r: 32
  alpha: 32
  dropout: 0.0
"""
    (data / 'training.yaml').write_text(setting, encoding='utf-8')
    print(f'progress 1 Training starts: {step} steps', flush=True)
    command = [sys.executable, str(HERE / 'upstream' / 'train_voxcpm_finetune.py'), '--config_path', str(data / 'training.yaml')]
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONUNBUFFERED': '1'}
    s = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', env=env)
    last = []
    for line in s.stdout:
        line = line.rstrip()
        last = (last + [line])[-30:]
        # Training log: percent from lines like "step 120/400 ...".
        m = re.search(r'\b(?:step|iter(?:ation)?)\D{0,3}(\d+)\s*/\s*(\d+)', line, re.I) or re.search(r'\bstep[=: ]+(\d+)', line, re.I)
        if m:
            now = int(m.group(1))
            print(f'progress {max(1, min(99, round(now * 100 / step)))} Training: step {now}/{step}', flush=True)
        print(line, flush=True)
    s.wait()
    target = record / 'latest'
    weight = target / 'lora_weights.safetensors'
    if not weight.exists():
        weight = target / 'lora_weights.ckpt'
    if s.returncode != 0 or not weight.exists():
        sys.exit('ERROR: Training failed.\n' + '\n'.join(last[-10:]))
    print('progress 100 Training done', flush=True)
    print(json.dumps({'lora': str(target), 'step': step}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
