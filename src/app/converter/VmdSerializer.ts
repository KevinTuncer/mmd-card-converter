import Encoding from "encoding-japanese";
import type {
  MmdBoneAnimationTrack,
  MmdCameraAnimationTrack,
  MmdMovableBoneAnimationTrack,
} from "babylon-mmd/esm/Loader/Animation/mmdAnimationTrack";
import type { MmdAnimation as MmdAnimationType } from "babylon-mmd/esm/Loader/Animation/mmdAnimation";

type MmdAnimation = MmdAnimationType;

const VMD_SIGNATURE = "Vocaloid Motion Data 0002";
const VMD_SIGNATURE_BYTES = 30;
const VMD_MODEL_NAME_BYTES = 20;
const VMD_BONE_NAME_BYTES = 15;
const VMD_MORPH_NAME_BYTES = 15;
const VMD_PROPERTY_IK_NAME_BYTES = 20;

function encodeShiftJisChar(char: string): Uint8Array {
  const encoded = Encoding.convert(Encoding.stringToCode(char), {
    to: "SJIS",
    from: "UNICODE",
    type: "array",
    fallback: "error",
  });
  return Uint8Array.from(encoded);
}

function encodeShiftJisString(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of value) {
    bytes.push(...encodeShiftJisChar(char));
  }
  return Uint8Array.from(bytes);
}

function encodeBoundedShiftJis(value: string, byteLimit: number): Uint8Array {
  const bytes: number[] = [];
  for (const char of value) {
    const encoded = encodeShiftJisChar(char);
    if (bytes.length + encoded.length > byteLimit) break;
    bytes.push(...encoded);
  }
  return Uint8Array.from(bytes);
}

function writeFixedBytes(
  target: Uint8Array,
  offset: number,
  byteLength: number,
  bytes: Uint8Array,
): void {
  target.fill(0, offset, offset + byteLength);
  target.set(bytes.subarray(0, byteLength), offset);
}

function setUint32(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value, true);
  return offset + 4;
}

function setFloat32(view: DataView, offset: number, value: number): number {
  view.setFloat32(offset, value, true);
  return offset + 4;
}

function buildBoneInterpolation(
  positionInterpolations: Uint8Array | null,
  rotationInterpolations: Uint8Array,
  frameIndex: number,
  physicsToggle: number,
): Uint8Array {
  const interpolation = new Uint8Array(64);

  const x = positionInterpolations
    ? positionInterpolations.subarray(frameIndex * 12 + 0, frameIndex * 12 + 4)
    : Uint8Array.from([20, 107, 20, 107]);
  const y = positionInterpolations
    ? positionInterpolations.subarray(frameIndex * 12 + 4, frameIndex * 12 + 8)
    : Uint8Array.from([20, 107, 20, 107]);
  const z = positionInterpolations
    ? positionInterpolations.subarray(frameIndex * 12 + 8, frameIndex * 12 + 12)
    : Uint8Array.from([20, 107, 20, 107]);
  const r = rotationInterpolations.subarray(frameIndex * 4, frameIndex * 4 + 4);
  const phy1 = physicsToggle === 0 ? 0x63 : 0x00;
  const phy2 = physicsToggle === 0 ? 0x0f : 0x00;

  interpolation.set([x[0], y[0], phy1, phy2], 0);
  interpolation.set([x[2], y[2], z[2], r[2]], 4);
  interpolation.set([x[1], y[1], z[1], r[1]], 8);
  interpolation.set([x[3], y[3], z[3], r[3]], 12);

  interpolation.set([y[0], z[0], r[0], x[2]], 16);
  interpolation.set([y[2], z[2], r[2], x[1]], 20);
  interpolation.set([y[1], z[1], r[1], x[3]], 24);
  interpolation.set([y[3], z[3], r[3], 0], 28);

  interpolation.set([z[0], r[0], x[2], y[2]], 32);
  interpolation.set([z[2], r[2], x[1], y[1]], 36);
  interpolation.set([z[1], r[1], x[3], y[3]], 40);
  interpolation.set([z[3], r[3], 0, 0], 44);

  interpolation.set([r[0], x[2], y[2], z[2]], 48);
  interpolation.set([r[2], x[1], y[1], z[1]], 52);
  interpolation.set([r[1], x[3], y[3], z[3]], 56);
  interpolation.set([r[3], 0, 0, 0], 60);

  return interpolation;
}

