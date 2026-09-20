import {
  decodeImageData,
  detectFormatFromBytes,
} from "@/app/converter/ImageFormatRestorer";
import { imageDataHasTransparentPixels } from "@/app/converter/MaterialTransparencyResolver";
import {
  decodeTgaToImageData,
  hasTgaFileExtension,
} from "@/app/converter/TgaDecoder";

/**
 * Minimal structural view of a PMX model used for translucency detection.
 * `PmxObject` satisfies this interface.
 */
export interface PmxTranslucencySourceModel {
  readonly materials: ReadonlyArray<{
    /** PMX diffuse color; index 3 is the material alpha. */
    readonly diffuse: readonly number[];
    /** Index into {@link PmxTranslucencySourceModel.textures}; -1 = none. */
    readonly textureIndex: number;
  }>;
  readonly textures: readonly string[];
}

/** How the translucency decision for a material was made. */
export type PmxTranslucencySource =
  /** Material diffuse alpha is already < 1. */
  | "material-alpha"
  /** Diffuse texture decoded; decision based on its alpha channel. */
  | "texture-scan"
  /**
   * Diffuse texture missing from the file list or not decodable in the
   * conversion environment (e.g. SPH/DDS/corrupt files): conservatively
   * treated as translucent so the transparency survives the card round-trip.
   */
  | "texture-unknown"
  /** Material declares no diffuse texture. */
  | "no-texture";

export interface PmxMaterialTranslucencyResult {
  /**
   * translucentMaterials[i] === true when material i requires alpha blending
   * (value for BpmxConverter's `translucentMaterials` option).
   */
  readonly translucentMaterials: readonly boolean[];
  /**
   * PMX/BPMX alpha-evaluation result per material (value for BpmxConverter's
   * `alphaEvaluateResults` option): 0 = opaque, 2 = alpha blend,
   * 0xf = "not evaluated".
   */
  readonly alphaEvaluateResults: readonly number[];
  /** Decision source per material (same indexing as translucentMaterials). */
  readonly sources: readonly PmxTranslucencySource[];
}

/** Low-nibble encoding of BpmxConverter's alphaEvaluateResults option. */
const ALPHA_EVALUATE_OPAQUE = 0;
const ALPHA_EVALUATE_ALPHABLEND = 2;
/** "Not evaluated" marker (all bits set). */
const ALPHA_EVALUATE_NOT_EVALUATED = 0xf;

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function fileRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath;
  return normalizeRelativePath(relativePath || file.name);
}

function findTextureFile(
  allFiles: readonly File[],
  relativePath: string,
): File | undefined {
  const target = normalizeRelativePath(relativePath);
  for (const file of allFiles) {
    if (fileRelativePath(file) === target) return file;
  }
  // PMX texture paths are relative to the model directory while file lists
  // are often rooted one or more levels higher.
  const suffix = `/${target}`;
  for (const file of allFiles) {
    if (fileRelativePath(file).endsWith(suffix)) return file;
  }
  return undefined;
}

/**
 * Scans a texture file's alpha channel.
 *
 * @returns true when the image contains pixels with alpha < 255, false when
 *          it is provably opaque (e.g. JPEG), null when it cannot be decoded
 *          in the current environment (unsupported format, no decoder).
 */
async function scanTextureFile(
  file: File,
  path: string,
): Promise<boolean | null> {
  try {
    const buffer = await file.arrayBuffer();
    const format = detectFormatFromBytes(new Uint8Array(buffer));
    if (format === "JPEG") return false; // JPEG has no alpha channel
    if (format === "?") {
      // TGA has no magic bytes; identify it via the file path and decode with
      // the built-in TGA decoder. Everything else stays undecodable.
      if (hasTgaFileExtension(path)) {
        return imageDataHasTransparentPixels(
          await decodeTgaToImageData(buffer),
        );
      }
      return null;
    }
    return imageDataHasTransparentPixels(await decodeImageData(buffer, format));
  } catch {
    return null;
  }
}

/**
 * Determines for every PMX material whether it requires alpha blending so the
 * generated BPMX can carry explicit `evaluatedTransparency` bits (like the
 * official ero cards).
 *
 * MMD activates alpha blending (and thereby honors the diffuse texture's
 * alpha channel) only when the material diffuse alpha is below 1, while
 * babylon.js based viewers evaluate the texture alpha at runtime. Writing the
 * bits explicitly keeps the transparency intact in MMD-facing conversions and
 * in viewers without a runtime texture alpha checker.
 *
 * 1. material diffuse alpha < 1 → translucent ("material-alpha")
 * 2. diffuse texture decoded (PNG/AVIF/BMP/WebP, plus TGA identified via its
 *    file extension) → translucent when any pixel has alpha < 255; JPEG
 *    counts as opaque ("texture-scan")
 * 3. diffuse texture missing or undecodable (SPH/DDS/…) → conservatively
 *    translucent with a "not evaluated" result ("texture-unknown")
 * 4. no diffuse texture declared → opaque ("no-texture")
 */
export async function resolvePmxMaterialTranslucency(
  pmx: PmxTranslucencySourceModel,
  allFiles: readonly File[],
  pmxRelativeDir: string,
): Promise<PmxMaterialTranslucencyResult> {
  const translucentMaterials: boolean[] = [];
  const alphaEvaluateResults: number[] = [];
  const sources: PmxTranslucencySource[] = [];

  // normalized path → scan result (textures shared by several materials are
  // only read and decoded once)
  const scanCache = new Map<string, Promise<boolean | null>>();

  const scanTexture = (texturePath: string): Promise<boolean | null> => {
    const key = normalizeRelativePath(pmxRelativeDir + texturePath);
    const cached = scanCache.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const relativePath = pmxRelativeDir + texturePath;
      const file = findTextureFile(allFiles, relativePath);
      return file ? scanTextureFile(file, relativePath) : null;
    })();
    scanCache.set(key, pending);
    return pending;
  };

  for (const material of pmx.materials) {
    if ((material.diffuse[3] ?? 1) < 1) {
      translucentMaterials.push(true);
      alphaEvaluateResults.push(ALPHA_EVALUATE_ALPHABLEND);
      sources.push("material-alpha");
      continue;
    }

    const textureIndex = material.textureIndex;
    if (
      !Number.isInteger(textureIndex) ||
      textureIndex < 0 ||
      textureIndex >= pmx.textures.length
    ) {
      translucentMaterials.push(false);
      alphaEvaluateResults.push(ALPHA_EVALUATE_OPAQUE);
      sources.push("no-texture");
      continue;
    }

    const scanned = await scanTexture(pmx.textures[textureIndex]);
    if (scanned === null) {
      // A false positive only enables alpha blending on an (almost
      // certainly opaque) texture — visually harmless — while a false
      // negative reproduces the opaque "skin over fishnet" artifact in MMD.
      translucentMaterials.push(true);
      alphaEvaluateResults.push(ALPHA_EVALUATE_NOT_EVALUATED);
      sources.push("texture-unknown");
      continue;
    }

    translucentMaterials.push(scanned);
    alphaEvaluateResults.push(
      scanned ? ALPHA_EVALUATE_ALPHABLEND : ALPHA_EVALUATE_OPAQUE,
    );
    sources.push("texture-scan");
  }

  return { translucentMaterials, alphaEvaluateResults, sources };
}
