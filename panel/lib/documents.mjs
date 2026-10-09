/**
 * API docs: builds the HTML page (/api/documents; English source, Turkish from the dictionary with ?lang=tr) and the
 * OpenAPI 3 JSON (/api/v1/openapi.json) from the route table (api.mjs). There is NO hand-written endpoint list.
 */
import { API_PREFIX, JOB_TYPES } from './api.mjs';
import { translate } from './language.mjs';

const GROUP_POSITION = ['General', 'Chat', 'Knowledge', 'Jobs', 'Gallery and uploads', 'Voice library', 'Model training', 'Scene writer', 'ComfyUI', 'Settings', 'Models', 'Docs'];

const k = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function curlExample(r, address) {
  if (r.exampleCurl) return r.exampleCurl.replace('http://127.0.0.1:1071', address.replace(/\/$/, ''));
  const path = r.path.replace(/\{(\w+)\}/g, (_, a) => `<${a}>`);
  const url = `${address.replace(/\/$/, '')}${API_PREFIX}${path}`;
  const authority = r.unauthorized ? '' : ' -H "Authorization: Bearer $KEY"';
  if (r.method === 'GET') return `curl${authority} "${url}"`;
  if (r.body?.type === 'json') return `curl -X ${r.method}${authority} -H "Content-Type: application/json" -d '${JSON.stringify(r.body.example)}' "${url}"`;
  return `curl -X ${r.method}${authority} "${url}"`;
}

function fieldTable(fields, t) {
  if (!fields?.length) return '';
  return `<table class="table"><thead><tr><th>${t('Field')}</th><th>${t('Type')}</th><th>${t('Required')}</th><th>${t('Description')}</th></tr></thead><tbody>${fields
    .map((a) => `<tr><td data-label="${t('Field')}" class="mono">${k(a.name)}</td><td data-label="${t('Type')}" class="mono">${k(a.type)}</td><td data-label="${t('Required')}">${a.required ? `<span class="required">${t('required')}</span>` : t('optional')}${a.defaultValue !== undefined ? ` <span class="text-muted">(${t('default')} ${k(JSON.stringify(a.defaultValue))})</span>` : ''}</td><td data-label="${t('Description')}">${k(t(a.description ?? ''))}${a.options ? ` <span class="mono">${a.options.map(k).join(' | ')}</span>` : ''}</td></tr>`)
    .join('')}</tbody></table>`;
}

function paramTable(params, t) {
  if (!params?.length) return '';
  return `<table class="table"><thead><tr><th>${t('Parameter')}</th><th>${t('In')}</th><th>${t('Required')}</th><th>${t('Description')}</th></tr></thead><tbody>${params
    .map((p) => `<tr><td data-label="${t('Parameter')}" class="mono">${k(p.name)}</td><td data-label="${t('In')}">${t(p.place === 'path' ? 'path' : 'query (?)')}</td><td data-label="${t('Required')}">${p.required ? `<span class="required">${t('required')}</span>` : t('optional')}</td><td data-label="${t('Description')}">${k(t(p.description ?? ''))}</td></tr>`)
    .join('')}</tbody></table>`;
}

// The panel's day / night button (index.html); the choice is the panel's own ('theme' in localStorage), so both pages
// open in the same theme (user report 09.10.2026: the API page had no day / night button).
const themeToggle = (t) => `<button type="button" class="btn btn--ghost btn--icon btn--sm" data-theme-toggle aria-label="${t('Change theme')}" title="${t('Change theme')}"><svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.6 6.6 0 0 0 10.7 10.7z" stroke-linejoin="round"/></svg><svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round"/></svg></button>`;

