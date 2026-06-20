if (!("nonce" in HTMLElement.prototype)) {
    Object.defineProperty(
        HTMLElement.prototype,
        "nonce",
        {
            get() {
                return this.getAttribute("nonce") || "";
            },
            set(v) {
                this.setAttribute("nonce", v);
            }
        }
    );
}

(function() {
    const origAppend = Element.prototype.appendChild;

    Element.prototype.appendChild = function(node) {

        if (node && node.tagName === "SCRIPT") {
            const pageNonce =
                document.querySelector("script[nonce]")?.nonce ||
                document.querySelector("script[nonce]")?.getAttribute("nonce");

            if (!node.nonce && pageNonce) {
                node.nonce = pageNonce;
                node.setAttribute("nonce", pageNonce);
            }
        }

        return origAppend.call(this, node);
    };
})();