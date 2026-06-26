if (typeof Uint8Array === 'function') {
    const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const hexAlphabet = '0123456789abcdef';

    function define(target, name, value) {
        if (!(name in target)) {
            Object.defineProperty(target, name, {
                value: value,
                writable: true,
                configurable: true
            });
        }
    }

    function requireString(value) {
        if (typeof value !== 'string') {
            throw new TypeError('Expected a string');
        }
        return value;
    }

    function requireUint8Array(value) {
        if (!(value instanceof Uint8Array)) {
            throw new TypeError('Expected a Uint8Array');
        }
        return value;
    }

    function getOptions(options) {
        if (options === undefined) options = {};
        if (options === null || typeof options !== 'object') {
            throw new TypeError('Expected an options object');
        }

        const alphabet = options.alphabet === undefined ? 'base64' : options.alphabet;
        if (alphabet !== 'base64' && alphabet !== 'base64url') {
            throw new TypeError('Invalid base64 alphabet');
        }

        const lastChunkHandling = options.lastChunkHandling === undefined ? 'loose' : options.lastChunkHandling;
        if (lastChunkHandling !== 'loose' && lastChunkHandling !== 'strict' && lastChunkHandling !== 'stop-before-partial') {
            throw new TypeError('Invalid last chunk handling');
        }

        return {
            alphabet: alphabet,
            chars: alphabet === 'base64url' ? base64UrlAlphabet : base64Alphabet,
            lastChunkHandling: lastChunkHandling,
            omitPadding: options.omitPadding === true
        };
    }

    function buildLookup(chars) {
        const lookup = {};
        for (let i = 0; i < chars.length; i++) {
            lookup[chars.charAt(i)] = i;
        }
        return lookup;
    }

    function cleanBase64(string) {
        return string.replace(/[\t\n\f\r ]/g, '');
    }

    function normalizeBase64(string, options) {
        const clean = cleanBase64(requireString(string));
        if (clean.indexOf('=') !== -1 && !/={0,2}$/.test(clean)) {
            throw new SyntaxError('Invalid base64 padding');
        }

        let end = clean;
        if (options.lastChunkHandling === 'stop-before-partial') {
            const remainder = end.length % 4;
            if (remainder === 1 || (remainder === 2 && end.charAt(end.length - 1) === '=')) {
                throw new SyntaxError('Invalid base64 length');
            }
            if (remainder !== 0) {
                end = end.slice(0, end.length - remainder);
            }
        } else if (options.lastChunkHandling === 'strict') {
            if (end.length % 4 !== 0) {
                throw new SyntaxError('Invalid base64 length');
            }
        } else {
            const remainder = end.length % 4;
            if (remainder === 1) {
                throw new SyntaxError('Invalid base64 length');
            }
            if (remainder) {
                end += remainder === 2 ? '==' : '=';
            }
        }

        return end;
    }

    function decodeBase64(string, options) {
        const normalized = normalizeBase64(string, options);
        const lookup = buildLookup(options.chars);
        const bytes = [];

        for (let i = 0; i < normalized.length; i += 4) {
            appendBase64Chunk(bytes, normalized, i, lookup, options);
        }

        return bytes;
    }

    function appendBase64Chunk(bytes, normalized, index, lookup, options) {
        const a = normalized.charAt(index);
        const b = normalized.charAt(index + 1);
        const c = normalized.charAt(index + 2);
        const d = normalized.charAt(index + 3);
        const padding = (c === '=' ? 2 : d === '=' ? 1 : 0);

        if (a === '=' || b === '=' || (padding && index + 4 !== normalized.length)) {
            throw new SyntaxError('Invalid base64 padding');
        }

        const x = lookup[a];
        const y = lookup[b];
        const z = c === '=' ? 0 : lookup[c];
        const w = d === '=' ? 0 : lookup[d];
        if (x === undefined || y === undefined || z === undefined || w === undefined) {
            throw new SyntaxError('Invalid base64 character');
        }

        if (options.lastChunkHandling === 'strict') {
            if (padding === 2 && (y & 15) !== 0) {
                throw new SyntaxError('Invalid base64 overflow bits');
            }
            if (padding === 1 && (z & 3) !== 0) {
                throw new SyntaxError('Invalid base64 overflow bits');
            }
        }

        bytes.push((x << 2) | (y >> 4));
        if (padding < 2) {
            bytes.push(((y & 15) << 4) | (z >> 2));
        }
        if (padding < 1) {
            bytes.push(((z & 3) << 6) | w);
        }
    }

    function decodedChunkLength(normalized, index) {
        const c = normalized.charAt(index + 2);
        const d = normalized.charAt(index + 3);

        return c === '=' ? 1 : d === '=' ? 2 : 3;
    }

    function toBase64(options) {
        const array = requireUint8Array(this);
        options = getOptions(options);

        let result = '';
        for (let i = 0; i < array.length; i += 3) {
            const a = array[i];
            const b = i + 1 < array.length ? array[i + 1] : 0;
            const c = i + 2 < array.length ? array[i + 2] : 0;

            result += options.chars.charAt(a >> 2);
            result += options.chars.charAt(((a & 3) << 4) | (b >> 4));
            result += i + 1 < array.length ? options.chars.charAt(((b & 15) << 2) | (c >> 6)) : '=';
            result += i + 2 < array.length ? options.chars.charAt(c & 63) : '=';
        }

        return options.omitPadding ? result.replace(/=+$/, '') : result;
    }

    function fromBase64(string, options) {
        return new Uint8Array(decodeBase64(string, getOptions(options)));
    }

    function setFromBase64(string, options) {
        const target = requireUint8Array(this);
        string = requireString(string);
        options = getOptions(options);
        const normalized = normalizeBase64(string, options);
        const lookup = buildLookup(options.chars);
        const bytes = [];
        let read = 0;

        for (let i = 0; i < normalized.length; i += 4) {
            const needed = decodedChunkLength(normalized, i);
            if (bytes.length + needed > target.length) {
                break;
            }

            appendBase64Chunk(bytes, normalized, i, lookup, options);
            read += 4;
        }

        for (let i = 0; i < bytes.length; i++) {
            target[i] = bytes[i];
        }

        return {
            read: read,
            written: bytes.length
        };
    }

    function fromHex(string) {
        string = requireString(string);
        if (string.length % 2) {
            throw new SyntaxError('Invalid hex length');
        }

        const result = new Uint8Array(string.length / 2);
        const written = writeHex(result, string);
        if (written.read !== string.length) {
            throw new SyntaxError('Invalid hex character');
        }
        return result;
    }

    function writeHex(target, string) {
        let read = 0;
        let written = 0;

        while (read < string.length && written < target.length) {
            const high = hexAlphabet.indexOf(string.charAt(read).toLowerCase());
            const low = hexAlphabet.indexOf(string.charAt(read + 1).toLowerCase());
            if (high < 0 || low < 0 || read + 1 >= string.length) {
                throw new SyntaxError('Invalid hex character');
            }

            target[written++] = (high << 4) | low;
            read += 2;
        }

        return { read: read, written: written };
    }

    function setFromHex(string) {
        string = requireString(string);
        return writeHex(requireUint8Array(this), string);
    }

    function toHex() {
        const array = requireUint8Array(this);
        let result = '';

        for (let i = 0; i < array.length; i++) {
            result += hexAlphabet.charAt(array[i] >> 4);
            result += hexAlphabet.charAt(array[i] & 15);
        }

        return result;
    }

    define(Uint8Array, 'fromBase64', fromBase64);
    define(Uint8Array, 'fromHex', fromHex);
    define(Uint8Array.prototype, 'toBase64', toBase64);
    define(Uint8Array.prototype, 'toHex', toHex);
    define(Uint8Array.prototype, 'setFromBase64', setFromBase64);
    define(Uint8Array.prototype, 'setFromHex', setFromHex);
}
