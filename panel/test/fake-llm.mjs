/**
 * Sahte llama-server: node sahte-llm.mjs <port>. /health, /v1/chat/completions (OpenAI bicimi).
 * response_format json_object ise JSON doner; degilse "EN: <son kullanici mesaji>".
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2]);
// Model file the fake was started with (a chat can use its own text model)
const MODEL = process.argv[3] ?? 'fake';

// follow-up suggestion requests answered (each answer names its number: a kept list is not asked again)
let followUpCount = 0;

const getText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '');

/** The http(s) addresses in the skills' guidance of a data collection prompt, in order, each once. */
const guidanceAddresses = (text) => {
  const part = /Guidance from skills[^\n]*\n([\s\S]*?)(?:\n\n(?:Tools you may call|Also name up to)|$)/.exec(text)?.[1] ?? '';
  return [...new Set([...part.matchAll(/https?:\/\/[^\s"'<>)`]+/g)].map((x) => x[0].replace(/[.,;:]+$/, '')))];
};

/**
 * Sahte ajan: son kullanici istegine ve son arac sonucuna gore bir arac cagirir ya da bitirir. Yerli kip (g.tools var):
 * tool_calls; metin kipi: <tool> bloklari. "block" istegi her kipte metin blogu dondurur (sablon ayristirmadiysa yedek).
 */
function agentResponse(g) {
  // the agent's note after a failed last call ("fix it or say what did not get done") is answered like the call itself
  const m = /^\[Your last tool call failed/.test(getText(g.messages.at(-1)?.content)) ? g.messages.slice(0, -1) : g.messages;
  const lastMessage = m.at(-1);
  let lastTool = null;
  if (lastMessage.role === 'tool') lastTool = { name: lastMessage.name, text: String(lastMessage.content ?? '') };
  else if (lastMessage.role === 'user' && /^\[tool result (\S+)\]/.test(getText(lastMessage.content))) lastTool = { name: /^\[tool result (\S+)\]/.exec(getText(lastMessage.content))[1], text: getText(lastMessage.content).replace(/^\[tool result \S+\]\n?/, '') };
  const req = [...m].reverse().find((x) => x.role === 'user' && !/^\[tool result/.test(getText(x.content)));
  // The send time the agent adds to each user message is not part of the request
  const sent = /\n\[sent ([^\]]*)\]$/.exec(getText(req?.content ?? ''))?.[1] ?? null;
  const text = getText(req?.content ?? '').replace(/\n\[sent [^\]]*\]$/, '');
  const hasImage = Array.isArray(req?.content) && req.content.some((p) => p.type === 'image_url');
  let counter = m.filter((x) => x.role === 'assistant').length;
  const call = (name, input) => {
    counter += 1;
    if (g.tools) return { content: '', tool_calls: [{ id: `call_${counter}`, type: 'function', function: { name: name, arguments: JSON.stringify(input) } }] };
    return { content: `<tool>${JSON.stringify({ name, input })}</tool>` };
  };
  const finish = (content) => ({ content });
  // a model that keeps making the same broken call (no path), whatever the error says
  if (/^broken write/.test(text)) return call('write_file', { content: 'x' });
  // MCP tools as functions: load_tools with the server's name, then the tool by its own function name; the answer
  // tells whether it was offered (native tools list or the text mode's tool list) and with which parameters
  if (/^mcp native/.test(text)) {
    const fn = 'mcp__fake__collect';
    const native = (g.tools ?? []).find((t) => t.function.name === fn);
    const listed = new RegExp(`^- ${fn}: `, 'm').test(getText(m[0]?.content));
    if (!lastTool) return call('load_tools', { names: [/via mcp_tools/.test(text) ? 'mcp_tools' : 'fake'] });
    if (lastTool.name === 'load_tools' && /Loaded: mcp_tools/.test(lastTool.text)) return call('mcp_tools', { server: 'fake' });
    if (lastTool.name === 'load_tools' || lastTool.name === 'mcp_tools') return native || listed ? call(fn, { a: 4, b: 5 }) : finish(`Not offered: ${lastTool.text.slice(0, 400)}`);
    return finish(`Native ${lastTool.name}: ${lastTool.text} | ${native ? `schema ${JSON.stringify(native.function.parameters)}` : listed ? 'listed in the prompt' : 'gone'}`);
  }
  // a cut write, then the whole file again from the start (Bonsai 2 27B did this, 08.10.2026): refused, it appends
  if (/^cut then rewrite/.test(text)) {
    if (!lastTool) return { ...call('write_file', { path: 'parca3.txt', text: 'one\ntwo\nthr' }), finish: 'length' };
    if (/output limit: only/.test(lastTool.text)) return call('write_file', { path: 'parca3.txt', text: 'one\ntwo\nthree\nfour\n' });
    if (/already has/.test(lastTool.text)) return call('write_file', { path: 'parca3.txt', text: 'three\n', append: true });
    return finish(`Ended: ${lastTool.text.slice(0, 200)}`);
  }
  // a cut write, then a next part cut before its path came (Bonsai writes the text first): it goes to the cut file
  if (/^cut then pathless/.test(text)) {
    if (!lastTool) return { ...call('write_file', { path: 'parca5.txt', text: 'a\nb\nhal' }), finish: 'length' };
    if (/lines of this text were written, the unfinished/.test(lastTool.text)) return { content: '', tool_calls: [{ id: 'cut2', type: 'function', function: { name: 'write_file', arguments: '{"text":"half\\nc\\nd' } }], finish: 'length' };
    return finish(`Ended: ${lastTool.text.slice(0, 400)}`);
  }
  // a whole page appended to the file that already holds a page (Gemma did this after copying it): refused
  if (/^append whole file/.test(text)) {
    if (!lastTool) return call('write_file', { path: 'dup.html', text: '<!DOCTYPE html>\n<p>one</p>\n' });
    if (/^Created/.test(lastTool.text)) return call('write_file', { path: 'dup.html', text: '<!DOCTYPE html>\n<p>two</p>\n', append: true });
    return finish(`Ended: ${lastTool.text.slice(0, 300)}`);
  }
  // a big file, then a short whole-file write over it (Bonsai's first part of a rewrite replaced its finished page):
  // refused once, the same call again goes through
  if (/^shrink rewrite/.test(text)) {
    if (!lastTool) return call('write_file', { path: 'shrunk.html', text: 'line\n'.repeat(300) });
    if (/^Created/.test(lastTool.text) || /writing it would delete/.test(lastTool.text)) return call('write_file', { path: 'shrunk.html', text: 'short\n' });
    return finish(`Ended: ${lastTool.text.slice(0, 300)}`);
  }
  // a cut write, then the next part without append: true (Bonsai forgot it and the page lost its start): appended
  if (/^cut then next part/.test(text)) {
    if (!lastTool) return { ...call('write_file', { path: 'parca4.txt', text: 'a\nb\nhal' }), finish: 'length' };
    if (/output limit: only/.test(lastTool.text)) return call('write_file', { path: 'parca4.txt', text: 'half\nc\n' });
    return finish(`Ended: ${lastTool.text.slice(0, 300)}`);
  }
  // four files written and one of them edited in one turn (the turn's edited-files summary)
  if (/^write several files/.test(text)) {
    const step = m.slice(m.lastIndexOf(req)).filter((x) => x.role === 'tool' || (x.role === 'user' && /^\[tool result/.test(getText(x.content)))).length;
    const files = [['app.js', 'const a = 1;\nconst b = 2;\n'], ['style.css', 'body {\n  margin: 0;\n}\n'], ['data.json', '{}\n'], ['notes.md', '# Notes\n']];
    if (step < files.length) return call('write_file', { path: files[step][0], text: files[step][1] });
    if (step === files.length) return call('edit_file', { path: 'app.js', search: 'const b = 2;', replace: 'const b = 3;\nconst c = 4;' });
    return finish('Four files written, app.js edited.');
  }
  // a photo from the web shown in the chat: show_image, then the line it returned goes into the answer
  // an answer that shows pictures from other sites without show_image (Gemma did this with an i.redd.it address)
  if (/^answer pictures /.test(text)) return finish(`Look:\n${text.slice(16).trim().split(/\s+/).map((u, i) => `![picture ${i + 1}](${u})`).join('\n')}`);
  if (/^(web photo|find photo) (.+)/.test(text)) {
    const [, how, what] = /^(web photo|find photo) (.+)/.exec(text);
    if (!lastTool) return call('show_image', how === 'web photo' ? { url: what, caption: 'a cat' } : { query: what });
    return finish(`Here it is:\n${/^!\[.*$/m.exec(lastTool.text)?.[0] ?? `(none) ${lastTool.text.slice(0, 400)}`}`);
  }
  // a search, then one page read: the answer's source links (search results and the read page)
  if (/^research (\S+) (.+)/.test(text)) {
    const [, page, query] = /^research (\S+) (.+)/.exec(text);
    if (!lastTool) return call('search_web', { query });
    if (lastTool.name === 'search_web') return call('fetch_web', { url: page });
    return finish(`From the sources: ${lastTool.text.split('\n')[0]}`);
  }
  if (lastTool) {
    const url = /"url":\s*"([^"]+)"/.exec(lastTool.text)?.[1];
    const jobId = /"job":\s*\{\s*"id":\s*"([^"]+)"/.exec(lastTool.text)?.[1];
    if (lastTool.name === 'panel_api' && jobId) return call('wait_job', { id: jobId, max_min: 2 });
    if (lastTool.name === 'wait_job') return finish(`Ready: ${url ?? lastTool.text.slice(0, 200)}`);
    if (lastTool.name === 'mcp_tools') return call('call_mcp', { server: 'fake', tool: 'collect', input: { a: 2, b: 3 } });
    if (lastTool.name === 'call_mcp') return finish(`Total: ${lastTool.text}`);
    if (lastTool.name === 'sub_agent') return finish(`Parent: ${lastTool.text}`);
    if (lastTool.name === 'run_command') return finish(`Output: ${lastTool.text}`);
    if (lastTool.name === 'search_web') return finish(`Found: ${lastTool.text.slice(0, 3000)}`);
    if (lastTool.name === 'search_chats') return finish(`Chats: ${lastTool.text.slice(0, 3000)}`);
    if (lastTool.name === 'write_file') return finish(/output limit/.test(lastTool.text) ? `Salvaged: ${lastTool.text.slice(0, 600)} | input back: ${JSON.stringify(m.at(-2)?.tool_calls?.[0]?.function?.arguments ?? '').slice(0, 300)}` : 'Written.');
    return finish(`Result (${lastTool.name}): ${lastTool.text.slice(0, 500)}`);
  }
  // any tool with the given input: "call tool watch {"url": "…", "then": "…"}" (background work tests)
  const named = /^call tool (\S+) (\{[\s\S]*\})$/.exec(text);
  if (named) return call(named[1], JSON.parse(named[2]));
  if (/cat image/i.test(text)) return call('panel_api', { method: 'POST', path: '/jobs', body: { type: 'image', prompt: 'a cat', count: 1 } });
  if (/^delete /.test(text)) return call('delete_file', { path: text.slice(7).trim() });
  if (/^run command/.test(text)) return call('run_command', { command: 'echo hello', duration_sec: 30 });
  // text before a tool call (native mode): a step whose words are not the final answer
  if (/^check then run/.test(text)) return g.tools ? { ...call('run_command', { command: 'echo hello', duration_sec: 30 }), content: 'Let me check first.' } : call('run_command', { command: 'echo hello', duration_sec: 30 });
  if (/^block/.test(text)) return { content: 'Writing the file.\n<tool>{"name":"write_file","input":{"path":"deneme.txt","content":"selam"}}</tool>' };
  if (/^subtask:/.test(text)) return call('sub_agent', { task: text.replace(/^subtask:\s*/, '') });
  if (/^mcp/.test(text)) return call('mcp_tools', { server: 'fake' });
  if (/^look (\S+)/.test(text)) return call('look_image', { source: /^look (\S+)/.exec(text)[1], question: 'What is there?' });
  // the user's documents ("search knowledge what to find"; "… in Q3 report" names a document)
  if (/^search knowledge (.+?)(?: in (.+))?$/.test(text)) {
    const [, query, inDoc] = /^search knowledge (.+?)(?: in (.+))?$/.exec(text);
    return call('search_knowledge', { query, ...(inDoc ? { documents: [inDoc] } : {}) });
  }
  // read_file on a chat attachment, from a line ("read file upload/x.pdf from 12")
  if (/^read file (\S+)(?: from (\d+))?/.test(text)) {
    const [, path, from] = /^read file (\S+)(?: from (\d+))?/.exec(text);
    return call('read_file', { path, ...(from ? { start_line: Number(from) } : {}) });
  }
  if (/^read (\S+)/.test(text)) return call('fetch_web', { url: /^read (\S+)/.exec(text)[1] });
  if (/^search the web for /.test(text)) return call('search_web', { query: text.replace(/^search the web for /, '') });
  if (/^search my chats for /.test(text)) return call('search_chats', { query: text.replace(/^search my chats for /, '') });
  if (/^open chat (\S+)/.test(text)) return call('search_chats', { id: /^open chat (\S+)/.exec(text)[1], ...(/ from (\d+)$/.test(text) ? { start: Number(/ from (\d+)$/.exec(text)[1]) } : {}) });
  if (/^schedule/.test(text)) return call('schedule', { task: 'say hello', minute_after: 1 });
  if (/^memory/.test(text)) return call('write_memory', { note: 'the user likes cats' });
  if (/^load skill/.test(text)) return call('load_skill', { name: 'deneme-beceri' });
  if (/^write /.test(text)) return call('write_file', { path: 'yazilan.txt', content: text.slice(6) });
  if (/^which model/.test(text)) return finish(`Model: ${MODEL}`);
  // the assistant preset's part of the system prompt (and that the user's rules still come after it)
  if (/^which preset/.test(text)) {
    const system = getText(m[0]?.content);
    const preset = /ASSISTANT PRESET "([^"]*)"[^\n]*\n([^\n]*)/.exec(system);
    return finish(preset ? `Preset ${preset[1]}: ${preset[2]}${system.indexOf('RULES FROM THE USER') > preset.index ? ' (rules after it)' : ''}` : 'No preset');
  }
  // an answer in Markdown (the web chat renders it), with HTML and a javascript: link that must stay text
  if (/^markdown sample/.test(text)) {
    return finish([
      '## Results',
      'The **two** files, *checked* and ~~guessed~~:',
      '',
      '| File | Size | Status |',
      '|:-----|-----:|:------:|',
      '| `a.png` | 12 KB | ok |',
      '| b.png | 3 KB | **new** |',
      '',
      '1. first step',
      '2. second step',
      '   - detail a',
      '   - detail b',
      '',
      '> Note: see [the docs](https://example.com/docs) or [this](javascript:window.__xss=1).',
      '',
      '---',
      '<img src=x onerror="window.__xss=2"> <script>window.__xss=3</script>',
    ].join('\n'));
  }
  // an answer with an HTML page, an SVG and a script (only the first two get a preview); the page reports to the chat
  // what it could do in its frame
  if (/^preview sample/.test(text)) {
    return finish([
      'A page:',
      '```html',
      '<!doctype html>',
      '<html><head><title>Sample</title></head><body><h1 id="h">waiting</h1><script>',
      "let parentRead = 'blocked'; try { parentRead = parent.document.title; } catch (e) {}",
      "let storage = 'blocked'; try { localStorage.getItem('x'); storage = 'open'; } catch (e) {}",
      "document.getElementById('h').textContent = 'Ran ' + (1 + 1);",
      "fetch('/api/v1/status').then(() => parent.postMessage({ fetch: 'sent' }, '*'), () => parent.postMessage({ fetch: 'blocked' }, '*'));",
      "parent.postMessage({ ran: document.getElementById('h').textContent, parentRead, storage }, '*');",
      '</script></body></html>',
      '```',
      'A circle:',
      '```svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="red"/></svg>',
      '```',
      'And a script:',
      '```js',
      "console.log('no preview');",
      '```',
    ].join('\n'));
  }
  // the model thinks first (reasoning_content), then answers; and the thinking settings the agent sent
  if (/^think about/.test(text)) return { content: `Answer after thinking about ${text.slice(12)}.`, reasoning: `First I consider ${text.slice(12)}. ${'Then I weigh it. '.repeat(Number(process.env.FAKE_LLM_THINK_REPEAT) || 2)}Decided.` };
  if (/^which thinking/.test(text)) return finish(`Thinking: ${g.chat_template_kwargs?.enable_thinking ? 'on' : 'off'}, budget ${g.thinking_budget_tokens ?? 0}`);
  // a long answer (streamed in many pieces; with FAKE_LLM_STREAM_MS it takes a while); "long answer 300": 300 words
  const long = /^long answer(?: (\d+))?/.exec(text);
  if (long) return finish(`${Array.from({ length: Number(long[1] ?? 120) }, (_, i) => `word${i}`).join(' ')} end.`);
  // The tools the agent sent with this request, and the "More tools" line of its system prompt
  // the answer stops at the output limit (a tool call that did not fit): finish_reason "length"
  if (/^cut answer/.test(text)) return { content: 'Writing the whole file now: <tool>{"name":"write_file","input":{"content":"<html>', finish: 'length' };
  // a whole file written into the answer and cut at the output limit (Gemma did this with a 1452-line redesign), and
  // what the model got back after it: the cut answer's length and the note
  if (/^file in answer/.test(text)) return { content: `Here is the new design:\n\`\`\`html\n${'<div class="card">x</div>\n'.repeat(400)}`, finish: 'length' };
  if (/^\[Your last answer was cut off at the output limit \(\d+ characters\)/.test(text)) return finish(`Got back ${getText(m.at(-2)?.content).length} characters: ${text.slice(0, 160)}`);
  // a write_file cut at the output limit: unfinished JSON arguments, or a call the server closed with a half last line
  if (/^cut write json/.test(text)) return { content: '', tool_calls: [{ id: 'cut1', type: 'function', function: { name: 'write_file', arguments: '{"path":"parca.txt","text":"line 1\\nline 2\\nline 3 unfini' } }], finish: 'length' };
  if (/^cut write closed/.test(text)) return { ...call('write_file', { path: 'parca2.txt', text: 'a\nb\nc\nhal' }), finish: 'length' };
  if (/^which tools/.test(text)) return finish(`Tools: ${(g.tools ?? []).map((t) => t.function.name).sort().join(', ')} | ${/^More tools \(add[^\n]*/m.exec(getText(m[0]?.content))?.[0] ?? 'no More tools line'}`);
  if (/^load panel tools/.test(text)) return call('load_tools', { names: ['panel_api', 'wait_job', 'no_such_tool'] });
  if (/^lang\b/.test(text)) return finish(`Marker: ${sent ?? 'none'}`);
  if (/^when did I send/.test(text)) return finish(`Sent: ${sent ?? 'unknown'}; clock in the system prompt: ${/Now: [^\n]*\d\d:\d\d/.test(getText(m[0]?.content)) ? 'yes' : 'no'}`);
  if (/^ask me/.test(text)) return call('ask_user', { question: 'Which database?', options: ['PostgreSQL', 'SQLite'] });
  if (/^endless/.test(text)) return call('run_command', { command: 'echo again', duration_sec: 30 }) && call('list_file', {});
  return finish(`EN: ${text}${hasImage ? ' [saw image]' : ''}`);
}

/**
 * stream: true -> the answer as server-sent chunks: text in pieces, each tool call as name then arguments, usage last.
 * FAKE_LLM_STREAM_MS: pause between text pieces (a model writing in real time).
 */
async function streamAnswer(response, r) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const pause = Number(process.env.FAKE_LLM_STREAM_MS) || 0;
  for (const part of String(r.reasoning ?? '').match(/[\s\S]{1,8}/g) ?? []) {
    chunk({ reasoning_content: part });
    if (pause) await new Promise((ok) => setTimeout(ok, pause));
  }
  for (const part of String(r.content ?? '').match(/[\s\S]{1,8}/g) ?? []) {
    chunk({ content: part });
    if (pause) await new Promise((ok) => setTimeout(ok, pause));
  }
  for (const [i, t] of (r.tool_calls ?? []).entries()) {
    chunk({ tool_calls: [{ index: i, id: t.id, type: 'function', function: { name: t.function.name, arguments: '' } }] });
    chunk({ tool_calls: [{ index: i, function: { arguments: t.function.arguments } }] });
  }
  chunk({}, r.finish ?? (r.tool_calls ? 'tool_calls' : 'stop'));
  response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

createServer(async (req, response) => {
  if (req.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end('{"status":"ok"}');
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let s = '';
    for await (const p of req) s += p;
    const g = JSON.parse(s);
    // Ajan (lib/agent): sistem istemi "You are the assistant and agent of Nedese Studio" ile baslar. Senaryolar son kullanici mesajina gore.
    if (/^You are the assistant and agent of Nedese Studio/.test(g.messages[0]?.content ?? '')) {
      if (g.tools && process.env.NO_FAKE_LLM_TOOL) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { message: 'tools are not supported by this chat template' } }));
      }
      const r = agentResponse(g);
      if (g.stream) return streamAnswer(response, r);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ id: 'a', object: 'chat.completion', created: 1, model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: r.content, ...(r.reasoning ? { reasoning_content: r.reasoning } : {}), ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) }, finish_reason: r.finish ?? (r.tool_calls ? 'tool_calls' : 'stop') }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    // show_image's English search words: köpek -> dog (with quotes and a full stop to strip), others as given
    if (/^Translate the picture search/.test(g.messages[0]?.content ?? '')) {
      const q = String(g.messages[1]?.content ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: q === 'köpek' ? '"Dog".' : q }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    }
    // Follow-up suggestions under an answer: JSON from the question (numbered, a repeat in other case, an empty one and
    // a fourth: the agent keeps three clean ones); "bad follow-ups": plain lines; "slow follow-ups": 3 s late
    if (/^Suggest the next messages the user/.test(g.messages[0]?.content ?? '')) {
      followUpCount += 1;
      const q = /^USER: (.*)$/m.exec(String(g.messages[1]?.content ?? ''))?.[1] ?? '';
      if (/slow follow-ups/.test(q)) await new Promise((ok) => setTimeout(ok, 3000));
      const content = /bad follow-ups/.test(q) ? 'Here are some ideas:\n1. First idea\n2. "Second idea"\n- first idea' : JSON.stringify({ followUps: [`Tell me more about ${q}`, `1. Give an example (#${followUpCount})`, `tell me more about ${q}`, ' ', 'Make it shorter', 'A fourth one'] });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } }));
    }
    // Ajanin gorsel sorusu (look_image / ekler): gorselin bayt sayisi + soru
    if (/^Examine the image carefully/.test(g.messages[0]?.content ?? '')) {
      const parts = Array.isArray(g.messages[1]?.content) ? g.messages[1].content : [];
      const url = parts.find((p) => p.type === 'image_url')?.image_url?.url ?? '';
      const byte = url.includes(',') ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').length : 0;
      const question = parts.find((p) => p.type === 'text')?.text ?? '';
      // show_image's check: a dog is never in the picture
      const shows = /^Does this picture show: "(.*)"\?/.exec(question);
      const content = shows ? (/dog/i.test(shows[1]) ? 'No.' : 'Yes.') : `Fake image answer: ${byte} bytes, question: ${question}`;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    const last = [...g.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    // The agent's summary (compaction): "SUMMARY FAILS" in the input fails the way llama-server does when the input
    // does not fit its context; otherwise the answer says how long the input and its longest line were
    if (/^Summarize the conversation below/.test(g.messages[0]?.content ?? '')) {
      if (/SUMMARY FAILS/.test(String(last))) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error' } }));
      }
      const longest = Math.max(0, ...String(last).split('\n').map((l) => l.length));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: `- summary of ${String(last).length} characters, longest line ${longest}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    const schema = g.response_format?.json_schema?.name;
    const plan = { title: 'Title', excerpt: 'Özet', meta_title: 'Meta', meta_description: 'Description', meta_keywords: 'a, b', tag_keywords_en: 'A, B', category_name: 'Oyun', intro: '<p>Giriş paragrafı.</p>', sections: [1, 2, 3, 4, 5].map((n) => ({ title: `Bölüm ${n}`, content_plan: 'açı', infos: [`bilgi ${n}`] })) };
    const sectionNo = /Heading \(h2\): "Bölüm (\d)"/.exec(g.messages[0]?.content ?? '')?.[1] ?? '0';
    const section = { html: `<h2>Bölüm ${sectionNo}</h2>` + Array.from({ length: 200 }, (_, k) => `kelime${sectionNo}x${k}`).join(' ') + '<h2>Fazla</h2><p>atılmalı</p>' };
    // Gorsel betimleme: icerikte gorsel (JPEG data URL) + metin; yanit gorselin bayt sayisini ve ipucunu yansitir.
    // Metinde "BOZUK" gecerse HTTP 500 (betimlenemeyen gorsel).
    if (/betimleyen bir sanat tarihçisisin|art historian describing images/.test(g.messages[0]?.content ?? '')) {
      const parts = Array.isArray(last) ? last : [];
      const url = parts.find((p) => p.type === 'image_url')?.image_url?.url ?? '';
      const text = parts.find((p) => p.type === 'text')?.text ?? '';
      if (/BOZUK/.test(text)) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { message: 'fake image error' } }));
      }
      const byte = url.startsWith('data:image/jpeg;base64,') ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').length : 0;
      const hint = /\((?:ipucu|a hint)[^)]*\):\s*([\s\S]*)$/.exec(text)?.[1]?.trim() ?? 'none';
      const captionText = `**Betimleme:** Sahte betim, ${byte} bayt JPEG. Soru: ${text.split('\n')[0]} İpucu: ${hint}`;
      // Konu denetimi istendiyse ilk satir karar (ipucunda ALAKASIZ: uygun degil)
      const control = /UYGUN DEĞİL|NOT RELEVANT/.test(g.messages[0]?.content ?? '');
      const content = control ? `${/ALAKASIZ/.test(text) ? 'NOT RELEVANT' : 'UYGUN'}\n${captionText}` : captionText;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    // Veri toplama ayiklamasi: tum bloklar makale, kalite 4 (anahtarlar ve siniflandirma degerleri data-collection.mjs ile ayni)
    if ((g.messages[0]?.content ?? '').includes('NUMBERED text blocks')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ article: true, title: 'Sahte başlık', language: 'tr', topic: 'trial', category: 'technology', contentType: 'guide', tags: ['trial', 'data'], summary: 'Sahte tek cümlelik özet.', quality: 4, accuracy: 4, topicFit: 5, blocks: [[1, 99]] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    // Data collection's MCP plan: every offered tool once (search with the first sample query, fetch_page with the first
    // address in the skills' guidance or one of its own) and delete_note, which is never offered; the note says whether
    // the guidance reached the prompt
    // Data collection skills (auto): the skills whose description holds a word of the topic (4+ letters)
    if (/^You pick skills for a web data collection job/.test(g.messages[0]?.content ?? '')) {
      const words = (/^Topic: (.*)$/m.exec(last)?.[1] ?? '').toLocaleLowerCase('tr').split(/\s+/).filter((w) => w.length >= 4);
      const skills = [...String(last).matchAll(/^- ([^:\n]+): (.*)$/gm)].filter((x) => words.some((w) => x[2].toLocaleLowerCase('tr').includes(w))).map((x) => x[1]);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ skills: [...skills, 'no-such-skill'], note: 'fake pick' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    if (/^You plan tool calls on MCP servers/.test(g.messages[0]?.content ?? '')) {
      const offered = [...String(last).matchAll(/^- ([\w-]+)\/([\w-]+):/gm)].map((x) => ({ server: x[1], tool: x[2] }));
      const query = /^Sample queries: (.*)$/m.exec(last)?.[1]?.split(' | ')[0] ?? 'kedi';
      // with skills' guidance the read tool gets the guidance's first address
      const guidance = /Guidance from skills/.test(last);
      const url = guidanceAddresses(last)[0] ?? 'https://fake.invalid/gezgin-kedi';
      const calls = offered.map((t) => (t.tool === 'search' ? { ...t, arguments: { query } } : t.tool === 'fetch_page' ? { ...t, arguments: { url } } : null)).filter(Boolean);
      if (offered.length) calls.push({ server: offered[0].server, tool: 'delete_note', arguments: { id: 1 } });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ calls, note: guidance ? 'guided by the skills' : 'fake plan' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    // Veri toplama arama sorgulari
    if ((g.messages[0]?.content ?? '').includes('data collection crawl')) {
      // Yonetici: "yeni yön" sorgusu daha once kullanilmadiysa onu onerir, sonra yeni yon yok
      const used = /Queries used:.*yeni yön/.test(last);
      const decision = used ? { prioritized: [], release: [], newQueries: [], note: 'Yeni yön kalmadı' } : { prioritized: [], release: [], newQueries: [{ language: 'tr', query: 'gezgin kedi yeni yön' }], note: 'Yeni alt başlık deneniyor' };
      // with skills' guidance: says so, and names the guidance's addresses (after the first) as sources
      if (/Guidance from skills/.test(last)) Object.assign(decision, { note: `${decision.note} (guided)`, sources: guidanceAddresses(last).slice(1) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(decision) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    if ((g.messages[0]?.content ?? '').includes('guiding a crawler')) {
      // Baglanti secimi: metninde "SEÇ" gecen numarali baglantilar
      const select = [...last.matchAll(/^\[(\d+)\] .*SEÇ/gm)].map((x) => Number(x[1]));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ select }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    if ((g.messages[0]?.content ?? '').includes('research assistant')) {
      // with skills' guidance: the guidance's addresses after the first are the sources (the first is for a read tool)
      const sources = /Guidance from skills/.test(last) ? { sources: guidanceAddresses(last).slice(1) } : {};
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ queries: [{ language: 'tr', query: 'sahte sorgu bir' }, { language: 'tr', query: 'sahte sorgu iki' }], ...sources }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
    const text = schema === 'plan' ? JSON.stringify(plan) : schema === 'section' ? JSON.stringify(section) : g.response_format?.type === 'json_object' ? JSON.stringify({ prompt: last, system: g.messages[0]?.content ?? '', thinking: g.chat_template_kwargs?.enable_thinking ?? null }) : `EN: ${last}`;
    // a request that does not fit the context: llama-server's error, before any event
    if (/TOO LONG FOR CONTEXT/.test(getText(last))) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error' } }));
    }
    // stream: true: llama-server's chunks (role, the text in pieces, the finish, usage when asked), then [DONE]
    if (g.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake' };
      const event = (o) => response.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
      const pause = Number(process.env.FAKE_LLM_STREAM_MS) || 0;
      event({ choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
      for (const part of text.match(/[\s\S]{1,8}/g) ?? []) {
        event({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
        if (pause) await new Promise((ok) => setTimeout(ok, pause));
      }
      event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      if (g.stream_options?.include_usage) event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      return response.end('data: [DONE]\n\n');
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: g.max_tokens === 1 ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  }
  response.writeHead(404);
  response.end();
}).listen(port, '127.0.0.1');
