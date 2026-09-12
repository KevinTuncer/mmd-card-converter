import { PmxObject, PmxReader } from "babylon-mmd";
import { type AppTheme } from "@/app/theme";
import { convertBpmxToPmx } from "@/app/converter/BpmxToPmxConverter";
import { parseBpmx } from "@/app/converter/BpmxReaderAdapter";
import {
  convertBvmdFileToLegacyVmdFiles,
  convertMotionFileToBvmd,
  type MotionSummary,
} from "@/app/converter/MmdMotionConverter";
import { convertPmxToBpmx } from "@/app/converter/PmxToBpmxConverter";
import { readZip, readZipFiles } from "@/app/converter/ZipReader";
import { buildZipFromFiles } from "@/app/converter/ZipBuilder";
import {
  compressImagesToAvif,
  LOSSY_QUALITY,
} from "@/app/converter/ImageCompressor";
import {
  convertAudioFileToWebm,
  getAudioToWebmSupport,
  type AudioConversionSummary,
} from "@/app/converter/AudioToWebmConverter";
import {
  createCardPngFromFiles,
  getCardCreatorInputKind,
  pickPreferredCardBaseImage,
} from "@/app/converter/CardPngCreator";
import {
  computeCardMetadataEntryStates,
  type CardMetadataEntryState,
  finalizeCardMetadataEntries,
  hasCardMetadataFilterableEntries,
} from "@/app/converter/CardMetadataMerge";
import { extractCardPngToZip } from "@/app/converter/CardPngExtractor";
import {
  LOCALE_LABELS,
  getErrorStrings,
  getViewStrings,
  normalizeLocale,
  type AppLocale,
} from "@/i18n/localization";

// ── helpers ──────────────────────────────────────────────────────────────────

function downloadAs(data: ArrayBuffer, fileName: string, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "model";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(values[key] ?? `{${key}}`),
  );
}

function getDefaultCardBaseImageUrl(): string {
  return new URL(
    `${import.meta.env.BASE_URL}eroLogo.png`,
    window.location.href,
  ).toString();
}

const COMPRESSIBLE_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "bmp", "webp"]);

function getFileExt(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function renderWarnings(
  target: HTMLElement,
  warnings: { level: string; message: string }[],
  emptyMessage: string,
): void {
  if (warnings.length === 0) {
    target.textContent = emptyMessage;
    return;
  }
  target.textContent = warnings
    .map((w) => `- [${w.level.toUpperCase()}] ${w.message}`)
    .join("\n");
}

function renderMotionSummary(
  target: HTMLElement,
  summary: MotionSummary,
): void {
  target.textContent = JSON.stringify(summary, null, 2);
}

function renderAudioSummary(
  target: HTMLElement,
  summary: AudioConversionSummary,
): void {
  target.textContent = JSON.stringify(summary, null, 2);
}

function renderCardExtractSummary(
  target: HTMLElement,
  summary: {
    foundChunkTypes: string[];
    exportedFiles: string[];
    sanitizedImageBytes: number;
    warnings: { level: string; message: string }[];
  },
): void {
  target.textContent = JSON.stringify(summary, null, 2);
}

function renderCardCreateSummary(
  target: HTMLElement,
  summary: {
    inputFiles: string[];
    usedBaseImage: string;
    embeddedChunkTypes: string[];
    convertedFiles: string[];
    outputFileName: string;
    warnings: { level: string; message: string }[];
  },
): void {
  target.textContent = JSON.stringify(summary, null, 2);
}

type CardCreateMetadataKey = "uInf" | "fBtn" | "moAi";

interface CardCreateUInfDraft {
  auth: string;
  ch: string;
  info: string;
}

interface CardCreateFastButtonDraft {
  name: string;
  action: "morph";
  morph: string;
  sourceSeq?: number;
}

interface MorphDescDraft {
  index: string;
  name: string;
  desc: string;
  sourceSeq?: number;
}

interface VoiceCloneSampleDraft {
  index: string;
  fileName: string;
  sampleName: string;
  locale: string;
}

interface CardCreateMoAiDraft {
  name: string;
  gender: string;
  info: string;
  morphs: MorphDescDraft[];
  voiceSamples: VoiceCloneSampleDraft[];
}

const CARD_CREATE_REQUIRED_KINDS = new Set([
  "pmx",
  "bpmx",
  "bpmv",
  "bvmd",
  "motion-source",
  "webm",
  "audio-source",
]);

const CARD_CREATE_METADATA_KIND_MAP: Record<
  CardCreateMetadataKey,
  ReturnType<typeof getCardCreatorInputKind>
> = {
  uInf: "metadata-uInf",
  fBtn: "metadata-fBtn",
  moAi: "metadata-moAi",
};

function createEmptyUInfDraft(): CardCreateUInfDraft {
  return { auth: "", ch: "", info: "" };
}

function createEmptyFastButtonDraft(): CardCreateFastButtonDraft {
  return { name: "", action: "morph", morph: "0" };
}

function createEmptyMoAiDraft(): CardCreateMoAiDraft {
  return { name: "", gender: "", info: "", morphs: [], voiceSamples: [] };
}

function hasCardCreateEmbeddableInput(files: readonly File[]): boolean {
  return files.some((file) =>
    CARD_CREATE_REQUIRED_KINDS.has(getCardCreatorInputKind(file)),
  );
}

function hasCardCreateModelInput(files: readonly File[]): boolean {
  return files.some((file) => {
    const kind = getCardCreatorInputKind(file);
    return kind === "pmx" || kind === "bpmx";
  });
}

function normalizeStringArray(values: unknown): string {
  if (!Array.isArray(values)) return "";
  return values.map((value) => String(value ?? "")).join("\n");
}

function parseUInfDraft(value: unknown): CardCreateUInfDraft {
  const data = (value ?? {}) as Record<string, unknown>;
  return {
    auth: String(data.auth ?? ""),
    ch: normalizeStringArray(data.ch),
    info: String(data.info ?? ""),
  };
}

function parseFastButtonRows(value: unknown): CardCreateFastButtonDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const data = (entry ?? {}) as Record<string, unknown>;
    return {
      name: String(data.name ?? ""),
      action: "morph" as const,
      morph: String(data.morph ?? "0"),
    };
  });
}

function parseMoAiDraft(value: unknown): CardCreateMoAiDraft {
  const data = (value ?? {}) as Record<string, unknown>;
  const morphs = Array.isArray(data.morphs)
    ? data.morphs.map((entry: unknown) => {
        const m = (entry ?? {}) as Record<string, unknown>;
        return {
          index: String(m.index ?? "0"),
          name: String(m.name ?? ""),
          desc: String(m.desc ?? ""),
        };
      })
    : [];
  const voiceSamples = Array.isArray(data.voiceSamples)
    ? data.voiceSamples.map((entry: unknown) => {
        const s = (entry ?? {}) as Record<string, unknown>;
        return {
          index: String(s.index ?? "0"),
          fileName: String(s.fileName ?? ""),
          sampleName: String(s.sampleName ?? ""),
          locale: String(s.locale ?? ""),
        };
      })
    : [];
  return {
    name: String(data.name ?? ""),
    gender: String(data.gender ?? ""),
    info: String(data.info ?? ""),
    morphs,
    voiceSamples,
  };
}

function buildUInfOverride(draft: CardCreateUInfDraft): {
  auth: string;
  ch: string[];
  info: string;
} {
  return {
    auth: draft.auth,
    ch: draft.ch
      .split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    info: draft.info,
  };
}

function buildFastButtonOverride(
  drafts: readonly CardCreateFastButtonDraft[],
): { name: string; action: "morph"; morph: number }[] {
  return drafts
    .map((draft) => ({
      name: draft.name.trim(),
      action: "morph" as const,
      morph: Number(draft.morph),
    }))
    .filter((draft) => draft.name.length > 0 || !Number.isNaN(draft.morph));
}

function buildMoAiOverride(draft: CardCreateMoAiDraft): {
  name: string;
  gender: string;
  info: string;
  morphs: Array<{ index: number; name: string; desc: string }>;
  voiceSamples: Array<{
    index: number;
    fileName: string;
    sampleName: string;
    locale?: string;
  }>;
} {
  const morphs = draft.morphs
    .filter((m) => m.name.trim().length > 0 || m.desc.trim().length > 0)
    .map((m) => ({
      index: Number(m.index) || 0,
      name: m.name.trim(),
      desc: m.desc.trim(),
    }));
  const voiceSamples = draft.voiceSamples
    .filter(
      (s) => s.fileName.trim().length > 0 || s.sampleName.trim().length > 0,
    )
    .map((s) => ({
      index: Number(s.index) || 0,
      fileName: s.fileName.trim(),
      sampleName: s.sampleName.trim(),
      ...(s.locale.trim() ? { locale: s.locale.trim() } : {}),
    }));
  return {
    name: draft.name,
    gender: draft.gender,
    info: draft.info,
    morphs,
    voiceSamples,
  };
}

async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text()) as unknown;
}

/**
 * Recursively reads a dropped FileSystemDirectoryEntry into File objects.
 * Each file gets `webkitRelativePath` set to its path within the directory,
 * prefixed by `pathPrefix` (which should be the top-level folder name).
 *
 * Note: `readEntries` returns at most 100 entries per call, so we loop until
 * it returns an empty array.
 */
async function readDirectoryEntry(
  entry: FileSystemDirectoryEntry,
  pathPrefix: string,
): Promise<File[]> {
  const reader = entry.createReader();
  const files: File[] = [];

  for (;;) {
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (entries.length === 0) break;

    for (const child of entries) {
      const childPath = `${pathPrefix}/${child.name}`;
      if (child.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (child as FileSystemFileEntry).file(resolve, reject),
        );
        try {
          Object.defineProperty(file, "webkitRelativePath", {
            configurable: true,
            enumerable: true,
            writable: false,
            value: childPath,
          });
        } catch {
          // Ignore in environments that disallow redefining this property.
        }
        files.push(file);
      } else if (child.isDirectory) {
        const sub = await readDirectoryEntry(
          child as FileSystemDirectoryEntry,
          childPath,
        );
        files.push(...sub);
      }
    }
  }

  return files;
}

