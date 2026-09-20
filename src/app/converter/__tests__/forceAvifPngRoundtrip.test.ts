import { beforeAll, describe, expect, it } from "vitest";

import { decode as decodeAvif } from "@jsquash/avif";
import UPNG from "@lib/upng";
import { encodeToAvifViaJsquash } from "../ForceAvifEncoder";
import { loadBuffer } from "./helpers";

const FIXTURE_REL_PATH = "public/example/testImage/clothes.png";

/**
 * Der verlustfreie AV1-Pfad (Quantizer 0, YUV 4:4:4) speichert die YUV-Ebenen
 * bitgenau. Der RGB↔YUV-Roundtrip (BT.601, 8 bit) kann gesättigte Farben
 * formal mit bis zu ±2 pro Kanal runden; Grauwerte (R=G=B) und der Alpha-Kanal
 * müssen dagegen exakt überleben. Die Toleranzen beschreiben daher die durch
 * das AVIF-Format gegebene Obergrenze, keine erwartete Abweichung.
 *
 * Beobachtet am Fixture (4096×4096 RGBA, 20 411 α=0-Pixel, 198 semi-transparente,
 * 11 062 603 Graupixel): alle Diffs 0 — der Roundtrip ist bitidentisch.
 */
const YUV_ROUNDTRIP_TOLERANCE = 2;
const GRAY_TOLERANCE = 1;

interface RoundtripDiffStats {
  /** Pixel mit α = 0 – deren RGB darf nicht geschwärzt werden. */
  transparentPixelCount: number;
  /** Pixel mit 0 < α < 255 – Canvas-Prämultiplikation würde diese verschieben. */
  semiAlphaPixelCount: number;
  /** Pixel mit R = G = B im Original (Grauwerte – das gemeldete Symptom). */
  grayPixelCount: number;
  maxAlphaDiff: number;
  /** Max. Wertdifferenz auf Graupixeln (0 = bitidentisch). */
  grayMaxDiff: number;
  /** Graupixel, die nach dem Roundtrip nicht mehr R = G = B sind. */
  grayChromaViolations: number;
  /** Max. Differenz auf farbigen (nicht-grauen) Pixeln. */
  coloredMaxDiff: number;
  /** Max. RGB-Differenz auf volltransparenten Pixeln mit RGB ≠ 0. */
  transparentRgbMaxDiff: number;
}

let referenceRgba: Uint8ClampedArray;
let avifRgba: Uint8ClampedArray;
let width = 0;
let height = 0;
let stats: RoundtripDiffStats;

function decodePngReference(buffer: ArrayBuffer): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const png = UPNG.decode(buffer);
  const frame = UPNG.toRGBA8(png)[0];
  return {
    // Straight Alpha – UPNG läuft ohne Canvas und ohne Prämultiplikation.
    rgba: new Uint8ClampedArray(frame),
    width: png.width,
    height: png.height,
  };
}

function computeDiffStats(
  reference: Uint8ClampedArray,
  actual: Uint8ClampedArray,
): RoundtripDiffStats {
  const result: RoundtripDiffStats = {
    transparentPixelCount: 0,
    semiAlphaPixelCount: 0,
    grayPixelCount: 0,
    maxAlphaDiff: 0,
    grayMaxDiff: 0,
    grayChromaViolations: 0,
    coloredMaxDiff: 0,
    transparentRgbMaxDiff: 0,
  };

  for (let index = 0; index < reference.length; index += 4) {
    const r = reference[index];
    const g = reference[index + 1];
    const b = reference[index + 2];
    const a = reference[index + 3];

    const alphaDiff = Math.abs(a - actual[index + 3]);
    if (alphaDiff > result.maxAlphaDiff) {
      result.maxAlphaDiff = alphaDiff;
    }

    if (a === 0) result.transparentPixelCount++;
    else if (a < 255) result.semiAlphaPixelCount++;

    if (r === g && g === b) {
      result.grayPixelCount++;
      if (
        actual[index] !== actual[index + 1] ||
        actual[index + 1] !== actual[index + 2]
      ) {
        result.grayChromaViolations++;
      }
      const grayDiff = Math.max(
        Math.abs(r - actual[index]),
        Math.abs(g - actual[index + 1]),
        Math.abs(b - actual[index + 2]),
      );
      if (grayDiff > result.grayMaxDiff) result.grayMaxDiff = grayDiff;
    } else {
      const coloredDiff = Math.max(
        Math.abs(r - actual[index]),
        Math.abs(g - actual[index + 1]),
        Math.abs(b - actual[index + 2]),
      );
      if (coloredDiff > result.coloredMaxDiff) {
        result.coloredMaxDiff = coloredDiff;
      }
    }

    if (a === 0 && r + g + b > 0) {
      const transparentDiff = Math.max(
        Math.abs(r - actual[index]),
        Math.abs(g - actual[index + 1]),
        Math.abs(b - actual[index + 2]),
      );
      if (transparentDiff > result.transparentRgbMaxDiff) {
        result.transparentRgbMaxDiff = transparentDiff;
      }
    }
  }

  return result;
}

