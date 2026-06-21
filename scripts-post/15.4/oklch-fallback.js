// GPT-5 - OKLCH -> RGB fallback for browsers without oklch() support
(function polyfillOKLCHFallback() {
    // --- Debug helpers ---
    const DEBUG = false;
    const LOG_PREFIX = "[oklch-fallback]";
    let __logCount = 0;
    const MAX_LOGS = 400;
    function dbg(...args) {
        if (!DEBUG) return;
        if (__logCount++ > MAX_LOGS) return;
        try {
            console.debug(LOG_PREFIX, ...args);
        } catch (_) {}
    }
    const stats = {
        started: Date.now(),
        nativeSupported: null,
        styleSheets: 0,
        sheetsChanged: 0,
        sheetsFetched: 0,
        styleTagsProcessed: 0,
        inlineStyleAttrsProcessed: 0,
        textReplacements: 0,
        rulesIndexed: 0,
        rulesApplied: 0,
        observerEvents: 0,
        errors: 0,
    };
    const REPROCESS_COOLDOWN_MS = 600;
    let lastFullProcessAt = 0;
    let fullProcessScheduled = false;
    let hasPerformedInlineStyleScan = false;
    let hasPerformedElementFallbackPass = false;

    if (window.__oklchFallbackApplied) return;
    window.__oklchFallbackApplied = true;

    // ---------- OKLCH parsing and conversion ----------
    function parseNumberWithUnit(token) {
        // returns { value: number, unit: string }
        const m = String(token)
            .trim()
            .match(/^([+-]?(?:\d+\.\d+|\d*\.\d+|\d+))(.*)$/);
        if (!m) return null;
        return { value: parseFloat(m[1]), unit: (m[2] || "").trim() };
    }

    function hueToDeg(h, unit) {
        if (!isFinite(h)) return NaN;
        switch ((unit || "deg").toLowerCase()) {
            case "deg":
            case "":
                return h;
            case "grad":
                return h * 0.9; // 400grad = 360deg
            case "rad":
                return h * (180 / Math.PI);
            case "turn":
                return h * 360;
            default:
                return h; // assume degrees
        }
    }

    function clamp01(x) {
        return x < 0 ? 0 : x > 1 ? 1 : x;
    }

    function linearToSRGB(x) {
        // gamma companding
        return x <= 0.0031308
            ? 12.92 * x
            : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    }

    function oklchToSRGB(Lp, C, Hdeg) {
        // Convert OKLCH to sRGB (gamma-encoded), returns [R,G,B] in 0..1
        const hrad = ((Hdeg % 360) * Math.PI) / 180;
        const a = C * Math.cos(hrad);
        const b = C * Math.sin(hrad);

        const L = Lp; // already 0..1
        // oklab -> LMS^3 per Björn Ottosson
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.291485548 * b;

        const l = l_ * l_ * l_;
        const m = m_ * m_ * m_;
        const s = s_ * s_ * s_;

        let r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
        let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
        let b2 = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

        r = linearToSRGB(r);
        g = linearToSRGB(g);
        b2 = linearToSRGB(b2);

        return [clamp01(r), clamp01(g), clamp01(b2)];
    }

    function toRGBString(r01, g01, b01, a) {
        const R = Math.round(r01 * 255);
        const G = Math.round(g01 * 255);
        const B = Math.round(b01 * 255);
        if (a == null || !(a >= 0) || a >= 1 || a === undefined) {
            return `rgb(${R}, ${G}, ${B})`;
        }
        const A = typeof a === "string" ? a : Math.max(0, Math.min(1, a)) + "";
        return `rgba(${R}, ${G}, ${B}, ${A})`;
    }

    function tryParseOKLCHArgs(argText) {
        // Accepts formats like: "L% C H[deg|rad|grad|turn] / A"; numbers can be decimals
        // Return { L01, C, Hdeg, alpha } or null when dynamic (var()/calc()) or invalid
        const txt = argText.trim();
        if (/var\(|calc\(|env\(/i.test(txt)) {
            return null;
        } // dynamic, skip

        // Split by "/" for alpha
        const parts = txt.split("/");
        const main = parts[0].trim();
        const alphaRaw = parts[1] ? parts[1].trim() : null;

        const tokens = main.split(/[\s,]+/).filter(Boolean);
        if (tokens.length < 3) {
            return null;
        }

        const Lp = parseNumberWithUnit(tokens[0]);
        const C = parseNumberWithUnit(tokens[1]);
        const H = parseNumberWithUnit(tokens[2]);
        if (!Lp || !isFinite(Lp.value)) {
            return null;
        }
        if (!C || !isFinite(C.value)) {
            return null;
        }
        if (!H || !isFinite(H.value)) {
            return null;
        }

        const L01 =
            Lp.unit === "%" || Lp.unit === ""
                ? Lp.unit === "%"
                    ? Lp.value / 100
                    : Lp.value
                : NaN;
        if (!isFinite(L01)) {
            return null;
        }
        const Cval = C.value; // unitless
        const Hdeg = hueToDeg(H.value, H.unit);
        if (!isFinite(Hdeg)) {
            return null;
        }

        let alpha = null;
        if (alphaRaw != null) {
            const a = parseNumberWithUnit(alphaRaw);
            if (a) {
                alpha = a.unit === "%" ? a.value / 100 : a.value;
            }
        }

        return { L01: L01, C: Cval, Hdeg, alpha };
    }

    function replaceOKLCHInText(input) {
        if (!input || typeof input !== "string") return input;
        let i = 0;
        let out = "";
        while (i < input.length) {
            const idx = input.toLowerCase().indexOf("oklch(", i);
            if (idx === -1) {
                out += input.slice(i);
                break;
            }
            out += input.slice(i, idx);
            // Find matching ')' with nesting awareness
            let j = idx + 6; // after 'oklch('
            let depth = 1;
            while (j < input.length && depth > 0) {
                const ch = input[j];
                if (ch === "(") depth++;
                else if (ch === ")") depth--;
                j++;
            }
            const inside = input.slice(idx + 6, j - 1);
            const parsed = tryParseOKLCHArgs(inside);
            if (parsed) {
                stats.textReplacements++;
                const { L01, C, Hdeg, alpha } = parsed;
                const [r, g, b] = oklchToSRGB(L01, C, Hdeg);
                const rgb = toRGBString(r, g, b, alpha);
                out += rgb;
            } else {
                // leave as-is when we cannot compute
                out += input.slice(idx, j);
            }
            i = j;
        }
        return out;
    }

    // ---------- Generic dynamic fallback: evaluate oklch(var/calc/clamp) per element ----------
    // This builds an index of same-origin CSS rules that set oklch(...) on color-related properties,
    // matches them against elements, resolves var()/calc()/clamp() using getComputedStyle(el),
    // computes sRGB, then applies the result inline to emulate support.

    // Properties we handle
    const COLOR_PROPS = [
        "color",
        "background-color",
        "background",
        "outline-color",
        "outline",
        "text-decoration-color",
        "text-decoration",
        "border-color",
        "border-top-color",
        "border-right-color",
        "border-bottom-color",
        "border-left-color",
        "border",
        "border-top",
        "border-right",
        "border-bottom",
        "border-left",
        "column-rule-color",
        "caret-color",
        "fill",
        "stroke",
    ];

    function stripOuter(str, head, tail) {
        const s = str.trim();
        if (s.toLowerCase().startsWith(head) && s.endsWith(tail)) {
            return s.slice(head.length, -tail.length);
        }
        return str;
    }

    function splitTopLevelArgs(s) {
        // Split by spaces or commas at depth 0
        const out = [];
        let buf = "";
        let depth = 0;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === "(") {
                depth++;
                buf += ch;
                continue;
            }
            if (ch === ")") {
                depth = Math.max(0, depth - 1);
                buf += ch;
                continue;
            }
            if ((ch === "," || /\s/.test(ch)) && depth === 0) {
                if (buf.trim()) out.push(buf.trim());
                buf = "";
                continue;
            }
            buf += ch;
        }
        if (buf.trim()) out.push(buf.trim());
        return out;
    }

    function resolveVar(el, chunk, localVars) {
        // var(--name[, fallback])
        const m = chunk.match(/^var\(\s*([^,\s)]+)\s*(?:,\s*(.*))?\)$/i);
        if (!m) return null;
        const name = m[1];
        const fallback = m[2];
        let val = "";
        if (
            localVars &&
            Object.prototype.hasOwnProperty.call(localVars, name)
        ) {
            val = String(localVars[name] || "").trim();
        }
        if (!val) {
            try {
                val = getComputedStyle(el).getPropertyValue(name) || "";
            } catch (_) {
                val = "";
            }
            val = String(val).trim();
        }
        val = String(val).trim();
        if (!val && fallback != null) return String(fallback).trim();
        // Provide sane numeric defaults when missing
        if (!val) {
            const lname = name.toLowerCase();
            if (/(^|-)opacity$/.test(lname)) return "1";
            if (/infinite/.test(lname)) return "1000000";
            if (/(^|-)offset$/.test(lname)) return "0";
            return "0";
        }
        return val || null;
    }

    function resolveVarsRecursive(el, s, depth = 0, localVars) {
        if (depth > 5) return s; // avoid cycles
        let out = s;
        const re = /var\(([^()]*?(?:\((?:[^()]+|\([^()]*\))*\)[^()]*)*)\)/gi; // rough var() matcher
        let m;
        while ((m = re.exec(out))) {
            const full = m[0];
            const inner = full;
            const val = resolveVar(el, inner, localVars) || "";
            out = out.replace(full, val);
            re.lastIndex = 0; // restart
        }
        return /var\(/i.test(out)
            ? resolveVarsRecursive(el, out, depth + 1, localVars)
            : out;
    }

    function evalArithmetic(expr) {
        // Safe parser for numbers with + - * / and parentheses; supports e/E exponents
        const s = expr.replace(/\s+/g, "");
        let i = 0;
        function peek() {
            return s[i];
        }
        function consume() {
            return s[i++];
        }
        function parseNumber() {
            const start = i;
            if (s[i] === "+" || s[i] === "-") i++;
            while (/[0-9]/.test(s[i])) i++;
            if (s[i] === ".") {
                i++;
                while (/[0-9]/.test(s[i])) i++;
            }
            if (s[i] === "e" || s[i] === "E") {
                i++;
                if (s[i] === "+" || s[i] === "-") i++;
                while (/[0-9]/.test(s[i])) i++;
            }
            const str = s.slice(start, i);
            const v = parseFloat(str);
            return isFinite(v) ? v : NaN;
        }
        function parseFactor() {
            if (peek() === "(") {
                consume();
                const v = parseExpr();
                if (peek() === ")") consume();
                return v;
            }
            return parseNumber();
        }
        function parseTerm() {
            let v = parseFactor();
            while (true) {
                const op = peek();
                if (op === "*" || op === "/") {
                    consume();
                    const rhs = parseFactor();
                    if (!isFinite(v) || !isFinite(rhs)) return NaN;
                    v = op === "*" ? v * rhs : v / rhs;
                } else break;
            }
            return v;
        }
        function parseExpr() {
            let v = parseTerm();
            while (true) {
                const op = peek();
                if (op === "+" || op === "-") {
                    consume();
                    const rhs = parseTerm();
                    if (!isFinite(v) || !isFinite(rhs)) return NaN;
                    v = op === "+" ? v + rhs : v - rhs;
                } else break;
            }
            return v;
        }
        const out = parseExpr();
        return isFinite(out) ? out : NaN;
    }

    function evalNumeric(el, token, kind, localVars) {
        // kind: 'L' | 'C' | 'H' | 'A'
        let s = String(token).trim();
        if (!s) return NaN;
        // Resolve nested calc()/clamp() and var()
        s = resolveVarsRecursive(el, s, 0, localVars);

        function parseUnitNum(t) {
            const u = parseNumberWithUnit(t);
            if (!u) return { val: NaN };
            return { val: u.value, unit: (u.unit || "").toLowerCase() };
        }

        // clamp(min, val, max)
        if (/^clamp\(/i.test(s)) {
            const inner = stripOuter(s, "clamp(", ")");
            const parts = [];
            let depth = 0,
                start = 0;
            for (let i = 0; i < inner.length; i++) {
                const ch = inner[i];
                if (ch === "(") depth++;
                else if (ch === ")") depth--;
                else if (ch === "," && depth === 0) {
                    parts.push(inner.slice(start, i));
                    start = i + 1;
                }
            }
            parts.push(inner.slice(start));
            if (parts.length === 3) {
                const minv = evalNumeric(el, parts[0], kind, localVars);
                const midv = evalNumeric(el, parts[1], kind, localVars);
                const maxv = evalNumeric(el, parts[2], kind, localVars);
                if ([minv, midv, maxv].every(isFinite))
                    return clamp(midv, minv, maxv);
            }
            return NaN;
        }

        // calc(...)
        if (/^calc\(/i.test(s)) {
            const inner = stripOuter(s, "calc(", ")");
            // Replace unit-bearing numbers into unitless based on kind
            const mapped = inner.replace(
                /([+-]?(?:\d+\.\d+|\d*\.\d+|\d+))(deg|rad|turn|%|[a-zA-Z]+)?/g,
                (_, num, unit) => {
                    const v = parseFloat(num);
                    const u = (unit || "").toLowerCase();
                    if (!unit || u === "") return String(v);
                    if (kind === "L" || kind === "A") {
                        if (u === "%") return String(v / 100);
                        return String(v); // assume already 0..1
                    }
                    if (kind === "H") {
                        if (u === "deg" || u === "") return String(v);
                        if (u === "rad") return String(v * (180 / Math.PI));
                        if (u === "turn") return String(v * 360);
                        if (u === "grad") return String(v * 0.9);
                        return String(v);
                    }
                    // C: treat percent as fraction if given
                    if (kind === "C") {
                        if (u === "%") return String(v / 100);
                        return String(v);
                    }
                    return String(v);
                }
            );
            return evalArithmetic(mapped);
        }

        // plain number with unit
        const pn = parseUnitNum(s);
        if (!isFinite(pn.val)) return NaN;
        if (kind === "L" || kind === "A") {
            return pn.unit === "%" ? pn.val / 100 : pn.val;
        }
        if (kind === "H") {
            return hueToDeg(pn.val, pn.unit);
        }
        // C
        if (pn.unit === "%") return pn.val / 100;
        return pn.val;
    }

    function parseOKLCHCall(text) {
        const lower = text.toLowerCase();
        const idx = lower.indexOf("oklch(");
        if (idx < 0) return null;
        let j = idx + 6,
            depth = 1;
        while (j < text.length && depth > 0) {
            const ch = text[j];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            j++;
        }
        const inside = text.slice(idx + 6, j - 1);
        return inside;
    }

    function computeOKLCHForElement(el, valueText, localVars) {
        const inner = parseOKLCHCall(valueText);
        if (!inner) return null;
        // Split alpha
        const slash = inner.lastIndexOf("/");
        let main = (slash !== -1 ? inner.slice(0, slash) : inner).trim();
        let alphaRaw = slash !== -1 ? inner.slice(slash + 1).trim() : null;
        // Resolve var() early so that var(--xyz) that expands to "L C H" tokenizes correctly
        try {
            main = resolveVarsRecursive(el, main, 0, localVars);
        } catch (_) {}
        try {
            if (alphaRaw)
                alphaRaw = resolveVarsRecursive(el, alphaRaw, 0, localVars);
        } catch (_) {}
        let tokens = splitTopLevelArgs(main);
        if (tokens.length < 3) {
            // If still not enough tokens, bail
            return null;
        }
        // Only use first three tokens for L C H
        const L = evalNumeric(el, tokens[0], "L", localVars);
        const C = evalNumeric(el, tokens[1], "C", localVars);
        const H = evalNumeric(el, tokens[2], "H", localVars);
        if (![L, C, H].every(isFinite)) {
            if (__logCount < MAX_LOGS)
                dbg(
                    "Failed to eval OKLCH for",
                    el,
                    "tokens=",
                    tokens,
                    "resolved main=",
                    main
                );
            return null;
        }
        const L01 = clamp(L, 0, 1);
        let A = 1;
        if (alphaRaw) {
            const a = evalNumeric(el, alphaRaw, "A", localVars);
            if (isFinite(a)) A = clamp(a, 0, 1);
        }
        const [r, g, b] = oklchToSRGB(L01, C, H);
        return toRGBString(r, g, b, A);
    }

    function computeSpecificity(selector) {
        // Very rough specificity calculator
        const s = selector.replace(/:not\(([^)]*)\)/g, "$1");
        const a = (s.match(/#[\w-]+/g) || []).length; // IDs
        const b =
            (s.match(/\.[\w-]+/g) || []).length +
            (s.match(/\[[^\]]+\]/g) || []).length +
            (s.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length; // classes, attrs, pseudo-class
        const c = (
            s.replace(/::[\w-]+/g, "").match(/\b[a-zA-Z][\w-]*\b/g) || []
        ).length; // elements
        return [a, b, c];
    }

    function compareSpec(a, b) {
        for (let i = 0; i < 3; i++) {
            if (a[i] !== b[i]) return a[i] - b[i];
        }
        return 0;
    }

    let OKLCH_RULE_INDEX = [];

    function collectOKLCHRules() {
        OKLCH_RULE_INDEX = [];
        const sheets = Array.from(document.styleSheets);
        for (let si = 0; si < sheets.length; si++) {
            const sheet = sheets[si];
            let rules;
            try {
                rules = sheet.cssRules;
            } catch (e) {
                dbg("collect: blocked cssRules for", sheet.href || "[inline]");
                continue;
            }
            if (!rules) continue;
            let order = 0;
            const walk = (list) => {
                for (let i = 0; i < list.length; i++) {
                    const r = list[i];
                    try {
                        // Grouping rule with children
                        if (r && r.cssRules && r.cssRules.length) {
                            walk(r.cssRules);
                            continue;
                        }
                    } catch (_) {}
                    if (!r || !r.selectorText || !r.style) continue;
                    // Capture rule-local custom properties for resolving var() (e.g., --tw-* set in same rule)
                    const localVars = {};
                    try {
                        for (let k = 0; k < r.style.length; k++) {
                            const pn = r.style[k];
                            if (pn && pn.startsWith("--")) {
                                localVars[pn] = r.style.getPropertyValue(pn);
                            }
                        }
                    } catch (_) {}
                    for (const prop of COLOR_PROPS) {
                        let val = "";
                        try {
                            val = r.style.getPropertyValue(prop) || "";
                        } catch (_) {
                            val = "";
                        }
                        if (val && /oklch\(/i.test(val)) {
                            OKLCH_RULE_INDEX.push({
                                selector: r.selectorText,
                                prop,
                                val,
                                important:
                                    r.style.getPropertyPriority(prop) ===
                                    "important",
                                si,
                                oi: order++,
                                spec: computeSpecificity(r.selectorText),
                                localVars,
                            });
                        }
                    }
                }
            };
            walk(rules);
        }
        stats.rulesIndexed = OKLCH_RULE_INDEX.length;
        dbg("Indexed OKLCH rules:", OKLCH_RULE_INDEX.length);
        if (OKLCH_RULE_INDEX.length) {
            const sampleCt = Math.min(3, OKLCH_RULE_INDEX.length);
            for (let i = 0; i < sampleCt; i++) {
                const e = OKLCH_RULE_INDEX[i];
                dbg(
                    "Rule",
                    i + 1 + "/",
                    sampleCt,
                    "selector=",
                    e.selector,
                    "prop=",
                    e.prop,
                    "val=",
                    e.val
                );
            }
        }
    }

    function mapPropToInline(prop) {
        switch (prop) {
            case "background":
                return "background-color";
            case "border":
                return "border-color";
            case "border-top":
                return "border-top-color";
            case "border-right":
                return "border-right-color";
            case "border-bottom":
                return "border-bottom-color";
            case "border-left":
                return "border-left-color";
            case "outline":
                return "outline-color";
            case "text-decoration":
                return "text-decoration-color";
            default:
                return prop;
        }
    }

    function applyIndexedRules() {
        if (!OKLCH_RULE_INDEX.length) return;
        // For each element, pick the winning declaration per property
        const all = document.querySelectorAll("*");
        for (const el of all) {
            for (const prop of COLOR_PROPS) {
                let winner = null;
                for (const entry of OKLCH_RULE_INDEX) {
                    if (entry.prop !== prop) continue;
                    try {
                        if (!el.matches(entry.selector)) continue;
                    } catch (_) {
                        continue;
                    }
                    if (!winner) {
                        winner = entry;
                        continue;
                    }
                    // Compare importance, specificity, then order (later wins)
                    if (entry.important !== winner.important) {
                        winner = entry.important ? entry : winner;
                        continue;
                    }
                    const cmp = compareSpec(entry.spec, winner.spec);
                    if (cmp > 0) {
                        winner = entry;
                        continue;
                    }
                    if (cmp === 0) {
                        if (
                            entry.si > winner.si ||
                            (entry.si === winner.si &&
                                (entry.oi || 0) > (winner.oi || 0))
                        )
                            winner = entry;
                    }
                }
                if (winner) {
                    const rgb = computeOKLCHForElement(
                        el,
                        winner.val,
                        winner.localVars
                    );
                    if (rgb) {
                        const targetProp = mapPropToInline(prop);
                        try {
                            el.style.setProperty(
                                targetProp,
                                rgb,
                                winner.important ? "important" : ""
                            );
                            stats.rulesApplied++;
                            if (stats.rulesApplied <= 50)
                                dbg(
                                    "Applied",
                                    targetProp,
                                    "to",
                                    el,
                                    "from",
                                    winner.selector,
                                    "=>",
                                    rgb
                                );
                        } catch (e) {
                            stats.errors++;
                            dbg("Failed set", targetProp, "on", el, e);
                        }
                    }
                }
            }
        }
    }

    function applyElementFallbacks() {
        collectOKLCHRules();
        applyIndexedRules();
    }

    // --- Selector expansion and query fallback ---
    function splitTopLevelCommas(s) {
        const parts = [];
        let depth = 0,
            start = 0;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            else if (ch === "," && depth === 0) {
                parts.push(s.slice(start, i));
                start = i + 1;
            }
        }
        parts.push(s.slice(start));
        return parts.map((x) => x.trim()).filter(Boolean);
    }

    function explodePseudoOnce(sel, name) {
        const needle = ":" + name + "(";
        const idx = sel.indexOf(needle);
        if (idx === -1) return null;
        let j = idx + needle.length,
            depth = 1;
        while (j < sel.length && depth > 0) {
            const ch = sel[j];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            j++;
        }
        const before = sel.slice(0, idx);
        const inside = sel.slice(idx + needle.length, j - 1);
        const after = sel.slice(j);
        const options = splitTopLevelCommas(inside);
        return options.map((opt) => (before + opt + after).trim());
    }

    function explodeSelectorFunctions(sel) {
        // Expand :is() and :where() into multiple candidates recursively
        const queue = [sel];
        const out = new Set();
        while (queue.length) {
            const cur = queue.pop();
            const isExp = explodePseudoOnce(cur, "is");
            if (isExp) {
                isExp.forEach((s) => queue.push(s));
                continue;
            }
            const whereExp = explodePseudoOnce(cur, "where");
            if (whereExp) {
                whereExp.forEach((s) => queue.push(s));
                continue;
            }
            // crude :has() removal for old engines: replace with '*' to avoid SyntaxError
            const sanitized = cur.replace(
                /:has\((?:[^()]+|\([^()]*\))*\)/g,
                "*"
            );
            out.add(sanitized);
        }
        return Array.from(out);
    }

    function applyIndexedRulesByQuery() {
        if (!OKLCH_RULE_INDEX.length) return;
        // Sort entries by sheet order
        const entries = OKLCH_RULE_INDEX.slice().sort(
            (a, b) => a.si - b.si || (a.oi || 0) - (b.oi || 0)
        );
        let applied = 0,
            errors = 0;
        for (const entry of entries) {
            const cands = explodeSelectorFunctions(entry.selector);
            let nodes = [];
            for (const cand of cands) {
                try {
                    const list = document.querySelectorAll(cand);
                    if (list && list.length) nodes.push(...list);
                } catch (e) {
                    // skip invalid candidate
                }
            }
            if (!nodes.length) continue;
            // Deduplicate nodes
            const seen = new Set();
            nodes = nodes.filter((n) => {
                if (seen.has(n)) return false;
                seen.add(n);
                return true;
            });
            for (const el of nodes) {
                const rgb = computeOKLCHForElement(
                    el,
                    entry.val,
                    entry.localVars
                );
                if (!rgb) continue;
                try {
                    // Preserve existing inline !important when present
                    const targetProp = mapPropToInline(entry.prop);
                    const existingImportant =
                        el.style.getPropertyPriority(targetProp) ===
                        "important";
                    const prio =
                        entry.important || existingImportant ? "important" : "";
                    el.style.setProperty(targetProp, rgb, prio);
                    applied++;
                    if (applied <= 50)
                        dbg(
                            "Applied (query)",
                            targetProp,
                            "to",
                            el,
                            "from",
                            entry.selector,
                            "=>",
                            rgb
                        );
                } catch (e) {
                    errors++;
                }
            }
        }
        stats.rulesApplied += applied;
        if (applied === 0) dbg("applyIndexedRulesByQuery applied none");
        else dbg("applyIndexedRulesByQuery applied", applied);
    }

    // Fallback when cssRules are inaccessible: scan computed styles for oklch(...) and resolve per element
    function applyComputedStyleFallbacks() {
        const all = document.querySelectorAll("*");
        dbg("Computed-style fallback scanning elements:", all.length);
        let hits = 0;
        for (const el of all) {
            let cs;
            try {
                cs = getComputedStyle(el);
            } catch (_) {
                continue;
            }
            for (const prop of COLOR_PROPS) {
                let val = "";
                try {
                    val = cs.getPropertyValue(prop) || "";
                } catch (_) {
                    val = "";
                }
                if (val && /oklch\(/i.test(val)) {
                    hits++;
                    const rgb = computeOKLCHForElement(el, val);
                    if (rgb) {
                        const targetProp = mapPropToInline(prop);
                        try {
                            el.style.setProperty(targetProp, rgb, "");
                            stats.rulesApplied++;
                            if (stats.rulesApplied <= 50)
                                dbg(
                                    "Applied (computed)",
                                    targetProp,
                                    "to",
                                    el,
                                    "=>",
                                    rgb
                                );
                        } catch (e) {
                            stats.errors++;
                            dbg(
                                "Failed to set computed fallback",
                                targetProp,
                                "on",
                                el,
                                e
                            );
                        }
                    }
                }
            }
        }
        dbg(
            "Computed-style fallback hits:",
            hits,
            "applied:",
            stats.rulesApplied
        );
    }

    // ---------- CSSOM traversal & mutation ----------
    const RULE = {
        STYLE: 1,
        MEDIA: 4,
        FONT_FACE: 5,
        PAGE: 6,
        KEYFRAMES: 7,
        SUPPORTS: 12,
    };

    function processStyleDeclaration(style) {
        if (!style) return false;
        let changed = false;
        for (let k = 0; k < style.length; k++) {
            const prop = style[k];
            const val = style.getPropertyValue(prop);
            if (val && val.toLowerCase().includes("oklch(")) {
                const priority = style.getPropertyPriority(prop);
                const newVal = replaceOKLCHInText(val);
                if (newVal !== val) {
                    try {
                        style.setProperty(prop, newVal, priority);
                        changed = true;
                    } catch (_) {
                        // ignore
                    }
                }
            }
        }
        return changed;
    }

    function traverseAndFixRules(rules) {
        if (!rules) return false;
        let anyChanged = false;
        for (const rule of Array.from(rules)) {
            const ctor = rule && rule.constructor && rule.constructor.name;
            if (rule.type === RULE.STYLE || ctor === "CSSStyleRule") {
                anyChanged = processStyleDeclaration(rule.style) || anyChanged;
            } else if (
                rule.type === RULE.KEYFRAMES ||
                ctor === "CSSKeyframesRule" ||
                ctor === "WebKitCSSKeyframesRule"
            ) {
                for (const kf of Array.from(rule.cssRules || [])) {
                    const changed = processStyleDeclaration(kf.style);
                    anyChanged = changed || anyChanged;
                }
            } else if (
                rule.type === RULE.FONT_FACE ||
                ctor === "CSSFontFaceRule" ||
                rule.type === RULE.PAGE ||
                ctor === "CSSPageRule"
            ) {
                anyChanged = processStyleDeclaration(rule.style) || anyChanged;
            }

            // Grouping rules
            const childRules = rule.cssRules || null;
            if (childRules)
                anyChanged = traverseAndFixRules(childRules) || anyChanged;
        }
        return anyChanged;
    }

    function getStyleSheetText(sheet) {
        try {
            const rules = Array.from(sheet.cssRules || sheet.rules || []);
            return rules.map((r) => r.cssText).join("\n");
        } catch (_) {
            return null;
        }
    }

    function injectStyle(css, id) {
        if (id) {
            const existing = document.getElementById(id);
            if (existing) return existing;
        }
        const style = document.createElement("style");
        if (id) style.id = id;
        style.textContent = css;
        document.head.appendChild(style);
        return style;
    }

    function processStyleTagNode(styleNode) {
        if (!styleNode || styleNode.__oklchProcessed) return;
        const txt = styleNode.textContent;
        if (txt && /oklch\(/i.test(txt)) {
            const out = replaceOKLCHInText(txt);
            if (out !== txt) {
                styleNode.textContent = out;
                stats.styleTagsProcessed++;
                dbg("Processed <style> tag, replaced OKLCH");
            }
        }
        styleNode.__oklchProcessed = true;
    }

    async function processStyleSheetObject(sheet) {
        try {
            const changed = traverseAndFixRules(sheet.cssRules);
            if (changed) {
                stats.sheetsChanged++;
                dbg(
                    "Edited CSSOM in-place for sheet",
                    sheet.href || "[inline]"
                );
                return true;
            }
        } catch (e) {
            // Access denied: cross-origin; try fetching if possible below
            dbg(
                "Cannot access cssRules for sheet; will try text/fetch path",
                sheet.href || "[inline]",
                e
            );
            stats.errors++;
        }

        // If rules not accessible or no changes (perhaps because declarations are dynamic), try text path
        const cssText = getStyleSheetText(sheet);
        if (cssText && cssText.toLowerCase().includes("oklch(")) {
            const out = replaceOKLCHInText(cssText);
            if (out !== cssText) {
                injectStyle(out);
                dbg(
                    "Injected fallback <style> for sheet text",
                    sheet.href || "[inline]"
                );
                return true;
            }
        }
        return false;
    }

    function hashString(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36);
    }

    async function fetchAndInlineStylesheet(href) {
        // Use shared fetch cache to avoid duplicate requests across polyfills
        const cache = window.__pfFetchCache;
        if (cache && !cache.has(href)) {
            cache.set(href, fetch(href, { mode: "cors" })
                .then(r => r.ok ? r.text() : Promise.reject())
                .catch(e => { dbg("Failed to fetch stylesheet", href, e); stats.errors++; return null; })
            );
        }
        try {
            const text = cache
                ? await cache.get(href)
                : await fetch(href, { mode: "cors" }).then(r => r.ok ? r.text() : Promise.reject());
            if (!text) return false;
            if (!/oklch\(/i.test(text)) return false;
            const out = replaceOKLCHInText(text);
            if (out !== text) {
                const id = "oklch-inline-" + hashString(href);
                injectStyle(out, id);
                stats.sheetsFetched++;
                dbg("Fetched and inlined stylesheet with OKLCH", href);
                return true;
            }
        } catch (e) {
            dbg("Failed to fetch stylesheet", href, e);
            stats.errors++;
        }
        return false;
    }

    async function processAllStyleSheets(options) {
        options = options || {};
        const links = Array.from(
            document.querySelectorAll('link[rel="stylesheet"]')
        );
        const allSheets = Array.from(document.styleSheets);
        stats.styleSheets = allSheets.length;
        dbg("Processing stylesheets:", allSheets.length);
        for (const sheet of allSheets) {
            const href = sheet.href || "";
            // Prefer in-place CSSOM edits when possible
            let handled = await processStyleSheetObject(sheet);
            if (handled) continue;

            // Fallback: fetch same-origin or explicitly CORS-enabled links
            if (href) {
                const abs = (() => {
                    try {
                        return new URL(href, location.href);
                    } catch (_) {
                        return null;
                    }
                })();
                if (
                    abs &&
                    (abs.protocol === "http:" || abs.protocol === "https:")
                ) {
                    await fetchAndInlineStylesheet(abs.href);
                }
            }
        }
        // Inline <style> tags text-based processing (covers cases not represented in CSSOM)
        document.querySelectorAll("style").forEach(processStyleTagNode);

        // Inline style="..." attributes are expensive to scan globally on every pass.
        // Do one full pass, then rely on mutation observer attribute updates.
        if (!hasPerformedInlineStyleScan || options.forceInlineScan) {
            document.querySelectorAll('[style*="oklch("]').forEach((el) => {
                try {
                    const txt = el.getAttribute("style");
                    if (!txt) return;
                    const out = replaceOKLCHInText(txt);
                    if (out !== txt) {
                        el.setAttribute("style", out);
                        stats.inlineStyleAttrsProcessed++;
                    }
                } catch (e) {
                    dbg("Failed processing inline style for element:", el, e);
                }
            });
            hasPerformedInlineStyleScan = true;
        }

        // Per-element fallbacks are the most CPU-heavy part. Run once unless forced.
        if (!hasPerformedElementFallbackPass || options.forceElementFallbacks) {
            const appliedBefore = stats.rulesApplied;
            try {
                applyElementFallbacks();
            } catch (e) {
                dbg("applyElementFallbacks failed", e);
                stats.errors++;
            }
            if (
                !OKLCH_RULE_INDEX.length ||
                stats.rulesApplied === appliedBefore
            ) {
                dbg(
                    "matches()-based path applied none; trying query-based application"
                );
                try {
                    applyIndexedRulesByQuery();
                } catch (e) {
                    dbg("applyIndexedRulesByQuery failed", e);
                    stats.errors++;
                }
            }
            if (
                !OKLCH_RULE_INDEX.length ||
                stats.rulesApplied === appliedBefore
            ) {
                dbg(
                    "No indexable rules or nothing applied; trying computed-style fallback"
                );
                try {
                    applyComputedStyleFallbacks();
                } catch (e) {
                    dbg("applyComputedStyleFallbacks failed", e);
                    stats.errors++;
                }
            }
            hasPerformedElementFallbackPass = true;
        }
        dbg(
            "Pass summary:",
            JSON.stringify({
                styleSheets: stats.styleSheets,
                sheetsChanged: stats.sheetsChanged,
                sheetsFetched: stats.sheetsFetched,
                styleTagsProcessed: stats.styleTagsProcessed,
                inlineStyleAttrsProcessed: stats.inlineStyleAttrsProcessed,
                textReplacements: stats.textReplacements,
                rulesIndexed: stats.rulesIndexed,
                rulesApplied: stats.rulesApplied,
            })
        );
    }

    function queueFullProcess(options) {
        if (fullProcessScheduled) return;
        fullProcessScheduled = true;
        const elapsed = Date.now() - lastFullProcessAt;
        const wait = Math.max(0, REPROCESS_COOLDOWN_MS - elapsed);
        clearTimeout(window.__oklchDebounce);
        window.__oklchDebounce = setTimeout(() => {
            fullProcessScheduled = false;
            lastFullProcessAt = Date.now();
            processAllStyleSheets(options || {});
        }, wait);
    }

    // Intercept Element.prototype.setAttribute to catch inline style writes with oklch() values.
    // This replaces the expensive 'style' attribute MutationObserver (which fired on every
    // inline style mutation across the whole document subtree) with a targeted synchronous hook.
    function setupInlineStyleInterception() {
        const origSetAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            if (name === 'style' && typeof value === 'string' && /oklch\(/i.test(value)) {
                try {
                    const replaced = replaceOKLCHInText(value);
                    if (replaced !== value) {
                        origSetAttribute.call(this, name, replaced);
                        stats.inlineStyleAttrsProcessed++;
                        return;
                    }
                } catch (_) {}
            }
            origSetAttribute.call(this, name, value);
        };
    }

    // Observe dynamic additions/changes via the shared mutation hub.
    // The 'style' attribute path is now handled by setupInlineStyleInterception() instead.
    function setupMutationListener() {
        function handleMutations(mutations) {
            stats.observerEvents += mutations.length;
            let needs = false;
            for (const m of mutations) {
                if (m.type === "childList") {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        if (node.tagName === "STYLE") {
                            processStyleTagNode(node);
                        } else if (
                            node.tagName === "LINK" &&
                            node.rel === "stylesheet"
                        ) {
                            needs = true;
                        } else {
                            const styleNodes =
                                node.querySelectorAll &&
                                node.querySelectorAll("style");
                            if (styleNodes && styleNodes.length) {
                                styleNodes.forEach(processStyleTagNode);
                            }

                            // Scan for elements already carrying inline oklch() styles
                            // in the newly added subtree (e.g. via innerHTML / template cloning).
                            const inlineStyledNodes =
                                node.querySelectorAll &&
                                node.querySelectorAll('[style*="oklch("]');
                            if (inlineStyledNodes && inlineStyledNodes.length) {
                                inlineStyledNodes.forEach((el) => {
                                    try {
                                        const txt = el.getAttribute("style");
                                        const out = replaceOKLCHInText(txt || "");
                                        if (out !== txt) {
                                            el.setAttribute("style", out);
                                            stats.inlineStyleAttrsProcessed++;
                                        }
                                    } catch (_) {}
                                });
                            }

                            const newLinks =
                                node.querySelectorAll &&
                                node.querySelectorAll('link[rel="stylesheet"]');
                            if (newLinks && newLinks.length) needs = true;
                        }
                    }
                } else if (m.type === "attributes") {
                    const t = m.target;
                    // Only href/rel changes on link elements reach here (hub no longer
                    // forwards 'style' attribute mutations — those are handled by the
                    // setAttribute monkeypatch above).
                    if (
                        t.tagName === "LINK" &&
                        t.rel === "stylesheet" &&
                        (m.attributeName === "href" || m.attributeName === "rel")
                    ) {
                        needs = true;
                    }
                }
            }
            if (needs) {
                queueFullProcess();
            }
        }

        if (window.__pfRegisterMutationListener) {
            window.__pfRegisterMutationListener(handleMutations);
        } else {
            // Fallback: own observer if hub is not available
            const observer = new MutationObserver(handleMutations);
            observer.observe(document, {
                childList: true,
                subtree: true,
                attributes: true,
                // No 'style' here — that is handled by the setAttribute monkeypatch
                attributeFilter: ["href", "rel"],
            });
        }
    }

    dbg("OKLCH fallback enabled");
    setupInlineStyleInterception();
    processAllStyleSheets({ forceInlineScan: true, forceElementFallbacks: true });
    setupMutationListener();
})();
