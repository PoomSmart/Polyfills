// Run registered CSS transforms on shadow trees and constructed stylesheets.
(function () {
    if (window.__pfShadowCss) return;
    window.__pfShadowCss = true;

    var roots = [];

    function applyText(css, base) {
        var next = window.__pfApplyShadowTransforms ? window.__pfApplyShadowTransforms(css) : css;
        if (base && window.__pfAbsolutizeCssUrls && next) next = window.__pfAbsolutizeCssUrls(next, base);
        return next;
    }

    function patchStyle(styleEl, base) {
        var raw, next;
        if (!styleEl || styleEl.tagName !== 'STYLE') return;
        raw = styleEl.__pfShadowSrc != null ? styleEl.__pfShadowSrc : styleEl.textContent;
        if (!raw) return;
        if (styleEl.__pfShadowSrc == null) styleEl.__pfShadowSrc = raw;
        next = applyText(raw, base);
        if (next && next !== styleEl.textContent) styleEl.textContent = next;
    }

    function scanRoot(root) {
        var styles, i;
        if (!root || !root.querySelectorAll) return;
        styles = root.querySelectorAll('style');
        for (i = 0; i < styles.length; i++) patchStyle(styles[i], document.baseURI);
    }

    function watch(root) {
        if (!root || root.__pfShadowWatch) return;
        root.__pfShadowWatch = true;
        roots.push(root);
        scanRoot(root);
        if (window.__pfOnShadowRoot) {
            try { window.__pfOnShadowRoot(root); } catch (e) {}
        }
        if (window.MutationObserver) {
            new MutationObserver(function () { scanRoot(root); }).observe(root, { childList: true, subtree: true, characterData: true });
        }
    }

    window.__pfRefreshShadowCss = function () {
        var i;
        for (i = 0; i < roots.length; i++) scanRoot(roots[i]);
    };

    if (window.Element && Element.prototype.attachShadow) {
        var orig = Element.prototype.attachShadow;
        if (!orig.__pfShadow) {
            var wrapped = function (init) {
                var root = orig.call(this, init);
                watch(root);
                return root;
            };
            wrapped.__pfShadow = true;
            Element.prototype.attachShadow = wrapped;
        }
    }

    if (window.CSSStyleSheet && CSSStyleSheet.prototype) {
        ['replace', 'replaceSync'].forEach(function (name) {
            var origFn = CSSStyleSheet.prototype[name];
            if (typeof origFn !== 'function' || origFn.__pfShadow) return;
            var wrappedFn = function (css) {
                var next = typeof css === 'string' ? applyText(css, document.baseURI) : css;
                return origFn.call(this, next);
            };
            wrappedFn.__pfShadow = true;
            CSSStyleSheet.prototype[name] = wrappedFn;
        });
    }

    function scanHosts(node) {
        var list, i, root;
        if (!node || !node.querySelectorAll) return;
        if (node.shadowRoot) watch(node.shadowRoot);
        list = node.querySelectorAll('*');
        for (i = 0; i < list.length; i++) {
            root = list[i].shadowRoot;
            if (root) watch(root);
        }
    }

    function start() { scanHosts(document); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
    if (window.MutationObserver) {
        new MutationObserver(function (mutations) {
            var i, j, node;
            for (i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                if (!added) continue;
                for (j = 0; j < added.length; j++) {
                    node = added[j];
                    if (node && node.nodeType === 1) scanHosts(node);
                }
            }
        }).observe(document.documentElement || document, { childList: true, subtree: true });
    }
})();