/** Returns the PMX file with the shallowest relative path (fewest slashes). */
function pickDefaultPmx(files: File[]): File | null {
  const pmxFiles = files.filter((f) => {
    const rel =
      (f as File & { webkitRelativePath?: string }).webkitRelativePath ??
      f.name;
    return rel.toLowerCase().endsWith(".pmx");
  });
  if (pmxFiles.length === 0) return null;
  pmxFiles.sort((a, b) => {
    const pa =
      (a as File & { webkitRelativePath?: string }).webkitRelativePath ??
      a.name;
    const pb =
      (b as File & { webkitRelativePath?: string }).webkitRelativePath ??
      b.name;
    return (pa.match(/\//g)?.length ?? 0) - (pb.match(/\//g)?.length ?? 0);
  });
  return pmxFiles[0];
}

// ── UI ───────────────────────────────────────────────────────────────────────

interface MountConverterViewOptions {
  locale: AppLocale;
  theme: AppTheme;
  onLocaleChange: (nextLocale: AppLocale) => void;
  onThemeToggle: (nextTheme: AppTheme) => void;
}

interface ConverterViewText {
  heroTitle: string;
  bpmxTitle: string;
  bpmxHint: string;
  bpmxDropLabel: string;
  pmxTitle: string;
  pmxHint: string;
  motionTitle: string;
  motionHint: string;
  motionDropLabel: string;
  motionSummaryTitle: string;
  bvmdTitle: string;
  bvmdHint: string;
  bvmdDropLabel: string;
  audioTitle: string;
  audioHint: string;
  audioDropLabel: string;
  audioSummaryTitle: string;
  cardCreateTitle: string;
  cardCreateHint: string;
  cardCreateDropLabel: string;
  cardCreatePreviewAlt: string;
  cardCreatePreviewDefault: string;
  metadataEditSummary: string;
  editLabel: string;
  uInfEditTitle: string;
  fBtnEditTitle: string;
  moAiEditTitle: string;
  authorLabel: string;
  characterTagsLabel: string;
  infoLabel: string;
  nameLabel: string;
  genderLabel: string;
  addButtonLabel: string;
  creationReportTitle: string;
  noCardCreated: string;
  cardExtractTitle: string;
  cardExtractHint: string;
  cardExtractDropLabel: string;
  convertLegacyMmdFiles: string;
  extractionReportTitle: string;
  noExtractionYet: string;
  tabFooterLegal: string;
  tabFooterPrivacy: string;
  tabFooterDocs: string;
  loadFile: string;
  loadFolder: string;
  loadZip: string;
  loadFiles: string;
  chooseOtherImage: string;
  removeImage: string;
  remove: string;
  detectedFiles: string;
  clearAll: string;
  textEncoding: string;
  restoreOriginalFormats: string;
  convertToPmxZip: string;
  convertToBpmx: string;
  convertToBvmd: string;
  convertToVmd: string;
  convertToWebm: string;
  createCardPng: string;
  extractAsZip: string;
  fidelityReportTitle: string;
  warningsTitle: string;
  noConversionYet: string;
  textureCompression: string;
  compressLossless: string;
  compressLossy: string;
  rawNoCompression: string;
  forceAvifLabel: string;
  forceAvifSlow: string;
  pmxNoFileFound: string;
  pmxDropLabelDefault: string;
  sourceFolder: string;
  sourceZip: string;
  sourceFolderDrop: string;
  sourceZipDrop: string;
  sourceFiles: string;
  sourceFilesDrop: string;
  sourceBaseImage: string;
  readZip: string;
  readFolder: string;
  filesLoadedLabel: string;
  filesLoadedStatus: string;
  filesLoadedFromSourceStatus: string;
  selectedFilesStatus: string;
  optimizingTextures: string;
  downloadedStatus: string;
  downloadedTextureZipStatus: string;
  downloadedZipFilesStatus: string;
  pleaseSelectBpmx: string;
  pleaseLoadFolderOrZip: string;
  pleaseSelectMotion: string;
  pleaseSelectBvmd: string;
  pleaseSelectAudio: string;
  pleaseSelectCardPng: string;
  webmEncodingUnavailable: string;
  alreadyAvif: string;
  losslessTag: string;
  lossyTag: string;
  noneLossy: string;
  allLossy: string;
  forceAvifBusyTitle: string;
  rawDisableCompressionTitle: string;
  forceAvifTitle: string;
  baseImageRole: string;
  baseImageAvailableRole: string;
  pmxSourceRole: string;
  motionSourceRole: string;
  audioSourceRole: string;
  genericFileRole: string;
  metadataSourceRolePrefix: string;
  metadataMissingEditTemplate: string;
  metadataEditableWhenModelLoaded: string;
  metadataSourceTemplate: string;
  metadataInvalidJsonTemplate: string;
  metadataInvalidJsonListTemplate: string;
  metadataDuplicateRowTitle: string;
  metadataInvalidRowTitle: string;
  metadataRemappedRowTemplate: string;
  fastButtonNamePlaceholder: string;
  fastButtonMorphPlaceholder: string;
  fastButtonRemove: string;
  baseImageLabel: string;
  defaultImageAlreadyActive: string;
  defaultImageActivated: string;
  createCardInProgress: string;
  extractCardInProgress: string;
  morphDescTitle: string;
  morphDescIndexLabel: string;
  morphDescNameLabel: string;
  morphDescDescLabel: string;
  morphDescRemove: string;
  morphDescAdd: string;
  voiceCloneTitle: string;
  voiceCloneFileNameLabel: string;
  voiceCloneSampleNameLabel: string;
  voiceCloneLocaleLabel: string;
  voiceCloneRemove: string;
  voiceCloneAdd: string;
  voiceCloneHint: string;
  voiceCloneSelectFile: string;
  voiceClonePlay: string;
  voiceCloneStop: string;
  voiceCloneDurationError: string;
  voiceCloneFileMissing: string;
  voiceCloneLocalePlaceholder: string;
  webmAudioTitle: string;
  webmAudioSelectFile: string;
}

function getConverterViewText(locale: AppLocale): ConverterViewText {
  const en: ConverterViewText = {
    heroTitle: "ero.dance Converter",
    bpmxTitle: "Convert BPMX to PMX",
    bpmxHint:
      "Loads a .bpmx file and returns a ZIP archive with the PMX file and all embedded textures.",
    bpmxDropLabel: "Drop BPMX file here, or",
    pmxTitle: "Convert PMX to BPMX",
    pmxHint:
      "Load the complete PMX model folder (PMX + textures), either as a folder or a ZIP archive.",
    motionTitle: "Convert VMD / VPD / VMP-like pose to BVMD",
    motionHint:
      "Loads MMD motions (.vmd) or text-based pose files (.vpd, .vmp) and converts them to .bvmd.",
    motionDropLabel: "Drop motion file here, or",
    motionSummaryTitle: "Motion summary",
    bvmdTitle: "Convert BVMD to VMD",
    bvmdHint:
      "Loads a .bvmd file and exports it as legacy .vmd files: the model animation plus a separate camera VMD when camera frames are present.",
    bvmdDropLabel: "Drop BVMD file here, or",
    audioTitle: "Convert WAV or MP3 to WebM audio",
    audioHint:
      "Loads a .wav or .mp3 file and exports it as a .webm audio file with the Opus codec.",
    audioDropLabel: "Drop audio file here, or",
    audioSummaryTitle: "Audio summary",
    cardCreateTitle: "Create card",
    cardCreateHint:
      "Loads a folder, a ZIP, or individual files, pre-converts source formats if needed, and then stores only the new card chunks into a PNG.",
    cardCreateDropLabel: "Drop folder, ZIP, or individual files here, or",
    cardCreatePreviewAlt: "Base image for the card",
    cardCreatePreviewDefault: "Base image: eroLogo.png",
    metadataEditSummary: "Edit metadata",
    editLabel: "Edit",
    uInfEditTitle: "Edit uInf",
    fBtnEditTitle: "Edit fBtn",
    moAiEditTitle: "Edit moAi",
    authorLabel: "Author",
    characterTagsLabel: "Character tags",
    infoLabel: "Info",
    nameLabel: "Name",
    genderLabel: "Gender",
    addButtonLabel: "Add button",
    creationReportTitle: "Creation report",
    noCardCreated: "No card created yet.",
    cardExtractTitle: "Extract MMD from Card",
    cardExtractHint:
      "Loads a Card PNG, extracts known private chunks into a ZIP, and includes the cleaned image as ero.dance.png.",
    cardExtractDropLabel: "Drop card PNG here, or",
    convertLegacyMmdFiles: "Convert to legacy MMD files",
    extractionReportTitle: "Extraction report",
    noExtractionYet: "No extraction yet.",
    tabFooterLegal: "Legal notice",
    tabFooterPrivacy: "Privacy policy",
    tabFooterDocs: "Documentation",
    loadFile: "Load file",
    loadFolder: "Load folder",
    loadZip: "Load ZIP",
    loadFiles: "Load files",
    chooseOtherImage: "Choose another image",
    removeImage: "Remove image",
    remove: "Remove",
    detectedFiles: "Detected files",
    clearAll: "Remove all",
    textEncoding: "Text encoding",
    restoreOriginalFormats: "Try to convert back to the original image formats",
    convertToPmxZip: "Convert to PMX ZIP",
    convertToBpmx: "Convert to BPMX",
    convertToBvmd: "Convert to BVMD",
    convertToVmd: "Convert to VMD",
    convertToWebm: "Convert to WebM",
    createCardPng: "Create card PNG",
    extractAsZip: "Extract as ZIP",
    fidelityReportTitle: "Fidelity report",
    warningsTitle: "Warnings",
    noConversionYet: "No conversion yet.",
    textureCompression: "Texture compression",
    compressLossless: "Compress (lossless)",
    compressLossy: "Compress with loss",
    rawNoCompression: "RAW (no compression)",
    forceAvifLabel: "Force AVIF",
    forceAvifSlow: "Force AVIF (very slow, but very small file)",
    pmxNoFileFound: "No .pmx file found.",
    pmxDropLabelDefault: "Drop folder or ZIP here, or",
    sourceFolder: "(folder)",
    sourceZip: "(ZIP)",
    sourceFolderDrop: "(folder via drop)",
    sourceZipDrop: "(ZIP via drop)",
    sourceFiles: "(files)",
    sourceFilesDrop: "(files via drop)",
    sourceBaseImage: "(base image)",
    readZip: "Reading ZIP...",
    readFolder: "Reading folder...",
    filesLoadedLabel: "{count} files loaded",
    filesLoadedStatus: "{ready} - {count} file(s) loaded.",
    filesLoadedFromSourceStatus: "{ready} - {count} file(s) loaded {source}.",
    selectedFilesStatus:
      '{ready} - "{name}" selected, {count} file(s) {source}.',
    optimizingTextures: "Optimizing textures ({done}/{total})...",
    downloadedStatus: "Done - {file} downloaded.",
    downloadedTextureZipStatus:
      "Done - ZIP with {count} texture(s) downloaded.",
    downloadedZipFilesStatus: "Done - {count} file(s) downloaded in ZIP.",
    pleaseSelectBpmx: "Please select a BPMX file first.",
    pleaseLoadFolderOrZip: "Please load a folder or ZIP first.",
    pleaseSelectMotion: "Please select a motion file first.",
    pleaseSelectBvmd: "Please select a BVMD file first.",
    pleaseSelectAudio: "Please select a WAV or MP3 file first.",
    pleaseSelectCardPng: "Please select a card PNG first.",
    webmEncodingUnavailable: "WebM audio encoding is not available here.",
    alreadyAvif: "already AVIF",
    losslessTag: "lossless",
    lossyTag: "lossy",
    noneLossy: "none lossy",
    allLossy: "all lossy",
    forceAvifBusyTitle: "Locked during conversion.",
    rawDisableCompressionTitle: "RAW disables image compression.",
    forceAvifTitle: "Forces real AVIF output via @jsquash/avif.",
    baseImageRole: "Base image",
    baseImageAvailableRole: "Base image available",
    pmxSourceRole: "PMX source",
    motionSourceRole: "Motion source",
    audioSourceRole: "Audio source",
    genericFileRole: "File",
    metadataSourceRolePrefix: "Metadata",
    metadataMissingEditTemplate:
      "No {file} loaded. Enabling edit will embed new content.",
    metadataEditableWhenModelLoaded:
      "Editing becomes available once PMX or BPMX has been loaded.",
    metadataSourceTemplate: "Source: {path}",
    metadataInvalidJsonTemplate: "Source: {path} (invalid JSON)",
    metadataInvalidJsonListTemplate: "Invalid JSON: {paths}",
    metadataDuplicateRowTitle:
      "Duplicate: refers to the same morph as another entry. When creating the card, the most recently added entry wins.",
    metadataInvalidRowTitle:
      "Invalid: this morph does not exist in the selected model. It will not be embedded into the card.",
    metadataRemappedRowTemplate:
      "Remapped: this entry's morph name was found at index {to}; {to} will be used instead of {from}.",
    fastButtonNamePlaceholder: "Name",
    fastButtonMorphPlaceholder: "Morph",
    fastButtonRemove: "Remove fast button",
    baseImageLabel: "Base image: {path}",
    defaultImageAlreadyActive: "The default image is already active.",
    defaultImageActivated: "Base image removed. eroLogo.png will be used.",
    createCardInProgress: "Creating card PNG...",
    extractCardInProgress: "Extracting card data...",
    morphDescTitle: "Morph Descriptions",
    morphDescIndexLabel: "Index",
    morphDescNameLabel: "Name",
    morphDescDescLabel: "Description",
    morphDescRemove: "Remove",
    morphDescAdd: "Add morph",
    voiceCloneTitle: "Voice Clone Samples",
    voiceCloneFileNameLabel: "File name",
    voiceCloneSampleNameLabel: "Sample name",
    voiceCloneLocaleLabel: "Locale",
    voiceCloneRemove: "Remove",
    voiceCloneAdd: "Add sample",
    voiceCloneHint:
      "Files named voice_sample_*.webm or in metadata.voiceSamples/ will be embedded as voice clone audio.",
    voiceCloneSelectFile: "Select file…",
    voiceClonePlay: "Play",
    voiceCloneStop: "Stop",
    voiceCloneDurationError: "Duration must be 3–20 seconds",
    voiceCloneFileMissing: "File not found",
    voiceCloneLocalePlaceholder: "Select locale…",
    webmAudioTitle: "WebM Audio",
    webmAudioSelectFile: "Select WebM file…",
  };

  const de: ConverterViewText = {
    heroTitle: "ero.dance Konverter",
    bpmxTitle: "BPMX zu PMX konvertieren",
    bpmxHint:
      "Lädt eine .bpmx-Datei und gibt ein ZIP-Archiv mit der PMX-Datei und allen eingebetteten Texturen zurück.",
    bpmxDropLabel: "BPMX-Datei hier ablegen oder",
    pmxTitle: "PMX zu BPMX konvertieren",
    pmxHint:
      "Lade den kompletten PMX-Modell-Ordner (PMX + Texturen) - entweder als Ordner oder als ZIP-Archiv.",
    motionTitle: "VMD / VPD / VMP-ähnliche Pose zu BVMD konvertieren",
    motionHint:
      "Lädt MMD-Motions (.vmd) oder textbasierte Pose-Dateien (.vpd, .vmp) und wandelt sie in .bvmd um.",
    motionDropLabel: "Motion-Datei hier ablegen oder",
    motionSummaryTitle: "Motion-Übersicht",
    bvmdTitle: "BVMD zu VMD konvertieren",
    bvmdHint:
      "Lädt eine .bvmd-Datei und exportiert sie als Legacy-.vmd-Dateien: die Figuren-Animation plus eine separate Kamera-VMD, wenn Kameraframes vorhanden sind.",
    bvmdDropLabel: "BVMD-Datei hier ablegen oder",
    audioTitle: "WAV oder MP3 zu WebM-Audio konvertieren",
    audioHint:
      "Lädt eine .wav- oder .mp3-Datei und exportiert sie als .webm-Audiodatei mit Opus-Codec.",
    audioDropLabel: "Audio-Datei hier ablegen oder",
    audioSummaryTitle: "Audio-Übersicht",
    cardCreateTitle: "Card erstellen",
    cardCreateHint:
      "Lädt einen Ordner, ein ZIP oder einzelne Dateien, konvertiert Quellformate bei Bedarf vor und speichert anschließend ausschließlich die neuen Card-Chunks in eine PNG.",
    cardCreateDropLabel: "Ordner, ZIP oder einzelne Dateien hier ablegen oder",
    cardCreatePreviewAlt: "Basisbild für die Card",
    cardCreatePreviewDefault: "Basisbild: eroLogo.png",
    metadataEditSummary: "Metadaten bearbeiten",
    editLabel: "Editieren",
    uInfEditTitle: "uInf bearbeiten",
    fBtnEditTitle: "fBtn bearbeiten",
    moAiEditTitle: "moAi bearbeiten",
    authorLabel: "Autor",
    characterTagsLabel: "Character-Tags",
    infoLabel: "Info",
    nameLabel: "Name",
    genderLabel: "Gender",
    addButtonLabel: "Button hinzufügen",
    creationReportTitle: "Erstellungsbericht",
    noCardCreated: "Noch keine Card erstellt.",
    cardExtractTitle: "MMD aus Card extrahieren",
    cardExtractHint:
      "Lädt eine Card-PNG, extrahiert bekannte private Chunks in ein ZIP und legt das bereinigte Bild ohne Chunkdaten als ero.dance.png bei.",
    cardExtractDropLabel: "Card-PNG hier ablegen oder",
    convertLegacyMmdFiles: "In Legacy-MMD-Dateien konvertieren",
    extractionReportTitle: "Extraktionsbericht",
    noExtractionYet: "Noch keine Extraktion.",
    tabFooterLegal: "Impressum",
    tabFooterPrivacy: "Datenschutzerklärung",
    tabFooterDocs: "Dokumentation",
    loadFile: "Datei laden",
    loadFolder: "Ordner laden",
    loadZip: "ZIP laden",
    loadFiles: "Dateien laden",
    chooseOtherImage: "Anderes Bild wählen",
    removeImage: "Bild entfernen",
    remove: "Entfernen",
    detectedFiles: "Erkannte Dateien",
    clearAll: "Alle entfernen",
    textEncoding: "Text-Encoding",
    restoreOriginalFormats:
      "Versuche zu den ursprünglichen Bildformaten zurück zu konvertieren",
    convertToPmxZip: "In PMX-ZIP konvertieren",
    convertToBpmx: "In BPMX konvertieren",
    convertToBvmd: "In BVMD konvertieren",
    convertToVmd: "In VMD konvertieren",
    convertToWebm: "In WebM konvertieren",
    createCardPng: "Card-PNG erstellen",
    extractAsZip: "Als ZIP extrahieren",
    fidelityReportTitle: "Fidelity Report",
    warningsTitle: "Warnungen",
    noConversionYet: "Noch keine Konvertierung.",
    textureCompression: "Textur-Komprimierung",
    compressLossless: "Komprimieren (verlustfrei)",
    compressLossy: "Verlustbehaftet komprimieren",
    rawNoCompression: "RAW (keine Komprimierung)",
    forceAvifLabel: "AVIF erzwingen",
    forceAvifSlow: "Force AVIF (Sehr langsam, aber sehr kleine Datei)",
    pmxNoFileFound: "Keine .pmx-Datei gefunden.",
    pmxDropLabelDefault: "Ordner oder ZIP hier ablegen oder",
    sourceFolder: "(Ordner)",
    sourceZip: "(ZIP)",
    sourceFolderDrop: "(Ordner per Drop)",
    sourceZipDrop: "(ZIP per Drop)",
    sourceFiles: "(Dateien)",
    sourceFilesDrop: "(Dateien per Drop)",
    sourceBaseImage: "(Basisbild)",
    readZip: "Lese ZIP...",
    readFolder: "Lese Ordner...",
    filesLoadedLabel: "{count} Dateien geladen",
    filesLoadedStatus: "{ready} - {count} Datei(en) geladen.",
    filesLoadedFromSourceStatus:
      "{ready} - {count} Datei(en) geladen {source}.",
    selectedFilesStatus:
      '{ready} - "{name}" ausgewählt, {count} Datei(en) {source}.',
    optimizingTextures: "Optimiere Texturen ({done}/{total})...",
    downloadedStatus: "Fertig - {file} heruntergeladen.",
    downloadedTextureZipStatus:
      "Fertig - ZIP mit {count} Textur(en) heruntergeladen.",
    downloadedZipFilesStatus:
      "Fertig - {count} Datei(en) in ZIP heruntergeladen.",
    pleaseSelectBpmx: "Bitte eine BPMX-Datei auswählen.",
    pleaseLoadFolderOrZip: "Bitte zuerst einen Ordner oder ein ZIP laden.",
    pleaseSelectMotion: "Bitte zuerst eine Motion-Datei auswählen.",
    pleaseSelectBvmd: "Bitte zuerst eine BVMD-Datei auswählen.",
    pleaseSelectAudio: "Bitte zuerst eine WAV- oder MP3-Datei auswählen.",
    pleaseSelectCardPng: "Bitte zuerst eine Card-PNG auswählen.",
    webmEncodingUnavailable: "WebM-Audio-Encoding ist hier nicht verfügbar.",
    alreadyAvif: "bereits AVIF",
    losslessTag: "verlustfrei",
    lossyTag: "verlustbehaftet",
    noneLossy: "Keine verlustbehaftet",
    allLossy: "Alle verlustbehaftet",
    forceAvifBusyTitle: "Wird waehrend der Konvertierung gesperrt.",
    rawDisableCompressionTitle: "RAW deaktiviert die Bildkomprimierung.",
    forceAvifTitle: "Erzwingt echte AVIF-Ausgabe via @jsquash/avif.",
    baseImageRole: "Basisbild",
    baseImageAvailableRole: "Basisbild verfügbar",
    pmxSourceRole: "PMX-Quelle",
    motionSourceRole: "Motion-Quelle",
    audioSourceRole: "Audio-Quelle",
    genericFileRole: "Datei",
    metadataSourceRolePrefix: "Metadata",
    metadataMissingEditTemplate:
      "Keine {file} geladen. Mit Editieren wird neuer Inhalt eingebettet.",
    metadataEditableWhenModelLoaded:
      "Bearbeitung verfügbar, sobald PMX oder BPMX geladen ist.",
    metadataSourceTemplate: "Quelle: {path}",
    metadataInvalidJsonTemplate: "Quelle: {path} (ungültiges JSON)",
    metadataInvalidJsonListTemplate: "Ungültiges JSON: {paths}",
    metadataDuplicateRowTitle:
      "Duplikat: verweist auf denselben Morph wie ein anderer Eintrag. Beim Erstellen der Karte gewinnt der zuletzt hinzugefügte Eintrag.",
    metadataInvalidRowTitle:
      "Ungültig: Dieser Morph existiert im ausgewählten Modell nicht. Er wird nicht in die Karte eingebettet.",
    metadataRemappedRowTemplate:
      "Umgemappt: Der Morph-Name dieses Eintrags wurde bei Index {to} gefunden; {to} wird statt {from} verwendet.",
    fastButtonNamePlaceholder: "Name",
    fastButtonMorphPlaceholder: "Morph",
    fastButtonRemove: "Fast Button entfernen",
    baseImageLabel: "Basisbild: {path}",
    defaultImageAlreadyActive: "Es ist bereits das Defaultbild aktiv.",
    defaultImageActivated: "Basisbild entfernt. Es wird eroLogo.png verwendet.",
    createCardInProgress: "Erstelle Card-PNG...",
    extractCardInProgress: "Extrahiere Card-Daten...",
    morphDescTitle: "Morph-Beschreibungen",
    morphDescIndexLabel: "Index",
    morphDescNameLabel: "Name",
    morphDescDescLabel: "Beschreibung",
    morphDescRemove: "Entfernen",
    morphDescAdd: "Morph hinzufügen",
    voiceCloneTitle: "Voice-Clone-Samples",
    voiceCloneFileNameLabel: "Dateiname",
    voiceCloneSampleNameLabel: "Sample-Name",
    voiceCloneLocaleLabel: "Locale",
    voiceCloneRemove: "Entfernen",
    voiceCloneAdd: "Sample hinzufügen",
    voiceCloneHint:
      "Dateien mit dem Namen voice_sample_*.webm oder im Ordner metadata.voiceSamples/ werden als Voice-Clone-Audio eingebettet.",
    voiceCloneSelectFile: "Datei auswählen…",
    voiceClonePlay: "Abspielen",
    voiceCloneStop: "Stoppen",
    voiceCloneDurationError: "Dauer muss zwischen 3 und 20 Sekunden liegen",
    voiceCloneFileMissing: "Datei nicht gefunden",
    voiceCloneLocalePlaceholder: "Locale auswählen…",
    webmAudioTitle: "WebM-Audio",
    webmAudioSelectFile: "WebM-Datei auswählen…",
  };

  const ja: ConverterViewText = {
    heroTitle: "ero.dance コンバーター",
    bpmxTitle: "BPMX を PMX に変換",
    bpmxHint:
      ".bpmx ファイルを読み込み、PMX ファイルと埋め込みテクスチャを含む ZIP を生成します。",
    bpmxDropLabel: "ここに BPMX ファイルをドロップするか、",
    pmxTitle: "PMX を BPMX に変換",
    pmxHint:
      "PMX モデル一式（PMX とテクスチャ）を、フォルダーまたは ZIP として読み込みます。",
    motionTitle: "VMD / VPD / VMP 系ポーズを BVMD に変換",
    motionHint:
      "MMD モーション（.vmd）またはテキストベースのポーズファイル（.vpd、.vmp）を .bvmd に変換します。",
    motionDropLabel: "ここにモーションファイルをドロップするか、",
    motionSummaryTitle: "モーション概要",
    bvmdTitle: "BVMD を VMD に変換",
    bvmdHint:
      ".bvmd ファイルを読み込み、レガシー .vmd ファイルとして出力します。モデルアニメーションに加え、カメラフレームがある場合はカメラ用 VMD も出力します。",
    bvmdDropLabel: "ここに BVMD ファイルをドロップするか、",
    audioTitle: "WAV または MP3 を WebM 音声に変換",
    audioHint:
      ".wav または .mp3 を読み込み、Opus コーデック付きの .webm 音声として出力します。",
    audioDropLabel: "ここに音声ファイルをドロップするか、",
    audioSummaryTitle: "音声概要",
    cardCreateTitle: "カードを作成",
    cardCreateHint:
      "フォルダー、ZIP、または個別ファイルを読み込み、必要に応じて事前変換したうえで、新しいカードチャンクだけを PNG に保存します。",
    cardCreateDropLabel:
      "ここにフォルダー、ZIP、または個別ファイルをドロップするか、",
    cardCreatePreviewAlt: "カード用のベース画像",
    cardCreatePreviewDefault: "ベース画像: eroLogo.png",
    metadataEditSummary: "メタデータを編集",
    editLabel: "編集",
    uInfEditTitle: "uInf を編集",
    fBtnEditTitle: "fBtn を編集",
    moAiEditTitle: "moAi を編集",
    authorLabel: "作者",
    characterTagsLabel: "キャラクタータグ",
    infoLabel: "情報",
    nameLabel: "名前",
    genderLabel: "性別",
    addButtonLabel: "ボタンを追加",
    creationReportTitle: "作成レポート",
    noCardCreated: "まだカードは作成されていません。",
    cardExtractTitle: "カードから MMD を抽出",
    cardExtractHint:
      "Card PNG を読み込み、既知の非公開チャンクを ZIP に抽出し、ero.dance.png としてクリーン画像も含めます。",
    cardExtractDropLabel: "ここに Card PNG をドロップするか、",
    convertLegacyMmdFiles: "従来の MMD ファイルに変換",
    extractionReportTitle: "抽出レポート",
    noExtractionYet: "まだ抽出は行われていません。",
    tabFooterLegal: "法的情報",
    tabFooterPrivacy: "プライバシーポリシー",
    tabFooterDocs: "ドキュメント",
    loadFile: "ファイルを読み込む",
    loadFolder: "フォルダーを読み込む",
    loadZip: "ZIP を読み込む",
    loadFiles: "ファイルを読み込む",
    chooseOtherImage: "別の画像を選択",
    removeImage: "画像を削除",
    remove: "削除",
    detectedFiles: "検出されたファイル",
    clearAll: "すべて削除",
    textEncoding: "テキストエンコーディング",
    restoreOriginalFormats: "元の画像形式へ戻すことを試みる",
    convertToPmxZip: "PMX ZIP に変換",
    convertToBpmx: "BPMX に変換",
    convertToBvmd: "BVMD に変換",
    convertToVmd: "VMD に変換",
    convertToWebm: "WebM に変換",
    createCardPng: "Card PNG を作成",
    extractAsZip: "ZIP として抽出",
    fidelityReportTitle: "再現性レポート",
    warningsTitle: "警告",
    noConversionYet: "まだ変換されていません。",
    textureCompression: "テクスチャ圧縮",
    compressLossless: "圧縮（可逆）",
    compressLossy: "圧縮（非可逆）",
    rawNoCompression: "RAW（圧縮なし）",
    forceAvifLabel: "AVIF を強制",
    forceAvifSlow:
      "Force AVIF（非常に遅いですが、非常に小さいファイルになります）",
    pmxNoFileFound: ".pmx ファイルが見つかりません。",
    pmxDropLabelDefault: "ここにフォルダーまたは ZIP をドロップするか、",
    sourceFolder: "（フォルダー）",
    sourceZip: "（ZIP）",
    sourceFolderDrop: "（ドラッグしたフォルダー）",
    sourceZipDrop: "（ドラッグした ZIP）",
    sourceFiles: "（ファイル）",
    sourceFilesDrop: "（ドラッグしたファイル）",
    sourceBaseImage: "（ベース画像）",
    readZip: "ZIP を読み込み中...",
    readFolder: "フォルダーを読み込み中...",
    filesLoadedLabel: "{count} 件のファイルを読み込みました",
    filesLoadedStatus: "{ready} - {count} 件のファイルを読み込みました。",
    filesLoadedFromSourceStatus:
      "{ready} - {count} 件のファイルを読み込みました {source}。",
    selectedFilesStatus:
      '{ready} - "{name}" を選択済み、{count} 件のファイル {source}。',
    optimizingTextures: "テクスチャを最適化中 ({done}/{total})...",
    downloadedStatus: "完了 - {file} をダウンロードしました。",
    downloadedTextureZipStatus:
      "完了 - {count} 枚のテクスチャを含む ZIP をダウンロードしました。",
    downloadedZipFilesStatus:
      "完了 - ZIP 内の {count} 件のファイルをダウンロードしました。",
    pleaseSelectBpmx: "先に BPMX ファイルを選択してください。",
    pleaseLoadFolderOrZip: "先にフォルダーまたは ZIP を読み込んでください。",
    pleaseSelectMotion: "先にモーションファイルを選択してください。",
    pleaseSelectBvmd: "先に BVMD ファイルを選択してください。",
    pleaseSelectAudio: "先に WAV または MP3 ファイルを選択してください。",
    pleaseSelectCardPng: "先に Card PNG を選択してください。",
    webmEncodingUnavailable:
      "この環境では WebM 音声エンコードを利用できません。",
    alreadyAvif: "すでに AVIF",
    losslessTag: "可逆",
    lossyTag: "非可逆",
    noneLossy: "非可逆を解除",
    allLossy: "すべて非可逆",
    forceAvifBusyTitle: "変換中はロックされます。",
    rawDisableCompressionTitle: "RAW では画像圧縮が無効になります。",
    forceAvifTitle: "@jsquash/avif による実際の AVIF 出力を強制します。",
    baseImageRole: "ベース画像",
    baseImageAvailableRole: "利用可能なベース画像",
    pmxSourceRole: "PMX ソース",
    motionSourceRole: "モーションソース",
    audioSourceRole: "音声ソース",
    genericFileRole: "ファイル",
    metadataSourceRolePrefix: "メタデータ",
    metadataMissingEditTemplate:
      "{file} は読み込まれていません。編集を有効にすると新しい内容が埋め込まれます。",
    metadataEditableWhenModelLoaded:
      "PMX または BPMX を読み込むと編集できるようになります。",
    metadataSourceTemplate: "ソース: {path}",
    metadataInvalidJsonTemplate: "ソース: {path}（無効な JSON）",
    metadataInvalidJsonListTemplate: "無効な JSON: {paths}",
    metadataDuplicateRowTitle:
      "重複: 他のエントリと同じモーフを参照しています。カード作成時は最後に追加されたエントリが優先されます。",
    metadataInvalidRowTitle:
      "無効: このモーフは選択されたモデルに存在しません。カードには埋め込まれません。",
    metadataRemappedRowTemplate:
      "再マッピング: このエントリのモーフ名がインデックス {to} で見つかったため、{from} の代わりに {to} を使用します。",
    fastButtonNamePlaceholder: "名前",
    fastButtonMorphPlaceholder: "Morph",
    fastButtonRemove: "Fast Button を削除",
    baseImageLabel: "ベース画像: {path}",
    defaultImageAlreadyActive: "すでにデフォルト画像が有効です。",
    defaultImageActivated:
      "ベース画像を削除しました。eroLogo.png を使用します。",
    createCardInProgress: "Card PNG を作成中...",
    extractCardInProgress: "カードデータを抽出中...",
    morphDescTitle: "モーフ説明",
    morphDescIndexLabel: "インデックス",
    morphDescNameLabel: "名前",
    morphDescDescLabel: "説明",
    morphDescRemove: "削除",
    morphDescAdd: "モーフを追加",
    voiceCloneTitle: "ボイスクローンサンプル",
    voiceCloneFileNameLabel: "ファイル名",
    voiceCloneSampleNameLabel: "サンプル名",
    voiceCloneLocaleLabel: "ロケール",
    voiceCloneRemove: "削除",
    voiceCloneAdd: "サンプルを追加",
    voiceCloneHint:
      "voice_sample_*.webm または metadata.voiceSamples/ 内のファイルは、ボイスクローンオーディオとして埋め込まれます。",
    voiceCloneSelectFile: "ファイルを選択…",
    voiceClonePlay: "再生",
    voiceCloneStop: "停止",
    voiceCloneDurationError: "再生時間は3～20秒にしてください",
    voiceCloneFileMissing: "ファイルが見つかりません",
    voiceCloneLocalePlaceholder: "ロケールを選択…",
    webmAudioTitle: "WebMオーディオ",
    webmAudioSelectFile: "WebMファイルを選択…",
  };

  const zhCN: ConverterViewText = {
    heroTitle: "ero.dance 转换器",
    bpmxTitle: "将 BPMX 转换为 PMX",
    bpmxHint:
      "加载 .bpmx 文件，并输出一个包含 PMX 文件和所有嵌入纹理的 ZIP 压缩包。",
    bpmxDropLabel: "将 BPMX 文件拖到这里，或",
    pmxTitle: "将 PMX 转换为 BPMX",
    pmxHint:
      "加载完整的 PMX 模型文件夹（PMX + 纹理），可作为文件夹或 ZIP 压缩包。",
    motionTitle: "将类似 VMD / VPD / VMP 的姿态转换为 BVMD",
    motionHint:
      "加载 MMD 动作（.vmd）或文本姿态文件（.vpd、.vmp），并转换为 .bvmd。",
    motionDropLabel: "将动作文件拖到这里，或",
    motionSummaryTitle: "动作概览",
    bvmdTitle: "将 BVMD 转换为 VMD",
    bvmdHint:
      "加载 .bvmd 文件并导出为旧版 .vmd 文件：模型动画，若包含摄像机帧还会额外导出单独的摄像机 VMD。",
    bvmdDropLabel: "将 BVMD 文件拖到这里，或",
    audioTitle: "将 WAV 或 MP3 转换为 WebM 音频",
    audioHint:
      "加载 .wav 或 .mp3 文件，并将其导出为使用 Opus 编码的 .webm 音频文件。",
    audioDropLabel: "将音频文件拖到这里，或",
    audioSummaryTitle: "音频概览",
    cardCreateTitle: "创建卡片",
    cardCreateHint:
      "加载文件夹、ZIP 或单独文件，在需要时预先转换源格式，然后仅将新的卡片块写入 PNG。",
    cardCreateDropLabel: "将文件夹、ZIP 或单独文件拖到这里，或",
    cardCreatePreviewAlt: "卡片基础图像",
    cardCreatePreviewDefault: "基础图像: eroLogo.png",
    metadataEditSummary: "编辑元数据",
    editLabel: "编辑",
    uInfEditTitle: "编辑 uInf",
    fBtnEditTitle: "编辑 fBtn",
    moAiEditTitle: "编辑 moAi",
    authorLabel: "作者",
    characterTagsLabel: "角色标签",
    infoLabel: "信息",
    nameLabel: "名称",
    genderLabel: "性别",
    addButtonLabel: "添加按钮",
    creationReportTitle: "创建报告",
    noCardCreated: "尚未创建卡片。",
    cardExtractTitle: "从卡片提取 MMD",
    cardExtractHint:
      "加载 Card PNG，将已知私有块提取到 ZIP 中，并附带清理后的 ero.dance.png 图像。",
    cardExtractDropLabel: "将 Card PNG 拖到这里，或",
    convertLegacyMmdFiles: "转换为旧版 MMD 文件",
    extractionReportTitle: "提取报告",
    noExtractionYet: "尚未提取。",
    tabFooterLegal: "法律声明",
    tabFooterPrivacy: "隐私政策",
    tabFooterDocs: "文档",
    loadFile: "加载文件",
    loadFolder: "加载文件夹",
    loadZip: "加载 ZIP",
    loadFiles: "加载文件",
    chooseOtherImage: "选择其他图像",
    removeImage: "移除图像",
    remove: "移除",
    detectedFiles: "已识别文件",
    clearAll: "全部移除",
    textEncoding: "文本编码",
    restoreOriginalFormats: "尝试恢复为原始图像格式",
    convertToPmxZip: "转换为 PMX ZIP",
    convertToBpmx: "转换为 BPMX",
    convertToBvmd: "转换为 BVMD",
    convertToVmd: "转换为 VMD",
    convertToWebm: "转换为 WebM",
    createCardPng: "创建 Card PNG",
    extractAsZip: "提取为 ZIP",
    fidelityReportTitle: "保真度报告",
    warningsTitle: "警告",
    noConversionYet: "尚未转换。",
    textureCompression: "纹理压缩",
    compressLossless: "压缩（无损）",
    compressLossy: "有损压缩",
    rawNoCompression: "RAW（不压缩）",
    forceAvifLabel: "强制 AVIF",
    forceAvifSlow: "强制 AVIF（非常慢，但文件会很小）",
    pmxNoFileFound: "未找到 .pmx 文件。",
    pmxDropLabelDefault: "将文件夹或 ZIP 拖到这里，或",
    sourceFolder: "（文件夹）",
    sourceZip: "（ZIP）",
    sourceFolderDrop: "（拖放文件夹）",
    sourceZipDrop: "（拖放 ZIP）",
    sourceFiles: "（文件）",
    sourceFilesDrop: "（拖放文件）",
    sourceBaseImage: "（基础图像）",
    readZip: "正在读取 ZIP...",
    readFolder: "正在读取文件夹...",
    filesLoadedLabel: "已加载 {count} 个文件",
    filesLoadedStatus: "{ready} - 已加载 {count} 个文件。",
    filesLoadedFromSourceStatus: "{ready} - 已加载 {count} 个文件 {source}。",
    selectedFilesStatus:
      "{ready} - 已选择“{name}”，共 {count} 个文件 {source}。",
    optimizingTextures: "正在优化纹理 ({done}/{total})...",
    downloadedStatus: "完成 - 已下载 {file}。",
    downloadedTextureZipStatus: "完成 - 已下载包含 {count} 个纹理的 ZIP。",
    downloadedZipFilesStatus: "完成 - 已下载 ZIP 中的 {count} 个文件。",
    pleaseSelectBpmx: "请先选择 BPMX 文件。",
    pleaseLoadFolderOrZip: "请先加载文件夹或 ZIP。",
    pleaseSelectMotion: "请先选择动作文件。",
    pleaseSelectBvmd: "请先选择 BVMD 文件。",
    pleaseSelectAudio: "请先选择 WAV 或 MP3 文件。",
    pleaseSelectCardPng: "请先选择 Card PNG。",
    webmEncodingUnavailable: "此处无法使用 WebM 音频编码。",
    alreadyAvif: "已是 AVIF",
    losslessTag: "无损",
    lossyTag: "有损",
    noneLossy: "全部设为非有损",
    allLossy: "全部设为有损",
    forceAvifBusyTitle: "转换期间会被锁定。",
    rawDisableCompressionTitle: "RAW 会禁用图像压缩。",
    forceAvifTitle: "通过 @jsquash/avif 强制输出真正的 AVIF。",
    baseImageRole: "基础图像",
    baseImageAvailableRole: "可用基础图像",
    pmxSourceRole: "PMX 来源",
    motionSourceRole: "动作来源",
    audioSourceRole: "音频来源",
    genericFileRole: "文件",
    metadataSourceRolePrefix: "元数据",
    metadataMissingEditTemplate: "未加载 {file}。启用编辑后会嵌入新的内容。",
    metadataEditableWhenModelLoaded: "加载 PMX 或 BPMX 后即可编辑。",
    metadataSourceTemplate: "来源: {path}",
    metadataInvalidJsonTemplate: "来源: {path}（JSON 无效）",
    metadataInvalidJsonListTemplate: "无效 JSON: {paths}",
    metadataDuplicateRowTitle:
      "重复：与其他条目指向同一个形态。创建卡片时，以最后添加的条目为准。",
    metadataInvalidRowTitle: "无效：所选模型中不存在此形态，不会嵌入卡片。",
    metadataRemappedRowTemplate:
      "已重新映射：此条目的形态名称在索引 {to} 处找到，将使用 {to} 而非 {from}。",
    fastButtonNamePlaceholder: "名称",
    fastButtonMorphPlaceholder: "Morph",
    fastButtonRemove: "移除 Fast Button",
    baseImageLabel: "基础图像: {path}",
    defaultImageAlreadyActive: "默认图像已经处于启用状态。",
    defaultImageActivated: "已移除基础图像。将使用 eroLogo.png。",
    createCardInProgress: "正在创建 Card PNG...",
    extractCardInProgress: "正在提取卡片数据...",
    morphDescTitle: "变形描述",
    morphDescIndexLabel: "索引",
    morphDescNameLabel: "名称",
    morphDescDescLabel: "描述",
    morphDescRemove: "删除",
    morphDescAdd: "添加变形",
    voiceCloneTitle: "语音克隆样本",
    voiceCloneFileNameLabel: "文件名",
    voiceCloneSampleNameLabel: "样本名",
    voiceCloneLocaleLabel: "区域",
    voiceCloneRemove: "删除",
    voiceCloneAdd: "添加样本",
    voiceCloneHint:
      "名为 voice_sample_*.webm 或在 metadata.voiceSamples/ 中的文件将作为语音克隆音频嵌入。",
    voiceCloneSelectFile: "选择文件…",
    voiceClonePlay: "播放",
    voiceCloneStop: "停止",
    voiceCloneDurationError: "时长必须在3到20秒之间",
    voiceCloneFileMissing: "文件未找到",
    voiceCloneLocalePlaceholder: "选择区域…",
    webmAudioTitle: "WebM音频",
    webmAudioSelectFile: "选择WebM文件…",
  };

  const zhTW: ConverterViewText = {
    heroTitle: "ero.dance 轉換器",
    bpmxTitle: "將 BPMX 轉換為 PMX",
    bpmxHint:
      "載入 .bpmx 檔案，並輸出一個包含 PMX 檔案與所有內嵌材質的 ZIP 壓縮檔。",
    bpmxDropLabel: "將 BPMX 檔案拖曳到這裡，或",
    pmxTitle: "將 PMX 轉換為 BPMX",
    pmxHint:
      "載入完整的 PMX 模型資料夾（PMX + 材質），可使用資料夾或 ZIP 壓縮檔。",
    motionTitle: "將類似 VMD / VPD / VMP 的姿勢轉換為 BVMD",
    motionHint:
      "載入 MMD 動作（.vmd）或文字姿勢檔（.vpd、.vmp），並轉換為 .bvmd。",
    motionDropLabel: "將動作檔拖曳到這裡，或",
    motionSummaryTitle: "動作概覽",
    bvmdTitle: "將 BVMD 轉換為 VMD",
    bvmdHint:
      "載入 .bvmd 檔案並匯出為舊版 .vmd 檔案：模型動畫，若包含攝影機影格還會額外匯出單獨的攝影機 VMD。",
    bvmdDropLabel: "將 BVMD 檔拖曳到這裡，或",
    audioTitle: "將 WAV 或 MP3 轉換為 WebM 音訊",
    audioHint:
      "載入 .wav 或 .mp3 檔案，並將其匯出為使用 Opus 編碼的 .webm 音訊檔。",
    audioDropLabel: "將音訊檔拖曳到這裡，或",
    audioSummaryTitle: "音訊概覽",
    cardCreateTitle: "建立卡片",
    cardCreateHint:
      "載入資料夾、ZIP 或單一檔案，必要時先轉換來源格式，之後只將新的卡片區塊寫入 PNG。",
    cardCreateDropLabel: "將資料夾、ZIP 或單一檔案拖曳到這裡，或",
    cardCreatePreviewAlt: "卡片基底圖片",
    cardCreatePreviewDefault: "基底圖片: eroLogo.png",
    metadataEditSummary: "編輯中繼資料",
    editLabel: "編輯",
    uInfEditTitle: "編輯 uInf",
    fBtnEditTitle: "編輯 fBtn",
    moAiEditTitle: "編輯 moAi",
    authorLabel: "作者",
    characterTagsLabel: "角色標籤",
    infoLabel: "資訊",
    nameLabel: "名稱",
    genderLabel: "性別",
    addButtonLabel: "新增按鈕",
    creationReportTitle: "建立報告",
    noCardCreated: "尚未建立卡片。",
    cardExtractTitle: "從卡片擷取 MMD",
    cardExtractHint:
      "載入 Card PNG，將已知的私有區塊擷取到 ZIP 中，並附上清理後的 ero.dance.png 圖片。",
    cardExtractDropLabel: "將 Card PNG 拖曳到這裡，或",
    convertLegacyMmdFiles: "轉換為舊版 MMD 檔案",
    extractionReportTitle: "擷取報告",
    noExtractionYet: "尚未擷取。",
    tabFooterLegal: "法律聲明",
    tabFooterPrivacy: "隱私權政策",
    tabFooterDocs: "文件",
    loadFile: "載入檔案",
    loadFolder: "載入資料夾",
    loadZip: "載入 ZIP",
    loadFiles: "載入檔案",
    chooseOtherImage: "選擇其他圖片",
    removeImage: "移除圖片",
    remove: "移除",
    detectedFiles: "已偵測檔案",
    clearAll: "全部移除",
    textEncoding: "文字編碼",
    restoreOriginalFormats: "嘗試還原為原始圖片格式",
    convertToPmxZip: "轉換為 PMX ZIP",
    convertToBpmx: "轉換為 BPMX",
    convertToBvmd: "轉換為 BVMD",
    convertToVmd: "轉換為 VMD",
    convertToWebm: "轉換為 WebM",
    createCardPng: "建立 Card PNG",
    extractAsZip: "擷取為 ZIP",
    fidelityReportTitle: "保真報告",
    warningsTitle: "警告",
    noConversionYet: "尚未轉換。",
    textureCompression: "材質壓縮",
    compressLossless: "壓縮（無損）",
    compressLossy: "有損壓縮",
    rawNoCompression: "RAW（不壓縮）",
    forceAvifLabel: "強制 AVIF",
    forceAvifSlow: "強制 AVIF（非常慢，但檔案會很小）",
    pmxNoFileFound: "找不到 .pmx 檔案。",
    pmxDropLabelDefault: "將資料夾或 ZIP 拖曳到這裡，或",
    sourceFolder: "（資料夾）",
    sourceZip: "（ZIP）",
    sourceFolderDrop: "（拖放資料夾）",
    sourceZipDrop: "（拖放 ZIP）",
    sourceFiles: "（檔案）",
    sourceFilesDrop: "（拖放檔案）",
    sourceBaseImage: "（基底圖片）",
    readZip: "正在讀取 ZIP...",
    readFolder: "正在讀取資料夾...",
    filesLoadedLabel: "已載入 {count} 個檔案",
    filesLoadedStatus: "{ready} - 已載入 {count} 個檔案。",
    filesLoadedFromSourceStatus: "{ready} - 已載入 {count} 個檔案 {source}。",
    selectedFilesStatus:
      "{ready} - 已選取「{name}」，共 {count} 個檔案 {source}。",
    optimizingTextures: "正在最佳化材質 ({done}/{total})...",
    downloadedStatus: "完成 - 已下載 {file}。",
    downloadedTextureZipStatus: "完成 - 已下載包含 {count} 個材質的 ZIP。",
    downloadedZipFilesStatus: "完成 - 已下載 ZIP 中的 {count} 個檔案。",
    pleaseSelectBpmx: "請先選擇 BPMX 檔案。",
    pleaseLoadFolderOrZip: "請先載入資料夾或 ZIP。",
    pleaseSelectMotion: "請先選擇動作檔案。",
    pleaseSelectBvmd: "請先選擇 BVMD 檔案。",
    pleaseSelectAudio: "請先選擇 WAV 或 MP3 檔案。",
    pleaseSelectCardPng: "請先選擇 Card PNG。",
    webmEncodingUnavailable: "此處無法使用 WebM 音訊編碼。",
    alreadyAvif: "已是 AVIF",
    losslessTag: "無損",
    lossyTag: "有損",
    noneLossy: "全部設為非有損",
    allLossy: "全部設為有損",
    forceAvifBusyTitle: "轉換期間會被鎖定。",
    rawDisableCompressionTitle: "RAW 會停用圖片壓縮。",
    forceAvifTitle: "透過 @jsquash/avif 強制輸出真正的 AVIF。",
    baseImageRole: "基底圖片",
    baseImageAvailableRole: "可用基底圖片",
    pmxSourceRole: "PMX 來源",
    motionSourceRole: "動作來源",
    audioSourceRole: "音訊來源",
    genericFileRole: "檔案",
    metadataSourceRolePrefix: "中繼資料",
    metadataMissingEditTemplate: "尚未載入 {file}。啟用編輯後會內嵌新的內容。",
    metadataEditableWhenModelLoaded: "載入 PMX 或 BPMX 後即可編輯。",
    metadataSourceTemplate: "來源: {path}",
    metadataInvalidJsonTemplate: "來源: {path}（無效的 JSON）",
    metadataInvalidJsonListTemplate: "無效 JSON: {paths}",
    metadataDuplicateRowTitle:
      "重複：與其他條目指向同一個形態。建立卡片時，以最後新增的條目為準。",
    metadataInvalidRowTitle: "無效：所選模型中不存在此形態，不會嵌入卡片。",
    metadataRemappedRowTemplate:
      "已重新映射：此條目的形態名稱在索引 {to} 找到，將使用 {to} 而非 {from}。",
    fastButtonNamePlaceholder: "名稱",
    fastButtonMorphPlaceholder: "Morph",
    fastButtonRemove: "移除 Fast Button",
    baseImageLabel: "基底圖片: {path}",
    defaultImageAlreadyActive: "預設圖片已經啟用。",
    defaultImageActivated: "已移除基底圖片。將使用 eroLogo.png。",
    createCardInProgress: "正在建立 Card PNG...",
    extractCardInProgress: "正在擷取卡片資料...",
    morphDescTitle: "變形描述",
    morphDescIndexLabel: "索引",
    morphDescNameLabel: "名稱",
    morphDescDescLabel: "描述",
    morphDescRemove: "移除",
    morphDescAdd: "新增變形",
    voiceCloneTitle: "語音克隆樣本",
    voiceCloneFileNameLabel: "檔案名稱",
    voiceCloneSampleNameLabel: "樣本名稱",
    voiceCloneLocaleLabel: "地區",
    voiceCloneRemove: "移除",
    voiceCloneAdd: "新增樣本",
    voiceCloneHint:
      "名為 voice_sample_*.webm 或在 metadata.voiceSamples/ 中的檔案將作為語音克隆音訊嵌入。",
    voiceCloneSelectFile: "選擇檔案…",
    voiceClonePlay: "播放",
    voiceCloneStop: "停止",
    voiceCloneDurationError: "時長必須在3到20秒之間",
    voiceCloneFileMissing: "檔案未找到",
    voiceCloneLocalePlaceholder: "選擇地區…",
    webmAudioTitle: "WebM音訊",
    webmAudioSelectFile: "選擇WebM檔案…",
  };

  const map: Partial<Record<AppLocale, ConverterViewText>> = {
    de,
    en,
    ja,
    "zh-CN": zhCN,
    "zh-TW": zhTW,
  };
  return map[locale] ?? en;
}

export interface ConverterViewHandle {
  updateTheme: (nextTheme: AppTheme) => void;
}

export function mountConverterView(
  container: HTMLElement,
  options: MountConverterViewOptions,
): ConverterViewHandle {
  const errorStrings = getErrorStrings(options.locale);
  const viewStrings = getViewStrings(options.locale);
  const text = getConverterViewText(options.locale);
  let activeTheme: AppTheme = options.theme;
  const initialToggleTheme = activeTheme === "dark" ? "light" : "dark";
  const themeToggleLabel =
    initialToggleTheme === "dark"
      ? viewStrings.themeToDark
      : viewStrings.themeToLight;
  const themeToggleEmoji = initialToggleTheme === "dark" ? "🌙" : "☀️";
  const statusReady = viewStrings.statusReady;
  const statusErrorPrefix = viewStrings.statusErrorPrefix;
  const EMPTY_INPUT_STATUS = viewStrings.statusEmptyInput;

  container.innerHTML = `
    <main class="app-shell">
      <header class="hero">
        <div class="hero-top-row">
          <p class="hero-kicker">${viewStrings.heroKicker}</p>
          <div class="hero-controls">
            <label class="lang-picker" for="locale-select">
              <span>${viewStrings.language}</span>
              <select id="locale-select"></select>
            </label>
            <button
              id="theme-toggle"
              class="theme-toggle"
              type="button"
              aria-label="${themeToggleLabel}"
              title="${themeToggleLabel}"
              aria-pressed="${String(options.theme === "dark")}"
            >${themeToggleEmoji}</button>
          </div>
        </div>
        <h1>${text.heroTitle}</h1>
        <p class="hero-sub">${viewStrings.heroSubPrefix} <a href="https://github.com/KevinTuncer/mmd-card-converter" target="_blank">${viewStrings.heroSubLink}</a></p>
      </header>

      <!-- Tab bar -->
      <nav class="tab-bar">
        <button class="tab-btn tab-active" data-tab="cardcreate">${viewStrings.tabCardCreate}</button>
        <button class="tab-btn" data-tab="cardextract">${viewStrings.tabCardExtract}</button>
        <button class="tab-btn" data-tab="bpmx2pmx">${viewStrings.tabBpmxToPmx}</button>
        <button class="tab-btn" data-tab="pmx2bpmx">${viewStrings.tabPmxToBpmx}</button>
        <button class="tab-btn" data-tab="motion2bvmd">${viewStrings.tabMotionToBvmd}</button>
        <button class="tab-btn" data-tab="bvmd2vmd">${viewStrings.tabBvmdToVmd}</button>
        <button class="tab-btn" data-tab="audio2webm">${viewStrings.tabAudioToWebm}</button>
        <button class="tab-toggle-btn" id="tab-toggle-extra" type="button">${viewStrings.tabShowMore}</button>
      </nav>

      <!-- ── Tab: BPMX → PMX ── -->
      <section id="tab-bpmx2pmx" class="tab-panel panel" hidden>
        <h2>${text.bpmxTitle}</h2>
        <p class="hint">${text.bpmxHint}</p>

        <div class="drop-zone" id="bpmx-drop-zone">
          <div class="drop-zone-hint">
            <span class="drop-icon">📄</span>
            <span id="bpmx-drop-label">${text.bpmxDropLabel}</span>
          </div>
          <div class="drop-zone-buttons">
            <button class="drop-btn" id="bpmx-file-btn" type="button">📄 ${text.loadFile}</button>
          </div>
          <input id="bpmx-file" type="file" accept=".bpmx,application/octet-stream" hidden />
        </div>

        <div class="encoding-row">
          <label for="bpmx-encoding">${text.textEncoding}</label>
          <select id="bpmx-encoding">
            <option value="utf8" selected>UTF-8</option>
            <option value="utf16">UTF-16LE</option>
          </select>
          <label class="checkbox-label" for="bpmx-restore-original-formats">
            <input id="bpmx-restore-original-formats" type="checkbox" checked />
            ${text.restoreOriginalFormats}
          </label>
        </div>

        <div class="actions">
          <button id="bpmx-convert" type="button">${text.convertToPmxZip}</button>
          <span id="bpmx-status" class="status">${statusReady}</span>
        </div>

        <h3>${text.fidelityReportTitle}</h3>
        <pre id="bpmx-report" class="report">${text.noConversionYet}</pre>
        <h3>${text.warningsTitle}</h3>
        <pre id="bpmx-warnings" class="report">–</pre>
      </section>

      <!-- ── Tab: PMX → BPMX ── -->
      <section id="tab-pmx2bpmx" class="tab-panel panel" hidden>
        <h2>${text.pmxTitle}</h2>
        <p class="hint">${text.pmxHint}</p>

        <div class="drop-zone" id="pmx-drop-zone">
          <div class="drop-zone-hint">
            <span class="drop-icon">📁</span>
            <span id="pmx-drop-label">${text.pmxDropLabelDefault}</span>
          </div>
          <div class="drop-zone-buttons">
            <button class="drop-btn" id="pmx-folder-btn" type="button">📁 ${text.loadFolder}</button>
            <button class="drop-btn" id="pmx-zip-btn" type="button">📄 ${text.loadZip}</button>
          </div>
          <input id="pmx-folder" type="file" webkitdirectory multiple hidden />
          <input id="pmx-zip" type="file" accept=".zip,application/zip" hidden />
        </div>

        <div id="pmx-file-list-wrap" class="file-list-wrap" hidden>
          <div class="file-list-header">
            <h3>${text.detectedFiles}</h3>
          </div>
          <ul class="file-list" id="pmx-file-list"></ul>
        </div>

        <div class="options-row">
          <label for="pmx-compress-mode">${text.textureCompression}</label>
          <select id="pmx-compress-mode">
            <option value="lossless" selected>${text.compressLossless}</option>
            <option value="lossy">${text.compressLossy}</option>
            <option value="raw">${text.rawNoCompression}</option>
          </select>
          <label class="checkbox-label" for="pmx-force-avif">
            <input id="pmx-force-avif" type="checkbox" />
            ${text.forceAvifSlow}
          </label>
          <button class="drop-btn" id="pmx-select-all-compress" type="button" hidden>Alle verlustbehaftet</button>
        </div>

        <div class="actions">
          <button id="pmx-convert" type="button">${text.convertToBpmx}</button>
          <span id="pmx-status" class="status">${statusReady}</span>
        </div>
      </section>

      <section id="tab-motion2bvmd" class="tab-panel panel" hidden>
        <h2>${text.motionTitle}</h2>
        <p class="hint">${text.motionHint}</p>

        <div class="drop-zone" id="motion-drop-zone">
          <div class="drop-zone-hint">
            <span class="drop-icon">🎞️</span>
            <span id="motion-drop-label">${text.motionDropLabel}</span>
          </div>
          <div class="drop-zone-buttons">
            <button class="drop-btn" id="motion-file-btn" type="button">🎞️ ${text.loadFile}</button>
          </div>
          <input id="motion-file" type="file" accept=".vmd,.vpd,.vmp,.bvmd,text/plain,application/octet-stream" hidden />
        </div>

        <div class="actions">
          <button id="motion-convert" type="button">${text.convertToBvmd}</button>
          <span id="motion-status" class="status">${statusReady}</span>
        </div>

        <h3>${text.motionSummaryTitle}</h3>
        <pre id="motion-summary" class="report">${text.noConversionYet}</pre>
      </section>

      <section id="tab-bvmd2vmd" class="tab-panel panel" hidden>
        <h2>${text.bvmdTitle}</h2>
        <p class="hint">${text.bvmdHint}</p>

        <div class="drop-zone" id="bvmd-motion-drop-zone">
          <div class="drop-zone-hint">
            <span class="drop-icon">🎬</span>
            <span id="bvmd-motion-drop-label">${text.bvmdDropLabel}</span>
          </div>
          <div class="drop-zone-buttons">
            <button class="drop-btn" id="bvmd-motion-file-btn" type="button">🎬 ${text.loadFile}</button>
          </div>
          <input id="bvmd-motion-file" type="file" accept=".bvmd,application/octet-stream" hidden />
        </div>

        <div class="actions">
          <button id="bvmd-motion-convert" type="button">${text.convertToVmd}</button>
          <span id="bvmd-motion-status" class="status">${statusReady}</span>
        </div>

        <h3>${text.motionSummaryTitle}</h3>
        <pre id="bvmd-motion-summary" class="report">${text.noConversionYet}</pre>
      </section>

      <section id="tab-audio2webm" class="tab-panel panel" hidden>
        <h2>${text.audioTitle}</h2>
        <p class="hint">${text.audioHint}</p>

        <div class="drop-zone" id="audio-drop-zone">
          <div class="drop-zone-hint">
            <span class="drop-icon">🎵</span>
            <span id="audio-drop-label">${text.audioDropLabel}</span>
          </div>
          <div class="drop-zone-buttons">
            <button class="drop-btn" id="audio-file-btn" type="button">🎵 ${text.loadFile}</button>
          </div>
          <input id="audio-file" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" hidden />
        </div>

        <div class="actions">
          <button id="audio-convert" type="button">${text.convertToWebm}</button>
          <span id="audio-status" class="status">${statusReady}</span>
        </div>

        <h3>${text.audioSummaryTitle}</h3>
        <pre id="audio-summary" class="report">${text.noConversionYet}</pre>
      </section>

      <section id="tab-cardcreate" class="tab-panel panel">
        <h2>${text.cardCreateTitle}</h2>
        <p class="hint">${text.cardCreateHint}</p>

        <div class="drop-zone" id="cardcreate-drop-zone">
          <div class="drop-zone-hint">
            <span class="drop-icon">🧩</span>
            <span id="cardcreate-drop-label">${text.cardCreateDropLabel}</span>
          </div>
          <div class="drop-zone-buttons">
            <button class="drop-btn" id="cardcreate-folder-btn" type="button">📁 ${text.loadFolder}</button>
            <button class="drop-btn" id="cardcreate-zip-btn" type="button">📦 ${text.loadZip}</button>
            <button class="drop-btn" id="cardcreate-files-btn" type="button">📄 ${text.loadFiles}</button>
          </div>
          <input id="cardcreate-folder" type="file" webkitdirectory multiple hidden />
          <input id="cardcreate-zip" type="file" accept=".zip,application/zip" hidden />
          <input id="cardcreate-files" type="file" multiple hidden />
          <input id="cardcreate-image-file" type="file" accept=".png,image/png" hidden />
        </div>

        <div id="cardcreate-file-list-wrap" class="file-list-wrap" hidden>
          <div class="file-list-header">
            <h3>${text.detectedFiles}</h3>
            <button class="drop-btn" id="cardcreate-clear-all" type="button">${text.clearAll}</button>
          </div>
          <ul class="file-list" id="cardcreate-file-list"></ul>
        </div>

        <div class="card-preview-block">
          <div class="card-preview-frame">
            <img id="cardcreate-preview-image" alt="${text.cardCreatePreviewAlt}" />
          </div>
          <div class="card-preview-meta">
            <span id="cardcreate-preview-source" class="status">${text.cardCreatePreviewDefault}</span>
            <div class="card-preview-actions">
              <button class="drop-btn" id="cardcreate-remove-image" type="button">${text.removeImage}</button>
              <button class="drop-btn" id="cardcreate-replace-image" type="button">${text.chooseOtherImage}</button>
            </div>
          </div>
        </div>

        <div class="card-webm-audio-block">
          <h3 class="card-subsection-title">${text.webmAudioTitle}</h3>
          <div id="cardcreate-webm-audio-select" class="card-webm-audio-select-wrap"></div>
        </div>

        <details class="card-metadata-expander">
          <summary>${text.metadataEditSummary}</summary>
          <div class="card-metadata-grid">
            <section class="card-metadata-panel">
              <div class="card-metadata-header">
                <div>
                  <h3>${text.uInfEditTitle}</h3>
                  <p id="cardcreate-uinf-source" class="status">${formatTemplate(text.metadataMissingEditTemplate, { file: "metadata.uInf.json" })}</p>
                </div>
                <label class="checkbox-label" for="cardcreate-uinf-edit">
                  <input id="cardcreate-uinf-edit" type="checkbox" disabled />
                  ${text.editLabel}
                </label>
              </div>
              <div id="cardcreate-uinf-fields" class="card-metadata-fields card-metadata-fields-disabled">
                <label class="card-field-label" for="cardcreate-uinf-auth">${text.authorLabel}</label>
                <input id="cardcreate-uinf-auth" type="text" />
                <label class="card-field-label" for="cardcreate-uinf-ch">${text.characterTagsLabel}</label>
                <textarea id="cardcreate-uinf-ch" rows="3"></textarea>
                <label class="card-field-label" for="cardcreate-uinf-info">${text.infoLabel}</label>
                <textarea id="cardcreate-uinf-info" rows="4"></textarea>
              </div>
            </section>

            <section class="card-metadata-panel">
              <div class="card-metadata-header">
                <div>
                  <h3>${text.fBtnEditTitle}</h3>
                  <p id="cardcreate-fbtn-source" class="status">${formatTemplate(text.metadataMissingEditTemplate, { file: "metadata.fBtn.json" })}</p>
                </div>
                <label class="checkbox-label" for="cardcreate-fbtn-edit">
                  <input id="cardcreate-fbtn-edit" type="checkbox" disabled />
                  ${text.editLabel}
                </label>
              </div>
              <div id="cardcreate-fbtn-fields" class="card-metadata-fields card-metadata-fields-disabled">
                <div id="cardcreate-fbtn-list" class="card-fast-button-list"></div>
                <button class="drop-btn" id="cardcreate-fbtn-add" type="button">${text.addButtonLabel}</button>
              </div>
            </section>

            <section class="card-metadata-panel">
              <div class="card-metadata-header">
                <div>
                  <h3>${text.moAiEditTitle}</h3>
                  <p id="cardcreate-moai-source" class="status">${formatTemplate(text.metadataMissingEditTemplate, { file: "metadata.moAi.json" })}</p>
                </div>
                <label class="checkbox-label" for="cardcreate-moai-edit">
                  <input id="cardcreate-moai-edit" type="checkbox" disabled />
                  ${text.editLabel}
                </label>
              </div>
              <div id="cardcreate-moai-fields" class="card-metadata-fields card-metadata-fields-disabled">
                <label class="card-field-label" for="cardcreate-moai-name">${text.nameLabel}</label>
                <input id="cardcreate-moai-name" type="text" />
                <label class="card-field-label" for="cardcreate-moai-gender">${text.genderLabel}</label>
                <input id="cardcreate-moai-gender" type="text" />
                <label class="card-field-label" for="cardcreate-moai-info">${text.infoLabel}</label>
                <textarea id="cardcreate-moai-info" rows="4"></textarea>

                <h4 class="card-subsection-title">${text.morphDescTitle}</h4>
                <div id="cardcreate-morph-list" class="card-fast-button-list"></div>
                <button class="drop-btn" id="cardcreate-morph-add" type="button">${text.morphDescAdd}</button>

                <h4 class="card-subsection-title">${text.voiceCloneTitle}</h4>
                <div id="cardcreate-voice-list" class="card-fast-button-list"></div>
                <button class="drop-btn" id="cardcreate-voice-add" type="button">${text.voiceCloneAdd}</button>
                <p class="status" id="cardcreate-voice-hint">${text.voiceCloneHint}</p>
              </div>
            </section>
          </div>
        </details>

        <div class="options-row">
          <label for="cardcreate-compress-mode">${text.textureCompression}</label>
          <select id="cardcreate-compress-mode">
            <option value="lossless" selected>${text.compressLossless}</option>
            <option value="lossy">${text.compressLossy}</option>
            <option value="raw">${text.rawNoCompression}</option>
          </select>
          <label class="checkbox-label" for="cardcreate-force-avif">
            <input id="cardcreate-force-avif" type="checkbox" />
            ${text.forceAvifLabel}
          </label>
          <button class="drop-btn" id="cardcreate-select-all-compress" type="button" hidden>${text.allLossy}</button>
        </div>

        <div class="actions">
          <button id="cardcreate-build" type="button">${text.createCardPng}</button>
          <span id="cardcreate-status" class="status">${statusReady}</span>
        </div>

        <h3>${text.creationReportTitle}</h3>
        <pre id="cardcreate-summary" class="report">${text.noCardCreated}</pre>
      </section>

      <section id="tab-cardextract" class="tab-panel panel" hidden>
        <h2>${text.cardExtractTitle}</h2>
        <p class="hint">${text.cardExtractHint}</p>

        <div class="drop-zone" id="cardextract-drop-zone">
          <div class="drop-zone-hint">
            <span class="drop-icon">🖼️</span>
            <span id="cardextract-drop-label">${text.cardExtractDropLabel}</span>
          </div>
          <div class="drop-zone-buttons">
            <button class="drop-btn" id="cardextract-file-btn" type="button">🖼️ ${text.loadFile}</button>
          </div>
          <input id="cardextract-file" type="file" accept=".png,image/png" hidden />
        </div>

        <div class="encoding-row">
          <label class="checkbox-label" for="cardextract-convert-legacy">
            <input id="cardextract-convert-legacy" type="checkbox" />
            ${text.convertLegacyMmdFiles}
          </label>
        </div>

        <div id="cardextract-legacy-options" class="encoding-row" hidden>
          <label for="cardextract-encoding">${text.textEncoding}</label>
          <select id="cardextract-encoding">
            <option value="utf8" selected>UTF-8</option>
            <option value="utf16">UTF-16LE</option>
          </select>
          <label class="checkbox-label" for="cardextract-restore-original-formats">
            <input id="cardextract-restore-original-formats" type="checkbox" checked />
            ${text.restoreOriginalFormats}
          </label>
        </div>

        <div class="actions">
          <button id="cardextract-extract" type="button">${text.extractAsZip}</button>
          <span id="cardextract-status" class="status">${statusReady}</span>
        </div>

        <h3>${text.extractionReportTitle}</h3>
        <pre id="cardextract-summary" class="report">${text.noExtractionYet}</pre>
      </section>

      <footer class="app-footer">
        <a href="https://docs.ero.dance/legal-notice.html" target="_blank" rel="noreferrer">${text.tabFooterLegal}</a>
        <a href="https://docs.ero.dance/privacy-policy.html" target="_blank" rel="noreferrer">${text.tabFooterPrivacy}</a>
        <a href="https://docs.ero.dance/" target="_blank" rel="noreferrer">${text.tabFooterDocs}</a>
        <a href="https://discord.com/invite/sM2dcgpMRC" target="_blank" rel="noreferrer">Discord</a>
      </footer>
    </main>
  `;

  // ── Tab switching ──────────────────────────────────────────────────────────
  const tabBtns = container.querySelectorAll<HTMLButtonElement>(".tab-btn");
  const tabPanels = container.querySelectorAll<HTMLElement>(".tab-panel");
  const themeToggleBtn =
    container.querySelector<HTMLButtonElement>("#theme-toggle")!;
  const localeSelect =
    container.querySelector<HTMLSelectElement>("#locale-select")!;
  const extraTabToggleBtn =
    container.querySelector<HTMLButtonElement>("#tab-toggle-extra")!;
  const knownTabs = new Set(
    Array.from(tabBtns, (btn) => btn.dataset.tab ?? "").filter(Boolean),
  );
  const primaryTabs = new Set(["cardcreate", "cardextract"]);
  let showExtraTabs = false;

  for (const locale of Object.keys(LOCALE_LABELS) as AppLocale[]) {
    const option = document.createElement("option");
    option.value = locale;
    option.textContent = LOCALE_LABELS[locale];
    option.selected = locale === options.locale;
    localeSelect.append(option);
  }
  localeSelect.addEventListener("change", () => {
    const nextLocale = normalizeLocale(localeSelect.value);
    if (!nextLocale || nextLocale === options.locale) return;
    options.onLocaleChange(nextLocale);
  });
  themeToggleBtn.addEventListener("click", () => {
    const toggleTo = activeTheme === "dark" ? "light" : "dark";
    options.onThemeToggle(toggleTo);
  });

  function getActiveTab(): string {
    return (
      Array.from(tabBtns).find((btn) => btn.classList.contains("tab-active"))
        ?.dataset.tab ?? "cardcreate"
    );
  }

  function syncTabVisibility(activeTab: string): void {
    tabBtns.forEach((btn) => {
      const tab = btn.dataset.tab;
      if (!tab) return;
      const isPrimary = primaryTabs.has(tab);
      const isActive = tab === activeTab;
      btn.hidden = !(isPrimary || showExtraTabs || isActive);
    });

    extraTabToggleBtn.textContent = showExtraTabs
      ? viewStrings.tabShowLess
      : viewStrings.tabShowMore;
    extraTabToggleBtn.setAttribute("aria-expanded", String(showExtraTabs));
  }

  function activateTab(target: string, updateHash: boolean): void {
    if (!knownTabs.has(target)) {
      return;
    }

    tabBtns.forEach((btn) => {
      btn.classList.toggle("tab-active", btn.dataset.tab === target);
    });
    tabPanels.forEach((panel) => {
      panel.hidden = panel.id !== `tab-${target}`;
    });
    syncTabVisibility(target);

    if (updateHash && window.location.hash !== `#${target}`) {
      window.location.hash = target;
    }
  }

  function getRequestedTabFromHash(): string {
    const requestedTab = window.location.hash.replace(/^#/, "");
    return knownTabs.has(requestedTab) ? requestedTab : "cardcreate";
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      if (!target) return;
      activateTab(target, true);
    });
  });
  extraTabToggleBtn.addEventListener("click", () => {
    showExtraTabs = !showExtraTabs;
    syncTabVisibility(getActiveTab());
  });
  window.addEventListener("hashchange", () => {
    activateTab(getRequestedTabFromHash(), false);
  });
  activateTab(getRequestedTabFromHash(), false);

  // ── BPMX → PMX ────────────────────────────────────────────────────────────

  const bpmxDropZone =
    container.querySelector<HTMLDivElement>("#bpmx-drop-zone")!;
  const bpmxFileBtn =
    container.querySelector<HTMLButtonElement>("#bpmx-file-btn")!;
  const bpmxFileInput =
    container.querySelector<HTMLInputElement>("#bpmx-file")!;
  const bpmxDropLabel =
    container.querySelector<HTMLSpanElement>("#bpmx-drop-label")!;
  const bpmxEncoding =
    container.querySelector<HTMLSelectElement>("#bpmx-encoding")!;
  const bpmxRestoreOriginalFormatsInput =
    container.querySelector<HTMLInputElement>(
      "#bpmx-restore-original-formats",
    )!;
  const bpmxConvertBtn =
    container.querySelector<HTMLButtonElement>("#bpmx-convert")!;
  const bpmxStatus = container.querySelector<HTMLSpanElement>("#bpmx-status")!;
  const bpmxReport = container.querySelector<HTMLPreElement>("#bpmx-report")!;
  const bpmxWarnings =
    container.querySelector<HTMLPreElement>("#bpmx-warnings")!;

  let stagedBpmxFile: File | null = null;
  let bpmxBusy = false;

  function syncBpmxAvailability(): void {
    bpmxConvertBtn.disabled = bpmxBusy || stagedBpmxFile === null;
    if (!bpmxBusy && stagedBpmxFile === null) {
      bpmxStatus.textContent = EMPTY_INPUT_STATUS;
    }
  }

  function setStagedBpmxFile(file: File): void {
    stagedBpmxFile = file;
    bpmxDropLabel.textContent = `${file.name} (${formatSize(file.size)})`;
    bpmxStatus.textContent = `${statusReady} - ${file.name}`;
    syncBpmxAvailability();
  }

  bpmxFileBtn.addEventListener("click", () => bpmxFileInput.click());

  bpmxFileInput.addEventListener("change", () => {
    const file = bpmxFileInput.files?.[0];
    bpmxFileInput.value = "";
    if (file) setStagedBpmxFile(file);
  });

  bpmxDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    bpmxDropZone.classList.add("drag-over");
  });
  bpmxDropZone.addEventListener("dragleave", () => {
    bpmxDropZone.classList.remove("drag-over");
  });
  bpmxDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    bpmxDropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) setStagedBpmxFile(file);
  });

  bpmxConvertBtn.addEventListener("click", async () => {
    if (!stagedBpmxFile) {
      bpmxStatus.textContent = text.pleaseSelectBpmx;
      return;
    }
    bpmxStatus.textContent = viewStrings.statusConverting;
    bpmxBusy = true;
    bpmxConvertBtn.disabled = true;
    bpmxEncoding.disabled = true;
    bpmxRestoreOriginalFormatsInput.disabled = true;
    try {
      const encoding =
        bpmxEncoding.value === "utf16"
          ? PmxObject.Header.Encoding.Utf16le
          : PmxObject.Header.Encoding.Utf8;

      const result = await convertBpmxToPmx(
        await stagedBpmxFile.arrayBuffer(),
        {
          encoding,
          restoreOriginalImageFormats: bpmxRestoreOriginalFormatsInput.checked,
        },
      );

      downloadAs(
        result.zipBuffer,
        `${stripExt(stagedBpmxFile.name)}.zip`,
        "application/zip",
      );
      bpmxReport.textContent = JSON.stringify(result.report.totals, null, 2);
      renderWarnings(
        bpmxWarnings,
        result.report.warnings,
        viewStrings.noWarnings,
      );
      bpmxStatus.textContent = formatTemplate(text.downloadedTextureZipStatus, {
        count: result.report.totals.textures,
      });
    } catch (err) {
      bpmxStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      bpmxBusy = false;
      bpmxEncoding.disabled = false;
      bpmxRestoreOriginalFormatsInput.disabled = false;
      syncBpmxAvailability();
    }
  });

  syncBpmxAvailability();

  // ── PMX → BPMX ────────────────────────────────────────────────────────────

  const pmxDropZone =
    container.querySelector<HTMLDivElement>("#pmx-drop-zone")!;
  const pmxFolderBtn =
    container.querySelector<HTMLButtonElement>("#pmx-folder-btn")!;
  const pmxZipBtn = container.querySelector<HTMLButtonElement>("#pmx-zip-btn")!;
  const pmxFolderInput =
    container.querySelector<HTMLInputElement>("#pmx-folder")!;
  const pmxZipInput = container.querySelector<HTMLInputElement>("#pmx-zip")!;
  const pmxDropLabel =
    container.querySelector<HTMLSpanElement>("#pmx-drop-label")!;
  const pmxFileListWrap = container.querySelector<HTMLDivElement>(
    "#pmx-file-list-wrap",
  )!;
  const pmxFileListEl =
    container.querySelector<HTMLUListElement>("#pmx-file-list")!;
  const pmxCompressModeSelect =
    container.querySelector<HTMLSelectElement>("#pmx-compress-mode")!;
  const pmxForceAvifInput =
    container.querySelector<HTMLInputElement>("#pmx-force-avif")!;
  const pmxSelectAllCompressBtn = container.querySelector<HTMLButtonElement>(
    "#pmx-select-all-compress",
  )!;
  const pmxConvertBtn =
    container.querySelector<HTMLButtonElement>("#pmx-convert")!;
  const pmxStatus = container.querySelector<HTMLSpanElement>("#pmx-status")!;

  let stagedPmxFile: File | null = null;
  let stagedAllFiles: File[] = [];
  let compressToAvifSet: Set<File> = new Set();
  let actualResultFiles: File[] | null = null;
  let pmxBusy = false;

  function syncPmxAvailability(): void {
    pmxConvertBtn.disabled = pmxBusy || stagedPmxFile === null;
    if (!pmxBusy && stagedAllFiles.length === 0) {
      pmxStatus.textContent = EMPTY_INPUT_STATUS;
    }
  }

  function modeLabel(mode: string): string {
    if (mode === "lossless") return text.losslessTag;
    if (mode === "lossy") return text.lossyTag;
    if (mode === "already-avif") return text.alreadyAvif;
    return "";
  }

  function getEffectiveCompressionMode(
    originalFile: File,
    resultFile: File,
  ): string {
    if (resultFile.type !== "image/avif") {
      return "lossless";
    }

    const requestedLossy =
      pmxCompressModeSelect.value === "lossy" &&
      compressToAvifSet.has(originalFile);

    return requestedLossy ? "lossy" : "lossless";
  }

  function buildResultSpan(
    originalFile: File,
    resultFile: File,
  ): HTMLSpanElement {
    const sizeAfter = document.createElement("span");
    sizeAfter.className = "size-after";
    const sizeValEl = document.createElement("span");
    sizeValEl.className = "size-value";
    const fmtTagEl = document.createElement("span");
    fmtTagEl.className = "fmt-tag";
    const modeTagEl = document.createElement("span");
    modeTagEl.className = "mode-tag";
    if (resultFile !== originalFile) {
      sizeValEl.textContent = "\u2192 " + formatSize(resultFile.size);
      sizeAfter.classList.add("size-smaller");
      fmtTagEl.textContent =
        resultFile.type === "image/avif"
          ? "AVIF"
          : (resultFile.type.split("/")[1]?.toUpperCase() ?? resultFile.type);
      const mode = getEffectiveCompressionMode(originalFile, resultFile);
      modeTagEl.textContent =
        mode === "lossy"
          ? `Q${Math.round(LOSSY_QUALITY * 100)}`
          : modeLabel(mode);
      modeTagEl.dataset.mode = mode;
      modeTagEl.hidden = false;
    } else {
      sizeValEl.textContent = "=";
      fmtTagEl.textContent = "";
      modeTagEl.hidden = true;
    }
    sizeAfter.append(sizeValEl, fmtTagEl, modeTagEl);
    return sizeAfter;
  }

  function updateSelectAllBtn(): void {
    const compressible = stagedAllFiles.filter((f) =>
      COMPRESSIBLE_IMAGE_EXTS.has(getFileExt(f.name)),
    );
    const allSelected =
      compressible.length > 0 &&
      compressible.every((f) => compressToAvifSet.has(f));
    pmxSelectAllCompressBtn.textContent = allSelected
      ? text.noneLossy
      : text.allLossy;
  }

  function updateForceAvifInput(): void {
    const disabled = pmxBusy || pmxCompressModeSelect.value === "raw";
    pmxForceAvifInput.disabled = disabled;
    pmxForceAvifInput.title = disabled
      ? pmxBusy
        ? text.forceAvifBusyTitle
        : text.rawDisableCompressionTitle
      : text.forceAvifTitle;
  }

  function setPmxBusy(nextBusy: boolean): void {
    pmxBusy = nextBusy;
    pmxFolderBtn.disabled = nextBusy;
    pmxZipBtn.disabled = nextBusy;
    pmxFolderInput.disabled = nextBusy;
    pmxZipInput.disabled = nextBusy;
    pmxCompressModeSelect.disabled = nextBusy;
    pmxSelectAllCompressBtn.disabled = nextBusy;
    pmxConvertBtn.disabled = nextBusy || stagedPmxFile === null;
    tabBtns.forEach((btn) => {
      btn.disabled = nextBusy;
    });
    pmxDropZone.classList.toggle("drop-zone-disabled", nextBusy);
    pmxFileListEl.classList.toggle("file-list-disabled", nextBusy);
    updateForceAvifInput();
    renderFileList();
    syncPmxAvailability();
  }

  // ── File list rendering ──────────────────────────────────────────────────

  function renderFileList(): void {
    pmxFileListEl.innerHTML = "";

    for (const file of stagedAllFiles) {
      const relPath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ??
        file.name;
      const isPmx = relPath.toLowerCase().endsWith(".pmx");

      const li = document.createElement("li");
      li.classList.add(isPmx ? "pmx-entry" : "other-entry");

      if (isPmx) {
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "pmx-selector";
        radio.value = relPath;
        radio.checked = file === stagedPmxFile;
        radio.disabled = pmxBusy;
        radio.addEventListener("change", () => {
          if (pmxBusy) return;
          if (radio.checked) stagedPmxFile = file;
        });

        const pathSpan = document.createElement("span");
        pathSpan.className = "file-path";
        pathSpan.textContent = relPath;

        const meta = document.createElement("span");
        meta.className = "file-meta";
        meta.textContent = formatSize(file.size);

        li.append(radio, pathSpan, meta);

        // Clicking anywhere in the row selects this PMX
        li.addEventListener("click", (e) => {
          if (pmxBusy) return;
          if ((e.target as HTMLElement).tagName !== "INPUT") {
            radio.checked = true;
            stagedPmxFile = file;
          }
        });
      } else {
        const pathSpan = document.createElement("span");
        pathSpan.className = "file-path";
        pathSpan.textContent = relPath;

        const meta = document.createElement("span");
        meta.className = "file-meta";
        meta.textContent = formatSize(file.size);

        const fileIdx = stagedAllFiles.indexOf(file);
        li.dataset.fileIdx = String(fileIdx);

        const isCompressible = COMPRESSIBLE_IMAGE_EXTS.has(getFileExt(relPath));
        const compressionMode = pmxCompressModeSelect.value;
        if (isCompressible && compressionMode !== "raw") {
          if (compressionMode === "lossy") {
            li.classList.add("compressible-entry");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "compress-check";
            cb.checked = compressToAvifSet.has(file);
            cb.disabled = pmxBusy;
            cb.addEventListener("change", () => {
              if (pmxBusy) return;
              if (cb.checked) compressToAvifSet.add(file);
              else compressToAvifSet.delete(file);
              updateSelectAllBtn();
              actualResultFiles = null;
              renderFileList();
            });
            li.addEventListener("click", (e) => {
              if (pmxBusy) return;
              if ((e.target as HTMLElement).tagName !== "INPUT") {
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event("change"));
              }
            });
            if (actualResultFiles !== null) {
              li.append(
                cb,
                pathSpan,
                meta,
                buildResultSpan(file, actualResultFiles[fileIdx]),
              );
            } else {
              li.append(cb, pathSpan, meta);
            }
          } else {
            // lossless mode: no per-file checkbox, but show result after conversion
            if (actualResultFiles !== null) {
              li.append(
                pathSpan,
                meta,
                buildResultSpan(file, actualResultFiles[fileIdx]),
              );
            } else {
              li.append(pathSpan, meta);
            }
          }
        } else {
          li.append(pathSpan, meta);
        }
      }

      pmxFileListEl.appendChild(li);
    }

    pmxFileListWrap.hidden = false;
  }

  function stageFiles(
    allFiles: File[],
    defaultPmx: File | null,
    sourceLabel: string,
  ): void {
    stagedAllFiles = allFiles;
    stagedPmxFile = defaultPmx;
    compressToAvifSet = new Set(
      allFiles.filter((f) => COMPRESSIBLE_IMAGE_EXTS.has(getFileExt(f.name))),
    );

    if (!stagedPmxFile) {
      pmxStatus.textContent = text.pmxNoFileFound;
      pmxDropLabel.textContent = text.pmxDropLabelDefault;
    } else {
      pmxStatus.textContent = formatTemplate(text.selectedFilesStatus, {
        ready: statusReady,
        name: stagedPmxFile.name,
        count: allFiles.length,
        source: sourceLabel,
      });
      pmxDropLabel.textContent = formatTemplate(text.filesLoadedLabel, {
        count: allFiles.length,
      });
    }

    actualResultFiles = null;
    renderFileList();
    if (pmxCompressModeSelect.value === "lossy") updateSelectAllBtn();
    syncPmxAvailability();
  }

  // ── Input wiring ──────────────────────────────────────────────────────────

  pmxFolderBtn.addEventListener("click", () => {
    if (pmxBusy) return;
    pmxFolderInput.click();
  });
  pmxZipBtn.addEventListener("click", () => {
    if (pmxBusy) return;
    pmxZipInput.click();
  });

  pmxFolderInput.addEventListener("change", () => {
    if (pmxBusy) return;
    const files = Array.from(pmxFolderInput.files ?? []);
    if (files.length === 0) return;
    stageFiles(files, pickDefaultPmx(files), text.sourceFolder);
    pmxZipInput.value = "";
  });

  pmxZipInput.addEventListener("change", async () => {
    if (pmxBusy) return;
    const zipFile = pmxZipInput.files?.[0];
    if (!zipFile) return;
    pmxStatus.textContent = text.readZip;
    try {
      const { pmxFile, allFiles } = readZip(await zipFile.arrayBuffer());
      stageFiles(allFiles, pmxFile, text.sourceZip);
      pmxFolderInput.value = "";
    } catch (err) {
      pmxStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  pmxCompressModeSelect.addEventListener("change", () => {
    if (pmxBusy) return;
    pmxSelectAllCompressBtn.hidden = pmxCompressModeSelect.value !== "lossy";
    actualResultFiles = null;
    updateForceAvifInput();
    renderFileList();
    if (pmxCompressModeSelect.value === "lossy") updateSelectAllBtn();
  });

  updateForceAvifInput();
  syncPmxAvailability();

  pmxSelectAllCompressBtn.addEventListener("click", () => {
    if (pmxBusy) return;
    const compressible = stagedAllFiles.filter((f) =>
      COMPRESSIBLE_IMAGE_EXTS.has(getFileExt(f.name)),
    );
    const allSelected = compressible.every((f) => compressToAvifSet.has(f));
    if (allSelected) {
      compressible.forEach((f) => compressToAvifSet.delete(f));
    } else {
      compressible.forEach((f) => compressToAvifSet.add(f));
    }
    actualResultFiles = null;
    renderFileList();
    updateSelectAllBtn();
  });

  // ── Drag & Drop for PMX zone ──────────────────────────────────────────────

  pmxDropZone.addEventListener("dragover", (e) => {
    if (pmxBusy) return;
    e.preventDefault();
    pmxDropZone.classList.add("drag-over");
  });
  pmxDropZone.addEventListener("dragleave", () => {
    if (pmxBusy) return;
    pmxDropZone.classList.remove("drag-over");
  });
  pmxDropZone.addEventListener("drop", async (e) => {
    if (pmxBusy) return;
    e.preventDefault();
    pmxDropZone.classList.remove("drag-over");
    if (!e.dataTransfer) return;

    const items = Array.from(e.dataTransfer.items);
    if (items.length === 0) return;

    // Prefer FileSystem API so we can read directory entries recursively.
    const firstEntry = items[0].webkitGetAsEntry?.();

    if (!firstEntry) {
      // FileSystem API unavailable – fall back to single-file ZIP
      const file = e.dataTransfer.files[0];
      if (!file) return;
      await loadZipFile(file);
      return;
    }

    if (firstEntry.isDirectory) {
      pmxStatus.textContent = text.readFolder;
      try {
        const allFiles = await readDirectoryEntry(
          firstEntry as FileSystemDirectoryEntry,
          firstEntry.name,
        );
        stageFiles(allFiles, pickDefaultPmx(allFiles), text.sourceFolderDrop);
      } catch (err) {
        pmxStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      const file = items[0].getAsFile();
      if (!file) return;
      await loadZipFile(file);
    }
  });

  async function loadZipFile(file: File): Promise<void> {
    pmxStatus.textContent = text.readZip;
    try {
      const { pmxFile, allFiles } = readZip(await file.arrayBuffer());
      stageFiles(allFiles, pmxFile, text.sourceZipDrop);
    } catch (err) {
      pmxStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Conversion ────────────────────────────────────────────────────────────

  pmxConvertBtn.addEventListener("click", async () => {
    if (!stagedPmxFile) {
      pmxStatus.textContent = text.pleaseLoadFolderOrZip;
      return;
    }
    setPmxBusy(true);

    try {
      // Always attempt lossless AVIF optimisation for all compressible images
      // (result is only kept when it is smaller than the original).
      // When "Verlustbehaftet komprimieren" is active, selected files are also
      // encoded lossily (quality 0.92) instead of losslessly.
      const compressionMode = pmxCompressModeSelect.value;
      let filesToConvert: File[];
      if (compressionMode === "raw") {
        filesToConvert = stagedAllFiles;
      } else {
        const compressibleTotal = stagedAllFiles.filter((f) =>
          COMPRESSIBLE_IMAGE_EXTS.has(getFileExt(f.name)),
        ).length;
        pmxStatus.textContent = formatTemplate(text.optimizingTextures, {
          done: 0,
          total: compressibleTotal,
        });
        filesToConvert = await compressImagesToAvif(
          stagedAllFiles,
          (done, total) => {
            pmxStatus.textContent = formatTemplate(text.optimizingTextures, {
              done,
              total,
            });
          },
          compressionMode === "lossy" ? compressToAvifSet : undefined,
          { forceAvif: pmxForceAvifInput.checked },
        );
      }

      pmxStatus.textContent = viewStrings.statusConverting;
      const bpmxBuffer = await convertPmxToBpmx(stagedPmxFile, filesToConvert);
      actualResultFiles = filesToConvert;
      renderFileList();
      const outName = `${stripExt(stagedPmxFile.name)}.bpmx`;
      downloadAs(bpmxBuffer, outName, "application/octet-stream");
      pmxStatus.textContent = formatTemplate(text.downloadedStatus, {
        file: outName,
      });
    } catch (err) {
      pmxStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      setPmxBusy(false);
    }
  });

  // ── Motion / Pose → BVMD ────────────────────────────────────────────────

  const motionDropZone =
    container.querySelector<HTMLDivElement>("#motion-drop-zone")!;
  const motionFileBtn =
    container.querySelector<HTMLButtonElement>("#motion-file-btn")!;
  const motionFileInput =
    container.querySelector<HTMLInputElement>("#motion-file")!;
  const motionDropLabel =
    container.querySelector<HTMLSpanElement>("#motion-drop-label")!;
  const motionConvertBtn =
    container.querySelector<HTMLButtonElement>("#motion-convert")!;
  const motionStatus =
    container.querySelector<HTMLSpanElement>("#motion-status")!;
  const motionSummary =
    container.querySelector<HTMLPreElement>("#motion-summary")!;

  let stagedMotionFile: File | null = null;

  function syncMotionAvailability(): void {
    motionConvertBtn.disabled = stagedMotionFile === null;
    if (stagedMotionFile === null) {
      motionStatus.textContent = EMPTY_INPUT_STATUS;
    }
  }

  function setStagedMotionFile(file: File): void {
    stagedMotionFile = file;
    motionDropLabel.textContent = `${file.name} (${formatSize(file.size)})`;
    motionStatus.textContent = `${statusReady} - ${file.name}`;
    syncMotionAvailability();
  }

  function setMotionBusy(nextBusy: boolean): void {
    motionFileBtn.disabled = nextBusy;
    motionFileInput.disabled = nextBusy;
    motionConvertBtn.disabled = nextBusy || stagedMotionFile === null;
    motionDropZone.classList.toggle("drop-zone-disabled", nextBusy);
  }

  motionFileBtn.addEventListener("click", () => motionFileInput.click());
  motionFileInput.addEventListener("change", () => {
    const file = motionFileInput.files?.[0];
    motionFileInput.value = "";
    if (file) setStagedMotionFile(file);
  });

  motionDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    motionDropZone.classList.add("drag-over");
  });
  motionDropZone.addEventListener("dragleave", () => {
    motionDropZone.classList.remove("drag-over");
  });
  motionDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    motionDropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) setStagedMotionFile(file);
  });

  motionConvertBtn.addEventListener("click", async () => {
    if (!stagedMotionFile) {
      motionStatus.textContent = text.pleaseSelectMotion;
      return;
    }
    setMotionBusy(true);
    motionStatus.textContent = viewStrings.statusConverting;
    try {
      const result = await convertMotionFileToBvmd(stagedMotionFile);
      renderMotionSummary(motionSummary, result.summary);
      downloadAs(
        result.buffer,
        `${stripExt(stagedMotionFile.name)}.bvmd`,
        "application/octet-stream",
      );
      motionStatus.textContent = formatTemplate(text.downloadedStatus, {
        file: `${stripExt(stagedMotionFile.name)}.bvmd`,
      });
    } catch (err) {
      motionStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      setMotionBusy(false);
    }
  });

  syncMotionAvailability();

  // ── BVMD → VMD ──────────────────────────────────────────────────────────

  const bvmdMotionDropZone = container.querySelector<HTMLDivElement>(
    "#bvmd-motion-drop-zone",
  )!;
  const bvmdMotionFileBtn = container.querySelector<HTMLButtonElement>(
    "#bvmd-motion-file-btn",
  )!;
  const bvmdMotionFileInput =
    container.querySelector<HTMLInputElement>("#bvmd-motion-file")!;
  const bvmdMotionDropLabel = container.querySelector<HTMLSpanElement>(
    "#bvmd-motion-drop-label",
  )!;
  const bvmdMotionConvertBtn = container.querySelector<HTMLButtonElement>(
    "#bvmd-motion-convert",
  )!;
  const bvmdMotionStatus = container.querySelector<HTMLSpanElement>(
    "#bvmd-motion-status",
  )!;
  const bvmdMotionSummary = container.querySelector<HTMLPreElement>(
    "#bvmd-motion-summary",
  )!;

  let stagedBvmdMotionFile: File | null = null;

  function syncBvmdMotionAvailability(): void {
    bvmdMotionConvertBtn.disabled = stagedBvmdMotionFile === null;
    if (stagedBvmdMotionFile === null) {
      bvmdMotionStatus.textContent = EMPTY_INPUT_STATUS;
    }
  }

  function setStagedBvmdMotionFile(file: File): void {
    stagedBvmdMotionFile = file;
    bvmdMotionDropLabel.textContent = `${file.name} (${formatSize(file.size)})`;
    bvmdMotionStatus.textContent = `${statusReady} - ${file.name}`;
    syncBvmdMotionAvailability();
  }

  function setBvmdMotionBusy(nextBusy: boolean): void {
    bvmdMotionFileBtn.disabled = nextBusy;
    bvmdMotionFileInput.disabled = nextBusy;
    bvmdMotionConvertBtn.disabled = nextBusy || stagedBvmdMotionFile === null;
    bvmdMotionDropZone.classList.toggle("drop-zone-disabled", nextBusy);
  }

  bvmdMotionFileBtn.addEventListener("click", () =>
    bvmdMotionFileInput.click(),
  );
  bvmdMotionFileInput.addEventListener("change", () => {
    const file = bvmdMotionFileInput.files?.[0];
    bvmdMotionFileInput.value = "";
    if (file) setStagedBvmdMotionFile(file);
  });

  bvmdMotionDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    bvmdMotionDropZone.classList.add("drag-over");
  });
  bvmdMotionDropZone.addEventListener("dragleave", () => {
    bvmdMotionDropZone.classList.remove("drag-over");
  });
  bvmdMotionDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    bvmdMotionDropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) setStagedBvmdMotionFile(file);
  });

  bvmdMotionConvertBtn.addEventListener("click", async () => {
    if (!stagedBvmdMotionFile) {
      bvmdMotionStatus.textContent = text.pleaseSelectBvmd;
      return;
    }
    setBvmdMotionBusy(true);
    bvmdMotionStatus.textContent = viewStrings.statusConverting;
    try {
      const result =
        await convertBvmdFileToLegacyVmdFiles(stagedBvmdMotionFile);
      renderMotionSummary(bvmdMotionSummary, result.summary);
      if (result.cameraVmd) {
        const zipName = `${stripExt(stagedBvmdMotionFile.name)}.legacy-vmd.zip`;
        downloadAs(
          buildZipFromFiles([
            {
              fileName: result.modelVmd.fileName,
              data: result.modelVmd.buffer,
            },
            {
              fileName: result.cameraVmd.fileName,
              data: result.cameraVmd.buffer,
            },
          ]),
          zipName,
          "application/zip",
        );
        bvmdMotionStatus.textContent = formatTemplate(
          text.downloadedZipFilesStatus,
          { count: 2 },
        );
      } else {
        downloadAs(
          result.modelVmd.buffer,
          result.modelVmd.fileName,
          "application/octet-stream",
        );
        bvmdMotionStatus.textContent = formatTemplate(text.downloadedStatus, {
          file: result.modelVmd.fileName,
        });
      }
    } catch (err) {
      bvmdMotionStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      setBvmdMotionBusy(false);
    }
  });

  syncBvmdMotionAvailability();

  // ── Audio → WebM ────────────────────────────────────────────────────────

  const audioDropZone =
    container.querySelector<HTMLDivElement>("#audio-drop-zone")!;
  const audioFileBtn =
    container.querySelector<HTMLButtonElement>("#audio-file-btn")!;
  const audioFileInput =
    container.querySelector<HTMLInputElement>("#audio-file")!;
  const audioDropLabel =
    container.querySelector<HTMLSpanElement>("#audio-drop-label")!;
  const audioConvertBtn =
    container.querySelector<HTMLButtonElement>("#audio-convert")!;
  const audioStatus =
    container.querySelector<HTMLSpanElement>("#audio-status")!;
  const audioSummary =
    container.querySelector<HTMLPreElement>("#audio-summary")!;

  let stagedAudioFile: File | null = null;

  function syncAudioAvailability(): void {
    audioConvertBtn.disabled = stagedAudioFile === null;
    if (stagedAudioFile === null) {
      audioStatus.textContent = EMPTY_INPUT_STATUS;
    }
  }

  function setStagedAudioFile(file: File): void {
    stagedAudioFile = file;
    audioDropLabel.textContent = `${file.name} (${formatSize(file.size)})`;
    audioStatus.textContent = `${statusReady} - ${file.name}`;
    syncAudioAvailability();
  }

  function setAudioBusy(nextBusy: boolean): void {
    audioFileBtn.disabled = nextBusy;
    audioFileInput.disabled = nextBusy;
    audioConvertBtn.disabled = nextBusy || stagedAudioFile === null;
    audioDropZone.classList.toggle("drop-zone-disabled", nextBusy);
  }

  void getAudioToWebmSupport().then((support) => {
    if (!support.supported) {
      audioStatus.title = support.reason ?? text.webmEncodingUnavailable;
    }
  });

  audioFileBtn.addEventListener("click", () => audioFileInput.click());
  audioFileInput.addEventListener("change", () => {
    const file = audioFileInput.files?.[0];
    audioFileInput.value = "";
    if (file) setStagedAudioFile(file);
  });

  audioDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    audioDropZone.classList.add("drag-over");
  });
  audioDropZone.addEventListener("dragleave", () => {
    audioDropZone.classList.remove("drag-over");
  });
  audioDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    audioDropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) setStagedAudioFile(file);
  });

  audioConvertBtn.addEventListener("click", async () => {
    if (!stagedAudioFile) {
      audioStatus.textContent = text.pleaseSelectAudio;
      return;
    }

    setAudioBusy(true);
    audioStatus.textContent = viewStrings.statusConverting;
    try {
      const result = await convertAudioFileToWebm(stagedAudioFile);
      renderAudioSummary(audioSummary, result.summary);
      downloadAs(result.buffer, result.outputFileName, result.mime);
      audioStatus.textContent = formatTemplate(text.downloadedStatus, {
        file: result.outputFileName,
      });
    } catch (err) {
      audioStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      setAudioBusy(false);
    }
  });

  syncAudioAvailability();

  // ── Card Creator ───────────────────────────────────────────────────────

  const cardCreateDropZone = container.querySelector<HTMLDivElement>(
    "#cardcreate-drop-zone",
  )!;
  const cardCreateFolderBtn = container.querySelector<HTMLButtonElement>(
    "#cardcreate-folder-btn",
  )!;
  const cardCreateZipBtn = container.querySelector<HTMLButtonElement>(
    "#cardcreate-zip-btn",
  )!;
  const cardCreateFilesBtn = container.querySelector<HTMLButtonElement>(
    "#cardcreate-files-btn",
  )!;
  const cardCreateFolderInput =
    container.querySelector<HTMLInputElement>("#cardcreate-folder")!;
  const cardCreateZipInput =
    container.querySelector<HTMLInputElement>("#cardcreate-zip")!;
  const cardCreateFilesInput =
    container.querySelector<HTMLInputElement>("#cardcreate-files")!;
  const cardCreateImageInput = container.querySelector<HTMLInputElement>(
    "#cardcreate-image-file",
  )!;
  const cardCreateDropLabel = container.querySelector<HTMLSpanElement>(
    "#cardcreate-drop-label",
  )!;
  const cardCreateFileListWrap = container.querySelector<HTMLDivElement>(
    "#cardcreate-file-list-wrap",
  )!;
  const cardCreateFileList = container.querySelector<HTMLUListElement>(
    "#cardcreate-file-list",
  )!;
  const cardCreateClearAllBtn = container.querySelector<HTMLButtonElement>(
    "#cardcreate-clear-all",
  )!;
  const cardCreatePreviewImage = container.querySelector<HTMLImageElement>(
    "#cardcreate-preview-image",
  )!;
  const cardCreatePreviewSource = container.querySelector<HTMLSpanElement>(
    "#cardcreate-preview-source",
  )!;
  const cardCreateRemoveImageBtn = container.querySelector<HTMLButtonElement>(
    "#cardcreate-remove-image",
  )!;
  const cardCreateReplaceImageBtn = container.querySelector<HTMLButtonElement>(
    "#cardcreate-replace-image",
  )!;
  const cardCreateCompressMode = container.querySelector<HTMLSelectElement>(
    "#cardcreate-compress-mode",
  )!;
  const cardCreateForceAvifInput = container.querySelector<HTMLInputElement>(
    "#cardcreate-force-avif",
  )!;
  const cardCreateSelectAllCompressBtn =
    container.querySelector<HTMLButtonElement>(
      "#cardcreate-select-all-compress",
    )!;
  const cardCreateBuildBtn =
    container.querySelector<HTMLButtonElement>("#cardcreate-build")!;
  const cardCreateStatus =
    container.querySelector<HTMLSpanElement>("#cardcreate-status")!;
  const cardCreateSummary = container.querySelector<HTMLPreElement>(
    "#cardcreate-summary",
  )!;
  const cardCreateUInfSource = container.querySelector<HTMLParagraphElement>(
    "#cardcreate-uinf-source",
  )!;
  const cardCreateUInfEditInput = container.querySelector<HTMLInputElement>(
    "#cardcreate-uinf-edit",
  )!;
  const cardCreateUInfFields = container.querySelector<HTMLDivElement>(
    "#cardcreate-uinf-fields",
  )!;
  const cardCreateUInfAuthInput = container.querySelector<HTMLInputElement>(
    "#cardcreate-uinf-auth",
  )!;
  const cardCreateUInfChInput = container.querySelector<HTMLTextAreaElement>(
    "#cardcreate-uinf-ch",
  )!;
  const cardCreateUInfInfoInput = container.querySelector<HTMLTextAreaElement>(
    "#cardcreate-uinf-info",
  )!;
  const cardCreateFBtnSource = container.querySelector<HTMLParagraphElement>(
    "#cardcreate-fbtn-source",
  )!;
  const cardCreateFBtnEditInput = container.querySelector<HTMLInputElement>(
    "#cardcreate-fbtn-edit",
  )!;
  const cardCreateFBtnFields = container.querySelector<HTMLDivElement>(
    "#cardcreate-fbtn-fields",
  )!;
  const cardCreateFBtnList = container.querySelector<HTMLDivElement>(
    "#cardcreate-fbtn-list",
  )!;
  const cardCreateFBtnAddBtn = container.querySelector<HTMLButtonElement>(
    "#cardcreate-fbtn-add",
  )!;
  const cardCreateMoAiSource = container.querySelector<HTMLParagraphElement>(
    "#cardcreate-moai-source",
  )!;
  const cardCreateMoAiEditInput = container.querySelector<HTMLInputElement>(
    "#cardcreate-moai-edit",
  )!;
  const cardCreateMoAiFields = container.querySelector<HTMLDivElement>(
    "#cardcreate-moai-fields",
  )!;
  const cardCreateMoAiNameInput = container.querySelector<HTMLInputElement>(
    "#cardcreate-moai-name",
  )!;
  const cardCreateMoAiGenderInput = container.querySelector<HTMLInputElement>(
    "#cardcreate-moai-gender",
  )!;
  const cardCreateMoAiInfoInput = container.querySelector<HTMLTextAreaElement>(
    "#cardcreate-moai-info",
  )!;
  const cardCreateMorphList = container.querySelector<HTMLDivElement>(
    "#cardcreate-morph-list",
  )!;
  const cardCreateMorphAddBtn = container.querySelector<HTMLButtonElement>(
    "#cardcreate-morph-add",
  )!;
  const cardCreateVoiceList = container.querySelector<HTMLDivElement>(
    "#cardcreate-voice-list",
  )!;
  const cardCreateVoiceAddBtn = container.querySelector<HTMLButtonElement>(
    "#cardcreate-voice-add",
  )!;
  const cardCreateWebmAudioSelect = container.querySelector<HTMLDivElement>(
    "#cardcreate-webm-audio-select",
  )!;

  let stagedCardCreateFiles: File[] = [];
  let selectedCardCreateBaseImage: File | null = null;
  let selectedCardCreateModelFile: File | null = null;
  let selectedCardCreateWebmFilePath: string | null = null;
  let cardCreatePreviewUrl: string | null = null;
  let defaultCardCreateBaseImageBuffer: ArrayBuffer | null = null;
  let cardCreatePreferDefaultBaseImage = false;
  let cardCreateLastSourceLabel: string | null = null;
  let cardCreateMetadataRefreshToken = 0;
  let cardCreateMorphNames: string[] = [];

  let activeVoiceAudio: {
    audio: HTMLAudioElement;
    objectUrl: string;
    rowIndex: number;
  } | null = null;
  let cardCreateBusy = false;
  let cardCreateCompressToAvifSet: Set<File> = new Set();
  let cardCreateActualResultFiles: Map<string, File> | null = null;
  let cardCreateUInfDraft = createEmptyUInfDraft();
  let cardCreateFBtnDrafts: CardCreateFastButtonDraft[] = [
    createEmptyFastButtonDraft(),
  ];
  let cardCreateMoAiDraft = createEmptyMoAiDraft();
  const cardCreateMetadataSourceKeys: Record<
    CardCreateMetadataKey,
    string | null
  > = {
    uInf: null,
    fBtn: null,
    moAi: null,
  };
  // Staging order of card-create files (per file key). Used to number
  // duplicated metadata files ("metadata.moAi.json (2)") and to resolve
  // duplicate morph entries with "last added wins".
  const cardCreateFileSeqByKey = new Map<string, number>();
  let cardCreateFileSeqCounter = 0;
  // Clean display path for files whose staging key had to be made unique
  // (dropped fBtn/moAi duplicates of an already staged file).
  const cardCreateDisplayKeyOverrides = new WeakMap<File, string>();

  async function getDefaultCardCreateBaseImageBuffer(): Promise<ArrayBuffer> {
    if (defaultCardCreateBaseImageBuffer) {
      return defaultCardCreateBaseImageBuffer;
    }

    const response = await fetch(getDefaultCardBaseImageUrl());
    if (!response.ok) {
      throw new Error(errorStrings.defaultBaseImageLoadFailed);
    }

    defaultCardCreateBaseImageBuffer = await response.arrayBuffer();
    return defaultCardCreateBaseImageBuffer;
  }

  function getCardCreateFileKey(file: File): string {
    return (
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name
    ).replace(/\\/g, "/");
  }

  function pickShallowestCardCreateFile(files: readonly File[]): File | null {
    const sorted = files.slice().sort((left, right) => {
      const leftPath = getCardCreateFileKey(left);
      const rightPath = getCardCreateFileKey(right);
      const depthDifference =
        (leftPath.match(/\//g)?.length ?? 0) -
        (rightPath.match(/\//g)?.length ?? 0);
      return depthDifference !== 0
        ? depthDifference
        : leftPath.localeCompare(rightPath);
    });
    return sorted[0] ?? null;
  }

  function pickDefaultCardCreateModel(files: readonly File[]): File | null {
    const bpmxFiles = files.filter(
      (file) => getCardCreatorInputKind(file) === "bpmx",
    );
    if (bpmxFiles.length > 0) {
      return pickShallowestCardCreateFile(bpmxFiles);
    }

    return pickDefaultPmx(
      files.filter((file) => getCardCreatorInputKind(file) === "pmx"),
    );
  }

  function isCardCreateModelCandidate(file: File): boolean {
    const kind = getCardCreatorInputKind(file);
    return kind === "pmx" || kind === "bpmx";
  }

  function isCardCreateTextureCandidate(file: File): boolean {
    switch (getCardCreatorInputKind(file)) {
      case "bpmx":
      case "pmx":
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
      case "voice-clone-sample":
      case "base-image":
        return false;
      default:
        return COMPRESSIBLE_IMAGE_EXTS.has(
          getFileExt(getCardCreateFileKey(file)),
        );
    }
  }

  function cardCreateUsesPmxConversion(): boolean {
    return (
      selectedCardCreateModelFile !== null &&
      getCardCreatorInputKind(selectedCardCreateModelFile) === "pmx"
    );
  }

  function syncCardCreateModelSelection(): void {
    if (
      selectedCardCreateModelFile &&
      stagedCardCreateFiles.includes(selectedCardCreateModelFile)
    ) {
      return;
    }

    selectedCardCreateModelFile = pickDefaultCardCreateModel(
      stagedCardCreateFiles,
    );
  }

  async function readMorphNamesFromModelFile(file: File): Promise<string[]> {
    try {
      const buffer = await file.arrayBuffer();
      const kind = getCardCreatorInputKind(file);
      if (kind === "bpmx") {
        const bpmx = await parseBpmx(buffer);
        return bpmx.morphs.map((m: { name: string }) => m.name);
      } else if (kind === "pmx") {
        const pmx = await PmxReader.ParseAsync(buffer);
        return pmx.morphs.map((m: { name: string }) => m.name);
      }
    } catch {
      // ignore parse errors – fall back to empty list
    }
    return [];
  }

  async function loadMorphNamesFromModel(): Promise<void> {
    if (selectedCardCreateModelFile) {
      cardCreateMorphNames = await readMorphNamesFromModelFile(
        selectedCardCreateModelFile,
      );
    } else {
      cardCreateMorphNames = [];
    }
  }

  function syncCardCreateLossySelection(
    previousFiles: readonly File[] = [],
  ): void {
    const previousKeys = new Set(previousFiles.map(getCardCreateFileKey));
    const selectedKeys = new Set(
      Array.from(cardCreateCompressToAvifSet, (file) =>
        getCardCreateFileKey(file),
      ),
    );
    const nextSelection = new Set<File>();

    for (const file of stagedCardCreateFiles) {
      if (!isCardCreateTextureCandidate(file)) continue;

      const key = getCardCreateFileKey(file);
      if (selectedKeys.has(key) || !previousKeys.has(key)) {
        nextSelection.add(file);
      }
    }

    cardCreateCompressToAvifSet = nextSelection;
  }

  function clearCardCreateActualResultFiles(): void {
    cardCreateActualResultFiles = null;
  }

  function updateCardCreateLoadedState(preferSelectionMessage = false): void {
    if (stagedCardCreateFiles.length === 0) {
      cardCreateDropLabel.textContent = text.cardCreateDropLabel;
      cardCreateStatus.textContent = EMPTY_INPUT_STATUS;
      return;
    }

    cardCreateDropLabel.textContent = formatTemplate(text.filesLoadedLabel, {
      count: stagedCardCreateFiles.length,
    });

    if (
      preferSelectionMessage &&
      selectedCardCreateModelFile &&
      cardCreateLastSourceLabel
    ) {
      cardCreateStatus.textContent = formatTemplate(text.selectedFilesStatus, {
        ready: statusReady,
        name: selectedCardCreateModelFile.name,
        count: stagedCardCreateFiles.length,
        source: cardCreateLastSourceLabel,
      });
      return;
    }

    if (cardCreateLastSourceLabel) {
      cardCreateStatus.textContent = formatTemplate(
        text.filesLoadedFromSourceStatus,
        {
          ready: statusReady,
          count: stagedCardCreateFiles.length,
          source: cardCreateLastSourceLabel,
        },
      );
      return;
    }

    cardCreateStatus.textContent = formatTemplate(text.filesLoadedStatus, {
      ready: statusReady,
      count: stagedCardCreateFiles.length,
    });
  }

  function describeCardCreateRole(file: File): string {
    if (file === selectedCardCreateBaseImage) {
      return text.baseImageRole;
    }

    switch (getCardCreatorInputKind(file)) {
      case "base-image":
        return cardCreatePreferDefaultBaseImage
          ? text.baseImageAvailableRole
          : text.baseImageRole;
      case "pmx":
        return text.pmxSourceRole;
      case "bpmx":
        return "BPMX";
      case "bpmv":
        return "BPMV";
      case "bvmd":
        return "BVMD";
      case "motion-source":
        return text.motionSourceRole;
      case "webm": {
        const webmPath = getCardCreateFileKey(file).replace(/\\/g, "/");
        return webmPath === selectedCardCreateWebmFilePath ? "WEBM ♪" : "WEBM";
      }
      case "audio-source":
        return text.audioSourceRole;
      case "audio-url":
        return "Audio-URL";
      case "metadata-eroV":
        return `${text.metadataSourceRolePrefix} eroV`;
      case "metadata-uInf":
        return `${text.metadataSourceRolePrefix} uInf`;
      case "metadata-fBtn":
        return `${text.metadataSourceRolePrefix} fBtn`;
      case "metadata-moAi":
        return `${text.metadataSourceRolePrefix} moAi`;
      case "voice-clone-sample":
        return "Voice";
      case "png-image":
        return "PNG";
      default:
        return text.genericFileRole;
    }
  }

  function updateCardCreateSelectAllBtn(): void {
    const compressible = stagedCardCreateFiles.filter((file) =>
      isCardCreateTextureCandidate(file),
    );
    const allSelected =
      compressible.length > 0 &&
      compressible.every((file) => cardCreateCompressToAvifSet.has(file));
    cardCreateSelectAllCompressBtn.textContent = allSelected
      ? text.noneLossy
      : text.allLossy;
  }

  function syncCardCreateForceAvif(): void {
    const disabled = cardCreateCompressMode.value === "raw";
    cardCreateForceAvifInput.disabled = disabled;
    cardCreateForceAvifInput.title = disabled
      ? "RAW deaktiviert die Bildkomprimierung."
      : "Erzwingt echte AVIF-Ausgabe via @jsquash/avif.";
  }

  function syncCardCreateCompressionUi(): void {
    syncCardCreateForceAvif();

    const showLossySelector =
      cardCreateUsesPmxConversion() && cardCreateCompressMode.value === "lossy";

    cardCreateSelectAllCompressBtn.hidden = !showLossySelector;
    cardCreateSelectAllCompressBtn.disabled =
      cardCreateBusy || !showLossySelector;

    if (showLossySelector) {
      updateCardCreateSelectAllBtn();
    }
  }

  function cardCreateModeLabel(mode: string): string {
    if (mode === "lossless") return text.losslessTag;
    if (mode === "lossy") return text.lossyTag;
    if (mode === "already-avif") return text.alreadyAvif;
    return "";
  }

  function getCardCreateEffectiveCompressionMode(
    originalFile: File,
    resultFile: File,
  ): string {
    if (resultFile.type !== "image/avif") {
      return "lossless";
    }

    const requestedLossy =
      cardCreateCompressMode.value === "lossy" &&
      cardCreateCompressToAvifSet.has(originalFile);

    return requestedLossy ? "lossy" : "lossless";
  }

  function buildCardCreateResultSpan(
    originalFile: File,
    resultFile: File,
  ): HTMLSpanElement {
    const sizeAfter = document.createElement("span");
    sizeAfter.className = "size-after";

    const sizeValEl = document.createElement("span");
    sizeValEl.className = "size-value";

    const fmtTagEl = document.createElement("span");
    fmtTagEl.className = "fmt-tag";

    const modeTagEl = document.createElement("span");
    modeTagEl.className = "mode-tag";

    if (resultFile !== originalFile) {
      sizeValEl.textContent = "\u2192 " + formatSize(resultFile.size);
      sizeAfter.classList.add("size-smaller");
      fmtTagEl.textContent =
        resultFile.type === "image/avif"
          ? "AVIF"
          : (resultFile.type.split("/")[1]?.toUpperCase() ??
            getFileExt(resultFile.name).toUpperCase());
      const mode = getCardCreateEffectiveCompressionMode(
        originalFile,
        resultFile,
      );
      modeTagEl.textContent =
        mode === "lossy"
          ? `Q${Math.round(LOSSY_QUALITY * 100)}`
          : cardCreateModeLabel(mode);
      modeTagEl.dataset.mode = mode;
      modeTagEl.hidden = false;
    } else {
      sizeValEl.textContent = "=";
      fmtTagEl.textContent =
        resultFile.type === "image/avif"
          ? "AVIF"
          : (resultFile.type.split("/")[1]?.toUpperCase() ??
            getFileExt(resultFile.name).toUpperCase());
      modeTagEl.textContent = cardCreateModeLabel("lossless");
      modeTagEl.dataset.mode = "lossless";
      modeTagEl.hidden = false;
    }

    sizeAfter.append(sizeValEl, fmtTagEl, modeTagEl);
    return sizeAfter;
  }

  function getCardCreateMetadataFile(key: CardCreateMetadataKey): File | null {
    return (
      stagedCardCreateFiles.find(
        (file) =>
          getCardCreatorInputKind(file) === CARD_CREATE_METADATA_KIND_MAP[key],
      ) ?? null
    );
  }

  function getCardCreateFileSeq(file: File): number {
    return cardCreateFileSeqByKey.get(getCardCreateFileKey(file)) ?? 0;
  }

  /** All staged files of a metadata kind, ordered by add sequence. */
  function getCardCreateMetadataFiles(key: CardCreateMetadataKey): File[] {
    const kind = CARD_CREATE_METADATA_KIND_MAP[key];
    return stagedCardCreateFiles
      .filter((file) => getCardCreatorInputKind(file) === kind)
      .sort(
        (left, right) =>
          getCardCreateFileSeq(left) - getCardCreateFileSeq(right),
      );
  }

  /**
   * Display key for the file list: duplicated fBtn/moAi metadata files get
   * an occurrence counter in parentheses, numbered by add order.
   */
  function getCardCreateFileDisplayKey(file: File): string {
    const fileKey = getCardCreateFileKey(file);
    const displayKey = cardCreateDisplayKeyOverrides.get(file) ?? fileKey;
    const kind = getCardCreatorInputKind(file);
    if (kind !== "metadata-fBtn" && kind !== "metadata-moAi") {
      return displayKey;
    }
    const group = stagedCardCreateFiles
      .filter((candidate) => getCardCreatorInputKind(candidate) === kind)
      .sort(
        (left, right) =>
          getCardCreateFileSeq(left) - getCardCreateFileSeq(right),
      );
    if (group.length < 2) return displayKey;
    return `${displayKey} (${group.indexOf(file) + 1})`;
  }

  function buildCardCreateMetadataSourceText(
    files: readonly File[],
    invalidLabels: readonly string[],
  ): string {
    const invalidSet = new Set(invalidLabels);
    const validLabels = files
      .map((file) => getCardCreateFileDisplayKey(file))
      .filter((label) => !invalidSet.has(label));
    const parts: string[] = [];
    if (validLabels.length > 0) {
      parts.push(
        formatTemplate(text.metadataSourceTemplate, {
          path: validLabels.join(", "),
        }),
      );
    }
    if (invalidLabels.length > 0) {
      parts.push(
        formatTemplate(text.metadataInvalidJsonListTemplate, {
          paths: invalidLabels.join(", "),
        }),
      );
    }
    return parts.join(" · ");
  }

  function applyCardMetadataRowState(
    row: HTMLElement,
    state: CardMetadataEntryState,
    remapTitle: string | null = null,
  ): void {
    row.classList.toggle(
      "card-row-remapped",
      state.remappedIndex !== undefined,
    );
    row.classList.toggle("card-row-duplicate", state.duplicate);
    row.classList.toggle("card-row-invalid", state.invalid);
    if (
      !state.duplicate &&
      !state.invalid &&
      state.remappedIndex === undefined
    ) {
      row.removeAttribute("title");
      return;
    }
    const titles: string[] = [];
    if (remapTitle !== null) titles.push(remapTitle);
    if (state.duplicate) titles.push(text.metadataDuplicateRowTitle);
    if (state.invalid) titles.push(text.metadataInvalidRowTitle);
    row.title = titles.join(" · ");
  }

  function setCardCreateMetadataFieldsDisabled(
    containerElement: HTMLElement,
    disabled: boolean,
  ): void {
    containerElement.classList.toggle(
      "card-metadata-fields-disabled",
      disabled,
    );
    containerElement
      .querySelectorAll<
        | HTMLInputElement
        | HTMLTextAreaElement
        | HTMLSelectElement
        | HTMLButtonElement
      >("input, textarea, select, button")
      .forEach((element) => {
        element.disabled = disabled;
      });
  }

  function renderCardCreateFastButtonRows(): void {
    cardCreateFBtnList.innerHTML = "";
    const rowStates = computeCardMetadataEntryStates(
      cardCreateFBtnDrafts,
      cardCreateMorphNames,
      (draft) => draft.morph,
    );
    cardCreateFBtnDrafts.forEach((draft, index) => {
      const row = document.createElement("div");
      row.className = "card-fast-button-row";
      applyCardMetadataRowState(row, rowStates[index]);

      const nameInput = document.createElement("input");
      nameInput.className = "card-fast-button-name";
      nameInput.type = "text";
      nameInput.placeholder = text.fastButtonNamePlaceholder;
      nameInput.value = draft.name;
      nameInput.addEventListener("input", () => {
        cardCreateFBtnDrafts[index].name = nameInput.value;
      });

      const actionSelect = document.createElement("select");
      const option = document.createElement("option");
      option.value = "morph";
      option.textContent = "morph";
      actionSelect.append(option);
      actionSelect.value = draft.action;
      actionSelect.addEventListener("change", () => {
        cardCreateFBtnDrafts[index].action = "morph";
      });

      const morphSelect = document.createElement("select");
      if (cardCreateMorphNames.length === 0) {
        const opt = document.createElement("option");
        opt.value = draft.morph || "0";
        opt.textContent = draft.morph || "—";
        opt.selected = true;
        morphSelect.appendChild(opt);
      } else {
        for (let i = 0; i < cardCreateMorphNames.length; i++) {
          const opt = document.createElement("option");
          const val = String(i);
          opt.value = val;
          opt.textContent = `${i}: ${cardCreateMorphNames[i]}`;
          if (val === draft.morph) opt.selected = true;
          morphSelect.appendChild(opt);
        }
        if (
          draft.morph &&
          !morphSelect.querySelector<HTMLOptionElement>(
            `option[value="${CSS.escape(draft.morph)}"]`,
          )
        ) {
          const opt = document.createElement("option");
          opt.value = draft.morph;
          opt.textContent = draft.morph;
          opt.selected = true;
          morphSelect.insertBefore(opt, morphSelect.firstChild);
        }
      }
      morphSelect.addEventListener("change", () => {
        cardCreateFBtnDrafts[index].morph = morphSelect.value;
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "card-remove-btn";
      removeBtn.textContent = "🗑";
      removeBtn.ariaLabel = text.fastButtonRemove;
      removeBtn.title = text.fastButtonRemove;
      removeBtn.addEventListener("click", () => {
        cardCreateFBtnDrafts = cardCreateFBtnDrafts.filter(
          (_, rowIndex) => rowIndex !== index,
        );
        if (cardCreateFBtnDrafts.length === 0) {
          cardCreateFBtnDrafts = [createEmptyFastButtonDraft()];
        }
        renderCardCreateFastButtonRows();
        syncCardCreateMetadataEditorsDisabledState(false);
      });

      row.append(nameInput, actionSelect, morphSelect, removeBtn);
      cardCreateFBtnList.appendChild(row);
    });
  }

  function buildMorphIndexOptions(
    currentDraftIndex: string,
  ): { value: string; label: string; selected: boolean }[] {
    const options: { value: string; label: string; selected: boolean }[] = [];
    if (cardCreateMorphNames.length === 0) {
      options.push({
        value: currentDraftIndex || "0",
        label: currentDraftIndex || "—",
        selected: true,
      });
      return options;
    }
    for (let i = 0; i < cardCreateMorphNames.length; i++) {
      const val = String(i);
      options.push({
        value: val,
        label: `${i}: ${cardCreateMorphNames[i]}`,
        selected: val === currentDraftIndex,
      });
    }
    if (
      currentDraftIndex &&
      !options.some((o) => o.value === currentDraftIndex)
    ) {
      options.push({
        value: currentDraftIndex,
        label: currentDraftIndex,
        selected: true,
      });
    }
    return options;
  }

  function renderCardCreateMorphRows(): void {
    cardCreateMorphList.innerHTML = "";
    const rowStates = computeCardMetadataEntryStates(
      cardCreateMoAiDraft.morphs,
      cardCreateMorphNames,
      (draft) => draft.index,
      (draft) => draft.name,
    );
    cardCreateMoAiDraft.morphs.forEach((draft, index) => {
      const state = rowStates[index];
      const effectiveIndex =
        state.remappedIndex !== undefined
          ? String(state.remappedIndex)
          : draft.index;
      const row = document.createElement("div");
      row.className = "card-morph-row";
      applyCardMetadataRowState(
        row,
        state,
        state.remappedIndex !== undefined
          ? formatTemplate(text.metadataRemappedRowTemplate, {
              from: draft.index,
              to: state.remappedIndex,
            })
          : null,
      );

      const indexSelect = document.createElement("select");
      for (const opt of buildMorphIndexOptions(effectiveIndex)) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        o.selected = opt.selected;
        indexSelect.appendChild(o);
      }
      indexSelect.addEventListener("change", () => {
        const newIndex = indexSelect.value;
        cardCreateMoAiDraft.morphs[index].index = newIndex;
        const nameIdx = parseInt(newIndex, 10);
        if (
          !Number.isNaN(nameIdx) &&
          nameIdx >= 0 &&
          nameIdx < cardCreateMorphNames.length
        ) {
          cardCreateMoAiDraft.morphs[index].name =
            cardCreateMorphNames[nameIdx];
        }
      });

      const descInput = document.createElement("input");
      descInput.type = "text";
      descInput.placeholder = text.morphDescDescLabel;
      descInput.value = draft.desc;
      descInput.addEventListener("input", () => {
        cardCreateMoAiDraft.morphs[index].desc = descInput.value;
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "card-remove-btn";
      removeBtn.textContent = "🗑";
      removeBtn.ariaLabel = text.morphDescRemove;
      removeBtn.title = text.morphDescRemove;
      removeBtn.addEventListener("click", () => {
        cardCreateMoAiDraft.morphs = cardCreateMoAiDraft.morphs.filter(
          (_, rowIndex) => rowIndex !== index,
        );
        renderCardCreateMorphRows();
        syncCardCreateMetadataEditorsDisabledState(false);
      });

      // --- Details row (second line): description input + remove ---
      const details = document.createElement("div");
      details.className = "card-morph-details";

      details.append(descInput, removeBtn);
      row.append(indexSelect, details);
      cardCreateMorphList.appendChild(row);
    });
  }

  const VOICE_CLONE_LOCALE_OPTIONS: ReadonlyArray<{
    value: string;
    label: string;
  }> = [
    { value: "", label: "—" },
    { value: "ar", label: "العربية (ar)" },
    { value: "cs", label: "Čeština (cs)" },
    { value: "da", label: "Dansk (da)" },
    { value: "de", label: "Deutsch (de)" },
    { value: "de-AT", label: "Deutsch (de-AT)" },
    { value: "de-CH", label: "Deutsch (de-CH)" },
    { value: "de-DE", label: "Deutsch (de-DE)" },
    { value: "el", label: "Ελληνικά (el)" },
    { value: "en", label: "English (en)" },
    { value: "en-AU", label: "English (en-AU)" },
    { value: "en-GB", label: "English (en-GB)" },
    { value: "en-US", label: "English (en-US)" },
    { value: "es", label: "Español (es)" },
    { value: "es-ES", label: "Español (es-ES)" },
    { value: "fi", label: "Suomi (fi)" },
    { value: "fr", label: "Français (fr)" },
    { value: "fr-CA", label: "Français (fr-CA)" },
    { value: "fr-FR", label: "Français (fr-FR)" },
    { value: "he", label: "עברית (he)" },
    { value: "hi", label: "हिन्दी (hi)" },
    { value: "hu", label: "Magyar (hu)" },
    { value: "id", label: "Bahasa Indonesia (id)" },
    { value: "it", label: "Italiano (it)" },
    { value: "ja", label: "日本語 (ja)" },
    { value: "ko", label: "한국어 (ko)" },
    { value: "nl", label: "Nederlands (nl)" },
    { value: "no", label: "Norsk (no)" },
    { value: "pl", label: "Polski (pl)" },
    { value: "pt", label: "Português (pt)" },
    { value: "pt-BR", label: "Português (pt-BR)" },
    { value: "ro", label: "Română (ro)" },
    { value: "ru", label: "Русский (ru)" },
    { value: "sk", label: "Slovenčina (sk)" },
    { value: "sv", label: "Svenska (sv)" },
    { value: "th", label: "ไทย (th)" },
    { value: "tr", label: "Türkçe (tr)" },
    { value: "uk", label: "Українська (uk)" },
    { value: "vi", label: "Tiếng Việt (vi)" },
    { value: "zh", label: "中文 (zh)" },
    { value: "zh-CN", label: "简体中文 (zh-CN)" },
    { value: "zh-TW", label: "繁體中文 (zh-TW)" },
  ];

  function filterLocaleOptions(
    query: string,
    options: ReadonlyArray<{ value: string; label: string }>,
    maxResults: number,
  ): Array<{ value: string; label: string }> {
    const normalized = query.toLowerCase().trim();
    if (!normalized) return options.slice(0, maxResults);
    return options
      .filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(normalized))
      .slice(0, maxResults);
  }

  function findVoiceCloneFileForDraft(
    draft: VoiceCloneSampleDraft,
  ): File | null {
    if (!draft.fileName) return null;
    return (
      stagedCardCreateFiles.find((file) => {
        const key = getCardCreateFileKey(file);
        const path = key.replace(/\\/g, "/");
        const baseName = path.split("/").pop() ?? path;
        // Match by baseName, by exact path, or by metadata.voiceSamples/fileName
        return (
          baseName === draft.fileName ||
          path === draft.fileName ||
          path === `metadata.voiceSamples/${draft.fileName}` ||
          key === draft.fileName
        );
      }) ?? null
    );
  }

  /**
   * Collects the actual File objects for all voice clone sample entries that have
   * a fileName selected in the UI editor, in the same order as the draft entries.
   * These files will be passed to createCardPngFromFiles as voiceCloneSampleFiles.
   */
  function collectVoiceCloneSampleFiles(): File[] {
    const files: File[] = [];
    for (const draft of cardCreateMoAiDraft.voiceSamples) {
      if (!draft.fileName) continue;
      const file = findVoiceCloneFileForDraft(draft);
      if (file) {
        files.push(file);
      }
    }
    return files;
  }

  function getUnassignedVoiceCloneFiles(excludeIndex: number): File[] {
    const assigned = new Set<string>();
    cardCreateMoAiDraft.voiceSamples.forEach((draft, i) => {
      if (i !== excludeIndex && draft.fileName) {
        assigned.add(draft.fileName);
      }
    });
    return stagedCardCreateFiles.filter((file) => {
      const kind = getCardCreatorInputKind(file);
      if (kind !== "voice-clone-sample" && kind !== "webm") return false;
      const key = getCardCreateFileKey(file);
      const path = key.replace(/\\/g, "/");
      const baseName = path.split("/").pop() ?? path;
      // Check if this file's name is already assigned to another row
      return !assigned.has(baseName) && !assigned.has(path);
    });
  }

  function showToastNotification(message: string): void {
    const existing = document.querySelector(".card-toast-notification");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "card-toast-notification";
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger enter animation
    requestAnimationFrame(() => toast.classList.add("card-toast-visible"));

    setTimeout(() => {
      toast.classList.remove("card-toast-visible");
      toast.addEventListener("transitionend", () => toast.remove(), {
        once: true,
      });
      // Fallback removal in case transitionend doesn't fire
      setTimeout(() => toast.remove(), 400);
    }, 3000);
  }

  function stopActiveVoiceAudio(): void {
    if (activeVoiceAudio) {
      activeVoiceAudio.audio.pause();
      activeVoiceAudio.audio.currentTime = 0;
      URL.revokeObjectURL(activeVoiceAudio.objectUrl);
      activeVoiceAudio = null;
    }
  }

  function closeAllVoiceDropdowns(): void {
    document
      .querySelectorAll(".card-voice-locale-dropdown")
      .forEach((el) => el.remove());
  }

  function renderCardCreateVoiceRows(): void {
    // Stop any playing audio before re-rendering
    stopActiveVoiceAudio();
    closeAllVoiceDropdowns();
    cardCreateVoiceList.innerHTML = "";

    cardCreateMoAiDraft.voiceSamples.forEach((draft, index) => {
      const row = document.createElement("div");
      row.className = "card-voice-row";

      // --- File selection select ---
      const matchedFile = findVoiceCloneFileForDraft(draft);
      const isMissing = draft.fileName !== "" && !matchedFile;

      const fileSelect = document.createElement("select");
      if (isMissing) {
        fileSelect.classList.add("card-voice-file-select-missing");
      }

      // Placeholder option
      const placeholderOpt = document.createElement("option");
      placeholderOpt.value = "";
      placeholderOpt.textContent = text.voiceCloneSelectFile;
      fileSelect.appendChild(placeholderOpt);

      // Populate with available files + currently selected file
      const availableFiles = getUnassignedVoiceCloneFiles(index);
      const filePaths = new Set<string>();
      for (const file of availableFiles) {
        const key = getCardCreateFileKey(file);
        const path = key.replace(/\\/g, "/");
        filePaths.add(path);
      }
      // Include currently selected file even if assigned
      if (matchedFile) {
        const key = getCardCreateFileKey(matchedFile);
        const path = key.replace(/\\/g, "/");
        filePaths.add(path);
      }

      const sortedPaths = [...filePaths].sort();
      for (const path of sortedPaths) {
        const opt = document.createElement("option");
        opt.value = path;
        opt.textContent = path;
        if (
          draft.fileName &&
          (path === draft.fileName ||
            path.split("/").pop() === draft.fileName ||
            path === `metadata.voiceSamples/${draft.fileName}`)
        ) {
          opt.selected = true;
        }
        fileSelect.appendChild(opt);
      }

      // If the current value is missing from options, add it at the top
      if (
        draft.fileName &&
        !sortedPaths.some(
          (p) =>
            p === draft.fileName ||
            p.split("/").pop() === draft.fileName ||
            p === `metadata.voiceSamples/${draft.fileName}`,
        )
      ) {
        const opt = document.createElement("option");
        opt.value = draft.fileName;
        opt.textContent = draft.fileName;
        opt.selected = true;
        fileSelect.insertBefore(opt, fileSelect.firstChild);
      }

      fileSelect.addEventListener("change", async () => {
        const selectedPath = fileSelect.value;
        if (!selectedPath) {
          cardCreateMoAiDraft.voiceSamples[index].fileName = "";
          renderCardCreateVoiceRows();
          return;
        }

        // Find the actual file object
        const file = stagedCardCreateFiles.find((f) => {
          const key = getCardCreateFileKey(f);
          const p = key.replace(/\\/g, "/");
          return p === selectedPath;
        });

        if (file) {
          // Validate duration
          const objectUrl = URL.createObjectURL(file);
          try {
            const duration = await getAudioDuration(objectUrl);
            if (duration < 3 || duration > 20) {
              // Revert selection and show toast notification
              const previousValue = draft.fileName;
              showToastNotification(
                `${text.voiceCloneDurationError} (${duration.toFixed(1)}s)`,
              );
              // Revert select to previous value
              if (previousValue) {
                fileSelect.value = previousValue;
              } else {
                fileSelect.value = "";
              }
              return;
            }
          } catch {
            // If we can't determine duration, allow it
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        }

        cardCreateMoAiDraft.voiceSamples[index].fileName = selectedPath;
        renderCardCreateVoiceRows();
      });

      // --- Details row (second line): sampleName, locale, play, remove ---
      const details = document.createElement("div");
      details.className = "card-voice-details";

      // --- Sample name input ---
      const sampleNameInput = document.createElement("input");
      sampleNameInput.type = "text";
      sampleNameInput.placeholder = text.voiceCloneSampleNameLabel;
      sampleNameInput.value = draft.sampleName;
      sampleNameInput.addEventListener("input", () => {
        cardCreateMoAiDraft.voiceSamples[index].sampleName =
          sampleNameInput.value;
      });

      // --- Locale typeahead button ---
      const localeBtn = document.createElement("button");
      localeBtn.type = "button";
      localeBtn.className = "card-voice-locale-btn";

      const currentLocaleOption = VOICE_CLONE_LOCALE_OPTIONS.find(
        (o) => o.value === draft.locale,
      );
      if (currentLocaleOption && currentLocaleOption.value) {
        localeBtn.textContent = currentLocaleOption.label;
      } else {
        localeBtn.textContent = text.voiceCloneLocalePlaceholder;
        localeBtn.classList.add("card-voice-locale-btn-placeholder");
      }

      localeBtn.addEventListener("click", () => {
        // Close any other open dropdowns
        closeAllVoiceDropdowns();

        const dropdown = document.createElement("div");
        dropdown.className = "card-voice-locale-dropdown";

        // Filter input
        const filterInput = document.createElement("input");
        filterInput.type = "text";
        filterInput.className = "card-voice-locale-filter";
        filterInput.placeholder = text.voiceCloneLocalePlaceholder;

        // Options container
        const optionsContainer = document.createElement("div");
        optionsContainer.className = "card-voice-locale-options";

        let activeIdx = -1;
        let filtered: Array<{ value: string; label: string }> = [];

        function renderOptions(query: string): void {
          filtered = filterLocaleOptions(query, VOICE_CLONE_LOCALE_OPTIONS, 12);
          activeIdx = filtered.findIndex((o) => o.value === draft.locale);
          if (activeIdx < 0 && filtered.length > 0) activeIdx = 0;
          optionsContainer.innerHTML = "";

          filtered.forEach((option, i) => {
            const optBtn = document.createElement("button");
            optBtn.type = "button";
            optBtn.className = "card-voice-locale-option";
            optBtn.textContent = option.label;
            optBtn.title = option.value;
            if (i === activeIdx) optBtn.classList.add("active");
            if (option.value === draft.locale) optBtn.classList.add("selected");

            optBtn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              cardCreateMoAiDraft.voiceSamples[index].locale = option.value;
              dropdown.remove();
              renderCardCreateVoiceRows();
            });

            optBtn.addEventListener("mouseenter", () => {
              activeIdx = i;
              optionsContainer
                .querySelectorAll(".card-voice-locale-option")
                .forEach((el, j) => {
                  el.classList.toggle("active", j === activeIdx);
                });
            });

            optionsContainer.appendChild(optBtn);
          });
        }

        filterInput.addEventListener("input", () => {
          renderOptions(filterInput.value);
        });

        filterInput.addEventListener("keydown", (ev) => {
          if (ev.key === "ArrowDown") {
            ev.preventDefault();
            if (filtered.length === 0) return;
            activeIdx = activeIdx < 0 ? 0 : (activeIdx + 1) % filtered.length;
            optionsContainer
              .querySelectorAll(".card-voice-locale-option")
              .forEach((el, j) => {
                el.classList.toggle("active", j === activeIdx);
              });
            // Scroll active into view
            const activeEl = optionsContainer.children[activeIdx] as
              | HTMLElement
              | undefined;
            activeEl?.scrollIntoView({ block: "nearest" });
          } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            if (filtered.length === 0) return;
            activeIdx = activeIdx <= 0 ? filtered.length - 1 : activeIdx - 1;
            optionsContainer
              .querySelectorAll(".card-voice-locale-option")
              .forEach((el, j) => {
                el.classList.toggle("active", j === activeIdx);
              });
            const activeEl = optionsContainer.children[activeIdx] as
              | HTMLElement
              | undefined;
            activeEl?.scrollIntoView({ block: "nearest" });
          } else if (ev.key === "Enter") {
            ev.preventDefault();
            if (activeIdx >= 0 && filtered[activeIdx]) {
              cardCreateMoAiDraft.voiceSamples[index].locale =
                filtered[activeIdx].value;
              dropdown.remove();
              renderCardCreateVoiceRows();
            }
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            dropdown.remove();
          }
        });

        dropdown.appendChild(filterInput);
        dropdown.appendChild(optionsContainer);
        renderOptions("");

        // Position dropdown
        document.body.appendChild(dropdown);
        const btnRect = localeBtn.getBoundingClientRect();
        dropdown.style.left = `${btnRect.left}px`;
        dropdown.style.top = `${btnRect.bottom + 2}px`;

        // Auto-focus filter on desktop
        const hasCoarsePointer =
          window.matchMedia?.("(pointer: coarse)").matches ?? false;
        if (navigator.maxTouchPoints <= 0 && !hasCoarsePointer) {
          setTimeout(() => filterInput.focus(), 0);
        }

        // Close on outside click
        const closeHandler = (ev: MouseEvent) => {
          if (!dropdown.contains(ev.target as Node)) {
            dropdown.remove();
            document.removeEventListener("click", closeHandler);
          }
        };
        setTimeout(() => document.addEventListener("click", closeHandler), 0);
      });

      // --- Play/Stop button ---
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "card-voice-play-btn";
      playBtn.textContent = "▶";
      playBtn.ariaLabel = text.voiceClonePlay;
      playBtn.title = text.voiceClonePlay;
      playBtn.disabled = !matchedFile;

      playBtn.addEventListener("click", () => {
        if (!matchedFile) return;

        // If this row's audio is already playing, stop it
        if (activeVoiceAudio && activeVoiceAudio.rowIndex === index) {
          stopActiveVoiceAudio();
          playBtn.textContent = "▶";
          playBtn.ariaLabel = text.voiceClonePlay;
          playBtn.title = text.voiceClonePlay;
          playBtn.classList.remove("card-voice-playing");
          return;
        }

        // Stop any other playing audio
        stopActiveVoiceAudio();
        // Reset any other play buttons in the list
        cardCreateVoiceList
          .querySelectorAll(".card-voice-play-btn")
          .forEach((btn) => {
            (btn as HTMLElement).textContent = "▶";
            btn.classList.remove("card-voice-playing");
          });

        const objectUrl = URL.createObjectURL(matchedFile);
        const audio = new Audio(objectUrl);
        activeVoiceAudio = { audio, objectUrl, rowIndex: index };

        playBtn.textContent = "⏹";
        playBtn.ariaLabel = text.voiceCloneStop;
        playBtn.title = text.voiceCloneStop;
        playBtn.classList.add("card-voice-playing");

        audio.addEventListener("ended", () => {
          if (activeVoiceAudio?.rowIndex === index) {
            stopActiveVoiceAudio();
          }
          playBtn.textContent = "▶";
          playBtn.ariaLabel = text.voiceClonePlay;
          playBtn.title = text.voiceClonePlay;
          playBtn.classList.remove("card-voice-playing");
        });

        audio.play().catch(() => {
          stopActiveVoiceAudio();
          playBtn.textContent = "▶";
          playBtn.ariaLabel = text.voiceClonePlay;
          playBtn.title = text.voiceClonePlay;
          playBtn.classList.remove("card-voice-playing");
        });
      });

      // --- Remove button ---
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "card-remove-btn";
      removeBtn.textContent = "🗑";
      removeBtn.ariaLabel = text.voiceCloneRemove;
      removeBtn.title = text.voiceCloneRemove;
      removeBtn.addEventListener("click", () => {
        if (activeVoiceAudio?.rowIndex === index) {
          stopActiveVoiceAudio();
        }
        cardCreateMoAiDraft.voiceSamples =
          cardCreateMoAiDraft.voiceSamples.filter(
            (_, rowIndex) => rowIndex !== index,
          );
        renderCardCreateVoiceRows();
        syncCardCreateMetadataEditorsDisabledState(false);
      });

      details.append(sampleNameInput, localeBtn, removeBtn);
      row.append(fileSelect, playBtn, details);
      cardCreateVoiceList.appendChild(row);
    });
  }

  function getAudioDuration(objectUrl: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.addEventListener("loadedmetadata", () => {
        resolve(audio.duration);
      });
      audio.addEventListener("error", () => {
        reject(new Error("Failed to load audio"));
      });
      audio.src = objectUrl;
    });
  }

  function syncCardCreateMetadataEditorsDisabledState(nextBusy: boolean): void {
    const hasModelInput = hasCardCreateModelInput(stagedCardCreateFiles);
    cardCreateUInfEditInput.disabled = nextBusy || !hasModelInput;
    cardCreateFBtnEditInput.disabled = nextBusy || !hasModelInput;
    cardCreateMoAiEditInput.disabled = nextBusy || !hasModelInput;

    setCardCreateMetadataFieldsDisabled(
      cardCreateUInfFields,
      nextBusy || !hasModelInput || !cardCreateUInfEditInput.checked,
    );
    setCardCreateMetadataFieldsDisabled(
      cardCreateFBtnFields,
      nextBusy || !hasModelInput || !cardCreateFBtnEditInput.checked,
    );
    setCardCreateMetadataFieldsDisabled(
      cardCreateMoAiFields,
      nextBusy || !hasModelInput || !cardCreateMoAiEditInput.checked,
    );
  }

  function getAvailableWebmAudioFiles(): File[] {
    return stagedCardCreateFiles.filter(
      (file) => getCardCreatorInputKind(file) === "webm",
    );
  }

  function findWebmAudioFileByPath(path: string): File | null {
    return (
      stagedCardCreateFiles.find((file) => {
        const key = getCardCreateFileKey(file);
        const p = key.replace(/\\/g, "/");
        return p === path;
      }) ?? null
    );
  }

  function renderWebmAudioSelect(): void {
    cardCreateWebmAudioSelect.innerHTML = "";

    const webmFiles = getAvailableWebmAudioFiles();

    // If the selected file no longer exists, clear it
    if (selectedCardCreateWebmFilePath) {
      const stillExists = webmFiles.some((file) => {
        const key = getCardCreateFileKey(file);
        return key.replace(/\\/g, "/") === selectedCardCreateWebmFilePath;
      });
      if (!stillExists) {
        selectedCardCreateWebmFilePath = null;
      }
    }

    const select = document.createElement("select");
    select.className = "card-webm-audio-dropdown";
    select.disabled = cardCreateBusy;

    // Placeholder option
    const placeholderOpt = document.createElement("option");
    placeholderOpt.value = "";
    placeholderOpt.textContent = text.webmAudioSelectFile;
    select.appendChild(placeholderOpt);

    // Sort webm files by path
    const sortedPaths = webmFiles
      .map((file) => {
        const key = getCardCreateFileKey(file);
        return key.replace(/\\/g, "/");
      })
      .sort();

    for (const path of sortedPaths) {
      const opt = document.createElement("option");
      opt.value = path;
      opt.textContent = path;
      if (path === selectedCardCreateWebmFilePath) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }

    select.addEventListener("change", () => {
      selectedCardCreateWebmFilePath = select.value || null;
    });

    if (sortedPaths.length === 0) {
      select.disabled = true;
    }

    cardCreateWebmAudioSelect.appendChild(select);
  }

  /**
   * If no WebM audio is selected yet and a model file (pmx/bpmx) is selected,
   * try to auto-select a WebM file that shares the same base name as the model.
   */
  function tryAutoSelectWebmAudio(): void {
    if (selectedCardCreateWebmFilePath) return;
    if (!selectedCardCreateModelFile) return;

    const modelKey = getCardCreateFileKey(selectedCardCreateModelFile);
    const modelBaseName = stripExt(modelKey.split("/").pop() ?? modelKey);

    const webmFiles = getAvailableWebmAudioFiles();
    const match = webmFiles.find((file) => {
      const webmKey = getCardCreateFileKey(file);
      const webmBaseName = stripExt(webmKey.split("/").pop() ?? webmKey);
      return webmBaseName === modelBaseName;
    });

    if (match) {
      selectedCardCreateWebmFilePath = getCardCreateFileKey(match).replace(
        /\\/g,
        "/",
      );
    }
  }

  function syncCardCreateBuildAvailability(nextBusy: boolean): void {
    cardCreateBuildBtn.disabled =
      nextBusy || !hasCardCreateEmbeddableInput(stagedCardCreateFiles);
    if (!nextBusy && stagedCardCreateFiles.length === 0) {
      cardCreateStatus.textContent = EMPTY_INPUT_STATUS;
    }
  }

  async function refreshCardCreateMetadataEditors(): Promise<void> {
    const refreshToken = ++cardCreateMetadataRefreshToken;

    const uInfFile = getCardCreateMetadataFile("uInf");
    if (!uInfFile) {
      cardCreateMetadataSourceKeys.uInf = null;
      cardCreateUInfSource.textContent = hasCardCreateModelInput(
        stagedCardCreateFiles,
      )
        ? formatTemplate(text.metadataMissingEditTemplate, {
            file: "metadata.uInf.json",
          })
        : text.metadataEditableWhenModelLoaded;
    } else if (
      cardCreateMetadataSourceKeys.uInf !== getCardCreateFileKey(uInfFile)
    ) {
      try {
        cardCreateUInfDraft = parseUInfDraft(await readJsonFile(uInfFile));
        if (refreshToken !== cardCreateMetadataRefreshToken) return;
        cardCreateUInfSource.textContent = formatTemplate(
          text.metadataSourceTemplate,
          { path: getCardCreateFileKey(uInfFile) },
        );
      } catch {
        if (refreshToken !== cardCreateMetadataRefreshToken) return;
        cardCreateUInfDraft = createEmptyUInfDraft();
        cardCreateUInfSource.textContent = formatTemplate(
          text.metadataInvalidJsonTemplate,
          { path: getCardCreateFileKey(uInfFile) },
        );
      }
      cardCreateMetadataSourceKeys.uInf = getCardCreateFileKey(uInfFile);
    }

    const fBtnFiles = getCardCreateMetadataFiles("fBtn");
    if (fBtnFiles.length === 0) {
      cardCreateMetadataSourceKeys.fBtn = null;
      cardCreateFBtnSource.textContent = hasCardCreateModelInput(
        stagedCardCreateFiles,
      )
        ? formatTemplate(text.metadataMissingEditTemplate, {
            file: "metadata.fBtn.json",
          })
        : text.metadataEditableWhenModelLoaded;
    } else {
      const fBtnCompositeKey = fBtnFiles
        .map((file) => getCardCreateFileDisplayKey(file))
        .join(" | ");
      if (cardCreateMetadataSourceKeys.fBtn !== fBtnCompositeKey) {
        const mergedRows: CardCreateFastButtonDraft[] = [];
        const invalidLabels: string[] = [];
        for (const file of fBtnFiles) {
          try {
            const rows = parseFastButtonRows(await readJsonFile(file));
            const sourceSeq = getCardCreateFileSeq(file);
            mergedRows.push(...rows.map((row) => ({ ...row, sourceSeq })));
          } catch {
            invalidLabels.push(getCardCreateFileDisplayKey(file));
          }
        }
        if (refreshToken !== cardCreateMetadataRefreshToken) return;
        cardCreateFBtnDrafts =
          mergedRows.length > 0 ? mergedRows : [createEmptyFastButtonDraft()];
        cardCreateFBtnSource.textContent = buildCardCreateMetadataSourceText(
          fBtnFiles,
          invalidLabels,
        );
        cardCreateMetadataSourceKeys.fBtn = fBtnCompositeKey;
      }
    }

    const moAiFiles = getCardCreateMetadataFiles("moAi");
    if (moAiFiles.length === 0) {
      cardCreateMetadataSourceKeys.moAi = null;
      cardCreateMoAiSource.textContent = hasCardCreateModelInput(
        stagedCardCreateFiles,
      )
        ? formatTemplate(text.metadataMissingEditTemplate, {
            file: "metadata.moAi.json",
          })
        : text.metadataEditableWhenModelLoaded;
    } else {
      const moAiCompositeKey = moAiFiles
        .map((file) => getCardCreateFileDisplayKey(file))
        .join(" | ");
      if (cardCreateMetadataSourceKeys.moAi !== moAiCompositeKey) {
        const mergedMorphs: MorphDescDraft[] = [];
        const mergedVoiceSamples: VoiceCloneSampleDraft[] = [];
        let scalarDraft: {
          name: string;
          gender: string;
          info: string;
        } | null = null;
        const invalidLabels: string[] = [];
        for (const file of moAiFiles) {
          try {
            const draft = parseMoAiDraft(await readJsonFile(file));
            const sourceSeq = getCardCreateFileSeq(file);
            mergedMorphs.push(
              ...draft.morphs.map((morph) => ({ ...morph, sourceSeq })),
            );
            mergedVoiceSamples.push(...draft.voiceSamples);
            scalarDraft = draft; // files are in add order → last valid wins
          } catch {
            invalidLabels.push(getCardCreateFileDisplayKey(file));
          }
        }
        if (refreshToken !== cardCreateMetadataRefreshToken) return;
        cardCreateMoAiDraft = {
          name: scalarDraft?.name ?? "",
          gender: scalarDraft?.gender ?? "",
          info: scalarDraft?.info ?? "",
          morphs: mergedMorphs,
          voiceSamples: mergedVoiceSamples,
        };
        cardCreateMoAiSource.textContent = buildCardCreateMetadataSourceText(
          moAiFiles,
          invalidLabels,
        );
        cardCreateMetadataSourceKeys.moAi = moAiCompositeKey;
      }
    }

    cardCreateUInfAuthInput.value = cardCreateUInfDraft.auth;
    cardCreateUInfChInput.value = cardCreateUInfDraft.ch;
    cardCreateUInfInfoInput.value = cardCreateUInfDraft.info;
    cardCreateMoAiNameInput.value = cardCreateMoAiDraft.name;
    cardCreateMoAiGenderInput.value = cardCreateMoAiDraft.gender;
    cardCreateMoAiInfoInput.value = cardCreateMoAiDraft.info;
    await loadMorphNamesFromModel();
    renderCardCreateFastButtonRows();
    renderCardCreateMorphRows();
    renderCardCreateVoiceRows();
    syncCardCreateMetadataEditorsDisabledState(false);
  }

  function collectCardCreateMetadataOverrides(): Partial<
    Record<CardCreateMetadataKey, unknown>
  > {
    const overrides: Partial<Record<CardCreateMetadataKey, unknown>> = {};
    if (cardCreateUInfEditInput.checked) {
      overrides.uInf = buildUInfOverride(cardCreateUInfDraft);
    }

    // fBtn/moAi: duplicated metadata files are merged automatically. The
    // merged, de-duplicated ("last added wins") and validated result
    // replaces the staged files — even when the edit checkbox is not ticked.
    const fBtnFiles = getCardCreateMetadataFiles("fBtn");
    const fBtnAutoMerge =
      fBtnFiles.length > 1 ||
      (fBtnFiles.length === 1 &&
        hasCardMetadataFilterableEntries(
          cardCreateFBtnDrafts,
          cardCreateMorphNames,
          (draft) => draft.morph,
        ));
    if (cardCreateFBtnEditInput.checked || fBtnAutoMerge) {
      overrides.fBtn = buildFastButtonOverride(
        finalizeCardMetadataEntries(
          cardCreateFBtnDrafts,
          cardCreateMorphNames,
          (draft) => draft.morph,
        ),
      );
    }

    const moAiFiles = getCardCreateMetadataFiles("moAi");
    const moAiAutoMerge =
      moAiFiles.length > 1 ||
      (moAiFiles.length === 1 &&
        hasCardMetadataFilterableEntries(
          cardCreateMoAiDraft.morphs,
          cardCreateMorphNames,
          (draft) => draft.index,
          (draft) => draft.name,
        ));
    if (cardCreateMoAiEditInput.checked || moAiAutoMerge) {
      overrides.moAi = buildMoAiOverride({
        ...cardCreateMoAiDraft,
        morphs: finalizeCardMetadataEntries(
          cardCreateMoAiDraft.morphs,
          cardCreateMorphNames,
          (draft) => draft.index,
          (draft) => draft.name,
          (draft, remappedIndex) => ({
            ...draft,
            index: String(remappedIndex),
          }),
        ),
      });
    }
    return overrides;
  }

  function setCardCreateBusy(nextBusy: boolean): void {
    cardCreateBusy = nextBusy;
    cardCreateFolderBtn.disabled = nextBusy;
    cardCreateZipBtn.disabled = nextBusy;
    cardCreateFilesBtn.disabled = nextBusy;
    cardCreateClearAllBtn.disabled = nextBusy;
    cardCreateFolderInput.disabled = nextBusy;
    cardCreateZipInput.disabled = nextBusy;
    cardCreateFilesInput.disabled = nextBusy;
    cardCreateImageInput.disabled = nextBusy;
    cardCreateRemoveImageBtn.disabled = nextBusy;
    cardCreateReplaceImageBtn.disabled = nextBusy;
    cardCreateCompressMode.disabled = nextBusy;
    cardCreateDropZone.classList.toggle("drop-zone-disabled", nextBusy);
    cardCreateFileList.classList.toggle("file-list-disabled", nextBusy);
    tabBtns.forEach((btn) => {
      btn.disabled = nextBusy;
    });
    syncCardCreateCompressionUi();
    syncCardCreateMetadataEditorsDisabledState(nextBusy);
    syncCardCreateBuildAvailability(nextBusy);
    renderCardCreateFileList();
  }

  function resetCardCreateInputs(): void {
    stagedCardCreateFiles = [];
    cardCreateFileSeqByKey.clear();
    cardCreateFileSeqCounter = 0;
    selectedCardCreateBaseImage = null;
    selectedCardCreateModelFile = null;
    cardCreatePreferDefaultBaseImage = false;
    cardCreateLastSourceLabel = null;
    cardCreateBusy = false;
    cardCreateCompressToAvifSet = new Set();
    cardCreateActualResultFiles = null;
    cardCreateUInfDraft = createEmptyUInfDraft();
    cardCreateFBtnDrafts = [createEmptyFastButtonDraft()];
    cardCreateMoAiDraft = createEmptyMoAiDraft();
    cardCreateMorphNames = [];
    renderCardCreateMorphRows();
    renderCardCreateFastButtonRows();
    renderCardCreateVoiceRows();
    selectedCardCreateWebmFilePath = null;
    renderWebmAudioSelect();
    cardCreateMetadataSourceKeys.uInf = null;
    cardCreateMetadataSourceKeys.fBtn = null;
    cardCreateMetadataSourceKeys.moAi = null;
    cardCreateUInfEditInput.checked = false;
    cardCreateFBtnEditInput.checked = false;
    cardCreateMoAiEditInput.checked = false;
    cardCreateFolderInput.value = "";
    cardCreateZipInput.value = "";
    cardCreateFilesInput.value = "";
    cardCreateImageInput.value = "";
    renderCardCreateFileList();
    updateCardCreatePreview();
    syncCardCreateCompressionUi();
    updateCardCreateLoadedState();
    void refreshCardCreateMetadataEditors();
    syncCardCreateBuildAvailability(false);
  }

  function updateCardCreatePreview(): void {
    if (cardCreatePreviewUrl) {
      URL.revokeObjectURL(cardCreatePreviewUrl);
      cardCreatePreviewUrl = null;
    }

    if (selectedCardCreateBaseImage) {
      cardCreatePreviewUrl = URL.createObjectURL(selectedCardCreateBaseImage);
      cardCreatePreviewImage.src = cardCreatePreviewUrl;
      cardCreatePreviewSource.textContent = formatTemplate(
        text.baseImageLabel,
        {
          path: getCardCreateFileKey(selectedCardCreateBaseImage),
        },
      );
      return;
    }

    cardCreatePreviewImage.src = getDefaultCardBaseImageUrl();
    cardCreatePreviewSource.textContent = text.cardCreatePreviewDefault;
  }

  function syncCardCreateBaseImage(): void {
    if (cardCreatePreferDefaultBaseImage) {
      selectedCardCreateBaseImage = null;
      updateCardCreatePreview();
      return;
    }

    if (
      selectedCardCreateBaseImage &&
      stagedCardCreateFiles.includes(selectedCardCreateBaseImage)
    ) {
      updateCardCreatePreview();
      return;
    }

    selectedCardCreateBaseImage =
      pickPreferredCardBaseImage(stagedCardCreateFiles) ?? null;
    updateCardCreatePreview();
  }

  function getCardCreateBuildFiles(): File[] {
    return stagedCardCreateFiles.filter((file) => {
      if (!isCardCreateModelCandidate(file)) {
        return true;
      }

      return (
        !selectedCardCreateModelFile || file === selectedCardCreateModelFile
      );
    });
  }

  function renderCardCreateFileList(): void {
    cardCreateFileList.innerHTML = "";
    cardCreateFileListWrap.hidden = stagedCardCreateFiles.length === 0;

    for (const file of stagedCardCreateFiles) {
      const fileKey = getCardCreateFileKey(file);
      const isModelCandidate = isCardCreateModelCandidate(file);
      const canSelectForLossy =
        cardCreateUsesPmxConversion() &&
        isCardCreateTextureCandidate(file) &&
        cardCreateCompressMode.value !== "raw";
      const resultFile = cardCreateActualResultFiles?.get(fileKey) ?? null;
      const li = document.createElement("li");
      li.classList.add(isModelCandidate ? "pmx-entry" : "other-entry");

      const pathSpan = document.createElement("span");
      pathSpan.className = "file-path";
      pathSpan.textContent = getCardCreateFileDisplayKey(file);

      const roleTag = document.createElement("span");
      roleTag.className = "card-role-tag";
      roleTag.textContent = describeCardCreateRole(file);

      const meta = document.createElement("span");
      meta.className = "file-meta";
      meta.textContent = formatSize(file.size);

      if (isModelCandidate) {
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "cardcreate-model-selector";
        radio.value = fileKey;
        radio.checked = file === selectedCardCreateModelFile;
        radio.disabled = cardCreateBusy;
        radio.addEventListener("change", async () => {
          if (cardCreateBusy || !radio.checked) return;
          selectedCardCreateModelFile = file;
          clearCardCreateActualResultFiles();
          syncCardCreateCompressionUi();
          updateCardCreateLoadedState(true);
          tryAutoSelectWebmAudio();
          renderCardCreateFileList();
          renderWebmAudioSelect();
          await loadMorphNamesFromModel();
          renderCardCreateMorphRows();
          renderCardCreateFastButtonRows();
        });

        li.append(radio, pathSpan, roleTag, meta);

        li.addEventListener("click", (event) => {
          if (cardCreateBusy) return;
          const target = event.target as HTMLElement;
          if (target.closest("input, button")) {
            return;
          }
          radio.checked = true;
          radio.dispatchEvent(new Event("change"));
        });
      } else if (
        canSelectForLossy &&
        cardCreateCompressMode.value === "lossy"
      ) {
        li.classList.add("compressible-entry");

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "compress-check";
        checkbox.checked = cardCreateCompressToAvifSet.has(file);
        checkbox.disabled = cardCreateBusy;
        checkbox.addEventListener("change", () => {
          if (cardCreateBusy) return;
          if (checkbox.checked) {
            cardCreateCompressToAvifSet.add(file);
          } else {
            cardCreateCompressToAvifSet.delete(file);
          }
          clearCardCreateActualResultFiles();
          updateCardCreateSelectAllBtn();
          renderCardCreateFileList();
        });

        li.append(checkbox, pathSpan, roleTag, meta);

        li.addEventListener("click", (event) => {
          if (cardCreateBusy) return;
          const target = event.target as HTMLElement;
          if (target.closest("input, button")) {
            return;
          }
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change"));
        });
      } else {
        li.append(pathSpan, roleTag, meta);
      }

      if (resultFile && canSelectForLossy) {
        li.append(buildCardCreateResultSpan(file, resultFile));
      }

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "card-remove-btn";
      removeBtn.textContent = text.remove;
      removeBtn.disabled = cardCreateBusy;
      removeBtn.addEventListener("click", () => {
        if (cardCreateBusy) return;
        const previousFiles = stagedCardCreateFiles;
        stagedCardCreateFiles = stagedCardCreateFiles.filter(
          (candidate) => candidate !== file,
        );
        cardCreateFileSeqByKey.delete(getCardCreateFileKey(file));
        if (selectedCardCreateBaseImage === file) {
          selectedCardCreateBaseImage = null;
        }
        if (selectedCardCreateModelFile === file) {
          selectedCardCreateModelFile = null;
        }
        const removedPath = getCardCreateFileKey(file).replace(/\\/g, "/");
        if (removedPath === selectedCardCreateWebmFilePath) {
          selectedCardCreateWebmFilePath = null;
        }
        syncCardCreateModelSelection();
        syncCardCreateBaseImage();
        syncCardCreateLossySelection(previousFiles);
        clearCardCreateActualResultFiles();
        syncCardCreateCompressionUi();
        tryAutoSelectWebmAudio();
        renderCardCreateFileList();
        renderWebmAudioSelect();
        void refreshCardCreateMetadataEditors();
        syncCardCreateBuildAvailability(false);
        updateCardCreateLoadedState(true);
      });

      li.append(removeBtn);
      cardCreateFileList.appendChild(li);
    }
  }

  function mergeCardCreateFiles(
    incomingFiles: File[],
    sourceLabel: string,
  ): void {
    const previousFiles = stagedCardCreateFiles;
    const merged = new Map<string, File>();
    for (const file of stagedCardCreateFiles) {
      merged.set(getCardCreateFileKey(file), file);
    }
    for (const file of incomingFiles) {
      const key = getCardCreateFileKey(file);
      const kind = getCardCreatorInputKind(file);
      const existing = merged.get(key);
      if (
        existing !== undefined &&
        existing !== file &&
        (kind === "metadata-fBtn" || kind === "metadata-moAi")
      ) {
        // Dropped fBtn/moAi file whose key is already staged (e.g. the same
        // file name inside a loaded ZIP): stage it as an ADDITIONAL entry
        // with a unique pseudo-folder key instead of replacing the existing
        // one. The prefix keeps the base name (and with it the file
        // classification) intact; the file list still shows the original
        // path plus the duplicate counter.
        const baseName = key.split("/").pop() ?? key;
        let suffix = 2;
        while (merged.has(`duplicate-${suffix}/${baseName}`)) suffix++;
        // webkitRelativePath is getter-only on File instances; shadow it
        // with defineProperty (same technique as readZipFiles).
        Object.defineProperty(file, "webkitRelativePath", {
          value: `duplicate-${suffix}/${baseName}`,
          configurable: true,
        });
        cardCreateDisplayKeyOverrides.set(file, key);
      }
      merged.set(getCardCreateFileKey(file), file);
    }

    const mergedKeys = new Set(merged.keys());
    for (const key of Array.from(cardCreateFileSeqByKey.keys())) {
      if (!mergedKeys.has(key)) cardCreateFileSeqByKey.delete(key);
    }
    for (const file of incomingFiles) {
      cardCreateFileSeqByKey.set(
        getCardCreateFileKey(file),
        ++cardCreateFileSeqCounter,
      );
    }

    stagedCardCreateFiles = Array.from(merged.values()).sort((left, right) =>
      getCardCreateFileKey(left).localeCompare(getCardCreateFileKey(right)),
    );
    cardCreateLastSourceLabel = sourceLabel;
    syncCardCreateModelSelection();
    syncCardCreateBaseImage();
    syncCardCreateLossySelection(previousFiles);
    clearCardCreateActualResultFiles();
    renderCardCreateFileList();
    tryAutoSelectWebmAudio();
    renderWebmAudioSelect();
    void refreshCardCreateMetadataEditors();
    syncCardCreateBuildAvailability(false);
    syncCardCreateCompressionUi();
    updateCardCreateLoadedState(true);
  }

  async function loadCardCreateZipFile(
    file: File,
    sourceLabel: string,
  ): Promise<void> {
    cardCreateStatus.textContent = text.readZip;
    try {
      mergeCardCreateFiles(readZipFiles(await file.arrayBuffer()), sourceLabel);
    } catch (err) {
      cardCreateStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Takes a list of files and expands any ZIP archives in it by extracting
   * their contents via {@link readZipFiles}. Non-ZIP files are passed through
   * unchanged. Returns a flat array ready for {@link mergeCardCreateFiles}.
   */
  async function expandZipFiles(files: readonly File[]): Promise<File[]> {
    const result: File[] = [];
    for (const file of files) {
      if (getFileExt(file.name) === "zip") {
        const zipContents = readZipFiles(await file.arrayBuffer());
        result.push(...zipContents);
      } else {
        result.push(file);
      }
    }
    return result;
  }

  cardCreateFolderBtn.addEventListener("click", () => {
    if (cardCreateBusy) return;
    cardCreateFolderInput.click();
  });
  cardCreateZipBtn.addEventListener("click", () => {
    if (cardCreateBusy) return;
    cardCreateZipInput.click();
  });
  cardCreateFilesBtn.addEventListener("click", () => {
    if (cardCreateBusy) return;
    cardCreateFilesInput.click();
  });
  cardCreateReplaceImageBtn.addEventListener("click", () => {
    if (cardCreateBusy) return;
    cardCreateImageInput.click();
  });

  cardCreateFolderInput.addEventListener("change", () => {
    if (cardCreateBusy) return;
    const files = Array.from(cardCreateFolderInput.files ?? []);
    cardCreateFolderInput.value = "";
    if (files.length === 0) return;
    mergeCardCreateFiles(files, text.sourceFolder);
  });

  cardCreateZipInput.addEventListener("change", async () => {
    if (cardCreateBusy) return;
    const file = cardCreateZipInput.files?.[0];
    cardCreateZipInput.value = "";
    if (!file) return;
    await loadCardCreateZipFile(file, text.sourceZip);
  });

  cardCreateFilesInput.addEventListener("change", async () => {
    if (cardCreateBusy) return;
    const files = Array.from(cardCreateFilesInput.files ?? []);
    cardCreateFilesInput.value = "";
    if (files.length === 0) return;
    try {
      mergeCardCreateFiles(await expandZipFiles(files), text.sourceFiles);
    } catch (err) {
      cardCreateStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  cardCreateImageInput.addEventListener("change", () => {
    if (cardCreateBusy) return;
    const file = cardCreateImageInput.files?.[0];
    cardCreateImageInput.value = "";
    if (!file) return;
    mergeCardCreateFiles([file], text.sourceBaseImage);
    cardCreatePreferDefaultBaseImage = false;
    selectedCardCreateBaseImage = file;
    updateCardCreatePreview();
    renderCardCreateFileList();
  });

  cardCreateRemoveImageBtn.addEventListener("click", () => {
    if (cardCreateBusy) return;
    const hadExplicitImage = !!selectedCardCreateBaseImage;
    const hadAutoDetectedImage =
      !selectedCardCreateBaseImage &&
      pickPreferredCardBaseImage(stagedCardCreateFiles) !== null;
    if (!hadExplicitImage && !hadAutoDetectedImage) {
      cardCreateStatus.textContent = text.defaultImageAlreadyActive;
      return;
    }

    const previousFiles = stagedCardCreateFiles;
    if (selectedCardCreateBaseImage) {
      stagedCardCreateFiles = stagedCardCreateFiles.filter(
        (file) => file !== selectedCardCreateBaseImage,
      );
    }

    cardCreatePreferDefaultBaseImage = true;
    selectedCardCreateBaseImage = null;
    syncCardCreateModelSelection();
    syncCardCreateBaseImage();
    syncCardCreateLossySelection(previousFiles);
    clearCardCreateActualResultFiles();
    syncCardCreateCompressionUi();
    renderCardCreateFileList();
    void refreshCardCreateMetadataEditors();
    syncCardCreateBuildAvailability(false);
    updateCardCreateLoadedState(true);
    cardCreateStatus.textContent = text.defaultImageActivated;
  });

  cardCreateClearAllBtn.addEventListener("click", () => {
    resetCardCreateInputs();
  });

  cardCreateUInfEditInput.addEventListener("change", () => {
    syncCardCreateMetadataEditorsDisabledState(false);
  });
  cardCreateFBtnEditInput.addEventListener("change", () => {
    syncCardCreateMetadataEditorsDisabledState(false);
  });
  cardCreateMoAiEditInput.addEventListener("change", () => {
    syncCardCreateMetadataEditorsDisabledState(false);
  });
  cardCreateFBtnAddBtn.addEventListener("click", () => {
    cardCreateFBtnDrafts = [
      ...cardCreateFBtnDrafts,
      createEmptyFastButtonDraft(),
    ];
    renderCardCreateFastButtonRows();
    syncCardCreateMetadataEditorsDisabledState(false);
  });
  cardCreateMorphAddBtn.addEventListener("click", () => {
    cardCreateMoAiDraft.morphs = [
      ...cardCreateMoAiDraft.morphs,
      { index: "", name: "", desc: "" },
    ];
    renderCardCreateMorphRows();
    syncCardCreateMetadataEditorsDisabledState(false);
  });
  cardCreateVoiceAddBtn.addEventListener("click", () => {
    cardCreateMoAiDraft.voiceSamples = [
      ...cardCreateMoAiDraft.voiceSamples,
      { index: "", fileName: "", sampleName: "", locale: "" },
    ];
    renderCardCreateVoiceRows();
    syncCardCreateMetadataEditorsDisabledState(false);
  });
  cardCreateUInfAuthInput.addEventListener("input", () => {
    cardCreateUInfDraft.auth = cardCreateUInfAuthInput.value;
  });
  cardCreateUInfChInput.addEventListener("input", () => {
    cardCreateUInfDraft.ch = cardCreateUInfChInput.value;
  });
  cardCreateUInfInfoInput.addEventListener("input", () => {
    cardCreateUInfDraft.info = cardCreateUInfInfoInput.value;
  });
  cardCreateMoAiNameInput.addEventListener("input", () => {
    cardCreateMoAiDraft.name = cardCreateMoAiNameInput.value;
  });
  cardCreateMoAiGenderInput.addEventListener("input", () => {
    cardCreateMoAiDraft.gender = cardCreateMoAiGenderInput.value;
  });
  cardCreateMoAiInfoInput.addEventListener("input", () => {
    cardCreateMoAiDraft.info = cardCreateMoAiInfoInput.value;
  });

  cardCreateCompressMode.addEventListener("change", () => {
    clearCardCreateActualResultFiles();
    syncCardCreateCompressionUi();
    renderCardCreateFileList();
  });

  cardCreateSelectAllCompressBtn.addEventListener("click", () => {
    if (cardCreateBusy) return;

    const compressible = stagedCardCreateFiles.filter((file) =>
      isCardCreateTextureCandidate(file),
    );
    const allSelected =
      compressible.length > 0 &&
      compressible.every((file) => cardCreateCompressToAvifSet.has(file));

    if (allSelected) {
      compressible.forEach((file) => cardCreateCompressToAvifSet.delete(file));
    } else {
      compressible.forEach((file) => cardCreateCompressToAvifSet.add(file));
    }

    clearCardCreateActualResultFiles();
    updateCardCreateSelectAllBtn();
    renderCardCreateFileList();
  });

  cardCreateDropZone.addEventListener("dragover", (event) => {
    if (cardCreateBusy) return;
    event.preventDefault();
    cardCreateDropZone.classList.add("drag-over");
  });
  cardCreateDropZone.addEventListener("dragleave", () => {
    if (cardCreateBusy) return;
    cardCreateDropZone.classList.remove("drag-over");
  });
  cardCreateDropZone.addEventListener("drop", async (event) => {
    if (cardCreateBusy) return;
    event.preventDefault();
    cardCreateDropZone.classList.remove("drag-over");
    const transfer = event.dataTransfer;
    if (!transfer) return;

    const items = Array.from(transfer.items);
    const firstEntry = items[0]?.webkitGetAsEntry?.();
    if (firstEntry?.isDirectory) {
      cardCreateStatus.textContent = text.readFolder;
      try {
        mergeCardCreateFiles(
          await readDirectoryEntry(
            firstEntry as FileSystemDirectoryEntry,
            firstEntry.name,
          ),
          text.sourceFolderDrop,
        );
      } catch (err) {
        cardCreateStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
      }
      return;
    }

    const droppedFiles = Array.from(transfer.files ?? []);
    if (droppedFiles.length > 0) {
      try {
        mergeCardCreateFiles(
          await expandZipFiles(droppedFiles),
          text.sourceFilesDrop,
        );
      } catch (err) {
        cardCreateStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  });

  cardCreateBuildBtn.addEventListener("click", async () => {
    if (cardCreateBusy) return;
    setCardCreateBusy(true);
    cardCreateStatus.textContent = text.createCardInProgress;
    try {
      const voiceCloneSampleFiles = collectVoiceCloneSampleFiles();
      let filesForBuild = getCardCreateBuildFiles();
      // Remove voice clone sample files from regular build files so they are
      // not classified as regular webm/audio and only go into the vcAu chunk.
      if (voiceCloneSampleFiles.length > 0) {
        const voiceCloneSet = new Set(voiceCloneSampleFiles);
        filesForBuild = filesForBuild.filter((f) => !voiceCloneSet.has(f));
      }
      // WebM audio: only include the explicitly selected file. If none is
      // selected, remove all webm-kind files so no webM chunk is embedded.
      if (selectedCardCreateWebmFilePath) {
        const selectedWebmFile = findWebmAudioFileByPath(
          selectedCardCreateWebmFilePath,
        );
        if (selectedWebmFile) {
          filesForBuild = filesForBuild.filter(
            (f) =>
              getCardCreatorInputKind(f) !== "webm" || f === selectedWebmFile,
          );
        } else {
          filesForBuild = filesForBuild.filter(
            (f) => getCardCreatorInputKind(f) !== "webm",
          );
        }
      } else {
        filesForBuild = filesForBuild.filter(
          (f) => getCardCreatorInputKind(f) !== "webm",
        );
      }
      const defaultBaseImageBuffer = selectedCardCreateBaseImage
        ? undefined
        : await getDefaultCardCreateBaseImageBuffer();
      const result = await createCardPngFromFiles(filesForBuild, {
        baseImageFile: selectedCardCreateBaseImage,
        defaultBaseImageBuffer,
        preferDefaultBaseImage: cardCreatePreferDefaultBaseImage,
        metadataOverrides: collectCardCreateMetadataOverrides(),
        voiceCloneSampleFiles:
          voiceCloneSampleFiles.length > 0 ? voiceCloneSampleFiles : undefined,
        compressionMode: cardCreateCompressMode.value as
          | "lossless"
          | "lossy"
          | "raw",
        forceAvif: cardCreateForceAvifInput.checked,
        lossyImageTargets:
          cardCreateCompressMode.value === "lossy"
            ? new Set(
                Array.from(cardCreateCompressToAvifSet).filter((file) =>
                  filesForBuild.includes(file),
                ),
              )
            : undefined,
        onImageProgress: (done, total) => {
          cardCreateStatus.textContent = formatTemplate(
            text.optimizingTextures,
            {
              done,
              total,
            },
          );
        },
      });
      cardCreateActualResultFiles = new Map(
        result.report.preparedImageFiles.map((entry) => [
          entry.sourcePath,
          entry.resultFile,
        ]),
      );
      renderCardCreateSummary(cardCreateSummary, result.report);
      renderCardCreateFileList();
      downloadAs(result.pngBuffer, result.report.outputFileName, "image/png");
      cardCreateStatus.textContent = formatTemplate(text.downloadedStatus, {
        file: result.report.outputFileName,
      });
    } catch (err) {
      cardCreateStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      setCardCreateBusy(false);
    }
  });

  syncCardCreateCompressionUi();
  updateCardCreatePreview();
  renderCardCreateFileList();
  tryAutoSelectWebmAudio();
  renderWebmAudioSelect();
  void refreshCardCreateMetadataEditors();
  syncCardCreateBuildAvailability(false);

  // ── Card Extract → ZIP ─────────────────────────────────────────────────

  const cardExtractDropZone = container.querySelector<HTMLDivElement>(
    "#cardextract-drop-zone",
  )!;
  const cardExtractFileBtn = container.querySelector<HTMLButtonElement>(
    "#cardextract-file-btn",
  )!;
  const cardExtractFileInput =
    container.querySelector<HTMLInputElement>("#cardextract-file")!;
  const cardExtractDropLabel = container.querySelector<HTMLSpanElement>(
    "#cardextract-drop-label",
  )!;
  const cardExtractConvertLegacyInput =
    container.querySelector<HTMLInputElement>("#cardextract-convert-legacy")!;
  const cardExtractLegacyOptions = container.querySelector<HTMLDivElement>(
    "#cardextract-legacy-options",
  )!;
  const cardExtractEncoding = container.querySelector<HTMLSelectElement>(
    "#cardextract-encoding",
  )!;
  const cardExtractRestoreOriginalFormatsInput =
    container.querySelector<HTMLInputElement>(
      "#cardextract-restore-original-formats",
    )!;
  const cardExtractExtractBtn = container.querySelector<HTMLButtonElement>(
    "#cardextract-extract",
  )!;
  const cardExtractStatus = container.querySelector<HTMLSpanElement>(
    "#cardextract-status",
  )!;
  const cardExtractSummary = container.querySelector<HTMLPreElement>(
    "#cardextract-summary",
  )!;

  let stagedCardExtractFile: File | null = null;

  function syncCardExtractAvailability(): void {
    cardExtractExtractBtn.disabled = stagedCardExtractFile === null;
    if (stagedCardExtractFile === null) {
      cardExtractStatus.textContent = EMPTY_INPUT_STATUS;
    }
  }

  function setStagedCardExtractFile(file: File): void {
    stagedCardExtractFile = file;
    cardExtractDropLabel.textContent = `${file.name} (${formatSize(file.size)})`;
    cardExtractStatus.textContent = `${statusReady} - ${file.name}`;
    syncCardExtractAvailability();
  }

  function setCardExtractBusy(nextBusy: boolean): void {
    cardExtractFileBtn.disabled = nextBusy;
    cardExtractFileInput.disabled = nextBusy;
    cardExtractConvertLegacyInput.disabled = nextBusy;
    cardExtractEncoding.disabled =
      nextBusy || !cardExtractConvertLegacyInput.checked;
    cardExtractRestoreOriginalFormatsInput.disabled =
      nextBusy || !cardExtractConvertLegacyInput.checked;
    cardExtractExtractBtn.disabled = nextBusy || stagedCardExtractFile === null;
    tabBtns.forEach((btn) => {
      btn.disabled = nextBusy;
    });
    cardExtractDropZone.classList.toggle("drop-zone-disabled", nextBusy);
  }

  function syncCardExtractLegacyOptions(): void {
    const enabled = cardExtractConvertLegacyInput.checked;
    cardExtractLegacyOptions.hidden = !enabled;
    cardExtractEncoding.disabled = !enabled;
    cardExtractRestoreOriginalFormatsInput.disabled = !enabled;
  }

  cardExtractFileBtn.addEventListener("click", () =>
    cardExtractFileInput.click(),
  );
  cardExtractFileInput.addEventListener("change", () => {
    const file = cardExtractFileInput.files?.[0];
    cardExtractFileInput.value = "";
    if (file) setStagedCardExtractFile(file);
  });
  cardExtractConvertLegacyInput.addEventListener("change", () => {
    syncCardExtractLegacyOptions();
  });

  cardExtractDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    cardExtractDropZone.classList.add("drag-over");
  });
  cardExtractDropZone.addEventListener("dragleave", () => {
    cardExtractDropZone.classList.remove("drag-over");
  });
  cardExtractDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    cardExtractDropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) setStagedCardExtractFile(file);
  });

  cardExtractExtractBtn.addEventListener("click", async () => {
    if (!stagedCardExtractFile) {
      cardExtractStatus.textContent = text.pleaseSelectCardPng;
      return;
    }

    setCardExtractBusy(true);
    cardExtractStatus.textContent = text.extractCardInProgress;
    try {
      const encoding =
        cardExtractEncoding.value === "utf16"
          ? PmxObject.Header.Encoding.Utf16le
          : PmxObject.Header.Encoding.Utf8;
      const result = await extractCardPngToZip(stagedCardExtractFile, {
        convertToLegacyMmdFiles: cardExtractConvertLegacyInput.checked,
        encoding,
        restoreOriginalImageFormats:
          cardExtractRestoreOriginalFormatsInput.checked,
        onImageProgress: (done, total) => {
          cardExtractStatus.textContent = formatTemplate(
            text.optimizingTextures,
            {
              done,
              total,
            },
          );
        },
      });
      renderCardExtractSummary(cardExtractSummary, result.report);
      downloadAs(
        result.zipBuffer,
        `${stripExt(stagedCardExtractFile.name)}.card-extract.zip`,
        "application/zip",
      );
      cardExtractStatus.textContent = formatTemplate(
        text.downloadedZipFilesStatus,
        {
          count: result.report.exportedFiles.length,
        },
      );
    } catch (err) {
      cardExtractStatus.textContent = `${statusErrorPrefix}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      setCardExtractBusy(false);
    }
  });

  syncCardExtractLegacyOptions();
  syncCardExtractAvailability();

  // ── Theme update (without DOM rebuild) ────────────────────────────────────
  function updateTheme(nextTheme: AppTheme): void {
    activeTheme = nextTheme;
    const toggleTo = nextTheme === "dark" ? "light" : "dark";
    const label =
      toggleTo === "dark" ? viewStrings.themeToDark : viewStrings.themeToLight;
    const emoji = toggleTo === "dark" ? "🌙" : "☀️";
    themeToggleBtn.textContent = emoji;
    themeToggleBtn.setAttribute("aria-label", label);
    themeToggleBtn.setAttribute("title", label);
    themeToggleBtn.setAttribute("aria-pressed", String(nextTheme === "dark"));
  }

  return { updateTheme };
}
