if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, 'flatMap', {
    value: function(callback, thisArg) {
      var self = thisArg || this;
      if (self === null) throw new TypeError('Array.prototype.flatMap called on null or undefined');
      if (typeof callback !== 'function') throw new TypeError(callback + ' is not a function');
      var list = [];
      var o = Object(self);
      var len = o.length >>> 0;
      for (var k = 0; k < len; ++k) {
        if (k in o) {
          var part_list = callback.call(self, o[k], k, o);
          list = list.concat(part_list);
        }
      }
      return list;
    },
    configurable: true,
    writable: true
  });
}
