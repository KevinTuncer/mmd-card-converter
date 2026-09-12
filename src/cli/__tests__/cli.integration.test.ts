// @vitest-environment node
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const CLI_PATH = path.resolve(PROJECT_ROOT, "cli.ts");

// Temp directory for all test outputs
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cli-integration-"));

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function runCli(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  try {
    const stdout = execFileSync("bun", ["run", CLI_PATH, ...args], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 100 * 1024 * 1024,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: unknown) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

function tmpPath(name: string): string {
  return path.join(TMP_DIR, name);
}

// ── Help ─────────────────────────────────────────────────────────────────────

describe("CLI --help", () => {
  it("shows help text and exits with 0", () => {
    const result = runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ero.dance Converter CLI");
    expect(result.stdout).toContain("bpmx-to-pmx");
    expect(result.stdout).toContain("pmx-to-bpmx");
    expect(result.stdout).toContain("motion-to-bvmd");
    expect(result.stdout).toContain("bvmd-to-vmd");
    expect(result.stdout).toContain("audio-to-webm");
    expect(result.stdout).toContain("card-extract");
    expect(result.stdout).toContain("card-create");
  });

  it("shows help when no arguments are given", () => {
    const result = runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ero.dance Converter CLI");
  });

  it("shows help with -h", () => {
    const result = runCli(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });
});

// ── Unknown command ──────────────────────────────────────────────────────────

describe("CLI unknown command", () => {
  it("exits with error for unknown command", () => {
    const result = runCli(["unknown-command"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command "unknown-command"');
  });
});

// ── bpmx-to-pmx ──────────────────────────────────────────────────────────────

describe("CLI bpmx-to-pmx", () => {
  it("converts TestModel.bpmx to a ZIP file", () => {
    const outputPath = tmpPath("TestModel.zip");
    const result = runCli([
      "bpmx-to-pmx",
      "public/example/TestModel.bpmx",
      "-o",
      outputPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓");
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify it's a valid ZIP containing a .pmx file
    const zipData = fs.readFileSync(outputPath);
    const entries = unzipSync(new Uint8Array(zipData));
    const names = Object.keys(entries);
    const hasPmx = names.some((n) => n.toLowerCase().endsWith(".pmx"));
    expect(hasPmx).toBe(true);
  });

  it("fails when no input file specified", () => {
    const result = runCli(["bpmx-to-pmx"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No input file specified");
  });

  it("fails for non-existent input file", () => {
    const result = runCli(["bpmx-to-pmx", "nonexistent.bpmx"]);
    expect(result.exitCode).toBe(1);
  });
});

// ── motion-to-bvmd ───────────────────────────────────────────────────────────

describe("CLI motion-to-bvmd", () => {
  it("converts TestMotion.bvmd (identity — BVMD is already BVMD)", () => {
    const outputPath = tmpPath("TestMotion_out.bvmd");
    const result = runCli([
      "motion-to-bvmd",
      "public/example/TestMotion.bvmd",
      "-o",
      outputPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓");
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
  });
});

// ── bvmd-to-vmd ──────────────────────────────────────────────────────────────

describe("CLI bvmd-to-vmd", () => {
  it("converts TestMotion.bvmd to VMD", () => {
    const outputPath = tmpPath("TestMotion.vmd");
    const result = runCli([
      "bvmd-to-vmd",
      "public/example/TestMotion.bvmd",
      "-o",
      outputPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓");
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify VMD magic bytes: "Vocaloid Motion Data"
    const vmdData = fs.readFileSync(outputPath);
    const header = vmdData.subarray(0, 30).toString("utf-8");
    expect(header).toContain("Vocaloid Motion Data");
  });

  it("fails when no input file specified", () => {
    const result = runCli(["bvmd-to-vmd"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No input file specified");
  });

  it("splits camera animation into a separate VMD with --split-camera", () => {
    const outputPath = tmpPath("SplitMotion.vmd");
    const cameraPath = tmpPath("SplitMotion_camera.vmd");
    const result = runCli([
      "bvmd-to-vmd",
      "public/example/TestMotion.bvmd",
      "-o",
      outputPath,
      "--split-camera",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓");
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(cameraPath)).toBe(true);

    for (const filePath of [outputPath, cameraPath]) {
      const header = fs
        .readFileSync(filePath)
        .subarray(0, 30)
        .toString("utf-8");
      expect(header).toContain("Vocaloid Motion Data");
    }

    // The camera-only file must be smaller than the model file.
    expect(fs.statSync(cameraPath).size).toBeLessThan(
      fs.statSync(outputPath).size,
    );
  });
});

// ── card-extract ─────────────────────────────────────────────────────────────

describe("CLI card-extract", () => {
  it("extracts a card PNG and produces a ZIP", async () => {
    // First create a simple card PNG for testing
    const cardPath = tmpPath("test_card.png");
    await createTestCardPng(cardPath);

    const outputPath = tmpPath("test_extracted.zip");
    const result = runCli(["card-extract", cardPath, "-o", outputPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓");
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify it's a valid ZIP
    const zipData = fs.readFileSync(outputPath);
    const entries = unzipSync(new Uint8Array(zipData));
    const names = Object.keys(entries);
    expect(names.length).toBeGreaterThan(0);
  });

  it("fails when no input file specified", () => {
    const result = runCli(["card-extract"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No input file specified");
  });
});

// ── card-create ──────────────────────────────────────────────────────────────

describe("CLI card-create", () => {
  it("creates a card PNG from a BPMX file", () => {
    const outputPath = tmpPath("test_created_card.png");
    const result = runCli([
      "card-create",
      "public/example/TestModel.bpmx",
      "-o",
      outputPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓");
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify PNG magic bytes
    const pngData = fs.readFileSync(outputPath);
    expect(pngData[0]).toBe(0x89); // PNG signature
    expect(pngData[1]).toBe(0x50); // P
    expect(pngData[2]).toBe(0x4e); // N
    expect(pngData[3]).toBe(0x47); // G
  });

  it("fails when no input files specified", () => {
    const result = runCli(["card-create"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No input files specified");
  });
});

// ── pmx-to-bpmx ──────────────────────────────────────────────────────────────

describe("CLI pmx-to-bpmx", () => {
  it("converts TestModelAsPmx/Ai.pmx to BPMX", () => {
    const outputPath = tmpPath("Ai.bpmx");
    const result = runCli([
      "pmx-to-bpmx",
      "public/example/TestModelAsPmx/Ai.pmx",
      "-o",
      outputPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓");
    expect(fs.existsSync(outputPath)).toBe(true);

    const bpmxData = fs.readFileSync(outputPath);
    expect(bpmxData.length).toBeGreaterThan(0);
  });
});

// ── --verbose ────────────────────────────────────────────────────────────────

describe("CLI --verbose", () => {
  it("prints detailed report with --verbose flag", () => {
    const outputPath = tmpPath("verbose_test.bvmd");
    const result = runCli([
      "motion-to-bvmd",
      "public/example/TestMotion.bvmd",
      "-o",
      outputPath,
      "--verbose",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Motion Summary:");
    expect(result.stdout).toContain("boneTracks");
  });
});

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a minimal card PNG for testing card-extract.
 * Embeds a bPMX chunk with a gzip-compressed payload.
 */
async function createTestCardPng(outputPath: string): Promise<void> {
  const { gzipSync } = await import("fflate");

  // Minimal 1x1 PNG
  const BASE_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=",
    "base64",
  );

  const pngBytes = new Uint8Array(BASE_PNG);
  const payload = gzipSync(new TextEncoder().encode("fake-bpmx-payload"));

  // Build PNG chunks: before-IEND + custom chunk + IEND
  const beforeIend = pngBytes.subarray(0, pngBytes.length - 12);
  const iend = pngBytes.subarray(pngBytes.length - 12);
  const customChunk = createPngChunk("bPMX", payload);

  const result = new Uint8Array(
    beforeIend.length + customChunk.length + iend.length,
  );
  result.set(beforeIend, 0);
  result.set(customChunk, beforeIend.length);
  result.set(iend, beforeIend.length + customChunk.length);

  fs.writeFileSync(outputPath, result);
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  new DataView(chunk.buffer).setUint32(0, data.length, false);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  return chunk;
}
