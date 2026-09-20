// @vitest-environment jsdom
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { BpmxReader, PmxReader, type PmxObject } from "babylon-mmd";
import { convertBpmxToPmx } from "@/app/converter/BpmxToPmxConverter";
import { MMD_BLEND_ENABLE_ALPHA } from "@/app/converter/ReverseMappingRules";
import {
  convertPmxToBpmx,
  ensurePmxLoaderRegistered,
} from "@/app/converter/PmxToBpmxConverter";
import { readZip } from "@/app/converter/ZipReader";
import { loadBuffer, loadPmxFolder } from "./helpers";

ensurePmxLoaderRegistered();

/**
 * Compares two parsed PmxObjects structurally.
 *
 * NOTE: vertex ORDER is not preserved in the round-trip because babylon-mmd's
 * optimizeSubmeshes splits/reorders vertices per material, so we do not compare
 * individual vertex values. Instead we verify that every structural count is
 * unchanged and that indices are all in-range.
 */
function assertPmxStructuralEquality(
  original: PmxObject,
  roundTripped: PmxObject,
  label: string,
): void {
  // Material count and per-material index counts must be identical
  expect(roundTripped.materials.length).toBe(original.materials.length);
  for (let i = 0; i < original.materials.length; i++) {
    expect(roundTripped.materials[i].indexCount).toBe(
      original.materials[i].indexCount,
    );
  }

  // Material order, names and diffuse colors survive the round-trip. RGB
  // must stay identical; the alpha may only be lowered to the MMD
  // blend-enable value when the material was detected as translucent via
  // its texture alpha channel (e.g. mesh stockings).
  for (let i = 0; i < original.materials.length; i++) {
    const o = original.materials[i];
    const r = roundTripped.materials[i];
    expect(r.name).toBe(o.name);
    expect([r.diffuse[0], r.diffuse[1], r.diffuse[2]]).toEqual([
      o.diffuse[0],
      o.diffuse[1],
      o.diffuse[2],
    ]);
    if (r.diffuse[3] !== o.diffuse[3]) {
      expect(o.diffuse[3]).toBeGreaterThanOrEqual(1);
      // PMX stores diffuse as float32; 0.9999 round-trips as its f32 value.
      expect(r.diffuse[3]).toBe(Math.fround(MMD_BLEND_ENABLE_ALPHA));
    }
  }

  // Total index count must be preserved
  expect(roundTripped.indices.length).toBe(original.indices.length);

  // Every index must be a valid vertex reference
  const vtxCount = roundTripped.vertices.length;
  for (let i = 0; i < roundTripped.indices.length; i++) {
    const idx = roundTripped.indices[i];
    expect(idx >= 0 && idx < vtxCount).toBe(true);
  }

  // Texture paths must be an identical set (order can differ)
  const origTexSet = new Set(original.textures);
  const rtTexSet = new Set(roundTripped.textures);
  expect(rtTexSet.size).toBe(origTexSet.size);
  for (const p of origTexSet) {
    expect(rtTexSet.has(p)).toBe(true);
  }

  // Bone count and names
  expect(roundTripped.bones.length).toBe(original.bones.length);
  for (let i = 0; i < original.bones.length; i++) {
    expect(roundTripped.bones[i].name).toBe(original.bones[i].name);
  }

  // Morph count and names
  expect(roundTripped.morphs.length).toBe(original.morphs.length);
  for (let i = 0; i < original.morphs.length; i++) {
    expect(roundTripped.morphs[i].name).toBe(original.morphs[i].name);
  }

  // Display frame count
  expect(roundTripped.displayFrames.length).toBe(original.displayFrames.length);

  // Rigid body count
  expect(roundTripped.rigidBodies.length).toBe(original.rigidBodies.length);

  // Joint count
  expect(roundTripped.joints.length).toBe(original.joints.length);

  void label; // used in error messages only
}

describe("Round-trip: BPMX → PMX → BPMX", () => {
  it("TestModel.bpmx survives BPMX→PMX→BPMX without throwing", async () => {
    // Step 1: BPMX → PMX + ZIP
    const bpmxBuffer = loadBuffer("public/example/TestModel.bpmx");
    const pmxResult = await convertBpmxToPmx(bpmxBuffer);

    expect(pmxResult.pmxBuffer.byteLength).toBeGreaterThan(0);

    // Step 2: unpack ZIP back into File objects
    const { pmxFile, allFiles } = readZip(pmxResult.zipBuffer);

    // Step 3: PMX → BPMX (this uses the real PmxLoader — identical to what MMD uses)
    const finalBpmx = await convertPmxToBpmx(pmxFile, allFiles);

    expect(finalBpmx).toBeInstanceOf(ArrayBuffer);
    expect(finalBpmx.byteLength).toBeGreaterThan(0);
  });
});

