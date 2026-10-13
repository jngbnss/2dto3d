import { VIEW_IDS, VIEWS, type ViewId } from "../views.ts";
import { center as centerMesh } from "../mesh/types.ts";
import type { Mesh } from "../mesh/types.ts";
import { BASES, type Basis } from "./basis.ts";

export interface RenderedView {
  readonly id: ViewId;
  readonly width: number;
  readonly height: number;
  /** RGBA, background alpha 0 so the analyser gets an exact silhouette. */
  readonly pixels: Uint8Array;
  /** Projected object extents in world units, before pixel scaling. */
  readonly extent: { readonly width: number; readonly height: number };
}

export interface RenderOptions {
  readonly size?: number;
  /** Fraction of the frame left empty on each side. */
  readonly margin?: number;
  /** Base surface colour used when the mesh carries no vertex colours. */
  readonly albedo?: readonly [number, number, number];
  /**
   * Fixed pixels per world unit with the world origin at the frame centre — the
   * preprocessing contract — so a render lines up pixel for pixel with the
   * prepared input views. Without it the mesh is centred and fitted to the frame.
   */
  readonly pixelsPerUnit?: number;
}

const DEFAULT_SIZE = 512;
const DEFAULT_MARGIN = 0.06;
const DEFAULT_ALBEDO = [0.82, 0.84, 0.88] as const;
const AMBIENT = 0.35;

/**
 * Renders every canonical view with one shared world-to-pixel scale.
 *
 * A per-view "fit to frame" would normalise away exactly the quantity the
 * analysis measures — the object's extent along each axis — so the scale is
 * computed once from the widest projection and reused by every view.
 */
export function renderViews(input: Mesh, options: RenderOptions = {}): Record<ViewId, RenderedView> {
  const size = options.size ?? DEFAULT_SIZE;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const albedo = options.albedo ?? DEFAULT_ALBEDO;
  const mesh = options.pixelsPerUnit === undefined ? centerMesh(input) : input;

  const half = {
    x: Math.max(Math.abs(mesh.bounds.min[0]), Math.abs(mesh.bounds.max[0])),
    y: Math.max(Math.abs(mesh.bounds.min[1]), Math.abs(mesh.bounds.max[1])),
    z: Math.max(Math.abs(mesh.bounds.min[2]), Math.abs(mesh.bounds.max[2])),
  };
  const widest = Math.max(half.x, half.y, half.z, Number.EPSILON);
  const scale = options.pixelsPerUnit ?? (size * (1 - 2 * margin)) / (2 * widest);

  const out = {} as Record<ViewId, RenderedView>;
  for (const id of VIEW_IDS) out[id] = renderView(mesh, id, size, scale, albedo);
  return out;
}

function renderView(
  mesh: Mesh,
  id: ViewId,
  size: number,
  scale: number,
  albedo: readonly [number, number, number],
): RenderedView {
  const basis = BASES[id];
  const vertexCount = mesh.positions.length / 3;
  const sx = new Float32Array(vertexCount);
  const sy = new Float32Array(vertexCount);
  const sz = new Float32Array(vertexCount);
  const center = size / 2;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < vertexCount; i++) {
    const x = mesh.positions[i * 3] ?? 0;
    const y = mesh.positions[i * 3 + 1] ?? 0;
    const z = mesh.positions[i * 3 + 2] ?? 0;
    const u = x * basis.right[0] + y * basis.right[1] + z * basis.right[2];
    const v = x * basis.up[0] + y * basis.up[1] + z * basis.up[2];
    const d = x * basis.forward[0] + y * basis.forward[1] + z * basis.forward[2];
    sx[i] = center + u * scale;
    // Image rows grow downward, so the up axis is negated here.
    sy[i] = center - v * scale;
    sz[i] = d;
    if (u < minX) minX = u;
    if (u > maxX) maxX = u;
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }

  const pixels = new Uint8Array(size * size * 4);
  const depth = new Float32Array(size * size).fill(Infinity);

  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] ?? 0;
    const b = mesh.indices[t + 1] ?? 0;
    const c = mesh.indices[t + 2] ?? 0;
    rasterize(mesh, basis, albedo, { a, b, c }, { sx, sy, sz }, pixels, depth, size);
  }

  return {
    id,
    width: size,
    height: size,
    pixels,
    extent: {
      width: Number.isFinite(maxX - minX) ? maxX - minX : 0,
      height: Number.isFinite(maxY - minY) ? maxY - minY : 0,
    },
  };
}

