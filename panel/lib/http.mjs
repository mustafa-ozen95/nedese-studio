/**
 * HTTP server: the UI (web\), the JSON API (/api/* for the UI, /api/v1/* the documented API) and serving the
 * outputs. The address: AI_PANEL_ADDRESS > panel-data\settings.json > defaults.json (0.0.0.0: home network / Tailscale).
 *
 * Security (other sites in the browser can send requests):
 * - The Host header must be one of this machine's names (allowedHosts; DNS rebinding attack).
 * - UI (/api/*): a POST needs this panel as its Origin; without an Origin the X-Panel header is required.
 * - API (/api/v1/*): Authorization: Bearer <key> (panel-data\settings.json) OR a same-origin browser request
 *   (X-Panel + Origin; a GET opened from the address bar works too). Otherwise 401.
 * - Only the job folders, the uploads and the voice library are served; a path cannot leave them.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { UserError, friendlyError } from './errors.mjs';
import { UPLOAD_FOLDER, allowedHosts } from './settings.mjs';
import { DATA_FILES } from './data-files.mjs';
import { voicePath } from './voices.mjs';
import { readJson } from './request.mjs';
import { LlmError, LENGTH_NOTE, chatToResponses, foreignScript, responsesToChat } from './llm.mjs';
import { trainedModelProfile, applyAbbreviations } from './jobs/training.mjs';
import { sectionedArticle, countWords } from './article.mjs';
import { createService } from './service.mjs';
import { API_PREFIX, JOB_TYPES, apiRoutes, pathPattern } from './api.mjs';
import { AgentManager } from './agent/agent.mjs';
import { sourcePath } from './agent/tools.mjs';
import { Knowledge } from './knowledge.mjs';
import { Database } from './database.mjs';
import { docsPage, openapi } from './documents.mjs';
import { requestLanguage, translateData } from './language.mjs';
import { COOKIE_NAME, LoginLimiter, Sessions, readCookie, isLocalClient } from './session.mjs';
import { JOB_ID } from './queue.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.srt': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.stl': 'model/stl',
  '.zip': 'application/zip',
};

const SAFE = /^[\w.-]+$/;

export function createPanelServer({ setting, queue, comfy, mod, settingFile = null, downloader = null, llm = null, updater = null, restart = null }) {
  let port = setting.port;
  const h = createService({ setting, queue, comfy, mod, settingFile, downloader, llm, updater, restart });
  const v1 = apiRoutes(h).map((r) => ({ ...r, ...pathPattern(r.path) }));
  // Chat / agent (lib/agent): when a local text model is installed; its tools are the route table itself (panel_api).
  // Knowledge (document search): in panel.db, also without the text model (the API searches it by words)
  const knowledge = new Knowledge({ db: queue.db ?? new Database(':memory:'), setting, resolve: (source) => sourcePath(setting, source), log: (m) => console.log(m) });
  h.knowledge = knowledge;
  const agent = llm?.installed ? new AgentManager({ setting, llm, h, routes: v1, jobTypes: JOB_TYPES, tasks: h.tasks, db: queue.db ?? null, webSearch: () => settingFile?.webSearch ?? null, remote: () => settingFile?.remoteModel ?? null, knowledge, log: (m) => console.log(m) }) : null;
  h.agent = agent;
  // Network clients (home network, Tailscale) with AI_PANEL_LOGIN=1: the API key or a session cookie opened once with
  // the key. Browser requests from this machine (loopback / its own addresses) are free as before.
  const sessions = settingFile ? new Sessions({ file: join(setting.dataRoot, DATA_FILES.sessions) }) : null;
  const loginLimit = new LoginLimiter();
  const COOKIE_OPTIONS = 'Path=/; HttpOnly; SameSite=Strict';
  const address = () => `http://127.0.0.1:${port}/`;

  /* The routes the UI uses: the same services (the response shapes did not change). */
  const routes = [
    ['GET', /^\/api\/id$/, async () => h.id()],
    ['GET', /^\/api\/status$/, async () => h.status()],
    ['GET', /^\/api\/options$/, async () => h.options()],
    ['GET', /^\/api\/images$/, async () => ({ images: h.images() })],
    ['GET', /^\/api\/voices$/, async () => ({ voices: h.voices() })],
    ['GET', /^\/api\/training$/, async () => h.trainingInfo()],
    ['GET', /^\/api\/jobs$/, async (_i, url) => ({ jobs: h.jobs({ type: url.searchParams.get('type'), status: url.searchParams.get('status') }) })],
    ['GET', /^\/api\/job\/([\w-]+)$/, async (_i, _u, [id]) => ({ job: h.job(id) })],
    ['POST', /^\/api\/job$/, async (req) => ({ ok: true, ...h.addJob(await readJson(req)) })],
    ['POST', /^\/api\/job\/([\w-]+)\/cancel$/, async (_i, _u, [id]) => ({ ok: true, ...h.cancelJob(id) })],
    ['POST', /^\/api\/job\/([\w-]+)\/pause$/, async (_i, _u, [id]) => ({ ok: true, ...h.pauseJob(id) })],
    ['POST', /^\/api\/job\/([\w-]+)\/retry$/, async (_i, _u, [id]) => ({ ok: true, ...h.retryJob(id) })],
    ['POST', /^\/api\/job\/([\w-]+)\/delete$/, async (_i, _u, [id]) => ({ ok: true, ...(await h.deleteJob(id)) })],
    ['POST', /^\/api\/upload$/, async (req, url) => ({ ok: true, ...(await h.loadImage(req, url.searchParams.get('name'))) })],
    ['POST', /^\/api\/record\/upload$/, async (req, url) => ({ ok: true, ...(await h.loadRecord(req, url.searchParams.get('name'))) })],
    ['POST', /^\/api\/data\/upload$/, async (req, url) => ({ ok: true, ...(await h.loadData(req, url.searchParams.get('name'))) })],
    ['POST', /^\/api\/music\/upload$/, async (req, url) => ({ ok: true, ...(await h.loadMusic(req, url.searchParams.get('name'))) })],
    ['POST', /^\/api\/write-scenes$/, async (req) => ({ ok: true, ...(await h.writeScene(await readJson(req))) })],
    ['POST', /^\/api\/task\/([\w-]+)\/cancel$/, async (_i, _u, [id]) => ({ ok: true, ...h.cancelTask(id) })],
    ['POST', /^\/api\/write-lyrics$/, async (req) => ({ ok: true, ...(await h.writeLyric(await readJson(req))) })],
    ['POST', /^\/api\/write-promo$/, async (req) => ({ ok: true, ...(await h.writePromoScript(await readJson(req))) })],
    ['POST', /^\/api\/voices\/upload$/, async (req, url) => ({ ok: true, ...(await h.loadVoice(req, url.searchParams.get('name'), url.searchParams.get('voiceName'))) })],
    ['POST', /^\/api\/voices\/([\w-]+)\/delete$/, async (_i, _u, [id]) => ({ ok: true, ...(await h.deleteVoice(id)), retval: 'voice' })],
    ['POST', /^\/api\/comfy\/start$/, async () => ({ ok: true, ...(await h.startComfy()) })],
  ];

  function keyCorrect(req) {
    const b = String(req.headers.authorization ?? '');
    const m = /^Bearer\s+(\S+)$/i.exec(b);
    if (!m || !settingFile?.apiKey) return false;
    const a = Buffer.from(m[1]);
    const k = Buffer.from(settingFile.apiKey);
    return a.length === k.length && timingSafeEqual(a, k);
  }

  /** The model's output must not go through the panel dictionary: raw JSON (json() translates the UI texts to Turkish). */
  const rawJson = (response, code, data) => write(response, code, 'application/json; charset=utf-8', JSON.stringify(data));
  const llmError = (response, code, message, type = 'server_error') => rawJson(response, code, { error: { message: message, type: type, code: code } });

  /** Turns a Responses request into an article written in sections; the answer in the Responses shape (text = the article JSON). */
  async function sectionedResponse(g) {
    const chat = responsesToChat(g);
    const guide = chat.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const source = chat.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const startedAt = Date.now();
    const ask = async (system, user, { format, max, temperature }) => {
      const r = await llm.req('/v1/chat/completions', { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: temperature, max_tokens: max, response_format: format, chat_template_kwargs: { enable_thinking: false }, stream: false });
      if (r.code !== 200) throw new LlmError(r.json?.error?.message ?? `Text model HTTP ${r.code}`, r.code);
      for (const k of Object.keys(usage)) usage[k] += r.json.usage?.[k] ?? 0;
      try {
        return JSON.parse(r.json.choices?.[0]?.message?.content ?? '');
      } catch {
        return {};
      }
    };
    const article = await sectionedArticle({ guide, source, ask, temperature: g.temperature ?? 0.7, progress: (m) => console.log(`[sectioned article] ${m}`) });
    console.log(`[sectioned article] done: ${countWords(article.content)} words, ${Math.round((Date.now() - startedAt) / 1000)} s`);
    return chatToResponses({ choices: [{ message: { content: JSON.stringify(article) }, finish_reason: 'stop' }], usage: usage }, llm.info.name);
  }

  /**
   * When a model trained in the panel is active, the request is brought to the training format: shortened prompts
   * (guide -> marker), a length note and no thinking (the training data had none). null when not trained (the request as it is).
   */
  const trainingProfile = () => trainedModelProfile(setting.aiRoot, llm?.info?.file);
  const textAdapt = (s, p) => applyAbbreviations(String(s ?? '').replace(`\n\n${LENGTH_NOTE}`, ''), p.abbreviations);
  // Content with images (the OpenAI array shape: text + image_url): only the text parts are adapted, the images go as they are
  const messagesAdapt = (messages, p) => messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((c) => (c?.type === 'text' ? { ...c, text: textAdapt(c.text, p) } : c)) : textAdapt(m.content, p) }));

  const getText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : '');

  /**
   * OpenAI-compatible agent: model "nedese-agent". The last user message goes to a chat, the tools run in the panel,
   * the final answer comes back as one chat.completion. metadata.chat: continue an existing chat (kept); else a
   * temporary session (deleted when done; kept with metadata.keep). metadata.approvalMode (manual | edits | auto; older: unattended), metadata.model:
   * session settings. full: with the key or from this computer.
   */
  async function completeAgent(g, full, { onChat = null } = {}) {
    if (!agent) throw new LlmError('Chat requires a local text model.', 503);
    const messages = Array.isArray(g.messages) ? g.messages : [];
    const lastIndex = messages.map((m) => m.role).lastIndexOf('user');
    if (lastIndex < 0) throw new UserError('No user message (role: "user" in messages).');
    const last = getText(messages[lastIndex].content);
    const existing = g.metadata?.chat ? agent.find(String(g.metadata.chat)) : null;
    if (g.metadata?.chat && !existing) throw new UserError('metadata.chat: no such chat.', 'notFound');
    const s = existing ?? agent.create({ title: `API · ${last.slice(0, 50)}`, full, approvalMode: g.metadata?.approvalMode, unattended: g.metadata?.unattended, model: g.metadata?.model ?? null, canAsk: false });
    if (!existing) for (const m of messages.slice(0, lastIndex)) if (m.role === 'user' || m.role === 'assistant') s.messages.push({ role: m.role, content: getText(m.content), attachments: [], time: new Date().toISOString() });
    const startedAt = Date.now();
    const before = { input: s.usage?.input ?? 0, output: s.usage?.output ?? 0 };
    let response;
    // onChat(s): a streaming request follows the chat's events while it works; returns how to stop following
    const unfollow = onChat?.(s) ?? null;
    try {
      response = await agent.sendMessage(s.id, { text: last });
    } finally {
      unfollow?.();
      // the temporary session goes; the jobs it created stay (the answer links to their files)
      if (!existing && !g.metadata?.keep) await agent.remove(s.id, { keepOutputs: true }).catch(() => {});
    }
    const duration = Math.round((Date.now() - startedAt) / 1000);
    const input = (s.usage?.input ?? 0) - before.input;
    const output = (s.usage?.output ?? 0) - before.output;
    return { id: `chatcmpl-${s.id}`, object: 'chat.completion', created: Math.floor(startedAt / 1000), model: 'nedese-agent', choices: [{ index: 0, message: { role: 'assistant', content: response }, finish_reason: s.error ? 'error' : 'stop' }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }, nedese: { chat: existing || g.metadata?.keep ? s.id : null, step: s.step, duration, error: s.error } };
  }

  const SSE_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
  const sseData = (response, data) => response.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);

  /**
   * stream: true on /llm/v1/chat/completions (user request 08.10.2026; it used to be forced off): llama-server's own
   * events are relayed as they come, then [DONE]. An error before the first event is the usual JSON error; a client
   * that goes away stops the generation.
   */
  async function streamCompletion(response, body) {
    const control = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) control.abort();
    });
    let opened = false;
    try {
      const r = await llm.req('/v1/chat/completions', body, {
        signal: control.signal,
        onEvent: (j) => {
          if (!opened) response.writeHead(200, SSE_HEADERS);
          opened = true;
          sseData(response, j);
        },
      });
      if (r.code !== 200) return rawJson(response, r.code, r.json);
      if (!opened) response.writeHead(200, SSE_HEADERS);
      opened = true;
      sseData(response, '[DONE]');
      response.end();
    } catch (e) {
      if (control.signal.aborted) return void response.destroy();
      if (!opened) throw e;
      sseData(response, { error: { message: e.message, type: 'server_error' } });
      response.end();
    }
  }

  /**
   * nedese-agent with stream: true (user request 08.10.2026): chat.completion.chunk events while the agent works — the
   * text the model writes in every step as it comes (steps apart by a blank line; its thinking as reasoning_content),
   * then whatever of the final answer did not come as pieces, and a last chunk with the finish reason, usage and the
   * nedese block (chat, step, duration, error). A client that goes away stops the agent.
   */
  async function streamAgent(response, g, full) {
    const created = Math.floor(Date.now() / 1000);
    let chatId = null;
    let opened = false;
    let streamed = ''; // the text of the current step
    let any = false;
    const chunk = (delta) => sseData(response, { id: `chatcmpl-${chatId}`, object: 'chat.completion.chunk', created, model: 'nedese-agent', choices: [{ index: 0, delta, finish_reason: null }] });
    response.on('close', () => {
      if (!response.writableFinished && chatId) {
        try {
          agent.stop(chatId);
        } catch {
          /* already gone */
        }
      }
    });
    const onChat = (s) => {
      chatId = s.id;
      response.writeHead(200, SSE_HEADERS);
      opened = true;
      chunk({ role: 'assistant', content: '' });
      let nextStep = false;
      const listen = (e) => {
        if (e.chat !== s.id) return;
        if (e.type === 'delta' && e.text) {
          if (nextStep && any) chunk({ content: '\n\n' });
          nextStep = false;
          streamed += e.text;
          any = true;
          chunk({ content: e.text });
        } else if (e.type === 'reasoning' && e.text) chunk({ reasoning_content: e.text });
        else if (e.type === 'tool' && !nextStep) {
          nextStep = true;
          streamed = '';
        }
      };
      agent.events.on('event', listen);
      return () => agent.events.off('event', listen);
    };
    try {
      const r = await completeAgent(g, full, { onChat });
      const text = String(r.choices[0].message.content ?? '');
      if (text !== streamed) chunk({ content: text.startsWith(streamed) ? text.slice(streamed.length) : `${any ? '\n\n' : ''}${text}` });
      sseData(response, { id: r.id, object: 'chat.completion.chunk', created, model: 'nedese-agent', choices: [{ index: 0, delta: {}, finish_reason: r.choices[0].finish_reason }], usage: r.usage, nedese: r.nedese });
      sseData(response, '[DONE]');
      response.end();
    } catch (e) {
      if (!opened) throw e;
      sseData(response, { error: { message: e.message, type: 'server_error' } });
      response.end();
    }
  }

  async function processLlm(req, response, sub, authorized, full = false) {
    if (!authorized) return llmError(response, 401, 'API key required: Authorization: Bearer <panel API key> (Settings).', 'invalid_request_error');
    if (!llm?.installed) return llmError(response, 503, 'Text model not installed.');
    try {
      if (req.method === 'GET' && sub === '/models') {
        // image: whether the chosen model reads images (mmproj); outside clients can check before sending an image
        return rawJson(response, 200, { object: 'list', data: [{ id: llm.info.name, object: 'model', owned_by: 'local', image: llm.understandsImages }, ...(agent ? [{ id: 'nedese-agent', object: 'model', owned_by: 'local', description: 'Panel agent: works with tools and returns the final answer (see /api/documents › Chat)' }] : [])] });
      }
      if (req.method === 'POST' && sub === '/chat/completions') {
        const g = await readJson(req);
        if (g.model === 'nedese-agent') return g.stream === true ? await streamAgent(response, g, full) : rawJson(response, 200, await completeAgent(g, full));
        const p = trainingProfile();
        if (p && Array.isArray(g.messages)) g.messages = messagesAdapt(g.messages, p);
        if (g.stream === true) return await streamCompletion(response, { chat_template_kwargs: { enable_thinking: false }, ...g, stream: true });
        const r = await llm.req('/v1/chat/completions', { chat_template_kwargs: { enable_thinking: false }, ...g, stream: false });
        return rawJson(response, r.code, r.json);
      }
      if (req.method === 'POST' && sub === '/responses') {
        const g = await readJson(req);
        // The bot's original article request (metadata.sectioned): a plan + section by section (lib/article.mjs), one JSON back.
        const p = trainingProfile();
        // A trained model learned to write the article in one call: the sectioned flow only with ready models.
        if (g.metadata?.sectioned && !p) return rawJson(response, 200, await sectionedResponse(g));
        let chat = responsesToChat(g);
        if (p) {
          const { thinking_budget_tokens: _b, ...clean } = chat;
          chat = { ...clean, messages: messagesAdapt(chat.messages, p), chat_template_kwargs: { enable_thinking: false }, max_tokens: g.max_output_tokens };
        }
        let r = await llm.req('/v1/chat/completions', { ...chat, stream: false });
        // Output that slipped into another script on the way (see foreignScript): once more without thinking; if that is broken too the first stays.
        const input = chat.messages.map((m) => m.content).join('\n');
        const text = r.code === 200 && foreignScript(input, r.json.choices?.[0]?.message?.content ?? '');
        if (text) {
          console.log(`[text model] ${text} text leaked into the output; retrying without thinking`);
          const { thinking_budget_tokens: _, ...withoutThinking } = chat;
          const r2 = await llm.req('/v1/chat/completions', { ...withoutThinking, chat_template_kwargs: { enable_thinking: false }, max_tokens: g.max_output_tokens, stream: false });
          if (r2.code === 200 && !foreignScript(input, r2.json.choices?.[0]?.message?.content ?? '')) r = r2;
        }
        return r.code === 200 ? rawJson(response, 200, chatToResponses(r.json, llm.info.name)) : rawJson(response, r.code, r.json);
      }
      return llmError(response, 404, `Unsupported endpoint: ${req.method} /llm/v1${sub} (chat/completions, responses, models)`, 'invalid_request_error');
    } catch (e) {
      if (e instanceof LlmError) return llmError(response, e.code, e.message);
      if (e instanceof UserError) return llmError(response, 400, e.message, 'invalid_request_error');
      console.error(e);
      return llmError(response, 500, e.message);
    }
  }

  function errorCode(e) {
    if (e instanceof UserError) {
      if (e.detail === 'notFound') return [404, 'notFound'];
      if (e.detail === 'inUse') return [409, 'inUse'];
      if (e.detail === 'tooLarge') return [413, 'tooLarge'];
      if (e.detail === 'disk') return [507, 'disk'];
      if (e.detail === 'forbidden') return [403, 'forbidden'];
      return [400, 'invalid'];
    }
    return [500, 'server'];
  }

  async function handle(req, response) {
    const host = String(req.headers.host ?? '');
    const names = allowedHosts(setting.address);
    if (!names.some((a) => host === `${a}:${port}`)) {
      write(response, 403, 'text/plain; charset=utf-8', 'Access from this address is not allowed.');
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      json(response, 400, { ok: false, error: 'Could not decode the address (malformed percent-encoding).', code: 'invalid' });
      return;
    }
    const source = req.headers.origin;
    const sourceAllowed = source ? names.some((a) => source === `http://${a}:${port}`) : false;
    const xPanel = req.headers['x-panel'] === '1';
    const withKey = keyCorrect(req);
    const writing = !['GET', 'HEAD'].includes(req.method);
    const clientIp = String(req.socket?.remoteAddress ?? '');
    const local = setting.localClientTrust !== false && isLocalClient(clientIp, names);
    const cookie = readCookie(req.headers.cookie);
    const withSession = Boolean(cookie && sessions?.validate(cookie));
    // A browser request (Origin / X-Panel) is trusted only from this machine or with an open session; any client can
    // write those headers, so on a network client they do not stand for an identity.
    // Sign-in is OFF by default (user decision: no accounts or sign-in; the home network and Tailscale open it
    // directly). Only with AI_PANEL_LOGIN=1 a network client needs the key or a session.
    const trusted = !setting.loginRequired || local || withSession;
    const loginRequired = (code = 401) => json(response, code, { ok: false, error: 'Sign-in is required from this device: enter the API key once (POST /api/v1/login) or send Authorization: Bearer <key>.', code: 'login' });

    /* ── The local text model: OpenAI-compatible (bots instead of DeepSeek; base_url .../llm/v1) ── */
    if (path.startsWith('/llm/v1/')) {
      await processLlm(req, response, path.slice('/llm/v1'.length), withKey || (trusted && xPanel && sourceAllowed), withKey || local);
      return;
    }

    /* ── Session: a network client enters the key once and goes on with a cookie ── */
    if (path === `${API_PREFIX}/session` && req.method === 'GET') {
      json(response, 200, { ok: true, local, withSession, withKey, loginRequired: Boolean(setting.loginRequired) && !local && !withSession && !withKey });
      return;
    }
    if (path === `${API_PREFIX}/login` && req.method === 'POST') {
      if (!sessions) {
        json(response, 400, { ok: false, error: 'This installation has no API key.', code: 'invalid' });
        return;
      }
      if (!loginLimit.allowed(clientIp)) {
        json(response, 429, { ok: false, error: 'Too many wrong attempts; try again in 15 minutes.', code: 'limit' });
        return;
      }
      let g = {};
      try {
        g = await readJson(req);
      } catch {}
      const given = Buffer.from(String(g?.key ?? '').trim());
      const correct = Buffer.from(settingFile.apiKey ?? '');
      if (!given.length || given.length !== correct.length || !timingSafeEqual(given, correct)) {
        loginLimit.failed(clientIp);
        json(response, 401, { ok: false, error: 'Wrong API key.', code: 'invalid' });
        return;
      }
      loginLimit.successful(clientIp);
      const token = sessions.create(`${clientIp} ${String(req.headers['user-agent'] ?? '').slice(0, 80)}`);
      response.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${COOKIE_OPTIONS}; Max-Age=${90 * 86400}`);
      console.log(`[session] login: ${clientIp}`);
      json(response, 200, { ok: true, message: 'Signed in; valid in this browser for 90 days.' });
      return;
    }
    if (path === `${API_PREFIX}/logout` && req.method === 'POST') {
      sessions?.remove(cookie);
      response.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${COOKIE_OPTIONS}; Max-Age=0`);
      json(response, 200, { ok: true, message: 'Signed out.' });
      return;
    }

    /* ── API v1 ── */
    if (path === `${API_PREFIX}/openapi.json`) {
      json(response, 200, openapi(v1, { address: address(), language: requestLanguage(req) }));
      return;
    }
    if (path === '/api/documents') {
      write(response, 200, 'text/html; charset=utf-8', docsPage(v1, { address: address(), language: requestLanguage(req) }));
      return;
    }    if (path.startsWith(`${API_PREFIX}/`)) {
      // File download: /api/v1/jobs/{id}/file/{file} -> the same rules as serveFile.
      const fileM = /^\/api\/v1\/jobs\/([\w-]+)\/file\/(.+)$/.exec(path);
      const subPath = path.slice(API_PREFIX.length);
      const route = v1.find((r) => r.method === req.method && r.pattern.test(subPath));
      if (!route && !fileM) {
        const other = v1.find((r) => r.pattern.test(subPath));
        json(response, other ? 405 : 404, { ok: false, error: other ? `This endpoint requires ${other.method}.` : 'No such API endpoint (see /api/documents).', code: 'notFound' });
        return;
      }
      // Access: the key OR (from this machine / with an open session) a same-origin browser (a writing request needs the Origin).
      const browser = trusted && (writing ? xPanel && sourceAllowed : xPanel || sourceAllowed || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
      if (!route?.unauthorized && !withKey && !browser) {
        if (!trusted) loginRequired();
        else json(response, 401, { ok: false, error: 'API key required: Authorization: Bearer <key> (Settings page).', code: 'unauthorized' });
        return;
      }
      if (fileM) {
        if (!['GET', 'HEAD'].includes(req.method)) {
          json(response, 405, { ok: false, error: 'This endpoint requires GET.', code: 'notFound' });
          return;
        }
        serveFile(req, response, `/file/job/${fileM[1]}/${fileM[2]}`, url);
        return;
      }
      if (!route.handler) {
        json(response, 404, { ok: false, error: 'No such API endpoint (see /api/documents).', code: 'notFound' });
        return;
      }
      const m = route.pattern.exec(subPath);
      const pathValues = Object.fromEntries(route.names.map((name, i) => [name, m[i + 1]]));
      // Chat access: full (files, commands) with the key, from this computer, with a session, or (user request and
      // permission 08.10.2026: "Panel erişimi her yere açılabilir", NAT and the firewall decide who reaches the panel)
      // from any device that opens it, unless Settings › Assistant turns that off
      const networkAccess = settingFile?.networkFullAccess !== false;
      const authority = { withKey, local, full: withKey || local || withSession || networkAccess };
      try {
        if (route.stream) {
          // Olay akisi (SSE): isleyici yaniti kendisi yazar
          await route.handler({ req, response, url, path: pathValues, authority });
          return;
        }
        const result = await route.handler({ req, url, path: pathValues, body: () => readJson(req), authority });
        if (route.path === '/settings/rotate-key') sessions?.deleteAll(); // eski anahtarla acilan oturumlar duser
        // ham: model metni iceren yanitlar sozlukten cevrilmez
        if (route.raw) rawJson(response, 200, { ok: true, ...result });
        else json(response, 200, { ok: true, ...result });
      } catch (e) {
        const [code, name] = errorCode(e);
        if (code === 500) console.error(e);
        if (response.headersSent) response.end();
        else json(response, code, { ok: false, error: friendlyError(e).message, code: name });
      }
      return;
    }

    /* ── The interface API and the files: a network client needs the key or a session ── */
    if ((path.startsWith('/api/') || path.startsWith('/file/')) && !withKey && !trusted) {
      if (path.startsWith('/file/')) write(response, 401, 'text/plain; charset=utf-8', 'Sign-in required.');
      else loginRequired();
      return;
    }
    if (req.method === 'POST') {
      const allowed = withKey || (source ? sourceAllowed : xPanel);
      if (!allowed) {
        json(response, 403, { ok: false, error: 'Request from a disallowed origin.' });
        return;
      }
    }
    for (const [method, pattern, handler] of routes) {
      if (method !== req.method) continue;
      const m = pattern.exec(path);
      if (!m) continue;
      // JSON yanit: betikten gelen istek (Accept / X-Panel / JSON govde). Duz form gonderimi
      // (betiksiz tarayici) sonucu bildirimle birlikte panele yonlendirilir.
      const jsonWants =
        req.method === 'GET' ||
        /application\/json/.test(req.headers.accept ?? '') ||
        /application\/json/.test(req.headers['content-type'] ?? '') ||
        xPanel ||
        withKey;
      try {
        const result = await handler(req, url, m.slice(1));
        if (jsonWants) json(response, 200, result);
        else redirect(response, result.message, 'success', result.retval);
      } catch (e) {
        const { message } = friendlyError(e);
        const [code] = errorCode(e);
        if (code === 500) console.error(e);
        if (jsonWants) json(response, code === 404 ? 400 : code, { ok: false, error: message });
        else redirect(response, message, 'danger');
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(response, 404, { ok: false, error: 'Not found.' });
      return;
    }
    if (path.startsWith('/file/')) {
      serveFile(req, response, path, url);
      return;
    }
    if (path === '/favicon.ico') {
      serveStatic(req, response, join(setting.webRoot, 'icon.svg'));
      return;
    }
    const target = resolve(setting.webRoot, `.${path === '/' ? '/index.html' : path}`);
    if (!target.startsWith(resolve(setting.webRoot) + sep)) {
      write(response, 404, 'text/plain; charset=utf-8', 'Not found.');
      return;
    }
    serveStatic(req, response, target);
  }

  function serveFile(req, response, path, url) {
    const part = path.split('/').slice(2);
    let file = null;
    let root = null;
    if (part[0] === 'job' && JOB_ID.test(part[1] ?? '') && part.length >= 3 && part.slice(2).every((p) => SAFE.test(p) && p !== '..')) {
      root = join(setting.outputRoot, part[1]);
      file = join(root, ...part.slice(2));
    } else if (part[0] === 'upload' && part.length === 2 && SAFE.test(part[1])) {
      root = join(setting.outputRoot, UPLOAD_FOLDER);
      file = join(root, part[1]);
    } else if (part[0] === 'voice' && part.length === 2) {
      root = setting.voiceLibrary;
      file = voicePath(setting.voiceLibrary, part[1].replace(/\.wav$/i, ''));
    }
    if (!file || !resolve(file).startsWith(resolve(root) + sep) || !existsSync(file) || !statSync(file).isFile()) {
      write(response, 404, 'text/plain; charset=utf-8', 'File not found.');
      return;
    }
    const download = url.searchParams.get('download') === '1';
    serveStatic(req, response, file, { download, cache: false });
  }

  function serveStatic(req, response, file, { download = false, cache = false } = {}) {
    let info;
    try {
      info = statSync(file);
    } catch {
      write(response, 404, 'text/plain; charset=utf-8', 'Not found.');
      return;
    }
    if (!info.isFile()) {
      write(response, 404, 'text/plain; charset=utf-8', 'Not found.');
      return;
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': cache ? 'max-age=300' : 'no-cache',
      'Last-Modified': info.mtime.toUTCString(),
    };
    if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(file.split(sep).pop())}`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      let startedAt = range[1] ? Number(range[1]) : info.size - Number(range[2]);
      let last = range[1] && range[2] ? Number(range[2]) : info.size - 1;
      startedAt = Math.max(0, startedAt);
      last = Math.min(last, info.size - 1);
      if (startedAt > last || startedAt >= info.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
        response.end();
        return;
      }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${startedAt}-${last}/${info.size}`, 'Content-Length': last - startedAt + 1 });
      if (req.method === 'HEAD') response.end();
      else createReadStream(file, { start: startedAt, end: last }).on('error', () => response.destroy()).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  }

  const server = createServer((req, response) => {
    handle(req, response).catch((e) => {
      console.error(e);
      if (!response.headersSent) json(response, 500, { ok: false, error: friendlyError(e).message, code: 'server' });
      else response.destroy();
    });
  });
  // Uzun suren API cagrilari (sahne yazimi obek obek dakikalar surebilir): yanit zaman asimi yok.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.on('listening', () => {
    port = server.address().port;
  });
  server.routes = v1;
  server.agent = agent;
  // Sunucu kapaninca ajan kaynaklari da kapanir (calisan oturumlar, arka plan komutlari, MCP alt surecleri; testlerde surec cikabilsin)
  server.on('close', () => {
    agent?.close();
    knowledge.close();
  });
  return server;
}

function write(response, code, type, text) {
  response.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  response.end(text);
}

function json(response, code, data) {
  // Program istemcilerine istenen dilde (varsayilan Ingilizce = kaynak metin); arayuz Ingilizce alip kendisi cevirir.
  const language = response.req ? requestLanguage(response.req) : 'en';
  write(response, code, 'application/json; charset=utf-8', JSON.stringify(translateData(data, language)));
}

/** Betiksiz form gonderimi: sonuc mesajiyla arayuze don (?bildirim=...#bolum). */
function redirect(response, message, type, retval = '') {
  const q = new URLSearchParams({ notification: message ?? '', type });
  response.writeHead(303, { Location: `/?${q}${retval ? `#${retval}` : ''}` });
  response.end();
}
