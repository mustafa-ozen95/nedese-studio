# Replace prep test. Following (follow_person): after a cut that swaps two people the followed one is kept by their
# look, a shot without them gives None, a brief miss is filled, and a window that starts without them does not take
# someone else; a person whose look changes after a cut (a close-up against the light) is kept by their place while
# the one beside them looks more like them. Face swap: the mask covers the face, not the body.
# Usage: ComfyUI_windows_portable\python_embeded\python.exe -I tools\comfy-nodes\nedese_animate\prep_test.py
import importlib.util, os, sys, types
import numpy as np

for name in ('comfy', 'comfy.model_management', 'folder_paths'):
    sys.modules[name] = types.ModuleType(name)
sys.modules['comfy'].model_management = sys.modules['comfy.model_management']
sys.modules['folder_paths'].folder_names_and_paths = {'pose': None}
spec = importlib.util.spec_from_file_location('nedese_animate', os.path.join(os.path.dirname(os.path.abspath(__file__)), '__init__.py'))
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)

W, H = 400, 200
YELLOW, NAVY, SKIN = (40, 200, 230), (90, 40, 30), (60, 120, 200)  # BGR


def shot(people):
    """A frame with people [(x0, colour or (top, bottom))] (100 x 160 each) on grey, and their boxes."""
    f = np.full((H, W, 3), 128, np.uint8)
    boxes = []
    for x, colour in people:
        top, bottom = colour if isinstance(colour[0], tuple) else (colour, colour)
        f[20:100, x:x + 100] = top
        f[100:180, x:x + 100] = bottom
        boxes.append([x, 20, x + 100, 180])
    return f, np.array(boxes, np.float64)


plan = (
    [[(60, YELLOW), (240, NAVY)]] * 8  # the girl left, the man right
    + [[(240, YELLOW), (60, NAVY)]] * 6  # a cut: the man where the girl stood
    + [[(60, NAVY)]] * 2  # the girl missed for two frames
    + [[(240, YELLOW), (60, NAVY)]] * 2
    + [[(60, NAVY)]] * 6  # a shot with only the man
)
frames, detections = zip(*(shot(p) for p in plan))
boxes, seen, place = n.follow_person(list(detections), {'order': 1}, W, H, frames=list(frames))
x = lambda b: None if b is None else int(b[0])
got = [x(b) for b in boxes]
assert got[:8] == [60] * 8, got
assert got[8:14] == [240] * 6, ('the man was taken after the cut', got)
assert got[14:16] == [240] * 2, ('a brief miss is filled', got)
assert got[16:18] == [240] * 2, got
assert got[18:] == [None] * 6, ('the girl is not in the last shot', got)
assert seen is not None and seen.shape == (16, 8)
assert place == [2, 2], ('the swap moves her place', place)

# without the frames: the old way, the box that overlaps the last one
old, _, _ = n.follow_person(list(detections), {'order': 1}, W, H)
assert [x(b) for b in old][8] == 60

# the next window starts in the shot with only the man: the girl's look keeps him from being taken
later, _, _ = n.follow_person(list(detections[18:]) + list(detections[8:12]), {'box': [0.15, 0.1, 0.4, 0.9], 'look': seen.ravel().tolist()}, W, H, frames=list(frames[18:]) + list(frames[8:12]))
assert [x(b) for b in later] == [None] * 6 + [240] * 4, [x(b) for b in later]

# the man followed (right) is all face and neck in the close-up after the cut (unlike his look), the boy beside him
# half navy now (more like it, not the same): his place keeps him, and the next window keeps it from the carried place
plan = [[(60, YELLOW), (240, NAVY)]] * 4 + [[(60, (NAVY, YELLOW)), (240, SKIN)]] * 8
frames, detections = zip(*(shot(p) for p in plan))
man, look, place = n.follow_person(list(detections), {'order': 2}, W, H, frames=list(frames))
assert [x(b) for b in man] == [240] * 12, ('his place keeps him', [x(b) for b in man])
assert place == [2, 2], place
carried = {'box': [0.6, 0.1, 0.85, 0.9], 'look': look.ravel().tolist(), 'place': place}
man, _, _ = n.follow_person(list(detections[4:]), carried, W, H, frames=list(frames[4:]))
assert [x(b) for b in man] == [240] * 8, ('the next window too', [x(b) for b in man])

# a face swap repaints the face, not the body: the face square (centre 110, 50, side 40) of a person at 60-160 x 20-180
face = n.person_mask(None, n.face_region([110, 50, 40]), H, W, 10, 16)
whole = n.person_mask(None, [60, 20, 160, 180], H, W, 20, 32)
assert face[50, 110] == 1 and face[150, 110] == 0 and face[50, 60] == 0, 'the face only'
assert whole[150, 110] == 1
assert face.sum() < whole.sum() * 0.25, (face.sum(), whole.sum())
print('prep test passed')
