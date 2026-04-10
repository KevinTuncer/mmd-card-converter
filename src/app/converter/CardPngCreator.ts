import { convertAudioFileToWebm } from "@/app/converter/AudioToWebmConverter";
import { compressGzip } from "@/app/converter/GzipCodec";
import { convertMotionFileToBvmd } from "@/app/converter/MmdMotionConverter";
import { convertPmxToBpmx } from "@/app/converter/PmxToBpmxConverter";
import { compressImagesToAvif } from "@/app/converter/ImageCompressor";
import type { ConverterWarning } from "@/app/converter/types";
import { getErrorStrings } from "@/i18n/localization";
import packageInfo from "../../../package.json";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const LEGACY_CARD_CHUNK_TYPES = [
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

const NEW_CARD_CHUNK_NAMES: Record<LegacyCardChunkType, string> = {
  bPMX: "bpMx",
  bPMV: "bpMv",
  bVMD: "bvMd",
  webM: "weBm",
  aURL: "auRl",
  eroV: "erOv",
  uInf: "uiNf",
  fBtn: "fbTn",
  moAi: "moAi",
  vcAu: "vcAu",
};

const SUPPORTED_PRIVATE_CHUNK_NAMES = new Set<string>([
  ...LEGACY_CARD_CHUNK_TYPES,
  ...Object.values(NEW_CARD_CHUNK_NAMES),
]);

const COMPRESSIBLE_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "bmp", "webp"]);

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const CARD_VERSION = packageInfo.cardVersion;

type LegacyCardChunkType = (typeof LEGACY_CARD_CHUNK_TYPES)[number];

export type CardCreateCompressionMode = "lossless" | "lossy" | "raw";

export type CardCreatorInputKind =
  | "base-image"
  | "png-image"
  | "pmx"
  | "bpmx"
  | "bpmv"
  | "motion-source"
  | "bvmd"
  | "webm"
  | "audio-source"
  | "audio-url"
  | "metadata-eroV"
  | "metadata-uInf"
  | "metadata-fBtn"
  | "metadata-moAi"
  | "voice-clone-sample"
  | "unknown";

export interface CardPngCreateOptions {
  baseImageFile?: File | null;
  defaultBaseImageBuffer?: ArrayBuffer;
  preferDefaultBaseImage?: boolean;
  compressionMode?: CardCreateCompressionMode;
  forceAvif?: boolean;
  lossyImageTargets?: ReadonlySet<File>;
  onImageProgress?: (done: number, total: number) => void;
  metadataOverrides?: Partial<Record<MetadataChunkType, unknown>>;
  voiceCloneSampleFiles?: File[];
}

export interface CardPreparedImageResult {
  sourcePath: string;
  resultFile: File;
}

export interface CardPngCreateReport {
  inputFiles: string[];
  usedBaseImage: string;
  embeddedChunkTypes: LegacyCardChunkType[];
  convertedFiles: string[];
  preparedImageFiles: CardPreparedImageResult[];
  outputFileName: string;
  warnings: ConverterWarning[];
}

export interface CardPngCreateResult {
  pngBuffer: ArrayBuffer;
  report: CardPngCreateReport;
}

interface ClassifiedCardInputs {
  bpmxFile: File | null;
  pmxFiles: File[];
  bpmvFile: File | null;
  bvmdFile: File | null;
  motionSourceFile: File | null;
  webmFile: File | null;
  audioSourceFile: File | null;
  audioUrlFile: File | null;
  metadataEroVFile: File | null;
  metadataUInfFile: File | null;
  metadataFBtnFile: File | null;
  metadataMoAiFile: File | null;
  voiceCloneSampleFiles: File[];
  baseImageCandidates: File[];
}

interface CardChunkPayload {
  chunkType: LegacyCardChunkType;
  data: Uint8Array;
}

type MetadataChunkType = "uInf" | "fBtn" | "moAi";

interface CardChunkBuildResult {
  chunkPayloads: CardChunkPayload[];
  convertedFiles: string[];
  preparedImageFiles: CardPreparedImageResult[];
}

interface ChosenFile<T extends File | null> {
  file: T;
  warnings: ConverterWarning[];
}

