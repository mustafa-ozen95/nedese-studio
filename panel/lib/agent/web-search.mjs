/**
 * Search services for the assistant's search_web (Settings › Web search; user request 08.10.2026): a Brave Search API
 * key, a Tavily API key or the address of a SearXNG server. A service that is set is tried before the headless browser
 * and the free engines, which stay as the fallback (the browser search breaks when the engines change their pages or
 * show a challenge). A key goes only into the request header to its own service: never into a log, an error text, a
 * tool result or a settings answer (the page shows its last 4 characters). The data collection job uses the same
 * services as search engines (lib/data-sources.mjs; user request 09.10.2026).
 */

export const SEARCH_SERVICES = {
  brave: { name: 'Brave Search', url: 'https://api.search.brave.com/res/v1/web/search' },
  tavily: { name: 'Tavily', url: 'https://api.tavily.com/search' },
  searxng: { name: 'SearXNG', url: null },
};

/** The order they are tried in. */
const ORDER = ['brave', 'tavily', 'searxng'];

// Why a service said no, in words the model (and the user reading the tool result) can act on
const STATUS_HINTS = {
  brave: { 401: 'the key was refused (Settings › Web search)', 403: 'the key was refused (Settings › Web search)', 422: 'the key or the query was refused', 429: 'rate limit or monthly quota reached' },
  tavily: { 401: 'the key was refused (Settings › Web search)', 429: 'rate limit reached', 432: 'plan limit reached', 433: 'pay-as-you-go limit reached' },
  searxng: { 403: 'the server does not answer in JSON: add json to search.formats in its settings.yml', 429: 'the server limited the requests' },
};

/** "••••a1b2": enough to tell two keys apart, never the key itself. */
export function maskKey(key) {
  const s = String(key ?? '');
  if (!s) return '';
  return s.length >= 12 ? `••••${s.slice(-4)}` : '••••';
}

/** A SearXNG address as shown in Settings: a password in it is hidden. */
export function maskAddress(address) {
  const s = String(address ?? '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.password) u.password = '••••';
    return decodeURI(u.href.replace(/\/$/, ''));
  } catch {
    return '••••';
  }
}

/** What Settings shows: which services are set, keys masked. */
export function maskedServices(config) {
  return { brave: maskKey(config?.brave), tavily: maskKey(config?.tavily), searxng: maskAddress(config?.searxng) };
}

/**
 * Checks a value typed in Settings and returns what is stored ('' removes the service). A SearXNG address is kept as
 * its base (a pasted ".../search?q=x" works too); a key is one word of printable characters.
 */
export function checkServiceValue(service, value) {
  if (!SEARCH_SERVICES[service]) throw new Error(`Unknown search service: ${service} (brave, tavily or searxng).`);
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (service === 'searxng') {
    let u;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
    } catch {
      throw new Error(`Not a web address: ${s}`);
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('The SearXNG address must start with http:// or https://.');
    u.search = '';
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/search$/, '') || '/';
    return u.href.replace(/\/$/, '');
  }
  if (s.length > 300 || !/^[\x21-\x7e]+$/.test(s)) throw new Error(`The ${SEARCH_SERVICES[service].name} key looks wrong: paste the key alone (letters, digits and signs, no spaces).`);
  return s;
}

/** The services that are set, in the order they are tried. */
export const serviceList = (config) => ORDER.filter((k) => config?.[k]);

/** Text of a result field: tags (Brave marks the query words with <strong>) and extra space removed. */
const plain = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/**
 * One service's results as { title, url, summary } (at most count: 10 for search_web, up to 20 for data collection).
 * site: only pages of that site ("site:" in the query; Tavily's include_domains). Throws with a short reason: the HTTP
 * status and what it likely means, never the key; the error carries status and retryAfter (a 429's wait) for callers
 * that back off. urls: other endpoints for Brave and Tavily (tests: a fake server).
 */
export async function serviceSearch(service, config, query, { language = null, signal = null, urls = null, count = 10, site = null } = {}) {
  const limit = AbortSignal.timeout(20000);
  const cut = signal ? AbortSignal.any([signal, limit]) : limit;
  const n = Math.max(1, Math.min(20, Math.round(Number(count)) || 10));
  const q = site && service !== 'tavily' ? `site:${site} ${query}` : query;
  let r;
  if (service === 'brave') {
    const u = new URL(urls?.brave ?? SEARCH_SERVICES.brave.url);
    u.searchParams.set('q', q);
    u.searchParams.set('count', String(n));
    r = await fetch(u, { headers: { Accept: 'application/json', 'X-Subscription-Token': config.brave }, signal: cut });
  } else if (service === 'tavily') {
    r = await fetch(urls?.tavily ?? SEARCH_SERVICES.tavily.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${config.tavily}` }, body: JSON.stringify({ query: q, max_results: n, search_depth: 'basic', ...(site ? { include_domains: [site] } : {}) }), signal: cut });
  } else if (service === 'searxng') {
    const u = new URL(`${config.searxng}/search`);
    u.searchParams.set('q', q);
    u.searchParams.set('format', 'json');
    if (language) u.searchParams.set('language', language);
    // fetch takes no user:password in the address: it goes as Basic authorization (a SearXNG behind a password)
    const headers = { Accept: 'application/json' };
    if (u.username || u.password) {
      headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
      u.username = '';
      u.password = '';
    }
    r = await fetch(u, { headers, signal: cut });
  } else {
    throw new Error(`Unknown search service: ${service}`);
  }
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    const hint = STATUS_HINTS[service]?.[r.status];
    throw Object.assign(new Error(`HTTP ${r.status}${hint ? ` (${hint})` : ''}`), { status: r.status, retryAfter: r.headers.get('retry-after') });
  }
  let j;
  try {
    j = await r.json();
  } catch {
    throw new Error('the answer was not JSON');
  }
  const raw = service === 'brave' ? j?.web?.results : j?.results;
  return (Array.isArray(raw) ? raw : [])
    .map((x) => ({ title: plain(x?.title), url: String(x?.url ?? ''), summary: plain(x?.description ?? x?.content) }))
    .filter((s) => /^https?:\/\//.test(s.url))
    .slice(0, n);
}
