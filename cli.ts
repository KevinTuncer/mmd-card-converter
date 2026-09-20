/**
 * ero.dance Converter CLI
 *
 * Browser-based MMD asset and card converter — runnable from the command line.
 *
 * Usage:
 *   bun run cli.ts <command> <input> [options]
 */

// ── Browser polyfills (must be first!) ───────────────────────────────────────
import "./src/cli/browser-polyfill";

// ── Node.js builtins ─────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as path from "node:path";

// ── CLI utilities (shared with tests) ────────────────────────────────────────
import {
  parseArgs,
  readFileToBuffer,
  readFileAsFile,
  writeFile,
  formatSize,
  resolveOutputPath,
  guessMimeType,
  expandInputPaths,
  askUserToSelect,
  type ParsedArgs,
} from "./src/cli/utils";

// ── Converter imports (relative, since Bun doesn't resolve @/) ───────────────
import { PmxObject } from "babylon-mmd";
import { convertBpmxToPmx } from "./src/app/converter/BpmxToPmxConverter";
import {
  convertPmxToBpmx,
  ensurePmxLoaderRegistered,
} from "./src/app/converter/PmxToBpmxConverter";
import {
  convertMotionFilesToBvmd,
  convertBvmdFileToVmd,
  convertBvmdFileToLegacyVmdFiles,
} from "./src/app/converter/MmdMotionConverter";
import {
  convertAudioFileToWebm,
  getAudioToWebmSupport,
} from "./src/app/converter/AudioToWebmConverter";
import { extractCardPngToZip } from "./src/app/converter/CardPngExtractor";
import {
  createCardPngFromFiles,
  getFilePath,
  getFileExt,
} from "./src/app/converter/CardPngCreator";
import { compressImagesToAvif } from "./src/app/converter/ImageCompressor";
import { runHeadlessConversion } from "./src/cli/headless-runner";

// Ensure the PMX loader plugin is registered before any PMX conversion
ensurePmxLoaderRegistered();

// ── Help text ────────────────────────────────────────────────────────────────

const HELP_TEXT = `
ero.dance Converter CLI

Usage:
  bun run cli.ts <command> <input> [options]

Commands:
  bpmx-to-pmx <file>         Convert BPMX model to PMX (output: ZIP with PMX + textures)
  pmx-to-bpmx <file>         Convert PMX model to BPMX (reads textures from same directory)
  motion-to-bvmd <files...>    Convert VMD/VPD/VMP motion(s) to BVMD; multiple
                             .vmd files (e.g. model + camera) are merged
                             into one BVMD
  bvmd-to-vmd <file>         Convert BVMD motion to VMD (model + camera as
                             separate files)
  audio-to-webm <file>       Convert WAV/MP3 audio to WebM (Opus)
  card-extract <file>        Extract files from an ero.dance card PNG
  card-create <files...>     Create an ero.dance card PNG from input files

Global Options:
  -o, --output <path>        Output file path (default: derived from input name)
  --verbose                  Show detailed conversion report
  -h, --help                 Show this help message

Command Options:
  bpmx-to-pmx:
    --encoding <enc>         PMX text encoding: utf8 (default), utf16le, shiftjis
    --no-restore-images      Skip restoring original image formats (default: restored)

  pmx-to-bpmx:
    --no-skeleton            Exclude skeleton data (default: included)
    --no-morph               Exclude morph data (default: included)
    --compression <mode>     Texture compression: raw (default), lossless, lossy
    --force-avif             Force real AVIF output via @jsquash/avif (default: off)

  bvmd-to-vmd:
    --combined               Write one combined VMD containing model and camera
                             animation (default: separate <name>.vmd +
                             <name>_camera.vmd files; --split-camera is the
                             legacy spelling and stays accepted)

  card-extract:
    --convert-legacy         Convert embedded BPMX/BVMD to legacy PMX/VMD (default: off)
    --encoding <enc>         PMX encoding for legacy conversion: utf8 (default), utf16le, shiftjis
    --no-restore-images      Skip restoring original image formats (default: restored)

  card-create:
    --compression <mode>     Image compression: lossless (default), lossy, raw
    --force-avif             Force real AVIF output via @jsquash/avif (default: off)
    --base-image <path>      Path to base image for the card PNG (default: built-in eroLogo)

Examples:
  bun run cli.ts bpmx-to-pmx model.bpmx
  bun run cli.ts pmx-to-bpmx model.pmx -o output.bpmx
  bun run cli.ts motion-to-bvmd dance.vmd
  bun run cli.ts motion-to-bvmd dance.vmd dance_camera.vmd -o merged.bvmd
  bun run cli.ts bvmd-to-vmd dance.bvmd
  bun run cli.ts bvmd-to-vmd dance.bvmd --combined -o out.vmd
  bun run cli.ts audio-to-webm song.wav
  bun run cli.ts card-extract ero.dance.png
  bun run cli.ts card-create model.bpmx motion.bvmd --base-image cover.png
`.trim();

