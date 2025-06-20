// https://gist.github.com/topicus/e179b1309e97f1e09e5e
if (!Array.from) {
    Array.from = (function () {
        var iteratorTypes = [
            '[object Map Iterator]', '[object Set Iterator]',
            '[object WeakMap Iterator]', '[object WeakSet Iterator]'
        ];

        var toStr = Object.prototype.toString;
        var isCallable = function (fn) {
            return typeof fn === 'function' || toStr.call(fn) === '[object Function]';
        };
        var toInteger = function (value) {
            var number = Number(value);
            if (isNaN(number)) { return 0; }
            if (number === 0 || !isFinite(number)) { return number; }
            return (number > 0 ? 1 : -1) * Math.floor(Math.abs(number));
        };
        var maxSafeInteger = Math.pow(2, 53) - 1;
        var toLength = function (value) {
            var len = toInteger(value);
            return Math.min(Math.max(len, 0), maxSafeInteger);
        };

        // The length property of the from method is 1.
        return function from(arrayLike/*, mapFn, thisArg */) {
            var iteratee = function (item, k) {
                if (mapFn) {
                    A[k] = typeof T === 'undefined' ? mapFn(item, k) : mapFn.call(T, item, k);
                } else {
                    A[k] = item;
                }
                return k + 1;
            };

            // 1. Let C be the this value.
            var C = this;

            // 2. Let items be ToObject(arrayLike).
            var items = Object(arrayLike);

            // 3. ReturnIfAbrupt(items).
            if (arrayLike == null) {
                throw new TypeError("Array.from requires an array-like object - not null or undefined");
            }

            // 4. If mapfn is undefined, then let mapping be false.
            var mapFn = arguments.length > 1 ? arguments[1] : void undefined;
            var T;
            if (typeof mapFn !== 'undefined') {
                // 5. else
                // 5. a If IsCallable(mapfn) is false, throw a TypeError exception.
                if (!isCallable(mapFn)) {
                    throw new TypeError('Array.from: when provided, the second argument must be a function');
                }

                // 5. b. If thisArg was supplied, let T be thisArg; else let T be undefined.
                if (arguments.length > 2) {
                    T = arguments[2];
                }
            }

            // 13. If IsConstructor(C) is true, then
            // 13. a. Let A be the result of calling the [[Construct]] internal method of C with an argument list containing the single item len.
            // 14. a. Else, Let A be ArrayCreate(len).
            var A = isCallable(C) ? Object(new C(len)) : new Array(len);

            // 16. Let k be 0.
            var k = 0;

            // If usingIterator is not undefined, then
            if (iteratorTypes.indexOf(items.toString()) !== -1) {
                var item;

                // Let next be IteratorStep
                while (item = items.next().value) k = iteratee(item, k);

                // Let putStatus be Put(A, "length", len, true).
                A.length = k;

                // Return A.
                return A;
            }

            // 10. Let lenValue be Get(items, "length").
            // 11. Let len be ToLength(lenValue).
            var len = toLength(items.length);

            // 17. Repeat, while k < len… (also steps a - h)
            while (k < len) k = iteratee(items[k], k);

            // 18. Let putStatus be Put(A, "length", len, true).
            A.length = len;

            // 20. Return A.
            return A;
        };
    }());
}