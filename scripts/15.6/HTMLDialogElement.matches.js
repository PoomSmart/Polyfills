(function () {
    if (!Element.prototype._originalMatches) {
        Element.prototype._originalMatches = HTMLDialogElement.prototype.matches;
        Element.prototype.matches = function (selector) {
            const modifiedSelector = selector.replace(/:modal/g, '.modal');
            return Element.prototype._originalMatches.call(this, modifiedSelector);
        };
    }
})();
