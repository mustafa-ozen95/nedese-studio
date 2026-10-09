/**
 * Background work of the chats (user request 09.10.2026: watchers and waiters like Claude Code's, "Ajan durdurulabilmeli"):
 * watches checked without the model until their condition, monitors whose lines wake the chat, background commands
 * and sub-agents that tell their chat when they finish, wake-ups in the same chat, the background list and Stop (one item,
 * a chat with everything it runs, all). Real panel, real shell commands and HTTP checks, the fake text model
 * (fake-llm.mjs "call tool <name> <json>"); one "minute" of a watch is 100 ms here (setting agentWatchMinuteMs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLlm } from '../lib/llm.mjs';
import { AgentManager, subAgentTitle } from '../lib/agent/agent.mjs';
import { createPanel } from './env.mjs';

const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const MINUTE = 100;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const freePort = () => new Promise((ok) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A panel with the fake text model; its API with the key (full access). */
async function env() {
  const llm = new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', image: true, models: [{ file: 'a.gguf', name: 'a', gib: 1, image: true }], command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port), 'a.gguf'] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
  const p = await createPanel({ server: true, llm, setting: { localClientTrust: false, agentPollingMs: 50, agentBrowser: false } });
  // not a setting of settings.mjs: the watches read it from the panel's setting object (default 60000)
  p.setting.agentWatchMinuteMs = MINUTE;
  const agent = p.http.agent;
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(p.address + path, { method, headers: { Accept: 'application/json', Authorization: `Bearer ${p.settingFile.apiKey}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { code: r.status, json: await r.json().catch(() => ({})) };
  };
  const chat = async () => {
    const r = await call('/api/v1/chat', { method: 'POST', body: {} });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    return r.json.chat;
  };
  const send = async (id, text) => {
    const r = await call(`/api/v1/chat/${id}/message`, { method: 'POST', body: { text, wait: true } });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    assert.ok(r.json.response !== undefined, `the chat was busy: ${JSON.stringify(r.json)}`);
    return r.json.response;
  };
  const until = async (fn, what, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(25)) if (await fn()) return;
    throw new Error(`timed out: ${what}`);
  };
  const tool = (name, input) => `call tool ${name} ${JSON.stringify(input)}`;
  const messages = (id) => agent.get(id).messages;
  const wakes = (id) => messages(id).filter((m) => m.wake && m.role === 'user');
  // idle, and its last answer is the one to a message from the background
  const answered = (id, pattern) => agent.get(id).status === 'idle' && pattern.test(messages(id).at(-1)?.content ?? '') && messages(id).at(-1).role === 'assistant';
  return { p, llm, agent, call, chat, send, until, tool, messages, wakes, answered, async close() { await llm.close(); await p.close(); } };
}

/** A web address whose answer the test sets: 503 "starting" or 200 "ok ready" (plan: the next answers in order). */
async function site(status = 503) {
  const state = { status, hits: 0, plan: [] };
  const server = createServer((req, res) => {
    state.hits += 1;
    const s = state.plan.length ? state.plan.shift() : state.status;
    res.writeHead(s, { 'Content-Type': 'text/plain' });
    res.end(s === 200 ? 'ok ready' : 'starting');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { state, url: `http://127.0.0.1:${server.address().port}/health`, close: () => new Promise((ok) => server.close(ok)) };
}

test('watch: a command check that fails twice and then succeeds fires once, the chat goes on with its output and "then"; the watch is gone and not checked again', async () => {
  const o = await env();
  try {
    const s = await o.chat();
    const count = join(o.p.root, 'count.txt');
    const command = `$n = 1 + [int](Get-Content '${count}' -ErrorAction SilentlyContinue); Set-Content '${count}' $n; if ($n -lt 3) { 'not yet'; exit 1 }; 'ready after ' + $n + ' checks'`;
    const r = await o.send(s.id, o.tool('watch', { command, every_min: 1, then: 'Deploy the site now.' }));
    assert.match(r, /^Result \(watch\): Watching \(w1\): command .* checked now and every 1 min until .* \(Istanbul\) at the latest\. This chat is woken/);
    assert.equal(o.agent.watchers.get('w1').chat, s.id);
    await o.until(() => o.answered(s.id, /^EN: \[Watch w1 fired/), 'the watch fired and the chat answered');
    const [wake] = o.wakes(s.id);
    assert.match(wake.content, /^\[Watch w1 fired \d\d\.\d\d \d\d:\d\d: ready after 3 checks\] Deploy the site now\.$/);
    assert.deepEqual(wake.wake, { kind: 'watch', id: 'w1' });
    assert.equal(o.messages(s.id).at(-1).content, `EN: ${wake.content}`, 'the model got the output and the "then" text');
    assert.equal(readFileSync(count, 'utf8').trim(), '3', 'checked three times');
    assert.deepEqual(o.agent.watchers.items, []);
    assert.deepEqual(JSON.parse(readFileSync(join(o.agent.folder, 'watches.json'), 'utf8')).items, []);
    // repeat: false: no check after it fired
    await wait(MINUTE * 8);
    assert.equal(readFileSync(count, 'utf8').trim(), '3');
    assert.equal(o.wakes(s.id).length, 1);
  } finally {
    await o.close();
  }
});

test('watch: a url that never gets ready ends after max_hours with a note (no model call) that the model reads with the next message; repeat: true wakes on each change to ready; the background tool lists and stops it', async () => {
  const o = await env();
  const web = await site(503);
  try {
    const s = await o.chat();
    // 0.05 h = 3 "minutes" = 300 ms here
    await o.send(s.id, o.tool('watch', { url: web.url, every_min: 1, max_hours: 0.05, then: 'Tell me it is up.' }));
    const answers = o.messages(s.id).filter((m) => m.role === 'assistant').length;
    await o.until(() => o.messages(s.id).some((m) => m.role === 'note' && m.kind === 'background'), 'the watch ended');
    const note = o.messages(s.id).find((m) => m.role === 'note');
    assert.equal(note.content, `[Watch w1 ended without the condition after 0.05 h: url: ${web.url}]`);
    assert.ok(web.state.hits >= 2, 'checked more than once');
    await wait(300);
    assert.equal(o.messages(s.id).filter((m) => m.role === 'assistant').length, answers, 'no model call for its end');
    assert.equal(o.agent.get(s.id).status, 'idle');
    assert.equal(await o.send(s.id, 'and now?'), `EN: ${note.content}\n\nand now?`);
    // repeat: up, up (no second wake), down, up again (a second wake)
    web.state.plan = [200, 200, 503];
    web.state.status = 200;
    await o.send(s.id, o.tool('watch', { url: web.url, every_min: 1, repeat: true, then: 'It is up.' }));
    await o.until(() => o.wakes(s.id).length === 2 && o.answered(s.id, /^EN: \[Watch w2 fired/), 'two wakes');
    for (const m of o.wakes(s.id)) assert.match(m.content, /^\[Watch w2 fired [\d. :]+: HTTP 200\nok ready\] It is up\.$/);
    await wait(MINUTE * 4);
    assert.equal(o.wakes(s.id).length, 2, 'it stays up: no more wakes');
    const list = await o.send(s.id, o.tool('background', {}));
    assert.match(list, /^Result \(background\): 1 item \(stop one: background with stop: <id>\):\n- w2 · watch · waiting, every 1 min, next check [\d. :]+, ends [\d. :]+, last check: HTTP 200\n {2}url: http:\/\/127\.0\.0\.1:\d+\/health/);
    assert.equal(await o.send(s.id, o.tool('background', { stop: 'w2' })), 'Result (background): Watcher w2 stopped.');
    assert.equal(o.agent.watchers.get('w2'), null);
    const hits = web.state.hits;
    web.state.plan = [503, 503];
    await wait(MINUTE * 6);
    assert.equal(web.state.hits, hits, 'not checked after it was stopped');
    assert.equal(o.wakes(s.id).length, 2);
    assert.equal(await o.send(s.id, o.tool('background', { stop: 'w2' })), 'Result (background): Tool error: Nothing runs in the background with the id w2 for this chat.');
  } finally {
    await web.close();
    await o.close();
  }
});

test('watch and monitor after a restart: the watch goes on from the file and fires in its chat, a monitor\'s chat is told its command stopped; ids are not used twice', async () => {
  const o = await env();
  const web = await site(503);
  let again = null;
  try {
    const s = await o.chat();
    await o.send(s.id, o.tool('watch', { url: web.url, every_min: 1, then: 'After the restart.' }));
    await o.send(s.id, o.tool('monitor', { command: 'Start-Sleep -Seconds 60' }));
    const monitor = o.agent.watchers.items.find((w) => w.kind === 'monitor');
    assert.equal(monitor.id, 'm2');
    const pid = o.agent.watchers.live.get('m2').record.proc.pid;
    assert.ok(alive(pid));
    // the panel stops: the monitor's command ends, both stay in the file
    o.agent.watchers.close();
    await o.until(() => !alive(pid), 'the monitor command ended');
    const saved = JSON.parse(readFileSync(join(o.agent.folder, 'watches.json'), 'utf8'));
    assert.deepEqual(saved.items.map((w) => [w.id, w.kind, w.chat]), [['w1', 'watch', s.id], ['m2', 'monitor', s.id]]);
    web.state.status = 200;
    again = new AgentManager({ setting: o.p.setting, llm: o.llm, h: o.agent.h, routes: o.agent.routes, jobTypes: o.agent.jobTypes });
    assert.match(again.get(s.id).messages.find((m) => m.role === 'note')?.content ?? '', /^\[Monitor m2 stopped: the panel restarted and its command no longer runs \(Start-Sleep -Seconds 60\)\. Start it again if it is still needed\.\]$/);
    // the note rides on the next message to the model
    await o.until(() => again.get(s.id).status === 'idle' && /^EN: \[Monitor m2 stopped: [^\n]+\]\n\n\[Watch w1 fired [\d. :]+: HTTP 200\nok ready\] After the restart\.$/.test(again.get(s.id).messages.at(-1).content), 'the watch fired after the restart');
    assert.deepEqual(again.watchers.items, []);
    const next = again.watchers.addWatch({ chat: s.id, check: { url: web.url }, everyMin: 600, then: 'x' });
    assert.equal(next.id, 'w3');
  } finally {
    again?.close();
    await web.close();
    await o.close();
  }
});

test('a message from the background waits for a busy chat and comes after its answer; a monitor wakes the chat with its new lines (only those matching pattern) and once more when it ends', async () => {
  const o = await env();
  const web = await site(200);
  try {
    const s = await o.chat();
    const sent = o.send(s.id, o.tool('run_command', { command: "Start-Sleep -Seconds 2; 'slept'", duration_sec: 60 }));
    await o.until(() => o.agent.get(s.id).work?.tool === 'run_command', 'the command runs');
    o.agent.watchers.addWatch({ chat: s.id, check: { url: web.url }, then: 'The site is up.', full: true });
    await o.until(() => o.agent.wakes.get(s.id)?.length === 1, 'the fired watch waits for the chat');
    assert.ok(!o.messages(s.id).some((m) => m.wake), 'not in the conversation while the chat works');
    assert.match(await sent, /^Output: \[exit code 0, [\d.]+ s\]\nslept$/);
    await o.until(() => o.answered(s.id, /^EN: \[Watch w1 fired/), 'the chat went on with it');
    const at = o.messages(s.id).findIndex((m) => m.wake);
    assert.match(o.messages(s.id)[at - 1].content, /^Output: /, 'after the answer of the run it waited for');
    // a monitor: lines of the command, "noise" left out by the pattern, then its end
    const command = "foreach ($i in 1..3) { 'tick ' + $i; 'noise'; Start-Sleep -Milliseconds 400 }; 'DONE'";
    await o.send(s.id, o.tool('monitor', { command, pattern: '^(tick|DONE)', then: 'Count the ticks.' }));
    await o.until(() => o.wakes(s.id).some((m) => /^\[Monitor m2 ended: exit code 0, /.test(m.content)) && o.agent.get(s.id).status === 'idle' && !o.agent.wakes.has(s.id), 'the monitor ended');
    const monitorWakes = o.wakes(s.id).filter((m) => m.wake.kind === 'monitor');
    const lines = monitorWakes.flatMap((m) => m.content.split('\n').filter((l) => /^(tick|DONE|noise)/.test(l)));
    assert.deepEqual(lines, ['tick 1', 'tick 2', 'tick 3', 'DONE']);
    assert.ok(monitorWakes.length >= 2, 'its lines and its end wake the chat');
    for (const m of monitorWakes) assert.match(m.content, /Count the ticks\.$/);
    assert.deepEqual(o.agent.watchers.items, []);
  } finally {
    await web.close();
    await o.close();
  }
});

test('a sub-agent chat is titled by its task, the files in the chat\'s folder named relatively (the list showed C:\\Users\\... paths)', () => {
  assert.equal(subAgentTitle('Write C:\\Users\\me\\demo\\tool\\README.md and c:\\users\\me\\demo\\tool.mjs', 'C:\\Users\\me\\demo\\'), '↳ Write tool\\README.md and tool.mjs');
  assert.equal(subAgentTitle('Fix /home/me/app/src/a.js', '/home/me/app'), '↳ Fix src/a.js');
  assert.equal(subAgentTitle(`count\n apples ${'x'.repeat(80)}`, ''), `↳ count apples ${'x'.repeat(47)}`);
});

test('notify: a background command wakes its chat when it ends (not with notify: false, not when it ended at once); a sub-agent with wait: false wakes its parent with its result; a wake-up goes on in the same chat with its schedule id, same_chat: false opens a new chat', async () => {
  const o = await env();
  try {
    const s = await o.chat();
    const r = await o.send(s.id, o.tool('run_command', { command: "Start-Sleep -Seconds 3; 'built ok'", back_plan: true }));
    assert.match(r, /^Output: Started in the background: k1 \(pid \d+\)\.[\s\S]*You will be told when it finishes/);
    await o.until(() => o.answered(s.id, /^EN: \[Background command k1 finished/), 'the command woke the chat');
    assert.match(o.wakes(s.id)[0].content, /^\[Background command k1 finished: exit code 0, \d+ s\] built ok$/);
    assert.deepEqual(o.wakes(s.id)[0].wake, { kind: 'command', id: 'k1' });
    const own = (await o.call(`/api/v1/chat/background?chat=${s.id}`)).json.items;
    assert.deepEqual(own.map((x) => [x.id, x.kind, x.status]), [['k1', 'command', 'done']]);
    // notify: false, and a command that ended within the first moments: no message later
    assert.match(await o.send(s.id, o.tool('run_command', { command: "Start-Sleep -Seconds 2; 'quiet'", back_plan: true, notify: false })), /Started in the background: k2/);
    assert.match(await o.send(s.id, o.tool('run_command', { command: 'echo fast', shell: 'cmd', back_plan: true })), /^Output: Finished at once: k3 \(exit code 0, [\d.]+ s\)\nfast$/);
    await o.until(() => o.agent.processes.get('k2').code !== null, 'k2 ended');
    await wait(2500);
    assert.equal(o.wakes(s.id).length, 1);
    // a sub-agent in parallel: its result comes as a message
    const started = await o.send(s.id, o.tool('sub_agent', { task: 'count apples', wait: false }));
    const sub = /Sub-agent started: (\w+)\. You will be told when it finishes/.exec(started)?.[1];
    assert.ok(sub, started);
    await o.until(() => o.answered(s.id, /^EN: \[Sub-agent \w+ finished\]/), 'the parent got the result');
    assert.equal(o.wakes(s.id).at(-1).content, `[Sub-agent ${sub} finished] EN: count apples`);
    const item = (await o.call(`/api/v1/chat/background?chat=${s.id}`)).json.items.find((x) => x.kind === 'agent');
    assert.deepEqual([item.id, item.chat, item.chatTitle, item.text, item.status, item.started, item.seconds], [sub, s.id, o.agent.get(s.id).title, 'count apples', 'done', o.agent.get(sub).creation, null]);
    assert.ok(item.tokens > 0, 'its tokens');
    // a wake-up: the same chat, its task knows its schedule id
    await o.send(s.id, o.tool('schedule', { task: 'say hello', minute_after: 1 }));
    const [z] = o.agent.schedules();
    assert.equal(z.chat, s.id);
    assert.equal((await o.call(`/api/v1/chat/background?chat=${s.id}`)).json.items.find((x) => x.kind === 'wakeup')?.id, z.id);
    o.agent.writeSchedules([{ ...z, time: new Date(Date.now() - 1000).toISOString() }]);
    const chats = o.agent.list().total;
    await o.agent.processSchedules();
    await o.until(() => o.answered(s.id, /^EN: \[schedule /), 'the wake-up went on in the chat');
    assert.equal(o.messages(s.id).at(-1).content, `EN: [schedule ${z.id}] say hello`);
    assert.equal(o.agent.list().total, chats, 'no new chat');
    assert.deepEqual(o.agent.schedules(), []);
    // same_chat: false: a new "⏰" chat each time, its task knows its id too
    await o.send(s.id, o.tool('schedule', { task: 'check the disk', minute_after: 1, repeat_min: 60, same_chat: false }));
    const [y] = o.agent.schedules();
    assert.equal(y.chat, undefined);
    o.agent.writeSchedules([{ ...y, time: new Date(Date.now() - 1000).toISOString() }]);
    await o.agent.processSchedules();
    const made = o.agent.list().chats.find((c) => c.title === '⏰ check the disk');
    assert.ok(made, 'a new chat');
    await o.until(() => o.answered(made.id, /^EN: /), 'it ran');
    assert.equal(o.messages(made.id)[0].content, `[schedule ${y.id}, every 60 min] check the disk`);
    assert.equal(o.agent.schedules()[0].id, y.id, 'it repeats');
  } finally {
    await o.close();
  }
});

test('stop: a chat\'s Stop stops what it runs in the background (a sub-agent of an idle parent, a background command with its process, watches and wake-ups) and nothing of it wakes the chat again; one item stops by its id (API); Stop all', async () => {
  const o = await env();
  const web = await site(503);
  try {
    // an idle parent with a sub-agent that works
    const parent = await o.chat();
    const slow = o.tool('run_command', { command: 'Start-Sleep -Seconds 60', duration_sec: 120 });
    const started = await o.send(parent.id, o.tool('sub_agent', { task: slow, wait: false }));
    const sub = /Sub-agent started: (\w+)/.exec(started)[1];
    await o.until(() => o.agent.get(sub).work?.tool === 'run_command', 'the sub-agent runs its command');
    assert.equal(o.agent.get(parent.id).status, 'idle');
    const running = (await o.call('/api/v1/chat/running')).json;
    assert.ok(running.agents.some((a) => a.id === sub && a.parent === parent.id));
    assert.deepEqual(running.background.map((x) => [x.id, x.kind, x.chat]), [[sub, 'agent', parent.id]]);
    const stopped = await o.call(`/api/v1/chat/${parent.id}/stop`, { method: 'POST' });
    assert.equal(stopped.code, 200);
    assert.equal(stopped.json.message, 'Stopped: 1 sub-agent.');
    assert.deepEqual(stopped.json.stopped, [{ id: sub, kind: 'agent' }]);
    await o.until(() => o.agent.get(sub).status === 'idle', 'the sub-agent stopped');
    assert.equal(o.messages(sub).at(-1).content, '(stopped)');
    // a background command: its process tree goes
    const c = await o.chat();
    await o.send(c.id, o.tool('run_command', { command: 'Start-Sleep -Seconds 60', back_plan: true }));
    const pid = o.agent.processes.get('k1').proc.pid;
    assert.ok(alive(pid));
    // a watch and a wake-up of the same chat
    await o.send(c.id, o.tool('watch', { url: web.url, every_min: 1, then: 'Up.' }));
    await o.send(c.id, o.tool('schedule', { task: 'wake me', minute_after: 1 }));
    const all = (await o.call(`/api/v1/chat/background?chat=${c.id}`)).json.items;
    assert.deepEqual(all.map((x) => x.kind).sort(), ['command', 'wakeup', 'watch']);
    const stop = await o.call(`/api/v1/chat/${c.id}/stop`, { method: 'POST' });
    assert.equal(stop.json.message, 'Stopped: 1 background command · 1 watcher · 1 wake-up.');
    await o.until(() => !alive(pid), 'the command process is gone', 10000);
    web.state.status = 200;
    await wait(MINUTE * 6);
    await o.agent.processSchedules();
    await wait(2000);
    assert.deepEqual([o.wakes(parent.id).length, o.wakes(c.id).length], [0, 0], 'nothing that was stopped woke a chat');
    assert.deepEqual([o.agent.watchers.items, o.agent.schedules()], [[], []]);
    assert.equal(o.agent.get(c.id).status, 'idle');
    // one item by its id; an unknown id
    await o.send(c.id, o.tool('watch', { url: web.url, every_min: 600, then: 'Up again.' }));
    // its first check fires at once (the site is up): a second one that waits
    await o.until(() => o.answered(c.id, /^EN: \[Watch w2 fired/), 'w2 fired');
    web.state.status = 503;
    await o.send(c.id, o.tool('watch', { url: web.url, every_min: 600, then: 'Up again.' }));
    const one = await o.call('/api/v1/chat/background/w3', { method: 'DELETE' });
    assert.deepEqual([one.code, one.json.message, one.json.stopped], [200, 'Watcher w3 stopped.', [{ id: 'w3', kind: 'watch' }]]);
    assert.equal((await o.call('/api/v1/chat/background/w3', { method: 'DELETE' })).code, 404);
    // Stop all: a working sub-agent of one chat, a command and a watch of another
    await o.send(parent.id, o.tool('sub_agent', { task: slow, wait: false }));
    await o.until(() => o.agent.backgroundList().some((x) => x.kind === 'agent'), 'the second sub-agent runs');
    await o.send(c.id, o.tool('run_command', { command: 'Start-Sleep -Seconds 60', back_plan: true }));
    await o.send(c.id, o.tool('watch', { url: web.url, every_min: 600, then: 'Up.' }));
    const pid2 = o.agent.processes.get('k2').proc.pid;
    const everything = await o.call('/api/v1/chat/stop-all', { method: 'POST' });
    assert.equal(everything.json.message, 'Stopped: 1 sub-agent · 1 background command · 1 watcher.');
    await o.until(() => !alive(pid2) && o.agent.backgroundList().length === 0, 'everything stopped', 10000);
    assert.equal((await o.call('/api/v1/chat/stop-all', { method: 'POST' })).json.message, 'Nothing was running.');
  } finally {
    await web.close();
    await o.close();
  }
});
