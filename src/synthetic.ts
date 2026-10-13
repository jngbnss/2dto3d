import { boxMesh, mergeMeshes, sphereMesh, sweptTubeMesh } from "./mesh/primitives.ts";
import type { Mesh } from "./mesh/types.ts";
import { ellipticCylinderMesh } from "./reconstruct/geometry-reconstruct.ts";

export type SyntheticFixtureId = "sphere" | "cylinder" | "cup-handle" | "hole-box" | "asymmetric";

export function syntheticFixtures(): Readonly<Record<SyntheticFixtureId, Mesh>> {
  const handlePoints = Array.from({ length: 25 }, (_, index) => {
    const angle = -Math.PI / 2 + (index / 24) * Math.PI;
    return [0.38 + Math.cos(angle) * 0.48, Math.sin(angle) * 0.48, 0] as const;
  });
  return {
    sphere: sphereMesh(0.55),
    cylinder: ellipticCylinderMesh(0.45, 1.4, 0.35),
    "cup-handle": mergeMeshes([
      ellipticCylinderMesh(0.4, 1.25, 0.4),
      sweptTubeMesh(handlePoints, 0.075),
    ]),
    "hole-box": mergeMeshes([
      boxMesh({ size: [1.2, 0.2, 0.4], at: [0, 0.7, 0] }),
      boxMesh({ size: [1.2, 0.2, 0.4], at: [0, -0.7, 0] }),
      boxMesh({ size: [0.2, 1.2, 0.4], at: [-0.5, 0, 0] }),
      boxMesh({ size: [0.2, 1.2, 0.4], at: [0.5, 0, 0] }),
    ]),
    asymmetric: mergeMeshes([
      boxMesh({ size: [0.7, 1.4, 0.7] }),
      boxMesh({ size: [0.45, 0.28, 0.3], at: [0.52, 0.25, 0] }),
    ]),
  };
}
