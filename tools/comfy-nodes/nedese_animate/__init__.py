"""
Nedese Studio: the person in a video replaced by the person in a photo (Wan 2.2 Animate, replacement mode).

NedeseReplacePrep turns the frames of a video (and the foreground mask of the background removal model) into what
WanAnimateToVideo needs: the pose video (the person's body drawn OpenPose style on black), the face video (the face
cropped square and scaled to 512 x 512 in every frame), the background video (the person's area blacked out) and
the character mask (that area grown and made blocky, so a person of another build or hair fits in).

Pose: DWPose (IDEA-Research, Apache-2.0) as TorchScript on the GPU: YOLOX-L finds the people, RTMPose (dw-ll ucoco
384) gives the 133 whole-body keypoints of one of them. The pre and post processing follow mmpose / DWPose; the body
is drawn like ControlNet's OpenPose annotator at a 960 pixel short side, as ComfyUI's Wan Animate example does. One
person is followed: the largest in the first frame with people (or the k-th from the left, or the one at a given box:
target), then in every frame the box that overlaps it most and still looks like them (colours); after a cut or a hug
the one who looks like them, and in a shot without them nothing is repainted. Their box in every frame and their look
come back in the node's UI output (boxes, look): a long video is made window by window and the next window follows the
same person from them.
"""
import json
import os

import cv2
import numpy as np
import torch

import comfy.model_management as mm
import folder_paths

POSE = 'pose'
# started without tools\comfy-nodes\paths.yaml (by hand): the install's models\pose
if POSE not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path(POSE, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), 'models', POSE))

DETECTOR = 'yolox_l.torchscript.pt'
POSE_MODEL = 'dw-ll_ucoco_384_bs5.torchscript.pt'
DET_SIZE = 640
POSE_SIZE = (288, 384)  # w, h
POSE_BATCH = 5  # the TorchScript pose model is traced for batches of 5
POSE_MEAN = np.array([123.675, 116.28, 103.53])
POSE_STD = np.array([58.395, 57.12, 57.375])
DRAW_SIDE = 960

# OpenPose body (18 points) from the 133 whole-body points (+ the neck, the middle of the shoulders, inserted at 17)
MMPOSE_IDX = [17, 6, 8, 10, 7, 9, 12, 14, 16, 13, 15, 2, 1, 4, 3]
OPENPOSE_IDX = [1, 2, 3, 4, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17]
LIMBS = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18]]
COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]]
SCORE = 0.3


def _grids():
    grids, strides = [], []
    for stride in (8, 16, 32):
        n = DET_SIZE // stride
        xv, yv = np.meshgrid(np.arange(n), np.arange(n))
        grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
        strides.append(np.full((n * n, 1), stride))
    return np.concatenate(grids), np.concatenate(strides)


GRID, STRIDE = _grids()


def _nms(boxes, scores, threshold):
    x1, y1, x2, y2 = boxes.T
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        w = np.maximum(0.0, np.minimum(x2[i], x2[order[1:]]) - np.maximum(x1[i], x1[order[1:]]) + 1)
        h = np.maximum(0.0, np.minimum(y2[i], y2[order[1:]]) - np.maximum(y1[i], y1[order[1:]]) + 1)
        overlap = w * h / (areas[i] + areas[order[1:]] - w * h)
        order = order[np.where(overlap <= threshold)[0] + 1]
    return keep


def detect_people(model, bgr):
    """The boxes [x1, y1, x2, y2] of the people in a BGR frame (YOLOX, letterboxed to 640 with grey 114)."""
    h, w = bgr.shape[:2]
    r = min(DET_SIZE / h, DET_SIZE / w)
    padded = np.full((DET_SIZE, DET_SIZE, 3), 114, np.uint8)
    resized = cv2.resize(bgr, (int(w * r), int(h * r)), interpolation=cv2.INTER_LINEAR)
    padded[:resized.shape[0], :resized.shape[1]] = resized
    p = next(model.parameters())
    x = torch.from_numpy(np.ascontiguousarray(padded.transpose(2, 0, 1)[None], dtype=np.float32)).to(p.device, p.dtype)
    with torch.no_grad():
        out = model(x).float().cpu().numpy()[0]
    out[:, :2] = (out[:, :2] + GRID) * STRIDE
    out[:, 2:4] = np.exp(out[:, 2:4]) * STRIDE
    scores = out[:, 4] * out[:, 5]  # objectness x the person class
    boxes = np.stack([out[:, 0] - out[:, 2] / 2, out[:, 1] - out[:, 3] / 2, out[:, 0] + out[:, 2] / 2, out[:, 1] + out[:, 3] / 2], 1) / r
    valid = scores > 0.1
    boxes, scores = boxes[valid], scores[valid]
    if not len(boxes):
        return np.zeros((0, 4))
    keep = [i for i in _nms(boxes, scores, 0.45) if scores[i] > SCORE]
    return boxes[keep]


