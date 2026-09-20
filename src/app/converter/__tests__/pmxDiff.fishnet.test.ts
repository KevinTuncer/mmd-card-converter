// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { PmxReader, type PmxObject } from "babylon-mmd";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd(), "public/example/TestFishnet");

function load(rel: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

function weightHistogram(pmx: PmxObject): string {
  const names = ["Bdef1", "Bdef2", "Bdef4", "Sdef", "Qdef"];
  const hist = new Map<string, number>(names.map((name) => [name, 0]));
  for (const vertex of pmx.vertices) {
    const name = names[vertex.weightType] ?? String(vertex.weightType);
    hist.set(name, (hist.get(name) ?? 0) + 1);
  }
  return JSON.stringify(Object.fromEntries(hist));
}

function uvStats(pmx: PmxObject): { u: number[]; v: number[] } {
  const u: number[] = [];
  const v: number[] = [];
  for (const vertex of pmx.vertices) {
    u.push(vertex.uv[0]);
    v.push(vertex.uv[1]);
  }
  u.sort((a, b) => a - b);
  v.sort((a, b) => a - b);
  return { u, v };
}

function arraysClose(a: readonly number[], b: readonly number[], eps = 1e-4) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (Math.abs(a[i] - b[i]) > eps) return false;
  }
  return true;
}

function mirrored(values: readonly number[]): number[] {
  return values.map((value) => 1 - value);
}

describe("2B PMX diff: original vs card-extract roundtrip", () => {
  it("dumps the structural differences", async () => {
    const originalBuf = load("2B/2B HIMEKAWA EE v1.9.pmx");
    const extractBuf = load("2B HIMEKAWA.ero.card-extract/2B HIMEKAWA.pmx");
    const original = await PmxReader.ParseAsync(originalBuf);
    const extracted = await PmxReader.ParseAsync(extractBuf);

    console.log(
      `SIZES: original=${originalBuf.byteLength} extracted=${extractBuf.byteLength}`,
    );
    console.log(
      `HEADER: original v${original.header.version} enc=${original.header.encoding} | extracted v${extracted.header.version} enc=${extracted.header.encoding}`,
    );

    const counts = (label: string, pmx: PmxObject) =>
      `${label}: vertices=${pmx.vertices.length} indices=${pmx.indices.length} textures=${pmx.textures.length} materials=${pmx.materials.length} bones=${pmx.bones.length} morphs=${pmx.morphs.length} displayFrames=${pmx.displayFrames.length} rigidBodies=${pmx.rigidBodies.length} joints=${pmx.joints.length}`;
    console.log(counts("COUNTS original ", original));
    console.log(counts("COUNTS extracted", extracted));

    console.log(
      `WEIGHTS original : ${weightHistogram(original)}\nWEIGHTS extracted: ${weightHistogram(extracted)}`,
    );

    // UV analysis: identical, or mirrored (double V-flip bug)?
    const ou = uvStats(original);
    const eu = uvStats(extracted);
    console.log(
      `UV sorted-u identical: ${arraysClose(ou.u, eu.u)} | sorted-v identical: ${arraysClose(ou.v, eu.v)} | sorted-v mirrored (1-v): ${arraysClose(eu.v, mirrored(ou.v))} | sorted-u mirrored: ${arraysClose(eu.u, mirrored(ou.u))}`,
    );

    // Textures
    console.log(
      `=== TEXTURES original (${original.textures.length}) ===\n${original.textures.join("\n")}`,
    );
    console.log(
      `=== TEXTURES extracted (${extracted.textures.length}) ===\n${extracted.textures.join("\n")}`,
    );

    // Materials side by side
    const count = Math.max(
      original.materials.length,
      extracted.materials.length,
    );
    for (let i = 0; i < count; ++i) {
      const o = original.materials[i];
      const e = extracted.materials[i];
      if (!o || !e) {
        console.log(`[${i}] MISSING: original=${!!o} extracted=${!!e}`);
        continue;
      }
      const diff = [];
      if (o.name !== e.name) diff.push("name");
      if (Math.abs(o.diffuse[3] - e.diffuse[3]) > 1e-6) diff.push("alpha");
      if (o.textureIndex !== e.textureIndex) diff.push("textureIndex");
      if (o.indexCount !== e.indexCount) diff.push("indexCount");
      if (o.flag !== e.flag) diff.push("flag");
      if (o.sphereTextureMode !== e.sphereTextureMode) diff.push("sphereMode");
      if (o.toonTextureIndex !== e.toonTextureIndex) diff.push("toon");
      console.log(
        `[${i}] "${o.name}" |"${e.name}"` +
          ` alpha=${o.diffuse[3].toFixed(4)}/${e.diffuse[3].toFixed(4)}` +
          ` tex=${o.textureIndex}/${e.textureIndex}` +
          ` faces=${o.indexCount / 3}/${e.indexCount / 3}` +
          ` flag=0x${o.flag.toString(16)}/0x${e.flag.toString(16)}` +
          ` sphere=${o.sphereTextureIndex}/${e.sphereTextureIndex}:${o.sphereTextureMode}/${e.sphereTextureMode}` +
          ` toon=${o.isSharedToonTexture ? "shared" : o.toonTextureIndex}/${e.isSharedToonTexture ? "shared" : e.toonTextureIndex}` +
          (diff.length > 0 ? `  <<< DIFFERS: ${diff.join(",")}` : ""),
      );
    }

    expect(extracted.vertices.length).toBeGreaterThan(0);
  }, 120_000);
});
