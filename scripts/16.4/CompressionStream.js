(function () {
    const globals =
        typeof globalThis == "undefined"
            ? typeof self == "undefined"
                ? typeof global == "undefined"
                    ? {}
                    : global
                : self
            : globalThis;

    function toUint8Array(chunk) {
        if (chunk instanceof Uint8Array) {
            return chunk;
        }
        if (chunk instanceof ArrayBuffer) {
            return new Uint8Array(chunk);
        }
        if (
            chunk &&
            typeof chunk === "object" &&
            chunk.buffer instanceof ArrayBuffer
        ) {
            // Handle DataView and all typed arrays (including Float16Array if supported)
            return new Uint8Array(
                chunk.buffer,
                chunk.byteOffset || 0,
                chunk.byteLength
            );
        }
        // Fallback: try to convert to Uint8Array
        try {
            return new Uint8Array(chunk);
        } catch (e) {
            throw new TypeError("Cannot convert chunk to Uint8Array");
        }
    }

    if (typeof CompressionStream === "undefined") {
        globals.CompressionStream = class CompressionStream {
            constructor(format) {
                if (!["gzip", "deflate", "deflate-raw"].includes(format)) {
                    throw new TypeError(
                        "Supported formats: gzip, deflate, deflate-raw"
                    );
                }

                // Configure pako options based on format
                let pakoOptions = {};
                if (format === "gzip") {
                    pakoOptions.gzip = true;
                } else if (format === "deflate-raw") {
                    pakoOptions.raw = true;
                }
                // deflate uses default options (no gzip, no raw)

                let encoder = new pako2.Deflate(pakoOptions);
                let done = false;

                const transform = new TransformStream({
                    transform(chunk, controller) {
                        if (done) return;
                        const input = toUint8Array(chunk);
                        encoder.push(input, false);
                        if (encoder.err)
                            throw new Error(
                                "Compression error: " + encoder.msg
                            );
                        if (encoder.result) {
                            controller.enqueue(new Uint8Array(encoder.result));
                            encoder.result = null;
                        }
                    },
                    flush(controller) {
                        done = true;
                        encoder.push(new Uint8Array(0), true);
                        if (encoder.err)
                            throw new Error(
                                "Compression error: " + encoder.msg
                            );
                        if (encoder.result) {
                            controller.enqueue(new Uint8Array(encoder.result));
                        }
                    },
                });

                this.readable = transform.readable;
                this.writable = transform.writable;
            }
        };
    }

    if (typeof DecompressionStream === "undefined") {
        globals.DecompressionStream = class DecompressionStream {
            constructor(format) {
                if (!["gzip", "deflate", "deflate-raw"].includes(format)) {
                    throw new TypeError(
                        "Supported formats: gzip, deflate, deflate-raw"
                    );
                }

                // Configure pako options based on format
                let pakoOptions = {};
                if (format === "deflate-raw") {
                    pakoOptions.raw = true;
                }
                // gzip and deflate use default options

                let inflator = new pako2.Inflate(pakoOptions);
                let done = false;

                const transform = new TransformStream({
                    transform(chunk, controller) {
                        if (done) return;
                        const input = toUint8Array(chunk);
                        inflator.push(input, false);
                        if (inflator.err)
                            throw new Error(
                                "Decompression error: " + inflator.msg
                            );
                        if (inflator.result) {
                            controller.enqueue(new Uint8Array(inflator.result));
                            inflator.result = null;
                        }
                    },
                    flush(controller) {
                        done = true;
                        inflator.push(new Uint8Array(0), true);
                        if (inflator.err)
                            throw new Error(
                                "Decompression error: " + inflator.msg
                            );
                        if (inflator.result) {
                            controller.enqueue(new Uint8Array(inflator.result));
                        }
                    },
                });

                this.readable = transform.readable;
                this.writable = transform.writable;
            }
        };
    }
})();
