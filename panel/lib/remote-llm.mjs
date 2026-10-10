/**
 * Remote OpenAI-compatible text model (Settings › Remote model; user request 08.10.2026): a chat can use a model served
 * elsewhere (OpenAI, OpenRouter, DeepSeek, Groq, or a vLLM / Ollama / LM Studio server on another computer) instead of
 * the local llama-server, or only while the GPU is busy with an image/video job. Requests go to <address>/chat/completions
 * with the key as a bearer token; answers come back in the shape LocalLlm.req gives ({ code, json }), streamed the same
 * way (streamCollector), so the chat loop does not tell them apart. Claude (api.anthropic.com) speaks its own Messages
 * API (claudeRequest below).
 */
import { LlmError, streamCollector } from './llm.mjs';
import { CancelError } from './errors.mjs';

/** A chat's model value for the remote model (local model files end in .gguf, so it cannot clash). */
export const REMOTE_MODEL = 'remote';

/** Fields only llama-server knows: OpenAI rejects unknown fields. */
const LOCAL_FIELDS = ['chat_template_kwargs', 'thinking_budget_tokens', 'cache_prompt', 'id_slot', 'n_probs', 'reasoning_format'];

/** Checks the address typed in Settings and returns what is stored ('' removes it); a pasted ".../chat/completions" or ".../messages" keeps its base. */
export function checkRemoteAddress(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    throw new Error(`Not a web address: ${s}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('The remote model address must start with http:// or https://.');
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '') || '/';
  return u.href.replace(/\/+$/, '');
}

/** An API key as stored: one word of printable characters ('' removes it). */
export function checkRemoteKey(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (s.length > 400 || !/^[\x21-\x7e]+$/.test(s)) throw new Error('The API key looks wrong: paste the key alone (letters, digits and signs, no spaces).');
  return s;
}

/** A model name as the server knows it (e.g. gpt-4o-mini, deepseek-chat, qwen2.5:14b). */
export function checkRemoteModelName(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (s.length > 200 || /[\x00-\x1f\x7f]/.test(s)) throw new Error('The model name looks wrong: write it as the server lists it (e.g. gpt-4o-mini).');
  return s;
}

/** The text of a server's error answer (OpenAI: { error: { message } }; others: error, message or detail). */
function errorText(json, text, status) {
  const e = json?.error;
  const found = (typeof e === 'string' ? e : e?.message) ?? json?.message ?? (typeof json?.detail === 'string' ? json.detail : null);
  return String(found ?? (String(text ?? '').trim().slice(0, 300) || `HTTP ${status}`));
}

/** Streamed "data:" events of a fetch answer, each as parsed JSON. */
async function readEvents(stream, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of stream) {
    buffer += decoder.decode(part, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try {
        onEvent(JSON.parse(d));
      } catch {
        /* a broken event line: skipped */
      }
    }
  }
}

async function post(config, payload, signal, onChunk) {
  const collector = onChunk ? streamCollector(onChunk) : null;
  let response;
  try {
    response = await fetch(`${config.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: collector ? 'text/event-stream' : 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new CancelError();
    throw new LlmError(`The remote model cannot be reached (${config.url}): ${e.cause?.code ?? e.cause?.message ?? e.message}`, 503);
  }
  try {
    if (response.status === 200 && collector && /event-stream/i.test(response.headers.get('content-type') ?? '')) {
      await readEvents(response.body, (j) => collector.event(j));
      return { code: 200, json: collector.result() };
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: the text is the error */
    }
    if (response.status !== 200) return { code: response.status, json: { error: { message: errorText(json, text, response.status) } } };
    if (!Array.isArray(json?.choices)) return { code: 502, json: { error: { message: `no answer in its reply: ${String(text).slice(0, 200)}` } } };
    // a server that does not stream sent the whole answer at once: it still shows in the chat
    const message = json.choices[0]?.message;
    if (onChunk && message?.reasoning_content) onChunk({ thinking: message.reasoning_content });
    if (onChunk && typeof message?.content === 'string' && message.content) onChunk({ text: message.content });
    return { code: 200, json };
  } catch (e) {
    if (signal?.aborted) throw new CancelError();
    throw new LlmError(`The remote model's answer broke off: ${e.message}`, 502);
  }
}

/* ── Claude (user request 10.10.2026: "Claude'u model olarak kullan") ──
 * Anthropic's own Messages API instead of its OpenAI-compatible layer: prompt caching and images work there. The
 * request is built from the OpenAI-shaped body and the answer (streamed or whole) comes back in the OpenAI shape, so
 * the chat loop does not tell it apart. Chosen by the address: api.anthropic.com, or a path ending in /anthropic
 * (DeepSeek's Anthropic endpoint, Cloudflare AI Gateway, LiteLLM). */

const ANTHROPIC_VERSION = '2023-06-01';
const CLAUDE_MAX_TOKENS = 16384;
/** Claude's context window: the chat's gauge and auto compact count against it instead of the local model's. */
export const CLAUDE_CONTEXT = 200000;

/** True when the remote model address speaks the Anthropic Messages API. */
export function anthropicApi(url) {
  try {
    const u = new URL(url);
    return /(^|\.)anthropic\.com$/i.test(u.hostname) || /\/anthropic(\/v1)?\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** A Claude model on the Messages API (DeepSeek's Anthropic endpoint speaks it too, with its own models). */
const claudeModel = (config) => Boolean(config?.url && anthropicApi(config.url) && /claude/i.test(config.model ?? ''));

/** The context window of a remote model when it is known (Claude), else null (the local model's is used). */
export function remoteContext(config) {
  return claudeModel(config) ? CLAUDE_CONTEXT : null;
}

/** Whether the remote model is sent the images of a chat (Claude reads them; for other servers it is not known). */
export function remoteReadsImages(config) {
  return claudeModel(config);
}

/** An OpenAI content part -> an Anthropic block (data: images as base64, web images by address). */
function claudePart(p) {
  if (typeof p === 'string') return p ? { type: 'text', text: p } : null;
  if (p?.type === 'text') return p.text ? { type: 'text', text: p.text } : null;
  if (p?.type === 'image_url') {
    const url = String(p.image_url?.url ?? '');
    const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
    return /^https?:/i.test(url) ? { type: 'image', source: { type: 'url', url } } : null;
  }
  return null;
}

const claudeBlocks = (content) => (Array.isArray(content) ? content.map(claudePart) : [claudePart(String(content ?? ''))]).filter(Boolean);

/**
 * OpenAI chat body -> Anthropic Messages body. System messages join the system prompt; a tool result is a user turn's
 * tool_result block; turns of the same role are merged (the API wants user and assistant in turn). Cache marks go on
 * the system prompt, the last tool and the last message: each step reads the whole earlier prompt from the cache.
 */
export function claudeBody(body, model) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const m of body.messages ?? []) {
    if (m.role === 'system') {
      const text = Array.isArray(m.content) ? m.content.map((p) => p?.text ?? '').join('') : String(m.content ?? '');
      if (text.trim()) system.push(text);
    } else if (m.role === 'tool') {
      const content = claudeBlocks(m.content);
      push('user', [{ type: 'tool_result', tool_use_id: String(m.tool_call_id ?? ''), content: content.length ? content : [{ type: 'text', text: '(no output)' }] }]);
    } else if (m.role === 'assistant') {
      const blocks = claudeBlocks(m.content).filter((b) => b.type === 'text' && b.text.trim());
      for (const t of m.tool_calls ?? []) {
        let input = {};
        try {
          input = typeof t.function?.arguments === 'string' ? JSON.parse(t.function.arguments || '{}') : t.function?.arguments ?? {};
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: String(t.id), name: t.function?.name, input: input && typeof input === 'object' && !Array.isArray(input) ? input : {} });
      }
      push('assistant', blocks);
    } else push('user', claudeBlocks(m.content));
  }
  // the conversation starts with the user (a chat whose first turns were summarized away may start with the model)
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  const last = messages.at(-1)?.content.at(-1);
  if (last) last.cache_control = { type: 'ephemeral' };
  const out = { model, max_tokens: Number(body.max_tokens ?? body.max_completion_tokens) || CLAUDE_MAX_TOKENS, messages };
  if (system.length) out.system = [{ type: 'text', text: system.join('\n\n'), cache_control: { type: 'ephemeral' } }];
  if (typeof body.temperature === 'number') out.temperature = Math.min(1, Math.max(0, body.temperature));
  if (body.stop) out.stop_sequences = [].concat(body.stop).filter(Boolean);
  const tools = (body.tools ?? []).filter((t) => t?.function?.name).map((t) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }));
  if (tools.length && body.tool_choice !== 'none') {
    tools.at(-1).cache_control = { type: 'ephemeral' };
    out.tools = tools;
    const c = body.tool_choice;
    if (c === 'required') out.tool_choice = { type: 'any' };
    else if (c?.function?.name) out.tool_choice = { type: 'tool', name: c.function.name };
  }
  return out;
}

