/**
 * Browser API polyfills for running converters in Bun CLI.
 *
 * Installs global mocks for browser-only APIs that the converter modules
 * depend on (OffscreenCanvas, createImageBitmap, document, ImageData).
 *
 * Powered by @napi-rs/canvas for actual Canvas rendering.
 */

import {
  type Canvas,
  type Image,
  ImageData as CanvasImageData,
  type SKRSContext2D,
  createCanvas,
  loadImage,
} from "@napi-rs/canvas";

// ── ImageData polyfill ───────────────────────────────────────────────────────

if (typeof globalThis.ImageData === "undefined") {
  // @napi-rs/canvas ships a native ImageData implementation
  globalThis.ImageData =
    CanvasImageData as unknown as typeof globalThis.ImageData;
}

// ── Bitmap-like wrapper (simulates ImageBitmap) ──────────────────────────────

interface CanvasImage {
  width: number;
  height: number;
}

class ImageBitmapWrapper {
  readonly width: number;
  readonly height: number;
  private _source: CanvasImage;

  constructor(source: CanvasImage) {
    this.width = source.width;
    this.height = source.height;
    this._source = source;
  }

  /** Internal: returns the underlying image for canvas drawing. */
  get _imageSource(): CanvasImage {
    return this._source;
  }

  close(): void {
    // No-op; @napi-rs/canvas images don't need explicit disposal
  }
}

// ── createImageBitmap polyfill ───────────────────────────────────────────────

async function createImageBitmapPolyfill(
  source: Blob | File | ArrayBuffer | Uint8Array,
): Promise<ImageBitmapWrapper> {
  let buffer: ArrayBuffer;

  if (source instanceof Blob) {
    buffer = await source.arrayBuffer();
  } else if (source instanceof ArrayBuffer) {
    buffer = source;
  } else {
    buffer = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ) as ArrayBuffer;
  }

  const image = await loadImage(Buffer.from(buffer));
  return new ImageBitmapWrapper(image);
}

// ── document polyfill (minimal) ──────────────────────────────────────────────

function createDocumentPolyfill() {
  return {
    createElement(tagName: string) {
      if (tagName.toLowerCase() === "canvas") {
        const native = createCanvas(300, 150);
        return {
          getContext(contextId: string) {
            if (contextId !== "2d") return null;
            return native.getContext("2d");
          },
          toBlob(
            callback: (blob: Blob | null) => void,
            mimeType?: string,
            _quality?: number,
          ): void {
            try {
              const buf = native.toBuffer(
                (mimeType ?? "image/png") as "image/png",
              );
              callback(
                new Blob([new Uint8Array(buf)], {
                  type: mimeType ?? "image/png",
                }),
              );
            } catch {
              callback(null);
            }
          },
          get width(): number {
            return 300;
          },
          set width(_val: number) {
            // CanvasElement from @napi-rs/canvas doesn't support dynamic resize
            // but for the converters this is only used for creating new canvases
          },
          get height(): number {
            return 150;
          },
          set height(_val: number) {
            // Same as above
          },
        };
      }
      throw new Error(
        `document.createElement("${tagName}") is not supported in CLI mode`,
      );
    },
    addEventListener() {
      // No-op for CLI
    },
    removeEventListener() {
      // No-op for CLI
    },
    dispatchEvent() {
      return true;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    body: null,
    head: null,
    documentElement: null,
  };
}

// ── Extended OffscreenCanvas that can draw ImageBitmapWrapper ─────────────────

/**
 * The converters use OffscreenCanvas.getContext("2d").drawImage(bitmap, 0, 0)
 * and then getImageData(). We need to intercept drawImage to handle our
 * ImageBitmapWrapper which wraps a @napi-rs/canvas image.
 *
 * Strategy: Instead of patching the context, we create a patched OffscreenCanvas
 * that returns a context proxy which unwraps ImageBitmapWrapper in drawImage calls.
 */

class PatchedOffscreenCanvas {
  readonly width: number;
  readonly height: number;
  private _canvas: Canvas;
  private _contextProxy: PatchedCanvasContext | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this._canvas = createCanvas(width, height);
  }

  getContext(contextId: "2d"): PatchedCanvasContext | null {
    if (contextId !== "2d") return null;
    if (!this._contextProxy) {
      const nativeCtx = this._canvas.getContext("2d");
      if (!nativeCtx) return null;
      this._contextProxy = new PatchedCanvasContext(nativeCtx);
    }
    return this._contextProxy;
  }

  async convertToBlob(options?: {
    type?: string;
    quality?: number;
  }): Promise<Blob> {
    const mimeType = options?.type ?? "image/png";
    const buffer = this._canvas.toBuffer(mimeType as "image/png");
    return new Blob([new Uint8Array(buffer)], { type: mimeType });
  }

  transferToImageBitmap(): never {
    throw new Error("transferToImageBitmap is not supported in CLI mode");
  }
}

