// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  resolvePmxMaterialTranslucency,
  type PmxTranslucencySourceModel,
} from "@/app/converter/PmxMaterialTranslucency";
import { makeTgaBuffer } from "./helpers";

/** Builds a minimal bottom-up 32-bpp BMP with a single row of pixels. */
function makeBmpBuffer(
  pixels: readonly (readonly [number, number, number, number])[],
): ArrayBuffer {
  const width = pixels.length;
  const height = 1;
  const pixelOffset = 54;
  const buffer = new ArrayBuffer(pixelOffset + width * 4 * height);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, buffer.byteLength, true);
  view.setUint32(10, pixelOffset, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 0, true);
  for (let x = 0; x < width; ++x) {
    const [b, g, r, a] = pixels[x];
    const dest = pixelOffset + x * 4;
    bytes[dest] = b;
    bytes[dest + 1] = g;
    bytes[dest + 2] = r;
    bytes[dest + 3] = a;
  }
  return buffer;
}

function makeModel(
  materials: PmxTranslucencySourceModel["materials"],
  textures: readonly string[] = [],
): PmxTranslucencySourceModel {
  return { materials, textures };
}

function makeFile(buffer: ArrayBuffer, name: string): File {
  return new File([buffer], name);
}

describe("resolvePmxMaterialTranslucency", () => {
  it("material diffuse alpha < 1 wins before any texture scan", async () => {
    const result = await resolvePmxMaterialTranslucency(
      makeModel([{ diffuse: [1, 1, 1, 0.5], textureIndex: -1 }]),
      [],
      "",
    );

    expect(result.translucentMaterials).toEqual([true]);
    expect(result.alphaEvaluateResults).toEqual([2]);
    expect(result.sources).toEqual(["material-alpha"]);
  });

  it("opaque material without texture stays opaque", async () => {
    const result = await resolvePmxMaterialTranslucency(
      makeModel([{ diffuse: [1, 1, 1, 1], textureIndex: -1 }]),
      [],
      "",
    );

    expect(result.translucentMaterials).toEqual([false]);
    expect(result.alphaEvaluateResults).toEqual([0]);
    expect(result.sources).toEqual(["no-texture"]);
  });

  it("texture with transparent pixels marks the material translucent", async () => {
    // Mimics the fishnet case: RGB under the hole is skin colored, alpha = 0.
    const bmp = makeBmpBuffer([
      [220, 200, 190, 255],
      [220, 200, 190, 0],
    ]);
    const result = await resolvePmxMaterialTranslucency(
      makeModel(
        [{ diffuse: [1, 1, 1, 1], textureIndex: 0 }],
        ["clothes/stockings.bmp"],
      ),
      [makeFile(bmp, "clothes/stockings.bmp")],
      "",
    );

    expect(result.translucentMaterials).toEqual([true]);
    expect(result.alphaEvaluateResults).toEqual([2]);
    expect(result.sources).toEqual(["texture-scan"]);
  });

  it("fully opaque texture keeps the material opaque", async () => {
    const bmp = makeBmpBuffer([[40, 50, 60, 255]]);
    const result = await resolvePmxMaterialTranslucency(
      makeModel([{ diffuse: [1, 1, 1, 1], textureIndex: 0 }], ["tex/a.bmp"]),
      [makeFile(bmp, "tex/a.bmp")],
      "",
    );

    expect(result.translucentMaterials).toEqual([false]);
    expect(result.alphaEvaluateResults).toEqual([0]);
    expect(result.sources).toEqual(["texture-scan"]);
  });

  it("JPEG textures count as opaque without decoding", async () => {
    // Magic bytes only – the resolver must not attempt to decode JPEGs.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const result = await resolvePmxMaterialTranslucency(
      makeModel([{ diffuse: [1, 1, 1, 1], textureIndex: 0 }], ["tex/a.jpg"]),
      [makeFile(jpeg.buffer as ArrayBuffer, "tex/a.jpg")],
      "",
    );

    expect(result.translucentMaterials).toEqual([false]);
    expect(result.alphaEvaluateResults).toEqual([0]);
    expect(result.sources).toEqual(["texture-scan"]);
  });

  it("decodes real TGA textures and detects transparent pixels", async () => {
    // 32-bit uncompressed TGA, 1x2: opaque pixel + fully transparent pixel
    // (TGA stores BGRA with no magic bytes – identified via the extension).
    const tga = makeTgaBuffer({
      width: 1,
      height: 2,
      pixelDepth: 32,
      imageType: 2,
      pixelBytes: [30, 20, 10, 255, 30, 20, 10, 0],
    });
    const result = await resolvePmxMaterialTranslucency(
      makeModel([{ diffuse: [1, 1, 1, 1], textureIndex: 0 }], ["tex/net.tga"]),
      [makeFile(tga, "tex/net.tga")],
      "",
    );

    expect(result.translucentMaterials).toEqual([true]);
    expect(result.alphaEvaluateResults).toEqual([2]);
    expect(result.sources).toEqual(["texture-scan"]);
  });

  it("decodes opaque TGA textures as opaque", async () => {
    // 24-bit TGA has no alpha channel → fully opaque.
    const tga = makeTgaBuffer({
      width: 1,
      height: 1,
      pixelDepth: 24,
      imageType: 2,
      pixelBytes: [10, 20, 30],
    });
    const result = await resolvePmxMaterialTranslucency(
      makeModel(
        [{ diffuse: [1, 1, 1, 1], textureIndex: 0 }],
        ["tex/plain.tga"],
      ),
      [makeFile(tga, "tex/plain.tga")],
      "",
    );

    expect(result.translucentMaterials).toEqual([false]);
    expect(result.alphaEvaluateResults).toEqual([0]);
    expect(result.sources).toEqual(["texture-scan"]);
  });

  it("corrupt TGA texture conservatively marks translucent + not evaluated", async () => {
    // 0x2b is an invalid color map type → decode fails → the result must be
    // the conservative "translucent + not evaluated" (ET = 0x1F).
    const tga = new Uint8Array(64).fill(0x2b);
    const result = await resolvePmxMaterialTranslucency(
      makeModel([{ diffuse: [1, 1, 1, 1], textureIndex: 0 }], ["tex/net.tga"]),
      [makeFile(tga.buffer as ArrayBuffer, "tex/net.tga")],
      "",
    );

    expect(result.translucentMaterials).toEqual([true]);
    expect(result.alphaEvaluateResults).toEqual([0xf]);
    expect(result.sources).toEqual(["texture-unknown"]);
  });

  it("declared texture missing from the file list is conservative too", async () => {
    const result = await resolvePmxMaterialTranslucency(
      makeModel(
        [{ diffuse: [1, 1, 1, 1], textureIndex: 0 }],
        ["clothes/missing.png"],
      ),
      [],
      "",
    );

    expect(result.translucentMaterials).toEqual([true]);
    expect(result.alphaEvaluateResults).toEqual([0xf]);
    expect(result.sources).toEqual(["texture-unknown"]);
  });

  it("resolves texture paths relative to the PMX directory", async () => {
    const bmp = makeBmpBuffer([[10, 20, 30, 0]]);
    const file = makeFile(bmp, "model/tex/a.bmp");
    // Simulate UI file lists rooted above the model directory.
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: "model/tex/a.bmp",
    });

    const result = await resolvePmxMaterialTranslucency(
      makeModel([{ diffuse: [1, 1, 1, 1], textureIndex: 0 }], ["tex/a.bmp"]),
      [file],
      "model/",
    );

    expect(result.translucentMaterials).toEqual([true]);
    expect(result.sources).toEqual(["texture-scan"]);
  });

  it("shares the scan result between materials using the same texture", async () => {
    const transparent = makeBmpBuffer([[10, 20, 30, 0]]);
    const opaque = makeBmpBuffer([[10, 20, 30, 255]]);
    const result = await resolvePmxMaterialTranslucency(
      makeModel(
        [
          { diffuse: [1, 1, 1, 1], textureIndex: 0 },
          { diffuse: [1, 1, 1, 1], textureIndex: 0 },
          { diffuse: [1, 1, 1, 1], textureIndex: 1 },
        ],
        ["shared.bmp", "plain.bmp"],
      ),
      [makeFile(transparent, "shared.bmp"), makeFile(opaque, "plain.bmp")],
      "",
    );

    expect(result.translucentMaterials).toEqual([true, true, false]);
    expect(result.alphaEvaluateResults).toEqual([2, 2, 0]);
    expect(result.sources).toEqual([
      "texture-scan",
      "texture-scan",
      "texture-scan",
    ]);
  });
});
