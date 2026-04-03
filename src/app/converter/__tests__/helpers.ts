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
