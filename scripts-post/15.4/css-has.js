// Stylesheet :has() for iOS before 15.4. Rewrites selectors to a class the runtime toggles.
(function () {
    if (window.__pfCssHas) return;
    window.__pfCssHas = true;

    var rules = [];

    function classFor(sel, inner) {
        var s = sel + '\0' + inner;
        var h = 0;
        var i;
        for (i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
        return 'pf-has-' + h.toString(36);
    }

    function findHas(sel) {
        var idx = sel.indexOf(':has(');
        var depth, j;
        if (idx === -1) return null;
        j = idx + 5;
        depth = 1;
        while (j < sel.length && depth > 0) {
            if (sel.charAt(j) === '(') depth++;
            else if (sel.charAt(j) === ')') depth--;
            j++;
        }
        return { idx: idx, end: j, inner: sel.slice(idx + 5, j - 1).replace(/^\s+|\s+$/g, '') };
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

    function subject(sel, idx) {
        var i = idx - 1;
        while (i >= 0) {
            var ch = sel.charAt(i);
            if (ch === ' ' || ch === '>' || ch === '+' || ch === '~') break;
            i--;
        }
        return sel.slice(i + 1, idx);
    }

    function rewriteSelector(sel) {
        var parts = splitCommas(sel);
        var out = [];
        var i, cur, hit, cls, base;
        for (i = 0; i < parts.length; i++) {
            cur = parts[i];
            hit = findHas(cur);
            if (!hit) { out.push(cur); continue; }
            cls = classFor(cur, hit.inner);
            var beforeHas = cur.slice(0, hit.idx).replace(/\s+$/, '');
            var notWrap = beforeHas.slice(-5) === ':not(';
            base = subject(cur, notWrap ? beforeHas.length - 5 : hit.idx);
            rules.push({
                cls: cls,
                base: base || '*',
                inner: hit.inner,
                child: hit.inner.charAt(0) === '>'
            });
            out.push(cur.slice(0, hit.idx) + '.' + cls + cur.slice(hit.end));
        }
        return out.join(',');
    }

    function findBrace(css, openIdx) {
        var depth = 1;
        var j = openIdx + 1;
        while (j < css.length && depth > 0) {
            if (css.charAt(j) === '{') depth++;
            else if (css.charAt(j) === '}') depth--;
            j++;
        }
        return j;
    }

    function rewriteCss(css) {
        var i = 0;
        var out = [];
        if (!css || css.indexOf(':has(') === -1) return '';
        while (i < css.length) {
            while (i < css.length && /\s/.test(css.charAt(i))) i++;
            if (i >= css.length) break;
            if (css.charAt(i) === '@') {
                var atOpen = css.indexOf('{', i);
                if (atOpen === -1) break;
                var atClose = findBrace(css, atOpen);
                var inner = rewriteCss(css.slice(atOpen + 1, atClose - 1));
                if (inner) out.push(css.slice(i, atOpen).replace(/^\s+|\s+$/g, '') + '{' + inner + '}');
                i = atClose;
                continue;
            }
            var open = css.indexOf('{', i);
            if (open === -1) break;
            var close = findBrace(css, open);
            var sel = css.slice(i, open);
            if (sel.indexOf(':has(') !== -1) out.push(rewriteSelector(sel.replace(/^\s+|\s+$/g, '')) + css.slice(open, close));
            i = close;
        }
        return out.join('\n');
    }

    function matchesInner(el, rule) {
        var inner = rule.inner;
        var child, i, rest;
        if (!inner) return false;
        if (rule.child) {
            rest = inner.replace(/^>\s*/, '');
            for (child = el.firstElementChild; child; child = child.nextElementSibling) {
                try { if (child.matches && child.matches(rest)) return true; } catch (e) {}
            }
            return false;
        }
        try {
            if (el.matches && el.matches(inner)) return true;
        } catch (e2) {}
        try {
            return !!el.querySelector(inner);
        } catch (e3) {
            return false;
        }
    }

    function apply(root) {
        var i, list, j, el;
        root = root || document;
        if (!root.querySelectorAll) return;
        for (i = 0; i < rules.length; i++) {
            try { list = root.querySelectorAll(rules[i].base); } catch (e) { continue; }
            for (j = 0; j < list.length; j++) {
                el = list[j];
                if (matchesInner(el, rules[i])) el.classList.add(rules[i].cls);
                else el.classList.remove(rules[i].cls);
            }
        }
    }

    var scheduled = false;
    function schedule() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function () { scheduled = false; apply(document); }, 30);
    }

    if (window.__pfRegisterShadowTransform) {
        window.__pfRegisterShadowTransform(function (css) {
            var extra = rewriteCss(css);
            return extra ? css + '\n' + extra : css;
        });
    }

    if (window.__pfInstallCssSheetRewriter) {
        window.__pfInstallCssSheetRewriter({
            marker: 'data-pf-has',
            skipSheet: function (css) { return !css || css.indexOf(':has(') === -1; },
            extract: function (css) {
                var extra = rewriteCss(css);
                if (extra) schedule();
                return extra;
            }
        });
    }

    window.__pfOnShadowRoot = (function (prev) {
        return function (root) {
            if (prev) prev(root);
            apply(root);
        };
    })(window.__pfOnShadowRoot);

    if (window.MutationObserver) {
        new MutationObserver(schedule).observe(document.documentElement || document, {
            childList: true,
            subtree: true,
            attributes: true
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
    else schedule();
})();
