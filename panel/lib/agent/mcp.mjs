/**
 * MCP client (Model Context Protocol): the agent uses the tools of the MCP servers the panel knows (user request
 * 08.10.2026: "it should be able to use the existing MCP servers and skills").
 *
 * Server sources, all inside the project (user request 09.10.2026: Claude's plugins and MCP servers are downloaded into
 * the panel's own folders, ~/.claude is not read); the first one with a name wins: panel-data\mcp.json, <ai>\.mcp.json,
 * the plugins in panel-data\plugins (plugins.mjs). The format is Claude Code's: { mcpServers: { name: { command, args,
 * env } | { type: 'http', url, headers } } }.
 *
 * A server starts when it is first used (most need another program such as Blender; starting them all with the panel
 * would be slow and useless). stdio: JSON-RPC 2.0 line by line; http: "streamable HTTP" (JSON or SSE answer); sse: the older
 * HTTP+SSE transport (GET event stream + POST address), also used when an http server refuses the POST.
 * ${VAR} / ${VAR:-default} in a definition come from the environment (expandVariables).
 *
 * Time limits per server (user request 08.10.2026: Blender's generate_3d takes 1-3 minutes and the one fixed 60 s
 * limit cut it off): "timeout" for tool calls (default 10 min) and "initTimeout" for the start (default 60 s), in ms
 * (a value under 1000 is read as seconds). A tool call asks for progress notifications; each one restarts the wait.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { killTree } from '../process.mjs';
import { DATA_FILES } from '../data-files.mjs';
import { pluginFolders, pluginMcpServers } from './plugins.mjs';

const VERSION = '2025-06-18';
const CLIENT = { name: 'nedese-studio-ajan', version: '1.0.0' };
export const MCP_INIT_TIMEOUT_MS = 60000;
export const MCP_TOOL_TIMEOUT_MS = 10 * 60000;
// tools/list and other short requests: a server that does not list its tools in a minute is not working
const MCP_REQUEST_TIMEOUT_MS = 60000;

/**
 * MCP tools as the model's own functions (user request 08.10.2026): once a chat loads a server, each of its tools goes
 * to the model as "mcp__<server>__<tool>" with its own input schema, at most this many per server (the rest stay
 * reachable with call_mcp); a tool whose schema is larger than MCP_SCHEMA_LIMIT characters stays with call_mcp too.
 */
export const MCP_NATIVE_LIMIT = 40;
export const MCP_SCHEMA_LIMIT = 6000;
const MCP_DESCRIPTION_LIMIT = 1000;

