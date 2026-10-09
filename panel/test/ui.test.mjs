/**
 * Arayuz duman testi (basliksiz Edge/Chrome, CDP): panel acilir; her bolum, Egitim'in her alani, Video'da her model
 * ve dil secimi gezilir; sayfada yakalanmamis istisna ya da console.error olmamali. node --check ve birim testleri
 * calisma zamani hatasini yakalamiyordu (05.10.2026: bir secici hatasi panelin acilisini ~40 dk bozdu).
 * Kaynak dil Ingilizce (08.10.2026): Ingilizce sayfada Turkce kalinti (çğıöşü) olmamali; TR secimi sozlukle cevirir.
 * Makinede Edge/Chrome yoksa atlanir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPanel } from './env.mjs';
import { Browser, browserPath } from '../lib/browser.mjs';
import { LocalLlm } from '../lib/llm.mjs';
import { CATALOG } from '../lib/models.mjs';

const SECTIONS = ['image', 'video', 'voice', 'music', 'edit', 'model3d', 'film', 'gallery', 'training', 'settings'];
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const FAKE_LLM = fileURLToPath(new URL('./fake-llm.mjs', import.meta.url));
const freePort = () => new Promise((ok) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});

/**
 * Tarayici tr-TR ile acilir (lib/browser.mjs) ve lang.js varsayilani tarayici dilinden alir: sayfa, kayitli secim
 * (localStorage "lang") Ingilizce yazildiktan sonra yeniden acilir; sablondan kopyalanan sahne / ses alanlari da
 * boylece kaynak dilde (Ingilizce) kurulur.
 */
const openEnglish = async (t, address) => {
  await t.goto(address);
  // an empty draft under the key of the Turkish-named versions: the page moves it to the English key once
  await t.evaluate("localStorage.setItem('lang', 'en'); localStorage.removeItem('aiPanel.draft.v1'); localStorage.setItem('aiPanel.taslak.v1', '{}'); true");
  // the same address with a #section would only change the hash (no reload): a blank page in between loads it again
  await t.goto('about:blank', { settleMs: 0 });
  await t.goto(address);
  assert.equal(await t.evaluate("localStorage.getItem('aiPanel.taslak.v1')"), null, 'the old draft key is gone after the page opened');
};

const collectErrors = (t, errors) => {
  t.events.set('Runtime.exceptionThrown', [(o) => errors.push(`exception: ${o.exceptionDetails?.exception?.description ?? o.exceptionDetails?.text}`)]);
  t.events.set('Runtime.consoleAPICalled', [(o) => {
    if (o.type === 'error') errors.push(`console.error: ${o.args.map((a) => a.value ?? a.description).join(' ')}`);
  }]);
};

test('UI: sections, training fields, video models and the language toggle work without console errors; the English page has no Turkish leftovers (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const p = await createPanel({ server: true });
  const t = new Browser({ height: 900 });
  const errors = [];
  try {
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/`);
    assert.equal(await t.evaluate('typeof window.NedesePanel'), 'object', 'app.js startup completed');
    assert.equal(await t.evaluate('window.NedeseLang?.language'), 'en', 'lang.js loaded with the stored language');
    // Ingilizce: her bolumde gorunen metin, yer tutucu ve ipuclarinda Turkce harf kalmamali (kaynak dil Ingilizce)
    const leftovers = new Set();
    for (const b of SECTIONS) {
      await t.evaluate(`location.hash = '#${b}'`);
      await wait(250);
      for (const m of await t.evaluate('window.NedeseLang.missing()')) leftovers.add(`${b}: ${m}`);
    }
    assert.deepEqual([...leftovers], [], 'Turkish text left on the English page');
    // the Text section is gone (user decision 09.10.2026: the chat does its work): not in the menu, no page for it
    assert.deepEqual(await t.evaluate("[...document.querySelectorAll('[data-sub-tab]')].map((a) => a.dataset.subTab)"), ['image', 'video', 'voice', 'music', 'film', 'edit', 'model3d'], 'Production tabs');
    assert.equal(await t.evaluate("Boolean(document.querySelector('[data-section=text], [data-text-form], a[href=\"#text\"]'))"), false, 'something of the Text section is left');
    // Egitim: her alan (yontem, temel listesi, ipucu, alan bloklari degisir)
    const fields = await t.evaluate(`(async () => {
      location.hash = '#training';
      await new Promise((r) => setTimeout(r, 400));
      const f = document.querySelector('[name=field]').form;
      const d = [];
      for (const o of [...f.field.options].filter((x) => !x.disabled)) {
        f.field.value = o.value;
        f.field.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        d.push(o.value);
      }
      return d;
    })()`);
    for (const a of ['text', 'code', 'image', 'music', 'video', 'general']) assert.ok(fields.includes(a), `field ${a}: ${fields.join(',')}`);
    // Video: her model (LoRA alani yalniz wan5'te)
    await t.evaluate(`(async () => {
      location.hash = '#video';
      await new Promise((r) => setTimeout(r, 300));
      const f = document.querySelector('[data-job-form="video"]');
      for (const o of [...f.model.options]) {
        f.model.value = o.value;
        f.model.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
      }
      return true;
    })()`);
    // Video sure ipucu ve tahmini: anahtar kare (A14B, cok parca) suresi eklenir. 06.10.2026 hatasi: anahtar kare kapali ya da
    // tek parcada olcum varken de "no timing measured" ekleniyordu ("else" yeni satira baglanmisti).
    const hint = await t.evaluate(`(async () => {
      const f = document.querySelector('[data-job-form="video"]');
      window.NedesePanel.status.averages = { ...(window.NedesePanel.status.averages ?? {}), 'video/wan14/720p': 76 };
      const duration = f.querySelector('[data-duration-preset]');
      const read = async (s, key) => {
        duration.value = s;
        f.model.value = 'wan14';
        f.resolution.value = '720p';
        f.keyFrame.checked = key;
        f.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
        return { hint: f.querySelector('[data-duration-hint]').textContent, estimate: document.querySelector('[data-estimate="video"]').textContent };
      };
      return { defaultValue: f.keyFrame.defaultChecked, isOpen: await read('60', true), closed: await read('60', false), single: await read('5', true) };
    })()`);
    assert.equal(hint.defaultValue, true, 'keyframe checkbox is checked by default');
    assert.match(hint.isOpen.hint, /Keyframes on: .*Keyframes ≈ .+ more\./, hint.isOpen.hint);
    for (const x of [hint.isOpen, hint.closed, hint.single]) assert.doesNotMatch(x.hint, /no timing measured/, x.hint);
    assert.doesNotMatch(hint.closed.hint, /Keyframes/, hint.closed.hint);
    assert.doesNotMatch(hint.single.hint, /Keyframes/, 'no keyframes for a single part');
    assert.notEqual(hint.isOpen.estimate, hint.closed.estimate, 'total estimate includes the keyframe time');
    // Turkce: ceviri gozcusu (sozluk) sayfanin tamaminda calisir, sonra Ingilizceye donus
    await t.evaluate(`document.querySelector('[data-language-select="tr"]').click()`);
    await wait(500);
    assert.equal(await t.evaluate('window.NedeseLang.language'), 'tr', 'TR button selects Turkish');
    for (const b of ['image', 'training', 'settings']) {
      await t.evaluate(`location.hash = '#${b}'`);
      await wait(250);
    }
    await t.evaluate(`document.querySelector('[data-language-select="en"]').click()`);
    await wait(300);
    assert.equal(await t.evaluate('window.NedeseLang.language'), 'en', 'EN button selects English');
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await p.close();
  }
});

// 09.10.2026: with film timings measured on the machine the film estimate threw ("Cannot access 'lines' before
// initialization": the English conversion gave a function and a variable the same name), and as every status update
// stopped there, the recent panels stayed empty and finished jobs were never announced. The fake panel had no timings.
test('UI with measured timings (film too): the estimates are written, the recent panels fill, no exception (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const p = await createPanel({ server: true });
  const t = new Browser({ height: 900 });
  const errors = [];
  const until = async (expression, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return true;
    return false;
  };
  try {
    const done = await p.waitUntilDone(p.queue.add('image', { prompt: 'a red bicycle', model: 'flux', ratio: '1:1' }).id);
    assert.equal(done.status, 'done', done.error);
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/#film`);
    assert.ok(await until("Boolean(document.querySelector('[data-job-form=\"film\"] [name=\"videoModel\"]')?.value)"), 'the film form has its models');
    const f = await t.evaluate(`(() => { const f = document.querySelector('[data-job-form="film"]'); return { image: f.imageModel.value, video: f.videoModel.value, voice: f.querySelector('[name="quality"]').value }; })()`);
    for (const [key, value] of Object.entries({ [`voice/${f.voice}`]: 20, [`image/${f.image}`]: 30, [`video/${f.video}/720p`]: 40, [`video/${f.video}/480p`]: 20, 'video/lip/720p': 9, edit: 60 })) p.queue.db.writeMeasurement(key, value, 'x');
    p.queue.averageCache = null;
    await t.evaluate(`(() => { const s = document.querySelector('[data-job-form="film"] [data-scene] textarea'); if (s) { s.value = 'A cyclist rides along the shore at dawn.'; s.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
    assert.ok(await until(`/Estimated time/.test(document.querySelector('[data-estimate="film"]').textContent)`), `film estimate: ${await t.evaluate(`document.querySelector('[data-estimate="film"]').textContent`)}`);
    await t.evaluate(`location.hash = '#image'`);
    assert.ok(await until(`document.querySelectorAll('[data-last="image"] .gallery-card').length === 1`), 'the recent images panel shows the finished image');
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await p.close();
  }
});

test('UI rename: the job window renames the job; the recent card and the window show the new name (Turkish page, headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const p = await createPanel({ server: true });
  const t = new Browser({ height: 900 });
  const errors = [];
  const until = async (expression, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return true;
    return false;
  };
  try {
    const job = await p.waitUntilDone(p.queue.add('image', { prompt: 'a red fox walking in the snowy forest', model: 'flux', ratio: '1:1' }).id);
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/#image`);
    await t.evaluate(`document.querySelector('[data-language-select="tr"]').click()`);
    const card = `document.querySelector('[data-last="image"] [data-preview="${job.id}"]')`;
    assert.ok(await until(`Boolean(${card})`), 'the image is in the recent panel');
    await t.evaluate(`${card}.click(); true`);
    assert.ok(await until(`document.querySelector('#modal-preview [data-rename]')?.textContent === 'Yeniden adlandır'`));
    await t.evaluate(`document.querySelector('#modal-preview [data-rename]').click(); true`);
    assert.equal(await t.evaluate(`document.querySelector('[data-rename-form] input').value`), 'a red fox walking in the snowy forest');
    await t.evaluate(`(() => { const f = document.querySelector('[data-rename-form]'); f.title.value = 'Karda yürüyen tilki'; f.requestSubmit(); return true; })()`);
    assert.ok(await until(`document.querySelector('#preview-title')?.textContent.endsWith('Karda yürüyen tilki')`), await t.evaluate(`document.querySelector('#preview-title')?.textContent`));
    assert.equal(p.queue.jobs.get(job.id).summary.title, 'Karda yürüyen tilki');
    assert.ok(await until(`[...document.querySelectorAll('[data-last="image"] .gallery-card__title')].some((e) => e.textContent === 'Karda yürüyen tilki')`), 'the recent card shows the new name');
    await t.evaluate(`document.querySelector('[data-language-select="en"]').click()`);
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await p.close();
  }
});

