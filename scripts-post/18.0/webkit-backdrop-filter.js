// backdrop-filter -webkit-prefix polyfill for engines without unprefixed support.
(function polyfillWebkitBackdropFilter() {
    var __PF_DEBUG__ = false;
    const LOG = "[webkit-backdrop-filter]";
    function dbg() {
        if (!__PF_DEBUG__) return;
        try {
            console.log.apply(
                console,
                [LOG].concat(Array.prototype.slice.call(arguments))
            );
        } catch (_) {}
    }

    if (window.__webkitBackdropFilterPolyfillApplied) {
        dbg("already applied, skipping");
        return;
    }

    const createPatcher = window.__pfCreateWebkitPropertyPatcher;
    if (!createPatcher) {
        dbg("prefix helper missing, skipping");
        return;
    }

    const patcher = createPatcher({
        properties: ["backdrop-filter"],
        detectProperty: "backdrop-filter",
        detectValue: "blur(1px)",
        quickTest: /(?:^|[;{])\s*backdrop-filter\s*:/m,
        webkitOnly: true,
    });

    if (!patcher.needsPolyfill()) {
        dbg("native backdrop-filter supported — polyfill not needed");
        return;
    }

    window.__webkitBackdropFilterPolyfillApplied = true;
    dbg("polyfill active");

    const patchText = patcher.patchText;
    window.__pfPatchBackdropFilterInCSS = patchText;

    function isPolyfillInjectedStyle(node) {
        return !!(
            node &&
            (node.getAttribute("data-css-layers-polyfill") != null ||
                node.getAttribute("data-color-mix-polyfill") != null ||
                (node.id && node.id.indexOf("css-layers-src-") === 0) ||
                (node.id && node.id.indexOf("oklch-") === 0) ||
                (node.id && node.id.indexOf("patched-") === 0) ||
                (node.id && node.id.indexOf("backdrop-supplement-") === 0) ||
                (node.id && node.id.indexOf("color-mix-") === 0))
        );
    }

    const processedStyleNodes = new WeakMap();
    const processedLinks = new WeakMap();
    const supplementNodes = new WeakMap();

    const backdropDeclPattern =
        /(?:^|;)(\s*)(?!-webkit-)backdrop-filter\s*:\s*([^;}]*)|^\s*(?!-webkit-)backdrop-filter\s*:\s*([^;}]*)$/gm;

    function extractSupplementalBackdropStylesheet(css) {
        if (!css || /@layer/i.test(css) || !patcher.quickTest.test(css)) {
            return "";
        }

        var parts = [];
        var openIdx = 0;

        while (openIdx < css.length) {
            var ruleOpen = css.indexOf("{", openIdx);
            if (ruleOpen === -1) break;
            var ruleClose = css.indexOf("}", ruleOpen);
            if (ruleClose === -1) break;

            var selector = css.slice(openIdx, ruleOpen).trim();
            var block = css.slice(ruleOpen + 1, ruleClose);
            var decls = [];

            block.replace(backdropDeclPattern, function (_m, s1, v1, v2) {
                decls.push("-webkit-backdrop-filter: " + (v1 || v2));
                return _m;
            });

            if (decls.length && selector.indexOf("@") !== 0) {
                parts.push(selector + "{" + decls.join(";") + "}");
            }

            openIdx = ruleClose + 1;
        }

        return parts.join("\n");
    }

    function injectSupplementalBackdropStyle(anchor, css) {
        if (!anchor || !anchor.parentNode || !css) return;

        var existing = supplementNodes.get(anchor);
        if (existing && existing.parentNode) {
            if (existing.textContent === css) return;
            existing.textContent = css;
            dbg("updated supplemental backdrop stylesheet for", anchor.id || anchor.tagName);
            return;
        }

        var styleNode = document.createElement("style");
        styleNode.setAttribute("data-webkit-backdrop-polyfill", "");
        styleNode.textContent = css;
        if (anchor.id) styleNode.id = "backdrop-supplement-" + anchor.id;
        anchor.parentNode.insertBefore(styleNode, anchor.nextSibling);
        supplementNodes.set(anchor, styleNode);
        dbg("injected supplemental backdrop stylesheet for", anchor.id || anchor.tagName);
    }

    function processStyleNode(node) {
        if (!node || node.tagName !== "STYLE" || isPolyfillInjectedStyle(node)) {
            return;
        }
        const txt = node.textContent;
        if (processedStyleNodes.get(node) === txt) return;
        processedStyleNodes.set(node, txt);

        var supplemental = extractSupplementalBackdropStylesheet(txt);
        if (supplemental) {
            injectSupplementalBackdropStyle(node, supplemental);
        }
    }

    function processLinkNode(link) {
        if (!link || link.tagName !== "LINK" || link.rel !== "stylesheet" || !link.href) {
            return;
        }
        if (processedLinks.get(link) === link.href) return;
        processedLinks.set(link, link.href);
        const href = link.href;
        fetch(href)
            .then(function (res) {
                if (!res.ok) throw new Error("status " + res.status);
                return res.text();
            })
            .then(function (css) {
                if (/@layer/i.test(css)) {
                    dbg("skipping @layer link (css-layers owns this sheet):", href);
                    return;
                }
                if (!/(?:^|[;{])\s*backdrop-filter\s*:/m.test(css)) return;
                var supplemental = extractSupplementalBackdropStylesheet(css);
                if (!supplemental) return;
                injectSupplementalBackdropStyle(link, supplemental);
                dbg("patched link stylesheet:", href);
            })
            .catch(function (err) {
                dbg("failed to patch link:", href, err.message);
            });
    }

    (function patchCSSStyleDeclaration() {
        const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (prop, val, priority) {
            if (prop === "backdrop-filter") {
                origSetProperty.call(this, "-webkit-backdrop-filter", val, priority);
            }
            return origSetProperty.call(this, prop, val, priority);
        };
    })();

    function processAll() {
        document.querySelectorAll("style").forEach(processStyleNode);
        document.querySelectorAll('link[rel="stylesheet"]').forEach(processLinkNode);
    }

    function setupMutationListener() {
        if (!window.__pfRegisterMutationListener) return;
        window.__pfRegisterMutationListener(function (mutations) {
            for (let m = 0; m < mutations.length; m++) {
                const mutation = mutations[m];
                if (mutation.type !== "childList") continue;
                for (let i = 0; i < mutation.addedNodes.length; i++) {
                    const node = mutation.addedNodes[i];
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === "STYLE") processStyleNode(node);
                    else if (node.tagName === "LINK" && node.rel === "stylesheet") {
                        processLinkNode(node);
                    } else {
                        const styles =
                            node.querySelectorAll && node.querySelectorAll("style");
                        if (styles) styles.forEach(processStyleNode);
                        const links =
                            node.querySelectorAll &&
                            node.querySelectorAll('link[rel="stylesheet"]');
                        if (links) links.forEach(processLinkNode);
                    }
                }
            }
        });
    }

    processAll();
    setupMutationListener();
})();