function rasterize(
  mesh: Mesh,
  basis: Basis,
  albedo: readonly [number, number, number],
  tri: { a: number; b: number; c: number },
  screen: { sx: Float32Array; sy: Float32Array; sz: Float32Array },
  pixels: Uint8Array,
  depth: Float32Array,
  size: number,
): void {
  const { a, b, c } = tri;
  const ax = screen.sx[a] ?? 0;
  const ay = screen.sy[a] ?? 0;
  const bx = screen.sx[b] ?? 0;
  const by = screen.sy[b] ?? 0;
  const cx = screen.sx[c] ?? 0;
  const cy = screen.sy[c] ?? 0;

  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return;

  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
  if (minX > maxX || minY > maxY) return;

  const shade = lambert(mesh, basis, tri);
  const colors = mesh.colors.length > 0 ? mesh.colors : null;
  const baseR = colors ? ((colors[a * 3] ?? 1) + (colors[b * 3] ?? 1) + (colors[c * 3] ?? 1)) / 3 : albedo[0];
  const baseG = colors ? ((colors[a * 3 + 1] ?? 1) + (colors[b * 3 + 1] ?? 1) + (colors[c * 3 + 1] ?? 1)) / 3 : albedo[1];
  const baseB = colors ? ((colors[a * 3 + 2] ?? 1) + (colors[b * 3 + 2] ?? 1) + (colors[c * 3 + 2] ?? 1)) / 3 : albedo[2];
  const r = Math.round(Math.min(255, baseR * shade * 255));
  const g = Math.round(Math.min(255, baseG * shade * 255));
  const bl = Math.round(Math.min(255, baseB * shade * 255));

  const az = screen.sz[a] ?? 0;
  const bz = screen.sz[b] ?? 0;
  const cz = screen.sz[c] ?? 0;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area;
      const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
      if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;

      const z = az + w1 * (bz - az) + w0 * (cz - az);
      const i = y * size + x;
      if (z >= (depth[i] ?? Infinity)) continue;
      depth[i] = z;
      const p = i * 4;
      pixels[p] = r;
      pixels[p + 1] = g;
      pixels[p + 2] = bl;
      pixels[p + 3] = 255;
    }
  }
}

/** Head-on light: shading never changes the silhouette, only its readability. */
function lambert(mesh: Mesh, basis: Basis, tri: { a: number; b: number; c: number }): number {
  const ax = mesh.positions[tri.a * 3] ?? 0;
  const ay = mesh.positions[tri.a * 3 + 1] ?? 0;
  const az = mesh.positions[tri.a * 3 + 2] ?? 0;
  const ux = (mesh.positions[tri.b * 3] ?? 0) - ax;
  const uy = (mesh.positions[tri.b * 3 + 1] ?? 0) - ay;
  const uz = (mesh.positions[tri.b * 3 + 2] ?? 0) - az;
  const vx = (mesh.positions[tri.c * 3] ?? 0) - ax;
  const vy = (mesh.positions[tri.c * 3 + 1] ?? 0) - ay;
  const vz = (mesh.positions[tri.c * 3 + 2] ?? 0) - az;

  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length === 0) return AMBIENT;

  const toCamera = -(
    (nx / length) * basis.forward[0] +
    (ny / length) * basis.forward[1] +
    (nz / length) * basis.forward[2]
  );
  return AMBIENT + (1 - AMBIENT) * Math.abs(toCamera);
}
