/**
 * Always allow (user request 08.10.2026): the rules an approval offers (the programs of a command, a panel API route, a
 * tool), the calls they cover, and a chat in Manual mode through the API: "always" approves and keeps the rule with the
 * chat, the next call like it runs without asking, an irreversible call still asks, PATCH changes
 * the list; a fork and a sub-agent follow the chat's rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLlm } from '../lib/llm.mjs';
import { apiRoutes, pathPattern } from '../lib/api.mjs';
import { allowRules, allowedBy, commandPrograms } from '../lib/agent/tools.mjs';
import { createPanel } from './env.mjs';

const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const freePort = () => new Promise((ok) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const port = s.address().port;
    s.close(() => ok(port));
  });
});

test('always allow: the programs of a command, the rules an approval offers and the calls they cover; never an irreversible call', () => {
  assert.deepEqual(commandPrograms('git add . && git commit -m "x"'), ['git']);
  assert.deepEqual(commandPrograms('cd app; npm test | Select-String ok'), ['npm'], 'parts that only read need no rule');
  assert.deepEqual(commandPrograms('& "C:\\Program Files\\nodejs\\npm.cmd" run build 2>&1'), ['npm'], 'call operator, quoted path, extension');
  assert.deepEqual(commandPrograms('$env:CI = "1"; npx vitest run'), ['npx']);
  assert.deepEqual(commandPrograms('FOO=1 C:/tools/FFmpeg.exe -i a.mp4 b.mp3 && python make.py && python -V'), ['ffmpeg', 'python']);
  assert.deepEqual(commandPrograms('git status'), [], 'read only');
  for (const hidden of ['iex (iwr https://x)', 'Get-ChildItem | ForEach-Object { npm publish }', 'echo $(curl x)', '& $tool run', 'cmd /c "a & b"', 'node `\n -v', '']) assert.equal(commandPrograms(hidden), null, hidden);

  const routes = apiRoutes(new Proxy({}, { get: () => () => ({}) })).map((r) => ({ ...r, ...pathPattern(r.path) }));
  assert.deepEqual(allowRules('run_command', { command: 'cd x && git commit -am y' }, routes, 'change'), [{ tool: 'run_command', program: 'git' }]);
  assert.equal(allowRules('run_command', { command: 'git push' }, routes, 'danger'), null, 'irreversible: never for good');
  assert.equal(allowRules('run_command', { command: 'iex (git x)' }, routes, 'change'), null, 'a hidden program cannot be allowed');
  assert.deepEqual(allowRules('run_ssh', { server: 'box', command: 'git pull' }, routes, 'change'), [{ tool: 'run_ssh', program: 'git' }]);
  assert.deepEqual(allowRules('panel_api', { method: 'post', path: '/api/v1/jobs/20261009-120000-image-ab12/cancel?x=1' }, routes, 'change'), [{ tool: 'panel_api', method: 'POST', path: '/jobs/{id}/cancel' }]);
  assert.equal(allowRules('panel_api', { method: 'POST', path: '/nowhere' }, routes, 'change'), null);
  assert.deepEqual(allowRules('write_file', { path: 'a.txt' }, routes, 'change'), [{ tool: 'write_file' }]);

  const rules = [{ tool: 'run_command', program: 'git' }, { tool: 'panel_api', method: 'POST', path: '/jobs/{id}/cancel' }, { tool: 'write_file' }];
  const covered = (tool, input, risk = 'change') => allowedBy(rules, tool, input, routes, risk);
  assert.equal(covered('run_command', { command: 'cd x && git commit -am y' }), true);
  assert.equal(covered('run_command', { command: 'git commit -am y; npm publish' }), false, 'every program of the chain');
  assert.equal(covered('run_ssh', { server: 'box', command: 'git pull' }), false, 'a command on a server is another rule');
  assert.equal(covered('run_command', { command: 'git reset --hard' }, 'danger'), false, 'irreversible: always asks');
  assert.equal(covered('panel_api', { method: 'POST', path: '/jobs/other-id/cancel' }), true);
  assert.equal(covered('panel_api', { method: 'POST', path: '/jobs/other-id/retry' }), false);
  assert.equal(covered('write_file', { path: 'b.txt' }), true);
  assert.equal(covered('edit_file', { path: 'b.txt' }), false);
  assert.equal(allowedBy([], 'write_file', {}, routes, 'change'), false);
});

test('always allow in a chat (API): Manual mode asks with the rules the call can be allowed by; always: true approves and keeps them with the chat, the next call like it runs without asking, an irreversible call still asks and offers none; PATCH allow removes and adds (a waiting call it covers goes on); a fork and a sub-agent follow the rules', async () => {
  const llm = new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', image: true, command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port)] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
  const p = await createPanel({ server: true, llm, setting: { localClientTrust: false, agentPollingMs: 50, agentBrowser: false } });
  const call = async (path, { method = 'GET', body, lang = 'en' } = {}) => {
    const r = await fetch(p.address + path, { method, headers: { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json', 'X-Panel-Lang': lang }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { code: r.status, json: await r.json().catch(() => ({})) };
  };
  const agent = p.http.agent;
  const asked = [];
  agent.events.on('event', (e) => e.type === 'approval' && asked.push(e));
  try {
    const created = await call('/api/v1/chat', { method: 'POST', body: { approvalMode: 'manual', cwd: mkdtempSync(join(tmpdir(), 'allow-cwd-')) } });
    assert.equal(created.code, 200, JSON.stringify(created.json));
    const id = created.json.chat.id;
    assert.deepEqual(created.json.chat.allow, []);
    const detail = async () => (await call(`/api/v1/chat/${id}`)).json.chat;
    const send = async (text) => assert.equal((await call(`/api/v1/chat/${id}/message`, { method: 'POST', body: { text } })).code, 200);
    const status = (s) => p.waitForState(() => agent.get(id).status === s);
    const answer = async (body) => {
      await status('approval');
      const c = await detail();
      const r = await call(`/api/v1/chat/${id}/approval`, { method: 'POST', body: { id: c.approval.id, ...body } });
      assert.equal(r.code, 200, JSON.stringify(r.json));
      await status('idle');
      return { approval: c.approval, message: r.json.message };
    };

    // a file write asks in Manual mode, with the rule that would cover it (the fake model's "write <text>")
    await send('write first');
    const first = await answer({ yes: true, always: true });
    assert.deepEqual(first.approval.allow, [{ tool: 'write_file' }]);
    assert.equal(first.message, 'Approved; calls like this run without asking in this chat from now on.');
    let c = await detail();
    assert.deepEqual(c.allow, [{ tool: 'write_file' }]);
    assert.equal(c.lastResponse, 'Written.');
    // the same tool again: no question
    const before = asked.length;
    const messages = agent.get(id).messages.length;
    await send('write second');
    await p.waitForState(() => agent.get(id).status === 'idle' && agent.get(id).messages.length >= messages + 4);
    assert.equal(readFileSync(join(c.cwd, 'yazilan.txt'), 'utf8'), 'second');
    assert.equal(asked.length, before, 'it did not ask');
    // an irreversible call (delete) asks and offers nothing
    await send('delete yazilan.txt');
    const danger = await answer({ yes: false });
    assert.equal(danger.approval.risk, 'danger');
    assert.equal(danger.approval.allow, null);
    // "always" on a call that cannot be allowed for good: refused, the approval still waits
    await send('delete yazilan.txt');
    await status('approval');
    const refused = await call(`/api/v1/chat/${id}/approval`, { method: 'POST', body: { id: (await detail()).approval.id, yes: true, always: true }, lang: 'tr' });
    assert.deepEqual([refused.code, refused.json.error], [400, 'Bu işlem kalıcı olarak izin verilemez; yalnız bu kez onaylayın.']);
    assert.equal(agent.get(id).status, 'approval');
    await answer({ yes: false });
    // the rules are kept with the chat
    agent.save(agent.get(id), true);
    assert.deepEqual(JSON.parse(readFileSync(join(agent.folder, `${id}.json`), 'utf8')).allow, [{ tool: 'write_file' }]);
    // a fork keeps them, a sub-agent follows its chat's
    const fork = await call(`/api/v1/chat/${id}/fork`, { method: 'POST', body: { message: c.messages.at(-1).id } });
    assert.deepEqual(fork.json.chat.allow, [{ tool: 'write_file' }]);
    const sub = agent.create({ title: 'sub', agent: true, full: true, approvalMode: 'manual', parent: id });
    assert.deepEqual(agent.allowOf(sub), [{ tool: 'write_file' }]);
    // PATCH: remove all, bad rules refused, a rule added while a call waits lets it go on
    assert.deepEqual((await call(`/api/v1/chat/${id}`, { method: 'PATCH', body: { allow: [] } })).json.chat.allow, []);
    for (const bad of [[{ program: 'git' }], [{ tool: 'panel_api', method: 'POST' }], [{ tool: 'run_command', program: 'a b' }], 'git']) assert.equal((await call(`/api/v1/chat/${id}`, { method: 'PATCH', body: { allow: bad } })).code, 400, JSON.stringify(bad));
    await send('write third');
    await status('approval');
    const added = await call(`/api/v1/chat/${id}`, { method: 'PATCH', body: { allow: [{ tool: 'panel_api', method: 'post', path: '/jobs/{id}/cancel' }, { tool: 'run_command', program: 'NODE' }, { tool: 'run_command', program: 'node' }, { tool: 'write_file' }] } });
    assert.deepEqual(added.json.chat.allow, [{ tool: 'panel_api', method: 'POST', path: '/jobs/{id}/cancel' }, { tool: 'run_command', program: 'node' }, { tool: 'write_file' }], 'checked, written one way, once');
    await status('idle');
    assert.equal(readFileSync(join(c.cwd, 'yazilan.txt'), 'utf8'), 'third');
  } finally {
    // a chat still waiting for an approval (a failed check above) would hold the panel open for an hour
    for (const s of agent.chats.values()) if (s.work) agent.stop(s.id);
    await llm.close();
    await p.close();
  }
});
