"""
Game copies (Blender, no window): low-poly copies of the full model for game engines, each with its own textures.
  blender -b --factory-startup --python-exit-code 1 -P game_copies.py -- --full model.glb --copies game.glb:30000:2048 game-lod1.glb:15000:1024

- The shape: generated models are thin double-walled shells (an outer sheet and an inner one close behind it) and hair
  or fur is a mass of open curls. Decimated as it is, the two sheets cross each other (a curly-haired woman's copy had
  shards of the inner sheet all over her face) and the curls take the triangles (three quarters of a 30k copy went to
  the hair, the face had a few dozen). So the shell is thickened, remeshed into one closed solid on a voxel grid (the
  curls melt into a lumpy mass) and that is decimated to each copy's triangles.
- The look: the copy gets its own UVs, and its colour, metallic/roughness/occlusion and normal maps are baked from the
  full model (selected to active), so its face is the full model's (projected picture, transferred face) and the curls
  are back in the normal map. Cycles bakes the normal map for the MikkTSpace tangents game engines compute; the copy is
  written with its tangents.
- Cycles on the GPU when there is one, the CPU otherwise; one sample is enough for these bakes.
- The result is printed on the last line as "RESULT {json}" (copies: [{file, triangles, size, face, seconds}]; face:
  the polygons that got the face's texels with --focus).
"""
import argparse
import json
import math
import os
import sys
import tempfile
import time

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model3d  # noqa: E402

# The voxel, a share of the model's largest dimension: 1/440 kept a woman's nose, lips and brows (1/300 holed the thin
# face, a coarser grid smooths it away). The shell is thickened by THICKNESS voxels first so its thin walls (the face)
# close into a solid.
VOXELS = 440
THICKNESS = 3
# The cage and the ray reach of the bakes, a share of the copy's largest dimension (the normal-map bake's of 11.10.2026:
# a furry dwarf's copy lay under the fur, 0.005 started rays inside it)
EXTRUSION = 0.02
REACH = 0.05
# UV islands this many pixels apart (the concave packing filled 41-45% of a 30k copy's texture, the default 35%, the
# old copies 29%), the bake margin in pixels
PACK_MARGIN = 4
BAKE_MARGIN = 8
# The share of the texture the islands cover at least, or they are packed again with smaller margins (a woman's 30k copy
# covered 41%, a ball's 37%; a lumpy copy's thousands of islands next to nothing)
MIN_COVER = 0.2
# The face in the picture (YuNet's box, grown this much) gets this many times the texels per length of the rest: a
# woman's 30k copy had a blurry face (eyes ~20 texels wide) at an even density
FOCUS_BOX = 1.6
FOCUS_SCALE = 2


def args():
    p = argparse.ArgumentParser(description='Low-poly game copies baked from the full model')
    p.add_argument('--full', required=True, help='the full model (GLB)')
    p.add_argument('--copies', nargs='+', required=True, help='file:triangles:texture size for each copy (GLB)')
    p.add_argument('--focus', help='JSON {fov, face: YuNet box in the picture, size: its width}: the face gets more texels')
    return p.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def solid_shape(full):
    """The full model's meshes as one closed, voxel-remeshed solid (a new object)."""
    bm = bmesh.new()
    for o in full:
        mesh = o.data.copy()
        mesh.transform(o.matrix_world)
        bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)
    # a GLB splits its vertices at every texture seam: joined again, the shell thickens as one surface
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    low, high = model3d.mesh_box(bm)
    voxel = max(high - low) / VOXELS
    mesh = bpy.data.meshes.new('solid')
    bm.to_mesh(mesh)
    bm.free()
    body = bpy.data.objects.new('solid', mesh)
    bpy.context.scene.collection.objects.link(body)
    model3d.apply_modifier(body, 'SOLIDIFY', thickness=voxel * THICKNESS, offset=0)
    model3d.apply_modifier(body, 'REMESH', mode='VOXEL', voxel_size=voxel, adaptivity=0)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    model3d.drop_crumbs(bm)
    bm.to_mesh(body.data)
    bm.free()
    return body


def focus_faces(body, focus):
    """The polygons of the face in the picture: their centres seen by Pixal3D's camera inside the face box (grown by
    FOCUS_BOX) and turned towards it."""
    import numpy as np
    mesh = body.data
    count = len(mesh.polygons)
    centres = np.empty(count * 3, np.float32)
    mesh.polygons.foreach_get('center', centres)
    normals = np.empty(count * 3, np.float32)
    mesh.polygons.foreach_get('normal', normals)
    centres, normals = centres.reshape(-1, 3), normals.reshape(-1, 3)
    d = 0.5 / math.tan(math.radians(focus['fov']) / 2)
    size = focus['size']
    x, y, w, h = focus['face'][:4]
    cx, cy, r = x + w / 2, y + h / 2, max(w, h) / 2 * FOCUS_BOX
    scale = d / np.maximum(d + centres[:, 1], 1e-6)
    u = size / 2 + size * centres[:, 0] * scale
    v = size / 2 - size * centres[:, 2] * scale
    towards = (normals * (centres - np.array([0, -d, 0], np.float32))).sum(1) < 0
    return (np.abs(u - cx) < r) & (np.abs(v - cy) < r) & towards


