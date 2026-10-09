/**
 * Image viewer: a picture opens over the page instead of in a new tab, and can be zoomed and moved
 * (user request 09.10.2026: "resme tıklayınca ayrı sayfada açma olmamalı, modal içinde açılsın yakınlaştır").
 *
 * Classic script like modal.js. A link with [data-image-viewer] opens its href in the viewer; a click with a
 * modifier key or the middle button keeps the browser's own behaviour (new tab), and without the script the link
 * still opens the picture. window.ndsImageViewer.open(src, alt, opener) opens one from code.
 *
 * Zoom: the wheel (around the pointer), two fingers, a double click or double tap (fit ↔ 2.5×), the + / − buttons
 * and keys, 0 back to fit. Move: drag while zoomed. Close: ×, Escape, a click beside the picture at fit size.
 */
(() => {
    if (window.ndsImageViewer) return;

    const MAX = 8;
    const STEP = 1.5;
    const DOUBLE_TAP_MS = 300;

    let box = null;
    let stage = null;
    let img = null;
    let opener = null;
    let overflowBefore = '';
    let scale = 1;
    let x = 0;
    let y = 0;
    const pointers = new Map();
    let pinch = null; // { distance, middle } at the last two-finger move
    let drag = null; // { x, y, fromX, fromY, moved, onPicture }
    let lastTap = 0;
    let closeLater = null; // a tap beside the picture: closes on its click

    function button(label, text, action) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'image-viewer__button';
        b.textContent = text;
        b.title = label;
        b.setAttribute('aria-label', label);
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            action();
        });
        return b;
    }

    function apply() {
        // rounded: a float remainder (1e-13) would be written in exponent form
        const r = (v) => Math.round(v * 100) / 100;
        img.style.transform = `translate(${r(x)}px, ${r(y)}px) scale(${r(scale * 100) / 100})`;
        box.dataset.zoomed = scale > 1.01 ? 'true' : 'false';
    }

    // The picture covers the stage when larger and stays centred when smaller: it is never dragged out of sight
    function clamp() {
        const r = stage.getBoundingClientRect();
        const maxX = Math.max(0, (img.offsetWidth * scale - r.width) / 2);
        const maxY = Math.max(0, (img.offsetHeight * scale - r.height) / 2);
        x = Math.min(maxX, Math.max(-maxX, x));
        y = Math.min(maxY, Math.max(-maxY, y));
    }

    // Point relative to the stage centre, where the picture's centre rests at fit size
    function fromCentre(clientX, clientY) {
        const r = stage.getBoundingClientRect();
        return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
    }

    // The point under p stays under p: p = x + scale·u before and after
    function zoomAt(next, p = { x: 0, y: 0 }) {
        next = Math.min(MAX, Math.max(1, next));
        x = p.x - (next * (p.x - x)) / scale;
        y = p.y - (next * (p.y - y)) / scale;
        scale = next;
        clamp();
        apply();
    }

    function fit() {
        scale = 1;
        x = 0;
        y = 0;
        apply();
    }

    function onPointerDown(e) {
        if (e.button > 0) return;
        stage.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
            drag = null;
        } else if (pointers.size === 1) {
            drag = { x: e.clientX, y: e.clientY, fromX: x, fromY: y, moved: false, onPicture: e.target === img };
        }
    }

    function onPointerMove(e) {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size >= 2) {
            const [a, b] = [...pointers.values()];
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            x += middle.x - pinch.middle.x;
            y += middle.y - pinch.middle.y;
            if (pinch.distance > 0) zoomAt((scale * distance) / pinch.distance, fromCentre(middle.x, middle.y));
            else apply();
            pinch = { distance, middle };
            return;
        }
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
        if (scale > 1) {
            x = drag.fromX + dx;
            y = drag.fromY + dy;
            clamp();
            apply();
        }
    }

    function onPointerUp(e) {
        if (!pointers.delete(e.pointerId)) return;
        if (pointers.size < 2) pinch = null;
        if (pinch === null && pointers.size === 1) {
            // one finger stays after a pinch: it moves the picture from here, it is not a tap
            const [p] = [...pointers.values()];
            drag = { x: p.x, y: p.y, fromX: x, fromY: y, moved: true, onPicture: true };
            return;
        }
        if (!drag || pointers.size) return;
        const tap = !drag.moved && e.type === 'pointerup';
        const onPicture = drag.onPicture;
        drag = null;
        if (!tap) return;
        const now = Date.now();
        if (onPicture && now - lastTap < DOUBLE_TAP_MS) {
            lastTap = 0;
            if (scale > 1.01) fit();
            else zoomAt(2.5, fromCentre(e.clientX, e.clientY));
            return;
        }
        lastTap = onPicture ? now : 0;
        // A tap beside the picture closes on the click that follows it: closed at once, that click would land on
        // whatever is under the viewer in the chat. No click within half a second (a browser that sends none): close then.
        if (!onPicture && scale <= 1.01) {
            clearTimeout(closeLater);
            closeLater = setTimeout(close, 500);
        }
    }

    function onClick(e) {
        if (!closeLater) return;
        e.preventDefault();
        e.stopPropagation();
        close();
    }

    function onWheel(e) {
        e.preventDefault();
        zoomAt(scale * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002)), fromCentre(e.clientX, e.clientY));
    }

    function onKey(e) {
        if (!box) return;
        if (e.key === 'Escape') {
            // only the viewer closes, not the window under it (modal.js and the chat close theirs on Escape too)
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
        } else if (e.key === '+' || e.key === '=') zoomAt(scale * STEP);
        else if (e.key === '-') zoomAt(scale / STEP);
        else if (e.key === '0') fit();
    }

    function onResize() {
        if (!box) return;
        clamp();
        apply();
    }

    function downloadAddress(src) {
        try {
            const u = new URL(src, location.href);
            if (u.origin === location.origin && u.pathname.startsWith('/file/')) u.searchParams.set('download', '1');
            return u.href;
        } catch {
            return src;
        }
    }

    function build(src, alt) {
        box = document.createElement('div');
        box.className = 'image-viewer';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', alt || 'Image');
        box.dataset.imageViewerBox = '';

        stage = document.createElement('div');
        stage.className = 'image-viewer__stage';
        img = document.createElement('img');
        img.className = 'image-viewer__image';
        img.alt = alt || '';
        img.draggable = false;
        // a picture that arrives after the viewer closed (or after another one opened) changes nothing
        const own = box;
        img.addEventListener('load', () => {
            if (box !== own) return;
            box.dataset.loading = 'false';
            fit();
        });
        img.addEventListener('error', () => {
            if (box !== own) return;
            box.dataset.loading = 'false';
            note.hidden = false;
        });
        const note = document.createElement('p');
        note.className = 'image-viewer__note';
        note.textContent = 'Could not load the image.';
        note.hidden = true;
        stage.append(img, note);

        const download = document.createElement('a');
        download.className = 'image-viewer__button';
        download.href = downloadAddress(src);
        download.setAttribute('download', '');
        download.textContent = '↓';
        download.title = 'Download';
        download.setAttribute('aria-label', 'Download');
        download.addEventListener('click', (e) => e.stopPropagation());

        const close_ = button('Close', '×', close);
        close_.dataset.imageViewerClose = '';
        const bar = document.createElement('div');
        bar.className = 'image-viewer__bar';
        bar.append(
            button('Zoom out', '−', () => zoomAt(scale / STEP)),
            button('Fit to screen', '⤢', fit),
            button('Zoom in', '+', () => zoomAt(scale * STEP)),
            download,
            close_,
        );
        box.append(stage, bar);

        stage.addEventListener('pointerdown', onPointerDown);
        stage.addEventListener('pointermove', onPointerMove);
        stage.addEventListener('pointerup', onPointerUp);
        stage.addEventListener('pointercancel', onPointerUp);
        stage.addEventListener('wheel', onWheel, { passive: false });
        stage.addEventListener('click', onClick);
        box.dataset.loading = 'true';
        img.src = src;
        return close_;
    }

    function open(src, alt = '', from = null) {
        close();
        opener = from ?? document.activeElement;
        const closeButton = build(src, alt);
        document.body.append(box);
        overflowBefore = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        fit();
        closeButton.focus({ preventScroll: true });
    }

    function close() {
        clearTimeout(closeLater);
        closeLater = null;
        if (!box) return;
        box.remove();
        box = null;
        stage = null;
        img = null;
        pointers.clear();
        pinch = null;
        drag = null;
        lastTap = 0;
        document.documentElement.style.overflow = overflowBefore;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        opener = null;
    }

    document.addEventListener('click', (e) => {
        const link = e.target.closest?.('[data-image-viewer]');
        if (!link || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        const src = link.getAttribute('href') || link.dataset.imageViewer;
        if (!src) return;
        e.preventDefault();
        open(src, link.querySelector('img')?.alt ?? '', link);
    });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);

    window.ndsImageViewer = { open, close, isOpen: () => box !== null };
})();
