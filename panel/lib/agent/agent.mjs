/**
 * Chat and agent: the local text model (llama-server) does every panel operation and general work on this computer
 * through tool calls (user 08.10.2026: "Chat kismindan paneldeki tum islemleri yapabilmeli", "tam bir agent",
 * "birden fazla agent arka plan isleri icin").
 *
 * Session: panel-data\chat\<id>.json (messages, tool calls, result attachments). Every chat can work through a
 * multi-step task from one message (the model decides; user request 08.10.2026: no agent checkbox), step limit, Stop.
 * Approval mode per chat (manual | edits | auto, changeable while it runs) decides which tool calls wait for the
 * user (tools.mjs risk). Text model per chat (llm\models file, changeable while it runs; empty = Settings > Text model;
 * "remote" = the OpenAI-compatible server of Settings › Remote model, lib/remote-llm.mjs).
 * Full access (shell, files, SSH, MCP) only in a session opened from this computer or with the API key.
 *
 * Tool calls: first llama-server's own "tools" support (--jinja template); when the template lacks it or the model writes
 * the calls as text, <tool>{"name","input"}</tool> blocks are parsed (fallback). When the context fills, old tool outputs
 * are trimmed, and if that is not enough the older conversation is summarized by the model.
 */
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { unifiedDiff } from './diff.mjs';
import { detectRuntimes } from './runtimes.mjs';
import { moveToRecycleBin } from '../deletion.mjs';
import { DATA_FILES } from '../data-files.mjs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { CancelError, UserError } from '../errors.mjs';
import { LlmError, TEMPERATURE_CAP, THINKING_BUDGET } from '../llm.mjs';
import { REMOTE_MODEL, remoteRequest } from '../remote-llm.mjs';
import { APPROVAL_MODES, TOOLS, Processes, WebBrowser, allowRules, allowedBy, cleanRule, fileStream, mcpInstructions, mcpTool, messageLanguage, needsApproval, parsePath, sameRule, searchFold, searchWords, sourcePath, terminalText, truncate } from './tools.mjs';
import { McpManager, nativeMcpTools } from './mcp.mjs';
import { Watchers, durationText, shortTime, tail, watchText } from './background.mjs';
import { Database } from '../database.mjs';
import { findSkills } from './skills.mjs';
import { pluginFolders, pluginMcpServers, pluginSkills } from './plugins.mjs';
import { runFfmpeg } from '../ffmpeg.mjs';
import { attachmentText, readableKind } from '../attachments.mjs';

export const AGENT_STEPS = 40;
/** Project rule files, read in the working folder and the folders above it (nearest first). */
export const RULE_FILES = ['NEDESE.md', 'AGENTS.md', 'CLAUDE.md'];
const RULE_FILE_LIMIT = 8000;
const RULES_LIMIT = 20000;
// Assistant presets: the instructions one adds, how many there can be
const PRESET_PROMPT_LIMIT = 8000;
const PRESET_LIMIT = 100;
// Prompt templates: their text, how many there can be, the names the composer's own commands use
const TEMPLATE_TEXT_LIMIT = 8000;
const TEMPLATE_LIMIT = 200;
export const CHAT_COMMANDS = ['compact', 'mode', 'model', 'thinking', 'new', 'stop', 'regenerate', 'delete', 'help', 'templates'];
export const CHAT_PAGE = 30;
// An exported chat (user request 08.10.2026): its format name, and what an imported file may hold
export const CHAT_FORMAT = 'nedese-chat';
const IMPORT_MESSAGE_LIMIT = 5000;
const IMPORT_TEXT_LIMIT = 200000;
// Source links under an answer that used the web (user request 08.10.2026): at most this many
const SOURCE_LIMIT = 6;
// Follow-up suggestions under the last answer (user request 08.10.2026): how many, how long each (characters), what
// the text model is asked
const FOLLOW_UP_COUNT = 3;
const FOLLOW_UP_LENGTH = 120;
const FOLLOW_UP_PROMPT = 'Suggest the next messages the user is most likely to send after the assistant\'s last answer below: a question that goes deeper, a related detail to ask for, or the next step to ask the assistant to do. Write each one as the user would type it, in the language of the user\'s message, short (at most 12 words), without numbering. Answer only with JSON: {"followUps": ["...", "...", "..."]}';
// Chat list order: newest update first, or best match first for a search
export const CHAT_SORTS = ['recent', 'relevance'];
/** Idle chats kept in memory; the others are read from their file when opened. */
const CACHE_LIMIT = 40;
const APPROVAL_WAIT_MS = 60 * 60000;
// Lasting notes: the system prompt gets the newest whole notes up to MEMORY_LIMIT characters, the file holds more
// (search_memory finds the older ones); one note at most NOTE_LIMIT characters
const MEMORY_LIMIT = 4000;
const MEMORY_FILE_LIMIT = 40000;
const NOTE_LIMIT = 500;
const RESPONSE_TOKEN = 4096;
const ANSWER_TOKEN_CAP = 14336;
// Files with text that ride on a user message: each of the last two user messages may fill this share of the context
// with them (split between its files, at least ATTACHMENT_MIN characters each); an older message keeps the start of
// each file (ATTACHMENT_OLD characters) and the read_file call that reads on
const ATTACHMENT_SHARE = 0.25;
const ATTACHMENT_MIN = 3000;
const ATTACHMENT_OLD = 1500;
const ATTACHMENT_CACHE = 100;