export function getCardCreatorInputKind(file: File): CardCreatorInputKind {
  const path = getFilePath(file);
  const baseName = getBaseName(path).toLowerCase();
  const extension = getFileExt(path);

  if (baseName === "ero.dance.png") return "base-image";
  if (baseName === "metadata.erov.txt") return "metadata-eroV";
  if (baseName === "metadata.uinf.json") return "metadata-uInf";
  if (baseName === "metadata.fbtn.json") return "metadata-fBtn";
  if (baseName === "metadata.moai.json") return "metadata-moAi";
  if (baseName === "audio-url.txt") return "audio-url";

  if (extension === "bpmx") return "bpmx";
  if (extension === "pmx") return "pmx";
  if (extension === "bpmv") return "bpmv";
  if (extension === "bvmd") return "bvmd";
  if (extension === "vmd" || extension === "vpd" || extension === "vmp") {
    return "motion-source";
  }
  if (extension === "webm") {
    // Files from the metadata.voiceSamples/ subfolder (extracted from cards)
    if (path.includes("metadata.voiceSamples/")) return "voice-clone-sample";
    // Legacy naming convention
    if (baseName.startsWith("voice_sample")) return "voice-clone-sample";
    return "webm";
  }
  if (extension === "wav" || extension === "mp3") return "audio-source";
  if (extension === "png") return "png-image";

  return "unknown";
}

export function pickPreferredCardBaseImage(
  files: readonly File[],
): File | null {
  return (
    files.find((file) => getCardCreatorInputKind(file) === "base-image") ?? null
  );
}

export async function createCardPngFromFiles(
  files: readonly File[],
  options: CardPngCreateOptions = {},
): Promise<CardPngCreateResult> {
  const warnings: ConverterWarning[] = [];
  const classified = classifyCardInputs(files, warnings);
  const baseImage = await resolveBaseImage(classified, options, warnings);
  const { chunkPayloads, convertedFiles, preparedImageFiles } =
    await buildCardChunkPayloads(classified, files, options, warnings);
  const pngBuffer = await embedChunksIntoPng(baseImage.buffer, chunkPayloads);
  const outputFileName = deriveCardOutputFileName(
    classified,
    options.baseImageFile ?? baseImage.file,
  );

  return {
    pngBuffer,
    report: {
      inputFiles: files.map((file) => getFilePath(file)),
      usedBaseImage: baseImage.label,
      embeddedChunkTypes: chunkPayloads.map((chunk) => chunk.chunkType),
      convertedFiles,
      preparedImageFiles,
      outputFileName,
      warnings,
    },
  };
}

function classifyCardInputs(
  files: readonly File[],
  warnings: ConverterWarning[],
): ClassifiedCardInputs {
  const pmxFiles = files.filter(
    (file) => getCardCreatorInputKind(file) === "pmx",
  );
  const baseImageCandidates = files.filter(
    (file) => getCardCreatorInputKind(file) === "base-image",
  );

  return {
    bpmxFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "bpmx"),
      "Mehrere BPMX-Dateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    pmxFiles,
    bpmvFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "bpmv"),
      "Mehrere BPMV-Dateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    bvmdFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "bvmd"),
      "Mehrere BVMD-Dateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    motionSourceFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "motion-source"),
      "Mehrere Motion-Quelldateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    webmFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "webm"),
      "Mehrere WebM-Dateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    audioSourceFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "audio-source"),
      "Mehrere Audio-Quelldateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    audioUrlFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "audio-url"),
      "Mehrere Audio-URL-Dateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    metadataEroVFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "metadata-eroV"),
      "Mehrere metadata.eroV.txt-Dateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    metadataUInfFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "metadata-uInf"),
      "Mehrere metadata.uInf.json-Dateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    metadataFBtnFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "metadata-fBtn"),
      "Mehrere metadata.fBtn.json-Dateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    metadataMoAiFile: chooseSingleFile(
      files.filter((file) => getCardCreatorInputKind(file) === "metadata-moAi"),
      "Mehrere metadata.moAi.json-Dateien gefunden. Es wird die erste verwendet.",
      warnings,
    ).file,
    voiceCloneSampleFiles: files.filter(
      (file) => getCardCreatorInputKind(file) === "voice-clone-sample",
    ),
    baseImageCandidates,
  };
}

function chooseSingleFile<T extends File>(
  files: readonly T[],
  warningMessage: string,
  warnings: ConverterWarning[],
): ChosenFile<T | null> {
  if (files.length > 1) {
    warnings.push({ level: "warn", message: warningMessage });
  }
  return { file: files[0] ?? null, warnings };
}

