// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { PmxReader, type BpmxObject } from "babylon-mmd";
import { convertBpmxToPmx } from "@/app/converter/BpmxToPmxConverter";
import { restoreImagesToNamedFormats } from "@/app/converter/ImageFormatRestorer";
import { resolveMaterialTranslucency } from "@/app/converter/MaterialTransparencyResolver";
import {
  mapBpmxToPmxObject,
  MMD_BLEND_ENABLE_ALPHA,
} from "@/app/converter/ReverseMappingRules";
import {
  convertPmxToBpmx,
  ensurePmxLoaderRegistered,
} from "@/app/converter/PmxToBpmxConverter";
import { readZip } from "@/app/converter/ZipReader";
import { detectImageFormat } from "@/app/converter/ImageCompressor";
import { encodeToAvifViaJsquash } from "@/app/converter/ForceAvifEncoder";
import { loadBuffer, makeTgaBuffer } from "./helpers";

ensurePmxLoaderRegistered();

const BPMX_PATH = "public/example/TestModel.bpmx";

describe("convertBpmxToPmx (BPMX → PMX)", () => {
  it("converts TestModel.bpmx without throwing", async () => {
    const buffer = loadBuffer(BPMX_PATH);
    const result = await convertBpmxToPmx(buffer);

    expect(result.pmxBuffer.byteLength).toBeGreaterThan(0);
    expect(result.zipBuffer.byteLength).toBeGreaterThan(0);
  });

  it("pmxBuffer starts with PMX magic bytes (50 4D 58 20)", async () => {
    const buffer = loadBuffer(BPMX_PATH);
    const result = await convertBpmxToPmx(buffer);

    const view = new Uint8Array(result.pmxBuffer);
    // "PMX "
    expect(view[0]).toBe(0x50);
    expect(view[1]).toBe(0x4d);
    expect(view[2]).toBe(0x58);
    expect(view[3]).toBe(0x20);
  });

  it("zipBuffer starts with ZIP local file header signature (PK\\x03\\x04)", async () => {
    const buffer = loadBuffer(BPMX_PATH);
    const result = await convertBpmxToPmx(buffer);

    const view = new Uint8Array(result.zipBuffer);
    expect(view[0]).toBe(0x50); // P
    expect(view[1]).toBe(0x4b); // K
    expect(view[2]).toBe(0x03);
    expect(view[3]).toBe(0x04);
  });

  it("zipBuffer can be read back with readZip() and contains a .pmx file", async () => {
    const buffer = loadBuffer(BPMX_PATH);
    const result = await convertBpmxToPmx(buffer);
    const { pmxFile, allFiles } = readZip(result.zipBuffer);

    expect(pmxFile.name.toLowerCase()).toMatch(/\.pmx$/);
    expect(allFiles.length).toBeGreaterThan(0);
  });

  it("fidelity report has no errors, only info/warn entries", async () => {
    const buffer = loadBuffer(BPMX_PATH);
    const result = await convertBpmxToPmx(buffer);

    expect(Array.isArray(result.report.warnings)).toBe(true);
    for (const w of result.report.warnings) {
      expect(["info", "warn"]).toContain(w.level);
    }
  });

  it("restores AVIF payloads back to the image format implied by the file name", async () => {
    const source = new File(
      [loadBuffer("public/example/TestModelAsPmx/TEX/4.bmp")],
      "4.bmp",
      { type: "image/bmp" },
    );
    const avifBlob = await encodeToAvifViaJsquash(source, 1.0);

    const [restored] = await restoreImagesToNamedFormats([
      {
        relativePath: "TEX/4.bmp",
        mimeType: "image/avif",
        data: await avifBlob.arrayBuffer(),
      },
    ]);

    const restoredFile = new File([restored.data], restored.relativePath, {
      type: restored.mimeType,
    });

    expect(restored.relativePath).toBe("TEX/4.bmp");
    expect(restored.mimeType).toBe("image/bmp");
    expect(await detectImageFormat(restoredFile)).toBe("BMP");
  });

  it("reports live image restoration progress", async () => {
    const source = new File(
      [loadBuffer("public/example/TestModelAsPmx/TEX/4.bmp")],
      "4.bmp",
      { type: "image/bmp" },
    );
    const avifBlob = await encodeToAvifViaJsquash(source, 1.0);
    const progressCalls: Array<[number, number]> = [];

    await restoreImagesToNamedFormats(
      [
        {
          relativePath: "TEX/4.bmp",
          mimeType: "image/avif",
          data: await avifBlob.arrayBuffer(),
        },
      ],
      true,
      (done, total) => {
        progressCalls.push([done, total]);
      },
    );

    expect(progressCalls).toEqual([[1, 1]]);
  });
});

