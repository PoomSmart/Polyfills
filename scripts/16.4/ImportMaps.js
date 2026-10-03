// Import maps and bare module specifiers, for iOS before 16.4.
// Runs rewritten modules through __pfbridge so the page CSP does not block them.
// Lookbehind and callee/parameter clashes are fixed by A_legacy_syntax.js before eval.
(function () {
    if (window.__pfImportMaps) return;
    window.__pfImportMaps = true;

    var supportsName = 'sup' + 'ports';
    var supportsFn = window.HTMLScriptElement && HTMLScriptElement[supportsName];
    if (typeof supportsFn === 'function') {
        try { if (supportsFn.call(HTMLScriptElement, 'importmap')) return; } catch (e) {}
    }
    if (!window.__pfBridgeGet || !window.__pfBridgeEval) return;

    var records = typeof Map === 'function' ? new Map() : null;
    var recordBag = records ? null : {};
    var map = { imports: {}, scopes: {} };
    var mapRead = false;
    var active = false;
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
    var inlineN = 0;

    function getRec(url) {
        if (records) {
            var hit = records.get(url);
            if (!hit) { hit = { url: url }; records.set(url, hit); }
            return hit;
        }
        if (!recordBag[url]) recordBag[url] = { url: url };
        return recordBag[url];
    }

    function isBare(spec) {
        if (!spec) return false;
        var c = spec.charAt(0);
        if (c === '/' || c === '.') return false;
        if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return false;
        return true;
    }

    function resolveUrl(rel, base) {
        if (!rel) return rel;
        if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return rel;
        if (rel.indexOf('//') === 0) return (String(base).split(':')[0] || 'https') + ':' + rel;
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

    function addMap(src, dst, base) {
        var k, key, val;
        for (k in src) {
            if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
            key = isBare(k) && k.charAt(0) !== '/' && k.indexOf('./') !== 0 && k.indexOf('../') !== 0 ? k : resolveUrl(k, base);
            try { val = resolveUrl(src[k], base); } catch (e) { continue; }
            dst[key] = val;
        }
    }

    function readMaps() {
        var nodes, i, parsed, base, scope;
        mapRead = true;
        nodes = document.querySelectorAll('script[type="importmap"]');
        for (i = 0; i < nodes.length; i++) {
            try { parsed = JSON.parse(nodes[i].textContent || ''); } catch (e) { continue; }
            base = document.baseURI || location.href;
            addMap(parsed.imports, map.imports, base);
            for (scope in parsed.scopes || {}) {
                if (!Object.prototype.hasOwnProperty.call(parsed.scopes, scope)) continue;
                var scopeKey = resolveUrl(scope, base);
                map.scopes[scopeKey] = map.scopes[scopeKey] || {};
                addMap(parsed.scopes[scope], map.scopes[scopeKey], base);
            }
        }
    }

    function lookup(key, table) {
        var best = null, p;
        if (!table) return null;
        if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
        for (p in table) {
            if (!Object.prototype.hasOwnProperty.call(table, p)) continue;
            if (p.charAt(p.length - 1) === '/' && key.indexOf(p) === 0 && (!best || p.length > best.length)) best = p;
        }
        return best ? table[best] + key.slice(best.length) : null;
    }

    function resolve(spec, parent) {
        var key, scopes, i, hit, parentUrl;
        if (!mapRead) readMaps();
        parentUrl = parent || document.baseURI || location.href;
        key = isBare(spec) ? spec : resolveUrl(spec, parentUrl);
        scopes = [];
        for (i in map.scopes) {
            if (Object.prototype.hasOwnProperty.call(map.scopes, i) && parentUrl.indexOf(i) === 0) scopes.push(i);
        }
        scopes.sort(function (a, b) { return b.length - a.length; });
        for (i = 0; i < scopes.length; i++) {
            hit = lookup(key, map.scopes[scopes[i]]);
            if (hit) return hit;
        }
        hit = lookup(key, map.imports);
        if (hit) return hit;
        if (isBare(spec)) throw new TypeError('Module name "' + spec + '" is not in the import map');
        return key;
    }

    function replaceOutsideStrings(src, re, replacement) {
        var masked = mask(src);
        var out = '';
        var last = 0;
        var m;
        re.lastIndex = 0;
        while ((m = re.exec(masked))) {
            if (masked.slice(m.index, m.index + m[0].length) !== m[0]) break;
            out += src.slice(last, m.index) + m[0].replace(new RegExp(re.source), replacement);
            last = m.index + m[0].length;
            if (!re.global) break;
        }
        return out + src.slice(last);
    }

    function mask(src) {
        if (typeof window.__pfMaskJs === 'function') return window.__pfMaskJs(src);
        return src;
    }

    function readUntilSemi(masked, start) {
        var i = start;
        var depth = 0;
        var paren = 0;
        var bracket = 0;
        while (i < masked.length) {
            var c = masked.charAt(i);
            if (c === '{') depth++;
            else if (c === '}') depth = Math.max(0, depth - 1);
            else if (c === '(') paren++;
            else if (c === ')') paren = Math.max(0, paren - 1);
            else if (c === '[') bracket++;
            else if (c === ']') bracket = Math.max(0, bracket - 1);
            else if (c === ';' && depth === 0 && paren === 0 && bracket === 0) { i++; break; }
            i++;
        }
        return i;
    }

    function readStmt(masked, start) {
        var i = start;
        var depth = 0;
        var paren = 0;
        var bracket = 0;
        while (i < masked.length) {
            var c = masked.charAt(i);
            if (c === '{') depth++;
            else if (c === '}') {
                if (depth === 0) break;
                depth--;
                if (depth === 0 && paren === 0 && bracket === 0) { i++; break; }
            } else if (c === '(') paren++;
            else if (c === ')') paren--;
            else if (c === '[') bracket++;
            else if (c === ']') bracket--;
            else if (c === ';' && depth === 0 && paren === 0 && bracket === 0) { i++; break; }
            i++;
        }
        return i;
    }

    function keywordAt(masked, i, word) {
        if (masked.slice(i, i + word.length) !== word) return false;
        var before = i === 0 ? ' ' : masked.charAt(i - 1);
        var after = masked.charAt(i + word.length) || ' ';
        if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) return false;
        return true;
    }

    function parseSpecifierList(text) {
        var parts = text.split(',');
        var out = [];
        var i, part, asAt, local, imported;
        for (i = 0; i < parts.length; i++) {
            part = parts[i].replace(/^\s+|\s+$/g, '');
            if (!part) continue;
            asAt = part.indexOf(' as ');
            if (asAt === -1) out.push({ imported: part, local: part });
            else {
                imported = part.slice(0, asAt).replace(/^\s+|\s+$/g, '');
                local = part.slice(asAt + 4).replace(/^\s+|\s+$/g, '');
                out.push({ imported: imported, local: local });
            }
        }
        return out;
    }

    function stringArg(stmt) {
        var m = stmt.match(/["']([^"']+)["']\s*;?\s*$/);
        return m ? m[1] : null;
    }

    function transformModule(src, url) {
        var masked = mask(src);
        var deps = [];
        var header = [];
        var getters = [];
        var stars = [];
        var removals = [];
        var needsSelf = false;
        var defN = 0;
        var i = 0;

        function depIdx(spec) {
            var at = deps.indexOf(spec);
            if (at === -1) { at = deps.length; deps.push(spec); }
            if (isBare(spec)) needsSelf = true;
            return at;
        }

        while (i < masked.length) {
            while (i < masked.length && /\s/.test(masked.charAt(i))) i++;
            if (i >= masked.length) break;
            if (keywordAt(masked, i, 'import') && masked.charAt(i + 6) !== '(') {
                var end = readUntilSemi(masked, i);
                var stmt = src.slice(i, end);
                var fromSpec = stringArg(stmt);
                var star = stmt.match(/^\s*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from/);
                var named = stmt.match(/^\s*import\s*\{([\s\S]*)\}\s*from/);
                var deflt = stmt.match(/^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([\s\S]*)\})?\s*from/) ||
                    stmt.match(/^\s*import\s+([A-Za-z_$][\w$]*)\s*,\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/);
                var side = /^\s*import\s+["']/.test(stmt);
                if (fromSpec) {
                    var idx = depIdx(fromSpec);
                    if (side) {
                        header.push('void __i[' + idx + '];');
                    } else if (star) {
                        header.push('var ' + star[1] + '=__i[' + idx + '];');
                    } else if (deflt && deflt[2] && stmt.indexOf('*') !== -1 && !named) {
                        header.push('var ' + deflt[1] + '=__i[' + idx + ']["default"];');
                        header.push('var ' + deflt[2] + '=__i[' + idx + '];');
                    } else {
                        if (deflt) header.push('var ' + deflt[1] + '=__i[' + idx + ']["default"];');
                        if (named || (deflt && deflt[2])) {
                            var list = parseSpecifierList((named && named[1]) || (deflt && deflt[2]) || '');
                            var s;
                            for (s = 0; s < list.length; s++) {
                                header.push('var ' + list[s].local + '=__i[' + idx + '][' + JSON.stringify(list[s].imported) + '];');
                            }
                        }
                    }
                    removals.push([i, end]);
                }
                i = end;
                continue;
            }
            if (keywordAt(masked, i, 'export')) {
                var exportHead = src.slice(i, i + 80);
                var exportNeedsBody = /^\s*export\s+(?:async\s+)?(?:function|class)\b/.test(exportHead) ||
                    /^\s*export\s+default\s+(?:async\s+)?(?:function|class)\b/.test(exportHead);
                var expEnd = exportNeedsBody ? readStmt(masked, i) : readUntilSemi(masked, i);
                var exp = src.slice(i, expEnd);
                var expFrom = /^\s*export\s*(?:\*|\{)/.test(exp) ? exp.match(/\bfrom\s+["']([^"']+)["']/) : null;
                var expIdx = expFrom ? depIdx(expFrom[1]) : -1;
                if (/^\s*export\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from/.test(exp)) {
                    var nsName = exp.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
                    getters.push([nsName[1], '__i[' + expIdx + ']']);
                    removals.push([i, expEnd]);
                } else if (/^\s*export\s*\*\s*from/.test(exp)) {
                    stars.push(expIdx);
                    removals.push([i, expEnd]);
                } else if (/^\s*export\s*\{/.test(exp)) {
                    var body = exp.match(/\{([\s\S]*)\}/);
                    var items = parseSpecifierList(body ? body[1] : '');
                    var n;
                    for (n = 0; n < items.length; n++) {
                        var importedName = items[n].imported;
                        var exportedName = items[n].local;
                        if (expIdx >= 0) getters.push([exportedName, '__i[' + expIdx + '][' + JSON.stringify(importedName) + ']']);
                        else getters.push([exportedName, importedName]);
                    }
                    removals.push([i, expEnd]);
                } else if (/^\s*export\s+default\b/.test(exp)) {
                    var rest = exp.replace(/^\s*export\s+default\s*/, '');
                    var namedDecl = rest.match(/^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/);
                    if (namedDecl) {
                        getters.push(['default', namedDecl[1]]);
                        removals.push([i, i + (exp.length - rest.length)]);
                    } else {
                        var id = '__pfDef' + (defN++);
                        getters.push(['default', id]);
                        removals.push([i, i + (exp.length - rest.length), 'var ' + id + '=']);
                    }
                } else if (/^\s*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/.test(exp)) {
                    var declName = exp.match(/^\s*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/);
                    getters.push([declName[1], declName[1]]);
                    removals.push([i, i + exp.match(/^\s*export\s+/)[0].length]);
                } else if (/^\s*export\s+(?:const|let|var)\s+/.test(exp)) {
                    var names = exp.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
                    if (names) getters.push([names[1], names[1]]);
                    removals.push([i, i + exp.match(/^\s*export\s+/)[0].length]);
                }
                i = expEnd;
                continue;
            }
            if (masked.charAt(i) === '{') {
                var blockEnd = readStmt(masked, i);
                i = blockEnd;
                continue;
            }
            i++;
        }

        var body = src;
        var r;
        removals.sort(function (a, b) { return b[0] - a[0]; });
        for (r = 0; r < removals.length; r++) {
            var rep = removals[r];
            body = body.slice(0, rep[0]) + (rep[2] || '') + body.slice(rep[1]);
        }

        body = replaceOutsideStrings(body, /(^|[^.\w$])import\.meta\b/g, '$1__m');
        body = replaceOutsideStrings(body, /(^|[^.\w$])import\s*\(/g, '$1__d(');
        if (typeof window.__pfFixLegacySyntax === 'function') body = window.__pfFixLegacySyntax(body);

        var expObj = getters.map(function (g) {
            return JSON.stringify(g[0]) + ':function(){return ' + g[1] + ';}';
        }).join(',');
        var code = '__pfDefine(' + JSON.stringify(url) + ',async function(__i,__e,__m,__d){"use strict";' +
            header.join('') +
            '__e({' + expObj + '},[' + stars.join(',') + ']);\n' +
            body + '\n});';
        return { deps: deps, needsSelf: needsSelf, code: code };
    }

    function getText(url) {
        if (/^data:/i.test(url)) {
            var comma = url.indexOf(',');
            var meta = url.slice(5, comma);
            var data = url.slice(comma + 1);
            if (/;base64/i.test(meta)) {
                try { return Promise.resolve(atob(data)); } catch (e) { return Promise.resolve(''); }
            }
            try { return Promise.resolve(decodeURIComponent(data)); } catch (e2) { return Promise.resolve(data); }
        }
        return window.__pfBridgeGet('jsraw', url).then(function (reply) {
            if (!reply) throw new Error('no source');
            if (reply.raw != null) return reply.raw;
            if (reply.data != null) return reply.data;
            throw new Error('no source');
        });
    }

    function analyze(src, url) {
        return transformModule(src, url);
    }

    function loadInfo(rec) {
        if (rec.info) return Promise.resolve(rec.info);
        if (rec.loadingInfo) return rec.loadingInfo;
        var srcP = rec.inline != null ? Promise.resolve(rec.inline) : getText(rec.url);
        rec.loadingInfo = srcP.then(function (src) {
            rec.info = analyze(src, rec.url);
            return rec.info;
        });
        return rec.loadingInfo;
    }

    function loadOne(url) {
        var rec = getRec(url);
        if (rec.loading) return rec.loading;
        rec.loading = loadInfo(rec).then(function (info) {
            var base = rec.base || rec.url;
            rec.deps = info.deps.map(function (spec) { return resolve(spec, base); });
            return rec.deps;
        });
        return rec.loading;
    }

    function loadGraph(url) {
        var seenUrls = {};
        seenUrls[url] = true;
        function wave(list) {
            if (!list.length) return Promise.resolve();
            return Promise.all(list.map(loadOne)).then(function (depLists) {
                var next = [];
                var i, j;
                for (i = 0; i < depLists.length; i++) {
                    for (j = 0; j < depLists[i].length; j++) {
                        var d = depLists[i][j];
                        if (!seenUrls[d]) { seenUrls[d] = true; next.push(d); }
                    }
                }
                return wave(next);
            });
        }
        return wave([url]);
    }

    function needs(url, stack) {
        var rec = getRec(url);
        if (rec.needs != null) return rec.needs;
        if (stack[url]) return false;
        stack[url] = true;
        var value = !!(rec.info && rec.info.needsSelf);
        var i;
        if (!value && rec.deps) {
            for (i = 0; i < rec.deps.length; i++) {
                if (needs(rec.deps[i], stack)) { value = true; break; }
            }
        }
        delete stack[url];
        if (!Object.keys(stack).length || value) rec.needs = value;
        return value;
    }

    window.__pfDefine = function (url, fn) {
        var rec = getRec(url);
        rec.fn = fn;
    };

    function defineNow(rec) {
        if (rec.fn) return Promise.resolve();
        return window.__pfBridgeEval(rec.info.code).then(function () {
            if (!rec.fn) throw new Error('module did not define');
        });
    }

    function makeNs(rec) {
        if (rec.ns) return rec.ns;
        var ns = {};
        rec.ns = ns;
        return ns;
    }

    function run(url) {
        var rec = getRec(url);
        if (rec.running && !rec.finished) return Promise.resolve(rec.ns || makeNs(rec));
        if (rec.done) return rec.done;
        if (!active && !rec.needs) {
            try {
                var nativeImport = new Function('u', 'return import(u)');
                rec.done = nativeImport(url).catch(function () {
                    rec.needs = true;
                    rec.done = null;
                    return run(url);
                });
                return rec.done;
            } catch (e) {
                rec.needs = true;
            }
        }
        rec.running = true;
        var ns = makeNs(rec);
        var chain = Promise.resolve();
        var depNs = [];
        rec.deps.forEach(function (dep, index) {
            chain = chain.then(function () {
                return run(dep).then(function (mod) { depNs[index] = mod; });
            });
        });
        rec.done = chain.then(function () { return defineNow(rec); }).then(function () {
            var exportFn = function (getters, starList) {
                var k, s, key, src;
                for (k in getters) {
                    if (!Object.prototype.hasOwnProperty.call(getters, k)) continue;
                    (function (name, getter) {
                        Object.defineProperty(ns, name, { get: getter, enumerable: true, configurable: true });
                    })(k, getters[k]);
                }
                for (s = 0; s < starList.length; s++) {
                    src = depNs[starList[s]];
                    for (key in src) {
                        if (key === 'default' || Object.prototype.hasOwnProperty.call(ns, key)) continue;
                        (function (name, mod) {
                            Object.defineProperty(ns, name, { get: function () { return mod[name]; }, enumerable: true, configurable: true });
                        })(key, src);
                    }
                }
            };
            var meta = { url: rec.inline != null ? (document.baseURI || location.href) : rec.url, resolve: function (spec) { return resolve(spec, rec.base || rec.url); } };
            var dyn = function (spec) { return dynImport(spec, rec.base || rec.url); };
            return Promise.resolve(rec.fn(depNs, exportFn, meta, dyn)).then(function () {
                rec.finished = true;
                return ns;
            });
        });
        return rec.done;
    }

    function dynImport(spec, parent) {
        var url = resolve(String(spec), parent);
        return loadGraph(url).then(function () {
            needs(url, {});
            return run(url);
        });
    }

    function patchRuntime(wr, base) {
        var orig;
        if (!wr || !wr.f || typeof wr.f.j !== 'function' || wr.__pfPatched) return;
        wr.__pfPatched = true;
        orig = wr.f.j;
        wr.f.j = function (id, promises) {
            var before = promises.length;
            var nativeTry, url, p;
            orig.call(this, id, promises);
            if (promises.length === before || typeof wr.u !== 'function') return;
            nativeTry = promises.pop();
            if (nativeTry && nativeTry.catch) nativeTry.catch(function () {});
            url = resolveUrl('./' + wr.u(id), base);
            p = dynImport(url, base).then(function (ns) {
                var mods = ns.__webpack_modules__ || ns.__webpack_esm_modules__ || ns.modules || {};
                var k;
                for (k in mods) if (Object.prototype.hasOwnProperty.call(mods, k)) wr.m[k] = mods[k];
            });
            promises.push(p);
        };
    }

    function root(script) {
        var url, rec;
        if (!script || script.tagName !== 'SCRIPT') return Promise.resolve();
        if ((script.getAttribute('type') || '').toLowerCase() === 'module') {
            script.setAttribute('type', 'text/pf-module');
        }
        if ((script.getAttribute('type') || '').toLowerCase() !== 'text/pf-module') return Promise.resolve();
        if (seen) {
            if (seen.has(script)) return Promise.resolve();
            seen.add(script);
        } else if (script.__pfMod) return Promise.resolve();
        else script.__pfMod = true;
        if (script.src) {
            url = script.src;
            rec = getRec(url);
            if (/^data:/i.test(url)) rec.base = document.baseURI || location.href;
        } else {
            url = (document.baseURI || location.href).split('#')[0] + '#pf-inline-' + (inlineN++);
            rec = getRec(url);
            rec.inline = script.textContent || '';
            rec.base = document.baseURI || location.href;
        }
        return loadGraph(url).then(function () {
            if (!active && !needs(url, {})) return null;
            return run(url);
        }).catch(function () {});
    }

    function scanAll() {
        var list = document.querySelectorAll('script[type="module"],script[type="text/pf-module"]');
        var chain = Promise.resolve();
        var i;
        for (i = 0; i < list.length; i++) {
            (function (el) { chain = chain.then(function () { return root(el); }); })(list[i]);
        }
        return chain;
    }

    function activate() {
        if (active) return;
        active = true;
        scanAll();
    }

    function check() {
        if (document.querySelector('script[type="importmap"]')) activate();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
    else setTimeout(check, 0);

    function scriptsIn(node, out) {
        var i, nested;
        if (!node || node.nodeType !== 1) return;
        if (node.localName === 'script') out.push(node);
        if (!node.querySelectorAll) return;
        nested = node.querySelectorAll('script');
        for (i = 0; i < nested.length; i++) out.push(nested[i]);
    }

    function takeScripts(list) {
        var i, type, sawMap;
        sawMap = active;
        for (i = 0; i < list.length; i++) {
            type = (list[i].getAttribute('type') || '').toLowerCase();
            if (type === 'importmap') sawMap = true;
        }
        if (!sawMap) return;
        for (i = 0; i < list.length; i++) {
            type = (list[i].getAttribute('type') || '').toLowerCase();
            if (type === 'importmap') activate();
            else if (type === 'module' || type === 'text/pf-module') root(list[i]);
        }
    }

    if (window.MutationObserver) {
        new MutationObserver(function (mutations) {
            var i, j, added, node, list;
            for (i = 0; i < mutations.length; i++) {
                added = mutations[i].addedNodes;
                if (!added) continue;
                list = [];
                for (j = 0; j < added.length; j++) {
                    node = added[j];
                    scriptsIn(node, list);
                }
                if (list.length) takeScripts(list);
            }
        }).observe(document.documentElement || document, { childList: true, subtree: true });
    }

    window.__pfDynImport = dynImport;
    window.__pfPatchWebpack = patchRuntime;
})();
