// https://gist.github.com/samthor/3ff82bd5b11314fec2e1826d4a96ce7c
(function () {
  function importScript(path) {
    const key = path;
    let entry = importScript.__db[key];
    if (!entry) {
      entry = importScript.__db[key] = {};
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        const script = document.createElement('script');
        script.type = 'module';
        const quoted = JSON.stringify(path); // safely escapes quotes
        script.textContent = `
          import * as m from ${quoted};
          window.importScript.__db[${quoted}].resolve(m);
        `;
        script.onerror = reject;
        document.head.appendChild(script);
        // Delay removal to ensure error can be caught
        setTimeout(() => script.remove(), 0);
      });
    }
    return entry.promise;
  }

  importScript.__db = {};
  window.importScript = importScript;

  // Optional: replace native import() if not supported
  if (typeof window.import === 'undefined') {
    window.import = importScript;
  }
})();
