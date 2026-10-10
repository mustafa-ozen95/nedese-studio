/**
 * Sohbet / ajan (lib/agent): sahte yazi modeli (fake-llm.mjs ajan senaryolari) ile uctan uca: panel isi acma ve bekleme,
 * olay akisi (SSE), yetki (tam / kisitli), onay, metin blogu yedegi, kabuk, MCP (sahte stdio sunucu), beceri, hafiza,
 * zamanlama, alt ajan, gorsel ekleri, web okuma, OpenAI uyumlu "nedese-agent", baglam kirpma; birim: ayristirici, kirpma.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLlm } from '../lib/llm.mjs';
import { toolBlocks, searchQuery, searchFold, partialWrite, noteLine, summaryCut, turnSources, uninstalledTools, cleanSources, followUpList } from '../lib/agent/agent.mjs';
import { apiResultText, htmlText, truncate, isDestructiveApi, isDestructiveCommand, isReadOnlyCommand, needsApproval, panelApiRisk, commandRisk, bingTarget, relevantResults, pageExcerpt, guessLanguage, messageLanguage, sourceTrust, mcpCommand, localPaths, terminalText, artifactOf, TOOLS } from '../lib/agent/tools.mjs';
import { McpClient, McpManager, expandVariables, functionSchema, mcpFunctionName, mcpServers, nativeMcpTools, progressText } from '../lib/agent/mcp.mjs';
import { startFakeMcpHttp } from './fake-mcp-http.mjs';
import { startFakeRemote } from './fake-remote-llm.mjs';
import { anthropicApi, checkRemoteAddress, claudeBody, remoteReadsImages, remoteRequest } from '../lib/remote-llm.mjs';
import { startFakeAnthropic } from './fake-anthropic.mjs';
import { checkServiceValue, maskAddress, maskKey } from '../lib/agent/web-search.mjs';
import { unifiedDiff } from '../lib/agent/diff.mjs';
import { findSkills, frontMatter, githubSource } from '../lib/agent/skills.mjs';
import { githubRepo } from '../lib/agent/plugins.mjs';
import { makePng } from '../lib/media.mjs';
import { loadSettings } from '../lib/settings.mjs';
import { createPanel } from './env.mjs';
import { translate } from '../lib/language.mjs';

const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const FAKE_MCP = fileURLToPath(new URL('./fake-mcp.mjs', import.meta.url));
const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
// Two text models: the default (a.gguf, reads images) and b.gguf; the fake answers "which model" with its file
const FAKE_MODELS = [{ file: 'a.gguf', name: 'a', gib: 1, image: true }, { file: 'b.gguf', name: 'b', gib: 1, image: false }];
const fakeLlm = async (options = {}) => new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', image: true, models: FAKE_MODELS, command: (port, i) => ({ command: process.execPath, args: [FAKE_LLM, String(port), i?.file ?? 'a.gguf'] }) }, port: await freePort(), readySec: 20, idleSec: 600, ...options });

/** Panel + agent: a skill and mcp.json in the panel's own data folder, local client trust off (full access only with the key). */
async function agentEnv(options = {}) {
  // a folder of the test's own (a working folder for presets, a missing program's path)
  const home = mkdtempSync(join(tmpdir(), 'ajan-ev-'));
  const llm = await fakeLlm();
  const p = await createPanel({ server: true, llm, setting: { localClientTrust: false, agentPollingMs: 50, agentBrowser: false, ...options } });
  const skill = join(p.setting.dataRoot, 'skills', 'deneme-beceri');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: deneme-beceri\ndescription: Deneme becerisi açıklaması\n---\n# Deneme\nAdım 1: merhaba de.\n');
  writeFileSync(join(skill, 'ek.md'), 'ek dosya');
  writeFileSync(join(p.setting.dataRoot, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP] } } }));
  const call = async (path, { method = 'GET', body, key = true, raw, type } = {}) => {
    const h = { Accept: 'application/json', 'X-Panel-Lang': 'tr' };
    if (key) h.Authorization = `Bearer ${p.settingFile.apiKey}`;
    else {
      h['X-Panel'] = '1';
      h.Origin = p.address;
    }
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (raw !== undefined) h['Content-Type'] = type ?? 'application/octet-stream';
    const r = await fetch(p.address + path, { method: method, headers: h, body: body !== undefined ? JSON.stringify(body) : raw });
    return { code: r.status, json: await r.json().catch(() => ({})) };
  };
  /** SSE: "done" olayina kadar olaylari toplar. ready: ilk "status" olayi geldi (baglanti kuruldu; mesaj ondan sonra gonderilir). */
  const events = (id, { key = true } = {}) => {
    let ready;
    const readyP = new Promise((ok) => { ready = ok; });
    const list = (async () => {
      const h = key ? { Authorization: `Bearer ${p.settingFile.apiKey}` } : { 'X-Panel': '1', Origin: p.address };
      const r = await fetch(`${p.address}/api/v1/chat/${id}/events`, { headers: h });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/event-stream/);
      const list = [];
      const reader = r.body.getReader();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += Buffer.from(value).toString('utf8');
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const part = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = part.split('\n').filter((s) => s.startsWith('data:')).map((s) => s.slice(5).trim()).join('');
          if (data) list.push(JSON.parse(data));
        }
        if (list.some((o) => o.type === 'status')) ready();
        if (list.some((o) => o.type === 'done')) break;
      }
      reader.cancel().catch(() => {});
      return list;
    })();
    list.catch(() => {}).finally(ready);
    return { ready: readyP, list };
  };
  const chat = async (body = {}, { key = true } = {}) => {
    const r = await call('/api/v1/chat', { method: 'POST', body, key });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    return r.json.chat;
  };
  const send = async (id, text, { key = true, attachments, wait = true } = {}) => {
    const r = await call(`/api/v1/chat/${id}/message`, { method: 'POST', body: { text, attachments, wait }, key });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    return r.json;
  };
  return { p, home, llm, call, events, chat, send, agent: p.http.agent, async close() { await llm.close(); await p.close(); } };
}

test('agent units: tool block parser, truncation, destructive command/API, HTML text, skill front matter', () => {
  assert.deepEqual(toolBlocks('First this.\n<tool>{"name":"read_file","input":{"path":"a.txt"}}</tool>\nthen'), { calls: [{ name: 'read_file', input: { path: 'a.txt' } }], text: 'First this.\n\nthen' });
  assert.deepEqual(toolBlocks('<tool_call>{"name":"search_web","arguments":"{\\"query\\":\\"x\\"}"}</tool_call>').calls, [{ name: 'search_web', input: { query: 'x' } }]);
  // the other key names: tool, parameters
  assert.deepEqual(toolBlocks('<tool>{"tool":"read_file","parameters":{"path":"b.txt"}}</tool>'), { calls: [{ name: 'read_file', input: { path: 'b.txt' } }], text: '' });
  assert.deepEqual(toolBlocks('```json\n{"name":"schedules","input":{}}\n```').calls, [{ name: 'schedules', input: {} }]);
  assert.deepEqual(toolBlocks('Plain answer {"name": "x"} not a code block'), { calls: [], text: 'Plain answer {"name": "x"} not a code block' });
  const long = 'a'.repeat(5000) + 'SON';
  const k = truncate(long, 1000);
  assert.ok(k.length < 1100 && k.endsWith('SON') && k.includes('characters trimmed'));
  assert.equal(truncate('short'), 'short');
  // Long API lists: first items kept and the total stated (the model must not count only the visible items)
  const gallery = { ok: true, gallery: Array.from({ length: 121 }, (_, i) => ({ id: `20261008-0000${i}-image-abcd`, type: 'image', prompt: 'x'.repeat(120), outputs: [{ url: `/file/${i}.png` }] })) };
  const g = apiResultText(gallery);
  assert.ok(g.length < 6400, `length ${g.length}`);
  assert.match(g, /^\[gallery: 121 items in total, first \d+ shown/);
  assert.ok(JSON.parse(g.slice(g.indexOf('\n') + 1)).gallery.length >= 5, 'the cut list is still valid JSON');
  assert.equal(apiResultText({ ok: true, jobs: [1, 2] }), JSON.stringify({ ok: true, jobs: [1, 2] }, null, 1));
  assert.ok(isDestructiveCommand('Remove-Item -Recurse C:\\x') && isDestructiveCommand('git push origin main') && isDestructiveCommand('rm -rf build'));
  assert.ok(!isDestructiveCommand('Get-ChildItem') && !isDestructiveCommand('npm test') && !isDestructiveCommand('git status'));
  assert.ok(isDestructiveApi('DELETE', '/jobs/x') && isDestructiveApi('PATCH', '/settings') && isDestructiveApi('POST', '/jobs/x/delete'));
  assert.ok(!isDestructiveApi('POST', '/jobs') && !isDestructiveApi('GET', '/settings'));
  const h = htmlText('<html><head><title>Başlık &amp; co</title><style>x{}</style></head><body><script>var a=1</script><h1>Selam</h1><p>Bir <a href="/git">bağlantı</a> ve &ccedil;ok  boşluk</p><ul><li>a</li><li>b</li></ul></body></html>', 'http://ornek.test/page');
  assert.equal(h.title, 'Başlık & co');
  assert.equal(h.text, '# Selam\nBir [bağlantı](http://ornek.test/git) ve çok boşluk\n- a\n- b');
  assert.deepEqual(frontMatter('---\nname: x\ndescription: |\n  iki\n  satır\n---\ngövde'), { fields: { name: 'x', description: 'iki\nsatır' }, body: 'gövde' });
  assert.deepEqual(frontMatter('ön bilgisiz'), { fields: {}, body: 'ön bilgisiz' });
});

test('MCP: server definitions from inside the project only (panel, project, installed plugins) and tool list/call with a fake stdio server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-'));
  const plugin = join(root, 'data', 'plugins', 'ek');
  mkdirSync(join(plugin, 'skills', 'e-beceri'), { recursive: true });
  writeFileSync(join(root, 'data', 'mcp.json'), JSON.stringify({ mcpServers: { fromPanel: { command: 'a.exe' } } }));
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { fromProject: { type: 'http', url: 'http://x/mcp' }, fromPanel: { command: 'gölgelenir' } } }));
  writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { fromPlugin: { command: '${CLAUDE_PLUGIN_ROOT}/bin/x', args: ['--k'], env: { K: '${CLAUDE_PLUGIN_ROOT}' } } } }));
  writeFileSync(join(plugin, 'skills', 'e-beceri', 'SKILL.md'), '---\nname: e-beceri\ndescription: eklenti becerisi\n---\nx');
  // a plugin.json naming its servers in a file of the plugin
  mkdirSync(join(root, 'data', 'plugins', 'second', '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'data', 'plugins', 'second', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'second', mcpServers: './servers.json' }));
  writeFileSync(join(root, 'data', 'plugins', 'second', 'servers.json'), JSON.stringify({ mcpServers: { fromFile: { command: 'z' } } }));
  const s = mcpServers({ aiRoot: root, dataRoot: join(root, 'data') });
  assert.deepEqual(Object.keys(s).sort(), ['fromFile', 'fromPanel', 'fromPlugin', 'fromProject']);
  assert.equal(s.fromPanel.command, 'a.exe', 'panel definition shadows the project one');
  assert.equal(s.fromProject.type, 'http');
  assert.equal(s.fromPlugin.command, `${plugin}/bin/x`);
  assert.equal(s.fromPlugin.env.K, plugin);
  assert.equal(s.fromPlugin.source, 'plugin:ek');
  const b = findSkills({ aiRoot: root, dataRoot: join(root, 'data') });
  assert.deepEqual(b.map((x) => [x.name, x.source]), [['ek:e-beceri', 'plugin:ek']]);
  // Sahte sunucu: gunluk satiri atlanir, araclar listelenir, cagri metin + gorsel doner
  const i = new McpClient({ name: 'fake', type: 'stdio', command: process.execPath, args: [FAKE_MCP], env: {} }, { timeTimeoutMs: 15000 });
  try {
    const list = await i.toolList();
    assert.deepEqual(list.map((a) => a.name), ['collect']);
    assert.equal(i.instruction, 'Fake server.');
    const r = await i.call('collect', { a: 2, b: 3 });
    assert.equal(r.text, '5');
    assert.equal(r.images.length, 1);
    await assert.rejects(i.call('none', {}), /no such tool/);
  } finally {
    i.close();
  }
});

test('MCP time limits: per server from mcp.json, progress notifications keep a long tool call alive (stdio and streamable HTTP), a silent call ends at its limit, Stop cancels it', async () => {
  // Definitions: ms, or seconds when under 1000; tool calls get 10 minutes by default (generate_3d takes 1-3 min)
  const root = mkdtempSync(join(tmpdir(), 'mcp-limits-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'mcp.json'), JSON.stringify({ mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'], timeout: 300000, initTimeout: 90 }, plain: { command: 'x' }, remote: { type: 'http', url: 'http://x/mcp', timeout: '120' } } }));
  const s = mcpServers({ aiRoot: root, dataRoot: join(root, 'data') });
  assert.deepEqual([s.blender.timeout, s.blender.initTimeout], [300000, 90000]);
  assert.equal(s.remote.timeout, 120000);
  assert.equal(s.plain.timeout, undefined);
  assert.deepEqual(new McpClient(s.plain).limits, { init: 60000, tool: 600000, other: 60000 });
  assert.deepEqual(new McpClient(s.blender).limits, { init: 90000, tool: 300000, other: 60000 });
  assert.equal(progressText({ progress: 2, total: 5, message: 'step 2 of 5' }), 'step 2 of 5 (40%)');
  assert.equal(progressText({ progress: 1, total: 4 }), '25%');
  // 8 progress reports 100 ms apart outlive a 400 ms limit; a silent tool ends at it; Stop cancels at once
  const http = await startFakeMcpHttp();
  const clients = [new McpClient({ name: 'slow', type: 'stdio', command: process.execPath, args: [FAKE_MCP, '--slow'], env: {}, timeout: 400 }), new McpClient({ name: 'slowHttp', type: 'http', url: http.url, headers: {}, timeout: 400 })];
  try {
    for (const c of clients) {
      const reports = [];
      const r = await c.call('slow', { steps: 8, every: 100 }, { onProgress: (p) => reports.push(progressText(p)) });
      assert.equal(r.text, 'done after 8 steps', c.definition.name);
      assert.deepEqual([reports.length, reports.at(-1)], [8, 'step 8 of 8 (100%)']);
      const started = Date.now();
      await assert.rejects(c.call('hang', {}), /tools\/call did not respond within 0\.4 s \(a longer limit for this server: "timeout" in ms in mcp\.json\)/);
      assert.ok(Date.now() - started < 3000, `ended at its limit (${Date.now() - started} ms)`);
      const control = new AbortController();
      const stopped = c.call('hang', {}, { signal: control.signal });
      setTimeout(() => control.abort(), 50);
      await assert.rejects(stopped, /^Error: Stopped\.$/);
    }
    // the servers were told about the timed out and the stopped call (MCP notifications/cancelled)
    for (let i = 0; i < 40 && !((clients[0].errorText.match(/cancelled/g) ?? []).length >= 2 && http.seen.cancelled.length >= 2); i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal((clients[0].errorText.match(/cancelled \d+/g) ?? []).length, 2);
    assert.equal(http.seen.cancelled.length, 2);
    assert.equal(http.seen.headers['mcp-session-id'], 'fake-session', 'the session id goes with every request');
    // call_mcp shows the reports on the running card (progress events)
    const shown = [];
    const out = await TOOLS.find((t) => t.name === 'call_mcp').run({ server: 'slow', tool: 'slow', input: { steps: 2, every: 50 } }, { mcp: { client: () => clients[0] }, advance: (t) => shown.push(t), signal: new AbortController().signal, setting: {} });
    assert.equal(out, 'done after 2 steps');
    assert.deepEqual(shown, ['slow: step 1 of 2 (50%)', 'slow: step 2 of 2 (100%)']);
  } finally {
    for (const c of clients) c.close();
    await http.close();
  }
});

test('MCP: ${VAR} from the environment in command, args, env, url and headers (a missing one is named at start); the older SSE transport ("type": "sse", and an http address that refuses the POST); mcp_tools gives the server instructions first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-vars-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'mcp.json'), JSON.stringify({
    mcpServers: {
      local: { command: '${TOOL_HOME}/bin/server', args: ['--token=${API_TOKEN}', '--mode=${MODE:-fast}'], env: { KEY: '${API_TOKEN}', PLAIN: 'as is' } },
      remote: { type: 'http', url: 'https://${API_HOST}/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
      broken: { command: 'x', env: { KEY: '${NOT_SET_ANYWHERE}' } },
      old: { type: 'sse', url: 'http://h/sse' },
    },
  }));
  const env = { TOOL_HOME: 'C:/tools', API_TOKEN: 'tok123', API_HOST: 'mcp.example.com', MODE: '' };
  const s = mcpServers({ aiRoot: root, dataRoot: join(root, 'data'), env });
  assert.deepEqual([s.local.command, s.local.args, s.local.env], ['C:/tools/bin/server', ['--token=tok123', '--mode=fast'], { KEY: 'tok123', PLAIN: 'as is' }]);
  assert.deepEqual([s.remote.url, s.remote.headers], ['https://mcp.example.com/mcp', { Authorization: 'Bearer tok123' }]);
  assert.equal(s.local.missing, undefined);
  assert.deepEqual(s.broken.missing, ['NOT_SET_ANYWHERE']);
  assert.equal(s.old.type, 'sse');
  await assert.rejects(new McpClient(s.broken).toolList(), /environment variable NOT_SET_ANYWHERE is not set \(used as \$\{…\} in its definition, panel\)/);
  assert.equal(expandVariables('${A}-${B:-b}-$C-${CLAUDE_PLUGIN_ROOT}', { env: { A: 'a' }, root: 'R' }), 'a-b-$C-R');
  // The older SSE transport: a GET opens the stream, its "endpoint" event names the POST address, answers and progress
  // reports come over the stream. "guessed" is the same server added as http: its POST is refused and it switches.
  const sse = await startFakeMcpHttp({ transport: 'sse', instructions: 'Use collect to add numbers.' });
  const clients = [new McpClient({ name: 'old', type: 'sse', url: sse.url, headers: { 'X-Key': 'k1' } }, { timeTimeoutMs: 15000 }), new McpClient({ name: 'guessed', type: 'http', url: sse.url, headers: {} }, { timeTimeoutMs: 15000 })];
  try {
    for (const c of clients) {
      assert.deepEqual((await c.toolList()).map((a) => a.name), ['collect', 'slow', 'hang'], c.definition.name);
      assert.equal(c.transport, 'sse', c.definition.name);
      assert.equal((await c.call('collect', { a: 2, b: 5 })).text, '7');
      const reports = [];
      assert.equal((await c.call('slow', { steps: 3, every: 30 }, { onProgress: (p) => reports.push(progressText(p)) })).text, 'done after 3 steps');
      assert.deepEqual(reports, ['step 1 of 3 (33%)', 'step 2 of 3 (67%)', 'step 3 of 3 (100%)'], 'progress over the stream');
      if (c === clients[0]) assert.equal(sse.seen.headers['x-key'], 'k1', 'the headers of the definition go with the messages');
    }
    assert.ok(sse.seen.urls.some((u) => /^POST \/messages\?session=s\d$/.test(u)), 'messages go to the endpoint address');
    assert.ok(sse.seen.urls.includes('POST /sse'), 'the http address was tried with a POST first');
    // mcp_tools: the server's instructions before the tools
    const out = await TOOLS.find((t) => t.name === 'mcp_tools').run({ server: 'old' }, { mcp: { client: () => clients[0] } });
    assert.match(out, /^Instructions of the server "old":\nUse collect to add numbers\.\n\nTools:\n- collect: Adds two numbers/);
    // closing the client ends a waiting call with a clear error
    const waiting = clients[0].call('hang', {});
    setTimeout(() => clients[0].close(), 50);
    await assert.rejects(waiting, /MCP server "old" was closed/);
    // and the next call connects again
    assert.equal((await clients[0].call('collect', { a: 1, b: 1 })).text, '2');
  } finally {
    for (const c of clients) c.close();
    await sse.close();
  }
});

