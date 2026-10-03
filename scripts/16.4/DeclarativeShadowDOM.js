// <template shadowrootmode> becomes a real shadow root. iOS before 16.4.
(function () {
    if (!window.Element || !Element.prototype.attachShadow || !window.HTMLTemplateElement) return;
    if ('shadowRootMode' in HTMLTemplateElement.prototype) return;
    if (window.__pfDeclarativeShadow) return;
    window.__pfDeclarativeShadow = true;

    var origAttach = Element.prototype.attachShadow;
    var shadowDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot');
    if (!shadowDesc || typeof shadowDesc.get !== 'function') return;

    var closedRoots = typeof WeakMap === 'function' ? new WeakMap() : null;
    var declarative = typeof WeakSet === 'function' ? new WeakSet() : null;
    var anyDSD = false;

    function isDSD(node) {
        return node && node.localName === 'template' &&
            (node.hasAttribute('shadowrootmode') || node.hasAttribute('shadowroot'));
    }

    function findTemplate(host) {
        var child;
        if (!anyDSD || !host) return null;
        for (child = host.firstElementChild; child; child = child.nextElementSibling) {
            if (isDSD(child)) return child;
        }
        return null;
    }

    function processTree(node) {
        var list, i;
        if (!node || !node.querySelectorAll) return;
        list = node.querySelectorAll('template[shadowrootmode],template[shadowroot]');
        if (list.length) anyDSD = true;
        for (i = 0; i < list.length; i++) {
            if (list[i].isConnected || list[i].parentNode) attachFrom(list[i]);
        }
    }

    function attachFrom(template) {
        var host = template.parentNode;
        var mode, root;
        if (!host || host.nodeType !== 1) return null;
        if (shadowDesc.get.call(host) || (closedRoots && closedRoots.has(host))) {
            template.parentNode && template.parentNode.removeChild(template);
            return null;
        }
        mode = (template.getAttribute('shadowrootmode') || template.getAttribute('shadowroot') || 'open').toLowerCase();
        try {
            root = origAttach.call(host, {
                mode: mode === 'closed' ? 'closed' : 'open',
                delegatesFocus: template.hasAttribute('shadowrootdelegatesfocus') || template.hasAttribute('shadowrootdelegatefocus')
            });
        } catch (e) {
            return null;
        }
        if (template.content) root.appendChild(template.content);
        if (template.parentNode) template.parentNode.removeChild(template);
        if (declarative) declarative.add(root);
        if (mode === 'closed' && closedRoots) closedRoots.set(host, root);
        processTree(root);
        if (window.__pfOnShadowRoot) {
            try { window.__pfOnShadowRoot(root); } catch (e2) {}
        }
        return root;
    }

    Object.defineProperty(Element.prototype, 'shadowRoot', {
        configurable: true,
        enumerable: shadowDesc.enumerable,
        get: function () {
            var root = shadowDesc.get.call(this);
            var template;
            if (root) return root;
            template = findTemplate(this);
            if (!template) return null;
            root = attachFrom(template);
            if (root && root.mode === 'open') return root;
            return null;
        }
    });

    Element.prototype.attachShadow = function (init) {
        var existing = shadowDesc.get.call(this) || (closedRoots && closedRoots.get(this));
        var template;
        if (!existing) {
            template = findTemplate(this);
            if (template) existing = attachFrom(template);
        }
        if (existing && declarative && declarative.has(existing)) {
            while (existing.firstChild) existing.removeChild(existing.firstChild);
            declarative.delete(existing);
            return existing;
        }
        return origAttach.call(this, init);
    };

    function hookInnerHTML(proto) {
        var desc = proto && Object.getOwnPropertyDescriptor(proto, 'innerHTML');
        var orig, wrapped;
        if (!desc || typeof desc.set !== 'function' || desc.set.__pfDSD) return;
        orig = desc.set;
        wrapped = function (markup) {
            orig.call(this, markup);
            processTree(this.content || this);
        };
        wrapped.__pfDSD = true;
        Object.defineProperty(proto, 'innerHTML', {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set: wrapped
        });
    }

    function setHTML(target, markup) {
        target.innerHTML = markup;
        processTree(target.content || target);
    }

    hookInnerHTML(Element.prototype);
    if (window.ShadowRoot) hookInnerHTML(ShadowRoot.prototype);

    if (!Element.prototype.setHTMLUnsafe) {
        Element.prototype.setHTMLUnsafe = function (markup) { setHTML(this, markup); };
        if (window.ShadowRoot) ShadowRoot.prototype.setHTMLUnsafe = function (markup) { setHTML(this, markup); };
    }

    if (!Document.parseHTMLUnsafe && window.DOMParser) {
        Document.parseHTMLUnsafe = function (markup) {
            var doc = new DOMParser().parseFromString(markup, 'text/html');
            processTree(doc);
            return doc;
        };
    }

    Object.defineProperty(HTMLTemplateElement.prototype, 'shadowRootMode', {
        configurable: true,
        get: function () { return this.getAttribute('shadowrootmode') || ''; },
        set: function (value) { this.setAttribute('shadowrootmode', value); }
    });

    if (window.MutationObserver) {
        new MutationObserver(function (mutations) {
            var i, j, added, node;
            if (document.readyState === 'loading') {
                if (!anyDSD) {
                    for (i = 0; i < mutations.length && !anyDSD; i++) {
                        added = mutations[i].addedNodes;
                        for (j = 0; j < added.length; j++) {
                            if (isDSD(added[j])) { anyDSD = true; break; }
                        }
                    }
                }
                return;
            }
            for (i = 0; i < mutations.length; i++) {
                added = mutations[i].addedNodes;
                for (j = 0; j < added.length; j++) {
                    node = added[j];
                    if (!node || node.nodeType !== 1) continue;
                    if (isDSD(node)) {
                        anyDSD = true;
                        attachFrom(node);
                    } else {
                        processTree(node);
                    }
                }
            }
        }).observe(document.documentElement || document, { childList: true, subtree: true });
    }

    function start() { processTree(document); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, true);
    else start();
})();
