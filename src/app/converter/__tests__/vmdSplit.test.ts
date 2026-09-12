// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BvmdConverter } from "babylon-mmd/esm/Loader/Optimized/bvmdConverter";

import {
  convertBvmdFileToLegacyVmdFiles,
  loadMotionFromBuffer,
} from "@/app/converter/MmdMotionConverter";
import { serializeMmdAnimationToVmd } from "@/app/converter/VmdSerializer";
import { loadBuffer } from "./helpers";

const FIXTURE = "public/example/TestMotion.bvmd";

function expectArrayEqual(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

function toMotionFile(buffer: ArrayBuffer): File {
  return new File([buffer], "TestMotion.bvmd", {
    type: "application/octet-stream",
  });
}

describe("BVMD → legacy VMD split", () => {
  it("splits camera animation into a separate camera VMD", async () => {
    const originalBuffer = loadBuffer(FIXTURE);

    const result = await convertBvmdFileToLegacyVmdFiles(
      toMotionFile(originalBuffer),
    );

    expect(result.summary.cameraFrames).toBeGreaterThan(0);
    expect(result.modelVmd.fileName).toBe("TestMotion.vmd");
    expect(result.cameraVmd).not.toBeNull();
    expect(result.cameraVmd?.fileName).toBe("TestMotion_camera.vmd");
  });

  it("emits a model VMD without camera frames and a camera VMD without model tracks", async () => {
    const originalBuffer = loadBuffer(FIXTURE);

    const result = await convertBvmdFileToLegacyVmdFiles(
      toMotionFile(originalBuffer),
    );
    const cameraVmd = result.cameraVmd;
    if (!cameraVmd) {
      throw new Error("expected camera VMD to be present");
    }

    const modelParsed = await loadMotionFromBuffer(
      result.modelVmd.fileName,
      result.modelVmd.buffer,
    );
    expect(modelParsed.animation.cameraTrack.frameNumbers.length).toBe(0);
    expect(
      modelParsed.animation.boneTracks.length +
        modelParsed.animation.movableBoneTracks.length,
    ).toBeGreaterThan(0);
    expect(modelParsed.animation.morphTracks.length).toBeGreaterThan(0);
    expect(
      modelParsed.animation.propertyTrack.frameNumbers.length,
    ).toBeGreaterThan(0);

    const cameraParsed = await loadMotionFromBuffer(
      cameraVmd.fileName,
      cameraVmd.buffer,
    );
    expect(cameraParsed.animation.cameraTrack.frameNumbers.length).toBe(
      result.summary.cameraFrames,
    );
    expect(cameraParsed.animation.boneTracks.length).toBe(0);
    expect(cameraParsed.animation.movableBoneTracks.length).toBe(0);
    expect(cameraParsed.animation.morphTracks.length).toBe(0);
    expect(cameraParsed.animation.propertyTrack.frameNumbers.length).toBe(0);
  });

  it("preserves the camera animation byte-exactly in the camera VMD", async () => {
    const originalBuffer = loadBuffer(FIXTURE);

    const result = await convertBvmdFileToLegacyVmdFiles(
      toMotionFile(originalBuffer),
    );
    const cameraVmd = result.cameraVmd;
    if (!cameraVmd) {
      throw new Error("expected camera VMD to be present");
    }

    const original = await loadMotionFromBuffer(
      "TestMotion.bvmd",
      originalBuffer.slice(0),
    );
    const cameraParsed = await loadMotionFromBuffer(
      cameraVmd.fileName,
      cameraVmd.buffer,
    );

    const expectedTrack = original.animation.cameraTrack;
    const actualTrack = cameraParsed.animation.cameraTrack;
    expectArrayEqual(actualTrack.frameNumbers, expectedTrack.frameNumbers);
    expectArrayEqual(actualTrack.positions, expectedTrack.positions);
    expectArrayEqual(
      actualTrack.positionInterpolations,
      expectedTrack.positionInterpolations,
    );
    expectArrayEqual(actualTrack.rotations, expectedTrack.rotations);
    expectArrayEqual(
      actualTrack.rotationInterpolations,
      expectedTrack.rotationInterpolations,
    );
    expectArrayEqual(actualTrack.distances, expectedTrack.distances);
    expectArrayEqual(
      actualTrack.distanceInterpolations,
      expectedTrack.distanceInterpolations,
    );
    expectArrayEqual(actualTrack.fovs, expectedTrack.fovs);
    expectArrayEqual(
      actualTrack.fovInterpolations,
      expectedTrack.fovInterpolations,
    );
  });

  it("serializer flags exclude exactly the requested sections", async () => {
    const originalBuffer = loadBuffer(FIXTURE);
    const { animation } = await loadMotionFromBuffer(
      "TestMotion.bvmd",
      originalBuffer.slice(0),
    );

    const modelOnly = serializeMmdAnimationToVmd(animation, {
      includeCameraTrack: false,
    });
    const modelOnlyParsed = await loadMotionFromBuffer(
      "ModelOnly.vmd",
      modelOnly,
    );
    expect(modelOnlyParsed.animation.cameraTrack.frameNumbers.length).toBe(0);
    expect(
      modelOnlyParsed.animation.boneTracks.length +
        modelOnlyParsed.animation.movableBoneTracks.length,
    ).toBeGreaterThan(0);

    const cameraOnly = serializeMmdAnimationToVmd(animation, {
      includeModelTracks: false,
    });
    const cameraOnlyParsed = await loadMotionFromBuffer(
      "CameraOnly.vmd",
      cameraOnly,
    );
    expect(cameraOnlyParsed.animation.cameraTrack.frameNumbers.length).toBe(
      animation.cameraTrack.frameNumbers.length,
    );
    expect(cameraOnlyParsed.animation.boneTracks.length).toBe(0);
    expect(cameraOnlyParsed.animation.movableBoneTracks.length).toBe(0);
    expect(cameraOnlyParsed.animation.morphTracks.length).toBe(0);
  });

  it("omits the camera VMD when the animation has no camera frames", async () => {
    const originalBuffer = loadBuffer(FIXTURE);
    const { animation } = await loadMotionFromBuffer(
      "TestMotion.bvmd",
      originalBuffer.slice(0),
    );

    // Build a camera-less BVMD by stripping the camera track and
    // roundtripping the model-only VMD back to BVMD.
    const modelOnlyVmd = serializeMmdAnimationToVmd(animation, {
      includeCameraTrack: false,
    });
    const cameraLess = await loadMotionFromBuffer("NoCamera.vmd", modelOnlyVmd);
    const bvmdFile = new File(
      [BvmdConverter.Convert(cameraLess.animation)],
      "NoCamera.bvmd",
      { type: "application/octet-stream" },
    );

    const result = await convertBvmdFileToLegacyVmdFiles(bvmdFile);
    expect(result.cameraVmd).toBeNull();
    expect(result.modelVmd.fileName).toBe("NoCamera.vmd");
  });
});
