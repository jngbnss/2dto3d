/**
 * Core CAD document model.
 *
 * Invariants:
 *  - All lengths are stored in MILLIMETRES. Display units are converted at the UI
 *    boundary only (see `units.ts`). 1 internal unit === 1 mm === 1 three.js unit.
 *  - Angles are stored in DEGREES, applied as an intrinsic XYZ Euler.
 *  - A `Feature` describes geometry in the object's LOCAL frame. It is the
 *    parametric truth. `Transform` only places that geometry in the world; it
 *    never changes the geometry itself.
 *  - Solids therefore have NO scale: resizing a solid means editing feature
 *    parameters and rebuilding in the kernel. Only meshes carry a scale, which is
 *    explicitly a non-parametric visual/mesh operation.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface Transform {
  /** Position of the object's local origin, in mm, world frame. */
  position: Vec3;
  /** Intrinsic XYZ Euler rotation, in degrees. */
  rotation: Vec3;
}

export const IDENTITY: Transform = Object.freeze({
  position: [0, 0, 0] as Vec3,
  rotation: [0, 0, 0] as Vec3,
});

/* ------------------------------------------------------------------ features */

export type PlaneName = "XY" | "XZ" | "YZ";

/** A closed 2D profile, in the sketch plane's local 2D coordinates (mm). */
export type Profile =
  | { type: "rect"; width: number; height: number; cornerRadius?: number }
  | { type: "circle"; radius: number }
  | { type: "polygon"; points: Vec2[] }
  | { type: "regular"; sides: number; radius: number };

export interface HoleSpec {
  id: string;
  /** Hole axis origin in the parent solid's local frame (mm). */
  position: Vec3;
  /** Axis direction; normalised by the kernel. */
  direction: Vec3;
  diameter: number;
  /** Depth in mm, or `"through"` to cut all the way through the body. */
  depth: number | "through";
  /** Optional countersink/counterbore at the hole mouth. */
  counterbore?: { diameter: number; depth: number };
}

export type BooleanOp = "union" | "cut" | "intersect";

/**
 * A recipe is a feature plus the placement of that feature. Boolean operands are
 * recipes, which is what makes the history tree re-editable: changing a leaf
 * parameter rebuilds every ancestor.
 */
export interface SolidRecipe {
  feature: Feature;
  transform: Transform;
}

export type Feature =
  | { type: "box"; width: number; depth: number; height: number }
  | { type: "cylinder"; radius: number; height: number }
  | { type: "sphere"; radius: number }
  | { type: "cone"; bottomRadius: number; topRadius: number; height: number }
  | { type: "extrude"; plane: PlaneName; profile: Profile; distance: number; twistAngle?: number }
  | { type: "revolve"; plane: PlaneName; profile: Profile; angle: number }
  | { type: "boolean"; op: BooleanOp; operands: SolidRecipe[] }
  | { type: "hole"; base: SolidRecipe; holes: HoleSpec[] }
  | { type: "fillet"; base: SolidRecipe; radius: number }
  | { type: "chamfer"; base: SolidRecipe; distance: number }
  | { type: "imported-step"; assetId: string };

export type FeatureType = Feature["type"];

export const PRIMITIVE_TYPES = ["box", "cylinder", "sphere", "cone"] as const;
export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

export function isPrimitive(f: Feature): boolean {
  return (PRIMITIVE_TYPES as readonly string[]).includes(f.type);
}

/* ------------------------------------------------------------------- objects */

export type ObjectKind = "solid" | "mesh" | "group";

/** What the editor is actually allowed to do to an object. Drives UI gating. */
export interface Capabilities {
  /** True B-rep solid: parametric dimensions, booleans, fillets, STEP export. */
  parametric: boolean;
  booleans: boolean;
  stepExport: boolean;
  /** Non-parametric mesh scaling (visual / vertex scaling only). */
  meshScale: boolean;
}

export const SOLID_CAPS: Capabilities = Object.freeze({
  parametric: true, booleans: true, stepExport: true, meshScale: false,
});
export const MESH_CAPS: Capabilities = Object.freeze({
  parametric: false, booleans: false, stepExport: false, meshScale: true,
});
export const GROUP_CAPS: Capabilities = Object.freeze({
  parametric: false, booleans: false, stepExport: false, meshScale: false,
});

interface ObjectBase {
  id: string;
  name: string;
  parentId: string | null;
  visible: boolean;
  color: string;
  /** Monotonic order within the parent, for a stable tree. */
  order: number;
}

export interface SolidObject extends ObjectBase, SolidRecipe {
  kind: "solid";
}

export type MeshOrigin = "import-stl" | "import-glb" | "ai-generated" | "tessellated";

export interface MeshObject extends ObjectBase {
  kind: "mesh";
  transform: Transform;
  /** Non-parametric scale factor per axis. Mesh-only. */
  scale: Vec3;
  assetId: string;
  origin: MeshOrigin;
  /** Provenance shown to the user so mesh is never mistaken for CAD solid. */
  provenance?: { source: string; note?: string };
}

export interface GroupObject extends ObjectBase {
  kind: "group";
  transform: Transform;
  collapsed?: boolean;
}

export type CadObject = SolidObject | MeshObject | GroupObject;

export function capsOf(o: CadObject): Capabilities {
  return o.kind === "solid" ? SOLID_CAPS : o.kind === "mesh" ? MESH_CAPS : GROUP_CAPS;
}

/* ------------------------------------------------------------------- assets */

/**
 * Triangle-soup asset backing a MeshObject. Positions are mm.
 *
 * Typed arrays, not plain arrays: an AI-generated mesh is routinely hundreds of
 * thousands of triangles, and these buffers go straight into three.js
 * BufferAttributes without a copy. The project file stores them base64-encoded.
 */
export interface MeshAsset {
  id: string;
  name: string;
  positions: Float32Array;
  /** Optional; recomputed by three.js when absent. */
  normals?: Float32Array;
  /** Optional; the mesh is non-indexed when absent. */
  indices?: Uint32Array;
  triangleCount: number;
}

/* ----------------------------------------------------------------- document */

export const PROJECT_FORMAT = "webcad-project";
export const PROJECT_VERSION = 3;

export interface CadDocument {
  format: typeof PROJECT_FORMAT;
  version: number;
  name: string;
  /** Internal unit is always mm; this is the unit shown in the UI. */
  displayUnit: UnitName;
  objects: Record<string, CadObject>;
  /** Root-level ordering + group membership is derived from parentId/order. */
  assets: Record<string, MeshAsset>;
  /** Append-only log of geometry operations, for the project file. */
  operationLog: OperationLogEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface OperationLogEntry {
  id: string;
  at: number;
  op: string;
  detail: string;
  objectIds: string[];
}

export type UnitName = "mm" | "cm" | "m" | "in";

/* ------------------------------------------------------------------ results */

/** Tessellated output of the kernel for one solid. Buffers are in mm. */
export interface TessellationResult {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Flat line-segment pairs for B-rep edge display. */
  edges: Float32Array;
  volume: number;
  area: number;
  bbox: { min: Vec3; max: Vec3 };
  triangleCount: number;
}
