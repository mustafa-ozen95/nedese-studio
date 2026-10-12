/**
 * Real Blender (skipped on a machine without one): tools\blender\game_copies.py makes each game copy one closed solid
 * baked from the full model. ComfyUI's decimation of a curly-haired woman (12.10.2026) left shards of the shell's inner
 * sheet all over her face and gave three quarters of the triangles to the hair. The test figure is a ball with an inner
 * sheet close behind its surface (Pixal3D's double shell) and a tuft of open strands on top; its colour is red above,
 * blue below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findBlender } from '../lib/blender.mjs';

const blender = findBlender();
const SCRIPT = fileURLToPath(new URL('../../tools/blender/game_copies.py', import.meta.url));

const MAKE_FIGURE = `
import sys
import math
import bpy
import bmesh
model = sys.argv[sys.argv.index('--') + 1]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bm = bmesh.new()
bm.loops.layers.uv.new('UVMap')
bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=0.3, calc_uvs=True)
# the inner sheet: the same ball a little smaller, turned inwards
inner = bmesh.new()
inner.loops.layers.uv.new('UVMap')
bmesh.ops.create_uvsphere(inner, u_segments=96, v_segments=48, radius=0.2985, calc_uvs=True)
bmesh.ops.reverse_faces(inner, faces=inner.faces)
mesh = bpy.data.meshes.new('ball')
bm.to_mesh(mesh)
part = bpy.data.meshes.new('inner')
inner.to_mesh(part)
bm.free()
inner.free()
# open strands on top: thin two-sided ribbons, each its own piece (more polygons than the ball)
bm = bmesh.new()
bm.from_mesh(mesh)
bm.from_mesh(part)
uv = bm.loops.layers.uv.active
for i in range(400):
    a = i * 2.39996
    r = 0.12 * math.sqrt((i + 0.5) / 400)
    x, y = r * math.cos(a), r * math.sin(a)
    z = math.sqrt(max(0.3 ** 2 - x * x - y * y, 0)) - 0.005
    dx, dy = -math.sin(a) * 0.002, math.cos(a) * 0.002
    previous = None
    for k in range(9):
        t = k / 8
        cx, cy, cz = x * (1 + 0.6 * t), y * (1 + 0.6 * t), z + 0.08 * t
        pair = (bm.verts.new((cx - dx, cy - dy, cz)), bm.verts.new((cx + dx, cy + dy, cz)))
        if previous:
            face = bm.faces.new((previous[0], previous[1], pair[1], pair[0]))
            for loop in face.loops:
                loop[uv].uv = (0.5, 0.99)
        previous = pair
mesh = bpy.data.meshes.new('figure')
bm.to_mesh(mesh)
bm.free()
figure = bpy.data.objects.new('figure', mesh)
bpy.context.scene.collection.objects.link(figure)
# glTF is Y up: Blender's Z stays the figure's up after the export and the import
size = 64
colour = bpy.data.images.new('colour', size, size)
colour.pixels.foreach_set([c for y in range(size) for x in range(size) for c in ((0.9, 0.05, 0.05, 1) if y >= size // 2 else (0.05, 0.05, 0.9, 1))])
colour.pack()
orm = bpy.data.images.new('orm', size, size)
orm.pixels.foreach_set([1.0, 0.6, 0.0, 1.0] * size * size)
orm.colorspace_settings.name = 'Non-Color'
orm.pack()
material = bpy.data.materials.new('skin')
material.use_nodes = True
tree = material.node_tree
bsdf = next(n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED')
node = tree.nodes.new('ShaderNodeTexImage')
node.image = colour
tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
node = tree.nodes.new('ShaderNodeTexImage')
node.image = orm
split = tree.nodes.new('ShaderNodeSeparateColor')
tree.links.new(node.outputs['Color'], split.inputs['Color'])
tree.links.new(split.outputs['Green'], bsdf.inputs['Roughness'])
tree.links.new(split.outputs['Blue'], bsdf.inputs['Metallic'])
mesh.materials.append(material)
bpy.ops.object.select_all(action='DESELECT')
figure.select_set(True)
bpy.ops.export_scene.gltf(filepath=model, export_format='GLB', use_selection=True)
`;

// The copy's pieces, inward faces, faces seen from behind by rays from outside, and the baked colour above and below
const READ_COPY = `
import sys
import json
import math
import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
model = sys.argv[sys.argv.index('--') + 1]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bpy.ops.import_scene.gltf(filepath=model)
body = next(o for o in bpy.data.objects if o.type == 'MESH')
bm = bmesh.new()
bm.from_mesh(body.data)
bm.transform(body.matrix_world)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
bm.faces.ensure_lookup_table()
seen, pieces = set(), 0
for f in bm.faces:
    if f.index in seen:
        continue
    pieces += 1
    stack = [f]
    seen.add(f.index)
    while stack:
        for e in stack.pop().edges:
            for g in e.link_faces:
                if g.index not in seen:
                    seen.add(g.index)
                    stack.append(g)
open_edges = sum(1 for e in bm.edges if len(e.link_faces) != 2)
volume = bm.calc_volume(signed=True)
tree = BVHTree.FromBMesh(bm)
hits = behind = 0
for i in range(2000):
    z = 1 - 2 * (i + 0.5) / 2000
    a = i * 2.39996
    d = Vector((math.sqrt(1 - z * z) * math.cos(a), math.sqrt(1 - z * z) * math.sin(a), z))
    hit = tree.ray_cast(d * 2, -d)
    if hit[0] is not None:
        hits += 1
        behind += int(hit[1].dot(-d) > 0)
tree_nodes = body.active_material.node_tree
bsdf = next(n for n in tree_nodes.nodes if n.type == 'BSDF_PRINCIPLED')
image = next(l.from_node.image for l in tree_nodes.links if l.to_node == bsdf and l.to_socket.name == 'Base Color')
w, h = image.size
pixels = np.empty(w * h * 4, np.float32)
image.pixels.foreach_get(pixels)
pixels = pixels.reshape(h, w, 4)
uv = bm.loops.layers.uv.active
def colour(test):
    red = blue = 0
    for f in bm.faces:
        c = f.calc_center_median()
        if not test(c):
            continue
        u, v = sum((l[uv].uv for l in f.loops), Vector((0, 0))) / len(f.loops)
        p = pixels[min(int(v * h), h - 1), min(int(u * w), w - 1)]
        red += int(p[0] > 0.5 and p[2] < 0.3)
        blue += int(p[2] > 0.5 and p[0] < 0.3)
    return {'red': red, 'blue': blue}
top = max(v.co.z for v in bm.verts)
print('COPY ' + json.dumps({
    'pieces': pieces, 'openEdges': open_edges, 'volume': volume, 'hits': hits, 'behind': behind,
    'above': colour(lambda c: 0.1 < c.z < 0.2), 'below': colour(lambda c: c.z < -0.1), 'top': top,
}))
`;

/** The JSON chunk of a GLB file. */
function gltf(file) {
  const data = readFileSync(file);
  const length = data.readUInt32LE(12);
  return JSON.parse(data.subarray(20, 20 + length).toString('utf8'));
}

