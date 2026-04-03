// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { gzipSync, unzipSync } from "fflate";
import { extractCardPngToZip } from "@/app/converter/CardPngExtractor";
import { loadBuffer } from "./helpers";

const BASE_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("extractCardPngToZip", () => {
  it("extracts embedded files, metadata and the cleaned PNG into a ZIP", async () => {
    const bpmxPayload = new TextEncoder().encode("fake-bpmx-payload");
    const webmPayload = new TextEncoder().encode("fake-webm-payload");
    const pngBytes = createCardPng([
      {
        type: "bPMX",
        data: gzipSync(bpmxPayload),
      },
      {
        type: "webM",
        data: webmPayload,
      },
      {
        type: "aURL",
        data: new TextEncoder().encode("https://example.test/audio"),
      },
      {
        type: "eroV",
        data: new TextEncoder().encode("0.0.4"),
      },
      {
        type: "uInf",
        data: new TextEncoder().encode(
          JSON.stringify({ auth: "artist", ch: ["hero"], info: "note" }),
        ),
      },
      {
        type: "fBtn",
        data: new TextEncoder().encode(
          JSON.stringify([{ name: "Smile", action: "morph", morph: 1 }]),
        ),
      },
      {
        type: "moAi",
        data: new TextEncoder().encode(
          JSON.stringify({ name: "Model", gender: "f", info: "meta" }),
        ),
      },
    ]);

    const file = new File([toArrayBuffer(pngBytes)], "dance.ero.png", {
      type: "image/png",
    });
    const result = await extractCardPngToZip(file);
    const entries = unzipSync(new Uint8Array(result.zipBuffer));

    expect(result.report.foundChunkTypes).toEqual([
      "bPMX",
      "webM",
      "aURL",
      "eroV",
      "uInf",
      "fBtn",
      "moAi",
    ]);
    expect(Object.keys(entries).sort()).toEqual([
      "audio-url.txt",
      "dance.bpmx",
      "dance.webm",
      "ero.dance.png",
      "metadata.eroV.txt",
      "metadata.fBtn.json",
      "metadata.moAi.json",
      "metadata.uInf.json",
    ]);
    expect(decodeUtf8(entries["dance.bpmx"])).toBe("fake-bpmx-payload");
    expect(decodeUtf8(entries["dance.webm"])).toBe("fake-webm-payload");
    expect(decodeUtf8(entries["audio-url.txt"])).toBe(
      "https://example.test/audio",
    );
    expect(decodeUtf8(entries["metadata.eroV.txt"])).toBe("0.0.4");
    expect(JSON.parse(decodeUtf8(entries["metadata.uInf.json"]))).toEqual({
      auth: "artist",
      ch: ["hero"],
      info: "note",
    });
  });

  it("stores a cleaned PNG without the private card chunks", async () => {
    const pngBytes = createCardPng([
      {
        type: "bVMD",
        data: gzipSync(new TextEncoder().encode("fake-bvmd-payload")),
      },
      {
        type: "eroV",
        data: new TextEncoder().encode("1.2.3"),
      },
    ]);

    const result = await extractCardPngToZip(
      new File([toArrayBuffer(pngBytes)], "motion-card.png", {
        type: "image/png",
      }),
    );
    const entries = unzipSync(new Uint8Array(result.zipBuffer));
    const cleanedPng = entries["ero.dance.png"];

    expect(Array.from(cleanedPng.slice(0, 8))).toEqual(
      Array.from(BASE_PNG.slice(0, 8)),
    );
    expect(listChunkTypes(cleanedPng)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(result.report.sanitizedImageBytes).toBe(cleanedPng.byteLength);
  });

  it("prefers the last uInf chunk when duplicate metadata exists", async () => {
    const pngBytes = createCardPng([
      {
        type: "uInf",
        data: new TextEncoder().encode(
          JSON.stringify({ auth: "", ch: [""], info: "" }),
        ),
      },
      {
        type: "uInf",
        data: new TextEncoder().encode(
          JSON.stringify({ auth: "artist", ch: ["hero"], info: "filled" }),
        ),
      },
    ]);

    const result = await extractCardPngToZip(
      new File([toArrayBuffer(pngBytes)], "duplicate-uinf.png", {
        type: "image/png",
      }),
    );
    const entries = unzipSync(new Uint8Array(result.zipBuffer));

    expect(Object.keys(entries)).toContain("metadata.uInf.json");
    expect(Object.keys(entries)).not.toContain("metadata.uInf-2.json");
    expect(JSON.parse(decodeUtf8(entries["metadata.uInf.json"]))).toEqual({
      auth: "artist",
      ch: ["hero"],
      info: "filled",
    });
  });

  it("extracts renamed chunk variants and reports canonical chunk names", async () => {
    const pngBytes = createCardPng([
      {
        type: "bpMx",
        data: gzipSync(new TextEncoder().encode("fake-bpmx-payload")),
      },
      {
        type: "weBm",
        data: new TextEncoder().encode("fake-webm-payload"),
      },
      {
        type: "auRl",
        data: new TextEncoder().encode("https://example.test/audio"),
      },
      {
        type: "erOv",
        data: new TextEncoder().encode("0.0.5"),
      },
      {
        type: "uiNf",
        data: new TextEncoder().encode(
          JSON.stringify({ auth: "artist", ch: ["hero"], info: "new" }),
        ),
      },
      {
        type: "fbTn",
        data: new TextEncoder().encode(
          JSON.stringify([{ name: "Smile", action: "morph", morph: 1 }]),
        ),
      },
    ]);

    const result = await extractCardPngToZip(
      new File([toArrayBuffer(pngBytes)], "renamed-card.png", {
        type: "image/png",
      }),
    );
    const entries = unzipSync(new Uint8Array(result.zipBuffer));

    expect(result.report.foundChunkTypes).toEqual([
      "bPMX",
      "webM",
      "aURL",
      "eroV",
      "uInf",
      "fBtn",
    ]);
    expect(Object.keys(entries).sort()).toEqual([
      "audio-url.txt",
      "ero.dance.png",
      "metadata.eroV.txt",
      "metadata.fBtn.json",
      "metadata.uInf.json",
      "renamed-card.bpmx",
      "renamed-card.webm",
    ]);
    expect(listChunkTypes(entries["ero.dance.png"])).toEqual([
      "IHDR",
      "IDAT",
      "IEND",
    ]);
  });

  it("keeps compatibility when old and new chunk names are mixed", async () => {
    const pngBytes = createCardPng([
      {
        type: "uInf",
        data: new TextEncoder().encode(
          JSON.stringify({ auth: "old", ch: ["legacy"], info: "old" }),
        ),
      },
      {
        type: "uiNf",
        data: new TextEncoder().encode(
          JSON.stringify({ auth: "new", ch: ["modern"], info: "new" }),
        ),
      },
    ]);

    const result = await extractCardPngToZip(
      new File([toArrayBuffer(pngBytes)], "mixed-uinf.png", {
        type: "image/png",
      }),
    );
    const entries = unzipSync(new Uint8Array(result.zipBuffer));

    expect(JSON.parse(decodeUtf8(entries["metadata.uInf.json"]))).toEqual({
      auth: "new",
      ch: ["modern"],
      info: "new",
    });
    expect(
      result.report.warnings.some((warning) =>
        warning.message.includes("uInf war 2 mal vorhanden"),
      ),
    ).toBe(true);
  });

  it("converts embedded BPMX into PMX ZIP contents in legacy mode", async () => {
    const bpmxBuffer = loadBuffer("public/example/TestModel.bpmx");
    const pngBytes = createCardPng([
      {
        type: "bPMX",
        data: gzipSync(new Uint8Array(bpmxBuffer)),
      },
    ]);

    const result = await extractCardPngToZip(
      new File([toArrayBuffer(pngBytes)], "legacy-model.png", {
        type: "image/png",
      }),
      {
        convertToLegacyMmdFiles: true,
      },
    );
    const entries = unzipSync(new Uint8Array(result.zipBuffer));
    const exportedNames = Object.keys(entries).sort();

    expect(exportedNames).toContain("ero.dance.png");
    expect(
      exportedNames.some((name) => name.toLowerCase().endsWith(".pmx")),
    ).toBe(true);
    expect(exportedNames).not.toContain("legacy-model.bpmx");

    const pmxName = exportedNames.find((name) =>
      name.toLowerCase().endsWith(".pmx"),
    );
    expect(pmxName).toBeDefined();
    if (pmxName) {
      const pmxBytes = entries[pmxName];
      expect(Array.from(pmxBytes.slice(0, 4))).toEqual([
        0x50, 0x4d, 0x58, 0x20,
      ]);
    }
  });

  it("converts embedded BVMD into VMD in legacy mode", async () => {
    const bvmdBuffer = loadBuffer("public/example/TestMotion.bvmd");
    const pngBytes = createCardPng([
      {
        type: "bVMD",
        data: gzipSync(new Uint8Array(bvmdBuffer)),
      },
    ]);

    const result = await extractCardPngToZip(
      new File([toArrayBuffer(pngBytes)], "legacy-motion.png", {
        type: "image/png",
      }),
      {
        convertToLegacyMmdFiles: true,
      },
    );
    const entries = unzipSync(new Uint8Array(result.zipBuffer));

    expect(Object.keys(entries)).toContain("legacy-motion.vmd");
    expect(Object.keys(entries)).not.toContain("legacy-motion.bvmd");
    expect(decodeAscii(entries["legacy-motion.vmd"].slice(0, 30))).toContain(
      "Vocaloid Motion Data",
    );
  });

  it("keeps BPMV as BPMV even when legacy mode is enabled", async () => {
    const bpmvPayload = new TextEncoder().encode("fake-bpmv-payload");
    const pngBytes = createCardPng([
      {
        type: "bPMV",
        data: gzipSync(bpmvPayload),
      },
    ]);

    const result = await extractCardPngToZip(
      new File([toArrayBuffer(pngBytes)], "legacy-bpmv.png", {
        type: "image/png",
      }),
      {
        convertToLegacyMmdFiles: true,
      },
    );
    const entries = unzipSync(new Uint8Array(result.zipBuffer));

    expect(Object.keys(entries)).toContain("legacy-bpmv.bpmv");
    expect(decodeUtf8(entries["legacy-bpmv.bpmv"])).toBe("fake-bpmv-payload");
  });

  it("rejects invalid PNG input", async () => {
    const file = new File([new Uint8Array([0x00, 0x01, 0x02])], "broken.png", {
      type: "image/png",
    });

    await expect(extractCardPngToZip(file)).rejects.toThrow(
      "Datei ist zu klein fuer eine gueltige PNG.",
    );
  });
});

function createCardPng(
  chunks: ReadonlyArray<{ type: string; data: Uint8Array }>,
): Uint8Array {
  const beforeIend = BASE_PNG.subarray(0, BASE_PNG.byteLength - 12);
  const iend = BASE_PNG.subarray(BASE_PNG.byteLength - 12);
  const parts = [
    beforeIend,
    ...chunks.map((chunk) => createPngChunk(chunk.type, chunk.data)),
    iend,
  ];
  return concatUint8Arrays(parts);
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.byteLength + 12);
  writeUint32BE(chunk, 0, data.byteLength);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  return chunk;
}

function writeUint32BE(
  target: Uint8Array,
  offset: number,
  value: number,
): void {
  new DataView(target.buffer).setUint32(offset, value, false);
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

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

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder("ascii").decode(bytes).trimEnd();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
