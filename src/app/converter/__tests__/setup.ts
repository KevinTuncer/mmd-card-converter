import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Global test setup for jsdom environments.
 *
 * jsdom v26 does not implement Blob.prototype.arrayBuffer(), but babylon-mmd's
 * MmdAsyncTextureLoader calls it when loading texture files from referenceFiles.
 * Polyfill it using FileReader which jsdom DOES implement.
 */
if (typeof Blob !== "undefined" && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (): void => resolve(reader.result as ArrayBuffer);
      reader.onerror = (): void => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

if (typeof fetch === "function") {
  const nativeFetch = fetch.bind(globalThis);
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url;

    if (url.startsWith("file://")) {
      const file = await fs.readFile(fileURLToPath(url));
      return new Response(file, {
        headers: {
          "Content-Type": url.endsWith(".wasm")
            ? "application/wasm"
            : "application/octet-stream",
        },
      });
    }

    return nativeFetch(input, init);
  };
}
