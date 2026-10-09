/*
 * Two languages (English is the source language, Turkish the second).
 *
 * A CLASSIC SCRIPT, loaded WITHOUT defer (at the end of body, before design.js/app.js): the page is translated before
 * it is drawn, so English never flashes in between.
 *
 * Source texts are English (index.html, app.js, server messages; the server gets X-Panel-Lang: en). The dictionary
 * (lang/dictionary.js) maps English text to Turkish; patterns with {0}, {1} placeholders cover dynamic texts (the
 * captured part is translated too). Text nodes and visible attributes (placeholder, title, aria-label, alt, confirm
 * texts) keep their originals; a language change translates again from the original. Everything added later (what
 * app.js draws, server messages, notices) is translated at once through a MutationObserver.
 *
 * Not translated: an element with translate="no" and everything under it (prompts the user wrote, file names), and
 * form field values.
 *
 * Page hooks: language buttons [data-language-select="tr|en"], document links [data-language-link] (?lang= is added).
 */
(function () {
    'use strict';

    const KEY = 'lang';
    const LANGUAGES = ['en', 'tr'];
    const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt', 'data-confirm', 'data-confirm-title', 'data-approval'];

    // Default: English (the main language). Turkish only when the user picks TR (remembered in localStorage).
    let language = 'en';
    try {
        const d = localStorage.getItem(KEY);
        if (LANGUAGES.includes(d)) language = d;
    } catch {
        /* gizli sekme: varsayılan */
    }

    const raw = (globalThis.NedeseDictionary && globalThis.NedeseDictionary.tr) || {};
    const full = new Map();
    const patterns = [];
    // raw: English source text -> Turkish translation
    for (const [en, tr] of Object.entries(raw)) {
        if (/\{\d+\}/.test(en)) {
            const parts = en.split(/(\{\d+\})/);
            const position = [];
            const pattern = parts.map((p) => {
                const m = /^\{(\d+)\}$/.exec(p);
                if (m) {
                    position.push(Number(m[1]));
                    return '([\\s\\S]*?)';
                }
                return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }).join('');
            // Uzun (daha belirli) kalıp önce denenir.
            patterns.push({ re: new RegExp(`^${pattern}$`), position, tr, len: en.replace(/\{\d+\}/g, '').length, dot: en.includes(' · ') });
        } else {
            full.set(en, tr);
        }
    }
    patterns.sort((a, b) => b.len - a.len);

    const HOUR = /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+)([\s\S]+)$/;

    /** İngilizce kaynak metni seçili dile çevirir (EN'de aynen döner). */
    function translate(text, target = language, depth = 0) {
        if (target === 'en' || text === null || text === undefined) return text;
        const s = String(text);
        const trimmed = s.trim();
        if (!trimmed || depth > 4) return s;
        const startedAt = s.slice(0, s.indexOf(trimmed));
        const last = s.slice(startedAt.length + trimmed.length);
        const find = (t) => {
            if (full.has(t)) return full.get(t);
            const hour = HOUR.exec(t);
            if (hour) {
                const back = find(hour[2]);
                return back === null ? null : hour[1] + back;
            }
            for (const k of patterns) {
                const m = k.re.exec(t);
                // A part caught across " · " belongs to the split below: "… (best) · 1280×720 · 5 s (2 parts)" matched
                // "{0} ({1} parts)" with {1} = "best) · … · 5 s (2" and stayed English (09.10.2026)
                if (!m || (!k.dot && m.slice(1).some((v) => v.includes(' · ')))) continue;
                const values = {};
                k.position.forEach((no, i) => {
                    values[no] = translate(m[i + 1], target, depth + 1);
                });
                return k.tr.replace(/\{(\d+)\}/g, (_, no) => values[no] ?? '');
            }
            const split = (separator) => {
                const parts = t.split(separator);
                if (parts.length < 2) return null;
                const translated = parts.map((p) => (/^\s*$/.test(p) || separator.test?.(p) ? p : translate(p, target, depth + 1)));
                return translated.some((p, i) => p !== parts[i]) ? translated.join('') : null;
            };
            // Birleşik metin: satırlar, " · " ile dizilenler, " — " açıklamalar, cümleler ayrı ayrı.
            return split(/(\n)/) ?? split(/( · )/) ?? split(/( — )/) ?? split(/(?<=[.!?])(\s+)(?=\S)/);
        };
        const result = find(trimmed);
        return result === null ? s : startedAt + result + last;
    }

    /* ── Sayfa çevirisi ────────────────────────────────────────────────── */

    const originalText = new WeakMap(); // Text -> { ozgun, yazilan }
    const originalOz = new WeakMap(); // Element -> { ad: { ozgun, yazilan } }

    // translate is inherited as in HTML: the nearest element with the attribute decides (translate="yes" inside a
    // translate="no" answer: the panel's own buttons in it, such as Preview on a code block; 08.10.2026)
    const untranslated = (e) => e.closest('[translate]')?.getAttribute('translate') === 'no';
    const skipped = (node) => {
        const e = node.nodeType === 1 ? node : node.parentElement;
        return !e || untranslated(e) || Boolean(e.closest('script, style, textarea, code.no-ceviri'));
    };

    function translateText(t) {
        if (skipped(t)) return;
        const record = originalText.get(t);
        const current = t.nodeValue;
        let original = current;
        if (record && current === record.written) original = record.original;
        const fresh = translate(original);
        originalText.set(t, { original, written: fresh });
        if (fresh !== current) t.nodeValue = fresh;
    }

    function translateAttribute(e, name) {
        // Öznitelikte yalnız translate=no engeller: textarea/input'un placeholder'ı da çevrilir.
        if (!e.hasAttribute(name) || untranslated(e)) return;
        const records = originalOz.get(e) ?? {};
        const current = e.getAttribute(name);
        let original = current;
        if (records[name] && current === records[name].written) original = records[name].original;
        const fresh = translate(original);
        records[name] = { original, written: fresh };
        originalOz.set(e, records);
        if (fresh !== current) e.setAttribute(name, fresh);
    }

    function translateTree(root) {
        if (!root) return;
        if (root.nodeType === 3) {
            translateText(root);
            return;
        }
        if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
        if (root.nodeType === 1) for (const name of ATTRIBUTES) translateAttribute(root, name);
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let d = walk.nextNode();
        while (d) {
            if (d.nodeType === 3) translateText(d);
            else {
                for (const name of ATTRIBUTES) translateAttribute(d, name);
                if (d.tagName === 'TEMPLATE') translateTree(d.content);
            }
            d = walk.nextNode();
        }
    }

    function translateDocument() {
        document.documentElement.lang = language;
        if (!originalText.has(document)) originalText.set(document, { original: document.title });
        document.title = translate(originalText.get(document).original);
        translateTree(document.body);
        // Document links open in the chosen language (?lang=).
        document.querySelectorAll('[data-language-link]').forEach((b) => {
            const u = new URL(b.getAttribute('href'), location.href);
            u.searchParams.set('lang', language);
            b.setAttribute('href', u.pathname + u.search);
        });
        document.querySelectorAll(LANGUAGE_BUTTON).forEach((d) => {
            d.setAttribute('aria-pressed', String(buttonLanguage(d) === language));
        });
    }

    const LANGUAGE_BUTTON = '[data-language-select]';
    const buttonLanguage = (d) => d.dataset.languageSelect;

    const observer = new MutationObserver((records) => {
        for (const k of records) {
            if (k.type === 'characterData') translateText(k.target);
            else if (k.type === 'attributes') translateAttribute(k.target, k.attributeName);
            else k.addedNodes.forEach(translateTree);
        }
    });

    function selectLanguage(fresh) {
        if (!LANGUAGES.includes(fresh) || fresh === language) return;
        language = fresh;
        try {
            localStorage.setItem(KEY, language);
        } catch {
            /* this page only */
        }
        translateDocument();
        document.dispatchEvent(new CustomEvent('language-changed', { detail: { language } }));
    }

    document.addEventListener('click', (event) => {
        const d = event.target.closest(LANGUAGE_BUTTON);
        if (d) selectLanguage(buttonLanguage(d));
    });

    translateDocument();
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });

    window.NedeseLang = {
        get language() {
            return language;
        },
        get local() {
            return language === 'tr' ? 'tr-TR' : 'en-US';
        },
        translate: (m) => translate(m),
        select: selectLanguage,
        // Test ve denetim: görünen Türkçe metinler (EN'de sözlükten sızan ya da kaynakta kalan Türkçe).
        missing() {
            const set = new Set();
            // Turkish letters, a percent before its number ("%3") and Turkish units ("5 sn"): an English recording showed
            // "GPU 0.8/12 GB · %0" and "5 sn" (09.10.2026)
            const turkish = /[çğıöşüÇĞİÖŞÜ]|(^|[\s(·])%\d|\b\d+ (sn|dk|sa)\b/;
            // the browser's own file field speaks the system's language ("Dosyaları Seç"): the panel draws its own
            document.querySelectorAll('input[type="file"]').forEach((e) => {
                if (e.offsetParent !== null) set.add('native file field: ' + (e.id || e.name || e.outerHTML.slice(0, 60)));
            });
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let d = walk.nextNode();
            while (d) {
                if (!skipped(d) && turkish.test(d.nodeValue) && d.parentElement.offsetParent !== null) set.add(d.nodeValue.trim());
                d = walk.nextNode();
            }
            // Görünen öznitelikler (yer tutucu, ipucu) de denetlenir.
            document.querySelectorAll(ATTRIBUTES.map((o) => '[' + o + ']').join(',')).forEach((e) => {
                if (untranslated(e)) return;
                for (const o of ['placeholder', 'title', 'aria-label']) {
                    const v = e.getAttribute(o);
                    if (v && turkish.test(v)) set.add(o + ': ' + v);
                }
            });
            return [...set];
        },
    };
})();
