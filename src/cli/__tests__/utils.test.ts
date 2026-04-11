// @vitest-environment node
import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  formatSize,
  guessMimeType,
  stripExt,
  deriveOutputPath,
  resolveOutputPath,
  readFileToBuffer,
  readFileAsFile,
  readDirectoryFiles,
  writeFile,
} from "@/cli/utils";
import * as fs from "node:fs";
import * as os from "node:os";

// ── formatSize ───────────────────────────────────────────────────────────────

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(100)).toBe("100 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1023)).toBe("1023.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(25.6 * 1024 * 1024)).toBe("25.6 MB");
  });
});

// ── guessMimeType ────────────────────────────────────────────────────────────

describe("guessMimeType", () => {
  it("recognizes PMX files", () => {
    expect(guessMimeType("model.pmx")).toBe("application/octet-stream");
  });

  it("recognizes BPMX files", () => {
    expect(guessMimeType("model.bpmx")).toBe("application/octet-stream");
  });

  it("recognizes image files", () => {
    expect(guessMimeType("photo.png")).toBe("image/png");
    expect(guessMimeType("photo.jpg")).toBe("image/jpeg");
    expect(guessMimeType("photo.jpeg")).toBe("image/jpeg");
    expect(guessMimeType("photo.bmp")).toBe("image/bmp");
    expect(guessMimeType("photo.tga")).toBe("image/x-tga");
  });

  it("recognizes audio files", () => {
    expect(guessMimeType("song.wav")).toBe("audio/wav");
    expect(guessMimeType("song.mp3")).toBe("audio/mpeg");
    expect(guessMimeType("song.webm")).toBe("audio/webm");
  });

  it("recognizes motion files", () => {
    expect(guessMimeType("dance.vmd")).toBe("application/octet-stream");
    expect(guessMimeType("dance.bvmd")).toBe("application/octet-stream");
    expect(guessMimeType("pose.vpd")).toBe("application/octet-stream");
  });

  it("returns default for unknown extensions", () => {
    expect(guessMimeType("file.xyz")).toBe("application/octet-stream");
    expect(guessMimeType("file")).toBe("application/octet-stream");
  });

  it("is case-insensitive", () => {
    expect(guessMimeType("file.PNG")).toBe("image/png");
    expect(guessMimeType("file.Jpg")).toBe("image/jpeg");
  });
});

// ── stripExt ─────────────────────────────────────────────────────────────────

describe("stripExt", () => {
  it("removes a single extension", () => {
    expect(stripExt("model.bpmx")).toBe("model");
    expect(stripExt("dance.vmd")).toBe("dance");
  });

  it("removes only the last extension", () => {
    expect(stripExt("archive.tar.gz")).toBe("archive.tar");
  });

  it("returns 'output' for dot-only names", () => {
    expect(stripExt(".hidden")).toBe("output");
  });

  it("returns the name when there is no extension", () => {
    expect(stripExt("noext")).toBe("noext");
  });
});

// ── deriveOutputPath ─────────────────────────────────────────────────────────

describe("deriveOutputPath", () => {
  it("replaces the extension", () => {
    expect(deriveOutputPath("model.bpmx", ".zip")).toBe(
      path.join("", "model.zip"),
    );
    expect(deriveOutputPath("dance.vmd", ".bvmd")).toBe(
      path.join("", "dance.bvmd"),
    );
  });

  it("preserves directory path", () => {
    const result = deriveOutputPath("some/dir/model.bpmx", ".zip");
    expect(result).toMatch(/some/);
    expect(result).toMatch(/model\.zip$/);
  });
});

// ── resolveOutputPath ────────────────────────────────────────────────────────

describe("resolveOutputPath", () => {
  it("uses --output when provided", () => {
    const result = resolveOutputPath("input.bpmx", ".zip", {
      output: "/custom/path/output.zip",
    });
    expect(result).toBe(path.resolve("/custom/path/output.zip"));
  });

  it("derives from input when no --output", () => {
    const result = resolveOutputPath("input.bpmx", ".zip", {});
    expect(result).toMatch(/input\.zip$/);
  });
});

// ── File I/O helpers ─────────────────────────────────────────────────────────

describe("writeFile + readFileToBuffer", () => {
  it("writes and reads back binary data", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
    const filePath = path.join(tmpDir, "test.bin");
    const data = new Uint8Array([1, 2, 3, 4, 5]).buffer as ArrayBuffer;

    try {
      writeFile(filePath, data);
      const result = readFileToBuffer(filePath);
      expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates parent directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
    const filePath = path.join(tmpDir, "sub", "dir", "test.bin");
    const data = new Uint8Array([42]).buffer as ArrayBuffer;

    try {
      writeFile(filePath, data);
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("readFileAsFile", () => {
  it("creates a File with correct name and content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
    const filePath = path.join(tmpDir, "model.bpmx");
    const content = new Uint8Array([0x42, 0x50, 0x4d, 0x58]);
    fs.writeFileSync(filePath, content);

    try {
      const file = readFileAsFile(filePath);
      expect(file.name).toBe("model.bpmx");
      expect(file.type).toBe("application/octet-stream");
      expect(file.size).toBe(4);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("readDirectoryFiles", () => {
  it("recursively reads all files with relative paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
    // Create a nested structure
    fs.mkdirSync(path.join(tmpDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    fs.writeFileSync(path.join(tmpDir, "sub", "b.txt"), "b");

    try {
      const files = readDirectoryFiles(tmpDir);
      const names = files.map((f) => f.name).sort();
      expect(names).toContain("a.txt");
      expect(names).toContain(path.join("sub", "b.txt").replace(/\\/g, "/"));
      expect(files.length).toBe(2);

      // Check webkitRelativePath is set
      for (const file of files) {
        expect(file).toHaveProperty("webkitRelativePath");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
