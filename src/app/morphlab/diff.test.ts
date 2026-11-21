/**
 * Unit tests for the pixel-diff visibility threshold: the change ratio is
 * calibrated at the base capture size and must be AREA-COMPENSATED for
 * higher render scales — otherwise raising the resolution (the AI's knob
 * for fine detail like body hair) could never flip a tiny effect to
 * visible, because numerator and denominator scale together.
 */

import { describe, expect, it } from "vitest";

import { computeDiffMetrics } from "./diff";
import { CAPTURE_HEIGHT, CAPTURE_WIDTH } from "./protocol";

/** Paints `count` individual changed pixels starting at (0, 0). */
function paintChangedPixels(
  data: Uint8ClampedArray,
  width: number,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const o = (Math.floor(i / width) * width + (i % width)) * 4;
    data[o] = 220;
    data[o + 1] = 220;
    data[o + 2] = 220;
  }
}

describe("computeDiffMetrics visibility threshold", () => {
  it("detects a small real effect at base resolution", () => {
    const width = CAPTURE_WIDTH;
    const height = CAPTURE_HEIGHT;
    const a = new Uint8ClampedArray(width * height * 4).fill(20);
    const b = new Uint8ClampedArray(width * height * 4).fill(20);
    paintChangedPixels(b, width, 30);
    const metrics = computeDiffMetrics(a, b, width, height);
    // 30 px ≥ 12 min AND 30/327 680 ≈ 0.0000915 ≥ 0.00008 ratio bar
    expect(metrics.changedPixels).toBe(30);
    expect(metrics.visible).toBe(true);
  });

  it("keeps the ABSOLUTE pixel bar constant at higher render scales", () => {
    const width = CAPTURE_WIDTH * 3;
    const height = CAPTURE_HEIGHT * 3;
    const a = new Uint8ClampedArray(width * height * 4).fill(20);
    const b = new Uint8ClampedArray(width * height * 4).fill(20);
    // The same tiny physical effect: ~30 changed pixels (observed: 陰毛
    // with 56 px at resolution 3). An UNSCALED ratio bar (0.00008 ×
    // 8.85 M px = 708 px) would declare this invisible forever — exactly
    // when the AI raises the resolution for fine detail.
    paintChangedPixels(b, width, 30);
    const metrics = computeDiffMetrics(a, b, width, height);
    expect(metrics.changedPixels).toBe(30);
    expect(metrics.visible).toBe(true);
  });

  it("still rejects sub-dithering pixel noise at high scales", () => {
    const width = CAPTURE_WIDTH * 3;
    const height = CAPTURE_HEIGHT * 3;
    const a = new Uint8ClampedArray(width * height * 4).fill(20);
    const b = new Uint8ClampedArray(width * height * 4).fill(20);
    paintChangedPixels(b, width, 5);
    expect(computeDiffMetrics(a, b, width, height).visible).toBe(false);
  });

  it("reports no change without a bbox", () => {
    const width = 32;
    const height = 32;
    const a = new Uint8ClampedArray(width * height * 4).fill(20);
    const b = new Uint8ClampedArray(width * height * 4).fill(20);
    const metrics = computeDiffMetrics(a, b, width, height);
    expect(metrics.visible).toBe(false);
    expect(metrics.bbox).toBeNull();
  });
});
