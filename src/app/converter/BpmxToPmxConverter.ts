import { PmxObject } from "babylon-mmd";
import { parseBpmx } from "@/app/converter/BpmxReaderAdapter";
import { restoreImagesToNamedFormats } from "@/app/converter/ImageFormatRestorer";
import { resolveMaterialTranslucency } from "@/app/converter/MaterialTransparencyResolver";
import { mapBpmxToPmxObject } from "@/app/converter/ReverseMappingRules";
import { serializePmx } from "@/app/converter/PmxSerializer";
import { buildOutputZip } from "@/app/converter/ZipBuilder";
import type { ConversionResult, ConvertOptions } from "@/app/converter/types";

/** Derive a safe filesystem name from the PMX model name header. */
function modelNameToFileName(modelName: string): string {
  const trimmed = modelName.trim().replace(/[\\/:*?"<>|]/g, "_");
  return trimmed.length > 0 ? `${trimmed}.pmx` : "model.pmx";
}

export async function convertBpmxToPmx(
  fileBuffer: ArrayBuffer,
  options: ConvertOptions = {},
): Promise<ConversionResult> {
  const bpmx = await parseBpmx(fileBuffer);
  const encoding = options.encoding ?? PmxObject.Header.Encoding.Utf8;
  const restoreOriginalImageFormats =
    options.restoreOriginalImageFormats ?? true;

  // Detect per-material translucency (diffuse texture alpha scan with an
  // evaluatedTransparency fallback) so the generated PMX enables alpha
  // blending where MMD requires it (MMD only honors texture alpha when the
  // material diffuse alpha is < 1).
  const { translucency, sources } = await resolveMaterialTranslucency(bpmx);

  const { pmx, report } = mapBpmxToPmxObject(bpmx, encoding, {
    materialTranslucency: translucency,
    materialTranslucencySources: sources,
  });
  const pmxBuffer = serializePmx(pmx);
  const outputImages = restoreOriginalImageFormats
    ? await restoreImagesToNamedFormats(
        bpmx.images,
        true,
        options.onImageProgress,
      )
    : bpmx.images;

  const pmxFileName = modelNameToFileName(bpmx.header.modelName);
  const zipBuffer = buildOutputZip(pmxBuffer, pmxFileName, outputImages);

  return {
    pmx,
    pmxBuffer,
    zipBuffer,
    report,
  };
}
