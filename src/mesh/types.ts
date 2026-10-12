export type MeshFormat = "glb" | "obj";

export interface Mesh {
  /** Vertex positions, xyz triples. */
  readonly positions: Float32Array;
  /** Triangle vertex indices, 3 per face. */
  readonly indices: Uint32Array;
  /** Per-vertex colours in 0..1, rgb triples. Empty when the asset has none. */
  readonly colors: Float32Array;
  readonly bounds: Bounds;
}

export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export function computeBounds(positions: Float32Array): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Recentres a mesh on its bounding-box centre. The renderer needs the object
 * centred, otherwise every view inherits the asset's arbitrary origin offset and
 * the framing check fires on all six views at once.
 */
export function center(mesh: Mesh): Mesh {
  const cx = (mesh.bounds.min[0] + mesh.bounds.max[0]) / 2;
  const cy = (mesh.bounds.min[1] + mesh.bounds.max[1]) / 2;
  const cz = (mesh.bounds.min[2] + mesh.bounds.max[2]) / 2;
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    positions[i] = (mesh.positions[i] ?? 0) - cx;
    positions[i + 1] = (mesh.positions[i + 1] ?? 0) - cy;
    positions[i + 2] = (mesh.positions[i + 2] ?? 0) - cz;
  }
  return { ...mesh, positions, bounds: computeBounds(positions) };
}
