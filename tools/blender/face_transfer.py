"""
The face of a separately generated head put onto a full-body Pixal3D model (Blender, no window):
  blender -b --factory-startup --python-exit-code 1 -P face_transfer.py -- --head head.glb --head-fov 41.6
      --head-face "[...15]" --head-size 1024 --fov 32.8 --face "[...15]" --size 1024 --models model.glb game.glb

- A full-body figure's face is ~100 px of the generation's input: Pixal3D's voxels lose it (eyes without irises, a
  blurred mouth; user 11.10.2026: "yeterli değil"). The panel makes a head-and-shoulders portrait of the same person,
  generates a head from it (pixel aligned with its own picture, like the body) and this script puts its face on the body.
- The faces' five points (YuNet: eyes, nose, mouth corners) are cast from each picture's camera onto its model; a
  similarity transform (Umeyama) puts the head on the body's face.
- Geometry: inside an ellipse around the body's face, on the layer the camera sees first, each vertex moves along its
  view ray onto the head's surface where the surface faces the camera at large; everywhere else in the ellipse and
  in a band around it the offset is harmonic (Laplace's equation, 0 at the band's edge), so the new face settles onto
  the body without a fold. Vertices split at UV seams move together (welded by position): a seam does not open. A
  hidden layer that faces away (the face's inner wall) moves with the surface in front of it and stays under it; the
  moved vertices take the new surface's normals.
- Texture: each texel of the face region casts the camera's ray onto the head and takes the head's colour (tone matched
  to the body's), roughness and metallic; the normal map is flat there (the head's own detail is in the new geometry).
  Texels whose ray found the head too far from them (the mouth corners, the eyelids' folds) take their neighbours'
  colour: left as they were they stayed as dark specks in the face (11.10.2026).
- Game copies (the models after the first): the full model's new face colours, roughness and metallic are baked onto
  their UVs (selected to active); their meshes stay, their normal maps are baked from the full model afterwards.
- The models are written back in place (before the skeleton: they are exported without an armature).
- The result is printed on the last line as "RESULT {json}" (models: [{file, moved, sampled, filled, seconds} or
  {file, skipped}]).
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model3d  # noqa: E402

# The face region: an ellipse around the face box, EX x its width and EY x its height (radius). The head's colours go
# in it, faded from FADE on. Measured on a woman (11.10.2026): the face to the hairline and the chin, the ears and
# the hair stay the body's.
EX, EY, FADE = 0.55, 0.6, 0.8
# The geometry goes onto the head inside MOVE_REACH x that ellipse: to the hairline (12.10.2026) the hair there,
# lumpy in the body and the head alike but differently, came out lumpier still put onto the head's; the forehead's
# top is carried over smoothly instead.
MOVE_REACH = 0.83
# The geometry goes onto the head inside the ellipse and settles back onto the body over a band around it, to BAND x
# the radius: the offsets are harmonic there (Laplace's equation, 0 at the band's edge), so the new face meets the
# body without a fold. Faded out inside the ellipse's last 20% (12.10.2026) they left a ridge down the cheek and along
# the hairline, where the head's surface lay up to 0.6 eye distances from the body's.
BAND = 1.6
# A view-ray offset is trusted where the surface faces the camera (|normal . ray| from FACING[0] to FACING[1]): at a
# silhouette a small difference between the head and the body is a long way along the ray.
FACING = (0.25, 0.5)
NORMAL_ROUNDS = 20
HARMONIC_ROUNDS = 6000
# The first layer the camera sees: a vertex this far (x the eye distance) behind the first surface on its ray is out
# (the back of the head), with a soft edge from FRONT[0] to FRONT[1]. Eye sockets' walls stay in.
FRONT = (0.4, 0.8)
# A head surface farther than this (x the eye distance) along the ray gives no offset (the hair, the shoulders).
GAP = 0.6
# The validity of the offsets spread over the mesh: the colours fade out where the head has no surface near.
VALID_ROUNDS, VALID = 30, (0.3, 0.9)
# Laplacian rounds over the moved region: folds where vertices of different depths landed on the same surface.
SMOOTH_ROUNDS = 8
FLIP_ROUNDS = 60
# A texel takes the head's colour when the ray's hit is this close to it (x the eye distance); the others are filled.
TEXEL_TOLERANCE = 0.15
FILL_TEXELS = 24
# A game copy takes the full model's new face by a selected-to-active bake: the cage and the ray reach, a share of the
# copy's largest dimension (game_copies.py's values: they held for the woman and a furry dwarf)
COPY_EXTRUSION = 0.02
COPY_REACH = 0.05


def args():
    p = argparse.ArgumentParser(description="A separately generated head's face onto a full-body model")
    p.add_argument('--head', required=True, help='the head model (GLB), generated from a portrait of the same person')
    p.add_argument('--head-fov', type=float, required=True, help="the horizontal field of view of the head's picture (degrees)")
    p.add_argument('--head-face', required=True, help="the face in the head's picture: JSON [x, y, w, h, 5 points, score]")
    p.add_argument('--head-size', type=int, required=True, help="the head's picture size (square, px)")
    p.add_argument('--fov', type=float, required=True, help="the horizontal field of view of the body's picture (degrees)")
    p.add_argument('--face', required=True, help="the face in the body's picture: JSON [x, y, w, h, 5 points, score]")
    p.add_argument('--size', type=int, required=True, help="the body's picture size (square, px)")
    p.add_argument('--models', nargs='+', required=True, help='the body models (GLB), written back in place')
    return p.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def smooth(e0, e1, v):
    k = np.clip((v - e0) / (e1 - e0), 0, 1)
    return k * k * (3 - 2 * k)


def load(path):
    before = set(bpy.data.objects)
    model3d.import_model(path)
    objects = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in objects if o.type == 'MESH']
    return objects, (max(meshes, key=lambda o: len(o.data.vertices)) if meshes else None)


def world_points(o):
    co = np.empty(len(o.data.vertices) * 3, np.float32)
    o.data.vertices.foreach_get('co', co)
    m = np.array(o.matrix_world, np.float32)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def bvh_of(o):
    o.data.calc_loop_triangles()
    tris = np.empty(len(o.data.loop_triangles) * 3, np.int32)
    o.data.loop_triangles.foreach_get('vertices', tris)
    return BVHTree.FromPolygons([Vector(p) for p in world_points(o)], [tuple(t) for t in tris.reshape(-1, 3)])


def distance_of(fov):
    """Pixal3D's camera (front_projection.py): Z up, at -Y looking at the origin, the picture 1 unit wide there."""
    return 0.5 / math.tan(math.radians(fov) / 2)