def unwrap(body, size, focus):
    """Fresh UVs: Smart UV Project, the islands evened to one texel density (the face's FOCUS_SCALE times denser),
    packed tight."""
    import numpy as np
    mesh = body.data
    mesh.uv_layers.new(name='UVMap')
    chosen = focus_faces(body, focus) if focus else np.zeros(len(mesh.polygons), bool)
    model3d.select([body])
    for part in ([chosen, ~chosen] if chosen.any() else [None]):
        bpy.ops.object.mode_set(mode='OBJECT')
        if part is not None:
            mesh.polygons.foreach_set('select', part)
        bpy.ops.object.mode_set(mode='EDIT')
        if part is None:
            bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode='OBJECT')
    if chosen.any():
        total = np.empty(len(mesh.polygons), np.int32)
        mesh.polygons.foreach_get('loop_total', total)
        index = np.repeat(np.arange(len(mesh.polygons)), total)
        uv = np.empty(len(mesh.loops) * 2, np.float32)
        mesh.uv_layers.active.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        uv[chosen[index]] *= FOCUS_SCALE
        mesh.uv_layers.active.data.foreach_set('uv', uv.ravel())
    # Many small islands (a lumpy mass of fur or curls) in a small texture: their margins alone outgrow the square and
    # the packer shrinks the islands to dots or lays them out past 1 (a lumpy 4k copy in 128 or 256 px: its bake hit
    # nothing and came out black). Packed again from the unpacked islands (a shrunk island stays a dot) with smaller
    # margins until they cover the texture, the layout scaled into the square at last.
    mesh.calc_loop_triangles()
    corners = np.empty(len(mesh.loop_triangles) * 3, np.int32)
    mesh.loop_triangles.foreach_get('loops', corners)
    corners = corners.reshape(-1, 3)
    unpacked = np.empty(len(mesh.loops) * 2, np.float32)
    mesh.uv_layers.active.data.foreach_get('uv', unpacked)
    for margin in (PACK_MARGIN / size, PACK_MARGIN / size / 4, 0):
        mesh.uv_layers.active.data.foreach_set('uv', unpacked)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.pack_islands(rotate=True, margin=margin, margin_method='FRACTION', shape_method='CONCAVE')
        bpy.ops.object.mode_set(mode='OBJECT')
        uv = np.empty(len(mesh.loops) * 2, np.float64)
        mesh.uv_layers.active.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        low, high = min(float(uv.min()), 0.0), max(float(uv.max()), 1.0)
        a, b, c = uv[corners[:, 0]], uv[corners[:, 1]], uv[corners[:, 2]]
        cover = float(np.abs(np.cross(b - a, c - a)).sum() / 2) / (high - low) ** 2
        if cover >= MIN_COVER:
            break
    if low < 0 or high > 1:
        mesh.uv_layers.active.data.foreach_set('uv', ((uv - low) / (high - low)).astype(np.float32).ravel())
    return int(chosen.sum())


def decimated(shape, triangles, name):
    """A copy of the solid decimated to about this many triangles, smooth shaded."""
    body = bpy.data.objects.new(name, shape.data.copy())
    bpy.context.scene.collection.objects.link(body)
    count = model3d.triangle_count([body])
    if count > triangles:
        model3d.apply_modifier(body, 'DECIMATE', decimate_type='COLLAPSE', ratio=triangles / count, use_collapse_triangulate=True)
    body.data.shade_smooth()
    return body


