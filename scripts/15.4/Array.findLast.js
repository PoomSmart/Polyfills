if (!Array.prototype.findLast) {
    Object.defineProperty(Array.prototype, 'findLast', {
        value: function (callback, thisArg) {
            if (this == null) {
                throw new TypeError('Array.prototype.findLast called on null or undefined');
            }
            if (typeof callback !== 'function') {
                throw new TypeError('callback must be a function');
            }

            var array = Object(this);
            var length = array.length >>> 0;

            for (var i = length - 1; i >= 0; i--) {
                if (i in array && callback.call(thisArg, array[i], i, array)) {
                    return array[i];
                }
            }

            return undefined;
        },
        writable: true,
        configurable: true
    });
}
