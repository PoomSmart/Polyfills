(function polyfillCSSLayer() {
    var __PF_DEBUG__ = false;
    const LOG = "[css-layers]";
    function dbg() {
        if (!__PF_DEBUG__) return;
        try {
            console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        } catch (_) {}
    }

    if (window.__cssLayersPolyfillApplied) return;
    window.__cssLayersPolyfillApplied = true;

    const processedSheetSignatures = new Map();
    const layerUpdateListeners = [];

    window.__pfOnCssLayersUpdate = function (listener) {
        if (typeof listener === "function") {
            layerUpdateListeners.push(listener);
        }
    };

    let layerUpdateTimer = null;
    function notifyLayerUpdate() {
        clearTimeout(layerUpdateTimer);
        layerUpdateTimer = setTimeout(function () {
            for (let i = 0; i < layerUpdateListeners.length; i++) {
                try {
                    layerUpdateListeners[i]();
                } catch (_) {}
            }
        }, 50);
    }

    // Parsing utilities
    function cleanCSS(css) {
        return parseBlocks(css).join('');
    }

    function parseBlocks(css, startIndex = 0) {
        const output = [];
        let buffer = '';
        let i = startIndex;

        while (i < css.length) {
            if (css.startsWith('@layer', i)) {
                if (buffer.trim()) output.push(buffer);
                buffer = '';

                i += 6;
                // Skip layer name list (supports `@layer a, b, c {`)
                while (i < css.length && css[i] !== '{') i++;

                if (i < css.length && css[i] === '{') {
                    const { blockContent, endIndex } = extractBlock(css, i);
                    const inner = parseBlocks(blockContent).join('');
                    output.push(inner);
                    i = endIndex;
                    continue;
                } else {
                    // If we can't find '{', treat as regular text and continue safely
                    buffer += '@layer';
                    if (i >= css.length) break;
                    // Don't continue without incrementing i
                }
            }

            if (css[i] === '{') {
                const selector = buffer.trim();
                buffer = '';

                const { blockContent, endIndex } = extractBlock(css, i);
                const nested = parseBlocks(blockContent).join('');

                if (selector.includes('::backdrop')) {
                    i = endIndex;
                    continue;
                }

                const cleanedSelector = selector
                    .split(',')
                    .map(s => s.trim())
                    .filter(s => s && !s.includes('::backdrop'))
                    .join(', ');

                if (cleanedSelector) {
                    output.push(`${cleanedSelector} {${nested}}`);
                }

                i = endIndex;
            } else {
                buffer += css[i++];
            }
        }

        if (buffer.trim()) output.push(buffer);
        return output;
    }

    function extractBlock(css, startIndex) {
        let i = startIndex;
        let depth = 0;
        const maxLen = css.length;
        i++; // skip initial {
        const blockStart = i;

        // Add iteration limit as safety measure
        let iterations = 0;
        const maxIterations = maxLen * 2; // Reasonable upper bound

        while (i < maxLen && iterations < maxIterations) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') {
                if (depth === 0) break;
                depth--;
            }
            i++;
            iterations++;
        }

        if (i >= maxLen) {
            console.warn('⚠️ Unclosed CSS block detected');
            return {
                blockContent: css.slice(blockStart),
                endIndex: maxLen
            };
        }

        if (iterations >= maxIterations) {
            console.warn('⚠️ CSS parsing iteration limit reached, possible infinite loop prevented');
            return {
                blockContent: css.slice(blockStart, i),
                endIndex: i
            };
        }

        const blockContent = css.slice(blockStart, i);
        return { blockContent, endIndex: i + 1 };
    }

    function hashString(input) {
        let h = 0;
        for (let i = 0; i < input.length; i++) {
            h = ((h << 5) - h + input.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36);
    }

    function injectStyle(css, id, sourceKey) {
        const resolvedId = id || `css-layers-${hashString(css)}`;
        const sourceHash = hashString(css);
        const existingByHash = document.querySelector(
            'style[data-css-layers-polyfill][data-css-layers-source-hash="' + sourceHash + '"]'
        );
        if (existingByHash) {
            return existingByHash;
        }
        let style = document.getElementById(resolvedId);
        if (style) {
            if (style.dataset.cssLayersSourceHash === sourceHash) {
                return style;
            }
            style.dataset.cssLayersSourceHash = sourceHash;
            delete style.dataset.pfColorMixOrig;
            style.textContent = css;
            dbg("Updated injected stylesheet", resolvedId, "bytes=", css.length);
            notifyLayerUpdate();
            return style;
        }
        style = document.createElement('style');
        style.id = resolvedId;
        style.dataset.cssLayersSourceHash = sourceHash;
        style.setAttribute('data-css-layers-polyfill', '');
        style.textContent = css;
        document.head.appendChild(style);
        dbg("Injected flattened stylesheet", resolvedId, "bytes=", css.length);
        notifyLayerUpdate();
        return style;
    }

    function processLayeredCSS(cssText, sourceKey) {
        if (!cssText || !/@layer/i.test(cssText)) return false;
        let cleaned = cleanCSS(cssText);
        if (!cleaned.trim()) return false;
        if (
            window.__pfPatchMaskInCSS &&
            /(?:^|[;{])\s*(?:-webkit-)?mask(?:-(?:image|size|repeat|position|origin|clip|composite|mode))?\s*:/m.test(
                cleaned
            )
        ) {
            cleaned = window.__pfPatchMaskInCSS(cleaned);
        }
        if (
            window.__pfPatchBackdropFilterInCSS &&
            /(?:^|[;{])\s*backdrop-filter\s*:/m.test(cleaned)
        ) {
            cleaned = window.__pfPatchBackdropFilterInCSS(cleaned);
        }
        // if (
        //     window.__pfPatchContentVisibilityInCSS &&
        //     /content-visibility\s*:/i.test(cleaned)
        // ) {
        //     cleaned = window.__pfPatchContentVisibilityInCSS(cleaned);
        // }
        const id = sourceKey
            ? `css-layers-src-${hashString(sourceKey)}`
            : `css-layers-${hashString(cleaned)}`;
        injectStyle(cleaned, id, sourceKey);
        return true;
    }

    function getStyleSheetText(sheet) {
        try {
            // Try to access cssRules directly (bypasses CSP for already-loaded stylesheets)
            const rules = Array.from(sheet.cssRules || sheet.rules || []);
            return rules.map(rule => rule.cssText).join('\n');
        } catch (e) {
            // Cross-origin or other access restriction
            return null;
        }
    }

    function normalizeStylesheetHref(href) {
        try {
            return new URL(href, location.href).href;
        } catch (_) {
            return href;
        }
    }

    function fetchStylesheetText(href) {
        const normalizedHref = normalizeStylesheetHref(href);
        const cache = window.__pfFetchCache;
        if (cache && !cache.has(normalizedHref)) {
            cache.set(
                normalizedHref,
                fetch(normalizedHref, { mode: "cors" })
                    .then((r) => {
                        if (!r.ok) {
                            throw new Error(`Failed to fetch ${normalizedHref}`);
                        }
                        return r.text();
                    })
                    .catch((e) => {
                        cache.delete(normalizedHref);
                        console.warn(
                            `❌ Could not fetch stylesheet at ${normalizedHref}`,
                            e
                        );
                        return null;
                    })
            );
        }
        if (cache) {
            return cache.get(normalizedHref);
        }
        return fetch(normalizedHref, { mode: "cors" })
            .then((r) => {
                if (!r.ok) {
                    throw new Error(`Failed to fetch ${normalizedHref}`);
                }
                return r.text();
            })
            .catch((e) => {
                console.warn(
                    `❌ Could not fetch stylesheet at ${normalizedHref}`,
                    e
                );
                return null;
            });
    }

    async function fetchAndInlineStylesheet(href, sheet = null) {
        const normalizedHref = normalizeStylesheetHref(href);

        try {
            const cssText = await fetchStylesheetText(normalizedHref);
            if (cssText && /@layer/i.test(cssText)) {
                dbg("Fetched stylesheet with @layer", normalizedHref);
                return processLayeredCSS(cssText, normalizedHref);
            }
        } catch (e) {
            console.warn(`❌ Could not fetch stylesheet at ${href}`, e);
        }

        // CSSOM fallback when fetch is unavailable or has no @layer text.
        if (sheet) {
            const cssText = getStyleSheetText(sheet);
            if (cssText && /@layer/i.test(cssText)) {
                return processLayeredCSS(cssText, normalizedHref);
            }
        }

        return false;
    }

    function processInlineStyleNode(styleNode) {
        if (
            !styleNode ||
            styleNode.tagName !== "STYLE" ||
            styleNode.hasAttribute("data-css-layers-polyfill") ||
            (styleNode.id && styleNode.id.indexOf("css-layers-src-") === 0) ||
            styleNode.id?.startsWith("skip-polyfill-") ||
            !styleNode.textContent.includes("@layer")
        ) {
            return;
        }

        const original = styleNode.textContent;
        if (original.length > 200000) {
            const existing = document.querySelectorAll(
                "style[data-css-layers-polyfill]"
            );
            for (let i = 0; i < existing.length; i++) {
                const len = (existing[i].textContent || "").length;
                if (Math.abs(len - original.length) < 2000) {
                    return;
                }
            }
        }
        const inlineId = styleNode.id || hashString(original);
        const signature = `inline::${inlineId}::${original.length}`;
        if (processedSheetSignatures.get(inlineId) === signature) {
            return;
        }

        const cleaned = cleanCSS(original);
        if (cleaned.trim()) {
            processLayeredCSS(original, signature);
        }
        processedSheetSignatures.set(inlineId, signature);
    }

    function canFetchStylesheetHref(href, link) {
        try {
            const sheetOrigin = new URL(href, location.href).origin;
            const pageOrigin = location.origin;
            return (
                sheetOrigin === pageOrigin ||
                (link &&
                    (link.crossOrigin === "anonymous" || link.crossOrigin === ""))
            );
        } catch (_) {
            return false;
        }
    }

    async function processStyleSheets() {
        const seen = new WeakSet();
        const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
        let injected = 0;

        for (const sheet of document.styleSheets) {
            if (seen.has(sheet)) continue;
            seen.add(sheet);

            if (sheet.href) {
                const normalizedHref = normalizeStylesheetHref(sheet.href);
                const link = links.find((l) => {
                    try {
                        return (
                            normalizeStylesheetHref(l.href) === normalizedHref
                        );
                    } catch (_) {
                        return l.href === sheet.href;
                    }
                });

                const cssText = getStyleSheetText(sheet);

                if (canFetchStylesheetHref(normalizedHref, link)) {
                    const signature = `${normalizedHref}::fetch`;
                    if (processedSheetSignatures.get(normalizedHref) !== signature) {
                        if (await fetchAndInlineStylesheet(normalizedHref, sheet)) {
                            injected++;
                        }
                        processedSheetSignatures.set(normalizedHref, signature);
                    }
                } else if (cssText && /@layer/i.test(cssText)) {
                    const signature = `${normalizedHref}::${cssText.length}`;
                    if (processedSheetSignatures.get(normalizedHref) !== signature) {
                        if (processLayeredCSS(cssText, normalizedHref)) {
                            injected++;
                        }
                        processedSheetSignatures.set(normalizedHref, signature);
                    }
                } else if (link) {
                    dbg("Skipping cross-origin stylesheet without CORS:", normalizedHref);
                }
            } else if (
                sheet.ownerNode &&
                sheet.ownerNode.tagName === "STYLE"
            ) {
                processInlineStyleNode(sheet.ownerNode);
            }
        }

        document.querySelectorAll("style").forEach(processInlineStyleNode);
        if (injected) {
            dbg("Flattened @layer rules from", injected, "stylesheet(s)");
        }
    }

    // Register with the shared mutation hub (or fall back to own observer)
    function setupMutationListener() {
        function handleMutations(mutations) {
            let needsProcessing = false;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Check for new style elements
                            if (node.tagName === 'STYLE') {
                                processInlineStyleNode(node);
                            }
                            // Check for new link elements with stylesheets
                            else if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
                                needsProcessing = true;
                            }
                            // Check for nested style/link elements within added nodes
                            else {
                                const styleNodes = node.querySelectorAll && node.querySelectorAll('style');
                                const linkNodes = node.querySelectorAll && node.querySelectorAll('link[rel="stylesheet"]');

                                if (styleNodes) {
                                    for (const styleNode of styleNodes) {
                                        processInlineStyleNode(styleNode);
                                    }
                                }

                                if (linkNodes && linkNodes.length > 0) {
                                    needsProcessing = true;
                                }
                            }
                        }
                    }
                }
                // Watch for attribute changes on link elements (e.g., href changes)
                else if (mutation.type === 'attributes' &&
                    mutation.target.tagName === 'LINK' &&
                    mutation.target.rel === 'stylesheet' &&
                    (mutation.attributeName === 'href' || mutation.attributeName === 'rel')) {
                    needsProcessing = true;
                }
            }

            if (needsProcessing) {
                // Debounce stylesheet processing to avoid excessive calls
                clearTimeout(window.__cssLayersDebounceTimer);
                window.__cssLayersDebounceTimer = setTimeout(() => {
                    processStyleSheets();
                }, 250);
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
                attributeFilter: ['href', 'rel']
            });
        }
    }

    let rescanScheduled = 0;
    const MAX_RESCAN_PASSES = 2;

    function scheduleRescan(delay) {
        if (rescanScheduled >= MAX_RESCAN_PASSES) return;
        rescanScheduled++;
        setTimeout(function () {
            processStyleSheets().finally(function () {
                if (rescanScheduled < MAX_RESCAN_PASSES) {
                    scheduleRescan(delay * 2);
                }
            });
        }, delay);
    }

    // Initial processing — defer one tick so prefix polyfills register patch hooks.
    dbg("CSS @layer polyfill starting");
    setTimeout(function () {
        processStyleSheets().finally(function () {
            scheduleRescan(1000);
        });
    }, 0);
    if (document.readyState !== "complete") {
        window.addEventListener("load", () => processStyleSheets(), { once: true });
    }

    if (window.__pfOnCssLayersUpdate) {
        window.__pfOnCssLayersUpdate(function () {
            processStyleSheets();
        });
    }

    // Register listener for dynamic content
    setupMutationListener();
})();