def cast(bvh, fov, size, x, y_top):
    d = distance_of(fov)
    camera = Vector((0, -d, 0))
    target = Vector((x / size - 0.5, 0, 0.5 - y_top / size))
    return bvh.ray_cast(camera, (target - camera).normalized())[0]


def umeyama(src, dst):
    mu_s, mu_d = src.mean(0), dst.mean(0)
    s0, d0 = src - mu_s, dst - mu_d
    U, S, Vt = np.linalg.svd(d0.T @ s0 / len(src))
    D = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / ((s0 ** 2).sum() / len(src))
    return s, R, mu_d - s * R @ mu_s


def landmarks(bvh, fov, size, face):
    return [cast(bvh, fov, size, face[4 + 2 * i], face[5 + 2 * i]) for i in range(5)]


def place_head(a, head_objects, head, body):
    """Moves the head onto the body's face; returns the eye distance on the body and the points' residual (x eye)."""
    on_body = landmarks(bvh_of(body), a.fov, a.size, a.face)
    on_head = landmarks(bvh_of(head), a.head_fov, a.head_size, a.head_face)
    pairs = [(h, b) for h, b in zip(on_head, on_body) if h is not None and b is not None]
    if len(pairs) < 4:
        raise SystemExit(f'Only {len(pairs)} of the 5 face points are on the models')
    src = np.array([tuple(h) for h, _ in pairs])
    dst = np.array([tuple(b) for _, b in pairs])
    s, R, t = umeyama(src, dst)
    transform = Matrix.Translation(Vector(t)) @ Matrix(R.tolist()).to_4x4() @ Matrix.Scale(s, 4)
    for o in head_objects:
        if o.parent is None:
            o.matrix_world = transform @ o.matrix_world
    bpy.context.view_layer.update()
    # the distance between the eyes on the body: the face's scale (else the eye to mouth corner span, about the same)
    eye = (on_body[0] - on_body[1]).length if on_body[0] is not None and on_body[1] is not None else float(np.linalg.norm(dst[0] - dst[-1]))
    residual = np.linalg.norm((s * src @ R.T + t) - dst, axis=1).max() / eye
    return eye, float(residual), float(s)


