import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** Read any file relative to the project root and return its contents as an ArrayBuffer. */
export function loadBuffer(relFromRoot: string): ArrayBuffer {
  const absPath = path.resolve(PROJECT_ROOT, relFromRoot);
  const buf = fs.readFileSync(absPath);
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/** Guess a MIME type from a file extension. */
function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pmx: "application/octet-stream",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    bmp: "image/bmp",
    tga: "image/x-tga",
    spa: "application/octet-stream",
    sph: "application/octet-stream",
    dds: "image/x-dds",
  };
  return map[ext] ?? "application/octet-stream";
}

export interface PmxFolderContents {
  pmxFile: File;
  allFiles: File[];
}

export interface TgaFixtureOptions {
  width: number;
  height: number;
  pixelDepth: number;
  imageType: number;
  /** TGA image descriptor byte (row origin, alpha depth bits). */
  descriptor?: number;
  /** Optional image ID field content. */
  id?: readonly number[];
  colorMap?: {
    firstIndex: number;
    entrySize: number;
    /** Raw color map bytes (entrySize/8 bytes per entry). */
    entryBytes: readonly number[];
  };
  /** Raw pixel data bytes in storage order. */
  pixelBytes: readonly number[];
}

/**
 * Builds a synthetic TGA binary (header + id + color map + pixel data) for
 * decoder and transparency-scanner tests.
 */
export function makeTgaBuffer(options: TgaFixtureOptions): ArrayBuffer {
  const idLength = options.id?.length ?? 0;
  const colorMap = options.colorMap;
  const header = new Uint8Array(18);
  const view = new DataView(header.buffer);
  header[0] = idLength;
  header[1] = colorMap ? 1 : 0;
  header[2] = options.imageType;
  if (colorMap) {
    view.setUint16(3, colorMap.firstIndex, true);
    view.setUint16(
      5,
      colorMap.entryBytes.length / (colorMap.entrySize / 8),
      true,
    );
    header[7] = colorMap.entrySize;
  }
  view.setUint16(12, options.width, true);
  view.setUint16(14, options.height, true);
  header[16] = options.pixelDepth;
  header[17] = options.descriptor ?? 0;

  const idBytes = options.id ?? [];
  const colorMapBytes = colorMap?.entryBytes ?? [];
  const total =
    18 + idLength + colorMapBytes.length + options.pixelBytes.length;
  const bytes = new Uint8Array(total);
  bytes.set(header, 0);
  bytes.set(idBytes, 18);
  bytes.set(colorMapBytes, 18 + idLength);
  bytes.set(options.pixelBytes, 18 + idLength + colorMapBytes.length);
  return bytes.buffer as ArrayBuffer;
}

/**
 * Recursively reads a PMX model folder from disk and returns:
 *  - `pmxFile`: the .pmx File, with `name` set to its path relative to the folder root
 *  - `allFiles`: every file in the folder tree as a File with name = relative path from folder root
 *
 * @param folderRelPath  Path to the model folder, relative to the project root
 */
export function loadPmxFolder(folderRelPath: string): PmxFolderContents {
  const absFolder = path.resolve(PROJECT_ROOT, folderRelPath);

  const allFiles: File[] = [];
  let pmxFile: File | null = null;

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      const absEntry = path.join(dir, entry);
      const stat = fs.statSync(absEntry);
      if (stat.isDirectory()) {
        walk(absEntry);
      } else {
        const relPath = path.relative(absFolder, absEntry).replace(/\\/g, "/");
        const buf = fs.readFileSync(absEntry);
        const arrayBuffer = buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer;
        const file = new File([arrayBuffer], relPath, {
          type: guessMime(relPath),
        });
        // jsdom/Node.js File objects have webkitRelativePath as undefined (not "").
        // babylon-mmd's ReferenceFileResolver calls PathNormalize(file.webkitRelativePath)
        // which crashes if the value is undefined. Set it explicitly.
        Object.defineProperty(file, "webkitRelativePath", {
          configurable: true,
          enumerable: true,
          writable: false,
          value: relPath,
        });
        allFiles.push(file);
        if (relPath.toLowerCase().endsWith(".pmx") && pmxFile === null) {
          pmxFile = file;
        }
      }
    }
  }

  walk(absFolder);

  if (pmxFile === null) {
    throw new Error(`No .pmx file found in folder: ${absFolder}`);
  }

  return { pmxFile, allFiles };
}
