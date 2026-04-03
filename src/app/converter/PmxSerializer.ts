import { PmxObject, type PmxObject as PmxObjectType } from "babylon-mmd";

class BinaryWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private offset = 0;

  public constructor(initialSize = 1024 * 1024) {
    this.buffer = new Uint8Array(initialSize);
    this.view = new DataView(this.buffer.buffer);
  }

  private ensure(size: number): void {
    if (this.offset + size <= this.buffer.length) return;

    let nextSize = this.buffer.length;
    while (nextSize < this.offset + size) nextSize *= 2;

    const next = new Uint8Array(nextSize);
    next.set(this.buffer);
    this.buffer = next;
    this.view = new DataView(this.buffer.buffer);
  }

  public writeUint8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  public writeInt8(value: number): void {
    this.ensure(1);
    this.view.setInt8(this.offset, value);
    this.offset += 1;
  }

  public writeUint16(value: number): void {
    this.ensure(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  public writeInt16(value: number): void {
    this.ensure(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }

  public writeInt32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  public writeFloat32(value: number): void {
    this.ensure(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }

  public writeBytes(value: Uint8Array): void {
    this.ensure(value.length);
    this.buffer.set(value, this.offset);
    this.offset += value.length;
  }

  public toArrayBuffer(): ArrayBuffer {
    return this.buffer.slice(0, this.offset).buffer;
  }
}

function encodeUtf16Le(input: string): Uint8Array {
  const bytes = new Uint8Array(input.length * 2);
  for (let i = 0; i < input.length; ++i) {
    const code = input.charCodeAt(i);
    bytes[i * 2 + 0] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  return bytes;
}

function encodeString(
  input: string,
  encoding: PmxObject.Header.Encoding,
): Uint8Array {
  if (encoding === PmxObject.Header.Encoding.Utf8) {
    return new TextEncoder().encode(input);
  }
  return encodeUtf16Le(input);
}

function writeTuple(writer: BinaryWriter, tuple: readonly number[]): void {
  for (let i = 0; i < tuple.length; ++i) writer.writeFloat32(tuple[i]);
}

function writeSignedIndex(
  writer: BinaryWriter,
  size: number,
  value: number,
): void {
  if (size === 1) writer.writeInt8(value);
  else if (size === 2) writer.writeInt16(value);
  else writer.writeInt32(value);
}

function writeVertexIndex(
  writer: BinaryWriter,
  size: number,
  value: number,
): void {
  if (size === 1) writer.writeUint8(value);
  else if (size === 2) writer.writeUint16(value);
  else writer.writeInt32(value);
}

function writePmxString(
  writer: BinaryWriter,
  value: string,
  encoding: PmxObject.Header.Encoding,
): void {
  const encoded = encodeString(value, encoding);
  writer.writeInt32(encoded.length);
  writer.writeBytes(encoded);
}

export function serializePmx(pmx: PmxObjectType): ArrayBuffer {
  const writer = new BinaryWriter();
  const { header } = pmx;

  writer.writeBytes(new Uint8Array([0x50, 0x4d, 0x58, 0x20]));
  writer.writeFloat32(header.version);

  writer.writeUint8(8);
  writer.writeUint8(header.encoding);
  writer.writeUint8(header.additionalVec4Count);
  writer.writeUint8(header.vertexIndexSize);
  writer.writeUint8(header.textureIndexSize);
  writer.writeUint8(header.materialIndexSize);
  writer.writeUint8(header.boneIndexSize);
  writer.writeUint8(header.morphIndexSize);
  writer.writeUint8(header.rigidBodyIndexSize);

  writePmxString(writer, header.modelName, header.encoding);
  writePmxString(writer, header.englishModelName, header.encoding);
  writePmxString(writer, header.comment, header.encoding);
  writePmxString(writer, header.englishComment, header.encoding);

  writer.writeInt32(pmx.vertices.length);
  for (let i = 0; i < pmx.vertices.length; ++i) {
    const vertex = pmx.vertices[i];
    writeTuple(writer, vertex.position);
    writeTuple(writer, vertex.normal);
    writeTuple(writer, vertex.uv);

    for (let j = 0; j < header.additionalVec4Count; ++j) {
      const vec4 = vertex.additionalVec4[j] ?? [0, 0, 0, 0];
      writeTuple(writer, vec4);
    }

    writer.writeUint8(vertex.weightType);

    switch (vertex.weightType) {
      case PmxObject.Vertex.BoneWeightType.Bdef1: {
        writeSignedIndex(
          writer,
          header.boneIndexSize,
          vertex.boneWeight.boneIndices as number,
        );
        break;
      }
      case PmxObject.Vertex.BoneWeightType.Bdef2: {
        const weight = vertex.boneWeight;
        const indices = weight.boneIndices as [number, number];
        writeSignedIndex(writer, header.boneIndexSize, indices[0]);
        writeSignedIndex(writer, header.boneIndexSize, indices[1]);
        writer.writeFloat32(weight.boneWeights as number);
        break;
      }
      case PmxObject.Vertex.BoneWeightType.Bdef4:
      case PmxObject.Vertex.BoneWeightType.Qdef: {
        const weight = vertex.boneWeight;
        const indices = weight.boneIndices as [number, number, number, number];
        const weights = weight.boneWeights as [number, number, number, number];
        for (let j = 0; j < 4; ++j)
          writeSignedIndex(writer, header.boneIndexSize, indices[j]);
        for (let j = 0; j < 4; ++j) writer.writeFloat32(weights[j]);
        break;
      }
      case PmxObject.Vertex.BoneWeightType.Sdef: {
        const weight = vertex.boneWeight;
        const indices = weight.boneIndices as [number, number];
        const sdef =
          weight.boneWeights as PmxObjectType["vertices"][number]["boneWeight"] extends {
            boneWeights: infer T;
          }
            ? T
            : never;
        writeSignedIndex(writer, header.boneIndexSize, indices[0]);
        writeSignedIndex(writer, header.boneIndexSize, indices[1]);
        writer.writeFloat32((sdef as { boneWeight0: number }).boneWeight0);
        writeTuple(writer, (sdef as { c: [number, number, number] }).c);
        writeTuple(writer, (sdef as { r0: [number, number, number] }).r0);
        writeTuple(writer, (sdef as { r1: [number, number, number] }).r1);
        break;
      }
      default:
        throw new Error(`Unsupported vertex weight type: ${vertex.weightType}`);
    }

    writer.writeFloat32(vertex.edgeScale);
  }

  writer.writeInt32(pmx.indices.length);
  for (let i = 0; i < pmx.indices.length; ++i) {
    writeVertexIndex(writer, header.vertexIndexSize, pmx.indices[i]);
  }

  writer.writeInt32(pmx.textures.length);
  for (let i = 0; i < pmx.textures.length; ++i) {
    writePmxString(writer, pmx.textures[i], header.encoding);
  }

  writer.writeInt32(pmx.materials.length);
  for (let i = 0; i < pmx.materials.length; ++i) {
    const material = pmx.materials[i];
    writePmxString(writer, material.name, header.encoding);
    writePmxString(writer, material.englishName, header.encoding);
    writeTuple(writer, material.diffuse);
    writeTuple(writer, material.specular);
    writer.writeFloat32(material.shininess);
    writeTuple(writer, material.ambient);
    writer.writeUint8(material.flag);
    writeTuple(writer, material.edgeColor);
    writer.writeFloat32(material.edgeSize);
    writeSignedIndex(writer, header.textureIndexSize, material.textureIndex);
    writeSignedIndex(
      writer,
      header.textureIndexSize,
      material.sphereTextureIndex,
    );
    writer.writeUint8(material.sphereTextureMode);
    writer.writeUint8(material.isSharedToonTexture ? 1 : 0);
    if (material.isSharedToonTexture)
      writer.writeUint8(material.toonTextureIndex);
    else
      writeSignedIndex(
        writer,
        header.textureIndexSize,
        material.toonTextureIndex,
      );
    writePmxString(writer, material.comment, header.encoding);
    writer.writeInt32(material.indexCount);
  }

  writer.writeInt32(pmx.bones.length);
  for (let i = 0; i < pmx.bones.length; ++i) {
    const bone = pmx.bones[i];
    writePmxString(writer, bone.name, header.encoding);
    writePmxString(writer, bone.englishName, header.encoding);
    writeTuple(writer, bone.position);
    writeSignedIndex(writer, header.boneIndexSize, bone.parentBoneIndex);
    writer.writeInt32(bone.transformOrder);
    writer.writeUint16(bone.flag);

    if (bone.flag & PmxObject.Bone.Flag.UseBoneIndexAsTailPosition) {
      writeSignedIndex(
        writer,
        header.boneIndexSize,
        bone.tailPosition as number,
      );
    } else {
      writeTuple(writer, bone.tailPosition as [number, number, number]);
    }

    if (
      bone.flag & PmxObject.Bone.Flag.HasAppendMove ||
      bone.flag & PmxObject.Bone.Flag.HasAppendRotate
    ) {
      const append = bone.appendTransform;
      writeSignedIndex(writer, header.boneIndexSize, append?.parentIndex ?? -1);
      writer.writeFloat32(append?.ratio ?? 0);
    }

    if (bone.flag & PmxObject.Bone.Flag.HasAxisLimit) {
      writeTuple(writer, bone.axisLimit ?? [0, 0, 0]);
    }

    if (bone.flag & PmxObject.Bone.Flag.HasLocalVector) {
      writeTuple(writer, bone.localVector?.x ?? [1, 0, 0]);
      writeTuple(writer, bone.localVector?.z ?? [0, 0, 1]);
    }

    if (bone.flag & PmxObject.Bone.Flag.IsExternalParentTransformed) {
      writer.writeInt32(bone.externalParentTransform ?? 0);
    }

    if (bone.flag & PmxObject.Bone.Flag.IsIkEnabled) {
      writeSignedIndex(writer, header.boneIndexSize, bone.ik?.target ?? -1);
      writer.writeInt32(bone.ik?.iteration ?? 0);
      writer.writeFloat32(bone.ik?.rotationConstraint ?? 0);
      writer.writeInt32(bone.ik?.links.length ?? 0);
      const links = bone.ik?.links ?? [];
      for (let l = 0; l < links.length; ++l) {
        const link = links[l];
        writeSignedIndex(writer, header.boneIndexSize, link.target);
        writer.writeUint8(link.limitation ? 1 : 0);
        if (link.limitation) {
          writeTuple(writer, link.limitation.minimumAngle);
          writeTuple(writer, link.limitation.maximumAngle);
        }
      }
    }
  }

  writer.writeInt32(pmx.morphs.length);
  for (let i = 0; i < pmx.morphs.length; ++i) {
    const morph = pmx.morphs[i];
    writePmxString(writer, morph.name, header.encoding);
    writePmxString(writer, morph.englishName, header.encoding);
    writer.writeInt8(morph.category);
    writer.writeInt8(morph.type);

    switch (morph.type) {
      case PmxObject.Morph.Type.GroupMorph:
        writer.writeInt32(morph.indices.length);
        for (let j = 0; j < morph.indices.length; ++j) {
          writeSignedIndex(writer, header.morphIndexSize, morph.indices[j]);
          writer.writeFloat32(morph.ratios[j]);
        }
        break;
      case PmxObject.Morph.Type.VertexMorph:
        writer.writeInt32(morph.indices.length);
        for (let j = 0; j < morph.indices.length; ++j) {
          writeVertexIndex(writer, header.vertexIndexSize, morph.indices[j]);
          writer.writeFloat32(morph.positions[j * 3 + 0]);
          writer.writeFloat32(morph.positions[j * 3 + 1]);
          writer.writeFloat32(morph.positions[j * 3 + 2]);
        }
        break;
      case PmxObject.Morph.Type.BoneMorph:
        writer.writeInt32(morph.indices.length);
        for (let j = 0; j < morph.indices.length; ++j) {
          writeSignedIndex(writer, header.boneIndexSize, morph.indices[j]);
          writer.writeFloat32(morph.positions[j * 3 + 0]);
          writer.writeFloat32(morph.positions[j * 3 + 1]);
          writer.writeFloat32(morph.positions[j * 3 + 2]);
          writer.writeFloat32(morph.rotations[j * 4 + 0]);
          writer.writeFloat32(morph.rotations[j * 4 + 1]);
          writer.writeFloat32(morph.rotations[j * 4 + 2]);
          writer.writeFloat32(morph.rotations[j * 4 + 3]);
        }
        break;
      case PmxObject.Morph.Type.UvMorph:
      case PmxObject.Morph.Type.AdditionalUvMorph1:
      case PmxObject.Morph.Type.AdditionalUvMorph2:
      case PmxObject.Morph.Type.AdditionalUvMorph3:
      case PmxObject.Morph.Type.AdditionalUvMorph4:
        writer.writeInt32(morph.indices.length);
        for (let j = 0; j < morph.indices.length; ++j) {
          writeVertexIndex(writer, header.vertexIndexSize, morph.indices[j]);
          writer.writeFloat32(morph.offsets[j * 4 + 0]);
          writer.writeFloat32(morph.offsets[j * 4 + 1]);
          writer.writeFloat32(morph.offsets[j * 4 + 2]);
          writer.writeFloat32(morph.offsets[j * 4 + 3]);
        }
        break;
      case PmxObject.Morph.Type.MaterialMorph:
        writer.writeInt32(morph.elements.length);
        for (let j = 0; j < morph.elements.length; ++j) {
          const element = morph.elements[j];
          writeSignedIndex(writer, header.materialIndexSize, element.index);
          writer.writeUint8(element.type);
          writeTuple(writer, element.diffuse);
          writeTuple(writer, element.specular);
          writer.writeFloat32(element.shininess);
          writeTuple(writer, element.ambient);
          writeTuple(writer, element.edgeColor);
          writer.writeFloat32(element.edgeSize);
          writeTuple(writer, element.textureColor);
          writeTuple(writer, element.sphereTextureColor);
          writeTuple(writer, element.toonTextureColor);
        }
        break;
      case PmxObject.Morph.Type.FlipMorph:
        writer.writeInt32(morph.indices.length);
        for (let j = 0; j < morph.indices.length; ++j) {
          writeSignedIndex(writer, header.morphIndexSize, morph.indices[j]);
          writer.writeFloat32(morph.ratios[j]);
        }
        break;
      case PmxObject.Morph.Type.ImpulseMorph:
        writer.writeInt32(morph.indices.length);
        for (let j = 0; j < morph.indices.length; ++j) {
          writeSignedIndex(writer, header.rigidBodyIndexSize, morph.indices[j]);
          writer.writeUint8(morph.isLocals[j] ? 1 : 0);
          writer.writeFloat32(morph.velocities[j * 3 + 0]);
          writer.writeFloat32(morph.velocities[j * 3 + 1]);
          writer.writeFloat32(morph.velocities[j * 3 + 2]);
          writer.writeFloat32(morph.torques[j * 3 + 0]);
          writer.writeFloat32(morph.torques[j * 3 + 1]);
          writer.writeFloat32(morph.torques[j * 3 + 2]);
        }
        break;
    }
  }

  writer.writeInt32(pmx.displayFrames.length);
  for (let i = 0; i < pmx.displayFrames.length; ++i) {
    const frame = pmx.displayFrames[i];
    writePmxString(writer, frame.name, header.encoding);
    writePmxString(writer, frame.englishName, header.encoding);
    writer.writeUint8(frame.isSpecialFrame ? 1 : 0);
    writer.writeInt32(frame.frames.length);
    for (let f = 0; f < frame.frames.length; ++f) {
      const element = frame.frames[f];
      writer.writeUint8(element.type);
      if (element.type === PmxObject.DisplayFrame.FrameData.FrameType.Bone) {
        writeSignedIndex(writer, header.boneIndexSize, element.index);
      } else {
        writeSignedIndex(writer, header.morphIndexSize, element.index);
      }
    }
  }

  writer.writeInt32(pmx.rigidBodies.length);
  for (let i = 0; i < pmx.rigidBodies.length; ++i) {
    const rigidBody = pmx.rigidBodies[i];
    writePmxString(writer, rigidBody.name, header.encoding);
    writePmxString(writer, rigidBody.englishName, header.encoding);
    writeSignedIndex(writer, header.boneIndexSize, rigidBody.boneIndex);
    writer.writeUint8(rigidBody.collisionGroup);
    writer.writeUint16(rigidBody.collisionMask);
    writer.writeUint8(rigidBody.shapeType);
    writeTuple(writer, rigidBody.shapeSize);
    writeTuple(writer, rigidBody.shapePosition);
    writeTuple(writer, rigidBody.shapeRotation);
    writer.writeFloat32(rigidBody.mass);
    writer.writeFloat32(rigidBody.linearDamping);
    writer.writeFloat32(rigidBody.angularDamping);
    writer.writeFloat32(rigidBody.repulsion);
    writer.writeFloat32(rigidBody.friction);
    writer.writeUint8(rigidBody.physicsMode);
  }

  writer.writeInt32(pmx.joints.length);
  for (let i = 0; i < pmx.joints.length; ++i) {
    const joint = pmx.joints[i];
    writePmxString(writer, joint.name, header.encoding);
    writePmxString(writer, joint.englishName, header.encoding);
    writer.writeUint8(joint.type);
    writeSignedIndex(writer, header.rigidBodyIndexSize, joint.rigidbodyIndexA);
    writeSignedIndex(writer, header.rigidBodyIndexSize, joint.rigidbodyIndexB);
    writeTuple(writer, joint.position);
    writeTuple(writer, joint.rotation);
    writeTuple(writer, joint.positionMin);
    writeTuple(writer, joint.positionMax);
    writeTuple(writer, joint.rotationMin);
    writeTuple(writer, joint.rotationMax);
    writeTuple(writer, joint.springPosition);
    writeTuple(writer, joint.springRotation);
  }

  if (header.version > 2) {
    writer.writeInt32(pmx.softBodies.length);
  }

  return writer.toArrayBuffer();
}
