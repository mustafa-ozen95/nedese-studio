/**
 * CLI (panel/cli/nedese.mjs) against a test panel with the fake text model, through a fake terminal: the "/" menu with
 * descriptions, arrow keys, /mode, an approval answered with "y", tool lines, print mode (-p) and --continue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer as netServer } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLlm } from '../lib/llm.mjs';
import { createPanel } from './env.mjs';
import { Panel, main, parseArgs, setStreams, translator } from '../cli/nedese.mjs';

const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

/** A terminal: input takes keystrokes, output collects everything written (columns 100). */
function fakeTerminal(tty = true) {
  const input = new PassThrough();
  input.isTTY = tty;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = tty;
  output.columns = 100;
  output.rows = 40;
  let text = '';
  output.on('data', (d) => { text += d.toString('utf8'); });
  const error = new PassThrough();
  error.isTTY = false;
  let errText = '';
  error.on('data', (d) => { errText += d.toString('utf8'); });
  return {
    input,
    output,
    error,
    get text() { return text; },
    get errText() { return errText; },
    plain: () => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
    async until(check, ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (check(text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))) return true;
        await new Promise((ok) => setTimeout(ok, 30));
      }
      throw new Error(`Terminal did not show the expected text. Last output:\n${text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-1500)}`);
    },
    type: async (s) => {
      input.write(s);
      await new Promise((ok) => setTimeout(ok, 60));
    },
  };
}

test('CLI units: arguments, Turkish through the panel dictionary', () => {
  const o = parseArgs(['-p', '--mode', 'auto', 'fix', 'it'], {});
  assert.equal(o.print, true);
  assert.equal(o.mode, 'auto');
  assert.deepEqual(o.words, ['fix', 'it']);
  assert.equal(parseArgs(['-r'], {}).resume, '');
  assert.equal(parseArgs(['-r', 'abc'], {}).resume, 'abc');
  assert.equal(parseArgs([], { NEDESE_URL: 'http://x:1', NEDESE_LANG: 'tr' }).url, 'http://x:1');
  assert.throws(() => parseArgs(['--mode', 'never'], {}), /manual, edits or auto/);
  assert.throws(() => parseArgs(['--what'], {}), /Unknown option/);
  const t = translator({ 'Done · {0} s': 'Bitti · {0} sn', Done: 'Bitti' });
  assert.equal(t('Done · 4 s'), 'Bitti · 4 sn');
  assert.equal(t('Done'), 'Bitti');
  assert.equal(t('other'), 'other');
});