function buildCameraInterpolation(
  track: MmdCameraAnimationTrack,
  frameIndex: number,
): Uint8Array {
  const position = track.positionInterpolations.subarray(
    frameIndex * 12,
    frameIndex * 12 + 12,
  );
  const rotation = track.rotationInterpolations.subarray(
    frameIndex * 4,
    frameIndex * 4 + 4,
  );
  const distance = track.distanceInterpolations.subarray(
    frameIndex * 4,
    frameIndex * 4 + 4,
  );
  const fov = track.fovInterpolations.subarray(
    frameIndex * 4,
    frameIndex * 4 + 4,
  );

  return Uint8Array.from([
    position[0],
    position[1],
    position[2],
    position[3],
    position[4],
    position[5],
    position[6],
    position[7],
    position[8],
    position[9],
    position[10],
    position[11],
    rotation[0],
    rotation[1],
    rotation[2],
    rotation[3],
    distance[0],
    distance[1],
    distance[2],
    distance[3],
    fov[0],
    fov[1],
    fov[2],
    fov[3],
  ]);
}

type BoneFrame = {
  name: string;
  frameNumber: number;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number, number];
  interpolation: Uint8Array;
};

function collectBoneFrames(track: MmdBoneAnimationTrack): BoneFrame[] {
  const frames: BoneFrame[] = [];
  for (let index = 0; index < track.frameNumbers.length; index += 1) {
    const rotation: [number, number, number, number] = [
      track.rotations[index * 4 + 0],
      track.rotations[index * 4 + 1],
      track.rotations[index * 4 + 2],
      track.rotations[index * 4 + 3],
    ];

    frames.push({
      name: track.name,
      frameNumber: track.frameNumbers[index],
      position: [0, 0, 0],
      rotation,
      interpolation: buildBoneInterpolation(
        null,
        track.rotationInterpolations,
        index,
        track.physicsToggles[index],
      ),
    });
  }
  return frames;
}

function collectMovableBoneFrames(
  track: MmdMovableBoneAnimationTrack,
): BoneFrame[] {
  const frames: BoneFrame[] = [];
  for (let index = 0; index < track.frameNumbers.length; index += 1) {
    const rotation: [number, number, number, number] = [
      track.rotations[index * 4 + 0],
      track.rotations[index * 4 + 1],
      track.rotations[index * 4 + 2],
      track.rotations[index * 4 + 3],
    ];

    frames.push({
      name: track.name,
      frameNumber: track.frameNumbers[index],
      position: [
        track.positions[index * 3 + 0],
        track.positions[index * 3 + 1],
        track.positions[index * 3 + 2],
      ],
      rotation,
      interpolation: buildBoneInterpolation(
        track.positionInterpolations,
        track.rotationInterpolations,
        index,
        track.physicsToggles[index],
      ),
    });
  }
  return frames;
}

function calculateVmdByteLength(animation: MmdAnimation): number {
  const boneFrames = [
    ...animation.boneTracks.flatMap((track) => collectBoneFrames(track)),
    ...animation.movableBoneTracks.flatMap((track) =>
      collectMovableBoneFrames(track),
    ),
  ];

  let byteLength = VMD_SIGNATURE_BYTES + VMD_MODEL_NAME_BYTES;
  byteLength += 4 + boneFrames.length * (15 + 4 + 12 + 16 + 64);
  byteLength += 4;
  for (const track of animation.morphTracks) {
    byteLength += track.frameNumbers.length * (15 + 4 + 4);
  }
  byteLength +=
    4 +
    animation.cameraTrack.frameNumbers.length * (4 + 4 + 12 + 12 + 24 + 4 + 1);
  byteLength += 4;
  byteLength += 4;
  byteLength += 4;
  for (
    let frameIndex = 0;
    frameIndex < animation.propertyTrack.frameNumbers.length;
    frameIndex += 1
  ) {
    byteLength += 4 + 1 + 4;
    byteLength += animation.propertyTrack.ikBoneNames.length * (20 + 1);
  }
  return byteLength;
}

export interface SerializeVmdOptions {
  modelName?: string;
}

