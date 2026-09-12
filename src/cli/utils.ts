/**
 * Shared CLI utility functions, extracted for testability.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { readZipFiles } from "../app/converter/ZipReader";

// ── Argument parsing ─────────────────────────────────────────────────────────

export interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, string>;
  flags: Set<string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "--") {
      // Everything after -- is positional
      for (let j = i + 1; j < argv.length; j++) {
        positional.push(argv[j]!);
      }
      break;
    }

    if (arg.startsWith("--no-")) {
      // --no-foo → flag "no-foo"
      flags.add(arg.slice(2));
      continue;
    }

    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        const key = arg.slice(2, eqIndex);
        const value = arg.slice(eqIndex + 1);
        options[key] = value;
      } else {
        // Peek at next arg: if it exists and doesn't start with '-', it's the value
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          options[arg.slice(2)] = next;
          i++;
        } else {
          flags.add(arg.slice(2));
        }
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length === 2) {
      const flag = arg.slice(1);
      if (flag === "h") {
        flags.add("help");
      } else if (flag === "o") {
        const next = argv[i + 1];
        if (next) {
          options["output"] = next;
          i++;
        }
      } else {
        flags.add(flag);
      }
      continue;
    }

    positional.push(arg);
  }

  const command = positional.shift() ?? "";
  return { command, positional, options, flags };
}

// ── File helpers ─────────────────────────────────────────────────────────────

export function readFileToBuffer(filePath: string): ArrayBuffer {
  const absPath = path.resolve(filePath);
  const buf = fs.readFileSync(absPath);
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

export function readFileAsFile(filePath: string): File {
  const absPath = path.resolve(filePath);
  const buffer = readFileToBuffer(filePath);
  const name = path.basename(absPath);
  return new File([buffer], name, {
    type: guessMimeType(name),
  });
}

export function readFileAsFileWithRelativePath(
  filePath: string,
  basePath: string,
): File {
  const absPath = path.resolve(filePath);
  const buffer = readFileToBuffer(filePath);
  const relPath = path.relative(basePath, absPath).replace(/\\/g, "/");
  const file = new File([buffer], relPath, {
    type: guessMimeType(relPath),
  });
  // Set webkitRelativePath for PmxToBpmxConverter texture resolution
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    enumerable: true,
    writable: false,
    value: relPath,
  });
  return file;
}

export function readDirectoryFiles(dirPath: string): File[] {
  const absDir = path.resolve(dirPath);
  const files: File[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir)) {
      const absEntry = path.join(dir, entry);
      const stat = fs.statSync(absEntry);
      if (stat.isDirectory()) {
        walk(absEntry);
      } else {
        files.push(readFileAsFileWithRelativePath(absEntry, absDir));
      }
    }
  }

  walk(absDir);
  return files;
}

export function writeFile(filePath: string, data: ArrayBuffer): void {
  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: unknown) {
    // Bun <2 may throw EEXIST even with recursive:true
    if (
      !(
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      )
    ) {
      throw err;
    }
  }
  fs.writeFileSync(absPath, Buffer.from(data));
}

export function guessMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pmx: "application/octet-stream",
    bpmx: "application/octet-stream",
    bpmv: "application/octet-stream",
    bvmd: "application/octet-stream",
    vmd: "application/octet-stream",
    vpd: "application/octet-stream",
    vmp: "application/octet-stream",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    webm: "audio/webm",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    bmp: "image/bmp",
    tga: "image/x-tga",
    spa: "application/octet-stream",
    sph: "application/octet-stream",
    zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "output";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function deriveOutputPath(
  inputPath: string,
  newExtension: string,
): string {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}${newExtension}`);
}

export function resolveOutputPath(
  inputPath: string,
  newExtension: string,
  options: Record<string, string>,
): string {
  if (options["output"]) {
    return path.resolve(options["output"]);
  }
  return deriveOutputPath(inputPath, newExtension);
}

/**
 * Expands a list of file paths into a flat list of File objects.
 * Handles directories (recursively) and ZIP files (extracted).
 */
export async function expandInputPaths(paths: string[]): Promise<File[]> {
  const files: File[] = [];
  const seenPaths = new Set<string>();

  function addFile(file: File, absSourcePath: string) {
    if (seenPaths.has(absSourcePath)) return;
    seenPaths.add(absSourcePath);
    files.push(file);
  }

  for (const p of paths) {
    const absPath = path.resolve(p);
    if (!fs.existsSync(absPath)) {
      console.warn(`Warning: Path does not exist: ${p}`);
      continue;
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      const dirFiles = readDirectoryFiles(absPath);
      // readDirectoryFiles already uses readFileAsFileWithRelativePath
      // which carries the absolute path info in its closure, but we don't have it here.
      // However, readDirectoryFiles returns Files with webkitRelativePath.
      // Let's just trust readDirectoryFiles for now or deduplicate by webkitRelativePath.
      for (const f of dirFiles) {
        const relPath = f.webkitRelativePath || f.name;
        const fullRelPath = path.join(absPath, relPath);
        addFile(f, fullRelPath);
      }
    } else if (p.toLowerCase().endsWith(".zip")) {
      const buffer = readFileToBuffer(absPath);
      const zipFiles = readZipFiles(buffer);
      for (const f of zipFiles) {
        // For ZIP files, the "path" is internal to the ZIP.
        // We use the ZIP path + internal path to deduplicate.
        const internalPath = f.webkitRelativePath || f.name;
        addFile(f, `${absPath}:${internalPath}`);
      }
    } else {
      addFile(readFileAsFile(absPath), absPath);
    }
  }

  return files;
}

/**
 * Interactive selection from a list of options.
 */
export async function askUserToSelect(
  options: string[],
  message: string,
): Promise<number> {
  console.log(`\n${message}`);
  options.forEach((opt, i) => {
    console.log(`  [${i + 1}] ${opt}`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const ask = () => {
      rl.question(`\nSelection (1-${options.length}): `, (answer) => {
        const index = parseInt(answer, 10) - 1;
        if (index >= 0 && index < options.length) {
          rl.close();
          resolve(index);
        } else {
          console.log(
            `Invalid selection. Please enter a number between 1 and ${options.length}.`,
          );
          ask();
        }
      });
    };
    ask();
  });
}