// ── Command implementations ──────────────────────────────────────────────────

async function cmdBpmxToPmx(args: ParsedArgs): Promise<void> {
  const inputPath = args.positional[0];
  if (!inputPath) {
    console.error("Error: No input file specified.");
    console.error("Usage: bun run cli.ts bpmx-to-pmx <file.bpmx>");
    process.exit(1);
  }

  const encoding = resolveEncoding(args.options["encoding"]);
  const restoreImages = !args.flags.has("no-restore-images");

  console.log(`Reading ${inputPath} ...`);
  const buffer = readFileToBuffer(inputPath);
  console.log(
    `  Input: ${formatSize(buffer.byteLength)} | Encoding: ${args.options["encoding"] ?? "utf8"} | Restore images: ${restoreImages}`,
  );
  console.log("Converting BPMX → PMX ...");
  const result = await convertBpmxToPmx(buffer, {
    encoding,
    restoreOriginalImageFormats: restoreImages,
  });

  const outputPath = resolveOutputPath(inputPath, ".zip", args.options);
  console.log(`Writing ${outputPath} ...`);
  writeFile(outputPath, result.zipBuffer);

  console.log(
    `✓ Written ${outputPath} (${formatSize(result.zipBuffer.byteLength)})`,
  );
  console.log(
    `  Vertices: ${result.report.totals.vertices} | Materials: ${result.report.totals.materials} | Textures: ${result.report.totals.textures} | Bones: ${result.report.totals.bones} | Morphs: ${result.report.totals.morphs}`,
  );

  if (args.flags.has("verbose")) {
    console.log("\nFidelity Report:");
    console.log(JSON.stringify(result.report, null, 2));
  }
}

