import { computeBounds, type Mesh } from "./types.ts";

export interface BoxSpec {
  readonly size: readonly [number, number, number];
  readonly at?: readonly [number, number, number];
  readonly color?: readonly [number, number, number];
}

const BOX_FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 2, 3], // -z
  [5, 4, 7, 6], // +z
  [4, 0, 3, 7], // -x
  [1, 5, 6, 2], // +x
  [3, 2, 6, 7], // +y
  [4, 5, 1, 0], // -y
];

export function boxMesh(spec: BoxSpec): Mesh {
  const [sx, sy, sz] = spec.size;
  const [ox, oy, oz] = spec.at ?? [0, 0, 0];
  const [cr, cg, cb] = spec.color ?? [0.8, 0.8, 0.85];
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;

  const corners: Array<readonly [number, number, number]> = [
    [ox - hx, oy - hy, oz - hz],
    [ox + hx, oy - hy, oz - hz],
    [ox + hx, oy + hy, oz - hz],
    [ox - hx, oy + hy, oz - hz],
    [ox - hx, oy - hy, oz + hz],
    [ox + hx, oy - hy, oz + hz],
    [ox + hx, oy + hy, oz + hz],
    [ox - hx, oy + hy, oz + hz],
  ];

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const face of BOX_FACES) {
    const base = positions.length / 3;
    for (const corner of face) {
      const point = corners[corner] ?? [0, 0, 0];
      positions.push(point[0], point[1], point[2]);
      colors.push(cr, cg, cb);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const positionArray = Float32Array.from(positions);
  return {
    positions: positionArray,
    indices: Uint32Array.from(indices),
    colors: Float32Array.from(colors),
    bounds: computeBounds(positionArray),
  };
}

export function mergeMeshes(meshes: readonly Mesh[]): Mesh {
  let vertexCount = 0;
  let indexCount = 0;
  for (const mesh of meshes) {
    vertexCount += mesh.positions.length;
    indexCount += mesh.indices.length;
  }

  const positions = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let positionOffset = 0;
  let indexOffset = 0;
  let base = 0;

  for (const mesh of meshes) {
    positions.set(mesh.positions, positionOffset);
    if (mesh.colors.length === mesh.positions.length) {
      colors.set(mesh.colors, positionOffset);
    } else {
      colors.fill(1, positionOffset, positionOffset + mesh.positions.length);
    }
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[indexOffset + i] = base + (mesh.indices[i] ?? 0);
    }
    positionOffset += mesh.positions.length;
    indexOffset += mesh.indices.length;
    base += mesh.positions.length / 3;
  }

  return { positions, indices, colors, bounds: computeBounds(positions) };
}

/**
 * Built-in demo solid: an asymmetric blocky chair. Its three axis extents are all
 * different (X 1.00, Y 2.20, Z 1.10), so a swapped view or a wrong axis mapping
 * shows up in the report instead of hiding behind a cube's symmetry.
 */
export function demoMesh(): Mesh {
  return mergeMeshes([
    boxMesh({ size: [1.0, 0.12, 1.1], at: [0, 0.5, 0], color: [0.78, 0.55, 0.32] }),
    boxMesh({ size: [1.0, 1.2, 0.12], at: [0, 1.1, -0.49], color: [0.72, 0.48, 0.28] }),
    boxMesh({ size: [0.12, 1.0, 0.12], at: [-0.4, 0, -0.45], color: [0.55, 0.38, 0.22] }),
    boxMesh({ size: [0.12, 1.0, 0.12], at: [0.4, 0, -0.45], color: [0.55, 0.38, 0.22] }),
    boxMesh({ size: [0.12, 1.0, 0.12], at: [-0.4, 0, 0.45], color: [0.55, 0.38, 0.22] }),
    boxMesh({ size: [0.12, 1.0, 0.12], at: [0.4, 0, 0.45], color: [0.55, 0.38, 0.22] }),
  ]);
}
