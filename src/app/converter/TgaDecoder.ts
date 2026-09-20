/**
 * Minimal TGA (Truevision TARGA) decoder for CPU-side texture analysis.
 *
 * TGA has no magic bytes and browser image decoders cannot handle it, which
 * is why MMD models frequently ship translucent materials (stockings,
 * fishnets, overlays) as .tga textures that transparency scans could not
 * inspect. This decoder covers the real-world MMD subset of the format:
 *
 * - image types 1/2/3/9/10/11 (color-mapped / true-color / grayscale,
 *   uncompressed and RLE compressed)
 * - pixel depths 8 (grayscale or color-map index), 15/16 (A1R5G5B5),
 *   24 (BGR) and 32 (BGRA)
 * - both row orders (classic bottom-up default and top-down descriptor bit)
 *   plus right-to-left column order (descriptor bit 4)
 *
 * Anything outside this subset (Huffman/Vista/HRZ types, interleave != 0,
 * truncated buffers) throws so callers can fall back to conservative behavior.
 */

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

function requireBytes(bytes: Uint8Array, end: number): void {
  if (end > bytes.length) throw new Error("Corrupt TGA file");
}

/** Reads one uncompressed pixel (BGR(A)/gray/A1R5G5B5) as RGBA into `out`. */
function readRawPixel(
  bytes: Uint8Array,
  offset: number,
  pixelDepth: 8 | 16 | 24 | 32,
  hasAlphaBit: boolean,
  out: Uint8Array,
  outOffset: number,
): void {
  requireBytes(bytes, offset + (pixelDepth >> 3));
  switch (pixelDepth) {
    case 8: {
      // Grayscale value
      const value = bytes[offset];
      out[outOffset + 0] = value;
      out[outOffset + 1] = value;
      out[outOffset + 2] = value;
      out[outOffset + 3] = 255;
      return;
    }
    case 16: {
      // A1R5G5B5 stored as a little-endian word
      const word = bytes[offset] | (bytes[offset + 1] << 8);
      const r = (word >> 10) & 0x1f;
      const g = (word >> 5) & 0x1f;
      const b = word & 0x1f;
      out[outOffset + 0] = (r << 3) | (r >> 2);
      out[outOffset + 1] = (g << 3) | (g >> 2);
      out[outOffset + 2] = (b << 3) | (b >> 2);
      out[outOffset + 3] = hasAlphaBit && word >> 15 === 0 ? 0 : 255;
      return;
    }
    case 24: {
      out[outOffset + 0] = bytes[offset + 2];
      out[outOffset + 1] = bytes[offset + 1];
      out[outOffset + 2] = bytes[offset + 0];
      out[outOffset + 3] = 255;
      return;
    }
    case 32: {
      out[outOffset + 0] = bytes[offset + 2];
      out[outOffset + 1] = bytes[offset + 1];
      out[outOffset + 2] = bytes[offset + 0];
      out[outOffset + 3] = bytes[offset + 3];
      return;
    }
  }
}

/**
 * Decodes a TGA buffer into straight-alpha RGBA image data.
 *
 * @throws {Error} for unsupported or corrupt TGA content
 */
