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

export function sphereMesh(radius = 0.5, rings = 32, sectors = 48): Mesh {
  const positions: number[] = [0, radius, 0, 0, -radius, 0];
  const indices: number[] = [];
  for (let ring = 1; ring < rings; ring++) {
    const polar = (ring / rings) * Math.PI;
    for (let sector = 0; sector < sectors; sector++) {
      const azimuth = (sector / sectors) * Math.PI * 2;
      positions.push(radius * Math.sin(polar) * Math.cos(azimuth), radius * Math.cos(polar), radius * Math.sin(polar) * Math.sin(azimuth));
    }
  }
  const top = 0;
  const bottom = 1;
  const at = (ring: number, sector: number) => 2 + (ring - 1) * sectors + (sector % sectors);
  for (let sector = 0; sector < sectors; sector++) indices.push(top, at(1, sector + 1), at(1, sector));
  for (let ring = 1; ring + 1 < rings; ring++) for (let sector = 0; sector < sectors; sector++) {
    const a = at(ring, sector);
    const b = at(ring, sector + 1);
    const c = at(ring + 1, sector + 1);
    const d = at(ring + 1, sector);
    indices.push(a, b, c, a, c, d);
  }
  for (let sector = 0; sector < sectors; sector++) indices.push(bottom, at(rings - 1, sector), at(rings - 1, sector + 1));
  const positionArray = Float32Array.from(positions);
  return { positions: positionArray, indices: Uint32Array.from(indices), colors: new Float32Array(0), bounds: computeBounds(positionArray) };
}

/** Tube swept along a polyline; intended for handles, hoses and curved members. */
export function sweptTubeMesh(
  points: ReadonlyArray<readonly [number, number, number]>,
  radius: number,
  sectors = 16,
): Mesh {
  if (points.length < 2) throw new Error("swept tube needs at least two points");
  const positions: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    const previous = points[Math.max(0, index - 1)]!;
    const next = points[Math.min(points.length - 1, index + 1)]!;
    const tx = next[0] - previous[0];
    const ty = next[1] - previous[1];
    const length = Math.hypot(tx, ty) || 1;
    const nx = -ty / length;
    const ny = tx / length;
    for (let sector = 0; sector < sectors; sector++) {
      const angle = (sector / sectors) * Math.PI * 2;
      positions.push(
        point[0] + nx * Math.cos(angle) * radius,
        point[1] + ny * Math.cos(angle) * radius,
        point[2] + Math.sin(angle) * radius,
      );
    }
  }
  for (let ring = 0; ring + 1 < points.length; ring++) for (let sector = 0; sector < sectors; sector++) {
    const next = (sector + 1) % sectors;
    const a = ring * sectors + sector;
    const b = ring * sectors + next;
    const c = (ring + 1) * sectors + next;
    const d = (ring + 1) * sectors + sector;
    indices.push(a, b, c, a, c, d);
  }
  const firstCenter = positions.length / 3;
  positions.push(...points[0]!);
  const lastCenter = positions.length / 3;
  positions.push(...points[points.length - 1]!);
  const last = (points.length - 1) * sectors;
  for (let sector = 0; sector < sectors; sector++) {
    const next = (sector + 1) % sectors;
    indices.push(firstCenter, sector, next, lastCenter, last + next, last + sector);
  }
  const positionArray = Float32Array.from(positions);
  return { positions: positionArray, indices: Uint32Array.from(indices), colors: new Float32Array(0), bounds: computeBounds(positionArray) };
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
