if (typeof Map !== 'undefined') {
    function defineMapMethod(name, fn) {
        if (!Map.prototype[name]) {
            Object.defineProperty(Map.prototype, name, {
                value: fn,
                writable: true,
                configurable: true
            });
        }
    }

    defineMapMethod('getOrInsert', function (key, value) {
        if (this.has(key)) return this.get(key);

        this.set(key, value);
        return value;
    });

    defineMapMethod('getOrInsertComputed', function (key, callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a function');
        if (this.has(key)) return this.get(key);

        const value = callback(key);
        this.set(key, value);
        return value;
    });
}
