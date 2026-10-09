#!/usr/bin/env node
/**
 * Nedese Studio CLI (user request 08.10.2026: a chat opened from any folder that can do everything up to writing
 * software): a chat with the panel's agent in the terminal, working in the current folder (files,
 * commands, git, web, panel jobs). It talks to the running panel over its API: on this computer the key comes from
 * panel-data/settings.json; another computer's panel with --url/--key (or NEDESE_URL / NEDESE_KEY).
 *
 *   nedese                          interactive chat in this folder
 *   nedese "fix the failing test"   starts with this message
 *   nedese -p "question"            prints the answer and exits (stdin is read when no question is given)
 *   nedese -c                       continues the last chat of this folder
 *   nedese -r [id]                  resumes a chat (without id: pick from a list)
 *   --mode manual|edits|auto        approval mode (default edits)      --model <file>   text model
 *   --lang en|tr                    language (default: NEDESE_LANG, else en)     --no-color
 *
 * In the chat "/" lists the commands with a description below the input (arrow keys, Tab, Enter). Ctrl+C stops the
 * running answer; twice on an empty line exits. A line ending with "\" continues on the next line.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import readline from 'node:readline';

const AI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let out = process.stdout;
let err = process.stderr;
let inp = process.stdin;

/** Test hook: fake terminal streams (input with isTTY/setRawMode, output with columns). */
export function setStreams({ input = inp, output = out, error = err } = {}) {
  inp = input;
  out = output;
  err = error;
}
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

class CliError extends Error {}

/* ── Arguments ─────────────────────────────────────────────────────────── */

export function parseArgs(argv, env = process.env) {
  const o = { mode: null, model: null, url: env.NEDESE_URL ?? null, key: env.NEDESE_KEY ?? null, print: false, cont: false, resume: null, lang: env.NEDESE_LANG ?? null, color: !env.NO_COLOR, help: false, words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new CliError(`${a} needs a value.`);
      return argv[++i];
    };
    if (a === '-p' || a === '--print') o.print = true;
    else if (a === '-c' || a === '--continue') o.cont = true;
    else if (a === '-r' || a === '--resume') o.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '';
    else if (a === '--mode') o.mode = value();
    else if (a === '--model') o.model = value();
    else if (a === '--url') o.url = value();
    else if (a === '--key') o.key = value();
    else if (a === '--lang') o.lang = value();
    else if (a === '--no-color') o.color = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-') && a.length > 1) throw new CliError(`Unknown option: ${a} (nedese --help)`);
    else o.words.push(a);
  }
  if (o.mode && !['manual', 'edits', 'auto'].includes(o.mode)) throw new CliError('--mode must be manual, edits or auto.');
  return o;
}

/* ── Language: the panel's dictionary (English source text -> Turkish) ───── */

function loadDictionary() {
  try {
    const sandbox = {};
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    runInNewContext(readFileSync(join(AI_ROOT, 'panel', 'web', 'lang', 'dictionary.js'), 'utf8'), sandbox);
    return sandbox.NedeseDictionary?.tr ?? {};
  } catch {
    return {};
  }
}

export function translator(dictionary) {
  const full = new Map();
  const patterns = [];
  for (const [en, tr] of Object.entries(dictionary)) {
    if (!/\{\d+\}/.test(en)) {
      full.set(en, tr);
      continue;
    }
    const position = [];
    const re = en.split(/(\{\d+\})/).map((p) => {
      const m = /^\{(\d+)\}$/.exec(p);
      if (m) {
        position.push(Number(m[1]));
        return '([\\s\\S]*?)';
      }
      return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    patterns.push({ re: new RegExp(`^${re}$`), position, tr, len: en.replace(/\{\d+\}/g, '').length });
  }
  patterns.sort((a, b) => b.len - a.len);
  const t = (text, depth = 0) => {
    const s = String(text ?? '');
    if (full.has(s)) return full.get(s);
    if (depth > 3) return s;
    for (const k of patterns) {
      const m = k.re.exec(s);
      if (!m) continue;
      const values = {};
      k.position.forEach((no, i) => {
        values[no] = t(m[i + 1], depth + 1);
      });
      return k.tr.replace(/\{(\d+)\}/g, (_, no) => values[no] ?? '');
    }
    return s;
  };
  return t;
}

/* ── Terminal helpers ──────────────────────────────────────────────────── */

let useColor = true;
const sgr = (a, b) => (s) => (useColor ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
// Markers are text glyphs (● not ⏺: Windows consoles draw ⏺ as a blue emoji box; user 08.10.2026: "basit duruyor")
const DOT = '●';
const c = { bold: sgr(1, 22), dim: sgr(2, 22), inverse: sgr(7, 27), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), blue: sgr(34, 39), magenta: sgr(35, 39), cyan: sgr(36, 39), gray: sgr(90, 39) };
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
/** Cuts a colored line to n visible characters. */
function fit(s, n) {
  let shown = 0;
  let result = '';
  for (const part of String(s).split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      result += part;
      continue;
    }
    const room = n - shown;
    if (room <= 0) continue;
    result += part.length > room ? `${part.slice(0, Math.max(0, room - 1))}…` : part;
    shown += Math.min(part.length, room);
  }
  return result + (useColor ? '\x1b[0m' : '');
}
const formatTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

const TOOL_LABELS = { panel_api: 'Panel', api_document: 'API docs', wait_job: 'Wait for job', look_image: 'Look at image', add_upload: 'Add to uploads', list_file: 'List', read_file: 'Read', write_file: 'Write', edit_file: 'Edit', search_file: 'Search', delete_file: 'Delete', run_command: 'Command', command_output: 'Command output', stop_command: 'Stop command', run_ssh: 'SSH command', search_web: 'Web search', fetch_web: 'Read web page', download: 'Download', sub_agent: 'Sub-agent', agent_status: 'Sub-agent status', write_memory: 'Save note', update_memory: 'Update note', search_memory: 'Search notes', search_chats: 'Search chats', delete_memory: 'Delete note', schedule: 'Schedule', schedules: 'Schedules', load_skill: 'Load skill', mcp_tools: 'MCP tools', call_mcp: 'MCP call' };

// An MCP tool the chat calls as its own function (mcp__<server>__<tool>) shows as "server · tool"
const toolLabel = (name) => TOOL_LABELS[name] ?? String(name ?? '').replace(/^mcp__(.+?)__(.+)$/, '$1 · $2');

function shortInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'panel_api') return `${input.method ?? 'GET'} ${input.path ?? ''}${input.body?.type ? ` · ${input.body.type}` : ''}`;
  if (name === 'call_mcp') return `${input.server ?? ''} · ${input.tool ?? ''}`;
  if (input.question) return input.question;
  return String(input.command ?? input.path ?? input.url ?? input.query ?? input.id ?? input.task ?? input.source ?? JSON.stringify(input)).replace(/\s+/g, ' ');
}

