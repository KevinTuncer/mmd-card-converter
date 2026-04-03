import { decode as decodeAvif, encode as encodeAvif } from "@jsquash/avif";
import type { BpmxObject } from "babylon-mmd";

type ImageFormat = "PNG" | "JPEG" | "BMP" | "WebP" | "AVIF" | "?";
type RestorableImageFormat = Exclude<ImageFormat, "?">;

function getFileExt(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

function detectFormatFromBytes(bytes: Uint8Array): ImageFormat {
  const text = (start: number, count: number): string =>
    Array.from(bytes.subarray(start, start + count))
      .map((value) => String.fromCharCode(value))
      .join("");

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "PNG";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "JPEG";
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "BMP";
  }
  if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    return "WebP";
  }
  if (bytes.length >= 12 && text(4, 4) === "ftyp") {
    const brand = text(8, 4);
    if (brand === "avif" || brand === "avis") {
      return "AVIF";
    }
  }
  return "?";
}

function targetFormatFromPath(path: string): RestorableImageFormat | null {
  const ext = getFileExt(path);
  if (ext === "png") return "PNG";
  if (ext === "jpg" || ext === "jpeg") return "JPEG";
  if (ext === "bmp") return "BMP";
  if (ext === "webp") return "WebP";
  if (ext === "avif") return "AVIF";
  return null;
}

function mimeTypeForFormat(format: ImageFormat): string | undefined {
  if (format === "PNG") return "image/png";
  if (format === "JPEG") return "image/jpeg";
  if (format === "BMP") return "image/bmp";
  if (format === "WebP") return "image/webp";
  if (format === "AVIF") return "image/avif";
  return undefined;
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
    throw new Error("Unsupported BMP file");
  }

  const pixelOffset = view.getUint32(10, true);
  const dibHeaderSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const planes = view.getUint16(26, true);
  const bitsPerPixel = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (dibHeaderSize < 40 || width <= 0 || rawHeight === 0 || planes !== 1) {
    throw new Error("Unsupported BMP header");
  }

  if (compression !== 0 || (bitsPerPixel !== 24 && bitsPerPixel !== 32)) {
    throw new Error("Unsupported BMP pixel format");
  }

  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  const expectedLength = pixelOffset + rowStride * height;

  if (expectedLength > bytes.length) {
    throw new Error("Corrupt BMP file");
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = topDown ? y : height - 1 - y;
    const rowStart = pixelOffset + sourceY * rowStride;
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

function encodeBmpFromImageData(imageData: ImageData): ArrayBuffer {
  const { data, width, height } = imageData;
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowStride * height;
  const fileSize = 54 + pixelDataSize;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(30, 0, true);
  view.setUint32(34, pixelDataSize, true);

  for (let y = 0; y < height; y++) {
    const destRow = 54 + y * rowStride;
    const sourceY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const src = (sourceY * width + x) * 4;
      const dest = destRow + x * 3;
      bytes[dest] = data[src + 2];
      bytes[dest + 1] = data[src + 1];
      bytes[dest + 2] = data[src];
    }
  }

  return buffer;
}

async function imageDataFromBitmapSource(
  data: ArrayBuffer,
  mimeType: string,
): Promise<ImageData> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap is unavailable");
  }

  const bitmap = await createImageBitmap(new Blob([data], { type: mimeType }));
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Could not get 2d context from OffscreenCanvas");
      }
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    }

    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Could not get 2d context from HTMLCanvasElement");
      }
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    }

    throw new Error("No canvas implementation available");
  } finally {
    bitmap.close();
  }
}

async function decodeImageData(
  data: ArrayBuffer,
  format: ImageFormat,
): Promise<ImageData> {
  if (format === "AVIF") {
    const imageData = await decodeAvif(data);
    if (!imageData) {
      throw new Error("Could not decode AVIF image");
    }
    return imageData;
  }

  if (format === "BMP") {
    return decodeBmpToImageData(data);
  }

  const mimeType = mimeTypeForFormat(format);
  if (!mimeType) {
    throw new Error("Unsupported image format");
  }

  return imageDataFromBitmapSource(data, mimeType);
}

async function imageDataToBlob(
  imageData: ImageData,
  mimeType: string,
  quality?: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not get 2d context from OffscreenCanvas");
    }
    context.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: mimeType, quality });
  }

  if (typeof document !== "undefined") {
    return new Promise<Blob>((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Could not get 2d context from HTMLCanvasElement"));
        return;
      }
      context.putImageData(imageData, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("canvas.toBlob returned null"));
            return;
          }
          resolve(blob);
        },
        mimeType,
        quality,
      );
    });
  }

  throw new Error("No canvas implementation available");
}

async function encodeImageData(
  imageData: ImageData,
  targetFormat: RestorableImageFormat,
  preferLossless: boolean,
): Promise<{ data: ArrayBuffer; mimeType: string | undefined }> {
  if (targetFormat === "BMP") {
    return { data: encodeBmpFromImageData(imageData), mimeType: "image/bmp" };
  }

  if (targetFormat === "AVIF") {
    const avifBuffer = await encodeAvif(
      imageData,
      preferLossless ? { lossless: true } : { lossless: false, quality: 92 },
    );
    return { data: avifBuffer, mimeType: "image/avif" };
  }

  const mimeType = mimeTypeForFormat(targetFormat);
  if (!mimeType) {
    throw new Error("Unsupported target image format");
  }

  const quality = preferLossless ? 1 : 0.92;
  const blob = await imageDataToBlob(imageData, mimeType, quality);
  return { data: await blob.arrayBuffer(), mimeType };
}

export async function restoreImagesToNamedFormats(
  images: readonly BpmxObject.Image[],
  preferLossless = true,
  onProgress?: (done: number, total: number) => void,
): Promise<BpmxObject.Image[]> {
  const imagesToRestore = images.filter((image) => {
    const actualFormat = detectFormatFromBytes(new Uint8Array(image.data));
    const targetFormat = targetFormatFromPath(image.relativePath);

    return (
      targetFormat !== null &&
      actualFormat !== "?" &&
      actualFormat !== targetFormat
    );
  });

  const restoredImages: BpmxObject.Image[] = [];
  let restoredCount = 0;

  for (const image of images) {
    const actualFormat = detectFormatFromBytes(new Uint8Array(image.data));
    const targetFormat = targetFormatFromPath(image.relativePath);

    if (
      !targetFormat ||
      actualFormat === "?" ||
      actualFormat === targetFormat
    ) {
      restoredImages.push(image);
      continue;
    }

    const resolvedTargetFormat: RestorableImageFormat = targetFormat;

    try {
      const imageData = await decodeImageData(image.data, actualFormat);
      const converted = await encodeImageData(
        imageData,
        resolvedTargetFormat,
        preferLossless,
      );
      restoredImages.push({
        relativePath: image.relativePath,
        mimeType: converted.mimeType,
        data: converted.data,
      });
    } catch {
      restoredImages.push(image);
    } finally {
      restoredCount += 1;
      onProgress?.(restoredCount, imagesToRestore.length);
    }
  }

  return restoredImages;
}