async function resolveBaseImage(
  classified: ClassifiedCardInputs,
  options: CardPngCreateOptions,
  warnings: ConverterWarning[],
): Promise<{
  file: File | null;
  buffer: ArrayBuffer;
  label: string;
}> {
  if (options.preferDefaultBaseImage && options.defaultBaseImageBuffer) {
    return {
      file: null,
      buffer: options.defaultBaseImageBuffer,
      label: "public/eroLogo.png",
    };
  }

  const selectedBaseImage =
    options.baseImageFile ??
    pickPreferredCardBaseImage(classified.baseImageCandidates);

  if (selectedBaseImage) {
    return {
      file: selectedBaseImage,
      buffer: await selectedBaseImage.arrayBuffer(),
      label: getFilePath(selectedBaseImage),
    };
  }

  if (options.defaultBaseImageBuffer) {
    return {
      file: null,
      buffer: options.defaultBaseImageBuffer,
      label: "public/eroLogo.png",
    };
  }

  const response = await fetch(resolveDefaultBaseImageUrl());
  if (!response.ok) {
    throw new Error(getErrorStrings().defaultBaseImageLoadFailed);
  }
  warnings.push({
    level: "info",
    message:
      "Kein eigenes Basisbild gewählt. Es wird public/eroLogo.png verwendet.",
  });
  return {
    file: null,
    buffer: await response.arrayBuffer(),
    label: "public/eroLogo.png",
  };
}