describe("BPMX → PMX binary validity (PmxReader)", () => {
  it("TestModel.bpmx: pmxBuffer parses cleanly with PmxReader.ParseAsync", async () => {
    const buffer = loadBuffer(BPMX_PATH);
    const result = await convertBpmxToPmx(buffer);

    // PmxReader.ParseAsync uses the same binary parser as babylon-mmd's PmxLoader
    // and is equivalent to what MMD-compatible tools use.
    const pmxObject = await PmxReader.ParseAsync(result.pmxBuffer);

    expect(pmxObject.vertices.length).toBeGreaterThan(0);
    expect(pmxObject.materials.length).toBeGreaterThan(0);
    expect(pmxObject.bones.length).toBeGreaterThan(0);
  });
});

describe("BPMX → PMX → load into babylon-mmd (LoadAssetContainerAsync)", () => {
  it("TestModel.bpmx: converted PMX+assets can be loaded as a babylon-mmd mesh", async () => {
    const buffer = loadBuffer(BPMX_PATH);

    // Step 1: convert BPMX → PMX + embedded assets in ZIP
    const result = await convertBpmxToPmx(buffer);

    // Step 2: extract ZIP → pmxFile + texture allFiles
    const { pmxFile, allFiles } = readZip(result.zipBuffer);

    // Step 3: load the PMX into babylon-mmd via the full LoadAssetContainerAsync pipeline
    // (NullEngine + PmxLoader) — the same stack used by MMD-compatible babylon.js apps.
    const bpmxBuffer = await convertPmxToBpmx(pmxFile, allFiles);

    expect(bpmxBuffer).toBeInstanceOf(ArrayBuffer);
    expect(bpmxBuffer.byteLength).toBeGreaterThan(0);
  });
});

// ─── Synthetic BPMX fixtures ──────────────────────────────────────────────