def face_region(a, body, eye, reach=1.0):
    """The camera, the body's vertices (world), their radius from the face's centre (1 at the ellipse's edge) and
    each one's weight on the first layer the camera sees (0 beyond `reach` x the radius, behind the first surface on
    its ray, or without a hit)."""
    d = distance_of(a.fov)
    camera = np.array([0, -d, 0], np.float32)
    P = world_points(body)
    depth = P[:, 1] + d
    u = a.size * d * P[:, 0] / depth + a.size / 2
    v = a.size - (a.size * d * P[:, 2] / depth + a.size / 2)
    x, y, w, h = a.face[:4]
    r = np.sqrt(((u - (x + w / 2)) / (w * EX)) ** 2 + ((v - (y + h / 2)) / (h * EY)) ** 2)
    body_bvh = bvh_of(body)
    cam = Vector(camera)
    front = np.zeros(len(P), np.float32)
    for i in np.nonzero(r < reach)[0]:
        ray = Vector(P[i]) - cam
        hit = body_bvh.ray_cast(cam, ray.normalized())[0]
        if hit is not None:
            front[i] = 1 - smooth(FRONT[0], FRONT[1], max(ray.length - (hit - cam).length, 0) / eye)
    return camera, P, r, front


def colour_weights(r, front):
    """The head's colours' weight: the ellipse, faded from FADE on, on the first layer."""
    return (1 - smooth(FADE, 1.0, r)) * front


