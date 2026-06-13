// Modified version via Claude
/**
 @class BroadcastChannel
 A simple BroadcastChannel polyfill that works with all major browsers.
 Please refer to the official MDN documentation of the Broadcast Channel API.
 @see <a href="https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API">Broadcast Channel API on MDN</a>
 @author Alessandro Piana
 @version 0.0.6-fixed
 */

/*
  MIT License
  Copyright (c) 2021 Alessandro Piana
  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:
  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
*/

(function (context) {
    // Internal variables
    let _channels = null; // List of channels
    let _tabId = null; // Current window browser tab identifier (see IE problem, later)
    let _storageListener = null; // Store reference to the storage listener
    let _cleanupTimer = null; // Shared cleanup timer for localStorage keys
    let _pendingCleanupKeys = []; // Keys awaiting cleanup
    const _prefix = "polyBC_"; // prefix to identify localStorage keys.

    const scheduleStorageCleanup = (key) => {
        _pendingCleanupKeys.push(key);
        if (_cleanupTimer !== null) {
            return;
        }

        _cleanupTimer = setTimeout(() => {
            const keys = _pendingCleanupKeys;
            _pendingCleanupKeys = [];
            _cleanupTimer = null;

            for (let i = 0; i < keys.length; i++) {
                try {
                    context.localStorage.removeItem(keys[i]);
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }, 50);
    };

    /**
     * Utils
     * @private
     */
    const getRandomString = (len = 5) => {
        let text = "";
        const possible =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < len; i++) {
            text += possible.charAt(
                Math.floor(Math.random() * possible.length)
            );
        }
        return text;
    };

    const isEmpty = (obj) => !Object.keys(obj).length;

    const getTimestamp = () => new Date().getTime();

    /**
     * Build a "similar" response as done in the real BroadcastChannel API
     */
    const buildResponse = (data) => {
        return {
            timestamp: getTimestamp(),
            isTrusted: true,
            target: null, // Since we are using JSON stringify, we cannot pass references.
            currentTarget: null,
            data,
            bubbles: false,
            cancelable: false,
            defaultPrevented: false,
            lastEventId: "",
            origin: context.location.origin,
        };
    };

    /**
     * Handler of the 'storage' function.
     * Called when another window has sent a message.
     * @param {Object} ev - the message.
     * @private
     */
    const _onmsg = (ev) => {
        const key = ev.key;
        const newValue = ev.newValue;
        const isRemoved = !newValue;
        let obj = null;

        // Actually checks if the messages if from us.
        if (key.indexOf(`${_prefix}message_`) > -1 && !isRemoved) {
            try {
                obj = JSON.parse(newValue);
                // Validate parsed object structure
                if (
                    !obj ||
                    typeof obj !== "object" ||
                    !obj.channelId ||
                    !obj.message
                ) {
                    return;
                }
            } catch (ex) {
                // Handle JSON parsing errors by dispatching messageerror events
                if (_channels) {
                    Object.values(_channels).forEach((subscribers) => {
                        subscribers.forEach((sub) => {
                            if (!sub.closed) {
                                const errorEvent = new MessageEvent(
                                    "messageerror",
                                    {
                                        data: null,
                                        origin: context.location.origin,
                                        lastEventId: "",
                                        source: null,
                                        ports: [],
                                    }
                                );
                                sub.dispatchEvent(errorEvent);
                                // Also call onmessageerror if set
                                if (typeof sub.onmessageerror === "function") {
                                    sub.onmessageerror(errorEvent);
                                }
                            }
                        });
                    });
                }
                return;
            }

            // NOTE: Check on tab is done to prevent IE error
            // (localStorage event is called even in the same tab :( )
            if (
                obj.tabId !== _tabId &&
                obj.channelId &&
                _channels &&
                _channels[obj.channelId]
            ) {
                const subscribers = _channels[obj.channelId];
                for (let i = 0; i < subscribers.length; i++) {
                    const sub = subscribers[i];
                    if (!sub.closed) {
                        // Create proper MessageEvent with data property
                        const event = new MessageEvent("message", {
                            data: obj.message.data,
                            origin:
                                obj.message.origin || context.location.origin,
                            lastEventId: obj.message.lastEventId || "",
                            source: null,
                            ports: [],
                        });
                        sub.dispatchEvent(event);
                        // Also call onmessage if set
                        if (typeof sub.onmessage === "function") {
                            sub.onmessage(event);
                        }
                    }
                }
                // Remove the item for safety.
                context.localStorage.removeItem(key);
            }
        }
    };

    /**
     * Creates a new BroadcastChannel
     * @param {String} channelName - the channel name.
     * return {BroadcastChannel}
     */
    class _BroadcastChannel extends EventTarget {
        channelId = "";
        channelName = "";
        closed = false;
        _onmessage = null;
        _onmessageerror = null;
        _instanceId = "";

        constructor(channelName = "") {
            super();

            // Validate channel name
            if (typeof channelName !== "string") {
                throw new TypeError("Channel name must be a string");
            }

            this.channelName = channelName;

            // Check if localStorage is available.
            if (!context.localStorage) {
                throw new Error("localStorage not available");
            }

            // Add custom prefix to Channel Name.
            const _channelId = _prefix + channelName;
            const isFirstChannel = _channels === null;

            this.channelId = _channelId;

            _tabId = _tabId || getRandomString(); // Creates a new tab identifier, if necessary.
            _channels = _channels || {}; // Initializes channels, if necessary.
            _channels[_channelId] = _channels[_channelId] || [];

            // Adds the current Broadcast Channel.
            _channels[_channelId].push(this);

            // Creates a sufficiently random instance identifier for the current instance of BC.
            this._instanceId =
                _channelId + "::::" + getRandomString() + getTimestamp();

            // If it is the first instance of Channel created, also creates the storage listener.
            if (isFirstChannel) {
                _storageListener = _onmsg;
                context.addEventListener("storage", _storageListener, false);
            }
        }

        /**
         * Gets the name of the broadcast channel
         */
        get name() {
            return this.channelName;
        }

        /**
         * Gets the onmessage event handler
         */
        get onmessage() {
            return this._onmessage;
        }

        /**
         * Sets the onmessage event handler
         */
        set onmessage(handler) {
            this._onmessage = handler;
        }

        /**
         * Gets the onmessageerror event handler
         */
        get onmessageerror() {
            return this._onmessageerror;
        }

        /**
         * Sets the onmessageerror event handler
         */
        set onmessageerror(handler) {
            this._onmessageerror = handler;
        }

        /**
         * Sends the message to different channels.
         * @param {*} data - the data to be sent ( actually, it can be any JS type ).
         */
        postMessage(data) {
            if (!_channels) return;

            if (this.closed) {
                throw new DOMException(
                    "This BroadcastChannel is closed.",
                    "InvalidStateError"
                );
            }

            // Build the event-like response.
            const msgObj = buildResponse(data);

            // SAME-TAB communication.
            const subscribers = _channels[this.channelId] || [];
            for (let i = 0; i < subscribers.length; i++) {
                const sub = subscribers[i];
                // We don't send the message to ourselves.
                if (sub.closed || sub._instanceId === this._instanceId) continue;
                // Create proper MessageEvent with data property
                const event = new MessageEvent("message", {
                    data: msgObj.data,
                    origin: msgObj.origin || context.location.origin,
                    lastEventId: msgObj.lastEventId || "",
                    source: null,
                    ports: [],
                });
                sub.dispatchEvent(event);
                // Also call onmessage if set
                if (typeof sub.onmessage === "function") {
                    sub.onmessage(event);
                }
            }

            // CROSS-TAB communication.
            // Adds some properties to communicate among the tabs.
            const editedObj = {
                channelId: this.channelId,
                bcId: this._instanceId,
                tabId: _tabId,
                message: msgObj,
            };

            try {
                const editedJSON = JSON.stringify(editedObj);
                const lsKey = `${_prefix}message_${getRandomString()}_${
                    this.channelId
                }`;
                // Set localStorage item (and, after that, removes it).
                context.localStorage.setItem(lsKey, editedJSON);
                // Batch key cleanup to avoid creating one timer per message.
                scheduleStorageCleanup(lsKey);
            } catch (ex) {
                // Handle localStorage quota exceeded or other storage errors
                const errorEvent = new MessageEvent("messageerror", {
                    data: null,
                    origin: context.location.origin,
                    lastEventId: "",
                    source: null,
                    ports: [],
                });
                this.dispatchEvent(errorEvent);
                if (typeof this.onmessageerror === "function") {
                    this.onmessageerror(errorEvent);
                }
            }
        }

        /**
         * Closes a Broadcast channel.
         */
        close() {
            if (this.closed) return; // Already closed

            this.closed = true;
            const subscribers = _channels[this.channelId];

            if (subscribers) {
                const index = subscribers.indexOf(this);
                if (index > -1) {
                    subscribers.splice(index, 1);
                }
                // If we have no channels, remove the listener.
                if (!subscribers.length) {
                    delete _channels[this.channelId];
                }
            }

            if (isEmpty(_channels) && _storageListener) {
                context.removeEventListener("storage", _storageListener);
                _storageListener = null;
                if (_cleanupTimer !== null) {
                    clearTimeout(_cleanupTimer);
                    _cleanupTimer = null;
                }
                _pendingCleanupKeys = [];
            }
        }
    }

    // Sets BroadcastChannel, if not available.
    context.BroadcastChannel = context.BroadcastChannel || _BroadcastChannel;
})(self);
