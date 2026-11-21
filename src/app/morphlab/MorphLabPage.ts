/**
 * Morph-AI Lab — browser-side runtime module.
 *
 * Loaded by the runner page served from the Bun CLI (`workspace/morph-lab`).
 * Boots a WebGL Babylon.js scene, loads the PMX model, and executes lab
 * commands (poll `/lab/poll`, report to `/lab/report`):
 *
 *   - `load`        Load the model + build MmdRuntime/MmdModel + frame camera
 *   - `testMorph`   Before/after screenshots around one morph activation
 *                   (with optional prerequisite morphs and camera view)
 *   - `captureBase` Single screenshot (character overview)
 *   - `shutdown`    Stop the poll loop
 *
 * Determinism: no physics, no animation, no camera inputs, antialias off,
 * fixed capture size, explicit `morph.update()` before every render.
 */

import { Engine } from "@babylonjs/core/Engines/engine";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Nullable } from "@babylonjs/core/types";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

// Side-effect imports required to register texture loaders (same set as
// src/app/converter/PmxToBpmxConverter.ts)
import "@babylonjs/core/Materials/Textures/Loaders/ddsTextureLoader";
import "@babylonjs/core/Materials/Textures/Loaders/tgaTextureLoader";
// Tools.CreateScreenshotAsync is NOT used: it hangs under headless
// SwiftShader/WebGL1. Instead we render explicitly and read the canvas
// synchronously (deterministic, requires preserveDrawingBuffer).

import {
  MmdRuntime,
  MmdStandardMaterialBuilder,
  MmdStandardMaterialProxy,
  MmdMaterialRenderMethod,
} from "babylon-mmd";
import type { MmdModel } from "babylon-mmd";
import type { MmdMesh } from "babylon-mmd";

import { computeDiffMetrics } from "./diff";
import {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  DEFAULT_VIEW,
  type LabCommand,
  type LoadResult,
  type ModelIndex,
  type MorphWeight,
  type ViewSpec,
} from "./protocol";

// ── Lab session state ────────────────────────────────────────────────────────

interface LabSession {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  mmdRuntime: MmdRuntime;
  model: MmdModel;
  /** Bounding box of the loaded model (world space). */
  min: Vector3;
  max: Vector3;
  /** Full-body framing radius at distanceFactor = 1. */
  baseRadius: number;
  /** Verbose diagnostics (--debug). */
  debugLogs: boolean;
}

let session: LabSession | null = null;
let decodeCanvas: OffscreenCanvas | null = null;

// ── CPU morph application ────────────────────────────────────────────────
// Babylon's GPU morph target pipeline (attribute AND texture mode) renders
// nothing under headless SwiftShader — verified with a hand-rolled cube
// morph (0 changed pixels). We therefore apply vertex morphs on the CPU:
// base positions + Σ (target positions × influence), written directly into
// each mesh's position buffer. Bone/material/group morphs still go through
// the MmdMorphController (they are CPU-bound anyway).
interface MeshMorphData {
  mesh: Mesh;
  basePositions: Float32Array;
}
const cpuMorphMeshes: MeshMorphData[] = [];
const targetToMeshIndex = new Map<MorphTarget, number>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.log(`[morphlab] ${message}`);
}

function dataUrlToBase64(dataUrl: string): string {
  const index = dataUrl.indexOf(",");
  return index === -1 ? dataUrl : dataUrl.slice(index + 1);
}

