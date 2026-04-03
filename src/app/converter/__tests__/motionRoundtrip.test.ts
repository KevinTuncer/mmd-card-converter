// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BvmdConverter } from "babylon-mmd/esm/Loader/Optimized/bvmdConverter";

import {
  convertBvmdFileToVmd,
  loadMotionFromBuffer,
} from "@/app/converter/MmdMotionConverter";
import { loadBuffer } from "./helpers";

function expectArrayEqual(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

async function expectMotionEquivalent(
  originalBuffer: ArrayBuffer,
  roundtrippedBuffer: ArrayBuffer,
): Promise<void> {
  const original = await loadMotionFromBuffer(
    "TestMotion.bvmd",
    originalBuffer,
  );
  const roundtripped = await loadMotionFromBuffer(
    "TestMotion-roundtrip.bvmd",
    roundtrippedBuffer,
  );

  expect(roundtripped.animation.boneTracks.length).toBe(
    original.animation.boneTracks.length,
  );
  expect(roundtripped.animation.movableBoneTracks.length).toBe(
    original.animation.movableBoneTracks.length,
  );
  expect(roundtripped.animation.morphTracks.length).toBe(
    original.animation.morphTracks.length,
  );

  for (
    let index = 0;
    index < original.animation.boneTracks.length;
    index += 1
  ) {
    const expected = original.animation.boneTracks[index];
    const actual = roundtripped.animation.boneTracks[index];
    expect(actual.name).toBe(expected.name);
    expectArrayEqual(actual.frameNumbers, expected.frameNumbers);
    expectArrayEqual(actual.rotations, expected.rotations);
    expectArrayEqual(
      actual.rotationInterpolations,
      expected.rotationInterpolations,
    );
    expectArrayEqual(actual.physicsToggles, expected.physicsToggles);
  }

  for (
    let index = 0;
    index < original.animation.movableBoneTracks.length;
    index += 1
  ) {
    const expected = original.animation.movableBoneTracks[index];
    const actual = roundtripped.animation.movableBoneTracks[index];
    expect(actual.name).toBe(expected.name);
    expectArrayEqual(actual.frameNumbers, expected.frameNumbers);
    expectArrayEqual(actual.positions, expected.positions);
    expectArrayEqual(
      actual.positionInterpolations,
      expected.positionInterpolations,
    );
    expectArrayEqual(actual.rotations, expected.rotations);
    expectArrayEqual(
      actual.rotationInterpolations,
      expected.rotationInterpolations,
    );
    expectArrayEqual(actual.physicsToggles, expected.physicsToggles);
  }

  for (
    let index = 0;
    index < original.animation.morphTracks.length;
    index += 1
  ) {
    const expected = original.animation.morphTracks[index];
    const actual = roundtripped.animation.morphTracks[index];
    expect(actual.name).toBe(expected.name);
    expectArrayEqual(actual.frameNumbers, expected.frameNumbers);
    expectArrayEqual(actual.weights, expected.weights);
  }

  expectArrayEqual(
    roundtripped.animation.propertyTrack.frameNumbers,
    original.animation.propertyTrack.frameNumbers,
  );
  expectArrayEqual(
    roundtripped.animation.propertyTrack.visibles,
    original.animation.propertyTrack.visibles,
  );
  expect(roundtripped.animation.propertyTrack.ikBoneNames).toEqual(
    original.animation.propertyTrack.ikBoneNames,
  );
  for (
    let index = 0;
    index < original.animation.propertyTrack.ikBoneNames.length;
    index += 1
  ) {
    expectArrayEqual(
      roundtripped.animation.propertyTrack.getIkState(index),
      original.animation.propertyTrack.getIkState(index),
    );
  }

  expectArrayEqual(
    roundtripped.animation.cameraTrack.frameNumbers,
    original.animation.cameraTrack.frameNumbers,
  );
  expectArrayEqual(
    roundtripped.animation.cameraTrack.positions,
    original.animation.cameraTrack.positions,
  );
  expectArrayEqual(
    roundtripped.animation.cameraTrack.positionInterpolations,
    original.animation.cameraTrack.positionInterpolations,
  );
  expectArrayEqual(
    roundtripped.animation.cameraTrack.rotations,
    original.animation.cameraTrack.rotations,
  );
  expectArrayEqual(
    roundtripped.animation.cameraTrack.rotationInterpolations,
    original.animation.cameraTrack.rotationInterpolations,
  );
  expectArrayEqual(
    roundtripped.animation.cameraTrack.distances,
    original.animation.cameraTrack.distances,
  );
  expectArrayEqual(
    roundtripped.animation.cameraTrack.distanceInterpolations,
    original.animation.cameraTrack.distanceInterpolations,
  );
  expectArrayEqual(
    roundtripped.animation.cameraTrack.fovs,
    original.animation.cameraTrack.fovs,
  );
  expectArrayEqual(
    roundtripped.animation.cameraTrack.fovInterpolations,
    original.animation.cameraTrack.fovInterpolations,
  );
}

describe("Motion roundtrip", () => {
  it("converts TestMotion.bvmd to VMD and back to BVMD", async () => {
    const originalBuffer = loadBuffer("public/example/TestMotion.bvmd");
    const motionFile = new File([originalBuffer], "TestMotion.bvmd", {
      type: "application/octet-stream",
    });

    const vmdResult = await convertBvmdFileToVmd(motionFile);
    expect(vmdResult.buffer.byteLength).toBeGreaterThan(0);

    const { animation } = await loadMotionFromBuffer(
      "TestMotion.vmd",
      vmdResult.buffer,
    );
    const roundtrippedBuffer = BvmdConverter.Convert(animation);

    expect(roundtrippedBuffer.byteLength).toBeGreaterThan(0);
    await expectMotionEquivalent(originalBuffer, roundtrippedBuffer);
  });
});
