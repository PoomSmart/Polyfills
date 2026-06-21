// ChatGPT - Media Query Range Syntax Polyfill
// Supports transforming level 4 range syntax like:
//   @media (width >= 600px) {}
//   @media (500px < width <= 800px) {}
//   @media (400px <= width < 1000px), (height > 700px) {}
// into classic min-/max- feature queries for older browsers.
// Notes:
// - Exclusive bounds (< or >) are approximated by adding / subtracting a small epsilon
//   when the unit is px / dpi / dppx. For other units or aspect-ratio we degrade to inclusive.
// - We only transform a subset of features: width, height, device-width, device-height,
//   aspect-ratio, device-aspect-ratio, resolution.
// - If parsing fails for a media list part, it is left unchanged.
// - Dynamic <style> and <link rel="stylesheet"> insertions are watched via MutationObserver.

(function mediaQueryRangePolyfill() {
    if (window.__mediaQueryRangePolyfillApplied) return;
    window.__mediaQueryRangePolyfillApplied = true;

    const processedSheetSignatures = new Map();
    const injectedIds = new Set();
    const RESCAN_COOLDOWN_MS = 500;
    let lastRescanAt = 0;
    let rescanScheduled = false;

    const FEATURES = new Set([
        "width",
        "height",
        "device-width",
        "device-height",
        "aspect-ratio",
        "device-aspect-ratio",
        "resolution",
    ]);

    const EPSILON_PX = 0.02; // px adjustment for exclusive bounds
    const EPSILON_DPPX = 0.001; // dppx adjustment
    const EPSILON_DPI = 0.2; // dpi adjustment

    function adjustExclusive(value, unit, direction) {
        // direction: +1 for > (raise lower bound), -1 for < (lower upper bound)
        const num = parseFloat(value);
        if (!isFinite(num)) return value + unit; // fallback
        switch (unit) {
            case "px":
                return num + direction * EPSILON_PX + unit;
            case "dppx":
                return num + direction * EPSILON_DPPX + unit;
            case "dpi":
                return num + direction * EPSILON_DPI + unit;
            default:
                // For units we don't adjust, treat exclusive as inclusive
                return num + unit;
        }
    }

    function parseValueUnit(str) {
        const m = String(str)
            .trim()
            .match(
                /^([+-]?(?:\d+\.\d+|\d*\.\d+|\d+))(px|em|rem|vh|vw|vmin|vmax|dppx|dpi|dpcm|pt|pc|cm|mm|in|%)?$/i
            );
        if (!m) return null;
        return { value: m[1], unit: (m[2] || "").toLowerCase() };
    }

    function isRatioValue(v) {
        return /^(?:[0-9]*\.?[0-9]+)\/(?:[0-9]*\.?[0-9]+)$/.test(v.trim());
    }

    function buildConstraint(feature, type, val) {
        // type: 'min' | 'max'
        return `(${type}-${feature}: ${val})`;
    }

    function transformSingleComparison(left, op, right, reversed) {
        // left/right are strings; one side is feature, other is value
        let feature, value, valueIsLeft;
        if (FEATURES.has(left)) {
            feature = left;
            value = right;
            valueIsLeft = false;
        } else if (FEATURES.has(right)) {
            feature = right;
            value = left;
            valueIsLeft = true;
        } else return null;

        feature = feature.toLowerCase();
        const isRatio = feature.includes("aspect-ratio");
        let min = null,
            max = null;

        // Normalize operator as it applies to feature OP value (feature op value)
        // If value is on left (value OP feature) we invert semantics.
        // Operators: <, <=, >, >= relative to feature.
        let featureOp, exclusive;
        if (!valueIsLeft) {
            // feature op value
            featureOp = op;
            exclusive = op === "<" || op === ">";
        } else {
            // value op feature  e.g. 500px < width  => width > 500px
            // value OP feature => invert
            if (op === "<") featureOp = ">";
            else if (op === "<=") featureOp = ">=";
            else if (op === ">") featureOp = "<";
            else if (op === ">=") featureOp = "<=";
            exclusive = op === "<" || op === ">";
        }

        value = value.trim();
        if (
            !isRatio &&
            !parseValueUnit(value) &&
            !isRatioValue(value) &&
            !isCalcValue(value)
        )
            return null;

        if (featureOp === ">=" || featureOp === ">") {
            if (isRatio) {
                min = value;
            } else if (isCalcValue(value)) {
                const adj =
                    featureOp === ">"
                        ? evaluateAndAdjustCalc(value, +1)
                        : value; // exclusive >
                min = adj;
            } else {
                const parsed = parseValueUnit(value);
                if (!parsed) return null;
                min =
                    featureOp === ">"
                        ? adjustExclusive(parsed.value, parsed.unit, +1)
                        : parsed.value + parsed.unit;
            }
        } else if (featureOp === "<=" || featureOp === "<") {
            if (isRatio) {
                max = value;
            } else if (isCalcValue(value)) {
                const adj =
                    featureOp === "<"
                        ? evaluateAndAdjustCalc(value, -1)
                        : value;
                max = adj;
            } else {
                const parsed = parseValueUnit(value);
                if (!parsed) return null;
                max =
                    featureOp === "<"
                        ? adjustExclusive(parsed.value, parsed.unit, -1)
                        : parsed.value + parsed.unit;
            }
        }

        const out = [];
        if (min) out.push(buildConstraint(feature, "min", min));
        if (max) out.push(buildConstraint(feature, "max", max));
        return out.join(" and ") || null;
    }

    function transformTripleRange(leftVal, op1, feature, op2, rightVal) {
        feature = feature.toLowerCase();
        if (!FEATURES.has(feature)) return null;
        const isRatio = feature.includes("aspect-ratio");

        const leftParsed = parseValueUnit(leftVal);
        const rightParsed = parseValueUnit(rightVal);
        const leftIsRatio = isRatioValue(leftVal);
        const rightIsRatio = isRatioValue(rightVal);
        const leftIsCalc = isCalcValue(leftVal);
        const rightIsCalc = isCalcValue(rightVal);

        if (isRatio && (!leftIsRatio || !rightIsRatio)) return null;
        if (!isRatio && !(leftParsed || leftIsCalc)) return null;
        if (!isRatio && !(rightParsed || rightIsCalc)) return null;

        let minVal, maxVal;

        if (isRatio) {
            // degrade exclusive to inclusive for aspect-ratio
            minVal = leftVal.trim();
            maxVal = rightVal.trim();
        } else if (leftIsCalc || rightIsCalc) {
            if (leftIsCalc) {
                // pattern A < feature  => feature > A  (raise lower bound)
                minVal =
                    op1 === "<"
                        ? evaluateAndAdjustCalc(leftVal, +1)
                        : leftVal.trim();
            } else {
                minVal =
                    op1 === "<"
                        ? adjustExclusive(leftParsed.value, leftParsed.unit, +1)
                        : leftParsed.value + leftParsed.unit;
            }
            if (rightIsCalc) {
                maxVal =
                    op2 === "<"
                        ? evaluateAndAdjustCalc(rightVal, -1)
                        : rightVal.trim();
            } else {
                maxVal =
                    op2 === "<"
                        ? adjustExclusive(
                              rightParsed.value,
                              rightParsed.unit,
                              -1
                          )
                        : rightParsed.value + rightParsed.unit;
            }
        } else {
            minVal =
                op1 === "<"
                    ? adjustExclusive(leftParsed.value, leftParsed.unit, +1)
                    : leftParsed.value + leftParsed.unit;
            maxVal =
                op2 === "<"
                    ? adjustExclusive(rightParsed.value, rightParsed.unit, -1)
                    : rightParsed.value + rightParsed.unit;
        }

        return `(${`min-${feature}`}: ${minVal}) and (${`max-${feature}`}: ${maxVal})`;
    }

    // Regex fragments
    const featureRe =
        "(?:width|height|device-width|device-height|aspect-ratio|device-aspect-ratio|resolution)";
    const numberUnitRe = "(?:[0-9]*\\.?[0-9]+(?:[a-zA-Z%]+)?)";
    const ratioRe = "(?:[0-9]*\\.?[0-9]+/[0-9]*\\.?[0-9]+)";
    const calcRe = "calc\\((?:[^()]+|\\([^()]*\\))*\\)"; // simplistic calc() matcher allowing one nested level
    const valueRe = `(?:${numberUnitRe}|${ratioRe}|${calcRe})`;
    const opRe = "(?:<=|>=|<|>)";

    // Triple range:  A  <  feature  <=  B   (any mix of <, <=)
    const tripleRangeRegex = new RegExp(
        `^${valueRe}\\s*${opRe}\\s*${featureRe}\\s*${opRe}\\s*${valueRe}$`,
        "i"
    );

    // Single comparison patterns inside parentheses (no AND / OR splitting yet)
    const singleCompRegex = new RegExp(
        `^(?:${featureRe}\\s*${opRe}\\s*${valueRe}|${valueRe}\\s*${opRe}\\s*${featureRe})$`,
        "i"
    );
    function isCalcValue(v) {
        return /^\s*calc\(/i.test(v);
    }

    // Enhanced calc() evaluator supporting +, -, *, /, parentheses and single-unit propagation (px|dppx|dpi) for numeric adjustment.
    function evaluateCalcExpression(expr) {
        const m = expr.match(/^\s*calc\((.*)\)\s*$/i);
        if (!m) return null;
        const src = m[1];
        let i = 0;
        function peek() {
            return src[i];
        }
        function eat() {
            return src[i++];
        }
        function skip() {
            while (/\s/.test(peek())) i++;
        }
        function parseNumberUnit() {
            skip();
            const start = i;
            if (/[+-]/.test(peek())) eat();
            let saw = false;
            while (/\d/.test(peek())) {
                eat();
                saw = true;
            }
            if (peek() === ".") {
                eat();
                while (/\d/.test(peek())) {
                    eat();
                    saw = true;
                }
            }
            if (!saw) {
                i = start;
                return null;
            }
            const num = parseFloat(src.slice(start, i));
            const um = src.slice(i).match(/^(px|dppx|dpi)/i);
            let unit = "";
            if (um) {
                unit = um[1];
                i += unit.length;
            }
            return { value: num, unit: unit.toLowerCase() };
        }
        function parsePrimary() {
            skip();
            if (peek() === "(") {
                eat();
                const v = parseExpr();
                skip();
                if (peek() === ")") eat();
                else return null;
                return v;
            }
            return parseNumberUnit();
        }
        function combine(a, b, op) {
            if (!a || !b) return null;
            if (op === "+" || op === "-") {
                if (a.unit !== b.unit) return null;
                return {
                    value: op === "+" ? a.value + b.value : a.value - b.value,
                    unit: a.unit,
                };
            }
            if (op === "*") {
                if (a.unit && b.unit) return null;
                if (a.unit) return { value: a.value * b.value, unit: a.unit };
                if (b.unit) return { value: a.value * b.value, unit: b.unit };
                return { value: a.value * b.value, unit: "" };
            }
            if (op === "/") {
                if (b.unit) return null;
                return { value: a.value / b.value, unit: a.unit };
            }
            return null;
        }
        function parseFactor() {
            skip();
            let sign = 1;
            while (peek() === "+" || peek() === "-") {
                if (peek() === "-") sign *= -1;
                eat();
                skip();
            }
            let node = parsePrimary();
            if (!node) return null;
            node.value *= sign;
            return node;
        }
        function parseTerm() {
            let n = parseFactor();
            skip();
            while (peek() === "*" || peek() === "/") {
                const op = eat();
                const r = parseFactor();
                n = combine(n, r, op);
                if (!n) return null;
                skip();
            }
            return n;
        }
        function parseExpr() {
            let n = parseTerm();
            skip();
            while (peek() === "+" || peek() === "-") {
                const op = eat();
                const r = parseTerm();
                n = combine(n, r, op);
                if (!n) return null;
                skip();
            }
            return n;
        }
        const out = parseExpr();
        skip();
        if (i !== src.length) return null;
        return out;
    }

    function evaluateAndAdjustCalc(expr, direction) {
        const res = evaluateCalcExpression(expr);
        if (!res) return expr; // fallback
        const { value, unit } = res;
        const u = unit.toLowerCase();
        let v = value;
        if (u === "px") v += direction * EPSILON_PX;
        else if (u === "dppx") v += direction * EPSILON_DPPX;
        else if (u === "dpi") v += direction * EPSILON_DPI;
        else return expr; // unsupported unit for epsilon
        return v + unit; // numeric literal replacement
    }

    function transformConditionPart(part) {
        const trimmed = part.trim();
        if (!trimmed) return part;
        // Remove optional outer parentheses for analysis (will rebuild later)
        const inner = trimmed.replace(/^\((.*)\)$/, "$1").trim();

        if (tripleRangeRegex.test(inner)) {
            // Extract pieces
            const m = inner.match(
                new RegExp(
                    `^(${valueRe})\\s*(${opRe})\\s*(${featureRe})\\s*(${opRe})\\s*(${valueRe})$`,
                    "i"
                )
            );
            if (m) {
                const out = transformTripleRange(m[1], m[2], m[3], m[4], m[5]);
                if (out) return out;
            }
        } else if (singleCompRegex.test(inner)) {
            const m = inner.match(
                new RegExp(`^(${featureRe})\\s*(${opRe})\\s*(${valueRe})$`, "i")
            );
            if (m) {
                const out = transformSingleComparison(m[1], m[2], m[3], false);
                if (out) return out;
            } else {
                const m2 = inner.match(
                    new RegExp(
                        `^(${valueRe})\\s*(${opRe})\\s*(${featureRe})$`,
                        "i"
                    )
                );
                if (m2) {
                    const out = transformSingleComparison(
                        m2[1],
                        m2[2],
                        m2[3],
                        true
                    );
                    if (out) return out;
                }
            }
        }
        return part; // unchanged
    }

    function splitMediaConditionList(cond) {
        // Split by commas at top level not inside parentheses
        const parts = [];
        let depth = 0,
            start = 0;
        for (let i = 0; i < cond.length; i++) {
            const ch = cond[i];
            if (ch === "(") depth++;
            else if (ch === ")") depth = Math.max(0, depth - 1);
            else if (ch === "," && depth === 0) {
                parts.push(cond.slice(start, i));
                start = i + 1;
            }
        }
        parts.push(cond.slice(start));
        return parts.map((s) => s.trim());
    }

    function splitPartsByAnd(condPart) {
        // Very naive split on 'and' tokens outside parentheses
        const tokens = [];
        let depth = 0;
        let buf = "";
        const w = condPart.split(/\s+/);
        for (let i = 0; i < w.length; i++) {
            const token = w[i];
            const lowered = token.toLowerCase();
            // track parentheses counts in token
            for (const c of token) {
                if (c === "(") depth++;
                else if (c === ")") depth = Math.max(0, depth - 1);
            }
            if (depth === 0 && lowered === "and") {
                if (buf.trim()) tokens.push(buf.trim());
                buf = "";
            } else {
                buf += (buf ? " " : "") + token;
            }
        }
        if (buf.trim()) tokens.push(buf.trim());
        return tokens;
    }

    function transformMediaQueryExpression(expr) {
        // Handle NOT / ONLY tokens by preserving them and operating on the rest
        const prefixMatch = expr.match(/^((?:not|only)\s+)/i);
        let prefix = "";
        let rest = expr;
        if (prefixMatch) {
            prefix = prefixMatch[1];
            rest = expr.slice(prefix.length);
        }

        const parts = splitPartsByAnd(rest);
        const outParts = parts.map((p) => transformConditionPart(p));
        return prefix + outParts.join(" and ");
    }

    function transformMediaQueryList(cond) {
        const list = splitMediaConditionList(cond);
        let changed = false;
        const out = list.map((part) => {
            const transformed = transformMediaQueryExpression(part);
            if (transformed !== part) changed = true;
            return transformed;
        });
        return { changed, text: out.join(", ") };
    }

    function transformCSS(cssText) {
        if (!/@media/i.test(cssText)) return cssText;
        return cssText.replace(/@media\s+([^\{]+)\{/gi, (full, cond) => {
            const { changed, text } = transformMediaQueryList(cond.trim());
            if (!changed) return full; // unchanged
            return `@media ${text}{`;
        });
    }

    function hashString(input) {
        let h = 0;
        for (let i = 0; i < input.length; i++) {
            h = ((h << 5) - h + input.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36);
    }

    function injectStyle(css) {
        if (!css) return;
        const id = `media-range-${hashString(css)}`;
        if (injectedIds.has(id) || document.getElementById(id)) {
            return;
        }
        const style = document.createElement("style");
        style.id = id;
        style.textContent = css;
        document.head.appendChild(style);
        injectedIds.add(id);
    }

    function getStyleSheetText(sheet) {
        try {
            const rules = Array.from(sheet.cssRules || sheet.rules || []);
            return rules.map((r) => r.cssText).join("\n");
        } catch (e) {
            return null;
        }
    }

    async function processStyleSheet(sheet) {
        const sheetKey = sheet.href || (sheet.ownerNode && sheet.ownerNode.id) || "inline";
        let text = getStyleSheetText(sheet);
        if (text && /@media\s+[^\{]*[<>]=?/.test(text)) {
            const signature = `${sheetKey}::${text.length}`;
            if (processedSheetSignatures.get(sheetKey) === signature) {
                return;
            }
            // early filter for range ops
            const transformed = transformCSS(text);
            if (transformed !== text) {
                injectStyle(transformed);
            }
            processedSheetSignatures.set(sheetKey, signature);
            return;
        }
        // If we couldn't get text (cross-origin) we attempt fetch if same-origin
        if (sheet.href) {
            try {
                const url = new URL(sheet.href, location.href);
                if (url.origin === location.origin) {
                    // Use shared fetch cache to avoid duplicate requests across polyfills
                    const cache = window.__pfFetchCache;
                    if (cache && !cache.has(url.href)) {
                        cache.set(url.href, fetch(url.href, { mode: 'cors' })
                            .then(r => r.ok ? r.text() : Promise.reject())
                            .catch(() => null)
                        );
                    }
                    const css = cache
                        ? await cache.get(url.href)
                        : await fetch(url.href, { mode: 'cors' }).then(r => r.ok ? r.text() : Promise.reject());
                    if (css && /@media\s+[^\{]*[<>]=?/.test(css)) {
                        const transformed = transformCSS(css);
                        if (transformed !== css) injectStyle(transformed);
                    }
                }
            } catch (e) {
                // ignore
            }
        }
    }

    function processInlineStyleTag(node) {
        if (node.__mediaRangeProcessed) return;
        const txt = node.textContent;
        if (txt && /@media\s+[^\{]*[<>]=?/.test(txt)) {
            const out = transformCSS(txt);
            if (out !== txt) {
                node.textContent = out;
            }
        }
        node.__mediaRangeProcessed = true;
    }

    async function processAll() {
        // Process existing styleSheets
        const sheets = Array.from(document.styleSheets);
        for (const sheet of sheets) {
            await processStyleSheet(sheet);
        }
        // Process inline <style>
        document.querySelectorAll("style").forEach(processInlineStyleTag);
    }

    function queueRescan() {
        if (rescanScheduled) return;
        rescanScheduled = true;
        const elapsed = Date.now() - lastRescanAt;
        const wait = Math.max(0, RESCAN_COOLDOWN_MS - elapsed);
        clearTimeout(window.__mediaRangeDebounce);
        window.__mediaRangeDebounce = setTimeout(() => {
            rescanScheduled = false;
            lastRescanAt = Date.now();
            processAll();
        }, wait);
    }

    function setupObserver() {
        function handleMutations(muts) {
            let needs = false;
            for (const m of muts) {
                if (m.type === 'childList') {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        if (node.tagName === 'STYLE') {
                            processInlineStyleTag(node);
                        } else if (
                            node.tagName === 'LINK' &&
                            node.rel === 'stylesheet'
                        ) {
                            needs = true;
                        } else {
                            const inner =
                                node.querySelectorAll &&
                                node.querySelectorAll(
                                    'style, link[rel="stylesheet"]'
                                );
                            if (inner && inner.length) needs = true;
                        }
                    }
                } else if (m.type === 'attributes') {
                    const t = m.target;
                    if (
                        t.tagName === 'LINK' &&
                        t.rel === 'stylesheet' &&
                        (m.attributeName === 'href' ||
                            m.attributeName === 'rel')
                    ) {
                        needs = true;
                    }
                }
            }
            if (needs) {
                queueRescan();
            }
        }

        if (window.__pfRegisterMutationListener) {
            window.__pfRegisterMutationListener(handleMutations);
        } else {
            // Fallback: own observer if hub is not available
            const obs = new MutationObserver(handleMutations);
            obs.observe(document, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['href', 'rel'],
            });
        }
    }

    processAll();
    setupObserver();
})();
