/// <reference lib="webworker" />
/**
 * CAD geometry worker. Owns the OpenCascade (OCCT) WASM instance via replicad.
 *
 * Everything in this file runs OFF the main thread, so a kernel crash or a long
 * boolean never freezes the UI. Failures are returned as structured errors; the
 * worker stays alive and usable afterwards.
 */
import initOpenCascade from "replicad-opencascadejs";
import occtWasmUrl from "replicad-opencascadejs/wasm?url";
import * as rc from "replicad";
import type { Feature, HoleSpec, Profile, SolidRecipe, Transform, Vec3 } from "../core/types";
import type { WorkerRequest, WorkerResponse, ErrorCode } from "./protocol";
import { recipeKey } from "./recipeKey";

type AnyShape = any;

let ready: Promise<void> | null = null;

function boot(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const OC = await (initOpenCascade as any)({ locateFile: () => occtWasmUrl });
      rc.setOC(OC);
    })();
  }
  return ready;
}

class KernelFailure extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.code = code;
  }
}

/* --------------------------------------------------------------- shape cache */

const MAX_CACHE = 64;
/** key -> shape. Insertion order doubles as the LRU queue. */
const cache = new Map<string, AnyShape>();

function cacheGet(key: string): AnyShape | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, shape: AnyShape): AnyShape {
  cache.set(key, shape);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const victim = cache.get(oldest);
    cache.delete(oldest);
    safeDelete(victim);
  }
  return shape;
}

function safeDelete(shape: AnyShape) {
  try {
    shape?.delete?.();
  } catch {
    /* shape already freed */
  }
}

function clearCache() {
  for (const shape of cache.values()) safeDelete(shape);
  cache.clear();
}

/**
 * Imported STEP solids, keyed by asset id. These are the ONE case where a shape
 * is not derived from parameters, so they are retained outside the LRU cache for
 * as long as the document references them.
 */
const stepAssets = new Map<string, { source: string; shape: AnyShape }>();