def _warp(center, scale):
    """The affine matrix from the box (center, scale) to the pose model input (w 288, h 384)."""
    w, h = POSE_SIZE
    src = np.array([center, center + [0, -scale[0] * 0.5], [0, 0]], np.float32)
    dst = np.array([[w * 0.5, h * 0.5], [w * 0.5, h * 0.5 - w * 0.5], [0, 0]], np.float32)
    src[2] = src[1] + [-(src[0] - src[1])[1], (src[0] - src[1])[0]]
    dst[2] = dst[1] + [-(dst[0] - dst[1])[1], (dst[0] - dst[1])[0]]
    return cv2.getAffineTransform(src, dst)


def estimate_poses(model, frames_bgr, boxes):
    """The 133 whole-body points [x, y, score] of the person in each box (one box per frame)."""
    inputs, centers, scales = [], [], []
    w, h = POSE_SIZE
    for bgr, box in zip(frames_bgr, boxes):
        center = np.array([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2])
        scale = np.array([box[2] - box[0], box[3] - box[1]]) * 1.25
        scale = np.array([scale[0], scale[0] / (w / h)]) if scale[0] > scale[1] * (w / h) else np.array([scale[1] * (w / h), scale[1]])
        crop = cv2.warpAffine(bgr, _warp(center, scale), (w, h), flags=cv2.INTER_LINEAR)
        inputs.append(((crop - POSE_MEAN) / POSE_STD).transpose(2, 0, 1))
        centers.append(center)
        scales.append(scale)
    count = len(inputs)
    while len(inputs) % POSE_BATCH:
        inputs.append(np.zeros_like(inputs[0]))
    p = next(model.parameters())
    xs, ys = [], []
    with torch.no_grad():
        for i in range(0, len(inputs), POSE_BATCH):
            out = model(torch.from_numpy(np.stack(inputs[i:i + POSE_BATCH]).astype(np.float32)).to(p.device, p.dtype))
            xs.append(out[0].float().cpu().numpy())
            ys.append(out[1].float().cpu().numpy())
    simcc_x, simcc_y = np.concatenate(xs)[:count], np.concatenate(ys)[:count]
    locs = np.stack([simcc_x.argmax(2), simcc_y.argmax(2)], -1).astype(np.float32) / 2.0
    vals = np.minimum(simcc_x.max(2), simcc_y.max(2))
    locs[vals <= 0] = -1
    points = locs / np.array(POSE_SIZE) * np.array(scales)[:, None] + np.array(centers)[:, None] - np.array(scales)[:, None] / 2
    return np.concatenate([points, vals[..., None]], -1)


def body_points(whole):
    """The OpenPose body (18 points [x, y, score]) of 133 whole-body points."""
    neck = whole[[5, 6]].mean(0)
    neck[2] = float(whole[5, 2] > SCORE and whole[6, 2] > SCORE)
    p = np.insert(whole, 17, neck, axis=0)
    p[OPENPOSE_IDX] = p[MMPOSE_IDX]
    return p[:18]


def draw_body(body, height, width):
    """The body drawn like ControlNet's OpenPose annotator: limbs at 60% colour, joints as dots, on black."""
    k = DRAW_SIDE / min(height, width)
    canvas = np.zeros((round(height * k), round(width * k), 3), np.uint8)
    pts = [(x * k, y * k) if s >= SCORE else None for x, y, s in body]
    for (a, b), color in zip(LIMBS, COLORS):
        p1, p2 = pts[a - 1], pts[b - 1]
        if p1 is None or p2 is None:
            continue
        length = ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5
        angle = np.degrees(np.arctan2(p1[1] - p2[1], p1[0] - p2[0]))
        polygon = cv2.ellipse2Poly((int((p1[0] + p2[0]) / 2), int((p1[1] + p2[1]) / 2)), (int(length / 2), 4), int(angle), 0, 360, 1)
        cv2.fillConvexPoly(canvas, polygon, [int(c * 0.6) for c in color])
    for p, color in zip(pts, COLORS):
        if p is not None:
            cv2.circle(canvas, (int(p[0]), int(p[1])), 4, color, thickness=-1)
    return cv2.resize(canvas, (width, height), interpolation=cv2.INTER_AREA)


def _overlap(a, b):
    w = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - w * h
    return w * h / union if union > 0 else 0.0


