if (typeof Symbol === 'function') {
    const global = typeof globalThis !== 'undefined' ? globalThis : window;

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
        if (!(name in target)) {
            Object.defineProperty(target, name, {
                get: getter,
                configurable: true
            });
        }
    }

    function wellKnownSymbol(name) {
        return typeof Symbol.for === 'function' ? Symbol.for('Symbol.' + name) : Symbol('Symbol.' + name);
    }

    define(Symbol, 'dispose', wellKnownSymbol('dispose'));
    define(Symbol, 'asyncDispose', wellKnownSymbol('asyncDispose'));

    function createSuppressedError(error, suppressed) {
        if (typeof global.SuppressedError === 'function') {
            return new global.SuppressedError(error, suppressed, 'An error was suppressed during disposal.');
        }

        const instance = new Error('An error was suppressed during disposal.');
        instance.name = 'SuppressedError';
        instance.error = error;
        instance.suppressed = suppressed;
        return instance;
    }

    function throwIfDisposed(stack) {
        if (stack._disposed) {
            throw new ReferenceError('DisposableStack is already disposed.');
        }
    }

    function addSuppressedError(state, error) {
        if (state.hasError) {
            state.error = createSuppressedError(error, state.error);
        } else {
            state.error = error;
            state.hasError = true;
        }
    }

    if (!("SuppressedError" in global)) {
        function SuppressedErrorPolyfill(error, suppressed, message) {
            const instance = new Error(message === undefined ? '' : String(message));
            if (Object.setPrototypeOf) {
                Object.setPrototypeOf(instance, SuppressedErrorPolyfill.prototype);
            }
            instance.name = 'SuppressedError';
            instance.error = error;
            instance.suppressed = suppressed;
            return instance;
        }

        SuppressedErrorPolyfill.prototype = Object.create(Error.prototype);
        SuppressedErrorPolyfill.prototype.constructor = SuppressedErrorPolyfill;

        define(global, 'SuppressedError', SuppressedErrorPolyfill);
    }

    if (!("DisposableStack" in global)) {
        function DisposableStackPolyfill() {
            this._stack = [];
            this._disposed = false;
        }

        defineGetter(DisposableStackPolyfill.prototype, 'disposed', function () {
            return this._disposed;
        });

        define(DisposableStackPolyfill.prototype, 'use', function (value) {
            throwIfDisposed(this);
            if (value === null || value === undefined) return value;

            const dispose = value[Symbol.dispose];
            if (typeof dispose !== 'function') {
                throw new TypeError('Object is not disposable.');
            }

            this._stack.push(function () {
                return dispose.call(value);
            });
            return value;
        });

        define(DisposableStackPolyfill.prototype, 'adopt', function (value, onDispose) {
            throwIfDisposed(this);
            if (typeof onDispose !== 'function') {
                throw new TypeError('Expected a disposal function.');
            }

            this._stack.push(function () {
                return onDispose(value);
            });
            return value;
        });

        define(DisposableStackPolyfill.prototype, 'defer', function (onDispose) {
            throwIfDisposed(this);
            if (typeof onDispose !== 'function') {
                throw new TypeError('Expected a disposal function.');
            }

            this._stack.push(onDispose);
        });

        define(DisposableStackPolyfill.prototype, 'move', function () {
            throwIfDisposed(this);

            const stack = new DisposableStackPolyfill();
            stack._stack = this._stack;
            this._stack = [];
            this._disposed = true;
            return stack;
        });

        define(DisposableStackPolyfill.prototype, 'dispose', function () {
            if (this._disposed) return;

            const state = { hasError: false, error: undefined };
            const stack = this._stack;
            this._stack = [];
            this._disposed = true;

            while (stack.length) {
                try {
                    stack.pop()();
                } catch (error) {
                    addSuppressedError(state, error);
                }
            }

            if (state.hasError) {
                throw state.error;
            }
        });

        define(DisposableStackPolyfill.prototype, Symbol.dispose, DisposableStackPolyfill.prototype.dispose);
        define(global, 'DisposableStack', DisposableStackPolyfill);
    }

    if (!("AsyncDisposableStack" in global)) {
        function AsyncDisposableStackPolyfill() {
            this._stack = [];
            this._disposed = false;
        }

        defineGetter(AsyncDisposableStackPolyfill.prototype, 'disposed', function () {
            return this._disposed;
        });

        define(AsyncDisposableStackPolyfill.prototype, 'use', function (value) {
            throwIfDisposed(this);
            if (value === null || value === undefined) return value;

            const asyncDispose = value[Symbol.asyncDispose];
            const dispose = value[Symbol.dispose];
            if (typeof asyncDispose === 'function') {
                this._stack.push(function () {
                    return asyncDispose.call(value);
                });
            } else if (typeof dispose === 'function') {
                this._stack.push(function () {
                    return dispose.call(value);
                });
            } else {
                throw new TypeError('Object is not disposable.');
            }

            return value;
        });

        define(AsyncDisposableStackPolyfill.prototype, 'adopt', function (value, onDisposeAsync) {
            throwIfDisposed(this);
            if (typeof onDisposeAsync !== 'function') {
                throw new TypeError('Expected a disposal function.');
            }

            this._stack.push(function () {
                return onDisposeAsync(value);
            });
            return value;
        });

        define(AsyncDisposableStackPolyfill.prototype, 'defer', function (onDisposeAsync) {
            throwIfDisposed(this);
            if (typeof onDisposeAsync !== 'function') {
                throw new TypeError('Expected a disposal function.');
            }

            this._stack.push(onDisposeAsync);
        });

        define(AsyncDisposableStackPolyfill.prototype, 'move', function () {
            throwIfDisposed(this);

            const stack = new AsyncDisposableStackPolyfill();
            stack._stack = this._stack;
            this._stack = [];
            this._disposed = true;
            return stack;
        });

        define(AsyncDisposableStackPolyfill.prototype, 'disposeAsync', function () {
            if (this._disposed) return Promise.resolve();

            const state = { hasError: false, error: undefined };
            const stack = this._stack;
            this._stack = [];
            this._disposed = true;

            function next() {
                if (!stack.length) {
                    return state.hasError ? Promise.reject(state.error) : Promise.resolve();
                }

                return Promise.resolve()
                    .then(stack.pop())
                    .then(next, function (error) {
                        addSuppressedError(state, error);
                        return next();
                    });
            }

            return next();
        });

        define(AsyncDisposableStackPolyfill.prototype, Symbol.asyncDispose, AsyncDisposableStackPolyfill.prototype.disposeAsync);
        define(global, 'AsyncDisposableStack', AsyncDisposableStackPolyfill);
    }

    const arrayIterator = Array.prototype[Symbol.iterator] && [][Symbol.iterator]();
    const arrayIteratorPrototype = arrayIterator && Object.getPrototypeOf(arrayIterator);
    const iteratorPrototype = arrayIteratorPrototype && Object.getPrototypeOf(arrayIteratorPrototype);
    if (iteratorPrototype && !(Symbol.dispose in iteratorPrototype)) {
        define(iteratorPrototype, Symbol.dispose, function () {
            if (typeof this.return === 'function') {
                this.return();
            }
        });
    }
}
