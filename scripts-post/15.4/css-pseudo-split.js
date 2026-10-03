// Drop unknown pseudos from a selector list so one bad pseudo does not drop the rule.
(function () {
    if (window.__pfPseudoSplit) return;
    window.__pfPseudoSplit = true;

    var ALIAS = {
        '::placeholder': '::-webkit-input-placeholder',
        '::file-selector-button': '::-webkit-file-upload-button'
    };

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

    var probe = document.createElement('div');
    function selectorOK(sel) {
        try { probe.matches(sel); return true; } catch (e) { return false; }
    }

    function alias(sel) {
        var k;
        for (k in ALIAS) {
            if (Object.prototype.hasOwnProperty.call(ALIAS, k) && sel.indexOf(k) !== -1) {
                var aliased = sel.split(k).join(ALIAS[k]);
                if (selectorOK(aliased)) return aliased;
            }
        }
        return sel;
    }

    function fixSelector(sel) {
        var parts, i, kept, piece;
        if (sel.indexOf('::') === -1 && sel.indexOf(':') === -1) return sel;
        if (selectorOK(sel)) return sel;
        parts = splitCommas(sel);
        if (parts.length < 2 && sel === alias(sel) && !selectorOK(alias(sel))) return '';
        kept = [];
        for (i = 0; i < parts.length; i++) {
            piece = alias(parts[i]);
            if (selectorOK(piece)) kept.push(piece);
        }
        return kept.join(',');
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

    function extract(css) {
        var i = 0;
        var out = [];
        if (!css) return '';
        while (i < css.length) {
            while (i < css.length && /\s/.test(css.charAt(i))) i++;
            if (i >= css.length || css.charAt(i) === '}') break;
            if (css.charAt(i) === '@') {
                var atOpen = css.indexOf('{', i);
                if (atOpen === -1) break;
                var atClose = findBrace(css, atOpen);
                var inner = extract(css.slice(atOpen + 1, atClose - 1));
                if (inner) out.push(css.slice(i, atOpen).replace(/^\s+|\s+$/g, '') + '{' + inner + '}');
                i = atClose;
                continue;
            }
            var open = css.indexOf('{', i);
            if (open === -1) break;
            var close = findBrace(css, open);
            var sel = css.slice(i, open).replace(/^\s+|\s+$/g, '');
            var fixed = fixSelector(sel);
            if (fixed && fixed !== sel) out.push(fixed + css.slice(open, close));
            i = close;
        }
        return out.join('\n');
    }

    if (window.__pfRegisterShadowTransform) {
        window.__pfRegisterShadowTransform(function (css) {
            var extra = extract(css);
            return extra ? css + '\n' + extra : css;
        });
    }
    if (!window.__pfInstallCssSheetRewriter) return;
    window.__pfInstallCssSheetRewriter({
        marker: 'data-pf-pseudo-split',
        skipSheet: function () { return false; },
        extract: extract
    });
})();
