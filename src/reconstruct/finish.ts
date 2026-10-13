import { BASES } from "../render/basis.ts";
import { center, vertexNormals, type Bounds, type Mesh } from "../mesh/types.ts";
import type { Raster } from "../analyze/raster.ts";
import type { AxisEstimate, ViewSample } from "../analyze/types.ts";
import type { ViewId } from "../views.ts";

/**
 * Generative models condition on the views but do not reproduce their
 * proportions: the same F1 car came back 40% too wide. The input views measure
 * width (X), height (Y), and depth (Z) directly, so the asset is rescaled per
 * axis to match, keeping its height. Axes no view observed keep scale 1.
 */
export function proportionScale(bounds: Bounds, axes: readonly AxisEstimate[]): [number, number, number] {
  const measured = (axis: "x" | "y" | "z"): number => {
    const estimate = axes.find((a) => a.axis === axis);
    return estimate && estimate.observations.length > 0 ? estimate.extent : 0;
  };
  const target = { x: measured("x"), y: measured("y"), z: measured("z") };
  const size = [0, 1, 2].map((i) => (bounds.max[i] ?? 0) - (bounds.min[i] ?? 0));
  const height = size[1] ?? 0;
  if (target.y <= 0 || height <= 0) return [1, 1, 1];
  const along = (want: number, have: number): number =>
    want > 0 && have > 0 ? ((want / target.y) * height) / have : 1;
  return [along(target.x, size[0] ?? 0), 1, along(target.z, size[2] ?? 0)];
}

/** Depth-buffer resolution for the per-view visibility test. */
const VISIBILITY_SIZE = 512;
/** Views seen at grazing angles smear colour (stretched whiskers); below this facing they are ignored. */
const MIN_FACING = 0.3;
/**
 * Blend sharpness. Two views that disagree about a detail (an eye drawn at a
 * slightly different place) both paint it with a soft weight, leaving a ghost;
 * a steep power hands each vertex to the view that faces it most squarely and
 * blends only where two views face it about equally.
 */
const FACING_POWER = 6;

/**
 * Colours an untextured mesh from the input views, the way a game artist
 * projection-paints a model sheet: each vertex takes the colour of every view
 * that sees it, weighted by how squarely it faces that view. The view is
 * registered to the mesh by bounding box — the mesh was already fitted to the
 * views' proportions, so box-to-box mapping lines the silhouettes up.
 *
 * A depth test keeps occluded vertices from inheriting the colour of whatever
 * hides them. Vertices no view sees (top, bottom, cavities) take the colour of
 * their nearest painted neighbour across the surface.
 *
 * `samples` supplies each view's silhouette (registration and mask); `colour`
 * supplies a higher-resolution raster of the same image to sample from.
 */
export function paintFromViews(
  input: Mesh,
  samples: ReadonlyMap<ViewId, ViewSample>,
  colour: ReadonlyMap<ViewId, Raster>,
): Mesh {
  const mesh = center(input);
  const vertexCount = mesh.positions.length / 3;
  const normals = vertexNormals(mesh);
  const sum = new Float64Array(vertexCount * 3);
  const weights = new Float64Array(vertexCount);

  for (const [id, sample] of samples) {
    const raster = colour.get(id);
    const bbox = sample.silhouette.bbox;
    if (!raster || !bbox) continue;
    paintView(mesh, normals, id, sample, raster, bbox, sum, weights);
  }

  const colors = new Float32Array(vertexCount * 3);
  const painted = new Uint8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const w = weights[v] ?? 0;
    if (w <= 0) continue;
    painted[v] = 1;
    colors[v * 3] = (sum[v * 3] ?? 0) / w;
    colors[v * 3 + 1] = (sum[v * 3 + 1] ?? 0) / w;
    colors[v * 3 + 2] = (sum[v * 3 + 2] ?? 0) / w;
  }
  floodUnpainted(mesh, colors, painted);
  return { ...input, colors };
}

