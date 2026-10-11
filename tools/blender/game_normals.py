"""
Game copy normal maps (Blender, no window): each copy's normal map is baked again from the full model.
  blender -b --factory-startup --python-exit-code 1 -P game_normals.py -- --full model.glb --copies game.glb game-lod1.glb

- A tangent-space normal map only reads right with the tangents it was baked for. The map ComfyUI bakes does not match
  the MikkTSpace tangents game engines (and Blender) compute for the copy: faces come out patchy, seams along the UV
  islands. Cycles bakes with MikkTSpace; the copy is written back in place with its tangents.
- The copy keeps its mesh, UVs and other maps (colour, metal/roughness, occlusion); the new map has the old one's size.
- Cycles on the GPU when there is one (OptiX, CUDA, HIP, oneAPI, Metal), the CPU otherwise; one sample is enough for a
  normal bake.
- The result is printed on the last line as "RESULT {json}" (copies: [{file, size, seconds} or {file, skipped}]).
"""
import argparse
import json
import os
import sys
import time

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model3d  # noqa: E402

# The cage and the ray reach, a share of the copy's largest dimension. Measured: 0.005 was enough for a woman's copy
# (close to the full surface) but a furry dwarf's copy lies under the fur, its rays started inside it and hit the
# inner side (black blotches); 0.02 cleared the dwarf and looked the same on the woman (face, fingers, hair).
EXTRUSION = 0.02
REACH = 0.05


def args():
    p = argparse.ArgumentParser(description='Game copy normal maps baked from the full model')
    p.add_argument('--full', required=True, help='the full model (GLB)')
    p.add_argument('--copies', nargs='+', required=True, help='game copies (GLB), written back in place')
    return p.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def select_device(scene):
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 1
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA', 'HIP', 'ONEAPI', 'METAL'):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        devices = [d for d in prefs.devices if d.type == kind]
        if devices:
            for d in prefs.devices:
                d.use = d.type == kind
            scene.cycles.device = 'GPU'
            return kind
    scene.cycles.device = 'CPU'
    return 'CPU'


def normal_texture(body):
    """The image node feeding the copy's normal map node (None: the copy has no normal map)."""
    material = body.active_material
    if material is None or not material.use_nodes:
        return None
    tree = material.node_tree
    node = next((n for n in tree.nodes if n.type == 'NORMAL_MAP'), None)
    if node is None:
        return None
    return next((link.from_node for link in tree.links if link.to_node == node and link.to_socket.name == 'Color' and link.from_node.type == 'TEX_IMAGE'), None)


def rebake(full, path):
    started = time.time()
    before = set(bpy.data.objects)
    bodies = model3d.import_model(path)
    bodies = [o for o in bodies if o not in full]
    copy = [o for o in bpy.data.objects if o not in before]
    name = os.path.basename(path)
    bodies = [b for b in bodies if normal_texture(b) is not None]
    if not bodies:
        for o in copy:
            bpy.data.objects.remove(o, do_unlink=True)
        return {'file': name, 'skipped': 'no normal map'}
    scene = bpy.context.scene
    bake = scene.render.bake
    bake.use_selected_to_active = True
    bake.margin = 8
    size = 0
    for body in bodies:
        node = normal_texture(body)
        old = node.image
        image = bpy.data.images.new(f'{body.name}_normal', old.size[0], old.size[1])
        image.colorspace_settings.name = 'Non-Color'
        node.image = image
        tree = body.active_material.node_tree
        for n in tree.nodes:
            n.select = False
        node.select = True
        tree.nodes.active = node
        reach = max(body.dimensions)
        bake.cage_extrusion = EXTRUSION * reach
        bake.max_ray_distance = REACH * reach
        model3d.select(full + [body])
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.bake(type='NORMAL')
        image.pack()
        size = max(size, old.size[0])
    model3d.select(copy)
    temp = path + '.writing.glb'
    bpy.ops.export_scene.gltf(filepath=temp, export_format='GLB', use_selection=True, export_tangents=True)
    os.replace(temp, path)
    for o in copy:
        bpy.data.objects.remove(o, do_unlink=True)
    return {'file': name, 'size': size, 'seconds': round(time.time() - started, 1)}


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    device = select_device(bpy.context.scene)
    model3d.clear_scene()
    full = model3d.import_model(os.path.abspath(a.full))
    if not full:
        raise SystemExit(f'No mesh in {a.full}')
    result = {'device': device, 'copies': []}
    for path in a.copies:
        info = rebake(full, os.path.abspath(path))
        print(f"Normal map {info['file']}: " + (info['skipped'] if 'skipped' in info else f"{info['size']} px, {info['seconds']} s"), flush=True)
        result['copies'].append(info)
    print('RESULT ' + json.dumps(result, ensure_ascii=False))


main()