function encodePathSegments(relPath: string): string {
  return relPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Fetches a model file. `urlRel` is the path relative to the model folder
 * (server route), `nameRel` the name the loader should see (relative to the
 * PMX directory, like the repo's converter does).
 */
async function fetchFile(
  urlRel: string,
  nameRel: string,
  mimeType: string,
): Promise<File> {
  const response = await fetch(`/lab/file/${encodePathSegments(urlRel)}`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch model file "${urlRel}": HTTP ${response.status}`,
    );
  }
  const blob = await response.blob();
  const file = new File([blob], nameRel, { type: mimeType });
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    enumerable: true,
    writable: false,
    value: nameRel,
  });
  return file;
}

function guessMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    bmp: "image/bmp",
    tga: "image/x-tga",
    spa: "application/octet-stream",
    sph: "application/octet-stream",
    pmx: "application/octet-stream",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Decodes a PNG data URL into RGBA pixel data at the given resolution.
 *  Defaults to the base capture size — higher-resolution testMorph
 *  captures pass their own dimensions. */
async function decodePngToRgba(
  dataUrl: string,
  width: number = CAPTURE_WIDTH,
  height: number = CAPTURE_HEIGHT,
): Promise<Uint8ClampedArray> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width !== width || bitmap.height !== height) {
    throw new Error(
      `Unexpected screenshot size ${bitmap.width}x${bitmap.height}`,
    );
  }
  const ctx = decodeCanvas?.width === width && decodeCanvas?.height === height
    ? decodeCanvas.getContext("2d", { willReadFrequently: true })
    : (decodeCanvas = new OffscreenCanvas(width, height)).getContext("2d", {
        willReadFrequently: true,
      });
  if (ctx === null) throw new Error("Failed to get 2d context");
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height).data;
}

function captureScreenshot(): string {
  if (session === null) throw new Error("No model loaded");
  // Render once, then read the drawing buffer in the same task —
  // deterministic and fast under SwiftShader.
  session.scene.render();
  const canvas = session.engine.getRenderingCanvas();
  if (canvas === null) throw new Error("Rendering canvas unavailable");
  return (canvas as HTMLCanvasElement).toDataURL("image/png");
}

function applyView(view: ViewSpec): void {
  if (session === null) throw new Error("No model loaded");
  const { camera, min, max, baseRadius } = session;

  const yaw = ((view.yawDeg ?? 0) * Math.PI) / 180;
  const pitch = ((view.pitchDeg ?? 0) * Math.PI) / 180;
  const sizeY = max.y - min.y;
  const sizeX = max.x - min.x;
  const centerZ = (min.z + max.z) / 2;

  // yawDeg 0 = front view (verified against the old ero.dance app:
  // front-facing cameras use alpha = -π/2; PMX models face -Z)
  camera.alpha = -Math.PI / 2 + yaw;
  camera.beta = Math.min(Math.PI - 0.05, Math.max(0.05, Math.PI / 2 - pitch));
  camera.radius = baseRadius * (view.distanceFactor ?? 1);
  camera.target.set(
    min.x + sizeX * (view.targetXFactor ?? 0.5),
    min.y + sizeY * (view.targetYFactor ?? 0.5),
    centerZ,
  );
}

function applyMorphWeights(weights: readonly MorphWeight[]): void {
  if (session === null) throw new Error("No model loaded");
  // Bone/material/group morphs via the controller (CPU-bound path)
  session.model.morph.resetMorphWeights();
  for (const entry of weights) {
    session.model.morph.setMorphWeightFromIndex(entry.index, entry.weight);
  }

  // Vertex morphs on the CPU (GPU morph targets don't render under
  // SwiftShader — see MeshMorphData comment)
  const morphs = session.model.morph.morphs;
  const updated: Array<Float32Array | null> = cpuMorphMeshes.map(() => null);
  let dbgMapped = 0;
  let dbgUnmapped = 0;
  let dbgNull = 0;
  let dbgLen = 0;
  for (const entry of weights) {
    const morph = morphs[entry.index];
    if (
      morph === undefined ||
      morph.type !== 1 /* VertexMorph */ ||
      morph.elements === null
    ) {
      continue;
    }
    for (const target of morph.elements as readonly MorphTarget[]) {
      const meshIndex = targetToMeshIndex.get(target);
      if (meshIndex === undefined) {
        dbgUnmapped++;
        continue;
      }
      const targetPositions = target.getPositions();
      if (targetPositions === null) {
        dbgNull++;
        continue;
      }
      const meshData = cpuMorphMeshes[meshIndex]!;
      let positions = updated[meshIndex];
      if (positions === null) {
        positions = meshData.basePositions.slice();
        updated[meshIndex] = positions;
      }
      if (targetPositions.length !== positions.length) {
        dbgLen++;
        continue;
      }
      dbgMapped++;
      // babylon morph target positions are ABSOLUTE (base + offset):
      // blend back to an additive offset
      const base = meshData.basePositions;
      const weight = entry.weight;
      for (let i = 0; i < positions.length; i++) {
        positions[i] += (targetPositions[i]! - base[i]!) * weight;
      }
    }
  }
  let dbgUpdated = 0;
  let dbgBlendedMax = 0;
  for (let i = 0; i < cpuMorphMeshes.length; i++) {
    const meshData = cpuMorphMeshes[i]!;
    const positions = updated[i] ?? meshData.basePositions;
    if (updated[i] !== null) {
      dbgUpdated++;
      const base = meshData.basePositions;
      for (let j = 0; j < positions.length; j++) {
        const delta = Math.abs(positions[j]! - base[j]!);
        if (delta > dbgBlendedMax) dbgBlendedMax = delta;
      }
    }
    meshData.mesh.geometry?.setVerticesData(
      VertexBuffer.PositionKind,
      positions,
      false,
    );
  }
  // Verify the first actually-morphed mesh picked up the new data
  // (verbose diagnostics only in debug mode)
  const firstUpdated = updated.findIndex((u) => u !== null);
  if (session.debugLogs && firstUpdated !== -1) {
    const meshData = cpuMorphMeshes[firstUpdated]!;
    const readBack = meshData.mesh.getVerticesData(VertexBuffer.PositionKind);
    const expected = updated[firstUpdated]!;
    const differs =
      readBack === null ||
      readBack.length !== expected.length ||
      readBack[0] !== expected[0] ||
      readBack[100] !== expected[100];
    log(
      `  dbg cpu morphs: mapped=${dbgMapped} unmapped=${dbgUnmapped} null=${dbgNull} lenMismatch=${dbgLen} meshesUpdated=${dbgUpdated} blendedMax=${dbgBlendedMax.toFixed(4)} bufferDiffersFromExpected=${differs}`,
    );
  }
}

/**
 * Applies morphs and renders one frame.
 */
function renderFrame(): void {
  if (session === null) throw new Error("No model loaded");
  session.model.morph.update();
  session.scene.render();
}

// ── Command execution ────────────────────────────────────────────────────────

async function executeLoad(
  modelIndex: ModelIndex,
  pmxRelPath: string,
): Promise<unknown> {
  // A session can only be loaded once per page lifetime
  if (session !== null) throw new Error("Model already loaded");

  const engine = new Engine(
    document.getElementById("renderCanvas") as HTMLCanvasElement,
    false, // antialias off → deterministic pixels
    {
      preserveDrawingBuffer: true, // synchronous toDataURL reads
      stencil: false,
      powerPreference: "low-power",
    },
    false,
  );
  engine.setHardwareScalingLevel(1);

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.09, 0.09, 0.1, 1); // opaque dark gray
  scene.skipPointerMovePicking = true;

  // Even lighting from front and back so every yaw angle is usable
  const hemispheric = new HemisphericLight(
    "hemispheric",
    new Vector3(0, 1, 0),
    scene,
  );
  hemispheric.intensity = 0.55;
  hemispheric.diffuse = new Color3(1, 1, 1);
  hemispheric.groundColor = new Color3(0.35, 0.35, 0.38);

  const frontLight = new DirectionalLight(
    "frontLight",
    new Vector3(0.2, -1, -1).normalize(),
    scene,
  );
  frontLight.intensity = 0.5;
  const backLight = new DirectionalLight(
    "backLight",
    new Vector3(-0.2, -1, 1).normalize(),
    scene,
  );
  backLight.intensity = 0.5;

  // Fetch the PMX + all reference files. File names must be relative to
  // the PMX's directory (same semantics as PmxToBpmxConverter's
  // readDirectoryFiles + webkitRelativePath) so texture matching works.
  // Non-model files (archives, json, html…) are skipped.
  const modelFileExtensions = new Set([
    "pmx",
    "png",
    "jpg",
    "jpeg",
    "bmp",
    "tga",
    "spa",
    "sph",
    "dds",
  ]);
  const prefix = pmxRelPath.includes("/")
    ? pmxRelPath.substring(0, pmxRelPath.lastIndexOf("/") + 1)
    : "";
  log(`Fetching model files (root: ${prefix || "."})...`);
  const allFiles: File[] = [];
  for (const relPath of modelIndex.files) {
    if (!relPath.startsWith(prefix)) continue; // outside the PMX dir
    const localRel = relPath.slice(prefix.length);
    const ext = localRel.split(".").pop()?.toLowerCase() ?? "";
    if (!modelFileExtensions.has(ext)) continue;
    allFiles.push(await fetchFile(relPath, localRel, guessMimeType(localRel)));
  }
  const pmxBasename =
    prefix === "" ? pmxRelPath : pmxRelPath.slice(prefix.length);
  const pmxFile = allFiles.find((file) => file.name === pmxBasename) ?? null;
  if (pmxFile === null) {
    throw new Error(`PMX "${pmxRelPath}" not found in model index`);
  }

  const materialBuilder = new MmdStandardMaterialBuilder();
  materialBuilder.deleteTextureBufferAfterLoad = true;
  // CRITICAL: the default render method (DepthWriteAlphaBlendingWithEvaluation)
  // evaluates texture alpha via GPU readback at load time — which silently
  // fails under headless SwiftShader, marking alpha-textured meshes (hair!)
  // as OPAQUE. The hair then renders as a solid wall that covers the entire
  // face region. DepthWriteAlphaBlending is the MMD-faithful path with no
  // load-time evaluation dependency.
  materialBuilder.renderMethod =
    MmdMaterialRenderMethod.DepthWriteAlphaBlending;

  const rootUrl = pmxRelPath.includes("/")
    ? `/lab/file/${encodePathSegments(
        pmxRelPath.substring(0, pmxRelPath.lastIndexOf("/") + 1),
      )}`
    : "/lab/file/";

  log(`Loading PMX ${pmxRelPath}...`);
  const container = await LoadAssetContainerAsync(pmxFile, scene, {
    rootUrl,
    pluginOptions: {
      mmdmodel: {
        materialBuilder,
        buildSkeleton: true,
        buildMorph: true,
        boundingBoxMargin: 0,
        preserveSerializationData: false,
        referenceFiles: allFiles,
        loggingEnabled: false,
      },
    },
  });
  container.addAllToScene();

  const mmdMesh = container.meshes[0] as MmdMesh;

  const mmdRuntime = new MmdRuntime(scene);
  // REQUIRED: register() hooks the runtime's before/after-physics stage
  // into scene.onBeforeRenderObservable. Without it the MMD bone matrices
  // (worldTransformMatrices) are never prepared — skinned vertices then
  // collapse toward the model center (black triangles fanning to origin),
  // exactly the artifact the old ero.dance app never showed because it
  // always registers the runtime (sceneBuilder.ts:388).
  mmdRuntime.register(scene);
  const model = mmdRuntime.createMmdModel(mmdMesh, {
    buildPhysics: false,
    materialProxyConstructor: MmdStandardMaterialProxy,
  });

  // CRITICAL: Babylon's GPU morph target pipeline renders nothing under
  // headless SwiftShader (both attribute and texture mode). Detach every
  // morph target manager from its mesh and apply vertex morphs on the CPU
  // instead (see applyMorphWeights) — bone/material/group morphs keep
  // using the controller.
  cpuMorphMeshes.length = 0;
  targetToMeshIndex.clear();
  for (const manager of model.morph.morphTargetManagers) {
    const owner = container.meshes.find(
      (mesh) => mesh.morphTargetManager === manager,
    );
    if (owner === undefined) continue;
    const basePositions = owner.getVerticesData(
      VertexBuffer.PositionKind,
    ) as Float32Array | null;
    if (basePositions === null || basePositions.length === 0) {
      owner.morphTargetManager = null;
      continue;
    }
    const meshIndex = cpuMorphMeshes.length;
    cpuMorphMeshes.push({
      mesh: owner as Mesh,
      basePositions: basePositions.slice(),
    });
    for (let i = 0; i < manager.numTargets; i++) {
      const target = manager.getTarget(i);
      targetToMeshIndex.set(target, meshIndex);
    }
    owner.morphTargetManager = null;
  }
  log(
    `CPU morph mode: ${cpuMorphMeshes.length} meshes, ` +
      `${targetToMeshIndex.size} targets`,
  );

  // Union bounding box over all meshes that carry geometry
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const mesh of container.meshes) {
    if (mesh.getTotalVertices() === 0) continue;
    mesh.computeWorldMatrix(true);
    const bb = mesh.getBoundingInfo().boundingBox;
    const min = bb.minimumWorld;
    const max = bb.maximumWorld;
    minX = Math.min(minX, min.x);
    minY = Math.min(minY, min.y);
    minZ = Math.min(minZ, min.z);
    maxX = Math.max(maxX, max.x);
    maxY = Math.max(maxY, max.y);
    maxZ = Math.max(maxZ, max.z);
  }
  const min = new Vector3(minX, minY, minZ);
  const max = new Vector3(maxX, maxY, maxZ);
  const sizeX = max.x - min.x;
  const sizeY = max.y - min.y;
  const sizeZ = max.z - min.z;

  const camera = new ArcRotateCamera(
    "labCamera",
    Math.PI / 2,
    Math.PI / 2,
    10,
    new Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2),
    scene,
  );
  camera.fov = 0.8;
  camera.minZ = Math.max(sizeY / 1000, 0.05);
  camera.maxZ = sizeY * 50 + 100;
  camera.detachControl();
  camera.inputs.clear();

  const halfVertical = Math.tan(camera.fov / 2);
  const halfHorizontal = halfVertical * (CAPTURE_WIDTH / CAPTURE_HEIGHT);
  const radiusVertical = sizeY / 2 / halfVertical;
  const radiusHorizontal = Math.max(sizeX, sizeZ) / 2 / halfHorizontal;
  const baseRadius = Math.max(radiusVertical, radiusHorizontal) * 1.1;

  session = {
    engine,
    scene,
    camera,
    mmdRuntime,
    model,
    min,
    max,
    baseRadius,
    debugLogs: modelIndex.debug === true,
  };

  // Warm up: compile shaders, upload textures, apply default morph state.
  // The explicit readiness wait is REQUIRED under SwiftShader — the first
  // render starts async shader compilation and may draw nothing; captures
  // only become valid once the scene reports ready.
  applyMorphWeights([]);
  applyView(DEFAULT_VIEW);
  renderFrame();
  await new Promise<void>((resolve) => scene.executeWhenReady(resolve));
  renderFrame();

  if (modelIndex.debug === true) {
    // Isolation test: does a hand-rolled Babylon MorphTarget apply at
    // all under SwiftShader? (Cube + skewed positions + manager)
    const { MeshBuilder: MB } =
      await import("@babylonjs/core/Meshes/meshBuilder");
    const { MorphTarget: MT } =
      await import("@babylonjs/core/Morph/morphTarget");
    const { MorphTargetManager: MTM } =
      await import("@babylonjs/core/Morph/morphTargetManager");
    const { StandardMaterial: SM } =
      await import("@babylonjs/core/Materials/standardMaterial");
    const { VertexBuffer } = await import("@babylonjs/core/Buffers/buffer");

    const cube = MB.CreateBox("morphCube", { size: sizeY * 0.25 }, scene);
    const cubeMaterial = new SM("morphCubeMat", scene);
    cubeMaterial.diffuseColor = new Color3(0, 1, 0);
    cubeMaterial.emissiveColor = new Color3(0.2, 0.9, 0.2);
    cube.material = cubeMaterial;
    cube.position.set(max.x + sizeY * 0.4, (min.y + max.y) / 2, 0);

    const basePositions = cube
      .getVerticesData(VertexBuffer.PositionKind)
      ?.slice();
    if (basePositions !== undefined) {
      const morphed = basePositions.slice();
      for (let i = 0; i < morphed.length; i += 3) {
        morphed[i]! += sizeY * 0.08; // skew +X
      }
      const target = new MT("cubeShift", 0);
      target.setPositions(morphed);
      const cubeManager = new MTM(scene);
      cubeManager.addTarget(target);
      cube.morphTargetManager = cubeManager;

      renderFrame();
      const before = await decodePngToRgba(captureScreenshot());
      target.influence = 1;
      renderFrame();
      renderFrame();
      const after = await decodePngToRgba(captureScreenshot());
      const cubeDiff = computeDiffMetrics(
        before,
        after,
        CAPTURE_WIDTH,
        CAPTURE_HEIGHT,
      );
      log(
        `CUBE MORPH TEST: changedPixels=${cubeDiff.changedPixels} visible=${cubeDiff.visible}`,
      );
    }
    cube.setEnabled(false);
  }

  if (modelIndex.debug === true) {
    const { MeshBuilder } = await import("@babylonjs/core/Meshes/meshBuilder");
    const { StandardMaterial } =
      await import("@babylonjs/core/Materials/standardMaterial");
    const box = MeshBuilder.CreateBox(
      "debugBox",
      { size: sizeY * 0.25 },
      scene,
    );
    const boxMaterial = new StandardMaterial("debugBoxMat", scene);
    boxMaterial.diffuseColor = new Color3(1, 0, 0);
    boxMaterial.emissiveColor = new Color3(1, 0.2, 0.2);
    box.material = boxMaterial;
    box.position.set(
      (min.x + max.x) / 2,
      (min.y + max.y) / 2,
      (min.z + max.z) / 2 + sizeY * 0.3,
    );
    renderFrame();
    log("debug box added");
  }

  const morphs = model.morph.morphs.map((morph, index) => ({
    index,
    name: morph.name,
  }));

  let geometryMeshCount = 0;
  for (const mesh of container.meshes) {
    if (mesh.getTotalVertices() > 0) geometryMeshCount += 1;
  }

  log(
    `Model loaded: ${morphs.length} morphs, height ${sizeY.toFixed(2)}, ` +
      `bounds min=${min.toString()} max=${max.toString()}, ` +
      `radius=${baseRadius.toFixed(2)}, ` +
      `meshes ${geometryMeshCount}/${container.meshes.length}, ` +
      `materials ${scene.materials.length}`,
  );

  return {
    morphs,
    morphCount: morphs.length,
    modelHeight: sizeY,
    boundsMin: [min.x, min.y, min.z],
    boundsMax: [max.x, max.y, max.z],
    geometryMeshCount,
    totalMeshCount: container.meshes.length,
    materialCount: scene.materials.length,
  };
}

async function executeTestMorph(command: {
  targetIndex: number;
  weight: number;
  prerequisites: readonly MorphWeight[];
  view: ViewSpec;
  resolution?: number;
}): Promise<unknown> {
  if (session === null) throw new Error("No model loaded");

  // Per-capture render scale: the AI may request a higher resolution
  // (1|2|4) when fine detail would drown at the base capture size.
  const resolution = Math.max(
    1,
    Math.min(4, Math.round(command.resolution ?? 1)),
  );
  const captureWidth = CAPTURE_WIDTH * resolution;
  const captureHeight = CAPTURE_HEIGHT * resolution;

  applyView(command.view);

  session.engine.setHardwareScalingLevel(1 / resolution);
  try {
    // Before: baseline + prerequisite morphs
    applyMorphWeights(command.prerequisites);
    renderFrame();
    const beforeUrl = captureScreenshot();

    // After: additionally activate the target morph (via applyMorphWeights
    // so the CPU vertex path is used)
    applyMorphWeights([
      ...command.prerequisites,
      { index: command.targetIndex, weight: command.weight },
    ]);
    renderFrame();
    const afterUrl = captureScreenshot();

    const beforeRgba = await decodePngToRgba(
      beforeUrl,
      captureWidth,
      captureHeight,
    );
    const afterRgba = await decodePngToRgba(
      afterUrl,
      captureWidth,
      captureHeight,
    );
    const diff = computeDiffMetrics(
      beforeRgba,
      afterRgba,
      captureWidth,
      captureHeight,
    );

    // Restore pristine baseline for the next test
    applyMorphWeights([]);
    renderFrame();

    return {
      beforePng: dataUrlToBase64(beforeUrl),
      afterPng: dataUrlToBase64(afterUrl),
      diff,
      view: command.view,
      width: captureWidth,
      height: captureHeight,
    };
  } finally {
    session.engine.setHardwareScalingLevel(1);
  }
}

async function executeCaptureBase(view: ViewSpec): Promise<unknown> {
  if (session === null) throw new Error("No model loaded");
  applyMorphWeights([]);
  applyView(view);
  renderFrame();
  const url = captureScreenshot();
  return { png: dataUrlToBase64(url) };
}

/**
 * Per-mesh diagnostic: distorts ONE tracked mesh at a time through the
 * setVerticesData route and reports how many pixels each mesh's buffer
 * change actually alters the render. Reveals meshes whose position
 * buffers the renderer ignores (e.g. skinned/GPU-override paths).
 */
async function executeDebugDistortMeshes(
  scale: number,
  view: ViewSpec,
): Promise<unknown> {
  if (session === null) throw new Error("No model loaded");
  applyMorphWeights([]);
  applyView(view);
  renderFrame();
  const beforeUrl = captureScreenshot();
  const beforeRgba = await decodePngToRgba(beforeUrl);

  const entries: Array<{
    meshIndex: number;
    meshName: string;
    vertexCount: number;
    changedPixels: number;
    enabled: boolean;
    visible: boolean;
    alpha: number;
    inActiveMeshes: boolean;
    worldMinY: number;
    worldMaxY: number;
    skeletonName: string;
    boneCount: number;
    managerAttached: boolean;
  }> = [];

  const activeList = session.scene.getActiveMeshes();
  const activeMeshes = new Set<unknown>(
    Array.isArray(activeList) ? activeList : [],
  );

  for (let i = 0; i < cpuMorphMeshes.length; i++) {
    const meshData = cpuMorphMeshes[i]!;
    const positions = meshData.basePositions.slice();
    for (let j = 0; j < positions.length; j++) {
      positions[j] = positions[j]! * scale + 2;
    }
    meshData.mesh.geometry?.setVerticesData(
      VertexBuffer.PositionKind,
      positions,
      false,
    );
    renderFrame();
    const afterUrl = captureScreenshot();
    const afterRgba = await decodePngToRgba(afterUrl);
    const diff = computeDiffMetrics(
      beforeRgba,
      afterRgba,
      CAPTURE_WIDTH,
      CAPTURE_HEIGHT,
    );
    // Restore immediately
    meshData.mesh.geometry?.setVerticesData(
      VertexBuffer.PositionKind,
      meshData.basePositions,
      false,
    );
    renderFrame();
    entries.push({
      meshIndex: i,
      meshName: meshData.mesh.name,
      vertexCount: meshData.basePositions.length / 3,
      changedPixels: diff.changedPixels,
      enabled: meshData.mesh.isEnabled(),
      visible: meshData.mesh.isVisible,
      alpha: meshData.mesh.visibility,
      inActiveMeshes: activeMeshes.has(meshData.mesh),
      worldMinY: meshData.mesh.getBoundingInfo().boundingBox.minimumWorld.y,
      worldMaxY: meshData.mesh.getBoundingInfo().boundingBox.maximumWorld.y,
      skeletonName: meshData.mesh.skeleton?.name ?? "(none)",
      boneCount: meshData.mesh.skeleton?.bones.length ?? 0,
      managerAttached: meshData.mesh.morphTargetManager !== null,
    });
  }

  log(
    `  dbg distort-meshes: ${entries
      .map(
        (e) =>
          `${e.meshName}=${e.changedPixels}px` +
          `(mgr=${e.managerAttached ? "ATTACHED" : "detached"})`,
      )
      .join(", ")}`,
  );
  return { entries };
}

/**
 * Toggles EVERY scene mesh (with geometry) once and reports how many
 * pixels each contributes in the full render — the occluder map.
 */
async function executeDebugToggleAll(view: ViewSpec): Promise<unknown> {
  if (session === null) throw new Error("No model loaded");
  const candidates = session.scene.meshes.filter(
    (m) =>
      m.getTotalVertices() > 0 &&
      m.name !== "debugBox" &&
      m.name !== "morphProbeCube" &&
      m.name !== "labCamera",
  );

  applyMorphWeights([]);
  applyView(view);
  renderFrame();
  const beforeUrl = captureScreenshot();
  const beforeRgba = await decodePngToRgba(beforeUrl);

  const entries: Array<{
    meshName: string;
    changedPixels: number;
    vertexCount: number;
  }> = [];
  for (const mesh of candidates) {
    mesh.setEnabled(false);
    renderFrame();
    const afterUrl = captureScreenshot();
    mesh.setEnabled(true);
    const afterRgba = await decodePngToRgba(afterUrl);
    const diff = computeDiffMetrics(
      beforeRgba,
      afterRgba,
      CAPTURE_WIDTH,
      CAPTURE_HEIGHT,
    );
    entries.push({
      meshName: mesh.name,
      changedPixels: diff.changedPixels,
      vertexCount: mesh.getTotalVertices(),
    });
  }
  renderFrame();

  entries.sort((a, b) => b.changedPixels - a.changedPixels);
  log(
    `  dbg toggle-all: ${entries
      .map((e) => `${e.meshName}=${e.changedPixels}px`)
      .join(", ")}`,
  );
  return { entries };
}

/**
 * Full-scene toggle diagnostic: renders the complete scene, then the same
 * scene with exactly ONE tracked mesh disabled, and diffs. Reveals whether
 * a mesh contributes any visible pixels in the full render (vs. being
 * overdrawn/occluded by other meshes).
 */
async function executeDebugToggleMesh(
  meshIndex: number,
  view: ViewSpec,
): Promise<unknown> {
  if (session === null) throw new Error("No model loaded");
  const target = cpuMorphMeshes[meshIndex];
  if (target === undefined) throw new Error(`Unknown mesh index ${meshIndex}`);

  applyMorphWeights([]);
  applyView(view);
  target.mesh.setEnabled(true);
  renderFrame();
  const beforeUrl = captureScreenshot();

  target.mesh.setEnabled(false);
  renderFrame();
  const afterUrl = captureScreenshot();
  target.mesh.setEnabled(true);
  renderFrame();

  const beforeRgba = await decodePngToRgba(beforeUrl);
  const afterRgba = await decodePngToRgba(afterUrl);
  const diff = computeDiffMetrics(
    beforeRgba,
    afterRgba,
    CAPTURE_WIDTH,
    CAPTURE_HEIGHT,
  );
  log(`  dbg toggle ${target.mesh.name}: removedPixels=${diff.changedPixels}`);
  return {
    beforePng: dataUrlToBase64(beforeUrl),
    afterPng: dataUrlToBase64(afterUrl),
    diff,
    meshName: target.mesh.name,
  };
}

/**
 * Renders exactly ONE tracked mesh in isolation (everything else disabled)
 * and returns the capture — decisive test for "does this mesh render at all".
 */
async function executeDebugSoloMesh(
  meshIndex: number,
  view: ViewSpec,
): Promise<unknown> {
  if (session === null) throw new Error("No model loaded");
  const target = cpuMorphMeshes[meshIndex];
  if (target === undefined) throw new Error(`Unknown mesh index ${meshIndex}`);

  const states = cpuMorphMeshes.map((m) => m.mesh.isEnabled());
  const allMeshes = session.scene.meshes.filter(
    (m) => m.name !== "debugBox" && m.name !== "morphProbeCube",
  );
  // Never disable the target or any of its ancestors — disabling a parent
  // kills the whole subtree regardless of the child's own flag
  const keepEnabled = new Set<AbstractMesh>();
  for (let node: Nullable<AbstractMesh> = target.mesh; node !== null; ) {
    keepEnabled.add(node);
    node = node.parent as Nullable<AbstractMesh>;
  }
  const allStates = allMeshes.map((m) => m.isEnabled());
  for (const m of allMeshes) {
    if (!keepEnabled.has(m)) m.setEnabled(false);
  }
  target.mesh.setEnabled(true);

  // Material diagnostics: is the mesh's material transparent / alpha-0?
  const materials = target.mesh.material
    ? [target.mesh.material]
    : target.mesh.subMeshes
        .map((sm) => sm.getMaterial())
        .filter((mat): mat is Material => mat !== null);
  const materialInfo = materials.map(
    (mat) =>
      `alpha=${mat.alpha.toFixed(3)},needBlend=${mat.needAlphaBlending().toString()}`,
  );

  applyMorphWeights([]);
  applyView(view);
  renderFrame();
  const urlNormal = captureScreenshot();
  const activeAfterRender =
    session.scene.getActiveMeshes().indexOf(target.mesh) !== -1;

  // Force alpha=1 and render again — does the mesh appear?
  const savedAlphas = materials.map((mat) => mat.alpha);
  for (const mat of materials) mat.alpha = 1;
  renderFrame();
  const urlForced = captureScreenshot();
  for (let i = 0; i < materials.length; i++) {
    materials[i]!.alpha = savedAlphas[i]!;
  }

  for (let i = 0; i < allMeshes.length; i++) {
    if (allStates[i]) allMeshes[i]!.setEnabled(true);
  }
  void states;
  renderFrame();

  const frustumPlanes = Frustum.GetPlanes(
    session.camera.getTransformationMatrix(),
  );

  log(
    `  dbg solo ${target.mesh.name}: materials=[${materialInfo.join(" | ")}] ` +
      `subMeshes=${target.mesh.subMeshes.length} ` +
      `indices=${target.mesh.getTotalIndices()} ` +
      `vertices=${target.mesh.getTotalVertices()} ` +
      `inFrustum=${target.mesh.isInFrustum(frustumPlanes) ? "yes" : "no"} ` +
      `activeAfterRender=${activeAfterRender ? "yes" : "no"} ` +
      `layerMask=${target.mesh.layerMask.toString(16)} cam=${session.camera.layerMask.toString(16)} ` +
      `inSceneMeshes=${session.scene.meshes.includes(target.mesh) ? "yes" : "no"} ` +
      `parent=${target.mesh.parent?.name ?? "(none)"}`,
  );
  return {
    png: dataUrlToBase64(urlNormal),
    forcedPng: dataUrlToBase64(urlForced),
    meshName: target.mesh.name,
    materialInfo,
  };
}

/**
 * Decisive diagnostics for the CPU morph path:
 *  1. Distorts ALL tracked mesh positions through the exact same
 *     setVerticesData route and diffs the renders — proves/disproves that
 *     CPU-written buffers reach the GPU under SwiftShader.
 *  2. Reports max |target - base| across every loaded morph target —
 *     proves/disproves that targets carry real morph data (vs. placeholders
 *     identical to the base positions).
 */
async function executeDebugDistort(scale: number): Promise<unknown> {
  if (session === null) throw new Error("No model loaded");
  applyMorphWeights([]);
  renderFrame();
  const beforeUrl = captureScreenshot();

  let maxTargetDelta = 0;
  for (const [target, meshIndex] of targetToMeshIndex) {
    const targetPositions = target.getPositions();
    if (targetPositions === null) continue;
    const base = cpuMorphMeshes[meshIndex]!.basePositions;
    const length = Math.min(targetPositions.length, base.length);
    for (let i = 0; i < length; i++) {
      const delta = Math.abs(targetPositions[i]! - base[i]!);
      if (delta > maxTargetDelta) maxTargetDelta = delta;
    }
  }

  for (const meshData of cpuMorphMeshes) {
    const positions = meshData.basePositions.slice();
    for (let i = 0; i < positions.length; i++) {
      positions[i] = positions[i]! * scale + 2; // scale + hard offset
    }
    meshData.mesh.geometry?.setVerticesData(
      VertexBuffer.PositionKind,
      positions,
      false,
    );
  }
  renderFrame();
  const afterUrl = captureScreenshot();

  // Restore pristine positions
  for (const meshData of cpuMorphMeshes) {
    meshData.mesh.geometry?.setVerticesData(
      VertexBuffer.PositionKind,
      meshData.basePositions,
      false,
    );
  }
  renderFrame();

  const beforeRgba = await decodePngToRgba(beforeUrl);
  const afterRgba = await decodePngToRgba(afterUrl);
  const diff = computeDiffMetrics(
    beforeRgba,
    afterRgba,
    CAPTURE_WIDTH,
    CAPTURE_HEIGHT,
  );
  log(
    `  dbg distort: visible=${diff.visible} changedPixels=${diff.changedPixels} maxTargetDelta=${maxTargetDelta.toFixed(4)}`,
  );
  return {
    beforePng: dataUrlToBase64(beforeUrl),
    afterPng: dataUrlToBase64(afterUrl),
    diff,
    maxTargetDelta,
  };
}

// ── Bootstrap + poll loop ────────────────────────────────────────────────────

async function postJson(url: string, body: unknown): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.error(`[morphlab] POST ${url} failed`, err);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export async function runMorphLab(modelIndex: ModelIndex): Promise<void> {
  // Bootstrap creates the engine AND loads the model, then reports
  // readiness including the load result. Morphs are applied on the CPU
  // (Babylon's GPU morph pipeline doesn't render under SwiftShader), so
  // the page stays alive for the whole session.
  try {
    const probeCanvas = document.createElement("canvas");
    const gl =
      probeCanvas.getContext("webgl2") ?? probeCanvas.getContext("webgl");
    if (gl === null) {
      throw new Error("WebGL context unavailable (SwiftShader?)");
    }
    const versionString = gl.getParameter(gl.VERSION) as string;
    const webglVersion = versionString.includes("WebGL 2") ? 2 : 1;

    const load = (await executeLoad(
      modelIndex,
      modelIndex.pmxRelPath,
    )) as LoadResult;

    await postJson("/lab/ready", {
      ok: true,
      webglVersion,
      load,
    });
  } catch (err) {
    await postJson("/lab/ready", {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let seq = 0;
  for (;;) {
    let command: LabCommand | { type: "noop" };
    try {
      const response = await fetch(`/lab/poll?seq=${seq}`);
      if (!response.ok) {
        throw new Error(`Poll failed: HTTP ${response.status}`);
      }
      command = (await response.json()) as LabCommand | { type: "noop" };
    } catch (err) {
      console.error("[morphlab] poll error, retrying", err);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (command.type === "noop") continue;

    if (command.type === "shutdown") {
      await postJson("/lab/report", {
        id: command.seq,
        ok: true,
        result: null,
      });
      log("Shutting down poll loop");
      break;
    }

    seq = command.seq;
    log(`Command: ${command.type}`);

    try {
      let result: unknown;
      switch (command.type) {
        case "load":
          throw new Error("load is done automatically at page bootstrap");
        case "testMorph":
          result = await executeTestMorph(command);
          break;
        case "captureBase":
          result = await executeCaptureBase(command.view);
          break;
        case "debugDistort":
          result = await executeDebugDistort(command.scale);
          break;
        case "debugDistortMeshes":
          result = await executeDebugDistortMeshes(
            command.scale,
            command.view ??
              ({
                yawDeg: 0,
                pitchDeg: 0,
                distanceFactor: 0.3,
                targetYFactor: 0.9,
              } satisfies ViewSpec),
          );
          break;
        case "debugSoloMesh":
          result = await executeDebugSoloMesh(command.meshIndex, command.view);
          break;
        case "debugToggleMesh":
          result = await executeDebugToggleMesh(
            command.meshIndex,
            command.view,
          );
          break;
        case "debugToggleAll":
          result = await executeDebugToggleAll(command.view);
          break;
      }
      await postJson("/lab/report", {
        id: command.seq,
        ok: true,
        result,
      });
    } catch (err) {
      console.error(`[morphlab] ${command.type} failed`, err);
      await postJson("/lab/report", {
        id: command.seq,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
