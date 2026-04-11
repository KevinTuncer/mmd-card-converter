// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";

// Import the polyfill to install globals
import "@/cli/browser-polyfill";

describe("Browser polyfill globals", () => {
  it("provides OffscreenCanvas", () => {
    expect(typeof globalThis.OffscreenCanvas).toBe("function");
    const canvas = new OffscreenCanvas(100, 200);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(200);
  });

  it("OffscreenCanvas.getContext('2d') returns a context", () => {
    const canvas = new OffscreenCanvas(100, 100);
    const ctx = canvas.getContext("2d");
    expect(ctx).not.toBeNull();
  });

  it("OffscreenCanvas.getContext returns null for unsupported context types", () => {
    const canvas = new OffscreenCanvas(100, 100);
    const ctx = canvas.getContext("webgl");
    expect(ctx).toBeNull();
  });

  it("OffscreenCanvas.convertToBlob produces a PNG blob", async () => {
    const canvas = new OffscreenCanvas(10, 10);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe("image/png");
  });

  it("provides createImageBitmap", () => {
    expect(typeof globalThis.createImageBitmap).toBe("function");
  });

  it("createImageBitmap loads from a Blob", async () => {
    // Create a minimal 1x1 PNG blob
    const pngBytes = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const blob = new Blob([pngBytes], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    expect(bitmap.width).toBeGreaterThan(0);
    expect(bitmap.height).toBeGreaterThan(0);
    expect(typeof bitmap.close).toBe("function");
  });

  it("provides ImageData", () => {
    expect(typeof globalThis.ImageData).toBe("function");
    const data = new ImageData(10, 20);
    expect(data.width).toBe(10);
    expect(data.height).toBe(20);
    expect(data.data.length).toBe(10 * 20 * 4);
  });

  it("ImageData can be constructed with existing data", () => {
    const arr = new Uint8ClampedArray(4 * 4 * 4); // 4x4 RGBA
    const data = new ImageData(arr, 4);
    expect(data.width).toBe(4);
    expect(data.height).toBe(4);
  });

  it("provides document mock", () => {
    expect(globalThis.document).toBeDefined();
    expect(typeof globalThis.document.createElement).toBe("function");
  });

  it("document.createElement('canvas') returns a canvas element", () => {
    const canvas = globalThis.document.createElement("canvas");
    expect(canvas).toBeDefined();
    expect(typeof canvas.getContext).toBe("function");
  });

  it("document.addEventListener/removeEventListener/dispatchEvent are no-ops", () => {
    expect(() => {
      globalThis.document.addEventListener("test", () => {});
      globalThis.document.removeEventListener("test", () => {});
      globalThis.document.dispatchEvent(new Event("test"));
    }).not.toThrow();
  });

  it("provides navigator mock", () => {
    expect(globalThis.navigator).toBeDefined();
    // navigator may be set by the polyfill (en) or by the runtime (system locale)
    expect(globalThis.navigator.languages.length).toBeGreaterThan(0);
    expect(typeof globalThis.navigator.language).toBe("string");
  });

  it("provides localStorage mock", () => {
    expect(globalThis.localStorage).toBeDefined();
    globalThis.localStorage.setItem("test-key", "test-value");
    expect(globalThis.localStorage.getItem("test-key")).toBe("test-value");
    globalThis.localStorage.removeItem("test-key");
    expect(globalThis.localStorage.getItem("test-key")).toBeNull();
  });

  it("provides FileReader polyfill", () => {
    expect(typeof globalThis.FileReader).toBe("function");
  });

  it("FileReader.readAsArrayBuffer reads blob data", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const blob = new Blob([data]);

    const result = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        resolve(e.target!.result as ArrayBuffer);
      };
      reader.onerror = () => reject(new Error("read error"));
      reader.readAsArrayBuffer(blob);
    });

    expect(new Uint8Array(result)).toEqual(data);
  });

  it("FileReader.readAsText reads blob as text", async () => {
    const text = "Hello, World!";
    const blob = new Blob([text]);

    const result = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        resolve(e.target!.result as string);
      };
      reader.onerror = () => reject(new Error("read error"));
      reader.readAsText(blob);
    });

    expect(result).toBe(text);
  });

  it("provides XMLHttpRequest polyfill", () => {
    expect(typeof globalThis.XMLHttpRequest).toBe("function");
  });

  it("provides window and location polyfills", () => {
    expect(globalThis.window).toBeDefined();
    expect(globalThis.location).toBeDefined();
    expect((globalThis.location as Location).href).toBe("http://localhost/");
  });
});

describe("PatchedCanvasContext", () => {
  it("supports drawImage with ImageBitmapWrapper source", async () => {
    const canvas = new OffscreenCanvas(100, 100);
    const ctx = canvas.getContext("2d")!;

    // Create a small image bitmap
    const pngBytes = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const blob = new Blob([pngBytes], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);

    // Should not throw
    expect(() => ctx.drawImage(bitmap, 0, 0)).not.toThrow();
  });

  it("supports getImageData and putImageData", () => {
    const canvas = new OffscreenCanvas(10, 10);
    const ctx = canvas.getContext("2d")!;

    const imageData = ctx.getImageData(0, 0, 10, 10);
    expect(imageData.width).toBe(10);
    expect(imageData.height).toBe(10);
    expect(imageData.data.length).toBe(400);

    expect(() => ctx.putImageData(imageData, 0, 0)).not.toThrow();
  });

  it("supports basic drawing operations", () => {
    const canvas = new OffscreenCanvas(100, 100);
    const ctx = canvas.getContext("2d")!;

    expect(() => {
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 50, 50);
      ctx.clearRect(0, 0, 25, 25);
    }).not.toThrow();
  });
});
