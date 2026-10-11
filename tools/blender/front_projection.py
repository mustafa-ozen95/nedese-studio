"""
The input picture projected onto the front of a Pixal3D model (Blender, no window):
  blender -b --factory-startup --python-exit-code 1 -P front_projection.py -- --picture input.png --fov 32.5 --models model.glb game.glb

- Pixal3D generates the model pixel aligned with its input (the square crop ComfyUI saves as input.png): a camera on the
  front, its horizontal field of view estimated by MoGe-2. Its colours are decoded from a voxel grid, small details of a
  full-body figure are lost: a woman's eyes came out white, without irises (11.10.2026). The picture is projected back
  onto the surfaces the camera sees and blended into the base colour texture.
- Each texel's position and normal are baked (Cycles, emission), its visibility with a light at the camera (a diffuse
  bake with the normal maps off: cosine x shadow). The weight falls off where the surface turns away from the camera,
  the generated colours stay at the sides and the back.
- The models are written back in place, their other maps unchanged.
- The result is printed on the last line as "RESULT {json}" (models: [{file, size, share, seconds} or {file, skipped}]).
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model3d  # noqa: E402

# The weight by the cosine between the surface and the view: 0 under LOW, full over HIGH. Measured on the woman
# (11.10.2026): 0.35-0.75 left the eye sockets' walls with the generated black rings, 0.1-0.4 covered them and
# kept the face's sides clean in a 3/4 view.
LOW = 0.1
HIGH = 0.4
# A light at the camera with this energy (W): the irradiance is normalised by the fully lit texels, any value works.
ENERGY = 1000.0
# The picture's background (black) is not projected: pixels this dark at the figure's edge, eroded by EDGE pixels.
BACKGROUND = 0.01
EDGE = 2
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def args():
    p = argparse.ArgumentParser(description='The input picture projected onto the front of the model')
    p.add_argument('--picture', required=True, help='the square input picture the model was generated from')
    p.add_argument('--fov', type=float, required=True, help='the horizontal field of view of the picture (degrees)')
    p.add_argument('--models', nargs='+', required=True, help='models (GLB), written back in place')
    return p.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def read_picture(path):
    image = bpy.data.images.load(path)
    width, height = image.size
    if width != height:
        raise SystemExit(f'The picture is not square: {width}x{height}')
    pixels = np.empty(width * height * 4, np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    photo = pixels.reshape(height, width, 4)[..., :3]  # row 0 is the bottom row
    mask = photo.max(-1) > BACKGROUND
    for _ in range(EDGE):
        mask = mask & np.roll(mask, 1, 0) & np.roll(mask, -1, 0) & np.roll(mask, 1, 1) & np.roll(mask, -1, 1)
    return photo, mask


def base_texture(body):
    """The image node feeding the Principled BSDF's Base Color (None: the body has no colour texture)."""
    material = body.active_material
    if material is None or not material.use_nodes:
        return None
    tree = material.node_tree
    bsdf = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        return None
    return next((l.from_node for l in tree.links if l.to_node == bsdf and l.to_socket.name == 'Base Color' and l.from_node.type == 'TEX_IMAGE' and l.from_node.image), None)


def bake_into(body, size, bake):
    """Bakes into a new float image of size x size (the body's material set up by `bake`); returns its pixels."""
    tree = body.active_material.node_tree
    target = tree.nodes.new('ShaderNodeTexImage')
    image = bpy.data.images.new('projection_bake', size[0], size[1], float_buffer=True)
    image.colorspace_settings.name = 'Non-Color'
    target.image = image
    for n in tree.nodes:
        n.select = False
    target.select = True
    tree.nodes.active = target
    model3d.select([body])
    bake()
    tree.nodes.remove(target)
    pixels = np.empty(size[0] * size[1] * 4, np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(size[1], size[0], 4)


def bake_geometry(body, size, socket):
    """The Geometry node's Position or Normal (world space) per texel."""
    tree = body.active_material.node_tree
    outputs = [n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL']
    output = next((n for n in outputs if n.is_active_output), outputs[0])
    surface = next((l.from_socket for l in tree.links if l.to_node == output and l.to_socket.name == 'Surface'), None)
    geometry = tree.nodes.new('ShaderNodeNewGeometry')
    emission = tree.nodes.new('ShaderNodeEmission')
    tree.links.new(geometry.outputs[socket], emission.inputs['Color'])
    tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])
    try:
        return bake_into(body, size, lambda: bpy.ops.object.bake(type='EMIT'))[..., :3]
    finally:
        if surface is not None:
            tree.links.new(surface, output.inputs['Surface'])
        tree.nodes.remove(geometry)
        tree.nodes.remove(emission)


