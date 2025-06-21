// https://github.com/microsoft/pxt/blob/master/webapp/src/polyfills.ts
if (!Element.prototype.checkVisibility) {
    Element.prototype.checkVisibility = function checkVisibility(options = {}) {
        let checkOpacity = true;

        if (options.opacityProperty != undefined || options.checkOpacity != undefined) {
            checkOpacity = !!(options.opacityProperty || options.checkOpacity);
        }

        let checkVisibility = true;

        if (options.visibilityProperty != undefined || options.checkVisibilityCSS != undefined) {
            checkVisibility = !!(options.visibilityProperty || options.checkVisibilityCSS);
        }

        let checkContentVisibility = true;

        if (options.contentVisibilityAuto != undefined) {
            checkContentVisibility = !!options.contentVisibilityAuto;
        }

        const computedStyle = getComputedStyle(this);

        if (
            computedStyle.display === "none" ||
            (checkOpacity && computedStyle.opacity === "0") ||
            (checkVisibility && computedStyle.visibility === "hidden") ||
            (checkContentVisibility && computedStyle.contentVisibility === "hidden")
        ) {
            return false;
        }

        try {
            const rec = this.getBoundingClientRect();
            if (rec.width === 0 || rec.height === 0) {
                return false;
            }
        }
        catch {
            // some versions of firefox throw if an element is not in the DOM
            // and getBoundingClientRect is called
            return false;
        }

        return true;
    }
}
