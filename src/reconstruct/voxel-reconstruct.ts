import { BASES } from "../render/basis.ts";
import type { Silhouette } from "../analyze/silhouette.ts";
import type { Axis, ViewId } from "../views.ts";

/**
 * Visual hull as a signed distance field.
 *
 * A point belongs to the hull when it projects inside every view's silhouette.
 * Instead of a yes/no per voxel, each view contributes the 2D signed distance
 * from the projected point to its silhouette outline (positive inside), and the
 * hull field is the minimum over views. Its zero level set is exactly the
 * visual hull, but the field varies smoothly across cells, so the extracted
 * surface lands between grid samples instead of on cell faces — no staircase,
 * and silhouettes are reproduced to sub-voxel precision.
 *
 * Views are registered by the preprocessing contract: world point p lands at
 * pixel (W/2 + (p·right)·ppu, H/2 - (p·up)·ppu) of every silhouette.
 */

export interface HullFrame {
  /** Silhouette pixels per world unit, identical for every view. */
  readonly pixelsPerUnit: number;
  /** Object extent in world units, centred on the origin. */
  readonly extent: Readonly<Record<Axis, number>>;
}

export interface ReconstructOptions {
  /** Grid cells along the longest axis. */
  readonly resolution?: number;
  /** Intersect the hull with its own mirror image across X = 0 (left-right symmetric subjects). */
  readonly symmetryX?: boolean;
  /**
   * Rounded cross-section prior, 0..1. 0 keeps the plain visual hull, whose
   * horizontal slices are rectangles where front and side meet — the boxy
   * corners seen from a diagonal. Above 0 every slice is also limited to a
   * superellipse inscribed in that rectangle; 1 is a true ellipse (organic
   * subjects: characters, fruit, bodies). Exponent = 2 / rounding.
   */
  readonly rounding?: number;
}

export interface HullField {
  /** Samples per axis (grid corners). */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** World position of sample (0, 0, 0). */
  readonly origin: readonly [number, number, number];
  /** World distance between neighbouring samples. */
  readonly cell: number;
  /** Signed distance in world units, > 0 inside. Index = x + nx * (y + ny * z). */
  readonly values: Float32Array;
  readonly views: readonly ViewId[];
}

export const DEFAULT_RESOLUTION = 160;
/** Empty cells kept around the object so the surface closes inside the grid. */
const MARGIN_CELLS = 2;

export function buildHullField(
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  frame: HullFrame,
  options: ReconstructOptions = {},
): HullField {
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  const longest = Math.max(frame.extent.x, frame.extent.y, frame.extent.z);
  if (!(longest > 0)) throw new Error("뷰에서 피사체 크기를 읽지 못해 복원할 수 없습니다.");
  const views = [...silhouettes].filter(([, s]) => s.area > 0);
  if (views.length === 0) throw new Error("실루엣이 있는 뷰가 없어 복원할 수 없습니다.");

  const cell = longest / resolution;
  const count = (axis: Axis): number => Math.ceil(frame.extent[axis] / cell) + 1 + 2 * MARGIN_CELLS;
  const nx = count("x");
  const ny = count("y");
  const nz = count("z");
  const origin = [-((nx - 1) * cell) / 2, -((ny - 1) * cell) / 2, -((nz - 1) * cell) / 2] as const;

  const distances = views.map(([id, silhouette]) => ({ id, silhouette, field: signedDistance(silhouette) }));
  const rounding = options.rounding ?? 0;
  const round = rounding > 0 ? crossSectionPrior(silhouettes, frame.pixelsPerUnit, 2 / Math.min(1, rounding)) : null;
  const values = new Float32Array(nx * ny * nz);
  for (let iz = 0; iz < nz; iz++) {
    const z = origin[2] + iz * cell;
    for (let iy = 0; iy < ny; iy++) {
      const y = origin[1] + iy * cell;
      for (let ix = 0; ix < nx; ix++) {
        const x = origin[0] + ix * cell;
        let value = Infinity;
        for (const view of distances) {
          value = Math.min(value, sampleView(view.id, view.silhouette, view.field, x, y, z, frame.pixelsPerUnit));
          if (options.symmetryX) {
            value = Math.min(value, sampleView(view.id, view.silhouette, view.field, -x, y, z, frame.pixelsPerUnit));
          }
        }
        if (round) value = Math.min(value, round(x, y, z));
        values[ix + nx * (iy + ny * iz)] = value;
      }
    }
  }
  return { nx, ny, nz, origin, cell, values, views: views.map(([id]) => id) };
}