test('installing what the agent needs: skills from a folder or GitHub address, MCP servers checked before they are kept', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-install-'));
  const dataRoot = join(root, 'data');
  const run = (name, g, b) => TOOLS.find((t) => t.name === name).run(g, b);
  // GitHub addresses: repository, or a folder on a branch
  assert.deepEqual(githubSource('https://github.com/anthropics/skills'), { owner: 'anthropics', repo: 'skills', ref: '', folder: '' });
  assert.deepEqual(githubSource('https://github.com/anthropics/skills/tree/main/document-skills/pdf'), { owner: 'anthropics', repo: 'skills', ref: 'main', folder: 'document-skills/pdf' });
  assert.equal(githubSource('https://example.com/x'), null);
  // A source with two skills lists them; skill picks one; a second install needs replace
  for (const [folder, name] of [['one', 'first-skill'], ['two', 'second-skill']]) {
    mkdirSync(join(root, 'repo', 'skills', folder), { recursive: true });
    writeFileSync(join(root, 'repo', 'skills', folder, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${folder} skill\n---\nDo the ${folder} thing.`);
  }
  const b = { cwd: root, setting: { dataRoot }, full: true, mcp: new McpManager({ aiRoot: root, dataRoot }) };
  assert.match(await run('install_skill', { source: join(root, 'repo') }, b), /2 skills[\s\S]*- first-skill: The one skill[\s\S]*- second-skill/);
  assert.match(await run('install_skill', { source: join(root, 'repo'), skill: 'second-skill' }, b), /Installed skill "second-skill"/);
  assert.deepEqual(findSkills({ aiRoot: root, dataRoot }).map((s) => s.name), ['second-skill']);
  await assert.rejects(run('install_skill', { source: join(root, 'repo'), skill: 'two' }, b), /already installed/);
  assert.match(await run('install_skill', { source: join(root, 'repo'), skill: 'two', replace: true }, b), /Installed/);
  try {
    // MCP: kept only when it starts and lists its tools; a broken one is taken back out
    assert.match(await run('add_mcp_server', { name: 'calc', command: process.execPath, args: [FAKE_MCP] }, b), /added; 1 tools: collect/);
    assert.equal(b.mcp.servers().calc.source, 'panel');
    await assert.rejects(run('add_mcp_server', { name: 'broken', command: join(root, 'missing.exe') }, b), /did not start/);
    assert.equal(b.mcp.servers().broken, undefined, 'a server that does not start is not kept');
    assert.match(await run('add_mcp_server', { name: 'calc', remove: true }, b), /removed/);
    assert.equal(b.mcp.servers().calc, undefined);
    // The whole line in command (the model wrote "uvx mcp-server-time", 10.10.2026): split, the server starts
    assert.match(await run('add_mcp_server', { name: 'calc', command: `"${process.execPath}" "${FAKE_MCP}"` }, b), /added; 1 tools: collect/);
    assert.deepEqual([b.mcp.servers().calc.command, b.mcp.servers().calc.args], [process.execPath, [FAKE_MCP]]);
    assert.match(await run('add_mcp_server', { name: 'calc', remove: true }, b), /removed/);
    // A server the agent wrote, started with a program only the panel has ("python" from <ai>\python, 10.10.2026: it
    // hit the Microsoft Store alias) and its script given relative to the chat folder: found on the panel's PATH, the
    // script path stored in full
    if (process.platform === 'win32') {
      mkdirSync(join(root, 'node'), { recursive: true });
      writeFileSync(join(root, 'node', 'ownnode.cmd'), `@"${process.execPath}" %*\r\n`);
      mkdirSync(join(root, 'tools', 'calc'), { recursive: true });
      writeFileSync(join(root, 'tools', 'calc', 'server.mjs'), readFileSync(FAKE_MCP));
      assert.match(await run('add_mcp_server', { name: 'own', command: 'ownnode', args: ['tools\\calc\\server.mjs'] }, b), /added; 1 tools: collect/);
      assert.deepEqual(b.mcp.servers().own.args, [join(root, 'tools', 'calc', 'server.mjs')]);
      assert.match(await run('add_mcp_server', { name: 'own', remove: true }, b), /removed/);
    }
    assert.deepEqual(localPaths({ cwd: root }, { command: 'uvx', args: ['mcp-server-time', '--local-timezone', 'Europe/Istanbul', 'missing\\x.py'] }), { command: 'uvx', args: ['mcp-server-time', '--local-timezone', 'Europe/Istanbul', 'missing\\x.py'] }, 'package names, options and missing paths stay');
    assert.deepEqual(mcpCommand('uvx mcp-server-time --local-timezone Europe/Istanbul'), { command: 'uvx', args: ['mcp-server-time', '--local-timezone', 'Europe/Istanbul'] });
    assert.deepEqual(mcpCommand('npx', ['-y', 'x']), { command: 'npx', args: ['-y', 'x'] }, 'given args are kept');
    assert.deepEqual(mcpCommand(process.execPath), { command: process.execPath, args: [] }, 'an existing path is never split');
    // Command output without terminal codes; a line rewritten in place keeps only its last state (npx skills add, 10.10.2026)
    const spinner = '\x1b[?25l│\n\x1b[1G\x1b[J◒  Cloning repository…\x1b[1G\x1b[J◐  Cloning repository….\x1b[1G\x1b[J◇  Repository cloned\n\x1b[?25h│\n\x1b]0;title\x07\x1b[32m●\x1b[39m  Selected 1 skill: pdf\r\n 50%\r100%\n';
    assert.equal(terminalText(spinner), '│\n◇  Repository cloned\n│\n●  Selected 1 skill: pdf\n100%\n');
    assert.equal(terminalText('plain\nline'), 'plain\nline');
    assert.equal(TOOLS.find((t) => t.name === 'add_mcp_server').risk({ name: 'x', command: 'npx' }), 'danger', 'adding a server always asks outside Automatic');
  } finally {
    b.mcp.closeAll();
  }
});

test('Claude Code plugins inside the panel (user request 09.10.2026): a marketplace lists its plugins, one installs into panel-data\\plugins with its skills and MCP servers, replace and remove', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-plugin-'));
  const dataRoot = join(root, 'data');
  const market = join(root, 'market');
  const run = (g, b) => TOOLS.find((t) => t.name === 'install_plugin').run(g, b);
  // a marketplace with a plugin in a subfolder (pluginRoot + a bare name) and one in GitHub
  mkdirSync(join(market, '.claude-plugin'), { recursive: true });
  writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'm', owner: { name: 'x' }, metadata: { pluginRoot: './plugins' }, plugins: [{ name: 'calc', source: 'calc', description: 'Adds numbers' }, { name: 'remote', source: { source: 'github', repo: 'o/r' }, description: 'Elsewhere' }] }));
  const plugin = join(market, 'plugins', 'calc');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'skills', 'sum'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'calc', version: '1.0.0', description: 'Adds numbers' }));
  writeFileSync(join(plugin, 'skills', 'sum', 'SKILL.md'), '---\nname: sum\ndescription: Adds two numbers\n---\nUse collect.');
  writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { adder: { command: process.execPath, args: [FAKE_MCP] } } }));
  const b = { cwd: root, setting: { dataRoot }, full: true, mcp: new McpManager({ aiRoot: root, dataRoot }) };
  try {
    assert.match(await run({ source: market }, b), /2 plugins[\s\S]*- calc: Adds numbers[\s\S]*- remote: Elsewhere/);
    assert.match(await run({ source: market, plugin: 'calc' }, b), /Installed plugin "calc" in .*plugins.calc; skills: sum \(load_skill calc:<skill>\); MCP servers: adder/);
    assert.ok(existsSync(join(dataRoot, 'plugins', 'calc', 'skills', 'sum', 'SKILL.md')), 'copied into the panel');
    assert.deepEqual(findSkills({ aiRoot: root, dataRoot }).map((k) => k.name), ['calc:sum']);
    assert.equal(b.mcp.servers().adder.source, 'plugin:calc');
    assert.deepEqual((await b.mcp.client('adder').toolList()).map((t) => t.name), ['collect'], 'the plugin server runs from the panel folder');
    await assert.rejects(run({ source: market, plugin: 'calc' }, b), /already installed/);
    assert.match(await run({ source: market, plugin: 'calc', replace: true }, b), /Installed plugin "calc"/);
    assert.equal(b.mcp.clients.has('adder'), false, 'a replaced plugin restarts its servers at the next use');
    await assert.rejects(run({ source: join(root, 'nothing-here') }, b), /GitHub address .* or a folder/);
    await assert.rejects(run({ source: root }, b), /No plugin there/);
    assert.equal(TOOLS.find((t) => t.name === 'install_plugin').risk({ source: 'x' }), 'danger');
    assert.deepEqual(githubRepo('https://github.com/anthropics/claude-plugins-official'), { owner: 'anthropics', repo: 'claude-plugins-official', ref: '', folder: '' });
    assert.match(await run({ remove: 'calc' }, b), /Plugin removed/);
    assert.equal(existsSync(join(dataRoot, 'plugins', 'calc')), false);
    assert.equal(b.mcp.servers().adder, undefined);
  } finally {
    b.mcp.closeAll();
  }
});

test('agent end to end: image job from chat (panel_api → wait_job → link), event stream, record, gallery', async () => {
  const o = await agentEnv();
  try {
    const list0 = await o.call('/api/v1/chat');
    assert.equal(list0.json.textModel, true);
    const s = await o.chat({ title: '' });
    assert.equal(s.full, true, 'session opened with the key has full access');
    const eventP = o.events(s.id);
    await eventP.ready;
    const r = await o.send(s.id, 'generate a cat image');
    assert.match(r.response, /^Ready: \/file\/job\/.+image_1\.png/);
    const events = await eventP.list;
    assert.equal(events[0].type, 'status');
    const types = events.map((x) => x.type);
    for (const t of ['message', 'start', 'tool', 'tool_result', 'text', 'done']) assert.ok(types.includes(t), `event yok: ${t} (${types.join(',')})`);
    const tools = events.filter((x) => x.type === 'tool').map((x) => x.name);
    assert.deepEqual(tools, ['panel_api', 'wait_job']);
    // The answer streams in pieces (delta) before the final text
    const deltas = events.filter((x) => x.type === 'delta').map((x) => x.text).join('');
    assert.equal(deltas, events.filter((x) => x.type === 'text').at(-1).text, 'streamed pieces make up the answer');
    // Token use counts while the model writes (estimated prompt at once); the measured numbers come last
    const usage = events.filter((x) => x.type === 'usage');
    assert.ok(usage[0].live && usage[0].run.input > 0, 'live usage before the call ends');
    assert.ok(types.indexOf('usage') < types.indexOf('delta'), 'live usage before the first piece');
    assert.equal(usage.at(-1).live, undefined, 'last usage event is the measured one');
    const result = events.find((x) => x.type === 'tool_result' && x.name === 'wait_job');
    assert.equal(result.extra.outputs.length, 1);
    // the answer's lines for the outputs come with the result (a finished image went through show_image as a web picture)
    const waited = (await o.call(`/api/v1/chat/${s.id}`)).json.chat.messages.find((m) => m.role === 'tool' && m.toolName === 'wait_job');
    assert.match(waited.content, /\nPut these lines in your answer and the outputs show in the chat \(no other tool needed\):\n!\[image 1\]\(\/file\/job\/[^)]+\)$/);
    assert.ok(events.some((x) => x.type === 'progress'), 'progress event while waiting for the job');
    // Kayit: dosya ve ayrinti
    const a = await o.call(`/api/v1/chat/${s.id}`);
    assert.equal(a.json.chat.title, 'generate a cat image');
    assert.deepEqual(a.json.chat.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    assert.equal(a.json.chat.messages[2].extra.job, a.json.chat.messages[4].extra.job);
    assert.ok(existsSync(join(o.p.setting.dataRoot, 'chat', `${s.id}.json`)));
    const g = await o.call('/api/v1/gallery?type=image');
    assert.equal(g.json.gallery.length, 1);
    // Liste ve Kuyruk paneli (gorevler) sohbet bitince bos
    const d = await o.call('/api/v1/status');
    assert.deepEqual(d.json.tasks, []);
    assert.equal((await o.call('/api/v1/chat')).json.chats[0].id, s.id);
    // Gorsel eki (Ctrl+V / surukle): yukleme kaynagi mesaja eklenir, model gorseli gorur
    const png = makePng(64, 64);
    const y = await o.call('/api/v1/uploads/image?name=yapistirilan.png', { method: 'POST', raw: png, type: 'image/png' });
    assert.equal(y.code, 200, JSON.stringify(y.json));
    const r2 = await o.send(s.id, 'what is this', { attachments: [y.json.image.source] });
    assert.equal(r2.response, 'EN: what is this\n[Attachments: ' + y.json.image.source + ' (image) — can be given to tools as "source"] [saw image]');
    // Silme
    assert.equal((await o.call(`/api/v1/chat/${s.id}`, { method: 'DELETE' })).code, 200);
    assert.equal((await o.call(`/api/v1/chat/${s.id}`)).code, 404);
  } finally {
    await o.close();
  }
});

test('stream resume: a chat opened while the answer is being written gets the text so far (details and the first event), the pieces after it complete the answer', async () => {
  // the fake writes a piece every 15 ms (a model writing in real time)
  process.env.FAKE_LLM_STREAM_MS = '15';
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    await o.send(s.id, 'long answer', { wait: false });
    await o.p.waitForState(() => (o.agent.get(s.id).work?.live?.text.length ?? 0) > 40, 20000);
    // the details (the web chat opened again) carry the text written so far
    const detail = (await o.call(`/api/v1/chat/${s.id}`)).json.chat;
    assert.equal(detail.status, 'running');
    assert.match(detail.live.text, /^word0 word1 /);
    // a stream opened now: its first event carries the text so far, the deltas after it are new (nothing twice)
    const eventP = o.events(s.id);
    const events = await eventP.list;
    assert.equal(events[0].type, 'status');
    const head = events[0].chat.live.text;
    assert.ok(head.length >= detail.live.text.length && head.startsWith(detail.live.text), 'the text only grows');
    const final = events.findLast((x) => x.type === 'text').text;
    assert.ok(final.endsWith(' end.') && final.length > head.length, 'opened before the end');
    assert.equal(head + events.filter((x) => x.type === 'delta').map((x) => x.text).join(''), final);
    // finished: nothing is being written
    assert.equal((await o.call(`/api/v1/chat/${s.id}`)).json.chat.live, null);
  } finally {
    delete process.env.FAKE_LLM_STREAM_MS;
    await o.close();
  }
});

// User 08.10.2026: "Çok uzun sürüyor ekran kartı meşgul diyip": the wait names the job and its percent, then the loading
test('a chat waiting for the GPU says which job holds it and how far it is, then that the text model is loading', async () => {
  const o = await agentEnv();
  let busy = true;
  let percent = 20;
  o.llm.gpuBusy = () => busy;
  o.llm.gpuJob = () => (busy ? { typeName: 'Video', percent } : null);
  try {
    const s = await o.chat({});
    const eventP = o.events(s.id);
    await eventP.ready;
    await o.send(s.id, 'hello', { wait: false });
    await new Promise((ok) => setTimeout(ok, 500));
    percent = 64.7;
    await new Promise((ok) => setTimeout(ok, 2500));
    busy = false;
    const shown = (await eventP.list).filter((x) => x.type === 'progress' && x.text).map((x) => x.text);
    assert.deepEqual(shown.slice(0, 3), ['Video job is using the GPU (20%); the answer goes on when it finishes…', 'Video job is using the GPU (64%); the answer goes on when it finishes…', 'Loading the text model…']);
  } finally {
    await o.close();
  }
});

test('thinking: the model\'s reasoning streams as reasoning events, stays with its message and never goes back to the model; the thinking level of a chat sets the budget', async () => {
  // a longer thinking, written in real time, so a stream opened meanwhile finds it in chat.live
  process.env.FAKE_LLM_STREAM_MS = '10';
  process.env.FAKE_LLM_THINK_REPEAT = '30';
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    const eventP = o.events(s.id);
    await eventP.ready;
    const answerP = o.send(s.id, 'think about cats');
    await o.p.waitForState(() => (o.agent.get(s.id).work?.live?.reasoning.length ?? 0) > 30, 20000);
    assert.match((await o.call(`/api/v1/chat/${s.id}`)).json.chat.live.reasoning, /^First I consider cats\. Then I weigh it\./, 'the thinking so far is in the details while it is written');
    assert.equal((await answerP).response, 'Answer after thinking about cats.');
    const thought = `First I consider cats. ${'Then I weigh it. '.repeat(30)}Decided.`;
    const events = await eventP.list;
    assert.equal(events.filter((x) => x.type === 'reasoning').map((x) => x.text).join(''), thought);
    assert.ok(events.findLastIndex((x) => x.type === 'reasoning') < events.findIndex((x) => x.type === 'delta'), 'the thinking comes before the answer');
    assert.equal(events.find((x) => x.type === 'text').reasoning, thought);
    // stored with the message (the chat shows it folded), never sent back to the model
    assert.equal((await o.call(`/api/v1/chat/${s.id}`)).json.chat.messages.at(-1).reasoning, thought);
    assert.ok(!JSON.stringify(await o.agent.translateMessages(o.agent.get(s.id), null)).includes('Then I weigh it'), 'the thinking does not go back to the model');
    // without streaming the answer's reasoning_content is kept too
    o.p.setting.agentStream = false;
    await o.send(s.id, 'think about dogs');
    assert.match(o.agent.get(s.id).messages.at(-1).reasoning, /^First I consider dogs\./);
    o.p.setting.agentStream = true;
    // the level: low by default (1024 tokens); PATCH changes it from the next call, none turns thinking off
    assert.equal((await o.send(s.id, 'which thinking')).response, 'Thinking: on, budget 1024');
    const changed = await o.call(`/api/v1/chat/${s.id}`, { method: 'PATCH', body: { thinking: 'high' } });
    assert.equal(changed.json.chat.thinking, 'high', 'the summary carries the level');
    assert.equal((await o.send(s.id, 'which thinking')).response, 'Thinking: on, budget 8192');
    await o.call(`/api/v1/chat/${s.id}`, { method: 'PATCH', body: { thinking: 'none' } });
    assert.equal((await o.send(s.id, 'which thinking')).response, 'Thinking: off, budget 0');
    assert.equal((await o.chat({ thinking: 'medium' })).thinking, 'medium');
  } finally {
    delete process.env.FAKE_LLM_STREAM_MS;
    delete process.env.FAKE_LLM_THINK_REPEAT;
    await o.close();
  }
});

test('agent access and security: network client restricted, approval flow (denial), text block fallback, shell command, web reading', async () => {
  const o = await agentEnv();
  const site = createServer((_i, y) => { y.writeHead(200, { 'Content-Type': 'text/html' }); y.end('<html><title>Fake site</title><body><p>Hello world</p></body></html>'); });
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
  try {
    // Any device that opens the panel gets file and command access by default (user permission 08.10.2026)
    const open = await o.chat({}, { key: false });
    assert.equal(open.full, true);
    // Settings › Assistant rules turns it off: a browser without the key (local trust off) is restricted
    assert.equal((await o.call('/api/v1/settings', { method: 'PATCH', body: { networkFullAccess: false } })).json.networkFullAccess, false);
    const k = await o.chat({}, { key: false });
    assert.equal(k.full, false);
    // ...and cannot drive the chat that has the tools
    assert.equal((await o.call(`/api/v1/chat/${open.id}/message`, { method: 'POST', body: { text: 'hello' }, key: false })).code, 403);
    const r = await o.send(k.id, 'run command', { key: false });
    assert.match(r.response, /cannot be used in this session/);
    const kDetail = (await o.call(`/api/v1/chat/${k.id}`, { key: false })).json.chat;
    assert.equal(kDetail.messages.find((m) => m.role === 'tool').error, true);
    // Yerel aga web istegi de kisitli oturumda reddedilir
    const rw = await o.send(k.id, `read http://127.0.0.1:${site.address().port}/`, { key: false });
    assert.match(rw.response, /only from a chat opened from this computer/);
    // Tam oturum: komut calisir
    const t = await o.chat({});
    const rk = await o.send(t.id, 'run command');
    assert.match(rk.response, /Output: \[exit code 0/);
    assert.match(rk.response, /hello/);
    // Web okuma (tam oturum): baslik + metin
    const ro = await o.send(t.id, `read http://127.0.0.1:${site.address().port}/`);
    assert.match(ro.response, /# Fake site\nHello world/);
    // Onay: delete_file onay ister; reddedilir -> model "Result" ile bitirir
    const file = join(o.p.root, 'silinecek.txt');
    writeFileSync(file, 'x');
    const eventP = o.events(t.id);
    await eventP.ready;
    const gP = o.send(t.id, `delete ${file}`);
    await o.p.waitForState(() => o.agent.get(t.id).status === 'approval');
    const pending = (await o.call('/api/v1/chat')).json.chats.find((x) => x.id === t.id).approval;
    assert.equal(pending.tool, 'delete_file');
    assert.equal((await o.call(`/api/v1/chat/${t.id}/approval`, { method: 'POST', body: { id: pending.id, yes: false } })).code, 200);
    const rs = await gP;
    assert.match(rs.response, /rejected/);
    assert.ok(existsSync(file), 'denied deletion is not performed');
    const ol = await eventP.list;
    assert.ok(ol.some((x) => x.type === 'approval') && ol.some((x) => x.type === 'approval_done' && x.yes === false));
    // Metin blogu yedegi: model <tool> blogu yazdi, sablon ayristirmadi -> yine calisir
    const rb = await o.send(t.id, 'block write file');
    assert.equal(rb.response, 'Written.');
    assert.equal(readFileSync(join(o.p.setting.aiRoot, 'deneme.txt'), 'utf8'), 'selam');
    const detail = (await o.call(`/api/v1/chat/${t.id}`)).json.chat;
    const blockMessage = detail.messages.find((m) => m.toolCalls?.[0]?.name === 'write_file');
    assert.equal(blockMessage.content, 'Writing the file.');
    // A message while it runs is queued and read at the next step: it lands after the running tool's result
    const midP = o.send(t.id, 'generate a cat image');
    await o.p.waitForState(() => o.agent.get(t.id).status === 'running' && o.agent.get(t.id).step >= 1);
    const mid = await o.call(`/api/v1/chat/${t.id}/message`, { method: 'POST', body: { text: 'and one more thing' } });
    assert.deepEqual([mid.code, mid.json.queued], [200, true]);
    assert.equal((await midP).response, 'EN: and one more thing', 'the model read the queued message in the same run');
    const after = o.agent.get(t.id).messages;
    const at = after.findLastIndex((m) => m.role === 'user');
    assert.equal(after[at].content, 'and one more thing');
    assert.equal(after[at - 1].role, 'tool', 'queued message comes after the tool result, not between the call and its result');
    // Stop with a message waiting (sent while an approval is pending): the run ends "(stopped)" and the waiting
    // message is answered in the next run
    const longP = o.send(t.id, `delete ${file}`);
    await o.p.waitForState(() => o.agent.get(t.id).status === 'approval');
    // The running list shows it: waiting for approval, at its tool, with its step and time
    const running = (await o.call('/api/v1/chat/running')).json.agents;
    assert.deepEqual(running.map((a) => [a.id, a.status, a.tool, a.step]), [[t.id, 'approval', 'delete_file', 1]]);
    assert.ok(running[0].seconds >= 0 && running[0].usage);
    assert.equal((await o.call(`/api/v1/chat/${t.id}/message`, { method: 'POST', body: { text: 'x' } })).json.queued, true);
    assert.equal((await o.call(`/api/v1/chat/${t.id}/stop`, { method: 'POST' })).code, 200);
    const ru = await longP;
    assert.equal(ru.response, '');
    assert.ok(o.agent.get(t.id).messages.some((m) => m.stopped));
    await o.p.waitForState(() => o.agent.get(t.id).status === 'idle' && o.agent.get(t.id).messages.at(-1).content === 'EN: x', 20000);
    assert.deepEqual((await o.call('/api/v1/chat/running')).json.agents, [], 'nothing runs any more');
  } finally {
    site.close();
    await o.close();
  }
});

test('pictures from the web show in the chat, and a message with no clear language keeps the user\'s language', async () => {
  // Hasan asked for a cat photo from Reddit and Pinterest; Gemma said it is text-only and answered in English; later a
  // dog photo request showed a dark portrait from a guessed address (08.10.2026)
  const png = makePng(320, 200);
  const png2 = makePng(640, 400, [200, 120, 40]);
  const png3 = makePng(400, 300, [10, 10, 10]);
  const png4 = makePng(500, 300, [90, 200, 90]);
  let at = '';
  const bingQueries = [];
  const bingItem =(image, title) => `<a class="iusc" m="${JSON.stringify({ murl: image, purl: `${at}/page.html`, t: title }).replace(/"/g, '&quot;')}"></a>`;
  const site = createServer((i, y) => {
    const send = (type, body, code = 200) => {
      y.writeHead(code, { 'Content-Type': type });
      y.end(body);
    };
    const path = i.url.split('?')[0];
    if (path === '/bing') bingQueries.push(new URL(i.url, 'http://x').searchParams.get('q'));
    if (path === '/cat.png') send('image/png', png);
    else if (path === '/cat2.png') send('image/png', png2);
    else if (path === '/dog.png') send('image/png', png3);
    else if (path === '/cat3.png') send('image/png', png4);
    else if (path === '/page.html') send('text/html', `<html><head><title>Cats</title><meta property="og:image" content="/cat.png"></head><body><img src="/logo.svg"><img width="16" height="16" src="/icon.png"><p>Many cats here</p></body></html>`);
    // the image search sources: Bing's page, Openverse and Commons JSON; Brave refuses (it did, 429, 08.10.2026)
    else if (path === '/bing') send('text/html', `<html><body>${bingItem(`${at}/cat.png`, 'A cat')}${bingItem(`${at}/missing.png`, 'A cat, gone')}${bingItem(`${at}/cat3.png`, 'A cat, three')}${bingItem(`${at}/dog.png`, 'A dog')}</body></html>`);
    else if (path === '/openverse') send('application/json', JSON.stringify({ results: [{ url: `${at}/cat2.png`, title: 'cat two', foreign_landing_url: `${at}/page.html`, width: 640, height: 400 }] }));
    else if (path === '/commons') send('application/json', JSON.stringify({ batchcomplete: '' }));
    else if (path === '/brave') send('text/plain', 'slow down', 429);
    else send('text/plain', 'not a picture');
  });
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
  at = `http://127.0.0.1:${site.address().port}`;
  const o = await agentEnv({ agentSearchApis: { bing: `${at}/bing`, brave: `${at}/brave`, openverse: `${at}/openverse`, commons: `${at}/commons` } });
  const from = (job) => o.p.queue.jobs.get(job)?.input?.from;
  try {
    const t = await o.chat({});
    // fetch_web lists the page's pictures (no logo, SVG or tiny icon)
    const read = await o.send(t.id, `read ${at}/page.html`);
    assert.match(read.response, new RegExp(`Images on the page \\(show one in the chat with show_image\\):\\n- ${at}/cat\\.png$`));
    // show_image with an address (an image, or a page's main picture) fetches it into the gallery as a finished image job
    // of the chat; the answer shows it
    const jobs = [];
    const lineJob = (response) => /!\[[^\]]*\]\(\/file\/job\/(\d{8}-\d{6}-image-[0-9a-f]{4})\/web\.png\)/.exec(response)?.[1];
    for (const url of [`${at}/cat.png`, `${at}/page.html`]) {
      const shown = await o.send(t.id, `web photo ${url}`);
      assert.match(shown.response, /^Here it is:\n!\[a cat\]\(\/file\/job\/\d{8}-\d{6}-image-[0-9a-f]{4}\/web\.png\)$/);
      const job = lineJob(shown.response);
      jobs.push(job);
      assert.deepEqual(readFileSync(join(o.p.setting.outputRoot, job, 'web.png')), png);
      const served = await fetch(`${o.p.address}/file/job/${job}/web.png`, { headers: { Authorization: `Bearer ${o.p.settingFile.apiKey}` } });
      assert.deepEqual([served.status, served.headers.get('content-type')], [200, 'image/png']);
    }
    const gallery = (await o.call('/api/v1/gallery')).json.gallery ?? [];
    const item = gallery.find((g) => g.id === jobs[0]);
    // the call asks in Turkish (X-Panel-Lang: tr): the stored "From the web: 127.0.0.1" comes translated
    assert.deepEqual([item?.type, item?.title, item?.detail, item?.outputs?.[0]?.width, item?.outputs?.[0]?.height], ['image', 'a cat', 'Webden: 127.0.0.1', 320, 200]);
    assert.equal(o.p.queue.jobs.get(jobs[0])?.summary?.detail, 'From the web: 127.0.0.1', 'stored in English');
    // the panel's own picture (a job's output, by its /file/ address or by the panel's own host) shows as it is: no fetch,
    // no copy in the gallery
    const galleryCount = (await o.call('/api/v1/gallery')).json.gallery.length;
    for (const own of [`/file/job/${jobs[0]}/web.png`, `${o.p.address}/file/job/${jobs[0]}/web.png`, `job/${jobs[0]}/web.png`]) {
      const r = await o.send(t.id, `web photo ${own}`);
      assert.equal(r.response, `Here it is:\n![a cat](/file/job/${jobs[0]}/web.png)`, own);
    }
    assert.equal((await o.call('/api/v1/gallery')).json.gallery.length, galleryCount);
    const notPicture = await o.send(t.id, `web photo ${at}/text.txt`);
    assert.match(notPicture.response, /^Here it is:\n\(none\) Tool error: Not a picture \(text\/plain\)/);
    // show_image with a query: every source at once, ranked; the vision model checks each picture; a picture the chat
    // showed is not shown again
    const first = await o.send(t.id, 'find photo a cat');
    const second = await o.send(t.id, 'find photo a cat');
    const found = [lineJob(first.response), lineJob(second.response)];
    assert.ok(found.every(Boolean), `${first.response} | ${second.response}`);
    jobs.push(...found);
    assert.deepEqual(found.map(from).sort(), [`${at}/cat2.png`, `${at}/cat3.png`], 'two requests, two different pictures: cat.png was shown already, the gone one is skipped');
    // nothing that shows it: the vision model said no to every picture
    const dog = await o.send(t.id, 'find photo a dog');
    assert.match(dog.response, /^Here it is:\n\(none\) Tool error: No picture found that shows "a dog" \(sources: bing 4 results, brave error: HTTP 429, openverse 1 results, commons 0 results\); tried: /);
    // a search in another language goes out in English, by the chat's model ("kedi" found a road sign of the Georgian
    // village Zemo Kedi, 08.10.2026); the vision check gets the English words too
    const turkish = await o.send(t.id, 'find photo köpek');
    assert.match(turkish.response, /^Here it is:\n\(none\) Tool error: No picture found that shows "köpek" \(searched as "Dog"\) \(sources: bing 4 results/);
    assert.equal(bingQueries.at(-1), 'Dog');
    assert.ok(!bingQueries.includes('köpek'));
    // an answer that shows other sites' pictures without show_image: the agent fetches them into the gallery and the
    // answer shows the panel's copies (an address with a slash after the extension too); a picture that is not there is
    // replaced by one found for its caption
    const own = await o.send(t.id, `answer pictures ${at}/cat.png/ ${at}/missing.png`);
    const owned = [...own.response.matchAll(/!\[picture \d\]\(\/file\/job\/(\d{8}-\d{6}-image-[0-9a-f]{4})\/web\.png\)/g)].map((m) => m[1]);
    assert.equal(owned.length, 2, own.response);
    assert.match(own.response, /^Look:\n!\[picture 1\]\(\/file\/job\/[^)]+\)\n!\[picture 2\]\(\/file\/job\/[^)]+\)$/);
    assert.deepEqual(owned.map(from), [`${at}/cat.png`, `${at}/dog.png`], 'the gone picture is replaced by the one picture left that the chat did not show');
    jobs.push(...owned);
    assert.deepEqual((await o.call(`/api/v1/chat/${t.id}`)).json.chat.createdJobs.sort(), [...jobs].sort(), 'the pictures are jobs the chat produced');
    // deleting the chat with what it produced deletes the pictures; without, they stay in the gallery (user request
    // 08.10.2026: a tick box in the delete dialog)
    const other = await o.chat({});
    const otherJob = lineJob((await o.send(other.id, `web photo ${at}/cat.png`)).response);
    const keptChat = await o.call(`/api/v1/chat/${other.id}?keepOutputs=1`, { method: 'DELETE' });
    assert.deepEqual([keptChat.code, keptChat.json.message], [200, 'Chat deleted. What it produced stays in the gallery.']);
    assert.ok(existsSync(join(o.p.setting.outputRoot, otherJob, 'web.png')));
    const removed = await o.call(`/api/v1/chat/${t.id}`, { method: 'DELETE' });
    assert.deepEqual([removed.code, removed.json.deletedJobs, removed.json.message], [200, jobs.length, `Chat deleted, with ${jobs.length} jobs it created.`]);
    assert.ok(jobs.every((j) => !existsSync(join(o.p.setting.outputRoot, j, 'web.png'))));
    assert.deepEqual((await o.call('/api/v1/gallery')).json.gallery.map((g) => g.id), [otherJob]);
    // the language marker: a Turkish message without Turkish letters is Turkish; a message with no clear language takes
    // the language before it; the agent's own (English) notes do not change it
    const lang = await o.chat({});
    assert.match((await o.send(lang.id, 'lang emin misin')).response, /written in Turkish: answer in Turkish\]?$/);
    assert.match((await o.send(lang.id, 'lang pinterst')).response, /written in Turkish: answer in Turkish\]?$/);
    assert.match((await o.send(lang.id, 'lang show me the cats')).response, /written in English: answer in English\]?$/);
    assert.match((await o.send(lang.id, 'lang pinterst')).response, /written in English: answer in English\]?$/);
  } finally {
    site.close();
    await o.close();
  }
});

