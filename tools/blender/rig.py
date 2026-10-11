"""
Character skeleton in Blender (no window): the bones and skin weights tools\\rig\\infer.py found are put into the models.
  blender -b --factory-startup --python-exit-code 1 -P rig.py -- --npz rig.npz --models model.glb game.glb ...
      [--show game.glb --output <folder> --frames 96 --size 720]

- Each model (GLB) gets the armature (52 Mixamo bones, "mixamorig:Hips" ...) and its vertices the weights of the
  nearest analysed vertex (the copies of a model share one analysis: the game copies are decimated from the same mesh);
  the model is written back in place, rigged, in its own pose (the rest pose); a skeleton it had is replaced.
- --show: that model moves through a short test motion (head turn, arm raise, steps), frames in <output>/frames/.
- The result is printed on the last line as "RESULT {json}" (bones, models: [{file, vertices, weighted}], frames).
"""
import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector, kdtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model3d  # noqa: E402

P = 'mixamorig:'


def args():
    p = argparse.ArgumentParser(description='Character skeleton into the models')
    p.add_argument('--npz', required=True, help='tools\\rig\\infer.py result')
    p.add_argument('--models', nargs='+', required=True, help='GLB files, rigged in place')
    p.add_argument('--show', default=None, help='one of the models: rendered in a test motion')
    p.add_argument('--output', default=None, help='folder of the test motion frames')
    p.add_argument('--frames', type=int, default=96, help='test motion frames')
    p.add_argument('--size', type=int, default=720, help='test motion frame size (px)')
    a = p.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    return a


def to_blender(p):
    """glTF (Y up) -> Blender (Z up), as the glTF importer converts."""
    return Vector((float(p[0]), float(-p[2]), float(p[1])))


class Rig:
    def __init__(self, path):
        d = np.load(path)
        self.names = [str(n) for n in d['names']]
        self.parents = [int(i) for i in d['parents']]
        self.head = [to_blender(p) for p in d['head']]
        self.tail = [to_blender(p) for p in d['tail']]
        self.bones = d['bones']
        self.weights = d['weights']
        verts = d['verts']
        self.tree = kdtree.KDTree(len(verts))
        for i, p in enumerate(verts):
            self.tree.insert(to_blender(p), i)
        self.tree.balance()

    def armature(self):
        data = bpy.data.armatures.new('Armature')
        arm = bpy.data.objects.new('Armature', data)
        bpy.context.scene.collection.objects.link(arm)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode='EDIT')
        for i, n in enumerate(self.names):
            b = data.edit_bones.new(n)
            b.head = self.head[i]
            b.tail = self.tail[i] if (self.tail[i] - self.head[i]).length > 1e-5 else self.head[i] + Vector((0, 0, 0.01))
        for i, n in enumerate(self.names):
            if self.parents[i] >= 0:
                data.edit_bones[n].parent = data.edit_bones[self.names[self.parents[i]]]
        # Roll: each bone's Z axis towards the character's front (-Y), up for the bones lying along it (the feet), so
        # the same rotation bends the left and right limbs alike.
        for b in data.edit_bones:
            v = (b.tail - b.head).normalized()
            b.align_roll(Vector((0, -1, 0)) if abs(v.y) < 0.7 else Vector((0, 0, 1)))
        bpy.ops.object.mode_set(mode='OBJECT')
        return arm

    def skin(self, body, arm):
        """The weights of the nearest analysed vertex; returns how many vertices got any."""
        groups = [body.vertex_groups.new(name=n) for n in self.names]
        world = body.matrix_world
        weighted = 0
        for v in body.data.vertices:
            _, i, _ = self.tree.find(world @ v.co)
            any_weight = False
            for bone, w in zip(self.bones[i], self.weights[i]):
                if w > 1e-4:
                    groups[int(bone)].add([v.index], float(w), 'REPLACE')
                    any_weight = True
            weighted += any_weight
        body.parent = arm
        body.matrix_world = world.copy()
        modifier = body.modifiers.new('Armature', 'ARMATURE')
        modifier.object = arm
        return weighted


