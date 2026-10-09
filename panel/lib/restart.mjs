/**
 * Guncellemeden sonra paneli yeniden acar (tepsi yonetmiyorsa: panel.bat penceresi, uzaktan baslatma).
 * Eski surec kapanana kadar bekler, sonra paneli ayni arguman ve ortamla ayri surec olarak baslatir; cikti
 * <ai>\gunluk\panel.log'a eklenir. Tepsi yonetiyorsa (AI_PANEL_TEPSI=1) kullanilmaz: tepsi bekcisi 10 sn'de acar.
 *
 *   node panel\lib\yeniden-baslat.mjs <eski pid> <panel\sunucu.mjs> [argumanlar...]
 */
import { mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [pid, ...arg] = process.argv.slice(2);
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const lives = (p) => {
  try {
    process.kill(Number(p), 0);
    return true;
  } catch {
    return false;
  }
};
const end = Date.now() + 120000;
while (lives(pid) && Date.now() < end) await wait(500);
await wait(1500); // port birakilsin
const aiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
mkdirSync(join(aiRoot, 'logs'), { recursive: true });
const log = openSync(join(aiRoot, 'logs', 'panel.log'), 'a');
spawn(process.execPath, arg, { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env, cwd: process.cwd() }).unref();
