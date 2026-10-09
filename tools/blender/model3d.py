"""
3D model showcase and export (Blender, no window):
  blender -b --factory-startup --python-exit-code 1 -P model3d.py -- --input model.glb --output <folder>
      [--name model] [--frames 120] [--size 1024] [--formats fbx,obj,stl] [--ground 0|1] [--print-height 100]

- Imports the GLB; writes FBX (textures embedded), OBJ (OBJ + MTL + PNG textures in one ZIP) and STL.
- STL is for 3D printing: one closed (watertight) body rebuilt from voxels, cut flat at the bottom so it stands on the
  bed, --print-height millimetres tall (slicers read STL numbers as mm). The textured model is left as it is.
- Turntable: frames <output>/frames/0001.png ...; the panel's ffmpeg encodes the video (Blender's video settings change
  from version to version, PNG frames are the same in every version).
- Version independent: operator and engine names are tried at run time (Blender 3.6 - 5.x). The result is printed on
  the last line as "RESULT {json}".
"""
import argparse
import json
import math
import os
import shutil
import sys
import zipfile

import bmesh
import bpy
from mathutils import Matrix, Vector

# Voxels along the print height: 0.25 mm at 100 mm, finer than a 0.4 mm nozzle draws.
PRINT_VOXELS = 400
# The flat base: this much of the height is cut off the bottom (at least 0.4 mm).
PRINT_BASE = 0.008
# A larger body is reduced to this many triangles (a ~15 MB STL; slicers stay fast).
PRINT_TRIANGLES = 300000
# Where the generated parts meet, the surface has slits up to ~2 mm wide at 120 mm that let the outside flood the
# whole figure; the flood runs with the wall this many voxels thicker (from 3 on the inside stays the same).
PRINT_SEAL = 4


def args():
    p = argparse.ArgumentParser(description='3D model showcase and export')
    p.add_argument('--input', required=True, help='GLB file')
    p.add_argument('--output', required=True, help='folder for the exports and the turntable frames')
    p.add_argument('--name', default=None, help='file name of the exports (default: the GLB name)')
    p.add_argument('--frames', type=int, default=120, help='turntable frames (0: none)')
    p.add_argument('--size', type=int, default=1024, help='turntable frame size (px)')
    p.add_argument('--formats', default='fbx,obj,stl', help='exports: fbx, obj, stl')
    p.add_argument('--ground', type=int, default=0, help='1: the turntable has a floor')
    p.add_argument('--print-height', type=float, default=100, help='STL height in mm')
    a = p.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    return a


def has_operator(module, name):
    return name in dir(getattr(bpy.ops, module))


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    # The bounds are wrong until the imported objects' matrix_world is updated.
    bpy.context.view_layer.update()
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def bounds(objects):
    points = [o.matrix_world @ Vector(k) for o in objects for k in o.bound_box]
    low = Vector((min(p[i] for p in points) for i in range(3)))
    high = Vector((max(p[i] for p in points) for i in range(3)))
    return low, high


def triangle_count(objects):
    return sum(len(p.vertices) - 2 for o in objects for p in o.data.polygons)


def write_textures(folder):
    """Writes the GLB's embedded textures as PNG (OBJ/MTL refer to them)."""
    os.makedirs(folder, exist_ok=True)
    written = []
    for i, img in enumerate(bpy.data.images):
        if img.type != 'IMAGE' or not img.has_data and not img.packed_file:
            continue
        name = ''.join(c if c.isalnum() or c in '-_' else '_' for c in (img.name or f'texture{i}')) or f'texture{i}'
        target = os.path.join(folder, f'{name}.png')
        try:
            img.filepath_raw = target
            img.file_format = 'PNG'
            img.save()
            if img.packed_file:
                img.unpack(method='REMOVE')
            img.filepath = target
            written.append(os.path.basename(target))
        except Exception as e:  # an untextured model / an unreadable texture: the OBJ is still written
            print(f'Texture not written ({img.name}): {e}')
    return written


def select(objects):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def write_stl(path):
    if has_operator('wm', 'stl_export'):
        bpy.ops.wm.stl_export(filepath=path, export_selected_objects=True)
    else:
        bpy.ops.export_mesh.stl(filepath=path, use_selection=True)


