if (!String.prototype.matchAll) {
    String.prototype.matchAll = function (regexp) {
        if (regexp == null) {
            throw new TypeError("RegExp must be non-null");
        }
        if (!(regexp instanceof RegExp)) {
            throw new TypeError("Argument must be a RegExp");
        }

        const str = String(this);
        const global = regexp.global;

        if (!global) {
            const match = regexp.exec(str);
            return (function* () {
                if (match) yield match;
            })();
        }

        const re = new RegExp(regexp.source, regexp.flags); // Clone RegExp
        re.lastIndex = 0;

        return (function* () {
            let match;
            while ((match = re.exec(str)) !== null) {
                yield match;
                if (match[0] === "") {
                    // Avoid infinite loop on zero-length match
                    re.lastIndex++;
                }
            }
        })();
    };
}
