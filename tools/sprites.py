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
  (animated, with alpha) and stores the rate in the atlas. --match: the colours of every picture are brought back to those of
  cutout_base.png (the frames of a clip drift from it; see match_colours).
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
    p.add_argument('--match', action='store_true')
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


def background_left(image):
    """Opaque pixels of the background's own colour in large pieces: the background inside a swoosh or speed trail that the
    cut-out kept with the figure (an orc's axe attack had grey patches over 27% of a frame, 14.10.2026). The background's colour
    at every pixel comes from the cleared pixels around it (the cut-out keeps their colour under alpha 0); a piece counts from
    0.4% of the figure's area, smaller ones (highlights, an edge) stay."""
    a = np.asarray(image)
    alpha = a[..., 3]
    rgb = a[..., :3].astype(np.float32)
    clear = (alpha == 0).astype(np.float32)
    if clear.sum() < 100:
        return np.zeros(alpha.shape, bool)
    sigma = max(a.shape[:2]) / 8
    weight = cv2.GaussianBlur(clear, (0, 0), sigma)
    field = cv2.GaussianBlur(rgb * clear[..., None], (0, 0), sigma) / np.maximum(weight, 1e-4)[..., None]
    near = (np.abs(rgb - field).max(axis=2) <= 20) & (alpha > 0) & (weight > 0.001)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(near.astype(np.uint8), connectivity=8)
    big = np.zeros(count, bool)
    big[1:] = stats[1:, cv2.CC_STAT_AREA] >= 0.004 * max(1, int((alpha > 0).sum()))
    return big[labels]


def figure_share(image, mask):
    return mask.sum() / max(1, int((np.asarray(image.getchannel('A')) > 0).sum()))


def drop_background(image, mask=None):
    mask = background_left(image) if mask is None else mask
    if not mask.any():
        return image
    image = image.copy()
    image.putalpha(Image.fromarray(np.where(mask, 0, np.asarray(image.getchannel('A'))).astype(np.uint8), 'L'))
    return image


def drop_strokes(image, removed):
    """The outline of a swoosh that touches the figure goes too: once the background inside it is removed only its thin edge is
    left, still joined to the axe or the arm, so drop_lines() (separate pieces only) keeps it (14.10.2026). Thin, long parts (a
    disc of 0.8% of the figure's height does not fit in them, they are six such widths long) are removed when they lie along the
    removed background; thin parts of the figure elsewhere (an antenna, a strand of hair) stay."""
    if not removed.any():
        return image
    alpha = np.asarray(image.getchannel('A'))
    mask = (alpha > ALPHA_CUT).astype(np.uint8)
    rows = np.nonzero(mask.any(1))[0]
    if not len(rows):
        return image
    r = max(2, int(np.ceil(0.008 * (rows[-1] - rows[0] + 1))))
    disc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    thin = mask & ~cv2.morphologyEx(mask, cv2.MORPH_OPEN, disc)
    near = cv2.dilate(removed.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    count, labels, stats, _ = cv2.connectedComponentsWithStats(thin, connectivity=8)
    drop = np.zeros(mask.shape, bool)
    for i in range(1, count):
        if max(stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]) >= 6 * r:
            piece = labels == i
            if (piece & near).sum() >= 0.2 * piece.sum():
                drop |= piece
    if not drop.any():
        return image
    image = image.copy()
    image.putalpha(Image.fromarray(np.where(drop, 0, alpha).astype(np.uint8), 'L'))
    return image


def drop_lines(image):
    """Thin separate pieces go: speed lines and swoosh strokes the model drew around a blow, left floating once the background
    inside them is gone (14.10.2026). A piece counts as thin when no point of it is further than 0.8% of the figure's height from
    its edge; pieces from 5% of the largest part's area stay, and so do thick ones (a sweat drop, a spark). A brush stroke is
    often thicker at an end: a long piece (six such widths) that is thin over 90% of it and nowhere twice as thick goes too
    (arcs around an orc's swing stayed, 14.10.2026); a short drop of blood does not."""
    alpha = np.asarray(image.getchannel('A'))
    mask = (alpha > ALPHA_CUT).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 2:
        return image
    rows = np.nonzero(mask.any(1))[0]
    reach = max(1.5, 0.008 * (rows[-1] - rows[0] + 1))
    areas = stats[1:, cv2.CC_STAT_AREA]
    depth = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    drop = np.zeros(mask.shape, bool)
    for i in range(1, count):
        if areas[i - 1] < 0.05 * areas.max():
            piece = labels == i
            inside = depth[piece]
            long = max(stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]) >= 6 * reach
            if inside.max() <= reach or (long and np.percentile(inside, 90) <= reach and inside.max() <= 2 * reach):
                drop |= piece
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


