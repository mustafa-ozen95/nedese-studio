/**
 * Silme GERI ALINABILIR: klasor/dosya Windows geri donusum kutusuna tasinir
 * (Microsoft.VisualBasic FileSystem, Gezgin'in "Sil"i ile ayni). Bu yuzden arayuzdeki onay
 * yazili dogrulama istemez; NDS kurali: yazili onay yalnizca geri alinamayan islemde.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

export function moveToRecycleBin(path) {
  return new Promise((ok, red) => {
    const isFolder = statSync(path).isDirectory();
    const method = isFolder ? 'DeleteDirectory' : 'DeleteFile';
    // Yol ortam degiskeniyle gecer: tirnak/kacis derdi yok.
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}($env:TODELETE, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 60000, env: { ...process.env, TODELETE: path } },
      (error, _output, errorOutput) => {
        if (error) red(new Error(`Could not move to the Recycle Bin: ${String(errorOutput || error.message).trim().slice(0, 300)}`));
        else ok();
      },
    );
  });
}
