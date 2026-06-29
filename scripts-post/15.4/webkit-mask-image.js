// CSS mask-image -webkit-prefix polyfill for iOS < 15.4
// Safari < 15.4 requires -webkit-mask-image instead of the unprefixed mask-image.
// Never rewrites whole <style> sheets in place (breaks monolithic bundles).
// Instead injects a supplemental <style> with -webkit-mask-* copies of matching rules only.
(function polyfillWebkitMaskImage() {
    var __PF_DEBUG__ = false;
    const LOG = '[webkit-mask]';
    function dbg() {
        if (!__PF_DEBUG__) return;
        try { console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments))); } catch (_) {}
    }

    if (window.__webkitMaskPolyfillApplied) {
        dbg('already applied, skipping');
        return;
    }
    window.__webkitMaskPolyfillApplied = true;
    dbg('polyfill starting');

    const MASK_PROP =
        'mask(?:-(?:image|size|repeat|position|origin|clip|composite|mode))?';

    const MASK_PROP_CAPTURE =
        '(mask(?:-(?:image|size|repeat|position|origin|clip|composite|mode))?)';

    const maskQuickTest = new RegExp(
        '(?:^|[;{])\\s*(?:-webkit-)?' + MASK_PROP + '\\s*:',
        'm'
    );

    const maskDeclPattern = new RegExp(
        '(?:^|;)(\\s*)(?!-webkit-)' + MASK_PROP_CAPTURE + '\\s*:\\s*([^;}]*)',
        'gm'
    );

    const maskFirstDeclPattern = new RegExp(
        '^\\s*(?!-webkit-)' + MASK_PROP_CAPTURE + '\\s*:\\s*([^;}]*)'
    );

    function containsLayer(css) {
        return !!(css && /@layer/i.test(css));
    }

    function containsMaskDecl(css) {
        return !!(css && maskQuickTest.test(css));
    }

    function shouldPatchCssText(css) {
        return !!(css && !containsLayer(css) && containsMaskDecl(css));
    }

    const createPatcher = window.__pfCreateWebkitPropertyPatcher;
    const maskPatcher = createPatcher
        ? createPatcher({
              properties: [
                  'mask',
                  'mask-image',
                  'mask-size',
                  'mask-repeat',
                  'mask-position',
                  'mask-origin',
                  'mask-clip',
                  'mask-composite',
                  'mask-mode',
              ],
              detectProperty: 'mask-image',
              detectValue: 'none',
              quickTest: maskQuickTest,
              webkitOnly: true,
          })
        : null;

    const _test = document.createElement('div');
    _test.style.setProperty('mask-image', 'none');
    const nativeVal = _test.style.getPropertyValue('mask-image');
    dbg('feature detection: mask-image native value =', JSON.stringify(nativeVal));
    if (maskPatcher ? !maskPatcher.needsPolyfill() : nativeVal !== '') {
        dbg('native mask-image supported — polyfill not needed');
        return;
    }
    dbg('native mask-image NOT supported — polyfill active');

    function findMatchingBrace(css, openIdx) {
        var depth = 1;
        var j = openIdx + 1;
        while (j < css.length && depth > 0) {
            if (css[j] === '{') depth++;
            else if (css[j] === '}') depth--;
            j++;
        }
        return j;
    }

    function patchBlockMaskDeclarations(block) {
        if (!block || !containsMaskDecl(block)) {
            return block;
        }

        var patched = block.replace(maskDeclPattern, function (_match, space, prop, val) {
            return ';' + space + '-webkit-' + prop + ': ' + val;
        });

        patched = patched.replace(maskFirstDeclPattern, function (_match, prop, val) {
            return '-webkit-' + prop + ': ' + val;
        });

        return patched;
    }

    function extractMaskDeclarationsOnly(block) {
        var decls = [];

        block.replace(maskDeclPattern, function (_match, _space, prop, val) {
            decls.push('-webkit-' + prop + ': ' + val);
            return _match;
        });

        block.replace(maskFirstDeclPattern, function (_match, prop, val) {
            decls.push('-webkit-' + prop + ': ' + val);
            return _match;
        });

        return decls.join(';');
    }

    function patchCssRuleText(rule) {
        if (!rule || !containsMaskDecl(rule)) {
            return rule;
        }

        var open = rule.indexOf('{');
        if (open === -1) {
            return patchBlockMaskDeclarations(rule);
        }

        var close = rule.lastIndexOf('}');
        if (close <= open) {
            return rule;
        }

        return (
            rule.slice(0, open + 1) +
            patchBlockMaskDeclarations(rule.slice(open + 1, close)) +
            rule.slice(close)
        );
    }

    function walkCssBlocks(css, start, end, emitAll, outParts) {
        var i = start;
        end = end == null ? css.length : end;

        while (i < end) {
            while (i < end && /\s/.test(css[i])) {
                if (emitAll) outParts.push(css[i]);
                i++;
            }
            if (i >= end) break;
            if (css[i] === '}') break;

            if (css[i] === '@') {
                var atStart = i;
                var open = css.indexOf('{', i);
                if (open === -1 || open >= end) {
                    if (emitAll) outParts.push(css.slice(i, end));
                    break;
                }
                var atRule = css.slice(atStart, open).trim();
                var close = findMatchingBrace(css, open);
                if (emitAll) {
                    outParts.push(css.slice(atStart, open + 1));
                    walkCssBlocks(css, open + 1, close - 1, true, outParts);
                    outParts.push('}');
                } else {
                    var nested = [];
                    walkCssBlocks(css, open + 1, close - 1, false, nested);
                    if (nested.length) {
                        outParts.push(atRule + '{' + nested.join('\n') + '}');
                    }
                }
                i = close;
                continue;
            }

            var ruleOpen = css.indexOf('{', i);
            if (ruleOpen === -1 || ruleOpen >= end) {
                if (emitAll) outParts.push(css.slice(i, end));
                break;
            }

            var selector = css.slice(i, ruleOpen);
            var ruleClose = findMatchingBrace(css, ruleOpen);
            var block = css.slice(ruleOpen + 1, ruleClose - 1);

            if (containsMaskDecl(block)) {
                if (emitAll) {
                    outParts.push(
                        selector + '{' + patchBlockMaskDeclarations(block) + '}'
                    );
                } else {
                    var maskOnly = extractMaskDeclarationsOnly(block);
                    if (maskOnly) {
                        outParts.push(selector + '{' + maskOnly + '}');
                    }
                }
            } else if (emitAll) {
                outParts.push(css.slice(i, ruleClose));
            }

            i = ruleClose;
        }
    }

    function extractSupplementalMaskStylesheet(css) {
        if (!shouldPatchCssText(css)) {
            return '';
        }

        var parts = [];
        walkCssBlocks(css, 0, css.length, false, parts);
        return parts.join('\n');
    }

    function rebuildCssWithPatchedMaskBlocks(css) {
        if (!css || !containsMaskDecl(css)) {
            return css;
        }

        var parts = [];
        walkCssBlocks(css, 0, css.length, true, parts);
        return parts.join('');
    }

    function addWebkitPrefixToText(css) {
        if (!css || !containsMaskDecl(css)) {
            return css;
        }
        if (containsLayer(css)) {
            return css;
        }
        return rebuildCssWithPatchedMaskBlocks(css);
    }

    (function patchCSSStyleSheet() {
        var origInsertRule = CSSStyleSheet.prototype.insertRule;
        CSSStyleSheet.prototype.insertRule = function (rule, index) {
            try {
                if (typeof rule === 'string' && containsMaskDecl(rule)) {
                    var patched = patchCssRuleText(rule);
                    dbg('insertRule intercepted, patching:', rule, '->', patched);
                    return origInsertRule.call(this, patched, index);
                }
            } catch (e) {
                dbg('insertRule patch failed:', e.message);
            }
            return origInsertRule.call(this, rule, index);
        };

        var origAddRule = CSSStyleSheet.prototype.addRule;
        CSSStyleSheet.prototype.addRule = function (selector, style, index) {
            try {
                if (typeof style === 'string' && containsMaskDecl(style)) {
                    var patched = patchBlockMaskDeclarations(style);
                    dbg('addRule intercepted, patching:', style, '->', patched);
                    return origAddRule.call(this, selector, patched, index);
                }
            } catch (e) {
                dbg('addRule patch failed:', e.message);
            }
            return origAddRule.call(this, selector, style, index);
        };

        if (CSSStyleSheet.prototype.replace) {
            var origReplace = CSSStyleSheet.prototype.replace;
            CSSStyleSheet.prototype.replace = function (cssText) {
                try {
                    if (typeof cssText === 'string' && shouldPatchCssText(cssText)) {
                        var patched = addWebkitPrefixToText(cssText);
                        dbg('replace intercepted, patching');
                        return origReplace.call(this, patched);
                    }
                } catch (e) {
                    dbg('replace patch failed:', e.message);
                }
                return origReplace.call(this, cssText);
            };
        }

        if (CSSStyleSheet.prototype.replaceSync) {
            var origReplaceSync = CSSStyleSheet.prototype.replaceSync;
            CSSStyleSheet.prototype.replaceSync = function (cssText) {
                try {
                    if (typeof cssText === 'string' && shouldPatchCssText(cssText)) {
                        var patched = addWebkitPrefixToText(cssText);
                        dbg('replaceSync intercepted, patching');
                        return origReplaceSync.call(this, patched);
                    }
                } catch (e) {
                    dbg('replaceSync patch failed:', e.message);
                }
                return origReplaceSync.call(this, cssText);
            };
        }
    })();

    (function patchCSSStyleDeclaration() {
        if (window.__pfHookPrototype) {
            window.__pfHookPrototype(
                CSSStyleDeclaration.prototype,
                'setProperty',
                function (orig, prop, val, priority) {
                    if (
                        prop.indexOf('mask') === 0 &&
                        prop.indexOf('-webkit-') !== 0
                    ) {
                        orig.call(this, '-webkit-' + prop, val, priority);
                    }
                    return orig.call(this, prop, val, priority);
                }
            );
        } else {
            var origSetProperty = CSSStyleDeclaration.prototype.setProperty;
            CSSStyleDeclaration.prototype.setProperty = function (prop, val, priority) {
                if (
                    prop.indexOf('mask') === 0 &&
                    prop.indexOf('-webkit-') !== 0
                ) {
                    origSetProperty.call(this, '-webkit-' + prop, val, priority);
                }
                return origSetProperty.call(this, prop, val, priority);
            };
        }
    })();

    var processedStyleNodes = new WeakMap();
    var processedLinks = new WeakMap();
    var supplementNodes = new WeakMap();

    function isPolyfillInjectedStyle(node) {
        return !!(
            node &&
            (node.getAttribute('data-css-layers-polyfill') != null ||
                node.getAttribute('data-color-mix-polyfill') != null ||
                node.getAttribute('data-webkit-mask-polyfill') != null ||
                (node.id && node.id.indexOf('css-layers-src-') === 0) ||
                (node.id && node.id.indexOf('oklch-') === 0) ||
                (node.id && node.id.indexOf('patched-') === 0) ||
                (node.id && node.id.indexOf('mask-supplement-') === 0) ||
                (node.id && node.id.indexOf('color-mix-') === 0))
        );
    }

    function injectSupplementalMaskStyle(anchor, css) {
        if (!anchor || !anchor.parentNode || !css) {
            return;
        }

        var existing = supplementNodes.get(anchor);
        if (existing && existing.parentNode) {
            if (existing.textContent === css) {
                return;
            }
            existing.textContent = css;
            dbg('  updated supplemental mask stylesheet for', anchor.id || anchor.tagName);
            return;
        }

        var styleNode = document.createElement('style');
        styleNode.setAttribute('data-webkit-mask-polyfill', '');
        styleNode.textContent = css;
        if (anchor.id) {
            styleNode.id = 'mask-supplement-' + anchor.id;
        }
        anchor.parentNode.insertBefore(styleNode, anchor.nextSibling);
        supplementNodes.set(anchor, styleNode);
        dbg('  injected supplemental mask stylesheet for', anchor.id || anchor.tagName);
    }

    function processStyleNode(node) {
        if (!node || node.tagName !== 'STYLE' || isPolyfillInjectedStyle(node)) return;

        var txt = node.textContent;
        if (processedStyleNodes.get(node) === txt) return;
        processedStyleNodes.set(node, txt);

        if (containsLayer(txt)) {
            dbg('  skipping @layer style node (css-layers polyfill owns this sheet)');
            return;
        }

        var supplemental = extractSupplementalMaskStylesheet(txt);
        if (supplemental) {
            injectSupplementalMaskStyle(node, supplemental);
        }
    }

    function fetchStylesheetText(href) {
        var cache = window.__pfFetchCache;
        if (cache) {
            if (!cache.has(href)) {
                cache.set(
                    href,
                    fetch(href)
                        .then(function (res) {
                            if (!res.ok) throw new Error('status ' + res.status);
                            return res.text();
                        })
                        .catch(function (err) {
                            cache.delete(href);
                            throw err;
                        })
                );
            }
            return cache.get(href);
        }
        return fetch(href)
            .then(function (res) {
                if (!res.ok) throw new Error('status ' + res.status);
                return res.text();
            });
    }

    function processLinkNode(link) {
        if (!link || link.tagName !== 'LINK' || link.rel !== 'stylesheet' || !link.href) {
            return;
        }
        if (processedLinks.get(link) === link.href) return;
        processedLinks.set(link, link.href);

        var href = link.href;
        dbg('processLinkNode: fetching stylesheet:', href);
        fetchStylesheetText(href)
            .then(function (css) {
                if (containsLayer(css)) {
                    dbg('  skipping link with @layer (css-layers polyfill owns this sheet):', href);
                    return;
                }
                var supplemental = extractSupplementalMaskStylesheet(css);
                if (!supplemental) {
                    dbg('  no mask declarations needing patch in link:', href);
                    return;
                }
                injectSupplementalMaskStyle(link, supplemental);
            })
            .catch(function (err) {
                dbg('  failed to patch link stylesheet', href, ':', err.message);
            });
    }

    (function setupAttributeInterception() {
        if (!window.__pfHookPrototype) return;
        window.__pfHookPrototype(
            Element.prototype,
            'setAttribute',
            function (orig, name, value) {
                orig.call(this, name, value);
                if (name === 'style' && typeof value === 'string' && containsMaskDecl(value)) {
                    try {
                        var parsed = patchBlockMaskDeclarations(value);
                        if (parsed !== value) {
                            return orig.call(this, 'style', parsed);
                        }
                    } catch (_) {}
                }
            }
        );
        dbg('setAttribute monkeypatch installed');
    })();

    var observedRoots = new WeakSet();

    function observeMutations(root) {
        if (observedRoots.has(root)) return;
        observedRoots.add(root);

        var obs = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                if (mutations[m].type !== 'childList') continue;
                for (var n = 0; n < mutations[m].addedNodes.length; n++) {
                    var node = mutations[m].addedNodes[n];
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === 'STYLE') {
                        processStyleNode(node);
                    } else if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
                        processLinkNode(node);
                    } else {
                        if (node.querySelectorAll) {
                            node.querySelectorAll('style').forEach(processStyleNode);
                            node.querySelectorAll('link[rel="stylesheet"]').forEach(processLinkNode);
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
        var child = root.firstElementChild;
        while (child) {
            scanShadowRoots(child);
            child = child.nextElementSibling;
        }
    }

    (function patchShadowDOM() {
        var origAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (init) {
            var shadow = origAttachShadow.call(this, init);
            try {
                observeMutations(shadow);
            } catch (e) {
                dbg('attachShadow setup failed:', e.message);
            }
            return shadow;
        };
    })();

    function processAll() {
        dbg('processAll: scanning DOM style/link elements');
        document.querySelectorAll('style').forEach(processStyleNode);
        document.querySelectorAll('link[rel="stylesheet"]').forEach(processLinkNode);
        scanShadowRoots(document.documentElement);
    }

    function setupMutationListener() {
        if (!window.__pfRegisterMutationListener) {
            observeMutations(document);
            return;
        }

        dbg('registering with shared mutation hub');
        window.__pfRegisterMutationListener(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var mutation = mutations[m];
                if (mutation.type === 'childList') {
                    for (var n = 0; n < mutation.addedNodes.length; n++) {
                        var node = mutation.addedNodes[n];
                        if (node.nodeType !== 1) continue;
                        if (node.tagName === 'STYLE') {
                            processStyleNode(node);
                        } else if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
                            processLinkNode(node);
                        } else if (node.querySelectorAll) {
                            node.querySelectorAll('style').forEach(processStyleNode);
                            node.querySelectorAll('link[rel="stylesheet"]').forEach(processLinkNode);
                        }
                    }
                } else if (
                    mutation.type === 'attributes' &&
                    mutation.target.tagName === 'LINK' &&
                    mutation.target.rel === 'stylesheet' &&
                    (mutation.attributeName === 'href' || mutation.attributeName === 'rel')
                ) {
                    processLinkNode(mutation.target);
                }
            }
        });
    }

    processAll();
    setupMutationListener();
    window.__pfPatchMaskInCSS = addWebkitPrefixToText;
    dbg('init complete. hub available:', !!window.__pfRegisterMutationListener);
})();
