/**
 * Veri toplama: yardimcilar (besleme, OPML, site haritasi, robots.txt, ust veri, HTML bloklari, Markdown, simhash,
 * dil tahmini, link siniflama, arama sonuclari, kalite kurallari, kisisel veri, belgeler, Common Crawl kayitlari)
 * ve is akisi: sahte site (robots yasagi, tekrar metin, menu/reklam, hreflang ceviri esleri, JSON-LD/SSS, WordPress
 * API, site ici gezinme, PDF, 429 sonrasi devam, medya meta), konu kipi (sahte arama motoru), egitim dosyalari,
 * sahte yazi modeliyle etiketleme, duraklatma.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  normalizeUrl, searchUrl, searchResults, extractionResponse, documentType, feedItems, blockText, ccRecords, detectLanguage, trainingExamples, hammingDistance, htmlBlocks,
  contentImages, contentAudio, contentVideos, qualityRule, findCategory, maskPersonalData, ruleExtract, linkClassify, opmlFeeds, isPrivateIp, robotsRules, pageLinks, pageMetadata,
  simhash, sitemap, questionAnswers, warcBody, wpPosts,
} from '../lib/data-collection.mjs';
import { docxText, pdfText, xlsxText, zipInputs } from '../lib/read-document.mjs';
import { LocalLlm } from '../lib/llm.mjs';
import { createPanel } from './env.mjs';

test('data collection helpers: feed, OPML, sitemap, robots.txt, HTML blocks, model response', () => {
  const rss = '<?xml version="1.0"?><rss><channel><item><title><![CDATA[Bir &amp; iki]]></title><link>https://a.com/x</link><pubDate>Mon, 05 Oct 2026</pubDate><enclosure url="https://a.com/b.mp3" type="audio/mpeg" length="1000"/><itunes:duration>01:02:03</itunes:duration></item><item><title>Y</title><guid>https://a.com/y</guid></item></channel></rss>';
  assert.equal(documentType(rss), 'rss');
  const items = feedItems(rss);
  assert.deepEqual(items.map((o) => [o.link, o.title]), [['https://a.com/x', 'Bir & iki'], ['https://a.com/y', 'Y']]);
  assert.deepEqual(items[0].attachments, [{ url: 'https://a.com/b.mp3', type: 'audio/mpeg', byte: 1000, durationSec: 3723 }], 'podcast enclosure and duration');
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Z</title><link href="https://a.com/z"/></entry></feed>';
  assert.equal(documentType(atom), 'atom');
  assert.equal(feedItems(atom)[0].link, 'https://a.com/z');
  const opml = '<?xml version="1.0"?><opml version="2.0"><body><outline text="A" type="rss" xmlUrl="https://a.com/feed" htmlUrl="https://a.com"/><outline text="B"><outline type="rss" xmlUrl="https://b.com/rss.xml"/></outline></body></opml>';
  assert.equal(documentType(opml), 'opml');
  assert.deepEqual(opmlFeeds(opml), ['https://a.com/feed', 'https://b.com/rss.xml']);
  const map = '<urlset><url><loc>https://a.com/eski</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://a.com/yeni</loc><lastmod>2026-10-01</lastmod></url></urlset>';
  assert.equal(documentType(map), 'site-map');
  assert.deepEqual(sitemap(map).map((k) => k.loc), ['https://a.com/yeni', 'https://a.com/eski'], 'newest first');
  assert.equal(documentType('<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>'), 'site-map-directory');
  const r = robotsRules('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /hidden\nAllow: /hidden/isOpen\nDisallow: /*.pdf$\nCrawl-delay: 3\nSitemap: https://a.com/sitemap.xml');
  assert.equal(r.allowed('/text'), true);
  assert.equal(r.allowed('/hidden/a'), false);
  assert.equal(r.allowed('/hidden/isOpen/b'), true, 'longer Allow wins');
  assert.equal(r.allowed('/dosya.pdf'), false);
  assert.equal(r.delay, 3);
  assert.deepEqual(r.siteMaps, ['https://a.com/sitemap.xml']);
  const h = htmlBlocks('<html lang="tr"><head><title>Başlık | Site</title><script>x()</script></head><body><nav><a>Menü bağlantısı bir iki üç</a></nav><article><h2>Alt başlık</h2><p>Bu birinci paragraf yeterince uzun bir cümledir.</p><p>Bu birinci paragraf yeterince uzun bir cümledir.</p><p>Kısa</p><p><a href="/a">İlgili yazı bir</a> <a href="/b">ilgili yazı iki üç</a></p><ol><li>Birinci adım burada anlatılıyor uzunca</li><li>İkinci adım burada anlatılıyor uzunca</li></ol><pre>kod satırı</pre></article><footer><p>Telif hakkı alt bilgi metni burada duruyor</p></footer></body></html>');
  assert.equal(h.language, 'tr');
  assert.equal(h.title, 'Başlık | Site');
  assert.deepEqual(h.blocks.map((b) => b.type), ['h2', 'p', 'oli', 'oli', 'pre'], 'menu, footer, duplicate, short and link-heavy paragraphs were dropped; numbered list and code remained');
  assert.match(blockText(h.blocks), /^## Alt başlık\n\nBu birinci[^\n]+\n\n1\. Birinci adım[^\n]+\n2\. İkinci adım[^\n]+\n\n```\nkod satırı\n```$/);
  const y = extractionResponse('```json\n{"article": true, "language": "tr", "quality": 7, "accuracy": 4, "category": "Technology", "contentType": "guide", "tags": ["a","b"], "summary": "Tek cümle.", "blocks": [[1, 2], 0]}\n```', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]);
  assert.deepEqual(y.blocks.map((b) => b.text), ['a', 'b', 'c']);
  assert.deepEqual([y.quality, y.accuracy, y.category, y.contentType, y.tags, y.summary], [5, 4, 'technology', 'guide', ['a', 'b'], 'Tek cümle.'], 'quality is clamped to 1-5, category lowercased');
  assert.equal(extractionResponse('broken', []), null);
  // Kural ayıklama: en yoğun bölge (baştaki tek uzun paragraf + sondaki alt bilgi değil, ortadaki gövde)
  const p = (n) => ({ type: 'p', text: Array.from({ length: n }, (_, i) => `kelime${i}`).join(' ') });
  const choice = ruleExtract([p(14), { type: 'p', text: 'kısa menü' }, { type: 'p', text: 'başka kısa' }, { type: 'p', text: 'üçüncü kısa' }, { type: 'h2', text: 'Body' }, p(60), p(70), { type: 'li', text: 'madde kısa' }, p(50), { type: 'p', text: 'alt bilgi' }, p(13)]);
  assert.deepEqual(choice.map((b) => b.type), ['h2', 'p', 'p', 'li', 'p'], 'body region and the short item inside it');
});

test('page metadata, FAQ, images/videos, link classification, search results, language, simhash, quality, personal data, Common Crawl', () => {
  // MediaWiki: baslik h1 (JSON-LD headline Wikidata aciklamasi; gercek Vikipedi sayfasinda yanlis baslik aliniyordu, 06.10.2026)
  const wiki = '<html><head><meta name="generator" content="MediaWiki 1.46.0-wmf.3"><meta property="og:title" content="Osmanlı minyatürü - Vikipedi"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","name":"Osmanlı minyatürü","headline":"Genellikle Osmanlı\'da saray kültürünü yansıtan eski Osmanlı resim sanatı"}</script></head><body><h1 id="firstHeading"><span>Osmanlı minyatürü</span></h1></body></html>';
  assert.equal(pageMetadata(wiki, 'https://tr.wikipedia.org/wiki/Osmanl%C4%B1_minyat%C3%BCr%C3%BC').title, 'Osmanlı minyatürü');
  assert.equal(pageMetadata(wiki.replace('MediaWiki 1.46.0-wmf.3', 'WordPress 6.8'), 'https://a.com/x').title, "Genellikle Osmanlı'da saray kültürünü yansıtan eski Osmanlı resim sanatı", 'JSON-LD title first when not MediaWiki');
  const html = `<html lang="en-US"><head><title>Best Laptops 2026 | TechSite</title><link rel="canonical" href="https://tech.example/best-laptops"><link rel="alternate" hreflang="tr" href="https://tech.example/tr/en-iyi-laptoplar"><link rel="alternate" hreflang="x-default" href="https://tech.example/best-laptops"><link rel="alternate" type="application/rss+xml" href="/feed/"><link rel="https://api.w.org/" href="https://tech.example/wp-json/"><meta name="description" content="We tested 20 laptops to find the best ones for 2026."><meta property="article:published_time" content="2026-09-01T10:00:00Z"><meta name="robots" content="index, noai"><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"NewsArticle","headline":"Best Laptops of 2026","datePublished":"2026-09-01","author":{"@type":"Person","name":"Jane Doe"},"keywords":"laptops, reviews","articleSection":"Hardware","inLanguage":"en"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Which laptop is best for students?","acceptedAnswer":{"@type":"Answer","text":"The X1 offers the best value for most students thanks to battery life."}}]},{"@type":"VideoObject","name":"Hands on","contentUrl":"https://cdn.example/v.mp4","duration":"PT1M30S"}]}</script></head><body><article><h2>Is it worth it?</h2><p>Yes, for most people the answer is clearly positive because of the price and the long battery life.</p><figure><img src="/img/x1.jpg" width="800" height="600" alt="The X1 laptop on a desk"><figcaption>The X1 on our test bench</figcaption></figure><img src="/pixel.gif" width="1" height="1"><iframe src="https://www.youtube.com/embed/abc123" title="Review video"></iframe></article></body></html>`;
  const u = pageMetadata(html, 'https://tech.example/best-laptops?utm_source=x');
  assert.equal(u.title, 'Best Laptops of 2026');
  assert.equal(u.metaTitle, 'Best Laptops 2026 | TechSite');
  assert.match(u.metaDescription, /^We tested 20/);
  assert.deepEqual([u.language, u.author, u.section, u.tags, u.canonical, u.dateText], ['en', 'Jane Doe', 'Hardware', ['laptops', 'reviews'], 'https://tech.example/best-laptops', '2026-09-01']);
  assert.deepEqual(u.alternatives, [{ language: 'tr', url: 'https://tech.example/tr/en-iyi-laptoplar' }], 'x-default is skipped');
  assert.deepEqual([u.feeds, u.wpApi, u.noAi], [['https://tech.example/feed/'], 'https://tech.example/wp-json/', true]);
  const sc = questionAnswers(html, htmlBlocks(html).blocks);
  assert.deepEqual(sc.map((x) => x.question), ['Which laptop is best for students?', 'Is it worth it?'], 'JSON-LD FAQ + question heading in the content');
  assert.deepEqual(contentImages(html, 'https://tech.example/a'), [{ url: 'https://tech.example/img/x1.jpg', alt: 'The X1 laptop on a desk', caption: 'The X1 on our test bench' }], 'tracking pixel skipped');
  const v = contentVideos(html, 'https://tech.example/a');
  assert.deepEqual(v.map((x) => [x.url, x.durationSec, x.direct]), [['https://cdn.example/v.mp4', 90, true], ['https://www.youtube.com/embed/abc123', null, false]]);
  // blob: / javascript: adresli medya alinmaz (wikiwand <video src="blob:..."> indirme sirasina giriyordu)
  assert.deepEqual(contentVideos('<video src="blob:https://www.wikiwand.com/61e1"></video><video src="/v2.mp4"></video>', 'https://w.example/a').map((x) => x.url), ['https://w.example/v2.mp4']);
  assert.deepEqual(contentAudio('<audio src="blob:https://x/1"></audio>', 'https://w.example/a'), []);
  assert.deepEqual(contentImages('<article><img src="blob:https://x/1" alt="a"><img src="javascript:void(0)" alt="b"></article>', 'https://w.example/a'), []);
  assert.equal(findCategory('https://tech.example/donanim/x1-inceleme', { section: null }), 'donanim');
  assert.equal(findCategory('https://tech.example/2026/09/x1', { section: 'Hardware' }), 'Hardware');
  // Link siniflama ve normalizasyon
  assert.equal(normalizeUrl('HTTPS://Tech.Example/a/b/?utm_source=x&id=3#top'), 'https://tech.example/a/b/?id=3');
  assert.equal(normalizeUrl('/x/index.html', 'https://tech.example/'), 'https://tech.example/x');
  const h = 'tech.example';
  assert.deepEqual(['https://tech.example/category/laptops', 'https://tech.example/2026/09/best-laptops', 'https://tech.example/about', 'https://tech.example/rapor.pdf', 'https://tech.example/a.png', 'https://other.example/x', 'https://tech.example/page/2', 'https://tech.example/laptops'].map((l) => linkClassify(l, h)), ['list', 'text', 'static', 'doc', 'media', 'external', 'list', 'list']);
  const links = pageLinks('<nav><a href="/category/x">Kategori</a></nav><main><a href="/2026/09/yazi-bir?utm_campaign=t">Yazı bir</a><a href="/2026/09/yazi-bir">tekrar</a><a href="mailto:a@b.c">e</a></main>', 'https://tech.example/');
  assert.deepEqual(links.map((l) => [l.url, l.cls]), [['https://tech.example/2026/09/yazi-bir', 'text'], ['https://tech.example/category/x', 'list']], 'body links first, no duplicates or mailto');
  // Arama sonuclari: Bing RSS ve DuckDuckGo HTML
  assert.match(searchUrl('bing', 'oyun rehberi', 'tr'), /bing\.com\/search\?format=rss&q=oyun%20rehberi&setlang=tr&cc=TR/);
  const bing = '<rss><channel><item><title>A</title><link>https://site.example/yazi</link><description>özet</description></item><item><title>B</title><link>https://www.youtube.com/watch?v=1</link></item><item><title>C</title><link>https://site.example/yazi/</link></item></channel></rss>';
  assert.deepEqual(searchResults(bing).map((s) => s.url), ['https://site.example/yazi'], 'YouTube skipped, same path deduplicated');
  const ddg = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsite.example%2Fa%3Fx%3D1&amp;rut=abc">Başlık</a><a class="result__snippet" href="x">Kısa özet metni</a></div>';
  assert.deepEqual(searchResults(ddg), [{ url: 'https://site.example/a?x=1', title: 'Başlık', summary: 'Kısa özet metni' }]);
  // Dil, simhash, kalite, kisisel veri
  assert.equal(detectLanguage('Bu yazı ve bir deneme için yazıldı; daha çok kelime ile olarak en iyi sonucu verir ama yine de kısa.'), 'tr');
  assert.equal(detectLanguage('The quick brown fox jumps over the lazy dog and the cat is on the mat with a hat for the day.'), 'en');
  assert.equal(detectLanguage('Это простой текст на русском языке для проверки определения языка.'), 'ru');
  const m1 = Array.from({ length: 200 }, (_, i) => `kelime${i % 37} sözcük${i % 11}`).join(' ');
  const m2 = `${m1} ek bir cümle daha`;
  assert.ok(hammingDistance(simhash(m1), simhash(m2)) <= 3, 'near duplicate differs by a few bits');
  assert.ok(hammingDistance(simhash(m1), simhash(Array.from({ length: 200 }, (_, i) => `farklı${i % 53} metin${i % 7}`).join(' '))) > 10);
  assert.equal(qualityRule(Array.from({ length: 60 }, (_, i) => `Doğal bir cümle ${i} burada akıyor.`).join(' ')), null);
  assert.equal(qualityRule(Array.from({ length: 30 }, () => '- madde').join('\n')), 'item-list');
  assert.equal(qualityRule(Array.from({ length: 40 }, () => '#### | {} <>').join(' ')), 'letter-ratio');
  assert.equal(maskPersonalData('Yazın: ali@ornek.com, 0532 123 45 67, TR33 0006 1005 1978 6457 8413 26.'), 'Yazın: [email], [phone], [iban].');
  assert.deepEqual(['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '100.100.1.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '8.8.8.8', '2606:4700::1111'].map(isPrivateIp), [true, true, true, true, true, true, true, true, true, false, false]);
  // Common Crawl
  const cdx = '{"url":"https://s.example/a","filename":"crawl/1.warc.gz","offset":"10","length":"20","timestamp":"20260101","status":"200"}\n{"url":"https://s.example/a","filename":"crawl/2.warc.gz","offset":"5","length":"9","timestamp":"20260301","status":"200"}\n{"url":"https://s.example/b","filename":"x","offset":"1","length":"1","status":"404"}\n';
  assert.deepEqual(ccRecords(cdx).map((k) => [k.url, k.file]), [['https://s.example/a', 'crawl/2.warc.gz']], 'newest of the same address, no 404');
  const warc = Buffer.from('WARC/1.0\r\nWARC-Type: response\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html>gövde</html>');
  assert.deepEqual(warcBody(warc), { type: 'text/html; charset=utf-8', body: '<html>gövde</html>' });
  // WordPress API
  const wp = wpPosts([{ link: 'https://w.example/a', title: { rendered: 'A &amp; B' }, content: { rendered: '<p>içerik</p>' }, excerpt: { rendered: '<p>özet</p>' }, date_gmt: '2026-01-02T03:04:05', yoast_head_json: { title: 'A | W', description: 'meta', og_locale: 'tr_TR' }, _embedded: { author: [{ name: 'Yazar' }], 'wp:term': [[{ taxonomy: 'category', name: 'Oyun' }], [{ taxonomy: 'post_tag', name: 'rpg' }]] } }]);
  assert.deepEqual([wp[0].title, wp[0].metaTitle, wp[0].language, wp[0].section, wp[0].tags, wp[0].author, wp[0].dateText], ['A & B', 'A | W', 'tr', 'Oyun', ['rpg'], 'Yazar', '2026-01-02T03:04:05Z']);
});

/** En kucuk ZIP (docx/xlsx icin) ve PDF uretici. */
function makeZip(files) {
  const parts = [];
  const center = [];
  let position = 0;
  const crc = (b) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const frequent = deflateSync(data).subarray(2, -4); // ham deflate (zlib basligi ve adler yok)
    const adB = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc(data), 14);
    local.writeUInt32LE(frequent.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(adB.length, 26);
    const m = Buffer.alloc(46);
    m.writeUInt32LE(0x02014b50, 0);
    m.writeUInt16LE(8, 10);
    m.writeUInt32LE(crc(data), 16);
    m.writeUInt32LE(frequent.length, 20);
    m.writeUInt32LE(data.length, 24);
    m.writeUInt16LE(adB.length, 28);
    m.writeUInt32LE(position, 42);
    center.push(Buffer.concat([m, adB]));
    parts.push(local, adB, frequent);
    position += local.length + adB.length + frequent.length;
  }
  const centerB = Buffer.concat(center);
  const last = Buffer.alloc(22);
  last.writeUInt32LE(0x06054b50, 0);
  last.writeUInt16LE(center.length, 8);
  last.writeUInt16LE(center.length, 10);
  last.writeUInt32LE(centerB.length, 12);
  last.writeUInt32LE(position, 16);
  return Buffer.concat([...parts, centerB, last]);
}
function makePdf(lines) {
  const stream = `BT /F1 12 Tf ${lines.map((s) => `(${s}) Tj T*`).join(' ')} ET`;
  const frequent = deflateSync(Buffer.from(stream, 'latin1'));
  return Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Length ' + frequent.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'), frequent, Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1')]);
}

