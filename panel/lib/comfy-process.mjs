/**
 * ComfyUI surecini bulma ve kapatma (API: POST /api/v1/comfy/durdur). ComfyUI kendi
 * penceresinde baslat_comfyui.bat ile acilir; komut satirinda "ComfyUI\main.py" gecen
 * python sureci bulunur ve agaciyla kapatilir. Baska python'a dokunulmaz.
 */
import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killTree } from './process.mjs';

/** { pid, komut }[] - komut satirinda main.py gecen ComfyUI python surecleri. */
export function comfyProcesses() {
  return new Promise((ok) => {
    if (process.platform !== 'win32') {
      ok([]);
      return;
    }
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ComfyUI[\\\\/]main\\.py' } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 }, (error, output) => {
      if (error) {
        ok([]);
        return;
      }
      ok(
        String(output)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const [pid, ...k] = s.split('\t');
            return { pid: Number(pid), command: k.join('\t').slice(0, 300) };
          })
          .filter((x) => Number.isInteger(x.pid) && x.pid > 0),
      );
    });
  });
}

/** Bulunan ComfyUI sureclerini kapatir; kapatilan pid listesi doner. */
export async function closeComfy() {
  const list = await comfyProcesses();
  for (const s of list) killTree(s.pid);
  return list.map((s) => s.pid);
}

/**
 * ComfyUI 0.37 yamasi (dudak esleme): ModelPatchLoader InfiniteTalk yamasini (MultiTalkModelPatch) dtype vermeden kurar,
 * agirliklar fp32'ye acilir. Olculdu 07.10.2026: yama RAM'de 9,5 GB yerine 4,7 GB (diger yama turleri dtype'i zaten
 * veriyor). Yalniz beklenen blok birebir varsa dtype=dtype eklenir; ComfyUI guncellenip blok degistiyse dokunulmaz.
 * Doner: 'applied' | 'already' | 'none' (dosya ya da blok yok).
 */
const MULTITALK_UNPATCHED = `                    device=comfy.model_management.unet_offload_device(),
                    operations=comfy.ops.manual_cast)
        elif 'model.control_model.input_hint_block.0.weight' in sd`;
export function comfyPatch(comfyFolder) {
  const path = join(comfyFolder, 'comfy_extras', 'nodes_model_patch.py');
  let s;
  try {
    s = readFileSync(path, 'utf8');
  } catch {
    return 'none';
  }
  const startedAt = s.indexOf('model = MultiTalkModelPatch(');
  if (startedAt < 0) return 'none';
  const block = s.slice(startedAt, s.indexOf('elif', startedAt) + 4);
  if (block.includes('dtype=dtype')) return 'already';
  const n = s.split(MULTITALK_UNPATCHED).length - 1;
  if (n !== 1 || s.indexOf(MULTITALK_UNPATCHED) < startedAt) return 'none';
  writeFileSync(`${path}.writing`, s.replace(MULTITALK_UNPATCHED, MULTITALK_UNPATCHED.replace('                    operations=', '                    dtype=dtype,\n                    operations=')), 'utf8');
  renameSync(`${path}.writing`, path);
  return 'applied';
}

/**
 * extra_model_paths.yaml (kur.ps1 yazar) dudak esleme klasorlerini (audio_encoders, model_patches) bilmiyorsa ekler:
 * gunluk guncelleme kur.ps1'i calistirmaz; modeller Ayarlar'dan inse de ComfyUI bulamazdi. Yalniz panelin yazdigi
 * bicime ("yerel:" + "base_path:") dokunulur, eksik satir dosya sonuna eklenir. Doner: 'applied' | 'already' | 'none'.
 */
const LIP_FOLDERS = ['audio_encoders', 'model_patches'];
export function comfyPaths(comfyFolder) {
  const path = join(comfyFolder, 'extra_model_paths.yaml');
  let s;
  try {
    s = readFileSync(path, 'utf8');
  } catch {
    return 'none';
  }
  if (!/^yerel:\r?\n {2}base_path: /m.test(s)) return 'none';
  const missing = LIP_FOLDERS.filter((k) => !new RegExp(`^ {2}${k}:`, 'm').test(s));
  if (!missing.length) return 'already';
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(`${path}.writing`, `${s.replace(/\s*$/, '')}${nl}${missing.map((k) => `  ${k}: ${k}/`).join(nl)}${nl}`, 'utf8');
  renameSync(`${path}.writing`, path);
  return 'applied';
}
