(function (w) {
  function getProto() {
    if (w.MediaQueryList) {
      return w.MediaQueryList.prototype;
    }
    if (typeof w.matchMedia === "function") {
      const mql = w.matchMedia("all");
      return Object.getPrototypeOf(mql);
    }
  }
  const proto = getProto();

  if (!proto) return;

  const wrappers = new WeakMap();

  proto.addEventListener =
    proto.addEventListener ||
    function (type, listener) {
      if (type !== "change") return;

      if (typeof listener === "function") {
        proto.addListener.call(this, listener);
      } else {
        let wrapper = wrappers.get(listener);
        if (!wrapper) {
          wrapper = (ev) => listener.handleEvent(ev);
          wrappers.set(listener, wrapper);
        }
        proto.addListener.call(this, wrapper);
      }
    };

  proto.removeEventListener =
    proto.removeEventListener ||
    function (type, listener) {
      if (type !== "change") return;
      if (typeof listener === "function") {
        proto.removeListener.call(this, listener);
      } else {
        const wrapper = wrappers.get(listener);
        if (!wrapper) {
          return;
        }
        proto.removeListener.call(this, wrapper);
      }
    };
})(window);
