# Face picker test (patch.py): a face outside the target box (the listener) is not picked, the previous frame is used.
# Usage: .venv\Scripts\python.exe face_test.py
import os, sys, types
import numpy as np
ROOT = os.path.dirname(os.path.abspath(__file__))
os.environ["LS_FACE_MODEL"] = os.path.join(ROOT, "..", "models", "latentsync", "face_landmarker.task")
sys.path.insert(0, os.path.join(ROOT, "LatentSync"))
from latentsync.utils.face_detector import FaceDetector

def face(cx, cy):
    n = types.SimpleNamespace
    return [n(x=(cx + dx) / 100, y=(cy + dy) / 100) for dx, dy in np.random.RandomState(0).uniform(-5, 5, (478, 2))]

class Fake:
    def __init__(self): self.faces = []
    def detect(self, im): return types.SimpleNamespace(face_landmarks=self.faces)

os.environ["LS_TARGET_BOX"] = "10,10,30,30"  # the speaker on the left (in a 100x100 frame)
d = FaceDetector()
d.landmarker = Fake()
frame = np.zeros((100, 100, 3), np.uint8)
d.landmarker.faces = [face(20, 20), face(80, 80)]
k1, _ = d(frame)
assert 10 <= (k1[0] + k1[2]) / 2 <= 30, k1
d.landmarker.faces = [face(80, 80)]  # the speaker was not found, only the listener
k2, _ = d(frame)
assert (k2 == k1).all(), ("the listener was picked", k2)
print("face picker test passed")