async function cmdPmxToBpmx(args: ParsedArgs): Promise<void> {
  const inputPath = args.positional[0];
  if (!inputPath) {
    console.error("Error: No input specified.");
    console.error("Usage: bun run cli.ts pmx-to-bpmx <file.pmx|directory|zip>");
    process.exit(1);
  }

  const buildSkeleton = !args.flags.has("no-skeleton");
  const buildMorph = !args.flags.has("no-morph");

  let allFiles: File[];
  let pmxFile: File | undefined;

  const isZip = inputPath.toLowerCase().endsWith(".zip");
  const isDir =
    fs.existsSync(inputPath) && fs.statSync(inputPath).isDirectory();

  if (!isZip && !isDir) {
    // Single PMX file - read its directory for textures
    const inputDir = path.dirname(path.resolve(inputPath));
    console.log(`Reading directory ${inputDir} for textures...`);
    allFiles = await expandInputPaths([inputDir]);
    const pmxFileName = path.basename(inputPath);
    pmxFile = allFiles.find(
      (f) => f.name === pmxFileName || getFilePath(f) === pmxFileName,
    );
  } else {
    // Folder or ZIP
    console.log(`Gathering files from ${inputPath} ...`);
    allFiles = await expandInputPaths([inputPath]);
    const pmxFiles = allFiles.filter((f) =>
      f.name.toLowerCase().endsWith(".pmx"),
    );

    if (pmxFiles.length === 0) {
      console.error("Error: No PMX file found.");
      process.exit(1);
    }

    if (pmxFiles.length === 1) {
      pmxFile = pmxFiles[0];
    } else {
      const selection = await askUserToSelect(
        pmxFiles.map((f) => getFilePath(f)),
        "Multiple PMX files found. Which one should be the main model?",
      );
      pmxFile = pmxFiles[selection]!;
    }
  }

  if (!pmxFile) {
    console.error(`Error: Could not find PMX file ${inputPath}`);
    process.exit(1);
  }

  const compressionMode = resolveCompressionMode(
    args.options["compression"],
    "raw", // default: no compression (backward compat)
  );
  const forceAvif = args.flags.has("force-avif");

  console.log(
    `  Found ${allFiles.length} file(s) | Main: ${getFilePath(pmxFile)} | Skeleton: ${buildSkeleton} | Morphs: ${buildMorph} | Compression: ${compressionMode}${forceAvif ? " (force-avif)" : ""}`,
  );

  // Compress textures before conversion (matches UI flow)
  let filesForConversion = allFiles;
  if (compressionMode !== "raw") {
    const compressibleCount = allFiles.filter((f) =>
      COMPRESSIBLE_IMAGE_EXTS.has(getFileExt(f.name)),
    ).length;
    if (compressibleCount > 0) {
      console.log(
        `  Compressing ${compressibleCount} texture(s) (${compressionMode}${forceAvif ? ", force-avif" : ""}) ...`,
      );
      // In CLI lossy mode, all compressible images are compressed lossily
      // (no per-file selection like the UI provides)
      const lossyFiles =
        compressionMode === "lossy" ? new Set(allFiles) : undefined;
      filesForConversion = await compressImagesToAvif(
        allFiles,
        (done, total) => {
          process.stdout.write(
            `\r  Compressing textures... (${done}/${total})`,
          );
        },
        lossyFiles,
        { forceAvif },
      );
      process.stdout.write("\n");
      console.log("  Texture compression complete.");
    }
  }

  console.log("Converting PMX → BPMX ...");
  const bpmxBuffer = await convertPmxToBpmx(pmxFile, filesForConversion, {
    buildSkeleton,
    buildMorph,
  });

  const outputPath = resolveOutputPath(inputPath, ".bpmx", args.options);
  console.log(`Writing ${outputPath} ...`);
  writeFile(outputPath, bpmxBuffer);

  console.log(`✓ Written ${outputPath} (${formatSize(bpmxBuffer.byteLength)})`);
}

async function cmdMotionToBvmd(args: ParsedArgs): Promise<void> {
  const inputPaths = args.positional;
  if (inputPaths.length === 0) {
    console.error("Error: No input file specified.");
    console.error(
      "Usage: bun run cli.ts motion-to-bvmd <file.vmd|vpd|vmp> [more.vmd ...]",
    );
    process.exit(1);
  }

  const files: File[] = [];
  for (const inputPath of inputPaths) {
    console.log(`Reading ${inputPath} ...`);
    const file = readFileAsFile(inputPath);
    console.log(
      `  Input: ${formatSize(file.size)} | Type: ${inputPath.split(".").pop()?.toLowerCase() ?? "unknown"}`,
    );
    files.push(file);
  }

  const isMerge = files.length > 1;
  console.log(
    isMerge
      ? `Merging ${files.length} motions → BVMD ...`
      : "Converting motion → BVMD ...",
  );
  const result = await convertMotionFilesToBvmd(files);

  let outputPath: string;
  if (args.options["output"]) {
    outputPath = path.resolve(args.options["output"]);
  } else if (isMerge) {
    const firstDir = path.dirname(path.resolve(inputPaths[0]!));
    outputPath = path.join(
      firstDir,
      `${result.outputBaseName ?? path.parse(inputPaths[0]!).name}.bvmd`,
    );
  } else {
    outputPath = resolveOutputPath(inputPaths[0]!, ".bvmd", args.options);
  }
  console.log(`Writing ${outputPath} ...`);
  writeFile(outputPath, result.buffer);

  console.log(
    `✓ Written ${outputPath} (${formatSize(result.buffer.byteLength)})`,
  );

  if (args.flags.has("verbose")) {
    console.log("\nMotion Summary:");
    console.log(JSON.stringify(result.summary, null, 2));
  }
}

