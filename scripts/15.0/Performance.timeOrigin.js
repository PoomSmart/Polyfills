if (window.performance && !('timeOrigin' in window.performance)) {
    Object.defineProperty(window.performance, 'timeOrigin', {
        get: function () {
            // Prioritize navigation start if available
            if (window.performance.timing && window.performance.timing.navigationStart) {
                return window.performance.timing.navigationStart;
            }
            // Fallback for environment start
            return Date.now() - (window.performance.now ? window.performance.now() : 0);
        },
        enumerable: true,
        configurable: true
    });
}