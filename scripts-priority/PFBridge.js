// Talks to the native __pfbridge handler (iOS 14+). No-ops when it is absent.
(function () {
    if (window.__pfBridgeGet) return;

    function handler() {
        var webkit = window.webkit;
        var handlers = webkit && webkit.messageHandlers;
        var bridge = handlers && handlers.__pfbridge;
        if (!bridge || typeof bridge.postMessage !== 'function') return null;
        return bridge;
    }

    function rejected(err) {
        return {
            then: function (_ok, fail) {
                if (typeof fail === 'function') fail(err);
                return this;
            }
        };
    }

    function post(body) {
        var bridge = handler();
        if (!bridge) return rejected(new Error('no bridge'));
        return bridge.postMessage(body);
    }

    window.__pfBridgeGet = function (kind, url) {
        return post({ op: 'get', kind: kind, url: url });
    };

    window.__pfBridgePut = function (kind, url, data) {
        return post({ op: 'put', kind: kind, url: url, data: data });
    };

    window.__pfBridgeEval = function (code) {
        return post({ op: 'eval', code: code });
    };
})();