def material_nodes(material):
    tree = material.node_tree
    bsdf = next(n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED')
    outputs = [n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL']
    return tree, bsdf, next((n for n in outputs if n.is_active_output), outputs[0])


def linked_image(tree, node, socket):
    """The image node feeding a socket (through Separate Color and the like), None without one."""
    link = next((l for l in tree.links if l.to_node == node and l.to_socket.name == socket), None)
    n = link and link.from_node
    while n is not None and n.type != 'TEX_IMAGE':
        inputs = [l for l in tree.links if l.to_node == n]
        n = inputs[0].from_node if inputs else None
    return n if n is not None and n.image else None


def role_image(material, role):
    """The image node of a role: 'base' (colour), 'orm' (occlusion/roughness/metallic), 'normal'."""
    if material is None or material.node_tree is None or not any(n.type == 'BSDF_PRINCIPLED' for n in material.node_tree.nodes):
        return None
    tree, bsdf, _ = material_nodes(material)
    if role == 'base':
        return linked_image(tree, bsdf, 'Base Color')
    if role == 'orm':
        return linked_image(tree, bsdf, 'Roughness') or linked_image(tree, bsdf, 'Metallic')
    normal = next((n for n in tree.nodes if n.type == 'NORMAL_MAP'), None)
    return normal and linked_image(tree, normal, 'Color')


def bake(full, copy, target, role):
    """One map of the full model baked onto the copy's UVs into `target` (an image node of the copy's material):
    the normal map as Cycles' NORMAL, the other maps' stored values through emission."""
    rewired = []
    if role != 'normal':
        for o in full:
            for slot in o.material_slots:
                node = role_image(slot.material, role)
                if node is None:
                    continue
                tree, _, output = material_nodes(slot.material)
                surface = next((l.from_socket for l in tree.links if l.to_node == output and l.to_socket.name == 'Surface'), None)
                emission = tree.nodes.new('ShaderNodeEmission')
                tree.links.new(node.outputs['Color'], emission.inputs['Color'])
                tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])
                space = node.image.colorspace_settings.name
                node.image.colorspace_settings.name = 'Non-Color'
                rewired.append((tree, output, surface, emission, node.image, space))
    tree = copy.active_material.node_tree
    for n in tree.nodes:
        n.select = False
    target.select = True
    tree.nodes.active = target
    scene = bpy.context.scene
    settings = scene.render.bake
    reach = max(copy.dimensions)
    settings.use_selected_to_active = True
    settings.cage_extrusion = EXTRUSION * reach
    settings.max_ray_distance = REACH * reach
    settings.margin = BAKE_MARGIN
    model3d.select(full + [copy])
    bpy.context.view_layer.objects.active = copy
    try:
        bpy.ops.object.bake(type='NORMAL' if role == 'normal' else 'EMIT')
    finally:
        for tree, output, surface, emission, image, space in rewired:
            if surface is not None:
                tree.links.new(surface, output.inputs['Surface'])
            tree.nodes.remove(emission)
            image.colorspace_settings.name = space


def make_copy(full, shape, path, triangles, size, focus, folder):
    started = time.time()
    name = os.path.splitext(os.path.basename(path))[0]
    copy = decimated(shape, triangles, name)
    focused = unwrap(copy, size, focus)
    # the full model's material with images of its own: the glTF export reads it the same way (occlusion included)
    source = next((s.material for o in full for s in o.material_slots if s.material is not None), None)
    material = source.copy() if source is not None else bpy.data.materials.new(name)
    copy.data.materials.append(material)
    if source is not None and material.node_tree is not None:
        images = {}
        for role in ('base', 'orm', 'normal'):
            node = role_image(material, role)
            if node is None or node.image in images:
                continue
            old = node.image
            image = bpy.data.images.new(f'{name}_{role}', size, size)
            # the bake writes the stored values: no colour transform until it is done
            image.colorspace_settings.name = 'Non-Color'
            images[old] = image
            for n in material.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image == old:
                    n.image = image
            bake(full, copy, node, role)
            # Saved as baked, then read back as a file in the map's colour space (a generated image whose colour
            # space changes is generated again: every map came out black).
            image.filepath_raw = os.path.join(folder, f'{image.name}.png')
            image.file_format = 'PNG'
            image.save()
            image.source = 'FILE'
            image.colorspace_settings.name = old.colorspace_settings.name
            image.reload()
            image.pack()
    model3d.select([copy])
    temp = path + '.writing.glb'
    bpy.ops.export_scene.gltf(filepath=temp, export_format='GLB', use_selection=True, export_tangents=True)
    os.replace(temp, path)
    info = {'file': os.path.basename(path), 'triangles': model3d.triangle_count([copy]), 'size': size, 'face': focused, 'seconds': round(time.time() - started, 1)}
    bpy.data.objects.remove(copy, do_unlink=True)
    return info


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    device = model3d.select_bake_device(scene)
    scene.cycles.samples = 1
    model3d.clear_scene()
    full = model3d.import_model(os.path.abspath(a.full))
    if not full:
        raise SystemExit(f'No mesh in {a.full}')
    started = time.time()
    shape = solid_shape(full)
    print(f'Solid shape: {model3d.triangle_count([shape])} triangles, {time.time() - started:.1f} s', flush=True)
    focus = json.loads(a.focus) if a.focus else None
    result = {'device': device, 'copies': []}
    with tempfile.TemporaryDirectory() as folder:
        for spec in a.copies:
            path, triangles, size = spec.rsplit(':', 2)
            info = make_copy(full, shape, os.path.abspath(path), int(triangles), int(size), focus, folder)
            print(f"Game copy {info['file']}: {info['triangles']} triangles ({info['face']} on the face), {info['size']} px, {info['seconds']} s", flush=True)
            result['copies'].append(info)
    print('RESULT ' + json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