test('document reading: PDF (FlateDecode), DOCX, XLSX', () => {
  const pdf = makePdf(['Birinci cumle burada bitiyor.', 'Ikinci cumle devam ediyor ve', 'ucuncu satirla tamamlaniyor.']);
  assert.match(pdfText(pdf), /^Birinci cumle burada bitiyor\.\n\nIkinci cumle devam ediyor ve ucuncu satirla tamamlaniyor\.$/);
  const docx = makeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Başlık</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Metin </w:t></w:r><w:r><w:t>devamı &amp; son.</w:t></w:r></w:p></w:body></w:document>' });
  assert.equal(zipInputs(docx).size, 1);
  assert.equal(docxText(docx), '## Başlık\n\nMetin devamı & son.');
  const xlsx = makeZip({ 'xl/sharedStrings.xml': '<sst><si><t>Ad</t></si><si><t>Puan</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>7</v></c><c><v>42</v></c></row></sheetData></worksheet>' });
  assert.equal(xlsxText(xlsx), '## sheet1\nAd | Puan\n7 | 42');
});

test('training samples: meta, summary, title, question, article; translation pairs from the hreflang group (both directions, ratio check)', () => {
  const textTr = `# Başlık\n\n${Array.from({ length: 300 }, (_, i) => `kelime${i}`).join(' ')}`;
  const englishText = `# Title\n\n${Array.from({ length: 280 }, (_, i) => `word${i}`).join(' ')}`;
  const records = [
    { url: 'https://a/tr', language: 'tr', group: 'g1', words: 300, text: textTr, title: 'Uzun ve açıklayıcı bir başlık', metaTitle: 'Kısa SEO başlık', metaDescription: 'Bu açıklama yüz yirmi karakterden uzun olmalı ki meta eğitim örneği olarak kabul edilsin ve bir noktayla bitsin, evet.', quality: 4, questionAnswers: [{ question: 'Bu nedir ki?', cevap: 'Bu bir deneme yanıtıdır ve yeterince uzundur.' }] },
    { url: 'https://a/en', language: 'en', group: 'g1', words: 280, text: englishText, title: 'An informative English title', quality: null },
    { url: 'https://a/de', language: 'de', group: 'g1', words: 40, text: 'kurz', title: 'x', quality: null },
  ];
  const o = trainingExamples(records);
  assert.equal(o.meta.length, 1);
  assert.deepEqual(JSON.parse(o.meta[0].messages[2].content), { meta_title: 'Kısa SEO başlık', meta_description: records[0].metaDescription });
  assert.equal(o.summary.length, 1);
  assert.equal(o.title.length, 2);
  assert.equal(o.question.length, 1);
  assert.equal(o.write.length, 1, 'kalite 4 olan');
  assert.deepEqual(o.translation.map((c) => c.source), ['https://a/tr -> https://a/en', 'https://a/en -> https://a/tr'], 'short German counterpart makes no translation pair');
  assert.match(o.translation[0].messages[0].content, /Turkish article into English/);
});

/**
 * Sahte site: robots (Disallow /gizli), RSS (3 yazi + gizli), kopya sayfa, hreflang ceviri esi, JSON-LD/SSS/gorsel,
 * WordPress bolumu (/wp + /wp-json), liste sayfasi ile ic linkler (gezinme), PDF, 429 sonra basari, sahte arama motoru.
 */
async function fakeSite() {
  // ayirt: paragraflara eklenen kelime (yakin kopya sayilmasin diye gezinme yazilari birbirinden farkli)
  const paragraph = (n, distinguish = '') => `<p>${n}. paragraf${distinguish ? ` ${distinguish} ${distinguish} konusu` : ''}: Bu yazı veri toplama aracını sınamak için yazılmış uzunca bir paragraftır ve yeterince kelime içerir, sayfanın asıl içeriğidir.</p>`;
  const body = (startedAt, n = 30, distinguish = '') => Array.from({ length: n }, (_, i) => paragraph(i + startedAt, distinguish)).join('');
  const text = (title, bodyNo, ek = '', lang = 'tr', distinguish = '') => `<html lang="${lang}"><head><title>${title}</title>${ek}</head><body><nav><a href="/">Ana sayfa menü bağlantısı burada</a><a href="/list">Liste</a></nav><article><h1>${title}</h1>${body(bodyNo, 30, distinguish)}</article><aside><p>İlgili yazılar listesi ve reklam alanı burada duruyor</p></aside></body></html>`;
  const requests = [];
  let counter429 = 0;
  const s = createServer((i, y) => {
    requests.push(i.url);
    const port = s.address().port;
    const root = `http://127.0.0.1:${port}`;
    const widthParagraph = (n) => Array.from({ length: 28 }, (_, k) => `<p>Paragraph ${k + n}: this is the English version of the article with enough words to count as real content for the test.</p>`).join('');
    const pages = {
      '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /hidden\n'],
      '/rss.xml': ['application/rss+xml', `<rss><channel>${['/yazi1', '/yazi2', '/copy', '/hidden/yazi3'].map((p) => `<item><title>${p}</title><link>${root}${p}</link></item>`).join('')}</channel></rss>`],
      '/yazi1': ['text/html', text('Birinci yazı', 0, `<link rel="alternate" hreflang="en" href="${root}/en/first"><link rel="canonical" href="${root}/yazi1"><meta name="description" content="Birinci yazının meta açıklaması burada yüz yirmi karakteri geçecek kadar uzun tutuldu ki meta örneği üretilsin, tamam."><script type="application/ld+json">{"@type":"Article","headline":"Birinci yazı","datePublished":"2026-09-10","articleSection":"Oyun"}</script>`)],
      '/en/first': ['text/html', `<html lang="en"><head><title>First article</title><link rel="alternate" hreflang="tr" href="${root}/yazi1"></head><body><article><h1>First article</h1>${widthParagraph(0)}<figure><img src="/img/a.jpg" width="640" height="480" alt="A laptop on a desk"><figcaption>Test bench photo</figcaption></figure><h2>Is it any good?</h2><p>Yes it is quite good for the price and the battery lasts long enough for a day.</p></article></body></html>`],
      '/yazi2': ['text/html', text('İkinci yazı', 100)],
      '/copy': ['text/html', text('Birinci yazının kopyası', 0)],
      '/hidden/yazi3': ['text/html', text('Gizli', 200)],
      '/list': ['text/html', `<html lang="tr"><head><title>Yazılar</title></head><body><main><a href="/2026/10/gezinme-yazisi-bir">Gezinme yazısı bir</a><a href="/2026/10/gezinme-yazisi-iki">Gezinme yazısı iki</a><a href="/hakkimizda">Hakkımızda</a><a href="/rapor.pdf">Rapor</a><a href="/page/2">Sonraki</a></main></body></html>`],
      '/page/2': ['text/html', '<html lang="tr"><head><title>Sayfa 2</title></head><body><main><a href="/2026/10/gezinme-yazisi-uc">Üç</a></main></body></html>'],
      '/2026/10/gezinme-yazisi-bir': ['text/html', text('Gezinme yazısı bir', 300, '', 'tr', 'elma armut')],
      '/2026/10/gezinme-yazisi-iki': ['text/html', text('Gezinme yazısı iki', 400, '', 'tr', 'kiraz vişne')],
      '/2026/10/gezinme-yazisi-uc': ['text/html', text('Gezinme yazısı üç', 500, '', 'tr', 'ceviz fındık')],
      '/hakkimizda': ['text/html', text('Hakkımızda', 600, '', 'tr', 'kurum tarihçe')],
      '/kirilgan': ['text/html', text('Kırılgan sayfa', 800, '', 'tr', 'dayanıklılık sınavı')],
      '/rapor.pdf': ['application/pdf', makePdf(Array.from({ length: 40 }, (_, i) => `Rapor satiri ${i} burada yeterince uzun bir cumle olarak duruyor.`))],
      '/wp/': ['text/html', `<html lang="tr"><head><title>WP Sitesi</title><link rel="https://api.w.org/" href="${root}/wp-json/"></head><body><p>ana sayfa</p></body></html>`],
      '/wp-json/wp/v2/posts?per_page=50&page=1&orderby=date&order=desc&_embed=1': ['application/json', JSON.stringify([{ link: `${root}/wp/yazi-a`, title: { rendered: 'WP yazısı A' }, content: { rendered: body(700) }, excerpt: { rendered: '<p>Özet A</p>' }, date_gmt: '2026-09-20T10:00:00', yoast_head_json: { title: 'WP A | Site', description: 'WP yazısı A için meta açıklama metni; yüz yirmi karakterden uzun olsun diye biraz daha uzatıldı, böylece meta örneği de çıkar.' }, _embedded: { 'wp:term': [[{ taxonomy: 'category', name: 'Teknoloji' }]] } }])],
      '/search': null,
    };
    if (i.url.startsWith('/search?q=')) {
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      y.end(`<rss><channel><item><title>Birinci</title><link>${root}/yazi1</link></item><item><title>İkinci</title><link>${root}/yazi2</link></item><item><title>Kırılgan</title><link>${root}/kirilgan</link></item></channel></rss>`);
      return;
    }
    if (i.url === '/kirilgan' && counter429++ < 1) {
      y.writeHead(429, { 'Retry-After': '1' });
      y.end('yavaş');
      return;
    }
    const v = pages[i.url];
    y.writeHead(v ? 200 : 404, { 'Content-Type': v?.[0] ?? 'text/plain' });
    y.end(v?.[1] ?? '');
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  return { local: `http://127.0.0.1:${s.address().port}`, requests, close: () => new Promise((ok) => s.close(ok)) };
}

const readRecords = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)) : []);

