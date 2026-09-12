import { PmxObject } from "babylon-mmd";
import { unzipSync } from "fflate";
import { convertBpmxToPmx } from "@/app/converter/BpmxToPmxConverter";
import { convertBvmdFileToLegacyVmdFiles } from "@/app/converter/MmdMotionConverter";
import { buildZipFromFiles } from "@/app/converter/ZipBuilder";
import { decompressGzip } from "@/app/converter/GzipCodec";
import type { ConverterWarning } from "@/app/converter/types";
import { getErrorStrings } from "@/i18n/localization";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CARD_CHUNK_TYPES = [
  "bPMX",
  "bPMV",
  "bVMD",
  "webM",
  "aURL",
  "eroV",
  "uInf",
  "fBtn",
  "moAi",
  "vcAu",
] as const;

const RENAMED_CARD_CHUNK_TYPES = [
  "bpMx",
  "bpMv",
  "bvMd",
  "weBm",
  "auRl",
  "erOv",
  "uiNf",
  "fbTn",
  "moAi",
  "vcAu",
] as const;

const textDecoder = new TextDecoder();

export type CardPngChunkType = (typeof CARD_CHUNK_TYPES)[number];
type SupportedCardChunkType =
  | CardPngChunkType
  | (typeof RENAMED_CARD_CHUNK_TYPES)[number];

const SUPPORTED_CARD_CHUNK_TO_CANONICAL: Record<
  SupportedCardChunkType,
  CardPngChunkType
> = {
  bPMX: "bPMX",
  bPMV: "bPMV",
  bVMD: "bVMD",
  webM: "webM",
  aURL: "aURL",
  eroV: "eroV",
  uInf: "uInf",
  fBtn: "fBtn",
  moAi: "moAi",
  bpMx: "bPMX",
  bpMv: "bPMV",
  bvMd: "bVMD",
  weBm: "webM",
  auRl: "aURL",
  erOv: "eroV",
  uiNf: "uInf",
  fbTn: "fBtn",
  vcAu: "vcAu",
};

const SUPPORTED_CARD_CHUNK_TYPE_SET = new Set<string>([
  ...CARD_CHUNK_TYPES,
  ...RENAMED_CARD_CHUNK_TYPES,
]);

export interface CardPngExportFile {
  fileName: string;
  mime: string;
  data: ArrayBuffer;
  sourceChunk: CardPngChunkType | "image";
}

export interface CardPngExtractionReport {
  foundChunkTypes: CardPngChunkType[];
  exportedFiles: string[];
  sanitizedImageBytes: number;
  warnings: ConverterWarning[];
}

export interface CardPngExtractionResult {
  zipBuffer: ArrayBuffer;
  files: CardPngExportFile[];
  report: CardPngExtractionReport;
}

export interface CardPngExtractionOptions {
  convertToLegacyMmdFiles?: boolean;
  encoding?: PmxObject.Header.Encoding;
  restoreOriginalImageFormats?: boolean;
  onImageProgress?: (done: number, total: number) => void;
}

interface ParsedChunk {
  type: CardPngChunkType;
  data: Uint8Array;
}

export async function extractCardPngToZip(
  pngFile: File,
  options: CardPngExtractionOptions = {},
): Promise<CardPngExtractionResult> {
  const bytes = new Uint8Array(await pngFile.arrayBuffer());
  const warnings: ConverterWarning[] = [];
  const { cardChunks, sanitizedPng } = parseCardPng(bytes);

  const exportFiles = await buildExportFiles(
    pngFile.name,
    sanitizedPng,
    cardChunks,
    warnings,
    options,
  );
  const zipBuffer = buildFilesZip(exportFiles);

  return {
    zipBuffer,
    files: exportFiles,
    report: {
      foundChunkTypes: cardChunks.map((chunk) => chunk.type),
      exportedFiles: exportFiles.map((file) => file.fileName),
      sanitizedImageBytes: sanitizedPng.byteLength,
      warnings,
    },
  };
}

