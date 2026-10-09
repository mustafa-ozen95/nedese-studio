/**
 * The agent's tools. Measure (the user, 08.10.2026): "what should an agent be able to do today" — every panel operation
 * (API), read/write/edit/search/delete files, run commands (foreground/background), SSH, web search/reading, downloads,
 * looking at images, sub-agents, lasting memory, scheduled tasks, MCP servers and skills.
 *
 * Each tool: { name, description, params (JSON Schema), full (only in a full-access session: from this computer or with
 * the API key), risk(input) ('danger' | 'change' | null; the chat's approval mode decides whether the user is asked),
 * run(input, b) -> string | { text, extra } }. A tool's output reaches the model truncated (the context is small).
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { moveToRecycleBin } from '../deletion.mjs';
import { killTree } from '../process.mjs';
import { runFfmpeg } from '../ffmpeg.mjs';
import { USER_AGENT, searchUrl, searchResults, decodeEntities } from '../data-collection.mjs';
import { githubSource, installSkill, loadSkill } from './skills.mjs';
import { githubRepo, installPlugin, pluginMcpServers } from './plugins.mjs';
import { progressText } from './mcp.mjs';
import { SEARCH_SERVICES, serviceList, serviceSearch } from './web-search.mjs';
import { searchImages } from './image-search.mjs';
import { DATA_FILES } from '../data-files.mjs';
import { Browser, browserPath } from '../browser.mjs';
import { normalizeSource } from '../jobs/common.mjs';
import { fileText, readableKind } from '../attachments.mjs';

export const OUTPUT_LIMIT = 8000;

/** Downloads a GitHub archive and extracts it (install_skill, install_plugin). */
function githubFetch(b) {
  return {
    download: async (url, file) => {
      const response = await fetch(checkWeb(b, url), { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }, redirect: 'follow', signal: b.signal ?? undefined });
      if (!response.ok || !response.body) throw new Error(`GitHub: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
    },
    // Run in the archive's folder with a bare file name: GNU tar (Git for Windows) reads "C:\…" as a remote host
    tar: (file, folder) => runProgram('tar', ['-xzf', relative(folder, file)], b.signal, folder),
  };
}

/** A long output keeps its start and its end (the error is usually at the end). */
export function truncate(s, n = OUTPUT_LIMIT) {
  s = String(s ?? '');
  if (s.length <= n) return s;
  const startedAt = Math.floor(n * 0.35);
  return `${s.slice(0, startedAt)}\n… [${s.length - n} characters trimmed] …\n${s.slice(s.length - (n - startedAt))}`;
}

/**
 * API response for the model: long lists are cut to their first items and the total is stated. A plain character cut
 * made the model count only the visible items (measured 08.10.2026: 121 gallery items answered as "9").
 */
export function apiResultText(r, limit = 6000) {
  const full = JSON.stringify(r, null, 1);
  if (full.length <= limit) return full;
  const notes = [];
  const cut = (v, path, keep) => {
    if (Array.isArray(v)) {
      if (v.length > keep) notes.push(`${path || 'response'}: ${v.length} items in total, first ${keep} shown`);
      return v.slice(0, keep).map((x, i) => cut(x, `${path}[${i}]`, keep));
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x, path ? `${path}.${k}` : k, keep)]));
    return v;
  };
  // List items with their short fields only (id, type, status, dates…): more items fit (measured 08.10.2026: job
  // records are large, "last 3 jobs" got 2 of 128 and the model could not answer)
  let shortened = false;
  const brief = (v) => {
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => (y === null || typeof y !== 'object') && !(typeof y === 'string' && y.length > 160))) : brief(x)));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, brief(x)]));
    return v;
  };
  let text = '';
  for (const [keep, short] of [[20, false], [10, false], [20, true], [10, true], [5, true], [2, true]]) {
    notes.length = 0;
    text = JSON.stringify(cut(short ? brief(r) : r, '', keep), null, 1);
    shortened = short;
    if (text.length <= limit) break;
  }
  const head = notes.length || shortened ? `[${[...notes.slice(0, 4), ...(notes.length > 4 ? [`${notes.length - 4} more lists cut`] : []), ...(shortened ? ['list items shortened to their short fields (one in full: its own route, e.g. GET /jobs/<id>)'] : [])].join('; ')}; filter or page the request for more]\n` : '';
  return `${head}${truncate(text, limit)}`;
}

/** Shell commands that may not be undone (approval is asked). */
const DESTRUCTIVE = /\b(Remove-Item|rm|rmdir|rd|del|erase|Clear-Content|Clear-RecycleBin|Format-Volume|Clear-Disk|diskpart|mkfs|dd\s+if=|shutdown|Stop-Computer|Restart-Computer|reg\s+delete|Remove-ItemProperty|git\s+push|git\s+reset\s+--hard|git\s+clean|git\s+checkout\s+--|git\s+branch\s+-D|Uninstall-\w+|winget\s+uninstall|choco\s+uninstall|pip\s+uninstall|npm\s+uninstall|DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|Stop-Process|taskkill|kill\s+-9|systemctl\s+(stop|disable)|docker\s+(rm|rmi|system\s+prune))\b/i;
export const isDestructiveCommand = (k) => DESTRUCTIVE.test(String(k ?? '')) || /(^|[\s;&|(])format(\.com)?\s+[a-z]:/i.test(String(k ?? ''));

/** Panel API requests that cannot be undone or that affect the panel. */
/**
 * The program and arguments of a local MCP server. The model often writes the whole line into command ("uvx
 * mcp-server-time", seen 10.10.2026: three failed starts before it split it): without args, a command with spaces
 * that is not an existing path is split like a command line (quotes keep a part together).
 */
export function mcpCommand(command, args) {
  const list = (Array.isArray(args) ? args : []).map(String);
  const line = String(command).trim();
  if (list.length || !/\s/.test(line) || existsSync(line)) return { command: line, args: list };
  const parts = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return { command: parts[0], args: parts.slice(1) };
}

export function isDestructiveApi(method, path) {
  const y = String(method ?? 'GET').toUpperCase();
  const p = String(path ?? '');
  if (y === 'GET') return false;
  if (y === 'DELETE' || y === 'PATCH') return true;
  return /\/(sil|delete)$|rotate-key|anahtar-yenile|update\/(uygula|apply)|comfy\/(stop|durdur)/.test(p);
}

/**
 * Approval modes of a chat (user request 08.10.2026: "automatic, allow edits and manual; changeable mid-task"):
 * manual asks before every action that changes something, edits asks only before irreversible ones (deleting,
 * destructive commands, settings changes), auto never asks. A tool's risk(input) is 'danger', 'change' or null.
 */
export const APPROVAL_MODES = ['manual', 'edits', 'auto'];
export const needsApproval = (mode, risk) => Boolean(risk) && mode !== 'auto' && (mode === 'manual' || risk === 'danger');

// Commands that only read (Manual mode runs them without asking). Script blocks, subexpressions and redirections into
// files are never read-only; every part of a chain or pipe must start with one of these.
const READ_ONLY = new Set(['get-childitem', 'gci', 'dir', 'ls', 'get-content', 'gc', 'cat', 'type', 'get-item', 'gi', 'get-itemproperty', 'gp', 'test-path', 'resolve-path', 'get-location', 'gl', 'pwd', 'cd', 'chdir', 'set-location', 'sl', 'pushd', 'popd', 'get-command', 'gcm', 'where', 'which', 'get-process', 'gps', 'ps', 'tasklist', 'get-service', 'gsv', 'get-date', 'date', 'get-host', 'get-psdrive', 'get-volume', 'get-disk', 'get-ciminstance', 'get-computerinfo', 'get-netipaddress', 'get-nettcpconnection', 'get-filehash', 'get-acl', 'get-module', 'get-help', 'help', 'man', 'get-member', 'gm', 'select-object', 'select', 'sort-object', 'measure-object', 'measure', 'group-object', 'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'out-string', 'out-host', 'select-string', 'sls', 'findstr', 'grep', 'rg', 'head', 'tail', 'wc', 'du', 'df', 'stat', 'realpath', 'basename', 'dirname', 'uniq', 'convertto-json', 'convertfrom-json', 'write-output', 'write-host', 'echo', 'hostname', 'whoami', 'systeminfo', 'ver', 'tree', 'ipconfig', 'netstat', 'uname', 'nvidia-smi']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'version', 'help']);
const LISTING = { branch: /^(-a|-r|-v|-vv|-l|--all|--remotes|--list|--show-current)$/, tag: /^(-l|--list)$/, remote: /^-v$/, stash: /^list$/ };
const VERSION_ONLY = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'conda', 'git', 'ffmpeg', 'nvcc', 'cmake', 'java', 'go', 'cargo', 'rustc', 'dotnet', 'winget', 'choco', 'ollama', 'pwsh', 'powershell']);

export function isReadOnlyCommand(command) {
  const s = String(command ?? '').trim();
  if (!s || /[{}`]|\$\(|@\(|\b(iex|invoke-expression|invoke-command|start-process)\b/i.test(s)) return false;
  const rest = s.replace(/\d?>&\d|\d?>\s*(\$null|nul)\b/gi, ' ');
  if (/>/.test(rest)) return false;
  return rest.split(/\|\||&&|[;|&\n]/).every((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const name = words[0].replace(/^["']|["']$/g, '').toLowerCase().replace(/\.exe$/, '');
    const args = words.slice(1);
    if (name === 'nvidia-smi') return !args.some((a) => /^(-pl|--power-limit|-ac|-rac|-r|--gpu-reset|-pm|-e|-c|-am|-lgc|-rgc|-lmc|-rmc|-mig)\b/i.test(a));
    if (READ_ONLY.has(name)) return !args.some((a) => /^-?-?(o|output|outfile)(=|$)/i.test(a) && name !== 'get-childitem');
    if (name === 'git') {
      const a = args.filter((x, i) => !(x === '--no-pager' || x === '-C' || args[i - 1] === '-C'));
      if (a.some((x) => /^--output\b/.test(x))) return false;
      if (GIT_READ.has(a[0])) return true;
      if (LISTING[a[0]]) return a.slice(1).every((x) => LISTING[a[0]].test(x));
      return a.length === 1 && /^(--version|-v)$/.test(a[0]);
    }
    if (['pip', 'pip3'].includes(name) && ['list', 'show', 'freeze'].includes(args[0])) return true;
    if (['npm', 'pnpm'].includes(name) && ['ls', 'list', 'view'].includes(args[0])) return true;
    return VERSION_ONLY.has(name) && args.length === 1 && /^(--version|-v|-V|version)$/.test(args[0]);
  });
}

export const commandRisk = (command) => (isDestructiveCommand(command) ? 'danger' : isReadOnlyCommand(command) ? null : 'change');

/** Panel API: deleting, settings and updates are 'danger'; reading, generation jobs and text writers need no approval. */
export function panelApiRisk(method, path) {
  const y = String(method ?? 'GET').toUpperCase();
  if (y === 'GET') return null;
  if (isDestructiveApi(y, path)) return 'danger';
  const p = String(path ?? '').split('?')[0].replace(/^\/api\/v1/, '');
  return y === 'POST' && /^\/(jobs|jobs\/[^/]+\/retry|write-scenes|write-lyrics|update\/check)\/?$/.test(p) ? null : 'change';
}

/*
 * Always allow (user request 08.10.2026): "Always allow" on an approval card keeps a rule with the chat, and the calls it
 * covers run without asking from then on: a command by the programs it starts (git, npm…; every part of a chain needs
 * one, a part that only reads none), a panel API call by its method and route ("POST /jobs/{id}/cancel"), any other
 * tool by its name. An irreversible call (risk 'danger') is never covered: it always asks.
 */
const COMMAND_TOOLS = new Set(['run_command', 'run_ssh']);

/**
 * The programs a command starts (lower case, without folder and extension; the parts that only read left out), or null
 * when that cannot be told from its text: a program run through a variable, a script block, a subexpression or
 * Invoke-Expression could be anything.
 */
export function commandPrograms(command) {
  const s = String(command ?? '').replace(/\d?>&\d/g, ' ').trim();
  if (!s || /[{}`]|\$\(|@\(|\b(iex|invoke-expression|invoke-command|start-process|start-job|eval|exec|xargs)\b/i.test(s)) return null;
  const programs = [];
  for (const raw of s.split(/\|\||&&|[;|\n]/)) {
    // PowerShell's call operator; a lone & elsewhere (cmd's separator, a background job) is not read
    let part = raw.trim().replace(/^&\s*/, '');
    if (!part) continue;
    if (part.includes('&')) return null;
    // $env:X = 1 sets a variable for what follows; another $ runs or sets something unknown
    if (/^\$env:\w+\s*=/i.test(part)) continue;
    if (part.startsWith('$')) return null;
    part = part.replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, '');
    if (isReadOnlyCommand(part)) continue;
    const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(part);
    const name = String(m?.[1] ?? m?.[2] ?? m?.[3] ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
    if (!/^[\w.+-]+$/.test(name)) return null;
    if (!programs.includes(name)) programs.push(name);
  }
  return programs;
}

/** The panel API route a panel_api call goes to (its method and path pattern), or null. */
function apiRoute(routes, method, path) {
  const y = String(method ?? 'GET').toUpperCase();
  const p = String(path ?? '').split('?')[0].replace(/^\/api\/v1/, '');
  const sub = p.startsWith('/') ? p : `/${p}`;
  return (routes ?? []).find((r) => r.method === y && r.pattern?.test(sub)) ?? null;
}

/** The rules "Always allow" would keep for this call, or null when it cannot be allowed for good. */
export function allowRules(tool, input, routes, risk) {
  if (!risk || risk === 'danger') return null;
  if (COMMAND_TOOLS.has(tool)) {
    const programs = commandPrograms(input?.command);
    return programs?.length ? programs.map((program) => ({ tool, program })) : null;
  }
  if (tool === 'panel_api') {
    const r = apiRoute(routes, input?.method, input?.path);
    return r ? [{ tool, method: r.method, path: r.path }] : null;
  }
  return [{ tool }];
}

export const sameRule = (a, b) => a.tool === b.tool && (a.program ?? null) === (b.program ?? null) && (a.method ?? null) === (b.method ?? null) && (a.path ?? null) === (b.path ?? null);

/** True when the rules cover this call (every rule it would need is there); never for an irreversible one. */
export function allowedBy(rules, tool, input, routes, risk) {
  if (!rules?.length || !risk || risk === 'danger') return false;
  const wanted = allowRules(tool, input, routes, risk);
  return Boolean(wanted) && wanted.every((w) => rules.some((r) => sameRule(r, w)));
}

/** A rule as PATCH /chat/{id} allow gives it, written one way (program lower case, method upper case), or null. */
export function cleanRule(r) {
  if (!r || typeof r !== 'object' || typeof r.tool !== 'string' || !/^[\w.-]{1,100}$/.test(r.tool)) return null;
  if (COMMAND_TOOLS.has(r.tool)) {
    const program = String(r.program ?? '').toLowerCase();
    return /^[\w.+-]{1,80}$/.test(program) ? { tool: r.tool, program } : null;
  }
  if (r.tool === 'panel_api') {
    const method = String(r.method ?? '').toUpperCase();
    const path = String(r.path ?? '');
    return ['POST', 'PATCH', 'DELETE'].includes(method) && /^\/[\w./{}-]{0,200}$/.test(path) ? { tool: r.tool, method, path } : null;
  }
  return { tool: r.tool };
}

export function parsePath(b, path) {
  if (!path) throw new Error('Path is required.');
  const y = String(path).replace(/^~(?=[\\/]|$)/, process.env.USERPROFILE ?? process.env.HOME ?? '~');
  return isAbsolute(y) ? resolve(y) : resolve(b.cwd, y);
}

/**
 * The file read_file reads: a path as parsePath takes it, or a panel source the chat names ("upload/…" an attachment,
 * "job/<id>/<file>", "/file/…") when no such file is in the working folder.
 */
export function readablePath(b, path) {
  const local = parsePath(b, path);
  if (existsSync(local) || !/^\/?(file\/)?(upload|job)\//.test(String(path))) return local;
  const own = sourcePath(b.setting, path);
  return own && existsSync(own) ? own : local;
}

/** Text for search and matching: lower case, Turkish dotless i and diacritics folded. */
export const searchFold = (t) => String(t ?? '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export const searchWords = (t) => searchFold(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12);

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

/**
 * Headless Edge/Chrome shared by the agents for web search and for pages that need scripts (one tab; calls take
 * turns; closes after 2 idle minutes). Plain HTTP search is not usable from here: Bing and DuckDuckGo answer requests
 * without a browser session with challenges or with results unrelated to the query (measured 08.10.2026: "weather in
 * Bursa today" -> Tarsus pages, "Node.js latest LTS version" -> Spotify), while the same queries in the browser gave
 * the expected pages in ~1.5 s (browser start 0.6 s).
 */
export class WebBrowser {
  constructor({ enabled = true, idleMs = 120000, log = () => {} } = {}) {
    Object.assign(this, { enabled, idleMs, log });
    this.browser = null;
    this.queue = Promise.resolve();
    this.timer = null;
  }

  get available() {
    return this.enabled && Boolean(browserPath());
  }

  use(fn, signal = null) {
    const run = this.queue.then(async () => {
      if (signal?.aborted) throw new Error('Stopped.');
      clearTimeout(this.timer);
      if (!this.browser?.isOpen) {
        await this.browser?.close().catch(() => {});
        this.browser = new Browser({ userAgent: BROWSER_UA, height: 1600, log: this.log });
        await this.browser.open();
      }
      try {
        return await fn(this.browser);
      } finally {
        this.timer = setTimeout(() => this.close(), this.idleMs);
        this.timer.unref?.();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async close() {
    clearTimeout(this.timer);
    const b = this.browser;
    this.browser = null;
    await b?.close().catch(() => {});
  }
}

// Result lists in the browser (title, address, snippet); Bing links are its ck/a redirects (target in the u parameter)
const SEARCH_PAGES = {
  duckduckgo: {
    url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    pick: `[...document.querySelectorAll('article[data-testid=result]')].map((r) => { const a = r.querySelector('[data-testid=result-title-a]'); return a && { title: a.textContent.trim(), url: a.href, summary: (r.querySelector('[data-result=snippet]')?.innerText ?? '').trim() }; }).filter(Boolean)`,
  },
  bing: {
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    pick: `[...document.querySelectorAll('#b_results li.b_algo')].map((r) => { const a = r.querySelector('h2 a'); return a && { title: a.textContent.trim(), url: a.href, summary: (r.querySelector('.b_caption p, p[class*=b_lineclamp], .b_paractl')?.innerText ?? '').trim() }; }).filter(Boolean)`,
  },
};

export function bingTarget(url) {
  const u = /^https:\/\/www\.bing\.com\/ck\/a\?[^#]*[?&]u=a1([^&]+)/.exec(String(url))?.[1];
  if (!u) return url;
  try {
    return Buffer.from(u.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return url;
  }
}

export async function browserSearch(br, engine, query) {
  const e = SEARCH_PAGES[engine];
  await br.goto(e.url(query), { waitMs: 12000, settleMs: 600 });
  let list = [];
  for (let i = 0; i < 8 && !list.length; i++) {
    list = (await br.evaluate(e.pick)) ?? [];
    if (!list.length) await wait(400);
  }
  return list.map((s) => ({ ...s, url: bingTarget(s.url) })).filter((s) => /^https?:\/\//.test(s.url) && !/duckduckgo\.com\/y\.js|bing\.com\/(aclick|ck\/a)/.test(s.url));
}

// Well-known sources (reference, news, weather, finance, software); official sites are recognised by their domain
const KNOWN_SOURCES = /(^|\.)(wikipedia\.org|wikimedia\.org|britannica\.com|bbc\.(com|co\.uk)|reuters\.com|apnews\.com|aa\.com\.tr|trthaber\.com|ntv\.com\.tr|bloomberght\.com|bloomberg\.com|ft\.com|nytimes\.com|theguardian\.com|dw\.com|euronews\.com|accuweather\.com|weather\.com|meteoblue\.com|yr\.no|timeanddate\.com|wunderground\.com|windy\.com|metoffice\.gov\.uk|xe\.com|wise\.com|investing\.com|doviz\.com|tradingview\.com|github\.com|gitlab\.com|stackoverflow\.com|npmjs\.com|pypi\.org|nodejs\.org|python\.org|mozilla\.org|microsoft\.com|apple\.com|google\.com|android\.com|nvidia\.com|huggingface\.co|arxiv\.org|nature\.com|who\.int|europa\.eu|un\.org)$/i;
// Domains spam and copy sites favour; a name made of words and numbers (havadurumu15gunluk) also counts against
const LOW_TRUST_TLD = /\.(xyz|top|click|online|site|icu|buzz|club|work|loan|win|bid|stream|gq|ml|cf|tk|ga|rest|monster|cyou|sbs|cfd)$/i;

/** 2 official (government, education, international bodies), 1 well-known, 0 unknown, -1 low trust. */
export function sourceTrust(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 0;
  }
  if (/(^|\.)(gov|edu|mil|int|k12|pol|bel|tsk)(\.[a-z]{2})?$/.test(host) || /\.gov\.[a-z]{2}$/.test(host)) return 2;
  if (KNOWN_SOURCES.test(host)) return 1;
  if (LOW_TRUST_TLD.test(host) || /[a-z]{3,}\d{2,}[a-z]{3,}/.test(host.split('.')[0])) return -1;
  return 0;
}

const TRUST_TAGS = { 2: ' [official]', 1: ' [well-known]', 0: '', [-1]: ' [low trust]' };

/** Results that share at least one query word (3+ letters); all of them if none does. */
export function relevantResults(list, query) {
  const words = searchWords(query).filter((w) => w.length >= 3);
  if (!words.length) return list;
  const kept = list.filter((s) => words.some((w) => searchFold(`${s.title} ${s.summary} ${s.url}`).includes(w)));
  return kept.length ? kept : list;
}

/** Lines of a page that match the query best (query words, numbers), in page order, up to limit characters. */
export function pageExcerpt(text, query, limit = 500) {
  const words = searchWords(query).filter((w) => w.length >= 3);
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()).filter((l) => l.length > 2 && l.length < 400);
  const scored = lines.map((l, i) => ({ i, l, score: words.filter((w) => searchFold(l).includes(w)).length * 2 + (/\d/.test(l) ? 1 : 0) })).filter((x) => x.score >= 2);
  const chosen = [];
  let length = 0;
  for (const x of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (length + x.l.length > limit) continue;
    chosen.push(x);
    length += x.l.length + 3;
  }
  return chosen.sort((a, b) => a.i - b.i).map((x) => x.l).join(' · ') || null;
}

/** Language hint for the HTTP search fallback: Turkish letters or common Turkish words -> tr, otherwise en. */
export const guessLanguage = (q) => (/[çğıöşüİ]|\b(hava|nasil|nedir|ne kadar|bugun|icin|fiyat|kuru|haber|nerede)\b/i.test(`${q} ${searchFold(q)}`) ? 'tr' : 'en');

// Turkish typed without Turkish letters ("emin misin", "goster") and common English words
const TURKISH_WORDS = /\b(mi|mu|misin|musun|misiniz|bir|bu|su|ne|neden|niye|nasil|nedir|nerede|kac|yok|evet|hayir|tamam|lutfen|merhaba|selam|tesekkurler|sagol|abi|knk|kanka|bana|beni|sana|seni|icin|gibi|daha|cok|ama|degil|olur|olsun|goster|bul|yap|getir|cevir|fotograf|resim|hava|bugun|yarin|haber|fiyat)\b/;
const ENGLISH_WORDS = /\b(the|and|is|are|was|what|how|why|when|where|who|can|could|would|please|show|find|make|give|you|your|me|my|this|that|with|for|from|of|it|do|does|yes|thanks|hello|hi)\b/;

/**
 * The language of a chat message: Turkish letters or Turkish words -> tr, English words -> en; a message with neither
 * ("pinterst", a link) is in the language of the message before it (Gemma answered Hasan's "pinterst" and "emin misin"
 * in English, 08.10.2026).
 */
export function messageLanguage(text, before = null) {
  const t = String(text ?? '');
  const folded = searchFold(t);
  if (/[çğıöşüİ]/i.test(t) || TURKISH_WORDS.test(folded)) return 'tr';
  if (ENGLISH_WORDS.test(folded)) return 'en';
  return before ?? guessLanguage(t);
}

// An image address with a slash after its extension (search results list i.redd.it/x.gif/; that address answers 404 with
// a "not found" PNG) loses the slash
const imageAddress = (u) => String(u ?? '').trim().replace(/(\.(?:jpe?g|png|webp|gif))\/+(?=$|\?)/i, '$1');

/**
 * A picture from the web: { data, ext, url }. A page gives its main picture. A picture that is not there (404/410, not a
 * picture, a site's "removed" stand-in) throws an error marked gone.
 */
async function fetchPicture(b, address) {
  const u = checkWeb(b, imageAddress(address));
  const gone = (m) => Object.assign(new Error(m), { gone: true });
  // asked like a browser's <img>: with text/html in Accept, i.imgur.com answered with its page instead of the picture
  const get = (to) => fetch(to, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }, redirect: 'follow', signal: b.signal ? AbortSignal.any([b.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  const check = (resp, to) => {
    if ([404, 410].includes(resp.status)) throw gone(`Not found (HTTP ${resp.status}): ${to}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${to}`);
  };
  let r = await get(u);
  check(r, u.href);
  if (/html/i.test(r.headers.get('content-type') ?? '')) {
    const first = pageImages((await r.text()).slice(0, 5 * 2 ** 20), r.url)[0];
    if (!first) throw gone(`${u.href} is a page without a picture.`);
    r = await get(checkWeb(b, first));
    check(r, first);
  }
  const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[type];
  if (!ext) {
    await r.body?.cancel().catch(() => {});
    throw gone(`Not a picture (${type || 'unknown type'}): ${r.url}`);
  }
  // a site's stand-in for a missing picture (i.imgur.com sends an invented or deleted address to removed.png)
  const landed = new URL(r.url).pathname;
  if (landed !== new URL(u.href).pathname && /removed|not[-_]?found|missing|placeholder|\/404\b/i.test(landed)) {
    await r.body?.cancel().catch(() => {});
    throw gone(`The picture is not there (the site answered with its stand-in ${r.url}): ${u.href}`);
  }
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > 20 * 2 ** 20) throw new Error(`The picture is too big (${Math.round(data.length / 2 ** 20)} MB; at most 20 MB).`);
  return { data, ext, url: r.url };
}

/** Does the picture show what was asked? The vision model answers yes (true) or no (false); null when it cannot tell. */
/**
 * The picture search in English, by the chat's own model: the image sources match English best and the vision check
 * reads it plainly ("kedi" ranked a Wikimedia photo named Zemo_Kedi_entrance first, 08.10.2026). As given when the
 * model does not answer.
 */
export async function englishQuery(b, want) {
  if (!b.askText || !want) return want;
  try {
    const a = String(await b.askText('Translate the picture search below into short English search words: what the picture should show. Return only the words: no quotes, no explanation. Keep proper names. If it is already English, return it unchanged.', want));
    const words = a.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^["'“]+|["'”.]+$/g, '').trim();
    return words && words.length <= 200 ? words : want;
  } catch (e) {
    if (b.signal?.aborted) throw e;
    return want;
  }
}

async function pictureShows(b, picture, want) {
  if (!b.askImage) return null;
  const file = join(tmpdir(), `nedese-picture-${process.pid}-${Date.now()}${picture.ext}`);
  try {
    writeFileSync(file, picture.data);
    // the thing itself: a road sign reading "ZEMO KEDI" (a Georgian village) passed as a "kedi" (cat) photo (08.10.2026)
    const a = String(await b.askImage(await imageData(b, file), `Does this picture show: ${JSON.stringify(want)}? It must show the thing itself; a word, sign, label or name that only spells it does not count. Answer only yes or no.`));
    return /^\W*(yes|evet)\b/i.test(a) ? true : /^\W*(no|hay[ıi]r)\b/i.test(a) ? false : null;
  } catch {
    // no vision encoder, no ffmpeg: the picture is taken unchecked
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

const IMAGE_ADDRESS = /https?:\/\/[^\s"'<>()\\]+?\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>()\\]*)?(?=[\s"'<>()\\]|$)|https?:\/\/i\.redd\.it\/[\w.-]+/gi;
const NOT_A_PICTURE = /icon|logo|sprite|avatar|emoji|pixel|blank|badge|spinner|favicon|placeholder|loading|tracking|\/ads?\//i;

/**
 * The pictures of a page (fetch_web lists them for show_image): og/twitter image, <img> (src, data-src, the largest
 * srcset), image addresses in JSON or text; no icons, logos, SVG or tiny images. At most 10, absolute addresses.
 */
export function pageImages(raw, base, html = true) {
  const s = String(raw ?? '');
  const found = [];
  const add = (u) => {
    if (!u || /^data:/i.test(u) || /\.svg(\?|$)/i.test(u) || NOT_A_PICTURE.test(u)) return;
    try {
      const href = new URL(imageAddress(decodeEntities(u.trim())), base).href;
      if (/^https?:/.test(href) && !found.includes(href)) found.push(href);
    } catch {}
  };
  if (html) {
    for (const m of s.matchAll(/<meta\b[^>]*(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]*>/gi)) add(/content=["']([^"']+)/i.exec(m[0])?.[1]);
    for (const m of s.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      const size = (name) => Number(new RegExp(`\\b${name}=["']?(\\d+)`, 'i').exec(tag)?.[1] ?? 0);
      if ((size('width') && size('width') < 100) || (size('height') && size('height') < 100)) continue;
      const set = /\bsrcset=["']([^"']+)/i.exec(tag)?.[1];
      const largest = set?.split(',').map((p) => p.trim().split(/\s+/)).sort((a, b2) => parseFloat(b2[1] ?? 0) - parseFloat(a[1] ?? 0))[0]?.[0];
      add(largest ?? /\bdata-src=["']([^"']+)/i.exec(tag)?.[1] ?? /\bsrc=["']([^"']+)/i.exec(tag)?.[1]);
    }
  }
  for (const m of s.replace(/\\\//g, '/').replace(/&amp;/g, '&').matchAll(IMAGE_ADDRESS)) add(m[0]);
  return found.slice(0, 10);
}

async function readExcerpt(b, url, query) {
  try {
    checkWeb(b, url);
    const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*', 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!r.ok || !/html/i.test(r.headers.get('content-type') ?? '')) return null;
    const raw = Buffer.from(await r.arrayBuffer()).subarray(0, 3 * 2 ** 20).toString('utf8');
    return pageExcerpt(htmlText(raw, r.url).text, query);
  } catch {
    return null;
  }
}

const customNetwork = (host) => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|\[?f[cd])/i.test(host);

/** Runs a program to the end (no shell); rejects with its last output lines when it fails. */
function runProgram(command, args, signal, cwd = undefined) {
  return new Promise((ok, fail) => {
    const p = spawn(command, args, { windowsHide: true, signal: signal ?? undefined, cwd });
    let output = '';
    p.stdout.on('data', (d) => (output = `${output}${d}`.slice(-4000)));
    p.stderr.on('data', (d) => (output = `${output}${d}`.slice(-4000)));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(output) : fail(new Error(`${command} exited with ${code}: ${output.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

function checkWeb(b, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid address: ${url}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https URLs.');
  // A session opened from a network client (without full access) cannot send requests to the panel's local network
  if (!b.full && customNetwork(u.hostname)) throw new Error('Local network addresses are reachable only from a chat opened from this computer or with an API key.');
  return u;
}

// common named entities that data collection's entity decoder does not know (Turkish and Western European letters, punctuation)
const ENTITY_EXTRA = { nbsp: ' ', ccedil: 'ç', ouml: 'ö', uuml: 'ü', scedil: 'ş', gbreve: 'ğ', inodot: 'ı', idot: 'İ', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', szlig: 'ß', auml: 'ä', euro: '€', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·', times: '×', deg: '°' };
const entityParseFull = (s) => decodeEntities(s).replace(/&([A-Za-z]+);/g, (m, a) => {
  const k = a.toLowerCase();
  const v = ENTITY_EXTRA[k];
  if (v === undefined) return m;
  return a[0] === a[0].toUpperCase() && /^[a-zçöüşğı]$/.test(v) ? v.toLocaleUpperCase('tr') : v;
});

/** HTML -> okunur metin (baslik, paragraflar, baglantilar [metin](adres)). */
export function htmlText(html, base) {
  let s = String(html);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim() ?? '';
  s = s.replace(/<(script|style|noscript|svg|head|template|title)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, m) => {
    const text = m.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return ' ';
    let address = decodeEntities(h);
    try {
      address = new URL(address, base).href;
    } catch {}
    return ` [${text}](${address}) `;
  });
  s = s.replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article|\/header|\/footer|\/pre)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '\n- ').replace(/<h(\d)[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `);
  s = entityParseFull(s.replace(/<[^>]+>/g, ' '));
  s = s.split('\n').map((x) => x.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
  return { title: entityParseFull(title), text: s };
}

/* ── Kabuk ─────────────────────────────────────────────────────────────── */

/** Git for Windows' bash, if the computer has it (System32\bash.exe is the WSL launcher, not a shell). */
export function bashPath() {
  const candidates = ['ProgramFiles', 'ProgramFiles(x86)'].map((k) => process.env[k] && join(process.env[k], 'Git', 'bin', 'bash.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && !/[\\/]System32[\\/]?$/i.test(dir)) candidates.push(join(dir, 'bash.exe'));
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

export function shellCommand(shell, command) {
  if (shell === 'cmd') return ['cmd.exe', ['/d', '/s', '/c', `chcp 65001>nul & ${command}`], { windowsVerbatimArguments: true }];
  // bash only when the computer has one; otherwise the command runs in PowerShell
  if (shell === 'bash') {
    const bash = bashPath();
    if (bash) return [bash, ['-lc', command], {}];
  }
  // PowerShell 5.1 ciktisi OEM kod sayfasinda: UTF-8'e cevrilir (Turkce karakterler bozulmasin)
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';$PSDefaultParameterValues['Out-File:Encoding']='utf8';${command}`], {}];
}

/**
 * Environment of the agent's commands: the bundled Python (<ai>\python) and Node first on PATH (user 08.10.2026: Python
 * in the project, no version trouble); git never waits for a password, an editor or a pager (it would hang the tool).
 */
export function commandEnv(setting) {
  const own = ['python', join('python', 'Scripts'), 'node'].map((d) => join(setting.aiRoot, d)).filter((d) => existsSync(d));
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', FORCE_COLOR: '0', [key]: [...own, process.env[key] ?? ''].join(delimiter) };
}

/**
 * A command's output as the model reads it: without colour and cursor codes, a line rewritten in place (spinner,
 * progress bar: carriage return or "cursor to column 1") only as its last state. Seen 10.10.2026: "npx skills add"
 * returned every spinner frame with the codes left in it.
 */
export function terminalText(s) {
  return String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[\d*G/g, '\r')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.split('\r').findLast((p) => p.trim()) ?? '' : line))
    .join('\n');
}

/** Starts a command process; its output is collected. Returns the record { output, code, start, proc, done (Promise) }. */
export function startProcess({ command, args, options = {}, cwd, env }) {
  const record = { output: '', code: null, start: Date.now(), read: 0 };
  const s = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, ...options });
  record.proc = s;
  const add = (p) => {
    record.output += p;
    // Memory limit: at most 2 MB is kept (the start is cut)
    if (record.output.length > 2_000_000) {
      const at = record.output.length - 1_500_000;
      record.output = record.output.slice(at);
      record.read = Math.max(0, record.read - at);
    }
  };
  s.stdout?.setEncoding('utf8');
  s.stderr?.setEncoding('utf8');
  s.stdout?.on('data', add);
  s.stderr?.on('data', add);
  s.stdin?.end();
  record.done = new Promise((ok) => {
    s.on('error', (e) => {
      add(`\n[could not start: ${e.message}]`);
      record.code = -1;
      ok();
    });
    s.on('exit', (code) => {
      record.code = code ?? -1;
      setTimeout(ok, 1500);
    });
    s.on('close', (code) => {
      record.code ??= code ?? -1;
      ok();
    });
  });
  return record;
}

async function frontPlanCommand(b, record, durationSec) {
  const stop = () => record.proc.pid && killTree(record.proc.pid);
  b.signal?.addEventListener('abort', stop, { once: true });
  let timeout = false;
  const z = setTimeout(() => {
    timeout = true;
    stop();
  }, durationSec * 1000);
  const aborted = new Promise((ok) => b.signal?.addEventListener('abort', ok, { once: true }));
  await Promise.race([record.done, aborted]);
  clearTimeout(z);
  b.signal?.removeEventListener('abort', stop);
  if (b.signal?.aborted) throw new Error('Stopped.');
  const duration = ((Date.now() - record.start) / 1000).toFixed(1);
  const startedAt = timeout ? `[${durationSec} s limit reached, stopped. If it waited for input (a password, an editor, a yes/no), run it without asking: keys or tokens, --yes, -m "message"; a long task: back_plan: true]` : `[exit code ${record.code}, ${duration} s]`;
  return `${startedAt}\n${truncate(terminalText(record.output).trimEnd() || '(no output)')}`;
}

/* ── Gorsel -> data URL ───────────────────────────────────────────────── */

async function imageData(b, path, timeSec = null) {
  const jpg = join(tmpdir(), `agent-look-${process.pid}-${Date.now()}.jpg`);
  try {
    if (!b.setting.ffmpeg) throw new Error('ffmpeg is missing; the image cannot be downscaled.');
    const video = /\.(mp4|mov|mkv|webm|avi|gif)$/i.test(path);
    await runFfmpeg(b.setting.ffmpeg, ['-y', ...(video && timeSec !== null ? ['-ss', String(timeSec)] : []), '-i', path, '-vf', "scale='min(1024,iw)':-2", '-frames:v', '1', '-q:v', '3', jpg], { signal: b.signal });
    return `data:image/jpeg;base64,${readFileSync(jpg).toString('base64')}`;
  } finally {
    rmSync(jpg, { force: true });
  }
}

/** Panel kaynagi ("job/<id>/<file>", "upload/<file>", "/file/...") -> diskteki yol. */
export function sourcePath(setting, source) {
  const k = normalizeSource(source).replace(/^\/?file\//, '').replace(/^\//, '');
  const p = k.split('/');
  const safe = (x) => /^[\w.-]+$/.test(x) && x !== '..';
  if (p[0] === 'job' && p.length >= 3 && p.slice(1).every(safe)) return join(setting.outputRoot, ...p.slice(1));
  if (p[0] === 'upload' && p.length === 2 && safe(p[1])) return join(setting.outputRoot, 'uploads', p[1]);
  return null;
}

/**
 * The panel's own file behind an address ("/file/job/<id>/<file>", "job/<id>/<file>", "/file/upload/<file>", or the
 * same path on any of the panel's addresses): its /file/ address when it is on disk, otherwise null.
 */
function ownFile(b, address) {
  let path = String(address ?? '').trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return null;
    }
  }
  const rel = path.replace(/^\/?file\//, '').replace(/^\//, '');
  if (!/^(job\/[\w.-]+\/[\w.-]+|upload\/[\w.-]+)$/.test(rel)) return null;
  const disk = sourcePath(b.setting, rel);
  return disk && existsSync(disk) ? `/file/${rel}` : null;
}

/* ── Araclar ──────────────────────────────────────────────────────────── */

const object = (properties, required = []) => ({ type: 'object', properties: properties, required: required });
const text = (description) => ({ type: 'string', description: description });
const integer = (description) => ({ type: 'integer', description: description });
const logic = (description) => ({ type: 'boolean', description: description });

export const TOOLS = [
  {
    name: 'panel_api',
    group: 'panel',
    description: 'Calls the panel\'s own API (under /api/v1): create a job (image, video, voice, music, film, 3D, editing, training, data collection), job status, gallery, voices, models, settings… Creating a job: POST /jobs, body is a FLAT object { "type": "image", "prompt": "...", "ratio": "16:9" } (field names as in the example bodies that came when panel_api was loaded; no nesting under "fields"). Other routes and fields: api_document.',
    params: object({ method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'] }, path: text('e.g. "/jobs", "/jobs/<id>", "/gallery?type=image" (without the /api/v1 prefix)'), body: { type: 'object', description: 'JSON body (POST/PATCH); for a job, flat { type, ...fields }' } }, ['method', 'path']),
    risk: (g) => panelApiRisk(g.method, g.path),
    async run(g, b) {
      let body = g.body;
      // Model api_document ciktisini kopyalayip alanlari "fields" altina yuvalayabiliyor (olculdu 08.10.2026): duzlestir
      if (body && typeof body === 'object' && body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) {
        const { fields, ...remaining } = body;
        body = { ...fields, ...remaining };
      }
      const r = await b.api(g.method ?? 'GET', g.path, body);
      const extra = {};
      if (r?.job?.id) extra.job = r.job.id;
      return { text: apiResultText(r), extra };
    },
  },
  {
    name: 'api_document',
    group: 'panel',
    description: 'Details of a panel API route (description, body fields, example) or the input fields of a job type. Give path or job_type.',
    params: object({ path: text('Route, e.g. "/jobs" or "/write-scenes"'), job_type: text('image, video, voice, music, film, model3d, edit, training, data…') }),
    async run(g, b) {
      if (g.job_type) {
        const t = b.jobTypes[g.job_type];
        if (!t) return `No such job type. Types: ${Object.keys(b.jobTypes).join(', ')}`;
        return truncate(JSON.stringify({ type: g.job_type, name: t.name, description: t.description, fields: t.fields.map((a) => ({ name: a.name, type: a.type, required: a.required || undefined, defaultValue: a.defaultValue, options: a.options, description: a.description })), example: t.example }));
      }
      const path = String(g.path ?? '').replace(/^\/api\/v1/, '').split('?')[0];
      const r = b.routes.filter((x) => x.path === path || x.pattern?.test(path));
      if (!r.length) return `No such route: ${path}`;
      return truncate(JSON.stringify(r.map((x) => ({ method: x.method, path: x.path, summary: x.summary, description: x.description, params: x.params, body: x.body, response: x.response }))));
    },
  },
  {
    name: 'wait_job',
    group: 'panel',
    description: 'Waits for a panel job (image, video…) to finish; when done returns the status, error and output files (source = input for another job, path = file on disk). For long jobs, max_min can be increased.',
    params: object({ id: text('Job ID'), max_min: integer('Wait limit (minutes, default 60)') }, ['id']),
    async run(g, b) {
      const last = Date.now() + Math.max(1, Number(g.max_min) || 60) * 60000;
      let job = b.jobSummary(g.id);
      let lastStage = '';
      while (['waiting', 'running'].includes(job.status) || (job.status === 'paused' && job.yielded)) {
        if (b.signal?.aborted) throw new Error('Stopped.');
        if (Date.now() > last) return `Still ${job.status} (${job.progress?.percent ?? '?'}%, ${job.progress?.stage ?? ''}). You can call wait_job again.`;
        const a = `${job.progress?.stage ?? ''} ${job.progress?.percent ?? ''}`;
        if (a !== lastStage) b.advance?.(`${g.id}: ${job.progress?.stage ?? job.status}${job.progress?.percent !== undefined ? ` ${job.progress.percent}%` : ''}`);
        lastStage = a;
        await new Promise((ok) => setTimeout(ok, b.pollingMs ?? 2000));
        job = b.jobSummary(g.id);
      }
      const outputs = job.outputs.map((c) => ({ type: c.type, source: c.source, url: c.url, path: sourcePath(b.setting, c.source) }));
      // the lines that show the outputs in the answer (a finished dog image was sent to show_image, refused as an address,
      // then fetched from 127.0.0.1 into a copy: four extra steps, 08.10.2026)
      const shown = job.status === 'done' ? job.outputs.filter((c) => c.url).slice(0, 8).map((c, i) => (c.type === 'image' ? `![${c.type} ${i + 1}](${c.url})` : `[${c.type} ${i + 1}](${c.url})`)) : [];
      const show = shown.length ? `\nPut these lines in your answer and the outputs show in the chat (no other tool needed):\n${shown.join('\n')}` : '';
      return { text: truncate(JSON.stringify({ id: job.id, status: job.status, error: job.error, duration: job.duration, outputs })) + show, extra: { job: job.id, outputs: job.outputs.map((c) => ({ type: c.type, url: c.url, previewUrl: c.previewUrl })) } };
    },
  },
  {
    name: 'look_image',
    group: 'panel',
    description: 'Looks at an image or a frame of a video and answers the question (to check a generated result: does it match the request, are there errors).',
    params: object({ source: text('"job/<id>/<file>", "upload/<file>" or a file path on disk'), question: text('What to ask'), time_sec: { type: 'number', description: 'Which second of the video (default 0)' } }, ['source', 'question']),
    async run(g, b) {
      let path = sourcePath(b.setting, g.source);
      if (!path) {
        if (!b.full) throw new Error('Only panel sources (job/…, upload/…).');
        path = parsePath(b, g.source);
      }
      if (!existsSync(path)) throw new Error(`File not found: ${g.source}`);
      return b.askImage(await imageData(b, path, g.time_sec ?? 0), String(g.question));
    },
  },
  {
    name: 'add_upload',
    group: 'panel',
    description: 'Copies an image/music/recording from disk into the panel uploads; the returned source ("upload/<file>") can be used as input for jobs (e.g. the source image of a video).',
    full: true,
    params: object({ path: text('File path'), type: { type: 'string', enum: ['image', 'music', 'record', 'data'], description: 'Default: from the extension' } }, ['path']),
    async run(g, b) {
      const path = parsePath(b, g.path);
      if (!existsSync(path)) throw new Error(`File not found: ${path}`);
      const type = g.type ?? (/\.(png|jpe?g|webp)$/i.test(path) ? 'image' : /\.(mp3|wav|m4a|ogg|flac)$/i.test(path) ? 'music' : 'data');
      return truncate(JSON.stringify(await b.addUpload(path, type)));
    },
  },
  {
    name: 'list_file',
    core: true,
    description: 'Files and folders in a folder (size, date). deep: subfolders too (at most 500 entries).',
    full: true,
    params: object({ path: text('Folder (default: the working folder)'), deep: logic('Subfolders too'), pattern: text('Name filter, e.g. "*.mjs"') }),
    async run(g, b) {
      const root = parsePath(b, g.path ?? '.');
      const re = g.pattern ? new RegExp(`^${String(g.pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : null;
      const lines = [];
      const walk = (d, depth) => {
        let names = [];
        try {
          names = readdirSync(d, { withFileTypes: true });
        } catch (e) {
          lines.push(`[could not read ${d}: ${e.code}]`);
          return;
        }
        for (const a of names) {
          if (lines.length >= 500) return;
          const y = join(d, a.name);
          if (a.isDirectory()) {
            if (!re) lines.push(`${relative(root, y)}\\`);
            if (g.deep && depth < 8 && !['node_modules', '.git', '__pycache__', '.venv', 'venv'].includes(a.name)) walk(y, depth + 1);
          } else if (!re || re.test(a.name)) {
            let s = null;
            try {
              s = statSync(y);
            } catch {}
            lines.push(`${relative(root, y)}  ${s ? `${s.size} B  ${s.mtime.toISOString().slice(0, 16)}` : ''}`);
          }
        }
      };
      walk(root, 0);
      return `${root}\n${lines.join('\n') || '(empty)'}${lines.length >= 500 ? '\n… (cut off at 500 entries)' : ''}`;
    },
  },
  {
    name: 'read_file',
    outputLimit: 12000,
    core: true,
    description: 'Reads a text file with line numbers (for large files, in chunks with start_line/line_count). PDF, DOCX, XLSX and PPTX are read as their text (page, sheet and slide markers on lines of their own). A chat attachment is read by its source ("upload/…").',
    full: true,
    params: object({ path: text('File'), start_line: integer('Starts at 1'), line_count: integer('Default 400') }, ['path']),
    async run(g, b) {
      const path = readablePath(b, g.path);
      const st = statSync(path);
      if (st.isDirectory()) throw new Error('This is a folder; use list_file.');
      let lines;
      let about = '';
      if (readableKind(path) === 'document') {
        // the same lines as the attachment's text in the message, so the line it says to go on from is this one
        const t = fileText(path);
        if (t.empty) return `${path}: ${t.type}; no text could be read from it (a scanned or encrypted document has none).`;
        lines = t.lines;
        about = ` (${t.type}${t.unitCount ? `, ${t.unitCount} ${t.unit}${t.unitCount === 1 ? '' : 's'}` : ''}; its text)`;
      } else {
        if (st.size > 50 * 2 ** 20) throw new Error(`File is too large (${Math.round(st.size / 2 ** 20)} MB); read it in parts with run_command.`);
        const raw = readFileSync(path);
        const utf16 = raw[0] === 0xff && raw[1] === 0xfe;
        if (!utf16 && raw.subarray(0, 8000).includes(0)) return `Binary file (${st.size} B); cannot be read.`;
        lines = (utf16 ? raw.subarray(2).toString('utf16le') : raw.toString('utf8')).split(/\r?\n/);
      }
      const startedAt = Math.min(Math.max(1, Number(g.start_line) || 1), lines.length);
      const n = Math.max(1, Math.min(2000, Number(g.line_count) || 400));
      // as many lines as fit the output (the note on what comes next goes first, so it is never cut)
      const part = [];
      let size = 0;
      for (let i = startedAt - 1; i < Math.min(lines.length, startedAt - 1 + n); i++) {
        const line = `${i + 1}\t${lines[i].length > 500 ? `${lines[i].slice(0, 500)}…` : lines[i]}`;
        if (part.length && size + line.length > 11000) break;
        part.push(line);
        size += line.length + 1;
      }
      const last = startedAt - 1 + part.length;
      const next = last < lines.length ? `; more: read_file with start_line=${last + 1}` : '';
      return truncate(`${path}${about}: lines ${startedAt}-${last} of ${lines.length}${next}\n${part.join('\n')}`, 12000);
    },
  },
  {
    name: 'write_file',
    core: true,
    description: 'Writes the file with the given content (creates it and its folders if missing; overwrites if it exists). A long file (more than ~300 lines) goes in parts: the first part, then append: true for each next one.',
    full: true,
    risk: () => 'change',
    params: object({ path: text('File'), text: text('Content as a plain string (the whole file, or the next part with append)'), append: logic('Add to the end of the file instead of replacing it') }, ['path', 'text']),
    aliases: { content: 'text' },
    async run(g, b) {
      const path = parsePath(b, g.path);
      const existed = existsSync(path);
      const before = existed ? readFileSync(path) : null;
      const content = g.append && before ? `${before.toString('utf8')}${String(g.text ?? '')}` : String(g.text ?? '');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
      const edit = b.recordEdit?.(path, before, content) ?? null;
      return { text: `${existed ? (g.append ? 'Appended' : 'Overwritten') : 'Created'}: ${path} (${Buffer.byteLength(content)} B${edit ? `, +${edit.added} -${edit.removed} lines` : ''})`, extra: edit ? { edit } : undefined };
    },
  },
  {
    name: 'edit_file',
    core: true,
    description: 'Replaces text in a file: the old text must match the file EXACTLY (including whitespace) and occur in one place (everywhere if all: true).',
    full: true,
    risk: () => 'change',
    params: object({ path: text('File'), search: text('Text to replace (exactly as in the file)'), replace: text('Replacement text'), all: logic('Everywhere it occurs') }, ['path', 'search', 'replace']),
    aliases: { old: 'search', fresh: 'replace' },
    async run(g, b) {
      const path = parsePath(b, g.path);
      const bytes = readFileSync(path);
      const s = bytes.toString('utf8');
      if (s.includes('\uFFFD') && !Buffer.from(s, 'utf8').equals(bytes)) throw new Error('The file is not UTF-8 text (another code page or binary): edit_file would damage it. Convert it first (run_command) or write it anew with write_file.');
      const old = String(g.search);
      let number = s.split(old).length - 1;
      // A line ending difference (a CRLF file, an LF old text)
      let e = old;
      if (!number && s.includes('\r\n')) {
        e = old.replace(/\r?\n/g, '\r\n');
        number = s.split(e).length - 1;
      }
      if (!number) throw new Error('Old text not found in the file (it must match exactly; check with read_file first).');
      if (number > 1 && !g.all) throw new Error(`Old text occurs in ${number} places; give a longer/unique text or all: true.`);
      const fresh = e !== old ? String(g.replace).replace(/\r?\n/g, '\r\n') : String(g.replace);
      const after = g.all ? s.split(e).join(fresh) : s.replace(e, () => fresh);
      writeFileSync(path, after, 'utf8');
      const edit = b.recordEdit?.(path, bytes, after) ?? null;
      return { text: `Edited: ${path} (${g.all ? number : 1} places${edit ? `, +${edit.added} -${edit.removed} lines` : ''})`, extra: edit ? { edit } : undefined };
    },
  },
  {
    name: 'search_file',
    core: true,
    description: 'Searches file contents with a regular expression (like grep); matching lines as file:line.',
    full: true,
    params: object({ pattern: text('Regular expression (JavaScript)'), path: text('Folder or file'), file_pattern: text('e.g. "*.mjs"'), large_small: logic('Case sensitive (default no)') }, ['pattern']),
    async run(g, b) {
      const root = parsePath(b, g.path ?? '.');
      const re = new RegExp(String(g.pattern), g.large_small ? '' : 'i');
      const name = g.file_pattern ? new RegExp(`^${String(g.file_pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i') : null;
      const result = [];
      let scanned = 0;
      let stopped = false;
      // folders that are not code to search: dependencies, environments, models, outputs, the panel's own big tools
      const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'outputs', 'models', 'ComfyUI_windows_portable', 'site-packages']);
      const skipPaths = new Set(['python', 'node', 'llm', 'logs', 'panel-data'].map((d) => resolve(b.setting.aiRoot, d).toLowerCase()));
      const scan = async (y) => {
        if (result.length >= 200) return;
        if (scanned >= 20000) {
          stopped = true;
          return;
        }
        let st;
        try {
          st = statSync(y);
        } catch {
          return;
        }
        if (st.isDirectory()) {
          if (y !== root && (SKIP.has(basename(y)) || skipPaths.has(resolve(y).toLowerCase()))) return;
          let names = [];
          try {
            names = readdirSync(y);
          } catch {
            return;
          }
          for (const a of names) await scan(join(y, a));
          return;
        }
        if ((name && !name.test(basename(y))) || st.size > 2 * 2 ** 20) return;
        scanned += 1;
        // let the panel breathe (events, Stop) during a big search
        if (scanned % 200 === 0) await new Promise((ok) => setImmediate(ok));
        if (b.signal?.aborted) throw new Error('Stopped.');
        const raw = readFileSync(y);
        if (raw.subarray(0, 4000).includes(0)) return;
        raw.toString('utf8').split(/\r?\n/).forEach((s, i) => {
          if (result.length < 200 && re.test(s)) result.push(`${relative(root, y) || basename(y)}:${i + 1}: ${s.trim().slice(0, 300)}`);
        });
      };
      await scan(root);
      const more = stopped ? `\n… search stopped after ${scanned} files: give a narrower path or a file_pattern` : '';
      return truncate(result.length ? result.join('\n') + (result.length >= 200 ? '\n… (cut off at 200 matches)' : '') + more : `No matches (${scanned} files scanned)${more}.`);
    },
  },
  {
    name: 'delete_file',
    group: 'files',
    description: 'Moves a file or folder to the recycle bin (can be restored).',
    full: true,
    risk: () => 'danger',
    params: object({ path: text('File or folder') }, ['path']),
    async run(g, b) {
      const path = parsePath(b, g.path);
      if (!existsSync(path)) throw new Error(`Not found: ${path}`);
      if (resolve(path) === resolve(b.setting.aiRoot) || resolve(path).length <= 3) throw new Error('This folder cannot be deleted.');
      await moveToRecycleBin(path);
      return `Moved to the recycle bin: ${path}`;
    },
  },
  {
    name: 'run_command',
    core: true,
    description: 'Runs a shell command (PowerShell by default; cmd or bash too). Writing and running programs, tests, installs (pip/npm/winget), git, builds all go through this. For long-running ones (server, large download/setup) use back_plan: true → returns an id; you are told when it finishes (do not poll command_output in a loop).',
    full: true,
    risk: (g) => commandRisk(g.command),
    params: object({ command: text('Command'), shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'] }, cwd: text('Working folder'), duration_sec: integer('Time limit (default 120, max 3600)'), back_plan: logic('Run in the background'), notify: logic('With back_plan: wake this chat when it finishes (default true)') }, ['command']),
    async run(g, b) {
      const [command, args, options] = shellCommand(g.shell ?? 'powershell', String(g.command));
      const cwd = g.cwd ? parsePath(b, g.cwd) : b.cwd;
      if (!existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
      b.writeLog?.({ tool: 'command', command: g.command, cwd });
      const record = startProcess({ command, args, options, cwd, env: commandEnv(b.setting) });
      if (g.back_plan) {
        const id = b.processes.add(record, String(g.command), b.chat?.id ?? null);
        // the chat's background list shows it while it runs and how it ended
        b.manager?.backgroundChanged?.(b.chat?.id);
        record.done.then(() => {
          record.ended = Date.now();
          b.manager?.backgroundChanged?.(record.chat);
        });
        await new Promise((ok) => setTimeout(ok, 1500));
        if (record.code !== null) {
          record.reported = true;
          return `Finished at once: ${id} (exit code ${record.code}, ${((Date.now() - record.start) / 1000).toFixed(1)} s)\n${truncate(terminalText(record.output).trimEnd() || '(no output)')}`;
        }
        // the chat is woken when it ends (user request 09.10.2026: like Claude Code's background commands)
        const notify = g.notify !== false && Boolean(b.notifyWhenDone);
        if (notify) b.notifyWhenDone(id, record);
        return `Started in the background: ${id} (pid ${record.proc.pid}). First output:\n${truncate(terminalText(record.output), 2000) || '(none yet)'}\n${notify ? 'You will be told when it finishes: do not wait for it or poll command_output in a loop. ' : ''}Read its output with command_output, stop it with stop_command.`;
      }
      return frontPlanCommand(b, record, Math.min(3600, Math.max(1, Number(g.duration_sec) || 120)));
    },
  },
  {
    name: 'command_output',
    group: 'commands',
    description: 'New output and status of a background command; if wait_sec is given, waits that long (or until it finishes).',
    full: true,
    params: object({ id: text('Background command id'), wait_sec: integer('Maximum wait (s)') }, ['id']),
    async run(g, b) {
      const k = b.processes.get(g.id);
      if (g.wait_sec) await Promise.race([k.done, new Promise((ok) => setTimeout(ok, Math.min(3600, Number(g.wait_sec)) * 1000))]);
      const fresh = terminalText(k.output.slice(k.read));
      k.read = k.output.length;
      // its end was seen here: no message about it later
      if (k.code !== null) k.reported = true;
      return `${k.code === null ? 'Running' : `Finished (code ${k.code})`}, ${Math.round((Date.now() - k.start) / 1000)} s\n${truncate(fresh) || '(no new output)'}`;
    },
  },
  {
    name: 'stop_command',
    group: 'commands',
    description: 'Stops a background command (with its process tree).',
    full: true,
    params: object({ id: text('Background command id') }, ['id']),
    async run(g, b) {
      const k = b.processes.stop(g.id);
      await Promise.race([k.done, new Promise((ok) => setTimeout(ok, 5000))]);
      b.manager?.backgroundChanged?.(k.chat);
      return `Stopped: ${g.id}`;
    },
  },
  {
    name: 'run_ssh',
    group: 'commands',
    description: 'Runs a command on a remote server over SSH (key-based only; names from ~/.ssh/config or user@host).',
    full: true,
    risk: (g) => commandRisk(g.command),
    params: object({ server: text('Server name (ssh config) or user@host'), command: text('Command to run remotely'), duration_sec: integer('Time limit (default 120)') }, ['server', 'command']),
    async run(g, b) {
      if (!/^[\w.@-]+$/.test(String(g.server))) throw new Error('Invalid server name.');
      b.writeLog?.({ tool: 'ssh', server: g.server, command: g.command });
      const record = startProcess({ command: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', String(g.server), String(g.command)], cwd: b.cwd });
      return frontPlanCommand(b, record, Math.min(3600, Math.max(1, Number(g.duration_sec) || 120)));
    },
  },
  {
    name: 'search_web',
    core: true,
    description: 'Searches the web (the search service set in Settings, else DuckDuckGo and Bing in a real browser) and returns the results (title, URL, snippet) with the matching lines of the top pages ("From the page"). Use short keyword queries ("Bursa hava durumu", "Node.js LTS version"), not questions; read a page fully with fetch_web.',
    params: object({ query: text('Search query (keywords)'), language: text('Language hint for SearXNG and the fallback engines: tr, en… (default: from the query)') }, ['query']),
    async run(g, b) {
      const query = String(g.query).trim();
      const tried = [];
      let found = null;
      const language = /^[a-z]{2}$/.test(String(g.language ?? '')) ? g.language : guessLanguage(query);
      // A search service from Settings › Web search first (Brave, Tavily, SearXNG; user request 08.10.2026); the
      // browser and the free engines below stay as the fallback
      for (const service of serviceList(b.webSearch)) {
        const name = SEARCH_SERVICES[service].name;
        try {
          const list = await serviceSearch(service, b.webSearch, query, { language, signal: b.signal, urls: b.setting?.agentSearchApis });
          tried.push(`${name}: ${list.length}`);
          if (list.length) {
            found = { engine: name, list };
            break;
          }
        } catch (e) {
          if (b.signal?.aborted) throw new Error('Stopped.');
          tried.push(`${name}: ${e.message}`);
        }
      }
      if (!found && b.web?.available) {
        for (const engine of ['duckduckgo', 'bing']) {
          try {
            const list = await b.web.use((br) => browserSearch(br, engine, query), b.signal);
            tried.push(`${engine}: ${list.length}`);
            if (list.length) {
              found = { engine: `${engine}, browser`, list };
              break;
            }
          } catch (e) {
            tried.push(`${engine}: ${e.message}`);
          }
        }
      }
      // Without a browser (or if it failed): the plain HTTP endpoints (Bing RSS, DuckDuckGo HTML, Wikipedia)
      for (const engine of found ? [] : b.searchEngines ?? ['bing', 'ddg', 'wiki']) {
        try {
          const r = await fetch(searchUrl(engine, query, language), { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': language }, signal: AbortSignal.timeout(20000) });
          const list = r.ok ? searchResults(await r.text(), engine).slice(0, 10) : [];
          tried.push(`${engine}: ${r.status}/${list.length}`);
          if (list.length) {
            found = { engine, list };
            break;
          }
        } catch (e) {
          tried.push(`${engine}: ${e.message}`);
        }
      }
      if (!found) return `No results (${tried.join('; ')}). Rephrase the query (other keywords, English) and search again.`;
      // Trusted sites first (official, then well-known), low-trust domains last; the engine's order within each
      const list = relevantResults(found.list, query).slice(0, 10).map((s, i) => ({ ...s, trust: sourceTrust(s.url), rank: i })).sort((a, z) => z.trust - a.trust || a.rank - z.rank).slice(0, 8);
      // Matching lines of the top pages (in parallel): often the answer itself (temperature, rate, version). The three
      // most trusted pages are read; a page with no matching lines (script pages like MGM) lets the next one in
      const candidates = list.filter((s) => s.trust >= 0).slice(0, 5);
      const read = await Promise.all(candidates.map((s) => readExcerpt(b, s.url, query)));
      const excerpts = new Map();
      candidates.forEach((s, i) => {
        if (read[i] && excerpts.size < 3) excerpts.set(s.url, read[i]);
      });
      const clean = (s) => decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();
      return truncate(`(${found.engine}; trusted sources first)\n${list.map((s, i) => `${i + 1}. ${clean(s.title)}${TRUST_TAGS[s.trust]}\n   ${s.url}\n   ${clean(s.summary).slice(0, 250)}${excerpts.has(s.url) ? `\n   From the page: ${excerpts.get(s.url)}` : ''}`).join('\n')}`);
    },
  },
  {
    name: 'fetch_web',
    core: true,
    description: 'Fetches a web page as readable text (links as [text](url)); JSON/plain text as is. Pages that need scripts or refuse plain requests are opened in a real browser (render: true forces it). For long pages, continue with start.',
    params: object({ url: text('URL'), start: integer('Character offset (to continue)'), render: logic('Open in the browser (scripts run)') }, ['url']),
    async run(g, b) {
      const u = checkWeb(b, g.url);
      let page = { status: 0, url: u.href, title: '', text: '', type: '' };
      let failure = null;
      if (!g.render) {
        try {
          const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json,text/plain,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
          const type = r.headers.get('content-type') ?? '';
          // a file (model, archive, video) is not read into memory: download saves it
          if (type && !/text|html|json|xml|javascript|csv|markdown/i.test(type)) {
            await r.body?.cancel().catch(() => {});
            return `HTTP ${r.status} ${r.url}\n[${type}, ${r.headers.get('content-length') ?? '?'} bytes: not a page; save it with download]`;
          }
          // at most 5 MB of the page, read in pieces (the whole body used to be read first)
          const parts = [];
          let size = 0;
          const reader = r.body?.getReader();
          while (reader) {
            const { value, done } = await reader.read();
            if (done) break;
            parts.push(value);
            size += value.length;
            if (size >= 5 * 2 ** 20) {
              await reader.cancel().catch(() => {});
              break;
            }
          }
          const raw = Buffer.concat(parts).subarray(0, 5 * 2 ** 20).toString('utf8');
          const isHtml = /html/i.test(type) || /^\s*</.test(raw);
          const h = isHtml ? htmlText(raw, r.url) : { title: '', text: raw };
          page = { status: r.status, url: r.url, title: h.title, text: h.text, type, images: pageImages(raw, r.url, isHtml) };
        } catch (e) {
          failure = e;
        }
      }
      // Script pages and bot walls (measured: tcmb.gov.tr kurlar 281 characters plain, 2278 in the browser)
      const thin = page.text.replace(/\s+/g, ' ').length < 600 || [401, 403, 429, 503].includes(page.status) || /enable javascript|javascript (is )?(required|disabled)|checking your browser|just a moment/i.test(page.text.slice(0, 3000));
      if ((g.render || thin) && !/json|text\/plain/i.test(page.type) && b.web?.available && !customNetwork(u.hostname)) {
        try {
          const r = await b.web.use(async (br) => {
            await br.goto(u.href, { waitMs: 15000, settleMs: 1500 });
            return { html: await br.html(), url: await br.address() };
          }, b.signal);
          const h = htmlText(r.html, r.url);
          if (h.text.length > page.text.length) page = { status: page.status || 200, url: r.url, title: h.title, text: h.text, type: 'text/html', rendered: true, images: pageImages(r.html, r.url) };
        } catch (e) {
          failure ??= e;
        }
      }
      if (!page.text && failure) throw failure;
      const startedAt = Math.max(0, Number(g.start) || 0);
      const part = page.text.slice(startedAt, startedAt + 7000);
      // the page's pictures, for show_image (user 08.10.2026: a photo asked for from the web is shown in the chat)
      const images = !startedAt && page.images?.length ? `\nImages on the page (show one in the chat with show_image):\n${page.images.map((x) => `- ${x}`).join('\n')}` : '';
      return `HTTP ${page.status} ${page.url}${page.rendered ? ' (opened in the browser)' : ''}${page.title ? `\n# ${page.title}` : ''}\n${part}${startedAt + 7000 < page.text.length ? `\n… (${page.text.length} characters; continue: start=${startedAt + 7000})` : ''}${images}`;
    },
  },
  {
    name: 'show_image',
    core: true,
    description: 'Shows a picture from the internet in the chat (found anywhere on the web; shown, never only a link). query: what it should show, e.g. "tabby kitten" or "Galata Tower at night": every image search source is asked at once and the best picture that really shows it is fetched (the vision model checks it). url: a picture you have seen (an image address or a page). Returns the Markdown line to put in your answer. A picture the panel made (a job output) needs no tool: put the line wait_job gave in your answer.',
    params: object({ query: text('What the picture should show'), url: text('Image or page address (a picture you have seen)'), caption: text('Short description of the picture') }, []),
    async run(g, b) {
      const want = String(g.query ?? '').trim();
      if (!want && !g.url) throw new Error('Give query (what the picture should show) or url.');
      const caption = String(g.caption || want || 'picture').replace(/[[\]\n]/g, ' ').trim().slice(0, 100);
      // the panel's own picture (a job's output, an upload) shows as it is: nothing fetched, no copy in the gallery
      const own = g.url && ownFile(b, g.url);
      if (own) return `This picture is already in the panel. Put this line in your answer and it shows in the chat:\n![${caption}](${own})`;
      // a request for several pictures gets different ones: the ones this chat showed are skipped
      const shown = new Set((b.chat?.shownPictures ?? []).map(String));
      const candidates = g.url ? [{ image: String(g.url) }] : [];
      let sources = null;
      const english = await englishQuery(b, want);
      if (want) {
        const found = await searchImages(english, { config: b.webSearch, urls: b.setting?.agentSearchApis, signal: b.signal, count: 12 });
        sources = found.sources;
        candidates.push(...found.results.filter((x) => !shown.has(x.image)));
      }
      const tried = [];
      let firstError = null;
      for (const c of candidates.slice(0, 8)) {
        if (b.signal?.aborted) break;
        try {
          const got = await fetchPicture(b, c.image);
          // it must show what was asked: a dog photo request got a dark portrait from a guessed address (08.10.2026)
          if (want && (await pictureShows(b, got, english)) === false) {
            tried.push(`${c.image} (does not show it)`);
            continue;
          }
          // a finished image job in the gallery, made by this chat: deleting the chat with what it produced deletes it,
          // otherwise it stays in the gallery; it can be the source of an image or video job
          const job = b.addPicture({ name: `web${got.ext}`, data: got.data, title: caption, detail: `From the web: ${new URL(got.url).hostname}`, from: got.url });
          if (b.chat) b.chat.shownPictures = [...(b.chat.shownPictures ?? []), c.image].slice(-200);
          const out = job.outputs[0];
          return { text: `Saved in the gallery (${Math.round(got.data.length / 1024)} KB, from ${got.url}). Put this line in your answer and the picture shows in the chat:\n![${caption}](${out.url})\nAs the source of an image or video job: ${out.source}`, extra: { job: job.id } };
        } catch (e) {
          firstError ??= e;
          tried.push(`${c.image} (${String(e.message).slice(0, 100)})`);
        }
      }
      // only an address was given and it failed: its own error (a missing picture is marked gone)
      if (!want && firstError) throw firstError;
      throw Object.assign(new Error(`No picture found that shows "${want}"${english !== want ? ` (searched as "${english}")` : ''}${sources ? ` (sources: ${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}${tried.length ? `; tried: ${tried.slice(0, 5).join('; ')}` : ''}. Try other words, in English too.`), { gone: true });
    },
  },
  {
    name: 'search_images',
    group: 'web',
    description: 'Searches pictures on the web: every image search source at once (Bing, Brave, Openverse, Wikimedia Commons, and SearXNG and Brave Search when set in Settings), best first. Lists the image address, size, title and page of each; show one with show_image url.',
    params: object({ query: text('What to look for'), count: integer('How many (default 10, at most 30)') }, ['query']),
    async run(g, b) {
      const query = String(g.query ?? '').trim();
      const english = await englishQuery(b, query);
      const r = await searchImages(english, { config: b.webSearch, urls: b.setting?.agentSearchApis, signal: b.signal, count: Math.min(30, Number(g.count) || 10) });
      const head = `${english !== query ? `Searched as "${english}". ` : ''}Sources: ${Object.entries(r.sources).map(([k, v]) => `${k} ${v}`).join(', ')}`;
      if (!r.results.length) return `${head}\nNo pictures found; try other words, in English too.`;
      return `${head}\n${r.results.map((x, i) => `${i + 1}. ${x.title || '(no title)'} — ${x.image}${x.width ? ` (${x.width}×${x.height})` : ''}${x.page ? ` · page: ${x.page}` : ''} · ${x.sources.join('+')}`).join('\n')}`;
    },
  },
  {
    name: 'download',
    group: 'files',
    description: 'Downloads a file from a URL (program, model, data). If target is a folder, the name is taken from the URL.',
    full: true,
    risk: () => 'change',
    params: object({ url: text('URL'), target: text('File or folder path') }, ['url', 'target']),
    async run(g, b) {
      const u = checkWeb(b, g.url);
      let target = parsePath(b, g.target);
      const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: b.signal ?? undefined });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      if ((existsSync(target) && statSync(target).isDirectory()) || /[\\/]$/.test(String(g.target))) {
        const name = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? basename(new URL(r.url).pathname) ?? 'downloaded';
        target = join(target, decodeURIComponent(name) || 'downloaded');
      }
      mkdirSync(dirname(target), { recursive: true });
      const startedAt = Date.now();
      await pipeline(Readable.fromWeb(r.body), createWriteStream(target));
      const height = statSync(target).size;
      return `Downloaded: ${target} (${(height / 2 ** 20).toFixed(1)} MB, ${((Date.now() - startedAt) / 1000).toFixed(0)} s)`;
    },
  },
  {
    name: 'load_tools',
    core: true,
    description: 'Adds tools from the "More tools" list to this chat; their descriptions and inputs come with your next step. An MCP server name (from the More tools list) adds that server\'s tools as functions. Load only what the task needs.',
    params: object({ names: { type: 'array', items: { type: 'string' }, description: 'Tool names or MCP server names from the More tools list' } }, ['names']),
    outputLimit: 16000,
    async run(g, b) {
      return await b.loadTools((Array.isArray(g.names) ? g.names : String(g.names ?? '').split(/[\s,]+/)).map((n) => String(n).trim()).filter(Boolean));
    },
  },
  {
    name: 'ask_user',
    core: true,
    description: 'Asks the user a question and waits for the answer. Use it only when the decision is really the user\'s (a choice between approaches, a preference, information you cannot find or reasonably assume); give 2-4 short options when they fit (the user can also write their own answer). Do not ask what you can find out or decide yourself.',
    ask: true,
    params: object({ question: text('The question, short and clear'), options: { type: 'array', items: { type: 'string' }, description: '2-4 short choices (optional)' } }, ['question']),
    async run(g, b) {
      const options = (Array.isArray(g.options) ? g.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 6);
      const a = await b.askUser(String(g.question).trim(), options);
      return a.answered ? `The user answered: ${a.answer}` : 'No answer within an hour: continue with your best assumption and say which one you made.';
    },
  },
  {
    name: 'sub_agent',
    group: 'agents',
    description: 'Starts a separate agent with a sub-task (with its own context). wait: true returns the result; false returns an id immediately (for parallel work) and this chat is woken with its result when it finishes (no need to poll agent_status).',
    params: object({ task: text("The sub-agent's task: a complete, self-contained description"), wait: logic('Wait for it to finish (default true)') }, ['task']),
    async run(g, b) {
      const sub = await b.manager.subAgent({ parent: b.chat, task: String(g.task), notify: g.wait === false });
      if (g.wait === false) return `Sub-agent started: ${sub.id}. You will be told when it finishes (its result comes as a message); stop it with background.`;
      return b.manager.agentResult(sub.id, b.signal);
    },
  },
  {
    name: 'agent_status',
    group: 'agents',
    description: 'Status of a sub-agent and (if finished) its final reply; with wait: true waits until it finishes.',
    params: object({ id: text('Sub-agent (chat) id'), wait: logic('Wait until it finishes') }, ['id']),
    async run(g, b) {
      if (g.wait) return b.manager.agentResult(g.id, b.signal);
      const s = b.manager.summary(g.id);
      // a finished result read here is not sent to the chat again
      if (s.status === 'idle' && s.lastResponse) b.manager.subAgentSeen?.(s.id);
      return JSON.stringify({ id: s.id, status: s.status, last: s.lastResponse?.slice(0, 3000) ?? null });
    },
  },
  {
    name: 'write_memory',
    group: 'memory',
    description: 'Saves a new persistent note (also in the system prompt of later chats): user preferences, learned paths, unfinished work. Keep it short. To change a note that exists, use update_memory with its id.',
    params: object({ note: text('One-line note') }, ['note']),
    async run(g, b) {
      return b.manager.addMemory(String(g.note));
    },
  },
  {
    name: 'update_memory',
    group: 'memory',
    description: 'Replaces the text of one persistent note, by its id (the [n…] before each note in your instructions, or from search_memory).',
    params: object({ id: text('Note id, e.g. n3'), note: text('The new one-line text') }, ['id', 'note']),
    aliases: { text: 'note' },
    async run(g, b) {
      return b.manager.updateMemory(String(g.id), String(g.note));
    },
  },
  {
    name: 'search_knowledge',
    group: 'knowledge',
    outputLimit: 12000,
    description: 'Searches the user\'s documents in Knowledge (added in the Knowledge window or attached to chats) by words and, with the embedding model, by meaning; returns the best passages with their document, page/sheet/slide and lines. Answer from the passages and name the document and page; read on in a document with read_file from the line given.',
    params: object({ query: text('What to find: a question, or the words the document would use'), documents: { type: 'array', items: { type: 'string' }, description: 'Only in these documents (names or ids); default: every document this chat may use' }, count: integer('Passages, default 5 (at most 10)') }, ['query']),
    aliases: { q: 'query', text: 'query' },
    async run(g, b) {
      if (!b.knowledge) throw new Error('Knowledge is not available.');
      const named = (Array.isArray(g.documents) ? g.documents : String(g.documents ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
      // a chat set to some documents searches only in those (and in the named ones among them)
      let documents = named.length ? b.knowledge.match(named) : null;
      if (named.length && !documents.length) return `None of these is in Knowledge: ${named.join(', ')}. Documents: ${b.knowledge.list().slice(0, 30).map((d) => d.name).join(', ') || '(none)'}`;
      if (b.knowledgeOnly) {
        documents = documents ? documents.filter((d) => b.knowledgeOnly.includes(d)) : b.knowledgeOnly;
        if (!documents.length) return 'This chat is set to use other documents of Knowledge (chat Options › Knowledge); none of the named ones.';
      }
      const r = await b.knowledge.search(g.query, { documents, count: Math.min(10, Math.max(1, Number(g.count) || 5)), signal: b.signal });
      const how = r.mode === 'hybrid' ? 'by words and by meaning' : 'by words';
      if (!r.results.length) return `No passage found for "${g.query}" (searched ${how}${documents ? ` in ${documents.length} document${documents.length === 1 ? '' : 's'}` : ''}). ${r.note ?? 'Try other words, or the words the document itself would use.'}`;
      const where = (x) => x.document.source ?? x.document.path;
      return `${r.results.length} passage${r.results.length === 1 ? '' : 's'} (searched ${how}${r.note ? `; ${r.note}` : ''}):\n\n${r.results.map((x, i) => `[${i + 1}] ${x.document.name}${x.label ? ` · ${x.label.replace(/^Sheet: /, 'sheet ')}` : ''} · lines ${x.line}-${x.line + x.lines - 1}${where(x) ? ` · read on: read_file path "${where(x)}" start_line=${x.line + x.lines}` : ''}\n${x.text}`).join('\n\n')}`;
    },
  },
  {
    name: 'search_memory',
    group: 'memory',
    description: 'Searches the persistent notes (the older ones are not in your instructions): notes with the given words, or one note by id; neither: all notes, with their ids.',
    params: object({ query: text('Words to look for'), id: text('A note id, e.g. n3') }),
    async run(g, b) {
      return b.manager.searchMemory({ query: g.query ?? '', id: g.id ?? '' });
    },
  },
  {
    name: 'delete_memory',
    group: 'memory',
    description: 'Deletes one persistent note (wrong or outdated) by its id.',
    params: object({ id: text('Note id, e.g. n3') }, ['id']),
    aliases: { text: 'id' },
    async run(g, b) {
      return b.manager.deleteMemory(String(g.id));
    },
  },
  {
    name: 'search_chats',
    group: 'chats',
    description: 'Searches the earlier chats (titles and messages; every word must occur, as a word start): the best matches first, each with its id, date and the line around the match. With id: reads that chat\'s messages in short form (start: from that message on). For "what did we do / decide / write before".',
    params: object({ query: text('Words to look for'), id: text('A chat id from the results: read its messages'), start: integer('With id: the message to start from (default 1)') }),
    async run(g, b) {
      if (g.id) return b.manager.readChat(String(g.id), { start: g.start });
      return b.manager.searchChats(String(g.query ?? ''), { current: b.chat?.id ?? null });
    },
  },
  {
    name: 'schedule',
    group: 'agents',
    description: 'Schedules a task for a set time or a regular repeat ("every day at 9:00", "check again in 20 minutes": minute_after); when due, this chat goes on with the task (same_chat: false: a new chat each time). For "wait until something happens" use watch instead.',
    risk: () => 'change',
    params: object({ task: text('Task to do (full description)'), minute_after: integer('In how many minutes'), time: text('ISO time, e.g. 2026-10-09T09:00:00+03:00'), repeat_min: integer('Repeat interval (minutes); empty = once'), same_chat: logic('Go on in this chat (default true); false: a new chat each time') }, ['task']),
    async run(g, b) {
      return JSON.stringify(b.manager.schedule({ task: String(g.task), minuteAfter: g.minute_after, time: g.time, repeatMin: g.repeat_min, full: b.full, approvalMode: b.chat.approvalMode, cwd: b.cwd, chat: g.same_chat === false ? null : b.chat.id }));
    },
  },
  {
    name: 'schedules',
    group: 'agents',
    description: 'Scheduled tasks; if remove is given, removes that id.',
    params: object({ remove: text('Schedule id to delete') }),
    async run(g, b) {
      if (g.remove) return b.manager.deleteSchedule(g.remove);
      return JSON.stringify(b.manager.scheduleList());
    },
  },
  {
    // Waiting in the background (user request 09.10.2026, like Claude Code): lib/agent/background.mjs
    name: 'watch',
    group: 'agents',
    description: 'Waits in the background until something is true, then wakes this chat with "then" and the check\'s output: for "wait until X, then do Y". It checks one of command (exit code 0, or its output matches until), url (HTTP 2xx, or "HTTP <status>" and the page match until) or job (a panel job finished, or its status matches until) every every_min minutes, by itself (no model calls), for at most max_hours. A failing check (host down, command error) only means not yet. repeat: true wakes again each time it becomes true again. Returns an id (w…); stop it with background.',
    risk: () => 'change',
    params: object({ command: text('A shell command to check (needs file/command access)'), shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'] }, url: text('A web address to check'), job: text('A panel job id to wait for'), until: text('Regular expression the output must match (default: exit code 0, HTTP 2xx, job finished)'), every_min: integer('Minutes between checks (default 5, at least 1)'), max_hours: { type: 'number', description: 'Give up after this many hours (default 12, at most 72)' }, then: text('What to do when it happens: this chat goes on with it'), repeat: logic('Keep watching after it fires (default false)') }, ['then']),
    async run(g, b) {
      const given = ['command', 'url', 'job'].filter((k) => g[k] !== undefined && g[k] !== null && String(g[k]).trim());
      if (given.length !== 1) throw new Error('Give exactly one of command, url or job to check.');
      let check;
      if (g.command) {
        if (!b.full) throw new Error('A command check needs file and command access (a chat opened from this computer or with an API key); check a url or a job instead.');
        check = { command: String(g.command), shell: g.shell ?? 'powershell', cwd: b.cwd };
      } else if (g.url) check = { url: checkWeb(b, String(g.url).trim()).href };
      else {
        // a job that is not there is refused now, not waited for
        check = { job: b.jobSummary(String(g.job).trim()).id };
      }
      const w = b.manager.watchers.addWatch({ chat: b.chat.id, check, until: g.until, everyMin: g.every_min, maxHours: g.max_hours, then: g.then, repeat: g.repeat === true, full: b.full, approvalMode: b.chat.approvalMode, cwd: b.cwd });
      return `Watching (${w.id}): ${given[0] === 'job' ? `job ${check.job}` : given[0] === 'url' ? check.url : `command ${check.command}`}${w.until ? ` until /${w.until}/` : ''}, checked now and every ${w.everyMin} min until ${new Date(w.ends).toLocaleString('en-GB', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' })} (Istanbul) at the latest. This chat is woken with your "then" text when it happens: do not wait or check it yourself. Stop it with background (stop: ${w.id}).`;
    },
  },
  {
    name: 'monitor',
    group: 'agents',
    description: 'Runs a command in the background and wakes this chat with the new lines it prints (only those matching pattern, when given), the lines of about 30 s together; it ends when the command exits (that wakes the chat once more) or with background. For output that streams: a log (Get-Content -Wait -Tail 0 <file>), a server, or a wait loop that prints once (while (-not (<check>)) { Start-Sleep 5 }; "READY"). Returns an id (m…).',
    full: true,
    risk: (g) => commandRisk(g.command),
    params: object({ command: text('Command to run'), shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'] }, cwd: text('Working folder'), pattern: text('Regular expression: only matching lines wake the chat'), then: text('What to do with the lines (comes with each message)'), max_hours: { type: 'number', description: 'Stop it after this many hours (default 12, at most 72)' } }, ['command']),
    async run(g, b) {
      const cwd = g.cwd ? parsePath(b, g.cwd) : b.cwd;
      if (!existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
      b.writeLog?.({ tool: 'monitor', command: g.command, cwd });
      const m = b.manager.watchers.addMonitor({ chat: b.chat.id, command: String(g.command), shell: g.shell ?? 'powershell', pattern: g.pattern, then: g.then ?? '', maxHours: g.max_hours, full: b.full, approvalMode: b.chat.approvalMode, cwd });
      return `Monitoring (${m.id}): ${m.command}${m.pattern ? ` (lines matching /${m.pattern}/)` : ''}. Its new lines wake this chat, and so does its end: do not wait or poll. Stop it with background (stop: ${m.id}).`;
    },
  },
  {
    name: 'background',
    group: 'agents',
    description: 'What this chat runs in the background, with ids and state: background commands (k…), watches (w…), monitors (m…), sub-agents and wake-ups (this chat\'s scheduled tasks). stop: an id stops that one; it does not wake the chat any more.',
    params: object({ stop: text('Id of the item to stop') }),
    async run(g, b) {
      if (g.stop) return b.manager.stopItem(String(g.stop).trim(), { chat: b.chat.id }).message;
      return b.manager.backgroundText(b.chat.id);
    },
  },
  {
    name: 'load_skill',
    outputLimit: 14000,
    group: 'skills',
    description: 'Skills (SKILL.md instructions for a kind of task): query lists the installed ones that match (empty: all names), name loads one.',
    params: object({ name: text('Skill name to load'), query: text('Words to find skills by (name or description)') }),
    async run(g, b) {
      if (!g.name) {
        const words = String(g.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const all = b.skills();
        const found = words.length ? all.filter((k) => words.some((w) => `${k.name} ${k.description}`.toLowerCase().includes(w))) : all;
        if (!found.length) return `No installed skill matches "${g.query}" (${all.length} installed). install_skill can add one from GitHub.`;
        return words.length ? found.slice(0, 30).map((k) => `- ${k.name}: ${k.description.slice(0, 160)}`).join('\n') : `${all.length} skills: ${all.map((k) => k.name).join(', ')}`;
      }
      const r = loadSkill(b.skills(), String(g.name));
      return truncate(`Skill: ${r.name}\nFolder: ${r.folder}${r.files.length ? `\nExtra files (with read_file): ${r.files.join(', ')}` : ''}\n\n${r.content}`, 14000);
    },
  },
  {
    name: 'install_skill',
    group: 'skills',
    description: 'Installs a skill (a folder with SKILL.md, the Claude Code skills format) so that load_skill can load it: from a GitHub address (github.com/<owner>/<repo>, or .../tree/<branch>/<folder>) or a folder on this computer. Find one with search_web first and prefer official or well-known publishers. A source with several skills returns their names: call again with skill. remove deletes an installed skill instead.',
    full: true,
    risk: () => 'change',
    params: object({ source: text('GitHub address or folder'), skill: text('Which skill, when the source has several'), replace: logic('Update a skill that is already installed'), remove: text('Folder name of an installed skill (panel-data\\skills) to delete instead') }),
    async run(g, b) {
      if (g.remove) {
        const folder = join(b.setting.dataRoot, DATA_FILES.skills, basename(String(g.remove)));
        if (!existsSync(join(folder, 'SKILL.md'))) return `No installed skill in ${folder}.`;
        await moveToRecycleBin(folder);
        return `Skill removed: ${folder} (in the Recycle Bin).`;
      }
      if (!g.source) return 'Give source: a GitHub address or a folder.';
      const source = githubSource(g.source) ? String(g.source) : parsePath(b, g.source);
      const r = await installSkill({ source, skill: g.skill ?? '', dataRoot: b.setting.dataRoot, replace: Boolean(g.replace), ...githubFetch(b) });
      if (r.choices) return `This source has ${r.choices.length} skills; call install_skill again with skill:\n${r.choices.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
      return `Installed skill "${r.installed.name}" in ${r.installed.folder}. Load it with load_skill when a task needs it.`;
    },
  },
  {
    name: 'install_plugin',
    group: 'skills',
    description: "Installs a Claude / Claude Code plugin into the panel (panel-data\\plugins): its skills join load_skill and its MCP servers join the chats. source: a GitHub address of a plugin or of a plugin marketplace (a repository with .claude-plugin/marketplace.json, such as Anthropic's official one), or a folder on this computer. A marketplace with several plugins returns their names: call again with plugin. remove deletes an installed plugin instead.",
    full: true,
    risk: (g) => (g?.remove ? 'change' : 'danger'),
    params: object({ source: text('GitHub address or folder of a plugin or marketplace'), plugin: text('Which plugin of the marketplace'), replace: logic('Update a plugin that is already installed'), remove: text('Name of an installed plugin to delete instead') }),
    async run(g, b) {
      if (g.remove) {
        const folder = join(b.setting.dataRoot, DATA_FILES.plugins, basename(String(g.remove)));
        if (!existsSync(folder)) return `No installed plugin in ${folder}.`;
        // its servers run in its folder: stop them first
        b.mcp?.prune(Object.keys(pluginMcpServers(folder) ?? {}));
        await moveToRecycleBin(folder);
        b.mcp?.prune();
        return `Plugin removed: ${folder} (in the Recycle Bin).`;
      }
      if (!g.source) return 'Give source: a GitHub address or a folder of a plugin or marketplace.';
      const source = githubRepo(g.source) ? String(g.source) : parsePath(b, g.source);
      const r = await installPlugin({ source, plugin: g.plugin ?? '', dataRoot: b.setting.dataRoot, replace: Boolean(g.replace), ...githubFetch(b), stop: (folder) => b.mcp?.prune(Object.keys(pluginMcpServers(folder) ?? {})) });
      if (r.choices) return `This marketplace has ${r.choices.length} plugins; call install_plugin again with plugin:\n${r.choices.map((p) => `- ${p.name}: ${p.description}`).join('\n')}`;
      b.mcp?.prune(r.installed.mcp);
      const what = [r.installed.skills.length ? `skills: ${r.installed.skills.join(', ')} (load_skill ${r.installed.name}:<skill>)` : '', r.installed.mcp.length ? `MCP servers: ${r.installed.mcp.join(', ')} (their tools join from the next message)` : ''].filter(Boolean).join('; ');
      return `Installed plugin "${r.installed.name}" in ${r.installed.folder}${what ? `; ${what}` : ' (it has no skills or MCP servers)'}.`;
    },
  },
  {
    name: 'add_mcp_server',
    group: 'mcp',
    description: 'Adds an MCP server to the panel (panel-data\\mcp.json) and starts it to check that it works; its tools then join this chat as functions (mcp__<server>__<tool>). Local server: command + args (often npx -y <package> or uvx <package>; install the runtime with run_command first if it is missing) and env for the keys it needs. Remote server: url (+ headers). Find servers with search_web (registry.modelcontextprotocol.io, GitHub, npm, PyPI), read the README with fetch_web, prefer official or well-known publishers. remove: true deletes the server.',
    full: true,
    risk: (g) => (g?.remove ? 'change' : 'danger'),
    params: object({ name: text('Short server name'), command: text('Program to start (npx, uvx, node, python or an .exe)'), args: { type: 'array', items: { type: 'string' }, description: 'Arguments of the command' }, env: { type: 'object', description: 'Environment variables (keys the server needs)' }, url: text('Address of a remote (HTTP) server instead of a command'), headers: { type: 'object', description: 'HTTP headers of a remote server' }, timeout_sec: integer('Time limit of one tool call in seconds (default 600); for tools that work for many minutes'), remove: logic('Delete this server instead') }, ['name']),
    async run(g, b) {
      if (g.remove) return `MCP server "${b.mcp.save(g.name, null)}" removed.`;
      const strings = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [k, String(v)]));
      const limit = Number(g.timeout_sec) > 0 ? { timeout: Math.round(Number(g.timeout_sec) * 1000) } : {};
      const definition = g.url
        ? { type: 'http', url: String(g.url), ...(g.headers ? { headers: strings(g.headers) } : {}), ...limit }
        : g.command
          ? { ...mcpCommand(g.command, g.args), ...(g.env && Object.keys(g.env).length ? { env: strings(g.env) } : {}), ...limit }
          : null;
      if (!definition) return 'Give command (+ args) for a local server or url for a remote one.';
      const previous = b.mcp.panelDefinition(g.name);
      const name = b.mcp.save(g.name, definition);
      try {
        const list = await b.mcp.client(name).toolList();
        // its tools join this chat as functions at once (no mcp_tools step)
        if (b.loadMcp) return `MCP server "${name}" added.\n${await b.loadMcp(name)}`;
        return `MCP server "${name}" added; ${list.length} tools: ${list.map((a) => a.name).join(', ').slice(0, 1500)}. Use them with call_mcp (inputs: mcp_tools).`;
      } catch (e) {
        b.mcp.save(name, previous);
        throw new Error(`The server did not start (${e.message}); it was not added${previous ? ' (the previous definition is back)' : ''}. Check the command (is its runtime installed?) and its README.`);
      }
    },
  },
  {
    name: 'mcp_tools',
    outputLimit: 12000,
    group: 'mcp',
    description: 'Starts an MCP server and adds its tools to this chat as functions (mcp__<server>__<tool>, usable from your next step), after the server\'s own instructions on how to use them. Tools over the limit are listed with their inputs for call_mcp.',
    full: true,
    params: object({ server: text('Server name') }, ['server']),
    async run(g, b) {
      const client = b.mcp.client(String(g.server));
      await client.toolList();
      // the tools become the chat's own functions; their full input schemas go with the functions, not into this text
      if (b.loadMcp) return truncate(await b.loadMcp(String(g.server)), 12000);
      const list = client.tools ?? [];
      const tools = list.map((a) => `- ${a.name}: ${String(a.description ?? '').replace(/\s+/g, ' ').slice(0, 300)}\n  input: ${JSON.stringify(a.inputSchema?.properties ?? {}).slice(0, 2000)}${a.inputSchema?.required?.length ? ` required: ${a.inputSchema.required.join(', ')}` : ''}`).join('\n') || '(no tools)';
      return truncate(`${mcpInstructions(g.server, client)}${tools}`, 12000);
    },
  },
  {
    name: 'call_mcp',
    group: 'mcp',
    description: 'Calls a tool of an MCP server that is not loaded as functions (learn the inputs with mcp_tools first; a loaded server\'s tools are called directly as mcp__<server>__<tool>).',
    full: true,
    risk: () => 'change',
    params: object({ server: text('Server name'), tool: text('Tool name'), input: { type: 'object', description: 'Tool input' } }, ['server', 'tool']),
    async run(g, b) {
      return callMcp(b, String(g.server), String(g.tool), g.input ?? {});
    },
  },
];

/**
 * The server's instructions (MCP initialize "instructions"; Blender's say how to drive it), kept short so the tool list
 * still fits (user request 08.10.2026); '' without any.
 */
export function mcpInstructions(server, client) {
  const said = String(client?.instruction ?? '').trim();
  return said ? `Instructions of the server "${server}":\n${said.length > 3000 ? `${said.slice(0, 3000)}… (cut)` : said}\n\nTools:\n` : '';
}

/** One MCP tool call (call_mcp and the native mcp__ functions): text, an error mark, images saved for look_image. */
export async function callMcp(b, server, tool, input) {
  b.writeLog?.({ tool: 'mcp', server, name: tool });
  // Stop cancels a long call (the server is told); the server's progress reports show on the running card
  const r = await b.mcp.client(server).call(tool, input && typeof input === 'object' ? input : {}, { signal: b.signal, onProgress: (p) => b.advance?.(`${server}: ${progressText(p)}`) });
  let images = '';
  if (r.images.length) {
    // an MCP image (screenshot, render) goes to disk; the agent can look at it with look_image
    const folder = join(b.setting.dataRoot, DATA_FILES.chat, 'attachments');
    mkdirSync(folder, { recursive: true });
    const paths = r.images.map((gr, i) => {
      const y = join(folder, `${Date.now()}-${i}${gr.mime === 'image/jpeg' ? '.jpg' : '.png'}`);
      writeFileSync(y, Buffer.from(gr.data, 'base64'));
      return y;
    });
    images = `\nImages (can be viewed with look_image): ${paths.join(', ')}`;
  }
  return `${r.error ? '[tool returned an error] ' : ''}${truncate(r.text)}${images}`;
}

/**
 * A loaded MCP server's tool as a function of the chat (nativeMcpTools entry). Every call asks like call_mcp in
 * Manual mode; a tool the server marks destructive (annotations.destructiveHint) asks in Allow edits mode too.
 */
export function mcpTool(t) {
  return {
    name: t.name,
    group: 'mcp',
    full: true,
    mcp: { server: t.server, tool: t.tool },
    description: t.description,
    params: t.params,
    risk: () => (t.annotations?.destructiveHint === true ? 'danger' : 'change'),
    async run(g, b) {
      return callMcp(b, t.server, t.tool, g);
    },
  };
}

/**
 * Arka plan surecleri (run_command back_plan): kimlik -> kayit; panel kapanirken durdurulur. A record knows the chat
 * that started it (its background list, Stop) and whether it was stopped (a stopped command never wakes its chat).
 */
export class Processes {
  constructor() {
    this.map = new Map();
    this.counter = 0;
  }

  add(record, command, chat = null) {
    this.counter += 1;
    const id = `k${this.counter}`;
    record.command = command;
    record.chat = chat;
    this.map.set(id, record);
    return id;
  }

  get(id) {
    const k = this.map.get(String(id));
    if (!k) throw new Error(`No such background command: ${id}. Existing: ${[...this.map.keys()].join(', ') || '(none)'}`);
    return k;
  }

  /** Stops one with its process tree; it does not wake its chat. */
  stop(id) {
    const k = this.get(id);
    k.stopped = true;
    if (k.code === null && k.proc.pid) killTree(k.proc.pid);
    return k;
  }

  list() {
    return [...this.map.entries()].map(([id, k]) => ({ id, command: k.command.slice(0, 200), pid: k.proc.pid, code: k.code, duration: Math.round((Date.now() - k.start) / 1000), chat: k.chat ?? null }));
  }

  stopAll() {
    for (const k of this.map.values()) if (k.code === null && k.proc.pid) killTree(k.proc.pid);
  }
}

/** The file as a stream (the request shape the upload handlers expect): createReadStream + content-length. */
export function fileStream(path) {
  const s = createReadStream(path);
  s.headers = { 'content-length': String(statSync(path).size) };
  return s;
}

export { extname };