def move_vertices(a, body, head_bvh, eye):
    """The face's vertices onto the head along their view rays, the band around the face settled back onto the body;
    returns the per-vertex weight of the head's colours (0..1)."""
    camera, P, r, front = face_region(a, body, eye, BAND)
    cam = Vector(camera)
    rays = P - camera
    rays /= np.linalg.norm(rays, axis=1, keepdims=True)
    normals = np.empty(len(P) * 3, np.float32)
    body.data.vertices.foreach_get('normal', normals)
    normals = normals.reshape(-1, 3) @ np.array(body.matrix_world.to_3x3().inverted().transposed(), np.float32).T
    inner = (normals * rays).sum(1) > 0
    # the offsets are cast inside the ellipse on the first layer
    inside = (r < MOVE_REACH) & (front > 0)
    offset = np.zeros(len(P), np.float32)
    known = np.zeros(len(P), bool)
    behind = np.zeros(len(P), np.float32)
    body_bvh = bvh_of(body)
    for i in np.nonzero(inside)[0]:
        hit = head_bvh.ray_cast(cam, Vector(rays[i]))[0]
        if hit is None:
            continue
        # A layer behind the first surface that faces away (the face's inner wall) moves with the first surface and
        # keeps its depth under it. Put on the head itself it lay on the new face, facing in: patches of the inner side
        # showed through (z-fighting) and a game copy's normal map baked from it came out in dark blotches
        # (12.10.2026). A hidden part facing the camera (an eye socket's wall under the lid) goes onto the head: kept
        # under it, it left a dark crease around the old eye.
        if inner[i]:
            first_hit = body_bvh.ray_cast(cam, Vector(rays[i]))[0]
            behind[i] = max(float((Vector(P[i]) - cam).length - (first_hit - cam).length), 0) if first_hit is not None else 0
        t = float(np.dot(np.array(hit) - P[i], rays[i])) + float(behind[i])
        if abs(t) <= GAP * eye:
            offset[i], known[i] = t, True
    # every field per position: vertices split at UV seams move as one
    _, first, group = np.unique(P, axis=0, return_index=True, return_inverse=True)
    group = group.ravel()
    n = len(first)
    edges = np.empty(len(body.data.edges) * 2, np.int32)
    body.data.edges.foreach_get('vertices', edges)
    edges = group[edges.reshape(-1, 2)]
    gknown, gt, gP, grays = known[first], offset[first], P[first], rays[first]
    # the band: the face and its surroundings on the first layer; the offsets settle to 0 at its edge
    region = (r[first] < BAND) & (front[first] > 0)
    edges = edges[(region[edges[:, 0]] | region[edges[:, 1]]) & (edges[:, 0] != edges[:, 1])]
    ea, eb = np.concatenate([edges[:, 0], edges[:, 1]]), np.concatenate([edges[:, 1], edges[:, 0]])
    degree = np.bincount(ea, minlength=n).astype(np.float32)

    def neighbour_mean(f):
        return np.where(degree > 0, np.bincount(ea, weights=f[eb], minlength=n) / np.maximum(degree, 1), f)

    # An offset is trusted where the surface faces the camera at large (the normals averaged over NORMAL_ROUNDS
    # neighbours: the bumpy rims of the generated eyes face every way, the whole eye faces the camera).
    smoothed = normals[first].copy()
    for _ in range(NORMAL_ROUNDS):
        smoothed = np.stack([neighbour_mean(smoothed[:, c]) for c in range(3)], 1)
    macro = np.abs((smoothed * grays).sum(1)) / np.maximum(np.linalg.norm(smoothed, axis=1), 1e-6)
    gtrust = smooth(FACING[0], FACING[1], macro) * front[first] * (r[first] < MOVE_REACH) * gknown

    # The offset field: the trusted offsets where they are trusted, harmonic (each the mean of its neighbours)
    # elsewhere in the band, 0 outside it (Jacobi iterations; the band is a few hundred edges wide).
    fill = gt * gtrust
    for rounds in range(HARMONIC_ROUNDS):
        new = np.where(region, gtrust * gt + (1 - gtrust) * neighbour_mean(fill), 0)
        change = float(np.abs(new - fill).max())
        fill = new
        if rounds % 100 == 99 and change < 1e-5 * eye:
            break
    print(f'Offsets settled: {rounds + 1} rounds, last change {change / eye * 100:.3f}% of the eye distance', flush=True)
    # the colours' weight: the ellipse on the first layer, out where the head has no surface near
    valid = gknown.astype(np.float32)
    for _ in range(VALID_ROUNDS):
        valid = neighbour_mean(valid)
    gmask = colour_weights(r, front)[first] * smooth(VALID[0], VALID[1], valid)
    moved = gP + fill[:, None] * grays
    def relax(points, weight):
        mean = np.stack([np.bincount(ea, weights=points[eb, c], minlength=n) for c in range(3)], 1) / np.maximum(degree, 1)[:, None]
        k = (0.5 * weight * (degree > 0))[:, None]
        return points * (1 - k) + mean * k

    for _ in range(SMOOTH_ROUNDS):
        moved = relax(moved, gtrust)
    # Triangles the move turned away from the camera (a crease's two sides landed crossed on the head: dark specks at
    # the mouth corners and lines under the eyes in light, 11.10.2026) are relaxed until they face it again.
    body.data.calc_loop_triangles()
    tris = np.empty(len(body.data.loop_triangles) * 3, np.int32)
    body.data.loop_triangles.foreach_get('vertices', tris)
    tris = group[tris.reshape(-1, 3)]
    tris = tris[region[tris].any(1)]

    def facing(points):
        a, b, c = points[tris[:, 0]], points[tris[:, 1]], points[tris[:, 2]]
        return (np.cross(b - a, c - a) * ((a + b + c) / 3 - camera)).sum(1)

    front = facing(gP) < 0
    flipped = np.zeros(len(tris), bool)
    for rounds in range(FLIP_ROUNDS):
        flipped = front & (facing(moved) > 0)
        if not flipped.any():
            break
        weight = np.zeros(n, np.float32)
        weight[tris[flipped].ravel()] = 1
        for _ in range(2):
            weight = np.maximum(weight, neighbour_mean(weight) > 0)
        moved = relax(moved, weight * region)
    print(f'Flipped triangles: {int((front & (facing(moved) > 0)).sum())} left after {rounds + 1} rounds', flush=True)
    inverse = np.array(body.matrix_world.inverted(), np.float32)
    mesh = body.data
    old = None
    if mesh.has_custom_normals:
        old = np.empty(len(mesh.loops) * 3, np.float32)
        mesh.corner_normals.foreach_get('vector', old)
        old = old.reshape(-1, 3)
    mesh.vertices.foreach_set('co', (moved[group] @ inverse[:3, :3].T + inverse[:3, 3]).ravel())
    mesh.update()
    if old is not None:
        # The glTF's normals (custom) stayed the old face's: the light showed its eye pits and creases on the new one,
        # and a game copy's normal map baked from it came out in dark patches (12.10.2026). The moved region takes the
        # new surface's normals, the same for all vertices at a position (a UV seam does not show).
        normals = np.empty(len(mesh.vertices) * 3, np.float32)
        mesh.vertices.foreach_get('normal', normals)
        normals = normals.reshape(-1, 3)
        welded = np.zeros((n, 3), np.float32)
        np.add.at(welded, group, normals)
        welded /= np.maximum(np.linalg.norm(welded, axis=1, keepdims=True), 1e-12)
        corners = np.empty(len(mesh.loops), np.int32)
        mesh.loops.foreach_get('vertex_index', corners)
        # the vertices that moved take the new surface's normals
        w = np.minimum(np.abs(fill) / (0.02 * eye), 1)[group][corners][:, None]
        new = old * (1 - w) + welded[group][corners] * w
        new /= np.maximum(np.linalg.norm(new, axis=1, keepdims=True), 1e-12)
        mesh.normals_split_custom_set(new.tolist())
        mesh.update()
    return gmask[group]


