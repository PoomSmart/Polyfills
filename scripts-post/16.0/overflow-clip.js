// overflow: clip for iOS before 16.
// `hidden` then `clip` is the usual fallback. Engines that drop `clip` keep
// `hidden`, and one non-visible axis forces the other to auto. That turns a
// flex column into a scroller iOS will not scroll. `clip` was there so that
// would not happen, so the axis goes back to visible.
(function () {
    if (window.__pfOverflowClipFix) return;
    window.__pfOverflowClipFix = true;

    function findBrace(css, openIdx) {
        var depth = 1;
        var j = openIdx + 1;
        var ch, q;
        while (j < css.length && depth > 0) {
            ch = css.charAt(j);
            if (ch === '"' || ch === "'") {
                q = ch;
                j++;
                while (j < css.length && css.charAt(j) !== q) {
                    if (css.charAt(j) === '\\') j += 2;
                    else j++;
                }
                j++;
                continue;
            }
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            j++;
        }
        return j;
    }

    function applyAxis(state, axis, value, imp) {
        var v = value.replace(/^\s+|\s+$/g, '').toLowerCase();
        if (!v || v === 'clip') {
            if (v === 'clip' && state.cur[axis] && state.cur[axis] !== 'clip') {
                state.fix[axis] = true;
                state.imp[axis] = imp;
            }
            if (v === 'clip') state.cur[axis] = 'clip';
            return;
        }
        state.cur[axis] = v;
        state.fix[axis] = false;
    }

    function applyShorthand(state, value, imp) {
        var parts = value.replace(/^\s+|\s+$/g, '').split(/\s+/);
        if (!parts[0]) return;
        applyAxis(state, 'x', parts[0], imp);
        applyAxis(state, 'y', parts.length > 1 ? parts[1] : parts[0], imp);
    }

    function overrides(body) {
        var state = { cur: { x: '', y: '' }, fix: { x: false, y: false }, imp: { x: false, y: false } };
        var i = 0;
        var start = 0;
        var depth = 0;
        var ch, part, colon, prop, raw, imp, value, bits;
        function take(text) {
            part = text.replace(/^\s+|\s+$/g, '');
            colon = part.indexOf(':');
            if (colon === -1) return;
            prop = part.slice(0, colon).replace(/^\s+|\s+$/g, '').toLowerCase();
            raw = part.slice(colon + 1);
            imp = /!important\s*$/i.test(raw);
            value = raw.replace(/!important\s*$/i, '');
            if (prop === 'overflow-x') applyAxis(state, 'x', value, imp);
            else if (prop === 'overflow-y') applyAxis(state, 'y', value, imp);
            else if (prop === 'overflow') applyShorthand(state, value, imp);
        }
        while (i <= body.length) {
            ch = i === body.length ? ';' : body.charAt(i);
            if (ch === '(') depth++;
            else if (ch === ')' && depth) depth--;
            else if (ch === ';' && depth === 0) {
                take(body.slice(start, i));
                start = i + 1;
            }
            i++;
        }
        bits = [];
        if (state.fix.x) bits.push('overflow-x:visible' + (state.imp.x ? '!important' : ''));
        if (state.fix.y) bits.push('overflow-y:visible' + (state.imp.y ? '!important' : ''));
        return bits.join(';');
    }

    function wrap(rule, medias) {
        var css = rule;
        var i;
        for (i = medias.length - 1; i >= 0; i--) css = medias[i] + '{' + css + '}';
        return css;
    }

    function pushFix(prelude, layerName, medias, out, decl, imp) {
        var sel = prelude;
        if (window.__pfPrefixSelector) sel = window.__pfPrefixSelector(prelude, layerName, !!imp);
        out.push(wrap(sel + '{' + decl + '}', medias));
    }

    function collect(css, medias, layerName, out) {
        var i = 0;
        var open, prelude, close, body, fix, inner, child;
        if (!css || css.toLowerCase().indexOf('clip') === -1) return;
        while (i < css.length) {
            while (i < css.length && /\s/.test(css.charAt(i))) i++;
            if (css.charAt(i) === '/' && css.charAt(i + 1) === '*') {
                close = css.indexOf('*/', i + 2);
                i = close === -1 ? css.length : close + 2;
                continue;
            }
            if (i >= css.length) break;
            open = css.indexOf('{', i);
            if (open === -1) break;
            prelude = css.slice(i, open).replace(/^\s+|\s+$/g, '');
            close = findBrace(css, open);
            body = css.slice(open + 1, close - 1);
            if (prelude.charAt(0) === '@') {
                if (/^@media\b/i.test(prelude) || /^@container\b/i.test(prelude)) collect(body, medias.concat([prelude]), layerName, out);
                else if (/^@supports\b/i.test(prelude)) {
                    if (prelude.toLowerCase().indexOf('clip') === -1) collect(body, medias.concat([prelude]), layerName, out);
                } else if (/^@layer\b/i.test(prelude)) {
                    if (window.__pfPrefixSelector && window.__pfJoinLayer) {
                        child = window.__pfJoinLayer(layerName, prelude);
                        collect(body, medias, child, out);
                    } else {
                        inner = [];
                        collect(body, medias, null, inner);
                        if (inner.length) out.push(prelude + '{' + inner.join('\n') + '}');
                    }
                }
            } else if (prelude) {
                fix = overrides(body);
                if (fix) {
                    var xImp = /overflow-x:visible!important/.test(fix);
                    var yImp = /overflow-y:visible!important/.test(fix);
                    if (/overflow-x:/.test(fix)) pushFix(prelude, layerName, medias, out, 'overflow-x:visible' + (xImp ? '!important' : ''), xImp);
                    if (/overflow-y:/.test(fix)) pushFix(prelude, layerName, medias, out, 'overflow-y:visible' + (yImp ? '!important' : ''), yImp);
                }
            }
            i = close;
        }
    }

    function extract(css) {
        var out = [];
        collect(css, [], null, out);
        return out.join('\n');
    }

    function supplement(anchor, css) {
        var style = anchor.__pfOcStyle;
        if (!css) return;
        if (style && style.parentNode) {
            if (style.textContent !== css) style.textContent = css;
            return;
        }
        style = document.createElement('style');
        style.setAttribute('data-pf-overflow-clip', '');
        style.textContent = css;
        if (anchor.parentNode) anchor.parentNode.insertBefore(style, anchor.nextSibling);
        else (document.head || document.documentElement).appendChild(style);
        anchor.__pfOcStyle = style;
    }

    function patchStyle(node) {
        var raw, epoch;
        if (!node || node.tagName !== 'STYLE' || node.id === 'pf-css-layers') return;
        if (node.getAttribute('data-pf-overflow-clip') != null) return;
        raw = node.textContent || '';
        if (raw.toLowerCase().indexOf('clip') === -1) return;
        epoch = window.__pfLayerEpoch || 0;
        if (node.__pfOcSrc === raw && node.__pfOcEpoch === epoch) return;
        node.__pfOcSrc = raw;
        node.__pfOcEpoch = epoch;
        node.__pfOcText = raw;
        supplement(node, extract(raw));
    }

    function patchLink(link) {
        var href, rel, epoch;
        if (!link || link.tagName !== 'LINK' || !window.__pfLoadCssText) return;
        rel = (link.rel || '').toLowerCase();
        if (rel !== 'stylesheet' || !link.href) return;
        href = link.href;
        epoch = window.__pfLayerEpoch || 0;
        if (link.__pfOcHref === href && link.__pfOcText && link.__pfOcEpoch === epoch) return;
        if (link.__pfOcHref === href && link.__pfOcText) {
            link.__pfOcEpoch = epoch;
            supplement(link, extract(link.__pfOcText));
            return;
        }
        link.__pfOcHref = href;
        window.__pfLoadCssText(href, function (err, text) {
            if (link.__pfOcHref !== href || err || !text) return;
            link.__pfOcText = text;
            link.__pfOcEpoch = window.__pfLayerEpoch || 0;
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

    function relayerOverflow() {
        var links = document.getElementsByTagName('link');
        var styles = document.getElementsByTagName('style');
        var i;
        for (i = 0; i < links.length; i++) patchLink(links[i]);
        for (i = 0; i < styles.length; i++) patchStyle(styles[i]);
    }

    patchNode(document.documentElement || document);
    if (window.__pfOnCssLayersUpdate) window.__pfOnCssLayersUpdate(relayerOverflow);
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