def export(objects, output, name, formats):
    files = {}
    select(objects)
    # The embedded textures go to disk first: FBX embedding and OBJ/MTL read them from a file path.
    temp = os.path.join(output, f'{name}-obj')
    if formats & {'fbx', 'obj'}:
        os.makedirs(temp, exist_ok=True)
        write_textures(temp)
    if 'fbx' in formats:
        path = os.path.join(output, f'{name}.fbx')
        bpy.ops.export_scene.fbx(filepath=path, use_selection=True, path_mode='COPY', embed_textures=True, bake_anim=False)
        files['fbx'] = os.path.basename(path)
    if 'obj' in formats:
        # OBJ textures are separate files: OBJ + MTL + PNGs in the temporary folder, then one ZIP.
        path = os.path.join(temp, f'{name}.obj')
        if has_operator('wm', 'obj_export'):
            bpy.ops.wm.obj_export(filepath=path, export_selected_objects=True, export_materials=True, path_mode='RELATIVE')
        else:
            bpy.ops.export_scene.obj(filepath=path, use_selection=True, use_materials=True, path_mode='RELATIVE')
        zip_path = os.path.join(output, f'{name}-obj.zip')
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
            for d in sorted(os.listdir(temp)):
                z.write(os.path.join(temp, d), d)
        files['obj'] = os.path.basename(zip_path)
    return files, temp


def mesh_box(bm):
    low = Vector((min(v.co[i] for v in bm.verts) for i in range(3)))
    high = Vector((max(v.co[i] for v in bm.verts) for i in range(3)))
    return low, high


