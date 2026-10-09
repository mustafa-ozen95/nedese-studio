/**
 * Service worker of the web app (user request 08.10.2026: Nedese Studio on the phone's home screen). It keeps only
 * the app shell (the page, its scripts, styles, fonts, dictionary and icons) so the panel opens at once and shows its
 * frame when the computer cannot be reached; everything else goes straight to the network and is never stored: the
 * API (/api/, also the event streams), outputs and uploads (/file/) and the text model (/llm/).
 * Network first: a page that is online always gets the files as they are on disk now.
 * Browsers run service workers only on a secure origin (https or this computer); on http over the local network the
 * page works the same without it.
 */
const CACHE = 'nedese-shell-v1';
const SHELL = ['/', '/index.html', '/app.js', '/settings.js', '/assistant-settings.js', '/chat.js', '/js/lang.js', '/js/design.js', '/js/modal.js', '/js/image-viewer.js', '/js/markdown.js', '/js/highlight.js', '/js/pwa.js', '/lang/dictionary.js', '/css/app.css', '/icon.svg', '/manifest.webmanifest'];
const NEVER = /^\/(api|file|llm)(\/|$)/;

self.addEventListener('install', (event) => {
    // a file that cannot be fetched does not stop the install (the shell fills as the page is used)
    event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(SHELL.map((path) => cache.add(path).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});

/** Whether a request may be answered from (and stored in) the shell cache. */
function shellRequest(request) {
    if (request.method !== 'GET') return false;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    if (NEVER.test(url.pathname) || url.searchParams.has('download')) return false;
    if (request.headers.get('accept')?.includes('text/event-stream')) return false;
    return request.mode === 'navigate' || /\.(html|js|css|woff2|svg|png|webmanifest)$/.test(url.pathname) || url.pathname === '/';
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (!shellRequest(request)) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        try {
            const response = await fetch(request);
            if (response.ok && response.type === 'basic') cache.put(request.mode === 'navigate' ? '/' : request, response.clone()).catch(() => {});
            return response;
        } catch (error) {
            const stored = await cache.match(request.mode === 'navigate' ? '/' : request, { ignoreSearch: request.mode === 'navigate' });
            if (stored) return stored;
            throw error;
        }
    })());
});
