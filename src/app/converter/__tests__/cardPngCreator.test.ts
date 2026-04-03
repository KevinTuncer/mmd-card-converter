// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { createCardPngFromFiles } from "@/app/converter/CardPngCreator";
import { extractCardPngToZip } from "@/app/converter/CardPngExtractor";
import { convertBvmdFileToVmd } from "@/app/converter/MmdMotionConverter";
import { loadBuffer, loadPmxFolder } from "./helpers";

const BASE_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("createCardPngFromFiles", () => {
  it("creates a roundtrip-compatible card PNG and writes only new chunk names", async () => {
    const files = [
      new File([toArrayBuffer(BASE_PNG)], "ero.dance.png", {
        type: "image/png",
      }),
      new File([loadBuffer("public/example/TestModel.bpmx")], "dance.bpmx"),
      new File([loadBuffer("public/example/TestMotion.bvmd")], "dance.bvmd"),
      new File([new TextEncoder().encode("fake-bpmv-payload")], "dance.bpmv"),
      new File([new TextEncoder().encode("fake-webm-payload")], "dance.webm", {
        type: "audio/webm",
      }),
      new File(
        [new TextEncoder().encode("https://example.test/audio")],
        "audio-url.txt",
        { type: "text/plain" },
      ),
      new File([new TextEncoder().encode("9.9.9")], "metadata.eroV.txt", {
        type: "text/plain",
      }),
      new File(
        [
          new TextEncoder().encode(
            JSON.stringify({ auth: "artist", ch: ["hero"], info: "note" }),
          ),
        ],
        "metadata.uInf.json",
        { type: "application/json" },
      ),
      new File(
        [
          new TextEncoder().encode(
            JSON.stringify([{ name: "Smile", action: "morph", morph: 1 }]),
          ),
        ],
        "metadata.fBtn.json",
        { type: "application/json" },
      ),
      new File(
        [
          new TextEncoder().encode(
            JSON.stringify({ name: "Model", gender: "f", info: "meta" }),
          ),
        ],
        "metadata.moAi.json",
        { type: "application/json" },
      ),
    ];

    const result = await createCardPngFromFiles(files, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
    });
    const chunkTypes = listChunkTypes(new Uint8Array(result.pngBuffer));

    expect(result.report.usedBaseImage).toBe("ero.dance.png");
    expect(result.report.embeddedChunkTypes).toEqual([
      "bPMX",
      "bPMV",
      "bVMD",
      "webM",
      "aURL",
      "eroV",
      "uInf",
      "fBtn",
      "moAi",
    ]);
    expect(chunkTypes).toEqual([
      "IHDR",
      "IDAT",
      "bpMx",
      "bpMv",
      "bvMd",
      "weBm",
      "auRl",
      "erOv",
      "uiNf",
      "fbTn",
      "moAi",
      "IEND",
    ]);
    expect(chunkTypes).not.toContain("bPMX");
    expect(chunkTypes).not.toContain("webM");
    expect(result.report.convertedFiles).toEqual([]);

    const extracted = await extractCardPngToZip(
      new File([result.pngBuffer], result.report.outputFileName, {
        type: "image/png",
      }),
    );
    const entries = unzipSync(new Uint8Array(extracted.zipBuffer));

    expect(Object.keys(entries).sort()).toEqual([
      "audio-url.txt",
      "dance.bpmv",
      "dance.bpmx",
      "dance.bvmd",
      "dance.webm",
      "ero.dance.png",
      "metadata.eroV.txt",
      "metadata.fBtn.json",
      "metadata.moAi.json",
      "metadata.uInf.json",
    ]);
    expect(decodeUtf8(entries["audio-url.txt"])).toBe(
      "https://example.test/audio",
    );
    expect(decodeUtf8(entries["metadata.eroV.txt"])).toBe("0.0.5");
    expect(decodeUtf8(entries["metadata.uInf.json"])).toBe(
      '{"auth":"artist","ch":["hero"],"info":"note"}',
    );
    expect(decodeUtf8(entries["metadata.fBtn.json"])).toBe(
      '[{"name":"Smile","action":"morph","morph":1}]',
    );
  });

  it("converts PMX and VMD input and falls back to the default base image", async () => {
    const { allFiles } = loadPmxFolder("public/example/TestModelAsPmx");
    const vmdBuffer = (
      await convertBvmdFileToVmd(
        new File([loadBuffer("public/example/TestMotion.bvmd")], "motion.bvmd"),
      )
    ).buffer;
    const motionFile = new File([vmdBuffer], "motion.vmd", {
      type: "application/octet-stream",
    });

    const result = await createCardPngFromFiles([...allFiles, motionFile], {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      compressionMode: "raw",
    });

    expect(result.report.usedBaseImage).toBe("public/eroLogo.png");
    expect(result.report.embeddedChunkTypes).toEqual(["bPMX", "bVMD", "eroV"]);
    expect(result.report.convertedFiles).toEqual([
      expect.stringContaining(".pmx -> "),
      "motion.vmd -> motion.bvmd",
    ]);

    const extracted = await extractCardPngToZip(
      new File([result.pngBuffer], result.report.outputFileName, {
        type: "image/png",
      }),
    );
    const entries = unzipSync(new Uint8Array(extracted.zipBuffer));
    const entryNames = Object.keys(entries).sort();

    expect(entryNames).toContain("ero.dance.png");
    expect(entryNames.some((name) => name.endsWith(".bpmx"))).toBe(true);
    expect(entryNames.some((name) => name.endsWith(".bvmd"))).toBe(true);
    const sanitizedChunkTypes = listChunkTypes(entries["ero.dance.png"]);
    expect(sanitizedChunkTypes).toContain("IEND");
    expect(sanitizedChunkTypes).not.toContain("bpMx");
    expect(sanitizedChunkTypes).not.toContain("bpMv");
    expect(sanitizedChunkTypes).not.toContain("bvMd");
    expect(sanitizedChunkTypes).not.toContain("weBm");
  });

  it("reports live image preparation progress for PMX-based card creation", async () => {
    const { allFiles } = loadPmxFolder("public/example/TestModelAsPmx");
    const progressCalls: Array<[number, number]> = [];

    await createCardPngFromFiles(allFiles, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      onImageProgress: (done, total) => {
        progressCalls.push([done, total]);
      },
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls.at(-1)?.[0]).toBe(progressCalls.at(-1)?.[1]);
  });

  it("uses the default base image when explicitly preferred over an auto-detected card image", async () => {
    const files = [
      new File([toArrayBuffer(BASE_PNG)], "ero.dance.png", {
        type: "image/png",
      }),
      new File([loadBuffer("public/example/TestModel.bpmx")], "dance.bpmx"),
    ];

    const result = await createCardPngFromFiles(files, {
      defaultBaseImageBuffer: loadBuffer("public/eroLogo.png"),
      preferDefaultBaseImage: true,
    });

    expect(result.report.usedBaseImage).toBe("public/eroLogo.png");

    const extracted = await extractCardPngToZip(
      new File([result.pngBuffer], result.report.outputFileName, {
        type: "image/png",
      }),
    );
    const entries = unzipSync(new Uint8Array(extracted.zipBuffer));
    const sanitizedChunkTypes = listChunkTypes(entries["ero.dance.png"]);

    expect(sanitizedChunkTypes).toContain("PLTE");
    expect(sanitizedChunkTypes).not.toContain("bpMx");
  });

  it("overrides staged JSON metadata when edited values are provided", async () => {
    const files = [
      new File([toArrayBuffer(BASE_PNG)], "ero.dance.png", {
        type: "image/png",
      }),
      new File([loadBuffer("public/example/TestModel.bpmx")], "dance.bpmx"),
      new File(
        [
          new TextEncoder().encode(
            JSON.stringify({ auth: "artist", ch: ["hero"], info: "note" }),
          ),
        ],
        "metadata.uInf.json",
        { type: "application/json" },
      ),
      new File(
        [
          new TextEncoder().encode(
            JSON.stringify([{ name: "Smile", action: "morph", morph: 1 }]),
          ),
        ],
        "metadata.fBtn.json",
        { type: "application/json" },
      ),
      new File(
        [
          new TextEncoder().encode(
            JSON.stringify({ name: "Model", gender: "f", info: "meta" }),
          ),
        ],
        "metadata.moAi.json",
        { type: "application/json" },
      ),
    ];

    const result = await createCardPngFromFiles(files, {
      metadataOverrides: {
        uInf: { auth: "override", ch: ["alt", "tag"], info: "edited" },
        fBtn: [{ name: "Blink", action: "morph", morph: 2 }],
        moAi: { name: "Override", gender: "x", info: "edited-meta" },
      },
    });

    const extracted = await extractCardPngToZip(
      new File([result.pngBuffer], result.report.outputFileName, {
        type: "image/png",
      }),
    );
    const entries = unzipSync(new Uint8Array(extracted.zipBuffer));

    expect(decodeUtf8(entries["metadata.uInf.json"])).toBe(
      '{"auth":"override","ch":["alt","tag"],"info":"edited"}',
    );
    expect(decodeUtf8(entries["metadata.fBtn.json"])).toBe(
      '[{"name":"Blink","action":"morph","morph":2}]',
    );
    expect(decodeUtf8(entries["metadata.moAi.json"])).toBe(
      '{"name":"Override","gender":"x","info":"edited-meta"}',
    );
  });

  it("embeds edited JSON metadata without source metadata files when a model exists", async () => {
    const files = [
      new File([toArrayBuffer(BASE_PNG)], "ero.dance.png", {
        type: "image/png",
      }),
      new File([loadBuffer("public/example/TestModel.bpmx")], "dance.bpmx"),
    ];

    const result = await createCardPngFromFiles(files, {
      metadataOverrides: {
        uInf: { auth: "fresh", ch: ["alpha"], info: "new" },
        fBtn: [{ name: "Look", action: "morph", morph: 3 }],
        moAi: { name: "Fresh", gender: "n", info: "created" },
      },
    });

    const extracted = await extractCardPngToZip(
      new File([result.pngBuffer], result.report.outputFileName, {
        type: "image/png",
      }),
    );
    const entries = unzipSync(new Uint8Array(extracted.zipBuffer));

    expect(Object.keys(entries)).toContain("metadata.uInf.json");
    expect(Object.keys(entries)).toContain("metadata.fBtn.json");
    expect(Object.keys(entries)).toContain("metadata.moAi.json");
    expect(decodeUtf8(entries["metadata.uInf.json"])).toBe(
      '{"auth":"fresh","ch":["alpha"],"info":"new"}',
    );
  });
});

function listChunkTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      4,
    ).getUint32(0, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    types.push(type);
    offset += length + 12;
    if (type === "IEND") {
      break;
    }
  }
  return types;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trimEnd();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
