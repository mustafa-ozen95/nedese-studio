"""
Game sprites from transparent pictures (the Game assets job; ComfyUI's python: Pillow and numpy are there):
  python sprites.py --folder out --names idle walk ... --cell 512 --padding 8 --anchor bottom
- Reads <folder>/cutout_<name>.png (RGBA) for every name.
- Writes <folder>/sprite_<name>.png: the picture trimmed to the figure (alpha > 8), with the half-transparent halo of the
  mask's edge cleaned (colour of the opaque neighbours spread into texels that are nearly transparent).
- Writes <folder>/sheet.png and <folder>/atlas.json: every sprite scaled by ONE common factor (the poses keep their
  relative size) into square cells, anchored bottom-centre (characters, vehicles: the feet stay on one line) or in the
  centre; the atlas lists the frame rectangles, the pivot and the scale.
- --prefix NAME_ puts it before sheet.png / atlas.json / sprites.zip (several sets in one folder); --union crops every
  picture by the box that holds ALL of them (the frames of an animation keep their place in the cell: a walking figure's
  width changes from frame to frame and a per-frame trim would make it jitter); --fps N also writes <prefix>animation.webp
  (animated, with alpha) and stores the rate in the atlas.
- --mode tiles: reads <folder>/source_<name>.png, makes each seamless (the picture and its half-shifted copy are cross-faded,
  so the opposite edges meet) at --cell x --cell: tile_<name>.png, the sheet, the atlas and tile-preview.png (the first tile
  repeated 3 x 3: the seams show there).
- Prints "progress <done>/<total> <text>" lines and a last line "RESULT {json}".
"""
import argparse
import json
import math
import os
import sys
import zipfile

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
    p.add_argument('--prefix', default='')
    p.add_argument('--fps', type=float, default=0)
    p.add_argument('--union', action='store_true')
    p.add_argument('--mode', choices=('sprites', 'tiles'), default='sprites')
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