test('data collection job: robots, duplicates, menu/ads, translation counterpart, meta/FAQ/image, PDF, navigation, WordPress API, resumes where it left off', async () => {
  const site = await fakeSite();
  const p = await createPanel();
  try {
    const source = `${site.local}/rss.xml`;
    assert.throws(() => p.queue.add('data', { name: 'x', sources: [] }), /enter a topic|at least one source/i);
    assert.throws(() => p.queue.add('data', { name: 'x', sources: ['ftp://a'] }), /Invalid address/);
    const job = p.queue.add('data', { name: 'Deneme koleksiyonu', sources: [source], extract: 'rule', minWord: 100, depth: 0 });
    assert.deepEqual([job.input.max, job.input.target, job.input.browser, job.input.media, job.input.depth], [50, 200, 'automatic', 'meta', 0]);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const c = last.outputs.find((x) => x.type === 'data');
    assert.equal(c.added, 3, `two original articles + English translation counterpart: ${JSON.stringify(c)}`);
    assert.equal(c.repeat, 1, 'duplicate text skipped');
    assert.equal(c.robots, 1, 'robots.txt disallow');
    assert.equal(c.translation, 1);
    const folder = join(p.root, 'data', 'collections', 'deneme-koleksiyonu');
    const records = readRecords(join(folder, 'articles.jsonl'));
    assert.equal(records.length, 3);
    const first = records.find((k) => k.url.endsWith('/yazi1'));
    assert.ok(!first.text.includes('menü') && !first.text.includes('reklam'), 'menu and sidebar stripped');
    assert.ok(first.words > 300);
    assert.deepEqual([first.language, first.category, first.dateText, first.method, first.extraction], ['tr', 'Oyun', '2026-09-10', 'html', 'rule']);
    assert.ok(first.metaDescription.length > 100, 'meta description captured');
    assert.equal(first.group, `${site.local}/yazi1`, 'hreflang grubu kanonik adres');
    const width = records.find((k) => k.url.endsWith('/en/first'));
    assert.deepEqual([width.language, width.group, width.questionAnswers.length, width.media.image], ['en', first.group, 1, 1], 'translation counterpart in the same group; FAQ and image meta');
    assert.deepEqual(readRecords(join(folder, 'images.jsonl')).map((g) => [g.url, g.text]), [[`${site.local}/img/a.jpg`, 'Test bench photo']]);
    assert.ok(!site.requests.includes('/hidden/yazi3'), 'disallowed page never requested');
    assert.ok(!site.requests.includes('/img/a.jpg'), 'media=meta: image not downloaded');
    const summary = JSON.parse(readFileSync(join(folder, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.languages, { tr: 2, en: 1 });
    assert.equal(summary.files['training-translation'], 2, 'two-way translation pair');
    assert.ok(summary.files['training-meta'] >= 1 && summary.files['training-question'] >= 1 && summary.files['training-image'] === 1);
    assert.equal(readRecords(join(folder, 'training-translation.jsonl')).length, 2);

    // Yeniden calistirinca ayni yazilar tekrar eklenmez; eski (kirli altyazili) gorsel kaydi egitim ciftinde temizlenir
    appendFileSync(join(folder, 'images.jsonl'), `${JSON.stringify({ url: 'https://eski.invalid/a.jpg', alt: 'Eski_gorsel label QS:Len,"Eski"', caption: 'Exhibit in the Eski Museum. This artwork is in the public domain because the artist died.', file: null })}\n`);
    const last3 = await p.waitUntilDone(p.queue.add('data', { name: 'Deneme koleksiyonu', sources: [`${site.local}/yazi1`], extract: 'rule', minWord: 100, depth: 0 }).id, 30000);
    assert.equal(last3.outputs.find((x) => x.type === 'data').added, 0);
    assert.equal(readRecords(join(folder, 'articles.jsonl')).length, 3);
    assert.deepEqual(readRecords(join(folder, 'training-image.jsonl')).map((c) => c.text), ['Test bench photo', 'Exhibit in the Eski Museum.']);

    // Site ici gezinme: liste sayfasi -> yazi linkleri (statik atlanir), 2. sayfa (derinlik), PDF belgesi
    const last4 = await p.waitUntilDone(p.queue.add('data', { name: 'Gezinme', sources: [`${site.local}/list`], extract: 'rule', minWord: 100, depth: 2 }).id, 60000);
    assert.equal(last4.status, 'done', last4.error);
    const walk = readRecords(join(p.root, 'data', 'collections', 'gezinme', 'articles.jsonl'));
    assert.deepEqual(walk.map((k) => k.url.replace(site.local, '')).sort(), ['/2026/10/gezinme-yazisi-bir', '/2026/10/gezinme-yazisi-iki', '/2026/10/gezinme-yazisi-uc', '/rapor.pdf'], 'three articles + PDF; Hakkımızda counted as static and not taken');
    assert.equal(walk.find((k) => k.url.endsWith('.pdf')).method, 'doc:pdf');
    assert.ok(!site.requests.includes('/hakkimizda'), 'static page never requested');

    // WordPress API kesfi (api.w.org linki) -> icerik + Yoast meta
    const last5 = await p.waitUntilDone(p.queue.add('data', { name: 'WP', sources: [`${site.local}/wp/`], extract: 'rule', minWord: 100 }).id, 60000);
    assert.equal(last5.status, 'done', last5.error);
    const wp = readRecords(join(p.root, 'data', 'collections', 'wp', 'articles.jsonl'));
    assert.deepEqual([wp.length, wp[0].method, wp[0].metaTitle, wp[0].category, wp[0].title], [1, 'wp-api', 'WP A | Site', 'Teknoloji', 'WP yazısı A']);
    assert.equal(last5.outputs.find((x) => x.type === 'data').wpApi, 1);

    // Koleksiyon ve egitime hazir dosyasi egitim verisi olarak secilebilir
    assert.throws(() => p.queue.add('training', { name: 'x', dataItems: ['collection/olmayan'] }), /not installed|Collection not found/);
    assert.throws(() => p.queue.add('training', { name: 'x', dataItems: ['collection/deneme-koleksiyonu/training-translation'] }), /not installed/);
  } finally {
    await p.close();
    await site.close();
  }
});

test('data collection job: topic mode (fake search engine), continue after 429, time limit and pausing', async () => {
  const site = await fakeSite();
  const p = await createPanel({ setting: { dataSearchTemplate: `${site.local}/search?q={q}` } });
  try {
    const job = p.queue.add('data', { name: 'Topic', topic: 'veri toplama aracı', extract: 'rule', minWord: 100, target: 10, minFit: 1, depth: 0, durationMin: 5 });
    assert.deepEqual([job.input.languages, job.input.topic], [['tr'], 'veri toplama aracı']);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const c = last.outputs.find((x) => x.type === 'data');
    const records = readRecords(join(p.root, 'data', 'collections', 'topic', 'articles.jsonl'));
    assert.ok(records.some((k) => k.url.endsWith('/kirilgan')), `429 alan sayfa yeniden denendi: ${JSON.stringify(c)}`);
    assert.ok(records.every((k) => k.topicFit >= 1 && k.source.startsWith('search:')), 'search source and topic match');
    assert.ok(site.requests.filter((u) => u === '/kirilgan').length >= 2, 'retry performed');
    const log = (await p.queue.lastLog(job.id, 200)).join('\n');
    assert.match(log, /Search: \d+ queries × 1 engines/);
    assert.match(log, /Training files: meta/);
    // Duraklatma: calisirken durdurulur, 'paused' olur; devam edince kaldigi yerden
    const is2 = p.queue.add('data', { name: 'Topic', topic: 'veri toplama aracı ikinci tur', extract: 'rule', minWord: 100, target: 50, minFit: 1, depth: 2 });
    await p.waitForState(() => p.queue.jobs.get(is2.id).status === 'running' && (p.queue.jobs.get(is2.id).progress?.detail ?? '').includes('candidate'));
    p.queue.pause(is2.id);
    const stopped = await p.waitUntilDone(is2.id, 20000);
    assert.equal(stopped.status, 'paused');
    p.queue.tryAgain(is2.id);
    assert.equal((await p.waitUntilDone(is2.id, 60000)).status, 'done');
  } finally {
    await p.close();
    await site.close();
  }
});

test('data collection job: model extraction (fake text model) records language, topic, category and quality', async () => {
  const site = await fakeSite();
  const FAKE = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
  const { createServer: free } = await import('node:net');
  const port = await new Promise((ok) => { const s = free().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
  const llm = new LocalLlm({ info: { name: 'fake', command: (prt) => ({ command: process.execPath, args: [FAKE, String(prt)] }) }, port, readySec: 20 });
  const p = await createPanel({ llm });
  try {
    const last = await p.waitUntilDone(p.queue.add('data', { name: 'Model ayıklama', sources: [`${site.local}/yazi2`], minWord: 100, depth: 0 }).id, 60000);
    assert.equal(last.status, 'done', last.error);
    const k = JSON.parse(readFileSync(join(p.root, 'data', 'collections', 'model-ayiklama', 'articles.jsonl'), 'utf8').trim());
    assert.deepEqual([k.language, k.topic, k.quality, k.extraction, k.title, k.category, k.contentType, k.accuracy], ['tr', 'trial', 4, 'model', 'Sahte başlık', 'technology', 'guide', 4]);
    assert.ok(existsSync(join(p.root, 'data', 'collections', 'model-ayiklama', 'training-classification.jsonl')));
  } finally {
    await llm.close();
    await p.close();
    await site.close();
  }
});

test('data collection job: Wikimedia Commons source (category + subcategory + search): licensed media, 480p video derivative, mp3 derivative for large audio, no text filter', async () => {
  const { makePng } = await import('../lib/media.mjs');
  const requested = [];
  const agents = [];
  const page = (no, mediatype, mime, ek = {}) => ({ pageid: no, title: `File:Dosya ${no}.${mime.split('/')[1]}`, imageinfo: [{ mediatype, mime, size: ek.size ?? 1000, width: 2000, height: 1500, url: `${address}/asil/${no}`, descriptionurl: `${address}/wiki/File:${no}`, thumburl: `${address}/media/${no}-1280.jpg`, thumbwidth: 1280, thumbheight: 960, duration: ek.duration, extmetadata: { ImageDescription: { value: `<div class="description en"><span class="language en" title="İngilizce"><b>İngilizce:</b></span> <p>Açıklama <b>${no}</b> &amp; minyatür. This file is in the public domain because its copyright has expired.</p></div>` }, ObjectName: { value: `<div class="fn"><i>Levni_${no}</i></div><div style="display: none;">label QS:Len,"Levni ${no}"</div>` }, LicenseShortName: { value: 'Public domain' }, Artist: { value: '<a href="x">Levnî</a><div style="display:none">label QS:Lhu,"Levni"</div>' } } }], videoinfo: [{ derivatives: ek.derivatives ?? [] }] });
  let address = '';
  const s = createServer((i, y) => {
    const u = new URL(i.url, 'http://x');
    requested.push(u.pathname);
    if (u.pathname === '/w/api.php') {
      agents.push(i.headers['user-agent']);
      const q = Object.fromEntries(u.searchParams);
      let j = {};
      if (q.list === 'categorymembers') j = { query: { categorymembers: q.cmtitle === 'Category:Minyatur' ? [{ title: 'Category:Alt' }] : [] } };
      else if (q.generator === 'categorymembers' && q.gcmtitle === 'Category:Minyatur' && !q.gcmcontinue) j = { continue: { gcmcontinue: 'second', continue: 'gcmcontinue||' }, query: { pages: [page(1, 'BITMAP', 'image/jpeg'), page(2, 'VIDEO', 'video/webm', { duration: 95.4, derivatives: [{ src: `${address}/media/v360.webm`, type: 'video/webm; codecs="vp9"', width: 480, height: 360 }, { src: `${address}/media/v480.webm`, type: 'video/webm; codecs="vp9"', width: 640, height: 480 }, { src: `${address}/media/v720.webm`, type: 'video/webm', width: 960, height: 720 }] })] } };
      else if (q.generator === 'categorymembers' && q.gcmtitle === 'Category:Minyatur') j = { query: { pages: [page(3, 'AUDIO', 'audio/flac', { size: 90 * 2 ** 20, duration: 180, derivatives: [{ src: `${address}/media/s3.mp3`, type: 'audio/mpeg' }] }), page(4, 'DRAWING', 'image/svg+xml')] } };
      else if (q.generator === 'categorymembers' && q.gcmtitle === 'Category:Alt') j = { query: { pages: [page(5, 'BITMAP', 'image/png')] } };
      else if (q.generator === 'search') j = { query: { pages: [page(6, 'BITMAP', 'image/jpeg'), page(1, 'BITMAP', 'image/jpeg')] } };
      y.writeHead(200, { 'Content-Type': 'application/json' });
      y.end(JSON.stringify(j));
    } else if (u.pathname.startsWith('/media/')) {
      y.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      y.end(u.pathname.endsWith('.jpg') ? makePng(64, 48) : Buffer.alloc(5000, 7));
    } else {
      y.writeHead(404);
      y.end();
    }
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  address = `http://127.0.0.1:${s.address().port}`;
  const p = await createPanel({ setting: { commonsApi: `${address}/w/api.php` } });
  try {
    assert.throws(() => p.queue.add('data', { name: 'x', sources: ['commons:'] }), /Invalid address/);
    const job = p.queue.add('data', { name: 'Commons deneme', sources: ['commons:Category:Minyatur', 'commons:minyatür'], media: 'download', depth: 1, extract: 'rule', parallel: 1, mediaMaxMb: 25 });
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const folder = join(p.root, 'data', 'collections', 'commons-deneme');
    const images = readRecords(join(folder, 'images.jsonl'));
    assert.deepEqual(images.map((o) => o.pageTitle).sort(), ['File:Dosya 1.jpeg', 'File:Dosya 5.png', 'File:Dosya 6.jpeg'], 'category + subcategory + search; duplicate in search skipped, no svg');
    const g1 = images.find((o) => o.pageTitle === 'File:Dosya 1.jpeg');
    // Altyazi: gizli Wikidata satiri, dil etiketi ve lisans cumlesi atilir (lisans kendi alaninda)
    assert.deepEqual([g1.text, g1.alt, g1.license, g1.author, g1.sourceType, g1.width], ['Açıklama 1 & minyatür.', 'Levni 1', 'Public domain', 'Levnî', 'commons', 1280]);
    assert.ok(existsSync(join(folder, g1.file)), 'image downloaded');
    assert.ok(requested.includes('/media/1-1280.jpg'), '1280 px downscaled version');
    const [v] = readRecords(join(folder, 'videos.jsonl'));
    assert.deepEqual([v.durationSec, v.height, v.description, v.title], [95, 480, 'Açıklama 2 & minyatür.', 'Levni 2']);
    assert.ok(requested.includes('/media/v480.webm') && !requested.includes('/media/v720.webm') && !requested.includes('/asil/2'), '480p derivative downloaded');
    const [voice] = readRecords(join(folder, 'audio.jsonl'));
    assert.ok(voice.file && requested.includes('/media/s3.mp3') && !requested.includes('/asil/3'), 'mp3 derivative instead of the large FLAC');
    assert.ok(agents.every((a) => /^NedeseStudioData\/2\.0 \(https:\/\/github\.com\//.test(a)), 'User-Agent identifying the tool on API requests');
    // Yalniz medya toplanmis koleksiyon listede ve egitimde secilebilir
    const { collections } = await import('../lib/jobs/data.mjs');
    assert.deepEqual(collections(p.root).find((k) => k.id === 'commons-deneme')?.media, { images: 3, videos: 1, audio: 1, captions: 0 });
  } finally {
    await p.close();
    s.close();
  }
});

test('data collection job: hops between sites (external link of a page matching the topic), target 0 is unlimited; yields the queue when another job arrives, resumes on its own when it finishes', async () => {
  // Her yazi baska kelimelerden (yakin kopya sayilmasin): yaziya ozel tohumla secilen sozcukler; konu "gezgin kedi"
  const dictionary = 'elma armut kiraz vişne ceviz fındık kayısı şeftali erik dut incir nar deniz dağ orman nehir göl ova bulut yağmur kar rüzgâr güneş ay yıldız köprü kale saray çarşı liman fener bahçe tarla bağ çeşme kuyu değirmen han hamam kervan gemi tren yol patika vadi tepe kaya mağara ada koy sahil kumsal dalga martı leylek turna serçe baykuş tilki kirpi sincap'.split(' ');
  const sentence = (no, i) => Array.from({ length: 22 }, (_, k) => dictionary[(no * 131 + i * 17 + k * k * 7 + k) % dictionary.length]).join(' ');
  const text = (title, no, ek = '') => `<html lang="tr"><head><title>${title}</title></head><body><article><h1>${title}</h1>${Array.from({ length: 30 }, (_, i) => `<p>Gezgin kedi ${sentence(no, i)}.</p>`).join('')}${ek}</article></body></html>`;
  let bAddress = '';
  const bRequests = [];
  const b = createServer((i, y) => {
    bRequests.push(i.url);
    const pages = {
      '/': `<html lang="tr"><head><title>B ana sayfa</title></head><body><main>${[1, 2, 3, 4].map((n) => `<a href="/2026/10/kedi-yazisi-${n}">Kedi yazısı ${n}</a>`).join('')}</main></body></html>`,
      ...Object.fromEntries([1, 2, 3, 4].map((n) => [`/2026/10/kedi-yazisi-${n}`, text(`B kedi yazısı ${n}`, 10 + n)])),
    };
    const v = pages[i.url];
    // Yavas site: toplama uzun sursun (araya is girebilsin)
    setTimeout(() => {
      y.writeHead(v ? 200 : 404, { 'Content-Type': 'text/html' });
      y.end(v ?? '');
    }, v && i.url !== '/' ? 700 : 0);
  });
  await new Promise((ok) => b.listen(0, '127.0.0.1', ok));
  bAddress = `http://localhost:${b.address().port}`;
  const a = createServer((i, y) => {
    const root = `http://127.0.0.1:${a.address().port}`;
    if (i.url.startsWith('/search?q=')) {
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      y.end(`<rss><channel><item><title>A1</title><link>${root}/a1</link></item><item><title>A2</title><link>${root}/a2</link></item></channel></rss>`);
      return;
    }
    const pages = {
      '/a1': text('A birinci kedi yazısı', 1, `<p>Ayrıca bakınız: <a href="${bAddress}/2026/10/kedi-yazisi-1">B sitesindeki kedi yazısı</a> ve <a href="https://www.facebook.com/kedi">Facebook</a></p>`),
      '/a2': text('A ikinci kedi yazısı', 2, `<p><a href="${bAddress}/">B sitesi</a></p>`),
    };
    const v = pages[i.url];
    y.writeHead(v ? 200 : 404, { 'Content-Type': 'text/html' });
    y.end(v ?? '');
  });
  await new Promise((ok) => a.listen(0, '127.0.0.1', ok));
  const p = await createPanel({ setting: { dataSearchTemplate: `http://127.0.0.1:${a.address().port}/search?q={q}` } });
  try {
    const job = p.queue.add('data', { name: 'Gezgin', topic: 'gezgin kedi', extract: 'rule', minWord: 100, target: 0, minFit: 1, depth: 1, parallel: 1 });
    assert.deepEqual([job.input.target, job.input.hopSites], [0, true], 'site hopping on by default in topic mode, target 0 = unlimited');
    assert.match(job.summary.detail, /unlimited · site to site/);
    // B'nin yazilari gelmeye baslayinca yeni is: veri toplama sirayi birakir
    await p.waitForState(() => bRequests.some((u) => u.startsWith('/2026/10/')), 30000);
    const g = p.queue.add('image', { prompt: 'a cat', model: 'qwen' });
    await p.waitForState(() => p.queue.jobs.get(job.id).status === 'paused', 20000);
    assert.equal(p.queue.jobs.get(job.id).yielded, true);
    assert.match(p.queue.jobs.get(job.id).progress.stage, /Yielded the queue/);
    assert.equal((await p.waitUntilDone(g.id, 60000)).status, 'done');
    // Sira bosalinca kendiliginden surer ve biter (kuyrukta gezilecek site kalmayinca)
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const records = readRecords(join(p.root, 'data', 'collections', 'gezgin', 'articles.jsonl'));
    const bTexts = records.filter((k) => k.url.startsWith(bAddress)).map((k) => k.url.split('/').pop()).sort();
    assert.deepEqual(bTexts, ['kedi-yazisi-1', 'kedi-yazisi-2', 'kedi-yazisi-3', 'kedi-yazisi-4'], 'site B crawled through its own links, not taken again after pause and resume');
    assert.equal(new Set(records.map((k) => k.url)).size, records.length, 'no duplicate record');
    const queue = JSON.parse(readFileSync(join(p.root, 'data', 'collections', 'gezgin', 'site-queue.json'), 'utf8'));
    assert.deepEqual([queue.visited, queue.queue], [['localhost'], []], 'sites like facebook are not crawled; the state file keeps the position');
    assert.match((await p.queue.lastLog(job.id, 400)).join('\n'), /Queue is empty; resuming where it left off/);
  } finally {
    await p.close();
    a.close();
    b.close();
  }
});

test('data collection job: the model picks the site-to-site link (the one matching the topic is queued, the other is not crawled)', async () => {
  const FAKE = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
  const { createServer: free } = await import('node:net');
  const port = await new Promise((ok) => { const s = free().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
  const llm = new LocalLlm({ info: { name: 'fake', command: (prt) => ({ command: process.execPath, args: [FAKE, String(prt)] }) }, port, readySec: 20 });
  const dictionary = 'deniz dağ orman nehir göl ova bulut yağmur kar rüzgâr güneş ay yıldız köprü kale saray çarşı liman fener bahçe tarla bağ çeşme kuyu'.split(' ');
  const text = (title, no, ek = '') => `<html lang="tr"><head><title>${title}</title></head><body><article><h1>${title}</h1>${Array.from({ length: 25 }, (_, i) => `<p>Gezgin kedi ${Array.from({ length: 18 }, (_, k) => dictionary[(no * 37 + i * 11 + k * k * 5 + k) % dictionary.length]).join(' ')}.</p>`).join('')}${ek}</article></body></html>`;
  const server = (address, pages, requests) => new Promise((ok) => {
    const s = createServer((i, y) => {
      requests.push(i.url);
      const v = pages()[i.url];
      y.writeHead(v ? 200 : 404, { 'Content-Type': 'text/html' });
      y.end(v ?? '');
    });
    s.listen(0, address, () => ok(s));
  });
  const bRequest = [];
  const cRequest = [];
  const b = await server('127.0.0.1', () => ({ '/b1': text('B yazısı', 3) }), bRequest);
  const c = await server('::1', () => ({ '/c1': text('C yazısı', 5) }), cRequest);
  const bAddress = `http://localhost:${b.address().port}`;
  const cAddress = `http://[::1]:${c.address().port}`;
  const a = createServer((i, y) => {
    const root = `http://127.0.0.1:${a.address().port}`;
    if (i.url.startsWith('/search?q=')) {
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return y.end(`<rss><channel><item><title>A1</title><link>${root}/a1</link></item></channel></rss>`);
    }
    const v = { '/a1': text('A yazısı', 1, `<p><a href="${bAddress}/b1">SEÇ: gezgin kediler üzerine B</a> ve <a href="${cAddress}/c1">Başka bir şey</a></p>`) }[i.url];
    y.writeHead(v ? 200 : 404, { 'Content-Type': 'text/html' });
    y.end(v ?? '');
  });
  await new Promise((ok) => a.listen(0, '127.0.0.1', ok));
  const p = await createPanel({ llm, setting: { dataSearchTemplate: `http://127.0.0.1:${a.address().port}/search?q={q}` } });
  try {
    const job = p.queue.add('data', { name: 'Model atlama', topic: 'gezgin kedi', extract: 'model', minWord: 50, target: 0, depth: 0, parallel: 1 });
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    assert.ok(bRequest.includes('/b1'), 'link chosen by the model was crawled');
    assert.deepEqual(cRequest, [], 'unselected site never visited');
    const queue = JSON.parse(readFileSync(join(p.root, 'data', 'collections', 'model-atlama', 'site-queue.json'), 'utf8'));
    assert.deepEqual([queue.visited, queue.queue], [['localhost'], []]);
    assert.match((await p.queue.lastLog(job.id, 200)).join('\n'), /Site to site: 1 sites crawled, 0 queued; the model selected 1 links/);
  } finally {
    await llm.close();
    await p.close();
    a.close();
    b.close();
    c.close();
  }
});

test('data collection job: the manager (model) suggests a new direction when topic results run out and collects with a new query; stops when no new direction is left', async () => {
  const FAKE = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
  const { createServer: free } = await import('node:net');
  const port = await new Promise((ok) => { const s = free().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
  const llm = new LocalLlm({ info: { name: 'fake', command: (prt) => ({ command: process.execPath, args: [FAKE, String(prt)] }) }, port, readySec: 20 });
  const dictionary = 'deniz dağ orman nehir göl ova bulut yağmur kar rüzgâr güneş ay yıldız köprü kale saray çarşı liman fener bahçe tarla bağ çeşme kuyu'.split(' ');
  // Yaziya ozel sozcukler (ayni dagarciktan uretilen metinler yakin kopya sayiliyor)
  const text = (title, no) => `<html lang="tr"><head><title>${title}</title></head><body><article><h1>${title}</h1>${Array.from({ length: 25 }, (_, i) => `<p>Gezgin kedi ${Array.from({ length: 18 }, (_, k) => `${dictionary[(no * 37 + i * 11 + k * k * 5 + k) % dictionary.length]}${no}`).join(' ')}.</p>`).join('')}</article></body></html>`;
  const searches = [];
  const a = createServer((i, y) => {
    const root = `http://127.0.0.1:${a.address().port}`;
    if (i.url.startsWith('/search?q=')) {
      const q = decodeURIComponent(i.url.slice('/search?q='.length));
      searches.push(q);
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return y.end(`<rss><channel><item><title>x</title><link>${root}${q.includes('yeni') ? '/yeni' : '/a1'}</link></item></channel></rss>`);
    }
    const v = { '/a1': text('İlk yazı', 1), '/yeni': text('Yeni yön yazısı', 7) }[i.url];
    y.writeHead(v ? 200 : 404, { 'Content-Type': 'text/html' });
    y.end(v ?? '');
  });
  await new Promise((ok) => a.listen(0, '127.0.0.1', ok));
  const p = await createPanel({ llm, setting: { dataSearchTemplate: `http://127.0.0.1:${a.address().port}/search?q={q}` } });
  try {
    const job = p.queue.add('data', { name: 'Yonetici', topic: 'gezgin kedi', extract: 'model', minWord: 50, target: 0, depth: 0, parallel: 1 });
    assert.equal(job.input.manager, true, 'on by default');
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    const records = readRecords(join(p.root, 'data', 'collections', 'yonetici', 'articles.jsonl'));
    assert.deepEqual(records.map((k) => k.url.split('/').pop()).sort(), ['a1', 'yeni'], 'new article arrived with the query suggested by the manager');
    assert.ok(searches.includes('gezgin kedi yeni yön'));
    const log = (await p.queue.lastLog(job.id, 300)).join('\n');
    assert.match(log, /Manager \(queue empty\): Yeni alt başlık deneniyor · prioritized 0, released 0, new queries 1: "gezgin kedi yeni yön"/);
    assert.match(log, /Manager \(queue empty\): Yeni yön kalmadı/);
    const queue = JSON.parse(readFileSync(join(p.root, 'data', 'collections', 'yonetici', 'site-queue.json'), 'utf8'));
    assert.ok(queue.queries.includes('gezgin kedi yeni yön'), 'manager memory saved (resumes where it left off)');
  } finally {
    await llm.close();
    await p.close();
    a.close();
  }
});

test("fetcher: grows the per-site request interval on its own when rate limited, waits for the reset in the limit header; Wikimedia with the tool's name", async () => {
  const { setupExtractor } = await import('../lib/jobs/data.mjs');
  let last = 0;
  const requests = [];
  const s = createServer((i, y) => {
    const now = Date.now();
    requests.push({ path: i.url, time: now, agent: i.headers['user-agent'] });
    if (i.url === '/robots.txt') return void y.writeHead(404).end();
    // 300 ms'den sik gelen istege 429 (Retry-After 1)
    if (i.url.startsWith('/sik') && now - last < 300) {
      last = now;
      y.writeHead(429, { 'Retry-After': '1' });
      return void y.end('yavaş');
    }
    last = now;
    if (i.url === '/hak-bitti') y.writeHead(200, { 'Content-Type': 'text/plain', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '1' });
    else y.writeHead(200, { 'Content-Type': 'text/plain' });
    y.end('ok');
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const root = `http://127.0.0.1:${s.address().port}`;
  const log = [];
  try {
    const retrieve = setupExtractor(null, { privateNetworkAllowed: true, minDelayMs: 30, log: (m) => log.push(m) });
    for (const n of [1, 2, 3]) assert.equal((await retrieve(`${root}/sik${n}`, { checkRobots: false })).code, 200, `request ${n} eventually passes`);
    const status = retrieve.siteStatus(`127.0.0.1:${s.address().port}`);
    assert.equal(status.range, 2000, 'request interval 2 s after the rate limit (from the 30 ms base)');
    assert.ok(log.some((m) => /rate limited \(429\); request interval raised to 2\.0 s, the server asked to wait 1 s/.test(m)), log.join(' | '));
    // Ogrenilen aralik: sonraki istekler arasi >= 2 sn
    const options = requests.filter((x) => x.path.startsWith('/sik'));
    assert.ok(options.at(-1).time - options.at(-2).time >= 1900, 'learned interval respected');
    // RateLimit-Remaining 0, Reset 1 sn: sonraki istek sifirlanmayi bekler
    const fetch2 = setupExtractor(null, { privateNetworkAllowed: true, minDelayMs: 30 });
    await fetch2(`${root}/hak-bitti`, { checkRobots: false });
    const startedAt = Date.now();
    await fetch2(`${root}/sonra`, { checkRobots: false });
    assert.ok(Date.now() - startedAt >= 900, `waited until the quota reset (${Date.now() - startedAt} ms)`);
  } finally {
    s.close();
  }
});

test('data collection job: media downloads in the background (the page does not wait), a Commons file blocked by the rate limit is not recorded and downloads on the next run; a short page does not go to the model', async () => {
  const { makePng } = await import('../lib/media.mjs');
  let restricted = true;
  let address = '';
  const s = createServer((i, y) => {
    const u = new URL(i.url, 'http://x');
    if (u.pathname === '/w/api.php') {
      const q = Object.fromEntries(u.searchParams);
      const c = address.replace('127.0.0.1', 'localhost');
      const page = (no) => ({ pageid: no, title: `File:D${no}.png`, imageinfo: [{ mediatype: 'BITMAP', mime: 'image/png', size: 900, width: 64, height: 48, url: `${c}/asil/${no}.png`, descriptionurl: `${c}/wiki/File:D${no}`, thumburl: `${c}/m/${no}.png`, thumbwidth: 64, thumbheight: 48, extmetadata: { ImageDescription: { value: `Açıklama ${no}` }, LicenseShortName: { value: 'CC0' } } }], videoinfo: [{ derivatives: [] }] });
      y.writeHead(200, { 'Content-Type': 'application/json' });
      return void y.end(JSON.stringify(q.generator === 'categorymembers' ? { query: { pages: [page(1), page(2)] } } : { query: { categorymembers: [] } }));
    }
    // Commons dosyasi 2: ilk calistirmada hiz siniri (uzun Retry-After: site dinlenir, bekleyerek de 15 dk'yi asar)
    if (u.pathname === '/m/2.png' && restricted) {
      y.writeHead(429, { 'Retry-After': '3600' });
      return void y.end('yavaş');
    }
    if (u.pathname.startsWith('/m/') || u.pathname.startsWith('/g/')) {
      y.writeHead(200, { 'Content-Type': 'image/png' });
      return void y.end(makePng(64, 48));
    }
    if (u.pathname === '/gallery') {
      y.writeHead(200, { 'Content-Type': 'text/html' });
      return void y.end(`<html lang="tr"><head><title>Galeri</title></head><body><article><h1>Galeri</h1><p>Kısa metin.</p>${[1, 2, 3, 4, 5].map((n) => `<img src="/g/${n}.png" width="640" height="480" alt="Görsel ${n}">`).join('')}</article></body></html>`);
    }
    y.writeHead(404);
    y.end();
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  address = `http://127.0.0.1:${s.address().port}`;
  // Commons (API ve dosyalar) localhost adiyla, galeri 127.0.0.1: Commons sunucusunun dinlenmesi galeriyi etkilemez
  const p = await createPanel({ setting: { commonsApi: `${address.replace('127.0.0.1', 'localhost')}/w/api.php` } });
  try {
    const input = { name: 'Havuz', sources: ['commons:Category:Deneme', `${address}/gallery`], media: 'download', depth: 0, extract: 'rule', parallel: 1, minWord: 100 };
    const last = await p.waitUntilDone(p.queue.add('data', input).id, 60000);
    assert.equal(last.status, 'done', last.error);
    const folder = join(p.root, 'data', 'collections', 'havuz');
    const images = readRecords(join(folder, 'images.jsonl'));
    assert.equal(images.filter((o) => o.url.includes('/g/') && o.file).length, 5, "the short gallery page's 5 images downloaded in the background");
    assert.deepEqual(images.filter((o) => o.sourceType === 'commons').map((o) => o.pageTitle), ['File:D1.png'], 'rate-limited file not recorded (no permanent loss)');
    const log = (await p.queue.lastLog(last.id, 300)).join('\n');
    assert.match(log, /1 downloads deferred due to rate limit\/network error/);
    assert.match(log, /prefiltered 1/, 'short gallery page dropped without going to the model / rules, its media still taken');
    // Ikinci calistirma: sinir kalkti, ertelenen dosya iner; kayitlar tekil
    restricted = false;
    const last2 = await p.waitUntilDone(p.queue.add('data', input).id, 60000);
    assert.equal(last2.status, 'done', last2.error);
    const g2 = readRecords(join(folder, 'images.jsonl'));
    assert.deepEqual(g2.filter((o) => o.sourceType === 'commons' && o.file).map((o) => o.pageTitle).sort(), ['File:D1.png', 'File:D2.png']);
    assert.equal(new Set(g2.map((o) => o.url)).size, g2.length, 'unique records');
  } finally {
    await p.close();
    s.close();
  }
});

test('topic match rule: recognizes Turkish suffixes (stem), uppercase İ/I correct; a single generic word does not count as a full match', async () => {
  const { topicFitRule } = await import('../lib/data-collection.mjs');
  assert.equal(topicFitRule('Osmanlı minyatürleri', 'Osmanlı minyatür sanatı ve Levnî'), 5, '"minyatürleri" ~ "minyatür"');
  assert.equal(topicFitRule('Osmanlı minyatürleri', 'OSMANLI MİNYATÜRLERİ'), 5, 'Turkish uppercase');
  assert.equal(topicFitRule('Osmanlı minyatürleri', 'Osmanlı Devleti kısaca tarihi'), 3, 'only "Osmanlı": off-topic because the threshold on the rule path is 4');
  assert.equal(topicFitRule('Osmanlı minyatürleri', 'Fransız mutfağı'), 1);
});

test('media caption: hidden Wikidata label, language label, licence sentence and camera file name are dropped; the title is included only if it adds information', async () => {
  const { mergeCaptions, cleanCaption, visibleText } = await import('../lib/data-collection.mjs');
  // Commons ObjectName: gorunen baslik + display:none QS satirlari (gercek yanit, 05.10.2026)
  assert.equal(visibleText('<div class="fn">\n<div style="font-weight:bold;display:inline-block;"><div style="display:inline-block" dir="ltr" lang="en"><i>Siege_of_Belgrade_(Nándorfehérvár)_1456</i></div></div><div style="display: none;">label QS:Len,"Siege_of_Belgrade_(Nándorfehérvár)_1456"</div><div style="display: none;">label QS:Lhu,"Nándorfehérvár ostroma"</div></div>'), 'Siege_of_Belgrade_(Nándorfehérvár)_1456');
  assert.equal(visibleText('<div lang="en"><span class="language en" title="İngilizce"><b>İngilizce:</b></span> The <b>Dala\'il</b> &amp; al-Khayrat<br/>ikinci <div style="display:none"><div>iç içe</div> gizli</div>satır<!-- yorum --></div>'), "The Dala'il & al-Khayrat ikinci satır");
  // Eski kayitlar: gizli metin karismis (ic ice tirnakli QS), lisans ve izin cumleleri, alt cizgi
  assert.equal(cleanCaption('İngilizce: The Dala\'il al-Khayrat of al-Juzuli label QS:Len,"The Dala\'il al-Khayrat of al-Juzuli" label QS:Lar,"كتاب" title QS:P1476,en:" The Dala\'il label QS:Len,"x" "'), "The Dala'il al-Khayrat of al-Juzuli");
  assert.equal(cleanCaption('Exhibit in the Cincinnati Art Museum, Cincinnati, Ohio, USA. This artwork is in the public domain because the artist died more than 70 years ago. Photography was permitted in the museum without restriction.'), 'Exhibit in the Cincinnati Art Museum, Cincinnati, Ohio, USA.');
  assert.equal(cleanCaption('Fruit_sellers_carrying_ceramic_jars_in_front_of_Sultan_Murad_III_circa_1582.'), 'Fruit sellers carrying ceramic jars in front of Sultan Murad III circa 1582.');
  assert.equal(cleanCaption('Sultan Ahmed I , seated on a throne (https://ornek.invalid/a). '), 'Sultan Ahmed I, seated on a throne.');
  assert.equal(cleanCaption('1895-lumiere-une-partie-de-cartes'), '1895 lumiere une partie de cartes');
  assert.equal(cleanCaption('This work is licensed under CC BY-SA 4.0.'), '');
  // Aciklama yalniz yer bilgisiyse bilgi tasiyan baslik; aciklama bilgi katiyorsa aciklama; genel ad ve kamera adi sayilmaz
  assert.equal(mergeCaptions('Combat between Two Mounted Warriors, unknown artist, Turkey, 1550-1600 AD, ink, gold, and opaque watercolor on paper - Cincinnati Art Museum - DSC04222', 'Exhibit in the Cincinnati Art Museum, Cincinnati, Ohio, USA. This artwork is in the public domain because the artist died more than 70 years ago.'), 'Combat between Two Mounted Warriors, unknown artist, Turkey, 1550-1600 AD, ink, gold, and opaque watercolor on paper - Cincinnati Art Museum');
  assert.equal(mergeCaptions('I Ahmet', 'Sultan Ahmed I, seated on a throne.'), 'Sultan Ahmed I, seated on a throne.');
  assert.equal(mergeCaptions('Kevin MacLeod - Vibe Ace', 'Vibe Ace by Kevin MacLeod'), 'Vibe Ace by Kevin MacLeod');
  assert.equal(mergeCaptions('Dosya 1', 'Açıklama 1'), 'Açıklama 1');
  assert.equal(mergeCaptions('IMG_2034', ''), '');
  assert.equal(mergeCaptions('gün batımı', undefined), 'gün batımı');
  assert.equal(mergeCaptions('Siege of Vienna painted in Istanbul workshop', 'A page from the Süleymanname showing cavalry'), 'Siege of Vienna painted in Istanbul workshop. A page from the Süleymanname showing cavalry', 'both together when both add information');
  assert.equal(mergeCaptions('x'.repeat(300), 'kelime '.repeat(100)).length, 500);
});

test('data collection job: with less free disk than the margin, media downloads stop and the articles go on', async () => {
  const { makePng } = await import('../lib/media.mjs');
  const s = createServer((i, y) => {
    if (i.url.startsWith('/g/')) {
      y.writeHead(200, { 'Content-Type': 'image/png' });
      return void y.end(makePng(64, 48));
    }
    y.writeHead(200, { 'Content-Type': 'text/html' });
    y.end(`<html lang="en"><head><title>Gallery</title></head><body><article><h1>Gallery</h1><p>${'A long enough text about pictures. '.repeat(30)}</p>${[1, 2, 3].map((n) => `<img src="/g/${n}.png" width="640" height="480" alt="Picture ${n}">`).join('')}</article></body></html>`);
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  // a margin no disk has: the first check stops the media
  const p = await createPanel({ setting: { mediaDiskMarginGb: 1e9 } });
  try {
    const last = await p.waitUntilDone(p.queue.add('data', { name: 'Full disk', sources: [`http://127.0.0.1:${s.address().port}/gallery`], media: 'download', depth: 0, extract: 'rule', parallel: 1, minWord: 50 }).id, 60000);
    assert.equal(last.status, 'done', last.error);
    const log = (await p.queue.lastLog(last.id, 300)).join('\n');
    assert.match(log, /GB free left on disk: media download stopped \(1000000000 GB is kept as margin; articles continue to be collected\)/);
    const folder = join(p.root, 'data', 'collections', 'full-disk');
    const images = existsSync(join(folder, 'images.jsonl')) ? readRecords(join(folder, 'images.jsonl')) : [];
    assert.equal(images.filter((o) => o.file).length, 0, 'no picture downloaded');
    assert.ok(existsSync(join(folder, 'articles.jsonl')) && readRecords(join(folder, 'articles.jsonl')).length >= 1, 'the article is still collected');
  } finally {
    await p.close();
    s.close();
  }
});

test('data collection job: pausing does not crash when Commons and web run together; pending media and target resume where they left off; queue file read from backup; hopping off in a job without a topic', async () => {
  const { makePng } = await import('../lib/media.mjs');
  const { validate } = await import('../lib/jobs/data.mjs');
  assert.equal(validate({ name: 'x', sources: ['https://ornek.com'], hopSites: true }).hopSites, false, 'a job without a topic does not hop between sites');
  let slow = true;
  let address = '';
  const dictionary = 'deniz dağ orman nehir göl ova bulut yağmur kar rüzgâr güneş ay yıldız köprü kale saray çarşı liman fener bahçe tarla bağ çeşme kuyu'.split(' ');
  const text = (no) => `<html lang="tr"><head><title>Yazı ${no}</title></head><body><article><h1>Yazı ${no}</h1>${Array.from({ length: 25 }, (_, i) => `<p>Gezgin kedi ${Array.from({ length: 18 }, (_, k) => `${dictionary[(no * 37 + i * 11 + k * k * 5 + k) % dictionary.length]}${no}`).join(' ')}.</p>`).join('')}<img src="/g/${no}.png" width="640" height="480" alt="Kedi ${no}"></article></body></html>`;
  const s = createServer((i, y) => {
    const u = new URL(i.url, 'http://x');
    if (u.pathname === '/search') {
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return void y.end(`<rss><channel>${[1, 2, 3, 4, 5].map((n) => `<item><title>Y${n}</title><link>${address}/y${n}</link></item>`).join('')}</channel></rss>`);
    }
    if (u.pathname === '/w/api.php') {
      // Commons yavas: is duraklatildiginda istek ucusta
      setTimeout(() => {
        y.writeHead(200, { 'Content-Type': 'application/json' });
        y.end(JSON.stringify({ query: { search: [] } }));
      }, 800);
      return;
    }
    if (/^\/y\d$/.test(u.pathname)) {
      // Sayfalar yavas: ilk yazidan sonra duraklatmaya zaman kalsin
      setTimeout(() => {
        y.writeHead(200, { 'Content-Type': 'text/html' });
        y.end(text(Number(u.pathname.slice(2))));
      }, slow ? 900 : 0);
      return;
    }
    if (u.pathname.startsWith('/g/')) {
      // Gorseller yavas (havuzda bekler)
      setTimeout(() => {
        y.writeHead(200, { 'Content-Type': 'image/png' });
        y.end(makePng(64, 48));
      }, slow ? 1500 : 0);
      return;
    }
    y.writeHead(404);
    y.end();
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  address = `http://127.0.0.1:${s.address().port}`;
  const p = await createPanel({ setting: { dataSearchTemplate: `${address}/search?q={q}`, commonsApi: `${address}/w/api.php` } });
  try {
    const job = p.queue.add('data', { name: 'Surdurme', topic: 'gezgin kedi', extract: 'rule', minWord: 100, target: 3, depth: 0, parallel: 1, media: 'download' });
    const folder = join(p.root, 'data', 'collections', 'surdurme');
    await p.waitForState(() => readRecords(join(folder, 'articles.jsonl')).length >= 1, 30000);
    p.queue.pause(job.id);
    const stopped = await p.waitUntilDone(job.id, 20000);
    assert.equal(stopped.status, 'paused', 'no crash, job paused');
    const first = readRecords(join(folder, 'articles.jsonl')).length;
    assert.ok(first >= 1 && first < 3, `${first} articles at pause`);
    assert.ok(readRecords(join(folder, 'images.jsonl')).some((o) => o.waiting), 'image left in the pool has a "waiting" record');
    // Kuyruk dosyasi bozulsa da yedekten okunur
    (await import('node:fs')).writeFileSync(join(folder, 'site-queue.json'), '{"bozuk');
    slow = false;
    p.queue.tryAgain(job.id);
    const last = await p.waitUntilDone(job.id, 60000);
    assert.equal(last.status, 'done', last.error);
    assert.equal(readRecords(join(folder, 'articles.jsonl')).length, 3, 'target 3: on resume only the remainder was collected (not 3 + 3)');
    const images = readRecords(join(folder, 'images.jsonl'));
    assert.ok(images.length >= 3 && images.every((o) => o.file), 'pending images downloaded on resume, records unique and with files');
    const log = (await p.queue.lastLog(job.id, 400)).join('\n');
    assert.match(log, /\d+ media not downloaded in the previous run were re-queued/);
    assert.match(log, /Site queue could not be read .*reading the backup/);
  } finally {
    await p.close();
    s.close();
  }
});

test('site search: on a site whose home page links to off-topic entries, the topic page is found by search and its links are crawled first by topic; site crawling stops at 60 pages on off-topic entries', async () => {
  const dictionary = 'elma armut kiraz vişne ceviz fındık kayısı şeftali erik dut incir nar deniz dağ orman nehir göl ova bulut yağmur kar rüzgâr güneş ay yıldız köprü kale saray çarşı liman fener bahçe tarla bağ çeşme kuyu değirmen han hamam kervan gemi tren yol patika vadi tepe kaya mağara ada koy sahil kumsal dalga martı leylek turna serçe baykuş tilki kirpi sincap'.split(' ');
  const sentence = (no, i) => Array.from({ length: 22 }, (_, k) => dictionary[(no * 131 + i * 17 + k * k * 7 + k) % dictionary.length]).join(' ');
  const text = (title, no, prefix, ek = '') => `<html lang="tr"><head><title>${title}</title></head><body><article><h1>${title}</h1>${Array.from({ length: 30 }, (_, i) => `<p>${prefix} ${sentence(no, i)}.</p>`).join('')}${ek}</article></body></html>`;
  // T (localhost): ansiklopedi. Ana sayfa yalniz konu disi maddelere baglanir; "minyatur" maddesine baglanti yok.
  const tRequests = [];
  let tAddress = '';
  const t = createServer((i, y) => {
    tRequests.push(i.url);
    const pages = {
      '/': `<html lang="tr"><head><title>Ansiklopedi</title></head><body><main>${Array.from({ length: 70 }, (_, n) => `<a href="/madde-${n}-eski-yazisi">Madde ${n}</a>`).join(' ')}</main></body></html>`,
      '/minyatur': text('Minyatür', 1, 'Osmanlı minyatür sanatı', `<p><a href="/levni-ve-minyatur-ustalari">Levnî</a> <a href="/madde-1-eski-yazisi">Madde 1</a></p>`),
      '/levni-ve-minyatur-ustalari': text('Levnî', 2, 'Osmanlı minyatür ustası Levnî'),
      '/kedi-gezgin-yazisi': text('Gezgin kedi', 5, 'Gezgin kedi yolculuğu', '<p><a href="/madde-2-eski-yazisi">Madde 2</a></p>'),
      ...Object.fromEntries(Array.from({ length: 70 }, (_, n) => [`/madde-${n}-eski-yazisi`, text(`Madde ${n}`, 100 + n, 'Eski cami ve medrese')])),
    };
    const v = pages[i.url];
    y.writeHead(v ? 200 : 404, { 'Content-Type': 'text/html' });
    y.end(v ?? '');
  });
  await new Promise((ok) => t.listen(0, '127.0.0.1', ok));
  tAddress = `http://localhost:${t.address().port}`;
  // Arama motoru + A sitesi (127.0.0.1): konu sorgusuna A'nin konu yazisi (T'ye baglanir); "site:localhost" sorgusuna
  // minyatur konusunda T'nin maddesi, baska konuda bos sonuc
  const searches = [];
  const a = createServer((i, y) => {
    const root = `http://127.0.0.1:${a.address().port}`;
    const u = new URL(i.url, root);
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q');
      searches.push(q);
      const result = q.startsWith('site:') ? (q.includes('minyat') ? [[`${tAddress}/minyatur`, 'MİNYATÜR']] : []) : [[`${root}/${q.includes('minyat') ? 'a-minyatur' : 'a-kedi'}`, 'A']];
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      y.end(`<rss><channel>${result.map(([l, b]) => `<item><title>${b}</title><link>${l}</link></item>`).join('')}</channel></rss>`);
      return;
    }
    const pages = {
      '/a-minyatur': text('Osmanlı minyatürleri', 3, 'Osmanlı minyatür', `<p><a href="${tAddress}/">Ansiklopedi</a></p>`),
      '/a-kedi': text('Gezgin kedi', 4, 'Gezgin kedi', `<p><a href="${tAddress}/kedi-gezgin-yazisi">Ansiklopedide gezgin kedi</a></p>`),
    };
    const v = pages[u.pathname];
    y.writeHead(v ? 200 : 404, { 'Content-Type': 'text/html' });
    y.end(v ?? '');
  });
  await new Promise((ok) => a.listen(0, '127.0.0.1', ok));
  const p = await createPanel({ setting: { dataSearchTemplate: `http://127.0.0.1:${a.address().port}/search?q={q}` } });
  try {
    const common = { extract: 'rule', minWord: 100, target: 0, depth: 1, parallel: 1, media: 'meta' };
    const last = await p.waitUntilDone(p.queue.add('data', { ...common, name: 'Minyatur arama', topic: 'Osmanlı minyatürleri' }).id, 120000);
    assert.equal(last.status, 'done', last.error);
    const log1 = readFileSync(join(p.queue.folder(last.id), 'log.txt'), 'utf8');
    assert.equal(searches.find((q) => q.startsWith('site:localhost')), 'site:localhost minyatür', 'site search with the distinctive stem word (plural suffix stripped)');
    assert.match(log1, /localhost: site search found 1 topic pages/);
    const texts = readRecords(join(p.root, 'data', 'collections', 'minyatur-arama', 'articles.jsonl')).map((k) => k.url.replace(tAddress, 'T'));
    assert.ok(texts.includes('T/minyatur') && texts.includes('T/levni-ve-minyatur-ustalari'), JSON.stringify(texts));
    // Konu sayfasi aramayla once; konu adresli baglanti (Levni) konu disi maddelerden once gezilir
    const firstItem = tRequests.findIndex((u) => u.startsWith('/madde-'));
    assert.ok(tRequests.indexOf('/minyatur') >= 0 && (firstItem < 0 || tRequests.indexOf('/minyatur') < firstItem), JSON.stringify(tRequests.slice(0, 8)));
    assert.ok(firstItem < 0 || tRequests.indexOf('/levni-ve-minyatur-ustalari') < firstItem, 'topic-addressed link first');

    // Tek konu yazisi olan site: arama bos, bagli konu yazisi alinir; site ici gezinme 70 konu disi maddede 60 sayfada birakilir
    tRequests.length = 0;
    const last2 = await p.waitUntilDone(p.queue.add('data', { ...common, name: 'Kedi arama', topic: 'Gezgin kedi' }).id, 120000);
    assert.equal(last2.status, 'done', last2.error);
    const log2 = readFileSync(join(p.queue.folder(last2.id), 'log.txt'), 'utf8');
    assert.match(log2, /site crawl 60 pages, 0 articles added \(no on-topic article in 60 pages, site dropped/);
    assert.ok(tRequests.filter((u) => u.startsWith('/madde-')).length <= 60, `${tRequests.length} istek`);
  } finally {
    await p.close();
    a.close();
    t.close();
  }
});

test('source: when a specific page is given, the page itself is taken (no fallback to the wiki "recent changes" feed); when the root is given, the content feed is followed and the wiki special feed is skipped', async () => {
  const words = 'minyatür nakkaş tezhip kalem renk altın sayfa kitap padişah saray sefer kuşatma at asker çadır bayrak ırmak köprü kale dağ'.split(' ');
  const body = (no) => Array.from({ length: 30 }, (_, i) => `<p>${Array.from({ length: 16 }, (_, k) => words[(no * 7 + i * 3 + k * k) % words.length]).join(' ')} ${no}-${i}.</p>`).join('');
  const requests = [];
  const s = createServer((i, y) => {
    requests.push(i.url);
    const root = `http://127.0.0.1:${s.address().port}`;
    const wiki = '<link rel="alternate" type="application/atom+xml" title="Son değişiklikler" href="/w/index.php?title=%C3%96zel:SonDe%C4%9Fi%C5%9Fiklikler&amp;feed=atom">';
    const pages = {
      '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /w/\n'],
      '/': ['text/html', `<html lang="tr"><head><title>Ana</title>${wiki}<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body><a href="/makale">Makale</a></body></html>`],
      '/feed.xml': ['application/rss+xml', `<rss><channel><item><title>Akış yazısı</title><link>${root}/akis-yazisi</link></item></channel></rss>`],
      '/makale': ['text/html', `<html lang="tr"><head><title>Osmanlı minyatürü</title>${wiki}</head><body><article><h1>Osmanlı minyatürü</h1>${body(1)}</article></body></html>`],
      '/akis-yazisi': ['text/html', `<html lang="tr"><head><title>Akış yazısı</title></head><body><article><h1>Akış yazısı</h1>${body(2)}</article></body></html>`],
    };
    const v = pages[i.url.split('?')[0] === '/w/index.php' ? '/none' : i.url];
    y.writeHead(v ? 200 : 404, { 'Content-Type': v?.[0] ?? 'text/plain' });
    y.end(v?.[1] ?? '');
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const address = `http://127.0.0.1:${s.address().port}`;
  const p = await createPanel();
  try {
    const page = await p.waitUntilDone(p.queue.add('data', { name: 'Tek sayfa', sources: [`${address}/makale`], extract: 'rule', minWord: 100, depth: 0 }).id, 30000);
    assert.equal(page.status, 'done', page.error);
    const k1 = readFileSync(join(p.root, 'data', 'collections', 'tek-sayfa', 'articles.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.deepEqual(k1.map((k) => k.title), ['Osmanlı minyatürü'], 'given page taken');
    assert.ok(!requests.some((u) => u.startsWith('/w/index.php') || u === '/feed.xml'), `no feed discovery for a page source: ${requests.join(' ')}`);
    const root = await p.waitUntilDone(p.queue.add('data', { name: 'Kok', sources: [`${address}/`], extract: 'rule', minWord: 100, depth: 0 }).id, 30000);
    assert.equal(root.status, 'done', root.error);
    const k2 = readFileSync(join(p.root, 'data', 'collections', 'kok', 'articles.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.deepEqual(k2.map((k) => k.title), ['Akış yazısı'], 'content feed followed at the root');
    assert.ok(!requests.some((u) => u.startsWith('/w/index.php')), 'wiki special feed not followed');
  } finally {
    await p.close();
    s.close();
  }
});

test('unsuitable sites: adult / gambling domains and their CDNs are caught, similar legitimate names (sussex, sexton, escorial) are not; a CDN image embedded in the page is not saved', async () => {
  const { isUnsuitable } = await import('../lib/data-collection.mjs');
  const yes = ['https://www.pornhub.com/x', 'https://ei.phncdn.com/pics/a.jpg', 'https://xhamster.com/', 'https://www.caesars.com/casino', 'https://hqporner.com', 'https://tubepornstars.com/a', 'https://my-casino-site.net', 'https://sex.com', 'https://best-escorts.co.uk', 'https://online.poker.org', 'https://canlibahis.com'];
  const no = ['https://www.sussex.ac.uk/', 'https://essexlive.news', 'https://tr.wikipedia.org/wiki/Osmanl%C4%B1', 'https://www.betterhelp.com', 'https://abc.xyz', 'https://sexton-family.org', 'https://escorial.es', 'https://pokerface-fans.net', 'https://slotsampler.io', 'https://bet.com'];
  assert.deepEqual(yes.filter((u) => !isUnsuitable(u)), [], 'all caught');
  assert.deepEqual(no.filter((u) => isUnsuitable(u)), [], 'legitimate names not caught');
  // Mesru sayfaya gomulu yetiskin CDN gorseli (meta kaydi; ag istegi gitmez)
  const words = 'minyatür nakkaş tezhip kalem renk altın sayfa kitap padişah saray sefer kuşatma at asker çadır bayrak ırmak köprü kale dağ'.split(' ');
  const body = Array.from({ length: 30 }, (_, i) => `<p>${Array.from({ length: 16 }, (_, k) => words[(i * 3 + k * k) % words.length]).join(' ')} ${i}.</p>`).join('');
  const s = createServer((i, y) => {
    y.writeHead(200, { 'Content-Type': 'text/html' });
    y.end(`<html lang="tr"><head><title>Minyatür sayfası</title></head><body><article><h1>Minyatür sayfası</h1>${body}<figure><img src="/minyatur.jpg" alt="Surname minyatürü" width="800" height="600"><figcaption>Surname minyatürü</figcaption></figure><img src="https://ei.phncdn.com/pics/kapak.jpg" alt="Yetişkin kapak" width="800" height="600"></article></body></html>`);
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const p = await createPanel();
  try {
    const last = await p.waitUntilDone(p.queue.add('data', { name: 'Gomulu', sources: [`http://127.0.0.1:${s.address().port}/makale`], extract: 'rule', minWord: 100, depth: 0, media: 'meta' }).id, 30000);
    assert.equal(last.status, 'done', last.error);
    const images = readFileSync(join(p.root, 'data', 'collections', 'gomulu', 'images.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.deepEqual(images.map((g) => g.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')), ['/minyatur.jpg'], 'CDN image not saved');
    assert.match(p.queue.lastLog(last.id, 20).join('\n'), /unsuitable 1/);
  } finally {
    await p.close();
    s.close();
  }
});

test('search candidate pre-filter: a result of a topic-bound query that drifted to an off-topic word is dropped (Bing "Ünlü …" -> tabloid); semantic matches, queries in another language / not bound to the topic and short titles are not judged; ı/i folded', async () => {
  const { isOffTopicResult, topicFitRule } = await import('../lib/data-collection.mjs');
  const topic = 'Osmanlı minyatürleri';
  // Olculdu 06.10.2026: "Ünlü Osmanlı minyatür sanatçıları" sorgusuna Bing'in 10 sonucunun 10'u magazin / borsa ("ünlü" tek ortak sozcuk)
  const vowel = 'Ünlü Osmanlı minyatür sanatçıları';
  assert.equal(isOffTopicResult(topic, vowel, 'Son Dakika Ünlüler Haberleri - Ünlüler Son Dakika', 'Ünlü isimlerin tatil pozları ve magazin dünyasından son gelişmeler'), true);
  assert.equal(isOffTopicResult(topic, vowel, 'ÜNLÜ Menkul Değerler - Yetkili Borsa Aracı Kurumu', ''), true);
  assert.equal(isOffTopicResult(topic, 'minyatür sanatı tarihi', 'Ankara’nın tarihi dokuları ATO’nun takviminde - Haber 7', ''), true, 'Google News drifted to "tarihi"');
  assert.equal(isOffTopicResult(topic, vowel, 'Levnî ve Osmanlı minyatür sanatı', 'Lale Devri nakkaşı'), false);
  assert.equal(isOffTopicResult(topic, vowel, "Matrakçı Nasuh'un üç kıtada yolculuğu - sabah.com.tr", ''), false, 'no word in common with the query: the engine may have matched semantically (Google News)');
  assert.equal(isOffTopicResult(topic, 'Osmanlı minyatür ustaları Levni Matrakçı', "Levni ve Matrakçı'nın eserleri sergide", ''), false, "the query's specific words (40%) appear");
  // Baska dildeki sorgu konuya baglanamaz (konu Turkce): Google Haberler "Ottoman miniature painting" sonuclari elenmez
  assert.equal(isOffTopicResult(topic, 'Ottoman miniature painting', 'Exhibition honors Ottoman genius Matrakçı Nasuh - Daily Sabah', ''), false);
  assert.equal(isOffTopicResult(topic, 'Ottoman miniature painting', 'Miniature: The art that bridged Silk Road empires - The Standard', ''), false);
  assert.equal(isOffTopicResult(topic, 'nakkaşhane tarihi', 'Nakkaşhane - Vikipedi özgür ansiklopedi', ''), false, 'synonym / query without the topic word');
  assert.equal(isOffTopicResult(topic, 'site:ornek.org Osmanlı nakkaşları', 'Nakkaşların günlük yaşamı ve atölyeleri', ''), false, 'site: operator does not count toward the query criterion');
  assert.equal(isOffTopicResult(topic, vowel, 'Ünlüler A1', ''), false, 'short title not judged');
  assert.equal(isOffTopicResult('', 'kedi', 'Son dakika ünlüler haberleri', ''), false, 'not filtered without a topic');
  assert.equal(topicFitRule('islamic art', 'ISLAMIC ART HISTORY'), 5, 'ı/i folded (Turkish lowercasing turns "I" into "ı")');
  assert.equal(topicFitRule('Osmanlı minyatürleri', 'OSMANLI MİNYATÜRLERİ'), 5);
});

test('search candidate pre-filter (end to end): a drifted result is never requested, the on-topic candidate is crawled; count in the log', async () => {
  const requested = [];
  const words = 'minyatür nakkaş tezhip kalem renk altın sayfa kitap padişah saray sefer kuşatma at asker çadır bayrak ırmak köprü kale dağ'.split(' ');
  const body = (n) => Array.from({ length: 30 }, (_, i) => `<p>Osmanlı minyatür ${Array.from({ length: 16 }, (_, k) => words[(n * 7 + i * 3 + k * k) % words.length]).join(' ')} ${n}-${i}.</p>`).join('');
  const s = createServer((i, y) => {
    const root = `http://127.0.0.1:${s.address().port}`;
    const u = new URL(i.url, root);
    requested.push(u.pathname);
    if (u.pathname === '/search') {
      // "… rehber" sorgusunda motor "rehber"e kayiyor (magazin rehberi); her sorguda konulu sonuc da var
      const sliding = (u.searchParams.get('q') ?? '').includes('rehber') ? `<item><title>Magazin rehberi: ünlülerin tatil adresleri</title><link>${root}/magazin</link><description>Ünlü isimlerin gittiği mekanlar ve son gelişmeler</description></item>` : '';
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return void y.end(`<rss><channel>${sliding}<item><title>Osmanlı minyatür sanatı rehberi</title><link>${root}/minyatur</link><description>Nakkaşhane ve Levnî</description></item></channel></rss>`);
    }
    const pages = {
      '/minyatur': `<html lang="tr"><head><title>Osmanlı minyatür sanatı rehberi</title></head><body><article><h1>Osmanlı minyatür sanatı rehberi</h1>${body(1)}</article></body></html>`,
      '/magazin': `<html lang="tr"><head><title>Ünlüler</title></head><body><article><h1>Ünlüler</h1>${body(2)}</article></body></html>`,
    };
    const v = pages[u.pathname];
    y.writeHead(v ? 200 : 404, { 'Content-Type': 'text/html' });
    y.end(v ?? '');
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const p = await createPanel({ setting: { dataSearchTemplate: `http://127.0.0.1:${s.address().port}/search?q={q}` } });
  try {
    const last = await p.waitUntilDone(p.queue.add('data', { name: 'On suzme', topic: 'Osmanlı minyatürleri', extract: 'rule', minWord: 100, target: 0, depth: 0, parallel: 1, media: 'meta' }).id, 60000);
    assert.equal(last.status, 'done', last.error);
    assert.ok(requested.includes('/minyatur'), 'konulu aday gezildi');
    assert.ok(!requested.includes('/magazin'), 'drifted candidate not requested');
    const log = p.queue.lastLog(last.id, 60).join('\n');
    assert.match(log, /1 candidate titles off-topic \(not crawled\)/);
    assert.match(log, /offTopicResults 1/);
  } finally {
    await p.close();
    s.close();
  }
});

test("Wikipedia search engine: API address in the query's language; from the response, in order, the article address, title and lead summary", async () => {
  const { SEARCH_ENGINES, searchUrl, searchResults } = await import('../lib/data-collection.mjs');
  assert.ok(SEARCH_ENGINES.includes('wiki'));
  const a = new URL(searchUrl('wiki', 'Osmanlı minyatürleri', 'tr'));
  assert.equal(a.origin, 'https://tr.wikipedia.org');
  assert.equal(a.searchParams.get('gsrsearch'), 'Osmanlı minyatürleri');
  assert.equal(a.searchParams.get('prop'), 'info|extracts');
  assert.equal(new URL(searchUrl('wiki', 'Ottoman miniature', 'en')).hostname, 'en.wikipedia.org');
  assert.equal(new URL(searchUrl('wiki', 'x', 'kötü dil')).hostname, 'tr.wikipedia.org');
  const response = JSON.stringify({ batchcomplete: true, query: { pages: [
    { pageid: 2, ns: 0, title: 'Levnî', index: 2, fullurl: 'https://tr.wikipedia.org/wiki/Levn%C3%AE', extract: 'Levnî, Lale Devri Osmanlı minyatür sanatçısı.' },
    { pageid: 1, ns: 0, title: 'Osmanlı minyatürü', index: 1, fullurl: 'https://tr.wikipedia.org/wiki/Osmanl%C4%B1_minyat%C3%BCr%C3%BC', extract: 'Osmanlı İmparatorluğu\'nda gelişen resim sanatı.' },
    { pageid: 3, ns: 0, title: 'Adressiz', index: 3 },
  ] } });
  assert.deepEqual(searchResults(response, 'wiki'), [
    { url: 'https://tr.wikipedia.org/wiki/Osmanl%C4%B1_minyat%C3%BCr%C3%BC', title: 'Osmanlı minyatürü', summary: 'Osmanlı İmparatorluğu\'nda gelişen resim sanatı.' },
    { url: 'https://tr.wikipedia.org/wiki/Levn%C3%AE', title: 'Levnî', summary: 'Levnî, Lale Devri Osmanlı minyatür sanatçısı.' },
  ]);
  assert.deepEqual(searchResults('{"batchcomplete":true}', 'wiki'), [], 'response with no results');
  assert.deepEqual(searchResults('{bozuk', 'wiki'), [], 'bozuk JSON');
});

test('after a search, no home page discovery on a huge general site (like Wikipedia); on an ordinary site it happens at 2+ accepted', async () => {
  const dictionary = 'elma armut kiraz vişne ceviz fındık kayısı şeftali erik dut incir nar deniz dağ orman nehir göl ova bulut yağmur kar rüzgâr güneş ay yıldız köprü kale saray çarşı liman fener bahçe tarla bağ çeşme kuyu değirmen han hamam kervan gemi tren yol patika vadi tepe kaya mağara ada koy sahil kumsal dalga martı leylek turna serçe baykuş tilki kirpi sincap'.split(' ');
  const sentence = (no, i) => Array.from({ length: 22 }, (_, k) => dictionary[(no * 131 + i * 17 + k * k * 7 + k) % dictionary.length]).join(' ');
  const s = createServer((i, y) => {
    const root = `http://127.0.0.1:${s.address().port}`;
    const u = new URL(i.url, root);
    if (u.pathname === '/search') {
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return void y.end(`<rss><channel>${[1, 2, 3].map((n) => `<item><title>Osmanlı minyatür maddesi ${n}</title><link>${root}/madde-${n}</link></item>`).join('')}</channel></rss>`);
    }
    const m = /^\/madde-(\d)$/.exec(u.pathname);
    if (!m) return void y.writeHead(404).end('');
    y.writeHead(200, { 'Content-Type': 'text/html' });
    y.end(`<html lang="tr"><head><title>Osmanlı minyatür maddesi ${m[1]}</title></head><body><article><h1>Osmanlı minyatür maddesi ${m[1]}</h1>${Array.from({ length: 30 }, (_, k) => `<p>Osmanlı minyatür ${sentence(Number(m[1]), k)}.</p>`).join('')}</article></body></html>`);
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  try {
    for (const [wide, discovery] of [[['127.0.0.1'], false], [null, true]]) {
      const p = await createPanel({ setting: { dataSearchTemplate: `http://127.0.0.1:${s.address().port}/search?q={q}`, dataWideSites: wide } });
      try {
        const last = await p.waitUntilDone(p.queue.add('data', { name: `Genis ${discovery}`, topic: 'Osmanlı minyatürleri', extract: 'rule', minWord: 100, target: 0, depth: 0, parallel: 1, media: 'meta' }).id, 60000);
        assert.equal(last.status, 'done', last.error);
        const log = p.queue.lastLog(last.id, 100).join('\n');
        assert.match(log, /Search finished: 3 candidate pages, 1 sites/);
        assert.match(log, /Done: 3 new articles/);
        // Kesif ana sayfayi (https://<site>/) kaynak olarak isler; yerel test sunucusu http oldugu icin hata satiri birakir
        assert.equal(log.includes('https://127.0.0.1/'), discovery, discovery ? 'discovery attempted on the ordinary site' : 'no discovery on the huge general site');
      } finally {
        await p.close();
      }
    }
  } finally {
    s.close();
  }
});

test('PDF: a long number sequence without TJ (font widths) does not lock up the parser (exponential backtracking); object stream not read; page text read', async () => {
  const { spawnSync } = await import('node:child_process');
  // Ayri surecte: eski desen olay dongusunu kilitledigi icin test zamanlayicisi hic calismazdi
  const code = `import { pdfText } from ${JSON.stringify(new URL('../lib/read-document.mjs', import.meta.url).href)};
const akis = (sozluk, ic) => sozluk.replace('>>', '/Length ' + ic.length + ' >>') + '\\nstream\\n' + ic + '\\nendstream';
const pdf = ['%PDF-1.4',
  '1 0 obj', akis('<< >>', 'BT [ ' + Array.from({ length: 60 }, () => '586').join(' ') + ' ] ET'), 'endobj',
  '2 0 obj', akis('<< /Type /ObjStm /N 1 /First 4 >>', '9 0 BT (Nesne akisi metni) Tj ET'), 'endobj',
  '3 0 obj', akis('<< >>', 'BT /F1 12 Tf (Merhaba dunya) Tj ET'), 'endobj', '%%EOF'].join('\\n');
const t = Date.now();
const text = pdfText(Buffer.from(pdf, 'latin1'));
console.log(JSON.stringify({ text, ms: Date.now() - t }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.error?.code, undefined, 'parser finished within 15 s');
  assert.equal(r.status, 0, r.stderr);
  const { text, ms } = JSON.parse(r.stdout.trim());
  assert.equal(text.split('Merhaba dunya').length - 1, 1, 'page text read once (endstream not counted as a stream start)');
  assert.doesNotMatch(text, /Nesne akisi/);
  assert.ok(ms < 2000, `${ms} ms`);
});

test('site hopping: no hop to wiki editions outside the requested languages or to Wikimedia subdomains other than Commons', async () => {
  const { isOtherWikiLanguage } = await import('../lib/data-collection.mjs');
  const languages = ['tr', 'en'];
  assert.deepEqual(['tr.wikipedia.org', 'en.wikipedia.org', 'en.m.wikipedia.org', 'tr.wikisource.org', 'commons.wikimedia.org', 'islamansiklopedisi.org.tr', 'simple.wikipedia.org'].filter((h) => isOtherWikiLanguage(h, languages)), []);
  assert.deepEqual(['nl.wikipedia.org', 'ckb.wikipedia.org', 'zh-min-nan.wikipedia.org', 'de.wiktionary.org', 'developer.wikimedia.org', 'foundation.wikimedia.org', 'upload.wikimedia.org', 'meta.wikimedia.org'].filter((h) => !isOtherWikiLanguage(h, languages)), []);
  assert.equal(isOtherWikiLanguage('nl.wikipedia.org', []), false, 'no language filter when no language is given');
});

test('focused topic match in rule mode: a single occurrence of the topic word in a long text is not enough; it must be in the title + lead or spread across the text', async () => {
  const { topicFitFocused, topicFitRule } = await import('../lib/data-collection.mjs');
  const topic = 'Osmanlı minyatürleri';
  const padding = (n) => Array.from({ length: n }, (_, i) => ['tower', 'liman', 'şehir', 'surlar', 'Osmanlı', 'yapı', 'dateText', 'deniz'][i % 8]).join(' ');
  // "Galata Kulesi" gibi: 3000 sozcuk, "Osmanlı" sik, "minyatür" bir kez ve giriste degil
  const tower = `${padding(1500)} bir minyatürde kule görülür ${padding(1500)}`;
  assert.equal(topicFitRule(topic, `Galata Kulesi\n${tower}`), 5, 'old measure: a single occurrence was enough');
  assert.ok(topicFitFocused(topic, 'Galata Kulesi', tower) < 4);
  assert.equal(topicFitFocused(topic, 'Osmanlı minyatürü', tower), 5, 'topic in the title');
  // Kisa haber: baslikta "minyatür", giriste "Osmanlı"
  assert.equal(topicFitFocused(topic, 'Minyatür sergisi açıldı', `Sergide Osmanlı dönemine ait eserler var. ${padding(200)}`), 5);
  // Uzun ama konuya yayilmis metin
  const spread = Array.from({ length: 10 }, () => `${padding(290)} Osmanlı minyatür sanatı`).join(' ');
  assert.equal(topicFitFocused(topic, 'Nakkaşhane', spread), 5);
  assert.equal(topicFitFocused('', 'x', 'y'), 5, 'no block without a topic');
});

test('Google News link: id, page signature, batchexecute body and publisher address from its response', async () => {
  const { gnewsId, gnewsSignature, gnewsResolveBody, gnewsResolveResponse } = await import('../lib/data-collection.mjs');
  assert.equal(gnewsId('https://news.google.com/rss/articles/CBMiggFBVV95cUxN?oc=5'), 'CBMiggFBVV95cUxN');
  assert.equal(gnewsId('https://news.google.com/articles/CBMi-wFBVV9_x'), 'CBMi-wFBVV9_x');
  assert.equal(gnewsId('https://news.google.com/topics/abc'), null);
  assert.equal(gnewsId('https://example.com/rss/articles/abc'), null);
  assert.deepEqual(gnewsSignature('<c-wiz jsrenderer="x" data-n-a-ts="1759700000" data-n-a-sg="AZ5r_sig-1"></c-wiz>'), { sg: 'AZ5r_sig-1', ts: 1759700000 });
  assert.equal(gnewsSignature('<html>imza yok</html>'), null);
  const body = gnewsResolveBody('KIMLIK', { sg: 'IMZA', ts: 123 });
  assert.match(body, /^f\.req=/);
  const dis = JSON.parse(decodeURIComponent(body.slice(6)));
  assert.equal(dis[0][0][0], 'Fbv4je');
  const ic = JSON.parse(dis[0][0][1]);
  assert.deepEqual([ic[0], ic[2], ic[3], ic[4]], ['garturlreq', 'KIMLIK', 123, 'IMZA']);
  const response = `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.yenisafak.com/hayat/osmanli-izini-4859545\\",1]",null,null,null,"generic"],["di",42]]\n25\n[["e",4,null,null,123]]`;
  assert.equal(gnewsResolveResponse(response), 'https://www.yenisafak.com/hayat/osmanli-izini-4859545');
  assert.equal(gnewsResolveResponse(')]}\'\n\n[["er",null,null,null,null,400]]'), null);
});

test('Google News (end to end): the search result is resolved to the publisher address, the Google page does not count as an article; an unresolvable one counts', async () => {
  const requests = [];
  let batch = null;
  const dictionary = 'elma armut kiraz vişne ceviz fındık kayısı şeftali erik dut incir nar deniz dağ orman nehir göl ova bulut yağmur kar rüzgâr güneş ay yıldız köprü kale saray çarşı liman fener bahçe tarla bağ çeşme kuyu değirmen han hamam kervan gemi tren yol patika vadi tepe kaya mağara ada koy sahil kumsal dalga martı leylek turna serçe baykuş tilki kirpi sincap'.split(' ');
  const sentence = (no, i) => Array.from({ length: 22 }, (_, k) => dictionary[(no * 131 + i * 17 + k * k * 7 + k) % dictionary.length]).join(' ');
  const s = createServer(async (i, y) => {
    const root = `http://127.0.0.1:${s.address().port}`;
    const u = new URL(i.url, root);
    requests.push(`${i.method} ${u.pathname}`);
    if (u.pathname === '/search') {
      y.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return void y.end(`<rss><channel><item><title>Osmanlı minyatür sergisi açıldı - Haber</title><link>${root}/rss/articles/ABC?oc=5</link></item><item><title>Osmanlı minyatür ustaları anıldı - Gazete</title><link>${root}/rss/articles/IMZASIZ?oc=5</link></item></channel></rss>`);
    }
    if (u.pathname === '/rss/articles/ABC') {
      y.writeHead(200, { 'Content-Type': 'text/html' });
      return void y.end(`<html><head><title>Google News</title></head><body><script>${'x'.repeat(5000)}</script><c-wiz data-n-a-sg="SIG_1" data-n-a-ts="1759700000"></c-wiz></body></html>`);
    }
    if (u.pathname === '/rss/articles/IMZASIZ') {
      y.writeHead(200, { 'Content-Type': 'text/html' });
      return void y.end('<html><head><title>Google News</title></head><body>imza yok</body></html>');
    }
    if (u.pathname === '/_/DotsSplashUi/data/batchexecute' && i.method === 'POST') {
      let body = '';
      for await (const p of i) body += p;
      batch = decodeURIComponent(body);
      y.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return void y.end(`)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"${root}/haber/minyatur-sergisi\\",1]",null,null,null,"generic"]]`);
    }
    if (u.pathname === '/haber/minyatur-sergisi') {
      y.writeHead(200, { 'Content-Type': 'text/html' });
      return void y.end(`<html lang="tr"><head><title>Osmanlı minyatür sergisi açıldı</title></head><body><article><h1>Osmanlı minyatür sergisi açıldı</h1>${Array.from({ length: 30 }, (_, k) => `<p>Osmanlı minyatür ${sentence(7, k)}.</p>`).join('')}</article></body></html>`);
    }
    y.writeHead(404);
    y.end('');
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const root = `http://127.0.0.1:${s.address().port}`;
  const p = await createPanel({ setting: { dataSearchTemplate: `${root}/search?q={q}`, dataGnewsAddress: root } });
  try {
    const last = await p.waitUntilDone(p.queue.add('data', { name: 'Gnews', topic: 'Osmanlı minyatürleri', extract: 'rule', minWord: 100, target: 0, depth: 0, parallel: 1, media: 'meta', hopSites: false }).id, 60000);
    assert.equal(last.status, 'done', last.error);
    assert.match(batch ?? '', /garturlreq/);
    assert.match(batch, /ABC/);
    assert.match(batch, /SIG_1/);
    const texts = readFileSync(join(p.root, 'data', 'collections', 'gnews', 'articles.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.deepEqual(texts.map((x) => new URL(x.url).pathname), ['/haber/minyatur-sergisi']);
    assert.equal(requests.filter((x) => x === 'POST /_/DotsSplashUi/data/batchexecute').length, 1, 'no resolve request for an unsigned page');
    const log = p.queue.lastLog(last.id, 80).join('\n');
    assert.match(log, /gnewsUnresolved 1/);
  } finally {
    await p.close();
    s.close();
  }
});

test('HTML entities in the JSON-LD title are decoded (the CMS writes "UNESCO&#039;ya")', async () => {
  const { pageMetadata } = await import('../lib/data-collection.mjs');
  const html = (title) => `<html lang="tr"><head><title>T</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"${title}","description":"A &amp; B","author":{"@type":"Person","name":"Ay&#351;e"}}</script></head><body></body></html>`;
  assert.equal(pageMetadata(html('Minyatür sanatı UNESCO&#039;ya kayıt edildi')).title, "Minyatür sanatı UNESCO'ya kayıt edildi");
  assert.equal(pageMetadata(html('Osmanlı&apos;nın minyatür saat kuleleri')).title, "Osmanlı'nın minyatür saat kuleleri");
  const u = pageMetadata(html('Tom & Jerry'));
  assert.equal(u.title, 'Tom & Jerry', 'a non-entity & is not mangled');
  assert.equal(u.metaDescription, 'A & B');
  assert.equal(u.author, 'Ayşe');
});
