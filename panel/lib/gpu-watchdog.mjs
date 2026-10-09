/**
 * Is baslamadan once ekran karti baska bir programca kullaniliyor mu (ayni anda iki buyuk model
 * VRAM/RAM'e sigmaz, biri coker ya da takasa duser). Windows'ta surec basina VRAM gorunmez
 * (nvidia-smi "N/A"); bu yuzden iki isaret:
 *  1. Yabanci hesaplama sureci: nvidia-smi tablosunda tipi "C" olan ve panelin ya da ComfyUI'nin
 *     surec agacinda olmayan surec (baska bir yapay zeka programi, egitim, ikinci bir ComfyUI).
 *  2. ComfyUI kapali ve panelin alt sureci yokken VRAM 4 GB'tan fazla dolu (oyun, video isleme).
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';

const run = (command, args) =>
  new Promise((ok) => execFile(command, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 * 2 ** 20 }, (h, output) => ok(h ? '' : String(output))));

/** nvidia-smi tablosundaki surecler: [{ pid, tur, ad }] */
async function gpuProcesses() {
  const text = await run('nvidia-smi', []);
  const list = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\|\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(C\+G|C|G)\s+(.+?)\s{2,}\S+\s*\|$/.exec(line);
    if (m) list.push({ pid: Number(m[1]), type: m[2], name: m[3].trim() });
  }
  return list;
}

/** Windows surec agaci: pid -> ebeveyn pid (Win32_Process). */
async function parents() {
  if (process.platform !== 'win32') return new Map();
  const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']);
  const map = new Map();
  for (const s of text.split(/\r?\n/)) {
    const [a, b] = s.trim().split(/\s+/).map(Number);
    if (a) map.set(a, b);
  }
  return map;
}

/**
 * Doner: null (kart bos ya da yalniz bizim surecler) ya da { neden } (beklenmeli).
 * bizimPidler: panelin ve ComfyUI'nin kok surecleri; altlari da bizim sayilir.
 */
export async function isGpuBusy({ ourPids = [], comfyOpen = false, measureGpu } = {}) {
  const [processes, tree] = await Promise.all([gpuProcesses(), parents()]);
  const roots = new Set([process.pid, ...ourPids]);
  const isOur = (pid) => {
    for (let p = pid, step = 0; p && step < 30; p = tree.get(p), step++) if (roots.has(p)) return true;
    return false;
  };
  const foreign = processes.filter((s) => s.type === 'C' && !isOur(s.pid));
  if (foreign.length) {
    const names = [...new Set(foreign.map((s) => basename(s.name.replace(/^\.\.\./, ''))))].join(', ');
    return { reason: `Another AI program is using the graphics card (${names}); the job starts when it finishes.` };
  }
  const hasOurSub = processes.some((s) => s.type === 'C' && isOur(s.pid));
  if (!comfyOpen && !hasOurSub && measureGpu) {
    const g = await measureGpu();
    if (g?.memoryUsedMb > 4096) return { reason: `Graphics memory is used by another program (${(g.memoryUsedMb / 1024).toFixed(1)} GB; maybe a game or video app). The job starts when it is free.` };
  }
  return null;
}
