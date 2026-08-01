/**
 * @ungap/structured-clone - A structuredClone polyfill
 * https://github.com/ungap/structured-clone
 * (c) Andrea Giammarchi - ISC License
 */
(function () {
    var VOID = -1;
    var PRIMITIVE = 0;
    var ARRAY = 1;
    var OBJECT = 2;
    var DATE = 3;
    var REGEXP = 4;
    var MAP = 5;
    var SET = 6;
    var ERROR = 7;
    var BIGINT = 8;

    var env = typeof self === 'object' ? self : globalThis;

    var guard = function (name, init) {
        switch (name) {
            case 'Function':
            case 'SharedWorker':
            case 'Worker':
            case 'eval':
            case 'setInterval':
            case 'setTimeout':
                throw new TypeError('unable to deserialize ' + name);
        }
        return new env[name](init);
    };

    var deserializer = function ($, _) {
        var as = function (out, index) {
            $.set(index, out);
            return out;
        };

        var unpair = function (index) {
            if ($.has(index)) return $.get(index);

            var pair = _[index];
            var type = pair[0];
            var value = pair[1];

            switch (type) {
                case PRIMITIVE:
                case VOID:
                    return as(value, index);
                case ARRAY: {
                    var arr = as([], index);
                    for (var i = 0; i < value.length; i++) {
                        arr.push(unpair(value[i]));
                    }
                    return arr;
                }
                case OBJECT: {
                    var object = as({}, index);
                    for (var j = 0; j < value.length; j++) {
                        var entry = value[j];
                        object[unpair(entry[0])] = unpair(entry[1]);
                    }
                    return object;
                }
                case DATE:
                    return as(new Date(value), index);
                case REGEXP: {
                    return as(new RegExp(value.source, value.flags), index);
                }
                case MAP: {
                    var map = as(new Map(), index);
                    for (var k = 0; k < value.length; k++) {
                        var mapEntry = value[k];
                        map.set(unpair(mapEntry[0]), unpair(mapEntry[1]));
                    }
                    return map;
                }
                case SET: {
                    var set = as(new Set(), index);
                    for (var s = 0; s < value.length; s++) {
                        set.add(unpair(value[s]));
                    }
                    return set;
                }
                case ERROR: {
                    return as(
                        typeof env[value.name] === 'function'
                            ? guard(value.name, value.message)
                            : new Error(value.message),
                        index
                    );
                }
                case BIGINT:
                    return as(BigInt(value), index);
                case 'BigInt':
                    return as(Object(BigInt(value)), index);
                case 'ArrayBuffer':
                    return as(new Uint8Array(value).buffer, value);
                case 'DataView': {
                    var buffer = new Uint8Array(value).buffer;
                    return as(new DataView(buffer), value);
                }
            }

            return as(guard(type, value), index);
        };

        return unpair;
    };

    var deserialize = function (serialized) {
        return deserializer(new Map(), serialized)(0);
    };

    var EMPTY = '';
    var toString = {}.toString;
    var keys = Object.keys;

    var typeOf = function (value) {
        var type = typeof value;
        if (type !== 'object' || !value) return [PRIMITIVE, type];

        var asString = toString.call(value).slice(8, -1);
        switch (asString) {
            case 'Array':
                return [ARRAY, EMPTY];
            case 'Object':
                return [OBJECT, EMPTY];
            case 'Date':
                return [DATE, EMPTY];
            case 'RegExp':
                return [REGEXP, EMPTY];
            case 'Map':
                return [MAP, EMPTY];
            case 'Set':
                return [SET, EMPTY];
            case 'DataView':
                return [ARRAY, asString];
        }

        if (asString.indexOf('Array') !== -1) return [ARRAY, asString];
        if (value instanceof Error) return [ERROR, value.name || 'Error'];
        return [OBJECT, asString];
    };

    var shouldSkip = function (typed) {
        return typed[0] === PRIMITIVE && (typed[1] === 'function' || typed[1] === 'symbol');
    };

    var serializer = function (strict, json, $, _) {
        var as = function (out, value) {
            var index = _.push(out) - 1;
            $.set(value, index);
            return index;
        };

        var pair = function (value) {
            if ($.has(value)) return $.get(value);

            var typed = typeOf(value);
            var TYPE = typed[0];
            var kind = typed[1];

            switch (TYPE) {
                case PRIMITIVE: {
                    var entry = value;
                    switch (kind) {
                        case 'bigint':
                            TYPE = BIGINT;
                            entry = value.toString();
                            break;
                        case 'function':
                        case 'symbol':
                            if (strict) {
                                throw new TypeError('unable to serialize ' + kind);
                            }
                            entry = null;
                            break;
                        case 'undefined':
                            return as([VOID], value);
                    }
                    return as([TYPE, entry], value);
                }
                case ARRAY: {
                    if (kind) {
                        var spread = value;
                        if (kind === 'DataView') {
                            spread = new Uint8Array(value.buffer);
                        } else if (kind === 'ArrayBuffer') {
                            spread = new Uint8Array(value);
                        }
                        return as([kind, Array.from(spread)], value);
                    }

                    var arr = [];
                    var arrIndex = as([TYPE, arr], value);
                    for (var i = 0; i < value.length; i++) {
                        arr.push(pair(value[i]));
                    }
                    return arrIndex;
                }
                case OBJECT: {
                    if (kind) {
                        switch (kind) {
                            case 'BigInt':
                                return as([kind, value.toString()], value);
                            case 'Boolean':
                            case 'Number':
                            case 'String':
                                return as([kind, value.valueOf()], value);
                        }
                    }

                    if (json && 'toJSON' in value) {
                        return pair(value.toJSON());
                    }

                    var entries = [];
                    var objIndex = as([TYPE, entries], value);
                    var props = keys(value);
                    for (var j = 0; j < props.length; j++) {
                        var key = props[j];
                        if (strict || !shouldSkip(typeOf(value[key]))) {
                            entries.push([pair(key), pair(value[key])]);
                        }
                    }
                    return objIndex;
                }
                case DATE:
                    return as(
                        [TYPE, isNaN(value.getTime()) ? EMPTY : value.toISOString()],
                        value
                    );
                case REGEXP:
                    return as(
                        [TYPE, { source: value.source, flags: value.flags }],
                        value
                    );
                case MAP: {
                    var mapEntries = [];
                    var mapIndex = as([TYPE, mapEntries], value);
                    value.forEach(function (mapValue, mapKey) {
                        if (
                            strict ||
                            !(shouldSkip(typeOf(mapKey)) || shouldSkip(typeOf(mapValue)))
                        ) {
                            mapEntries.push([pair(mapKey), pair(mapValue)]);
                        }
                    });
                    return mapIndex;
                }
                case SET: {
                    var setEntries = [];
                    var setIndex = as([TYPE, setEntries], value);
                    value.forEach(function (setValue) {
                        if (strict || !shouldSkip(typeOf(setValue))) {
                            setEntries.push(pair(setValue));
                        }
                    });
                    return setIndex;
                }
            }

            return as([TYPE, { name: kind, message: value.message }], value);
        };

        return pair;
    };

    var serialize = function (value, options) {
        options = options || {};
        var records = [];
        return serializer(!(options.json || options.lossy), !!options.json, new Map(), records)(
            value
        ), records;
    };

    var globals =
        typeof globalThis === 'undefined'
            ? typeof self === 'undefined'
                ? typeof global === 'undefined'
                    ? {}
                    : global
                : self
            : globalThis;

    if (!('structuredClone' in globals)) {
        globals.structuredClone = function (any, options) {
            return deserialize(serialize(any, options));
        };
    }
})();
