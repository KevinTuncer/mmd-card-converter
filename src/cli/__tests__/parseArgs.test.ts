// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseArgs } from "@/cli/utils";

describe("parseArgs", () => {
  it("parses a simple command with one positional", () => {
    const result = parseArgs(["bpmx-to-pmx", "model.bpmx"]);
    expect(result.command).toBe("bpmx-to-pmx");
    expect(result.positional).toEqual(["model.bpmx"]);
    expect(result.options).toEqual({});
    expect([...result.flags]).toEqual([]);
  });

  it("parses multiple positional arguments", () => {
    const result = parseArgs(["card-create", "a.bpmx", "b.bvmd", "c.png"]);
    expect(result.command).toBe("card-create");
    expect(result.positional).toEqual(["a.bpmx", "b.bvmd", "c.png"]);
  });

  it("parses --option value pairs", () => {
    const result = parseArgs([
      "bpmx-to-pmx",
      "model.bpmx",
      "--encoding",
      "shiftjis",
    ]);
    expect(result.options).toEqual({ encoding: "shiftjis" });
  });

  it("parses -o short option with value", () => {
    const result = parseArgs(["bpmx-to-pmx", "model.bpmx", "-o", "out.zip"]);
    expect(result.options).toEqual({ output: "out.zip" });
  });

  it("parses --output=value with equals sign", () => {
    const result = parseArgs(["bpmx-to-pmx", "model.bpmx", "--output=out.zip"]);
    expect(result.options).toEqual({ output: "out.zip" });
  });

  it("parses boolean flags", () => {
    const result = parseArgs(["bpmx-to-pmx", "model.bpmx", "--verbose"]);
    expect(result.flags.has("verbose")).toBe(true);
  });

  it("parses --no- prefix as flag", () => {
    const result = parseArgs([
      "bpmx-to-pmx",
      "model.bpmx",
      "--no-restore-images",
    ]);
    expect(result.flags.has("no-restore-images")).toBe(true);
  });

  it("parses -h as help flag", () => {
    const result = parseArgs(["-h"]);
    expect(result.flags.has("help")).toBe(true);
  });

  it("treats -- as end of options", () => {
    const result = parseArgs(["card-create", "--", "file--with-dashes.bpmx"]);
    expect(result.command).toBe("card-create");
    expect(result.positional).toEqual(["file--with-dashes.bpmx"]);
  });

  it("handles mixed options, flags, and positional args", () => {
    const result = parseArgs([
      "bpmx-to-pmx",
      "model.bpmx",
      "--encoding",
      "utf16le",
      "--no-restore-images",
      "--verbose",
    ]);
    expect(result.command).toBe("bpmx-to-pmx");
    expect(result.positional).toEqual(["model.bpmx"]);
    expect(result.options).toEqual({ encoding: "utf16le" });
    expect(result.flags.has("no-restore-images")).toBe(true);
    expect(result.flags.has("verbose")).toBe(true);
  });

  it("returns empty defaults for empty argv", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("");
    expect(result.positional).toEqual([]);
    expect(result.options).toEqual({});
    expect([...result.flags]).toEqual([]);
  });

  it("does not consume a value starting with - as option value", () => {
    const result = parseArgs(["cmd", "--output", "-something"]);
    // --output sees next arg starts with -, so it becomes a flag
    expect(result.options.output).toBeUndefined();
    expect(result.flags.has("output")).toBe(true);
    // -something is not a single-char flag, so it becomes positional
    expect(result.positional).toEqual(["-something"]);
  });
});