def people_in_order(boxes):
    """The people of a frame from left to right (box centers); someone far smaller than the largest (a passer-by in
    the distance, under 15% of its area) does not count."""
    area = lambda b: (b[2] - b[0]) * (b[3] - b[1])
    largest = max(area(b) for b in boxes)
    return sorted([b for b in boxes if area(b) >= 0.15 * largest], key=lambda b: b[0] + b[2])


def pick_person(boxes, target, width, height):
    """The person to replace in the first frame with people. target: {} the largest; {'order': k} the k-th from the
    left (1-based); {'box': [x0, y0, x1, y1]} (0-1, the box carried over from the previous window) the box that
    overlaps it most, else the nearest one."""
    area = lambda b: (b[2] - b[0]) * (b[3] - b[1])
    if target.get('order'):
        ordered = people_in_order(boxes)
        k = int(target['order'])
        if k > len(ordered):
            raise ValueError(f'Only {len(ordered)} people were found in the first frame; photo {k} has no one to replace.')
        return ordered[k - 1]
    if target.get('box'):
        hint = np.array(target['box'], np.float64) * [width, height, width, height]
        best = max(boxes, key=lambda b: _overlap(b, hint))
        if _overlap(best, hint) > 0.1:
            return best
        center = lambda b: np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])
        return min(boxes, key=lambda b: np.linalg.norm(center(b) - center(hint)))
    return max(boxes, key=area)


LOOK_BINS = [16, 8]  # hue x saturation


def look(bgr, box, fg=None):
    """The colours of a person: a hue x saturation histogram of the middle of the box (the middle 60% of its width,
    10-90% of its height: the clothes and hair, little background), only the foreground there when it is given."""
    h, w = bgr.shape[:2]
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    l, r = int(max(0, x1 + bw * 0.2)), int(min(w, x2 - bw * 0.2))
    t, b = int(max(0, y1 + bh * 0.1)), int(min(h, y2 - bh * 0.1))
    if r - l < 2 or b - t < 2:
        l, r, t, b = int(max(0, x1)), int(min(w, x2)), int(max(0, y1)), int(min(h, y2))
    if r - l < 1 or b - t < 1:
        return None
    hsv = cv2.cvtColor(np.ascontiguousarray(bgr[t:b, l:r]), cv2.COLOR_BGR2HSV)
    mask = None
    if fg is not None:
        m = (fg[t:b, l:r] > 0.5).astype(np.uint8)
        if m.sum() >= m.size * 0.2:
            mask = m
    hist = cv2.calcHist([hsv], [0, 1], mask, LOOK_BINS, [0, 180, 0, 256])
    return cv2.normalize(hist, hist, 1, 0, cv2.NORM_L1)


def similar(a, b):
    """How alike two looks are: 1 the same colours, 0 none in common."""
    if a is None or b is None:
        return 0.0
    return 1.0 - cv2.compareHist(a, b, cv2.HISTCMP_BHATTACHARYYA)


# Two people hugging are one box for the detector, and when they part or the shot changes the box that overlaps the
# last one can be the other person. So the look decides too, against the person's look where they were picked (fixed:
# a look that follows along drifts to the other one during the hug). The overlapping box is kept while it looks at
# least a little like the person (LOW: the hug box has them in it) and nobody looks clearly more like them (MARGIN);
# else whoever looks like them (SAME) is taken; else they are not in the shot. Measured on the balloon scene
# (11.10.2026, the girl followed): the girl 0.58-0.88, the hug box 0.45, the man 0.18-0.45 in the first shot and
# 0.22-0.27 after the cut.
LOW = 0.3
SAME = 0.55
MARGIN = 0.15
BRIEF = 5  # frames


