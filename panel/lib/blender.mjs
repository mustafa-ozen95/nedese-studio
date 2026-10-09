/**
 * Blender (no window): the turntable video of a 3D model and its FBX/OBJ/STL export (tools\blender\model3d.py). Without
 * Blender the 3D model job makes only the GLB.
 *
 * No version is written in: AI_PANEL_BLENDER > PATH > Program Files\Blender Foundation\Blender * (the newest) > Steam.
 * The script tries operator and engine names at run time (3.6 - 5.x).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './process.mjs';

/** "Blender 4.10" > "Blender 4.2": the version parts are compared as numbers. */
function compareVersion(a, b) {
  const pa = (a.match(/\d+/g) ?? []).map(Number);
  const pb = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const f = (pb[i] ?? -1) - (pa[i] ?? -1);
    if (f) return f;
  }
  return 0;
}

export function findBlender(env = process.env) {
  if (env.AI_PANEL_BLENDER) return existsSync(env.AI_PANEL_BLENDER) ? env.AI_PANEL_BLENDER : null;
  for (const d of (env.PATH ?? '').split(';')) if (d && existsSync(join(d, 'blender.exe'))) return join(d, 'blender.exe');
  for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean)) {
    const root = join(pf, 'Blender Foundation');
    let subs = [];
    try {
      subs = readdirSync(root).filter((a) => /^Blender/i.test(a)).sort(compareVersion);
    } catch {
      continue;
    }
    for (const a of subs) if (existsSync(join(root, a, 'blender.exe'))) return join(root, a, 'blender.exe');
  }
  const steam = join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe');
  return existsSync(steam) ? steam : null;
}

/**
 * GLB -> exports + turntable frames (<output>/frames/0001.png...). STL is the print copy, printHeight mm tall.
 * Returns the script's RESULT line ({ blender, triangles, size, files: { fbx, obj, stl }, print, frames, engine }).
 */
export async function blenderPresentation(blender, { script, input, output, name, frames = 120, size = 1024, formats = ['fbx', 'obj', 'stl'], printHeight = 100, signal, progress = () => {} }) {
  const args = ['-b', '--factory-startup', '--python-exit-code', '1', '-P', script, '--', '--input', input, '--output', output, '--name', name, '--frames', String(frames), '--size', String(size), '--formats', formats.join(','), '--print-height', String(printHeight)];
  // blender: the exe path or (in tests) a function that returns { command, args } for the arguments.
  const k = typeof blender === 'function' ? blender(args) : { command: blender, args };
  let result = null;
  await run(k.command, k.args, {
    name: 'Blender',
    signal,
    env: { ...process.env, PYTHONUTF8: '1' },
    line: (s) => {
      if (s.startsWith('RESULT ')) {
        try {
          result = JSON.parse(s.slice(7));
        } catch {
          /* */
        }
        return;
      }
      // Frame progress: "Fra:12 ..." / "Saved: '...\0012.png'".
      const m = s.match(/^Fra:(\d+)/) ?? s.match(/Saved: .*?(\d+)\.png/);
      if (m && frames) progress(Number(m[1]) / frames);
    },
  });
  if (!result) throw new Error('Blender returned no result.');
  return result;
}