function paintView(
  mesh: Mesh,
  normals: Float32Array,
  id: ViewId,
  sample: ViewSample,
  raster: Raster,
  bbox: NonNullable<ViewSample["silhouette"]["bbox"]>,
  sum: Float64Array,
  weights: Float64Array,
): void {
  const basis = BASES[id];
  const vertexCount = mesh.positions.length / 3;
  const u = new Float32Array(vertexCount);
  const v = new Float32Array(vertexCount);
  const d = new Float32Array(vertexCount);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = mesh.positions[i * 3] ?? 0;
    const y = mesh.positions[i * 3 + 1] ?? 0;
    const z = mesh.positions[i * 3 + 2] ?? 0;
    const pu = x * basis.right[0] + y * basis.right[1] + z * basis.right[2];
    const pv = x * basis.up[0] + y * basis.up[1] + z * basis.up[2];
    u[i] = pu;
    v[i] = pv;
    d[i] = x * basis.forward[0] + y * basis.forward[1] + z * basis.forward[2];
    if (pu < uMin) uMin = pu;
    if (pu > uMax) uMax = pu;
    if (pv < vMin) vMin = pv;
    if (pv > vMax) vMax = pv;
  }
  if (!(uMax > uMin) || !(vMax > vMin)) return;

  // Mesh projection box -> silhouette box, both as 0..1 fractions of the frame.
  const silhouette = sample.silhouette;
  const fx0 = bbox.x0 / silhouette.width;
  const fx1 = bbox.x1 / silhouette.width;
  const fy0 = bbox.y0 / silhouette.height;
  const fy1 = bbox.y1 / silhouette.height;
  const fx = new Float32Array(vertexCount);
  const fy = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    fx[i] = fx0 + (((u[i] ?? 0) - uMin) / (uMax - uMin)) * (fx1 - fx0);
    fy[i] = fy0 + ((vMax - (v[i] ?? 0)) / (vMax - vMin)) * (fy1 - fy0);
  }

  const depth = depthBuffer(mesh, fx, fy, d);
  // Two depth-buffer pixels of slack, in world units along the view axis.
  const tolerance = (2 * (uMax - uMin)) / ((fx1 - fx0) * VISIBILITY_SIZE);
  const facingAxis = [-basis.forward[0], -basis.forward[1], -basis.forward[2]] as const;

  for (let i = 0; i < vertexCount; i++) {
    const facing =
      (normals[i * 3] ?? 0) * facingAxis[0] +
      (normals[i * 3 + 1] ?? 0) * facingAxis[1] +
      (normals[i * 3 + 2] ?? 0) * facingAxis[2];
    if (facing < MIN_FACING) continue;
    const px = fx[i] ?? 0;
    const py = fy[i] ?? 0;
    const dx = Math.min(VISIBILITY_SIZE - 1, Math.max(0, Math.floor(px * VISIBILITY_SIZE)));
    const dy = Math.min(VISIBILITY_SIZE - 1, Math.max(0, Math.floor(py * VISIBILITY_SIZE)));
    if ((d[i] ?? 0) > (depth[dy * VISIBILITY_SIZE + dx] ?? Infinity) + tolerance) continue;

    // Outside the drawn silhouette there is only background to sample.
    const mx = Math.min(silhouette.width - 1, Math.max(0, Math.floor(px * silhouette.width)));
    const my = Math.min(silhouette.height - 1, Math.max(0, Math.floor(py * silhouette.height)));
    if (silhouette.mask[my * silhouette.width + mx] !== 1) continue;

    const cx = Math.min(raster.width - 1, Math.max(0, Math.floor(px * raster.width)));
    const cy = Math.min(raster.height - 1, Math.max(0, Math.floor(py * raster.height)));
    const p = (cy * raster.width + cx) * 4;
    if ((raster.data[p + 3] ?? 0) < 128) continue;
    const w = facing ** FACING_POWER;
    sum[i * 3] = (sum[i * 3] ?? 0) + ((raster.data[p] ?? 0) / 255) * w;
    sum[i * 3 + 1] = (sum[i * 3 + 1] ?? 0) + ((raster.data[p + 1] ?? 0) / 255) * w;
    sum[i * 3 + 2] = (sum[i * 3 + 2] ?? 0) + ((raster.data[p + 2] ?? 0) / 255) * w;
    weights[i] = (weights[i] ?? 0) + w;
  }
}