/* ------------------------------------------------------------- numeric guard */

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new KernelFailure(`${label} must be a positive number (got ${value})`, "INVALID_PARAMS");
  }
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new KernelFailure(`${label} must be a finite number`, "INVALID_PARAMS");
  }
  return value;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len < 1e-9) {
    throw new KernelFailure("Direction vector must be non-zero", "INVALID_PARAMS");
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

/* ------------------------------------------------------------------ profiles */

function drawProfile(profile: Profile): any {
  switch (profile.type) {
    case "rect": {
      const w = finitePositive(profile.width, "Profile width");
      const h = finitePositive(profile.height, "Profile height");
      const r = profile.cornerRadius ?? 0;
      if (r > 0) {
        const maxR = Math.min(w, h) / 2 - 1e-6;
        return rc.drawRoundedRectangle(w, h, Math.min(r, maxR));
      }
      return rc.drawRectangle(w, h);
    }
    case "circle":
      return rc.drawCircle(finitePositive(profile.radius, "Profile radius"));
    case "regular":
      return rc.drawPolysides(
        finitePositive(profile.radius, "Profile radius"),
        Math.max(3, Math.round(profile.sides)),
      );
    case "polygon": {
      const pts = profile.points;
      if (!pts || pts.length < 3) {
        throw new KernelFailure("A polygon profile needs at least 3 points", "INVALID_PARAMS");
      }
      pts.forEach((p, i) => {
        finite(p[0], `Point ${i} x`);
        finite(p[1], `Point ${i} y`);
      });
      let pen = rc.draw([pts[0][0], pts[0][1]]);
      for (let i = 1; i < pts.length; i += 1) pen = pen.lineTo([pts[i][0], pts[i][1]]);
      return pen.close();
    }
    default:
      throw new KernelFailure("Unsupported profile type", "UNSUPPORTED");
  }
}

/** Unit normal of a named sketch plane, used to centre extrusions on their axis. */
const PLANE_NORMAL: Record<string, Vec3> = {
  XY: [0, 0, 1],
  XZ: [0, -1, 0],
  YZ: [1, 0, 0],
};

/* ------------------------------------------------------------ feature -> shape */

function buildFeature(feature: Feature): AnyShape {
  switch (feature.type) {
    case "box": {
      const w = finitePositive(feature.width, "Width");
      const d = finitePositive(feature.depth, "Depth");
      const h = finitePositive(feature.height, "Height");
      // makeBaseBox is centred in XY with its base at z=0; recentre on the origin.
      return rc.makeBaseBox(w, d, h).translate(0, 0, -h / 2);
    }
    case "cylinder": {
      const r = finitePositive(feature.radius, "Radius");
      const h = finitePositive(feature.height, "Height");
      return rc.makeCylinder(r, h).translate(0, 0, -h / 2);
    }
    case "sphere":
      return rc.makeSphere(finitePositive(feature.radius, "Radius"));
    case "cone": {
      const h = finitePositive(feature.height, "Height");
      const r1 = Math.max(0, finite(feature.bottomRadius, "Bottom radius"));
      const r2 = Math.max(0, finite(feature.topRadius, "Top radius"));
      if (r1 <= 0 && r2 <= 0) {
        throw new KernelFailure("A cone needs at least one non-zero radius", "INVALID_PARAMS");
      }
      // Revolve the meridian profile: replicad has no makeCone.
      const pts: [number, number][] = [[0, 0], [r1, 0], [r2, h], [0, h]];
      const dedup = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9);
      let pen = rc.draw(dedup[0]);
      for (let i = 1; i < dedup.length; i += 1) pen = pen.lineTo(dedup[i]);
      const solid = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]);
      return solid.translate(0, 0, -h / 2);
    }
    case "extrude": {
      const dist = finitePositive(feature.distance, "Extrude distance");
      const sketch = drawProfile(feature.profile).sketchOnPlane(feature.plane);
      const solid = sketch.extrude(dist, feature.twistAngle ? { twistAngle: feature.twistAngle } : undefined);
      const n = PLANE_NORMAL[feature.plane] ?? [0, 0, 1];
      // Centre on the extrusion axis so the local origin is the solid's centre.
      return solid.translate(-n[0] * dist / 2, -n[1] * dist / 2, -n[2] * dist / 2);
    }
    case "revolve": {
      const angle = finitePositive(feature.angle, "Revolve angle");
      const sketch = drawProfile(feature.profile).sketchOnPlane(feature.plane);
      return sketch.revolve(undefined, { angle });
    }
    case "boolean":
      return buildBoolean(feature.op, feature.operands);
    case "hole":
      return buildHoles(feature.base, feature.holes);
    case "fillet":
    case "chamfer": {
      const size = finitePositive(
        feature.type === "fillet" ? feature.radius : feature.distance,
        feature.type === "fillet" ? "Fillet radius" : "Chamfer distance",
      );
      const base = buildRecipe(feature.base).clone();
      try {
        return feature.type === "fillet" ? base.fillet(size) : base.chamfer(size);
      } catch (err) {
        safeDelete(base);
        throw new KernelFailure(
          `${feature.type === "fillet" ? "Fillet" : "Chamfer"} failed: the size (${size} mm) is probably too large for this shape`,
          "FILLET_FAILED",
        );
      }
    }
    case "imported-step": {
      const asset = stepAssets.get(feature.assetId);
      if (!asset) {
        throw new KernelFailure(
          "Imported STEP data is no longer in memory — re-import the file",
          "EMPTY_RESULT",
        );
      }
      return asset.shape.clone();
    }
    default:
      throw new KernelFailure(`Unsupported feature: ${(feature as { type: string }).type}`, "UNSUPPORTED");
  }
}

