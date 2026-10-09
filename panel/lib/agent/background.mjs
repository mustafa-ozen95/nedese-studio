/**
 * Waiting in the background (user request 09.10.2026: "Bizim agentların da izleyici bekleyici oluşturma özelliği var
 * dimi", "Sendeki gibi olsun onda da": like Claude Code's background tools). A watch checks something by itself every
 * few minutes, without the text model (a command, a web address or a panel job), until its condition is met, then wakes
 * the chat that made it with the agent's "then" text; a monitor runs a command and wakes its chat with the new lines it
 * prints. A failing check (a host that is down, a command that fails or runs out of time) only means "not yet".
 *
 * Kept in panel-data\chat\watches.json: watches go on after a panel restart; a monitor's command does not survive one
 * (its chat gets a note). Waking a chat (a busy chat gets the message when it is idle, a chat that is gone gets a new
 * "⏰" chat) is AgentManager.wake; the chat's own list and Stop are AgentManager.backgroundList / stopItem.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { killTree } from '../process.mjs';
import { USER_AGENT } from '../data-collection.mjs';
import { commandEnv, shellCommand, startProcess } from './tools.mjs';

/** Watches and monitors at a time (all chats), and the longest one may run. */
export const BACKGROUND_LIMIT = 50;
export const MAX_HOURS = 72;
// one check: a command, a web address
const CHECK_COMMAND_MS = 60000;
const CHECK_URL_MS = 15000;
// what a message to the chat carries of an output, and the lines a monitor keeps between two messages
const MESSAGE_OUTPUT = 2000;
const MONITOR_LINES = 100;
const LINE_LENGTH = 400;

