// CSS mask-image -webkit-prefix polyfill for iOS < 15.4
// Safari < 15.4 requires -webkit-mask-image instead of the unprefixed mask-image.
// This polyfill:
//   - Patches <style> textContent directly so the browser parses -webkit-mask-* properties.
//   - Fetches and patches <link rel="stylesheet"> files (including CORS-enabled CDNs).
//   - Traverses and observes style elements inside Shadow DOMs.
//   - Monkeypatches CSSStyleSheet.prototype (insertRule, addRule, replace, replaceSync).
//   - Monkeypatches CSSStyleDeclaration.prototype (setProperty, getters/setters).
//   - Intercepts inline style writes via Element.prototype.setAttribute.
//
// Properties covered: mask, mask-image, mask-size, mask-repeat, mask-position,
//                     mask-origin, mask-clip, mask-composite, mask-mode
(function polyfillWebkitMaskImage() {
    const LOG = '[webkit-mask]';
    function dbg() {
        try { console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments))); } catch (_) {}
    }

    if (window.__webkitMaskPolyfillApplied) {
        dbg('already applied, skipping');
        return;
    }
    window.__webkitMaskPolyfillApplied = true;
    dbg('polyfill starting');

    // Feature detection: if unprefixed mask-image is supported natively, bail out.
    const _test = document.createElement('div');
    _test.style.setProperty('mask-image', 'none');
    const nativeVal = _test.style.getPropertyValue('mask-image');
    dbg('feature detection: mask-image native value =', JSON.stringify(nativeVal));
    if (nativeVal !== '') {
        dbg('native mask-image supported — polyfill not needed');
        return;
    }
    dbg('native mask-image NOT supported — polyfill active');

    // Also check -webkit-mask-image support for diagnostics
    _test.style.setProperty('-webkit-mask-image', 'none');
    dbg('-webkit-mask-image supported:', JSON.stringify(_test.style.getPropertyValue('-webkit-mask-image')));

    const MASK_PROPS = [
        'mask',
        'mask-image',
        'mask-size',
        'mask-repeat',
        'mask-position',
        'mask-origin',
        'mask-clip',
        'mask-composite',
        'mask-mode',
    ];

    // ---- Text-level CSS patching ----
    // Since the browser discards unrecognized properties at parse time, we must duplicate
    // any unprefixed mask property to its -webkit- prefixed equivalent in the raw CSS text.
    function addWebkitPrefixToText(css) {
        if (!css || !/\bmask/.test(css)) return css;
        return css.replace(
            /(?:^|;|\{)\s*(mask(?:-(?:image|size|repeat|position|origin|clip|composite|mode))?)\s*:\s*([^;}]*)/g,
            function (match, prop, val) {
                if (prop.startsWith('-webkit-')) return match;
                const prefixChar = match.trim().charAt(0);
                const prefix = (prefixChar === ';' || prefixChar === '{') ? prefixChar : '';
                return prefix + ' ' + prop + ': ' + val + '; -webkit-' + prop + ': ' + val;
            }
        );
    }

    // ---- CSSStyleSheet prototype patching ----
    // Intercept rules added dynamically via JavaScript APIs.
    (function patchCSSStyleSheet() {
        const origInsertRule = CSSStyleSheet.prototype.insertRule;
        CSSStyleSheet.prototype.insertRule = function (rule, index) {
            try {
                if (typeof rule === 'string' && /\bmask/.test(rule)) {
                    const patched = addWebkitPrefixToText(rule);
                    dbg('insertRule intercepted, patching:', rule, '->', patched);
                    return origInsertRule.call(this, patched, index);
                }
            } catch (e) {
                dbg('insertRule patch failed:', e.message);
            }
            return origInsertRule.call(this, rule, index);
        };

        const origAddRule = CSSStyleSheet.prototype.addRule;
        CSSStyleSheet.prototype.addRule = function (selector, style, index) {
            try {
                if (typeof style === 'string' && /\bmask/.test(style)) {
                    const patched = addWebkitPrefixToText(style);
                    dbg('addRule intercepted, patching:', style, '->', patched);
                    return origAddRule.call(this, selector, patched, index);
                }
            } catch (e) {
                dbg('addRule patch failed:', e.message);
            }
            return origAddRule.call(this, selector, style, index);
        };

        if (CSSStyleSheet.prototype.replace) {
            const origReplace = CSSStyleSheet.prototype.replace;
            CSSStyleSheet.prototype.replace = function (cssText) {
                try {
                    if (typeof cssText === 'string' && /\bmask/.test(cssText)) {
                        const patched = addWebkitPrefixToText(cssText);
                        dbg('replace intercepted, patching:', cssText.slice(0, 100), '->', patched.slice(0, 100));
                        return origReplace.call(this, patched);
                    }
                } catch (e) {
                    dbg('replace patch failed:', e.message);
                }
                return origReplace.call(this, cssText);
            };
        }

        if (CSSStyleSheet.prototype.replaceSync) {
            const origReplaceSync = CSSStyleSheet.prototype.replaceSync;
            CSSStyleSheet.prototype.replaceSync = function (cssText) {
                try {
                    if (typeof cssText === 'string' && /\bmask/.test(cssText)) {
                        const patched = addWebkitPrefixToText(cssText);
                        dbg('replaceSync intercepted, patching:', cssText.slice(0, 100), '->', patched.slice(0, 100));
                        return origReplaceSync.call(this, patched);
                    }
                } catch (e) {
                    dbg('replaceSync patch failed:', e.message);
                }
                return origReplaceSync.call(this, cssText);
            };
        }
    })();

    // ---- CSSStyleDeclaration prototype patching ----
    // Intercept inline styles set via CSSOM (e.g. element.style.maskImage = ... or setProperty)
    (function patchCSSStyleDeclaration() {
        const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (prop, val, priority) {
            if (prop.startsWith('mask')) {
                const wprop = '-webkit-' + prop;
                origSetProperty.call(this, wprop, val, priority);
            }
            return origSetProperty.call(this, prop, val, priority);
        };

        // Define getters/setters for all camelCase properties on style declarations
        for (const prop of MASK_PROPS) {
            const camel = prop.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
            Object.defineProperty(CSSStyleDeclaration.prototype, camel, {
                get: function () {
                    return this.getPropertyValue(prop);
                },
                set: function (val) {
                    this.setProperty(prop, val);
                },
                configurable: true,
                enumerable: true
            });
        }
    })();

    // ---- <style> and <link> element processing ----
    const processedStyleNodes = new WeakMap();
    const processedLinks = new WeakMap();

    function processStyleNode(node) {
        if (!node || node.tagName !== 'STYLE') return;
        const nodeLabel = node.id ? '#' + node.id : (node.className || '<style>');
        const txt = node.textContent;
        if (processedStyleNodes.get(node) === txt) return;
        processedStyleNodes.set(node, txt);

        if (txt && /\bmask/.test(txt)) {
            const patched = addWebkitPrefixToText(txt);
            if (patched !== txt) {
                dbg('  textContent patched for style node:', nodeLabel);
                processedStyleNodes.set(node, patched);
                node.textContent = patched;
            }
        }
    }

    function processLinkNode(link) {
        if (!link || link.tagName !== 'LINK' || link.rel !== 'stylesheet' || !link.href) return;
        if (processedLinks.get(link) === link.href) return;
        processedLinks.set(link, link.href);

        const href = link.href;
        dbg('processLinkNode: fetching stylesheet:', href);
        fetch(href)
            .then(res => {
                if (!res.ok) throw new Error('status ' + res.status);
                return res.text();
            })
            .then(css => {
                if (/\bmask/.test(css)) {
                    const patched = addWebkitPrefixToText(css);
                    if (patched !== css) {
                        dbg('  successfully patched and replaced link stylesheet:', href);
                        const styleNode = document.createElement('style');
                        styleNode.textContent = patched;
                        if (link.id) styleNode.id = 'patched-' + link.id;
                        link.parentNode.insertBefore(styleNode, link.nextSibling);
                        link.disabled = true;
                    } else {
                        dbg('  no mask properties needing patch in link:', href);
                    }
                } else {
                    dbg('  no mask pattern in link stylesheet:', href);
                }
            })
            .catch(err => {
                dbg('  failed to patch link stylesheet', href, ':', err.message);
            });
    }

    // ---- Inline style attribute intercept (setAttribute) ----
    (function setupAttributeInterception() {
        const origSetAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            origSetAttribute.call(this, name, value);
            if (name === 'style' && typeof value === 'string' && /\bmask/.test(value)) {
                dbg('setAttribute intercepted mask style on', this.tagName, ':', value.slice(0, 80));
                try {
                    // Update the style declaration (our patched setProperty handles it)
                    const parsed = addWebkitPrefixToText(value);
                    if (parsed !== value) {
                        origSetAttribute.call(this, 'style', parsed);
                    }
                } catch (_) {}
            }
        };
        dbg('setAttribute monkeypatch installed');
    })();

    // ---- Shadow DOM support ----
    const observedRoots = new WeakSet();

    function observeMutations(root) {
        if (observedRoots.has(root)) return;
        observedRoots.add(root);

        const obs = new MutationObserver(function (mutations) {
            for (const m of mutations) {
                if (m.type === 'childList') {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        if (node.tagName === 'STYLE') {
                            processStyleNode(node);
                        } else if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
                            processLinkNode(node);
                        } else {
                            const innerStyles = node.querySelectorAll && node.querySelectorAll('style');
                            if (innerStyles && innerStyles.length) innerStyles.forEach(processStyleNode);

                            const innerLinks = node.querySelectorAll && node.querySelectorAll('link[rel="stylesheet"]');
                            if (innerLinks && innerLinks.length) innerLinks.forEach(processLinkNode);
                        }
                    }
                }
            }
        });
        obs.observe(root, { childList: true, subtree: true });
    }

    function scanShadowRoots(root) {
        if (!root) return;
        if (root.shadowRoot) {
            observeMutations(root.shadowRoot);
            root.shadowRoot.querySelectorAll('style').forEach(processStyleNode);
            root.shadowRoot.querySelectorAll('link[rel="stylesheet"]').forEach(processLinkNode);
            scanShadowRoots(root.shadowRoot);
        }
        let child = root.firstElementChild;
        while (child) {
            scanShadowRoots(child);
            child = child.nextElementSibling;
        }
    }

    (function patchShadowDOM() {
        const origAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (init) {
            const shadow = origAttachShadow.call(this, init);
            try {
                dbg('attachShadow intercepted, setting up observer');
                observeMutations(shadow);
            } catch (e) {
                dbg('attachShadow setup failed:', e.message);
            }
            return shadow;
        };
    })();

    // ---- Main Scan ----
    function processAll() {
        dbg('processAll: scanning DOM style/link elements');
        document.querySelectorAll('style').forEach(processStyleNode);
        document.querySelectorAll('link[rel="stylesheet"]').forEach(processLinkNode);
        scanShadowRoots(document.documentElement);
    }

    // ---- Mutation listener ----
    function setupMutationListener() {
        if (window.__pfRegisterMutationListener) {
            dbg('registering with shared mutation hub');
            window.__pfRegisterMutationListener(function (mutations) {
                // Shared hub handles main DOM mutations
                for (const m of mutations) {
                    if (m.type === 'childList') {
                        for (const node of m.addedNodes) {
                            if (node.nodeType !== 1) continue;
                            if (node.tagName === 'STYLE') {
                                processStyleNode(node);
                            } else if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
                                processLinkNode(node);
                            } else {
                                const innerStyles = node.querySelectorAll && node.querySelectorAll('style');
                                if (innerStyles && innerStyles.length) innerStyles.forEach(processStyleNode);

                                const innerLinks = node.querySelectorAll && node.querySelectorAll('link[rel="stylesheet"]');
                                if (innerLinks && innerLinks.length) innerLinks.forEach(processLinkNode);
                            }
                        }
                    } else if (
                        m.type === 'attributes' &&
                        m.target.tagName === 'LINK' &&
                        m.target.rel === 'stylesheet' &&
                        (m.attributeName === 'href' || m.attributeName === 'rel')
                    ) {
                        processLinkNode(m.target);
                    }
                }
            });
        } else {
            dbg('WARNING: shared hub not found, creating own MutationObserver');
            observeMutations(document);
        }
    }

    processAll();
    setupMutationListener();
    dbg('init complete. hub available:', !!window.__pfRegisterMutationListener);
})();