async function writeSplitCameraVmds(
  args: ParsedArgs,
  inputPath: string,
  file: File,
): Promise<void> {
  console.log("Converting BVMD → legacy VMD files (model + camera) ...");
  const result = await convertBvmdFileToLegacyVmdFiles(file);

  const outputPath = resolveOutputPath(inputPath, ".vmd", args.options);
  console.log(`Writing ${outputPath} ...`);
  writeFile(outputPath, result.modelVmd.buffer);
  console.log(
    `✓ Written ${outputPath} (${formatSize(result.modelVmd.buffer.byteLength)})`,
  );

  if (result.cameraVmd) {
    const cameraPath = `${outputPath.replace(/\.vmd$/i, "")}_camera.vmd`;
    console.log(`Writing ${cameraPath} ...`);
    writeFile(cameraPath, result.cameraVmd.buffer);
    console.log(
      `✓ Written ${cameraPath} (${formatSize(result.cameraVmd.buffer.byteLength)})`,
    );
  } else {
    console.log("  No camera frames found — camera VMD skipped.");
  }

  if (args.flags.has("verbose")) {
    console.log("\nMotion Summary:");
    console.log(JSON.stringify(result.summary, null, 2));
  }
}

async function cmdBvmdToVmd(args: ParsedArgs): Promise<void> {
  const inputPath = args.positional[0];
  if (!inputPath) {
    console.error("Error: No input file specified.");
    console.error("Usage: bun run cli.ts bvmd-to-vmd <file.bvmd>");
    process.exit(1);
  }

  console.log(`Reading ${inputPath} ...`);
  const file = readFileAsFile(inputPath);
  console.log(`  Input: ${formatSize(file.size)}`);

  if (!args.flags.has("combined")) {
    // Default: split into model + camera VMD files. --split-camera is the
    // legacy spelling of this behavior and stays accepted as a no-op.
    await writeSplitCameraVmds(args, inputPath, file);
    return;
  }

  console.log("Converting BVMD → VMD (combined) ...");
  const result = await convertBvmdFileToVmd(file);

  const outputPath = resolveOutputPath(inputPath, ".vmd", args.options);
  console.log(`Writing ${outputPath} ...`);
  writeFile(outputPath, result.buffer);

  console.log(
    `✓ Written ${outputPath} (${formatSize(result.buffer.byteLength)})`,
  );

  if (args.flags.has("verbose")) {
    console.log("\nMotion Summary:");
    console.log(JSON.stringify(result.summary, null, 2));
  }
}

async function cmdAudioToWebm(args: ParsedArgs): Promise<void> {
  const inputPath = args.positional[0];
  if (!inputPath) {
    console.error("Error: No input file specified.");
    console.error("Usage: bun run cli.ts audio-to-webm <file.wav|mp3>");
    process.exit(1);
  }

  const verbose = args.flags.has("verbose");

  // Check if browser APIs (AudioEncoder, WebCodecs) are available natively.
  // In Bun/Node they are not, so we delegate to a headless browser.
  const support = await getAudioToWebmSupport();
  if (!support.supported) {
    if (verbose) {
      console.log(
        `  Browser APIs not available (${support.reason}), launching headless browser...`,
      );
    }

    const inputBuffer = readFileToBuffer(inputPath);
    const inputFileName = path.basename(path.resolve(inputPath));
    const inputMimeType = guessMimeType(inputFileName);

    console.log(`Converting ${inputPath} via headless browser ...`);
    const result = await runHeadlessConversion(
      "audio-to-webm",
      inputBuffer,
      inputFileName,
      inputMimeType,
      args.options,
      [...args.flags],
      verbose,
    );

    if (!result.success) {
      throw new Error(result.error ?? "Headless audio conversion failed");
    }

    const outputBytes = Uint8Array.from(atob(result.outputFile), (c) =>
      c.charCodeAt(0),
    );
    const outputPath = resolveOutputPath(inputPath, ".webm", args.options);
    writeFile(outputPath, outputBytes.buffer as ArrayBuffer);

    console.log(
      `✓ Written ${outputPath} (${formatSize(outputBytes.byteLength)})`,
    );

    if (verbose) {
      console.log("\nAudio Conversion Summary:");
      console.log(JSON.stringify(result.summary, null, 2));
    }
    return;
  }

  // Native path: browser APIs are available (rare in CLI, but possible)
  const file = readFileAsFile(inputPath);
  console.log(`Converting ${inputPath} ...`);
  const convResult = await convertAudioFileToWebm(file);

  const outputPath = resolveOutputPath(inputPath, ".webm", args.options);
  writeFile(outputPath, convResult.buffer);

  console.log(
    `✓ Written ${outputPath} (${formatSize(convResult.buffer.byteLength)})`,
  );

  if (verbose) {
    console.log("\nAudio Conversion Summary:");
    console.log(JSON.stringify(convResult.summary, null, 2));
  }
}

