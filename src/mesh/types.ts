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

/** Rotates 180° about +Y: a subject facing -Z ends up facing +Z. Winding is preserved. */
export function turnAround(mesh: Mesh): Mesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    positions[i] = -(mesh.positions[i] ?? 0);
    positions[i + 1] = mesh.positions[i + 1] ?? 0;
    positions[i + 2] = -(mesh.positions[i + 2] ?? 0);
  }
  return { ...mesh, positions, bounds: computeBounds(positions) };
}

/** Area-weighted unit vertex normals: smooth shading across the shared vertices of a welded mesh. */
export function vertexNormals(mesh: Mesh): Float32Array {
  const p = mesh.positions;
  const normals = new Float32Array(p.length);
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = (mesh.indices[t] ?? 0) * 3;
    const b = (mesh.indices[t + 1] ?? 0) * 3;
    const c = (mesh.indices[t + 2] ?? 0) * 3;
    const ux = (p[b] ?? 0) - (p[a] ?? 0);
    const uy = (p[b + 1] ?? 0) - (p[a + 1] ?? 0);
    const uz = (p[b + 2] ?? 0) - (p[a + 2] ?? 0);
    const vx = (p[c] ?? 0) - (p[a] ?? 0);
    const vy = (p[c + 1] ?? 0) - (p[a + 1] ?? 0);
    const vz = (p[c + 2] ?? 0) - (p[a + 2] ?? 0);
    // Unnormalised cross product: its length is twice the face area.
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      normals[v] = (normals[v] ?? 0) + nx;
      normals[v + 1] = (normals[v + 1] ?? 0) + ny;
      normals[v + 2] = (normals[v + 2] ?? 0) + nz;
    }
  }
  for (let i = 0; i + 2 < normals.length; i += 3) {
    const length = Math.hypot(normals[i] ?? 0, normals[i + 1] ?? 0, normals[i + 2] ?? 0);
    if (length === 0) {
      normals[i + 1] = 1;
      continue;
    }
    normals[i] = (normals[i] ?? 0) / length;
    normals[i + 1] = (normals[i + 1] ?? 0) / length;
    normals[i + 2] = (normals[i + 2] ?? 0) / length;
  }
  return normals;
}

/** Scales positions per axis about the origin. */
export function scaleMesh(mesh: Mesh, scale: readonly [number, number, number]): Mesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    positions[i] = (mesh.positions[i] ?? 0) * scale[0];
    positions[i + 1] = (mesh.positions[i + 1] ?? 0) * scale[1];
    positions[i + 2] = (mesh.positions[i + 2] ?? 0) * scale[2];
  }
  return { ...mesh, positions, bounds: computeBounds(positions) };
}