test('CLI chat in a fake terminal: "/" menu, /mode, approval with y, tool lines, print mode, continue', async () => {
  const llm = new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', image: true, command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port)] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
  const p = await createPanel({ server: true, llm, setting: { localClientTrust: false, agentPollingMs: 50, agentBrowser: false } });
  const args = ['--url', p.address, '--key', p.settingFile.apiKey, '--no-color'];
  const written = join(process.cwd(), 'yazilan.txt');
  try {
    // Interactive
    const term = fakeTerminal();
    setStreams(term);
    const done = main(args);
    await term.until((s) => s.includes('"/" lists the commands'));
    await term.type('/');
    await term.until((s) => s.includes('/compact') && s.includes('Summarize the conversation so far') && s.includes('/exit') && s.includes('Quit'));
    await term.type('mo');
    await term.until((s) => s.includes('Approval mode: manual, edits or auto'));
    await term.type('\t'); // Tab completes "/mode " and lists the modes
    await term.until((s) => s.includes('Asks before every change'));
    await term.type('\r'); // Enter picks the highlighted mode (manual) and runs it
    await term.until((s) => s.includes('mode: manual'));
    // /thinking: the level of the chat (it opens with the first message and takes it)
    await term.type('/thinking\r');
    await term.until((s) => s.includes('thinking: low') && s.includes('/thinking none | low | medium | high'));
    await term.type('/thinking high\r');
    await term.until((s) => s.includes('thinking: high'));
    await term.type('run command\r');
    await term.until((s) => s.includes('● Command echo hello') && s.includes('Output: [exit code 0'));
    await term.until((s) => /tokens · \d+ s/.test(s));
    assert.equal(process.title, 'run command · Nedese', 'the window title shows the chat');
    // manual mode: writing a file waits for the approval asked in the terminal
    await term.type('write from the cli\r');
    await term.until((s) => s.includes('Approval needed') && s.includes('[y] yes'));
    await term.type('y');
    await term.until((s) => s.includes('Written.'));
    assert.equal(readFileSync(written, 'utf8'), 'from the cli');
    assert.ok(term.plain().includes('+from the cli'), 'the diff line of the edit is shown');
    // /undo: the created file goes away
    // ask_user: the question and its options in the terminal; "2" picks the second option
    await term.type('ask me\r');
    await term.until((s) => s.includes('Which database?') && s.includes('2. SQLite'));
    await term.type('2\r');
    await term.until((s) => s.includes('The user answered: SQLite'));
    await term.type('/undo\r');
    await term.until((s) => /Undone: .*yazilan\.txt/.test(s));
    assert.equal(existsSync(written), false);
    // /regenerate: the last request again, a new answer; the old one stays as version 1
    const turns = (s) => (s.match(/tokens · \d+ s/g) ?? []).length;
    const before = turns(term.plain());
    await term.type('say twice\r');
    await term.until((s) => turns(s) === before + 1);
    await term.type('/regenerate\r');
    await term.until((s) => turns(s) === before + 2);
    assert.match(term.plain().slice(term.plain().lastIndexOf('/regenerate')), /● EN: [\s\S]*say twice/, 'the answer written again');
    const chats = (await (await fetch(`${p.address}/api/v1/chat`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json()).chats;
    assert.equal(chats.length, 1);
    assert.equal(chats[0].approvalMode, 'manual');
    assert.equal(chats[0].thinking, 'high', '/thinking before the first message applies to the new chat');
    assert.equal(chats[0].cwd, process.cwd(), 'the chat works in the folder the CLI was started in');
    const regenerated = (await (await fetch(`${p.address}/api/v1/chat/${chats[0].id}`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json()).chat;
    assert.deepEqual(regenerated.forks.map((f) => [f.version, f.count]), [[2, 2]], '/regenerate kept the first answer as version 1');
    const titleBefore = process.title;
    await term.type('/exit\r');
    assert.equal(await done, 0);
    assert.notEqual(process.title, titleBefore, 'the old window title comes back on exit');

    // Print mode: the answer on stdout, tool lines on stderr
    const pipe = fakeTerminal(false);
    setStreams(pipe);
    assert.equal(await main([...args, '-p', 'run command']), 0);
    assert.match(pipe.text, /^Output: \[exit code 0/);
    assert.match(pipe.errText, /● Command echo hello/);

    // --continue: the latest chat of this folder (the print mode chat), no new chat
    const again = fakeTerminal(false);
    setStreams(again);
    assert.equal(await main([...args, '-p', '-c', 'say hi']), 0);
    assert.match(again.text, /EN: say hi/);
    const after = (await (await fetch(`${p.address}/api/v1/chat`, { headers: { Authorization: `Bearer ${p.settingFile.apiKey}` } })).json()).chats;
    assert.equal(after.length, 2, 'continue used the existing chat');

    // A stream that delivers nothing (not connected yet under load, or dropped): the turn still ends with its answer,
    // from the chat state (the full test run once hung here waiting for a missed "done")
    const original = Panel.prototype.events;
    Panel.prototype.events = () => ({ close() {} });
    try {
      const deaf = fakeTerminal(false);
      setStreams(deaf);
      const started = Date.now();
      assert.equal(await main([...args, '-p', 'say late']), 0);
      assert.match(deaf.text, /EN: say late/);
      assert.ok(Date.now() - started < 20000, 'finished from the chat state');
    } finally {
      Panel.prototype.events = original;
    }
  } finally {
    setStreams({ input: process.stdin, output: process.stdout, error: process.stderr });
    if (existsSync(written)) rmSync(written);
    await llm.close();
    await p.close();
  }
});
