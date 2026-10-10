/**
 * The image viewer (web/js/image-viewer.js) and the chat's video frame in a headless browser on a phone-sized page
 * (user reports 09.10.2026: "Videolarda ön gösterim yok?", "resme tıklayınca ayrı sayfada açma olmamalı, modal içinde
 * açılsın yakınlaştır falan yapabilsin kullanıcı").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPLOAD_FOLDER } from '../lib/settings.mjs';
import { SKIP, chatPage, wait } from './chat-page.mjs';

const transform = "(() => { const m = /translate\\((-?[\\d.]+)px, (-?[\\d.]+)px\\) scale\\(([\\d.]+)\\)/.exec(document.querySelector('.image-viewer__image')?.style.transform ?? ''); return m ? m.slice(1).map(Number) : null; })()";

test('image viewer (phone 402 px): a picture in an answer opens over the chat, not in a new tab; two fingers, a double tap and the wheel zoom, a finger drag moves it, Escape and × close it and only it; a video in an answer starts at its frame at 0.1 s (headless browser)', SKIP, async () => {
  const o = await chatPage({ width: 402, height: 860 });
  const { p, t, until } = o;
  try {
    // a 1200×800 picture drawn in the page, stored as an upload
    const data = await t.evaluate("(() => { const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d'); g.fillStyle = '#c63'; g.fillRect(0, 0, 1200, 800); g.fillStyle = '#fff'; g.fillRect(500, 300, 200, 200); return c.toDataURL('image/png').split(',')[1]; })()");
    const uploads = join(p.setting.outputRoot, UPLOAD_FOLDER);
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'viewer-test.png'), Buffer.from(data, 'base64'));
    await o.send('![ferry](/file/upload/viewer-test.png) and [clip](/file/upload/clip.mp4)');
    const picture = ".message--assistant:not(.message--live) a[data-image-viewer] img.message__media";
    assert.ok(await until(`document.querySelector('${picture}')?.complete && document.querySelector('${picture}').naturalWidth === 1200`), 'the picture is in the answer');
    assert.equal(await t.evaluate("document.querySelector('.message--assistant:not(.message--live) video.message__media')?.getAttribute('src')"), '/file/upload/clip.mp4#t=0.1', 'the video starts at its frame at 0.1 s');

    // a click opens the viewer over the chat: the link's own navigation (a new tab) does not happen
    await t.evaluate("window.prevented = null; addEventListener('click', (e) => { if (e.target.closest('a[data-image-viewer]')) window.prevented = e.defaultPrevented; }); true");
    const address = await t.evaluate('location.href');
    // the chat still moves down to its end after the picture loads: clicked where it rests
    const open = async () => {
      let last = '';
      for (let i = 0; i < 60; i++) {
        const now = await t.evaluate(`JSON.stringify(document.querySelector('${picture}').getBoundingClientRect())`);
        if (now === last) break;
        last = now;
        await wait(200);
      }
      await t.clickSelector(picture);
    };
    await open();
    assert.ok(await until("document.querySelector('.image-viewer')?.dataset.loading === 'false'", 5000), 'the viewer opens with the picture');
    assert.equal(await t.evaluate('window.prevented'), true, 'no new tab');
    assert.equal(await t.evaluate('location.href'), address);
    assert.equal(await t.evaluate("document.querySelector('.image-viewer__image').getAttribute('src')"), '/file/upload/viewer-test.png');
    assert.equal(await t.evaluate('document.documentElement.style.overflow'), 'hidden', 'the chat does not scroll under it');
    assert.equal(await t.evaluate("document.querySelector('.image-viewer a[download]').getAttribute('href').endsWith('/file/upload/viewer-test.png?download=1')"), true, 'download link');
    assert.deepEqual(await t.evaluate(transform), [0, 0, 1]);
    // the panel's one window (user 10.10.2026: "Bi tane genel modalımız olur onu kullanır herşey"): its name in the
    // header, Download and ×; no zoom buttons ("Bu üçünü kaldır")
    assert.deepEqual(await t.evaluate("[document.querySelector('.image-viewer').classList.contains('modal'), !!document.querySelector('.image-viewer > .modal__box > .modal__header'), document.querySelector('.image-viewer .modal__title').textContent, [...document.querySelectorAll('.image-viewer button')].map((b) => b.getAttribute('aria-label'))]"), [true, true, 'ferry', ['Close']]);

    // the picture fills the window's width at fit size (1200×800: two thirds of it high), the window inside the phone
    const box = await t.evaluate("(() => { const r = document.querySelector('.image-viewer__image').getBoundingClientRect(); const s = document.querySelector('.image-viewer__stage').getBoundingClientRect(); const w = document.querySelector('.image-viewer .modal__box').getBoundingClientRect(); return { w: r.width, h: r.height, sw: s.width, cx: s.left + s.width / 2, cy: s.top + s.height / 2, left: w.left, right: w.right, top: w.top }; })()");
    assert.ok(Math.abs(box.w - box.sw) < 2 && Math.abs(box.h - (box.w * 2) / 3) < 2 && box.left >= 0 && box.right <= 402 && box.top > 60, JSON.stringify(box));
    const { cx, cy } = box;

    // two fingers spread from 100 px to 300 px apart: about 3× around their middle
    const touch = (type, points) => t.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    await touch('touchStart', [[cx - 50, cy], [cx + 50, cy]]);
    for (let d = 60; d <= 150; d += 10) await touch('touchMove', [[cx - d, cy], [cx + d, cy]]);
    await touch('touchEnd', []);
    await wait(100);
    assert.ok(await t.evaluate(transform), `after the pinch: ${await t.evaluate("document.querySelector('.image-viewer__image')?.style.transform ?? 'closed'")}`);
    let [x, y, scale] = await t.evaluate(transform);
    assert.ok(scale > 2.8 && scale < 3.2, `pinch: ${scale}`);
    assert.ok(Math.abs(x) < 2 && Math.abs(y) < 2, 'zoomed around the middle of the fingers');

    // one finger drags the zoomed picture; it stops at the picture's edge
    await touch('touchStart', [[cx, cy]]);
    for (let d = 20; d <= 100; d += 20) await touch('touchMove', [[cx + d, cy + d]]);
    await touch('touchEnd', []);
    await wait(100);
    [x, y, scale] = await t.evaluate(transform);
    assert.ok(Math.abs(x - 100) < 2, `moved right: ${x}`);
    const maxY = (box.h * scale - (await t.evaluate("document.querySelector('.image-viewer__stage').getBoundingClientRect().height"))) / 2;
    assert.ok(y <= Math.max(0, maxY) + 1, `not dragged past the edge: ${y}`);

    // a double tap goes back to fit, another zooms to 2.5×
    const tap = async () => {
      await touch('touchStart', [[cx, cy]]);
      await touch('touchEnd', []);
    };
    await tap();
    await wait(60);
    await tap();
    await wait(100);
    assert.deepEqual(await t.evaluate(transform), [0, 0, 1], 'double tap: fit');
    await wait(400);
    await tap();
    await wait(60);
    await tap();
    await wait(100);
    assert.equal((await t.evaluate(transform))[2], 2.5, 'double tap: 2.5×');

    // the wheel zooms too, up to 8×; the − key zooms out
    for (let i = 0; i < 6; i++) await t.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -400 });
    await wait(100);
    assert.equal((await t.evaluate(transform))[2], 8, 'wheel: up to 8×');
    await t.evaluate("dispatchEvent(new KeyboardEvent('keydown', { key: '-' })), true");
    assert.ok(Math.abs((await t.evaluate(transform))[2] - 8 / 1.5) < 0.01, 'zoom out');

    // Escape closes the viewer and only the viewer: a window under it stays open
    await t.evaluate("openNdsWindow(document.querySelector('#modal-preview')), true");
    await t.evaluate("window.ndsImageViewer.open('/file/upload/viewer-test.png'), true");
    await t.key('Escape');
    assert.equal(await t.evaluate("document.querySelector('.image-viewer')"), null, 'Escape closed the viewer');
    assert.equal(await t.evaluate("document.querySelector('#modal-preview').hidden"), false, 'the window under it stays');
    await t.key('Escape');
    assert.equal(await t.evaluate("document.querySelector('#modal-preview').hidden"), true);
    // a picture opened from inside a window takes its place: one window on the screen, the window back on close
    await t.evaluate("openNdsWindow(document.querySelector('#modal-preview')), true");
    await t.evaluate("(() => { const a = document.createElement('a'); a.href = '/file/upload/viewer-test.png'; a.dataset.imageViewer = ''; a.id = 'in-window'; a.textContent = 'picture'; document.querySelector('[data-preview-body]').append(a); a.click(); return true; })()");
    assert.deepEqual(await t.evaluate("[!!document.querySelector('.image-viewer'), getComputedStyle(document.querySelector('#modal-preview')).visibility]"), [true, 'hidden']);
    await t.evaluate("document.querySelector('[data-image-viewer-close]').click(), true");
    assert.deepEqual(await t.evaluate("[document.querySelector('#modal-preview').hidden, getComputedStyle(document.querySelector('#modal-preview')).visibility]"), [false, 'visible']);
    await t.evaluate("document.querySelector('#in-window').remove(), ndsCloseWindow(document.querySelector('#modal-preview')), true");

    // × closes it; a tap outside the window closes it too; the chat scrolls again
    await open();
    assert.ok(await until("!!document.querySelector('.image-viewer')", 3000));
    await t.evaluate("document.querySelector('[data-image-viewer-close]').click(), true");
    assert.equal(await t.evaluate("document.querySelector('.image-viewer')"), null, '× closed it');
    await open();
    assert.ok(await until("document.querySelector('.image-viewer')?.dataset.loading === 'false'", 3000));
    // the tap's click does not fall through to the chat under the viewer once it closes
    await t.evaluate("window.leaked = []; document.addEventListener('click', (e) => { if (!e.target.closest('.image-viewer')) window.leaked.push(e.target.className || e.target.tagName); }, true); true");
    await touch('touchStart', [[cx, 40]]);
    await touch('touchEnd', []);
    await wait(700);
    assert.equal(await t.evaluate("document.querySelector('.image-viewer')"), null, 'a tap outside the window closed it');
    assert.deepEqual(await t.evaluate('window.leaked'), [], 'no click reached the chat');
    assert.equal(await t.evaluate('document.documentElement.style.overflow'), '');
    await o.shots('image-viewer');
    assert.deepEqual(o.errors.filter((e) => !e.includes('clip.mp4')), []);
  } finally {
    await o.close();
  }
});
