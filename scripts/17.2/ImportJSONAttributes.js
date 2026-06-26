if (typeof window !== 'undefined' && !("importJsonModule" in window)) {
    const hasOwn = Object.prototype.hasOwnProperty;
    const cache = {};

    function hasJsonAttribute(options) {
        if (!options || !options.with || options.with.type !== 'json') {
            return false;
        }

        for (const name in options.with) {
            if (hasOwn.call(options.with, name) && name !== 'type') {
                return false;
            }
        }

        return true;
    }

    function isJsonMime(contentType) {
        const mime = String(contentType || '').split(';')[0].replace(/^\s+|\s+$/g, '').toLowerCase();

        return !mime ||
            mime === 'application/json' ||
            mime === 'text/json' ||
            mime.slice(-5) === '+json';
    }

    function assertJsonMime(contentType) {
        if (!isJsonMime(contentType)) {
            throw new TypeError('JSON module response was not JSON');
        }
    }

    function readText(specifier) {
        if (typeof XMLHttpRequest !== 'function') {
            return Promise.reject(new TypeError('No JSON module request support is available'));
        }

        return new Promise(function (resolve, reject) {
            const request = new XMLHttpRequest();
            request.open('GET', specifier, true);
            request.onload = function () {
                if ((request.status >= 200 && request.status < 300) || request.status === 0) {
                    assertJsonMime(request.getResponseHeader('Content-Type'));
                    resolve(request.responseText);
                    return;
                }

                reject(new TypeError('Failed to load JSON module'));
            };
            request.onerror = function () {
                reject(new TypeError('Failed to load JSON module'));
            };
            request.send();
        });
    }

    function createJsonModule(value) {
        const module = {};

        Object.defineProperty(module, 'default', {
            value: value,
            enumerable: true,
            configurable: false,
            writable: false
        });

        if (typeof Symbol === 'function' && Symbol.toStringTag) {
            Object.defineProperty(module, Symbol.toStringTag, {
                value: 'Module',
                configurable: false
            });
        }

        return Object.freeze ? Object.freeze(module) : module;
    }

    function importJsonModule(specifier, options) {
        if (!hasJsonAttribute(options)) {
            return Promise.reject(new TypeError('Expected { with: { type: "json" } }'));
        }

        const key = String(specifier);
        if (!cache[key]) {
            cache[key] = readText(key).then(function (text) {
                return createJsonModule(JSON.parse(text));
            }, function (error) {
                delete cache[key];
                throw error;
            });
        }

        return cache[key];
    }

    importJsonModule.__db = cache;
    window.importJsonModule = importJsonModule;

    if (typeof window.importScript === 'function' && !window.importScript.__jsonModules) {
        // extend the existing window.importScript (from 15.2 import.js polyfill) to support  JSON imports
        const importScript = window.importScript;
        const importScriptWithJson = function (specifier, options) {
            if (hasJsonAttribute(options)) {
                return importJsonModule(specifier, options);
            }

            return importScript(specifier);
        };

        importScriptWithJson.__db = importScript.__db;
        importScriptWithJson.__jsonModules = true;
        window.importScript = importScriptWithJson;

        if (window.import === importScript) {
            window.import = importScriptWithJson;
        }
    }
}