async function cmdCardExtract(args: ParsedArgs): Promise<void> {
  const inputPath = args.positional[0];
  if (!inputPath) {
    console.error("Error: No input file specified.");
    console.error("Usage: bun run cli.ts card-extract <file.png>");
    process.exit(1);
  }

  const encoding = resolveEncoding(args.options["encoding"]);
  const restoreImages = !args.flags.has("no-restore-images");
  const convertLegacy = args.flags.has("convert-legacy");

  console.log(`Reading ${inputPath} ...`);
  const file = readFileAsFile(inputPath);
  console.log(
    `  Input: ${formatSize(file.size)} | Legacy conversion: ${convertLegacy} | Encoding: ${args.options["encoding"] ?? "utf8"} | Restore images: ${restoreImages}`,
  );
  console.log("Extracting card ...");
  const result = await extractCardPngToZip(file, {
    convertToLegacyMmdFiles: convertLegacy,
    encoding,
    restoreOriginalImageFormats: restoreImages,
  });

  const outputPath = resolveOutputPath(inputPath, ".zip", args.options);
  console.log(`Writing ${outputPath} ...`);
  writeFile(outputPath, result.zipBuffer);

  console.log(
    `✓ Written ${outputPath} (${formatSize(result.zipBuffer.byteLength)})`,
  );
  console.log(`  Found chunks: ${result.report.foundChunkTypes.join(", ")}`);
  console.log(`  Exported files: ${result.report.exportedFiles.join(", ")}`);

  if (args.flags.has("verbose")) {
    console.log("\nExtraction Report:");
    console.log(JSON.stringify(result.report, null, 2));
  }
}