// 09.10.2026: the collection checkboxes were drawn as one translate=no text ("<name> · raw articles (34)"), so the
// kinds of data stayed English on the Turkish page (seen in the Turkish promo video); the collection list's labels too.
test('UI training data (Turkish page): a collection keeps its name, the kinds of data and the labels beside it are Turkish (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const p = await createPanel({ server: true });
  const t = new Browser({ height: 900 });
  const errors = [];
  const until = async (expression, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return true;
    return false;
  };
  try {
    // a name that is also an English text of the dictionary ("Image") must stay as the user wrote it
    const root = join(p.setting.aiRoot, 'data', 'collections', 'image');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'articles.jsonl'), '{"title":"x"}\n');
    writeFileSync(join(root, 'training-title.jsonl'), '{"prompt":"x","response":"y"}\n');
    writeFileSync(join(root, 'summary.json'), JSON.stringify({ name: 'Image', topic: 'Voice', total: 34, languages: { tr: 30, en: 4 }, files: { 'training-title': 32 } }));
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/#training`);
    await t.evaluate(`document.querySelector('[data-language-select="tr"]').click()`);
    const labels = `[...document.querySelectorAll('[data-training-collection-choice] label')].map((e) => e.textContent)`;
    assert.ok(await until(`${labels}.length === 2`), `collection boxes: ${JSON.stringify(await t.evaluate(labels))}`);
    assert.ok(await until(`${labels}.join('|') === 'Image · ham yazılar (34)|Image · başlık yazma (32)'`), JSON.stringify(await t.evaluate(labels)));
    const details = `document.querySelector('[data-data-collections] .text-sm.text-muted:not(.row *)')?.textContent`;
    assert.ok(await until(`${details} === 'Konu: Voice — Diller: tr 30, en 4 — başlık yazma 32'`), await t.evaluate(details));
    await t.evaluate(`document.querySelector('[data-language-select="en"]').click()`);
    assert.ok(await until(`${labels}.join('|') === 'Image · raw articles (34)|Image · title writing (32)'`), JSON.stringify(await t.evaluate(labels)));
    assert.ok(await until(`${details} === 'Topic: Voice — Languages: tr 30, en 4 — title writing 32'`), await t.evaluate(details));
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await p.close();
  }
});