/** Silhouette runs along one image row: for every pixel, the inclusive [start, end] of its foreground run, or -1. */
interface Runs {
  readonly start: Int32Array;
  readonly end: Int32Array;
}

/** Thin parts (whiskers, antennae, wires) narrower than twice this are left out of cross-section spans. */
export const OPENING_RADIUS = 4;
/** Rows above and below averaged when measuring a cross-section span. */
const SPAN_ROWS = 3;

/**
 * Morphological opening by a disc: drops structures thinner than `2 * radius`
 * and keeps everything else unchanged. Without it, a whisker row would widen the
 * head's span in that row only, and the rounded prior would bulge row by row.
 */
export function openMask(silhouette: Pick<Silhouette, "width" | "height" | "mask">, radius: number): Uint8Array {
  const { width, height, mask } = silhouette;
  const toBackground = distanceTransform(mask, width, height, 0);
  const eroded = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) eroded[i] = (toBackground[i] ?? 0) > radius * radius ? 1 : 0;
  const toEroded = distanceTransform(eroded, width, height, 1);
  const opened = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) opened[i] = mask[i] === 1 && (toEroded[i] ?? Infinity) <= radius * radius ? 1 : 0;
  return opened;
}

function rowRuns(silhouette: Silhouette): Runs {
  const { width, height } = silhouette;
  const mask = openMask(silhouette, OPENING_RADIUS);
  const start = new Int32Array(width * height).fill(-1);
  const end = new Int32Array(width * height).fill(-1);
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      if (mask[y * width + x] !== 1) {
        x++;
        continue;
      }
      const from = x;
      while (x < width && mask[y * width + x] === 1) x++;
      for (let k = from; k < x; k++) {
        start[y * width + k] = from;
        end[y * width + k] = x - 1;
      }
    }
  }
  return { start, end };
}

/**
 * Builds f(x, y, z): signed distance-like value of a superellipse in the
 * horizontal slice through y. The slice's X span comes from the front (or back)
 * silhouette run under the point, its Z span from the left (or right) run, so
 * arms, legs and head each get their own rounded section. Points outside a run
 * are left to the silhouettes themselves (+Infinity here).
 */
function crossSectionPrior(
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  pixelsPerUnit: number,
  exponent: number,
): ((x: number, y: number, z: number) => number) | null {
  const pick = (axis: 0 | 2): { id: ViewId; silhouette: Silhouette; runs: Runs } | null => {
    for (const [id, silhouette] of silhouettes) {
      const basis = BASES[id];
      if (basis.up[1] !== 1 || basis.right[axis] === 0 || silhouette.area === 0) continue;
      return { id, silhouette, runs: rowRuns(silhouette) };
    }
    return null;
  };
  const across = pick(0);
  const deep = pick(2);
  if (!across || !deep) return null;

  // Run under (horizontal world coordinate w, height y) in a view whose image right is ±axis.
  // Run ends are averaged over a few neighbouring rows: per-row spans step by a
  // whole pixel, which would otherwise print as horizontal ribs on round sides.
  const span = (view: NonNullable<typeof across>, axis: 0 | 2, w: number, y: number): [number, number] | null => {
    const { width, height } = view.silhouette;
    const sign = BASES[view.id].right[axis] ?? 1;
    const px = Math.floor(width / 2 + w * sign * pixelsPerUnit);
    const row = Math.floor(height / 2 - y * pixelsPerUnit);
    if (px < 0 || row < 0 || px >= width || row >= height) return null;
    if ((view.runs.start[row * width + px] ?? -1) < 0) return null;
    let a = 0;
    let b = 0;
    let rows = 0;
    for (let py = Math.max(0, row - SPAN_ROWS); py <= Math.min(height - 1, row + SPAN_ROWS); py++) {
      const start = view.runs.start[py * width + px] ?? -1;
      if (start < 0) continue;
      a += start;
      b += view.runs.end[py * width + px] ?? start;
      rows++;
    }
    const w0 = ((a / rows - width / 2) / pixelsPerUnit) * sign;
    const w1 = ((b / rows + 1 - width / 2) / pixelsPerUnit) * sign;
    return w0 < w1 ? [w0, w1] : [w1, w0];
  };

  return (x, y, z) => {
    const sx = span(across, 0, x, y);
    const sz = span(deep, 2, z, y);
    if (!sx || !sz) return Infinity;
    const rx = (sx[1] - sx[0]) / 2;
    const rz = (sz[1] - sz[0]) / 2;
    if (rx <= 0 || rz <= 0) return Infinity;
    const ex = Math.abs(x - (sx[0] + sx[1]) / 2) / rx;
    const ez = Math.abs(z - (sz[0] + sz[1]) / 2) / rz;
    const r = (ex ** exponent + ez ** exponent) ** (1 / exponent);
    return (1 - r) * Math.min(rx, rz);
  };
}

