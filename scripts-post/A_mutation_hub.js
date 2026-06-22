// Shared MutationObserver Hub for Polyfills
// Replaces individual MutationObserver instances in css-layers, oklch-fallback,
// and media-query-range polyfills with a single shared observer to reduce overhead.
//
// API:
//   window.__pfRegisterMutationListener(listener)
//     listener: function(mutations) — receives the raw MutationRecord array
//               from a single shared observer watching the whole document.
//
//   window.__pfFetchCache — Map<url, Promise<string>> shared fetch cache.
//   Polyfills should check this before fetching CSS to avoid duplicate requests.
(function setupPolyfillMutationHub() {
    if (window.__pfMutationHub) return;

    const listeners = [];

    const observer = new MutationObserver(function (mutations) {
        if (!listeners.length) return;
        for (let i = 0; i < listeners.length; i++) {
            try {
                listeners[i](mutations);
            } catch (e) {
                // ignore per-listener errors to keep the hub running
            }
        }
    });

    observer.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        // Union of all polyfill attribute interests.
        attributeFilter: ['href', 'rel', 'class'],
    });

    window.__pfMutationHub = {
        register: function (listener) {
            if (typeof listener === 'function') {
                listeners.push(listener);
            }
        },
        observer: observer,
    };

    window.__pfRegisterMutationListener = function (listener) {
        window.__pfMutationHub.register(listener);
    };

    // Shared CSS fetch cache: Map<url string, Promise<string>>
    // Usage: if (!window.__pfFetchCache.has(url)) {
    //            window.__pfFetchCache.set(url, fetch(url, { mode: 'cors' }).then(r => r.ok ? r.text() : Promise.reject()));
    //        }
    //        window.__pfFetchCache.get(url).then(cssText => { ... }).catch(() => { ... });
    window.__pfFetchCache = new Map();
})();
