// Shared helper for duplicating unprefixed CSS properties to -webkit- equivalents.
// Used by property-specific polyfills (mask-image, backdrop-filter, etc.).
(function setupWebkitPrefixHelper() {
    if (window.__pfCreateWebkitPropertyPatcher) return;

    function escapeRegex(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    window.__pfCreateWebkitPropertyPatcher = function (options) {
        options = options || {};
        const properties = options.properties || [];
        const detectProperty = options.detectProperty || properties[0];
        const detectValue = options.detectValue || "none";

        const propPattern = properties
            .map(function (p) {
                return escapeRegex(p);
            })
            .join("|");

        const declPattern = new RegExp(
            "(?:^|;|\\{)\\s*(" + propPattern + ")\\s*:\\s*([^;}]*)",
            "g"
        );

        function needsPolyfill() {
            if (!detectProperty) return false;
            const el = document.createElement("div");
            try {
                el.style.setProperty(detectProperty, detectValue);
                return el.style.getPropertyValue(detectProperty) === "";
            } catch (_) {
                return false;
            }
        }

        function patchText(css) {
            if (!css || !options.quickTest || !options.quickTest.test(css)) {
                return css;
            }
            return css.replace(declPattern, function (match, prop, val) {
                if (prop.indexOf("-webkit-") === 0) return match;
                const prefixChar = match.trim().charAt(0);
                const prefix =
                    prefixChar === ";" || prefixChar === "{" ? prefixChar : "";
                return (
                    prefix +
                    " " +
                    prop +
                    ": " +
                    val +
                    "; -webkit-" +
                    prop +
                    ": " +
                    val
                );
            });
        }

        return {
            properties: properties,
            needsPolyfill: needsPolyfill,
            patchText: patchText,
            quickTest: options.quickTest,
        };
    };

    if (!window.__pfPatchMaskInCSS) {
        window.__pfPatchMaskInCSS = function (css) {
            return css;
        };
    }
    if (!window.__pfPatchBackdropFilterInCSS) {
        window.__pfPatchBackdropFilterInCSS = function (css) {
            return css;
        };
    }
    // if (!window.__pfPatchContentVisibilityInCSS) {
    //     window.__pfPatchContentVisibilityInCSS = function (css) {
    //         return css;
    //     };
    // }
})();
