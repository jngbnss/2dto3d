import ManifoldModule from "manifold-3d";
import { computeBounds, type Mesh } from "../mesh/types.ts";
import type { HullField } from "./voxel-reconstruct.ts";

type ManifoldRuntime = Awaited<ReturnType<typeof ManifoldModule>>;
let runtimePromise: Promise<ManifoldRuntime> | undefined;

function manifoldRuntime(): Promise<ManifoldRuntime> {
  runtimePromise ??= ManifoldModule().then((module) => {
    module.setup();
    return module;
  });
  return runtimePromise;
}

/**
 * Robust SDF extraction backed by Manifold's body-centred-cubic level-set
 * polygonizer. Used only when the faster Surface Nets result is non-manifold.
 */
export async function extractManifoldSurface(field: HullField): Promise<Mesh> {
  const module = await manifoldRuntime();
  const max = [
    field.origin[0] + (field.nx - 1) * field.cell,
    field.origin[1] + (field.ny - 1) * field.cell,
    field.origin[2] + (field.nz - 1) * field.cell,
  ] as [number, number, number];
  const solid = module.Manifold.levelSet(
    (point) => sampleField(field, point),
    { min: [...field.origin], max },
    field.cell * 1.25,
  );
  try {
    const output = solid.getMesh();
    const positions = new Float32Array(output.numVert * 3);
    for (let vertex = 0; vertex < output.numVert; vertex++) {
      const source = vertex * output.numProp;
      positions[vertex * 3] = output.vertProperties[source] ?? 0;
      positions[vertex * 3 + 1] = output.vertProperties[source + 1] ?? 0;
      positions[vertex * 3 + 2] = output.vertProperties[source + 2] ?? 0;
    }
    if (output.triVerts.length === 0) throw new Error("Manifold level-set extractor returned an empty mesh");
    return {
      positions,
      indices: Uint32Array.from(output.triVerts),
      colors: new Float32Array(0),
      bounds: computeBounds(positions),
    };
  } finally {
    solid.delete();
  }
}

function sampleField(field: HullField, point: readonly number[]): number {
  const gx = (Number(point[0]) - field.origin[0]) / field.cell;
  const gy = (Number(point[1]) - field.origin[1]) / field.cell;
  const gz = (Number(point[2]) - field.origin[2]) / field.cell;
  const x0 = clampIndex(Math.floor(gx), field.nx);
  const y0 = clampIndex(Math.floor(gy), field.ny);
  const z0 = clampIndex(Math.floor(gz), field.nz);
  const x1 = Math.min(field.nx - 1, x0 + 1);
  const y1 = Math.min(field.ny - 1, y0 + 1);
  const z1 = Math.min(field.nz - 1, z0 + 1);
  const fx = Math.max(0, Math.min(1, gx - x0));
  const fy = Math.max(0, Math.min(1, gy - y0));
  const fz = Math.max(0, Math.min(1, gz - z0));
  const at = (x: number, y: number, z: number): number => field.values[x + field.nx * (y + field.ny * z)] ?? -field.cell;
  const z0y0 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
  const z0y1 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
  const z1y0 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
  const z1y1 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
  return (z0y0 * (1 - fy) + z0y1 * fy) * (1 - fz) + (z1y0 * (1 - fy) + z1y1 * fy) * fz;
}

function clampIndex(index: number, size: number): number {
  return Math.max(0, Math.min(size - 1, index));
}
