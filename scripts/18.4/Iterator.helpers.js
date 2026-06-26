const global = typeof globalThis === 'object' ? globalThis : window;
const iteratorSymbol = typeof Symbol === 'function' && Symbol.iterator;
const iteratorPrototype = iteratorSymbol && typeof Object.getPrototypeOf === 'function'
    ? getIteratorPrototype()
    : null;

if (iteratorPrototype) {
    let IteratorConstructor = global.Iterator;
    if (typeof IteratorConstructor !== 'function') {
        IteratorConstructor = function Iterator() {
            throw new TypeError('Iterator is not constructible');
        };
        IteratorConstructor.prototype = iteratorPrototype;
        defineValue(global, 'Iterator', IteratorConstructor);
    }

    if (!IteratorConstructor.prototype) {
        IteratorConstructor.prototype = iteratorPrototype;
    }

    defineValue(iteratorPrototype, iteratorSymbol, function () {
        return this;
    });

    defineValue(IteratorConstructor, 'from', function (value) {
        const iterator = getIterator(value);
        if (isIteratorHelper(iterator)) return iterator;

        return createIterator(function () {
            return iterator.next();
        }, iterator);
    });

    defineValue(iteratorPrototype, 'map', function (callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a function');

        const iterator = getIterator(this);
        let index = 0;

        return createIterator(function () {
            const step = iterator.next();
            if (step.done) return done();

            return {
                value: callback(step.value, index++),
                done: false
            };
        }, iterator);
    });

    defineValue(iteratorPrototype, 'filter', function (callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a function');

        const iterator = getIterator(this);
        let index = 0;

        return createIterator(function () {
            let step;

            while (!(step = iterator.next()).done) {
                if (callback(step.value, index++)) {
                    return {
                        value: step.value,
                        done: false
                    };
                }
            }

            return done();
        }, iterator);
    });

    defineValue(iteratorPrototype, 'take', function (limit) {
        const iterator = getIterator(this);
        let remaining = toLimit(limit);

        return createIterator(function () {
            if (remaining <= 0) {
                closeIterator(iterator);
                return done();
            }

            const step = iterator.next();
            if (step.done) return done();

            remaining--;
            if (remaining <= 0) closeIterator(iterator);

            return {
                value: step.value,
                done: false
            };
        }, iterator);
    });

    defineValue(iteratorPrototype, 'drop', function (limit) {
        const iterator = getIterator(this);
        let remaining = toLimit(limit);

        return createIterator(function () {
            let step;

            while (remaining > 0) {
                step = iterator.next();
                if (step.done) return done();
                remaining--;
            }

            return iterator.next();
        }, iterator);
    });

    defineValue(iteratorPrototype, 'flatMap', function (callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a function');

        const iterator = getIterator(this);
        let innerIterator;
        let index = 0;

        return createIterator(function () {
            let innerStep;
            let outerStep;

            while (true) {
                if (innerIterator) {
                    innerStep = innerIterator.next();
                    if (!innerStep.done) {
                        return {
                            value: innerStep.value,
                            done: false
                        };
                    }
                    innerIterator = null;
                }

                outerStep = iterator.next();
                if (outerStep.done) return done();

                innerIterator = getIterator(callback(outerStep.value, index++));
            }
        }, iterator, function () {
            closeIterator(innerIterator);
            closeIterator(iterator);
        });
    });

    defineValue(iteratorPrototype, 'reduce', function (callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a function');

        const iterator = getIterator(this);
        let hasAccumulator = arguments.length > 1;
        let accumulator = arguments[1];
        let index = 0;
        let step;

        while (!(step = iterator.next()).done) {
            if (hasAccumulator) {
                accumulator = callback(accumulator, step.value, index++);
            } else {
                accumulator = step.value;
                hasAccumulator = true;
            }
        }

        if (!hasAccumulator) throw new TypeError('Reduce of empty iterator with no initial value');

        return accumulator;
    });

    defineValue(iteratorPrototype, 'toArray', function () {
        const iterator = getIterator(this);
        const result = [];
        let step;

        while (!(step = iterator.next()).done) {
            result.push(step.value);
        }

        return result;
    });

    defineValue(iteratorPrototype, 'forEach', function (callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a function');

        const iterator = getIterator(this);
        let index = 0;
        let step;

        while (!(step = iterator.next()).done) {
            callback(step.value, index++);
        }
    });

    defineValue(iteratorPrototype, 'some', function (callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a function');

        const iterator = getIterator(this);
        let index = 0;
        let step;

        while (!(step = iterator.next()).done) {
            if (callback(step.value, index++)) {
                closeIterator(iterator);
                return true;
            }
        }

        return false;
    });

    defineValue(iteratorPrototype, 'every', function (callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a function');

        const iterator = getIterator(this);
        let index = 0;
        let step;

        while (!(step = iterator.next()).done) {
            if (!callback(step.value, index++)) {
                closeIterator(iterator);
                return false;
            }
        }

        return true;
    });

    defineValue(iteratorPrototype, 'find', function (callback) {
        if (typeof callback !== 'function') throw new TypeError('Expected a function');

        const iterator = getIterator(this);
        let index = 0;
        let step;

        while (!(step = iterator.next()).done) {
            if (callback(step.value, index++)) {
                closeIterator(iterator);
                return step.value;
            }
        }
    });
}

function getIteratorPrototype() {
    if (!Array.prototype[iteratorSymbol]) return null;

    const arrayIterator = [][iteratorSymbol]();
    const arrayIteratorPrototype = Object.getPrototypeOf(arrayIterator);

    return Object.getPrototypeOf(arrayIteratorPrototype) || arrayIteratorPrototype;
}

function getIterator(value) {
    if (value == null) throw new TypeError('Expected an iterable or iterator');

    const method = value[iteratorSymbol];
    let iterator;
    if (typeof method === 'function') {
        iterator = method.call(value);
    } else {
        iterator = value;
    }

    if (!iterator || typeof iterator.next !== 'function') {
        throw new TypeError('Expected an iterable or iterator');
    }

    return iterator;
}

function createIterator(next, source, onReturn) {
    const iterator = Object.create(iteratorPrototype);
    let closed = false;

    defineValue(iterator, 'next', function () {
        let step;

        if (closed) return done();

        try {
            step = next();
        } catch (error) {
            closed = true;
            closeIterator(source);
            throw error;
        }

        if (!step || typeof step !== 'object') {
            closed = true;
            closeIterator(source);
            throw new TypeError('Iterator result is not an object');
        }

        if (step.done) closed = true;

        return step;
    });

    defineValue(iterator, 'return', function (value) {
        if (!closed) {
            closed = true;
            if (onReturn) {
                onReturn();
            } else {
                closeIterator(source);
            }
        }

        return {
            value: value,
            done: true
        };
    });

    return iterator;
}

function closeIterator(iterator) {
    if (!iterator) return;

    const returnMethod = iterator.return;
    if (typeof returnMethod === 'function') returnMethod.call(iterator);
}

function done() {
    return {
        value: undefined,
        done: true
    };
}

function toLimit(value) {
    const number = Number(value);

    if (number !== number || number < 0) {
        throw new RangeError('Limit must be a non-negative number');
    }

    if (number === Infinity) return number;

    return Math.floor(number);
}

function isIteratorHelper(value) {
    return value && typeof value.next === 'function' && typeof value.map === 'function';
}

function defineValue(target, name, value) {
    if (!target[name]) {
        Object.defineProperty(target, name, {
            value: value,
            writable: true,
            configurable: true
        });
    }
}
