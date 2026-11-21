/**
 * Pure pixel-diff metrics for before/after morph screenshots.
 *
 * Runs in the browser page (`MorphLabPage.ts`) on RGBA `ImageData` buffers.
 * Kept dependency-free and pure so it is unit-testable under vitest.
 */

import {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  DIFF_PIXEL_DELTA_THRESHOLD,
  MIN_CHANGED_PIXELS,
  VISIBLE_CHANGE_RATIO,
  type DiffBBox,
  type DiffMetrics,
} from "./protocol";

/**
 * Compares two RGBA buffers of the given dimensions.
 *
 * @param a          "before" pixels (`ImageData.data` semantics: RGBA, 4 bytes
 *                   per pixel, row-major)
 * @param b          "after" pixels (same dimensions)
 * @param width      Buffer width in pixels
 * @param height     Buffer height in pixels
 */
export function computeDiffMetrics(
  a: Uint8ClampedArray | Uint8Array,
  b: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): DiffMetrics {
  if (a.length !== b.length) {
    throw new Error(`Diff buffer size mismatch: ${a.length} vs ${b.length}`);
  }
  if (a.length < width * height * 4) {
    throw new Error(
      `Diff buffers too small: ${a.length} < ${width * height * 4}`,
    );
  }

  const pixelCount = width * height;
  let changedPixels = 0;
  let totalDelta = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let py = 0; py < height; py++) {
    const rowOffset = py * width * 4;
    for (let px = 0; px < width; px++) {
      const o = rowOffset + px * 4;
      // Alpha included: clear color is opaque, so alpha only changes on
      // real content differences anyway.
      const dr = Math.abs(a[o] - b[o]);
      const dg = Math.abs(a[o + 1] - b[o + 1]);
      const db = Math.abs(a[o + 2] - b[o + 2]);
      const da = Math.abs(a[o + 3] - b[o + 3]);
      const delta = Math.max(dr, dg, db, da);
      totalDelta += (dr + dg + db + da) / 4;

      if (delta > DIFF_PIXEL_DELTA_THRESHOLD) {
        changedPixels++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }

  const changedRatio = changedPixels / pixelCount;
  const bbox: DiffBBox | null =
    changedPixels > 0 ? { minX, minY, maxX, maxY } : null;

  // The ratio bar is calibrated at the BASE capture size (512×640).
  // Higher render scales reproduce the same real effect in MORE pixels,
  // so an unscaled ratio keeps the bar unreachable exactly when the AI
  // raises "resolution" for fine detail (body hair, genital shape).
  // Compensating by the area scale keeps the ABSOLUTE pixel requirement
  // constant (~26 px equivalent at every resolution ≥ base). Captures
  // smaller than base (unit-test canvases) keep the base bar;
  // MIN_CHANGED_PIXELS guards dithering the same way as before.
  const areaScale = pixelCount / (CAPTURE_WIDTH * CAPTURE_HEIGHT);
  const ratioThreshold =
    areaScale > 1 ? VISIBLE_CHANGE_RATIO / areaScale : VISIBLE_CHANGE_RATIO;

  return {
    changedRatio,
    changedPixels,
    meanDelta: totalDelta / pixelCount,
    bbox,
    visible:
      changedPixels >= MIN_CHANGED_PIXELS && changedRatio >= ratioThreshold,
  };
}
