/**
 * Sources of the data collection job beyond the scraped search engines (user request 09.10.2026: "we added a lot of
 * search engines; they must apply to data collection too, and data collection can use skills and MCPs"):
 *  - the search services of Settings › Web search (Brave Search API, Tavily, SearXNG; lib/agent/web-search.mjs) as
 *    engines, asked before the scraped ones, one request at a time per service, backing off on 429.
 *  - MCP servers (lib/agent/mcp.mjs): the job starts the ones it names, the local text model picks calls of their
 *    tools that search or read (never ones that may change something), text in the answers becomes articles and the
 *    addresses in them join the crawl.
 *  - skills (lib/agent/skills.mjs): the SKILL.md text of the named ones (or the ones the model picks for the topic)
 *    guides the local text model where it plans the crawl (queries, the manager, MCP plans); their scripts are not run.
 */
import { SEARCH_SERVICES, serviceSearch } from './agent/web-search.mjs';
import { SEARCH_ENGINES, htmlBlocks, textBlocks } from './data-collection.mjs';

/** The search services (their keys and address are in Settings › Web search), in the order they are asked. */
export const SERVICE_ENGINES = Object.keys(SEARCH_SERVICES);
/** Every engine a data job can name: the services first, then the scraped engines (no key). */
export const ALL_ENGINES = [...SERVICE_ENGINES, ...SEARCH_ENGINES];
export const ENGINE_NAMES = { ...Object.fromEntries(SERVICE_ENGINES.map((k) => [k, SEARCH_SERVICES[k].name])), bing: 'Bing', ddg: 'DuckDuckGo', gnews: 'Google News', wiki: 'Wikipedia', test: 'test' };
/** General web engines: a query a search service answered is not asked again here (Google News and Wikipedia are). */
export const GENERAL_ENGINES = new Set(['bing', 'ddg', 'test']);

/** The engines field of a data job: names (a list or "brave, bing …"), "viki" read as "wiki"; unknown ones dropped. */
export function engineList(v) {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((m) => String(m).trim().toLowerCase()).map((m) => (m === 'viki' ? 'wiki' : m)).filter((m) => ALL_ENGINES.includes(m));
  return [...new Set(list)];
}