const id = () => `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** A rough token estimate (Turkish ~3 characters per token). */
const token = (s) => Math.ceil(String(s ?? '').length / 3);

/**
 * Tool folders (panel-data\tools\<name>) the turn wrote but did not install: no successful install_skill from that
 * folder and no add_mcp_server whose command or args name it. Seen 10.10.2026: the agent wrote a QR skill and an MCP
 * server script, installed neither and answered that the tool was installed.
 */
/** Tools that are called again to see something change (a job, a command, a sub-agent): a repeat is not a loop. */
const WAITING_TOOLS = new Set(['wait_job', 'command_output', 'agent_status', 'monitor', 'background', 'schedules', 'watch']);

export function uninstalledTools(messages) {
  let start = messages.length;
  while (start > 0 && !(messages[start - 1].role === 'user' && !messages[start - 1].hidden)) start -= 1;
  const turn = messages.slice(start);
  const ok = new Set(turn.filter((m) => m.role === 'tool' && !m.error).map((m) => m.toolId));
  const folder = (p) => /(?:^|[\\/])panel-data[\\/]+tools[\\/]+([^\\/]+)/i.exec(String(p ?? ''))?.[1]?.toLowerCase() ?? null;
  const written = new Map();
  const asSkill = new Set();
  const asServer = new Set();
  for (const m of turn) {
    for (const c of m.toolCalls ?? []) {
      if (!ok.has(c.id)) continue;
      const g = c.input ?? {};
      if (c.name === 'write_file' || c.name === 'edit_file') {
        const f = folder(g.path);
        // an MCP server script (10.10.2026: the agent put its FastMCP server in with install_skill, which starts nothing)
        const server = /\.py$/i.test(String(g.path)) && /FastMCP|\bfrom\s+mcp\b|\bimport\s+mcp\b/.test(`${g.text ?? ''}${g.replace ?? ''}`);
        if (f) written.set(f, written.get(f) || server);
      } else if (c.name === 'install_skill') [g.source, g.skill].map(folder).filter(Boolean).forEach((f) => asSkill.add(f));
      else if (c.name === 'add_mcp_server') [g.command, ...(Array.isArray(g.args) ? g.args : [])].map(folder).filter(Boolean).forEach((f) => asServer.add(f));
    }
  }
  return [...written].filter(([f, server]) => !asServer.has(f) && (server || !asSkill.has(f))).map(([f, server]) => ({ folder: f, server }));
}

/**
 * The web pages a turn's answer stands on (user request 08.10.2026: source chips under answers that used web search or
 * fetch): the pages fetch_web read (HTTP 2xx, a page and not a file), then search_web's results in their order. The turn
 * is everything after the user's last shown message; failed calls give nothing.
 */
export function turnSources(messages) {
  let start = messages.length;
  while (start > 0 && !(messages[start - 1].role === 'user' && !messages[start - 1].hidden)) start -= 1;
  const turn = messages.slice(start);
  const results = new Map(turn.filter((m) => m.role === 'tool' && !m.error).map((m) => [m.toolId, String(m.content ?? '')]));
  const read = [];
  const found = [];
  for (const m of turn) {
    for (const c of m.toolCalls ?? []) {
      const text = results.get(c.id);
      if (text === undefined) continue;
      if (c.name === 'fetch_web') {
        // "HTTP 200 <address>[ (opened in the browser)]\n# <title>" (tools.mjs fetch_web)
        const head = /^HTTP (\d+) (\S+)(?: \(opened in the browser\))?(?:\n# (.*))?/.exec(text);
        if (head && /^2\d\d$/.test(head[1]) && !/^HTTP \d+ \S+\n\[[^\]\n]*not a page/.test(text)) read.push({ url: head[2], title: head[3] ?? '' });
      } else if (c.name === 'search_web') {
        // "1. <title>[ [official]]\n   <address>" (tools.mjs search_web)
        for (const x of text.matchAll(/^\d+\. (.*)\n {3}(\S+)$/gm)) found.push({ url: x[2], title: x[1].replace(/ \[(official|well-known|low trust)\]$/, '') });
      }
    }
  }
  return cleanSources([...read, ...found]);
}

/** Source links kept on a message: http(s) addresses, each once (without its #part), a title of one short line. */
export function cleanSources(list) {
  const seen = new Set();
  const kept = [];
  for (const x of Array.isArray(list) ? list : []) {
    let u;
    try {
      u = new URL(String(x?.url ?? ''));
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(u.protocol)) continue;
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    kept.push({ url: u.href, title: String(x?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) });
    if (kept.length >= SOURCE_LIMIT) break;
  }
  return kept;
}

/**
 * The follow-up suggestions in a model's answer: {"followUps": [...]} (or a bare list, or one per line), each a short
 * line without numbering, bullets or quotes, each once, at most FOLLOW_UP_COUNT.
 */
export function followUpList(text) {
  const raw = String(text ?? '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  let list = null;
  try {
    const j = JSON.parse(/[[{][\s\S]*[\]}]/.exec(raw)?.[0] ?? raw);
    list = Array.isArray(j) ? j : Object.values(j ?? {}).find(Array.isArray);
  } catch {
    list = raw.split('\n');
  }
  const seen = new Set();
  const kept = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (typeof x !== 'string') continue;
    const line = x.replace(/\s+/g, ' ').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    if (!line || line.length > FOLLOW_UP_LENGTH || /:$/.test(line) || seen.has(line.toLocaleLowerCase())) continue;
    seen.add(line.toLocaleLowerCase());
    kept.push(line);
    if (kept.length >= FOLLOW_UP_COUNT) break;
  }
  return kept;
}

/** A cut answer goes back to the model only this long: the rest was unfinished (often a whole file) and filled the context. */
const CUT_ANSWER_KEEP = 4000;
/** The model's thinking kept with a message (for the user to read; a high budget writes ~30k characters). */
const REASONING_KEEP = 20000;
/** The summary's answer (tokens) and the least a message keeps in the summary input (characters). */
const SUMMARY_ANSWER = 800;
const SUMMARY_MESSAGE_MIN = 300;

/**
 * The longest a message may be in the summary input so that all of them fit room characters: short messages stay
 * whole and the long ones share what is left (user request 08.10.2026: a fixed 1500 characters cut tool results and
 * answers the summarizer had room for). null: everything fits whole.
 */
export function summaryCut(lengths, room) {
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = room;
  for (const [k, n] of sorted.entries()) {
    const share = left / (sorted.length - k);
    if (n > share) return Math.max(SUMMARY_MESSAGE_MIN, Math.floor(share));
    left -= n;
  }
  return null;
}

const modelText = (m) => (m.role === 'assistant' && m.cut && !m.toolCalls?.length && String(m.content ?? '').length > CUT_ANSWER_KEEP ? `${String(m.content).slice(0, 600)}… [cut off at the output limit: ${String(m.content).length - 600} more characters left out]` : m.content);

/**
 * The path and the text written so far of a write_file cut at the output limit: from unfinished JSON arguments (native
 * call or <tool> block) or from Gemma's own call syntax (call:write_file{path:<|"|>…). null without a complete path.
 */
export function partialWrite(raw) {
  const s = String(raw ?? '');
  const path = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
  const text = /"(?:text|content)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(s);
  if (path && text) {
    try {
      // an escape cut in the middle (\ or \u00) is left out
      return { path: JSON.parse(`"${path[1]}"`), text: JSON.parse(`"${text[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, '')}"`), append: /"append"\s*:\s*true/.test(s) };
    } catch {
      return null;
    }
  }
  const gPath = /path:<\|"\|>([\s\S]*?)<\|"\|>/.exec(s);
  const gText = /(?:text|content):<\|"\|>([\s\S]*)$/.exec(s);
  if (gPath && gText) return { path: gPath[1], text: gText[1].replace(/<\|"\|>[\s\S]*$/, ''), append: /append:true/.test(s) };
  // the text came first and was cut before the path: the caller may know the file (one cut file in this run)
  if (text) {
    try {
      return { path: null, text: JSON.parse(`"${text[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, '')}"`), append: true };
    } catch {
      return null;
    }
  }
  if (gText) return { path: null, text: gText[1].replace(/<\|"\|>[\s\S]*$/, ''), append: true };
  return null;
}

/**
 * Tool call blocks: <tool>{"name","input"}</tool> (also <tool_call>…</tool_call>), ```json {"name"...}```.
 * Keys: name (or tool), input (or arguments, parameters).
 */
export function toolBlocks(text, { fenced = true, known = null } = {}) {
  const s = String(text ?? '');
  const result = [];
  const add = (raw, strict = false) => {
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      return false;
    }
    const name = j?.name ?? j?.tool;
    if (!name || typeof name !== 'string') return false;
    if (strict && known && !known.has(name)) return false;
    const input = j.input ?? j.arguments ?? j.parameters ?? {};
    result.push({ name, input: typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return { text: input }; } })() : input ?? {} });
    return true;
  };
  for (const m of s.matchAll(/<(tool|tool_call)>\s*([\s\S]*?)\s*<\/\1>/g)) add(m[2]);
  if (!result.length && fenced) for (const m of s.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)) add(m[1], true);
  // The text outside the blocks (what the model wrote to the user)
  const remaining = s.replace(/<(tool|tool_call)>[\s\S]*?<\/\1>/g, '').replace(result.length ? /```(?:json)?\s*\{[\s\S]*?\}\s*```/g : /$^/, '').trim();
  return { calls: result, text: remaining };
}

// Chat search folds text the same way as tools.mjs (the FTS5 tokenizer does not fold the Turkish dotless i)
export { searchFold };

/**
 * Lasting notes (chat\memory.md), one line each: "- [n3] 2026-10-08: text". The id stays with the note, so the model
 * can change or delete one note (user report 08.10.2026: delete_memory deleted every line containing the text, and the
 * prompt cut the file mid-line so old notes dropped out silently). Lines of the older format ("- 2026-10-08: text")
 * get ids in their order; migrated tells the caller to write the file back with them.
 */
export function parseNotes(text) {
  const notes = [];
  let migrated = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    const m = /^-\s*\[(n\d+)\]\s*(?:(\d{4}-\d{2}-\d{2}):\s*)?(.*)$/.exec(clean);
    if (m) {
      notes.push({ id: m[1], date: m[2] ?? '', text: m[3].trim() });
      continue;
    }
    const old = /^(?:[-*]\s*)?(?:(\d{4}-\d{2}-\d{2}):\s*)?(.*)$/.exec(clean);
    notes.push({ id: null, date: old[1] ?? '', text: old[2].trim() });
    migrated = true;
  }
  let next = noteNumber(notes);
  for (const n of notes) n.id ??= `n${next++}`;
  return { notes, migrated };
}

/** The number the next new note gets (one more than the highest id). */
const noteNumber = (notes) => Math.max(0, ...notes.map((n) => Number(String(n.id ?? '').slice(1)) || 0)) + 1;
export const noteLine = (n) => `- [${n.id}] ${n.date ? `${n.date}: ` : ''}${n.text}`;
const noteText = (note) => String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_LIMIT);

/** A sub-agent chat's title: its task, with the files inside the chat's folder named relatively. */
export function subAgentTitle(task, cwd) {
  const folder = String(cwd ?? '').replace(/[\\/]+$/, '');
  const text = folder ? String(task).replace(new RegExp(`${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]`, 'gi'), '') : String(task);
  return `↳ ${text.replace(/\s+/g, ' ').trim().slice(0, 60)}`;
}

/** FTS5 query: every word as a prefix ("burs" finds "Bursa"); null when there is nothing to search. */
export function searchQuery(text) {
  const words = searchWords(text);
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

export class AgentManager {
  // webSearch: () => the search services of Settings › Web search ({ brave, tavily, searxng }; read at each search)
  // remote: () => Settings › Remote model ({ url, key, model, whenBusy }; read at each model call)
  // knowledge: the documents of Knowledge (lib/knowledge.mjs; search_knowledge, and a chat's attachments go in it)
  constructor({ setting, llm, h, routes, jobTypes, tasks = null, db = null, webSearch = null, remote = null, knowledge = null, log = () => {} }) {
    Object.assign(this, { setting, llm, h, routes, jobTypes, tasks, webSearch, remote, knowledge, log });
    this.folder = join(setting.dataRoot, DATA_FILES.chat);
    mkdirSync(this.folder, { recursive: true });
    // List and search come from panel.db (chats, chat_search); without a panel DB an in-memory one is indexed at start
    this.db = db ?? new Database(':memory:');
    this.ownDb = !db;
    this.chats = new Map(); // loaded sessions (running ones always), least recently used first
    this.events = new EventEmitter();
    this.events.setMaxListeners(200);
    this.processes = new Processes();
    this.web = new WebBrowser({ enabled: setting.agentBrowser !== false, log });
    // MCP servers and skills come from inside the project only (panel-data, the plugins in it, <ai>.mcp.json)
    this.mcp = new McpManager({ aiRoot: setting.aiRoot, dataRoot: setting.dataRoot, log });
    this.skillCache = null;
    // Native tool calls per model file (a trained model's template may lack them while Gemma has them; one flag for
    // the whole process locked every model to the first one's mode). nativeTool: the last decided value (tests, status)
    this.nativeTools = new Map();
    this.nativeTool = null;
    this.recordTimer = new Map();
    // follow-up suggestions being written, per chat: { messageId, control, promise } (a new message stops them)
    this.followUpRuns = new Map();
    // the text of a message's files as the model reads it, per message, room and file state (the context fit measures
    // the conversation many times a step; a chat with many documents would read them again each time)
    this.attachmentCache = new Map();
    this.scheduleFile = join(this.folder, 'schedules.json');
    this.memoryFile = join(this.folder, 'memory.md');
    // Background work (user request 09.10.2026): messages from the background waiting for their busy chat, the parent
    // chats a sub-agent started with wait: false tells when it finishes, the watches and monitors
    this.wakes = new Map();
    this.subNotify = new Map();
    this.backgroundTimers = new Map();
    this.watchers = new Watchers({ file: join(this.folder, 'watches.json'), setting, manager: this, log });
    this.index();
    this.sweepCheckpoints();
    this.watchers.start();
    this.timer = setInterval(() => this.processSchedules().catch((e) => this.log(`[agent] schedule: ${e.message}`)), 30000);
    this.timer.unref?.();
  }

  /* ── Sessions ── */

  /** Session as stored on disk -> in memory (all idle after a restart; approval mode from the older flag). */
  static normalize(s) {
    if (s.status !== 'idle') s.status = 'idle';
    // sessions from before the approval modes: "unattended" was the only switch
    if (!APPROVAL_MODES.includes(s.approvalMode)) s.approvalMode = s.unattended ? 'auto' : 'edits';
    delete s.unattended;
    return s;
  }

  /** Reads a session file without keeping it in memory (null if missing or unreadable). */
  peek(id) {
    id = String(id);
    const live = this.chats.get(id);
    if (live) return live;
    if (!/^[a-z0-9]+$/i.test(id)) return null;
    try {
      const s = JSON.parse(readFileSync(join(this.folder, `${id}.json`), 'utf8'));
      return s?.id === id ? AgentManager.normalize(s) : null;
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`[agent] could not read session ${id}: ${e.message}`);
      return null;
    }
  }

  /** Session by id, loaded from its file when needed (kept in memory, least recently used idle ones dropped). */
  find(id) {
    id = String(id);
    let s = this.chats.get(id);
    if (s) {
      this.chats.delete(id);
      this.chats.set(id, s);
      return s;
    }
    s = this.peek(id);
    if (!s) return null;
    this.chats.set(id, s);
    for (const [k, x] of this.chats) {
      if (this.chats.size <= CACHE_LIMIT) break;
      // a temporary chat lives only here
      if (k !== id && !x.work && x.status === 'idle' && !this.recordTimer.has(k) && !x.temporary) this.chats.delete(k);
    }
    return s;
  }

  /**
   * Chat files into the DB list and search index: on the first start with the DB (or after it was rebuilt), and for
   * an in-memory DB on every start.
   */
  index() {
    if (this.db.meta('chatIndex') === '1' && !this.ownDb) return;
    let n = 0;
    for (const d of readdirSync(this.folder)) {
      if (!/^[a-z0-9]+\.json$/i.test(d)) continue;
      const s = this.peek(d.slice(0, -5));
      if (!s) continue;
      this.indexChat(s);
      n += 1;
    }
    this.db.meta('chatIndex', '1');
    if (n && !this.ownDb) this.log(`[agent] ${n} chats indexed in panel.db`);
  }

  /** Undo copies of chats that have no file (a temporary chat when the panel stopped) are removed at start. */
  sweepCheckpoints() {
    const root = join(this.folder, 'checkpoints');
    if (!existsSync(root)) return;
    for (const d of readdirSync(root)) if (/^[a-z0-9]+$/i.test(d) && !existsSync(join(this.folder, `${d}.json`))) rmSync(join(root, d), { recursive: true, force: true });
  }

  /** List summary and search text of a session into the DB. */
  indexChat(s) {
    const texts = s.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !m.hidden).map((m) => m.content);
    try {
      this.db.writeChat({ ...this.summary(s), status: 'idle', approval: null, progress: null }, { title: searchFold(s.title), body: searchFold(texts.join('\n')).slice(0, 400000) });
    } catch (e) {
      this.log(`[agent] could not index session ${s.id}: ${e.message}`);
    }
  }

  /**
   * Every message gets an id (rating and editing address a message by it; user request 08.10.2026). New messages get
   * theirs when they are made; messages of older chats and the few made elsewhere get one here. True if any was added.
   */
  static messageIds(s) {
    let added = false;
    for (const m of s.messages) {
      if (m.id) continue;
      m.id = id();
      added = true;
    }
    return added;
  }

  save(s, immediately = false) {
    // a temporary chat (user request 08.10.2026) is never written: not on disk, not in the list or the search
    if (s.temporary) {
      AgentManager.messageIds(s);
      return;
    }
    const write = () => {
      this.recordTimer.delete(s.id);
      AgentManager.messageIds(s);
      const { work: _c, ...data } = s;
      try {
        writeFileSync(join(this.folder, `${s.id}.json`), JSON.stringify(data));
      } catch (e) {
        this.log(`[agent] could not write session ${s.id}: ${e.message}`);
      }
      this.indexChat(s);
    };
    if (immediately) {
      clearTimeout(this.recordTimer.get(s.id));
      write();
      return;
    }
    if (!this.recordTimer.has(s.id)) this.recordTimer.set(s.id, setTimeout(write, 300));
  }

  /** Approval mode from a request: approvalMode, or the older unattended flag (true = auto). */
  static approvalMode(mode, unattended, fallback = 'edits') {
    if (mode !== undefined && mode !== null && mode !== '') {
      if (!APPROVAL_MODES.includes(mode)) throw new UserError(`approvalMode must be one of ${APPROVAL_MODES.join(', ')}.`);
      return mode;
    }
    if (unattended !== undefined && unattended !== null) return unattended ? 'auto' : 'edits';
    return fallback;
  }

  /**
   * Text model file of a chat: '' / null = the panel default (Settings > Text model), "remote" = the remote model of
   * Settings › Remote model; a missing file (or a remote model that is not set) is rejected.
   */
  checkModel(model) {
    if (!model) return null;
    if (model === REMOTE_MODEL) {
      if (!this.remoteConfig()) throw new UserError('The remote model is not set: Settings › Remote model.');
      return REMOTE_MODEL;
    }
    if (!this.llm?.modelInfo?.(String(model))) throw new UserError(`Text model not found: ${model}`);
    return String(model);
  }

  /** Settings › Remote model when it is set (address and model name), else null. */
  remoteConfig() {
    const r = this.remote?.();
    return r?.url && r?.model ? r : null;
  }

  /**
   * Where a chat's model call goes (user request 08.10.2026): the remote model when the chat chose it, or when the GPU
   * is busy with an image/video job and "use it while the GPU is busy" is on (the local model would wait for the job);
   * null: the local llama-server. A call in progress keeps its choice (s.work.remote).
   */
  remoteFor(s) {
    if (s?.work && s.work.remote !== undefined) return s.work.remote;
    const r = this.remoteConfig();
    if (!r) return null;
    if (s?.model === REMOTE_MODEL) return r;
    return r.whenBusy && (this.llm?.gpuBusy?.() || this.llm?.releasing) ? r : null;
  }

  /** A chat completion for a chat: the remote model (remoteFor) or the local llama-server; the same answer shape. */
  textRequest(s, body, options) {
    const remote = this.remoteFor(s);
    if (remote) return remoteRequest(remote, body, { signal: options.signal, onChunk: options.onChunk });
    // the remote model's entry never goes to llama-server (Settings changed while this call was being prepared)
    return this.llm.req('/v1/chat/completions', body, options.info?.remote ? { ...options, info: this.localInfo(s) } : options);
  }

  /** temporary: never saved (memory only, gone when deleted or when the panel restarts; user request 08.10.2026). */
  create({ title = '', agent = false, full = false, approvalMode, unattended, model = null, autoCompact = true, canAsk = true, cwd = null, parent = null, thinking = 'low', stepLimit = null, preset = null, temporary = false } = {}) {
    const s = {
      ...(temporary ? { temporary: true } : {}),
      id: id(),
      title: String(title).slice(0, 80),
      creation: new Date().toISOString(),
      update: new Date().toISOString(),
      status: 'idle',
      agent: Boolean(agent),
      full: Boolean(full),
      approvalMode: AgentManager.approvalMode(approvalMode, unattended),
      model: this.checkModel(model),
      autoCompact: autoCompact !== false,
      // false: nobody is there to answer ask_user (API completions, scheduled tasks)
      canAsk: canAsk !== false,
      cwd: cwd && existsSync(cwd) ? cwd : this.setting.aiRoot,
      parent,
      thinking: THINKING_BUDGET[thinking] !== undefined ? thinking : 'low',
      stepLimit: stepLimit ? Math.max(1, Math.min(500, Number(stepLimit))) : null,
      // the assistant preset it started with: its instructions are copied (editing the preset later does not change it)
      preset: preset ? { id: preset.id, name: preset.name, prompt: preset.prompt ?? '' } : null,
      messages: [],
      trimmed: 0,
      summary: '',
      step: 0,
      lastResponse: null,
      error: null,
    };
    this.chats.set(s.id, s);
    this.save(s, true);
    return s;
  }

  get(id) {
    const s = this.find(id);
    if (!s) throw new UserError('Chat not found.', 'notFound');
    return s;
  }

  summary(s) {
    if (typeof s === 'string') s = this.get(s);
    const rated = { good: 0, bad: 0 };
    for (const m of AgentManager.storedMessages(s)) if (m.rating === 1) rated.good += 1;
    else if (m.rating === -1) rated.bad += 1;
    return { id: s.id, title: s.title, creation: s.creation, update: s.update, status: s.status, full: s.full, pinned: Boolean(s.pinned), archived: Boolean(s.archived), temporary: Boolean(s.temporary), rated, preset: s.preset ? { id: s.preset.id, name: s.preset.name } : null, approvalMode: s.approvalMode, model: s.model ?? null, thinking: s.thinking ?? 'low', autoCompact: s.autoCompact !== false, context: { used: s.conversationTokens ?? this.estimateContext(s), size: this.conversationRoom(s) }, cwd: s.cwd ?? null, knowledge: s.knowledge ?? null, allow: s.allow ?? [], parent: s.parent, step: s.step, messageCount: s.messages.length, lastResponse: s.lastResponse, error: s.error, approval: s.work?.approval ? { id: s.work.approval.id, tool: s.work.approval.tool, input: s.work.approval.input, risk: s.work.approval.risk, allow: s.work.approval.allow ?? null } : null, question: s.work?.question ? { id: s.work.question.id, question: s.work.question.question, options: s.work.question.options } : null, progress: s.work?.progress ?? null, usage: s.usage ?? null, runUsage: s.work?.usage ?? null };
  }

  /**
   * One page of chats, most recently updated first (panel.db, indexed). query: words that must all occur (as word
   * prefixes) in the title or a user/assistant message, case, diacritics and Turkish i insensitive; each hit carries a
   * short excerpt (match). after: the next cursor of the previous page. Returns { chats, total, next }.
   * sort: recent (default) or relevance (with a query: best match first; its cursor is "@<offset>"). exclude: a chat
   * id that is left out.
   * Without a query (user request 08.10.2026): the pages hold the chats that are neither pinned nor archived; the first
   * page brings the pinned ones apart (pinned, newest first) and every page the number of archived ones (archivedCount);
   * archived: true pages through the archived chats instead. A search looks through every chat.
   */
  list({ query = '', after = null, limit = CHAT_PAGE, sort = 'recent', exclude = null, archived = false } = {}) {
    if (sort && !CHAT_SORTS.includes(sort)) throw new UserError(`sort must be ${CHAT_SORTS.join(' or ')}.`);
    const match = String(query ?? '').trim() ? searchQuery(query) : null;
    if (String(query ?? '').trim() && !match) return { chats: [], total: 0, next: null };
    const relevance = sort === 'relevance' && match;
    const cut = after ? String(after).lastIndexOf('|') : -1;
    const cursor = relevance ? (/^@\d+$/.test(String(after ?? '')) ? { offset: Number(String(after).slice(1)) } : null) : cut > 0 ? { updated: String(after).slice(0, cut), id: String(after).slice(cut + 1) } : null;
    const shelf = match ? null : archived ? 'archived' : 'main';
    const page = this.db.chatPage({ match, after: cursor, limit: Math.max(1, Math.min(100, Number(limit) || CHAT_PAGE)), sort: relevance ? 'relevance' : 'recent', exclude, shelf });
    const words = match ? searchWords(query) : [];
    const fresh = (stored) => {
      const live = this.chats.get(stored.id);
      return live ? this.summary(live) : stored;
    };
    const chats = page.summaries.map((stored) => {
      const summary = fresh(stored);
      return words.length ? { ...summary, match: this.excerpt(this.chats.get(stored.id) ?? this.peek(stored.id), words) } : summary;
    });
    const next = !page.next ? null : page.next.offset !== undefined ? `@${page.next.offset}` : `${page.next.updated}|${page.next.id}`;
    if (match) return { chats, total: page.total, next };
    const pinned = shelf === 'main' && !cursor ? this.db.chatPage({ limit: 100, shelf: 'pinned', exclude }).summaries.map(fresh) : undefined;
    return { chats, total: page.total, next, ...(pinned ? { pinned } : {}), archivedCount: this.db.archivedChatCount() };
  }

  /**
   * search_chats (user request 08.10.2026: the assistant can look up what was said or done in earlier chats): the chats
   * with all the words, best match first, each with its id, date, title and the line around the match. The chat that
   * searches is left out (its own question has the words).
   */
  searchChats(query, { current = null, limit = 8 } = {}) {
    if (!searchQuery(query)) throw new Error('Give words to look for (query), or the id of a chat to read it.');
    const r = this.list({ query, limit, sort: 'relevance', exclude: current });
    if (!r.chats.length) return `No other chat has all of: ${String(query).trim()}. Try fewer or other words (a word matches as a word start).`;
    const line = (c) => `- ${c.id} · ${String(c.update ?? c.creation ?? '').slice(0, 10)} · ${c.title || '(untitled)'} · ${c.messageCount ?? 0} messages${c.match ? `\n  ${c.match}` : ''}`;
    return `${r.chats.length} of ${r.total} chats, best match first (read one: search_chats with its id):\n${r.chats.map(line).join('\n')}`;
  }

  /**
   * search_chats with id: a chat's messages in short form, from message start on, as many as fit (who said what, the
   * tools that ran and a line of their results); the next start is named first so it is never cut off.
   */
  readChat(id, { start = 1 } = {}) {
    const s = this.peek(String(id ?? '').trim());
    if (!s) throw new Error(`No chat with id "${id}" (the ids come from search_chats).`);
    const shown = s.messages.filter((m) => !m.hidden && ['user', 'assistant', 'tool'].includes(m.role));
    const from = Math.min(Math.max(1, Math.floor(Number(start) || 1)), Math.max(1, shown.length));
    const flat = (t, n) => {
      const x = String(t ?? '').replace(/\s+/g, ' ').trim();
      return x.length > n ? `${x.slice(0, n)}…` : x;
    };
    const lines = [];
    let size = 0;
    for (let i = from - 1; i < shown.length; i++) {
      const m = shown[i];
      const tools = (m.toolCalls ?? []).map((c) => `${c.name}(${flat(c.input?.path ?? c.input?.command ?? c.input?.query ?? c.input?.url ?? c.input?.prompt ?? '', 80)})`).join(', ');
      const text =
        m.role === 'tool'
          ? `[${i + 1}] result of ${m.toolName}${m.error ? ' (error)' : ''}: ${flat(m.content, 200)}`
          : `[${i + 1}] ${m.role}: ${flat(m.content, 700) || '(no text)'}${(m.attachments ?? []).length ? ` [attachments: ${m.attachments.map((e) => e.source).join(', ')}]` : ''}${tools ? `\n  tools: ${tools}` : ''}`;
      if (lines.length && size + text.length > 7000) break;
      lines.push(text);
      size += text.length + 1;
    }
    const last = from - 1 + lines.length;
    const more = last < shown.length ? `; more: search_chats with this id and start=${last + 1}` : '';
    return `Chat ${s.id} · ${s.title || '(untitled)'} · ${String(s.creation ?? '').slice(0, 10)} · messages ${from}-${last} of ${shown.length}${more}\n${lines.join('\n')}`;
  }

  /** Short text around the first searched word in the chat's messages (null if it is only in the title). */
  excerpt(s, words) {
    for (const m of s?.messages ?? []) {
      if (!((m.role === 'user' || m.role === 'assistant') && m.content)) continue;
      const text = String(m.content).replace(/\s+/g, ' ');
      const at = searchFold(text).indexOf(words[0]);
      if (at < 0) continue;
      return `${at > 40 ? '…' : ''}${text.slice(Math.max(0, at - 40), at + 80)}${at + 80 < text.length ? '…' : ''}`;
    }
    return null;
  }

  detail(s) {
    if (typeof s === 'string') s = this.get(s);
    if (AgentManager.messageIds(s)) this.save(s);
    // live: the answer the model is writing right now (text so far), null when none is being written
    const live = s.work?.live && (s.work.live.text || s.work.live.reasoning) ? { ...s.work.live } : null;
    // background: its sub-agents, background commands, watches, monitors and wake-ups (the line above the composer)
    return { ...this.summary(s), cwd: s.cwd, thinking: s.thinking, stepLimit: s.stepLimit ?? AGENT_STEPS, createdJobs: this.createdJobs(s), rules: this.rules(s).map(({ source, path }) => ({ source, path })), messages: s.messages, forks: this.forkInfo(s), forkOf: s.forkOf ?? null, live, background: this.backgroundList(s.id) };
  }

  /* ── Rated answers (user request 08.10.2026: thumbs up/down; good answers become training data) ── */

  /** A message of the chat by its id (the active branch). */
  message(s, messageId) {
    const m = s.messages.find((x) => x.id === String(messageId ?? ''));
    if (!m) throw new UserError('No such message in this chat.', 'notFound');
    return m;
  }

  /** An answer of the assistant that can be rated: its own text, not a tool step, an error or a stopped run. */
  static rateable(m) {
    return m?.role === 'assistant' && !m.hidden && !m.toolCalls?.length && !m.error && !m.stopped && Boolean(String(m.content ?? '').trim());
  }

  /** Thumbs up (1) or down (-1) on an answer, stored with the message; 0 or null takes the rating back. */
  rate(chatId, messageId, rating) {
    const s = this.get(chatId);
    const m = this.message(s, messageId);
    if (!AgentManager.rateable(m)) throw new UserError('Only an answer of the assistant can be rated.');
    const value = rating === null || rating === undefined || rating === '' ? 0 : Number(rating);
    if (![1, -1, 0].includes(value)) throw new UserError('rating must be 1 (good), -1 (bad) or 0 (none).');
    if (value) {
      m.rating = value;
      m.ratedAt = new Date().toISOString();
    } else {
      delete m.rating;
      delete m.ratedAt;
    }
    this.save(s);
    this.events.emit('event', { chat: s.id, type: 'rating', id: m.id, rating: value, time: new Date().toISOString() });
    return { message: value ? 'Rating saved.' : 'Rating removed.', rating: value };
  }

  /**
   * Follow-up suggestions under the chat's last answer (user request 08.10.2026): up to three short next messages,
   * written by the chat's text model from the last question and answer and kept with the answer (asked again, they
   * come from there). None (an empty list) while the chat runs, for an answer that is not the last one, or when the
   * model is not ready: a suggestion never loads or switches the text model and never waits for a job on the GPU. A new
   * message stops the request; the same request from another device waits for the one being written.
   */
  async followUps(chatId, messageId) {
    const s = this.get(chatId);
    const m = this.message(s, messageId);
    if (!AgentManager.rateable(m)) throw new UserError('Suggestions are made for an answer of the assistant.');
    if (Array.isArray(m.followUps)) return { followUps: m.followUps };
    const running = this.followUpRuns.get(s.id);
    if (running?.messageId === m.id) return running.promise;
    const shown = s.messages.filter((x) => !x.hidden && x.role !== 'note');
    if (s.status !== 'idle' || shown.at(-1) !== m) return { followUps: [] };
    const remote = this.remoteFor(s);
    const info = this.localInfo(s);
    const llm = this.llm;
    if (!remote && !(llm?.proc && !llm.startup && !llm.releasing && !llm.gpuBusy?.() && llm.loaded?.model === info?.model)) return { followUps: [] };
    const question = [...s.messages.slice(0, s.messages.indexOf(m))].reverse().find((x) => x.role === 'user' && !x.hidden);
    const control = new AbortController();
    const promise = (async () => {
      try {
        const r = await this.textRequest(s, {
          messages: [{ role: 'system', content: FOLLOW_UP_PROMPT }, { role: 'user', content: `USER: ${String(question?.content ?? '').slice(0, 2000)}\n\nASSISTANT: ${String(m.content).slice(0, 4000)}` }],
          temperature: 0.6,
          max_tokens: 200,
          // llama-server keeps the answer to JSON; a remote server may not know the field (the prompt asks for JSON)
          ...(remote ? {} : { response_format: { type: 'json_object' } }),
          chat_template_kwargs: { enable_thinking: false },
        }, { externalRequest: true, signal: control.signal, info: remote ? this.modelInfo(s) : info, waitSec: 0 });
        if (control.signal.aborted || r.code !== 200) return { followUps: [] };
        this.addUsage(s, r.json.usage);
        const list = followUpList(r.json.choices?.[0]?.message?.content);
        // kept with the answer unless the chat went on meanwhile (a stopped request gives nothing)
        if (list.length && s.messages.includes(m) && !s.deleted) {
          m.followUps = list;
          this.save(s);
        }
        return { followUps: list };
      } catch (e) {
        if (control.signal.aborted || e instanceof CancelError) return { followUps: [] };
        this.log(`[agent ${s.id}] follow-up suggestions: ${e.message}`);
        return { followUps: [] };
      } finally {
        if (this.followUpRuns.get(s.id)?.control === control) this.followUpRuns.delete(s.id);
      }
    })();
    this.followUpRuns.set(s.id, { messageId: m.id, control, promise });
    return promise;
  }

  /** Rated answers in all chats, from the list summaries in panel.db (no chat file is read). */
  ratingCounts() {
    let good = 0;
    let bad = 0;
    let chats = 0;
    for (const c of this.db.chatSummaries()) {
      const r = this.chats.get(c.id) ? this.summary(this.chats.get(c.id)).rated : c.rated;
      if (!r?.good && !r?.bad) continue;
      good += r.good ?? 0;
      bad += r.bad ?? 0;
      chats += 1;
    }
    return { good, bad, chats };
  }

  /** Every chat on disk (sessions not kept in memory are read, not cached). */
  *allChats() {
    for (const d of readdirSync(this.folder)) {
      if (!/^[a-z0-9]+\.json$/i.test(d)) continue;
      const s = this.peek(d.slice(0, -5));
      if (s) yield s;
    }
  }

  /**
   * Training examples from the rated answers: for every answer rated good, the conversation before it (the user's
   * messages and the assistant's answers, without tool steps; an answer rated bad leaves with the request that led to
   * it; at most the last 10 turns) and the answer itself, as { messages: [{ role, content }] }: the chat format the
   * Training tab reads, which teaches the last answer only. Also counts the good and bad ratings.
   */
  ratedExamples() {
    const examples = [];
    let good = 0;
    let bad = 0;
    const chats = new Set();
    for (const s of this.allChats()) {
      for (const m of AgentManager.storedMessages(s)) {
        if (!AgentManager.rateable(m) || !m.rating) continue;
        if (m.rating === 1) good += 1;
        if (m.rating === -1) bad += 1;
        chats.add(s.id);
      }
      // every branch (edited messages keep the earlier ones); an answer the branches share is one example
      const done = new Set();
      for (const path of AgentManager.branches(s)) {
        const turns = [];
        for (const m of path) {
          if (m.role === 'user' && !m.hidden && String(m.content ?? '').trim()) {
            // messages sent one after the other (queued while it worked) are one request
            if (turns.at(-1)?.role === 'user') turns.at(-1).content += `\n\n${m.content.trim()}`;
            else turns.push({ role: 'user', content: m.content.trim() });
          } else if (AgentManager.rateable(m)) {
            // a second answer in a row (the run went on after a note) takes the place of the first
            if (turns.at(-1)?.role === 'assistant') turns.pop();
            if (turns.at(-1)?.role !== 'user') continue;
            if (m.rating === -1) {
              turns.pop();
              continue;
            }
            turns.push({ role: 'assistant', content: String(m.content).trim() });
            if (m.rating !== 1 || done.has(m)) continue;
            done.add(m);
            // the last 10 turns, starting with a request
            let from = Math.max(0, turns.length - 20);
            if (turns[from].role !== 'user') from += 1;
            examples.push({ messages: turns.slice(from).map((t) => ({ ...t })) });
          }
        }
      }
    }
    return { examples, good, bad, chats: chats.size };
  }

  /* ── Branches (user request 08.10.2026: edit an earlier message and send it again; the rest becomes a branch) ──
   * s.messages is the branch shown. s.forks: the edited places on it, { at, current, versions }: at is the index of the
   * edited user message, versions are the branches from there (the shown one is null, its messages are in
   * s.messages; the others keep their messages from at on, their own forks further on and their context state).
   */

  /** Every message the chat keeps: the shown branch and the ones put aside (each message once). */
  static storedMessages(s) {
    const out = [...s.messages];
    const walk = (forks) => {
      for (const f of forks ?? []) for (const t of f.versions) {
        if (!t) continue;
        out.push(...t.messages);
        walk(t.forks);
      }
    };
    walk(s.forks);
    return out;
  }

  /** Every branch as its whole message list, the shown one first. */
  static *branches(s) {
    yield s.messages;
    const walk = function* (messages, forks) {
      for (const f of forks ?? []) for (const t of f.versions) {
        if (!t) continue;
        const path = [...messages.slice(0, f.at), ...t.messages];
        yield path;
        yield* walk(path, t.forks);
      }
    };
    yield* walk(s.messages, s.forks);
  }

  /** The edited messages of the shown branch: { message (its id), version (1-based), count }. */
  forkInfo(s) {
    return (s.forks ?? []).filter((f) => s.messages[f.at]).map((f) => ({ message: s.messages[f.at].id, version: f.current + 1, count: f.versions.length }));
  }

  /** The shown branch from index at on, put aside: its messages, its forks further on, its context state. */
  static branchTail(s, at) {
    return { messages: s.messages.slice(at), forks: (s.forks ?? []).filter((f) => f.at > at), trimmed: s.trimmed ?? 0, summary: s.summary ?? '', leftOut: s.leftOut ?? 0, loadedTools: s.loadedTools ?? [], mcpLoaded: s.mcpLoaded ?? [], lastResponse: s.lastResponse ?? null };
  }

  /** Index of a message of the shown branch by its id. */
  messageIndex(s, messageId) {
    const at = s.messages.findIndex((m) => m.id === String(messageId ?? ''));
    if (at < 0) throw new UserError('No such message in this chat.', 'notFound');
    return at;
  }

  /** The context gauge measures again (the conversation changed under it). */
  static forgetMeasure(s) {
    delete s.contextTokens;
    delete s.conversationTokens;
  }

  /**
   * Edit: the user's message at messageId gets a new text (and its attachments, unless new ones are given) and the
   * chat goes on from it; what followed it stays as the earlier version (POST /chat/{id}/branch shows it again). A
   * summary that covered the messages after it no longer fits the conversation: it is dropped and made again when needed.
   * Returns the session; the caller runs it.
   */
  editMessage(chatId, messageId, { text = '', attachments } = {}) {
    const s = this.get(chatId);
    if (s.status !== 'idle' || s.work) throw new UserError('The chat is running; edit a message when it finishes (or stop it).', 'inUse');
    const at = this.messageIndex(s, messageId);
    const old = s.messages[at];
    if (old.role !== 'user' || old.hidden || old.wake) throw new UserError('Only a message you wrote can be edited.');
    const message = this.userMessage(s, { text, attachments: attachments ?? old.attachments ?? [] });
    s.forks ??= [];
    let f = s.forks.find((x) => x.at === at);
    if (!f) {
      f = { at, current: 0, versions: [null] };
      s.forks.push(f);
      s.forks.sort((a, b) => a.at - b.at);
    }
    f.versions[f.current] = AgentManager.branchTail(s, at);
    s.forks = s.forks.filter((x) => x.at <= at);
    f.versions.push(null);
    f.current = f.versions.length - 1;
    s.messages = s.messages.slice(0, at);
    if ((s.trimmed ?? 0) > at) {
      s.trimmed = 0;
      s.summary = '';
      s.leftOut = 0;
      for (const m of s.messages) delete m.dropped;
    }
    s.messages.push(message);
    AgentManager.forgetMeasure(s);
    this.save(s, true);
    this.emit(s, 'branch', { detail: this.detail(s) });
    return s;
  }

  /**
   * Regenerate (user request 08.10.2026): the last request is sent again as it was (text and attachments) and the
   * model writes a new answer; the answer before stays as the earlier version of that request (the switcher under it,
   * as after an edit). Returns the session; the caller runs it.
   */
  regenerate(chatId) {
    const s = this.get(chatId);
    if (s.status !== 'idle' || s.work) throw new UserError('The chat is running; regenerate the answer when it finishes (or stop it).', 'inUse');
    const last = s.messages.findLastIndex((m) => m.role === 'user' && !m.hidden);
    if (last < 0) throw new UserError('There is no answer to write again yet.');
    const request = s.messages[last];
    return this.editMessage(chatId, request.id, { text: request.content, attachments: request.attachments ?? [] });
  }

  /** Shows another version of an edited message (1-based, as in "2/3"): its messages and its context come back. */
  switchBranch(chatId, messageId, version) {
    const s = this.get(chatId);
    if (s.status !== 'idle' || s.work) throw new UserError('The chat is running; switch versions when it finishes (or stop it).', 'inUse');
    const at = this.messageIndex(s, messageId);
    const f = (s.forks ?? []).find((x) => x.at === at);
    if (!f) throw new UserError('This message has no other versions.', 'notFound');
    const v = Number(version) - 1;
    if (!Number.isInteger(v) || v < 0 || v >= f.versions.length) throw new UserError(`version must be 1 to ${f.versions.length}.`);
    if (v !== f.current) {
      f.versions[f.current] = AgentManager.branchTail(s, at);
      const t = f.versions[v];
      s.messages = [...s.messages.slice(0, at), ...t.messages];
      s.forks = [...s.forks.filter((x) => x.at <= at), ...(t.forks ?? [])];
      Object.assign(s, { trimmed: t.trimmed ?? 0, summary: t.summary ?? '', leftOut: t.leftOut ?? 0, loadedTools: t.loadedTools ?? [], mcpLoaded: t.mcpLoaded ?? [], lastResponse: t.lastResponse ?? null });
      f.versions[v] = null;
      f.current = v;
      AgentManager.forgetMeasure(s);
      this.save(s, true);
      this.emit(s, 'branch', { detail: this.detail(s) });
    }
    return { message: `Showing version ${v + 1} of ${f.versions.length}.`, chat: this.detail(s) };
  }

  /**
   * Fork: a new chat with this chat's messages up to messageId (a step's tool results come along), its settings and
   * its context. The copied messages get new ids and no ratings; the jobs they made stay the first chat's (deleting the
   * fork does not delete them). full: the access of the device that asks.
   */
  fork(chatId, messageId, { full = false } = {}) {
    const s = this.get(chatId);
    let end = this.messageIndex(s, messageId) + 1;
    while (end < s.messages.length && s.messages[end].role === 'tool') end += 1;
    // "Title (2)", a fork of that "Title (3)"
    const numbered = /^(.*) \((\d+)\)$/.exec(s.title ?? '');
    const title = numbered ? `${numbered[1]} (${Number(numbered[2]) + 1})` : `${(s.title || 'Chat').slice(0, 74)} (2)`;
    const t = this.create({ title, full: full && s.full, approvalMode: s.approvalMode, model: s.model && (s.model === REMOTE_MODEL ? this.remoteConfig() : this.llm?.modelInfo?.(s.model)) ? s.model : null, autoCompact: s.autoCompact, cwd: s.cwd, thinking: s.thinking, stepLimit: s.stepLimit, preset: s.preset });
    const copy = JSON.parse(JSON.stringify(s.messages.slice(0, end)));
    const checkpoints = [];
    for (const m of copy) {
      m.id = id();
      m.copied = true;
      delete m.rating;
      delete m.ratedAt;
      if (m.extra?.edit?.checkpoint) checkpoints.push(m.extra.edit.checkpoint);
    }
    // its own copies of the edits' backups: Undo works in the fork too
    for (const cp of checkpoints) {
      try {
        mkdirSync(this.checkpointFolder(t), { recursive: true });
        copyFileSync(join(this.checkpointFolder(s), `${cp}.json`), join(this.checkpointFolder(t), `${cp}.json`));
      } catch {
        /* too large to keep or already gone: no Undo */
      }
    }
    t.messages = copy;
    if ((s.trimmed ?? 0) <= end) Object.assign(t, { trimmed: s.trimmed ?? 0, summary: s.summary ?? '', leftOut: s.leftOut ?? 0 });
    else for (const m of t.messages) delete m.dropped;
    Object.assign(t, { loadedTools: [...(s.loadedTools ?? [])], mcpLoaded: [...(s.mcpLoaded ?? [])], forkOf: { chat: s.id, message: String(messageId) }, lastResponse: [...copy].reverse().find((m) => AgentManager.rateable(m))?.content ?? null });
    // the Always allow rules are a setting of the chat: the fork keeps them
    if (s.allow?.length) t.allow = s.allow.map((r) => ({ ...r }));
    this.save(t, true);
    this.emit(t, 'created', { summary: this.summary(t) });
    return { message: 'Chat forked.', chat: this.summary(t) };
  }

  /* ── Export and import (user request 08.10.2026) ── */

  /**
   * The chat as a file: json (format nedese-chat: the branch shown with its tool steps, thinking and summary; import
   * makes a chat of it again) or md (Markdown to read: who said what and when, the tool steps as quotes).
   * Returns { name, type, text }.
   */
  exportChat(chatId, format = 'json') {
    const s = this.get(chatId);
    const stem = String(s.title || 'chat').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'chat';
    const name = `${stem}-${String(s.creation ?? '').slice(0, 10)}`;
    if (format === 'md') return { name: `${name}.md`, type: 'text/markdown; charset=utf-8', text: AgentManager.markdown(s) };
    if (format !== 'json') throw new UserError('format must be json or md.');
    const data = {
      format: CHAT_FORMAT,
      version: 1,
      exported: new Date().toISOString(),
      chat: { title: s.title, creation: s.creation, update: s.update, model: s.model ?? null, thinking: s.thinking ?? 'low', preset: s.preset ? { name: s.preset.name } : null, summary: s.summary ?? '' },
      messages: s.messages,
    };
    return { name: `${name}.json`, type: 'application/json; charset=utf-8', text: `${JSON.stringify(data, null, 2)}\n` };
  }

  /** A chat as Markdown: headings for each speaker with the time (Istanbul), tool steps and summaries as quotes. */
  static markdown(s) {
    const when = (t) => (t && !Number.isNaN(Date.parse(t)) ? new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/Istanbul', dateStyle: 'medium', timeStyle: 'short' }) : '');
    const quote = (text) => String(text).split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
    const short = (text, n) => {
      const x = String(text ?? '').replace(/\s+/g, ' ').trim();
      return x.length > n ? `${x.slice(0, n)}…` : x;
    };
    const shown = s.messages.filter((m) => !m.hidden);
    const lines = [`# ${s.title || 'Chat'}`, '', `Exported from Nedese Studio on ${when(new Date().toISOString())} · ${shown.filter((m) => m.role === 'user').length} messages from you`, ''];
    let speaker = null;
    const heading = (who, time) => {
      lines.push(`## ${who}${time ? ` · ${when(time)}` : ''}`, '');
      speaker = who;
    };
    for (const m of shown) {
      if (m.role === 'user') {
        heading('You', m.time);
        if (m.content) lines.push(m.content, '');
        if (m.attachments?.length) lines.push(`Attachments: ${m.attachments.map((e) => (e.name ? `${e.name} (${e.source})` : e.source)).join(', ')}`, '');
      } else if (m.role === 'assistant') {
        if (m.content || speaker !== 'Nedese') heading('Nedese', m.time);
        if (m.content) lines.push(m.content, '');
        if (m.sources?.length) lines.push(`Sources: ${m.sources.map((x) => `[${new URL(x.url).hostname.replace(/^www\./, '')}](${x.url})`).join(' · ')}`, '');
        for (const c of m.toolCalls ?? []) lines.push(quote(`Tool ${c.name}: ${short(JSON.stringify(c.input ?? {}), 300)}`), '');
      } else if (m.role === 'tool') lines.push(quote(`${m.error ? 'Failed' : 'Result'} (${m.toolName}): ${short(m.content, 500)}`), '');
      else if (m.role === 'note' && m.kind === 'compact') lines.push(quote(`Summary of the earlier conversation: ${m.content}`), '');
    }
    return `${lines.join('\n').trim()}\n`;
  }

  /**
   * A new chat from an exported file (format nedese-chat) or from a plain list of { role, content } messages (the
   * OpenAI chat format; only its user and assistant texts). The messages come as they were, with new ids, no ratings
   * and like a fork's (the jobs they name stay where they are); tool steps only whole (a call with its result). The
   * title and the model (when it is here) come from the file; the approval mode, working folder and access are this
   * panel's, never the file's.
   */
  importChat(data, { full = false, approvalMode } = {}) {
    const file = Array.isArray(data) ? { messages: data } : data;
    if (!file || typeof file !== 'object' || !Array.isArray(file.messages)) throw new UserError('Not a chat file: expected an exported chat (format nedese-chat) or { messages: [{ role, content }] }.');
    if (file.format !== undefined && file.format !== CHAT_FORMAT) throw new UserError(`Unknown chat format: ${String(file.format).slice(0, 40)}`);
    if (file.messages.length > IMPORT_MESSAGE_LIMIT) throw new UserError(`A chat file holds at most ${IMPORT_MESSAGE_LIMIT} messages.`);
    const own = file.format === CHAT_FORMAT;
    const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('') : '').slice(0, IMPORT_TEXT_LIMIT);
    const messages = [];
    for (const m of file.messages) {
      if (!m || typeof m !== 'object') continue;
      const base = { id: id(), time: typeof m.time === 'string' && !Number.isNaN(Date.parse(m.time)) ? new Date(m.time).toISOString() : new Date().toISOString(), copied: true };
      if (m.role === 'user') {
        const attachments = own && Array.isArray(m.attachments) ? m.attachments.filter((e) => typeof e?.source === 'string').slice(0, 20).map((e) => ({ source: e.source, type: e.type === 'image' ? 'image' : 'file', ...(typeof e.name === 'string' && e.name ? { name: e.name.slice(0, 200) } : {}) })) : [];
        if (text(m.content) || attachments.length) messages.push({ ...base, role: 'user', content: text(m.content), attachments, ...(own && m.hidden ? { hidden: true } : {}) });
      } else if (m.role === 'assistant') {
        const calls = own && Array.isArray(m.toolCalls) ? m.toolCalls.filter((c) => c && typeof c.name === 'string' && c.id).map((c) => ({ id: String(c.id), name: c.name, input: c.input && typeof c.input === 'object' ? c.input : {} })) : [];
        const sources = own ? cleanSources(m.sources) : [];
        messages.push({ ...base, role: 'assistant', content: text(m.content), ...(calls.length ? { toolCalls: calls } : {}), ...(own && typeof m.reasoning === 'string' && m.reasoning ? { reasoning: m.reasoning.slice(0, IMPORT_TEXT_LIMIT) } : {}), ...(sources.length ? { sources } : {}), ...(m.error ? { error: true } : {}) });
      } else if (own && m.role === 'tool' && m.toolId) {
        // a file change keeps its diff; its Undo belonged to the chat it came from (the copy is not here)
        const extra = m.extra && typeof m.extra === 'object' && !Array.isArray(m.extra) ? { ...m.extra } : {};
        if (extra.edit && typeof extra.edit === 'object') extra.edit = { ...extra.edit, checkpoint: null };
        messages.push({ ...base, role: 'tool', toolId: String(m.toolId), toolName: String(m.toolName ?? ''), content: text(m.content), ...(m.error ? { error: true } : {}), ...(Object.keys(extra).length ? { extra } : {}) });
      } else if (own && m.role === 'note' && typeof m.kind === 'string') messages.push({ ...base, role: 'note', kind: m.kind, content: text(m.content) });
    }
    // tool steps whole: a call keeps its result and a result its call
    const results = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.toolId));
    const calls = new Set();
    for (const m of messages) {
      if (!m.toolCalls) continue;
      m.toolCalls = m.toolCalls.filter((c) => results.has(c.id));
      for (const c of m.toolCalls) calls.add(c.id);
      if (!m.toolCalls.length) delete m.toolCalls;
    }
    const kept = messages.filter((m) => (m.role !== 'tool' || calls.has(m.toolId)) && (m.role !== 'assistant' || m.content || m.toolCalls));
    if (!kept.some((m) => m.role === 'user' || m.role === 'assistant')) throw new UserError('The file has no messages to import.');
    const info = file.chat && typeof file.chat === 'object' ? file.chat : {};
    const model = typeof info.model === 'string' && info.model && (info.model === REMOTE_MODEL ? this.remoteConfig() : this.llm?.modelInfo?.(info.model)) ? info.model : null;
    const firstText = kept.find((m) => m.role === 'user')?.content ?? '';
    const title = String(info.title ?? file.title ?? '').trim().slice(0, 80) || firstText.replace(/\s+/g, ' ').slice(0, 60) || 'Imported chat';
    const s = this.create({ title, full, approvalMode, model, thinking: info.thinking });
    s.messages = kept;
    // a compacted chat goes on from its summary (the messages before it stay visible, out of the model's context)
    const compacted = kept.map((m) => m.role === 'note' && m.kind === 'compact').lastIndexOf(true);
    s.trimmed = compacted + 1;
    s.summary = compacted >= 0 ? String(info.summary || kept[compacted].content || '').slice(0, 2000) : '';
    s.lastResponse = [...kept].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? null;
    this.save(s, true);
    this.emit(s, 'created');
    return s;
  }

  /* ── File edits: a copy before every change (Undo on the card), the diff of the change ── */

  checkpointFolder(s) {
    return join(this.folder, 'checkpoints', typeof s === 'string' ? s : s.id);
  }

  /**
   * Records an edit the agent made: the previous bytes (null: the file did not exist) go to
   * panel-data/chat/checkpoints/<chat>/<id>.json, the result carries the diff for the card. Files over 5 MB get a diff
   * but no copy (no Undo).
   */
  recordEdit(s, path, before, after) {
    const binary = Boolean(before && before.subarray(0, 8000).includes(0));
    const diff = binary ? { text: '(binary file)', added: 0, removed: 0, truncated: false } : unifiedDiff(before ? before.toString('utf8') : null, after);
    const id = `cp${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    const keep = !before || before.length <= 5 * 2 ** 20;
    if (keep) {
      try {
        mkdirSync(this.checkpointFolder(s), { recursive: true });
        writeFileSync(join(this.checkpointFolder(s), `${id}.json`), JSON.stringify({ id, path, existed: Boolean(before), before: before ? before.toString('base64') : null, afterHash: createHash('sha1').update(after).digest('hex'), time: new Date().toISOString() }));
      } catch (e) {
        this.log(`[agent] could not keep a copy of ${path}: ${e.message}`);
        return { checkpoint: null, path, diff: diff.text, added: diff.added, removed: diff.removed, truncated: diff.truncated };
      }
    }
    return { checkpoint: keep ? id : null, path, diff: diff.text, added: diff.added, removed: diff.removed, truncated: diff.truncated };
  }

  /**
   * Undo of one edit: the file gets its previous content back (a file the agent created goes to the Recycle Bin). If
   * the file changed after the edit, force is needed (the later changes would be lost). The model learns it from a
   * note sent with the next message.
   */
  async undo(chatId, checkpoint, { force = false } = {}) {
    const s = this.get(chatId);
    if (s.status !== 'idle') throw new UserError('The chat is running; undo when it finishes (or stop it).', 'inUse');
    if (!/^cp[a-z0-9]+$/.test(String(checkpoint))) throw new UserError('No such change.', 'notFound');
    const file = join(this.checkpointFolder(s), `${checkpoint}.json`);
    if (!existsSync(file)) throw new UserError('No such change (it may be too old or too large to undo).', 'notFound');
    const cp = JSON.parse(readFileSync(file, 'utf8'));
    if (cp.undone) throw new UserError('This change was already undone.');
    const current = existsSync(cp.path) ? readFileSync(cp.path) : null;
    if (!force && (current === null || createHash('sha1').update(current).digest('hex') !== cp.afterHash)) throw new UserError('The file changed after this edit; undoing it would discard the later changes. Click again to undo anyway.', 'inUse');
    if (cp.existed) {
      mkdirSync(dirname(cp.path), { recursive: true });
      writeFileSync(cp.path, Buffer.from(cp.before, 'base64'));
    } else if (current !== null) await moveToRecycleBin(cp.path);
    cp.undone = new Date().toISOString();
    writeFileSync(file, JSON.stringify(cp));
    for (const m of s.messages) if (m.role === 'tool' && m.extra?.edit?.checkpoint === cp.id) m.extra.edit.undone = true;
    s.messages.push({ role: 'note', kind: 'undo', content: cp.existed ? `The user undid your change to ${cp.path}; its previous content is back.` : `The user undid the creation of ${cp.path}; the file was removed.`, checkpoint: cp.id, time: new Date().toISOString() });
    this.save(s, true);
    this.emit(s, 'undo', { checkpoint: cp.id, path: cp.path });
    return { message: cp.existed ? `Undone: ${cp.path}` : `Undone: ${cp.path} moved to the Recycle Bin.`, checkpoint: cp.id };
  }

  /* ── Rules (user request 08.10.2026: "md kuralı tanımlanabiliyor ve buna uyuluyor olması lazım") ── */

  get rulesFile() {
    return join(this.setting.dataRoot, DATA_FILES.rules);
  }

  /** Settings › Assistant rules: for every chat. */
  globalRules() {
    try {
      return readFileSync(this.rulesFile, 'utf8');
    } catch {
      return '';
    }
  }

  saveGlobalRules(text) {
    const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (clean.length > RULES_LIMIT) throw new UserError(`Rules are too long (at most ${RULES_LIMIT} characters).`);
    if (clean) writeFileSync(this.rulesFile, `${clean}\n`, 'utf8');
    else rmSync(this.rulesFile, { force: true });
    return { message: clean ? 'Rules saved; they apply from the next message of every chat.' : 'Rules cleared.', text: clean, path: this.rulesFile };
  }

  /* ── Assistant presets (user request 08.10.2026): a name, instructions added to the system prompt, text model,
   * thinking, approval mode and working folder a new chat starts with; panel-data/chat-presets.json ── */

  get presetFile() {
    return join(this.setting.dataRoot, DATA_FILES.presets);
  }

  presets() {
    try {
      const list = JSON.parse(readFileSync(this.presetFile, 'utf8'))?.presets;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  preset(presetId) {
    const p = this.presets().find((x) => x.id === String(presetId ?? ''));
    if (!p) throw new UserError('No such assistant preset.', 'notFound');
    return p;
  }

  /** Adds a preset, or with presetId changes the given fields of one (null or '' clears a setting: the default). */
  savePreset(g = {}, presetId = null) {
    const list = this.presets();
    const old = presetId ? this.preset(presetId) : null;
    if (!old && list.length >= PRESET_LIMIT) throw new UserError(`At most ${PRESET_LIMIT} presets.`);
    const pick = (key) => (g[key] !== undefined ? g[key] : old?.[key] ?? null);
    const name = String(pick('name') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw new UserError('Give the preset a name.');
    if (list.some((x) => x.id !== old?.id && x.name.toLowerCase() === name.toLowerCase())) throw new UserError(`A preset named "${name}" already exists.`);
    const prompt = String(pick('prompt') ?? '').replace(/\r\n/g, '\n').trim();
    if (prompt.length > PRESET_PROMPT_LIMIT) throw new UserError(`The instructions are too long (at most ${PRESET_PROMPT_LIMIT} characters).`);
    const thinking = pick('thinking') || null;
    if (thinking && THINKING_BUDGET[thinking] === undefined) throw new UserError('thinking must be none, low, medium or high.');
    const cwd = String(pick('cwd') ?? '').trim() || null;
    if (cwd && !existsSync(cwd)) throw new UserError('Working folder does not exist.');
    const preset = { id: old?.id ?? id(), name, prompt, model: this.checkModel(pick('model')), thinking, approvalMode: pick('approvalMode') ? AgentManager.approvalMode(pick('approvalMode')) : null, cwd, update: new Date().toISOString() };
    const next = old ? list.map((x) => (x.id === old.id ? preset : x)) : [...list, preset];
    next.sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(this.presetFile, JSON.stringify({ presets: next }, null, 2));
    return { message: old ? 'Preset saved.' : 'Preset added.', preset };
  }

  deletePreset(presetId) {
    const p = this.preset(presetId);
    writeFileSync(this.presetFile, JSON.stringify({ presets: this.presets().filter((x) => x.id !== p.id) }, null, 2));
    return { message: 'Preset deleted.' };
  }

  /* ── Prompt templates (user request 08.10.2026): saved prompts the composer offers under "/"; {{name}} marks a
   * variable the user fills in when picking one; panel-data/prompt-templates.json ── */

  get templateFile() {
    return join(this.setting.dataRoot, DATA_FILES.templates);
  }

  templates() {
    try {
      const list = JSON.parse(readFileSync(this.templateFile, 'utf8'))?.templates;
      return Array.isArray(list) ? list.map((t) => ({ ...t, variables: AgentManager.templateVariables(t.text) })) : [];
    } catch {
      return [];
    }
  }

  /** The {{variables}} of a template's text, each once, in order. */
  static templateVariables(text) {
    return [...new Set([...String(text ?? '').matchAll(/\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g)].map((m) => m[1]))];
  }

  template(templateId) {
    const t = this.templates().find((x) => x.id === String(templateId ?? ''));
    if (!t) throw new UserError('No such prompt template.', 'notFound');
    return t;
  }

  /** Adds a template, or with templateId changes the given fields of one. name: what follows "/" in the composer. */
  saveTemplate(g = {}, templateId = null) {
    const list = this.templates();
    const old = templateId ? this.template(templateId) : null;
    if (!old && list.length >= TEMPLATE_LIMIT) throw new UserError(`At most ${TEMPLATE_LIMIT} templates.`);
    const pick = (key) => (g[key] !== undefined ? g[key] : old?.[key] ?? null);
    const name = String(pick('name') ?? '').trim().replace(/^\//, '');
    if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(name)) throw new UserError('The name is what follows "/" in the composer: 1 to 40 letters, digits, - or _ (no spaces).');
    if (CHAT_COMMANDS.includes(name.toLowerCase())) throw new UserError(`"/${name}" is a command of the composer; choose another name.`);
    if (list.some((x) => x.id !== old?.id && x.name.toLowerCase() === name.toLowerCase())) throw new UserError(`A template named "/${name}" already exists.`);
    const text = String(pick('text') ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new UserError('Write the text of the template.');
    if (text.length > TEMPLATE_TEXT_LIMIT) throw new UserError(`The text is too long (at most ${TEMPLATE_TEXT_LIMIT} characters).`);
    const description = String(pick('description') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const template = { id: old?.id ?? id(), name, description, text, update: new Date().toISOString() };
    const next = (old ? list.map((x) => (x.id === old.id ? template : x)) : [...list, template]).map(({ variables: _v, ...t }) => t);
    next.sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(this.templateFile, JSON.stringify({ templates: next }, null, 2));
    return { message: old ? 'Template saved.' : 'Template added.', template: { ...template, variables: AgentManager.templateVariables(text) } };
  }

  deleteTemplate(templateId) {
    const t = this.template(templateId);
    writeFileSync(this.templateFile, JSON.stringify({ templates: this.templates().filter((x) => x.id !== t.id).map(({ variables: _v, ...x }) => x) }, null, 2));
    return { message: 'Template deleted.' };
  }

  /**
   * Rules a chat must follow: the panel's rules, then the project's rule files from the working folder up to the drive
   * root (nearest first; at most 8 KB each, 20 KB in all). [{ source, path, text }]
   */
  rules(s) {
    const out = [];
    let total = 0;
    const add = (source, path, text) => {
      const clean = String(text ?? '').trim().slice(0, RULE_FILE_LIMIT);
      if (!clean || total >= RULES_LIMIT) return;
      out.push({ source, path, text: clean.slice(0, RULES_LIMIT - total) });
      total += clean.length;
    };
    add('Settings › Assistant rules', this.rulesFile, this.globalRules());
    let folder = resolve(s.cwd ?? this.setting.aiRoot);
    for (let depth = 0; depth < 8; depth++) {
      for (const name of RULE_FILES) {
        const path = join(folder, name);
        try {
          if (statSync(path).isFile()) add(name, path, readFileSync(path, 'utf8'));
        } catch {
          /* no such file */
        }
      }
      const up = dirname(folder);
      if (up === folder) break;
      folder = up;
    }
    return out;
  }

  /**
   * A final answer's pictures from other sites (Markdown images with an http(s) address, at most 4) are fetched with
   * show_image into the gallery and the answer points to the panel's copy; a picture that cannot be fetched keeps its
   * address. Returns the text and the gallery jobs made.
   */
  async ownPictures(s, text, signal) {
    const tool = TOOLS.find((t) => t.name === 'show_image');
    const found = [...String(text).matchAll(/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g)].slice(0, 4);
    const pictures = [];
    const missing = [];
    // what the picture should show: its caption, else the user's request; the address is tried first, then a search
    const request = [...s.messages].reverse().find((m) => m.role === 'user' && !m.hidden)?.content ?? '';
    for (const [whole, caption, url] of found) {
      if (signal?.aborted) break;
      try {
        const query = (caption.trim().length >= 3 ? caption : String(request)).trim().slice(0, 120);
        const r = await tool.run({ url, caption, ...(query ? { query } : {}) }, this.toolContext(s, signal));
        const own = /!\[[^\]\n]*\]\((\/file\/job\/[^)\s]+)\)/.exec(r.text)?.[1];
        if (!own || !r.extra?.job) continue;
        text = text.replace(whole, `![${caption}](${own})`);
        pictures.push(r.extra.job);
      } catch (e) {
        this.log(`[agent ${s.id}] picture not fetched (${url}): ${e.message}`);
        // a picture that is not there leaves the answer (Gemma showed an invented i.imgur.com address, 08.10.2026); one
        // the site only refused to the panel stays, the browser may still show it
        if (e.gone) {
          text = text.replace(whole, '').replace(/\n{3,}/g, '\n\n').trim();
          missing.push({ url, error: e.message });
        }
      }
    }
    return { text, pictures, missing };
  }

  /** Jobs the chat created (panel_api POST /jobs); jobs it only looked at or waited for are not its own. */
  createdJobs(s) {
    if (typeof s === 'string') s = this.get(s);
    // every branch; messages copied from another chat (fork) made that chat's jobs
    const messages = AgentManager.storedMessages(s).filter((m) => !m.copied);
    const calls = new Map(messages.flatMap((m) => (m.toolCalls ?? []).map((c) => [c.id, c])));
    const ids = new Set(messages.flatMap((m) => m.pictures ?? []));
    for (const m of messages) {
      if (m.role !== 'tool' || !m.extra?.job || m.error) continue;
      // a picture show_image fetched from the web is a gallery job of the chat
      if (m.toolName === 'show_image') {
        ids.add(m.extra.job);
        continue;
      }
      if (m.toolName !== 'panel_api') continue;
      const input = calls.get(m.toolId)?.input ?? {};
      if (String(input.method ?? '').toUpperCase() === 'POST' && /^(\/api\/v1)?\/jobs\/?$/.test(String(input.path ?? '').split('?')[0])) ids.add(m.extra.job);
    }
    return [...ids];
  }

  /**
   * Deletes the chat, its sub-agent chats and (unless keepOutputs) the jobs they created with their files (user request
   * 08.10.2026: "chatte üretilenleri de silmeli"). A running job is cancelled first; if it does not stop within 15 s it
   * stays and is reported.
   */
  async remove(id, { keepOutputs = false } = {}) {
    const s = this.get(id);
    let deleted = 0;
    const kept = [];
    // the sub-agent chats: in the list (saved) and in memory only (a temporary chat's)
    const temporaryChildren = [...this.chats.values()].filter((c) => c.parent === s.id && c.temporary).map((c) => c.id);
    for (const sub of [...new Set([...this.db.chatChildren(s.id), ...temporaryChildren])]) {
      if (!this.peek(sub)) {
        this.db.deleteChat(sub);
        continue;
      }
      const r = await this.remove(sub, { keepOutputs });
      deleted += r.deletedJobs;
      kept.push(...r.keptJobs);
    }
    // what runs for it now stops with it (its step, sub-agents, background commands, monitors); its watches and
    // wake-ups stay and go on in a new "⏰" chat when they fire (a temporary chat that is left is deleted)
    this.stopBackground(s.id, { live: true });
    if (s.work) this.stopStep(s);
    s.deleted = true;
    this.chats.delete(s.id);
    clearTimeout(this.recordTimer.get(s.id));
    this.recordTimer.delete(s.id);
    rmSync(join(this.folder, `${s.id}.json`), { force: true });
    rmSync(this.checkpointFolder(s), { recursive: true, force: true });
    try {
      this.db.deleteChat(s.id);
      // the files attached in it leave Knowledge with it (the ones added in the Knowledge window stay)
      this.knowledge?.removeChat(s.id);
    } catch (e) {
      this.log(`[agent] could not remove session ${s.id} from the index: ${e.message}`);
    }
    this.events.emit('event', { chat: s.id, type: 'deleted', time: new Date().toISOString() });
    if (!keepOutputs) {
      for (const job of this.createdJobs(s)) {
        try {
          let status = this.h.job(job).status;
          if (status === 'running' || status === 'waiting') {
            this.h.cancelJob(job);
            for (let i = 0; i < 30 && this.h.job(job).status === 'running'; i++) await wait(500);
            status = this.h.job(job).status;
          }
          if (status === 'running') {
            kept.push(job);
            continue;
          }
          await this.h.deleteJob(job);
          deleted += 1;
        } catch (e) {
          // already deleted from the gallery: nothing to do
          if (!/not found/i.test(e.message)) {
            kept.push(job);
            this.log(`[agent] could not delete job ${job} of chat ${s.id}: ${e.message}`);
          }
        }
      }
    }
    const stays = keepOutputs && this.createdJobs(s).length ? ' What it produced stays in the gallery.' : '';
    const message = `Chat deleted${deleted ? `, with ${deleted} job${deleted === 1 ? '' : 's'} it created` : ''}.${stays}${kept.length ? ` Not deleted (still running or locked): ${kept.join(', ')}.` : ''}`;
    return { message, deletedJobs: deleted, keptJobs: kept };
  }

  /**
   * Chat settings, also while it runs (they apply from the next model call or tool). A pending approval that the new
   * approval mode no longer needs is accepted right away.
   */
  applyUpdate(id, { title, approvalMode, unattended, model, autoCompact, thinking, stepLimit, cwd, pinned, archived, temporary, knowledge, allow } = {}) {
    const s = this.get(id);
    // the Always allow rules (chat Options lists them to remove one): the whole list, checked before anything changes
    if (allow !== undefined) {
      if (allow !== null && !Array.isArray(allow)) throw new UserError('allow must be a list of rules.');
      const rules = (allow ?? []).map(cleanRule);
      if (rules.some((r) => !r)) throw new UserError('An allow rule needs tool, and for a command its program, for panel_api its method and path.');
      const unique = rules.filter((r, i) => rules.findIndex((x) => sameRule(x, r)) === i);
      if (unique.length) s.allow = unique;
      else delete s.allow;
    }
    // the Knowledge documents this chat searches: a list of ids (or names), or null / [] for all of them
    if (knowledge !== undefined) {
      const list = Array.isArray(knowledge) ? knowledge : knowledge === null ? [] : [knowledge];
      const ids = list.length && this.knowledge ? this.knowledge.match(list) : [];
      if (list.length && !ids.length) throw new UserError('None of these documents is in Knowledge.');
      if (ids.length) s.knowledge = ids;
      else delete s.knowledge;
    }
    // A temporary chat is kept with temporary: false (it is saved from then on, with its sub-agents); it cannot be
    // made temporary again. Pinned and archived (user request 08.10.2026) exclude each other.
    if (temporary === false && s.temporary) {
      for (const x of [s, ...[...this.chats.values()].filter((c) => c.parent === s.id && c.temporary)]) {
        delete x.temporary;
        this.save(x, true);
      }
    } else if (temporary === true && !s.temporary) throw new UserError('A saved chat cannot become temporary.');
    if ((pinned !== undefined || archived !== undefined) && s.temporary) throw new UserError('A temporary chat cannot be pinned or archived: keep it first.');
    if (pinned !== undefined) {
      s.pinned = Boolean(pinned);
      if (s.pinned) s.archived = false;
    }
    if (archived !== undefined) {
      s.archived = Boolean(archived);
      if (s.archived) s.pinned = false;
    }
    if (title !== undefined) s.title = String(title).slice(0, 80);
    if (approvalMode !== undefined || unattended !== undefined) s.approvalMode = AgentManager.approvalMode(approvalMode, unattended, s.approvalMode);
    if (model !== undefined) s.model = this.checkModel(model);
    if (autoCompact !== undefined) s.autoCompact = Boolean(autoCompact);
    if (thinking !== undefined && THINKING_BUDGET[thinking] !== undefined) s.thinking = thinking;
    if (stepLimit !== undefined) s.stepLimit = stepLimit ? Math.max(1, Math.min(500, Number(stepLimit))) : null;
    if (cwd !== undefined && s.full) {
      if (!existsSync(String(cwd))) throw new UserError('Working folder does not exist.');
      s.cwd = String(cwd);
    }
    const pending = s.work?.approval;
    if (pending && (!needsApproval(s.approvalMode, pending.risk) || allowedBy(this.allowOf(s), pending.tool, pending.input, this.routes, pending.risk))) pending.ok({ yes: true, auto: true });
    // pinned and archived move the chat in the list (panel.db) at once
    this.save(s, pinned !== undefined || archived !== undefined);
    // "chat" is the event's own chat id field: the new settings travel as summary
    this.emit(s, 'update', { summary: this.summary(s) });
    return this.summary(s);
  }

  emit(s, type, data = {}) {
    s.update = new Date().toISOString();
    this.events.emit('event', { chat: s.id, type, time: s.update, ...data });
  }

  /* ── Message and loop ── */

  /** Adds the user's message to the session (checked at once: an empty message, a running session 409); starts the loop. */
  addMessage(id, { text = '', attachments = [] } = {}) {
    const s = this.get(id);
    if (s.status !== 'idle') throw new UserError('Chat is currently running; wait for it to finish or stop it.', 'inUse');
    s.messages.push(this.userMessage(s, { text, attachments }));
    this.emit(s, 'message', { message: s.messages.at(-1) });
    return s;
  }

  /**
   * Access of the device that sends a message: a chat opened with fewer rights gets the file and command tools (from
   * its next run); a device without them cannot drive a chat that has them (403).
   */
  setAccess(id, full) {
    const s = this.get(id);
    if (full && !s.full) {
      s.full = true;
      this.save(s);
    } else if (!full && s.full) throw new UserError('This chat can use files and commands: continue it from this computer or with the API key, or allow other devices (Settings › Assistant rules).', 'forbidden');
  }

  /** A checked user message (empty message, missing text model: errors); names an unnamed chat. */
  userMessage(s, { text = '', attachments = [] } = {}) {
    const clean = String(text ?? '').trim();
    // name: the file's own name (an upload is stored as "<time>-file-<slug>.pdf"); the chat and the model show it
    const named = (e) => (typeof e?.name === 'string' && e.name.trim() ? { name: e.name.trim().slice(0, 200) } : {});
    const extraList = (Array.isArray(attachments) ? attachments : []).map((e) => ({ source: String(e?.source ?? e), type: e?.type ?? (/\.(png|jpe?g|webp)$/i.test(String(e?.source ?? e)) ? 'image' : 'file'), ...named(e) })).filter((e) => sourcePath(this.setting, e.source));
    if (!clean && !extraList.length) throw new UserError('Message is empty.');
    if (!this.llm?.installed) throw new UserError('Text model is not installed (<ai>\\llm); chat runs on the local text model.');
    if (!s.title) s.title = (clean || extraList[0]?.source || 'Chat').replace(/\s+/g, ' ').slice(0, 60);
    this.indexAttachments(s, extraList);
    return { id: id(), role: 'user', content: clean, attachments: extraList, time: new Date().toISOString() };
  }

  /**
   * A chat's files with text go into Knowledge (user request 08.10.2026), after the message is taken (a large document
   * does not hold it up); search_knowledge finds them later, also from other chats. A temporary chat leaves nothing.
   */
  indexAttachments(s, attachments) {
    if (!this.knowledge || s.temporary) return;
    const files = attachments.filter((e) => e.type !== 'image' && e.type !== 'music');
    if (!files.length) return;
    setImmediate(() => {
      for (const e of files) {
        const path = sourcePath(this.setting, e.source);
        if (!path || !existsSync(path) || !readableKind(path)) continue;
        try {
          this.knowledge.add({ source: e.source, name: e.name, origin: 'chat', chat: s.id });
        } catch (err) {
          this.log(`[agent ${s.id}] ${e.source} could not go into Knowledge: ${err.message}`);
        }
      }
    });
  }

  /**
   * A message while the chat runs (user request 08.10.2026: "Stoplamadan ikinciyi yazamıyorum"): it waits in the
   * inbox and the model reads it at its next step, after the tool that is running; a run that ends (answer, stop,
   * error) with messages still waiting goes on with them. A waiting question takes it as the answer.
   */
  queueMessage(id, g = {}) {
    const s = this.get(id);
    if (!s.work) throw new UserError('Chat is not running; send the message normally.', 'inUse');
    const message = this.userMessage(s, g);
    if (s.work.question && message.content && !message.attachments.length) {
      this.answer(id, null, message.content);
      return { answered: true, chat: s };
    }
    (s.work.inbox ??= []).push(message);
    this.emit(s, 'message', { message, queued: true });
    return { queued: true, chat: s };
  }

  /** Waiting messages into the conversation (between steps, where the model reads them next). */
  takeInbox(s) {
    const inbox = s.work?.inbox;
    if (!inbox?.length) return false;
    s.messages.push(...inbox.splice(0));
    this.emit(s, 'inbox', { count: s.messages.length });
    return true;
  }

  /** Message + loop; returns with the text of the last answer. */
  sendMessage(id, g) {
    return this.run(this.addMessage(id, g));
  }

  async run(s) {
    // suggestions for the last answer are not needed any more: the GPU goes to this run
    this.followUpRuns.get(s.id)?.control.abort();
    const control = new AbortController();
    s.work = { control, approval: null, progress: null, usage: { input: 0, output: 0 }, started: Date.now(), tool: null };
    s.status = 'running';
    s.error = null;
    s.step = 0;
    const task = this.tasks?.add({ type: s.agent ? 'agent' : 'chat', title: s.title });
    task?.signal.addEventListener('abort', () => control.abort(), { once: true });
    this.emit(s, 'start');
    // a sub-agent's state is a line of its parent's background list
    if (s.parent) this.backgroundChanged(s.parent);
    let response = '';
    try {
      response = await this.loop(s, control.signal);
    } catch (e) {
      if (control.signal.aborted || e instanceof CancelError) {
        response = '';
        s.messages.push({ id: id(), role: 'assistant', content: '(stopped)', time: new Date().toISOString(), stopped: true });
      } else {
        s.error = e.message;
        this.log(`[agent ${s.id}] error: ${e.message}`);
        s.messages.push({ id: id(), role: 'assistant', content: `Error: ${e.message}`, time: new Date().toISOString(), error: true });
        this.emit(s, 'error', { error: e.message });
      }
    } finally {
      task?.finish();
      if (s.deleted) return response;
      const waiting = s.work?.inbox ?? [];
      s.status = 'idle';
      s.work = null;
      s.lastResponse = response || s.lastResponse;
      // Messages sent after the last step (or before a stop/error) start the next run
      if (waiting.length) s.messages.push(...waiting);
      this.save(s, true);
      this.emit(s, 'done', { response, error: s.error });
      if (waiting.length) setImmediate(() => s.status === 'idle' && this.run(s).catch(() => {}));
      // messages from the background that waited for the chat to finish (a watch that fired, a command that ended)
      else setImmediate(() => this.idle(s));
      if (s.parent) this.backgroundChanged(s.parent);
    }
    return response;
  }

  /**
   * Stop (user request 09.10.2026: "Ajan durdurulabilmeli"): the running step and everything the chat runs in the
   * background (sub-agents, also when this chat is idle; background commands with their process trees; watches,
   * monitors and wake-ups); what was stopped never wakes the chat. The message says what stopped.
   */
  stop(id) {
    const s = this.get(id);
    const stopped = this.stopBackground(s.id);
    const what = AgentManager.stoppedText(stopped);
    if (!s.work) return { message: stopped.length ? `Stopped: ${what}.` : 'Chat is already idle.', stopped };
    this.stopStep(s);
    return { message: stopped.length ? `Stopping. Also stopped: ${what}.` : 'Stopping.', stopped };
  }

  /** Only the step that runs (the panel closing; a deleted chat's background is stopped apart). */
  stopStep(s) {
    if (!s.work) return;
    s.work.approval?.ok({ yes: false, stopped: true });
    s.work.question?.ok({ answered: false, stopped: true });
    s.work.control.abort();
  }

  /** always: approve and keep the rules the approval offered (Always allow): calls like it run without asking from now on. */
  approve(id, approvalId, yes, { always = false } = {}) {
    const s = this.get(id);
    const o = s.work?.approval;
    if (!o || o.id !== String(approvalId)) throw new UserError('No pending approval (it may have expired).', 'notFound');
    if (yes && always) {
      if (!o.allow?.length) throw new UserError('This action cannot be allowed for good; approve it once.');
      const rules = s.allow ?? [];
      s.allow = [...rules, ...o.allow.filter((r) => !rules.some((x) => sameRule(x, r)))];
      this.save(s, true);
      this.emit(s, 'update', { summary: this.summary(s) });
    }
    o.ok({ yes: Boolean(yes) });
    return { message: !yes ? 'Rejected.' : always ? 'Approved; calls like this run without asking in this chat from now on.' : 'Approved.' };
  }

  /** The Always allow rules a chat's calls follow: its own and those of the chats it works for (a sub-agent's parents). */
  allowOf(s) {
    const rules = [...(s.allow ?? [])];
    let parent = s.parent ? this.peek(s.parent) : null;
    for (let depth = 0; parent && depth < 10; depth += 1) {
      for (const r of parent.allow ?? []) if (!rules.some((x) => sameRule(x, r))) rules.push(r);
      parent = parent.parent ? this.peek(parent.parent) : null;
    }
    return rules;
  }

  tools(s) {
    // search_knowledge only while Knowledge has documents (it is not offered for an empty list)
    const knowledge = Boolean(this.knowledge?.count());
    return [...TOOLS.filter((a) => (!a.full || s.full) && (!a.ask || s.canAsk !== false) && (a.group !== 'knowledge' || knowledge)), ...this.mcpTools(s)];
  }

  /** "12 documents", or "2 of 12 documents chosen for this chat" (chat Options › Knowledge). */
  knowledgeLabel(s) {
    const n = this.knowledge?.count() ?? 0;
    const chosen = s.knowledge?.length ? this.knowledge.match(s.knowledge).length : 0;
    return chosen ? `${chosen} of ${n} documents chosen for this chat` : `${n} document${n === 1 ? '' : 's'}`;
  }

  /**
   * The functions of the MCP servers this chat loaded (load_tools with a server name, mcp_tools, add_mcp_server): one
   * per tool with its own input schema (user request 08.10.2026: before, one call_mcp took every tool's input as an
   * object and mcp_tools showed the inputs cut at 600 characters). Only full-access chats; a server whose tool list
   * is not fetched yet in this run of the panel adds none until ensureMcp fetches it.
   */
  mcpTools(s) {
    if (!s.full || !s.mcpLoaded?.length) return [];
    const known = this.mcp.servers();
    const out = [];
    for (const server of s.mcpLoaded) {
      const list = known[server] ? this.mcp.cachedTools(server) : null;
      if (list) out.push(...nativeMcpTools(server, list).native.map(mcpTool));
    }
    return out;
  }

  /**
   * An mcp__<server>__<tool> call whose server's list is not at hand (it did not start for ensureMcp, or the model
   * remembered the name from earlier): the call goes to the server as call_mcp would send it. null for other names.
   */
  mcpByName(s, name) {
    const m = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ''));
    if (!m || !s.full || !this.mcp.servers()[m[1]]) return null;
    return mcpTool({ name, server: m[1], tool: m[2], description: '', params: { type: 'object', properties: {} }, annotations: null });
  }

  /** The loaded servers' tool lists before a model call (a restarted panel has none yet); a server that fails is dropped. */
  async ensureMcp(s) {
    for (const server of [...(s.mcpLoaded ?? [])]) {
      if (this.mcp.cachedTools(server)) continue;
      try {
        if (!this.mcp.servers()[server]) throw new Error('it is no longer defined');
        await this.mcp.client(server).toolList();
      } catch (e) {
        s.mcpLoaded = s.mcpLoaded.filter((x) => x !== server);
        this.log(`[agent ${s.id}] MCP server ${server} left the chat's tools: ${e.message}`);
      }
    }
  }

  /**
   * Starts an MCP server and makes its tools functions of the chat; returns what the model reads: the server's
   * instructions, the function names, and the tools over the limits with their inputs for call_mcp.
   */
  async loadMcp(s, server) {
    if (!s.full) throw new Error('MCP servers can be used only in a chat opened from this computer or with an API key.');
    const client = this.mcp.client(server);
    const list = await client.toolList();
    if (!(s.mcpLoaded ?? []).includes(server)) s.mcpLoaded = [...(s.mcpLoaded ?? []), server];
    const { native, rest } = nativeMcpTools(server, list);
    const lines = [`MCP server "${server}": ${native.length === 1 ? '1 tool is now a function' : `${native.length} tools are now functions`} of this chat (call them directly from your next step): ${native.map((t) => t.name).join(', ') || '(none)'}.`];
    if (rest.length) lines.push(`Not loaded as functions (use call_mcp with server "${server}"):\n${rest.map((a) => `- ${a.name}: ${String(a.description ?? '').replace(/\s+/g, ' ').slice(0, 200)}\n  input: ${JSON.stringify(a.inputSchema?.properties ?? {}).slice(0, 1500)}${a.inputSchema?.required?.length ? ` required: ${a.inputSchema.required.join(', ')}` : ''}`).join('\n')}`);
    const said = mcpInstructions(server, client).replace(/\n\nTools:\n$/, '');
    return `${said ? `${said}\n\n` : ''}${lines.join('\n\n')}`;
  }

  /**
   * ask_user: the chat waits in the "question" state until the user answers (a card in the chat, the CLI, POST
   * /chat/{id}/answer), stops it, or an hour passes. { answered, answer }
   */
  askUser(s, question, options, signal) {
    return new Promise((ok) => {
      const q = { id: id(), question, options, ok: null };
      let done = false;
      const timer = setTimeout(() => finish({ answered: false }), APPROVAL_WAIT_MS);
      const cancel = () => finish({ answered: false, stopped: true });
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (s.work) {
          s.work.question = null;
          s.status = 'running';
        }
        this.emit(s, 'question_done', { id: q.id, answer: v.answer ?? null });
        ok(v);
      };
      q.ok = finish;
      signal?.addEventListener('abort', cancel, { once: true });
      s.work.question = q;
      s.status = 'question';
      this.emit(s, 'question', { id: q.id, question, options });
    });
  }

  answer(chatId, questionId, answer) {
    const s = this.get(chatId);
    const q = s.work?.question;
    if (!q || (questionId && q.id !== String(questionId))) throw new UserError('No question is waiting for an answer.', 'notFound');
    const text = String(answer ?? '').trim();
    if (!text) throw new UserError('The answer is empty.');
    q.ok({ answered: true, answer: text.slice(0, 4000) });
    return { message: 'Answer sent.' };
  }

  async loop(s, signal) {
    const limit = s.stepLimit ?? AGENT_STEPS;
    let lastText = '';
    while (true) {
      if (signal.aborted) throw new CancelError();
      if (s.step >= limit) {
        const m = `Step limit reached (${limit}). Write if you want me to continue.`;
        s.messages.push({ id: id(), role: 'assistant', content: m, time: new Date().toISOString() });
        this.emit(s, 'text', { text: m, id: s.messages.at(-1).id, final: true });
        return m;
      }
      this.takeInbox(s);
      await this.ensureMcp(s);
      await this.contextFit(s, signal);
      // the tools of this chat (core + loaded) for every call: load_tools may have added some
      const r = await this.callModel(s, this.activeTools(s), signal);
      if (r.cut) this.salvageWrite(r, s);
      // the thinking goes with the message it led to (shown folded; translateMessages never sends it to the model)
      const thought = r.reasoning ? { reasoning: r.reasoning } : {};
      if (!r.calls.length && r.cut && (s.work.cuts ?? 0) < 2) {
        // Stopped at the output limit (often a tool call that did not fit): the model is told and goes on in parts
        s.work.cuts = (s.work.cuts ?? 0) + 1;
        if (r.text) {
          s.messages.push({ id: id(), role: 'assistant', content: r.text, cut: true, ...thought, time: new Date().toISOString() });
          this.emit(s, 'text', { text: r.text, id: s.messages.at(-1).id, ...thought });
        }
        // Seen live (08.10.2026): Gemma wrote a whole 1452-line redesign into its answer (46k characters, 4.5 minutes),
        // was cut, the answer filled the context, the chat was compacted and it started again. The model gets the
        // answer back short (modelText) and is told where files go.
        const fileInAnswer = r.text.length > CUT_ANSWER_KEEP && /```/.test(r.text);
        const note = fileInAnswer
          ? `[Your last answer was cut off at the output limit (${r.text.length} characters) and nothing was saved: you wrote a file's content into the answer. Never put a file's content in the answer; files are written with write_file. Write a big file in parts of about 250 lines: write_file for the first part, then write_file with append: true for each next part. To change a big existing file: copy it (run_command Copy-Item), then change only the needed parts of the copy with edit_file.]`
          : '[Your last answer was cut off at the output limit before it was complete. Go on in smaller steps: write a long file in parts (write_file, then write_file with append: true), change only the needed parts with edit_file, read large files in parts.]';
        s.messages.push({ role: 'user', hidden: true, content: note, time: new Date().toISOString() });
        this.save(s);
        continue;
      }
      // Finishing right after a failed call: once per run the model is sent back to fix it or say what did not get done
      // (Gemma's redesign script failed and it answered that the page was redesigned; the file was the old one, 08.10.2026)
      const lastResult = s.messages.at(-1);
      if (!r.calls.length && lastResult?.role === 'tool' && lastResult.error && !s.work.failedEndNoted) {
        s.work.failedEndNoted = true;
        s.messages.push({ role: 'user', hidden: true, content: `[Your last tool call failed (${String(lastResult.content).split('\n')[0].slice(0, 200)}) and you were about to finish. First fix it and check the result, or tell the user plainly what did not get done. Never say something is done when it is not.]`, time: new Date().toISOString() });
        this.save(s);
        continue;
      }
      // Finishing with a tool written but not installed: twice per run the model is sent back to install and test it
      // (10.10.2026: after one note its install_skill call was wrong and it answered "installed" anyway)
      const notInstalled = !r.calls.length && (s.work.installNoted ?? 0) < 2 ? uninstalledTools(s.messages) : [];
      if (notInstalled.length) {
        s.work.installNoted = (s.work.installNoted ?? 0) + 1;
        const how = (t) => (t.server ? `panel-data\\tools\\${t.folder} holds an MCP server script: add it with add_mcp_server (command: python, args: [the script's path]; install_skill does not start a server)` : `panel-data\\tools\\${t.folder}: install_skill with source = that folder (its SKILL.md starts with front matter: ---, name: …, description: …, ---), or add_mcp_server if it is an MCP server script`);
        s.messages.push({ role: 'user', hidden: true, content: `[You wrote a tool but did not install it, so it is not available. Install it now: ${notInstalled.map(how).join('; ')}. Then test it with one real call. If you do not keep it, tell the user plainly that nothing was installed. Never say a tool is installed when it is not.]`, time: new Date().toISOString() });
        this.save(s);
        continue;
      }
      if (!r.calls.length) {
        // pictures the answer shows from other sites are fetched into the gallery and shown from the panel (Gemma put
        // an i.redd.it address in its answer instead of calling show_image, 08.10.2026)
        const { text: m, pictures, missing } = await this.ownPictures(s, r.text || '(empty answer)', signal);
        // the pages the turn read or found on the web go with the answer (shown as source links under it)
        const sources = turnSources(s.messages);
        const cited = sources.length ? { sources } : {};
        s.messages.push({ id: id(), role: 'assistant', content: m, ...thought, ...(pictures.length ? { pictures } : {}), ...cited, time: new Date().toISOString() });
        // final: the answer of this turn (the chat offers rating on it)
        this.emit(s, 'text', { text: m, id: s.messages.at(-1).id, final: true, ...thought, ...cited });
        this.save(s);
        // pictures that are not there: once per run the model is sent back for real ones
        if (missing.length && !s.work.picturesNoted) {
          s.work.picturesNoted = true;
          s.messages.push({ role: 'user', hidden: true, content: `[These pictures in your answer could not be shown, so they were left out: ${missing.map((x) => `${x.url} (${x.error})`).join('; ')}. Never write an image address yourself: call show_image with query = what the picture should show (other words, in English too) and answer again with the line it returns.]`, time: new Date().toISOString() });
          this.save(s);
          continue;
        }
        // A message arrived while the model wrote this answer: it is answered in the same run
        if (s.work?.inbox?.length) continue;
        return m;
      }
      s.step += 1;
      const calls = r.calls.map((c, i) => ({ id: c.id ?? `c${s.step}_${i}`, name: c.name, input: c.input ?? {}, ...(r.cut ? { cut: true } : {}), ...(c.salvaged ? { salvaged: c.salvaged } : {}) }));
      s.messages.push({ id: id(), role: 'assistant', content: r.text, toolCalls: calls, raw: r.raw, ...thought, time: new Date().toISOString() });
      if (r.text) this.emit(s, 'text', { text: r.text, id: s.messages.at(-1).id, ...thought });
      lastText = r.text;
      for (const c of calls) {
        if (signal.aborted) throw new CancelError();
        this.emit(s, 'tool', { id: c.id, name: c.name, input: c.input, step: s.step });
        const startedAt = Date.now();
        s.work.tool = c.name;
        // the chat's tools now: load_tools, mcp_tools or add_mcp_server earlier in this step may have added some
        const result = await this.runTool(s, c, this.tools(s), signal).finally(() => {
          if (s.work) s.work.tool = null;
        });
        // a cut write is finished with append (runTool refuses a rewrite from the start); a whole append ends it
        if (c.name === 'write_file' && !result.error) {
          if (c.salvaged) (s.work.partial ??= new Map()).set(this.partialKey(s, c.input.path), { last: c.salvaged.last });
          else if (c.input.append) s.work.partial?.delete(this.partialKey(s, c.input.path));
        }
        if (c.autoAppend && !result.error) result.text += '\n[append: true was missing: this part was added to the end of the file, as the next part of a file always is.]';
        if (c.salvaged && !result.error) result.text += `\n[Your answer stopped at the output limit: only the first ${c.salvaged.lines} whole lines of this text were written${c.input.append ? ' (appended)' : ''}, the unfinished line after them was left out. The file now ends with: ${JSON.stringify(c.salvaged.last)}. Go on right after that line with write_file append: true and the next part (about 250 lines per call), not the whole file again.]`;
        // The same call failing the same way: the model is pushed to its own fix (2nd time), then to ask the user for an
        // idea (3rd); if it still repeats, the user is asked for it and the answer goes to the model (no empty repeats)
        let stopRepeating = false;
        if (result.error) {
          // the same failure: the tool and its error (the input differs a little on every try)
          const key = createHash('sha1').update(`${c.name}\u0000${result.text.split('\n')[0].slice(0, 200)}`).digest('hex');
          const seen = (s.work.failures ??= new Map()).get(key) ?? 0;
          s.work.failures.set(key, seen + 1);
          if (seen === 1) result.text += '\n[You made exactly this call before and it failed the same way. Do not repeat it: read the error and find another way (other input, another tool, another approach).]';
          else if (seen === 2) result.text += `\n[This failed three times the same way. Do not try it again. ${s.canAsk !== false ? 'Ask the user with ask_user: say in two sentences what you tried and what failed, and ask for an idea; then follow the answer.' : 'Explain what you tried and what failed, and stop.'}]`;
          else if (seen >= 3 && s.canAsk !== false) {
            const first = result.text.split('\n')[0].slice(0, 300);
            const a = await this.askUser(s, `I could not do this: ${c.name} failed again the same way ("${first}"). I tried other ways too. How should I go on?`, [], signal);
            s.work.failures.delete(key);
            result.text += a.answered ? `\n[The user answered: ${a.answer} — follow this.]` : '\n[No answer from the user: stop and explain what failed.]';
          } else if (seen >= 3) stopRepeating = true;
        } else if (!WAITING_TOOLS.has(c.name) && !(c.name === 'panel_api' && String(c.input?.method ?? 'GET').toUpperCase() === 'GET')) {
          // The same call with the same result again (10.10.2026: load_tools of a skill name 15 times, the same pip
          // install 6 times, until the step limit): told at once, stopped at the fourth
          const key = createHash('sha1').update(`${c.name}\u0000${JSON.stringify(c.input ?? {})}\u0000${result.text.slice(0, 300)}`).digest('hex');
          const seen = (s.work.repeats ??= new Map()).get(key) ?? 0;
          s.work.repeats.set(key, seen + 1);
          if (seen === 1) result.text += '\n[You made exactly this call before and got the same result. Repeating it changes nothing: use the result and take the next step (another tool, other input), or answer.]';
          else if (seen === 2) result.text += '\n[The same call gave the same result three times. Do not make it again: take another step, or tell the user what is done and what is not.]';
          else if (seen >= 3) stopRepeating = true;
        }
        s.messages.push({ role: 'tool', toolId: c.id, toolName: c.name, content: result.text, extra: result.extra ?? null, error: result.error ?? false, duration: Math.round((Date.now() - startedAt) / 1000), time: new Date().toISOString() });
        this.emit(s, 'tool_result', { id: c.id, name: c.name, text: result.text.slice(0, 4000), extra: result.extra ?? null, error: result.error ?? false, duration: Math.round((Date.now() - startedAt) / 1000) });
        this.save(s);
        if (stopRepeating) {
          const m = `Stopped: the same ${c.name} call kept ${result.error ? 'failing the same way' : 'giving the same result'} (${result.text.split('\n')[0].slice(0, 200)}). Tell me how to go on, or ask differently.`;
          s.messages.push({ id: id(), role: 'assistant', content: m, time: new Date().toISOString() });
          this.emit(s, 'text', { text: m, id: s.messages.at(-1).id, final: true });
          this.save(s);
          return m;
        }
      }
    }
  }

  async runTool(s, c, tools, signal) {
    const tool = tools.find((a) => a.name === c.name) ?? this.mcpByName(s, c.name);
    if (!tool) return { text: TOOLS.some((a) => a.name === c.name) ? `"${c.name}" cannot be used in this session (only in a chat opened from this computer or with an API key).` : `No such tool: ${c.name}. Tools: ${tools.map((a) => a.name).join(', ')}`, error: true };
    const input = c.input && typeof c.input === 'object' ? c.input : {};
    for (const [from, to] of Object.entries(tool.aliases ?? {})) if (input[to] === undefined && input[from] !== undefined) input[to] = input[from];
    const cut = c.cut ? ' Your answer was cut off at the output limit, so this call is incomplete: send less in one call (write a long file in parts with write_file append: true, or change only the parts with edit_file).' : '';
    if (input._error) return { text: `The tool input is not valid JSON.${cut}`, error: true };
    // the model's own call tokens inside a value: a string was not closed and ran into the next call
    const garbled = Object.entries(input).find(([, v]) => typeof v === 'string' && /<\|?(tool_call|channel|"\|)\|?>|<tool_call\|>/.test(v));
    if (garbled) return { text: `The call came out garbled: the "${garbled[0]}" value was not closed and ran into your next call, so the rest of the call was lost. Write string values with normal quoting, never wrapped in backticks. For a big change do not write a script: copy the file (run_command Copy-Item) and change only the needed parts of the copy with edit_file.`, error: true };
    for (const z of tool.params?.required ?? []) {
      if (input[z] !== undefined && input[z] !== null) continue;
      const swallowed = Object.entries(input).find(([, v]) => typeof v === 'string' && new RegExp(`[\`'"]?\\s*,\\s*"?${z}"?\\s*:\\s*$`).test(v.slice(-80)));
      if (swallowed) return { text: `The call came out broken: the "${swallowed[0]}" value swallowed "${z}" (it ends in ",${z}:"), so ${z} was lost. Call again with ${z} FIRST and ${swallowed[0]} as a plain string (do not wrap it in backticks).`, error: true };
      return { text: `Missing parameter: ${z}.${cut}`, error: true };
    }
    // A file whose write stopped at the output limit is finished with append in this run. Written again from the start it
    // lost its lines and stopped sooner each time as the context grew (Bonsai 2 27B: 222 -> 353 -> 149 lines, 08.10.2026)
    // The next part sent without append: true (Bonsai continued at the right line but forgot it, and the page lost its
    // start) is added to the end; only a text that starts like the file again is a rewrite and refused.
    // A whole file appended to itself: Gemma copied the page, then appended a complete new page to the copy, and the
    // file held two documents (</html><!DOCTYPE html>, 08.10.2026). A text that starts like the file is not a next part.
    if (tool.name === 'write_file' && input.append) {
      const file = this.partialKey(s, input.path);
      const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const first = (t) => String(t ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
      if (current.trim() && first(current).length > 3 && first(input.text) === first(current)) return { text: `The text starts like ${input.path} itself (${JSON.stringify(first(current).slice(0, 80))}): appending it would put a second copy after the file. To replace the file, write it without append; to add a part, send only the new lines that come after the end of the file.`, error: true };
    }
    if (tool.name === 'write_file' && !input.append) {
      const file = this.partialKey(s, input.path);
      const partial = s.work?.partial?.get(file);
      if (partial && existsSync(file)) {
        const current = readFileSync(file, 'utf8');
        const first = (t) => String(t ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
        if (first(input.text) === first(current)) return { text: `${input.path} already has ${current.split('\n').length - 1} lines from your write that stopped at the output limit. Writing it again from the start loses them and stops at the limit again. Add only the rest with write_file append: true, starting right after the line: ${JSON.stringify(partial.last)}`, error: true };
        input.append = true;
        c.autoAppend = true;
      } else if (s.work && !s.work.shrinkWarned?.has(file) && existsSync(file) && statSync(file).isFile() && statSync(file).size < 5 * 2 ** 20) {
        // A whole-file write that drops most of a big file: Bonsai found unbalanced tags in its finished 1628-line page,
        // began rewriting it in parts, and the first part (332 lines) replaced the whole page (08.10.2026). Refused once
        // per file and run; the next write goes through (a real shortening).
        const before = readFileSync(file, 'utf8').split('\n').length;
        const after = String(input.text ?? '').split('\n').length;
        if (before >= 200 && after < before / 2) {
          (s.work.shrinkWarned ??= new Set()).add(file);
          const other = String(input.path).replace(/(\.[^.\\/]+)?$/, '.new$1');
          return { text: `${input.path} has ${before} lines and this text has ${after}: writing it would delete the other ${before - after} lines. To fix a few places, use edit_file. To write a new version in parts, write it to another file (e.g. ${other}, the next parts with append: true) and put it in place only when it is complete. If ${input.path} really should become just these ${after} lines, send the call again.`, error: true };
        }
      }
    }
    // A tool from the More tools list used without load_tools: it stays in the chat's tool list from now on
    if (!tool.core && !tool.mcp && !(s.loadedTools ?? []).includes(tool.name)) s.loadedTools = [...(s.loadedTools ?? []), tool.name];
    const risk = tool.risk?.(input) ?? null;
    // a call the chat's Always allow rules cover runs without asking (never an irreversible one)
    if (needsApproval(s.approvalMode, risk) && !allowedBy(this.allowOf(s), tool.name, input, this.routes, risk)) {
      const o = await this.waitApproval(s, c, risk, signal, allowRules(tool.name, input, this.routes, risk));
      if (!o.yes) return { text: o.stopped ? 'Stopped.' : 'The user rejected this action; suggest another way or stop.', error: true };
    }
    const b = this.toolContext(s, signal);
    try {
      const r = await tool.run(input, b);
      return typeof r === 'string' ? { text: truncate(r, tool.outputLimit) } : { text: truncate(r.text, tool.outputLimit), extra: r.extra };
    } catch (e) {
      if (signal.aborted || e instanceof CancelError) throw new CancelError();
      return { text: `Tool error: ${e.message}`, error: true };
    }
  }

  /** allow: the rules "Always allow" would keep for this call (allowRules), null when it cannot be allowed for good. */
  waitApproval(s, c, risk, signal, allow = null) {
    return new Promise((ok) => {
      const approval = { id: id(), tool: c.name, input: c.input, risk, allow, ok: null };
      let done = false;
      const z = setTimeout(() => finish({ yes: false }), APPROVAL_WAIT_MS);
      const cancel = () => finish({ yes: false, stopped: true });
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(z);
        signal.removeEventListener('abort', cancel);
        if (s.work) {
          s.work.approval = null;
          s.status = 'running';
        }
        this.emit(s, 'approval_done', { id: approval.id, yes: v.yes, auto: Boolean(v.auto) });
        ok(v);
      };
      approval.ok = finish;
      signal.addEventListener('abort', cancel, { once: true });
      s.work.approval = approval;
      s.status = 'approval';
      this.emit(s, 'approval', { id: approval.id, tool: c.name, input: c.input, risk, allow });
    });
  }

  toolContext(s, signal) {
    return {
      setting: this.setting,
      cwd: s.cwd,
      full: s.full,
      signal,
      chat: s,
      manager: this,
      processes: this.processes,
      mcp: this.mcp,
      skills: () => this.skills(),
      skillsChanged: () => { this.skillCache = null; },
      jobTypes: this.jobTypes,
      routes: this.routes,
      api: (method, path, body) => this.callApi(method, path, body),
      jobSummary: (id) => this.h.job(id),
      askImage: (data, question) => this.askImage(data, question, signal, this.localInfo(s), s),
      askText: (system, question) => this.askText(system, question, signal, this.modelInfo(s), s),
      askUser: (question, options) => this.askUser(s, question, options, signal),
      loadTools: (names) => this.loadTools(s, names),
      loadMcp: (server) => this.loadMcp(s, server),
      addUpload: (path, type) => this.addUpload(path, type),
      addPicture: (picture) => this.h.addPicture(picture),
      writeLog: (k) => this.log(`[agent ${s.id}] ${JSON.stringify(k).slice(0, 500)}`),
      advance: (m) => {
        if (s.work) s.work.progress = m;
        this.emit(s, 'progress', { text: m });
      },
      searchEngines: this.setting.agentSearchEngines,
      // Settings › Web search: the keys reach only search_web's request to its service (lib/agent/web-search.mjs)
      webSearch: this.webSearch?.() ?? null,
      web: this.web,
      knowledge: this.knowledge,
      knowledgeOnly: s.knowledge?.length ? s.knowledge : null,
      recordEdit: (path, before, after) => this.recordEdit(s, path, before, after),
      // a background command wakes this chat when it ends
      notifyWhenDone: (kid, record) => this.notifyWhenDone(s, kid, record),
      pollingMs: this.setting.agentPollingMs ?? 2000,
    };
  }

  /** The panel API inside the process (no HTTP): the handler from the route table. */
  async callApi(method, path, body) {
    const y = String(method ?? 'GET').toUpperCase();
    const full = String(path ?? '').replace(/^\/api\/v1/, '');
    const url = new URL(`http://panel/api/v1${full.startsWith('/') ? full : `/${full}`}`);
    const subPath = url.pathname.slice('/api/v1'.length);
    if (/^\/(chat|uploads\/|models\/load)/.test(subPath) && y !== 'GET') throw new Error('This endpoint cannot be called from inside the agent (use the add_upload tool for uploads).');
    const route = this.routes.find((r) => r.method === y && r.pattern.test(subPath));
    if (!route) {
      const other = this.routes.filter((r) => r.pattern.test(subPath)).map((r) => r.method);
      throw new Error(other.length ? `Method for ${subPath} must be ${other.join('/')}.` : `No such route: ${y} ${subPath}. Routes are in the system prompt; check with api_document.`);
    }
    if (!route.handler || route.stream) throw new Error('This endpoint cannot be called from inside the agent.');
    const m = route.pattern.exec(subPath);
    const pathValues = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(m[i + 1])]));
    return route.handler({ req: { method: y, headers: {}, agent: true }, url, path: pathValues, body: async () => (body && typeof body === 'object' ? body : {}), authority: { full: true } });
  }

  async addUpload(path, type) {
    const name = basename(path);
    if (type === 'image') return this.h.loadImage(fileStream(path), name);
    if (type === 'music') return this.h.loadMusic(fileStream(path), name);
    if (type === 'record') return this.h.loadRecord(fileStream(path), name);
    return this.h.loadData(fileStream(path), name);
  }

  /**
   * The chat's text model (llm\models file), or the panel default when it is empty or the file is gone. The remote model
   * (Settings › Remote model) has its own entry: its tool-call support is learned apart (native), it gets no images.
   */
  modelInfo(s) {
    if (s.model === REMOTE_MODEL) {
      const r = this.remoteConfig();
      if (r) return { file: `${REMOTE_MODEL}:${r.model}`, name: `${r.model} (remote)`, remote: true, image: false };
    }
    return this.localInfo(s);
  }

  /** The local model of a chat: a chat on the remote model views images (view_image) with the panel default. */
  localInfo(s) {
    return (s.model && s.model !== REMOTE_MODEL && this.llm?.modelInfo?.(s.model)) || this.llm?.info;
  }

  static readsImages(info) {
    return Boolean(info?.mmproj || info?.image);
  }

  /** Tokens the text model processed for a chat (prompt + generated), per run and in total; shown live in the chat. */
  addUsage(s, u) {
    if (!u || !s) return;
    const input = Number(u.prompt_tokens) || 0;
    const output = Number(u.completion_tokens) || 0;
    s.usage = { input: (s.usage?.input ?? 0) + input, output: (s.usage?.output ?? 0) + output };
    if (s.work) s.work.usage = { input: s.work.usage.input + input, output: s.work.usage.output + output };
    this.emit(s, 'usage', { run: s.work?.usage ?? null, total: s.usage });
  }

  async askImage(data, question, signal, info = this.llm.info, s = null) {
    if (!AgentManager.readsImages(info)) throw new Error('The image encoder (mmproj) of the text model is not installed; the image cannot be viewed.');
    const r = await this.llm.req('/v1/chat/completions', {
      messages: [
        { role: 'system', content: 'Examine the image carefully; answer the question in English, concretely and briefly. Clearly point out generation errors (extra/missing limbs, distorted face or hands, garbled text, duplicated character, elements that do not match the request).' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: data } }, { type: 'text', text: question }] },
      ],
      temperature: 0.2,
      max_tokens: 800,
      chat_template_kwargs: { enable_thinking: false },
    }, { externalRequest: true, signal, info });
    if (r.code !== 200) throw new LlmError(r.json?.error?.message ?? `HTTP ${r.code}`, r.code);
    this.addUsage(s, r.json.usage);
    return r.json.choices?.[0]?.message?.content ?? '';
  }

  /** A short side question to the chat's own text model (no tools, no thinking), e.g. show_image's English search words. */
  async askText(system, question, signal, info = this.llm.info, s = null) {
    const body = {
      messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
      temperature: 0.2,
      max_tokens: 120,
      chat_template_kwargs: { enable_thinking: false },
    };
    const r = s ? await this.textRequest(s, body, { externalRequest: true, signal, info }) : await this.llm.req('/v1/chat/completions', body, { externalRequest: true, signal, info });
    if (r.code !== 200) throw new LlmError(r.json?.error?.message ?? `HTTP ${r.code}`, r.code);
    this.addUsage(s, r.json.usage);
    return r.json.choices?.[0]?.message?.content ?? '';
  }

  /* ── Context ── */

  skills() {
    const now = Date.now();
    if (!this.skillCache || now - this.skillCache.time > 60000) this.skillCache = { time: now, list: findSkills({ aiRoot: this.setting.aiRoot, dataRoot: this.setting.dataRoot }) };
    return this.skillCache.list;
  }

  readMemory() {
    try {
      return readFileSync(this.memoryFile, 'utf8');
    } catch {
      return '';
    }
  }

  /** The lasting notes, oldest first ({ id, date, text }); an older file gets its ids written in at the first read. */
  notes() {
    const { notes, migrated } = parseNotes(this.readMemory());
    if (migrated) {
      try {
        this.writeNotes(notes);
      } catch (e) {
        this.log(`[agent] could not give the notes ids: ${e.message}`);
      }
    }
    return notes;
  }

  writeNotes(notes) {
    writeFileSync(this.memoryFile, notes.length ? `${notes.map(noteLine).join('\n')}\n` : '', 'utf8');
  }

  addMemory(note) {
    const text = noteText(note);
    if (!text) throw new Error('The note is empty.');
    const notes = this.notes();
    const n = { id: `n${noteNumber(notes)}`, date: new Date().toISOString().slice(0, 10), text };
    notes.push(n);
    if (notes.map(noteLine).join('\n').length > MEMORY_FILE_LIMIT) throw new Error(`Memory is full (${MEMORY_FILE_LIMIT} characters): update or delete old notes (search_memory finds them).`);
    this.writeNotes(notes);
    return `Note saved as ${n.id} (${notes.length} note${notes.length === 1 ? '' : 's'}).`;
  }

  /** A note gets new text; it counts as the newest (the prompt keeps the newest notes when they do not all fit). */
  updateMemory(id, note) {
    const text = noteText(note);
    if (!text) throw new Error('The note is empty; delete it with delete_memory instead.');
    const notes = this.notes();
    const at = notes.findIndex((n) => n.id === String(id ?? '').trim());
    if (at < 0) throw new Error(`No note ${id}. ${notes.length ? 'search_memory lists the notes with their ids.' : 'There are no notes.'}`);
    const [n] = notes.splice(at, 1);
    notes.push({ ...n, date: new Date().toISOString().slice(0, 10), text });
    this.writeNotes(notes);
    return `Note ${n.id} updated.`;
  }

  /**
   * Notes by id, or those that contain every searched word (case, accents and Turkish i do not matter); none: all of
   * them. Notes that hold only some of the words follow, most matches first.
   */
  searchMemory({ query = '', id = '' } = {}) {
    const notes = this.notes();
    if (!notes.length) return 'There are no notes.';
    let found = notes;
    if (String(id ?? '').trim()) found = notes.filter((n) => n.id === String(id).trim());
    else if (searchWords(query).length) {
      const words = searchWords(query);
      const hits = notes.map((n) => ({ n, count: words.filter((w) => searchFold(`${n.date} ${n.text}`).includes(w)).length })).filter((x) => x.count);
      found = [...hits.filter((x) => x.count === words.length), ...hits.filter((x) => x.count < words.length).sort((a, z) => z.count - a.count)].map((x) => x.n);
    }
    if (!found.length) return `No note matches "${String(id || query).trim()}" (${notes.length} note${notes.length === 1 ? '' : 's'} in all).`;
    const shown = found.slice(0, 80);
    return `${found.length} of ${notes.length} note${notes.length === 1 ? '' : 's'}${found.length > shown.length ? ` (first ${shown.length} shown; search with more words)` : ''}:\n${shown.map(noteLine).join('\n')}`;
  }

  /** Deletes one note by id; a text instead of an id deletes only the one note that contains it. */
  deleteMemory(key) {
    const notes = this.notes();
    const k = String(key ?? '').trim();
    let found = notes.filter((n) => n.id === k);
    if (!found.length && k) {
      found = notes.filter((n) => searchFold(n.text).includes(searchFold(k)));
      if (found.length > 1) throw new Error(`"${k}" is in ${found.length} notes; delete them one by one by id:\n${found.slice(0, 20).map(noteLine).join('\n')}`);
    }
    if (!found.length) throw new Error(`No note ${k || '(no id given)'}. search_memory lists the notes with their ids.`);
    const remaining = notes.filter((n) => n !== found[0]);
    this.writeNotes(remaining);
    return `Note ${found[0].id} deleted (${remaining.length} left).`;
  }

  /**
   * The notes for the system prompt: whole notes, the newest that fit in MEMORY_LIMIT characters, oldest first with
   * their ids; when older ones are left out, how many, and that search_memory finds them.
   */
  memoryPrompt() {
    const notes = this.notes();
    if (!notes.length) return '';
    const shown = [];
    let size = 0;
    for (const n of [...notes].reverse()) {
      const line = noteLine(n);
      if (size + line.length + 1 > MEMORY_LIMIT) break;
      shown.unshift(line);
      size += line.length + 1;
    }
    const older = notes.length - shown.length;
    return `Your persistent notes (update_memory and delete_memory take the id in brackets):\n${shown.join('\n')}${older ? `\n[${older} older note${older === 1 ? ' is' : 's are'} not shown here: search_memory finds ${older === 1 ? 'it' : 'them'}]` : ''}`;
  }

  systemPrompt(s, tools) {
    // The date only: the system prompt must stay the same from call to call, or llama-server processes the whole prompt
    // again (measured 08.10.2026: with the minute in it, 11k tokens took 11 s instead of ~1 s whenever the minute
    // changed). The time rides on each user message instead (translateMessages), where it does not change.
    const hour = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Istanbul', dateStyle: 'full' });
    const memory = this.memoryPrompt();
    // Only what every request needs (user 08.10.2026: "Araç skil kural vs. istenmediği sürece dahil etmemelisin"): the
    // panel guide comes with panel_api, skills with load_skill, other tools by name until load_tools adds them
    const parts = [
      `You are the assistant and agent of Nedese Studio (a local image/video/voice/music/film/3D generation and model training panel). Computer: ${hostname()}, Windows. Working folder: ${s.cwd}. Panel folder: ${this.setting.aiRoot}. Now: ${hour} (Istanbul).`,
      s.full
        ? `You have full access: on this computer you can read and write files, write and run programs (run_command: PowerShell), install software, connect to remote servers over SSH, search and download from the web. ${detectRuntimes(this.setting.aiRoot)}`
        : 'This session was opened over the network: you can only do panel operations, web search and reading; file/command tools are disabled.',
      `Rules:
- Answer in the language of the user's latest message (English message: English answer; Turkish message: Turkish answer), even when notes or tool output are in another language. Short and concrete. Do not ask unnecessary questions; proceed with a reasonable assumption and state it in one sentence.
- Use only what the task needs. Tools you do not have yet are named under "More tools": add them with load_tools first.
- A request that needs several steps: keep going with tools until it is done, then a short summary. A simple question gets a direct answer.
- Facts you are not sure of and current information (weather, news, prices, versions, dates): never guess. Use search_web (short keywords; results carry lines read from the pages) and answer only from what the sources say: the exact value and the source site, official and well-known sites first; your own knowledge is older, do not "correct" the sources with it. If the results lack the answer, open a page with fetch_web or search again with other words before saying you could not find it.
- Pictures: the chat shows them. A photo from the internet: call show_image with query = what it should show, in the user's words (it searches every image source on the web at once, checks the picture and fetches the best; any site will do, the user does not need a particular one), and put the line it returns in your answer. One per picture; several calls give different pictures. Never write an image address yourself and never give only a link. A new picture is made with the panel's image job (panel_api). Never say you are text-only or cannot show or make pictures.
- When a decision is really the user's, ask with ask_user (2-4 short options) and wait; otherwise decide and say what you assumed.
- Change files with edit_file or write_file (the user sees the diff and can undo it), not with a script, and never put a file's content in your answer; a changed copy of a file: copy it (Copy-Item), then edit_file the parts in the copy. Large work goes in parts: first plan the parts (e.g. 250 lines each) and say the plan in one line, then do them one by one: read with start_line, write a long file in parts (append: true), and change only what is needed (a new design is mostly the CSS: edit that, not every line). Writing a program: write it, run it, read the error, fix it; do not say "done" before it works.
- Never wait with sleep loops or by polling: start it in the background and you are woken when it happens (run_command back_plan, watch for "wait until X, then Y", monitor for new output lines, sub_agent wait: false). schedule is for set times ("every day at 9:00", "in 20 minutes").
- Actions that need approval are confirmed by the system (the chat's approval mode); if rejected, do not force it.
- If your tools cannot do something, look for an MCP server or a skill (search_web: registry.modelcontextprotocol.io, GitHub, npm, PyPI) and install it (add_mcp_server, install_skill; a Claude / Claude Code plugin or marketplace on GitHub: install_plugin). Install only with these tools, which put it where the panel reads it, never with another installer (npx skills, claude mcp add, a README's own install script); load a skill (load_skill) before you use it or say what it does. If none fits, build the tool yourself and then do the task with it: a one-off job is a Python script (python -m pip install what it needs; there is no pip command) run with run_command; a tool worth keeping becomes a skill (a folder panel-data\\tools\\<name> with SKILL.md: name, description, how to use it, and its scripts; then install_skill with that folder) or a small local MCP server in Python (python -m pip install mcp, FastMCP; then add_mcp_server with command python and the script's path; a server is never installed with install_skill, and when the user asks for an MCP server it is this). Research the library or service first (search_web, fetch_web) and test what you built before you report.`,
    ];
    const more = this.moreTools(s, tools);
    if (more) parts.push(more);
    if (memory) parts.push(memory);
    if (s.parent) parts.push('This is a sub-agent session: do only the given task, and finish with a clear report of the result (the parent agent will read it).');
    // The assistant preset the user started the chat with (user request 08.10.2026); the user's rules still come last
    if (s.preset?.prompt) parts.push(`ASSISTANT PRESET "${s.preset.name}", chosen by the user for this chat. Follow these instructions:\n${s.preset.prompt}`);
    // The user's rules last, so they weigh most: they win over the general rules above when the two disagree
    const rules = this.rules(s);
    if (rules.length) parts.push(`RULES FROM THE USER. Follow every one of them in every answer and action; when one disagrees with the general rules above, the user's rule wins. If the user asks you to remember a rule for this project, add it to NEDESE.md in the working folder (create the file if needed).\n${rules.map((r) => `### ${r.source} (${r.path})\n${r.text}`).join('\n\n')}`);
    if (this.native(s) === false) {
      parts.push(`Tools (JSON Schema input):\n${tools.map((a) => `- ${a.name}: ${a.description}\n  input: ${JSON.stringify(a.params.properties)}${a.params.required?.length ? ` required: ${a.params.required.join(', ')}` : ''}`).join('\n')}`);
      parts.push('To call a tool, write ONLY this block in your reply (there may be several; add no other text):\n<tool>{"name": "tool_name", "input": {…}}</tool>\nThe result comes back to you as a "[tool result]" message. When the work is done, answer the user in plain text (without a block).');
    }
    return parts.join('\n\n');
  }

  /** Tools the model sees in this chat: the core ones and those it loaded (load_tools, or by using one). */
  activeTools(s) {
    const loaded = new Set(s.loadedTools ?? []);
    return this.tools(s).filter((a) => a.core || a.mcp || loaded.has(a.name));
  }

  /** "More tools": the tools this chat may use but has not loaded, by name and group (load_tools adds them). */
  moreTools(s, active) {
    const on = new Set(active.map((a) => a.name));
    const rest = this.tools(s).filter((a) => !on.has(a.name));
    if (!rest.length) return '';
    // servers whose tools are not functions of this chat yet (load_tools with the name adds them)
    const servers = Object.keys(this.mcp.servers()).filter((x) => !(s.mcpLoaded ?? []).includes(x));
    const label = {
      panel: 'panel jobs (image, video, voice, music, film, 3D, editing, training, data collection, page videos: a recorded demo of a website or of this panel) and the panel API',
      files: 'files',
      commands: 'background commands and SSH',
      agents: 'sub-agents, waiting in the background (watch, monitor), scheduled tasks and the background list',
      memory: 'lasting notes (preferences to remember)',
      chats: 'earlier chats (search and read them)',
      knowledge: `the user's documents in Knowledge (${this.knowledgeLabel(s)}; search them for questions about the user's own reports, notes and manuals)`,
      skills: `skills (${this.skills().length} installed)`,
      mcp: `MCP servers${servers.length ? ` (${servers.slice(0, 12).join(', ')}${servers.length > 12 ? ', …' : ''}; load_tools with a server name adds its tools)` : ''}`,
    };
    const groups = new Map();
    for (const a of rest) groups.set(a.group ?? 'other', [...(groups.get(a.group ?? 'other') ?? []), a.name]);
    return `More tools (add with load_tools before use): ${[...groups].map(([g, names]) => `${label[g] ?? g}: ${names.join(', ')}`).join(' · ')}`;
  }

  /**
   * load_tools: the named tools join this chat; panel_api brings the panel guide once. A known MCP server's name
   * ("blender", also "mcp:blender") starts it and makes its tools functions of the chat (loadMcp).
   */
  async loadTools(s, names) {
    const permitted = this.tools(s);
    const servers = this.mcp.servers();
    const found = [];
    const missing = [];
    const mcpLines = [];
    for (const n of names) {
      const t = permitted.find((a) => a.name === n);
      const server = String(n).replace(/^mcp[:_]+/i, '');
      if (t) found.push(t);
      else if (servers[server] && s.full) {
        try {
          mcpLines.push(await this.loadMcp(s, server));
        } catch (e) {
          mcpLines.push(`MCP server "${server}" did not start: ${e.message}`);
        }
      } else missing.push(n);
    }
    const fresh = found.filter((t) => !t.core && !t.mcp && !(s.loadedTools ?? []).includes(t.name));
    s.loadedTools = [...(s.loadedTools ?? []), ...fresh.map((t) => t.name)];
    const lines = [];
    if (found.length) lines.push(`Loaded: ${found.map((t) => t.name).join(', ')}; use them from your next step.`);
    lines.push(...mcpLines);
    // a skill or a tool folder the agent wrote is not a tool (10.10.2026: load_tools of its own skill 15 times)
    const skills = this.skills();
    const toolFolder = (n) => existsSync(join(this.setting.dataRoot, 'tools', String(n)));
    for (const n of missing.filter((n) => skills.some((k) => k.name === n || k.name.split(':').pop() === n))) lines.push(`"${n}" is a skill, not a tool: read it with load_skill (name "${n}") and follow it; its scripts run with run_command.`);
    for (const n of missing.filter((n) => !skills.some((k) => k.name === n || k.name.split(':').pop() === n) && toolFolder(n))) lines.push(`"${n}" is a folder you wrote (panel-data\\tools\\${n}), not a tool: an MCP server script in it becomes tools with add_mcp_server (command: python, args: [the script's path]); run other scripts with run_command.`);
    const unknown = missing.filter((n) => !skills.some((k) => k.name === n || k.name.split(':').pop() === n) && !toolFolder(n));
    if (unknown.length) lines.push(`Not available: ${unknown.join(', ')} (${unknown.some((n) => TOOLS.some((t) => t.name === n) || servers[String(n).replace(/^mcp[:_]+/i, '')]) ? 'this chat has no access to it' : 'no such tool; see the More tools list'}).`);
    if (fresh.some((t) => t.name === 'panel_api')) lines.push(this.panelGuide());
    return lines.join('\n\n');
  }

  /** What panel_api needs: how to make a job, the job types with an example body each, the routes. */
  panelGuide() {
    const routes = this.routes.filter((r) => !r.direct && r.handler && !r.stream && !/^\/(chat|login|logout|session|openapi)/.test(r.path)).map((r) => `${r.method} ${r.path} — ${r.summary}`);
    // An example body per job type: the model copies the (flat) field names (measured 08.10.2026: without examples
    // "aspect_ratio" and nesting under "fields" wasted 3 steps)
    const types = Object.entries(this.jobTypes).map(([k, t]) => `${k}: ${t.name} — ${String(t.description).split(/(?<=\.)\s/)[0].slice(0, 140)}\n  example body: ${JSON.stringify(t.example ?? { type: k })}`);
    return [
      'Panel jobs: panel_api POST /jobs with a FLAT body using the field names of the example bodies below (e.g. {"method":"POST","path":"/jobs","body":{"type":"image","prompt":"an orange cat in a snowy forest","title":"Karlı ormanda turuncu kedi","ratio":"16:9"}}); other fields: api_document (job_type). Write image/video prompts in English and give the job a short title in the language of the user (image, video, edit, music: the cards show it instead of the long prompt). After creating a job, wait for it with wait_job (load it) and give the user the file link (url); when the request has specific details or the user asks for a check, look at the result with look_image and regenerate if it does not match (at most 2 attempts). Production order: film = /write-scenes → POST /jobs type=film; video = a source image (gallery/upload, or generate an image first) → type=video; a video of a website or of this panel (demo, promo, tutorial) = type=pageVideo with steps (open, click, type, scroll… with captions; look at the page with fetch_web first to know its buttons), for a narrated one make a voice job per step first and give each clip as the audio of that step, music from a music job.',
      `Job types (POST /jobs "type"):\n${types.join('\n')}`,
      `Panel API routes (via panel_api, without the /api/v1 prefix):\n${routes.join('\n')}`,
    ].join('\n\n');
  }

  async imageExtra(source) {
    const path = sourcePath(this.setting, source);
    if (!path || !existsSync(path)) return null;
    if (!this.setting.ffmpeg) return `data:image/${/\.png$/i.test(path) ? 'png' : 'jpeg'};base64,${readFileSync(path).toString('base64')}`;
    const jpg = join(tmpdir(), `agent-image-${process.pid}-${Date.now()}.jpg`);
    try {
      await runFfmpeg(this.setting.ffmpeg, ['-y', '-i', path, '-vf', "scale='min(1024,iw)':-2", '-frames:v', '1', '-q:v', '3', jpg]);
      return `data:image/jpeg;base64,${readFileSync(jpg).toString('base64')}`;
    } catch {
      return null;
    } finally {
      rmSync(jpg, { force: true });
    }
  }

  /**
   * A tool call as the model sees it again: long strings of a call that failed, or whose result was trimmed, are cut
   * to a note (a broken write_file came back whole each step and the model copied it; old contents fill the context).
   */
  callInput(c, result) {
    const input = c.input ?? {};
    if (!result || (!result.error && !result.truncated && !c.salvaged)) return input;
    const why = result.error ? 'the call failed' : c.salvaged ? 'it is in the file now' : 'an earlier step';
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' && v.length > 400 ? `${v.slice(0, 200)}… [${v.length} characters left out: ${why}]` : v]));
  }

  /**
   * A write_file cut at the output limit keeps its work (user idea 08.10.2026: cut with room to spare, then the rest):
   * the whole lines written so far become a complete call and the model goes on from the next line. Before, the cut
   * call failed and minutes of writing were lost, or a call the server had closed wrote a half line without a word.
   * The cut call may come parsed, as unfinished JSON, in a <tool> block or in Gemma's own call syntax.
   */
  salvageWrite(r, s) {
    const at = r.calls.findIndex((c) => c.name === 'write_file');
    const c = at >= 0 ? r.calls[at] : null;
    const input = c?.input ?? {};
    const body = input.text ?? input.content;
    const found = c && !input._error && typeof body === 'string' ? { path: typeof input.path === 'string' ? input.path : null, text: body, append: typeof input.path === 'string' ? input.append === true : true } : partialWrite(c ? input.raw : r.content);
    if (!found) return;
    // cut before its path (Bonsai writes the text first): the next part of the one file cut earlier in this run
    if (!found.path) {
      const files = [...(s?.work?.partial?.keys() ?? [])];
      if (files.length !== 1) return;
      found.path = files[0];
    }
    const keep = found.text.slice(0, found.text.lastIndexOf('\n') + 1);
    if (!keep) return;
    const lines = keep.split('\n');
    const call = { id: c?.id, name: 'write_file', input: { path: found.path, text: keep, ...(found.append ? { append: true } : {}) }, salvaged: { lines: lines.length - 1, last: lines.at(-2).slice(-120) } };
    // calls after the cut one are not complete; a call found in the text leaves the text before it as the answer
    r.calls = [...r.calls.slice(0, Math.max(0, at)), call];
    if (!c) {
      const start = r.text.search(/<tool>|<tool_call>|call:write_file/);
      if (start >= 0) r.text = r.text.slice(0, start).trim();
    }
  }

  /** The full path of a file a tool names in this chat (the key of a cut write that is finished with append). */
  partialKey(s, path) {
    try {
      return parsePath({ cwd: s.cwd }, path);
    } catch {
      return '';
    }
  }

  /**
   * What the model reads of a user message's attachments (user request 08.10.2026: PDF, Word, Excel and PowerPoint in
   * the chat, and text files as text): a file with text goes with the message, cut to its room (recent: one of the last
   * two user messages; an older one keeps the start and how to read on), a picture or another file by its source for the
   * tools. '' for a message without attachments.
   */
  attachmentPart(s, m, recent) {
    const list = m.attachments ?? [];
    if (!list.length) return '';
    const files = list.map((e) => {
      const path = e.type === 'image' ? null : sourcePath(this.setting, e.source);
      if (!path || !existsSync(path)) return { e, path: null };
      const st = statSync(path);
      return { e, path, state: `${st.size}:${st.mtimeMs}` };
    });
    const budget = this.contextBudget();
    const key = `${m.id ?? m.time}|${recent ? budget : 'old'}|${s.full ? 1 : 0}|${files.map((f) => f.state ?? '-').join(',')}`;
    if (this.attachmentCache.has(key)) return this.attachmentCache.get(key);
    const readable = files.filter((f) => f.path && readableKind(f.path));
    const room = recent ? Math.max(ATTACHMENT_MIN, Math.floor((budget * 3 * ATTACHMENT_SHARE) / Math.max(1, readable.length))) : ATTACHMENT_OLD;
    const listed = files.filter((f) => !readable.includes(f)).map((f) => `${f.e.source} (${f.e.type}${f.e.name ? `, ${f.e.name}` : ''}${f.e.type !== 'image' && !f.path ? ', no longer on disk' : ''})`);
    const parts = readable.map((f) => attachmentText(f.path, { source: f.e.source, name: f.e.name, limit: room, full: s.full }));
    if (listed.length) parts.unshift(`[Attachments: ${listed.join(', ')} — can be given to tools as "source"]`);
    const text = `\n${parts.join('\n\n')}`;
    this.attachmentCache.set(key, text);
    for (const k of this.attachmentCache.keys()) {
      if (this.attachmentCache.size <= ATTACHMENT_CACHE) break;
      this.attachmentCache.delete(k);
    }
    return text;
  }

  /** The user messages whose files go whole (as far as their room allows): the last two of the messages sent. */
  static recentUsers(messages) {
    return new Set(messages.filter((m) => m.role === 'user').slice(-2));
  }

  /** Session messages -> OpenAI chat messages (native tool mode or text blocks). */
  async translateMessages(s, signal) {
    // the remote model gets attachments by name only (whether it reads images is not known)
    const withImage = !this.remoteFor(s) && AgentManager.readsImages(this.modelInfo(s));
    const result = [];
    // messages left out to fit the context (leaveOut) do not go
    const messages = s.messages.slice(s.trimmed).filter((m) => !m.dropped);
    // Image attachments go whole only with the last two user messages; older ones by name only (the context stays small)
    const userIndexes = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).slice(-2);
    // how each call ended (its result message): a failed or trimmed call goes back without its long contents
    const outcome = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.toolId, m]));
    // Notes for the model (an undone edit) ride on the next user message: chat templates want user/assistant turns in turn
    let notes = [];
    let userLanguage = null;
    for (const [i, m] of messages.entries()) {
      if (signal?.aborted) throw new CancelError();
      if (m.role === 'note' && m.kind === 'undo') {
        notes.push(`[${m.content}]`);
        continue;
      }
      // a line from the background (a watch that ended): it is already in brackets
      if (m.role === 'note' && m.kind === 'background') {
        notes.push(m.content);
        continue;
      }
      if (m.role === 'user') {
        const attachments = m.attachments ?? [];
        const extraText = this.attachmentPart(s, m, userIndexes.includes(i));
        // the language rides on the message too (stable, so the prompt cache holds): with English tool output all
        // around, Gemma drifted into English answers to a Turkish user (08.10.2026)
        // a message with no clear language ("pinterst") and the agent's own notes keep the user's language before it
        // a message from the background (wake) keeps the user's language too
        if (!m.hidden && !m.wake) userLanguage = messageLanguage(m.content, userLanguage);
        const language = (userLanguage ?? messageLanguage(m.content)) === 'tr' ? 'Turkish' : 'English';
        const sent = m.time ? `\n[sent ${new Date(m.time).toLocaleString('en-GB', { timeZone: 'Europe/Istanbul', dateStyle: 'medium', timeStyle: 'short' })} · written in ${language}: answer in ${language}]` : '';
        const text = `${notes.length ? `${notes.join('\n')}\n\n` : ''}${m.content}${extraText}${sent}`;
        notes = [];
        const parts = [];
        if (withImage && userIndexes.includes(i)) {
          for (const e of attachments.filter((x) => x.type === 'image').slice(0, 4)) {
            const data = await this.imageExtra(e.source);
            if (data) parts.push({ type: 'image_url', image_url: { url: data } });
          }
        }
        result.push({ role: 'user', content: parts.length ? [...parts, { type: 'text', text: text }] : text });
      } else if (m.role === 'assistant') {
        if (m.toolCalls?.length) {
          if (this.native(s) === false) result.push({ role: 'assistant', content: `${m.content ? `${m.content}\n` : ''}${m.toolCalls.map((c) => `<tool>${JSON.stringify({ name: c.name, input: this.callInput(c, outcome.get(c.id)) })}</tool>`).join('\n')}` });
          else result.push({ role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(this.callInput(c, outcome.get(c.id))) } })) });
        } else result.push({ role: 'assistant', content: modelText(m) ?? '' });
      } else if (m.role === 'tool') {
        const content = m.truncated ? `[old tool output trimmed] ${String(m.content).slice(0, 300)}` : m.content;
        if (this.native(s) === false) result.push({ role: 'user', content: `[tool result ${m.toolName}]\n${content}` });
        else result.push({ role: 'tool', tool_call_id: m.toolId, name: m.toolName, content: String(content) });
      }
    }
    return result;
  }

  /**
   * The conversation's share of the context when no model call has measured it yet (older chats, right after a
   * compact): the messages since the last compact. Like Claude Code, the gauge leaves out the fixed part (instructions,
   * tools, the summary), so it is 0 after a compact (user 08.10.2026).
   */
  estimateContext(s) {
    const recent = s.messages.slice(s.trimmed ?? 0).filter((m) => m.role !== 'note' && !m.dropped);
    const whole = AgentManager.recentUsers(recent);
    return recent.reduce((t, m) => t + token(m.truncated ? '.'.repeat(300) : modelText(m)) + (m.role === 'user' ? token(this.attachmentPart(s, m, whole.has(m))) : 0) + (m.toolCalls ? token(JSON.stringify(m.toolCalls)) : 0) + 8, 0);
  }

  /** Context window of the text model (the loaded setting, else the configured one). */
  contextSize() {
    return this.llm?.lastSetting?.context ?? this.llm?.context ?? 32768;
  }

  /**
   * Room of the conversation: from the empty chat to the point where auto compact starts (the context window less the
   * answer's reserve and the fixed part: instructions, tools, summary). The gauge shows the conversation against it.
   */
  conversationRoom(s) {
    return Math.max(1024, this.contextBudget() - (s.fixedTokens ?? this.baseTokens ?? 2000));
  }

  contextBudget() {
    const b = this.llm.lastSetting?.context ?? this.llm.context ?? 32768;
    return Math.max(4096, b - RESPONSE_TOKEN - THINKING_BUDGET.medium);
  }

  /** When the context does not fit the budget: old tool outputs are trimmed first, then old messages are summarized by the model. */
  async contextFit(s, signal) {
    const budget = this.contextBudget();
    const active = this.activeTools(s);
    const fixed = token(this.systemPrompt(s, active)) + (this.native(s) === false ? 0 : token(JSON.stringify(this.toolSchemas(active))));
    const measure = () => {
      const outcome = new Map(s.messages.filter((m) => m.role === 'tool').map((m) => [m.toolId, m]));
      const sent = s.messages.slice(s.trimmed).filter((m) => !m.dropped);
      const whole = AgentManager.recentUsers(sent);
      return fixed + token(s.summary) + sent.reduce((t, m) => t + (m.truncated ? 110 : token(modelText(m))) + (m.role === 'user' ? token(this.attachmentPart(s, m, whole.has(m))) : 0) + (m.toolCalls ? token(JSON.stringify(m.toolCalls.map((c) => this.callInput(c, outcome.get(c.id))))) : 0) + 8, 0);
    };
    if (measure() <= budget) return;
    // Old tool outputs first, oldest first; the last 2 stay whole (one turn of many large reads filled the window)
    const tools = s.messages.map((m, i) => (m.role === 'tool' && !m.truncated ? i : -1)).filter((i) => i >= s.trimmed);
    for (const i of tools.slice(0, Math.max(0, tools.length - 2))) {
      s.messages[i].truncated = true;
      if (measure() <= budget) return;
    }
    // Auto compact off (chat Options): old tool outputs are trimmed, the conversation is not summarized
    if (s.autoCompact === false) return;
    // Summary: the first half of the messages from the trimmed point on (the last user message and what follows stay)
    const leftovers = s.messages.slice(s.trimmed);
    const lastUser = leftovers.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).at(-1) ?? 0;
    let cut = Math.min(lastUser, Math.floor(leftovers.length / 2));
    // One long task from a single message: the first half of its steps (cut where a step begins, so a tool call is not
    // separated from its result)
    if (cut < 2) {
      const half = Math.floor(leftovers.length / 2);
      cut = [...leftovers.keys()].filter((i) => i >= 2 && i <= half && leftovers[i].role === 'assistant').at(-1) ?? 0;
    }
    if (cut >= 2) {
      let summarized = false;
      try {
        summarized = await this.summarize(s, cut, signal);
      } catch (e) {
        if (signal?.aborted) throw new CancelError();
        this.log(`[agent ${s.id}] the summary failed: ${e.message}`);
      }
      if (signal?.aborted) throw new CancelError();
      if (summarized) {
        s.trimmed += cut;
        this.emit(s, 'summary', { trimmed: s.trimmed });
        this.save(s);
      }
    }
    // The summary failed or was not enough: the oldest messages leave the context (user request 08.10.2026: the request
    // that was too long for the model used to go out anyway and fail)
    if (measure() > budget) this.leaveOut(s, measure, budget);
  }

  /**
   * Leaves the oldest messages out of the model's context until the request fits: first whole turns before the latest
   * user request, then the oldest steps of the task that request started (a step is an assistant message with the
   * results of its tool calls; the last two stay). The request itself always stays; the model is told in the summary
   * slot that messages were left out, the user by a note. The messages stay in the chat.
   */
  leaveOut(s, measure, budget) {
    const startedAt = s.trimmed;
    const droppedBefore = s.messages.filter((m) => m.dropped).length;
    // 1) the conversation starts at a user message (chat templates want a user turn first)
    for (const i of s.messages.map((m, i) => (i > s.trimmed && m.role === 'user' ? i : -1)).filter((i) => i >= 0)) {
      if (measure() <= budget) break;
      s.trimmed = i;
    }
    // 2) the oldest steps after the latest request, a whole step at a time (a call never loses its result)
    if (measure() > budget) {
      const steps = s.messages.map((m, i) => (i > s.trimmed && m.role === 'assistant' && !m.dropped ? i : -1)).filter((i) => i >= 0);
      for (const [k, i] of steps.slice(0, -2).entries()) {
        for (let j = i; j < steps[k + 1]; j++) if (s.messages[j].role !== 'note') s.messages[j].dropped = true;
        if (measure() <= budget) break;
      }
    }
    const count = s.messages.slice(startedAt, s.trimmed).filter((m) => m.role !== 'note' && !m.dropped).length + s.messages.filter((m) => m.dropped).length - droppedBefore;
    if (!count) return 0;
    s.leftOut = (s.leftOut ?? 0) + count;
    const said = `[${s.leftOut} earlier messages were left out to fit the context window (they could not be summarized); ask the user if something from them is needed.]`;
    s.summary = `${String(s.summary ?? '').replace(/\n?\[\d+ earlier messages were left out to fit the context window[^\]]*\]/, '').trim()}\n${said}`.trim();
    const text = `${count} earlier messages were left out of the model's context to make room (the summary could not be made); they stay in this chat.`;
    s.messages.push({ role: 'note', kind: 'left-out', content: text, time: new Date().toISOString() });
    this.log(`[agent ${s.id}] ${count} messages left out of the context`);
    this.emit(s, 'left_out', { count, text });
    this.save(s);
    return count;
  }

  /**
   * Merges the messages [trimmed, trimmed + cut) into s.summary with the text model; false if the model failed. Each
   * message goes in as long as the summarizer's room allows (summaryCut), not a fixed length.
   */
  async summarize(s, cut, signal) {
    const list = s.messages.slice(s.trimmed, s.trimmed + cut).filter((m) => m.role !== 'note');
    const label = (m) => `${m.role === 'user' ? 'USER' : m.role === 'tool' ? `TOOL ${m.toolName}` : 'ASSISTANT'}: `;
    const calls = (m) => (m.toolCalls ? ` [tool calls: ${m.toolCalls.map((c) => c.name).join(', ')}]` : '');
    // the summarizer's room in characters: its context less its answer, its instructions, the previous summary, labels
    const room = Math.max(4000, (this.contextSize() - SUMMARY_ANSWER - 300 - token(s.summary)) * 3 - list.reduce((t, m) => t + label(m).length + calls(m).length + 2, 0));
    const most = summaryCut(list.map((m) => String(m.content ?? '').length), room);
    const old = list.map((m) => {
      const text = String(m.content ?? '');
      return `${label(m)}${most !== null && text.length > most ? `${text.slice(0, most)}…` : text}${calls(m)}`;
    }).join('\n');
    const r = await this.textRequest(s, {
      messages: [{ role: 'system', content: "Summarize the conversation below for the next steps: the user's request, what was done, generated file/job ids and paths, decisions, remaining work. At most 1500 characters, as bullet points, in English." }, { role: 'user', content: `${s.summary ? `Previous summary:\n${s.summary}\n\n` : ''}${old}` }],
      temperature: 0.2,
      max_tokens: SUMMARY_ANSWER,
      chat_template_kwargs: { enable_thinking: false },
    }, { externalRequest: true, signal, info: this.modelInfo(s), waitSec: Infinity });
    if (r.code !== 200) return false;
    this.addUsage(s, r.json.usage);
    s.summary = String(r.json.choices?.[0]?.message?.content ?? '').slice(0, 2000);
    return Boolean(s.summary.trim());
  }

  /**
   * Compact (user request 08.10.2026, like Claude Code /compact): the conversation so far is summarized and leaves the
   * model context, so later answers are faster and the context does not fill up; the messages stay visible. Idle only.
   */
  async compact(id) {
    const s = this.get(id);
    if (s.status !== 'idle') throw new UserError('Chat is currently running; compact it when it finishes.', 'inUse');
    const cut = s.messages.length - s.trimmed;
    if (cut < 2) return { message: 'Nothing to compact yet.', chat: this.summary(s) };
    const control = new AbortController();
    s.work = { control, approval: null, progress: 'Compacting the conversation…', usage: { input: 0, output: 0 }, started: Date.now(), tool: null };
    s.status = 'running';
    this.emit(s, 'start');
    this.emit(s, 'progress', { text: s.work.progress });
    let error = null;
    try {
      if (!(await this.summarize(s, cut, control.signal))) throw new UserError('The text model could not summarize the conversation; try again.');
      s.messages.push({ role: 'note', kind: 'compact', content: s.summary, time: new Date().toISOString() });
      s.trimmed = s.messages.length;
      // a fresh start: the loaded tools and MCP servers go too (they come back with their guides when needed)
      s.loadedTools = [];
      s.mcpLoaded = [];
      // the conversation is empty again: the gauge reads 0 until the next call measures it
      delete s.contextTokens;
      delete s.conversationTokens;
      this.emit(s, 'compact', { summary: s.summary });
      // The context gauge drops at once (user report 08.10.2026: "Compact yaptım alttakini sıfırlamadı")
      this.emit(s, 'context', { used: this.estimateContext(s), size: this.conversationRoom(s) });
      return { message: 'Conversation compacted.', chat: this.summary(s) };
    } catch (e) {
      error = control.signal.aborted ? null : e.message;
      throw control.signal.aborted ? new UserError('Compacting stopped.') : e;
    } finally {
      // a message sent while compacting was queued: it is kept and answered now
      const waiting = s.work?.inbox ?? [];
      s.status = 'idle';
      s.work = null;
      if (waiting.length) s.messages.push(...waiting);
      this.save(s, true);
      this.emit(s, 'done', { response: '', error, compact: true });
      if (waiting.length) setImmediate(() => s.status === 'idle' && this.run(s).catch(() => {}));
      else setImmediate(() => this.idle(s));
    }
  }

  /**
   * null: not known yet, true: llama-server parses tool calls, false: <tool> blocks in the text (per model file; per
   * remote model name for a call that goes to the remote model).
   */
  native(s) {
    return this.nativeTools.get(this.modelKey(s)) ?? null;
  }

  setNative(s, value) {
    this.nativeTools.set(this.modelKey(s), value);
    this.nativeTool = value;
  }

  modelKey(s) {
    const remote = this.remoteFor(s);
    return remote ? `${REMOTE_MODEL}:${remote.model}` : (this.localInfo(s)?.file ?? '');
  }

  toolSchemas(tools) {
    return tools.map((a) => ({ type: 'function', function: { name: a.name, description: a.description, parameters: a.params } }));
  }

  /**
   * Streamed answer pieces to the chat's event stream, batched every ~40 ms: delta { text }, and the model's thinking
   * as reasoning { text } with progress "Thinking…" (user request 08.10.2026: the answer should appear as it is
   * written, not after 30-50 s).
   * Token use counts up while the model writes (user report 08.10.2026: "token işlemde bir hesaplanıyor, anlık
   * göstermiyor"): the estimated prompt at once, then one token per streamed piece (llama-server sends one token per
   * chunk), every ~250 ms; the measured numbers replace the estimate when the call ends.
   * The text sent so far stays in s.work.live until the call ends (user report 08.10.2026: a chat opened again, or
   * a stream that reconnected, lost the live answer): the first event of a stream carries it (detail().live).
   */
  liveWriter(s, promptTokens = 0) {
    let pending = '';
    // the model's thinking streams too (user request 08.10.2026: show it, not only "Thinking…"): reasoning events
    let pendingReasoning = '';
    let timer = null;
    let thinking = false;
    let written = 0;
    let counted = 0;
    let countTimer = null;
    if (s.work) s.work.live = { text: '', reasoning: '' };
    const count = () => {
      countTimer = null;
      counted = written;
      this.liveUsage(s, promptTokens, written);
    };
    const flush = () => {
      timer = null;
      // only what the events carried: a stream that opens now gets it once, and the next pieces after it
      if (pendingReasoning) {
        if (s.work?.live) s.work.live.reasoning += pendingReasoning;
        this.emit(s, 'reasoning', { text: pendingReasoning });
      }
      if (pending) {
        if (s.work?.live) s.work.live.text += pending;
        this.emit(s, 'delta', { text: pending });
      }
      pending = '';
      pendingReasoning = '';
    };
    this.liveUsage(s, promptTokens, 0);
    return {
      estimate: () => ({ prompt_tokens: promptTokens, completion_tokens: written }),
      chunk: (c) => {
        written++;
        if (written !== counted) countTimer ??= setTimeout(count, 250);
        if (c.thinking) {
          if (!thinking) {
            thinking = true;
            this.emit(s, 'progress', { text: 'Thinking…' });
          }
          pendingReasoning += c.thinking;
          timer ??= setTimeout(flush, 40);
        }
        if (c.text) {
          if (thinking) {
            thinking = false;
            this.emit(s, 'progress', { text: '' });
          }
          pending += c.text;
          timer ??= setTimeout(flush, 40);
        }
      },
      end: () => {
        clearTimeout(timer);
        clearTimeout(countTimer);
        flush();
        // the answer becomes a message (or tool calls) right after this, before any other event can be sent
        if (s.work) s.work.live = null;
        if (thinking) this.emit(s, 'progress', { text: '' });
      },
    };
  }

  /** Usage event with tokens of the call still running added (not stored; addUsage stores the measured ones). */
  liveUsage(s, input, output) {
    if (!s.work) return;
    const add = (u) => ({ input: (u?.input ?? 0) + input, output: (u?.output ?? 0) + output });
    this.emit(s, 'usage', { run: add(s.work.usage), total: add(s.usage), live: true });
  }

  /**
   * Model cagrisi -> { text, calls: [{id, name, input}], raw }. Where it goes (local or remote, remoteFor) is decided
   * once for the whole call: the GPU may get busy while the prompt is built.
   */
  async callModel(s, tools, signal) {
    const remote = this.remoteFor(s);
    if (s.work) s.work.remote = remote;
    try {
      // the chat is on the local model and the GPU is busy: say who answers (Settings › Remote model › while the GPU is busy)
      if (remote && s.model !== REMOTE_MODEL) this.emit(s, 'progress', { text: `The GPU is busy with a job; ${remote.model} (remote) answers.` });
      return await this.modelCall(s, tools, signal);
    } finally {
      if (s.work) delete s.work.remote;
    }
  }

  async modelCall(s, tools, signal) {
    const messages = [{ role: 'system', content: `${this.systemPrompt(s, tools)}${s.summary ? `\n\nSummary of the earlier conversation:\n${s.summary}` : ''}` }, ...(await this.translateMessages(s, signal))];
    this.baseTokens = token(messages[0].content) + (this.native(s) === false ? 0 : token(JSON.stringify(this.toolSchemas(tools))));
    const budget = THINKING_BUDGET[s.thinking] ?? 0;
    const promptGuess = token(JSON.stringify(messages)) + (this.native(s) === false ? 0 : token(JSON.stringify(this.toolSchemas(tools))));
    const room = this.contextSize() - promptGuess - 256;
    // The answer stops with room to spare (user 08.10.2026: "16k ise 14k'da kesmeli, sonra kalanı"): at most 14k, and
    // 2k of the context (after instructions, tools and messages) stays free for the next step; a cut write_file keeps
    // its whole lines (salvageWrite) and the model writes the rest
    const body = { messages: messages, temperature: TEMPERATURE_CAP, max_tokens: Math.max(RESPONSE_TOKEN + budget, Math.min(ANSWER_TOKEN_CAP + budget, room - 2048)), chat_template_kwargs: { enable_thinking: budget > 0 }, ...(budget > 0 ? { thinking_budget_tokens: budget } : {}), stream: false };
    // which job holds the GPU and how far it is (only "the GPU is busy" for minutes read as a fault), or the model loading
    const waiting = (b, x) => this.emit(s, 'progress', { text: !b ? '' : x?.loading ? 'Loading the text model…' : x?.typeName ? `${x.typeName} job is using the GPU (${Math.floor(x.percent ?? 0)}%); the answer goes on when it finishes…` : 'GPU is busy with another job; waiting…' });
    const info = this.modelInfo(s);
    // Estimated prompt (images about 800 tokens each, not their data) for the live token count
    const partTokens = (p) => (p?.type === 'image_url' ? 800 : token(p?.text));
    const promptTokens = this.baseTokens + messages.slice(1).reduce((t, m) => t + (Array.isArray(m.content) ? m.content.reduce((a, p) => a + partTokens(p), 0) : token(m.content)) + (m.tool_calls ? token(JSON.stringify(m.tool_calls)) : 0) + 4, 0);
    const live = this.setting.agentStream === false ? null : this.liveWriter(s, promptTokens);
    const onChunk = live ? live.chunk : null;
    let r;
    try {
      r = await this.modelRequest(s, body, tools, { signal, waiting, info, onChunk });
    } finally {
      live?.end();
    }
    if (r.code !== 200) throw new LlmError(r.json?.error?.message ?? `Text model HTTP ${r.code}`, r.code);
    // A server without usage numbers: the counted estimate is kept
    if (live && r.json && !r.json.usage) r.json.usage = live.estimate();
    return this.modelAnswer(s, r, { fixed: this.baseTokens, conversation: promptTokens - this.baseTokens });
  }

  /** Native tool calls first; if the chat template cannot do them, <tool> blocks in plain text (system prompt lists the tools). */
  async modelRequest(s, body, tools, { signal, waiting, info, onChunk }) {
    let r;
    if (this.native(s) !== false) {
      r = await this.textRequest(s, { ...body, tools: this.toolSchemas(tools), tool_choice: 'auto' }, { externalRequest: true, signal, waiting, info, onChunk, waitSec: Infinity });
      if (r.code !== 200 && this.native(s) === null && /tool|template|jinja|function/i.test(r.json?.error?.message ?? '')) {
        this.log(`[agent] text model template does not support tool calls (${r.json?.error?.message}); <tool> blocks will be used.`);
        this.setNative(s, false);
      } else if (r.code === 200 && this.native(s) === null) this.setNative(s, true);
    }
    if (this.native(s) === false) {
      // Text mode: the system prompt is built again with the tool list
      const m2 = [{ role: 'system', content: `${this.systemPrompt(s, tools)}${s.summary ? `\n\nSummary of the earlier conversation:\n${s.summary}` : ''}` }, ...(await this.translateMessages(s, signal))];
      r = await this.textRequest(s, { ...body, messages: m2 }, { externalRequest: true, signal, waiting, info, onChunk, waitSec: Infinity });
    }
    return r;
  }

  modelAnswer(s, r, estimate = null) {
    this.addUsage(s, r.json.usage);
    // How full the context is: the last call's prompt plus its answer. The gauge shows the conversation's share: the
    // measured prompt split by the estimated sizes of the fixed part (instructions, tools, summary) and the messages
    const u = r.json.usage;
    if (u) {
      const prompt = Number(u.prompt_tokens) || 0;
      const answer = Number(u.completion_tokens) || 0;
      s.contextTokens = prompt + answer;
      const share = estimate && estimate.fixed + estimate.conversation > 0 ? Math.max(0, estimate.conversation) / (estimate.fixed + Math.max(0, estimate.conversation)) : 1;
      s.conversationTokens = Math.round(prompt * share) + answer;
      s.fixedTokens = Math.max(0, prompt - Math.round(prompt * share));
      this.emit(s, 'context', { used: s.conversationTokens, size: this.conversationRoom(s) });
    }
    const message = r.json.choices?.[0]?.message ?? {};
    const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((p) => p?.text ?? '').join('') : '';
    const calls = (message.tool_calls ?? []).map((t) => {
      let input = {};
      try {
        input = typeof t.function?.arguments === 'string' ? JSON.parse(t.function.arguments || '{}') : t.function?.arguments ?? {};
      } catch {
        input = { _error: 'arguments are not JSON', raw: t.function?.arguments };
      }
      return { id: t.id, name: t.function?.name, input };
    });
    // stopped at the output limit (max_tokens): a tool call in it may be incomplete
    const cut = r.json.choices?.[0]?.finish_reason === 'length';
    // the model's thinking: kept with the message for the user (folded in the chat), never sent back to the model
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content.trim().slice(0, REASONING_KEEP) : '';
    if (calls.length) return { text: content.trim(), calls, raw: null, cut, content, reasoning };
    // Sablon ayristirmadiysa metindeki bloklar
    const b = toolBlocks(content, { fenced: this.native(s) === false, known: new Set(TOOLS.map((t) => t.name)) });
    return { text: b.text, calls: b.calls, raw: b.calls.length ? content : null, cut, content, reasoning };
  }

  /**
   * Chats and agents working right now (sub-agents and scheduled tasks too), longest running first: the chat's
   * "Running" list (user request 08.10.2026: "çalışan agentleri görmeliyiz sendeki gibi"; GET /chat/running).
   */
  running() {
    return [...this.chats.values()]
      .filter((s) => s.work)
      .map((s) => ({ id: s.id, title: s.title, status: s.status, parent: s.parent ?? null, agent: Boolean(s.agent), step: s.step, tool: s.work.tool ?? null, progress: s.work.progress ?? null, seconds: Math.round((Date.now() - (s.work.started ?? Date.now())) / 1000), usage: s.work.usage ?? null }))
      .sort((a, z) => z.seconds - a.seconds);
  }

  /* ── Sub-agents ── */

  /** notify: the parent is woken with the result when it finishes (sub_agent wait: false; user request 09.10.2026). */
  async subAgent({ parent, task, notify = false }) {
    const depth = (() => {
      let d = 0;
      let s = parent;
      while (s?.parent && d < 10) {
        s = this.peek(s.parent);
        d += 1;
      }
      return d;
    })();
    if (depth >= 3) throw new Error('Sub-agent depth limit (3).');
    const running = [...this.chats.values()].filter((x) => x.status !== 'idle').length;
    if (running >= 8) throw new Error('At most 8 agents run at the same time.');
    // a temporary chat's sub-agents are temporary too
    const sub = this.create({ title: subAgentTitle(task, parent.cwd), agent: true, full: parent.full, approvalMode: parent.approvalMode, model: parent.model, cwd: parent.cwd, parent: parent.id, thinking: parent.thinking, temporary: Boolean(parent.temporary) });
    sub.messages.push({ role: 'user', content: task, attachments: [], time: new Date().toISOString() });
    this.emit(sub, 'message', { message: sub.messages.at(-1) });
    if (notify) this.subNotify.set(sub.id, parent.id);
    this.run(sub).catch(() => {}).finally(() => this.subAgentDone(sub));
    return { id: sub.id };
  }

  async agentResult(id, signal) {
    const s = this.get(id);
    const startedAt = Date.now();
    while (s.status !== 'idle' || !s.messages.some((m) => m.role === 'assistant')) {
      if (signal?.aborted) throw new CancelError();
      if (Date.now() - startedAt > 6 * 3600000) return `Sub-agent ${id} did not finish within 6 hours.`;
      if (s.status === 'idle' && s.error) break;
      await wait(1000);
    }
    // the parent has the result: no message about it later
    this.subAgentSeen(s.id);
    const last = [...s.messages].reverse().find((m) => m.role === 'assistant');
    return `[sub-agent ${s.id} ${s.error ? `error: ${s.error}` : 'done'}]\n${truncate(last?.content ?? '(no reply)', 6000)}`;
  }

  /** A sub-agent started with wait: false finished: its parent is woken with the result (not when it was stopped). */
  subAgentDone(sub) {
    const parent = this.subNotify.get(sub.id);
    if (!parent || sub.deleted) return;
    this.subNotify.delete(sub.id);
    const last = [...sub.messages].reverse().find((m) => m.role === 'assistant');
    if (last?.stopped) return;
    this.wake(parent, `[Sub-agent ${sub.id} finished${sub.error ? ` with an error: ${sub.error}` : ''}] ${tail(last?.content ?? '(no reply)')}`, { kind: 'agent', ref: sub.id, fallback: { title: sub.title, full: sub.full, approvalMode: sub.approvalMode, cwd: sub.cwd } });
  }

  /** The parent read a sub-agent's result itself (agent_status): it is not sent to it again. */
  subAgentSeen(subId) {
    this.subNotify.delete(String(subId));
  }

  /*
   * ── Background (user request 09.10.2026: "Sendeki gibi olsun onda da", like Claude Code's background tools) ──
   * Background commands, watches, monitors and sub-agents started with wait: false wake their chat when something
   * happens; wake-ups (schedule from a chat) go on in the same chat. Every item can be listed and stopped one by one,
   * and stopping a chat stops all of its items ("Ajan durdurulabilmeli").
   */

  /** Whether the chat is working now (a message from the background waits for it). */
  busy(chatId) {
    return Boolean(this.chats.get(chatId)?.work);
  }

  /**
   * A message from the background (like Claude Code's task notifications): it goes into the chat as a turn of the user,
   * marked with where it came from (wake: { kind, id }; the chat shows it as a note), and the chat runs. A chat that is
   * working gets it when it is idle again; one that is gone (deleted, or temporary and closed) is replaced by a new "⏰"
   * chat with the access the item was made with (fallback: { title, full, approvalMode, cwd }). Returns the id of the
   * chat that got it (null while the panel closes).
   */
  wake(chatId, text, { kind, ref = null, fallback = {} } = {}) {
    if (this.closing) return null;
    let s = chatId ? this.find(chatId) : null;
    if (s?.deleted) s = null;
    if (!s) {
      s = this.create({ title: `⏰ ${String(fallback.title || text).replace(/\s+/g, ' ').trim().slice(0, 60)}`, agent: true, full: Boolean(fallback.full), approvalMode: APPROVAL_MODES.includes(fallback.approvalMode) ? fallback.approvalMode : 'edits', canAsk: false, cwd: fallback.cwd ?? null });
      this.log(`[agent] ${kind} ${ref ?? ''}: its chat is gone, it goes on in a new chat (${s.id})`);
    }
    const message = { id: id(), role: 'user', content: String(text), attachments: [], time: new Date().toISOString(), wake: { kind, id: ref } };
    this.wakes.set(s.id, [...(this.wakes.get(s.id) ?? []), message]);
    this.deliverWakes(s);
    return s.id;
  }

  /** Messages from the background that waited: into the conversation, and the chat runs (not while it works). */
  deliverWakes(s) {
    const list = this.wakes.get(s.id);
    if (!list?.length || s.work || s.deleted || this.closing) return;
    this.wakes.delete(s.id);
    for (const m of list) {
      s.messages.push(m);
      this.emit(s, 'message', { message: m });
    }
    this.save(s);
    if (this.llm?.installed) this.run(s).catch(() => {});
  }

  /** The chat finished a run: the lines its monitors held for it, then the messages that waited. */
  idle(s) {
    if (s.work || s.deleted || this.closing) return;
    this.watchers.chatIdle(s.id);
    this.deliverWakes(s);
  }

  /** A line from the background that the model reads with the next message, without a model call (a watch that ended). */
  note(chatId, text, { kind, ref = null } = {}) {
    const s = chatId ? this.find(chatId) : null;
    if (!s || s.deleted) return;
    const m = { id: id(), role: 'note', kind: 'background', content: String(text), wake: { kind, id: ref }, time: new Date().toISOString() };
    s.messages.push(m);
    this.events.emit('event', { chat: s.id, type: 'note', message: m, time: m.time });
    this.save(s);
  }

  /** The chat's background list changed: a "background" event with the list (its line and the Running list follow). */
  backgroundChanged(chatId) {
    if (!chatId || this.closing || this.backgroundTimers.has(chatId)) return;
    const t = setTimeout(() => {
      this.backgroundTimers.delete(chatId);
      if (!this.closing) this.events.emit('event', { chat: chatId, type: 'background', time: new Date().toISOString(), items: this.backgroundList(chatId) });
    }, 100);
    t.unref?.();
    this.backgroundTimers.set(chatId, t);
  }

  /**
   * A background command (run_command back_plan) wakes its chat when it ends: the exit code, how long it ran and the end
   * of its output; not when it was stopped or its end was read already (command_output).
   */
  notifyWhenDone(s, kid, record) {
    const fallback = { title: record.command, full: s.full, approvalMode: s.approvalMode, cwd: s.cwd };
    record.done.then(() => {
      if (record.stopped || record.reported || this.closing) return;
      record.reported = true;
      this.wake(record.chat, `[Background command ${kid} finished: exit code ${record.code}, ${durationText((record.ended ?? Date.now()) - record.start)}] ${tail(terminalText(record.output)) || '(no output)'}`, { kind: 'command', ref: kid, fallback });
    });
  }

  /** The chats a chat started (sub-agents): the saved ones and the temporary ones in memory. */
  childIds(chatId) {
    return [...new Set([...this.db.chatChildren(chatId), ...[...this.chats.values()].filter((c) => c.parent === chatId).map((c) => c.id)])];
  }

  /** Whether chatId is a sub-agent of ancestor (at any depth). */
  descends(chatId, ancestor) {
    let c = this.peek(chatId);
    for (let depth = 0; c?.parent && depth < 6; depth++) {
      if (c.parent === ancestor) return true;
      c = this.peek(c.parent);
    }
    return false;
  }

  /** A sub-agent as an item of its parent's list; ended: when it finished (its last message). */
  static agentItem(c) {
    const last = [...c.messages].reverse().find((m) => m.role === 'assistant');
    const status = c.work ? 'running' : c.error ? 'error' : last?.stopped ? 'stopped' : 'done';
    return { id: c.id, kind: 'agent', chat: c.parent, text: String(c.title ?? '').replace(/^↳\s*/, ''), status, state: c.status, started: c.creation, ended: c.work ? null : c.messages.at(-1)?.time ?? c.update ?? null, seconds: c.work ? Math.round((Date.now() - (c.work.started ?? Date.now())) / 1000) : null, tokens: (c.usage?.input ?? 0) + (c.usage?.output ?? 0), step: c.step ?? 0 };
  }

  /**
   * What a chat runs in the background (its line above the composer, the background tool), newest first: its
   * sub-agents (the finished ones too: the chat's history), background commands (of this run of the panel), watches,
   * monitors and wake-ups (its scheduled tasks). Without a chat: what every chat runs now (Settings › Assistant, the
   * Running list). Each: { id, kind: agent | command | watch | monitor | wakeup, chat, chatTitle, text, status: running
   * | waiting | done | stopped | error, started, ended (a finished sub-agent or command), seconds, tokens, every
   * (minutes), next, ends, last, lines }.
   */
  backgroundList(chatId = null) {
    const items = [];
    const now = Date.now();
    const subs = chatId ? this.childIds(chatId).map((x) => this.chats.get(x) ?? this.peek(x)).filter(Boolean) : [...this.chats.values()].filter((c) => c.parent && c.work);
    for (const c of subs) items.push(AgentManager.agentItem(c));
    for (const [kid, k] of this.processes.map) {
      if (chatId ? k.chat !== chatId : !k.chat || k.code !== null) continue;
      const status = k.code === null ? 'running' : k.stopped ? 'stopped' : k.code === 0 ? 'done' : 'error';
      items.push({ id: kid, kind: 'command', chat: k.chat, text: k.command, status, started: new Date(k.start).toISOString(), ended: k.ended ? new Date(k.ended).toISOString() : null, seconds: Math.round(((k.ended ?? now) - k.start) / 1000), code: k.code });
    }
    for (const w of this.watchers.items) {
      if (chatId && w.chat !== chatId) continue;
      const base = { id: w.id, kind: w.kind, chat: w.chat, started: w.creation, ends: w.ends, last: w.last };
      if (w.kind === 'monitor') items.push({ ...base, text: `${w.command}${w.pattern ? ` (lines matching /${w.pattern}/)` : ''}`, status: 'running', seconds: Math.round((now - Date.parse(w.creation)) / 1000), lines: w.lines });
      else items.push({ ...base, text: watchText(w), status: 'waiting', every: w.everyMin, next: w.next, checks: w.checks, repeat: w.repeat });
    }
    for (const z of this.schedules()) {
      if (z.chat && (!chatId || z.chat === chatId)) items.push({ id: z.id, kind: 'wakeup', chat: z.chat, text: z.task, status: 'waiting', started: z.creation, next: z.time, every: z.repeatMin ?? null });
    }
    const titles = new Map();
    for (const x of items) {
      if (!titles.has(x.chat)) titles.set(x.chat, x.chat ? this.peek(x.chat)?.title ?? null : null);
      x.chatTitle = titles.get(x.chat);
    }
    return items.sort((a, b) => String(b.started ?? '').localeCompare(String(a.started ?? '')));
  }

  /** The background tool's list: one line per item with its id, then what it is. */
  backgroundText(chatId) {
    const items = this.backgroundList(chatId);
    if (!items.length) return 'Nothing runs in the background for this chat.';
    const kind = { agent: 'sub-agent', command: 'background command', watch: 'watch', monitor: 'monitor', wakeup: 'wake-up' };
    const line = (x) => {
      const parts = [x.status];
      if (x.status === 'running' && x.seconds !== null && x.seconds !== undefined) parts.push(`for ${durationText(x.seconds * 1000)}`);
      if (x.kind === 'agent' && x.tokens) parts.push(`${x.tokens} tokens`);
      if (x.kind === 'command' && x.code !== null && x.code !== undefined) parts.push(`exit code ${x.code}`);
      if (x.kind === 'watch') parts.push(`every ${x.every} min, next check ${shortTime(x.next)}, ends ${shortTime(x.ends)}${x.last ? `, last check: ${x.last.text}` : ''}`);
      if (x.kind === 'monitor') parts.push(`${x.lines} lines, ends ${shortTime(x.ends)}`);
      if (x.kind === 'wakeup') parts.push(`next ${shortTime(x.next)}${x.every ? `, every ${x.every} min` : ''}`);
      return `- ${x.id} · ${kind[x.kind]} · ${parts.join(', ')}\n  ${String(x.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`;
    };
    return `${items.length} item${items.length === 1 ? '' : 's'} (stop one: background with stop: <id>):\n${items.map(line).join('\n')}`;
  }

  /** "1 sub-agent", "2 background commands"… (stop messages; the chat line builds the same words). */
  static countText(kind, n) {
    const names = { chat: ['chat', 'chats'], agent: ['sub-agent', 'sub-agents'], command: ['background command', 'background commands'], watch: ['watcher', 'watchers'], monitor: ['monitor', 'monitors'], wakeup: ['wake-up', 'wake-ups'] };
    return `${n} ${names[kind][n === 1 ? 0 : 1]}`;
  }

  /** What was stopped, counted by kind: "1 sub-agent · 2 background commands". */
  static stoppedText(stopped) {
    const counts = new Map();
    for (const x of stopped) counts.set(x.kind, (counts.get(x.kind) ?? 0) + 1);
    return ['chat', 'agent', 'command', 'watch', 'monitor', 'wakeup'].filter((k) => counts.get(k)).map((k) => AgentManager.countText(k, counts.get(k))).join(' · ');
  }

  /**
   * Stops what a chat runs in the background, its sub-agents' too: background commands (with their process trees),
   * monitors, working sub-agents and the messages waiting for it; and unless live (a deleted chat), its watches and
   * wake-ups. Returns [{ id, kind }].
   */
  stopBackground(chatId, { live = false } = {}) {
    const stopped = [];
    this.wakes.delete(chatId);
    for (const [kid, k] of this.processes.map) {
      if (k.chat !== chatId || k.code !== null || k.stopped) continue;
      this.processes.stop(kid);
      stopped.push({ id: kid, kind: 'command' });
    }
    for (const w of this.watchers.forChat(chatId)) {
      if (live && w.kind !== 'monitor') continue;
      this.watchers.remove(w.id);
      stopped.push({ id: w.id, kind: w.kind });
    }
    if (!live) {
      const list = this.schedules();
      const own = list.filter((z) => z.chat === chatId);
      if (own.length) {
        this.writeSchedules(list.filter((z) => z.chat !== chatId));
        stopped.push(...own.map((z) => ({ id: z.id, kind: 'wakeup' })));
      }
    }
    for (const sub of this.childIds(chatId)) {
      this.subNotify.delete(sub);
      const c = this.chats.get(sub);
      if (c?.work) {
        this.stopStep(c);
        stopped.push({ id: sub, kind: 'agent' });
      }
      stopped.push(...this.stopBackground(sub, { live }));
    }
    if (stopped.length) this.backgroundChanged(chatId);
    return stopped;
  }

  /**
   * Stops one item of the background by its id: a background command, a watch, a monitor, a wake-up (any scheduled
   * task) or a sub-agent (with what it runs). chat: only an item of that chat or of its sub-agents (the background tool).
   */
  stopItem(itemId, { chat = null } = {}) {
    const key = String(itemId ?? '').trim();
    const own = (owner) => !chat || Boolean(owner && (owner === chat || this.descends(owner, chat)));
    const k = this.processes.map.get(key);
    if (k && own(k.chat)) {
      if (k.code !== null) throw new UserError(`Background command ${key} has already finished.`);
      this.processes.stop(key);
      this.backgroundChanged(k.chat);
      return { message: `Background command ${key} stopped.`, stopped: [{ id: key, kind: 'command' }] };
    }
    const w = this.watchers.get(key);
    if (w && own(w.chat)) {
      this.watchers.remove(key);
      return { message: `${w.kind === 'monitor' ? 'Monitor' : 'Watcher'} ${key} stopped.`, stopped: [{ id: key, kind: w.kind }] };
    }
    const z = this.schedules().find((x) => x.id === key);
    if (z && own(z.chat)) {
      this.deleteSchedule(key);
      this.backgroundChanged(z.chat);
      return { message: z.chat ? `Wake-up ${key} removed.` : `Scheduled task ${key} removed.`, stopped: [{ id: key, kind: 'wakeup' }] };
    }
    const sub = /^[a-z0-9]+$/i.test(key) ? this.peek(key) : null;
    if (sub?.parent && own(sub.parent)) {
      this.subNotify.delete(key);
      const working = this.chats.get(key);
      const stopped = this.stopBackground(key);
      if (working?.work) {
        this.stopStep(working);
        stopped.unshift({ id: key, kind: 'agent' });
      }
      if (!stopped.length) throw new UserError(`Sub-agent ${key} has already finished.`);
      this.backgroundChanged(sub.parent);
      return { message: `Stopped: ${AgentManager.stoppedText(stopped)}.`, stopped };
    }
    throw new UserError(`Nothing runs in the background with the id ${key}${chat ? ' for this chat' : ''}.`, 'notFound');
  }

  /** Stop all (the Running list): every chat that works and everything every chat runs in the background. */
  stopAll() {
    const stopped = [];
    for (const s of this.chats.values()) {
      if (!s.work || s.parent) continue;
      this.stopStep(s);
      stopped.push({ id: s.id, kind: 'chat' });
    }
    const owners = new Set(this.wakes.keys());
    for (const k of this.processes.map.values()) if (k.chat && k.code === null && !k.stopped) owners.add(k.chat);
    for (const w of this.watchers.items) owners.add(w.chat);
    for (const z of this.schedules()) if (z.chat) owners.add(z.chat);
    for (const c of this.chats.values()) if (c.work && c.parent) owners.add(c.parent);
    for (const chat of owners) stopped.push(...this.stopBackground(chat));
    // sub-agents whose parent is not there any more
    for (const c of this.chats.values()) {
      if (!c.work || stopped.some((x) => x.id === c.id)) continue;
      this.stopStep(c);
      stopped.push({ id: c.id, kind: c.parent ? 'agent' : 'chat' });
    }
    const seen = new Set();
    const unique = stopped.filter((x) => !seen.has(x.id) && seen.add(x.id));
    return { message: unique.length ? `Stopped: ${AgentManager.stoppedText(unique)}.` : 'Nothing was running.', stopped: unique };
  }

  /* ── Schedules ── */

  schedules() {
    try {
      return JSON.parse(readFileSync(this.scheduleFile, 'utf8'));
    } catch {
      return [];
    }
  }

  writeSchedules(list) {
    writeFileSync(this.scheduleFile, JSON.stringify(list, null, 1));
  }

  /**
   * chat: a wake-up of that chat (the schedule tool; user request 09.10.2026): it goes on in the same chat, a repeat
   * too; without one (Settings) every run gets a new "⏰" chat.
   */
  schedule({ task, minuteAfter, time, repeatMin, full = false, approvalMode = 'edits', cwd = null, chat = null }) {
    let t = time ? Date.parse(time) : NaN;
    if (!Number.isFinite(t) && minuteAfter) t = Date.now() + Number(minuteAfter) * 60000;
    if (!Number.isFinite(t) && repeatMin) t = Date.now() + Number(repeatMin) * 60000;
    if (!Number.isFinite(t)) throw new Error('time (ISO) or minute_after is required.');
    const z = { id: id(), task: String(task).slice(0, 2000), time: new Date(t).toISOString(), repeatMin: repeatMin ? Math.max(1, Number(repeatMin)) : null, full: Boolean(full), approvalMode: AgentManager.approvalMode(approvalMode), cwd, ...(chat ? { chat } : {}), creation: new Date().toISOString() };
    const list = this.schedules();
    if (list.length >= 50) throw new Error('At most 50 schedules.');
    list.push(z);
    this.writeSchedules(list);
    this.backgroundChanged(chat);
    return { message: `Scheduled: ${new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/Istanbul' })}${z.repeatMin ? `, every ${z.repeatMin} min` : ''}${chat ? ' (in this chat)' : ''}`, scheduleEntry: z };
  }

  scheduleList() {
    return this.schedules();
  }

  deleteSchedule(id) {
    const list = this.schedules();
    const remaining = list.filter((z) => z.id !== String(id));
    if (remaining.length === list.length) throw new Error('No such schedule.');
    this.writeSchedules(remaining);
    return 'Schedule deleted.';
  }

  async processSchedules() {
    const list = this.schedules();
    const now = Date.now();
    let changed = false;
    const woken = new Set();
    for (const z of list) {
      if (Date.parse(z.time) > now) continue;
      changed = true;
      if (z.repeatMin) z.time = new Date(now + z.repeatMin * 60000).toISOString();
      else z.done = true;
      if (!this.llm?.installed) continue;
      // the task knows its schedule's id (it can remove itself with schedules or background)
      const text = `[schedule ${z.id}${z.repeatMin ? `, every ${z.repeatMin} min` : ''}] ${z.task}`;
      if (z.chat) {
        // a wake-up goes on in its chat; when that is gone, in a new "⏰" chat, and its repeats in that one
        z.chat = this.wake(z.chat, text, { kind: 'schedule', ref: z.id, fallback: { title: z.task, full: z.full, approvalMode: z.approvalMode, cwd: z.cwd } }) ?? z.chat;
        woken.add(z.chat);
        this.log(`[agent] wake-up ${z.id}: ${z.task.slice(0, 80)}`);
        continue;
      }
      const s = this.create({ title: `⏰ ${z.task.slice(0, 60)}`, agent: true, full: z.full, approvalMode: z.approvalMode, unattended: z.unattended, canAsk: false, cwd: z.cwd });
      s.messages.push({ id: id(), role: 'user', content: text, attachments: [], time: new Date().toISOString() });
      this.log(`[agent] scheduled task started: ${z.task.slice(0, 80)}`);
      this.run(s).catch(() => {});
    }
    if (changed) this.writeSchedules(list.filter((z) => !z.done));
    for (const chat of woken) this.backgroundChanged(chat);
  }

  /* ── Tool list (UI) ── */

  toolInfo() {
    return {
      tools: TOOLS.map((a) => ({ name: a.name, description: a.description, full: Boolean(a.full), approval: Boolean(a.risk) })),
      mcp: Object.values(this.mcp.servers()).map((m) => ({ name: m.name, type: m.type, source: m.source })),
      skills: this.skills().map((b) => ({ name: b.name, description: b.description, source: b.source })),
      processes: this.processes.list(),
      schedules: this.schedules(),
      background: this.backgroundList(),
      memory: this.readMemory(),
      textModel: this.llm?.status?.() ?? null,
      readsImages: Boolean(this.llm?.understandsImages),
      approvalModes: APPROVAL_MODES,
    };
  }

  /*
   * ── Settings › Assistant (user request 08.10.2026): what the assistant keeps, seen and changed by the user:
   * scheduled tasks, lasting notes, skills and MCP servers. The same stores the tools use; errors are the user's.
   */

  static userError(fn) {
    try {
      return fn();
    } catch (e) {
      throw e instanceof UserError ? e : new UserError(e.message);
    }
  }

  /** A scheduled task changed: its task, next time, repeat (minutes; 0 or null: once) and approval mode. */
  updateSchedule(scheduleId, { task, time, repeatMin, approvalMode } = {}) {
    const list = this.schedules();
    const z = list.find((x) => x.id === String(scheduleId ?? ''));
    if (!z) throw new UserError('No such schedule.', 'notFound');
    if (task !== undefined) {
      const clean = String(task ?? '').trim();
      if (!clean) throw new UserError('Write the task.');
      z.task = clean.slice(0, 2000);
    }
    if (time !== undefined) {
      const t = Date.parse(time);
      if (!Number.isFinite(t)) throw new UserError('time must be a date and time (ISO 8601).');
      z.time = new Date(t).toISOString();
    }
    if (repeatMin !== undefined) z.repeatMin = Number(repeatMin) > 0 ? Math.max(1, Math.round(Number(repeatMin))) : null;
    if (approvalMode !== undefined) z.approvalMode = AgentManager.approvalMode(approvalMode, undefined, z.approvalMode);
    this.writeSchedules(list);
    return { message: 'Schedule saved.', schedule: z };
  }

  /** The lasting notes, newest first; query: those with all the words (case, accents and Turkish i do not matter). */
  memoryNotes(query = '') {
    const notes = this.notes();
    const words = searchWords(query);
    const found = words.length ? notes.filter((n) => words.every((w) => searchFold(`${n.date} ${n.text}`).includes(w))) : notes;
    return { notes: [...found].reverse(), total: notes.length };
  }

  /** Every skill with whether the panel can remove it (only those installed into panel-data\skills). */
  skillList() {
    this.skillCache = null;
    const own = resolve(join(this.setting.dataRoot, DATA_FILES.skills));
    return this.skills().map((k) => ({ name: k.name, description: k.description, source: k.source, folder: k.folder, removable: k.source === 'panel' && dirname(resolve(k.folder)) === own }));
  }

  /** Removes a skill installed into panel-data\skills (to the Recycle Bin). */
  async removeSkill(name) {
    const k = this.skillList().find((x) => x.name === String(name ?? ''));
    if (!k) throw new UserError('No such skill.', 'notFound');
    if (!k.removable) throw new UserError(`This skill comes from ${k.source} (${k.folder}); only skills installed by the panel can be removed here.`);
    await moveToRecycleBin(k.folder);
    this.skillCache = null;
    return { message: `Skill removed: ${k.name} (in the Recycle Bin).` };
  }

  /** Installed plugins (panel-data\plugins) with the skills and MCP servers each brings. */
  pluginList() {
    return pluginFolders(this.setting.dataRoot).map((e) => ({ ...e, skills: pluginSkills(e.path), mcp: Object.keys(pluginMcpServers(e.path) ?? {}) }));
  }

  /** Removes an installed plugin (to the Recycle Bin); its MCP servers stop. */
  async removePlugin(name) {
    const k = this.pluginList().find((x) => x.name === String(name ?? ''));
    if (!k) throw new UserError('No such plugin.', 'notFound');
    // its servers run in its folder: stop them first
    this.mcp.prune(k.mcp);
    await moveToRecycleBin(k.path);
    this.skillCache = null;
    this.mcp.prune();
    return { message: `Plugin removed: ${k.name} (in the Recycle Bin).` };
  }

  /**
   * Adds (or replaces) a server of the panel and starts it to see that it works; one that does not start is not kept
   * (the previous definition comes back). definition: { command, args, env } or { url, headers }; timeoutSec.
   */
  async addMcpServer({ name, command, args, env, url, headers, timeoutSec } = {}) {
    const clean = String(name ?? '').trim();
    if (!/^[\w-]{1,40}$/.test(clean)) throw new UserError('Name the server with 1 to 40 letters, digits, - or _.');
    const strings = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), String(v)]));
    const limit = Number(timeoutSec) > 0 ? { timeout: Math.round(Number(timeoutSec) * 1000) } : {};
    const definition = String(url ?? '').trim()
      ? { type: 'http', url: String(url).trim(), ...(Object.keys(strings(headers)).length ? { headers: strings(headers) } : {}), ...limit }
      : String(command ?? '').trim()
        ? { command: String(command).trim(), args: (Array.isArray(args) ? args : []).map(String).filter((a) => a !== ''), ...(Object.keys(strings(env)).length ? { env: strings(env) } : {}), ...limit }
        : null;
    if (!definition) throw new UserError('Give a command (and its arguments) for a local server or an address for a remote one.');
    if (definition.url && !/^https?:\/\//i.test(definition.url)) throw new UserError('The address must start with http:// or https://.');
    const previous = this.mcp.panelDefinition(clean);
    this.mcp.save(clean, definition);
    try {
      const list = await this.mcp.client(clean).toolList();
      return { message: `MCP server "${clean}" added with ${list.length} tool${list.length === 1 ? '' : 's'}.`, server: this.mcp.list().find((s) => s.name === clean) };
    } catch (e) {
      this.mcp.save(clean, previous);
      throw new UserError(`The server did not start (${e.message}); it was not added${previous ? ' (the previous definition is back)' : ''}.`);
    }
  }

  /** Starts a server (if it is not running) and lists its tools. */
  async checkMcpServer(name) {
    const server = this.mcp.list().find((s) => s.name === String(name ?? ''));
    if (!server) throw new UserError('No such MCP server.', 'notFound');
    if (server.disabled) throw new UserError('The server is turned off; turn it on first.');
    try {
      const list = await this.mcp.client(server.name).toolList();
      return { message: `MCP server "${server.name}" works: ${list.length} tool${list.length === 1 ? '' : 's'}.`, server: this.mcp.list().find((s) => s.name === server.name) };
    } catch (e) {
      throw new UserError(`MCP server "${server.name}" did not start: ${e.message}`);
    }
  }

  configureMcpServer(name, g = {}) {
    const server = this.mcp.configure(String(name ?? ''), { disabled: g.disabled === undefined ? undefined : Boolean(g.disabled), timeoutSec: g.timeoutSec });
    if (!server) throw new UserError('No such MCP server.', 'notFound');
    return { message: 'MCP server saved.', server };
  }

  removeMcpServer(name) {
    const server = this.mcp.list().find((s) => s.name === String(name ?? ''));
    if (!server) throw new UserError('No such MCP server.', 'notFound');
    if (!server.editable) throw new UserError(`This server is defined in ${server.source}; turn it off here instead (the file stays as it is).`);
    this.mcp.save(server.name, null);
    return { message: `MCP server "${server.name}" removed.` };
  }

  close() {
    clearInterval(this.timer);
    // nothing wakes a chat any more; the steps stop; watches and wake-ups are kept for the next start
    this.closing = true;
    for (const s of this.chats.values()) if (s.work) this.stopStep(s);
    for (const t of this.backgroundTimers.values()) clearTimeout(t);
    this.watchers.close();
    for (const [id, z] of this.recordTimer) {
      clearTimeout(z);
      const s = this.chats.get(id);
      if (s) this.save(s, true);
    }
    if (this.ownDb) this.db.close();
    this.processes.stopAll();
    this.mcp.closeAll();
    this.web.close();
  }
}
