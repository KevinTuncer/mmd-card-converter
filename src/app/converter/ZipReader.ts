import { unzipSync } from "fflate";

export interface ZipContents {
  /** The .pmx file found inside the ZIP */
  pmxFile: File;
  /** All files from the ZIP (including the PMx and all textures) as File objects */
  allFiles: File[];
}

export function readZipFiles(zipBuffer: ArrayBuffer): File[] {
  const entries = unzipSync(new Uint8Array(zipBuffer));

  const allFiles: File[] = [];

  for (const [entryPath, data] of Object.entries(entries)) {
    if (entryPath.endsWith("/") || data.length === 0) continue;

    const normalizedPath = entryPath.replace(/\\/g, "/");
    const file = new File([toArrayBuffer(data)], normalizedPath, {
      type: guessMimeType(normalizedPath),
    });
    try {
      Object.defineProperty(file, "webkitRelativePath", {
        configurable: true,
        enumerable: true,
        writable: false,
        value: normalizedPath,
      });
    } catch {
      // Silently ignore if the environment does not allow redefining this property.
    }
    allFiles.push(file);
  }

  return allFiles;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Extracts a ZIP archive into File objects, reconstructing paths as filenames.
 * The .pmx entry closest to the ZIP root (shortest path) is returned as `pmxFile`.
 */
export function readZip(zipBuffer: ArrayBuffer): ZipContents {
  const allFiles = readZipFiles(zipBuffer);
  const pmxEntries: { path: string; file: File }[] = [];

  for (const file of allFiles) {
    const normalizedPath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ??
      file.name;
    if (normalizedPath.toLowerCase().endsWith(".pmx")) {
      pmxEntries.push({ path: normalizedPath, file });
    }
  }

  if (pmxEntries.length === 0) {
    throw new Error("Keine .pmx-Datei im ZIP gefunden.");
  }

  // Pick the PMX with the shallowest path (fewest slashes) — that's the root model
  pmxEntries.sort(
    (a, b) =>
      (a.path.match(/\//g)?.length ?? 0) - (b.path.match(/\//g)?.length ?? 0),
  );

  return { pmxFile: pmxEntries[0].file, allFiles };
}

function guessMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    bmp: "image/bmp",
    tga: "image/x-tga",
    spa: "application/octet-stream",
    sph: "application/octet-stream",
    pmx: "application/octet-stream",
    pmd: "application/octet-stream",
  };
  return map[ext] ?? "application/octet-stream";
}
