(function () {
    if (window.__viewportUnitPolyfillApplied) return;
    window.__viewportUnitPolyfillApplied = true;

    const UNIT_MAP = {
        dvh: 'vh', svh: 'vh', lvh: 'vh',
        dvw: 'vw', svw: 'vw', lvw: 'vw',
        dvmin: 'vmin', svmin: 'vmin', lvmin: 'vmin',
        dvmax: 'vmax', svmax: 'vmax', lvmax: 'vmax',
    };

    const valueUnitRegex = new RegExp(
        `(-?\\d*\\.?\\d+)\\s*(${Object.keys(UNIT_MAP).join('|')})(?![a-zA-Z])`,
        'g'
    );

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
                console.warn(`⚠️ Skipping cross-origin stylesheet: ${sheet.href}`);
            } else {
                console.error(`❌ Error processing stylesheet: ${sheet.href || 'inline'}`, err);
            }
        }
    }

    for (const sheet of document.styleSheets) {
        processSheet(sheet);
    }
})();
