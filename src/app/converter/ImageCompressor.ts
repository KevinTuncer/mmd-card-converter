import { encodeToAvifViaJsquash } from "@/app/converter/ForceAvifEncoder";

/**
 * Compresses image files to AVIF format.
 *
 * Lossy encoding prefers a real AVIF path via WebCodecs when available.
 * Lossless encoding, unsupported codec configurations, transparent images, and
 * other unsupported cases fall back to the browser's Canvas export path.
 *
 * Files that are already AVIF (detected via magic bytes, regardless of file extension)
 * are passed through unchanged.
 *
 * Formats that the browser cannot decode (TGA, SPH, SPA, PMX, …) are passed through unchanged.
 */

/** Quality used when encoding a file lossily. */
export const LOSSY_QUALITY = 0.92;

/** Extensions that should be encoded losslessly. */
const LOSSLESS_EXTS = new Set(["png", "bmp", "webp"]);

/** Extensions that may be encoded lossily (source is already lossy). */
const LOSSY_EXTS = new Set(["jpg", "jpeg"]);

/** All extensions that will be converted. */
const COMPRESSIBLE_EXTS = new Set([...LOSSLESS_EXTS, ...LOSSY_EXTS]);

const TRANSPARENCY_CHECK_EXTS = new Set(["png", "webp"]);

const AV1_CODEC_CANDIDATES = ["av01.0.08M.08", "av01.0.04M.08"];
const AVIF_ALPHA_AUX_TYPE = "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha";

interface AvifEncoderSupport {
  codec: string;
}

export interface CompressImagesToAvifOptions {
  forceAvif?: boolean;
}

interface ForceAvifWorkerResponse {
  id: number;
  buffer?: ArrayBuffer;
  type?: string;
  error?: string;
}

interface ForceAvifWorkerState {
  worker: Worker;
  nextId: number;
  pending: Map<
    number,
    {
      resolve: (blob: Blob) => void;
      reject: (error: Error) => void;
    }
  >;
}

let forceAvifWorkerState: ForceAvifWorkerState | null = null;
let forceAvifWorkerDisabled = false;

function getExt(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

/** Reads the first 12 bytes of a file for magic-byte detection. */
async function readMagicBytes(file: File): Promise<Uint8Array> {
  const count = Math.min(file.size, 12);
  if (count === 0) return new Uint8Array(0);
  return new Uint8Array(await file.slice(0, count).arrayBuffer());
}

/**
 * Detects the image format from raw magic bytes.
 * Returns a short label: "PNG", "JPEG", "BMP", "WebP", "AVIF", or "?".
 */
function detectFormatFromBytes(b: Uint8Array): string {
  const txt = (s: number, n: number): string =>
    Array.from(b.subarray(s, s + n))
      .map((c) => String.fromCharCode(c))
      .join("");
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "PNG";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "JPEG";
  if (b[0] === 0x42 && b[1] === 0x4d) return "BMP";
  if (b.length >= 12 && txt(0, 4) === "RIFF" && txt(8, 4) === "WEBP")
    return "WebP";
  if (b.length >= 12 && txt(4, 4) === "ftyp") {
    const brand = txt(8, 4);
    if (brand === "avif" || brand === "avis") return "AVIF";
  }
  return "?";
}

async function isAlreadyAvif(file: File): Promise<boolean> {
  return detectFormatFromBytes(await readMagicBytes(file)) === "AVIF";
}

/**
 * Detects the actual image format of a file via magic bytes,
 * independent of the file name or extension.
 */
export async function detectImageFormat(file: File): Promise<string> {
  return detectFormatFromBytes(await readMagicBytes(file));
}

function transferRelPath(source: File, dest: File): void {
  const relPath = (source as File & { webkitRelativePath?: string })
    .webkitRelativePath;
  if (!relPath) return;
  try {
    Object.defineProperty(dest, "webkitRelativePath", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: relPath,
    });
  } catch {
    // Ignore if the environment does not allow redefining this property.
  }
}

function encodeAscii(value: string): Uint8Array {
  return new Uint8Array(Array.from(value, (char) => char.charCodeAt(0)));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function uint8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, value);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, value);
  return bytes;
}

