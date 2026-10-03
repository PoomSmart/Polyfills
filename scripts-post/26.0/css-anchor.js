// CSS anchor positioning for iOS before 26. Writes top, left, and width from anchor rules.
(function () {
    if (window.__pfCssAnchor) return;
    window.__pfCssAnchor = true;

    try {
        var probe = document.createElement('div');
        probe.style.setProperty('anchor-name', '--a');
        if (probe.style.getPropertyValue('anchor-name')) return;
    } catch (e) {}

    var rules = [];
    var order = 0;
    var managed = [];
    var written = typeof WeakMap === 'function' ? new WeakMap() : null;
    var scheduled = false;
    var seenSheets = {};

    var ANCHOR_PROP = {
        'anchor-name': 1, 'position-anchor': 1, 'position-area': 1, 'inset-area': 1,
        'position-try-fallbacks': 1, 'position-try': 1
    };
    var SIZE_PROP = {
        top: 1, left: 1, right: 1, bottom: 1, width: 1, height: 1,
        'min-width': 1, 'max-width': 1, 'min-height': 1, 'max-height': 1,
        'inset-block-start': 1, 'inset-block-end': 1, 'inset-inline-start': 1, 'inset-inline-end': 1
    };

    function sheetUsesAnchor(css) {
        return css.indexOf('anchor(') !== -1 || css.indexOf('anchor-size(') !== -1 ||
            css.indexOf('anchor-name') !== -1 || css.indexOf('position-anchor') !== -1 ||
            css.indexOf('position-area') !== -1 || css.indexOf('inset-area') !== -1 ||
            css.indexOf('position-try') !== -1;
    }

    function isAnchorDecl(prop, value) {
        if (ANCHOR_PROP[prop]) return true;
        if (!SIZE_PROP[prop] || !value) return false;
        return value.indexOf('anchor(') !== -1 || value.indexOf('anchor-size(') !== -1;
    }
    var AXIS = { top: 'y', bottom: 'y', left: 'x', right: 'x', 'inset-block-start': 'y', 'inset-block-end': 'y', 'inset-inline-start': 'x', 'inset-inline-end': 'x' };
    var PHYS = { 'inset-block-start': 'top', 'inset-block-end': 'bottom', 'inset-inline-start': 'left', 'inset-inline-end': 'right' };

    function findBrace(css, openIdx) {
        var depth = 1, j = openIdx + 1;
        while (j < css.length && depth > 0) {
            if (css.charAt(j) === '{') depth++;
            else if (css.charAt(j) === '}') depth--;
            j++;
        }
        return j;
    }

    function splitCommas(sel) {
        var out = [], cur = '', depth = 0, i, ch;
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

    function specOf(sel) {
        var s = sel.replace(/\[[^\]]*\]/g, '.a');
        var ids = (s.match(/#[\w-]+/g) || []).length;
        var cls = (s.match(/\.[\w-]+|:(?!:)[\w-]+/g) || []).length;
        return ids * 100 + cls;
    }

    function addDecl(sel, media, prop, value, imp) {
        var parts = splitCommas(sel);
        var i;
        for (i = 0; i < parts.length; i++) {
            if (parts[i].indexOf('::') !== -1) continue;
            rules.push({ sel: parts[i], media: media, prop: prop, value: value, imp: imp ? 1 : 0, spec: specOf(parts[i]), order: order++ });
        }
    }

    function walk(css, media) {
        var i = 0;
        if (!css || !sheetUsesAnchor(css)) return;
        while (i < css.length) {
            while (i < css.length && /\s/.test(css.charAt(i))) i++;
            if (i >= css.length) break;
            var open = css.indexOf('{', i);
            if (open === -1) break;
            var prelude = css.slice(i, open).replace(/^\s+|\s+$/g, '');
            var close = findBrace(css, open);
            var body = css.slice(open + 1, close - 1);
            if (prelude.charAt(0) === '@') {
                if (/^@media\b/i.test(prelude)) walk(body, media.concat([prelude.replace(/^@media/i, '').replace(/^\s+|\s+$/g, '')]));
                else if (/^@(supports|layer|container)\b/i.test(prelude)) walk(body, media);
            } else if (prelude) {
                var decls = body.split(';');
                var d;
                for (d = 0; d < decls.length; d++) {
                    var colon = decls[d].indexOf(':');
                    if (colon === -1) continue;
                    var prop = decls[d].slice(0, colon).replace(/^\s+|\s+$/g, '').toLowerCase();
                    var raw = decls[d].slice(colon + 1);
                    var imp = /\s!important\s*$/i.test(raw);
                    var value = raw.replace(/\s*!important\s*$/i, '').replace(/^\s+|\s+$/g, '');
                    if (isAnchorDecl(prop, value)) {
                        addDecl(prelude, media, prop, value, imp);
                    }
                }
            }
            i = close;
        }
    }

    var listening = false;
    var styleSeq = 0;

    function ensureListeners() {
        if (listening || !rules.length) return;
        listening = true;
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);
        if (window.visualViewport) {
            visualViewport.addEventListener('resize', schedule);
            visualViewport.addEventListener('scroll', schedule);
        }
    }

    function takeCss(css, key) {
        var before;
        if (!css || seenSheets[key] === css) return;
        seenSheets[key] = css;
        if (!sheetUsesAnchor(css)) return;
        before = rules.length;
        walk(css, []);
        if (rules.length > before) {
            ensureListeners();
            schedule();
        }
    }

    function scanLinks() {
        var links = document.querySelectorAll('link[rel="stylesheet"]');
        var styles, i, text;
        for (i = 0; i < links.length; i++) {
            (function (link) {
                if (!link.href || !window.__pfLoadCssText) return;
                window.__pfLoadCssText(link.href, function (err, css) {
                    if (err || !css) return;
                    var abs = window.__pfAbsolutizeCssUrls ? window.__pfAbsolutizeCssUrls(css, link.href) : css;
                    takeCss(abs, link.href);
                });
            })(links[i]);
        }
        styles = document.getElementsByTagName('style');
        for (i = 0; i < styles.length; i++) {
            text = styles[i].textContent || '';
            if (styles[i].__pfAnchorSeen === text) continue;
            styles[i].__pfAnchorSeen = text;
            if (!styles[i].__pfAnchorId) styles[i].__pfAnchorId = 's' + (styleSeq++);
            takeCss(text, styles[i].__pfAnchorId);
        }
    }

    function mediaOK(list) {
        var i;
        for (i = 0; i < list.length; i++) {
            try { if (!matchMedia(list[i]).matches) return false; } catch (e) { return true; }
        }
        return true;
    }

    function qsa(rule) {
        if (rule.bad) return [];
        try { return document.querySelectorAll(rule.sel); } catch (e) { rule.bad = true; return []; }
    }

    function resolveVars(v, cs, depth) {
        var out = '', i = 0;
        if (!v || v.indexOf('var(') === -1 || (depth || 0) > 8) return v;
        while (i < v.length) {
            var j = v.indexOf('var(', i);
            var k, d, inner, c, name, val;
            if (j === -1) { out += v.slice(i); break; }
            out += v.slice(i, j);
            k = j + 4; d = 1;
            while (k < v.length && d) { if (v.charAt(k) === '(') d++; else if (v.charAt(k) === ')') d--; k++; }
            inner = v.slice(j + 4, k - 1);
            c = inner.indexOf(',');
            name = (c === -1 ? inner : inner.slice(0, c)).replace(/^\s+|\s+$/g, '');
            val = cs.getPropertyValue(name).replace(/^\s+|\s+$/g, '');
            if (!val && c !== -1) val = inner.slice(c + 1).replace(/^\s+|\s+$/g, '');
            out += resolveVars(val, cs, (depth || 0) + 1);
            i = k;
        }
        return out;
    }

    function replaceCalls(v, name, fn) {
        var out = '', i = 0, needle = name + '(', from = 0, start, k, d;
        while ((start = v.indexOf(needle, from)) !== -1) {
            if (start > 0 && /[\w-]/.test(v.charAt(start - 1))) { from = start + needle.length; continue; }
            k = start + needle.length; d = 1;
            while (k < v.length && d) { if (v.charAt(k) === '(') d++; else if (v.charAt(k) === ')') d--; k++; }
            out += v.slice(i, start) + fn(v.slice(start + needle.length, k - 1));
            i = k; from = k;
        }
        return out + v.slice(i);
    }

    function sideCoord(rect, axis, side, prop) {
        var lo = axis === 'y' ? rect.top : rect.left;
        var hi = axis === 'y' ? rect.bottom : rect.right;
        side = side.replace(/^\s+|\s+$/g, '').toLowerCase();
        if (/%$/.test(side)) return lo + (hi - lo) * parseFloat(side) / 100;
        if (side === 'top' || side === 'left' || side === 'start') return lo;
        if (side === 'bottom' || side === 'right' || side === 'end') return hi;
        if (side === 'center') return (lo + hi) / 2;
        return NaN;
    }

    function containingBlock(el, cs) {
        var de = document.documentElement;
        var op, r;
        if (cs.position === 'fixed') return { ox: 0, oy: 0, w: de.clientWidth, h: de.clientHeight };
        op = el.offsetParent;
        if (!op || (op === document.body && getComputedStyle(op).position === 'static')) {
            return { ox: -window.scrollX, oy: -window.scrollY, w: de.clientWidth, h: de.clientHeight };
        }
        r = op.getBoundingClientRect();
        return { ox: r.left + op.clientLeft - op.scrollLeft, oy: r.top + op.clientTop - op.scrollTop, w: op.clientWidth, h: op.clientHeight };
    }

    function tracks(word) {
        var w = word.replace(/^self-/, '').replace(/^(block|inline|x|y)-/, '').replace(/^span-(block|inline|x|y)-/, 'span-');
        if (w === 'top' || w === 'left' || w === 'start') return [0];
        if (w === 'bottom' || w === 'right' || w === 'end') return [2];
        if (w === 'center') return [1];
        if (w === 'span-top' || w === 'span-left' || w === 'span-start') return [0, 1];
        if (w === 'span-bottom' || w === 'span-right' || w === 'span-end') return [1, 2];
        if (w === 'span-all') return [0, 1, 2];
        return null;
    }

    function axisOf(word) {
        if (/top|bottom|block|(^|-)y-/.test(word)) return 'y';
        if (/left|right|inline|(^|-)x-/.test(word)) return 'x';
        return null;
    }

    function parseArea(v) {
        var words = v.replace(/^\s+|\s+$/g, '').toLowerCase().split(/\s+/);
        var y = null, x = null, a0, a1, t0, t1, t;
        if (!words.length || words[0] === 'none') return null;
        if (words.length === 1) {
            t = tracks(words[0]);
            if (!t) return null;
            if (axisOf(words[0]) === 'y') return { y: t, x: [0, 1, 2] };
            if (axisOf(words[0]) === 'x') return { y: [0, 1, 2], x: t };
            return { y: t, x: t };
        }
        a0 = axisOf(words[0]); a1 = axisOf(words[1]);
        t0 = tracks(words[0]); t1 = tracks(words[1]);
        if (!t0 || !t1) return null;
        if (a0 === 'x' || a1 === 'y') { x = t0; y = t1; } else { y = t0; x = t1; }
        return { y: y, x: x };
    }

    function alignFor(t) {
        if (t.length === 1) return t[0] === 0 ? 'end' : t[0] === 2 ? 'start' : 'center';
        if (t.length === 3) return 'center';
        return t[0] === 0 ? 'end' : 'start';
    }

    function write(el, styles) {
        var prev = written ? (written.get(el) || {}) : (el.__pfAnchorPrev || {});
        var props = ['top', 'left', 'right', 'bottom', 'width', 'height'];
        var i, p, v;
        for (i = 0; i < props.length; i++) {
            p = props[i];
            v = styles[p];
            if (v == null) { if (prev[p] != null) el.style.removeProperty(p); continue; }
            if (prev[p] !== v) el.style.setProperty(p, v);
        }
        if (written) written.set(el, styles);
        else el.__pfAnchorPrev = styles;
        if (managed.indexOf(el) === -1) managed.push(el);
    }

    function clearEl(el) {
        var prev = written ? written.get(el) : el.__pfAnchorPrev;
        var p;
        if (prev) for (p in prev) el.style.removeProperty(p);
        if (written) written.delete(el);
        else el.__pfAnchorPrev = null;
    }

    function anchorRect(names, name, fallback) {
        var a = name ? names[name] : fallback;
        var r;
        if (!a || !a.isConnected) return null;
        r = a.getBoundingClientRect();
        return (r.width || r.height) ? r : null;
    }

    function compute(el, cs, d, names, anchorEl) {
        var cb = containingBlock(el, cs);
        var styles = {};
        var used = false;
        var A = anchorRect(names, null, anchorEl);
        var p, axis, val, pa, area;
        ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height'].forEach(function (prop) {
            if (!d[prop] || d[prop].indexOf('anchor-size(') === -1) return;
            styles[prop] = replaceCalls(d[prop], 'anchor-size', function (args) {
                var parts = args.split(',');
                var words = parts[0].replace(/^\s+|\s+$/g, '').split(/\s+/);
                var name = null, dim = '', w;
                for (w = 0; w < words.length; w++) {
                    if (words[w].indexOf('--') === 0) name = words[w];
                    else dim = words[w];
                }
                var r = anchorRect(names, name, anchorEl);
                if (!r) return parts.length > 1 ? parts.slice(1).join(',') : '0px';
                if (!dim) dim = /height/.test(prop) ? 'height' : 'width';
                return ((/height|block/.test(dim) ? r.height : r.width).toFixed(2)) + 'px';
            });
            used = true;
        });
        for (p in d) {
            axis = AXIS[p];
            if (!axis || !d[p] || d[p].indexOf('anchor(') === -1) continue;
            var phys = PHYS[p] || p;
            val = replaceCalls(d[p], 'anchor', function (args) {
                var parts = args.split(',');
                var words = parts[0].replace(/^\s+|\s+$/g, '').split(/\s+/);
                var name = null, side = 'center', w, r, c, px;
                for (w = 0; w < words.length; w++) {
                    if (words[w].indexOf('--') === 0) name = words[w];
                    else side = words[w];
                }
                r = anchorRect(names, name, anchorEl);
                if (!r) return parts.length > 1 ? parts.slice(1).join(',') : '0px';
                c = sideCoord(r, axis, side, phys);
                if (isNaN(c)) return '0px';
                if (phys === 'top') px = c - cb.oy;
                else if (phys === 'left') px = c - cb.ox;
                else if (phys === 'bottom') px = cb.oy + cb.h - c;
                else px = cb.ox + cb.w - c;
                return px.toFixed(2) + 'px';
            });
            styles[phys] = val;
            used = true;
        }
        pa = d['position-area'];
        area = pa ? parseArea(pa) : null;
        if (area && A) {
            var ys = [cb.oy, A.top, A.bottom, cb.oy + cb.h];
            var xs = [cb.ox, A.left, A.right, cb.ox + cb.w];
            var aTop = ys[area.y[0]], aBot = ys[area.y[area.y.length - 1] + 1];
            var aL = xs[area.x[0]], aR = xs[area.x[area.x.length - 1] + 1];
            var ay = alignFor(area.y), ax = alignFor(area.x);
            var h = el.offsetHeight, w = el.offsetWidth, top, left;
            if (ay === 'start') top = aTop;
            else if (ay === 'end') top = aBot - h;
            else top = (aTop + aBot) / 2 - h / 2;
            if (ax === 'start') left = aL;
            else if (ax === 'end') left = aR - w;
            else left = (aL + aR) / 2 - w / 2;
            styles.top = (top - cb.oy).toFixed(2) + 'px';
            styles.left = (left - cb.ox).toFixed(2) + 'px';
            styles.bottom = 'auto';
            styles.right = 'auto';
            used = true;
        }
        return used ? styles : null;
    }

    function update() {
        scheduled = false;
        if (!rules.length) return;
        var names = {};
        var per = [];
        var i, els, e, cs, list, n;
        for (i = 0; i < rules.length; i++) {
            var rule = rules[i];
            if (rule.media.length && !mediaOK(rule.media)) continue;
            els = qsa(rule);
            if (rule.prop === 'anchor-name') {
                for (e = 0; e < els.length; e++) {
                    cs = getComputedStyle(els[e]);
                    if (cs.display === 'none') continue;
                    list = resolveVars(rule.value, cs).split(',');
                    for (n = 0; n < list.length; n++) {
                        var nm = list[n].replace(/^\s+|\s+$/g, '');
                        if (nm.indexOf('--') === 0) names[nm] = els[e];
                    }
                }
                continue;
            }
            for (e = 0; e < els.length; e++) {
                var bucket = null, b;
                for (b = 0; b < per.length; b++) if (per[b].el === els[e]) bucket = per[b];
                if (!bucket) { bucket = { el: els[e], d: {} }; per.push(bucket); }
                var old = bucket.d[rule.prop];
                if (!old || rule.imp > old.imp || (rule.imp === old.imp && (rule.spec > old.spec || (rule.spec === old.spec && rule.order > old.order)))) {
                    bucket.d[rule.prop] = rule;
                }
            }
        }
        var seen = [];
        for (i = 0; i < per.length; i++) {
            var item = per[i];
            cs = getComputedStyle(item.el);
            if (cs.display === 'none' || (cs.position !== 'absolute' && cs.position !== 'fixed')) continue;
            var d = {};
            for (var p in item.d) d[p] = resolveVars(item.d[p].value, cs);
            if (d['inset-area'] && !d['position-area']) d['position-area'] = d['inset-area'];
            var pa = (d['position-anchor'] || '').replace(/^\s+|\s+$/g, '');
            var anchorEl = pa && pa !== 'auto' ? names[pa] : null;
            var styles = compute(item.el, cs, d, names, anchorEl);
            if (!styles) continue;
            write(item.el, styles);
            seen.push(item.el);
        }
        for (i = managed.length - 1; i >= 0; i--) {
            if (seen.indexOf(managed[i]) === -1) {
                clearEl(managed[i]);
                managed.splice(i, 1);
            }
        }
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function () { try { update(); } catch (err) { scheduled = false; } }, 16);
    }

    function start() {
        var scanTimer = 0;
        function queueScan() {
            if (scanTimer) return;
            scanTimer = setTimeout(function () { scanTimer = 0; scanLinks(); }, 40);
        }
        scanLinks();
        if (window.__pfOnCssLayersUpdate) window.__pfOnCssLayersUpdate(function () { seenSheets = {}; scanLinks(); });
        if (window.MutationObserver) {
            new MutationObserver(function (mutations) {
                var i, j, node, added;
                for (i = 0; i < mutations.length; i++) {
                    added = mutations[i].addedNodes;
                    if (!added) continue;
                    for (j = 0; j < added.length; j++) {
                        node = added[j];
                        if (!node || node.nodeType !== 1) continue;
                        if (node.tagName === 'STYLE' || node.tagName === 'LINK' || (node.querySelector && node.querySelector('style,link[rel="stylesheet"]'))) {
                            queueScan();
                            return;
                        }
                    }
                }
            }).observe(document.documentElement || document, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
