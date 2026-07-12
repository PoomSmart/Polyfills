// https://github.com/chase-moskal/webp-hero
(function () {
    if (typeof window === "undefined" || !window.webpHero || !window.webpHero.WebpMachine) {
        return;
    }

    var machine = new window.webpHero.WebpMachine();

    function run() {
        machine.polyfillDocument();
    }

    if (document.body) {
        run();
    } else {
        document.addEventListener("DOMContentLoaded", run);
    }
})();