function fullBoxHeader(version: number, flags: number): Uint8Array {
  return new Uint8Array([
    version & 0xff,
    (flags >> 16) & 0xff,
    (flags >> 8) & 0xff,
    flags & 0xff,
  ]);
}

function box(type: string, ...payloadParts: Uint8Array[]): Uint8Array {
  const payload = concatBytes(...payloadParts);
  return concatBytes(uint32(payload.length + 8), encodeAscii(type), payload);
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payloadParts: Uint8Array[]
): Uint8Array {
  return box(type, fullBoxHeader(version, flags), ...payloadParts);
}

function bufferSourceToUint8Array(value: AllowSharedBufferSource): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return Uint8Array.from(new Uint8Array(value));
  }

  if (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  ) {
    return Uint8Array.from(new Uint8Array(value));
  }

  const view = value as ArrayBufferView;
  return Uint8Array.from(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
  );
}

function makeFtypBox(): Uint8Array {
  return box(
    "ftyp",
    encodeAscii("avif"),
    uint32(0),
    encodeAscii("avif"),
    encodeAscii("mif1"),
    encodeAscii("miaf"),
    encodeAscii("MA1B"),
  );
}

function makeHandlerBox(): Uint8Array {
  return fullBox(
    "hdlr",
    0,
    0,
    uint32(0),
    encodeAscii("pict"),
    new Uint8Array(12),
    uint8(0),
  );
}

function makePrimaryItemBox(itemId: number): Uint8Array {
  return fullBox("pitm", 0, 0, uint16(itemId));
}

function makeItemInfoEntryBox(itemId: number, hidden = false): Uint8Array {
  return fullBox(
    "infe",
    2,
    hidden ? 1 : 0,
    uint16(itemId),
    uint16(0),
    encodeAscii("av01"),
    uint8(0),
  );
}

function makeItemInfoBox(entries: Uint8Array[]): Uint8Array {
  return fullBox("iinf", 0, 0, uint16(entries.length), ...entries);
}

function makeImageSpatialExtentsBox(width: number, height: number): Uint8Array {
  return fullBox("ispe", 0, 0, uint32(width), uint32(height));
}

function makePixelInformationBox(channelBits: number[]): Uint8Array {
  return fullBox(
    "pixi",
    0,
    0,
    uint8(channelBits.length),
    ...channelBits.map((bits) => uint8(bits)),
  );
}

function makeCodecConfigurationBox(av1Config: Uint8Array): Uint8Array {
  return box("av1C", av1Config);
}

function makeAuxiliaryTypePropertyBox(): Uint8Array {
  return fullBox("auxC", 0, 0, encodeAscii(AVIF_ALPHA_AUX_TYPE), uint8(0));
}

function makeItemPropertyContainerBox(properties: Uint8Array[]): Uint8Array {
  return box("ipco", ...properties);
}

function makeItemPropertyAssociationBox(
  itemProperties: Array<{ itemId: number; propertyIndices: number[] }>,
): Uint8Array {
  return fullBox(
    "ipma",
    0,
    0,
    uint32(itemProperties.length),
    ...itemProperties.flatMap(({ itemId, propertyIndices }) => {
      const associations = propertyIndices.map((propertyIndex) =>
        uint8(propertyIndex),
      );
      return [uint16(itemId), uint8(propertyIndices.length), ...associations];
    }),
  );
}

function makeItemPropertiesBox(
  properties: Uint8Array[],
  itemProperties: Array<{ itemId: number; propertyIndices: number[] }>,
): Uint8Array {
  return box(
    "iprp",
    makeItemPropertyContainerBox(properties),
    makeItemPropertyAssociationBox(itemProperties),
  );
}

function makeItemLocationBox(
  items: Array<{ itemId: number; baseOffset: number; itemLength: number }>,
): Uint8Array {
  return fullBox(
    "iloc",
    0,
    0,
    uint8(0x04),
    uint8(0x40),
    uint16(items.length),
    ...items.flatMap(({ itemId, baseOffset, itemLength }) => [
      uint16(itemId),
      uint16(0),
      uint32(baseOffset),
      uint16(1),
      uint32(itemLength),
    ]),
  );
}

