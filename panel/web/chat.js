/**
 * Chat section (#chat): talk to the panel's local text model, which works with tools (panel jobs, files, shell, web,
 * MCP servers, skills) and carries out multi-step tasks on its own when a request needs them. Backend: /api/v1/chat
 * (lib/agent). Live updates come over Server-Sent Events.
 *
 * Layout: chat list on the left (collapsible on phones; the latest 10 chats, 5 on phones, "See all" pages in more
 * while scrolling; search over titles and messages), messages on the right, composer sticky at the bottom.
 * Per chat, changeable while it runs, in the Options popover (icon in the composer): approval mode (Manual | Allow
 * edits | Automatic) and text model; a short label beside the icon shows a choice that is not the default. Compact
 * summarizes the conversation so far (also by typing /compact). Delete asks first and deletes the jobs the chat created.
 * The answer appears as it is written (delta events). Typing "/" lists the commands with a description (arrow keys,
 * Tab or Enter to pick).
 * Attachments: paste an image with Ctrl+V, drag and drop files, or use the attach button; images are uploaded to
 * /api/v1/uploads/image and sent as { source, type } so the model can see them and pass them to tools.
 *
 * CLASSIC SCRIPT: loaded after app.js and uses its helpers (window.NedesePanel: el, api, notify).
 * Messages are rendered incrementally (no full redraw on every event).
 */
