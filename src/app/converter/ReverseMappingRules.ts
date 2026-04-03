import {
  PmxObject,
  type BpmxObject,
  type PmxObject as PmxObjectType,
} from "babylon-mmd";
import type { FidelityReport } from "@/app/converter/types";

interface ReverseMappingResult {
  pmx: PmxObjectType;
  report: FidelityReport;
}

const EPSILON = 1e-5;

function chooseVertexIndexSize(vertexCount: number): 1 | 2 | 4 {
  if (vertexCount <= 0xff) return 1;
  if (vertexCount <= 0xffff) return 2;
  return 4;
}

function chooseSignedIndexSize(entryCount: number): 1 | 2 | 4 {
  if (entryCount <= 0x7f) return 1;
  if (entryCount <= 0x7fff) return 2;
  return 4;
}

function clampIndex(index: number): number {
  return Number.isFinite(index) ? Math.trunc(index) : -1;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; ++i) total += values[i];
  return total;
}

export function mapBpmxToPmxObject(
  bpmx: BpmxObject,
  encoding: PmxObject.Header.Encoding = PmxObject.Header.Encoding.Utf8,
): ReverseMappingResult {
  const warnings: FidelityReport["warnings"] = [];

  const vertexOffsets: number[] = [];
  const vertices: PmxObjectType["vertices"] extends readonly (infer T)[]
    ? T[]
    : never = [];
  const flattenedIndices: number[] = [];

  const materialIndexCounts = new Array<number>(bpmx.materials.length).fill(0);

  for (let meshIndex = 0; meshIndex < bpmx.geometries.length; ++meshIndex) {
    const geometry = bpmx.geometries[meshIndex];
    const vertexOffset = vertices.length;
    vertexOffsets.push(vertexOffset);

    const vertexCount = Math.floor(geometry.positions.length / 3);

    for (let i = 0; i < vertexCount; ++i) {
      const additionalVec4 = geometry.additionalUvs.map((uv) => {
        const p = i * 4;
        return [
          uv[p + 0] ?? 0,
          uv[p + 1] ?? 0,
          uv[p + 2] ?? 0,
          uv[p + 3] ?? 0,
        ] as [number, number, number, number];
      });

      let weightType = PmxObject.Vertex.BoneWeightType.Bdef1;
      let boneWeight: PmxObjectType["vertices"][number]["boneWeight"] = {
        boneIndices: -1,
        boneWeights: null,
      };

      if (geometry.skinning) {
        const matricesIndices = geometry.skinning.matricesIndices;
        const matricesWeights = geometry.skinning.matricesWeights;
        const m = i * 4;

        const b0 = clampIndex(matricesIndices[m + 0]);
        const b1 = clampIndex(matricesIndices[m + 1]);
        const b2 = clampIndex(matricesIndices[m + 2]);
        const b3 = clampIndex(matricesIndices[m + 3]);

        const w0 = matricesWeights[m + 0] ?? 0;
        const w1 = matricesWeights[m + 1] ?? 0;
        const w2 = matricesWeights[m + 2] ?? 0;
        const w3 = matricesWeights[m + 3] ?? 0;
        const active = [
          w0 > EPSILON,
          w1 > EPSILON,
          w2 > EPSILON,
          w3 > EPSILON,
        ].filter(Boolean).length;

        const sdef = geometry.skinning.sdef;
        if (sdef && w0 + w1 > EPSILON) {
          weightType = PmxObject.Vertex.BoneWeightType.Sdef;
          boneWeight = {
            boneIndices: [b0, b1],
            boneWeights: {
              boneWeight0: w0,
              c: [sdef.c[i * 3 + 0], sdef.c[i * 3 + 1], sdef.c[i * 3 + 2]],
              r0: [sdef.r0[i * 3 + 0], sdef.r0[i * 3 + 1], sdef.r0[i * 3 + 2]],
              r1: [sdef.r1[i * 3 + 0], sdef.r1[i * 3 + 1], sdef.r1[i * 3 + 2]],
            },
          };
        } else if (active <= 1) {
          weightType = PmxObject.Vertex.BoneWeightType.Bdef1;
          boneWeight = {
            boneIndices: b0,
            boneWeights: null,
          };
        } else if (active <= 2) {
          const total = w0 + w1;
          weightType = PmxObject.Vertex.BoneWeightType.Bdef2;
          boneWeight = {
            boneIndices: [b0, b1],
            boneWeights: total > EPSILON ? w0 / total : 0.5,
          };
        } else {
          weightType = PmxObject.Vertex.BoneWeightType.Bdef4;
          boneWeight = {
            boneIndices: [b0, b1, b2, b3],
            boneWeights: [w0, w1, w2, w3],
          };
        }
      }

      vertices.push({
        position: [
          geometry.positions[i * 3 + 0] ?? 0,
          geometry.positions[i * 3 + 1] ?? 0,
          geometry.positions[i * 3 + 2] ?? 0,
        ],
        normal: [
          geometry.normals[i * 3 + 0] ?? 0,
          geometry.normals[i * 3 + 1] ?? 0,
          geometry.normals[i * 3 + 2] ?? 1,
        ],
        uv: [geometry.uvs[i * 2 + 0] ?? 0, 1 - (geometry.uvs[i * 2 + 1] ?? 0)],
        additionalVec4,
        weightType,
        boneWeight,
        edgeScale: geometry.edgeScale?.[i] ?? 1,
      });
    }

    const localIndices = geometry.indices
      ? Array.from(geometry.indices)
      : Array.from({ length: vertexCount }, (_, i) => i);

    if (!geometry.indices) {
      warnings.push({
        level: "info",
        message: `Mesh ${meshIndex} ist nicht indexed. Sequenz-Indizes wurden erzeugt.`,
      });
    }

    // Reverse winding order to undo the PMX loader's left-handed → right-handed conversion
    for (let i = 0; i + 2 < localIndices.length; i += 3) {
      flattenedIndices.push(localIndices[i + 0] + vertexOffset);
      flattenedIndices.push(localIndices[i + 2] + vertexOffset);
      flattenedIndices.push(localIndices[i + 1] + vertexOffset);
    }

    const materialLink = geometry.materialIndex;
    if (Array.isArray(materialLink)) {
      warnings.push({
        level: "info",
        message: `Mesh ${meshIndex} nutzt SubGeometries. Material indexCount wurde aus SubMesh-Info rekonstruiert.`,
      });
      for (let i = 0; i < materialLink.length; ++i) {
        const sub = materialLink[i];
        if (
          0 <= sub.materialIndex &&
          sub.materialIndex < materialIndexCounts.length
        ) {
          materialIndexCounts[sub.materialIndex] += sub.indexCount;
        }
      }
    } else if (
      typeof materialLink === "number" &&
      0 <= materialLink &&
      materialLink < materialIndexCounts.length
    ) {
      materialIndexCounts[materialLink] += localIndices.length;
    }
  }

  const indices = new Int32Array(flattenedIndices.length);
  for (let i = 0; i < flattenedIndices.length; ++i) {
    indices[i] = flattenedIndices[i];
  }

  const textures = bpmx.textures.map((texture, textureIndex) => {
    if (texture.imageIndex < 0 || texture.imageIndex >= bpmx.images.length) {
      warnings.push({
        level: "warn",
        message: `Texture ${textureIndex} referenziert kein eingebettetes Image. Leerer PMX-Pfad gesetzt.`,
      });
      return "";
    }
    return bpmx.images[texture.imageIndex].relativePath;
  });

  const materials: PmxObjectType["materials"] = bpmx.materials.map(
    (material, index) => ({
      ...material,
      indexCount: materialIndexCounts[index] ?? 0,
    }),
  );

  const morphs: PmxObjectType["morphs"] = bpmx.morphs.map((morph) => {
    switch (morph.type) {
      case PmxObject.Morph.Type.VertexMorph: {
        const indicesMerged: number[] = [];
        const positionsMerged: number[] = [];
        for (let e = 0; e < morph.elements.length; ++e) {
          const element = morph.elements[e];
          const vertexOffset = vertexOffsets[element.meshIndex] ?? 0;
          if (vertexOffsets[element.meshIndex] === undefined) {
            warnings.push({
              level: "warn",
              message: `VertexMorph ${morph.name} referenziert unbekannten meshIndex ${element.meshIndex}.`,
            });
          }
          for (let i = 0; i < element.indices.length; ++i) {
            indicesMerged.push(element.indices[i] + vertexOffset);
            positionsMerged.push(
              element.offsets[i * 3 + 0] ?? 0,
              element.offsets[i * 3 + 1] ?? 0,
              element.offsets[i * 3 + 2] ?? 0,
            );
          }
        }
        return {
          name: morph.name,
          englishName: morph.englishName,
          category: morph.category,
          type: morph.type,
          indices: Int32Array.from(indicesMerged),
          positions: Float32Array.from(positionsMerged),
        };
      }
      case PmxObject.Morph.Type.UvMorph:
      case PmxObject.Morph.Type.AdditionalUvMorph1:
      case PmxObject.Morph.Type.AdditionalUvMorph2:
      case PmxObject.Morph.Type.AdditionalUvMorph3:
      case PmxObject.Morph.Type.AdditionalUvMorph4: {
        const indicesMerged: number[] = [];
        const offsetsMerged: number[] = [];
        // The PMX loader negates the V-offset for UvMorph (main UV) but not for
        // AdditionalUvMorphs. Undo that negation here when recovering PMX data.
        const isMainUvMorph = morph.type === PmxObject.Morph.Type.UvMorph;
        for (let e = 0; e < morph.elements.length; ++e) {
          const element = morph.elements[e];
          const vertexOffset = vertexOffsets[element.meshIndex] ?? 0;
          if (vertexOffsets[element.meshIndex] === undefined) {
            warnings.push({
              level: "warn",
              message: `UvMorph ${morph.name} referenziert unbekannten meshIndex ${element.meshIndex}.`,
            });
          }
          for (let i = 0; i < element.indices.length; ++i) {
            indicesMerged.push(element.indices[i] + vertexOffset);
            offsetsMerged.push(
              element.offsets[i * 4 + 0] ?? 0,
              isMainUvMorph
                ? -(element.offsets[i * 4 + 1] ?? 0)
                : (element.offsets[i * 4 + 1] ?? 0),
              element.offsets[i * 4 + 2] ?? 0,
              element.offsets[i * 4 + 3] ?? 0,
            );
          }
        }
        return {
          name: morph.name,
          englishName: morph.englishName,
          category: morph.category,
          type: morph.type,
          indices: Int32Array.from(indicesMerged),
          offsets: Float32Array.from(offsetsMerged),
        };
      }
      default:
        return morph as PmxObjectType["morphs"][number];
    }
  });

  const additionalVec4Count = Math.min(
    4,
    vertices.reduce(
      (max, vertex) => Math.max(max, vertex.additionalVec4.length),
      0,
    ),
  );

  const header: PmxObjectType["header"] = {
    signature: "PMX",
    version: 2.1,
    encoding,
    additionalVec4Count,
    vertexIndexSize: chooseVertexIndexSize(vertices.length),
    textureIndexSize: chooseSignedIndexSize(textures.length),
    materialIndexSize: chooseSignedIndexSize(materials.length),
    boneIndexSize: chooseSignedIndexSize(bpmx.bones.length),
    morphIndexSize: chooseSignedIndexSize(morphs.length),
    rigidBodyIndexSize: chooseSignedIndexSize(bpmx.rigidBodies.length),
    modelName: bpmx.header.modelName,
    englishModelName: bpmx.header.englishModelName,
    comment: bpmx.header.comment,
    englishComment: bpmx.header.englishComment,
  };

  const pmx: PmxObjectType = {
    header,
    vertices,
    indices,
    textures,
    materials,
    bones: bpmx.bones,
    morphs,
    displayFrames: bpmx.displayFrames,
    rigidBodies: bpmx.rigidBodies,
    joints: bpmx.joints,
    softBodies: [],
  };

  const report: FidelityReport = {
    sourceFormat: "BPMX",
    targetFormat: "PMX",
    totals: {
      vertices: vertices.length,
      indices: indices.length,
      textures: textures.length,
      materials: materials.length,
      bones: bpmx.bones.length,
      morphs: morphs.length,
      displayFrames: bpmx.displayFrames.length,
      rigidBodies: bpmx.rigidBodies.length,
      joints: bpmx.joints.length,
    },
    warnings,
  };

  if (sum(materialIndexCounts) !== indices.length) {
    report.warnings.push({
      level: "warn",
      message:
        "Summe aller Material indexCount weicht von der Gesamtindexzahl ab. Einige DrawRanges konnten nur angenaehert rekonstruiert werden.",
    });
  }

  return { pmx, report };
}
