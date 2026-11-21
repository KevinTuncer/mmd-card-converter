/**
 * Shared protocol types for the Morph-AI Lab.
 *
 * These types are used by BOTH sides:
 *  - `src/app/morphlab/MorphLabPage.ts` (browser page, served through Vite)
 *  - `workspace/morph-lab/lib/*` + `cli.ts` (Bun CLI side)
 *
 * Keep this module free of runtime dependencies so it can be imported
 * from the browser (via Vite) and from Bun (via relative path) alike.
 */

// ── View control ─────────────────────────────────────────────────────────────

/**
 * Camera view specification for captures.
 *
 * All values are relative to the model's bounding box:
 *  - `yawDeg`:          0 = front view, 90 = side view, 180 = back view.
 *  - `pitchDeg`:        0 = horizontal view, positive = camera above.
 *  - `distanceFactor`:  1 = default full-body framing, < 1 = closer.
 *  - `targetYFactor`:   camera target height as a fraction of model height
 *                       (0 = feet, 0.5 = mid-body, ~0.9 = face).
 */
export interface ViewSpec {
  readonly yawDeg?: number;
  readonly pitchDeg?: number;
  readonly distanceFactor?: number;
  /** Vertical capture target, normalized over the model's Y bounds
   *  (0 = feet / bbox bottom, 1 = head / bbox top). */
  readonly targetYFactor?: number;
  /** Horizontal capture target, normalized over the model's X bounds
   *  (0 = bbox left, 0.5 = body center, 1 = bbox right). Lets a close-up
   *  frame off-center regions like one hand — without it the camera
   *  always aims at the body center and hands hang out of frame
   *  (observed: hand close-ups at targetX=0 captured px=0). */
  readonly targetXFactor?: number;
}

/** Default view (front, horizontal, full-body framing, mid-body target). */
export const DEFAULT_VIEW: ViewSpec = {};

// ── Capture / diff ───────────────────────────────────────────────────────────

/** Capture resolution (portrait orientation, matches card aspect ~3:4). */
export const CAPTURE_WIDTH = 512;
export const CAPTURE_HEIGHT = 640;

/** Per-pixel delta threshold (any channel) for the analytic diff. */
export const DIFF_PIXEL_DELTA_THRESHOLD = 10;

/**
 * Minimum ratio of changed pixels for a morph to count as "visibly
 * effective", CALIBRATED AT THE BASE CAPTURE SIZE (512×640). Higher
 * render scales get an area-compensated bar (see `diff.ts`) so raising
 * the resolution actually helps fine detail pass. SwiftShader rendering
 * is deterministic, so real morph changes can be detected well below
 * noisy-GPU thresholds.
 */
export const VISIBLE_CHANGE_RATIO = 0.00008;

/**
 * Minimum number of changed pixels (in addition to the ratio) — guards
 * against single-pixel dithering artifacts.
 */
export const MIN_CHANGED_PIXELS = 12;

/** Axis-aligned bounding box of changed pixels (inclusive pixel coords). */
export interface DiffBBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface DiffMetrics {
  /** Ratio of pixels whose delta exceeds `DIFF_PIXEL_DELTA_THRESHOLD` (0..1). */
  readonly changedRatio: number;
  /** Absolute number of changed pixels. */
  readonly changedPixels: number;
  /** Mean absolute delta over all pixels and channels (0..255). */
  readonly meanDelta: number;
  /** Bounding box around changed pixels; `null` when nothing changed. */
  readonly bbox: DiffBBox | null;
  /** Whether the change exceeds `VISIBLE_CHANGE_RATIO` AND `MIN_CHANGED_PIXELS`. */
  readonly visible: boolean;
}

// ── Commands (CLI → page) ────────────────────────────────────────────────────

export interface MorphWeight {
  readonly index: number;
  readonly weight: number;
}

export interface LoadCommand {
  readonly type: "load";
  readonly seq: number;
  /** Optional PMX override; the page falls back to the embedded index. */
  readonly pmxRelPath?: string;
}

export interface TestMorphCommand {
  readonly type: "testMorph";
  readonly seq: number;
  readonly targetIndex: number;
  readonly weight: number;
  /** Morphs to activate in the "before" state (e.g. undress morphs). */
  readonly prerequisites: readonly MorphWeight[];
  readonly view: ViewSpec;
  /** Render-scale multiplier for this capture only (1|2|4). 2 = 1024×1280
   *  pixels — the AI asks for it when fine detail (body hair, fingers,
   *  genitalia) would drown at base resolution. */
  readonly resolution?: number;
}

export interface CaptureBaseCommand {
  readonly type: "captureBase";
  readonly seq: number;
  readonly view: ViewSpec;
}

