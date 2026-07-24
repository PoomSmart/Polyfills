(function () {
    if (window.__viewportUnitPolyfillApplied) return;
    window.__viewportUnitPolyfillApplied = true;

    const UNIT_MAP = {
        dvh: 'vh', svh: 'vh', lvh: 'vh',
        dvw: 'vw', svw: 'vw', lvw: 'vw',
        dvmin: 'vmin', svmin: 'vmin', lvmin: 'vmin',
        dvmax: 'vmax', svmax: 'vmax', lvmax: 'vmax',
    };

    // Longest first so dvmin/dvmax win over a shorter prefix match.
    const UNIT_NAMES = Object.keys(UNIT_MAP).sort((a, b) => b.length - a.length);

    const valueUnitRegex = new RegExp(
        `(-?\\d*\\.?\\d+)\\s*(${UNIT_NAMES.join('|')})(?![a-zA-Z])`,
        'g'
    );

    // Same pattern, anchored, for scanning stylesheet text position by position.
    const unitAtPosition = new RegExp(
        `^(-?\\d*\\.?\\d+)\\s*(${UNIT_NAMES.join('|')})(?![a-zA-Z])`
    );

    function mightContainUnits(str) {
        return str.indexOf('dv') !== -1 || str.indexOf('sv') !== -1 || str.indexOf('lv') !== -1;
    }

    function replaceUnitsOutsideVar(str) {
        let result = '';
        let i = 0;

        while (i < str.length) {
            const varStart = str.indexOf('var(', i);

            if (varStart === -1) {
                result += str.slice(i).replace(valueUnitRegex, (_, num, unit) => `${num}${UNIT_MAP[unit]}`);
                break;
            }

            result += str.slice(i, varStart).replace(valueUnitRegex, (_, num, unit) => `${num}${UNIT_MAP[unit]}`);

            let depth = 1;
            let j = varStart + 4;
            while (j < str.length && depth > 0) {
                if (str[j] === '(') depth++;
                else if (str[j] === ')') depth--;
                j++;
            }

            result += str.slice(varStart, j);
            i = j;
        }

        return result;
    }

    // Rewrites units in whole stylesheet text, for sheets whose rules cannot be
    // reached through the CSSOM — a cross-origin sheet re-hosted inline by another
    // polyfill, or rules that the parser dropped (e.g. inside `@layer` on WebKit
    // older than 15.4) and that only exist in text form.
    //
    // Only declaration values may be touched. Utility frameworks put the unit in
    // class names too — `.h-dvh`, `.h-\[calc\(100dvh-2rem\)\]` — and those must stay
    // byte-identical to the markup or the rule stops matching. So the scan skips
    // strings, comments and escaped `\[ ... \]` selector segments, and only rewrites
    // a unit that directly follows a number which is not part of an identifier.
    function replaceUnitsInStyleSheetText(css) {
        if (!mightContainUnits(css)) return css;

        const out = [];
        const n = css.length;
        let i = 0;
        let seg = 0;
        let inEscapedBrackets = false;
        const flush = (upTo) => { if (upTo > seg) out.push(css.slice(seg, upTo)); };

        while (i < n) {
            const c = css.charCodeAt(i);

            if (c === 92) { // backslash escape, and \[ ... \] selector tracking
                const next = css[i + 1];
                if (next === '[') inEscapedBrackets = true;
                else if (next === ']') inEscapedBrackets = false;
                i += 2;
                continue;
            }
            if (c === 47 && css.charCodeAt(i + 1) === 42) { // comment
                const end = css.indexOf('*/', i + 2);
                i = end < 0 ? n : end + 2;
                continue;
            }
            if (c === 34 || c === 39) { // string
                const quote = c;
                let j = i + 1;
                while (j < n) {
                    const cj = css.charCodeAt(j);
                    if (cj === 92) { j += 2; continue; }
                    if (cj === quote) { j++; break; }
                    j++;
                }
                i = j;
                continue;
            }
            // a digit, leading dot or sign may start a length
            if (!inEscapedBrackets && ((c >= 48 && c <= 57) || c === 46 || c === 45)) {
                const prev = i > 0 ? css[i - 1] : ' ';
                if (!/[A-Za-z0-9_]/.test(prev)) { // not inside an identifier
                    const m = unitAtPosition.exec(css.substr(i, 40));
                    if (m) {
                        flush(i);
                        out.push(m[1] + UNIT_MAP[m[2]]);
                        i += m[0].length;
                        seg = i;
                        continue;
                    }
                }
            }
            i++;
        }

        flush(n);
        return out.join('');
    }

    function fixStyleSheet(sheet) {
        try {
            const rules = sheet.cssRules;
            for (let i = 0; i < rules.length; i++) {
                const rule = rules[i];

                if (rule.type === CSSRule.STYLE_RULE) {
                    const style = rule.style;
                    for (let j = 0; j < style.length; j++) {
                        const prop = style.item(j);
                        const value = style.getPropertyValue(prop);
                        const replaced = replaceUnitsOutsideVar(value);
                        if (value !== replaced) {
                            style.setProperty(prop, replaced, style.getPropertyPriority(prop));
                        }
                    }
                } else if (
                    rule.type === CSSRule.MEDIA_RULE ||
                    rule.type === CSSRule.SUPPORTS_RULE
                ) {
                    fixStyleSheet(rule); // recurse
                }
            }
        } catch (e) {
            throw e;
        }
    }

    function processSheet(sheet) {
        try {
            fixStyleSheet(sheet);
        } catch (err) {
            if (err.name === 'SecurityError') {
                // Cross-origin: nothing readable here. If another polyfill re-hosts
                // the sheet inline, processStyleNode() picks it up from its text.
            } else {
                console.error(`❌ Error processing stylesheet: ${sheet.href || 'inline'}`, err);
            }
        }
    }

    // Patches a <style> element's text. The last value we wrote is remembered so
    // our own write does not come back as more work, while a rewrite by another
    // polyfill still does.
    function processStyleNode(node) {
        if (!node || node.tagName !== 'STYLE') return;
        const text = node.textContent;
        // Empty for now: elements are often inserted before their text is set, and
        // that write arrives as its own mutation.
        if (!text || node.__pfUnitsPatchedText === text) return;

        const patched = replaceUnitsInStyleSheetText(text);
        node.__pfUnitsPatchedText = patched;
        if (patched !== text) {
            node.textContent = patched;
        }
    }

    function processAll() {
        for (let i = 0; i < document.styleSheets.length; i++) {
            processSheet(document.styleSheets[i]);
        }
        const styles = document.querySelectorAll('style');
        for (let j = 0; j < styles.length; j++) {
            processStyleNode(styles[j]);
        }
    }

    // A <link> that just appeared has no sheet yet; give it a moment to load.
    let sheetPassTimer = null;
    function scheduleSheetPass() {
        clearTimeout(sheetPassTimer);
        sheetPassTimer = setTimeout(processAll, 250);
    }

    function handleMutations(mutations) {
        for (let i = 0; i < mutations.length; i++) {
            const added = mutations[i].addedNodes;
            if (!added) continue;
            for (let j = 0; j < added.length; j++) {
                const node = added[j];
                if (node.nodeType === 3) {
                    // text written into a <style>, e.g. by the cascade-layer polyfill
                    if (node.parentNode && node.parentNode.tagName === 'STYLE') {
                        processStyleNode(node.parentNode);
                    }
                } else if (node.nodeType === 1) {
                    if (node.tagName === 'STYLE') {
                        processStyleNode(node);
                    } else if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
                        scheduleSheetPass();
                    }
                }
            }
        }
    }

    processAll();

    if (window.__pfRegisterMutationListener) {
        window.__pfRegisterMutationListener(handleMutations);
    } else {
        new MutationObserver(handleMutations).observe(document, {
            childList: true,
            subtree: true,
        });
    }

    // The cascade-layer polyfill re-hosts remote stylesheets inline, which is the
    // only way their rules become reachable at all on older WebKit — re-run once it
    // has done so.
    if (window.__pfOnCssLayersUpdate) {
        window.__pfOnCssLayersUpdate(processAll);
    }
})();