const CLAUDE_FINISH = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', pause_turn: 'stop', refusal: 'stop' };

/** Anthropic usage -> OpenAI usage: the cached prompt counts in the prompt. */
const claudeUsage = (u) => (u ? { prompt_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), completion_tokens: u.output_tokens ?? 0, cached_tokens: u.cache_read_input_tokens ?? 0 } : null);

/** A whole Anthropic answer -> an OpenAI chat completion. */
export function claudeAnswer(json) {
  const text = [];
  const thinking = [];
  const calls = [];
  for (const b of json?.content ?? []) {
    if (b.type === 'text') text.push(b.text);
    else if (b.type === 'thinking') thinking.push(b.thinking);
    else if (b.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  }
  const message = { role: 'assistant', content: text.join(''), ...(thinking.length ? { reasoning_content: thinking.join('') } : {}), ...(calls.length ? { tool_calls: calls } : {}) };
  return { choices: [{ index: 0, message, finish_reason: CLAUDE_FINISH[json?.stop_reason] ?? 'stop' }], usage: claudeUsage(json?.usage) ?? undefined };
}

/**
 * Anthropic stream events -> the OpenAI chunks the collector reads. One translator per answer: it keeps the usage of
 * message_start (input) until message_delta brings the output, and gives each tool_use block its tool index.
 */
export function claudeStream() {
  let usage = null;
  let tools = 0;
  const kinds = new Map(); // content block index -> { type, tool }
  let error = null;
  return {
    get error() {
      return error;
    },
    chunks(e) {
      const delta = (d, finish = null) => [{ choices: [{ index: 0, delta: d, finish_reason: finish }] }];
      switch (e?.type) {
        case 'message_start':
          usage = { ...(e.message?.usage ?? {}) };
          return [];
        case 'content_block_start': {
          const b = e.content_block ?? {};
          if (b.type === 'tool_use') {
            const tool = tools++;
            kinds.set(e.index, { type: 'tool', tool });
            return delta({ tool_calls: [{ index: tool, id: b.id, type: 'function', function: { name: b.name, arguments: '' } }] });
          }
          kinds.set(e.index, { type: b.type });
          return b.type === 'text' && b.text ? delta({ content: b.text }) : [];
        }
        case 'content_block_delta': {
          const d = e.delta ?? {};
          if (d.type === 'text_delta') return delta({ content: d.text });
          if (d.type === 'thinking_delta') return delta({ reasoning_content: d.thinking });
          if (d.type === 'input_json_delta') {
            const k = kinds.get(e.index);
            return k?.type === 'tool' && d.partial_json ? delta({ tool_calls: [{ index: k.tool, function: { arguments: d.partial_json } }] }) : [];
          }
          return [];
        }
        case 'message_delta': {
          usage = { ...(usage ?? {}), ...(e.usage ?? {}) };
          const out = e.delta?.stop_reason ? delta({}, CLAUDE_FINISH[e.delta.stop_reason] ?? 'stop') : [];
          return [...out, { choices: [], usage: claudeUsage(usage) }];
        }
        case 'error':
          error = e.error ?? { message: 'error event' };
          return [];
        default:
          return [];
      }
    },
  };
}

async function postClaude(config, payload, signal, onChunk) {
  const collector = onChunk ? streamCollector(onChunk) : null;
  let response;
  try {
    response = await fetch(`${config.url}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: collector ? 'text/event-stream' : 'application/json', 'anthropic-version': ANTHROPIC_VERSION, ...(config.key ? { 'x-api-key': config.key } : {}) },
      body: JSON.stringify({ ...payload, ...(collector ? { stream: true } : {}) }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new CancelError();
    throw new LlmError(`The remote model cannot be reached (${config.url}): ${e.cause?.code ?? e.cause?.message ?? e.message}`, 503);
  }
  try {
    if (response.status === 200 && collector && /event-stream/i.test(response.headers.get('content-type') ?? '')) {
      const translate = claudeStream();
      await readEvents(response.body, (j) => {
        for (const c of translate.chunks(j)) collector.event(c);
      });
      // an error in the middle of the stream (overloaded): the answer so far is not used
      if (translate.error) return { code: translate.error.type === 'overloaded_error' ? 529 : 502, json: { error: { message: errorText({ error: translate.error }, '', 502) } } };
      return { code: 200, json: collector.result() };
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: the text is the error */
    }
    if (response.status !== 200) return { code: response.status, json: { error: { message: errorText(json, text, response.status) } } };
    if (!Array.isArray(json?.content)) return { code: 502, json: { error: { message: `no answer in its reply: ${String(text).slice(0, 200)}` } } };
    const answer = claudeAnswer(json);
    const message = answer.choices[0].message;
    if (onChunk && message.reasoning_content) onChunk({ thinking: message.reasoning_content });
    if (onChunk && message.content) onChunk({ text: message.content });
    return { code: 200, json: answer };
  } catch (e) {
    if (signal?.aborted) throw new CancelError();
    throw new LlmError(`The remote model's answer broke off: ${e.message}`, 502);
  }
}

/** One Claude request: a temperature the model refuses (newer models fix their own) is left out once. */
async function claudeRequest(config, body, { signal, onChunk }) {
  let payload = claudeBody(body, config.model);
  let dropped = false;
  for (;;) {
    if (signal?.aborted) throw new CancelError();
    const r = await postClaude(config, payload, signal, onChunk);
    if (r.code === 400 && !dropped && payload.temperature !== undefined && /temperature/i.test(r.json.error.message)) {
      dropped = true;
      const { temperature: _t, ...rest } = payload;
      payload = rest;
      continue;
    }
    if (r.code !== 200) r.json.error.message = `The remote model answered HTTP ${r.code}: ${r.json.error.message}`;
    return r;
  }
}

/**
 * What the request asks that this server refused, changed once each: newer OpenAI models take max_completion_tokens
 * and only their own temperature; some servers do not know stream_options. null: nothing to change.
 */
function adjust(payload, message, done) {
  const without = (key) => Object.fromEntries(Object.entries(payload).filter(([k]) => k !== key));
  if (!done.has('max') && payload.max_tokens !== undefined && /max_tokens/.test(message)) {
    done.add('max');
    return { ...without('max_tokens'), max_completion_tokens: payload.max_tokens };
  }
  if (!done.has('temperature') && payload.temperature !== undefined && /temperature/i.test(message)) {
    done.add('temperature');
    return without('temperature');
  }
  if (!done.has('options') && payload.stream_options !== undefined && /stream_options/.test(message)) {
    done.add('options');
    return without('stream_options');
  }
  return null;
}

/**
 * One chat completion from the remote model: body as for llama-server (its own fields are left out, the model name is
 * set), streamed to onChunk when given. A refused field is changed and the request sent again (adjust). An error
 * answer comes back with code and message like LocalLlm.req; an address that cannot be reached throws LlmError.
 */
export async function remoteRequest(config, body, { signal = null, onChunk = null } = {}) {
  if (anthropicApi(config.url)) return claudeRequest(config, body, { signal, onChunk });
  let payload = Object.fromEntries(Object.entries(body).filter(([k]) => !LOCAL_FIELDS.includes(k) && k !== 'stream' && k !== 'stream_options'));
  payload.model = config.model;
  // the local model's thinking stays here (DeepSeek refuses a message that carries reasoning_content)
  if (Array.isArray(payload.messages)) payload.messages = payload.messages.map(({ reasoning_content: _r, ...m }) => m);
  payload = onChunk ? { ...payload, stream: true, stream_options: { include_usage: true } } : { ...payload, stream: false };
  const done = new Set();
  for (;;) {
    if (signal?.aborted) throw new CancelError();
    const r = await post(config, payload, signal, onChunk);
    if (r.code === 400 || r.code === 422) {
      const next = adjust(payload, r.json.error.message, done);
      if (next) {
        payload = next;
        continue;
      }
    }
    if (r.code !== 200) r.json.error.message = `The remote model answered HTTP ${r.code}: ${r.json.error.message}`;
    return r;
  }
}

/** Settings › Remote model › Test: a short question; the answer's text and how long it took. */
export async function checkRemote(config, timeoutSec = 60) {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutSec * 1000);
  let r;
  try {
    r = await remoteRequest(config, { messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_tokens: 16, temperature: 0 }, { signal });
  } catch (e) {
    if (signal.aborted) throw new LlmError(`The remote model did not answer within ${timeoutSec} s.`, 504);
    throw e;
  }
  if (r.code !== 200) throw new LlmError(r.json.error.message, r.code);
  return { text: String(r.json.choices?.[0]?.message?.content ?? '').trim().slice(0, 200), ms: Date.now() - started };
}