export interface DebugDistortCommand {
  readonly type: "debugDistort";
  readonly seq: number;
  /** Uniform position scale for the distortion experiment (e.g. 1.5). */
  readonly scale: number;
}

export interface DebugDistortMeshesCommand {
  readonly type: "debugDistortMeshes";
  readonly seq: number;
  /** Uniform position scale applied to ONE mesh at a time. */
  readonly scale: number;
  /** View to run the diagnostic at (default: face closeup). */
  readonly view?: ViewSpec;
}

export interface DebugSoloMeshCommand {
  readonly type: "debugSoloMesh";
  readonly seq: number;
  /** Index into the tracked CPU-morph mesh list. */
  readonly meshIndex: number;
  readonly view: ViewSpec;
}

export interface DebugToggleMeshCommand {
  readonly type: "debugToggleMesh";
  readonly seq: number;
  /** Index into the tracked CPU-morph mesh list. */
  readonly meshIndex: number;
  readonly view: ViewSpec;
}

export interface DebugToggleAllCommand {
  readonly type: "debugToggleAll";
  readonly seq: number;
  readonly view: ViewSpec;
}
export interface ShutdownCommand {
  readonly type: "shutdown";
  readonly seq: number;
}
export type LabCommand =
  | LoadCommand
  | TestMorphCommand
  | CaptureBaseCommand
  | DebugDistortCommand
  | DebugDistortMeshesCommand
  | DebugSoloMeshCommand
  | DebugToggleMeshCommand
  | DebugToggleAllCommand
  | ShutdownCommand;

/** `Omit` that distributes over the union (per-member, not common keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A command without its server-assigned sequence number. */
export type LabCommandRequest = DistributiveOmit<LabCommand, "seq">;

/** Long-poll result when no command is available in time. */
export interface NoopPoll {
  readonly type: "noop";
}

// ── Reports (page → CLI) ─────────────────────────────────────────────────────

export interface MorphEntry {
  readonly index: number;
  readonly name: string;
}

export interface LoadResult {
  readonly morphs: readonly MorphEntry[];
  readonly morphCount: number;
  /** Model height in world units (for context). */
  readonly modelHeight: number;
  /** Diagnostic: world-space bounding box minimum [x,y,z]. */
  readonly boundsMin: readonly [number, number, number];
  /** Diagnostic: world-space bounding box maximum [x,y,z]. */
  readonly boundsMax: readonly [number, number, number];
  /** Diagnostic: meshes with geometry / total meshes in the container. */
  readonly geometryMeshCount: number;
  readonly totalMeshCount: number;
  /** Diagnostic: scene material count. */
  readonly materialCount: number;
}

export interface TestMorphResult {
  /** PNG bytes as base64 (no data: prefix). */
  readonly beforePng: string;
  readonly afterPng: string;
  readonly diff: DiffMetrics;
  readonly view: ViewSpec;
  /** Actual capture dimensions (CAPTURE_* × resolution). */
  readonly width: number;
  readonly height: number;
}

export interface CaptureBaseResult {
  /** PNG bytes as base64 (no data: prefix). */
  readonly png: string;
}

export interface DebugDistortResult {
  readonly beforePng: string;
  readonly afterPng: string;
  readonly diff: DiffMetrics;
  /** Max |target - base| over all currently loaded vertex morph targets. */
  readonly maxTargetDelta: number;
}

/** Per-mesh visibility map from the distort-meshes diagnostic. */
export interface MeshVisibilityEntry {
  readonly meshIndex: number;
  readonly meshName: string;
  readonly vertexCount: number;
  readonly changedPixels: number;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly alpha: number;
  readonly inActiveMeshes: boolean;
  readonly worldMinY: number;
  readonly worldMaxY: number;
  readonly skeletonName: string;
  readonly boneCount: number;
  readonly managerAttached: boolean;
}

export interface DebugSoloMeshResult {
  /** PNG bytes as base64 (no data: prefix). */
  readonly png: string;
  /** Second capture with material.alpha forced to 1 (base64 PNG). */
  readonly forcedPng: string;
  readonly meshName: string;
  readonly materialInfo: readonly string[];
}

export interface LabReport {
  readonly id: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly result?: unknown;
}

export interface LoadReport extends LabReport {
  readonly result?: LoadResult;
}

export interface TestMorphReport extends LabReport {
  readonly result?: TestMorphResult;
}

// ── Model index (embedded into the runner HTML) ──────────────────────────────

export interface ModelIndex {
  /** Relative path of the chosen PMX (POSIX separators). */
  readonly pmxRelPath: string;
  /** All files of the model folder (recursive, POSIX separators). */
  readonly files: readonly string[];
  /** Debug mode: adds a visible test box to the scene. */
  readonly debug?: boolean;
}
