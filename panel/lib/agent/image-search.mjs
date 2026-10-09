/**
 * Picture search for the assistant (search_images, and show_image with a query; user request 08.10.2026: a photo from
 * anywhere on the web, every source at once, the best one first). All sources are asked at the same time; the results
 * are merged and ranked by how well the title and address match the query, the picture's size, the source's own order
 * and how many sources found the same picture.
 *
 * Sources: the SearXNG server and the Brave Search key of Settings › Web search when set, the Bing Images and Brave image
 * search pages, Openverse and Wikimedia Commons (free APIs). Measured 08.10.2026: those four answer plain requests;
 * DuckDuckGo's image API refused them (403), Reddit asks for a challenge.
 */
import { USER_AGENT, decodeEntities } from '../data-collection.mjs';

const fold = (t) => String(t ?? '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '');
const unescapeJs = (s) => String(s ?? '').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
const PICTURE = /\.(jpe?g|png|webp|gif)(\?|$)/i;

/** The sources and their addresses (tests point them at a fake server with Settings agentSearchApis). */
export const IMAGE_SOURCES = {
  bing: 'https://www.bing.com/images/search',
  brave: 'https://search.brave.com/images',
  openverse: 'https://api.openverse.org/v1/images/',
  commons: 'https://commons.wikimedia.org/w/api.php',
  braveApi: 'https://api.search.brave.com/res/v1/images/search',
};

// how much a source's own first places count (its ranking is about the query, its pictures about photos in general)
const WEIGHT = { searxng: 1, braveApi: 1, bing: 1, brave: 0.9, openverse: 0.7, commons: 0.7 };

async function page(url, cut, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8', ...headers }, redirect: 'follow', signal: cut });
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${r.status}`);
  }
  return r;
}

const ASK = {
  async bing(q, { urls }, cut) {
    const u = new URL(urls?.bing ?? IMAGE_SOURCES.bing);
    u.searchParams.set('q', q);
    u.searchParams.set('form', 'HDRSC2');
    const html = await (await page(u, cut)).text();
    const out = [];
    for (const m of html.matchAll(/\bm="(\{[^"]*\})"/g)) {
      try {
        const j = JSON.parse(decodeEntities(m[1]));
        if (j.murl) out.push({ image: j.murl, page: j.purl ?? null, title: j.t ?? j.desc ?? '' });
      } catch {}
    }
    return out;
  },
  async brave(q, { urls }, cut) {
    const u = new URL(urls?.brave ?? IMAGE_SOURCES.brave);
    u.searchParams.set('q', q);
    const html = await (await page(u, cut)).text();
    const out = [];
    for (const m of html.matchAll(/\{title:"((?:[^"\\]|\\.)*)",url:"((?:[^"\\]|\\.)*)"[\s\S]{0,1500}?thumbnail:\{src:"[^"]*",alt:[^,]*,height:(\d+),width:(\d+)[\s\S]{0,400}?original:"((?:[^"\\]|\\.)*)"/g)) {
      out.push({ image: unescapeJs(m[5]), page: unescapeJs(m[2]), title: unescapeJs(m[1]), ratio: Number(m[4]) / Math.max(1, Number(m[3])) });
    }
    return out;
  },
  async openverse(q, { urls }, cut) {
    const u = new URL(urls?.openverse ?? IMAGE_SOURCES.openverse);
    u.searchParams.set('q', q);
    u.searchParams.set('page_size', '20');
    const j = await (await page(u, cut, { Accept: 'application/json' })).json();
    return (j?.results ?? []).map((x) => ({ image: x.url, page: x.foreign_landing_url ?? null, title: x.title ?? '', width: x.width ?? null, height: x.height ?? null }));
  },
  async commons(q, { urls }, cut) {
    const u = new URL(urls?.commons ?? IMAGE_SOURCES.commons);
    for (const [k, v] of Object.entries({ action: 'query', generator: 'search', gsrnamespace: '6', gsrsearch: q, gsrlimit: '20', prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: '1280', format: 'json' })) u.searchParams.set(k, v);
    const j = await (await page(u, cut, { Accept: 'application/json' })).json();
    return Object.values(j?.query?.pages ?? {})
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((p) => ({ p, i: p.imageinfo?.[0] }))
      .filter(({ i }) => i && /^image\/(jpeg|png|webp|gif)$/.test(i.mime ?? ''))
      .map(({ p, i }) => ({ image: i.thumburl ?? i.url, page: i.descriptionurl ?? null, title: String(p.title ?? '').replace(/^File:/, '').replace(/\.[a-z]+$/i, ''), width: i.thumbwidth ?? i.width ?? null, height: i.thumbheight ?? i.height ?? null }));
  },
  async searxng(q, { config }, cut) {
    const u = new URL(`${config.searxng}/search`);
    u.searchParams.set('q', q);
    u.searchParams.set('categories', 'images');
    u.searchParams.set('format', 'json');
    const headers = { Accept: 'application/json' };
    if (u.username || u.password) {
      headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
      u.username = '';
      u.password = '';
    }
    const j = await (await page(u, cut, headers)).json();
    return (j?.results ?? []).filter((x) => x.img_src).map((x) => ({ image: x.img_src, page: x.url ?? null, title: x.title ?? '', ...(/^\d+\s*x\s*\d+$/.test(x.resolution ?? '') ? { width: Number(x.resolution.split('x')[0]), height: Number(x.resolution.split('x')[1]) } : {}) }));
  },
  async braveApi(q, { config, urls }, cut) {
    const u = new URL(urls?.braveApi ?? IMAGE_SOURCES.braveApi);
    u.searchParams.set('q', q);
    u.searchParams.set('count', '20');
    const j = await (await page(u, cut, { Accept: 'application/json', 'X-Subscription-Token': config.brave })).json();
    return (j?.results ?? []).map((x) => ({ image: x.properties?.url, page: x.url ?? null, title: x.title ?? '', width: x.properties?.width ?? null, height: x.properties?.height ?? null }));
  },
};

// stock photo sites stamp their previews with a watermark: last, used only when nothing else shows it (a Galata Tower
// photo came from c8.alamy.com with "alamy" across it, 08.10.2026)
const STOCK = /(^|\.)(alamy|shutterstock|gettyimages|istockphoto|dreamstime|depositphotos|123rf|ftcdn|canstockphoto|bigstockphoto|agefotostock|pond5|vectorstock|colourbox|featurepics|stockfresh|masterfile|superstock)\.[a-z.]+$|^stock\.adobe\.com$/i;
const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

/**
 * Every source at once (20 s each); merged, ranked best first. config: Settings › Web search ({ brave, searxng }); urls:
 * other addresses for the sources (tests). Returns { results: [{ image, page, title, width, height, sources, score }],
 * sources: { name: 'n results' | 'error' } }.
 */
export async function searchImages(query, { config = null, urls = null, signal = null, count = 10 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('Say what to look for.');
  const names = ['bing', 'brave', 'openverse', 'commons', ...(config?.searxng ? ['searxng'] : []), ...(config?.brave ? ['braveApi'] : [])];
  const limit = AbortSignal.timeout(20000);
  const cut = signal ? AbortSignal.any([signal, limit]) : limit;
  const answers = await Promise.allSettled(names.map((n) => ASK[n](q, { config, urls }, cut)));
  const sources = {};
  const merged = new Map();
  for (const [i, a] of answers.entries()) {
    const name = names[i];
    if (a.status === 'rejected') {
      sources[name] = `error: ${String(a.reason?.message ?? a.reason).slice(0, 80)}`;
      continue;
    }
    const list = a.value.filter((x) => /^https?:\/\//.test(String(x.image ?? '')) && !/\.svg(\?|$)/i.test(x.image));
    sources[name] = `${list.length} results`;
    for (const [rank, x] of list.entries()) {
      let key;
      try {
        const u = new URL(x.image);
        key = `${u.hostname.replace(/^www\./, '')}${u.pathname}`.toLowerCase();
      } catch {
        continue;
      }
      const seen = merged.get(key);
      if (seen) {
        seen.sources.push({ name, rank });
        seen.width ??= x.width ?? null;
        seen.height ??= x.height ?? null;
        if (!seen.title && x.title) seen.title = x.title;
      } else merged.set(key, { image: x.image, page: x.page ?? null, title: String(x.title ?? '').replace(/\s+/g, ' ').trim(), width: x.width ?? null, height: x.height ?? null, ratio: x.ratio ?? null, sources: [{ name, rank }] });
    }
  }
  const words = fold(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  for (const x of merged.values()) {
    const hay = fold(`${x.title} ${decodeURIComponent(x.image.replace(/%(?![0-9a-f]{2})/gi, ''))} ${x.page ?? ''}`);
    const relevance = words.length ? words.filter((w) => hay.includes(w)).length / words.length : 0.5;
    const place = Math.max(...x.sources.map((s) => (WEIGHT[s.name] ?? 0.7) / (1 + s.rank * 0.25)));
    const pixels = x.width && x.height ? x.width * x.height : null;
    const size = pixels ? Math.min(1, pixels / (1280 * 720)) - (Math.min(x.width, x.height) < 300 ? 1 : 0) : 0.4;
    const shape = x.ratio ?? (x.width && x.height ? x.width / x.height : 1.5);
    const odd = shape > 3 || shape < 0.33 ? 0.5 : 0;
    const stamped = STOCK.test(hostOf(x.image)) || STOCK.test(hostOf(x.page)) ? 2 : 0;
    x.score = Math.round((2 * relevance + 1.5 * place + size + 0.5 * (x.sources.length - 1) + (PICTURE.test(x.image) ? 0.2 : 0) - odd - stamped) * 100) / 100;
  }
  const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, count)));
  return { results: results.map(({ ratio, ...x }) => ({ ...x, sources: x.sources.map((s) => s.name) })), sources };
}
