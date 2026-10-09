/**
 * Data collection: gathers articles, documents and media from the web for training data; writes under <ai>\data\collections\<collection>\.
 *  Input (both may be given):
 *   - topic    : the tool works on its own. It generates search queries with the local model (templates without one), searches
 *                Bing RSS / DuckDuckGo / Google News (no key needed), collects the result pages and goes deeper on productive
 *                sites through feeds / sitemaps / the WordPress API / in-site crawling; stops at the target count.
 *                Search services set in Settings › Web search (Brave, Tavily, SearXNG) are asked first (user request
 *                09.10.2026; lib/data-sources.mjs): a query one of them answered skips Bing and DuckDuckGo.
 *   - sources  : a site address, RSS/Atom, OPML (feed list), sitemap, WordPress API, page link, PDF/Office
 *                document. For a site address the feed, sitemap and API are discovered; inner links are classified
 *                (text / list-category / static / doc / media) and followed up to the depth.
 *  Page processing: JSON-LD / Open Graph / meta (SEO title-description, date, author, tags, section), hreflang language
 *  alternatives (translation pairs), HTML -> Markdown blocks, extraction 'model' (local model: main content, language,
 *  topic, category, content type, tags, summary, quality, accuracy, topic fit) or 'rule' (the densest content
 *  region + Gopher style quality rules), language guess, exact and near copies (simhash), personal data masking,
 *  FAQ/HowTo question-answers, image/video/audio metadata (downloads when asked). Script-heavy pages go through
 *  Edge/Chrome on this computer (DevTools: cookie banners, scrolling, clicks, screenshots); in 'agent' mode the model
 *  decides what to click. With Common Crawl on, pages come from its archive without loading the live site.
 *  Robustness: requests in order per site, robots.txt and Crawl-delay, exponential backoff and Retry-After on 429/503,
 *  resting a site after consecutive errors, retries, a time budget (durationMin) and the estimated time left, refusing
 *  private network addresses (SSRF), a body limit, skipping content that is not HTML/XML/JSON/a document; sites in parallel.
 *  Output: articles.jsonl, images/videos/audio.jsonl, media\ (the downloads), ready-to-train chat files
 *  (training-*.jsonl) and summary.json. The same link or text is not added twice; an interrupted / paused job resumes.
 */
import { appendFileSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { extname, join } from 'node:path';
import { UserError } from '../errors.mjs';
import { diskStatus } from '../models.mjs';
import { yes, text, number, choice, slug } from './common.mjs';
import { documentText } from '../read-document.mjs';
import { Browser, browserPath, processWithBrowser } from '../browser.mjs';
import {
  SEARCH_ENGINES, EXTRACTION_SYSTEM, USER_AGENT, QUERY_SYSTEM, normalizeUrl, mergeCaptions, cleanCaption, searchUrl, searchResults, cleanResults, extractionPrompt, extractionResponse, documentType,
  feedItems, blockText, ccRecords, detectLanguage, trainingExamples, hammingDistance, htmlBlocks, contentImages, contentAudio, contentVideos, qualityRule,
  isOffTopicResult, gnewsResolveBody, gnewsResolveResponse, gnewsSignature, gnewsId, findCategory, maskPersonalData, topicFitRule, topicFitFocused, ruleExtract, linkClassify, isUnsuitable, isOtherWikiLanguage, isWikiNonContent, textDigest, opmlFeeds, isPrivateIp, robotsRules, pageLinks, pageType,
  visibleText, pageMetadata, simhash, sitemap, questionAnswers, queryPrompt, queryResponse, defaultQueries, warcBody, wpPostsUrl, wpPosts, textBlocks,
} from '../data-collection.mjs';
import {
  ENGINE_NAMES, GENERAL_ENGINES, MCP_PLAN_SYSTEM, SERVICE_ENGINES, SKILL_PICK_SYSTEM, answerSources, callKey, engineList, guidancePart, guidanceText, mcpPlanPrompt, mcpPlanResponse, mcpResultItems,
  nameList, ruleMcpPlan, serviceSearcher, skillPickPrompt, skillPickResponse, usableTools,
} from '../data-sources.mjs';
import { McpManager, mcpServers } from '../agent/mcp.mjs';
import { findSkills, loadSkill } from '../agent/skills.mjs';

export const name = 'Data collection';
/** Pausable: the request loop stops, "Resume" goes on where it left off (what is in the file is not fetched again). */
export const pausable = true;
// A long (unlimited) collection gives way when another job comes and resumes when the queue is empty (queue.mjs)
export const yields = true;
// Uses the text model itself: bot requests (/llm/v1) are not held back while it runs, they share the same model
export const textModelShares = true;
// An unlimited (topic + target 0) collection gives way to every new job that has an end (another data collection too)
export const isLong = (g) => Boolean(g?.topic) && !g?.target;
const MAX_BODY_BYTES = 6 * 2 ** 20;
// The browser mode ('always' = on every page) and the media mode: the same as the form's option values
const BROWSERS = ['automatic', 'closed', 'always', 'agent'];
const MEDIA_MODES = ['none', 'meta', 'download'];
/** Ready-to-train chat files (<name>.jsonl on disk; fixed names: existing collections and the training selection "collection/<id>/<name>"). */
export const TRAINING_FILES = ['training-meta', 'training-translation', 'training-write', 'training-summary', 'training-title', 'training-question', 'training-classification', 'training-image'];
/** The raw record files (articles / images / videos / audio.jsonl on disk). */
export const RAW_FILES = ['articles', 'images', 'videos', 'audio'];
/** Media type (the API / form key: collection/<id>/<type>) -> the name on disk (<name>.jsonl and media\<name>\). */
export const MEDIA_FILES = { images: 'images', videos: 'videos', audio: 'audio' };
const MEDIA_TYPES = Object.keys(MEDIA_FILES);

export const collectionFolder = (aiRoot, name_) => join(aiRoot, 'data', 'collections', slug(name_, 'collection').slice(0, 60));

/** The collected collections (for the Training tab and the training data selection). */
export function collections(aiRoot) {
  const root = join(aiRoot, 'data', 'collections');
  if (!existsSync(root)) return [];
  const list = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, d.name, 'articles.jsonl');
    // A collection with only media (commons:) is listed too
    if (!d.isDirectory() || ![file, ...Object.values(MEDIA_FILES).map((t) => join(root, d.name, `${t}.jsonl`))].some((y) => existsSync(y))) continue;
    let summary_ = {};
    try {
      summary_ = JSON.parse(readFileSync(join(root, d.name, 'summary.json'), 'utf8'));
    } catch {}
    const files = [...RAW_FILES, ...TRAINING_FILES].filter((e) => existsSync(join(root, d.name, `${e}.jsonl`))).map((e) => ({ name: e, count: summary_.files?.[e] ?? (e === 'articles' ? summary_.total ?? null : null) }));
    // Downloaded media (in training collection/<id>/images | videos | audio): the files under media\<name>\
    const media = Object.fromEntries(MEDIA_TYPES.map((t) => {
      try {
        return [t, readdirSync(join(root, d.name, 'media', MEDIA_FILES[t])).length];
      } catch {
        return [t, 0];
      }
    }));
    // Captioned images (the Image captioning job; in training collection/<id>/captions)
    media.captions = captionCount(join(root, d.name, 'captions.jsonl'));
    list.push({ id: d.name, name: summary_.name ?? d.name, topic: summary_.topic ?? null, total: summary_.total ?? null, languages: summary_.languages ?? {}, categories: summary_.categories ?? {}, byte: existsSync(file) ? statSync(file).size : 0, lastUpdate: summary_.lastUpdate ?? null, files, media });
  }
  return list.sort((a, b) => String(b.lastUpdate).localeCompare(String(a.lastUpdate)));
}

/** The number of distinct images in captions.jsonl. */
function captionCount(file) {
  if (!existsSync(file)) return 0;
  const seen = new Set();
  for (const s of readFileSync(file, 'utf8').split('\n')) {
    try {
      const b = JSON.parse(s);
      if (typeof b?.file !== 'string' || !b.caption) continue;
      // An image that failed the topic check does not enter training: not counted (the later record wins)
      if (b.suitable === false) seen.delete(b.file);
      else seen.add(b.file);
    } catch {}
  }
  return seen.size;
}

const domainList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((a) => String(a).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean).slice(0, 500);

export function validate(g, { setting = null } = {}) {
  const sources = (Array.isArray(g.sources) ? g.sources : String(g.sources ?? '').split(/\s+/)).map((k) => String(k).trim()).filter(Boolean);
  const topic = text(g.topic, 'Topic', { required: false, max: 300 });
  if (!sources.length && !topic) throw new UserError('Enter a topic (the tool searches on its own) or give at least one source address (site, RSS, OPML, sitemap, page, document link).');
  if (sources.length > 500) throw new UserError('At most 500 sources.');
  for (const k of sources) if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(k) && !/^cc:[\w.-]+$/i.test(k) && !/^commons:\S.{0,199}$/i.test(k)) throw new UserError(`Invalid address: ${k.slice(0, 80)} (https://…, cc:domain or commons:Category:Name / commons:search)`);
  const languages = String(g.languages ?? '').split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z]{2}$/.test(d));
  const engines = engineList(g.engines);
  // Without a choice: the search services set in Settings › Web search, then the scraped engines (a service named in
  // engines but not set is skipped at run time with a log line: it may be set before the job runs or resumes)
  const services = setting?.webSearchServices?.() ?? {};
  // MCP servers as sources: names, or "auto" (every server that is on); a name must be known (panel-data\mcp.json and
  // the other places the assistant reads its servers from)
  const mcp = nameList(g.mcp);
  if (mcp.length && mcp[0] !== 'auto' && setting?.aiRoot) {
    const known = mcpServers({ aiRoot: setting.aiRoot, dataRoot: setting.dataRoot });
    const unknown = mcp.filter((n) => !known[n]);
    if (unknown.length) throw new UserError(`No such MCP server: ${unknown.join(', ')} (known: ${Object.keys(known).join(', ') || 'none'}).`);
  }
  // Skills as guidance: names (a skill's name may hold spaces: comma or line separated), or "auto" (the model picks)
  const skills = nameList(g.skills, /[,\n]+/);
  if (skills.length && skills[0] !== 'auto' && setting?.aiRoot) {
    const known = findSkills({ aiRoot: setting.aiRoot, dataRoot: setting.dataRoot });
    const unknown = skills.filter((n) => !known.some((s) => s.name === n || s.name.split(':').pop() === n));
    if (unknown.length) throw new UserError(`No such skill: ${unknown.join(', ')} (known: ${known.slice(0, 30).map((s) => s.name).join(', ') || 'none'}${known.length > 30 ? ', …' : ''}).`);
  }
  const oldestDate = String(g.oldestDate ?? '').trim();
  if (oldestDate && !/^\d{4}-\d{2}-\d{2}$/.test(oldestDate)) throw new UserError('Earliest date must be in YYYY-MM-DD format.');
  return {
    name: text(g.name, 'Collection name', { max: 60 }),
    topic: topic || '',
    sources,
    // 0 = unlimited: collects until stopped (or durationMin runs out); gives way when another job comes (yields)
    target: number(g.target, 'Target article count', { min: 0, max: 1000000, full: true, defaultValue: 200 }),
    // Site to site: also goes on to the sites of the outbound links on accepted pages (on by default in topic mode)
    // Only with a topic: without one, following every outbound link would turn into an endless web crawl
    hopSites: Boolean(topic) && (g.hopSites === undefined || g.hopSites === null || g.hopSites === '' ? true : yes(g.hopSites)),
    // Manager: the local model looks at the summary at intervals and steers (prioritize / release / new queries); needs the model + a topic
    manager: g.manager === undefined || g.manager === null || g.manager === '' ? true : yes(g.manager),
    max: number(g.max, 'Max articles per source', { min: 1, max: 5000, full: true, defaultValue: 50 }),
    extract: g.extract === 'rule' ? 'rule' : 'model',
    minWord: number(g.minWord, 'Minimum words', { min: 20, max: 5000, full: true, defaultValue: 300 }),
    minQuality: number(g.minQuality, 'Minimum quality', { min: 1, max: 5, full: true, defaultValue: 3 }),
    minAccuracy: number(g.minAccuracy, 'Minimum accuracy', { min: 1, max: 5, full: true, defaultValue: 2 }),
    minFit: number(g.minFit, 'Minimum topic fit', { min: 1, max: 5, full: true, defaultValue: 3 }),
    languages: languages.length ? languages : topic ? ['tr'] : [],
    engines: engines.length ? engines : [...SERVICE_ENGINES.filter((k) => services[k]), ...SEARCH_ENGINES],
    // Searches per search service in one run (0 = no limit): a free plan's monthly quota is small (Brave, Tavily)
    serviceLimit: number(g.serviceLimit, 'Searches per service', { min: 0, max: 100000, full: true, defaultValue: 100 }),
    mcp,
    // Tool calls on the MCP servers in one run (the planner asks for at most 8 per search round)
    mcpCalls: number(g.mcpCalls, 'MCP calls per run', { min: 1, max: 500, full: true, defaultValue: 20 }),
    skills,
    parallel: number(g.parallel, 'Parallel sites', { min: 1, max: 8, full: true, defaultValue: 4 }),
    depth: number(g.depth, 'In-site crawl depth', { min: 0, max: 3, full: true, defaultValue: 1 }),
    sitePerPage: number(g.sitePerPage, 'Max pages per site', { min: 5, max: 5000, full: true, defaultValue: 200 }),
    browser: choice(String(g.browser ?? ''), 'Browser', BROWSERS, 'automatic'),
    media: choice(String(g.media ?? ''), 'Media', MEDIA_MODES, 'meta'),
    mediaMaxMb: number(g.mediaMaxMb, 'Media file max MB', { min: 1, max: 5000, full: true, defaultValue: 300 }),
    // 0 = unlimited: downloads until MEDIA_DISK_MARGIN is left free on the disk
    mediaTotalGb: number(g.mediaTotalGb, 'Media total max GB', { min: 0, max: 100000, defaultValue: 0 }),
    documents: g.documents === undefined ? true : yes(g.documents),
    translationPairs: g.translationPairs === undefined ? true : yes(g.translationPairs),
    wpApi: g.wpApi === undefined ? true : yes(g.wpApi),
    commonCrawl: yes(g.commonCrawl),
    onlyNew: yes(g.onlyNew),
    maskPersonalData: g.maskPersonalData === undefined ? true : yes(g.maskPersonalData),
    qualityRules: g.qualityRules === undefined ? true : yes(g.qualityRules),
    durationMin: number(g.durationMin, 'Time limit (min)', { min: 0, max: 10080, full: true, defaultValue: 0 }),
    onlyDomains: domainList(g.onlyDomains),
    blockedDomains: domainList(g.blockedDomains),
    oldestDate: oldestDate || null,
  };
}

export function summary(g) {
  const sources = `${g.sources.length} source${g.sources.length === 1 ? '' : 's'}`;
  const what = g.topic ? `topic: ${g.topic.slice(0, 40)} · ${g.target ? `target ${g.target}` : 'unlimited'}${g.sources.length ? ` · +${sources}` : ''}` : `${sources} · at most ${g.max} per source`;
  const hop = g.hopSites ? ' · site to site' : '';
  const mcp = g.mcp?.length ? ` · MCP: ${g.mcp.join(', ')}` : '';
  const skills = g.skills?.length ? ` · skills: ${g.skills.join(', ')}` : '';
  return { title: g.name, detail: `${what}${hop}${mcp}${skills} · extraction: ${g.extract === 'model' ? 'local model' : 'rule'}${g.durationMin ? ` · ${g.durationMin} min` : ''}` };
}

/* ── Fetcher: per-site order, delays and exponential backoff; robots; private networks; body limit; retries ─────── */

