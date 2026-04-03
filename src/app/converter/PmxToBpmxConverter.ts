import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";

// Side-effect imports required to register loader plugin and texture loaders
import "@babylonjs/core/Materials/Textures/Loaders/ddsTextureLoader";
import "@babylonjs/core/Materials/Textures/Loaders/tgaTextureLoader";

import {
  BpmxConverter,
  MmdStandardMaterialBuilder,
  PmxLoader,
} from "babylon-mmd";
import type { MmdMesh } from "babylon-mmd/esm/Runtime/mmdMesh";

export interface PmxToBpmxOptions {
  buildSkeleton?: boolean;
  buildMorph?: boolean;
}

/**
 * Converts a PMX file (plus its texture files) to BPMX format using
 * babylon-mmd's BpmxConverter in a headless NullEngine scene.
 *
 * @param pmxFile  The .pmx File object (must have `webkitRelativePath` or match a path in allFiles)
 * @param allFiles All files in the model folder (PMX + textures + etc.)
 * @param options  Conversion options
 */
export async function convertPmxToBpmx(
  pmxFile: File,
  allFiles: File[],
  options: PmxToBpmxOptions = {},
): Promise<ArrayBuffer> {
  const { buildSkeleton = true, buildMorph = true } = options;

  // Derive rootUrl from the PMX file's relative path so texture lookups resolve correctly
  const relativePath =
    (pmxFile as File & { webkitRelativePath?: string }).webkitRelativePath ??
    pmxFile.name;
  const rootUrl = relativePath.includes("/")
    ? relativePath.substring(0, relativePath.lastIndexOf("/") + 1)
    : "";

  const materialBuilder = new MmdStandardMaterialBuilder();
  // Keep raw texture buffers in memory so BpmxConverter can re-embed them
  materialBuilder.deleteTextureBufferAfterLoad = false;

  const engine = new NullEngine();
  const scene = new Scene(engine);

  try {
    const container = await LoadAssetContainerAsync(pmxFile, scene, {
      rootUrl,
      pluginOptions: {
        mmdmodel: {
          materialBuilder,
          buildSkeleton,
          buildMorph,
          boundingBoxMargin: 0,
          preserveSerializationData: true,
          referenceFiles: allFiles,
          loggingEnabled: false,
        },
      },
    });

    container.addAllToScene();

    const mmdMesh = container.meshes[0] as MmdMesh;

    const converter = new BpmxConverter();
    return converter.convert(mmdMesh, {
      includeSkinningData: buildSkeleton,
      includeMorphData: buildMorph,
    });
  } finally {
    scene.dispose();
    engine.dispose();
  }
}

/** Check if PmxLoader is already registered; if not, register it. */
export function ensurePmxLoaderRegistered(): void {
  // Importing PmxLoader causes its metadata to register automatically via
  // ISceneLoaderPluginFactory. We just need the import side-effect.
  void PmxLoader;
}
