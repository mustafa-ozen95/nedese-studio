/**
 * Dis surec calistirma (seslendirme, ses tasarimi, ffmpeg): satir satir cikti,
 * iptal sinyaliyle SUREC AGACI oldurulur (cmd -> python zincirinde yalniz cmd'yi
 * oldurmek python'u GPU'da yetim birakirdi).
 */
import { spawn, spawnSync } from 'node:child_process';
import { CancelError, ProcessError } from './errors.mjs';

/** Windows'ta agaci kokuyle birlikte oldurur. */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* zaten bitmis */
    }
  }
}

/** Calisan butun alt surecler (panel kapanirken temizlik icin). */
export const runningProcesses = new Set();

/**
 * Komutu calistirir.
 * secenekler: cwd, env, sinyal (AbortSignal), satir(metin, akis), ad ('ses' | 'ffmpeg' ...),
 *             windowsVerbatimArguments, sonSatirSayisi
 * Doner: { son: [son satirlar] }. Sifirdan farkli cikis -> SurecHatasi, iptal -> IptalHatasi.
 */
export function run(command, args, options = {}) {
  const { cwd, env, signal, line, name = command, windowsVerbatimArguments = false, lastLineCount = 80 } = options;
  return new Promise((ok, red) => {
    if (signal?.aborted) {
      red(new CancelError());
      return;
    }
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, windowsVerbatimArguments });
    } catch (e) {
      red(e);
      return;
    }
    runningProcesses.add(child);
    const last = [];
    const add = (text, stream) => {
      const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
      if (!clean.trim()) return;
      last.push(clean);
      if (last.length > lastLineCount) last.shift();
      try {
        line?.(clean, stream);
      } catch {
        /* izleyici hatasi sureci bozmasin */
      }
    };
    const bind = (stream, name) => {
      if (!stream) return;
      stream.setEncoding('utf8');
      let buffer = '';
      stream.on('data', (part) => {
        buffer += part;
        // \r de satir sonu: tqdm ve ffmpeg ilerlemesi ayni satiri \r ile yeniler.
        const parts = buffer.split(/\r\n|\n|\r/);
        buffer = parts.pop();
        for (const p of parts) add(p, name);
      });
      stream.on('end', () => {
        if (buffer) add(buffer, name);
        buffer = '';
      });
    };
    bind(child.stdout, 'stdout');
    bind(child.stderr, 'stderr');

    const stop = () => killTree(child.pid);
    signal?.addEventListener('abort', stop, { once: true });

    child.on('error', (e) => {
      runningProcesses.delete(child);
      signal?.removeEventListener('abort', stop);
      red(Object.assign(e, { lastLines: last }));
    });
    child.on('close', (code) => {
      runningProcesses.delete(child);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) red(new CancelError());
      else if (code === 0) ok({ last });
      else red(new ProcessError(name, code, last));
    });
  });
}

/** cmd.exe ile .bat calistirma: tirnaklama Node'un shell:true'su gibi (/d /s /c "..."). */
export function batArgs(bat, args) {
  const quote = (s) => {
    const d = String(s);
    if (/["\r\n%^&|<>]/.test(d)) throw new Error(`Character not allowed in a bat argument: ${d}`);
    return /\s/.test(d) || d === '' ? `"${d}"` : d;
  };
  const line = [`"${bat}"`, ...args.map(quote)].join(' ');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}
