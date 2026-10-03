// @property initial-value becomes a :where(:root) custom property. iOS before 15.4.
(function () {
    if (window.__pfCssProperty) return;
    window.__pfCssProperty = true;

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

    function initialValue(body) {
        var m = body.match(/(?:^|[;{])\s*initial-value\s*:\s*([^;}]+)/i);
        return m ? m[1].replace(/^\s+|\s+$/g, '') : '';
    }

    function extract(css) {
        var i = 0;
        var decls = [];
        if (!css || css.toLowerCase().indexOf('@property') === -1) return '';
        while (i < css.length) {
            var idx = css.toLowerCase().indexOf('@property', i);
            var open, close, name, init;
            if (idx === -1) break;
            open = css.indexOf('{', idx);
            if (open === -1) break;
            name = css.slice(idx + 9, open).replace(/^\s+|\s+$/g, '');
            close = findBrace(css, open);
            init = initialValue(css.slice(open + 1, close - 1));
            if (/^--[\w-]+$/.test(name) && init) decls.push(name + ':' + init);
            i = close;
        }
        return decls.length ? ':where(:root){' + decls.join(';') + '}' : '';
    }

    if (window.__pfRegisterShadowTransform) {
        window.__pfRegisterShadowTransform(function (css) {
            var extra = extract(css);
            if (!extra) return css;
            return extra + '\n' + css.replace(/@property\b/gi, '@-pf-property');
        });
    }

    if (!window.__pfInstallCssSheetRewriter) return;
    window.__pfInstallCssSheetRewriter({
        marker: 'data-pf-property',
        skipSheet: function (css) { return !css || css.toLowerCase().indexOf('@property') === -1; },
        extract: extract
    });
})();