test('UI 3D model: the print height shows only with STL and goes with the job; the job window shows the print copy (size, volume) in English and Turkish (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const p = await createPanel({ server: true, blender: true });
  const t = new Browser({ height: 900 });
  const errors = [];
  const until = async (expression, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return true;
    return false;
  };
  const form = `document.querySelector('[data-job-form="model3d"]')`;
  const printShown = `!${form}.querySelector('[data-m3-print]').hidden`;
  try {
    const image = await p.waitUntilDone(p.queue.add('image', { prompt: 'a clay teapot', model: 'flux', ratio: '1:1' }).id);
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/#model3d`);
    assert.ok(await until(`!${form}.querySelector('[data-m3-blender]').hidden && ${printShown}`), 'with Blender and STL checked the print height shows');
    await t.evaluate(`${form}.format_stl.click(); true`);
    assert.equal(await t.evaluate(printShown), false, 'STL unchecked: no print height');
    await t.evaluate(`${form}.format_stl.click(); true`);
    assert.equal(await t.evaluate(printShown), true);
    await t.evaluate(`(() => { const f = ${form}; f.imageSource.value = 'job/${image.id}/${image.outputs[0].file}'; f.printHeight.value = '80'; f.querySelector('button[type="submit"]').click(); return true; })()`);
    await p.waitForState(() => [...p.queue.jobs.values()].some((job) => job.type === 'model3d'));
    const job = [...p.queue.jobs.values()].find((x) => x.type === 'model3d');
    assert.equal(job.input.printHeight, 80);
    assert.equal((await p.waitUntilDone(job.id, 120000)).status, 'done');
    assert.ok(await until(`Boolean(document.querySelector('[data-last="model3d"] [data-preview="${job.id}"]'))`), 'the finished model is in the recent panel');
    await t.evaluate(`document.querySelector('[data-last="model3d"] [data-preview="${job.id}"]').click(); true`);
    assert.ok(await until(`document.querySelector('#modal-preview [data-print-info]')?.textContent === 'STL for printing: 28 × 16.8 × 80 mm, 12.5 cm³'`), await t.evaluate(`document.querySelector('#modal-preview [data-print-info]')?.textContent ?? 'no print line'`));
    // every input row has a name; the source image is named by its job, not by its file (an English promo showed
    // "printHeight" and "job/…/gorsel_1.png", 09.10.2026)
    const facts = async () => JSON.parse(await t.evaluate(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('#modal-preview .facts__row')].map((r) => [r.children[0].textContent, r.children[1].textContent])))`));
    const rows = await facts();
    assert.equal(rows['Print height'], '80 mm');
    assert.equal(rows['Source image'], image.summary.title);
    assert.deepEqual(Object.keys(rows).filter((k) => /^[a-z]+[A-Z]/.test(k) || k === 'Title'), [], 'no raw key, no title row');
    // the viewer showed an empty box until a big GLB loaded (09.10.2026): a loading layer covers it; a GLB that cannot be
    // read takes the layer away and says so
    assert.ok(await until(`document.querySelector('#modal-preview .field__error')?.textContent === 'Could not load the 3D model.' && !document.querySelector('#modal-preview [data-model-loading]')`), 'an unreadable GLB: the loading layer goes, the error shows');
    // in Turkish (the window opened again: its numbers are written in the language of the moment)
    await t.evaluate(`document.querySelector('[data-language-select="tr"]').click()`);
    await t.evaluate(`document.querySelector('[data-last="model3d"] [data-preview="${job.id}"]').click(); true`);
    assert.ok(await until(`document.querySelector('#modal-preview [data-print-info]')?.textContent === 'Baskı için STL: 28 × 16,8 × 80 mm, 12,5 cm³'`), await t.evaluate(`document.querySelector('#modal-preview [data-print-info]')?.textContent ?? 'no print line'`));
    assert.match(await t.evaluate(`${form}.querySelector('[for="m3-print-height"]').textContent`), /^Baskı yüksekliği \(mm\)$/);
    assert.equal((await facts())['Baskı yüksekliği'], '80 mm');
    await t.evaluate(`document.querySelector('[data-language-select="en"]').click()`);
    // the fake ComfyUI's GLB is a line of text, which the 3D viewer cannot parse
    assert.deepEqual(errors.filter((e) => !/model-viewer\.min\.js/.test(e)), []);
  } finally {
    await t.close();
    await p.close();
  }
});

test('UI settings: a Web search key is saved from its field (Enter), shown only by its last 4 characters, removed; Turkish labels (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const KEY = 'BSAuiTestKey98765';
  const p = await createPanel({ server: true });
  const t = new Browser({ height: 900 });
  const errors = [];
  const until = async (expression, ms = 10000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return true;
    return false;
  };
  const field = (name) => `document.querySelector('[data-search-input="${name}"]')`;
  const hint = (name) => `${field(name)}.closest('.field').querySelector('.field__hint').textContent`;
  try {
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/#settings`);
    assert.ok(await until("!document.querySelector('[data-setting-search]').hidden && document.querySelectorAll('[data-search-input]').length === 3"), 'the Web search panel shows its three services');
    // an empty field sends nothing
    await t.evaluate(`document.querySelector('[data-search-save="tavily"]').click(); true`);
    await t.evaluate(`(() => { const i = ${field('brave')}; i.value = '${KEY}'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    assert.ok(await until(`${hint('brave')} === 'Saved: ••••8765'`), 'saved: the line under the field shows the last 4 characters');
    assert.deepEqual(p.settingFile.webSearch, { brave: KEY, tavily: '', searxng: '' });
    const shown = await t.evaluate(`({ value: ${field('brave')}.value, type: ${field('brave')}.type, hint: ${hint('brave')}, remove: Boolean(document.querySelector('[data-search-remove="brave"]')), page: document.documentElement.outerHTML.includes('${KEY}'), tavily: ${hint('tavily')} })`);
    assert.deepEqual(shown, { value: '', type: 'password', hint: 'Saved: ••••8765', remove: true, page: false, tavily: 'Not set' });
    // Turkish: labels and the masked hint come from the dictionary
    await t.evaluate(`document.querySelector('[data-language-select="tr"]').click()`);
    assert.ok(await until(`${hint('brave')} === 'Kayıtlı: ••••8765'`), 'the hint in Turkish');
    assert.equal(await t.evaluate(`${field('brave')}.closest('.field').querySelector('label').textContent`), 'Brave Search API anahtarı');
    // Remove: the service is gone from the file and the field says so
    await t.evaluate(`document.querySelector('[data-search-remove="brave"]').click(); true`);
    assert.ok(await until(`${hint('brave')} === 'Ayarlı değil' && !document.querySelector('[data-search-remove="brave"]')`), 'removed');
    assert.equal(p.settingFile.webSearch.brave, '');
    await t.evaluate(`document.querySelector('[data-language-select="en"]').click()`);
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await p.close();
  }
});

// 09.10.2026 user screenshot ("eşit ölçü yap sırıtmasın"): in Settings › Models the "installed" badge and the "Download"
// button had different widths, so the column did not line up. The Download button also did nothing: after the English
// conversion it read dataset.downloadCatalog, while the attribute is data-catalog-download (an error notice instead).
test('UI settings models: installed, in downloads and Download are one size (EN and TR, desktop and phone); Download queues the row\'s missing parts (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const p = await createPanel({ server: true });
  const t = new Browser({ height: 900 });
  const errors = [];
  const until = async (expression, ms = 10000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return true;
    return false;
  };
  const MAIN = ['diffusion_models', 'checkpoints'];
  const rowName = (k) => k.name.replace(/\s*\b(HighNoise|LowNoise)\b\s*/, ' ').replace(/\s+/g, ' ').trim();
  const mains = CATALOG.filter((k) => MAIN.includes(k.folder));
  const installed = mains[0];
  const pending = mains.find((k) => k.group !== installed.group);
  // every file of the first group on disk: that row is installed
  for (const k of CATALOG.filter((x) => x.group === installed.group)) {
    mkdirSync(join(p.setting.modelRoot, k.folder), { recursive: true });
    writeFileSync(join(p.setting.modelRoot, k.folder, k.file), '');
  }
  // the downloads list answers with a paused download of another row's main file; a POST is recorded, not sent
  const fakeDownloads = `(() => {
    window.__catalogPosts = [];
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (path, o = {}) => {
      if (String(path) === '/api/v1/models/downloads' && (o.method ?? 'GET') === 'GET') return json({ downloads: [{ id: 'test-1', folder: ${JSON.stringify(pending.folder)}, file: ${JSON.stringify(pending.file)}, name: ${JSON.stringify(pending.file)}, status: 'paused', downloaded: 0, expected: ${pending.size}, percent: 0 }] });
      if (String(path) === '/api/v1/models/downloads' && o.method === 'POST') {
        window.__catalogPosts.push(JSON.parse(o.body).catalog);
        return json({ ok: true, message: 'Queued.' });
      }
      return real(path, o);
    };
    return true;
  })()`;
  const sizes = `[...document.querySelectorAll('[data-catalog] tbody tr')].map((tr) => {
    const s = tr.querySelector('.row-state');
    const r = s.getBoundingClientRect();
    return { name: tr.querySelector('td div').textContent, state: s.textContent, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, nameLeft: Math.round(tr.querySelector('td div').getBoundingClientRect().left), stateLeft: Math.round(r.left), stateRight: Math.round(r.right), nameOffset: Math.round(tr.querySelector('td div').getBoundingClientRect().top - tr.querySelector('td').getBoundingClientRect().top) };
  })`;
  const check = async (label, texts, phone = false) => {
    const rows = await t.evaluate(sizes);
    assert.ok(rows.length > 3, `${label}: catalog rows`);
    assert.equal(rows.find((r) => r.name === rowName(installed)).state, texts.installed, `${label}: the installed row`);
    assert.equal(rows.find((r) => r.name === rowName(pending)).state, texts.pending, `${label}: the row in downloads`);
    assert.ok(rows.some((r) => r.state === texts.download), `${label}: a Download row`);
    const widths = new Set(rows.map((r) => r.width));
    const heights = new Set(rows.map((r) => r.height));
    assert.equal(widths.size, 1, `${label}: one width for every state: ${JSON.stringify(rows.map((r) => [r.state, r.width]))}`);
    assert.deepEqual([...heights], [24], `${label}: one height`);
    // phone: no right alignment (user rule): the name and the state start in one value column beside the labels
    if (phone) {
      const starts = new Set(rows.flatMap((r) => [r.nameLeft, r.stateLeft]));
      assert.equal(starts.size, 1, `${label}: names and states start in one column: ${JSON.stringify(rows.map((r) => [r.nameLeft, r.stateLeft]))}`);
      assert.ok([...starts][0] > 100 && [...starts][0] < 160, `${label}: the value column right of the labels: ${[...starts][0]}`);
      assert.ok(rows.every((r) => r.stateRight <= 390), `${label}: inside the phone`);
      // a long name wraps beside its label, it does not drop under it
      assert.ok(rows.every((r) => r.nameOffset <= 8), `${label}: names on the label's line: ${JSON.stringify(rows.filter((r) => r.nameOffset > 8).map((r) => [r.name, r.nameOffset]))}`);
    }
  };
  try {
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/`);
    await t.evaluate(fakeDownloads);
    await t.evaluate("location.hash = '#settings'; true");
    assert.ok(await until(`document.querySelectorAll('[data-catalog] tbody tr').length > 3 && [...document.querySelectorAll('[data-catalog] .row-state')].some((s) => s.textContent === 'in downloads')`), 'the catalog is drawn with the paused download');
    await check('EN desktop', { installed: 'installed', pending: 'in downloads', download: 'Download' });
    // Download: the row's missing parts are queued (ids from the button), no error notice
    const button = await t.evaluate(`(() => {
      const b = [...document.querySelectorAll('[data-catalog-download]')].find((x) => x.closest('tr').querySelector('td div').textContent !== ${JSON.stringify(rowName(pending))});
      b.click();
      return b.dataset.catalogDownload;
    })()`);
    assert.ok(await until('window.__catalogPosts.length > 0'), 'Download sent its request');
    await wait(300);
    assert.deepEqual(await t.evaluate('window.__catalogPosts'), button.split(','));
    assert.ok(button.split(',').every((id) => CATALOG.some((k) => k.id === id)), `catalog ids: ${button}`);
    assert.equal(await t.evaluate("[...document.querySelectorAll('.toast, [data-notice], .notice')].some((n) => /split|undefined/.test(n.textContent))"), false, 'no error notice');
    // Turkish
    await t.evaluate(`document.querySelector('[data-language-select="tr"]').click()`);
    assert.ok(await until(`[...document.querySelectorAll('[data-catalog] .row-state')].some((s) => s.textContent === 'kurulu')`), 'Turkish labels');
    await check('TR desktop', { installed: 'kurulu', pending: await t.evaluate("window.NedeseLang.translate('in downloads')"), download: await t.evaluate("window.NedeseLang.translate('Download')") });
    // phone: rows stack, the state keeps its size
    await t.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await wait(300);
    await check('TR phone', { installed: 'kurulu', pending: await t.evaluate("window.NedeseLang.translate('in downloads')"), download: await t.evaluate("window.NedeseLang.translate('Download')") }, true);
    assert.ok(await t.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal page scroll on a phone');
    await t.evaluate(`document.querySelector('[data-language-select="en"]').click()`);
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await p.close();
  }
});

// 09.10.2026 user screenshot (iPhone, "Apiye gece gündüz koymamışsın"): the API docs page had no day / night button.
test('UI API docs (phone 390 px): the day / night button switches the theme, keeps it after a reload and shares it with the panel; Turkish label; fits the phone (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const p = await createPanel({ server: true });
  const t = new Browser({ width: 390, height: 844 });
  const errors = [];
  const state = `(() => {
    const b = document.querySelector('.topbar [data-theme-toggle]');
    const r = b.getBoundingClientRect();
    const shown = [...b.querySelectorAll('svg')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.getAttribute('class'));
    return { theme: document.documentElement.dataset.theme, label: b.getAttribute('aria-label'), shown, inside: r.left >= 0 && r.right <= window.innerWidth && r.width > 0, wide: document.documentElement.scrollWidth > window.innerWidth };
  })()`;
  try {
    await t.open();
    collectErrors(t, errors);
    await t.goto(`${p.address}/api/documents?lang=en`);
    await t.evaluate("localStorage.removeItem('theme'); true");
    await t.goto(`${p.address}/api/documents?lang=en`);
    assert.deepEqual(await t.evaluate(state), { theme: 'dark', label: 'Change theme', shown: ['icon-sun'], inside: true, wide: false });
    await t.evaluate("document.querySelector('[data-theme-toggle]').click(); true");
    assert.deepEqual(await t.evaluate(state), { theme: 'light', label: 'Change theme', shown: ['icon-moon'], inside: true, wide: false });
    assert.equal(await t.evaluate("localStorage.getItem('theme')"), 'light');
    // a reload and the Turkish page keep the choice
    await t.goto(`${p.address}/api/documents?lang=tr`);
    assert.deepEqual(await t.evaluate(state), { theme: 'light', label: 'Temayı değiştir', shown: ['icon-moon'], inside: true, wide: false });
    // the panel opens in the same theme, and its own button changes the docs page too
    await t.goto(`${p.address}/`);
    assert.equal(await t.evaluate('document.documentElement.dataset.theme'), 'light');
    await t.evaluate("document.querySelector('[data-theme-toggle]').click(); true");
    await t.goto(`${p.address}/api/documents`);
    assert.equal(await t.evaluate('document.documentElement.dataset.theme'), 'dark');
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await p.close();
  }
});

// 07.10.2026 kullanici ekran goruntusu (iPhone): is penceresi yatay kayiyordu (uzun model dosyasi adi kirilmiyordu,
// 390 px'te govde 451/376), alt baslik kesiliyordu (379/324), 5 sahnenin 5'i gorunurken "+1 sahne klibi daha"
// yaziyordu. Ayrica "Sahneleri yaz" ilerleme gostergesine (Kuyruk) dusmuyordu.
test('UI (phone 390 px): job window does not overflow, subheading is not cut off, scene count correct; scene writer visible in Queue', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const p = await createPanel({ server: true });
  const t = new Browser({ width: 390, height: 844 });
  const errors = [];
  let resume = null;
  p.setting.sceneWriter = async ({ sceneCount, progress }) => {
    progress({ written: 0, total: sceneCount });
    await new Promise((ok) => {
      resume = ok;
    });
    return { title: 'Küçük Tilki', scenes: Array.from({ length: sceneCount }, (_, i) => ({ narration: `Anlatım ${i + 1}`, image: `image ${i + 1}`, motion: 'slow push in' })) };
  };
  const id = '20261007-082359-tekparca-test';
  p.queue.jobs.set(id, {
    panel: 1, id, type: 'film', status: 'done', creation: '2026-10-07T05:23:59.596Z', start: '2026-10-07T05:23:59.629Z', end: '2026-10-07T06:57:15.818Z', duration: 5596,
    input: { title: 'Ormanda Kaybolan Minik Kedi: Pamuk', ratio: '9:16', imageModel: 'qwen', videoModel: 'wan14', musicMode: 'generate', quality: 'checked', scenes: [1, 2, 3, 4, 5].map((i) => ({ narration: `Küçük turuncu kedi Pamuk, bir sonbahar sabahı kelebeğin peşinden koşarken evinin bahçesinden uzaklaştı (${i}).` })) },
    summary: { title: 'Ormanda Kaybolan Minik Kedi: Pamuk', detail: '5 sahne · 9:16 · Wan 2.2 A14B (en iyi) · müzikli' },
    outputs: [
      { file: 'film.mp4', type: 'video', main: true, width: 720, height: 1280, duration: 47 },
      { file: 'film.srt', type: 'subtitle' },
      ...[1, 2, 3, 4, 5].map((i) => ({ file: `sahne0${i}.mp4`, type: 'scene', duration: 10, scene: i })),
    ],
    modelFiles: ['wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf', 'wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q5_K_M.gguf', 'rife49.pth', 'acestep_v1.5_turbo.safetensors'],
    stages: { voice: 313, image: 934, video: 4122, fiction: 20 },
    measurements: {},
  });
  try {
    await t.open();
    await t.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/`);
    const modal = await t.evaluate(`(async () => {
      const b = document.createElement('button');
      b.dataset.preview = ${JSON.stringify(id)};
      document.body.append(b);
      b.click();
      await new Promise((r) => setTimeout(r, 800));
      b.remove();
      const p = document.querySelector('#modal-preview');
      const body = p.querySelector('[data-preview-body]');
      const sub = p.querySelector('[data-preview-sub]');
      const result = { isOpen: !p.hidden, body: [body.scrollWidth, body.clientWidth], sub: [sub.scrollWidth, sub.clientWidth], text: body.textContent, subText: sub.textContent };
      p.querySelector('[data-modal-close]').click();
      return result;
    })()`);
    assert.ok(modal.isOpen, 'job window opened');
    assert.ok(modal.body[0] <= modal.body[1] + 1, `body does not overflow horizontally: scrollWidth/clientWidth ${modal.body}`);
    assert.ok(modal.sub[0] <= modal.sub[1] + 1, `subheading is not cut off: ${modal.sub} "${modal.subText}"`);
    assert.match(modal.subText, /müzikli$/, 'the job record detail is shown as stored');
    assert.match(modal.text, /wan2\.2_i2v_A14b_high_noise/);
    assert.match(modal.text, /Scene 5 \(10 s\)/);
    assert.doesNotMatch(modal.text, /more scene clips/, 'does not say "+1 more scene clips" while all scenes are shown');

    // Sahne yazari: yazim surerken Kuyruk'ta yan gorev satiri (ilerleme, Iptal), bitince kalkar, sahneler forma gelir
    await t.evaluate(`(async () => {
      location.hash = '#film';
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('#t-konu').value = 'Ormanda kaybolan küçük bir tilki';
      document.querySelector('#t-sahne-sayisi').value = '3';
      document.querySelector('[data-scene-write]').click();
      return true;
    })()`);
    let line = null;
    for (let i = 0; i < 30 && !line?.present; i++) {
      await wait(200);
      line = await t.evaluate(`(() => {
        const s = document.querySelector('[data-queue-list] [data-task]');
        return s ? { present: true, text: s.textContent, cancel: Boolean(s.querySelector('form[action$="/cancel"] button, form[action$="/cancel"]')), bar: Boolean(s.querySelector('progress')) } : { present: false };
      })()`);
    }
    assert.ok(line?.present, 'scene writer visible in Queue');
    assert.match(line.text, /Scene writer · Ormanda kaybolan küçük bir tilki/);
    assert.match(line.text, /0\/3 scenes written/);
    assert.ok(line.cancel && line.bar, 'progress bar and Cancel are present');
    resume();
    let done = null;
    for (let i = 0; i < 30 && !done?.done; i++) {
      await wait(200);
      done = await t.evaluate(`(() => ({ done: !document.querySelector('[data-queue-list] [data-task]') && document.querySelectorAll('[data-scene]').length >= 3, scenes: document.querySelectorAll('[data-scene]').length }))()`);
    }
    assert.ok(done?.done, `row disappears when writing finishes, scenes land in the form: ${JSON.stringify(done)}`);

    // Karakterler (07.10.2026: karakterler kadin/erkek sesiyle konusur): replige yazilan ad listede belirir, cinsiyet
    // secilmeden isaretli; gonderilen iste karakterler ve replikler
    const character = await t.evaluate(`(async () => {
      const f = document.querySelector('[data-job-form="film"]');
      const k = f.querySelector('[data-scene] [data-field="dialogue"]');
      k.value = 'Elif: Pamuk! Neredesin?';
      k.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      const panel = f.querySelector('[data-characters]');
      const line = panel.querySelector('[data-character-line="Elif"]');
      const c = line?.querySelector('[data-character-field="gender"]');
      const once = c?.getAttribute('aria-invalid') ?? null;
      c.value = 'female';
      c.dispatchEvent(new Event('change', { bubbles: true }));
      const y = line.querySelector('[data-character-field="age"]');
      y.value = 'child';
      y.dispatchEvent(new Event('change', { bubbles: true }));
      // Tur secimi satirda; tarif bosken insan
      if (line.querySelector('[data-character-field="type"]')?.value !== 'human') throw new Error('type choice missing or not human');
      // Dudak esleme (07.10.2026: "dudaklari da yapabilsek iyi olur"): Kurgu'da secenek, iste lip: true
      const lip = f.querySelector('input[name="lip"]');
      lip.checked = true;
      lip.dispatchEvent(new Event('change', { bubbles: true }));
      return { visible: !panel.hidden, line: Boolean(line), once, after: c.getAttribute('aria-invalid'), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    })()`);
    assert.deepEqual(character, { visible: true, line: true, once: 'true', after: null, overflow: false });
    await t.evaluate(`document.querySelector('[data-job-form="film"] button[type="submit"]').click()`);
    let film = null;
    for (let i = 0; i < 30 && !film; i++) {
      await wait(200);
      film = [...p.queue.jobs.values()].find((x) => x.type === 'film' && x.id !== id) ?? null;
    }
    assert.ok(film, 'film job entered the queue');
    // Tur (insan/hayvan) secimi satirda; tarif bossa insan (07.10.2026: "Kedi mi konusuyor Elif mi, karismis")
    assert.deepEqual(film.input.characters, [{ name: 'Elif', gender: 'female', age: 'child', type: 'human', spec: '', voice: '' }]);
    assert.deepEqual(film.input.scenes[0].dialogue, [{ who: 'Elif', text: 'Pamuk! Neredesin?' }]);
    assert.equal(film.input.lip, true, 'lip sync option carried into the job');
    assert.match(film.summary.detail, /lip sync/);
    assert.deepEqual(errors, []);
  } finally {
    resume?.();
    await t.close();
    await p.close();
  }
});

