/**
 * Skills (Claude Code's "skills" format): <folder>/<name>/SKILL.md with YAML front matter (name, description).
 * Sources, all inside the project (user request 09.10.2026, ~/.claude is not read): panel-data\skills, <ai>\.claude\skills
 * and the skills\ folder of every plugin in panel-data\plugins (plugins.mjs).
 * Only the name and description go into the agent's system prompt; load_skill reads the body when it is needed.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { pluginFolders } from './plugins.mjs';
import { DATA_FILES } from '../data-files.mjs';

/** YAML on bilgisinin duz anahtarlari (tek satir; | ve > ile cok satirli aciklama da). */
export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!s) continue;
    let value = s[2].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const part = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) part.push(lines[++i].trim());
      value = part.join(value.startsWith('|') ? '\n' : ' ');
    }
    fields[s[1]] = value.replace(/^["']|["']$/g, '');
  }
  return { fields, body: text.slice(m[0].length) };
}

export function findSkills({ aiRoot, dataRoot }) {
  const roots = [
    { path: join(dataRoot, DATA_FILES.skills), source: 'panel' },
    { path: join(aiRoot, '.claude', 'skills'), source: 'project' },
    ...pluginFolders(dataRoot).map((e) => ({ path: join(e.path, 'skills'), source: `plugin:${e.name}`, prefix: e.name })),
  ];
  const result = new Map();
  for (const k of roots) {
    if (!existsSync(k.path)) continue;
    let names = [];
    try {
      names = readdirSync(k.path);
    } catch {
      continue;
    }
    for (const folder of names) {
      const file = join(k.path, folder, 'SKILL.md');
      if (!existsSync(file)) continue;
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { fields } = frontMatter(text);
      const name = `${k.prefix ? `${k.prefix}:` : ''}${fields.name || folder}`;
      if (result.has(name)) continue;
      result.set(name, { name, description: String(fields.description ?? '').replace(/\s+/g, ' ').slice(0, 300), file, folder: join(k.path, folder), source: k.source });
    }
  }
  return [...result.values()];
}

/** SKILL.md folders under a folder (a repository may hold several), at most 4 levels deep. */
function skillFolders(base) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4 || found.length > 200) return;
    let names = [];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (names.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const { fields } = frontMatter(readFileSync(join(d, 'SKILL.md'), 'utf8'));
      found.push({ name: fields.name || basename(d), description: String(fields.description ?? '').replace(/\s+/g, ' ').slice(0, 160), folder: d });
      return;
    }
    for (const e of names) if (e.isDirectory() && !['.git', 'node_modules', '.venv', '__pycache__'].includes(e.name)) walk(join(d, e.name), depth + 1);
  };
  walk(base, 0);
  return found;
}

/** github.com/<owner>/<repo>[/tree/<ref>/<folder>] -> { owner, repo, ref, folder }; null for other addresses. */
export function githubSource(address) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(String(address).trim());
  return m ? { owner: m[1], repo: m[2], ref: m[3] ?? '', folder: (m[4] ?? '').replace(/\/SKILL\.md$/i, '') } : null;
}

/**
 * Installs a skill into panel-data\skills (the agent's install_skill; user request 08.10.2026: it should find and
 * install the skills and MCP servers it needs). source: a GitHub address (repository, or .../tree/<branch>/<folder>) or a
 * folder on this computer. A source with several skills returns them as choices; skill picks one by name or folder.
 * download(url, file) saves a file (the agent's downloader); tar extracts the GitHub archive.
 * -> { installed: { name, folder } } | { choices: [{ name, description }] }
 */
export async function installSkill({ source, skill = '', dataRoot, replace = false, download, tar }) {
  const temp = mkdtempSync(join(tmpdir(), 'nedese-skill-'));
  try {
    let base = String(source ?? '').trim();
    const gh = githubSource(base);
    if (gh) {
      // The repository archive (GitHub API: the default branch when no ref is given)
      const archive = join(temp, 'source.tar.gz');
      await download(`https://api.github.com/repos/${gh.owner}/${gh.repo}/tarball/${encodeURIComponent(gh.ref)}`.replace(/\/$/, ''), archive);
      await tar(archive, temp);
      const top = readdirSync(temp, { withFileTypes: true }).find((e) => e.isDirectory());
      if (!top) throw new Error('The archive from GitHub was empty.');
      base = join(temp, top.name, ...gh.folder.split('/').filter(Boolean));
    } else if (!existsSync(base)) throw new Error('The source must be a GitHub address (github.com/<owner>/<repo>, or .../tree/<branch>/<folder>) or a folder on this computer.');
    if (!existsSync(base)) throw new Error(`No such folder in the repository: ${source}`);
    const found = skillFolders(base);
    if (!found.length) throw new Error('No SKILL.md found there.');
    const wanted = String(skill ?? '').trim().toLowerCase();
    const pick = found.length === 1 && !wanted ? found[0] : found.find((s) => s.name.toLowerCase() === wanted || basename(s.folder).toLowerCase() === wanted);
    if (!pick) return { choices: found.map(({ name, description }) => ({ name, description })) };
    // A skill written on this computer (often by the agent itself) must say what it is for: load_skill finds skills by
    // their description (10.10.2026: the agent's QR skill had a heading and no front matter)
    if (!gh && !pick.description) throw new Error(`${join(pick.folder, 'SKILL.md')} has no description: start it with front matter (---, name: <name>, description: <what it does and when to use it>, ---), then install again.`);
    const target = join(dataRoot, DATA_FILES.skills, basename(pick.folder).replace(/[^\w.-]/g, '_'));
    if (existsSync(target)) {
      if (!replace) throw new Error(`A skill is already installed at ${target}; give replace: true to update it.`);
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(dirname(target), { recursive: true });
    cpSync(pick.folder, target, { recursive: true });
    return { installed: { name: pick.name, folder: target } };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Becerinin govdesi + klasordeki diger dosyalar (ajan read_file ile acar). */
export function loadSkill(skills, name) {
  const b = skills.find((x) => x.name === name) ?? skills.find((x) => x.name.split(':').pop() === name);
  if (!b) throw new Error(`No such skill: "${name}". Known: ${skills.map((x) => x.name).join(', ')}`);
  const { body } = frontMatter(readFileSync(b.file, 'utf8'));
  const files = [];
  const walk = (d, depth) => {
    if (depth > 3 || files.length > 60) return;
    for (const a of readdirSync(d)) {
      const y = join(d, a);
      if (statSync(y).isDirectory()) walk(y, depth + 1);
      else if (y !== b.file) files.push(relative(b.folder, y));
    }
  };
  walk(b.folder, 0);
  return { name: b.name, folder: b.folder, content: body, files };
}