(function () {
    'use strict';

    const { el, api, notify } = window.NedesePanel;
    const $ = (s, k = document) => k.querySelector(s);
    const section = $('[data-section="chat"]');
    if (!section) return;

    const PAGE = 30;
    const phone = () => matchMedia('(max-width: 900px)').matches;
    const visibleCount = () => (phone() ? 5 : 10);

    // A chat's model value for the remote OpenAI-compatible model of Settings › Remote model (user request 08.10.2026)
    const REMOTE = 'remote';

    const state = {
        open: false,
        chats: [], // loaded list pages (or search results)
        total: 0,
        next: null, // cursor of the next page
        query: '',
        expanded: false,
        loadingMore: false,
        models: [],
        defaultModel: null,
        remote: null, // Settings › Remote model ({ model, whenBusy }) when it is set
        current: null, // chat detail (messages)
        progress: '',
        listStream: null,
        chatStream: null,
        attachments: [], // { source, type, name, previewUrl, uploading }
        toolCards: new Map(), // tool call id -> card element
        toolCalls: new Map(), // tool call id -> { name, input } (live: which results are created jobs)
        turnEdits: [], // the running turn's file edits (their summary comes when the turn ends)
        createdJobs: new Set(),
        listSignature: '',
        // a new chat starts in Automatic (user request 08.10.2026: "Direk otomatik seçili olsun"); a mode chosen in the
        // options is remembered on this device (a new key: choices saved before this default do not count)
        newApprovalMode: 'auto',
        newModel: '',
        newAutoCompact: true,
        newThinking: 'low',
        translatePrompt: null, // panel-wide prompt translation (null: no settings file)
        presets: [], // assistant presets (GET /chat/presets)
        templates: [], // prompt templates offered under "/" (GET /chat/templates)
        newPreset: '', // the preset a new chat starts with (remembered on this device)
        // Pinned chats above the others, the archive apart, temporary chats (user request 08.10.2026)
        pinned: [],
        archivedCount: 0,
        archivedView: false,
        newTemporary: false, // a new chat starts temporary (not saved) while this is on
        knowledge: { documents: [], status: null }, // Knowledge: the documents the assistant searches (GET /knowledge)
        // Projects (user request 10.10.2026): the list shows the chosen project's chats and a new chat goes into it
        projects: [],
        project: '',
    };
    try {
        const m = localStorage.getItem('chat.newApprovalMode');
        if (['manual', 'edits', 'auto'].includes(m)) state.newApprovalMode = m;
        const t = localStorage.getItem('chat.thinking');
        if (['none', 'low', 'medium', 'high'].includes(t)) state.newThinking = t;
        state.newPreset = localStorage.getItem('chat.preset') ?? '';
        state.project = localStorage.getItem('chat.project') ?? '';
    } catch {
        /* private mode */
    }

    const listBox = $('[data-chat-list]', section);
    const listItems = $('[data-chat-items]', section);
    const searchInput = $('[data-chat-search]', section);
    const searchSort = $('[data-chat-search-sort]', section);
    const searchToggle = $('[data-chat-search-toggle]', section);
    const moreButton = $('[data-chat-more]', section);
    const messagesBox = $('[data-chat-messages]', section);
    const titleBox = $('[data-chat-title]', section);
    const statusLine = $('[data-chat-status]', section);
    const form = $('[data-chat-form]', section);
    const input = $('[data-chat-input]', section);
    const sendButton = $('[data-chat-send]', section);
    const stopButton = $('[data-chat-stop]', section);
    const attachInput = $('[data-chat-file]', section);
    const attachPreview = $('[data-chat-attachments]', section);
    const optionsButton = $('[data-chat-options]', section);
    const optionsLabel = $('[data-chat-options-label]', section);
    const optionsPanel = $('[data-chat-options-panel]', section);
    const contextButton = $('[data-chat-context]', section);
    const contextLabel = $('[data-chat-context-label]', section);
    const contextPanel = $('[data-chat-context-panel]', section);
    // Two delete buttons: in the chat header (wide screens) and in the list row (phones)
    const deleteForms = [...section.querySelectorAll('[data-chat-delete-form]')];
    const deleteButtons = [...section.querySelectorAll('[data-chat-delete]')];
    const composer = $('[data-chat-composer]', section);
    const menuButton = $('[data-chat-menu]', section);
    const menuPanel = $('[data-chat-menu-panel]', section);
    const temporaryBox = $('[data-chat-temporary]', section);
    const keepButton = $('[data-chat-keep]', section);
    const archivedButton = $('[data-chat-archived]', section);
    const importButton = $('[data-chat-import]', section);
    const importFile = $('[data-chat-import-file]', section);
    const projectSelect = $('[data-chat-project]', section);
    const projectInfo = $('[data-chat-project-info]', section);
    // The line above the composer (user request 09.10.2026): what the chat does now, its tokens and what it runs in the
    // background ("2 sub-agents (1 running) · 1 watcher"); with background items it is a button that opens their list
    // right under it. Its parts stay between renders, so the button keeps its focus while events redraw the line.
    const statusParent = el('button', { type: 'button', class: 'btn btn--ghost btn--sm chat__status-parent', 'data-chat-parent': true, hidden: true, title: 'Open the chat that started this sub-agent' }, el('span', { 'aria-hidden': 'true', text: '↑ ' }), el('span', { text: 'Parent chat' }));
    const statusWork = el('span', { class: 'chat__status-work' });
    const statusUsage = el('span', { class: 'chat__status-usage' });
    const backgroundToggle = el('button', { type: 'button', class: 'chat__background-toggle', 'data-chat-background': true, 'aria-expanded': 'false', 'aria-controls': 'chat-background-list', hidden: true });
    const backgroundBox = el('div', { class: 'chat__background', id: 'chat-background-list', 'data-chat-background-list': true, role: 'list', 'aria-label': 'In the background', hidden: true });
    statusLine.replaceChildren(statusParent, statusWork, statusUsage, backgroundToggle);
    statusLine.after(backgroundBox);

    /*
     * ── Markdown (safe: web/js/markdown.js parses, this builds DOM nodes from text only, never innerHTML) ──
     * Tables, headings, lists (nested, numbered, tasks), quotes, rules, emphasis, code, links (http/https and the
     * panel's /file/ and /api/ paths only); a link to an image, video or sound shows the media itself.
     */

    const plainText = (nodes) => nodes.map((n) => (typeof n === 'string' ? n : n.text ?? plainText(n.children ?? []))).join('');

    function inlineNodes(nodes) {
        return nodes.map((n) => {
            if (typeof n === 'string') return n;
            if (n.type === 'code') return el('code', { text: n.text });
            if (n.type === 'strong' || n.type === 'em' || n.type === 'del') return el(n.type, {}, ...inlineNodes(n.children));
            if (n.type === 'image') return media(n.src, n.alt);
            if (n.type === 'link') return isMedia(n.href) ? media(n.href, plainText(n.children)) : el('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, ...inlineNodes(n.children));
            return '';
        });
    }

    /** Lines of a paragraph: the model's line breaks stay. */
    const lineNodes = (lines) => lines.flatMap((l, j) => (j ? [el('br'), ...inlineNodes(l)] : inlineNodes(l)));
    const cellClass = (align) => (align ? `message__cell--${align}` : null);
    // Longest cell text of a column that never wraps (e.g. "1570 B", "09.10.2026 07:40")
    const SHORT_CELL = 16;

    function blockNodes(blocks) {
        return blocks.map((b) => {
            if (b.type === 'code') return codeBlock(b);
            // # is the chat's biggest heading: h3 (the page and the chat title come first)
            if (b.type === 'heading') return el(`h${Math.min(6, b.level + 2)}`, { class: `message__heading message__heading--${Math.min(4, b.level)}` }, ...inlineNodes(b.inline));
            if (b.type === 'hr') return el('hr');
            if (b.type === 'quote') return el('blockquote', {}, ...blockNodes(b.blocks));
            if (b.type === 'list') return el(b.ordered ? 'ol' : 'ul', { start: b.ordered && b.start !== 1 ? b.start : null }, ...b.items.map(listItem));
            if (b.type === 'table') {
                // A column of short values (size, date, state) stays on one line: on a phone it got the width of its
                // heading and "353 B" broke into "353" and "B" (09.10.2026)
                const short = b.head.map((h, k) => [h, ...b.rows.map((r) => r[k])].every((c) => plainText(c).length <= SHORT_CELL));
                const cls = (k) => [cellClass(b.align[k]), short[k] ? 'message__cell--nowrap' : null].filter(Boolean).join(' ') || null;
                return el('div', { class: 'message__table' }, el('table', {},
                    el('thead', {}, el('tr', {}, ...b.head.map((c, k) => el('th', { class: cls(k) }, ...inlineNodes(c))))),
                    el('tbody', {}, ...b.rows.map((r) => el('tr', {}, ...r.map((c, k) => el('td', { class: cls(k) }, ...inlineNodes(c))))))));
            }
            return el('p', {}, ...lineNodes(b.lines));
        });
    }

    /** A list item: its first paragraph inline (compact lists), then its other blocks (a nested list). */
    function listItem(item) {
        const li = el('li', { class: item.task === null ? null : 'message__task' });
        if (item.task !== null) li.append(el('input', { type: 'checkbox', disabled: true, checked: item.task }), ' ');
        const [first, ...rest] = item.blocks;
        if (first?.type === 'paragraph') li.append(...lineNodes(first.lines), ...blockNodes(rest));
        else li.append(...blockNodes(item.blocks));
        return li;
    }

    const markdown = (text) => blockNodes(window.NedeseMarkdown.parse(text));

    /*
     * ── Previews (user request 08.10.2026): an HTML or SVG code block in an answer gets a Preview button that shows it
     * running beside the chat (full screen on phones). The page runs in a sandboxed frame without the panel's origin
     * (sandbox="allow-scripts", no allow-same-origin: no access to the panel, its storage or its API) and its own
     * Content-Security-Policy stops it from sending data anywhere (no fetch, XHR, WebSocket or form posts).
     */

    /** 'html', 'svg' or null: what a code block can be previewed as (by its language, else by how it starts). */
    function previewKind(lang, text) {
        const l = String(lang ?? '').toLowerCase();
        const start = String(text ?? '').trimStart().slice(0, 300).toLowerCase();
        if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/.test(start) && ['', 'svg', 'xml', 'html', 'image/svg+xml'].includes(l)) return 'svg';
        if (l === 'svg') return 'svg';
        if (['html', 'htm', 'xhtml'].includes(l) || (!l && /^(<!doctype html|<html[\s>])/.test(start))) return 'html';
        return null;
    }

    /**
     * A code block of an answer: its language, Copy (user request 08.10.2026) and, for HTML and SVG, Preview above it;
     * the code in colors (js/highlight.js, every character escaped) when its language is known.
     */
    function codeBlock(b) {
        const code = el('code', { 'data-lang': b.lang || null });
        if (window.NedeseHighlight?.language(b.lang)) code.innerHTML = window.NedeseHighlight.highlight(b.text, b.lang);
        else code.textContent = b.text;
        const pre = el('pre', {}, code);
        const kind = previewKind(b.lang, b.text);
        const copy = el('button', { type: 'button', class: 'message__action', 'data-code-copy': true, 'aria-label': 'Copy code', title: 'Copy code', text: 'Copy' });
        copy.addEventListener('click', () => copyText(b.text, copy));
        const buttons = [copy];
        if (kind) {
            // code blocks with the same page title (or none, of the same kind) are versions of one artifact
            const key = `block:${kind}:${pageTitle(b.text)}`;
            const button = el('button', { type: 'button', class: 'message__action message__preview-button', 'data-code-preview': kind, 'data-artifact-key': key, text: 'Preview' });
            button.artifact = { code: b.text, kind, title: pageTitle(b.text), name: '' };
            button.addEventListener('click', () => openArtifact(key, button));
            buttons.push(button);
        }
        const label = kind ? (kind === 'svg' ? 'SVG' : 'HTML') : String(b.lang ?? '');
        return el('div', { class: 'message__code' },
            // the answer is not translated, the panel's buttons in it are
            el('div', { class: 'message__code-bar', translate: 'yes' }, el('span', { class: 'message__code-lang', translate: 'no', text: label }), el('span', { class: 'message__code-buttons' }, ...buttons)),
            pre);
    }

    /**
     * Puts text on the clipboard: the Clipboard API where the page may use it (this computer, https), else a hidden
     * text box and the copy command (the phone on http over the local network has no Clipboard API). The button says
     * Copied for a moment.
     */
    async function copyText(text, button = null) {
        let done = false;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                done = true;
            }
        } catch {
            // refused (no focus, no permission): the old way below
        }
        if (!done) {
            const box = el('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0' });
            box.value = text;
            document.body.append(box);
            box.select();
            box.setSelectionRange(0, text.length);
            try {
                done = document.execCommand('copy');
            } catch {
                done = false;
            }
            box.remove();
        }
        if (!done) {
            notify('Copying is not allowed here: select the text and copy it.', 'warning');
            return false;
        }
        if (button) {
            button.dataset.copied = 'true';
            const label = button.getAttribute('aria-label');
            if (button.textContent) {
                const before = button.textContent;
                button.textContent = 'Copied';
                setTimeout(() => {
                    button.textContent = before;
                    delete button.dataset.copied;
                }, 1500);
            } else {
                button.title = 'Copied';
                setTimeout(() => {
                    button.title = label;
                    delete button.dataset.copied;
                }, 1500);
            }
        } else notify('Copied.', 'success');
        return true;
    }

    /** The document the frame shows: the policy goes first in its head (an SVG gets a page of its own). */
    function previewDocument(code, kind) {
        const own = location.origin;
        const policy = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'unsafe-inline' https:; img-src data: blob: https: ${own}; media-src data: blob: https: ${own}; font-src data: https:; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src blob:`;
        const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`;
        if (kind === 'svg') return `<!doctype html><html><head><meta charset="utf-8">${meta}<style>html,body{margin:0;height:100%;background:#fff}body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh;height:auto}</style></head><body>${code.replace(/^\s*<\?xml[^>]*>/i, '')}</body></html>`;
        const head = /<head(\s[^>]*)?>/i.exec(code);
        if (head) return code.slice(0, head.index + head[0].length) + meta + code.slice(head.index + head[0].length);
        const doctype = /^\s*<!doctype[^>]*>/i.exec(code);
        if (doctype) return doctype[0] + meta + code.slice(doctype[0].length);
        return meta + code;
    }

    /*
     * ── Artifacts (user request 10.10.2026, like Claude's): the preview panel shows one artifact with its versions. An
     * HTML or SVG file the agent writes or edits is one artifact, a version per write; code blocks in answers with the
     * same page title are versions of one. Every source in the chat carries data-artifact-key and its content
     * (element.artifact), so the versions are the chat's sources of that key in order. When the agent writes one, the
     * panel opens by itself on a wide screen (a card in the chat opens it on a phone). Code shows the source, Download
     * saves the version shown, Full screen covers the chat.
     */

    const pageTitle = (code) => decodeEntities(/<title[^>]*>([^<]{1,120})<\/title>/i.exec(code)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    function decodeEntities(s) {
        const t = document.createElement('textarea');
        t.innerHTML = s;
        return t.value;
    }
    const artifactSources = (key) => [...messagesBox.querySelectorAll('[data-artifact-key]')].filter((n) => n.dataset.artifactKey === key && n.artifact && !n.closest('.message--live'));

    let preview = null; // { box, opener, key, index, code: showing the source, full }
    function openArtifact(key, opener = null, { focus = true } = {}) {
        const sources = artifactSources(key);
        if (!sources.length) return;
        const index = opener && sources.includes(opener) ? sources.indexOf(opener) : sources.length - 1;
        if (preview?.key === key) {
            preview.index = index;
            preview.opener = opener ?? preview.opener;
            return renderArtifact();
        }
        closePreview({ focus: false });
        const close = el('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'data-code-preview-close': true, 'aria-label': 'Close preview', title: 'Close preview', text: 'Close' });
        close.addEventListener('click', () => closePreview());
        const box = el('div', { class: 'artifact', role: 'dialog', 'aria-label': 'Preview', 'data-code-preview-panel': true });
        document.body.append(box);
        preview = { box, opener, key, index, code: false, full: false, close, chat: state.current?.id ?? null };
        renderArtifact();
        if (focus) close.focus();
    }

    function renderArtifact() {
        if (!preview) return;
        const p = preview;
        const sources = artifactSources(p.key);
        if (!sources.length) return closePreview({ focus: false });
        p.index = Math.min(Math.max(0, p.index), sources.length - 1);
        const a = sources[p.index].artifact;
        const kindName = a.kind === 'svg' ? 'SVG' : 'HTML';
        const button = (attrs, text, onClick) => {
            const b = el('button', { type: 'button', class: 'btn btn--sm btn--ghost', ...attrs, text });
            b.addEventListener('click', onClick);
            return b;
        };
        const step = (by) => () => {
            p.index += by;
            renderArtifact();
        };
        const versions = sources.length > 1 ? el('span', { class: 'artifact__versions', 'data-artifact-versions': true },
            button({ 'data-artifact-previous': true, 'aria-label': 'Previous version', title: 'Previous version', disabled: p.index === 0 }, '‹', step(-1)),
            el('span', { class: 'artifact__version', 'data-artifact-version': true, text: `Version ${p.index + 1} of ${sources.length}` }),
            button({ 'data-artifact-next': true, 'aria-label': 'Next version', title: 'Next version', disabled: p.index === sources.length - 1 }, '›', step(1))) : null;
        const code = button({ 'data-artifact-code': true, 'aria-pressed': String(p.code) }, p.code ? 'Preview' : 'Code', () => {
            p.code = !p.code;
            renderArtifact();
        });
        const download = button({ 'data-artifact-download': true }, 'Download', () => downloadArtifact(a));
        const full = button({ 'data-artifact-full': true, 'aria-pressed': String(p.full) }, p.full ? 'Exit full screen' : 'Full screen', () => {
            p.full = !p.full;
            renderArtifact();
        });
        let body;
        if (p.code) {
            const source = el('code', { 'data-lang': a.kind });
            if (window.NedeseHighlight?.language(a.kind === 'svg' ? 'xml' : 'html')) source.innerHTML = window.NedeseHighlight.highlight(a.code, a.kind === 'svg' ? 'xml' : 'html');
            else source.textContent = a.code;
            body = el('pre', { class: 'artifact__source', translate: 'no', 'data-artifact-source': true }, source);
        } else {
            body = el('iframe', { class: 'artifact__frame', sandbox: 'allow-scripts', title: 'Preview', referrerpolicy: 'no-referrer', 'data-code-preview-frame': true });
            body.srcdoc = previewDocument(a.code, a.kind);
        }
        p.box.classList.toggle('artifact--full', p.full);
        p.box.replaceChildren(
            el('div', { class: 'artifact__head' },
                el('span', { class: 'artifact__name' },
                    el('span', { class: 'artifact__title', translate: a.title || a.name ? 'no' : null, title: a.path ?? null, text: a.name || a.title || `${kindName} preview` }),
                    el('span', { class: 'artifact__kind', translate: 'no', text: kindName })),
                versions,
                el('span', { class: 'artifact__buttons' }, code, download, full, p.close)),
            body);
    }

    /** The version shown, saved as a file: the file's own name, else the page title (or page / image). */
    function downloadArtifact(a) {
        const ext = a.kind === 'svg' ? 'svg' : 'html';
        const name = a.name || `${(a.title || (a.kind === 'svg' ? 'image' : 'page')).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'page'}.${ext}`;
        const url = URL.createObjectURL(new Blob([a.code], { type: a.kind === 'svg' ? 'image/svg+xml' : 'text/html' }));
        const link = el('a', { href: url, download: name, hidden: true });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    /** A file the agent wrote, as a card under its tool call: its name and Open. */
    function artifactCard(artifact) {
        const key = `file:${artifact.path}`;
        const name = fileName(artifact.path);
        const open = el('button', { type: 'button', class: 'btn btn--sm', 'data-artifact-open': true, text: 'Open' });
        const card = el('div', { class: 'artifact-card', 'data-artifact-key': key },
            fileMark(artifact.path),
            el('span', { class: 'artifact-card__name', translate: 'no', title: artifact.path, text: name }),
            el('span', { class: 'artifact-card__kind text-sm text-muted', text: artifact.kind === 'svg' ? 'SVG image' : 'Web page' }),
            open);
        card.artifact = { code: String(artifact.content ?? ''), kind: artifact.kind, title: pageTitle(String(artifact.content ?? '')), name, path: artifact.path };
        open.addEventListener('click', () => openArtifact(key, card));
        return card;
    }

    function closePreview({ focus = true } = {}) {
        if (!preview) return;
        const { box, opener } = preview;
        preview = null;
        box.remove();
        if (focus && opener?.isConnected) (opener.querySelector?.('[data-artifact-open]') ?? opener).focus();
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && preview) closePreview();
    });
    document.addEventListener('nedese:section', (e) => {
        if (e.detail?.section !== 'chat') closePreview();
    });

    const isMedia = (url) => /\.(png|jpe?g|webp|gif|mp4|webm|mov|wav|mp3|m4a|ogg|flac)(\?|$)/i.test(url);

    function media(url, alt = '') {
        // the frame at 0.1 s shows before play: iPhone Safari drew an empty grey box without it (user report 09.10.2026)
        if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return el('video', { class: 'message__media', src: url.includes('#') ? url : `${url}#t=0.1`, controls: true, preload: 'metadata', playsinline: true });
        if (/\.(wav|mp3|m4a|ogg|flac)(\?|$)/i.test(url)) return el('audio', { class: 'message__media', src: url, controls: true, preload: 'metadata' });
        // loaded with the chat, not when scrolled near: a picture loading above the reader pushed the text down.
        // A click opens it in the image viewer over the chat, not in a new tab (user request 09.10.2026)
        return el('a', { href: url, target: '_blank', rel: 'noopener', 'data-image-viewer': true, title: 'Open full size' }, el('img', { class: 'message__media', src: url, alt }));
    }

    /* ── Rendering ────────────────────────────────────────────────────── */

    // The messages scroll inside their own box (the chat fills the page; see fitChat)
    // At the bottom the box moves down with what is written (user report 08.10.2026: "son kart aşağıda kalıyor hep");
    // the moment the user scrolls up it stays where they are, and it moves again only once they are back at the very
    // bottom (user report 08.10.2026: "yukarı kaydırınca fırlatıyor": within 160 px of the bottom every written word
    // pulled the reader back down). Pictures that finish loading and a box that changes size (the phone keyboard) move it
    // down too ("yazı altta kalıyor": a chat with pictures opened 1000 px above its end).
    const distance = () => messagesBox.scrollHeight - messagesBox.scrollTop - messagesBox.clientHeight;
    let stuck = true;
    let lastTop = 0;
    // Moving up more than 40 px from the end leaves the bottom; moving down to near the end (160 px) follows again; while a
    // finger is on the screen the box never moves by itself, and when it lifts within 40 px of the end following goes on
    // (user report 08.10.2026: "Yazı yazdıkça aşağı kaydırmıyor": a tap whose finger slipped a few pixels, as when closing
    // the phone keyboard, stopped following, and the end of a growing answer was hard to reach within 24 px). Content
    // that shrinks at the end (a folded thinking block) leaves the box at the bottom, so it stays.
    let touching = false;
    messagesBox.addEventListener('scroll', () => {
        const top = messagesBox.scrollTop;
        const d = distance();
        if (top < lastTop - 1 && d > 40) stuck = false;
        else if (d < 160 && top >= lastTop) stuck = true;
        lastTop = top;
    }, { passive: true });
    messagesBox.addEventListener('touchstart', () => {
        touching = true;
    }, { passive: true });
    const release = () => {
        touching = false;
        if (distance() <= 40) stuck = true;
        follow();
    };
    messagesBox.addEventListener('touchend', release, { passive: true });
    messagesBox.addEventListener('touchcancel', release, { passive: true });
    // a wheel turned up leaves the bottom at once
    messagesBox.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) stuck = false;
    }, { passive: true });
    // opening or closing a card is reading: the box stays where the user is (user report 08.10.2026: "Tıklayınca detayı
    // açılmıyor": at the bottom, the opened card grew and the box jumped to its end, the card above the screen)
    messagesBox.addEventListener('click', (e) => {
        if (e.target.closest?.('summary')) stuck = false;
    }, true);
    let followFrame = 0;
    const follow = () => {
        if (!stuck || touching || followFrame) return;
        followFrame = requestAnimationFrame(() => {
            followFrame = 0;
            if (stuck && !touching) messagesBox.scrollTop = messagesBox.scrollHeight;
        });
    };
    new MutationObserver(follow).observe(messagesBox, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden'] });
    messagesBox.addEventListener('load', follow, true);
    messagesBox.addEventListener('loadedmetadata', follow, true);
    new ResizeObserver(follow).observe(messagesBox);
    const scrollToBottom = (force = false) => {
        if (force) stuck = true;
        if (stuck && (force || !touching)) requestAnimationFrame(() => {
            messagesBox.scrollTop = messagesBox.scrollHeight;
        });
    };

    function append(node, { force = false } = {}) {
        $('[data-chat-empty]', messagesBox)?.remove();
        messagesBox.append(node);
        scrollToBottom(force);
    }

    /** The assistant took the queued messages: they become ordinary messages. */
    function takeQueued() {
        for (const box of messagesBox.querySelectorAll('.message--queued')) {
            box.classList.remove('message--queued');
            box.querySelector('.message__queued')?.remove();
        }
    }

    /**
     * A file attached to a message (a PDF, a workbook, code; user request 08.10.2026): its type over its name, a link to
     * the file once it is sent. The name is the file's own (older messages have only the stored source).
     */
    function fileChip(a, href) {
        const name = a.name || String(a.source ?? '').split('/').pop().replace(/^\d{8}-\d{6}-(file-|data-|veri-|muzik-)?/, '');
        const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
        const parts = [
            extension ? el('span', { class: 'file-chip__type', translate: 'no', text: extension.toUpperCase() }) : el('span', { class: 'file-chip__type', text: 'File' }),
            el('span', { class: 'file-chip__name', translate: 'no', text: name }),
        ];
        return href ? el('a', { class: 'file-chip', href, target: '_blank', rel: 'noopener', title: name }, ...parts) : el('span', { class: 'file-chip', title: name }, ...parts);
    }

    function userMessage(m) {
        const box = el('div', { class: 'message message--user' });
        const images = (m.attachments ?? []).filter((a) => a.type === 'image');
        if (images.length) box.append(el('div', { class: 'message__attachments' }, ...images.map((a) => el('a', { href: `/file/${a.source}`, target: '_blank', rel: 'noopener', 'data-image-viewer': true, title: 'Open full size' }, el('img', { class: 'message__attachment', src: `/file/${a.source}`, alt: '' })))));
        const others = (m.attachments ?? []).filter((a) => a.type !== 'image');
        if (others.length) box.append(el('div', { class: 'message__files' }, ...others.map((a) => fileChip(a, `/file/${a.source}`))));
        if (m.content) box.append(el('div', { class: 'message__bubble', translate: 'no', text: m.content }));
        if (m.id && !m.hidden) box.append(userActions(m, box));
        return box;
    }

    /*
     * Edit and branches (user request 08.10.2026): an earlier message of the user can be edited and sent again; what
     * followed it stays as the earlier version, reached with the "‹ 1/2 ›" switcher under the message. The server sends
     * the whole chat back as a "branch" event, which draws it again.
     */
    function userActions(m, box) {
        const bar = el('div', { class: 'message__actions', 'data-message-actions': m.id });
        const edit = el('button', { type: 'button', class: 'message__action', 'data-message-edit-button': m.id, 'aria-label': 'Edit message', title: 'Edit message' });
        edit.innerHTML = icon('edit');
        edit.addEventListener('click', () => editMessage(m, box));
        bar.append(edit);
        const f = (state.current?.forks ?? []).find((x) => x.message === m.id);
        if (f && f.count > 1) {
            const go = async (version, button) => {
                button.disabled = true;
                try {
                    await api(`/api/v1/chat/${state.current.id}/branch`, { method: 'POST', body: { message: m.id, version } });
                } catch (e) {
                    notify(e.message, 'danger');
                } finally {
                    button.disabled = false;
                }
            };
            const previous = el('button', { type: 'button', class: 'message__action', 'data-branch': 'previous', 'aria-label': 'Previous version', title: 'Previous version', disabled: f.version <= 1 });
            previous.innerHTML = icon('left');
            previous.addEventListener('click', () => go(f.version - 1, previous));
            const next = el('button', { type: 'button', class: 'message__action', 'data-branch': 'next', 'aria-label': 'Next version', title: 'Next version', disabled: f.version >= f.count });
            next.innerHTML = icon('right');
            next.addEventListener('click', () => go(f.version + 1, next));
            bar.append(previous, el('span', { class: 'message__branch', 'data-branch-label': true, translate: 'no', text: `${f.version}/${f.count}` }), next);
        }
        return bar;
    }

    /** The message becomes a box to edit in; Send makes a new version from it, Cancel (or Escape) puts it back. */
    function editMessage(m, box) {
        if (state.current?.status && state.current.status !== 'idle') return notify('The chat is running; edit a message when it finishes (or stop it).', 'danger');
        if (box.querySelector('[data-message-edit]')) return;
        const shown = [...box.children];
        const text = el('textarea', { class: 'textarea message__edit-input', 'data-message-edit-input': true, rows: Math.min(10, Math.max(2, String(m.content ?? '').split('\n').length + 1)), 'aria-label': 'Edit message' });
        text.value = m.content ?? '';
        const cancel = el('button', { type: 'button', class: 'btn btn--sm btn--ghost', text: 'Cancel' });
        const send = el('button', { type: 'submit', class: 'btn btn--sm btn--primary', 'data-message-edit-send': true, text: 'Send' });
        const editor = el('form', { class: 'message__edit', 'data-message-edit': true }, text, el('div', { class: 'row row--end' }, cancel, send));
        const close = () => {
            editor.remove();
            box.classList.remove('message--editing');
            for (const n of shown) n.hidden = false;
        };
        cancel.addEventListener('click', close);
        // Enter sends as in the composer (a new line on touch screens), Shift+Enter makes a new line
        text.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
                e.preventDefault();
                editor.requestSubmit();
            }
        });
        editor.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!text.value.trim() && !(m.attachments ?? []).length) return;
            send.disabled = true;
            try {
                // the chat is drawn again from the "branch" event, the answer follows as usual
                await api(`/api/v1/chat/${state.current.id}/edit`, { method: 'POST', body: { message: m.id, text: text.value } });
                stuck = true;
            } catch (err) {
                notify(err.message, 'danger');
                send.disabled = false;
            }
        });
        for (const n of shown) n.hidden = true;
        box.classList.add('message--editing');
        box.append(editor);
        text.focus();
    }

    /*
     * Live answer (user request 08.10.2026: "anlık yazı yazımı yumuşak olmalı"): the streamed pieces arrive in bursts
     * every ~40 ms; they are revealed a few characters per frame instead, faster when the backlog grows (it never falls
     * more than ~12 frames behind). The final text finishes in the same bubble.
     * The model's thinking (user request 08.10.2026) streams into a "Thinking" block above the answer: open while it
     * is written, folded once the answer begins; it stays with the message, folded.
     */
    let live = null; // { box, bubble, target, shown, frame, final, attached, thinking: { details, body, text, folded } }
    const readable = (s) => s.replace(/<(tool|tool_call)>[\s\S]*?(<\/\1>|$)/g, '').replace(/^\s+/, ''); // <tool> blocks of the text tool mode

    /** The folded "Thinking" block of an answer (the model's reasoning, as plain text). */
    function thinkingBlock(text, { open = false } = {}) {
        const body = el('div', { class: 'message__thinking-body', translate: 'no', text });
        return { details: el('details', { class: 'message__thinking', open }, el('summary', { text: 'Thinking' }), body), body };
    }

    /** The live answer, made when its first piece (text or thinking) arrives. */
    function liveStart() {
        // a new answer while the previous one is still finishing: that one is completed first
        if (live?.final) liveFinish();
        if (!live) {
            const bubble = el('div', { class: 'message__bubble', translate: 'no' });
            live = { box: el('div', { class: 'message message--assistant message--live' }, bubble), bubble, target: '', shown: 0, frame: 0, final: false, attached: false, thinking: null };
        }
        return live;
    }

    function liveDelta(text) {
        liveStart().target += text;
        liveSchedule();
    }

    function liveReasoning(text) {
        const l = liveStart();
        if (!l.thinking) {
            l.thinking = { ...thinkingBlock('', { open: true }), text: '', folded: false };
            l.box.prepend(l.thinking.details);
        }
        l.thinking.text += text;
        l.thinking.body.textContent = l.thinking.text;
        if (!l.attached) {
            append(l.box);
            l.attached = true;
        }
        scrollToBottom();
    }

    /** The answer began (or ended): its thinking folds, once (the user can open it again). */
    function foldThinking(l) {
        if (!l.thinking || l.thinking.folded) return;
        l.thinking.folded = true;
        l.thinking.details.open = false;
    }

    function liveSchedule() {
        if (live && !live.frame) live.frame = requestAnimationFrame(liveStep);
    }

    function liveStep() {
        const l = live;
        if (!l) return;
        l.frame = 0;
        const text = readable(l.target);
        const backlog = text.length - l.shown;
        if (backlog > 0) {
            if (!l.attached) {
                append(l.box);
                l.attached = true;
            }
            l.shown += Math.max(l.final ? 3 : 1, Math.ceil(backlog / (l.final ? 6 : 12)));
            l.bubble.replaceChildren(...markdown(text.slice(0, l.shown)));
            foldThinking(l);
            scrollToBottom();
        }
        if (l.shown < text.length) liveSchedule();
        else if (l.final) liveFinish();
    }

    /** The finished text: shown completely (markdown, no caret); the bubble stays as the message. */
    function liveFinish() {
        const l = live;
        live = null;
        if (!l) return;
        cancelAnimationFrame(l.frame);
        const text = readable(l.target).trim();
        if (l.thinking) foldThinking(l);
        if (!text) {
            // only thinking (a tool call followed): the folded thinking stays, the empty bubble goes
            if (l.thinking) {
                l.bubble.remove();
                l.box.classList.remove('message--live');
            } else l.box.remove();
            return;
        }
        if (!l.attached) append(l.box);
        l.box.classList.remove('message--live');
        l.bubble.replaceChildren(...markdown(text));
        const sources = sourceRow(l.answer?.sources);
        if (sources) l.box.append(sources);
        if (l.answer?.rateable && l.answer.id) l.box.append(rateBar(l.answer.id, 0, text));
        const waiting = waitingFollowUps;
        if (waiting && waiting.id === l.answer?.id) showFollowUps(waiting.chatId, waiting.id, waiting.list);
        scrollToBottom();
    }

    /**
     * A chat opened (or its stream reopened) while the model writes: the server sends the text and the thinking so far
     * (chat.live). They show at once; the pieces that follow continue them. The same answer seen again (reconnect)
     * only gets longer.
     */
    function liveRestore(written) {
        const text = String(written?.text ?? '');
        const reasoning = String(written?.reasoning ?? '');
        if (!readable(text).trim() && !reasoning.trim()) return;
        const thought = live?.thinking?.text ?? '';
        if (live && !live.final && text.startsWith(live.target) && reasoning.startsWith(thought)) {
            if (reasoning.length > thought.length) liveReasoning(reasoning.slice(thought.length));
            live.target = text;
            liveSchedule();
            return;
        }
        liveEnd({ keep: false });
        if (reasoning) liveReasoning(reasoning);
        if (!text) return;
        liveDelta(text);
        // no typing effect for what was written before: the next frame shows all of it
        live.shown = Math.max(0, readable(text).length - 1);
    }

    /**
     * The final text arrived: the bubble writes the rest quickly and becomes the message (with its thumbs when it is the
     * turn's answer). False: nothing was streaming.
     */
    function liveText(text, answer = null) {
        if (!live) return false;
        live.target = text;
        live.final = true;
        live.answer = answer;
        liveSchedule();
        return true;
    }

    /**
     * Streaming stops (tool call, error, stop): what was written stays (complete), an empty bubble goes. A finished text
     * that is still being written out (its final text arrived) ends by itself, smoothly.
     */
    function liveEnd({ keep = true } = {}) {
        if (!live) return;
        if (keep && live.final && live.attached) return;
        if (keep) liveFinish();
        else {
            cancelAnimationFrame(live.frame);
            live.box.remove();
            live = null;
        }
    }

    // panel: a text the panel wrote (step limit, stopped, an error), not the model: it is translated like the rest of the
    // page (user 10.10.2026: "Step limit reached (40)" stayed English in a Turkish chat); the model's answer never is
    function assistantMessage(text, { error = false, panel = false, reasoning = '', id = null, rating = 0, rateable = false, sources = null } = {}) {
        return el('div', { class: `message message--assistant${error ? ' message--error' : ''}` },
            reasoning ? thinkingBlock(reasoning).details : null,
            text ? el('div', { class: 'message__bubble', translate: panel || error ? 'yes' : 'no' }, ...markdown(text)) : null,
            text ? sourceRow(sources) : null,
            text && rateable && id ? rateBar(id, rating, text) : null);
    }

    /**
     * Source links under an answer that used web search or fetch (user request 08.10.2026): the site of each page it
     * read or found (read ones first); the page's title on hover; they open in a new tab.
     */
    function sourceRow(sources) {
        if (!Array.isArray(sources) || !sources.length) return null;
        const hosts = new Map();
        const links = [];
        for (const s of sources) {
            let host;
            try {
                host = new URL(s.url).hostname.replace(/^www\./, '');
            } catch {
                continue;
            }
            // the same site twice: the second one is numbered (its title tells them apart)
            const seen = (hosts.get(host) ?? 0) + 1;
            hosts.set(host, seen);
            links.push(el('a', { class: 'message__source', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.title ? `${s.title}\n${s.url}` : s.url, translate: 'no', 'data-source': s.url }, seen > 1 ? `${host} · ${seen}` : host));
        }
        if (!links.length) return null;
        return el('div', { class: 'message__sources', role: 'group', 'aria-label': 'Sources' },
            el('span', { class: 'message__sources-label' }, 'Sources'), ...links);
    }

    /*
     * Follow-up suggestions (user request 08.10.2026): up to three next messages under the last answer, written by the
     * text model after the answer arrives; a click sends one (a draft in the box stays). On by default; Options turns
     * them off on this device.
     */
    let followUpChoice = (() => {
        try {
            return localStorage.getItem('chat.followUps') !== 'off';
        } catch {
            return true;
        }
    })();
    // suggestions that came while their answer was still being written out: shown when it is finished
    let waitingFollowUps = null;

    function followUpRow(id, list) {
        const row = el('div', { class: 'message__follow-ups', role: 'group', 'aria-label': 'Suggested follow-ups', 'data-follow-ups': id },
            el('span', { class: 'message__follow-ups-label' }, 'Follow-ups'));
        for (const text of list) {
            const b = el('button', { type: 'button', class: 'message__follow-up', translate: 'no', 'data-follow-up': true }, text);
            b.addEventListener('click', () => sendFollowUp(text));
            row.append(b);
        }
        return row;
    }

    function clearFollowUps() {
        waitingFollowUps = null;
        for (const row of messagesBox.querySelectorAll('.message__follow-ups')) row.remove();
    }

    /** The suggestions under answer id, if it is the last message shown. */
    function attachFollowUps(id, list) {
        const box = $(`[data-rate-id="${CSS.escape(id)}"]`, messagesBox)?.closest('.message');
        if (!box || [...messagesBox.querySelectorAll('.message')].at(-1) !== box) return false;
        clearFollowUps();
        box.append(followUpRow(id, list));
        return true;
    }

    function showFollowUps(chatId, id, list) {
        if (!list?.length || !followUpChoice || state.current?.id !== chatId || state.current.status !== 'idle') return;
        if (live) {
            waitingFollowUps = { chatId, id, list };
            return;
        }
        if (attachFollowUps(id, list)) scrollToBottom();
    }

    async function requestFollowUps(chatId, id) {
        if (!followUpChoice) return;
        try {
            const r = await api(`/api/v1/chat/${encodeURIComponent(chatId)}/follow-ups`, { method: 'POST', body: { message: id } });
            showFollowUps(chatId, id, r.followUps);
        } catch {
            // a nicety: no suggestions, no error
        }
    }

    async function sendFollowUp(text) {
        const c = state.current;
        if (!c || c.status !== 'idle' || sending) return;
        sending = true;
        clearFollowUps();
        try {
            await api(`/api/v1/chat/${c.id}/message`, { method: 'POST', body: { text } });
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            sending = false;
        }
    }

    // An answer of the assistant that can be rated (lib/agent rateable): its own text, not a tool step or an error
    const rateable = (m) => m.role === 'assistant' && !m.hidden && !m.toolCalls?.length && !m.error && !m.stopped && !m.panel && Boolean(String(m.content ?? '').trim());

    const ICONS = {
        up: '<path d="M7 10v11H4.5A1.5 1.5 0 0 1 3 19.5v-8A1.5 1.5 0 0 1 4.5 10zm0 0 4-7a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1.2 8A2 2 0 0 1 17.5 21H7" stroke-linejoin="round"/>',
        down: '<path d="M17 14V3h2.5A1.5 1.5 0 0 1 21 4.5v8a1.5 1.5 0 0 1-1.5 1.5zm0 0-4 7a2.5 2.5 0 0 1-2.5-2.5V15H5.3a2 2 0 0 1-2-2.3l1.2-8A2 2 0 0 1 6.5 3H17" stroke-linejoin="round"/>',
        edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zm9.5-13.5 4 4" stroke-linejoin="round" stroke-linecap="round"/>',
        fork: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10m12-8c0 5-6 4-11.3 8.6" stroke-linecap="round"/>',
        left: '<path d="m15 5-7 7 7 7" stroke-linecap="round" stroke-linejoin="round"/>',
        right: '<path d="m9 5 7 7-7 7" stroke-linecap="round" stroke-linejoin="round"/>',
        copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" stroke-linejoin="round"/>',
        speak: '<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5z" stroke-linejoin="round"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke-linecap="round"/>',
        stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
        regenerate: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5" stroke-linecap="round" stroke-linejoin="round"/>',
    };
    const icon = (name) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${ICONS[name]}</svg>`;

    /*
     * Read aloud (user request 08.10.2026): Turkish or English by the answer's language; one answer at a time, its button
     * stops it. Code blocks are left out, links read by their text. The panel's own voice reads it (a "speech" job; user
     * 10.10.2026: the browser's voice "çok robotik"), each answer's file is kept for playing it again; the browser's
     * voices (speechSynthesis) only when the panel cannot (no voice model).
     */
    const speech = { button: null, audio: null, job: null };
    const browserSpeech = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
    const spokenFiles = new Map();
    // a silent sound started inside the click: iOS plays the voice that arrives seconds later only on an element the user started
    const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

    function speakableText(markdownText) {
        return String(markdownText)
            .replace(/```[\s\S]*?(```|$)/g, ' ')
            .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/`([^`]*)`/g, '$1')
            .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
            .replace(/[*_~|]+/g, ' ')
            .replace(/^\s*:?-{3,}:?\s*$/gm, ' ')
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .trim();
    }

    /** 'tr' when the text has Turkish letters or common Turkish words, else 'en'. */
    function textLanguage(text) {
        const s = ` ${String(text).toLocaleLowerCase('tr')} `;
        const turkish = (s.match(/[çğışöü]/g) ?? []).length + 3 * (s.match(/\s(ve|bir|bu|için|ile|da|de|ne|çok|olarak|gibi|daha)\s/g) ?? []).length;
        const english = 3 * (s.match(/\s(the|and|is|are|of|to|with|for|this|that|you)\s/g) ?? []).length;
        return turkish > english ? 'tr' : 'en';
    }

    function speakButtonState(button, on, preparing = false) {
        if (!button) return;
        button.setAttribute('aria-pressed', String(on));
        button.classList.toggle('is-busy', preparing);
        const label = preparing ? 'Preparing the voice… (click to stop)' : on ? 'Stop reading' : 'Read aloud';
        button.setAttribute('aria-label', label);
        button.title = label;
        button.innerHTML = icon(on ? 'stop' : 'speak');
    }

    function stopSpeaking() {
        const b = speech.button;
        speech.button = null;
        speakButtonState(b, false);
        speech.audio?.pause();
        speech.audio = null;
        // a voice still being prepared is cancelled (the queue frees the GPU for the next job)
        if (speech.job) api(`/api/v1/jobs/${speech.job}/cancel`, { method: 'POST' }).catch(() => {});
        speech.job = null;
        if (browserSpeech) speechSynthesis.cancel();
    }

    /** Waits for the read-aloud job; its voice.wav address, or null when it stopped (cancelled, failed). */
    async function speechFile(id, button) {
        for (;;) {
            await new Promise((ok) => setTimeout(ok, 1500));
            if (speech.button !== button) return null;
            const job = (await api(`/api/v1/jobs/${id}`)).job;
            if (job.status === 'done') return job.outputs?.find((o) => o.type === 'voice')?.url ?? null;
            if (['error', 'cancelled', 'interrupted'].includes(job.status)) throw new Error(job.error || `Read aloud ${job.status}.`);
        }
    }

    async function speak(text, button) {
        if (speech.button === button) {
            stopSpeaking();
            return;
        }
        stopSpeaking();
        const plain = speakableText(text);
        if (!plain) return;
        const audio = new Audio(SILENCE);
        audio.play().catch(() => {});
        speech.button = button;
        speech.audio = audio;
        let url = spokenFiles.get(plain);
        try {
            if (!url) {
                speakButtonState(button, true, true);
                const j = await api('/api/v1/jobs', { method: 'POST', body: { type: 'speech', text: plain.replace(/\s*\n\s*/g, '\n').slice(0, 5000), lang: textLanguage(plain) } });
                if (speech.button !== button) {
                    api(`/api/v1/jobs/${j.job.id}/cancel`, { method: 'POST' }).catch(() => {});
                    return;
                }
                speech.job = j.job.id;
                url = await speechFile(j.job.id, button);
                speech.job = null;
                if (!url || speech.button !== button) return;
                spokenFiles.set(plain, url);
            }
            speakButtonState(button, true);
            audio.src = url;
            audio.addEventListener('ended', () => speech.button === button && stopSpeaking());
            await audio.play();
        } catch (e) {
            speech.job = null;
            if (speech.button !== button) return;
            if (!browserSpeech) {
                stopSpeaking();
                notify(e.message, 'warning');
                return;
            }
            speech.audio = null;
            browserSpeak(plain, button);
        }
    }

    /** The browser's own voices: when the panel has no voice model. */
    function browserSpeak(plain, button) {
        const lang = textLanguage(plain) === 'tr' ? 'tr-TR' : 'en-US';
        const voices = speechSynthesis.getVoices();
        const fits = (v) => String(v.lang ?? '').replace('_', '-').toLowerCase().startsWith(lang.slice(0, 2));
        const voice = voices.find((v) => fits(v) && v.localService) ?? voices.find(fits) ?? null;
        // short pieces: some voices stop after a long utterance (about 15 s in Chrome), and Stop takes effect at once
        const parts = plain.match(/[^.!?\n]+[.!?]*\s*|\n+/g)?.map((p) => p.trim()).filter(Boolean) ?? [plain];
        const pieces = [];
        for (const p of parts) {
            if (pieces.length && pieces.at(-1).length + p.length < 220) pieces[pieces.length - 1] += ` ${p}`;
            else pieces.push(p);
        }
        speakButtonState(button, true);
        pieces.forEach((p, i) => {
            const u = new SpeechSynthesisUtterance(p);
            u.lang = lang;
            if (voice) u.voice = voice;
            if (i === pieces.length - 1) u.addEventListener('end', () => speech.button === button && stopSpeaking());
            u.addEventListener('error', (e) => {
                if (speech.button !== button || e.error === 'interrupted' || e.error === 'canceled') return;
                stopSpeaking();
                notify(lang === 'tr-TR' ? 'This browser has no voice for Turkish.' : 'The browser could not read it aloud.', 'warning');
            });
            speechSynthesis.speak(u);
        });
    }

    /**
     * Under an answer: copy it (as Markdown), read it aloud, thumbs up / down (user request 08.10.2026: stored with the
     * message; the good ones become training data, Training › Good answers from rated chats; clicking the chosen one
     * again takes the rating back), fork.
     */
    function rateBar(id, rating = 0, text = '') {
        const bar = el('div', { class: 'message__actions', 'data-rate-id': id });
        if (text) {
            const copy = el('button', { type: 'button', class: 'message__action', 'data-message-copy': id, 'aria-label': 'Copy answer', title: 'Copy answer' });
            copy.innerHTML = icon('copy');
            copy.addEventListener('click', () => copyText(text, copy));
            bar.append(copy);
            const read = el('button', { type: 'button', class: 'message__action', 'data-message-speak': id });
            speakButtonState(read, false);
            read.addEventListener('click', () => speak(text, read));
            bar.append(read);
        }
        const set = (value) => {
            for (const b of bar.querySelectorAll('[data-rate]')) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === value));
        };
        for (const [value, label, name] of [[1, 'Good answer', 'up'], [-1, 'Bad answer', 'down']]) {
            const b = el('button', { type: 'button', class: 'message__action', 'data-rate': value, 'aria-label': label, title: label, 'aria-pressed': String(rating === value) });
            b.innerHTML = icon(name);
            b.addEventListener('click', async () => {
                const next = b.getAttribute('aria-pressed') === 'true' ? 0 : value;
                const before = [...bar.querySelectorAll('[data-rate]')].find((x) => x.getAttribute('aria-pressed') === 'true')?.dataset.rate ?? 0;
                set(next);
                try {
                    await api(`/api/v1/chat/${state.current.id}/rate`, { method: 'POST', body: { message: id, rating: next } });
                } catch (e) {
                    set(Number(before));
                    notify(e.message, 'danger');
                }
            });
            bar.append(b);
        }
        // Fork (user request 08.10.2026): a new chat with the messages up to this answer; this chat stays as it is
        const fork = el('button', { type: 'button', class: 'message__action', 'data-fork': id, 'aria-label': 'Fork chat from here', title: 'Fork chat from here' });
        fork.innerHTML = icon('fork');
        fork.addEventListener('click', async () => {
            fork.disabled = true;
            try {
                const r = await api(`/api/v1/chat/${state.current.id}/fork`, { method: 'POST', body: { message: id } });
                await select(r.chat.id);
                notify(r.message, 'success');
            } catch (e) {
                notify(e.message, 'danger');
            } finally {
                fork.disabled = false;
            }
        });
        bar.append(fork, regenerateButton());
        return bar;
    }

    /*
     * Regenerate (user request 08.10.2026): under the last answer while the chat is idle (also under an error or a
     * stopped answer), the last request goes again and the model writes a new answer; the old one stays as the earlier
     * version of that request (‹ 1/2 › under it, as after an edit).
     */
    function regenerateButton() {
        const b = el('button', { type: 'button', class: 'message__action', 'data-regenerate': true, 'aria-label': 'Regenerate the answer', title: 'Regenerate the answer', hidden: true });
        b.innerHTML = icon('regenerate');
        b.addEventListener('click', async () => {
            // one request at a time, as for sending (a double click would write it twice)
            if (sending) return;
            sending = true;
            try {
                await regenerate(b);
            } finally {
                sending = false;
            }
        });
        return b;
    }

    async function regenerate(button = null) {
        const c = state.current;
        if (!c || c.status !== 'idle') return;
        if (button) button.disabled = true;
        stopSpeaking();
        clearFollowUps();
        try {
            await api(`/api/v1/chat/${encodeURIComponent(c.id)}/regenerate`, { method: 'POST', body: {} });
        } catch (e) {
            notify(e.message, 'danger');
            if (button) button.disabled = false;
        }
    }

    /** Only the last answer offers Regenerate, and only while nothing runs; an answer without actions gets a bar of its own. */
    function updateRegenerate() {
        for (const b of messagesBox.querySelectorAll('[data-regenerate]')) b.hidden = true;
        messagesBox.querySelector('[data-regenerate-bar]')?.remove();
        const c = state.current;
        if (!c || c.status !== 'idle' || state.running || !(c.messages ?? []).some((m) => m.role === 'user' && !m.hidden)) return;
        const last = [...messagesBox.children].at(-1);
        // a tool step or a card is not an answer; the live bubble belongs to a run
        if (!last?.classList.contains('message--assistant') || !last.querySelector(':scope > .message__bubble')) return;
        const own = last.querySelector(':scope > .message__actions [data-regenerate]');
        if (own) {
            own.hidden = false;
            own.disabled = false;
            return;
        }
        const b = regenerateButton();
        b.hidden = false;
        // before the follow-ups, which stay last
        last.insertBefore(el('div', { class: 'message__actions', 'data-regenerate-bar': true }, b), last.querySelector(':scope > .message__follow-ups'));
    }

    /** Divider where the conversation was compacted; the summary the model keeps opens on click. */
    function compactNote(text) {
        return el('details', { class: 'chat__note' }, el('summary', { text: 'Conversation compacted' }), el('div', { class: 'chat__note-body', translate: 'no', text: text ?? '' }));
    }

    // Messages that left the model's context because the summary could not be made (they stay in the chat)
    function leftOutNote(text) {
        return el('details', { class: 'chat__note' }, el('summary', { text: 'Earlier messages left out' }), el('div', { class: 'chat__note-body', text: text ?? '' }));
    }

    // What woke the chat from the background (user request 09.10.2026): a watcher fired, a background command or a
    // sub-agent finished, a monitor printed lines, a wake-up came; a note when a watcher ended. What the model got opens
    // on click.
    const WAKE_TITLES = { watch: 'A watcher fired', command: 'A background command finished', agent: 'A sub-agent finished', monitor: 'A monitor reported', schedule: 'Scheduled wake-up', 'watch-ended': 'A watcher ended', 'monitor-ended': 'A monitor stopped' };
    function wakeNote(m) {
        return el('details', { class: 'chat__note chat__note--wake', 'data-wake': m.wake?.kind ?? '' },
            el('summary', {}, el('span', { text: WAKE_TITLES[m.wake?.kind] ?? 'From the background' }), m.wake?.id ? el('span', { class: 'chat__note-id', translate: 'no', text: m.wake.id }) : null),
            el('div', { class: 'chat__note-body', translate: 'no', text: m.content ?? '' }));
    }

    // Readable tool names on the cards (TR in the dictionary); unknown (MCP) names are shown as they are.
    const TOOL_LABELS = {
        panel_api: 'Panel',
        api_document: 'API docs',
        wait_job: 'Wait for job',
        look_image: 'Look at image',
        add_upload: 'Add to uploads',
        list_file: 'List',
        read_file: 'Read',
        write_file: 'Write',
        edit_file: 'Edit',
        search_file: 'Search',
        delete_file: 'Delete',
        run_command: 'Command',
        command_output: 'Command output',
        stop_command: 'Stop command',
        run_ssh: 'SSH command',
        search_web: 'Web search',
        fetch_web: 'Read web page',
        show_image: 'Show picture',
        search_images: 'Picture search',
        download: 'Download',
        sub_agent: 'Sub-agent',
        agent_status: 'Sub-agent status',
        write_memory: 'Save note',
        update_memory: 'Update note',
        search_memory: 'Search notes',
        delete_memory: 'Delete note',
        search_chats: 'Search chats',
        schedule: 'Schedule',
        schedules: 'Schedules',
        watch: 'Watcher',
        monitor: 'Monitor',
        background: 'Background',
        load_skill: 'Load skill',
        load_tools: 'Load tools',
        install_skill: 'Install skill',
        install_plugin: 'Install plugin',
        add_mcp_server: 'Add MCP server',
        mcp_tools: 'MCP tools',
        call_mcp: 'MCP call',
        ask_user: 'Question',
        present_plan: 'Plan',
    };
    // An MCP tool the chat calls as its own function (mcp__<server>__<tool>) shows as "server · tool", untranslated
    const mcpName = (name) => /^mcp__(.+?)__(.+)$/.exec(String(name ?? ''));
    const toolLabel = (name) => TOOL_LABELS[name] ?? (mcpName(name) ? `${mcpName(name)[1]} · ${mcpName(name)[2]}` : String(name ?? ''));

    function shortInput(name, input) {
        if (!input || typeof input !== 'object') return '';
        if (name === 'panel_api') return `${input.method ?? 'GET'} ${input.path ?? ''}${input.body?.type ? ` · ${input.body.type}` : ''}`;
        if (name === 'call_mcp') return `${input.server ?? ''} · ${input.tool ?? ''}`;
        if (name === 'add_mcp_server') return `${input.name ?? ''}${input.remove ? ' · remove' : input.url ? ` · ${input.url}` : input.command ? ` · ${[input.command, ...(input.args ?? [])].join(' ')}` : ''}`;
        if (name === 'load_tools') return (input.names ?? []).join(', ');
        if (name === 'install_skill') return input.remove ? `remove · ${input.remove}` : `${input.source ?? ''}${input.skill ? ` · ${input.skill}` : ''}`;
        if (name === 'install_plugin') return input.remove ? `remove · ${input.remove}` : `${input.source ?? ''}${input.plugin ? ` · ${input.plugin}` : ''}`;
        if (name === 'background') return input.stop ? `stop · ${input.stop}` : '';
        if (name === 'watch' && input.job) return input.job;
        if (input.question) return input.question;
        if (input.command) return input.command;
        if (input.path) return input.path;
        if (input.url) return input.url;
        if (input.query) return input.query;
        if (input.id) return input.id;
        if (input.task) return input.task;
        if (input.source) return input.source;
        return JSON.stringify(input).slice(0, 120);
    }

    // a job the chat made: panel_api POST /jobs, or a picture show_image fetched from the web into the gallery
    const isJobCreation = (call) => call?.name === 'show_image' || call?.name === 'panel_api' &&String(call.input?.method ?? '').toUpperCase() === 'POST' && /^(\/api\/v1)?\/jobs\/?$/.test(String(call.input?.path ?? '').split('?')[0]);

    /*
     * ── Plan mode (user request 10.10.2026, like Claude Code's): the plan the agent presented, with Approve and run and
     * Keep planning; only the chat's latest plan, while the chat is still in plan mode and idle, can be approved ──
     */
    function planCard(call) {
        const approve = el('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-plan-approve': true, text: 'Approve and run' });
        const keep = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-plan-keep': true, text: 'Keep planning' });
        const actions = el('div', { class: 'row row--wrap plan__actions', 'data-plan-actions': true }, approve, keep);
        approve.addEventListener('click', async () => {
            if (!state.current) return;
            approve.disabled = true;
            try {
                const r = await api(`/api/v1/chat/${state.current.id}/plan/approve`, { method: 'POST', body: {} });
                Object.assign(state.current, r.chat);
                setStatus(state.current);
            } catch (e) {
                notify(e.message, 'warning');
            } finally {
                approve.disabled = false;
            }
        });
        // what to change in the plan is written as a normal message; the chat stays in plan mode
        keep.addEventListener('click', () => input.focus());
        state.toolCalls.set(call.id, { name: call.name, input: call.input });
        return el('div', { class: 'message message--assistant', 'data-plan': true },
            el('div', { class: 'plan' },
                el('div', { class: 'plan__title', text: 'Plan' }),
                el('div', { class: 'message__bubble plan__body' }, ...markdown(String(call.input?.plan ?? ''))),
                actions));
    }

    function renderPlans() {
        const cards = [...section.querySelectorAll('[data-plan]')];
        const open = state.current?.approvalMode === 'plan' && !state.running;
        cards.forEach((c, i) => {
            const actions = $('[data-plan-actions]', c);
            if (actions) actions.hidden = !(open && i === cards.length - 1);
        });
    }

    function toolCard(call) {
        if (call.name === 'present_plan') return planCard(call);
        const status = el('span', { class: 'badge badge--blue', text: 'Running' });
        const body = el('div', { class: 'tool__body' }, el('div', { class: 'text-sm text-muted', text: 'Input' }), el('pre', { translate: 'no', text: JSON.stringify(call.input ?? {}, null, 2) }));
        const outputs = el('div', { class: 'tool__outputs', hidden: true });
        const card = el('details', { class: 'tool' },
            el('summary', {}, el('span', { class: 'tool__name', title: call.name, translate: mcpName(call.name) ? 'no' : null, text: toolLabel(call.name) }), el('span', { class: 'tool__summary', translate: 'no', text: shortInput(call.name, call.input) }), status),
            body);
        const wrap = el('div', { class: 'message message--assistant' }, card, outputs);
        wrap.toolParts = { status, body, outputs, card, running: true };
        state.toolCards.set(call.id, wrap);
        state.toolCalls.set(call.id, { name: call.name, input: call.input });
        return wrap;
    }

    /** The colored lines of an edit's diff (null when it has none). */
    function diffBody(edit) {
        const lines = String(edit.diff ?? '').split('\n').filter((l) => l !== '');
        const kind = (l) => (l.startsWith('@@') ? ' diff__line--hunk' : l[0] === '+' ? ' diff__line--add' : l[0] === '-' ? ' diff__line--del' : '');
        return lines.length ? el('pre', { class: 'diff__body', translate: 'no' }, ...lines.map((l) => el('span', { class: `diff__line${kind(l)}`, text: l }))) : null;
    }

    const diffStat = (added, removed) => el('span', { class: 'diff__stat', translate: 'no' }, el('span', { class: 'diff__add', text: `+${added}` }), ' ', el('span', { class: 'diff__del', text: `−${removed}` }));

    /** Diff of a file edit under its card, with Undo (when the file changed since, a second click forces it). */
    function diffView(edit) {
        const undo = edit.checkpoint ? el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-undo': edit.checkpoint, text: edit.undone ? 'Undone' : 'Undo', disabled: Boolean(edit.undone) }) : null;
        let force = false;
        undo?.addEventListener('click', async () => {
            undo.disabled = true;
            try {
                const r = await api(`/api/v1/chat/${state.current.id}/undo`, { method: 'POST', body: { checkpoint: edit.checkpoint, force } });
                notify(r.message, 'success');
                edit.undone = true;
                undo.textContent = 'Undone';
            } catch (e) {
                notify(e.message, 'warning');
                if (/changed after this edit|sonra değişti/.test(e.message)) {
                    force = true;
                    undo.textContent = 'Undo anyway';
                }
                undo.disabled = false;
            }
        });
        return el('div', { class: 'diff' },
            el('div', { class: 'diff__head' },
                el('span', { class: 'diff__path', translate: 'no', title: edit.path, text: edit.path }),
                diffStat(edit.added, edit.removed),
                undo),
            diffBody(edit),
            edit.truncated ? el('div', { class: 'diff__more text-sm text-muted', text: 'The diff is cut here; the file has more changes.' }) : null);
    }

    /*
     * ── Edited files of a turn (user request 09.10.2026: "like Claude Code"): at the end of the turn, every file the
     * assistant wrote or edited with its +added −removed lines, three rows, then "Show N more"; a row opens its diffs.
     * An undone edit no longer counts (a file whose edits were all undone leaves the list).
     */

    const EDITS_SHOWN = 3;
    // a file's type as a small mark: the language for code, the extension otherwise
    const FILE_MARKS = {
        js: ['JS', 'js'], mjs: ['JS', 'js'], cjs: ['JS', 'js'], jsx: ['JS', 'js'], ts: ['TS', 'ts'], tsx: ['TS', 'ts'],
        html: ['<>', 'html'], htm: ['<>', 'html'], xml: ['<>', 'html'], svg: ['<>', 'html'], vue: ['<>', 'html'],
        css: ['#', 'css'], scss: ['#', 'css'], json: ['{}', 'json'], yaml: ['{}', 'json'], yml: ['{}', 'json'], toml: ['{}', 'json'],
        py: ['PY', 'py'], md: ['MD', 'md'], txt: ['TXT', 'md'], ps1: ['>_', 'sh'], sh: ['>_', 'sh'], cmd: ['>_', 'sh'], bat: ['>_', 'sh'],
    };
    const fileName = (path) => String(path ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? String(path ?? '');
    const fileFolder = (path) => String(path ?? '').split(/[\\/]/).filter(Boolean).at(-2) ?? '';

    function fileMark(path) {
        const ext = /\.([a-z0-9]+)$/i.exec(fileName(path))?.[1]?.toLowerCase() ?? '';
        const [text, kind] = FILE_MARKS[ext] ?? [ext.slice(0, 3).toUpperCase() || '·', 'other'];
        return el('span', { class: `edits__mark edits__mark--${kind}`, 'aria-hidden': 'true', translate: 'no', text });
    }

    /** A turn's edits by file, in the order they were first touched; a file that did not exist before is new. */
    function editsByFile(edits) {
        const files = new Map();
        for (const e of edits) {
            if (!e?.path || e.undone) continue;
            const f = files.get(e.path) ?? { path: e.path, added: 0, removed: 0, created: /^@@ -0,0 /.test(String(e.diff ?? '')), edits: [] };
            f.added += Number(e.added) || 0;
            f.removed += Number(e.removed) || 0;
            f.edits.push(e);
            files.set(e.path, f);
        }
        return [...files.values()];
    }

    function editSummary(edits) {
        const box = el('div', { class: 'message message--assistant', 'data-edits': true });
        box.edits = edits;
        box.expanded = false;
        renderEditSummary(box);
        return box;
    }

    function renderEditSummary(box) {
        const files = editsByFile(box.edits);
        const wasOpen = $('.edits', box)?.open ?? true;
        box.hidden = !files.length;
        if (!files.length) return void box.replaceChildren();
        // two files of the same name show their folder too
        const names = files.map((f) => fileName(f.path).toLowerCase());
        const rows = files.map((f, i) => el('details', { class: 'edits__file', 'data-edits-file': f.path, hidden: !box.expanded && i >= EDITS_SHOWN },
            el('summary', { title: f.path },
                fileMark(f.path),
                el('span', { class: 'edits__name', translate: 'no', text: fileName(f.path) }),
                names.indexOf(names[i]) !== names.lastIndexOf(names[i]) && fileFolder(f.path) ? el('span', { class: 'edits__folder', translate: 'no', text: fileFolder(f.path) }) : null,
                f.created ? el('span', { class: 'edits__tag', text: 'New' }) : null,
                diffStat(f.added, f.removed)),
            el('div', { class: 'edits__diffs' }, ...f.edits.map(diffBody), f.edits.some((e) => e.truncated) ? el('div', { class: 'diff__more text-sm text-muted', text: 'The diff is cut here; the file has more changes.' }) : null)));
        const more = files.length > EDITS_SHOWN ? el('button', { type: 'button', class: 'edits__more', 'data-edits-more': true, text: box.expanded ? 'Show less' : `Show ${files.length - EDITS_SHOWN} more` }) : null;
        more?.addEventListener('click', () => {
            box.expanded = !box.expanded;
            rows.slice(EDITS_SHOWN).forEach((r) => (r.hidden = !box.expanded));
            more.textContent = box.expanded ? 'Show less' : `Show ${files.length - EDITS_SHOWN} more`;
        });
        box.replaceChildren(el('details', { class: 'edits', open: wasOpen },
            el('summary', { class: 'edits__head' },
                el('span', { class: 'edits__title', text: files.length === 1 ? 'Edited 1 file' : `Edited ${files.length} files` }),
                diffStat(files.reduce((n, f) => n + f.added, 0), files.reduce((n, f) => n + f.removed, 0))),
            el('div', { class: 'edits__list' }, ...rows, more)));
    }

    /** The running turn's edits as its summary (at the end of the turn, or before the next message). */
    function flushEdits() {
        if (state.turnEdits.length) append(editSummary(state.turnEdits));
        state.turnEdits = [];
    }

    function toolResult(id, { text, extra, error, duration }) {
        const call = state.toolCalls.get(id);
        if (!error && extra?.job && isJobCreation(call)) {
            state.createdJobs.add(extra.job);
            updateDeleteConfirm();
        }
        const wrap = state.toolCards.get(id);
        if (!wrap) return;
        const { status, body, outputs } = wrap.toolParts;
        wrap.toolParts.running = false;
        status.className = `badge ${error ? 'badge--red' : 'badge--green'}`;
        status.textContent = error ? 'Error' : duration ? `Done · ${duration} s` : 'Done';
        body.append(el('div', { class: 'text-sm text-muted', text: 'Result' }), el('pre', { translate: 'no', text: String(text ?? '') }));
        if (extra?.edit || extra?.artifact) {
            outputs.hidden = false;
            outputs.replaceChildren(...[extra.edit ? diffView(extra.edit) : null, !error && extra.artifact ? artifactCard(extra.artifact) : null].filter(Boolean));
            scrollToBottom();
        }
        const files = extra?.outputs ?? [];
        if (files.length) {
            outputs.hidden = false;
            outputs.replaceChildren(...files.slice(0, 8).map((o) => media(o.url)));
            scrollToBottom();
        }
    }

    function toolProgress(text) {
        // "<job id>: <stage> %NN" from wait_job → shown on the running card of that job
        const id = /^(\d{8}-\d{6}-[\w-]+):/.exec(text ?? '')?.[1];
        for (const wrap of state.toolCards.values()) {
            if (!wrap.toolParts.running) continue;
            if (!id || wrap.toolParts.card.textContent.includes(id)) wrap.toolParts.status.textContent = id ? text.slice(id.length + 2) : text;
        }
    }

    /** One Always allow rule as the user reads it: its kind, then the program, the route or nothing (a tool's name is its kind). */
    function ruleChip(r) {
        const [kind, value] = r.program ? [r.tool === 'run_ssh' ? 'Command on a server' : 'Command', r.program] : r.method ? ['Panel API', `${r.method} ${r.path}`] : [toolLabel(r.tool), null];
        return el('span', { class: 'allow-rule', 'data-allow-chip': true },
            el('span', { class: 'allow-rule__kind', translate: !r.program && !r.method && mcpName(r.tool) ? 'no' : null, text: kind }),
            value ? el('code', { translate: 'no', text: value }) : null);
    }

    /**
     * Approve, Reject, and Always allow (user request 08.10.2026) when the call can be allowed for good: the rules it
     * would keep (a command's programs, a panel API route, a tool) are shown above; an irreversible call has none.
     */
    function approvalCard({ id, tool, input, risk, allow }) {
        const yes = el('button', { type: 'button', class: 'btn btn--primary btn--sm', text: 'Approve' });
        const no = el('button', { type: 'button', class: 'btn btn--sm', text: 'Reject' });
        const always = allow?.length ? el('button', { type: 'button', class: 'btn btn--sm', 'data-approval-always': true, title: 'Calls like this run without asking in this chat from now on; irreversible actions always ask.', text: 'Always allow' }) : null;
        const buttons = [yes, always, no].filter(Boolean);
        const card = el('div', { class: 'approval-card', 'data-approval-card': id },
            el('strong', { text: 'Approval needed' }),
            el('div', { class: 'text-sm', text: risk === 'danger' ? `The assistant wants to use "${toolLabel(tool)}". This may not be reversible.` : `The assistant wants to use "${toolLabel(tool)}". Manual mode asks before every change.` }),
            el('pre', { translate: 'no', text: JSON.stringify(input ?? {}, null, 2) }),
            el('div', { class: 'text-sm text-muted', text: 'Choosing Automatic in Options approves this too.' }),
            always ? el('div', { class: 'approval-card__allow text-sm', 'data-approval-allow': true }, el('span', { class: 'text-muted', text: 'Always allow in this chat:' }), ...allow.map(ruleChip)) : null,
            el('div', { class: 'row' }, ...buttons));
        const answer = async (value, forever = false) => {
            for (const b of buttons) b.disabled = true;
            try {
                const r = await api(`/api/v1/chat/${state.current.id}/approval`, { method: 'POST', body: { id, yes: value, always: forever } });
                if (forever) notify(r.message, 'success');
            } catch (e) {
                notify(e.message, 'danger');
                for (const b of buttons) b.disabled = false;
            }
        };
        yes.addEventListener('click', () => answer(true));
        always?.addEventListener('click', () => answer(true, true));
        no.addEventListener('click', () => answer(false));
        return el('div', { class: 'message message--assistant' }, card);
    }

    /** The agent asks (ask_user): options as buttons, or a free answer (also from the composer). */
    function questionCard({ id, question, options, panel = false }) {
        const box = el('div', { class: 'question-card', 'data-question-card': id });
        const controls = [];
        const answer = async (text) => {
            for (const c of controls) c.disabled = true;
            try {
                await api(`/api/v1/chat/${state.current.id}/answer`, { method: 'POST', body: { id, answer: text } });
            } catch (e) {
                notify(e.message, 'danger');
                for (const c of controls) c.disabled = false;
            }
        };
        const buttons = (options ?? []).map((o) => {
            const b = el('button', { type: 'button', class: 'btn btn--sm', translate: 'no', text: o });
            b.addEventListener('click', () => answer(o));
            return b;
        });
        const free = el('input', { type: 'text', class: 'input', placeholder: 'Or write your answer', 'aria-label': 'Your answer', autocomplete: 'off' });
        const go = el('button', { type: 'button', class: 'btn btn--primary btn--sm', text: 'Answer' });
        go.addEventListener('click', () => {
            if (free.value.trim()) answer(free.value.trim());
        });
        free.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                go.click();
            }
        });
        controls.push(...buttons, free, go);
        box.append(el('strong', { text: 'Question' }), el('div', { class: 'question-card__text', translate: panel ? 'yes' : 'no', text: question }),
            buttons.length ? el('div', { class: 'question-card__options' }, ...buttons) : '',
            el('div', { class: 'question-card__free' }, free, go));
        return el('div', { class: 'message message--assistant' }, box);
    }

    function renderMessages(chat) {
        // a bubble still being written belongs to the old view (after a reconnect it swallowed the final answer)
        liveEnd({ keep: false });
        state.toolCards.clear();
        state.toolCalls.clear();
        state.createdJobs = new Set(chat.createdJobs ?? []);
        const nodes = [];
        // a turn's edited files come at its end: before the next message, or after the last one when the chat is idle
        let turn = [];
        const endTurn = () => {
            if (turn.length) nodes.push(editSummary(turn));
            turn = [];
        };
        for (const m of chat.messages ?? []) {
            // hidden: a note for the model (its answer was cut off), not something the user wrote
            if (m.role === 'user') {
                if (m.wake) {
                    endTurn();
                    nodes.push(wakeNote(m));
                } else if (!m.hidden) {
                    endTurn();
                    nodes.push(userMessage(m));
                }
            } else if (m.role === 'tool') {
                const edit = m.extra?.edit;
                if (edit && !m.error) turn.push(edit);
            } else if (m.role === 'assistant') {
                if (m.content || m.reasoning) nodes.push(assistantMessage(m.content, { error: m.error, panel: m.panel, reasoning: m.reasoning, id: m.id, rating: m.rating ?? 0, rateable: rateable(m), sources: m.sources }));
                for (const c of m.toolCalls ?? []) nodes.push(toolCard(c));
            } else if (m.role === 'note' && m.kind === 'compact') nodes.push(compactNote(m.content));
            else if (m.role === 'note' && m.kind === 'left-out') nodes.push(leftOutNote(m.content));
            else if (m.role === 'note' && m.kind === 'background') nodes.push(wakeNote(m));
        }
        // a running turn gets its summary when it ends ('done')
        if (!['running', 'approval', 'question'].includes(chat.status)) endTurn();
        state.turnEdits = turn;
        messagesBox.replaceChildren(...(nodes.length ? nodes : [emptyState()]));
        for (const m of chat.messages ?? []) if (m.role === 'tool') toolResult(m.toolId, { text: m.content, extra: m.extra, error: m.error, duration: m.duration });
        if (chat.approval) messagesBox.append(approvalCard(chat.approval));
        if (chat.question) messagesBox.append(questionCard(chat.question));
        // the answer being written right now (the stream was closed while another section was open, or reconnected)
        if (chat.live && chat.status !== 'idle') liveRestore(chat.live);
        // the last answer's suggestions, as they were kept with it
        const last = (chat.messages ?? []).filter((m) => !m.hidden).at(-1);
        if (followUpChoice && chat.status === 'idle' && last && rateable(last) && last.followUps?.length) attachFollowUps(last.id, last.followUps);
        // an open artifact follows its chat (its versions as they are now) and closes with another chat
        if (preview) {
            if (preview.chat === chat.id) renderArtifact();
            else closePreview({ focus: false });
        }
        updateDeleteConfirm();
        scrollToBottom(true);
    }

    function emptyState() {
        const examples = ['Generate an image of an orange cat in a snowy forest', 'Make a 5 second video from my last image', 'Write a short film about a lost fox (3 scenes)', 'What is using the GPU right now?'];
        return el('div', { class: 'chat__empty', 'data-chat-empty': true },
            el('p', { class: 'empty__title', text: 'What should we make?' }),
            el('p', { class: 'text-sm', text: 'Ask for an image, video, voice, music or a film; the assistant opens the jobs, waits for them and shows the results here. It also carries out multi-step tasks on its own.' }),
            el('div', { class: 'chat__suggestions' }, ...examples.map((t) => {
                const b = el('button', { type: 'button', class: 'btn btn--sm', text: t });
                b.addEventListener('click', () => {
                    // the text as the user sees it (translated in Turkish), not the English source
                    input.value = b.textContent.trim() || t;
                    resizeInput();
                    input.focus();
                });
                return b;
            })));
    }

    /* ── Chat list: latest few, "See all" pages in more on scroll, search ── */

    const sentinel = el('div', { class: 'chat__sentinel', 'aria-hidden': 'true' });
    const pager = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
    });
    pager.observe(sentinel);

    /** A small pin drawn beside a pinned chat's name. */
    function pinMark() {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'aria-hidden': 'true', class: 'chat__item-mark' })) svg.setAttribute(k, v);
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M9 3.5h6l-1 6.5 3.5 3.5h-11L10 10zM12 13.5V21');
        path.setAttribute('stroke-linejoin', 'round');
        svg.append(path);
        return svg;
    }

    function chatItem(c) {
        const b = el('button', { type: 'button', class: `chat__item${c.parent ? ' chat__item--sub' : ''}`, 'aria-current': c.id === state.current?.id ? 'true' : null, title: c.title || 'New chat', 'data-chat-item': c.id },
            el('span', { class: `dot ${c.status === 'running' ? 'dot--blue' : c.status === 'approval' || c.status === 'question' ? 'dot--orange' : c.error ? 'dot--red' : 'dot--gray'}` }),
            el('span', { class: 'chat__item-text' },
                el('span', { class: 'chat__item-name', translate: 'no', text: c.title || 'New chat' }),
                c.match ? el('span', { class: 'chat__item-match', translate: 'no', text: c.match }) : null),
            c.pinned ? pinMark() : null,
            // in All chats, the project a chat belongs to
            c.project && !state.project && projectById(c.project) ? el('span', { class: 'chat__item-tag chat__item-project', translate: 'no', text: projectById(c.project).name }) : null,
            c.temporary ? el('span', { class: 'chat__item-tag', text: 'Temporary' }) : c.archived && !state.archivedView ? el('span', { class: 'chat__item-tag', text: 'Archived' }) : null);
        b.addEventListener('click', () => {
            listBox.classList.remove('open');
            select(c.id);
        });
        return b;
    }

    function renderList() {
        const searching = Boolean(state.query);
        const archive = state.archivedView && !searching;
        const all = searching || state.expanded || archive;
        let shown = state.chats;
        if (!all) {
            shown = state.chats.slice(0, visibleCount());
            const current = state.current && !shown.some((c) => c.id === state.current.id) ? state.chats.find((c) => c.id === state.current.id) : null;
            if (current) shown = [...shown, current];
        }
        // pinned chats come first, apart (not in a search or the archive)
        const pinned = searching || archive ? [] : state.pinned;
        const line = (c) => [c.id, c.title, c.status, c.parent, c.error ? 1 : 0, c.match ?? '', c.pinned ? 1 : 0, c.archived ? 1 : 0, c.temporary ? 1 : 0, c.project ?? ''];
        const signature = JSON.stringify([shown.map(line), pinned.map(line), state.current?.id ?? '', all, archive, state.archivedCount, state.total, Boolean(state.next), phone(), state.project, state.projects.map((p) => p.id + p.name)]);
        if (signature === state.listSignature) return;
        state.listSignature = signature;
        const items = [];
        if (archive) {
            const back = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-chat-archive-back': true, text: 'Back to chats' });
            back.addEventListener('click', () => showArchive(false));
            items.push(el('div', { class: 'chat__group-head' }, el('span', { text: 'Archived chats' }), back));
        }
        if (pinned.length) items.push(el('div', { class: 'chat__group-title', text: 'Pinned' }), ...pinned.map(chatItem), ...(shown.length ? [el('div', { class: 'chat__group-title', text: 'Chats' })] : []));
        items.push(...shown.map(chatItem));
        if (!shown.length && !pinned.length) items.push(el('p', { class: 'text-sm text-muted', text: archive ? 'No archived chats.' : searching ? 'No chats found.' : state.project ? 'No chats in this project yet.' : 'No chats yet.' }));
        listItems.replaceChildren(...items, ...(all && state.next ? [sentinel] : []));
        moreButton.hidden = searching || archive || state.total <= visibleCount();
        moreButton.textContent = state.expanded ? 'Show less' : `See all (${state.total})`;
        archivedButton.hidden = searching || archive || !state.archivedCount;
        archivedButton.textContent = `Archived (${state.archivedCount})`;
    }

    /** The archived chats instead of the list (and back): they page in like "See all". */
    function showArchive(open) {
        state.archivedView = open;
        state.chats = [];
        state.next = null;
        state.listSignature = '';
        loadList();
    }

    /* ── Options popover: approval mode and text model ──────────────────── */

    const APPROVAL_MODES = [
        ['manual', 'Manual', 'Asks before every change (files, commands, downloads)'],
        ['edits', 'Allow edits', 'Asks only before deleting, destructive commands and settings changes'],
        ['auto', 'Automatic', 'Never asks'],
        ['plan', 'Plan', 'Only reads and researches, then shows a plan to approve'],
    ];
    // How much the model thinks before it answers (the thinking budget; user request 08.10.2026); low is the default
    const THINKING_LEVELS = [
        ['none', 'Off', 'Answers at once'],
        ['low', 'Short', 'A short think first'],
        ['medium', 'Medium', 'Thinks longer: harder tasks'],
        ['high', 'Long', 'Thinks longest: slowest answers'],
    ];
    const currentMode = () => state.current?.approvalMode ?? state.newApprovalMode;
    const currentModel = () => state.current?.model ?? state.newModel ?? '';
    const currentThinking = () => state.current?.thinking ?? state.newThinking;
    /**
     * A model's short name (user report 08.10.2026: "Ternary-Bonsai-2-27B-PQ2_0" pushed Send to the next line): no
     * quantization, no "Ternary-", spaces for dashes, a panel-trained model with its date ("Bonsai 2 27B", "Gemma 4 26B",
     * "Minyatur betimleyici 05.10 22:27"). Two models with the same short name keep their file names.
     */
    function shortModelName(name) {
        let s = String(name ?? '').replace(/\.gguf$/i, '');
        const trained = /-trained-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}/i.exec(s);
        s = s.replace(/-trained-\d{8}-\d{6}.*$/i, '').replace(/^Ternary-/i, '');
        for (let i = 0; i < 3; i++) s = s.replace(/[-_.](?:UD-)?(?:qat-)?(?:I?Q\d\w*|PT?Q\d_\d|B?F16|F32)$/i, '');
        s = s.replace(/[-_]+/g, ' ').trim();
        s = s.charAt(0).toUpperCase() + s.slice(1);
        return (trained ? `${s} ${trained[3]}.${trained[2]} ${trained[4]}:${trained[5]}` : s) || String(name ?? '');
    }
    const modelName = (file) => {
        if (file === REMOTE) return state.remote ? `${state.remote.model} (remote)` : 'Remote model (not set)';
        const m = state.models.find((x) => x.file === file);
        if (!m) return file;
        const short = shortModelName(m.name);
        return state.models.some((x) => x !== m && shortModelName(x.name) === short) ? m.name : short;
    };

    function option(group, value, name, note, checked) {
        const radio = el('input', { type: 'radio', name: `chat-${group}`, value, checked });
        radio.addEventListener('change', () => (group === 'mode' ? chooseMode(value) : group === 'thinking' ? chooseThinking(value) : group === 'preset' ? choosePreset(value) : group === 'project' ? chooseProject(value) : chooseModel(value)));
        // a model file or a preset (names the user gave) stays as written; "<name> (remote)" is translated as a pattern
        return el('label', { class: 'chat__option' }, radio, el('span', { class: 'chat__option-text' }, el('span', { class: 'chat__option-name', translate: (group === 'model' || group === 'preset' || group === 'project') && value && value !== REMOTE ? 'no' : null, text: name }), note ? el('span', { class: 'chat__option-note', translate: (group === 'preset' || group === 'project') && value ? 'no' : null, text: note }) : null));
    }

    /*
     * ── Projects (user request 10.10.2026, like Claude's): chats grouped under a project that gives them its instructions,
     * Knowledge documents, working folder and notes of their own. The list shows one project's chats (or all of them) and
     * a new chat goes into the one shown; Options moves an open chat in or out; the Projects window manages them.
     */

    const projectById = (id) => (id ? state.projects.find((p) => p.id === id) ?? null : null);

    async function loadProjects() {
        try {
            state.projects = (await api('/api/v1/chat/projects')).projects ?? [];
        } catch {
            state.projects = [];
        }
        // a remembered project that was deleted (here or elsewhere): all chats
        if (state.project && !projectById(state.project)) showProject('');
        renderProjectBar();
        renderOptions();
        state.listSignature = '';
        renderList();
        projectWindow?.render();
    }

    function renderProjectBar() {
        projectSelect.replaceChildren(el('option', { value: '', text: 'All chats' }), ...state.projects.map((p) => el('option', { value: p.id, translate: 'no', text: `${p.name} (${p.chatCount})` })));
        projectSelect.value = state.project;
        const p = projectById(state.project);
        projectInfo.hidden = !p?.description;
        projectInfo.textContent = p?.description ?? '';
    }

    /** The list shows this project's chats ('' all of them); a new chat goes into it. */
    function showProject(id) {
        state.project = id;
        try {
            if (id) localStorage.setItem('chat.project', id);
            else localStorage.removeItem('chat.project');
        } catch {
            /* private mode */
        }
        renderProjectBar();
        renderOptions();
        state.chats = [];
        state.next = null;
        state.listSignature = '';
        loadList();
    }

    projectSelect.addEventListener('change', () => showProject(projectSelect.value));

    /** Options › Project: an open chat moves in or out; before the first message it is the project of the new chat. */
    function chooseProject(id) {
        if (!state.current) {
            showProject(id);
            return;
        }
        patch({ project: id || null }).then(() => loadProjects());
    }

    function projectGroup() {
        const manage = el('button', { type: 'button', class: 'btn btn--ghost btn--sm chat__options-manage', 'data-projects-options-manage': true, text: 'Manage projects…' });
        manage.addEventListener('click', () => {
            openOptions(false);
            openProjects(state.current?.project ?? state.project);
        });
        const title = el('div', { class: 'chat__options-title', text: 'Project' });
        if (!state.projects.length) return el('div', { class: 'chat__options-group' }, title, el('div', { class: 'chat__options-note', text: 'No projects yet' }), manage);
        const chosen = state.current ? state.current.project ?? '' : state.project;
        return el('div', { class: 'chat__options-group', role: 'radiogroup', 'aria-label': 'Project' }, title,
            option('project', '', 'No project', null, !chosen),
            ...state.projects.map((p) => option('project', p.id, p.name, p.description || null, p.id === chosen)),
            manage);
    }

    let projectWindow = null;
    function openProjects(id = '') {
        if (!projectWindow) projectWindow = buildProjectWindow();
        projectWindow.show(id);
        window.openNdsWindow?.(projectWindow.modal);
    }

    $('[data-projects-manage]', section).addEventListener('click', () => openProjects(state.project));

    function buildProjectWindow() {
        const list = el('div', { class: 'preset-list', 'data-project-list': true });
        const field = (label, control, hint = null) => el('label', { class: 'field' }, el('span', { class: 'field__label', text: label }), control, hint ? el('span', { class: 'field__hint', text: hint }) : null);
        const name = el('input', { class: 'input', name: 'name', maxlength: 60, required: true, autocomplete: 'off' });
        const description = el('input', { class: 'input', name: 'description', maxlength: 200, autocomplete: 'off' });
        const instructions = el('textarea', { class: 'textarea', name: 'instructions', rows: 6, maxlength: 16000, placeholder: 'e.g. This is our shop\'s website. Use plain HTML and CSS, and write the texts in a friendly tone.' });
        const cwd = el('input', { class: 'input', name: 'cwd', autocomplete: 'off', placeholder: 'Default: the panel folder', translate: 'no' });
        const documents = el('div', { class: 'project-documents', 'data-project-documents': true });
        const notesBox = el('div', { class: 'project-notes', 'data-project-notes': true });
        const noteInput = el('input', { class: 'input', name: 'note', maxlength: 500, autocomplete: 'off', placeholder: 'A note the chats of this project keep in mind' });
        const noteAdd = el('button', { type: 'button', class: 'btn btn--sm', 'data-project-note-add': true, text: 'Add note' });
        const notesField = el('div', { class: 'field', 'data-project-notes-field': true }, el('span', { class: 'field__label', text: 'Notes of this project' }), notesBox, el('div', { class: 'row' }, noteInput, noteAdd), el('span', { class: 'field__hint', text: 'What the assistant remembers in this project\'s chats (write_memory saves here); separate from the panel\'s notes.' }));
        const save = el('button', { type: 'submit', class: 'btn btn--primary btn--sm', 'data-project-save': true, text: 'Save project' });
        const fresh = el('button', { type: 'button', class: 'btn btn--sm', 'data-project-new': true, text: 'New project' });
        const openChats = el('button', { type: 'button', class: 'btn btn--sm', 'data-project-open': true, text: 'Show its chats' });
        const remove = el('button', { type: 'submit', class: 'btn btn--sm btn--ghost', 'data-project-delete': true, 'data-confirm-title': 'Delete project', 'data-confirm-variant': 'danger', text: 'Delete project' });
        const removeForm = el('form', { class: 'row', hidden: true }, remove);
        const heading = el('h3', { class: 'preset-form__title', 'data-project-form-title': true, text: 'New project' });
        const formBox = el('form', { class: 'stack', 'data-project-form': true }, heading,
            field('Name', name),
            field('Description', description, 'One line, shown under the project in the chat list.'),
            field('Instructions', instructions, 'Added to the system prompt of every chat in this project.'),
            field('Working folder', cwd, 'New chats of the project start here (full access).'),
            el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Knowledge documents' }), documents, el('span', { class: 'field__hint', text: 'The chats of the project search only these (none chosen: every document).' })),
            el('div', { class: 'row row--wrap' }, save, fresh, openChats));
        let editing = null;
        let notes = [];
        const renderDocuments = (chosen) => {
            const docs = state.knowledge.documents ?? [];
            documents.replaceChildren(...(docs.length ? docs.map((d) => el('label', { class: 'chat__option' }, el('input', { type: 'checkbox', value: d.id, checked: chosen.includes(d.id) }), el('span', { translate: 'no', text: d.name }))) : [el('span', { class: 'text-sm text-muted', text: 'No documents in Knowledge yet.' })]));
        };
        const noteQuery = () => `?project=${encodeURIComponent(editing.id)}`;
        const renderNotes = () => {
            notesBox.replaceChildren(...(notes.length ? notes.map((n) => {
                const del = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-project-note-delete': n.id, 'aria-label': 'Delete note', title: 'Delete note', text: '×' });
                del.addEventListener('click', async () => {
                    try {
                        await api(`/api/v1/chat/memory/${encodeURIComponent(n.id)}${noteQuery()}`, { method: 'DELETE' });
                        await loadNotes();
                    } catch (err) {
                        notify(err.message, 'danger');
                    }
                });
                return el('div', { class: 'project-notes__item', 'data-project-note': n.id }, el('span', { class: 'text-sm', translate: 'no', text: n.text }), del);
            }) : [el('span', { class: 'text-sm text-muted', text: 'No notes yet.' })]));
        };
        const loadNotes = async () => {
            if (!editing) return;
            try {
                notes = (await api(`/api/v1/chat/memory${noteQuery()}`)).notes ?? [];
            } catch {
                notes = [];
            }
            renderNotes();
        };
        noteAdd.addEventListener('click', async () => {
            if (!editing || !noteInput.value.trim()) return;
            try {
                await api(`/api/v1/chat/memory${noteQuery()}`, { method: 'POST', body: { text: noteInput.value } });
                noteInput.value = '';
                await loadNotes();
            } catch (err) {
                notify(err.message, 'danger');
            }
        });
        const fill = (p) => {
            editing = p;
            heading.textContent = p ? 'Edit project' : 'New project';
            name.value = p?.name ?? '';
            description.value = p?.description ?? '';
            instructions.value = p?.instructions ?? '';
            cwd.value = p?.cwd ?? '';
            renderDocuments(p?.knowledge ?? []);
            removeForm.hidden = !p;
            openChats.hidden = !p;
            notesField.hidden = !p;
            if (notesField.parentElement !== formBox) formBox.insertBefore(notesField, formBox.lastElementChild);
            notes = [];
            renderNotes();
            if (p) {
                remove.dataset.confirm = `Delete the project "${p.name}"? Its chats stay in the list; its notes are deleted.`;
                loadNotes();
            }
            for (const row of list.querySelectorAll('[data-project-id]')) row.classList.toggle('preset-list__item--current', row.dataset.projectId === p?.id);
        };
        const renderProjectList = () => {
            list.replaceChildren(...(state.projects.length ? state.projects.map((p) => {
                const row = el('button', { type: 'button', class: 'preset-list__item', 'data-project-id': p.id },
                    el('span', { class: 'preset-list__name', translate: 'no', text: p.name }),
                    el('span', { class: 'preset-list__note', text: `Chats: ${p.chatCount} · Notes: ${p.noteCount}` }));
                row.addEventListener('click', () => fill(p));
                return row;
            }) : [el('p', { class: 'text-sm text-muted', text: 'No projects yet. Fill in the form to add the first one.' })]));
            if (editing) for (const row of list.querySelectorAll('[data-project-id]')) row.classList.toggle('preset-list__item--current', row.dataset.projectId === editing.id);
        };
        fresh.addEventListener('click', () => {
            fill(null);
            name.focus();
        });
        openChats.addEventListener('click', () => {
            if (!editing) return;
            showProject(editing.id);
            modal.querySelector('[data-modal-close]')?.click();
            listBox.classList.add('open');
        });
        formBox.addEventListener('submit', async (e) => {
            e.preventDefault();
            save.disabled = true;
            try {
                const knowledge = [...documents.querySelectorAll('input:checked')].map((x) => x.value);
                const body = { name: name.value, description: description.value, instructions: instructions.value, cwd: cwd.value.trim() || null, knowledge };
                const added = !editing;
                const r = await api(editing ? `/api/v1/chat/projects/${encodeURIComponent(editing.id)}` : '/api/v1/chat/projects', { method: editing ? 'PATCH' : 'POST', body });
                notify(r.message, 'success');
                // a new project is where the next chats go
                if (added) showProject(r.project.id);
                await loadProjects();
                fill(projectById(r.project.id));
            } catch (err) {
                notify(err.message, 'danger');
            } finally {
                save.disabled = false;
            }
        });
        removeForm.addEventListener('submit', (e) => e.preventDefault());
        removeForm.submit = async () => {
            if (!editing) return;
            try {
                const r = await api(`/api/v1/chat/projects/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
                notify(r.message, 'success');
                if (state.project === editing.id) showProject('');
                if (state.current?.project === editing.id) state.current.project = null;
                await loadProjects();
                fill(null);
            } catch (err) {
                notify(err.message, 'danger');
            }
        };
        const modal = el('div', { class: 'modal', 'data-modal': true, id: 'modal-chat-projects', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'chat-projects-title' },
            el('div', { class: 'modal__box modal__box--wide' },
                el('header', { class: 'modal__header' },
                    el('div', {}, el('h2', { class: 'modal__title', id: 'chat-projects-title', text: 'Projects' }),
                        el('p', { class: 'text-sm text-muted', text: 'A project keeps chats together: its instructions, Knowledge documents and notes apply to every chat in it.' })),
                    el('button', { type: 'button', class: 'modal__close', 'data-modal-close': true, 'aria-label': 'Close', text: '×' })),
                el('div', { class: 'modal__body stack' }, list, formBox, removeForm)));
        document.body.append(modal);
        return {
            modal,
            show(id) {
                renderProjectList();
                fill(projectById(id));
                loadKnowledge();
            },
            render() {
                renderProjectList();
                // the documents can arrive after the window opened; the ticks the user made stay
                if (!documents.querySelector('input')) renderDocuments(editing?.knowledge ?? []);
            },
        };
    }

    /*
     * ── Assistant presets (user request 08.10.2026): a new chat can start with one (its instructions join the system
     * prompt, its model, thinking, approval mode and working folder are the chat's); chosen in Options, managed in a window.
     */

    const presetById = (id) => state.presets.find((p) => p.id === id) ?? null;
    const currentPresetName = () => (state.current ? state.current.preset?.name : presetById(state.newPreset)?.name) ?? '';

    async function loadPresets() {
        try {
            state.presets = (await api('/api/v1/chat/presets')).presets ?? [];
        } catch {
            state.presets = [];
        }
        // a remembered preset that was deleted (here or elsewhere): none
        if (state.newPreset && !presetById(state.newPreset)) state.newPreset = '';
        renderOptions();
    }

    /** The Assistant group of the options: the preset of a new chat; an open chat shows the one it started with. */
    function presetGroup() {
        const manage = el('button', { type: 'button', class: 'btn btn--ghost btn--sm chat__options-manage', 'data-presets-manage': true, text: 'Manage presets…' });
        manage.addEventListener('click', () => {
            openOptions(false);
            openPresets();
        });
        const title = el('div', { class: 'chat__options-title', text: 'Assistant' });
        if (state.current || !state.presets.length) {
            const name = state.current?.preset?.name;
            return el('div', { class: 'chat__options-group' }, title,
                el('div', { class: 'chat__options-note', translate: name ? 'no' : null, text: name ?? (state.current ? 'No preset' : 'No presets yet') }),
                manage);
        }
        // the start of its instructions under its name
        const short = (p) => (p.prompt ? `${p.prompt.replace(/\s+/g, ' ').slice(0, 70)}${p.prompt.length > 70 ? '…' : ''}` : null);
        return el('div', { class: 'chat__options-group', role: 'radiogroup', 'aria-label': 'Assistant' }, title,
            option('preset', '', 'No preset', 'The default assistant', !state.newPreset),
            ...state.presets.map((p) => option('preset', p.id, p.name, short(p), p.id === state.newPreset)),
            manage);
    }

    /** A new chat's preset: its settings become the new chat's choices (they can still be changed before sending). */
    function choosePreset(id) {
        state.newPreset = id;
        try {
            localStorage.setItem('chat.preset', id);
        } catch {
            /* private mode */
        }
        const p = presetById(id);
        if (p?.approvalMode) state.newApprovalMode = p.approvalMode;
        if (p?.thinking) state.newThinking = p.thinking;
        if (p) state.newModel = p.model && (p.model === REMOTE ? state.remote : state.models.some((m) => m.file === p.model)) ? p.model : '';
        renderOptions();
    }

    let presetWindow = null;
    /** The window that lists, adds, changes and deletes the presets (made the first time it opens). */
    function openPresets() {
        if (!presetWindow) presetWindow = buildPresetWindow();
        presetWindow.show();
        window.openNdsWindow?.(presetWindow.modal);
    }

    function buildPresetWindow() {
        const list = el('div', { class: 'preset-list', 'data-preset-list': true });
        const field = (label, control, hint = null) => el('label', { class: 'field' }, el('span', { class: 'field__label', text: label }), control, hint ? el('span', { class: 'field__hint', text: hint }) : null);
        const name = el('input', { class: 'input', name: 'name', maxlength: 60, required: true, autocomplete: 'off' });
        const prompt = el('textarea', { class: 'textarea', name: 'prompt', rows: 6, maxlength: 8000, placeholder: 'e.g. You are a careful senior programmer. Answer with code first, then a short explanation.' });
        const model = el('select', { class: 'select', name: 'model' });
        const thinking = el('select', { class: 'select', name: 'thinking' }, el('option', { value: '', text: 'Default' }), ...THINKING_LEVELS.map(([v, n]) => el('option', { value: v, text: n })));
        const mode = el('select', { class: 'select', name: 'approvalMode' }, el('option', { value: '', text: 'Default' }), ...APPROVAL_MODES.map(([v, n]) => el('option', { value: v, text: n })));
        const cwd = el('input', { class: 'input', name: 'cwd', autocomplete: 'off', placeholder: 'Default: the panel folder', translate: 'no' });
        const save = el('button', { type: 'submit', class: 'btn btn--primary btn--sm', 'data-preset-save': true, text: 'Save preset' });
        const fresh = el('button', { type: 'button', class: 'btn btn--sm', 'data-preset-new': true, text: 'New preset' });
        // Delete asks first (design.js data-confirm), then submits its own form (design.js submits the button's nearest
        // form: inside the preset form it would have sent that one)
        const remove = el('button', { type: 'submit', class: 'btn btn--sm btn--ghost', 'data-preset-delete': true, 'data-confirm-title': 'Delete preset', 'data-confirm-variant': 'danger', text: 'Delete preset' });
        const removeForm = el('form', { class: 'row', hidden: true }, remove);
        const heading = el('h3', { class: 'preset-form__title', 'data-preset-form-title': true, text: 'New preset' });
        const formBox = el('form', { class: 'stack', 'data-preset-form': true }, heading,
            field('Name', name),
            field('Instructions', prompt, 'Added to the system prompt of every chat started with this preset.'),
            el('div', { class: 'form-grid' }, field('Text model', model), field('Thinking', thinking), field('Approval mode', mode), field('Working folder', cwd, 'Used when the chat has full access.')),
            el('div', { class: 'row row--wrap' }, save, fresh));
        let editing = null;
        const fill = (p) => {
            editing = p;
            heading.textContent = p ? 'Edit preset' : 'New preset';
            name.value = p?.name ?? '';
            prompt.value = p?.prompt ?? '';
            // "<name> (remote)" is translated as a pattern (the model name stays)
            const remoteOption = state.remote || p?.model === REMOTE ? [el('option', { value: REMOTE, text: modelName(REMOTE) })] : [];
            model.replaceChildren(el('option', { value: '', text: 'Default' }), ...state.models.map((m) => el('option', { value: m.file, text: modelName(m.file), translate: 'no' })), ...remoteOption, ...(p?.model && p.model !== REMOTE && !state.models.some((m) => m.file === p.model) ? [el('option', { value: p.model, text: `${p.model} (missing)` })] : []));
            model.value = p?.model ?? '';
            thinking.value = p?.thinking ?? '';
            mode.value = p?.approvalMode ?? '';
            cwd.value = p?.cwd ?? '';
            removeForm.hidden = !p;
            if (p) remove.dataset.confirm = `Delete the preset "${p.name}"? Chats started with it keep its instructions.`;
            for (const row of list.querySelectorAll('[data-preset-id]')) row.classList.toggle('preset-list__item--current', row.dataset.presetId === p?.id);
        };
        const renderPresetList = () => {
            list.replaceChildren(...(state.presets.length ? state.presets.map((p) => {
                const row = el('button', { type: 'button', class: 'preset-list__item', 'data-preset-id': p.id },
                    el('span', { class: 'preset-list__name', translate: 'no', text: p.name }),
                    el('span', { class: 'preset-list__note', translate: 'no', text: p.prompt.replace(/\s+/g, ' ').slice(0, 90) || '—' }));
                row.addEventListener('click', () => fill(p));
                return row;
            }) : [el('p', { class: 'text-sm text-muted', text: 'No presets yet. Fill in the form to add the first one.' })]));
        };
        fresh.addEventListener('click', () => {
            fill(null);
            name.focus();
        });
        formBox.addEventListener('submit', async (e) => {
            e.preventDefault();
            save.disabled = true;
            try {
                const body = { name: name.value, prompt: prompt.value, model: model.value || null, thinking: thinking.value || null, approvalMode: mode.value || null, cwd: cwd.value.trim() || null };
                const r = await api(editing ? `/api/v1/chat/presets/${encodeURIComponent(editing.id)}` : '/api/v1/chat/presets', { method: editing ? 'PATCH' : 'POST', body });
                notify(r.message, 'success');
                await loadPresets();
                renderPresetList();
                fill(presetById(r.preset.id));
            } catch (err) {
                notify(err.message, 'danger');
            } finally {
                save.disabled = false;
            }
        });
        removeForm.addEventListener('submit', (e) => e.preventDefault());
        removeForm.submit = async () => {
            if (!editing) return;
            try {
                const r = await api(`/api/v1/chat/presets/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
                notify(r.message, 'success');
                await loadPresets();
                renderPresetList();
                fill(null);
            } catch (err) {
                notify(err.message, 'danger');
            }
        };
        const modal = el('div', { class: 'modal', 'data-modal': true, id: 'modal-chat-presets', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'chat-presets-title' },
            el('div', { class: 'modal__box modal__box--wide' },
                el('header', { class: 'modal__header' },
                    el('div', {}, el('h2', { class: 'modal__title', id: 'chat-presets-title', text: 'Assistant presets' }),
                        el('p', { class: 'text-sm text-muted', text: 'A new chat can start with a preset (Options › Assistant): its instructions join the system prompt and its settings become the chat\'s.' })),
                    el('button', { type: 'button', class: 'modal__close', 'data-modal-close': true, 'aria-label': 'Close', text: '×' })),
                el('div', { class: 'modal__body stack' }, list, formBox, removeForm)));
        document.body.append(modal);
        return {
            modal,
            show() {
                renderPresetList();
                fill(null);
            },
        };
    }

    /*
     * ── Knowledge (user request 08.10.2026): the user's documents the assistant searches (search_knowledge). Added in its
     * window or attached in a chat; an open chat can be set to some of them. The search runs on the CPU: by words, and
     * by meaning too when an embedding model is in llm\embed.
     */

    async function loadKnowledge() {
        try {
            state.knowledge = await api('/api/v1/knowledge');
        } catch {
            state.knowledge = { documents: [], status: null };
        }
        // only the count changes in the open options (they are not built again under the user's finger)
        const note = optionsPanel.querySelector('[data-knowledge-note]');
        if (note) note.textContent = knowledgeNote();
        knowledgeWindow?.render();
        projectWindow?.render();
    }

    function knowledgeNote() {
        const n = state.knowledge.documents.length;
        const chosen = state.current?.knowledge?.length ?? 0;
        if (!n) return 'No documents yet';
        if (state.current && chosen) return `This chat: ${chosen} of ${n} documents`;
        return n === 1 ? '1 document' : `${n} documents`;
    }

    /** The Knowledge group of the options: how many documents, which ones this chat searches, the window's button. */
    function knowledgeGroup() {
        const manage = el('button', { type: 'button', class: 'btn btn--ghost btn--sm chat__options-manage', 'data-knowledge-manage': true, text: 'Knowledge…' });
        manage.addEventListener('click', () => {
            openOptions(false);
            openKnowledge();
        });
        return el('div', { class: 'chat__options-group' }, el('div', { class: 'chat__options-title', text: 'Knowledge' }),
            el('div', { class: 'chat__options-note', 'data-knowledge-note': true, text: knowledgeNote() }), manage);
    }

    let knowledgeWindow = null;
    let knowledgeTimer = null;
    function openKnowledge() {
        if (!knowledgeWindow) knowledgeWindow = buildKnowledgeWindow();
        knowledgeWindow.render();
        window.openNdsWindow?.(knowledgeWindow.modal);
        loadKnowledge();
    }

    function buildKnowledgeWindow() {
        const status = el('p', { class: 'text-sm text-muted', 'data-knowledge-status': true });
        const picker = el('input', { type: 'file', multiple: true, hidden: true, 'data-knowledge-file': true });
        const add = el('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-knowledge-add': true, text: 'Add documents' });
        add.addEventListener('click', () => picker.click());
        picker.addEventListener('change', async () => {
            const files = [...picker.files];
            picker.value = '';
            add.disabled = true;
            try {
                for (const file of files) {
                    add.textContent = `Adding: ${file.name}`;
                    try {
                        const up = await api(`/api/v1/uploads/file?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
                        const r = await api('/api/v1/knowledge', { method: 'POST', body: { source: up.file.source, name: file.name } });
                        notify(r.message, 'success');
                    } catch (e) {
                        notify(`${file.name}: ${e.message}`, 'danger');
                    }
                }
            } finally {
                add.disabled = false;
                add.textContent = 'Add documents';
                await loadKnowledge();
            }
        });
        const query = el('input', { class: 'input', type: 'search', 'data-knowledge-query': true, placeholder: 'Search your documents', autocomplete: 'off', 'aria-label': 'Search your documents' });
        const results = el('div', { class: 'knowledge__results', 'data-knowledge-results': true });
        const searchForm = el('form', { class: 'knowledge__search' }, query, el('button', { type: 'submit', class: 'btn btn--sm', text: 'Search' }));
        searchForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!query.value.trim()) return;
            try {
                const ids = state.current?.knowledge?.length ? `&documents=${encodeURIComponent(state.current.knowledge.join(','))}` : '';
                const r = await api(`/api/v1/knowledge/search?q=${encodeURIComponent(query.value)}&count=5${ids}`);
                results.replaceChildren(...(r.results.length ? r.results.map((x) => el('div', { class: 'knowledge__result' },
                    el('div', { class: 'knowledge__result-head' }, el('span', { class: 'knowledge__name', translate: 'no', text: x.document.name }), x.label ? el('span', { class: 'text-muted', text: x.label }) : null, el('span', { class: 'text-muted', text: `Lines ${x.line}-${x.line + x.lines - 1}` })),
                    el('div', { class: 'knowledge__result-text', translate: 'no', text: x.text.length > 400 ? `${x.text.slice(0, 400)}…` : x.text })))
                    : [el('p', { class: 'text-sm text-muted', text: 'Nothing found.' })]));
            } catch (err) {
                notify(err.message, 'danger');
            }
        });
        const scope = el('p', { class: 'text-sm', 'data-knowledge-scope': true });
        const list = el('div', { class: 'knowledge__list', 'data-knowledge-list': true });
        /** The documents this chat searches: every box checked is all of them (sent as none chosen). */
        const choose = async () => {
            const boxes = [...list.querySelectorAll('[data-knowledge-use]')];
            const checked = boxes.filter((b) => b.checked).map((b) => b.dataset.knowledgeUse);
            if (!checked.length) {
                notify('A chat searches at least one document.', 'warning');
                render();
                return;
            }
            await patch({ knowledge: checked.length === boxes.length ? [] : checked });
            render();
            renderOptions();
        };
        const row = (d) => {
            // a text file's type ("CSV file") stays as it is; the document types and the counts are translated
            const meta = [d.type, d.units ?(d.unit === 'sheet' ? (d.units === 1 ? '1 sheet' : `${d.units} sheets`) : d.unit === 'slide' ? (d.units === 1 ? '1 slide' : `${d.units} slides`) : d.units === 1 ? '1 page' : `${d.units} pages`) : null, d.chunks === 1 ? '1 passage' : `${d.chunks} passages`, d.origin === 'chat' ? 'From a chat' : null, state.knowledge.status?.model && d.embedded < d.chunks ? `Vectors: ${d.embedded}/${d.chunks}` : null].filter(Boolean);
            const remove = el('button', { type: 'submit', class: 'btn btn--ghost btn--sm', 'data-knowledge-delete': d.id, 'data-confirm': `Remove "${d.name}" from Knowledge? The file itself stays.`, 'data-confirm-title': 'Remove document', 'data-confirm-variant': 'danger', 'aria-label': 'Remove', title: 'Remove', text: 'Remove' });
            const form = el('form', { class: 'knowledge__remove' }, remove);
            form.addEventListener('submit', (e) => e.preventDefault());
            form.submit = async () => {
                try {
                    const r = await api(`/api/v1/knowledge/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
                    notify(r.message, 'success');
                    // passages shown from it would be gone on the next search
                    results.replaceChildren();
                    if (state.current?.knowledge?.includes(d.id)) Object.assign(state.current, (await api(`/api/v1/chat/${state.current.id}`)).chat ?? {});
                } catch (err) {
                    notify(err.message, 'danger');
                }
                await loadKnowledge();
            };
            const use = state.current ? el('input', { type: 'checkbox', 'data-knowledge-use': d.id, 'aria-label': 'Use in this chat', title: 'Use in this chat', checked: !state.current.knowledge?.length || state.current.knowledge.includes(d.id) }) : null;
            use?.addEventListener('change', choose);
            return el('div', { class: 'knowledge__item', 'data-knowledge-id': d.id }, use,
                el('div', { class: 'knowledge__item-text' }, el('span', { class: 'knowledge__name', translate: 'no', text: d.name }), el('span', { class: 'knowledge__meta' }, ...meta.flatMap((m, i) => [i ? ' · ' : null, el('span', { text: m, translate: i === 0 && / file$/.test(m) && m !== 'Text file' ? 'no' : null })]).filter(Boolean))),
                form);
        };
        function render() {
            const s = state.knowledge.status;
            const ready = s?.model ? (s.embedded < s.chunks ? `${s.embedded} of ${s.chunks} passages have vectors (being made on the CPU)` : 'every passage has its vector') : null;
            status.textContent = s?.model ? `Search: by words and by meaning (${s.model}, on the CPU); ${ready}.` : 'Search: by words. Put a small multilingual embedding model (GGUF) in llm\\embed to search by meaning too.';
            if (s?.error) status.textContent += ` Last error: ${s.error}`;
            const docs = state.knowledge.documents;
            list.replaceChildren(...(docs.length ? docs.map(row) : [el('p', { class: 'text-sm text-muted', text: 'No documents yet. Add PDF, Word, Excel, PowerPoint or text files; files attached in chats come here too.' })]));
            // vectors are being made on the CPU: the window follows them while it is open
            clearTimeout(knowledgeTimer);
            if (s?.model && s.embedded < s.chunks && !modal.hidden) knowledgeTimer = setTimeout(loadKnowledge, 1500);
            scope.hidden = !state.current || !docs.length;
            scope.textContent = state.current?.knowledge?.length ? 'This chat searches only the checked documents.' : 'This chat searches all documents (uncheck the ones it should leave out).';
        }
        const modal = el('div', { class: 'modal', 'data-modal': true, id: 'modal-chat-knowledge', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'chat-knowledge-title' },
            el('div', { class: 'modal__box modal__box--wide' },
                el('header', { class: 'modal__header' },
                    el('div', {}, el('h2', { class: 'modal__title', id: 'chat-knowledge-title', text: 'Knowledge' }),
                        el('p', { class: 'text-sm text-muted', text: 'Your documents for the assistant: it searches them and answers from the passages it finds, naming the document and page.' })),
                    el('button', { type: 'button', class: 'modal__close', 'data-modal-close': true, 'aria-label': 'Close', text: '×' })),
                el('div', { class: 'modal__body stack' }, status, el('div', { class: 'row row--wrap' }, add, picker), searchForm, results, scope, list)));
        document.body.append(modal);
        return { modal, render };
    }

    /** Popover content and the label beside the icon (only choices that differ from the defaults). */
    function renderOptions() {
        const mode = currentMode();
        const model = currentModel();
        const models = [['', state.defaultModel ? `Default · ${modelName(state.defaultModel)}` : 'Default', null]];
        // the default model is the first entry (it follows Settings); listed again only when chosen explicitly
        for (const m of state.models) if (m.file !== state.defaultModel || model === m.file) models.push([m.file, modelName(m.file), `${m.gib} GiB${m.image ? ' · reads images' : ''}`]);
        if (state.remote || model === REMOTE) models.push([REMOTE, modelName(REMOTE), state.remote ? 'Remote · OpenAI-compatible (Settings › Remote model)' : null]);
        if (model && model !== REMOTE && !state.models.some((m) => m.file === model)) models.push([model, `${model} (missing)`, null]);
        const thinking = currentThinking();
        // replaceChildren writes a null as the text "null" (it showed under the list with only the default model)
        optionsPanel.replaceChildren(...[
            projectGroup(),
            presetGroup(),
            knowledgeGroup(),
            el('div', { class: 'chat__options-group', role: 'radiogroup', 'aria-label': 'Approval mode' }, el('div', { class: 'chat__options-title', text: 'Approval mode' }), ...APPROVAL_MODES.map(([v, n, d]) => option('mode', v, n, d, v === mode))),
            allowGroup(),
            el('div', { class: 'chat__options-group', role: 'radiogroup', 'aria-label': 'Thinking' }, el('div', { class: 'chat__options-title', text: 'Thinking' }), ...THINKING_LEVELS.map(([v, n, d]) => option('thinking', v, n, d, v === thinking))),
            // always shown (user 10.10.2026: "model seçim yok olmuş" with one installed model): which model answers, even without a choice
            el('div', { class: 'chat__options-group', role: 'radiogroup', 'aria-label': 'Text model' }, el('div', { class: 'chat__options-title', text: 'Text model' }), ...models.map(([v, n, d]) => option('model', v, n, d, v === model))),
            temporaryGroup(),
            followUpGroup(),
        ].filter(Boolean));
        renderContext();
        const parts = [];
        if (state.current ? state.current.temporary : state.newTemporary) parts.push(el('span', { text: 'Temporary' }));
        const project = projectById(state.current ? state.current.project : state.project);
        if (project) parts.push(el('span', { translate: 'no', text: project.name }));
        const preset = currentPresetName();
        if (preset) parts.push(el('span', { translate: 'no', text: preset }));
        // the mode always shows (user report 08.10.2026: "Otomatik yazısı gizleniyor": a chat in Allow edits showed nothing)
        parts.push(el('span', { text: APPROVAL_MODES.find(([v]) => v === mode)?.[1] ?? mode }));
        if (thinking !== 'low') parts.push(el('span', { text: `Thinking: ${THINKING_LEVELS.find(([v]) => v === thinking)?.[1] ?? thinking}` }));
        if (model) parts.push(el('span', { translate: model === REMOTE ? null : 'no', text: modelName(model) }));
        optionsLabel.replaceChildren(...parts.flatMap((x, i) => (i ? [' · ', x] : [x])));
        optionsButton.classList.toggle('chat__options-button--auto', mode === 'auto');
    }

    /**
     * A new chat can be temporary (user request 08.10.2026): never saved, not in the list or the search, deleted when it
     * is left (what it made stays in the gallery); "Keep this chat" saves it. The choice lasts while the page is open.
     */
    function temporaryGroup() {
        if (state.current) return null;
        const box = el('input', { type: 'checkbox', 'data-chat-temporary-choice': true, checked: state.newTemporary });
        box.addEventListener('change', () => {
            state.newTemporary = box.checked;
            setStatus(null);
        });
        return el('div', { class: 'chat__options-group' },
            el('label', { class: 'chat__option' }, box, el('span', { class: 'chat__option-text' },
                el('span', { class: 'chat__option-name', text: 'Temporary chat' }),
                el('span', { class: 'chat__option-note', text: 'Not saved and not in the list; gone when you leave it' }))));
    }

    /** The chat's Always allow rules (user request 08.10.2026), each with its × to remove it; no rules, no group. */
    function allowGroup() {
        const rules = state.current?.allow ?? [];
        if (!rules.length) return null;
        return el('div', { class: 'chat__options-group', 'data-allow-list': true },
            el('div', { class: 'chat__options-title', text: 'Always allowed' }),
            el('div', { class: 'chat__options-note', text: 'Run without asking in this chat; irreversible actions always ask.' }),
            ...rules.map((r, i) => {
                const remove = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-allow-remove': i, 'aria-label': 'Remove this rule', title: 'Remove this rule', text: '×' });
                remove.addEventListener('click', async () => {
                    remove.disabled = true;
                    try {
                        const r2 = await api(`/api/v1/chat/${state.current.id}`, { method: 'PATCH', body: { allow: rules.filter((_, k) => k !== i) } });
                        state.current.allow = r2.chat.allow;
                        renderOptions();
                    } catch (e) {
                        notify(e.message, 'danger');
                        remove.disabled = false;
                    }
                });
                return el('div', { class: 'allow-row', 'data-allow-rule': true }, ruleChip(r), remove);
            }));
    }

    /** Follow-up suggestions on this device (user request 08.10.2026): on unless turned off here. */
    function followUpGroup() {
        const box = el('input', { type: 'checkbox', 'data-chat-follow-ups-choice': true, checked: followUpChoice });
        box.addEventListener('change', () => {
            followUpChoice = box.checked;
            try {
                localStorage.setItem('chat.followUps', box.checked ? 'on' : 'off');
            } catch {
                // storage blocked (private window): the choice lasts while the page is open
            }
            if (!box.checked) clearFollowUps();
        });
        return el('div', { class: 'chat__options-group' },
            el('label', { class: 'chat__option' }, box, el('span', { class: 'chat__option-text' },
                el('span', { class: 'chat__option-name', text: 'Suggest follow-ups' }),
                el('span', { class: 'chat__option-note', text: 'Up to three next messages under the last answer, written by the text model (on this device)' }))));
    }

    /** Context group: how full the model's context is, and auto compact (summarize when it fills up). */
    function contextGroup() {
        const ctx = state.current?.context;
        const used = ctx?.used ?? 0;
        const size = ctx?.size ?? 0;
        const percent = size ? Math.min(100, Math.round((used / size) * 100)) : 0;
        const bar = el('span', { class: 'chat__context-fill' });
        bar.style.width = `${percent}%`;
        bar.classList.toggle('chat__context-fill--high', percent >= 80);
        const auto = el('input', { type: 'checkbox', checked: (state.current?.autoCompact ?? state.newAutoCompact) !== false });
        auto.addEventListener('change', () => {
            if (state.current) patch({ autoCompact: auto.checked });
            else state.newAutoCompact = auto.checked;
        });
        // Compact now (also /compact): only for a started, idle chat with something to summarize
        const c = state.current;
        const canCompact = c && c.status === 'idle' && (c.messageCount ?? c.messages?.length ?? 0) >= 2;
        const now = el('button', { type: 'button', class: 'btn btn--sm chat__compact', text: 'Compact now', disabled: !canCompact, title: "Summarize the conversation so far: earlier messages leave the model's context (faster answers, the context does not fill up) and stay visible. Also: type /compact" });
        now.addEventListener('click', compact);
        return el('div', { class: 'chat__options-group' },
            el('div', { class: 'chat__options-title', text: 'Context' }),
            el('div', { class: 'chat__context' },
                el('span', { class: 'chat__context-bar' }, bar),
                el('span', { class: 'chat__option-note', text: used ? `${percent}% · ${formatTokens(used)} / ${formatTokens(size)} tokens` : 'Empty' }),
                now),
            el('label', { class: 'chat__option' }, auto, el('span', { class: 'chat__option-text' },
                el('span', { class: 'chat__option-name', text: 'Compact automatically' }),
                el('span', { class: 'chat__option-note', text: 'When the context fills up, the earlier conversation is summarized' }))));
    }

    /**
     * Job prompts in English (user request 08.10.2026: "işlerle ilgili çeviri ... seçeneklere onu da açma kapamayı ekle").
     * It is the panel-wide setting (Settings › prompt translation): image, video, music and editing prompts.
     */
    function translateGroup() {
        if (state.translatePrompt === null) return null;
        const box = el('input', { type: 'checkbox', checked: state.translatePrompt });
        box.addEventListener('change', async () => {
            box.disabled = true;
            try {
                const r = await api('/api/v1/settings', { method: 'PATCH', body: { translatePrompt: box.checked } });
                state.translatePrompt = r.translatePrompt ?? box.checked;
                notify(r.message, 'success');
            } catch (e) {
                box.checked = !box.checked;
                notify(e.message, 'danger');
            } finally {
                box.disabled = false;
            }
        });
        return el('div', { class: 'chat__options-group' },
            el('div', { class: 'chat__options-title', text: 'Jobs' }),
            el('label', { class: 'chat__option' }, box, el('span', { class: 'chat__option-text' },
                el('span', { class: 'chat__option-name', text: 'Translate prompts to English' }),
                el('span', { class: 'chat__option-note', text: 'Image, video, music and editing prompts reach the models in English; for the whole panel (also in Settings)' }))));
    }

    function openOptions(open) {
        if (open) openContext(false);
        optionsPanel.hidden = !open;
        optionsButton.setAttribute('aria-expanded', String(open));
        if (open) renderOptions();
        // a chat's attachments join Knowledge: its count is fresh when the options open
        if (open) loadKnowledge();
    }

    /** Context button: the percentage beside the icon (orange from 80%); the panel when open. */
    function renderContext() {
        const ctx = state.current?.context;
        const percent = ctx?.size && ctx.used ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : 0;
        contextLabel.textContent = percent ? `${percent}%` : '';
        contextButton.classList.toggle('chat__options-button--auto', percent >= 80);
        // Prompt translation only matters when writing in Turkish: shown with the Turkish interface
        if (!contextPanel.hidden) contextPanel.replaceChildren(...[contextGroup(), rulesGroup(), window.NedeseLang?.language === 'tr' ? translateGroup() : null].filter(Boolean));
    }

    /** Rules the chat follows: Settings › Assistant rules and the project's NEDESE.md / AGENTS.md / CLAUDE.md. */
    function rulesGroup() {
        const rules = state.current?.rules ?? [];
        return el('div', { class: 'chat__options-group' },
            el('div', { class: 'chat__options-title', text: 'Rules' }),
            ...(rules.length
                ? rules.map((r) => el('div', { class: 'chat__rule', title: r.path }, el('span', { class: 'chat__option-name', text: r.source }), el('span', { class: 'chat__option-note', translate: 'no', text: r.path })))
                : [el('span', { class: 'chat__option-note chat__rule', text: 'No rules. Add them in Settings › Assistant rules, or in a NEDESE.md file in the project folder.' })]),
            el('a', { class: 'chat__rule-link text-sm', href: '#settings', text: 'Edit the assistant rules' }));
    }

    function openContext(open) {
        if (open) openOptions(false);
        contextPanel.hidden = !open;
        contextButton.setAttribute('aria-expanded', String(open));
        if (open) renderContext();
    }

    function chooseMode(mode) {
        state.newApprovalMode = mode;
        try {
            // plan mode is for one task: new chats do not start in it
            if (mode !== 'plan') localStorage.setItem('chat.newApprovalMode', mode);
        } catch {
            /* private mode */
        }
        if (state.current) patch({ approvalMode: mode });
        else renderOptions();
    }

    /** Thinking level of this chat (from its next model call, also while it runs); remembered for new chats. */
    function chooseThinking(level) {
        state.newThinking = level;
        try {
            localStorage.setItem('chat.thinking', level);
        } catch {
            /* private mode */
        }
        if (state.current) patch({ thinking: level });
        else renderOptions();
    }

    function chooseModel(model) {
        if (state.current) patch({ model });
        else {
            state.newModel = model;
            renderOptions();
        }
    }

    const formatTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

    function renderStatus() {
        const c = state.current;
        const running = c?.status === 'running' || c?.status === 'approval' || c?.status === 'question';
        statusParent.hidden = !c?.parent;
        statusWork.replaceChildren(...(running ? [el('span', { class: 'dot dot--blue' }), el('span', { text: c.status === 'approval' ? 'Waiting for your approval' : c.status === 'question' ? 'Waiting for your answer' : state.progress || 'Working…' })] : []));
        const run = c?.runUsage;
        const total = c?.usage;
        const sum = (u) => (u ? (u.input ?? 0) + (u.output ?? 0) : 0);
        // While running the exact number, so that it visibly counts up as the model writes (8.5k would hide it)
        const usage = running && sum(run) ? el('span', { class: 'chat__usage', title: `This turn: ${run.input} input, ${run.output} output tokens. Chat total: ${sum(total)} tokens.`, text: `${sum(run).toLocaleString(document.documentElement.lang || 'en')} tokens` })
            : !running && sum(total) ? el('span', { class: 'chat__usage', title: `${total.input} input, ${total.output} output tokens`, text: `Spent in this chat: ${formatTokens(sum(total))} tokens` }) : null;
        const counts = backgroundCounts(shownBackground(c));
        backgroundToggle.hidden = !counts.length;
        if (counts.length) {
            statusUsage.replaceChildren();
            backgroundToggle.replaceChildren(usage ?? '', ...counts.map((t) => el('span', { class: 'chat__background-count', text: t })), el('span', { class: 'chat__background-chevron', 'aria-hidden': 'true' }));
            backgroundToggle.setAttribute('aria-expanded', String(Boolean(state.backgroundOpen)));
        } else statusUsage.replaceChildren(...(usage ? [usage] : []));
        renderBackground();
    }

    /*
     * What the chat runs in the background (GET /chat/background?chat=, the chat's "background" events): its sub-agents
     * (the finished ones until the user writes again), background commands, watchers, monitors and wake-ups. The line counts them
     * ("2 sub-agents (1 running)"); its list has a row for each, newest first: the task, state, a clock while it runs,
     * a sub-agent's tokens, Open for a sub-agent and Stop for what still runs.
     */
    const BACKGROUND_NAMES = { agent: ['sub-agent', 'sub-agents'], command: ['background command', 'background commands'], watch: ['watcher', 'watchers'], monitor: ['monitor', 'monitors'], wakeup: ['wake-up', 'wake-ups'] };
    const BACKGROUND_KINDS = { agent: 'Sub-agent', command: 'Background command', watch: 'Watcher', monitor: 'Monitor', wakeup: 'Wake-up' };
    const BACKGROUND_STATES = { running: 'running', waiting: 'waiting', done: 'done', stopped: 'stopped', error: 'error' };
    const BACKGROUND_DOTS = { running: 'dot--blue', waiting: 'dot--yellow', done: 'dot--green', error: 'dot--red' };
    const STOP_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/></svg>';
    let backgroundTick = null;

    /*
     * A sub-agent or command that finished stays listed until the user writes again (user request 09.10.2026:
     * "yeniden yazınca temizlensin"); what still runs or waits always shows.
     */
    function shownBackground(c) {
        const asked = Date.parse([...(c?.messages ?? [])].reverse().find((m) => m.role === 'user' && !m.wake)?.time ?? '');
        return (c?.background ?? []).filter((x) => !x.ended || !(Date.parse(x.ended) < asked));
    }

    function backgroundCounts(items) {
        const out = [];
        for (const [kind, [one, many]] of Object.entries(BACKGROUND_NAMES)) {
            const list = items.filter((x) => x.kind === kind);
            if (!list.length) continue;
            const n = list.length;
            const name = n === 1 ? one : many;
            // sub-agents and commands that finished stay listed: how many of them still run
            const active = list.filter((x) => x.status === 'running').length;
            out.push(['agent', 'command'].includes(kind) && active ? (active === n ? `${n} ${name} running` : `${n} ${name} (${active} running)`) : `${n} ${name}`);
        }
        return out;
    }

    const clockText = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    // a time today as 14:05, another day with its date
    const whenText = (iso) => {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const local = window.NedeseLang?.local ?? 'en-GB';
        return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(local, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(local, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    };

    function renderBackground() {
        const items = shownBackground(state.current);
        const open = Boolean(state.backgroundOpen) && items.length > 0;
        backgroundBox.hidden = !open;
        clearInterval(backgroundTick);
        if (!open) return;
        backgroundBox.replaceChildren(...items.map(backgroundRow));
        // the clocks of what runs count on
        if (items.some((x) => x.status === 'running')) {
            backgroundTick = setInterval(() => {
                for (const s of backgroundBox.querySelectorAll('[data-since]')) s.textContent = clockText(Math.max(0, Math.round((Date.now() - Number(s.dataset.since)) / 1000)));
            }, 1000);
        }
    }

    function backgroundRow(x) {
        const active = x.status === 'running' || x.status === 'waiting';
        const meta = [el('span', { text: BACKGROUND_KINDS[x.kind] ?? x.kind }), el('span', { text: BACKGROUND_STATES[x.status] ?? x.status })];
        if (x.status === 'running' && Number.isFinite(x.seconds)) meta.push(el('span', { translate: 'no', 'data-since': String(Date.now() - x.seconds * 1000), text: clockText(x.seconds) }));
        if (x.kind === 'agent' && x.tokens) meta.push(el('span', { text: `${formatTokens(x.tokens)} tokens` }));
        if (x.kind === 'command' && x.status === 'error' && x.code !== null && x.code !== undefined) meta.push(el('span', { text: `exit code ${x.code}` }));
        if (x.kind === 'watch') meta.push(el('span', { text: `every ${x.every} min` }), el('span', { text: `until ${whenText(x.ends)}` }));
        if (x.kind === 'wakeup') meta.push(el('span', { text: `next ${whenText(x.next)}` }), x.every ? el('span', { text: `every ${x.every} min` }) : null);
        if (x.kind === 'monitor' && x.lines) meta.push(el('span', { text: x.lines === 1 ? '1 line' : `${x.lines} lines` }));
        if ((x.kind === 'watch' || x.kind === 'monitor') && x.last?.text) meta.push(el('span', { translate: 'no', title: x.last.text, text: x.last.text }));
        const row = el('div', { class: `chat__background-item chat__background-item--${x.status}`, role: 'listitem', 'data-background-item': x.id, 'data-background-kind': x.kind },
            el('span', { class: `dot ${BACKGROUND_DOTS[x.status] ?? ''}`, 'aria-hidden': 'true' }),
            el('span', { class: 'chat__background-text' },
                el('span', { class: 'chat__background-name', translate: 'no', title: x.text, text: x.text || x.id }),
                el('span', { class: 'chat__background-meta' }, ...meta.filter(Boolean))));
        if (x.kind === 'agent') {
            const open = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-background-open': x.id, text: 'Open' });
            open.addEventListener('click', () => select(x.id));
            row.append(open);
        }
        if (active) {
            const stop = el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'data-background-stop': x.id, 'aria-label': 'Stop', title: 'Stop' });
            stop.innerHTML = STOP_ICON;
            stop.addEventListener('click', () => stopBackground(x.id, stop));
            row.append(stop);
        }
        return row;
    }

    /** Stops one background item (the list follows from the chat's "background" event). */
    async function stopBackground(id, button) {
        button.disabled = true;
        try {
            const r = await api(`/api/v1/chat/background/${encodeURIComponent(id)}`, { method: 'DELETE' });
            notify(r.message, 'success');
        } catch (e) {
            notify(e.message, 'danger');
            button.disabled = false;
        }
        refreshRunning();
    }

    backgroundToggle.addEventListener('click', () => {
        state.backgroundOpen = !state.backgroundOpen;
        renderStatus();
    });
    statusParent.addEventListener('click', () => {
        if (state.current?.parent) select(state.current.parent);
    });

    /** Title of the open chat; "New chat" (translated) until the first message names it. The chat's menu renames it. */
    function setTitle(chat) {
        if (chat?.title) titleBox.setAttribute('translate', 'no');
        else titleBox.removeAttribute('translate');
        titleBox.textContent = chat?.title || 'New chat';
        titleBox.setAttribute('title', titleBox.textContent);
    }

    /**
     * Rename in place (user request 08.10.2026): Enter saves, Escape cancels, leaving the box saves. Opened from the chat's
     * menu (09.10.2026: the pencil next to the title left, the menu has Rename).
     */
    function startRename() {
        if (!state.current || titleBox.hidden) return;
        const old = state.current.title || '';
        const field = el('input', { type: 'text', class: 'input chat__title-input', value: old, maxlength: 80, 'aria-label': 'Chat name', translate: 'no', autocomplete: 'off' });
        titleBox.hidden = true;
        titleBox.after(field);
        field.focus();
        field.select();
        let done = false;
        const finish = async (save) => {
            if (done) return;
            done = true;
            const value = field.value.replace(/\s+/g, ' ').trim();
            field.remove();
            titleBox.hidden = false;
            if (!save || !value || value === old) return;
            await patch({ title: value });
            const item = state.chats.find((c) => c.id === state.current?.id);
            if (item) item.title = value;
            renderList();
        };
        field.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                finish(true);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                finish(false);
            }
        });
        field.addEventListener('blur', () => finish(true));
    }

    /**
     * Send and Stop are one button (user request 08.10.2026: "Ok butonu durdura dönüşmeli"): while the chat runs with
     * nothing typed or attached it stops the chat; something typed turns it back into Send, and the message waits for
     * the assistant's next step (or answers its question).
     */
    function updateSendStop() {
        const draft = Boolean(input.value.trim()) || state.attachments.length > 0;
        stopButton.hidden = !state.running || draft;
        sendButton.hidden = !stopButton.hidden;
    }

    function setStatus(chat) {
        const running = chat?.status === 'running' || chat?.status === 'approval' || chat?.status === 'question';
        if (!running) state.progress = '';
        state.running = running;
        updateSendStop();
        input.disabled = false;
        setTitle(chat);
        renderOptions();
        // the Compact button of an open Context panel follows the status (it stayed enabled when a run began)
        renderContext();
        for (const f of deleteForms) f.hidden = !chat;
        menuButton.hidden = !chat;
        if (!chat) openMenu(false);
        else if (!menuPanel.hidden) renderMenu();
        // a temporary chat says so above its messages (also a new chat that will be one)
        temporaryBox.hidden = !(chat ? chat.temporary : state.newTemporary);
        keepButton.hidden = !chat?.temporary;
        renderPlans();
        renderStatus();
        updateRegenerate();
    }

    // What the chat produced (its jobs and the web pictures it fetched) is deleted only when the box is ticked; unticked it
    // stays in the gallery (user request 08.10.2026)
    function updateDeleteConfirm() {
        const n = state.createdJobs.size;
        const check = n === 0 ? '' : n === 1 ? 'Also delete what this chat produced (1 item: images, videos and other outputs). Unticked, it stays in the gallery.' : `Also delete what this chat produced (${n} items: images, videos and other outputs). Unticked, they stay in the gallery.`;
        for (const b of deleteButtons) {
            b.dataset.confirm = 'Delete this chat?';
            b.dataset.confirmCheck = check;
        }
    }

    /* ── Data ─────────────────────────────────────────────────────────── */

    // A search's words and order (Best match first: sort=relevance; user request 08.10.2026); the archive's pages
    const searchParams = () => (state.query ? `&q=${encodeURIComponent(state.query)}${searchSort?.value === 'relevance' ? '&sort=relevance' : ''}` : state.archivedView ? '&archived=1' : '') + (state.project ? `&project=${encodeURIComponent(state.project)}` : '');

    let loadSerial = 0;
    async function loadList() {
        const serial = ++loadSerial;
        if (searchSort) searchSort.hidden = !state.query;
        try {
            const r = await api(`/api/v1/chat?limit=${PAGE}${searchParams()}`);
            if (serial !== loadSerial) return;
            state.chats = r.chats ?? [];
            state.total = r.total ?? state.chats.length;
            state.next = r.next ?? null;
            state.pinned = r.pinned ?? [];
            if (r.archivedCount !== undefined) state.archivedCount = r.archivedCount;
            // an open temporary chat is never in the server's list: it stays at the top while it is open
            const open = state.current;
            if (open?.temporary && !state.query && !state.archivedView && !state.chats.some((c) => c.id === open.id)) state.chats.unshift(open);
            state.models = r.models ?? [];
            state.defaultModel = r.defaultModel ?? null;
            state.remote = r.remote ?? null;
            if (r.translatePrompt !== undefined) state.translatePrompt = r.translatePrompt;
            if (r.textModel === false) {
                messagesBox.replaceChildren(el('div', { class: 'alert alert--warning', text: 'Chat needs the local text model (llm\\bin\\llama-server.exe and a model in llm\\models). Run setup.bat.' }));
                form.hidden = true;
            }
            renderOptions();
            renderList();
        } catch (e) {
            notify(e.message, 'danger');
        }
    }

    async function loadMore() {
        if (!state.next || state.loadingMore || !(state.expanded || state.query)) return;
        state.loadingMore = true;
        const serial = loadSerial;
        try {
            const r = await api(`/api/v1/chat?limit=${PAGE}&after=${encodeURIComponent(state.next)}${searchParams()}`);
            if (serial !== loadSerial) return;
            const known = new Set(state.chats.map((c) => c.id));
            state.chats.push(...(r.chats ?? []).filter((c) => !known.has(c.id)));
            state.next = r.next ?? null;
            state.total = r.total ?? state.total;
            renderList();
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            state.loadingMore = false;
        }
    }

    let reloadTimer = null;
    const reloadSoon = () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(loadList, 800);
    };

    /**
     * Server-Sent Events over fetch: EventSource cannot send the X-Panel header, and over plain http on a network
     * address (a phone on the LAN) the browser sends no Sec-Fetch-Site either, so the server would answer 401.
     * Reconnects after a pause like EventSource; onOpen runs on every (re)connect.
     */
    function eventStream(url, onEvent, { onOpen } = {}) {
        let closed = false;
        let controller = null;
        const run = async () => {
            while (!closed) {
                controller = new AbortController();
                try {
                    const r = await fetch(url, { headers: { Accept: 'text/event-stream', 'X-Panel': '1', 'X-Panel-Lang': 'en' }, signal: controller.signal, cache: 'no-store' });
                    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
                    onOpen?.();
                    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
                    let buffer = '';
                    // the server sends a heartbeat every 15 s: 45 s of silence is a dead connection, it is reopened
                    let heard = Date.now();
                    const watch = setInterval(() => {
                        if (Date.now() - heard > 45000) controller.abort();
                    }, 5000);
                    try {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        heard = Date.now();
                        buffer += value.replace(/\r\n?/g, '\n');
                        let cut;
                        while ((cut = buffer.indexOf('\n\n')) >= 0) {
                            const block = buffer.slice(0, cut);
                            buffer = buffer.slice(cut + 2);
                            const data = block
                                .split('\n')
                                .filter((l) => l.startsWith('data:'))
                                .map((l) => l.slice(5).replace(/^ /, ''))
                                .join('\n');
                            if (!data) continue;
                            let e;
                            try {
                                e = JSON.parse(data);
                            } catch {
                                continue;
                            }
                            if (!closed) onEvent(e);
                        }
                    }
                    } finally {
                        clearInterval(watch);
                    }
                } catch {
                    /* connection lost or closed: retry below */
                }
                if (!closed) await new Promise((ok) => setTimeout(ok, 3000));
            }
        };
        run();
        return {
            close() {
                closed = true;
                controller?.abort();
            },
        };
    }

    /* ── Running agents: the header button and its panel ── */
    const runningButton = $('[data-chat-running]', section);
    const runningPanel = $('[data-chat-running-panel]', section);
    let runningTimer = null;
    let runningTick = null;

    async function loadRunning() {
        try {
            const r = await api('/api/v1/chat/running');
            state.runningAgents = r.agents ?? [];
            // the sub-agents are in agents, under their parent
            state.runningBackground = (r.background ?? []).filter((x) => x.kind !== 'agent');
            state.runningAt = Date.now();
        } catch {
            return;
        }
        renderRunning();
    }

    const refreshRunning = () => {
        clearTimeout(runningTimer);
        runningTimer = setTimeout(loadRunning, 250);
    };

    /*
     * The Running list (user request 09.10.2026: "Ajan durdurulabilmeli"): every chat that works or runs something in the
     * background, its sub-agents under it and its background items (commands, watchers, monitors, wake-ups) under those,
     * each with a Stop; a chat's Stop stops everything it runs. Stop all when more than one thing runs.
     */
    function renderRunning() {
        const agents = state.runningAgents ?? [];
        const items = state.runningBackground ?? [];
        const count = agents.length + items.length;
        runningButton.hidden = !count;
        $('[data-chat-running-count]', runningButton).textContent = String(count);
        if (!count) openRunning(false);
        if (runningPanel.hidden) return;
        const since = Math.round((Date.now() - (state.runningAt ?? Date.now())) / 1000);
        const byId = new Map(agents.map((a) => [a.id, a]));
        // chats that only own background items (idle now)
        for (const x of items) if (x.chat && !byId.has(x.chat)) byId.set(x.chat, { id: x.chat, title: x.chatTitle, idle: true, parent: null });
        const children = (id) => [...byId.values()].filter((a) => a.parent === id);
        const rows = [];
        const add = (a, depth) => {
            rows.push(runningChatRow(a, depth, since));
            for (const x of items.filter((i) => i.chat === a.id)) rows.push(runningItemRow(x, depth + 1, since));
            for (const sub of children(a.id)) add(sub, depth + 1);
        };
        for (const a of byId.values()) if (!a.parent || !byId.has(a.parent)) add(a, 0);
        const stopAll = count > 1 ? el('button', { type: 'button', class: 'btn btn--sm chat__running-stop-all', 'data-chat-stop-all': true, text: 'Stop all' }) : null;
        stopAll?.addEventListener('click', async () => {
            stopAll.disabled = true;
            try {
                const r = await api('/api/v1/chat/stop-all', { method: 'POST' });
                notify(r.message, 'success');
            } catch (e) {
                notify(e.message, 'danger');
                stopAll.disabled = false;
            }
            refreshRunning();
        });
        runningPanel.replaceChildren(el('div', { class: 'chat__running-head' }, el('div', { class: 'chat__options-title', text: 'Running agents' }), stopAll), ...rows);
    }

    const runningClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

    /** A Stop button; action runs on click, then the list loads again. */
    function runningStop(label, action) {
        const stop = el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': label, title: label });
        stop.innerHTML = STOP_ICON;
        stop.addEventListener('click', async () => {
            stop.disabled = true;
            try {
                const r = await action();
                if (r?.stopped?.length) notify(r.message, 'success');
            } catch (e) {
                notify(e.message, 'danger');
            }
            refreshRunning();
        });
        return stop;
    }

    function runningChatRow(a, depth, since) {
        const doing = a.idle ? 'In the background' : a.status === 'approval' ? 'Waiting for your approval' : a.status === 'question' ? 'Waiting for your answer' : a.progress || (a.tool ? toolLabel(a.tool) : 'Thinking…');
        const tokens = a.usage ? (a.usage.input ?? 0) + (a.usage.output ?? 0) : 0;
        const open = el('button', { type: 'button', class: 'chat__running-open', title: 'Open this chat' },
            el('span', { class: `dot ${a.idle ? 'dot--yellow' : a.status === 'running' ? 'dot--blue' : 'dot--yellow'}`, 'aria-hidden': 'true' }),
            el('span', { class: 'chat__running-text' },
                el('span', { class: 'chat__running-name', translate: 'no', text: a.title || 'New chat' }),
                el('span', { class: 'chat__running-meta' },
                    a.parent ? el('span', { text: 'Sub-agent' }) : null,
                    a.idle ? null : el('span', { text: `Step ${a.tool || a.status !== 'running' ? a.step : a.step + 1}` }),
                    el('span', { text: doing }),
                    a.idle ? null : el('span', { translate: 'no', text: runningClock(a.seconds + since) }),
                    tokens ? el('span', { text: `${formatTokens(tokens)} tokens` }) : null)));
        open.addEventListener('click', () => {
            openRunning(false);
            listBox.classList.remove('open');
            select(a.id);
        });
        // a chat's Stop stops its step and everything it runs in the background
        const stop = runningStop('Stop', () => api(`/api/v1/chat/${a.id}/stop`, { method: 'POST' }));
        return el('div', { class: `chat__running-item${a.id === state.current?.id ? ' chat__running-item--current' : ''}`, style: depth ? `--depth: ${depth}` : null, 'data-running-chat': a.id }, open, stop);
    }

    function runningItemRow(x, depth, since) {
        const label = el('span', { class: 'chat__running-open chat__running-open--static' },
            el('span', { class: `dot ${BACKGROUND_DOTS[x.status] ?? ''}`, 'aria-hidden': 'true' }),
            el('span', { class: 'chat__running-text' },
                el('span', { class: 'chat__running-name', translate: 'no', title: x.text, text: x.text || x.id }),
                el('span', { class: 'chat__running-meta' },
                    el('span', { text: BACKGROUND_KINDS[x.kind] ?? x.kind }),
                    el('span', { text: BACKGROUND_STATES[x.status] ?? x.status }),
                    x.status === 'running' && Number.isFinite(x.seconds) ? el('span', { translate: 'no', text: runningClock(x.seconds + since) }) : null,
                    x.kind === 'watch' ? el('span', { text: `every ${x.every} min` }) : null,
                    x.kind === 'wakeup' && x.next ? el('span', { text: `next ${whenText(x.next)}` }) : null)));
        const stop = runningStop('Stop', () => api(`/api/v1/chat/background/${encodeURIComponent(x.id)}`, { method: 'DELETE' }));
        return el('div', { class: 'chat__running-item chat__running-item--background', style: `--depth: ${depth}`, 'data-running-item': x.id }, label, stop);
    }

    function openRunning(open) {
        runningPanel.hidden = !open;
        runningButton.setAttribute('aria-expanded', String(open));
        clearInterval(runningTick);
        if (!open) return;
        renderRunning();
        // the clocks count while the panel is open; the list itself comes again with the events
        runningTick = setInterval(renderRunning, 1000);
    }

    function streamList() {
        state.listStream?.close();
        let first = true;
        state.listStream = eventStream('/api/v1/chat/events', (e) => {
            if (['status', 'start', 'tool', 'approval', 'approval_done', 'question', 'question_done', 'done', 'deleted', 'background'].includes(e.type)) refreshRunning();
            if (e.type === 'status') {
                // (Re)connected: the first page again (events may have been missed)
                if (!first) reloadSoon();
                first = false;
                return;
            }
            if (e.type === 'deleted') {
                const before = state.chats.length;
                state.chats = state.chats.filter((x) => x.id !== e.chat);
                state.pinned = state.pinned.filter((x) => x.id !== e.chat);
                if (state.chats.length !== before) state.total = Math.max(0, state.total - 1);
                renderList();
                return;
            }
            if (!['start', 'approval', 'approval_done', 'question', 'question_done', 'done', 'message', 'update', 'created'].includes(e.type)) return;
            const c = state.chats.find((x) => x.id === e.chat) ?? state.pinned.find((x) => x.id === e.chat);
            // pinned or archived (here or on another device): the chat moves to its group
            if (c && e.type === 'update' && (Boolean(c.pinned) !== Boolean(e.summary?.pinned) || Boolean(c.archived) !== Boolean(e.summary?.archived))) {
                Object.assign(c, e.summary);
                reloadSoon();
                return;
            }
            if (!c) {
                // created: a chat forked from another (here or on another device)
                if (!state.query && ['start', 'message', 'created'].includes(e.type)) reloadSoon();
                return;
            }
            if (e.type === 'start') c.status = 'running';
            else if (e.type === 'approval') c.status = 'approval';
            else if (e.type === 'question') c.status = 'question';
            else if (e.type === 'approval_done' || e.type === 'question_done') c.status = 'running';
            else if (e.type === 'done') {
                c.status = 'idle';
                c.error = e.error ?? null;
            } else if (e.type === 'message' && !c.title) c.title = e.message?.content?.slice(0, 60) ?? '';
            else if (e.type === 'update') Object.assign(c, e.summary);
            if (e.type === 'message' && !state.query) {
                // Newest activity first, like the server's order
                c.update = e.time;
                state.chats.sort((a, b) => (a.update < b.update ? 1 : a.update > b.update ? -1 : 0));
            }
            renderList();
        });
    }

    /** A temporary chat that is left is deleted (what it made stays in the gallery). */
    function dropTemporary(chat) {
        if (!chat?.temporary) return;
        state.chats = state.chats.filter((c) => c.id !== chat.id);
        api(`/api/v1/chat/${encodeURIComponent(chat.id)}?keepOutputs=1`, { method: 'DELETE' }).catch(() => {});
    }

    async function select(id, { quiet = false } = {}) {
        if (state.current?.temporary && state.current.id !== id) dropTemporary(state.current);
        state.chatStream?.close();
        state.chatStream = null;
        liveEnd({ keep: false });
        // an answer read aloud stops with its chat
        if (speech.button) stopSpeaking();
        state.progress = '';
        state.backgroundOpen = false;
        openMenu(false);
        if (!id) {
            state.current = null;
            state.createdJobs = new Set();
            messagesBox.replaceChildren(emptyState());
            setStatus(null);
            renderList();
            return;
        }
        try {
            const r = await api(`/api/v1/chat/${encodeURIComponent(id)}`);
            state.current = r.chat;
        } catch (e) {
            // The remembered chat was deleted elsewhere: start a new one without a warning
            if (quiet) return select(null);
            notify(e.message, 'danger');
            return;
        }
        try {
            // a temporary chat is not opened again after a reload: it is gone by then
            if (!state.current.temporary) localStorage.setItem('chat.current', id);
        } catch {
            /* private mode */
        }
        if (!state.chats.some((c) => c.id === id) && !state.pinned.some((c) => c.id === id)) {
            state.chats.unshift(state.current);
            if (!state.current.temporary) state.total += 1;
        }
        renderMessages(state.current);
        setStatus(state.current);
        renderList();
        streamChat(id);
    }

    function streamChat(id) {
        let first = true;
        // the turn's answer: its follow-up suggestions are asked for when the run is done
        let lastFinal = null;
        const onEvent = (e) => {
            if (!state.current || state.current.id !== id) return;
            if (e.type === 'status') {
                // First event: full state. Re-render only if messages arrived between the fetch and the stream.
                if (first && (e.chat?.messages?.length ?? 0) !== state.current.messages.length) {
                    state.current = e.chat;
                    renderMessages(state.current);
                } else if (e.chat?.live) liveRestore(e.chat.live); // pieces written while the stream was not connected
                first = false;
                state.current = { ...state.current, ...e.chat };
                setStatus(state.current);
                return;
            }
            const c = state.current;
            if (e.type === 'message' && e.message?.wake) {
                // from the background: a note, the run that follows is shown as usual
                clearFollowUps();
                flushEdits();
                c.messages.push(e.message);
                c.messageCount = (c.messageCount ?? 0) + 1;
                append(wakeNote(e.message), { force: true });
            } else if (e.type === 'note') {
                c.messages.push(e.message);
                append(wakeNote(e.message), { force: true });
            } else if (e.type === 'background') {
                c.background = e.items ?? [];
                renderStatus();
            } else if (e.type === 'message') {
                clearFollowUps();
                c.messages.push(e.message);
                c.messageCount = (c.messageCount ?? 0) + 1;
                if (!c.title) {
                    // the server names the chat after its first message
                    c.title = String(e.message?.content || e.message?.attachments?.[0]?.source || 'Chat').replace(/\s+/g, ' ').slice(0, 60);
                    setTitle(c);
                }
                const box = userMessage(e.message);
                if (e.queued) {
                    box.classList.add('message--queued');
                    box.append(el('div', { class: 'message__queued', text: 'Queued: the assistant reads it at its next step' }));
                } else flushEdits();
                append(box, { force: true });
                updateRegenerate();
                // what finished in the background before this message leaves the line
                renderStatus();
            } else if (e.type === 'inbox') {
                takeQueued();
            } else if (e.type === 'start') {
                clearFollowUps();
                lastFinal = null;
                c.status = 'running';
                c.runUsage = { input: 0, output: 0 };
                setStatus(c);
            } else if (e.type === 'delta') {
                liveDelta(e.text ?? '');
            } else if (e.type === 'reasoning') {
                liveReasoning(e.text ?? '');
            } else if (e.type === 'text') {
                c.messageCount = (c.messageCount ?? 0) + 1;
                // final: the answer of the turn, rated with the thumbs under it
                const answer = { id: e.id ?? null, rateable: Boolean(e.final) && !e.panel, panel: Boolean(e.panel), sources: e.sources ?? null };
                if (e.final && e.id) lastFinal = e.id;
                if (!liveText(e.text, answer)) append(assistantMessage(e.text, { reasoning: e.reasoning, ...answer }));
            } else if (e.type === 'rating') {
                const bar = $(`[data-rate-id="${CSS.escape(e.id)}"]`, messagesBox);
                for (const b of bar?.querySelectorAll('[data-rate]') ?? []) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === e.rating));
            } else if (e.type === 'branch' && e.detail) {
                // a message was edited or another version is shown (here or on another device): the chat as it is now
                state.current = e.detail;
                renderMessages(state.current);
                setStatus(state.current);
            } else if (e.type === 'tool') {
                liveEnd();
                append(toolCard({ id: e.id, name: e.name, input: e.input }));
            } else if (e.type === 'tool_result') {
                toolResult(e.id, { text: e.text, extra: e.extra, error: e.error, duration: e.duration });
                if (e.extra?.edit && !e.error) state.turnEdits.push(e.extra.edit);
                // the page the agent just wrote, shown as it is now (beside the chat; a phone keeps its card)
                if (e.extra?.artifact && !e.error && (preview || matchMedia('(min-width: 901px)').matches)) openArtifact(`file:${e.extra.artifact.path}`, null, { focus: false });
            } else if (e.type === 'progress') {
                toolProgress(e.text);
                state.progress = e.text ?? '';
                renderStatus();
            } else if (e.type === 'usage') {
                c.runUsage = e.run;
                c.usage = e.total;
                renderStatus();
            } else if (e.type === 'context') {
                c.context = { used: e.used, size: e.size };
                renderContext();
            } else if (e.type === 'update') {
                Object.assign(c, e.summary);
                setStatus(c);
            } else if (e.type === 'undo') {
                const b = $(`[data-undo="${CSS.escape(e.checkpoint)}"]`, messagesBox);
                if (b) {
                    b.textContent = 'Undone';
                    b.disabled = true;
                }
                // the edit leaves its turn's summary
                for (const box of messagesBox.querySelectorAll('[data-edits]')) {
                    const undone = (box.edits ?? []).filter((x) => x.checkpoint === e.checkpoint);
                    for (const x of undone) x.undone = true;
                    if (undone.length) renderEditSummary(box);
                }
                for (const x of state.turnEdits) if (x.checkpoint === e.checkpoint) x.undone = true;
            } else if (e.type === 'compact') {
                append(compactNote(e.summary), { force: true });
            } else if (e.type === 'left_out') {
                append(leftOutNote(e.text), { force: true });
            } else if (e.type === 'approval') {
                c.status = 'approval';
                c.approval = { id: e.id, tool: e.tool, input: e.input, risk: e.risk, allow: e.allow ?? null };
                append(approvalCard(c.approval), { force: true });
                setStatus(c);
            } else if (e.type === 'question') {
                c.status = 'question';
                c.question = { id: e.id, question: e.question, options: e.options, panel: Boolean(e.panel) };
                liveEnd();
                append(questionCard(c.question), { force: true });
                setStatus(c);
            } else if (e.type === 'question_done') {
                $(`[data-question-card="${CSS.escape(e.id)}"]`, messagesBox)?.closest('.message')?.remove();
                if (e.answer) append(userMessage({ content: e.answer }), { force: true });
                c.status = 'running';
                c.question = null;
                setStatus(c);
            } else if (e.type === 'approval_done') {
                $(`[data-approval-card="${CSS.escape(e.id)}"]`, messagesBox)?.closest('.message')?.remove();
                c.status = 'running';
                c.approval = null;
                setStatus(c);
            } else if (e.type === 'error') {
                liveEnd();
                append(assistantMessage(`Error: ${e.error}`, { error: true }));
            } else if (e.type === 'done') {
                liveEnd();
                takeQueued();
                c.status = 'idle';
                c.error = e.error ?? null;
                setStatus(c);
                if (!e.response && !e.error && !e.compact) append(assistantMessage('(stopped)', { panel: true }));
                flushEdits();
                updateRegenerate();
                if (lastFinal && e.response && !e.error) requestFollowUps(id, lastFinal);
                lastFinal = null;
            } else if (e.type === 'deleted') {
                select(null);
            }
        };
        // On every (re)connect the first 'status' event brings the full state again.
        state.chatStream = eventStream(`/api/v1/chat/${encodeURIComponent(id)}/events`, onEvent, {
            onOpen: () => {
                first = true;
            },
        });
    }

    /* ── Composer ─────────────────────────────────────────────────────── */

    function resizeInput() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
        updateSendStop();
    }

    function renderAttachments() {
        attachPreview.replaceChildren(...state.attachments.map((a, i) => {
            const remove = el('button', { type: 'button', 'aria-label': 'Remove', text: '×' });
            remove.addEventListener('click', () => {
                state.attachments.splice(i, 1);
                renderAttachments();
            });
            return el('div', { class: `attachment-chip${a.previewUrl ? '' : ' attachment-chip--file'}${a.uploading ? ' attachment-chip--uploading' : ''}`, title: a.name },
                a.previewUrl ? el('img', { src: a.previewUrl, alt: '' }) : fileChip(a),
                remove);
        }));
    }

    async function addFiles(files) {
        for (const file of files) {
            const image = /^image\/(png|jpeg|webp)$/.test(file.type);
            const music = /^audio\//.test(file.type);
            // any other file (PDF, Word, Excel, PowerPoint, code, CSV…): the model reads it as text with the message
            const route = image ? '/api/v1/uploads/image' : music ? '/api/v1/uploads/music' : '/api/v1/uploads/file';
            const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${Date.now()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
            const item = { name, type: image ? 'image' : music ? 'music' : 'file', previewUrl: image ? URL.createObjectURL(file) : null, uploading: true, source: null };
            state.attachments.push(item);
            renderAttachments();
            try {
                const r = await api(`${route}?name=${encodeURIComponent(name)}`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
                item.source = (r.image ?? r.music ?? r.file ?? r.data ?? r.upload)?.source ?? null;
                if (!item.source) throw new Error('Upload returned no source.');
                item.uploading = false;
            } catch (e) {
                notify(e.message, 'danger');
                state.attachments.splice(state.attachments.indexOf(item), 1);
            }
            renderAttachments();
        }
    }

    async function ensureChat() {
        if (state.current) return state.current;
        // with a preset, '' (Default) must stay: null would take the preset's model
        const r = await api('/api/v1/chat', { method: 'POST', body: { approvalMode: state.newApprovalMode, model: state.newModel || '', autoCompact: state.newAutoCompact, thinking: state.newThinking, preset: state.newPreset || undefined, temporary: state.newTemporary || undefined, project: state.project || undefined } });
        await select(r.chat.id);
        // the chat count beside the project
        if (r.chat.project) loadProjects();
        return state.current;
    }

    async function compact() {
        if (!state.current) return;
        if (state.current.status !== 'idle') {
            notify('Compacting works when the chat is idle: stop it or wait for the answer.', 'warning');
            return;
        }
        openContext(false);
        try {
            const r = await api(`/api/v1/chat/${state.current.id}/compact`, { method: 'POST' });
            if (r.chat && state.current?.id === r.chat.id) Object.assign(state.current, r.chat);
            renderContext();
            notify(r.message, 'success');
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            setStatus(state.current);
        }
    }

    /* ── Slash commands: "/" lists them with a description; arrow keys, Tab or Enter pick ── */

    const COMMANDS = [
        { name: 'compact', note: 'Summarize the conversation so far; earlier messages leave the context' },
        { name: 'mode', note: 'Approval mode: manual, edits or auto', args: () => APPROVAL_MODES.map(([v, , d]) => [v, d]) },
        { name: 'model', note: 'Text model of this chat', args: () => [['default', 'Settings › Text model'], ...state.models.map((m) => [m.name, `${m.gib} GiB`]), ...(state.remote ? [[REMOTE, modelName(REMOTE)]] : [])] },
        { name: 'thinking', note: 'How much the model thinks before it answers', args: () => THINKING_LEVELS.map(([v, n, d]) => [v, `${n} · ${d}`]) },
        { name: 'new', note: 'Start a new chat' },
        { name: 'stop', note: 'Stop the running answer' },
        { name: 'regenerate', note: 'Write the last answer again (the old one stays as the earlier version)' },
        { name: 'delete', note: 'Delete this chat (asks first)' },
        { name: 'help', note: 'List the commands' },
        { name: 'templates', note: 'Manage the prompt templates offered here' },
    ];
    const commandBox = el('div', { class: 'chat__commands', role: 'listbox', 'aria-label': 'Commands', hidden: true });
    composer.append(commandBox);
    let commandItems = [];
    let commandIndex = 0;

    /** Suggestions for the text in the box: commands for "/co", the arguments for "/mode a". */
    function commandSuggestions(value) {
        const m = /^\/(\S*)(?:\s+(\S*))?$/.exec(value);
        if (!m) return [];
        if (m[2] === undefined) {
            const start = m[1].toLowerCase();
            // the commands, then the prompt templates (user request 08.10.2026)
            return [
                ...COMMANDS.filter((c) => c.name.startsWith(start)).map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, note: c.note, more: Boolean(c.args) })),
                ...state.templates.filter((t) => t.name.toLowerCase().startsWith(start)).map((t) => ({ value: `/${t.name}`, label: `/${t.name}`, note: t.description || t.text.replace(/\s+/g, ' ').slice(0, 80), more: false, template: t })),
            ];
        }
        const c = COMMANDS.find((x) => x.name === m[1].toLowerCase());
        if (!c?.args) return [];
        return c.args().filter(([v]) => v.toLowerCase().startsWith(m[2].toLowerCase())).map(([v, d]) => ({ value: `/${c.name} ${v}`, label: v, note: d, more: false }));
    }

    function renderCommands() {
        commandItems = commandSuggestions(input.value);
        commandIndex = Math.min(commandIndex, Math.max(0, commandItems.length - 1));
        commandBox.hidden = !commandItems.length;
        commandBox.replaceChildren(...commandItems.map((s, i) => {
            // a template's description is the user's text: not translated
            const item = el('div', { class: `chat__command${s.template ? ' chat__command--template' : ''}`, role: 'option', 'aria-selected': String(i === commandIndex), 'data-command': s.value }, el('span', { class: 'chat__command-name', translate: 'no', text: s.label }), el('span', { class: 'chat__command-note', translate: s.template ? 'no' : null, text: s.note }));
            item.addEventListener('mousedown', (event) => {
                event.preventDefault();
                pickCommand(i, false);
            });
            return item;
        }));
    }

    /** Puts the suggestion into the box (Tab); Enter also runs it unless it still needs an argument. */
    function pickCommand(i, run) {
        const s = commandItems[i];
        if (!s) return;
        if (s.template) return useTemplate(s.template);
        input.value = s.more ? `${s.value} ` : s.value;
        commandIndex = 0;
        renderCommands();
        input.focus();
        if (run && !s.more) send();
    }

    /** Runs a slash command typed in the box; false if the text is not a command, 'keep' when it filled the box. */
    async function runCommand(text) {
        const m = /^\/([\p{L}\p{N}_-]+)(?:\s+(.+))?$/u.exec(text);
        if (!m) return false;
        const [, name, arg = ''] = m;
        const value = arg.trim();
        const template = !COMMANDS.some((c) => c.name === name) && !value ? state.templates.find((t) => t.name.toLowerCase() === name.toLowerCase()) : null;
        if (template) {
            useTemplate(template);
            return 'keep';
        }
        if (name === 'templates') openTemplates();
        else if (name === 'compact') await compact();
        else if (name === 'new') {
            state.newModel = '';
            select(null);
        } else if (name === 'stop') stopButton.click();
        else if (name === 'regenerate') {
            if (!state.current) notify('There is no answer to write again yet.', 'warning');
            else if (state.running) notify('The chat is running; regenerate the answer when it finishes (or stop it).', 'warning');
            else await regenerate();
        } else if (name === 'delete') {
            if (state.current) deleteButtons.find((b) => b.offsetParent)?.click();
        } else if (name === 'mode') {
            if (APPROVAL_MODES.some(([v]) => v === value)) chooseMode(value);
            else openOptions(true);
        } else if (name === 'model') {
            const found = value === 'default' ? { file: '' } : value === REMOTE && state.remote ? { file: REMOTE } : state.models.find((x) => x.name === value || x.file === value);
            if (found) chooseModel(found.file);
            else openOptions(true);
        } else if (name === 'thinking') {
            if (THINKING_LEVELS.some(([v]) => v === value)) chooseThinking(value);
            else openOptions(true);
        } else if (name === 'help') append(el('div', { class: 'message message--assistant' }, el('div', { class: 'message__bubble chat__help' }, ...COMMANDS.map((c) => el('div', {}, el('code', { text: `/${c.name}` }), ' ', el('span', { text: c.note }))))));
        else {
            notify(`Unknown command: /${name}`, 'warning');
            return true;
        }
        return true;
    }

    /*
     * ── Prompt templates (user request 08.10.2026): saved prompts offered under "/"; {{name}} in the text is a variable
     * asked for when one is picked. The filled text goes into the box (not sent: the user reads it first).
     */

    const VARIABLE = /\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g;

    async function loadTemplates() {
        try {
            state.templates = (await api('/api/v1/chat/templates')).templates ?? [];
        } catch {
            state.templates = [];
        }
    }

    // inside the message form: a box, not a form of its own (Enter in a field inserts)
    const templateBox = el('div', { class: 'chat__commands chat__template', 'data-template-form': true, role: 'dialog', 'aria-label': 'Fill in the template', hidden: true });
    composer.append(templateBox);

    function closeTemplateForm() {
        templateBox.hidden = true;
        templateBox.replaceChildren();
    }

    function fillComposer(text) {
        input.value = text;
        resizeInput();
        input.focus();
        input.setSelectionRange(text.length, text.length);
    }

    function useTemplate(t) {
        commandBox.hidden = true;
        const variables = t.variables ?? [];
        if (!variables.length) {
            closeTemplateForm();
            return fillComposer(t.text);
        }
        input.value = '';
        resizeInput();
        const fields = variables.map((name) => {
            const field = el('input', { class: 'input', 'data-template-variable': name, autocomplete: 'off', 'aria-label': name });
            return { name, field, row: el('label', { class: 'field' }, el('span', { class: 'field__label', translate: 'no', text: name }), field) };
        });
        const cancel = el('button', { type: 'button', class: 'btn btn--sm btn--ghost', text: 'Cancel' });
        cancel.addEventListener('click', () => {
            closeTemplateForm();
            input.focus();
        });
        const insert = el('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-template-insert': true, text: 'Insert' });
        insert.addEventListener('click', () => {
            const values = Object.fromEntries(fields.map((f) => [f.name, f.field.value]));
            closeTemplateForm();
            fillComposer(t.text.replace(VARIABLE, (all, name) => values[name] ?? all));
        });
        templateBox.replaceChildren(
            el('div', { class: 'chat__template-title' }, el('span', { class: 'chat__command-name', translate: 'no', text: `/${t.name}` }), el('span', { class: 'chat__command-note', text: 'Fill in the template' })),
            ...fields.map((f) => f.row),
            el('div', { class: 'row row--end' }, cancel, insert));
        // Enter: the next field, from the last one Insert; Escape closes (the message form is not sent)
        templateBox.onkeydown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                closeTemplateForm();
                input.focus();
            } else if (e.key === 'Enter' && e.target.matches('input') && !e.isComposing) {
                e.preventDefault();
                const i = fields.findIndex((f) => f.field === e.target);
                if (i < fields.length - 1) fields[i + 1].field.focus();
                else insert.click();
            }
        };
        templateBox.hidden = false;
        fields[0].field.focus();
    }

    let templateWindow = null;
    function openTemplates() {
        if (!templateWindow) templateWindow = buildTemplateWindow();
        templateWindow.show();
        window.openNdsWindow?.(templateWindow.modal);
    }

    /** The window that lists, adds, changes and deletes the templates (made the first time it opens). */
    function buildTemplateWindow() {
        const list = el('div', { class: 'preset-list', 'data-template-list': true });
        const field = (label, control, hint = null) => el('label', { class: 'field' }, el('span', { class: 'field__label', text: label }), control, hint ? el('span', { class: 'field__hint', text: hint }) : null);
        const name = el('input', { class: 'input', name: 'name', maxlength: 40, required: true, autocomplete: 'off', placeholder: 'e.g. bug' });
        const description = el('input', { class: 'input', name: 'description', maxlength: 120, autocomplete: 'off', placeholder: 'e.g. Find a bug in a file' });
        const text = el('textarea', { class: 'textarea', name: 'text', rows: 6, maxlength: 8000, required: true, placeholder: 'e.g. Find the bug in {{file}}. What happens: {{what happens}}' });
        const save = el('button', { type: 'submit', class: 'btn btn--primary btn--sm', 'data-template-save': true, text: 'Save template' });
        const fresh = el('button', { type: 'button', class: 'btn btn--sm', text: 'New template' });
        const heading = el('h3', { class: 'preset-form__title', 'data-template-form-title': true, text: 'New template' });
        const formBox = el('form', { class: 'stack', 'data-template-edit': true }, heading,
            field('Name', name, 'Typed after "/" in the message box: letters, digits, - or _.'),
            field('Description', description),
            field('Text', text, 'Write {{name}} where something should be filled in when the template is used.'),
            el('div', { class: 'row row--wrap' }, save, fresh));
        // Delete asks first and submits its own form (see the presets window)
        const remove = el('button', { type: 'submit', class: 'btn btn--sm btn--ghost', 'data-template-delete': true, 'data-confirm-title': 'Delete template', 'data-confirm-variant': 'danger', text: 'Delete template' });
        const removeForm = el('form', { class: 'row', hidden: true }, remove);
        let editing = null;
        const fill = (t) => {
            editing = t;
            heading.textContent = t ? 'Edit template' : 'New template';
            name.value = t?.name ?? '';
            description.value = t?.description ?? '';
            text.value = t?.text ?? '';
            removeForm.hidden = !t;
            if (t) remove.dataset.confirm = `Delete the template "/${t.name}"?`;
            for (const row of list.querySelectorAll('[data-template-id]')) row.classList.toggle('preset-list__item--current', row.dataset.templateId === t?.id);
        };
        const render = () => {
            list.replaceChildren(...(state.templates.length ? state.templates.map((t) => {
                const row = el('button', { type: 'button', class: 'preset-list__item', 'data-template-id': t.id },
                    el('span', { class: 'preset-list__name', translate: 'no', text: `/${t.name}` }),
                    el('span', { class: 'preset-list__note', translate: 'no', text: t.description || t.text.replace(/\s+/g, ' ').slice(0, 90) }));
                row.addEventListener('click', () => fill(t));
                return row;
            }) : [el('p', { class: 'text-sm text-muted', text: 'No templates yet. Fill in the form to add the first one.' })]));
        };
        fresh.addEventListener('click', () => {
            fill(null);
            name.focus();
        });
        formBox.addEventListener('submit', async (e) => {
            e.preventDefault();
            save.disabled = true;
            try {
                const body = { name: name.value, description: description.value, text: text.value };
                const r = await api(editing ? `/api/v1/chat/templates/${encodeURIComponent(editing.id)}` : '/api/v1/chat/templates', { method: editing ? 'PATCH' : 'POST', body });
                notify(r.message, 'success');
                await loadTemplates();
                render();
                fill(state.templates.find((t) => t.id === r.template.id) ?? null);
            } catch (err) {
                notify(err.message, 'danger');
            } finally {
                save.disabled = false;
            }
        });
        removeForm.addEventListener('submit', (e) => e.preventDefault());
        removeForm.submit = async () => {
            if (!editing) return;
            try {
                const r = await api(`/api/v1/chat/templates/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
                notify(r.message, 'success');
                await loadTemplates();
                render();
                fill(null);
            } catch (err) {
                notify(err.message, 'danger');
            }
        };
        const modal = el('div', { class: 'modal', 'data-modal': true, id: 'modal-prompt-templates', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'prompt-templates-title' },
            el('div', { class: 'modal__box modal__box--wide' },
                el('header', { class: 'modal__header' },
                    el('div', {}, el('h2', { class: 'modal__title', id: 'prompt-templates-title', text: 'Prompt templates' }),
                        el('p', { class: 'text-sm text-muted', text: 'Saved prompts: type "/" in the message box and pick one; its {{variables}} are asked for, then the text is in the box to send.' })),
                    el('button', { type: 'button', class: 'modal__close', 'data-modal-close': true, 'aria-label': 'Close', text: '×' })),
                el('div', { class: 'modal__body stack' }, list, formBox, removeForm)));
        document.body.append(modal);
        return {
            modal,
            show() {
                render();
                fill(null);
            },
        };
    }

    let sending = false;

    async function send() {
        // Enter during a slow first send (the button is disabled, the key is not) would send the message twice
        if (sending) return;
        sending = true;
        try {
            await sendNow();
        } finally {
            sending = false;
        }
    }

    async function sendNow() {
        const text = input.value.trim();
        if (text.startsWith('/') && !text.includes('\n')) {
            commandBox.hidden = true;
            const done = await runCommand(text);
            if (done) {
                // a prompt template filled the box: it stays for the user to read and send
                if (done !== 'keep') {
                    input.value = '';
                    resizeInput();
                }
                return;
            }
        }
        if (state.attachments.some((a) => a.uploading)) {
            notify('Wait until the attachments are uploaded.', 'warning');
            return;
        }
        const attachments = state.attachments.filter((a) => a.source).map((a) => ({ source: a.source, type: a.type, name: a.name }));
        if (!text && !attachments.length) return;
        // The agent is waiting for an answer to its question: the message is the answer
        if (state.current?.status === 'question' && state.current.question && text) {
            try {
                await api(`/api/v1/chat/${state.current.id}/answer`, { method: 'POST', body: { id: state.current.question.id, answer: text } });
                input.value = '';
                resizeInput();
            } catch (e) {
                notify(e.message, 'danger');
            }
            return;
        }
        sendButton.disabled = true;
        try {
            const chat = await ensureChat();
            await api(`/api/v1/chat/${chat.id}/message`, { method: 'POST', body: { text, attachments } });
            input.value = '';
            state.attachments = [];
            renderAttachments();
            resizeInput();
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            sendButton.disabled = false;
        }
    }

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        send();
    });
    input.addEventListener('keydown', (event) => {
        if (!commandBox.hidden && commandItems.length) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandItems.length) % commandItems.length;
                renderCommands();
                return;
            }
            if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing)) {
                event.preventDefault();
                pickCommand(commandIndex, event.key === 'Enter');
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                commandBox.hidden = true;
                return;
            }
        }
        // Enter sends; Shift+Enter (and Enter on phones) adds a new line
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) {
            event.preventDefault();
            send();
        }
    });
    input.addEventListener('input', () => {
        resizeInput();
        commandIndex = 0;
        renderCommands();
    });
    input.addEventListener('blur', () => setTimeout(() => {
        commandBox.hidden = true;
    }, 150));
    input.addEventListener('paste', (event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length) {
            event.preventDefault();
            addFiles(files);
        }
    });
    composer.addEventListener('dragover', (event) => {
        event.preventDefault();
        composer.classList.add('dragging');
    });
    composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
    composer.addEventListener('drop', (event) => {
        event.preventDefault();
        composer.classList.remove('dragging');
        addFiles([...(event.dataTransfer?.files ?? [])]);
    });
    $('[data-chat-attach]', section).addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => {
        addFiles([...attachInput.files]);
        attachInput.value = '';
    });
    stopButton.addEventListener('click', async () => {
        if (!state.current) return;
        try {
            const r = await api(`/api/v1/chat/${state.current.id}/stop`, { method: 'POST' });
            // what stopped with it in the background (sub-agents, commands, watchers…)
            if (r?.stopped?.length) notify(r.message, 'success');
        } catch (e) {
            notify(e.message, 'danger');
        }
    });
    const patch = async (body) => {
        if (!state.current) return;
        try {
            const r = await api(`/api/v1/chat/${state.current.id}`, { method: 'PATCH', body });
            Object.assign(state.current, r.chat);
        } catch (e) {
            notify(e.message, 'danger');
        }
        setStatus(state.current);
    };
    /*
     * ── The chat's menu (⋯ in its header; user request 08.10.2026): pin it above the others, archive it out of the list,
     * keep a temporary chat ──
     */

    function renderMenu() {
        const c = state.current;
        if (!c) return;
        const item = (action, text) => el('button', { type: 'button', class: 'chat__menu-item', role: 'menuitem', 'data-chat-menu-action': action, text });
        const items = c.temporary
            ? [item('keep', 'Keep this chat')]
            : [item('rename', 'Rename'), item(c.pinned ? 'unpin' : 'pin', c.pinned ? 'Unpin' : 'Pin to the top'), item(c.archived ? 'unarchive' : 'archive', c.archived ? 'Take out of the archive' : 'Archive')];
        // a file of the chat: Markdown to read, JSON to import again (here or on another Nedese Studio)
        items.push(el('div', { class: 'chat__menu-separator', role: 'separator' }), item('export-md', 'Export as Markdown'), item('export-json', 'Export as JSON'));
        menuPanel.replaceChildren(...items);
    }

    /** Downloads the open chat as a file (a fetch with the panel header: a phone on the network sends no Sec-Fetch-Site). */
    async function exportChat(format) {
        const c = state.current;
        if (!c) return;
        try {
            const r = await fetch(`/api/v1/chat/${encodeURIComponent(c.id)}/export?format=${format}`, { headers: { 'X-Panel': '1', 'X-Panel-Lang': 'en' } });
            if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Server error (HTTP ${r.status}).`);
            const header = r.headers.get('content-disposition') ?? '';
            const utf = /filename\*=UTF-8''([^;]+)/i.exec(header);
            const name = utf ? decodeURIComponent(utf[1]) : /filename="([^"]+)"/.exec(header)?.[1] ?? `chat.${format}`;
            const url = URL.createObjectURL(await r.blob());
            const a = el('a', { href: url, download: name, hidden: true, 'data-chat-export-link': format });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (e) {
            notify(e.message, 'danger');
        }
    }

    // Import: a chat exported as JSON becomes a new chat here (with the approval mode a new chat would get)
    importButton.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
        const file = importFile.files?.[0];
        importFile.value = '';
        if (!file) return;
        let data;
        try {
            data = JSON.parse(await file.text());
        } catch {
            notify('This file is not JSON: choose a chat exported as JSON.', 'danger');
            return;
        }
        try {
            const r = await api('/api/v1/chat/import', { method: 'POST', body: { data, approvalMode: state.newApprovalMode } });
            notify(r.message, 'success');
            listBox.classList.remove('open');
            state.archivedView = false;
            await loadList();
            await select(r.chat.id);
        } catch (e) {
            notify(e.message, 'danger');
        }
    });

    function openMenu(open) {
        if (!menuPanel || (open && !state.current)) return;
        if (open) renderMenu();
        menuPanel.hidden = !open;
        menuButton.setAttribute('aria-expanded', String(open));
        if (open) menuPanel.querySelector('button')?.focus();
    }

    const MENU_ACTIONS = {
        pin: [{ pinned: true }, 'Pinned to the top of the list.'],
        unpin: [{ pinned: false }, 'Unpinned.'],
        archive: [{ archived: true }, 'Archived: it is out of the list (Archived, under the list).'],
        unarchive: [{ archived: false }, 'Taken out of the archive.'],
        keep: [{ temporary: false }, 'Kept: this chat is saved now.'],
    };

    async function chatAction(action) {
        // the name field in place of the title (user request 09.10.2026: Rename in the chat's menu, no pencil by the title)
        if (action === 'rename') {
            openMenu(false);
            startRename();
            return;
        }
        if (action === 'export-md' || action === 'export-json') {
            openMenu(false);
            exportChat(action.slice(7));
            return;
        }
        const c = state.current;
        const [body, message] = MENU_ACTIONS[action] ?? [];
        if (!c || !body) return;
        openMenu(false);
        try {
            const r = await api(`/api/v1/chat/${encodeURIComponent(c.id)}`, { method: 'PATCH', body });
            if (state.current?.id === c.id) Object.assign(state.current, r.chat);
            notify(message, 'success');
            if (state.current?.id === c.id) setStatus(state.current);
            if (action === 'keep') {
                try {
                    localStorage.setItem('chat.current', c.id);
                } catch {
                    /* private mode */
                }
            }
            loadList();
        } catch (e) {
            notify(e.message, 'danger');
        }
    }

    menuButton.addEventListener('click', () => openMenu(menuPanel.hidden));
    menuPanel.addEventListener('click', (event) => {
        const b = event.target.closest('[data-chat-menu-action]');
        if (b) chatAction(b.dataset.chatMenuAction);
    });
    keepButton.addEventListener('click', () => chatAction('keep'));
    archivedButton.addEventListener('click', () => showArchive(true));
    // a temporary chat whose page closes is deleted too (keepalive: the request outlives the page)
    window.addEventListener('pagehide', () => {
        const c = state.current;
        if (c?.temporary) fetch(`/api/v1/chat/${encodeURIComponent(c.id)}?keepOutputs=1`, { method: 'DELETE', keepalive: true, headers: { 'X-Panel': '1' } }).catch(() => {});
    });

    // Options: per chat, changeable while it runs; before the first message they apply to the new chat
    optionsButton.addEventListener('click', () => openOptions(optionsPanel.hidden));
    contextButton.addEventListener('click', () => openContext(contextPanel.hidden));
    document.addEventListener('language-changed', () => renderContext());
    // Outside click closes the popovers. The path is taken at dispatch: opening redraws the label and choosing redraws
    // the panel, so the clicked element may already be detached (closest() then missed and the popover closed at once)
    const optionsBox = optionsButton.closest('.chat__options');
    const contextBox = contextButton.closest('.chat__options');
    const runningBox = runningButton.closest('.chat__running-box');
    const menuBox = menuButton.closest('.chat__menu-box');
    runningButton.addEventListener('click', () => openRunning(runningPanel.hidden));
    document.addEventListener('click', (event) => {
        const path = event.composedPath();
        if (!optionsPanel.hidden && !path.includes(optionsBox)) openOptions(false);
        if (!contextPanel.hidden && !path.includes(contextBox)) openContext(false);
        if (!runningPanel.hidden && !path.includes(runningBox)) openRunning(false);
        if (!menuPanel.hidden && !path.includes(menuBox)) openMenu(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!menuPanel.hidden) {
            openMenu(false);
            menuButton.focus();
        } else if (!runningPanel.hidden) {
            openRunning(false);
            runningButton.focus();
        } else if (!optionsPanel.hidden) {
            openOptions(false);
            optionsButton.focus();
        } else if (!contextPanel.hidden) {
            openContext(false);
            contextButton.focus();
        }
    });
    $('[data-chat-new]', section).addEventListener('click', () => {
        listBox.classList.remove('open');
        state.newModel = '';
        select(null);
        input.focus();
    });
    // Delete: the confirm dialog (design.js, data-confirm) calls form.submit() when confirmed
    const deleteChat = async (f) => {
        if (!state.current) return;
        const id = state.current.id;
        // the tick box of the dialog (design.js): what the chat produced is deleted only when it is ticked
        const keepOutputs = f?.dataset.confirmChecked !== '1';
        try {
            const r = await api(`/api/v1/chat/${encodeURIComponent(id)}${keepOutputs ? '?keepOutputs=1' : ''}`, { method: 'DELETE' });
            notify(r.message, 'success');
            state.chats = state.chats.filter((c) => c.id !== id);
            state.total = Math.max(0, state.total - 1);
            select(null);
        } catch (e) {
            notify(e.message, 'danger');
        }
    };
    for (const f of deleteForms) {
        f.submit = () => deleteChat(f);
        f.addEventListener('submit', (event) => event.preventDefault());
    }
    $('[data-chat-list-toggle]', section).addEventListener('click', () => listBox.classList.toggle('open'));

    moreButton.addEventListener('click', () => {
        state.expanded = !state.expanded;
        renderList();
        if (state.expanded) loadMore();
    });
    // Search opens from the magnifier; closing it clears the search and brings the latest chats back
    function showSearch(open) {
        searchInput.hidden = !open;
        searchToggle.setAttribute('aria-expanded', String(open));
        if (open) {
            listBox.classList.add('open');
            searchInput.focus();
        } else if (searchInput.value || state.query) {
            clearTimeout(searchTimer);
            searchInput.value = '';
            state.query = '';
            loadList();
        }
    }
    searchToggle.addEventListener('click', () => showSearch(searchInput.hidden));
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            showSearch(false);
            searchToggle.focus();
        }
    });
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.query = searchInput.value.trim();
            loadList();
        }, 250);
    });
    try {
        if (searchSort && localStorage.getItem('chat.searchSort') === 'relevance') searchSort.value = 'relevance';
    } catch {
        /* storage blocked: newest first */
    }
    searchSort?.addEventListener('change', () => {
        try {
            localStorage.setItem('chat.searchSort', searchSort.value);
        } catch {
            /* storage blocked: the choice lasts this visit */
        }
        if (state.query) loadList();
    });
    matchMedia('(max-width: 900px)').addEventListener('change', renderList);

    /*
     * ── Quote (user request 08.10.2026): text selected in an answer shows Quote beside it, which puts the selection into
     * the composer as a Markdown quote ("> …") after what is already written there ──
     */
    const quoteButton = el('button', { type: 'button', class: 'chat__quote', 'data-chat-quote': true, hidden: true, text: 'Quote' });
    document.body.append(quoteButton);
    let quoted = '';
    let quoteTimer = 0;

    function placeQuote() {
        const sel = window.getSelection();
        const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
        const node = text && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        const bubble = element?.closest('.message--assistant .message__bubble');
        if (!bubble || !messagesBox.contains(bubble) || !state.open) {
            quoteButton.hidden = true;
            return;
        }
        quoted = text;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        // a selection scrolled out of the messages has no button (it would sit over the header)
        const box = messagesBox.getBoundingClientRect();
        if (rect.bottom < box.top || rect.top > box.bottom) {
            quoteButton.hidden = true;
            return;
        }
        quoteButton.hidden = false;
        const w = quoteButton.offsetWidth;
        const h = quoteButton.offsetHeight;
        // under the selection (a phone shows its own menu above it); above it when there is no room below
        let top = rect.bottom + 8;
        if (top + h > innerHeight - 8) top = rect.top - h - 8;
        // a selection partly scrolled away: the button stays on the screen
        quoteButton.style.top = `${Math.round(Math.min(Math.max(8, top), innerHeight - h - 8))}px`;
        quoteButton.style.left = `${Math.round(Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), innerWidth - w - 8))}px`;
    }

    document.addEventListener('selectionchange', () => {
        clearTimeout(quoteTimer);
        quoteTimer = setTimeout(placeQuote, 120);
    });
    messagesBox.addEventListener('scroll', () => {
        quoteButton.hidden = true;
    }, { passive: true });
    // a press on the button keeps the selection (it would take the focus and clear it first)
    quoteButton.addEventListener('pointerdown', (e) => e.preventDefault());
    quoteButton.addEventListener('mousedown', (e) => e.preventDefault());
    quoteButton.addEventListener('click', () => {
        const block = quoted.split(/\r?\n/).map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
        const before = input.value.replace(/\s+$/, '');
        input.value = `${before ? `${before}\n\n` : ''}${block}\n\n`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        quoteButton.hidden = true;
        window.getSelection()?.removeAllRanges();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    });

    /* ── Section lifecycle ────────────────────────────────────────────── */

    document.addEventListener('nedese:section', async (event) => {
        const open = event.detail.section === 'chat';
        if (open === state.open) return;
        state.open = open;
        if (!open) {
            // Streams stay closed while the section is hidden (no work in the background for the page)
            state.listStream?.close();
            state.chatStream?.close();
            state.listStream = null;
            state.chatStream = null;
            if (speech.button) stopSpeaking();
            return;
        }
        await loadList();
        loadPresets();
        loadProjects();
        loadTemplates();
        loadKnowledge();
        streamList();
        let last = null;
        try {
            last = localStorage.getItem('chat.current');
        } catch {
            /* private mode */
        }
        const id = state.current?.id ?? last;
        await select(id, { quiet: true });
        if (!state.current) input.focus();
    });
})();
