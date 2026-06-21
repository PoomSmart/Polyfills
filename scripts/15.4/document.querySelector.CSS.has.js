(function() {
  // Check if browser already supports :has() natively
  try {
    document.querySelector('html:has(body)');
    return; // Native support exists, skip polyfill
  } catch (e) {}

  // Keep Document and Element originals separated
  const origDocQS = Document.prototype.querySelector;
  const origDocQSA = Document.prototype.querySelectorAll;
  const origElQS = Element.prototype.querySelector;
  const origElQSA = Element.prototype.querySelectorAll;

  const hasRegex = /^(.*?):has\((.*?)\)(.*)$/;

  function parseAndFind(selector, context, originalQS, originalQSA) {
    const match = selector.match(hasRegex);
    if (!match) {
      return null; // Not matching :has(), let caller fall back to native
    }

    const [, baseSelector, subSelector, restSelector] = match;
    
    // Find base elements using the appropriate context context (Document or Element)
    const bases = Array.from(originalQSA.call(context, baseSelector || '*'));
    
    // Filter bases containing the subSelector (always query within base element using Element.prototype)
    const matchingBases = bases.filter(base => {
      return origElQS.call(base, subSelector) !== null;
    });

    if (restSelector && restSelector.trim() !== '') {
      const results = [];
      for (const base of matchingBases) {
        // Query descendants using Element.prototype
        const subResults = Array.from(origElQSA.call(base, restSelector));
        results.push(...subResults);
      }
      return results;
    }

    return matchingBases;
  }

  // --- Document Polyfills ---
  Document.prototype.querySelector = function(selector) {
    if (typeof selector === 'string') {
      const results = parseAndFind(selector, this, origDocQS, origDocQSA);
      if (results) return results[0] || null;
    }
    return origDocQS.call(this, selector);
  };

  Document.prototype.querySelectorAll = function(selector) {
    if (typeof selector === 'string') {
      const results = parseAndFind(selector, this, origDocQS, origDocQSA);
      if (results) {
        results.item = function(index) { return this[index] || null; };
        return results;
      }
    }
    return origDocQSA.call(this, selector);
  };

  // --- Element Polyfills ---
  Element.prototype.querySelector = function(selector) {
    if (typeof selector === 'string') {
      const results = parseAndFind(selector, this, origElQS, origElQSA);
      if (results) return results[0] || null;
    }
    return origElQS.call(this, selector);
  };

  Element.prototype.querySelectorAll = function(selector) {
    if (typeof selector === 'string') {
      const results = parseAndFind(selector, this, origElQS, origElQSA);
      if (results) {
        results.item = function(index) { return this[index] || null; };
        return results;
      }
    }
    return origElQSA.call(this, selector);
  };
})();