function buildBoolean(op: "union" | "cut" | "intersect", operands: SolidRecipe[]): AnyShape {
  if (!operands || operands.length < 2) {
    throw new KernelFailure("A boolean operation needs at least two bodies", "INVALID_PARAMS");
  }
  let result = buildRecipe(operands[0]).clone();
  for (let i = 1; i < operands.length; i += 1) {
    const tool = buildRecipe(operands[i]).clone();
    try {
      result =
        op === "union" ? result.fuse(tool) : op === "cut" ? result.cut(tool) : result.intersect(tool);
    } catch (err) {
      safeDelete(result);
      safeDelete(tool);
      throw new KernelFailure(
        `Boolean ${op} failed — the bodies may not overlap, or the result is not a valid solid`,
        "BOOLEAN_FAILED",
      );
    }
    if (!result || result.isNull) {
      throw new KernelFailure(`Boolean ${op} produced an empty result`, "EMPTY_RESULT");
    }
  }
  if (op !== "union" && rc.measureVolume(result) < 1e-9) {
    throw new KernelFailure(
      `Boolean ${op} produced an empty solid — check that the bodies actually overlap`,
      "EMPTY_RESULT",
    );
  }
  return result;
}

function buildHoles(base: SolidRecipe, holes: HoleSpec[]): AnyShape {
  let result = buildRecipe(base).clone();
  if (!holes?.length) return result;
  const [bmin, bmax] = result.boundingBox.bounds;
  const span = Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) || 100;
  for (const hole of holes) {
    const dia = finitePositive(hole.diameter, "Hole diameter");
    const dir = normalize(hole.direction as Vec3);
    const through = hole.depth === "through";
    const depth = through ? span * 2 + 10 : finitePositive(hole.depth as number, "Hole depth");
    const origin = hole.position as Vec3;
    // A through hole is centred on the anchor point and over-long in both
    // directions; a blind hole starts at the anchor and runs along +direction.
    const start: Vec3 = through
      ? [origin[0] - dir[0] * depth / 2, origin[1] - dir[1] * depth / 2, origin[2] - dir[2] * depth / 2]
      : origin;
    let tool = rc.makeCylinder(dia / 2, depth, start, dir);
    if (hole.counterbore) {
      const cbD = finitePositive(hole.counterbore.diameter, "Counterbore diameter");
      const cbH = finitePositive(hole.counterbore.depth, "Counterbore depth");
      const cb = rc.makeCylinder(cbD / 2, cbH, start, dir);
      tool = tool.fuse(cb);
    }
    try {
      result = result.cut(tool);
    } catch {
      safeDelete(result);
      safeDelete(tool);
      throw new KernelFailure("Hole cut failed — check the hole position and diameter", "BOOLEAN_FAILED");
    }
  }
  if (rc.measureVolume(result) < 1e-9) {
    throw new KernelFailure("The holes removed the entire body", "EMPTY_RESULT");
  }
  return result;
}

/**
 * three.js Euler order "XYZ" builds R = Rx·Ry·Rz, so applying world-axis
 * rotations in the order Z, Y, X reproduces exactly the same orientation.
 * Keeping these two in lockstep is what makes "what you see" equal "what the
 * kernel exports".
 */
function applyTransform(shape: AnyShape, t: Transform): AnyShape {
  let out = shape;
  const [rx, ry, rz] = t.rotation.map((v) => finite(v, "Rotation")) as Vec3;
  if (rz) out = out.rotate(rz, [0, 0, 0], [0, 0, 1]);
  if (ry) out = out.rotate(ry, [0, 0, 0], [0, 1, 0]);
  if (rx) out = out.rotate(rx, [0, 0, 0], [1, 0, 0]);
  const [px, py, pz] = t.position.map((v) => finite(v, "Position")) as Vec3;
  if (px || py || pz) out = out.translate(px, py, pz);
  return out;
}

function isIdentity(t: Transform): boolean {
  return t.position.every((v) => v === 0) && t.rotation.every((v) => v === 0);
}

/** Build (or reuse) the shape for a recipe. The returned shape is CACHE-OWNED. */
function buildRecipe(recipe: SolidRecipe): AnyShape {
  const key = recipeKey(recipe);
  const hit = cacheGet(key);
  if (hit) return hit;
  const local = buildFeature(recipe.feature);
  const placed = isIdentity(recipe.transform) ? local : applyTransform(local, recipe.transform);
  if (!placed || placed.isNull) {
    throw new KernelFailure("The kernel produced an empty shape", "EMPTY_RESULT");
  }
  return cachePut(key, placed);
}

