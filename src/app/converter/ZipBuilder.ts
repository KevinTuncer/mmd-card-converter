import { zipSync, type Zippable } from "fflate";
import type { BpmxObject } from "babylon-mmd";

/**
 * Assembles a ZIP archive that mirrors the original PMX folder structure:
 *   {pmxFileName}
 *   {image.relativePath}   <- for every embedded image
 *
 * @param pmxBuffer   Serialized PMX binary
 * @param pmxFileName File name for the PMX entry inside the ZIP (e.g. "Ai.pmx")
 * @param images      Embedded images from BpmxObject
 */
export function buildOutputZip(
  pmxBuffer: ArrayBuffer,
  pmxFileName: string,
  images: readonly BpmxObject.Image[],
): ArrayBuffer {
  const files: Zippable = {};

  // Add the PMX file at the root
  files[pmxFileName] = [new Uint8Array(pmxBuffer), { level: 0 }];

  // Add every embedded image at its original relative path
  for (const image of images) {
    const safePath = image.relativePath.replace(/\\/g, "/");
    files[safePath] = [new Uint8Array(image.data), { level: 0 }];
  }

  const zipped = zipSync(files);
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}

export interface ZipEntry {
  fileName: string;
  data: ArrayBuffer;
}

/**
 * Assembles a flat ZIP archive from named buffers (store level 0, mirroring
 * buildOutputZip).
 */
export function buildZipFromFiles(files: readonly ZipEntry[]): ArrayBuffer {
  const entries: Zippable = {};
  for (const file of files) {
    entries[file.fileName] = [new Uint8Array(file.data), { level: 0 }];
  }
  const zipped = zipSync(entries);
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}