async function buildCardChunkPayloads(
  classified: ClassifiedCardInputs,
  files: readonly File[],
  options: CardPngCreateOptions,
  warnings: ConverterWarning[],
): Promise<CardChunkBuildResult> {
  const chunkPayloads: CardChunkPayload[] = [];
  const convertedFiles: string[] = [];
  let preparedImageFiles: CardPreparedImageResult[] = [];

  if (classified.bpmxFile) {
    chunkPayloads.push({
      chunkType: "bPMX",
      data: await compressCardChunk(
        new Uint8Array(await classified.bpmxFile.arrayBuffer()),
      ),
    });
  } else if (classified.pmxFiles.length > 0) {
    const pmxFile =
      pickDefaultPmx(classified.pmxFiles) ?? classified.pmxFiles[0];
    const pmxPreparation = await preparePmxFilesForCardConversion(
      files,
      options,
    );
    const filesForConversion = pmxPreparation.filesForConversion;
    preparedImageFiles = pmxPreparation.preparedImageFiles;
    const bpmxBuffer = await convertPmxToBpmx(pmxFile, filesForConversion);
    chunkPayloads.push({
      chunkType: "bPMX",
      data: await compressCardChunk(new Uint8Array(bpmxBuffer)),
    });
    convertedFiles.push(
      `${getFilePath(pmxFile)} -> ${stripExt(getBaseName(getFilePath(pmxFile)))}.bpmx`,
    );
  }

  if (classified.bpmvFile) {
    chunkPayloads.push({
      chunkType: "bPMV",
      data: await compressCardChunk(
        new Uint8Array(await classified.bpmvFile.arrayBuffer()),
      ),
    });
  }

  if (classified.bvmdFile) {
    chunkPayloads.push({
      chunkType: "bVMD",
      data: await compressCardChunk(
        new Uint8Array(await classified.bvmdFile.arrayBuffer()),
      ),
    });
  } else if (classified.motionSourceFile) {
    const result = await convertMotionFileToBvmd(classified.motionSourceFile);
    chunkPayloads.push({
      chunkType: "bVMD",
      data: await compressCardChunk(new Uint8Array(result.buffer)),
    });
    convertedFiles.push(
      `${getFilePath(classified.motionSourceFile)} -> ${stripExt(getBaseName(getFilePath(classified.motionSourceFile)))}.bvmd`,
    );
  }

  if (classified.webmFile) {
    chunkPayloads.push({
      chunkType: "webM",
      data: new Uint8Array(await classified.webmFile.arrayBuffer()),
    });
  } else if (classified.audioSourceFile) {
    const result = await convertAudioFileToWebm(classified.audioSourceFile);
    chunkPayloads.push({
      chunkType: "webM",
      data: new Uint8Array(result.buffer),
    });
    convertedFiles.push(
      `${getFilePath(classified.audioSourceFile)} -> ${result.outputFileName}`,
    );
  }

  if (classified.webmFile && classified.audioUrlFile) {
    warnings.push({
      level: "info",
      message:
        "Sowohl WebM als auch audio-url.txt gefunden. Die URL wird zusätzlich eingebettet.",
    });
  }

  if (classified.audioUrlFile) {
    chunkPayloads.push({
      chunkType: "aURL",
      data: new Uint8Array(await classified.audioUrlFile.arrayBuffer()),
    });
  }

  chunkPayloads.push({
    chunkType: "eroV",
    data: textEncoder.encode(CARD_VERSION),
  });

  for (const metadata of [
    ["uInf", classified.metadataUInfFile],
    ["fBtn", classified.metadataFBtnFile],
    ["moAi", classified.metadataMoAiFile],
  ] as const) {
    const [chunkType, file] = metadata;
    const override = options.metadataOverrides?.[chunkType];
    if (!file && override === undefined) continue;

    let bytes: Uint8Array;
    if (override !== undefined) {
      bytes = encodeCanonicalJson(override);
      if (file) {
        warnings.push({
          level: "info",
          message: `${getFilePath(file)} wurde durch editierte ${chunkType}-Metadaten überschrieben.`,
        });
      }
    } else {
      const sourceFile = file;
      if (!sourceFile) continue;
      const rawBytes = new Uint8Array(await sourceFile.arrayBuffer());
      bytes = rawBytes;
      try {
        bytes = canonicalizeJsonBytes(rawBytes);
      } catch {
        warnings.push({
          level: "warn",
          message: `${getFilePath(sourceFile)} enthält kein gültiges JSON. Der Inhalt wird trotzdem eingebettet.`,
        });
      }
    }
    chunkPayloads.push({ chunkType, data: bytes });
  }

  // Voice clone audio samples → vcAu chunk (not gzip-compressed, variable-length encoded)
  let voiceCloneFiles = options.voiceCloneSampleFiles?.length
    ? options.voiceCloneSampleFiles
    : classified.voiceCloneSampleFiles;
  if (voiceCloneFiles.length > 0) {
    // Reorder voice clone files to match moAi voiceSamples[].fileName order
    voiceCloneFiles = await reorderVoiceCloneFilesAsync(
      voiceCloneFiles,
      classified.metadataMoAiFile,
    );
    const audioArrays: Uint8Array[] = [];
    for (const file of voiceCloneFiles) {
      audioArrays.push(new Uint8Array(await file.arrayBuffer()));
    }
    chunkPayloads.push({
      chunkType: "vcAu",
      data: serializeArrayVarLength(audioArrays),
    });
  }

  if (chunkPayloads.length === 0) {
    warnings.push({
      level: "info",
      message:
        "Es wurden keine einbettbaren Card-Daten gefunden. Es wird nur das Basisbild ohne private Chunks gespeichert.",
    });
  }

  if (convertedFiles.length > 0) {
    warnings.push({
      level: "info",
      message: `Vor dem Einbetten konvertiert: ${convertedFiles.join(", ")}`,
    });
  }

  return { chunkPayloads, convertedFiles, preparedImageFiles };
}

async function preparePmxFilesForCardConversion(
  files: readonly File[],
  options: CardPngCreateOptions,
): Promise<{
  filesForConversion: File[];
  preparedImageFiles: CardPreparedImageResult[];
}> {
  const pmxReferenceFiles = collectPmxReferenceFiles(files);
  const compressionMode = options.compressionMode ?? "lossless";
  const preparedImageFiles = pmxReferenceFiles
    .filter((file) =>
      COMPRESSIBLE_IMAGE_EXTS.has(getFileExt(getFilePath(file))),
    )
    .map((file) => ({
      sourcePath: getFilePath(file),
      resultFile: file,
    }));

  if (compressionMode === "raw") {
    return {
      filesForConversion: pmxReferenceFiles,
      preparedImageFiles,
    };
  }

  const compressibleFiles = pmxReferenceFiles.filter((file) =>
    COMPRESSIBLE_IMAGE_EXTS.has(getFileExt(getFilePath(file))),
  );
  const lossyTargets =
    compressionMode === "lossy"
      ? options.lossyImageTargets
        ? new Set<File>(
            compressibleFiles.filter((file) =>
              options.lossyImageTargets?.has(file),
            ),
          )
        : new Set<File>(compressibleFiles)
      : undefined;

  const filesForConversion = await compressImagesToAvif(
    pmxReferenceFiles,
    options.onImageProgress,
    lossyTargets,
    { forceAvif: options.forceAvif ?? false },
  );

  return {
    filesForConversion,
    preparedImageFiles: pmxReferenceFiles.flatMap((file, index) => {
      if (!COMPRESSIBLE_IMAGE_EXTS.has(getFileExt(getFilePath(file)))) {
        return [];
      }

      return [
        {
          sourcePath: getFilePath(file),
          resultFile: filesForConversion[index],
        },
      ];
    }),
  };
}