describe("PMX → BPMX translucency metadata (evaluatedTransparency)", () => {
  it("TestModelAsPmx/Ai.pmx: materials carry explicit ET bits instead of 0x3f", async () => {
    const { pmxFile, allFiles } = loadPmxFolder(
      "public/example/TestModelAsPmx",
    );
    const originalPmx = await PmxReader.ParseAsync(await pmxFile.arrayBuffer());

    const bpmxBuffer = await convertPmxToBpmx(pmxFile, allFiles);
    const bpmx = await BpmxReader.ParseAsync(bpmxBuffer);

    expect(bpmx.materials.length).toBe(originalPmx.materials.length);

    // BPMX material order corresponds to the PMX material order (the PMX
    // index buffer is material-grouped, so the loader's submesh encounter
    // order matches). A material is "not opaque" (bits 4-5 = 01) either when
    // its diffuse alpha is < 1 (material-alpha path) or when its diffuse
    // texture contains transparent pixels (texture-scan path) – hence ET
    // 0x12 is also valid for alpha = 1 materials.
    const allowedEtValues = new Set([0x00, 0x12, 0x1f]);
    for (let i = 0; i < bpmx.materials.length; ++i) {
      const et = bpmx.materials[i].evaluatedTransparency;
      // 0x3f = "not evaluated" – the pre-fix value that lost the transparency
      // metadata for the card → PMX conversion (opaque fishnet in MMD).
      expect(allowedEtValues.has(et)).toBe(true);
      if (originalPmx.materials[i].diffuse[3] < 1) {
        expect(et).toBe(0x12);
      }
    }
  });
});

describe("Round-trip: PMX → BPMX → PMX", () => {
  it("TestModelAsPmx/Ai.pmx: structural fidelity after PMX→BPMX→PMX", async () => {
    const { pmxFile, allFiles } = loadPmxFolder(
      "public/example/TestModelAsPmx",
    );
    // Parse original PMX so we can compare counts later
    const originalBuffer = await pmxFile.arrayBuffer();
    const originalPmx = await PmxReader.ParseAsync(originalBuffer);

    // Step 1: PMX → BPMX
    const bpmxBuffer = await convertPmxToBpmx(pmxFile, allFiles);
    expect(bpmxBuffer.byteLength).toBeGreaterThan(0);

    // Step 2: BPMX → PMX
    const pmxResult = await convertBpmxToPmx(bpmxBuffer);
    expect(pmxResult.pmxBuffer.byteLength).toBeGreaterThan(0);

    // Verify PMX binary starts with correct magic bytes "PMX "
    const view = new Uint8Array(pmxResult.pmxBuffer);
    expect(view[0]).toBe(0x50); // P
    expect(view[1]).toBe(0x4d); // M
    expect(view[2]).toBe(0x58); // X
    expect(view[3]).toBe(0x20); // space

    // Parse round-tripped PMX and check structural equality
    const roundTrippedPmx = await PmxReader.ParseAsync(pmxResult.pmxBuffer);
    assertPmxStructuralEquality(originalPmx, roundTrippedPmx, "Ai.pmx");
  });

  it("TestModel2AsPmx/ローザスタウト.pmx: structural fidelity after PMX→BPMX→PMX", async () => {
    const { pmxFile, allFiles } = loadPmxFolder(
      "public/example/TestModel2AsPmx",
    );
    const originalBuffer = await pmxFile.arrayBuffer();
    const originalPmx = await PmxReader.ParseAsync(originalBuffer);

    // Step 1: PMX → BPMX
    const bpmxBuffer = await convertPmxToBpmx(pmxFile, allFiles);
    expect(bpmxBuffer.byteLength).toBeGreaterThan(0);

    // Step 2: BPMX → PMX
    const pmxResult = await convertBpmxToPmx(bpmxBuffer);
    expect(pmxResult.pmxBuffer.byteLength).toBeGreaterThan(0);

    // Verify PMX binary starts with correct magic bytes "PMX "
    const view = new Uint8Array(pmxResult.pmxBuffer);
    expect(view[0]).toBe(0x50);
    expect(view[1]).toBe(0x4d);
    expect(view[2]).toBe(0x58);
    expect(view[3]).toBe(0x20);

    // Parse round-tripped PMX and check structural equality
    const roundTrippedPmx = await PmxReader.ParseAsync(pmxResult.pmxBuffer);
    assertPmxStructuralEquality(
      originalPmx,
      roundTrippedPmx,
      "ローザスタウト.pmx",
    );
  });
});

