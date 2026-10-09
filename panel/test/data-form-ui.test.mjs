/**
 * Training › Data collection form (user request 09.10.2026): the search services with their state, the MCP servers and
 * the skills the job can use come from GET /api/v1/data/sources; the choices reach the job's fields. Headless
 * Edge/Chrome against a panel with a fake MCP server, skills of the project and a key for one search service;
 * the search addresses point at a local site, and the job is cancelled at once. Skipped without Edge/Chrome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanel } from './env.mjs';
import { Browser, browserPath } from '../lib/browser.mjs';

const FAKE_MCP = fileURLToPath(new URL('./fake-mcp.mjs', import.meta.url));
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

const openEnglish = async (t, address) => {
  await t.goto(address);
  await t.evaluate("localStorage.setItem('lang', 'en'); true");
  await t.goto(address);
};

const collectErrors = (t, errors) => {
  t.events.set('Runtime.exceptionThrown', [(o) => errors.push(`exception: ${o.exceptionDetails?.exception?.description ?? o.exceptionDetails?.text}`)]);
  t.events.set('Runtime.consoleAPICalled', [(o) => {
    if (o.type === 'error') errors.push(`console.error: ${o.args.map((a) => a.value ?? a.description).join(' ')}`);
  }]);
};

test('UI data collection form: the search services with their state, MCP servers and skills to choose; the choices reach the job; Turkish labels; no Turkish leftovers on the English page (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  // a local site for every search the job might make before it is cancelled (never the real services)
  const site = createServer((i, y) => {
    y.writeHead(i.url.startsWith('/search') ? 200 : 404, { 'Content-Type': 'application/rss+xml' });
    y.end('<rss><channel></channel></rss>');
  });
  const root = await new Promise((ok) => site.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${site.address().port}`)));
  const p = await createPanel({ server: true, setting: { dataSearchTemplate: `${root}/search?q={q}`, agentSearchApis: { brave: `${root}/brave`, tavily: `${root}/tavily` }, dataWideSites: ['127.0.0.1'] } });
  mkdirSync(p.setting.dataRoot, { recursive: true });
  writeFileSync(join(p.setting.dataRoot, 'mcp.json'), JSON.stringify({ mcpServers: { fakedata: { command: process.execPath, args: [FAKE_MCP, '--data', root] }, off: { command: process.execPath, args: [FAKE_MCP], disabled: true } } }));
  // skills of the project (<ai>\.claude\skills)
  const home = p.setting.aiRoot;
  for (const [name, description] of [['kedi-kaynaklari', 'Finding sources about cats'], ['arsiv-okuma', 'Gazete arşivlerini okuma (eski sayfalar)'], ['yemek-tarifleri', 'Cooking recipes']]) {
    mkdirSync(join(home, '.claude', 'skills', name), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
  }
  p.settingFile.saveWebSearch({ brave: 'BSAuiFormKey1234' });
  const t = new Browser({ height: 900 });
  const errors = [];
  const until = async (expression, ms = 10000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return true;
    return false;
  };
  try {
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/#training/data`);
    assert.ok(await until("document.querySelectorAll('[data-data-engines] input[name=engine]').length === 7"), 'the engines are listed');
    const engines = await t.evaluate(`[...document.querySelectorAll('[data-data-engines] label')].map((l) => { const i = l.querySelector('input'); return [i.value, i.checked, i.disabled, l.textContent]; })`);
    assert.deepEqual(engines, [
      ['brave', true, false, 'Brave Searchkey set'],
      ['tavily', false, true, 'TavilyNot set'],
      ['searxng', false, true, 'SearXNGNot set'],
      ['bing', true, false, 'Bingno key'],
      ['ddg', true, false, 'DuckDuckGono key'],
      ['gnews', true, false, 'Google Newsno key'],
      ['wiki', true, false, 'Wikipediano key'],
    ]);
    assert.equal(await t.evaluate("document.documentElement.outerHTML.includes('BSAuiFormKey1234')"), false, 'no key on the page');
    // the lists show when "Choose" is picked; a server that is off is not offered
    const lists = await t.evaluate(`(async () => {
      const f = document.querySelector('[data-data-form]');
      const hiddenBefore = [document.querySelector('[data-data-mcp-list]').hidden, document.querySelector('[data-data-skill-list]').hidden];
      f.mcpMode.value = 'pick';
      f.mcpMode.dispatchEvent(new Event('change', { bubbles: true }));
      f.skillsMode.value = 'pick';
      f.skillsMode.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        hiddenBefore,
        hiddenAfter: [document.querySelector('[data-data-mcp-list]').hidden, document.querySelector('[data-data-skill-list]').hidden],
        mcp: [...document.querySelectorAll('[data-data-mcp-list] input')].map((i) => i.value),
        skills: [...document.querySelectorAll('[data-data-skill-list] input')].map((i) => i.value),
        description: document.querySelector('[data-data-skill-list] input[value="arsiv-okuma"]').closest('label').textContent,
      };
    })()`);
    assert.deepEqual(lists, { hiddenBefore: [true, true], hiddenAfter: [false, false], mcp: ['fakedata'], skills: ['arsiv-okuma', 'kedi-kaynaklari', 'yemek-tarifleri'], description: 'arsiv-okumaGazete arşivlerini okuma (eski sayfalar)' });
    assert.deepEqual(await t.evaluate('window.NedeseLang.missing()'), [], 'a skill\'s own Turkish description is not a leftover');
    // "Choose" with nothing chosen is refused on the page
    await t.evaluate(`(() => { const f = document.querySelector('[data-data-form]'); f.name.value = 'Form deneme'; f.topic.value = 'gezgin kedi'; f.requestSubmit(); return true; })()`);
    await wait(300);
    assert.equal(p.queue.list({ type: 'data' }).length, 0, 'no job without a chosen server');
    // the choices reach the job
    await t.evaluate(`(() => {
      const f = document.querySelector('[data-data-form]');
      f.querySelector('[data-data-engines] input[value="ddg"]').checked = false;
      f.querySelector('[data-data-mcp-list] input[value="fakedata"]').checked = true;
      f.querySelector('[data-data-skill-list] input[value="kedi-kaynaklari"]').checked = true;
      f.serviceLimit.value = '7';
      f.mcpCalls.value = '3';
      f.extract.value = 'rule';
      f.requestSubmit();
      return true;
    })()`);
    let job = null;
    for (const end = Date.now() + 10000; !job && Date.now() < end; await wait(100)) job = p.queue.jobs.get(p.queue.list({ type: 'data' })[0]?.id) ?? null;
    assert.ok(job, 'the job was added');
    try {
      p.queue.cancel(job.id);
    } catch {}
    await p.waitUntilDone(job.id, 30000);
    assert.deepEqual([job.input.engines, job.input.serviceLimit, job.input.mcp, job.input.mcpCalls, job.input.skills], [['brave', 'bing', 'gnews', 'wiki'], 7, ['fakedata'], 3, ['kedi-kaynaklari']]);
    // Turkish: labels, states and hints from the dictionary; the skill's description stays as written
    await t.evaluate(`document.querySelector('[data-language-select="tr"]').click()`);
    assert.ok(await until(`document.querySelector('label[for="vt-skills"]').textContent === 'Beceriler (konu, yerel model)'`), 'skills label in Turkish');
    const tr = await t.evaluate(`({
      engines: document.querySelector('[data-data-engines]').closest('.field').querySelector('.field__label').textContent,
      brave: document.querySelector('[data-data-engines] input[value="brave"]').closest('label').textContent,
      tavily: document.querySelector('[data-data-engines] input[value="tavily"]').closest('label').textContent,
      mcp: document.querySelector('label[for="vt-mcp"]').textContent,
      auto: document.querySelector('#vt-skills option[value="auto"]').textContent,
      limit: document.querySelector('label[for="vt-service-limit"]').textContent,
      description: document.querySelector('[data-data-skill-list] input[value="yemek-tarifleri"]').closest('label').textContent,
    })`);
    assert.deepEqual(tr, { engines: 'Arama motorları (konu)', brave: 'Brave Searchanahtar ayarlı', tavily: 'TavilyAyarlı değil', mcp: 'MCP sunucuları (konu)', auto: 'Otomatik: model konuya uyanları seçer', limit: 'Hizmet başına arama (çalıştırma başına, 0 sınırsız)', description: 'yemek-tarifleriCooking recipes' });
    await t.evaluate(`document.querySelector('[data-language-select="en"]').click()`);
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await p.close();
    await new Promise((ok) => site.close(ok));
  }
});
