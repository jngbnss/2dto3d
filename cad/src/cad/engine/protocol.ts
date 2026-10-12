import type { SolidRecipe, Vec3 } from "../core/types";

export interface TessellateJob {
  /** Stable cache key derived from the recipe (see `recipeKey`). */
  key: string;
  recipe: SolidRecipe;
  /** Linear deflection in mm. Smaller = finer mesh. */
  tolerance: number;
  /** Angular deflection in degrees. */
  angularTolerance: number;
}

export interface TessellatePayload {
  key: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edges: Float32Array;
  volume: number;
  area: number;
  bbox: { min: Vec3; max: Vec3 };
  triangleCount: number;
}

export type WorkerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "tessellate"; job: TessellateJob }
  | { id: number; type: "measure"; recipe: SolidRecipe }
  | { id: number; type: "exportSTEP"; items: { recipe: SolidRecipe; name: string }[] }
  | { id: number; type: "exportSTL"; items: { recipe: SolidRecipe; name: string }[]; tolerance: number }
  | { id: number; type: "importSTEP"; data: string }
  | { id: number; type: "releaseAll" };

export type WorkerResponse =
  | { id: number; ok: true; type: "init" }
  | { id: number; ok: true; type: "tessellate"; payload: TessellatePayload }
  | { id: number; ok: true; type: "measure"; volume: number; area: number }
  | { id: number; ok: true; type: "exportSTEP"; text: string }
  | { id: number; ok: true; type: "exportSTL"; buffer: ArrayBuffer }
  | { id: number; ok: true; type: "importSTEP"; assetId: string; solidCount: number }
  | { id: number; ok: true; type: "releaseAll" }
  | { id: number; ok: false; error: string; code: ErrorCode };

export type ErrorCode =
  | "KERNEL_INIT"
  | "INVALID_PARAMS"
  | "BOOLEAN_FAILED"
  | "FILLET_FAILED"
  | "EMPTY_RESULT"
  | "UNSUPPORTED"
  | "UNKNOWN";