/**
 * Proxy around @napi-rs/canvas CanvasRenderingContext2D that handles
 * ImageBitmapWrapper objects in drawImage() calls.
 */
class PatchedCanvasContext {
  private _ctx: SKRSContext2D;

  constructor(ctx: SKRSContext2D) {
    this._ctx = ctx;
  }

  drawImage(
    source: unknown,
    dxOrSx: number,
    dyOrSy: number,
    dwOrSw?: number,
    dhOrSh?: number,
    dx?: number,
    dy?: number,
    dw?: number,
    dh?: number,
  ): void {
    // Unwrap ImageBitmapWrapper to get the native @napi-rs/canvas image
    const nativeSource =
      source instanceof ImageBitmapWrapper
        ? (source as unknown as { _imageSource: unknown })._imageSource
        : source;

    if (arguments.length <= 5) {
      // drawImage(source, dx, dy) or drawImage(source, dx, dy, dw, dh)
      if (arguments.length === 3) {
        this._ctx.drawImage(
          nativeSource as unknown as Image | Canvas,
          dxOrSx,
          dyOrSy,
        );
      } else {
        this._ctx.drawImage(
          nativeSource as unknown as Image | Canvas,
          dxOrSx,
          dyOrSy,
          dwOrSw!,
          dhOrSh!,
        );
      }
    } else {
      // drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)
      this._ctx.drawImage(
        nativeSource as unknown as Image | Canvas,
        dxOrSx,
        dyOrSy,
        dwOrSw!,
        dhOrSh!,
        dx!,
        dy!,
        dw!,
        dh!,
      );
    }
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
    // @napi-rs/canvas ImageData lacks `colorSpace`; cast to the DOM type
    return this._ctx.getImageData(sx, sy, sw, sh) as unknown as ImageData;
  }

  putImageData(
    imageData: ImageData,
    dx: number,
    dy: number,
    dirtyX?: number,
    dirtyY?: number,
    dirtyWidth?: number,
    dirtyHeight?: number,
  ): void {
    if (
      dirtyX === undefined ||
      dirtyY === undefined ||
      dirtyWidth === undefined ||
      dirtyHeight === undefined
    ) {
      this._ctx.putImageData(imageData, dx, dy);
    } else {
      this._ctx.putImageData(
        imageData,
        dx,
        dy,
        dirtyX,
        dirtyY,
        dirtyWidth,
        dirtyHeight,
      );
    }
  }