/** A wait that ends at once when the job is stopped or paused. */
function pause(ms, signal) {
  return new Promise((ok) => {
    if (ms <= 0 || signal?.aborted) return ok();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      ok();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const retryAfterMs = (v) => {
  const s = Number(v);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(v ?? '');
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
};

/**
 * The search services of one data job run. Each service gets one request at a time and at least minDelayMs between
 * them (Brave's free plan allows 1 per second); a 429 (or 5xx, a network error) doubles the wait (at least 2 s, at most
 * 60 s, longer when the service says so in Retry-After) and the same search is tried again twice; a refused key or
 * plan limit (401/403/432/433) or 3 failures in a row take the service out of this run. limit: searches per service in
 * one run (0 = no limit; a free plan's monthly quota is small), a site search may use half of it.
 * search() -> results ({ title, url, summary }), [] when it found nothing, null when the service is not used (any more).
 */
export function serviceSearcher({ config = {}, urls = null, signal = null, log = () => {}, minDelayMs = 1000, limit = 100 } = {}) {
  const states = new Map();
  const state = (service) => {
    let s = states.get(service);
    if (!s) {
      s = { position: Promise.resolve(), last: 0, backoff: 0, used: 0, failures: 0, off: config?.[service] ? null : 'not set', searches: 0, results: 0, errors: 0 };
      states.set(service, s);
    }
    return s;
  };
  const name = (service) => SEARCH_SERVICES[service]?.name ?? service;

  async function run(service, query, { language = null, site = null, count = 20, share = 1 } = {}) {
    const s = state(service);
    if (s.off) return null;
    if (limit && s.used >= limit * share) {
      if (share >= 1) {
        s.off = 'limit';
        log(`${name(service)}: ${limit} searches used in this run (the job's limit per service, to spare the plan's quota); the other engines go on.`);
      }
      return null;
    }
    for (let attempt = 0; ; attempt++) {
      await pause(Math.max(minDelayMs, s.backoff) - (Date.now() - s.last), signal);
      if (signal?.aborted) throw new Error('Cancelled.');
      s.last = Date.now();
      s.used++;
      s.searches++;
      try {
        const list = await serviceSearch(service, config, query, { language, signal, urls, count, site });
        s.failures = 0;
        s.backoff = Math.floor(s.backoff / 2);
        s.results += list.length;
        return list;
      } catch (e) {
        if (signal?.aborted) throw e;
        s.errors++;
        const status = e.status ?? 0;
        if ([401, 403, 432, 433].includes(status) || ++s.failures >= 3) {
          s.off = e.message;
          log(`${name(service)}: ${e.message}; not used for the rest of this run.`);
          return null;
        }
        // rate limit, server or network trouble: wait longer and try the same search again (twice)
        if (status === 429 || status >= 500 || !status) {
          const old = s.backoff;
          s.backoff = Math.min(60000, Math.max(2000, s.backoff * 2, retryAfterMs(e.retryAfter)));
          if (s.backoff !== old) log(`${name(service)}: ${status ? `HTTP ${status}` : e.message}; ${(s.backoff / 1000).toFixed(0)} s between its searches now.`);
          if (attempt < 2) continue;
        }
        return [];
      }
    }
  }

  return {
    /** One search on a service, after the searches before it on the same service (one at a time). */
    search(service, query, options = {}) {
      const s = state(service);
      const result = s.position.then(() => run(service, query, options));
      s.position = result.catch(() => {});
      return result;
    },
    /** Still in use in this run (set, not refused, its limit not reached). */
    usable: (service) => !state(service).off,
    /** { service: { searches, results, errors, off } } of the services that were asked. */
    stats: () => Object.fromEntries([...states].filter(([, s]) => s.searches).map(([k, s]) => [k, { searches: s.searches, results: s.results, errors: s.errors, off: s.off }])),
  };
}

/* ── MCP servers as sources ────────────────────────────────────────────────────────────────────── */

/** A names field (mcp, skills): a list or "a, b"; "auto" (any case) stands alone. */
export function nameList(v, split = /[\s,]+/) {
  const list = [...new Set((Array.isArray(v) ? v : String(v ?? '').split(split)).map((s) => String(s).trim()).filter(Boolean))];
  return list.some((s) => s.toLowerCase() === 'auto') ? ['auto'] : list.slice(0, 50);
}

// Words of a tool name that change something (write, delete, send, create, update, run…): such a tool is never called
const CHANGING = new Set('write delete del remove rm erase destroy drop truncate purge clear reset wipe send create add insert update upsert set put patch edit modify change rename move copy upload publish deploy install uninstall exec execute run eval kill stop start restart shutdown commit push merge pay purchase buy sell order transfer email mail sms notify invite approve reject archive generate import render record download save submit reply comment like follow book schedule cancel close launch click fill press type enable disable grant revoke lock unlock sign login logout tweet post'.split(' '));

/** The words of a tool name: "deleteNote", "delete-note" and "delete_note" give delete, note. */
const nameWords = (name) => String(name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Why the data job never calls a tool, or null when it may: the server marks it destructive or as changing its
 * environment (MCP annotations destructiveHint / readOnlyHint false), or a word of its name changes something.
 */
export function toolRefusal(tool) {
  const a = tool?.annotations ?? {};
  if (a.destructiveHint === true) return 'marked destructive';
  if (a.readOnlyHint === false) return 'marked as changing things';
  const word = nameWords(tool?.name).find((w) => CHANGING.has(w));
  return word ? `"${word}" in its name` : null;
}

/** The tools of a server the job may call ({ server, tool, description, schema }) and the ones it never calls. */
export function usableTools(server, list = []) {
  const usable = [];
  const skipped = [];
  for (const t of list) {
    if (!t?.name) continue;
    const reason = toolRefusal(t);
    if (reason) skipped.push({ tool: t.name, reason });
    else usable.push({ server, tool: t.name, description: String(t.description ?? '').replace(/\s+/g, ' ').trim(), schema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {} });
  }
  return { usable, skipped };
}

/** One tool for the model: "- server/tool: description | fields: query* string (what); limit integer". */
function toolLine(t) {
  const props = t.schema?.properties && typeof t.schema.properties === 'object' ? t.schema.properties : {};
  const required = new Set(Array.isArray(t.schema?.required) ? t.schema.required : []);
  const fields = Object.entries(props).slice(0, 12).map(([k, p]) => `${k}${required.has(k) ? '*' : ''} ${p?.type ?? (p?.enum ? 'enum' : 'any')}${Array.isArray(p?.enum) ? ` [${p.enum.slice(0, 6).join('|')}]` : ''}${p?.description ? ` (${String(p.description).replace(/\s+/g, ' ').slice(0, 80)})` : ''}`);
  return `- ${t.server}/${t.tool}: ${t.description.slice(0, 300) || '(no description)'} | fields: ${fields.join('; ') || 'none'}`;
}

export const MCP_PLAN_SYSTEM = 'You plan tool calls on MCP servers for a web data collection job on one topic. You will be given the topic, the languages, sample search queries, maybe guidance from skills, the tools you may call (server/tool, description and input fields; * = required) and the calls made so far with what they brought. Choose calls that find or read content on the topic: a search tool with a good query, a fetch or read tool with an address worth reading, a database or API tool with fitting filters. Fill every required field with a real value, never repeat a call made so far, stay within the given number of calls; if no tool fits the topic, return no calls. Reply ONLY as JSON: {"calls": [{"server": "...", "tool": "...", "arguments": {}}], "note": "one sentence"}';

/** The planner's user message. history: [{ server, tool, arguments, result }] of the calls made so far. */
export function mcpPlanPrompt({ topic, languages = [], queries = [], guidance = '', tools = [], history = [], max = 5 }) {
  let catalog = '';
  for (const t of tools.slice(0, 60)) {
    const line = toolLine(t);
    if (catalog.length + line.length > 8000) break;
    catalog += `${line}\n`;
  }
  return [
    `Topic: ${topic}`,
    `Languages: ${languages.join(', ') || 'any'}`,
    `Sample queries: ${queries.slice(0, 8).map((s) => s.query ?? s).join(' | ') || '-'}`,
    guidancePart(guidance) || null,
    `Tools you may call:\n${catalog.trim() || '-'}`,
    `Calls made so far:\n${history.slice(-15).map((c) => `${c.server}/${c.tool} ${JSON.stringify(c.arguments).slice(0, 160)} -> ${c.result}`).join('\n') || '-'}`,
    `At most ${max} calls now.`,
  ].filter(Boolean).join('\n\n');
}

/** The same call (server, tool, arguments) is made once per collection. */
export const callKey = (c) => `${c.server}/${c.tool} ${JSON.stringify(c.arguments ?? {})}`;

/**
 * The planner's answer -> { calls, refused, note }: only tools in the offered list (refused: the ones it named that
 * were not offered: unknown, or never called because they may change something), arguments an object, no call made
 * before or twice, at most max.
 */
export function mcpPlanResponse(text, tools, { made = new Set(), max = 5 } = {}) {
  const j = JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  const offered = new Set(tools.map((t) => `${t.server}/${t.tool}`));
  const calls = [];
  const refused = [];
  const keys = new Set(made);
  for (const c of Array.isArray(j?.calls) ? j.calls : []) {
    const server = String(c?.server ?? '').trim();
    const tool = String(c?.tool ?? c?.name ?? '').trim();
    if (!offered.has(`${server}/${tool}`)) {
      if (server || tool) refused.push({ server, tool });
      continue;
    }
    const args = c?.arguments ?? c?.input ?? {};
    const call = { server, tool, arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {} };
    if (keys.has(callKey(call)) || calls.length >= max) continue;
    keys.add(callKey(call));
    calls.push(call);
  }
  return { calls, refused, note: String(j?.note ?? '').replace(/\s+/g, ' ').trim() };
}

// The field of a search-like tool that takes the query
const QUERY_FIELD = /^(query|q|search|search_?query|searchterm|keywords?|terms?|topic|question|text|prompt)$/i;

/**
 * Without the text model: every tool that takes a query and needs nothing else is called with the queries in turn
 * (tool 1 with query 1, tool 2 with query 1, tool 1 with query 2 …), calls made before left out, at most max.
 */
export function ruleMcpPlan(tools, queries, { made = new Set(), max = 5 } = {}) {
  const searchers = [];
  for (const t of tools) {
    const props = t.schema?.properties && typeof t.schema.properties === 'object' ? t.schema.properties : {};
    const field = Object.keys(props).find((k) => QUERY_FIELD.test(k) && (props[k]?.type ?? 'string') === 'string');
    const required = Array.isArray(t.schema?.required) ? t.schema.required : [];
    if (field && required.every((k) => k === field)) searchers.push({ t, field });
  }
  const calls = [];
  for (const s of queries) {
    for (const { t, field } of searchers) {
      const call = { server: t.server, tool: t.tool, arguments: { [field]: s.query ?? s } };
      if (made.has(callKey(call)) || calls.some((c) => callKey(c) === callKey(call))) continue;
      calls.push(call);
      if (calls.length >= max) return calls;
    }
  }
  return calls;
}

/** http(s) addresses in a text, each once, without the punctuation that ends a sentence or a Markdown link. */
export function addressesIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s"'<>\]`|]+/g)) {
    let u = m[0].replace(/[,.;:!?*]+$/, '');
    // "(see https://a.example/x)": a closing parenthesis the address did not open is not part of it
    while (u.endsWith(')') && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1).replace(/[,.;:!?*]+$/, '');
    try {
      u = new URL(u).href;
    } catch {
      continue;
    }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

const URL_FIELDS = ['url', 'link', 'href', 'uri', 'sourceUrl', 'source_url', 'pageUrl', 'page_url', 'canonical', 'source'];
const TITLE_FIELDS = ['title', 'name', 'headline', 'label'];
const TEXT_FIELDS = ['content', 'text', 'body', 'markdown', 'fullText', 'full_text', 'raw_content', 'rawContent', 'abstract', 'extract', 'summary', 'description', 'snippet'];
const words = (s) => String(s ?? '').split(/\s+/).filter(Boolean).length;

const objectLists = (o) => Object.values(o).filter((v) => Array.isArray(v) && v.some((x) => x && typeof x === 'object' && !Array.isArray(x)));
const linkOf = (r) => URL_FIELDS.map((k) => r[k]).find((v) => typeof v === 'string' && /^https?:\/\//i.test(v)) ?? null;
const textOf = (r) => TEXT_FIELDS.map((k) => r[k]).filter((v) => typeof v === 'string').sort((a, b) => b.length - a.length)[0] ?? '';

/**
 * The record-like objects of a JSON answer: the items of a list, the lists of an object ({ results: […] }, also one
 * level down: { web: { results: […] } }), and an object that names an address or holds a long text itself.
 */
function records(j, depth = 0) {
  if (depth > 3 || !j || typeof j !== 'object') return [];
  if (Array.isArray(j)) return j.flatMap((x) => (Array.isArray(x) ? records(x, depth + 1) : x && typeof x === 'object' ? [x] : [])).slice(0, 200);
  const nested = [...objectLists(j), ...Object.values(j).filter((v) => v && typeof v === 'object' && !Array.isArray(v) && objectLists(v).length)];
  const self = linkOf(j) || words(textOf(j)) >= 50 || !nested.length ? [j] : [];
  return [...self, ...nested.flatMap((v) => records(v, depth + 1))].slice(0, 200);
}

/**
 * What an MCP tool answered, for the job: articles ({ url, title, text, html }: text long enough to be judged as an
 * article; url when the record names one) and links (addresses to crawl). JSON answers are read as records (url,
 * title and the longest text field); a text or Markdown answer is one article unless it is mostly a list of links;
 * HTML is one page. minWords: shorter texts are no articles (their addresses still count).
 */
export function mcpResultItems(text, { minWords = 50 } = {}) {
  const s = String(text ?? '').trim();
  const articles = [];
  const links = [];
  const link = (u) => {
    if (/^https?:\/\//i.test(u ?? '') && !links.includes(u)) links.push(u);
  };
  let j;
  try {
    j = /^[[{]/.test(s) ? JSON.parse(s) : undefined;
  } catch {
    j = undefined;
  }
  if (j !== undefined) {
    for (const r of records(j)) {
      const url = linkOf(r);
      const title = TITLE_FIELDS.map((k) => r[k]).find((v) => typeof v === 'string' && v.trim()) ?? '';
      const body = textOf(r);
      if (words(body) >= minWords) articles.push({ url, title: String(title).trim().slice(0, 300), text: body, html: /<\/(p|div|h[1-6]|li)>/i.test(body) ? body : null });
      else if (url) link(url);
      for (const u of addressesIn(body)) link(u);
    }
    return { articles, links };
  }
  const found = addressesIn(s);
  for (const u of found) link(u);
  const isHtml = /<(html|body|article)\b/i.test(s) || (s.match(/<\/(p|div|li|h[1-6])>/gi)?.length ?? 0) >= 3;
  const plainWords = words(isHtml ? s.replace(/<[^>]+>/g, ' ') : s.replace(/https?:\/\/\S+/g, ''));
  // a list of links (search results as text) is no article: fewer than 25 words per address
  if (plainWords >= minWords && plainWords / Math.max(1, found.length) >= 25) {
    const blocks = isHtml ? htmlBlocks(s) : { title: '', blocks: textBlocks(s) };
    const title = blocks.title || blocks.blocks.find((b) => /^h/.test(b.type))?.text || '';
    articles.push({ url: null, title, text: s, html: isHtml ? s : null });
  }
  return { articles, links };
}

/* ── Skills as guidance ────────────────────────────────────────────────────────────────────────── */

const unfence = (text) => String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');

export const SKILL_PICK_SYSTEM = 'You pick skills for a web data collection job on one topic. A skill is a set of written instructions. You will be given the topic and the installed skills (name: description). Pick the skills whose description fits finding, reading or judging sources on this topic (at most 3); pick none when no skill fits. Reply ONLY as JSON: {"skills": ["name"], "note": "one sentence"}';

/** The skill picker's user message: the topic and "- name: description" of the installed skills. */
export function skillPickPrompt(topic, skills) {
  let list = '';
  for (const s of skills.slice(0, 200)) {
    const line = `- ${s.name}: ${s.description || '(no description)'}\n`;
    if (list.length + line.length > 9000) break;
    list += line;
  }
  return `Topic: ${topic}\n\nSkills:\n${list.trim() || '-'}`;
}

/** The picker's answer -> { picked: installed names (at most max), note }. */
export function skillPickResponse(text, skills, max = 3) {
  const j = JSON.parse(unfence(text));
  const names = new Set(skills.map((s) => s.name));
  const picked = [...new Set((Array.isArray(j?.skills) ? j.skills : []).map((s) => String(s?.name ?? s ?? '').trim()))].filter((n) => names.has(n)).slice(0, max);
  return { picked, note: String(j?.note ?? '').replace(/\s+/g, ' ').trim() };
}

// The guidance in a prompt: at most this much of one skill and of all of them (the local model's context is small)
export const SKILL_CHARS = 4000;
export const GUIDANCE_CHARS = 9000;

/**
 * The guidance of loaded skills ([{ name, content }], the SKILL.md bodies) -> { text, used }: "### Skill: <name>"
 * and its body, each cut at SKILL_CHARS, all within GUIDANCE_CHARS (a skill that no longer fits is left out).
 */
export function guidanceText(loaded) {
  let text = '';
  const used = [];
  for (const s of loaded) {
    let body = String(s?.content ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!body) continue;
    if (body.length > SKILL_CHARS) body = `${body.slice(0, SKILL_CHARS).replace(/\s+\S*$/, '')} …`;
    const part = `${text ? '\n\n' : ''}### Skill: ${s.name}\n${body}`;
    if (text.length + part.length > GUIDANCE_CHARS) continue;
    text += part;
    used.push(s.name);
  }
  return { text, used };
}

/** The part of a planning prompt that carries the guidance (the MCP planner and the fake model find it by its words). */
export const guidancePart = (guidance) => (guidance ? `Guidance from skills (follow it to find and judge sources; its scripts and tools are not available here):\n${guidance}` : '');

/** Source addresses a planning answer names ("sources": [...]): http(s) only, each once, at most max. */
export function answerSources(text, max = 5) {
  try {
    const j = JSON.parse(unfence(text));
    const out = [];
    for (const v of Array.isArray(j?.sources) ? j.sources : []) {
      const s = String(v?.url ?? v ?? '').trim();
      if (!/^https?:\/\/[^\s]+$/i.test(s)) continue;
      let u;
      try {
        u = new URL(s).href;
      } catch {
        continue;
      }
      if (!out.includes(u)) out.push(u);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}
