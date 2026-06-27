// https://github.com/WICG/visual-viewport
// Polyfills window.visualViewport for browsers without the CSSOM View API.
(function () {
    var DUMMY_FRAME_ATTR = "data-pf-vv-dummy";

    // This polyfill is injected into every frame (forMainFrameOnly:NO),
    // including the hidden iframe we create below. Bail out inside that
    // iframe so it doesn't recursively spawn more iframes.
    function isDummyFrame() {
        try {
            var fe = window.frameElement;
            return !!(
                fe &&
                fe.getAttribute &&
                fe.getAttribute(DUMMY_FRAME_ATTR) === "1"
            );
        } catch (e) {
            return false;
        }
    }

    if (isDummyFrame()) return;

    function needsPolyfill() {
        var vv = window.visualViewport;
        if (!vv) return true;
        return (
            typeof vv.offsetLeft !== "number" ||
            typeof vv.offsetTop !== "number" ||
            typeof vv.width !== "number" ||
            typeof vv.height !== "number" ||
            typeof vv.scale !== "number" ||
            typeof vv.pageLeft !== "number" ||
            typeof vv.pageTop !== "number"
        );
    }

    if (!needsPolyfill()) return;

    var isChrome = navigator.userAgent.indexOf("Chrome") > -1;
    var isSafari = navigator.userAgent.indexOf("Safari") > -1;
    var isIEEdge = navigator.userAgent.indexOf("Edge") > -1;
    if (isChrome && isSafari) isSafari = false;

    var layoutDummy = document.createElement("div");
    layoutDummy.style.width = "100%";
    layoutDummy.style.height = "100%";
    layoutDummy.style.position = isSafari ? "fixed" : "absolute";
    layoutDummy.style.left = "0px";
    layoutDummy.style.top = "0px";
    layoutDummy.style.visibility = "hidden";
    layoutDummy.style.pointerEvents = "none";

    window.viewPolyfill = {
        offsetLeftSinceLastChange: null,
        offsetTopSinceLastChange: null,
        widthSinceLastChange: null,
        heightSinceLastChange: null,
        scaleSinceLastChange: null,
        scrollEventListeners: [],
        resizeEventListeners: [],
        layoutDummy: layoutDummy,
        iframeDummy: null,
        iframeReady: false,
        unscaledInnerWidth: window.innerWidth || 0,
        unscaledInnerHeight: window.innerHeight || 0,
        initialized: false,
        handlersRegistered: false,
        measuring: false,
        unscaledUpdateScheduled: false,
        pollId: null,
        onscroll: null,
        onresize: null,
    };

    function layoutDummyRect() {
        if (!window.viewPolyfill.layoutDummy.parentNode) {
            return { left: 0, top: 0 };
        }
        return window.viewPolyfill.layoutDummy.getBoundingClientRect();
    }

    function getScale() {
        var unscaledWidth = window.viewPolyfill.unscaledInnerWidth;
        var innerWidth = window.innerWidth;
        if (!unscaledWidth || !innerWidth) return 1;
        return unscaledWidth / innerWidth;
    }

    function getOffsetLeft() {
        var rect = layoutDummyRect();
        var scale = getScale();
        if (isSafari) {
            return (
                window.scrollX -
                (rect.left * scale + window.scrollX * scale)
            );
        }
        return window.scrollX + rect.left;
    }

    function getOffsetTop() {
        var rect = layoutDummyRect();
        var scale = getScale();
        if (isSafari) {
            return (
                window.scrollY -
                (rect.top * scale + window.scrollY * scale)
            );
        }
        return window.scrollY + rect.top;
    }

    function getWidth() {
        var clientWidth = document.documentElement.clientWidth;
        var scale = getScale();
        if (isIEEdge) {
            if (
                document.documentElement.clientWidth ==
                    window.viewPolyfill.unscaledInnerWidth &&
                scale > 1
            ) {
                var oldWidth = document.documentElement.clientWidth;
                var prevHeight = layoutDummy.style.height;
                layoutDummy.style.height = "200%";
                var scrollbarWidth =
                    oldWidth - document.documentElement.clientWidth;
                layoutDummy.style.height = prevHeight;
                clientWidth -= scrollbarWidth;
            }
        }
        return clientWidth / scale;
    }

    function getHeight() {
        var clientHeight = document.documentElement.clientHeight;
        var scale = getScale();
        if (isIEEdge) {
            if (
                document.documentElement.clientHeight ==
                    window.viewPolyfill.unscaledInnerHeight &&
                scale > 1
            ) {
                var oldHeight = document.documentElement.clientHeight;
                var prevWidth = layoutDummy.style.width;
                layoutDummy.style.width = "200%";
                var scrollbarHeight =
                    oldHeight - document.documentElement.clientHeight;
                layoutDummy.style.width = prevWidth;
                clientHeight -= scrollbarHeight;
            }
        }
        return clientHeight / scale;
    }

    function getIframeDocument(iframe) {
        try {
            return (
                iframe.contentDocument ||
                (iframe.contentWindow && iframe.contentWindow.document)
            );
        } catch (e) {
            return null;
        }
    }

    function ensureIframeBody(iframeDocument) {
        if (!iframeDocument) return null;
        if (iframeDocument.body) return iframeDocument.body;

        var body = iframeDocument.createElement("body");
        body.style.margin = "0px";
        body.style.padding = "0px";

        if (iframeDocument.documentElement) {
            iframeDocument.documentElement.appendChild(body);
        } else {
            var html = iframeDocument.createElement("html");
            html.appendChild(body);
            iframeDocument.appendChild(html);
        }

        return body;
    }

    function measureUnscaledDimensions() {
        if (window.viewPolyfill.measuring) return;

        var iframe = window.viewPolyfill.iframeDummy;
        if (!iframe || !window.viewPolyfill.iframeReady) return;

        var iframeDocument = getIframeDocument(iframe);
        var iframeBody = ensureIframeBody(iframeDocument);
        var iframeWindow = iframe.contentWindow;
        if (!iframeBody || !iframeWindow) return;

        window.viewPolyfill.measuring = true;
        try {
            var documentRect = document.documentElement.getBoundingClientRect();
            iframeBody.style.width = documentRect.width + "px";
            iframeBody.style.height = documentRect.height + "px";

            var prevDocumentOverflow = document.documentElement.style.overflow;
            document.documentElement.style.overflow = "hidden";

            window.viewPolyfill.unscaledInnerWidth = iframeWindow.innerWidth;
            window.viewPolyfill.unscaledInnerHeight = iframeWindow.innerHeight;

            document.documentElement.style.overflow = prevDocumentOverflow;
        } finally {
            window.viewPolyfill.measuring = false;
        }
    }

    // Hacky but necessary to read innerWidth/Height without page scale applied.
    function ensureIframeDummy() {
        if (window.viewPolyfill.iframeDummy || !document.body) {
            return;
        }

        var iframe = document.createElement("iframe");
        iframe.style.position = "fixed";
        iframe.style.width = "0px";
        iframe.style.height = "0px";
        iframe.style.left = "0px";
        iframe.style.top = "0px";
        iframe.style.border = "0";
        iframe.style.visibility = "hidden";
        iframe.style.pointerEvents = "none";
        iframe.setAttribute("tabindex", "-1");
        iframe.setAttribute("aria-hidden", "true");
        iframe.setAttribute(DUMMY_FRAME_ATTR, "1");

        iframe.onload = function () {
            if (window.viewPolyfill.iframeReady) return;
            ensureIframeBody(getIframeDocument(iframe));
            window.viewPolyfill.iframeReady = true;
            measureUnscaledDimensions();
            seedViewportCache();
        };

        window.viewPolyfill.iframeDummy = iframe;
        document.body.appendChild(iframe);

        if ("srcdoc" in iframe) {
            iframe.srcdoc =
                "<!DOCTYPE html><html><body style='margin:0;padding:0'></body></html>";
        } else {
            iframe.src = "about:blank";
        }
    }

    function updateUnscaledDimensions() {
        if (!document.body) return;
        ensureIframeDummy();
        measureUnscaledDimensions();
    }

    function scheduleUnscaledDimensionsUpdate() {
        if (window.viewPolyfill.unscaledUpdateScheduled) return;
        window.viewPolyfill.unscaledUpdateScheduled = true;
        setTimeout(function () {
            window.viewPolyfill.unscaledUpdateScheduled = false;
            updateUnscaledDimensions();
        }, 250);
    }

    function fireScrollEvent() {
        var listeners = window.viewPolyfill.scrollEventListeners.slice();
        for (var i = 0; i < listeners.length; i++) {
            listeners[i]();
        }
        if (typeof window.viewPolyfill.onscroll === "function") {
            window.viewPolyfill.onscroll();
        }
    }

    function fireResizeEvent() {
        var listeners = window.viewPolyfill.resizeEventListeners.slice();
        for (var i = 0; i < listeners.length; i++) {
            listeners[i]();
        }
        if (typeof window.viewPolyfill.onresize === "function") {
            window.viewPolyfill.onresize();
        }
    }

    function seedViewportCache() {
        var vv = window.visualViewport;
        window.viewPolyfill.offsetLeftSinceLastChange = vv.offsetLeft;
        window.viewPolyfill.offsetTopSinceLastChange = vv.offsetTop;
        window.viewPolyfill.widthSinceLastChange = vv.width;
        window.viewPolyfill.heightSinceLastChange = vv.height;
        window.viewPolyfill.scaleSinceLastChange = vv.scale;
    }

    function updateViewportChanged() {
        if (window.viewPolyfill.measuring) return;

        var vv = window.visualViewport;
        var hasBaseline =
            window.viewPolyfill.offsetLeftSinceLastChange !== null;

        var scrollChanged =
            hasBaseline &&
            (window.viewPolyfill.offsetLeftSinceLastChange != vv.offsetLeft ||
                window.viewPolyfill.offsetTopSinceLastChange != vv.offsetTop);
        var sizeChanged =
            hasBaseline &&
            (window.viewPolyfill.widthSinceLastChange != vv.width ||
                window.viewPolyfill.heightSinceLastChange != vv.height ||
                window.viewPolyfill.scaleSinceLastChange != vv.scale);

        window.viewPolyfill.offsetLeftSinceLastChange = vv.offsetLeft;
        window.viewPolyfill.offsetTopSinceLastChange = vv.offsetTop;
        window.viewPolyfill.widthSinceLastChange = vv.width;
        window.viewPolyfill.heightSinceLastChange = vv.height;
        window.viewPolyfill.scaleSinceLastChange = vv.scale;

        if (scrollChanged) fireScrollEvent();
        if (sizeChanged) fireResizeEvent();
    }

    function registerChangeHandlers() {
        if (window.viewPolyfill.handlersRegistered) return;
        window.viewPolyfill.handlersRegistered = true;

        window.addEventListener("scroll", updateViewportChanged, {
            passive: true,
        });
        window.addEventListener("resize", updateViewportChanged, {
            passive: true,
        });
        window.addEventListener("resize", scheduleUnscaledDimensionsUpdate, {
            passive: true,
        });
    }

    function startPolling() {
        if (window.viewPolyfill.pollId) return;
        window.viewPolyfill.pollId = setInterval(updateViewportChanged, 500);
    }

    var viewport = {
        get offsetLeft() {
            return getOffsetLeft();
        },
        get offsetTop() {
            return getOffsetTop();
        },
        get width() {
            return getWidth();
        },
        get height() {
            return getHeight();
        },
        get scale() {
            return getScale();
        },
        get pageLeft() {
            return window.scrollX;
        },
        get pageTop() {
            return window.scrollY;
        },
        get onscroll() {
            return window.viewPolyfill.onscroll;
        },
        set onscroll(value) {
            window.viewPolyfill.onscroll =
                typeof value === "function" ? value : null;
        },
        get onresize() {
            return window.viewPolyfill.onresize;
        },
        set onresize(value) {
            window.viewPolyfill.onresize =
                typeof value === "function" ? value : null;
        },
        addEventListener: function (name, func) {
            if (typeof func !== "function") return;
            if (name === "scroll") {
                if (window.viewPolyfill.scrollEventListeners.indexOf(func) < 0) {
                    window.viewPolyfill.scrollEventListeners.push(func);
                }
            } else if (name === "resize") {
                if (window.viewPolyfill.resizeEventListeners.indexOf(func) < 0) {
                    window.viewPolyfill.resizeEventListeners.push(func);
                }
            }
        },
        removeEventListener: function (name, func) {
            var list =
                name === "scroll"
                    ? window.viewPolyfill.scrollEventListeners
                    : name === "resize"
                      ? window.viewPolyfill.resizeEventListeners
                      : null;
            if (!list) return;
            var index = list.indexOf(func);
            if (index >= 0) list.splice(index, 1);
        },
    };

    window.visualViewport = viewport;

    function initLayout() {
        if (window.viewPolyfill.initialized || !document.body) return;

        document.body.appendChild(layoutDummy);
        ensureIframeDummy();
        seedViewportCache();
        registerChangeHandlers();
        startPolling();
        window.viewPolyfill.initialized = true;
    }

    if (document.body) {
        initLayout();
    } else {
        document.addEventListener("DOMContentLoaded", initLayout);
    }
})();
