// ChatGPT — color-mix() -> rgb() fallback for browsers without color-mix support
(function polyfillColorMix() {
    const DEBUG = false;
    const LOG_PREFIX = "[color-mix-fallback]";
    let __logCount = 0;
    const MAX_LOGS = 300;
    function dbg(...args) {
        if (!DEBUG) return;
        if (__logCount++ > MAX_LOGS) return;
        try {
            console.debug(LOG_PREFIX, ...args);
        } catch (_) {}
    }

    try {
        const has = !!(
            window.CSS &&
            CSS.supports &&
            CSS.supports("color: color-mix(in srgb, red, blue)")
        );
        if (has) {
            dbg("Native color-mix supported; skipping");
            return;
        }
    } catch (_) {}

    if (window.__colorMixFallbackApplied) return;
    window.__colorMixFallbackApplied = true;

    // Utilities
    function clamp01(x) {
        return x < 0 ? 0 : x > 1 ? 1 : x;
    }
    function srgbToLinear(x) {
        x = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        return x;
    }
    function linearToSrgb(x) {
        return x <= 0.0031308
            ? 12.92 * x
            : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    }
    function toRGBString(r01, g01, b01, a) {
        const R = Math.round(r01 * 255),
            G = Math.round(g01 * 255),
            B = Math.round(b01 * 255);
        if (a == null || a >= 1) return `rgb(${R}, ${G}, ${B})`;
        return `rgba(${R}, ${G}, ${B}, ${Math.max(0, Math.min(1, a))})`;
    }
    function hueToDeg(h, unit) {
        switch ((unit || "deg").toLowerCase()) {
            case "":
            case "deg":
                return h;
            case "rad":
                return h * (180 / Math.PI);
            case "turn":
                return h * 360;
            case "grad":
                return h * 0.9;
            default:
                return h;
        }
    }

    // Capability flags for advanced color functions
    const CAPS = { oklch: false, oklab: false, lch: false, lab: false };
    try { CAPS.oklch = !!(window.CSS && CSS.supports && CSS.supports("color: oklch(50% 0.1 200)")); } catch (_) {}
    try { CAPS.oklab = !!(window.CSS && CSS.supports && CSS.supports("color: oklab(0.5 0 0)")); } catch (_) {}
    try { CAPS.lch =   !!(window.CSS && CSS.supports && CSS.supports("color: lch(50% 40 200)")); } catch (_) {}
    try { CAPS.lab =   !!(window.CSS && CSS.supports && CSS.supports("color: lab(50% 40 20)")); } catch (_) {}

    // Parse colors: #rgb[a], #rrggbb[aa], rgb[a](), hsl[a](), oklch/oklab/lab/lch (best-effort for oklch via your existing converter if available)
    function parseNumberWithUnit(token) {
        const m = String(token)
            .trim()
            .match(/^([+-]?(?:\d+\.\d+|\d*\.\d+|\d+))(.*)$/);
        if (!m) return null;
        return { value: parseFloat(m[1]), unit: (m[2] || "").trim() };
    }
    function parseHexColor(s) {
        s = s.trim();
        if (!/^#([0-9a-f]{3,8})$/i.test(s)) return null;
        const h = s.slice(1);
        let r,
            g,
            b,
            a = 255;
        if (h.length === 3) {
            r = parseInt(h[0] + h[0], 16);
            g = parseInt(h[1] + h[1], 16);
            b = parseInt(h[2] + h[2], 16);
        } else if (h.length === 4) {
            r = parseInt(h[0] + h[0], 16);
            g = parseInt(h[1] + h[1], 16);
            b = parseInt(h[2] + h[2], 16);
            a = parseInt(h[3] + h[3], 16);
        } else if (h.length === 6) {
            r = parseInt(h.slice(0, 2), 16);
            g = parseInt(h.slice(2, 4), 16);
            b = parseInt(h.slice(4, 6), 16);
        } else if (h.length === 8) {
            r = parseInt(h.slice(0, 2), 16);
            g = parseInt(h.slice(2, 4), 16);
            b = parseInt(h.slice(4, 6), 16);
            a = parseInt(h.slice(6, 8), 16);
        } else return null;
        return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
    }
    function parseFunctionalColor(s) {
        const t = s.trim().toLowerCase();
        // rgb/rgba
        let m = t.match(/^rgba?\((.*)\)$/);
        if (m) {
            const parts = m[1].split("/");
            const main = parts[0];
            const alpha = parts[1] ? parts[1].trim() : null;
            const nums =
                main.split(",").length > 1
                    ? main.split(",")
                    : main.trim().split(/\s+/);
            let [r, g, b] = nums.map((x) => x.trim());
            const pr = parseNumberWithUnit(r),
                pg = parseNumberWithUnit(g),
                pb = parseNumberWithUnit(b);
            if (!pr || !pg || !pb) return null;
            const R = pr.unit === "%" ? pr.value / 100 : pr.value / 255,
                G = pg.unit === "%" ? pg.value / 100 : pg.value / 255,
                B = pb.unit === "%" ? pb.value / 100 : pb.value / 255;
            let A = 1;
            if (alpha) {
                const pa = parseNumberWithUnit(alpha);
                if (pa) A = pa.unit === "%" ? pa.value / 100 : pa.value;
            }
            return {
                r: clamp01(R),
                g: clamp01(G),
                b: clamp01(B),
                a: clamp01(A),
            };
        }
        // hsl/hsla
        m = t.match(/^hsla?\((.*)\)$/);
        if (m) {
            const parts = m[1].split("/");
            const main = parts[0];
            const alpha = parts[1] ? parts[1].trim() : null;
            const nums =
                main.split(",").length > 1
                    ? main.split(",")
                    : main.trim().split(/\s+/);
            let [hh, ss, ll] = nums.map((x) => x.trim());
            const ph = parseNumberWithUnit(hh),
                ps = parseNumberWithUnit(ss),
                pl = parseNumberWithUnit(ll);
            if (!ph || !ps || !pl) return null;
            const H = (() => {
                const u = (ph.unit || "deg").toLowerCase();
                if (u === "deg" || u === "") return ph.value;
                if (u === "rad") return ph.value * (180 / Math.PI);
                if (u === "turn") return ph.value * 360;
                if (u === "grad") return ph.value * 0.9;
                return ph.value;
            })();
            const S = ps.unit === "%" ? ps.value / 100 : ps.value;
            const L = pl.unit === "%" ? pl.value / 100 : pl.value;
            const c = (1 - Math.abs(2 * L - 1)) * S;
            const hprime = (((H % 360) + 360) % 360) / 60;
            const x = c * (1 - Math.abs((hprime % 2) - 1));
            let r1 = 0,
                g1 = 0,
                b1 = 0;
            if (hprime < 1) {
                r1 = c;
                g1 = x;
            } else if (hprime < 2) {
                r1 = x;
                g1 = c;
            } else if (hprime < 3) {
                g1 = c;
                b1 = x;
            } else if (hprime < 4) {
                g1 = x;
                b1 = c;
            } else if (hprime < 5) {
                r1 = x;
                b1 = c;
            } else {
                r1 = c;
                b1 = x;
            }
            const mmm = L - c / 2;
            const R = r1 + mmm,
                G = g1 + mmm,
                B = b1 + mmm;
            let A = 1;
            if (alpha) {
                const pa = parseNumberWithUnit(alpha);
                if (pa) A = pa.unit === "%" ? pa.value / 100 : pa.value;
            }
            return {
                r: clamp01(R),
                g: clamp01(G),
                b: clamp01(B),
                a: clamp01(A),
            };
        }
        // oklch()
        m = t.match(/^oklch\((.*)\)$/);
        if (m) {
            const parts = m[1].split("/");
            const main = parts[0].trim();
            const alpha = parts[1] ? parts[1].trim() : null;
            const toks = main.split(/[\s,]+/).filter(Boolean);
            if (toks.length < 3) return null;
            const Lp = parseNumberWithUnit(toks[0]);
            const Cn = parseNumberWithUnit(toks[1]);
            const Hn = parseNumberWithUnit(toks[2]);
            if (!Lp || !Cn || !Hn) return null;
            const L = Lp.unit === "%" ? Lp.value / 100 : Lp.value;
            const C = Cn.unit === "%" ? Cn.value / 100 : Cn.value;
            const H = hueToDeg(Hn.value, Hn.unit);
            const [r, g, b] = oklchToSRGB(L, C, H);
            let A = 1;
            if (alpha) {
                const pa = parseNumberWithUnit(alpha);
                if (pa) A = pa.unit === "%" ? pa.value / 100 : pa.value;
            }
            return { r, g, b, a: clamp01(A) };
        }
        // oklab()
        m = t.match(/^oklab\((.*)\)$/);
        if (m) {
            const parts = m[1].split("/");
            const main = parts[0].trim();
            const alpha = parts[1] ? parts[1].trim() : null;
            const toks = main.split(/[\s,]+/).filter(Boolean);
            if (toks.length < 3) return null;
            const Lp = parseNumberWithUnit(toks[0]);
            const an = parseNumberWithUnit(toks[1]);
            const bn = parseNumberWithUnit(toks[2]);
            if (!Lp || !an || !bn) return null;
            const L = Lp.unit === "%" ? Lp.value / 100 : Lp.value;
            const a = an.value;
            const b = bn.value;
            const [r, g, b2] = oklabToSRGB(L, a, b);
            let A = 1;
            if (alpha) {
                const pa = parseNumberWithUnit(alpha);
                if (pa) A = pa.unit === "%" ? pa.value / 100 : pa.value;
            }
            return { r, g, b: b2, a: clamp01(A) };
        }
        // lch() CIE
        m = t.match(/^lch\((.*)\)$/);
        if (m) {
            const parts = m[1].split("/");
            const main = parts[0].trim();
            const alpha = parts[1] ? parts[1].trim() : null;
            const toks = main.split(/[\s,]+/).filter(Boolean);
            if (toks.length < 3) return null;
            const Lp = parseNumberWithUnit(toks[0]);
            const Cn = parseNumberWithUnit(toks[1]);
            const Hn = parseNumberWithUnit(toks[2]);
            if (!Lp || !Cn || !Hn) return null;
            const L = Lp.unit === "%" ? Lp.value : Lp.value;
            const C = Cn.value;
            const H = hueToDeg(Hn.value, Hn.unit);
            const a = C * Math.cos((H * Math.PI) / 180),
                b = C * Math.sin((H * Math.PI) / 180);
            const [r, g, b2] = labToSRGB(L, a, b);
            let A = 1;
            if (alpha) {
                const pa = parseNumberWithUnit(alpha);
                if (pa) A = pa.unit === "%" ? pa.value / 100 : pa.value;
            }
            return { r, g, b: b2, a: clamp01(A) };
        }
        // lab() CIE
        m = t.match(/^lab\((.*)\)$/);
        if (m) {
            const parts = m[1].split("/");
            const main = parts[0].trim();
            const alpha = parts[1] ? parts[1].trim() : null;
            const toks = main.split(/[\s,]+/).filter(Boolean);
            if (toks.length < 3) return null;
            const Lp = parseNumberWithUnit(toks[0]);
            const an = parseNumberWithUnit(toks[1]);
            const bn = parseNumberWithUnit(toks[2]);
            if (!Lp || !an || !bn) return null;
            const L = Lp.unit === "%" ? Lp.value : Lp.value;
            const a = an.value;
            const b = bn.value;
            const [r, g, b2] = labToSRGB(L, a, b);
            let A = 1;
            if (alpha) {
                const pa = parseNumberWithUnit(alpha);
                if (pa) A = pa.unit === "%" ? pa.value / 100 : pa.value;
            }
            return { r, g, b: b2, a: clamp01(A) };
        }
        return null;
    }
    function parseColor(s) {
        return parseHexColor(s) || parseFunctionalColor(s);
    }

    // Conversions: OKLab/OKLCH and CIE Lab/LCH to sRGB
    function oklchToSRGB(Lp, C, Hdeg) {
        const hrad = ((Hdeg % 360) * Math.PI) / 180;
        const a = C * Math.cos(hrad);
        const b = C * Math.sin(hrad);
        return oklabToSRGB(Lp, a, b);
    }
    function oklabToSRGB(L, a, b) {
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.291485548 * b;
        const l = l_ * l_ * l_;
        const m = m_ * m_ * m_;
        const s = s_ * s_ * s_;
        let r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
        let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
        let b2 = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
        r = linearToSrgb(r);
        g = linearToSrgb(g);
        b2 = linearToSrgb(b2);
        return [clamp01(r), clamp01(g), clamp01(b2)];
    }
    function labToSRGB(L, a, b) {
        // CIE Lab D50 -> D65 sRGB
        const fy = (L + 16) / 116;
        const fx = fy + a / 500;
        const fz = fy - b / 200;
        const delta = 6 / 29;
        function fInv(t) {
            return t > delta ? t * t * t : 3 * delta * delta * (t - 4 / 29);
        }
        const Xn = 0.96422,
            Yn = 1,
            Zn = 0.82521;
        let X = Xn * fInv(fx);
        let Y = Yn * fInv(fy);
        let Z = Zn * fInv(fz);
        // Bradford adaptation D50 -> D65
        const M = [
            [0.8951, 0.2664, -0.1614],
            [-0.7502, 1.7135, 0.0367],
            [0.0389, -0.0685, 1.0296],
        ];
        const Minv = [
            [0.9869929, -0.1470543, 0.1599627],
            [0.4323053, 0.5183603, 0.0492912],
            [-0.0085287, 0.0400428, 0.9684867],
        ];
        function mult3(M, v) {
            return [
                M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
                M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
                M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
            ];
        }
        const D50 = mult3(M, [X, Y, Z]);
        const D65Scale = [0.95047 / 0.96422, 1 / 1.0, 1.08883 / 0.82521]; // scale cone response
        const D65 = [
            D50[0] * D65Scale[0],
            D50[1] * D65Scale[1],
            D50[2] * D65Scale[2],
        ];
        const XYZd65 = mult3(Minv, D65);
        const x = XYZd65[0],
            y = XYZd65[1],
            z = XYZd65[2];
        let r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
        let g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
        let b2 = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
        r = linearToSrgb(r);
        g = linearToSrgb(g);
        b2 = linearToSrgb(b2);
        return [clamp01(r), clamp01(g), clamp01(b2)];
    }

    // var() resolution for dynamic values
    function resolveVar(el, chunk, localVars) {
        const m = String(chunk).match(
            /^var\(\s*([^,\s)]+)\s*(?:,\s*(.*))?\)$/i
        );
        if (!m) return null;
        const name = m[1];
        const fallback = m[2];
        let val = "";
        if (
            localVars &&
            Object.prototype.hasOwnProperty.call(localVars, name)
        ) {
            val = String(localVars[name] || "").trim();
        }
        if (!val) {
            try {
                val = getComputedStyle(el).getPropertyValue(name) || "";
            } catch (_) {}
            val = String(val).trim();
        }
        if (!val && fallback != null) return String(fallback).trim();
        return val || null;
    }
    function resolveVarsRecursive(el, s, depth = 0, localVars) {
        if (depth > 5) return s;
        let out = String(s);
        const re = /var\(([^()]*?(?:\((?:[^()]+|\([^()]*\))*\)[^()]*)*)\)/gi;
        let m;
        while ((m = re.exec(out))) {
            const full = m[0];
            const val = resolveVar(el, full, localVars) || "";
            out = out.replace(full, val);
            re.lastIndex = 0;
        }
        return /var\(/i.test(out)
            ? resolveVarsRecursive(el, out, depth + 1, localVars)
            : out;
    }

    // Helper: parse colors with currentColor and named colors via computed style fallback
    let __colorProbe = null;
    function browserParseColor(s) {
        try {
            if (!__colorProbe) {
                __colorProbe = document.createElement("span");
                __colorProbe.style.display = "none";
                (document.head || document.documentElement || document.body).appendChild(__colorProbe);
            }
            __colorProbe.style.color = s;
            const c = getComputedStyle(__colorProbe).color;
            return parseFunctionalColor(c) || parseHexColor(c);
        } catch (_) { return null; }
    }
    function parseColorFlexible(el, colorStr) {
        const s = String(colorStr).trim();
        if (!s) return null;
        const parsed = parseHexColor(s) || parseFunctionalColor(s);
        if (parsed) return parsed;
        if (/^currentcolor$/i.test(s)) {
            try {
                const c = getComputedStyle(el).color;
                return parseFunctionalColor(c) || parseHexColor(c);
            } catch (_) {}
        }
        // Prefer browser parsing when the space is supported to avoid manual conversion
        if (/^oklch\(/i.test(s) && CAPS.oklch) { const r = browserParseColor(s); if (r) return r; }
        if (/^oklab\(/i.test(s) && CAPS.oklab) { const r = browserParseColor(s); if (r) return r; }
        if (/^lch\(/i.test(s)   && CAPS.lch)   { const r = browserParseColor(s); if (r) return r; }
        if (/^lab\(/i.test(s)   && CAPS.lab)   { const r = browserParseColor(s); if (r) return r; }
        // fallback probe for names and any other syntaxes the engine can parse
        const probe = browserParseColor(s);
        if (probe) return probe;
        return null;
    }

    // Mix in sRGB by default (per color-mix syntax): color-mix(in <space>, <color> <p?>, <color> <p?>)
    function parseColorStop(part) {
        // returns { color:{r,g,b,a}, p:0..1 | null }
        const bits = part.trim().split(/\s+(?![^()]*\))/); // split by spaces not inside ()
        if (!bits.length) return null; // last token may be percentage
        let p = null,
            colorStr = part.trim();
        if (bits.length > 1) {
            const last = bits[bits.length - 1];
            const pn = parseNumberWithUnit(last);
            if (pn && (pn.unit === "%" || pn.unit === "")) {
                p = pn.unit === "%" ? pn.value / 100 : pn.value;
                colorStr = bits.slice(0, -1).join(" ");
            }
        }
        const color = parseColor(colorStr);
        if (!color) return null;
        return { color, p };
    }

    function mixColors(c1, w1, c2, w2) {
        // Alpha compositing: simple weighted average including alpha; mix in linear light for better result, output to sRGB
        const L1 = {
            r: srgbToLinear(c1.r),
            g: srgbToLinear(c1.g),
            b: srgbToLinear(c1.b),
            a: c1.a,
        };
        const L2 = {
            r: srgbToLinear(c2.r),
            g: srgbToLinear(c2.g),
            b: srgbToLinear(c2.b),
            a: c2.a,
        };
        const W = w1 + w2 || 1;
        const r = (L1.r * w1 + L2.r * w2) / W;
        const g = (L1.g * w1 + L2.g * w2) / W;
        const b = (L1.b * w1 + L2.b * w2) / W;
        const a = clamp01((c1.a * w1 + c2.a * w2) / W);
        return {
            r: clamp01(linearToSrgb(r)),
            g: clamp01(linearToSrgb(g)),
            b: clamp01(linearToSrgb(b)),
            a,
        };
    }

    function splitTopLevelCommas(s) {
        const parts = [];
        let depth = 0,
            start = 0;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            else if (ch === "," && depth === 0) {
                parts.push(s.slice(start, i));
                start = i + 1;
            }
        }
        parts.push(s.slice(start));
        return parts;
    }

    function parseColorMix(input) {
        const s = String(input);
        const idx = s.toLowerCase().indexOf("color-mix(");
        if (idx < 0) return null;
        let j = idx + 10,
            depth = 1; // after 'color-mix('
        while (j < s.length && depth > 0) {
            const ch = s[j];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            j++;
        }
        const inside = s.slice(idx + 10, j - 1).trim();
        // color-mix(in <space>, stop1, stop2)
        const parts = splitTopLevelCommas(inside);
        if (parts.length < 3) return null;
        const spacePart = parts[0].trim();
        if (!/^in\s+/i.test(spacePart)) return null;
        // We only implement srgb now; treat others as srgb fallback
        const stop1 = parseColorStop(parts[1]);
        const stop2 = parseColorStop(parts[2]);
        if (!stop1 || !stop2) return null;
        let w1 =
            stop1.p != null ? stop1.p : stop2.p != null ? 1 - stop2.p : 0.5;
        let w2 =
            stop2.p != null ? stop2.p : stop1.p != null ? 1 - stop1.p : 0.5;
        // Normalize weights if they don't add to 1
        const sum = w1 + w2;
        if (sum !== 1 && sum > 0) {
            w1 = w1 / sum;
            w2 = w2 / sum;
        }
        const mixed = mixColors(stop1.color, w1, stop2.color, w2);
        return { end: j, rgb: toRGBString(mixed.r, mixed.g, mixed.b, mixed.a) };
    }

    function replaceColorMixInText(input) {
        if (!input || typeof input !== "string") return input;
        let i = 0,
            out = "";
        while (i < input.length) {
            const idx = input.toLowerCase().indexOf("color-mix(", i);
            if (idx === -1) {
                out += input.slice(i);
                break;
            }
            out += input.slice(i, idx);
            let j = idx + 10,
                depth = 1;
            while (j < input.length && depth > 0) {
                const ch = input[j];
                if (ch === "(") depth++;
                else if (ch === ")") depth--;
                j++;
            }
            const seg = input.slice(i, j);
            const parsed = parseColorMix(seg);
            if (parsed) {
                out += parsed.rgb;
            } else {
                out += seg;
            }
            i = j;
        }
        return out;
    }

    // CSSOM traversal
    const RULE = {
        STYLE: 1,
        MEDIA: 4,
        FONT_FACE: 5,
        PAGE: 6,
        KEYFRAMES: 7,
        SUPPORTS: 12,
    };
    function processStyleDeclaration(style) {
        if (!style) return false;
        let changed = false;
        for (let k = 0; k < style.length; k++) {
            const prop = style[k];
            const val = style.getPropertyValue(prop);
            if (val && /color-mix\(/i.test(val)) {
                const prio = style.getPropertyPriority(prop);
                const out = replaceColorMixInText(val);
                if (out !== val) {
                    try {
                        style.setProperty(prop, out, prio);
                        changed = true;
                    } catch (_) {}
                }
            }
        }
        return changed;
    }
    function traverseAndFixRules(rules) {
        if (!rules) return false;
        let any = false;
        for (const rule of Array.from(rules)) {
            const ctor = rule && rule.constructor && rule.constructor.name;
            if (rule.type === RULE.STYLE || ctor === "CSSStyleRule") {
                any = processStyleDeclaration(rule.style) || any;
            } else if (
                rule.type === RULE.KEYFRAMES ||
                ctor === "CSSKeyframesRule" ||
                ctor === "WebKitCSSKeyframesRule"
            ) {
                for (const kf of Array.from(rule.cssRules || [])) {
                    any = processStyleDeclaration(kf.style) || any;
                }
            }
            const child = rule.cssRules || null;
            if (child) any = traverseAndFixRules(child) || any;
        }
        return any;
    }
    function processStyleTagNode(styleNode) {
        if (!styleNode || styleNode.__cmProcessed) return;
        const txt = styleNode.textContent;
        if (txt && /color-mix\(/i.test(txt)) {
            const out = replaceColorMixInText(txt);
            if (out !== txt) {
                styleNode.textContent = out;
                dbg("Processed <style> color-mix");
            }
        }
        styleNode.__cmProcessed = true;
    }

    function getStyleSheetText(sheet) {
        try {
            const rules = Array.from(sheet.cssRules || sheet.rules || []);
            return rules.map((r) => r.cssText).join("\n");
        } catch (_) {
            return null;
        }
    }
    function injectStyle(css) {
        const style = document.createElement("style");
        style.setAttribute("data-color-mix-polyfill", "");
        style.textContent = css;
        document.head.appendChild(style);
        return style;
    }
    const handledSheets = typeof WeakSet === "function" ? new WeakSet() : null;

    async function processStyleSheetObject(sheet) {
        const owner = sheet && sheet.ownerNode;
        if (owner && owner.getAttribute && owner.getAttribute("data-color-mix-polyfill") != null) return false;
        if (handledSheets) {
            if (handledSheets.has(sheet)) return false;
            handledSheets.add(sheet);
        }
        try {
            const changed = traverseAndFixRules(sheet.cssRules);
            if (changed) {
                dbg(
                    "Edited CSSOM in-place for color-mix:",
                    sheet.href || "[inline]"
                );
                return true;
            }
        } catch (e) {
            dbg(
                "Cannot access cssRules for sheet (color-mix)",
                sheet.href || "[inline]",
                e
            );
            if (sheet.href && window.__pfLoadCssText) {
                const fetched = await new Promise(function (resolve) {
                    window.__pfLoadCssText(sheet.href, function (err, text) {
                        resolve(err ? null : text);
                    });
                });
                if (fetched && /color-mix\(/i.test(fetched)) {
                    const abs = window.__pfAbsolutizeCssUrls
                        ? window.__pfAbsolutizeCssUrls(fetched, sheet.href)
                        : fetched;
                    const out = replaceColorMixInText(abs);
                    if (out && out !== abs) {
                        injectStyle(out);
                        return true;
                    }
                }
            }
        }
        const cssText = getStyleSheetText(sheet);
        if (cssText && /color-mix\(/i.test(cssText)) {
            const out = replaceColorMixInText(cssText);
            if (out !== cssText) {
                injectStyle(out);
                dbg(
                    "Injected fallback <style> for color-mix",
                    sheet.href || "[inline]"
                );
                return true;
            }
        }
        return false;
    }

    // -------- Dynamic per-element fallback with var() resolution --------
    const COLOR_PROPS = [
        "color",
        "background-color",
        "background",
        "outline-color",
        "outline",
        "text-decoration-color",
        "text-decoration",
        "border-color",
        "border-top-color",
        "border-right-color",
        "border-bottom-color",
        "border-left-color",
        "border",
        "border-top",
        "border-right",
        "border-bottom",
        "border-left",
        "column-rule-color",
        "caret-color",
        "fill",
        "stroke",
    ];
    function mapPropToInline(prop) {
        switch (prop) {
            case "background":
                return "background-color";
            case "border":
                return "border-color";
            case "border-top":
                return "border-top-color";
            case "border-right":
                return "border-right-color";
            case "border-bottom":
                return "border-bottom-color";
            case "border-left":
                return "border-left-color";
            case "outline":
                return "outline-color";
            case "text-decoration":
                return "text-decoration-color";
            default:
                return prop;
        }
    }

    let RULE_INDEX = [];
    function collectColorMixRules() {
        RULE_INDEX = [];
        const sheets = Array.from(document.styleSheets);
        for (let si = 0; si < sheets.length; si++) {
            const sheet = sheets[si];
            let rules;
            try {
                rules = sheet.cssRules;
            } catch (_) {
                continue;
            }
            if (!rules) continue;
            let order = 0;
            const walk = (list) => {
                for (let i = 0; i < list.length; i++) {
                    const r = list[i];
                    try {
                        if (r && r.cssRules && r.cssRules.length) {
                            walk(r.cssRules);
                            continue;
                        }
                    } catch (_) {}
                    if (!r || !r.selectorText || !r.style) continue;
                    const localVars = {};
                    try {
                        for (let k = 0; k < r.style.length; k++) {
                            const pn = r.style[k];
                            if (pn && pn.startsWith("--"))
                                localVars[pn] = r.style.getPropertyValue(pn);
                        }
                    } catch (_) {}
                    for (const prop of COLOR_PROPS) {
                        let val = "";
                        try {
                            val = r.style.getPropertyValue(prop) || "";
                        } catch (_) {
                            val = "";
                        }
                        if (val && /color-mix\(/i.test(val)) {
                            RULE_INDEX.push({
                                selector: r.selectorText,
                                prop,
                                val,
                                important:
                                    r.style.getPropertyPriority(prop) ===
                                    "important",
                                si,
                                oi: order++,
                                localVars,
                            });
                        }
                    }
                }
            };
            walk(rules);
        }
    }

    function splitTopLevelSpaces(s) {
        const out = [];
        let buf = "";
        let depth = 0;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === "(") {
                depth++;
                buf += ch;
                continue;
            }
            if (ch === ")") {
                depth = Math.max(0, depth - 1);
                buf += ch;
                continue;
            }
            if (/\s/.test(ch) && depth === 0) {
                if (buf.trim()) out.push(buf.trim());
                buf = "";
                continue;
            }
            buf += ch;
        }
        if (buf.trim()) out.push(buf.trim());
        return out;
    }

    function parseColorStopForElement(el, part, localVars) {
        let token = resolveVarsRecursive(el, part, 0, localVars);
        const bits = token.trim().split(/\s+(?![^()]*\))/);
        let p = null;
        if (bits.length > 1) {
            const last = bits[bits.length - 1];
            const pn = parseNumberWithUnit(last);
            if (pn) {
                if (pn.unit === "%" || pn.unit === "") {
                    p = pn.unit === "%" ? pn.value / 100 : pn.value;
                    token = bits.slice(0, -1).join(" ");
                }
            }
        }
        const color = parseColorFlexible(el, token);
        if (!color) return null;
        return { color, p };
    }

    function computeColorMixForElement(el, value, localVars) {
        const s = String(value);
        const idx = s.toLowerCase().indexOf("color-mix(");
        if (idx < 0) return null;
        let j = idx + 10,
            depth = 1;
        while (j < s.length && depth > 0) {
            const ch = s[j];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            j++;
        }
        const inside = s.slice(idx + 10, j - 1).trim();
        const parts = splitTopLevelCommas(inside);
        if (parts.length < 3) return null;
        const spacePart = resolveVarsRecursive(el, parts[0], 0, localVars);
        if (!/^in\s+/i.test(spacePart.trim())) return null; // we treat all spaces as sRGB for now
        const stop1 = parseColorStopForElement(el, parts[1], localVars);
        const stop2 = parseColorStopForElement(el, parts[2], localVars);
        if (!stop1 || !stop2) return null;
        let w1 =
            stop1.p != null ? stop1.p : stop2.p != null ? 1 - stop2.p : 0.5;
        let w2 =
            stop2.p != null ? stop2.p : stop1.p != null ? 1 - stop1.p : 0.5;
        const sum = w1 + w2;
        if (sum !== 1 && sum > 0) {
            w1 /= sum;
            w2 /= sum;
        }
        const mixed = mixColors(stop1.color, w1, stop2.color, w2);
        return toRGBString(mixed.r, mixed.g, mixed.b, mixed.a);
    }

    function applyIndexedRulesMatches() {
        if (!RULE_INDEX.length) return 0;
        let applied = 0;
        const all = document.querySelectorAll("*");
        for (const el of all) {
            for (const prop of COLOR_PROPS) {
                let winner = null;
                for (const entry of RULE_INDEX) {
                    if (entry.prop !== prop) continue;
                    try {
                        if (!el.matches(entry.selector)) continue;
                    } catch (_) {
                        continue;
                    }
                    if (!winner) {
                        winner = entry;
                        continue;
                    }
                    if (entry.important && !winner.important) {
                        winner = entry;
                        continue;
                    }
                    if (
                        entry.si > winner.si ||
                        (entry.si === winner.si &&
                            (entry.oi || 0) > (winner.oi || 0))
                    )
                        winner = entry;
                }
                if (winner) {
                    const rgb = computeColorMixForElement(
                        el,
                        winner.val,
                        winner.localVars
                    );
                    if (rgb) {
                        try {
                            el.style.setProperty(
                                mapPropToInline(prop),
                                rgb,
                                winner.important ? "important" : ""
                            );
                            applied++;
                            if (applied <= 30)
                                dbg(
                                    "Applied",
                                    mapPropToInline(prop),
                                    "to",
                                    el,
                                    "from",
                                    winner.selector,
                                    "=>",
                                    rgb
                                );
                        } catch (_) {}
                    }
                }
            }
        }
        return applied;
    }

    function applyComputedStyleFallback() {
        const all = document.querySelectorAll("*");
        let hits = 0,
            applied = 0;
        for (const el of all) {
            let cs;
            try {
                cs = getComputedStyle(el);
            } catch (_) {
                continue;
            }
            for (const prop of COLOR_PROPS) {
                let val = "";
                try {
                    val = cs.getPropertyValue(prop) || "";
                } catch (_) {
                    val = "";
                }
                if (val && /color-mix\(/i.test(val)) {
                    hits++;
                    const rgb = computeColorMixForElement(el, val, null);
                    if (rgb) {
                        try {
                            el.style.setProperty(
                                mapPropToInline(prop),
                                rgb,
                                ""
                            );
                            applied++;
                            if (applied <= 30)
                                dbg(
                                    "Applied (computed)",
                                    mapPropToInline(prop),
                                    "to",
                                    el,
                                    "=>",
                                    rgb
                                );
                        } catch (_) {}
                    }
                }
            }
        }
        if (hits && !applied)
            dbg(
                "Computed-style fallback found",
                hits,
                "color-mix but applied 0"
            );
        return applied;
    }

    async function processAllStyleSheets() {
        const allSheets = Array.from(document.styleSheets);
        dbg("Processing stylesheets (color-mix):", allSheets.length);
        for (const sheet of allSheets) {
            await processStyleSheetObject(sheet);
        }
        document.querySelectorAll("style").forEach(processStyleTagNode);
        document.querySelectorAll('[style*="color-mix("]').forEach((el) => {
            try {
                const txt = el.getAttribute("style");
                if (!txt) return;
                const out = replaceColorMixInText(txt);
                if (out !== txt) el.setAttribute("style", out);
            } catch (_) {}
        });
        // Dynamic application
        try {
            collectColorMixRules();
        } catch (_) {}
        let count = 0;
        try {
            count = applyIndexedRulesMatches();
        } catch (_) {}
        if (!count && RULE_INDEX.length) {
            try {
                applyComputedStyleFallback();
            } catch (_) {}
        }
    }

    // Observe
    function setupObserver() {
        const obs = new MutationObserver((muts) => {
            let needs = false;
            for (const m of muts) {
                if (m.type === "childList") {
                    for (const n of m.addedNodes) {
                        if (n.nodeType !== 1) continue;
                        if (n.getAttribute && n.getAttribute("data-color-mix-polyfill") != null) continue;
                        if (
                            n.tagName === "STYLE" ||
                            (n.tagName === "LINK" && n.rel === "stylesheet")
                        )
                            needs = true;
                        else if (
                            n.querySelector &&
                            n.querySelector(
                                'style, link[rel="stylesheet"], [style*="color-mix("]'
                            )
                        )
                            needs = true;
                    }
                } else if (m.type === "attributes") {
                    const t = m.target;
                    if (
                        (t.tagName === "LINK" &&
                            t.rel === "stylesheet" &&
                            (m.attributeName === "href" ||
                                m.attributeName === "rel")) ||
                        (m.attributeName === "style" &&
                            /color-mix\(/i.test(t.getAttribute("style") || ""))
                    )
                        needs = true;
                }
            }
            if (needs) {
                clearTimeout(window.__cmDebounce);
                window.__cmDebounce = setTimeout(processAllStyleSheets, 100);
            }
        });
        obs.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["href", "rel", "style"],
        });
        return obs;
    }

    dbg("color-mix fallback enabled");
    processAllStyleSheets();
    setupObserver();
    if (window.__pfOnCssLayersUpdate) window.__pfOnCssLayersUpdate(processAllStyleSheets);
    if (window.__pfRegisterShadowTransform) {
        window.__pfRegisterShadowTransform(function (css) {
            if (!css || !/color-mix\(/i.test(css)) return css;
            return replaceColorMixInText(css);
        });
    }
})();