/* ------------------------------------------------------------------ handlers */

function tessellate(job: { key: string; recipe: SolidRecipe; tolerance: number; angularTolerance: number }) {
  const shape = buildRecipe(job.recipe);
  const mesh = shape.mesh({ tolerance: job.tolerance, angularTolerance: job.angularTolerance });
  const edgeMesh = shape.meshEdges({ tolerance: job.tolerance, angularTolerance: job.angularTolerance });
  const [min, max] = shape.boundingBox.bounds;
  const positions = new Float32Array(mesh.vertices);
  const normals = new Float32Array(mesh.normals);
  const indices = new Uint32Array(mesh.triangles);
  const edges = new Float32Array(edgeMesh.lines);
  return {
    payload: {
      key: job.key,
      positions,
      normals,
      indices,
      edges,
      volume: rc.measureVolume(shape),
      area: rc.measureArea(shape),
      bbox: { min: min as Vec3, max: max as Vec3 },
      triangleCount: indices.length / 3,
    },
    transfer: [positions.buffer, normals.buffer, indices.buffer, edges.buffer] as Transferable[],
  };
}

async function handle(req: WorkerRequest): Promise<{ res: WorkerResponse; transfer?: Transferable[] }> {
  await boot();
  switch (req.type) {
    case "init":
      return { res: { id: req.id, ok: true, type: "init" } };
    case "tessellate": {
      const { payload, transfer } = tessellate(req.job);
      return { res: { id: req.id, ok: true, type: "tessellate", payload }, transfer };
    }
    case "measure": {
      const shape = buildRecipe(req.recipe);
      return {
        res: { id: req.id, ok: true, type: "measure", volume: rc.measureVolume(shape), area: rc.measureArea(shape) },
      };
    }
    case "exportSTEP": {
      if (!req.items.length) throw new KernelFailure("No solid bodies to export", "EMPTY_RESULT");
      const shapes = req.items.map((item) => ({ shape: buildRecipe(item.recipe).clone(), name: item.name }));
      const blob = rc.exportSTEP(shapes as any);
      const text = await blob.text();
      shapes.forEach((s) => safeDelete(s.shape));
      return { res: { id: req.id, ok: true, type: "exportSTEP", text } };
    }
    case "exportSTL": {
      if (!req.items.length) throw new KernelFailure("No solid bodies to export", "EMPTY_RESULT");
      // A compound keeps disjoint bodies separate: no boolean cost, no risk of a
      // fuse failing on bodies that never touch.
      const parts = req.items.map((item) => buildRecipe(item.recipe).clone());
      const combined = parts.length === 1 ? parts[0] : rc.makeCompound(parts);
      const blob = combined.blobSTL({ binary: true, tolerance: req.tolerance, angularTolerance: 20 });
      const buffer = await blob.arrayBuffer();
      safeDelete(combined);
      return { res: { id: req.id, ok: true, type: "exportSTL", buffer }, transfer: [buffer] };
    }
    case "importSTEP": {
      const blob = new Blob([req.data], { type: "application/step" });
      const shape = await rc.importSTEP(blob);
      if (!shape || shape.isNull) throw new KernelFailure("The STEP file contains no usable solid", "EMPTY_RESULT");
      const assetId = `step_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      stepAssets.set(assetId, { source: req.data, shape });
      return { res: { id: req.id, ok: true, type: "importSTEP", assetId, solidCount: 1 } };
    }
    case "releaseAll":
      clearCache();
      return { res: { id: req.id, ok: true, type: "releaseAll" } };
    default:
      throw new KernelFailure("Unknown request", "UNSUPPORTED");
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    const { res, transfer } = await handle(req);
    (self as unknown as Worker).postMessage(res, transfer ?? []);
  } catch (err) {
    const code: ErrorCode = err instanceof KernelFailure ? err.code : "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    const res: WorkerResponse = { id: req.id, ok: false, error: message, code };
    (self as unknown as Worker).postMessage(res);
  }
};
