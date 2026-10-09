/**
 * Data collection sources (user request 09.10.2026): the search services of Settings › Web search as engines of the
 * data job (one request at a time per service, back-off on 429, a refused key or the run's limit takes a service out),
 * asked before the scraped engines; their results go through the same pipeline (filters, robots, private network,
 * dedupe). MCP servers as sources: the model (or, without it, the rule) picks calls of the tools that search or read,
 * never one that may change something; text in the answers becomes articles, addresses join the crawl. Everything
 * runs against fake services, sites, MCP servers and the fake text model on 127.0.0.1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanResults, textBlocks } from '../lib/data-collection.mjs';
import {
  ALL_ENGINES, GUIDANCE_CHARS, SKILL_CHARS, addressesIn, answerSources, callKey, engineList, guidanceText, mcpPlanResponse, mcpResultItems, nameList, ruleMcpPlan, serviceSearcher, skillPickPrompt,
  skillPickResponse, toolRefusal, usableTools,
} from '../lib/data-sources.mjs';
import { validate } from '../lib/jobs/data.mjs';
import { LocalLlm } from '../lib/llm.mjs';
import { createPanel } from './env.mjs';

const FAKE_MCP = fileURLToPath(new URL('./fake-mcp.mjs', import.meta.url));
const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const freePort = () => new Promise((ok) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const n = s.address().port;
    s.close(() => ok(n));
  });
});

const BRAVE_KEY = 'BSAfakeBraveKey1234';
const TAVILY_KEY = 'tvly-fakeTavilyKey5678';
const readRecords = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)) : []);
const listen = (s) => new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}`)));

// Article pages that pass the rule filters, each with words of its own (not near copies of each other)
const WORDS = 'elma armut kiraz vişne ceviz fındık kayısı şeftali erik dut incir nar deniz dağ orman nehir göl ova bulut yağmur kar rüzgâr güneş ay yıldız köprü kale saray çarşı liman fener bahçe tarla bağ çeşme kuyu değirmen han hamam kervan gemi tren yol patika vadi tepe kaya mağara ada koy sahil kumsal dalga martı leylek turna serçe baykuş tilki kirpi sincap'.split(' ');
const seedOf = (s) => [...s].reduce((t, c) => (t * 31 + c.charCodeAt(0)) % 9973, 7);
const article = (title) => {
  const no = seedOf(title);
  const sentence = (i) => Array.from({ length: 22 }, (_, k) => WORDS[(no * 131 + i * 17 + k * k * 7 + k) % WORDS.length]).join(' ');
  return `<html lang="tr"><head><title>${title}</title></head><body><article><h1>${title}</h1>${Array.from({ length: 30 }, (_, i) => `<p>Gezgin kedi ${sentence(i)} ${no}.</p>`).join('')}</article></body></html>`;
};

test('engines field: the services and the free engines, viki read as wiki, unknown dropped; result filter shared by every engine', () => {
  assert.deepEqual(ALL_ENGINES, ['brave', 'tavily', 'searxng', 'bing', 'ddg', 'gnews', 'wiki']);
  assert.deepEqual(engineList('Brave, viki  bing,google,brave'), ['brave', 'wiki', 'bing']);
  assert.deepEqual(engineList(['searxng', 'TAVILY']), ['searxng', 'tavily']);
  assert.deepEqual(engineList(''), []);
  const list = cleanResults([
    { url: 'https://a.example/x', title: 'A' },
    { url: 'https://a.example/x/', title: 'same page' },
    { url: 'https://www.youtube.com/watch?v=1', title: 'video' },
    { url: 'https://a.example/file.pdf', title: 'file' },
    { url: 'not an address', title: 'bad' },
    { url: 'https://b.example/y?z=1', title: 'B' },
  ]);
  assert.deepEqual(list.map((r) => r.url), ['https://a.example/x', 'https://b.example/y?z=1']);
});

test('service searcher: one request at a time per service with a gap, 429 backs off (Retry-After) and retries, a refused key and the limit take a service out, a site search uses half the limit', async () => {
  const seen = [];
  let active = 0;
  let most = 0;
  let searx429 = 0;
  const s = createServer((i, y) => {
    const u = new URL(i.url, 'http://x');
    let body = '';
    i.on('data', (d) => (body += d));
    i.on('end', () => {
      active++;
      most = Math.max(most, active);
      seen.push({ at: Date.now(), path: u.pathname, q: u.searchParams.get('q') ?? JSON.parse(body || '{}').query, count: u.searchParams.get('count'), body });
      setTimeout(() => {
        active--;
        const json = (code, v, headers = {}) => {
          y.writeHead(code, { 'Content-Type': 'application/json', ...headers });
          y.end(JSON.stringify(v));
        };
        if (u.pathname === '/brave') return json(200, { web: { results: [{ title: `<strong>${u.searchParams.get('q')}</strong>`, url: 'https://a.example/1', description: 'x' }] } });
        if (u.pathname === '/tavily') return json(401, {});
        if (u.pathname === '/searx/search') return searx429++ < 1 ? json(429, {}, { 'Retry-After': '0' }) : json(200, { results: [{ title: 'S', url: 'https://s.example/1', content: 'y' }] });
        json(404, {});
      }, 30);
    });
  });
  const base = await listen(s);
  const log = [];
  try {
    const searcher = serviceSearcher({ config: { brave: BRAVE_KEY, tavily: TAVILY_KEY, searxng: `${base}/searx` }, urls: { brave: `${base}/brave`, tavily: `${base}/tavily` }, log: (m) => log.push(m), minDelayMs: 80, limit: 4 });
    // three searches at once: the service gets them one after another, 80 ms apart (measured from the first start: the
    // server's arrival times jitter under load)
    const t0 = Date.now();
    const answers = await Promise.all(['bir', 'iki', 'üç'].map((q) => searcher.search('brave', q, { count: 20 })));
    assert.deepEqual(answers.map((a) => a[0].title), ['bir', 'iki', 'üç']);
    assert.equal(most, 1, 'never two requests to the service at the same time');
    const brave = seen.filter((x) => x.path === '/brave');
    assert.deepEqual(brave.map((x) => x.count), ['20', '20', '20']);
    assert.ok(brave[1].at - t0 >= 78 && brave[2].at - t0 >= 158, `the second at ${brave[1].at - t0} ms, the third at ${brave[2].at - t0} ms`);
    // a site search: "site:" in the query; it may use half of the limit (2 of 4): the 4th search is refused for it
    assert.equal(await searcher.search('brave', 'kedi', { site: 'a.example', share: 0.5 }), null, 'half of the limit is used: no site search');
    assert.equal((await searcher.search('brave', 'dört'))[0].title, 'dört');
    assert.equal(await searcher.search('brave', 'beş'), null, 'limit of 4 reached');
    assert.equal(searcher.usable('brave'), false);
    assert.match(log.join('\n'), /Brave Search: 4 searches used in this run/);
    // Tavily refuses the key: out for the rest of the run (said once, without the key)
    assert.equal(await searcher.search('tavily', 'kedi'), null);
    assert.equal(await searcher.search('tavily', 'kedi'), null);
    assert.equal(seen.filter((x) => x.path === '/tavily').length, 1);
    assert.match(log.join('\n'), /Tavily: HTTP 401 \(the key was refused \(Settings › Web search\)\); not used for the rest of this run\./);
    // SearXNG: 429 first, the wait grows to 2 s, the same search again answers
    const t1 = Date.now();
    const sx = await searcher.search('searxng', 'kedi', { site: 's.example' });
    assert.equal(sx[0].url, 'https://s.example/1');
    assert.ok(Date.now() - t1 >= 1900, 'waited after the 429');
    assert.deepEqual(seen.filter((x) => x.path === '/searx/search').map((x) => x.q), ['site:s.example kedi', 'site:s.example kedi']);
    assert.match(log.join('\n'), /SearXNG: HTTP 429; 2 s between its searches now\./);
    // a service that is not set is never asked
    const none = serviceSearcher({ config: {}, log: (m) => log.push(m) });
    assert.equal(await none.search('brave', 'x'), null);
    assert.deepEqual(Object.keys(searcher.stats()).sort(), ['brave', 'searxng', 'tavily']);
    assert.equal(log.join('\n').includes(BRAVE_KEY) || log.join('\n').includes(TAVILY_KEY), false, 'keys never in the log');
  } finally {
    s.close();
  }
});

/**
 * Fake search services and a fake site in one server: Brave (GET, key header), Tavily (POST, refuses the key), SearXNG
 * (429 once), the test template engine (/search) and the result pages (/b/…, /s/…, /t/…; /hidden is disallowed).
 */