test('chat Markdown: tables, headings, nested and numbered lists, tasks, quotes, rules, emphasis, links only for http(s) and panel paths', async () => {
  await import('../web/js/markdown.js');
  const { parse } = globalThis.NedeseMarkdown;
  // a table: alignment, a pipe inside code, a short row filled up, a cell with markup
  assert.deepEqual(parse('| Name | Size |\n|:-----|-----:|\n| `x|y` | 12 KB |\n| **b** |'), [{ type: 'table', align: ['left', 'right'], head: [['Name'], ['Size']], rows: [[[{ type: 'code', text: 'x|y' }], ['12 KB']], [[{ type: 'strong', children: ['b'] }], []]] }]);
  assert.deepEqual(parse('window.__xss=1 and a__b__c')[0].lines[0], ['window.__xss=1 and a__b__c'], 'underscores in names are not emphasis');
  // a row of pipes without a delimiter row is text
  assert.equal(parse('a | b\nc | d')[0].type, 'paragraph');
  const doc = parse('# Title\nSome **bold**, *it*, _em_, snake_case_name, 2*3*4, ~~old~~ and **unclosed\n---\n> quote **x**\n> more\n\n```js\nconst a = 1;\n```');
  assert.deepEqual(doc.map((b) => b.type), ['heading', 'paragraph', 'hr', 'quote', 'code']);
  assert.deepEqual(doc[1].lines[0], ['Some ', { type: 'strong', children: ['bold'] }, ', ', { type: 'em', children: ['it'] }, ', ', { type: 'em', children: ['em'] }, ', snake_case_name, 2*3*4, ', { type: 'del', children: ['old'] }, ' and **unclosed']);
  assert.deepEqual(doc[3].blocks, [{ type: 'paragraph', lines: [['quote ', { type: 'strong', children: ['x'] }], ['more']] }]);
  assert.deepEqual(doc[4], { type: 'code', lang: 'js', text: 'const a = 1;' });
  // lists: numbered with a nested list under an item, the start number, tasks; a list right after a line of text
  const lists = parse('Steps:\n1. first\n2. second\n   - nested a\n   - nested b\n3. third\n\n4. after a blank line\n\nMore:\n\n7. seven\n\n- [ ] todo\n- [x] done');
  assert.deepEqual(lists.map((b) => [b.type, b.ordered, b.start]), [['paragraph', undefined, undefined], ['list', true, 1], ['paragraph', undefined, undefined], ['list', true, 7], ['list', false, 1]]);
  assert.deepEqual(lists[1].items.map((i) => i.blocks.map((b) => b.type)), [['paragraph'], ['paragraph', 'list'], ['paragraph'], ['paragraph']]);
  assert.deepEqual(lists[1].items[1].blocks[1].items.map((i) => i.blocks[0].lines[0][0]), ['nested a', 'nested b']);
  assert.deepEqual(lists[4].items.map((i) => [i.task, i.blocks[0].lines[0][0]]), [[false, 'todo'], [true, 'done']]);
  assert.equal(parse('It was\n2024. a year')[0].type, 'paragraph', 'only "1." starts a list inside a paragraph');
  // links: http(s) and panel paths; javascript: and data: stay text; an address ends before closing punctuation
  const links = parse('[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.com/a_(b)) <https://x.org> see https://y.org/p. /file/job/1/a.png ![i](/file/upload/c.png)')[0].lines[0];
  assert.deepEqual(links.filter((n) => typeof n !== 'string').map((n) => [n.type, n.href ?? n.src]), [['link', 'https://example.com/a_(b)'], ['link', 'https://x.org'], ['link', 'https://y.org/p'], ['link', '/file/job/1/a.png'], ['image', '/file/upload/c.png']]);
  assert.match(links[0], /^\[a\]\(javascript:alert\(1\)\) \[b\]\(data:text\/html,x\) $/);
  // while streaming: an open fence is code to the end, half a table is still text
  assert.deepEqual(parse('```\nconst x'), [{ type: 'code', lang: '', text: 'const x' }]);
  assert.equal(parse('| a | b |')[0].type, 'paragraph');
});

