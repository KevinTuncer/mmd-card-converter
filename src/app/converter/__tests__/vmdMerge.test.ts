// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  convertBvmdFileToLegacyVmdFiles,
  convertMotionFilesToBvmd,
  deriveMergedMotionBaseName,
  loadMotionFromBuffer,
} from "@/app/converter/MmdMotionConverter";
import { loadBuffer } from "./helpers";

const FIXTURE = "public/example/TestMotion.bvmd";

function expectArrayEqual(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

function toMotionFile(buffer: ArrayBuffer, fileName: string): File {
  return new File([buffer], fileName, {
    type: "application/octet-stream",
  });
}

describe("deriveMergedMotionBaseName", () => {
  it("trims the shared prefix back to a separator boundary", () => {
    expect(deriveMergedMotionBaseName(["dance.vmd", "dance_camera.vmd"])).toBe(
      "dance",
    );
    expect(
      deriveMergedMotionBaseName(["dance_model.vmd", "dance_cam.vmd"]),
    ).toBe("dance");
  });

  it("falls back to the first base name when nothing meaningful is shared", () => {
    expect(deriveMergedMotionBaseName(["foo.vmd", "bar.vmd"])).toBe("foo");
  });

  it("returns the plain base name for zero or one inputs", () => {
    expect(deriveMergedMotionBaseName([])).toBe("motion");
    expect(deriveMergedMotionBaseName(["pose.vmd"])).toBe("pose");
  });
});

describe("VMD merge → BVMD", () => {
  it("merges split model + camera VMDs back into one BVMD equivalent to the original", async () => {
    const originalBuffer = loadBuffer(FIXTURE);
    const split = await convertBvmdFileToLegacyVmdFiles(
      toMotionFile(originalBuffer.slice(0), "TestMotion.bvmd"),
    );
    const cameraVmd = split.cameraVmd;
    if (!cameraVmd) {
      throw new Error("expected camera VMD to be present");
    }

    const merged = await convertMotionFilesToBvmd([
      toMotionFile(split.modelVmd.buffer, split.modelVmd.fileName),
      toMotionFile(cameraVmd.buffer, cameraVmd.fileName),
    ]);

    expect(merged.sourceFormat).toBe("vmd");
    expect(merged.outputFormat).toBe("bvmd");
    expect(merged.outputBaseName).toBe("TestMotion");
    expect(merged.summary.cameraFrames).toBe(split.summary.cameraFrames);

    const original = (
      await loadMotionFromBuffer("TestMotion.bvmd", originalBuffer.slice(0))
    ).animation;
    const mergedAnimation = (
      await loadMotionFromBuffer("merged.bvmd", merged.buffer.slice(0))
    ).animation;

    expect(mergedAnimation.boneTracks.length).toBe(original.boneTracks.length);
    expect(mergedAnimation.movableBoneTracks.length).toBe(
      original.movableBoneTracks.length,
    );
    expect(mergedAnimation.morphTracks.length).toBe(
      original.morphTracks.length,
    );
    expect(mergedAnimation.propertyTrack.frameNumbers.length).toBe(
      original.propertyTrack.frameNumbers.length,
    );
    expect(mergedAnimation.cameraTrack.frameNumbers.length).toBe(
      original.cameraTrack.frameNumbers.length,
    );

    const boneByName = new Map(
      original.boneTracks.map((track) => [track.name, track]),
    );
    for (const track of mergedAnimation.boneTracks) {
      const expected = boneByName.get(track.name);
      if (!expected) throw new Error(`unexpected bone track: ${track.name}`);
      expectArrayEqual(track.frameNumbers, expected.frameNumbers);
      expectArrayEqual(track.rotations, expected.rotations);
      expectArrayEqual(
        track.rotationInterpolations,
        expected.rotationInterpolations,
      );
      expectArrayEqual(track.physicsToggles, expected.physicsToggles);
    }

    const movableBoneByName = new Map(
      original.movableBoneTracks.map((track) => [track.name, track]),
    );
    for (const track of mergedAnimation.movableBoneTracks) {
      const expected = movableBoneByName.get(track.name);
      if (!expected) {
        throw new Error(`unexpected movable bone track: ${track.name}`);
      }
      expectArrayEqual(track.frameNumbers, expected.frameNumbers);
      expectArrayEqual(track.positions, expected.positions);
      expectArrayEqual(
        track.positionInterpolations,
        expected.positionInterpolations,
      );
      expectArrayEqual(track.rotations, expected.rotations);
      expectArrayEqual(
        track.rotationInterpolations,
        expected.rotationInterpolations,
      );
      expectArrayEqual(track.physicsToggles, expected.physicsToggles);
    }

    const morphByName = new Map(
      original.morphTracks.map((track) => [track.name, track]),
    );
    for (const track of mergedAnimation.morphTracks) {
      const expected = morphByName.get(track.name);
      if (!expected) throw new Error(`unexpected morph track: ${track.name}`);
      expectArrayEqual(track.frameNumbers, expected.frameNumbers);
      expectArrayEqual(track.weights, expected.weights);
    }

    expectArrayEqual(
      mergedAnimation.propertyTrack.frameNumbers,
      original.propertyTrack.frameNumbers,
    );
    expectArrayEqual(
      mergedAnimation.propertyTrack.visibles,
      original.propertyTrack.visibles,
    );

    const mergedCamera = mergedAnimation.cameraTrack;
    const expectedCamera = original.cameraTrack;
    expectArrayEqual(mergedCamera.frameNumbers, expectedCamera.frameNumbers);
    expectArrayEqual(mergedCamera.positions, expectedCamera.positions);
    expectArrayEqual(
      mergedCamera.positionInterpolations,
      expectedCamera.positionInterpolations,
    );
    expectArrayEqual(mergedCamera.rotations, expectedCamera.rotations);
    expectArrayEqual(
      mergedCamera.rotationInterpolations,
      expectedCamera.rotationInterpolations,
    );
    expectArrayEqual(mergedCamera.distances, expectedCamera.distances);
    expectArrayEqual(
      mergedCamera.distanceInterpolations,
      expectedCamera.distanceInterpolations,
    );
    expectArrayEqual(mergedCamera.fovs, expectedCamera.fovs);
    expectArrayEqual(
      mergedCamera.fovInterpolations,
      expectedCamera.fovInterpolations,
    );
  });

  it("keeps single-file conversion working and derives its base name", async () => {
    const result = await convertMotionFilesToBvmd([
      toMotionFile(loadBuffer(FIXTURE).slice(0), "Solo.bvmd"),
    ]);
    expect(result.sourceFormat).toBe("bvmd");
    expect(result.outputBaseName).toBe("Solo");
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });

  it("rejects empty input", async () => {
    await expect(convertMotionFilesToBvmd([])).rejects.toThrow(
      "Keine Motion-Datei ausgewählt.",
    );
  });

  it("rejects merging when a non-VMD file is included", async () => {
    const split = await convertBvmdFileToLegacyVmdFiles(
      toMotionFile(loadBuffer(FIXTURE).slice(0), "TestMotion.bvmd"),
    );
    await expect(
      convertMotionFilesToBvmd([
        toMotionFile(split.modelVmd.buffer, "dance.vmd"),
        toMotionFile(new ArrayBuffer(0), "pose.vpd"),
      ]),
    ).rejects.toThrow(/VMD-Dateien/);
  });
});
