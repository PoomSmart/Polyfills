(function () {
    // https://gist.github.com/gtrabanco/7c97bd41aa74af974fa935bfb5044b6e
    const hasGroup = typeof Object.groupBy === typeof undefined || typeof Array.groupToMap === typeof undefined || typeof Array.group === typeof undefined;
    if (!hasGroup) {
        const groupBy = (arr, callback) => {
            return arr.reduce((acc = {}, ...args) => {
                const key = callback(...args);
                acc[key] ??= []
                acc[key].push(args[0]);
                return acc;
            }, {});
        };

        if (typeof Object.groupBy === typeof undefined) {
            Object.groupBy = groupBy;
        }

        if (typeof Array.groupToMap === typeof undefined) {
            Array.groupToMap = groupBy;
        }

        if (typeof Array.group === typeof undefined) {
            Array.group = groupBy;
        }
    }

    // https://github.com/jimmywarting/groupby-polyfill
    if (typeof Map.groupBy === typeof undefined) {
        Map.groupBy = function groupBy(iterable, callbackfn) {
            const map = new Map();
            let i = 0;
            for (const value of iterable) {
                const key = callbackfn(value, i++), list = map.get(key);
                if (list)
                    list.push(value)
                else
                    map.set(key, [value]);
            }
            return map;
        }
    }
})();
