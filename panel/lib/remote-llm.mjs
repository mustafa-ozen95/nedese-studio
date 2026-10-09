/**
 * Remote OpenAI-compatible text model (Settings › Remote model; user request 08.10.2026): a chat can use a model served
 * elsewhere (OpenAI, OpenRouter, DeepSeek, Groq, or a vLLM / Ollama / LM Studio server on another computer) instead of
 * the local llama-server, or only while the GPU is busy with an image/video job. Requests go to <address>/chat/completions
 * with the key as a bearer token; answers come back in the shape LocalLlm.req gives ({ code, json }), streamed the same
 * way (streamCollector), so the chat loop does not tell them apart.
 */
import { LlmError, streamCollector } from './llm.mjs';
import { CancelError } from './errors.mjs';

/** A chat's model value for the remote model (local model files end in .gguf, so it cannot clash). */
export const REMOTE_MODEL = 'remote';

/** Fields only llama-server knows: OpenAI rejects unknown fields. */
const LOCAL_FIELDS = ['chat_template_kwargs', 'thinking_budget_tokens', 'cache_prompt', 'id_slot', 'n_probs', 'reasoning_format'];

/** Checks the address typed in Settings and returns what is stored ('' removes it); a pasted ".../chat/completions" keeps its base. */
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
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') || '/';
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
