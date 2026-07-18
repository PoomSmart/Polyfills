// Shared MutationObserver + CSS fetch cache for post polyfills.
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

    window.__pfFetchCache = new Map();
})();