function makeItemReferenceBox(
  fromItemId: number,
  toItemIds: number[],
): Uint8Array {
  return fullBox(
    "iref",
    0,
    0,
    box(
      "auxl",
      uint16(fromItemId),
      uint16(toItemIds.length),
      ...toItemIds.map((itemId) => uint16(itemId)),
    ),
  );
}

function makeMetadataBox(children: Uint8Array[]): Uint8Array {
  return fullBox("meta", 0, 0, ...children);
}

function buildStillImageAvif(
  width: number,
  height: number,
  av1Config: Uint8Array,
  av1Payload: Uint8Array,
  alphaAv1Payload?: Uint8Array,
  alphaAv1Config?: Uint8Array,
): Uint8Array {
  const hasAlpha =
    alphaAv1Payload !== undefined &&
    alphaAv1Payload.byteLength > 0 &&
    alphaAv1Config !== undefined;

  const properties = [
    makeImageSpatialExtentsBox(width, height),
    makePixelInformationBox([8, 8, 8]),
    makeCodecConfigurationBox(av1Config),
  ];

  const itemProperties = [{ itemId: 1, propertyIndices: [1, 2, 3] }];

  if (hasAlpha) {
    properties.push(
      makePixelInformationBox([8]),
      makeCodecConfigurationBox(alphaAv1Config),
      makeAuxiliaryTypePropertyBox(),
    );
    itemProperties.push({ itemId: 2, propertyIndices: [1, 4, 5, 6] });
  }

  const itemInfoEntries = [makeItemInfoEntryBox(1)];
  if (hasAlpha) {
    itemInfoEntries.push(makeItemInfoEntryBox(2, true));
  }

  const makeMetaWithOffset = (
    itemOffsets: Array<{
      itemId: number;
      baseOffset: number;
      itemLength: number;
    }>,
  ): Uint8Array =>
    makeMetadataBox([
      makeHandlerBox(),
      makePrimaryItemBox(1),
      makeItemLocationBox(itemOffsets),
      makeItemInfoBox(itemInfoEntries),
      makeItemPropertiesBox(properties, itemProperties),
      ...(hasAlpha ? [makeItemReferenceBox(1, [2])] : []),
    ]);

  const ftyp = makeFtypBox();
  const metaWithPlaceholderOffset = makeMetaWithOffset([
    { itemId: 1, baseOffset: 0, itemLength: av1Payload.length },
    ...(hasAlpha && alphaAv1Payload
      ? [{ itemId: 2, baseOffset: 0, itemLength: alphaAv1Payload.length }]
      : []),
  ]);
  const mdatPayloadOffset = ftyp.length + metaWithPlaceholderOffset.length + 8;
  const itemOffsets = [
    { itemId: 1, baseOffset: mdatPayloadOffset, itemLength: av1Payload.length },
  ];

  if (hasAlpha && alphaAv1Payload) {
    itemOffsets.push({
      itemId: 2,
      baseOffset: mdatPayloadOffset + av1Payload.length,
      itemLength: alphaAv1Payload.length,
    });
  }

  const meta = makeMetaWithOffset(itemOffsets);
  const mdat = box(
    "mdat",
    av1Payload,
    ...(hasAlpha && alphaAv1Payload ? [alphaAv1Payload] : []),
  );

  return concatBytes(ftyp, meta, mdat);
}

function computeLossyAv1Bitrate(
  width: number,
  height: number,
  quality: number,
): number {
  const bytesPerPixel = 0.12 + quality * 0.28;
  return Math.max(64_000, Math.round(width * height * bytesPerPixel * 8));
}

async function getWebCodecsAvifSupport(
  width: number,
  height: number,
  bitrate: number,
): Promise<AvifEncoderSupport | null> {
  if (typeof VideoEncoder === "undefined") return null;

  for (const codec of AV1_CODEC_CANDIDATES) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        displayWidth: width,
        displayHeight: height,
        bitrate,
        framerate: 1,
        bitrateMode: "variable",
        latencyMode: "quality",
        alpha: "keep",
      });

      if (support.supported) {
        return { codec };
      }
    } catch {
      // Ignore unsupported codec strings and try the next one.
    }
  }

  return null;
}

