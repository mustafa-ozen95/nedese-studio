/**
 * Claude and Claude Code plugins inside the panel (user request 09.10.2026: the panel uses Claude's plugins, skills and
 * MCP servers, but downloads them into its own folders instead of reading ~/.claude). An installed plugin is a folder
 * panel-data\plugins\<name>\ laid out as Claude Code lays it out: .claude-plugin\plugin.json, skills\<skill>\SKILL.md,
 * .mcp.json (or "mcpServers" in plugin.json). skills.mjs and mcp.mjs read the skills and servers from these folders.
 *
 * A source is a plugin (a folder with .claude-plugin\plugin.json, skills\ or .mcp.json) or a marketplace (a folder with
 * .claude-plugin\marketplace.json listing plugins), on GitHub or on this computer.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DATA_FILES } from '../data-files.mjs';

function jsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const cleanName = (name) => String(name ?? '').trim().replace(/[^\w.-]/g, '_').slice(0, 80);

/** plugin.json of a plugin folder ({} when it has none). */
export const pluginManifest = (folder) => jsonFile(join(folder, '.claude-plugin', 'plugin.json')) ?? jsonFile(join(folder, 'plugin.json')) ?? {};

/** Installed plugins: [{ name, path, description, version }] (panel-data\plugins\*). */
export function pluginFolders(dataRoot) {
  const base = join(dataRoot, DATA_FILES.plugins);
  let names = [];
  try {
    names = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  return names.sort().map((folder) => {
    const path = join(base, folder);
    const m = pluginManifest(path);
    return { name: folder, path, description: String(m.description ?? '').replace(/\s+/g, ' ').slice(0, 300), version: m.version ? String(m.version) : null };
  });
}

/**
 * The MCP servers a plugin defines: .mcp.json ({ mcpServers } or the bare map), or "mcpServers" in plugin.json (an
 * object, or the path of a JSON file inside the plugin).
 */
export function pluginMcpServers(folder) {
  const own = jsonFile(join(folder, '.mcp.json'));
  if (own) return own.mcpServers ?? own;
  const m = pluginManifest(folder).mcpServers;
  if (typeof m === 'string') {
    const j = jsonFile(resolve(folder, m));
    return j?.mcpServers ?? j ?? {};
  }
  return m && typeof m === 'object' ? m : {};
}

/** Skill folder names of a plugin (skills\<name>\SKILL.md). */
export function pluginSkills(folder) {
  try {
    return readdirSync(join(folder, 'skills')).filter((d) => existsSync(join(folder, 'skills', d, 'SKILL.md')));
  } catch {
    return [];
  }
}

const isPlugin = (folder) => existsSync(join(folder, '.claude-plugin', 'plugin.json')) || existsSync(join(folder, 'plugin.json')) || existsSync(join(folder, '.mcp.json')) || pluginSkills(folder).length > 0;

/** github.com/<owner>/<repo>[.git][/tree/<ref>/<folder>] -> { owner, repo, ref, folder }; null for other addresses. */
export function githubRepo(address) {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(String(address ?? '').trim());
  return m ? { owner: m[1], repo: m[2], ref: m[3] ?? '', folder: m[4] ?? '' } : null;
}

/**
 * Installs a plugin into panel-data\plugins (the agent's install_plugin). source: a GitHub address or a folder on this
 * computer, of a plugin or of a marketplace; plugin: which plugin of a marketplace (a marketplace with several returns
 * them as choices). download(url, file) saves a file, tar(archive, folder) extracts it; stop(folder) is called before an
 * installed plugin is replaced (its MCP servers run in its folder, and Windows does not delete a folder in use).
 * -> { installed: { name, folder, skills, mcp } } | { choices: [{ name, description }] }
 */
export async function installPlugin({ source, plugin = '', dataRoot, replace = false, download, tar, stop = () => {} }) {
  const temp = mkdtempSync(join(tmpdir(), 'nedese-plugin-'));
  let fetched = 0;
  // A GitHub repository's archive (the default branch when no ref is given), extracted into the temp folder
  const fromGithub = async (gh) => {
    const into = join(temp, `r${fetched++}`);
    mkdirSync(into);
    const archive = join(into, 'source.tar.gz');
    await download(`https://api.github.com/repos/${gh.owner}/${gh.repo}/tarball/${encodeURIComponent(gh.ref ?? '')}`.replace(/\/$/, ''), archive);
    await tar(archive, into);
    const top = readdirSync(into, { withFileTypes: true }).find((e) => e.isDirectory());
    if (!top) throw new Error(`The archive of github.com/${gh.owner}/${gh.repo} was empty.`);
    const folder = join(into, top.name, ...String(gh.folder ?? '').split('/').filter(Boolean));
    if (!existsSync(folder)) throw new Error(`No such folder in github.com/${gh.owner}/${gh.repo}: ${gh.folder}`);
    return folder;
  };
  try {
    const gh = githubRepo(source);
    let base = gh ? await fromGithub(gh) : String(source ?? '').trim();
    if (!gh && (!isAbsolute(base) || !existsSync(base))) throw new Error('The source must be a GitHub address (github.com/<owner>/<repo>, or .../tree/<branch>/<folder>) or a folder on this computer.');
    let entry = null;
    const market = jsonFile(join(base, '.claude-plugin', 'marketplace.json'));
    if (market && Array.isArray(market.plugins)) {
      const wanted = String(plugin ?? '').trim().toLowerCase();
      entry = market.plugins.length === 1 && !wanted ? market.plugins[0] : market.plugins.find((p) => String(p?.name ?? '').toLowerCase() === wanted);
      if (!entry) return { choices: market.plugins.map((p) => ({ name: String(p?.name ?? ''), description: String(p?.description ?? '').replace(/\s+/g, ' ').slice(0, 200) })) };
      const s = entry.source;
      if (typeof s === 'string' || s == null) {
        // a path in the marketplace; metadata.pluginRoot is put before a bare name
        const rel = String(s ?? entry.name);
        const root = market.metadata?.pluginRoot && !/^\.{0,2}\//.test(rel) ? market.metadata.pluginRoot : '.';
        base = resolve(base, root, rel);
      } else if (s.source === 'github' && s.repo) {
        const [owner, repo] = String(s.repo).split('/');
        base = await fromGithub({ owner, repo, ref: s.ref ?? s.commit ?? '', folder: s.path ?? '' });
      } else if ((s.source === 'url' || s.source === 'git-subdir') && githubRepo(s.url)) {
        const r = githubRepo(s.url);
        base = await fromGithub({ ...r, ref: s.ref ?? s.commit ?? r.ref, folder: s.path ?? r.folder });
      } else {
        throw new Error(`Plugin "${entry.name}" comes from ${JSON.stringify(s).slice(0, 120)}; only paths in the marketplace and GitHub repositories can be installed.`);
      }
      if (!existsSync(base)) throw new Error(`The folder of plugin "${entry.name}" is missing in the marketplace.`);
    }
    if (!isPlugin(base)) throw new Error('No plugin there: a plugin has .claude-plugin\\plugin.json, a skills folder or .mcp.json; a marketplace has .claude-plugin\\marketplace.json.');
    const manifest = pluginManifest(base);
    const name = cleanName(manifest.name || entry?.name || basename(base));
    if (!name) throw new Error('The plugin has no name.');
    const target = join(dataRoot, DATA_FILES.plugins, name);
    if (existsSync(target)) {
      if (!replace) throw new Error(`Plugin "${name}" is already installed (${target}); give replace: true to update it.`);
      stop(target);
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    mkdirSync(dirname(target), { recursive: true });
    cpSync(base, target, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)$/.test(p) });
    // A marketplace entry may carry the description and version a plugin folder without plugin.json lacks
    if (entry && !existsSync(join(target, '.claude-plugin', 'plugin.json')) && !existsSync(join(target, 'plugin.json'))) {
      mkdirSync(join(target, '.claude-plugin'), { recursive: true });
      writeFileSync(join(target, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name, description: entry.description ?? '', version: entry.version ?? undefined, mcpServers: entry.mcpServers ?? undefined }, null, 2)}\n`);
    }
    return { installed: { name, folder: target, skills: pluginSkills(target), mcp: Object.keys(pluginMcpServers(target) ?? {}) } };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
