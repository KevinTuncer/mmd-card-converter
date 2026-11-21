/**
 * Unit tests for the pure pixel-diff metric (src/app/morphlab/diff.ts).
 */

import { describe, expect, it } from "vitest";

import { computeDiffMetrics } from "../diff";
import { CAPTURE_WIDTH } from "../protocol";

const WIDTH = 16;
const HEIGHT = 16;

function filledBuffer(value: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  data.fill(value);
  return data;
}

/** Paints one pixel (RGBA) into the buffer. */
function paint(
  buffer: Uint8ClampedArray,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
): void {
  const offset = (y * WIDTH + x) * 4;
  buffer[offset] = r;
  buffer[offset + 1] = g;
  buffer[offset + 2] = b;
  buffer[offset + 3] = 255;
}

describe("computeDiffMetrics", () => {
  it("reports no change for identical buffers", () => {
    const a = filledBuffer(100);
    const metrics = computeDiffMetrics(a, a, WIDTH, HEIGHT);
    expect(metrics.changedRatio).toBe(0);
    expect(metrics.meanDelta).toBe(0);
    expect(metrics.bbox).toBeNull();
    expect(metrics.visible).toBe(false);
  });

  it("ignores tiny sub-threshold deltas", () => {
    const a = filledBuffer(100);
    const b = filledBuffer(105); // delta 5 < threshold 10
    const metrics = computeDiffMetrics(a, b, WIDTH, HEIGHT);
    expect(metrics.changedRatio).toBe(0);
    expect(metrics.visible).toBe(false);
    // Mean delta is still reported
    expect(metrics.meanDelta).toBeCloseTo(5, 5);
  });

  it("detects a small changed region with correct bbox", () => {
    const a = filledBuffer(100);
    const b = filledBuffer(100);
    paint(a, 3, 5, 100, 100, 100);
    paint(b, 3, 5, 250, 250, 250);
    paint(a, 8, 9, 100, 100, 100);
    paint(b, 8, 9, 0, 0, 0);

    const metrics = computeDiffMetrics(a, b, WIDTH, HEIGHT);
    expect(metrics.changedRatio).toBeCloseTo(2 / (WIDTH * HEIGHT), 8);
    expect(metrics.changedPixels).toBe(2);
    // 2 pixels < MIN_CHANGED_PIXELS (12) → not visible despite 0.78% ratio
    expect(metrics.visible).toBe(false);
    expect(metrics.bbox).toEqual({
      minX: 3,
      minY: 5,
      maxX: 8,
      maxY: 9,
    });
  });

  it("marks a 20-pixel change as visible (above min pixel floor)", () => {
    const a = filledBuffer(100);
    const b = filledBuffer(100);
    // 20 pixels in a horizontal band
    for (let x = 0; x < 20; x++) {
      paint(a, x, 4, 100, 100, 100);
      paint(b, x, 4, 250, 250, 250);
    }
    const metrics = computeDiffMetrics(a, b, WIDTH, HEIGHT);
    expect(metrics.changedPixels).toBe(20);
    expect(metrics.visible).toBe(true);
  });

  it("marks a full-frame change as visible", () => {
    const a = filledBuffer(20);
    const b = filledBuffer(240);
    const metrics = computeDiffMetrics(a, b, WIDTH, HEIGHT);
    expect(metrics.changedRatio).toBe(1);
    expect(metrics.visible).toBe(true);
    expect(metrics.bbox).toEqual({
      minX: 0,
      minY: 0,
      maxX: WIDTH - 1,
      maxY: HEIGHT - 1,
    });
  });

  it("treats alpha changes as changes", () => {
    const a = filledBuffer(100);
    const b = filledBuffer(100);
    for (let i = 3; i < b.length; i += 4) {
      b[i] = 40;
    }
    const metrics = computeDiffMetrics(a, b, WIDTH, HEIGHT);
    expect(metrics.changedRatio).toBe(1);
  });

  it("throws on size mismatch", () => {
    const a = filledBuffer(100);
    const b = new Uint8ClampedArray(a.length + 4);
    expect(() => computeDiffMetrics(a, b, WIDTH, HEIGHT)).toThrow(/mismatch/i);
  });

  it("throws when buffers are smaller than width*height*4", () => {
    const a = new Uint8ClampedArray(10);
    expect(() => computeDiffMetrics(a, a, CAPTURE_WIDTH, 640)).toThrow(
      /too small/i,
    );
  });
});