async function cmdCardCreate(args: ParsedArgs): Promise<void> {
  if (args.positional.length === 0) {
    console.error("Error: No input files specified.");
    console.error("Usage: bun run cli.ts card-create <files...>");
    process.exit(1);
  }

  const compressionMode = resolveCompressionMode(args.options["compression"]);
  const forceAvif = args.flags.has("force-avif");

  // Read all input files (expanding directories and ZIPs)
  console.log(`Gathering input file(s) ...`);

  // For card creation, if a single PMX file is passed, we should also include
  // its directory to pick up textures, just like pmx-to-bpmx does.
  const expandedPaths: string[] = [];
  for (const p of args.positional) {
    const absPath = path.resolve(p);
    if (
      fs.existsSync(absPath) &&
      fs.statSync(absPath).isFile() &&
      p.toLowerCase().endsWith(".pmx")
    ) {
      const inputDir = path.dirname(absPath);
      console.log(`  Adding directory for PMX: ${inputDir}`);
      expandedPaths.push(inputDir);
    } else {
      expandedPaths.push(p);
    }
  }

  const allFiles = await expandInputPaths(expandedPaths);

  // Filter for potential primary models (PMX or BPMX)
  const modelFiles = allFiles.filter((f) => {
    const ext = f.name.toLowerCase().split(".").pop();
    return ext === "pmx" || ext === "bpmx";
  });

  let primaryModelFile: File | null = null;
  if (modelFiles.length > 1) {
    const selection = await askUserToSelect(
      modelFiles.map((f) => getFilePath(f)),
      "Multiple PMX/BPMX files found. Which one should be embedded as the main model?",
    );
    primaryModelFile = modelFiles[selection]!;
  }

  // If base-image is specified, add it to the file list
  let baseImageFile: File | null = null;
  if (args.options["base-image"]) {
    baseImageFile = readFileAsFile(args.options["base-image"]);
    console.log(`  Base image (explicit): ${args.options["base-image"]}`);
  }

  // In CLI mode, provide a default base image from local public/eroLogo.png
  // so we don't need to fetch from a server
  let defaultBaseImageBuffer: ArrayBuffer | undefined;
  if (!baseImageFile) {
    try {
      const eroLogoPath = path.resolve("public", "eroLogo.png");
      if (fs.existsSync(eroLogoPath)) {
        defaultBaseImageBuffer = fs.readFileSync(eroLogoPath)
          .buffer as ArrayBuffer;
      }
    } catch {
      // Ignore — will fall back to fetch
    }
  }

  console.log(
    `  Found ${allFiles.length} file(s) | Compression: ${compressionMode}${forceAvif ? " (force-avif)" : ""}`,
  );
  if (primaryModelFile) {
    console.log(`  Main model: ${getFilePath(primaryModelFile)}`);
  }

  console.log("Creating card ...");
  const result = await createCardPngFromFiles(allFiles, {
    baseImageFile,
    primaryModelFile,
    compressionMode,
    forceAvif,
    defaultBaseImageBuffer,
  });

  const outputPath = resolveOutputPath(
    args.positional[0]!,
    ".png",
    args.options,
  );
  console.log(`Writing ${outputPath} ...`);
  writeFile(outputPath, result.pngBuffer);

  console.log(
    `✓ Written ${outputPath} (${formatSize(result.pngBuffer.byteLength)})`,
  );
  console.log(
    `  Embedded chunks: ${result.report.embeddedChunkTypes.join(", ")}`,
  );

  if (args.flags.has("verbose")) {
    console.log("\nCard Creation Report:");
    console.log(JSON.stringify(result.report, null, 2));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const COMPRESSIBLE_IMAGE_EXTS = new Set(["png", "bmp", "webp", "jpg", "jpeg"]);

type CompressionMode = "lossless" | "lossy" | "raw";

function resolveCompressionMode(
  value: string | undefined,
  fallback: CompressionMode = "lossless",
): CompressionMode {
  const mode = value ?? fallback;
  if (!["lossless", "lossy", "raw"].includes(mode)) {
    console.error(
      `Error: Invalid compression mode "${mode}". Use: lossless, lossy, raw`,
    );
    process.exit(1);
  }
  return mode as CompressionMode;
}

function resolveEncoding(encoding?: string): PmxObject.Header.Encoding {
  if (!encoding || encoding === "utf8") {
    return PmxObject.Header.Encoding.Utf8;
  }
  if (encoding === "utf16le") {
    return PmxObject.Header.Encoding.Utf16le;
  }
  if (encoding === "shiftjis") {
    return PmxObject.Header.Encoding.ShiftJis;
  }
  return PmxObject.Header.Encoding.Utf8;
}

// ── Command dispatch ─────────────────────────────────────────────────────────

type CommandHandler = (args: ParsedArgs) => Promise<void>;

const COMMANDS: Record<string, CommandHandler> = {
  "bpmx-to-pmx": cmdBpmxToPmx,
  "pmx-to-bpmx": cmdPmxToBpmx,
  "motion-to-bvmd": cmdMotionToBvmd,
  "bvmd-to-vmd": cmdBvmdToVmd,
  "audio-to-webm": cmdAudioToWebm,
  "card-extract": cmdCardExtract,
  "card-create": cmdCardCreate,
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.flags.has("help") || args.command === "help" || argv.length === 0) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    console.error(`Error: Unknown command "${args.command}".`);
    console.error('Run "bun run cli.ts --help" for usage information.');
    process.exit(1);
  }

  try {
    await handler(args);
    process.exit(0);
  } catch (error) {
    console.error(
      `\n✗ Conversion failed: ${error instanceof Error ? error.message : error}`,
    );
    if (args.flags.has("verbose") && error instanceof Error && error.stack) {
      console.error(`\nStack trace:\n${error.stack}`);
    }
    process.exit(1);
  }
}

main();
