import { VIEWS, type Axis, type ViewId } from "../views.ts";
import { BASES } from "../render/basis.ts";
import type { ViewSample } from "../analyze/types.ts";
import type { AxisEstimate } from "../analyze/types.ts";

/**
 * Space carving (visual hull) from the six canonical views.
 *
 * A voxel survives only if it projects inside the silhouette of *every*
 * available view. The result is the tightest solid consistent with all six
 * outlines — concavities that no outline reveals (a mug's hollow, a drawer gap)
 * cannot be recovered from silhouettes alone, and that limit is inherent, not a
 * shortcut.
 */

export interface CarveOptions {
  /** Cells along the longest axis. */
  readonly resolution?: number;
  /**
   * Views a voxel may fall outside of and still survive. 0 is the strict visual
   * hull; 1 tolerates one bad view at the cost of a looser shape.
   */
  readonly tolerance?: number;
}

export interface VoxelGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** 1 = solid. Index = x + nx * (y + ny * z). */
  readonly solid: Uint8Array;
  /** Per-voxel RGB in 0..1, back-projected from the views. */
  readonly color: Float32Array;
  /** Object extents in frame fractions, used to size the grid. */
  readonly extent: Record<Axis, number>;
  readonly filled: number;
  /** Views that actually constrained the carve. */
  readonly views: readonly ViewId[];
}

const DEFAULT_RESOLUTION = 128;
/** Share of a voxel's projected footprint that must sit inside the silhouette. */
const MIN_FOOTPRINT_COVERAGE = 0.5;

export function carveVisualHull(
  samples: ReadonlyMap<ViewId, ViewSample>,
  axes: readonly AxisEstimate[],
  options: CarveOptions = {},
): VoxelGrid {
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  const tolerance = options.tolerance ?? 0;

  const extent: Record<Axis, number> = { x: 0, y: 0, z: 0 };
  for (const axis of axes) extent[axis.axis] = axis.extent;
  const longest = Math.max(extent.x, extent.y, extent.z);
  if (longest <= 0) throw new Error("뷰에서 피사체 크기를 읽지 못해 복원할 수 없습니다.");

  const nx = Math.max(1, Math.round((resolution * extent.x) / longest));
  const ny = Math.max(1, Math.round((resolution * extent.y) / longest));
  const nz = Math.max(1, Math.round((resolution * extent.z) / longest));

  const views = [...samples.values()].filter((s) => s.silhouette.area > 0);
  if (views.length === 0) throw new Error("실루엣이 있는 뷰가 없어 복원할 수 없습니다.");

  const solid = new Uint8Array(nx * ny * nz);
  const color = new Float32Array(nx * ny * nz * 3);
  let filled = 0;

  // Half a cell in each axis: the probe covers the voxel's footprint instead of a
  // single point, so features thinner than one cell survive the discretisation.
  const hx = extent.x / nx / 2;
  const hy = extent.y / ny / 2;
  const hz = extent.z / nz / 2;

  for (let iz = 0; iz < nz; iz++) {
    const pz = ((iz + 0.5) / nz - 0.5) * extent.z;
    for (let iy = 0; iy < ny; iy++) {
      const py = ((iy + 0.5) / ny - 0.5) * extent.y;
      for (let ix = 0; ix < nx; ix++) {
        const px = ((ix + 0.5) / nx - 0.5) * extent.x;

        let misses = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        let hits = 0;

        for (const sample of views) {
          const probe = project(sample, px, py, pz, hx, hy, hz);
          if (probe === null) {
            if (++misses > tolerance) break;
            continue;
          }
          hits++;
          r += probe.r;
          g += probe.g;
          b += probe.b;
        }
        if (misses > tolerance || hits === 0) continue;

        const index = ix + nx * (iy + ny * iz);
        solid[index] = 1;
        color[index * 3] = r / hits / 255;
        color[index * 3 + 1] = g / hits / 255;
        color[index * 3 + 2] = b / hits / 255;
        filled++;
      }
    }
  }

  return { nx, ny, nz, solid, color, extent, filled, views: views.map((v) => v.id) };
}

/**
 * Projects a voxel into one view and samples it.
 *
 * The voxel's half-extents are projected too, so the probe covers the footprint
 * the voxel occupies in this view. The voxel counts as inside when at least half
 * that footprint lands on the silhouette: point sampling erases features thinner
 * than a cell, while any-overlap inflates the hull by a full cell in every
 * direction.
 *
 * The view's own silhouette centre anchors the projection, so a view framed
 * slightly off-centre shifts with its content instead of carving the solid away.
 */
function project(
  sample: ViewSample,
  px: number,
  py: number,
  pz: number,
  hx: number,
  hy: number,
  hz: number,
): { r: number; g: number; b: number } | null {
  const basis = BASES[sample.id];
  const silhouette = sample.silhouette;

  const u = basis.right[0] * px + basis.right[1] * py + basis.right[2] * pz;
  const v = basis.up[0] * px + basis.up[1] * py + basis.up[2] * pz;
  // Axis-aligned bases make the footprint the sum of |component| half-extents.
  const du =
    Math.abs(basis.right[0]) * hx + Math.abs(basis.right[1]) * hy + Math.abs(basis.right[2]) * hz;
  const dv = Math.abs(basis.up[0]) * hx + Math.abs(basis.up[1]) * hy + Math.abs(basis.up[2]) * hz;

  const x0 = Math.round((silhouette.center.x + u - du) * silhouette.width - 0.5);
  const x1 = Math.round((silhouette.center.x + u + du) * silhouette.width - 0.5);
  const y0 = Math.round((silhouette.center.y - v - dv) * silhouette.height - 0.5);
  const y1 = Math.round((silhouette.center.y - v + dv) * silhouette.height - 0.5);

  const left = Math.max(0, Math.min(x0, x1));
  const right = Math.min(silhouette.width - 1, Math.max(x0, x1));
  const topRow = Math.max(0, Math.min(y0, y1));
  const bottom = Math.min(silhouette.height - 1, Math.max(y0, y1));
  if (left > right || topRow > bottom) return null;

  let r = 0;
  let g = 0;
  let b = 0;
  let hits = 0;
  const data = sample.raster.data;
  for (let y = topRow; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const index = y * silhouette.width + x;
      if (silhouette.mask[index] !== 1) continue;
      const p = index * 4;
      r += data[p] ?? 0;
      g += data[p + 1] ?? 0;
      b += data[p + 2] ?? 0;
      hits++;
    }
  }
  const area = (right - left + 1) * (bottom - topRow + 1);
  if (hits / area < MIN_FOOTPRINT_COVERAGE) return null;
  return { r: r / hits, g: g / hits, b: b / hits };
}

export function describeGrid(grid: VoxelGrid): string {
  const total = grid.nx * grid.ny * grid.nz;
  const missing = Object.values(VIEWS)
    .filter((spec) => !grid.views.includes(spec.id))
    .map((spec) => spec.label);
  const note = missing.length > 0 ? ` · 미사용 뷰 ${missing.join(",")}` : "";
  return `복셀 ${grid.nx}x${grid.ny}x${grid.nz} · 채움 ${grid.filled}/${total} (${((grid.filled / total) * 100).toFixed(1)}%) · 사용 뷰 ${grid.views.length}${note}`;
}
