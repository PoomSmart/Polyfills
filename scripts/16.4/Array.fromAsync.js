// https://github.com/es-shims/array-from-async
(() => {
    if (typeof Array.fromAsync === 'function') return;

    const { MAX_SAFE_INTEGER } = Number;
    const iteratorSymbol = Symbol.iterator;
    const asyncIteratorSymbol = Symbol.asyncIterator;
    const IntrinsicArray = Array;
    const tooLongErrorMessage = 'Input is too long and exceeded Number.MAX_SAFE_INTEGER times.';

    function isConstructor(obj) {
        if (obj != null) {
            const prox = new Proxy(obj, {
                construct() {
                    return prox;
                },
            });
            try {
                new prox();
                return true;
            } catch {
                return false;
            }
        }
        return false;
    }

    Array.fromAsync = async function fromAsync(items, mapfn, thisArg) {
        const itemsAreIterable = (
            items != null &&
            (asyncIteratorSymbol in items || iteratorSymbol in items)
        );

        const C = isConstructor(this) ? this : IntrinsicArray;

        if (itemsAreIterable) {
            const result = new C();
            let i = 0;

            for await (const v of items) {
                if (i > MAX_SAFE_INTEGER) throw TypeError(tooLongErrorMessage);
                result[i] = mapfn ? await mapfn.call(thisArg, v, i) : v;
                i++;
            }

            result.length = i;
            return result;
        }

        // Array-like fallback
        const { length } = items ?? {};
        const len = length >>> 0;
        const result = new C(len);

        let i = 0;
        while (i < len) {
            if (i > MAX_SAFE_INTEGER) throw TypeError(tooLongErrorMessage);
            const v = await items[i];
            result[i] = mapfn ? await mapfn.call(thisArg, v, i) : v;
            i++;
        }

        result.length = i;
        return result;
    };
})();
