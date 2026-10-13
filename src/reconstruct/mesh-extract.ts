import { computeBounds, type Mesh } from "../mesh/types.ts";
import type { HullField } from "./voxel-reconstruct.ts";

/**
 * Surface extraction from the hull field.
 *
 * `extractSurface` is Surface Nets (dual contouring with mass-point vertices):
 * one vertex per cell the surface crosses, placed at the mean of the field's
 * zero crossings on that cell's edges, and one quad per crossed grid edge. The
 * output is a closed, welded, manifold-friendly mesh whose vertices sit on the
 * interpolated surface — smooth where the field is smooth, with no staircase.
 *
 * `extractVoxels` emits the same solid as axis-aligned cubes, for the viewer's
 * voxel toggle and for debugging what the carve actually kept.
 */

const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7], // along x
  [0, 2], [1, 3], [4, 6], [5, 7], // along y
  [0, 4], [1, 5], [2, 6], [3, 7], // along z
];

export function extractSurface(field: HullField): Mesh {
  const { nx, ny, nz, values, origin, cell } = field;
  const cx = nx - 1;
  const cy = ny - 1;
  const cz = nz - 1;
  const cellVertex = new Int32Array(cx * cy * cz).fill(-1);
  const positions: number[] = [];
  const corner = new Float64Array(8);
  const at = (x: number, y: number, z: number): number => values[x + nx * (y + ny * z)] ?? -Infinity;

  for (let iz = 0; iz < cz; iz++) {
    for (let iy = 0; iy < cy; iy++) {
      for (let ix = 0; ix < cx; ix++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const value = at(ix + (c & 1), iy + ((c >> 1) & 1), iz + ((c >> 2) & 1));
          corner[c] = value;
          if (value > 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;

        let sx = 0;
        let sy = 0;
        let sz = 0;
        let crossings = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a] ?? 0;
          const vb = corner[b] ?? 0;
          if (va > 0 === vb > 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + t * ((b & 1) - (a & 1));
          sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
          sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
          crossings++;
        }
        cellVertex[ix + cx * (iy + cy * iz)] = positions.length / 3;
        positions.push(
          origin[0] + (ix + sx / crossings) * cell,
          origin[1] + (iy + sy / crossings) * cell,
          origin[2] + (iz + sz / crossings) * cell,
        );
      }
    }
  }

  const indices: number[] = [];
  const vertexOf = (x: number, y: number, z: number): number => cellVertex[x + cx * (y + cy * z)] ?? -1;
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, d, c, a, c, b);
    else indices.push(a, b, c, a, c, d);
  };

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const here = at(ix, iy, iz) > 0;
        // Edge +x: the four cells around it span (y-1..y, z-1..z); y×z = +x.
        if (ix < cx && iy > 0 && iy < cy && iz > 0 && iz < cz && here !== at(ix + 1, iy, iz) > 0) {
          quad(vertexOf(ix, iy - 1, iz - 1), vertexOf(ix, iy, iz - 1), vertexOf(ix, iy, iz), vertexOf(ix, iy - 1, iz), !here);
        }
        // Edge +y: cells span (z-1..z, x-1..x); z×x = +y.
        if (iy < cy && iz > 0 && iz < cz && ix > 0 && ix < cx && here !== at(ix, iy + 1, iz) > 0) {
          quad(vertexOf(ix - 1, iy, iz - 1), vertexOf(ix - 1, iy, iz), vertexOf(ix, iy, iz), vertexOf(ix, iy, iz - 1), !here);
        }
        // Edge +z: cells span (x-1..x, y-1..y); x×y = +z.
        if (iz < cz && ix > 0 && ix < cx && iy > 0 && iy < cy && here !== at(ix, iy, iz + 1) > 0) {
          quad(vertexOf(ix - 1, iy - 1, iz), vertexOf(ix, iy - 1, iz), vertexOf(ix, iy, iz), vertexOf(ix - 1, iy, iz), !here);
        }
      }
    }
  }

  if (indices.length === 0) throw new Error("실루엣 교집합이 비어 표면을 만들 수 없습니다. 뷰 방향과 정렬을 확인하세요.");
  const positionArray = Float32Array.from(positions);
  return {
    positions: positionArray,
    indices: Uint32Array.from(indices),
    colors: new Float32Array(0),
    bounds: computeBounds(positionArray),
  };
}

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

/** Every grid sample inside the hull as a cube of side `cell`, boundary faces only. */
export function extractVoxels(field: HullField): Mesh {
  const { nx, ny, nz, values, origin, cell } = field;
  const solid = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && (values[x + nx * (y + ny * z)] ?? 0) > 0;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (!solid(ix, iy, iz)) continue;
        for (const face of FACES) {
          if (solid(ix + face.delta[0], iy + face.delta[1], iz + face.delta[2])) continue;
          const base = positions.length / 3;
          for (const c of face.corners) {
            positions.push(
              origin[0] + (ix - 0.5 + c[0]) * cell,
              origin[1] + (iy - 0.5 + c[1]) * cell,
              origin[2] + (iz - 0.5 + c[2]) * cell,
            );
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }
  const positionArray = Float32Array.from(positions);
  return { positions: positionArray, indices: Uint32Array.from(indices), colors: new Float32Array(0), bounds: computeBounds(positionArray) };
}
