/**
 * Data collection helpers (no dependencies): web search (Bing RSS, DuckDuckGo HTML, Google News RSS),
 * RSS/Atom/sitemaps, robots.txt, page metadata (JSON-LD, Open Graph, hreflang, feed/WordPress API
 * discovery), Markdown blocks from HTML (link density filter, the densest content region), language guess,
 * near copies (simhash), private network address check, local model prompts/replies and training file output.
 * Job flow: lib/jobs/data.mjs.
 */
import { createHash } from 'node:crypto';

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 NedeseStudioData/2.0';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', copy: '©', trade: '™', middot: '·', bull: '•' };

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, a) => ENTITIES[a.toLowerCase()] ?? m);
}
// CDATA is opened first: otherwise "<![CDATA[...]]>" is taken for a tag and removed together with the title.
const untagged = (s) => decodeEntities(String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const countWords = (s) => String(s ?? '').split(/\s+/).filter(Boolean).length;

/** The document's type: rss | atom | opml | site-map | site-map-directory | json | html */
export function documentType(text) {
  const startedAt = String(text).slice(0, 2000).trimStart();
  if (/<rss[\s>]|<rdf:RDF/i.test(startedAt)) return 'rss';
  if (/<feed[\s>]/i.test(startedAt)) return 'atom';
  if (/<opml[\s>]/i.test(startedAt)) return 'opml';
  if (/<sitemapindex[\s>]/i.test(startedAt)) return 'site-map-directory';
  if (/<urlset[\s>]/i.test(startedAt)) return 'site-map';
  if (/^[[{]/.test(startedAt)) return 'json';
  return 'html';
}

/** RSS/Atom items: [{ link, title, dateText, summary, attachments: [{ url, type, byte, durationSec }] }] (podcast/video attachments included). */
export function feedItems(text) {
  const items = [];
  for (const m of String(text).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const o = m[0];
    const attachments = [...o.matchAll(/<(?:enclosure|media:content)\b([^>]*)>/gi)].map((e) => {
      const attrs = Object.fromEntries([...e[1].matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1].toLowerCase(), decodeEntities(a[2])]));
      return { url: attrs.url ?? '', type: attrs.type ?? '', byte: Number(attrs.length ?? attrs.filesize ?? 0) || null, durationSec: Number(attrs.duration ?? 0) || null };
    }).filter((e) => /^https?:\/\//i.test(e.url));
    const link = decodeEntities((/<link[^>]*>([^<]+)<\/link>/i.exec(o)?.[1] ?? /<link[^>]*href="([^"]+)"[^>]*\/?>/i.exec(o)?.[1] ?? /<guid[^>]*>(https?:[^<]+)<\/guid>/i.exec(o)?.[1] ?? attachments[0]?.url ?? '').trim());
    if (!/^https?:\/\//i.test(link)) continue;
    const duration = /<itunes:duration>([^<]+)<\/itunes:duration>/i.exec(o)?.[1];
    if (duration && attachments[0] && !attachments[0].durationSec) attachments[0].durationSec = duration.includes(':') ? duration.split(':').reduce((t, p) => t * 60 + Number(p), 0) : Number(duration) || null;
    items.push({
      link,
      title: untagged(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(o)?.[1]),
      dateText: untagged(/<(pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/\1>/i.exec(o)?.[2]),
      summary: untagged(/<(description|summary|content|content:encoded|itunes:summary)[^>]*>([\s\S]*?)<\/\1>/i.exec(o)?.[2]).slice(0, 1500),
      attachments,
    });
  }
  return items;
}

/** OPML (an RSS reader export): the feed addresses (xmlUrl). */
export function opmlFeeds(text) {
  return [...new Set([...String(text).matchAll(/<outline\b[^>]*\bxmlUrl\s*=\s*"([^"]+)"/gi)].map((m) => decodeEntities(m[1]).trim()).filter((u) => /^https?:\/\//i.test(u)))];
}

/** Sitemap: [{ loc, dateText }] newest first; for an index, the child sitemaps. */
export function sitemap(text) {
  const records = [...String(text).matchAll(/<(url|sitemap)\b[\s\S]*?<\/\1>/gi)].map((m) => ({
    loc: decodeEntities(/<loc>\s*([^<]+?)\s*<\/loc>/i.exec(m[0])?.[1] ?? ''),
    dateText: /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(m[0])?.[1] ?? '',
  })).filter((k) => /^https?:\/\//i.test(k.loc));
  return records.sort((a, b) => (b.dateText || '').localeCompare(a.dateText || ''));
}

/** robots.txt: the rules for "User-agent: *" (and our own name); allowed(path), delay (s), siteMaps. */
export function robotsRules(text) {
  const forbidden = [];
  const permission = [];
  const siteMaps = [];
  let delay = 0;
  let our = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const [key, ...value] = line.replace(/#.*/, '').split(':');
    const a = key.trim().toLowerCase();
    const d = value.join(':').trim();
    if (a === 'sitemap' && /^https?:\/\//i.test(d)) siteMaps.push(d);
    else if (a === 'user-agent') our = d === '*' || /nedese/i.test(d);
    else if (our && a === 'disallow' && d) forbidden.push(d);
    else if (our && a === 'allow' && d) permission.push(d);
    else if (our && a === 'crawl-delay') delay = Math.min(30, Number(d) || 0);
  }
  // "*" is any run of characters, a trailing "$" the end of the path (the Google robots.txt rule)
  const matches = (path, rule) => {
    const last = rule.endsWith('$');
    const body = last ? rule.slice(0, -1) : rule;
    if (!body.includes('*') && !last) return path.startsWith(body);
    return new RegExp(`^${body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}${last ? '$' : ''}`).test(path);
  };
  return {
    delay,
    siteMaps,
    allowed(path) {
      const y = permission.filter((k) => matches(path, k)).sort((p, q) => q.length - p.length)[0];
      const n = forbidden.filter((k) => matches(path, k)).sort((p, q) => q.length - p.length)[0];
      return !n || (y !== undefined && y.length >= n.length);
    },
  };
}

/* ── Page metadata ────────────────────────────────────────────────────── */

/** <meta> tags: name/property -> content (attribute order does not matter; the first value stays). */
export function metaTags(html) {
  const result = {};
  for (const m of String(html ?? '').matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const name = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase();
    if (name && attrs.content !== undefined && result[name] === undefined) result[name] = attrs.content.trim();
  }
  return result;
}

/** <link rel=…> tags: [{ rel, href, hreflang, type }] (href absolute). */
export function linkTags(html, base) {
  const list = [];
  for (const m of String(html ?? '').matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    if (!attrs.href) continue;
    let href;
    try {
      href = new URL(attrs.href, base).href;
    } catch {
      continue;
    }
    list.push({ rel: (attrs.rel ?? '').toLowerCase(), href, hreflang: (attrs.hreflang ?? '').toLowerCase(), type: (attrs.type ?? '').toLowerCase() });
  }
  return list;
}

const ARTICLE_TYPES = /^(Article|NewsArticle|BlogPosting|TechArticle|Report|ScholarlyArticle|Review|HowTo|Recipe)$/i;

/** Every JSON-LD object on the page (a flat list; @graph, mainEntity and arrays are opened). */
export function jsonLdObjects(html) {
  const list = [];
  for (const m of String(html ?? '').matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let j;
    try {
      j = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const stack = [j];
    while (stack.length && list.length < 200) {
      const n = stack.pop();
      if (Array.isArray(n)) stack.push(...n);
      else if (n && typeof n === 'object') {
        list.push(n);
        if (n['@graph']) stack.push(n['@graph']);
        if (n.mainEntity) stack.push(n.mainEntity);
      }
    }
  }
  return list;
}

/** The JSON-LD article object (if any). */
export function jsonLdArticle(html) {
  return jsonLdObjects(html).find((n) => [n['@type']].flat().some((t) => typeof t === 'string' && ARTICLE_TYPES.test(t))) ?? null;
}

const cleanText = (v) => untagged(typeof v === 'string' ? v : v?.text ?? v?.name ?? '');

/**
 * Question-answer pairs: FAQPage (Question/acceptedAnswer) and HowTo (steps) JSON-LD; also a "question?" heading in
 * the content + the paragraph(s) after it (FAQ sections). [{ question, answer }]
 */
export function questionAnswers(html, blocks = []) {
  const pairs = [];
  const add = (question, answer) => {
    question = cleanText(question).slice(0, 300);
    answer = cleanText(answer).slice(0, 2000);
    if (question.length >= 8 && answer.length >= 20 && !pairs.some((c) => c.question === question)) pairs.push({ question, answer });
  };
  for (const n of jsonLdObjects(html)) {
    const type = [n['@type']].flat().join(' ');
    if (/Question/.test(type) && n.acceptedAnswer) add(n.name, n.acceptedAnswer);
    if (/HowTo/.test(type) && Array.isArray(n.step)) {
      const steps = n.step.map((s, i) => `${i + 1}. ${cleanText(s.name ? `${s.name}: ${s.text ?? ''}` : s.text ?? s)}`).filter((s) => s.length > 4);
      if (steps.length >= 2) add(`${cleanText(n.name)}?`, steps.join('\n'));
    }
  }
  // FAQ in the content: a heading ending in a question mark + the paragraphs after it (up to the next heading, at most 3)
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!/^h[2-4]$/.test(b.type) || !/\?\s*$/.test(b.text) || countWords(b.text) < 3) continue;
    const answer = [];
    for (let j = i + 1; j < blocks.length && answer.length < 3 && !/^h/.test(blocks[j].type); j++) if (blocks[j].type === 'p') answer.push(blocks[j].text);
    if (answer.length) add(b.text, answer.join('\n\n'));
  }
  return pairs.slice(0, 40);
}

/** The images in the content: [{ url, alt, caption }] (tracking pixels excluded). */
export function contentImages(html, base = 'http://x/') {
  let s = String(html ?? '').replace(/<(script|style|noscript|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = [...s.matchAll(/<(article|main)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]).sort((a, b) => b.length - a.length)[0];
  if (main && untagged(main).length > 500) s = main;
  const list = [];
  for (const m of s.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    // The large version: the widest srcset candidate (w; for x, 1000 x the factor), otherwise src (a small preview on most sites)
    const candidates = [attrs.srcset, attrs['data-srcset'], attrs['data-lazy-srcset']].flatMap((s) => String(s ?? '').split(/,\s+/)).map((p) => p.trim().split(/\s+/)).filter((p) => p[0] && !/^data:/i.test(p[0]));
    const measure = ([, t]) => (/^\d+w$/.test(t ?? '') ? parseInt(t, 10) : /^[\d.]+x$/.test(t ?? '') ? parseFloat(t) * 1000 : 0);
    const largest = candidates.sort((a, b) => measure(b) - measure(a))[0]?.[0];
    const raw = largest || attrs['data-src'] || attrs['data-lazy-src'] || attrs.src || '';
    if (!raw || /^data:/i.test(raw) || /\.(svg|gif)(\?|$)/i.test(raw)) continue;
    const width = Number(attrs.width || 0);
    const height = Number(attrs.height || 0);
    if ((width && width < 200) || (height && height < 200)) continue; // icon, pixel
    let url;
    try {
      const a = new URL(raw, base);
      if (!/^https?:$/.test(a.protocol)) continue; // blob:, javascript: etc. cannot be downloaded
      url = a.href;
    } catch {
      continue;
    }
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const caption = untagged(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i.exec(after)?.[1] ?? '');
    const alt = untagged(attrs.alt ?? '');
    // An image without alt text is taken too (uncaptioned training data); only off-content addresses such as logos/icons/avatars are skipped
    if (/(^|[/_.-])(logo|icon|ikon|favicon|avatar|sprite|emoji|badge|spinner|loader|pixel|tracking)([/_.-]|$)/i.test(url)) continue;
    if (!list.some((g) => g.url === url)) list.push({ url, alt: alt.slice(0, 300), caption: caption.slice(0, 500) });
  }
  return list.slice(0, 50);
}

const LANGUAGE_CODE = (s) => {
  const m = /^([a-z]{2})(?:[-_]|$)/i.exec(String(s ?? '').trim());
  return m ? m[1].toLowerCase() : null;
};
// HTML entities in JSON-LD strings are decoded: some CMSs write "UNESCO&#039;ya" (measured 06.10.2026: haberturk, sabah)
const name_ = (v) => (typeof v === 'string' ? decodeEntities(v) : Array.isArray(v) ? v.map(name_).filter(Boolean).join(', ') : v && typeof v === 'object' ? name_(v.name) : '');
const list_ = (v) => (Array.isArray(v) ? v.map((x) => String(name_(x) || x)) : typeof v === 'string' ? v.split(',') : []).map((s) => s.trim()).filter(Boolean).slice(0, 20);

/**
 * Page metadata: title, meta title/description (SEO), language, date, author, tags, section, canonical address,
 * language alternatives (hreflang), the feeds found and the WordPress API address. JSON-LD > Open Graph > meta.
 */
export function pageMetadata(html, url = 'http://x/') {
  const s = String(html ?? '');
  const meta = metaTags(s);
  const links = linkTags(s, url);
  const ld = jsonLdArticle(s) ?? {};
  const tagTitle = untagged(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '');
  const h1 = untagged(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(s)?.[1] ?? '');
  const metaTitle = tagTitle || meta['og:title'] || '';
  // MediaWiki (Wikipedia): the JSON-LD headline is not the page title but the Wikidata description ("Genellikle Osmanlı'da saray..."); h1 or name
  const wikiTitle = /^MediaWiki/i.test(meta.generator ?? '') ? h1 || name_(ld.name) : '';
  const title = (wikiTitle || name_(ld.headline) || meta['og:title'] || h1 || tagTitle || '').trim().slice(0, 300);
  const canonical = links.find((l) => l.rel === 'canonical')?.href ?? meta['og:url'] ?? null;
  const alternatives = [];
  for (const l of links) {
    if (l.rel !== 'alternate' || !l.hreflang || l.hreflang === 'x-default') continue;
    const language = LANGUAGE_CODE(l.hreflang);
    if (language && !alternatives.some((a) => a.url === l.href)) alternatives.push({ language, url: l.href });
  }
  const feeds = links.filter((l) => l.rel === 'alternate' && /rss|atom/.test(l.type)).map((l) => l.href);
  const wpApi = links.find((l) => l.rel === 'https://api.w.org/')?.href ?? null;
  const language = LANGUAGE_CODE(ld.inLanguage) ?? LANGUAGE_CODE(/<html[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/i.exec(s)?.[1]) ?? LANGUAGE_CODE(meta['og:locale']) ?? null;
  return {
    title,
    metaTitle: metaTitle.slice(0, 300),
    metaDescription: (meta.description || meta['og:description'] || name_(ld.description) || '').trim().slice(0, 600),
    language,
    dateText: ld.datePublished || meta['article:published_time'] || meta.date || meta.pubdate || meta['dc.date'] || null,
    modified: ld.dateModified || meta['article:modified_time'] || null,
    author: (name_(ld.author) || meta.author || meta['article:author'] || '').slice(0, 120) || null,
    tags: [...new Set([...list_(ld.keywords), ...list_(meta.keywords), ...list_(meta['article:tag'])])].slice(0, 20),
    section: (name_(ld.articleSection) || meta['article:section'] || '').slice(0, 80) || null,
    canonical,
    alternatives,
    feeds: [...new Set(feeds)],
    wpApi,
    // The publisher's objection to AI training (noai / noimageai; TDM Reservation) is respected
    noAi: /\bnoai\b/i.test(meta.robots ?? '') || meta['tdm-reservation'] === '1',
    noImageAi: /\bnoimageai\b/i.test(meta.robots ?? ''),
    // A single-page app hint: an empty body, heavy scripts (may need the browser)
    scriptHeavy: (s.match(/<script\b/gi) ?? []).length >= 6 && /__NEXT_DATA__|id="(root|app|__nuxt|___gatsby)"|ng-version=|data-reactroot|window\.__INITIAL_STATE__/i.test(s),
  };
}

/* ── HTML -> blocks -> Markdown ───────────────────────────────────────── */

/**
 * HTML -> { title, language, dateText, blocks: [{ type, text }] } in document order. type: h1-h4, p, li (item),
 * oli (numbered item), blockquote, pre, td, figcaption. Navigation/header/footer/side parts and scripts are dropped;
 * with an <article>/<main> only its inside; blocks heavy with link text (menus, "related posts") are dropped.
 */
export function htmlBlocks(html) {
  let s = String(html ?? '');
  const title = untagged(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(s)?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '');
  const language = /<html[^>]*\blang="([a-z]{2})/i.exec(s)?.[1]?.toLowerCase() ?? null;
  const dateText = /<meta[^>]+(?:property|name)="(?:article:published_time|date|pubdate)"[^>]+content="([^"]+)"/i.exec(s)?.[1] ?? null;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe|form|button|select|canvas|video|audio)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = [...s.matchAll(/<(article|main)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]).sort((a, b) => b.length - a.length)[0];
  if (main && untagged(main).length > 500) s = main;
  s = s.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  // Comment, share and related-post parts (from the class/id name)
  s = s.replace(/<(div|section|ul)\b[^>]*(?:class|id)\s*=\s*"[^"]*\b(comments?|yorum\w*|share|sharing|social|related|breadcrumb|sidebar|widget|cookie|newsletter|subscribe|advert|ads?-|tags?-list|author-box|pagination)\b[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // The items of numbered lists: <li> inside <ol> -> <oli>
  s = s.replace(/<ol\b[\s\S]*?<\/ol>/gi, (ol) => ol.replace(/<li\b/gi, '<oli').replace(/<\/li>/gi, '</oli>'));
  const blocks = [];
  const seen = new Set();
  for (const m of s.matchAll(/<(h[1-4]|p|oli|li|blockquote|pre|td|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const type = m[1].toLowerCase();
    const inner = type === 'pre' ? m[2].replace(/<br\s*\/?>/gi, '\n') : m[2];
    const text = type === 'pre' ? decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim() : untagged(inner.replace(/<br\s*\/?>/gi, ' '));
    if (!text || seen.has(text)) continue;
    const isTitle = /^h/.test(type);
    if (!isTitle && type !== 'pre' && countWords(text) < 4) continue;
    // Link density: when more than half of the text is links it counts as a menu/list
    if (!isTitle) {
      const linked = untagged([...inner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((a) => a[1]).join(' '));
      if (linked.length > 0 && linked.length / Math.max(1, text.length) > 0.55) continue;
    }
    seen.add(text);
    blocks.push({ type, text });
  }
  return { title, language, dateText, blocks };
}

/**
 * Plain text or Markdown (the text an MCP tool answers with) -> blocks as htmlBlocks gives them: headings, list items,
 * code and paragraphs; links keep their words, images are dropped.
 */
export function textBlocks(text) {
  const plain = (s) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1').replace(/(\*\*|__|`)(.+?)\1/g, '$2').replace(/\s+/g, ' ').trim();
  const blocks = [];
  const seen = new Set();
  const add = (type, t) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    blocks.push({ type, text: t });
  };
  for (const part of String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    if (/^\s*```/.test(part)) {
      add('pre', part.replace(/^\s*```[^\n]*\n?|\n?```\s*$/g, '').trim());
      continue;
    }
    const lines = part.split('\n').map((l) => l.trim()).filter(Boolean);
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0] ?? '');
    if (heading) {
      add(heading[1].length <= 2 ? 'h2' : 'h3', plain(heading[2]));
      lines.shift();
    }
    if (lines.length && lines.every((l) => /^([-*+•]|\d+[.)])\s+/.test(l))) {
      for (const l of lines) add(/^\d/.test(l) ? 'oli' : 'li', plain(l.replace(/^([-*+•]|\d+[.)])\s+/, '')));
    } else if (lines.length) add('p', plain(lines.join(' ')));
  }
  return blocks;
}

/**
 * Rule-based extraction (without a model): the densest run of content. A content block: a heading, code or a text
 * of >= 12 words. Region score = content words - 15 x each non-content block between; the best region is picked,
 * and the short items (lists) inside it are kept.
 */
export function ruleExtract(blocks) {
  const content = blocks.map((b) => /^h/.test(b.type) || b.type === 'pre' || countWords(b.text) >= 12);
  const weight = blocks.map((b, i) => (content[i] ? Math.max(1, countWords(b.text)) : -15));
  let best = { score: -1, startedAt: 0, last: -1 };
  for (let i = 0; i < blocks.length; i++) {
    if (!content[i]) continue;
    let score = 0;
    for (let j = i; j < blocks.length; j++) {
      score += weight[j];
      if (content[j] && score > best.score) best = { score, startedAt: i, last: j };
    }
  }
  if (best.last < 0) return [];
  return blocks.slice(best.startedAt, best.last + 1).filter((b, k) => content[best.startedAt + k] || b.type === 'li' || b.type === 'oli');
}

/** Blocks -> Markdown (headings #, items -, numbered 1., quotes >, code ```). */
export function blockText(blocks) {
  const lines = [];
  let position = 0;
  for (const b of blocks) {
    if (b.type !== 'oli') position = 0;
    if (b.type === 'h1') lines.push(`# ${b.text}`);
    else if (b.type === 'h2') lines.push(`## ${b.text}`);
    else if (b.type === 'h3' || b.type === 'h4') lines.push(`### ${b.text}`);
    else if (b.type === 'li') lines.push(`- ${b.text}`);
    else if (b.type === 'oli') lines.push(`${++position}. ${b.text}`);
    else if (b.type === 'blockquote') lines.push(`> ${b.text}`);
    else if (b.type === 'pre') lines.push(`\`\`\`\n${b.text}\n\`\`\``);
    else lines.push(b.text);
  }
  // Consecutive items form one block without blank lines
  return lines.join('\n\n').replace(/(^|\n)(- [^\n]*)\n\n(?=- )/g, '$1$2\n').replace(/(^|\n)(\d+\. [^\n]*)\n\n(?=\d+\. )/g, '$1$2\n');
}

/** The body digest for the repeat check: headings excluded (a copy with a changed title is caught too). */
export const textDigest = (text) => createHash('sha1').update(String(text).split('\n').filter((s) => !s.startsWith('#')).join(' ').toLowerCase().replace(/\s+/g, ' ').slice(0, 2000)).digest('hex');

/* ── Near copies: simhash ─────────────────────────────────────────────── */

const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;
function fnv64(s) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** A 64-bit simhash (3-word shingles), 16 hex characters. Near copies differ in a few bits. */
export function simhash(text) {
  const k = String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  const v = new Array(64).fill(0);
  const n = Math.max(1, k.length - 2);
  for (let i = 0; i < n; i++) {
    const h = fnv64(k.slice(i, i + 3).join(' '));
    for (let b = 0; b < 64; b++) v[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
  }
  let result = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) result |= 1n << BigInt(b);
  return result.toString(16).padStart(16, '0');
}

export function hammingDistance(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/* ── Language guess ───────────────────────────────────────────────────── */

const TEXTS = [['ar', /\p{Script=Arabic}/u], ['ru', /\p{Script=Cyrillic}/u], ['el', /\p{Script=Greek}/u], ['he', /\p{Script=Hebrew}/u], ['th', /\p{Script=Thai}/u], ['ko', /\p{Script=Hangul}/u], ['ja', /\p{Script=Hiragana}|\p{Script=Katakana}/u], ['zh', /\p{Script=Han}/u]];
const STOP = {
  tr: 've bir bu da için ile olarak daha çok en gibi kadar ama sonra var olan değil ya ne',
  en: 'the and of to in is that for with as on are this by from was be at or it',
  de: 'der die und das ist nicht mit für auf ein eine sich auch den von zu im des werden',
  fr: 'le la les et des est une pour dans que qui pas sur avec plus au par ce du',
  es: 'el la los las que de en es por para con una del se su más como pero',
  it: 'il la che di e per una con non sono del della gli le più anche nel',
  pt: 'o a os as que de em para com uma não do da se mais por como mas',
  nl: 'de het een en van is dat op voor met zijn niet ook aan er maar om',
  pl: 'i w na się z nie jest to do że o jak po ale od za przez',
  id: 'yang dan di dengan untuk ini dari pada adalah tidak akan juga itu ke oleh',
};
const STOP_SET = Object.fromEntries(Object.entries(STOP).map(([d, s]) => [d, new Set(s.split(' '))]));

/** The text's language (ISO 639-1) or null: first the script, then stop word counts (at least 4 hits, a clear lead). */
export function detectLanguage(text) {
  const s = String(text ?? '');
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return null;
  for (const [language, d] of TEXTS) {
    const n = letters.filter((h) => d.test(h)).length;
    if (n / letters.length > 0.3) return language;
  }
  const words = s.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean).slice(0, 3000);
  const score = Object.entries(STOP_SET).map(([language, set]) => [language, words.filter((k) => set.has(k)).length]).sort((a, b) => b[1] - a[1]);
  const [[language, n], [, second = 0] = []] = score;
  if (n < 4 || n < second * 1.3) return null;
  return language;
}

/* ── Web search ───────────────────────────────────────────────────────── */

export const SEARCH_ENGINES = ['bing', 'ddg', 'gnews', 'wiki'];
const COUNTRY = { tr: 'TR', en: 'US', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', pt: 'BR', nl: 'NL', ru: 'RU', ar: 'SA', pl: 'PL', id: 'ID', ja: 'JP', ko: 'KR', zh: 'CN' };

/** The search address (no key needed): Bing RSS, DuckDuckGo HTML, Google News RSS, the Wikipedia search API. */
export function searchUrl(engine, query, language = 'tr') {
  const q = encodeURIComponent(query);
  const country = COUNTRY[language] ?? 'US';
  if (engine === 'bing') return `https://www.bing.com/search?format=rss&q=${q}&setlang=${language}&cc=${country}&count=30`;
  if (engine === 'ddg') return `https://html.duckduckgo.com/html/?q=${q}&kl=${language}-${country.toLowerCase()}`;
  if (engine === 'gnews') return `https://news.google.com/rss/search?q=${q}&hl=${language}&gl=${country}&ceid=${country}:${language}`;
  // Wikipedia (in the query's language): full-text search, address and intro summary in one request. Measured 06.10.2026: from
  // this IP Bing RSS gives an empty channel for foreign markets (cc=US/GB, mkt=en-US), DuckDuckGo 202; Wikipedia gave 20 relevant articles each in tr/en/de.
  if (engine === 'wiki') return `https://${/^[a-z]{2,3}$/.test(language) ? language : 'tr'}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&utf8=1&generator=search&gsrsearch=${q}&gsrnamespace=0&gsrlimit=20&prop=info%7Cextracts&inprop=url&exintro=1&explaintext=1&exsentences=2&exlimit=20`;
  throw new Error(`Unknown search engine: ${engine}`);
}

const SKIPPED_HOSTS = /(^|\.)(youtube|youtu\.be|facebook|instagram|twitter|x\.com|tiktok|pinterest|linkedin|reddit|amazon|ebay|aliexpress|trendyol|hepsiburada|n11|spotify|apple|google|bing|duckduckgo|microsoft\.com|play\.google|t\.me|whatsapp|vk\.com)(\.|$)/i;

/** A search reply -> [{ url, title, summary }] (feed items for RSS, articles for the Wikipedia API, result links for DuckDuckGo HTML). */
export function searchResults(text, engine = '') {
  const type = documentType(text);
  const result = [];
  if (type === 'json') {
    // The Wikipedia search API (formatversion=2): articles in search order (index)
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    const pages = Array.isArray(j?.query?.pages) ? j.query.pages : Object.values(j?.query?.pages ?? {});
    for (const p of pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) if (p?.fullurl) result.push({ url: p.fullurl, title: String(p.title ?? ''), summary: String(p.extract ?? '') });
  } else if (type === 'rss' || type === 'atom') {
    for (const o of feedItems(text)) result.push({ url: o.link, title: o.title, summary: o.summary });
  } else {
    const s = String(text);
    for (const m of s.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      let url = decodeEntities(m[1]);
      const u = /[?&]uddg=([^&]+)/.exec(url);
      if (u) url = decodeURIComponent(u[1]);
      else if (url.startsWith('//')) url = `https:${url}`;
      if (!/^https?:\/\//i.test(url)) continue;
      const remaining = s.slice(m.index + m[0].length, m.index + m[0].length + 1500);
      result.push({ url, title: untagged(m[2]), summary: untagged(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(remaining)?.[1] ?? '') });
    }
  }
  void engine;
  return cleanResults(result);
}

/**
 * Search results worth crawling, from any engine (the scraped ones above, the search services of Settings › Web search):
 * social networks, shops, video sites and search engines are left out, file links too (documents come from pages),
 * and the same page (host + path) once.
 */
export function cleanResults(result) {
  const seen = new Set();
  return result.filter((r) => {
    let u;
    try {
      u = new URL(r.url);
    } catch {
      return false;
    }
    if (SKIPPED_HOSTS.test(u.hostname) && !/news\.google\./.test(u.hostname)) return false;
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|mp[34]|jpe?g|png|gif|webp)$/i.test(u.pathname)) return false;
    const key = `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ── Google News link -> the publisher's address ───────────────────────── */
// news.google.com/rss/articles/<id> does no HTTP redirect (a ~600 KB JavaScript page). The web client calls batchexecute
// "garturlreq" with the signature on the page (data-n-a-sg, data-n-a-ts) and gets the publisher's address. Measured 06.10.2026: 5/5, ~0.4 s.

/** A Google News article address -> the article id; otherwise null. host: a fake server in tests. */
export function gnewsId(url, host = 'news.google.com') {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== host && !u.hostname.endsWith(`.${host}`)) return null;
  return /^\/(?:rss\/)?articles\/([\w-]+)$/.exec(u.pathname)?.[1] ?? null;
}

/** The signature and timestamp on the article page; otherwise null. */
export function gnewsSignature(html) {
  const sg = /data-n-a-sg="([^"]+)"/.exec(String(html))?.[1];
  const ts = /data-n-a-ts="(\d+)"/.exec(String(html))?.[1];
  return sg && ts ? { sg, ts: Number(ts) } : null;
}

/** The batchexecute body (application/x-www-form-urlencoded). */
export function gnewsResolveBody(id, { sg, ts }) {
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, ts, sg]);
  return `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]))}`;
}

/** A batchexecute reply -> the publisher's address; null when it cannot be resolved. */
export function gnewsResolveResponse(text) {
  for (const part of String(text).split('\n\n').slice(1)) {
    // The whole part or (when length lines follow) its first line is JSON
    for (const candidate of [part, part.split('\n')[0]]) {
      try {
        const address = JSON.parse(JSON.parse(candidate)[0][2])?.[1];
        if (/^https?:\/\//i.test(address)) return address;
      } catch {}
    }
  }
  return null;
}

/** The system prompt for generating search queries. */
export const QUERY_SYSTEM = `You are a research assistant. For the given topic, generate short and effective search queries to type into a web search engine, from DIFFERENT angles (guide, comparison, news, review, tips, FAQ). Each query 2-6 words, in the requested languages. Reply ONLY as this JSON: {"queries": [{"language": "tr", "query": "..."}, ...]}`;

export function queryPrompt(topic, languages, count) {
  return `Topic: ${topic}\nLanguages: ${languages.join(', ')}\nGenerate ${count} queries in total (distribute evenly across the languages).`;
}

export function queryResponse(text, languages) {
  try {
    const j = JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
    const list = (Array.isArray(j.queries) ? j.queries : []).map((s) => ({ language: /^[a-z]{2}$/.test(s?.language) && languages.includes(s.language) ? s.language : languages[0], query: String(s?.query ?? s ?? '').trim().slice(0, 100) })).filter((s) => s.query);
    return list.length ? list : null;
  } catch {
    return null;
  }
}

/** Without a model: the topic itself and a few patterns (per language). */
export function defaultQueries(topic, languages) {
  const pattern = { tr: ['', 'nedir', 'rehber', 'nasıl yapılır', 'ipuçları', 'inceleme'], en: ['', 'guide', 'how to', 'tips', 'review', 'explained'], de: ['', 'Anleitung', 'Tipps', 'Test'], fr: ['', 'guide', 'conseils', 'avis'], es: ['', 'guía', 'consejos', 'análisis'] };
  const list = [];
  for (const language of languages) for (const suffix of pattern[language] ?? pattern.en) list.push({ language, query: `${topic} ${suffix}`.trim() });
  return list;
}

/* ── In-site crawling: link discovery and classification ─────────────── */

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|yclid|mc_cid|mc_eid|ref|source|igshid|_ga|share|replytocom)$/i;

/** URL normalisation: the fragment (#) is dropped, tracking parameters removed, a trailing / and index.* go, the host is lower case. */
export function normalizeUrl(url, base) {
  let u;
  try {
    u = new URL(url, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.pathname = u.pathname.replace(/\/index\.(html?|php)$/i, '/').replace(/\/{2,}/g, '/');
  if (u.pathname.length > 1 && u.pathname.endsWith('/') && !u.search) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}

/**
 * Adult / gambling / betting sites and their CDNs: no candidate page, site hop or media is taken from them. Measured 06.10.2026:
 * for the topic "Osmanli minyaturleri" pornhub, xhamster and casino pages were crawled from search results. The words are
 * matched as a whole domain label (sussex.ac.uk, sexton, escorial are not hit); porn / xxx / hentai / casino / bahis anywhere.
 */
const UNSUITABLE_HOST = /(^|\.)(pornhub|xhamster|xvideos|xnxx|redtube|youporn|tube8|spankbang|hqporner|tubepornstars|porntrex|eporner|beeg|chaturbate|stripchat|bongacams|cam4|livejasmin|onlyfans|fansly|phncdn|xhcdn|rdtcdn|brazzers|bet365|betway|caesars|pokerstars|1xbet|mostbet|melbet|bwin|unibet|williamhill|draftkings|fanduel)\.[a-z.]+$/i;
const UNSUITABLE_WORD = /porn|xxx|hentai|casino|bahis|camgirl|(^|[.-])(sex|escorts?|nudes?|poker|slots?|jackpot)(?=[.-]|$)/i;
export function isUnsuitable(url) {
  let h;
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return UNSUITABLE_HOST.test(h) || UNSUITABLE_WORD.test(h);
}

/**
 * A wiki address no site hop goes to: wiki project editions outside the wanted languages (the ~100 language links beside
 * an article) and Wikimedia subdomains other than Commons (developer, foundation, donate...). Measured 06.10.2026: a 12 min
 * trial crawled nl/es/ar/ckb/te/hy... Wikipedias; with the Wikipedia engine the site queue grew to 1461 sites.
 */
const WIKI_PROJECT = /^([a-z]{2,3}(?:-[a-z]+)*)\.(?:m\.)?(?:wikipedia|wiktionary|wikibooks|wikisource|wikiquote|wikivoyage|wikinews|wikiversity)\.org$/i;
export function isOtherWikiLanguage(host, languages = []) {
  const h = String(host ?? '').toLowerCase().replace(/^www\./, '');
  if (/(^|\.)wikimedia\.org$/.test(h)) return h !== 'commons.wikimedia.org';
  const m = WIKI_PROJECT.exec(h);
  return Boolean(m) && languages.length > 0 && !languages.includes(m[1]);
}

/**
 * The off-content pages of wiki software (user, talk, special, help, template namespaces and recent changes): never
 * wanted. 05.10.2026: 29 empty user pages were crawled from the mediawiki.org "recent changes" feed.
 */
export function isWikiNonContent(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {}
  // the title parameter is decoded: Wikipedia feeds give "title=%C3%96zel:SonDe%C4%9Fi..."
  const name = /^\/wiki\/([^/:]+):/.exec(path)?.[1] ?? /^([^:]+):/.exec(u.searchParams.get('title') ?? '')?.[1];
  return Boolean(name && /^(user|user_talk|talk|special|help|help_talk|template|template_talk|mediawiki|module|draft|wikipedia|wikipedia_talk|file_talk|category_talk|portal_talk|project|project_talk|kullanıcı|kullanıcı_mesaj|tartışma|özel|yardım|şablon|şablon_tartışma|vikipedi|vikipedi_tartışma|dosya_tartışma|kategori_tartışma)$/i.test(name.replace(/ /g, '_')));
}

const STATIC_PATH = /(^|\/)(about|hakk[iı]m[iı]zda|hakkinda|iletisim|iletişim|contact|privacy|gizlilik|cerez|cookie|terms|kosullar|kvkk|login|giris|register|kayit|signup|cart|sepet|checkout|account|hesap|search|ara|wp-admin|wp-login|feed|rss|sitemap|cdn-cgi|share|print|amp)(\/|$|\.)/i;
const LIST_PATH = /(^|\/)(category|categories|kategori|tag|tags|etiket|etiketler|archive|arsiv|arşiv|author|yazar|topic|topics|konu|label|section|page|sayfa|haberler|news|blog|yazilar|makaleler|articles)(\/|$)|\/page\/\d+|[?&](page|paged|sayfa|p)=\d+/i;
const TEXT_PATH = /\/\d{4}\/\d{1,2}\/|\/(haber|yazi|makale|article|post|blog|news|story|review|inceleme|rehber|guide)\/[^/]+|-\d{4,}\/?$|\/[^/]*[a-z0-9]+-[a-z0-9]+-[a-z0-9]+[^/]*\/?$|\.html?$|\/\d{5,}\/?$/i;
const MEDIA_EXTENSION = /\.(jpe?g|png|gif|webp|svg|ico|mp[34]|m4a|wav|avi|mov|mkv|webm|zip|rar|7z|exe|dmg|apk|css|js|json|xml|woff2?|ttf)(\?|$)/i;
const DOCUMENT_EXTENSION = /\.(pdf|docx|pptx|xlsx)(\?|$)/i;

/** The link class: text | list | static | doc | media | external (another site). From address patterns, not page content. */
export function linkClassify(url, siteHost) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'media';
  }
  const same = (h) => h.replace(/^www\./, '');
  if (same(u.hostname) !== same(siteHost) && !u.hostname.endsWith(`.${same(siteHost)}`)) return 'external';
  const path = u.pathname + (u.search ? `?${u.searchParams.toString()}` : '');
  if (isWikiNonContent(url)) return 'static';
  if (DOCUMENT_EXTENSION.test(u.pathname)) return 'doc';
  if (MEDIA_EXTENSION.test(u.pathname)) return 'media';
  if (STATIC_PATH.test(u.pathname)) return 'static';
  if (LIST_PATH.test(path)) return 'list';
  if (TEXT_PATH.test(u.pathname)) return 'text';
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return 'list';
  if (parts.length === 1 && parts[0].length <= 20 && !parts[0].includes('-')) return 'list'; // a section such as /teknoloji
  return 'text';
}

/** The links on the page: [{ url, text, cls }] (normalised, unique; those outside menus/footers first). */
export function pageLinks(html, baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return [];
  }
  const s = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ');
  const body = s.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const base = /<base[^>]+href\s*=\s*["']([^"']+)/i.exec(s)?.[1] ?? baseUrl;
  const seen = new Set();
  const list = [];
  for (const source of [body, s]) {
    for (const m of source.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
      const raw = decodeEntities(m[1] ?? m[2] ?? '').trim();
      if (!raw || /^(mailto:|tel:|javascript:|#)/i.test(raw)) continue;
      const url = normalizeUrl(raw, base);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      list.push({ url, text: untagged(m[3]).slice(0, 120), cls: linkClassify(url, host) });
    }
  }
  return list;
}

/** The page type (from the content): text | list. Article JSON-LD / og:type=article / enough paragraphs -> text. */
export function pageType(html, blocks) {
  const s = String(html ?? '');
  if (/"@type"\s*:\s*"(Article|NewsArticle|BlogPosting|TechArticle)"/.test(s) || /property="og:type"[^>]+content="article"/i.test(s) || /content="article"[^>]+property="og:type"/i.test(s)) return 'text';
  const paragraph = blocks.filter((b) => b.type === 'p' && countWords(b.text) >= 25).length;
  return paragraph >= 4 ? 'text' : 'list';
}

/** The article's category: section (meta/JSON-LD) > breadcrumb > the address's first folder (unless a date/number). */
export function findCategory(url, { section = null, html = '' } = {}) {
  if (section) return String(section).slice(0, 60);
  const crumb = [...String(html).matchAll(/"@type"\s*:\s*"ListItem"[\s\S]{0,300}?"name"\s*:\s*"([^"]{2,60})"/g)].map((m) => m[1]);
  if (crumb.length >= 2) return crumb[crumb.length - 2]; // the last one is the article itself
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const first = parts.length >= 2 ? parts[0] : ''; // a one-part path is the article itself, not a category
    if (first && !/^\d+$/.test(first) && first.length <= 30 && !/\.(html?|php)$/.test(first) && !/^(haber|yazi|makale|article|post|blog|news|p|a|tr|en|de|fr|es)$/i.test(first)) return decodeURIComponent(first).replace(/[-_]+/g, ' ');
  } catch {}
  return null;
}

/* ── Media: video and audio ───────────────────────────────────────────── */

const properties = (s) => Object.fromEntries([...String(s).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)].map((a) => [a[1].toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')]));
// http/https only: <video src="blob:..."> (wikiwand) got into the download queue and rested the "empty site" for 10 min
const absolute = (u, base) => {
  try {
    const a = new URL(u, base);
    return /^https?:$/.test(a.protocol) ? a.href : null;
  } catch {
    return null;
  }
};

/** The videos on the page: <video>/<source>, og:video, YouTube/Vimeo embeds, JSON-LD VideoObject. */
export function contentVideos(html, base = 'http://x/') {
  const s = String(html ?? '');
  const list = [];
  const add = (v) => {
    if (v.url && !list.some((x) => x.url === v.url)) list.push({ url: v.url, title: (v.title ?? '').slice(0, 200), description: (v.description ?? '').slice(0, 1000), durationSec: v.durationSec ?? null, thumbnail: v.thumbnail ?? null, sourceType: v.sourceType, direct: Boolean(v.direct) });
  };
  for (const n of jsonLdObjects(s)) {
    if (![n['@type']].flat().some((t) => /VideoObject/.test(String(t)))) continue;
    const duration = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(n.duration ?? ''));
    add({ url: absolute(n.contentUrl ?? n.embedUrl ?? '', base), title: name_(n.name), description: name_(n.description), durationSec: duration ? Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0) : null, thumbnail: absolute([n.thumbnailUrl].flat()[0] ?? '', base), sourceType: 'json-ld', direct: Boolean(n.contentUrl) && /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(String(n.contentUrl)) });
  }
  const meta = metaTags(s);
  if (meta['og:video'] || meta['og:video:url'] || meta['og:video:secure_url']) add({ url: absolute(meta['og:video:secure_url'] ?? meta['og:video:url'] ?? meta['og:video'], base), title: meta['og:title'], description: meta['og:description'], thumbnail: meta['og:image'] ?? null, sourceType: 'open-graph', direct: /\.(mp4|webm|mov)(\?|$)/i.test(meta['og:video:secure_url'] ?? meta['og:video:url'] ?? meta['og:video'] ?? '') });
  for (const m of s.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>|<video\b([^>]*)\/?>/gi)) {
    const attrs = properties(m[1] ?? m[3] ?? '');
    const sources = [attrs.src, ...[...(m[2] ?? '').matchAll(/<source\b([^>]*)>/gi)].map((k) => properties(k[1]).src)].filter(Boolean);
    for (const k of sources) add({ url: absolute(k, base), title: attrs.title ?? attrs['aria-label'] ?? '', thumbnail: attrs.poster ? absolute(attrs.poster, base) : null, sourceType: 'video-tag', direct: true });
  }
  for (const m of s.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const u = decodeEntities(m[1]);
    if (/youtube(-nocookie)?\.com\/embed\/|youtu\.be\/|player\.vimeo\.com\/video\/|dailymotion\.com\/embed/i.test(u)) add({ url: absolute(u, base), title: properties(m[0]).title ?? '', sourceType: 'embed', direct: false });
  }
  return list.slice(0, 20);
}

/** The audio on the page: <audio>/<source>, JSON-LD AudioObject/PodcastEpisode. */
export function contentAudio(html, base = 'http://x/') {
  const s = String(html ?? '');
  const list = [];
  const add = (v) => {
    if (v.url && !list.some((x) => x.url === v.url)) list.push({ url: v.url, title: (v.title ?? '').slice(0, 200), description: (v.description ?? '').slice(0, 1000), durationSec: v.durationSec ?? null, sourceType: v.sourceType });
  };
  for (const n of jsonLdObjects(s)) {
    if (![n['@type']].flat().some((t) => /AudioObject|PodcastEpisode|MusicRecording/.test(String(t)))) continue;
    const inner = n.associatedMedia ?? n.audio ?? n;
    const duration = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(inner.duration ?? n.duration ?? ''));
    add({ url: absolute(inner.contentUrl ?? n.contentUrl ?? '', base), title: name_(n.name), description: name_(n.description), durationSec: duration ? Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0) : null, sourceType: 'json-ld' });
  }
  for (const m of s.matchAll(/<audio\b([^>]*)>([\s\S]*?)<\/audio>|<audio\b([^>]*)\/?>/gi)) {
    const attrs = properties(m[1] ?? m[3] ?? '');
    const sources = [attrs.src, ...[...(m[2] ?? '').matchAll(/<source\b([^>]*)>/gi)].map((k) => properties(k[1]).src)].filter(Boolean);
    for (const k of sources) add({ url: absolute(k, base), title: attrs.title ?? '', sourceType: 'audio-tag' });
  }
  return list.slice(0, 20);
}

/* ── Quality rules (Gopher/C4 style) and personal data masking ────────── */

/** The text quality rule: the reason when there is a problem, otherwise null. (The word count threshold is the caller's.) */
export function qualityRule(text) {
  const s = String(text ?? '');
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 20) return 'short';
  const letter = (s.match(/\p{L}/gu) ?? []).length;
  if (letter / Math.max(1, s.replace(/\s/g, '').length) < 0.6) return 'letter-ratio';
  const avgLength = words.reduce((t, k) => t + k.length, 0) / words.length;
  if (avgLength < 2.5 || avgLength > 12) return 'word-len';
  const symbols = (s.match(/[#|{}<>\\^~]|\.{3}|…/g) ?? []).length;
  if (symbols / words.length > 0.1) return 'symbols';
  const lines = s.split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length >= 5) {
    // Short item lines (menus, tag clouds); long numbered paragraphs do not count as items
    const item = lines.filter((x) => /^([-•*]|\d+\.)\s/.test(x) && countWords(x) < 10).length;
    if (item / lines.length > 0.9) return 'item-list';
    const single = new Set(lines.map((x) => x.toLowerCase())).size;
    if (1 - single / lines.length > 0.3) return 'repeat';
  }
  if (/lorem ipsum/i.test(s)) return 'lorem';
  const upper = (s.match(/\p{Lu}/gu) ?? []).length;
  if (upper / Math.max(1, letter) > 0.5) return 'uppercase-ratio';
  return null;
}

/** Replaces e-mail addresses, phone, IBAN and Turkish ID numbers with placeholders (so no personal data enters training data). */
export function maskPersonalData(text) {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\bTR\d{2}(?:[ -]?\d{4}){5}[ -]?\d{2}\b/gi, '[iban]')
    .replace(/(?<!\d)(?:\+?90[\s-]?)?\(?0?5\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g, '[phone]')
    .replace(/(?<!\d)\+\d{1,3}[\s-]?\(?\d{2,4}\)?(?:[\s-]?\d{2,4}){2,4}(?!\d)/g, '[phone]')
    .replace(/(?<!\d)[1-9]\d{10}(?!\d)/g, (m) => (validTurkishId(m) ? '[id-number]' : m));
}

function validTurkishId(s) {
  const d = [...s].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  return (odd * 7 - even) % 10 === d[9] && (d.slice(0, 10).reduce((a, b) => a + b, 0)) % 10 === d[10];
}

/* ── Common Crawl ─────────────────────────────────────────────────────── */

/** A CDX index reply (JSON lines) -> [{ url, file, start, len, time, languages }] (the newest of the same address). */
export function ccRecords(text) {
  const result = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!j.url || !j.filename || String(j.status ?? '200') !== '200') continue;
    const u = normalizeUrl(j.url);
    if (!u) continue;
    const previous = result.get(u);
    if (!previous || String(j.timestamp) > previous.time) result.set(u, { url: u, file: j.filename, start: Number(j.offset), len: Number(j.length), time: String(j.timestamp ?? ''), languages: String(j.languages ?? '') });
  }
  return [...result.values()].sort((a, b) => b.time.localeCompare(a.time));
}

/** A WARC response record (gunzipped) -> { type, body } (the HTTP response's body). */
export function warcBody(buf) {
  const s = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const first = s.indexOf('\r\n\r\n');
  if (first < 0) return null;
  const second = s.indexOf('\r\n\r\n', first + 4);
  if (second < 0) return null;
  const http = s.toString('latin1', first + 4, second);
  const type = /content-type:\s*([^\r\n]+)/i.exec(http)?.[1]?.trim() ?? '';
  const body = s.subarray(second + 4);
  const characterSet = /charset=([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1] ?? 'utf-8';
  let text;
  try {
    text = new TextDecoder(characterSet).decode(body);
  } catch {
    text = body.toString('utf8');
  }
  return { type, body: text };
}

/* ── Private network addresses (SSRF) ─────────────────────────────────── */

/** Whether the address is loopback, private, link-local, CGNAT (Tailscale 100.64/10), multicast or unspecified. */
export function isPrivateIp(ip) {
  let a = String(ip ?? '').toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a.includes(':')) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff');
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
}

/* ── WordPress REST API ───────────────────────────────────────────────── */

/** The WordPress post list address (content, excerpt, Yoast meta, categories/tags, author in one request). */
export function wpPostsUrl(apiRoot, page, count = 50) {
  const root = String(apiRoot).replace(/\/+$/, '');
  return `${root}/wp/v2/posts?per_page=${count}&page=${page}&orderby=date&order=desc&_embed=1`;
}

/** Records from a WordPress reply: { url, title, contentHtml, summary, dateText, modified, author, tags, section, metaTitle, metaDescription, language }. */
export function wpPosts(json) {
  const list = Array.isArray(json) ? json : [];
  return list.filter((y) => y && y.link && y.content?.rendered).map((y) => {
    const yoast = y.yoast_head_json ?? {};
    const terms = (y._embedded?.['wp:term'] ?? []).flat().filter(Boolean);
    return {
      url: y.link,
      title: untagged(y.title?.rendered ?? ''),
      contentHtml: y.content.rendered,
      summary: untagged(y.excerpt?.rendered ?? '').slice(0, 600),
      dateText: y.date_gmt ? `${y.date_gmt}Z` : y.date ?? null,
      modified: y.modified_gmt ? `${y.modified_gmt}Z` : null,
      author: y._embedded?.author?.[0]?.name ?? null,
      tags: terms.filter((t) => t.taxonomy === 'post_tag').map((t) => untagged(t.name)).slice(0, 20),
      section: terms.find((t) => t.taxonomy === 'category')?.name ? untagged(terms.find((t) => t.taxonomy === 'category').name) : null,
      metaTitle: String(yoast.title ?? y.rank_math_title ?? '').slice(0, 300),
      metaDescription: String(yoast.description ?? y.rank_math_description ?? '').slice(0, 600),
      language: LANGUAGE_CODE(yoast.og_locale) ?? LANGUAGE_CODE(y.lang) ?? null,
    };
  });
}

/* ── Local model: extraction ───────────────────────────────────────────── */

// Classification values (the model picks from these lists; stored in lower case in the record and the classification training file)
export const CATEGORIES = ['technology', 'gaming', 'science', 'health', 'economy', 'finance', 'education', 'sports', 'culture-arts', 'travel', 'food', 'lifestyle', 'fashion-beauty', 'automotive', 'real-estate', 'law', 'politics', 'world', 'software', 'ai', 'business-career', 'parenting', 'home-garden', 'environment', 'history', 'religion-philosophy', 'entertainment', 'shopping', 'other'];
export const CONTENT_TYPES = ['news', 'guide', 'review', 'list', 'opinion', 'academic', 'product', 'announcement', 'interview', 'question-answer', 'spec', 'biography', 'other'];

export const EXTRACTION_SYSTEM = `You will be given NUMBERED text blocks extracted from a web page. Your task is to select the MAIN content of the page (article, news, guide) and label the content.
- Give the numbers of the blocks belonging to the main content as ranges: [[start, end], ...]. Do NOT INCLUDE menus, ads, "related posts", comments, cookie/subscription notices, author bio, share buttons, footer.
- If the page is not an article (list/archive/product/login page, empty or junk) article=false.
- quality: 1 (junk/repeat/machine translation/ads only) … 3 (ordinary news) … 5 (original, detailed, informative, well written).
- accuracy: 1 (baseless/clickbait/contradictory claims) … 3 (unsourced but plausible) … 5 (sourced, dated, concrete data, expert/institution attribution). If unsure, 3.
- language: ISO 639-1 (tr, en, de…). topic: a 1-4 word topic label (like a game/product name).
- category: one of: ${CATEGORIES.join(', ')}. contentType: one of: ${CONTENT_TYPES.join(', ')}.
- tags: 3-8 short keywords (in the language of the content). summary: one sentence in the language of the content.
- If a TARGET TOPIC is given, topicFit: 1 (unrelated) … 5 (exactly that topic).
Reply ONLY as this JSON: {"article": true|false, "title": "...", "language": "..", "topic": "...", "category": "...", "contentType": "...", "tags": ["..."], "summary": "...", "quality": 1-5, "accuracy": 1-5, "topicFit": 1-5, "blocks": [[a,b],...]}`;

/** The model prompt: the blocks numbered and shortened (long blocks at 400 characters, ~24 thousand characters in all). */
export function extractionPrompt(blocks, title, soughtTopic = '') {
  const lines = [];
  let total = 0;
  for (const [i, b] of blocks.entries()) {
    const text = b.text.length > 400 ? `${b.text.slice(0, 400)}…` : b.text;
    const line = `[${i}] ${/^h/.test(b.type) ? `(${b.type}) ` : ''}${text}`;
    if (total + line.length > 24000) break;
    lines.push(line);
    total += line.length;
  }
  return `${soughtTopic ? `TARGET TOPIC: ${soughtTopic}\n` : ''}Page title: ${title}\n\n${lines.join('\n')}`;
}

/** The model reply -> the selected blocks and the details (null when invalid). */
export function extractionResponse(text, blocks) {
  let j;
  try {
    j = JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  } catch {
    return null;
  }
  const ranges = Array.isArray(j.blocks) ? j.blocks : [];
  const picked = new Set();
  for (const a of ranges) {
    const [b, s] = Array.isArray(a) ? a : [a, a];
    for (let i = Math.max(0, Number(b) || 0); i <= Math.min(blocks.length - 1, Number(s) || 0); i++) picked.add(i);
  }
  const score = (v) => (v === undefined || v === null || v === '' ? null : Math.max(1, Math.min(5, Math.round(Number(v) || 0) || 1)));
  const lower = (v) => String(v ?? '').trim().toLowerCase();
  return {
    article: j.article !== false,
    title: String(j.title ?? '').slice(0, 300),
    language: /^[a-z]{2}$/.test(j.language) ? j.language : null,
    topic: String(j.topic ?? '').slice(0, 80),
    category: CATEGORIES.includes(lower(j.category)) ? lower(j.category) : null,
    contentType: CONTENT_TYPES.includes(lower(j.contentType)) ? lower(j.contentType) : null,
    tags: (Array.isArray(j.tags) ? j.tags : String(j.tags ?? '').split(',')).map((e) => String(e).trim().slice(0, 40)).filter(Boolean).slice(0, 8),
    summary: String(j.summary ?? '').trim().slice(0, 400) || null,
    quality: score(j.quality) ?? 1,
    accuracy: score(j.accuracy),
    topicFit: score(j.topicFit),
    blocks: blocks.filter((_, i) => picked.has(i)),
  };
}

// ı/i are folded: Turkish lower case turns "ISLAMIC" into "ıslamic", which would not match "islamic"
const foldLower = (s) => String(s).toLocaleLowerCase('tr').replaceAll('ı', 'i');
// Stem: the first 6 letters ("minyatürleri" matches "minyatür" in the text; Turkish suffixes)
const keyWords = (s) => [...new Set(foldLower(s).split(/[^\p{L}\p{N}]+/u).filter((k) => k.length > 2).map((k) => k.slice(0, 6)))];

/** The topic fit rule (without a model): the share of topic words found in the text -> 1-5. */
export function topicFitRule(topic, text) {
  const keys = keyWords(topic);
  if (!keys.length) return 5;
  const m = foldLower(text);
  const ratio = keys.filter((k) => m.includes(k)).length / keys.length;
  return ratio >= 0.8 ? 5 : ratio >= 0.6 ? 4 : ratio >= 0.4 ? 3 : ratio > 0 ? 2 : 1;
}

/**
 * The rule fit (without a model), focused: the topic words must be either in the title + lead (the first 300 words) or
 * spread through the text (each at least twice and once every 1500 words). Measured 06.10.2026, 80 real articles in rule
 * mode ("Osmanlı minyatürleri"): one mention anywhere was enough, long articles such as "Anıtkabir", "Kur'an", "Galata
 * Kulesi" got in too (80 of 80). The focused measure kept 32; most of the 48 left out were off topic, a few borderline (English "Hünername").
 */
export function topicFitFocused(topic, title, text) {
  const keys = keyWords(topic);
  if (!keys.length) return 5;
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lead = topicFitRule(topic, `${title ?? ''}\n${words.slice(0, 300).join(' ')}`);
  const m = foldLower(text);
  const required = Math.max(2, Math.ceil(words.length / 1500));
  const ratio = keys.filter((k) => m.split(k).length - 1 >= required).length / keys.length;
  return Math.max(lead, ratio >= 0.8 ? 5 : ratio >= 0.6 ? 4 : ratio >= 0.4 ? 3 : ratio > 0 ? 2 : 1);
}

/**
 * The search candidate prefilter (the drift signature): a result of a topic-bound query (one holding a topic word) is not
 * crawled when it holds none of the topic's words and only part (under 40%) of the query. Measured 06.10.2026: Bing drifts to
 * the off-topic word in long Turkish queries ("Ünlü Osmanlı minyatür sanatçıları" -> 9-10 of 10 results "ünlü" gossip / stocks).
 * Not judged: a result sharing no word with the query (the engine may have matched by meaning; Google News: "Matrakçı
 * Nasuh'un üç kıtada yolculuğu"), a query not bound to the topic (another language, synonyms: which word is off topic cannot
 * be known; "Ottoman miniature painting" results), a title + summary under 3 words. Operators such as site: do not count.
 */
export function isOffTopicResult(topic, query, title, summary) {
  const text = `${title ?? ''}\n${summary ?? ''}`;
  if (!topic || (text.match(/[\p{L}\p{N}]+/gu) ?? []).length < 3) return false;
  if (topicFitRule(topic, text) > 1) return false;
  const queryWords = String(query ?? '').replace(/\S+:\S+/g, ' ');
  const topicKeys = keyWords(topic);
  const topicBound = keyWords(queryWords).some((q) => topicKeys.some((k) => q.startsWith(k) || k.startsWith(q)));
  return topicBound && topicFitRule(queryWords, text) === 2;
}

/* ── Training files ───────────────────────────────────────────────────── */

const LANGUAGE_NAME = { tr: 'Turkish', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', ar: 'Arabic', pl: 'Polish', id: 'Indonesian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', el: 'Greek', he: 'Hebrew', th: 'Thai' };
export const languageName = (d) => LANGUAGE_NAME[d] ?? d;
const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

/* ── Media captions ───────────────────────────────────────────────────── */

const VOID_ELEMENTS = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'wbr', 'source', 'area', 'col', 'embed', 'param', 'track']);

/**
 * HTML -> the visible plain text: hidden elements (display:none; on Commons the Wikidata 'label QS:Len,"..."' lines) and
 * language labels (<span class="language en"><b>İngilizce:</b></span>) are dropped with their content; tags become spaces.
 */
export function visibleText(html) {
  const s = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
  const stack = [];
  let hidden = -1; // the hidden element's place in the stack (-1: visible)
  let output = '';
  let last = 0;
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    if (hidden < 0) output += `${s.slice(last, m.index)} `;
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.lastIndexOf(name);
      if (i < 0) continue;
      stack.length = i;
      if (hidden >= i) hidden = -1;
      continue;
    }
    if (VOID_ELEMENTS.has(name) || /\/\s*$/.test(m[3])) continue;
    if (hidden < 0 && (/\bstyle\s*=\s*["'][^"']*display\s*:\s*none/i.test(m[3]) || /\bclass\s*=\s*["'](?:[^"']*\s)?language(?:\s[^"']*)?["']/i.test(m[3]))) hidden = stack.length;
    stack.push(name);
  }
  if (hidden < 0) output += s.slice(last);
  return decodeEntities(output).replace(/\s+/g, ' ').trim();
}

// A licence / permission sentence (noise in a training caption; the licence has its own field in the record)
const LICENSE_SENTENCE = /public domain|creative commons|\bcc[- ]?(by|0)\b|\bgfdl\b|licen[cs]e|copyright|©|all rights reserved|\bown work\b|photography (was|is) permitted|kamu malı|telif hakk/i;
// A leading language label ("İngilizce: ...", "English: ..."; Commons writes the Turkish name in its Turkish interface, the English
// one in English; in old records the hidden label got into the text)
const LANGUAGE_TAG = new RegExp(`(^|[.!?]\\s+)(${[...Object.values(LANGUAGE_NAME), 'Persian', 'Ottoman Turkish', 'Hungarian', 'İngilizce', 'Türkçe', 'Almanca', 'Fransızca', 'İspanyolca', 'İtalyanca', 'Portekizce', 'Felemenkçe', 'Rusça', 'Arapça', 'Farsça', 'Osmanlıca', 'Osmanlı Türkçesi', 'Macarca', 'Lehçe', 'Endonezce', 'Japonca', 'Korece', 'Çince', 'Yunanca', 'İbranice', 'Tayca'].join('|')})\\s*:\\s+`, 'g');
// A part made only of these words carries no information ("Dosya 1", "IMG 2034", "Untitled")
const GENERIC_NAME = /^(file|dosya|image|img|photo|foto|fotoğraf|picture|pic|resim|görsel|gorsel|scan|untitled|adsız|video|audio|ses|clip|klip|track|parça)$/i;
// Frequent words that add no information (not counted when comparing the title and the description)
const FILLER_WORDS = new Set('with from this that which there their have been were also into over under about after before during between such than then them they these those için ile olan gibi daha veya ancak kadar sonra önce üzerinde arasında'.split(' '));

/**
 * Training caption cleanup: Wikidata QuickStatements leftovers, addresses, camera file names (DSC04222), underscores,
 * language labels and licence / permission sentences are dropped. May come back empty.
 */
export function cleanCaption(text) {
  // The QS leftover (old records: hidden elements got into the text, nested quotes) comes after the visible text: cut there
  const s = String(text ?? '')
    .split(/\b(?:label|title|description) QS:/)[0]
    .replace(/https?:\/\/[^\s()<>"'[\]]+/gi, ' ')
    .replace(/\b(DSC[NF]?|IMG|PICT|_MG)[_-]?\d{3,}\b/gi, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\S+$/, (t) => (t.split('-').length >= 3 ? t.replace(/-/g, ' ') : t)) // a file name: "1895-lumiere-une-partie"
    .replace(LANGUAGE_TAG, '$1');
  return s.split(/(?<=[.!?])\s+/).filter((c) => !LICENSE_SENTENCE.test(c)).join(' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
}

/**
 * A media caption: the title (file name / alt text) and the description (description / figcaption) are cleaned. The
 * description leads; the title gets in only when it adds at least 3 new words: both when the description adds some too,
 * otherwise (only a place, such as "X Muzesinde sergi") the title. A part made only of generic names ("Dosya 1") does not count. At most 500.
 */
export function mergeCaptions(title, description) {
  const plain = (s) => s.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const valid = (s) => {
    const words = plain(s).split(' ').filter((k) => /\p{L}/u.test(k));
    return words.length > 0 && !words.every((k) => GENERIC_NAME.test(k));
  };
  const newWord = (x, y) => {
    const ys = new Set(plain(y).split(' '));
    return plain(x).split(' ').filter((k) => k.length >= 4 && /\p{L}/u.test(k) && !ys.has(k) && !FILLER_WORDS.has(k)).length;
  };
  const b = valid(cleanCaption(title)) ? cleanCaption(title) : '';
  const a = valid(cleanCaption(description)) ? cleanCaption(description) : '';
  let selected = a || b;
  if (a && b && !plain(a).includes(plain(b))) {
    if (plain(b).includes(plain(a))) selected = b;
    else if (newWord(b, a) >= 3) selected = newWord(a, b) >= 3 ? `${b.replace(/[.,;:]$/, '')}. ${a}` : b;
  }
  return selected.slice(0, 500).trim();
}

/**
 * Ready-to-train chat examples (messages) from the collected records. Returns the arrays { meta, translation, write, summary, title, question }.
 *  - meta       : content -> SEO meta title (<=60) + meta description (120-165) (when the site has its own meta)
 *  - translation: the articles of one group (hreflang) in two languages -> a translation pair (both ways)
 *  - write      : title + topic/tags -> a Markdown article (only quality >= 4, or unrated but >= 700 words)
 *  - summary    : content -> a 1-2 sentence summary (the site's description / excerpt)
 *  - title      : content (without its title) -> title
 *  - question   : FAQ / HowTo question-answer pairs (in the page's context)
 */
export function trainingExamples(records) {
  const meta = [];
  const translation = [];
  const write = [];
  const summary = [];
  const title = [];
  const question = [];
  const systemMeta = 'You are an SEO expert. For the given article, produce a meta title that will get clicks in search results (at most 60 characters) and a meta description (120-165 characters, in the language of the article, ending with a period). Reply ONLY as JSON: {"meta_title": "...", "meta_description": "..."}';
  for (const k of records) {
    const mb = String(k.metaTitle ?? '').replace(/\s*[|–-]\s*[^|–-]{2,40}$/, '').trim();
    const ma = String(k.metaDescription ?? '').trim();
    const bodyless = String(k.text ?? '').replace(/^# [^\n]*\n+/, '');
    if (mb && mb.length <= 60 && ma.length >= 90 && ma.length <= 200 && k.words >= 200) {
      meta.push({ messages: [{ role: 'system', content: systemMeta }, { role: 'user', content: `Language: ${languageName(k.language)}\nTitle: ${k.title}\n\n${truncate(k.text, 6000)}` }, { role: 'assistant', content: JSON.stringify({ meta_title: mb, meta_description: ma }) }], source: k.url });
    }
    if (ma.length >= 60 && ma.length <= 400 && k.words >= 200 && !/\.\.\.$|…$/.test(ma)) {
      summary.push({ messages: [{ role: 'system', content: `Summarize the given article in ${languageName(k.language)} in 1-2 sentences, in a way that informs the reader.` }, { role: 'user', content: truncate(k.text, 8000) }, { role: 'assistant', content: ma }], source: k.url });
    }
    if (k.title && k.title.length >= 15 && k.title.length <= 120 && k.words >= 200) {
      title.push({ messages: [{ role: 'system', content: `Write an engaging title in ${languageName(k.language)} for the given article that accurately reflects its content. Give only the title.` }, { role: 'user', content: truncate(bodyless, 8000) }, { role: 'assistant', content: k.title }], source: k.url });
    }
    if ((k.quality ?? 0) >= 4 || (k.quality == null && k.words >= 700)) {
      const hints = [k.section ? `Category: ${k.section}` : '', k.tags?.length ? `Tags: ${k.tags.slice(0, 8).join(', ')}` : '', k.topic ? `Topic: ${k.topic}` : ''].filter(Boolean).join('\n');
      write.push({ messages: [{ role: 'system', content: `You are an experienced ${languageName(k.language)} content writer. For the given title, write a fluent, informative and original article with subheadings (Markdown ##).` }, { role: 'user', content: `Title: ${k.title}${hints ? `\n${hints}` : ''}` }, { role: 'assistant', content: truncate(k.text, 12000) }], source: k.url });
    }
    for (const sc of k.questionAnswers ?? []) {
      question.push({ messages: [{ role: 'system', content: `Answer accurately and clearly in ${languageName(k.language)}.${k.title ? ` Context: "${k.title}".` : ''}` }, { role: 'user', content: sc.question }, { role: 'assistant', content: sc.answer }], source: k.url });
    }
  }
  const groups = new Map();
  for (const k of records) if (k.group && k.language) groups.set(k.group, [...(groups.get(k.group) ?? []), k]);
  for (const members of groups.values()) {
    for (const a of members) for (const b of members) {
      if (a === b || a.language === b.language || a.words < 150 || b.words < 150) continue;
      const ratio = a.words / b.words;
      if (ratio < 0.5 || ratio > 2) continue; // a summary/abridgement, not a translation
      translation.push({ messages: [{ role: 'system', content: `You are a professional translator. Translate the given ${languageName(a.language)} article into ${languageName(b.language)}; keep the Markdown structure (headings, lists) and the meaning, and write naturally.` }, { role: 'user', content: truncate(a.text, 12000) }, { role: 'assistant', content: truncate(b.text, 12000) }], source: `${a.url} -> ${b.url}` });
    }
  }
  return { meta, translation, write, summary, title, question };
}
