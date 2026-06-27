function defineSetMethod(name, fn) {
    if (!Set.prototype[name]) {
        Object.defineProperty(Set.prototype, name, {
            value: fn,
            writable: true,
            configurable: true
        });
    }
}

defineSetMethod('union', function (other) {
    const result = new Set(this);
    const keys = other.keys();
    let next;

    while (!(next = keys.next()).done) {
        result.add(next.value);
    }

    return result;
});

defineSetMethod('intersection', function (other) {
    const result = new Set();

    this.forEach(function (value) {
        if (other.has(value)) result.add(value);
    });

    return result;
});

defineSetMethod('difference', function (other) {
    const result = new Set();

    this.forEach(function (value) {
        if (!other.has(value)) result.add(value);
    });

    return result;
});

defineSetMethod('symmetricDifference', function (other) {
    const result = new Set(this);
    const keys = other.keys();
    let next;

    while (!(next = keys.next()).done) {
        if (result.has(next.value)) {
            result.delete(next.value);
        } else {
            result.add(next.value);
        }
    }

    return result;
});

defineSetMethod('isSubsetOf', function (other) {
    let result = true;

    if (this.size > other.size) return false;

    this.forEach(function (value) {
        if (!other.has(value)) result = false;
    });

    return result;
});

defineSetMethod('isSupersetOf', function (other) {
    const keys = other.keys();
    let next;

    if (this.size < other.size) return false;

    while (!(next = keys.next()).done) {
        if (!this.has(next.value)) return false;
    }

    return true;
});

defineSetMethod('isDisjointFrom', function (other) {
    let result = true;

    this.forEach(function (value) {
        if (other.has(value)) result = false;
    });

    return result;
});