export function decodeTgaToImageData(buffer: ArrayBuffer): ImageData {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  requireBytes(bytes, 18);

  const idLength = bytes[0];
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const colorMapFirstIndex = view.getUint16(3, true);
  const colorMapLength = view.getUint16(5, true);
  const colorMapEntrySize = bytes[7];
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const pixelDepth = bytes[16];
  const descriptor = bytes[17];
  const topToBottom = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;

  if (width === 0 || height === 0) throw new Error("Unsupported TGA size");

  const isRle = (imageType & 0x08) !== 0;
  const baseType = imageType & 0x07;
  if (baseType !== 1 && baseType !== 2 && baseType !== 3) {
    throw new Error("Unsupported TGA image type");
  }
  if (colorMapType !== 0 && colorMapType !== 1) {
    throw new Error("Unsupported TGA color map type");
  }
  if (baseType === 1 && colorMapType !== 1) {
    throw new Error("Color-mapped TGA without color map");
  }

  const supportedDepths: readonly number[] =
    baseType === 1 ? [8, 16] : baseType === 3 ? [8] : [16, 24, 32];
  if (!supportedDepths.includes(pixelDepth)) {
    throw new Error("Unsupported TGA pixel depth");
  }
  // Runtime-validated above; narrowed to the depths readRawPixel supports.
  const depth = pixelDepth as 8 | 16 | 24 | 32;

  let offset = 18 + idLength;

  // Decode the color map into an RGBA table (one entry per index).
  let colorMapRgba: Uint8Array | null = null;
  if (baseType === 1) {
    if (colorMapLength === 0) throw new Error("Corrupt TGA file");
    if (colorMapEntrySize !== 15 && colorMapEntrySize % 8 !== 0) {
      throw new Error("Unsupported TGA color map entry size");
    }
    const entryBytes = Math.ceil(colorMapEntrySize / 8);
    const mapAlphaBit =
      (colorMapEntrySize === 15 || colorMapEntrySize === 16) &&
      (descriptor & 0x0f) > 0;
    const entryPixelDepth = entryBytes === 2 ? 16 : entryBytes === 3 ? 24 : 32;

    colorMapRgba = new Uint8Array(colorMapLength * 4);
    requireBytes(bytes, offset + colorMapLength * entryBytes);
    for (let index = 0; index < colorMapLength; ++index) {
      readRawPixel(
        bytes,
        offset + index * entryBytes,
        entryPixelDepth,
        mapAlphaBit,
        colorMapRgba,
        index * 4,
      );
    }
    offset += colorMapLength * entryBytes;
  }

  const indexBytes = depth < 16 ? 1 : 2;
  const pixelBytes = baseType === 1 ? indexBytes : depth >> 3;
  const alphaBit = depth === 16 && (descriptor & 0x0f) > 0;

  const totalPixels = width * height;
  const storage = new Uint8ClampedArray(totalPixels * 4);
  const pixel = new Uint8Array(4);

  const readPixelAt = (position: number): void => {
    if (baseType === 1) {
      const index =
        indexBytes === 1
          ? bytes[position]
          : bytes[position] | (bytes[position + 1] << 8);
      if (index < colorMapFirstIndex) {
        throw new Error("TGA color index out of range");
      }
      const entry = index - colorMapFirstIndex;
      if (entry >= colorMapLength) {
        throw new Error("TGA color index out of range");
      }
      pixel.set(
        (colorMapRgba as Uint8Array).subarray(entry * 4, entry * 4 + 4),
      );
      return;
    }
    readRawPixel(bytes, position, depth, alphaBit, pixel, 0);
  };

  let cursor = offset;
  let pixelIndex = 0;

  if (isRle) {
    while (pixelIndex < totalPixels) {
      requireBytes(bytes, cursor + 1);
      const packet = bytes[cursor++];
      const count = (packet & 0x7f) + 1;
      if ((packet & 0x80) !== 0) {
        // RLE packet: a single pixel repeated `count` times.
        requireBytes(bytes, cursor + pixelBytes);
        readPixelAt(cursor);
        cursor += pixelBytes;
        for (let i = 0; i < count && pixelIndex < totalPixels; ++i) {
          storage.set(pixel, pixelIndex * 4);
          pixelIndex += 1;
        }
      } else {
        // Raw packet: `count` literal pixels.
        requireBytes(bytes, cursor + count * pixelBytes);
        for (let i = 0; i < count && pixelIndex < totalPixels; ++i) {
          readPixelAt(cursor);
          cursor += pixelBytes;
          storage.set(pixel, pixelIndex * 4);
          pixelIndex += 1;
        }
      }
    }
  } else {
    requireBytes(bytes, cursor + totalPixels * pixelBytes);
    for (; pixelIndex < totalPixels; ++pixelIndex) {
      readPixelAt(cursor);
      cursor += pixelBytes;
      storage.set(pixel, pixelIndex * 4);
    }
  }

  // Reorder storage rows/columns into top-down left-to-right RGBA output.
  const imageData = makeImageData(
    new Uint8ClampedArray(totalPixels * 4),
    width,
    height,
  );
  const out = imageData.data;
  const rowBytes = width * 4;
  for (let y = 0; y < height; ++y) {
    const sourceRow = topToBottom ? y : height - 1 - y;
    const sourceStart = sourceRow * rowBytes;
    if (!rightToLeft) {
      out.set(
        storage.subarray(sourceStart, sourceStart + rowBytes),
        y * rowBytes,
      );
    } else {
      for (let x = 0; x < width; ++x) {
        const sourcePixel = sourceStart + (width - 1 - x) * 4;
        out.set(
          storage.subarray(sourcePixel, sourcePixel + 4),
          (y * width + x) * 4,
        );
      }
    }
  }
  return imageData;
}

/**
 * Whether a file path refers to a TGA texture. TGA has no magic bytes, so the
 * extension is the only identification available.
 */
export function hasTgaFileExtension(path: string): boolean {
  return (path.split(".").pop() ?? "").toLowerCase() === "tga";
}
