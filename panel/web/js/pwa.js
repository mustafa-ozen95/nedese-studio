/**
 * The page as an app (user request 08.10.2026: Nedese Studio on the phone's home screen): the service worker (sw.js)
 * keeps the app shell where the browser allows one (https or this computer; not plain http over the network, where
 * "Add to Home Screen" still opens the panel full screen from the manifest and the apple-mobile-web-app tags), and
 * the browser's bar follows the panel's theme.
 *
 * CLASSIC SCRIPT, independent of the others.
 */
(function () {
    'use strict';

    if ('serviceWorker' in navigator && window.isSecureContext) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
                /* no app shell: the page works the same */
            });
        });
    }

    // The bar's color: the top bar of the dark or the light theme
    const COLORS = { dark: '#212426', light: '#ffffff' };
    const meta = document.querySelector('meta[name="theme-color"]');
    const root = document.documentElement;
    const follow = () => {
        if (meta) meta.content = COLORS[root.dataset.theme] ?? COLORS.dark;
    };
    follow();
    new MutationObserver(follow).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
})();
