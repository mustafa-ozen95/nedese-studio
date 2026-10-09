/**
 * Fake remote OpenAI-compatible server for Settings › Remote model: POST /v1/chat/completions with a bearer key; every
 * request is kept (requests). Like OpenAI it refuses fields it does not know (llama-server's chat_template_kwargs,
 * thinking_budget_tokens, a message's reasoning_content); strict: true refuses max_tokens like the newer OpenAI models.
 * Answers: "Remote answer from <model>"; "remote tool" calls list_file; after a tool result "Remote saw the tool result:
 * …"; the Settings test question gets "OK". stream: true sends the answer in pieces, then usage when asked.
 */
import { createServer } from 'node:http';

function answerFor(body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  if (last?.role === 'tool') return { content: `Remote saw the tool result: ${String(last.content).slice(0, 60)}` };
  const user = [...messages].reverse().find((m) => m.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map((p) => p?.text ?? '').join('');
  if (/^Reply with the single word/.test(text)) return { content: 'OK' };
  if (/^remote tool/.test(text) && body.tools?.length) return { content: '', tool_calls: [{ id: 'rcall_1', type: 'function', function: { name: 'list_file', arguments: JSON.stringify({ path: '.' }) } }] };
  return { content: `Remote answer from ${body.model}` };
}

export async function startFakeRemote({ key = '', strict = false } = {}) {
  const state = { requests: [], strict, key };
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    } catch {
      /* not JSON */
    }
    state.requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization ?? null, body });
    const send = (code, json) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: { message: `Unknown path: ${req.url}` } });
    if (state.key && req.headers.authorization !== `Bearer ${state.key}`) return send(401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } });
    for (const field of ['chat_template_kwargs', 'thinking_budget_tokens']) if (field in body) return send(400, { error: { message: `Unrecognized request argument supplied: ${field}` } });
    if ((body.messages ?? []).some((m) => 'reasoning_content' in m)) return send(400, { error: { message: 'reasoning_content is not allowed in input messages' } });
    if (state.strict && body.max_tokens !== undefined) return send(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: 'max_tokens' } });
    const a = answerFor(body);
    const usage = { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 };
    const finish = a.tool_calls ? 'tool_calls' : 'stop';
    if (!body.stream) return send(200, { id: 'r1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: a.content, ...(a.tool_calls ? { tool_calls: a.tool_calls } : {}) }, finish_reason: finish }], usage });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (j) => res.write(`data: ${JSON.stringify({ id: 'r1', object: 'chat.completion.chunk', model: body.model, ...j })}\n\n`);
    event({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    for (const piece of a.content.match(/.{1,6}/gs) ?? []) event({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    for (const [i, t] of (a.tool_calls ?? []).entries()) {
      event({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: t.id, type: 'function', function: { name: t.function.name, arguments: '' } }] }, finish_reason: null }] });
      event({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: t.function.arguments } }] }, finish_reason: null }] });
    }
    event({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    if (body.stream_options?.include_usage) event({ choices: [], usage });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    state,
    get requests() {
      return state.requests;
    },
    address: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((ok) => server.close(ok)),
  };
}