/** Function name of an MCP tool: letters, digits, _ and - only, at most 64 characters (OpenAI function names). */
export function mcpFunctionName(server, tool) {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (name.length <= 64) return name;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${name.slice(0, 56)}_${h.toString(36).slice(0, 7)}`;
}

/** An MCP input schema as a function's parameters: always an object with properties ($schema left out). */
export function functionSchema(schema) {
  const s = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
  const { $schema: _version, required, properties, ...rest } = s;
  return { ...rest, type: 'object', properties: properties && typeof properties === 'object' && !Array.isArray(properties) ? properties : {}, ...(Array.isArray(required) && required.length ? { required } : {}) };
}

/**
 * The tools of a server that go to the model as functions ({ name, server, tool, description, params, annotations })
 * and the ones that stay with call_mcp (over the limits).
 */
export function nativeMcpTools(server, list = []) {
  const native = [];
  const rest = [];
  for (const t of list) {
    const params = functionSchema(t.inputSchema);
    if (native.length >= MCP_NATIVE_LIMIT || JSON.stringify(params).length > MCP_SCHEMA_LIMIT) {
      rest.push(t);
      continue;
    }
    const description = String(t.description ?? '').replace(/\s+/g, ' ').trim();
    native.push({ name: mcpFunctionName(server, t.name), server, tool: t.name, description: `${description.slice(0, MCP_DESCRIPTION_LIMIT) || `Tool ${t.name}`} (MCP server ${server})`, params, annotations: t.annotations ?? null });
  }
  return { native, rest };
}

/** A time limit from mcp.json: ms, or seconds when under 1000 (nobody means a sub-second limit); null if not set. */
export function timeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n < 1000 ? n * 1000 : n);
}

/**
 * Reads a server-sent event stream (fetch body): onEvent({ event, data }) for every event, in order; an onEvent that
 * returns true ends the reading (the answer that was waited for came).
 */
export async function readEvents(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? onEvent({ event, data: data.join('\n') }) : false;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (flush(block)) return true;
    }
  }
  return buffer.trim() ? Boolean(flush(buffer)) : false;
}

function jsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * ${VAR} and ${VAR:-default} come from the environment, as in Claude Code's .mcp.json (user request 08.10.2026: a key
 * stays out of the file that is shared); ${CLAUDE_PLUGIN_ROOT} is the plugin's folder. A variable that is not set and
 * has no default becomes '' and its name goes into missing (the server says so when it is started).
 */
export function expandVariables(value, { env = process.env, root = null, missing = null } = {}) {
  return String(value ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    if (name === 'CLAUDE_PLUGIN_ROOT' && root) return root;
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    missing?.add(name);
    return '';
  });
}

function translateDefinition(name, t, source, root = null, env = process.env) {
  if (!t || typeof t !== 'object' || t.disabled) return null;
  const missing = new Set();
  // in command, args, env, url and headers (the places Claude Code expands)
  const place = (s) => expandVariables(s, { env, root, missing });
  const strings = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [k, place(v)]));
  const limits = Object.fromEntries([['timeout', timeoutMs(t.timeout)], ['initTimeout', timeoutMs(t.initTimeout)]].filter(([, v]) => v));
  let c = null;
  // "sse": the older HTTP+SSE transport; "http" (or a url alone): streamable HTTP, which falls back to SSE by itself
  if (t.url || t.type === 'http' || t.type === 'sse') c = { name, type: t.type === 'sse' ? 'sse' : 'http', url: place(t.url), headers: strings(t.headers), ...limits, source };
  else if (t.command) c = { name, type: 'stdio', command: place(t.command), args: (Array.isArray(t.args) ? t.args : []).map(place), env: strings(t.env), cwd: root ?? undefined, ...limits, source };
  if (c && missing.size) c.missing = [...missing];
  return c;
}

/**
 * Every server definition as written, first source wins: [{ name, source, root, raw }]. panel-data\mcp.json comes
 * first, then the project's .mcp.json, then the installed plugins (root: the plugin's folder, ${CLAUDE_PLUGIN_ROOT}).
 */
function definitionsBySource({ aiRoot, dataRoot }) {
  const out = new Map();
  const add = (servers, source, root = null) => {
    for (const [name, raw] of Object.entries(servers ?? {})) {
      const clean = name.replace(/[^\w-]/g, '_');
      if (!out.has(clean) && raw && typeof raw === 'object') out.set(clean, { name: clean, source, root, raw });
    }
  };
  add(jsonFile(join(dataRoot, DATA_FILES.mcp))?.mcpServers, 'panel');
  add(jsonFile(join(aiRoot, '.mcp.json'))?.mcpServers, 'project');
  for (const e of pluginFolders(dataRoot)) add(pluginMcpServers(e.path), `plugin:${e.name}`, e.path);
  return [...out.values()];
}

/**
 * The panel's own settings for servers it does not define (Settings › Assistant, user request 08.10.2026): in
 * panel-data\mcp.json "overrides": { name: { disabled, timeout } }; the other files stay untouched.
 */
function overrides(dataRoot) {
  const o = jsonFile(join(dataRoot, DATA_FILES.mcp))?.overrides;
  return o && typeof o === 'object' ? o : {};
}

/** Bilinen MCP sunuculari: { ad: tanim }. env: where ${VAR} values come from (tests: an object). */
export function mcpServers({ aiRoot, dataRoot, env = process.env }) {
  const result = {};
  const own = overrides(dataRoot);
  for (const d of definitionsBySource({ aiRoot, dataRoot })) {
    const o = own[d.name] ?? {};
    if (o.disabled) continue;
    const c = translateDefinition(d.name, o.timeout ? { ...d.raw, timeout: o.timeout } : d.raw, d.source, d.root, env);
    if (c) result[d.name] = c;
  }
  return result;
}

/**
 * Every known server for the management list, the disabled ones too: { name, source, type, target (command and
 * arguments or address), timeoutSec, disabled, editable (defined by the panel), missing (environment variables) }.
 */
export function mcpServerList({ aiRoot, dataRoot, env = process.env }) {
  const own = overrides(dataRoot);
  return definitionsBySource({ aiRoot, dataRoot }).map((d) => {
    const o = own[d.name] ?? {};
    const c = translateDefinition(d.name, { ...d.raw, disabled: false }, d.source, d.root, env);
    const limit = timeoutMs(o.timeout ?? d.raw.timeout);
    return {
      name: d.name,
      source: d.source,
      type: c?.type ?? null,
      target: c ? (c.type === 'stdio' ? [d.raw.command, ...(Array.isArray(d.raw.args) ? d.raw.args : [])].join(' ') : String(d.raw.url ?? '')) : '',
      timeoutSec: limit ? Math.round(limit / 1000) : null,
      disabled: Boolean(d.raw.disabled || o.disabled),
      editable: d.source === 'panel',
      missing: c?.missing ?? [],
    };
  });
}

/** Answer to a request of the server (ping, roots/list): empty. */
const serverRequestAnswer = (method) => (method === 'roots/list' ? { roots: [] } : {});

/** "40%" or "step 2 of 5 (40%)": a progress notification for the chat's running tool card. */
export function progressText(p = {}) {
  const percent = Number(p.total) > 0 ? `${Math.round((Number(p.progress) / Number(p.total)) * 100)}%` : null;
  const text = String(p.message ?? '').trim();
  return text ? `${text}${percent ? ` (${percent})` : ''}` : percent ?? (p.progress !== undefined ? String(p.progress) : '');
}

/** Windows: .exe disindaki komutlar (dart.bat, npx.cmd, uvx) kabukla calisir; bosluklu argumanlar tirnaklanir. */
function shellArg(s) {
  return /[\s"&|<>^]/.test(s) ? `"${String(s).replaceAll('"', '\\"')}"` : s;
}

export class McpClient {
  constructor(definition, { timeTimeoutMs = null, log = () => {} } = {}) {
    this.definition = definition;
    // timeTimeoutMs: one limit for every request (tests); otherwise the server's own limits or the defaults
    this.limits = {
      init: timeTimeoutMs ?? definition.initTimeout ?? MCP_INIT_TIMEOUT_MS,
      tool: timeTimeoutMs ?? definition.timeout ?? MCP_TOOL_TIMEOUT_MS,
      other: timeTimeoutMs ?? Math.min(definition.timeout ?? MCP_REQUEST_TIMEOUT_MS, MCP_REQUEST_TIMEOUT_MS),
    };
    this.log = log;
    // stdio, http (streamable) or sse (the older HTTP+SSE); an http server that refuses the POST turns out to be sse
    this.transport = definition.type;
    this.counter = 0;
    this.pending = new Map();
    this.proc = null;
    this.session = null;
    this.sseControl = null;
    this.postUrl = null;
    this.ready = null;
    this.tools = null;
    this.errorText = '';
    this.instruction = '';
  }

  start() {
    this.ready ??= (async () => {
      const t = this.definition;
      if (t.missing?.length) throw new Error(`MCP server "${t.name}": environment variable${t.missing.length > 1 ? 's' : ''} ${t.missing.join(', ')} ${t.missing.length > 1 ? 'are' : 'is'} not set (used as \${…} in its definition, ${t.source ?? 'mcp.json'}). Set it for the panel (a system environment variable, then restart the panel) or write the value into the definition.`);
      if (this.transport === 'stdio') this.stdioAc();
      if (this.transport === 'sse') await this.sseConnect();
      const hello = { protocolVersion: VERSION, capabilities: {}, clientInfo: CLIENT };
      let r;
      try {
        r = await this.req('initialize', hello);
      } catch (e) {
        // MCP backwards compatibility: a server of the older HTTP+SSE transport refuses the POST (400/404/405); its
        // event stream opens with a GET to the same address
        if (this.transport !== 'http' || ![400, 404, 405].includes(e.status)) throw e;
        this.transport = 'sse';
        await this.sseConnect();
        r = await this.req('initialize', hello);
      }
      this.serverInfo = r?.serverInfo ?? null;
      this.instruction = String(r?.instructions ?? '');
      await this.notify('notifications/initialized');
    })().catch((e) => {
      this.ready = null;
      this.close();
      throw e;
    });
    return this.ready;
  }

  stdioAc() {
    const t = this.definition;
    const exe = /\.exe$/i.test(t.command) && existsSync(t.command);
    const shell = process.platform === 'win32' && !exe;
    const command = shell ? [t.command, ...t.args].map(shellArg).join(' ') : t.command;
    const s = spawn(command, shell ? [] : t.args, { cwd: t.cwd, env: { ...process.env, ...t.env }, shell: shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = s;
    let buffer = '';
    s.stdout.setEncoding('utf8');
    s.stdout.on('data', (p) => {
      buffer += p;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) this.getMessage(line);
      }
    });
    s.stderr.setEncoding('utf8');
    s.stderr.on('data', (p) => {
      this.errorText = (this.errorText + p).slice(-2000);
    });
    const done = (reason) => {
      if (this.proc !== s) return;
      this.proc = null;
      this.ready = null;
      for (const [, b] of this.pending) b.red(new Error(`MCP server "${t.name}" closed (${reason}). ${this.errorText.trim().slice(-400)}`));
      this.pending.clear();
    };
    s.on('error', (e) => done(e.message));
    s.on('exit', (code) => done(`exit ${code}`));
  }

  /**
   * The older HTTP+SSE transport (servers before MCP 2025-03-26; "type": "sse" in .mcp.json): a GET opens the event
   * stream, its first event ("endpoint") names the address messages are POSTed to, and every answer, progress report
   * and request of the server comes back over the stream (handled like stdio lines). Resolves once the address is known.
   */
  sseConnect() {
    const t = this.definition;
    const control = new AbortController();
    this.sseControl?.abort();
    this.sseControl = control;
    this.postUrl = null;
    return new Promise((ok, red) => {
      const timer = setTimeout(() => {
        red(new Error(`MCP ${t.name}: no "endpoint" event from ${t.url} within ${Math.round(this.limits.init / 1000)} s (is it an MCP SSE address?)`));
        control.abort();
      }, this.limits.init);
      (async () => {
        const r = await fetch(t.url, { headers: { Accept: 'text/event-stream', ...t.headers }, signal: control.signal });
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('text/event-stream')) {
          await r.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${r.status}, ${r.headers.get('content-type') ?? 'no content type'}`);
        }
        await readEvents(r.body, (e) => {
          if (e.event === 'endpoint') {
            const u = new URL(e.data.trim(), t.url);
            // the server's headers (often a key) go only to the server's own site
            if (u.origin !== new URL(t.url).origin) throw new Error(`the message address is on another site (${u.origin}); not followed`);
            this.postUrl = u.href;
            clearTimeout(timer);
            ok();
          } else if (e.event === 'message') {
            let m = null;
            try {
              m = JSON.parse(e.data);
            } catch {
              return false; // not JSON-RPC: skipped like a log line on stdio
            }
            for (const x of Array.isArray(m) ? m : [m]) this.receive(x);
          }
          return false;
        });
        throw new Error('the stream ended');
      })().catch((e) => {
        clearTimeout(timer);
        if (this.sseControl !== control) return; // closed or opened again on purpose
        this.sseControl = null;
        this.postUrl = null;
        this.ready = null;
        const error = new Error(`MCP server "${t.name}" closed its event stream (${e.message}).`);
        red(error);
        for (const [, b] of this.pending) b.red(error);
        this.pending.clear();
      });
    });
  }

  getMessage(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return; // sunucunun stdout'a yazdigi gunluk satiri
    }
    this.receive(m);
  }

  /** A message from the server: the response to a waiting request, a progress notification of one, or a request. */
  receive(m) {
    if (m.id !== undefined && this.pending.has(m.id) && (m.result !== undefined || m.error)) {
      const b = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) b.red(new Error(`MCP ${this.definition.name}: ${m.error.message ?? JSON.stringify(m.error)}`));
      else b.ok(m.result);
    } else if (m.method === 'notifications/progress') {
      this.pending.get(m.params?.progressToken)?.progress(m.params ?? {});
    } else if (m.id !== undefined && m.method) {
      // Sunucudan istek (ping, roots/list): bos yanit
      try {
        this.send({ jsonrpc: '2.0', id: m.id, result: serverRequestAnswer(m.method) })?.catch?.(() => {});
      } catch {
        /* the server is gone: nobody to answer */
      }
    }
  }

  /** stdio: a line on its input; sse: a POST to the message address (a promise; the answer comes over the stream). */
  send(m) {
    if (this.transport === 'stdio') {
      if (!this.proc) throw new Error(`MCP server "${this.definition.name}" is not running.`);
      this.proc.stdin.write(`${JSON.stringify(m)}\n`);
    } else if (this.transport === 'sse') {
      if (!this.postUrl) throw new Error(`MCP server "${this.definition.name}" is not connected.`);
      return fetch(this.postUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.definition.headers }, body: JSON.stringify(m), signal: AbortSignal.timeout(this.limits.other) }).then(async (r) => {
        await r.body?.cancel().catch(() => {});
        if (!r.ok) throw new Error(`MCP ${this.definition.name}: HTTP ${r.status} for ${m.method ?? 'an answer'}`);
      });
    }
    return null;
  }

  /** How long a request may wait: the start, a tool call, or anything else (tools/list). */
  limitFor(method) {
    return method === 'initialize' ? this.limits.init : method === 'tools/call' ? this.limits.tool : this.limits.other;
  }

  timeoutText(method, limit, progressed) {
    const hint = method === 'tools/call' ? ' (a longer limit for this server: "timeout" in ms in mcp.json)' : method === 'initialize' ? ' (a longer start limit: "initTimeout" in ms in mcp.json)' : '';
    return `MCP ${this.definition.name}: ${method} did not respond within ${Math.round(limit / 100) / 10} s${progressed ? ' after its last progress report' : ''}${hint}. ${this.errorText.trim().slice(-300)}`.trim();
  }

  /**
   * Streamable HTTP: one POST per message; the answer is JSON or an event stream that may carry progress
   * notifications first (each restarts the wait) and requests of the server (answered with another POST).
   */
  async sendHttp(m, { limit = this.limits.other, signal = null, onProgress = null } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': VERSION, ...this.definition.headers };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const control = new AbortController();
    let timer = null;
    let timedOut = false;
    let progressed = false;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        control.abort();
      }, limit);
    };
    const stop = () => control.abort();
    signal?.addEventListener('abort', stop, { once: true });
    touch();
    try {
      const r = await fetch(this.definition.url, { method: 'POST', headers: headers, body: JSON.stringify(m), signal: control.signal });
      touch();
      const o = r.headers.get('mcp-session-id');
      if (o) this.session = o;
      // a notification, or our answer to a request of the server: nothing comes back
      if (m.id === undefined || !m.method) {
        await r.body?.cancel().catch(() => {});
        return null;
      }
      if (!r.ok) throw Object.assign(new Error(`MCP ${this.definition.name}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`), { status: r.status });
      let answer = null;
      const take = (s) => {
        let j;
        try {
          j = JSON.parse(s);
        } catch {
          return false;
        }
        for (const x of Array.isArray(j) ? j : [j]) {
          if (x?.id === m.id && (x.result !== undefined || x.error)) answer = x;
          else if (x?.method === 'notifications/progress' && x.params?.progressToken === m.id) {
            progressed = true;
            touch();
            onProgress?.(x.params);
          } else if (x?.id !== undefined && x.method) this.sendHttp({ jsonrpc: '2.0', id: x.id, result: serverRequestAnswer(x.method) }).catch(() => {});
        }
        return Boolean(answer);
      };
      if ((r.headers.get('content-type') ?? '').includes('text/event-stream')) await readEvents(r.body, (e) => take(e.data));
      else take(await r.text());
      if (!answer) throw new Error(`MCP ${this.definition.name}: could not parse the response.`);
      if (answer.error) throw new Error(`MCP ${this.definition.name}: ${answer.error.message ?? JSON.stringify(answer.error)}`);
      return answer.result;
    } catch (e) {
      // the server is told that nobody waits for the answer any more (MCP notifications/cancelled)
      if (timedOut || signal?.aborted) this.notify('notifications/cancelled', { requestId: m.id, reason: timedOut ? 'Timed out' : 'Stopped by the user' }).catch(() => {});
      if (timedOut) throw new Error(this.timeoutText(m.method, limit, progressed));
      if (signal?.aborted) throw new Error('Stopped.');
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }

  /**
   * A request; signal (Stop) cancels it (the server is told: notifications/cancelled), onProgress gets the server's
   * progress notifications ({ progress, total, message }) of a tool call.
   */
  req(method, params = {}, { signal = null, onProgress = null } = {}) {
    this.counter += 1;
    const id = this.counter;
    const limit = this.limitFor(method);
    // a tool call asks for progress notifications (MCP progressToken): each one restarts the wait (keep-alive)
    const m = { jsonrpc: '2.0', id, method: method, params: method === 'tools/call' ? { ...params, _meta: { ...(params._meta ?? {}), progressToken: id } } : params };
    if (this.transport === 'http') return this.sendHttp(m, { limit, signal, onProgress });
    // stdio and sse: the answer arrives as a message of its own (receive)
    return new Promise((ok, red) => {
      let timer = null;
      let progressed = false;
      const finish = (fn, v) => {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', stop);
        fn(v);
      };
      // the server is told that nobody waits for the answer any more (MCP notifications/cancelled)
      const cancel = (reason) => this.notify('notifications/cancelled', { requestId: id, reason }).catch(() => {});
      const stop = () => {
        cancel('Stopped by the user');
        finish(red, new Error('Stopped.'));
      };
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish(red, new Error(this.timeoutText(method, limit, progressed)));
          cancel('Timed out');
        }, limit);
      };
      if (signal?.aborted) return red(new Error('Stopped.'));
      touch();
      signal?.addEventListener('abort', stop, { once: true });
      this.pending.set(id, {
        ok: (v) => finish(ok, v),
        red: (e) => finish(red, e),
        progress: (p) => {
          progressed = true;
          touch();
          onProgress?.(p);
        },
      });
      try {
        this.send(m)?.catch?.((e) => this.pending.get(id)?.red(e));
      } catch (e) {
        this.pending.get(id)?.red(e);
      }
    });
  }

  async notify(method, params = {}) {
    const m = { jsonrpc: '2.0', method: method, params };
    if (this.transport === 'http') await this.sendHttp(m).catch(() => {});
    else await this.send(m);
  }

  async toolList() {
    await this.start();
    if (this.tools) return this.tools;
    const list = [];
    let cursor;
    do {
      const r = await this.req('tools/list', cursor ? { cursor: cursor } : {});
      list.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
    } while (cursor && list.length < 500);
    this.tools = list;
    return list;
  }

  /** Arac cagrisi -> { text, images: [{ mime, data(base64) }], error }; signal: Stop, onProgress: the server's reports. */
  async call(name, input = {}, { signal = null, onProgress = null } = {}) {
    await this.start();
    const r = await this.req('tools/call', { name: name, arguments: input }, { signal, onProgress });
    const parts = [];
    const images = [];
    for (const c of r?.content ?? []) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'image') images.push({ mime: c.mimeType, data: c.data });
      else if (c.type === 'resource') parts.push(c.resource?.text ?? `[resource ${c.resource?.uri}]`);
      else parts.push(JSON.stringify(c).slice(0, 2000));
    }
    if (r?.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent));
    return { text: parts.join('\n'), images, error: Boolean(r?.isError) };
  }

  close() {
    const s = this.proc;
    this.proc = null;
    this.ready = null;
    if (s?.pid) killTree(s.pid);
    const sse = this.sseControl;
    if (sse) {
      this.sseControl = null;
      this.postUrl = null;
      sse.abort();
      for (const [, b] of this.pending) b.red(new Error(`MCP server "${this.definition.name}" was closed.`));
      this.pending.clear();
    }
  }
}

