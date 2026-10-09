/**
 * Real Blender (skipped on a machine without one): the STL print copy of tools\blender\model3d.py is solid. Generated
 * models are thin closed shells with slits in them; the test figure is the same: a 100 mm box whose wall is a 0.3 mm
 * shell with a 1.5 mm window cut through one side.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findBlender, blenderPresentation } from '../lib/blender.mjs';

const blender = findBlender();
const SCRIPT = fileURLToPath(new URL('../../tools/blender/model3d.py', import.meta.url));

const MAKE_FIGURE = `
import sys
import bpy
out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bpy.ops.mesh.primitive_cube_add(size=1.0)
box = bpy.context.active_object
wall = box.modifiers.new('wall', 'SOLIDIFY')
wall.thickness = 0.003
wall.offset = -1
bpy.ops.object.modifier_apply(modifier=wall.name)
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.5, 0, 0))
cutter = bpy.context.active_object
cutter.dimensions = (0.05, 0.015, 0.015)
window = box.modifiers.new('window', 'BOOLEAN')
window.operation = 'DIFFERENCE'
window.object = cutter
bpy.context.view_layer.objects.active = box
bpy.ops.object.modifier_apply(modifier=window.name)
bpy.data.objects.remove(cutter)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB')
`;

test('3D print copy: a thin shell with a slit in it is filled solid (real Blender)', { skip: blender ? false : 'Blender is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'print-'));
  try {
    writeFileSync(join(dir, 'make.py'), MAKE_FIGURE);
    execFileSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', join(dir, 'make.py'), '--', join(dir, 'figure.glb')], { stdio: 'ignore' });
    const result = await blenderPresentation(blender, { script: SCRIPT, input: join(dir, 'figure.glb'), output: dir, name: 'model', frames: 0, size: 256, formats: ['stl'], printHeight: 100 });
    const print = result.print;
    assert.equal(result.files.stl, 'model.stl');
    // the base cut is stretched back to the height, so the sides grow by the same 0.8 %
    assert.ok(print.size.every((v) => v > 99 && v < 102), `size ${print.size}`);
    assert.ok(print.watertight && print.solid, JSON.stringify(print));
    // the solid box is ~100.8 × 100.8 × 100 mm = ~1016 cm³; the shell alone would be ~18 cm³
    assert.ok(print.volume > 980 && print.volume < 1030, `volume ${print.volume} cm³`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
