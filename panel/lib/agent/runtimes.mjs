/**
 * Programs the agent can really use on this computer, found once (user report 08.10.2026: the agent wrote a Python
 * script, but "python" was only the Microsoft Store shortcut and the command failed). One line for the system prompt.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function find(name) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/** "python" on Windows without Python installed: the WindowsApps alias that opens the Store. */
const storeAlias = (path) => Boolean(path && /\\WindowsApps\\python3?\.exe$/i.test(path));

let found = null;

/** Found once per process (the system prompt must stay the same from call to call). aiRoot: the bundled Python there. */
export function detectRuntimes(aiRoot = null) {
  return (found ??= detect(aiRoot));
}

function detect(aiRoot) {
  // the Python that comes with the panel (setup: <ai>\python) is first on the commands' PATH
  if (aiRoot && existsSync(join(aiRoot, 'python', process.platform === 'win32' ? 'python.exe' : join('bin', 'python3')))) {
    const present = ['node', 'npm', 'git', 'ssh', 'uv', 'winget'].filter((n) => find(n));
    return `Programs on this computer: python 3.12 (comes with the panel; install packages with python -m pip install …, there is no pip command), ${present.join(', ')}. Commands run in Windows PowerShell 5.1: no && or ||, use ; (or if ($?) { … }).`;
  }
  const at = {};
  for (const n of ['node', 'npm', 'git', 'ssh', 'python', 'python3', 'py', 'uv', 'winget', 'docker']) at[n] = find(n);
  const python = ['python', 'python3', 'py'].find((n) => at[n] && !storeAlias(at[n])) ?? null;
  const present = ['node', 'npm', 'git', 'ssh', 'uv', 'winget', 'docker'].filter((n) => at[n]);
  let pythonNote;
  if (python) pythonNote = `Python: ${python}.`;
  else if (at.uv) pythonNote = 'Python is not installed ("python" only opens the Microsoft Store): use node, or uv run python … (uv brings Python), or install it with winget.';
  else pythonNote = 'Python is not installed: use node, or install Python with winget first.';
  return `Programs on this computer: ${present.join(', ') || 'none found'}${python ? `, ${python}` : ''}. ${pythonNote} Commands run in Windows PowerShell 5.1: no && or ||, use ; (or if ($?) { … }).`;
}
