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
- --mode loop --frames DIR --count N: the frames of a clip (PNG, sorted by name); the loop is closed where the picture
  is closest to the first one (the clip's second half is searched); N evenly spaced frames of that part are picked.
  Prints RESULT {files, length, closure}: the picked file names, the loop's length in frames and the mean difference (0-255).
- Prints "progress <done>/<total> <text>" lines and a last line "RESULT {json}".
"""
import argparse
import json
import math
import os
import sys
import zipfile

import cv2
import numpy as np
from PIL import Image

ALPHA_CUT = 8


def args():
    p = argparse.ArgumentParser()
    p.add_argument('--folder', default='')
    p.add_argument('--names', nargs='+')
    p.add_argument('--cell', type=int, default=512)
    p.add_argument('--padding', type=int, default=8)
    p.add_argument('--anchor', choices=('bottom', 'center'), default='bottom')
    p.add_argument('--columns', type=int, default=0)
    p.add_argument('--prefix', default='')
    p.add_argument('--fps', type=float, default=0)
    p.add_argument('--union', action='store_true')
    p.add_argument('--pixel', type=int, default=0)
    p.add_argument('--mode', choices=('sprites', 'tiles', 'loop'), default='sprites')
    p.add_argument('--frames', default='')
    p.add_argument('--count', type=int, default=12)
    p.add_argument('--whole', action='store_true')
    return p.parse_args()


def pixelate(image, cell, logical):
    """Real pixel art: the sprite is reduced to blocks of cell/logical pixels (the block average) and enlarged without smoothing;
    a block is either fully opaque or empty."""
    block = max(1, cell // logical)
    w, h = max(1, image.width // block), max(1, image.height // block)
    small = image.resize((w, h), Image.BOX)
    alpha = small.getchannel('A').point(lambda v: 255 if v >= 128 else 0)
    small.putalpha(alpha)
    return small.resize((w * block, h * block), Image.NEAREST)


def one_palette(images, colours=32):
    """All the pixel-art sprites of a sheet drawn with one palette (the frames of an animation would flicker otherwise)."""
    pixels = np.concatenate([np.asarray(im.convert('RGBA')).reshape(-1, 4) for im in images])
    pixels = pixels[pixels[:, 3] == 255][:, :3]
    if len(pixels) == 0:
        return images
    side = math.ceil(math.sqrt(len(pixels)))
    sample = np.zeros((side * side, 3), np.uint8)
    sample[:len(pixels)] = pixels
    sample[len(pixels):] = pixels[0]
    palette = Image.fromarray(sample.reshape(side, side, 3), 'RGB').quantize(colours, Image.MEDIANCUT)
    done = []
    for im in images:
        alpha = im.getchannel('A')
        flat = im.convert('RGB').quantize(palette=palette, dither=Image.NONE).convert('RGB').convert('RGBA')
        flat.putalpha(alpha)
        done.append(flat)
    return done


def drop_floor(image):
    """A thin, wide streak under the figure (a floor line or a shadow stuck to the feet) is removed: pixels that sit in vertical
    runs shorter than 6% of the picture's height form pieces; a piece in the lowest 15% of the figure that is at least three times
    as wide as it is tall goes."""
    alpha = np.asarray(image.getchannel('A'))
    mask = (alpha > ALPHA_CUT).astype(np.uint8)
    rows = np.nonzero(mask.any(1))[0]
    if len(rows) == 0:
        return image
    top, bottom = rows[0], rows[-1]
    k = max(3, round((bottom - top + 1) * 0.06))
    kernel = np.ones((k, 1), np.uint8)
    thick = cv2.dilate(cv2.erode(mask, kernel), kernel)
    thin = mask & (1 - thick)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(thin, connectivity=8)
    drop = np.zeros(mask.shape, bool)
    for i in range(1, count):
        x, y, w, h, _area = stats[i]
        if y >= bottom - 0.15 * (bottom - top) and w >= 3 * h and w >= 2 * k:
            drop |= labels == i
    if not drop.any():
        return image
    image = image.copy()
    image.putalpha(Image.fromarray(np.where(drop, 0, alpha).astype(np.uint8), 'L'))
    return image


def drop_specks(image):
    """Pieces cut out together with the figure at its feet (a bit of the floor, a shadow) are removed: a separate piece smaller
    than 10% of the largest part's area that lies in the lowest 12% of the figure. Effects around the body (sweat drops, sparks)
    stay."""
    alpha = np.asarray(image.getchannel('A'))
    count, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > ALPHA_CUT).astype(np.uint8), connectivity=8)
    if count <= 2:
        return image
    areas = stats[1:, cv2.CC_STAT_AREA]
    top = stats[1:, cv2.CC_STAT_TOP].min()
    bottom = (stats[1:, cv2.CC_STAT_TOP] + stats[1:, cv2.CC_STAT_HEIGHT]).max()
    low = top + 0.88 * (bottom - top)
    keep = np.ones(count, bool)
    keep[1:] = ~((areas < areas.max() * 0.1) & (stats[1:, cv2.CC_STAT_TOP] >= low))
    cleaned = np.where(keep[labels], alpha, 0).astype(np.uint8)
    image = image.copy()
    image.putalpha(Image.fromarray(cleaned, 'L'))
    return image


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


def blend(under, over, mask, levels=5):
    """Laplacian-pyramid blend (result = over where the mask is 1, under where it is 0): the fine detail changes over a narrow
    band, the broad shading over a wide one, so a seam leaves no ghost of the other picture."""
    gu, go, gm = [under], [over], [mask]
    for _ in range(levels):
        gu.append(cv2.pyrDown(gu[-1]))
        go.append(cv2.pyrDown(go[-1]))
        gm.append(cv2.pyrDown(gm[-1]))
    out = None
    for i in range(levels, -1, -1):
        if i == levels:
            lu, lo = gu[i], go[i]
        else:
            size = (gu[i].shape[1], gu[i].shape[0])
            lu = gu[i] - cv2.pyrUp(gu[i + 1], dstsize=size)
            lo = go[i] - cv2.pyrUp(go[i + 1], dstsize=size)
        m = gm[i][..., None]
        level = lu * (1 - m) + lo * m
        out = level if out is None else cv2.pyrUp(out, dstsize=(level.shape[1], level.shape[0])) + level
    return out


def seamless(image):
    """Made tileable: the picture rolled by half its size wraps without a seam on its edges, but has one in the middle; the middle
    box of the original picture (which has no seam there) is blended over it."""
    a = np.asarray(image.convert('RGB')).astype(np.float32)
    h, w = a.shape[:2]
    rolled = np.roll(np.roll(a, w // 2, 1), h // 2, 0)
    mask = np.zeros((h, w), np.float32)
    mask[h // 4:3 * h // 4, w // 4:3 * w // 4] = 1
    mask = cv2.GaussianBlur(mask, (0, 0), min(h, w) / 16)
    return Image.fromarray(np.clip(blend(rolled, a, mask), 0, 255).astype(np.uint8), 'RGB')


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


def loop(a):
    files = sorted(f for f in os.listdir(a.frames) if f.lower().endswith('.png'))
    if len(files) < 4:
        print('ERROR: the clip has too few frames', flush=True)
        sys.exit(1)
    small = [np.asarray(Image.open(os.path.join(a.frames, f)).convert('L').resize((64, 64), Image.BILINEAR)).astype(np.float32) for f in files]
    diffs = [float(np.abs(x - small[0]).mean()) for x in small]
    if a.whole:
        # the clip was closed by a second clip that ends on the first frame: the loop is all of it
        end = len(files) - 1
    else:
        # the loop may not be shorter than 40% of the clip (the figure must have moved away and come back), and it holds
        # the main motion: an orc that stood with the axe raised for 19 frames before the swing came back "closest"
        # there, and the loop was the axe shaking in the air (14.10.2026)
        peak = max(diffs)
        moved = next((i for i, d in enumerate(diffs) if d >= peak * 0.6), 0)
        start = min(len(files) - 1, max(2, int(len(files) * 0.4), moved + 1))
        best = min(diffs[start:])
        # the earliest frame that is about as close as the closest: a longer loop would repeat the motion more than once
        end = next(i for i in range(start, len(files)) if diffs[i] <= best * 1.1 + 1.0)
    picks = [min(end - 1, round(i * end / a.count)) for i in range(a.count)]
    print('RESULT ' + json.dumps({'files': [files[i] for i in picks], 'length': end, 'closure': round(diffs[end], 2), 'frames': len(files)}))


def main():
    a = args()
    if a.mode == 'loop':
        return loop(a)
    if not a.names or not a.folder:
        print('ERROR: --folder and --names are required', flush=True)
        sys.exit(1)
    if a.mode == 'tiles':
        return tiles(a)
    loaded = []
    for name in a.names:
        image = drop_floor(drop_specks(Image.open(os.path.join(a.folder, f'cutout_{name}.png')).convert('RGBA')))
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
    scaled = [im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS) for _, im in sprites]
    if a.pixel:
        scaled = one_palette([pixelate(im, a.cell, a.pixel) for im in scaled])
    for i, (name, im) in enumerate(sprites):
        small = scaled[i]
        w, h = small.size
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


if __name__ == '__main__':
    main()
