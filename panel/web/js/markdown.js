/*
 * Markdown for the chat (user request 08.10.2026: tables showed as raw pipes): parses the model's answer into plain
 * objects; web/chat.js builds DOM nodes from them (text nodes only, never HTML), so nothing in an answer can run.
 * SHARED by the browser (classic script, window.NedeseMarkdown) and the tests (import sets globalThis).
 *
 * Blocks: paragraph (lines; the model's line breaks stay), heading (# … ######), code (``` or ~~~ fences, open at the
 * end while streaming), quote (>), list (-, *, +, 1. or 1); nested by indentation, - [ ] tasks), table (GitHub pipe
 * tables with :--: alignment), hr (---, ***, ___).
 * Inline: **strong**, __strong__, *em*, _em_ (not inside words: snake_case stays), ***both***, ~~del~~, `code`,
 * [text](url), ![alt](url), <https://…>, bare http(s) addresses and panel paths (/file/…). A link is kept only for
 * http(s) addresses and the panel's own /file/ and /api/ paths; anything else (javascript:, data:) stays plain text.
 */
(function () {
    'use strict';

    const SAFE_URL = /^(https?:\/\/|\/file\/|\/api\/)/i;
    const safeUrl = (u) => (SAFE_URL.test(u) ? u : null);
    const WORD = /[\p{L}\p{N}]/u;
    // _emphasis_ only between words: snake_case_name and __dunder__ names in code-like text stay as written
    const UNDERSCORE_WORD = /[\p{L}\p{N}_]/u;

    const INLINE = {
        escape: /\\([\\`*_~[\]()#+\-.!|>{}])/y,
        code: /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/y,
        image: /!\[([^\]]*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y,
        link: /\[((?:\\.|[^[\]\\]|\[[^[\]]*\])*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y,
        angle: /<(https?:\/\/[^\s<>]+)>/y,
        url: /https?:\/\/[^\s<>"'`]+/y,
        file: /\/file\/[^\s)<>"'`]+/y,
        both: /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*(?!\*)/y,
        strong: /\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/y,
        strongU: /__(?=\S)([\s\S]*?\S)__/y,
        em: /\*(?![\s*])((?:[^*]|\*\*[^*]+\*\*)*?[^\s*])\*(?!\*)/y,
        emU: /_(?![\s_])([\s\S]*?[^\s_])_/y,
        del: /~~(?=\S)([\s\S]*?\S)~~/y,
    };
    // where something inline may start (everything between is plain text)
    const SPECIAL = /[\\`![<*_~]|https?:\/\/|\/file\//g;

    const at = (re, text, i) => {
        re.lastIndex = i;
        return re.exec(text);
    };

    /** An address found in running text ends before closing punctuation and an unmatched ")". */
    function trimUrl(u) {
        let s = u.replace(/[.,;:!?*_~]+$/, '');
        while (s.endsWith(')') && (s.match(/\(/g) ?? []).length < (s.match(/\)/g) ?? []).length) s = s.slice(0, -1).replace(/[.,;:!?]+$/, '');
        return s;
    }

    /** Inline nodes of one line: strings and { type: strong | em | del | code | link | image }. links: false inside a link text. */
    function inline(text, { links = true } = {}) {
        const out = [];
        let plain = '';
        const push = (node) => {
            if (plain) out.push(plain);
            plain = '';
            out.push(node);
        };
        const s = String(text ?? '');
        let i = 0;
        while (i < s.length) {
            SPECIAL.lastIndex = i;
            const next = SPECIAL.exec(s);
            if (!next) {
                plain += s.slice(i);
                break;
            }
            plain += s.slice(i, next.index);
            i = next.index;
            const before = s[i - 1] ?? '';
            const c = s[i];
            let m = null;
            if (c === '\\' && (m = at(INLINE.escape, s, i))) {
                plain += m[1];
            } else if (c === '`' && (m = at(INLINE.code, s, i))) {
                const body = m[2];
                push({ type: 'code', text: /^ .* $/.test(body) && body.trim() ? body.slice(1, -1) : body });
            } else if (c === '!' && links && (m = at(INLINE.image, s, i))) {
                const src = safeUrl(m[2]);
                if (src) push({ type: 'image', src, alt: m[1] });
                else plain += m[0];
            } else if (c === '[' && links && (m = at(INLINE.link, s, i))) {
                const href = safeUrl(m[2]);
                if (href) push({ type: 'link', href, children: inline(m[1], { links: false }) });
                else plain += m[0];
            } else if (c === '<' && links && (m = at(INLINE.angle, s, i))) {
                push({ type: 'link', href: m[1], children: [m[1]] });
            } else if (c === 'h' && links && !WORD.test(before) && (m = at(INLINE.url, s, i))) {
                const url = trimUrl(m[0]);
                push({ type: 'link', href: url, children: [url] });
                i += url.length;
                continue;
            } else if (c === '/' && links && !WORD.test(before) && (m = at(INLINE.file, s, i))) {
                const path = trimUrl(m[0]);
                push({ type: 'link', href: path, children: [path] });
                i += path.length;
                continue;
            } else if (c === '*' && (m = at(INLINE.both, s, i))) {
                push({ type: 'strong', children: [{ type: 'em', children: inline(m[1], { links }) }] });
            } else if (c === '*' && (m = at(INLINE.strong, s, i))) {
                push({ type: 'strong', children: inline(m[1], { links }) });
            } else if (c === '_' && !UNDERSCORE_WORD.test(before) && (m = at(INLINE.strongU, s, i)) && !UNDERSCORE_WORD.test(s[i + m[0].length] ?? '')) {
                push({ type: 'strong', children: inline(m[1], { links }) });
            } else if (c === '*' && (m = at(INLINE.em, s, i)) && !(WORD.test(before) && WORD.test(s[i + m[0].length] ?? ''))) {
                // (2*3*4 is arithmetic, not emphasis)
                push({ type: 'em', children: inline(m[1], { links }) });
            } else if (c === '_' && !UNDERSCORE_WORD.test(before) && (m = at(INLINE.emU, s, i)) && !UNDERSCORE_WORD.test(s[i + m[0].length] ?? '')) {
                push({ type: 'em', children: inline(m[1], { links }) });
            } else if (c === '~' && (m = at(INLINE.del, s, i))) {
                push({ type: 'del', children: inline(m[1], { links }) });
            } else m = null;
            if (m) i += m[0].length;
            else {
                // not markup: the character itself (a lone *, a word like "http" without an address)
                plain += s[i];
                i += 1;
            }
        }
        if (plain) out.push(plain);
        return out;
    }

    const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
    const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
    const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
    const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
    const QUOTE = /^ {0,3}>/;
    const indentOf = (line) => /^ */.exec(line)[0].length;

    /** Cells of a table row: outer pipes dropped, split on pipes that are not escaped (\|) or inside `code`. */
    function cells(line) {
        let s = line.trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
        const out = [];
        let cell = '';
        let code = false;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '\\' && s[i + 1] === '|') {
                cell += '|';
                i += 1;
            } else if (c === '`') {
                code = !code;
                cell += c;
            } else if (c === '|' && !code) {
                out.push(cell.trim());
                cell = '';
            } else cell += c;
        }
        out.push(cell.trim());
        return out;
    }

    const DELIMITER_CELL = /^:?-+:?$/;
    function tableStart(line, next) {
        if (!line.includes('|') || next === undefined || !/^[\s|:-]+$/.test(next) || !next.includes('-')) return null;
        const head = cells(line);
        const align = cells(next);
        if (align.length !== head.length || !align.every((a) => DELIMITER_CELL.test(a))) return null;
        return { head, align: align.map((a) => (a.startsWith(':') && a.endsWith(':') ? 'center' : a.endsWith(':') ? 'right' : a.startsWith(':') ? 'left' : null)) };
    }

    /** Does this line begin a block of its own (it ends a paragraph or a list item's loose text)? */
    const startsBlock = (line, next) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || Boolean(tableStart(line, next));

    function list(lines, start) {
        const first = LIST_ITEM.exec(lines[start]);
        const indent = first[1].length;
        const ordered = /\d/.test(first[2]);
        const block = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
        let item = null;
        let i = start;
        const close = () => {
            if (!item) return;
            const task = /^\[([ xX])\][ \t]+/.exec(item.lines[0] ?? '');
            if (task) item.lines[0] = item.lines[0].slice(task[0].length);
            block.items.push({ task: task ? task[1] !== ' ' : null, blocks: blocks(item.lines) });
            item = null;
        };
        while (i < lines.length) {
            const line = lines[i];
            const m = LIST_ITEM.exec(line);
            if (m && m[1].length === indent) {
                // another kind of marker at the same depth starts another list
                if (/\d/.test(m[2]) !== ordered) break;
                close();
                item = { lines: [m[3] ?? ''], inner: indent + m[2].length + 1 };
                i += 1;
                continue;
            }
            if (m && m[1].length < indent) break;
            if (!line.trim()) {
                // a blank line: the list goes on when the next text is indented under it or is its next item
                let j = i + 1;
                while (j < lines.length && !lines[j].trim()) j += 1;
                const n = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
                if (j < lines.length && ((n && n[1].length === indent && /\d/.test(n[2]) === ordered) || indentOf(lines[j]) > indent)) {
                    item?.lines.push('');
                    i += 1;
                    continue;
                }
                break;
            }
            if (indentOf(line) > indent) {
                item.lines.push(line.slice(Math.min(item.inner, indentOf(line))));
                i += 1;
                continue;
            }
            // text at the list's own depth: more of the item's line unless it begins a block
            if (startsBlock(line, lines[i + 1]) || (m && m[1].length === indent)) break;
            item.lines.push(line.trim());
            i += 1;
        }
        close();
        return { block, next: i };
    }

    /** Blocks of the given lines (also the inside of a quote or a list item). */
    function blocks(lines) {
        const out = [];
        let para = null;
        const endPara = () => {
            if (para) out.push({ type: 'paragraph', lines: para.map((l) => inline(l)) });
            para = null;
        };
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            const fence = FENCE.exec(line);
            if (fence) {
                endPara();
                const mark = fence[1];
                const body = [];
                i += 1;
                const closing = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
                while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
                i += 1;
                out.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
                continue;
            }
            if (!line.trim()) {
                endPara();
                i += 1;
                continue;
            }
            const heading = HEADING.exec(line);
            if (heading) {
                endPara();
                out.push({ type: 'heading', level: heading[1].length, inline: inline(heading[2] ?? '') });
                i += 1;
                continue;
            }
            if (RULE.test(line)) {
                endPara();
                out.push({ type: 'hr' });
                i += 1;
                continue;
            }
            if (QUOTE.test(line)) {
                endPara();
                const body = [];
                while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^ {0,3}> ?/, ''));
                out.push({ type: 'quote', blocks: blocks(body) });
                continue;
            }
            const table = tableStart(line, lines[i + 1]);
            if (table) {
                endPara();
                i += 2;
                const rows = [];
                while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
                out.push({ type: 'table', align: table.align, head: table.head.map((c) => inline(c)), rows: rows.map((r) => table.head.map((_, k) => inline(r[k] ?? ''))) });
                continue;
            }
            const item = LIST_ITEM.exec(line);
            // inside a paragraph only a bullet or "1." starts a list ("2024. was a good year" stays text)
            if (item && (!para || !/\d/.test(item[2]) || parseInt(item[2], 10) === 1) && (item[3] ?? '').trim()) {
                endPara();
                const r = list(lines, i);
                out.push(r.block);
                i = r.next;
                continue;
            }
            (para ??= []).push(line.replace(/^ +/, ''));
            i += 1;
        }
        endPara();
        return out;
    }

    /** The blocks of a whole answer (tabs count as 4 spaces). */
    function parse(text) {
        return blocks(String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
    }

    globalThis.NedeseMarkdown = { parse, inline, safeUrl };
})();
