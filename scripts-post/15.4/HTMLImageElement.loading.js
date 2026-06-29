// https://github.com/mfranzke/loading-attribute-polyfill
// Upstream expects lazy media inside <noscript class="loading-lazy">. Bare
// img[loading="lazy"] / iframe[loading="lazy"] are auto-wrapped before defer.
//
// iOS 15.0–15.3: WebKit exposes loading on HTMLImageElement but lazy loading
// (especially with srcset) is unreliable; IntersectionObserver also often skips
// the initial callback for already-visible nodes inside iframes. This file only
// loads on iOS < 15.4, so we always defer and eagerly restore in-viewport items.
(function () {
    /*
     * Loading attribute polyfill - https://github.com/mfranzke/loading-attribute-polyfill
     * @license Copyright(c) 2019 by Maximilian Franzke
     */

    var config = {
        intersectionObserver: {
            rootMargin: '0px 0px 256px 0px',
            threshold: 0.01,
        },
        lazyImage: 'img[loading="lazy"]',
        lazyIframe: 'iframe[loading="lazy"]',
    };

    var bareLazySelector =
        config.lazyImage + ',' + config.lazyIframe;

    var pendingLazySelector =
        config.lazyImage +
        '[data-lazy-src],' +
        config.lazyImage +
        '[data-lazy-srcset],' +
        config.lazyIframe +
        '[data-lazy-src]';

    // Skip defer for non-scrolling UAs (e.g. search-engine crawlers).
    var supportsScrolling = 'onscroll' in window;

    var intersectionObserver;

    if ('IntersectionObserver' in window) {
        intersectionObserver = new IntersectionObserver(
            onIntersection,
            config.intersectionObserver
        );
    }

    function placeholderSvg(width, height) {
        return (
            'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 ' +
            width +
            ' ' +
            height +
            '%27%3E%3C/svg%3E'
        );
    }

    function dimensionsFromHtml(html) {
        var widthMatch = html.match(/width=['"](\d+)['"]/);
        var heightMatch = html.match(/height=['"](\d+)['"]/);
        var sizesMatch = html.match(/sizes=['"](\d+)/);
        var sizeFromSizes = sizesMatch && sizesMatch[1];
        return {
            width: (widthMatch && widthMatch[1]) || sizeFromSizes || 1,
            height: (heightMatch && heightMatch[1]) || sizeFromSizes || 1,
        };
    }

    function observedElement(element) {
        if (
            element.tagName &&
            element.tagName.toLowerCase() === 'picture'
        ) {
            return element.querySelector('img');
        }
        return element;
    }

    function isNearViewport(element) {
        if (!element || !element.getBoundingClientRect) {
            return false;
        }

        var rect = element.getBoundingClientRect();
        var margin = 256;
        var viewHeight =
            window.innerHeight || document.documentElement.clientHeight || 0;
        var viewWidth =
            window.innerWidth || document.documentElement.clientWidth || 0;

        return (
            rect.bottom > -margin &&
            rect.right > 0 &&
            rect.top < viewHeight + margin &&
            rect.left < viewWidth
        );
    }

    function hasPendingLazySource(element) {
        return (
            element &&
            (element.hasAttribute('data-lazy-src') ||
                element.hasAttribute('data-lazy-srcset'))
        );
    }

    function restoreSource(lazyItem) {
        if (!lazyItem || !hasPendingLazySource(lazyItem)) {
            return;
        }

        var srcsetItems = [];

        if (
            lazyItem.parentNode &&
            lazyItem.parentNode.tagName.toLowerCase() === 'picture'
        ) {
            removePlaceholderSource(lazyItem.parentNode);
            srcsetItems = Array.prototype.slice.call(
                lazyItem.parentNode.querySelectorAll('source')
            );
        }

        srcsetItems.push(lazyItem);

        srcsetItems.forEach(function (item) {
            if (item.hasAttribute('data-lazy-srcset')) {
                item.setAttribute('srcset', item.getAttribute('data-lazy-srcset'));
                item.removeAttribute('data-lazy-srcset');
            }
        });

        if (lazyItem.hasAttribute('data-lazy-src')) {
            lazyItem.setAttribute('src', lazyItem.getAttribute('data-lazy-src'));
            lazyItem.removeAttribute('data-lazy-src');
        }

        if (lazyItem.getAttribute('loading') === 'lazy') {
            lazyItem.removeAttribute('loading');
        }
    }

    function removePlaceholderSource(lazyItemPicture) {
        var placeholderSource = lazyItemPicture.querySelector(
            'source[data-lazy-remove]'
        );

        if (placeholderSource) {
            lazyItemPicture.removeChild(placeholderSource);
        }
    }

    function onIntersection(entries, observer) {
        entries.forEach(function (entry) {
            if (entry.intersectionRatio === 0) {
                return;
            }

            var lazyItem = entry.target;
            observer.unobserve(lazyItem);
            restoreSource(lazyItem);
        });
    }

    var pendingRestoreScheduled = false;
    var pendingRestoreBound = false;

    function checkPendingLazyItems() {
        document.querySelectorAll(pendingLazySelector).forEach(function (lazyItem) {
            if (!hasPendingLazySource(lazyItem) || !isNearViewport(lazyItem)) {
                return;
            }

            if (intersectionObserver) {
                intersectionObserver.unobserve(lazyItem);
            }

            restoreSource(lazyItem);
        });
    }

    function schedulePendingRestoreCheck() {
        if (pendingRestoreScheduled) {
            return;
        }

        pendingRestoreScheduled = true;

        requestAnimationFrame(function () {
            pendingRestoreScheduled = false;
            checkPendingLazyItems();
        });
    }

    function bindPendingRestoreListeners() {
        if (pendingRestoreBound || !supportsScrolling) {
            return;
        }

        pendingRestoreBound = true;
        window.addEventListener('scroll', schedulePendingRestoreCheck, true);
        window.addEventListener('resize', schedulePendingRestoreCheck, true);
    }

    function observeLazyItem(element) {
        var target = observedElement(element);
        if (!target || !intersectionObserver) {
            return;
        }

        intersectionObserver.observe(target);
        schedulePendingRestoreCheck();
    }

    function onPrinting() {
        if (window.matchMedia === undefined) {
            return;
        }

        window.matchMedia('print').addListener(function (mql) {
            if (!mql.matches) {
                return;
            }

            document.querySelectorAll(pendingLazySelector).forEach(restoreSource);
        });
    }

    function getAndPrepareHTMLCode(noScriptTag) {
        var lazyAreaHtml = noScriptTag.textContent || noScriptTag.innerHTML;
        var dims = dimensionsFromHtml(lazyAreaHtml);
        var placeholder = placeholderSvg(dims.width, dims.height);

        if (
            supportsScrolling &&
            (/<img/gim.test(lazyAreaHtml) || /<iframe/gim.test(lazyAreaHtml))
        ) {
            if (intersectionObserver === undefined) {
                lazyAreaHtml = lazyAreaHtml.replace(
                    /(?:\r\n|\r|\n|\t| )src=/g,
                    ' lazyload="1" src='
                );
            } else {
                lazyAreaHtml = lazyAreaHtml.replace(
                    '<source',
                    '<source srcset="' +
                        placeholder +
                        '" data-lazy-remove="true"></source>\n<source'
                );

                lazyAreaHtml = lazyAreaHtml
                    .replace(/(?:\r\n|\r|\n|\t| )srcset=/g, ' data-lazy-srcset=')
                    .replace(
                        /(?:\r\n|\r|\n|\t| )src=/g,
                        ' src="' + placeholder + '" data-lazy-src='
                    );
            }
        }

        return lazyAreaHtml;
    }

    function shouldObserveLazyTag(tagName) {
        tagName = tagName.toLowerCase();
        return (
            tagName === 'img' ||
            tagName === 'picture' ||
            tagName === 'iframe'
        );
    }

    function prepareElement(noScriptTag) {
        if (!noScriptTag || !noScriptTag.parentNode) {
            return;
        }

        var lazyArea = document.createElement('div');
        lazyArea.innerHTML = getAndPrepareHTMLCode(noScriptTag);

        while (lazyArea.firstChild) {
            var actualChild = lazyArea.firstChild;
            var parent = noScriptTag.parentNode;

            if (!parent) {
                break;
            }

            parent.insertBefore(actualChild, noScriptTag);

            if (
                supportsScrolling &&
                intersectionObserver !== undefined &&
                actualChild.tagName &&
                shouldObserveLazyTag(actualChild.tagName)
            ) {
                observeLazyItem(actualChild);
            }
        }

        if (noScriptTag.parentNode) {
            noScriptTag.parentNode.removeChild(noScriptTag);
        }
    }

    function findBareLazyRoots(root) {
        var roots = [];
        var seen = [];

        (root || document).querySelectorAll(bareLazySelector).forEach(function (item) {
            var rootElement = item;
            var tagName = item.tagName.toLowerCase();

            if (item.closest('noscript')) {
                return;
            }

            if (
                item.hasAttribute('data-lazy-src') ||
                item.hasAttribute('data-lazy-srcset')
            ) {
                return;
            }

            if (tagName === 'img') {
                var picture =
                    item.parentNode &&
                    item.parentNode.tagName.toLowerCase() === 'picture'
                        ? item.parentNode
                        : null;
                rootElement = picture || item;
            }

            if (seen.indexOf(rootElement) >= 0) {
                return;
            }

            seen.push(rootElement);
            roots.push(rootElement);
        });

        return roots;
    }

    function wrapInNoscript(element) {
        var parent = element.parentNode;
        if (!parent || !element.outerHTML) {
            return null;
        }

        var noScriptTag = document.createElement('noscript');
        noScriptTag.className = 'loading-lazy';
        noScriptTag.textContent = element.outerHTML;
        parent.insertBefore(noScriptTag, element);
        parent.removeChild(element);
        return noScriptTag;
    }

    function wrapBareLazyElements(root) {
        findBareLazyRoots(root).forEach(function (element) {
            var noScriptTag = wrapInNoscript(element);
            if (noScriptTag) {
                prepareElement(noScriptTag);
            }
        });
    }

    function prepareAll(root) {
        var scope = root || document;
        wrapBareLazyElements(scope);
        scope.querySelectorAll('noscript.loading-lazy').forEach(prepareElement);
        onPrinting();
    }

    function watchForLazyElements() {
        if (!('MutationObserver' in window)) {
            return;
        }

        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                Array.prototype.forEach.call(mutation.addedNodes, function (node) {
                    if (node.nodeType !== 1) {
                        return;
                    }

                    if (
                        node.matches &&
                        node.matches('noscript.loading-lazy') &&
                        node.parentNode
                    ) {
                        prepareElement(node);
                        return;
                    }

                    wrapBareLazyElements(node);

                    if (node.querySelectorAll) {
                        node.querySelectorAll('noscript.loading-lazy').forEach(
                            prepareElement
                        );
                    }
                });
            });
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    }

    window.loadingAttributePolyfill = {
        prepareElement: prepareElement,
        prepareLazyItem: function (element) {
            var noScriptTag = wrapInNoscript(element);
            if (noScriptTag) {
                prepareElement(noScriptTag);
            }
        },
        wrapInNoscript: wrapInNoscript,
        restoreSource: restoreSource,
    };

    var watching = false;

    function init() {
        bindPendingRestoreListeners();
        prepareAll(document);
        schedulePendingRestoreCheck();
        setTimeout(checkPendingLazyItems, 250);
        if (!watching) {
            watchForLazyElements();
            watching = true;
        }
    }

    if (/comp|inter/.test(document.readyState)) {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }

    window.addEventListener('load', init);
})();