  // Passthrough all other properties to the native context
  get fillStyle() {
    return this._ctx.fillStyle;
  }
  set fillStyle(value: unknown) {
    this._ctx.fillStyle = value as string;
  }
  get strokeStyle() {
    return this._ctx.strokeStyle;
  }
  set strokeStyle(value: unknown) {
    this._ctx.strokeStyle = value as string;
  }
  get font() {
    return this._ctx.font;
  }
  set font(value: string) {
    this._ctx.font = value;
  }
  get globalAlpha() {
    return this._ctx.globalAlpha;
  }
  set globalAlpha(value: number) {
    this._ctx.globalAlpha = value;
  }
  get globalCompositeOperation() {
    return this._ctx.globalCompositeOperation;
  }
  set globalCompositeOperation(value: string) {
    this._ctx.globalCompositeOperation = value as GlobalCompositeOperation;
  }
  get imageSmoothingEnabled() {
    return this._ctx.imageSmoothingEnabled;
  }
  set imageSmoothingEnabled(value: boolean) {
    this._ctx.imageSmoothingEnabled = value;
  }
  get lineWidth() {
    return this._ctx.lineWidth;
  }
  set lineWidth(value: number) {
    this._ctx.lineWidth = value;
  }
  get lineCap() {
    return this._ctx.lineCap;
  }
  set lineCap(value: string) {
    this._ctx.lineCap = value as CanvasLineCap;
  }
  get lineJoin() {
    return this._ctx.lineJoin;
  }
  set lineJoin(value: string) {
    this._ctx.lineJoin = value as CanvasLineJoin;
  }
  get shadowBlur() {
    return this._ctx.shadowBlur;
  }
  set shadowBlur(value: number) {
    this._ctx.shadowBlur = value;
  }
  get shadowColor() {
    return this._ctx.shadowColor;
  }
  set shadowColor(value: string) {
    this._ctx.shadowColor = value;
  }
  get shadowOffsetX() {
    return this._ctx.shadowOffsetX;
  }
  set shadowOffsetX(value: number) {
    this._ctx.shadowOffsetX = value;
  }
  get shadowOffsetY() {
    return this._ctx.shadowOffsetY;
  }
  set shadowOffsetY(value: number) {
    this._ctx.shadowOffsetY = value;
  }
  get textAlign() {
    return this._ctx.textAlign;
  }
  set textAlign(value: string) {
    this._ctx.textAlign = value as CanvasTextAlign;
  }
  get textBaseline() {
    return this._ctx.textBaseline;
  }
  set textBaseline(value: string) {
    this._ctx.textBaseline = value as CanvasTextBaseline;
  }
  get filter() {
    return this._ctx.filter;
  }
  set filter(value: string) {
    this._ctx.filter = value;
  }
  get miterLimit() {
    return this._ctx.miterLimit;
  }
  set miterLimit(value: number) {
    this._ctx.miterLimit = value;
  }

  clearRect(x: number, y: number, w: number, h: number) {
    this._ctx.clearRect(x, y, w, h);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this._ctx.fillRect(x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number) {
    this._ctx.strokeRect(x, y, w, h);
  }
  fillText(text: string, x: number, y: number, maxWidth?: number) {
    this._ctx.fillText(text, x, y, maxWidth);
  }
  strokeText(text: string, x: number, y: number, maxWidth?: number) {
    this._ctx.strokeText(text, x, y, maxWidth);
  }
  beginPath() {
    this._ctx.beginPath();
  }
  closePath() {
    this._ctx.closePath();
  }
  moveTo(x: number, y: number) {
    this._ctx.moveTo(x, y);
  }
  lineTo(x: number, y: number) {
    this._ctx.lineTo(x, y);
  }
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ) {
    this._ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
    this._ctx.quadraticCurveTo(cpx, cpy, x, y);
  }
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ) {
    this._ctx.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number) {
    this._ctx.arcTo(x1, y1, x2, y2, radius);
  }
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ) {
    this._ctx.ellipse(
      x,
      y,
      radiusX,
      radiusY,
      rotation,
      startAngle,
      endAngle,
      counterclockwise,
    );
  }
  rect(x: number, y: number, w: number, h: number) {
    this._ctx.rect(x, y, w, h);
  }
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii?: number | number[],
  ) {
    this._ctx.roundRect(x, y, w, h, radii as number);
  }
  fill(fillRule?: string) {
    this._ctx.fill(fillRule as CanvasFillRule);
  }
  stroke() {
    this._ctx.stroke();
  }
  clip(fillRule?: string) {
    this._ctx.clip(fillRule as CanvasFillRule);
  }
  save() {
    this._ctx.save();
  }
  restore() {
    this._ctx.restore();
  }
  scale(x: number, y: number) {
    this._ctx.scale(x, y);
  }
  rotate(angle: number) {
    this._ctx.rotate(angle);
  }
  translate(x: number, y: number) {
    this._ctx.translate(x, y);
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this._ctx.transform(a, b, c, d, e, f);
  }
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ) {
    this._ctx.setTransform(a, b, c, d, e, f);
  }
  resetTransform() {
    this._ctx.resetTransform();
  }
  getLineDash() {
    return this._ctx.getLineDash();
  }
  setLineDash(segments: number[]) {
    this._ctx.setLineDash(segments);
  }
  measureText(text: string) {
    return this._ctx.measureText(text);
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
    return this._ctx.createLinearGradient(x0, y0, x1, y1);
  }
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ) {
    return this._ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  }
  createConicGradient(startAngle: number, x: number, y: number) {
    return this._ctx.createConicGradient(startAngle, x, y);
  }
  createPattern(image: unknown, repetition: string) {
    return this._ctx.createPattern(
      image as unknown as Image | Canvas,
      repetition as "repeat" | "repeat-x" | "repeat-y" | "no-repeat" | null,
    );
  }
  createImageData(sw: number, sh: number) {
    return this._ctx.createImageData(sw, sh);
  }
  isPointInPath(x: number, y: number, fillRule?: string) {
    return this._ctx.isPointInPath(x, y, fillRule as CanvasFillRule);
  }
  isPointInStroke(x: number, y: number) {
    return this._ctx.isPointInStroke(x, y);
  }
}