/** The end of a text, at most n characters. */
export const tail = (s, n = MESSAGE_OUTPUT) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** 12 s, 3 min 5 s, 2 h 5 min. */
export function durationText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** "09.10 14:05" (Istanbul). */
export function shortTime(t = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

/** A regular expression the model gave (null when none); a broken one is refused with the reason. */
function expression(source, name) {
  if (source === undefined || source === null || String(source) === '') return null;
  try {
    new RegExp(String(source), 'im');
  } catch (e) {
    throw new Error(`${name} is not a valid regular expression: ${e.message}`);
  }
  return String(source);
}

/** What a watch checks, in one line (lists, the chat line). */
export function watchText(w) {
  const c = w.check ?? {};
  const what = c.command !== undefined ? `command: ${c.command}` : c.url ? `url: ${c.url}` : `job ${c.job}`;
  return `${what}${w.until ? ` until /${w.until}/` : ''}`;
}

export class Watchers {
  constructor({ file, setting, manager, log = () => {} }) {
    Object.assign(this, { file, setting, manager, log });
    const data = this.read();
    this.items = data.items;
    this.counter = data.counter;
    this.timers = new Map();
    // monitors running now: id -> { record, lines, dropped, partial, timer, lastWake, stopped, closing, ended }
    this.live = new Map();
  }

  /** How long one "minute" of a watch is: 60 s; tests make it short (setting.agentWatchMinuteMs, set on the object). */
  get minute() {
    return Number(this.setting.agentWatchMinuteMs) > 0 ? Number(this.setting.agentWatchMinuteMs) : 60000;
  }

  read() {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      return { items: Array.isArray(j.items) ? j.items : [], counter: Number(j.counter) || 0 };
    } catch {
      return { items: [], counter: 0 };
    }
  }

  save() {
    try {
      writeFileSync(this.file, JSON.stringify({ counter: this.counter, items: this.items }, null, 1));
    } catch (e) {
      this.log(`[agent] could not write the watches: ${e.message}`);
    }
  }

  /** After a (re)start: every watch goes on from its next check; a monitor's command is gone, its chat is told. */
  start() {
    for (const w of [...this.items]) {
      if (w.kind !== 'monitor') {
        this.arm(w);
        continue;
      }
      this.items = this.items.filter((x) => x !== w);
      this.manager.note(w.chat, `[Monitor ${w.id} stopped: the panel restarted and its command no longer runs (${w.command}). Start it again if it is still needed.]`, { kind: 'monitor-ended', ref: w.id });
    }
    this.save();
  }

  get(id) {
    return this.items.find((w) => w.id === String(id ?? '')) ?? null;
  }

  forChat(chat) {
    return this.items.filter((w) => w.chat === chat);
  }

  /** The fields every watch and monitor has: its chat, the access a new chat gets when that one is gone, its end. */
  base(kind, { chat, then = '', maxHours, full = false, approvalMode = 'edits', cwd = null }) {
    if (this.items.length >= BACKGROUND_LIMIT) throw new Error(`At most ${BACKGROUND_LIMIT} watches and monitors at a time: stop one first (background).`);
    const hours = maxHours === undefined || maxHours === null || maxHours === '' ? 12 : Number(maxHours);
    if (!(hours > 0)) throw new Error('max_hours must be more than 0.');
    const now = Date.now();
    this.counter += 1;
    const limit = Math.min(MAX_HOURS, hours);
    return { id: `${kind === 'monitor' ? 'm' : 'w'}${this.counter}`, kind, chat, then: String(then ?? '').trim().slice(0, 2000), maxHours: limit, full: Boolean(full), approvalMode, cwd, creation: new Date(now).toISOString(), ends: new Date(now + limit * 60 * this.minute).toISOString(), last: null };
  }

  /** A watch: check { command, shell, cwd } | { url } | { job }; its first check runs at once. */
  addWatch({ check, until, everyMin, repeat = false, ...rest }) {
    const u = expression(until, 'until');
    const every = Math.max(1, Math.min(1440, Number(everyMin) || 5));
    if (!String(rest.then ?? '').trim()) throw new Error('Say in "then" what to do when it happens.');
    const w = { ...this.base('watch', rest), check, until: u, everyMin: every, repeat: Boolean(repeat), next: new Date().toISOString(), checks: 0, fired: 0, met: false };
    this.items.push(w);
    this.save();
    this.arm(w);
    this.changed(w.chat);
    return w;
  }

  /** A monitor: the command starts now; each new line (matching pattern) is an event for its chat. */
  addMonitor({ command, shell = 'powershell', pattern, ...rest }) {
    const p = expression(pattern, 'pattern');
    const m = { ...this.base('monitor', rest), command: String(command), shell, pattern: p, lines: 0 };
    this.items.push(m);
    this.save();
    this.startMonitor(m);
    this.changed(m.chat);
    return m;
  }

  /** Removes a watch or monitor (a monitor's command is stopped): it never wakes its chat again. */
  remove(id) {
    const w = this.get(id);
    if (!w) return null;
    this.items = this.items.filter((x) => x !== w);
    clearTimeout(this.timers.get(w.id));
    this.timers.delete(w.id);
    const live = this.live.get(w.id);
    if (live) {
      live.stopped = true;
      clearTimeout(live.timer);
      clearTimeout(live.limit);
      if (live.record.code === null && live.record.proc.pid) killTree(live.record.proc.pid);
    }
    this.save();
    this.changed(w.chat);
    return w;
  }

  /** The chat whose list changed (its line and Settings › Assistant follow). */
  changed(chat) {
    this.manager.backgroundChanged?.(chat);
  }

  /** Where a fired watch or a monitor's lines go when the chat is gone: a new chat with the access it was made with. */
  fallback(w) {
    return { title: w.then || watchText(w), full: w.full, approvalMode: w.approvalMode, cwd: w.cwd };
  }

  /** A message for the chat; the chat that got it from now on (a new "⏰" chat when the first one is gone). */
  wake(w, text) {
    const chat = this.manager.wake(w.chat, text, { kind: w.kind, ref: w.id, fallback: this.fallback(w) });
    if (chat && chat !== w.chat) w.chat = chat;
  }

  /* ── Watches ── */

  arm(w) {
    if (this.closed) return;
    clearTimeout(this.timers.get(w.id));
    const at = Math.min(Date.parse(w.next) || Date.now(), Date.parse(w.ends) || Date.now());
    const t = setTimeout(() => this.tick(w.id).catch((e) => this.log(`[agent] watch ${w.id}: ${e.message}`)), Math.max(0, at - Date.now()));
    t.unref?.();
    this.timers.set(w.id, t);
  }

  async tick(id) {
    const w = this.get(id);
    if (!w || w.kind === 'monitor') return;
    if (Date.now() >= Date.parse(w.ends)) return this.expire(w);
    let r;
    try {
      r = await this.check(w);
    } catch (e) {
      r = { met: false, text: e.message, short: e.message };
    }
    // stopped while it was checked, or the panel closes (the file keeps it as it was)
    if (this.get(id) !== w || this.closed) return;
    w.checks += 1;
    w.last = { time: new Date().toISOString(), met: r.met, text: String(r.short ?? r.text).replace(/\s+/g, ' ').trim().slice(0, 200) };
    // repeat: true wakes each time the condition becomes true again, not on every check while it stays true
    const fire = r.met && !(w.repeat && w.met);
    w.met = r.met;
    w.next = new Date(Date.now() + w.everyMin * this.minute).toISOString();
    if (fire) {
      w.fired += 1;
      if (!w.repeat) {
        this.items = this.items.filter((x) => x !== w);
        this.timers.delete(w.id);
      }
      this.wake(w, `[Watch ${w.id} fired ${shortTime()}: ${tail(r.text) || '(no output)'}] ${w.then}`);
    }
    this.save();
    if (this.get(id) === w) this.arm(w);
    this.changed(w.chat);
  }

  /** max_hours passed: the watch ends and its chat gets a note (no model call). */
  expire(w) {
    this.items = this.items.filter((x) => x !== w);
    this.timers.delete(w.id);
    this.save();
    const hours = `${Math.round(w.maxHours * 100) / 100} h`;
    this.manager.note(w.chat, w.fired ? `[Watch ${w.id} ended after ${hours} (it fired ${w.fired} time${w.fired === 1 ? '' : 's'})]` : `[Watch ${w.id} ended without the condition after ${hours}: ${watchText(w)}]`, { kind: 'watch-ended', ref: w.id });
    this.changed(w.chat);
  }

  /** One check: { met, text: what the message carries, short: the last result line }. */
  async check(w) {
    const c = w.check ?? {};
    if (c.command !== undefined) return this.checkCommand(w);
    if (c.url) return this.checkUrl(w);
    return this.checkJob(w);
  }

  async checkCommand(w) {
    const c = w.check;
    const [command, args, options] = shellCommand(c.shell ?? 'powershell', String(c.command));
    const record = startProcess({ command, args, options, cwd: c.cwd ?? w.cwd ?? this.setting.aiRoot, env: commandEnv(this.setting) });
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      if (record.proc.pid) killTree(record.proc.pid);
    }, CHECK_COMMAND_MS);
    await record.done;
    clearTimeout(timer);
    const output = record.output.trim();
    if (late) return { met: false, text: output, short: `no answer within ${CHECK_COMMAND_MS / 1000} s` };
    const met = w.until ? new RegExp(w.until, 'im').test(output) : record.code === 0;
    return { met, text: output, short: `exit code ${record.code}${output ? `: ${output.split('\n').at(-1)}` : ''}` };
  }

  async checkUrl(w) {
    try {
      const r = await fetch(w.check.url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(CHECK_URL_MS) });
      const body = (await r.text()).slice(0, 200000);
      const text = `HTTP ${r.status}\n${body}`;
      return { met: w.until ? new RegExp(w.until, 'im').test(text) : r.ok, text, short: `HTTP ${r.status}` };
    } catch (e) {
      return { met: false, text: e.message, short: e.cause?.code ?? e.message };
    }
  }

  checkJob(w) {
    let job;
    try {
      job = this.manager.h.job(w.check.job);
    } catch {
      return { met: true, text: `Job ${w.check.job} is not there any more (deleted).`, short: 'deleted' };
    }
    const working = ['waiting', 'running'].includes(job.status) || (job.status === 'paused' && job.yielded);
    const status = `${job.status}${job.error ? `: ${job.error}` : ''}${working && job.progress?.percent !== undefined ? ` (${job.progress.percent}%)` : ''}`;
    const outputs = (job.outputs ?? []).filter((x) => x.url).slice(0, 8).map((x) => `${x.type} ${x.url}`);
    return { met: w.until ? new RegExp(w.until, 'im').test(status) : !working, text: `Job ${job.id}: ${status}${outputs.length ? `\nOutputs: ${outputs.join(', ')}` : ''}`, short: status };
  }

  /* ── Monitors ── */

  startMonitor(m) {
    const [command, args, options] = shellCommand(m.shell ?? 'powershell', m.command);
    const record = startProcess({ command, args, options, cwd: m.cwd ?? this.setting.aiRoot, env: commandEnv(this.setting) });
    const live = { record, lines: [], dropped: 0, partial: { out: '', err: '' }, timer: null, lastWake: 0, stopped: false, closing: false, ended: null };
    this.live.set(m.id, live);
    const re = m.pattern ? new RegExp(m.pattern, 'i') : null;
    const take = (stream) => (piece) => {
      const parts = `${live.partial[stream]}${piece}`.split(/\r?\n/);
      live.partial[stream] = parts.pop();
      for (const line of parts) this.line(m, live, line, re);
    };
    record.proc.stdout?.on('data', take('out'));
    record.proc.stderr?.on('data', take('err'));
    live.limit = setTimeout(() => {
      live.ended = 'time';
      if (record.proc.pid) killTree(record.proc.pid);
    }, Math.max(0, Date.parse(m.ends) - Date.now()));
    live.limit.unref?.();
    record.done.then(() => this.monitorEnded(m.id));
  }

  line(m, live, line, re) {
    const text = line.replace(/\s+$/, '');
    if (!text.trim() || (re && !re.test(text))) return;
    live.lines.push(text.slice(0, LINE_LENGTH));
    if (live.lines.length > MONITOR_LINES) {
      live.lines.shift();
      live.dropped += 1;
    }
    m.lines += 1;
    m.last = { time: new Date().toISOString(), text: text.trim().slice(0, 200) };
    // lines that come together go together
    live.timer ??= setTimeout(() => this.flush(m.id), 200);
  }

  /**
   * New lines to the chat: at most once per half "minute" (30 s), the lines collected in between together; while the
   * chat works they wait for it (chatIdle sends them).
   */
  flush(id) {
    const m = this.get(id);
    const live = this.live.get(id);
    if (!m || !live || live.stopped) return;
    live.timer = null;
    if (!live.lines.length || this.manager.busy?.(m.chat)) return;
    const wait = live.lastWake + this.minute / 2 - Date.now();
    if (wait > 0) {
      live.timer = setTimeout(() => this.flush(id), wait);
      return;
    }
    const lines = live.lines.splice(0);
    const dropped = live.dropped;
    live.dropped = 0;
    live.lastWake = Date.now();
    this.wake(m, `[Monitor ${m.id}: ${lines.length} new line${lines.length === 1 ? '' : 's'} at ${shortTime()}${dropped ? ` (${dropped} earlier ones left out)` : ''}]\n${tail(lines.join('\n'))}${m.then ? `\n${m.then}` : ''}`);
    this.save();
    this.changed(m.chat);
  }

  /** The chat is idle again: lines its monitors held for it. */
  chatIdle(chat) {
    for (const m of this.items) if (m.kind === 'monitor' && m.chat === chat && this.live.get(m.id)?.lines.length) this.flush(m.id);
  }

  /** The command ended: once more to the chat (exit code, the lines not sent yet), unless it was stopped. */
  monitorEnded(id) {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    clearTimeout(live.timer);
    clearTimeout(live.limit);
    const m = this.get(id);
    if (live.stopped || live.closing || !m) return;
    for (const stream of ['out', 'err']) if (live.partial[stream].trim()) this.line(m, live, live.partial[stream], m.pattern ? new RegExp(m.pattern, 'i') : null);
    clearTimeout(live.timer);
    this.items = this.items.filter((x) => x !== m);
    this.save();
    const lines = live.lines.length ? `\n${tail(live.lines.join('\n'))}` : '';
    if (live.ended === 'time') this.manager.note(m.chat, `[Monitor ${m.id} stopped after ${m.maxHours} h (its time limit)]${lines}`, { kind: 'monitor-ended', ref: m.id });
    else this.wake(m, `[Monitor ${m.id} ended: exit code ${live.record.code}, ${durationText(Date.now() - Date.parse(m.creation))}]${lines}${m.then ? `\n${m.then}` : ''}`);
    this.changed(m.chat);
  }

  /** The panel closes: timers stop, monitors' commands end (the file keeps them: their chats are told at the next start). */
  close() {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const live of this.live.values()) {
      live.closing = true;
      clearTimeout(live.timer);
      clearTimeout(live.limit);
      if (live.record.code === null && live.record.proc.pid) killTree(live.record.proc.pid);
    }
  }
}
