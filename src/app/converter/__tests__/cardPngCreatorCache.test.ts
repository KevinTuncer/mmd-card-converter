// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompressImagesToAvif = vi.fn();

vi.mock("@/app/converter/ImageCompressor", () => ({
  compressImagesToAvif: (...args: unknown[]) =>
    mockCompressImagesToAvif(...args),
  LOSSY_QUALITY: 0.92,
}));

import { createCardPngFromFiles } from "@/app/converter/CardPngCreator";
import { loadBuffer, loadPmxFolder } from "./helpers";

const COMPRESSIBLE_EXTS = new Set(["png", "jpg", "jpeg", "bmp", "webp"]);

function isCompressible(file: File): boolean {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  return COMPRESSIBLE_EXTS.has(ext);
}

function makeConverted(original: File): File {
  // Sentinel result mimicking compressImagesToAvif: same relative name, new
  // bytes, AVIF mime type. webkitRelativePath must be preserved (the PMX
  // loader's reference file resolver requires it, and jsdom defaults it to
  // undefined on freshly created Files).
  const converted = new File(
    [new TextEncoder().encode(`avif:${original.name}:${original.size}`)],
    original.name,
    { type: "image/avif" },
  );
  const relativePath = (original as File & { webkitRelativePath?: string })
    .webkitRelativePath;
  if (relativePath !== undefined && relativePath !== "") {
    Object.defineProperty(converted, "webkitRelativePath", {
      value: relativePath,
      configurable: true,
    });
  }
  return converted;
}