function make2dCanvas(
  width: number,
  height: number,
): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not get 2d context from OffscreenCanvas");
    }
    return { canvas, context };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not get 2d context from HTMLCanvasElement");
  }
  return { canvas, context };
}

async function bitmapHasTransparency(bitmap: ImageBitmap): Promise<boolean> {
  const { context } = make2dCanvas(bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 255) {
      return true;
    }
  }
  return false;
}

async function encodeToAvifViaWebCodecs(
  file: File,
  quality: number,
): Promise<Blob | null> {
  if (quality >= 1.0) return null;
  if (
    typeof VideoEncoder === "undefined" ||
    typeof VideoFrame === "undefined"
  ) {
    return null;
  }

  const bitmap = await createImageBitmap(file);
  let frame: VideoFrame | null = null;
  let activeEncoder: VideoEncoder | null = null;
  let hasTransparency = false;

  try {
    if (TRANSPARENCY_CHECK_EXTS.has(getExt(file.name))) {
      hasTransparency = await bitmapHasTransparency(bitmap);
    }

    const bitrate = computeLossyAv1Bitrate(
      bitmap.width,
      bitmap.height,
      quality,
    );
    const support = await getWebCodecsAvifSupport(
      bitmap.width,
      bitmap.height,
      bitrate,
    );
    if (!support) return null;

    const payloadChunks: Uint8Array[] = [];
    let av1Config: Uint8Array | null = null;
    let alphaSideData: Uint8Array | undefined;

    activeEncoder = new VideoEncoder({
      output(chunk, metadata?: EncodedVideoChunkMetadata) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        payloadChunks.push(Uint8Array.from(bytes));

        const description = metadata?.decoderConfig?.description;
        if (description && av1Config === null) {
          av1Config = bufferSourceToUint8Array(description);
        }

        const alphaBytes = (
          metadata as EncodedVideoChunkMetadata & {
            alphaSideData?: AllowSharedBufferSource;
          }
        )?.alphaSideData;
        if (alphaBytes) {
          alphaSideData = bufferSourceToUint8Array(alphaBytes);
        }
      },
      error(error) {
        throw error;
      },
    });

    frame = new VideoFrame(bitmap, { timestamp: 0 });
    activeEncoder.configure({
      codec: support.codec,
      width: bitmap.width,
      height: bitmap.height,
      displayWidth: bitmap.width,
      displayHeight: bitmap.height,
      bitrate,
      framerate: 1,
      bitrateMode: "variable",
      latencyMode: "quality",
      alpha: "keep",
    });
    activeEncoder.encode(frame, { keyFrame: true });
    await activeEncoder.flush();

    if (hasTransparency && (!alphaSideData || alphaSideData.byteLength === 0)) {
      return null;
    }

    if (av1Config === null || payloadChunks.length === 0) {
      return null;
    }

    const avifBytes = buildStillImageAvif(
      bitmap.width,
      bitmap.height,
      av1Config,
      concatBytes(...payloadChunks),
      alphaSideData,
      alphaSideData && alphaSideData.byteLength > 0 ? av1Config : undefined,
    );

    return new Blob([avifBytes.buffer as ArrayBuffer], { type: "image/avif" });
  } finally {
    frame?.close();
    activeEncoder?.close();
    bitmap.close();
  }
}

async function encodeToAvif(file: File, quality: number): Promise<Blob> {
  const webCodecsBlob = await encodeToAvifViaWebCodecs(file, quality);
  if (webCodecsBlob) {
    return webCodecsBlob;
  }

  const bitmap = await createImageBitmap(file);

  // Prefer OffscreenCanvas (available in workers and main thread on modern browsers)
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context from OffscreenCanvas");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.convertToBlob({ type: "image/avif", quality });
  }

  // Fallback: HTMLCanvasElement (main thread only)
  return new Promise<Blob>((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      reject(new Error("Could not get 2d context from HTMLCanvasElement"));
      return;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null")),
      "image/avif",
      quality,
    );
  });
}