export function docsPage(routes, { address = 'http://127.0.0.1:1071/', language = 'en' } = {}) {
  const t = (s) => translate(s, language);
  const english = language === 'en';
  const groups = new Map();
  for (const r of routes) (groups.get(r.group) ?? groups.set(r.group, []).get(r.group)).push(r);
  const ordered = [...groups.keys()].sort((a, b) => GROUP_POSITION.indexOf(a) - GROUP_POSITION.indexOf(b));
  const id = (r) => `${r.method.toLowerCase()}-${r.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`;

  const contents = ordered.map((g) => `<li><strong>${k(t(g))}</strong><ul>${groups.get(g).map((r) => `<li><a href="#${id(r)}"><span class="doc-method doc-method--${r.method.toLowerCase()}">${r.method}</span> <span class="mono">${k(r.path)}</span> — ${k(t(r.summary))}</a></li>`).join('')}</ul></li>`).join('');

  const sections = ordered
    .map(
      (g) => `<section class="panel"><header class="panel__head"><h2 class="panel__title" id="group-${k(g).replace(/\W+/g, '-')}">${k(t(g))}</h2></header><div class="panel__body stack">${groups
        .get(g)
        .map(
          (r) => `<article class="doc-route" id="${id(r)}">
  <h3 class="doc-route__title"><span class="doc-method doc-method--${r.method.toLowerCase()}">${r.method}</span> <code>${API_PREFIX}${k(r.path)}</code>${r.unauthorized ? ` <span class="badge">${t('no key needed')}</span>` : ''}</h3>
  <p><strong>${k(t(r.summary))}.</strong> ${k(t(r.description))}</p>
  ${paramTable(r.params, t)}
  ${r.body ? `<p class="text-sm text-muted">${t('Body')}: ${r.body.type === 'json' ? 'JSON' : `${t('raw file')} (${k(t(r.body.description ?? ''))})`}${r.body.description && r.body.type === 'json' ? ` — ${k(t(r.body.description))}` : ''}</p>${fieldTable(r.body.fields, t)}` : ''}
  <p class="text-sm text-muted">${t('Example request')}</p><pre class="config-preview">${k(curlExample(r, address))}</pre>
  ${r.response !== undefined ? `<p class="text-sm text-muted">${t('Example response')}</p><pre class="config-preview">${k(typeof r.response === 'string' ? r.response : JSON.stringify(r.response.ok === undefined ? { ok: true, ...r.response } : r.response, null, 1))}</pre>` : ''}
</article>`,
        )
        .join('')}</div></section>`,
    )
    .join('');

  const jobTypes = Object.entries(JOB_TYPES)
    .map(
      ([type, b]) => `<article class="doc-route" id="job-${type}"><h3 class="doc-route__title"><code>type: "${type}"</code> — ${k(t(b.name))}</h3><p>${k(t(b.description))}</p>${fieldTable(b.fields, t)}<p class="text-sm text-muted">${t('Example body')} (POST ${API_PREFIX}/jobs)</p><pre class="config-preview">${k(JSON.stringify(b.example, null, 1))}</pre></article>`,
    )
    .join('');

  const base = `<span class="mono">${k(address.replace(/\/$/, ''))}${API_PREFIX}</span>`;
  const baseUrl = `${k(address.replace(/\/$/, ''))}${API_PREFIX}`;
  // Getting started: written by hand in both languages (not through the dictionary); field and address names are shared.
  const start = english
    ? `<p><strong>Auth.</strong> Add the <span class="mono">Authorization: Bearer &lt;key&gt;</span> header to every request. The key is shown and can be regenerated on the <a href="/#settings">Settings</a> page (file: <span class="mono">panel-data\\settings.json</span>). Requests without a key return <span class="mono">401</span>. The panel's own UI works without a key from the same origin (with the <span class="mono">X-Panel: 1</span> header); requests from other sites are rejected by the Host/Origin check.</p>
<pre class="config-preview">export KEY=aip_...          # from the Settings page
curl -H "Authorization: Bearer $KEY" ${baseUrl}/status</pre>
<p><strong>Language.</strong> Messages are English by default. Add <span class="mono">?lang=tr</span> or send <span class="mono">Accept-Language: tr</span> (or <span class="mono">X-Panel-Lang: tr</span>) for Turkish; field names stay the same.</p>
<p><strong>Response format.</strong> On success <span class="mono">{ "ok": true, ... }</span>; on error <span class="mono">{ "ok": false, "error": "message", "code": "invalid | unauthorized | notFound | inUse | server" }</span> with HTTP 400 / 401 / 404 / 409 / 500. Dates are ISO 8601 (UTC), sizes in bytes, durations in seconds.</p>
<p><strong>Job flow.</strong> Create a job with <span class="mono">POST /jobs</span> (validated immediately, runs when its turn comes); follow progress (<span class="mono">progress.percent</span>, <span class="mono">progress.stage</span>) and outputs with <span class="mono">GET /jobs/{id}</span>; download output files from <span class="mono">outputs[].url</span>. If the panel closes, a running job becomes "interrupted" and <span class="mono">POST /jobs/{id}/retry</span> continues where it left off. Pausable jobs (model training) can be paused with <span class="mono">POST /jobs/{id}/pause</span> (GPU and RAM are freed, status "paused"); <span class="mono">/retry</span> resumes from the last checkpoint. The older <span class="mono">/api/*</span> endpoints keep working for the UI.</p>
<p><strong>Files.</strong> Outputs at <span class="mono">/file/job/{id}/{file}</span>, uploads at <span class="mono">/file/upload/{file}</span>, voices at <span class="mono">/file/voice/{id}.wav</span> (Range supported; <span class="mono">?download=1</span> adds a download header). These need no key beyond the Host check (the UI reads them via &lt;img&gt;/&lt;video&gt;).</p>`
    : `<p><strong>Yetki.</strong> Her isteğe <span class="mono">Authorization: Bearer &lt;anahtar&gt;</span> başlığı eklenir. Anahtar <a href="/#settings">Ayarlar</a> sayfasında görünür ve yenilenebilir (dosya: <span class="mono">panel-data\\settings.json</span>). Anahtarsız istek <span class="mono">401</span> döner. Panelin kendi arayüzü aynı kaynaktan (<span class="mono">X-Panel: 1</span> başlığıyla) anahtarsız çalışır; başka sitelerden gelen istekler Host/Origin denetimiyle reddedilir.</p>
<pre class="config-preview">export KEY=aip_...          # Ayarlar sayfasından
curl -H "Authorization: Bearer $KEY" ${baseUrl}/status</pre>
<p><strong>Dil.</strong> Mesajlar varsayılan olarak İngilizcedir. Türkçe için <span class="mono">?lang=tr</span> ekleyin ya da <span class="mono">Accept-Language: tr</span> (ya da <span class="mono">X-Panel-Lang: tr</span>) gönderin; alan adları aynı kalır.</p>
<p><strong>Yanıt biçimi.</strong> Başarıda <span class="mono">{ "ok": true, ... }</span>; hatada <span class="mono">{ "ok": false, "error": "mesaj", "code": "invalid | unauthorized | notFound | inUse | server" }</span> ve HTTP 400 / 401 / 404 / 409 / 500. Tarihler ISO 8601 (UTC), boyutlar bayt, süreler saniye.</p>
<p><strong>İş akışı.</strong> <span class="mono">POST /jobs</span> ile iş oluşturulur (hemen doğrulanır, sırası gelince çalışır); <span class="mono">GET /jobs/{id}</span> ile ilerleme (<span class="mono">progress.percent</span>, <span class="mono">progress.stage</span>) ve çıktılar izlenir; çıktı dosyaları <span class="mono">outputs[].url</span> adresinden indirilir. Panel kapanırsa çalışan iş "interrupted" (yarıda) olur, <span class="mono">POST /jobs/{id}/retry</span> kaldığı yerden sürdürür. Duraklatılabilen işler (model eğitimi) <span class="mono">POST /jobs/{id}/pause</span> ile duraklatılır (ekran kartı ve RAM boşalır, durum "paused"); <span class="mono">/retry</span> son kayıt noktasından sürdürür. Eski <span class="mono">/api/*</span> adresleri arayüz için aynen çalışmaya devam eder.</p>
<p><strong>Dosyalar.</strong> Çıktılar <span class="mono">/file/job/{id}/{file}</span>, yüklemeler <span class="mono">/file/upload/{file}</span>, sesler <span class="mono">/file/voice/{id}.wav</span> (Range destekli; <span class="mono">?download=1</span> indirme başlığı). Bu adresler Host denetimi dışında yetki istemez (arayüz &lt;img&gt;/&lt;video&gt; ile okur).</p>`;

  return `<!doctype html>
<html lang="${language}" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('API docs')} · Nedese Studio</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/app.css">
<script>try { var t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}</script>
<style>
.doc-method { display: inline-block; min-width: 3.6em; padding: 1px 6px; border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: var(--text-xs); font-weight: var(--weight-semibold); text-align: center; background: var(--color-selected); }
.doc-method--get { background: var(--color-green-bg, #1f3d2b); color: var(--color-green-fg, #7fd99a); }
.doc-method--post { background: var(--color-blue-bg, #1d3550); color: var(--color-blue-fg, #8fc1ff); }
.doc-method--patch { background: var(--color-yellow-bg, #4a3a14); color: var(--color-yellow-fg, #f0c861); }
.doc-method--delete { background: var(--color-red-bg, #4a1d1d); color: var(--color-red-fg, #ff8d8d); }
.doc-route + .doc-route { border-top: 1px solid var(--color-line); padding-top: var(--space-5); }
.doc-route__title { font-size: var(--text-md); margin-bottom: var(--space-2); }
.doc-route__title code { font-family: var(--font-mono); }
.doc-contents ul { list-style: none; padding-left: var(--space-4); }
.doc-contents > ul > li { margin-bottom: var(--space-3); }
.doc-route .table { margin: var(--space-3) 0; }
.doc-route pre { max-height: 420px; }
@media (max-width: 720px) {
  .doc-route .table td { justify-content: flex-start; text-align: left; }
  .doc-route .table td::before { flex: 0 0 6.5rem; }
}
.doc-lang { display: inline-flex; gap: 4px; align-items: center; font-size: var(--text-sm); }
.doc-lang a { color: var(--color-text-muted); }
.doc-lang a[aria-current] { color: var(--color-text); text-decoration: underline; text-underline-offset: 3px; }
</style>
</head>
<body>
<div class="shell">
<header class="topbar"><a href="/" class="topbar__mark">Nedese Studio</a><nav class="topbar__nav"><a href="/#settings" class="topbar__link">${t('Settings')}</a><a href="/api/documents?lang=${language}" class="topbar__link" aria-current="page">API</a><a href="${API_PREFIX}/openapi.json?lang=${language}" class="topbar__link">openapi.json</a></nav><span class="topbar__spacer"></span><span class="doc-lang"><a href="/api/documents?lang=en"${english ? ' aria-current="true"' : ''}>EN</a><span aria-hidden="true">|</span><a href="/api/documents?lang=tr"${english ? '' : ' aria-current="true"'}>TR</a></span>${themeToggle(t)}</header>
<div class="page"><div class="page__inner">
<header class="page-head"><div class="page-head__text"><h1>${t('API docs')}</h1><p class="page-head__subtitle">${english ? 'Everything the panel can do is also available to programs. Base URL' : 'Panelin yaptığı her şey programlara da açıktır. Temel adres'} ${base}.</p></div></header>

<section class="panel"><header class="panel__head"><h2 class="panel__title">${english ? 'Getting started' : 'Başlarken'}</h2></header><div class="panel__body stack">
${start}
</div></section>

<section class="panel"><header class="panel__head"><h2 class="panel__title">${t('Contents')}</h2></header><div class="panel__body doc-contents"><ul>${contents}<li><strong>${t('Job types')}</strong><ul>${Object.entries(JOB_TYPES).map(([type, b]) => `<li><a href="#job-${type}"><span class="mono">${type}</span> — ${k(t(b.name))}</a></li>`).join('')}</ul></li></ul></div></section>

${sections}

<section class="panel"><header class="panel__head"><div><h2 class="panel__title" id="job-types">${t('Job types')} (POST ${API_PREFIX}/jobs)</h2><p class="text-sm text-muted">${english ? 'The fields match the UI forms exactly; the server validates them and an invalid field returns 400 with a message.' : 'Alanlar arayüz formlarıyla birebir aynıdır; sunucu doğrular, geçersiz alan mesajla 400 döner.'}</p></div></header><div class="panel__body stack">${jobTypes}</div></section>
</div></div></div>
<script>
document.querySelector('[data-theme-toggle]').addEventListener('click', function () {
  var fresh = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = fresh;
  try { localStorage.setItem('theme', fresh); } catch (e) {}
});
</script>
</body>
</html>`;
}