beforeAll(async () => {
  const pngBuffer = loadBuffer(FIXTURE_REL_PATH);

  const reference = decodePngReference(pngBuffer);
  referenceRgba = reference.rgba;
  width = reference.width;
  height = reference.height;

  const avifBlob = await encodeToAvifViaJsquash(
    new File([pngBuffer], "clothes.png", { type: "image/png" }),
    1.0,
  );
  expect(avifBlob.type).toBe("image/avif");

  const avifImage = await decodeAvif(await avifBlob.arrayBuffer());
  if (!avifImage) {
    throw new Error("AVIF decoding unexpectedly returned null");
  }
  expect(avifImage.width).toBe(width);
  expect(avifImage.height).toBe(height);
  avifRgba = avifImage.data;

  stats = computeDiffStats(referenceRgba, avifRgba);

  // Beobachtete Werte für die Toleranz-Kalibrierung mit loggen.
  console.log("[forceAvifPngRoundtrip] fixture:", `${width}x${height}`);
  console.log("[forceAvifPngRoundtrip] stats:", stats);
}, 600_000);

describe("Force-AVIF lossless roundtrip (clothes.png)", () => {
  it("fixture contains transparency so the premultiply case is exercised", () => {
    expect(stats.transparentPixelCount).toBeGreaterThan(0);
    expect(stats.semiAlphaPixelCount).toBeGreaterThan(0);
  });

  it("preserves every alpha value exactly", () => {
    expect(stats.maxAlphaDiff).toBe(0);
  });

  it("preserves gray values exactly, including under transparency", () => {
    // Sanity: Die Grau-Assertion muss überhaupt Substanz haben.
    expect(stats.grayPixelCount).toBeGreaterThan(100_000);
    expect(stats.grayChromaViolations).toBe(0);
    expect(stats.grayMaxDiff).toBeLessThanOrEqual(GRAY_TOLERANCE);
  });

  it("keeps the RGB of fully transparent pixels instead of blackening them", () => {
    expect(stats.transparentRgbMaxDiff).toBeLessThanOrEqual(
      YUV_ROUNDTRIP_TOLERANCE,
    );
  });

  it("keeps colored pixels within the YUV roundtrip tolerance", () => {
    expect(stats.coloredMaxDiff).toBeLessThanOrEqual(YUV_ROUNDTRIP_TOLERANCE);
  });

  it("round-trips back to a pixel-identical PNG", () => {
    // window-Polyfill: der Encode-Pfad von lib/upng fragt `window.UZIP` ab
    // (nur im Browser vorhanden); in Node muss der Zugriff lediglich definiert sein.
    (globalThis as { window?: unknown }).window ??= globalThis;

    const pngBuffer = UPNG.encodeLL(
      [avifRgba.buffer as ArrayBuffer],
      width,
      height,
      3,
      1,
      8,
    );
    const decoded = decodePngReference(pngBuffer);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);

    // Der PNG-Encode/Decode-Schritt muss selbst verlustfrei sein.
    let maxDiff = 0;
    let firstDiffIndex = -1;
    for (let index = 0; index < avifRgba.length; index++) {
      const diff = Math.abs(decoded.rgba[index] - avifRgba[index]);
      if (diff > maxDiff) {
        maxDiff = diff;
        firstDiffIndex = index;
      }
    }
    expect(
      { maxDiff, firstDiffIndex },
      `PNG roundtrip introduced diff: ${JSON.stringify({ maxDiff, firstDiffIndex })}`,
    ).toEqual({ maxDiff: 0, firstDiffIndex: -1 });
  });
});