/** Nearest surface depth per pixel of the view, smaller = closer to the camera. */
function depthBuffer(mesh: Mesh, fx: Float32Array, fy: Float32Array, d: Float32Array): Float32Array {
  const size = VISIBILITY_SIZE;
  const depth = new Float32Array(size * size).fill(Infinity);
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] ?? 0;
    const b = mesh.indices[t + 1] ?? 0;
    const c = mesh.indices[t + 2] ?? 0;
    const ax = (fx[a] ?? 0) * size;
    const ay = (fy[a] ?? 0) * size;
    const bx = (fx[b] ?? 0) * size;
    const by = (fy[b] ?? 0) * size;
    const cx = (fx[c] ?? 0) * size;
    const cy = (fy[c] ?? 0) * size;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) continue;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    const az = d[a] ?? 0;
    const bz = d[b] ?? 0;
    const cz = d[c] ?? 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area;
        const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        const z = az + w1 * (bz - az) + w0 * (cz - az);
        const i = y * size + x;
        if (z < (depth[i] ?? Infinity)) depth[i] = z;
      }
    }
  }
  return depth;
}

/** Breadth-first fill over mesh edges: each unpainted vertex copies its nearest painted neighbour. */
function floodUnpainted(mesh: Mesh, colors: Float32Array, painted: Uint8Array): void {
  const vertexCount = painted.length;
  const degree = new Uint32Array(vertexCount + 1);
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) degree[(mesh.indices[t + k] ?? 0) + 1] = (degree[(mesh.indices[t + k] ?? 0) + 1] ?? 0) + 2;
  }
  for (let v = 0; v < vertexCount; v++) degree[v + 1] = (degree[v + 1] ?? 0) + (degree[v] ?? 0);
  const start = degree.slice();
  const neighbours = new Uint32Array(degree[vertexCount] ?? 0);
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t + k] ?? 0;
      const slot = start[v] ?? 0;
      neighbours[slot] = mesh.indices[t + ((k + 1) % 3)] ?? 0;
      neighbours[slot + 1] = mesh.indices[t + ((k + 2) % 3)] ?? 0;
      start[v] = slot + 2;
    }
  }

  const queue = new Uint32Array(vertexCount);
  let head = 0;
  let tail = 0;
  for (let v = 0; v < vertexCount; v++) if (painted[v] === 1) queue[tail++] = v;
  if (tail === 0) {
    colors.fill(0.8);
    return;
  }
  // Islands no painted vertex reaches keep the overall mean instead of black.
  const mean = [0, 0, 0];
  for (let i = 0; i < tail; i++) {
    const v = queue[i] ?? 0;
    for (let k = 0; k < 3; k++) mean[k] = (mean[k] ?? 0) + (colors[v * 3 + k] ?? 0) / tail;
  }
  for (let v = 0; v < vertexCount; v++) {
    if (painted[v] === 1) continue;
    for (let k = 0; k < 3; k++) colors[v * 3 + k] = mean[k] ?? 0;
  }
  while (head < tail) {
    const v = queue[head++] ?? 0;
    for (let s = degree[v] ?? 0; s < (degree[v + 1] ?? 0); s++) {
      const n = neighbours[s] ?? 0;
      if (painted[n] === 1) continue;
      painted[n] = 1;
      colors[n * 3] = colors[v * 3] ?? 0;
      colors[n * 3 + 1] = colors[v * 3 + 1] ?? 0;
      colors[n * 3 + 2] = colors[v * 3 + 2] ?? 0;
      queue[tail++] = n;
    }
  }
}