function schemaField(a, t = (x) => x) {
  const type = { string: 'string', integer: 'integer', number: 'number', boolean: 'boolean', array: 'array', object: 'object' }[a.type] ?? 'string';
  const s = { type: type, description: t(a.description ?? '') };
  if (a.options) s.enum = a.options;
  if (a.defaultValue !== undefined) s.default = a.defaultValue;
  if (type === 'array') s.items = { type: 'object' };
  return s;
}

export function openapi(routes, { address = 'http://127.0.0.1:1071/', language = 'en' } = {}) {
  const t = (s) => translate(s, language);
  const paths = {};
  for (const r of routes) {
    const path = `${API_PREFIX}${r.path}`;
    const op = {
      summary: t(r.summary),
      description: t(r.description),
      tags: [t(r.group)],
      operationId: `${r.method.toLowerCase()}${r.path.replace(/\{(\w+)\}/g, '_$1').replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '')}`,
      parameters: (r.params ?? []).map((p) => ({ name: p.name, in: p.place === 'path' ? 'path' : 'query', required: Boolean(p.required), description: t(p.description ?? ''), schema: { type: p.type === 'integer' ? 'integer' : 'string' } })),
      responses: {
        200: { description: t('Success'), content: r.file ? { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } : { 'application/json': { schema: { type: 'object' }, example: typeof r.response === 'object' ? (r.response.ok === undefined ? { ok: true, ...r.response } : r.response) : undefined } } },
        400: { $ref: '#/components/responses/Err' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/Err' },
      },
    };
    if (r.unauthorized) op.security = [];
    if (r.body?.type === 'json') {
      const fields = r.path === '/jobs' ? [{ name: 'type', type: 'string', required: true, options: Object.keys(JOB_TYPES), description: t('Job type; the other fields depend on the type (components/schemas/Is_<type>).') }] : r.body.fields ?? [];
      const schema = { type: 'object', properties: Object.fromEntries(fields.map((a) => [a.name, schemaField(a, t)])), required: fields.filter((a) => a.required).map((a) => a.name) };
      if (r.path === '/jobs') schema.oneOf = Object.keys(JOB_TYPES).map((t) => ({ $ref: `#/components/schemas/Is_${t}` }));
      if (!schema.required.length) delete schema.required;
      op.requestBody = { required: true, content: { 'application/json': { schema: schema, example: r.body.example } } };
    } else if (r.body?.type === 'binary') {
      op.requestBody = { required: true, description: t(r.body.description ?? ''), content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
    }
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }
  const schemas = {};
  for (const [type, b] of Object.entries(JOB_TYPES)) {
    const fields = b.fields.filter((a) => !a.name.includes(','));
    schemas[`Is_${type}`] = {
      type: 'object',
      description: t(b.description),
      properties: { type: { type: 'string', enum: [type] }, ...Object.fromEntries(fields.map((a) => [a.name, schemaField(a, t)])) },
      required: ['type', ...fields.filter((a) => a.required).map((a) => a.name)],
      example: b.example,
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Nedese Studio API', version: '1.0.0', description: t('Local image / video / voice / film generation panel. Docs: /api/documents') },
    servers: [{ url: `${address.replace(/\/$/, '')}${API_PREFIX}` }],
    tags: GROUP_POSITION.map((g) => ({ name: t(g) })),
    security: [{ key: [] }],
    paths,
    components: {
      securitySchemes: { key: { type: 'http', scheme: 'bearer', description: t('The API key from the Settings page') } },
      schemas: { Err: { type: 'object', properties: { ok: { type: 'boolean', enum: [false] }, error: { type: 'string', description: t('Error message (in the requested language)') }, code: { type: 'string', enum: ['invalid', 'unauthorized', 'notFound', 'inUse', 'server'] } } }, ...schemas },
      responses: {
        Err: { description: t('Error'), content: { 'application/json': { schema: { $ref: '#/components/schemas/Err' } } } },
        Unauthorized: { description: t('API key missing or wrong'), content: { 'application/json': { schema: { $ref: '#/components/schemas/Err' } } } },
      },
    },
  };
}