def follow_person(detections, target=None, width=1, height=1, frames=None, foreground=None):
    """One box per frame: the person picked in the first frame with people (pick_person), then the box overlapping the
    last one most. With the frames (BGR) the person's look is followed too: after a cut the one who looks like them
    is taken, and a frame where nobody does gets None (the person is not in the shot). Without the frames a frame
    with no overlapping box keeps the last box. Returns (boxes, the person's look); boxes is None when no frame has a
    person."""
    first = next((i for i, d in enumerate(detections) if len(d)), None)
    if first is None:
        return None, None
    target = target or {}
    last = pick_person(detections[first], target, width, height)
    fg = lambda i: None if foreground is None else foreground[min(i, len(foreground) - 1)]
    # the look carried over from the previous window: the picked box must look like it too (a window can start in a
    # shot without the person)
    given = frames is not None and bool(target.get('look'))
    ref = None
    if given:
        ref = np.array(target['look'], np.float32).reshape(LOOK_BINS)
    elif frames is not None:
        ref = look(frames[first], last, fg(first))
    boxes = []
    for i, d in enumerate(detections):
        here = last
        if (i > first or (i == first and given)) and len(d):
            near = max(range(len(d)), key=lambda k: _overlap(d[k], last))
            if ref is None:
                if _overlap(d[near], last) > 0.1:
                    last = here = d[near]
            else:
                alike = [similar(look(frames[i], b, fg(i)), ref) for b in d]
                most = int(np.argmax(alike))
                if _overlap(d[near], last) > 0.1 and alike[near] >= LOW and alike[near] >= alike[most] - MARGIN:
                    pick = near
                elif alike[most] >= SAME:
                    pick = most
                else:
                    pick = None
                if pick is None:
                    here = None
                else:
                    last = here = d[pick]
        boxes.append(None if here is None else np.array(here, np.float64))
    # a few frames without the person between frames with them are a miss (blur, a turn), not an absence
    i = 0
    while i < len(boxes):
        if boxes[i] is not None:
            i += 1
            continue
        j = i
        while j < len(boxes) and boxes[j] is None:
            j += 1
        if j - i < BRIEF and i > 0 and j < len(boxes):
            for k in range(i, j):
                boxes[k] = boxes[i - 1] if k - i < j - k else boxes[j]
        i = j
    return boxes, ref


def _fill(values, valid):
    """Frames without a value take the nearest frame's (values: [N, k])."""
    idx = np.where(valid)[0]
    if not len(idx):
        return None
    out = values.copy()
    for i in range(len(values)):
        if not valid[i]:
            out[i] = values[idx[np.abs(idx - i).argmin()]]
    return out


def _smooth(values, size=5):
    pad = size // 2
    padded = np.concatenate([values[:1].repeat(pad, 0), values, values[-1:].repeat(pad, 0)])
    return np.stack([padded[i:i + size].mean(0) for i in range(len(values))])


def face_boxes(wholes, boxes):
    """A square around the face in each frame [cx, cy, side]: the face points (1.3 x their extent), else the head
    from the body points, else the nearest frame's; smoothed over 5 frames against jitter."""
    out = np.zeros((len(wholes), 3))
    valid = np.zeros(len(wholes), bool)
    for i, whole in enumerate(wholes):
        face = whole[23:91]
        face = face[face[:, 2] > SCORE]
        if len(face) >= 10:
            x1, y1 = face[:, :2].min(0)
            x2, y2 = face[:, :2].max(0)
            out[i] = [(x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1) * 1.3]
            valid[i] = True
            continue
        head = whole[0:5]
        head = head[head[:, 2] > SCORE]
        if len(head) >= 2:
            c = head[:, :2].mean(0)
            side = max(np.ptp(head[:, 0]), np.ptp(head[:, 1]), (boxes[i][3] - boxes[i][1]) * 0.08) * 2.2
            out[i] = [c[0], c[1], side]
            valid[i] = True
    filled = _fill(out, valid)
    if filled is None:
        # no face anywhere: the top of the person's box
        filled = np.array([[(b[0] + b[2]) / 2, b[1] + (b[2] - b[0]) * 0.3, (b[2] - b[0]) * 0.6] for b in boxes])
    return _smooth(filled)


