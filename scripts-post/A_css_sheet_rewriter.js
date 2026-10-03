// Shared stylesheet scan / supplement inject / mutation watch for CSS polyfills.
(function setupCssSheetRewriter() {
    if (window.__pfInstallCssSheetRewriter) return;

    var shadowTransforms = [];
    window.__pfRegisterShadowTransform = function (fn) {
        if (typeof fn !== 'function') return;
        shadowTransforms.push(fn);
        if (window.__pfRefreshShadowCss) window.__pfRefreshShadowCss();
    };
    window.__pfApplyShadowTransforms = function (css) {
        var i, next;
        if (!css) return css;
        for (i = 0; i < shadowTransforms.length; i++) {
            try {
                next = shadowTransforms[i](css);
                if (typeof next === 'string') css = next;
            } catch (e) {}
        }
        return css;
    };

    function forEachNode(list, fn) {
        if (!list) return;
        var i;
        for (i = 0; i < list.length; i++) fn(list[i]);
    }

    function findMatchingBrace(css, openIdx) {
        var depth = 1;
        var j = openIdx + 1;
        while (j < css.length && depth > 0) {
            var ch = css.charAt(j);
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            j++;
        }
        return j;
    }

    function walkRules(css, start, end, handleBlock, out) {
        var i = start;
        while (i < end) {
            while (i < end && /\s/.test(css.charAt(i))) i++;
            if (i >= end || css.charAt(i) === '}') break;
            if (css.charAt(i) === '@') {
                var atOpen = css.indexOf('{', i);
                if (atOpen === -1 || atOpen >= end) break;
                var atClose = findMatchingBrace(css, atOpen);
                var prelude = css.slice(i, atOpen).trim();
                var nested = [];
                walkRules(css, atOpen + 1, atClose - 1, handleBlock, nested);
                if (nested.length) out.push(prelude + '{' + nested.join('') + '}');
                i = atClose;
                continue;
            }
            var open = css.indexOf('{', i);
            if (open === -1 || open >= end) break;
            var close = findMatchingBrace(css, open);
            var selector = css.slice(i, open).trim();
            var block = css.slice(open + 1, close - 1);
            if (selector.charAt(0) !== '@') {
                var decls = handleBlock(selector, block);
                if (decls) out.push(selector + '{' + decls + '}');
            }
            i = close;
        }
    }

    window.__pfExtractCssRuleSubset = function (css, handleBlock) {
        if (!css || typeof handleBlock !== 'function') return '';
        var out = [];
        walkRules(css, 0, css.length, handleBlock, out);
        return out.join('\n');
    };

    var xhrCache = {};

    function loadCssText(href, done) {
        var entry = xhrCache[href];
        if (entry) {
            if (entry.done) return done(entry.err, entry.text);
            entry.wait.push(done);
            return;
        }
        entry = { wait: [done], done: false };
        xhrCache[href] = entry;
        function xhrLoad() {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', href);
            xhr.onload = function () {
                var ok = xhr.status >= 200 && xhr.status < 300 || xhr.status === 0;
                finish(ok ? null : new Error('status ' + xhr.status), ok ? xhr.responseText : null);
            };
            xhr.onerror = function () { finish(new Error('network'), null); };
            xhr.send();
        }
        if (window.__pfBridgeGet) {
            window.__pfBridgeGet('css', href).then(function (reply) {
                var text = reply && (reply.data != null ? reply.data : reply.raw);
                if (text == null) xhrLoad();
                else finish(null, text);
            }, xhrLoad);
        } else {
            xhrLoad();
        }
        function finish(err, text) {
            entry.done = true;
            entry.err = err;
            entry.text = text;
            var wait = entry.wait;
            entry.wait = [];
            var i;
            for (i = 0; i < wait.length; i++) wait[i](err, text);
        }
    }

    window.__pfLoadCssText = loadCssText;

    function absCssUrl(rel, base) {
        if (!rel || /^(data:|blob:|#|[a-z][a-z0-9+.-]*:)/i.test(rel)) return rel;
        if (rel.indexOf('//') === 0) {
            var proto = String(base).split(':')[0] || 'https';
            return proto + ':' + rel;
        }
        var originMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(base || '');
        var origin = originMatch ? originMatch[0] : '';
        if (rel.charAt(0) === '/') return origin ? origin + rel : rel;
        var dir = String(base || '').replace(/[#?].*$/, '').replace(/[^/]*$/, '');
        var stack = dir.split('/');
        var parts = rel.split('/');
        var i;
        if (stack.length) stack.pop();
        for (i = 0; i < parts.length; i++) {
            if (parts[i] === '' || parts[i] === '.') continue;
            if (parts[i] === '..') stack.pop();
            else stack.push(parts[i]);
        }
        return stack.join('/');
    }

    window.__pfAbsolutizeCssUrls = function (css, base) {
        if (!css || !base) return css;
        var urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
        var importRe = /@import\s+(['"])([^'"]+)\1/g;
        return css
            .replace(urlRe, function (m, q, u) { return 'url(' + q + absCssUrl(u, base) + q + ')'; })
            .replace(importRe, function (m, q, u) { return '@import ' + q + absCssUrl(u, base) + q; });
    };

    function isPolyfillStyle(node) {
        if (!node || !node.attributes) return false;
        var attrs = node.attributes;
        var i, name;
        for (i = 0; i < attrs.length; i++) {
            name = attrs[i].name;
            if (name.indexOf('data-pf-') === 0) return true;
            if (name.indexOf('data-') === 0 && name.indexOf('polyfill') !== -1) return true;
        }
        return false;
    }

    window.__pfInstallCssSheetRewriter = function (opts) {
        opts = opts || {};
        var marker = opts.marker;
        var extract = opts.extract;
        var patchInline = opts.patchInline;
        var userSkip = opts.skipSheet;
        var skipSheet = function (css) {
            if (css && /@layer/i.test(css)) return true;
            if (userSkip) return userSkip(css);
            return false;
        };
        if (!marker || typeof extract !== 'function') return;

        var hasWM = typeof WeakMap === 'function';
        var processedStyles = hasWM ? new WeakMap() : null;
        var processedLinks = hasWM ? new WeakMap() : null;
        var supplements = hasWM ? new WeakMap() : null;

        function injectSupplement(anchor, css) {
            if (!anchor || !anchor.parentNode || !css) return;
            var existing = supplements && supplements.get(anchor);
            if (existing && existing.parentNode) {
                if (existing.textContent === css) return;
                existing.textContent = css;
                return;
            }
            var style = document.createElement('style');
            style.setAttribute(marker, '');
            style.textContent = css;
            anchor.parentNode.insertBefore(style, anchor.nextSibling);
            if (supplements) supplements.set(anchor, style);
        }

        function processStyleNode(node) {
            if (!node || node.tagName !== 'STYLE' || isPolyfillStyle(node)) return;
            var txt = node.textContent;
            if (processedStyles && processedStyles.get(node) === txt) return;
            if (processedStyles) processedStyles.set(node, txt);
            if (skipSheet(txt)) return;
            var extra = extract(txt);
            if (extra) injectSupplement(node, extra);
        }

        function processLinkNode(link) {
            if (!link || link.tagName !== 'LINK' || link.rel !== 'stylesheet' || !link.href) return;
            if (processedLinks && processedLinks.get(link) === link.href) return;
            if (processedLinks) processedLinks.set(link, link.href);
            loadCssText(link.href, function (err, css) {
                if (err || !css || skipSheet(css)) return;
                var extra = extract(css);
                if (extra) injectSupplement(link, extra);
            });
        }

        function processTree(root) {
            if (!root) return;
            if (root.tagName === 'STYLE') processStyleNode(root);
            if (root.tagName === 'LINK') processLinkNode(root);
            if (!root.querySelectorAll) return;
            forEachNode(root.querySelectorAll('style'), processStyleNode);
            forEachNode(root.querySelectorAll('link[rel="stylesheet"]'), processLinkNode);
        }

        function patchInlineStyle(el) {
            if (!patchInline || !el || el.nodeType !== 1) return;
            var raw = el.getAttribute('style');
            if (!raw) return;
            var patched = patchInline(raw);
            if (patched && patched !== raw) el.setAttribute('style', patched);
        }

        function scanInlineStyles(root) {
            if (!patchInline || !root) return;
            if (root.nodeType === 1) patchInlineStyle(root);
            if (!root.querySelectorAll) return;
            forEachNode(root.querySelectorAll('[style]'), patchInlineStyle);
        }

        function handleMutations(mutations) {
            var m, n, node, mutation;
            for (m = 0; m < mutations.length; m++) {
                mutation = mutations[m];
                if (mutation.type === 'childList') {
                    for (n = 0; n < mutation.addedNodes.length; n++) {
                        node = mutation.addedNodes[n];
                        if (node.nodeType !== 1) continue;
                        processTree(node);
                        scanInlineStyles(node);
                    }
                } else if (mutation.type === 'attributes') {
                    if (mutation.target.tagName === 'LINK' && mutation.target.rel === 'stylesheet') {
                        processLinkNode(mutation.target);
                    }
                }
            }
        }

        if (patchInline && window.__pfHookPrototype) {
            window.__pfHookPrototype(Element.prototype, 'setAttribute', function (orig, name, value) {
                orig.call(this, name, value);
                if (name === 'style' && typeof value === 'string') {
                    var patched = patchInline(value);
                    if (patched && patched !== value) orig.call(this, 'style', patched);
                }
            });
        }

        processTree(document);
        scanInlineStyles(document);
        if (window.__pfRegisterMutationListener) {
            window.__pfRegisterMutationListener(handleMutations);
        } else if (window.MutationObserver) {
            new MutationObserver(handleMutations).observe(document, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['href', 'rel']
            });
        }
    };
})();
