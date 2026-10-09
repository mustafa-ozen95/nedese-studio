/**
 * Update: version detection, the GitHub check (public repository, no key), applying (only the repository's files;
 * settings and outputs are kept), deferring while a job runs, the daily automatic check, the development copy, the
 * top bar summary, the API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Updater, blobSha, localVersion } from '../lib/update.mjs';
import { SettingsFile } from '../lib/settings-file.mjs';
import { createPanel } from './env.mjs';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

const NEW_FILES = {
  'panel/server.mjs': 'new server',
  'panel/same.mjs': 'unchanged',
  'panel/lib/added.mjs': 'new file',
  'panel.bat': 'new bat',
  'panel/version.txt': '$Format:%H %cI$\n', // the raw file keeps git's placeholder: the updater writes the version itself
};

/** The API (commits, compare, the git tree of the version) and the raw file host on one server; { 'path': content } */
async function fakeGithub({ sha = NEW, files = NEW_FILES, compare = ['panel/server.mjs'], status = 200 } = {}) {
  const requests = [];
  const s = createServer((i, y) => {
    requests.push({ url: i.url, authority: i.headers.authorization ?? null });
    const json = (j) => {
      y.writeHead(200, { 'Content-Type': 'application/json' });
      y.end(JSON.stringify(j));
    };
    if (status !== 200) {
      y.writeHead(status, { 'Content-Type': 'application/json' });
      return y.end('{"message":"no"}');
    }
    if (i.url === '/repos/owner/repo/commits/main') return json({ sha, commit: { message: 'New feature\n\ndetail line', committer: { date: '2026-10-06T01:00:00Z' } } });
    if (i.url.startsWith('/repos/owner/repo/compare/')) return json({ files: compare.map((filename) => ({ filename })) });
    if (i.url === `/repos/owner/repo/git/trees/${sha}?recursive=1`) return json({ sha, truncated: false, tree: Object.entries(files).map(([path, v]) => ({ path, type: 'blob', mode: '100644', sha: blobSha(Buffer.from(v)), size: v.length })) });
    const raw = decodeURIComponent(i.url).match(new RegExp(`^/owner/repo/${sha}/(.+)$`));
    if (raw && files[raw[1]] !== undefined) {
      y.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return y.end(Buffer.from(files[raw[1]]));
    }
    y.writeHead(404);
    y.end();
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  return { api: `http://127.0.0.1:${s.address().port}`, requests, close: () => s.close() };
}

/** An installation (from a package): the old version, a user setting and an output */
function setupSetup() {
  const root = mkdtempSync(join(tmpdir(), 'update-'));
  mkdirSync(join(root, 'panel', 'lib'), { recursive: true });
  writeFileSync(join(root, 'panel', 'server.mjs'), 'old server');
  writeFileSync(join(root, 'panel', 'same.mjs'), 'unchanged');
  writeFileSync(join(root, 'panel', 'removed.mjs'), 'deleted from the repository');
  writeFileSync(join(root, 'panel.bat'), 'old bat');
  mkdirSync(join(root, 'outputs', 'job1'), { recursive: true });
  writeFileSync(join(root, 'outputs', 'job1', 'video.mp4'), 'user video');
  writeFileSync(join(root, 'version.json'), JSON.stringify({ sha: OLD, files: ['panel/server.mjs', 'panel/same.mjs', 'panel/removed.mjs', 'panel.bat'] }));
  const settingFile = new SettingsFile(join(root, 'panel-data', 'settings.json'));
  settingFile.data.customPort = 9999; // the user's own setting: the update must not touch it
  settingFile.save();
  return { root, settingFile };
}

const freeQueue = () => ({ active: null, pending: () => [], runners: { data: { yields: true }, image: {} } });
const setting = (root, api) => ({ aiRoot: root, updateApi: api, updateRaw: api, updateRepo: 'owner/repo' });

test('version: development copy (git), version.json written by the updater, version.txt in the package (export-subst), unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'version-'));
  assert.deepEqual(localVersion(root), { sha: null, dateText: null, source: 'unknown' });
  mkdirSync(join(root, 'panel'));
  writeFileSync(join(root, 'panel', 'version.txt'), '$Format:%H %cI$\n');
  assert.equal(localVersion(root).source, 'unknown', 'if the placeholder remains (copy outside a package) the version is unknown');
  writeFileSync(join(root, 'panel', 'version.txt'), `${NEW} 2026-10-06T01:00:00+03:00\r\n`);
  assert.deepEqual(localVersion(root), { sha: NEW, dateText: '2026-10-06T01:00:00+03:00', source: 'pkg' });
  writeFileSync(join(root, 'version.json'), JSON.stringify({ sha: OLD, dateText: 't', files: ['a'] }));
  assert.equal(localVersion(root).sha, OLD, 'version.json first');
  mkdirSync(join(root, '.git'));
  assert.equal(localVersion(root).source, 'git', 'a git repository is a development copy');
});

test('update check: the public repository is asked without a key; finds the new version and whether setup must run again', async () => {
  const gh = await fakeGithub({ compare: ['panel/server.mjs', 'training/sidestep/uv.lock'] });
  const { root, settingFile } = setupSetup();
  try {
    const g = new Updater({ setting: setting(root, gh.api), settingFile, queue: freeQueue() });
    const d = await g.check();
    assert.deepEqual([d.fresh, d.remote.sha, d.remote.message, d.local.sha, d.setupRequired], [true, NEW, 'New feature', OLD, true]);
    assert.ok(gh.requests.length >= 2 && gh.requests.every((x) => x.authority === null), 'no Authorization header');
    assert.ok(settingFile.updateLastControl > Date.now() - 5000, 'the last check is saved');
    assert.equal(g.status().repo, 'owner/repo');
    assert.equal('hasKey' in g.status(), false);
    assert.equal(new Updater({ setting: { aiRoot: root }, settingFile, queue: freeQueue() }).repo, 'mustafa-ozen95/nedese-studio', 'the default repository');
  } finally {
    gh.close();
  }
});

test('update check: a missing repository and the request limit give clear errors', async () => {
  for (const [status, error] of [[404, /^Repository not found on GitHub: owner\/repo\.$/], [403, /^GitHub request limit reached/], [500, /^GitHub response: HTTP 500$/]]) {
    const gh = await fakeGithub({ status });
    const { root, settingFile } = setupSetup();
    try {
      await assert.rejects(new Updater({ setting: setting(root, gh.api), settingFile, queue: freeQueue() }).check(), { message: error });
    } finally {
      gh.close();
    }
  }
});

test('update is applied: only repository files are written, deleted ones are removed (with backup), settings and outputs are preserved, the panel restarts', async () => {
  const gh = await fakeGithub();
  const { root, settingFile } = setupSetup();
  let started;
  const again = new Promise((ok) => (started = ok));
  try {
    const g = new Updater({ setting: setting(root, gh.api), settingFile, queue: freeQueue(), startAgain: () => started(true) });
    const r = await g.apply();
    assert.deepEqual([r.written, r.same, r.deleted], [4, 1, 1], r.message);
    assert.match(r.message, /^Updated: bbbbbbb \(New feature\)\. 4 files written, 1 deleted; the panel is restarting\.$/);
    assert.equal(readFileSync(join(root, 'panel', 'server.mjs'), 'utf8'), 'new server');
    assert.match(readFileSync(join(root, 'panel', 'version.txt'), 'utf8'), new RegExp(`^${NEW} 2026-10-06T01:00:00Z\\n$`), 'version.txt holds the new version, not the placeholder');
    assert.equal(readFileSync(join(root, 'panel', 'lib', 'added.mjs'), 'utf8'), 'new file');
    assert.ok(!existsSync(join(root, 'panel', 'removed.mjs')), 'file deleted from the repository was removed');
    assert.equal(readFileSync(join(root, 'update', 'backup-aaaaaaa', 'panel', 'server.mjs'), 'utf8'), 'old server');
    assert.equal(readFileSync(join(root, 'update', 'backup-aaaaaaa', 'panel', 'removed.mjs'), 'utf8'), 'deleted from the repository');
    assert.equal(readFileSync(join(root, 'outputs', 'job1', 'video.mp4'), 'utf8'), 'user video');
    const settings = JSON.parse(readFileSync(join(root, 'panel-data', 'settings.json'), 'utf8'));
    assert.deepEqual([settings.customPort, settings.update.lastResult.remote.sha], [9999, NEW], 'user settings are preserved');
    const s = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
    assert.deepEqual([s.sha, s.files], [NEW, ['panel.bat', 'panel/lib/added.mjs', 'panel/same.mjs', 'panel/server.mjs', 'panel/version.txt']]);
    assert.equal(localVersion(root).sha, NEW);
    assert.equal(await Promise.race([again, new Promise((ok) => setTimeout(() => ok(false), 4000))]), true, 'panel was restarted');
    // A second time: already up to date
    const r2 = await g.apply();
    assert.equal(r2.current, true, r2.message);
  } finally {
    gh.close();
  }
});

test('update: deferred while a job is running, the scheduler applies it when the job finishes; unlimited collection does not block it; a development copy does not update itself', async () => {
  const gh = await fakeGithub();
  const { root, settingFile } = setupSetup();
  try {
    const queue = freeQueue();
    queue.active = { job: { type: 'image' } };
    const g = new Updater({ setting: setting(root, gh.api), settingFile, queue });
    const r = await g.apply();
    assert.deepEqual([r.deferred, g.waiting], [true, true]);
    assert.equal(readFileSync(join(root, 'panel', 'server.mjs'), 'utf8'), 'old server', 'files are not touched while a job is running');
    await g.tick();
    assert.equal(readFileSync(join(root, 'panel', 'server.mjs'), 'utf8'), 'old server', 'the scheduler also waits while a job is running');
    queue.active = { job: { type: 'data' } }; // an unlimited collection that gives way: pauses at shutdown, resumes at startup
    await g.tick();
    assert.equal(readFileSync(join(root, 'panel', 'server.mjs'), 'utf8'), 'new server');
    assert.equal(g.waiting, false);

    // A development copy (git): not applied, the scheduler does not ask GitHub
    const { root: root2, settingFile: s2 } = setupSetup();
    mkdirSync(join(root2, '.git'));
    const g2 = new Updater({ setting: setting(root2, gh.api), settingFile: s2, queue: freeQueue() });
    await assert.rejects(g2.apply(), /development copy \(git repository\)/);
    const once = gh.requests.length;
    await g2.tick();
    assert.equal(gh.requests.length, once, 'no automatic check in a development copy');
  } finally {
    gh.close();
  }
});

test('automatic update: checks once a day; does not check when disabled; a package with an unsafe path changes no files', async () => {
  const gh = await fakeGithub();
  const { root, settingFile } = setupSetup();
  try {
    const g = new Updater({ setting: setting(root, gh.api), settingFile, queue: freeQueue() });
    assert.equal(settingFile.updateAuto, true, 'on by default');
    settingFile.saveUpdate({ auto: false, lastControl: 0 });
    await g.tick();
    assert.equal(gh.requests.length, 0, 'no check when disabled');
    settingFile.saveUpdate({ auto: true, lastControl: Date.now() - 3600 * 1000 });
    await g.tick();
    assert.equal(gh.requests.length, 0, '24 hours have not passed since the last check');
    settingFile.saveUpdate({ lastControl: Date.now() - 25 * 3600 * 1000 });
    await g.tick();
    assert.equal(readFileSync(join(root, 'panel', 'server.mjs'), 'utf8'), 'new server', 'checks and applies after 24 hours');
  } finally {
    gh.close();
  }
  const bad = await fakeGithub({ files: { 'panel/server.mjs': 'bad', '../outside.txt': 'escape' } });
  const { root: root3, settingFile: s3 } = setupSetup();
  try {
    const g3 = new Updater({ setting: setting(root3, bad.api), settingFile: s3, queue: freeQueue() });
    await assert.rejects(g3.apply(), /Unsafe path/);
    assert.equal(readFileSync(join(root3, 'panel', 'server.mjs'), 'utf8'), 'old server');
    assert.equal(localVersion(root3).sha, OLD);
  } finally {
    bad.close();
  }
});

test('the repository ships no read key: the update needs none', () => {
  assert.equal(existsSync(new URL('../update-key.txt', import.meta.url)), false);
});

test('top bar summary: the last check stays in the settings file, the new version is known after a restart; it disappears once installed; absent in a development copy', async () => {
  const gh = await fakeGithub({ compare: ['panel/server.mjs', 'setup/setup.ps1'] });
  const { root, settingFile } = setupSetup();
  const setup = () => new Updater({ setting: setting(root, gh.api), settingFile: new SettingsFile(join(root, 'panel-data', 'settings.json')), queue: freeQueue() });
  try {
    const g = new Updater({ setting: setting(root, gh.api), settingFile, queue: freeQueue() });
    assert.deepEqual(g.summary(), { fresh: false, sha: null, message: null, waiting: false, applying: false, setupRequired: false }, 'no badge without a check');
    await g.check();
    assert.deepEqual(g.summary(), { fresh: true, sha: 'bbbbbbb', message: 'New feature', waiting: false, applying: false, setupRequired: true });
    // The panel opened again (the settings file is read again): the new version is known without asking GitHub
    const once = gh.requests.length;
    const g2 = setup();
    assert.deepEqual([g2.summary().fresh, g2.summary().sha, g2.status().last.fresh, g2.status().last.remote.sha], [true, 'bbbbbbb', true, NEW]);
    assert.equal(gh.requests.length, once, 'no request at startup');
    // Once installed (version.json has the new sha) the badge disappears, after a restart too
    await g2.apply();
    assert.equal(g2.summary().fresh, false);
    assert.deepEqual([setup().summary().fresh, setup().status().last.fresh], [false, false]);
    // A development copy (git): no badge
    mkdirSync(join(root, '.git'));
    assert.equal(setup().summary(), null);
  } finally {
    gh.close();
  }
});

test('API: update status, check, settings, /status summary, prompt translation box', async () => {
  const gh = await fakeGithub();
  const p = await createPanel({ server: true, setupUpdater: ({ setting: s, settingFile, queue }) => new Updater({ setting: { ...s, ...setting(setupSetup().root, gh.api) }, settingFile, queue }) });
  const req = async (path, method = 'GET', body) => {
    const r = await fetch(`${p.address}/api/v1${path}`, { method: method, headers: { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, j: await r.json() };
  };
  try {
    const other = await req('/update', 'PATCH', { repo: 'someone/else' });
    assert.equal(other.code, 400, 'only auto can be changed through the API');
    assert.match(other.j.error, /^No update setting to change/);
    const a = await req('/update', 'PATCH', { auto: false });
    assert.deepEqual([a.code, a.j.repo, a.j.auto, a.j.message], [200, 'owner/repo', false, 'Daily update check off.'], JSON.stringify(a.j));
    const settings = await req('/settings');
    assert.deepEqual([settings.j.update.repo, settings.j.translatePrompt], ['owner/repo', true]);
    assert.equal((await req('/status')).j.update.fresh, false, 'no badge before the check');
    const d = await req('/update/check', 'POST');
    assert.equal(d.code, 200, JSON.stringify(d.j));
    // lib/service.mjs builds this message: only the version and commit message are pinned
    assert.match(d.j.message, /^[A-Za-z ]*version[A-Za-z ]*: bbbbbbb \(New feature\)\.$/i, d.j.message);
    assert.deepEqual((await req('/status')).j.update, { fresh: true, sha: 'bbbbbbb', message: 'New feature', waiting: false, applying: false, setupRequired: false });
    const o = await req('/update', 'PATCH', { auto: true });
    assert.equal(o.j.message, 'Daily update check on: checked once a day, a new version is installed automatically.');
    const c = await req('/settings', 'PATCH', { translatePrompt: false });
    assert.deepEqual([c.code, c.j.message, p.settingFile.translatePrompt], [200, 'Prompt translation is off: prompts will be sent as written.', false]);
    const { makePromptEnglish, setPromptTranslation } = await import('../lib/prompt-translate.mjs');
    setPromptTranslation(() => p.settingFile.translatePrompt);
    assert.deepEqual(await makePromptEnglish('Kedi kılıç sallasın'), { prompt: 'Kedi kılıç sallasın', translated: false, closed: true });
    setPromptTranslation(true);
  } finally {
    gh.close();
    await p.close();
  }
});