def bake_light(body, size):
    """The direct diffuse light from the camera per texel, the normal maps off (cosine x shadow)."""
    tree = body.active_material.node_tree
    cut = [(l.from_socket, l.to_socket) for l in tree.links if l.to_socket.name == 'Normal']
    for link in [l for l in tree.links if l.to_socket.name == 'Normal']:
        tree.links.remove(link)
    bake = bpy.context.scene.render.bake
    bake.use_pass_direct, bake.use_pass_indirect, bake.use_pass_color = True, False, False
    try:
        return bake_into(body, size, lambda: bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT'}))[..., 0]
    finally:
        for a, b in cut:
            tree.links.new(a, b)


def project(body, node, photo, mask, distance):
    """Blends the projected picture into the body's base colour texture; returns the share of texels it covered."""
    image = node.image
    size = tuple(image.size)
    position = bake_geometry(body, size, 'Position')
    normal = bake_geometry(body, size, 'Normal')
    light = bake_light(body, size)
    covered = np.abs(position).sum(-1) > 0
    camera = np.array([0, -distance, 0], np.float32)
    # Pixal3D's camera (comfy/ldm/trellis2/model.py, _project_points_to_image): Z up, at -Y looking at the origin,
    # the focal length in pixels resolution * distance. The model is imported at the generation's scale (Y up -> Z up).
    r = photo.shape[0]
    depth = np.maximum(position[..., 1] + distance, 1e-6)
    u = r * distance * position[..., 0] / depth + r / 2
    v = r * distance * position[..., 2] / depth + r / 2
    ray = camera - position
    length = np.maximum(np.linalg.norm(ray, axis=-1), 1e-6)
    cosine = np.clip((normal * ray).sum(-1) / length, 0, 1)
    # the shadow term: the irradiance over the unshadowed one (energy / distance², the cosine); 1 on the lit texels
    lit = light * length ** 2 / np.maximum(cosine, 1e-3)
    sample = covered & (cosine > 0.8) & (lit > 0)
    if not sample.any():
        return 0.0
    visible = np.clip(lit / np.median(lit[sample]), 0, 1)
    x0 = np.clip(np.floor(u - 0.5).astype(int), 0, r - 2)
    y0 = np.clip(np.floor(v - 0.5).astype(int), 0, r - 2)
    fx = np.clip(u - 0.5 - x0, 0, 1)[..., None]
    fy = np.clip(v - 0.5 - y0, 0, 1)[..., None]
    colour = (photo[y0, x0] * (1 - fx) * (1 - fy) + photo[y0, x0 + 1] * fx * (1 - fy)
              + photo[y0 + 1, x0] * (1 - fx) * fy + photo[y0 + 1, x0 + 1] * fx * fy)
    inside = mask[y0, x0] & mask[y0, x0 + 1] & mask[y0 + 1, x0] & mask[y0 + 1, x0 + 1]
    inside &= (u >= 0) & (u < r) & (v >= 0) & (v < r)
    weight = np.clip((cosine - LOW) / (HIGH - LOW), 0, 1)
    weight = weight * weight * (3 - 2 * weight) * visible * inside * covered
    weight = weight.astype(np.float32)[..., None]
    old = np.empty(size[0] * size[1] * 4, np.float32)
    image.pixels.foreach_get(old)
    old = old.reshape(size[1], size[0], 4)
    new = old.copy()
    new[..., :3] = old[..., :3] * (1 - weight) + colour * weight
    image.pixels.foreach_set(new.ravel())
    image.pack()
    return float((weight[..., 0] > 0.5).mean())


def process(path, photo, mask, distance):
    started = time.time()
    before = set(bpy.data.objects)
    model3d.import_model(path)
    objects = [o for o in bpy.data.objects if o not in before]
    name = os.path.basename(path)
    bodies = [o for o in objects if o.type == 'MESH' and base_texture(o) is not None]
    if not bodies:
        for o in objects:
            bpy.data.objects.remove(o, do_unlink=True)
        return {'file': name, 'skipped': 'no colour texture'}
    # only the model being projected casts shadows
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.hide_render = o not in objects
    share, size = 0.0, 0
    for body in bodies:
        node = base_texture(body)
        share = max(share, project(body, node, photo, mask, distance))
        size = max(size, node.image.size[0])
    model3d.select(objects)
    temp = path + '.writing.glb'
    bpy.ops.export_scene.gltf(filepath=temp, export_format='GLB', use_selection=True)
    os.replace(temp, path)
    for o in objects:
        bpy.data.objects.remove(o, do_unlink=True)
    return {'file': name, 'size': size, 'share': round(share, 3), 'seconds': round(time.time() - started, 1)}


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    device = model3d.select_bake_device(scene)
    scene.render.bake.margin = 8
    scene.render.bake.use_selected_to_active = False
    model3d.clear_scene()
    photo, mask = read_picture(os.path.abspath(a.picture))
    distance = 0.5 / math.tan(math.radians(a.fov) / 2)
    lamp = bpy.data.objects.new('projection_light', bpy.data.lights.new('projection_light', 'POINT'))
    lamp.data.shadow_soft_size = 0
    lamp.data.energy = ENERGY
    lamp.location = (0, -distance, 0)
    scene.collection.objects.link(lamp)
    result = {'device': device, 'fov': a.fov, 'models': []}
    for path in a.models:
        info = process(os.path.abspath(path), photo, mask, distance)
        print(f"Projected onto {info['file']}: " + (info['skipped'] if 'skipped' in info else f"{info['share'] * 100:.0f}% of {info['size']} px, {info['seconds']} s"), flush=True)
        result['models'].append(info)
    print('RESULT ' + json.dumps(result, ensure_ascii=False))


main()