/**
 * User reports 09.10.2026 (phone): a table's narrow columns broke one letter a line ("Size" read S-i-z-e), then a column
 * of short values broke at its space ("353 B" as "353" over "B"), and a file change scrolled sideways showed the green
 * line colour only as wide as the screen.
 */
test('UI chat: on a phone a table column is never narrower than its longest word, a column of short values keeps them on one line, a wide table scrolls in its box (not the page), and every line of a file change is as wide as the longest (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  const llm = new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', models: [{ file: 'a.gguf', name: 'a', gib: 1 }], command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port), 'a.gguf'] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
  const p = await createPanel({ server: true, llm, setting: { agentBrowser: false, agentPollingMs: 50 } });
  const t = new Browser({ width: 402, height: 874 });
  const errors = [];
  try {
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/#chat`);
    const table = [
      '| File | Size | Contents |',
      '|---|---|---|',
      '| `package.json` | 213 B | made with `npm init -y`; `"type": "module"`, `"test": "node --test"` |',
      '| `metin.mjs` | 353 B | `export function istatistik(metin)` → `{ kelimeSayisi, cumleSayisi, okumaSuresiDakika }` (words: trim + `split(/\\s+/)`, sentences: count of `[.!?]`, time: words/200 min) |',
      '| `README.md` | 512 B | Setup (Node 18+, no dependencies), a usage example, the test command |',
      // a path without spaces or hyphens: no place to break, the table is wider than the phone
      '| `C:\\Users\\root\\projects\\textstatistics\\src\\statistics.test.mjs` | 1570 B | the tests |',
    ].join('\n');
    const long = 'assert.deepEqual(Object.keys(s), ["kelimeSayisi", "cumleSayisi", "okumaSuresiDakika"]); '.repeat(2);
    const file = { format: 'nedese-chat', version: 1, chat: { title: 'Phone layout' }, messages: [
      { role: 'user', content: 'Write the test and summarize the files' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'C:\\demo\\metin.test.mjs', text: 'x' } }] },
      { role: 'tool', toolId: 't1', toolName: 'write_file', content: 'Created: C:\\demo\\metin.test.mjs (+3 -0 lines)', extra: { edit: { path: 'C:\\demo\\metin.test.mjs', added: 3, removed: 0, diff: `@@ -0,0 +1,3 @@\n+short\n+${long}\n+end` } } },
      { role: 'assistant', content: `Files written:\n\n${table}\n\nAll tests pass.` },
    ] };
    const id = await t.evaluate(`fetch('/api/v1/chat/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel': '1' }, body: JSON.stringify({ data: ${JSON.stringify(file)} }) }).then((r) => r.json()).then((j) => j.chat?.id ?? JSON.stringify(j))`);
    assert.match(id, /^\w+$/, `imported: ${id}`);
    await t.evaluate(`localStorage.setItem('chat.current', ${JSON.stringify(id)}); true`);
    await t.goto(`${p.address}/?r=1#chat`);
    let cells = null;
    for (let i = 0; i < 100 && !cells; i++, await wait(100)) {
      cells = await t.evaluate(`(() => {
        const box = document.querySelector('.message__table');
        if (!box) return null;
        // a cell without a space, and a short one ("353 B"), must fit on one line: its content laid out without wrapping is
        // no wider than the cell
        return [...box.querySelectorAll('th, td')].filter((c) => !/\\s/.test(c.textContent.trim()) || c.textContent.trim().length <= 16).map((c) => {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
          probe.innerHTML = c.innerHTML;
          c.append(probe);
          const s = getComputedStyle(c);
          const room = c.getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
          const need = probe.getBoundingClientRect().width;
          probe.remove();
          return { text: c.textContent.trim(), fits: need <= room + 1, need: Math.round(need), room: Math.round(room) };
        });
      })()`);
    }
    assert.ok(cells?.length >= 5, `table cells found: ${JSON.stringify(cells)}`);
    assert.deepEqual(['213 B', '353 B', '512 B', '1570 B'].filter((x) => !cells.some((c) => c.text === x)), [], 'the sizes are among the cells checked');
    assert.deepEqual(cells.filter((c) => !c.fits), [], 'no column is narrower than its longest word');
    const box = await t.evaluate("(() => { const b = document.querySelector('.message__table'); return { scrolls: b.scrollWidth > b.clientWidth, page: document.documentElement.scrollWidth > innerWidth + 1 }; })()");
    assert.deepEqual(box, { scrolls: true, page: false }, 'the wide table scrolls inside its box; the page itself does not scroll sideways');
    // the file change (its step opened if folded): scrolled to the end, every line spans the whole width
    const lines = await t.evaluate(`(() => {
      document.querySelectorAll('details').forEach((d) => { if (d.querySelector('.diff')) d.open = true; });
      const body = document.querySelector('.diff__body');
      if (!body) return null;
      body.scrollLeft = body.scrollWidth;
      return { overflow: body.scrollWidth > body.clientWidth, widths: [...body.querySelectorAll('.diff__line')].map((l) => Math.round(l.getBoundingClientRect().width)), full: body.scrollWidth };
    })()`);
    assert.ok(lines?.overflow, `the long line scrolls in the diff: ${JSON.stringify(lines)}`);
    assert.deepEqual(lines.widths.map((w) => Math.abs(w - lines.full) <= 1), [true, true, true, true], `every line as wide as the longest: ${JSON.stringify(lines)}`);
    // Rename from the chat's menu (user request 09.10.2026); no pencil next to the title any more
    assert.equal(await t.evaluate("document.querySelectorAll('.chat__name button').length"), 0, 'no button next to the title');
    await t.evaluate("document.querySelector('[data-chat-menu]').click(); true");
    assert.ok(await t.evaluate("Boolean(document.querySelector('[data-chat-menu-action=\"rename\"]'))"), 'the menu has Rename');
    await t.evaluate(`(() => {
      document.querySelector('[data-chat-menu-action="rename"]').click();
      const field = document.querySelector('.chat__title-input');
      field.value = 'Renamed from the menu';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    let title = '';
    for (let i = 0; i < 50 && title !== 'Renamed from the menu'; i++, await wait(100)) title = await t.evaluate(`fetch('/api/v1/chat/${id}', { headers: { 'X-Panel': '1' } }).then((r) => r.json()).then((j) => j.chat.title)`);
    assert.equal(title, 'Renamed from the menu');
    assert.equal(await t.evaluate("document.querySelector('[data-chat-menu-panel]').hidden"), true, 'the menu closed');
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
    await p.close();
    await llm.close();
  }
});

/**
 * Chat (fake text model writing a piece every 20 ms): the live answer survives leaving the section and coming back
 * (user report 08.10.2026: the stream closed with the section and the bubble lost the text written so far).
 */
test('UI chat: the answer being written is back with its text after switching sections; Markdown answers render safely; the thinking is shown folded; the thinking level is picked in Options; the chat search orders by best match (headless browser)', { skip: browserPath() ? false : 'Edge/Chrome not found' }, async () => {
  process.env.FAKE_LLM_STREAM_MS = '30';
  process.env.FAKE_LLM_THINK_REPEAT = '10';
  const llm = new LocalLlm({ info: { name: 'fake-model', file: 'a.gguf', image: true, models: [{ file: 'a.gguf', name: 'a', gib: 1, image: true }], command: (port) => ({ command: process.execPath, args: [FAKE_LLM, String(port), 'a.gguf'] }) }, port: await freePort(), readySec: 20, idleSec: 600 });
  const p = await createPanel({ server: true, llm, setting: { agentBrowser: false, agentPollingMs: 50 } });
  const t = new Browser({ height: 900 });
  const errors = [];
  try {
    await t.open();
    collectErrors(t, errors);
    await openEnglish(t, `${p.address}/#chat`);
    const until = async (expression, ms = 20000) => {
      for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await t.evaluate(expression)) return true;
      return false;
    };
    const liveText = "(document.querySelector('.message--live .message__bubble')?.textContent ?? '')";
    await t.evaluate(`(() => { document.querySelector('[data-chat-input]').value = 'long answer 300'; document.querySelector('[data-chat-form]').requestSubmit(); return true; })()`);
    assert.ok(await until(`/word10 /.test(${liveText})`), 'the answer streams into the live bubble');
    // another section: the chat streams close; the model keeps writing
    await t.evaluate(`location.hash = '#image'`);
    await wait(600);
    const before = await t.evaluate(liveText);
    await t.evaluate(`location.hash = '#chat'`);
    // at once from the first word (not only the pieces written after the return), while the model still writes
    assert.ok(await until(`${liveText}.startsWith('word0 word1 ') && ${liveText}.length >= ${before.length}`, 1000), 'back in the chat: the live bubble has the text written so far');
    assert.ok(await t.evaluate("Boolean(document.querySelector('.message--live'))"), 'checked while the answer was still being written');
    assert.ok(await until("[...document.querySelectorAll('.message--assistant:not(.message--live) .message__bubble')].some((b) => / end\\.$/.test(b.textContent))"), 'the answer finishes in the chat');
    const final = await t.evaluate("[...document.querySelectorAll('.message--assistant .message__bubble')].map((b) => b.textContent).join('|')");
    assert.equal((final.match(/word5 /g) ?? []).length, 1, `the answer is shown once, without repeats: ${final.slice(0, 200)}`);
    assert.match(final, /^word0 word1 .* word299 end\.$/);
    // Markdown answer: table, heading, lists, quote, rule, links; HTML in the answer stays text and nothing runs
    await t.evaluate(`(() => { document.querySelector('[data-chat-input]').value = 'markdown sample'; document.querySelector('[data-chat-form]').requestSubmit(); return true; })()`);
    assert.ok(await until("Boolean(document.querySelector('.message--assistant:not(.message--live) .message__table'))"), 'the table is rendered');
    const md = await t.evaluate(`(() => {
      const b = document.querySelector('.message--assistant:not(.message--live) .message__table').closest('.message__bubble');
      return {
        heading: b.querySelector('h4.message__heading')?.textContent,
        head: [...b.querySelectorAll('th')].map((x) => [x.textContent, x.className]),
        cells: [...b.querySelectorAll('td')].map((x) => x.textContent),
        nested: [...b.querySelectorAll('ol > li > ul > li')].map((x) => x.textContent),
        quote: b.querySelector('blockquote')?.textContent,
        links: [...b.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        marks: [b.querySelector('p strong')?.textContent, b.querySelector('p em')?.textContent, b.querySelector('p del')?.textContent, b.querySelectorAll('hr').length],
        html: b.querySelectorAll('img, script').length,
        rawHtml: b.textContent.includes('<img src=x onerror='),
        xss: window.__xss ?? null,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      };
    })()`);
    assert.deepEqual(md, {
      heading: 'Results',
      head: [['File', 'message__cell--left message__cell--nowrap'], ['Size', 'message__cell--right message__cell--nowrap'], ['Status', 'message__cell--center message__cell--nowrap']],
      cells: ['a.png', '12 KB', 'ok', 'b.png', '3 KB', 'new'],
      nested: ['detail a', 'detail b'],
      quote: 'Note: see the docs or [this](javascript:window.__xss=1).',
      links: ['https://example.com/docs'],
      marks: ['two', 'checked', 'guessed', 1],
      html: 0,
      rawHtml: true,
      xss: null,
      overflow: false,
    });
    // Thinking: the reasoning streams into an open "Thinking" block above the answer, folded once the answer is there
    await t.evaluate(`(() => { document.querySelector('[data-chat-input]').value = 'think about cats'; document.querySelector('[data-chat-form]').requestSubmit(); return true; })()`);
    assert.ok(await until("/First I consider cats/.test(document.querySelector('.message--live .message__thinking[open] .message__thinking-body')?.textContent ?? '')", 10000), 'the thinking shows, open, while it is written');
    assert.ok(await until("[...document.querySelectorAll('.message--assistant:not(.message--live) .message__bubble')].some((b) => b.textContent === 'Answer after thinking about cats.')"));
    const folded = "(() => { const d = [...document.querySelectorAll('.message__thinking')].at(-1); return d && { open: d.open, summary: d.querySelector('summary').textContent, body: d.querySelector('.message__thinking-body').textContent, answer: d.nextElementSibling?.textContent }; })()";
    const thought = await t.evaluate(folded);
    assert.deepEqual({ ...thought, body: thought.body.slice(0, 22) }, { open: false, summary: 'Thinking', body: 'First I consider cats.', answer: 'Answer after thinking about cats.' });
    // stored with the message: after opening the chat again it is there, folded
    await t.evaluate(`location.hash = '#image'`);
    await wait(300);
    await t.evaluate(`location.hash = '#chat'`);
    await wait(1200);
    assert.deepEqual(await t.evaluate(folded), thought);
    // Options › Thinking › Long: the chat thinks with the high budget from its next answer; the label beside the icon says so
    await t.evaluate("document.querySelector('[data-chat-options]').click(); true");
    assert.equal(await t.evaluate("[...document.querySelector('[data-chat-options-panel]').childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === 'null')"), false, 'no stray "null" text under the options (only the default model here)');
    await t.evaluate(`(() => { const r = document.querySelector('input[name="chat-thinking"][value="high"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const chat = () => [...p.http.agent.chats.values()].find((x) => x.title === 'long answer 300');
    for (let i = 0; i < 30 && chat()?.thinking !== 'high'; i++) await wait(100);
    assert.equal(chat()?.thinking, 'high');
    assert.ok(await until("document.querySelector('[data-chat-options-label]').textContent.includes('Thinking: Long')", 3000), 'the label shows the level');
    // Search order: with words, "Best match first" asks for sort=relevance (the shorter title wins) and is kept
    p.http.agent.create({ title: 'zebra', full: true });
    await wait(20);
    p.http.agent.create({ title: 'zebra stripes and many other words', full: true });
    await t.evaluate("document.querySelector('[data-chat-search-toggle]').click(); true");
    assert.equal(await t.evaluate("document.querySelector('[data-chat-search-sort]').hidden"), true, 'no order choice without words');
    await t.evaluate("(() => { const i = document.querySelector('[data-chat-search]'); i.value = 'zebra'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    const names = "[...document.querySelectorAll('[data-chat-items] .chat__item-name')].map((x) => x.textContent).join('|')";
    assert.ok(await until(`${names} === 'zebra stripes and many other words|zebra'`, 5000), 'newest first');
    assert.equal(await t.evaluate("document.querySelector('[data-chat-search-sort]').hidden"), false, 'the order choice shows with words');
    await t.evaluate("(() => { const s = document.querySelector('[data-chat-search-sort]'); s.value = 'relevance'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    assert.ok(await until(`${names} === 'zebra|zebra stripes and many other words'`, 5000), `best match first: ${await t.evaluate(names)}`);
    assert.equal(await t.evaluate("localStorage.getItem('chat.searchSort')"), 'relevance');
    // A chat whose earlier messages left the model's context (no summary could be made): the note shows where
    const z = p.http.agent.create({ title: 'quokka notes', full: true });
    z.messages.push({ role: 'user', content: 'quokka', attachments: [], time: new Date().toISOString() }, { role: 'note', kind: 'left-out', content: "3 earlier messages were left out of the model's context to make room (the summary could not be made); they stay in this chat.", time: new Date().toISOString() });
    p.http.agent.save(z, true);
    await t.evaluate("(() => { const i = document.querySelector('[data-chat-search]'); i.value = 'quokka'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    assert.ok(await until(`${names} === 'quokka notes'`, 5000));
    await t.evaluate("document.querySelector('[data-chat-items] .chat__item').click(); true");
    assert.ok(await until("[...document.querySelectorAll('.chat__note > summary')].some((x) => x.textContent === 'Earlier messages left out')", 5000), 'the note is shown');
    assert.match(await t.evaluate("[...document.querySelectorAll('.chat__note')].at(-1).querySelector('.chat__note-body').textContent"), /^3 earlier messages were left out/);
    assert.deepEqual(errors, []);
  } finally {
    delete process.env.FAKE_LLM_THINK_REPEAT;
    delete process.env.FAKE_LLM_STREAM_MS;
    await t.close();
    await llm.close();
    await p.close();
  }
});