// ── Install globals ──────────────────────────────────────────────────────────

// Install PatchedOffscreenCanvas as global OffscreenCanvas
globalThis.OffscreenCanvas =
  PatchedOffscreenCanvas as unknown as typeof globalThis.OffscreenCanvas;

// Install createImageBitmap polyfill
globalThis.createImageBitmap =
  createImageBitmapPolyfill as unknown as typeof globalThis.createImageBitmap;

// Install minimal document mock (only createElement('canvas') is needed)
if (typeof globalThis.document === "undefined") {
  (
    globalThis as unknown as {
      document: ReturnType<typeof createDocumentPolyfill>;
    }
  ).document = createDocumentPolyfill();
}

// Ensure self refers to globalThis (needed by Worker-related code)
if (typeof (globalThis as Record<string, unknown>).self === "undefined") {
  (globalThis as Record<string, unknown>).self = globalThis;
}

// navigator mock (needed by i18n/localization.ts)
if (typeof globalThis.navigator === "undefined") {
  (globalThis as Record<string, unknown>).navigator = {
    languages: ["en"],
    language: "en",
  };
}

// localStorage mock (needed by i18n/localization.ts)
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (_index: number) => null,
  };
}

// FileReader polyfill (needed by Babylon.js LoadFile → ReadFile for File objects)
if (typeof globalThis.FileReader === "undefined") {
  (globalThis as Record<string, unknown>).FileReader = class FileReader {
    onabort: (() => void) | null = null;
    onerror: ((event: ProgressEvent) => void) | null = null;
    onload: ((event: ProgressEvent) => void) | null = null;
    onloadend: (() => void) | null = null;
    onloadstart: (() => void) | null = null;
    onprogress: ((event: ProgressEvent) => void) | null = null;
    readyState: 0 | 1 | 2 = 0;
    result: string | ArrayBuffer | null = null;
    error: DOMException | null = null;

    static readonly EMPTY = 0 as const;
    static readonly LOADING = 1 as const;
    static readonly DONE = 2 as const;

    readonly EMPTY = 0 as const;
    readonly LOADING = 1 as const;
    readonly DONE = 2 as const;

    private _aborted = false;

    abort(): void {
      this._aborted = true;
      this.readyState = 2;
      this.onabort?.();
      this.onloadend?.();
    }

    readAsArrayBuffer(blob: Blob): void {
      this._readBlob(blob, "arraybuffer");
    }

    readAsText(blob: Blob, _encoding?: string): void {
      this._readBlob(blob, "text");
    }

    readAsDataURL(blob: Blob): void {
      this._readBlob(blob, "dataurl");
    }

    private async _readBlob(
      blob: Blob,
      mode: "arraybuffer" | "text" | "dataurl",
    ): Promise<void> {
      this.readyState = 1;
      this._aborted = false;

      try {
        const buffer = await blob.arrayBuffer();

        if (this._aborted) return;

        switch (mode) {
          case "arraybuffer":
            this.result = buffer;
            break;
          case "text": {
            const decoder = new TextDecoder("utf-8");
            this.result = decoder.decode(buffer);
            break;
          }
          case "dataurl": {
            const bytes = new Uint8Array(buffer);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]!);
            }
            const base64 =
              typeof btoa !== "undefined"
                ? btoa(binary)
                : Buffer.from(binary, "binary").toString("base64");
            this.result = `data:application/octet-stream;base64,${base64}`;
            break;
          }
        }

        this.readyState = 2;
        // Create a mock event with `target` pointing to `this` so Babylon.js can read `e.target["result"]`
        const loadEvent = {
          type: "load",
          target: this,
        } as unknown as ProgressEvent;
        this.onload?.(loadEvent);
        this.onloadend?.();
      } catch (err) {
        if (this._aborted) return;
        this.readyState = 2;
        this.error = new DOMException(
          err instanceof Error ? err.message : String(err),
          "NotReadableError",
        );
        this.onerror?.({
          type: "error",
          target: this,
        } as unknown as ProgressEvent);
        this.onloadend?.();
      }
    }
  };
}

