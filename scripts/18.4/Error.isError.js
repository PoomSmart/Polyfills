if (!("isError" in Error)) {
    Object.defineProperty(Error, 'isError', {
        value: function isError(value) {
            if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
                return false;
            }

            // iOS 18.4 introduced Error.isError, but returns false for DOMExceptions.
            // Other browsers return true, so I am doing that...
            const tag = Object.prototype.toString.call(value);
            if (tag === '[object DOMException]' || tag === '[object DOMError]' || tag === '[object Exception]') {
                return true;
            }

            const toStringTag = typeof Symbol === 'function' && Symbol.toStringTag;
            if (toStringTag && toStringTag in value) {
                return value instanceof Error;
            }

            return tag === '[object Error]';
        },
        writable: true,
        configurable: true
    });
}