function parseCardPng(bytes: Uint8Array): {
  cardChunks: ParsedChunk[];
  sanitizedPng: ArrayBuffer;
} {
  assertPngSignature(bytes);

  const keptSegments: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
  const cardChunks: ParsedChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  let reachedIend = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error(getErrorStrings().pngIncomplete);
    }

    const length = readUint32BE(bytes, offset);
    const chunkTotalLength = length + 12;
    const chunkEnd = offset + chunkTotalLength;
    if (chunkEnd > bytes.length) {
      throw new Error(getErrorStrings().pngChunkTruncated);
    }

    const type = readChunkType(bytes, offset + 4);
    const data = bytes.subarray(offset + 8, offset + 8 + length);

    if (isSupportedCardChunkType(type)) {
      cardChunks.push({
        type: normalizeCardChunkType(type),
        data: copyUint8Array(data),
      });
    } else {
      keptSegments.push(bytes.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
    if (type === "IEND") {
      reachedIend = true;
      break;
    }
  }

  if (!reachedIend) {
    throw new Error(getErrorStrings().pngIendMissing);
  }

  return {
    cardChunks,
    sanitizedPng: toArrayBuffer(concatUint8Arrays(keptSegments)),
  };
}

async function buildExportFiles(
  sourceName: string,
  sanitizedPng: ArrayBuffer,
  cardChunks: ParsedChunk[],
  warnings: ConverterWarning[],
  options: CardPngExtractionOptions,
): Promise<CardPngExportFile[]> {
  const files: CardPngExportFile[] = [
    {
      fileName: "ero.dance.png",
      mime: "image/png",
      data: sanitizedPng,
      sourceChunk: "image",
    },
  ];
  const usedFileNames = new Set<string>(["ero.dance.png"]);
  const baseName = getCardBaseName(sourceName);
  const effectiveChunks = getEffectiveChunks(cardChunks, warnings);

  // Pre-parse moAi chunk to extract voiceSamples metadata for vcAu file naming
  let voiceSampleMetadata: Array<{ fileName?: string; sampleName?: string }> =
    [];
  const moAiChunk = effectiveChunks.find((c) => c.type === "moAi");
  if (moAiChunk) {
    try {
      const moAiObj = JSON.parse(textDecoder.decode(moAiChunk.data)) as Record<
        string,
        unknown
      >;
      if (Array.isArray(moAiObj.voiceSamples)) {
        voiceSampleMetadata = moAiObj.voiceSamples as Array<{
          fileName?: string;
          sampleName?: string;
        }>;
      }
    } catch {
      // ignore parse errors – vcAu will use fallback naming
    }
  }

  for (const chunk of effectiveChunks) {
    try {
      const entries = await mapChunkToFiles(
        chunk,
        baseName,
        options,
        voiceSampleMetadata,
      );
      if (entries.length === 0) {
        continue;
      }
      for (const entry of entries) {
        entry.fileName = ensureUniqueFileName(entry.fileName, usedFileNames);
        usedFileNames.add(entry.fileName);
        files.push(entry);
      }
    } catch (error) {
      warnings.push({
        level: "warn",
        message: `${chunk.type} konnte nicht extrahiert werden: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (cardChunks.length === 0) {
    warnings.push({
      level: "info",
      message: getErrorStrings().cardNoKnownChunks,
    });
  }

  return files;
}

function getEffectiveChunks(
  cardChunks: readonly ParsedChunk[],
  warnings: ConverterWarning[],
): ParsedChunk[] {
  const latestByType = new Map<CardPngChunkType, ParsedChunk>();
  const duplicateCounts = new Map<CardPngChunkType, number>();

  for (const chunk of cardChunks) {
    latestByType.set(chunk.type, chunk);
    duplicateCounts.set(chunk.type, (duplicateCounts.get(chunk.type) ?? 0) + 1);
  }

  for (const chunkType of CARD_CHUNK_TYPES) {
    const count = duplicateCounts.get(chunkType) ?? 0;
    if (count > 1) {
      warnings.push({
        level: "info",
        message: `${chunkType} war ${count} mal vorhanden. Exportiert wurde der letzte Eintrag.`,
      });
    }
  }

  return cardChunks.filter((chunk, index) => {
    const effectiveChunk = latestByType.get(chunk.type);
    if (!effectiveChunk) {
      return false;
    }
    const lastIndex = cardChunks.lastIndexOf(effectiveChunk);
    return index === lastIndex;
  });
}

async function mapChunkToFiles(
  chunk: ParsedChunk,
  baseName: string,
  options: CardPngExtractionOptions,
  voiceSampleMetadata: Array<{ fileName?: string; sampleName?: string }> = [],
): Promise<CardPngExportFile[]> {
  switch (chunk.type) {
    case "bPMX":
      return options.convertToLegacyMmdFiles
        ? await convertBpmxChunkToLegacyFiles(chunk, baseName, options)
        : [
            {
              fileName: `${baseName}.bpmx`,
              mime: "application/octet-stream",
              data: toArrayBuffer(await decompressGzip(chunk.data)),
              sourceChunk: chunk.type,
            },
          ];
    case "bPMV":
      return [
        {
          fileName: `${baseName}.bpmv`,
          mime: "application/octet-stream",
          data: toArrayBuffer(await decompressGzip(chunk.data)),
          sourceChunk: chunk.type,
        },
      ];
    case "bVMD":
      return options.convertToLegacyMmdFiles
        ? await convertBvmdChunkToLegacyFiles(chunk, baseName)
        : [
            {
              fileName: `${baseName}.bvmd`,
              mime: "application/octet-stream",
              data: toArrayBuffer(await decompressGzip(chunk.data)),
              sourceChunk: chunk.type,
            },
          ];
    case "webM":
      return [
        {
          fileName: `${baseName}.webm`,
          mime: "video/webm",
          data: toArrayBuffer(chunk.data),
          sourceChunk: chunk.type,
        },
      ];
    case "aURL":
      return [
        {
          fileName: "audio-url.txt",
          mime: "text/plain;charset=utf-8",
          data: encodeText(textDecoder.decode(chunk.data)),
          sourceChunk: chunk.type,
        },
      ];
    case "eroV":
      return [
        {
          fileName: "metadata.eroV.txt",
          mime: "text/plain;charset=utf-8",
          data: encodeText(textDecoder.decode(chunk.data)),
          sourceChunk: chunk.type,
        },
      ];
    case "uInf":
      return [buildJsonFile(chunk, "metadata.uInf.json")];
    case "fBtn":
      return [buildJsonFile(chunk, "metadata.fBtn.json")];
    case "moAi":
      return [buildJsonFile(chunk, "metadata.moAi.json")];
    case "vcAu": {
      const parts = deserializeArrayVarLength(chunk.data);
      return parts.map((part, index) => {
        const metaFileName = voiceSampleMetadata[index]?.fileName;
        const fileName =
          metaFileName && metaFileName.length > 0
            ? metaFileName
            : `voice_sample_${index}.webm`;
        return {
          fileName: `metadata.voiceSamples/${fileName}`,
          mime: "video/webm",
          data: toArrayBuffer(part),
          sourceChunk: chunk.type,
        };
      });
    }
    default:
      return [];
  }
}

async function convertBpmxChunkToLegacyFiles(
  chunk: ParsedChunk,
  baseName: string,
  options: CardPngExtractionOptions,
): Promise<CardPngExportFile[]> {
  const bpmxBuffer = toArrayBuffer(await decompressGzip(chunk.data));
  const result = await convertBpmxToPmx(bpmxBuffer, {
    encoding: options.encoding ?? PmxObject.Header.Encoding.Utf8,
    restoreOriginalImageFormats: options.restoreOriginalImageFormats ?? true,
    onImageProgress: options.onImageProgress,
  });
  const zipEntries = unzipSync(new Uint8Array(result.zipBuffer));

  return Object.entries(zipEntries).map(([fileName, data]) => ({
    fileName: normalizeLegacyZipEntryName(fileName, baseName),
    mime: guessMimeType(fileName),
    data: toArrayBuffer(data),
    sourceChunk: chunk.type,
  }));
}

async function convertBvmdChunkToLegacyFiles(
  chunk: ParsedChunk,
  baseName: string,
): Promise<CardPngExportFile[]> {
  const bvmdBuffer = toArrayBuffer(await decompressGzip(chunk.data));
  const bvmdFile = new File([bvmdBuffer], `${baseName}.bvmd`, {
    type: "application/octet-stream",
  });
  const result = await convertBvmdFileToLegacyVmdFiles(bvmdFile);
  const files: CardPngExportFile[] = [
    {
      fileName: result.modelVmd.fileName,
      mime: "application/octet-stream",
      data: result.modelVmd.buffer,
      sourceChunk: chunk.type,
    },
  ];
  if (result.cameraVmd) {
    files.push({
      fileName: result.cameraVmd.fileName,
      mime: "application/octet-stream",
      data: result.cameraVmd.buffer,
      sourceChunk: chunk.type,
    });
  }
  return files;
}

function buildJsonFile(
  chunk: ParsedChunk,
  fileName: string,
): CardPngExportFile {
  const decoded = textDecoder.decode(chunk.data);
  const parsed = JSON.parse(decoded) as unknown;
  return {
    fileName,
    mime: "application/json;charset=utf-8",
    data: encodeText(JSON.stringify(parsed)),
    sourceChunk: chunk.type,
  };
}

function buildFilesZip(files: readonly CardPngExportFile[]): ArrayBuffer {
  return buildZipFromFiles(
    files.map((file) => ({ fileName: file.fileName, data: file.data })),
  );
}

function normalizeLegacyZipEntryName(
  fileName: string,
  baseName: string,
): string {
  const normalized = fileName.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : `${baseName}.pmx`;
}

function guessMimeType(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    case "tga":
      return "image/x-tga";
    case "dds":
      return "image/x-dds";
    case "webm":
      return "video/webm";
    case "json":
      return "application/json;charset=utf-8";
    case "txt":
      return "text/plain;charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function assertPngSignature(bytes: Uint8Array): void {
  if (bytes.byteLength < PNG_SIGNATURE.length) {
    throw new Error(getErrorStrings().pngTooSmall);
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error(getErrorStrings().pngInvalidSignature);
    }
  }
}

function isSupportedCardChunkType(
  value: string,
): value is SupportedCardChunkType {
  return SUPPORTED_CARD_CHUNK_TYPE_SET.has(value);
}

function normalizeCardChunkType(
  value: SupportedCardChunkType,
): CardPngChunkType {
  return SUPPORTED_CARD_CHUNK_TO_CANONICAL[value];
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
    0,
    false,
  );
}

function readChunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function copyUint8Array(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function encodeText(value: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(value));
}

function getCardBaseName(name: string): string {
  const sanitized = name.replace(/[\\/:?<>"|]/g, "_");
  const segments = sanitized.split(".");
  if (segments.length === 1) {
    return sanitized || "card";
  }

  const extension = segments.pop()?.toLowerCase();
  if (extension !== "png") {
    return sanitized;
  }

  const suffix = segments[segments.length - 1]?.toLowerCase();
  if (
    suffix === "bpmx" ||
    suffix === "bpmv" ||
    suffix === "bvmd" ||
    suffix === "webm" ||
    suffix === "wav" ||
    suffix === "ero"
  ) {
    segments.pop();
  }

  return segments.join(".") || "card";
}

function ensureUniqueFileName(
  name: string,
  usedNames: ReadonlySet<string>,
): string {
  if (!usedNames.has(name)) {
    return name;
  }

  const dotIndex = name.lastIndexOf(".");
  const stem = dotIndex === -1 ? name : name.slice(0, dotIndex);
  const extension = dotIndex === -1 ? "" : name.slice(dotIndex);
  let suffix = 2;
  let nextName = `${stem}-${suffix}${extension}`;
  while (usedNames.has(nextName)) {
    suffix += 1;
    nextName = `${stem}-${suffix}${extension}`;
  }
  return nextName;
}

/**
 * Deserializes a variable-length encoded array from a single byte buffer.
 * Each element is prefixed with a variable-length quantity (VLQ) encoding its byte length.
 * Ported from the main application's imageCard.ts serialization format.
 */
function deserializeArrayVarLength(data: Uint8Array): Uint8Array[] {
  const results: Uint8Array[] = [];
  let index = 0;

  while (index < data.length) {
    // Decode variable-length quantity
    let length = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = data[index++];
      length |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte >= 128);

    const content = new Uint8Array(
      data.buffer,
      data.byteOffset + index,
      length,
    );
    results.push(content);
    index += length;
  }

  return results;
}