function canUseForceAvifWorker(): boolean {
  return (
    !forceAvifWorkerDisabled &&
    typeof window !== "undefined" &&
    typeof Worker !== "undefined"
  );
}

function disposeForceAvifWorker(reason: Error): void {
  if (!forceAvifWorkerState) {
    forceAvifWorkerDisabled = true;
    return;
  }

  for (const { reject } of forceAvifWorkerState.pending.values()) {
    reject(reason);
  }

  forceAvifWorkerState.worker.terminate();
  forceAvifWorkerState = null;
  forceAvifWorkerDisabled = true;
}

function getForceAvifWorkerState(): ForceAvifWorkerState {
  if (forceAvifWorkerState) {
    return forceAvifWorkerState;
  }

  const worker = new Worker(new URL("./ForceAvifWorker.ts", import.meta.url), {
    type: "module",
  });
  const state: ForceAvifWorkerState = {
    worker,
    nextId: 1,
    pending: new Map(),
  };

  worker.addEventListener(
    "message",
    (event: MessageEvent<ForceAvifWorkerResponse>) => {
      const pending = state.pending.get(event.data.id);
      if (!pending) {
        return;
      }
      state.pending.delete(event.data.id);

      if (event.data.error) {
        pending.reject(new Error(event.data.error));
        return;
      }

      if (!event.data.buffer || !event.data.type) {
        pending.reject(new Error("Force AVIF worker returned no payload"));
        return;
      }

      pending.resolve(new Blob([event.data.buffer], { type: event.data.type }));
    },
  );

  worker.addEventListener("error", (event) => {
    disposeForceAvifWorker(
      event.error ?? new Error("Force AVIF worker failed"),
    );
  });

  forceAvifWorkerState = state;
  return state;
}

async function encodeToAvifViaJsquashOffThread(
  file: File,
  quality: number,
): Promise<Blob> {
  if (!canUseForceAvifWorker()) {
    return encodeToAvifViaJsquash(file, quality);
  }

  try {
    const state = getForceAvifWorkerState();
    return await new Promise<Blob>((resolve, reject) => {
      const id = state.nextId++;
      state.pending.set(id, { resolve, reject });
      state.worker.postMessage({ id, file, quality });
    });
  } catch {
    if (forceAvifWorkerState) {
      forceAvifWorkerState.worker.terminate();
      forceAvifWorkerState = null;
    }
    forceAvifWorkerDisabled = true;
    return encodeToAvifViaJsquash(file, quality);
  }
}

/**
 * Converts eligible image files in `files` to AVIF while preserving original
 * file names (including extensions) and `webkitRelativePath`.
 *
 * Every compressible file is always encoded as lossless AVIF (quality 1.0) and
 * only kept if smaller than the original.  Files in `lossyFiles` are encoded
 * lossily (quality 0.92) instead – only use this for files where quality loss
 * is acceptable (not depth maps, normal maps, etc.).
 *
 * Files whose format cannot be processed by the Canvas API are returned unchanged.
 *
 * @param files       Input file list (e.g. all files staged for conversion).
 * @param onProgress  Optional callback invoked after each image is processed.
 *                    Receives `(done, total)` where `total` is the count of
 *                    compressible images (excluding those already in AVIF format).
 * @param lossyFiles  Optional set of files to encode lossily (quality 0.92).
 *                    All other compressible files are encoded losslessly.
 * @param options     Optional encoder flags. `forceAvif` routes encoding through
 *                    `@jsquash/avif` so the result stays AVIF even when the
 *                    browser canvas path would fall back to PNG. In this mode,
 *                    a successfully encoded AVIF is kept even if it is larger
 *                    than the original source.
 */
