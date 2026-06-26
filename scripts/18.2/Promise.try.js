if (!("try" in Promise)) {
    Object.defineProperty(Promise, 'try', {
        value: function (callback) {
            const PromiseConstructor = this;
            const args = Array.prototype.slice.call(arguments, 1);

            return new PromiseConstructor(function (resolve, reject) {
                try {
                    resolve(callback.apply(undefined, args));
                } catch (error) {
                    reject(error);
                }
            });
        },
        writable: true,
        configurable: true
    });
}
