/**
 * The "nedese" command in any terminal: <ai>\bin goes on the user PATH when the panel starts (setup.bat does it too, but
 * an install moved by hand never ran it: on Hasan's PC "nedese" was not found, 08.10.2026). The panel runs in the
 * user's own session (the tray starts it), so the change reaches new terminals at once; it is added only when missing.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PowerShell that adds the folder to a user variable (PATH) when it is missing and prints "added". The variable is named
 * once, so a test can point the whole script at a throwaway variable (patching the text once hit the real PATH).
 */
export function cliPathScript(bin, variable = 'Path') {
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return `$b = ${quote(bin)}; $v = ${quote(variable)}; $p = [Environment]::GetEnvironmentVariable($v, 'User'); $parts = @($p -split ';' | Where-Object { $_ }); if ($parts -notcontains $b -and $parts -notcontains "$b\\") { [Environment]::SetEnvironmentVariable($v, (($parts + $b) -join ';'), 'User'); 'added' }`;
}

/** Windows only, and only when <ai>\bin\nedese.cmd is there. run: (script) => Promise<output> (tests). */
export async function ensureCliOnPath(aiRoot, { log = () => {}, platform = process.platform, run = null } = {}) {
  const bin = join(aiRoot, 'bin');
  if (platform !== 'win32' || !existsSync(join(bin, 'nedese.cmd'))) return false;
  const exec = run ?? ((script) => new Promise((ok) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 }, (_e, out) => ok(String(out ?? '')))));
  const out = await exec(cliPathScript(bin));
  if (!/\badded\b/.test(out)) return false;
  log(`CLI: ${bin} was added to the user PATH; "nedese" works in new terminal windows.`);
  return true;
}
