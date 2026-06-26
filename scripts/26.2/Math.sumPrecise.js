if (!("sumPrecise" in Math)) {
    const POW_2_1023 = Math.pow(2, 1023);
    const MAX_SAFE_INTEGER = Math.pow(2, 53) - 1;
    const MAX_DOUBLE = Number.MAX_VALUE;
    const MAX_ULP = Math.pow(2, 971);

    const NOT_A_NUMBER = {};
    const MINUS_INFINITY = {};
    const PLUS_INFINITY = {};
    const MINUS_ZERO = {};
    const FINITE = {};

    Object.defineProperty(Math, 'sumPrecise', {
        value: function (values) {
            const iteratorSymbol = typeof Symbol === 'function' && Symbol.iterator;
            if (values == null || !iteratorSymbol || typeof values[iteratorSymbol] !== 'function') {
                throw new TypeError('Expected an iterable');
            }

            const iterator = values[iteratorSymbol]();
            const numbers = [];
            let count = 0;
            let state = MINUS_ZERO;
            let step;

            while (!(step = iterator.next()).done) {
                count++;
                if (count >= MAX_SAFE_INTEGER) {
                    closeIterator(iterator);
                    throw new RangeError('Maximum allowed index exceeded');
                }

                const value = step.value;
                if (typeof value !== 'number') {
                    closeIterator(iterator);
                    throw new TypeError('Expected numbers');
                }

                if (state !== NOT_A_NUMBER) {
                    if (value !== value) {
                        state = NOT_A_NUMBER;
                    } else if (value === Infinity) {
                        state = state === MINUS_INFINITY ? NOT_A_NUMBER : PLUS_INFINITY;
                    } else if (value === -Infinity) {
                        state = state === PLUS_INFINITY ? NOT_A_NUMBER : MINUS_INFINITY;
                    } else if ((value !== 0 || 1 / value === Infinity) && (state === MINUS_ZERO || state === FINITE)) {
                        state = FINITE;
                        numbers.push(value);
                    }
                }
            }

            if (state === NOT_A_NUMBER) return NaN;
            if (state === MINUS_INFINITY) return -Infinity;
            if (state === PLUS_INFINITY) return Infinity;
            if (state === MINUS_ZERO) return -0;

            const partials = [];
            let overflow = 0;
            let hi = 0;
            let lo = 0;
            let x;
            let y;
            let sum;
            let temp;

            for (let i = 0; i < numbers.length; i++) {
                x = numbers[i];
                let usedPartials = 0;

                for (let j = 0; j < partials.length; j++) {
                    y = partials[j];
                    if (Math.abs(x) < Math.abs(y)) {
                        temp = x;
                        x = y;
                        y = temp;
                    }

                    sum = twoSum(x, y);
                    hi = sum.hi;
                    lo = sum.lo;

                    if (Math.abs(hi) === Infinity) {
                        const sign = hi === Infinity ? 1 : -1;
                        overflow += sign;
                        x = (x - sign * POW_2_1023) - sign * POW_2_1023;

                        if (Math.abs(x) < Math.abs(y)) {
                            temp = x;
                            x = y;
                            y = temp;
                        }

                        sum = twoSum(x, y);
                        hi = sum.hi;
                        lo = sum.lo;
                    }

                    if (lo !== 0) partials[usedPartials++] = lo;
                    x = hi;
                }

                partials.length = usedPartials;
                if (x !== 0) partials.push(x);
            }

            let n = partials.length - 1;
            hi = 0;
            lo = 0;

            if (overflow !== 0) {
                const next = n >= 0 ? partials[n] : 0;
                n--;

                if (Math.abs(overflow) > 1 || (overflow > 0 && next > 0) || (overflow < 0 && next < 0)) {
                    return overflow > 0 ? Infinity : -Infinity;
                }

                sum = twoSum(overflow * POW_2_1023, next / 2);
                hi = sum.hi;
                lo = sum.lo * 2;

                if (Math.abs(2 * hi) === Infinity) {
                    if (hi > 0) {
                        return hi === POW_2_1023 && lo === -(MAX_ULP / 2) && n >= 0 && partials[n] < 0
                            ? MAX_DOUBLE
                            : Infinity;
                    }

                    return hi === -POW_2_1023 && lo === MAX_ULP / 2 && n >= 0 && partials[n] > 0
                        ? -MAX_DOUBLE
                        : -Infinity;
                }

                if (lo !== 0) {
                    partials[++n] = lo;
                    lo = 0;
                }

                hi *= 2;
            }

            while (n >= 0) {
                sum = twoSum(hi, partials[n--]);
                hi = sum.hi;
                lo = sum.lo;
                if (lo !== 0) break;
            }

            if (n >= 0 && ((lo < 0 && partials[n] < 0) || (lo > 0 && partials[n] > 0))) {
                y = lo * 2;
                x = hi + y;
                if (y === x - hi) hi = x;
            }

            return hi;
        },
        writable: true,
        configurable: true
    });
}

function twoSum(x, y) {
    const hi = x + y;
    return {
        hi: hi,
        lo: y - (hi - x)
    };
}

function closeIterator(iterator) {
    const returnMethod = iterator && iterator.return;
    if (typeof returnMethod === 'function') returnMethod.call(iterator);
}