const MODES = [['manual', 'Asks before every change (files, commands, downloads)'], ['edits', 'Asks only before deleting, destructive commands and settings changes'], ['auto', 'Never asks']];
// The thinking budget of a chat (user request 08.10.2026: /thinking like the web chat's Options); low is the default
const THINKING = [['none', 'Answers at once'], ['low', 'A short think first'], ['medium', 'Thinks longer: harder tasks'], ['high', 'Thinks longest: slowest answers']];

/* ── Panel API ─────────────────────────────────────────────────────────── */

export class Panel {
  constructor({ url, key, lang }) {
    let local = {};
    try {
      local = JSON.parse(readFileSync(join(AI_ROOT, 'panel-data', 'settings.json'), 'utf8'));
    } catch {
      /* another computer's panel: --url and --key */
    }
    // The port of this installation (panel-data\settings.json), else the default in panel\defaults.json
    const port = Number(local.port) > 0 ? local.port : JSON.parse(readFileSync(join(AI_ROOT, 'panel', 'defaults.json'), 'utf8')).port;
    this.base = String(url ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
    this.key = key ?? local.apiKey ?? '';
    this.lang = lang;
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.key}`, 'X-Panel-Lang': this.lang, ...extra };
  }

  async call(path, { method = 'GET', body } = {}) {
    let r;
    try {
      r = await fetch(`${this.base}/api/v1${path}`, { method, headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new CliError(`Nedese Studio is not running at ${this.base}. Start it (the Nedese Studio shortcut or panel.bat) and try again.`);
    }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new CliError('The panel refused the API key (Settings › API key; --key or NEDESE_KEY).');
    if (!r.ok || j.ok === false) throw new CliError(j.error ?? `HTTP ${r.status}`);
    return j;
  }

  /** Server-sent events of one chat; reconnects until close(). */
  events(chatId, onEvent) {
    let closed = false;
    let controller = null;
    (async () => {
      while (!closed) {
        controller = new AbortController();
        try {
          const r = await fetch(`${this.base}/api/v1/chat/${encodeURIComponent(chatId)}/events`, { headers: this.headers({ Accept: 'text/event-stream' }), signal: controller.signal });
          if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
          const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value.replace(/\r\n?/g, '\n');
            let cut;
            while ((cut = buffer.indexOf('\n\n')) >= 0) {
              const data = buffer.slice(0, cut).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
              buffer = buffer.slice(cut + 2);
              if (!data) continue;
              let e;
              try {
                e = JSON.parse(data);
              } catch {
                continue;
              }
              if (!closed) onEvent(e);
            }
          }
        } catch {
          /* dropped: retry below */
        }
        if (!closed) await wait(1500);
      }
    })();
    return {
      close() {
        closed = true;
        controller?.abort();
      },
    };
  }
}

/* ── Chat session (shared by the interactive and the print mode) ───────── */

class Session {
  constructor({ panel, t, cwd, mode, model, print = false, ask }) {
    Object.assign(this, { panel, t, cwd, mode, model, print, ask });
    this.thinking = null; // null: the panel's default for a new chat
    this.chat = null;
    this.stream = null;
    this.turn = null; // { started, resolve, usage, text }
    this.inText = false;
    this.status = '';
    this.spinnerAt = 0;
    this.lastOutput = 0;
    this.timer = null;
    this.sentByMe = new Set();
    this.models = [];
    this.defaultModel = null;
    this.edits = []; // file edits of this chat (checkpoint, path) for /undo
    this.lastEventAt = 0;
    this.prompted = new Set(); // approvals and questions already shown
  }

  // stdout gets the answer; in print mode the chrome (tools, status) goes to stderr
  write(s) {
    this.clearStatus();
    (this.print ? err : out).write(s);
    this.lastOutput = Date.now();
  }

  answer(s) {
    this.clearStatus();
    out.write(s);
    this.lastOutput = Date.now();
  }

  line(s = '') {
    this.endText();
    this.write(`${s}\n`);
  }

  endText() {
    if (!this.inText) return;
    this.inText = false;
    this.answer('\n');
  }

  /** The window title (cmd, PowerShell, Windows Terminal): the chat's name, "●" in front while it works. */
  setTitle() {
    if (this.print || !out.isTTY) return;
    const name = String(this.chat?.title || this.firstText || basename(this.cwd) || 'Nedese').replace(/\s+/g, ' ').trim().slice(0, 60);
    try {
      process.title = `${this.turn ? '● ' : ''}${name} · Nedese`;
    } catch {
      /* not every host lets a program set it */
    }
  }

  async open(chat) {
    this.stream?.close();
    this.chat = chat;
    this.mode = chat.approvalMode ?? this.mode;
    this.model = chat.model ?? null;
    this.thinking = chat.thinking ?? this.thinking;
    let ready;
    const first = new Promise((ok) => {
      ready = ok;
    });
    this.stream = this.panel.events(chat.id, (e) => {
      this.lastEventAt = Date.now();
      if (e.type === 'status') {
        if (e.chat) Object.assign(this.chat, e.chat);
        ready();
        // (re)connected while a turn runs: what happened in between comes from the chat state
        if (this.turn?.sent && e.chat) this.catchUp(e.chat);
        return;
      }
      this.onEvent(e);
    });
    await Promise.race([first, wait(5000)]);
    this.setTitle();
  }

  /**
   * Events of the turn were missed (the stream was not connected yet, or it dropped for a moment): the chat state
   * finishes the turn with its last answer, or shows the approval / question it waits for.
   */
  catchUp(chat) {
    if (!this.turn) return;
    if (chat.status === 'approval' && chat.approval && !this.prompted.has(chat.approval.id)) this.onEvent({ type: 'approval', ...chat.approval });
    else if (chat.status === 'question' && chat.question && !this.prompted.has(chat.question.id)) this.onEvent({ type: 'question', ...chat.question });
    else if (chat.status === 'idle') {
      if (!this.turn.answered) {
        const last = [...(chat.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.content ?? chat.lastResponse ?? '';
        if (last) this.onEvent({ type: 'text', text: last });
      }
      this.onEvent({ type: 'done', response: chat.lastResponse ?? '', error: chat.error ?? null });
    }
  }

  async create() {
    const r = await this.panel.call('/chat', { method: 'POST', body: { cwd: this.cwd, approvalMode: this.mode ?? 'edits', model: this.model ?? null, ...(this.thinking ? { thinking: this.thinking } : {}), ...(this.print ? { canAsk: false } : {}) } });
    if (r.chat.cwd && resolve(r.chat.cwd).toLowerCase() !== resolve(this.cwd).toLowerCase()) this.line(c.yellow(this.t('Working folder: {0} (this connection has no file access here)').replace('{0}', r.chat.cwd)));
    await this.open(r.chat);
  }

  /**
   * Sends a message and resolves when the turn is done ({ error }). regenerate: no message, the last request goes
   * again and the model writes its answer anew (/regenerate; the old answer stays as the earlier version).
   */
  async send(text, { regenerate = false } = {}) {
    if (!this.chat) await this.create();
    const done = new Promise((ok) => {
      this.turn = { started: Date.now(), resolve: ok, usage: null };
    });
    if (!regenerate) {
      this.sentByMe.add(text);
      // the panel names a new chat after its first message
      if (!this.chat?.title && !this.firstText) this.firstText = text;
    }
    this.startStatus();
    this.setTitle();
    try {
      const sent = regenerate
        ? await this.panel.call(`/chat/${this.chat.id}/regenerate`, { method: 'POST', body: {} })
        : await this.panel.call(`/chat/${this.chat.id}/message`, { method: 'POST', body: { text } });
      if (this.turn) {
        this.turn.sent = true;
        if (sent?.queued) this.turn.queued = true;
      }
    } catch (e) {
      this.finishTurn({ error: e.message });
    }
    // No event for a few seconds: ask the panel how the chat is (a missed "done" would wait forever)
    const turn = this.turn;
    if (turn) {
      turn.watch = setInterval(async () => {
        if (this.turn !== turn || turn.checking || Date.now() - this.lastEventAt < 3000) return;
        turn.checking = true;
        try {
          const running = await this.panel.call('/chat/running').catch(() => null);
          const mine = running?.agents?.find((a) => a.id === this.chat.id);
          const waits = mine && (mine.status === 'approval' || mine.status === 'question');
          if (this.turn === turn && running && (!mine || waits)) {
            const r = await this.panel.call(`/chat/${this.chat.id}`).catch(() => null);
            if (this.turn === turn && r?.chat) this.catchUp(r.chat);
          }
        } finally {
          turn.checking = false;
        }
      }, 3000);
    }
    return done;
  }

  finishTurn(result) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.setTitle();
    clearInterval(turn.watch);
    clearInterval(this.timer);
    this.clearStatus();
    turn.resolve({ ...result, usage: turn.usage, seconds: Math.round((Date.now() - turn.started) / 1000) });
  }

  startStatus() {
    clearInterval(this.timer);
    this.status = this.t('Working…');
    this.timer = setInterval(() => this.drawStatus(), 120);
  }

  drawStatus() {
    if (!this.turn || this.inText || Date.now() - this.lastOutput < 250 || !err.isTTY) return;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.spinnerAt = (this.spinnerAt + 1) % frames.length;
    const secs = Math.round((Date.now() - this.turn.started) / 1000);
    const tokens = this.turn.usage ? this.turn.usage.input + this.turn.usage.output : 0;
    const info = [`${secs} s`, tokens ? `${formatTokens(tokens)} ${this.t('tokens')}` : null, this.t('Ctrl+C to stop')].filter(Boolean).join(' · ');
    err.write(`\r\x1b[2K${fit(`${c.magenta(frames[this.spinnerAt])} ${this.status} ${c.dim(`(${info})`)}`, (err.columns ?? 80) - 1)}`);
    this.statusShown = true;
  }

  clearStatus() {
    if (!this.statusShown) return;
    err.write('\r\x1b[2K');
    this.statusShown = false;
  }

  onEvent(e) {
    const t = this.t;
    switch (e.type) {
      case 'delta': {
        if (this.turn) this.turn.answered = true;
        if (!this.inText) {
          this.clearStatus();
          if (!this.print) out.write(`${c.bold(DOT)} `);
          this.inText = true;
        }
        // <tool> blocks of the text tool mode are not for reading
        this.answer(String(e.text ?? '').replace(/<\/?(tool|tool_call)>/g, ''));
        break;
      }
      case 'text':
        if (this.turn) this.turn.answered = true;
        if (this.inText) this.endText();
        else this.answer(`${this.print ? '' : `${c.bold(DOT)} `}${e.text}\n`);
        break;
      case 'tool':
        this.line(`${c.green(DOT)} ${c.bold(t(toolLabel(e.name)))} ${c.dim(fit(shortInput(e.name, e.input), Math.max(20, (out.columns ?? 100) - 24)))}`);
        break;
      case 'tool_result': {
        const first = String(e.text ?? '').split('\n').find((l) => l.trim()) ?? '';
        const state = e.error ? c.red(t('Error')) : c.green(e.duration ? t('Done · {0} s').replace('{0}', e.duration) : t('Done'));
        this.line(`  ${c.dim('⎿')} ${state} ${c.dim(fit(first.trim(), Math.max(20, (out.columns ?? 100) - 20)))}`);
        for (const o of e.extra?.outputs ?? []) this.line(`    ${c.blue(`${this.panel.base}${o.url}`)}`);
        if (e.extra?.edit) this.showEdit(e.extra.edit);
        break;
      }
      case 'progress':
        this.status = e.text ? t(e.text) : t('Working…');
        break;
      case 'usage':
        if (this.turn) this.turn.usage = e.run;
        break;
      case 'context':
        if (this.chat) this.chat.context = { used: e.used, size: e.size };
        break;
      case 'approval':
        this.prompted.add(e.id);
        this.endText();
        this.ask?.(e);
        break;
      case 'question':
        this.prompted.add(e.id);
        this.endText();
        this.question?.(e);
        break;
      case 'question_done':
        this.questionDone?.(e);
        break;
      case 'approval_done':
        if (e.auto) this.line(c.dim(`  ${t('Approved by the approval mode.')}`));
        break;
      case 'compact':
        this.line(c.dim(`── ${t('Conversation compacted')} ──`));
        break;
      case 'left_out':
        this.line(c.dim(`── ${t(e.text)} ──`));
        break;
      case 'undo': {
        const edit = this.edits.find((x) => x.checkpoint === e.checkpoint);
        if (edit) edit.undone = true;
        break;
      }
      case 'update':
        if (e.summary) {
          Object.assign(this.chat, e.summary);
          this.setTitle();
          this.mode = e.summary.approvalMode;
          this.model = e.summary.model;
          this.thinking = e.summary.thinking ?? this.thinking;
        }
        break;
      case 'message':
        if (e.message?.role === 'user' && !this.sentByMe.delete(e.message.content)) this.line(c.dim(`› ${e.message.content} ${t('(from another window)')}`));
        break;
      case 'error':
        this.line(c.red(`${t('Error')}: ${e.error}`));
        break;
      case 'inbox':
        // the running turn took the queued message: its "done" ends this turn too
        if (this.turn) this.turn.queued = false;
        break;
      case 'done':
        // the earlier run of this chat ended; the queued message starts the next one
        if (this.turn?.queued) {
          this.turn.queued = false;
          break;
        }
        this.endText();
        this.finishTurn({ error: e.error ?? null, stopped: !e.response && !e.error && !e.compact });
        break;
      default:
    }
  }

  /** A file edit: up to 16 diff lines (green added, red removed), the rest counted; remembered for /undo. */
  showEdit(edit) {
    if (edit.checkpoint) this.edits.push({ checkpoint: edit.checkpoint, path: edit.path, undone: Boolean(edit.undone) });
    const lines = String(edit.diff ?? '').split('\n').filter((l) => l && !l.startsWith('@@'));
    const width = Math.max(20, (out.columns ?? 100) - 8);
    for (const l of lines.slice(0, 16)) this.line(`      ${fit(l[0] === '+' ? c.green(l) : l[0] === '-' ? c.red(l) : c.dim(l), width)}`);
    if (lines.length > 16) this.line(c.dim(`      … ${lines.length - 16} ${this.t('more lines')}`));
  }

  close() {
    clearInterval(this.timer);
    this.clearStatus();
    this.stream?.close();
  }
}

/* ── Interactive chat ──────────────────────────────────────────────────── */

const COMMANDS = [
  { name: 'help', note: 'List the commands' },
  { name: 'compact', note: 'Summarize the conversation so far; earlier messages leave the context' },
  { name: 'mode', note: 'Approval mode: manual, edits or auto', args: () => MODES },
  { name: 'model', note: 'Text model of this chat', args: (s) => [['default', 'Settings › Text model'], ...s.models.map((m) => [m.name, `${m.gib} GiB`])] },
  { name: 'thinking', note: 'How much the model thinks before it answers: none, low, medium or high', args: () => THINKING },
  { name: 'undo', note: 'Undo the last file change of the agent' },
  { name: 'regenerate', note: 'Write the last answer again (the old one stays as the earlier version)' },
  { name: 'new', note: 'Start a new chat in this folder' },
  { name: 'resume', note: 'Continue an earlier chat' },
  { name: 'usage', note: 'Tokens used in this chat and how full the context is' },
  { name: 'autocompact', note: 'Compact automatically when the context fills up: on or off', args: () => [['on', 'Summarize the earlier conversation when the context fills up'], ['off', 'Only trim old tool outputs']] },
  { name: 'rules', note: 'Rules this chat follows (Settings and NEDESE.md / AGENTS.md / CLAUDE.md)' },
  { name: 'rename', note: 'Give this chat a new name' },
  { name: 'cwd', note: 'Working folder of this chat' },
  { name: 'exit', note: 'Quit' },
];

async function interactive(o, panel, t) {
  const session = new Session({ panel, t, cwd: process.cwd(), mode: o.mode, model: o.model });
  try {
    const list = await panel.call('/chat?limit=1');
    session.models = list.models ?? [];
    session.defaultModel = list.defaultModel ?? null;
    if (list.textModel === false) throw new CliError('The panel has no local text model (llm\\models); the chat cannot run.');
  } catch (e) {
    throw e instanceof CliError ? e : new CliError(e.message);
  }
  if (o.cont || o.resume !== null) {
    const chat = await pickChat(panel, t, o.cont ? 'continue' : o.resume, session);
    if (chat) {
      await session.open(chat);
      await showHistory(panel, t, chat.id, session);
    }
  }

  const rl = readline.createInterface({ input: inp, output: out, terminal: true, historySize: 200, prompt: `${c.cyan('›')} ` });
  const header = [c.bold('Nedese Studio'), c.dim(session.cwd), c.dim(`${t('mode')}: ${session.mode ?? 'edits'}`), session.chat ? c.dim(`${t('chat')} ${session.chat.id}`) : null].filter(Boolean).join(c.dim(' · '));
  out.write(`${header}\n${c.dim(t('Type a message; "/" lists the commands. Ctrl+C stops an answer; twice on an empty line quits.'))}\n\n`);

  let busy = false;
  let approval = null;
  let question = null; // ask_user: the next line (or an option number) is the answer
  let lastCtrlC = 0;
  let pendingLines = [];
  const menu = { items: [], index: 0, shown: 0, down: 0 };

  /* Slash command menu below the input line: drawn with relative cursor moves (space reserved first). */
  const suggestions = (value) => {
    const m = /^\/(\S*)(?:\s+(\S*))?$/.exec(value);
    if (!m) return [];
    if (m[2] === undefined) return COMMANDS.filter((x) => x.name.startsWith(m[1].toLowerCase())).map((x) => ({ value: `/${x.name}`, label: `/${x.name}`, note: t(x.note), more: Boolean(x.args) }));
    const cmd = COMMANDS.find((x) => x.name === m[1].toLowerCase());
    if (!cmd?.args) return [];
    return cmd.args(session).filter(([v]) => v.toLowerCase().startsWith(m[2].toLowerCase())).map(([v, d]) => ({ value: `/${cmd.name} ${v}`, label: v, note: t(d), more: false }));
  };
  const clearMenu = () => {
    if (!menu.shown) return;
    const { cols } = rl.getCursorPos();
    out.write(`\x1b[${menu.down}B\r\x1b[0J\x1b[${menu.down}A\x1b[${cols + 1}G`);
    menu.shown = 0;
  };
  const drawMenu = () => {
    clearMenu();
    menu.items = busy ? [] : suggestions(rl.line);
    menu.index = Math.min(menu.index, Math.max(0, menu.items.length - 1));
    if (!menu.items.length) return;
    const width = out.columns ?? 80;
    const labelWidth = Math.max(...menu.items.map((s) => s.label.length)) + 2;
    // At most 16 rows, all the commands (fewer on a short terminal); with more the window follows the highlighted one
    const rows = Math.max(5, Math.min(16, (out.rows ?? 24) - 6));
    const start = Math.max(0, Math.min(menu.index - rows + 1, menu.items.length - rows));
    const lines = menu.items.slice(start, start + rows).map((s, k) => {
      const i = start + k;
      return fit(`${i === menu.index ? c.inverse(` ${s.label.padEnd(labelWidth)}`) : ` ${c.bold(s.label.padEnd(labelWidth))}`} ${c.dim(s.note)}`, width - 1);
    });
    const pos = rl.getCursorPos();
    const promptWidth = 2;
    const inputRows = Math.floor((promptWidth + rl.line.length) / width);
    const down = inputRows - pos.rows + 1;
    const reserve = down + lines.length - 1;
    let s = `${'\n'.repeat(reserve)}\x1b[${reserve}A`;
    s += `\x1b[${down}B`;
    lines.forEach((l, i) => {
      s += `\r\x1b[2K${l}`;
      if (i < lines.length - 1) s += '\x1b[1B';
    });
    s += `\x1b[${down + lines.length - 1}A\x1b[${pos.cols + 1}G`;
    out.write(s);
    menu.shown = lines.length;
    menu.down = down;
  };
  const pick = (run) => {
    const s = menu.items[menu.index];
    if (!s) return false;
    clearMenu();
    rl.line = s.more ? `${s.value} ` : s.value;
    rl.cursor = rl.line.length;
    rl._refreshLine();
    menu.index = 0;
    if (run && !s.more) {
      clearMenu();
      rl.write('\r');
      return true;
    }
    drawMenu();
    return true;
  };

  // Approval: y / n / a (approve and switch to Automatic) / l (always allow calls like this in this chat, when the call
  // can be allowed for good: the rules it would keep are named), asked in the terminal
  const ruleText = (r) => (r.program ? `${r.tool === 'run_ssh' ? 'ssh ' : ''}${r.program}` : r.method ? `${r.method} ${r.path}` : r.tool);
  session.ask = (e) => {
    approval = e;
    const risky = e.risk === 'danger';
    session.line(`${c.yellow('⚠')} ${c.bold(t('Approval needed'))}: ${t(toolLabel(e.tool))} ${c.dim(fit(shortInput(e.tool, e.input), (out.columns ?? 100) - 30))}`);
    const detail = JSON.stringify(e.input ?? {}, null, 1).split('\n').slice(0, 12).map((l) => `    ${c.dim(fit(l, (out.columns ?? 100) - 6))}`).join('\n');
    session.line(detail);
    const always = e.allow?.length ? `   ${c.bold('[l]')} ${t('always allow in this chat')}: ${e.allow.map(ruleText).join(', ')}` : '';
    session.line(`    ${risky ? c.red(t('This may not be reversible.')) : ''} ${c.bold('[y]')} ${t('yes')}   ${c.bold('[n]')} ${t('no')}   ${c.bold('[a]')} ${t('yes, and switch to Automatic')}${always}`);
  };
  const answerApproval = async (key) => {
    const a = approval;
    approval = null;
    try {
      if (key === 'a') await panel.call(`/chat/${session.chat.id}`, { method: 'PATCH', body: { approvalMode: 'auto' } });
      else await panel.call(`/chat/${session.chat.id}/approval`, { method: 'POST', body: { id: a.id, yes: key !== 'n', always: key === 'l' } });
      session.line(c.dim(`  ${key === 'n' ? t('Rejected.') : key === 'l' ? t('Approved; calls like this run without asking in this chat from now on.') : t('Approved.')}`));
    } catch (e) {
      session.line(c.red(e.message));
    }
  };

  // ask_user: the question and its options; the answer is typed (a number picks an option)
  session.question = (e) => {
    question = e;
    session.line(`${c.cyan('?')} ${c.bold(e.question)}`);
    (e.options ?? []).forEach((o, i) => session.line(`    ${c.bold(String(i + 1))}. ${o}`));
    rl.setPrompt(`${c.cyan('?')} `);
    rl.prompt();
  };
  session.questionDone = () => {
    question = null;
    rl.setPrompt('');
  };
  const answerQuestion = async (line) => {
    const q = question;
    const pick = /^\d+$/.test(line.trim()) ? q.options?.[Number(line.trim()) - 1] : null;
    const text = pick ?? line.trim();
    if (!text) return;
    try {
      await panel.call(`/chat/${session.chat.id}/answer`, { method: 'POST', body: { id: q.id, answer: text } });
    } catch (e) {
      session.line(c.red(e.message));
    }
  };

  const original = rl._ttyWrite.bind(rl);
  rl._ttyWrite = (s, key = {}) => {
    if (key.ctrl && key.name === 'c') {
      clearMenu();
      if (busy) {
        session.line(c.dim(t('Stopping…')));
        panel.call(`/chat/${session.chat.id}/stop`, { method: 'POST' }).catch((e) => session.finishTurn({ error: `${t('The panel does not answer')}: ${e.message}` }));
        return;
      }
      if (rl.line) {
        rl.line = '';
        rl.cursor = 0;
        rl._refreshLine();
        return;
      }
      if (Date.now() - lastCtrlC < 1500) {
        rl.close();
        return;
      }
      lastCtrlC = Date.now();
      out.write(`\n${c.dim(t('Press Ctrl+C again to quit.'))}\n`);
      rl.prompt();
      return;
    }
    if (busy) {
      if (question) {
        original(s, key); // the answer to the agent's question is typed on the prompt line
        return;
      }
      const pressed = String(s).toLowerCase();
      if (approval && (['y', 'n', 'a'].includes(pressed) || (pressed === 'l' && approval.allow?.length))) answerApproval(pressed);
      return; // typing waits until the answer is done
    }
    if (menu.items.length && menu.shown) {
      if (key.name === 'up' || key.name === 'down') {
        menu.index = (menu.index + (key.name === 'down' ? 1 : -1) + menu.items.length) % menu.items.length;
        drawMenu();
        return;
      }
      if (key.name === 'tab') {
        pick(false);
        return;
      }
      if (key.name === 'return' && rl.line.trim() !== menu.items[menu.index]?.value) {
        pick(true);
        return;
      }
      if (key.name === 'escape') {
        clearMenu();
        menu.items = [];
        return;
      }
    }
    if (key.name === 'return') clearMenu();
    original(s, key);
    if (key.name !== 'return') drawMenu();
  };

  const run = async (text, options = {}) => {
    busy = true;
    rl.setPrompt('');
    const r = await session.send(text, options);
    busy = false;
    approval = null;
    const tokens = r.usage ? r.usage.input + r.usage.output : 0;
    if (r.error) session.line(c.red(`${t('Error')}: ${r.error}`));
    else if (r.stopped) session.line(c.dim(t('(stopped)')));
    session.line(c.dim(`${[tokens ? `${formatTokens(tokens)} ${t('tokens')}` : null, `${r.seconds} s`].filter(Boolean).join(' · ')}\n`));
    rl.setPrompt(`${c.cyan('›')} `);
    rl.prompt();
  };

  const command = async (text) => {
    const [, name, arg = ''] = /^\/(\w+)(?:\s+(.*))?$/.exec(text) ?? [];
    const value = arg.trim();
    if (!name) return false;
    if (name === 'exit' || name === 'quit') rl.close();
    else if (name === 'help') for (const x of COMMANDS) session.line(`  ${c.bold(`/${x.name}`.padEnd(10))} ${c.dim(t(x.note))}`);
    else if (name === 'cwd') session.line(`  ${session.chat?.cwd ?? session.cwd}`);
    else if (name === 'rename') {
      if (!session.chat) session.line(c.dim(`  ${t('The chat gets a name with its first message.')}`));
      else if (!value) session.line(`  ${t('Name')}: ${c.bold(session.chat.title || t('New chat'))}  ${c.dim('/rename <name>')}`);
      else {
        const r = await panel.call(`/chat/${session.chat.id}`, { method: 'PATCH', body: { title: value } }).catch((e) => session.line(c.red(e.message)));
        if (r?.chat) session.chat.title = r.chat.title;
        session.setTitle();
        session.line(c.dim(`  ${t('Name')}: ${value}`));
      }
    }
    else if (name === 'rules') {
      const global = await panel.call('/chat/rules').catch(() => null);
      const active = session.chat ? (await panel.call(`/chat/${session.chat.id}`)).chat.rules ?? [] : [];
      if (active.length) for (const r of active) session.line(`  ${c.bold(t(r.source))}  ${c.dim(r.path)}`);
      else session.line(c.dim(`  ${t('No rules yet (they are read when the chat starts).')}`));
      if (global) session.line(c.dim(`  ${t('Rules for every chat')}: ${global.path} · ${t('project rules')}: ${global.projectFiles.join(', ')}`));
    }
    else if (name === 'usage') {
      const u = session.chat?.usage;
      const ctx = session.chat?.context;
      session.line(u ? `  ${formatTokens(u.input + u.output)} ${t('tokens')} (${u.input} ${t('input')}, ${u.output} ${t('output')})` : c.dim(`  ${t('No tokens used yet.')}`));
      if (ctx?.size) session.line(`  ${t('Context')}: ${Math.round((ctx.used / ctx.size) * 100)}% · ${formatTokens(ctx.used)} / ${formatTokens(ctx.size)} · ${t('auto compact')} ${session.chat?.autoCompact === false ? 'off' : 'on'}`);
    } else if (name === 'undo') {
      const edit = [...session.edits].reverse().find((x) => !x.undone);
      if (!edit || !session.chat) session.line(c.dim(`  ${t('No file change to undo.')}`));
      else {
        const undo = (force) => panel.call(`/chat/${session.chat.id}/undo`, { method: 'POST', body: { checkpoint: edit.checkpoint, force } });
        try {
          session.line(c.dim(`  ${(await undo(false)).message}`));
          edit.undone = true;
        } catch (e) {
          if (!/changed after this edit|sonra değişti/.test(e.message)) session.line(c.red(`  ${e.message}`));
          else {
            const answer = await new Promise((ok) => rl.question(`  ${t('The file changed after this edit; undo anyway and lose the later changes?')} [y/N] `, ok));
            if (/^y/i.test(answer)) {
              session.line(c.dim(`  ${(await undo(true).catch((x) => ({ message: x.message }))).message}`));
              edit.undone = true;
            }
          }
        }
      }
    } else if (name === 'autocompact') {
      if (!['on', 'off'].includes(value)) session.line(`  ${t('auto compact')}: ${session.chat?.autoCompact === false ? 'off' : 'on'}  ${c.dim('/autocompact on | off')}`);
      else if (!session.chat) session.line(c.dim(`  ${t('It applies once the chat has started.')}`));
      else {
        const r = await panel.call(`/chat/${session.chat.id}`, { method: 'PATCH', body: { autoCompact: value === 'on' } }).catch((e) => session.line(c.red(e.message)));
        if (r?.chat) session.chat.autoCompact = r.chat.autoCompact;
        session.line(c.dim(`  ${t('auto compact')}: ${value}`));
      }
    } else if (name === 'regenerate') {
      if (!session.chat) session.line(c.dim(`  ${t('There is no answer to write again yet.')}`));
      else await run('', { regenerate: true });
    } else if (name === 'new') {
      session.stream?.close();
      session.chat = null;
      session.line(c.dim(`  ${t('New chat; it opens with the next message.')}`));
    } else if (name === 'resume') {
      rl.pause();
      const chat = await pickChat(panel, t, '', session, rl);
      rl.resume();
      if (chat) {
        await session.open(chat);
        await showHistory(panel, t, chat.id, session);
      }
    } else if (name === 'compact') {
      if (!session.chat) session.line(c.dim(`  ${t('Nothing to compact yet.')}`));
      else {
        busy = true;
        try {
          const r = await panel.call(`/chat/${session.chat.id}/compact`, { method: 'POST' });
          session.line(c.dim(`  ${r.message}`));
        } catch (e) {
          session.line(c.red(`  ${e.message}`));
        }
        busy = false;
      }
    } else if (name === 'mode') {
      if (!MODES.some(([m]) => m === value)) session.line(`  ${t('mode')}: ${c.bold(session.mode ?? 'edits')}  ${c.dim('/mode manual | edits | auto')}`);
      else {
        session.mode = value;
        if (session.chat) await panel.call(`/chat/${session.chat.id}`, { method: 'PATCH', body: { approvalMode: value } }).catch((e) => session.line(c.red(e.message)));
        session.line(c.dim(`  ${t('mode')}: ${value}`));
      }
    } else if (name === 'thinking') {
      if (!THINKING.some(([v]) => v === value)) session.line(`  ${t('thinking')}: ${c.bold(session.thinking ?? 'low')}  ${c.dim('/thinking none | low | medium | high')}`);
      else {
        session.thinking = value;
        if (session.chat) await panel.call(`/chat/${session.chat.id}`, { method: 'PATCH', body: { thinking: value } }).catch((e) => session.line(c.red(e.message)));
        session.line(c.dim(`  ${t('thinking')}: ${value}`));
      }
    } else if (name === 'model') {
      const found = value === 'default' ? { file: '', name: 'default' } : session.models.find((m) => m.name === value || m.file === value);
      if (!found) {
        session.line(`  ${t('Text model')}: ${c.bold(session.model ?? `default (${session.defaultModel ?? '?'})`)}`);
        for (const m of session.models) session.line(c.dim(`    ${m.name}  ${m.gib} GiB${m.image ? ' · reads images' : ''}`));
      } else {
        session.model = found.file || null;
        if (session.chat) await panel.call(`/chat/${session.chat.id}`, { method: 'PATCH', body: { model: found.file } }).catch((e) => session.line(c.red(e.message)));
        session.line(c.dim(`  ${t('Text model')}: ${found.name}`));
      }
    } else {
      session.line(c.yellow(`  ${t('Unknown command: {0}').replace('{0}', `/${name}`)}`));
    }
    return true;
  };

  // A line ending with "\" continues; lines pasted together arrive within a few ms and are sent as one message
  let pasteTimer = null;
  rl.on('line', (line) => {
    if (busy) {
      if (question) answerQuestion(line);
      // like the web chat: a message while it works waits for the assistant's next step (it was dropped silently)
      else if (line.trim() && session.chat && !line.trim().startsWith('/')) {
        session.sentByMe.add(line.trim());
        panel.call(`/chat/${session.chat.id}/message`, { method: 'POST', body: { text: line.trim() } }).then(() => session.line(c.dim(`  ${t('Queued: the assistant reads it at its next step')}`)), (e) => session.line(c.red(e.message)));
      } else if (line.trim().startsWith('/')) session.line(c.dim(`  ${t('Commands wait until the answer is done (Ctrl+C stops it).')}`));
      return;
    }
    if (line.endsWith('\\')) {
      pendingLines.push(line.slice(0, -1));
      rl.setPrompt(c.dim('… '));
      rl.prompt();
      return;
    }
    pendingLines.push(line);
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(async () => {
      const text = pendingLines.join('\n').trim();
      pendingLines = [];
      rl.setPrompt(`${c.cyan('›')} `);
      if (!text) {
        rl.prompt();
        return;
      }
      if (text.startsWith('/') && !text.includes('\n') && (await command(text))) {
        if (!rl.closed) rl.prompt();
        return;
      }
      await run(text);
    }, 25);
  });
  out.on('resize', () => drawMenu());

  if (o.words.length) {
    const first = o.words.join(' ');
    out.write(`${c.cyan('›')} ${first}\n`);
    await run(first);
  } else rl.prompt();

  await new Promise((ok) => rl.on('close', ok));
  session.close();
  out.write('\n');
}

/** Chat to continue: "continue" = the latest of this folder; an id; '' = pick from a list. */
async function pickChat(panel, t, which, session, rl = null) {
  const list = (await panel.call('/chat?limit=50')).chats.filter((x) => !x.parent);
  const here = resolve(session.cwd).toLowerCase();
  if (which === 'continue') {
    const chat = list.find((x) => x.cwd && resolve(x.cwd).toLowerCase() === here);
    if (!chat) out.write(c.dim(`${t('No earlier chat in this folder; a new one starts.')}\n`));
    return chat ?? null;
  }
  if (which) {
    try {
      return (await panel.call(`/chat/${encodeURIComponent(which)}`)).chat;
    } catch {
      throw new CliError(t('Chat not found.'));
    }
  }
  const shown = list.slice(0, 15);
  if (!shown.length) {
    out.write(c.dim(`${t('No chats yet.')}\n`));
    return null;
  }
  shown.forEach((x, i) => out.write(`  ${c.bold(String(i + 1).padStart(2))}  ${fit(x.title || t('New chat'), 50).padEnd(50)} ${c.dim(`${new Date(x.update).toLocaleString()}  ${x.cwd ?? ''}`)}\n`));
  const ask = rl ?? readline.createInterface({ input: inp, output: out });
  const answer = await new Promise((ok) => ask.question(`${t('Number')}: `, ok));
  if (!rl) ask.close();
  const chosen = shown[Number(answer) - 1];
  return chosen ? (await panel.call(`/chat/${chosen.id}`)).chat : null;
}

async function showHistory(panel, t, id, session) {
  const d = (await panel.call(`/chat/${encodeURIComponent(id)}`)).chat;
  const recent = d.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).slice(-6);
  if (!recent.length) return;
  out.write(c.dim(`── ${t('Earlier in this chat')} ──\n`));
  for (const m of recent.filter((x) => !x.hidden)) out.write(m.role === 'user' ? `${c.cyan('›')} ${m.content}\n` : `${c.bold(DOT)} ${m.content}\n`);
  out.write(c.dim('──\n\n'));
  session.chat = d;
}

/* ── Print mode: one answer to stdout ──────────────────────────────────── */

async function printMode(o, panel, t) {
  let text = o.words.join(' ');
  if (!text && !inp.isTTY) {
    const parts = [];
    for await (const p of inp) parts.push(p);
    text = Buffer.concat(parts).toString('utf8').trim();
  }
  if (!text) throw new CliError('nedese -p needs a question (or text on stdin).');
  const session = new Session({ panel, t, cwd: process.cwd(), mode: o.mode, model: o.model, print: true });
  session.ask = async (e) => {
    // No terminal to ask in: rejected (use --mode auto to let it run)
    if (!inp.isTTY) {
      err.write(c.yellow(`${t('Approval needed')}: ${e.tool} — ${t('rejected (no terminal to ask; use --mode auto)')}\n`));
      await panel.call(`/chat/${session.chat.id}/approval`, { method: 'POST', body: { id: e.id, yes: false } }).catch(() => {});
      return;
    }
    const rl = readline.createInterface({ input: inp, output: err });
    const a = await new Promise((ok) => rl.question(`${t('Approval needed')}: ${t(toolLabel(e.tool))} ${shortInput(e.tool, e.input)} [y/n] `, ok));
    rl.close();
    await panel.call(`/chat/${session.chat.id}/approval`, { method: 'POST', body: { id: e.id, yes: /^y/i.test(a) } }).catch(() => {});
  };
  if (o.cont || o.resume) {
    const chat = await pickChat(panel, t, o.cont ? 'continue' : o.resume, session);
    if (chat) await session.open(chat);
  }
  process.on('SIGINT', () => {
    if (!session.chat) process.exit(130);
    panel.call(`/chat/${session.chat.id}/stop`, { method: 'POST' }).catch(() => process.exit(130));
  });
  const r = await session.send(text);
  session.close();
  if (r.error) {
    err.write(c.red(`${t('Error')}: ${r.error}\n`));
    process.exitCode = 1;
  }
}

/* ── Main ──────────────────────────────────────────────────────────────── */

const HELP = `Nedese Studio CLI: chat with the panel's agent in this folder (files, commands, code, web, panel jobs).

  nedese                          interactive chat in this folder
  nedese "message"                starts with this message
  nedese -p "question"            print the answer and exit (stdin when no question)
  nedese -c                       continue the last chat of this folder
  nedese -r [id]                  resume a chat (a list without id)

  --mode manual|edits|auto        approval mode (default edits)
  --model <file>                  text model (llm\\models file)
  --lang en|tr                    language (NEDESE_LANG)
  --url <http://host:1071>        another computer's panel (NEDESE_URL), with --key (NEDESE_KEY)
  --no-color                      plain output (NO_COLOR)

In the chat "/" lists the commands. Ctrl+C stops the answer; twice on an empty line quits.`;

export async function main(argv = process.argv.slice(2)) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 2;
  }
  useColor = o.color && Boolean(out.isTTY);
  const lang = o.lang === 'tr' ? 'tr' : 'en';
  const t = lang === 'tr' ? translator(loadDictionary()) : (s) => s;
  if (o.help) {
    out.write(`${HELP}\n`);
    return 0;
  }
  const panel = new Panel({ url: o.url, key: o.key, lang });
  const titleBefore = process.title;
  try {
    if (o.print || !inp.isTTY) await printMode({ ...o, print: true }, panel, t);
    else await interactive(o, panel, t);
  } catch (e) {
    err.write(`${c.red(e instanceof CliError ? t(e.message) : e.stack ?? e.message)}\n`);
    return 1;
  } finally {
    // the window gets its own title back
    if (process.title !== titleBefore) process.title = titleBefore;
  }
  return process.exitCode ?? 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
