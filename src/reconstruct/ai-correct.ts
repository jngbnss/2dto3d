import { renderViews } from "../render/ortho.ts";
import { BASES } from "../render/basis.ts";
import { maskIoU } from "../validation.ts";
import { computeBounds, type Mesh } from "../mesh/types.ts";
import { adjacency, smoothWithinBand } from "./mesh-postprocess.ts";
import { OPENING_RADIUS, openMask } from "./voxel-reconstruct.ts";
import type { HullField } from "./voxel-reconstruct.ts";
import type { Silhouette } from "../analyze/silhouette.ts";
import type { Axis, ViewId } from "../views.ts";

/**
 * Generated shape + silhouette correction.
 *
 * An image-to-3D model gives a character its inner relief (cheeks, nose, a
 * hair flower that actually sticks out) but not exact proportions, and it may
 * hand the subject back turned. The prepared views give exact outlines but no
 * relief. This module puts the generated mesh into the views' frame and then
 * lets the outlines win: whatever the generator placed outside any silhouette
 * is pushed back onto the visual hull, and everything inside is kept as is.
 */

export interface Fit {
  readonly mesh: Mesh;
  /** Turn about +Y, degrees, that made the generated mesh agree best with the views. */
  readonly yaw: 0 | 90 | 180 | 270;
  /** Mean silhouette IoU of the fitted (uncorrected) mesh. */
  readonly iou: number;
}

const YAWS = [0, 90, 180, 270] as const;

/**
 * Tries the four quarter turns about +Y; for each, centres the mesh and scales
 * it per axis to the views' extent, renders it into every view and scores the
 * silhouettes. The best-scoring turn wins — a generator that returns the
 * subject facing -Z or sideways is caught here instead of being carved apart.
 *
 * The box fit is then refined on the silhouettes' bodies: thin parts
 * (whiskers, antennae) stretch a bounding box but not a body, and a generator
 * may or may not model them, so both outlines are morphologically opened
 * before their spans are matched axis by axis.
 */
export function fitToViews(
  generated: Mesh,
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  frame: { readonly pixelsPerUnit: number; readonly extent: Readonly<Record<Axis, number>> },
): Fit {
  let best: Fit | null = null;
  for (const yaw of YAWS) {
    const mesh = fitBox(turn(generated, yaw), frame.extent);
    const iou = meanIoU(mesh, silhouettes, frame.pixelsPerUnit);
    if (!best || iou > best.iou) best = { mesh, yaw, iou };
  }
  if (!best) throw new Error("생성된 메시를 뷰에 맞출 수 없습니다.");
  for (let round = 0; round < REFINE_ROUNDS; round++) {
    const refined = refine(best.mesh, silhouettes, frame.pixelsPerUnit);
    const iou = meanIoU(refined, silhouettes, frame.pixelsPerUnit);
    if (iou <= best.iou) break;
    best = { ...best, mesh: refined, iou };
  }
  return best;
}

const REFINE_ROUNDS = 3;

function meanIoU(mesh: Mesh, silhouettes: ReadonlyMap<ViewId, Silhouette>, pixelsPerUnit: number): number {
  const size = [...silhouettes.values()][0]?.width ?? 512;
  const renders = renderViews(mesh, { size, pixelsPerUnit });
  let total = 0;
  for (const [id, silhouette] of silhouettes) total += maskIoU(silhouette, renders[id].pixels);
  return total / Math.max(silhouettes.size, 1);
}

/**
 * One refinement step: per view, the opened input outline and the opened render
 * outline each give a world-space span along both image axes; every span pair
 * proposes a scale and offset for that world axis, and the median proposal per
 * axis is applied.
 */