export async function compressImagesToAvif(
  files: File[],
  onProgress?: (done: number, total: number) => void,
  lossyFiles?: Set<File>,
  options?: CompressImagesToAvifOptions,
): Promise<File[]> {
  // Pre-check which files are compressible and not already AVIF.
  // We do this upfront so the total count for the progress callback is accurate.
  const alreadyAvif = new Set<File>();
  for (const f of files) {
    if (COMPRESSIBLE_EXTS.has(getExt(f.name)) && (await isAlreadyAvif(f))) {
      alreadyAvif.add(f);
    }
  }

  const compressibleCount = files.filter(
    (f) => COMPRESSIBLE_EXTS.has(getExt(f.name)) && !alreadyAvif.has(f),
  ).length;

  let done = 0;
  const result: File[] = [];

  for (const file of files) {
    const ext = getExt(file.name);

    if (COMPRESSIBLE_EXTS.has(ext)) {
      // Pass through files that are already stored as AVIF regardless of extension.
      if (alreadyAvif.has(file)) {
        result.push(file);
        continue;
      }

      // Use lossy encoding when the caller explicitly opted in for this file,
      // otherwise always attempt lossless (but still keep only if smaller).
      const quality = (lossyFiles?.has(file) ?? false) ? LOSSY_QUALITY : 1.0;
      try {
        const avifBlob = options?.forceAvif
          ? await encodeToAvifViaJsquashOffThread(file, quality)
          : await encodeToAvif(file, quality);
        const shouldKeepConverted = options?.forceAvif
          ? avifBlob.type === "image/avif"
          : avifBlob.size < file.size;
        // Browsers that don't support AVIF encoding silently fall back to PNG.
        // For lossy mode: prefer AVIF, but accept PNG fallback (lossless is better
        // than nothing when AVIF encoding is unavailable). Force-AVIF bypasses
        // the size heuristic and keeps any successfully encoded AVIF result.
        if (shouldKeepConverted) {
          // Keep the original file name (and extension) – the BPMX format stores
          // original relative paths, so renaming would break texture lookups.
          const converted = new File([avifBlob], file.name, {
            type: avifBlob.type,
          });
          transferRelPath(file, converted);
          result.push(converted);
        } else {
          result.push(file);
        }
      } catch {
        // If conversion fails (unsupported AVIF encoder, corrupt image, …)
        // fall back to the original to avoid data loss.
        result.push(file);
      }
      done++;
      onProgress?.(done, compressibleCount);
    } else {
      result.push(file);
    }
  }

  return result;
}

/**
 * Computes the effective post-compression size for each eligible file without
 * materialising the full output bytes – useful for showing a before/after size
 * preview in the UI.
 *
 * For files where AVIF would be larger than the original, the original file
 * size is reported (i.e. no benefit from conversion). Already-AVIF files
 * also report their original size.
 *
 * @param files      Files to analyze.
 * @param lossyFiles Optional set of files to encode lossily (quality 0.92).
 *                   All other compressible files are encoded losslessly.
 * @param onEach     Callback invoked after each compressible file is analysed,
 *                   receiving the file and the size that would actually be used.
 */
export async function previewAvifSizes(
  files: File[],
  lossyFiles?: Set<File>,
  onEach?: (
    file: File,
    resultSize: number,
    outputFormat: string,
    mode: "lossless" | "lossy" | "already-avif" | "unchanged",
  ) => void,
): Promise<Map<File, number>> {
  const sizes = new Map<File, number>();

  for (const file of files) {
    const ext = getExt(file.name);
    if (!COMPRESSIBLE_EXTS.has(ext)) continue;

    // Read magic bytes once and reuse for both AVIF-check and format label.
    const magicBytes = await readMagicBytes(file);
    const originalFormat = detectFormatFromBytes(magicBytes);

    if (originalFormat === "AVIF") {
      sizes.set(file, file.size);
      onEach?.(file, file.size, "AVIF", "already-avif");
      continue;
    }

    const isLossy = lossyFiles?.has(file) ?? false;
    const quality = isLossy ? LOSSY_QUALITY : 1.0;
    try {
      const blob = await encodeToAvif(file, quality);
      const willConvert = blob.size < file.size;
      const resultSize = willConvert ? blob.size : file.size;
      const outputFormat = willConvert ? "AVIF" : originalFormat;
      const mode = willConvert ? (isLossy ? "lossy" : "lossless") : "unchanged";
      sizes.set(file, resultSize);
      onEach?.(file, resultSize, outputFormat, mode);
    } catch {
      sizes.set(file, file.size);
      onEach?.(file, file.size, originalFormat, "unchanged");
    }
  }

  return sizes;
}