/** Builds a minimal bottom-up 32-bpp BMP (width × 1) with the given BGRA pixels. */
function makeBmp(
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

function makeMaterial(
  overrides: Partial<BpmxObject.Material> = {},
): BpmxObject.Material {
  return {
    name: "mat",
    englishName: "mat",
    diffuse: [1, 1, 1, 1],
    specular: [0, 0, 0],
    shininess: 5,
    ambient: [0.5, 0.5, 0.5],
    evaluatedTransparency: 0x3f,
    flag: 0,
    edgeColor: [0, 0, 0, 1],
    edgeSize: 1,
    textureIndex: -1,
    sphereTextureIndex: -1,
    sphereTextureMode: 0,
    isSharedToonTexture: false,
    toonTextureIndex: -1,
    comment: "",
    ...overrides,
  };
}

function makeGeometry(
  indices: readonly number[],
  materialIndex: BpmxObject.Geometry["materialIndex"],
  vertexCount = 4,
): BpmxObject.Geometry {
  return {
    name: "geo",
    materialIndex,
    positions: Float32Array.from({ length: vertexCount * 3 }, (_, i) => i),
    normals: Float32Array.from({ length: vertexCount * 3 }, () => 1),
    uvs: Float32Array.from({ length: vertexCount * 2 }, () => 0.5),
    additionalUvs: [],
    indices: Uint16Array.from(indices),
    skinning: undefined,
    edgeScale: undefined,
  };
}

function makeBpmx(
  geometries: readonly BpmxObject.Geometry[],
  materials: readonly BpmxObject.Material[],
  images: readonly BpmxObject.Image[] = [],
  textures: readonly BpmxObject.Texture[] = [],
): BpmxObject {
  return {
    header: {
      signature: "BPMX",
      version: [3, 0, 0],
      dataPositions: {
        positionToModelInfo: 0,
        positionToMesh: 0,
        positionToImage: 0,
        positionToTexture: 0,
        positionToMaterial: 0,
        positionToBone: 0,
        positionToMorph: 0,
        positionToDisplayFrame: 0,
        positionToRigidBody: 0,
        positionToJoint: 0,
      },
      modelName: "Test",
      englishModelName: "Test",
      comment: "",
      englishComment: "",
    },
    geometries: [...geometries],
    images: [...images],
    textures: [...textures],
    materials: [...materials],
    bones: [],
    morphs: [],
    displayFrames: [],
    rigidBodies: [],
    joints: [],
  };
}

describe("resolveMaterialTranslucency (MaterialTransparencyResolver)", () => {
  it("marks materials whose diffuse texture contains transparent pixels", async () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2, 0, 2, 3], 0)],
      [makeMaterial({ textureIndex: 0 })],
      [
        {
          relativePath: "tex/tights.bmp",
          mimeType: "image/bmp",
          data: makeBmp([
            [255, 255, 255, 128],
            [255, 255, 255, 255],
          ]),
        },
      ],
      [{ flag: 0, samplingMode: 0, imageIndex: 0 }],
    );

    const result = await resolveMaterialTranslucency(bpmx);

    expect(result.translucency).toEqual([true]);
    expect(result.sources).toEqual(["texture-scan"]);
  });

  it("treats fully opaque textures as opaque", async () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2, 0, 2, 3], 0)],
      [makeMaterial({ textureIndex: 0 })],
      [
        {
          relativePath: "tex/skin.bmp",
          mimeType: "image/bmp",
          data: makeBmp([
            [10, 20, 30, 255],
            [40, 50, 60, 255],
          ]),
        },
      ],
      [{ flag: 0, samplingMode: 0, imageIndex: 0 }],
    );

    const result = await resolveMaterialTranslucency(bpmx);

    expect(result.translucency).toEqual([false]);
    expect(result.sources).toEqual(["texture-scan"]);
  });

  it("treats diffuse alpha < 1 as translucent without scanning textures", async () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2], 0)],
      [makeMaterial({ diffuse: [1, 1, 1, 0.5] })],
    );

    const result = await resolveMaterialTranslucency(bpmx);

    expect(result.translucency).toEqual([true]);
    expect(result.sources).toEqual(["material-alpha"]);
  });

  it("falls back to evaluatedTransparency when the texture is undecodable", async () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2], 0)],
      [
        makeMaterial({
          textureIndex: 0,
          // bits 4-5 = 01 (not complete opaque), bits 0-3 = 1111 (not evaluated)
          evaluatedTransparency: 0x1f,
        }),
      ],
      [
        {
          relativePath: "tex/tights.tga",
          mimeType: undefined,
          data: new ArrayBuffer(4),
        },
      ],
      [{ flag: 0, samplingMode: 0, imageIndex: 0 }],
    );

    const result = await resolveMaterialTranslucency(bpmx);

    expect(result.translucency).toEqual([true]);
    expect(result.sources).toEqual(["evaluated-transparency"]);
  });

  it("evaluatedTransparency 'not evaluated' (0x3f) counts as opaque in the fallback", async () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2], 0)],
      [makeMaterial({ textureIndex: 0 })],
      [
        {
          relativePath: "tex/tights.tga",
          mimeType: undefined,
          data: new ArrayBuffer(4),
        },
      ],
      [{ flag: 0, samplingMode: 0, imageIndex: 0 }],
    );

    const result = await resolveMaterialTranslucency(bpmx);

    expect(result.translucency).toEqual([false]);
    expect(result.sources).toEqual(["evaluated-transparency"]);
  });

  it("JPEG diffuse textures count as opaque (no alpha channel)", async () => {
    const jpegMagic = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);
    const data = new ArrayBuffer(jpegMagic.byteLength);
    new Uint8Array(data).set(jpegMagic);

    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2], 0)],
      [makeMaterial({ textureIndex: 0 })],
      [{ relativePath: "tex/tex.jpg", mimeType: "image/jpeg", data }],
      [{ flag: 0, samplingMode: 0, imageIndex: 0 }],
    );

    const result = await resolveMaterialTranslucency(bpmx);

    expect(result.translucency).toEqual([false]);
    expect(result.sources).toEqual(["texture-scan"]);
  });

  it("TGA diffuse textures are decoded via the built-in TGA decoder", async () => {
    // 32-bit uncompressed TGA, 1x1 with a fully transparent pixel. TGA has no
    // magic bytes – the format is identified via the .tga file extension.
    const tga = makeTgaBuffer({
      width: 1,
      height: 1,
      pixelDepth: 32,
      imageType: 2,
      pixelBytes: [30, 20, 10, 0],
    });

    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2], 0)],
      [makeMaterial({ textureIndex: 0 })],
      [{ relativePath: "tex/tights.tga", mimeType: undefined, data: tga }],
      [{ flag: 0, samplingMode: 0, imageIndex: 0 }],
    );

    const result = await resolveMaterialTranslucency(bpmx);

    expect(result.translucency).toEqual([true]);
    expect(result.sources).toEqual(["texture-scan"]);
  });
});

