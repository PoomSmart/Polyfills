// Flatten CSS nesting for iOS before 17.2.
(function () {
    if (window.__pfCssNesting) return;
    window.__pfCssNesting = true;

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

    function splitCommas(sel) {
        var out = [];
        var cur = '';
        var depth = 0;
        var i, ch;
        for (i = 0; i < sel.length; i++) {
            ch = sel.charAt(i);
            if (ch === '(' || ch === '[') depth++;
            else if (ch === ')' || ch === ']') depth--;
            if (ch === ',' && depth === 0) {
                if (cur.replace(/^\s+|\s+$/g, '')) out.push(cur.replace(/^\s+|\s+$/g, ''));
                cur = '';
            } else cur += ch;
        }
        if (cur.replace(/^\s+|\s+$/g, '')) out.push(cur.replace(/^\s+|\s+$/g, ''));
        return out;
    }

    function combine(parent, child) {
        var parents = splitCommas(parent);
        var children = splitCommas(child);
        var out = [];
        var i, j, p, c;
        for (i = 0; i < parents.length; i++) {
            for (j = 0; j < children.length; j++) {
                p = parents[i];
                c = children[j];
                if (c.indexOf('&') !== -1) out.push(c.split('&').join(p));
                else out.push(p + ' ' + c);
            }
        }
        return out.join(',');
    }

    function splitBody(body) {
        var decls = '';
        var nested = [];
        var i = 0;
        while (i < body.length) {
            while (i < body.length && /\s/.test(body.charAt(i))) i++;
            if (i >= body.length) break;
            var open = body.indexOf('{', i);
            var semi = body.indexOf(';', i);
            if (open === -1 || (semi !== -1 && semi < open)) {
                var end = semi === -1 ? body.length : semi + 1;
                decls += body.slice(i, end);
                i = end;
                continue;
            }
            var close = findBrace(body, open);
            nested.push({
                prelude: body.slice(i, open).replace(/^\s+|\s+$/g, ''),
                body: body.slice(open + 1, close - 1)
            });
            i = close;
        }
        return { decls: decls, nested: nested };
    }

    function flattenStyle(selector, body) {
        var parts = splitBody(body);
        var out = [];
        var i, n, sels, more;
        if (!parts.nested.length) return '';
        if (parts.decls.replace(/\s/g, '')) out.push(selector + '{' + parts.decls + '}');
        for (i = 0; i < parts.nested.length; i++) {
            n = parts.nested[i];
            if (!n.prelude) continue;
            if (n.prelude.charAt(0) === '@') {
                more = flattenStyle(selector, n.body);
                out.push(n.prelude + '{' + (more || (selector + '{' + n.body + '}')) + '}');
            } else {
                sels = combine(selector, n.prelude);
                more = flattenStyle(sels, n.body);
                out.push(more || (sels + '{' + n.body + '}'));
            }
        }
        return out.join('\n');
    }

    function processCss(css, layer) {
        var i = 0;
        var out = [];
        if (!css || css.indexOf('{') === -1) return '';
        while (i < css.length) {
            while (i < css.length && /\s/.test(css.charAt(i))) i++;
            if (i >= css.length) break;
            var open = css.indexOf('{', i);
            if (open === -1) break;
            var prelude = css.slice(i, open).replace(/^\s+|\s+$/g, '');
            var close = findBrace(css, open);
            var body = css.slice(open + 1, close - 1);
            var flat, isLayer, child;
            if (prelude.charAt(0) === '@' && !/^@(media|supports|layer|container)\b/i.test(prelude)) {
                i = close;
                continue;
            }
            if (prelude.charAt(0) === '@') {
                isLayer = /^@layer\b/i.test(prelude);
                child = layer;
                if (isLayer && window.__pfJoinLayer) child = window.__pfJoinLayer(layer, prelude);
                flat = processCss(body, child);
                if (flat) {
                    if (isLayer && window.__pfPrefixCss) out.push(flat);
                    else out.push(prelude + '{' + flat + '}');
                }
            } else if (prelude) {
                flat = flattenStyle(prelude, body);
                if (flat) {
                    if (window.__pfPrefixCss) out.push(window.__pfPrefixCss(flat, layer || null));
                    else out.push(flat);
                }
            }
            i = close;
        }
        return out.join('\n');
    }

    function transform(css) {
        if (!css || css.indexOf('{') === -1) return css;
        var extra = processCss(css);
        return extra ? css + '\n' + extra : css;
    }

    if (window.__pfRegisterShadowTransform) window.__pfRegisterShadowTransform(function (css) {
        var extra = processCss(css);
        return extra ? css + '\n' + extra : css;
    });

    if (!window.__pfInstallCssSheetRewriter) return;
    window.__pfInstallCssSheetRewriter({
        marker: 'data-pf-nesting',
        skipSheet: function (css) { return !css || css.indexOf('{') === -1; },
        extract: function (css) { return processCss(css); }
    });
})();