test('agent resources: MCP server, skill, memory, scheduling, sub-agent, image viewing, OpenAI-compatible nedese-agent', async () => {
  const o = await agentEnv();
  try {
    const info = (await o.call('/api/v1/chat/tools')).json;
    assert.ok(info.tools.some((a) => a.name === 'panel_api' && !a.full) && info.tools.some((a) => a.name === 'run_command' && a.full && a.approval));
    assert.deepEqual(info.approvalModes, ['manual', 'edits', 'auto', 'plan']);
    assert.deepEqual(info.mcp.map((m) => m.name), ['fake']);
    assert.deepEqual(info.skills.map((b) => b.name), ['deneme-beceri']);
    assert.equal(info.readsImages, true);
    const s = await o.chat({ agent: true });
    // MCP: mcp_tools -> call_mcp collect(2,3) = 5; gorsel eki diske yazilir
    const rm = await o.send(s.id, 'mcp add');
    assert.match(rm.response, /^Total: 5\nImages \(can be viewed with look_image\): .+\.png$/);
    // Beceri govdesi + ek dosya listesi
    const rb = await o.send(s.id, 'load skill');
    assert.match(rb.response, /Skill: deneme-beceri[\s\S]*Extra files \(with read_file\): ek\.md[\s\S]*Adım 1: merhaba de\./);
    // Hafiza: dosyaya yazilir, sistem istemine girer
    const rh = await o.send(s.id, 'memory');
    assert.match(rh.response, /Note saved as n1 \(1 note\)/);
    assert.match(readFileSync(join(o.p.setting.dataRoot, 'chat', 'memory.md'), 'utf8'), /^- \[n1\] \d{4}-\d\d-\d\d: the user likes cats\n$/);
    assert.match(o.agent.systemPrompt(o.agent.get(s.id), o.agent.tools(o.agent.get(s.id))), /Your persistent notes \(update_memory and delete_memory take the id in brackets\):\n- \[n1\] [\d-]+: the user likes cats/);
    assert.equal(o.agent.deleteMemory('cats'), 'Note n1 deleted (0 left).');
    // Scheduling from a chat: when due, the same chat goes on with the task, which knows its schedule id (user request
    // 09.10.2026; a new "⏰" chat each time with same_chat: false, test/background.test.mjs)
    const rz = await o.send(s.id, 'schedule');
    assert.match(rz.response, /Scheduled/);
    const z = o.agent.schedules();
    assert.equal(z.length, 1);
    assert.equal(z[0].chat, s.id);
    z[0].time = new Date(Date.now() - 1000).toISOString();
    o.agent.writeSchedules(z);
    await o.agent.processSchedules();
    assert.equal(o.agent.schedules().length, 0, 'one-off schedule removed');
    await o.p.waitForState(() => o.agent.get(s.id).status === 'idle' && o.agent.get(s.id).messages.at(-1).content === `EN: [schedule ${z[0].id}] say hello`);
    assert.ok(!o.agent.list().chats.some((x) => x.title.startsWith('⏰')), 'no new chat');
    // Alt ajan: ayri oturum, ust sonucu alir
    const ra = await o.send(s.id, 'subtask: count apples');
    assert.match(ra.response, /^Parent: \[sub-agent \w+ done\]\nEN: count apples$/);
    const sub = o.agent.list().chats.find((x) => x.parent === s.id);
    assert.ok(sub && sub.full && sub.approvalMode === 'edits');
    // Gorsel bakma: galerideki gorsele soru (ffmpeg varsa kucultulur)
    const png = makePng(32, 32);
    const y = await o.call('/api/v1/uploads/image?name=bak.png', { method: 'POST', raw: png, type: 'image/png' });
    const rg = await o.send(s.id, `look ${y.json.image.source}`);
    assert.match(rg.response, /Result \(look_image\): Fake image answer: \d+ bytes, question: What is there\?/);
    // OpenAI uyumlu: model nedese-agent, gecici oturum silinir
    const once = o.agent.list().total;
    const r = await fetch(`${o.p.address}/llm/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.p.settingFile.apiKey}` }, body: JSON.stringify({ model: 'nedese-agent', messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'EN: hi' }, { role: 'user', content: 'run command' }] }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.model, 'nedese-agent');
    assert.match(j.choices[0].message.content, /^Output: \[exit code 0/);
    assert.equal(j.nedese.step, 1);
    assert.equal(o.agent.list().total, once, 'temporary session deleted');
    assert.ok(j.usage.total_tokens > 0, 'token usage reported');
    const models = await (await fetch(`${o.p.address}/llm/v1/models`, { headers: { Authorization: `Bearer ${o.p.settingFile.apiKey}` } })).json();
    assert.ok(models.data.some((m) => m.id === 'nedese-agent'));
    // Var olan sohbeti surdurme (metadata.chat): kalici
    const r2 = await fetch(`${o.p.address}/llm/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.p.settingFile.apiKey}` }, body: JSON.stringify({ model: 'nedese-agent', metadata: { chat: s.id }, messages: [{ role: 'user', content: 'how are you' }] }) });
    assert.equal((await r2.json()).nedese.chat, s.id);
    assert.equal(o.agent.get(s.id).messages.at(-1).content, 'EN: how are you');
  } finally {
    await o.close();
  }
});