def material_nodes(o):
    tree = o.active_material.node_tree
    bsdf = next(n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED')
    outputs = [n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL']
    return tree, bsdf, next((n for n in outputs if n.is_active_output), outputs[0])


def linked_image(tree, node, socket):
    link = next((l for l in tree.links if l.to_node == node and l.to_socket.name == socket), None)
    n = link and link.from_node
    while n is not None and n.type != 'TEX_IMAGE':
        inputs = [l for l in tree.links if l.to_node == n]
        n = inputs[0].from_node if inputs else None
    return n if n is not None and n.image else None


def maps(o):
    """The images of the base colour, the roughness/metallic and the normal map (None where there is none)."""
    if o.active_material is None or not o.active_material.use_nodes:
        return None, None, None
    tree, bsdf, _ = material_nodes(o)
    normal = next((n for n in tree.nodes if n.type == 'NORMAL_MAP'), None)
    return linked_image(tree, bsdf, 'Base Color'), linked_image(tree, bsdf, 'Roughness'), normal and linked_image(tree, normal, 'Color')


def bake_emission(o, size, socket_of):
    """A socket (made by socket_of(tree)) baked as emission into a float image of the texture's size."""
    tree, _, output = material_nodes(o)
    surface = next((l.from_socket for l in tree.links if l.to_node == output and l.to_socket.name == 'Surface'), None)
    source, socket = socket_of(tree)
    emission = tree.nodes.new('ShaderNodeEmission')
    tree.links.new(socket, emission.inputs['Color'])
    tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])
    target = tree.nodes.new('ShaderNodeTexImage')
    image = bpy.data.images.new('face_bake', size[0], size[1], float_buffer=True, alpha=True)
    image.colorspace_settings.name = 'Non-Color'
    image.generated_color = (0, 0, 0, 0)
    target.image = image
    for n in tree.nodes:
        n.select = False
    target.select = True
    tree.nodes.active = target
    model3d.select([o])
    bpy.context.view_layer.objects.active = o
    try:
        bpy.ops.object.bake(type='EMIT')
        pixels = np.empty(size[0] * size[1] * 4, np.float32)
        image.pixels.foreach_get(pixels)
        return pixels.reshape(size[1], size[0], 4)
    finally:
        if surface is not None:
            tree.links.new(surface, output.inputs['Surface'])
        for n in (source, emission, target):
            tree.nodes.remove(n)
        bpy.data.images.remove(image)


def pixels_of(image):
    w, h = image.size
    px = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(px)
    return px.reshape(h, w, 4)