const TEXT_TYPE = /^(text\/|application\/(xml|rss|atom|json|xhtml|ld\+json|x-ndjson))|\+xml|\+json/i;
// Wikimedia limits clients posing as a browser (429, "wait 600 s"), a name that openly introduces the tool is free (measured 05.10.2026)
const TOOL_AGENT = 'NedeseStudioData/2.0 (+https://github.com/mustafa-ozen95/nedese-studio)';
const TOOL_AGENT_HOSTS = /(^|\.)(wikimedia|wikipedia|wikidata|wikisource|wiktionary|wikibooks|wikiquote|wikivoyage|mediawiki)\.org$/i;
/** RateLimit-Remaining / -Reset (the IETF draft and the X- prefixed ones): the requests left and the ms until the reset. */
function limitHeaders(h) {
  const remaining = Number(h.get('ratelimit-remaining') ?? h.get('x-ratelimit-remaining') ?? NaN);
  const raw = h.get('ratelimit-reset') ?? h.get('x-ratelimit-reset');
  let resetMs = null;
  if (raw !== null && raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n)) resetMs = n > 1e9 ? Math.max(0, n * 1000 - Date.now()) : n * 1000; // epoch or seconds
  }
  return { limitRemaining: Number.isFinite(remaining) ? remaining : null, limitResetMs: resetMs };
}
const TEMP_ERROR = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const retryAfterMs = (v) => {
  if (!v) return 0;
  const sec = Number(v);
  if (Number.isFinite(sec)) return sec * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
};

/**
 * A delayed GET in order per site. Refuses private network addresses (redirects too), limits the body, backs off
 * exponentially per site on 429/5xx and network errors (honouring Retry-After), rests the site 10 min after 5 errors in a row,
 * retries temporary errors twice. Returns: { code, text|data, url, type, cut } or { forbidden } / { rest }.
 */
