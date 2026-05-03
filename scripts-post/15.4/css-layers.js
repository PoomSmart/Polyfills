// ChatGPT
(function polyfillCSSLayer() {
    if (window.__cssLayersPolyfillApplied) return;
    window.__cssLayersPolyfillApplied = true;

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
                // Safe character skipping with bounds checking
                while (i < css.length && /\s/.test(css[i])) i++;
                while (i < css.length && /[a-zA-Z0-9_.-]/.test(css[i])) i++;
                while (i < css.length && /\s/.test(css[i])) i++;

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

    function injectStyle(css, id) {
        if (id && document.getElementById(id)) return;
        const style = document.createElement('style');
        if (id) style.id = id;
        style.setAttribute('data-css-layers-polyfill', '');
        style.textContent = css;
        document.head.appendChild(style);
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

    async function fetchAndInlineStylesheet(href, sheet = null) {
        // First try to get content from existing stylesheet object (bypasses CSP)
        if (sheet) {
            const cssText = getStyleSheetText(sheet);
            if (cssText) {
                const cleaned = cleanCSS(cssText);
                injectStyle(cleaned);
                return true;
            }
        }

        // Fallback to fetch (may be blocked by CSP)
        try {
            const res = await fetch(href, { mode: 'cors' });
            if (!res.ok) throw new Error(`Failed to fetch ${href}`);
            const cssText = await res.text();
            const cleaned = cleanCSS(cssText);
            injectStyle(cleaned);
            return true;
        } catch (e) {
            console.warn(`❌ Could not fetch stylesheet at ${href}`, e);
            return false;
        }
    }

    async function processStyleSheets() {
        const seen = new WeakSet();
        const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));

        for (const sheet of document.styleSheets) {
            if (seen.has(sheet)) continue;
            seen.add(sheet);

            if (sheet.href) {
                const link = links.find(l => l.href === sheet.href);
                if (!link) continue;

                // Try to process all stylesheets using direct cssRules access first
                const cssText = getStyleSheetText(sheet);
                if (cssText) {
                    const cleaned = cleanCSS(cssText);
                    if (cleaned.trim()) {
                        injectStyle(cleaned);
                    }
                    continue;
                }

                // Fallback: only attempt fetch for same-origin or CORS-enabled stylesheets
                const sheetOrigin = new URL(sheet.href, location.href).origin;
                const pageOrigin = location.origin;

                if (sheetOrigin === pageOrigin ||
                    link.crossOrigin === 'anonymous' ||
                    link.crossOrigin === '') {
                    await fetchAndInlineStylesheet(sheet.href, null);
                }
            } else if (
                sheet.ownerNode &&
                sheet.ownerNode.tagName === 'STYLE' &&
                !sheet.ownerNode.hasAttribute('data-css-layers-polyfill') &&
                sheet.ownerNode.textContent.includes('@layer') &&
                !sheet.ownerNode.id?.startsWith('skip-polyfill-')
            ) {
                const original = sheet.ownerNode.textContent;
                const cleaned = cleanCSS(original);
                injectStyle(cleaned);
            }
        }
    }

    // Set up MutationObserver to watch for dynamically added styles
    function setupMutationObserver() {
        const observer = new MutationObserver((mutations) => {
            let needsProcessing = false;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Check for new style elements
                            if (node.tagName === 'STYLE') {
                                if (node.textContent.includes('@layer') &&
                                    !node.hasAttribute('data-css-layers-polyfill') &&
                                    !node.id?.startsWith('skip-polyfill-')) {
                                    const cleaned = cleanCSS(node.textContent);
                                    injectStyle(cleaned);
                                }
                            }
                            // Check for new link elements with stylesheets
                            else if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
                                // Process all link stylesheets since we can access them via cssRules
                                needsProcessing = true;
                            }
                            // Check for nested style/link elements within added nodes
                            else {
                                const styleNodes = node.querySelectorAll && node.querySelectorAll('style');
                                const linkNodes = node.querySelectorAll && node.querySelectorAll('link[rel="stylesheet"]');

                                if (styleNodes) {
                                    for (const styleNode of styleNodes) {
                                        if (styleNode.textContent.includes('@layer') &&
                                            !styleNode.hasAttribute('data-css-layers-polyfill') &&
                                            !styleNode.id?.startsWith('skip-polyfill-')) {
                                            const cleaned = cleanCSS(styleNode.textContent);
                                            injectStyle(cleaned);
                                        }
                                    }
                                }

                                if (linkNodes && linkNodes.length > 0) {
                                    // Process all link stylesheets since we can access them via cssRules
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
                }, 100);
            }
        });

        // Start observing
        observer.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href', 'rel']
        });

        return observer;
    }

    // Initial processing
    processStyleSheets();

    // Set up observer for dynamic content
    setupMutationObserver();
})();
