// light-dark() for iOS before 17.5.
(function () {
    if (window.__pfLightDark) return;
    window.__pfLightDark = true;

    function darkNow() {
        try { return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches; }
        catch (e) { return false; }
    }

    function replaceOne(css, dark) {
        var out = '';
        var i = 0;
        var needle = 'light-dark(';
        while (i < css.length) {
            var idx = css.toLowerCase().indexOf(needle, i);
            var depth, j, inner, comma, a, b;
            if (idx === -1) { out += css.slice(i); break; }
            out += css.slice(i, idx);
            j = idx + needle.length;
            depth = 1;
            while (j < css.length && depth > 0) {
                if (css.charAt(j) === '(') depth++;
                else if (css.charAt(j) === ')') depth--;
                j++;
            }
            inner = css.slice(idx + needle.length, j - 1);
            comma = -1;
            depth = 0;
            for (var k = 0; k < inner.length; k++) {
                var ch = inner.charAt(k);
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
                else if (ch === ',' && depth === 0) { comma = k; break; }
            }
            if (comma === -1) out += css.slice(idx, j);
            else {
                a = inner.slice(0, comma).replace(/^\s+|\s+$/g, '');
                b = inner.slice(comma + 1).replace(/^\s+|\s+$/g, '');
                out += dark ? b : a;
            }
            i = j;
        }
        return out;
    }

    function transform(css) {
        if (!css || css.toLowerCase().indexOf('light-dark(') === -1) return css;
        return replaceOne(css, darkNow());
    }

    if (window.__pfRegisterShadowTransform) window.__pfRegisterShadowTransform(transform);

    function findBrace(css, openIdx) {
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

    // Only the blocks that use light-dark(). On iOS 15.4+ the replacement stays
    // inside @layer. Before that, the layer polyfill ranks the selector.
    function extract(css, layerName) {
        var i = 0;
        var out = [];
        var open, prelude, close, body, inner, fixed, isLayer, child;
        if (!css || css.toLowerCase().indexOf('light-dark(') === -1) return '';
        while (i < css.length) {
            while (i < css.length && /\s/.test(css.charAt(i))) i++;
            if (i >= css.length) break;
            open = css.indexOf('{', i);
            if (open === -1) break;
            prelude = css.slice(i, open).replace(/^\s+|\s+$/g, '');
            close = findBrace(css, open);
            body = css.slice(open + 1, close - 1);
            if (prelude.charAt(0) === '@') {
                isLayer = /^@layer\b/i.test(prelude);
                child = layerName;
                if (isLayer && window.__pfJoinLayer) child = window.__pfJoinLayer(layerName, prelude);
                inner = extract(body, child);
                if (inner) {
                    if (isLayer && window.__pfPrefixCss) out.push(inner);
                    else out.push(prelude + '{' + inner + '}');
                }
            } else if (prelude && body.toLowerCase().indexOf('light-dark(') !== -1) {
                fixed = transform(body);
                if (fixed !== body) {
                    if (window.__pfPrefixCss) out.push(window.__pfPrefixCss(prelude + '{' + fixed + '}', layerName || null));
                    else out.push(prelude + '{' + fixed + '}');
                }
            }
            i = close;
        }
        return out.join('\n');
    }

    function patchStyle(node) {
        var raw, next;
        if (!node || node.tagName !== 'STYLE' || node.id === 'pf-css-layers') return;
        if (node.getAttribute('data-pf-light-dark') != null) return;
        raw = node.__pfLdSrcText;
        if (raw == null) raw = node.getAttribute('data-pf-ld-src');
        if (raw == null) {
            raw = node.textContent || '';
            if (raw.toLowerCase().indexOf('light-dark(') === -1) return;
            node.__pfLdSrcText = raw;
            node.setAttribute('data-pf-ld-src', raw);
        }
        if (window.__pfPrefixCss) {
            supplement(node, extract(raw));
            return;
        }
        next = transform(raw);
        if (node.textContent !== next) node.textContent = next;
    }

    function supplement(link, css) {
        var style = link.__pfLdStyle;
        if (!css) return;
        if (style && style.parentNode) {
            if (style.textContent !== css) style.textContent = css;
            return;
        }
        style = document.createElement('style');
        style.setAttribute('data-pf-light-dark', '');
        style.textContent = css;
        if (link.parentNode) link.parentNode.insertBefore(style, link.nextSibling);
        else (document.head || document.documentElement).appendChild(style);
        link.__pfLdStyle = style;
    }

    function patchLink(link) {
        var href, rel;
        if (!link || link.tagName !== 'LINK' || !window.__pfLoadCssText) return;
        rel = (link.rel || '').toLowerCase();
        if (rel !== 'stylesheet' || !link.href) return;
        href = link.href;
        if (link.__pfLdHref === href) return;
        link.__pfLdHref = href;
        link.__pfLdSrc = '';
        window.__pfLoadCssText(href, function (err, text) {
            if (link.__pfLdHref !== href || err || !text) return;
            link.__pfLdSrc = text;
            supplement(link, extract(text));
        });
    }

    function patchNode(node) {
        var styles, links, i;
        if (!node || node.nodeType !== 1) return;
        if (node.tagName === 'STYLE') patchStyle(node);
        else if (node.tagName === 'LINK') patchLink(node);
        if (!node.querySelectorAll) return;
        styles = node.querySelectorAll('style');
        links = node.querySelectorAll('link[rel="stylesheet"]');
        for (i = 0; i < styles.length; i++) patchStyle(styles[i]);
        for (i = 0; i < links.length; i++) patchLink(links[i]);
    }

    function onScheme() {
        var styles = document.getElementsByTagName('style');
        var links = document.getElementsByTagName('link');
        var i;
        for (i = 0; i < styles.length; i++) patchStyle(styles[i]);
        for (i = 0; i < links.length; i++) {
            if (links[i].__pfLdSrc) supplement(links[i], extract(links[i].__pfLdSrc));
        }
    }

    patchNode(document.documentElement || document);
    if (window.__pfOnCssLayersUpdate) window.__pfOnCssLayersUpdate(onScheme);
    try {
        var mq = matchMedia('(prefers-color-scheme: dark)');
        if (mq.addEventListener) mq.addEventListener('change', onScheme);
        else if (mq.addListener) mq.addListener(onScheme);
    } catch (e) {}
    if (window.MutationObserver) {
        new MutationObserver(function (mutations) {
            var i, j, node;
            for (i = 0; i < mutations.length; i++) {
                if (!mutations[i].addedNodes) continue;
                for (j = 0; j < mutations[i].addedNodes.length; j++) {
                    node = mutations[i].addedNodes[j];
                    if (node && node.nodeType === 1) patchNode(node);
                }
            }
        }).observe(document.documentElement || document, { childList: true, subtree: true });
    }
})();
