import { computeBounds, type Mesh } from "../mesh/types.ts";
import type { VoxelGrid } from "./carve.ts";

/**
 * Boundary-face extraction: emits a quad wherever a solid voxel touches empty
 * space or the grid edge. The result is blocky by construction, which is honest
 * about what six silhouettes can actually pin down — smoothing here would invent
 * surface detail the input never contained.
 */

/** Face offsets as [dx, dy, dz] plus the four corner offsets of the emitted quad. */
const FACES: ReadonlyArray<{
  readonly delta: readonly [number, number, number];
  readonly corners: ReadonlyArray<readonly [number, number, number]>;
}> = [
  { delta: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  { delta: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { delta: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { delta: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { delta: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { delta: [0, -1, 0], corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
];

export function surfaceMesh(grid: VoxelGrid): Mesh {
  const { nx, ny, nz, solid, color } = grid;
  // Object units with the longest axis normalised to 1.
  const longest = Math.max(grid.extent.x, grid.extent.y, grid.extent.z);
  const spanX = grid.extent.x / longest;
  const spanY = grid.extent.y / longest;
  const spanZ = grid.extent.z / longest;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const index = ix + nx * (iy + ny * iz);
        if (solid[index] !== 1) continue;
        const r = color[index * 3] ?? 1;
        const g = color[index * 3 + 1] ?? 1;
        const b = color[index * 3 + 2] ?? 1;

        for (const face of FACES) {
          const jx = ix + face.delta[0];
          const jy = iy + face.delta[1];
          const jz = iz + face.delta[2];
          const outside = jx < 0 || jy < 0 || jz < 0 || jx >= nx || jy >= ny || jz >= nz;
          if (!outside && solid[jx + nx * (jy + ny * jz)] === 1) continue;

          const base = positions.length / 3;
          for (const corner of face.corners) {
            positions.push(
              ((ix + corner[0]) / nx - 0.5) * spanX,
              ((iy + corner[1]) / ny - 0.5) * spanY,
              ((iz + corner[2]) / nz - 0.5) * spanZ,
            );
            colors.push(r, g, b);
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }

  if (positions.length === 0) throw new Error("복셀이 비어 있어 표면을 만들 수 없습니다.");
  const positionArray = Float32Array.from(positions);
  return {
    positions: positionArray,
    indices: Uint32Array.from(indices),
    colors: Float32Array.from(colors),
    bounds: computeBounds(positionArray),
  };
}

/** Wavefront OBJ with per-vertex colours, the form most viewers accept. */
export function toObj(mesh: Mesh, comment: string): string {
  const lines: string[] = [`# ${comment}`, "# sixview space carving"];
  const hasColor = mesh.colors.length === mesh.positions.length;

  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    const x = (mesh.positions[i] ?? 0).toFixed(5);
    const y = (mesh.positions[i + 1] ?? 0).toFixed(5);
    const z = (mesh.positions[i + 2] ?? 0).toFixed(5);
    if (hasColor) {
      const r = (mesh.colors[i] ?? 1).toFixed(4);
      const g = (mesh.colors[i + 1] ?? 1).toFixed(4);
      const b = (mesh.colors[i + 2] ?? 1).toFixed(4);
      lines.push(`v ${x} ${y} ${z} ${r} ${g} ${b}`);
    } else {
      lines.push(`v ${x} ${y} ${z}`);
    }
  }
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    lines.push(
      `f ${(mesh.indices[i] ?? 0) + 1} ${(mesh.indices[i + 1] ?? 0) + 1} ${(mesh.indices[i + 2] ?? 0) + 1}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
