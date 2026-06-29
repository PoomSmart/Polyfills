// OKLCH -> RGB fallback for browsers without oklch() support
(function polyfillOKLCHFallback() {
    var __PF_DEBUG__ = false;
    const LOG_PREFIX = "[oklch-fallback]";
    let __logCount = 0;
    const MAX_LOGS = 400;
    function dbg(...args) {
        if (!__PF_DEBUG__) return;
        if (__logCount++ > MAX_LOGS) return;
        try {
            console.log(LOG_PREFIX, ...args);
        } catch (_) { }
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
    setupThemedCustomPropertyListeners();

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

    function clamp(val, min, max) {
        return val < min ? min : val > max ? max : val;
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
        try {
            val = getComputedStyle(el).getPropertyValue(name) || "";
        } catch (_) {
            val = "";
        }
        val = String(val).trim();
        // Text map is fallback when computed/custom props are not available yet.
        if (
            !val &&
            localVars &&
            Object.prototype.hasOwnProperty.call(localVars, name)
        ) {
            val = String(localVars[name] || "").trim();
        }
        if (!val && fallback != null) return String(fallback).trim();
        // Provide sane numeric defaults when missing
        if (!val) {
            const lname = name.toLowerCase();
            if (/(^|-)opacity/.test(lname) || /--opacity/.test(name)) return "1";
            if (/infinite/.test(lname)) return "1000000";
            if (/(^|-)offset$/.test(lname)) return "0";
            if (/--(oklch|hsl)__/.test(name)) return "0";
            return null;
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
        } catch (_) { }
        try {
            if (alphaRaw)
                alphaRaw = resolveVarsRecursive(el, alphaRaw, 0, localVars);
        } catch (_) { }
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

    function splitTopLevelCommaArgs(s) {
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
            if (ch === "," && depth === 0) {
                if (buf.trim()) out.push(buf.trim());
                buf = "";
                continue;
            }
            buf += ch;
        }
        if (buf.trim()) out.push(buf.trim());
        return out;
    }

    function parseColorFunctionCall(text, fn) {
        const lower = text.toLowerCase();
        const needle = fn + "(";
        const idx = lower.indexOf(needle);
        if (idx < 0) return null;
        let j = idx + needle.length,
            depth = 1;
        while (j < text.length && depth > 0) {
            const ch = text[j];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            j++;
        }
        return text.slice(idx + needle.length, j - 1);
    }

    function hslToSRGB(hDeg, s01, l01) {
        const h = ((hDeg % 360) + 360) % 360;
        const s = clamp(s01, 0, 1);
        const l = clamp(l01, 0, 1);
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;
        let rp = 0,
            gp = 0,
            bp = 0;
        if (h < 60) {
            rp = c;
            gp = x;
        } else if (h < 120) {
            rp = x;
            gp = c;
        } else if (h < 180) {
            gp = c;
            bp = x;
        } else if (h < 240) {
            gp = x;
            bp = c;
        } else if (h < 300) {
            rp = x;
            bp = c;
        } else {
            rp = c;
            bp = x;
        }
        return [rp + m, gp + m, bp + m];
    }

    function computeHSLForElement(el, valueText, localVars) {
        const inner = parseColorFunctionCall(valueText, "hsl");
        if (!inner) return null;
        const parts = splitTopLevelCommaArgs(inner);
        if (parts.length < 3) return null;
        const H = evalNumeric(el, parts[0], "H", localVars);
        const S = evalNumeric(el, parts[1], "L", localVars);
        const L = evalNumeric(el, parts[2], "L", localVars);
        if (![H, S, L].every(isFinite)) return null;
        const [r, g, b] = hslToSRGB(H, S, L);
        return toRGBString(r, g, b, 1);
    }

    function resolveTokenValueToRGB(el, valueText, localVars) {
        const val = String(valueText || "").trim();
        if (!val) return null;
        if (/^oklch\(/i.test(val)) {
            return computeOKLCHForElement(el, val, localVars);
        }
        if (/^hsl\(/i.test(val)) {
            return computeHSLForElement(el, val, localVars);
        }
        return null;
    }

    function sRGBToLinear(c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    function srgbToOKLCHA(r01, g01, b01, a) {
        const rl = sRGBToLinear(r01);
        const gl = sRGBToLinear(g01);
        const bl = sRGBToLinear(b01);
        const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
        const m = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
        const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;
        const l_ = Math.cbrt(l);
        const m_ = Math.cbrt(m);
        const s_ = Math.cbrt(s);
        const L =
            0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
        const aLab = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
        const bLab = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
        const C = Math.sqrt(aLab * aLab + bLab * bLab);
        let H = (Math.atan2(bLab, aLab) * 180) / Math.PI;
        if (H < 0) H += 360;
        return { L: clamp(L, 0, 1), C: C, H: H, A: a == null ? 1 : clamp(a, 0, 1) };
    }

    function parseRGBColorString(s) {
        const t = String(s || "").trim().toLowerCase();
        if (t === "transparent") {
            return { r: 0, g: 0, b: 0, a: 0 };
        }
        if (/^#([0-9a-f]{3,8})$/.test(t)) {
            let hex = t.slice(1);
            if (hex.length === 3) {
                hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            }
            const r = parseInt(hex.slice(0, 2), 16) / 255;
            const g = parseInt(hex.slice(2, 4), 16) / 255;
            const b = parseInt(hex.slice(4, 6), 16) / 255;
            const a =
                hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
            return { r: r, g: g, b: b, a: a };
        }
        let m = t.match(
            /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/
        );
        if (!m) {
            m = t.match(
                /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/
            );
        }
        if (!m) return null;
        let r = +m[1];
        let g = +m[2];
        let b = +m[3];
        const a = m[4] != null ? +m[4] : 1;
        if (r > 1 || g > 1 || b > 1) {
            r /= 255;
            g /= 255;
            b /= 255;
        }
        return { r: r, g: g, b: b, a: a };
    }

    function resolveCustomPropertyColor(el, propName, localVars) {
        let val = "";
        try {
            val = getComputedStyle(el).getPropertyValue(propName) || "";
        } catch (_) {
            val = "";
        }
        val = String(val).trim();
        if (val) {
            const direct = parseRGBColorString(val);
            if (direct) return direct;
            const rgb = resolveTokenValueToRGB(el, val, localVars);
            if (rgb) return parseRGBColorString(rgb);
        }
        const resolvedTokens = window.__pfResolvedColorTokens;
        if (
            resolvedTokens &&
            Object.prototype.hasOwnProperty.call(resolvedTokens, propName)
        ) {
            const fromResolved = parseRGBColorString(resolvedTokens[propName]);
            if (fromResolved) return fromResolved;
        }
        if (
            localVars &&
            Object.prototype.hasOwnProperty.call(localVars, propName)
        ) {
            return resolveColorToRGBA(el, localVars[propName], localVars);
        }
        return null;
    }

    function resolveColorToRGBA(el, expr, localVars) {
        let s = String(expr || "").trim();
        if (!s) return null;

        const varOnly = s.match(/^var\(\s*(--[^,\s)]+)\s*(?:,[^)]*)?\)$/i);
        if (varOnly) {
            const fromProp = resolveCustomPropertyColor(el, varOnly[1], localVars);
            if (fromProp) return fromProp;
        }

        s = resolveVarsRecursive(el, s, 0, localVars);
        if (!s) return null;
        if (/^transparent$/i.test(s)) {
            return { r: 0, g: 0, b: 0, a: 0 };
        }

        const direct = parseRGBColorString(s);
        if (direct) return direct;

        if (/^oklch\(/i.test(s)) {
            const rgb = computeOKLCHForElement(el, s, localVars);
            return rgb ? parseRGBColorString(rgb) : null;
        }
        if (/^hsl\(/i.test(s)) {
            const rgb = computeHSLForElement(el, s, localVars);
            return rgb ? parseRGBColorString(rgb) : null;
        }
        if (/^var\(/i.test(s)) {
            const v = resolveVar(el, s, localVars);
            return v ? resolveColorToRGBA(el, v, localVars) : null;
        }
        return null;
    }

    function resolveColorToOKLCHA(el, expr, localVars) {
        const rgba = resolveColorToRGBA(el, expr, localVars);
        if (!rgba) return null;
        const o = srgbToOKLCHA(rgba.r, rgba.g, rgba.b, rgba.a);
        return o;
    }

    function evalMixPercentage(el, expr, localVars) {
        let s = resolveVarsRecursive(el, String(expr || "").trim(), 0, localVars);
        if (/^calc\(/i.test(s)) {
            const v = evalNumeric(el, s, "A", localVars);
            if (isFinite(v)) return v > 1 ? clamp(v, 0, 100) : clamp(v * 100, 0, 100);
        }
        const pn = parseNumberWithUnit(s);
        if (pn && isFinite(pn.value)) {
            if (pn.unit === "%") return clamp(pn.value, 0, 100);
            return pn.value > 1
                ? clamp(pn.value, 0, 100)
                : clamp(pn.value * 100, 0, 100);
        }
        return 50;
    }

    function splitColorMixOperand(operand, el, localVars) {
        operand = String(operand || "").trim();
        const calcIdx = operand.toLowerCase().lastIndexOf("calc(");
        if (calcIdx > 0) {
            let depth = 0;
            let j = calcIdx;
            for (; j < operand.length; j++) {
                const ch = operand[j];
                if (ch === "(") depth++;
                else if (ch === ")") {
                    depth--;
                    if (depth === 0) {
                        j++;
                        break;
                    }
                }
            }
            return {
                color: operand.slice(0, calcIdx).trim(),
                pct: evalMixPercentage(el, operand.slice(calcIdx, j).trim(), localVars),
            };
        }
        const sp = operand.lastIndexOf(" ");
        if (sp > 0) {
            const tail = operand.slice(sp + 1).trim();
            if (/%$/.test(tail)) {
                return {
                    color: operand.slice(0, sp).trim(),
                    pct: evalMixPercentage(el, tail, localVars),
                };
            }
        }
        return { color: operand, pct: 50 };
    }

    function mixOKLCHA(c1, c2, pct1) {
        const w1 = clamp(pct1, 0, 100) / 100;
        const w2 = 1 - w1;
        let h1 = c1.H;
        let h2 = c2.H;
        if (Math.abs(h2 - h1) > 180) {
            if (h1 < h2) h1 += 360;
            else h2 += 360;
        }
        return {
            L: c1.L * w1 + c2.L * w2,
            C: c1.C * w1 + c2.C * w2,
            H: (((h1 * w1 + h2 * w2) % 360) + 360) % 360,
            A: c1.A * w1 + c2.A * w2,
        };
    }

    function computeColorMixForElement(el, valueText, localVars) {
        const inner = parseColorFunctionCall(valueText, "color-mix");
        if (!inner) return null;
        const parts = splitTopLevelCommaArgs(inner);
        if (parts.length < 3) return null;
        if (!/oklch/i.test(parts[0])) return null;

        const op1 = splitColorMixOperand(parts[1], el, localVars);
        const op2 = splitColorMixOperand(parts[2], el, localVars);
        const op1Color = resolveVarsRecursive(el, op1.color, 0, localVars);
        const op2Color = resolveVarsRecursive(el, op2.color, 0, localVars);

        // Mix toward transparent: treat the percentage operand as alpha.
        if (/^transparent$/i.test(op2Color)) {
            const rgba = resolveColorToRGBA(el, op1.color, localVars);
            if (rgba) {
                const alpha = clamp(op1.pct, 0, 100) / 100;
                return toRGBString(rgba.r, rgba.g, rgba.b, alpha);
            }
        }
        if (/^transparent$/i.test(op1Color)) {
            const rgba = resolveColorToRGBA(el, op2.color, localVars);
            if (rgba) {
                const alpha = clamp(op2.pct, 0, 100) / 100;
                return toRGBString(rgba.r, rgba.g, rgba.b, alpha);
            }
        }

        const c1 = resolveColorToOKLCHA(el, op1.color, localVars);
        const c2 = resolveColorToOKLCHA(el, op2.color, localVars);
        if (!c1 || !c2) return null;

        const pct1 = op2.pct === 50 && op1.pct !== 50 ? op1.pct : op1.pct;
        const mixed = mixOKLCHA(c1, c2, pct1);
        const [r, g, b] = oklchToSRGB(mixed.L, mixed.C, mixed.H);
        return toRGBString(r, g, b, mixed.A);
    }

    function getTokenTextFallback() {
        if (window.__pfTokenTextFallback) return window.__pfTokenTextFallback;
        const map = collectCustomPropertyMapFromLayerText();
        const out = {};
        map.forEach(function (val, name) {
            out[name] = val;
        });
        return out;
    }

    function getColorMixLocalVars() {
        const vars = getTokenTextFallback();
        const resolved = window.__pfResolvedColorTokens;
        if (resolved) {
            Object.keys(resolved).forEach(function (name) {
                vars[name] = resolved[name];
            });
        }
        return vars;
    }

    function replaceColorMixInText(input, el, localVars) {
        if (!input || !/color-mix\s*\(/i.test(input)) return input;
        const ctx = el || document.documentElement;
        const vars = localVars || getColorMixLocalVars();
        let i = 0;
        let out = "";
        while (i < input.length) {
            const idx = input.toLowerCase().indexOf("color-mix(", i);
            if (idx === -1) {
                out += input.slice(i);
                break;
            }
            out += input.slice(i, idx);
            let j = idx + 10;
            let depth = 1;
            while (j < input.length && depth > 0) {
                const ch = input[j];
                if (ch === "(") depth++;
                else if (ch === ")") depth--;
                j++;
            }
            const full = input.slice(idx, j);
            const rgb = computeColorMixForElement(ctx, full, vars);
            if (rgb) {
                stats.textReplacements++;
                out += rgb;
            } else if (window.__pfResolvedColorTokens) {
                dbg("color-mix() unresolved:", full.slice(0, 140));
                out += full;
            } else {
                out += full;
            }
            i = j;
        }
        return out;
    }

    function isPolyfillManagedStyle(node) {
        if (!node || node.tagName !== "STYLE") return true;
        if (node.getAttribute("data-color-mix-polyfill") != null) return true;
        if (node.getAttribute("data-webkit-mask-polyfill") != null) return true;
        if (node.getAttribute("data-webkit-backdrop-polyfill") != null) return true;
        const id = node.id || "";
        if (id.indexOf("css-layers-src-") === 0) return true;
        if (id.indexOf("oklch-") === 0) return true;
        if (id.indexOf("mask-supplement-") === 0) return true;
        if (id.indexOf("backdrop-supplement-") === 0) return true;
        if (id.indexOf("patched-") === 0) return true;
        if (id === "oklch-themed-custom-props") return true;
        if (id === "color-mix-cascade-overrides") return true;
        return false;
    }

    function isRawLayerStyle(node) {
        if (!node || node.getAttribute("data-css-layers-polyfill") != null) {
            return false;
        }
        const txt = node.textContent;
        return !!(txt && /@layer/i.test(txt));
    }

    function patchColorMixInStylesheets() {
        const root = document.documentElement;
        const vars = getColorMixLocalVars();
        const nodes = document.querySelectorAll("style");
        let patched = 0;
        let pending = 0;
        for (let n = 0; n < nodes.length; n++) {
            const node = nodes[n];
            if (isPolyfillManagedStyle(node)) continue;
            if (isRawLayerStyle(node)) continue;
            const txt = node.textContent;
            if (!node.dataset.pfColorMixOrig) {
                if (!txt || !/color-mix\s*\(/i.test(txt)) continue;
                node.dataset.pfColorMixOrig = txt;
            }
            const orig = node.dataset.pfColorMixOrig;
            const out = replaceColorMixInText(orig, root, vars);
            if (out === orig) {
                pending++;
                continue;
            }
            if (out !== node.textContent) {
                node.textContent = out;
                patched++;
                dbg(
                    "Patched color-mix() in stylesheet",
                    node.id || node.getAttribute("data-css-layers-polyfill") || "<style>"
                );
            }
        }
        if (pending > 0 && window.__pfResolvedColorTokens) {
            dbg("color-mix() still pending after token refresh:", pending);
        }
        injectColorMixCascadeOverrides();
        return patched;
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
                    } catch (_) { }
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
                    } catch (_) { }
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
    function resolveOKLCHValueForProp(el, cs, prop) {
        let val = "";
        try {
            val = cs.getPropertyValue(prop) || "";
        } catch (_) {
            val = "";
        }
        if (val && /oklch\(/i.test(val)) return val;

        const varMatch = val.match(/^var\(\s*([^,\s)]+)/i);
        if (varMatch) {
            let customVal = "";
            try {
                customVal = cs.getPropertyValue(varMatch[1].trim()) || "";
            } catch (_) {
                customVal = "";
            }
            if (customVal && /oklch\(/i.test(customVal)) return customVal;
        }
        return "";
    }

    function scanCustomPropertyMapInText(cssText, map) {
        if (!cssText) return;
        let i = 0;
        while (i < cssText.length) {
            if (cssText.charCodeAt(i) !== 45 || cssText.charCodeAt(i + 1) !== 45) {
                i++;
                continue;
            }
            let j = i + 2;
            while (j < cssText.length && /[a-zA-Z0-9_-]/.test(cssText[j])) j++;
            if (cssText.charCodeAt(j) !== 58) {
                i = j;
                continue;
            }
            const name = cssText.slice(i, j);
            j++;
            while (j < cssText.length && /\s/.test(cssText[j])) j++;
            let depth = 0;
            const valStart = j;
            while (j < cssText.length) {
                const ch = cssText[j];
                if (ch === "(") depth++;
                else if (ch === ")") depth = Math.max(0, depth - 1);
                else if ((ch === ";" || ch === "}") && depth === 0) break;
                j++;
            }
            const val = cssText.slice(valStart, j).trim();
            i = j + 1;
            if (val) map.set(name, val);
        }
    }

    function collectCustomPropertyMapFromLayerText() {
        const map = new Map();
        const nodes = document.querySelectorAll(
            "style[data-css-layers-polyfill]"
        );
        for (let n = 0; n < nodes.length; n++) {
            scanCustomPropertyMapInText(nodes[n].textContent, map);
        }
        return map;
    }

    function isPassthroughLayerToken(name) {
        return (
            /^--backdrop-filter/.test(name) ||
            /^--filter-/.test(name) ||
            /^--opacity-/.test(name)
        );
    }

    function collectLayerTextBundle() {
        let text = "";
        const nodes = document.querySelectorAll(
            "style[data-css-layers-polyfill]"
        );
        for (let n = 0; n < nodes.length; n++) {
            text += nodes[n].textContent || "";
        }
        return text;
    }

    function resolvePassthroughLayerToken(name, tokenMap, layerText) {
        let val = tokenMap.get(name);
        if (val) val = String(val).trim();
        if (val && !/^var\(/i.test(val) && !/^none$/i.test(val)) {
            return val;
        }
        if (!layerText) return null;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(escaped + "\\s*:\\s*([^;}{]+)", "g");
        let match;
        let fallback = null;
        while ((match = re.exec(layerText))) {
            const candidate = String(match[1] || "").trim();
            if (!candidate || /^var\(/i.test(candidate)) continue;
            if (/^none$/i.test(candidate)) continue;
            fallback = candidate;
        }
        return fallback;
    }

    function collectPassthroughLayerTokens(tokenMap, layerText, el) {
        const out = new Map();
        tokenMap.forEach(function (val, name) {
            if (!isPassthroughLayerToken(name)) return;
            let computed = "";
            try {
                computed = getComputedStyle(el).getPropertyValue(name) || "";
            } catch (_) {
                computed = "";
            }
            computed = String(computed).trim();
            if (computed && !/^initial$/i.test(computed)) return;
            const resolved = resolvePassthroughLayerToken(name, tokenMap, layerText);
            if (resolved) out.set(name, resolved);
        });
        return out;
    }

    function isColorTokenName(name) {
        return (
            /^--(color|background-color|border-color|outline-color|accent-color)/.test(
                name
            ) || /--(color|background|border|outline|accent)/.test(name)
        );
    }

    function collectOKLCHCustomPropertyDefs() {
        const defs = [];
        const seen = new Set();
        const walk = (rules) => {
            if (!rules) return;
            for (const rule of Array.from(rules)) {
                try {
                    if (rule && rule.cssRules && rule.cssRules.length) {
                        walk(rule.cssRules);
                    }
                } catch (_) { }
                if (!rule || !rule.style) continue;
                const localVars = {};
                for (let k = 0; k < rule.style.length; k++) {
                    const pn = rule.style[k];
                    if (pn && pn.startsWith("--")) {
                        localVars[pn] = rule.style.getPropertyValue(pn);
                    }
                }
                for (let k = 0; k < rule.style.length; k++) {
                    const pn = rule.style[k];
                    if (!pn || !pn.startsWith("--")) continue;
                    const val = rule.style.getPropertyValue(pn) || "";
                    if (!val || !/oklch\(/i.test(val) || !/var\(/i.test(val)) continue;
                    if (seen.has(pn)) continue;
                    seen.add(pn);
                    defs.push({ name: pn, val, localVars });
                }
            }
        };
        for (const sheet of Array.from(document.styleSheets)) {
            try {
                walk(sheet.cssRules);
            } catch (_) { }
        }
        return defs;
    }

    function refreshThemedCustomProperties() {
        const root = document.documentElement;
        const prefersDark =
            root.classList.contains("dark") ||
            root.getAttribute("data-theme") === "dark" ||
            (window.matchMedia &&
                window.matchMedia("(prefers-color-scheme: dark)").matches);
        const tokenMap = collectCustomPropertyMapFromLayerText();
        const layerText = collectLayerTextBundle();
        const textFallback = {};
        tokenMap.forEach(function (val, name) {
            textFallback[name] = val;
        });
        window.__pfTokenTextFallback = textFallback;

        const resolved = new Map();
        const passthrough = collectPassthroughLayerTokens(
            tokenMap,
            layerText,
            root
        );

        tokenMap.forEach(function (val, name) {
            if (!isColorTokenName(name)) return;
            if (prefersDark) {
                try {
                    const existing = getComputedStyle(root).getPropertyValue(name).trim();
                    if (
                        existing &&
                        !/^initial$/i.test(existing) &&
                        !/^unset$/i.test(existing)
                    ) {
                        return;
                    }
                } catch (_) {}
            }
            if (/^var\(/i.test(val)) return;
            const rgb = resolveTokenValueToRGB(root, val, textFallback);
            if (rgb) resolved.set(name, rgb);
        });

        for (const def of collectOKLCHCustomPropertyDefs()) {
            if (resolved.has(def.name)) continue;
            if (prefersDark) {
                try {
                    const existing = getComputedStyle(root)
                        .getPropertyValue(def.name)
                        .trim();
                    if (
                        existing &&
                        !/^initial$/i.test(existing) &&
                        !/^unset$/i.test(existing)
                    ) {
                        continue;
                    }
                } catch (_) {}
            }
            const rgb = resolveTokenValueToRGB(root, def.val, textFallback);
            if (rgb) resolved.set(def.name, rgb);
        }

        let guard = 0;
        let changed = true;
        while (changed && guard++ < 32) {
            changed = false;
            tokenMap.forEach(function (val, name) {
                if (!isColorTokenName(name) || resolved.has(name)) return;
                const m = val.match(/^var\(\s*([^,\s)]+)/i);
                if (!m) return;
                const ref = m[1].trim();
                if (resolved.has(ref)) {
                    resolved.set(name, resolved.get(ref));
                    changed = true;
                }
            });
        }

        const declarations = [];
        resolved.forEach(function (rgb, name) {
            declarations.push(name + ":" + rgb);
        });
        passthrough.forEach(function (val, name) {
            declarations.push(name + ":" + val);
        });

        if (!declarations.length) {
            patchColorMixInStylesheets();
            return 0;
        }

        const resolvedObj = {};
        resolved.forEach(function (rgb, name) {
            resolvedObj[name] = rgb;
        });
        window.__pfResolvedColorTokens = resolvedObj;

        const id = "oklch-themed-custom-props";
        const css = ":root{" + declarations.join(";") + "}";
        const existing = document.getElementById(id);
        if (existing) {
            if (existing.textContent === css) {
                patchColorMixInStylesheets();
                return 0;
            }
            existing.textContent = css;
        } else {
            injectStyle(css, id);
        }
        dbg(
            "Refreshed layer root tokens:",
            declarations.length,
            "colors=",
            resolved.size,
            "passthrough=",
            passthrough.size,
            "sample=",
            declarations.slice(0, 3).join(";")
        );
        patchColorMixInStylesheets();
        return declarations.length;
    }

    function scheduleColorMixPatchPasses() {
        const delays = [50, 250, 1000, 3000, 6000];
        for (let i = 0; i < delays.length; i++) {
            setTimeout(function () {
                try {
                    refreshThemedCustomProperties();
                } catch (e) {
                    dbg("refresh before color-mix patch failed", e);
                }
            }, delays[i]);
        }
    }

    function setupThemedCustomPropertyListeners() {
        if (window.__pfOnCssLayersUpdate) {
            window.__pfOnCssLayersUpdate(function () {
                setTimeout(function () {
                    try {
                        refreshThemedCustomProperties();
                    } catch (e) {
                        dbg("refresh after css-layers failed", e);
                    }
                }, 100);
            });
        }
        if (window.matchMedia) {
            const mq = window.matchMedia("(prefers-color-scheme: dark)");
            const onSchemeChange = function () {
                try {
                    refreshThemedCustomProperties();
                    injectColorMixCascadeOverrides();
                } catch (e) {
                    dbg("refresh after color-scheme change failed", e);
                }
            };
            if (mq.addEventListener) {
                mq.addEventListener("change", onSchemeChange);
            } else if (mq.addListener) {
                mq.addListener(onSchemeChange);
            }
        }
    }

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
                const val = resolveOKLCHValueForProp(el, cs, prop);
                if (!val) continue;
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

    function isGroupingCSSRule(rule) {
        if (!rule || !rule.cssRules || !rule.cssRules.length) return false;
        const ctor = rule.constructor && rule.constructor.name;
        return (
            rule.type === RULE.MEDIA ||
            rule.type === RULE.SUPPORTS ||
            ctor === "CSSMediaRule" ||
            ctor === "CSSSupportsRule"
        );
    }

    function groupingRuleCondition(rule) {
        return (
            rule.conditionText ||
            (rule.media && rule.media.mediaText) ||
            ""
        );
    }

    function ruleBlockHadColorMix(orig, selector) {
        if (!orig || !selector) return false;
        const parts = selector.split(",");
        for (let p = 0; p < parts.length; p++) {
            const sel = parts[p].trim();
            if (!sel) continue;
            const idx = orig.indexOf(sel);
            if (idx < 0) continue;
            const brace = orig.indexOf("{", idx);
            if (brace < 0) continue;
            let depth = 1;
            let j = brace + 1;
            while (j < orig.length && depth > 0) {
                const ch = orig[j];
                if (ch === "{") depth++;
                else if (ch === "}") depth--;
                j++;
            }
            if (/color-mix\s*\(/i.test(orig.slice(brace, j))) return true;
        }
        return false;
    }

    function collectColorMixOverrideChunks(rules, out, orig) {
        if (!rules) return;
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            if (!rule) continue;
            if (isGroupingCSSRule(rule)) {
                const inner = [];
                collectColorMixOverrideChunks(rule.cssRules, inner, orig);
                if (inner.length) {
                    out.push({
                        type: "group",
                        condition: groupingRuleCondition(rule),
                        rules: inner,
                    });
                }
                continue;
            }
            if (!rule.selectorText || !rule.style) continue;
            if (!ruleBlockHadColorMix(orig, rule.selectorText)) continue;
            const bg = rule.style.getPropertyValue("background-color");
            if (!bg || /color-mix/i.test(bg)) continue;
            if (!/^rgba?\(/i.test(bg.trim())) continue;
            out.push({
                type: "style",
                selector: rule.selectorText,
                background: bg.trim(),
            });
        }
    }

    function serializeColorMixOverrideChunks(chunks) {
        let css = "";
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk.type === "group") {
                if (!chunk.condition) continue;
                css +=
                    "@media " +
                    chunk.condition +
                    "{" +
                    serializeColorMixOverrideChunks(chunk.rules) +
                    "}";
            } else if (chunk.type === "style") {
                css +=
                    chunk.selector +
                    "{background-color:" +
                    chunk.background +
                    " !important;}";
            }
        }
        return css;
    }

    function buildOverrideCssFromStyleNode(styleNode) {
        if (!styleNode || !styleNode.sheet) return "";
        const orig = styleNode.dataset.pfColorMixOrig || "";
        const chunks = [];
        try {
            collectColorMixOverrideChunks(styleNode.sheet.cssRules, chunks, orig);
        } catch (e) {
            dbg("collectColorMixOverrideChunks failed", e);
        }
        return serializeColorMixOverrideChunks(chunks);
    }

    function buildOverrideCssFromText(cssText, el, localVars) {
        if (!cssText || !/color-mix\s*\(/i.test(cssText)) return "";
        const patched = replaceColorMixInText(cssText, el, localVars);
        if (patched === cssText) return "";
        const temp = document.createElement("style");
        temp.textContent = patched;
        document.head.appendChild(temp);
        let css = "";
        try {
            if (temp.sheet) {
                css = buildOverrideCssFromStyleNode(temp);
            }
        } catch (e) {
            dbg("buildOverrideCssFromText failed", e);
        }
        temp.remove();
        return css;
    }

    function applyColorMixOverrideStylesheet(css) {
        if (!css || !css.trim()) return false;
        const id = "color-mix-cascade-overrides";
        let node = document.getElementById(id);
        if (!node) {
            node = document.createElement("style");
            node.id = id;
            node.setAttribute("data-color-mix-polyfill", "");
            document.head.appendChild(node);
        }
        if (node.textContent === css) return false;
        node.textContent = css;
        dbg("Injected color-mix cascade overrides, bytes=", css.length);
        return true;
    }

    function collectAllColorMixOverrideCss() {
        const parts = [];
        const nodes = document.querySelectorAll("style");
        for (let n = 0; n < nodes.length; n++) {
            const node = nodes[n];
            if (node.id === "color-mix-cascade-overrides") continue;
            if (!node.dataset.pfColorMixOrig) continue;
            const css = buildOverrideCssFromStyleNode(node);
            if (css) parts.push(css);
        }
        return parts.join("");
    }

    function injectColorMixCascadeOverrides() {
        const css = collectAllColorMixOverrideCss();
        if (css) applyColorMixOverrideStylesheet(css);
        queueLinkedColorMixOverrides();
    }

    async function rebuildColorMixCascadeOverrides() {
        let css = collectAllColorMixOverrideCss();
        const linkCss = await buildLinkedColorMixOverrides();
        if (linkCss) css += linkCss;
        if (css) applyColorMixOverrideStylesheet(css);
    }

    async function buildLinkedColorMixOverrides() {
        const root = document.documentElement;
        const vars = getColorMixLocalVars();
        const links = document.querySelectorAll(
            'link[rel="stylesheet"]:not([disabled])'
        );
        const parts = [];
        const cache = window.__pfFetchCache;
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            const href = link.href;
            if (!href) continue;
            let text = null;
            try {
                const normalizedHref = normalizeStylesheetHref(href);
                if (cache && cache.has(normalizedHref)) {
                    text = await cache.get(normalizedHref);
                } else {
                    const res = await fetch(href, { mode: "cors" });
                    if (res.ok) text = await res.text();
                }
            } catch (e) {
                dbg("fetch for color-mix overrides failed", href, e);
            }
            if (!text || !/color-mix\s*\(/i.test(text)) continue;
            const css = buildOverrideCssFromText(text, root, vars);
            if (css) parts.push(css);
        }
        return parts.join("");
    }

    let linkedColorMixOverrideQueued = false;
    function queueLinkedColorMixOverrides() {
        if (linkedColorMixOverrideQueued) return;
        linkedColorMixOverrideQueued = true;
        setTimeout(function () {
            linkedColorMixOverrideQueued = false;
            rebuildColorMixCascadeOverrides().catch(function (e) {
                dbg("rebuildColorMixCascadeOverrides failed", e);
            });
        }, 0);
    }

    function processStyleDeclaration(style, contextEl) {
        if (!style) return false;
        const ctx = contextEl || document.documentElement;
        let changed = false;
        for (let k = 0; k < style.length; k++) {
            const prop = style[k];
            const val = style.getPropertyValue(prop);
            if (!val) continue;
            const priority = style.getPropertyPriority(prop);

            if (/color-mix\s*\(/i.test(val)) {
                const mixed = replaceColorMixInText(val, ctx);
                if (mixed !== val) {
                    try {
                        style.setProperty(prop, mixed, priority);
                        changed = true;
                    } catch (_) {
                        // ignore
                    }
                }
                continue;
            }

            if (!/oklch\(/i.test(val)) continue;
            // Themed values must stay dynamic — baking oklch(var(...)) to static rgb
            // breaks prefers-color-scheme and other contextual token overrides.
            if (/var\(/i.test(val)) continue;
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
        return changed;
    }

    function processCSSTextWithCSSOM(cssText) {
        if (
            !cssText ||
            (!/oklch\(/i.test(cssText) && !/color-mix\s*\(/i.test(cssText))
        ) {
            return { changed: false, text: cssText };
        }
        const temp = document.createElement("style");
        temp.textContent = cssText;
        document.head.appendChild(temp);
        let changed = false;
        let out = cssText;
        try {
            if (temp.sheet) {
                changed = traverseAndFixRules(temp.sheet.cssRules);
                if (changed) {
                    out = Array.from(temp.sheet.cssRules || [])
                        .map((r) => r.cssText)
                        .join("\n");
                }
            }
        } catch (e) {
            dbg("processCSSTextWithCSSOM failed", e);
        }
        if (/color-mix\s*\(/i.test(out)) {
            const patched = replaceColorMixInText(out);
            if (patched !== out) {
                out = patched;
                changed = true;
            }
        }
        temp.remove();
        return { changed: changed && out !== cssText, text: out };
    }

    function traverseAndFixRules(rules) {
        if (!rules) return false;
        let anyChanged = false;
        for (const rule of Array.from(rules)) {
            const ctor = rule && rule.constructor && rule.constructor.name;
            if (rule.type === RULE.STYLE || ctor === "CSSStyleRule") {
                anyChanged =
                    processStyleDeclaration(rule.style) || anyChanged;
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
        if (!styleNode || styleNode.__oklchProcessed) {
            return;
        }
        if (
            styleNode.getAttribute("data-css-layers-polyfill") ||
            isPolyfillManagedStyle(styleNode) ||
            isRawLayerStyle(styleNode)
        ) {
            styleNode.__oklchProcessed = true;
            return;
        }
        const txt = styleNode.textContent;
        if (!txt || !/oklch\(/i.test(txt)) {
            styleNode.__oklchProcessed = true;
            return;
        }

        let changed = false;
        try {
            if (styleNode.sheet) {
                changed = traverseAndFixRules(styleNode.sheet.cssRules);
            }
        } catch (e) {
            dbg("Failed CSSOM pass for <style> tag", e);
        }

        if (!changed) {
            const out = replaceOKLCHInText(txt);
            if (out !== txt) {
                styleNode.textContent = out;
                changed = true;
            }
        }

        if (changed) {
            stats.styleTagsProcessed++;
            dbg("Processed <style> tag, replaced OKLCH");
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
            const processed = processCSSTextWithCSSOM(cssText);
            if (processed.changed) {
                injectStyle(processed.text);
                dbg(
                    "Injected fallback <style> for sheet text",
                    sheet.href || "[inline]"
                );
                return true;
            }
        }
        return false;
    }

    function normalizeStylesheetHref(href) {
        try {
            return new URL(href, location.href).href;
        } catch (_) {
            return href;
        }
    }

    function hashString(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36);
    }

    async function fetchAndInlineStylesheet(href) {
        const normalizedHref = normalizeStylesheetHref(href);
        // Use shared fetch cache to avoid duplicate requests across polyfills
        const cache = window.__pfFetchCache;
        if (cache && !cache.has(normalizedHref)) {
            cache.set(normalizedHref, fetch(normalizedHref, { mode: "cors" })
                .then(r => r.ok ? r.text() : Promise.reject())
                .catch(e => {
                    cache.delete(normalizedHref);
                    dbg("Failed to fetch stylesheet", normalizedHref, e);
                    stats.errors++;
                    return null;
                })
            );
        }
        try {
            const text = cache
                ? await cache.get(normalizedHref)
                : await fetch(normalizedHref, { mode: "cors" }).then(r => r.ok ? r.text() : Promise.reject());
            if (!text) return false;
            if (!/oklch\(/i.test(text) && !/color-mix\s*\(/i.test(text)) {
                return false;
            }
            const processed = processCSSTextWithCSSOM(text);
            if (processed.changed) {
                const id = "oklch-inline-" + hashString(normalizedHref);
                injectStyle(processed.text, id);
                stats.sheetsFetched++;
                dbg("Fetched and inlined stylesheet with OKLCH", normalizedHref);
                return true;
            }
        } catch (e) {
            dbg("Failed to fetch stylesheet", normalizedHref, e);
            stats.errors++;
        }
        return false;
    }

    async function processAllStyleSheets(options) {
        options = options || {};
        if (options.refreshThemedOnly) {
            try {
                const themed = refreshThemedCustomProperties();
                if (themed) stats.textReplacements += themed;
            } catch (e) {
                dbg("refreshThemedCustomProperties failed", e);
                stats.errors++;
            }
            return;
        }

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

        try {
            const themed = refreshThemedCustomProperties();
            if (themed) stats.textReplacements += themed;
        } catch (e) {
            dbg("refreshThemedCustomProperties failed", e);
            stats.errors++;
        }

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
                collectOKLCHRules();
            } catch (e) {
                dbg("collectOKLCHRules failed", e);
                stats.errors++;
            }
            if (OKLCH_RULE_INDEX.length) {
                try {
                    applyIndexedRules();
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
                if (stats.rulesApplied === appliedBefore) {
                    dbg(
                        "No indexed rules applied; trying computed-style fallback"
                    );
                    try {
                        applyComputedStyleFallbacks();
                    } catch (e) {
                        dbg("applyComputedStyleFallbacks failed", e);
                        stats.errors++;
                    }
                }
            } else {
                dbg(
                    "No OKLCH rules in stylesheets; skipping element/computed fallbacks"
                );
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

    // Intercept inline style writes with oklch() values via CSSOM and setAttribute.
    // This replaces the expensive 'style' attribute MutationObserver (which fired on every
    // inline style mutation across the whole document subtree) with targeted synchronous hooks.
    function setupInlineStyleInterception() {
        const handleSetProperty = function (orig, prop, value, priority) {
            if (typeof value === "string" && /oklch\(/i.test(value)) {
                try {
                    const replaced = replaceOKLCHInText(value);
                    if (replaced !== value) {
                        stats.inlineStyleAttrsProcessed++;
                        return orig.call(this, prop, replaced, priority);
                    }
                } catch (_) {}
            }
            return orig.call(this, prop, value, priority);
        };

        const handleSetAttribute = function (orig, name, value) {
            if (name === "style" && typeof value === "string" && /oklch\(/i.test(value)) {
                try {
                    const replaced = replaceOKLCHInText(value);
                    if (replaced !== value) {
                        orig.call(this, name, replaced);
                        stats.inlineStyleAttrsProcessed++;
                        return;
                    }
                } catch (_) {}
            }
            return orig.call(this, name, value);
        };

        if (window.__pfHookPrototype) {
            window.__pfHookPrototype(
                CSSStyleDeclaration.prototype,
                "setProperty",
                handleSetProperty
            );
            window.__pfHookPrototype(Element.prototype, "setAttribute", handleSetAttribute);
        } else {
            const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
            CSSStyleDeclaration.prototype.setProperty = function (prop, value, priority) {
                return handleSetProperty.call(this, origSetProperty, prop, value, priority);
            };
            const origSetAttribute = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function (name, value) {
                return handleSetAttribute.call(this, origSetAttribute, name, value);
            };
        }

        const cssTextDesc = Object.getOwnPropertyDescriptor(
            CSSStyleDeclaration.prototype,
            "cssText"
        );
        if (cssTextDesc && cssTextDesc.set) {
            const origCssTextSet = cssTextDesc.set;
            Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", {
                get: cssTextDesc.get,
                set: function (value) {
                    if (typeof value === "string" && /oklch\(/i.test(value)) {
                        try {
                            const replaced = replaceOKLCHInText(value);
                            if (replaced !== value) {
                                stats.inlineStyleAttrsProcessed++;
                                return origCssTextSet.call(this, replaced);
                            }
                        } catch (_) { }
                    }
                    return origCssTextSet.call(this, value);
                },
                configurable: true,
                enumerable: cssTextDesc.enumerable,
            });
        }
    }

    // Observe dynamic additions/changes via the shared mutation hub.
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
                                    } catch (_) { }
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
                    if (
                        t === document.documentElement &&
                        m.attributeName === "class"
                    ) {
                        queueFullProcess({ refreshThemedOnly: true });
                    } else if (
                        t.tagName === "LINK" &&
                        t.rel === "stylesheet" &&
                        (m.attributeName === "href" || m.attributeName === "rel")
                    ) {
                        needs = true;
                    }
                }
            }
            if (needs) {
                queueFullProcess({});
            }
        }

        if (window.__pfRegisterMutationListener) {
            window.__pfRegisterMutationListener(handleMutations);
        } else {
            const observer = new MutationObserver(handleMutations);
            observer.observe(document, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["href", "rel", "class"],
            });
        }
    }

    let oklchRescanScheduled = 0;
    const OKLCH_MAX_RESCAN_PASSES = 2;

    function scheduleOklchRescan(delay) {
        if (oklchRescanScheduled >= OKLCH_MAX_RESCAN_PASSES) return;
        oklchRescanScheduled++;
        setTimeout(function () {
            processAllStyleSheets(lightPassOptions);
        }, delay);
    }

    dbg("OKLCH fallback enabled");
    setupInlineStyleInterception();
    const initialPassOptions = {
        forceInlineScan: true,
        forceElementFallbacks: true,
    };
    const lightPassOptions = { refreshThemedOnly: true };
    processAllStyleSheets(initialPassOptions);
    if (document.readyState !== "complete") {
        window.addEventListener(
            "load",
            () => processAllStyleSheets(lightPassOptions),
            { once: true }
        );
    }
    scheduleOklchRescan(1000);
    if (window.__pfOnCssLayersUpdate) {
        window.__pfOnCssLayersUpdate(function () {
            processAllStyleSheets(lightPassOptions);
        });
    }
    scheduleColorMixPatchPasses();
    setupMutationListener();
})();