def seamless(image):
    """The picture cross-faded with its half-shifted copy, first across x then across y: the weight is 0 on the picture's own
    edges (where it would not wrap) and 1 in the middle (where the shifted copy has its seam)."""
    a = np.asarray(image.convert('RGB')).astype(np.float32)
    h, w = a.shape[:2]
    wx = (1 - np.abs(np.linspace(-1, 1, w, endpoint=False) + 1 / w))[None, :, None]
    a = a * wx + np.roll(a, w // 2, 1) * (1 - wx)
    wy = (1 - np.abs(np.linspace(-1, 1, h, endpoint=False) + 1 / h))[:, None, None]
    a = a * wy + np.roll(a, h // 2, 0) * (1 - wy)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGB')


def tiles(a):
    done = []
    for i, name in enumerate(a.names):
        image = Image.open(os.path.join(a.folder, f'source_{name}.png')).convert('RGB')
        tile = seamless(image).resize((a.cell, a.cell), Image.LANCZOS)
        tile.save(os.path.join(a.folder, f'tile_{name}.png'))
        done.append((name, tile))
        print(f'progress {i + 1}/{len(a.names) + 1} {name}', flush=True)
    columns = a.columns or min(len(done), 4)
    rows = math.ceil(len(done) / columns)
    sheet = Image.new('RGB', (columns * a.cell, rows * a.cell))
    frames = []
    for i, (name, tile) in enumerate(done):
        cx, cy = (i % columns) * a.cell, (i // columns) * a.cell
        sheet.paste(tile, (cx, cy))
        frames.append({'name': name, 'frame': {'x': cx, 'y': cy, 'w': a.cell, 'h': a.cell}, 'source': f'tile_{name}.png'})
    sheet.save(os.path.join(a.folder, f'{a.prefix}sheet.png'))
    preview = Image.new('RGB', (a.cell * 3, a.cell * 3))
    for y in range(3):
        for x in range(3):
            preview.paste(done[0][1], (x * a.cell, y * a.cell))
    preview.save(os.path.join(a.folder, 'tile-preview.png'))
    atlas = {'image': f'{a.prefix}sheet.png', 'size': {'w': sheet.width, 'h': sheet.height}, 'cell': a.cell, 'columns': columns, 'kind': 'tiles', 'frames': frames}
    with open(os.path.join(a.folder, f'{a.prefix}atlas.json'), 'w', encoding='utf8') as f:
        json.dump(atlas, f, indent=2)
    with zipfile.ZipFile(os.path.join(a.folder, f'{a.prefix}sprites.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for f in [f'{a.prefix}sheet.png', f'{a.prefix}atlas.json'] + [f'tile_{n}.png' for n in a.names]:
            z.write(os.path.join(a.folder, f), f)
    print(f'progress {len(a.names) + 1}/{len(a.names) + 1} sheet', flush=True)
    print('RESULT ' + json.dumps({'sheet': [sheet.width, sheet.height], 'frames': len(frames)}))


def main():
    a = args()
    if a.mode == 'tiles':
        return tiles(a)
    loaded = []
    for name in a.names:
        image = Image.open(os.path.join(a.folder, f'cutout_{name}.png')).convert('RGBA')
        box = image.getchannel('A').point(lambda v: 255 if v > ALPHA_CUT else 0).getbbox()
        if box is None:
            print(f'ERROR: {name}: nothing is left after the background removal', flush=True)
            sys.exit(1)
        loaded.append((name, image, box))
    if a.union:
        box = (min(b[0] for _, _, b in loaded), min(b[1] for _, _, b in loaded), max(b[2] for _, _, b in loaded), max(b[3] for _, _, b in loaded))
        loaded = [(n, im, box) for n, im, _ in loaded]
    sprites = []
    for i, (name, image, box) in enumerate(loaded):
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
    cells = []
    for i, (name, im) in enumerate(sprites):
        w, h = max(1, round(im.width * k)), max(1, round(im.height * k))
        small = im.resize((w, h), Image.LANCZOS)
        cx, cy = (i % columns) * a.cell, (i // columns) * a.cell
        x = cx + (a.cell - w) // 2
        y = cy + (a.cell - a.padding - h if a.anchor == 'bottom' else (a.cell - h) // 2)
        sheet.alpha_composite(small, (x, y))
        if a.fps:
            one = Image.new('RGBA', (a.cell, a.cell), (0, 0, 0, 0))
            one.alpha_composite(small, (x - cx, y - cy))
            cells.append(one)
        frames.append({'name': name, 'frame': {'x': cx, 'y': cy, 'w': a.cell, 'h': a.cell}, 'sprite': {'x': x - cx, 'y': y - cy, 'w': w, 'h': h},
                       'pivot': {'x': 0.5, 'y': (a.cell - a.padding) / a.cell if a.anchor == 'bottom' else 0.5}, 'source': f'sprite_{name}.png'})
    sheet.save(os.path.join(a.folder, f'{a.prefix}sheet.png'))
    atlas = {'image': f'{a.prefix}sheet.png', 'size': {'w': sheet.width, 'h': sheet.height}, 'cell': a.cell, 'columns': columns, 'scale': round(k, 4), 'anchor': a.anchor, 'frames': frames}
    if a.fps:
        atlas['fps'] = a.fps
        cells[0].save(os.path.join(a.folder, f'{a.prefix}animation.webp'), save_all=True, append_images=cells[1:], duration=round(1000 / a.fps), loop=0, lossless=True)
    with open(os.path.join(a.folder, f'{a.prefix}atlas.json'), 'w', encoding='utf8') as f:
        json.dump(atlas, f, indent=2)
    with zipfile.ZipFile(os.path.join(a.folder, f'{a.prefix}sprites.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for f in [f'{a.prefix}sheet.png', f'{a.prefix}atlas.json'] + [f'sprite_{n}.png' for n in a.names]:
            z.write(os.path.join(a.folder, f), f)
    print(f'progress {len(a.names) + 1}/{len(a.names) + 1} sheet', flush=True)
    print('RESULT ' + json.dumps({'sheet': [sheet.width, sheet.height], 'scale': round(k, 4), 'frames': len(frames)}))


main()
