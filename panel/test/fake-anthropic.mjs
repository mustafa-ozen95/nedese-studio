/**
 * Fake Anthropic Messages API for Settings › Remote model with Claude: POST <base>/messages with x-api-key and
 * anthropic-version; every request is kept (requests). Strict like the real API: unknown top-level fields, a missing
 * max_tokens, turns not in user/assistant order, a tool_use without its tool_result in the next user turn, a
 * temperature above 1 and more than 4 cache marks are refused (400 invalid_request_error). Answers: "Claude answer
 * from <model>"; "remote tool" calls list_file; after a tool result "Claude saw the tool result: …"; an image in the
 * last user turn "Claude saw an image (<media type>)"; the Settings test question "OK". stream: true sends the events
 * of the real API (message_start … message_stop, input_json_delta in pieces); overloaded: true sends an error event.
 */
import { createServer } from 'node:http';

const FIELDS = new Set(['model', 'max_tokens', 'messages', 'system', 'temperature', 'stop_sequences', 'tools', 'tool_choice', 'stream', 'metadata', 'top_p', 'top_k', 'thinking']);

function invalid(body) {
  for (const k of Object.keys(body)) if (!FIELDS.has(k)) return `${k}: Extra inputs are not permitted`;
  if (!body.model) return 'model: Field required';
  if (!Number.isInteger(body.max_tokens)) return 'max_tokens: Field required';
  if (body.temperature !== undefined && (body.temperature < 0 || body.temperature > 1)) return 'temperature: Input should be less than or equal to 1';
  const messages = body.messages ?? [];
  if (!messages.length) return 'messages: at least one message is required';
  if (messages[0].role !== 'user') return 'messages: first message must use the "user" role';
  let marks = 0;
  const count = (blocks) => (Array.isArray(blocks) ? blocks.forEach((b) => (marks += b?.cache_control ? 1 : 0)) : null);
  count(body.system);
  count(body.tools);
  for (const [i, m] of messages.entries()) {
    if (!['user', 'assistant'].includes(m.role)) return `messages.${i}.role: Input should be 'user' or 'assistant'`;
    if (i && messages[i - 1].role === m.role) return `messages: roles must alternate between "user" and "assistant" (${i})`;
    if (!Array.isArray(m.content) || !m.content.length) return `messages.${i}.content: non-empty list required`;
    count(m.content);
    const uses = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (uses.length) {
      const next = messages[i + 1];
      const results = new Set((next?.content ?? []).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id));
      if (next && uses.some((u) => !results.has(u))) return `messages.${i + 1}: tool_use ids were found without tool_result blocks immediately after: ${uses.filter((u) => !results.has(u)).join(', ')}`;
    }
    for (const b of m.content) {
      if (b.type === 'tool_result' && !(messages[i - 1]?.content ?? []).some((x) => x.type === 'tool_use' && x.id === b.tool_use_id)) return `messages.${i}.content: unexpected tool_use_id found in tool_result blocks: ${b.tool_use_id}`;
      if (b.type === 'text' && !b.text) return `messages.${i}.content: text content blocks must be non-empty`;
    }
  }
  if (marks > 4) return 'A maximum of 4 blocks with cache_control may be provided.';
  return null;
}

function answerFor(body) {
  const last = body.messages.at(-1);
  const result = last.content.find((b) => b.type === 'tool_result');
  if (result) {
    const text = (Array.isArray(result.content) ? result.content.map((b) => b.text ?? '').join('') : String(result.content)).slice(0, 60);
    return { text: `Claude saw the tool result: ${text}` };
  }
  const image = last.content.find((b) => b.type === 'image');
  if (image) return { text: `Claude saw an image (${image.source.media_type})` };
  const text = last.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (/^Reply with the single word/.test(text)) return { text: 'OK' };
  if (/^remote tool/.test(text) && body.tools?.length) return { text: 'Looking.', tool: { id: 'toolu_01', name: 'list_file', input: { path: '.' } } };
  return { text: `Claude answer from ${body.model}` };
}

export async function startFakeAnthropic({ key = '' } = {}) {
  const state = { requests: [], key, overloaded: false };
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    } catch {
      /* not JSON */
    }
    state.requests.push({ method: req.method, path: req.url, apiKey: req.headers['x-api-key'] ?? null, authorization: req.headers.authorization ?? null, version: req.headers['anthropic-version'] ?? null, body });
    const send = (code, json) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const error = (code, type, message) => send(code, { type: 'error', error: { type, message } });
    if (req.method !== 'POST' || !/\/messages$/.test(req.url)) return error(404, 'not_found_error', `Not found: ${req.url}`);
    if (!req.headers['anthropic-version']) return error(400, 'invalid_request_error', 'anthropic-version: header is required');
    if (state.key && req.headers['x-api-key'] !== state.key) return error(401, 'authentication_error', 'invalid x-api-key');
    const wrong = invalid(body);
    if (wrong) return error(400, 'invalid_request_error', wrong);
    const a = answerFor(body);
    const usage = { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 9 };
    const stop = a.tool ? 'tool_use' : 'end_turn';
    const content = [{ type: 'text', text: a.text }, ...(a.tool ? [{ type: 'tool_use', ...a.tool }] : [])];
    if (!body.stream) return send(200, { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, j) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...j })}\n\n`);
    event('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: usage.cache_read_input_tokens, output_tokens: 1 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('ping', {});
    if (state.overloaded) {
      event('error', { error: { type: 'overloaded_error', message: 'Overloaded' } });
      return res.end();
    }
    for (const piece of a.text.match(/.{1,5}/gs) ?? []) event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
    event('content_block_stop', { index: 0 });
    if (a.tool) {
      event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: a.tool.id, name: a.tool.name, input: {} } });
      const json = JSON.stringify(a.tool.input);
      event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '' } });
      for (const piece of json.match(/.{1,4}/gs)) event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: piece } });
      event('content_block_stop', { index: 1 });
    }
    event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    event('message_stop', {});
    res.end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    state,
    get requests() {
      return state.requests;
    },
    // a path ending in /anthropic speaks the Messages API (like DeepSeek's endpoint and the gateways)
    address: `http://127.0.0.1:${server.address().port}/anthropic`,
    close: () => new Promise((ok) => server.close(ok)),
  };
}
