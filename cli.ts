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
  readDirectoryFiles,
  writeFile,
  formatSize,
  resolveOutputPath,
  guessMimeType,
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
  convertMotionFileToBvmd,
  convertBvmdFileToVmd,
} from "./src/app/converter/MmdMotionConverter";
import {
  convertAudioFileToWebm,
  getAudioToWebmSupport,
} from "./src/app/converter/AudioToWebmConverter";
import { extractCardPngToZip } from "./src/app/converter/CardPngExtractor";
import { createCardPngFromFiles } from "./src/app/converter/CardPngCreator";
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
  motion-to-bvmd <file>      Convert VMD/VPD/VMP motion to BVMD
  bvmd-to-vmd <file>         Convert BVMD motion to VMD
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
    --no-restore-images      Skip restoring original image formats

  pmx-to-bpmx:
    --no-skeleton            Exclude skeleton data
    --no-morph               Exclude morph data

  card-extract:
    --convert-legacy         Convert embedded BPMX/BVMD to legacy PMX/VMD
    --encoding <enc>         PMX encoding for legacy conversion: utf8 (default), utf16le, shiftjis
    --no-restore-images      Skip restoring original image formats

  card-create:
    --compression <mode>     Image compression: lossless (default), lossy, raw
    --base-image <path>      Path to base image for the card PNG

Examples:
  bun run cli.ts bpmx-to-pmx model.bpmx
  bun run cli.ts pmx-to-bpmx model.pmx -o output.bpmx
  bun run cli.ts motion-to-bvmd dance.vmd
  bun run cli.ts bvmd-to-vmd dance.bvmd
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

  console.log(`Converting ${inputPath} ...`);
  const buffer = readFileToBuffer(inputPath);
  const result = await convertBpmxToPmx(buffer, {
    encoding,
    restoreOriginalImageFormats: restoreImages,
  });

  const outputPath = resolveOutputPath(inputPath, ".zip", args.options);
  writeFile(outputPath, result.zipBuffer);

  console.log(
    `✓ Written ${outputPath} (${formatSize(result.zipBuffer.byteLength)})`,
  );

  if (args.flags.has("verbose")) {
    console.log("\nFidelity Report:");
    console.log(JSON.stringify(result.report, null, 2));
  }
}

async function cmdPmxToBpmx(args: ParsedArgs): Promise<void> {
  const inputPath = args.positional[0];
  if (!inputPath) {
    console.error("Error: No input file specified.");
    console.error("Usage: bun run cli.ts pmx-to-bpmx <file.pmx>");
    process.exit(1);
  }

  const absInput = path.resolve(inputPath);
  const inputDir = path.dirname(absInput);
  const buildSkeleton = !args.flags.has("no-skeleton");
  const buildMorph = !args.flags.has("no-morph");

  // Read all files in the PMX directory (textures, etc.)
  const allFiles = readDirectoryFiles(inputDir);
  const pmxFileName = path.basename(absInput);
  const pmxFile = allFiles.find(
    (f) =>
      (f as File & { webkitRelativePath?: string }).webkitRelativePath ===
        pmxFileName || f.name === pmxFileName,
  );
  if (!pmxFile) {
    console.error(`Error: Could not find ${pmxFileName} in directory.`);
    process.exit(1);
  }

  console.log(`Converting ${inputPath} (with ${allFiles.length} files) ...`);
  const bpmxBuffer = await convertPmxToBpmx(pmxFile, allFiles, {
    buildSkeleton,
    buildMorph,
  });

  const outputPath = resolveOutputPath(inputPath, ".bpmx", args.options);
  writeFile(outputPath, bpmxBuffer);

  console.log(`✓ Written ${outputPath} (${formatSize(bpmxBuffer.byteLength)})`);
}

async function cmdMotionToBvmd(args: ParsedArgs): Promise<void> {
  const inputPath = args.positional[0];
  if (!inputPath) {
    console.error("Error: No input file specified.");
    console.error("Usage: bun run cli.ts motion-to-bvmd <file.vmd|vpd|vmp>");
    process.exit(1);
  }

  const file = readFileAsFile(inputPath);
  console.log(`Converting ${inputPath} ...`);
  const result = await convertMotionFileToBvmd(file);

  const outputPath = resolveOutputPath(inputPath, ".bvmd", args.options);
  writeFile(outputPath, result.buffer);

  console.log(
    `✓ Written ${outputPath} (${formatSize(result.buffer.byteLength)})`,
  );

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

  const file = readFileAsFile(inputPath);
  console.log(`Converting ${inputPath} ...`);
  const result = await convertBvmdFileToVmd(file);

  const outputPath = resolveOutputPath(inputPath, ".vmd", args.options);
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

  const file = readFileAsFile(inputPath);
  console.log(`Extracting card ${inputPath} ...`);
  const result = await extractCardPngToZip(file, {
    convertToLegacyMmdFiles: convertLegacy,
    encoding,
    restoreOriginalImageFormats: restoreImages,
  });

  const outputPath = resolveOutputPath(inputPath, ".zip", args.options);
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

  const compressionMode = (args.options["compression"] ?? "lossless") as
    | "lossless"
    | "lossy"
    | "raw";
  if (!["lossless", "lossy", "raw"].includes(compressionMode)) {
    console.error(
      `Error: Invalid compression mode "${compressionMode}". Use: lossless, lossy, raw`,
    );
    process.exit(1);
  }

  // Read all input files as File objects
  const files = args.positional.map((p) => readFileAsFile(p));

  // If base-image is specified, add it to the file list
  let baseImageFile: File | null = null;
  if (args.options["base-image"]) {
    baseImageFile = readFileAsFile(args.options["base-image"]);
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
    `Creating card from ${files.length} file(s) (compression: ${compressionMode}) ...`,
  );
  const result = await createCardPngFromFiles(files, {
    baseImageFile,
    compressionMode,
    defaultBaseImageBuffer,
  });

  const outputPath = resolveOutputPath(
    args.positional[0]!,
    ".png",
    args.options,
  );
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

// ── Encoding helper ──────────────────────────────────────────────────────────

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