/** Field value of one view at world point (x, y, z), in world units. */
function sampleView(
  id: ViewId,
  silhouette: Silhouette,
  field: Float32Array,
  x: number,
  y: number,
  z: number,
  pixelsPerUnit: number,
): number {
  const basis = BASES[id];
  const u = basis.right[0] * x + basis.right[1] * y + basis.right[2] * z;
  const v = basis.up[0] * x + basis.up[1] * y + basis.up[2] * z;
  // Pixel centres sit at integer + 0.5, so shift into sample space before interpolating.
  const px = silhouette.width / 2 + u * pixelsPerUnit - 0.5;
  const py = silhouette.height / 2 - v * pixelsPerUnit - 0.5;
  return bilinear(field, silhouette.width, silhouette.height, px, py) / pixelsPerUnit;
}

/** Bilinear sample; outside the image the field keeps falling off with distance. */
function bilinear(field: Float32Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const outside = Math.hypot(x - cx, y - cy);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = field[y0 * width + x0] ?? 0;
  const b = field[y0 * width + x1] ?? 0;
  const c = field[y1 * width + x0] ?? 0;
  const d = field[y1 * width + x1] ?? 0;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy - outside;
}

/**
 * Signed Euclidean distance to the silhouette boundary in pixels, positive
 * inside. Two exact distance transforms (to foreground, to background) with the
 * half-pixel offset that puts the zero crossing on the pixel edge.
 */
export function signedDistance(silhouette: Silhouette): Float32Array {
  const { width, height, mask } = silhouette;
  const toForeground = distanceTransform(mask, width, height, 1);
  const toBackground = distanceTransform(mask, width, height, 0);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = mask[i] === 1 ? Math.sqrt(toBackground[i] ?? 0) - 0.5 : 0.5 - Math.sqrt(toForeground[i] ?? 0);
  }
  return out;
}

const FAR = 1e20;

/** Squared distance from every pixel to the nearest pixel whose mask equals `target` (Felzenszwalb–Huttenlocher). */
function distanceTransform(mask: Uint8Array, width: number, height: number, target: 0 | 1): Float64Array {
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] === target ? 0 : FAR;
  const line = new Float64Array(Math.max(width, height));
  const out = new Float64Array(Math.max(width, height));
  const v = new Int32Array(Math.max(width, height));
  const z = new Float64Array(Math.max(width, height) + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) line[y] = grid[y * width + x] ?? FAR;
    transform1d(line, height, out, v, z);
    for (let y = 0; y < height; y++) grid[y * width + x] = out[y] ?? FAR;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) line[x] = grid[y * width + x] ?? FAR;
    transform1d(line, width, out, v, z);
    for (let x = 0; x < width; x++) grid[y * width + x] = out[x] ?? FAR;
  }
  return grid;
}

function transform1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  const intersect = (q: number, p: number): number =>
    ((f[q] ?? FAR) + q * q - ((f[p] ?? FAR) + p * p)) / (2 * q - 2 * p);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = intersect(q, v[k] ?? 0);
    // z[0] is -Infinity, so this never pops past the first parabola.
    while (s <= (z[k] ?? -Infinity)) {
      k--;
      s = intersect(q, v[k] ?? 0);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] ?? Infinity) < q) k++;
    const p = v[k] ?? 0;
    d[q] = (q - p) * (q - p) + (f[p] ?? FAR);
  }
}