/** PATH with the panel's own python, python\Scripts and node folders first (those that exist), under the key Windows uses. */
export function ownPrograms(aiRoot) {
  const own = ['python', join('python', 'Scripts'), 'node'].map((d) => join(aiRoot, d)).filter((d) => existsSync(d));
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return own.length ? { [key]: [...own, process.env[key] ?? ''].join(delimiter) } : {};
}

/** Ad -> istemci; sunucu bir kez acilir, panel kapanirken hepsi kapanir. */
export class McpManager {
  constructor({ aiRoot, dataRoot, env = process.env, log = () => {} }) {
    Object.assign(this, { aiRoot, dataRoot, env, log });
    this.clients = new Map();
  }

  servers() {
    return mcpServers({ aiRoot: this.aiRoot, dataRoot: this.dataRoot, env: this.env });
  }

  client(name) {
    const definition = this.servers()[name];
    if (!definition) throw new Error(`No such MCP server: "${name}". Known: ${Object.keys(this.servers()).join(', ') || '(none)'}`);
    let i = this.clients.get(name);
    if (!i) {
      // A local server sees the panel's own Python and Node first on its PATH, like the agent's commands, and starts in
      // the panel's folder (10.10.2026: the agent's "python <its server>.py" hit the Microsoft Store alias)
      const local = definition.type === 'stdio' ? { env: { ...ownPrograms(this.aiRoot), ...definition.env }, cwd: definition.cwd ?? this.aiRoot } : {};
      i = new McpClient({ ...definition, ...local }, { log: this.log });
      this.clients.set(name, i);
    }
    return i;
  }