test('game copies: one closed solid without the inner sheet or the strands, coloured from the model, with tangents (real Blender)', { skip: blender ? false : 'Blender is not installed', timeout: 600000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'game-copies-'));
  try {
    const model = join(dir, 'model.glb');
    writeFileSync(join(dir, 'make.py'), MAKE_FIGURE);
    writeFileSync(join(dir, 'read.py'), READ_COPY);
    execFileSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', join(dir, 'make.py'), '--', model], { stdio: 'ignore' });
    // the face box in the middle of a 1024 px picture: the ball's front
    const focus = JSON.stringify({ fov: 30, face: [462, 462, 100, 100], size: 1024 });
    const copies = [['game.glb', 4000, 256], ['game-lod1.glb', 2000, 128]];
    const out = execFileSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', SCRIPT, '--', '--full', model, '--copies', ...copies.map(([f, t, s]) => `${join(dir, f)}:${t}:${s}`), '--focus', focus], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const result = JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
    assert.deepEqual(result.copies.map((c) => [c.file, c.size]), copies.map(([f, , s]) => [f, s]));
    for (const [i, [file, triangles]] of copies.entries()) {
      const c = result.copies[i];
      assert.ok(c.triangles <= triangles && c.triangles > triangles * 0.9, `${file}: ${c.triangles} of ${triangles} triangles`);
      assert.ok(c.face > 0, `${file}: the front focused`);
      const read = execFileSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', join(dir, 'read.py'), '--', join(dir, file)], { encoding: 'utf8', maxBuffer: 64 << 20 });
      const copy = JSON.parse(read.split('\n').find((l) => l.startsWith('COPY ')).slice(5));
      // one closed piece facing out: no inner sheet, no loose strands (ComfyUI's copies of the woman: 11-12 pieces and
      // 214-231 open edges; of a furry dwarf: 596 of 2000 rays from outside hit a face from behind). The 2k LOD of this
      // lumpy ball folds in a few spots (4 rays of 2000); the woman's and the dwarf's copies had none.
      assert.equal(copy.pieces, 1, `${file}: pieces`);
      assert.equal(copy.openEdges, 0, `${file}: open edges`);
      assert.ok(copy.volume > 0.08, `${file}: volume ${copy.volume}`);
      assert.ok(copy.hits > 1900 && copy.behind <= copy.hits * 0.005, `${file}: ${copy.behind} of ${copy.hits} rays hit a face from behind`);
      // the strands melted into a lump on top, not lost and not spikes
      assert.ok(copy.top > 0.31 && copy.top < 0.4, `${file}: top ${copy.top}`);
      // the colours baked where they were: red above, blue below
      assert.ok(copy.above.red > 10 * Math.max(copy.above.blue, 1), `${file}: above ${JSON.stringify(copy.above)}`);
      assert.ok(copy.below.blue > 10 * Math.max(copy.below.red, 1), `${file}: below ${JSON.stringify(copy.below)}`);
      // tangents for the normal map; the model's colour, ORM and normal maps
      const json = gltf(join(dir, file));
      assert.ok(json.meshes[0].primitives.every((p) => 'TANGENT' in p.attributes), `${file}: tangents`);
      const material = json.materials[0];
      assert.ok(material.pbrMetallicRoughness.baseColorTexture && material.pbrMetallicRoughness.metallicRoughnessTexture, `${file}: maps ${JSON.stringify(material)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
