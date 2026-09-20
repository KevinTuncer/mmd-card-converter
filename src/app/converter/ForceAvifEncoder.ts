import { encode as encodeAvifWithJsquash } from "@jsquash/avif";
import { getErrorStrings } from "@/i18n/localization";

function getExt(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function makeImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): ImageData {
  if (typeof ImageData !== "undefined") {
    return new ImageData(new Uint8ClampedArray(data), width, height);
  }

  return { data, width, height } as ImageData;
}

function decodeBmpToImageData(buffer: ArrayBuffer): ImageData {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error(getErrorStrings().bmpUnsupportedFile);
  }

  const pixelOffset = view.getUint32(10, true);
  const dibHeaderSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const planes = view.getUint16(26, true);
  const bitsPerPixel = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (dibHeaderSize < 40 || width <= 0 || rawHeight === 0 || planes !== 1) {
    throw new Error(getErrorStrings().bmpUnsupportedHeader);
  }

  if (compression !== 0 || (bitsPerPixel !== 24 && bitsPerPixel !== 32)) {
    throw new Error(getErrorStrings().bmpUnsupportedPixelFormat);
  }

  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  const expectedLength = pixelOffset + rowStride * height;

  if (expectedLength > bytes.length) {
    throw new Error(getErrorStrings().bmpCorruptFile);
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    const rowStart = pixelOffset + srcY * rowStride;
    for (let x = 0; x < width; x++) {
      const src = rowStart + x * bytesPerPixel;
      const dest = (y * width + x) * 4;
      rgba[dest] = bytes[src + 2];
      rgba[dest + 1] = bytes[src + 1];
      rgba[dest + 2] = bytes[src];
      rgba[dest + 3] = bytesPerPixel === 4 ? bytes[src + 3] : 0xff;
    }
  }

  return makeImageData(rgba, width, height);
}

function isPngBuffer(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

async function isPngFile(file: File): Promise<boolean> {
  return isPngBuffer(new Uint8Array(await file.slice(0, 4).arrayBuffer()));
}

/**
 * Decodes a PNG without going through a 2D canvas. The canvas stores pixels
 * premultiplied, which irreversibly shifts the RGB values of semi-transparent
 * pixels and zeroes the RGB of fully transparent pixels. UPNG returns the
 * straight-alpha RGBA values exactly as stored in the file.
 */
export async function decodePngToImageData(
  buffer: ArrayBuffer,
): Promise<ImageData> {
  const { default: UPNG } = await import("@lib/upng");
  const png = UPNG.decode(buffer);
  const frame = UPNG.toRGBA8(png)[0];
  return makeImageData(new Uint8ClampedArray(frame), png.width, png.height);
}

async function decodeFileToImageData(file: File): Promise<ImageData> {
  // PNGs must never take the canvas path: canvas premultiplication would
  // alter the pixel values that the "lossless" AVIF encode then stores.
  if (await isPngFile(file)) {
    return decodePngToImageData(await file.arrayBuffer());
  }

  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, {
      // Never apply ICC/gamma conversion implicitly: the raw pixel values are
      // what gets encoded, and the AVIF does not carry the PNG's ICC profile.
      colorSpaceConversion: "none",
    });
    try {
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error(getErrorStrings().no2dOffscreen);
        }
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      }

      if (typeof document !== "undefined") {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error(getErrorStrings().no2dCanvas);
        }
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      }
    } finally {
      bitmap.close();
    }
  }

  if (getExt(file.name) === "bmp") {
    return decodeBmpToImageData(await file.arrayBuffer());
  }

  throw new Error(`No decoder available for ${file.name}`);
}

export async function encodeToAvifViaJsquash(
  file: File,
  quality: number,
): Promise<Blob> {
  const imageData = await decodeFileToImageData(file);
  const avifBuffer = await encodeAvifWithJsquash(
    imageData,
    quality >= 1
      ? { lossless: true }
      : {
          lossless: false,
          quality: Math.max(0, Math.min(100, Math.round(quality * 100))),
          // 4:4:4 statt 4:2:0 (jsquash-Default): ohne Chroma-Subsampling
          // färben sich neutrale Grauflächen nicht von farbigen Nachbarn ein.
          subsample: 3,
        },
  );

  return new Blob([avifBuffer], { type: "image/avif" });
}