function refine(mesh: Mesh, silhouettes: ReadonlyMap<ViewId, Silhouette>, pixelsPerUnit: number): Mesh {
  const size = [...silhouettes.values()][0]?.width ?? 512;
  const renders = renderViews(mesh, { size, pixelsPerUnit });
  const proposals: Array<Array<[number, number]>> = [[], [], []];
  for (const [id, silhouette] of silhouettes) {
    const rendered = renders[id];
    const renderMask = new Uint8Array(rendered.width * rendered.height);
    for (let i = 0; i < renderMask.length; i++) renderMask[i] = (rendered.pixels[i * 4 + 3] ?? 0) >= 128 ? 1 : 0;
    const want = openedBox(openMask(silhouette, OPENING_RADIUS), silhouette.width, silhouette.height);
    const have = openedBox(openMask({ width: rendered.width, height: rendered.height, mask: renderMask }, OPENING_RADIUS), rendered.width, rendered.height);
    if (!want || !have) continue;
    const basis = BASES[id];
    for (const [vector, a0, a1, b0, b1, flipRows, extent] of [
      [basis.right, want.x0, want.x1, have.x0, have.x1, false, silhouette.width],
      [basis.up, want.y0, want.y1, have.y0, have.y1, true, silhouette.height],
    ] as const) {
      const axis = vector.findIndex((c) => c !== 0);
      const sign = (vector[axis] ?? 1) * (flipRows ? -1 : 1);
      const world = (pixel: number): number => (sign * (pixel - extent / 2)) / pixelsPerUnit;
      const [w0, w1] = [world(a0), world(a1)].sort((p, q) => p - q) as [number, number];
      const [r0, r1] = [world(b0), world(b1)].sort((p, q) => p - q) as [number, number];
      if (!(r1 > r0)) continue;
      const scale = (w1 - w0) / (r1 - r0);
      proposals[axis]?.push([scale, (w0 + w1) / 2 - (scale * (r0 + r1)) / 2]);
    }
  }
  const apply = proposals.map((list) => (list.length > 0 ? medianPair(list) : ([1, 0] as [number, number])));
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const [scale, offset] = apply[k] ?? [1, 0];
      positions[i + k] = (mesh.positions[i + k] ?? 0) * scale + offset;
    }
  }
  return { ...mesh, positions, bounds: computeBounds(positions) };
}

function openedBox(mask: Uint8Array, width: number, height: number): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  // Exclusive far edges, so spans are measured edge to edge.
  return x1 < 0 ? null : { x0, x1: x1 + 1, y0, y1: y1 + 1 };
}

function medianPair(list: ReadonlyArray<[number, number]>): [number, number] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  return sorted[sorted.length >> 1] ?? [1, 0];
}

/**
 * Overhang a vertex may keep beyond the hull, in cells. Pulling every vertex
 * exactly onto the hull flattens the generator's curved surface onto the hull's
 * extruded faces (visible as streaks); a couple of cells of slack keeps the
 * curvature while the outline still matches the silhouettes closely.
 */
const OVERHANG_CELLS = 2.5;
/** Diffusion steps that spread a correction over its neighbourhood. */
const SPREAD_ITERATIONS = 24;

/**
 * Shrink-wraps the generated surface into the hull. Each vertex further than
 * `OVERHANG_CELLS` outside gets the displacement that would bring it back; the
 * displacement field is then diffused across the mesh so the surrounding
 * surface moves with it — a smooth dent instead of a flat cut — and only what
 * still overhangs after that is projected. Vertices well inside and far from
 * any overhang keep the generator's shape.
 */
export function correctToHull(mesh: Mesh, field: HullField): Mesh {
  const limit = -field.cell * OVERHANG_CELLS;
  const required = projectOutside(mesh.positions, field, limit);
  const vertexCount = mesh.positions.length / 3;
  let spread = new Float32Array(mesh.positions.length);
  for (let i = 0; i < spread.length; i++) spread[i] = (required[i] ?? 0) - (mesh.positions[i] ?? 0);
  const { offsets, neighbours } = adjacency(mesh, vertexCount);
  let next = new Float32Array(spread.length);
  for (let pass = 0; pass < SPREAD_ITERATIONS; pass++) {
    for (let v = 0; v < vertexCount; v++) {
      const from = offsets[v] ?? 0;
      const to = offsets[v + 1] ?? 0;
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        for (let s = from; s < to; s++) sum += spread[(neighbours[s] ?? 0) * 3 + k] ?? 0;
        const own = spread[v * 3 + k] ?? 0;
        next[v * 3 + k] = to > from ? 0.5 * own + (0.5 * sum) / (to - from) : own;
      }
    }
    [spread, next] = [next, spread];
  }
  const moved = new Float32Array(mesh.positions.length);
  for (let i = 0; i < moved.length; i++) moved[i] = (mesh.positions[i] ?? 0) + (spread[i] ?? 0);
  const projected = projectOutside(moved, field, limit);
  const smoothed = smoothWithinBand({ ...mesh, positions: projected, bounds: computeBounds(projected) }, 3, field.cell);
  return { ...mesh, positions: smoothed.positions, bounds: smoothed.bounds };
}

