// Re-run classic scripts that fail to parse because of class static blocks.
// Lookbehind and the regex v flag are left unchanged.
(function () {
    if (window.__pfScriptSyntax) return;
    window.__pfScriptSyntax = true;
    if (!window.__pfBridgeEval || !window.__pfBridgeGet) return;

    var handled = typeof WeakSet === 'function' ? new WeakSet() : null;

    function isIdentChar(c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || (c >= '0' && c <= '9');
    }

    function skipString(src, i) {
        var q = src.charAt(i);
        var j = i + 1;
        while (j < src.length) {
            if (src.charAt(j) === '\\') { j += 2; continue; }
            if (src.charAt(j) === q) return j + 1;
            j++;
        }
        return src.length;
    }

    function rewriteStaticBlocks(src) {
        var out = [];
        var i = 0;
        var n = src.length;
        var count = 0;
        var changed = false;
        while (i < n) {
            var c = src.charAt(i);
            if (c === '/' && src.charAt(i + 1) === '/') {
                var nl = src.indexOf('\n', i);
                if (nl < 0) { out.push(src.slice(i)); break; }
                out.push(src.slice(i, nl + 1));
                i = nl + 1;
                continue;
            }
            if (c === '/' && src.charAt(i + 1) === '*') {
                var end = src.indexOf('*/', i + 2);
                if (end < 0) { out.push(src.slice(i)); break; }
                out.push(src.slice(i, end + 2));
                i = end + 2;
                continue;
            }
            if (c === '"' || c === "'" || c === '`') {
                var j = skipString(src, i);
                out.push(src.slice(i, j));
                i = j;
                continue;
            }
            if (src.slice(i, i + 6) === 'static' && (i === 0 || !isIdentChar(src.charAt(i - 1))) && !isIdentChar(src.charAt(i + 6) || '')) {
                var k = i + 6;
                while (k < n && /\s/.test(src.charAt(k))) k++;
                if (src.charAt(k) === '{') {
                    var depth = 1;
                    var b = k + 1;
                    while (b < n && depth > 0) {
                        var ch = src.charAt(b);
                        if (ch === '"' || ch === "'" || ch === '`') { b = skipString(src, b); continue; }
                        if (ch === '/' && src.charAt(b + 1) === '/') {
                            var line = src.indexOf('\n', b);
                            b = line < 0 ? n : line + 1;
                            continue;
                        }
                        if (ch === '{') depth++;
                        else if (ch === '}') depth--;
                        b++;
                    }
                    var body = src.slice(k + 1, b - 1);
                    out.push('static __pfSb' + (count++) + '=(function(){' + body + '}).call(this);');
                    changed = true;
                    i = b;
                    continue;
                }
            }
            out.push(c);
            i++;
        }
        return changed ? out.join('') : null;
    }

    function mark(el) {
        if (handled) handled.add(el);
        else el.__pfStaticFixed = true;
    }

    function seen(el) {
        if (handled) return handled.has(el);
        return !!el.__pfStaticFixed;
    }

    function isClassic(el) {
        var t = (el.getAttribute('type') || '').replace(/^\s+|\s+$/g, '').toLowerCase();
        return !t || t === 'text/javascript' || t === 'application/javascript' || t === 'text/ecmascript' || t === 'application/ecmascript';
    }

    function run(code) {
        if (!code) return;
        if (typeof window.__pfFixLegacySyntax === 'function') code = window.__pfFixLegacySyntax(code);
        window.__pfBridgeEval(code);
    }

    function fixText(src) {
        if (!src || src.indexOf('static') === -1) return null;
        return rewriteStaticBlocks(src);
    }

    function fixExternal(el) {
        if (!el || !el.src || seen(el) || !isClassic(el)) return;
        mark(el);
        window.__pfBridgeGet('jsraw', el.src).then(function (reply) {
            var raw = reply && (reply.raw != null ? reply.raw : reply.data);
            var fixed = fixText(raw);
            if (fixed) run(fixed);
        }, function () {});
    }

    function fixInline(el) {
        var fixed;
        if (!el || el.src || seen(el) || !isClassic(el)) return;
        fixed = fixText(el.textContent || '');
        if (!fixed) return;
        mark(el);
        run(fixed);
    }

    function scanInline() {
        var list = document.getElementsByTagName('script');
        var i;
        for (i = 0; i < list.length; i++) fixInline(list[i]);
    }

    window.addEventListener('error', function (e) {
        var msg = e && (e.message || '');
        if (e && e.target && e.target.tagName === 'SCRIPT') {
            fixExternal(e.target);
            return;
        }
        if (msg.indexOf('Syntax') === -1 && msg.indexOf('Unexpected') === -1) return;
        scanInline();
    }, true);

    function start() { scanInline(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