def opaque_lab(image, limit=40000):
    """The Lab colours of the opaque texels (a fixed sample of at most limit)."""
    a = np.asarray(image)
    px = cv2.cvtColor(np.ascontiguousarray(a[..., :3]), cv2.COLOR_RGB2LAB).astype(np.float32)[a[..., 3] > 200]
    if len(px) > limit:
        px = px[np.random.default_rng(0).choice(len(px), limit, replace=False)]
    return px


def palette(image, k=8):
    """The main colours of a picture (Lab cluster centres of its opaque texels)."""
    px = opaque_lab(image)
    if len(px) < k * 10:
        return None
    _, _, centres = cv2.kmeans(px, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5), 3, cv2.KMEANS_PP_CENTERS)
    return centres


def match_colours(image, centres):
    """
    The colours of a frame brought back to the reference's main colours: Wan drifts from its start picture, most in the second
    clip that closes the loop (its frames came about 10% more saturated, a wizard's robe 13 levels lighter; 15.10.2026). Each
    texel goes to the nearest reference colour and a gain and offset per Lab channel are fitted to the means of those groups,
    weighted by their size, not to the mean of the whole figure: an orc raising its axe shows more fur and less skin and is
    darker on the whole, which is the pose, not a drift (a match of the whole mean lightened its skin). Mild: gains 0.85-1.18,
    offsets at most 20 levels, and nothing when fewer than three reference colours are in the frame.
    """
    px = opaque_lab(image)
    if centres is None or len(px) < 500:
        return image
    gain, offset = np.ones(3, np.float32), np.zeros(3, np.float32)
    for _ in range(3):
        near = np.argmin((((px * gain + offset)[:, None, :] - centres[None]) ** 2).sum(2), 1)
        weight = np.bincount(near, minlength=len(centres)).astype(np.float32)
        keep = weight >= max(50, 0.01 * len(px))
        if keep.sum() < 3:
            return image
        means = np.stack([px[near == i].mean(0) for i in np.flatnonzero(keep)])
        w = weight[keep]
        for c in range(3):
            x, y = means[:, c], centres[keep, c]
            xm, ym = np.average(x, weights=w), np.average(y, weights=w)
            var = np.average((x - xm) ** 2, weights=w)
            gain[c] = np.clip(np.average((x - xm) * (y - ym), weights=w) / var if var > 1 else 1.0, 0.85, 1.18)
            offset[c] = np.clip(ym - gain[c] * xm, -20 - (gain[c] - 1) * xm, 20 - (gain[c] - 1) * xm)
    a = np.asarray(image)
    lab = cv2.cvtColor(np.ascontiguousarray(a[..., :3]), cv2.COLOR_RGB2LAB).astype(np.float32)
    rgb = cv2.cvtColor(np.clip(lab * gain + offset, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)
    return Image.fromarray(np.dstack([rgb, a[..., 3]]), 'RGBA')


def surface(channel, degree=4):
    """A smooth surface (a polynomial of x and y) fitted to a channel: the broad shape of a vignette, right up to the corners, where
    a blur takes in the lit middle and falls short."""
    h, w = channel.shape
    small = cv2.resize(channel, (64, 64), interpolation=cv2.INTER_AREA)
    y, x = np.mgrid[0:64, 0:64] / 63 * 2 - 1
    terms = [(i, j) for i in range(degree + 1) for j in range(degree + 1 - i)]
    coef = np.linalg.lstsq(np.stack([(x ** i * y ** j).ravel() for i, j in terms], 1), small.ravel(), rcond=None)[0]
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    x, y = x / (w - 1) * 2 - 1, y / (h - 1) * 2 - 1
    return sum(c * x ** i * y ** j for c, (i, j) in zip(coef, terms)).astype(np.float32)


def even_light(image):
    """The broad light and colour of a texture made even (detail kept): the model draws a vignette (dark edges, a lit middle) even
    when asked not to, and the half-shift of seamless() puts the dark edges in the middle, a dark cross repeated on every tile of
    a floor (14.10.2026). The lightness is scaled, the colour shifted, to their level in the lit quarter of the picture: first by a
    smooth surface (the vignette, which the tile keeps at its edges since nothing is shifted), then by a blur (broad patches)."""
    lab = cv2.cvtColor(np.asarray(image.convert('RGB')), cv2.COLOR_RGB2LAB).astype(np.float32)
    h, w = lab.shape[:2]

    def blurred(channel):
        return cv2.GaussianBlur(channel, (0, 0), min(h, w) / 12, borderType=cv2.BORDER_REFLECT)

    for broad in (surface, blurred):
        light = broad(lab[..., 0])
        lit = light >= np.percentile(light, 75)
        lab[..., 0] = np.clip(lab[..., 0] * np.clip(light[lit].mean() / np.maximum(light, 1), 0.5, 3), 0, 255)
        for c in (1, 2):
            colour = broad(lab[..., c])
            lab[..., c] = np.clip(lab[..., c] - colour + colour[lit].mean(), 0, 255)
    return Image.fromarray(cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB), 'RGB')