/** Moves points with field < `limit` up to `limit` along the normalised gradient (a few Newton steps). */
function projectOutside(positions: Float32Array, field: HullField, limit: number): Float32Array {
  const out = Float32Array.from(positions);
  const h = field.cell;
  for (let i = 0; i + 2 < out.length; i += 3) {
    let x = out[i] ?? 0;
    let y = out[i + 1] ?? 0;
    let z = out[i + 2] ?? 0;
    for (let step = 0; step < 4; step++) {
      const f = trilinear(field, x, y, z);
      if (f >= limit) break;
      const gx = (trilinear(field, x + h, y, z) - trilinear(field, x - h, y, z)) / (2 * h);
      const gy = (trilinear(field, x, y + h, z) - trilinear(field, x, y - h, z)) / (2 * h);
      const gz = (trilinear(field, x, y, z + h) - trilinear(field, x, y, z - h)) / (2 * h);
      const length = Math.hypot(gx, gy, gz);
      if (!(length > 1e-9)) break;
      const move = (limit - f) / length;
      x += gx * move;
      y += gy * move;
      z += gz * move;
    }
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
  }
  return out;
}

/** Field value at a world point; outside the grid the field keeps falling off with distance. */
export function trilinear(field: HullField, x: number, y: number, z: number): number {
  const { nx, ny, nz, origin, cell, values } = field;
  const gx = (x - origin[0]) / cell;
  const gy = (y - origin[1]) / cell;
  const gz = (z - origin[2]) / cell;
  const cx = Math.min(nx - 1, Math.max(0, gx));
  const cy = Math.min(ny - 1, Math.max(0, gy));
  const cz = Math.min(nz - 1, Math.max(0, gz));
  const outside = Math.hypot(gx - cx, gy - cy, gz - cz) * cell;
  const x0 = Math.min(nx - 2, Math.floor(cx));
  const y0 = Math.min(ny - 2, Math.floor(cy));
  const z0 = Math.min(nz - 2, Math.floor(cz));
  const fx = cx - x0;
  const fy = cy - y0;
  const fz = cz - z0;
  const at = (ix: number, iy: number, iz: number): number => values[ix + nx * (iy + ny * iz)] ?? 0;
  const c00 = at(x0, y0, z0) * (1 - fx) + at(x0 + 1, y0, z0) * fx;
  const c10 = at(x0, y0 + 1, z0) * (1 - fx) + at(x0 + 1, y0 + 1, z0) * fx;
  const c01 = at(x0, y0, z0 + 1) * (1 - fx) + at(x0 + 1, y0, z0 + 1) * fx;
  const c11 = at(x0, y0 + 1, z0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1, z0 + 1) * fx;
  const c0 = c00 * (1 - fy) + c10 * fy;
  const c1 = c01 * (1 - fy) + c11 * fy;
  return c0 * (1 - fz) + c1 * fz - outside;
}

/** Quarter turn about +Y; winding is preserved because it is a rotation. */
function turn(mesh: Mesh, yaw: (typeof YAWS)[number]): Mesh {
  if (yaw === 0) return mesh;
  const cos = Math.round(Math.cos((yaw * Math.PI) / 180));
  const sin = Math.round(Math.sin((yaw * Math.PI) / 180));
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = mesh.positions[i] ?? 0;
    const z = mesh.positions[i + 2] ?? 0;
    positions[i] = cos * x + sin * z;
    positions[i + 1] = mesh.positions[i + 1] ?? 0;
    positions[i + 2] = -sin * x + cos * z;
  }
  return { ...mesh, positions, bounds: computeBounds(positions) };
}

/** Centres the mesh's bounding box on the origin and scales each axis to `extent`. */
function fitBox(mesh: Mesh, extent: Readonly<Record<Axis, number>>): Mesh {
  const { min, max } = mesh.bounds;
  const target = [extent.x, extent.y, extent.z];
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const lo = min[k] ?? 0;
      const span = (max[k] ?? 0) - lo;
      const want = target[k] ?? 0;
      const value = mesh.positions[i + k] ?? 0;
      positions[i + k] = span > 0 && want > 0 ? ((value - lo) / span - 0.5) * want : value - (lo + span / 2);
    }
  }
  return { ...mesh, positions, bounds: computeBounds(positions) };
}