export function serializeMmdAnimationToVmd(
  animation: MmdAnimation,
  options: SerializeVmdOptions = {},
): ArrayBuffer {
  const modelName = options.modelName ?? animation.name ?? "Motion";
  const boneFrames = [
    ...animation.boneTracks.flatMap((track) => collectBoneFrames(track)),
    ...animation.movableBoneTracks.flatMap((track) =>
      collectMovableBoneFrames(track),
    ),
  ];

  const byteLength = calculateVmdByteLength(animation);
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  let offset = 0;
  writeFixedBytes(
    bytes,
    offset,
    VMD_SIGNATURE_BYTES,
    encodeShiftJisString(VMD_SIGNATURE),
  );
  offset += VMD_SIGNATURE_BYTES;
  writeFixedBytes(
    bytes,
    offset,
    VMD_MODEL_NAME_BYTES,
    encodeBoundedShiftJis(modelName, VMD_MODEL_NAME_BYTES),
  );
  offset += VMD_MODEL_NAME_BYTES;

  offset = setUint32(view, offset, boneFrames.length);
  for (const frame of boneFrames) {
    writeFixedBytes(
      bytes,
      offset,
      VMD_BONE_NAME_BYTES,
      encodeBoundedShiftJis(frame.name, VMD_BONE_NAME_BYTES),
    );
    offset += VMD_BONE_NAME_BYTES;
    offset = setUint32(view, offset, frame.frameNumber);
    offset = setFloat32(view, offset, frame.position[0]);
    offset = setFloat32(view, offset, frame.position[1]);
    offset = setFloat32(view, offset, frame.position[2]);
    offset = setFloat32(view, offset, frame.rotation[0]);
    offset = setFloat32(view, offset, frame.rotation[1]);
    offset = setFloat32(view, offset, frame.rotation[2]);
    offset = setFloat32(view, offset, frame.rotation[3]);
    bytes.set(frame.interpolation, offset);
    offset += frame.interpolation.length;
  }

  const morphFrameCount = animation.morphTracks.reduce(
    (total, track) => total + track.frameNumbers.length,
    0,
  );
  offset = setUint32(view, offset, morphFrameCount);
  for (const track of animation.morphTracks) {
    for (let index = 0; index < track.frameNumbers.length; index += 1) {
      writeFixedBytes(
        bytes,
        offset,
        VMD_MORPH_NAME_BYTES,
        encodeBoundedShiftJis(track.name, VMD_MORPH_NAME_BYTES),
      );
      offset += VMD_MORPH_NAME_BYTES;
      offset = setUint32(view, offset, track.frameNumbers[index]);
      offset = setFloat32(view, offset, track.weights[index]);
    }
  }

  offset = setUint32(view, offset, animation.cameraTrack.frameNumbers.length);
  for (
    let index = 0;
    index < animation.cameraTrack.frameNumbers.length;
    index += 1
  ) {
    offset = setUint32(view, offset, animation.cameraTrack.frameNumbers[index]);
    offset = setFloat32(view, offset, animation.cameraTrack.distances[index]);
    offset = setFloat32(
      view,
      offset,
      animation.cameraTrack.positions[index * 3 + 0],
    );
    offset = setFloat32(
      view,
      offset,
      animation.cameraTrack.positions[index * 3 + 1],
    );
    offset = setFloat32(
      view,
      offset,
      animation.cameraTrack.positions[index * 3 + 2],
    );
    offset = setFloat32(
      view,
      offset,
      animation.cameraTrack.rotations[index * 3 + 0],
    );
    offset = setFloat32(
      view,
      offset,
      animation.cameraTrack.rotations[index * 3 + 1],
    );
    offset = setFloat32(
      view,
      offset,
      animation.cameraTrack.rotations[index * 3 + 2],
    );
    const interpolation = buildCameraInterpolation(
      animation.cameraTrack,
      index,
    );
    bytes.set(interpolation, offset);
    offset += interpolation.length;
    view.setUint32(offset, Math.round(animation.cameraTrack.fovs[index]), true);
    offset += 4;
    bytes[offset] = 1;
    offset += 1;
  }

  offset = setUint32(view, offset, 0);
  offset = setUint32(view, offset, 0);
  offset = setUint32(view, offset, animation.propertyTrack.frameNumbers.length);
  for (
    let frameIndex = 0;
    frameIndex < animation.propertyTrack.frameNumbers.length;
    frameIndex += 1
  ) {
    offset = setUint32(
      view,
      offset,
      animation.propertyTrack.frameNumbers[frameIndex],
    );
    bytes[offset] = animation.propertyTrack.visibles[frameIndex] ? 1 : 0;
    offset += 1;
    offset = setUint32(
      view,
      offset,
      animation.propertyTrack.ikBoneNames.length,
    );
    for (
      let ikIndex = 0;
      ikIndex < animation.propertyTrack.ikBoneNames.length;
      ikIndex += 1
    ) {
      writeFixedBytes(
        bytes,
        offset,
        VMD_PROPERTY_IK_NAME_BYTES,
        encodeBoundedShiftJis(
          animation.propertyTrack.ikBoneNames[ikIndex],
          VMD_PROPERTY_IK_NAME_BYTES,
        ),
      );
      offset += VMD_PROPERTY_IK_NAME_BYTES;
      bytes[offset] = animation.propertyTrack.getIkState(ikIndex)[frameIndex]
        ? 1
        : 0;
      offset += 1;
    }
  }

  return buffer;
}
