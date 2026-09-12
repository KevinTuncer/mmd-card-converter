import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { MmdAnimation } from "babylon-mmd/esm/Loader/Animation/mmdAnimation";
import { BvmdConverter } from "babylon-mmd/esm/Loader/Optimized/bvmdConverter";
import { BvmdLoader } from "babylon-mmd/esm/Loader/Optimized/bvmdLoader";
import { VmdObject } from "babylon-mmd/esm/Loader/Parser/vmdObject";
import { VmdLoader } from "babylon-mmd/esm/Loader/vmdLoader";
import { VpdLoader } from "babylon-mmd/esm/Loader/vpdLoader";

import { serializeMmdAnimationToVmd } from "@/app/converter/VmdSerializer";

export type MotionSourceFormat = "bvmd" | "vmd" | "vpd";

export interface MotionSummary {
  boneTracks: number;
  movableBoneTracks: number;
  morphTracks: number;
  propertyFrames: number;
  propertyIkBones: number;
  cameraFrames: number;
  totalBoneFrames: number;
  totalMorphFrames: number;
}

export interface MotionConversionResult {
  buffer: ArrayBuffer;
  sourceFormat: MotionSourceFormat;
  outputFormat: "bvmd" | "vmd";
  summary: MotionSummary;
}

function createHeadlessScene(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  return { engine, scene };
}

function getMotionFormat(fileName: string): MotionSourceFormat {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "bvmd") return "bvmd";
  if (extension === "vmd") return "vmd";
  if (extension === "vpd" || extension === "vmp") return "vpd";
  throw new Error(`Nicht unterstütztes Motion-Format: ${fileName}`);
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") || "motion";
}

export function summarizeMotion(animation: MmdAnimation): MotionSummary {
  return {
    boneTracks: animation.boneTracks.length,
    movableBoneTracks: animation.movableBoneTracks.length,
    morphTracks: animation.morphTracks.length,
    propertyFrames: animation.propertyTrack.frameNumbers.length,
    propertyIkBones: animation.propertyTrack.ikBoneNames.length,
    cameraFrames: animation.cameraTrack.frameNumbers.length,
    totalBoneFrames:
      animation.boneTracks.reduce(
        (total, track) => total + track.frameNumbers.length,
        0,
      ) +
      animation.movableBoneTracks.reduce(
        (total, track) => total + track.frameNumbers.length,
        0,
      ),
    totalMorphFrames: animation.morphTracks.reduce(
      (total, track) => total + track.frameNumbers.length,
      0,
    ),
  };
}

export async function loadMotionFromBuffer(
  fileName: string,
  buffer: ArrayBuffer,
): Promise<{ animation: MmdAnimation; format: MotionSourceFormat }> {
  const format = getMotionFormat(fileName);
  const baseName = stripExtension(fileName);
  const { engine, scene } = createHeadlessScene();

  try {
    if (format === "bvmd") {
      const loader = new BvmdLoader(scene);
      return {
        animation: loader.loadFromBuffer(baseName, buffer),
        format,
      };
    }

    if (format === "vmd") {
      const loader = new VmdLoader(scene);
      const vmdObject = VmdObject.ParseFromBuffer(buffer);
      return {
        animation: await loader.loadFromVmdObjectAsync(baseName, vmdObject),
        format,
      };
    }

    const loader = new VpdLoader(scene);
    return {
      animation: loader.loadFromBuffer(baseName, buffer),
      format,
    };
  } finally {
    scene.dispose();
    engine.dispose();
  }
}

export async function convertMotionFileToBvmd(
  file: File,
): Promise<MotionConversionResult> {
  const { animation, format } = await loadMotionFromBuffer(
    file.name,
    await file.arrayBuffer(),
  );
  return {
    buffer: BvmdConverter.Convert(animation),
    sourceFormat: format,
    outputFormat: "bvmd",
    summary: summarizeMotion(animation),
  };
}

export async function convertBvmdFileToVmd(
  file: File,
): Promise<MotionConversionResult> {
  const { animation, format } = await loadMotionFromBuffer(
    file.name,
    await file.arrayBuffer(),
  );
  if (format !== "bvmd") {
    throw new Error("Für diese Konvertierung wird eine BVMD-Datei benötigt.");
  }
  return {
    buffer: serializeMmdAnimationToVmd(animation, {
      modelName: stripExtension(file.name),
    }),
    sourceFormat: format,
    outputFormat: "vmd",
    summary: summarizeMotion(animation),
  };
}

export interface NamedMotionBuffer {
  fileName: string;
  buffer: ArrayBuffer;
}

export interface LegacyVmdFilesResult {
  modelVmd: NamedMotionBuffer;
  cameraVmd: NamedMotionBuffer | null;
  summary: MotionSummary;
}

/**
 * Converts a BVMD into legacy MMD files, splitting camera data off into its
 * own VMD the same way it was separated in original MMD motion packs.
 * `cameraVmd` is null when the animation contains no camera frames.
 */
export async function convertBvmdFileToLegacyVmdFiles(
  file: File,
): Promise<LegacyVmdFilesResult> {
  const { animation, format } = await loadMotionFromBuffer(
    file.name,
    await file.arrayBuffer(),
  );
  if (format !== "bvmd") {
    throw new Error("Für diese Konvertierung wird eine BVMD-Datei benötigt.");
  }
  const summary = summarizeMotion(animation);
  const baseName = stripExtension(file.name);
  const modelBuffer = serializeMmdAnimationToVmd(animation, {
    modelName: baseName,
    includeCameraTrack: false,
  });
  const cameraBuffer =
    summary.cameraFrames > 0
      ? serializeMmdAnimationToVmd(animation, {
          modelName: baseName,
          includeModelTracks: false,
        })
      : null;
  return {
    modelVmd: { fileName: `${baseName}.vmd`, buffer: modelBuffer },
    cameraVmd: cameraBuffer
      ? { fileName: `${baseName}_camera.vmd`, buffer: cameraBuffer }
      : null,
    summary,
  };
}
