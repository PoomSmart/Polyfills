// Runtime blacklist gate for per-script polyfill loading.
// Tweak.x prepends `window.__pfBL = {...}` when preferences define blacklists,
// then injects this file once before all polyfills (document start or end).
(function () {
    function stringEndsWith(str, suffix) {
        var idx = str.length - suffix.length;
        return idx >= 0 && str.indexOf(suffix, idx) === idx;
    }

    function hostMatchesDomain(host, domain) {
        return host === domain || stringEndsWith(host, "." + domain);
    }

    function matchesDomain(entry) {
        if (!entry) {
            return false;
        }
        entry = String(entry).toLowerCase();
        var h = location.hostname.toLowerCase();
        var path = location.pathname;
        var slash = entry.indexOf("/");
        if (slash < 0) {
            return hostMatchesDomain(h, entry);
        }
        var host = entry.substring(0, slash);
        var pref = entry.substring(slash + 1);
        if (hostMatchesDomain(h, host)) {
            var prefPath = "/" + pref.replace(/^\/+/, "");
            return (
                path === prefPath ||
                path.indexOf(
                    prefPath + (prefPath.charAt(prefPath.length - 1) === "/" ? "" : "/")
                ) === 0
            );
        }
        return false;
    }

    window.__pfShouldRun = function (script) {
        var orig = script;
        script = String(script || "").toLowerCase();
        var bl = window.__pfBL;
        if (!bl) {
            return true;
        }

        var globalArr = bl["*"];
        if (globalArr && globalArr.length) {
            for (var i = 0; i < globalArr.length; i++) {
                if (matchesDomain(globalArr[i])) {
                    try {
                        console.log(
                            "[Polyfills] Skipped " + orig + " (global blacklist)"
                        );
                    } catch (_) {}
                    return false;
                }
            }
        }

        var arr = bl[script];
        if (!arr || !arr.length) {
            return true;
        }
        for (var j = 0; j < arr.length; j++) {
            if (matchesDomain(arr[j])) {
                try {
                    console.log(
                        "[Polyfills] Skipped " + orig + " (script blacklist)"
                    );
                } catch (_) {}
                return false;
            }
        }
        return true;
    };
})();
