// Syntax that iOS before 16.4 rejects at parse time.
// Lookbehind is rewritten into a normal pattern.
// A literal that still contains lookbehind becomes new RegExp() for PolyfillsRegExp.
// function name(name) keeps the callee and renames the parameter to name_.
(function () {
    if (window.__pfFixLegacySyntax) return;

    var KW = {
        return: 1, throw: 1, case: 1, else: 1, do: 1, typeof: 1, void: 1,
        delete: 1, "in": 1, of: 1, instanceof: 1, yield: 1, await: 1, "new": 1
    };

    function startsRegex(last) {
        if (!last) return true;
        if (last === "=>") return true;
        if (KW[last]) return true;
        return last.length === 1 && "([{:;,=!?&|~^%*+-<>".indexOf(last) !== -1;
    }

    function spaces(text) {
        return new Array(text.length + 1).join(" ");
    }

    function readRegexAt(src, i) {
        var n = src.length;
        var j = i + 1;
        var inClass = false;
        while (j < n) {
            var ch = src.charAt(j);
            if (ch === "\\") { j += 2; continue; }
            if (ch === "\n" || ch === "\r") return null;
            if (inClass) {
                if (ch === "]") inClass = false;
                j++;
                continue;
            }
            if (ch === "[") { inClass = true; j++; continue; }
            if (ch === "/") {
                var f = j + 1;
                while (f < n && /[dgimsuvy]/.test(src.charAt(f))) f++;
                return { body: src.slice(i + 1, j), flags: src.slice(j + 1, f), end: f };
            }
            j++;
        }
        return null;
    }

    function findBalancedClose(str, openIndex) {
        if (str.charAt(openIndex) !== "(") return -1;
        var depth = 0;
        var i;
        for (i = openIndex; i < str.length; i++) {
            if (str.charAt(i) === "\\") { i++; continue; }
            if (str.charAt(i) === "(") depth++;
            else if (str.charAt(i) === ")") {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function readLookbehind(pattern, index) {
        if (pattern.slice(index, index + 3) !== "(?<") return null;
        var kind = pattern.charAt(index + 3);
        if (kind !== "!" && kind !== "=") return null;
        var lbEnd = findBalancedClose(pattern, index);
        if (lbEnd === -1) return null;
        return {
            kind: kind === "!" ? "negative" : "positive",
            start: index,
            end: lbEnd + 1,
            body: pattern.slice(index + 4, lbEnd)
        };
    }

    function readRegexTerm(pattern, index) {
        var i = index;
        if (i >= pattern.length) return null;
        var baseEnd = i;
        if (pattern.charAt(i) === "(") {
            if (pattern.charAt(i + 1) === "?") {
                var nested = readLookbehind(pattern, i);
                if (nested) {
                    var after = readRegexSequenceUntilAlternation(pattern, nested.end);
                    if (!after || !after.text) return null;
                    return { text: pattern.slice(i, after.end), end: after.end };
                }
                if (pattern.charAt(i + 2) === ":") {
                    var close = findBalancedClose(pattern, i);
                    if (close === -1) return null;
                    baseEnd = close + 1;
                } else return null;
            } else {
                var close2 = findBalancedClose(pattern, i);
                if (close2 === -1) return null;
                baseEnd = close2 + 1;
            }
        } else if (pattern.charAt(i) === "[") {
            var j = i + 1;
            while (j < pattern.length) {
                if (pattern.charAt(j) === "\\") { j += 2; continue; }
                if (pattern.charAt(j) === "]") { baseEnd = j + 1; break; }
                j++;
            }
            if (baseEnd === i) return null;
        } else if (pattern.charAt(i) === "\\") {
            baseEnd = i + 2;
        } else if (pattern.charAt(i) === ".") {
            baseEnd = i + 1;
        } else {
            var k = i;
            while (k < pattern.length) {
                if (pattern.charAt(k) === "\\") { k += 2; continue; }
                if (/[?*+{|[|().]/.test(pattern.charAt(k))) break;
                k++;
            }
            baseEnd = k > i ? k : i + 1;
        }
        var end = baseEnd;
        while (end < pattern.length && /[?*+{]/.test(pattern.charAt(end))) {
            if (pattern.charAt(end) === "{") {
                var q = pattern.indexOf("}", end);
                if (q === -1) return null;
                end = q + 1;
            } else end++;
        }
        return { text: pattern.slice(i, end), end: end };
    }

    function readRegexSequenceUntilAlternation(pattern, index) {
        var pos = index;
        var text = "";
        while (pos < pattern.length) {
            if (pattern.charAt(pos) === "|" || pattern.charAt(pos) === ")") break;
            var term = readRegexTerm(pattern, pos);
            if (!term || term.end === pos) break;
            text += term.text;
            pos = term.end;
        }
        if (!text) return null;
        return { text: text, end: pos };
    }

    function rewritePatternOnce(pattern) {
        var result = "";
        var pos = 0;
        var changed = false;
        while (pos < pattern.length) {
            var lb = readLookbehind(pattern, pos);
            if (!lb) {
                result += pattern.charAt(pos);
                pos++;
                continue;
            }
            var rest = readRegexSequenceUntilAlternation(pattern, lb.end);
            if (!rest || !rest.text) {
                result += pattern.charAt(pos);
                pos++;
                continue;
            }
            if (lb.kind === "positive" && lb.body === "^|\\s|\\p{P}|\\p{S}" && /^\(\[-\.\\w+\]\+\)@/.test(rest.text)) {
                result += "(?:^|[\\s\\p{P}\\p{S}])(?=[-.\\w+]+@)" + rest.text;
            } else if (lb.kind === "negative") {
                result += "(?!(?:" + lb.body + ")(?=" + rest.text + "))" + rest.text;
            } else {
                result += "(?:" + lb.body + ")(?=" + rest.text + ")" + rest.text;
            }
            changed = true;
            pos = rest.end;
        }
        return { pattern: result, changed: changed };
    }

    function rewritePattern(pattern) {
        var current = pattern;
        var changed = false;
        var i;
        for (i = 0; i < 20; i++) {
            var step = rewritePatternOnce(current);
            if (!step.changed) break;
            current = step.pattern;
            changed = true;
        }
        return { pattern: current, changed: changed };
    }

    function hasLookbehind(pattern) {
        return pattern.indexOf("(?<=") !== -1 || pattern.indexOf("(?<!") !== -1;
    }

    function regexReplacement(rx) {
        if (!hasLookbehind(rx.body)) return null;
        var rewritten = rewritePattern(rx.body);
        if (rewritten.changed && !hasLookbehind(rewritten.pattern) && rewritten.pattern.indexOf("/") === -1) {
            return "/" + rewritten.pattern + "/" + rx.flags;
        }
        var esc = rx.body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        return 'new RegExp("' + esc + '"' + (rx.flags ? ',"' + rx.flags + '"' : "") + ")";
    }

    function lex(src, blank) {
        var n = src.length;
        var out = [];
        var i = 0;
        var last = "";

        function push(text, hide) {
            out.push(hide ? spaces(text) : text);
        }

        function scan(stopBrace) {
            var brace = 0;
            while (i < n) {
                var c = src.charAt(i);
                if (c === "}" && stopBrace && brace === 0) { i++; return; }
                if (c === "{") { brace++; push(c, false); last = c; i++; continue; }
                if (c === "}") { if (brace > 0) brace--; push(c, false); last = c; i++; continue; }
                if (c === "/" && src.charAt(i + 1) === "/") {
                    var nl = src.indexOf("\n", i);
                    if (nl < 0) { push(src.slice(i), true); i = n; break; }
                    push(src.slice(i, nl + 1), blank);
                    i = nl + 1;
                    last = "\n";
                    continue;
                }
                if (c === "/" && src.charAt(i + 1) === "*") {
                    var end = src.indexOf("*/", i + 2);
                    if (end < 0) { push(src.slice(i), true); i = n; break; }
                    push(src.slice(i, end + 2), blank);
                    i = end + 2;
                    last = "/";
                    continue;
                }
                if (c === '"' || c === "'") {
                    var q = c;
                    var j = i + 1;
                    while (j < n) {
                        if (src.charAt(j) === "\\") { j += 2; continue; }
                        if (src.charAt(j) === q) { j++; break; }
                        j++;
                    }
                    push(src.slice(i, j), blank);
                    last = q;
                    i = j;
                    continue;
                }
                if (c === "`") {
                    push("`", blank);
                    i++;
                    scanTemplate();
                    last = "`";
                    continue;
                }
                if (c === "/" && startsRegex(last)) {
                    var rx = readRegexAt(src, i);
                    if (rx) {
                        var repl = blank ? null : regexReplacement(rx);
                        if (repl) out.push(repl);
                        else push(src.slice(i, rx.end), blank);
                        last = ")";
                        i = rx.end;
                        continue;
                    }
                }
                if (/[A-Za-z0-9_$]/.test(c)) {
                    var k = i + 1;
                    while (k < n && /[A-Za-z0-9_$]/.test(src.charAt(k))) k++;
                    last = src.slice(i, k);
                    push(last, false);
                    i = k;
                    continue;
                }
                push(c, false);
                if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") last = c;
                i++;
            }
        }

        function scanTemplate() {
            while (i < n) {
                var c = src.charAt(i);
                if (c === "\\") {
                    push(src.slice(i, i + 2), blank);
                    i += 2;
                    continue;
                }
                if (c === "`") { push("`", blank); i++; return; }
                if (c === "$" && src.charAt(i + 1) === "{") {
                    push("${", false);
                    i += 2;
                    scan(true);
                    push("}", false);
                    continue;
                }
                push(c, blank);
                i++;
            }
        }

        scan(false);
        return out.join("");
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function findParenEnd(text, openIndex) {
        if (text.charAt(openIndex) !== "(") return -1;
        var depth = 0;
        var i;
        for (i = openIndex; i < text.length; i++) {
            if (text.charAt(i) === "(") depth++;
            else if (text.charAt(i) === ")") {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function findBlockEnd(src, openBrace) {
        var i = openBrace;
        var depth = 0;
        var last = "";
        while (i < src.length) {
            var c = src.charAt(i);
            if (c === '"' || c === "'" || c === "`") {
                var q = c;
                i++;
                while (i < src.length) {
                    if (src.charAt(i) === "\\") { i += 2; continue; }
                    if (q === "`" && src.charAt(i) === "$" && src.charAt(i + 1) === "{") {
                        i += 2;
                        var inner = findBlockEnd(src, i - 1);
                        i = inner === -1 ? src.length : inner + 1;
                        continue;
                    }
                    if (src.charAt(i) === q) { i++; break; }
                    i++;
                }
                last = q;
                continue;
            }
            if (c === "/" && src.charAt(i + 1) === "/") {
                var nl = src.indexOf("\n", i);
                i = nl < 0 ? src.length : nl + 1;
                last = "\n";
                continue;
            }
            if (c === "/" && src.charAt(i + 1) === "*") {
                var end = src.indexOf("*/", i + 2);
                i = end < 0 ? src.length : end + 2;
                last = "/";
                continue;
            }
            if (c === "/" && startsRegex(last)) {
                var rx = readRegexAt(src, i);
                if (rx) { last = ")"; i = rx.end; continue; }
            }
            if (c === "{") depth++;
            else if (c === "}") {
                depth--;
                if (depth === 0) return i;
            }
            if (/[A-Za-z0-9_$]/.test(c)) {
                var k = i + 1;
                while (k < src.length && /[A-Za-z0-9_$]/.test(src.charAt(k))) k++;
                last = src.slice(i, k);
                i = k;
                continue;
            }
            if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") last = c;
            i++;
        }
        return -1;
    }

    function paramConflicts(callee, params) {
        if (params.replace(/^\s+|\s+$/g, "") === callee) return true;
        var re = new RegExp(
            "(?:^|[\\[,{\\s])" + escapeRegExp(callee) + "(?=[\\]},:=\\s,]|$)|:\\s*" + escapeRegExp(callee) + "(?=[\\},])"
        );
        return re.test(params);
    }

    function paramNameSpan(params, callee) {
        var re = new RegExp("(?:^|[\\[,{\\s])(" + escapeRegExp(callee) + ")(?=[\\]},:=\\s,]|$)");
        var match = re.exec(params);
        if (!match) return null;
        var at = match.index + match[0].length - match[1].length;
        return { start: at, end: at + callee.length };
    }

    function isMemberDot(src, i) {
        if (i < 1 || src.charAt(i - 1) !== ".") return false;
        return !(i >= 3 && src.charAt(i - 2) === "." && src.charAt(i - 3) === ".");
    }

    function braceKind(prev) {
        if (prev === "var" || prev === "let" || prev === "const" || prev === "default") return "obj";
        if (prev === "else" || prev === "try" || prev === "finally" || prev === "do" ||
            prev === "catch" || prev === "class" || prev === "static" || prev === "while" ||
            prev === "if" || prev === "for" || prev === "switch" || prev === "with" ||
            prev === "function") return "stmt";
        if (KW[prev]) return "obj";
        if (!prev || prev === ")" || prev === "}" || prev === ";" || prev === "{" || prev === "=>") return "stmt";
        if (/^[A-Za-z_$][\w$]*$/.test(prev)) return "stmt";
        return "obj";
    }

    function readNumber(src, i, to) {
        var j = i;
        if (src.charAt(j) === ".") j++;
        else if (src.charAt(j) === "0" && j + 1 < to && /[xXoObB]/.test(src.charAt(j + 1))) {
            j += 2;
            while (j < to && /[0-9A-Fa-f_]/.test(src.charAt(j))) j++;
            if (src.charAt(j) === "n") j++;
            return j;
        }
        while (j < to && /[0-9_]/.test(src.charAt(j))) j++;
        if (src.charAt(j) === "." && j + 1 < to && /[0-9]/.test(src.charAt(j + 1))) {
            j++;
            while (j < to && /[0-9_]/.test(src.charAt(j))) j++;
        }
        if (j < to && /[eE]/.test(src.charAt(j))) {
            var k = j + 1;
            if (src.charAt(k) === "+" || src.charAt(k) === "-") k++;
            if (k < to && /[0-9]/.test(src.charAt(k))) {
                j = k + 1;
                while (j < to && /[0-9_]/.test(src.charAt(j))) j++;
            }
        } else if (src.charAt(j) === "n") j++;
        return j;
    }

    function renameIdents(src, from, to, name, nextName, expr) {
        var out = "";
        var i = from;
        var prev = "";
        var stack = [expr ? "expr" : "stmt"];

        function openBrace() {
            var kind = !prev && stack[stack.length - 1] === "expr" ? "obj" : braceKind(prev);
            stack.push(kind);
            prev = "{";
        }

        while (i < to) {
            var c = src.charAt(i);
            if (c === " " || c === "\t" || c === "\n" || c === "\r") { out += c; i++; continue; }
            if (c === "/" && src.charAt(i + 1) === "/") {
                var nl = src.indexOf("\n", i);
                if (nl < 0 || nl >= to) { out += src.slice(i, to); break; }
                out += src.slice(i, nl + 1);
                i = nl + 1;
                prev = "\n";
                continue;
            }
            if (c === "/" && src.charAt(i + 1) === "*") {
                var end = src.indexOf("*/", i + 2);
                if (end < 0 || end >= to) { out += src.slice(i, to); break; }
                out += src.slice(i, end + 2);
                i = end + 2;
                prev = "/";
                continue;
            }
            if (c === '"' || c === "'") {
                var j = i + 1;
                while (j < to) {
                    if (src.charAt(j) === "\\") { j += 2; continue; }
                    if (src.charAt(j) === c) { j++; break; }
                    j++;
                }
                out += src.slice(i, j);
                prev = c;
                i = j;
                continue;
            }
            if (c === "`") {
                out += "`";
                i++;
                while (i < to) {
                    if (src.charAt(i) === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
                    if (src.charAt(i) === "`") { out += "`"; i++; break; }
                    if (src.charAt(i) === "$" && src.charAt(i + 1) === "{") {
                        var innerStart = i + 2;
                        var innerEnd = findBlockEnd(src, i + 1);
                        if (innerEnd < 0 || innerEnd > to) { out += src.slice(i, to); i = to; break; }
                        var renamedInner = renameIdents(src, innerStart, innerEnd, name, nextName, true);
                        var innerLen = innerEnd - innerStart + (renamedInner.length - src.length);
                        out += "${" + renamedInner.slice(innerStart, innerStart + innerLen) + "}";
                        i = innerEnd + 1;
                        continue;
                    }
                    out += src.charAt(i);
                    i++;
                }
                prev = "`";
                continue;
            }
            if (c === "/" && startsRegex(prev)) {
                var rx = readRegexAt(src, i);
                if (rx && rx.end <= to) {
                    out += src.slice(i, rx.end);
                    i = rx.end;
                    prev = ")";
                    continue;
                }
            }
            if (c === "{") { out += c; i++; openBrace(); continue; }
            if (c === "}") {
                out += c;
                i++;
                if (stack.length > 1) stack.pop();
                prev = "}";
                continue;
            }
            if (c === "(") { out += c; i++; stack.push("paren"); prev = "("; continue; }
            if (c === ")") {
                out += c;
                i++;
                if (stack.length > 1) stack.pop();
                prev = ")";
                continue;
            }
            if (c === "[") { out += c; i++; stack.push("bracket"); prev = "["; continue; }
            if (c === "]") {
                out += c;
                i++;
                if (stack.length > 1) stack.pop();
                prev = "]";
                continue;
            }
            if (c === "=" && src.charAt(i + 1) === ">") { out += "=>"; i += 2; prev = "=>"; continue; }
            if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src.charAt(i + 1) || ""))) {
                var nj = readNumber(src, i, to);
                out += src.slice(i, nj);
                prev = src.charAt(nj - 1);
                i = nj;
                continue;
            }
            if (/[A-Za-z_$]/.test(c)) {
                var k = i + 1;
                while (k < to && /[A-Za-z0-9_$]/.test(src.charAt(k))) k++;
                var word = src.slice(i, k);
                var after = "";
                var a = k;
                while (a < to && /\s/.test(src.charAt(a))) a++;
                if (a < to) after = src.charAt(a);
                if (word === name && !isMemberDot(src, i) && !/[0-9]/.test(src.charAt(i - 1) || "")) {
                    var top = stack[stack.length - 1];
                    var method = top === "obj" && after === "(" &&
                        (prev === "{" || prev === "," || prev === "get" || prev === "set" || prev === "async");
                    if (after === ":" || method) out += word;
                    else if (top === "obj" && (prev === "{" || prev === ",") && (after === "," || after === "}")) out += word + ":" + nextName;
                    else out += nextName;
                } else out += word;
                prev = word;
                i = k;
                continue;
            }
            out += c;
            prev = c;
            i++;
        }
        return src.slice(0, from) + out + src.slice(to);
    }

    function fixCalleeParamConflicts(code) {
        var re = /\b(async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*\(/g;
        var jobs = [];
        var match;
        while ((match = re.exec(code))) {
            var callee = match[2];
            var open = match.index + match[0].length - 1;
            var close = findParenEnd(code, open);
            if (close === -1) continue;
            var params = code.slice(open + 1, close);
            if (!paramConflicts(callee, params)) continue;
            var span = paramNameSpan(params, callee);
            if (!span) continue;
            var brace = close + 1;
            while (code.charAt(brace) === " " || code.charAt(brace) === "\n") brace++;
            if (code.charAt(brace) !== "{") continue;
            var end = findBlockEnd(code, brace);
            if (end === -1) continue;
            jobs.push({
                paramStart: open + 1 + span.start,
                paramEnd: open + 1 + span.end,
                bodyStart: brace + 1,
                bodyEnd: end,
                callee: callee
            });
        }
        var result = code;
        var r;
        for (r = jobs.length - 1; r >= 0; r--) {
            var job = jobs[r];
            var nextName = job.callee + "_";
            result = renameIdents(result, job.bodyStart, job.bodyEnd, job.callee, nextName);
            result = result.slice(0, job.paramStart) + nextName + result.slice(job.paramEnd);
        }
        return result;
    }

    window.__pfMaskJs = function (src) {
        return lex(src, true);
    };

    window.__pfFixLegacySyntax = function (src) {
        if (!src) return src;
        var out = src.indexOf("(?<") === -1 ? src : lex(src, false);
        return fixCalleeParamConflicts(out);
    };
})();
