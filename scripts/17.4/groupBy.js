if (typeof Object.groupBy === 'undefined' || (typeof Map === 'function' && typeof Map.groupBy === 'undefined')) {
    function define(target, name, value) {
        if (!(name in target)) {
            Object.defineProperty(target, name, {
                value: value,
                writable: true,
                configurable: true
            });
        }
    }

    function requireCallback(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('callback must be a function');
        }
        return callback;
    }

    function requireIterable(items) {
        const iteratorKey = typeof Symbol === 'function' && Symbol.iterator;
        const iterator = items != null && ((iteratorKey && items[iteratorKey]) || items['@@iterator']);
        if (typeof iterator !== 'function') {
            throw new TypeError('items must be iterable');
        }
        return items;
    }

    function toPropertyKey(value) {
        return typeof value === 'symbol' ? value : String(value);
    }

    define(Object, 'groupBy', function groupBy(items, callback) {
        const groups = Object.create(null);
        const callbackfn = requireCallback(callback);
        let index = 0;

        for (const value of requireIterable(items)) {
            const key = toPropertyKey(callbackfn(value, index++));
            if (!(key in groups)) {
                groups[key] = [];
            }
            groups[key].push(value);
        }

        return groups;
    });

    if (typeof Map === 'function') {
        define(Map, 'groupBy', function groupBy(items, callback) {
            const groups = new Map();
            const callbackfn = requireCallback(callback);
            let index = 0;

            for (const value of requireIterable(items)) {
                const key = callbackfn(value, index++);
                const group = groups.get(key);
                if (group) {
                    group.push(value);
                } else {
                    groups.set(key, [value]);
                }
            }

            return groups;
        });
    }
}