test('/llm/v1 streaming: stream: true relays the model\'s events (plain completions) and streams the agent\'s text as chunks (nedese-agent); without stream the answers are as before', async () => {
  // the fake model writes in real time (a client can leave in the middle)
  process.env.FAKE_LLM_STREAM_MS = '20';
  const o = await agentEnv();
  const post = (body) => fetch(`${o.p.address}/llm/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.p.settingFile.apiKey}` }, body: JSON.stringify(body) });
  const events = async (r) => (await r.text()).split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => b.slice(6)).map((d) => (d === '[DONE]' ? d : JSON.parse(d)));
  try {
    // plain completion: the model's pieces in order, its finish and usage (asked for), then [DONE]
    const r = await post({ messages: [{ role: 'user', content: 'tell me a long story about streams' }], stream: true, stream_options: { include_usage: true } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const list = await events(r);
    assert.equal(list.at(-1), '[DONE]');
    const pieces = list.slice(0, -1).map((j) => j.choices?.[0]?.delta?.content ?? '').filter(Boolean);
    assert.ok(pieces.length > 3, `several pieces: ${pieces.length}`);
    assert.equal(pieces.join(''), 'EN: tell me a long story about streams');
    assert.equal(list.filter((j) => j !== '[DONE]' && j.choices?.[0]?.finish_reason === 'stop').length, 1);
    assert.deepEqual(list.at(-2).usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    // an error before the first event is the usual JSON error with its status
    const bad = await post({ messages: [{ role: 'user', content: 'TOO LONG FOR CONTEXT' }], stream: true });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /exceeds the available context size/);
    // without stream: one JSON answer, as before
    assert.equal((await (await post({ messages: [{ role: 'user', content: 'hello' }] })).json()).choices[0].message.content, 'EN: hello');
    // nedese-agent: each step's text as it is written (a blank line between steps), then the finish, usage and nedese
    const once = o.agent.list().total;
    const a = await post({ model: 'nedese-agent', messages: [{ role: 'user', content: 'check then run' }], stream: true });
    assert.equal(a.status, 200);
    const chunks = await events(a);
    assert.equal(chunks.at(-1), '[DONE]');
    assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
    const said = chunks.slice(0, -1).map((j) => j.choices[0].delta.content ?? '').join('');
    assert.match(said, /^Let me check first\.\n\nOutput: \[exit code 0[^\n]*\n[\s\S]*hello/);
    const end = chunks.at(-2);
    assert.deepEqual([end.object, end.model, end.choices[0].finish_reason, end.nedese.step], ['chat.completion.chunk', 'nedese-agent', 'stop', 1]);
    assert.ok(end.usage.total_tokens > 0, 'token usage reported');
    assert.ok(chunks.slice(0, -1).every((j) => j.id === end.id), 'one id for the whole answer');
    assert.equal(o.agent.list().total, once, 'temporary session deleted');
    // the same without stream: the final answer alone
    assert.match((await (await post({ model: 'nedese-agent', messages: [{ role: 'user', content: 'check then run' }] })).json()).choices[0].message.content, /^Output: \[exit code 0/);
    // a client that goes away mid-answer stops the agent; its temporary chat goes
    const control = new AbortController();
    const away = await fetch(`${o.p.address}/llm/v1/chat/completions`, { method: 'POST', signal: control.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.p.settingFile.apiKey}` }, body: JSON.stringify({ model: 'nedese-agent', messages: [{ role: 'user', content: 'long answer 1000' }], stream: true }) });
    const reader = away.body.getReader();
    let got = '';
    while (!/word1 /.test(got)) got += Buffer.from((await reader.read()).value ?? []).toString('utf8');
    control.abort();
    const left = Date.now();
    // the whole answer takes ~18 s at this pace: it ends long before
    await o.p.waitForState(() => o.agent.list().total === once && !o.agent.running().length, 15000);
    assert.ok(Date.now() - left < 5000, `stopped and deleted soon after the client left (${Date.now() - left} ms)`);
  } finally {
    delete process.env.FAKE_LLM_STREAM_MS;
    await o.close();
  }
});

test('lasting notes: ids, update and search, delete by id (a text deletes one note only), an older file gets ids, the prompt has the newest whole notes and the count of older ones', async () => {
  const o = await agentEnv();
  try {
    const a = o.agent;
    const file = join(o.p.setting.dataRoot, 'chat', 'memory.md');
    // an older file: dated lines without ids, and one written by hand
    writeFileSync(file, '- 2026-10-01: the user likes cats\n- 2026-10-02: outputs go to D:\\renders\n- write short answers\n');
    assert.deepEqual(a.notes().map((n) => [n.id, n.date, n.text]), [['n1', '2026-10-01', 'the user likes cats'], ['n2', '2026-10-02', 'outputs go to D:\\renders'], ['n3', '', 'write short answers']]);
    assert.equal(readFileSync(file, 'utf8'), '- [n1] 2026-10-01: the user likes cats\n- [n2] 2026-10-02: outputs go to D:\\renders\n- [n3] write short answers\n', 'the ids are written into the file');
    assert.equal(a.addMemory('the user likes  dogs too'), 'Note saved as n4 (4 notes).');
    assert.equal(a.updateMemory('n2', 'outputs go to E:\\renders'), 'Note n2 updated.');
    assert.deepEqual(a.notes().map((n) => n.id), ['n1', 'n3', 'n4', 'n2'], 'an updated note counts as the newest');
    assert.throws(() => a.updateMemory('n9', 'x'), /No note n9/);
    // search: every word (case and accents do not matter), by id, all
    assert.equal(a.searchMemory({ query: 'LİKES cats' }), `2 of 4 notes:\n- [n1] 2026-10-01: the user likes cats\n${noteLine(a.notes()[2])}`);
    assert.equal(a.searchMemory({ id: 'n3' }), '1 of 4 notes:\n- [n3] write short answers');
    assert.match(a.searchMemory({ query: 'zebra' }), /^No note matches "zebra" \(4 notes in all\)\.$/);
    assert.equal(a.searchMemory().split('\n').length, 5);
    // delete: by id; a text names one note only (it used to delete every line containing it)
    assert.throws(() => a.deleteMemory('likes'), /"likes" is in 2 notes; delete them one by one by id/);
    assert.equal(a.notes().length, 4, 'nothing deleted');
    assert.equal(a.deleteMemory('n1'), 'Note n1 deleted (3 left).');
    assert.throws(() => a.deleteMemory('n1'), /No note n1/);
    // through the tools: delete_memory with the older "text" input, update_memory, search_memory
    const s = a.create({ full: true });
    const run = (name, input) => a.runTool(s, { name, input }, a.tools(s), new AbortController().signal);
    assert.equal((await run('delete_memory', { text: 'short answers' })).text, 'Note n3 deleted (2 left).');
    assert.equal((await run('update_memory', { id: 'n4', note: 'the user likes dogs' })).text, 'Note n4 updated.');
    assert.match((await run('search_memory', { query: 'dogs' })).text, /^1 of 2 notes:\n- \[n4\] [\d-]+: the user likes dogs$/);
    // the prompt: 120 more notes do not fit in 4000 characters; the newest whole ones go in, oldest first, and the
    // count of the others (they used to be cut mid-line and drop out silently)
    for (let i = 0; i < 120; i++) a.addMemory(`note number ${i} ${'x'.repeat(60)}`);
    const prompt = a.systemPrompt(s, a.activeTools(s));
    const block = prompt.slice(prompt.indexOf('Your persistent notes'));
    const lines = block.split('\n').filter((l) => l.startsWith('- ['));
    assert.ok(lines.every((l) => /^- \[n\d+\] [\d-]+: note number \d+ x{60}$/.test(l)), 'whole notes only');
    assert.match(lines.at(-1), /^- \[n124\] [\d-]+: note number 119 /, 'the newest note last');
    assert.ok(lines.join('\n').length <= 4000);
    const older = /\n\[(\d+) older notes are not shown here: search_memory finds them\]/.exec(block);
    assert.equal(Number(older?.[1]) + lines.length, 122);
  } finally {
    await o.close();
  }
});

test('agent: falls back to <tool> block mode if the template does not support tool calls; when the context fills up old tool outputs are truncated and summarized', async () => {
  process.env.NO_FAKE_LLM_TOOL = '1';
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    const r = await o.send(s.id, 'write hello file');
    assert.equal(r.response, 'Written.');
    assert.equal(o.agent.nativeTool, false);
    assert.equal(readFileSync(join(o.p.setting.aiRoot, 'yazilan.txt'), 'utf8'), 'hello file');
    assert.match(o.agent.systemPrompt(o.agent.get(s.id), o.agent.tools(o.agent.get(s.id))), /<tool>\{"name"/);
    // Baglam: kucuk pencere; 12 uzun arac ciktisi -> eskiler kirpilir, yetmezse ilk yari ozetlenir
    o.llm.context = 8192;
    const b = o.agent.create({ full: true });
    const long = 'x'.repeat(20000);
    const t = (i) => ({ role: 'tool', toolId: `c${i}`, toolName: 'read_file', content: long, time: new Date().toISOString() });
    b.messages.push({ role: 'user', content: 'first', attachments: [] }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', input: {} }] }, ...[1, 2, 3, 4, 5].map(t), { role: 'user', content: 'second', attachments: [] }, { role: 'assistant', content: '', toolCalls: [{ id: 'c6', name: 'read_file', input: {} }] }, ...[6, 7, 8, 9, 10].map(t));
    await o.agent.contextFit(b, new AbortController().signal);
    // The last 2 tool outputs stay whole, all older ones are trimmed (one turn of many large reads filled the window);
    // when that is not enough the first half (up to the last user message) is summarized
    assert.ok([2, 3, 4, 5, 6, 9, 10, 11].every((i) => b.messages[i].truncated), 'old tool outputs truncated');
    assert.ok(b.messages.slice(12).every((m) => !m.truncated), 'latest tool outputs intact');
    assert.ok(b.trimmed >= 7 && b.summary.length > 0, `summarized (trimmed ${b.trimmed})`);
    const translated = await o.agent.translateMessages(b, null);
    assert.ok(translated.every((m) => m.content.length <= 21000) && translated.length < 12);
  } finally {
    delete process.env.NO_FAKE_LLM_TOOL;
    await o.close();
  }
});

test('context fallback: when the summary fails the oldest turns leave the context (the latest request stays; the model and the user are told), a long task loses its oldest steps whole; the summary input is cut by the summarizer\'s room', async () => {
  // How long a message may be in the summary input: short ones whole, the long ones share the rest (at least 300)
  assert.equal(summaryCut([100, 200, 5000, 9000], 6000), 2850);
  assert.equal(summaryCut([10, 20], 1000), null, 'everything fits whole');
  assert.equal(summaryCut([5000], 100), 300);
  const o = await agentEnv();
  const signal = new AbortController().signal;
  const events = [];
  const listen = (e) => e.type === 'left_out' && events.push(e);
  o.agent.events.on('event', listen);
  try {
    // sizes from this chat's room (the context budget less the instructions and tools that always go)
    const room = (s) => {
      const active = o.agent.activeTools(s);
      return o.agent.contextBudget() - Math.ceil(o.agent.systemPrompt(s, active).length / 3) - Math.ceil(JSON.stringify(o.agent.toolSchemas(active)).length / 3);
    };
    const now = () => new Date().toISOString();
    // A) three long turns and a new request; the summary fails ("SUMMARY FAILS" in the first request): the first turn
    // leaves the context, the latest request stays
    const a = o.agent.create({ full: true });
    const big = 'y'.repeat(Math.floor(room(a) * 0.4) * 3);
    a.messages.push({ role: 'user', content: 'old request SUMMARY FAILS', attachments: [], time: now() }, { role: 'assistant', content: big, time: now() }, { role: 'user', content: 'second request', attachments: [], time: now() }, { role: 'assistant', content: big, time: now() }, { role: 'user', content: 'third request', attachments: [], time: now() }, { role: 'assistant', content: big, time: now() }, { role: 'user', content: 'latest request', attachments: [], time: now() });
    await o.agent.contextFit(a, signal);
    assert.equal(a.trimmed, 2, 'the first turn left the context');
    assert.match(a.summary, /^\[2 earlier messages were left out to fit the context window \(they could not be summarized\); ask the user if something from them is needed\.\]$/);
    const sentA = await o.agent.translateMessages(a, null);
    assert.equal(sentA[0].role, 'user', 'the conversation still starts with a user turn');
    assert.match(sentA.at(-1).content, /^latest request/);
    assert.deepEqual([a.messages.at(-1).role, a.messages.at(-1).kind], ['note', 'left-out'], 'the user sees a note');
    assert.equal(a.messages.length, 8, 'the messages stay in the chat');
    assert.deepEqual(events.filter((e) => e.chat === a.id).map((e) => e.count), [2]);
    // the chat goes on: the next request fits and is answered
    assert.equal((await o.send(a.id, 'go on')).response, 'EN: go on');
    assert.equal(a.trimmed, 2);
    // B) one long task from one request: its oldest steps leave whole (a call with its result), the last ones stay
    const b = o.agent.create({ full: true });
    const step = 'z'.repeat(Math.floor(room(b) * 0.3) * 3);
    b.messages.push({ role: 'user', content: 'one long task SUMMARY FAILS', attachments: [], time: now() });
    for (let i = 1; i <= 5; i++) b.messages.push({ role: 'assistant', content: `step ${i} ${step}`, toolCalls: [{ id: `s${i}`, name: 'list_file', input: { path: '.' } }], time: now() }, { role: 'tool', toolId: `s${i}`, toolName: 'list_file', content: `listing ${i}`, time: now() });
    await o.agent.contextFit(b, signal);
    assert.equal(b.trimmed, 0, 'the request stays');
    assert.deepEqual(b.messages.slice(1, 11).map((m) => Boolean(m.dropped)), [true, true, true, true, false, false, false, false, false, false], 'steps 1 and 2 left out with their results');
    const sentB = await o.agent.translateMessages(b, null);
    assert.match(sentB[0].content, /^one long task/);
    assert.deepEqual(sentB.slice(1).map((m) => m.role), ['assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool']);
    assert.equal(sentB[1].tool_calls[0].id, 's3');
    assert.equal(sentB[2].tool_call_id, 's3', 'each result follows its call');
    assert.match(b.summary, /^\[4 earlier messages were left out/);
    // C) the summary input: a long answer goes whole when the summarizer has room (it was cut at 1500 characters)
    const c = o.agent.create({ full: true });
    c.messages.push({ role: 'user', content: 'write a long text', attachments: [], time: now() }, { role: 'assistant', content: 'w'.repeat(6000), time: now() });
    assert.equal(await o.agent.summarize(c, 2, signal), true);
    assert.equal(c.summary, `- summary of ${'USER: write a long text\n'.length + 'ASSISTANT: '.length + 6000} characters, longest line ${'ASSISTANT: '.length + 6000}`);
  } finally {
    o.agent.events.off('event', listen);
    await o.close();
  }
});

test('approval modes: risk classes, read-only commands, panel API risk', () => {
  for (const c of ['dir', 'Get-ChildItem C:\\x -Recurse | Select-Object Name', 'git status', 'git log --oneline -5', 'git -C C:\\repo diff', 'nvidia-smi', 'nvidia-smi --query-gpu=memory.used --format=csv', 'python --version', 'pip list', 'cat a.txt | grep x', 'type a.txt', 'echo hello', 'git branch -a', 'Get-Content log.txt -Tail 20 2>&1']) assert.ok(isReadOnlyCommand(c), `read-only: ${c}`);
  for (const c of ['python x.py', 'npm install', 'echo x > a.txt', 'Get-ChildItem | ForEach-Object { $_ }', 'dir; .\\setup.exe', 'git commit -m x', 'git branch new-branch', 'git tag -d v1', 'nvidia-smi -pl 100', 'node -e "1"', 'Set-Content a.txt x', '$(rm x)', 'Get-Content a | Out-File b', 'curl -o x http://y', '& "C:\\x.exe"', 'git diff --output=x.patch']) assert.ok(!isReadOnlyCommand(c), `not read-only: ${c}`);
  assert.equal(commandRisk('Remove-Item x'), 'danger');
  assert.equal(commandRisk('python x.py'), 'change');
  assert.equal(commandRisk('git status'), null);
  assert.equal(panelApiRisk('GET', '/gallery'), null);
  assert.equal(panelApiRisk('POST', '/jobs'), null);
  assert.equal(panelApiRisk('POST', '/api/v1/jobs'), null);
  assert.equal(panelApiRisk('POST', '/models/downloads'), 'change');
  assert.equal(panelApiRisk('DELETE', '/jobs/x'), 'danger');
  assert.equal(panelApiRisk('PATCH', '/settings'), 'danger');
  // manual asks for every change, edits only for irreversible actions, auto never
  assert.deepEqual(['manual', 'edits', 'auto'].map((m) => [needsApproval(m, 'change'), needsApproval(m, 'danger'), needsApproval(m, null)]), [[true, true, false], [false, true, false], [false, false, false]]);
  assert.equal(searchFold('IŞIK Çağrı İstanbul'), 'isik cagri istanbul');
  assert.equal(searchQuery('Bursa  hava-durumu'), '"bursa"* "hava"* "durumu"*');
  assert.equal(searchQuery('  ,. '), null);
});

test('chat settings while running: approval modes (pending approval accepted on Automatic), per-chat text model, token usage', async () => {
  const o = await agentEnv();
  try {
    // edits (default): file writing runs without asking
    const s = await o.chat({});
    assert.equal(s.approvalMode, 'edits');
    assert.equal((await o.send(s.id, 'write edits mode')).response, 'Written.');
    // manual: writing waits; switching to auto while it waits approves it and the work goes on
    assert.equal((await o.call(`/api/v1/chat/${s.id}`, { method: 'PATCH', body: { approvalMode: 'manual' } })).json.chat.approvalMode, 'manual');
    const eventP = o.events(s.id);
    await eventP.ready;
    const gP = o.send(s.id, 'write manual mode');
    await o.p.waitForState(() => o.agent.get(s.id).status === 'approval');
    const pending = (await o.call(`/api/v1/chat/${s.id}`)).json.chat.approval;
    assert.equal(pending.tool, 'write_file');
    assert.equal(pending.risk, 'change');
    assert.equal((await o.call(`/api/v1/chat/${s.id}`, { method: 'PATCH', body: { approvalMode: 'auto' } })).code, 200);
    assert.equal((await gP).response, 'Written.');
    assert.equal(readFileSync(join(o.p.setting.aiRoot, 'yazilan.txt'), 'utf8'), 'manual mode');
    const events = await eventP.list;
    assert.ok(events.some((x) => x.type === 'approval_done' && x.yes === true && x.auto === true), 'approved by the mode change');
    assert.ok(events.some((x) => x.type === 'update' && x.summary.approvalMode === 'auto'));
    // Token usage: per run in events, chat total in the summary
    assert.ok(events.some((x) => x.type === 'usage' && x.run.input > 0 && x.total.input >= x.run.input));
    assert.ok(o.agent.summary(s.id).usage.input > 0);
    assert.equal((await o.call(`/api/v1/chat/${s.id}`, { method: 'PATCH', body: { approvalMode: 'never' } })).code, 400);
    // Older clients: unattended true = auto
    assert.equal((await o.chat({ unattended: true })).approvalMode, 'auto');
    // Text model per chat: listed, used, changeable; a missing file is refused
    const list = (await o.call('/api/v1/chat')).json;
    assert.deepEqual(list.models.map((m) => m.file), ['a.gguf', 'b.gguf']);
    assert.equal(list.defaultModel, 'a.gguf');
    const m = await o.chat({ model: 'b.gguf' });
    assert.equal(m.model, 'b.gguf');
    assert.equal((await o.send(m.id, 'which model')).response, 'Model: b.gguf');
    assert.equal(o.llm.status().loaded, 'b.gguf');
    assert.equal((await o.call(`/api/v1/chat/${m.id}`, { method: 'PATCH', body: { model: '' } })).json.chat.model, null);
    assert.equal((await o.send(m.id, 'which model again')).response, 'Model: a.gguf');
    // The clock rides on each user message (it does not change later); the system prompt keeps only the date, so
    // llama-server can reuse the processed prompt from call to call
    assert.match((await o.send(m.id, 'when did I send this')).response, /^Sent: \d{1,2} \w{3} \d{4}, \d\d:\d\d · written in English: answer in English; clock in the system prompt: no$/);
    // the language of the message rides with it (a Turkish message: answer in Turkish)
    const tr = (await o.agent.translateMessages({ ...o.agent.get(m.id), messages: [{ role: 'user', content: 'Bursa’da hava nasıl?', attachments: [], time: new Date().toISOString() }], trimmed: 0 }, null)).at(-1).content;
    assert.match(tr, /written in Turkish: answer in Turkish\]$/);
    assert.equal((await o.call(`/api/v1/chat/${m.id}`, { method: 'PATCH', body: { model: 'nope.gguf' } })).code, 400);
    assert.equal((await o.call('/api/v1/chat', { method: 'POST', body: { model: 'nope.gguf' } })).code, 400);
  } finally {
    await o.close();
  }
});

test('search_chats: the assistant finds earlier chats (best match first, its own chat left out) and reads one in short form; the chat search can sort by relevance', async () => {
  const o = await agentEnv();
  try {
    // Two chats with both words: "paint" has them in its title, "later" only in a later message (and is newer)
    const paint = await o.chat({});
    await o.send(paint.id, 'turquoise paint for the cats room');
    const later = await o.chat({});
    await o.send(later.id, 'hello there');
    await o.send(later.id, 'are turquoise cats real?');
    const other = await o.chat({});
    await o.send(other.id, 'only turquoise here');
    // API: newest first by default; sort=relevance puts the title hit first; relevance pages by count
    const q = encodeURIComponent('turquoise cats');
    assert.deepEqual((await o.call(`/api/v1/chat?q=${q}`)).json.chats.map((c) => c.id), [later.id, paint.id]);
    const best = (await o.call(`/api/v1/chat?q=${q}&sort=relevance`)).json;
    assert.deepEqual([best.chats.map((c) => c.id), best.total], [[paint.id, later.id], 2]);
    const page1 = (await o.call(`/api/v1/chat?q=${q}&sort=relevance&limit=1`)).json;
    assert.deepEqual([page1.chats.map((c) => c.id), page1.next], [[paint.id], '@1']);
    const page2 = (await o.call(`/api/v1/chat?q=${q}&sort=relevance&limit=1&after=${encodeURIComponent(page1.next)}`)).json;
    assert.deepEqual([page2.chats.map((c) => c.id), page2.next], [[later.id], null]);
    assert.equal((await o.call(`/api/v1/chat?q=${q}&sort=oldest`)).code, 400);
    // The tool: the chat that searches has the words too, but is left out; ids, titles and the line around the match
    const asking = await o.chat({});
    const found = (await o.send(asking.id, 'search my chats for turquoise cats')).response;
    assert.match(found, /^Chats: 2 of 2 chats, best match first \(read one: search_chats with its id\):\n/);
    const ids = [...found.matchAll(/^- (\S+) · /gm)].map((m) => m[1]);
    assert.deepEqual(ids, [paint.id, later.id], found);
    assert.match(found, new RegExp(`- ${later.id} · \\d{4}-\\d\\d-\\d\\d · hello there · 4 messages\\n  are turquoise cats real\\?`));
    assert.match((await o.send(asking.id, 'search my chats for violet')).response, /^Chats: No other chat has all of: violet\./);
    // Reading one: who said what, numbered; start continues a long chat
    const read = (await o.send(asking.id, `open chat ${later.id}`)).response;
    assert.equal(read, `Chats: Chat ${later.id} · hello there · ${o.agent.get(later.id).creation.slice(0, 10)} · messages 1-4 of 4\n[1] user: hello there\n[2] assistant: EN: hello there\n[3] user: are turquoise cats real?\n[4] assistant: EN: are turquoise cats real?`);
    assert.match((await o.send(asking.id, `open chat ${later.id} from 3`)).response, /messages 3-4 of 4\n\[3\] user: are turquoise cats real\?/);
    assert.match((await o.send(asking.id, 'open chat nosuchchat')).response, /No chat with id "nosuchchat"/);
    // a deferred tool: a new chat has it under More tools, not with every request; once used it stays in the chat
    const fresh = (await o.send((await o.chat({})).id, 'which tools')).response;
    assert.match(fresh, /More tools .*earlier chats \(search and read them\): search_chats/);
    assert.doesNotMatch(fresh.split(' | ')[0], /search_chats/);
    assert.match((await o.send(asking.id, 'which tools')).response.split(' | ')[0], /search_chats/);
  } finally {
    await o.close();
  }
});

test('chat list from the DB: pages, search (Turkish letters, excerpt), compact, delete with the jobs it created', async () => {
  const o = await agentEnv();
  try {
    // 34 chats + 1 with a Turkish message; pages of 30 newest first
    for (let i = 0; i < 34; i++) o.agent.create({ title: `Chat ${String(i).padStart(2, '0')}`, full: true });
    const t = await o.chat({});
    await o.send(t.id, 'Bursa için IŞIK ve hava durumu');
    const first = (await o.call('/api/v1/chat?limit=30')).json;
    assert.equal(first.total, 35);
    assert.equal(first.chats.length, 30);
    assert.equal(first.chats[0].id, t.id, 'latest activity first');
    assert.ok(first.next);
    const second = (await o.call(`/api/v1/chat?limit=30&after=${encodeURIComponent(first.next)}`)).json;
    assert.equal(second.chats.length, 5);
    assert.equal(second.next, null);
    assert.equal(new Set([...first.chats, ...second.chats].map((c) => c.id)).size, 35, 'no chat twice');
    // Search: case, accents and dotless i do not matter; word starts; excerpt from the message
    const hit = (await o.call(`/api/v1/chat?q=${encodeURIComponent('isik bur')}`)).json;
    assert.deepEqual(hit.chats.map((c) => c.id), [t.id]);
    assert.match(hit.chats[0].match, /IŞIK/);
    assert.equal((await o.call('/api/v1/chat?q=chat%2007')).json.chats[0].title, 'Chat 07');
    assert.equal((await o.call('/api/v1/chat?q=zzzz')).json.total, 0);
    // Listed from panel.db (indexed), not by reading every chat file
    assert.equal(o.p.queue.db.chatCount(), 35);
    // Compact: the conversation leaves the model context, the messages stay; the context gauge drops at once
    o.agent.get(t.id).contextTokens = 25000;
    const contextEvents = [];
    const listen = (e) => e.chat === t.id && e.type === 'context' && contextEvents.push(e);
    o.agent.events.on('event', listen);
    const c = await o.call(`/api/v1/chat/${t.id}/compact`, { method: 'POST' });
    o.agent.events.off('event', listen);
    assert.equal(c.code, 200, JSON.stringify(c.json));
    // like Claude Code: the gauge counts the conversation only (not the instructions, tools or summary): 0 after compact
    assert.ok(c.json.chat.context.used === 0 && contextEvents.at(-1)?.used === 0, `context after compact: ${JSON.stringify(c.json.chat.context)}`);
    const d = (await o.call(`/api/v1/chat/${t.id}`)).json.chat;
    assert.equal(d.messages.at(-1).role, 'note');
    assert.equal(d.messages.at(-1).kind, 'compact');
    assert.equal(o.agent.get(t.id).trimmed, d.messages.length);
    assert.ok(o.agent.get(t.id).summary.length > 0);
    assert.equal((await o.send(t.id, 'after compact')).response, 'EN: after compact');
    assert.deepEqual((await o.agent.translateMessages(o.agent.get(t.id), null)).map((m) => m.role), ['user', 'assistant'], 'only the messages after the compact go to the model');
    // Delete: asks nothing on the API, deletes the job the chat created (and keeps it with keepOutputs)
    const g = await o.chat({});
    await o.send(g.id, 'generate a cat image');
    const jobs = (await o.call(`/api/v1/chat/${g.id}`)).json.chat.createdJobs;
    assert.equal(jobs.length, 1);
    const r = await o.call(`/api/v1/chat/${g.id}`, { method: 'DELETE' });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    assert.equal(r.json.deletedJobs, 1);
    assert.equal((await o.call(`/api/v1/jobs/${jobs[0]}`)).code, 404, 'job deleted with the chat');
    assert.equal((await o.call(`/api/v1/chat?q=${encodeURIComponent('cat image')}`)).json.total, 0, 'removed from the search index');
    const k = await o.chat({});
    await o.send(k.id, 'generate a cat image');
    const kept = (await o.call(`/api/v1/chat/${k.id}`)).json.chat.createdJobs[0];
    assert.equal((await o.call(`/api/v1/chat/${k.id}?keepOutputs=1`, { method: 'DELETE' })).json.deletedJobs, 0);
    assert.equal((await o.call(`/api/v1/jobs/${kept}`)).code, 200, 'keepOutputs keeps the job');
  } finally {
    await o.close();
  }
});

test('pinned, archived and temporary chats: pinned ones come apart on the first page, archived ones leave the list (archived=1 lists them, a search finds them), the two exclude each other; a temporary chat is never written, listed or searched, stays in memory, is deleted like any chat and saved with temporary: false (its sub-agents too)', async () => {
  const o = await agentEnv();
  try {
    const titles = (list) => (list ?? []).map((c) => c.title);
    const file = (id) => join(o.p.setting.dataRoot, 'chat', `${id}.json`);
    const a = await o.chat({ title: 'Alpha' });
    const b = await o.chat({ title: 'Beta' });
    await o.chat({ title: 'Gamma' });
    let r = (await o.call('/api/v1/chat')).json;
    assert.deepEqual([titles(r.chats), r.pinned, r.archivedCount], [['Gamma', 'Beta', 'Alpha'], [], 0]);
    // Pinned: apart on the first page, not in the pages
    const pin = await o.call(`/api/v1/chat/${a.id}`, { method: 'PATCH', body: { pinned: true } });
    assert.equal(pin.code, 200, JSON.stringify(pin.json));
    assert.deepEqual([pin.json.chat.pinned, pin.json.chat.archived], [true, false]);
    r = (await o.call('/api/v1/chat')).json;
    assert.deepEqual([titles(r.pinned), titles(r.chats), r.total], [['Alpha'], ['Gamma', 'Beta'], 2]);
    assert.equal(JSON.parse(readFileSync(file(a.id), 'utf8')).pinned, true, 'kept in the chat file');
    // Archived: out of the list, counted, listed with archived=1, found by a search
    await o.call(`/api/v1/chat/${b.id}`, { method: 'PATCH', body: { archived: true } });
    r = (await o.call('/api/v1/chat')).json;
    assert.deepEqual([titles(r.pinned), titles(r.chats), r.archivedCount], [['Alpha'], ['Gamma'], 1]);
    const archive = (await o.call('/api/v1/chat?archived=1')).json;
    assert.deepEqual([titles(archive.chats), archive.total, archive.pinned], [['Beta'], 1, undefined]);
    const found = (await o.call('/api/v1/chat?q=beta')).json.chats;
    assert.deepEqual([titles(found), found[0].archived], [['Beta'], true]);
    // Archiving a pinned chat unpins it; pinning an archived one takes it out of the archive
    const both = await o.call(`/api/v1/chat/${a.id}`, { method: 'PATCH', body: { archived: true } });
    assert.deepEqual([both.json.chat.pinned, both.json.chat.archived], [false, true]);
    const back = await o.call(`/api/v1/chat/${b.id}`, { method: 'PATCH', body: { pinned: true } });
    assert.deepEqual([back.json.chat.pinned, back.json.chat.archived], [true, false]);
    r = (await o.call('/api/v1/chat')).json;
    assert.deepEqual([titles(r.pinned), titles(r.chats), r.archivedCount], [['Beta'], ['Gamma'], 1]);

    // Temporary: never written, listed or searched; it answers and lives in memory
    const t = await o.chat({ temporary: true });
    assert.equal(t.temporary, true);
    assert.equal((await o.send(t.id, 'temporary hello')).response, 'EN: temporary hello');
    assert.equal(existsSync(file(t.id)), false, 'no chat file');
    r = (await o.call('/api/v1/chat')).json;
    assert.equal([...r.chats, ...r.pinned].some((x) => x.id === t.id), false, 'not listed');
    assert.equal((await o.call('/api/v1/chat?q=temporary')).json.total, 0, 'not searched');
    assert.equal((await o.call(`/api/v1/chat/${t.id}`)).json.chat.messages.length, 2, 'it opens while it lives');
    assert.equal((await o.call(`/api/v1/chat/${t.id}`, { method: 'PATCH', body: { pinned: true } })).code, 400, 'not pinned before it is kept');
    // many chats opened after it do not push it out of memory
    for (let i = 0; i < 45; i++) o.agent.create({ title: `Filler ${i}` });
    const first = o.agent.list({ limit: 100 }).chats.at(-1).id;
    o.agent.chats.delete(first);
    o.agent.find(first);
    assert.ok(o.agent.chats.size <= 41 && o.agent.chats.has(t.id), 'the temporary chat stays in memory');
    // a sub-agent of a temporary chat is temporary; keeping the chat keeps it too
    const sub = o.agent.create({ title: 'Sub', parent: t.id, temporary: true });
    const kept = await o.call(`/api/v1/chat/${t.id}`, { method: 'PATCH', body: { temporary: false } });
    assert.equal(kept.code, 200, JSON.stringify(kept.json));
    assert.equal(kept.json.chat.temporary, false);
    assert.ok(existsSync(file(t.id)) && existsSync(file(sub.id)), 'saved with its sub-agent');
    assert.ok((await o.call('/api/v1/chat?limit=100')).json.chats.some((x) => x.id === t.id), 'listed now');
    assert.equal((await o.call(`/api/v1/chat/${t.id}`, { method: 'PATCH', body: { temporary: true } })).code, 400, 'a saved chat cannot become temporary');
    // Deleted: gone with its temporary sub-agent
    const t2 = await o.chat({ temporary: true });
    const sub2 = o.agent.create({ title: 'Sub 2', parent: t2.id, temporary: true });
    assert.equal((await o.call(`/api/v1/chat/${t2.id}?keepOutputs=1`, { method: 'DELETE' })).code, 200);
    assert.deepEqual([(await o.call(`/api/v1/chat/${t2.id}`)).code, (await o.call(`/api/v1/chat/${sub2.id}`)).code], [404, 404]);
  } finally {
    await o.close();
  }
});

test('export and import: a chat as JSON (format nedese-chat) or Markdown, imported again as a new chat (messages, tool steps, thinking and summary as they were; new ids, no ratings, jobs not owned; this panel\'s approval mode); a plain { role, content } list; broken tool steps, wrong files and formats refused', async () => {
  const o = await agentEnv();
  try {
    const t = await o.chat({ title: 'Çay saati', approvalMode: 'auto' });
    await o.send(t.id, 'memory');
    await o.send(t.id, 'generate a cat image');
    const before = (await o.call(`/api/v1/chat/${t.id}`)).json.chat;
    const job = before.createdJobs[0];
    assert.ok(job, 'the chat made a job');
    const answer = before.messages.find((m) => m.role === 'assistant' && m.content);
    o.agent.rate(t.id, answer.id, 1);
    assert.equal((await o.call(`/api/v1/chat/${t.id}/compact`, { method: 'POST' })).code, 200);
    await o.send(t.id, 'after compact');
    const source = o.agent.get(t.id);
    // JSON: a download with the chat's name (non-ASCII kept in filename*)
    const get = (path) => fetch(o.p.address + path, { headers: { Authorization: `Bearer ${o.p.settingFile.apiKey}` } });
    const r = await get(`/api/v1/chat/${t.id}/export?format=json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="_ay-saati-\d{4}-\d{2}-\d{2}\.json"; filename\*=UTF-8''%C3%87ay-saati-\d{4}-\d{2}-\d{2}\.json$/);
    const file = await r.json();
    assert.deepEqual([file.format, file.version, file.chat.title, file.chat.summary, file.messages.length], ['nedese-chat', 1, 'Çay saati', source.summary, source.messages.length]);
    // Markdown: who said what, the tool steps and the summary as quotes
    const md = await (await get(`/api/v1/chat/${t.id}/export?format=md`)).text();
    assert.match(md, /^# Çay saati\n\nExported from Nedese Studio on .+ · 3 messages from you\n\n## You · .+\n\nmemory\n\n## Nedese · .+\n\n> Tool write_memory: \{"note":"the user likes cats"\}\n\n> Result \(write_memory\): /);
    assert.match(md, /> Summary of the earlier conversation: /);
    assert.match(md, /## You · .+\n\nafter compact\n\n## Nedese · .+\n\nEN: after compact\n$/);
    // Imported: a new chat with the same conversation
    const imported = await o.call('/api/v1/chat/import', { method: 'POST', body: file });
    assert.equal(imported.code, 200, JSON.stringify(imported.json));
    // a raw answer (the chat's own texts are never run through the dictionary; the page translates the message)
    assert.equal(imported.json.message, 'Chat imported: 6 messages.');
    const c = o.agent.get(imported.json.chat.id);
    assert.equal(c.title, 'Çay saati');
    assert.deepEqual(c.messages.map((m) => [m.role, m.content, m.toolName ?? null, m.kind ?? null]), source.messages.map((m) => [m.role, m.content, m.toolName ?? null, m.kind ?? null]));
    assert.equal(c.messages.some((m) => source.messages.some((x) => x.id === m.id)), false, 'new ids');
    assert.equal(c.messages.some((m) => 'rating' in m), false, 'no ratings');
    assert.deepEqual([c.trimmed, c.summary], [source.trimmed, source.summary], 'it goes on from the summary');
    assert.equal(c.approvalMode, 'edits', "this panel's approval mode, not the file's");
    assert.deepEqual(o.agent.createdJobs(c), [], 'the jobs stay the first chat\'s');
    assert.equal((await o.send(c.id, 'which model')).response, 'Model: a.gguf', 'it goes on');
    assert.deepEqual((await o.agent.translateMessages(c, null)).map((m) => m.role), ['user', 'assistant', 'user', 'assistant'], 'only the messages after the summary go to the model');
    const removed = await o.call(`/api/v1/chat/${c.id}`, { method: 'DELETE' });
    assert.equal(removed.json.deletedJobs, 0);
    assert.equal((await o.call(`/api/v1/jobs/${job}`)).code, 200, 'deleting the copy keeps the job');
    // The wrapped body: { data, approvalMode }
    assert.equal(o.agent.get((await o.call('/api/v1/chat/import', { method: 'POST', body: { data: file, approvalMode: 'manual' } })).json.chat.id).approvalMode, 'manual');
    // A plain list in the OpenAI chat format: its user and assistant texts
    const plain = await o.call('/api/v1/chat/import', { method: 'POST', body: { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi there' }, { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }, { role: 'tool', tool_call_id: 'x', content: 'ignored' }] } });
    assert.equal(plain.code, 200, JSON.stringify(plain.json));
    assert.deepEqual(o.agent.get(plain.json.chat.id).messages.map((m) => [m.role, m.content]), [['user', 'Hi there'], ['assistant', 'Hello!']]);
    assert.equal(plain.json.chat.title, 'Hi there');
    // Tool steps only whole: a call without its result and a result without its call are left out
    const broken = await o.call('/api/v1/chat/import', { method: 'POST', body: { format: 'nedese-chat', messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 'list_file', input: {} }] }, { role: 'tool', toolId: 'zz', toolName: 'read_file', content: 'orphan' }, { role: 'assistant', content: 'Done.' }] } });
    assert.deepEqual(o.agent.get(broken.json.chat.id).messages.map((m) => [m.role, m.content]), [['user', 'go'], ['assistant', 'Done.']]);
    // Refused: not a chat file, another format, nothing to import, a wrong export format, an unknown chat
    for (const body of [{}, { format: 'other', messages: [] }, { messages: [{ role: 'system', content: 'x' }] }, 'text']) assert.equal((await o.call('/api/v1/chat/import', { method: 'POST', body })).code, 400, JSON.stringify(body));
    assert.equal((await get(`/api/v1/chat/${t.id}/export?format=xml`)).status, 400);
    assert.equal((await get('/api/v1/chat/nosuchchat/export')).status, 404);
  } finally {
    await o.close();
  }
});

test('web search helpers: Bing redirect target, relevance filter, page excerpt, language hint', () => {
  const target = 'https://nodejs.org/en/download';
  assert.equal(bingTarget(`https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(target).toString('base64').replace(/=+$/, '')}&ntb=1`), target);
  assert.equal(bingTarget('https://example.com/x'), 'https://example.com/x');
  const list = [{ title: 'Spotify - Web Player', url: 'https://open.spotify.com/', summary: 'Music for everyone' }, { title: 'Bursa Hava Durumu', url: 'https://havadurumu.com.tr/bursa', summary: '15 günlük tahmin' }];
  assert.deepEqual(relevantResults(list, 'bursa hava durumu').map((s) => s.url), ['https://havadurumu.com.tr/bursa']);
  assert.equal(relevantResults(list, 'zzz qqq').length, 2, 'nothing matches: all kept');
  const page = '# Bursa Hava Durumu\nMenü\n[Giriş](https://x/)\nBursa bugün parçalı bulutlu, 14 °C\nRüzgar 12 km/s\nGizlilik politikası\nBursa yarın 16 °C, sağanak';
  assert.equal(pageExcerpt(page, 'Bursa hava durumu'), 'Bursa Hava Durumu · Bursa bugün parçalı bulutlu, 14 °C · Bursa yarın 16 °C, sağanak');
  assert.equal(pageExcerpt('nothing related here', 'Bursa'), null);
  assert.equal(guessLanguage("Bursa'da hava nasıl"), 'tr');
  assert.equal(guessLanguage('dolar kuru bugun'), 'tr');
  assert.equal(guessLanguage('Node.js latest LTS version'), 'en');
  // a chat's first message with no clear language is not called English: the model reads it (user 10.10.2026: "Naber"
  // got an English answer); a clear one is marked, an unclear later one keeps the language before it
  for (const m of ['Naber', 'slm', 'pinterst']) assert.equal(messageLanguage(m), null, m);
  assert.deepEqual([messageLanguage('Naber', 'tr'), messageLanguage('Naber', 'en')], ['tr', 'en']);
  for (const m of ['bana bir kedi ciz', 'nasılsın']) assert.equal(messageLanguage(m), 'tr', m);
  for (const m of ['Hello', 'draw me a cat', 'What is this?']) assert.equal(messageLanguage(m), 'en', m);
  // Trust: official > well-known > unknown > low trust (a .xyz copy site was cited over MGM and AccuWeather)
  assert.equal(sourceTrust('https://www.mgm.gov.tr/tahmin/il-ve-ilceler.aspx?il=Bursa'), 2);
  assert.equal(sourceTrust('https://www.bursa.bel.tr/'), 2);
  assert.equal(sourceTrust('https://www.accuweather.com/tr/tr/bursa/316938/weather-forecast/316938'), 1);
  assert.equal(sourceTrust('https://tr.wikipedia.org/wiki/Bursa'), 1);
  assert.equal(sourceTrust('https://havadurumu.com.tr/bursa'), 0);
  assert.equal(sourceTrust('https://havadurumu15gunluk.xyz/havadurumu/bursa'), -1);
  assert.equal(sourceTrust('not a url'), 0);
  // Search services (Settings › Web search): masks, stored values
  assert.equal(maskKey('BSAabcdefgh1234'), '••••1234');
  assert.equal(maskKey('short'), '••••', 'a short key shows nothing of itself');
  assert.equal(maskKey(''), '');
  assert.equal(maskAddress('https://me:secret@searx.example.org/base'), 'https://me:••••@searx.example.org/base');
  assert.equal(checkServiceValue('searxng', 'localhost:8888/'), 'http://localhost:8888');
  assert.equal(checkServiceValue('searxng', ' https://searx.example.org/search?q=x#top '), 'https://searx.example.org');
  assert.equal(checkServiceValue('tavily', '  tvly-abc  '), 'tvly-abc');
  assert.equal(checkServiceValue('brave', ''), '', '"" removes');
  assert.throws(() => checkServiceValue('brave', 'two words'), /key looks wrong/);
  assert.throws(() => checkServiceValue('searxng', 'ftp://x.org'), /http:\/\/ or https:\/\//);
  assert.throws(() => checkServiceValue('google', 'x'), /Unknown search service/);
});

test('Settings › Web search: a Brave, Tavily or SearXNG service answers search_web first (fake services); keys go back masked and only to their service; a refused one falls through to the next', async () => {
  const BRAVE_KEY = 'BSAfakeBraveKey1234';
  const TAVILY_KEY = 'tvly-fakeTavilyKey5678';
  // The fake services: Brave (GET, key in X-Subscription-Token), Tavily (POST, Bearer key), SearXNG (GET format=json),
  // and the result pages (their matching lines come back as "From the page")
  const seen = [];
  const site = createServer((i, y) => {
    const u = new URL(i.url, 'http://x');
    let body = '';
    i.on('data', (d) => (body += d));
    i.on('end', () => {
      seen.push({ method: i.method, path: u.pathname, query: Object.fromEntries(u.searchParams), token: i.headers['x-subscription-token'], auth: i.headers.authorization, body });
      const json = (code, value) => {
        y.writeHead(code, { 'Content-Type': 'application/json' });
        y.end(JSON.stringify(value));
      };
      const base = `http://127.0.0.1:${site.address().port}`;
      if (u.pathname === '/brave') return i.headers['x-subscription-token'] === BRAVE_KEY ? json(200, { web: { results: [{ title: 'Bursa <strong>weather</strong>', url: `${base}/page/brave`, description: 'Today in <strong>Bursa</strong>' }] } }) : json(401, { error: 'bad key' });
      if (u.pathname === '/tavily') return i.headers.authorization === `Bearer ${TAVILY_KEY}` ? json(200, { results: [{ title: 'Tavily weather Bursa', url: `${base}/page/tavily`, content: 'Bursa forecast', score: 0.9 }] }) : json(401, {});
      if (u.pathname === '/searx/search') return json(200, { results: [{ title: 'SearXNG Bursa weather', url: `${base}/page/searx`, content: 'From SearXNG' }] });
      if (u.pathname.startsWith('/page/')) {
        y.writeHead(200, { 'Content-Type': 'text/html' });
        return y.end(`<html><title>Page</title><body><p>Bursa weather today: 14 °C, cloudy (${u.pathname})</p></body></html>`);
      }
      json(404, {});
    });
  });
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${site.address().port}`;
  // no free engines and no browser: nothing in this test reaches the real internet
  const o = await agentEnv({ agentSearchApis: { brave: `${base}/brave`, tavily: `${base}/tavily` }, agentSearchEngines: [] });
  const patch = (webSearch) => o.call('/api/v1/settings', { method: 'PATCH', body: { webSearch } });
  try {
    assert.deepEqual((await o.call('/api/v1/settings')).json.webSearch, { brave: '', tavily: '', searxng: '' });
    const t = await o.chat({});
    assert.match((await o.send(t.id, 'search the web for bursa weather')).response, /No results/, 'nothing set, no engines: no results');
    // Brave key saved: the answer and GET /settings show its last 4 characters; the settings file keeps it whole
    const saved = await patch({ brave: BRAVE_KEY });
    assert.equal(saved.code, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.webSearch, { brave: '••••1234', tavily: '', searxng: '' });
    assert.match(saved.json.message, /search_web önce Brave Search dener/, 'the message in Turkish (X-Panel-Lang: tr)');
    assert.equal(o.p.settingFile.webSearch.brave, BRAVE_KEY);
    assert.equal(JSON.stringify((await o.call('/api/v1/settings')).json).includes(BRAVE_KEY), false, 'the key never goes back');
    // search_web: Brave answers first, with the lines read from the result page; the key went only in its header
    const r = await o.send(t.id, 'search the web for bursa weather');
    assert.match(r.response, /^Found: \(Brave Search; trusted sources first\)\n1\. Bursa weather\n {3}http:\/\/127\.0\.0\.1:\d+\/page\/brave\n {3}Today in Bursa\n {3}From the page: Bursa weather today: 14 °C, cloudy \(\/page\/brave\)/);
    const brave = seen.find((s) => s.path === '/brave');
    assert.deepEqual([brave.method, brave.query.q, brave.query.count, brave.token], ['GET', 'bursa weather', '10', BRAVE_KEY]);
    assert.equal(JSON.stringify(o.agent.get(t.id).messages).includes(BRAVE_KEY), false, 'the key is in no message or tool result');
    // A refused key falls through to the next service: Brave 401, then Tavily answers
    assert.deepEqual((await patch({ brave: 'BSAwrongKey000000', tavily: TAVILY_KEY })).json.webSearch, { brave: '••••0000', tavily: '••••5678', searxng: '' });
    const r2 = await o.send(t.id, 'search the web for bursa weather');
    assert.match(r2.response, /^Found: \(Tavily; trusted sources first\)\n1\. Tavily weather Bursa/);
    const tavily = seen.find((s) => s.path === '/tavily');
    assert.deepEqual([tavily.method, tavily.auth, JSON.parse(tavily.body).query, JSON.parse(tavily.body).max_results], ['POST', `Bearer ${TAVILY_KEY}`, 'bursa weather', 10]);
    // SearXNG: a pasted search address is kept as its base; it is asked for JSON in the query's language
    assert.equal((await patch({ tavily: '', searxng: `${base}/searx/search?q=old` })).json.webSearch.searxng, `${base}/searx`);
    assert.equal(o.p.settingFile.webSearch.tavily, '', '"" removed Tavily');
    const r3 = await o.send(t.id, 'search the web for bursa weather');
    assert.match(r3.response, /^Found: \(SearXNG; trusted sources first\)\n1\. SearXNG Bursa weather/);
    const searx = seen.find((s) => s.path === '/searx/search');
    assert.deepEqual([searx.query.q, searx.query.format, searx.query.language], ['bursa weather', 'json', 'en']);
    // Nothing answers: the tool says why for each service (the model and the user see what to fix), never the key
    await patch({ searxng: `${base}/missing` });
    const r4 = await o.send(t.id, 'search the web for bursa weather');
    assert.match(r4.response, /No results \(Brave Search: HTTP 401 \(the key was refused \(Settings › Web search\)\); SearXNG: HTTP 404\)/);
    assert.equal(r4.response.includes('BSAwrongKey000000'), false);
    // Wrong values are refused and nothing is saved
    assert.equal((await patch({ brave: 'has a space' })).code, 400);
    assert.equal((await patch({ searxng: 'ftp://example.com' })).code, 400);
    assert.equal((await patch({ google: 'x' })).code, 400);
    assert.equal((await patch('key')).code, 400);
    assert.equal(o.p.settingFile.webSearch.brave, 'BSAwrongKey000000');
    // Removed: back to the browser and the free engines
    const removed = await patch({ brave: '', searxng: '' });
    assert.deepEqual(removed.json.webSearch, { brave: '', tavily: '', searxng: '' });
    assert.match(removed.json.message, /tarayıcıyı ve ücretsiz arama motorlarını kullanır/);
  } finally {
    site.close();
    await o.close();
  }
});

test('source links: an answer that used search_web or fetch_web keeps the pages it read (first) and found, each once, at most 6; the next answer has its own; failed reads, error pages and files are not sources; export and import keep them', async () => {
  // turnSources reads the tool results of the turn after the last shown user message
  const turn = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'fetch_web', input: {} }] },
    { role: 'tool', toolId: 'a', toolName: 'fetch_web', content: 'HTTP 200 https://old.example/\n# Old' },
    { role: 'user', content: 'new' },
    { role: 'user', hidden: true, content: '[a note]' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'fetch_web', input: {} }, { id: 'c', name: 'fetch_web', input: {} }, { id: 'd', name: 'search_web', input: {} }, { id: 'e', name: 'fetch_web', input: {} }] },
    { role: 'tool', toolId: 'b', toolName: 'fetch_web', content: 'HTTP 200 https://www.example.org/a#part (opened in the browser)\n# Page A\ntext' },
    { role: 'tool', toolId: 'c', toolName: 'fetch_web', content: 'HTTP 403 https://blocked.example/\n# Forbidden' },
    { role: 'tool', toolId: 'd', toolName: 'search_web', content: '(Brave Search; trusted sources first)\n1. Gov page [official]\n   https://gov.example/x\n   summary\n2. Page A again\n   https://www.example.org/a\n   summary\n3. Old FTP\n   ftp://files.example/x\n   summary' },
    { role: 'tool', toolId: 'e', toolName: 'fetch_web', content: 'fetch failed', error: true },
  ];
  assert.deepEqual(turnSources(turn), [{ url: 'https://www.example.org/a', title: 'Page A' }, { url: 'https://gov.example/x', title: 'Gov page' }]);
  assert.deepEqual(turnSources([{ role: 'user', content: 'hi' }]), []);
  assert.equal(cleanSources(Array.from({ length: 9 }, (_, i) => ({ url: `https://s${i}.example/` }))).length, 6);
  assert.deepEqual(cleanSources([{ url: 'javascript:alert(1)' }, { url: 'not an address' }, { url: 'http://a.example/', title: ` two\n lines ${'x'.repeat(300)}` }]).map((x) => [x.url, x.title.length]), [['http://a.example/', 200]]);
  // A real run: Brave (fake) finds pages, fetch_web reads one
  const BRAVE_KEY = 'BSAfakeBraveKey1234';
  const site = createServer((i, y) => {
    const u = new URL(i.url, 'http://x');
    const base = `http://127.0.0.1:${site.address().port}`;
    if (u.pathname === '/brave') {
      y.writeHead(200, { 'Content-Type': 'application/json' });
      const results = [['One', '/page/1#top'], ['Read again', '/page/read'], ['Two', '/page/2'], ['Three', '/page/3'], ['Four', '/page/4'], ['Five', '/page/5'], ['Six', '/page/6']];
      return y.end(JSON.stringify({ web: { results: results.map(([title, path]) => ({ title, url: base + path, description: `About ${title}` })) } }));
    }
    if (u.pathname.startsWith('/page/')) {
      y.writeHead(200, { 'Content-Type': 'text/html' });
      return y.end(`<html><title>Page ${u.pathname.slice(6)}</title><body><p>${'Bursa weather today: 14 °C, cloudy. '.repeat(30)}</p></body></html>`);
    }
    if (u.pathname === '/file.zip') {
      y.writeHead(200, { 'Content-Type': 'application/zip' });
      return y.end('PK');
    }
    y.writeHead(404, { 'Content-Type': 'text/html' });
    y.end(`<html><title>Not found</title><body><p>${'Nothing here. '.repeat(60)}</p></body></html>`);
  });
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${site.address().port}`;
  const o = await agentEnv({ agentSearchApis: { brave: `${base}/brave` }, agentSearchEngines: [] });
  const finals = [];
  const listen = (e) => {
    if (e.type === 'text' && e.final) finals.push(e);
  };
  o.agent.events.on('event', listen);
  try {
    assert.equal((await o.call('/api/v1/settings', { method: 'PATCH', body: { webSearch: { brave: BRAVE_KEY } } })).code, 200);
    const t = await o.chat({});
    const r = await o.send(t.id, `research ${base}/page/read bursa weather`);
    assert.equal(r.response, `From the sources: HTTP 200 ${base}/page/read`);
    const expected = [['read', 'Page read'], ['1', 'One'], ['2', 'Two'], ['3', 'Three'], ['4', 'Four'], ['5', 'Five']].map(([n, title]) => ({ url: `${base}/page/${n}`, title }));
    const answer = o.agent.get(t.id).messages.at(-1);
    assert.deepEqual(answer.sources, expected, 'the read page first; the search results after it without the page read again and the #part; six at most');
    assert.deepEqual(finals.at(-1).sources, expected, 'the final text event carries them (the live answer shows them)');
    assert.deepEqual((await o.call(`/api/v1/chat/${t.id}`)).json.chat.messages.at(-1).sources, expected, 'GET /chat/{id} returns them');
    // The next turn has its own (none); a 404 page, a file and a failed read are no sources
    await o.send(t.id, 'hello');
    for (const page of [`${base}/missing`, `${base}/file.zip`, 'http://127.0.0.1:1/nothing']) {
      await o.send(t.id, `read ${page}`);
      assert.equal('sources' in o.agent.get(t.id).messages.at(-1), false, page);
    }
    assert.equal(o.agent.get(t.id).messages.filter((m) => m.sources).length, 1);
    // Export: Markdown lists them under the answer; JSON keeps them and import brings them back
    const get = (path) => fetch(o.p.address + path, { headers: { Authorization: `Bearer ${o.p.settingFile.apiKey}` } });
    const md = await (await get(`/api/v1/chat/${t.id}/export?format=md`)).text();
    assert.ok(md.includes(`From the sources: HTTP 200 ${base}/page/read\n\nSources: [127.0.0.1](${base}/page/read) · [127.0.0.1](${base}/page/1)`), md.slice(0, 1500));
    const file = await (await get(`/api/v1/chat/${t.id}/export?format=json`)).json();
    file.messages.find((m) => m.sources).sources.push({ url: 'javascript:alert(1)', title: 'bad' });
    const imported = await o.call('/api/v1/chat/import', { method: 'POST', body: file });
    assert.deepEqual(o.agent.get(imported.json.chat.id).messages.find((m) => m.sources)?.sources, expected, 'kept on import; a bad address left out');
  } finally {
    o.agent.events.off('event', listen);
    site.close();
    await o.close();
  }
});

test('follow-up suggestions: up to three clean next messages for the last answer, written by the chat\'s text model and kept with it; none for an earlier answer, while the GPU works on a job or when the model is not loaded (it is not loaded for them); a new message stops a slow request; a remote chat asks its server (no JSON mode)', async () => {
  // the model's answer: JSON (a list under any key, or a bare list) or plain lines; numbering, bullets, quotes, intro
  // lines, repeats (any case), empty and too long ones left out; three at most
  assert.deepEqual(followUpList('{"followUps": ["1. A", "\\"B\\"", "a", " ", "C", "D"]}'), ['A', 'B', 'C']);
  assert.deepEqual(followUpList('```json\n{"suggestions": ["- One", "Two:"]}\n```'), ['One']);
  assert.deepEqual(followUpList('Ideas:\n1) First\n* Second'), ['First', 'Second']);
  assert.deepEqual(followUpList(`["${'x'.repeat(121)}", 42, null]`), []);
  assert.deepEqual(followUpList(''), []);
  const remote = await startFakeRemote();
  const o = await agentEnv();
  try {
    const t = await o.chat({});
    const ask = (chat, message) => o.call(`/api/v1/chat/${chat}/follow-ups`, { method: 'POST', body: { message } });
    await o.send(t.id, 'owls');
    const answer = o.agent.get(t.id).messages.at(-1);
    const first = await ask(t.id, answer.id);
    assert.equal(first.code, 200, JSON.stringify(first.json));
    const expected = ['Tell me more about owls', 'Give an example (#1)', 'Make it shorter'];
    assert.deepEqual(first.json.followUps, expected, 'cleaned; the model\'s own text (a raw answer, not translated)');
    assert.deepEqual(o.agent.get(t.id).messages.at(-1).followUps, expected, 'kept with the answer');
    assert.deepEqual((await o.call(`/api/v1/chat/${t.id}`)).json.chat.messages.at(-1).followUps, expected);
    assert.deepEqual((await ask(t.id, answer.id)).json.followUps, expected, 'asked again: the kept ones (#1: the model was not asked again)');
    // only an answer of the assistant; an unknown message
    const user = o.agent.get(t.id).messages.find((m) => m.role === 'user');
    const refused = await ask(t.id, user.id);
    assert.equal(refused.code, 400);
    assert.match(refused.json.error, /Öneriler asistanın bir yanıtı için yapılır/);
    assert.equal((await ask(t.id, 'nosuchmessage')).code, 404);
    // plain lines from the model
    await o.send(t.id, 'bad follow-ups please');
    assert.deepEqual((await ask(t.id, o.agent.get(t.id).messages.at(-1).id)).json.followUps, ['First idea', 'Second idea']);
    // an earlier answer gets none (only the last one)
    const t2 = await o.chat({});
    await o.send(t2.id, 'one');
    const one = o.agent.get(t2.id).messages.at(-1);
    await o.send(t2.id, 'two');
    assert.deepEqual((await ask(t2.id, one.id)).json.followUps, []);
    assert.equal('followUps' in o.agent.get(t2.id).messages.find((m) => m.id === one.id), false);
    // The GPU works on a job: none (the suggestion does not wait for it); nothing kept, so asked later they come
    const last = o.agent.get(t2.id).messages.at(-1);
    o.llm.gpuBusy = () => true;
    assert.deepEqual((await ask(t2.id, last.id)).json.followUps, []);
    o.llm.gpuBusy = () => false;
    assert.equal('followUps' in last, false);
    // The text model is not loaded: none, and it stays unloaded
    await o.llm.close();
    assert.deepEqual((await ask(t2.id, last.id)).json.followUps, []);
    assert.equal(o.llm.proc, null, 'a suggestion never loads the model');
    // A slow request is stopped by the next message: nothing kept for the answer it was for
    await o.send(t2.id, 'slow follow-ups');
    const slow = o.agent.get(t2.id).messages.at(-1);
    const startedAt = Date.now();
    const pending = ask(t2.id, slow.id);
    await new Promise((ok) => setTimeout(ok, 600));
    const next = await o.send(t2.id, 'after the slow one');
    assert.equal(next.response, 'EN: after the slow one');
    assert.deepEqual((await pending).json.followUps, []);
    assert.ok(Date.now() - startedAt < 2900, 'stopped before the model finished');
    assert.equal('followUps' in slow, false);
    // A chat on the remote model: its server writes them (without llama-server's JSON mode)
    assert.equal((await o.call('/api/v1/settings', { method: 'PATCH', body: { remoteModel: { url: `${remote.address}/v1`, model: 'gpt-test-mini' } } })).code, 200);
    const r = await o.chat({ model: 'remote' });
    await o.send(r.id, 'hello remote');
    const asked = await ask(r.id, o.agent.get(r.id).messages.at(-1).id);
    assert.deepEqual(asked.json.followUps, ['Remote answer from gpt-test-mini']);
    const body = remote.requests.at(-1).body;
    assert.match(body.messages[0].content, /^Suggest the next messages the user/);
    assert.equal('response_format' in body, false);
  } finally {
    await o.close();
    await remote.close();
  }
});

test('Settings › Remote model:a chat that chose an OpenAI-compatible server (fake) gets its streamed answers and tool calls; the key goes back masked and only to it; llama-server fields stay home; a refused max_tokens goes again as max_completion_tokens; while the GPU is busy a chat on the local model answers with it', async () => {
  const KEY = 'sk-fakeRemoteKey-1234';
  const remote = await startFakeRemote({ key: KEY });
  const o = await agentEnv();
  const patch = (remoteModel) => o.call('/api/v1/settings', { method: 'PATCH', body: { remoteModel } });
  try {
    // Not set: nothing to choose, a chat cannot ask for it
    assert.deepEqual((await o.call('/api/v1/settings')).json.remoteModel, { url: '', key: '', model: '', whenBusy: false, ready: false });
    assert.equal((await o.call('/api/v1/chat')).json.remote, null);
    const refused = await o.call('/api/v1/chat', { method: 'POST', body: { model: 'remote' } });
    assert.equal(refused.code, 400);
    assert.match(refused.json.error, /Uzak model ayarlı değil/);
    // Saved: a pasted .../chat/completions keeps its base, the key comes back masked (whole only in the settings file)
    const saved = await patch({ url: `${remote.address}/v1/chat/completions`, key: KEY, model: 'gpt-test-mini' });
    assert.equal(saved.code, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.remoteModel, { url: `${remote.address}/v1`, key: '••••1234', model: 'gpt-test-mini', whenBusy: false, ready: true });
    assert.match(saved.json.message, /gpt-test-mini \(uzak\)/, 'the message in Turkish (X-Panel-Lang: tr)');
    assert.equal(o.p.settingFile.remoteModel.key, KEY);
    assert.equal(JSON.stringify((await o.call('/api/v1/settings')).json).includes(KEY), false, 'the key never goes back');
    assert.deepEqual((await o.call('/api/v1/chat')).json.remote, { model: 'gpt-test-mini', whenBusy: false });
    // A preset on the remote model starts its chats on it
    const preset = await o.call('/api/v1/chat/presets', { method: 'POST', body: { name: 'Remote', model: 'remote' } });
    assert.equal(preset.code, 200, JSON.stringify(preset.json));
    assert.equal((await o.chat({ preset: preset.json.preset.id })).model, 'remote');
    // Test: a one-word question with the saved address, key and model
    const check = await o.call('/api/v1/settings/remote-model/check', { method: 'POST' });
    assert.equal(check.code, 200, JSON.stringify(check.json));
    assert.equal(check.json.text, 'OK');
    assert.match(check.json.message, /^gpt-test-mini \d+[.,]\d s içinde yanıt verdi\.$/);
    assert.deepEqual([remote.requests.at(-1).body.max_tokens, remote.requests.at(-1).body.stream], [16, false]);

    // A chat on the remote model: the answer streams from it; the local model is never started
    const t = await o.chat({ model: 'remote' });
    assert.equal(t.model, 'remote');
    const ev = o.events(t.id);
    await ev.ready;
    const r = await o.send(t.id, 'hello there');
    assert.equal(r.response, 'Remote answer from gpt-test-mini');
    const events = await ev.list;
    assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Remote answer from gpt-test-mini', 'streamed in pieces');
    const sent = remote.requests.at(-1);
    assert.equal(sent.authorization, `Bearer ${KEY}`);
    assert.equal(sent.body.model, 'gpt-test-mini');
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.stream_options, { include_usage: true });
    assert.ok(sent.body.tools.some((x) => x.function.name === 'list_file'), 'tools as functions');
    assert.equal('chat_template_kwargs' in sent.body || 'thinking_budget_tokens' in sent.body, false, 'llama-server fields are not sent');
    assert.deepEqual(r.chat.usage, { input: 20, output: 6 }, 'the server\'s usage chunk counts');
    assert.equal(o.llm.proc, null, 'the local model was not started');
    // A tool call from the remote model runs here, its result goes back to it
    const r2 = await o.send(t.id, 'remote tool please');
    assert.match(r2.response, /^Remote saw the tool result: /);
    assert.equal(remote.requests.at(-1).body.messages.at(-1).tool_call_id, 'rcall_1');
    // A server that refuses max_tokens (newer OpenAI models): sent again as max_completion_tokens
    remote.state.strict = true;
    const count = remote.requests.length;
    assert.equal((await o.send(t.id, 'hello again')).response, 'Remote answer from gpt-test-mini');
    const [first, again] = remote.requests.slice(count);
    assert.ok(first.body.max_tokens > 0);
    assert.equal(again.body.max_completion_tokens, first.body.max_tokens);
    assert.equal('max_tokens' in again.body, false);
    remote.state.strict = false;
    // A refused key: the chat says what the server answered, never the key
    assert.equal((await patch({ key: 'sk-wrongRemoteKey-0000' })).json.remoteModel.key, '••••0000');
    const bad = await o.send(t.id, 'hello');
    assert.equal(bad.response, '');
    assert.match(bad.chat.error, /The remote model answered HTTP 401: Incorrect API key provided\./);
    assert.equal(bad.chat.error.includes('sk-wrongRemoteKey'), false);
    assert.equal((await o.call('/api/v1/settings/remote-model/check', { method: 'POST' })).code, 400);

    // While the GPU is busy (an image/video job) a chat on the local model answers with the remote model, then the
    // local model again
    await patch({ key: KEY, whenBusy: true });
    const local = await o.chat({});
    let busy = true;
    o.llm.gpuBusy = () => busy;
    const ev2 = o.events(local.id);
    await ev2.ready;
    assert.equal((await o.send(local.id, 'hello busy')).response, 'Remote answer from gpt-test-mini');
    assert.ok((await ev2.list).some((e) => e.type === 'progress' && /The GPU is busy with a job; gpt-test-mini \(remote\) answers\./.test(e.text)));
    busy = false;
    assert.equal((await o.send(local.id, 'which model')).response, 'Model: a.gguf');
    // The chat can switch to it while it exists; removed, a remote chat goes back to the local default
    assert.equal((await o.call(`/api/v1/chat/${local.id}`, { method: 'PATCH', body: { model: 'remote' } })).code, 200);
    const removed = await patch({ url: '', key: '', model: '', whenBusy: false });
    assert.deepEqual(removed.json.remoteModel, { url: '', key: '', model: '', whenBusy: false, ready: false });
    assert.deepEqual(o.p.settingFile.remoteModel, { url: '', key: '', model: '', whenBusy: false });
    assert.equal((await o.send(t.id, 'which model')).response, 'Model: a.gguf');
    // Wrong values are refused and nothing is saved
    assert.equal((await patch({ url: 'ftp://example.com' })).code, 400);
    assert.equal((await patch({ key: 'has a space' })).code, 400);
    assert.equal((await patch({ other: 'x' })).code, 400);
    assert.equal((await patch('x')).code, 400);
    assert.deepEqual(o.p.settingFile.remoteModel, { url: '', key: '', model: '', whenBusy: false });
  } finally {
    await remote.close();
    await o.close();
  }
});

test('Settings › Remote model with Claude (user request 10.10.2026): the Messages API (fake, strict like the real one) streams answers and tool calls, gets the key as x-api-key, the system prompt, tools and last turn marked for the cache, images, a 200k context; an overloaded stream is an error', async () => {
  const KEY = 'sk-ant-fakeClaudeKey-9876';
  const claude = await startFakeAnthropic({ key: KEY });
  const o = await agentEnv();
  const patch = (remoteModel) => o.call('/api/v1/settings', { method: 'PATCH', body: { remoteModel } });
  try {
    // a pasted .../messages keeps its base
    const saved = await patch({ url: `${claude.address}/messages`, key: KEY, model: 'claude-test-5' });
    assert.equal(saved.code, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.remoteModel.url, claude.address);
    const check = await o.call('/api/v1/settings/remote-model/check', { method: 'POST' });
    assert.equal(check.code, 200, JSON.stringify(check.json));
    assert.equal(check.json.text, 'OK');

    const t = await o.chat({ model: 'remote' });
    assert.ok(t.context.size > 100000, `Claude's context window, not the local 32k (${t.context.size})`);
    const ev = o.events(t.id);
    await ev.ready;
    const r = await o.send(t.id, 'hello there');
    assert.equal(r.response, 'Claude answer from claude-test-5');
    assert.equal((await ev.list).filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Claude answer from claude-test-5', 'streamed in pieces');
    const sent = claude.requests.at(-1);
    assert.equal(sent.path, '/anthropic/messages');
    assert.deepEqual([sent.apiKey, sent.authorization, sent.version], [KEY, null, '2023-06-01'], 'the key as x-api-key, never as a bearer token');
    assert.equal(sent.body.stream, true);
    assert.equal(sent.body.system[0].cache_control.type, 'ephemeral');
    assert.ok(sent.body.tools.some((x) => x.name === 'list_file' && x.input_schema), 'tools with input_schema');
    assert.equal(sent.body.tools.at(-1).cache_control.type, 'ephemeral');
    assert.equal(sent.body.messages.at(-1).content.at(-1).cache_control.type, 'ephemeral');
    assert.deepEqual(r.chat.usage, { input: 1030, output: 9 }, 'the cached prompt counts in the input');
    assert.equal(o.llm.proc, null, 'the local model was not started');

    // a tool call streamed as input_json_delta pieces runs here; its result goes back as a tool_result block
    const r2 = await o.send(t.id, 'remote tool please');
    assert.match(r2.response, /^Claude saw the tool result: /);
    const [assistant, user] = claude.requests.at(-1).body.messages.slice(-2);
    assert.deepEqual(assistant.content.find((b) => b.type === 'tool_use'), { type: 'tool_use', id: 'toolu_01', name: 'list_file', input: { path: '.' } });
    assert.equal(user.content[0].tool_use_id, 'toolu_01');
    const toolMessage = o.agent.get(t.id).messages.find((m) => m.role === 'tool');
    assert.equal(toolMessage.toolName, 'list_file');

    // an image goes to Claude
    const png = makePng(32, 32);
    const y = await o.call('/api/v1/uploads/image?name=photo.png', { method: 'POST', raw: png, type: 'image/png' });
    assert.equal((await o.send(t.id, 'what is this', { attachments: [y.json.image.source] })).response, 'Claude saw an image (image/jpeg)', 'the panel sends images as JPEG');

    // overloaded in the middle of the stream: an error, not half an answer
    claude.state.overloaded = true;
    const bad = await o.send(t.id, 'hello');
    assert.equal(bad.response, '');
    assert.match(bad.chat.error, /The remote model answered HTTP 529: Overloaded/);
    claude.state.overloaded = false;
    // a wrong key: what the server said, never the key
    await patch({ key: 'sk-ant-wrongKey-0000' });
    const refused = await o.send(t.id, 'hello');
    assert.match(refused.chat.error, /HTTP 401: invalid x-api-key/);
    assert.equal(refused.chat.error.includes('wrongKey'), false);
  } finally {
    await claude.close();
    await o.close();
  }
});

test('Plan mode (user request 10.10.2026, like Claude Code): only reading tools run, a change and a panel job are refused, present_plan shows the plan, approving goes back to the earlier mode and carries it out', async () => {
  const o = await agentEnv();
  try {
    const t = await o.chat({ full: true, approvalMode: 'edits' });
    const s = () => o.agent.get(t.id);
    const toolText = () => s().messages.filter((m) => m.role === 'tool').at(-1).content;
    const tools = async () => (await o.send(t.id, 'which tools')).response;
    assert.doesNotMatch(await tools(), /present_plan/, 'only offered in plan mode');
    const patched = await o.call(`/api/v1/chat/${t.id}`, { method: 'PATCH', body: { approvalMode: 'plan' } });
    assert.equal(patched.json.chat.approvalMode, 'plan');
    assert.match(await tools(), /present_plan/);
    assert.match(o.agent.systemPrompt(s(), o.agent.tools(s())), /PLAN MODE \(chosen by the user\)/);
    // a file write, a panel job and a note do not run
    await o.send(t.id, 'write hello');
    assert.match(toolText(), /^Plan mode: this would change something, so it did not run/);
    assert.equal(existsSync(join(s().cwd, 'yazilan.txt')), false);
    const jobs = (await o.call('/api/v1/jobs')).json.jobs.length;
    await o.send(t.id, 'generate a cat image');
    assert.match(toolText(), /^Plan mode/);
    assert.equal((await o.call('/api/v1/jobs')).json.jobs.length, jobs, 'no job was started');
    await o.send(t.id, 'call tool write_memory {"note":"x"}');
    assert.match(toolText(), /^Plan mode/, 'a note is a change too');
    // reading runs: a read-only command, a GET of the panel API
    assert.match((await o.send(t.id, 'run command')).response, /^Output: .*hello/s);
    await o.send(t.id, 'call tool panel_api {"method":"GET","path":"/jobs"}');
    assert.doesNotMatch(toolText(), /Plan mode/);
    // the plan
    const ev = o.events(t.id);
    await ev.ready;
    const shown = await o.send(t.id, 'call tool present_plan {"plan":"1. Write yazilan.txt\\n2. Check it"}');
    assert.match(shown.response, /^Result \(present_plan\): The plan is shown to the user/);
    assert.equal(s().plan.text, '1. Write yazilan.txt\n2. Check it');
    assert.ok((await ev.list).some((e) => e.type === 'plan' && /Write yazilan\.txt/.test(e.text)));
    // approved: back to Allow edits (the mode before plan mode), the go-ahead goes in as a message and the chat runs
    const approved = await o.call(`/api/v1/chat/${t.id}/plan/approve`, { method: 'POST', body: {} });
    assert.equal(approved.code, 200, JSON.stringify(approved.json));
    assert.equal(s().approvalMode, 'edits');
    for (let i = 0; i < 200 && s().work; i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(s().messages.filter((m) => m.role === 'user').at(-1).content, 'The plan is approved: carry it out.');
    assert.equal(s().plan, undefined);
    await o.send(t.id, 'write hello');
    assert.doesNotMatch(toolText(), /Plan mode/, 'changes run again');
    assert.ok(existsSync(join(s().cwd, 'yazilan.txt')));
    // not in plan mode any more; plan cannot be the mode the plan runs in; a chosen mode
    const again = await o.call(`/api/v1/chat/${t.id}/plan/approve`, { method: 'POST', body: {} });
    assert.equal(again.code, 400);
    await o.call(`/api/v1/chat/${t.id}`, { method: 'PATCH', body: { approvalMode: 'plan' } });
    assert.equal((await o.call(`/api/v1/chat/${t.id}/plan/approve`, { method: 'POST', body: { mode: 'plan' } })).code, 400);
    assert.equal((await o.call(`/api/v1/chat/${t.id}/plan/approve`, { method: 'POST', body: { mode: 'auto' } })).code, 200);
    assert.equal(s().approvalMode, 'auto');
    for (let i = 0; i < 200 && s().work; i++) await new Promise((ok) => setTimeout(ok, 50));
  } finally {
    await o.close();
  }
});

test('Projects (user request 10.10.2026, like Claude): a project gives its chats its instructions and working folder, notes of their own (not the panel\'s, and the panel\'s not theirs), its own chat list; a chat moves in and out; a fork stays in it; deleting it keeps the chats', async () => {
  const o = await agentEnv();
  try {
    const folder = mkdtempSync(join(tmpdir(), 'project-'));
    const add = (body) => o.call('/api/v1/chat/projects', { method: 'POST', body });
    const made = await add({ name: '  Web   site ', description: 'The new site', instructions: 'Always use plain HTML.', cwd: folder });
    assert.equal(made.code, 200, JSON.stringify(made.json));
    const p = made.json.project;
    assert.deepEqual([p.name, p.description, p.instructions, p.cwd, p.knowledge], ['Web site', 'The new site', 'Always use plain HTML.', folder, []]);
    assert.equal((await add({ name: 'web SITE' })).code, 400, 'names are unique');
    assert.equal((await add({ name: '' })).code, 400);
    assert.equal((await add({ name: 'x', cwd: join(folder, 'missing') })).code, 400);
    assert.equal((await o.call('/api/v1/chat', { method: 'POST', body: { project: 'nope' } })).code, 404);
    // a chat in the project: its folder, its instructions in the system prompt
    const c = await o.chat({ project: p.id });
    assert.equal(c.project, p.id);
    assert.equal(c.cwd, folder);
    const prompt = (id) => o.agent.systemPrompt(o.agent.get(id), o.agent.tools(o.agent.get(id)));
    assert.match(prompt(c.id), /PROJECT "Web site": this chat belongs to this project of the user \(The new site\); your notes are the project's own\. Follow the project's instructions:\nAlways use plain HTML\./);
    // notes: the project's chat writes to the project, a plain chat to the panel; neither sees the other's
    const plain = await o.chat({});
    await o.send(c.id, 'memory');
    assert.match(prompt(c.id), /Your persistent notes for the project "Web site" \(update_memory[^\n]*\n- \[n1\] [\d-]+: the user likes cats/);
    assert.doesNotMatch(prompt(plain.id), /likes cats/);
    assert.equal((await o.call('/api/v1/chat/memory')).json.total, 0);
    const notes = await o.call(`/api/v1/chat/memory?project=${p.id}`);
    assert.deepEqual(notes.json.notes.map((n) => n.text), ['the user likes cats']);
    assert.equal((await o.call(`/api/v1/chat/memory?project=${p.id}`, { method: 'POST', body: { text: 'the site is blue' } })).code, 200);
    assert.equal((await o.call(`/api/v1/chat/memory/n2?project=${p.id}`, { method: 'PATCH', body: { text: 'the site is green' } })).code, 200);
    assert.equal((await o.call('/api/v1/chat/memory/n2', { method: 'DELETE' })).code, 404, 'not a panel note');
    await o.call('/api/v1/chat/memory', { method: 'POST', body: { text: 'panel wide note' } });
    assert.match(prompt(plain.id), /panel wide note/);
    assert.doesNotMatch(prompt(c.id), /panel wide note/);
    assert.match(prompt(c.id), /the site is green/);
    assert.equal((await o.call(`/api/v1/chat/memory/n2?project=${p.id}`, { method: 'DELETE' })).code, 200);
    // the list: chatCount and noteCount; GET /chat?project= only its chats
    const listed = (await o.call('/api/v1/chat/projects')).json.projects.find((x) => x.id === p.id);
    assert.deepEqual([listed.chatCount, listed.noteCount], [1, 1]);
    const ids = async (q) => (await o.call(`/api/v1/chat${q}`)).json.chats.map((x) => x.id);
    assert.deepEqual(await ids(`?project=${p.id}`), [c.id]);
    assert.ok((await ids('')).includes(c.id), 'the main list keeps every chat');
    // moved in and out
    assert.equal((await o.call(`/api/v1/chat/${plain.id}`, { method: 'PATCH', body: { project: p.id } })).json.chat.project, p.id);
    assert.deepEqual((await ids(`?project=${p.id}`)).sort(), [c.id, plain.id].sort());
    assert.equal((await o.call(`/api/v1/chat/${plain.id}`, { method: 'PATCH', body: { project: null } })).json.chat.project, null);
    assert.equal((await o.call(`/api/v1/chat/${plain.id}`, { method: 'PATCH', body: { project: 'nope' } })).code, 404);
    // a fork stays in the project
    const answer = o.agent.get(c.id).messages.find((m) => m.role === 'assistant');
    const fork = await o.call(`/api/v1/chat/${c.id}/fork`, { method: 'POST', body: { message: answer.id } });
    assert.equal(fork.json.chat?.project, p.id, JSON.stringify(fork.json));
    // changed: from the next message
    await o.call(`/api/v1/chat/projects/${p.id}`, { method: 'PATCH', body: { instructions: 'Answer in haiku.' } });
    assert.match(prompt(c.id), /Follow the project's instructions:\nAnswer in haiku\./);
    // deleted: its chats stay, outside any project; its notes go
    const gone = await o.call(`/api/v1/chat/projects/${p.id}`, { method: 'DELETE' });
    assert.equal(gone.json.message, 'Proje silindi; 2 sohbeti listede kalıyor.');
    assert.equal(o.agent.get(c.id).project, undefined);
    assert.equal((await o.call(`/api/v1/chat/${c.id}`)).json.chat.project, null);
    assert.doesNotMatch(prompt(c.id), /PROJECT|likes cats/);
    assert.equal(existsSync(join(o.p.setting.dataRoot, 'projects', p.id)), false);
    assert.deepEqual((await o.call('/api/v1/chat/projects')).json.projects, []);
    assert.equal((await o.call(`/api/v1/chat/projects/${p.id}`, { method: 'DELETE' })).code, 404);
  } finally {
    await o.close();
  }
});

test('Claude request body: tool results of one step in one user turn, a chat that starts with the model, image parts, the address that picks the Messages API', () => {
  const body = claudeBody({
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'assistant', content: 'summary left this first' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }, { id: 'b', type: 'function', function: { name: 'list_file', arguments: 'not json' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'file text' },
      { role: 'tool', tool_call_id: 'b', content: '' },
      { role: 'user', content: 'and then?' },
    ],
    temperature: 1.3,
    max_tokens: 500,
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    tool_choice: 'auto',
  }, 'claude-x');
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(body.messages[0].content[0].text, '(continue)');
  assert.deepEqual(body.messages[2].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
  assert.deepEqual(body.messages[3].content.map((b) => [b.type, b.id, b.input]), [['tool_use', 'a', { path: 'x' }], ['tool_use', 'b', {}]], 'an empty text is left out; broken arguments are an empty input');
  assert.deepEqual(body.messages[4].content.map((b) => b.type), ['tool_result', 'tool_result', 'text'], 'both results and the next question in one user turn');
  assert.equal(body.messages[4].content[1].content[0].text, '(no output)');
  assert.equal(body.temperature, 1, 'at most 1');
  assert.equal('tool_choice' in body, false, 'auto is the default');
  assert.deepEqual(body.system, [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }]);
  assert.equal(anthropicApi('https://api.anthropic.com/v1'), true);
  assert.equal(anthropicApi('https://api.deepseek.com/anthropic'), true);
  assert.equal(anthropicApi('https://api.deepseek.com'), false);
  assert.equal(anthropicApi('https://openrouter.ai/api/v1'), false);
  assert.equal(remoteReadsImages({ url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' }), true);
  assert.equal(remoteReadsImages({ url: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' }), false);
  assert.equal(checkRemoteAddress('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1');
});

test('remote model requests: an address that cannot be reached, a stream that the server does not send, an error that is not JSON', async () => {
  // a server that ignores stream: true (whole answer at once) still shows in the chat as text
  const plain = createServer((i, y) => {
    let body = '';
    i.on('data', (d) => (body += d));
    i.on('end', () => {
      const g = JSON.parse(body);
      if (g.model === 'broken') {
        y.writeHead(502, { 'Content-Type': 'text/html' });
        return y.end('<html>Bad gateway</html>');
      }
      y.writeHead(200, { 'Content-Type': 'application/json' });
      y.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'whole answer' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((ok) => plain.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${plain.address().port}/v1`;
  try {
    const pieces = [];
    const r = await remoteRequest({ url, model: 'm' }, { messages: [{ role: 'user', content: 'hi' }] }, { onChunk: (c) => pieces.push(c) });
    assert.equal(r.code, 200);
    assert.equal(r.json.choices[0].message.content, 'whole answer');
    assert.deepEqual(pieces, [{ text: 'whole answer' }]);
    const broken = await remoteRequest({ url, model: 'broken' }, { messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual([broken.code, broken.json.error.message], [502, 'The remote model answered HTTP 502: <html>Bad gateway</html>']);
    const port = await freePort();
    await assert.rejects(remoteRequest({ url: `http://127.0.0.1:${port}/v1`, model: 'm' }, { messages: [] }), /The remote model cannot be reached \(http:\/\/127\.0\.0\.1:\d+\/v1\): ECONNREFUSED/);
    // the address as stored: base only, http(s) only
    assert.equal(checkRemoteAddress(' https://api.example.com/v1/chat/completions?x=1 '), 'https://api.example.com/v1');
    assert.equal(checkRemoteAddress('192.168.1.5:11434/v1/'), 'http://192.168.1.5:11434/v1');
    assert.equal(checkRemoteAddress(''), '');
    assert.throws(() => checkRemoteAddress('ftp://x'), /http:\/\/ or https:\/\//);
  } finally {
    plain.close();
  }
});

test('deferred tools: a chat gets the core tools and the names of the rest; load_tools adds them, panel_api brings the panel guide', async () => {
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    const first = (await o.send(s.id, 'which tools')).response;
    const [sent, more] = first.replace(/^Tools: /, '').split(' | ');
    assert.deepEqual(sent.split(', '), ['ask_user', 'edit_file', 'fetch_web', 'list_file', 'load_tools', 'read_file', 'run_command', 'search_file', 'search_web', 'show_image', 'write_file'], 'only the core tools go with a request');
    assert.match(more, /^More tools \(add with load_tools before use\): panel jobs[^·]*: panel_api, api_document, wait_job/);
    assert.match(more, /skills \(1 installed\): load_skill, install_skill/);
    const prompt = o.agent.systemPrompt(o.agent.get(s.id), o.agent.activeTools(o.agent.get(s.id)));
    assert.ok(!/Job types|Panel API routes|deneme-beceri/.test(prompt), 'no job types, routes or skill list in every request');
    // load_tools: the tools join the chat; panel_api brings the job types with example bodies and the routes once
    await o.send(s.id, 'load panel tools');
    const loaded = o.agent.get(s.id).messages.findLast((x) => x.role === 'tool' && x.toolName === 'load_tools').content;
    assert.match(loaded, /^Loaded: panel_api, wait_job[\s\S]*Not available: no_such_tool[\s\S]*Job types \(POST \/jobs "type"\):[\s\S]*example body[\s\S]*Panel API routes/);
    const after = (await o.send(s.id, 'which tools again')).response;
    assert.match(after, /Tools: [^|]*panel_api[^|]*wait_job/);
    assert.ok(!/More tools[^\n]*panel_api/.test(after), 'loaded tools leave the More tools line');
    assert.deepEqual(o.agent.get(s.id).loadedTools, ['panel_api', 'wait_job']);
    // A compact starts lean again
    await o.call(`/api/v1/chat/${s.id}/compact`, { method: 'POST' });
    assert.deepEqual(o.agent.get(s.id).loadedTools, []);
  } finally {
    await o.close();
  }
});

test('MCP tools as functions: names and schemas, load_tools with a server name, mcp_tools, after a panel restart, text block mode; call_mcp stays for the rest', async () => {
  // names: only letters, digits, _ and -, at most 64 characters (a long one keeps a hash so two stay apart)
  assert.equal(mcpFunctionName('blender', 'get_scene.info'), 'mcp__blender__get_scene_info');
  const long = [mcpFunctionName('a'.repeat(40), `${'b'.repeat(40)}1`), mcpFunctionName('a'.repeat(40), `${'b'.repeat(40)}2`)];
  assert.ok(long.every((n) => n.length <= 64 && /^[A-Za-z0-9_-]+$/.test(n)) && long[0] !== long[1], long.join(' '));
  assert.deepEqual(functionSchema({ $schema: 'http://json-schema.org/draft-07/schema#', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false }), { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false });
  assert.deepEqual(functionSchema(null), { type: 'object', properties: {} });
  // at most 40 per server, a tool with a huge schema stays with call_mcp
  const many = Array.from({ length: 45 }, (_, i) => ({ name: `t${i}`, description: 'd', inputSchema: { type: 'object', properties: {} } }));
  many[3].inputSchema.properties.big = { type: 'string', description: 'x'.repeat(7000) };
  const split = nativeMcpTools('s', many);
  assert.deepEqual([split.native.length, split.rest.map((t) => t.name)], [40, ['t3', 't41', 't42', 't43', 't44']]);
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    // load_tools with the server's name: its tool goes to the model as mcp__fake__collect with the server's own schema
    const r = (await o.send(s.id, 'mcp native')).response;
    assert.match(r, /^Native mcp__fake__collect: 9\nImages \(can be viewed with look_image\): .+\.png \| schema \{"type":"object","properties":\{"a":\{"type":"number"\},"b":\{"type":"number"\}\},"required":\["a","b"\]\}$/);
    const loaded = o.agent.get(s.id).messages.find((m) => m.role === 'tool' && m.toolName === 'load_tools').content;
    assert.match(loaded, /^Instructions of the server "fake":\nFake server\.\n\nMCP server "fake": 1 tool is now a function of this chat \(call them directly from your next step\): mcp__fake__collect\.$/);
    assert.deepEqual(o.agent.get(s.id).mcpLoaded, ['fake']);
    assert.ok(!o.agent.get(s.id).loadedTools?.includes('mcp__fake__collect'), 'the function is not a deferred tool');
    // the chat keeps the server: its function goes with every request; the More tools line no longer names the server
    const tools = (await o.send(s.id, 'which tools')).response;
    assert.match(tools, /^Tools: [^|]*mcp__fake__collect/);
    assert.match(tools, /MCP servers: add_mcp_server/, 'no unloaded server named');
    // a restarted panel has no tool lists: the server starts again before the next model call
    o.agent.mcp.closeAll();
    assert.equal(o.agent.mcp.cachedTools('fake'), null);
    assert.match((await o.send(s.id, 'which tools again')).response, /^Tools: [^|]*mcp__fake__collect/);
    // mcp_tools loads the server the same way
    const v = await o.chat({});
    assert.match((await o.send(v.id, 'mcp native via mcp_tools')).response, /^Native mcp__fake__collect: 9\n/);
    // a chat without file and command access gets no MCP server
    const limited = o.agent.create({ full: false });
    assert.match(await o.agent.loadTools(limited, ['fake']), /^Not available: fake \(this chat has no access to it\)\.$/);
    assert.deepEqual(o.agent.mcpTools(limited), []);
    // compact: the chat starts lean again
    await o.call(`/api/v1/chat/${s.id}/compact`, { method: 'POST' });
    assert.deepEqual(o.agent.get(s.id).mcpLoaded, []);
  } finally {
    await o.close();
  }
  // text block mode (the template has no tool calls): the functions are listed in the system prompt like the others
  process.env.NO_FAKE_LLM_TOOL = '1';
  const t = await agentEnv();
  try {
    const s = await t.chat({});
    assert.match((await t.send(s.id, 'mcp native')).response, /^Native mcp__fake__collect: 9\n[\s\S]* \| listed in the prompt$/);
  } finally {
    delete process.env.NO_FAKE_LLM_TOOL;
    await t.close();
  }
});

test('rated answers: thumbs up/down stored with the message (ids on every message), counts, the good ones as JSONL training examples (download and as a data upload)', async () => {
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    const e = o.events(s.id);
    await e.ready;
    await o.send(s.id, 'first question');
    const list = await e.list;
    const text = list.find((x) => x.type === 'text');
    assert.ok(text.id && text.final, 'the answer event carries its message id and that it is the answer');
    await o.send(s.id, 'second question');
    await o.send(s.id, 'third question');
    // every message has an id (older chats get theirs when opened)
    const old = o.agent.create({ full: true });
    old.messages.push({ role: 'user', content: 'old question', attachments: [] }, { role: 'assistant', content: 'old answer' });
    const opened = (await o.call(`/api/v1/chat/${old.id}`)).json.chat;
    assert.ok(opened.messages.every((m) => /^[a-z0-9]+$/.test(m.id)), 'ids given on open');
    assert.equal(o.agent.get(old.id).messages[0].id, opened.messages[0].id, 'kept');
    const messages = (await o.call(`/api/v1/chat/${s.id}`)).json.chat.messages;
    const answers = messages.filter((m) => m.role === 'assistant');
    assert.deepEqual(answers.map((m) => m.content), ['EN: first question', 'EN: second question', 'EN: third question']);
    assert.equal(answers[0].id, text.id);
    const rate = (message, rating) => o.call(`/api/v1/chat/${s.id}/rate`, { method: 'POST', body: { message, rating } });
    assert.equal((await rate(answers[0].id, 1)).json.message, 'Puan kaydedildi.');
    assert.equal((await rate(answers[1].id, -1)).code, 200);
    assert.equal((await rate(answers[2].id, 1)).code, 200);
    assert.equal((await rate(messages[0].id, 1)).code, 400, 'a user message is not rated');
    assert.equal((await rate(answers[0].id, 5)).code, 400);
    assert.equal((await rate('nosuchmessage', 1)).code, 404);
    assert.deepEqual(o.agent.get(s.id).messages.filter((m) => m.rating).map((m) => [m.content, m.rating]), [['EN: first question', 1], ['EN: second question', -1], ['EN: third question', 1]]);
    // counts come from the chat list (panel.db), also in the Training options
    await o.p.waitForState(() => !o.agent.recordTimer.size);
    assert.deepEqual((await o.call('/api/v1/chat/ratings')).json, { ok: true, good: 2, bad: 1, chats: 1 });
    assert.deepEqual((await o.call('/api/v1/training')).json.ratedChats, { good: 2, bad: 1, chats: 1 });
    // the JSONL: one line per good answer; the bad answer leaves with its request, the earlier good one stays as context
    const r = await fetch(`${o.p.address}/api/v1/chat/ratings/export`, { headers: { Authorization: `Bearer ${o.p.settingFile.apiKey}` } });
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="rated-chats-[\d-]+\.jsonl"$/);
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [
      { messages: [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'EN: first question' }] },
      { messages: [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'EN: first question' }, { role: 'user', content: 'third question' }, { role: 'assistant', content: 'EN: third question' }] },
    ]);
    // saved as training data: a data upload whose source goes into a training job
    const saved = (await o.call('/api/v1/chat/ratings/export', { method: 'POST' })).json;
    assert.match(saved.data.source, /^upload\/\d{8}-\d{6}-data-rated-chats\.jsonl$/);
    assert.equal(saved.examples, 2);
    assert.deepEqual(readFileSync(join(o.p.setting.outputRoot, 'uploads', saved.data.source.slice(7)), 'utf8').trim().split('\n').map((l) => JSON.parse(l)), lines);
    // thumbs back: no ratings, nothing to save
    for (const a of answers) await rate(a.id, 0);
    assert.ok(!o.agent.get(s.id).messages.some((m) => 'rating' in m));
    const none = await o.call('/api/v1/chat/ratings/export', { method: 'POST' });
    assert.deepEqual([none.code, none.json.error], [400, 'Henüz iyi puanlanan yanıt yok: önce sohbetteki yanıtları başparmak yukarı ile puanlayın.']);
  } finally {
    await o.close();
  }
});

test('edit and fork: an edited message goes on as a new version, the earlier one comes back with its context and nested versions; ratings and jobs of every version count; a fork copies the messages up to a point without owning their jobs', async () => {
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    for (const text of ['first', 'second', 'third']) await o.send(s.id, text);
    const detail = async () => (await o.call(`/api/v1/chat/${s.id}`)).json.chat;
    const texts = (c) => c.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.content);
    let c = await detail();
    assert.deepEqual(c.forks, []);
    const id = (text) => c.messages.find((m) => m.content === text).id;
    const rate = (message, rating) => o.call(`/api/v1/chat/${s.id}/rate`, { method: 'POST', body: { message, rating } });
    await rate(id('EN: first'), 1);
    await rate(id('EN: second'), 1);
    // a job made in the third turn (the chat owns it)
    const live = o.agent.get(s.id);
    live.messages.push({ id: 'jobcall', role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'panel_api', input: { method: 'POST', path: '/jobs' } }] }, { role: 'tool', toolId: 'c9', toolName: 'panel_api', content: '{}', extra: { job: '20261008-000000-image-ab12' } });
    o.agent.save(live, true);
    // a summary that covers the third turn: it does not fit the edited conversation
    Object.assign(live, { trimmed: 6, summary: 'the third turn was about x' });
    const secondId = id('second');
    // edit the second message: the chat goes on from it, the rest is the earlier version
    const e = o.events(s.id);
    await e.ready;
    const edited = await o.call(`/api/v1/chat/${s.id}/edit`, { method: 'POST', body: { message: secondId, text: 'second edited', wait: true } });
    assert.equal(edited.code, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.response, 'EN: second edited');
    const branch = (await e.list).find((x) => x.type === 'branch');
    assert.deepEqual(texts(branch.detail), ['first', 'EN: first', 'second edited'], 'the branch event carries the chat before the answer');
    c = await detail();
    assert.deepEqual(texts(c), ['first', 'EN: first', 'second edited', 'EN: second edited']);
    const newId = c.messages[2].id;
    assert.notEqual(newId, secondId);
    assert.deepEqual(c.forks, [{ message: newId, version: 2, count: 2 }]);
    assert.deepEqual([live.trimmed, live.summary], [0, ''], 'the summary of the old version is dropped');
    // jobs and ratings of the earlier version still count (delete removes them too; good answers stay examples)
    assert.deepEqual(c.createdJobs, ['20261008-000000-image-ab12']);
    assert.deepEqual(c.rated, { good: 2, bad: 0 });
    // back to version 1: its messages and its summary
    const back = await o.call(`/api/v1/chat/${s.id}/branch`, { method: 'POST', body: { message: newId, version: 1 } });
    assert.equal(back.code, 200, JSON.stringify(back.json));
    assert.equal(back.json.message, 'Showing version 1 of 2.');
    c = back.json.chat;
    assert.deepEqual(texts(c), ['first', 'EN: first', 'second', 'EN: second', 'third', 'EN: third', '']);
    assert.deepEqual(c.forks, [{ message: secondId, version: 1, count: 2 }]);
    assert.equal(c.messages.find((m) => m.content === 'EN: second').rating, 1);
    assert.deepEqual([live.trimmed, live.summary], [6, 'the third turn was about x'], 'its context comes back');
    // a version inside a version: edit the third message of version 1, then away and back
    await o.call(`/api/v1/chat/${s.id}/edit`, { method: 'POST', body: { message: id('third'), text: 'third edited', wait: true } });
    c = await detail();
    assert.deepEqual(texts(c), ['first', 'EN: first', 'second', 'EN: second', 'third edited', 'EN: third edited']);
    assert.deepEqual(c.forks.map((f) => [f.version, f.count]), [[1, 2], [2, 2]]);
    await o.call(`/api/v1/chat/${s.id}/branch`, { method: 'POST', body: { message: secondId, version: 2 } });
    c = await detail();
    assert.deepEqual(texts(c), ['first', 'EN: first', 'second edited', 'EN: second edited']);
    assert.deepEqual(c.forks, [{ message: newId, version: 2, count: 2 }], 'the nested version belongs to version 1');
    await o.call(`/api/v1/chat/${s.id}/branch`, { method: 'POST', body: { message: newId, version: 1 } });
    c = await detail();
    assert.deepEqual(texts(c), ['first', 'EN: first', 'second', 'EN: second', 'third edited', 'EN: third edited']);
    assert.deepEqual(c.forks.map((f) => [f.version, f.count]), [[1, 2], [2, 2]]);
    // the chat file keeps every version (a restarted panel reads them)
    o.agent.save(live, true);
    const stored = JSON.parse(readFileSync(join(o.agent.folder, `${s.id}.json`), 'utf8'));
    assert.equal(stored.forks.length, 2);
    // training data: every version, an answer the versions share once
    const examples = o.agent.ratedExamples().examples.map((x) => x.messages.map((m) => m.content).join(' > '));
    assert.deepEqual(examples.sort(), ['first > EN: first', 'first > EN: first > second > EN: second']);
    // wrong uses
    const bad = async (path, body) => (await o.call(`/api/v1/chat/${s.id}/${path}`, { method: 'POST', body })).code;
    assert.equal(await bad('edit', { message: id('EN: first'), text: 'x' }), 400, 'an answer is not edited');
    assert.equal(await bad('edit', { message: 'nosuch', text: 'x' }), 404);
    assert.equal(await bad('edit', { message: secondId, text: '' }), 400, 'empty');
    assert.equal(await bad('branch', { message: secondId, version: 3 }), 400);
    assert.equal(await bad('branch', { message: id('first'), version: 1 }), 404, 'never edited');
    await o.send(s.id, 'ask me', { wait: false });
    await o.p.waitForState(() => o.agent.get(s.id).status === 'question');
    assert.equal(await bad('edit', { message: secondId, text: 'x' }), 409, 'not while it runs');
    assert.equal(await bad('branch', { message: secondId, version: 2 }), 409);
    o.agent.stop(s.id);
    await o.p.waitForState(() => o.agent.get(s.id).status === 'idle');
    // fork from the first answer: a new chat with those messages, settings and no ratings; the first chat stays
    o.agent.applyUpdate(s.id, { approvalMode: 'manual', thinking: 'high' });
    const before = JSON.stringify(o.agent.get(s.id).messages);
    const forked = await o.call(`/api/v1/chat/${s.id}/fork`, { method: 'POST', body: { message: id('EN: first') } });
    assert.equal(forked.code, 200, JSON.stringify(forked.json));
    assert.equal(forked.json.message, 'Chat forked.');
    const f = (await o.call(`/api/v1/chat/${forked.json.chat.id}`)).json.chat;
    assert.equal(f.title, 'first (2)');
    assert.deepEqual(texts(f), ['first', 'EN: first']);
    assert.deepEqual([f.approvalMode, f.thinking, f.full, f.rated], ['manual', 'high', true, { good: 0, bad: 0 }]);
    assert.deepEqual(f.forkOf, { chat: s.id, message: id('EN: first') });
    assert.ok(f.messages.every((m) => !c.messages.some((x) => x.id === m.id)), 'new ids');
    assert.equal(JSON.stringify(o.agent.get(s.id).messages), before, 'the first chat is unchanged');
    // the fork goes on by itself
    await o.send(f.id, 'fork question');
    assert.deepEqual(texts((await o.call(`/api/v1/chat/${f.id}`)).json.chat), ['first', 'EN: first', 'fork question', 'EN: fork question']);
    // a fork after the job: the copies do not make the job the fork's (deleting it keeps the job)
    c = await detail();
    // version 1 of the third message: the one with the job
    const nested = c.forks.find((x) => x.message !== secondId);
    await o.call(`/api/v1/chat/${s.id}/branch`, { method: 'POST', body: { message: nested.message, version: 1 } });
    c = await detail();
    assert.ok(c.messages.some((m) => m.id === 'jobcall'));
    const second = (await o.call(`/api/v1/chat/${s.id}/fork`, { method: 'POST', body: { message: c.messages.at(-1).id } })).json.chat;
    assert.deepEqual(o.agent.createdJobs(second.id), []);
    assert.deepEqual(o.agent.createdJobs(s.id), ['20261008-000000-image-ab12']);
    // a fork of the fork is numbered on
    assert.equal((await o.call(`/api/v1/chat/${second.id}/fork`, { method: 'POST', body: { message: (await o.call(`/api/v1/chat/${second.id}`)).json.chat.messages[1].id } })).json.chat.title, 'first (3)');
  } finally {
    await o.close();
  }
});

test('regenerate: the last request goes again with its attachments, the earlier answer stays as version 1 and comes back; not before a request, not while it runs', async () => {
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    const regenerate = (body = { wait: true }) => o.call(`/api/v1/chat/${s.id}/regenerate`, { method: 'POST', body });
    const none = await regenerate();
    assert.deepEqual([none.code, none.json.error], [400, 'Henüz yeniden yazılacak bir yanıt yok.']);
    await o.send(s.id, 'first');
    const up = await o.call('/api/v1/uploads/file?name=notes.txt', { method: 'POST', raw: Buffer.from('the notes') });
    const file = { source: up.json.file.source, type: 'file', name: 'notes.txt' };
    await o.send(s.id, 'second', { attachments: [file] });
    const detail = async () => (await o.call(`/api/v1/chat/${s.id}`)).json.chat;
    const texts = (c) => c.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.content);
    let c = await detail();
    const oldAnswer = c.messages.at(-1).id;
    await o.call(`/api/v1/chat/${s.id}/rate`, { method: 'POST', body: { message: oldAnswer, rating: 1 } });
    const e = o.events(s.id);
    await e.ready;
    const r = await regenerate();
    assert.equal(r.code, 200, JSON.stringify(r.json));
    // the fake model echoes what it got: the attached text went again too
    assert.match(r.json.response, /^EN: second\n\[Attachment notes\.txt · [^\n]*\]\nthe notes\n/);
    assert.ok((await e.list).some((x) => x.type === 'branch'), 'the chat view changes as after an edit');
    c = await detail();
    assert.deepEqual(texts(c).map((x) => x.split('\n')[0]), ['first', 'EN: first', 'second', 'EN: second']);
    const request = c.messages[2];
    assert.deepEqual(request.attachments, [file], 'the request goes again with its attachment');
    assert.notEqual(c.messages.at(-1).id, oldAnswer, 'a new answer');
    assert.equal(c.messages.at(-1).rating ?? 0, 0);
    assert.deepEqual(c.forks, [{ message: request.id, version: 2, count: 2 }]);
    // again: a third version; the answers before stay
    await regenerate();
    c = await detail();
    assert.deepEqual(c.forks, [{ message: c.messages[2].id, version: 3, count: 3 }]);
    // the first answer comes back with its rating
    const back = await o.call(`/api/v1/chat/${s.id}/branch`, { method: 'POST', body: { message: c.messages[2].id, version: 1 } });
    assert.equal(back.code, 200, JSON.stringify(back.json));
    assert.equal(back.json.chat.messages.at(-1).id, oldAnswer);
    assert.equal(back.json.chat.messages.at(-1).rating, 1);
    // not while it runs (409); without wait the answer comes in the event stream
    await o.send(s.id, 'ask me', { wait: false });
    await o.p.waitForState(() => o.agent.get(s.id).status === 'question');
    const busy = await regenerate({});
    assert.deepEqual([busy.code, busy.json.error], [409, 'Sohbet çalışıyor; yanıtı bittiğinde (ya da durdurunca) yeniden yazdırın.']);
    o.agent.stop(s.id);
    await o.p.waitForState(() => o.agent.get(s.id).status === 'idle');
    const later = await regenerate({});
    assert.equal(later.code, 200, JSON.stringify(later.json));
    assert.equal(later.json.message, 'Writing the answer again; it comes in the event stream.');
    await o.p.waitForState(() => o.agent.get(s.id).status === 'question');
    o.agent.stop(s.id);
    await o.p.waitForState(() => o.agent.get(s.id).status === 'idle');
    assert.equal((await o.call('/api/v1/chat/templates', { method: 'POST', body: { name: 'regenerate', text: 'x' } })).code, 400, '/regenerate is a command, not a template name');
  } finally {
    await o.close();
  }
});

test('assistant presets: added, checked, changed and deleted; a chat started with one gets its instructions in the system prompt (before the user rules) and its settings, unless the request gives them; editing the preset later does not change the chat', async () => {
  const o = await agentEnv();
  try {
    const add = (body) => o.call('/api/v1/chat/presets', { method: 'POST', body });
    assert.deepEqual((await o.call('/api/v1/chat/presets')).json.presets, []);
    const coder = await add({ name: '  Coder  ', prompt: 'Answer with code first.\r\nKeep it short.', model: 'b.gguf', thinking: 'high', approvalMode: 'manual', cwd: o.home });
    assert.equal(coder.code, 200, JSON.stringify(coder.json));
    // raw: the user's names and texts are never run through the dictionary (a preset named "Assistant" stays so)
    assert.equal(coder.json.message, 'Preset added.');
    const p = coder.json.preset;
    assert.deepEqual({ ...p, id: 'x', update: 'x' }, { id: 'x', name: 'Coder', prompt: 'Answer with code first.\nKeep it short.', model: 'b.gguf', thinking: 'high', approvalMode: 'manual', cwd: o.home, update: 'x' });
    // checks
    const bad = async (body) => {
      const r = await add(body);
      return [r.code, r.json.error];
    };
    assert.deepEqual(await bad({ prompt: 'x' }), [400, 'Ön ayara bir ad verin.']);
    assert.deepEqual(await bad({ name: 'coder' }), [400, '"coder" adlı bir ön ayar zaten var.']);
    assert.equal((await add({ name: 'M', model: 'none.gguf' })).code, 400);
    assert.equal((await add({ name: 'T', thinking: 'very' })).code, 400);
    assert.equal((await add({ name: 'A', approvalMode: 'sometimes' })).code, 400);
    assert.equal((await add({ name: 'C', cwd: join(o.home, 'no-such-folder') })).code, 400);
    assert.equal((await add({ name: 'L', prompt: 'x'.repeat(8001) })).code, 400);
    const plain = (await add({ name: 'Brief', prompt: 'Answer in one sentence.' })).json.preset;
    await add({ name: 'Assistant', prompt: 'Default' });
    assert.deepEqual((await o.call('/api/v1/chat/presets')).json.presets.map((x) => [x.name, x.prompt]), [['Assistant', 'Default'], ['Brief', 'Answer in one sentence.'], ['Coder', 'Answer with code first.\nKeep it short.']], 'sorted by name, not translated');
    await o.call(`/api/v1/chat/presets/${(await o.call('/api/v1/chat/presets')).json.presets[0].id}`, { method: 'DELETE' });
    // a chat with the preset: its settings and its instructions
    const s = await o.chat({ preset: p.id });
    assert.deepEqual([s.preset, s.approvalMode, s.thinking, s.model, s.cwd], [{ id: p.id, name: 'Coder' }, 'manual', 'high', 'b.gguf', o.home]);
    assert.equal((await o.send(s.id, 'which preset')).response, 'Preset Coder: Answer with code first.');
    // the user's rules come after the preset (they weigh most)
    await o.call('/api/v1/chat/rules', { method: 'PATCH', body: { text: '- Always be polite.' } });
    assert.equal((await o.send(s.id, 'which preset')).response, 'Preset Coder: Answer with code first. (rules after it)');
    // what the request gives wins; a chat without a preset has none
    const own = await o.chat({ preset: p.id, approvalMode: 'auto', thinking: 'none', model: '' });
    assert.deepEqual([own.approvalMode, own.thinking, own.model], ['auto', 'none', null]);
    const none = await o.chat({});
    assert.equal(none.preset, null);
    assert.equal((await o.send(none.id, 'which preset')).response, 'No preset');
    assert.equal((await o.call('/api/v1/chat', { method: 'POST', body: { preset: 'nosuch' } })).code, 404);
    // change and delete: the chat keeps what it started with
    const changed = await o.call(`/api/v1/chat/presets/${p.id}`, { method: 'PATCH', body: { prompt: 'Be funny.', model: null } });
    assert.deepEqual([changed.json.preset.prompt, changed.json.preset.model, changed.json.preset.thinking], ['Be funny.', null, 'high'], 'other fields stay');
    assert.equal((await o.send(s.id, 'which preset')).response, 'Preset Coder: Answer with code first. (rules after it)');
    assert.equal((await o.chat({ preset: p.id })).model, null);
    assert.equal((await o.call(`/api/v1/chat/presets/${plain.id}`, { method: 'PATCH', body: { name: 'Coder' } })).code, 400, 'name taken');
    assert.equal((await o.call(`/api/v1/chat/presets/${p.id}`, { method: 'DELETE' })).json.message, 'Ön ayar silindi.');
    assert.equal((await o.call(`/api/v1/chat/presets/${p.id}`, { method: 'DELETE' })).code, 404);
    assert.deepEqual((await o.call('/api/v1/chat/presets')).json.presets.map((x) => x.name), ['Brief']);
    assert.equal((await o.send(s.id, 'which preset')).response, 'Preset Coder: Answer with code first. (rules after it)');
    // the agent cannot change presets through panel_api (non-GET /chat routes are closed to it)
    await assert.rejects(o.agent.callApi('POST', '/chat/presets', { name: 'Sneaky' }), /cannot be called from inside the agent/);
    // uploads go through add_upload, not a raw POST (the guard named the old /yuklemeler/ route after the English rename)
    await assert.rejects(o.agent.callApi('POST', '/uploads/file', {}), /cannot be called from inside the agent/);
  } finally {
    await o.close();
  }
});

test('prompt templates: added with their {{variables}}, names checked (no spaces, not a composer command, unique), changed and deleted, kept in panel-data', async () => {
  const o = await agentEnv();
  try {
    const add = (body) => o.call('/api/v1/chat/templates', { method: 'POST', body });
    const bug = await add({ name: '/bug', description: '  Find a bug  ', text: 'Find the bug in {{file}}.\r\nWhat happens: {{ what happens }}; again {{file}}.' });
    assert.equal(bug.code, 200, JSON.stringify(bug.json));
    const t = bug.json.template;
    assert.deepEqual([t.name, t.description, t.text, t.variables], ['bug', 'Find a bug', 'Find the bug in {{file}}.\nWhat happens: {{ what happens }}; again {{file}}.', ['file', 'what happens']]);
    const code = async (body) => (await add(body)).code;
    assert.equal(await code({ name: 'two words', text: 'x' }), 400);
    assert.equal(await code({ name: 'help', text: 'x' }), 400, 'a command of the composer');
    assert.equal(await code({ name: 'BUG', text: 'x' }), 400, 'taken');
    assert.equal(await code({ name: 'empty', text: '  ' }), 400);
    assert.equal(await code({ name: 'x'.repeat(41), text: 'x' }), 400);
    assert.equal((await add({ name: 'çeviri', text: 'Translate to Turkish: {{text}}' })).code, 200, 'letters of any language');
    assert.equal((await add({ name: 'hello', text: 'Say hello.' })).json.template.variables.length, 0);
    let list = (await o.call('/api/v1/chat/templates')).json.templates;
    assert.deepEqual(list.map((x) => x.name), ['bug', 'çeviri', 'hello']);
    assert.deepEqual(list[1].variables, ['text']);
    // stored without the computed variables
    const stored = JSON.parse(readFileSync(join(o.p.setting.dataRoot, 'prompt-templates.json'), 'utf8')).templates;
    assert.ok(stored.every((x) => !('variables' in x)));
    const changed = (await o.call(`/api/v1/chat/templates/${t.id}`, { method: 'PATCH', body: { text: 'Explain {{topic}}.' } })).json.template;
    assert.deepEqual([changed.name, changed.description, changed.variables], ['bug', 'Find a bug', ['topic']]);
    assert.equal((await o.call(`/api/v1/chat/templates/${t.id}`, { method: 'DELETE' })).json.message, 'Şablon silindi.');
    list = (await o.call('/api/v1/chat/templates')).json.templates;
    assert.deepEqual(list.map((x) => x.name), ['çeviri', 'hello']);
    assert.equal((await o.call(`/api/v1/chat/templates/${t.id}`, { method: 'PATCH', body: { text: 'x' } })).code, 404);
  } finally {
    await o.close();
  }
});

test('Settings › Assistant API: scheduled tasks, lasting notes, skills and MCP servers are listed, added, changed and deleted; servers of other files are turned off by an override; MCP and skill changes need full access', async () => {
  const o = await agentEnv();
  try {
    // scheduled tasks
    const added = await o.call('/api/v1/chat/schedules', { method: 'POST', body: { task: 'Check the disk', minuteAfter: 60, repeatMin: 1440, approvalMode: 'manual' } });
    assert.equal(added.code, 200, JSON.stringify(added.json));
    const z = added.json.schedule;
    assert.deepEqual([z.task, z.repeatMin, z.approvalMode, z.full], ['Check the disk', 1440, 'manual', true]);
    assert.ok(Math.abs(Date.parse(z.time) - Date.now() - 3600000) < 60000);
    assert.equal((await o.call('/api/v1/chat/schedules', { method: 'POST', body: { task: ' ', minuteAfter: 5 } })).code, 400);
    assert.equal((await o.call('/api/v1/chat/schedules', { method: 'POST', body: { task: 'x' } })).code, 400, 'no time');
    const changed = await o.call(`/api/v1/chat/schedules/${z.id}`, { method: 'PATCH', body: { task: 'Check the disk twice', time: '2030-01-02T03:04:00.000Z', repeatMin: 0 } });
    assert.deepEqual([changed.json.schedule.task, changed.json.schedule.time, changed.json.schedule.repeatMin, changed.json.schedule.approvalMode], ['Check the disk twice', '2030-01-02T03:04:00.000Z', null, 'manual']);
    assert.equal((await o.call(`/api/v1/chat/schedules/${z.id}`, { method: 'PATCH', body: { time: 'tomorrow-ish' } })).code, 400);
    assert.deepEqual((await o.call('/api/v1/chat/schedules')).json.schedules.map((x) => x.task), ['Check the disk twice']);
    assert.equal((await o.call(`/api/v1/chat/schedules/${z.id}`, { method: 'DELETE' })).code, 200);
    assert.equal((await o.call(`/api/v1/chat/schedules/${z.id}`, { method: 'DELETE' })).code, 404);
    // lasting notes: newest first, searched, changed, deleted by id only
    for (const text of ['The user likes cats.', 'Answer in Turkish.', 'The cat is called Tekir.']) assert.equal((await o.call('/api/v1/chat/memory', { method: 'POST', body: { text } })).code, 200);
    let notes = (await o.call('/api/v1/chat/memory')).json;
    assert.deepEqual([notes.total, notes.notes.map((n) => n.id)], [3, ['n3', 'n2', 'n1']]);
    assert.deepEqual((await o.call('/api/v1/chat/memory?q=CAT')).json.notes.map((n) => n.id), ['n3', 'n1']);
    assert.equal((await o.call('/api/v1/chat/memory/n2', { method: 'PATCH', body: { text: 'Answer in English.' } })).code, 200);
    assert.equal((await o.call('/api/v1/chat/memory/n2', { method: 'PATCH', body: { text: ' ' } })).code, 400);
    assert.equal((await o.call('/api/v1/chat/memory/n9', { method: 'PATCH', body: { text: 'x' } })).code, 404);
    assert.equal((await o.call('/api/v1/chat/memory/cats', { method: 'DELETE' })).code, 404, 'not by text');
    assert.equal((await o.call('/api/v1/chat/memory/n1', { method: 'DELETE' })).code, 200);
    notes = (await o.call('/api/v1/chat/memory')).json;
    assert.deepEqual(notes.notes.map((n) => [n.id, n.text]), [['n2', 'Answer in English.'], ['n3', 'The cat is called Tekir.']]);
    assert.match(o.agent.memoryPrompt(), /Answer in English\./, 'the assistant reads them');
    // skills: only the panel's own can be removed (a project skill or a plugin's stays)
    mkdirSync(join(o.p.setting.dataRoot, 'skills', 'own-skill'), { recursive: true });
    writeFileSync(join(o.p.setting.dataRoot, 'skills', 'own-skill', 'SKILL.md'), '---\nname: own-skill\ndescription: Installed by the panel\n---\nDo it.\n');
    mkdirSync(join(o.p.setting.aiRoot, '.claude', 'skills', 'project-skill'), { recursive: true });
    writeFileSync(join(o.p.setting.aiRoot, '.claude', 'skills', 'project-skill', 'SKILL.md'), '---\nname: project-skill\ndescription: Kept in the project\n---\nDo it.\n');
    const kit = join(o.p.setting.dataRoot, 'plugins', 'kit');
    mkdirSync(join(kit, 'skills', 'kit-skill'), { recursive: true });
    mkdirSync(join(kit, '.claude-plugin'), { recursive: true });
    writeFileSync(join(kit, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', version: '2.1.0', description: 'A kit' }));
    writeFileSync(join(kit, 'skills', 'kit-skill', 'SKILL.md'), '---\nname: kit-skill\ndescription: From a plugin\n---\nDo it.\n');
    writeFileSync(join(kit, '.mcp.json'), JSON.stringify({ mcpServers: { kitserver: { command: process.execPath, args: [FAKE_MCP] } } }));
    const skills = (await o.call('/api/v1/chat/skills')).json.skills;
    assert.deepEqual(skills.map((k) => [k.name, k.source, k.removable]), [['deneme-beceri', 'panel', true], ['own-skill', 'panel', true], ['project-skill', 'project', false], ['kit:kit-skill', 'plugin:kit', false]]);
    assert.equal((await o.call('/api/v1/chat/skills/project-skill', { method: 'DELETE' })).code, 400);
    assert.equal((await o.call('/api/v1/chat/skills/own-skill', { method: 'DELETE' })).code, 200);
    assert.ok(!existsSync(join(o.p.setting.dataRoot, 'skills', 'own-skill')));
    // plugins: listed with their skills and servers; removing one takes both away
    assert.deepEqual((await o.call('/api/v1/chat/plugins')).json.plugins.map((x) => [x.name, x.version, x.description, x.skills, x.mcp]), [['kit', '2.1.0', 'A kit', ['kit-skill'], ['kitserver']]]);
    assert.equal(o.agent.mcp.servers().kitserver.source, 'plugin:kit');
    assert.equal((await o.call('/api/v1/chat/mcp/kitserver', { method: 'DELETE' })).code, 400, "a plugin's server is removed with its plugin");
    assert.equal((await o.call('/api/v1/chat/plugins/kit', { method: 'DELETE' })).code, 200);
    assert.ok(!existsSync(kit));
    assert.equal(o.agent.mcp.servers().kitserver, undefined);
    assert.ok(!(await o.call('/api/v1/chat/skills')).json.skills.some((k) => k.name === 'kit:kit-skill'));
    assert.equal((await o.call('/api/v1/chat/plugins/kit', { method: 'DELETE' })).code, 404);
    // MCP: the panel's server and one of the project's file
    writeFileSync(join(o.p.setting.aiRoot, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: process.execPath, args: [FAKE_MCP] } } }));
    let servers = (await o.call('/api/v1/chat/mcp')).json.servers;
    assert.deepEqual(servers.map((s) => [s.name, s.source, s.type, s.editable, s.disabled, s.started, s.tools]), [['fake', 'panel', 'stdio', true, false, false, null], ['proj', 'project', 'stdio', false, false, false, null]]);
    const check = await o.call('/api/v1/chat/mcp/fake/check', { method: 'POST' });
    assert.equal(check.code, 200, JSON.stringify(check.json));
    assert.ok(check.json.server.started && check.json.server.tools.includes('collect'));
    // off, a time limit, on
    assert.equal((await o.call('/api/v1/chat/mcp/fake', { method: 'PATCH', body: { disabled: true, timeoutSec: 30 } })).json.server.disabled, true);
    assert.ok(!('fake' in o.agent.mcp.servers()), 'its tools leave the chats');
    assert.equal((await o.call('/api/v1/chat/mcp/fake/check', { method: 'POST' })).code, 400, 'off: not started');
    const own = JSON.parse(readFileSync(join(o.p.setting.dataRoot, 'mcp.json'), 'utf8'));
    assert.deepEqual([own.mcpServers.fake.disabled, own.mcpServers.fake.timeout], [true, 30000]);
    await o.call('/api/v1/chat/mcp/fake', { method: 'PATCH', body: { disabled: false } });
    assert.equal(o.agent.mcp.servers().fake.timeout, 30000);
    // a server of another file: an override in the panel's file, its own file untouched; not removable here
    await o.call('/api/v1/chat/mcp/proj', { method: 'PATCH', body: { disabled: true } });
    assert.deepEqual(JSON.parse(readFileSync(join(o.p.setting.dataRoot, 'mcp.json'), 'utf8')).overrides, { proj: { disabled: true } });
    assert.deepEqual(JSON.parse(readFileSync(join(o.p.setting.aiRoot, '.mcp.json'), 'utf8')), { mcpServers: { proj: { command: process.execPath, args: [FAKE_MCP] } } });
    assert.ok(!('proj' in o.agent.mcp.servers()));
    assert.equal((await o.call('/api/v1/chat/mcp/proj', { method: 'DELETE' })).code, 400);
    await o.call('/api/v1/chat/mcp/proj', { method: 'PATCH', body: { disabled: false } });
    assert.equal(JSON.parse(readFileSync(join(o.p.setting.dataRoot, 'mcp.json'), 'utf8')).overrides.proj, undefined, 'an empty override goes');
    // add: started to check; one that does not start is not kept
    const two = await o.call('/api/v1/chat/mcp', { method: 'POST', body: { name: 'two', command: process.execPath, args: [FAKE_MCP], timeoutSec: 45 } });
    assert.equal(two.code, 200, JSON.stringify(two.json));
    assert.equal(two.json.message, 'MCP server "two" added with 1 tool.');
    assert.equal(two.json.server.timeoutSec, 45);
    const broken = await o.call('/api/v1/chat/mcp', { method: 'POST', body: { name: 'broken', command: join(o.home, 'no-such-program.exe') } });
    assert.equal(broken.code, 400);
    assert.ok(!(await o.call('/api/v1/chat/mcp')).json.servers.some((s) => s.name === 'broken'));
    assert.equal((await o.call('/api/v1/chat/mcp', { method: 'POST', body: { name: 'bad name!', command: 'x' } })).code, 400);
    assert.equal((await o.call('/api/v1/chat/mcp/two', { method: 'DELETE' })).code, 200);
    servers = (await o.call('/api/v1/chat/mcp')).json.servers;
    assert.deepEqual(servers.map((s) => s.name), ['fake', 'proj']);
    // a device without full access sees them but cannot change MCP servers or skills
    await o.call('/api/v1/settings', { method: 'PATCH', body: { networkFullAccess: false } });
    assert.equal((await o.call('/api/v1/chat/mcp', { key: false })).code, 200);
    assert.equal((await o.call('/api/v1/chat/mcp/fake', { method: 'PATCH', body: { disabled: true }, key: false })).code, 403);
    assert.equal((await o.call('/api/v1/chat/mcp', { method: 'POST', body: { name: 'x', command: 'x' }, key: false })).code, 403);
    assert.equal((await o.call('/api/v1/chat/plugins/any', { method: 'DELETE', key: false })).code, 403);
    const limited = await o.call('/api/v1/chat/schedules', { method: 'POST', body: { task: 'From the phone', minuteAfter: 5 }, key: false });
    assert.equal(limited.json.schedule.full, false, 'a task scheduled from such a device has its access');
  } finally {
    await o.close();
  }
});

test('a tool the agent wrote but did not install: it is sent back once to install it (10.10.2026: "installed" said, nothing installed)', async () => {
  // which tool folders a turn wrote and did not install
  const turn = (calls) => [{ role: 'user', content: 'go' }, ...calls.flatMap(([name, input, error], i) => [{ role: 'assistant', toolCalls: [{ id: `c${i}`, name, input }] }, { role: 'tool', toolId: `c${i}`, toolName: name, content: 'x', ...(error ? { error: true } : {}) }])];
  const folders = (calls) => uninstalledTools(turn(calls)).map((t) => `${t.folder}${t.server ? ' (server)' : ''}`);
  assert.deepEqual(folders([['write_file', { path: 'panel-data\\tools\\qr_generator\\qr_tool.py' }], ['write_file', { path: 'panel-data\\tools\\qr_generator\\server.py' }], ['run_command', { command: 'python x' }]]), ['qr_generator']);
  assert.deepEqual(folders([['write_file', { path: 'C:\\ai\\panel-data\\tools\\qr\\SKILL.md' }], ['install_skill', { source: 'C:\\ai\\panel-data\\tools\\qr' }]]), []);
  assert.deepEqual(folders([['write_file', { path: 'panel-data/tools/qr/server.py' }], ['add_mcp_server', { name: 'qr', command: 'python', args: ['panel-data/tools/qr/server.py'] }]]), []);
  assert.deepEqual(folders([['write_file', { path: 'panel-data/tools/qr/SKILL.md' }], ['install_skill', { source: 'panel-data/tools/qr' }, true]]), ['qr'], 'a failed install does not count');
  assert.deepEqual(folders([['write_file', { path: 'notes/panel-data-tools.txt' }]]), []);
  // an MCP server script is installed only by add_mcp_server: install_skill of its folder starts nothing
  const server = ['write_file', { path: 'panel-data\\tools\\qr-mcp\\server.py', text: 'import os\nfrom fastmcp import FastMCP\n' }];
  assert.deepEqual(folders([server, ['install_skill', { skill: 'qr-mcp', source: 'panel-data\\tools\\qr-mcp' }]]), ['qr-mcp (server)']);
  assert.deepEqual(folders([server, ['add_mcp_server', { name: 'qr-mcp', command: 'python', args: ['C:\\ai\\panel-data\\tools\\qr-mcp\\server.py'] }]]), []);
  assert.deepEqual(folders([['edit_file', { path: 'panel-data/tools/t/run.py', search: 'a', replace: 'from mcp.server.fastmcp import FastMCP' }]]), ['t (server)']);
  // the agent: the model finishes after writing the skill, is sent back, installs it and answers
  const o = await agentEnv();
  try {
    const s = await o.chat({ approvalMode: 'auto' });
    const r = await o.send(s.id, 'build tool');
    assert.match(r.response, /^After the note: Installed skill "qr"/);
    const msgs = o.agent.get(s.id).messages;
    assert.equal(msgs.filter((m) => m.hidden && /^\[You wrote a tool but did not install it, so it is not available\. Install it now: panel-data\\tools\\qr: install_skill/.test(m.content)).length, 1);
    assert.ok(o.agent.skills().some((k) => k.name === 'qr'), 'the skill is installed');
    // a skill or a written tool folder given to load_tools says what it is and how to use it
    const ctx = o.agent.toolContext(o.agent.get(s.id), new AbortController().signal);
    assert.match(await TOOLS.find((t) => t.name === 'load_tools').run({ names: ['qr'] }, ctx), /"qr" is a skill, not a tool: read it with load_skill/);
    // an MCP server script installed as a skill: the note asks for add_mcp_server
    const s2 = await o.chat({ approvalMode: 'auto' });
    assert.equal((await o.send(s2.id, 'build server')).response, 'After the server note.');
    assert.match(await TOOLS.find((t) => t.name === 'load_tools').run({ names: ['qrs-missing', 'qrs'] }, ctx), /"qrs" is a skill[\s\S]*Not available: qrs-missing/);
    mkdirSync(join(o.agent.setting.dataRoot, 'tools', 'plain'), { recursive: true });
    assert.match(await TOOLS.find((t) => t.name === 'load_tools').run({ names: ['plain'] }, ctx), /"plain" is a folder you wrote \(panel-data\\tools\\plain\), not a tool: an MCP server script in it becomes tools with add_mcp_server/);
    // the same call with the same result: told at the second, stopped at the fourth (not 15 times to the step limit)
    const s3 = await o.chat({ approvalMode: 'auto' });
    const r3 = await o.send(s3.id, 'repeat load');
    assert.match(r3.response, /^Stopped: the same load_tools call kept giving the same result/);
    const results = o.agent.get(s3.id).messages.filter((m) => m.role === 'tool');
    assert.equal(results.length, 4);
    assert.match(results[1].content, /You made exactly this call before and got the same result/);
    // the panel's own texts (not the model's) are marked so the Turkish page translates them (user 10.10.2026: "Step
    // limit reached (40)" stayed English in a Turkish chat); the dictionary has them
    assert.equal(o.agent.get(s3.id).messages.at(-1).panel, true);
    assert.match(translate(r3.response, 'tr'), /^Durdum: aynı load_tools çağrısı hep aynı sonucu verdi \(/);
    const s4 = await o.chat({ approvalMode: 'auto', stepLimit: 2 });
    const r4 = await o.send(s4.id, 'repeat load');
    assert.equal(r4.response, 'Step limit reached (2). Write if you want me to continue.');
    assert.equal(o.agent.get(s4.id).messages.at(-1).panel, true);
    assert.equal(translate(r4.response, 'tr'), 'Adım sınırına ulaşıldı (2). Devam etmemi istiyorsanız yazın.');
    assert.equal(translate('I could not do this: run_command failed again the same way ("exit code 1"). I tried other ways too. How should I go on?', 'tr'), 'Bunu yapamadım: run_command yine aynı şekilde başarısız oldu ("çıkış kodu 1"). Başka yolları da denedim. Nasıl devam edeyim?');
    const chatPage = readFileSync(fileURLToPath(new URL('../web/chat.js', import.meta.url)), 'utf8');
    assert.match(chatPage, /translate: panel \|\| error \? 'yes' : 'no'/, 'a panel text or an error bubble is translated, the model answer is not');
    // a SKILL.md written here without a description is refused with what to add
    const bare = join(o.p.root, 'bare-skill');
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'SKILL.md'), '# QR Generator Skill\n\nMakes QR codes.');
    const b = o.agent.toolContext(o.agent.get(s.id), new AbortController().signal);
    await assert.rejects(TOOLS.find((t) => t.name === 'install_skill').run({ source: bare }, b), /SKILL\.md has no description: start it with front matter/);
    // the folder given as skill (the model's wrong call) is the source; nothing to install is an error, not a plain answer
    writeFileSync(join(bare, 'SKILL.md'), '---\nname: bare\ndescription: Makes QR codes\n---\nRun it.');
    assert.match(await TOOLS.find((t) => t.name === 'install_skill').run({ skill: bare }, b), /Installed skill "bare"/);
    await assert.rejects(TOOLS.find((t) => t.name === 'install_skill').run({ skill: 'no-such-folder' }, b), /Give source/);
    await assert.rejects(TOOLS.find((t) => t.name === 'install_plugin').run({ plugin: 'document-skills' }, b), /Give source/);
    await assert.rejects(TOOLS.find((t) => t.name === 'add_mcp_server').run({ name: 'x' }, b), /Give command/);
  } finally {
    await o.close();
  }
});

test('a skill installed in the chat is found at once, not after the skill list cache expires (10.10.2026: "0 installed" right after install_plugin)', async () => {
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    const b = o.agent.toolContext(o.agent.get(s.id), new AbortController().signal);
    const run = (name, g) => TOOLS.find((t) => t.name === name).run(g, b);
    assert.match(await run('load_skill', { query: 'pdf' }), /No installed skill matches "pdf"/);
    const source = join(o.p.root, 'pdf-skill');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: pdf\ndescription: Read and merge PDF files\n---\nUse pypdf.');
    assert.match(await run('install_skill', { source }), /Installed skill "pdf"/);
    assert.match(await run('load_skill', { query: 'pdf' }), /^- pdf: Read and merge PDF files/);
    assert.match(await run('load_skill', { name: 'pdf' }), /Skill: pdf[\s\S]*Use pypdf\./);
    assert.match(await run('install_skill', { remove: 'pdf-skill' }), /Skill removed/);
    assert.match(await run('load_skill', { query: 'pdf' }), /No installed skill matches "pdf"/);
  } finally {
    await o.close();
  }
});

test('large work in parts: read_file says the range and what comes next first, write_file appends, a cut answer does not end the turn', async () => {
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    const b = o.agent.toolContext(o.agent.get(s.id), new AbortController().signal);
    const run = (name, g) => TOOLS.find((t) => t.name === name).run(g, b);
    // a 1452-line page: the note on the next part comes first, so a cut never hides it
    const page = join(o.p.root, 'big.html');
    writeFileSync(page, Array.from({ length: 1452 }, (_, i) => `<div class="row-${i}">${'x'.repeat(60)}</div>`).join('\n'));
    const first = await run('read_file', { path: page });
    const m = /^.*big\.html: lines 1-(\d+) of 1452; more: read_file with start_line=(\d+)\n/.exec(first);
    assert.ok(m && Number(m[2]) === Number(m[1]) + 1 && first.length <= 12000, first.slice(0, 200));
    assert.match(await run('read_file', { path: page, start_line: Number(m[2]) }), new RegExp(`big\\.html: lines ${m[2]}-`));
    // a long file in parts
    const out = join(o.p.root, 'parts.txt');
    await run('write_file', { path: out, text: 'part one\n' });
    await run('write_file', { path: out, text: 'part two\n', append: true });
    assert.equal(readFileSync(out, 'utf8'), 'part one\npart two\n');
    // the model stops at the output limit with half a tool call: it is told and the turn goes on
    const r = await o.send(s.id, 'cut answer');
    assert.match(r.response, /^EN: \[Your last answer was cut off at the output limit/);
    const msgs = o.agent.get(s.id).messages;
    assert.ok(msgs.some((x) => x.role === 'assistant' && x.cut) && msgs.some((x) => x.role === 'user' && x.hidden), 'the cut answer and the hidden note are kept');
    // a whole file written into the answer and cut: the user still sees it, the model gets it back short (it filled the
    // context, the chat was compacted and the model started again) and is told where files go
    const f = await o.send(s.id, 'file in answer');
    assert.match(f.response, /^Got back \d+ characters: \[Your last answer was cut off at the output limit \(\d+ characters\) and nothing was saved: you wrote a file's content into the answer/);
    assert.ok(Number(/^Got back (\d+)/.exec(f.response)[1]) < 1000, `the cut answer goes back short: ${f.response.slice(0, 40)}`);
    assert.ok(o.agent.get(s.id).messages.some((x) => x.cut && x.content.length > 9000), 'the full answer stays in the chat');
    // a write_file cut at the output limit keeps its whole lines and the model is told where to go on (user idea:
    // "14k'da kes, sonra kalanı"); unfinished JSON arguments and a call the server closed with a half line
    const cwd = o.agent.get(s.id).cwd ?? b.cwd;
    const j = await o.send(s.id, 'cut write json');
    assert.equal(readFileSync(join(cwd, 'parca.txt'), 'utf8'), 'line 1\nline 2\n');
    assert.match(j.response, /^Salvaged: .*only the first 2 whole lines of this text were written, the unfinished line after them was left out\. The file now ends with: "line 2"\. Go on right after that line with write_file append: true/s);
    await o.send(s.id, 'cut write closed');
    assert.equal(readFileSync(join(cwd, 'parca2.txt'), 'utf8'), 'a\nb\nc\n', 'the half last line is not written');
    // finishing right after a failed call: the model is sent back once to fix it or say what did not get done
    const failed = await o.send(s.id, 'read http://127.0.0.1:1/nothing');
    assert.match(failed.response, /^Result \(fetch_web\): /);
    assert.equal(o.agent.get(s.id).messages.filter((x) => x.hidden && /^\[Your last tool call failed \(.+\) and you were about to finish\./.test(x.content)).length, 1);
    // the cut file written again from the start is refused (it lost its lines and stopped sooner each time); append goes on
    await o.send(s.id, 'cut then rewrite');
    assert.equal(readFileSync(join(cwd, 'parca3.txt'), 'utf8'), 'one\ntwo\nthree\n');
    const pathless = await o.send(s.id, 'cut then pathless');
    assert.equal(readFileSync(join(cwd, 'parca5.txt'), 'utf8'), 'a\nb\nhalf\nc\n', 'a part cut before its path goes to the file cut earlier');
    assert.match(pathless.response, /^Ended: Appended: .*parca5\.txt .*were written \(appended\)/s);
    const dup = await o.send(s.id, 'append whole file');
    assert.match(dup.response, /^Ended: The text starts like dup\.html itself \("<!DOCTYPE html>"\): appending it would put a second copy after the file\./);
    assert.equal(readFileSync(join(cwd, 'dup.html'), 'utf8'), '<!DOCTYPE html>\n<p>one</p>\n');
    const next = await o.send(s.id, 'cut then next part');
    assert.equal(readFileSync(join(cwd, 'parca4.txt'), 'utf8'), 'a\nb\nhalf\nc\n', 'the next part without append: true goes to the end');
    assert.match(next.response, /append: true was missing: this part was added to the end of the file/);
    assert.ok(o.agent.get(s.id).messages.some((x) => x.role === 'tool' && x.error && /^parca3\.txt already has 2 lines from your write that stopped at the output limit\. .*append: true, starting right after the line: "two"$/.test(x.content)), 'the rewrite from the start is refused');
    // a short whole-file write over a big file is refused once (the first part of a rewrite replaced a finished page)
    const shrink = await o.send(s.id, 'shrink rewrite');
    assert.match(shrink.response, /^Ended: Overwritten: /);
    assert.equal(readFileSync(join(cwd, 'shrunk.html'), 'utf8'), 'short\n', 'sent again, the shortening goes through');
    assert.ok(o.agent.get(s.id).messages.some((x) => x.role === 'tool' && x.error && x.content.startsWith('shrunk.html has 301 lines and this text has 2: writing it would delete the other 299 lines. To fix a few places, use edit_file. To write a new version in parts, write it to another file (e.g. shrunk.new.html,')), 'the first short write is refused');
    // the same failing call: 2nd time "find another way", 3rd time "ask the user for an idea", then the user is asked
    // and the answer goes to the model (no empty repeats, no stop)
    const from = o.agent.get(s.id).messages.length;
    const againP = o.send(s.id, 'broken write');
    await o.p.waitForState(() => o.agent.get(s.id).status === 'question', 20000);
    const q = o.agent.summary(o.agent.get(s.id)).question;
    assert.match(q.question, /^I could not do this: write_file failed again the same way \("Missing parameter: path/);
    assert.equal((await o.call(`/api/v1/chat/${s.id}/answer`, { method: 'POST', body: { id: q.id, answer: 'give the path first' } })).code, 200);
    await o.p.waitForState(() => o.agent.get(s.id).messages.some((x) => x.role === 'tool' && /The user answered: give the path first — follow this/.test(x.content)), 20000);
    const results = o.agent.get(s.id).messages.slice(from).filter((x) => x.role === 'tool' && x.toolName === 'write_file').slice(0, 3);
    assert.deepEqual(results.map((x) => [/find another way/.test(x.content), /ask the user with ask_user/i.test(x.content)]), [[false, false], [true, false], [false, true]]);
    await o.call(`/api/v1/chat/${s.id}/stop`, { method: 'POST' });
    await againP;
    // where nobody can answer (API, scheduled task) the turn ends with what failed
    const silent = await o.chat({ canAsk: false });
    const ended = await o.send(silent.id, 'broken write');
    assert.match(ended.response, /^Stopped: the same write_file call kept failing the same way \(Missing parameter: path/);
  } finally {
    await o.close();
  }
});

test('a cut write_file: path and text so far from unfinished JSON, a <tool> block or Gemma call syntax', () => {
  assert.deepEqual(partialWrite('{"path":"a.html","text":"<p>\\"x\\"</p>\\nnext \\u00'), { path: 'a.html', text: '<p>"x"</p>\nnext ', append: false });
  assert.deepEqual(partialWrite('Writing: <tool>{"name":"write_file","input":{"path":"b.txt","append":true,"text":"1\\n2'), { path: 'b.txt', text: '1\n2', append: true });
  assert.deepEqual(partialWrite('call:write_file{path:<|"|>C:\\x\\c.css<|"|>,text:<|"|>body { color: red; }\n.a {'), { path: 'C:\\x\\c.css', text: 'body { color: red; }\n.a {', append: false });
  // the text came first and the path never did: the text without a path (the agent uses the one file cut in this run)
  assert.deepEqual(partialWrite('{"content":"<html>\\n<body>'), { path: null, text: '<html>\n<body>', append: true });
  assert.equal(partialWrite('{"path":"x.txt"'), null);
});

test('Settings › Network: listen address saved for the next start (the port stays the default); restart', async () => {
  let restarts = 0;
  const p = await createPanel({ server: true, restart: () => (restarts += 1) });
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(p.address + path, { method, headers: { Authorization: `Bearer ${p.settingFile.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, json: await r.json().catch(() => ({})) };
  };
  try {
    const before = (await call('/api/v1/settings')).json.listen;
    assert.deepEqual(before.defaults, JSON.parse(readFileSync(join(p.setting.panelRoot, 'defaults.json'), 'utf8')), 'defaults from panel\\defaults.json');
    assert.deepEqual(before.saved, { address: null, port: null });
    assert.equal(before.restart, true);
    const saved = await call('/api/v1/settings', { method: 'PATCH', body: { listenAddress: '127.0.0.1' } });
    assert.equal(saved.code, 200);
    assert.deepEqual([saved.json.listen, saved.json.restartNeeded], [{ address: '127.0.0.1', port: null }, true]);
    assert.match(saved.json.message, /this computer only; restart/);
    // written for this installation: settings.mjs reads it at the next start; the port is the default
    const next = loadSettings({ aiRoot: p.setting.aiRoot, dataRoot: p.setting.dataRoot });
    assert.deepEqual([next.address, next.port], ['127.0.0.1', before.defaults.port]);
    assert.equal((await call('/api/v1/settings', { method: 'PATCH', body: { port: 1080 } })).code, 400, 'the port is not a setting');
    assert.equal((await call('/api/v1/settings', { method: 'PATCH', body: { listenAddress: '8.8.8.8' } })).code, 400);
    // Restart: the hook runs (after the answer); it comes back on the saved address
    const r = await call('/api/v1/restart', { method: 'POST' });
    assert.deepEqual([r.code, r.json.port, r.json.address], [200, before.defaults.port, '127.0.0.1']);
    await new Promise((ok) => setTimeout(ok, 600));
    assert.equal(restarts, 1);
  } finally {
    await p.close();
  }
});

test('text model memory: unloaded after the idle time, kept loaded with 0; setting saved through PATCH /settings', async () => {
  const keep = { min: 0 };
  const llm = await fakeLlm({ keepFor: () => keep.min * 60 });
  try {
    assert.equal(llm.keepLoaded, true);
    assert.equal(await llm.preload(), true, 'preload loads the model without a request');
    assert.ok(llm.proc);
    await new Promise((ok) => setTimeout(ok, 1200));
    assert.ok(llm.proc, 'kept loaded while idle');
    keep.min = 0.01; // 0.6 s
    llm.idleSchedule();
    await new Promise((ok) => setTimeout(ok, 1500));
    assert.equal(llm.proc, null, 'unloaded after the idle time');
    assert.equal(llm.keepLoaded, false);
  } finally {
    await llm.close();
  }
  const o = await agentEnv();
  try {
    assert.equal((await o.call('/api/v1/settings')).json.textModelIdleMin, 5, 'default 5 min');
    const r = await o.call('/api/v1/settings', { method: 'PATCH', body: { textModelIdleMin: 0 } });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    assert.match(r.json.message, /stays in memory|bellekte kalır/);
    assert.equal((await o.call('/api/v1/settings')).json.textModelIdleMin, 0);
    assert.equal((await o.call('/api/v1/settings', { method: 'PATCH', body: { textModelIdleMin: 7 } })).code, 400);
    // The chat list tells the chat Options the prompt translation state
    assert.equal((await o.call('/api/v1/chat')).json.translatePrompt, true);
  } finally {
    await o.close();
  }
});

test('chat: auto compact can be turned off per chat; the summary shows how full the context is', async () => {
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    assert.equal(s.autoCompact, true);
    await o.send(s.id, 'hello');
    const c = (await o.call(`/api/v1/chat/${s.id}`)).json.chat.context;
    assert.ok(c.used > 0 && c.size > 0, JSON.stringify(c));
    assert.equal((await o.call(`/api/v1/chat/${s.id}`, { method: 'PATCH', body: { autoCompact: false } })).json.chat.autoCompact, false);
    // Off: a full context trims old tool outputs but does not summarize the conversation
    o.llm.context = 8192;
    const b = o.agent.create({ full: true, autoCompact: false });
    const long = 'x'.repeat(20000);
    const t = (i) => ({ role: 'tool', toolId: `c${i}`, toolName: 'read_file', content: long, time: new Date().toISOString() });
    b.messages.push({ role: 'user', content: 'first', attachments: [] }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', input: {} }] }, ...[1, 2, 3, 4, 5].map(t), { role: 'user', content: 'second', attachments: [] }, { role: 'assistant', content: '', toolCalls: [{ id: 'c6', name: 'read_file', input: {} }] }, ...[6, 7, 8, 9, 10].map(t));
    await o.agent.contextFit(b, new AbortController().signal);
    assert.ok(b.messages.slice(2, 6).every((m) => m.truncated), 'old tool outputs trimmed');
    assert.equal(b.trimmed, 0, 'not summarized');
    assert.equal(b.summary, '');
  } finally {
    await o.close();
  }
});

test('file edits: diff on the tool result, undo restores the previous content (a created file goes away), conflicts need force, the model is told', async () => {
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.equal(d.text, '@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d');
  assert.deepEqual([d.added, d.removed], [2, 1]);
  assert.equal(unifiedDiff(null, 'x\n').text, '@@ -0,0 +1,1 @@\n+x');
  assert.equal(unifiedDiff('same\n', 'same\n').text, '');
  const o = await agentEnv();
  const file = join(o.p.setting.aiRoot, 'yazilan.txt');
  try {
    const s = await o.chat({});
    await o.send(s.id, 'write first content');
    await o.send(s.id, 'write second content');
    const tools = (await o.call(`/api/v1/chat/${s.id}`)).json.chat.messages.filter((m) => m.role === 'tool' && m.toolName === 'write_file');
    const [one, two] = tools.map((m) => m.extra.edit);
    assert.equal(one.diff, '@@ -0,0 +1,1 @@\n+first content');
    assert.equal(two.diff, '@@ -1,1 +1,1 @@\n-first content\n+second content');
    assert.match(tools[1].content, /\+1 -1 lines/);
    // Undo the second edit: the first content is back; the next message tells the model
    const u = await o.call(`/api/v1/chat/${s.id}/undo`, { method: 'POST', body: { checkpoint: two.checkpoint } });
    assert.equal(u.code, 200, JSON.stringify(u.json));
    assert.equal(readFileSync(file, 'utf8'), 'first content');
    assert.equal((await o.call(`/api/v1/chat/${s.id}/undo`, { method: 'POST', body: { checkpoint: two.checkpoint } })).code, 400, 'already undone');
    o.agent.get(s.id).messages.push({ role: 'user', content: 'next', attachments: [] });
    const sent = await o.agent.translateMessages(o.agent.get(s.id), null);
    assert.match(sent.at(-1).content, /^\[The user undid your change to .+yazilan\.txt; its previous content is back\.\]\n\nnext$/);
    o.agent.get(s.id).messages.pop();
    assert.equal((await o.call(`/api/v1/chat/${s.id}`)).json.chat.messages.find((m) => m.extra?.edit?.checkpoint === two.checkpoint).extra.edit.undone, true);
    // Conflict: the file changed after the first edit -> 409, force undoes it (the created file goes to the Recycle Bin)
    writeFileSync(file, 'changed by hand');
    const c = await o.call(`/api/v1/chat/${s.id}/undo`, { method: 'POST', body: { checkpoint: one.checkpoint } });
    assert.equal(c.code, 409);
    assert.match(c.json.error, /changed after this edit|sonra değişti/);
    assert.equal((await o.call(`/api/v1/chat/${s.id}/undo`, { method: 'POST', body: { checkpoint: one.checkpoint, force: true } })).code, 200);
    assert.equal(existsSync(file), false, 'created file removed');
    // Deleting the chat removes its copies
    await o.call(`/api/v1/chat/${s.id}`, { method: 'DELETE' });
    assert.equal(existsSync(join(o.p.setting.dataRoot, 'chat', 'checkpoints', s.id)), false);
  } finally {
    await o.close();
  }
});

test('rules: Settings › Assistant rules and the project files (NEDESE.md, AGENTS.md) above the working folder go into the system prompt', async () => {
  const o = await agentEnv();
  try {
    assert.equal((await o.call('/api/v1/chat/rules')).json.text, '');
    const saved = await o.call('/api/v1/chat/rules', { method: 'PATCH', body: { text: '- Always end with: — Nedese' } });
    assert.equal(saved.code, 200, JSON.stringify(saved.json));
    assert.equal(readFileSync(join(o.p.setting.dataRoot, 'rules.md'), 'utf8'), '- Always end with: — Nedese\n');
    const project = join(o.p.setting.aiRoot, 'proj');
    const sub = join(project, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'NEDESE.md'), 'Use tabs in this folder.');
    writeFileSync(join(project, 'AGENTS.md'), 'Tests run with npm test.');
    const s = await o.chat({ cwd: sub });
    const d = (await o.call(`/api/v1/chat/${s.id}`)).json.chat;
    assert.deepEqual(d.rules.map((r) => r.source).slice(0, 3), ['Settings › Assistant rules', 'NEDESE.md', 'AGENTS.md'], 'panel rules, then nearest project file first');
    const prompt = o.agent.systemPrompt(o.agent.get(s.id), o.agent.tools(o.agent.get(s.id)));
    const at = prompt.indexOf('RULES FROM THE USER');
    assert.ok(at > 0 && prompt.indexOf('Always end with: — Nedese') > at && prompt.indexOf('Use tabs in this folder.') > at && prompt.indexOf('Tests run with npm test.') > prompt.indexOf('Use tabs in this folder.'));
    // Cleared: no rules section for a chat without project files
    assert.equal((await o.call('/api/v1/chat/rules', { method: 'PATCH', body: { text: '' } })).code, 200);
    const plain = await o.chat({});
    const plainPrompt = o.agent.systemPrompt(o.agent.get(plain.id), o.agent.tools(o.agent.get(plain.id)));
    assert.ok(!plainPrompt.includes('RULES FROM THE USER'));
    // Missing tools: the panel's installers only, else build it; the folder is written with real backslashes (a lone
    // backslash in the template made "panel-data<TAB>ools", 10.10.2026) and no control character is in the prompt
    assert.ok(plainPrompt.includes('a folder panel-data\\tools\\<name> with SKILL.md'));
    assert.match(plainPrompt, /never with another installer \(npx skills/);
    assert.doesNotMatch(plainPrompt, /[\x00-\x08\x0b-\x1f]/);
    assert.equal((await o.call('/api/v1/chat/rules', { method: 'PATCH', body: { text: 'x'.repeat(20001) } })).code, 400);
  } finally {
    await o.close();
  }
});

test('ask_user: the chat waits in the question state, the answer goes to the model; no asking where nobody can answer', async () => {
  const o = await agentEnv();
  try {
    const s = await o.chat({});
    const eventP = o.events(s.id);
    await eventP.ready;
    const sent = o.send(s.id, 'ask me something');
    await o.p.waitForState(() => o.agent.get(s.id).status === 'question');
    const q = (await o.call(`/api/v1/chat/${s.id}`)).json.chat.question;
    assert.deepEqual([q.question, q.options], ['Which database?', ['PostgreSQL', 'SQLite']]);
    assert.equal((await o.call(`/api/v1/chat/${s.id}/answer`, { method: 'POST', body: { id: 'wrong', answer: 'x' } })).code, 404);
    assert.equal((await o.call(`/api/v1/chat/${s.id}/answer`, { method: 'POST', body: { id: q.id, answer: '' } })).code, 400);
    assert.equal((await o.call(`/api/v1/chat/${s.id}/answer`, { method: 'POST', body: { id: q.id, answer: 'SQLite' } })).code, 200);
    assert.equal((await sent).response, 'Result (ask_user): The user answered: SQLite');
    const events = await eventP.list;
    assert.ok(events.some((x) => x.type === 'question' && x.question === 'Which database?'));
    assert.ok(events.some((x) => x.type === 'question_done' && x.answer === 'SQLite'));
    // API completions and scheduled tasks have nobody to ask
    const quiet = o.agent.create({ full: true, canAsk: false });
    assert.ok(!o.agent.tools(quiet).some((t) => t.name === 'ask_user'));
    assert.ok(o.agent.tools(o.agent.get(s.id)).some((t) => t.name === 'ask_user'));
    // Stop while asking: the chat goes idle
    const again = o.send(s.id, 'ask me again', { wait: false });
    await again;
    await o.p.waitForState(() => o.agent.get(s.id).status === 'question');
    await o.call(`/api/v1/chat/${s.id}/stop`, { method: 'POST' });
    await o.p.waitForState(() => o.agent.get(s.id).status === 'idle');
  } finally {
    await o.close();
  }
});

test('Artifacts (user request 10.10.2026, like Claude): an HTML or SVG file the agent writes goes with its result whole (up to 512 KB), other files and larger pages do not', () => {
  assert.deepEqual(artifactOf('C:\site\Index.HTML', '<h1>x</h1>'), { path: 'C:\site\Index.HTML', kind: 'html', content: '<h1>x</h1>' });
  assert.equal(artifactOf('/a/logo.svg', '<svg/>').kind, 'svg');
  assert.equal(artifactOf('/a/page.htm', '').kind, 'html');
  assert.equal(artifactOf('/a/app.js', 'x'), null);
  assert.equal(artifactOf('/a/notes.txt', '<html>'), null);
  assert.equal(artifactOf('/a/big.html', 'x'.repeat(512 * 1024)).kind, 'html');
  assert.equal(artifactOf('/a/big.html', 'x'.repeat(512 * 1024 + 1)), null);
});