describe("Fishnet regression: 2B HIMEKAWA (TestFishnet)", () => {
  it("preserves material order and translucency through PMX → BPMX → PMX", async () => {
    const { pmxFile, allFiles } = loadPmxFolder(
      "public/example/TestFishnet/2B",
    );
    expect(pmxFile.name.toLowerCase()).toContain("himekawa");

    const original = await PmxReader.ParseAsync(await pmxFile.arrayBuffer());
    const dumpOriginal = original.materials
      .map((material, index) => {
        const texture =
          material.textureIndex >= 0
            ? original.textures[material.textureIndex]
            : "-";
        return `[${index}] "${material.name}" alpha=${material.diffuse[3]} tex=${texture} faces=${material.indexCount / 3}`;
      })
      .join("\n");
    console.log(`=== ORIGINAL PMX materials ===\n${dumpOriginal}`);

    const bpmxBuffer = await convertPmxToBpmx(pmxFile, allFiles);
    const bpmx = await BpmxReader.ParseAsync(bpmxBuffer);
    const dumpBpmx = bpmx.materials
      .map(
        (material, index) =>
          `[${index}] "${material.name}" alpha=${material.diffuse[3]} ET=0x${material.evaluatedTransparency.toString(16)}`,
      )
      .join("\n");
    const geometrySequence = bpmx.geometries
      .map((geometry) =>
        Array.isArray(geometry.materialIndex)
          ? `sub(${geometry.materialIndex
              .map((sub) => sub.materialIndex)
              .join(",")})`
          : String(geometry.materialIndex),
      )
      .join(",");
    console.log(
      `=== BPMX materials (serialized order) ===\n${dumpBpmx}\n=== BPMX geometry → material sequence ===\n${geometrySequence}`,
    );

    const { pmxBuffer, zipBuffer } = await convertBpmxToPmx(bpmxBuffer);
    const roundTripped = await PmxReader.ParseAsync(pmxBuffer);
    const dumpRoundTripped = roundTripped.materials
      .map(
        (material, index) =>
          `[${index}] "${material.name}" alpha=${material.diffuse[3]} faces=${material.indexCount / 3}`,
      )
      .join("\n");
    console.log(`=== ROUNDTRIPPED PMX materials ===\n${dumpRoundTripped}`);

    // Persist the round-tripped model so it can be opened in MMD directly.
    const outDir = path.resolve(process.cwd(), "temp/fishnet-roundtrip");
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, "2B-roundtrip-pmx.zip");
    fs.writeFileSync(zipPath, new Uint8Array(zipBuffer));
    console.log(`Round-tripped model written to: ${zipPath}`);

    // Material count and order must survive the round-trip (MMD draws
    // materials strictly in list order – a reorder would put translucent
    // materials before opaque ones and break the fishnet rendering).
    expect(roundTripped.materials.length).toBe(original.materials.length);
    for (let i = 0; i < original.materials.length; ++i) {
      expect(roundTripped.materials[i].name).toBe(original.materials[i].name);
    }

    // SDEF regression: the BPMX carries an all-zero SDEF row (c/r0/r1) for
    // BDEF vertices; the PMX mapping must not misclassify those rows as SDEF
    // (previously ~38k vertices flipped from BDEF to SDEF, deforming meshes
    // so the skin displaced over the fishnet).
    const weightHist = (pmx: PmxObject) => {
      const hist = [0, 0, 0, 0, 0]; // Bdef1, Bdef2, Bdef4, Sdef, Qdef
      for (const vertex of pmx.vertices) hist[vertex.weightType] += 1;
      return hist;
    };
    const originalWeights = weightHist(original);
    const roundTrippedWeights = weightHist(roundTripped);
    console.log(
      `WEIGHTS original   : Bdef1=${originalWeights[0]} Bdef2=${originalWeights[1]} Bdef4=${originalWeights[2]} Sdef=${originalWeights[3]}`,
    );
    console.log(
      `WEIGHTS roundtripped: Bdef1=${roundTrippedWeights[0]} Bdef2=${roundTrippedWeights[1]} Bdef4=${roundTrippedWeights[2]} Sdef=${roundTrippedWeights[3]}`,
    );
    // SDEF must be exact – that is the regression (net displaced under skin).
    expect(roundTrippedWeights[3]).toBe(originalWeights[3]);
    // Bdef1 is stable (single active weight).
    expect(roundTrippedWeights[0]).toBe(originalWeights[0]);
    // The BPMX does not carry the original weight type for vertices with
    // degenerate (≈0) secondary weights, so a few Bdef4 may normalize to
    // Bdef2 (observed: 14 of 122988 ≈ 0.011%). Bdef2+Bdef4 total is stable.
    expect(roundTrippedWeights[1] + roundTrippedWeights[2]).toBe(
      originalWeights[1] + originalWeights[2],
    );
    expect(
      Math.abs(roundTrippedWeights[1] - originalWeights[1]),
    ).toBeLessThanOrEqual(Math.ceil(original.vertices.length * 0.001));

    // Materials without a sphere texture must keep SphereTextureMode.Off.
    for (let i = 0; i < original.materials.length; ++i) {
      if (original.materials[i].sphereTextureIndex < 0) {
        expect(roundTripped.materials[i].sphereTextureMode).toBe(0);
      }
    }

    // The stockings material (fishnet over skin) must end up translucent in
    // the round-tripped PMX so MMD enables alpha blending for it.
    const stockingsIndices = original.materials
      .map((material, index) =>
        material.textureIndex >= 0 &&
        /stockings|tights|net/i.test(original.textures[material.textureIndex])
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    expect(stockingsIndices.length).toBeGreaterThan(0);
    for (const index of stockingsIndices) {
      expect(roundTripped.materials[index].diffuse[3]).toBeLessThan(1);
    }
  }, 300_000);
});
