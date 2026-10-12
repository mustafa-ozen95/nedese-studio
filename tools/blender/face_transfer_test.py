# face_transfer.py's move test (Blender): a face with a thin inner wall behind it (Pixal3D's shell) moves onto a head
# surface that lies deeper and tilted. The wall stays under the moved face (put on the head with it, it showed through
# in patches and a game copy's normal map came out in dark blotches, 12.10.2026), and the moved face's normals are the
# new surface's, not the glTF's old ones.
# Usage: blender -b --factory-startup --python-exit-code 1 -P tools\blender\face_transfer_test.py
import importlib.util
import math
import os
import sys
from types import SimpleNamespace

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

spec = importlib.util.spec_from_file_location('face_transfer', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'face_transfer.py'))
ft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ft)

FOV, SIZE, EYE = 30.0, 1024, 0.06
N, HALF, WALL = 101, 0.1, 0.02
TILT = math.radians(20)  # the head's surface turned about the vertical axis


def grid(y, away):
    """An N x N grid in the plane y (x, z in -HALF..HALF), its faces turned to the camera (-y) or away from it."""
    s = np.linspace(-HALF, HALF, N)
    points = [(x, y, z) for z in s for x in s]
    faces = []
    for j in range(N - 1):
        for i in range(N - 1):
            a, b, c, d = j * N + i, j * N + i + 1, (j + 1) * N + i + 1, (j + 1) * N + i
            faces.append((a, d, c, b) if away else (a, b, c, d))
    return points, faces


def head_y(x):
    return 0.03 + x * math.tan(TILT)


bpy.ops.wm.read_factory_settings(use_empty=True)
front, front_faces = grid(0.0, away=False)
wall, wall_faces = grid(WALL, away=True)
mesh = bpy.data.meshes.new('body')
mesh.from_pydata(front + wall, [], front_faces + [tuple(i + len(front) for i in f) for f in wall_faces])
mesh.update(calc_edges=True)
# the glTF's normals: straight at the camera on the face, away from it on the wall
mesh.normals_split_custom_set([(0, -1, 0) if l.vertex_index < len(front) else (0, 1, 0) for l in mesh.loops])
body = bpy.data.objects.new('body', mesh)
bpy.context.scene.collection.objects.link(body)

head_points = [(x, head_y(x), z) for z in (-1, 1) for x in (-1, 1)]
head = BVHTree.FromPolygons([Vector(p) for p in head_points], [(0, 1, 3, 2)])
a = SimpleNamespace(fov=FOV, size=SIZE, face=[SIZE / 2 - 50, SIZE / 2 - 50, 100, 100])
weights = ft.move_vertices(a, body, head, EYE)

co = np.empty(len(mesh.vertices) * 3, np.float32)
mesh.vertices.foreach_get('co', co)
co = co.reshape(-1, 3)
core = (np.abs(co[:, 0]) < 0.015) & (np.abs(co[:, 2]) < 0.015) & (weights > 0.95)
f, w = core[:len(front)], core[len(front):]
assert f.sum() > 4 and w.sum() > 4, f'core vertices: face {f.sum()}, wall {w.sum()}'
face_gap = np.abs(co[:len(front)][f, 1] - head_y(co[:len(front)][f, 0])).max()
assert face_gap < 0.002, f'the face is {face_gap:.4f} off the head'
under = (co[len(front):][w, 1] - head_y(co[len(front):][w, 0])).min()
assert under > WALL / 2, f'the inner wall is only {under:.4f} under the moved face (it should keep ~{WALL})'

normals = np.empty(len(mesh.loops) * 3, np.float32)
mesh.corner_normals.foreach_get('vector', normals)
normals = normals.reshape(-1, 3)
corners = np.empty(len(mesh.loops), np.int32)
mesh.loops.foreach_get('vertex_index', corners)
surface = np.empty(len(mesh.vertices) * 3, np.float32)
mesh.vertices.foreach_get('normal', surface)
surface = surface.reshape(-1, 3)[corners]
face_corners = (corners < len(front)) & core[corners]
worst = (normals[face_corners] * surface[face_corners]).sum(1).min()
assert worst > 0.99, f'a moved face normal is {math.degrees(math.acos(min(worst, 1))):.0f} degrees off the new surface'
tilt = math.degrees(math.acos(float(np.clip(-normals[face_corners].mean(0)[1], -1, 1))))
assert abs(tilt - math.degrees(TILT)) < 3, f"the moved face's normals lean {tilt:.0f} degrees, the head's {math.degrees(TILT):.0f}"
print('face_transfer_test: OK')
sys.exit(0)
