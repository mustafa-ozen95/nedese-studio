/**
 * Nedese Studio arayüzü.
 *
 * KLASİK BETİK (modül değil): tasarim.js ve pencere.js'ten sonra yüklenir, onların
 * sözleşmesini kullanır — tema (`data-theme-toggle`), bildirim (`NdsTasarim.bildir`),
 * pencere (`data-modal`, `ndsPencereAc`), onay (`data-confirm`).
 *
 * İşleri sunucu yürütür; sayfa yalnızca durumu okur (1,5 sn'de bir). Sekme kapansa da
 * kuyruk sürer, sayfa yeniden açılınca kaldığı yerden görünür. Form taslakları tarayıcıda
 * saklanır (yenilemede yazılanlar kaybolmasın).
 */
(function () {
    'use strict';

    /* ── Küçük yardımcılar ──────────────────────────────────────────────── */

    const $ = (s, k = document) => k.querySelector(s);
    const $$ = (s, k = document) => Array.from(k.querySelectorAll(s));

    function el(tag, oz = {}, ...children) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(oz)) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else e.setAttribute(k, v === true ? '' : String(v));
        }
        for (const c of children.flat()) {
            if (c === null || c === undefined || c === false) continue;
            e.append(c instanceof Node ? c : String(c));
        }
        return e;
    }

    const notify = (message, type = 'info') => window.NdsDesign?.notify(message, type);
    const number = (n, digit = 1) => Number(n).toLocaleString(window.NedeseLang?.local ?? 'en-US', { maximumFractionDigits: digit });

    function durationText(sec) {
        if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return '';
        const s = Math.round(sec);
        if (s < 60) return `${s} s`;
        const min = Math.floor(s / 60);
        if (min < 60) return `${min} min ${String(s % 60).padStart(2, '0')} s`;
        return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
    }

    function elapsed(iso) {
        if (!iso) return '';
        const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
        const iki = (n) => String(n).padStart(2, '0');
        return s >= 3600 ? `${Math.floor(s / 3600)}:${iki(Math.floor((s % 3600) / 60))}:${iki(s % 60)}` : `${iki(Math.floor(s / 60))}:${iki(s % 60)}`;
    }

    // A file field drawn by the panel (.file-pick): the names chosen, in the panel's language (the browser's own field
    // speaks the language of the system: "Dosyaları Seç" in an English recording, 09.10.2026); a file name is not translated
    function showFileNames(input) {
        const out = input.closest('.file-pick')?.querySelector('[data-file-names]');
        if (!out) return;
        const files = [...(input.files ?? [])];
        out.replaceChildren(files.length === 1 ? el('span', { translate: 'no', text: files[0].name }) : files.length ? `${files.length} files` : 'No file chosen');
    }
    document.addEventListener('change', (event) => {
        if (event.target.matches?.('.file-pick input[type="file"]')) showFileNames(event.target);
    });
    // form.reset() empties the fields without a change event
    document.addEventListener('reset', (event) => setTimeout(() => event.target.querySelectorAll?.('.file-pick input[type="file"]').forEach(showFileNames)));

    function dateText(iso) {
        if (!iso) return '';
        const t = new Date(iso);
        const iki = (n) => String(n).padStart(2, '0');
        return `${iki(t.getDate())}.${iki(t.getMonth() + 1)} ${iki(t.getHours())}:${iki(t.getMinutes())}`;
    }

    const TYPE_NAME = { image: 'Image', video: 'Video', voice: 'Voice', music: 'Music', film: 'Film', clone: 'My voice', edit: 'Edit image', song: 'Edit song', audioEdit: 'Edit audio', videoEdit: 'Edit video', model3d: '3D model', training: 'Model training', data: 'Data collection', describe: 'Image description' };
    // Is turu adi: once arayuzun bildigi (cevrilebilir), yoksa sunucunun gonderdigi, o da yoksa "İş".
    const typeName = (job) => TYPE_NAME[job?.type] ?? job?.typeName ?? 'Job';
    const STATUS_NAME = {
        waiting: ['gray', 'Queued'],
        running: ['blue', 'Running'],
        done: ['green', 'Done'],
        error: ['red', 'Error'],
        cancelled: ['yellow', 'Cancelled'],
        interrupted: ['orange', 'Interrupted'],
        paused: ['purple', 'Paused'],
    };
    // Yeniden kuyruga alinabilen durumlar; duraklatilan is "Devam ettir" ile surer.
    const RETRY_STATUSES = ['error', 'cancelled', 'interrupted', 'paused'];
    const retryButton = (job, button) => actionForm({ path: `/api/job/${job.id}/retry`, tag: job.status === 'paused' ? 'Resume' : 'Retry', button });
    const pauseButton = (job, button) => actionForm({ path: `/api/job/${job.id}/pause`, tag: 'Pause', title: 'Pause job', approval: 'Training will stop and the GPU and RAM will be freed. "Resume" continues from the last completed step (an unfinished step is redone).', button });
    const SECTIONS = ['chat', 'image', 'video', 'voice', 'music', 'edit', 'model3d', 'film', 'training', 'gallery', 'settings'];
    const SINGLE = ['image', 'video', 'voice', 'music', 'film', 'edit', 'model3d'];
    const SPEECH_RATE = 13; // Türkçe anlatım, karakter/sn (Chatterbox, cfg 0,5): tahmin için

    const status = {
        options: null,
        averages: {},
        section: null,
        galleryFilter: '',
        gallerySignature: '',
        galleryPage: 1,
        lastSignature: {},
        knownLast: null,
        videoSource: null,
        pickerTarget: null,
        pickerChoice: null,
        previewed: null,
        noServer: false,
    };

    async function api(path, { method = 'GET', body, raw, type } = {}) {
        // Sunucu Türkçe döner; çeviriyi dil.js yapar (X-Panel-Dil: tr).
        const headers = { Accept: 'application/json', 'X-Panel': '1', 'X-Panel-Lang': 'en' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (raw !== undefined) headers['Content-Type'] = type || 'application/octet-stream';
        let r;
        try {
            r = await fetch(path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : raw });
        } catch {
            throw new Error('Cannot reach the panel server: the panel.bat window may have been closed.');
        }
        let j = {};
        try {
            j = await r.json();
        } catch {
            /* gövdesiz yanıt */
        }
        if (r.status === 401 && j.code === 'login') {
            await requestLogin();
            return api(path, { method, body, raw, type });
        }
        if (!r.ok || j.ok === false) throw new Error(j.error || `Server error (HTTP ${r.status}).`);
        return j;
    }

    /* Ag istemcisi (ev agi, Tailscale): sunucu 401 "giris" dondurunce API anahtari bir kez istenir; sunucu
     * HttpOnly cerezle 90 gunluk oturum acar, sayfa yenilenir. Panelin calistigi bilgisayarda hic gorunmez. */
    let loginPending = null;
    function requestLogin() {
        loginPending ??= new Promise((ok) => {
            const overlay = el('div', { class: 'login-overlay', style: 'position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px' });
            const input = el('input', { type: 'password', class: 'input', placeholder: 'API key', autocomplete: 'current-password', 'aria-label': 'API key', translate: 'no' });
            const error = el('p', { class: 'text-sm', style: 'color:var(--color-red-fg)', hidden: true });
            const button = el('button', { type: 'submit', class: 'btn btn--primary', text: 'Sign in' });
            const form = el('form', { class: 'panel stack', style: 'max-width:400px;width:100%;padding:20px', novalidate: true },
                el('h2', { class: 'panel__title', text: 'Sign in to the panel' }),
                el('p', { class: 'text-sm text-muted', text: "This device is not the computer running the panel. Enter the panel's API key once (it is shown on the Settings page on the panel's own computer); the session stays open in this browser for 90 days." }),
                input, error, el('div', { class: 'form-actions' }, button));
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                button.disabled = true;
                error.hidden = true;
                try {
                    const y = await fetch('/api/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Panel': '1', 'X-Panel-Lang': 'en' }, body: JSON.stringify({ key: input.value.trim() }) });
                    const j = await y.json().catch(() => ({}));
                    if (!y.ok || j.ok === false) throw new Error(j.error || `HTTP ${y.status}`);
                    overlay.remove();
                    loginPending = null;
                    ok();
                    location.reload();
                } catch (e) {
                    error.textContent = e.message;
                    error.hidden = false;
                    button.disabled = false;
                }
            });
            overlay.append(form);
            document.body.append(overlay);
            input.focus();
        });
        return loginPending;
    }

    /* ── Onaylı işlem formları ──────────────────────────────────────────
     *
     * Durum değiştiren işlem (iptal, sil) bir FORMDUR ve `data-confirm` taşır: tasarim.js
     * onayı sorar, onaylanınca `form.submit()` çağırır. O çağrı burada yakalanır ve istek
     * fetch ile gider — sayfa yenilenmez, kuyruk ve taslaklar yerinde kalır. Form kendi
     * başına da gerçek bir POST'tur: sunucu düz gönderimi sonuç bildirimiyle panele yönlendirir.
     */
    function actionForm({ path, tag, approval, title, variant, button = 'btn btn--sm' }) {
        const form = el(
            'form',
            { method: 'post', action: path, 'data-api-form': true, 'data-confirm': approval, 'data-confirm-title': title, 'data-confirm-variant': variant },
            el('button', { type: 'submit', class: button, text: tag }),
        );
        form.submit = () => apiForm(form);
        return form;
    }

    async function apiForm(form) {
        const button = $('button', form);
        const path = new URL(form.action).pathname + new URL(form.action).search;
        const method = form.dataset.method || 'POST';
        if (button) button.disabled = true;
        let ok = false;
        try {
            const j = await api(path, { method });
            notify(j.message || 'Done.', 'success');
            ok = true;
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            if (button) button.disabled = false;
            pollStatus();
            if (path.startsWith('/api/voices/')) refreshVoices();
            if (status.section === 'gallery') loadGallery();
            if (path.startsWith('/api/v1/')) document.dispatchEvent(new CustomEvent('nedese:action', { detail: { path, ok } }));
            const isOpen = status.previewed && !$('#modal-preview').hidden;
            if (isOpen && ok && path.endsWith('/delete')) window.ndsCloseWindow?.($('#modal-preview'));
            else if (isOpen) previewRefresh();
        }
    }

    document.addEventListener('submit', (event) => {
        const form = event.target;
        if (form.matches('[data-api-form]')) {
            event.preventDefault();
            apiForm(form);
        }
    });

    /* ── Sections (address #image, #gallery/video …) ──────────────────────── */

    const queuePanel = el(
        'section',
        { class: 'panel', 'data-queue': true },
        el(
            'header',
            { class: 'panel__head' },
            el('div', {}, el('h2', { class: 'panel__title', text: 'Queue' }), el('p', { class: 'text-sm text-muted', text: 'GPU jobs run one at a time, in order.' })),
        ),
        el('div', { class: 'panel__body panel__body--flush', 'data-queue-list': true }),
    );

    // Phones: the section tabs row hides while scrolling down and comes back on scrolling up (user request 08.10.2026;
    // the rule is in layout.css under the narrow-screen media query, so wide screens are not affected).
    // Not in the chat: the rows going and coming pushed the chat's text up and down (user report 09.10.2026: "headerdaki
    // açılıp kapanma chatteki metni itiyor", then "itmesini kapat"), so there they always stay.
    (() => {
        const page = $('[data-page]');
        const bar = $('.topbar');
        if (!page || !bar) return;
        const lastOf = new WeakMap();
        let quietUntil = 0;
        document.addEventListener('scroll', (event) => {
            const box = event.target;
            if (box !== page || document.querySelector('[data-section="chat"]:not([hidden])')) return;
            const y = box.scrollTop;
            const last = lastOf.get(box) ?? y;
            // Hiding or showing the row resizes the page; near the bottom the browser then moves scrollTop by itself,
            // which looked like scrolling the other way and made the row flicker: those moves are ignored for a moment
            if (Date.now() < quietUntil) {
                lastOf.set(box, y);
                return;
            }
            if (Math.abs(y - last) < 16) {
                if (!lastOf.has(box)) lastOf.set(box, y);
                return;
            }
            const hide = y > last && y > 60;
            if (hide !== bar.classList.contains('topbar--scrolled')) {
                setBars(hide);
                quietUntil = Date.now() + 500;
            }
            lastOf.set(box, y);
        }, { passive: true, capture: true });

        /**
         * FLIP: animating the rows' height relaid the whole chat on every frame and stuttered while scrolling (user report
         * 08.10.2026: "kasma var gibi"). Now the row hides or shows at once (one layout), the page is put back where it was
         * with a transform and slides to its new place; the transform runs on the compositor.
         */
        const slide = (el, dy) => {
            if (!el || Math.abs(dy) < 1) return;
            el.style.transition = 'none';
            el.style.transform = `translateY(${dy}px)`;
            el.getBoundingClientRect();
            requestAnimationFrame(() => {
                el.style.transition = 'transform 0.3s ease-in-out';
                el.style.transform = '';
            });
            clearTimeout(el.slideTimer);
            el.slideTimer = setTimeout(() => {
                el.style.transition = '';
            }, 360);
        };
        function setBars(hide) {
            const pageTop = page.getBoundingClientRect().top;
            bar.classList.toggle('topbar--scrolled', hide);
            // the new place is measured before anything moves
            slide(page, pageTop - page.getBoundingClientRect().top);
        }
    })();

    function applyRoute() {
        const parts = decodeURIComponent(location.hash.replace(/^#/, '')).split('/');
        const [b, sub = ''] = parts;
        const section = SECTIONS.includes(b) ? b : 'image';
        const changed = section !== status.section;
        status.section = section;
        $$('[data-section]').forEach((s) => {
            s.hidden = s.dataset.section !== section;
        });
        // Görsel, Video, Ses, Müzik üst menüde tek 'Tekil' başlığında; alt sekmelerle seçilir.
        const single = SINGLE.includes(section);
        if (single) status.lastSingle = section;
        $$('[data-section-link]').forEach((a) => {
            if (a.dataset.sectionLink === (single ? 'single' : section)) a.setAttribute('aria-current', 'page');
            else a.removeAttribute('aria-current');
        });
        $('[data-single-link]').href = `#${status.lastSingle ?? 'image'}`;
        $('[data-single-tabs]').hidden = !single;
        $$('[data-sub-tab]').forEach((a) => {
            if (a.dataset.subTab === section) a.setAttribute('aria-current', 'page');
            else a.removeAttribute('aria-current');
        });
        const side = $(`[data-side="${section}"]`);
        if (side && section !== 'settings' && queuePanel.parentElement !== side) side.prepend(queuePanel);
        if (changed) $('[data-page]').scrollTop = 0;
        if (changed) $('.topbar')?.classList.remove('topbar--scrolled');
        if (changed) document.dispatchEvent(new CustomEvent('nedese:section', { detail: { section } }));
        // Training has two sub-tabs: Model training (#training) and Data collection (#training/data).
        if (section === 'training') {
            const tab = sub === 'data' ? 'data' : '';
            const root = $('[data-section="training"]');
            if (tab) root.dataset.trainingOpen = tab;
            else delete root.dataset.trainingOpen;
            $$('[data-training-tab]').forEach((a) => {
                if (a.dataset.trainingTab === tab) a.setAttribute('aria-current', 'page');
                else a.removeAttribute('aria-current');
            });
            if (status.trainingTab !== undefined && status.trainingTab !== tab) $('[data-page]').scrollTop = 0;
            status.trainingTab = tab;
        }
        const trainingTabName = section === 'training' ? $(`[data-training-tab="${status.trainingTab}"]`)?.textContent : null;
        const name = trainingTabName ?? ($(`[data-sub-tab="${section}"]`) ?? $(`[data-section-link="${section}"]`))?.textContent ?? '';
        document.title = `${name} · Nedese Studio`;
        if (section === 'gallery') {
            status.galleryFilter = ['image', 'video', 'voice', 'music', 'film', 'model3d', 'error'].includes(sub) ? sub : '';
            $$('[data-filter]').forEach((a) => {
                if (a.dataset.filter === status.galleryFilter) a.setAttribute('aria-current', 'page');
                else a.removeAttribute('aria-current');
            });
            if (status.galleryLastFilter !== status.galleryFilter) status.galleryPage = 1;
            status.galleryLastFilter = status.galleryFilter;
            // The previous render stays; data arrives in the background and is redrawn only if it changed (signature:
            // filter, page, jobs). Resetting it on every visit rebuilt every card, which looked like a page reload on iPhone.
            loadGallery();
        }
    }

    window.addEventListener('hashchange', applyRoute);

    /* ── Durum yoklama ──────────────────────────────────────────────────── */

    let polling = null;
    let pollingCounter = 0;

    // A page video recording this panel (its browser sets pageVideo in a profile of its own) leaves its own job out of
    // the queue and the gallery: the running card has no picture yet and showed as an empty card in the video.
    const RECORDING = (() => {
        try {
            return localStorage.getItem('pageVideo') === '1';
        } catch {
            return false;
        }
    })();
    const shown = (job) => !(RECORDING && job?.type === 'pageVideo');
    // and its gallery has only the outputs with a picture (a voice card is a bare player in a promo)
    const pictured = (job) => (job.outputs ?? []).some((o) => o.preview || o.type === 'image' || o.type === 'video');

    async function pollStatus() {
        clearTimeout(polling);
        const my = ++pollingCounter;
        let d = null;
        try {
            d = await api('/api/status');
            if (RECORDING) d = { ...d, active: shown(d.active) ? d.active : null, pending: d.pending.filter(shown), last: d.last.filter(shown) };
            if (status.noServer) notify('Reconnected to the panel server.', 'success');
            status.noServer = false;
            status.pollingError = 0;
        } catch (e) {
            // Tek kopukluk uyarı değil (iPhone'da indirme ya da uygulama değişimi istekleri keser):
            // art arda iki yoklama başarısızsa sunucu gerçekten yok sayılır.
            status.pollingError = (status.pollingError ?? 0) + 1;
            if (status.pollingError >= 2 && !status.noServer) notify(e.message, 'danger');
            if (status.pollingError >= 2) status.noServer = true;
            $('[data-status-comfy] .dot').className = 'dot dot--gray';
            $('[data-status-comfy-text]').textContent = 'No connection to the panel';
        }
        // Arada yeni bir yoklama başladıysa (işlemden sonra) ikinci döngü kurulmasın.
        if (my !== pollingCounter) return;
        if (d) {
            status.lastStatus = d;
            renderStatus(d);
        }
        // İş çalışırken ya da system penceresi açıkken sık yoklanır.
        const frequent = d && (d.active || d.pending.length || d.tasks?.length || !$('#modal-system').hidden);
        polling = setTimeout(pollStatus, document.hidden ? 10000 : frequent ? 1500 : 4000);
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) pollStatus();
    });

    function renderStatus(d) {
        parentBar(d);
        renderQueue(d);
        const averageSignature = JSON.stringify(d.averages ?? {});
        if (averageSignature !== status.averageSignature) {
            status.averageSignature = averageSignature;
            status.averages = d.averages ?? {};
            videoFields();
        }
        updateEstimates();
        finishedAnnounce(d);
        for (const type of Object.keys(TYPE_NAME)) renderLast(type, d.last.filter((job) => job.type === type).slice(0, 4));
        if (status.section === 'gallery' && d.version !== status.galleryVersion) {
            status.galleryVersion = d.version;
            loadGallery();
        }
        if (status.previewed && !$('#modal-preview').hidden) {
            const x = [d.active, ...d.pending, ...d.last].find((job) => job?.id === status.previewed);
            if (x && (x.status === 'running' || x.status !== status.previewedStatus)) previewRefresh();
        }
    }

    function parentBar(d) {
        const c = d.comfy;
        const [color, text, hint] = c.running
            ? ['green', c.queue ? `ComfyUI · ${c.queue} queued` : 'ComfyUI ready', `${c.address}`]
            : c.starting
                ? ['yellow', 'ComfyUI starting…', 'Opening in a separate window; this can take 1-2 minutes.']
                : ['red', 'ComfyUI off', 'Starts automatically when an image or video job arrives. Manual start / stop: Settings.'];
        $('[data-status-comfy] .dot').className = `dot dot--${color}`;
        $('[data-status-comfy-text]').textContent = text;
        $('[data-status-comfy]').title = hint;
        const point = $('[data-status-comfy-dot]');
        point.className = `dot dot--${color} system-mobile__dot`;
        point.closest('button').title = `System status · ${text}`;
        document.dispatchEvent(new CustomEvent('nedese:comfy', { detail: c }));
        const g = d.gpu;
        const gpu = $('[data-status-gpu]');
        gpu.textContent = g ? `GPU ${number(g.memoryUsedMb / 1024)}/${number(g.memoryTotalMb / 1024, 0)} GB · ${g.usagePercent}%` : 'GPU –';
        gpu.title = g ? `${g.name} · ${g.temperature} °C · memory ${g.memoryUsedMb} / ${g.memoryTotalMb} MB` : 'nvidia-smi did not respond';
        const ram = $('[data-status-ram]');
        ram.textContent = `RAM free ${number(d.ram.freeMb / 1024)} GB`;
        updateBadge(d.update);
        systemHistory(d);
        if (!$('#modal-system').hidden) {
            getSystemInfo(); // 3 sn'de bir: disk okuma/yazma, saat, takas
            renderSystem(d);
        }
    }

    /** Üst çubuk: yeni sürüm rozeti (son denetime göre; tıklayınca Ayarlar > Güncelleme). */
    function updateBadge(g) {
        const r = $('[data-top-update]');
        if (!r) return; // eski sayfa (önbellek)
        const show = Boolean(g && (g.fresh || g.applying));
        r.hidden = !show;
        if (!show) return;
        $('[data-top-update-text]', r).textContent = g.applying ? 'Updating…' : g.waiting ? 'Update queued' : 'Update available';
        r.title = g.applying
            ? 'Installing the new version; the panel will restart.'
            : g.waiting
                ? `New version: ${g.sha} (${g.message}). Queued: it will be installed when the running job finishes.`
                : `New version: ${g.sha} (${g.message}). You can install it from Settings > Updates.`;
    }

    $('[data-top-update]')?.addEventListener('click', (e) => {
        // Ayarlar zaten açıksa bölüm yüklüdür: doğrudan kaydır (değilse ayarlar.js yükleyince kaydırır)
        const k = $('[data-setting-update]');
        if (status.section !== 'settings' || !k || k.hidden) return;
        e.preventDefault();
        k.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.addEventListener('nedese:poll-status', () => pollStatus());
    // Ayarlar > İnce ayarlar değişince formların seçenekleri yenilenir (ör. 1080p video)
    document.addEventListener('nedese:refresh-options', () => loadOptions().catch((e) => notify(e.message, 'danger')));

    /* ── Sistem durumu penceresi: anlık değerler + son 3 dakikanın grafiği ── */

    const HISTORY_LENGTH = 120; // 1,5 sn'de bir → 3 dk
    const meterHistory = { gpu: [], vram: [], temperature: [], strength: [], cpu: [], ram: [], reading: [], writing: [], diskEnabled: [], swap: [], virtual: [] };
    let systemInfo = null;
    let systemInfoTime = 0;

    function systemHistory(d) {
        const g = d.gpu;
        const add = (name, v) => {
            meterHistory[name].push(Number.isFinite(v) ? v : null);
            if (meterHistory[name].length > HISTORY_LENGTH) meterHistory[name].shift();
        };
        add('gpu', g?.usagePercent);
        add('vram', g ? g.memoryUsedMb / 1024 : null);
        add('temperature', g?.temperature);
        add('strength', g?.strengthW);
        add('cpu', d.ram.cpuPercent);
        add('ram', (d.ram.totalMb - d.ram.freeMb) / 1024);
        const ay = systemInfo?.detail;
        add('reading', ay?.disk?.readingBps != null ? ay.disk.readingBps / 2 ** 20 : null);
        add('writing', ay?.disk?.writingBps != null ? ay.disk.writingBps / 2 ** 20 : null);
        add('diskEnabled', ay?.disk?.activityPercent);
        add('swap', ay?.ram?.swapMb != null ? ay.ram.swapMb / 1024 : null);
        add('virtual', ay?.ram?.commitByte ? ay.ram.commitByte / 2 ** 30 : null);
    }

    /**
     * Geçmiş grafiği: çekirdek çubuklarıyla aynı görünüm. Son 3 dakika 40 çubuğa toplanır
     * (her çubuk o aralığın en yükseği); en yeni sağda, boş aralık çizilmez.
     */
    const BAR = 40;
    function line(values, max, type = 'bar') {
        if (type === 'line') return lineSvg(values, max);
        const parent = Math.max(max ?? 0, ...values.filter((v) => v !== null), 1);
        const step = HISTORY_LENGTH / BAR;
        const startedAt = HISTORY_LENGTH - values.length;
        const bars = [];
        for (let i = 0; i < BAR; i++) {
            const slice = values.slice(Math.max(0, Math.round(i * step) - startedAt), Math.max(0, Math.round((i + 1) * step) - startedAt)).filter((v) => v !== null);
            const v = slice.length ? Math.max(...slice) : null;
            bars.push(el('span', { style: v === null ? 'visibility:hidden' : `--y:${Math.max(3, Math.min(100, (v / parent) * 100)).toFixed(1)}%` }));
        }
        return el('div', { class: 'system__bars', 'aria-hidden': 'true' }, ...bars);
    }

    /** Ekran kartı ölçüleri için çizgi grafik (SVG); boş ölçümler atlanır. */
    function lineSvg(values, max) {
        const width = 120;
        const height = 32;
        const parent = Math.max(max ?? 0, ...values.filter((v) => v !== null), 1);
        const points = values
            // En yeni ölçüm sağda; geçmiş doldukça çizgi sola doğru uzar.
            .map((v, i) => (v === null ? null : `${(((HISTORY_LENGTH - values.length + i) / (HISTORY_LENGTH - 1)) * width).toFixed(1)},${(height - (v / parent) * (height - 2) - 1).toFixed(1)}`))
            .filter(Boolean)
            .join(' ');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'system__line');
        svg.setAttribute('aria-hidden', 'true');
        const lineItem = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        lineItem.setAttribute('points', points);
        svg.append(lineItem);
        return svg;
    }

    function systemCard(title, value, sub, series, max, warning = false, chart = 'line') {
        return el('div', { class: `system__card${warning ? ' system__card--warning' : ''}` },
            el('div', { class: 'system__title', text: title }),
            el('div', { class: 'system__value mono', text: value }),
            sub ? el('div', { class: 'system__sub text-sm text-muted', text: sub }) : null,
            series ? line(series, max, chart) : null);
    }

    async function getSystemInfo() {
        if (Date.now() - systemInfoTime < 3000) return;
        systemInfoTime = Date.now();
        try {
            systemInfo = await api('/api/v1/system');
        } catch {
            /* disk bilgisi olmadan da çizilir */
        }
    }

    function renderSystem(d) {
        const g = d.gpu;
        const r = d.ram;
        const gb1 = (mb) => `${number(mb / 1024)} GB`;
        // "195 GB boş" + "Toplam 953 GB · %80 dolu": "195 / 953 GB boş" 953 boş gibi okunuyordu.
        const diskFree = (k) => (k?.freeByte != null ? `${number(k.freeByte / 2 ** 30, 0)} GB free` : '–');
        const diskTotal = (k) => (k?.totalByte ? `Total ${number(k.totalByte / 2 ** 30, 0)} GB · ${Math.round((1 - k.freeByte / k.totalByte) * 100)}% full` : '');
        const mDisk = systemInfo?.disk?.models;
        const cDisk = systemInfo?.disk?.outputs;
        const sameDisk = mDisk && cDisk && mDisk.totalByte === cDisk.totalByte && mDisk.freeByte === cDisk.freeByte;
        const cards = [];
        if (g) {
            // Ekran karti tek kart: ust satirda ad, altinda 4 olcu (her biri kendi grafigiyle).
            cards.push(el('div', { class: 'system__card system__card--wide' },
                el('div', { class: 'system__top' },
                    el('span', { class: 'system__name', text: 'GPU' }),
                    el('span', { class: 'system__sub text-sm text-muted', text: `${g.name}${g.hourMhz ? ` · ${g.hourMhz}/${g.hourMaxMhz} MHz` : ''}` })),
                el('div', { class: 'system__measures' },
                    systemCard('Load', `${g.usagePercent}%`, '', meterHistory.gpu, 100),
                    systemCard('Memory', `${gb1(g.memoryUsedMb)} / ${gb1(g.memoryTotalMb)}`, `${Math.round((g.memoryUsedMb / g.memoryTotalMb) * 100)}% full`, meterHistory.vram, g.memoryTotalMb / 1024),
                    systemCard('Temperature', `${g.temperature} °C`, g.fanPercent !== null ? `Fan ${g.fanPercent}%` : '', meterHistory.temperature, 100, g.temperature >= 83),
                    systemCard('Power', g.strengthW !== null ? `${number(g.strengthW, 0)} W` : '–', g.strengthLimitW ? `Limit ${number(g.strengthLimitW, 0)} W · ${g.performanceStatus ?? ''}` : '', meterHistory.strength, g.strengthLimitW ?? undefined))));
        } else {
            cards.push(systemCard('GPU', '–', 'nvidia-smi did not respond'));
        }
        const ay = systemInfo?.detail;
        const ghz = (mhz) => `${number(mhz / 1000, 2)} GHz`;
        const speed = (bps) => (bps >= 2 ** 20 ? `${number(bps / 2 ** 20, 1)} MB/s` : `${number(bps / 1024, 0)} KB/s`);
        const wideCard = (name, sub, ...measures) => el('div', { class: 'system__card system__card--wide' },
            el('div', { class: 'system__top' },
                el('span', { class: 'system__name', text: name }),
                sub ? el('span', { class: 'system__sub text-sm text-muted', text: sub }) : null),
            el('div', { class: 'system__measures' }, ...measures.filter(Boolean)));
        // Cekirdek basina yuk: dikey cubuklar (yuksekligi yuzde).
        const cores = r.corePercent?.length
            ? el('div', { class: 'system__card' },
                el('div', { class: 'system__title', text: 'Cores' }),
                el('div', { class: 'system__value mono', text: `Peak ${number(Math.max(...r.corePercent), 0)}%` }),
                el('div', { class: 'system__bars', 'aria-hidden': 'true' },
                    ...r.corePercent.map((y) => el('span', { style: `--y:${Math.min(100, Math.max(2, y))}%`, title: `${number(y, 0)}%` }))))
            : null;
        const cpuAlt = [r.cpuName, ay?.cpu?.core ? `${ay.cpu.core}/${ay.cpu.logical}` : null].filter(Boolean).join(' · ');
        const ramUsed = r.totalMb - r.freeMb;
        const ramAlt = ay?.ram?.modules ? `${ay.ram.modules} × ${number(ay.ram.moduleByte / 2 ** 30, 0)} GB${ay.ram.type ? ` ${ay.ram.type}` : ''}${ay.ram.mts ? ` · ${ay.ram.mts} MT/s` : ''}` : '';
        const isOpen = r.openStayingSec;
        const writeOpen = isOpen >= 86400 ? `${Math.floor(isOpen / 86400)} d ${Math.floor((isOpen % 86400) / 3600)} h` : `${Math.floor(isOpen / 3600)} h ${Math.floor((isOpen % 3600) / 60)} min`;
        cards.push(
            wideCard('CPU', cpuAlt,
                systemCard('Load', r.cpuPercent !== null && r.cpuPercent !== undefined ? `${number(r.cpuPercent, 0)}%` : '–', '', meterHistory.cpu, 100, r.cpuPercent >= 95, 'bar'),
                systemCard('Clock', ay?.cpu?.instantMhz ? ghz(ay.cpu.instantMhz) : '–', ay?.cpu?.baseMhz ? `Base ${ghz(ay.cpu.baseMhz)}` : ''),
                cores,
                systemCard('Processes', ay?.cpu?.proc ? String(ay.cpu.proc) : '–', [ay?.cpu?.l3Mb ? `L3 ${number(ay.cpu.l3Mb, 0)} MB` : '', `Up ${writeOpen}`].filter(Boolean).join(' · '))),
            wideCard('RAM', ramAlt,
                systemCard('Used', `${gb1(ramUsed)} / ${gb1(r.totalMb)}`, `${Math.round((ramUsed / r.totalMb) * 100)}% full`, meterHistory.ram, r.totalMb / 1024, r.freeMb < 2048),
                systemCard('Empty', gb1(r.freeMb), r.freeMb < 2048 ? 'Running low' : ''),
                systemCard('Virtual memory', ay?.ram?.commitByte ? `${gb1(ay.ram.commitByte / 2 ** 20)} / ${gb1(ay.ram.commitLimitByte / 2 ** 20)}` : '–', ay?.ram?.commitByte ? `${Math.round((ay.ram.commitByte / ay.ram.commitLimitByte) * 100)}% full (RAM + swap)` : '', meterHistory.virtual, ay?.ram?.commitLimitByte ? ay.ram.commitLimitByte / 2 ** 30 : undefined, ay?.ram?.commitByte / ay?.ram?.commitLimitByte > 0.9),
                systemCard('Swap', ay?.ram?.swapMb != null ? gb1(ay.ram.swapMb) : '–', ay?.ram?.swapSizeMb ? `Page file ${gb1(ay.ram.swapSizeMb)}` : '', meterHistory.swap, ay?.ram?.swapSizeMb ? ay.ram.swapSizeMb / 1024 : undefined)),
            wideCard('Disk', sameDisk ? 'Models and outputs on the same disk' : '',
                // Okuma ve yazma basta: telefonda (2 sutun) yan yana dursun.
                systemCard('Disk read', ay?.disk?.readingBps != null ? speed(ay.disk.readingBps) : '–', '', meterHistory.reading),
                systemCard('Disk write', ay?.disk?.writingBps != null ? speed(ay.disk.writingBps) : '–', '', meterHistory.writing),
                systemCard(sameDisk ? 'Free space' : 'Free space (models)', diskFree(mDisk), diskTotal(mDisk), null, undefined, mDisk?.freeByte != null && mDisk.freeByte < 25 * 2 ** 30),
                cDisk && !sameDisk ? systemCard('Free space (outputs)', diskFree(cDisk), diskTotal(cDisk)) : null,
                sameDisk ? systemCard('Activity', ay?.disk?.activityPercent != null ? `${number(ay.disk.activityPercent, 0)}%` : '–', 'Time the disk is busy', meterHistory.diskEnabled, 100) : null),
            systemCard('ComfyUI', d.comfy.running ? 'Ready' : d.comfy.starting ? 'Starting…' : 'Off', d.comfy.queue ? `${d.comfy.queue} jobs queued` : d.active ? 'A job is running' : 'Idle'),
        );
        $('[data-system]').replaceChildren(...cards.filter(Boolean));
        $('[data-system-sub]').textContent = `${d.machine}${g?.driver ? ` · driver ${g.driver}` : ''} · live values; charts show the last 3 minutes.`;
    }

    document.addEventListener('click', (event) => {
        if (!event.target.closest('[data-modal-open="modal-system"]')) return;
        systemInfoTime = 0;
        getSystemInfo().then(() => status.lastStatus && renderSystem(status.lastStatus));
        if (status.lastStatus) renderSystem(status.lastStatus);
    });

    /** Biten işi bildirim olarak söyler (sayfa açıkken; ilk yüklemede eskileri değil). */
    function finishedAnnounce(d) {
        const ids = new Set(d.last.map((job) => job.id));
        // the server's time of a job's end (the phone's clock may differ)
        const ended = (job) => Date.parse(job.end ?? job.start ?? job.creation) || 0;
        if (!status.knownLast) {
            status.knownLast = ids;
            // only jobs that end after this: deleting jobs brings older ones into the list, and a music job of the
            // morning was announced as just finished (user report 08.10.2026)
            status.announceAfter = Math.max(0, ...d.last.map(ended));
            return;
        }
        for (const job of d.last) {
            if (status.knownLast.has(job.id) || ended(job) <= status.announceAfter) continue;
            const name = `${typeName(job)} job`;
            if (job.status === 'done') notify(`${name} finished${job.duration ? ` (${durationText(job.duration)})` : ''}.`, 'success');
            else if (job.status === 'error') notify(`${name} failed: ${job.error ?? ''}`, 'danger');
            else if (job.status === 'cancelled') notify(`${name} was cancelled.`, 'warning');
            // Kendi sesim bitince yeni ses kütüphanede ve seçimlerde görünsün.
            if (job.type === 'clone') refreshVoices();
            // Model eğitimi bitince yeni model temel seçiminde ve listede görünsün.
            if (job.type === 'training' || job.type === 'data' || job.type === 'describe') document.dispatchEvent(new CustomEvent('nedese:training'));
        }
        status.knownLast = ids;
    }

    /* ── Kuyruk paneli (satırlar yerinde güncellenir: açık onay penceresi formunu kaybetmez) ── */

    function renderQueue(d) {
        const list = $('[data-queue-list]', queuePanel);
        // Duraklatilan isler de kuyrukta gorunur (Devam ettir); calisan isin model dosyalari Ayarlar'da "Sil"i kapatir
        const jobs = [d.active, ...d.pending, ...(d.last ?? []).filter((job) => job.status === 'paused')].filter(Boolean);
        // Yan gorevler (kuyruga girmeyen kisa isler: sahne yazari) en ustte, ilerlemesiyle
        const tasks = d.tasks ?? [];
        status.activeModelFiles = d.active?.modelFiles ?? [];
        const existing = new Map($$('[data-job]', list).map((s) => [s.dataset.job, s]));
        const existingTask = new Map($$('[data-task]', list).map((s) => [s.dataset.task, s]));
        if (!jobs.length && !tasks.length) {
            existing.forEach((s) => s.remove());
            existingTask.forEach((s) => s.remove());
            if (!$('.empty', list)) {
                list.append(
                    el('div', { class: 'empty' },
                        el('p', { class: 'empty__title', text: 'Queue is empty' }),
                        el('p', { class: 'empty__text', text: 'Added jobs run here in order and keep running even if you close the page.' })),
                );
            }
            return;
        }
        $('.empty', list)?.remove();
        tasks.forEach((g, i) => {
            const line = existingTask.get(g.id) ?? taskLine(g);
            existingTask.delete(g.id);
            updateTaskLine(line, g);
            if (list.children[i] !== line) list.insertBefore(line, list.children[i] ?? null);
        });
        existingTask.forEach((s) => s.remove());
        let pendingPosition = 0;
        jobs.forEach((job, i) => {
            let line = existing.get(job.id);
            if (!line) line = queueLine(job);
            existing.delete(job.id);
            if (job.status === 'waiting') pendingPosition += 1;
            updateQueueLine(line, job, pendingPosition);
            const place = tasks.length + i;
            if (list.children[place] !== line) list.insertBefore(line, list.children[place] ?? null);
        });
        existing.forEach((s) => s.remove());
    }

    const TASK_NAME = { 'write-scenes': 'Scene writer' };

    /** Yan gorev satiri (sahne yazari): kuyruga girmez, ekran kartini beklemez; Iptal sureci durdurur. */
    function taskLine(g) {
        return el(
            'div',
            { class: 'panel__block stack stack--tight', 'data-task': g.id },
            el('div', { class: 'row row--between' },
                el('span', { class: 'line-title truncate', 'data-field': 'title' }),
                el('span', { class: 'status' }, el('span', { class: 'dot' }), el('span', { 'data-field': 'status' }))),
            el('progress', { class: 'progress', max: '100', 'data-field': 'progress', 'aria-label': 'Progress' }),
            el('div', { class: 'row row--between text-sm text-muted' },
                el('span', { class: 'truncate', 'data-field': 'stage' }),
                el('span', { class: 'mono', 'data-field': 'duration' })),
            el('div', { class: 'job-actions' },
                actionForm({
                    path: `/api/task/${g.id}/cancel`,
                    tag: 'Cancel',
                    title: 'Cancel scene writing',
                    approval: 'Scene writing stops; written scenes are not added to the form.',
                    variant: 'danger',
                    button: 'btn btn--sm btn--danger',
                })),
        );
    }

    function updateTaskLine(line, g) {
        const write = (field, text) => {
            const e = $(`[data-field="${field}"]`, line);
            if (e.dataset.raw !== text) {
                e.dataset.raw = text;
                e.textContent = text;
            }
        };
        const title = $('[data-field="title"]', line);
        const rawTitle = `${g.type}|${g.summary?.title ?? ''}`;
        if (title.dataset.raw !== rawTitle) {
            title.dataset.raw = rawTitle;
            title.replaceChildren(`${TASK_NAME[g.type] ?? g.type} · `, el('span', { translate: 'no', title: g.summary?.title ?? '', text: g.summary?.title ?? '' }));
        }
        const [color, name] = STATUS_NAME.running ?? ['blue', 'Running'];
        $('.status .dot', line).className = `dot dot--${g.status === 'cancelled' ? 'gray' : color}`;
        write('status', g.status === 'cancelled' ? 'Cancelling' : name);
        const bar = $('[data-field="progress"]', line);
        const percent = Number(g.progress?.percent ?? 0);
        // Olcum yoksa belirsiz cubuk (deger yok): sahne yazari tek obekte ara ilerleme vermez
        if (percent > 0) {
            bar.value = percent;
            bar.title = `${number(percent, 0)}%`;
        } else {
            bar.removeAttribute('value');
        }
        write('stage', [g.progress?.stage, g.progress?.detail].filter(Boolean).join(' · '));
        line.dataset.start = g.start ?? '';
        write('duration', elapsed(g.start));
    }

    function queueLine(job) {
        return el(
            'div',
            { class: 'panel__block stack stack--tight', 'data-job': job.id },
            el('div', { class: 'row row--between' },
                el('span', { class: 'line-title truncate', 'data-field': 'title' }),
                el('span', { class: 'status', 'data-field': 'status' }, el('span', { class: 'dot' }), el('span', {}))),
            el('progress', { class: 'progress', max: '100', 'data-field': 'progress', 'aria-label': 'Progress' }),
            el('div', { class: 'row row--between text-sm text-muted' },
                el('span', { class: 'truncate', 'data-field': 'stage' }),
                el('span', { class: 'mono', 'data-field': 'duration' })),
            el('div', { class: 'job-actions' },
                el('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'data-preview': job.id, text: 'Details' }),
                Object.assign(pauseButton(job, 'btn btn--sm'), { hidden: true }),
                Object.assign(retryButton({ ...job, status: 'paused' }, 'btn btn--sm btn--primary'), { hidden: true }),
                actionForm({
                    path: `/api/job/${job.id}/cancel`,
                    tag: 'Cancel',
                    title: 'Cancel job',
                    approval: 'The job will be cancelled. The running step stops; intermediate files stay in the folder and "Retry" can queue the job again.',
                    variant: 'danger',
                    button: 'btn btn--sm btn--danger',
                })),
        );
    }

    function updateQueueLine(line, job, position) {
        const write = (field, text) => {
            const e = $(`[data-field="${field}"]`, line);
            // Ham metin saklanır: ekrandaki çevrilmiş olabilir (dil.js), her yoklamada yeniden yazılmasın.
            if (e.dataset.raw !== text) {
                e.dataset.raw = text;
                e.textContent = text;
            }
        };
        const title = $('[data-field="title"]', line);
        const rawTitle = `${job.type}|${job.summary?.title ?? ''}`;
        if (title.dataset.raw !== rawTitle) {
            title.dataset.raw = rawTitle;
            // Kullanıcının yazdığı istem çevrilmez (translate=no).
            title.replaceChildren(`${typeName(job)} · `, el('span', { translate: 'no', title: job.summary?.title ?? '', text: job.summary?.title ?? '' }));
        }
        const running = job.status === 'running';
        const pause = $('form[action$="/pause"]', line);
        if (pause) pause.hidden = !(running && job.pausable);
        const proceed = $('form[action$="/retry"]', line);
        if (proceed) proceed.hidden = job.status !== 'paused';
        const cancelForm = $('form[action$="/cancel"]', line);
        if (cancelForm) cancelForm.hidden = job.status === 'paused';
        const [color, name] = STATUS_NAME[job.status] ?? ['gray', job.status];
        $('[data-field="status"] .dot', line).className = `dot dot--${color}`;
        $('[data-field="status"] span:last-child', line).textContent = job.status === 'waiting' ? `${name} (${position}.)` : name;
        const bar = $('[data-field="progress"]', line);
        bar.hidden = !running;
        const percent = Number(job.progress?.percent ?? 0);
        if (running && percent > 0) {
            bar.value = percent;
            bar.title = `${number(percent, 0)}%`;
        } else {
            bar.removeAttribute('value');
        }
        const progress = job.progress ?? {};
        write('stage', running ? [progress.stage, progress.detail].filter(Boolean).join(' · ') : (job.summary?.detail ?? ''));
        line.dataset.start = running ? (job.start ?? '') : '';
        write('duration', running ? elapsed(job.start) : '');
    }

    setInterval(() => {
        $$('[data-job][data-start], [data-task][data-start]').forEach((s) => {
            if (s.dataset.start) $('[data-field="duration"]', s).textContent = elapsed(s.dataset.start);
        });
    }, 1000);

    /* ── Kartlar (galeri ve "son işler") ────────────────────────────────── */

    function mainOutput(job) {
        return job.outputs.find((c) => c.main) ?? job.outputs.find((c) => ['image', 'video', 'voice'].includes(c.type)) ?? null;
    }

    function mediaBox(job, ana) {
        if (ana && ana.type === 'voice') {
            return el('div', { class: 'media media--voice' }, el('audio', { controls: true, preload: 'none', src: ana.url }));
        }
        if (ana && (ana.type === 'image' || ana.type === 'video' || (ana.type === 'model' && ana.previewUrl))) {
            const images = job.outputs.filter((c) => c.type === 'image').length;
            const badge = job.type === 'model3d' ? '3D' : ana.type === 'video' ? `${number(ana.duration ?? 0)} s` : images > 1 ? `${images} images` : null;
            // a 3D card on screen: the viewer script (1 MB) loads while idle, so opening the model waits only for the model
            if (job.type === 'model3d') (window.requestIdleCallback ?? setTimeout)(() => loadModelViewer().catch(() => {}));
            return el(
                'button',
                { type: 'button', class: 'media', 'data-preview': job.id, 'aria-label': 'Preview' },
                el('img', { src: ana.previewUrl ?? ana.url, alt: '', loading: 'lazy' }),
                badge ? el('span', { class: 'media__badge', text: badge }) : null,
            );
        }
        const [color, name] = STATUS_NAME[job.status] ?? ['gray', job.status];
        return el('button', { type: 'button', class: 'media media--empty', 'data-preview': job.id, 'aria-label': 'Details' },
            el('span', { class: 'status' }, el('span', { class: `dot dot--${color}` }), name));
    }

    function operationButtons(job, ana) {
        const buttons = [];
        if (ana) buttons.push(el('a', { class: 'btn btn--sm', href: `${ana.url}?download=1`, download: true, target: '_blank', rel: 'noopener', text: 'Download' }));
        const image = job.outputs.find((c) => c.type === 'image');
        if (image && job.status === 'done') {
            buttons.push(el('button', { type: 'button', class: 'btn btn--sm', 'data-to-video': image.source, 'data-url': image.previewUrl ?? image.url, 'data-width': image.width, 'data-height': image.height, text: 'Send to video' }));
        }
        if (RETRY_STATUSES.includes(job.status)) buttons.push(retryButton(job, 'btn btn--sm'));
        if (!['waiting', 'running'].includes(job.status)) {
            buttons.push(actionForm({
                path: `/api/job/${job.id}/delete`,
                tag: 'Delete',
                title: 'Delete output',
                approval: `The ${typeName(job)} job and all its outputs will be permanently deleted (cannot be undone).`,
                variant: 'danger',
                button: 'btn btn--sm btn--ghost kart-sil',
            }));
        }
        return buttons;
    }

    function card(job) {
        const ana = mainOutput(job);
        const [color, name] = STATUS_NAME[job.status] ?? ['gray', job.status];
        const sub = [job.summary?.detail, job.duration ? durationText(job.duration) : null].filter(Boolean).join(' · ');
        return el(
            'article',
            { class: 'panel gallery-card', 'data-card': job.id },
            mediaBox(job, ana),
            el('div', { class: 'panel__body' },
                el('div', { class: 'row row--between' },
                    el('span', { class: 'status' }, el('span', { class: `dot dot--${color}` }), job.status === 'done' ? typeName(job) : `${typeName(job)} · ${name}`),
                    el('span', { class: 'code', text: dateText(job.creation) })),
                el('p', { class: 'gallery-card__title', translate: 'no', title: job.summary?.title ?? '', text: job.summary?.title || '—' }),
                el('p', { class: 'text-sm text-muted gallery-card__sub', title: sub, text: sub }),
                job.error ? el('p', { class: 'field__error gallery-card__error', title: job.error, text: job.error }) : null,
                el('div', { class: 'gallery-card__actions' }, ...operationButtons(job, ana))),
        );
    }

    function signature(jobs) {
        return jobs.map((job) => `${job.id}:${job.status}:${job.outputs.length}:${job.summary?.title ?? ''}`).join('|');
    }

    function renderLast(type, jobs) {
        const container = $(`[data-last="${type}"]`);
        if (!container) return;
        const i = signature(jobs);
        if (status.lastSignature[type] === i) return;
        status.lastSignature[type] = i;
        if (!jobs.length) {
            container.replaceChildren(el('p', { class: 'text-sm text-muted', text: 'Nothing yet.' }));
            return;
        }
        container.replaceChildren(...jobs.map(card));
    }

    function lastPanel(type, title) {
        return el(
            'section',
            { class: 'panel' },
            el('header', { class: 'panel__head' },
                el('div', {}, el('h2', { class: 'panel__title', text: title })),
                el('div', { class: 'panel__actions' }, el('a', { class: 'btn btn--ghost btn--sm', href: `#gallery/${type}`, text: 'Open in gallery' }))),
            el('div', { class: 'panel__body' }, el('div', { class: 'gallery gallery--narrow', 'data-last': type })),
        );
    }

    /* ── Galeri ─────────────────────────────────────────────────────────── */

    let galleryWaiting = false;

    /* ── Sayfalama (galeri, görsel seçici, ses kütüphanesi, indirmeler) ── */

    const PAGE_SIZE = 24;

    /** Sayfa numaraları: ilk, son, seçilinin iki yanı; aralar "…". */
    function pageNumbers(page, total) {
        const set = new Set([1, total, page - 1, page, page + 1].filter((n) => n >= 1 && n <= total));
        const ordered = [...set].sort((a, b) => a - b);
        const result = [];
        ordered.forEach((n, i) => {
            if (i && n - ordered[i - 1] > 1) result.push(null);
            result.push(n);
        });
        return result;
    }

    /** Pagination strip: the "1–24 / 230" summary, ‹ previous, the numbers, next ›. goTo(page) is called. */
    function pagination({ total, page, size, pageCount }, goTo) {
        if (!total || pageCount <= 1) return null;
        const first = (page - 1) * size + 1;
        const last = Math.min(total, page * size);
        const link = (n, text, extra = {}) => el('button', { type: 'button', class: 'pagination__link', ...extra, 'data-page-go': n, text: text });
        const nav = el('nav', { class: 'pagination', 'aria-label': 'Pages' },
            el('span', { class: 'pagination__summary', text: `${first}–${last} / ${total}` }),
            link(page - 1, '‹', { 'aria-label': 'Previous page', 'aria-disabled': page === 1 ? 'true' : null }),
            ...pageNumbers(page, pageCount).map((n) => (n === null ? el('span', { class: 'pagination__link', 'aria-hidden': 'true', text: '…' }) : link(n, String(n), { 'aria-current': n === page ? 'page' : null }))),
            link(page + 1, '›', { 'aria-label': 'Next page', 'aria-disabled': page === pageCount ? 'true' : null }));
        nav.addEventListener('click', (event) => {
            const d = event.target.closest('[data-page-go]');
            if (!d || d.getAttribute('aria-disabled') === 'true') return;
            goTo(Number(d.dataset.pageGo));
        });
        return nav;
    }

    /** Dizi için istemci tarafı sayfa dilimi. */
    function slice(list, page, size = PAGE_SIZE) {
        const pageCount = Math.max(1, Math.ceil(list.length / size));
        const s = Math.min(Math.max(1, page), pageCount);
        return { items: list.slice((s - 1) * size, s * size), total: list.length, page: s, size, pageCount };
    }

    async function loadGallery() {
        if (galleryWaiting) return;
        galleryWaiting = true;
        try {
            const s = status.galleryFilter;
            const q = new URLSearchParams({ page: String(status.galleryPage ?? 1), size: String(PAGE_SIZE) });
            if (s === 'error') q.set('status', 'unfinished');
            else if (s) q.set('type', s);
            status.galleryData = await api(`/api/v1/jobs?${q}`);
            if (RECORDING) {
                const jobs = status.galleryData.jobs.filter((job) => shown(job) && pictured(job));
                status.galleryData = { ...status.galleryData, total: status.galleryData.total - (status.galleryData.jobs.length - jobs.length), jobs };
            }
            status.galleryPage = status.galleryData.page;
            renderGallery();
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            galleryWaiting = false;
        }
    }

    function renderGallery() {
        const v = status.galleryData;
        if (!v) return;
        const i = `${status.galleryFilter}#${v.page}#${v.total}#${signature(v.jobs)}`;
        if (status.gallerySignature === i) return;
        status.gallerySignature = i;
        const container = $('[data-gallery]');
        const lane = $('[data-gallery-pagination]');
        if (!v.total) {
            container.replaceChildren(el('div', { class: 'empty' },
                el('p', { class: 'empty__title', text: 'No outputs here yet' }),
                el('p', { class: 'empty__text', text: 'Every generated image, video and voice-over is previewed and downloaded here.' })));
            lane.replaceChildren();
            return;
        }
        container.replaceChildren(...v.jobs.map(card));
        const nav = pagination(v, (n) => {
            status.galleryPage = n;
            $('[data-page]').scrollTop = 0;
            loadGallery();
        });
        lane.replaceChildren(...(nav ? [nav] : []));
    }

    /* ── Önizleme penceresi ─────────────────────────────────────────────── */

    const previewWindow = $('#modal-preview');

    document.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-preview]');
        if (!trigger) return;
        event.preventDefault();
        openPreview(trigger.dataset.preview);
    });

    async function openPreview(id) {
        status.previewed = id;
        try {
            const j = await api(`/api/job/${id}`);
            renderPreview(j.job, true);
            window.openNdsWindow?.(previewWindow);
        } catch (e) {
            notify(e.message, 'danger');
        }
    }

    async function previewRefresh() {
        if (!status.previewed) return;
        try {
            const j = await api(`/api/job/${status.previewed}`);
            renderPreview(j.job, false);
        } catch {
            /* silinmiş olabilir */
        }
    }

    // Pencere kapanınca oynayan media durur (pencere.js yalnızca gizler).
    new MutationObserver(() => {
        if (previewWindow.hidden) {
            $$('video, audio', previewWindow).forEach((m) => m.pause());
            status.previewed = null;
        }
    }).observe(previewWindow, { attributes: true, attributeFilter: ['hidden'] });

    const INPUT_NAMES = {
        prompt: 'Prompt', model: 'Model', ratio: 'Aspect ratio', width: 'Width', height: 'Height', step: 'Steps', seed: 'Seed', count: 'Count',
        source: 'Source image', duration: 'Duration', frame: 'Frames (per part)', part: 'Part', resolution: 'Resolution', smooth: 'Interpolation', fps: 'Frame rate (FPS)', colorPin: 'Color stabilization', keyFrame: 'Keyframes', idProtect: 'Identity protection', translate: 'Translate to English',
        text: 'Text', voice: 'Voice', spec: 'Voice description', recordName: 'Voice name', language: 'Language', speed: 'Speed', quality: 'Quality', exaggeration: 'Emotion', cfg: 'Reading pace',
        title: 'Title', imageModel: 'Image model', videoModel: 'Video model', subtitle: 'Subtitles', transition: 'Smooth transition', character: 'Same character',
        musicName: 'Music', musicLevel: 'Music volume',
        complete: 'Complete to full body', deleteBackPlan: 'Remove background', intro: 'Turntable video', time: 'Frame (seconds)',
        method: 'Method', base: 'Base model', size: 'Model size', epoch: 'Epochs', context: 'Context', quantization: 'Quantization', examplePrompt: 'Sample question',
        collection: 'Collection', max: 'At most', total: 'Image count',
        // every key a job type writes has a name: a 3D job's window showed "printHeight" (09.10.2026)
        lang: 'Language', name: 'Name', train: 'Training', instruction: 'Instruction', printHeight: 'Print height', from: 'From the web',
        style: 'Style', lyrics: 'Lyrics', bpm: 'Tempo (BPM)', strength: 'How much should it change?',
        priority: 'Production priority', lip: 'Lip sync', musicMode: 'Music', musicStyle: 'Music style', characterSource: 'Character source',
        field: 'Field', description: 'General description', imagePrompt: 'Image question', rank: 'LoRA size', trigger: 'Trigger word',
        topic: 'Topic', target: 'Target article count (topic; 0 unlimited)', durationMin: 'Time limit (min, 0 unlimited)', depth: 'In-site crawl depth',
        parallel: 'Sites in parallel', browser: 'Browser (Edge/Chrome)', extract: 'Extraction and labeling', media: 'Images, video, audio',
        minAccuracy: 'Min accuracy (1-5)', minQuality: 'Minimum quality (1-5)', minFit: 'Minimum topic fit (1-5)', minWord: 'Minimum words',
        hopSites: 'Hop from site to site (links on on-topic pages)', manager: 'Let the model manage (site choice, new directions)',
        translationPairs: 'Translation pairs (hreflang)', documents: 'PDF/Office documents', wpApi: 'WordPress API',
        maskPersonalData: 'Mask personal data', commonCrawl: 'Common Crawl archive', onlyNew: 'Only new since the last run', qualityRules: 'Quality rules',
        mediaMaxMb: 'Largest media file (MB)', mediaTotalGb: 'Media in total (GB)', sitePerPage: 'Pages per site', oldestDate: 'Oldest date',
        serviceLimit: 'Searches per service', mcpCalls: 'MCP calls per run',
        url: 'Address', panel: 'Panel page', theme: 'Theme', cursor: 'Cursor', captionPosition: 'Caption position', captionChosen: 'Captions picked', endTitle: 'Closing title',
    };
    // Choices shown by the name the form gives them
    const INPUT_CHOICES = {
        strength: { little: 'Little', medium: 'Medium', much: 'A lot' },
        priority: { quality: 'Quality (recommended)', speed: 'Speed: fewer parts', draft: 'Draft: 480p, fastest' },
        musicMode: { none: 'None', generate: 'Generate', gallery: 'From gallery', load: 'Upload' },
        field: { text: 'Text', code: 'Code (software)', image: 'Image (LoRA: style, product, character)', music: 'Music (LoRA: style, vocals, instruments)', video: 'Video (LoRA: motion, style, character)', general: 'General (image + text, all in one)' },
        browser: { automatic: 'When needed (script-heavy pages)', always: 'On every page', agent: 'Agent: the model clicks (read more etc.)', closed: 'Off' },
        extract: { model: 'Local model (quality, accuracy, category, tags)', rule: 'Rules (no model needed, rougher)' },
        media: { meta: 'Metadata (address, alt text, caption)', download: 'Metadata + download files (until 10 GB of disk is left free)', none: 'Do not collect' },
        captionPosition: { bottom: 'Bottom', top: 'Top' },
        theme: { dark: 'Dark', light: 'Light' },
    };

    /** Ayrıntı penceresinde kimlik yerine ad: wan14 → "Wan 2.2 A14B (en iyi)", tr → Türkçe. */
    function inputValue(job, k, v) {
        const s = status.options;
        if (typeof v === 'boolean') return v ? 'Yes' : 'No';
        // a gallery file by the name of its job
        if (typeof v === 'string' && job.sources?.[v]?.title) return job.sources[v].title;
        if (k === 'voice') return job.voiceName ?? (v === 'model' ? "Model's default voice" : v);
        if ((k === 'model' && job.type === 'image') || k === 'imageModel') return s?.imageModels.find((m) => m.id === v)?.name ?? v;
        if ((k === 'model' && job.type === 'video') || k === 'videoModel') return s?.videoModels.find((m) => m.id === v)?.name ?? v;
        if (k === 'quality' && job.type === 'model3d') return { fast: 'Fast', high: 'High' }[v] ?? v;
        if (k === 'quality') return s?.quality?.[v] ?? v;
        if (k === 'lang' || k === 'language') return { tr: 'Turkish', en: 'English' }[v] ?? v;
        if (k === 'printHeight') return `${v} mm`;
        if (INPUT_CHOICES[k]?.[v]) return INPUT_CHOICES[k][v];
        if (k === 'smooth') return Number(v) > 1 ? `${v}× interpolation` : 'Off';
        if (k === 'duration' && job.type === 'video') return durationText(v);
        if (k === 'speed') return `${number(v, 2)}×`;
        if (k === 'ratio' && v === 'custom') return 'Custom';
        if (k === 'musicLevel') return { low: 'Low', medium: 'Medium', high: 'High' }[v] ?? v;
        if (k === 'method' && job.type === 'training') return { fine: 'Improve an existing model (fine-tune)', scratch: 'From scratch' }[v] ?? v;
        if (k === 'ratio' && job.type === 'training') return Number(v) ? String(v) : 'Automatic';
        return v;
    }

    let modelViewerLoaded = null;
    function loadModelViewer() {
        modelViewerLoaded ??= new Promise((ok, red) => {
            const b = document.createElement('script');
            b.type = 'module';
            b.src = './js/model-viewer.min.js';
            b.onload = ok;
            b.onerror = () => {
                modelViewerLoaded = null;
                red(new Error('Could not load the 3D viewer.'));
            };
            document.head.append(b);
        });
        return modelViewerLoaded;
    }

    /**
     * A 3D model turned by hand: drag = turn, wheel / two fingers = zoom, right-drag = pan. A big GLB (a million
     * triangles, 60+ MB) takes seconds and the box stood empty: until the model has loaded, its source image shows
     * dimmed under a progress bar and fades out. It is not the viewer's poster: the Blender frame is framed differently
     * and jumped when the model came.
     */
    function modelViewer(glb, job) {
        const mv = el('model-viewer', {
            class: 'model-viewer', src: glb.url, alt: job.summary?.title || '3D model',
            'camera-controls': '', 'touch-action': 'none', 'shadow-intensity': '1', 'environment-image': 'neutral', exposure: '1', 'interaction-prompt': 'none',
        });
        const bar = el('progress', { class: 'progress', max: '1' });
        const loading = el('div', { class: 'model-viewer__loading', 'data-model-loading': '' },
            glb.previewUrl ? el('img', { src: glb.previewUrl, alt: '' }) : null,
            el('div', { class: 'model-viewer__loading-text stack stack--tight' }, el('span', { text: 'Loading the 3D model…' }), bar));
        const container = el('div', { class: 'stack stack--tight' }, el('div', { class: 'model-viewer__stage' }, mv, loading),
            el('p', { class: 'text-sm text-muted', text: 'Drag to rotate; zoom with the wheel or two fingers; pan with right-drag or a two-finger drag.' }));
        const failed = (message) => {
            loading.remove();
            container.append(el('p', { class: 'field__error', text: message }));
        };
        mv.addEventListener('progress', (e) => { bar.value = e.detail?.totalProgress ?? 0; });
        mv.addEventListener('load', () => loading.classList.add('is-done'), { once: true });
        mv.addEventListener('error', () => failed('Could not load the 3D model.'), { once: true });
        loadModelViewer().catch((e) => failed(e.message));
        return container;
    }

    /** Kayıp değerlerinden küçük çizgi grafik (SVG); düşüyorsa model öğreniyor demektir. */
    function lossCurve(losses) {
        const width = 320, height = 64, k = losses.filter(Number.isFinite);
        if (k.length < 2) return null;
        const az = Math.min(...k), cok = Math.max(...k), diff = cok - az || 1;
        const points = k.map((v, i) => `${(i / (k.length - 1)) * width},${height - 4 - ((v - az) / diff) * (height - 8)}`).join(' ');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('class', 'loss-curve');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `Training loss ${number(k[0], 2)} → ${number(k.at(-1), 2)}`);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('points', points);
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', 'currentColor');
        line.setAttribute('stroke-width', '2');
        svg.append(line);
        return el('div', { class: 'stack stack--tight' }, el('span', { class: 'text-sm text-muted', text: `Training loss: ${number(k[0], 3)} → ${number(k.at(-1), 3)}` }), svg);
    }

    function trainingResult(c) {
        const button = el('button', { type: 'button', class: 'btn btn--sm btn--primary', text: 'Use as text model' });
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                const j = await api('/api/v1/settings', { method: 'PATCH', body: { textModel: c.gguf } });
                notify(`${j.message}. Chat, prompt translations and bots now use this model.`, 'success');
            } catch (e) {
                notify(e.message, 'danger');
            } finally {
                button.disabled = false;
            }
        });
        return el('div', { class: 'stack' },
            lines([
                ['Text model', c.gguf, true],
                ['Training steps', c.step],
                ['Duration', c.durationSec ? durationText(c.durationSec) : null],
                ['Final loss', c.lastLoss !== null && c.lastLoss !== undefined ? number(c.lastLoss, 3) : null],
                ['Validation loss', c.validationLoss !== null && c.validationLoss !== undefined ? number(c.validationLoss, 3) : null],
                ['Parameter', c.param ? `${number(c.param / 1e6, 0)} million` : null],
            ]),
            lossCurve(c.losses ?? []),
            ...(c.examples ?? []).map((o) => el('div', { class: 'stack stack--tight' },
                el('p', { class: 'text-sm' }, el('strong', { text: 'Question: ' }), el('span', { translate: 'no', text: o.prompt })),
                el('p', { class: 'text-sm training-response', translate: 'no', text: o.response || '(empty answer)' }))),
            el('div', { class: 'row row--wrap' }, button, el('a', { class: 'btn btn--sm', href: '#chat', text: 'Try in Chat' })));
    }

    /** [etiket, değer, çevrilmesin?] satırları; kullanıcının yazdığı değerler (istem, metin) çevrilmez. */
    function lines(pair) {
        return el('div', { class: 'facts' }, ...pair.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v, raw]) =>
            el('div', { class: 'facts__row' }, el('span', { class: 'facts__key', text: k }), el('span', { class: 'facts__value', translate: raw ? 'no' : null, text: String(v) }))));
    }

    /** The window's title becomes a field; the new name goes to PATCH /jobs/{id} and shows on every card of the job. */
    function renameForm(job) {
        const input = el('input', { class: 'input', name: 'title', maxlength: 120, value: job.summary?.title ?? '', 'aria-label': 'New name' });
        const form = el('form', { class: 'row', 'data-rename-form': true }, input, el('button', { type: 'submit', class: 'btn btn--primary btn--sm', text: 'Save' }));
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = input.value.trim();
            if (!title) return;
            try {
                const j = await api(`/api/v1/jobs/${encodeURIComponent(job.id)}`, { method: 'PATCH', body: { title } });
                job.summary = j.job.summary;
                $('#preview-title').replaceChildren(`${typeName(job)} · `, el('span', { translate: 'no', text: job.summary.title }));
                notify(j.message, 'success');
            } catch (err) {
                notify(err.message, 'error');
            }
        });
        $('#preview-title').replaceChildren(form);
        input.focus();
        input.select();
    }

    function renderPreview(job, ilk) {
        const body = $('[data-preview-body]', previewWindow);
        const [, name] = STATUS_NAME[job.status] ?? ['gray', job.status];
        // a name being written stays while a running job's window refreshes
        if (!$('[data-rename-form]', previewWindow)) $('#preview-title').replaceChildren(`${typeName(job)} · `, el('span', { translate: 'no', text: job.summary?.title ?? '' }));
        $('[data-preview-sub]', previewWindow).textContent = [name, dateText(job.creation), job.duration ? durationText(job.duration) : null, job.summary?.detail].filter(Boolean).join(' · ');

        // Çalışan işte yalnızca günlük ve ilerleme tazelenir (pencere baştan çizilmez).
        const logBox = $('[data-preview-log]', body);
        const previousStatus = status.previewedStatus;
        status.previewedStatus = job.status;
        if (!ilk && logBox && job.status === 'running' && previousStatus === 'running') {
            const i = job.progress ?? {};
            const bar = $('[data-preview-progress] progress', body);
            if (bar && i.percent > 0) bar.value = i.percent;
            const text = $('[data-preview-progress] p', body);
            if (text) text.textContent = [i.stage, i.detail].filter(Boolean).join(' · ');
            const below = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 24;
            logBox.textContent = (job.log ?? []).join('\n');
            if (below) logBox.scrollTop = logBox.scrollHeight;
            return;
        }

        const parts = [];
        if (job.error) parts.push(el('div', { class: 'alert alert--danger' }, el('span', { text: job.error })));
        if (job.status === 'running') {
            const i = job.progress ?? {};
            parts.push(el('div', { class: 'stack stack--tight', 'data-preview-progress': true },
                el('progress', { class: 'progress', max: '100', value: i.percent > 0 ? String(i.percent) : null }),
                el('p', { class: 'text-sm text-muted', text: [i.stage, i.detail].filter(Boolean).join(' · ') })));
        }

        const media = el('div', { class: 'preview-media' });
        const glbOutput = job.outputs.find((c) => c.type === 'model' && c.format === 'glb');
        if (glbOutput) media.append(modelViewer(glbOutput, job));
        for (const c of job.outputs) {
            if (glbOutput && c.type === 'video') continue;
            if (c.type === 'image') {
                media.append(
                    el('a', { href: c.url, target: '_blank', rel: 'noopener', title: 'Open full size', 'data-image-viewer': true }, el('img', { src: c.url, alt: '' })),
                    el('div', { class: 'row row--between row--wrap' },
                        // Olmayan bilgi yazilmaz (veri toplamanin tarayici ekran goruntusunde boyut / tohum yok, adres var)
                        el('span', { class: 'code', translate: 'no', text: [c.file, c.name, c.width && c.height ? `${c.width}×${c.height}` : null, c.seed !== undefined && c.seed !== null ? `seed ${c.seed}` : null].filter(Boolean).join(' · ') }),
                        el('span', { class: 'row' },
                            el('a', { class: 'btn btn--sm', href: `${c.url}?download=1`, download: true, target: '_blank', rel: 'noopener', text: 'Download' }),
                            // Videoya aktarma yalniz uretilmis / duzenlenmis gorselde (ekran goruntusunde degil)
                            c.width && c.height && job.type !== 'data' ? el('button', { type: 'button', class: 'btn btn--sm', 'data-to-video': c.source, 'data-url': c.previewUrl ?? c.url, 'data-width': c.width, 'data-height': c.height, text: 'Send to video' }) : null)),
                );
            } else if (c.type === 'video' && (c.main || job.type === 'video')) {
                media.append(el('video', { src: c.url, poster: c.previewUrl, controls: true, preload: 'metadata', playsinline: true }));
            } else if (c.type === 'voice') {
                media.append(el('audio', { src: c.url, controls: true, preload: 'metadata' }));
                // heard: older jobs keep it as needed (the name the English conversion gave it at first)
                if (c.heard ?? c.needed) media.append(el('p', { class: 'text-sm text-muted', text: `What Whisper heard (error rate ${number((c.error ?? 0) * 100, 1)}%): ${c.heard ?? c.needed}` }));
            }
        }
        if (media.children.length) parts.push(media);

        // 3D model: GLB / FBX / OBJ (ZIP) / STL downloads; the STL is the print copy with its size and volume.
        const models = job.outputs.filter((c) => c.type === 'model');
        if (models.length) {
            const glb = models.find((c) => c.format === 'glb');
            const print = models.find((c) => c.format === 'stl')?.print;
            const intro = job.outputs.find((c) => c.type === 'video');
            const FORMAT_NAME = { glb: 'GLB', fbx: 'FBX', obj: 'OBJ (ZIP)', stl: 'STL' };
            parts.push(el('div', { class: 'row row--wrap' },
                ...models.map((c) => el('a', { class: 'btn btn--sm', href: `${c.url}?download=1`, download: true, target: '_blank', rel: 'noopener', text: `Download ${FORMAT_NAME[c.format] ?? c.format}` })),
                intro ? el('a', { class: 'btn btn--sm', href: `${intro.url}?download=1`, download: true, target: '_blank', rel: 'noopener', text: 'Turntable video (MP4)' }) : null,
                glb?.triangle ? el('span', { class: 'text-sm text-muted', text: `${number(glb.triangle)} triangles` }) : null));
            if (print) parts.push(el('p', { class: 'text-sm text-muted', 'data-print-info': true, text: [`STL for printing: ${print.size.map((v) => number(v, 1)).join(' × ')} mm, ${number(print.volume, 1)} cm³`, print.solid ? null : 'hollow inside', print.watertight ? null : 'not watertight'].filter(Boolean).join(' · ') }));
        }

        // Sahne klipleri: en cok 20 dugme; gerisi klasorde (binlerce sahnede pencere sismesin).
        const scenes = job.outputs.filter((c) => c.type === 'scene' || c.type === 'subtitle');
        if (scenes.length) {
            const shown = scenes.slice(0, 21);
            // Sahne disi ciktilar (film, altyazi) sayilmaz: 07.10.2026'da 5 sahnenin 5'i gorunurken "+1 sahne klibi daha" yaziyordu
            const sceneExternal = job.outputs.filter((c) => c.type !== 'scene').length;
            const remaining = (job.outputCount ?? job.outputs.length) - sceneExternal - shown.filter((c) => c.type === 'scene').length;
            parts.push(el('div', { class: 'row row--wrap' },
                ...shown.map((c) => el('a', { class: 'btn btn--sm', href: `${c.url}?download=1`, download: true, target: '_blank', rel: 'noopener', text: c.type === 'subtitle' ? 'Subtitles (.srt)' : `Scene ${c.scene} (${number(c.duration)} s)` })),
                remaining > 0 ? el('span', { class: 'text-sm text-muted', text: `+ ${remaining} more scene clips (in the job folder)` }) : null));
        }

        // Model eğitimi: GGUF, kayıp eğrisi, örnek yanıtlar; "Yazı modeli yap" Ayarlar'daki seçimi değiştirir.
        const training = job.outputs.find((c) => c.type === 'training');
        if (training) parts.push(trainingResult(training));
        // Görsel betimleme: sayılar ve ilk betim örnekleri
        const caption = job.type === 'describe' ? job.outputs.find((c) => c.captioned !== undefined) : null;
        if (caption) parts.push(el('div', { class: 'stack stack--tight' },
            el('strong', { text: `${caption.captioned} images described${caption.undescribable ? ` · ${caption.undescribable} could not be described` : ''} · ${caption.totalCaption} descriptions in the collection` }),
            ...(caption.examples ?? []).map((o) => el('p', { class: 'text-sm', translate: 'no', text: `${String(o.file).split('/').pop()}: ${o.caption}` }))));

        const g = job.input ?? {};
        const USER_TEXT = new Set(['prompt', 'text', 'spec', 'title', 'recordName', 'musicName', 'source', 'instruction', 'name', 'style', 'lyrics', 'musicStyle', 'topic', 'description', 'imagePrompt', 'trigger', 'from', 'url', 'endTitle']);
        const info = [];
        for (const [k, v] of Object.entries(g)) {
            // the title is the window's heading (a renamed job showed its old title here)
            if (k === 'scenes' || k === 'music' || k === 'title' || typeof v === 'object') continue;
            if ((k === 'musicName' || k === 'musicLevel') && !g.music) continue;
            info.push([job.type === 'training' && k === 'ratio' ? 'Learning rate' : INPUT_NAMES[k] ?? k, inputValue(job, k, v), USER_TEXT.has(k) || k === 'examplePrompt']);
        }
        if (Array.isArray(g.scenes)) info.push(['Scene', g.scenes.length]);
        if (job.modelFiles?.length) info.push(['Model file', job.modelFiles.join(', ')]);
        if (job.stages) info.push(['Stage times', Object.entries(job.stages).map(([k, v]) => `${k} ${durationText(v)}`).join(' · ')]);
        info.push(['Folder', `outputs\\${job.id}`]);
        parts.push(lines(info));

        if (Array.isArray(g.scenes)) {
            const ilk = g.scenes.slice(0, 30);
            parts.push(el('div', { class: 'stack stack--tight' },
                ...ilk.map((s, i) => el('p', { class: 'text-sm' }, el('strong', { text: `Scene ${i + 1}: ` }), el('span', { translate: 'no', text: [s.narration, ...(s.dialogue ?? []).map((x) => `${x.who}: ${x.text}`)].filter(Boolean).join(' · ') }))),
                g.scenes.length > ilk.length ? el('p', { class: 'text-sm text-muted', text: `… ${g.scenes.length - ilk.length} more scenes` }) : null));
        }

        const box = el('pre', { class: 'config-preview', 'data-preview-log': true, text: (job.log ?? []).join('\n') || 'Log is empty.' });
        parts.push(el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Log' }), box));
        if (job.errorDetail) parts.push(el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Error details' }), el('pre', { class: 'config-preview', text: job.errorDetail })));

        body.replaceChildren(...parts);
        box.scrollTop = box.scrollHeight;

        const action = $('[data-preview-actions]', previewWindow);
        const buttons = [];
        if (job.status === 'running' && job.pausable) buttons.push(pauseButton(job, 'btn'));
        if (job.status === 'running' || job.status === 'waiting') {
            buttons.push(actionForm({ path: `/api/job/${job.id}/cancel`, tag: 'Cancel', title: 'Cancel job', approval: 'The job will be cancelled.', variant: 'danger', button: 'btn btn--danger' }));
        }
        if (RETRY_STATUSES.includes(job.status)) buttons.push(retryButton(job, 'btn'));
        const rename = el('button', { type: 'button', class: 'btn btn--ghost', 'data-rename': true, text: 'Rename' });
        rename.addEventListener('click', () => renameForm(job));
        buttons.push(rename);
        if (!['waiting', 'running'].includes(job.status)) {
            buttons.push(actionForm({ path: `/api/job/${job.id}/delete`, tag: 'Delete', title: 'Delete output', approval: `The ${typeName(job)} job and all its outputs will be permanently deleted (cannot be undone).`, variant: 'danger', button: 'btn btn--ghost' }));
        }
        const ana = mainOutput(job);
        if (ana) buttons.push(el('a', { class: 'btn btn--primary', href: `${ana.url}?download=1`, download: true, target: '_blank', rel: 'noopener', text: 'Download' }));
        buttons.push(el('button', { type: 'button', class: 'btn btn--secondary', 'data-modal-close': true, text: 'Close' }));
        action.replaceChildren(...buttons);
    }

    /* ── Kaydırıcılar: değer etiketin yanında, dolu kısım renkli ────────── */

    function showSlider(field) {
        const container = field.closest('.field');
        const tag = container && $('[data-slider-value]', container);
        const v = Number(field.value);
        if (tag) tag.textContent = `${number(v, 2)}${field.dataset.sliderExtra ?? ''}`;
        const min = Number(field.min || 0);
        const max = Number(field.max || 100);
        field.style.setProperty('--slider-percent', `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`);
    }

    function updateSliders(root = document) {
        $$('input[type="range"].slider', root).forEach(showSlider);
    }

    document.addEventListener('input', (event) => {
        if (event.target.matches('input[type="range"].slider')) showSlider(event.target);
    });

    /* ── Seçenekler, model ve ses alanları ──────────────────────────────── */

    async function loadOptions() {
        const s = await api('/api/options');
        status.options = s;
        // İnce ayara bağlı seçenekler (1080p video, 720p / 81 kare video eğitimi): ayar kapalıysa gizli
        $$('[data-fine-required]').forEach((o) => {
            const isOpen = Boolean(s.fineSettings?.[o.dataset.fineRequired]);
            o.hidden = !isOpen;
            o.disabled = !isOpen;
            const choice = o.closest('select');
            if (!isOpen && choice?.value === o.value) choice.value = choice.querySelector('option[selected]:not([disabled])')?.value ?? choice.querySelector('option:not([disabled])')?.value ?? '';
        });
        $$('[data-model-choice]').forEach((choice) => {
            // Bu makinede olanlar üstte (kullanıcı 08.10.2026: "burada olanlar listelensin"), olmayanlar altta seçilemez.
            const list = [...(choice.dataset.modelChoice === 'image' ? s.imageModels : s.videoModels)].sort((a, b) => Number(Boolean(b.available)) - Number(Boolean(a.available)));
            const previous = choice.value;
            choice.replaceChildren(...list.map((m) => el('option', { value: m.id, disabled: !m.available, title: m.reason || null, text: m.available ? m.name : `${m.name} (not on this machine)` })));
            if (previous && list.some((m) => m.id === previous && m.available)) choice.value = previous;
        });
        $$('[data-voice-fields]').forEach((container) => {
            if (!container.children.length) setupVoiceFields(container);
        });
        $$('[data-quality-choice]').forEach((choice) => {
            const previous = choice.value || 'checked';
            choice.replaceChildren(...Object.entries(s.quality).map(([k, name]) => el('option', { value: k, text: name })));
            choice.value = previous;
        });
        fillVoiceChoices(s.voices);
        renderVoiceLibrary(s.voices);
        applyVoiceEngine(s.voiceEngine);
        applyM3Blender(s.hasBlender);
        if (!s.hasFfmpeg) notify('ffmpeg not found: merging video and audio will not work (<ai>\\ffmpeg\\bin or PATH).', 'danger');
        if (!s.hasVoice) notify('Voice-over is not installed (ses\\seslendir.bat missing).', 'warning');
    }

    /** Duygu şiddeti yalnız Chatterbox'ta etkili; VoxCPM2'de gizli. Ayarlar'da motor değişince sayfa yenilenmeden çağrılır. */
    function applyVoiceEngine(engine) {
        if (status.options) status.options.voiceEngine = engine;
        $$('[name="exaggeration"]').forEach((field) => {
            field.closest('.field').hidden = engine === 'voxcpm' || engine === 'kizagan';
        });
    }

    let fieldCounter = 0;

    /** Ses alanları şablondan kopyalanır: Ses ve Tek parça formunda aynı alanlar. */
    function setupVoiceFields(container) {
        container.append($('#voice-fields-template').content.cloneNode(true));
        // Kalite, hız vb. formun "İnce ayarlar" bölümüne; ana ekranda yalnız ses seçimi kalır.
        const part = $('[data-voice-fine-part]', container);
        const fine = $('[data-voice-fine]', container.closest('form'));
        if (part && fine) {
            fine.append(...part.children);
            part.remove();
        }
        $$('[data-for]', container.closest('form')).forEach((tag) => {
            const field = tag.closest('.field').querySelector(`[name="${tag.dataset.for}"]`);
            if (!field) return;
            fieldCounter += 1;
            field.id = `field-${tag.dataset.for}-${fieldCounter}`;
            tag.htmlFor = field.id;
        });
    }

    function fillVoiceChoices(voices) {
        $$('[data-voice-choice]').forEach((choice) => {
            const previous = choice.value;
            const design = status.options?.hasDesign;
            choice.replaceChildren(
                ...[
                    el('option', { value: 'model', text: "Model's default voice" }),
                    voices.length ? el('optgroup', { label: 'Voice library' }, ...voices.map((s) => el('option', { value: `ref:${s.id}`, translate: 'no', text: s.name }))) : null,
                    el('option', { value: 'spec', disabled: !design, text: design ? 'Create a new voice from a description…' : 'New voice from description (not installed on this machine)' }),
                ].filter(Boolean),
            );
            const exists = (d) => $$('option', choice).some((o) => o.value === d && !o.disabled);
            if (previous && exists(previous)) choice.value = previous;
            else choice.value = voices.length ? `ref:${(voices.find((s) => s.defaultValue) ?? voices[0]).id}` : 'model';
            specFields(choice);
        });
    }

    function specFields(choice) {
        const form = choice.closest('form');
        $$('[data-spec-field]', form).forEach((a) => {
            a.hidden = choice.value !== 'spec';
        });
        const voice = status.options?.voices.find((s) => `ref:${s.id}` === choice.value);
        const hint = $('[data-voice-hint]', form);
        if (hint) {
            // Kütüphanedeki sesin açıklaması kullanıcı metnidir: çevrilmez.
            if (voice) hint.replaceChildren(...(voice.description ? [el('span', { translate: 'no', text: voice.description }), voice.duration ? ' · ' : ''] : []), voice.duration ? `${number(voice.duration)} s reference` : '');
            else hint.textContent = choice.value === 'model' ? 'Built-in default voice.' : '';
        }
    }

    document.addEventListener('change', (event) => {
        if (event.target.matches('[data-voice-choice]')) specFields(event.target);
    });

    /* ── Ses kütüphanesi ────────────────────────────────────────────────── */

    function renderVoiceLibrary(voices) {
        const container = $('[data-voice-list]');
        if (!voices.length) {
            container.replaceChildren(el('div', { class: 'empty' },
                el('p', { class: 'empty__title', text: 'Library is empty' }),
                el('p', { class: 'empty__text', text: 'Upload a WAV/MP3 or design one with "New voice from description".' })));
            return;
        }
        // Kütüphane sayfalı (8'er ses): uzun listede kaydırma yerine sayfalar.
        status.voices = voices;
        const d = slice(voices, status.voicePage ?? 1, 8);
        status.voicePage = d.page;
        const nav = pagination(d, (n) => {
            status.voicePage = n;
            renderVoiceLibrary(status.voices);
        });
        $('[data-voice-pagination]').replaceChildren(...(nav ? [nav] : []));
        container.replaceChildren(...d.items.map((s) => el(
            'div',
            { class: 'panel__block stack stack--tight' },
            el('div', { class: 'row row--between' },
                el('span', { class: 'line-title truncate', translate: 'no', title: s.name, text: s.name }),
                el('span', { class: 'code', text: s.duration ? `${number(s.duration)} s` : '' })),
            s.ownVoice ? el('div', { class: 'row' },
                el('span', { class: 'badge', text: 'Own voice' }),
                el('span', { class: `badge${s.trained ? ' badge--green' : ''}`, title: s.trained ? 'A model trained on this voice is used (VoxCPM2).' : 'Quick clone from the recording.', text: s.trained ? 'Trained' : 'Quick clone' })) : null,
            s.description || s.spec ? el('p', { class: 'text-sm text-muted', translate: 'no', text: [s.description, s.spec].filter(Boolean).join(' — ') }) : null,
            el('audio', { controls: true, preload: 'none', src: `/file/voice/${s.id}.wav` }),
            el('div', { class: 'job-actions' },
                el('button', { type: 'button', class: 'btn btn--sm', 'data-voice-select': `ref:${s.id}`, text: 'Use this voice' }),
                actionForm({
                    path: `/api/voices/${s.id}/delete`,
                    tag: 'Remove',
                    title: 'Remove voice from library',
                    approval: `"${s.name}" will be permanently deleted. Outputs made with this voice are not affected.`,
                    variant: 'danger',
                    button: 'btn btn--sm btn--ghost',
                })),
        )));
    }

    async function refreshVoices() {
        try {
            const j = await api('/api/voices');
            if (status.options) status.options.voices = j.voices;
            fillVoiceChoices(j.voices);
            renderVoiceLibrary(j.voices);
            renderCharacters();
        } catch (e) {
            notify(e.message, 'danger');
        }
    }

    document.addEventListener('click', (event) => {
        const select = event.target.closest('[data-voice-select]');
        if (!select) return;
        const choice = $('[data-job-form="voice"] [data-voice-choice]');
        choice.value = select.dataset.voiceSelect;
        specFields(choice);
        saveDraft();
        notify('Voice selected.', 'success');
    });

    /**
     * Dosya yükleme, yüzdeli (fetch yükleme ilerlemesi vermez). Telefondan büyük video yüklerken
     * "donmuş" görünmesin diye. Yanıt api() ile aynı biçimde: JSON, hata Türkçe.
     */
    function loadProgressive(path, file, progress) {
        return new Promise((ok, red) => {
            const x = new XMLHttpRequest();
            x.open('POST', path);
            x.setRequestHeader('Accept', 'application/json');
            x.setRequestHeader('X-Panel', '1');
            x.setRequestHeader('X-Panel-Lang', 'en');
            x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
            x.upload.onprogress = (o) => o.lengthComputable && progress(o.loaded / o.total);
            x.onerror = () => red(new Error('Could not reach the panel server (connection lost).'));
            x.onload = () => {
                let j = {};
                try {
                    j = JSON.parse(x.responseText || '{}');
                } catch {
                    /* */
                }
                if (x.status >= 400 || j.ok === false) red(new Error(j.error || `Upload failed (HTTP ${x.status}).`));
                else ok(j);
            };
            x.send(file);
        });
    }

    // Seçim hemen görünsün (iOS'ta iCloud'daki video inene kadar seçim gelmez; gelince burada listelenir).
    $('[data-own-voice-form]').records.addEventListener('change', (event) => {
        const d = [...(event.target.files ?? [])];
        const total = d.reduce((t, x) => t + x.size, 0);
        $('[data-own-voice-status]').textContent = d.length ? `Selected: ${d.map((x) => x.name).join(', ')} (${number(total / 2 ** 20, 0)} MB). Press Start.` : '';
    });


    /* ── Model egitimi: veri dosyalari sirayla yuklenir, sonra "egitim" isi kuyruga girer ── */
    (() => {
        const form = $('[data-training-form]');
        if (!form) return;
        const text = $('[data-training-status]');
        const customField = $('[data-training-base-custom]');
        const CUSTOM = '__custom__';
        // The chat's answers rated good: a data choice in the list, turned into a data file on submit
        const RATED_CHATS = 'chats/rated';
        const isImage = () => form.field?.value === 'image';
        const isMusic = () => form.field?.value === 'music';
        const isVideo = () => form.field?.value === 'video';
        const isGeneral = () => form.field?.value === 'general';
        const isLora = () => isImage() || isMusic() || isVideo();
        const showMethod = () => {
            const image = isLora();
            if (image) form.method.value = 'fine';
            const scratch = form.method.value === 'scratch';
            $('[data-training-fine]').hidden = scratch;
            $('[data-training-scratch]').hidden = !scratch;
            const g = $('[data-training-image]');
            if (g) g.hidden = !isImage();
            const mz = $('[data-training-music]');
            if (mz) mz.hidden = !isMusic();
            const vd = $('[data-training-video]');
            if (vd) vd.hidden = !isVideo();
            // Genel: yalniz ince ayar (sifirdan yok); Gelismis alanlari acik
            if (isGeneral()) form.method.value = 'fine';
            $$('[data-training-general]').forEach((e) => {
                e.hidden = !isGeneral();
            });
            const hint = $('[data-training-data-hint]');
            if (hint) {
                hint.textContent = isImage()
                    ? "Images (PNG, JPEG, WebP) or a .zip containing them; a same-name .txt file becomes that image's caption. At least 3, 10-30 images recommended."
                    : isMusic()
                      ? 'Songs (WAV, MP3, FLAC, OGG, M4A) or a .zip containing them; a same-name .txt file becomes the lyrics, .caption.txt the description. At least 2, 10-20 songs recommended; the first 4 minutes of each song are used.'
                      : isGeneral()
                        ? 'Images (PNG, JPEG, WebP) with same-name .txt answers (e.g. product.png + product.txt: the image description or the answer you want), chat JSONL with images, plain text and Q&A (JSONL, CSV) or a .zip containing them.'
                        : isVideo()
                        ? 'Clips (MP4, MOV, WebM, MKV, AVI), images or a .zip containing them; a same-name .txt file becomes the caption. A few short pieces are taken from a long clip. At least 1, 5-30 clips recommended.'
                        : 'Plain text (TXT, MD, HTML): the model learns the style and knowledge of the text. Q&A: JSONL or CSV; each line has a prompt and a response (JSONL: prompt/response fields or a messages list; CSV: question,answer columns). Multiple files can be selected.';
            }
            form.method.closest('.field').hidden = image || isGeneral();
            const advanced = form.querySelector('details.fine-setting');
            if (advanced) advanced.hidden = image;
        };
        form.method.addEventListener('change', showMethod);
        form.field?.addEventListener('change', () => {
            showMethod();
            refresh();
        });
        form.base.addEventListener('change', () => {
            customField.hidden = form.base.value !== CUSTOM;
        });

        async function refresh({ skipIfUnchanged = false } = {}) {
            let b;
            try {
                b = await api('/api/training');
            } catch {
                return;
            }
            const signature = `${JSON.stringify(b)}|${form.field?.value}|${form.method?.value}`;
            if (skipIfUnchanged && signature === status.trainingSignature) return;
            status.trainingSignature = signature;
            status.trainingInfo = b;
            $('[data-training-not-installed]').hidden = isImage() ? b.imageInstalled !== false : isMusic() ? b.musicInstalled !== false : isVideo() ? b.videoInstalled !== false : isGeneral() ? b.generalInstalled !== false : b.installed;
            // Video: eksik olan (model dosyasi, ffmpeg) uyarida yazar
            const warning = $('[data-training-not-installed] span');
            if (warning) {
                warning.dataset.original ??= 'Training environment is not installed (training\\.venv). Run kur.bat.';
                warning.textContent = isVideo() && b.isVideossing ? `Video training is unavailable: ${b.isVideossing}` : warning.dataset.original;
            }
            imageLoras(b);
            musicLoras(b);
            videoLoras(b);
            const previous = form.base.value;
            // Kurulu (indirilmiş) temeller en üstte "Bu bilgisayarda" (sonradan girilen özel HF depoları dahil); inmemişler altta boyutuyla.
            const myField = form.field?.value || 'text';
            const inField = b.bases.filter((m) => (m.field ?? 'text') === myField);
            const local = [...inField.filter((m) => m.installed), ...(['text', 'code', 'general'].includes(myField) ? b.customBases ?? [] : [])];
            const toDownload = inField.filter((m) => !m.installed);
            // replaceChildren writes a null as the text "null": the empty groups are left out
            const trainedHere = b.trained.filter((m) => (m.field ?? 'text') === myField);
            form.base.replaceChildren(
                ...[
                    local.length ? el('optgroup', { label: 'On this computer' }, ...local.map((m) => el('option', { value: m.id, text: m.sizeGib ? `${m.name} · downloaded (${number(m.sizeGib, 1)} GB)` : `${m.name} · installed model, no download` }))) : null,
                    toDownload.length ? el('optgroup', { label: local.length ? 'To download' : 'Ready models' }, ...toDownload.map((m) => el('option', { value: m.id, text: m.downloadGib ? `${m.name} · ~${m.downloadGib} GB downloaded the first time` : `${m.name} · not installed` }))) : null,
                    trainedHere.length ? el('optgroup', { label: 'Trained here (improve)' }, ...trainedHere.map((m) => el('option', { value: m.id, text: `${m.name} (${['image', 'music', 'video'].includes(m.field) ? 'LoRA' : m.method === 'scratch' ? 'from scratch' : 'fine-tuned'})` }))) : null,
                    isLora() || isGeneral() ? null : el('option', { value: CUSTOM, text: 'Another Hugging Face model…' }),
                ].filter(Boolean),
            );
            if ([...form.base.options].some((o) => o.value === previous)) form.base.value = previous;
            customField.hidden = form.base.value !== CUSTOM;
            if (!form.size.options.length) form.size.replaceChildren(...b.sizes.map((m) => el('option', { value: m.id, text: m.name })));
            // Toplanan koleksiyonlar: egitim verisi olarak isaretlenebilir; ayrica liste
            const choice = $('[data-training-collection-choice]');
            const marked = new Set([...choice.querySelectorAll('input:checked')].map((i) => i.value));
            const arm = b.collections ?? [];
            const FILE_NAME = { 'training-meta': 'SEO meta', 'training-translation': 'translation pairs', 'training-write': 'writing', 'training-summary': 'summarization', 'training-title': 'title writing', 'training-question': 'question-answer', 'training-classification': 'classification', 'training-image': 'image-caption' };
            // The collection's name stays as the user wrote it; the kind of data is translated ("raw articles" stayed
            // English on the Turkish page under translate=no, 09.10.2026)
            const box = (value, name, kind, count) => el('label', { class: 'checkbox' }, el('input', { type: 'checkbox', name: 'collection', value: value, checked: marked.has(value) }),
                el('span', {}, el('span', { translate: 'no', text: name }), ' · ', el('span', { text: kind }), ` (${count})`));
            // Alana göre: LoRA'larda indirilen media (Veri toplama "Medya: indir"); metin/kod/genel'de yazılar ve eğitim dosyaları
            const field = form.field?.value || 'text';
            const mediaTypes = { image: ['images', 'captions'], video: ['videos', 'images'], music: ['audio'], general: ['images', 'captions'] }[field] ?? [];
            const MEDIA_NAME = { images: 'downloaded images', videos: 'downloaded videos', audio: 'downloaded audio', captions: 'images with model descriptions' };
            // Answers rated good in the chat (user request 08.10.2026): saved as a data file when the job starts
            const rated = isLora() ? 0 : b.ratedChats?.good ?? 0;
            const ratedBox = rated ? el('label', { class: 'checkbox' }, el('input', { type: 'checkbox', name: 'collection', value: RATED_CHATS, checked: marked.has(RATED_CHATS) }), el('span', { text: `Good answers from rated chats (${rated})` })) : null;
            const options = [...(ratedBox ? [ratedBox] : []), ...arm.flatMap((k) => [
                ...(isLora() ? [] : [box(`collection/${k.id}`, k.name, 'raw articles', k.total ?? '?')]),
                ...(isLora() ? [] : (k.files ?? []).filter((d) => d.name.startsWith('training-') && d.count && (d.name !== 'training-image' || field === 'general')).map((d) => box(`collection/${k.id}/${d.name}`, k.name, FILE_NAME[d.name] ?? d.name, d.count))),
                ...mediaTypes.filter((t) => k.media?.[t]).map((t) => box(`collection/${k.id}/${t}`, k.name, MEDIA_NAME[t], k.media[t])),
            ])];
            choice.hidden = !options.length;
            choice.replaceChildren(...options);
            // Görsel betimleme: yazı modeli (Gemma) indirilen görselleri Türkçe betimler; eğitimde altyazı yerine seçilir
            const describeLine = (k) => (k.media?.images ? el('div', { class: 'row row--wrap' },
                el('span', { class: 'text-sm text-muted', text: `Described images: ${k.media.captions ?? 0}/${k.media.images}` }),
                (k.media.captions ?? 0) < k.media.images ? el('button', { type: 'button', class: 'btn btn--sm', 'data-describe': k.id, title: 'The text model (Gemma) describes the downloaded images in Turkish; in training they are selected as "images with model descriptions". Resumes where it left off.', text: 'Describe images' }) : null) : null);
            // The topic and the language codes stay as they are; the labels and the kinds of data are translated
            const detailLine = (k) => {
                const languages = Object.entries(k.languages ?? {});
                const files = (k.files ?? []).filter((d) => d.name.startsWith('training-') && d.count);
                const parts = [
                    k.topic ? [el('span', { text: 'Topic' }), ': ', el('span', { translate: 'no', text: k.topic })] : null,
                    languages.length ? [el('span', { text: 'Languages' }), ': ', el('span', { translate: 'no', text: languages.map(([d, n]) => `${d} ${n}`).join(', ') })] : null,
                    files.length ? files.flatMap((d, i) => [i ? ' · ' : '', el('span', { text: FILE_NAME[d.name] ?? d.name }), ` ${d.count}`]) : null,
                ].filter(Boolean);
                return parts.flatMap((p, i) => (i ? [' — ', ...p] : p));
            };
            $('[data-data-collections]').replaceChildren(...(arm.length ? arm.map((k) => el('div', { class: 'stack stack--tight' },
                el('div', { class: 'row row--between row--wrap' },
                    el('strong', { translate: 'no', text: k.name }),
                    el('span', { class: 'text-sm text-muted', text: [`${k.total ?? '?'} articles`, `${number(k.byte / 2 ** 20, 1)} MB`, k.lastUpdate ? dateText(k.lastUpdate) : null].filter(Boolean).join(' · ') })),
                el('div', { class: 'text-sm text-muted' }, ...detailLine(k)), describeLine(k)))
                : [el('p', { class: 'text-sm text-muted', text: 'No collections yet.' })]));
            const list = $('[data-training-models]');
            list.replaceChildren(...(b.trained.length ? b.trained.map((m) => el('div', { class: 'row row--between row--wrap' },
                el('div', { class: 'stack stack--tight' },
                    el('strong', { translate: 'no', text: m.name }),
                    el('span', { class: 'text-sm text-muted', text: [['image', 'music', 'video'].includes(m.field) ? `${{ music: 'music', video: 'video' }[m.field] ?? 'image'} LoRA · trigger "${m.trigger ?? ''}"` : m.method === 'scratch' ? `from scratch · ${m.size ?? ''}` : `fine-tuned · ${m.base ?? ''}`, dateText(m.dateText), m.training?.lastLoss !== null && m.training?.lastLoss !== undefined ? `last loss ${number(m.training.lastLoss, 3)}` : null].filter(Boolean).join(' · ') }),
                    el('span', { class: 'text-sm code', translate: 'no', text: ['image', 'music', 'video'].includes(m.field) ? m.lora : m.gguf })),
                el('button', { type: 'button', class: 'btn btn--sm', 'data-training-improve': m.id, text: 'Improve this one' })))
                : [el('p', { class: 'text-sm text-muted', text: 'No trained models yet.' })]));
        }
        $('[data-data-collections]').addEventListener('click', async (event) => {
            const d = event.target.closest('[data-describe]');
            if (!d) return;
            d.disabled = true;
            try {
                const j = await api('/api/job', { method: 'POST', body: { type: 'describe', collection: d.dataset.describe, language: 'tr' } });
                notify(`${j.message} When done, select "images with model descriptions" in training.`, 'success');
            } catch (e) {
                notify(e.message, 'danger');
                d.disabled = false;
            }
        });
        $('[data-training-models]').addEventListener('click', async (event) => {
            const d = event.target.closest('[data-training-improve]');
            if (!d) return;
            const selected = (status.trainingInfo?.trained ?? []).find((m) => m.id === d.dataset.trainingImprove);
            if (selected && form.field) form.field.value = selected.field ?? 'text';
            form.method.value = 'fine';
            showMethod();
            await refresh();
            form.base.value = d.dataset.trainingImprove;
            customField.hidden = true;
            form.name.focus();
        });
        document.addEventListener('nedese:training', refresh);
        // On entering the section: lists and selects are not rebuilt when nothing changed (no reload-like flash).
        document.addEventListener('nedese:section', (o) => {
            if (o.detail.section === 'training') refresh({ skipIfUnchanged: true });
        });
        showMethod();
        refresh();

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const name = form.name.value.trim();
            const files = [...(form.dataItems.files ?? [])];
            if (!name) return notify('Enter a model name.', 'danger');
            const collections = [...form.querySelectorAll('[name=collection]:checked')].map((i) => i.value);
            if (!files.length && !collections.length) return notify('Pick at least one data file or collection.', 'danger');
            const base = form.base.value === CUSTOM ? customField.value.trim() : form.base.value;
            if (form.method.value === 'fine' && !base) return notify('Pick a base model or type "org/model".', 'danger');
            const button = form.querySelector('[type=submit]');
            button.disabled = true;
            try {
                const dataItems = collections.filter((c) => c !== RATED_CHATS);
                // the good answers become a data file now (the latest ratings)
                if (collections.includes(RATED_CHATS)) dataItems.push((await api('/api/v1/chat/ratings/export', { method: 'POST' })).data.source);
                for (const [i, d] of files.entries()) {
                    const startedAt = `Uploading ${i + 1}/${files.length}: ${d.name} (${number(d.size / 2 ** 20, 1)} MB)`;
                    text.textContent = startedAt;
                    const j = await loadProgressive(`/api/data/upload?name=${encodeURIComponent(d.name)}`, d, (ratio) => {
                        text.textContent = `${startedAt} · ${Math.round(ratio * 100)}%`;
                    });
                    dataItems.push(j.data.source);
                }
                text.textContent = 'Starting job…';
                const body = { type: 'training', name, field: (form.field?.value || 'text') || 'text', method: form.method.value, dataItems };
                if (form.method.value === 'fine') body.base = base;
                else body.size = form.size.value;
                const fields = isImage() ? ['trigger', 'description', 'resolution', 'step', 'rank'] : isMusic() || isVideo() ? [] : isGeneral() ? ['epoch', 'context', 'ratio', 'quantization', 'examplePrompt', 'imagePrompt'] : ['epoch', 'context', 'ratio', 'quantization', 'examplePrompt'];
                for (const k of fields) if (form[k]?.value?.trim()) body[k] = form[k].value.trim();
                // Muzik alanlari ayri adlarla (gorselle cakismasin): mTetik -> tetik ...
                if (isMusic()) for (const [k, a] of [['mTrigger', 'trigger'], ['mDescription', 'description'], ['mLanguage', 'lang'], ['mEpoch', 'epoch'], ['mRank', 'rank']]) if (form[k]?.value?.trim()) body[a] = form[k].value.trim();
                if (isVideo()) for (const [k, a] of [['vTrigger', 'trigger'], ['vDescription', 'description'], ['vResolution', 'resolution'], ['vFrame', 'frame'], ['vStep', 'step'], ['vRank', 'rank']]) if (form[k]?.value?.trim()) body[a] = form[k].value.trim();
                const j = await api('/api/job', { method: 'POST', body });
                notify(`${j.message} ${isImage() ? 'Progress is in the queue; when done the LoRA is selected with FLUX.2 klein in the Image tab.' : isMusic() ? 'Progress is in the queue; when done the LoRA is selected in the Music tab.' : isVideo() ? 'Progress is in the queue; when done the LoRA is selected in the Video tab (Advanced > Model: Wan 2.2 5B).' : isGeneral() ? 'Progress is in the queue; when done the model appears in Settings > Text model as "understands images".' : 'Progress is in the queue; when done, the model appears in the Settings > Text model list.'}`, 'success');
                form.dataItems.value = '';
                showFileNames(form.dataItems);
                text.textContent = '';
            } catch (e) {
                text.textContent = '';
                notify(e.message, 'danger');
            } finally {
                button.disabled = false;
            }
        });
    })();

    /* ── Veri toplama: kaynak listesinden koleksiyona (lib/isler/veri.mjs) ── */
    (() => {
        const form = $('[data-data-form]');
        if (!form) return;

        // The engines, MCP servers and skills the job can use (user request 09.10.2026): GET /api/v1/data/sources, read
        // again on every visit to Training (a key set in Settings or a server added meanwhile shows up); the choices made
        // stay when the lists are drawn again.
        const enginesBox = $('[data-data-engines]');
        const mcpList = $('[data-data-mcp-list]');
        const skillList = $('[data-data-skill-list]');
        const skillFilter = $('[data-data-skill-filter]');
        let known = null;
        const checkedValues = (box, name) => [...box.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
        const choice = (name, value, isChecked, title, note) => el('label', { class: 'checkbox', 'data-choice-text': `${title} ${note ?? ''}`.toLowerCase() },
            el('input', { type: 'checkbox', name, value, checked: isChecked }),
            el('span', { class: 'choice-list__text' },
                el('strong', { translate: 'no', text: title }),
                note ? el('span', { class: 'text-sm text-muted', translate: 'no', text: note }) : null));
        function showEngines() {
            // a service that was not set (disabled) gets the default (on) once it is set
            const before = new Map([...enginesBox.querySelectorAll('input[name="engine"]')].filter((i) => !i.disabled).map((i) => [i.value, i.checked]));
            enginesBox.replaceChildren(...known.engines.map((m) => el('label', { class: 'checkbox', title: m.configured ? null : 'Add its key or address in Settings › Web search.' },
                el('input', { type: 'checkbox', name: 'engine', value: m.id, checked: m.configured && (before.get(m.id) ?? true), disabled: !m.configured }),
                el('span', { translate: 'no', text: m.name }),
                el('span', { class: 'text-sm text-muted', text: m.service ? (m.configured ? 'key set' : 'Not set') : 'no key' }))));
        }
        function showMcp() {
            const before = new Set(checkedValues(mcpList, 'mcpServer'));
            mcpList.replaceChildren(...(known.mcp.length
                ? known.mcp.map((s) => {
                    const item = choice('mcpServer', s.name, before.has(s.name), s.name, [s.type, s.source].filter(Boolean).join(' · '));
                    if (s.missing?.length) item.querySelector('.choice-list__text').append(el('span', { class: 'text-sm text-muted', text: `Missing environment variables: ${s.missing.join(', ')}` }));
                    return item;
                })
                : [el('span', { class: 'text-sm text-muted', text: 'No MCP server is on: add one in Settings › Assistant.' })]));
        }
        function filterSkills() {
            const q = skillFilter.value.trim().toLowerCase();
            for (const l of skillList.querySelectorAll('[data-choice-text]')) l.hidden = Boolean(q) && !l.dataset.choiceText.includes(q) && !l.querySelector('input').checked;
        }
        function showSkills() {
            const before = new Set(checkedValues(skillList, 'skill'));
            skillList.replaceChildren(...(known.skills.length
                ? known.skills.map((s) => choice('skill', s.name, before.has(s.name), s.name, s.description))
                : [el('span', { class: 'text-sm text-muted', text: 'No skill is installed: add one in Settings › Assistant, or ask the chat to install one.' })]));
            filterSkills();
        }
        function showModes() {
            mcpList.hidden = form.mcpMode.value !== 'pick';
            skillList.hidden = form.skillsMode.value !== 'pick';
            skillFilter.hidden = skillList.hidden || (known?.skills.length ?? 0) <= 6;
        }
        async function loadSources() {
            try {
                known = await api('/api/v1/data/sources');
            } catch {
                return;
            }
            showEngines();
            showMcp();
            showSkills();
            showModes();
        }
        form.mcpMode.addEventListener('change', showModes);
        form.skillsMode.addEventListener('change', showModes);
        skillFilter.addEventListener('input', filterSkills);
        document.addEventListener('nedese:section', (o) => {
            if (o.detail.section === 'training') loadSources();
        });
        loadSources();

        /** engines, serviceLimit, mcp, mcpCalls, skills of the form (null: a choice is missing, said to the user). */
        function sourceFields(topic) {
            const g = {};
            const engines = known ? checkedValues(enginesBox, 'engine') : [];
            if (known && topic && !engines.length) return void notify('Pick at least one search engine.', 'danger');
            if (engines.length) g.engines = engines;
            g.serviceLimit = form.serviceLimit.value;
            const pick = (mode, box, name, empty) => {
                if (mode === 'auto') return 'auto';
                if (mode !== 'pick') return null;
                const names = checkedValues(box, name);
                if (!names.length) throw new Error(empty);
                return names;
            };
            try {
                const mcp = pick(form.mcpMode.value, mcpList, 'mcpServer', 'Pick at least one MCP server, or choose None.');
                if (mcp) Object.assign(g, { mcp, mcpCalls: form.mcpCalls.value });
                const skills = pick(form.skillsMode.value, skillList, 'skill', 'Pick at least one skill, or choose None.');
                if (skills) g.skills = skills;
            } catch (e) {
                return void notify(e.message, 'danger');
            }
            return g;
        }

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const name = form.name.value.trim();
            const sources = form.sources.value.split(/\s+/).map((k) => k.trim()).filter(Boolean);
            const topic = form.topic.value.trim();
            if (!name) return notify('Enter a collection name.', 'danger');
            if (!topic && !sources.length) return notify('Enter a topic or at least one source address.', 'danger');
            const extra = sourceFields(topic);
            if (!extra) return;
            const button = form.querySelector('[type=submit]');
            button.disabled = true;
            try {
                const value = (n) => form[n]?.value;
                const box = (n) => Boolean(form[n]?.checked);
                const j = await api('/api/job', { method: 'POST', body: { type: 'data', name, topic, sources, target: value('target'), max: value('max'), extract: value('extract'), minQuality: value('minQuality'), minAccuracy: value('minAccuracy'), languages: value('languages'), depth: value('depth'), browser: value('browser'), media: value('media'), durationMin: value('durationMin'), parallel: value('parallel'), translationPairs: box('translationPairs'), documents: box('documents'), wpApi: box('wpApi'), maskPersonalData: box('maskPersonalData'), commonCrawl: box('commonCrawl'), onlyNew: box('onlyNew'), hopSites: box('hopSites'), manager: box('manager'), ...extra } });
                notify(`${j.message} Progress is in the queue; when done the collection can be selected as training data.`, 'success');
            } catch (e) {
                notify(e.message, 'danger');
            } finally {
                button.disabled = false;
            }
        });
    })();

    /* Kendi sesim: kayitlar sirayla yuklenir, sonra "klon" isi kuyruga girer. */
    // Tek metin alanli formda Enter tarayicinin kendi GET gonderimini tetikliyordu (secilen dosyalar kayboluyordu)
    $('[data-own-voice-form]').addEventListener('submit', (event) => {
        event.preventDefault();
        $('[data-own-voice-submit]').click();
    });
    $('[data-own-voice-submit]').addEventListener('click', async () => {
        const form = $('[data-own-voice-form]');
        const button = $('[data-own-voice-submit]');
        const text = $('[data-own-voice-status]');
        const name = form.name.value.trim();
        const files = [...(form.records.files ?? [])];
        if (!name) return notify('Enter a voice name.', 'danger');
        if (!files.length) return notify('Pick at least one recording (video or audio).', 'danger');
        button.disabled = true;
        try {
            const records = [];
            for (const [i, d] of files.entries()) {
                const startedAt = `Uploading ${i + 1}/${files.length}: ${d.name} (${number(d.size / 2 ** 20, 0)} MB)`;
                text.textContent = startedAt;
                const j = await loadProgressive(`/api/record/upload?name=${encodeURIComponent(d.name)}`, d, (ratio) => {
                    text.textContent = `${startedAt} · ${Math.round(ratio * 100)}%`;
                });
                records.push(j.record.source);
            }
            text.textContent = 'Starting job…';
            const j = await api('/api/job', { method: 'POST', body: { type: 'clone', name, records, train: form.train.checked } });
            notify(`${j.message} When done the voice will be in the library; progress in the gallery.`, 'success');
            form.reset();
            text.textContent = '';
            $('#modal-own-voice [data-modal-close]').click();
        } catch (e) {
            text.textContent = '';
            notify(e.message, 'danger');
        } finally {
            button.disabled = false;
        }
    });

    $('[data-voice-upload]').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const j = await api(`/api/voices/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
            notify(j.message, 'success');
            await refreshVoices();
        } catch (e) {
            notify(e.message, 'danger');
        }
    });

    /* ── Görsel formu ───────────────────────────────────────────────────── */

    const imageForm = $('[data-job-form="image"]');

    /** Egitilmis gorsel LoRA'lari (Model egitimi > Gorsel) Gorsel sekmesindeki secime. */
    function imageLoras(b) {
        const choice = imageForm?.lora;
        if (!choice) return;
        const previous = choice.value;
        const loras = (b?.trained ?? []).filter((m) => m.field === 'image' && m.lora);
        choice.replaceChildren(el('option', { value: '', text: 'None' }), ...loras.map((m) => el('option', { value: m.lora, text: `${m.name} · trigger "${m.trigger ?? ''}"`, 'data-trigger': m.trigger ?? '' })));
        if ([...choice.options].some((o) => o.value === previous)) choice.value = previous;
        status.hasImageLora = loras.length > 0;
        imageFields();
    }

    function imageFields() {
        const s = status.options;
        if (!s) return;
        const model = imageForm.model.value;
        const loraField = $('[data-image-lora]', imageForm);
        if (loraField) {
            const show = model === 'flux' && status.hasImageLora;
            loraField.hidden = !show;
            if (!show) imageForm.lora.value = '';
            $('[data-image-lora-strength]', imageForm).hidden = !show || !imageForm.lora.value;
            const t = imageForm.lora.selectedOptions[0]?.dataset.trigger;
            $('[data-image-lora-hint]', imageForm).textContent = t ? `Trigger word "${t}" is added to the prompt automatically.` : 'LoRAs you trained under Model training > Image (FLUX.2 klein only).';
        }
        const ratio = imageForm.ratio.value;
        $$('[data-custom-size]', imageForm).forEach((a) => {
            a.hidden = ratio !== 'custom';
        });
        const size = ratio === 'custom' ? [imageForm.width.value, imageForm.height.value] : s.ratios[ratio]?.[model];
        $('[data-size-hint]', imageForm).textContent = size ? `${size[0]} × ${size[1]} pixels` : '';
        const m = s.imageModels.find((x) => x.id === model);
        $('[data-model-hint="image"]', imageForm).textContent = m?.files?.length ? m.files.join(', ') : '';
        $('[data-step-hint]', imageForm).textContent = m ? `How many passes the image gets. Recommended: ${m.step}; more is slower and does not improve quality (accelerated model).` : '';
        if (!imageForm.step.value && m) imageForm.step.value = m.step;
        updateSliders(imageForm);
    }

    imageForm.addEventListener('change', (event) => {
        if (event.target.name === 'model') {
            const m = status.options?.imageModels.find((x) => x.id === event.target.value);
            if (m) {
                imageForm.step.value = m.step;
                updateSliders(imageForm);
            }
        }
        imageFields();
    });

    // LoRA listesi: Görsel sekmesi açılınca ve açılışta (eğitim sekmesine gitmeden de görünsün)
    async function refreshImageLora() {
        try {
            const b = await api('/api/training');
            imageLoras(b);
            musicLoras(b);
            videoLoras(b);
        } catch {
            /* eğitim bilgisi yoksa LoRA alanı gizli kalır */
        }
    }
    document.addEventListener('nedese:section', (o) => {
        if (['image', 'single', 'video'].includes(o.detail.section)) refreshImageLora();
    });
    refreshImageLora();

    /* ── Video formu: kaynak görsel ─────────────────────────────────────── */

    /* ── Görsel düzenle: 0 = düzenlenecek görsel, 1-2 = referans ─────────── */

    const editForm = $('[data-job-form="edit"]');

    function configureSlot(n, k) {
        const slot = $(`[data-edit-slot="${n}"]`, editForm);
        if (!slot) return;
        $('[data-slot-field]', slot).value = k?.source ?? '';
        const picture = $('[data-slot-picture]', slot);
        $('[data-slot-empty]', slot).hidden = Boolean(k);
        picture.hidden = !k;
        if (k) picture.src = k.url;
        else picture.removeAttribute('src');
        const clear = $('[data-slot-clear]', slot);
        if (clear) clear.hidden = !k;
        saveDraft();
    }

    for (const slot of $$('[data-edit-slot]', editForm)) {
        const n = Number(slot.dataset.editSlot);
        $('[data-slot-upload]', slot).addEventListener('change', async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            const g = await loadImage(file);
            if (g) configureSlot(n, g);
        });
        $('[data-slot-clear]', slot)?.addEventListener('click', () => configureSlot(n, null));
        const box = $('[data-slot-box]', slot);
        box.addEventListener('dragover', (event) => {
            event.preventDefault();
            box.dataset.drag = 'over';
        });
        box.addEventListener('dragleave', () => delete box.dataset.drag);
        box.addEventListener('drop', async (event) => {
            event.preventDefault();
            delete box.dataset.drag;
            const g = await loadImage(event.dataTransfer?.files?.[0]);
            if (g) configureSlot(n, g);
        });
    }

    /* Düzenle türü: Görsel | Şarkı (her biri kendi formu); yenileyince varsayılana döner. */
    function editTypeApply() {
        const type = $('[data-edit-type] input:checked')?.value ?? 'image';
        $$('[data-edit-form]').forEach((f) => {
            f.hidden = f.dataset.editForm !== type;
        });
    }
    $('[data-edit-type]').addEventListener('change', editTypeApply);
    editTypeApply();

    /* Şarkı düzenle: kaynak şarkı (yüklenen ya da galeriden) */
    const songForm = $('[data-job-form="song"]');

    function configureSong(m) {
        songForm.source.value = m?.source ?? '';
        $('[data-song-name]', songForm).textContent = m?.name ?? 'No song selected';
        const listen = $('[data-song-listen]', songForm);
        listen.hidden = !m?.url;
        if (m?.url) listen.src = m.url;
        else listen.removeAttribute('src');
        saveDraft();
    }

    $('[data-song-upload]', songForm).addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const j = await api(`/api/music/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
            configureSong(j.music);
            notify(j.message, 'success');
        } catch (e) {
            notify(e.message, 'danger');
        }
    });

    /* Ses düzenle / Video düzenle: dosya alanları (gizli girdi + ad + önizleme) */
    const voiceEditForm = $('[data-job-form="audioEdit"]');
    const videoEditForm = $('[data-job-form="videoEdit"]');
    const FILE_FIELDS = {
        audioEdit: { form: voiceEditForm, prefix: 'audio-edit', free: 'No audio selected', preview: 'data-audio-edit-listen' },
        videoEdit: { form: videoEditForm, prefix: 'video-edit', free: 'No video selected', preview: 'data-video-edit-watch' },
        videoMusic: { form: videoEditForm, prefix: 'video-music', free: 'No music', preview: null },
    };

    function configureFileField(target, d) {
        const a = FILE_FIELDS[target];
        $(`[data-${a.prefix}-field]`, a.form).value = d?.source ?? '';
        $(`[data-${a.prefix}-name]`, a.form).textContent = d?.name ?? a.free;
        if (a.preview) {
            const o = $(`[${a.preview}]`, a.form);
            o.hidden = !d?.url;
            if (d?.url) o.src = d.url;
            else o.removeAttribute('src');
        }
        saveDraft();
    }

    for (const [target, path] of [['audioEdit', '/api/record/upload'], ['videoEdit', '/api/record/upload'], ['videoMusic', '/api/music/upload']]) {
        const a = FILE_FIELDS[target];
        $(`[data-${a.prefix}-upload]`, a.form).addEventListener('change', async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            try {
                $(`[data-${a.prefix}-name]`, a.form).textContent = `Uploading: ${file.name}`;
                const j = await api(`${path}?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
                configureFileField(target, j.record ?? j.music);
                notify(j.message, 'success');
            } catch (e) {
                configureFileField(target, null);
                notify(e.message, 'danger');
            }
        });
    }
    $('[data-video-music-clear]', videoEditForm).addEventListener('click', () => configureFileField('videoMusic', null));

    /* 3D model: kaynak görsel ya da videodan kare (TRELLIS.2); Blender yoksa yalnız GLB. */
    const m3Form = $('[data-job-form="model3d"]');

    function configureM3Image(k) {
        status.m3Image = k ?? null;
        const slot = $('[data-m3-slot]', m3Form);
        $('[data-slot-field]', slot).value = k?.source ?? '';
        const picture = $('[data-slot-picture]', slot);
        $('[data-slot-empty]', slot).hidden = Boolean(k);
        picture.hidden = !k;
        if (k) picture.src = k.previewUrl ?? k.url;
        else picture.removeAttribute('src');
        $('[data-m3-remove]', m3Form).hidden = !k;
        saveDraft();
    }
    $('[data-m3-remove]', m3Form).addEventListener('click', () => configureM3Image(null));

    function configureM3Video(v) {
        status.m3Video = v ?? null;
        m3Form.videoSource.value = v?.source ?? '';
        $('[data-m3v-name]', m3Form).textContent = v?.name ?? 'No video selected';
        const watch = $('[data-m3v-watch]', m3Form);
        watch.hidden = !v?.url;
        if (v?.url) watch.src = v.url;
        else watch.removeAttribute('src');
        saveDraft();
    }

    function applyM3Type() {
        const video = m3Form.sourceType.value === 'video';
        $('[data-m3-image]', m3Form).hidden = video;
        $('[data-m3-video]', m3Form).hidden = !video;
    }
    $('[data-m3-type]', m3Form).addEventListener('change', applyM3Type);

    const m3Slot = $('[data-m3-slot]', m3Form);
    $('[data-slot-upload]', m3Slot).addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        const g = await loadImage(file);
        if (g) configureM3Image(g);
    });
    const m3Box = $('[data-slot-box]', m3Slot);
    m3Box.addEventListener('dragover', (event) => {
        event.preventDefault();
        m3Box.dataset.drag = 'over';
    });
    m3Box.addEventListener('dragleave', () => delete m3Box.dataset.drag);
    m3Box.addEventListener('drop', async (event) => {
        event.preventDefault();
        delete m3Box.dataset.drag;
        const g = await loadImage(event.dataTransfer?.files?.[0]);
        if (g) configureM3Image(g);
    });

    $('[data-m3v-upload]', m3Form).addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            $('[data-m3v-name]', m3Form).textContent = `Uploading: ${file.name}`;
            const j = await api(`/api/record/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
            configureM3Video(j.record);
            notify(j.message, 'success');
        } catch (e) {
            configureM3Video(null);
            notify(e.message, 'danger');
        }
    });
    // Video durdurulan / sarılan kare: saniye kendiliğinden yazılır.
    const watchM3 = $('[data-m3v-watch]', m3Form);
    for (const event of ['pause', 'seeked']) {
        watchM3.addEventListener(event, () => {
            m3Form.time.value = (Math.round(watchM3.currentTime * 10) / 10).toFixed(1);
            saveDraft();
        });
    }

    /** Without Blender the turntable and export options are hidden (the server makes only the GLB); the print height only with STL. */
    function applyM3Blender(exists) {
        $('[data-m3-blender]', m3Form).hidden = !exists;
        $('[data-m3-blender-missing]', m3Form).hidden = exists;
        $('[data-m3-print]', m3Form).hidden = !exists || !m3Form.format_stl.checked;
    }
    m3Form.format_stl.addEventListener('change', () => applyM3Blender(Boolean(status.options?.hasBlender)));

    const videoForm = $('[data-job-form="video"]');

    function configureSource(k) {
        status.videoSource = k;
        videoForm.source.value = k?.source ?? '';
        const picture = $('[data-source-picture]', videoForm);
        $('[data-source-empty]', videoForm).hidden = Boolean(k);
        picture.hidden = !k;
        if (k) picture.src = k.url;
        else picture.removeAttribute('src');
        // The selection is kept in the form draft (it comes back after a reload); Remove clears it
        $('[data-source-remove]', videoForm).hidden = !k;
        $('[data-source-info]', videoForm).replaceChildren(...(k ? [k.name ? el('span', { translate: 'no', text: `${k.name} · ` }) : '', k.width && k.height ? `${k.width}×${k.height}` : ''] : []));
        videoFields();
        saveDraft();
    }

    $('[data-source-remove]', videoForm).addEventListener('click', () => configureSource(null));

    function orientation(width, height) {
        const ratio = width / height;
        if (ratio > 1.15) return 'landscape';
        if (ratio < 0.87) return 'portrait';
        return 'square';
    }

    /* Süre: hazır seçenek ya da özel (sayı × birim) → gizli olmayan name="sure" alanı saniye tutar. */
    function videoDuration() {
        const ready = $('[data-duration-preset]', videoForm).value;
        if (ready !== 'custom') return Number(ready);
        return Math.max(1, Math.round(Number($('[data-duration-value]', videoForm).value || 0) * Number($('[data-duration-unit]', videoForm).value || 1)));
    }

    /** Parça sayısı (sunucudaki videoParcalari ile aynı hesap). */
    function videoPartCount(duration, m) {
        const total = Math.max(5, Math.round((duration * m.fps) / 4) * 4 + 1);
        if (total <= m.frame) return 1;
        let n = 1;
        let remaining = total - m.frame;
        while (remaining > 0) {
            const k = Math.min(m.frame, Math.max(33, Math.ceil(remaining / 4) * 4 + 1));
            n += 1;
            remaining -= k - 1;
        }
        return n;
    }

    /* Kare hızı: hazır seçenek (24/30/60) ya da özel sayı; name="fps" alanı her zaman gerçek değeri tutar. */
    function applyFpsReady(choice) {
        const container = choice.closest('.field');
        const field = $('[data-fps-value]', container);
        if (choice.value === 'custom') {
            field.hidden = false;
            if (!field.value) field.value = '';
        } else {
            field.hidden = true;
            field.value = choice.value;
        }
    }

    function setupFpsPreparations() {
        $$('[data-fps-preset]').forEach((choice) => {
            const field = $('[data-fps-value]', choice.closest('.field'));
            const v = field.value;
            if ($$('option', choice).some((o) => o.value === v && o.value !== 'custom')) choice.value = v;
            else choice.value = 'custom';
            applyFpsReady(choice);
        });
    }

    document.addEventListener('change', (event) => {
        if (event.target.matches('[data-fps-preset]')) {
            applyFpsReady(event.target);
            event.target.closest('[data-job-form]')?.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });

    $('[data-duration-preset]', videoForm).addEventListener('change', () => {
        const custom = $('[data-duration-preset]', videoForm).value === 'custom';
        $('[data-duration-custom]', videoForm).hidden = !custom;
        if (custom) $('[data-duration-value]', videoForm).focus();
    });

    /** Egitilmis video LoRA'lari (Model egitimi > Video) Video sekmesindeki secime. */
    function videoLoras(b) {
        const choice = videoForm?.lora;
        if (!choice) return;
        const previous = choice.value;
        const loras = (b?.trained ?? []).filter((m) => m.field === 'video' && m.lora);
        choice.replaceChildren(el('option', { value: '', text: 'None' }), ...loras.map((m) => el('option', { value: m.lora, text: `${m.name} · trigger "${m.trigger ?? ''}"`, 'data-trigger': m.trigger ?? '' })));
        if ([...choice.options].some((o) => o.value === previous)) choice.value = previous;
        status.hasVideoLora = loras.length > 0;
        videoFields();
    }

    function videoFields() {
        const s = status.options;
        if (!s) return;
        const m = s.videoModels.find((x) => x.id === videoForm.model.value);
        if (!m) return;
        const loraField = $('[data-video-lora]', videoForm);
        if (loraField) {
            const show = m.id === 'wan5' && Boolean(status.hasVideoLora);
            loraField.hidden = !show;
            if (!show) videoForm.lora.value = '';
            $('[data-video-lora-strength]', videoForm).hidden = !show || !videoForm.lora.value;
            const t = videoForm.lora.selectedOptions[0]?.dataset.trigger;
            $('[data-video-lora-hint]', videoForm).textContent = t ? `Trigger word "${t}" is added to the prompt automatically.` : 'LoRAs you trained under Model training > Video (Wan 2.2 5B only).';
        }
        const k = status.videoSource;
        const direction = k?.width && k?.height ? orientation(Number(k.width), Number(k.height)) : 'landscape';
        // 1080p: İnce ayarlar › Doğrudan 1080p açıksa Wan 1920×1088 üretir (kırpılır); kapalıysa 720p üretilip büyütülür
        const upscale = videoForm.resolution.value === '1080p' && !s.fineSettings?.video1080p;
        const [width, height] = (m.size[upscale ? '720p' : videoForm.resolution.value] ?? m.size['720p'])[direction];
        const trimmed = width === 1088 || height === 1088;
        const target1080 = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1440, 1440] }[direction];
        const second = videoDuration();
        const part = videoPartCount(second, m);
        const frame = Math.min(m.frame, Math.max(5, Math.round((second * m.fps) / 4) * 4 + 1));
        $('[data-video-size-hint]', videoForm).textContent = upscale
            ? `${target1080[0]} × ${target1080[1]} (${width} × ${height} generated and upscaled) · ${m.fps} fps · ${frame} frames per part${k ? '' : ' (orientation is set once an image is chosen)'}`
            : trimmed
            ? `${width === 1088 ? 1080 : width} × ${height === 1088 ? 1080 : height} (cropped from 1088) · ${m.fps} fps · ${frame} frames per part${k ? '' : ' (orientation is set once an image is chosen)'}`
            : `${width} × ${height} · ${m.fps} fps · ${frame} frames per part${k ? '' : ' (orientation is set once an image is chosen)'}`;
        // Sure ipucu: parca sayisi + bu makinede olculen parca suresi.
        const unit = status.averages[`video/${m.id}/${videoForm.resolution.value}`];
        const partSec = unit ? unit * ((m.frame - 1) / m.fps) : null;
        const long = second > 60;
        // Anahtar kare (A14B, cok parca, kutu isaretli): her parcanin sonu ilk gorselden; sure anahtar kareyi de katar (tahminleriGuncelle ile ayni)
        const key = Boolean(videoForm.keyFrame?.checked) && m.id === 'wan14' && part > 1;
        let hint = `Long videos are generated in ${Math.round((m.frame - 1) / m.fps)}-second parts and joined; each part continues from the previous part's last frame.`;
        if (key) hint += ' Keyframes on: the end of each part is drawn from the first image, so the character stays tied to the source.';
        if (partSec) hint += ` Each part takes about ${durationText(partSec)}; ${part} parts ≈ ${durationText(partSec * part)}.${key ? ` Keyframes ≈ ${durationText(part * (status.averages['video/key'] ?? partSec * 0.4))} more.` : ''}`;
        else hint += ` ${part} segments will be generated (no timing measured on this machine yet; a 720p segment on a 12 GB card ≈ 6-7 min).`;
        if (long && videoForm.resolution.value === '720p') hint += ' For long videos, Fine settings → 480p is much faster.';
        if (upscale) hint += ' 1080p: Wan generates 720p and each segment is upscaled to 1920×1080 with a 2x AI model (for direct 1080p see Settings › Fine settings; needs a powerful card).';
        else if (videoForm.resolution.value === '1080p') hint += ' 1080p is not official (Wan was trained up to 720p): a segment takes several times longer than 720p; if the image breaks up, choose 720p.';
        if (second >= 600) hint += ' In very long videos the picture can drift between parts; color stabilization is on.';
        $('[data-duration-hint]', videoForm).textContent = hint;
        const target = Number(videoForm.fps.value);
        const factor = target > m.fps ? Math.min(8, Math.ceil(target / m.fps - 0.01)) : 1;
        $('[data-smooth-hint]', videoForm).textContent = !target
            ? `This model generates ${m.fps} frames per second.`
            : target > m.fps
              ? `Frames are interpolated ${factor}× (${m.fps * factor} fps), then converted to ${target} fps: smoother motion, longer generation.`
              : `The video is converted to ${target} frames per second.`;
        $('[data-model-hint="video"]', videoForm).textContent = m.files?.join(', ') ?? '';
    }

    videoForm.addEventListener('change', videoFields);

    async function loadImage(file) {
        if (!file) return null;
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
            notify('Only PNG, JPEG or WebP can be uploaded.', 'danger');
            return null;
        }
        try {
            const j = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file, type: file.type });
            notify(j.message, 'success');
            return j.image;
        } catch (e) {
            notify(e.message, 'danger');
            return null;
        }
    }

    $('[data-image-upload]', videoForm).addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        const g = await loadImage(file);
        if (g) configureSource(g);
    });

    const releaseField = $('[data-source-box]', videoForm);
    releaseField.addEventListener('dragover', (event) => {
        event.preventDefault();
        releaseField.dataset.drag = 'over';
    });
    releaseField.addEventListener('dragleave', () => {
        delete releaseField.dataset.drag;
    });
    releaseField.addEventListener('drop', async (event) => {
        event.preventDefault();
        delete releaseField.dataset.drag;
        const g = await loadImage(event.dataTransfer.files?.[0]);
        if (g) configureSource(g);
    });

    // Galeriden / önizlemeden "Videoya aktar".
    document.addEventListener('click', (event) => {
        const d = event.target.closest('[data-to-video]');
        if (!d) return;
        configureSource({ source: d.dataset.toVideo, url: d.dataset.url, width: d.dataset.width, height: d.dataset.height, name: '' });
        if (!previewWindow.hidden) window.ndsCloseWindow?.(previewWindow);
        location.hash = '#video';
        notify('Image sent to the video form.', 'success');
    });

    /* ── Görsel seçici penceresi (Video ve sahneler) ───────────────────── */

    const pickerWindow = $('#modal-picker');

    document.addEventListener('click', async (event) => {
        const trigger = event.target.closest('[data-picker-target]');
        if (!trigger) return;
        const target = trigger.dataset.pickerTarget;
        status.pickerTarget = target === 'scene' ? trigger.closest('[data-scene]') : target.startsWith('edit:') || target === 'model3d' ? target : 'video';
        status.pickerChoice = null;
        $('[data-picker-select]', pickerWindow).disabled = true;
        const list = $('[data-picker-list]', pickerWindow);
        list.replaceChildren(el('p', { class: 'text-sm text-muted', text: 'Loading…' }));
        try {
            const j = await api('/api/images');
            if (!j.images.length) {
                list.replaceChildren(el('div', { class: 'empty' },
                    el('p', { class: 'empty__title', text: 'No images' }),
                    el('p', { class: 'empty__text', text: 'Generate one in the Image section first or upload an image.' })));
                return;
            }
            status.pickerList = j.images;
            status.pickerPage = 1;
            renderPicker();
        } catch (e) {
            list.replaceChildren(el('p', { class: 'field__error', text: e.message }));
        }
    });

    function renderPicker() {
        const d = slice(status.pickerList ?? [], status.pickerPage);
        status.pickerPage = d.page;
        $('[data-picker-list]', pickerWindow).replaceChildren(...d.items.map((g) => el(
            'button',
            { type: 'button', class: 'picker__item', 'aria-pressed': String(status.pickerChoice?.source === g.source), 'data-picker-item': JSON.stringify(g) },
            el('img', { src: g.previewUrl, alt: '', loading: 'lazy' }),
            g.name ? el('span', { class: 'truncate', translate: 'no', title: g.name, text: g.name }) : el('span', { class: 'truncate', text: g.uploaded ? 'Uploaded' : '' }),
            el('span', { class: 'code', text: g.width && g.height ? `${g.width}×${g.height}` : '' }),
        )));
        const nav = pagination(d, (n) => {
            status.pickerPage = n;
            renderPicker();
        });
        $('[data-picker-pagination]', pickerWindow).replaceChildren(...(nav ? [nav] : []));
    }

    /* ── Ses seçici: film müziği ya da sahne anlatımı galeriden ─────────── */

    const voicePicker = $('#modal-voice-picker');

    document.addEventListener('click', async (event) => {
        const trigger = event.target.closest('[data-voice-picker]');
        if (!trigger) return;
        const pickerType = trigger.dataset.voicePicker;
        status.voicePickerTarget = pickerType === 'scene' ? trigger.closest('[data-scene]') : ['song', 'audioEdit', 'videoEdit', 'videoMusic', 'model3d'].includes(pickerType) ? pickerType : 'music';
        const videoMu = pickerType === 'videoEdit' || pickerType === 'model3d';
        $('#voice-picker-title').textContent = videoMu ? 'Pick a video from the gallery' : 'Choose audio from gallery';
        const list = $('[data-voice-picker-list]', voicePicker);
        list.replaceChildren(el('p', { class: 'text-sm text-muted', text: 'Loading…' }));
        try {
            const items = [];
            if (videoMu) {
                // Video düzenle: panelin videoları, filmleri, düzenlenmiş videoları ve yüklenen videolar
                const [v, t, d, y] = await Promise.all([api('/api/v1/gallery?type=video'), api('/api/v1/gallery?type=film'), api('/api/v1/gallery?type=videoEdit'), api('/api/v1/uploads')]);
                for (const job of [...v.gallery, ...t.gallery, ...d.gallery]) {
                    const c = job.outputs.find((x) => x.type === 'video');
                    if (c) items.push({ source: c.source, url: c.url, name: job.title, type: 'Video', duration: c.duration, dateText: job.creation, video: true });
                }
                for (const x of y.uploads.filter((x) => x.type === 'record' && /.(mp4|mov|mkv|webm|avi|m4v|3gp)$/i.test(x.source))) items.push({ source: x.source, url: x.url, name: x.name, type: 'Uploaded', video: true });
                status.voicePickerList = items;
                status.voicePickerPage = 1;
                renderVoicePicker();
                return;
            }
            const [m, s, y] = await Promise.all([api('/api/v1/gallery?type=music'), api('/api/v1/gallery?type=voice'), api('/api/v1/uploads')]);
            for (const job of [...m.gallery, ...s.gallery]) {
                const c = job.outputs.find((x) => x.type === 'voice');
                if (c) items.push({ source: c.source, url: c.url, name: job.title, type: job.type === 'music' ? 'Music' : 'Voice', duration: c.duration, dateText: job.creation });
            }
            for (const x of y.uploads.filter((x) => x.type === 'music')) items.push({ source: x.source, url: x.url, name: x.name, type: 'Uploaded' });
            // Sahne anlatımında önce sesler, film müziğinde önce müzikler.
            if (status.voicePickerTarget !== 'music') items.sort((a, b) => (a.type === 'Voice' ? -1 : 0) - (b.type === 'Voice' ? -1 : 0));
            status.voicePickerList = items;
            status.voicePickerPage = 1;
            renderVoicePicker();
        } catch (e) {
            list.replaceChildren(el('p', { class: 'field__error', text: e.message }));
        }
    });

    function renderVoicePicker() {
        const list = $('[data-voice-picker-list]', voicePicker);
        const d = slice(status.voicePickerList ?? [], status.voicePickerPage, 8);
        status.voicePickerPage = d.page;
        if (!d.total) {
            list.replaceChildren(el('div', { class: 'empty' },
                el('p', { class: 'empty__title', text: 'No audio' }),
                el('p', { class: 'empty__text', text: 'Generate some in the Music or Voice section first.' })));
        } else {
            list.replaceChildren(...d.items.map((o) => el('div', { class: 'voice-picker__row' },
                el('div', { class: 'row row--between' },
                    el('span', { class: 'line-title truncate', translate: 'no', title: o.name, text: o.name || '—' }),
                    el('span', { class: 'code', text: [o.type, o.duration ? `${number(o.duration)} s` : null].filter(Boolean).join(' · ') })),
                el('div', { class: 'row' },
                    o.video ? el('video', { controls: true, preload: 'metadata', playsinline: true, class: 'picker-video', src: o.url }) : el('audio', { controls: true, preload: 'none', src: o.url }),
                    el('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-voice-select-item': JSON.stringify(o), text: 'Select' })))));
        }
        const nav = pagination(d, (n) => {
            status.voicePickerPage = n;
            renderVoicePicker();
        });
        $('[data-voice-picker-pagination]', voicePicker).replaceChildren(...(nav ? [nav] : []));
    }

    voicePicker.addEventListener('click', (event) => {
        const b = event.target.closest('[data-voice-select-item]');
        if (!b) return;
        const o = JSON.parse(b.dataset.voiceSelectItem);
        const target = status.voicePickerTarget;
        if (target === 'music') {
            configureMusic({ source: o.source, name: o.name });
        } else if (target === 'song') {
            configureSong({ source: o.source, name: o.name, url: o.url });
        } else if (target === 'model3d') {
            configureM3Video({ source: o.source, name: o.name, url: o.url });
        } else if (typeof target === 'string' && FILE_FIELDS[target]) {
            configureFileField(target, { source: o.source, name: o.name, url: o.url });
        } else if (target instanceof HTMLElement) {
            target.dataset.voiceSource = o.source;
            target.dataset.voiceName = o.name;
            applyNarrationMode(target);
            saveDraft();
        }
        window.ndsCloseWindow?.(voicePicker);
    });

    function applyPicker() {
        const g = status.pickerChoice;
        if (!g) return;
        if (status.pickerTarget === 'video') configureSource(g);
        else if (status.pickerTarget === 'model3d') configureM3Image(g);
        else if (typeof status.pickerTarget === 'string' && status.pickerTarget.startsWith('edit:')) configureSlot(Number(status.pickerTarget.slice(5)), g);
        else if (status.pickerTarget instanceof HTMLElement) sceneSource(status.pickerTarget, g);
        window.ndsCloseWindow?.(pickerWindow);
    }

    pickerWindow.addEventListener('click', (event) => {
        const item = event.target.closest('[data-picker-item]');
        if (item) {
            $$('[data-picker-item]', pickerWindow).forEach((o) => o.setAttribute('aria-pressed', String(o === item)));
            status.pickerChoice = JSON.parse(item.dataset.pickerItem);
            $('[data-picker-select]', pickerWindow).disabled = false;
            if (event.detail >= 2) applyPicker();
            return;
        }
        if (event.target.closest('[data-picker-select]')) applyPicker();
    });

    /* ── Tek parça: sahneler ───────────────────────────────────────────── */

    const filmForm = $('[data-job-form="film"]');
    const sceneContainer = $('[data-scenes]', filmForm);

    function addScene(data = {}, { focus = false } = {}) {
        const scene = $('#scene-template').content.firstElementChild.cloneNode(true);
        $$('[data-for]', scene).forEach((tag) => {
            const field = tag.closest('.field').querySelector(`[data-field="${tag.dataset.for}"]`);
            fieldCounter += 1;
            field.id = `scene-${tag.dataset.for}-${fieldCounter}`;
            tag.htmlFor = field.id;
        });
        for (const name of ['narration', 'image', 'motion']) $(`[data-field="${name}"]`, scene).value = data[name] ?? '';
        // Replikler: yazardan dizi ([{ kim, metin }]) ya da taslaktan metin ("Ad: söz" satirlari)
        const k = data.dialogue;
        $('[data-field="dialogue"]', scene).value = Array.isArray(k) ? k.map((x) => `${x.who}: ${x.text}`).join('\n') : k ?? '';
        // Görsel kaynağı: üretilsin ya da galeriden (sahne başına tek seçim).
        fieldCounter += 1;
        $$('[data-image-mode] input', scene).forEach((r) => {
            r.name = `imageMode-${fieldCounter}`;
            r.checked = r.value === (data.source ? 'gallery' : 'generate');
        });
        $$('[data-narration-mode] input', scene).forEach((r) => {
            r.name = `narrationMode-${fieldCounter}`;
            r.checked = r.value === (data.voiceSource ? 'gallery' : 'speak');
        });
        scene.dataset.voiceSource = data.voiceSource ?? '';
        scene.dataset.voiceName = data.voiceName ?? '';
        sceneContainer.append(scene);
        if (data.source) sceneSource(scene, { source: data.source, url: data.sourceUrl, name: data.sourceName });
        applyImageMode(scene);
        applyNarrationMode(scene);
        scenesNumber();
        if (focus) $('[data-field="narration"]', scene).focus();
        return scene;
    }

    function sceneSource(scene, g) {
        scene.dataset.source = g?.source ?? '';
        scene.dataset.sourceUrl = g?.url ?? g?.previewUrl ?? '';
        scene.dataset.sourceName = g?.name ?? '';
        const line = $('[data-scene-source]', scene);
        $('.media--small', line)?.remove();
        if (g?.source) line.prepend(el('span', { class: 'media media--small' }, el('img', { src: scene.dataset.sourceUrl, alt: '' })));
        $('[data-scene-source-name]', scene).textContent = g?.source ? 'This image will be used.' : 'No image selected';
        saveDraft();
    }

    const imageMode = (scene) => $('[data-image-mode] input:checked', scene)?.value ?? 'generate';

    function applyImageMode(scene) {
        const mode = imageMode(scene);
        $('[data-image-generate]', scene).hidden = mode !== 'generate';
        $('[data-scene-source]', scene).hidden = mode !== 'gallery';
    }

    function narrationDuration(text) {
        const speed = Number(filmForm.querySelector('[name="speed"]')?.value || 1);
        return text.trim().length / SPEECH_RATE / speed;
    }

    function scenesNumber() {
        const scenes = $$('[data-scene]', sceneContainer);
        let total = 0;
        scenes.forEach((s, i) => {
            $('[data-scene-title]', s).textContent = `Scene ${i + 1}`;
            $('[data-scene-remove]', s).hidden = scenes.length === 1;
            // Replikler de sureye katilir (satirlar arasi 0,3 sn)
            const lines = $('[data-field="dialogue"]', s).value.split('\n').map((x) => x.replace(/^[^:]{1,40}:/, '').trim()).filter(Boolean);
            const duration = narrationDuration([$('[data-field="narration"]', s).value, ...lines].join(' ')) + (lines.length ? lines.length * 0.3 : 0);
            total += duration ? duration + 1.3 : 0;
            $('[data-scene-duration]', s).textContent = duration ? `≈ ${number(duration)} s narration; scene ≈ ${number(Math.max(2.5, duration + 1.3))} s` : 'Scene length matches the narration.';
        });
        $('[data-scene-summary]', filmForm).textContent = `${scenes.length} scenes · film ≈ ${durationText(total)} (approx.)`;
        updateEstimates();
    }

    function scenesCollect() {
        return $$('[data-scene]', sceneContainer).map((s) => ({
            narration: $('[data-field="narration"]', s).value,
            image: imageMode(s) === 'generate' ? $('[data-field="image"]', s).value : '',
            motion: $('[data-field="motion"]', s).value,
            dialogue: $('[data-field="dialogue"]', s).value,
            source: imageMode(s) === 'gallery' ? s.dataset.source || '' : '',
            sourceUrl: s.dataset.sourceUrl || '',
            sourceName: s.dataset.sourceName || '',
            voiceSource: narrationMode(s) === 'gallery' ? s.dataset.voiceSource || '' : '',
            voiceName: s.dataset.voiceName || '',
        }));
    }

    /* ── Tek parça: karakterler (konuşanlar) ────────────────────────────── */
    // Konusmalardaki adlar; cinsiyet/yas/ses ad basina (07.10.2026: karakterler kadin/erkek, yasina uygun sesle konusur).
    // durum.karakterler: { [kucuk ad]: { cinsiyet, yas, ses, tarif } } (taslakta saklanir).
    status.characters = {};
    const characterPanel = $('[data-characters]', filmForm);
    const CHARACTER_GENDER = [['', '— choose —'], ['female', 'Female'], ['male', 'Male']];
    const CHARACTER_AGE = [['child', 'Child'], ['young', 'Young'], ['adult', 'Adult'], ['old', 'Elderly']];
    const CHARACTER_TYPE = [['human', 'Human'], ['animal', 'Animal']];
    // Tür seçilmemişse tariften (sunucudaki karakterler.mjs turBul ile aynı sözcükler): konuşan hayvan insan sesiyle konuşmasın
    const ANIMAL_WORD = /\b(kitten|kitty|cat|puppy|dog|bunny|rabbit|bird|parrot|owl|fox|bear|cub|mouse|squirrel|duck|duckling|chick|frog|lion|tiger|horse|pony|monkey|penguin|dragon|animal)s?\b|kedi|köpek|tavşan|kuş|tilki|sincap|ördek|civciv|kurbağa|aslan|kaplan|maymun|penguen|ejderha|hayvan/;
    const characterType = (k) => k.type || (ANIMAL_WORD.test(String(k.spec ?? '').toLocaleLowerCase('tr')) ? 'animal' : 'human');
    const characterKey = (name) => String(name).trim().toLocaleLowerCase('tr');

    function speakers() {
        const names = [];
        for (const s of $$('[data-scene]', sceneContainer)) {
            for (const line of $('[data-field="dialogue"]', s).value.split('\n')) {
                const m = line.match(/^\s*([^:]{1,40}):\s*\S/);
                if (m && !names.some((a) => characterKey(a) === characterKey(m[1]))) names.push(m[1].trim());
            }
        }
        return names;
    }

    function renderCharacters() {
        const names = speakers();
        characterPanel.hidden = !names.length;
        const voices = status.options?.voices ?? [];
        const choice = (name, field, options, value, tag) => {
            const s = el('select', { class: 'select', 'data-character-field': field, 'data-character': name, 'aria-label': tag },
                ...options.map(([v, t]) => el('option', { value: v, translate: field === 'voice' && v ? 'no' : null, text: t })));
            s.value = value;
            if (field === 'gender' && !value) s.setAttribute('aria-invalid', 'true');
            return el('label', { class: 'field' }, el('span', { class: 'field__label', text: tag }), s);
        };
        $('[data-character-list]', characterPanel).replaceChildren(...names.map((name) => {
            const k = status.characters[characterKey(name)] ?? {};
            return el('div', { class: 'character-line', 'data-character-line': name },
                el('strong', { translate: 'no', text: name }),
                el('div', { class: 'form-grid' },
                    choice(name, 'gender', CHARACTER_GENDER, k.gender ?? '', 'Gender'),
                    choice(name, 'age', CHARACTER_AGE, k.age ?? 'adult', 'Age'),
                    choice(name, 'type', CHARACTER_TYPE, characterType(k), 'Type'),
                    choice(name, 'voice', [['', 'Automatic (by gender, age and kind)'], ...voices.map((s) => [`ref:${s.id}`, s.name])], k.voice ?? '', 'Voice'),
                    el('label', { class: 'field' }, el('span', { class: 'field__label', text: 'Voice description (English, optional)' }),
                        el('input', { class: 'input', 'data-character-field': 'spec', 'data-character': name, value: k.spec ?? '', placeholder: 'soft and shy', maxlength: '300' }))));
        }));
    }

    function charactersCollect() {
        return speakers().map((name) => {
            const k = status.characters[characterKey(name)] ?? {};
            return { name, gender: k.gender ?? '', age: k.age ?? 'adult', type: characterType(k), voice: k.voice ?? '', spec: k.spec ?? '' };
        });
    }

    characterPanel.addEventListener('change', (event) => {
        const a = event.target.closest('[data-character-field]');
        if (!a) return;
        const key = characterKey(a.dataset.character);
        status.characters[key] = { ...(status.characters[key] ?? {}), [a.dataset.characterField]: a.value };
        if (a.dataset.characterField === 'gender') a.toggleAttribute('aria-invalid', !a.value);
        saveDraft();
    });
    let characterTimer = null;
    sceneContainer.addEventListener('input', (event) => {
        if (!event.target.matches('[data-field="dialogue"]')) return;
        clearTimeout(characterTimer);
        characterTimer = setTimeout(renderCharacters, 400);
    });

    const narrationMode = (scene) => $('[data-narration-mode] input:checked', scene)?.value ?? 'speak';

    function applyNarrationMode(scene) {
        const gallery = narrationMode(scene) === 'gallery';
        $('[data-narration-gallery]', scene).hidden = !gallery;
        $('[data-field="narration"]', scene).placeholder = gallery ? 'Text of this audio (for subtitles; optional)' : 'Once upon a time, there were endless worlds made of blocks.';
        const text = $('[data-narration-voice-name]', scene);
        text.translate = !scene.dataset.voiceSource;
        text.textContent = scene.dataset.voiceSource ? scene.dataset.voiceName || 'Audio selected' : 'No audio selected';
    }

    $('[data-scene-add]', filmForm).addEventListener('click', () => {
        addScene({}, { focus: true });
        saveDraft();
    });

    sceneContainer.addEventListener('click', (event) => {
        const scene = event.target.closest('[data-scene]');
        if (!scene) return;
        if (event.target.closest('[data-scene-remove]')) {
            scene.remove();
        } else {
            return;
        }
        scenesNumber();
        saveDraft();
    });

    sceneContainer.addEventListener('input', scenesNumber);

    /*
     * Sahne sıralama: başlıktaki tutamaktan sürükle-bırak. HTML5 sürükleme iPhone'da
     * çalışmadığı için işaretçi (pointer) olaylarıyla: fare, dokunmatik ve kalem aynı yol.
     * Klavyede tutamak odaktayken ↑ / ↓ sahneyi bir yukarı/aşağı taşır.
     */
    let moved = null;
    let scroll = 0;
    const page = $('[data-page]');

    function placeScene(y) {
        const others = $$('[data-scene]', sceneContainer).filter((s) => s !== moved);
        const target = others.find((s) => {
            const k = s.getBoundingClientRect();
            return y < k.top + k.height / 2;
        });
        if (target) {
            if (moved.nextElementSibling !== target) sceneContainer.insertBefore(moved, target);
        } else if (sceneContainer.lastElementChild !== moved) {
            sceneContainer.append(moved);
        }
    }

    // Sürüklenen sahne işaretçiyi izler: doğal yerine göre kaydırma (translateY) tutulur.
    let holdingDiff = 0;
    let herdScroll = 0;

    function scenePlay(y) {
        const dogal = moved.getBoundingClientRect().top - herdScroll;
        herdScroll = y - holdingDiff - dogal;
        moved.style.transform = `translateY(${herdScroll}px)`;
    }

    sceneContainer.addEventListener('pointerdown', (event) => {
        const handle = event.target.closest('[data-scene-handle]');
        if (!handle || event.button > 0) return;
        event.preventDefault();
        moved = handle.closest('[data-scene]');
        try {
            handle.setPointerCapture(event.pointerId);
        } catch {
            /* yapay olay (test) ya da işaretçi kayboldu: yakalamasız da çalışır */
        }
        holdingDiff = event.clientY - moved.getBoundingClientRect().top;
        herdScroll = 0;
        moved.classList.add('is-dragging');
    });

    sceneContainer.addEventListener('pointermove', (event) => {
        if (!moved) return;
        placeScene(event.clientY);
        scenePlay(event.clientY);
        // Kenara yaklaşınca sayfa kendiliğinden kayar (uzun sahne listesi).
        const share = 80;
        scroll = event.clientY < share ? -14 : event.clientY > innerHeight - share ? 14 : 0;
        if (scroll) page.scrollBy(0, scroll);
    });

    const finishDrag = () => {
        if (!moved) return;
        moved.classList.remove('is-dragging');
        moved.style.transform = '';
        herdScroll = 0;
        moved = null;
        scroll = 0;
        scenesNumber();
        saveDraft();
    };
    sceneContainer.addEventListener('pointerup', finishDrag);
    sceneContainer.addEventListener('pointercancel', finishDrag);

    sceneContainer.addEventListener('keydown', (event) => {
        const handle = event.target.closest('[data-scene-handle]');
        if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const scene = handle.closest('[data-scene]');
        if (event.key === 'ArrowUp') scene.previousElementSibling?.before(scene);
        else scene.nextElementSibling?.after(scene);
        handle.focus();
        scenesNumber();
        saveDraft();
    });

    sceneContainer.addEventListener('change', (event) => {
        if (!event.target.closest('[data-image-mode], [data-narration-mode]')) return;
        const scene = event.target.closest('[data-scene]');
        applyImageMode(scene);
        applyNarrationMode(scene);
        scenesNumber();
        saveDraft();
    });

    /* ── Tek parça: müzik ──────────────────────────────────────────────── */

    function showMusic() {
        const name = $('[data-music-name-field]', filmForm).value;
        const exists = Boolean($('[data-music-source]', filmForm).value);
        const text = $('[data-music-name]', filmForm);
        text.translate = !(exists && name);
        text.textContent = exists ? name || 'Music selected' : 'No music';
        const galleryText = $('[data-music-name-gallery]', filmForm);
        galleryText.translate = !(exists && name);
        galleryText.textContent = exists ? name || 'Music selected' : 'No music selected';
    }

    // Müzik sekmesi: Yok / Üretilsin / Galeriden / Yükle; yalnız seçilen sekmenin alanı görünür.
    function applyMusicMode() {
        const mode = filmForm.musicMode.value || 'none';
        $$('[data-music-section]', filmForm).forEach((b) => {
            b.hidden = b.dataset.musicSection !== mode;
        });
        $('[data-music-hint]', filmForm).hidden = mode === 'none';
        const level = filmForm.querySelector('[name="musicLevel"]')?.closest('.field');
        if (level) level.hidden = mode === 'none';
    }

    $('[data-music-mode]', filmForm).addEventListener('change', () => {
        applyMusicMode();
        saveDraft();
    });

    function configureMusic(m) {
        $('[data-music-source]', filmForm).value = m?.source ?? '';
        $('[data-music-name-field]', filmForm).value = m?.name ?? '';
        showMusic();
        saveDraft();
    }

    $('[data-music-upload]', filmForm).addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        $('[data-music-name]', filmForm).textContent = 'Loading…';
        try {
            const j = await api(`/api/music/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
            notify(j.message, 'success');
            configureMusic(j.music);
        } catch (e) {
            notify(e.message, 'danger');
            showMusic();
        }
    });


    /* ── Tek parça: sahneleri panel mi yazsın, kullanıcı mı ─────────────── */

    function applySceneMode() {
        const hasWriter = Boolean(status.options?.hasSceneWriter);
        const choice = $('[data-scene-mode]', filmForm);
        choice.hidden = !hasWriter;
        if (!hasWriter) filmForm.sceneMode.value = 'manual';
        const auto = filmForm.sceneMode.value === 'automatic';
        $('[data-scene-writer]', filmForm).hidden = !auto;
        // Panel yazınca sahneler gözden geçirmek için görünür; yazılmadan boş sahne gösterilmez.
        const full = scenesCollect().some((x) => x.narration.trim() || x.image.trim() || x.source);
        $('[data-scene-area]', filmForm).hidden = auto && !full;
        $('[data-scene-add]', filmForm).hidden = auto;
    }

    $('[data-scene-mode]', filmForm).addEventListener('change', applySceneMode);

    /* ── Tek parça: konudan sahne yazımı ───────────────────────────────── */

    // Sahne sayisinda Enter: filmi kuyruga eklemek yerine sahneleri yazdir
    $('#t-sahne-sayisi')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        $('[data-scene-write]', filmForm).click();
    });
    $('[data-scene-write]', filmForm).addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const topic = $('[data-topic]', filmForm).value.trim();
        if (!topic) {
            notify('Write a topic first.', 'warning');
            $('[data-topic]', filmForm).focus();
            return;
        }
        const statusText = $('[data-scene-write-status]', filmForm);
        // Dolu sahneler varsa ikinci basışta yazılır (yanlışlıkla silinmesin).
        const full = scenesCollect().some((s) => s.narration.trim() || s.image.trim());
        if (full && !button.dataset.approval) {
            button.dataset.approval = '1';
            button.textContent = 'Yes, rewrite them';
            statusText.textContent = 'The current scenes will be replaced.';
            setTimeout(() => {
                delete button.dataset.approval;
                button.textContent = 'Write scenes';
                if (!button.disabled) statusText.textContent = '';
            }, 5000);
            return;
        }
        delete button.dataset.approval;
        button.textContent = 'Write scenes';
        button.disabled = true;
        statusText.textContent = 'Writing… (progress in Queue)';
        try {
            const req = api('/api/write-scenes', { method: 'POST', body: { topic, sceneCount: $('[data-scene-count]', filmForm).value, ratio: filmForm.ratio.value, speech: $('[data-speech]', filmForm)?.checked !== false } });
            // Yazim Kuyruk'ta yan gorev olarak gorunur (ilerleme, Iptal): durum hemen yoklanir
            setTimeout(pollStatus, 400);
            const j = await req;
            sceneContainer.replaceChildren();
            // Yazarin karakterleri (cinsiyet, yas, ses tarifi) listeye; ses kendiliginden secilir
            status.characters = {};
            for (const kr of j.characters ?? []) status.characters[characterKey(kr.name)] = { gender: kr.gender, age: kr.age, type: kr.type ?? '', spec: kr.spec ?? '', voice: '' };
            j.scenes.forEach((s) => addScene(s));
            renderCharacters();
            if (j.title && !filmForm.title.value.trim()) filmForm.title.value = j.title;
            $('[data-topic]', filmForm).value = '';
            scenesNumber();
            applySceneMode();
            saveDraft();
            notify(j.message, 'success');
            statusText.textContent = '';
        } catch (e) {
            notify(e.message, 'danger');
            statusText.textContent = '';
        } finally {
            button.disabled = false;
            pollStatus();
        }
    });

    /* ── Müzik: sözleri panel yazsın ───────────────────────────────────── */

    const musicForm = $('[data-job-form="music"]');

    /** Egitilmis muzik LoRA'lari (Model egitimi > Muzik) Muzik sekmesindeki secime. */
    function musicLoras(b) {
        const choice = musicForm?.lora;
        if (!choice) return;
        const previous = choice.value;
        const loras = (b?.trained ?? []).filter((m) => m.field === 'music' && m.lora);
        choice.replaceChildren(el('option', { value: '', text: 'None' }), ...loras.map((m) => el('option', { value: m.lora, text: `${m.name} · trigger "${m.trigger ?? ''}"`, 'data-trigger': m.trigger ?? '', 'data-strength': m.recommendedStrength ?? '' })));
        if ([...choice.options].some((o) => o.value === previous)) choice.value = previous;
        $('[data-music-lora]', musicForm).hidden = !loras.length;
        showMusicLora();
    }
    function showMusicLora() {
        const strength = $('[data-music-lora-strength]', musicForm);
        if (!strength) return;
        strength.hidden = !musicForm.lora.value;
        const t = musicForm.lora.selectedOptions[0]?.dataset.trigger;
        $('[data-music-lora-hint]', musicForm).textContent = t ? `Trigger word "${t}" is added to the start of the style automatically.` : 'LoRAs you trained under Model training > Music.';
    }
    musicForm?.lora?.addEventListener('change', () => {
        // Kayittaki olculmus onerilen guc (ornek: Caz 2) secilir; yoksa 1
        const g = musicForm.lora.selectedOptions[0]?.dataset.strength;
        if (musicForm.loraStrength) musicForm.loraStrength.value = g && [...musicForm.loraStrength.options].some((o) => o.value === String(g)) ? String(g) : '1';
        showMusicLora();
    });
    document.addEventListener('nedese:section', async (o) => {
        if (['music', 'single'].includes(o.detail.section)) {
            try {
                musicLoras(await api('/api/training'));
            } catch {
                /* egitim bilgisi yoksa LoRA alani gizli */
            }
        }
    });

    function applyLyricWriter() {
        $('[data-lyrics-writer]', musicForm).hidden = !status.options?.hasSceneWriter;
    }

    // Sarki konusunda Enter: muzigi kuyruga eklemek yerine sozleri yazdir
    $('#m-konu')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        $('[data-lyrics-write]', musicForm).click();
    });
    $('[data-lyrics-write]', musicForm).addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const topic = $('[data-lyrics-topic]', musicForm).value.trim();
        const style = musicForm.style.value.trim();
        if (!topic && !style) {
            notify("First write the song's topic or style.", 'warning');
            $('[data-lyrics-topic]', musicForm).focus();
            return;
        }
        const statusText = $('[data-lyrics-write-status]', musicForm);
        // Elle yazılmış sözler ikinci basışta değişir (yanlışlıkla silinmesin).
        if (musicForm.lyrics.value.trim() && !button.dataset.approval) {
            button.dataset.approval = '1';
            button.textContent = 'Yes, rewrite them';
            statusText.textContent = 'The current lyrics will be replaced.';
            setTimeout(() => {
                delete button.dataset.approval;
                button.textContent = 'Write lyrics';
                if (!button.disabled) statusText.textContent = '';
            }, 5000);
            return;
        }
        delete button.dataset.approval;
        button.textContent = 'Write lyrics';
        button.disabled = true;
        statusText.textContent = 'Writing… (10-30 s)';
        try {
            const j = await api('/api/write-lyrics', { method: 'POST', body: { topic, style, lang: musicForm.lang.value, duration: musicForm.duration.value } });
            musicForm.lyrics.value = j.lyrics;
            musicForm.lyrics.dispatchEvent(new Event('input', { bubbles: true }));
            notify(j.message, 'success');
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            statusText.textContent = '';
            button.disabled = false;
        }
    });

    /* ── Süre tahmini (bu makinede ölçülen ortancalar) ─────────────────── */

    function estimateWrite(type, second, missing) {
        const e = $(`[data-estimate="${type}"]`);
        if (!e) return;
        e.textContent = second && !missing ? `Estimated time ≈ ${durationText(second)}` : 'No measurements on this machine yet';
        e.title = 'Based on the median time of finished jobs on this machine.';
    }

    function updateEstimates() {
        const o = status.averages;
        if (!status.options) return;
        const g = imageForm;
        estimateWrite('image', (o[`image/${g.model.value}`] ?? 0) * Number(g.count.value || 1));
        const v = videoForm;
        const vModel = status.options.videoModels.find((m) => m.id === v.model.value);
        const vUnit = o[`video/${v.model.value}/${v.resolution.value}`];
        // Anahtar kare (A14B, cok parca): parca basina olculen anahtar kare suresi (video/anahtar); olcum yoksa parca suresinin 0,4'u (06.10.2026: ~150 / ~370 sn)
        const vPart = vModel ? videoPartCount(videoDuration(), vModel) : 0;
        const vPartSec = vModel && vUnit ? vUnit * ((vModel.frame - 1) / vModel.fps) : 0;
        const vKey = v.keyFrame?.checked && v.model.value === 'wan14' && vPart > 1 ? vPart * (o['video/key'] ?? vPartSec * 0.4) : 0;
        estimateWrite('video', vPartSec ? vPartSec * vPart + vKey : 0);
        const s = $('[data-job-form="voice"]');
        const quality = s.querySelector('[name="quality"]')?.value;
        estimateWrite('voice', (o[`voice/${quality}`] ?? 0) * (s.text.value.length / 100));
        const mz = $('[data-job-form="music"]');
        estimateWrite('music', (o.music ?? 0) * Number(mz.duration.value || 60));
        const m3 = o[`model3d/${m3Form.quality.value}`];
        const m3Blender = m3Form.intro.checked || ['fbx', 'obj', 'stl'].some((b) => m3Form[`format_${b}`].checked) ? (o.blender3d ?? 0) : 0;
        estimateWrite('model3d', m3 ? m3 + (m3Form.complete.checked ? (o.edit ?? 60) : 0) + (status.options.hasBlender ? m3Blender : 0) : 0);

        const f = filmForm;
        const scenes = scenesCollect();
        const vm = status.options.videoModels.find((m) => m.id === f.videoModel.value);
        const fk = f.querySelector('[name="quality"]')?.value;
        const unitVoice = o[`voice/${fk}`];
        const unitImage = o[`image/${f.imageModel.value}`];
        // Üretim önceliği (tekparca.mjs ONCELIK ile aynı): çözünürlük ve en çok yavaşlatma.
        const [resolution, slowdown] = { quality: ['720p', 1.6], speed: ['720p', 2], draft: ['480p', 2] }[f.priority?.value] ?? ['720p', 1.6];
        // 480p ölçümü yoksa 720p'nin %45'i (piksel oranı ≈ %43; tahmin).
        const unitVideo = o[`video/${f.videoModel.value}/${resolution}`] ?? (resolution === '480p' && o[`video/${f.videoModel.value}/720p`] ? o[`video/${f.videoModel.value}/720p`] * 0.45 : undefined);
        if (!vm || !unitVideo || !unitVoice || (!unitImage && scenes.some((x) => !x.source))) {
            estimateWrite('film', 0, true);
            return;
        }
        const dogal = vm.frame / vm.fps;
        // Aynı karakter: 2. sahneden itibaren görsel Qwen-Image-Edit ile (ölçüm yoksa görsel süresi).
        const unitCharacter = f.character?.checked ? (o.edit ?? unitImage) : unitImage;
        // Dudak eşleme: konuşmalı sahne 25 fps pencerelerle (81 kare, sonra +72); ölçüm sn/sn (lib/dudak.mjs)
        const lines = (x) => String(x.dialogue ?? '').split('\n').map((r) => r.replace(/^[^:]{1,40}:/, '').trim()).filter(Boolean);
        const withLips = (x) => f.lip?.checked && !x.voiceSource && lines(x).length > 0;
        const unitLip = o[`video/lip/${resolution}`];
        if (scenes.some(withLips) && !unitLip) {
            estimateWrite('film', 0, true);
            return;
        }
        let total = 0;
        scenes.forEach((x, i) => {
            // The lines count towards the length too (0.3 s between lines), as when the film numbers its scenes
            const said = lines(x);
            const target = Math.max(2.5, narrationDuration([x.narration, ...said].join(' ')) + said.length * 0.3 + 1.3);
            const part = Math.max(1, Math.ceil(target / (dogal * slowdown)));
            const frame = 81 + 72 * Math.max(0, Math.ceil((Math.ceil(target * 25) - 81) / 72));
            const video = withLips(x) ? (unitLip * frame) / 25 : part * unitVideo * dogal;
            total += unitVoice * ((x.narration.length + said.join(' ').length) / 100) + (x.source ? 0 : i ? unitCharacter : unitImage) + video + 4;
        });
        estimateWrite('film', total);
    }

    document.addEventListener('input', (event) => {
        if (event.target.closest('[data-job-form]')) updateEstimates();
        if (event.target.closest('[data-job-form="video"]')) videoFields();
    });
    document.addEventListener('change', (event) => {
        if (event.target.closest('[data-job-form]')) updateEstimates();
    });

    /* ── Gönderim ───────────────────────────────────────────────────────── */

    function formData(form) {
        const data = {};
        for (const field of form.elements) {
            if (!field.name || field.closest('[data-scene]')) continue;
            if (field.type === 'checkbox') data[field.name] = field.checked;
            else if (field.type === 'radio') {
                if (field.checked) data[field.name] = field.value;
            }
            else if (field.type === 'file' || field.type === 'submit' || field.type === 'button') continue;
            else data[field.name] = field.value;
        }
        return data;
    }

    document.addEventListener('submit', async (event) => {
        const form = event.target.closest('[data-job-form]');
        if (!form) return;
        event.preventDefault();
        const type = form.dataset.jobForm;
        const data = formData(form);
        if (type === 'film') {
            data.scenes = scenesCollect();
            data.characters = charactersCollect();
        }
        if (type === 'video') data.duration = videoDuration();
        if (type === 'edit') {
            data.references = [data.reference1, data.reference2].filter(Boolean);
            delete data.reference1;
            delete data.reference2;
        }
        if (type === 'model3d') {
            const video = data.sourceType === 'video';
            data.source = video ? data.videoSource : data.imageSource;
            if (!video) delete data.time;
            const blender = status.options?.hasBlender;
            data.formats = blender ? ['fbx', 'obj', 'stl'].filter((b) => data[`format_${b}`]) : [];
            if (!blender) data.intro = false;
            if (!data.formats.includes('stl')) delete data.printHeight;
            for (const a of ['sourceType', 'videoSource', 'imageSource', 'format_fbx', 'format_obj', 'format_stl']) delete data[a];
        }
        const button = $('button[type="submit"]', form);
        button.disabled = true;
        try {
            const j = await api('/api/job', { method: 'POST', body: { ...data, type } });
            notify(j.message, 'success');
            if (data.voice === 'spec') setTimeout(refreshVoices, 1500);
            cleanForm(type);
            pollStatus();
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            button.disabled = false;
        }
    });

    /**
     * Kuyruğa eklenen metin formda kalmaz: ana metin alanları temizlenir, ayarlar (model, oran,
     * ses seçimi, ince ayarlar) olduğu gibi kalır; taslak da buna göre güncellenir.
     */
    function cleanForm(type) {
        if (type === 'image') imageForm.prompt.value = '';
        if (type === 'edit') editForm.prompt.value = '';
        if (type === 'song') songForm.style.value = '';
        if (type === 'audioEdit') voiceEditForm.instruction.value = '';
        if (type === 'videoEdit') videoEditForm.instruction.value = '';
        if (type === 'video') videoForm.prompt.value = '';
        if (type === 'voice') $('[data-job-form="voice"]').text.value = '';
        if (type === 'music') {
            const m = $('[data-job-form="music"]');
            m.style.value = '';
            m.lyrics.value = '';
        }
        if (type === 'film') {
            $('[data-topic]', filmForm).value = '';
            filmForm.title.value = '';
            sceneContainer.replaceChildren();
            addScene();
            status.characters = {};
            renderCharacters();
            configureMusic(null);
            filmForm.musicMode.value = 'none';
            filmForm.musicStyle.value = '';
            applyMusicMode();
            scenesNumber();
            applySceneMode();
        }
        updateEstimates();
        saveDraft();
    }

    /* ── Draft (in the browser): what was typed survives a reload ─────────── */

    const DRAFT = 'aiPanel.draft.v1';
    let draftTimer = null;

    // A draft kept by the Turkish-named versions moves to the English key once, its source references rewritten
    // ("is/<id>/…", "yukleme/…", "koleksiyon/…" -> "job/…", "upload/…", "collection/…")
    try {
        const old = localStorage.getItem('aiPanel.taslak.v1');
        if (old !== null) {
            const dirs = { is: 'job', yukleme: 'upload', koleksiyon: 'collection' };
            if (localStorage.getItem(DRAFT) === null) localStorage.setItem(DRAFT, old.replace(/"(\/dosya\/)?(is|yukleme|koleksiyon)\//g, (_, file, dir) => `"${file ? '/file/' : ''}${dirs[dir]}/`));
            localStorage.removeItem('aiPanel.taslak.v1');
        }
    } catch {
        /* private tab: no stored draft */
    }

    function saveDraft() {
        clearTimeout(draftTimer);
        draftTimer = setTimeout(() => {
            const t = {};
            for (const form of $$('[data-job-form]')) t[form.dataset.jobForm] = formData(form);
            t.film.scenes = scenesCollect();
            t.film.characters = status.characters;
            t.video.durationReady = $('[data-duration-preset]', videoForm).value;
            t.video.durationUnit = $('[data-duration-unit]', videoForm).value;
            t.videoSource = status.videoSource;
            t.m3Image = status.m3Image;
            t.m3Video = status.m3Video;
            try {
                localStorage.setItem(DRAFT, JSON.stringify(t));
            } catch {
                /* gizli sekme: taslak yalnızca bu sayfada */
            }
        }, 400);
    }

    function loadDraft() {
        let t = {};
        try {
            t = JSON.parse(localStorage.getItem(DRAFT) || '{}') || {};
        } catch {
            t = {};
        }
        for (const form of $$('[data-job-form]')) {
            const v = t[form.dataset.jobForm];
            if (!v) continue;
            for (const field of form.elements) {
                // Sekme seçimleri (Panel yazsın / Ben yazacağım) taslaktan dönmez: yenileyince varsayılan.
                if (!field.name || !(field.name in v) || field.closest('[data-scene]') || field.type === 'radio') continue;
                if (field.type === 'checkbox') field.checked = Boolean(v[field.name]);
                else if (field.type === 'radio') field.checked = field.value === v[field.name];
                else if (field.tagName === 'SELECT') {
                    if ($$('option', field).some((o) => o.value === String(v[field.name]) && !o.disabled)) field.value = v[field.name];
                } else field.value = v[field.name];
            }
        }
        const scenes = t.film?.scenes;
        if (t.film?.characters && typeof t.film.characters === 'object') status.characters = t.film.characters;
        if (Array.isArray(scenes) && scenes.length) scenes.forEach((s) => addScene(s));
        else addScene();
        renderCharacters();
        if (t.videoSource?.source) configureSource(t.videoSource);
        if (t.m3Image?.source) configureM3Image(t.m3Image);
        if (t.m3Video?.source) configureM3Video(t.m3Video);
        // Video suresi: hazir secenek ya da ozel.
        if (t.video?.durationReady) {
            $('[data-duration-preset]', videoForm).value = t.video.durationReady;
            $('[data-duration-custom]', videoForm).hidden = t.video.durationReady !== 'custom';
            if (t.video.durationUnit) $('[data-duration-unit]', videoForm).value = t.video.durationUnit;
        }
        $$('[data-voice-choice]').forEach(specFields);
    }

    document.addEventListener('input', (event) => {
        if (event.target.closest('[data-job-form]')) saveDraft();
    });
    document.addEventListener('change', (event) => {
        if (event.target.closest('[data-job-form]')) saveDraft();
    });

    /* ── Başlangıç ──────────────────────────────────────────────────────── */

    async function start() {
        // Betiksiz gönderimden dönüş: ?bildirim=…
        const q = new URLSearchParams(location.search);
        if (q.get('notification')) {
            setTimeout(() => notify(q.get('notification'), q.get('type') || 'info'), 50);
            history.replaceState(null, '', `/${location.hash}`);
        }
        $('[data-side="image"]').append(lastPanel('image', 'Recent images'));
        $('[data-side="video"]').append(lastPanel('video', 'Recent videos'));
        $('[data-side="voice"]').append(lastPanel('voice', 'Recent voice-overs'));
        $('[data-side="music"]').append(lastPanel('music', 'Recent music'));
        $('[data-side="edit"]').append(lastPanel('edit', 'Recent edits'));
        $('[data-side="model3d"]').append(lastPanel('model3d', 'Recent 3D models'));
        $('[data-side="film"]').append(lastPanel('film', 'Recent films'));
        applyRoute();
        try {
            await loadOptions();
        } catch (e) {
            notify(`Could not load options: ${e.message}`, 'danger');
        }
        loadDraft();
        setupFpsPreparations();
        updateSliders();
        showMusic();
        applyMusicMode();
        applySceneMode();
        applyLyricWriter();
        imageFields();
        videoFields();
        scenesNumber();
        pollStatus();
        // The section is announced once every page script listens (settings.js, chat.js… run after this one): with the
        // web app's service worker the options could come back before chat.js had run, and the chat opened empty
        await scriptsReady;
        document.dispatchEvent(new CustomEvent('nedese:section', { detail: { section: status.section } }));
    }

    // DOMContentLoaded comes after every deferred script of the page has run
    const scriptsReady = new Promise((ok) => {
        if (document.readyState === 'complete') ok();
        else document.addEventListener('DOMContentLoaded', ok, { once: true });
    });

    // Ayarlar sayfasi (ayarlar.js) ayni yardimcilari kullanir.
    window.NedesePanel = { el, api, notify, durationText, number, actionForm, pollStatus, status, pagination, slice, applyVoiceEngine };

    start();
})();