def person_mask(fg, box, height, width, grow, block):
    """The area to repaint: the foreground inside the person's box (the box itself if the foreground misses it), grown
    by `grow` pixels and made blocky (every touched `block` x `block` square whole)."""
    x1, y1, x2, y2 = box
    mx, my = (x2 - x1) * 0.08, (y2 - y1) * 0.08
    region = np.zeros((height, width), bool)
    region[max(0, int(y1 - my)):min(height, int(y2 + my) + 1), max(0, int(x1 - mx)):min(width, int(x2 + mx) + 1)] = True
    m = region if fg is None else (fg > 0.5) & region
    if m.sum() < region.sum() * 0.05:
        m = region
    m = m.astype(np.uint8)
    if grow > 0:
        m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1, 2 * grow + 1)))
    if block > 1:
        bh, bw = -(-height // block), -(-width // block)
        padded = np.zeros((bh * block, bw * block), np.uint8)
        padded[:height, :width] = m
        cells = padded.reshape(bh, block, bw, block).max(axis=(1, 3))
        m = cells.repeat(block, 0).repeat(block, 1)[:height, :width]
    return m.astype(np.float32)


def _load(name):
    path = folder_paths.get_full_path_or_raise(POSE, name)
    model = torch.jit.load(path, map_location=mm.get_torch_device())
    model.eval()
    return model


class NedeseReplacePrep:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            'required': {
                'images': ('IMAGE', {'tooltip': 'The frames of the video whose person is replaced.'}),
                'grow': ('INT', {'default': 20, 'min': 0, 'max': 200, 'tooltip': 'Pixels the person area is grown by.'}),
                'block': ('INT', {'default': 32, 'min': 1, 'max': 256, 'tooltip': 'The person area is made of whole squares of this size.'}),
            },
            'optional': {
                'foreground': ('MASK', {'tooltip': 'The foreground of every frame (Remove Background); without it the person box is used.'}),
                'target': ('STRING', {'default': '', 'tooltip': 'Which person (JSON): empty the largest; {"order": k} the k-th from the left; {"box": [x0, y0, x1, y1]} (0-1) the one there.'}),
            },
        }

    RETURN_TYPES = ('IMAGE', 'IMAGE', 'IMAGE', 'MASK')
    RETURN_NAMES = ('pose_video', 'face_video', 'background_video', 'character_mask')
    FUNCTION = 'run'
    CATEGORY = 'Nedese Studio'
    DESCRIPTION = 'The pose, face, background and person mask of a video for WanAnimateToVideo (replacing its person).'

    def run(self, images, grow, block, foreground=None, target=''):
        frames = (images[..., :3].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
        count, height, width = frames.shape[:3]
        bgr = [np.ascontiguousarray(f[..., ::-1]) for f in frames]
        detector = _load(DETECTOR)
        try:
            detections = [detect_people(detector, f) for f in bgr]
        finally:
            del detector
        fg = None if foreground is None else foreground.cpu().numpy()
        if fg is not None and fg.shape[1:] != (height, width):
            fg = np.stack([cv2.resize(m, (width, height), interpolation=cv2.INTER_LINEAR) for m in fg])
        boxes, seen = follow_person(detections, json.loads(target) if target else {}, width, height, frames=bgr, foreground=fg)
        if boxes is None:
            raise ValueError('No person was found in the video.')
        # frames without the person (another shot): nothing is repainted there
        present = np.array([b is not None for b in boxes])
        near = np.where(present)[0]
        filled = [b if b is not None else boxes[near[np.abs(near - i).argmin()]] for i, b in enumerate(boxes)]
        model = _load(POSE_MODEL)
        try:
            wholes = estimate_poses(model, bgr, filled)
        finally:
            del model
            mm.soft_empty_cache()
        for i in np.where(~present)[0]:
            wholes[i][:, 2] = 0

        pose = np.stack([draw_body(body_points(w), height, width) if p else np.zeros((height, width, 3), np.uint8) for w, p in zip(wholes, present)])
        faces = []
        for f, (cx, cy, side) in zip(frames, face_boxes(wholes, filled)):
            s = max(16, int(round(side)))
            faces.append(cv2.resize(cv2.getRectSubPix(f, (s, s), (float(cx), float(cy))), (512, 512), interpolation=cv2.INTER_AREA if s > 512 else cv2.INTER_CUBIC))
        masks = np.stack([person_mask(None if fg is None else fg[min(i, len(fg) - 1)], boxes[i], height, width, grow, block) if present[i] else np.zeros((height, width), np.float32) for i in range(count)])
        background = frames.astype(np.float32) / 255 * (1 - masks[..., None])

        found = sum(1 for d in detections if len(d))
        print(f'[Nedese] replace prep: {count} frames {width}x{height}, a person in {found}, the followed one in {int(present.sum())}, mask {masks.mean() * 100:.0f}% of the picture')
        as_image = lambda a: torch.from_numpy(np.ascontiguousarray(a)).float() / 255
        # the person's box in every frame (0-1, null where they are not in the shot): the next window follows them from it
        followed = [None if b is None else [round(float(b[0]) / width, 4), round(float(b[1]) / height, 4), round(float(b[2]) / width, 4), round(float(b[3]) / height, 4)] for b in boxes]
        carried = [] if seen is None else [round(float(v), 5) for v in seen.ravel()]
        return {'ui': {'boxes': [json.dumps(followed)], 'look': [json.dumps(carried)]}, 'result': (as_image(pose), as_image(np.stack(faces)), torch.from_numpy(background), torch.from_numpy(masks))}


NODE_CLASS_MAPPINGS = {'NedeseReplacePrep': NedeseReplacePrep}
NODE_DISPLAY_NAME_MAPPINGS = {'NedeseReplacePrep': 'Replace person: pose, face, mask (Nedese)'}
