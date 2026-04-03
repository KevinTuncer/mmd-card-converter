import { describe, it, expect } from "vitest";

import {
  compressImagesToAvif,
  detectImageFormat,
  LOSSY_QUALITY,
} from "../ImageCompressor";
import { loadBuffer } from "./helpers";

describe("ImageCompressor", () => {
  it("uses a high quality factor for lossy fallback encoding", () => {
    expect(LOSSY_QUALITY).toBeGreaterThan(0.85);
    expect(LOSSY_QUALITY).toBe(0.92);
  });

  it("forces a real AVIF output via jsquash for the sample BMP texture", async () => {
    const source = new File(
      [loadBuffer("public/example/TestModelAsPmx/TEX/4.bmp")],
      "4.bmp",
      { type: "image/bmp" },
    );

    const [converted] = await compressImagesToAvif(
      [source],
      undefined,
      undefined,
      { forceAvif: true },
    );

    expect(converted).not.toBe(source);
    expect(converted.name).toBe(source.name);
    expect(converted.type).toBe("image/avif");
    expect(await detectImageFormat(converted)).toBe("AVIF");
  });
});
