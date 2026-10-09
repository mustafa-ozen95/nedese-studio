/**
 * Update: the installation takes the latest version of the Nedese Studio repository on GitHub.
 *
 * - Local version: a development copy (.git) -> git; else <ai>\version.json (written by the updater: sha, date,
 *   message, file list) -> panel\version.txt (the commit via export-subst in a git archive / GitHub zip) -> unknown.
 * - Check: GET /repos/<repo>/commits/<branch>. The repository is public: the requests need no key.
 * - Apply: the file list of the new version (git tree, one request) is compared with the installed files by git blob
 *   SHA; only the changed and new files are downloaded (raw.githubusercontent.com, no request limit) and written. The
 *   repository carries the installer's tools (setup\tools, ~2.5 GB): they never download unless they change. The old
 *   copy of a changed file goes to update\backup-<old sha>\, a file of the previous version that the new one does not
 *   have is deleted. panel-data (settings, port, keys), outputs, data and models are not in the repository and are not
 *   touched. Not applied while a job runs (except a collection without a limit that gives way: it pauses at shutdown
 *   and resumes at startup).
 * - Automatic (the box in Settings, on by default): one check a day; a new version is applied when no job runs and
 *   the panel restarts. A development copy does not update itself (git pull).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { UserError } from './errors.mjs';

const DAY_MS = 24 * 3600 * 1000;
const SHA = /^[0-9a-f]{40}$/;
// When these files change the Python environments / tools must be renewed too: setup.bat -Models none
const SETUP_FILE = /^setup\/|(^|\/)(uv\.lock|pyproject\.toml|requirements[^/]*\.txt)$/;

/** The installation's version: { sha, dateText, message?, source: 'git' | 'pkg' | 'unknown', files? } */
export function localVersion(aiRoot) {
  if (existsSync(join(aiRoot, '.git'))) {
    try {
      const [sha, dateText] = execFileSync('git', ['-C', aiRoot, 'log', '-1', '--format=%H %cI'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(' ');
      if (SHA.test(sha)) return { sha, dateText: dateText ?? null, source: 'git' };
    } catch {}
    return { sha: null, dateText: null, source: 'git' };
  }
  try {
    const s = JSON.parse(readFileSync(join(aiRoot, 'version.json'), 'utf8'));
    if (SHA.test(s?.sha)) return { sha: s.sha, dateText: s.dateText ?? null, message: s.message ?? null, source: 'pkg', files: Array.isArray(s.files) ? s.files : null };
  } catch {}
  try {
    const [sha, dateText] = readFileSync(join(aiRoot, 'panel', 'version.txt'), 'utf8').trim().split(/\s+/);
    if (SHA.test(sha)) return { sha, dateText: dateText ?? null, source: 'pkg' };
  } catch {}
  return { sha: null, dateText: null, source: 'unknown' };
}

/** Whether a relative path from the repository is safe (does not leave the root, not absolute). */
function safePath(rel) {
  return Boolean(rel) && !rel.startsWith('/') && !/^[a-zA-Z]:/.test(rel) && !rel.split('/').some((p) => p === '..' || p === '');
}

/** The git blob id of a file's content: what the repository tree lists for it. */
export function blobSha(data) {
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

export class Updater {
  /**
   * setting: aiRoot, updateApi?, updateRepo?, updateBranch?, updateTickMs?
   * settingFile: updateAuto, updateLastControl, updateLastResult, saveUpdate()
   * queue: active, pending(), runners. startAgain: after applying (server.mjs).
   */
  constructor({ setting, settingFile, queue, log = () => {}, startAgain = null, retrieve = fetch }) {
    Object.assign(this, { setting, settingFile, queue, log, startAgain, retrieve });
    // The last check's result (in the settings file too: after a restart the top bar knows "Update available")
    this.last = null;
    const s = settingFile?.updateLastResult;
    if (SHA.test(s?.remote?.sha)) {
      const y = localVersion(setting.aiRoot);
      const fresh = s.remote.sha !== y.sha;
      this.last = { dateText: s.dateText ?? null, local: { sha: y.sha, dateText: y.dateText, source: y.source }, remote: s.remote, fresh, setupRequired: fresh && Boolean(s.setupRequired) };
    }
    this.waiting = false; // applying waits for the jobs to finish
    this.applying = false;
    this.timer = null;
  }

  get repo() {
    return this.setting.updateRepo ?? 'mustafa-ozen95/nedese-studio';
  }

  get branch() {
    return this.setting.updateBranch ?? 'main';
  }

  get api() {
    return String(this.setting.updateApi ?? 'https://api.github.com').replace(/\/$/, '');
  }

  /** Where a file's content is downloaded from (not the API: no request limit). */
  get raw() {
    return String(this.setting.updateRaw ?? 'https://raw.githubusercontent.com').replace(/\/$/, '');
  }

  headers() {
    return { Accept: 'application/vnd.github+json', 'User-Agent': 'NedeseStudio-Update', 'X-GitHub-Api-Version': '2022-11-28' };
  }

  /** Whether no job runs (a collection without a limit that gives way does not count: it pauses at shutdown and resumes at startup). */
  noJob() {
    const active = this.queue?.active?.job;
    const obstacle = active && !this.queue.runners?.[active.type]?.yields;
    return !obstacle && !(this.queue?.pending?.() ?? []).length;
  }

  /** The local version is read at most once a minute: the top bar asks on every poll (a process in a git copy). */
  localCached() {
    if (!this.localCache || Date.now() - this.localCache.time > 60000) this.localCache = { time: Date.now(), version: localVersion(this.setting.aiRoot) };
    return this.localCache.version;
  }

  /**
   * For the top bar: { fresh, sha, message, waiting, applying, setupRequired }. The remote version of the last check
   * (kept in the settings file) is compared with the installed version. null in a development copy (git).
   */
  summary() {
    const local = this.localCached();
    if (local.source === 'git') return null;
    const remote = this.last?.remote;
    const fresh = Boolean(remote?.sha) && remote.sha !== local.sha;
    return { fresh, sha: fresh ? remote.sha.slice(0, 7) : null, message: fresh ? remote.message ?? '' : null, waiting: this.waiting, applying: this.applying, setupRequired: fresh && Boolean(this.last.setupRequired) };
  }

  status() {
    const local = localVersion(this.setting.aiRoot);
    return {
      local: { sha: local.sha, dateText: local.dateText, source: local.source },
      development: local.source === 'git',
      auto: this.settingFile?.updateAuto ?? false,
      repo: this.repo,
      lastControl: this.settingFile?.updateLastControl ? new Date(this.settingFile.updateLastControl).toISOString() : null,
      last: this.last,
      waiting: this.waiting,
      applying: this.applying,
    };
  }

  async req(path, { timeMs = 20000 } = {}) {
    let r;
    try {
      r = await this.retrieve(`${this.api}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(timeMs), redirect: 'follow' });
    } catch (e) {
      throw new UserError(`Could not reach GitHub (${e.cause?.code ?? e.message}).`);
    }
    // Without a key GitHub answers 60 requests an hour per address
    if (r.status === 403 || r.status === 429) throw new UserError('GitHub request limit reached: try again in an hour.');
    if (r.status === 404) throw new UserError(`Repository not found on GitHub: ${this.repo}.`);
    if (!r.ok) throw new UserError(`GitHub response: HTTP ${r.status}`);
    return r;
  }

  /** One file of a version, checked against the blob id the tree lists. */
  async rawFile(sha, path, blob) {
    let r;
    try {
      r = await this.retrieve(`${this.raw}/${this.repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'User-Agent': 'NedeseStudio-Update' }, signal: AbortSignal.timeout(300000), redirect: 'follow' });
    } catch (e) {
      throw new UserError(`Could not reach GitHub (${e.cause?.code ?? e.message}).`);
    }
    if (r.status === 429) throw new UserError('GitHub request limit reached: try again in an hour.');
    if (!r.ok) throw new UserError(`Could not download ${path.slice(0, 80)} (HTTP ${r.status}); no files were changed.`);
    const data = Buffer.from(await r.arrayBuffer());
    if (blobSha(data) !== blob) throw new UserError(`Downloaded file does not match the repository (${path.slice(0, 80)}); no files were changed.`);
    return data;
  }

  /** Checks the latest version. Returns: { dateText, local, remote: { sha, dateText, message }, fresh, setupRequired } */
  async check() {
    const local = localVersion(this.setting.aiRoot);
    this.localCache = { time: Date.now(), version: local };
    const j = await (await this.req(`/repos/${this.repo}/commits/${encodeURIComponent(this.branch)}`)).json();
    if (!SHA.test(j?.sha)) throw new UserError('No version in the GitHub response.');
    const remote = { sha: j.sha, dateText: j.commit?.committer?.date ?? null, message: String(j.commit?.message ?? '').split('\n')[0].slice(0, 200) };
    const fresh = local.sha !== remote.sha;
    // When the Python environments / tools changed, setup must run again (the panel cannot do it itself)
    let setupRequired = false;
    if (fresh && local.sha) {
      try {
        const f = await (await this.req(`/repos/${this.repo}/compare/${local.sha}...${remote.sha}`)).json();
        setupRequired = (f.files ?? []).some((x) => SETUP_FILE.test(x.filename ?? ''));
      } catch {}
    }
    this.last = { dateText: new Date().toISOString(), local: { sha: local.sha, dateText: local.dateText, source: local.source }, remote, fresh, setupRequired };
    this.settingFile?.saveUpdate?.({ lastControl: Date.now(), lastResult: { dateText: this.last.dateText, remote, setupRequired } });
    this.log(fresh ? `Update: new version ${remote.sha.slice(0, 7)} (${remote.message})${local.sha ? `, installed ${local.sha.slice(0, 7)}` : ''}.` : `Update: up to date (${remote.sha.slice(0, 7)}).`);
    return this.last;
  }

  /**
   * Applies the new version; deferred while a job runs (waiting). Returns: { message, current?, deferred?, written, same,
   * deleted, setupRequired }. On success startAgain is called (after the response went out).
   */
  async apply() {
    const local = localVersion(this.setting.aiRoot);
    if (local.source === 'git') throw new UserError('This installation is a development copy (git repository): update it with "git pull".');
    if (this.applying) throw new UserError('Update is already being applied.');
    if (!this.noJob()) {
      this.waiting = true;
      // Applied as soon as the queue is empty (checked every few seconds), not at the next 10-minute tick
      // (a user who pressed "Update now" during a job waited up to 10 minutes after it, 10.10.2026).
      if (!this.deferredTimer) {
        this.deferredTimer = setInterval(() => {
          if (this.applying || !this.waiting) return this.clearDeferred();
          if (!this.noJob()) return;
          this.clearDeferred();
          this.apply().catch((e) => this.log(`Deferred update: ${e.message}`));
        }, this.setting.updateDeferredMs ?? 15000);
        this.deferredTimer.unref?.();
      }
      return { deferred: true, message: 'A job is running or queued: the update will be applied when the jobs finish.' };
    }
    this.applying = true;
    try {
      const d = this.last?.fresh && this.last.local.sha === local.sha ? this.last : await this.check();
      if (!d.fresh) {
        this.waiting = false;
        return { current: true, message: `Already up to date (${d.remote.sha.slice(0, 7)}).` };
      }
      // The new version's file list: path + git blob id of every file (one request; a repository this size is not truncated)
      const t = await (await this.req(`/repos/${this.repo}/git/trees/${d.remote.sha}?recursive=1`, { timeMs: 60000 })).json();
      if (t.truncated) throw new UserError('The repository file list is too large for one request; no files were changed.');
      const files = new Map();
      for (const x of t.tree ?? []) {
        if (x.type !== 'blob') continue;
        if (!safePath(x.path)) throw new UserError(`Unsafe path in update package: ${String(x.path).slice(0, 80)}`);
        files.set(x.path, x.sha);
      }
      if (!files.has('panel/server.mjs')) throw new UserError('The repository does not have the expected layout (panel/server.mjs is missing).');
      const root = this.setting.aiRoot;
      // Only the files whose content differs are downloaded; all of them before anything is written
      const changed = new Map();
      let same = 0;
      for (const [rel, blob] of files) {
        const target = join(root, ...rel.split('/'));
        // panel/version.txt holds "$Format:%H %cI$" in the repository (git fills it in a ZIP export, the raw file
        // keeps the placeholder): written with the new version instead of downloaded.
        if (rel === 'panel/version.txt') {
          changed.set(rel, Buffer.from(`${d.remote.sha} ${d.remote.dateText ?? ''}`.trim() + '\n'));
          continue;
        }
        if (existsSync(target) && blobSha(readFileSync(target)) === blob) {
          same++;
          continue;
        }
        changed.set(rel, await this.rawFile(d.remote.sha, rel, blob));
      }
      const backupDir = join(root, 'update', `backup-${local.sha ? local.sha.slice(0, 7) : 'first'}`);
      const backup = (rel, target) => {
        const y = join(backupDir, ...rel.split('/'));
        mkdirSync(dirname(y), { recursive: true });
        copyFileSync(target, y);
      };
      let written = 0;
      for (const [rel, data] of changed) {
        const target = join(root, ...rel.split('/'));
        if (existsSync(target)) backup(rel, target);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(`${target}.updating`, data);
        renameSync(`${target}.updating`, target);
        written++;
      }
      // Files of the previous version that the new one does not have (deleted from the repository); no list on the first update: nothing is deleted
      let deleted = 0;
      for (const rel of local.files ?? []) {
        if (files.has(rel) || !safePath(rel)) continue;
        const target = join(root, ...rel.split('/'));
        if (!existsSync(target)) continue;
        backup(rel, target);
        rmSync(target, { force: true });
        deleted++;
      }
      writeFileSync(join(root, 'version.json'), JSON.stringify({ sha: d.remote.sha, dateText: d.remote.dateText, message: d.remote.message, application: new Date().toISOString(), files: [...files.keys()].sort() }, null, 1));
      this.localCache = null;
      this.waiting = false;
      this.last = { ...d, fresh: false, local: { sha: d.remote.sha, dateText: d.remote.dateText, source: 'pkg' } };
      const message = `Updated: ${d.remote.sha.slice(0, 7)} (${d.remote.message}). ${written} files written${deleted ? `, ${deleted} deleted` : ''}; the panel is restarting.${d.setupRequired ? ' Python environments changed too: run setup.bat -Models none.' : ''}`;
      this.log(message);
      if (this.startAgain) setTimeout(() => this.startAgain(), 1500).unref?.();
      return { message, written, same, deleted, setupRequired: d.setupRequired, version: d.remote };
    } finally {
      this.applying = false;
    }
  }

  /** The timer step: a deferred update when the jobs finish; when automatic, one check a day, a new version applied when no job runs. */
  async tick() {
    if (localVersion(this.setting.aiRoot).source === 'git' || this.applying) return;
    if (this.waiting) {
      if (this.noJob()) await this.apply();
      return;
    }
    if (!this.settingFile?.updateAuto) return;
    if (Date.now() - (this.settingFile.updateLastControl ?? 0) < DAY_MS) return;
    const d = await this.check();
    if (d.fresh) {
      if (this.noJob()) await this.apply();
      else this.waiting = true;
    }
  }

  start() {
    const step = () => this.tick().catch((e) => this.log(`Update check: ${e.message}`));
    this.firstTimer = setTimeout(step, this.setting.updateFirstMs ?? 120000);
    this.timer = setInterval(step, this.setting.updateTickMs ?? 600000);
    this.firstTimer.unref?.();
    this.timer.unref?.();
  }

  clearDeferred() {
    clearInterval(this.deferredTimer);
    this.deferredTimer = null;
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
    this.clearDeferred();
  }
}