def sample(image, uv):
    px = pixels_of(image)
    h, w = px.shape[:2]
    x = np.clip(uv[:, 0] * w - 0.5, 0, w - 1.001)
    y = np.clip(uv[:, 1] * h - 0.5, 0, h - 1.001)
    x0, y0 = x.astype(int), y.astype(int)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return px[y0, x0] * (1 - fx) * (1 - fy) + px[y0, x0 + 1] * fx * (1 - fy) + px[y0 + 1, x0] * (1 - fx) * fy + px[y0 + 1, x0 + 1] * fx * fy


class Head:
    """The head's triangles in world space: a texel's ray hit -> the head's UV there."""

    def __init__(self, head):
        m = head.data
        m.calc_loop_triangles()
        n = len(m.loop_triangles)
        self.loops = np.empty(n * 3, np.int32)
        m.loop_triangles.foreach_get('loops', self.loops)
        self.loops = self.loops.reshape(-1, 3)
        self.verts = np.empty(n * 3, np.int32)
        m.loop_triangles.foreach_get('vertices', self.verts)
        self.verts = self.verts.reshape(-1, 3)
        uv = np.empty(len(m.loops) * 2, np.float32)
        m.uv_layers.active.data.foreach_get('uv', uv)
        self.uv = uv.reshape(-1, 2)
        self.points = world_points(head)
        self.bvh = BVHTree.FromPolygons([Vector(p) for p in self.points], [tuple(t) for t in self.verts])
        self.base, self.mr, _ = maps(head)

    def uv_at(self, hits, tris):
        A, B, C = (self.points[self.verts[tris, i]] for i in range(3))
        v0, v1, v2 = B - A, C - A, hits - A
        d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
        d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
        den = np.maximum(d00 * d11 - d01 * d01, 1e-20)
        bv = (d11 * d20 - d01 * d21) / den
        bw = (d00 * d21 - d01 * d20) / den
        bu = 1 - bv - bw
        return self.uv[self.loops[tris, 0]] * bu[:, None] + self.uv[self.loops[tris, 1]] * bv[:, None] + self.uv[self.loops[tris, 2]] * bw[:, None]


def fill_texels(values, have, want, rounds=FILL_TEXELS):
    """Texels in `want` without a value take the mean of their neighbours that have one, spreading inward (in place);
    returns the texels that have a value. Only the box around `want` is worked on (a 4096 px texture is 268 MB)."""
    rows, cols = np.nonzero(want.any(1))[0], np.nonzero(want.any(0))[0]
    if not len(rows):
        return have
    box = (slice(max(rows[0] - 1, 0), rows[-1] + 2), slice(max(cols[0] - 1, 0), cols[-1] + 2))
    result = have.copy()
    result[box] = _fill(values[box], have[box], want[box], rounds)
    return result


