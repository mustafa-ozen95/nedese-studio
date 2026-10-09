/**
 * Ayarlar > "Elimdeki model dosyasini ekle" icin dosya gezgini: panelin calistigi
 * makinedeki klasorleri ve model dosyalarini listeler (tarayici guvenlik geregi secilen
 * dosyanin tam yolunu vermez; tasima icin yol sunucuda secilir).
 *
 * Yalniz okur: klasor adlari ve model uzantili dosyalar (boyutuyla). Gizli/system
 * klasorleri ($Recycle.Bin, System Volume Information, nokta ile baslayanlar) gosterilmez.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import { UserError } from './errors.mjs';
import { MODEL_EXTENSIONS } from './models.mjs';

const HIDDEN = /^(\$|\.|System Volume Information$|Recovery$|Config\.Msi$|PerfLogs$)/i;

/** Masaustu, Indirilenler, Belgeler ve suruculer (yalniz var olanlar). */
export function shortcuts() {
  const home = homedir();
  const candidates = [
    ['Desktop', join(home, 'Desktop')],
    ['Desktop (OneDrive)', join(home, 'OneDrive', 'Desktop')],
    ['Downloads', join(home, 'Downloads')],
    ['Docs', join(home, 'Documents')],
  ];
  const list = candidates.filter(([, path]) => existsSync(path)).map(([name, path]) => ({ name, path }));
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`;
      if (existsSync(root)) list.push({ name: `${letter}:`, path: root });
    }
  } else {
    list.push({ name: '/', path: '/' });
  }
  return list;
}

/** Klasor icerigi: alt klasorler ve model dosyalari. yol bossa Masaustu. */
export function browse(path) {
  const target = resolve(String(path || '').trim() || join(homedir(), 'Desktop'));
  let st;
  try {
    st = statSync(target);
  } catch {
    throw new UserError(`Folder not found: ${target}`, 'notFound');
  }
  if (!st.isDirectory()) throw new UserError('The path is not a folder.');
  let inputs = [];
  try {
    inputs = readdirSync(target, { withFileTypes: true });
  } catch {
    throw new UserError(`Could not read the folder (no permission): ${target}`);
  }
  const folders = [];
  const files = [];
  for (const g of inputs) {
    if (HIDDEN.test(g.name)) continue;
    if (g.isDirectory()) folders.push(g.name);
    else if (g.isFile() && MODEL_EXTENSIONS.includes(extname(g.name).toLowerCase())) {
      let size = null;
      try {
        size = statSync(join(target, g.name)).size;
      } catch {
        /* kilitli dosya: boyutsuz goster */
      }
      files.push({ name: g.name, path: join(target, g.name), size });
    }
  }
  const sort = (a, b) => a.localeCompare(b, 'tr', { sensitivity: 'base' });
  const root = parse(target).root;
  return {
    path: target,
    parent: target === root ? null : dirname(target),
    folders: folders.sort(sort).map((name) => ({ name, path: join(target, name) })),
    files: files.sort((a, b) => sort(a.name, b.name)),
    shortcuts: shortcuts(),
  };
}

/** Dosya adindan model klasoru tahmini (kullanici degistirebilir). */
export function folderEstimate(file) {
  const name = basename(String(file)).toLowerCase();
  if (/lora|lightning|lightx2v/.test(name)) return 'loras';
  if (/vae/.test(name)) return 'vae';
  if (/umt5|t5xxl|clip|text.?encoder|qwen_2\.5_vl|llava|gemma/.test(name)) return 'text_encoders';
  if (/\.ckpt$/.test(name) || /checkpoint|fp8\.safetensors$|schnell/.test(name)) return 'checkpoints';
  return 'diffusion_models';
}
