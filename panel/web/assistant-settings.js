/**
 * Settings › Assistant (user request 08.10.2026): what the assistant keeps between chats, seen and changed here:
 * scheduled tasks (the schedule tool), what the chats run in the background (sub-agents, commands, watchers, monitors,
 * wake-ups; user request 09.10.2026), lasting notes (write_memory), skills (install_skill), MCP servers (add_mcp_server)
 * and Claude / Claude Code plugins (install_plugin), all kept inside the project. Backend: /api/v1/chat/schedules,
 * /background, /memory, /skills, /mcp, /plugins.
 *
 * CLASSIC SCRIPT: loaded after app.js and uses its helpers (window.NedesePanel: el, api, notify). Deleting asks first
 * with the panel's confirm dialog (design.js data-confirm), which submits the button's form: each delete button has a
 * form of its own whose submit() does the work.
 */
(function () {
    'use strict';

    const { el, api, notify } = window.NedesePanel;
    const section = document.querySelector('[data-section="settings"]');
    const panel = section?.querySelector('[data-setting-assistant]');
    if (!panel) return;

    const APPROVAL_MODES = [['manual', 'Manual'], ['edits', 'Allow edits'], ['auto', 'Automatic']];
    const body = (part) => panel.querySelector(`[data-assistant-body="${part}"]`);
    const setCount = (part, n) => {
        panel.querySelector(`[data-assistant-count="${part}"]`).textContent = n ? String(n) : '';
    };
    const when = (iso) => new Date(iso).toLocaleString(window.NedeseLang?.local ?? 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    // a date for <input type="datetime-local"> (local time, minutes)
    const localInput = (date) => {
        const d = new Date(date);
        const two = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
    };
    const field = (label, control, hint = null) => el('label', { class: 'field' }, el('span', { class: 'field__label', text: label }), control, hint ? el('span', { class: 'field__hint', text: hint }) : null);

    /** A button that asks first (the confirm dialog) and then runs action; it sits in a form of its own. */
    function deleteButton(label, question, action, extra = {}) {
        const button = el('button', { type: 'submit', class: 'btn btn--sm btn--ghost', 'data-confirm': question, 'data-confirm-title': label, 'data-confirm-variant': 'danger', text: label, ...extra });
        const form = el('form', { class: 'assistant-item__delete' }, button);
        form.addEventListener('submit', (e) => e.preventDefault());
        form.submit = async () => {
            button.disabled = true;
            try {
                await action();
            } catch (e) {
                notify(e.message, 'danger');
            } finally {
                button.disabled = false;
            }
        };
        return form;
    }

    /** Runs a change, says what happened and draws the part again. */
    async function change(request, reload) {
        try {
            const r = await request();
            if (r?.message) notify(r.message, 'success');
            await reload();
            return r;
        } catch (e) {
            notify(e.message, 'danger');
            return null;
        }
    }

    const empty = (text) => el('p', { class: 'text-sm text-muted', text });

    /* ── Scheduled tasks ── */

    async function loadSchedules() {
        const { schedules } = await api('/api/v1/chat/schedules');
        setCount('schedules', schedules.length);
        body('schedules').replaceChildren(
            ...(schedules.length ? schedules.map(scheduleRow) : [empty('No scheduled tasks. Ask the assistant ("every morning at 9, …") or add one below.')]),
            scheduleForm(null));
    }

    function scheduleRow(z) {
        const mode = APPROVAL_MODES.find(([v]) => v === z.approvalMode)?.[1] ?? z.approvalMode;
        const row = el('div', { class: 'assistant-item', 'data-schedule-id': z.id },
            el('div', { class: 'assistant-item__text', translate: 'no', text: z.task }),
            el('div', { class: 'assistant-item__meta' },
                el('span', { text: `Next: ${when(z.time)}` }),
                el('span', { text: z.repeatMin ? `every ${z.repeatMin} min` : 'once' }),
                el('span', { text: mode }),
                z.full ? null : el('span', { text: 'panel operations only' }),
                z.chat ? el('span', { text: 'goes on in its chat' }) : null));
        const edit = el('button', { type: 'button', class: 'btn btn--sm', 'data-schedule-edit': z.id, text: 'Edit' });
        edit.addEventListener('click', () => row.replaceWith(scheduleForm(z)));
        row.append(el('div', { class: 'row-actions' }, edit, deleteButton('Delete task', 'Delete this scheduled task? It does not run again.', () => change(() => api(`/api/v1/chat/schedules/${encodeURIComponent(z.id)}`, { method: 'DELETE' }), loadSchedules))));
        return row;
    }

    /** The form of a new task (z null) or of one being changed. */
    function scheduleForm(z) {
        const task = el('textarea', { class: 'textarea', name: 'task', rows: 3, required: true, placeholder: 'e.g. Check the free disk space and tell me if it is under 20 GB' });
        task.value = z?.task ?? '';
        const time = el('input', { class: 'input', type: 'datetime-local', name: 'time', required: true, value: localInput(z?.time ?? Date.now() + 3600000) });
        const repeat = el('input', { class: 'input', type: 'number', name: 'repeatMin', min: 0, step: 1, value: z?.repeatMin ?? '', placeholder: 'once' });
        const mode = el('select', { class: 'select', name: 'approvalMode' }, ...APPROVAL_MODES.map(([v, n]) => el('option', { value: v, text: n, selected: (z?.approvalMode ?? 'edits') === v })));
        const save = el('button', { type: 'submit', class: 'btn btn--sm btn--primary', text: z ? 'Save task' : 'Add task' });
        const form = el('form', { class: `stack assistant-form${z ? ' assistant-item' : ''}`, 'data-schedule-form': z?.id ?? 'new' },
            z ? null : el('h3', { class: 'assistant-form__title', text: 'Add a task' }),
            field('Task', task),
            el('div', { class: 'form-grid' }, field('Next run', time), field('Repeat every (minutes)', repeat, 'Empty: once. 1440: every day.'), field('Approval mode', mode)),
            el('div', { class: 'row row--wrap' }, save));
        if (z) {
            const cancel = el('button', { type: 'button', class: 'btn btn--sm btn--ghost', text: 'Cancel' });
            cancel.addEventListener('click', () => form.replaceWith(scheduleRow(z)));
            form.lastElementChild.append(cancel);
        }
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            save.disabled = true;
            const values = { task: task.value, time: new Date(time.value).toISOString(), repeatMin: Number(repeat.value) || null, approvalMode: mode.value };
            await change(() => api(z ? `/api/v1/chat/schedules/${encodeURIComponent(z.id)}` : '/api/v1/chat/schedules', { method: z ? 'PATCH' : 'POST', body: values }), loadSchedules);
            save.disabled = false;
        });
        return form;
    }

    /* ── Running in the background (user request 09.10.2026): what the chats run on their own, each with a Stop ── */

    const KINDS = { agent: 'Sub-agent', command: 'Background command', watch: 'Watcher', monitor: 'Monitor', wakeup: 'Wake-up' };
    const STATES = { running: 'running', waiting: 'waiting', done: 'done', stopped: 'stopped', error: 'error' };

    async function loadBackground() {
        const { items } = await api('/api/v1/chat/background');
        setCount('background', items.length);
        body('background').replaceChildren(
            el('p', { class: 'field__hint', text: 'What the chats run on their own: sub-agents, background commands, watchers (they check something every few minutes until it is true), monitors (they follow the output of a command) and wake-ups. Each wakes its chat when something happens; a stopped one does not.' }),
            ...(items.length ? items.map(backgroundRow) : [empty('Nothing runs in the background.')]));
    }

    function backgroundRow(x) {
        const meta = [el('span', { text: KINDS[x.kind] ?? x.kind }), el('span', { text: STATES[x.status] ?? x.status })];
        if (x.kind === 'watch') meta.push(el('span', { text: `every ${x.every} min` }), x.last ? el('span', { text: `Last check: ${when(x.last.time)}` }) : null, el('span', { text: `Ends: ${when(x.ends)}` }));
        else if (x.kind === 'wakeup') meta.push(el('span', { text: `Next: ${when(x.next)}` }), el('span', { text: x.every ? `every ${x.every} min` : 'once' }));
        else if (x.kind === 'monitor') meta.push(el('span', { text: `Ends: ${when(x.ends)}` }));
        else meta.push(el('span', { text: `Started: ${when(x.started)}` }));
        const stop = el('button', { type: 'button', class: 'btn btn--sm', 'data-background-stop': x.id, text: 'Stop' });
        stop.addEventListener('click', async () => {
            stop.disabled = true;
            // a wake-up is also a scheduled task: both lists follow
            await change(() => api(`/api/v1/chat/background/${encodeURIComponent(x.id)}`, { method: 'DELETE' }), () => Promise.all([loadBackground(), loadSchedules()]));
            stop.disabled = false;
        });
        return el('div', { class: 'assistant-item', 'data-background-item': x.id },
            el('div', { class: 'assistant-item__text', translate: 'no', text: x.text }),
            el('div', { class: 'assistant-item__meta' }, ...meta.filter(Boolean)),
            x.chatTitle ? el('div', { class: 'assistant-item__meta' }, el('span', { text: 'Chat:' }), ' ', el('span', { translate: 'no', text: x.chatTitle })) : null,
            x.last?.text ? el('div', { class: 'assistant-item__meta mono', translate: 'no', text: x.last.text }) : null,
            el('div', { class: 'row-actions' }, stop));
    }

    /* ── Lasting notes ── */

    let memoryQuery = '';
    async function loadMemory() {
        const r = await api(`/api/v1/chat/memory${memoryQuery ? `?q=${encodeURIComponent(memoryQuery)}` : ''}`);
        setCount('memory', r.total);
        const search = el('input', { class: 'input', type: 'search', 'data-memory-search': true, placeholder: 'Search the notes', 'aria-label': 'Search the notes', value: memoryQuery });
        let timer = 0;
        search.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(async () => {
                memoryQuery = search.value.trim();
                await loadMemory();
                const again = body('memory').querySelector('[data-memory-search]');
                again?.focus();
                again?.setSelectionRange(again.value.length, again.value.length);
            }, 250);
        });
        const text = el('input', { class: 'input', name: 'text', maxlength: 500, required: true, autocomplete: 'off', placeholder: 'e.g. Answer in Turkish.', 'aria-label': 'New note' });
        const add = el('form', { class: 'row row--tight', 'data-memory-add': true }, text, el('button', { type: 'submit', class: 'btn btn--sm btn--primary', text: 'Add note' }));
        add.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (await change(() => api('/api/v1/chat/memory', { method: 'POST', body: { text: text.value } }), loadMemory)) text.value = '';
        });
        // replaceChildren writes a null as the text "null": the search box is left out when there are no notes
        body('memory').replaceChildren(
            ...[
                el('p', { class: 'field__hint', text: 'The assistant reads the newest notes in every chat and writes new ones when you ask it to remember something.' }),
                r.total ? search : null,
                ...(r.notes.length ? r.notes.map(noteRow) : [empty(r.total ? 'No note has all of these words.' : 'No notes yet.')]),
                add,
            ].filter(Boolean));
    }

    function noteRow(n) {
        const row = el('div', { class: 'assistant-item', 'data-note-id': n.id },
            el('div', { class: 'assistant-item__text', translate: 'no', text: n.text }),
            el('div', { class: 'assistant-item__meta', translate: 'no' }, el('span', { text: n.id }), n.date ? el('span', { text: n.date }) : null));
        const edit = el('button', { type: 'button', class: 'btn btn--sm', 'data-note-edit': n.id, text: 'Edit' });
        edit.addEventListener('click', () => {
            const input = el('input', { class: 'input', maxlength: 500, required: true, value: n.text, 'aria-label': 'Note' });
            const save = el('button', { type: 'submit', class: 'btn btn--sm btn--primary', text: 'Save' });
            const cancel = el('button', { type: 'button', class: 'btn btn--sm btn--ghost', text: 'Cancel' });
            const form = el('form', { class: 'stack assistant-item', 'data-note-form': n.id }, input, el('div', { class: 'row row--wrap' }, save, cancel));
            cancel.addEventListener('click', () => form.replaceWith(noteRow(n)));
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                change(() => api(`/api/v1/chat/memory/${encodeURIComponent(n.id)}`, { method: 'PATCH', body: { text: input.value } }), loadMemory);
            });
            row.replaceWith(form);
            input.focus();
        });
        row.append(el('div', { class: 'row-actions' }, edit, deleteButton('Delete note', 'Delete this note? The assistant forgets it.', () => change(() => api(`/api/v1/chat/memory/${encodeURIComponent(n.id)}`, { method: 'DELETE' }), loadMemory))));
        return row;
    }

    /* ── Skills ── */

    const SOURCES = { panel: 'installed by the panel', project: 'project (.claude\\skills, .mcp.json)' };
    const sourceName = (s) => SOURCES[s] ?? (String(s).startsWith('plugin:') ? `plugin ${String(s).slice(7)}` : s);

    async function loadSkills() {
        const { skills } = await api('/api/v1/chat/skills');
        setCount('skills', skills.length);
        body('skills').replaceChildren(
            el('p', { class: 'field__hint', text: 'The assistant loads a skill when a task needs it. To install one, ask it in a chat (install_skill or install_plugin, from GitHub or a folder).' }),
            ...(skills.length ? skills.map((k) => el('div', { class: 'assistant-item', 'data-skill': k.name },
                el('div', { class: 'assistant-item__name', translate: 'no', text: k.name }),
                k.description ? el('div', { class: 'assistant-item__text', translate: 'no', text: k.description }) : null,
                el('div', { class: 'assistant-item__meta' }, el('span', { text: sourceName(k.source) })),
                k.removable ? el('div', { class: 'row-actions' }, deleteButton('Remove skill', `Remove the skill "${k.name}"? Its folder goes to the Recycle Bin.`, () => change(() => api(`/api/v1/chat/skills/${encodeURIComponent(k.name)}`, { method: 'DELETE' }), loadSkills))) : null)) : [empty('No skills installed.')]));
    }

    /* ── MCP servers ── */

    async function loadMcp() {
        const { servers } = await api('/api/v1/chat/mcp');
        setCount('mcp', servers.length);
        body('mcp').replaceChildren(
            el('p', { class: 'field__hint', text: 'Programs that give the assistant more tools. Servers of the project and of plugins can be turned off here; their files stay as they are.' }),
            ...(servers.length ? servers.map(serverRow) : [empty('No MCP servers.')]),
            mcpForm());
    }

    /* ── Plugins ── */

    async function loadPlugins() {
        const { plugins } = await api('/api/v1/chat/plugins');
        setCount('plugins', plugins.length);
        body('plugins').replaceChildren(
            el('p', { class: 'field__hint', text: 'Claude and Claude Code plugins installed into the panel (panel-data\\plugins): their skills and MCP servers are listed above. To install one, ask it in a chat (install_plugin, a GitHub plugin or marketplace).' }),
            ...(plugins.length ? plugins.map((p) => el('div', { class: 'assistant-item', 'data-plugin': p.name },
                el('div', { class: 'row row--wrap' }, el('span', { class: 'assistant-item__name', translate: 'no', text: p.name }), p.version ? el('span', { class: 'badge', translate: 'no', text: p.version }) : null),
                p.description ? el('div', { class: 'assistant-item__text', translate: 'no', text: p.description }) : null,
                p.skills.length ? el('div', { class: 'assistant-item__meta' }, el('span', { text: 'Skills:' }), ' ', el('span', { translate: 'no', text: p.skills.join(', ') })) : null,
                p.mcp.length ? el('div', { class: 'assistant-item__meta' }, el('span', { text: 'MCP servers:' }), ' ', el('span', { translate: 'no', text: p.mcp.join(', ') })) : null,
                el('div', { class: 'row-actions' }, deleteButton('Remove plugin', `Remove the plugin "${p.name}"? Its folder goes to the Recycle Bin; its skills and MCP servers leave the chats.`, () => change(() => api(`/api/v1/chat/plugins/${encodeURIComponent(p.name)}`, { method: 'DELETE' }), () => Promise.all([loadPlugins(), loadSkills(), loadMcp()])))))) : [empty('No plugins installed.')]));
    }

    function serverRow(s) {
        // the number and the names apart from the words: no pattern that would catch other texts ending in "tools"
        const state = s.disabled ? el('span', { class: 'badge', text: 'off' })
            : s.missing.length ? el('span', { class: 'badge badge--yellow' }, el('span', { text: 'missing:' }), ' ', el('span', { translate: 'no', text: s.missing.join(', ') }))
                : s.tools ? el('span', { class: 'badge badge--green' }, `${s.tools.length} `, el('span', { text: s.tools.length === 1 ? 'tool' : 'tools' })) : null;
        const on = el('input', { type: 'checkbox', 'data-mcp-on': s.name, checked: !s.disabled });
        on.addEventListener('change', () => change(() => api(`/api/v1/chat/mcp/${encodeURIComponent(s.name)}`, { method: 'PATCH', body: { disabled: !on.checked } }), loadMcp));
        const timeout = el('input', { class: 'input assistant-item__number', type: 'number', min: 1, step: 1, value: s.timeoutSec ?? '', placeholder: '600', 'aria-label': 'Time limit of one tool call (seconds)', 'data-mcp-timeout': s.name });
        timeout.addEventListener('change', () => change(() => api(`/api/v1/chat/mcp/${encodeURIComponent(s.name)}`, { method: 'PATCH', body: { timeoutSec: timeout.value ? Number(timeout.value) : null } }), loadMcp));
        const check = el('button', { type: 'button', class: 'btn btn--sm', 'data-mcp-check': s.name, text: 'Check', disabled: s.disabled });
        check.addEventListener('click', async () => {
            check.disabled = true;
            await change(() => api(`/api/v1/chat/mcp/${encodeURIComponent(s.name)}/check`, { method: 'POST' }), loadMcp);
            check.disabled = false;
        });
        return el('div', { class: 'assistant-item', 'data-mcp-server': s.name },
            el('div', { class: 'row row--wrap' }, el('span', { class: 'assistant-item__name', translate: 'no', text: s.name }), state),
            el('div', { class: 'assistant-item__text mono', translate: 'no', text: s.target || '—' }),
            el('div', { class: 'assistant-item__meta' }, el('span', { text: sourceName(s.source) }), s.type ? el('span', { translate: 'no', text: s.type }) : null),
            s.tools?.length ? el('div', { class: 'assistant-item__meta', translate: 'no', text: s.tools.join(', ') }) : null,
            el('div', { class: 'row row--wrap assistant-item__controls' },
                el('label', { class: 'checkbox' }, on, el('span', { text: 'On' })),
                el('label', { class: 'row row--tight assistant-item__limit' }, el('span', { class: 'text-sm', text: 'Time limit (s)' }), timeout),
                check,
                s.editable ? deleteButton('Remove server', `Remove the MCP server "${s.name}"? Its tools leave the chats.`, () => change(() => api(`/api/v1/chat/mcp/${encodeURIComponent(s.name)}`, { method: 'DELETE' }), loadMcp)) : null));
    }

    /** Lines "KEY=value" (environment) or "Name: value" (headers) as an object. */
    const pairs = (text, separator) => Object.fromEntries(String(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const at = l.indexOf(separator);
        return at > 0 ? [l.slice(0, at).trim(), l.slice(at + 1).trim()] : [l, ''];
    }));

    function mcpForm() {
        const name = el('input', { class: 'input', name: 'name', required: true, maxlength: 40, autocomplete: 'off', placeholder: 'e.g. files' });
        const kind = el('select', { class: 'select', name: 'kind' }, el('option', { value: 'command', text: 'A program on this computer' }), el('option', { value: 'url', text: 'A remote server (address)' }));
        const command = el('input', { class: 'input mono', name: 'command', autocomplete: 'off', placeholder: 'e.g. npx', translate: 'no' });
        const args = el('textarea', { class: 'textarea mono', name: 'args', rows: 3, placeholder: 'One per line, e.g.\n-y\n@modelcontextprotocol/server-filesystem\nC:\\ai' });
        const env = el('textarea', { class: 'textarea mono', name: 'env', rows: 2, placeholder: 'KEY=value, one per line' });
        const url = el('input', { class: 'input mono', name: 'url', autocomplete: 'off', placeholder: 'https://…' });
        const headers = el('textarea', { class: 'textarea mono', name: 'headers', rows: 2, placeholder: 'Authorization: Bearer …, one per line' });
        const timeout = el('input', { class: 'input', type: 'number', name: 'timeoutSec', min: 1, step: 1, placeholder: '600' });
        const local = el('div', { class: 'stack' }, field('Command', command), field('Arguments', args), field('Environment variables', env));
        const remote = el('div', { class: 'stack', hidden: true }, field('Address', url), field('Headers', headers));
        kind.addEventListener('change', () => {
            local.hidden = kind.value !== 'command';
            remote.hidden = kind.value === 'command';
        });
        const save = el('button', { type: 'submit', class: 'btn btn--sm btn--primary', text: 'Add server' });
        const form = el('form', { class: 'stack assistant-form', 'data-mcp-form': true },
            el('h3', { class: 'assistant-form__title', text: 'Add an MCP server' }),
            el('div', { class: 'form-grid' }, field('Name', name), field('Kind', kind)),
            local, remote,
            field('Time limit of one tool call (seconds)', timeout, 'Empty: 600.'),
            el('div', { class: 'row row--wrap' }, save, el('span', { class: 'field__hint', text: 'It is started to check that it works.' })));
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            save.disabled = true;
            const values = kind.value === 'command'
                ? { name: name.value, command: command.value, args: args.value.split('\n').map((a) => a.trim()).filter(Boolean), env: pairs(env.value, '=') }
                : { name: name.value, url: url.value, headers: pairs(headers.value, ':') };
            await change(() => api('/api/v1/chat/mcp', { method: 'POST', body: { ...values, timeoutSec: timeout.value ? Number(timeout.value) : null } }), loadMcp);
            save.disabled = false;
        });
        return form;
    }

    /* ── Loading ── */

    async function load() {
        try {
            // without the local text model there is no assistant
            if (!(await api('/api/v1/chat?limit=1')).textModel) {
                panel.hidden = true;
                return;
            }
            await Promise.all([loadSchedules(), loadBackground(), loadMemory(), loadSkills(), loadMcp(), loadPlugins()]);
            panel.hidden = false;
        } catch (e) {
            panel.hidden = true;
        }
    }
    document.addEventListener('nedese:section', (event) => {
        if (event.detail.section === 'settings') load();
    });
})();
