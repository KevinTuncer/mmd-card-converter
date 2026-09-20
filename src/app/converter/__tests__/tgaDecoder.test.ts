// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { decodeTgaToImageData } from "@/app/converter/TgaDecoder";
import { makeTgaBuffer } from "./helpers";

describe("decodeTgaToImageData", () => {
  it("decodes 32-bit uncompressed bottom-up TGA with row flip", async () => {
    // Classic TGA default: descriptor 0 → rows are stored bottom-to-top.
    const buffer = makeTgaBuffer({
      width: 2,
      height: 2,
      pixelDepth: 32,
      imageType: 2,
      descriptor: 0,
      pixelBytes: [
        // storage row 0 (= image bottom row): BGRA
        30, 20, 10, 40, 70, 60, 50, 80,
        // storage row 1 (= image top row): BGRA
        110, 100, 90, 120, 150, 140, 130, 160,
      ],
    });

    const imageData = decodeTgaToImageData(buffer);

    expect(imageData.width).toBe(2);
    expect(imageData.height).toBe(2);
    expect(Array.from(imageData.data)).toEqual([
      // image top row (was storage row 1): RGBA
      90, 100, 110, 120, 130, 140, 150, 160,
      // image bottom row (was storage row 0): RGBA
      10, 20, 30, 40, 50, 60, 70, 80,
    ]);
  });

  it("decodes 32-bit top-down TGA without row flip", async () => {
    const buffer = makeTgaBuffer({
      width: 2,
      height: 1,
      pixelDepth: 32,
      imageType: 2,
      descriptor: 0x20,
      pixelBytes: [1, 2, 3, 255, 4, 5, 6, 0],
    });

    const imageData = decodeTgaToImageData(buffer);

    expect(Array.from(imageData.data)).toEqual([3, 2, 1, 255, 6, 5, 4, 0]);
  });

  it("decodes 24-bit TGA as fully opaque", async () => {
    const buffer = makeTgaBuffer({
      width: 2,
      height: 1,
      pixelDepth: 24,
      imageType: 2,
      pixelBytes: [10, 20, 30, 40, 50, 60],
    });

    const imageData = decodeTgaToImageData(buffer);

    expect(Array.from(imageData.data)).toEqual([
      30, 20, 10, 255, 60, 50, 40, 255,
    ]);
  });

  it("decodes RLE-compressed 32-bit TGA packets", async () => {
    const buffer = makeTgaBuffer({
      width: 4,
      height: 1,
      pixelDepth: 32,
      imageType: 10,
      pixelBytes: [
        0x83,
        30,
        20,
        10,
        255, // RLE packet: repeat pixel 4 times
      ],
    });

    const imageData = decodeTgaToImageData(buffer);

    expect(Array.from(imageData.data)).toEqual([
      10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
    ]);
  });

  it("decodes mixed raw and RLE packets", async () => {
    const buffer = makeTgaBuffer({
      width: 3,
      height: 1,
      pixelDepth: 32,
      imageType: 10,
      pixelBytes: [
        0x00,
        10,
        20,
        30,
        255, // raw packet: 1 literal pixel
        0x81,
        40,
        50,
        60,
        0, // RLE packet: pixel repeated 2 times
      ],
    });

    const imageData = decodeTgaToImageData(buffer);

    expect(Array.from(imageData.data)).toEqual([
      30, 20, 10, 255, 60, 50, 40, 0, 60, 50, 40, 0,
    ]);
  });

  it("decodes 8-bit grayscale TGA", async () => {
    const buffer = makeTgaBuffer({
      width: 2,
      height: 1,
      pixelDepth: 8,
      imageType: 3,
      pixelBytes: [0, 255],
    });

    const imageData = decodeTgaToImageData(buffer);

    expect(Array.from(imageData.data)).toEqual([
      0, 0, 0, 255, 255, 255, 255, 255,
    ]);
  });

  it("decodes 16-bit A1R5G5B5 pixels honoring the alpha depth bit", async () => {
    // word = (a << 15) | (r << 10) | (g << 5) | b, little-endian bytes.
    // Full red with alpha=1 → 0xFC00 → bytes [0x00, 0xFC].
    const withAlpha = makeTgaBuffer({
      width: 1,
      height: 1,
      pixelDepth: 16,
      imageType: 2,
      descriptor: 0x01,
      pixelBytes: [0x00, 0xfc],
    });
    const alphaImageData = decodeTgaToImageData(withAlpha);
    expect(Array.from(alphaImageData.data)).toEqual([255, 0, 0, 255]);

    // Same pixel color with alphaDepth = 0 → alpha forced opaque.
    const withoutAlpha = makeTgaBuffer({
      width: 1,
      height: 1,
      pixelDepth: 16,
      imageType: 2,
      descriptor: 0x00,
      pixelBytes: [0x00, 0xfc],
    });
    const opaqueImageData = decodeTgaToImageData(withoutAlpha);
    expect(Array.from(opaqueImageData.data)).toEqual([255, 0, 0, 255]);
  });

  it("decodes color-mapped 8-bit TGA (type 1)", async () => {
    const buffer = makeTgaBuffer({
      width: 2,
      height: 1,
      pixelDepth: 8,
      imageType: 1,
      colorMap: {
        firstIndex: 2,
        entrySize: 32,
        // entries 2 and 3, BGRA: entry 2 = opaque red, entry 3 = half blue
        entryBytes: [0, 0, 255, 255, 255, 0, 0, 128],
      },
      pixelBytes: [3, 2],
    });

    const imageData = decodeTgaToImageData(buffer);

    expect(Array.from(imageData.data)).toEqual([
      0, 0, 255, 128, 255, 0, 0, 255,
    ]);
  });

  it("throws for truncated pixel data", () => {
    const buffer = makeTgaBuffer({
      width: 2,
      height: 2,
      pixelDepth: 32,
      imageType: 2,
      pixelBytes: [1, 2, 3, 4], // 1 of 4 pixels
    });

    expect(() => decodeTgaToImageData(buffer)).toThrow("Corrupt TGA file");
  });

  it("throws for unsupported image types", () => {
    // imageType 32 (Huffman 1-row) is outside the supported subset.
    const buffer = makeTgaBuffer({
      width: 1,
      height: 1,
      pixelDepth: 8,
      imageType: 32,
      pixelBytes: [0],
    });

    expect(() => decodeTgaToImageData(buffer)).toThrow(
      "Unsupported TGA image type",
    );
  });
});
