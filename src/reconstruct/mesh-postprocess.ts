import { computeBounds, type Mesh } from "../mesh/types.ts";

/**
 * Clean-up after surface extraction, tuned to keep the silhouettes intact:
 *
 * - components below `minComponentFraction` of the triangles are dropped (specks
 *   from mask noise that no view confirms as part of the object);
 * - Taubin λ|μ smoothing removes grid ripple without the shrinkage plain
 *   Laplacian smoothing causes, and every vertex is clamped to `maxDisplacement`
 *   of where extraction put it, so smoothing can never pull the outline more
 *   than a fraction of a cell away from the carved silhouette.
 */

export interface PostprocessOptions {
  readonly minComponentFraction?: number;
  readonly iterations?: number;
  /** World-unit radius each vertex may move from its extracted position. */
  readonly maxDisplacement: number;
}

const LAMBDA = 0.5;
const MU = -0.53;

export function postprocessMesh(mesh: Mesh, options: PostprocessOptions): Mesh {
  const kept = removeSmallComponents(mesh, options.minComponentFraction ?? 0.02);
  return smoothWithinBand(kept, options.iterations ?? 12, options.maxDisplacement);
}

/** Drops connected components (by shared vertices) smaller than `fraction` of all triangles. */
export function removeSmallComponents(mesh: Mesh, fraction: number): Mesh {
  const vertexCount = mesh.positions.length / 3;
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (v: number): number => {
    let root = v;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    while ((parent[v] ?? v) !== root) {
      const next = parent[v] ?? v;
      parent[v] = root;
      v = next;
    }
    return root;
  };
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = find(mesh.indices[t] ?? 0);
    parent[find(mesh.indices[t + 1] ?? 0)] = a;
    parent[find(mesh.indices[t + 2] ?? 0)] = a;
  }

  const triangles = new Map<number, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const root = find(mesh.indices[t] ?? 0);
    triangles.set(root, (triangles.get(root) ?? 0) + 1);
  }
  const total = mesh.indices.length / 3;
  const keep = new Set([...triangles].filter(([, count]) => count >= total * fraction).map(([root]) => root));
  if (keep.size === triangles.size) return mesh;

  const remap = new Int32Array(vertexCount).fill(-1);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const hasColor = mesh.colors.length === mesh.positions.length;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    if (!keep.has(find(mesh.indices[t] ?? 0))) continue;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t + k] ?? 0;
      if (remap[v] === -1) {
        remap[v] = positions.length / 3;
        positions.push(mesh.positions[v * 3] ?? 0, mesh.positions[v * 3 + 1] ?? 0, mesh.positions[v * 3 + 2] ?? 0);
        if (hasColor) colors.push(mesh.colors[v * 3] ?? 0, mesh.colors[v * 3 + 1] ?? 0, mesh.colors[v * 3 + 2] ?? 0);
      }
      indices.push(remap[v] ?? 0);
    }
  }
  const positionArray = Float32Array.from(positions);
  return {
    positions: positionArray,
    indices: Uint32Array.from(indices),
    colors: hasColor ? Float32Array.from(colors) : new Float32Array(0),
    bounds: computeBounds(positionArray),
  };
}

/** Taubin smoothing over the edge graph, each vertex confined to a ball around its start. */
export function smoothWithinBand(mesh: Mesh, iterations: number, radius: number): Mesh {
  if (iterations <= 0) return mesh;
  const vertexCount = mesh.positions.length / 3;
  const { offsets, neighbours } = adjacency(mesh, vertexCount);
  const start = Float32Array.from(mesh.positions);
  let current = Float32Array.from(mesh.positions);
  let next = new Float32Array(current.length);

  for (let pass = 0; pass < iterations * 2; pass++) {
    const factor = pass % 2 === 0 ? LAMBDA : MU;
    for (let v = 0; v < vertexCount; v++) {
      const from = offsets[v] ?? 0;
      const to = offsets[v + 1] ?? 0;
      for (let k = 0; k < 3; k++) {
        const own = current[v * 3 + k] ?? 0;
        if (to === from) {
          next[v * 3 + k] = own;
          continue;
        }
        let sum = 0;
        for (let s = from; s < to; s++) sum += current[(neighbours[s] ?? 0) * 3 + k] ?? 0;
        next[v * 3 + k] = own + factor * (sum / (to - from) - own);
      }
      // Clamp to the band around the extracted surface.
      const dx = (next[v * 3] ?? 0) - (start[v * 3] ?? 0);
      const dy = (next[v * 3 + 1] ?? 0) - (start[v * 3 + 1] ?? 0);
      const dz = (next[v * 3 + 2] ?? 0) - (start[v * 3 + 2] ?? 0);
      const distance = Math.hypot(dx, dy, dz);
      if (distance > radius) {
        const k = radius / distance;
        next[v * 3] = (start[v * 3] ?? 0) + dx * k;
        next[v * 3 + 1] = (start[v * 3 + 1] ?? 0) + dy * k;
        next[v * 3 + 2] = (start[v * 3 + 2] ?? 0) + dz * k;
      }
    }
    [current, next] = [next, current];
  }
  return { ...mesh, positions: current, bounds: computeBounds(current) };
}

/** Unique vertex neighbours in CSR form. */
export function adjacency(mesh: Mesh, vertexCount: number): { offsets: Uint32Array; neighbours: Uint32Array } {
  const sets: Array<Set<number>> = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] ?? 0;
    const b = mesh.indices[t + 1] ?? 0;
    const c = mesh.indices[t + 2] ?? 0;
    sets[a]?.add(b).add(c);
    sets[b]?.add(a).add(c);
    sets[c]?.add(a).add(b);
  }
  const offsets = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] = (offsets[v] ?? 0) + (sets[v]?.size ?? 0);
  const neighbours = new Uint32Array(offsets[vertexCount] ?? 0);
  for (let v = 0; v < vertexCount; v++) {
    let slot = offsets[v] ?? 0;
    for (const n of sets[v] ?? []) neighbours[slot++] = n;
  }
  return { offsets, neighbours };
}
