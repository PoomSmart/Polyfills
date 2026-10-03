(function () {
    if (!('nonce' in HTMLElement.prototype)) {
        Object.defineProperty(HTMLElement.prototype, 'nonce', {
            get: function () { return this.getAttribute('nonce') || ''; },
            set: function (v) { this.setAttribute('nonce', v); }
        });
    }

    var origAppend = Element.prototype.appendChild;
    var origInsert = Element.prototype.insertBefore;
    var origRemove = Element.prototype.removeChild;
    var pageNonce = '';
    var broken = null;

    function readNonce() {
        var s = document.querySelector('script[nonce]');
        if (!s) return '';
        return s.nonce || s.getAttribute('nonce') || '';
    }

    function isClassic(node) {
        var t = (node.getAttribute('type') || '').replace(/^\s+|\s+$/g, '').toLowerCase();
        return !t || t === 'text/javascript' || t === 'application/javascript' ||
            t === 'text/ecmascript' || t === 'application/ecmascript';
    }

    function nonceOf(node) {
        return (node.nonce || node.getAttribute('nonce') || '');
    }

    function probe() {
        var parent, el;
        if (!pageNonce) return false;
        try {
            window.__pfNonceProbe = 0;
            el = document.createElement('script');
            el.setAttribute('nonce', pageNonce);
            el.text = 'window.__pfNonceProbe=1';
            parent = document.head || document.documentElement;
            origAppend.call(parent, el);
            var failed = window.__pfNonceProbe !== 1;
            origRemove.call(parent, el);
            return failed;
        } catch (e) {
            return false;
        }
    }

    function ensureState() {
        if (!pageNonce) pageNonce = readNonce();
        if (!pageNonce) return false;
        if (broken === null) broken = probe();
        return true;
    }

    function evalInline(node) {
        var code;
        if (!node || node.__pfNonceRan || node.src) return;
        if (!window.__pfBridgeEval) return;
        code = node.textContent || '';
        if (!code) return;
        node.__pfNonceRan = true;
        window.__pfBridgeEval(code);
    }

    function prepare(node) {
        var n;
        if (!node || node.tagName !== 'SCRIPT' || !isClassic(node)) return;
        if (!ensureState()) return;
        n = nonceOf(node);
        if (!n) {
            node.nonce = pageNonce;
            node.setAttribute('nonce', pageNonce);
            n = pageNonce;
        }
        if (broken && n === pageNonce && !node.src) {
            node.setAttribute('type', 'text/pf-nonce');
            evalInline(node);
        }
    }

    Element.prototype.appendChild = function (node) {
        prepare(node);
        return origAppend.call(this, node);
    };

    Element.prototype.insertBefore = function (node, ref) {
        prepare(node);
        return origInsert.call(this, node, ref);
    };

    function scanParserScripts() {
        var list, i, node, n;
        if (!ensureState() || !broken || !window.__pfBridgeEval) return;
        list = document.getElementsByTagName('script');
        for (i = 0; i < list.length; i++) {
            node = list[i];
            if (node.src || node.__pfNonceRan) continue;
            n = nonceOf(node);
            if (n !== pageNonce) continue;
            if (!isClassic(node) && (node.getAttribute('type') || '') !== 'text/pf-nonce') continue;
            evalInline(node);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanParserScripts);
    else scanParserScripts();
})();
