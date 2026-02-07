// https://gist.github.com/fuweichin/61005d22fffba63218f04a8276481c22 + Claude 4.5 Sonnet
(function () {
    "use strict";

    var ScreenOrientation;
    if ('onorientationchange' in window) { // Safari 15
        var weakMap = new WeakMap();
        ScreenOrientation = (function () {
            function ScreenOrientation() {
                EventTarget.call(this);
                this._onchange = null;
                Object.defineProperties(this, {
                    _onchange: { enumerable: false }
                });
            }

            // Inherit from EventTarget
            ScreenOrientation.prototype = Object.create(EventTarget.prototype);
            ScreenOrientation.prototype.constructor = ScreenOrientation;

            Object.defineProperty(ScreenOrientation.prototype, 'angle', {
                enumerable: true,
                configurable: true,
                get: function () {
                    var angle = window.orientation;
                    if (angle < 0)
                        angle += 360;
                    return angle;
                }
            });

            Object.defineProperty(ScreenOrientation.prototype, 'type', {
                enumerable: true,
                configurable: true,
                get: function () {
                    var angle = this.angle;
                    switch (angle) {
                        case 0:
                            return 'portrait-primary';
                        case 90:
                            return 'landscape-primary';
                        case 180:
                            return 'portrait-secondary';
                        case 270:
                            return 'landscape-secondary';
                        default:
                            return '';
                    }
                }
            });

            ScreenOrientation.prototype.lock = function () {
                return Promise.resolve();
            };

            ScreenOrientation.prototype.unlock = function () {
                return Promise.resolve();
            };

            ScreenOrientation.prototype.addEventListener = function (type, listener) {
                if (type === 'change') {
                    var self = this;
                    var middleListener = function (e) {
                        self.dispatchEvent(new Event('change'));
                    };
                    weakMap.set(listener, middleListener);
                    window.addEventListener('orientationchange', middleListener);
                }
                EventTarget.prototype.addEventListener.call(this, type, listener);
            };

            ScreenOrientation.prototype.removeEventListener = function (type, listener) {
                if (type === 'change') {
                    var middleListener = weakMap.get(listener);
                    if (middleListener) {
                        window.removeEventListener('orientationchange', middleListener);
                    }
                }
                EventTarget.prototype.removeEventListener.call(this, type, listener);
            };

            Object.defineProperty(ScreenOrientation.prototype, 'onchange', {
                enumerable: true,
                configurable: true,
                get: function () {
                    return this._onchange;
                },
                set: function (handler) {
                    var oldHandler = this._onchange;
                    if (handler === oldHandler)
                        return;
                    if (oldHandler !== null) {
                        this.removeEventListener('change', oldHandler);
                        this._onchange = null;
                    }
                    if (typeof handler === 'function') {
                        this.addEventListener('change', handler);
                        this._onchange = handler;
                    }
                }
            });

            Object.defineProperty(ScreenOrientation.prototype, Symbol.toStringTag, {
                enumerable: false,
                configurable: true,
                writable: false,
                value: 'ScreenOrientation'
            });

            return ScreenOrientation;
        })();
    }

    function polyfill() {
        if (!screen.orientation) {
            if (!ScreenOrientation) {
                throw new Error('cannot polyfill screen.orientation');
            }
            var orientation = new ScreenOrientation();
            Object.defineProperty(Screen.prototype, 'orientation', {
                enumerable: true,
                configurable: true,
                get: function getOrientation() {
                    return orientation;
                }
            });
            Object.defineProperty(window, 'ScreenOrientation', {
                enumerable: false,
                configurable: true,
                writable: true,
                value: ScreenOrientation
            });
        }
    }

    // Initialize polyfill
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', polyfill);
    } else {
        polyfill();
    }
})();
