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
  /**
   * Suggested base name for the output file (without extension). For merged
   * conversions this is derived from the shared prefix of the input names.
   */
  outputBaseName?: string;
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
    outputBaseName: stripExtension(file.name),
  };
}

/**
 * Derives a base name for a merged motion from the given file names: the
 * longest common prefix of the stripped names, cut back to the last separator
 * boundary (e.g. "dance" + "dance_camera" → "dance"). Falls back to the
 * first file's base name when no meaningful prefix is shared.
 */
export function deriveMergedMotionBaseName(fileNames: string[]): string {
  const baseNames = fileNames.map((name) => stripExtension(name));
  const firstName = baseNames[0] ?? "motion";
  if (baseNames.length < 2) return firstName;

  let prefix = firstName;
  for (const name of baseNames.slice(1)) {
    let index = 0;
    const limit = Math.min(prefix.length, name.length);
    while (index < limit && prefix[index] === name[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (prefix.length === 0) break;
  }

  const boundary = Math.max(
    prefix.lastIndexOf("_"),
    prefix.lastIndexOf("-"),
    prefix.lastIndexOf(" "),
  );
  if (boundary > 0) prefix = prefix.slice(0, boundary);
  return prefix.replace(/[\s_-]+$/, "") || firstName;
}

/**
 * Converts one or more motion files into a single BVMD. A single input keeps
 * the full format support of `convertMotionFileToBvmd` (VMD/VPD/VMP/BVMD);
 * multiple inputs are merged into one animation (e.g. a model VMD plus a
 * camera VMD), which is only supported for VMD files.
 */
export async function convertMotionFilesToBvmd(
  files: File[],
): Promise<MotionConversionResult> {
  if (files.length === 0) {
    throw new Error("Keine Motion-Datei ausgewählt.");
  }
  if (files.length === 1) {
    return convertMotionFileToBvmd(files[0]!);
  }

  const vmdObjects: VmdObject[] = [];
  for (const file of files) {
    if (getMotionFormat(file.name) !== "vmd") {
      throw new Error(
        `Für das Zusammenführen mehrerer Dateien werden ausschließlich VMD-Dateien unterstützt: ${file.name}`,
      );
    }
    vmdObjects.push(VmdObject.ParseFromBuffer(await file.arrayBuffer()));
  }

  const outputBaseName = deriveMergedMotionBaseName(files.map((f) => f.name));
  const { engine, scene } = createHeadlessScene();
  try {
    const loader = new VmdLoader(scene);
    const animation = await loader.loadFromVmdObjectAsync(
      outputBaseName,
      vmdObjects,
    );
    return {
      buffer: BvmdConverter.Convert(animation),
      sourceFormat: "vmd",
      outputFormat: "bvmd",
      summary: summarizeMotion(animation),
      outputBaseName,
    };
  } finally {
    scene.dispose();
    engine.dispose();
  }
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
