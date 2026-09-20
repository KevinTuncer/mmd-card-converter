// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { PmxReader, type PmxObject } from "babylon-mmd";
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
      expect(r.diffuse[3]).toBe(MMD_BLEND_ENABLE_ALPHA);
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