// XMLHttpRequest polyfill (needed by Babylon.js SceneLoader)
// Minimal implementation that supports the fetch-based loading path.
if (typeof globalThis.XMLHttpRequest === "undefined") {
  (globalThis as Record<string, unknown>).XMLHttpRequest =
    class XMLHttpRequest {
      onreadystatechange: (() => void) | null = null;
      onload: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      readyState = 0;
      status = 0;
      statusText = "";
      response: ArrayBuffer | null = null;
      responseType = "";
      withCredentials = false;
      timeout = 0;
      private _url = "";
      private _headers: Record<string, string> = {};
      private _listeners: Record<string, Set<(event?: unknown) => void>> = {};

      addEventListener(
        type: string,
        listener: (event?: unknown) => void,
      ): void {
        if (!this._listeners[type]) {
          this._listeners[type] = new Set();
        }
        this._listeners[type]!.add(listener);
      }

      removeEventListener(
        type: string,
        listener: (event?: unknown) => void,
      ): void {
        this._listeners[type]?.delete(listener);
      }

      private _dispatchEvent(type: string, event?: unknown): void {
        // Call property handlers (e.g., this.onload)
        const handler = (this as unknown as Record<string, unknown>)[
          `on${type}`
        ];
        if (typeof handler === "function") {
          handler.call(this, event ?? { type, target: this });
        }
        // Call registered listeners
        this._listeners[type]?.forEach((listener) => {
          listener.call(this, event ?? { type, target: this });
        });
      }

      open(_method: string, url: string): void {
        this._url = url;
        this.readyState = 1;
      }

      setRequestHeader(name: string, value: string): void {
        this._headers[name] = value;
      }

      send(_body?: unknown): void {
        const url = this._url;

        // Handle blob: URLs
        if (url && typeof url === "string") {
          this.readyState = 2;
          this._fetchData(url);
        }
      }

      private async _fetchData(url: string): Promise<void> {
        try {
          // In CLI, we don't have a web server to resolve relative URLs.
          // Native fetch for relative URLs might hang or fail depending on the environment.
          if (
            typeof url === "string" &&
            !url.startsWith("http") &&
            !url.startsWith("data:") &&
            !url.startsWith("blob:")
          ) {
            this.status = 404;
            this.statusText = "Not Found (Relative URL not supported in CLI)";
            this.readyState = 4;
            this._dispatchEvent("readystatechange");
            this._dispatchEvent(
              "error",
              new Error(`Relative URL not supported in CLI: ${url}`),
            );
            return;
          }

          // Try native fetch (supports blob:, file:, data: URLs in Bun)
          const response = await fetch(url as "url");
          this.status = response.status;
          this.statusText = response.statusText;

          if (this.responseType === "arraybuffer") {
            this.response = await response.arrayBuffer();
          } else {
            const buf = await response.arrayBuffer();
            this.response = buf;
          }

          this.readyState = 4;
          this._dispatchEvent("readystatechange");
          this._dispatchEvent("load");
        } catch (err) {
          this.status = 0;
          this.readyState = 4;
          this._dispatchEvent("error", err);
        }
      }

      abort(): void {
        this.readyState = 0;
      }

      getResponseHeader(_name: string): string | null {
        return null;
      }

      getAllResponseHeaders(): string {
        return "";
      }
    };
}

// window / self polyfill (needed by CardPngCreator → resolveDefaultBaseImageUrl)
if (typeof globalThis.window === "undefined") {
  (globalThis as Record<string, unknown>).window = globalThis;
}
if (typeof globalThis.self === "undefined") {
  (globalThis as Record<string, unknown>).self = globalThis;
}
if (typeof (globalThis as Record<string, unknown>).location === "undefined") {
  (globalThis as Record<string, unknown>).location = {
    href: "http://localhost/",
    origin: "http://localhost",
    protocol: "http:",
    host: "localhost",
    hostname: "localhost",
    port: "",
    pathname: "/",
    search: "",
    hash: "",
  };
}
