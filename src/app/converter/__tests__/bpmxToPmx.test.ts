// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { PmxReader } from "babylon-mmd";
import { convertBpmxToPmx } from "@/app/converter/BpmxToPmxConverter";
import { restoreImagesToNamedFormats } from "@/app/converter/ImageFormatRestorer";
import {
  convertPmxToBpmx,
  ensurePmxLoaderRegistered,
} from "@/app/converter/PmxToBpmxConverter";
import { readZip } from "@/app/converter/ZipReader";
import { detectImageFormat } from "@/app/converter/ImageCompressor";
import { encodeToAvifViaJsquash } from "@/app/converter/ForceAvifEncoder";
import { loadBuffer } from "./helpers";

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
