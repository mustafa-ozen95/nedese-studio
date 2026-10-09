/**
 * Ayarlar bölümü: kurulu modeller (boyut, kullanan iş akışı, silme), niceleme seçimi,
 * katalogdan / özel adresten indirme (gerçek bayt ilerlemesi, sürdür, iptal), API anahtarı.
 *
 * KLASİK BETİK: app.js'ten sonra yüklenir, window.AiPanel yardımcılarını kullanır
 * (el, api, bildir, islemFormu). Veri /api/v1/* adreslerinden (aynı kaynak, X-Panel).
 */
(function () {
    'use strict';

    const { el, api, notify, durationText, number, actionForm } = window.NedesePanel;
    const $ = (s, k = document) => k.querySelector(s);
    const $$ = (s, k = document) => Array.from(k.querySelectorAll(s));
    const section = $('[data-section="settings"]');

    const gb = (b) => (b === null || b === undefined ? '–' : b >= 2 ** 30 ? `${number(b / 2 ** 30, 1)} GB` : b >= 2 ** 20 ? `${number(b / 2 ** 20, 0)} MB` : `${number(b / 1024, 0)} KB`);
    const speed = (b) => (b >= 2 ** 20 ? `${number(b / 2 ** 20, 1)} MB/s` : `${number(b / 1024, 0)} KB/s`);

    const status = { isOpen: false, polling: null, catalog: [], models: null, settings: null };

    /* ── Yükleme ───────────────────────────────────────────────────────── */

    // Each part is redrawn only when its data changed, but only when entering the section: rebuilding tables and forms on
    // every visit looked like a page reload on iPhone and could reset a field being edited. Calls after save/delete and
    // on error paths always redraw (the form returns to the server's values).
    const renderSignature = {};
    let skipUnchanged = false;
    const ifChanged = (name, data, render) => {
        const signature = JSON.stringify(data);
        if (skipUnchanged && renderSignature[name] === signature) return;
        renderSignature[name] = signature;
        render();
    };

    async function loadAll({ skipIfUnchanged = false } = {}) {
        skipUnchanged = skipIfUnchanged;
        try {
            const [a, m, k, i] = await Promise.all([api('/api/v1/settings'), api('/api/v1/models'), api('/api/v1/models/catalog'), api('/api/v1/models/downloads')]);
            status.settings = a;
            status.models = m;
            status.catalog = k.catalog;
            ifChanged('api', { ...a, update: undefined }, () => renderApi(a));
            ifChanged('update', [a.update, a.translatePrompt], () => renderUpdate(a.update, a.translatePrompt));
            ifChanged('fine', a.fineSettings, () => renderFineSettings(a.fineSettings));
            ifChanged('network', [a.networkFullAccess, a.listen, a.addresses], () => renderNetwork(a));
            ifChanged('search', a.webSearch, () => renderSearch(a.webSearch));
            ifChanged('remote', a.remoteModel, () => renderRemote(a.remoteModel));
            // Volatile fields (free disk space, last update check) do not count: the table is not rebuilt for them
            const { disk: _disk, ...stableModels } = m;
            const { update: _update, ...stableSettings } = a;
            ifChanged('models', [stableModels, stableSettings], () => renderModels(m, a));
            writeDisk(m);
            ifChanged('catalog', [k.catalog, i.downloads], () => renderCatalog(k.catalog, i.downloads));
            ifChanged('downloads', i.downloads, () => renderDownloads(i.downloads));
        } catch (e) {
            notify(e.message, 'danger');
        }
        renderComfyInfo();
    }

    /* ── ComfyUI: durum, sürüm, aygıt, başlat / durdur / boşalt ───────── */

    async function renderComfyInfo() {
        let b;
        try {
            b = await api('/api/v1/comfy/info');
        } catch (e) {
            notify(e.message, 'danger');
            return;
        }
        const line = (k, v, raw = false) => (v === null || v === undefined || v === '' ? null : el('div', { class: 'facts__row' }, el('span', { class: 'facts__key', text: k }), el('span', { class: 'facts__value', translate: raw ? 'no' : null, text: String(v) })));
        const s = b.system;
        const a = b.devices?.[0];
        const statusText = b.running ? 'Ready' : b.starting ? 'Starting…' : 'Off';
        $('[data-comfy-info]', section).replaceChildren(
            el('div', { class: 'facts' },
                line('Status', statusText),
                line('Queue', b.running ? (b.queue ? `${b.queue} jobs` : 'Empty') : null),
                line('URL', b.address, true),
                line('Version', s?.version, true),
                line('PyTorch', s?.pytorch, true),
                line('Python', s?.python, true),
                line('GPU', a ? `${a.name.replace(/^cuda:\d+\s*:?\s*/, '').replace(/\s*:\s*cudaMalloc\w*$/, '')} ·${gb(a.vramTotal - a.vramFree)} / ${gb(a.vramTotal)}` : null, true),
                line('Launch options', s?.args?.length ? s.args.join(' ') : null, true),
                line('Folder', b.folder, true)));
        $('[data-comfy-operation="start"]', section).hidden = Boolean(b.running || b.starting);
        $('[data-comfy-operation="stop"]', section).hidden = !b.running;
        $('[data-comfy-operation="flush"]', section).hidden = !b.running;
        const open = $('[data-comfy-open]', section);
        // Bu bilgisayardan doğrudan ComfyUI'ye; başka cihazdan panelin aktardığı porta.
        const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
        const port = local ? new URL(b.address).port || '8188' : b.networkPort;
        open.hidden = !b.running || !port;
        open.href = `${location.protocol}//${location.hostname}:${port}/`;
    }

    section.addEventListener('click', async (event) => {
        const d = event.target.closest('[data-comfy-operation]');
        if (!d) return;
        d.disabled = true;
        try {
            const j = await api(`/api/v1/comfy/${d.dataset.comfyOperation}`, { method: 'POST' });
            notify(j.message, 'success');
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            d.disabled = false;
            setTimeout(renderComfyInfo, 1500);
        }
    });

    async function pollDownloads() {
        clearTimeout(status.polling);
        if (!status.isOpen) return;
        let list = [];
        try {
            list = (await api('/api/v1/models/downloads')).downloads;
            renderDownloads(list);
        } catch {
            /* sunucu yok: üst çubuk zaten söyler */
        }
        const ongoing = list.some((x) => ['downloading', 'queued'].includes(x.status));
        status.polling = setTimeout(pollDownloads, ongoing ? 1500 : 8000);
    }

    document.addEventListener('nedese:section', (event) => {
        status.isOpen = event.detail.section === 'settings';
        clearTimeout(status.polling);
        if (status.isOpen) {
            loadAll({ skipIfUnchanged: true }).then(() => {
                status.polling = setTimeout(pollDownloads, 1500);
            });
        }
    });

    // islemFormu ile yapilan islemlerden (sil, iptal, surdur) sonra tazele.
    document.addEventListener('nedese:action', () => {
        if (status.isOpen) loadAll();
    });

    $('[data-setting-refresh]', section).addEventListener('click', loadAll);

    /* ── Güncelleme (GitHub) ve istem çevirisi ─────────────────────────── */

    const dateText = (t) => (t ? new Date(t).toLocaleString(window.NedeseLang?.local ?? 'en-US', { dateStyle: 'short', timeStyle: 'short' }) : '–');
    const shortVersion = (s) => (s ? s.slice(0, 7) : 'unknown');

    function renderUpdate(g, translate) {
        const box = $('[data-prompt-translate]', section);
        if (box && translate !== undefined) box.checked = translate !== false;
        const k = $('[data-setting-update]', section);
        if (!k) return; // old page (cache): no section
        if (!g) {
            k.hidden = true;
            return;
        }
        k.hidden = false;
        const lines = [
            `Installed version: ${shortVersion(g.local.sha)}${g.local.dateText ? ` (${dateText(g.local.dateText)})` : ''}`,
            g.development ? 'Development copy (git): it is updated with git pull.' : null,
            g.last ? (g.last.fresh ? `Last check: ${dateText(g.lastControl)} · new version: ${shortVersion(g.last.remote.sha)} (${g.last.remote.message})` : `Last check: ${dateText(g.lastControl)} · up to date`) : g.lastControl ? `Last check: ${dateText(g.lastControl)}` : 'Not checked yet.',
            g.waiting ? 'The update will be applied when the jobs finish.' : null,
            g.last?.setupRequired ? 'Python environments also change in this version: after updating, run setup.bat -Models none.' : null,
        ].filter(Boolean);
        $('[data-update-info]', k).replaceChildren(...lines.map((s) => el('div', { text: s })));
        $('[data-update-auto]', k).checked = Boolean(g.auto);
        $('[data-update-apply]', k).hidden = !(g.last?.fresh && !g.development);
        // The top bar's "Update available" badge arrives with #settings/update: scroll to the section
        if (location.hash === '#settings/update') {
            history.replaceState(null, '', '#settings');
            requestAnimationFrame(() => k.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        }
    }

    if ($('[data-setting-update]', section) && $('[data-prompt-translate]', section)) {
        const k = $('[data-setting-update]', section);
        const withButton = (d, job) => async () => {
            d.disabled = true;
            try {
                await job();
            } catch (e) {
                notify(e.message, 'danger');
            } finally {
                d.disabled = false;
            }
        };
        const auto = $('[data-update-auto]', k);
        auto.addEventListener('change', async () => {
            try {
                const j = await api('/api/v1/update', { method: 'PATCH', body: { auto: auto.checked } });
                notify(j.message, 'success');
                renderUpdate(j);
            } catch (e) {
                notify(e.message, 'danger');
                auto.checked = !auto.checked;
            }
        });
        const check = $('[data-update-check]', k);
        check.addEventListener('click', withButton(check, async () => {
            const j = await api('/api/v1/update/check', { method: 'POST' });
            notify(j.message, j.last?.fresh ? 'info' : 'success');
            renderUpdate(j);
            document.dispatchEvent(new CustomEvent('nedese:poll-status'));
        }));
        const apply = $('[data-update-apply]', k);
        apply.addEventListener('click', withButton(apply, async () => {
            const j = await api('/api/v1/update/apply', { method: 'POST' });
            notify(j.message, 'success');
            renderUpdate(j);
        }));
        const translate = $('[data-prompt-translate]', section);
        translate.addEventListener('change', async () => {
            try {
                const j = await api('/api/v1/settings', { method: 'PATCH', body: { translatePrompt: translate.checked } });
                notify(j.message, 'success');
            } catch (e) {
                notify(e.message, 'danger');
                translate.checked = !translate.checked;
            }
        });
    }

    /* ── Network: where the panel opens from, the port, restart ──────────── */

    function renderNetwork(a) {
        const box = $('[data-setting-network]', section);
        if (!box) return; // old page (cache)
        const access = $('[data-network-access]', box);
        access.checked = a.networkFullAccess !== false;
        const l = a.listen;
        box.hidden = !l;
        if (!l) return;
        const next = { address: l.saved?.address ?? l.defaults.address, port: l.saved?.port ?? l.defaults.port };
        const field = $('[data-listen-address]', box);
        // what was saved, unless the user is editing it
        if (document.activeElement !== field) field.value = next.address;
        const where = (x) => (x === '127.0.0.1' ? 'this computer only' : 'all networks of this computer');
        const lines = [el('div', {}, el('span', { text: 'Now: ' }), el('span', { text: where(l.address) }))];
        if (next.address !== l.address) lines.push(el('div', { class: 'network-next' }, el('span', { text: 'After a restart: ' }), el('span', { text: where(next.address) })));
        $('[data-listen-now]', box).replaceChildren(...lines);
        $('[data-listen-restart]', box).hidden = !l.restart;
    }

    const listenSave = $('[data-listen-save]', section);
    listenSave?.addEventListener('click', async () => {
        const box = $('[data-setting-network]', section);
        listenSave.disabled = true;
        try {
            const j = await api('/api/v1/settings', { method: 'PATCH', body: { listenAddress: $('[data-listen-address]', box).value } });
            notify(j.message, 'success');
            loadAll();
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            listenSave.disabled = false;
        }
    });

    /** Restart, then open the panel again once it answers. */
    const listenRestart = $('[data-listen-restart]', section);
    listenRestart?.addEventListener('click', async () => {
        listenRestart.disabled = true;
        try {
            const j = await api('/api/v1/restart', { method: 'POST' });
            notify(j.message, 'info');
            const local = /^(127\.|localhost$|\[?::1\]?$)/.test(location.hostname);
            if (j.address === '127.0.0.1' && !local) {
                notify('The panel now opens only on its own computer.', 'warning');
                return;
            }
            const target = new URL(location.href);
            target.port = String(j.port);
            await new Promise((ok) => setTimeout(ok, 2500));
            // the panel answers again (a no-cors request resolves once something listens there)
            for (let i = 0; i < 60; i++) {
                try {
                    await fetch(`${target.origin}/api/v1/session`, { mode: 'no-cors', cache: 'no-store' });
                    location.href = target.href;
                    return;
                } catch {
                    await new Promise((ok) => setTimeout(ok, 1000));
                }
            }
            notify(`The panel did not answer at ${target.origin}; open it from the tray.`, 'warning');
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            listenRestart.disabled = false;
        }
    });

    const networkBox = $('[data-network-access]', section);
    networkBox?.addEventListener('change', async () => {
        try {
            const j = await api('/api/v1/settings', { method: 'PATCH', body: { networkFullAccess: networkBox.checked } });
            notify(j.message, 'success');
        } catch (e) {
            notify(e.message, 'danger');
            networkBox.checked = !networkBox.checked;
        }
    });

    /* ── Web search: Brave, Tavily or SearXNG for the assistant's search_web (user request 08.10.2026) ── */

    // A saved key never comes back from the panel: the field stays empty (its placeholder shows the format) and the
    // line under it shows the last 4 characters
    const SEARCH_SERVICES = [
        ['brave', 'Brave Search API key', 'password', 'BSA…'],
        ['tavily', 'Tavily API key', 'password', 'tvly-…'],
        ['searxng', 'SearXNG address', 'text', 'http://127.0.0.1:8888'],
    ];

    function renderSearch(w) {
        const box = $('[data-setting-search]', section);
        if (!box) return; // old page (cache)
        box.hidden = !w;
        if (!w) return;
        $('[data-search-services]', box).replaceChildren(...SEARCH_SERVICES.map(([key, label, type, example]) => {
            const id = `search-${key}`;
            const input = el('input', { class: 'input input--mono', id, type, autocomplete: 'off', spellcheck: 'false', 'data-search-input': key, placeholder: example });
            const actions = [input, el('button', { type: 'button', class: 'btn btn--sm', 'data-search-save': key, text: 'Save' })];
            if (w[key]) actions.push(el('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'data-search-remove': key, text: 'Remove' }));
            return el('div', { class: 'field' },
                el('label', { class: 'field__label', for: id, text: label }),
                el('div', { class: 'row row--tight' }, ...actions),
                el('span', { class: 'field__hint', text: w[key] ? `Saved: ${w[key]}` : 'Not set' }));
        }));
    }

    async function saveSearch(key, value, button) {
        button.disabled = true;
        try {
            const j = await api('/api/v1/settings', { method: 'PATCH', body: { webSearch: { [key]: value } } });
            notify(j.message, 'success');
            if (status.settings) status.settings.webSearch = j.webSearch;
            renderSignature.search = JSON.stringify(j.webSearch);
            renderSearch(j.webSearch);
        } catch (e) {
            notify(e.message, 'danger');
            button.disabled = false;
        }
    }

    const searchBox = $('[data-setting-search]', section);
    searchBox?.addEventListener('click', (event) => {
        const save = event.target.closest('[data-search-save]');
        const remove = event.target.closest('[data-search-remove]');
        if (save) {
            const value = $(`[data-search-input="${save.dataset.searchSave}"]`, searchBox).value.trim();
            if (!value) {
                notify('Paste the key or the address first.', 'warning');
                return;
            }
            saveSearch(save.dataset.searchSave, value, save);
        } else if (remove) saveSearch(remove.dataset.searchRemove, '', remove);
    });
    searchBox?.addEventListener('keydown', (event) => {
        const input = event.target.closest('[data-search-input]');
        if (event.key !== 'Enter' || !input) return;
        event.preventDefault();
        $(`[data-search-save="${input.dataset.searchInput}"]`, searchBox).click();
    });

    /* ── Remote model: an OpenAI-compatible server a chat can choose as its text model (user request 08.10.2026) ── */

    const remoteBox = $('[data-setting-remote]', section);
    const remoteForm = $('[data-remote-form]', section);
    const remoteRemoveForm = $('[data-remote-remove-form]', section);
    // what the fields showed: an unchanged field is not sent (an address with a password comes back masked)
    let remoteShown = { url: '', model: '' };

    function renderRemote(r) {
        if (!remoteBox || !remoteForm) return; // old page (cache)
        remoteBox.hidden = !r;
        if (!r) return;
        remoteShown = { url: r.url, model: r.model };
        remoteForm.elements.url.value = r.url;
        remoteForm.elements.model.value = r.model;
        // a saved key never comes back: the field stays empty, the line under it shows the last 4 characters
        remoteForm.elements.key.value = '';
        remoteForm.elements.whenBusy.checked = Boolean(r.whenBusy);
        $('[data-remote-key-hint]', remoteBox).textContent = r.key ? `Saved: ${r.key}` : 'Not set (a server without a key needs none)';
        $('[data-remote-check]', remoteBox).disabled = !r.ready;
        remoteRemoveForm.hidden = !(r.url || r.model || r.key);
    }

    async function saveRemote(body, button) {
        if (button) button.disabled = true;
        try {
            const j = await api('/api/v1/settings', { method: 'PATCH', body: { remoteModel: body } });
            notify(j.message, 'success');
            if (status.settings) status.settings.remoteModel = j.remoteModel;
            renderSignature.remote = JSON.stringify(j.remoteModel);
            renderRemote(j.remoteModel);
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            if (button) button.disabled = false;
        }
    }

    remoteForm?.addEventListener('submit', (event) => {
        event.preventDefault();
        const f = remoteForm.elements;
        const body = { whenBusy: f.whenBusy.checked };
        for (const name of ['url', 'model']) if (f[name].value.trim() !== remoteShown[name]) body[name] = f[name].value.trim();
        if (f.key.value.trim()) body.key = f.key.value.trim();
        saveRemote(body, $('[data-remote-save]', remoteForm));
    });

    $('[data-remote-check]', section)?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const j = await api('/api/v1/settings/remote-model/check', { method: 'POST' });
            notify(j.message, 'success');
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            button.disabled = false;
        }
    });

    // Remove asks first (design.js data-confirm), which submits this form natively: its submit is the request
    if (remoteRemoveForm) remoteRemoveForm.submit = () => saveRemote({ url: '', key: '', model: '', whenBusy: false }, null);

    /* ── İnce ayarlar (ekran kartına göre) ─────────────────────────────── */

    function renderFineSettings(d) {
        const k = $('[data-setting-fine]', section);
        if (!k) return; // eski sayfa (önbellek)
        if (!d) {
            k.hidden = true;
            return;
        }
        k.hidden = false;
        const renderItem = (a) => {
            const note = a.value !== a.defaultValue ? el('span', { class: 'badge badge--yellow', text: 'changed' }) : null;
            if (a.type === 'tick') {
                const box = el('input', { type: 'checkbox', 'data-fine-setting': a.key });
                box.checked = Boolean(a.value);
                return el('div', { class: 'stack stack--tight' },
                    el('label', { class: 'checkbox' }, box, ' ', el('span', { text: a.name }), note ? ' ' : null, note),
                    el('span', { class: 'field__hint', text: a.description }));
            }
            const choice = el('select', { class: 'select', id: `ince-${a.key}`, 'data-fine-setting': a.key }, a.options.map((s) => el('option', { value: s.value, text: s.name })));
            choice.value = a.value;
            return el('div', { class: 'field' },
                el('label', { class: 'field__label', for: `ince-${a.key}` }, a.name, note ? ' ' : null, note),
                choice,
                el('span', { class: 'field__hint', text: a.description }));
        };
        const groups = d.groups.map((group) => {
            const items = d.settings.filter((a) => a.group === group).map(renderItem);
            return items.length ? el('div', { class: 'stack' }, el('h3', { class: 'panel__title', text: group }), ...items) : null;
        });
        $('[data-fine-settings]', k).replaceChildren(...groups.filter(Boolean));
        $('[data-fine-default]', k).disabled = !d.settings.some((a) => a.value !== a.defaultValue);
    }

    async function saveFineSettings(changing) {
        const j = await api('/api/v1/settings', { method: 'PATCH', body: { fineSettings: changing } });
        notify(j.message, 'success');
        renderFineSettings(j.fineSettings);
        document.dispatchEvent(new CustomEvent('nedese:refresh-options'));
    }

    if ($('[data-setting-fine]', section)) {
        const k = $('[data-setting-fine]', section);
        k.addEventListener('change', async (event) => {
            const g = event.target.closest('[data-fine-setting]');
            if (!g) return;
            const value = g.type === 'checkbox' ? g.checked : g.value;
            try {
                await saveFineSettings({ [g.dataset.fineSetting]: value });
            } catch (e) {
                notify(e.message, 'danger');
                loadAll();
            }
        });
        const defaultValue = $('[data-fine-default]', k);
        defaultValue.addEventListener('click', async () => {
            defaultValue.disabled = true;
            try {
                const d = status.settings?.fineSettings;
                await saveFineSettings(Object.fromEntries((d?.settings ?? []).map((a) => [a.key, a.defaultValue])));
            } catch (e) {
                notify(e.message, 'danger');
                defaultValue.disabled = false;
            }
        });
    }

    /* ── API kutusu ────────────────────────────────────────────────────── */

    function renderApi(a) {
        const box = $('[data-secret]', section);
        box.dataset.secretExample = a.apiKey;
        if (box.dataset.secretOpen === 'true') $('[data-secret-value]', box).textContent = a.apiKey;
        $('[data-setting-file]', section).textContent = a.settingFile;
        // examples always use 127.0.0.1 (user request 09.10.2026), not the address this page was opened with
        $('[data-api-example]', section).textContent = `curl -H "Authorization: Bearer <key>" http://127.0.0.1:${location.port || 1071}/api/v1/status`;
        const refresh = $('[data-key-refresh]', section);
        if (!refresh.children.length) {
            const form = actionForm({
                path: '/api/v1/settings/rotate-key',
                tag: 'Regenerate key',
                title: 'Regenerate API key',
                approval: 'A new key will be generated; scripts using the old key will stop working.',
                variant: 'danger',
                button: 'btn btn--sm btn--ghost',
            });
            refresh.append(form);
        }
    }

    /* ── Kurulu modeller + niceleme seçimi ─────────────────────────────── */

    /** Free-space line: changes on every poll; only this text is updated, not the table. */
    function writeDisk(m) {
        const disk = m.disk;
        $('[data-model-disk]', section).textContent = disk.freeByte !== null ? `Free space ${gb(disk.freeByte)} / ${gb(disk.totalByte)} · folder ${m.root}` : m.root;
    }

    function renderModels(m, a) {
        writeDisk(m);

        // Niceleme secimi: her aile icin kurulu secenekler.
        const form = $('[data-quantization-form]', section);
        form.replaceChildren(
            ...Object.entries(a.quantizations).map(([family, n]) => {
                const selected = a.modelChoices[family] ?? '';
                const choice = el('select', { class: 'select', name: family, 'aria-label': n.name },
                    // Bos secim: panelin varsayilani (ileride daha iyi surume gecilince kendiliginden degisir).
                    el('option', { value: '', text: `Default (${n.defaultValue ?? '?'})` }),
                    ...n.installed.filter((q) => q !== n.defaultValue).map((q) => el('option', { value: q, text: q })));
                choice.value = n.installed.includes(selected) && selected !== n.defaultValue ? selected : '';
                const hint = n.installed.length > 1 ? 'Choose among installed ones; cannot change while a job runs.' : n.installed.length === 1 ? 'Only the default is installed (measured as the best balance on this machine); download other quantizations below.' : 'No files installed on this machine.';
                return el('div', { class: 'field' }, el('label', { class: 'field__label', text: `${n.name} model` }), choice,
                    n.version ? el('span', { class: 'field__hint', translate: 'no', text: n.version }) : null, el('span', { class: 'field__hint', text: hint }));
            }),
            // The local text model (Chat by default, prompt translations, bots /llm/v1).
            a.textModel?.models?.length ? (() => {
                const choice = el('select', { class: 'select', name: 'textModel', 'aria-label': 'Text model', translate: 'no' },
                    ...a.textModel.models.map((m) => el('option', { value: m.file, text: `${m.name} (${m.gib} GB)${m.image ? ' · understands images' : ''}` })));
                choice.value = a.textModel.file ?? '';
                return el('div', { class: 'field' }, el('label', { class: 'field__label', text: 'Text model' }), choice,
                    el('span', { class: 'field__hint', text: 'Chat (unless a chat picks another model), prompt translations and bots (/llm/v1) use this model. The large (26B) model writes better but fills the GPU and RAM and is slower.' }));
            })() : null,
            // Yazı modeli bellekte kalsın mı (kullanıcı 08.10.2026): hep ya da N dakika boşta kalınca çıkar.
            a.textModel?.models?.length ? (() => {
                const choice = el('select', { class: 'select', name: 'textModelIdleMin', 'aria-label': 'Unload the text model when idle' },
                    ...(a.textModelIdleOptions ?? [0, 2, 5, 10, 30, 60]).map((min) => el('option', { value: String(min), text: min ? `after ${min} minutes` : 'Never (keep in memory)' })));
                choice.value = String(a.textModelIdleMin ?? 5);
                return el('div', { class: 'field' }, el('label', { class: 'field__label', text: 'Unload the text model when idle' }), choice,
                    el('span', { class: 'field__hint', text: 'Kept in memory, chat answers start at once, but about 10 GB of GPU memory stays in use. Image and video jobs still unload it while they run; it is loaded again a minute after the GPU is free.' }));
            })() : null,
            // Seslendirme motoru (Ses ve Tek parça anlatımı).
            (() => {
                const choice = el('select', { class: 'select', name: 'voiceEngine', 'data-voice-engine': true, 'aria-label': 'Voice engine' },
                    ...Object.entries(a.voiceEngines ?? {}).map(([k, name]) => el('option', { value: k, text: name })));
                choice.value = a.voiceEngine ?? 'voxcpm';
                return el('div', { class: 'field' }, el('label', { class: 'field__label', text: 'Voice engine' }), choice, el('span', { class: 'field__hint', text: 'Voice-over and Film narration use this engine. EMA is a single female voice and does not clone: selected voices and characters are read with VoxCPM2.' }));
            })(),
            // ComfyUI elle başlat / kapat (üst çubukta yalnız durum noktası; iş gelince kendiliğinden açılır).
            (() => {
                const statusText = el('span', { class: 'status' }, el('span', { class: 'dot dot--gray' }), el('span', { text: 'ComfyUI' }));
                const button = el('button', { type: 'button', class: 'btn btn--secondary', text: 'Start' });
                const applyUpdate = (c) => {
                    const [color, text, action] = c.running ? ['green', c.queue ? `Running · ${c.queue} queued` : 'Running', 'Close'] : c.starting ? ['yellow', 'Starting…', null] : ['red', 'Off', 'Start'];
                    statusText.firstChild.className = `dot dot--${color}`;
                    statusText.lastChild.textContent = text;
                    button.hidden = !action;
                    if (action) button.textContent = action;
                    button.dataset.action = action === 'Close' ? 'stop' : 'start';
                };
                const listen = (o) => (button.isConnected ? applyUpdate(o.detail) : document.removeEventListener('nedese:comfy', listen));
                document.addEventListener('nedese:comfy', listen);
                button.addEventListener('click', async () => {
                    const stop = button.dataset.action === 'stop';
                    button.disabled = true;
                    try {
                        const j = await api(`/api/v1/comfy/${stop ? 'stop' : 'start'}`, { method: 'POST', body: stop ? { force: false } : undefined });
                        notify(j.message, 'info');
                    } catch (e) {
                        notify(e.message, 'danger');
                    } finally {
                        button.disabled = false;
                        window.NedesePanel.pollStatus();
                    }
                });
                return el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'ComfyUI' }),
                    el('div', { class: 'row row--wrap' }, statusText, button),
                    el('span', { class: 'field__hint', text: 'Starts automatically when an image, video, music or 3D job arrives; no need to start it by hand. Stopping frees RAM (not while a job is running).' }));
            })(),
            // Boşta ComfyUI kapatma (RAM): iş gelince kendiliğinden yeniden açılır.
            (() => {
                const choice = el('select', { class: 'select', name: 'comfyIdleCloseMin', 'aria-label': 'Close ComfyUI when idle' },
                    ...(a.idleCloseOptions ?? [0, 5, 10, 30, 60]).map((min) => el('option', { value: String(min), text: min ? `after ${min} minutes` : 'Never' })));
                choice.value = String(a.comfyIdleCloseMin ?? 10);
                return el('div', { class: 'field' }, el('label', { class: 'field__label', text: 'Close ComfyUI when idle' }), choice, el('span', { class: 'field__hint', text: 'When the queue is empty ComfyUI closes after this time and frees 4-5 GB of RAM; it starts again automatically when a job arrives (the first job starts 20-40 s later).' }));
            })(),
            el('div', { class: 'save-row field--wide' },
                el('button', { type: 'submit', class: 'btn btn--primary', text: 'Save choices' }),
                el('span', { class: 'field__hint', text: 'Applies to new jobs.' })),
        );

        const container = $('[data-model-list]', section);
        const runningFiles = window.NedesePanel.status?.activeModelFiles ?? [];
        // Model model: dosyalar onları kullanan iş akışına göre toplanır (ana model + yardımcı
        // parçaları tek satırda). Hiçbir iş akışının kullanmadığı dosyalar en sonda ayrı durur.
        const models = new Map();
        for (const k of m.folders) {
            for (const d of k.files) {
                const names = d.user.length ? d.user : ['Unused files'];
                for (const name of names) (models.get(name) ?? models.set(name, []).get(name)).push({ folder: k.name, d });
            }
        }
        const position = [...models.keys()].sort((a, b) => (a === 'Unused files') - (b === 'Unused files') || a.localeCompare(b));
        // Dosyalar gösterilmez (kullanıcı onları tek tek değiştirmiyor): model başına tek satır.
        container.replaceChildren(
            el('div', { class: 'table-wrap' },
                el('table', { class: 'table' },
                    el('thead', {}, el('tr', {}, el('th', { text: 'Model' }), el('th', { text: 'Size' }), el('th', {}))),
                    el('tbody', {}, ...position.map((name) => {
                        const files = models.get(name);
                        const total = files.reduce((t, x) => t + (x.d.size ?? 0), 0);
                        return el('tr', {},
                            el('td', { 'data-label': 'Model', text: name }),
                            el('td', { class: 'mono', 'data-label': 'Size', text: gb(total) }),
                            el('td', { class: 'table__row-actions table__row-actions--fixed' }, modelDeleteForm(name, files, models, runningFiles)));
                    })))),
        );
        if (!m.folders.some((k) => k.files.length)) container.replaceChildren(el('div', { class: 'empty' }, el('p', { class: 'empty__title', text: 'No models' }), el('p', { class: 'empty__text', text: 'Download from the catalog below.' })));
    }

    /**
     * Bir modeli bütün parçalarıyla kalıcı olarak siler. Başka bir modelin de
     * kullandığı parçalar (ortak metin kodlayıcı, VAE) kalır; çalışan işin modeli silinmez.
     */
    function modelDeleteForm(name, files, models, runningFiles) {
        const inOthers = (x) => [...models.entries()].some(([other, list]) => other !== name && other !== 'Unused files' && list.some((y) => y.folder === x.folder && y.d.file === x.d.file));
        const toDelete = files.filter((x) => !inOthers(x));
        const size = toDelete.reduce((t, x) => t + (x.d.size ?? 0), 0);
        const running = files.some((x) => runningFiles.includes(x.d.file));
        const form = actionForm({
            path: '/api/v1/models',
            tag: 'Delete',
            title: 'Delete model',
            approval: `"${name}" will be permanently deleted (${gb(size)}).`,
            variant: 'danger',
            button: 'btn btn--sm btn--ghost',
        });
        const button = $('button', form);
        if (running || !toDelete.length) {
            button.disabled = true;
            button.title = running ? 'The running job uses this model.' : 'Its parts are shared with other models.';
        }
        form.submit = async () => {
            button.disabled = true;
            try {
                for (const x of toDelete) await api(`/api/v1/models/${encodeURIComponent(x.folder)}/${encodeURIComponent(x.d.file)}?force=1`, { method: 'DELETE' });
                notify(`${name} deleted.`, 'success');
            } catch (e) {
                notify(e.message, 'danger');
            } finally {
                loadAll();
            }
        };
        return form;
    }

    $('[data-quantization-form]', section).addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        const modelChoices = {};
        let voiceEngine;
        let comfyIdleCloseMin;
        let textModel;
        let textModelIdleMin;
        for (const s of $$('select', form)) {
            if (s.name === 'voiceEngine') voiceEngine = s.value;
            else if (s.name === 'comfyIdleCloseMin') comfyIdleCloseMin = Number(s.value);
            else if (s.name === 'textModel') textModel = s.value;
            else if (s.name === 'textModelIdleMin') textModelIdleMin = Number(s.value);
            else modelChoices[s.name] = s.value;
        }
        const button = $('button[type="submit"]', form);
        button.disabled = true;
        try {
            const j = await api('/api/v1/settings', { method: 'PATCH', body: { modelChoices, voiceEngine, comfyIdleCloseMin, textModel, textModelIdleMin } });
            notify(j.message, 'success');
            if (j.voiceEngine) window.NedesePanel.applyVoiceEngine?.(j.voiceEngine);
            loadAll();
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            button.disabled = false;
        }
    });

    /* ── Katalog ───────────────────────────────────────────────────────── */

    function renderCatalog(catalog, downloads) {
        // One row per model: the main file (the High + Low pair for Wan); the group's helper parts (LoRA, text
        // encoder, VAE) belong to the row, and "Download" fetches every missing one.
        const container = $('[data-catalog]', section);
        const MAIN = ['diffusion_models', 'checkpoints'];
        const active = new Set(downloads.filter((i) => ['queued', 'downloading', 'paused', 'error'].includes(i.status)).map((i) => `${i.folder}/${i.file}`));
        const options = new Map();
        for (const k of catalog.filter((x) => MAIN.includes(x.folder))) {
            const name = k.name.replace(/\s*\b(HighNoise|LowNoise)\b\s*/, ' ').replace(/\s+/g, ' ').trim();
            const s = options.get(name) ?? options.set(name, { name, note: '', parts: [] }).get(name);
            s.parts.push(k);
            if (k.note && !s.note) s.note = k.note;
        }
        for (const s of options.values()) {
            const group = s.parts[0].group;
            s.parts.push(...catalog.filter((x) => x.group === group && !MAIN.includes(x.folder) && !/Lightning 4/.test(x.name)));
        }
        const lines = [...options.values()].map((s) => {
            const missing = s.parts.filter((k) => !k.installed);
            const downloading = missing.some((k) => active.has(`${k.folder}/${k.file}`));
            const size = (missing.length ? missing : s.parts).reduce((t, k) => t + (k.size ?? 0), 0);
            return el('tr', {},
                el('td', { 'data-label': 'Model' }, el('div', { text: s.name }), s.note ? el('div', { class: 'text-sm text-muted', text: s.note }) : null),
                el('td', { class: 'mono', 'data-label': 'Size' }, gb(size)),
                el('td', { class: 'table__row-actions table__row-actions--fixed' },
                    !missing.length
                        ? el('span', { class: 'badge badge--green row-state', text: 'installed' })
                        : downloading
                            ? el('span', { class: 'badge badge--blue row-state', text: 'in downloads' })
                            : el('button', { type: 'button', class: 'btn btn--sm row-state', 'data-catalog-download': missing.map((k) => k.id).join(','), text: 'Download' })));
        });
        // The default set (the files the workflows use; the same set the installer downloads): one click fetches the missing ones.
        const defaultValue = catalog.filter((k) => k.defaultValue);
        const missingDefault = defaultValue.filter((k) => !k.installed);
        const vSize = missingDefault.reduce((t, k) => t + (k.size ?? 0), 0);
        const vInList = missingDefault.length > 0 && missingDefault.every((k) => active.has(`${k.folder}/${k.file}`));
        const parent = el('div', { class: 'row row--between row--wrap' },
            el('div', { class: 'text-sm text-muted', text: missingDefault.length ? `Default model set: ${missingDefault.length} of ${defaultValue.length} files missing (${gb(vSize)}). Voice and text models are installed by setup.bat.` : `Default model set installed (${defaultValue.length} files).` }),
            !missingDefault.length
                ? el('span', { class: 'badge badge--green', text: 'installed' })
                : vInList
                    ? el('span', { class: 'badge badge--blue', text: 'in downloads' })
                    : el('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-default-download': '1', text: 'Download default models' }));
        container.replaceChildren(parent, el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('tbody', {}, ...lines))));
    }

    section.addEventListener('click', async (event) => {
        const v = event.target.closest('[data-default-download]');
        if (v) {
            v.disabled = true;
            try {
                const j = await api('/api/v1/models/downloads/defaults', { method: 'POST' });
                notify(j.message, 'success');
                await loadAll();
                pollDownloads();
            } catch (e) {
                notify(e.message, 'danger');
                v.disabled = false;
            }
            return;
        }
        const d = event.target.closest('[data-catalog-download]');
        if (!d) return;
        d.disabled = true;
        try {
            // A model row can fetch several parts (the main file + its missing helpers).
            for (const id of d.dataset.catalogDownload.split(',')) await api('/api/v1/models/downloads', { method: 'POST', body: { catalog: id } });
            notify('Download queued.', 'success');
            await loadAll();
            pollDownloads();
        } catch (e) {
            notify(e.message, 'danger');
            d.disabled = false;
        }
    });

    /** Dosya adından model klasörü tahmini (lib/file-browser.mjs klasorTahmini ile aynı kurallar). */
    function folderEstimate(file) {
        const name = String(file).split(/[\\/?#]/).filter(Boolean).pop()?.toLowerCase() ?? '';
        if (/lora|lightning|lightx2v/.test(name)) return 'loras';
        if (/vae/.test(name)) return 'vae';
        if (/umt5|t5xxl|clip|text.?encoder|qwen_2\.5_vl|llava|gemma/.test(name)) return 'text_encoders';
        if (/\.ckpt$/.test(name) || /checkpoint|fp8\.safetensors$|schnell/.test(name)) return 'checkpoints';
        return 'diffusion_models';
    }

    $('[data-custom-download]', section).addEventListener('input', (event) => {
        if (event.target.name !== 'url') return;
        const path = event.target.value.trim().replace(/[?#].*$/, '');
        if (path) event.currentTarget.folder.value = folderEstimate(path);
    });

    $('[data-custom-download]', section).addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        const body = {};
        for (const field of form.elements) if (field.name && field.value.trim()) body[field.name] = field.value.trim();
        const button = $('button[type="submit"]', form);
        button.disabled = true;
        try {
            const j = await api('/api/v1/models/downloads', { method: 'POST', body });
            notify(j.message, 'success');
            form.reset();
            await loadAll();
            pollDownloads();
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            button.disabled = false;
        }
    });

    /* ── İndirme listesi ───────────────────────────────────────────────── */

    const DOWNLOAD_STATUS = {
        queued: ['gray', 'Queued'],
        downloading: ['blue', 'Downloading'],
        paused: ['yellow', 'Paused'],
        cancelled: ['yellow', 'Paused'],
        error: ['red', 'Error'],
        done: ['green', 'Done'],
    };

    function renderDownloads(list) {
        const container = $('[data-download-list]', section);
        if (!list.length) {
            container.replaceChildren();
            return;
        }
        // Süren/duran indirmeler hep görünür; bitenler 10'ar sayfalanır.
        const ongoing = list.filter((i) => i.status !== 'done');
        const d = window.NedesePanel.slice(list.filter((i) => i.status === 'done'), status.downloadPage ?? 1, 10);
        status.downloadPage = d.page;
        const nav = window.NedesePanel.pagination(d, (n) => {
            status.downloadPage = n;
            renderDownloads(list);
        });
        $('[data-download-pagination]', section).replaceChildren(...(nav ? [nav] : []));
        const existing = new Map($$('[data-download]', container).map((s) => [s.dataset.download, s]));
        const position = [];
        for (const i of [...ongoing, ...d.items]) {
            let line = existing.get(i.id);
            if (!line || line.dataset.status !== i.status) line = downloadLine(i);
            existing.delete(i.id);
            updateDownloadLine(line, i);
            position.push(line);
        }
        container.replaceChildren(...position);
    }

    function downloadLine(i) {
        const actions = [];
        if (['queued', 'downloading'].includes(i.status)) actions.push(actionForm({ path: `/api/v1/models/downloads/${i.id}/cancel`, tag: 'Pause', button: 'btn btn--sm' }));
        if (['paused', 'error', 'cancelled'].includes(i.status)) actions.push(actionForm({ path: `/api/v1/models/downloads/${i.id}/resume`, tag: 'Resume', button: 'btn btn--sm btn--primary' }));
        if (i.status !== 'downloading') {
            const remove = actionForm({
                path: `/api/v1/models/downloads/${i.id}`,
                tag: i.status === 'done' ? 'Remove from list' : 'Cancel',
                title: i.status === 'done' ? undefined : 'Cancel download',
                approval: i.status === 'done' ? undefined : `The ${gb(i.downloaded)} downloaded for ${i.file} will be deleted.`,
                variant: 'danger',
                button: 'btn btn--sm btn--ghost',
            });
            remove.dataset.method = 'DELETE';
            actions.push(remove);
        }
        return el('div', { class: 'panel__block stack stack--tight', 'data-download': i.id, 'data-status': i.status },
            el('div', { class: 'row row--between' },
                // Uzun dosya adı ortadan kısalır: son kısım (niceleme, ör. -Q6_K.gguf) hep görünür.
                el('span', { class: 'line-title', style: 'display:flex;min-width:0', title: `${i.folder}/${i.file}`, translate: 'no' },
                    el('span', { class: 'truncate', 'data-field': 'name' }), el('span', { 'data-field': 'name-end', style: 'flex:none' })),
                el('span', { class: 'status', 'data-field': 'status' }, el('span', { class: 'dot' }), el('span', {}))),
            el('progress', { class: 'progress', max: '100', 'data-field': 'progress', 'aria-label': 'Download progress' }),
            el('div', { class: 'row row--between text-sm text-muted' }, el('span', { 'data-field': 'byte', class: 'mono' }), el('span', { 'data-field': 'remaining', class: 'mono' })),
            el('p', { class: 'field__error text-sm', 'data-field': 'error', hidden: true }),
            el('div', { class: 'job-actions' }, ...actions));
    }

    function updateDownloadLine(line, i) {
        const write = (field, text) => {
            const e = $(`[data-field="${field}"]`, line);
            if (e && e.textContent !== text) e.textContent = text;
        };
        const fileName = i.name || i.file;
        write('name', fileName.length > 30 ? fileName.slice(0, -18) : fileName);
        write('name-end', fileName.length > 30 ? fileName.slice(-18) : '');
        const [color, name] = DOWNLOAD_STATUS[i.status] ?? ['gray', i.status];
        $('[data-field="status"] .dot', line).className = `dot dot--${color}`;
        $('[data-field="status"] span:last-child', line).textContent = i.stage ? `${name} · ${i.stage}` : name;
        const bar = $('[data-field="progress"]', line);
        bar.hidden = i.status === 'done';
        if (i.percent !== null && i.percent !== undefined) bar.value = i.percent;
        else bar.removeAttribute('value');
        write('byte', `${gb(i.downloaded)}${i.expected ? ` / ${gb(i.expected)} (${number(i.percent ?? 0, 1)}%)` : ''}`);
        write('remaining', i.status === 'downloading' && i.speed ? `${speed(i.speed)}${i.remainingSec !== null && i.remainingSec !== undefined ? ` · remaining ≈ ${durationText(i.remainingSec)}` : ''}` : i.status === 'done' && i.validated ? 'SHA-256 verified' : '');
        const error = $('[data-field="error"]', line);
        error.hidden = !i.error;
        error.textContent = i.error ?? '';
    }

    /* ── Elimdeki model: bu bilgisayardan taşı ─────────────────────────── */

    function isInstalled(folder, file) {
        return Boolean(status.models?.folders.find((k) => k.name === folder)?.files.some((d) => d.file === file));
    }

    /** Var olan dosyanın üstüne yazma onayı: tasarim.js onay penceresi, sonucu Promise. */
    function ontoWriteApproval(file) {
        return new Promise((ok) => {
            const form = el('form', { method: 'post', action: '/', 'data-confirm': `${file} is already installed. Overwrite it? The old file will be deleted.`, 'data-confirm-title': 'Overwrite', 'data-confirm-variant': 'danger', hidden: true },
                el('button', { type: 'submit' }));
            let answered = false;
            form.submit = () => {
                answered = true;
                form.remove();
                ok(true);
            };
            document.body.append(form);
            $('button', form).click();
            // Vazgecilirse pencere kapanir, form bos kalir: gozle.
            const modal = $('[data-confirm-dialog]');
            const observer = new MutationObserver(() => {
                if (modal.hidden && !answered) {
                    observer.disconnect();
                    form.remove();
                    ok(false);
                }
            });
            observer.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
        });
    }

    /* ── Elimdeki model: Gözat (panelin makinesinde klasör gezme) ─────── */

    const browseWindow = $('#modal-browse');
    const localForm = $('[data-local-add]', section);
    let browseSelected = null;
    let browseLastPath = '';

    function fileSelected(d) {
        localForm.path.value = d ? d.path : '';
        const text = $('[data-selected-file]', localForm);
        text.translate = !d;
        text.textContent = d ? `${d.name} (${gb(d.size)})` : 'No file selected';
        if (d?.folder) localForm.folder.value = d.folder;
        $('button[type="submit"]', localForm).disabled = !d;
    }

    async function browse(path) {
        const list = $('[data-browse-list]', browseWindow);
        browseSelected = null;
        $('[data-browse-select]', browseWindow).disabled = true;
        let g;
        try {
            g = await api(`/api/v1/models/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);
        } catch (e) {
            notify(e.message, 'danger');
            return;
        }
        browseLastPath = g.path;
        $('[data-browse-path]', browseWindow).textContent = g.path;
        $('[data-browse-shortcuts]', browseWindow).replaceChildren(
            ...g.shortcuts.map((k) => el('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'data-browse-git': k.path, text: k.name })));
        const line = (oz, ...child) => el('button', { type: 'button', class: 'browser__row', ...oz }, ...child);
        list.replaceChildren(
            ...(g.parent ? [line({ 'data-browse-git': g.parent }, el('span', { text: '‹ Parent folder' }))] : []),
            ...g.folders.map((k) => line({ 'data-browse-git': k.path }, el('span', { class: 'browser__folder', translate: 'no', text: `${k.name}/` }))),
            ...g.files.map((d) => line({ 'data-browse-file': JSON.stringify(d), 'aria-pressed': 'false' }, el('span', { class: 'truncate', translate: 'no', text: d.name }), el('span', { class: 'code', text: gb(d.size) }))),
            ...(g.folders.length || g.files.length ? [] : [el('p', { class: 'text-sm text-muted', text: 'No model files in this folder.' })]),
        );
    }

    document.addEventListener('click', (event) => {
        if (event.target.closest('[data-modal-open="modal-browse"]')) browse(browseLastPath);
        const git = event.target.closest('[data-browse-git]');
        if (git) browse(git.dataset.browseGit);
        const file = event.target.closest('[data-browse-file]');
        if (file) {
            $$('[data-browse-file]', browseWindow).forEach((b) => b.setAttribute('aria-pressed', String(b === file)));
            browseSelected = JSON.parse(file.dataset.browseFile);
            $('[data-browse-select]', browseWindow).disabled = false;
        }
        if (event.target.closest('[data-browse-select]') && browseSelected) {
            fileSelected(browseSelected);
            $('[data-modal-close]', browseWindow).click();
        }
    });

    localForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        if (!form.path.value) return;
        const body = { path: form.path.value, folder: form.folder.value, method: 'move' };
        const file = body.path.split(/[\\/]/).pop();
        if (isInstalled(body.folder, file) && !(await ontoWriteApproval(file))) return;
        if (isInstalled(body.folder, file)) body.writeOnto = true;
        const button = $('button[type="submit"]', form);
        button.disabled = true;
        try {
            const j = await api('/api/v1/models/add', { method: 'POST', body });
            notify(j.message, 'success');
            fileSelected(null);
            await loadAll();
            pollDownloads();
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            button.disabled = false;
        }
    });

    /* ── Elimdeki model: tarayıcıdan yükleme (akışlı, ilerlemeli, iptal) ─ */

    async function loadModel(file) {
        if (!file) return;
        if (!/\.(gguf|safetensors|ckpt|pt|pth|bin)$/i.test(file.name)) {
            notify('The model file must be .gguf, .safetensors, .ckpt, .pt, .pth or .bin.', 'danger');
            return;
        }
        const folder = $('[data-upload-folder]', section).value;
        let writeOnto = false;
        if (isInstalled(folder, file.name)) {
            if (!(await ontoWriteApproval(file.name))) return;
            writeOnto = true;
        }
        const container = $('[data-upload-status]', section);
        const xhr = new XMLHttpRequest();
        const line = el('div', { class: 'panel__block stack stack--tight' },
            el('div', { class: 'row row--between' }, el('span', { class: 'line-title truncate', text: `Uploading: ${file.name}` }), el('span', { class: 'status' }, el('span', { class: 'dot dot--blue' }), el('span', { text: 'Uploading' }))),
            el('progress', { class: 'progress', max: '100', value: '0' }),
            el('div', { class: 'row row--between text-sm text-muted' }, el('span', { class: 'mono', 'data-field': 'byte', text: `0 / ${gb(file.size)}` }), el('span', { class: 'mono', 'data-field': 'speed' })),
            el('div', { class: 'job-actions' }, el('button', { type: 'button', class: 'btn btn--sm btn--danger', text: 'Cancel', 'data-upload-cancel': true })));
        container.replaceChildren(line);
        $('[data-upload-cancel]', line).addEventListener('click', () => xhr.abort());
        const startedAt = Date.now();
        xhr.upload.addEventListener('progress', (o) => {
            if (!o.lengthComputable) return;
            $('progress', line).value = (o.loaded / o.total) * 100;
            $('[data-field="byte"]', line).textContent = `${gb(o.loaded)} / ${gb(o.total)} (${number((o.loaded / o.total) * 100, 1)}%)`;
            const elapsed = (Date.now() - startedAt) / 1000;
            if (elapsed > 1) {
                const h = o.loaded / elapsed;
                $('[data-field="speed"]', line).textContent = `${speed(h)} · remaining ≈ ${durationText((o.total - o.loaded) / h)}`;
            }
        });
        const finish = (text, type) => {
            notify(text, type);
            container.replaceChildren();
            loadAll();
        };
        xhr.addEventListener('load', () => {
            let j = {};
            try {
                j = JSON.parse(xhr.responseText);
            } catch {
                /* */
            }
            if (xhr.status === 200 && j.ok) finish(j.message, 'success');
            else finish(j.error || `Upload failed (HTTP ${xhr.status}).`, 'danger');
        });
        xhr.addEventListener('error', () => finish('Upload interrupted (connection lost).', 'danger'));
        xhr.addEventListener('abort', () => finish('Upload cancelled; the partial file was deleted.', 'warning'));
        xhr.open('POST', `/api/v1/models/upload?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file.name)}${writeOnto ? '&writeOnto=1' : ''}`);
        xhr.setRequestHeader('X-Panel', '1');
        xhr.setRequestHeader('X-Panel-Lang', 'en');
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.send(file);
    }

    $('[data-model-upload]', section).addEventListener('change', (event) => {
        const d = event.target.files?.[0];
        event.target.value = '';
        loadModel(d);
    });
    const box = $('[data-upload-box]', section);
    box.addEventListener('dragover', (event) => {
        event.preventDefault();
        box.dataset.drag = 'over';
    });
    box.addEventListener('dragleave', () => delete box.dataset.drag);
    box.addEventListener('drop', (event) => {
        event.preventDefault();
        delete box.dataset.drag;
        loadModel(event.dataTransfer.files?.[0]);
    });

    /* ── Klasör seçimleri ──────────────────────────────────────────────── */

    const FOLDER_NAMES = { diffusion_models: 'diffusion_models (main models)', checkpoints: 'checkpoints', loras: 'loras', text_encoders: 'text_encoders', vae: 'vae' };
    $$('[data-folder-choice]', section).forEach((s) => s.replaceChildren(...Object.entries(FOLDER_NAMES).map(([k, name]) => el('option', { value: k, text: name }))));

    /* ── Assistant rules: every chat follows them (user request 08.10.2026: Markdown rules that are obeyed) ── */

    const rulesPanel = $('[data-setting-rules]', section);
    const rulesBox = $('[data-rules-text]', section);
    const rulesSave = $('[data-rules-save]', section);
    async function loadRules() {
        if (!rulesPanel) return;
        try {
            const r = await api('/api/v1/chat/rules');
            if (document.activeElement !== rulesBox) rulesBox.value = r.text ?? '';
            $('[data-rules-path]', section).textContent = r.path ?? '';
            rulesPanel.hidden = false;
        } catch {
            rulesPanel.hidden = true; // no local text model: no chat, no rules
            return;
        }
        loadRatings();
    }

    /* ── Rated answers: the thumbs in the chat; the good ones as training data (user request 08.10.2026) ── */

    const ratingsBox = $('[data-ratings]', section);
    async function loadRatings() {
        if (!ratingsBox) return;
        try {
            const r = await api('/api/v1/chat/ratings');
            $('[data-ratings-count]', ratingsBox).textContent = `Rated answers: ${r.good} good, ${r.bad} bad`;
            $('[data-ratings-download]', ratingsBox).disabled = !r.good;
            ratingsBox.hidden = false;
        } catch {
            ratingsBox.hidden = true;
        }
    }
    // A fetch with the panel header, not a link: a phone on the network sends no Sec-Fetch-Site, a plain link got 401
    $('[data-ratings-download]', section)?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const r = await fetch('/api/v1/chat/ratings/export', { headers: { 'X-Panel': '1', 'X-Panel-Lang': 'en' } });
            if (!r.ok) throw new Error(`Server error (HTTP ${r.status}).`);
            const url = URL.createObjectURL(await r.blob());
            const a = el('a', { href: url, download: /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'rated-chats.jsonl', hidden: true });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            button.disabled = false;
        }
    });
    rulesSave?.addEventListener('click', async () => {
        rulesSave.disabled = true;
        try {
            const r = await api('/api/v1/chat/rules', { method: 'PATCH', body: { text: rulesBox.value } });
            notify(r.message, 'success');
        } catch (e) {
            notify(e.message, 'danger');
        } finally {
            rulesSave.disabled = false;
        }
    });
    document.addEventListener('nedese:section', (event) => {
        if (event.detail.section === 'settings') loadRules();
    });
})();