  /**
   * Adds or replaces a server in panel-data\mcp.json (the agent's add_mcp_server; user request 08.10.2026: it should
   * find and install what it needs). A running client of that name is closed so the new definition is used.
   * definition: { command, args, env } or { type: 'http', url, headers }; null removes the server.
   */
  save(name, definition) {
    const clean = String(name).replace(/[^\w-]/g, '_');
    const file = join(this.dataRoot, DATA_FILES.mcp);
    const j = jsonFile(file) ?? {};
    j.mcpServers ??= {};
    if (definition) j.mcpServers[clean] = definition;
    else delete j.mcpServers[clean];
    mkdirSync(this.dataRoot, { recursive: true });
    writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
    this.clients.get(clean)?.close();
    this.clients.delete(clean);
    return clean;
  }

  /** The tool list of a server if it was fetched in this run of the panel (null: not yet). */
  cachedTools(name) {
    return this.clients.get(name)?.tools ?? null;
  }

  /** Every server, the disabled ones too, with what this run of the panel knows of it (started, its tools). */
  list() {
    return mcpServerList({ aiRoot: this.aiRoot, dataRoot: this.dataRoot, env: this.env }).map((s) => {
      const tools = this.cachedTools(s.name);
      return { ...s, started: Boolean(this.clients.get(s.name)?.ready), tools: tools ? tools.map((t) => t.name) : null };
    });
  }