function getFilePath(file: File): string {
  return (
    (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
    file.name
  );
}

/** Mimics the real compressor: converts compressible images, passes the rest through. */
function installCompressorMock(): void {
  mockCompressImagesToAvif.mockImplementation(
    async (
      files: File[],
      onProgress?: (done: number, total: number) => void,
    ) => {
      const compressible = files.filter(isCompressible);
      let done = 0;
      onProgress?.(0, compressible.length);
      const out: File[] = [];
      for (const file of files) {
        if (isCompressible(file)) {
          done += 1;
          onProgress?.(done, compressible.length);
          out.push(makeConverted(file));
        } else {
          out.push(file);
        }
      }
      return out;
    },
  );
}

function loadPmxFixture(): File[] {
  return loadPmxFolder("public/example/TestModelAsPmx").allFiles;
}

describe("createCardPngFromFiles image conversion cache", () => {
  beforeEach(() => {
    mockCompressImagesToAvif.mockReset();
    installCompressorMock();
  });

  it("reports fresh conversions via onImageConverted", async () => {
    const allFiles = loadPmxFixture();
    const converted: Array<[File, File]> = [];

    const result = await createCardPngFromFiles(allFiles, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      compressionMode: "lossless",
      onImageConverted: (source, prepared) => {
        converted.push([source, prepared]);
      },
    });

    const compressibleCount = allFiles.filter(isCompressible).length;
    expect(converted.length).toBe(compressibleCount);
    for (const [source, prepared] of converted) {
      expect(getFilePath(prepared)).toBe(getFilePath(source));
      expect(prepared).not.toBe(source);
    }
    // Report maps every compressible file to its prepared result.
    expect(result.report.preparedImageFiles).toHaveLength(compressibleCount);
  });

  it("reuses cached results on a second build without re-encoding", async () => {
    const allFiles = loadPmxFixture();
    const cacheMap = new Map<File, File>();
    const first = await createCardPngFromFiles(allFiles, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      compressionMode: "lossless",
      onImageConverted: (source, prepared) => cacheMap.set(source, prepared),
    });
    expect(mockCompressImagesToAvif).toHaveBeenCalledTimes(1);

    const second = await createCardPngFromFiles(allFiles, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      compressionMode: "lossless",
      cachedImageConversions: cacheMap,
    });

    // Full cache hit: the compressor was never invoked again.
    expect(mockCompressImagesToAvif).toHaveBeenCalledTimes(1);
    // Same inputs + same prepared files ⇒ byte-identical card PNG.
    expect(new Uint8Array(second.pngBuffer)).toEqual(
      new Uint8Array(first.pngBuffer),
    );
    for (const entry of second.report.preparedImageFiles) {
      const source = allFiles.find(
        (file) => getFilePath(file) === entry.sourcePath,
      );
      expect(source).toBeDefined();
      expect(entry.resultFile).toBe(cacheMap.get(source as File));
    }
  });

  it("re-encodes only files whose conversion parameters changed", async () => {
    const allFiles = loadPmxFixture();
    const compressible = allFiles.filter(isCompressible);
    expect(compressible.length).toBeGreaterThanOrEqual(2);
    const [texA, texB] = compressible;

    // Build 1: texA is a lossy target, texB is encoded losslessly.
    const cacheMap = new Map<File, File>();
    await createCardPngFromFiles(allFiles, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      compressionMode: "lossy",
      lossyImageTargets: new Set([texA]),
      onImageConverted: (source, prepared) => cacheMap.set(source, prepared),
    });
    const texBCached = cacheMap.get(texB);
    expect(texBCached).toBeDefined();

    mockCompressImagesToAvif.mockClear();

    // Build 2: texA is no longer a lossy target → new parameter set; texB unchanged.
    // (The UI layer only serves cache entries whose stored parameters match
    // the current ones — emulate that by handing over every entry except texA.)
    const servedMap = new Map<File, File>();
    for (const [source, prepared] of cacheMap) {
      if (source !== texA) servedMap.set(source, prepared);
    }
    const second = await createCardPngFromFiles(allFiles, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      compressionMode: "lossy",
      lossyImageTargets: new Set([]),
      cachedImageConversions: servedMap,
    });

    expect(mockCompressImagesToAvif).toHaveBeenCalledTimes(1);
    const [subsetFiles, , lossyTargets] = mockCompressImagesToAvif.mock
      .calls[0] as [File[], unknown, Set<File> | undefined];
    // Only texA is (re-)encoded; every other compressible file is cached.
    expect(subsetFiles.filter(isCompressible)).toEqual([texA]);
    // texA left the lossy target set → it must not be encoded lossily again.
    expect(lossyTargets?.has(texA) ?? false).toBe(false);

    // texB still comes from the cache, texA was freshly prepared.
    const preparedBySource = new Map(
      second.report.preparedImageFiles.map((entry) => [
        entry.sourcePath,
        entry.resultFile,
      ]),
    );
    expect(preparedBySource.get(getFilePath(texB))).toBe(texBCached);
    expect(preparedBySource.get(getFilePath(texA))).not.toBe(
      cacheMap.get(texA),
    );
  });

  it("ignores the cache in raw mode", async () => {
    const allFiles = loadPmxFixture();
    const cacheMap = new Map<File, File>();
    for (const file of allFiles) {
      if (isCompressible(file)) cacheMap.set(file, makeConverted(file));
    }

    const result = await createCardPngFromFiles(allFiles, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      compressionMode: "raw",
      cachedImageConversions: cacheMap,
    });

    expect(mockCompressImagesToAvif).not.toHaveBeenCalled();
    for (const entry of result.report.preparedImageFiles) {
      const source = allFiles.find(
        (file) => getFilePath(file) === entry.sourcePath,
      );
      expect(entry.resultFile).toBe(source);
    }
  });

  it("compresses every reference file when no cache is provided", async () => {
    const allFiles = loadPmxFixture();

    await createCardPngFromFiles(allFiles, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      compressionMode: "lossless",
    });

    expect(mockCompressImagesToAvif).toHaveBeenCalledTimes(1);
    const [subsetFiles] = mockCompressImagesToAvif.mock.calls[0] as [File[]];
    expect(subsetFiles.length).toBe(allFiles.length);
  });
});
