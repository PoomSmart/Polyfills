// Chained prototype hooks so multiple polyfills can intercept the same method.
(function setupPolyfillStyleHooks() {
    if (window.__pfHookPrototype) return;

    window.__pfHookPrototype = function (proto, methodName, handler) {
        if (!proto || !methodName || typeof handler !== "function") return;
        const key = "__pfHooks_" + methodName;
        if (!proto[key]) proto[key] = [];
        const hooks = proto[key];
        if (hooks.indexOf(handler) >= 0) return;
        hooks.push(handler);

        if (proto[methodName] && proto[methodName].__pfHookInstalled) return;

        const original = proto[methodName];
        const wrapped = function () {
            const args = arguments;
            for (let i = 0; i < hooks.length; i++) {
                const result = hooks[i].apply(this, [original].concat(Array.prototype.slice.call(args)));
                if (result !== undefined) return result;
            }
            return original.apply(this, args);
        };
        wrapped.__pfHookInstalled = true;
        proto[methodName] = wrapped;
    };
})();
