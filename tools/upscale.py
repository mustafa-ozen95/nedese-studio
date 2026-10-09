"""
Frame upscaling: upscales the PNG frames of a folder with a 2x AI model (spandrel: SPAN / ESRGAN / Compact), then covers
the target size (cropping the middle when the ratio differs) and scales down smoothly. Runs with the Python of ComfyUI
(torch and spandrel ready). Frame by frame: memory does not depend on the frame count. Prints "progress <percent> <text>"
for the panel and "result {json}" as the last line; an error as "ERROR: ...".

  python upscale.py --input frames --model 2xNomosUni_span_multijpg.safetensors --width 1920 --height 1080 [--output folder]

Video 1080p (Settings > Fine settings > Direct 1080p off): Wan generates 720p, this script upscales to 1920x1080.
"""
import argparse
import os
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from spandrel import ModelLoader


def error(message):
    print(f'ERROR: {message}', flush=True)
    sys.exit(1)


def cover(t, width, height):
    """t (1,3,H,W) is scaled until it covers the target, the overflow is cropped from the middle (aspect ratio kept)."""
    _, _, h, w = t.shape
    ratio = max(width / w, height / h)
    sw, sh = max(width, round(w * ratio)), max(height, round(h * ratio))
    t = F.interpolate(t, size=(sh, sw), mode='bicubic', antialias=True, align_corners=False)
    x0, y0 = (sw - width) // 2, (sh - height) // 2
    return t[:, :, y0:y0 + height, x0:x0 + width]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--output', default='', help='in place when empty')
    p.add_argument('--model', required=True)
    p.add_argument('--width', type=int, required=True)
    p.add_argument('--height', type=int, required=True)
    a = p.parse_args()
    source = Path(a.input)
    output = Path(a.output) if a.output else source
    output.mkdir(parents=True, exist_ok=True)
    # Frame files only (00001.png); temporary .writing.png files and _skip_ ones do not count
    frames = sorted(k for k in source.glob('*.png') if k.stem.isdigit())
    if not frames:
        error('No frames to upscale.')
    if not Path(a.model).exists():
        error(f'Upscale model missing: {a.model}')
    if not torch.cuda.is_available():
        error('No graphics card (CUDA) found.')
    m = ModelLoader().load_from_file(a.model)
    half = bool(m.supports_half)
    m = m.cuda().eval()
    if half:
        m = m.half()
    started = time.time()
    with torch.inference_mode():
        for i, path in enumerate(frames):
            target = output / path.name
            # On a retry a frame already upscaled (working in place) is skipped: upscaling and shrinking it again is
            # wasted work and extra sharpening
            with Image.open(path) as im:
                if target == path and im.size == (a.width, a.height):
                    continue
                g = np.asarray(im.convert('RGB'), dtype=np.float32) / 255.0
            t = torch.from_numpy(g).permute(2, 0, 1).unsqueeze(0).cuda()
            b = m(t.half() if half else t).float()
            b = cover(b, a.width, a.height).clamp_(0, 1)
            o = (b[0].permute(1, 2, 0).cpu().numpy() * 255.0 + 0.5).astype(np.uint8)
            # First to a temporary file, then into place: a cancel or shutdown must not leave a half PNG (every later
            # retry failed in Image.open)
            temp = target.with_name(target.stem + '.writing.png')
            Image.fromarray(o).save(temp, compress_level=1)
            os.replace(temp, target)
            if i % 8 == 0 or i == len(frames) - 1:
                print(f'progress {100 * (i + 1) // len(frames)} {i + 1}/{len(frames)} frames upscaled', flush=True)
    duration = time.time() - started
    print('result ' + json.dumps({'frames': len(frames), 'sec': round(duration, 1), 'secPerFrame': round(duration / len(frames), 3), 'half': half}), flush=True)


if __name__ == '__main__':
    main()