async function fakeWeb() {
  const calls = [];
  let active = 0;
  let most = 0;
  let searx429 = 0;
  let root = '';
  const slug = (q) => encodeURIComponent(String(q).replace(/\s+/g, '-'));
  const s = createServer((i, y) => {
    const u = new URL(i.url, 'http://x');
    let body = '';
    i.on('data', (d) => (body += d));
    i.on('end', () => {
      const q = u.searchParams.get('q') ?? (body ? JSON.parse(body).query : null);
      calls.push({ path: u.pathname, q, at: Date.now(), token: i.headers['x-subscription-token'] });
      const json = (code, v, headers = {}) => {
        y.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        y.end(JSON.stringify(v));
      };
      if (u.pathname === '/brave') {
        active++;
        most = Math.max(most, active);
        return setTimeout(() => {
          active--;
          if (i.headers['x-subscription-token'] !== BRAVE_KEY) return json(401, {});
          // nothing for "rehber" and "inceleme": those queries go on to the next engine
          if (/rehber|inceleme/.test(q)) return json(200, { web: { results: [] } });
          json(200, { web: { results: [{ title: `Gezgin kedi ${q}`, url: `${root}/b/${slug(q)}`, description: 'Gezgin kedi' }, { title: 'Gezgin kedi ortak', url: `${root}/b/ortak`, description: 'aynı sayfa' }, { title: 'Gezgin kedi gizli', url: `${root}/hidden/x`, description: 'robots' }] } });
        }, 20);
      }
      if (u.pathname === '/tavily') return json(401, {});
      if (u.pathname === '/searx/search') {
        if (searx429++ < 1) return json(429, {}, { 'Retry-After': '0' });
        if (/inceleme/.test(q)) return json(200, { results: [] });
        return json(200, { results: [{ title: `Gezgin kedi ${q}`, url: `${root}/s/${slug(q)}`, content: 'Gezgin kedi' }] });
      }
      if (u.pathname === '/search') {
        y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        return y.end(`<rss><channel><item><title>Gezgin kedi ${q}</title><link>${root}/t/${slug(q)}</link></item></channel></rss>`);
      }
      if (u.pathname === '/robots.txt') {
        y.writeHead(200, { 'Content-Type': 'text/plain' });
        return y.end('User-agent: *\nDisallow: /hidden\n');
      }
      if (/^\/(b|s|t|hidden)\//.test(u.pathname)) {
        y.writeHead(200, { 'Content-Type': 'text/html' });
        return y.end(article(`Gezgin kedi ${decodeURIComponent(u.pathname)}`));
      }
      y.writeHead(404);
      y.end();
    });
  });
  root = await listen(s);
  return { root, calls, most: () => most, close: () => new Promise((ok) => s.close(ok)) };
}