def one_panel(image):
    """One panel of a picture the model drew as two, side by side or one above the other (14.10.2026: a brick wall came as two
    walls, each with its own dark edges, joined by a straight joint down the middle, which stayed in the tile): the middle is
    darker than the middles of both halves, and the straightest line of the picture is there. A square from the first half is
    kept; a single picture, lit in the middle, is left as it is."""
    light = cv2.cvtColor(np.asarray(image.convert('RGB')), cv2.COLOR_RGB2LAB)[..., 0].astype(np.float32)
    for axis in (0, 1):
        profile = light.mean(axis)
        n = len(profile)
        broad = cv2.GaussianBlur(profile[None, :], (0, 0), n / 40)[0]
        dip = min(broad[n // 4], broad[3 * n // 4]) - broad[n // 2]
        line = np.abs(profile - cv2.GaussianBlur(profile[None, :], (0, 0), n / 60)[0])
        at = int(np.argmax(line[int(n * .3):int(n * .7)])) + int(n * .3)
        if dip > 2 and abs(at - n / 2) < n * .05:
            other = light.shape[axis]
            top = (other - at) // 2
            box = (0, top, at, top + at) if axis == 0 else (top, 0, top + at, at)
            return image.crop(box)
    return image


def cheapest_path(cost, cyclic=False):
    """The column per row of the cheapest top-to-bottom path through cost, moving at most one column a row; cyclic: it ends next to
    where it began, so the path wraps (every third column is tried as its start, which keeps the memory small)."""
    h, w = cost.shape
    starts = np.arange(0, w, 3) if cyclic else np.array([0])
    total = np.full((len(starts), w), np.inf)
    if cyclic:
        total[np.arange(len(starts)), starts] = cost[0, starts]
    else:
        total[0] = cost[0]
    moves = np.zeros((h, len(starts), w), np.int8)
    edge = np.full((len(starts), 1), np.inf)
    for y in range(1, h):
        options = np.stack([np.concatenate([edge, total[:, :-1]], 1), total, np.concatenate([total[:, 1:], edge], 1)])
        moves[y] = options.argmin(0) - 1
        total = options.min(0) + cost[y]
    if cyclic:
        ends = [total[i, max(0, s - 1):s + 2].min() for i, s in enumerate(starts)]
        start = int(np.argmin(ends))
        x = max(0, starts[start] - 1) + int(total[start, max(0, starts[start] - 1):starts[start] + 2].argmin())
    else:
        start, x = 0, int(total[0].argmin())
    path = np.zeros(h, int)
    for y in range(h - 1, -1, -1):
        path[y] = x
        x += int(moves[y, start, x])
    return path


def seamless(image):
    """Made tileable by overlapping the picture with itself: its last eighth is laid over its first one and the picture ends where
    that eighth began, so the right edge runs on into the left. The two strips are joined along the path where they differ least
    (between the stones, not through them, 14.10.2026), not faded into each other, which left half-see-through ghost stones; and
    nothing is used twice (the earlier half-shift repeated the middle half, so every tile showed its pattern twice). Across, then
    the same down; the second cut wraps so the sides stay seamless."""
    a = np.asarray(image.convert('RGB')).astype(np.float32)

    def wrap(a, cyclic):
        w = a.shape[1]
        o = w // 8
        start, end = a[:, :o], a[:, w - o:]
        smooth = lambda im: cv2.GaussianBlur(im, (0, 0), 2)
        cost = ((smooth(start) - smooth(end)) ** 2).sum(2)
        margin = o // 8
        path = cheapest_path(cost[:, margin:o - margin], cyclic) + margin
        x = np.arange(o)[None, :]
        mask = cv2.GaussianBlur((x < path[:, None]).astype(np.float32), (0, 0), 1.5)[..., None]
        out = a[:, :w - o].copy()
        out[:, :o] = end * mask + start * (1 - mask)
        return out

    across = wrap(a, False)
    down = wrap(across.transpose(1, 0, 2).copy(), True).transpose(1, 0, 2)
    return Image.fromarray(np.clip(down, 0, 255).astype(np.uint8), 'RGB')


def tiles(a):
    done = []
    for i, name in enumerate(a.names):
        image = Image.open(os.path.join(a.folder, f'source_{name}.png')).convert('RGB')
        tile = seamless(even_light(one_panel(image))).resize((a.cell, a.cell), Image.LANCZOS)
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


def key_frames(small, end, count):
    """
    count frames of the loop 0..end-1 (end is the first again), the first one kept: the ones whose poses, joined in
    order and back to the start, make the longest path, so the far poses of a motion are in (evenly spaced frames 1, 9,
    17... of an orc's swing left out its two blows at 13 and 29, 14.10.2026). Gaps stay between half and twice the even
    step, so the timing played at one frame rate stays about right.
    """
    even = [min(end - 1, round(i * end / count)) for i in range(count)]
    step = end / count
    lo, hi = max(1, int(step * 0.5)), max(2, int(round(step * 2)))
    if count < 2 or count * lo >= end:
        return even
    flat = np.stack([s.ravel() for s in small[:end + 1]])
    dist = np.abs(flat[:, None, :] - flat[None, :, :]).mean(axis=2)
    none = float('-inf')
    best = np.full((count, end + 1), none)
    back = np.full((count, end + 1), -1, dtype=int)
    best[0][0] = 0.0
    for j in range(1, count):
        for i in range(1, end):
            for p in range(max(0, i - hi), i - lo + 1):
                if best[j - 1][p] == none:
                    continue
                v = best[j - 1][p] + dist[p][i]
                if v > best[j][i]:
                    best[j][i], back[j][i] = v, p
    last, total = -1, none
    for i in range(max(1, end - hi), end - lo + 1):
        if best[count - 1][i] != none and best[count - 1][i] + dist[i][end] > total:
            last, total = i, best[count - 1][i] + dist[i][end]
    if last < 0:
        return even
    picks = [last]
    for j in range(count - 1, 0, -1):
        picks.append(int(back[j][picks[-1]]))
    return picks[::-1]


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
    picks = key_frames(small, end, a.count)
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
    # background patches are taken out of the poses and frames only when the first picture has none: a white knight or a
    # grey robot is itself the background's colour
    base = os.path.join(a.folder, 'cutout_base.png')
    plain = os.path.exists(base) and figure_share(*(lambda im: (im, background_left(im)))(Image.open(base).convert('RGBA'))) < 0.005
    centres = palette(Image.open(base).convert('RGBA')) if a.match and os.path.exists(base) else None
    loaded = []
    for name in a.names:
        image = Image.open(os.path.join(a.folder, f'cutout_{name}.png')).convert('RGBA')
        if plain and name != 'base':
            removed = background_left(image)
            image = drop_strokes(drop_background(image, removed), removed)
        image = drop_floor(drop_specks(drop_lines(image)))
        if centres is not None and name != 'base':
            image = match_colours(image, centres)
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