def _fill(values, have, want, rounds):
    have = have.copy()
    for _ in range(rounds):
        todo = want & ~have
        if not todo.any():
            break
        total = np.zeros_like(values)
        count = np.zeros(have.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            total += np.roll(np.roll(values * have[..., None], dy, 0), dx, 1)
            count += np.roll(np.roll(have, dy, 0), dx, 1)
        new = todo & (count > 0)
        values[new] = total[new] / count[new][:, None]
        have |= new
    return have


def texel_weights(body, size, weights):
    """The per-vertex weights baked into the texture's texels."""
    attribute = body.data.color_attributes.new('face_weight', 'FLOAT_COLOR', 'POINT')
    colours = np.repeat(weights[:, None], 4, 1).astype(np.float32)
    colours[:, 3] = 1
    attribute.data.foreach_set('color', colours.ravel())

    def weight_socket(tree):
        n = tree.nodes.new('ShaderNodeVertexColor')
        n.layer_name = 'face_weight'
        return n, n.outputs['Color']

    try:
        return bake_emission(body, size, weight_socket)[..., 0]
    finally:
        body.data.color_attributes.remove(attribute)


def transfer_texture(a, body, head, weights, eye):
    """The head's colours, roughness and metallic into the face region's texels; returns (sampled, filled) counts."""
    base, mr, normal = maps(body)
    size = tuple(base.image.size)

    def position_socket(tree):
        n = tree.nodes.new('ShaderNodeNewGeometry')
        return n, n.outputs['Position']

    texel_weight = texel_weights(body, size, weights)
    position = bake_emission(body, size, position_socket)[..., :3]
    want = texel_weight > 0.001
    cells = np.argwhere(want)
    camera = Vector((0, -distance_of(a.fov), 0))
    hits, tris, ok = [], [], np.zeros(len(cells), bool)
    for k, (y, x) in enumerate(cells):
        p = Vector(position[y, x])
        hit, _, tri, _ = head.bvh.ray_cast(camera, (p - camera).normalized())
        if hit is not None and (hit - p).length <= TEXEL_TOLERANCE * eye:
            ok[k] = True
            hits.append(tuple(hit))
            tris.append(tri)
    if not ok.any():
        return 0, 0
    uv = head.uv_at(np.array(hits), np.array(tris))
    ys, xs = cells[ok, 0], cells[ok, 1]
    have = np.zeros(texel_weight.shape, bool)
    have[ys, xs] = True

    def blend(image, values, tone=False):
        h, w = texel_weight.shape
        full = np.zeros((h, w, 4), np.float32)
        full[ys, xs] = values
        old = pixels_of(image)
        if tone:
            # the head's tone moved to the body's (mean, half the contrast ratio) over the face's core
            core = texel_weight[ys, xs] > 0.9
            if core.sum() > 16:
                mh, sh = values[core, :3].mean(0), values[core, :3].std(0)
                mb, sb = old[ys[core], xs[core], :3].mean(0), old[ys[core], xs[core], :3].std(0)
                full[ys, xs, :3] = np.clip((values[:, :3] - mh) * (sb / np.maximum(sh, 1e-3)) ** 0.5 + mb, 0, 1)
        filled = fill_texels(full, have, want)
        k = (texel_weight * filled)[..., None]
        old[..., :3] = old[..., :3] * (1 - k) + full[..., :3] * k
        image.pixels.foreach_set(old.ravel())
        image.pack()
        return int((filled & ~have).sum())

    filled = blend(base.image, sample(head.base.image, uv), tone=True)
    if mr is not None and head.mr is not None and tuple(mr.image.size) == size:
        blend(mr.image, sample(head.mr.image, uv))
    if normal is not None and tuple(normal.image.size) == size:
        blend(normal.image, np.tile(np.array([[0.5, 0.5, 1.0, 1.0]], np.float32), (len(ys), 1)))
    return int(ok.sum()), filled


def bake_from(source, copy, size, image_of):
    """The source's image (image_of(object) -> its TEX_IMAGE node) baked onto the copy's UVs (selected to active, like
    game_copies.py), its stored values unchanged; alpha 0 where the rays found no source."""
    node = image_of(source)
    space = node.image.colorspace_settings.name
    node.image.colorspace_settings.name = 'Non-Color'
    tree, _, output = material_nodes(source)
    surface = next((l.from_socket for l in tree.links if l.to_node == output and l.to_socket.name == 'Surface'), None)
    emission = tree.nodes.new('ShaderNodeEmission')
    tree.links.new(node.outputs['Color'], emission.inputs['Color'])
    tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])
    copy_tree = copy.active_material.node_tree
    target = copy_tree.nodes.new('ShaderNodeTexImage')
    image = bpy.data.images.new('face_copy_bake', size[0], size[1], float_buffer=True, alpha=True)
    image.colorspace_settings.name = 'Non-Color'
    image.generated_color = (0, 0, 0, 0)
    target.image = image
    for n in copy_tree.nodes:
        n.select = False
    target.select = True
    copy_tree.nodes.active = target
    bake = bpy.context.scene.render.bake
    reach = max(copy.dimensions)
    bake.use_selected_to_active = True
    bake.cage_extrusion = COPY_EXTRUSION * reach
    bake.max_ray_distance = COPY_REACH * reach
    model3d.select([source, copy])
    bpy.context.view_layer.objects.active = copy
    try:
        bpy.ops.object.bake(type='EMIT')
        return pixels_of(image)
    finally:
        bake.use_selected_to_active = False
        if surface is not None:
            tree.links.new(surface, output.inputs['Surface'])
        tree.nodes.remove(emission)
        copy_tree.nodes.remove(target)
        bpy.data.images.remove(image)
        node.image.colorspace_settings.name = space


