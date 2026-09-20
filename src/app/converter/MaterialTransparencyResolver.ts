import type { BpmxObject } from "babylon-mmd";
import {
  decodeImageData,
  detectFormatFromBytes,
} from "@/app/converter/ImageFormatRestorer";
import {
  decodeTgaToImageData,
  hasTgaFileExtension,
} from "@/app/converter/TgaDecoder";

/**
 * How the translucency decision for a material was made.
 */
export type MaterialTranslucencySource =
  /** Material diffuse alpha is already < 1. */
  | "material-alpha"
  /** Diffuse texture decoded; contains pixels with alpha < 255. */
  | "texture-scan"
  /** Fallback: native BPMX evaluatedTransparency field. */
  | "evaluated-transparency";

export interface MaterialTranslucencyResult {
  /**
   * translucency[i] === true when material i requires alpha blending.
   */
  readonly translucency: readonly boolean[];
  /**
   * Decision source per material (same indexing as translucency).
   */
  readonly sources: readonly MaterialTranslucencySource[];
}

/** evaluatedTransparency bits 4-5: 01 = not complete opaque. */
const ET_IS_NOT_OPAQUE = 0b01;
/** evaluatedTransparency bits 0-3: alphablend / alphatest+blend results. */
const ET_ALPHA_BLEND = 0b10;
const ET_ALPHA_TEST_AND_BLEND = 0b11;

export function imageDataHasTransparentPixels(imageData: ImageData): boolean {
  const data = imageData.data;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] < 255) return true;
  }
  return false;
}

/**
 * Determines for every BPMX material whether it needs alpha blending.
 *
 * MMD enables alpha blending (and therefore honors the diffuse texture's
 * alpha channel) only when the material diffuse alpha is < 1. Renderers like
 * babylon.js decide this per texture at runtime, which is why a model can
 * look translucent inside an app while its BPMX material alpha is 1.0. This
 * resolver reconstructs the intended transparency using only data embedded in
 * the BPMX itself:
 *
 * 1. material diffuse alpha < 1 → translucent
 * 2. diffuse texture decodable (AVIF/PNG/WebP/BMP, plus TGA identified via
 *    its file extension) → translucent when any pixel has alpha < 255
 *    (JPEG counts as opaque — no alpha channel)
 * 3. otherwise → native evaluatedTransparency field of the BPMX material
 */
export async function resolveMaterialTranslucency(
  bpmx: BpmxObject,
): Promise<MaterialTranslucencyResult> {
  const translucency: boolean[] = [];
  const sources: MaterialTranslucencySource[] = [];

  // imageIndex → true (transparent pixels) / false (fully opaque) / null (undecodable)
  const imageScanCache = new Map<number, boolean | null>();

  const scanImage = async (imageIndex: number): Promise<boolean | null> => {
    const cached = imageScanCache.get(imageIndex);
    if (cached !== undefined) return cached;

    let result: boolean | null = null;
    const image = bpmx.images[imageIndex];
    if (image) {
      try {
        const format = detectFormatFromBytes(new Uint8Array(image.data));
        if (format === "JPEG") {
          result = false; // JPEG has no alpha channel
        } else if (format === "?") {
          // TGA has no magic bytes; identify it via the embedded file name
          // and decode with the built-in TGA decoder. Everything else stays
          // undecodable (evaluatedTransparency fallback).
          if (hasTgaFileExtension(image.relativePath)) {
            result = imageDataHasTransparentPixels(
              await decodeTgaToImageData(image.data),
            );
          }
        } else {
          result = imageDataHasTransparentPixels(
            await decodeImageData(image.data, format),
          );
        }
      } catch {
        result = null; // decoding failed → fall back to evaluatedTransparency
      }
    }
    imageScanCache.set(imageIndex, result);
    return result;
  };

  for (let index = 0; index < bpmx.materials.length; ++index) {
    const material = bpmx.materials[index];

    if (material.diffuse[3] < 1) {
      translucency.push(true);
      sources.push("material-alpha");
      continue;
    }

    const texture =
      0 <= material.textureIndex && material.textureIndex < bpmx.textures.length
        ? bpmx.textures[material.textureIndex]
        : undefined;

    if (
      texture !== undefined &&
      0 <= texture.imageIndex &&
      texture.imageIndex < bpmx.images.length
    ) {
      const scanned = await scanImage(texture.imageIndex);
      if (scanned !== null) {
        translucency.push(scanned);
        sources.push("texture-scan");
        continue;
      }
    }

    const evaluatedTransparency = material.evaluatedTransparency;
    const isNotOpaque =
      ((evaluatedTransparency >> 4) & 0x03) === ET_IS_NOT_OPAQUE;
    const alphaEvaluateResult = evaluatedTransparency & 0x0f;
    translucency.push(
      isNotOpaque ||
        alphaEvaluateResult === ET_ALPHA_BLEND ||
        alphaEvaluateResult === ET_ALPHA_TEST_AND_BLEND,
    );
    sources.push("evaluated-transparency");
  }

  return { translucency, sources };
}