test('data collection job: the search services of Settings › Web search are asked first (default engines: the set ones), Bing/DuckDuckGo stand-in only for queries no service answered; refused key out, 429 retried, limit per run, results per engine in the log; the result pages go through robots, dedupe and the private-network refusal', async () => {
  const web = await fakeWeb();
  const p = await createPanel({ setting: { dataSearchTemplate: `${web.root}/search?q={q}`, agentSearchApis: { brave: `${web.root}/brave`, tavily: `${web.root}/tavily` }, dataServiceDelayMs: 40, dataWideSites: ['127.0.0.1'] } });
  try {
    // nothing set: the free engines only
    assert.deepEqual(validate({ name: 'x', topic: 'kedi' }, { setting: p.setting }).engines, ['bing', 'ddg', 'gnews', 'wiki']);
    p.settingFile.saveWebSearch({ brave: BRAVE_KEY, tavily: TAVILY_KEY, searxng: `${web.root}/searx` });
    const job = p.queue.add('data', { name: 'Hizmetler', topic: 'gezgin kedi', extract: 'rule', minWord: 100, minFit: 1, target: 0, depth: 0, parallel: 3 });
    assert.deepEqual([job.input.engines, job.input.serviceLimit], [['brave', 'tavily', 'searxng', 'bing', 'ddg', 'gnews', 'wiki'], 100], 'the set services first, then the free engines');
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const log = (await p.queue.lastLog(job.id, 400)).join('\n');
    const asked = (path) => web.calls.filter((c) => c.path === path).map((c) => c.q);
    // six template queries: Brave answers four; "rehber" goes on to Tavily (refused) and SearXNG (429, then answers);
    // "inceleme" finds nothing at the services and goes to the stand-in of Bing/DuckDuckGo
    assert.equal(asked('/brave').length, 6, 'one Brave search per query');
    assert.equal(web.most(), 1, 'one Brave request at a time');
    assert.equal(asked('/tavily').length, 1, 'Tavily refused the key once and was not asked again');
    // (the two queries reach SearXNG in either order: one of them meets the 429 and is asked again)
    assert.deepEqual([...new Set(asked('/searx/search'))].sort(), ['gezgin kedi inceleme', 'gezgin kedi rehber']);
    assert.equal(asked('/searx/search').length, 3);
    assert.deepEqual(asked('/search'), ['gezgin kedi inceleme'], 'the scraped engine only for the query no service answered');
    assert.match(log, /Search: 6 queries × 4 engines \(Brave Search, Tavily, SearXNG first\)/);
    assert.match(log, /Tavily: HTTP 401 \(the key was refused \(Settings › Web search\)\); not used for the rest of this run\./);
    assert.match(log, /SearXNG: HTTP 429; 2 s between its searches now\./);
    assert.match(log, /Search finished: 8 candidate pages, 1 sites\. Results per engine: /);
    assert.match(log, /Search engines in this run \(results, searches\): .*Brave Search 12 \(6 searches\).*SearXNG 1 \(2 searches\).*test 1 \(1 search\)/);
    assert.equal(log.includes(BRAVE_KEY) || log.includes(TAVILY_KEY), false, 'no key in the log');
    // the pages: the four Brave pages + the shared one once, SearXNG's and the template's; robots kept /hidden out
    const records = readRecords(join(p.root, 'data', 'collections', 'hizmetler', 'articles.jsonl'));
    const paths = records.map((k) => new URL(k.url).pathname).sort();
    assert.deepEqual(paths, ['/b/gezgin-kedi', '/b/gezgin-kedi-ipu%C3%A7lar%C4%B1', '/b/gezgin-kedi-nas%C4%B1l-yap%C4%B1l%C4%B1r', '/b/gezgin-kedi-nedir', '/b/ortak', '/s/gezgin-kedi-rehber', '/t/gezgin-kedi-inceleme']);
    assert.ok(records.every((k) => k.source === 'search:127.0.0.1'));
    assert.equal(web.calls.filter((c) => c.path === '/b/ortak').length, 1, 'a page several queries found is fetched once');
    assert.equal(web.calls.filter((c) => c.path.startsWith('/hidden')).length, 0, 'robots.txt disallow holds for service results');
    const out = last.outputs.find((x) => x.type === 'data');
    assert.deepEqual(out.engines.brave, { searches: 6, results: 12 });

    // the limit per run: two Brave searches, then the other engines go on
    const before = asked('/brave').length;
    const limited = await p.waitUntilDone(p.queue.add('data', { name: 'Sinirli', topic: 'gezgin kedi', extract: 'rule', minWord: 100, minFit: 1, target: 0, depth: 0, parallel: 1, engines: 'brave, bing', serviceLimit: 2 }).id, 60000);
    assert.equal(limited.status, 'done', limited.error);
    assert.equal(asked('/brave').length - before, 2);
    const log2 = (await p.queue.lastLog(limited.id, 300)).join('\n');
    assert.match(log2, /Brave Search: 2 searches used in this run/);
    assert.match(log2, /Search: 6 queries × 2 engines \(Brave Search first\)/);

    // private network refused for result pages (the service itself is the user's own setting and is asked)
    p.setting.dataPrivateNetworkAllowed = false;
    const pages = web.calls.filter((c) => /^\/[bst]\//.test(c.path)).length;
    const before3 = asked('/brave').length;
    const closed = await p.waitUntilDone(p.queue.add('data', { name: 'Ozel ag', topic: 'gezgin kedi', extract: 'rule', minWord: 100, minFit: 1, target: 0, depth: 0, parallel: 1, engines: 'brave' }).id, 60000);
    assert.equal(closed.status, 'done', closed.error);
    assert.ok(asked('/brave').length > before3, 'the service was asked');
    assert.ok(closed.duration < 15, `a refused address is not retried or waited for (${closed.duration} s)`);
    assert.doesNotMatch((await p.queue.lastLog(closed.id, 300)).join('\n'), /resting the site/);
    assert.equal(web.calls.filter((c) => /^\/[bst]\//.test(c.path)).length, pages, 'no result page on the private network was requested');
    assert.equal(closed.outputs.find((x) => x.type === 'data').added, 0);
  } finally {
    p.setting.dataPrivateNetworkAllowed = true;
    await p.close();
    await web.close();
  }
});

test('MCP tools for data collection: one that may change something is never offered (its annotations or a word of its name); the plan keeps offered tools, no repeat, at most n; the rule calls query tools with the queries', () => {
  assert.deepEqual(nameList('fetch, Brave-search  fetch'), ['fetch', 'Brave-search']);
  assert.deepEqual(nameList(['a', 'AUTO']), ['auto']);
  assert.equal(toolRefusal({ name: 'search' }), null);
  assert.equal(toolRefusal({ name: 'get_post' }), '"post" in its name', 'post is read as the verb: never called');
  assert.equal(toolRefusal({ name: 'deleteNote' }), '"delete" in its name');
  assert.equal(toolRefusal({ name: 'send-email' }), '"send" in its name');
  assert.equal(toolRefusal({ name: 'brave_web_search' }), null);
  assert.equal(toolRefusal({ name: 'news', annotations: { destructiveHint: true } }), 'marked destructive');
  assert.equal(toolRefusal({ name: 'lookup', annotations: { readOnlyHint: false } }), 'marked as changing things');
  assert.equal(toolRefusal({ name: 'create_thing', annotations: { readOnlyHint: true } }), '"create" in its name', 'the name rule holds even when the server says read-only');
  const { usable, skipped } = usableTools('srv', [
    { name: 'search', description: 'Find  things', inputSchema: { type: 'object', properties: { query: { type: 'string' }, page: { type: 'integer' } }, required: ['query'] } },
    { name: 'fetch', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'update_index', inputSchema: {} },
  ]);
  assert.deepEqual(usable.map((t) => [t.tool, t.description]), [['search', 'Find things'], ['fetch', '']]);
  assert.deepEqual(skipped, [{ tool: 'update_index', reason: '"update" in its name' }]);
  const made = new Set([callKey({ server: 'srv', tool: 'fetch', arguments: { url: 'https://a.example/' } })]);
  const plan = mcpPlanResponse('```json\n{"calls": [{"server": "srv", "tool": "search", "arguments": {"query": "kedi"}}, {"server": "srv", "tool": "fetch", "arguments": {"url": "https://a.example/"}}, {"server": "srv", "tool": "update_index", "arguments": {}}, {"server": "srv", "tool": "search", "arguments": {"query": "kedi"}}, {"server": "srv", "tool": "search", "input": {"query": "köpek"}}, {"server": "srv", "tool": "search", "arguments": {"query": "kuş"}}], "note": "ok"}\n```', usable, { made, max: 2 });
  assert.deepEqual(plan.calls, [{ server: 'srv', tool: 'search', arguments: { query: 'kedi' } }, { server: 'srv', tool: 'search', arguments: { query: 'köpek' } }], 'made before and repeated calls left out, at most 2');
  assert.deepEqual(plan.refused, [{ server: 'srv', tool: 'update_index' }]);
  assert.throws(() => mcpPlanResponse('not json', usable));
  assert.deepEqual(ruleMcpPlan(usable, [{ query: 'a' }, { query: 'b' }, { query: 'c' }], { made: new Set([callKey({ server: 'srv', tool: 'search', arguments: { query: 'b' } })]), max: 5 }).map((c) => c.arguments.query), ['a', 'c'], 'only the tool that needs nothing but the query; made calls left out');
});

test('MCP answers for data collection: JSON records (long text = article with its address, short = address to crawl, nested lists, a wrapper), a Markdown page, a list of links, HTML; addresses without trailing punctuation; Markdown blocks', () => {
  const long = (w) => Array.from({ length: 60 }, (_, i) => `${w}${i}`).join(' ');
  const json = mcpResultItems(JSON.stringify({ query: 'x', web: { results: [{ title: 'Short', url: 'https://a.example/1', description: 'kısa' }, { title: 'Long', link: 'https://a.example/2', content: long('k'), authors: [{ name: 'A' }] }, { name: 'No address', text: long('m') }] } }));
  assert.deepEqual(json.articles.map((a) => [a.url, a.title]), [['https://a.example/2', 'Long'], [null, 'No address']]);
  assert.deepEqual(json.links, ['https://a.example/1']);
  assert.deepEqual(mcpResultItems(JSON.stringify([{ url: 'https://b.example/', summary: 'see https://c.example/page.' }])).links, ['https://b.example/', 'https://c.example/page']);
  const one = mcpResultItems(JSON.stringify({ url: 'https://d.example/a', title: 'Page', markdown: long('p') }));
  assert.deepEqual(one.articles.map((a) => a.url), ['https://d.example/a'], 'a single record object');
  const page = mcpResultItems(`# Başlık\n\n${long('w')}\n\nKaynak: [site](https://e.example/x).`);
  assert.deepEqual([page.articles.length, page.articles[0].title, page.links], [1, 'Başlık', ['https://e.example/x']]);
  const list = mcpResultItems(Array.from({ length: 6 }, (_, i) => `${i + 1}. Result ${i} https://f.example/${i} short text here`).join('\n'));
  assert.deepEqual([list.articles.length, list.links.length], [0, 6], 'a list of links is no article');
  const html = mcpResultItems(`<html><body><article><h1>T</h1><p>${long('h')}</p></article></body></html>`);
  assert.equal(html.articles[0].html.startsWith('<html>'), true);
  assert.deepEqual(addressesIn('(see https://g.example/a_(b)) and https://g.example/c), https://g.example/c'), ['https://g.example/a_(b)', 'https://g.example/c']);
  assert.deepEqual(textBlocks('## Alt **başlık**\n\nBir [bağlantı](https://x.example) ve metin.\n\n- bir\n- iki\n\n1. ilk\n2. ikinci\n\n```\nkod\n```').map((b) => [b.type, b.text]), [['h2', 'Alt başlık'], ['p', 'Bir bağlantı ve metin.'], ['li', 'bir'], ['li', 'iki'], ['oli', 'ilk'], ['oli', 'ikinci'], ['pre', 'kod']]);
});

/** A site for the MCP and skill tests: /mcp-page and /kaynak-arsivi (articles), /mcp-record-* (must never be fetched), /search (empty). */
async function mcpSite() {
  const requests = [];
  const s = createServer((i, y) => {
    requests.push(i.url);
    if (i.url.startsWith('/search')) {
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return y.end('<rss><channel></channel></rss>');
    }
    if (i.url === '/mcp-page' || i.url === '/kaynak-arsivi' || i.url.startsWith('/mcp-record')) {
      y.writeHead(200, { 'Content-Type': 'text/html' });
      return y.end(article(`Gezgin kedi ${i.url}`));
    }
    y.writeHead(404);
    y.end();
  });
  const root = await listen(s);
  return { root, requests, close: () => new Promise((ok) => s.close(ok)) };
}

/** A panel whose MCP servers are the fake data server (and a broken one). */
async function mcpPanel(site, extra = {}) {
  const p = await createPanel({ ...extra, setting: { dataSearchTemplate: `${site.root}/search?q={q}`, dataWideSites: ['127.0.0.1'], ...(extra.setting ?? {}) } });
  const calls = join(p.root, 'mcp-calls.txt');
  mkdirSync(p.setting.dataRoot, { recursive: true });
  writeFileSync(join(p.setting.dataRoot, 'mcp.json'), JSON.stringify({ mcpServers: { fakedata: { command: process.execPath, args: [FAKE_MCP, '--data', site.root, '--log', calls] }, broken: { command: 'nedese-no-such-command-xyz' } } }));
  const made = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
  // the project's skills (<ai>\.claude\skills) go here
  return { p, made, home: p.setting.aiRoot };
}

test('data collection job with MCP servers (fake text model): the model plans calls of the tools that search or read; a tool that may change something is never called, even when the model asks; text in the answers becomes articles (source server/tool, the record\'s or the read page\'s address), addresses join the crawl; at most mcpCalls calls per run, a call made before is not made again', async () => {
  const site = await mcpSite();
  const port = await freePort();
  const llm = new LocalLlm({ info: { name: 'fake', command: (prt) => ({ command: process.execPath, args: [FAKE_LLM, String(prt)] }) }, port, readySec: 20 });
  const { p, made } = await mcpPanel(site, { llm });
  try {
    assert.throws(() => p.queue.add('data', { name: 'x', topic: 'kedi', mcp: 'fakedata, nope' }), /No such MCP server: nope \(known: fakedata, broken\)/);
    const job = p.queue.add('data', { name: 'Mcp kaynak', topic: 'gezgin kedi', mcp: ['fakedata'], mcpCalls: 3, minWord: 50, target: 0, depth: 0, parallel: 1 });
    assert.deepEqual([job.input.mcp, job.input.mcpCalls], [['fakedata'], 3]);
    assert.match(job.summary.detail, /MCP: fakedata/);
    const last = await p.waitUntilDone(job.id, 90000);
    assert.equal(last.status, 'done', last.error);
    const log = (await p.queue.lastLog(job.id, 400)).join('\n');
    // round 1: search with the first query and fetch_page; round 2 (the manager's new query): search again, the same
    // fetch_page is not made twice; delete_note and wipe never reach the server
    assert.deepEqual(made(), ['search {"query":"sahte sorgu bir"}', 'fetch_page {"url":"https://fake.invalid/gezgin-kedi"}', 'search {"query":"gezgin kedi yeni yön"}']);
    assert.match(log, /MCP fakedata: 4 tools, 2 usable \(search, fetch_page\); never called: delete_note \("delete" in its name\), wipe \(marked destructive\)\./);
    assert.match(log, /MCP fakedata\/delete_note: not offered \(unknown, or it may change something\); not called\./);
    assert.match(log, /MCP plan: 2 calls — fake plan/);
    assert.match(log, /MCP fakedata\/search \{"query":"sahte sorgu bir"\} → 1 article from its text, 1 new address \(\d+\.\d s\)/);
    assert.match(log, /MCP: 3 calls \(at most 3\), 3 articles from their text\./);
    const records = readRecords(join(p.root, 'data', 'collections', 'mcp-kaynak', 'articles.jsonl'));
    const by = (u) => records.find((k) => k.url === u);
    assert.deepEqual([by(`${site.root}/mcp-record-15`)?.source, by(`${site.root}/mcp-record-15`)?.method], ['mcp:fakedata/search', 'mcp'], 'a long search record is an article with its address');
    assert.deepEqual([by(`${site.root}/mcp-record-20`)?.source], ['mcp:fakedata/search'], 'the second round brought its own record');
    assert.deepEqual([by('https://fake.invalid/gezgin-kedi')?.source, by('https://fake.invalid/gezgin-kedi')?.method], ['mcp:fakedata/fetch_page', 'mcp'], 'the read page under the address it was given');
    assert.deepEqual([by(`${site.root}/mcp-page`)?.source, by(`${site.root}/mcp-page`)?.method], ['mcp:fakedata/search', 'html'], 'the short result was crawled');
    assert.equal(site.requests.filter((u) => u.startsWith('/mcp-record')).length, 0, 'a record that came with its text is not fetched');
    assert.equal(site.requests.filter((u) => u === '/mcp-page').length, 1);
    // the calls made are kept with the collection: the same calls are not made again by the next run
    const queue = JSON.parse(readFileSync(join(p.root, 'data', 'collections', 'mcp-kaynak', 'site-queue.json'), 'utf8'));
    assert.equal(queue.mcpMade.length, 3);
    const again = await p.waitUntilDone(p.queue.add('data', { name: 'Mcp kaynak', topic: 'gezgin kedi', mcp: ['fakedata'], mcpCalls: 3, minWord: 50, target: 0, depth: 0, parallel: 1 }).id, 90000);
    assert.equal(again.status, 'done', again.error);
    assert.equal(made().filter((s) => s === 'fetch_page {"url":"https://fake.invalid/gezgin-kedi"}').length, 1, 'fetch_page not made again');
  } finally {
    await llm.close();
    await p.close();
    await site.close();
  }
});

test('data collection job with MCP servers without the text model (rule extraction): "auto" starts every server (a broken one is skipped with a log line), the tools that take a query get the queries, at most mcpCalls; no MCP in source mode', async () => {
  const site = await mcpSite();
  const { p, made } = await mcpPanel(site);
  try {
    assert.deepEqual(validate({ name: 'x', topic: 'kedi', mcp: 'Auto' }, { setting: p.setting }).mcp, ['auto']);
    const job = p.queue.add('data', { name: 'Mcp kural', topic: 'gezgin kedi', mcp: 'auto', mcpCalls: 2, extract: 'rule', minWord: 100, minFit: 1, target: 0, depth: 0, parallel: 1 });
    const last = await p.waitUntilDone(job.id, 90000);
    assert.equal(last.status, 'done', last.error);
    const log = (await p.queue.lastLog(job.id, 400)).join('\n');
    assert.match(log, /MCP broken: could not start \(.+\); skipped\./);
    assert.deepEqual(made(), ['search {"query":"gezgin kedi"}', 'search {"query":"gezgin kedi nedir"}']);
    assert.doesNotMatch(log, /MCP plan:/, 'no model: no plan');
    const records = readRecords(join(p.root, 'data', 'collections', 'mcp-kural', 'articles.jsonl'));
    assert.deepEqual(records.filter((k) => k.method === 'mcp').map((k) => k.url).sort(), [`${site.root}/mcp-record-11`, `${site.root}/mcp-record-17`]);
    assert.ok(records.some((k) => k.url === `${site.root}/mcp-page` && k.source === 'mcp:fakedata/search'));
    assert.match(log, /MCP: 2 calls \(at most 2\), 2 articles from their text\./);
    // source mode: the servers are not started
    const sources = await p.waitUntilDone(p.queue.add('data', { name: 'Mcp kaynaksiz', sources: [`${site.root}/mcp-page`], mcp: 'auto', extract: 'rule', minWord: 100, depth: 0 }).id, 60000);
    assert.equal(sources.status, 'done', sources.error);
    assert.match((await p.queue.lastLog(sources.id, 100)).join('\n'), /MCP servers are asked in topic mode only/);
    assert.equal(made().length, 2);
  } finally {
    await p.close();
    await site.close();
  }
});

test('skills as guidance: the picker keeps installed names (at most 3), the guidance cuts each skill and the whole, the sources of an answer are web addresses', () => {
  const skills = [{ name: 'a', description: 'Cats' }, { name: 'b', description: '' }, { name: 'c', description: 'x' }, { name: 'd', description: 'y' }];
  assert.equal(skillPickPrompt('kedi', skills), 'Topic: kedi\n\nSkills:\n- a: Cats\n- b: (no description)\n- c: x\n- d: y');
  assert.deepEqual(skillPickResponse('```json\n{"skills": ["b", "nope", "a", "b", {"name": "c"}, "d"], "note": " ok "}\n```', skills), { picked: ['b', 'a', 'c'], note: 'ok' });
  assert.throws(() => skillPickResponse('none', skills));
  const long = 'kelime '.repeat(1000);
  const { text, used } = guidanceText([{ name: 'a', content: '\n\nFirst.\n\n\n\nSecond.\n' }, { name: 'empty', content: '  ' }, { name: 'big', content: long }, { name: 'big2', content: long }, { name: 'big3', content: long }, { name: 'small', content: 'Last.' }]);
  assert.deepEqual(used, ['a', 'big', 'big2', 'small'], 'big3 no longer fits; the small one after it still does');
  assert.ok(text.startsWith('### Skill: a\nFirst.\n\nSecond.\n\n### Skill: big\nkelime'));
  const bigBody = text.split('### Skill: big\n')[1].split('\n\n')[0];
  assert.ok(text.length <= GUIDANCE_CHARS && bigBody.length <= SKILL_CHARS + 2 && bigBody.length > SKILL_CHARS - 10, `${text.length} / ${bigBody.length}`);
  assert.match(text, /kelime …\n\n### Skill: small\nLast\.$/);
  assert.deepEqual(answerSources('{"queries": [], "sources": ["https://a.example/x", "ftp://b.example/", "not an address", {"url": "http://c.example"}, "https://a.example/x"]}'), ['https://a.example/x', 'http://c.example/']);
  assert.deepEqual(answerSources('no json'), []);
  assert.deepEqual(answerSources(JSON.stringify({ sources: Array.from({ length: 9 }, (_, i) => `https://s${i}.example/`) })).length, 5);
});

/** Skills of the project (<ai>\.claude\skills): one on cats (with a script that must never run), one on cooking, one in panel-data. */
function writeSkills(p, home, site) {
  const marker = join(p.root, 'script-ran.txt');
  const cat = join(home, '.claude', 'skills', 'kedi-kaynaklari');
  mkdirSync(join(cat, 'scripts'), { recursive: true });
  writeFileSync(join(cat, 'SKILL.md'), `---\nname: kedi-kaynaklari\ndescription: Finding and judging sources about cats (kedi) - archives and guides\n---\n# Cat sources\n\nRead https://fake.invalid/kedi-rehberi with a page reading tool first.\nStart from the cat archive at ${site.root}/kaynak-arsivi; skip forums.\n\nRun \`node scripts/collect.mjs\` to refresh the list.\n`);
  writeFileSync(join(cat, 'scripts', 'collect.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const cook = join(home, '.claude', 'skills', 'yemek-tarifleri');
  mkdirSync(cook, { recursive: true });
  writeFileSync(join(cook, 'SKILL.md'), '---\nname: yemek-tarifleri\ndescription: Cooking recipes and kitchen tips\n---\nAlways read https://recipes.invalid/ first.\n');
  const panelSkill = join(p.setting.dataRoot, 'skills', 'arsiv-okuma');
  mkdirSync(panelSkill, { recursive: true });
  writeFileSync(join(panelSkill, 'SKILL.md'), '---\nname: arsiv-okuma\ndescription: Reading old newspaper archives\n---\nPrefer scanned pages with dates.\n');
  return marker;
}

test('data collection job with skills (fake text model): "auto" lets the model pick the skills that fit the topic; their SKILL.md text guides the queries (the addresses it points to are crawled), the MCP plans and the manager; their scripts are not run', async () => {
  const site = await mcpSite();
  const port = await freePort();
  const llm = new LocalLlm({ info: { name: 'fake', command: (prt) => ({ command: process.execPath, args: [FAKE_LLM, String(prt)] }) }, port, readySec: 20 });
  const { p, made, home } = await mcpPanel(site, { llm });
  try {
    const marker = writeSkills(p, home, site);
    assert.throws(() => p.queue.add('data', { name: 'x', topic: 'kedi', skills: 'kedi-kaynaklari, nope' }), /No such skill: nope \(known: arsiv-okuma, kedi-kaynaklari, yemek-tarifleri\)/);
    assert.deepEqual(validate({ name: 'x', topic: 'kedi', skills: 'kedi-kaynaklari\narsiv-okuma' }, { setting: p.setting }).skills, ['kedi-kaynaklari', 'arsiv-okuma']);
    const job = p.queue.add('data', { name: 'Beceri', topic: 'gezgin kedi', skills: 'auto', mcp: ['fakedata'], mcpCalls: 2, minWord: 50, target: 0, depth: 0, parallel: 1 });
    assert.deepEqual(job.input.skills, ['auto']);
    assert.match(job.summary.detail, /skills: auto/);
    const last = await p.waitUntilDone(job.id, 90000);
    assert.equal(last.status, 'done', last.error);
    const log = (await p.queue.lastLog(job.id, 400)).join('\n');
    assert.match(log, /Skills \(auto, 3 installed\): the model picked kedi-kaynaklari — fake pick/, 'the unknown name the model added is left out');
    assert.match(log, /Skills as guidance: kedi-kaynaklari \(\d+ characters; their scripts are not run\)\./);
    assert.match(log, new RegExp(`Sources from the skills' guidance \\(the queries\\): ${site.root.replace(/[.]/g, '\\.')}/kaynak-arsivi`));
    assert.match(log, /MCP plan: 2 calls — guided by the skills/);
    assert.ok(made().includes('fetch_page {"url":"https://fake.invalid/kedi-rehberi"}'), 'the read tool got the address the skill names');
    assert.match(log, /Manager \(queue empty\): Yeni alt başlık deneniyor \(guided\)/);
    assert.doesNotMatch(log, /Sources from the skills' guidance \(the manager\)/, 'the address the manager named again is not queued twice');
    assert.doesNotMatch(log, /recipes\.invalid|yemek-tarifleri \(/);
    const records = readRecords(join(p.root, 'data', 'collections', 'beceri', 'articles.jsonl'));
    assert.ok(records.some((k) => k.url === `${site.root}/kaynak-arsivi`), 'the source the guidance pointed to was crawled');
    assert.equal(site.requests.filter((u) => u === '/kaynak-arsivi').length, 1);
    assert.ok(records.some((k) => k.url === 'https://fake.invalid/kedi-rehberi' && k.source === 'mcp:fakedata/fetch_page'));
    assert.equal(existsSync(marker), false, "the skill's script was not run");
  } finally {
    await llm.close();
    await p.close();
    await site.close();
  }
});

test('data collection job with skills without the text model, and in source mode: said in the log, nothing else changes', async () => {
  const site = await mcpSite();
  const { p, home } = await mcpPanel(site);
  try {
    writeSkills(p, home, site);
    const rule = await p.waitUntilDone(p.queue.add('data', { name: 'Beceri kural', topic: 'gezgin kedi', skills: ['kedi-kaynaklari'], extract: 'rule', minWord: 100, target: 0, depth: 0, parallel: 1 }).id, 60000);
    assert.equal(rule.status, 'done', rule.error);
    const log = (await p.queue.lastLog(rule.id, 200)).join('\n');
    assert.match(log, /Skills guide the local text model \(queries, manager, MCP plans\); with rule extraction they are not used\./);
    assert.doesNotMatch(log, /Skills as guidance|Sources from the skills/);
    assert.equal(site.requests.includes('/kaynak-arsivi'), false);
    const sources = await p.waitUntilDone(p.queue.add('data', { name: 'Beceri kaynak', sources: [`${site.root}/mcp-page`], skills: 'auto', extract: 'rule', minWord: 100, depth: 0 }).id, 60000);
    assert.equal(sources.status, 'done', sources.error);
    assert.match((await p.queue.lastLog(sources.id, 100)).join('\n'), /Skills guide topic mode only/);
  } finally {
    await p.close();
    await site.close();
  }
});
