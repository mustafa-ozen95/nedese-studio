"""
Game sprites from transparent pictures (the Game assets job; ComfyUI's python: Pillow and numpy are there):
  python sprites.py --folder out --names idle walk ... --cell 512 --padding 8 --anchor bottom
- Reads <folder>/cutout_<name>.png (RGBA) for every name.
- Writes <folder>/sprite_<name>.png: the picture trimmed to the figure (alpha > 8), with the half-transparent halo of the
  mask's edge cleaned (colour of the opaque neighbours spread into texels that are nearly transparent).
- Writes <folder>/sheet.png and <folder>/atlas.json: every sprite scaled by ONE common factor (the poses keep their
  relative size) into square cells, anchored bottom-centre (characters, vehicles: the feet stay on one line) or in the
  centre; the atlas lists the frame rectangles, the pivot and the scale.
- Prints "progress <done>/<total> <text>" lines and a last line "RESULT {json}".
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image

ALPHA_CUT = 8


def args():
    p = argparse.ArgumentParser()
    p.add_argument('--folder', required=True)
    p.add_argument('--names', nargs='+', required=True)
    p.add_argument('--cell', type=int, default=512)
    p.add_argument('--padding', type=int, default=8)
    p.add_argument('--anchor', choices=('bottom', 'center'), default='bottom')
    p.add_argument('--columns', type=int, default=0)
    return p.parse_args()


def clean_edge(image):
    """Texels that are nearly transparent take the colour of the nearest opaque ones (no dark/grey fringe when scaled)."""
    a = np.asarray(image).astype(np.float32)
    alpha = a[..., 3]
    solid = alpha > 200
    if not solid.any() or solid.all():
        return image
    colour = a[..., :3].copy()
    # a few rounds of spreading the solid colours outwards
    known = solid.copy()
    for _ in range(6):
        grown = np.zeros_like(colour)
        count = np.zeros(known.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                k = np.roll(np.roll(known, dy, 0), dx, 1)
                c = np.roll(np.roll(colour * known[..., None], dy, 0), dx, 1)
                grown += c
                count += k
        take = (~known) & (count > 0)
        colour[take] = grown[take] / count[take][..., None]
        known = known | take
    # BiRefNet's probabilities leave the inside of the figure at 250-254: made fully opaque (a game blends sprites)
    a[..., 3] = np.where(alpha >= 240, 255, alpha)
    weak = alpha < 200
    a[..., :3][weak] = colour[weak]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')


def main():
    a = args()
    sprites = []
    for i, name in enumerate(a.names):
        path = os.path.join(a.folder, f'cutout_{name}.png')
        image = Image.open(path).convert('RGBA')
        box = image.getchannel('A').point(lambda v: 255 if v > ALPHA_CUT else 0).getbbox()
        if box is None:
            print(f'ERROR: {name}: nothing is left after the background removal', flush=True)
            sys.exit(1)
        image = clean_edge(image.crop(box))
        image.save(os.path.join(a.folder, f'sprite_{name}.png'))
        sprites.append((name, image))
        print(f'progress {i + 1}/{len(a.names) + 1} {name}', flush=True)
    avail = a.cell - 2 * a.padding
    # one factor for all: the largest sprite fills a cell, the others keep their relative size
    k = min(avail / max(im.width, im.height) for _, im in sprites)
    columns = a.columns or min(len(sprites), 4)
    rows = math.ceil(len(sprites) / columns)
    sheet = Image.new('RGBA', (columns * a.cell, rows * a.cell), (0, 0, 0, 0))
    frames = []
    for i, (name, im) in enumerate(sprites):
        w, h = max(1, round(im.width * k)), max(1, round(im.height * k))
        small = im.resize((w, h), Image.LANCZOS)
        cx, cy = (i % columns) * a.cell, (i // columns) * a.cell
        x = cx + (a.cell - w) // 2
        y = cy + (a.cell - a.padding - h if a.anchor == 'bottom' else (a.cell - h) // 2)
        sheet.alpha_composite(small, (x, y))
        frames.append({'name': name, 'frame': {'x': cx, 'y': cy, 'w': a.cell, 'h': a.cell}, 'sprite': {'x': x - cx, 'y': y - cy, 'w': w, 'h': h},
                       'pivot': {'x': 0.5, 'y': (a.cell - a.padding) / a.cell if a.anchor == 'bottom' else 0.5}, 'source': f'sprite_{name}.png'})
    sheet.save(os.path.join(a.folder, 'sheet.png'))
    atlas = {'image': 'sheet.png', 'size': {'w': sheet.width, 'h': sheet.height}, 'cell': a.cell, 'columns': columns, 'scale': round(k, 4), 'anchor': a.anchor, 'frames': frames}
    with open(os.path.join(a.folder, 'atlas.json'), 'w', encoding='utf8') as f:
        json.dump(atlas, f, indent=2)
    print(f'progress {len(a.names) + 1}/{len(a.names) + 1} sheet', flush=True)
    print('RESULT ' + json.dumps({'sheet': [sheet.width, sheet.height], 'scale': round(k, 4), 'frames': len(frames)}))


main()
