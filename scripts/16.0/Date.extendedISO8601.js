(function () {
    const NativeDate = Date;
    const testDate = "2025-07-25 06:45:34.123+07:00";
    const supports = !isNaN(NativeDate.parse(testDate));

    if (supports) return; // Native support present

    function parseFlexibleDate(str) {
        const re =
            /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):?(\d{2}))?$/;
        const m = re.exec(str);
        if (!m) return null;

        const [
            ,
            y,
            mo,
            d,
            h,
            mi,
            s,
            ms = "0",
            tzSign,
            tzHour = "0",
            tzMin = "0",
        ] = m;

        // Create time in UTC first
        const utcMillis = Date.UTC(
            Number(y),
            Number(mo) - 1,
            Number(d),
            Number(h),
            Number(mi),
            Number(s),
            Number(ms.padEnd(3, "0")) // ensure 3-digit ms
        );

        let offset = 0;
        if (tzSign === "+" || tzSign === "-") {
            const offsetMin = Number(tzHour) * 60 + Number(tzMin);
            offset = offsetMin * 60000 * (tzSign === "+" ? -1 : 1); // reverse for UTC correction
        }

        return new NativeDate(utcMillis + offset);
    }

    function PatchedDate(...args) {
        if (this instanceof PatchedDate) {
            if (args.length === 1 && typeof args[0] === "string") {
                const parsed = parseFlexibleDate(args[0]);
                if (parsed) return parsed;
            }
            return new NativeDate(...args);
        }

        // Function call (Date(...))
        if (args.length === 1 && typeof args[0] === "string") {
            const parsed = parseFlexibleDate(args[0]);
            if (parsed) return parsed.toString();
        }
        return NativeDate(...args).toString();
    }

    PatchedDate.prototype = NativeDate.prototype;
    PatchedDate.now = NativeDate.now;
    PatchedDate.UTC = NativeDate.UTC;
    PatchedDate.parse = function (str) {
        if (typeof str === "string") {
            const parsed = parseFlexibleDate(str);
            if (parsed) return parsed.getTime();
        }
        return NativeDate.parse(str);
    };

    globalThis.Date = PatchedDate;
})();