  /**
   * Turns a server off or on and sets its time limit for one tool call (seconds; null: its own or the default). A
   * server of the panel changes in its definition; one from another file gets an override in panel-data\mcp.json.
   * A running client is closed so the change applies at its next start.
   */
  configure(name, { disabled, timeoutSec } = {}) {
    const server = this.list().find((s) => s.name === name);
    if (!server) return null;
    const file = join(this.dataRoot, DATA_FILES.mcp);
    const j = jsonFile(file) ?? {};
    const target = server.editable ? (j.mcpServers ??= {})[name] : ((j.overrides ??= {})[name] ??= {});
    if (disabled !== undefined) {
      if (disabled) target.disabled = true;
      else delete target.disabled;
    }
    if (timeoutSec !== undefined) {
      const n = Number(timeoutSec);
      if (timeoutSec === null || timeoutSec === '' || !(n > 0)) delete target.timeout;
      else target.timeout = Math.round(n * 1000);
    }
    if (!server.editable && !Object.keys(target).length) delete j.overrides[name];
    mkdirSync(this.dataRoot, { recursive: true });
    writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
    this.clients.get(name)?.close();
    this.clients.delete(name);
    return this.list().find((s) => s.name === name);
  }

  /** The definition a server has in panel-data\mcp.json (to put it back when a replacement does not start). */
  panelDefinition(name) {
    return jsonFile(join(this.dataRoot, DATA_FILES.mcp))?.mcpServers?.[String(name).replace(/[^\w-]/g, '_')] ?? null;
  }

  /** Closes the running servers that are no longer defined, and those named (a replaced plugin's): the next use starts them anew. */
  prune(names = []) {
    const known = this.servers();
    for (const [name, i] of this.clients) {
      if (known[name] && !names.includes(name)) continue;
      i.close();
      this.clients.delete(name);
    }
  }

  closeAll() {
    for (const i of this.clients.values()) i.close();
    this.clients.clear();
  }
}