def apply_modifier(body, kind, **settings):
    """Applies one modifier through the evaluated mesh (no operator context needed in background mode)."""
    m = body.modifiers.new(kind.lower(), kind)
    for k, v in settings.items():
        setattr(m, k, v)
    bpy.context.view_layer.update()
    mesh = bpy.data.meshes.new_from_object(body.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    body.modifiers.remove(m)
    old = body.data
    body.data = mesh
    bpy.data.meshes.remove(old)


def grow(mask):
    """The voxels of the mask and their six neighbours."""
    import numpy as np
    grown = mask.copy()
    for axis in range(3):
        grown |= np.roll(mask, 1, axis) | np.roll(mask, -1, axis)
    return grown


def flood_outside(free):
    """The voxels reachable from the border of the box through free voxels (6-connected).

    Each pass sweeps the six directions; along a line a free run takes the outside from any voxel of it before, so a
    few passes reach every corner of a figure.
    """
    import numpy as np
    outside = np.zeros_like(free)
    for axis in range(3):
        for end in (0, -1):
            index = [slice(None)] * 3
            index[axis] = end
            outside[tuple(index)] = free[tuple(index)]
    while True:
        before = int(outside.sum())
        for axis in range(3):
            for flip in (False, True):
                o = np.flip(outside, axis) if flip else outside
                f = np.flip(free, axis) if flip else free
                count = np.cumsum(o, axis=axis, dtype=np.int32)
                wall = np.maximum.accumulate(np.where(f, 0, count), axis=axis)
                o |= (count > wall) & f
        if int(outside.sum()) == before:
            return outside


def solid_mesh(bm, voxel):
    """The model filled solid, as a new mesh: everything the outside cannot reach is inside.

    Generated models are thin double-walled shells (the surface comes out twice, 0.3 mm apart at 100 mm), which a
    remesh or a slicer reads as a hollow figure. The distance to the surface is split into outside (flooded from the
    border of the box past a wall made PRINT_SEAL voxels thicker, so no slit leaks, then grown back to the surface)
    and inside; the surface of the solid then lies exactly on the outer wall.
    """
    import numpy as np
    import openvdb as vdb
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.verts.index_update()
    points = np.array([v.co[:] for v in bm.verts], dtype=np.float32)
    triangles = np.array([[v.index for v in f.verts] for f in bm.faces], dtype=np.uint32)
    transform = vdb.createLinearTransform(voxel)
    shell = vdb.FloatGrid.createLevelSetFromPolygons(points, triangles=triangles, transform=transform, halfWidth=3.0)
    (i0, j0, k0), (i1, j1, k1) = shell.evalActiveVoxelBoundingBox()
    # room around the surface for the thicker wall, so the flood still goes round it
    pad = PRINT_SEAL + 2
    start = (i0 - pad, j0 - pad, k0 - pad)
    signed = np.zeros((i1 - i0 + 1 + 2 * pad, j1 - j0 + 1 + 2 * pad, k1 - k0 + 1 + 2 * pad), dtype=np.float32)
    shell.copyToArray(signed, ijk=start)
    distance = np.abs(signed)
    near = distance < voxel * 0.75
    wall = near
    for _ in range(PRINT_SEAL):
        wall = grow(wall)
    outside = flood_outside(~wall)
    # back to the surface through the free voxels: into a slit only this far
    for _ in range(PRINT_SEAL + 2):
        outside |= grow(outside) & ~near
    # The near voxels on the outer side of the wall join the outside (the shell's own sign says which side).
    for _ in range(2):
        outside |= grow(outside) & near & (signed > 0)
    field = np.where(outside, distance, -distance).astype(np.float32)
    grid = vdb.FloatGrid(float(voxel * 3))
    grid.transform = transform
    grid.copyFromArray(field, ijk=start)
    points, triangles, quads = grid.convertToPolygons(isovalue=0.0, adaptivity=0.0)
    mesh = bpy.data.meshes.new('solid')
    mesh.from_pydata(points.tolist(), [], triangles.tolist() + quads.tolist())
    return mesh


def drop_crumbs(bm, share=0.01):
    """Removes the loose parts smaller than this share of the largest (they would print as crumbs on the bed)."""
    bm.faces.ensure_lookup_table()
    seen = set()
    parts = []
    for f in bm.faces:
        if f.index in seen:
            continue
        seen.add(f.index)
        part = [f]
        stack = [f]
        while stack:
            for e in stack.pop().edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        part.append(g)
                        stack.append(g)
        parts.append(part)
    largest = max((len(p) for p in parts), default=0)
    crumbs = [p for p in parts if len(p) < largest * share]
    if crumbs:
        bmesh.ops.delete(bm, geom=[f for p in crumbs for f in p], context='FACES')
    return len(crumbs)


def print_body(objects, output, name, height):
    """The STL for a 3D printer: a solid copy of the model standing on a flat cut, `height` mm tall.

    Generated meshes are open, double-walled and their parts overlap, which slicers refuse or read as hollow, so the
    copy is rebuilt as one watertight solid, the bottom is cut flat and closed, and the numbers are millimetres.
    """
    bm = bmesh.new()
    for o in objects:
        mesh = o.data.copy()
        mesh.transform(o.matrix_world)
        bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)
    # A GLB splits its vertices at every texture seam; joined again, only small holes are left to close.
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)
    low, high = mesh_box(bm)
    scale = height / max(high.z - low.z, 1e-9)
    centre = Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))
    bmesh.ops.transform(bm, matrix=Matrix.Scale(scale, 4) @ Matrix.Translation(-centre), verts=bm.verts)
    voxel = height / PRINT_VOXELS
    try:
        mesh = solid_mesh(bm, voxel)
        filled = True
    except ImportError:
        # Blender without its OpenVDB module (older versions): a voxel remesh, closed but possibly hollow inside.
        mesh = bpy.data.meshes.new('solid')
        bm.to_mesh(mesh)
        filled = False
    bm.free()
    body = bpy.data.objects.new(f'{name}-print', mesh)
    bpy.context.scene.collection.objects.link(body)
    if not filled:
        apply_modifier(body, 'REMESH', mode='VOXEL', voxel_size=voxel, adaptivity=0)

    # Flat base: cut the bottom off, close the cut with a face, stand it on z = 0 and stretch back to the height.
    cut = max(height * PRINT_BASE, 0.4)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, cut), plane_no=(0, 0, 1), clear_inner=True)
    rim = [e for e in bm.edges if e.is_boundary]
    if rim:
        bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=rim, normal=(0, 0, -1))
    crumbs = drop_crumbs(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    low, high = mesh_box(bm)
    bmesh.ops.transform(bm, matrix=Matrix.Scale(height / max(high.z - low.z, 1e-9), 4) @ Matrix.Translation(Vector((0, 0, -low.z))), verts=bm.verts)
    bm.to_mesh(body.data)
    bm.free()

    triangles = sum(len(p.vertices) - 2 for p in body.data.polygons)
    if triangles > PRINT_TRIANGLES:
        apply_modifier(body, 'DECIMATE', decimate_type='COLLAPSE', ratio=PRINT_TRIANGLES / triangles, use_collapse_triangulate=True)

    bm = bmesh.new()
    bm.from_mesh(body.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    open_edges = sum(1 for e in bm.edges if not e.is_manifold)
    volume = bm.calc_volume(signed=False) / 1000
    low, high = mesh_box(bm)
    bm.to_mesh(body.data)
    bm.free()

    select([body])
    path = os.path.join(output, f'{name}.stl')
    write_stl(path)
    result = {
        'file': os.path.basename(path),
        'height': round(height, 2),
        'size': [round(v, 1) for v in (high - low)],
        'triangles': len(body.data.polygons),
        'openEdges': open_edges,
        'watertight': open_edges == 0,
        'solid': filled,
        'crumbs': crumbs,
        'volume': round(volume, 2),
    }
    mesh = body.data
    bpy.data.objects.remove(body, do_unlink=True)
    bpy.data.meshes.remove(mesh)
    return result


def select_engine(scene):
    # EEVEE's identifier depends on the version (BLENDER_EEVEE_NEXT 4.2-4.x, BLENDER_EEVEE 5.x / 4.1-).
    for name in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
        try:
            scene.render.engine = name
            return name
        except TypeError:
            continue
    return scene.render.engine


def setup_turntable(objects, frames, size, ground):
    scene = bpy.context.scene
    low, high = bounds(objects)
    center = (low + high) / 2
    measure = max((high - low).length, 1e-6)

    # Turning axis: an empty under the model; the model is parented to it, the camera stays still.
    axis = bpy.data.objects.new('turn', None)
    scene.collection.objects.link(axis)
    axis.location = (center.x, center.y, low.z)
    # The axis's matrix_world must be updated before parenting, or the model shifts by the axis position.
    bpy.context.view_layer.update()
    for o in objects:
        if o.parent is None or o.parent not in objects:
            world = o.matrix_world.copy()
            o.parent = axis
            o.matrix_world = world
    for o in scene.objects:
        if o.type == 'EMPTY' and o is not axis and o.parent is None:
            world = o.matrix_world.copy()
            o.parent = axis
            o.matrix_world = world

    height = high.z - low.z
    target = Vector((center.x, center.y, low.z + height * 0.5))
    target_object = bpy.data.objects.new('target', None)
    scene.collection.objects.link(target_object)
    target_object.location = target

    camera_data = bpy.data.cameras.new('camera')
    camera_data.lens = 50
    camera = bpy.data.objects.new('camera', camera_data)
    scene.collection.objects.link(camera)
    # Framing: the widest horizontal size while turning (the base diagonal) or the height; 15 % margin.
    # 50 mm lens / 36 mm sensor: tan(half angle) = 0.36.
    framing = max(height, math.hypot(high.x - low.x, high.y - low.y))
    distance = framing * 1.15 / 2 / 0.36
    angle = math.radians(18)
    camera.location = target + Vector((0, -distance * math.cos(angle), distance * math.sin(angle)))
    track = camera.constraints.new('TRACK_TO')
    track.target = target_object
    track.track_axis = 'TRACK_NEGATIVE_Z'
    track.up_axis = 'UP_Y'
    camera_data.clip_start = measure * 0.01
    camera_data.clip_end = measure * 100
    scene.camera = camera

    def light(name, type, energy, position, size=None):
        v = bpy.data.lights.new(name, type)
        v.energy = energy
        if size is not None:
            v.size = size
        n = bpy.data.objects.new(name, v)
        scene.collection.objects.link(n)
        n.location = target + Vector(position) * measure
        c = n.constraints.new('TRACK_TO')
        c.target = target_object
        c.track_axis = 'TRACK_NEGATIVE_Z'
        c.up_axis = 'UP_Y'

    # Three-point lighting (area lights sized by the model; energy grows with the square of its size).
    light('key', 'AREA', 120 * measure * measure, (-1.2, -1.4, 1.6), measure * 1.2)
    light('fill', 'AREA', 40 * measure * measure, (1.6, -1.0, 0.6), measure * 1.5)
    light('back', 'AREA', 80 * measure * measure, (0.4, 1.8, 1.4), measure)

    world = scene.world or bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    background = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
    if background is not None:
        # A dark neutral backdrop (product shot), also a little ambient light.
        background.inputs[0].default_value = (0.045, 0.048, 0.055, 1)
        background.inputs[1].default_value = 1.0

    if ground:
        bpy.ops.mesh.primitive_plane_add(size=measure * 20, location=(center.x, center.y, low.z))
        floor = bpy.context.active_object
        mat = bpy.data.materials.new('floor')
        mat.use_nodes = True
        bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is not None:
            bsdf.inputs['Base Color'].default_value = (0.2, 0.21, 0.23, 1)
            bsdf.inputs['Roughness'].default_value = 0.85
        floor.data.materials.append(mat)

    # One full turn at a constant speed: the last frame is 360 - step so the first and last frames do not repeat.
    scene.frame_start = 1
    scene.frame_end = frames
    axis.rotation_euler = (0, 0, 0)
    axis.keyframe_insert('rotation_euler', index=2, frame=1)
    axis.rotation_euler = (0, 0, math.radians(360 * (frames - 1) / frames))
    axis.keyframe_insert('rotation_euler', index=2, frame=frames)
    make_linear(axis)

    engine = select_engine(scene)
    try:
        scene.eevee.taa_render_samples = 32
    except AttributeError:
        pass
    if engine == 'CYCLES':
        scene.cycles.samples = 32
    r = scene.render
    r.resolution_x = size
    r.resolution_y = size
    r.resolution_percentage = 100
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGB'
    # Standard: textures in their own colours (AgX / Filmic lower the saturation clearly, the model looked pale).
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    return engine


def make_linear(object):
    """Linear keyframe interpolation (constant turning speed); also covers the layered actions of Blender 4.4+."""
    action = object.animation_data.action if object.animation_data else None
    if action is None:
        return
    curves = list(getattr(action, 'fcurves', []) or [])
    if not curves:
        for layer in getattr(action, 'layers', []):
            for strip in layer.strips:
                for channel in getattr(strip, 'channelbags', []):
                    curves.extend(channel.fcurves)
    for c in curves:
        for k in c.keyframe_points:
            k.interpolation = 'LINEAR'


def main():
    a = args()
    output = os.path.abspath(a.output)
    os.makedirs(output, exist_ok=True)
    name = a.name or os.path.splitext(os.path.basename(a.input))[0]
    frames = max(0, a.frames)
    formats = {b.strip().lower() for b in a.formats.split(',') if b.strip()}

    clear_scene()
    objects = import_glb(os.path.abspath(a.input))
    if not objects:
        raise SystemExit('No mesh in the GLB')
    low, high = bounds(objects)
    result = {
        'blender': bpy.app.version_string,
        'objects': len(objects),
        'triangles': triangle_count(objects),
        'size': [round(v, 4) for v in (high - low)],
    }
    result['files'], temp = export(objects, output, name, formats)
    if 'stl' in formats:
        result['print'] = print_body(objects, output, name, a.print_height)
        result['files']['stl'] = result['print']['file']

    if frames > 0:
        result['engine'] = setup_turntable(objects, frames, a.size, a.ground != 0)
        folder = os.path.join(output, 'frames')
        os.makedirs(folder, exist_ok=True)
        bpy.context.scene.render.filepath = os.path.join(folder, '')
        bpy.ops.render.render(animation=True)
        result['frames'] = folder
    shutil.rmtree(temp, ignore_errors=True)
    print('RESULT ' + json.dumps(result, ensure_ascii=False))


main()
