/**
 * Real Blender (skipped on a machine without one): tools\blender\front_projection.py paints the picture onto what the
 * camera sees whatever the model's material is. A woman's eye rings stayed as black shards (11.10.2026): with the
 * model's own material those texels got no diffuse light in the visibility bake. The test figure is a metallic plane
 * facing the camera, its colour texture magenta; the picture is green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findBlender } from '../lib/blender.mjs';

const blender = findBlender();
const SCRIPT = fileURLToPath(new URL('../../tools/blender/front_projection.py', import.meta.url));

const MAKE_FIGURE = `
import sys
import bpy
model, picture = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
# glTF is Y up: the plane stands in Blender's XZ plane, facing -Y (the camera), after the import as well
bpy.ops.mesh.primitive_plane_add(size=0.6, rotation=(1.5707963, 0, 0))
plane = bpy.context.active_object
texture = bpy.data.images.new('magenta', 64, 64)
texture.pixels.foreach_set([1.0, 0.0, 1.0, 1.0] * 64 * 64)
texture.pack()
material = bpy.data.materials.new('metal')
material.use_nodes = True
tree = material.node_tree
bsdf = next(n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED')
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.3
node = tree.nodes.new('ShaderNodeTexImage')
node.image = texture
tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
plane.data.materials.append(material)
bpy.ops.export_scene.gltf(filepath=model, export_format='GLB')
green = bpy.data.images.new('green', 128, 128)
green.pixels.foreach_set([0.1, 0.8, 0.1, 1.0] * 128 * 128)
green.filepath_raw = picture
green.file_format = 'PNG'
green.save()
`;

const READ_COLOUR = `
import sys
import json
import bpy
import numpy as np
model = sys.argv[sys.argv.index('--') + 1]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bpy.ops.import_scene.gltf(filepath=model)
plane = next(o for o in bpy.data.objects if o.type == 'MESH')
tree = plane.active_material.node_tree
bsdf = next(n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED')
image = next(l.from_node.image for l in tree.links if l.to_node == bsdf and l.to_socket.name == 'Base Color')
pixels = np.empty(image.size[0] * image.size[1] * 4, np.float32)
image.pixels.foreach_get(pixels)
pixels = pixels.reshape(-1, 4)
green = (pixels[:, 1] > 0.5) & (pixels[:, 0] < 0.4) & (pixels[:, 2] < 0.4)
print('COLOUR ' + json.dumps({'green': float(green.mean()), 'metallic': bsdf.inputs['Metallic'].default_value}))
`;

test('front projection: a metallic surface the camera sees gets the picture too (real Blender)', { skip: blender ? false : 'Blender is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'projection-'));
  try {
    const model = join(dir, 'model.glb');
    const picture = join(dir, 'input.png');
    writeFileSync(join(dir, 'make.py'), MAKE_FIGURE);
    writeFileSync(join(dir, 'read.py'), READ_COLOUR);
    execFileSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', join(dir, 'make.py'), '--', model, picture], { stdio: 'ignore' });
    const out = execFileSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', SCRIPT, '--', '--picture', picture, '--fov', '30', '--models', model], { encoding: 'utf8' });
    const result = JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
    assert.equal(result.models[0].file, 'model.glb');
    assert.ok(result.models[0].share > 0.5, `share ${result.models[0].share}`);
    const read = execFileSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', join(dir, 'read.py'), '--', model], { encoding: 'utf8' });
    const colour = JSON.parse(read.split('\n').find((l) => l.startsWith('COLOUR ')).slice(7));
    // the plane's UV square fills the texture: (nearly) all of it is the picture's green now, still metallic
    assert.ok(colour.green > 0.9, `green ${colour.green}`);
    assert.equal(colour.metallic, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