async function embedChunksIntoPng(
  basePngBuffer: ArrayBuffer,
  chunkPayloads: readonly CardChunkPayload[],
): Promise<ArrayBuffer> {
  const sanitized = stripPrivateCardChunks(new Uint8Array(basePngBuffer));
  const beforeIend = sanitized.subarray(0, sanitized.byteLength - 12);
  const iend = sanitized.subarray(sanitized.byteLength - 12);
  const newChunks = chunkPayloads.map((chunk) =>
    createPngChunk(NEW_CARD_CHUNK_NAMES[chunk.chunkType], chunk.data),
  );
  return toArrayBuffer(concatUint8Arrays([beforeIend, ...newChunks, iend]));
}

function stripPrivateCardChunks(bytes: Uint8Array): Uint8Array {
  assertPngSignature(bytes);

  const keptSegments: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
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

    const chunkType = readChunkType(bytes, offset + 4);
    if (!SUPPORTED_PRIVATE_CHUNK_NAMES.has(chunkType)) {
      keptSegments.push(bytes.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
    if (chunkType === "IEND") {
      reachedIend = true;
      break;
    }
  }

  if (!reachedIend) {
    throw new Error(getErrorStrings().pngIendMissing);
  }

  return concatUint8Arrays(keptSegments);
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.byteLength + 12);
  writeUint32BE(result, 0, data.byteLength);
  for (let index = 0; index < 4; index += 1) {
    result[4 + index] = type.charCodeAt(index);
  }
  result.set(data, 8);
  writeUint32BE(
    result,
    data.byteLength + 8,
    crc32(result.subarray(4, data.byteLength + 8)),
  );
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function deriveCardOutputFileName(
  classified: ClassifiedCardInputs,
  baseImageFile: File | null,
): string {
  const primaryName =
    classified.bpmxFile?.name ??
    classified.pmxFiles[0]?.name ??
    classified.bpmvFile?.name ??
    classified.bvmdFile?.name ??
    classified.motionSourceFile?.name ??
    classified.webmFile?.name ??
    classified.audioSourceFile?.name ??
    baseImageFile?.name ??
    "card";

  const pureName = stripCardLikeSuffix(stripExt(primaryName));
  return `${pureName || "card"}.ero.png`;
}

function stripCardLikeSuffix(name: string): string {
  const parts = name.split(".");
  const suffix = parts[parts.length - 1]?.toLowerCase();
  if (
    suffix === "bpmx" ||
    suffix === "bpmv" ||
    suffix === "bvmd" ||
    suffix === "pmx" ||
    suffix === "vmd" ||
    suffix === "webm" ||
    suffix === "wav" ||
    suffix === "ero"
  ) {
    parts.pop();
  }
  return parts.join(".") || name;
}

function pickDefaultPmx(files: readonly File[]): File | null {
  const sorted = files.slice().sort((left, right) => {
    const leftPath = getFilePath(left);
    const rightPath = getFilePath(right);
    return (
      (leftPath.match(/\//g)?.length ?? 0) -
      (rightPath.match(/\//g)?.length ?? 0)
    );
  });
  return sorted[0] ?? null;
}

function getFilePath(file: File): string {
  return (
    (file as File & { webkitRelativePath?: string }).webkitRelativePath ??
    file.name
  );
}

function getFileExt(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function getBaseName(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] ?? path;
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "card";
}

function collectPmxReferenceFiles(files: readonly File[]): File[] {
  return files
    .filter((file) => {
      switch (getCardCreatorInputKind(file)) {
        case "bpmx":
        case "bpmv":
        case "bvmd":
        case "motion-source":
        case "webm":
        case "audio-source":
        case "audio-url":
        case "metadata-eroV":
        case "metadata-uInf":
        case "metadata-fBtn":
        case "metadata-moAi":
        case "base-image":
        case "voice-clone-sample":
          return false;
        default:
          return true;
      }
    })
    .map((file) => ensureRelativePath(file));
}

async function compressCardChunk(data: Uint8Array): Promise<Uint8Array> {
  return compressGzip(data);
}

function canonicalizeJsonBytes(bytes: Uint8Array): Uint8Array {
  const parsed = JSON.parse(textDecoder.decode(bytes)) as unknown;
  return encodeCanonicalJson(parsed);
}

function encodeCanonicalJson(value: unknown): Uint8Array {
  return new Uint8Array(
    textEncoder.encode(JSON.stringify(value)).buffer.slice(0),
  );
}

function resolveDefaultBaseImageUrl(): string {
  const baseUrl =
    typeof import.meta !== "undefined" && import.meta.env?.BASE_URL
      ? import.meta.env.BASE_URL
      : "/";
  return new URL(`${baseUrl}eroLogo.png`, window.location.href).toString();
}

function ensureRelativePath(file: File): File {
  const normalizedPath = getFilePath(file).replace(/\\/g, "/");
  try {
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: normalizedPath,
    });
  } catch {
    // Ignore environments that disallow redefining this property.
  }
  return file;
}

/**
 * Reorders voice clone sample files to match the order defined in moAi metadata's
 * voiceSamples[].fileName. Files not referenced in metadata are appended at the end.
 */
async function reorderVoiceCloneFilesAsync(
  voiceCloneFiles: readonly File[],
  metadataMoAiFile: File | null,
): Promise<File[]> {
  if (!metadataMoAiFile || voiceCloneFiles.length === 0) {
    return [...voiceCloneFiles];
  }

  try {
    const textDecoder = new TextDecoder();
    const rawBytes = new Uint8Array(await metadataMoAiFile.arrayBuffer());
    const json = JSON.parse(textDecoder.decode(rawBytes));

    const orderedFileNames: string[] =
      (json.voiceSamples as Array<{ fileName: string }>)
        ?.map((s) => s.fileName)
        ?.filter(Boolean) ?? [];

    if (orderedFileNames.length === 0) return [...voiceCloneFiles];

    // Build a map: baseName → File (for quick lookup)
    const fileMap = new Map<string, File>();
    for (const file of voiceCloneFiles) {
      const path = getFilePath(file);
      const baseName = getBaseName(path);
      fileMap.set(baseName, file);
      // Also map by full relative path for subfolder files
      if (path.includes("/")) {
        fileMap.set(path.replace(/\\/g, "/"), file);
      }
    }

    const ordered: File[] = [];
    const used = new Set<File>();

    // First, add files in the moAi metadata order
    for (const fileName of orderedFileNames) {
      // Try exact match first, then baseName match
      let matched = fileMap.get(fileName);
      if (!matched) {
        // Try with metadata.voiceSamples/ prefix
        matched = fileMap.get(`metadata.voiceSamples/${fileName}`);
      }
      if (matched && !used.has(matched)) {
        ordered.push(matched);
        used.add(matched);
      }
    }

    // Then append any remaining files not referenced in metadata
    for (const file of voiceCloneFiles) {
      if (!used.has(file)) {
        ordered.push(file);
      }
    }

    return ordered;
  } catch {
    return [...voiceCloneFiles];
  }
}

/**
 * Serializes an array of Uint8Array into a single byte buffer using
 * variable-length quantity (VLQ) encoding for each element's length prefix.
 * This matches the format used in the main application's imageCard.ts.
 */
function serializeArrayVarLength(items: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];

  for (const item of items) {
    if (item.length === 0) continue;

    // Encode length as a variable-length quantity
    let length = item.length;
    const lengthBuffer: number[] = [];
    while (length > 127) {
      lengthBuffer.push((length & 0x7f) | 0x80);
      length >>= 7;
    }
    lengthBuffer.push(length & 0x7f);
    parts.push(new Uint8Array(lengthBuffer), item);
  }

  if (parts.length === 0) return new Uint8Array(0);

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
    0,
    false,
  );
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(
    0,
    value >>> 0,
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