describe("mapBpmxToPmxObject — transparency reconstruction", () => {
  it("lowers material alpha to the blend-enable value when translucent", () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2, 0, 2, 3], 0)],
      [makeMaterial({ diffuse: [0.9, 0.8, 0.7, 1] })],
    );

    const { pmx, report } = mapBpmxToPmxObject(bpmx, undefined, {
      materialTranslucency: [true],
    });

    expect(pmx.materials[0].diffuse).toEqual([
      0.9,
      0.8,
      0.7,
      MMD_BLEND_ENABLE_ALPHA,
    ]);
    expect(
      report.warnings.some(
        (w) => w.level === "info" && w.message.includes("Alpha"),
      ),
    ).toBe(true);
  });

  it("keeps alpha 1.0 for opaque materials", () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2, 0, 2, 3], 0)],
      [makeMaterial()],
    );

    const { pmx, report } = mapBpmxToPmxObject(bpmx, undefined, {
      materialTranslucency: [false],
    });

    expect(pmx.materials[0].diffuse[3]).toBe(1);
    expect(report.warnings.some((w) => w.message.includes("Alpha"))).toBe(
      false,
    );
  });

  it("never modifies an alpha that is already below 1", () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2, 0, 2, 3], 0)],
      [makeMaterial({ diffuse: [1, 1, 1, 0.5] })],
    );

    const { pmx } = mapBpmxToPmxObject(bpmx, undefined, {
      materialTranslucency: [true],
    });

    expect(pmx.materials[0].diffuse[3]).toBe(0.5);
  });

  it("without hints the original alpha is kept", () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2, 0, 2, 3], 0)],
      [makeMaterial()],
    );

    const { pmx } = mapBpmxToPmxObject(bpmx);

    expect(pmx.materials[0].diffuse[3]).toBe(1);
  });
});

describe("mapBpmxToPmxObject — per-material index bucketing", () => {
  it("groups triangles by material even when sub-geometries interleave materials", () => {
    const geometry = makeGeometry(
      [0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6],
      [
        {
          materialIndex: 1,
          verticesStart: 0,
          verticesCount: 4,
          indexStart: 0,
          indexCount: 6,
        },
        {
          materialIndex: 0,
          verticesStart: 4,
          verticesCount: 4,
          indexStart: 6,
          indexCount: 6,
        },
      ],
      8,
    );
    const bpmx = makeBpmx([geometry], [makeMaterial(), makeMaterial()]);

    const { pmx } = mapBpmxToPmxObject(bpmx);

    // Material 0 must own the triangles of the second sub-geometry (local
    // indices 6..11) and be drawn first; the winding is flipped per triangle.
    expect(Array.from(pmx.indices)).toEqual([
      4,
      6,
      5,
      5,
      6,
      7, // material 0 (second sub-geometry, flipped)
      0,
      2,
      1,
      1,
      2,
      3, // material 1 (first sub-geometry, flipped)
    ]);
    expect(pmx.materials.map((m) => m.indexCount)).toEqual([6, 6]);
  });

  it("keeps geometry order for single-material geometries", () => {
    const bpmx = makeBpmx(
      [makeGeometry([0, 1, 2], 0), makeGeometry([4, 5, 6], 1, 7)],
      [makeMaterial(), makeMaterial()],
    );

    const { pmx } = mapBpmxToPmxObject(bpmx);

    // Second geometry starts at vertex offset 4; its triangle (4,5,6) is
    // flipped to (4,6,5) and shifted by the offset.
    expect(Array.from(pmx.indices)).toEqual([0, 2, 1, 8, 10, 9]);
    expect(pmx.materials.map((m) => m.indexCount)).toEqual([3, 3]);
  });

  it("drops triangles with an invalid material index and warns", () => {
    const bpmx = makeBpmx([makeGeometry([0, 1, 2], -1)], [makeMaterial()]);

    const { pmx, report } = mapBpmxToPmxObject(bpmx);

    expect(pmx.indices.length).toBe(0);
    expect(pmx.materials[0].indexCount).toBe(0);
    expect(
      report.warnings.some(
        (w) => w.level === "warn" && w.message.includes("gueltiges Material"),
      ),
    ).toBe(true);
  });
});
