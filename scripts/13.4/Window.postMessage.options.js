// window.postMessage(message) and window.postMessage(message, { targetOrigin, transfer }).
// Before Safari 13.1 / iOS 13.4 targetOrigin is a required argument, so both calls throw
// "Not enough arguments" (or treat the options object as an invalid origin string).
// As in the spec, a missing targetOrigin defaults to "/" (same origin only), which older
// WebKit already understands.
// Limitation: a cross-origin WindowProxy exposes the native postMessage, so calls on a
// cross-origin window still need an explicit targetOrigin.
(function (global) {
    var nativePostMessage = global.postMessage;
    if (typeof nativePostMessage !== 'function' || nativePostMessage.length < 2) return;

    // One declared parameter: length is 1 as in newer WebKit, which also stops a second run.
    function postMessage(message) {
        var target = this || global;
        var targetOrigin = arguments[1];
        if (targetOrigin === undefined) {
            return nativePostMessage.call(target, message, '/');
        }
        if (targetOrigin === Object(targetOrigin)) { // options object
            var origin = targetOrigin.targetOrigin === undefined ? '/' : targetOrigin.targetOrigin;
            return nativePostMessage.call(target, message, origin, targetOrigin.transfer || []);
        }
        return arguments.length > 2
            ? nativePostMessage.call(target, message, targetOrigin, arguments[2])
            : nativePostMessage.call(target, message, targetOrigin);
    }

    Object.defineProperty(global, 'postMessage', {
        value: postMessage,
        writable: true,
        enumerable: true,
        configurable: true
    });
})(window);