export function setupExtractor(signal, { privateNetworkAllowed = false, minDelayMs = 1000, log = () => {}, timeUp = () => false } = {}) {
  const sites = new Map(); // host -> { rules, last, position, penalty, consecutiveError, restEnd }
  const addresses = new Map(); // host -> allowed or not
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  // A wait that ends at once on cancel / pause (a long rate limit wait must not lock the job)
  const abortableWait = (ms) => new Promise((ok) => {
    if (signal?.aborted) return ok();
    const finish = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', finish);
      ok();
    };
    const t = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
  const stats = { req: 0, error: 0, wait: 0, rest: 0 };

  async function checkAddress(u) {
    if (privateNetworkAllowed) return;
    // refused: never retried or waited for (a search result on a private address made the site wait 45 s)
    if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error(`Only http/https: ${u.href.slice(0, 80)}`), { refused: true });
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let permission = addresses.get(host);
    if (permission === undefined) {
      try {
        const resolved = await lookup(host, { all: true });
        permission = resolved.length > 0 && !resolved.some((a) => isCustomIp(a.address));
      } catch {
        permission = false;
      }
      addresses.set(host, permission);
    }
    if (!permission) throw Object.assign(new Error(`Address could not be resolved or points to a private network: ${host}`), { refused: true });
  }

  /** toFile: the binary body streams into this file without going through memory (large media; 8 parallel 300 MB videos were filling the RAM). */
  async function fetchRaw(url, { limit = MAX_BODY_BYTES, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', timeMs = 25000, binary = false, headers = {}, toFile = null, method = 'GET', requestBody = undefined } = {}) {
    let u = new URL(url);
    for (let step = 0; step <= 5; step++) {
      await checkAddress(u);
      const signals = [AbortSignal.timeout(timeMs), ...(signal ? [signal] : [])];
      const r = await fetch(u.href, { method: method, body: requestBody, headers: { 'User-Agent': TOOL_AGENT_HOSTS.test(u.hostname) ? TOOL_AGENT : USER_AGENT, Accept: accept, 'Accept-Language': 'tr,en;q=0.8,*;q=0.5', ...headers }, redirect: 'manual', signal: AbortSignal.any(signals) });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const location = r.headers.get('location');
        await r.body?.cancel().catch(() => {});
        if (!location) return { code: r.status, url: u.href };
        u = new URL(location, u);
        continue;
      }
      const type = (r.headers.get('content-type') ?? '').toLowerCase();
      if (!r.ok && r.status !== 206) {
        const body = r.status === 403 ? await r.text().catch(() => '') : '';
        await r.body?.cancel().catch(() => {});
        return { code: r.status, url: u.href, type, retryAfter: r.headers.get('retry-after'), ...limitHeaders(r.headers), guarded: /cloudflare|captcha|just a moment|access denied|attention required/i.test(body.slice(0, 20000)) };
      }
      if (!binary && type && !TEXT_TYPE.test(type)) {
        await r.body?.cancel().catch(() => {});
        return { code: 415, url: u.href, type };
      }
      if (Number(r.headers.get('content-length') || 0) > limit) {
        await r.body?.cancel().catch(() => {});
        return { code: 413, url: u.href, type };
      }
      if (binary && toFile) {
        const out = createWriteStream(toFile);
        let written = 0;
        let exceeded = false;
        try {
          for await (const part of r.body) {
            written += part.length;
            if (written > limit) {
              exceeded = true;
              break;
            }
            if (!out.write(part)) await once(out, 'drain');
          }
        } finally {
          await new Promise((ok) => out.end(ok));
        }
        if (exceeded) rmSync(toFile, { force: true });
        return { code: r.status, fileSize: exceeded ? 0 : written, url: u.href, type, cut: exceeded, ...limitHeaders(r.headers) };
      }
      const parts = [];
      let received = 0;
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        parts.push(value);
        if (received > limit) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
      const body = Buffer.concat(parts);
      if (binary) return { code: r.status, data: body, url: u.href, type, cut: received > limit, ...limitHeaders(r.headers) };
      const characterSet = /charset=([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1] ?? 'utf-8';
      let text_;
      try {
        text_ = new TextDecoder(characterSet).decode(body);
      } catch {
        text_ = body.toString('utf8');
      }
      return { code: r.status, text: text_, url: u.href, type, cut: received > limit, ...limitHeaders(r.headers) };
    }
    return { code: 310, url: u.href };
  }

  function site(host) {
    let s = sites.get(host);
    if (!s) {
      // range: the request interval learnt for this site (ms); successSeries: 20 successes shorten it; nextPermission: from the limit headers
      s = { rules: null, last: 0, position: Promise.resolve(), penalty: 0, consecutiveError: 0, restEnd: 0, range: 0, successSeries: 0, nextPermission: 0 };
      sites.set(host, s);
    }
    return s;
  }

  function toQueue(host, worker) {
    const s = site(host);
    const result = s.position.then(worker);
    s.position = result.catch(() => {});
    return result;
  }

  function processError(s, r, e, base = minDelayMs) {
    s.consecutiveError++;
    stats.error++;
    const requested = retryAfterMs(r?.retryAfter);
    // Rate limit (429 / 503): this site's request interval doubles (at least 2, at most 60 s); successes shorten it again
    if (r?.code === 429 || r?.code === 503) {
      const old = Math.max(s.range, base);
      s.range = Math.min(60000, Math.max(old * 2, 2000));
      s.successSeries = 0;
      if (s.range !== old) log(`${s.host}: rate limited (${r.code}); request interval raised to ${(s.range / 1000).toFixed(1)} s${requested ? `, the server asked to wait ${Math.round(requested / 1000)} s` : ''}.`);
    }
    s.penalty = Math.min(90000, Math.max(3000, s.penalty * 2, Math.min(requested, 90000)));
    if (requested > 90000) s.restEnd = Date.now() + Math.min(requested, 3600000);
    if (s.consecutiveError >= 5 && !s.restEnd) {
      s.restEnd = Date.now() + 10 * 60000;
      stats.rest++;
      log(`${s.host}: ${s.consecutiveError} consecutive errors (${r?.code ?? e?.message ?? '?'}); resting the site for 10 min.`);
    }
  }

  /** waiting: when the site is resting after a rate limit (at most 15 min) wait and try (media downloads); otherwise return {rest} (page crawling moves to another site). */
  async function retrieve(url, { checkRobots = true, retries = 2, waiting = false, ...options } = {}) {
    const u = new URL(url);
    return toQueue(u.host, async () => {
      const s = site(u.host);
      s.host = u.host;
      const LONG = 15 * 60000;
      if (Date.now() < s.restEnd && (!waiting || s.restEnd - Date.now() > LONG)) return { rest: true, remainingMs: s.restEnd - Date.now(), url: u.href };
      // When the reset in the limit headers is far off (minutes) a page request does not wait, it moves to another site
      if (!waiting && s.nextPermission - Date.now() > 60000) return { rest: true, remainingMs: s.nextPermission - Date.now(), url: u.href };
      if (!s.rules) {
        s.rules = robotsRules('');
        try {
          const r = await fetchRaw(`${u.protocol}//${u.host}/robots.txt`, { limit: 256 * 1024, accept: 'text/plain,*/*;q=0.5', timeMs: 15000 });
          if (r.code === 200 && r.text) s.rules = robotsRules(r.text);
          else if (r.code >= 500) s.rules = robotsRules('User-agent: *\nDisallow: /'); // RFC 9309: everything is forbidden on a server error
        } catch (e) {
          if (signal?.aborted) throw e;
        }
      }
      if (checkRobots && !s.rules.allowed(u.pathname + u.search)) return { forbidden: true, url: u.href };
      const base = Math.max(minDelayMs, s.rules.delay * 1000);
      for (let d = 0; ; d++) {
        // The wait: the learnt interval, the error penalty, the limit headers; for a waiting request also the rest the server asked for
        const delay = Math.max(Math.max(s.range, base, s.penalty) - (Date.now() - s.last), s.nextPermission - Date.now(), waiting ? s.restEnd - Date.now() : 0);
        if (delay > 0) {
          stats.wait += delay;
          await abortableWait(delay);
        }
        if (Date.now() >= s.restEnd) s.restEnd = 0;
        if (signal?.aborted) throw new Error('Cancelled.');
        s.last = Date.now();
        stats.req++;
        let r;
        let error = null;
        try {
          r = await fetchRaw(u.href, options);
        } catch (e) {
          if (signal?.aborted || e.refused) throw e;
          error = e;
        }
        const temp = error ? /abort|timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|fetch failed|socket/i.test(String(error.message)) : TEMP_ERROR.has(r.code);
        if (!temp && !error) {
          s.penalty = Math.floor(s.penalty / 2);
          s.consecutiveError = 0;
          // Learning speed: after 20 successes in a row the interval shortens by 15% (not below the base)
          if (++s.successSeries >= 20 && s.range > base) {
            s.range = Math.max(base, Math.round(s.range * 0.85));
            s.successSeries = 0;
          }
          // When the server reports the requests left: once they run out, wait until the reset time
          if (r.limitRemaining !== null && r.limitRemaining <= 1 && r.limitResetMs > 0) s.nextPermission = Date.now() + Math.min(r.limitResetMs, 3600000);
          if (checkRobots && r.url && r.url !== u.href) {
            const last = new URL(r.url);
            const rule = last.host === u.host ? s.rules : sites.get(last.host)?.rules;
            if (rule && !rule.allowed(last.pathname + last.search)) return { forbidden: true, url: r.url };
          }
          return r;
        }
        processError(s, r, error, base);
        if (d >= retries || (Date.now() < s.restEnd && (!waiting || s.restEnd - Date.now() > LONG)) || timeUp() || signal?.aborted) {
          if (error) throw error;
          return r;
        }
      }
    });
  }
  retrieve.stats = stats;
  retrieve.siteStatus = (host) => sites.get(host) ?? null;
  return retrieve;
}

/* ── Source expansion ────────────────────────────────────────────────────────────────────────── */

const PRIORITIZED_MAP = /post|news|article|blog|haber|yazi|makale|story/i;

/**
 * Source -> { links: [{ link, title, dateText, attachments }], wpApi, ready, discovery }. Feed/OPML/sitemap items;
 * on an HTML page feed, sitemap (robots.txt) or WordPress API discovery; otherwise the page itself (inner links by crawling).
 */
async function expandSource(retrieve, source, g, log, lastUpdate, depth = 0) {
  if (/\/wp-json(\/|$)/i.test(source) && g.wpApi) return { links: [], wpApi: source.replace(/\/wp\/v2\/.*$/i, '').replace(/\/$/, '') };
  const r = await retrieve(source, { checkRobots: false });
  if (!r.text) {
    log(`${source}: could not be read (${r.forbidden ? 'robots' : r.rest ? 'site resting' : `HTTP ${r.code ?? '?'}`})`);
    return { links: [], wpApi: null };
  }
  const type = documentType(r.text);
  const isNew = (dateText) => !g.onlyNew || !lastUpdate || !dateText || String(dateText) >= lastUpdate;
  if (type === 'rss' || type === 'atom') return { links: feedItems(r.text).filter((o) => isNew(o.dateText)).map((o) => ({ link: o.link, title: o.title, dateText: o.dateText, summary: o.summary, attachments: o.attachments })), wpApi: null, discovery: 'feed' };
  if (type === 'opml') return { links: [], wpApi: null, subSources: opmlFeeds(r.text) };
  if (type === 'site-map') return { links: sitemap(r.text).filter((k) => isNew(k.dateText)).slice(0, g.max * 4).map((k) => ({ link: k.loc, dateText: k.dateText })), wpApi: null, discovery: 'sitemap' };
  if (type === 'site-map-directory') {
    const subs = sitemap(r.text).sort((a, b) => Number(PRIORITIZED_MAP.test(b.loc)) - Number(PRIORITIZED_MAP.test(a.loc))).slice(0, 5);
    const all = [];
    for (const sub of subs) {
      try {
        const a = await retrieve(sub.loc, { checkRobots: false });
        if (a.text) all.push(...sitemap(a.text).filter((k) => isNew(k.dateText)).map((k) => ({ link: k.loc, dateText: k.dateText })));
      } catch (e) {
        if (retrieve.isCancelled?.()) throw e;
      }
      if (all.length >= g.max * 4) break;
    }
    return { links: all.slice(0, g.max * 4), wpApi: null, discovery: 'sitemap index' };
  }
  if (type === 'json') return { links: [], wpApi: null };
  const u = pageMetadata(r.text, r.url || source);
  if (g.wpApi && u.wpApi) return { links: [], wpApi: u.wpApi.replace(/\/$/, ''), page: { link: r.url || source }, ready: r };
  // Feed / sitemap discovery only when a site root (/, /tr/, /blog/, /index.html) is given: for a given page that
  // page is taken (with its inner links when depth is on). A Wikipedia article turned to the "recent changes" feed and gave
  // 0 articles (06.10.2026). Wiki special pages and history feeds are not content feeds.
  let path_ = '/';
  try {
    path_ = new URL(r.url || source).pathname;
  } catch {}
  const isRoot = /^\/(?:[^/]+\/)?(?:index\.(?:html?|php|aspx?))?$/i.test(path_);
  if (depth === 0 && isRoot) {
    // A feed that comes back empty (robots, broken) moves on to the next
    for (const discovery of u.feeds.filter((b) => !isWikiNonContent(b) && !/[?&]action=history/i.test(b)).slice(0, 3)) {
      log(`${source}: feed found (${discovery})`);
      const sub = await expandSource(retrieve, discovery, g, log, lastUpdate, 1);
      if (sub.links.length) return { ...sub, ready: r };
    }
    try {
      const robots = await retrieve(`${new URL(source).origin}/robots.txt`, { checkRobots: false, limit: 256 * 1024, accept: 'text/plain,*/*;q=0.5' });
      const map = robots.text ? robotsRules(robots.text).siteMaps[0] : null;
      if (map) {
        log(`${source}: sitemap found (${map})`);
        const sub = await expandSource(retrieve, map, g, log, lastUpdate, 1);
        if (sub.links.length) return { ...sub, ready: r };
      }
    } catch (e) {
      if (retrieve.isCancelled?.()) throw e;
    }
  }
  return { links: [{ link: r.url || source }], wpApi: null, ready: r, discovery: 'page' };
}

/* ── Job flow ────────────────────────────────────────────────────────────────────────────────── */

async function askModel(ctx, system, user, maxTokens) {
  // A leftover worker of a stopped job must not reopen the text model (under another job that took the GPU)
  if (ctx.signal?.aborted) throw new Error('Cancelled.');
  const r = await ctx.llm.req('/v1/chat/completions', {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' }, temperature: 0.1, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false }, stream: false,
  }, { externalRequest: false });
  if (ctx.signal?.aborted) throw new Error('Cancelled.');
  if (r.code !== 200) throw new Error(r.json?.error?.message ?? `Text model HTTP ${r.code}`);
  return r.json.choices?.[0]?.message?.content ?? '';
}

/** Reads a collection file line by line (a large file does not fit in one string). */
async function readRecords(file, each) {
  if (!existsSync(file)) return 0;
  let n = 0;
  for await (const s of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
    if (!s.trim()) continue;
    try {
      each(JSON.parse(s));
      n++;
    } catch {}
  }
  return n;
}

let ccDirectory = { id: null, time: 0 };
// Site to site: on these huge general sites only the linked pages are taken (no home page / sitemap discovery)
const WIDE_SITE = /(^|\.)(wikipedia\.org|wikimedia\.org|wiktionary\.org|wikibooks\.org|wikisource\.org|archive\.org|medium\.com|github\.com|stackexchange\.com|stackoverflow\.com|quora\.com|blogspot\.com|wordpress\.com|tumblr\.com)$/i;
// Sites never visited by site hopping: social networks, search, shops, shorteners, ads/tracking, embedded video platforms
const SKIPPED_SITES = /(^|\.)(facebook\.com|fb\.com|fb\.me|twitter\.com|x\.com|t\.co|instagram\.com|threads\.net|youtube\.com|youtu\.be|linkedin\.com|pinterest\.[a-z.]+|tiktok\.com|reddit\.com|t\.me|telegram\.(me|org)|wa\.me|whatsapp\.com|google\.[a-z.]+|goo\.gl|g\.co|bing\.com|yandex\.[a-z.]+|duckduckgo\.com|bit\.ly|tinyurl\.com|ow\.ly|amazon\.[a-z.]+|amzn\.to|ebay\.[a-z.]+|aliexpress\.com|apple\.com|microsoft\.com|doubleclick\.net|googlesyndication\.com|googletagmanager\.com|addthis\.com|sharethis\.com|gravatar\.com|schema\.org|w3\.org|creativecommons\.org|cloudflare\.com|disqus\.com|spotify\.com|soundcloud\.com|vimeo\.com|twitch\.tv|discord\.(gg|com)|patreon\.com|paypal\.com|feedburner\.com|wordpress\.org|wikidata\.org|mediawiki\.org|wikimediafoundation\.org|meta\.wikimedia\.org)$/i;
const MEDIA_DISK_MARGIN = 10 * 2 ** 30;
const MANAGER_INTERVAL_MS = 8 * 60000;
// Text model prompts (the JSON keys are the ones parsed below; the fake model in the tests knows them by these sentences)
const MANAGER_SYSTEM = 'You manage a long-running, topic-focused web data collection crawl. You will be given a summary of the crawl: the topic, what has been collected, the last accepted articles, productive and empty sites, the queued sites (with score and a sample link) and the queries used so far. Set the strategy: prioritize the queued sites most likely to bring new content on the topic; release the ones that look off-topic, repetitive or unproductive; suggest new search queries for subtopics and angles of the topic not collected yet (do not repeat used queries; each query 2-6 words, in the requested languages). If no new direction is left, newQueries must be empty. When guidance from skills is given, follow it to find and judge sources, and you may name up to 5 source addresses it points to (home pages, feeds or pages not crawled yet) as "sources". Reply ONLY as JSON: {"prioritized": [site names], "release": [site names], "newQueries": [{"language": "tr", "query": "..."}], "sources": ["https://..."], "note": "one-sentence assessment"}';
const LINK_PICK_SYSTEM = 'You are guiding a crawler that collects web data on a topic. You will be given the topic, the title of the current page and the NUMBERED external links on that page (address — link text). Select the links directly related to the topic where new content (articles, images, videos, audio) can be found; do not select ads, social networks, shops, login/membership pages, generic home pages, bibliography catalogs or off-topic links. At most 8. Reply ONLY as JSON: {"select": [numbers]}';
const AGENT_SYSTEM = 'You are on a web page; the goal is to make the page\'s MAIN text content fully visible (read more / show all / next page and the like). You will be given the page title, the beginning of the visible text and the NUMBERED interactive elements. If the content is already complete or there is nothing to do, say done. Reply ONLY as JSON: {"action": "click"|"scroll"|"done", "target": element number|null}';

export async function run(ctx) {
  const g = ctx.job.input;
  const folder = collectionFolder(ctx.setting.aiRoot, g.name);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'articles.jsonl');
  const oldSummary = existsSync(join(folder, 'summary.json')) ? JSON.parse(readFileSync(join(folder, 'summary.json'), 'utf8')) : {};
  const seenLink = new Set();
  const seenText = new Set();
  const seenMedia = new Set();
  const fingerprints = [];
  const sourceCount = new Map();
  // Site to site: the sites of the outbound links on accepted pages: name -> [score (times linked), origin address, linking pages]
  const siteQueue = new Map();
  const visitedSites = new Set();
  const walking = new Map(); // name -> [score, address, pages]: re-crawled on resume when paused before finishing
  const queueFile = join(folder, 'site-queue.json');
  // Manager memory: site results (accepted, tried), queries used, the last accepted titles
  const siteResult = new Map();
  const usedQueries = new Set();
  const lastAccepted = [];
  // MCP calls made for this collection (callKey): a resumed or repeated run does not make them again
  const mcpMade = new Set();
  for (const path of [queueFile, `${queueFile}.bak`]) {
    if (!existsSync(path)) continue;
    try {
      const k = JSON.parse(readFileSync(path, 'utf8'));
      // Unwanted wiki language editions / Wikimedia subdomains in an old queue are dropped
      for (const [h, p, a, l] of k.queue ?? []) if (!isOtherWikiLanguage(h, g.languages)) siteQueue.set(h, [p, a ?? `https://${h}/`, Array.isArray(l) ? l : []]);
      for (const h of k.visited ?? []) visitedSites.add(h);
      for (const [h, accepted, tried] of k.results ?? []) siteResult.set(h, [accepted, tried]);
      for (const s of k.queries ?? []) usedQueries.add(s);
      for (const s of k.mcpMade ?? []) mcpMade.add(s);
      break;
    } catch (e) {
      ctx.log(`${path.endsWith('.bak') ? 'Site queue backup' : 'Site queue'} could not be read (${String(e.message).slice(0, 80)})${path.endsWith('.bak') ? '' : '; reading the backup'}.`);
    }
  }
  let queueChange = 0;
  let queueLastRecord = 0;
  /** Atomic: written as .tmp and renamed, the previous one becomes .bak. Unless forced at most once in 15 s (the file may be MBs). */
  const saveQueue = (force = false) => {
    if (!force && Date.now() - queueLastRecord < 15000) return;
    queueLastRecord = Date.now();
    const text = JSON.stringify({ queue: [...walking, ...siteQueue].map(([h, [p, a, l]]) => [h, p, a, l ?? []]).sort((x, y) => y[1] - x[1]).slice(0, 20000), visited: [...visitedSites], results: [...siteResult].slice(-3000).map(([h, [accepted, tried]]) => [h, accepted, tried]), queries: [...usedQueries].slice(-500), mcpMade: [...mcpMade].slice(-500) });
    writeFileSync(`${queueFile}.tmp`, text);
    if (existsSync(queueFile)) {
      try {
        copyFileSync(queueFile, `${queueFile}.bak`);
      } catch {}
    }
    renameSync(`${queueFile}.tmp`, queueFile);
  };
  const siteName = (u) => {
    try {
      return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  /**
   * The outbound links of an accepted page go to the site queue. With a model (extract: model, topic mode) the model picks
   * the on-topic ones (one call per page; a picked link scores 3); without one, or when the model cannot answer, all of them (1 point).
   */
  async function addExternalSites(html, pageUrl, title = '') {
    if (!g.hopSites || !html) return;
    const own = siteName(pageUrl);
    let candidates = pageLinks(html, pageUrl).filter((l) => {
      if (l.cls !== 'external') return false;
      const h = siteName(l.url);
      return h && h !== own && !visitedSites.has(h) && !walking.has(h) && !SKIPPED_SITES.test(h) && !isOtherWikiLanguage(h, g.languages) && !isWikiNonContent(l.url) && domainAllowed(l.url);
    });
    let score = 1;
    if (useModel && g.topic && candidates.length > 1) {
      const list = candidates.slice(0, 40);
      try {
        const response = await askModel(ctx, LINK_PICK_SYSTEM, `Topic: ${g.topic}\nPage: ${String(title).slice(0, 150)}\n\n${list.map((l, i) => `[${i}] ${l.url.slice(0, 160)} — ${(l.text || '').slice(0, 90)}`).join('\n')}`, 120);
        const selected = JSON.parse(String(response).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')).select;
        if (Array.isArray(selected)) {
          candidates = [...new Set(selected.map(Number))].filter((i) => Number.isInteger(i) && list[i]).slice(0, 8).map((i) => list[i]);
          score = 3;
          counter.modelLinks += candidates.length;
        }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        /* the model could not pick: fall back to the rule (all of them) */
      }
    }
    for (const l of candidates) {
      const h = siteName(l.url);
      if (visitedSites.has(h) || walking.has(h)) continue; // crawling started / released while the model was asked
      const previous = siteQueue.get(h);
      const pages = previous?.[2] ?? [];
      if (pages.length < 10 && !pages.includes(l.url)) pages.push(l.url);
      siteQueue.set(h, [(previous?.[0] ?? 0) + score, previous?.[1] ?? `${new URL(l.url).origin}/`, pages]);
      if (++queueChange % 25 === 0) saveQueue();
    }
  }
  let total = await readRecords(file, (o) => {
    for (const l of [o.url, o.canonical, o.feedLink]) if (l) seenLink.add(l);
    if (o.digest) seenText.add(o.digest);
    if (o.simhash) fingerprints.push(o.simhash);
    if (o.source) sourceCount.set(o.source, (sourceCount.get(o.source) ?? 0) + 1);
  });
  // Media records: downloaded, permanently failed, embedded (not direct) video or meta mode count as seen.
  // Pending downloads (left in the pool when the job stopped) are queued again below; an older version's fileless record is retried.
  const pendingMedia = new Map(); // url -> [type, record]
  for (const type of MEDIA_TYPES) {
    await readRecords(join(folder, `${MEDIA_FILES[type]}.jsonl`), (o) => {
      if (o.file || o.downloadFailed || g.media !== 'download' || o.direct === false) {
        seenMedia.add(o.url);
        pendingMedia.delete(o.url);
      } else if (o.waiting && o.download && !seenMedia.has(o.url)) pendingMedia.set(o.url, [type, o]);
    });
  }
  // Tried pages (accepted or refused for their content): not downloaded and asked to the model again on resume
  const triedFile = join(folder, 'tried.txt');
  if (existsSync(triedFile)) for (const s of readFileSync(triedFile, 'utf8').split('\n')) if (s) seenLink.add(s);
  let triedBuffer = [];
  const writeTried = () => {
    if (!triedBuffer.length) return;
    appendFileSync(triedFile, `${triedBuffer.join('\n')}\n`);
    triedBuffer = [];
  };
  const wasTried = (...addresses) => {
    for (const a of addresses) if (a) triedBuffer.push(a);
    if (triedBuffer.length >= 50) writeTried();
  };
  // The progress of earlier runs (target and time go on where they were after giving way / pausing)
  const previous = ctx.job.dataProgress ?? { added: 0, elapsedMs: 0 };
  ctx.job.noYield = false;
  const useModel = g.extract === 'model' && ctx.llm?.installed;
  if (g.extract === 'model' && !ctx.llm?.installed) ctx.log('Text model not installed: using rule-based extraction and template queries.');
  if (useModel) await ctx.flushVoiceForGpu();
  const start = Date.now();
  const endTime = g.durationMin ? start + Math.max(0, g.durationMin * 60000 - previous.elapsedMs) : Infinity;
  const timeUp = () => Date.now() > endTime;
  const retrieve = setupExtractor(ctx.signal, { privateNetworkAllowed: Boolean(ctx.setting.dataPrivateNetworkAllowed), minDelayMs: ctx.setting.dataMinDelayMs ?? 1000, log: ctx.log, timeUp });
  retrieve.isCancelled = () => Boolean(ctx.signal?.aborted);
  // Search services of Settings › Web search, read at the start of the run (a key set after the job was added counts);
  // the requests go to the services themselves, the result pages through retrieve like every other page
  const serviceConfig = ctx.setting.webSearchServices?.() ?? {};
  const jobServices = g.engines.filter((m) => SERVICE_ENGINES.includes(m));
  const searcher = serviceSearcher({ config: serviceConfig, urls: ctx.setting.agentSearchApis ?? null, signal: ctx.signal, log: ctx.log, minDelayMs: ctx.setting.dataServiceDelayMs ?? 1000, limit: g.serviceLimit ?? 100 });
  let servicesTold = false;
  // engine -> { searches, results } in this run (per round in the search log, in total at the end)
  const engineCount = new Map();
  const countEngine = (engine, results, ...more) => {
    for (const m of [engineCount, ...more]) {
      const c = m.get(engine) ?? { searches: 0, results: 0 };
      c.searches++;
      c.results += results;
      m.set(engine, c);
    }
  };
  const engineText = (m) => [...m].map(([k, c]) => `${ENGINE_NAMES[k] ?? k} ${c.results} (${c.searches} search${c.searches === 1 ? '' : 'es'})`).join(', ') || '-';
  const browserExe = g.browser === 'closed' ? null : ctx.setting.browserPath !== undefined ? ctx.setting.browserPath : browserPath();
  if (g.browser !== 'closed' && !browserExe) ctx.log('Edge/Chrome not found: script-heavy pages are processed without a browser.');
  let browser = null;
  let screenCount = 0;
  const counter = { added: 0, repeat: 0, nearCopy: 0, short: 0, notArticle: 0, lowQuality: 0, lowAccuracy: 0, qualityRule: 0, offTopic: 0, language: 0, old: 0, blockedDomain: 0, noai: 0, unreadable: 0, robots: 0, rest: 0, browser: 0, wpApi: 0, commonCrawl: 0, commons: 0, onlyMedia: 0, modelLinks: 0, managerRounds: 0, siteSearch: 0, wikiNonContent: 0, unsuitable: 0, offTopicResults: 0, gnewsResolved: 0, gnewsUnresolved: 0, mediaDeferred: 0, prefiltered: 0, doc: 0, translation: 0, candidate: 0, image: 0, video: 0, audio: 0, downloadedMb: 0, mcp: 0, mcpCalls: 0 };
  const target = g.topic && g.target ? Math.max(0, g.target - previous.added) : Infinity;
  let done = target <= 0;
  const shouldStop = () => done || timeUp();
  const cancelControl = () => {
    if (ctx.signal?.aborted) throw new Error('Cancelled.');
  };
  const domainAllowed = (url) => {
    // Adult / gambling sites never enter the queue by any route
    if (isUnsuitable(url)) return false;
    let h;
    try {
      h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return false;
    }
    const matches = (a) => h === a || h.endsWith(`.${a}`);
    if (g.blockedDomains.some(matches)) return false;
    return !g.onlyDomains.length || g.onlyDomains.some(matches);
  };
  let completedSource = 0;
  let lastProgress = 0;
  const advance = (detail) => {
    const now = Date.now();
    if (now - lastProgress < 1500) return;
    lastProgress = now;
    const elapsedMin = (now - start) / 60000;
    const speed = elapsedMin > 0.5 ? counter.added / elapsedMin : 0;
    const remainingMin = Number.isFinite(target) && speed > 0 ? Math.ceil((target - counter.added) / speed) : null;
    const durationRemaining = g.durationMin ? Math.max(0, Math.ceil((endTime - now) / 60000)) : null;
    const time = [remainingMin !== null ? `~${remainingMin} min left` : speed ? `${speed.toFixed(1)} articles/min` : '', durationRemaining !== null ? `${durationRemaining} min of the time limit left` : ''].filter(Boolean).join(' · ');
    const percent = g.topic && g.target ? Math.min(99, (100 * (previous.added + counter.added)) / g.target) : g.topic || g.hopSites ? 0 : Math.min(99, (100 * completedSource) / Math.max(1, g.sources.length));
    ctx.progress({ percent: g.durationMin ? Math.max(percent, Math.min(99, (100 * (now - start)) / (g.durationMin * 60000))) : percent, stage: g.topic || siteQueue.size ? `Collecting ${previous.added + counter.added}${g.topic && g.target ? `/${g.target}` : ''}${g.hopSites ? ` · ${visitedSites.size} sites crawled, ${siteQueue.size} queued` : ''}` : `Source ${Math.min(g.sources.length, completedSource + 1)}/${g.sources.length}`, detail: `${counter.added} added${time ? ` · ${time}` : ''} · ${detail}`.slice(0, 180) });
  };

  let browserStartup = null;
  let browserPosition = Promise.resolve();
  async function getBrowser() {
    if (!browserExe) return null;
    if (browser?.isOpen) return browser;
    // One start: parallel workers each opened Edge and left the earlier ones without an owner
    browserStartup ??= (async () => {
      const t = new Browser({ path: browserExe, userAgent: USER_AGENT, log: ctx.log });
      try {
        await t.open();
        ctx.log('Browser opened (headless Edge/Chrome).');
        browser = t;
      } catch (e) {
        ctx.log(`Could not open the browser: ${e.message}`);
        await t.close().catch(() => {});
        browser = null;
      }
      return browser;
    })().finally(() => {
      browserStartup = null;
    });
    return browserStartup;
  }

  /** HTML processed with the browser (cookie banners, scrolling; in agent mode the model clicks). Step screenshots are job outputs. */
  /** Pages go through the browser in order (one tab). */
  function fetchWithBrowser(url) {
    const result = browserPosition.then(() => withBrowserFetchOrdered(url));
    browserPosition = result.catch(() => {});
    return result;
  }

  async function withBrowserFetchOrdered(url) {
    if (ctx.signal?.aborted) return null;
    const t = await getBrowser();
    if (!t) return null;
    mkdirSync(join(ctx.folder, 'screen'), { recursive: true });
    const imageName = (step) => {
      if (screenCount >= 24) return null;
      const fileName = `screen/${String(++screenCount).padStart(3, '0')}-step${step}.jpg`;
      return join(ctx.folder, fileName);
    };
    const decision = g.browser === 'agent' && useModel ? async ({ title, text: m, items, step }) => {
      const response = await askModel(ctx, AGENT_SYSTEM, `Step ${step}. Page: ${title}\n\nVisible text (beginning):\n${m.slice(0, 1500)}\n\nElements:\n${items.slice(0, 40).map((o) => `[${o.i}] ${o.tag}: ${o.text}`).join('\n')}`, 80);
      try {
        return JSON.parse(String(response).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
      } catch {
        return { action: 'done' };
      }
    } : null;
    try {
      const r = await processWithBrowser(t, url, { shotPath: (step) => imageName(step), decision, signal: ctx.signal, maxSteps: 4 });
      for (const d of readdirSync(join(ctx.folder, 'screen'))) if (!ctx.job.outputs?.some((c) => c.file === `screen/${d}`)) ctx.addOutput({ file: `screen/${d}`, type: 'image', preview: `screen/${d}`, name: `Browser: ${url.slice(0, 60)}` });
      if (r.steps.length) ctx.log(`Browser ${url.slice(0, 80)}: ${r.steps.join(', ')}`);
      counter.browser++;
      return r;
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log(`Browser ${url.slice(0, 80)}: ${String(e.message).slice(0, 100)}`);
      try {
        await browser?.close();
      } catch {}
      browser = null;
      return null;
    }
  }

  let diskFull = false;
  let lastDiskControl = 0;
  /**
   * Downloads a media file (mode 'download'): { file, temp }. A per-file limit, an optional total, disk protection;
   * temp = a rate limit / server or network error (not saved, retried later).
   */
  async function downloadMedia(url, type) {
    const none = { file: null, temp: false };
    if (g.media !== 'download' || (g.mediaTotalGb && counter.downloadedMb >= g.mediaTotalGb * 1024) || diskFull) return none;
    // Disk protection: media downloads stop when less than 10 GB is left free (so the system and the panel can still write)
    if (counter.downloadedMb - lastDiskControl >= 256 || !lastDiskControl) {
      lastDiskControl = counter.downloadedMb || 0.001;
      const free = diskStatus(folder).freeByte;
      // a setting, so the tests do not depend on the free space of the disk they run on (09.10.2026)
      const margin = ctx.setting.mediaDiskMarginGb != null ? ctx.setting.mediaDiskMarginGb * 2 ** 30 : MEDIA_DISK_MARGIN;
      if (free !== null && free < margin) {
        diskFull = true;
        ctx.log(`${(free / 2 ** 30).toFixed(1)} GB free left on disk: media download stopped (${margin / 2 ** 30} GB is kept as margin; articles continue to be collected).`);
        return none;
      }
    }
    let temp = null;
    try {
      // waiting: when the site is resting after a rate limit, wait as long as the server asked (at most 15 min)
      const directory = join(folder, 'media', MEDIA_FILES[type]);
      mkdirSync(directory, { recursive: true });
      const root = createHash('sha1').update(url).digest('hex').slice(0, 20);
      temp = join(directory, `.${root}.downloading`);
      // The body streams to disk (not kept in memory); named with its extension when done
      const r = await retrieve(url, { binary: true, toFile: temp, limit: g.mediaMaxMb * 2 ** 20, accept: '*/*', checkRobots: true, waiting: true });
      if (!r.fileSize || r.cut || r.code !== 200) {
        rmSync(temp, { force: true });
        return { file: null, temp: Boolean(r.rest || TEMP_ERROR.has(r.code)) };
      }
      const ext = (extname(new URL(url).pathname).toLowerCase().match(/^\.[a-z0-9]{2,5}$/)?.[0]) || ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'video/webm': '.webm' }[(r.type ?? '').split(';')[0]] ?? '.bin');
      const name = `${root}${ext}`;
      renameSync(temp, join(directory, name));
      counter.downloadedMb += r.fileSize / 2 ** 20;
      return { file: `media/${MEDIA_FILES[type]}/${name}`, temp: false };
    } catch (e) {
      if (temp) rmSync(temp, { force: true });
      if (ctx.signal?.aborted) throw e;
      return { file: null, temp: true }; // a network error
    }
  }

  /*
   * The media download pool: page processing does not wait for downloads (50 images on a page from one server took ~1 min in order).
   * At most 8 downloads at once; requests to one server stay in retrieve's per-site order (politeness). The record is written
   * when the download ends; one that failed with a temporary error is not saved (retried on the next run). Crawling waits above 400 queued.
   */
  const mediaPool = { pending: [], running: 0, whenFree: [] };
  const writeMediaRecord = (type, o) => appendFileSync(join(folder, `${MEDIA_FILES[type]}.jsonl`), `${JSON.stringify(o)}\n`);
  /**
   * Puts a download in the pool: first a "waiting" record (queued again at the start if the job stops), with the file when
   * downloaded, a "downloadFailed" record on a permanent error; stays waiting on a temporary error (retried later). again: the record is already waiting (start).
   */
  function queueMediaDownload(type, record, download, again = false) {
    const { waiting: _b, download: _i, file: _d, ...clean } = record;
    if (!again) writeMediaRecord(type, { ...clean, file: null, waiting: true, download });
    mediaPool.pending.push(async () => {
      const s = await downloadMedia(download, type);
      if (!s.file && s.temp) {
        counter.mediaDeferred++;
        return;
      }
      writeMediaRecord(type, s.file ? { ...clean, file: s.file } : { ...clean, file: null, downloadFailed: true });
      if (s.file) counter[type === 'images' ? 'image' : type === 'videos' ? 'video' : 'audio']++;
    });
    drainMediaPool();
  }
  function drainMediaPool() {
    while (mediaPool.running < 8 && mediaPool.pending.length && !ctx.signal?.aborted && !timeUp()) {
      const job = mediaPool.pending.shift();
      mediaPool.running++;
      job()
        .catch((e) => {
          if (!ctx.signal?.aborted) ctx.log(`Media download failed: ${String(e.message).slice(0, 120)}`);
        })
        .finally(() => {
          mediaPool.running--;
          drainMediaPool();
          if (!mediaPool.running) for (const ok of mediaPool.whenFree.splice(0)) ok();
        });
    }
    // Time up or cancelled: the pending ones are not started (they were not saved, so they are retried later)
    if ((ctx.signal?.aborted || timeUp()) && !mediaPool.running) {
      mediaPool.pending.length = 0;
      for (const ok of mediaPool.whenFree.splice(0)) ok();
    }
  }
  const mediaFinish = () => (mediaPool.running || mediaPool.pending.length ? new Promise((ok) => {
    mediaPool.whenFree.push(ok);
    drainMediaPool();
  }) : Promise.resolve());
  async function waitForMediaRoom() {
    while (mediaPool.pending.length > 400 && !ctx.signal?.aborted && !timeUp()) await new Promise((ok) => setTimeout(ok, 500));
  }

  /** Saves the images/videos/audio on the page (meta or download). */
  async function saveMedia(html, finalUrl, record, attachments = []) {
    if (g.media === 'none') return { image: 0, video: 0, audio: 0 };
    const count = { image: 0, video: 0, audio: 0 };
    const common = { page: finalUrl, pageTitle: record.title, language: record.language, category: record.category, collectedAt: new Date().toISOString() };
    // download: the address to download (otherwise a meta record only). Downloads go through the pool; the record is written when done (or fileless on a permanent error).
    const write = (type, o, download = null) => {
      // Adult / gambling CDN media embedded in another page are not taken either
      if (isUnsuitable(o.url) || isUnsuitable(common.page)) return void counter.unsuitable++;
      if (seenMedia.has(o.url)) return;
      seenMedia.add(o.url);
      count[type === 'images' ? 'image' : type === 'videos' ? 'video' : 'audio']++;
      const record_ = { ...o, ...common };
      if (g.media !== 'download' || !download) {
        writeMediaRecord(type, { ...record_, file: o.file ?? null });
        counter[type === 'images' ? 'image' : type === 'videos' ? 'video' : 'audio']++;
        return;
      }
      queueMediaDownload(type, record_, download);
    };
    const u = record.pageMeta ?? {};
    if (!u.noImageAi && html) for (const img of contentImages(html, finalUrl)) write('images', { ...img, text: img.caption || img.alt }, img.url);
    if (html) {
      for (const v of contentVideos(html, finalUrl)) write('videos', { ...v }, v.direct ? v.url : null);
      for (const s of contentAudio(html, finalUrl)) write('audio', { ...s }, s.url);
    }
    for (const e of attachments) {
      if (/^audio\//.test(e.type) || /\.(mp3|m4a|ogg|wav)(\?|$)/i.test(e.url)) write('audio', { url: e.url, title: record.title, description: record.summarySentence ?? record.metaDescription ?? '', durationSec: e.durationSec, byte: e.byte, sourceType: 'feed-attachment' }, e.url);
      else if (/^video\//.test(e.type) || /\.(mp4|webm|mov)(\?|$)/i.test(e.url)) write('videos', { url: e.url, title: record.title, description: record.summarySentence ?? '', durationSec: e.durationSec, sourceType: 'feed-attachment', direct: true }, e.url);
    }
    await waitForMediaRoom();
    return count;
  }

  /** Labels, filters and saves text content (HTML blocks or a document). Returns: whether it was added. */
  async function recordContent({ finalUrl, link, source, group, feedLink, pageMeta, h, html, wp, method, attachments = [], qualityFrontAccept = false }) {
    wasTried(link, finalUrl !== link ? finalUrl : null);
    let extracted = { article: true, title: pageMeta.title || h.title, language: null, topic: '', category: null, contentType: null, tags: [], summary: null, quality: null, accuracy: null, topicFit: null, blocks: wp || method.startsWith('doc') ? h.blocks : ruleExtract(h.blocks) };
    // A cheap check before the model (one channel, ~10-20 s a page): when even the page's whole text is short or holds
    // none of the topic's words the model is not called; the page is dropped by the rules (its media are still taken)
    const allText = h.blocks.map((b) => b.text).join('\n');
    const pageLanguage = detectLanguage(allText);
    const topicInLanguage = !group && g.languages.length <= 1 && (!pageLanguage || pageLanguage === (g.languages[0] ?? 'tr'));
    const prefiltered = !wp && !qualityFrontAccept && (allText.split(/\s+/).filter(Boolean).length < g.minWord || (g.topic && topicInLanguage && topicFitRule(g.topic, `${extracted.title}\n${allText}`) <= 1));
    if (prefiltered) counter.prefiltered++;
    if (useModel && h.blocks.length && !prefiltered) {
      try {
        const prompt = extractionPrompt(h.blocks, extracted.title, g.topic);
        const m = extractionResponse(await askModel(ctx, EXTRACTION_SYSTEM, prompt, 700), h.blocks);
        if (m) {
          // The prompt is cut at ~24 thousand characters: when the pick reaches the last visible block the rest count as content too
          const inPrompt = prompt.match(/^\[(\d+)\]/gm)?.length ?? h.blocks.length;
          const lastVisible = h.blocks.indexOf(m.blocks.at(-1));
          const blocks = wp || method.startsWith('doc') ? h.blocks : lastVisible >= 0 && lastVisible >= inPrompt - 2 && inPrompt < h.blocks.length ? [...m.blocks, ...h.blocks.slice(inPrompt)] : m.blocks;
          extracted = { ...m, title: m.title || extracted.title, blocks };
        }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`Model extraction failed (${String(e.message).slice(0, 120)}); rules used.`);
      }
    }
    let body = blockText(extracted.blocks);
    if (g.maskPersonalData) body = maskPersonalData(body);
    const words = body.split(/\s+/).filter(Boolean).length;
    const language = extracted.language ?? detectLanguage(body) ?? pageMeta.language ?? h.language ?? null;
    // Without the model's rating the focused rule: the topic words must be in the title + lead or spread through the text
    const fit = g.topic ? (extracted.topicFit ?? topicFitFocused(g.topic, extracted.title, body)) : null;
    const ruleProblem = g.qualityRules && !qualityFrontAccept && words >= 20 ? qualityRule(body) : null;
    const digest = textDigest(body);
    const fingerprint = simhash(body);
    const near = words >= 50 && fingerprints.some((x) => hammingDistance(x, fingerprint) <= 3);
    const dateText = pageMeta.dateText ?? h.dateText ?? null;
    let copy = false;
    if (!extracted.article) counter.notArticle++;
    else if (words < g.minWord) counter.short++;
    else if (ruleProblem) counter.qualityRule++;
    else if (extracted.quality !== null && extracted.quality < g.minQuality) counter.lowQuality++;
    else if (extracted.accuracy !== null && extracted.accuracy < g.minAccuracy) counter.lowAccuracy++;
    // The rule fit (not rated by the model) is coarse: the threshold is one step higher (default 3 -> 4: 60% of the topic's words; "Osmanlı" alone is not "Osmanlı minyatürleri")
    else if (fit !== null && fit < (extracted.topicFit === null || extracted.topicFit === undefined ? Math.min(5, g.minFit + 1) : g.minFit)) counter.offTopic++;
    else if (g.languages.length && language && !g.languages.includes(language) && !group) counter.language++;
    else if (g.oldestDate && dateText && String(dateText).slice(0, 10) < g.oldestDate) counter.old++;
    else if (seenText.has(digest)) {
      counter.repeat++;
      copy = true;
    } else if (near) {
      counter.nearCopy++;
      copy = true;
    }
    else {
      seenText.add(digest);
      fingerprints.push(fingerprint);
      const record = {
        url: finalUrl, canonical: pageMeta.canonical ?? null, feedLink: feedLink && feedLink !== finalUrl ? feedLink : null, source, group: group ?? (g.translationPairs && pageMeta.alternatives?.length ? pageMeta.canonical ?? finalUrl : null),
        title: extracted.title || pageMeta.title || h.title, metaTitle: pageMeta.metaTitle || null, metaDescription: pageMeta.metaDescription || null, language, topic: extracted.topic || null,
        category: extracted.category ?? findCategory(finalUrl, { section: pageMeta.section, html }), contentType: extracted.contentType ?? null, tags: extracted.tags?.length ? extracted.tags : pageMeta.tags ?? [], siteTags: pageMeta.tags ?? [], summarySentence: extracted.summary ?? null,
        quality: extracted.quality, accuracy: extracted.accuracy ?? null, topicFit: fit, author: pageMeta.author ?? null, dateText, modified: pageMeta.modified ?? null, section: pageMeta.section ?? null,
        words, extraction: useModel ? 'model' : 'rule', method, questionAnswers: html ? questionAnswers(html, h.blocks) : [], collectedAt: new Date().toISOString(), digest, simhash: fingerprint, text: body,
      };
      const media = await saveMedia(html, finalUrl, { ...record, pageMeta }, attachments);
      record.media = media;
      appendFileSync(file, `${JSON.stringify(record)}\n`);
      await addExternalSites(html, finalUrl, record.title);
      lastAccepted.push(String(record.title ?? '').slice(0, 100));
      if (lastAccepted.length > 15) lastAccepted.shift();
      counter.added++;
      total++;
      sourceCount.set(source, (sourceCount.get(source) ?? 0) + 1);
      if (group) counter.translation++;
      if (counter.added >= target) done = true;
      if (g.translationPairs && !group && pageMeta.alternatives?.length) {
        for (const a of pageMeta.alternatives.filter((x) => x.url !== finalUrl && x.language !== language && (!g.languages.length || g.languages.includes(x.language)) && !seenLink.has(x.url)).slice(0, 6)) {
          seenLink.add(a.url);
          try {
            await processPage(a.url, { source, group: record.group });
          } catch (e) {
            if (ctx.signal?.aborted) throw e;
            counter.unreadable++;
          }
        }
      }
      return true;
    }
    // "Take whatever it finds": the media of a page not taken as an article are taken too (galleries, video pages, short, off-topic, low
    // scores, another language); not for a copy (its media came from the original page)
    if (g.media !== 'none' && html && !copy) {
      const m = await saveMedia(html, finalUrl, { title: extracted.title || pageMeta.title || h.title, language, category: extracted.category ?? null, metaDescription: pageMeta.metaDescription ?? null, summarySentence: null, pageMeta }, attachments);
      if (m.image + m.video + m.audio) counter.onlyMedia++;
    }
    return false;
  }

  /** A PDF / Office document: download, extract the text, save. */
  async function processDocument(link, { source, readyData = null, type = '' }) {
    let data = readyData;
    let finalUrl = link;
    if (!data) {
      const r = await retrieve(link, { binary: true, limit: 40 * 2 ** 20, accept: 'application/pdf,application/*,*/*;q=0.5' });
      if (r.forbidden) return void counter.robots++;
      if (r.rest) return void counter.rest++;
      if (!r.data || r.cut) return void counter.unreadable++;
      data = r.data;
      finalUrl = r.url || link;
      type = r.type || type;
    }
    const b = documentText(data, { extension: extname(new URL(finalUrl).pathname).toLowerCase(), type });
    if (!b || !b.text || b.text.split(/\s+/).length < 30) return void counter.unreadable++;
    const blocks = b.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith('## ') ? { type: 'h2', text: p.slice(3) } : p.startsWith('- ') ? { type: 'li', text: p.slice(2) } : { type: 'p', text: p }));
    const title = blocks.find((x) => x.type === 'h2')?.text ?? decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ');
    counter.doc++;
    return recordContent({ finalUrl, link, source, group: null, feedLink: null, pageMeta: { title, alternatives: [], tags: [] }, h: { title, language: null, dateText: null, blocks }, html: null, wp: null, method: `doc:${b.extension.slice(1)}` });
  }

  /* One page: fetch -> metadata -> blocks -> (browser) -> label/filter/save; returns the inner links. */
  async function processPage(link, { source, group = null, feedLink = null, ready = null, wp = null, attachments = [], linkCollector = null }) {
    if (isWikiNonContent(link)) return void counter.wikiNonContent++;
    if (shouldStop()) return false;
    cancelControl();
    if (isUnsuitable(wp?.url ?? link)) return void counter.unsuitable++;
    if (!domainAllowed(wp?.url ?? link)) return void counter.blockedDomain++;
    if (!wp && !ready && (linkClassify(link, new URL(link).hostname) === 'doc')) return g.documents ? processDocument(link, { source }) : false;
    let html = wp ? null : ready?.text ?? null;
    let finalUrl = wp?.url ?? ready?.url ?? link;
    let method = wp ? 'wp-api' : ready?.method ?? 'html';
    if (!wp && !html) {
      let page;
      try {
        page = await retrieve(link);
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        counter.unreadable++;
        return false;
      }
      if (page.forbidden) return void counter.robots++;
      if (page.rest) return void counter.rest++;
      if (page.code === 415 && g.documents && /pdf|officedocument/.test(page.type ?? '')) return processDocument(link, { source });
      if ((page.code === 403 && page.guarded) || (page.code === 429 && browserExe)) {
        const t = await fetchWithBrowser(link); // bot protection: try a real browser
        if (!t) return void counter.unreadable++;
        html = t.html;
        finalUrl = t.url || link;
        method = 'browser';
      } else if (!page.text || documentType(page.text) !== 'html') return void counter.unreadable++;
      else {
        html = page.text;
        finalUrl = page.url || link;
      }
    }
    if (seenLink.has(finalUrl) && finalUrl !== link) return void counter.repeat++;
    seenLink.add(finalUrl);
    let pageMeta = wp ? { title: wp.title, metaTitle: wp.metaTitle, metaDescription: wp.metaDescription || wp.summary, language: wp.language, dateText: wp.dateText, modified: wp.modified, author: wp.author, tags: wp.tags, section: wp.section, canonical: wp.url, alternatives: [], scriptHeavy: false } : pageMetadata(html, finalUrl);
    if (pageMeta.noAi) return void counter.noai++;
    let h = htmlBlocks(wp ? `<html><body><article>${wp.contentHtml}</article></body></html>` : html);
    const wordRaw = h.blocks.reduce((t, b) => t + b.text.split(' ').length, 0);
    if (!wp && browserExe && method !== 'browser' && (g.browser === 'always' || g.browser === 'agent' || (pageMeta.scriptHeavy && wordRaw < 150) || (wordRaw < 60 && html.length > 30000))) {
      const t = await fetchWithBrowser(finalUrl);
      if (t?.html) {
        const h2 = htmlBlocks(t.html);
        if (h2.blocks.length > h.blocks.length) {
          h = h2;
          html = t.html;
          const u2 = pageMetadata(t.html, finalUrl);
          pageMeta = { ...u2, alternatives: pageMeta.alternatives.length ? pageMeta.alternatives : u2.alternatives };
          method = 'browser';
        }
      }
    }
    if (linkCollector && html) linkCollector(pageLinks(html, finalUrl), pageType(html, h.blocks));
    if (pageMeta.canonical && pageMeta.canonical !== finalUrl) {
      if (seenLink.has(pageMeta.canonical)) return void counter.repeat++;
      seenLink.add(pageMeta.canonical);
    }
    return recordContent({ finalUrl, link, source, group, feedLink, pageMeta, h, html, wp, method, attachments });
  }

  /**
   * In-site search (a site found in topic mode): the search engine is asked "site:<site> <topic>"; the site's pages on the
   * topic are processed first. On a site of thousands of articles the home page's links are off topic: on TDV Islam Ansiklopedisi
   * 91 pages were crawled without ever reaching the "Minyatur" article (05.10.2026). Once per site; the first engine with results.
   */
  // The in-site search word: the topic's most distinctive (longest) word with the Turkish plural suffix dropped. Bing gets "site:"
  // right with the short stem ("site:islamansiklopedisi.org.tr minyatür" -> /minyatur); "Osmanlı minyatürleri" drifted to general
  // Ottoman results.
  const siteSearchWord = String(g.topic ?? '').split(/\s+/).map((k) => k.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/(lar|ler)(ı|i|u|ü|ın|in|un|ün|da|de|dan|den|a|e)?$/u, '')).filter((k) => k.length >= 4).sort((a, b) => b.length - a.length)[0];
  // Huge general sites (Wikipedia, archives...): only linked / found pages are taken; tests add the local site
  const wideSite = (host) => WIDE_SITE.test(host) || (ctx.setting.dataWideSites ?? []).includes(host);
  // A Google News link reaches the publisher through JavaScript: it is resolved to the publisher's address first (dataGnewsAddress in tests)
  const gnewsBase = String(ctx.setting.dataGnewsAddress ?? 'https://news.google.com').replace(/\/$/, '');
  const gnewsHost = new URL(gnewsBase).hostname;
  async function parseGnews(url) {
    const id = gnewsId(url, gnewsHost);
    if (!id) return url;
    try {
      const s = await retrieve(`${gnewsBase}/rss/articles/${id}`, { checkRobots: false });
      const signature = s.text ? gnewsSignature(s.text) : null;
      if (!signature) return null;
      const r = await retrieve(`${gnewsBase}/_/DotsSplashUi/data/batchexecute`, { checkRobots: false, method: 'POST', requestBody: gnewsResolveBody(id, signature), accept: '*/*', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } });
      return r.text ? gnewsResolveResponse(r.text) : null;
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      return null;
    }
  }
  const siteSearchDone = new Set();
  async function searchSiteInner(host) {
    const root = host.replace(/^www\./, '');
    if (siteSearchDone.has(root) || !g.topic) return [];
    siteSearchDone.add(root);
    const template = ctx.setting.dataSearchTemplate;
    // DuckDuckGo blocks bot queries (202, empty), Google News and Wikipedia do not search within a site: the first general engine
    const engine = template && g.engines.some((m) => SEARCH_ENGINES.includes(m)) ? 'test' : g.engines.includes('bing') ? 'bing' : g.engines.includes('ddg') ? 'ddg' : null;
    const services = jobServices.filter((m) => searcher.usable(m));
    const language = g.languages[0] ?? 'tr';
    const found = [];
    const add = (list) => {
      for (const a of list) {
        let h;
        try {
          h = new URL(a.url).hostname.replace(/^www\./, '');
        } catch {
          continue;
        }
        if ((h === root || h.endsWith(`.${root}`)) && !seenLink.has(a.url) && domainAllowed(a.url) && !found.includes(a.url)) found.push(a.url);
      }
    };
    for (const expression of [...new Set([siteSearchWord, g.topic].filter(Boolean))]) {
      if (shouldStop() || found.length) break;
      // The search services first ("site:" / Tavily's domain filter); at most half of a service's searches go here
      for (const service of services) {
        const list = await searcher.search(service, expression, { language, site: root, count: 20, share: 0.5 });
        if (list === null) continue;
        countEngine(service, list.length);
        add(list);
        if (found.length) break;
      }
      if (found.length || !engine) continue;
      const query = `site:${root} ${expression}`;
      try {
        const r = await retrieve(template ? template.replace('{q}', encodeURIComponent(query)) : searchUrl(engine, query, language), { checkRobots: false, accept: 'application/rss+xml,application/xml,text/html;q=0.9,*/*;q=0.8' });
        const list = r.text ? searchResults(r.text, engine) : [];
        countEngine(engine, list.length);
        add(list);
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
      }
    }
    return found.slice(0, 20);
  }

  // The topic's word stems (6 letters, Turkish letters simplified): inner links are ordered by the topic
  const plainText = (s) => String(s ?? '').toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
  const TOPIC_FILLER = new Set(['ile', 'icin', 'gibi', 'olan', 'nasil', 'nedir', 'and', 'the', 'for', 'with', 'how', 'what']);
  const topicRoots = g.topic ? [...new Set(plainText(g.topic).split(/[^\p{L}\p{N}]+/u).filter((k) => k.length > 2 && !TOPIC_FILLER.has(k)).map((k) => k.slice(0, 6)))] : [];
  const decoded = (u) => {
    try {
      return decodeURIComponent(u);
    } catch {
      return u;
    }
  };
  const topicScore = (l) => topicRoots.filter((k) => plainText(`${decoded(l.url)} ${l.text ?? ''}`).includes(k)).length;
  // In topic mode a site is dropped when this many pages inside it give no article (the in-site search found nothing either: it has no such topic)
  const UNPRODUCTIVE_PAGES = 60;

  /* In-site crawling: classify the inner links; text -> process, list -> follow up to the depth, doc -> process. */
  async function walkSite(startLinks, host, source, { firstPageType = null } = {}) {
    const visit = new Set();
    const queue = [];
    let fetched = 0;
    let taken = 0;
    let unproductive = false;
    const accept = (l, depth, priority) => {
      if (visit.has(l.url) || seenLink.has(l.url) || !domainAllowed(l.url)) return;
      if (l.cls === 'static' || l.cls === 'media' || l.cls === 'external') return;
      if (l.cls === 'doc' && !g.documents) return;
      if (l.cls === 'list' && depth > g.depth) return;
      visit.add(l.url);
      // In topic mode a link with a topic word in its address or text goes to the front, the others to the back
      const first = topicRoots.length ? topicScore(l) > 0 : priority;
      (first ? queue.unshift : queue.push).call(queue, { ...l, depth });
    };
    const collect = (depth) => (links, type) => {
      for (const l of links) accept(l, l.cls === 'list' ? depth + 1 : depth, l.cls === 'text' || l.cls === 'doc');
      void type;
    };
    for (const l of startLinks) accept(l, l.cls === 'list' ? 1 : 0, l.cls !== 'list');
    void firstPageType;
    while (queue.length && fetched < g.sitePerPage && taken + (sourceCount.get(source) ?? 0) < g.max && !shouldStop()) {
      cancelControl();
      const o = queue.shift();
      fetched++;
      try {
        if (o.cls === 'doc') {
          if (await processDocument(o.url, { source })) taken++;
          continue;
        }
        if (o.cls === 'list') {
          const r = await retrieve(o.url);
          if (r.text && documentType(r.text) === 'html') {
            const bl = htmlBlocks(r.text);
            if (pageType(r.text, bl.blocks) === 'text' && !seenLink.has(r.url || o.url)) {
              seenLink.add(o.url);
              if (await processPage(o.url, { source, ready: r, linkCollector: collect(o.depth) })) taken++;
            } else collect(o.depth)(pageLinks(r.text, r.url || o.url), 'list');
          }
          continue;
        }
        seenLink.add(o.url);
        if (await processPage(o.url, { source, linkCollector: o.depth < g.depth ? collect(o.depth) : null })) taken++;
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        counter.unreadable++;
      }
      advance(`${host} · crawl ${fetched} pages, ${taken} articles`);
      if (topicRoots.length && !taken && fetched >= UNPRODUCTIVE_PAGES) {
        unproductive = true;
        break;
      }
    }
    return { taken, fetched, remainingQueue: queue.length, unproductive };
  }

  /* The WordPress API: posts page by page (content, Yoast meta, category, tags, author in one request). */
  async function processWpSource(apiRoot, source) {
    let taken = 0;
    for (let page = 1; page <= 200 && !shouldStop(); page++) {
      let r;
      try {
        r = await retrieve(wpPostsUrl(apiRoot, page, Math.min(50, g.max)), { checkRobots: false, accept: 'application/json' });
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        break;
      }
      if (!r.text || r.code !== 200) break;
      let json;
      try {
        json = JSON.parse(r.text);
      } catch {
        break;
      }
      const texts = wpPosts(json);
      if (!texts.length) break;
      for (const y of texts) {
        if (taken >= g.max || shouldStop()) return taken;
        if (g.onlyNew && oldSummary.lastUpdate && y.dateText && y.dateText < oldSummary.lastUpdate) return taken;
        if (seenLink.has(y.url)) {
          counter.repeat++;
          continue;
        }
        counter.candidate++;
        if (await processPage(y.url, { source, wp: y })) {
          taken++;
          counter.wpApi++;
        }
        advance(`${taken} added · ${y.url}`);
      }
      if (texts.length < Math.min(50, g.max)) break;
    }
    return taken;
  }

  /* Common Crawl: the site's pages from the CDX index, HTML from the WARC record (no request to the live site). */
  async function processCcSource(host, source) {
    if (!ccDirectory.id || Date.now() - ccDirectory.time > 86400000) {
      const r = await retrieve('https://index.commoncrawl.org/collinfo.json', { checkRobots: false, accept: 'application/json' });
      ccDirectory = { id: r.text ? JSON.parse(r.text)[0]?.id ?? null : null, time: Date.now() };
    }
    if (!ccDirectory.id) return void ctx.log('Could not fetch the Common Crawl index.');
    const r = await retrieve(`https://index.commoncrawl.org/${ccDirectory.id}-index?url=${encodeURIComponent(`${host}/*`)}&output=json&filter==status:200&filter=~mime:text/html&limit=${Math.min(2000, g.max * 4)}`, { checkRobots: false, accept: 'application/json,text/plain', limit: 20 * 2 ** 20, timeMs: 60000 });
    if (!r.text) return void ctx.log(`Common Crawl: no index response for ${host} (HTTP ${r.code ?? '?'}).`);
    const records = ccRecords(r.text).filter((k) => linkClassify(k.url, host) === 'text' && !seenLink.has(k.url) && domainAllowed(k.url));
    ctx.log(`Common Crawl (${ccDirectory.id}): ${records.length} candidate pages for ${host}.`);
    let taken = 0;
    for (const k of records) {
      if (taken >= g.max || shouldStop()) break;
      counter.candidate++;
      try {
        const w = await retrieve(`https://data.commoncrawl.org/${k.file}`, { checkRobots: false, binary: true, limit: 8 * 2 ** 20, accept: '*/*', headers: { Range: `bytes=${k.start}-${k.start + k.len - 1}` } });
        if (!w.data) continue;
        const unzipped = gunzipSync(w.data);
        const body = warcBody(unzipped);
        if (!body?.body) continue;
        seenLink.add(k.url);
        if (await processPage(k.url, { source, ready: { text: body.body, url: k.url, method: 'common-crawl' } })) {
          taken++;
          counter.commonCrawl++;
        }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        counter.unreadable++;
      }
      advance(`Common Crawl ${host} · ${taken} articles`);
    }
    return taken;
  }

  /**
   * Wikimedia Commons (commons:Category:Name or commons:search): files from the API with their licence and description. No text
   * filter (a file page is short): images as the 1280 px scaled version, videos as the derivative nearest 480p, audio as the original
   * (an mp3/ogg derivative when large). In a category the subcategories are followed up to the depth. At most maxFiles files per source.
   */
  const API = ctx.setting.commonsApi ?? 'https://commons.wikimedia.org/w/api.php'; // a fake API in tests
  // The Wikimedia API rule: a User-Agent that introduces the tool; the API path is closed to crawlers (robots), open to clients
  const agent = { 'User-Agent': 'NedeseStudioData/2.0 (https://github.com/mustafa-ozen95/nedese-studio)' };

  /**
   * Commons in topic mode: Commons text is mostly English. The English queries are cleared of topic filler words;
   * for each phrase first at most 3 categories whose name holds the phrase's word (with their subcategories), then
   * a small file search. Runs alongside the web crawl (different servers).
   */
  async function commonsTopic(queries) {
    const FILLER = new Set('rehber rehberi nedir nasıl yapılır ipuçları inceleme incelemesi karşılaştırma ünlü en iyi hakkında tarihçesi örnekleri guide guides how to tips review reviews vs best famous what is top the a an of and in for examples history overview introduction'.split(' '));
    const clean = (s) => String(s ?? '').split(/\s+/).filter((k) => k && !FILLER.has(k.toLocaleLowerCase('tr'))).join(' ').trim();
    // The topic's core: the words (6-letter stems) found in at least half (at least two) of the English queries; without English
    // queries the topic's words. A category and a phrase must hold ALL of the core: a side-angle query such as "Minyatur ve Bati resmi"
    // brought the European portrait miniatures category (300 unrelated images).
    const words = (s) => [...new Set(String(s ?? '').toLocaleLowerCase('en').split(/[^\p{L}\p{N}]+/u).filter((k) => k.length >= 4 && !FILLER.has(k)).map((k) => k.slice(0, 6)))];
    const english = queries.filter((s) => s.language === 'en').map((s) => clean(s.query)).filter((s) => s.length >= 3);
    const count = new Map();
    for (const s of english) for (const k of words(s)) count.set(k, (count.get(k) ?? 0) + 1);
    let core = [...count].filter(([, n]) => n >= Math.max(2, Math.ceil(english.length / 2))).map(([k]) => k);
    if (!core.length) core = words(clean(g.topic));
    const hasCore = (t) => {
      const s = String(t).toLocaleLowerCase('en');
      return core.length > 0 && core.every((k) => s.includes(k));
    };
    const expressions = [...new Set([...english.filter(hasCore), clean(g.topic)].filter((s) => s.length >= 3))].slice(0, 3);
    const limit = g.target ? Math.max(g.max, g.target) : 300;
    ctx.log(`Media: also searching Wikimedia Commons (${expressions.map((s) => `"${s}"`).join(', ')}; topic core: ${core.join(', ') || '-'}).`);
    for (const expression of expressions) {
      if (shouldStop()) break;
      try {
        const r = await retrieve(`${API}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', list: 'search', srsearch: expression, srnamespace: '14', srlimit: '10' })}`, { checkRobots: false, accept: 'application/json', headers: agent });
        const categories = (r.text ? JSON.parse(r.text).query?.search ?? [] : []).map((s) => s.title).filter(hasCore).slice(0, 3);
        if (categories.length) ctx.log(`Commons "${expression}": categories ${categories.join(', ')}`);
        for (const k of categories) {
          if (shouldStop()) break;
          await processCommonsSource(k, `commons:${k}`, limit);
        }
        // A file search only when the phrase found a category on Commons (otherwise full text search brings unrelated files)
        if (categories.length && !shouldStop()) await processCommonsSource(expression, `commons:${expression}`, 50);
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`Commons "${expression}": ${String(e.message).slice(0, 120)}`);
      }
    }
  }

  /** For a Commons record: { file, temp } (media not 'download': a fileless record). */
  async function downloadStatus(address, type) {
    if (g.media !== 'download') return { file: null, temp: false };
    return downloadMedia(address, type);
  }

  async function processCommonsSource(target, source, maxFiles = g.max) {
    // The Wikimedia API rule: a User-Agent that introduces the tool; the API path is closed to crawlers (robots), open to clients
    const category = /^category:/i.test(target) ? `Category:${target.replace(/^category:/i, '').trim()}` : null;
    const language = g.languages[0] ?? 'tr';
    const common = {
      action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo|videoinfo',
      iiprop: 'url|size|mime|mediatype|extmetadata', iiurlwidth: '1280', iiextmetadatalanguage: language,
      iiextmetadatafilter: 'ImageDescription|ObjectName|LicenseShortName|Artist|DateTimeOriginal', viprop: 'derivatives',
    };
    const query = async (q) => {
      const r = await retrieve(`${API}?${new URLSearchParams({ ...common, ...q })}`, { checkRobots: false, accept: 'application/json', headers: agent, timeMs: 60000 });
      if (!r.text) throw new Error(`Commons API did not respond (HTTP ${r.code ?? '?'})`);
      return JSON.parse(r.text);
    };
    // Hidden elements (Wikidata "label QS:" lines, language labels) are dropped; no licence sentence or camera file name stays in a caption
    const clean = visibleText;
    let taken = 0;
    let viewed = 0;
    const queue = category ? [{ title: category, depth: 0 }] : [null];
    const seenCategory = new Set();
    while (queue.length && taken < maxFiles && !shouldStop()) {
      const k = queue.shift();
      if (k) {
        if (seenCategory.has(k.title)) continue;
        seenCategory.add(k.title);
      }
      let proceed = {};
      do {
        cancelControl();
        const j = await query(k ? { generator: 'categorymembers', gcmtitle: k.title, gcmtype: 'file', gcmlimit: '50', ...proceed } : { generator: 'search', gsrsearch: target, gsrnamespace: '6', gsrlimit: '50', ...proceed });
        proceed = j.continue ?? null;
        for (const s of j.query?.pages ?? []) {
          if (taken >= maxFiles || shouldStop()) break;
          const ii = s.imageinfo?.[0];
          if (!ii) continue;
          viewed++;
          const page = ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(s.title)}`;
          if (seenMedia.has(page)) continue;
          const m = ii.extmetadata ?? {};
          const title = cleanCaption(clean(m.ObjectName?.value)) || cleanCaption(s.title.replace(/^File:/, '').replace(/\.[^.]+$/, ''));
          const description = cleanCaption(clean(m.ImageDescription?.value)).slice(0, 1000);
          const extra = { page, pageTitle: s.title, license: clean(m.LicenseShortName?.value) || null, author: clean(m.Artist?.value).slice(0, 200) || null, dateText: clean(m.DateTimeOriginal?.value).slice(0, 40) || null, source, sourceType: 'commons', language, collectedAt: new Date().toISOString() };
          let type;
          let o;
          if (ii.mediatype === 'BITMAP' && /^image\/(jpeg|png|webp|tiff)$/.test(ii.mime)) {
            type = 'images';
            const address = ii.thumburl ?? ii.url;
            o = { url: page, alt: title, caption: description, text: mergeCaptions(title, description), width: ii.thumbwidth ?? ii.width, height: ii.thumbheight ?? ii.height, ...(await downloadStatus(address, 'images')) };
          } else if (ii.mediatype === 'VIDEO') {
            type = 'videos';
            // The derivative: the webm/mp4 nearest 480p (the original file is often very large)
            const derivatives = (s.videoinfo?.[0]?.derivatives ?? []).filter((d) => /^video\/(webm|mp4)/.test(d.type ?? '') && d.height);
            const selected = derivatives.sort((a, b) => Math.abs(a.height - 480) - Math.abs(b.height - 480))[0];
            const address = selected?.src ?? ii.url;
            o = { url: page, title, description, durationSec: ii.duration ? Math.round(ii.duration) : null, width: selected?.width ?? ii.width, height: selected?.height ?? ii.height, direct: true, ...(await downloadStatus(address, 'videos')) };
          } else if (ii.mediatype === 'AUDIO') {
            type = 'audio';
            // The original audio (ogg/mp3); an mp3/ogg derivative for a large file such as FLAC/WAV
            const compressed = /^(audio\/(mpeg|ogg)|application\/ogg)$/.test(ii.mime) && ii.size <= g.mediaMaxMb * 2 ** 20;
            const derivative = (s.videoinfo?.[0]?.derivatives ?? []).find((d) => /^audio\/(mpeg|ogg)/.test(d.type ?? ''));
            const address = compressed || !derivative ? ii.url : derivative.src;
            o = { url: page, title, description, durationSec: ii.duration ? Math.round(ii.duration) : null, ...(await downloadStatus(address, 'audio')) };
          } else continue;
          // Not saved when it was not downloaded for a rate limit / network error: retried on the next run (no permanent loss)
          if (o.temp) {
            counter.mediaDeferred++;
            continue;
          }
          delete o.temp;
          seenMedia.add(page);
          appendFileSync(join(folder, `${MEDIA_FILES[type]}.jsonl`), `${JSON.stringify({ ...o, ...extra })}\n`);
          counter[type === 'images' ? 'image' : type === 'videos' ? 'video' : 'audio']++;
          counter.commons++;
          taken++;
          advance(`Commons · ${taken} files · ${title.slice(0, 60)}`);
        }
      } while (proceed && taken < maxFiles && !shouldStop());
      // Subcategories (up to the depth)
      if (k && k.depth < g.depth && taken < maxFiles && !shouldStop()) {
        let subContinue = {};
        do {
          const r = await retrieve(`${API}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', list: 'categorymembers', cmtitle: k.title, cmtype: 'subcat', cmlimit: '100', ...subContinue })}`, { checkRobots: false, accept: 'application/json', headers: agent });
          const j = r.text ? JSON.parse(r.text) : {};
          for (const c of j.query?.categorymembers ?? []) queue.push({ title: c.title, depth: k.depth + 1 });
          subContinue = j.continue ?? null;
        } while (subContinue);
      }
    }
    ctx.log(`${source}: ${taken} files from Commons (${viewed} files examined${category ? `, ${seenCategory.size} categories` : ''}).`);
    return taken;
  }

  /* One source: expand (feed / OPML / sitemap / page / WP / cc:) and process the pages; crawl the site when needed. */
  async function processSource(source, discovered = false, extraLinks = []) {
    const previousTaken = sourceCount.get(source) ?? 0;
    if (/^cc:/i.test(source)) return void (await processCcSource(source.slice(3), source));
    if (/^commons:/i.test(source)) return void (await processCommonsSource(source.slice(8).trim(), source));
    let gen;
    try {
      gen = await expandSource(retrieve, source, g, ctx.log, oldSummary.lastUpdate);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log(`${source}: ${String(e.message).slice(0, 140)}`);
      counter.unreadable++;
      return;
    }
    let taken = 0;
    if (gen.subSources?.length) {
      ctx.log(`${source}: OPML, ${gen.subSources.length} feeds.`);
      for (const sub of gen.subSources) {
        if (shouldStop()) break;
        await processSource(sub);
      }
      return;
    }
    const host = new URL(source).hostname;
    if (gen.wpApi) {
      ctx.log(`${source}: using the WordPress API (${gen.wpApi})`);
      taken = await processWpSource(gen.wpApi, source);
      ctx.log(`${source}: ${taken} articles added (WordPress API).`);
    } else {
      const list = gen.links.filter((l) => !seenLink.has(l.link));
      // A site found in topic mode: first the in-site search (the topic's pages on the site), then the site's own entry points
      if (discovered && g.topic && !shouldStop()) {
        const found = (await searchSiteInner(host)).filter((u) => !list.some((l) => l.link === u));
        if (found.length) {
          counter.siteSearch += found.length;
          ctx.log(`${host}: site search found ${found.length} topic pages.`);
          list.unshift(...found.map((link) => ({ link })));
        }
      }
      counter.candidate += list.length;
      const innerLinks = [];
      let tried = 0;
      for (const o of list) {
        if (taken + previousTaken >= g.max || shouldStop()) break;
        // A found (hopped-to) site that does not fit the topic is dropped early: no acceptance in the first 8 candidates
        if (discovered && g.topic && ++tried > 8 && !taken) break;
        cancelControl();
        seenLink.add(o.link);
        try {
          if (await processPage(o.link, { source, feedLink: o.link, attachments: o.attachments ?? [], ready: gen.ready && gen.links.length === 1 && [gen.ready.url, source].includes(o.link) ? gen.ready : null, linkCollector: g.depth > 0 ? (l) => innerLinks.push(...l) : null })) taken++;
        } catch (e) {
          if (ctx.signal?.aborted) throw e;
          counter.unreadable++;
        }
        advance(`${taken} added · ${o.link}`);
      }
      ctx.log(`${source}: ${taken} articles added (${list.length} candidates, ${gen.discovery ?? 'list'}${discovered ? ', discovered site' : ''}).`);
      // In-site crawling: the inner links are followed when the source is a page or the feed/sitemap fell short
      if (g.depth > 0 && !shouldStop() && taken + previousTaken < g.max && (gen.discovery === 'page' || innerLinks.length || extraLinks.length) && !(discovered && g.topic && tried >= 8 && !taken && !extraLinks.length)) {
        // First the links of topic pages processed before (site to site), then the site's own entry points
        const start_ = [...extraLinks, ...(innerLinks.length ? innerLinks : gen.ready ? pageLinks(gen.ready.text, gen.ready.url || source) : [])];
        if (start_.length) {
          const s = await walkSite(start_, host, source);
          taken += s.taken;
          ctx.log(`${host}: site crawl ${s.fetched} pages, ${s.taken} articles added${s.unproductive ? ` (no on-topic article in ${UNPRODUCTIVE_PAGES} pages, site dropped; ${s.remainingQueue} links left)` : s.remainingQueue ? ` (${s.remainingQueue} more links remained)` : ''}.`);
        }
      }
    }
    if (g.commonCrawl && !shouldStop() && taken + previousTaken < g.max) {
      try {
        await processCcSource(host, source);
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`Common Crawl ${host}: ${String(e.message).slice(0, 100)}`);
      }
    }
  }

  /** Site to site: the queued sites are crawled in parallel; the manager steers at intervals. */
  async function walkSites() {
    ctx.log(`Site to site: ${siteQueue.size} sites queued${visitedSites.size ? ` (${visitedSites.size} sites crawled before)` : ''}.`);
    await Promise.all(Array.from({ length: g.parallel }, async () => {
      for (;;) {
        if (shouldStop()) break;
        if (!siteQueue.size) {
          if (!walking.size) break;
          await new Promise((ok) => setTimeout(ok, 2000));
          continue;
        }
        // Manager: at intervals it looks at the summary and changes the order and direction
        if (managerOpen() && !managed && Date.now() - lastManaged > (ctx.setting.dataManagementMs ?? MANAGER_INTERVAL_MS)) {
          const fresh = await manage('regular');
          if ((fresh?.length || guidedSources.length) && !shouldStop()) await topicCollect(fresh ?? []);
          continue;
        }
        // The most linked site first (closest to the topic)
        let best = null;
        for (const [h, v] of siteQueue) if (!best || v[0] > best[1]) best = [h, v[0], v[1], v[2] ?? []];
        siteQueue.delete(best[0]);
        walking.set(best[0], [best[1], best[2], best[3]]);
        saveQueue();
        try {
          // First the topic pages the in-site search found (the linked page is often the home page: off topic), then the
          // pages the links point to (from pages that fit the topic); with no acceptance in the first 3 the site is dropped
          let pages = best[3];
          if (g.topic && !shouldStop()) {
            const found = (await searchSiteInner(best[0])).filter((u) => !pages.includes(u));
            if (found.length) {
              counter.siteSearch += found.length;
              ctx.log(`${best[0]}: site search found ${found.length} topic pages.`);
              pages = [...found, ...pages];
            }
          }
          let accept = 0;
          let trial = 0;
          // The inner links of the processed pages (a topic page's "related articles"): the in-site crawl starts from them
          const innerLinks = [];
          for (const u of pages) {
            if (shouldStop() || (trial >= 3 && !accept)) break;
            if (seenLink.has(u)) continue;
            seenLink.add(u);
            trial++;
            try {
              if (await processPage(u, { source: `hop:${best[0]}`, linkCollector: g.depth > 0 ? (l) => innerLinks.push(...l) : null })) accept++;
            } catch (e) {
              if (ctx.signal?.aborted) throw e;
              counter.unreadable++;
            }
            advance(`${best[0]} · ${accept}/${trial} accepted (site to site)`);
          }
          // Wide discovery (feeds, sitemap, in-site crawl): when a linked page fit the topic or there is no page to try.
          // On huge general sites (Wikipedia, Commons, archives) only the linked pages: the home page is off topic
          if (!shouldStop() && (accept || !trial) && !wideSite(best[0])) await processSource(best[2], true, innerLinks);
          siteResult.set(best[0], [accept + (sourceCount.get(best[2]) ?? 0), trial]);
        } catch (e) {
          if (ctx.signal?.aborted) throw e;
          ctx.log(`${best[0]}: ${String(e.message).slice(0, 120)}`);
        }
        // When a pause/cancel left it half done the site stays queued (re-crawled on resume; what was taken is not taken again)
        if (ctx.signal?.aborted || timeUp()) break;
        walking.delete(best[0]);
        visitedSites.add(best[0]);
        saveQueue();
      }
    }));
  }

  // On when the field is missing: jobs created before the manager existed are managed too (on resume)
  const managerOpen = () => Boolean(g.manager !== false && useModel && g.topic);
  let managed = false;
  // When a full queue came from an earlier run (it may have filled under older rules) the manager prunes in the first round at once
  let lastManaged = siteQueue.size > 10 ? 0 : Date.now();
  /**
   * Manager: the model gets the crawl's summary (what was collected, productive / empty sites, the queue, the queries used); the model
   * names the sites to prioritize and release and new queries, the code applies them. Returns: the new queries (null when none).
   */
  async function manage(reason) {
    if (!managerOpen() || managed) return null;
    managed = true;
    try {
      const productive = [...siteResult].filter(([, [accepted]]) => accepted > 0).sort((a, b) => b[1][0] - a[1][0]).slice(0, 12);
      const empty = [...siteResult].filter(([, [accepted]]) => !accepted).slice(-12);
      const queued = [...siteQueue].sort((a, b) => b[1][0] - a[1][0]).slice(0, 25);
      const summary = [
        `Topic: ${g.topic}`,
        `Elapsed: ${Math.round((Date.now() - start) / 60000)} min; reason: ${reason}`,
        `Collected: ${total} articles, ${counter.image} images, ${counter.video} videos, ${counter.audio} audio`,
        `Last accepted articles: ${lastAccepted.slice(-10).join(' | ') || '-'}`,
        `Productive sites (accepted/tried): ${productive.map(([h, [accepted, tried]]) => `${h} ${accepted}/${tried}`).join(', ') || '-'}`,
        `Empty sites: ${empty.map(([h, [, tried]]) => `${h} 0/${tried}`).join(', ') || '-'}`,
        `Queued sites (score, sample link):\n${queued.map(([h, [p, , l]]) => `${h} (${p}${l?.[0] ? `, ${l[0].slice(0, 90)}` : ''})`).join('\n') || '-'}`,
        `Queries used: ${[...usedQueries].slice(-40).join(' | ')}`,
        `Languages: ${g.languages.join(', ') || 'all'}`,
        guidance ? `\n${guidancePart(guidance)}` : null,
      ].filter((s) => s !== null).join('\n');
      const answer = String(await askModel(ctx, MANAGER_SYSTEM, summary, 500));
      const j = JSON.parse(answer.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
      const name = (h) => String(h ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      const prioritized = (Array.isArray(j.prioritized) ? j.prioritized : []).map(name).filter((h) => siteQueue.has(h)).slice(0, 10);
      for (const h of prioritized) siteQueue.get(h)[0] += 10;
      const release = (Array.isArray(j.release) ? j.release : []).map(name).filter((h) => siteQueue.has(h)).slice(0, 40);
      for (const h of release) {
        siteQueue.delete(h);
        visitedSites.add(h);
      }
      const fresh = (queryResponse(JSON.stringify({ queries: Array.isArray(j.newQueries) ? j.newQueries : [] }), g.languages.length ? g.languages : ['tr']) ?? []).filter((s) => !usedQueries.has(s.query)).slice(0, 8);
      counter.managerRounds++;
      ctx.log(`Manager (${reason}): ${String(j.note ?? '').slice(0, 200)} · prioritized ${prioritized.length}, released ${release.length}, new queries ${fresh.length}${fresh.length ? `: ${fresh.slice(0, 4).map((s) => `"${s.query}"`).join(', ')}` : ''}`);
      if (guidance) queueGuidedSources(answerSources(answer), 'the manager');
      saveQueue();
      return fresh;
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.log(`Manager could not respond (${String(e.message).slice(0, 100)}); continuing with rules.`);
      return null;
    } finally {
      managed = false;
      lastManaged = Date.now();
    }
  }

  /*
   * Skills as guidance (field skills; user request 09.10.2026): the SKILL.md text of the named skills, or of the ones
   * the model picks for the topic ("auto"), goes into the prompts where the local model plans the crawl (the queries,
   * the manager, the MCP plans) as instructions for finding and judging sources. A skill's scripts are never run.
   * Addresses the guided answers name ("sources") are crawled like the job's sources, each once per run.
   */
  let guidance = '';
  const guidedSources = [];
  const guidedSeen = new Set();
  async function skillGuidance() {
    if (!useModel) return void ctx.log('Skills guide the local text model (queries, manager, MCP plans); with rule extraction they are not used.');
    let all = [];
    try {
      all = findSkills({ aiRoot: ctx.setting.aiRoot, dataRoot: ctx.setting.dataRoot });
    } catch {}
    let names = g.skills;
    if (names[0] === 'auto') {
      if (!all.length) return void ctx.log('Skills (auto): none is installed.');
      try {
        const { picked, note } = skillPickResponse(await askModel(ctx, SKILL_PICK_SYSTEM, skillPickPrompt(g.topic, all), 300), all);
        ctx.log(`Skills (auto, ${all.length} installed): ${picked.length ? `the model picked ${picked.join(', ')}` : 'none fits the topic'}${note ? ` — ${note.slice(0, 160)}` : ''}`);
        names = picked;
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        return void ctx.log(`Skills (auto): the model did not answer (${String(e.message).slice(0, 100)}); none used.`);
      }
    }
    const loaded = [];
    for (const n of names) {
      try {
        loaded.push(loadSkill(all, n));
      } catch {
        ctx.log(`Skill ${n}: not installed (any more); skipped.`);
      }
    }
    const { text: joined, used } = guidanceText(loaded);
    for (const s of loaded.filter((x) => !used.includes(x.name))) ctx.log(`Skill ${s.name}: ${String(s.content ?? '').trim() ? 'does not fit in the guidance any more' : 'its SKILL.md has no text'}; skipped.`);
    if (used.length) ctx.log(`Skills as guidance: ${used.join(', ')} (${joined.length} characters; their scripts are not run).`);
    guidance = joined;
  }

  /** Addresses a guided answer named: crawled like the job's sources. */
  function queueGuidedSources(list, from) {
    const fresh = list.filter((u) => !guidedSeen.has(u) && !seenLink.has(u) && !isUnsuitable(u) && domainAllowed(u));
    for (const u of fresh) {
      guidedSeen.add(u);
      guidedSources.push(u);
    }
    if (fresh.length) ctx.log(`Sources from the skills' guidance (${from}): ${fresh.join(', ')}`);
  }

  async function crawlGuidedSources() {
    while (guidedSources.length && !shouldStop()) {
      const k = guidedSources.shift();
      try {
        await processSource(k);
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`${k}: ${String(e.message).slice(0, 140)}`);
        counter.unreadable++;
      }
      advance(k);
    }
  }

  /*
   * MCP servers as sources (field mcp; user request 09.10.2026): the servers are started on the first topic round and
   * closed when the run ends. Each round the local model (the manager) picks calls of the tools that search or read
   * (never one that may change something: lib/data-sources.mjs toolRefusal) for the round's queries; without the model
   * the tools that take a query are called with the queries. Text in an answer becomes articles (judged like pages),
   * addresses in it join the crawl. At most mcpCalls calls per run, each within the server's own time limit.
   */
  let mcp = null;
  const mcpHistory = [];
  async function mcpStart() {
    if (mcp) return mcp;
    mcp = { manager: null, tools: [], calls: 0 };
    const manager = new McpManager({ aiRoot: ctx.setting.aiRoot, dataRoot: ctx.setting.dataRoot });
    mcp.manager = manager;
    const known = manager.servers();
    const names = g.mcp[0] === 'auto' ? Object.keys(known) : g.mcp;
    if (!names.length) ctx.log('MCP: no server is defined (Settings › Assistant › MCP servers).');
    for (const n of names.filter((x) => !known[x])) ctx.log(`MCP ${n}: not defined or turned off; skipped.`);
    await Promise.all(names.filter((x) => known[x]).map(async (name) => {
      try {
        const list = await manager.client(name).toolList();
        const { usable, skipped } = usableTools(name, list);
        mcp.tools.push(...usable);
        ctx.log(`MCP ${name}: ${list.length} tools, ${usable.length} usable (${usable.map((t) => t.tool).join(', ') || '-'})${skipped.length ? `; never called: ${skipped.map((s) => `${s.tool} (${s.reason})`).join(', ')}` : ''}.`);
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`MCP ${name}: could not start (${String(e.message).replace(/\s+/g, ' ').slice(0, 200)}); skipped.`);
      }
    }));
    return mcp;
  }

  /** Text an MCP tool answered with: judged and saved like a page; its address, or "mcp:<server>.<tool>#<hash>". */
  async function recordMcpText(item, server, tool) {
    const web = item.url && /^https?:\/\//i.test(item.url) ? item.url : null;
    if (web && (isUnsuitable(web) || !domainAllowed(web))) return false;
    const link = web ?? `mcp:${server}.${tool}#${createHash('sha1').update(item.text).digest('hex').slice(0, 16)}`;
    if (seenLink.has(link)) {
      counter.repeat++;
      return false;
    }
    seenLink.add(link);
    const h = item.html ? htmlBlocks(item.html) : { title: '', language: null, dateText: null, blocks: textBlocks(item.text) };
    const title = String(item.title || h.title || h.blocks.find((b) => /^h/.test(b.type))?.text || '').slice(0, 300);
    return recordContent({ finalUrl: link, link, source: `mcp:${server}/${tool}`, group: null, feedLink: null, pageMeta: { title, alternatives: [], tags: [] }, h: { ...h, title }, html: web ? item.html : null, wp: null, method: 'mcp' });
  }

  /** One round of MCP calls for the round's queries -> the addresses they brought (url -> { title, source }). */
  async function mcpRound(queries) {
    const found = new Map();
    const m = await mcpStart();
    const budget = (g.mcpCalls ?? 20) - m.calls;
    if (!m.tools.length || budget <= 0 || shouldStop()) return found;
    const max = Math.min(budget, 8);
    let calls = null;
    if (useModel) {
      try {
        const plan = mcpPlanResponse(await askModel(ctx, MCP_PLAN_SYSTEM, mcpPlanPrompt({ topic: g.topic, languages: g.languages, queries, guidance, tools: m.tools, history: mcpHistory, max }), 900), m.tools, { made: mcpMade, max });
        for (const r of plan.refused) ctx.log(`MCP ${r.server}/${r.tool}: not offered (unknown, or it may change something); not called.`);
        ctx.log(`MCP plan: ${plan.calls.length} call${plan.calls.length === 1 ? '' : 's'}${plan.note ? ` — ${plan.note.slice(0, 200)}` : ''}`);
        ({ calls } = plan);
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`MCP plan: the model did not answer (${String(e.message).slice(0, 100)}); the tools that take a query get the queries.`);
      }
    }
    calls ??= ruleMcpPlan(m.tools, queries, { made: mcpMade, max });
    // One call at a time per server, the servers side by side
    const perServer = new Map();
    for (const c of calls) perServer.set(c.server, [...(perServer.get(c.server) ?? []), c]);
    await Promise.all([...perServer.values()].map(async (list) => {
      for (const c of list) {
        if (shouldStop() || m.calls >= (g.mcpCalls ?? 20)) return;
        m.calls++;
        counter.mcpCalls++;
        mcpMade.add(callKey(c));
        const shown = `MCP ${c.server}/${c.tool} ${JSON.stringify(c.arguments).slice(0, 120)}`;
        const startedAt = Date.now();
        const took = () => `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
        try {
          const r = await m.manager.client(c.server).call(c.tool, c.arguments, { signal: ctx.signal });
          if (r.error) {
            ctx.log(`${shown} → the tool reported an error: ${r.text.replace(/\s+/g, ' ').slice(0, 160)} (${took()})`);
            mcpHistory.push({ ...c, result: 'error' });
            continue;
          }
          const items = mcpResultItems(r.text);
          const web = Object.values(c.arguments).find((v) => typeof v === 'string' && /^https?:\/\//i.test(v)) ?? null;
          let articles = 0;
          for (const a of items.articles) {
            // a read tool's single text is the page it was given
            if (await recordMcpText({ ...a, url: a.url ?? (items.articles.length === 1 ? web : null) }, c.server, c.tool)) articles++;
          }
          counter.mcp += articles;
          const fresh = [];
          for (const u of items.links) {
            if (found.has(u) || seenLink.has(u) || isUnsuitable(u) || !domainAllowed(u)) continue;
            found.set(u, { title: '', source: `mcp:${c.server}/${c.tool}` });
            fresh.push(u);
          }
          ctx.log(`${shown} → ${articles} article${articles === 1 ? '' : 's'} from its text, ${fresh.length} new address${fresh.length === 1 ? '' : 'es'} (${took()})`);
          mcpHistory.push({ ...c, result: `${items.articles.length} texts, ${articles} kept, addresses: ${fresh.slice(0, 5).join(' ') || '-'}` });
        } catch (e) {
          if (ctx.signal?.aborted) throw e;
          ctx.log(`${shown} → ${String(e.message).replace(/\s+/g, ' ').slice(0, 200)} (${took()})`);
          mcpHistory.push({ ...c, result: 'failed' });
        }
        advance(`MCP ${c.server}/${c.tool}`);
      }
    }));
    if (mcpHistory.length > 60) mcpHistory.splice(0, mcpHistory.length - 60);
    return found;
  }

  /* Topic: queries -> search -> result pages -> discover productive sites. */
  async function topicCollect(readyQueries = null) {
    const count = Math.min(24, Math.max(6, Math.ceil((g.target || 360) / 15)));
    let queries = readyQueries;
    if (!queries && useModel) {
      try {
        const prompt = `${queryPrompt(g.topic, g.languages, count)}${guidance ? `\n\n${guidancePart(guidance)}\n\nAlso name up to 5 source addresses the guidance points to (home pages, feeds or pages) as "sources": ["https://..."] in the same JSON.` : ''}`;
        const answer = await askModel(ctx, QUERY_SYSTEM, prompt, 600);
        queries = queryResponse(answer, g.languages);
        if (guidance) queueGuidedSources(answerSources(answer), 'the queries');
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`Query generation failed (${String(e.message).slice(0, 100)}); using template queries.`);
      }
    }
    queries ??= defaultQueries(g.topic, g.languages);
    for (const s of queries) usedQueries.add(s.query);
    const template = ctx.setting.dataSearchTemplate;
    // The search services of Settings › Web search first (an unset one is skipped, said once); the scraped engines
    // after them (the test template stands for them)
    if (!servicesTold) {
      servicesTold = true;
      for (const k of jobServices.filter((m) => !serviceConfig[m])) ctx.log(`${ENGINE_NAMES[k]}: not set in Settings › Web search; skipped.`);
    }
    const services = jobServices.filter((m) => searcher.usable(m));
    const scraped = g.engines.filter((m) => SEARCH_ENGINES.includes(m));
    if (template && scraped.length) scraped.splice(0, scraped.length, 'test');
    if (queries.length) ctx.log(`Search: ${queries.length} queries × ${services.length + scraped.length} engines${services.length ? ` (${services.map((k) => ENGINE_NAMES[k]).join(', ')} first)` : ''} — ${queries.slice(0, 6).map((s) => `"${s.query}"`).join(', ')}${queries.length > 6 ? '…' : ''}`);
    const candidates = new Map();
    const eliminatedCandidates = new Set();
    const pending = [...queries];
    const round = new Map(); // engine -> { searches, results } of this round
    const tally = (engine, results) => countEngine(engine, results, round);
    const take = (list, s) => {
      for (const a of cleanResults(list)) {
        if (candidates.has(a.url) || seenLink.has(a.url) || !domainAllowed(a.url)) continue;
        // A result that drifted to an off-topic word is not crawled (Bing on long Turkish queries: "Ünlü Osmanlı minyatür…" -> gossip)
        if (isOffTopicResult(g.topic, s.query, a.title, a.summary)) eliminatedCandidates.add(a.url);
        else candidates.set(a.url, { title: a.title, query: s.query });
      }
    };
    // MCP servers (field mcp) are asked beside the web search; the addresses they bring join the candidates
    const mcpJob = (g.mcp?.length && queries.length ? mcpRound(queries) : Promise.resolve(new Map())).then((v) => ({ v }), (e) => ({ e }));
    let searched = 0;
    let failed = 0;
    await Promise.all(Array.from({ length: Math.min(g.parallel, 3) }, async () => {
      for (;;) {
        const s = pending.shift();
        if (!s || shouldStop()) return;
        const found = [];
        // A service that answers ends the services for this query (one search per query spares the quotas)
        let answered = false;
        for (const service of services) {
          const list = await searcher.search(service, s.query, { language: s.language, count: 20 });
          if (list === null) continue;
          tally(service, list.length);
          if (!list.length) continue;
          found.push(...list);
          answered = true;
          break;
        }
        // Bing and DuckDuckGo only for a query no service answered; Google News and Wikipedia for every query
        await Promise.all(scraped.filter((m) => !(answered && GENERAL_ENGINES.has(m))).map(async (engine) => {
          try {
            const r = await retrieve(template ? template.replace('{q}', encodeURIComponent(s.query)) : searchUrl(engine, s.query, s.language), { checkRobots: false, accept: 'application/rss+xml,application/xml,text/html;q=0.9,*/*;q=0.8' });
            const list = r.text ? searchResults(r.text, engine) : [];
            tally(engine, list.length);
            if (!r.text) failed++;
            found.push(...list);
          } catch (e) {
            if (ctx.signal?.aborted) throw e;
            failed++;
          }
        }));
        take(found, s);
        searched++;
        advance(`${candidates.size} candidate pages · search ${searched}/${queries.length} queries`);
      }
    }));
    const fromMcp = await mcpJob;
    if (fromMcp.e) throw fromMcp.e;
    let mcpLinks = 0;
    for (const [u, v] of fromMcp.v) {
      if (candidates.has(u) || seenLink.has(u)) continue;
      candidates.set(u, v);
      mcpLinks++;
    }
    counter.candidate += candidates.size;
    const eliminated = [...eliminatedCandidates].filter((u) => !candidates.has(u)).length;
    counter.offTopicResults += eliminated;
    // Commons too when media are downloaded (alongside the web crawl). In tests (a fake search engine) the real Commons is not used.
    // Its rejection is caught (an unhandled rejection on pause/cancel would bring the panel down); waited for even when the site pool fails
    const commonsJob = g.media === 'download' && (!ctx.setting.dataSearchTemplate || ctx.setting.commonsApi) ? commonsTopic(queries).catch(() => {}) : null;
    const hosts = new Map();
    for (const u of candidates.keys()) {
      try {
        const h = new URL(u).hostname;
        hosts.set(h, [...(hosts.get(h) ?? []), u]);
      } catch {}
    }
    if (queries.length || mcpLinks) ctx.log(`Search finished: ${candidates.size} candidate pages, ${hosts.size} sites${mcpLinks ? ` (${mcpLinks} pages from MCP)` : ''}${eliminated ? `, ${eliminated} candidate titles off-topic (not crawled)` : ''}${failed ? `, ${failed} search requests failed` : ''}. Results per engine: ${engineText(round)}.`);
    const orderedHosts = [...hosts.entries()].sort((a, b) => b[1].length - a[1].length);
    try {
    // The sources the skills' guidance pointed to first, then the search results
    await crawlGuidedSources();
    await Promise.all(Array.from({ length: g.parallel }, async () => {
      for (;;) {
        const h = orderedHosts.shift();
        if (!h || shouldStop()) return;
        const [host, urls] = h;
        const info = { accept: 0, trial: 0 };
        // The Google News group: every link is resolved to the publisher's address; the publishers differ, so no "first 3" rule and no discovery
        const gnews = host === gnewsHost;
        for (const u of urls) {
          if (shouldStop()) return;
          seenLink.add(u);
          const target = gnews ? await parseGnews(u) : u;
          if (!target) {
            counter.gnewsUnresolved++;
            continue;
          }
          if (target !== u) {
            if (seenLink.has(target) || !domainAllowed(target)) continue;
            seenLink.add(target);
            counter.gnewsResolved++;
          }
          info.trial++;
          try {
            if (await processPage(target, { source: candidates.get(u)?.source ?? `search:${target === u ? host : new URL(target).hostname}` })) info.accept++;
          } catch (e) {
            if (ctx.signal?.aborted) throw e;
            counter.unreadable++;
          }
          advance(`${host} · ${info.accept}/${info.trial} accepted`);
          if (!gnews && info.trial >= 3 && !info.accept) break; // with no acceptance in the first 3 the site is dropped
        }
        siteResult.set(host.replace(/^www\./, ''), [info.accept, info.trial]);
        // No new discovery in the last 20% of the time budget: finish what is at hand
        const discoveryTime = !g.durationMin || Date.now() < start + g.durationMin * 60000 * 0.8;
        // No home page discovery on a huge general site (Wikipedia...): its home page links to random articles
        if (info.accept >= 2 && discoveryTime && !shouldStop() && !gnews && !wideSite(host) && !g.sources.some((k) => k.includes(host))) {
          try {
            await processSource(`https://${host}/`, true);
          } catch (e) {
            if (ctx.signal?.aborted) throw e;
            ctx.log(`${host}: discovery failed (${String(e.message).slice(0, 100)})`);
          }
        }
      }
    }));
    } finally {
      await commonsJob;
    }
  }

  if (pendingMedia.size) {
    ctx.log(`${pendingMedia.size} media not downloaded in the previous run were re-queued.`);
    for (const [url, [type, o]] of pendingMedia) {
      seenMedia.add(url);
      queueMediaDownload(type, o, o.download, true);
    }
  }
  if (g.mcp?.length && !g.topic) ctx.log('MCP servers are asked in topic mode only (their tools need a topic to search for); skipped.');
  if (g.skills?.length && !g.topic) ctx.log('Skills guide topic mode only (where the model plans the crawl); skipped.');
  try {
    if (g.topic && g.skills?.length && !shouldStop()) await skillGuidance();
    if (g.sources.length) {
      const remaining = [...g.sources];
      await Promise.all(Array.from({ length: g.parallel }, async () => {
        for (;;) {
          const k = remaining.shift();
          if (!k || shouldStop()) return;
          try {
            await processSource(k);
          } catch (e) {
            if (ctx.signal?.aborted) throw e;
            ctx.log(`${k}: ${String(e.message).slice(0, 140)}`);
            counter.unreadable++;
          }
          completedSource++;
          advance(k);
        }
      }));
    }
    if (g.topic && !shouldStop()) await topicCollect();
    if (g.hopSites && !shouldStop()) await walkSites();
    // When the queue empties (or the topic results run out) the manager suggests a new direction; it stops after 3 rounds in a row with nothing new
    let idleRounds = 0;
    while (g.topic && managerOpen() && !shouldStop() && idleRounds < 3) {
      const before = total + counter.image + counter.video + counter.audio;
      const fresh = await manage('queue empty');
      if (!fresh?.length && !guidedSources.length) break;
      await topicCollect(fresh ?? []);
      if (g.hopSites && !shouldStop()) await walkSites();
      idleRounds = total + counter.image + counter.video + counter.audio > before ? 0 : idleRounds + 1;
    }
    if (g.hopSites && !siteQueue.size && !shouldStop()) ctx.log('Site to site: no new sites left to crawl.');
    // The background media downloads finish (time up / cancelled: the unstarted ones are left, retried later)
    await mediaFinish();
  } finally {
    await browser?.close().catch(() => {});
    mcp?.manager?.closeAll();
    if (g.hopSites || managerOpen() || g.mcp?.length) saveQueue(true);
    writeTried();
    ctx.job.dataProgress = { added: previous.added + counter.added, elapsedMs: previous.elapsedMs + (Date.now() - start) };
  }
  if (timeUp()) ctx.log(`Time limit (${g.durationMin} min) reached; collected items saved.`);

  // The last pass: no giving way at this stage (otherwise a finished job would run again from the start)
  ctx.job.noYield = true;
  // The ready-to-train files and the summary
  const records = [];
  const languages = {};
  const sources = {};
  const categories = {};
  total = await readRecords(file, (o) => {
    records.push(o);
    if (o.language) languages[o.language] = (languages[o.language] ?? 0) + 1;
    if (o.source) sources[o.source] = (sources[o.source] ?? 0) + 1;
    if (o.category) categories[o.category] = (categories[o.category] ?? 0) + 1;
  });
  // Media records become unique: a downloaded record of the same address wins (a deferred download is added on the next run)
  for (const type of MEDIA_TYPES) {
    const path = join(folder, `${MEDIA_FILES[type]}.jsonl`);
    if (!existsSync(path)) continue;
    const map = new Map();
    await readRecords(path, (o) => {
      const previous = map.get(o.url);
      if (!previous || (!previous.file && o.file)) map.set(o.url, o);
    });
    writeFileSync(`${path}.tmp`, [...map.values()].map((o) => JSON.stringify(o)).join('\n') + (map.size ? '\n' : ''));
    renameSync(`${path}.tmp`, path);
  }
  const images = [];
  await readRecords(join(folder, 'images.jsonl'), (o) => images.push(o));
  const examples = trainingExamples(records);
  const classification = records.filter((k) => k.extraction === 'model' && k.category && k.contentType).map((k) => ({ messages: [{ role: 'system', content: 'Classify the given article. Reply ONLY as JSON: {"category": "...", "contentType": "...", "tags": ["..."], "language": "..", "quality": 1-5}' }, { role: 'user', content: `${k.title}\n\n${String(k.text).slice(0, 6000)}` }, { role: 'assistant', content: JSON.stringify({ category: k.category, contentType: k.contentType, tags: k.tags ?? [], language: k.language, quality: k.quality }) }], source: k.url }));
  // Image <-> caption: the caption cleaned as in training (old records hold Wikidata leftovers, licence sentences)
  const imagePairs = images.map((o) => ({ image: o.file ?? o.url, text: mergeCaptions(o.alt, o.caption || o.text), language: o.language, page: o.page })).filter((o) => o.text.length >= 12);
  // File counts by the names on disk (summary.json "files": the collection list reads these keys)
  const files = { articles: total, images: images.length };
  for (const m of ['videos', 'audio']) files[m] = await readRecords(join(folder, `${m}.jsonl`), () => {});
  for (const [type, list] of [['training-meta', examples.meta], ['training-translation', examples.translation], ['training-write', examples.write], ['training-summary', examples.summary], ['training-title', examples.title], ['training-question', examples.question], ['training-classification', classification], ['training-image', imagePairs]]) {
    files[type] = list.length;
    writeFileSync(join(folder, `${type}.jsonl`), list.map((o) => JSON.stringify(o)).join('\n') + (list.length ? '\n' : ''));
  }
  const avgWords = records.length ? Math.round(records.reduce((t, k) => t + (k.words ?? 0), 0) / records.length) : 0;
  const newSummary = { name: g.name, topic: g.topic || oldSummary.topic || null, total, languages, sources, categories, avgWords, withMetaDescription: records.filter((k) => k.metaDescription).length, translationGroups: new Set(records.filter((k) => k.group).map((k) => k.group)).size, files, req: retrieve.stats, lastJob: ctx.job.id, durationSec: Math.round((Date.now() - start) / 1000), lastUpdate: new Date().toISOString() };
  writeFileSync(join(folder, 'summary.json'), JSON.stringify(newSummary, null, 1));
  const skipped = Object.entries(counter).filter(([k, v]) => !['added', 'candidate', 'browser', 'wpApi', 'translation', 'commonCrawl', 'commons', 'onlyMedia', 'modelLinks', 'managerRounds', 'siteSearch', 'gnewsResolved', 'mediaDeferred', 'doc', 'image', 'video', 'audio', 'downloadedMb', 'mcp', 'mcpCalls'].includes(k) && v).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
  ctx.log(`Done: ${counter.added} new articles (${total} in the collection; ${counter.candidate} candidates; ${counter.translation} translation pairs, ${counter.wpApi} WordPress API, ${counter.commonCrawl} Common Crawl, ${counter.doc} documents, ${counter.browser} via browser). Skipped: ${skipped}.`);
  ctx.log(`Media: ${counter.image} images, ${counter.video} videos, ${counter.audio} audio${counter.downloadedMb ? ` (${counter.downloadedMb.toFixed(1)} MB downloaded)` : ''}${counter.mediaDeferred ? ` · ${counter.mediaDeferred} downloads deferred due to rate limit/network error (retried on the next run)` : ''} · ${retrieve.stats.req} requests, ${retrieve.stats.error} errors, ${Math.round(retrieve.stats.wait / 1000)} s waiting.`);
  if (engineCount.size) ctx.log(`Search engines in this run (results, searches): ${engineText(engineCount)}.`);
  if (g.mcp?.length && g.topic) ctx.log(`MCP: ${counter.mcpCalls} call${counter.mcpCalls === 1 ? '' : 's'} (at most ${g.mcpCalls ?? 20}), ${counter.mcp} article${counter.mcp === 1 ? '' : 's'} from their text.`);
  if (g.hopSites) ctx.log(`Site to site: ${visitedSites.size} sites crawled, ${siteQueue.size + walking.size} queued${counter.modelLinks ? `; the model selected ${counter.modelLinks} links` : ''}${counter.managerRounds ? `; the manager steered ${counter.managerRounds} times` : ''}${counter.siteSearch ? `; site search found ${counter.siteSearch} topic pages` : ''}.`);
  ctx.log(`Training files: ${TRAINING_FILES.map((e) => `${e.slice('training-'.length)} ${files[e]}`).join(', ')} · languages: ${Object.entries(languages).map(([d, n]) => `${d} ${n}`).join(', ') || '-'} · categories: ${Object.entries(categories).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d, n]) => `${d} ${n}`).join(', ') || '-'}.`);
  const output = { collection: g.name, folder, total, files, languages, categories, durationSec: newSummary.durationSec, ...counter, downloadedMb: Math.round(counter.downloadedMb), engines: Object.fromEntries(engineCount) };
  writeFileSync(join(ctx.folder, 'data.json'), JSON.stringify(output, null, 1));
  ctx.addOutput({ file: 'data.json', type: 'data', ...output });
  ctx.progress({ percent: 100, stage: 'Done', detail: `${counter.added} new articles · total ${total}` });
}