def unrig(bodies):
    """A skeleton the model already has goes (an uploaded rigged model, or a model rigged by an interrupted run): the
    meshes stay where they are, without its weights, and get the new one."""
    for b in bodies:
        if b.parent is not None and b.parent.type == 'ARMATURE':
            world = b.matrix_world.copy()
            b.parent = None
            b.matrix_world = world
        for m in [m for m in b.modifiers if m.type == 'ARMATURE']:
            b.modifiers.remove(m)
        b.vertex_groups.clear()
    for o in [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']:
        bpy.data.objects.remove(o, do_unlink=True)


def rig_model(rig, path):
    model3d.clear_scene()
    bodies = model3d.import_model(path)
    if not bodies:
        raise SystemExit(f'No mesh in {path}')
    unrig(bodies)
    arm = rig.armature()
    weighted = sum(rig.skin(b, arm) for b in bodies)
    vertices = sum(len(b.data.vertices) for b in bodies)
    bpy.context.view_layer.update()
    model3d.select(bodies + [arm])
    temp = path + '.writing.glb'
    bpy.ops.export_scene.gltf(filepath=temp, export_format='GLB', use_selection=True)
    os.replace(temp, path)
    return bodies, arm, {'file': os.path.basename(path), 'vertices': vertices, 'weighted': weighted}


def turn(pb, axis, angle):
    """Turns a pose bone about its head, about a world axis (the armature object may be turned: its own axes)."""
    pivot = pb.head.copy()
    axis = pb.id_data.matrix_world.to_3x3().inverted() @ Vector(axis)
    pb.matrix = Matrix.Translation(pivot) @ Matrix.Rotation(angle, 4, axis.normalized()) @ Matrix.Translation(-pivot) @ pb.matrix
    bpy.context.view_layer.update()


def swing(pb, target, amount):
    """Swings a pose bone towards a world direction (amount 1: all the way)."""
    world = pb.id_data.matrix_world.to_3x3()
    current = (world @ (pb.tail - pb.head)).normalized()
    t = Vector(target).normalized()
    axis = current.cross(t)
    if axis.length > 1e-6:
        turn(pb, axis, current.angle(t) * amount)


def show(bodies, arm, output, frames, size):
    """A loop of a test motion seen from the front left: the head turns, the left arm waves up, the right arm reaches
    forward, the legs step."""
    pose = arm.pose.bones
    for pb in pose:
        pb.rotation_mode = 'QUATERNION'
    for f in range(1, frames + 1):
        for pb in pose:
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.location = (0, 0, 0)
        bpy.context.view_layer.update()
        up = 0.5 - 0.5 * math.cos(2 * math.pi * (f - 1) / frames)
        side = math.sin(2 * math.pi * (f - 1) / frames)
        turn(pose[P + 'Spine1'], (0, 0, 1), math.radians(12) * side)
        turn(pose[P + 'Head'], (0, 0, 1), math.radians(30) * side)
        swing(pose[P + 'LeftArm'], (0.3, -0.2, 1), 0.85 * up)
        swing(pose[P + 'LeftForeArm'], (0, -1, 1), 0.5 * up)
        swing(pose[P + 'RightArm'], (0, -1, 0.1), 0.7 * up)
        swing(pose[P + 'LeftUpLeg'], (0, -1, -0.3), 0.45 * max(0, side))
        swing(pose[P + 'RightUpLeg'], (0, -1, -0.3), 0.45 * max(0, -side))
        swing(pose[P + 'LeftLeg'], (0, 1, -0.6), 0.5 * max(0, side))
        swing(pose[P + 'RightLeg'], (0, 1, -0.6), 0.5 * max(0, -side))
        for pb in pose:
            pb.keyframe_insert('rotation_quaternion', frame=f)
    model3d.setup_turntable(bodies + [arm], frames, size, True)
    axis = bpy.data.objects['turn']
    axis.animation_data_clear()
    axis.rotation_euler = (0, 0, math.radians(-25))
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, frames
    folder = os.path.join(os.path.abspath(output), 'frames')
    os.makedirs(folder, exist_ok=True)
    scene.render.filepath = os.path.join(folder, '')
    bpy.ops.render.render(animation=True)
    return folder


def main():
    a = args()
    rig = Rig(os.path.abspath(a.npz))
    result = {'bones': len(rig.names), 'models': []}
    shown = None
    for path in a.models:
        bodies, arm, info = rig_model(rig, os.path.abspath(path))
        print(f"Rigged {info['file']}: {info['weighted']}/{info['vertices']} vertices", flush=True)
        result['models'].append(info)
        if a.show and os.path.abspath(a.show) == os.path.abspath(path):
            shown = path
    if shown:
        # the shown model is imported again, rigged as written (what a game engine reads)
        model3d.clear_scene()
        model3d.import_model(os.path.abspath(shown))
        objects = list(bpy.context.scene.objects)
        arm = next(o for o in objects if o.type == 'ARMATURE')
        result['frames'] = show([o for o in objects if o.type == 'MESH'], arm, a.output, max(1, a.frames), a.size)
    print('RESULT ' + json.dumps(result, ensure_ascii=False))


main()