def copy_face(a, source, copy, eye):
    """A game copy's face from the full model that has the new face: its colours, roughness and metallic baked into
    the copy's texels (the head's own way gave the 30k copy a face of patches, 11.10.2026: its coarse mesh lies too far
    from the head). The mesh stays (moved onto the full model's face, the 15k copy's coarse face came out sheared); its
    normal map is baked from the full model afterwards. The panel makes its copies from the finished model now
    (game_copies.py) and gives this script only model.glb."""
    _, _, r, front = face_region(a, copy, eye)
    weights = colour_weights(r, front)
    base, mr, _ = maps(copy)
    size = tuple(base.image.size)
    texel_weight = texel_weights(copy, size, weights)
    baked = 0
    for image_of in (lambda o: maps(o)[0], lambda o: maps(o)[1]):
        node, source_node = image_of(copy), image_of(source)
        if node is None or source_node is None or tuple(node.image.size) != size:
            continue
        colour = bake_from(source, copy, size, image_of)
        k = (texel_weight * (colour[..., 3] > 0.5))[..., None]
        old = pixels_of(node.image)
        old[..., :3] = old[..., :3] * (1 - k) + colour[..., :3] * k
        node.image.pixels.foreach_set(old.ravel())
        node.image.pack()
        baked = max(baked, int((k[..., 0] > 0.5).sum()))
    return baked


def main():
    a = args()
    a.face, a.head_face = json.loads(a.face), json.loads(a.head_face)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    device = model3d.select_bake_device(scene)
    scene.render.bake.margin = 4
    scene.render.bake.use_selected_to_active = False
    model3d.clear_scene()
    head_objects, head_mesh = load(os.path.abspath(a.head))
    if head_mesh is None or maps(head_mesh)[0] is None:
        raise SystemExit('The head model has no textured mesh')
    for o in head_objects:
        o.hide_render = True
    result = {'device': device, 'models': []}
    # the first model (the full one) takes the head's face; the game copies after it take the full model's
    source = None
    eye = None
    for i, path in enumerate(a.models):
        started = time.time()
        name = os.path.basename(path)
        objects, body = load(os.path.abspath(path))
        if body is None or maps(body)[0] is None or (i and source is None):
            for o in objects:
                bpy.data.objects.remove(o, do_unlink=True)
            reason = 'no colour texture' if body is None or maps(body)[0] is None else 'no full model with the new face'
            result['models'].append({'file': name, 'skipped': reason})
            print(f"Face onto {name}: {reason}", flush=True)
            continue
        if i == 0:
            eye, residual, scale = place_head(a, head_objects, head_mesh, body)
            result['scale'], result['residual'] = round(scale, 4), round(residual, 3)
            print(f'Head placed: scale {scale:.3f}, the face points within {residual * 100:.0f}% of the eye distance', flush=True)
            head = Head(head_mesh)
            weights = move_vertices(a, body, head.bvh, eye)
            sampled, filled = transfer_texture(a, body, head, weights, eye)
            info = {'file': name, 'moved': int((weights > 0).sum()), 'sampled': sampled, 'filled': filled}
        else:
            texels = copy_face(a, source, body, eye)
            info = {'file': name, 'moved': 0, 'sampled': texels, 'filled': 0}
        model3d.select(objects)
        temp = path + '.writing.glb'
        bpy.ops.export_scene.gltf(filepath=temp, export_format='GLB', use_selection=True)
        os.replace(temp, path)
        if i == 0:
            source = body
            for o in head_objects:
                bpy.data.objects.remove(o, do_unlink=True)
        else:
            for o in objects:
                bpy.data.objects.remove(o, do_unlink=True)
        info['seconds'] = round(time.time() - started, 1)
        print(f"Face onto {name}: {info['moved']} vertices moved, {info['sampled']} texels" + (f" (+{info['filled']} filled)" if i == 0 else f' from {os.path.basename(a.models[0])}') + f", {info['seconds']} s", flush=True)
        result['models'].append(info)
    print('RESULT ' + json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
