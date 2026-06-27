// Polyfill for Float16Array, DataView float16 accessors, and Math.f16round
{
    const globals =
        typeof globalThis == "undefined"
            ? typeof self == "undefined"
                ? typeof global == "undefined"
                    ? {}
                    : global
                : self
            : globalThis;

    const BYTES_PER_ELEMENT = 2;
    const FLOAT16_MIN_VALUE = 5.960464477539063e-8;
    const FLOAT16_MIN_NORMAL = 0.00006103515625;
    const FLOAT16_MAX_VALUE = 65504;
    const FLOAT16_EPSILON = 0.0009765625;
    const FLOAT64_ROUNDING_FACTOR = 1 / Number.EPSILON;

    function define(target, name, value) {
        if (!(name in target)) {
            Object.defineProperty(target, name, {
                value: value,
                writable: true,
                configurable: true
            });
        }
    }

    function defineGetter(target, name, getter) {
        Object.defineProperty(target, name, {
            get: getter,
            enumerable: false,
            configurable: true
        });
    }

    function defineInternal(target, name, value) {
        Object.defineProperty(target, name, {
            value: value,
            writable: true,
            configurable: false
        });
    }

    function toInteger(value) {
        const number = Number(value);
        if (number !== number || number === 0) return 0;
        if (number === Infinity || number === -Infinity) return number;
        return (number < 0 ? -1 : 1) * Math.floor(Math.abs(number));
    }

    function toLength(value) {
        const length = toInteger(value);
        if (length <= 0) return 0;
        return Math.min(length, Number.MAX_SAFE_INTEGER || 9007199254740991);
    }

    function toIndex(value) {
        const index = value === undefined ? 0 : toInteger(value);
        if (index < 0 || index === Infinity) {
            throw new RangeError("Invalid index");
        }
        return index;
    }

    function toArrayLength(value) {
        const length = value === undefined ? 0 : toInteger(value);
        if (length < 0 || length === Infinity) {
            throw new RangeError("Invalid typed array length");
        }
        return Math.min(length, Number.MAX_SAFE_INTEGER || 9007199254740991);
    }

    function isArrayBuffer(value) {
        return value instanceof ArrayBuffer ||
            Object.prototype.toString.call(value) === "[object ArrayBuffer]";
    }

    function isCallable(value) {
        return typeof value === "function";
    }

    function hasIterator(value) {
        return typeof Symbol === "function" &&
            Symbol.iterator &&
            value != null &&
            isCallable(value[Symbol.iterator]);
    }

    function iterableToArray(value) {
        const result = [];

        if (hasIterator(value)) {
            const iterator = value[Symbol.iterator]();
            let step;
            while (!(step = iterator.next()).done) {
                result.push(step.value);
            }
            return result;
        }

        if (value == null) {
            throw new TypeError("Cannot convert undefined or null to object");
        }

        const object = Object(value);
        const length = toLength(object.length);
        for (let index = 0; index < length; index++) {
            result.push(object[index]);
        }
        return result;
    }

    function f16round(value) {
        const number = Number(value);
        if (!isFinite(number) || number === 0) return number;

        const sign = number < 0 ? -1 : 1;
        const absolute = Math.abs(number);

        if (absolute < FLOAT16_MIN_NORMAL) {
            return sign * (absolute / FLOAT16_MIN_VALUE + FLOAT64_ROUNDING_FACTOR - FLOAT64_ROUNDING_FACTOR) * FLOAT16_MIN_VALUE;
        }

        const rounded = (1 + FLOAT16_EPSILON * FLOAT64_ROUNDING_FACTOR) * absolute;
        const result = rounded - (rounded - absolute);
        return result > FLOAT16_MAX_VALUE || result !== result ? sign * Infinity : sign * result;
    }

    function float16BitsToNumber(bits) {
        bits = bits & 0xffff;

        const sign = bits & 0x8000 ? -1 : 1;
        const exponent = (bits >> 10) & 0x1f;
        const fraction = bits & 0x03ff;

        if (exponent === 0) {
            return sign * fraction * FLOAT16_MIN_VALUE;
        }

        if (exponent === 0x1f) {
            return fraction ? NaN : sign * Infinity;
        }

        return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
    }

    function numberToFloat16Bits(value) {
        const rounded = f16round(value);
        const sign = rounded < 0 || (rounded === 0 && 1 / rounded === -Infinity) ? 0x8000 : 0;
        const absolute = Math.abs(rounded);

        if (rounded !== rounded) return 0x7e00;
        if (absolute === Infinity) return sign | 0x7c00;
        if (absolute === 0) return sign;
        if (absolute < FLOAT16_MIN_NORMAL) {
            return sign | Math.round(absolute / FLOAT16_MIN_VALUE);
        }

        let exponent = Math.floor(Math.log(absolute) / Math.LN2);
        let fraction = Math.round((absolute / Math.pow(2, exponent) - 1) * 1024);
        if (fraction === 1024) {
            exponent++;
            fraction = 0;
        }

        const biasedExponent = exponent + 15;
        if (biasedExponent >= 0x1f) return sign | 0x7c00;
        return sign | (biasedExponent << 10) | (fraction & 0x03ff);
    }

    function installIndex(target, index) {
        Object.defineProperty(target, index, {
            get: function () {
                return this._get(index);
            },
            set: function (value) {
                this._set(index, value);
            },
            enumerable: true,
            configurable: false
        });
    }

    function normalizeIndex(index, length) {
        index = toInteger(index);
        return index < 0 ? Math.max(length + index, 0) : Math.min(index, length);
    }

    function createIterator(next) {
        const iterator = { next: next };
        if (typeof Symbol === "function" && Symbol.iterator) {
            iterator[Symbol.iterator] = function () {
                return this;
            };
        }
        return iterator;
    }

    function compareNumbers(left, right) {
        const leftIsNaN = left !== left;
        const rightIsNaN = right !== right;
        if (leftIsNaN && rightIsNaN) return 0;
        if (leftIsNaN) return 1;
        if (rightIsNaN) return -1;
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
    }

    function Float16ArrayPolyfill(input, byteOffset, length) {
        if (!(this instanceof Float16ArrayPolyfill)) {
            throw new TypeError("Constructor Float16Array requires 'new'");
        }

        let buffer;
        let offset = 0;
        let arrayLength;
        let values;

        if (isArrayBuffer(input)) {
            offset = toIndex(byteOffset);
            if (offset % BYTES_PER_ELEMENT !== 0) {
                throw new RangeError("start offset of Float16Array should be a multiple of 2");
            }
            if (offset > input.byteLength) {
                throw new RangeError("Start offset is outside the bounds of the buffer");
            }

            const remainingBytes = input.byteLength - offset;
            if (length === undefined) {
                if (remainingBytes % BYTES_PER_ELEMENT !== 0) {
                    throw new RangeError("byte length of Float16Array should be a multiple of 2");
                }
                arrayLength = remainingBytes / BYTES_PER_ELEMENT;
            } else {
                arrayLength = toArrayLength(length);
                if (arrayLength * BYTES_PER_ELEMENT > remainingBytes) {
                    throw new RangeError("Invalid typed array length");
                }
            }

            buffer = input;
        } else if (typeof input === "number" || input === undefined) {
            arrayLength = toArrayLength(input);
            buffer = new ArrayBuffer(arrayLength * BYTES_PER_ELEMENT);
        } else {
            values = iterableToArray(input);
            arrayLength = values.length;
            buffer = new ArrayBuffer(arrayLength * BYTES_PER_ELEMENT);
        }

        defineInternal(this, "_buffer", buffer);
        defineInternal(this, "_byteOffset", offset);
        defineInternal(this, "_length", arrayLength);
        defineInternal(this, "_view", new DataView(buffer, offset, arrayLength * BYTES_PER_ELEMENT));

        for (let index = 0; index < arrayLength; index++) {
            installIndex(this, index);
        }

        if (values) {
            this.set(values);
        }
    }

    defineGetter(Float16ArrayPolyfill.prototype, "buffer", function () {
        return this._buffer;
    });
    defineGetter(Float16ArrayPolyfill.prototype, "byteOffset", function () {
        return this._byteOffset;
    });
    defineGetter(Float16ArrayPolyfill.prototype, "byteLength", function () {
        return this._length * BYTES_PER_ELEMENT;
    });
    defineGetter(Float16ArrayPolyfill.prototype, "length", function () {
        return this._length;
    });

    define(Float16ArrayPolyfill, "BYTES_PER_ELEMENT", BYTES_PER_ELEMENT);
    define(Float16ArrayPolyfill.prototype, "BYTES_PER_ELEMENT", BYTES_PER_ELEMENT);

    define(Float16ArrayPolyfill.prototype, "_get", function (index) {
        return float16BitsToNumber(this._view.getUint16(index * BYTES_PER_ELEMENT, true));
    });

    define(Float16ArrayPolyfill.prototype, "_set", function (index, value) {
        this._view.setUint16(index * BYTES_PER_ELEMENT, numberToFloat16Bits(value), true);
    });

    define(Float16ArrayPolyfill, "from", function (source, mapFn, thisArg) {
        const values = iterableToArray(source);
        if (mapFn !== undefined) {
            if (!isCallable(mapFn)) throw new TypeError("mapFn must be a function");
            for (let index = 0; index < values.length; index++) {
                values[index] = mapFn.call(thisArg, values[index], index);
            }
        }
        return new this(values);
    });

    define(Float16ArrayPolyfill, "of", function () {
        return new this(arguments);
    });

    define(Float16ArrayPolyfill.prototype, "at", function (index) {
        index = toInteger(index);
        if (index < 0) index += this.length;
        return index < 0 || index >= this.length ? undefined : this[index];
    });

    define(Float16ArrayPolyfill.prototype, "copyWithin", function (target, start, end) {
        const length = this.length;
        target = normalizeIndex(target, length);
        start = normalizeIndex(start, length);
        end = end === undefined ? length : normalizeIndex(end, length);

        const values = [];
        for (let index = start; index < end; index++) {
            values.push(this[index]);
        }
        for (let index = 0; index < values.length && target + index < length; index++) {
            this[target + index] = values[index];
        }
        return this;
    });

    define(Float16ArrayPolyfill.prototype, "entries", function () {
        const array = this;
        let index = 0;
        return createIterator(function () {
            if (index >= array.length) return { value: undefined, done: true };
            return { value: [index, array[index++]], done: false };
        });
    });

    define(Float16ArrayPolyfill.prototype, "every", function (callback, thisArg) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        for (let index = 0; index < this.length; index++) {
            if (!callback.call(thisArg, this[index], index, this)) return false;
        }
        return true;
    });

    define(Float16ArrayPolyfill.prototype, "fill", function (value, start, end) {
        start = normalizeIndex(start, this.length);
        end = end === undefined ? this.length : normalizeIndex(end, this.length);
        for (let index = start; index < end; index++) {
            this[index] = value;
        }
        return this;
    });

    define(Float16ArrayPolyfill.prototype, "filter", function (callback, thisArg) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        const values = [];
        for (let index = 0; index < this.length; index++) {
            const value = this[index];
            if (callback.call(thisArg, value, index, this)) values.push(value);
        }
        return new Float16ArrayPolyfill(values);
    });

    define(Float16ArrayPolyfill.prototype, "find", function (callback, thisArg) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        for (let index = 0; index < this.length; index++) {
            const value = this[index];
            if (callback.call(thisArg, value, index, this)) return value;
        }
    });

    define(Float16ArrayPolyfill.prototype, "findIndex", function (callback, thisArg) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        for (let index = 0; index < this.length; index++) {
            if (callback.call(thisArg, this[index], index, this)) return index;
        }
        return -1;
    });

    define(Float16ArrayPolyfill.prototype, "findLast", function (callback, thisArg) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        for (let index = this.length - 1; index >= 0; index--) {
            const value = this[index];
            if (callback.call(thisArg, value, index, this)) return value;
        }
    });

    define(Float16ArrayPolyfill.prototype, "findLastIndex", function (callback, thisArg) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        for (let index = this.length - 1; index >= 0; index--) {
            if (callback.call(thisArg, this[index], index, this)) return index;
        }
        return -1;
    });

    define(Float16ArrayPolyfill.prototype, "forEach", function (callback, thisArg) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        for (let index = 0; index < this.length; index++) {
            callback.call(thisArg, this[index], index, this);
        }
    });

    define(Float16ArrayPolyfill.prototype, "includes", function (searchElement, fromIndex) {
        let index = normalizeIndex(fromIndex, this.length);
        const searchIsNaN = searchElement !== searchElement;
        for (; index < this.length; index++) {
            if (this[index] === searchElement || (searchIsNaN && this[index] !== this[index])) return true;
        }
        return false;
    });

    define(Float16ArrayPolyfill.prototype, "indexOf", function (searchElement, fromIndex) {
        let index = normalizeIndex(fromIndex, this.length);
        for (; index < this.length; index++) {
            if (this[index] === searchElement) return index;
        }
        return -1;
    });

    define(Float16ArrayPolyfill.prototype, "join", function (separator) {
        const values = [];
        for (let index = 0; index < this.length; index++) {
            values.push(this[index]);
        }
        return values.join(separator);
    });

    define(Float16ArrayPolyfill.prototype, "keys", function () {
        const array = this;
        let index = 0;
        return createIterator(function () {
            if (index >= array.length) return { value: undefined, done: true };
            return { value: index++, done: false };
        });
    });

    define(Float16ArrayPolyfill.prototype, "lastIndexOf", function (searchElement, fromIndex) {
        let index = fromIndex === undefined ? this.length - 1 : toInteger(fromIndex);
        if (index < 0) index += this.length;
        index = Math.min(index, this.length - 1);
        for (; index >= 0; index--) {
            if (this[index] === searchElement) return index;
        }
        return -1;
    });

    define(Float16ArrayPolyfill.prototype, "map", function (callback, thisArg) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        const result = new Float16ArrayPolyfill(this.length);
        for (let index = 0; index < this.length; index++) {
            result[index] = callback.call(thisArg, this[index], index, this);
        }
        return result;
    });

    define(Float16ArrayPolyfill.prototype, "reduce", function (callback, initialValue) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        if (this.length === 0 && arguments.length < 2) {
            throw new TypeError("Reduce of empty array with no initial value");
        }

        let index = 0;
        let accumulator = initialValue;
        if (arguments.length < 2) {
            accumulator = this[0];
            index = 1;
        }
        for (; index < this.length; index++) {
            accumulator = callback(accumulator, this[index], index, this);
        }
        return accumulator;
    });

    define(Float16ArrayPolyfill.prototype, "reduceRight", function (callback, initialValue) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        if (this.length === 0 && arguments.length < 2) {
            throw new TypeError("Reduce of empty array with no initial value");
        }

        let index = this.length - 1;
        let accumulator = initialValue;
        if (arguments.length < 2) {
            accumulator = this[index--];
        }
        for (; index >= 0; index--) {
            accumulator = callback(accumulator, this[index], index, this);
        }
        return accumulator;
    });

    define(Float16ArrayPolyfill.prototype, "reverse", function () {
        for (let left = 0, right = this.length - 1; left < right; left++, right--) {
            const value = this[left];
            this[left] = this[right];
            this[right] = value;
        }
        return this;
    });

    define(Float16ArrayPolyfill.prototype, "set", function (source, offset) {
        const values = iterableToArray(source);
        offset = toIndex(offset);
        if (offset + values.length > this.length) {
            throw new RangeError("Offset is out of bounds");
        }
        for (let index = 0; index < values.length; index++) {
            this[offset + index] = values[index];
        }
    });

    define(Float16ArrayPolyfill.prototype, "slice", function (start, end) {
        start = normalizeIndex(start, this.length);
        end = end === undefined ? this.length : normalizeIndex(end, this.length);
        const result = new Float16ArrayPolyfill(Math.max(end - start, 0));
        for (let index = 0; index < result.length; index++) {
            result[index] = this[start + index];
        }
        return result;
    });

    define(Float16ArrayPolyfill.prototype, "some", function (callback, thisArg) {
        if (!isCallable(callback)) throw new TypeError("callback must be a function");
        for (let index = 0; index < this.length; index++) {
            if (callback.call(thisArg, this[index], index, this)) return true;
        }
        return false;
    });

    define(Float16ArrayPolyfill.prototype, "sort", function (compareFn) {
        if (compareFn !== undefined && !isCallable(compareFn)) {
            throw new TypeError("compareFn must be a function");
        }
        const values = iterableToArray(this);
        values.sort(compareFn || compareNumbers);
        this.set(values);
        return this;
    });

    define(Float16ArrayPolyfill.prototype, "subarray", function (start, end) {
        start = normalizeIndex(start, this.length);
        end = end === undefined ? this.length : normalizeIndex(end, this.length);
        return new Float16ArrayPolyfill(this.buffer, this.byteOffset + start * BYTES_PER_ELEMENT, Math.max(end - start, 0));
    });

    define(Float16ArrayPolyfill.prototype, "toLocaleString", function () {
        const values = [];
        for (let index = 0; index < this.length; index++) {
            values.push(this[index]);
        }
        return values.toLocaleString.apply(values, arguments);
    });

    define(Float16ArrayPolyfill.prototype, "toReversed", function () {
        return this.slice().reverse();
    });

    define(Float16ArrayPolyfill.prototype, "toSorted", function (compareFn) {
        return this.slice().sort(compareFn);
    });

    define(Float16ArrayPolyfill.prototype, "values", function () {
        const array = this;
        let index = 0;
        return createIterator(function () {
            if (index >= array.length) return { value: undefined, done: true };
            return { value: array[index++], done: false };
        });
    });

    define(Float16ArrayPolyfill.prototype, "with", function (index, value) {
        index = toInteger(index);
        if (index < 0) index += this.length;
        if (index < 0 || index >= this.length) {
            throw new RangeError("Index out of range");
        }

        const result = this.slice();
        result[index] = value;
        return result;
    });

    if (typeof Symbol === "function") {
        if (Symbol.iterator) {
            define(Float16ArrayPolyfill.prototype, Symbol.iterator, Float16ArrayPolyfill.prototype.values);
        }
        if (Symbol.toStringTag) {
            define(Float16ArrayPolyfill.prototype, Symbol.toStringTag, "Float16Array");
        }
    }

    if (typeof Math === "object") {
        define(Math, "f16round", f16round);
    }

    if (typeof DataView === "function") {
        define(DataView.prototype, "getFloat16", function (byteOffset, littleEndian) {
            return float16BitsToNumber(this.getUint16(byteOffset, littleEndian));
        });

        define(DataView.prototype, "setFloat16", function (byteOffset, value, littleEndian) {
            this.setUint16(byteOffset, numberToFloat16Bits(value), littleEndian);
        });
    }

    if (typeof globals.Float16Array === "undefined") {
        Object.defineProperty(globals, "Float16Array", {
            value: Float16ArrayPolyfill,
            writable: true,
            configurable: true
        });
    }
}
