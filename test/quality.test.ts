import { strict as assert } from "node:assert";
import { test } from "node:test";
import { boxMesh, mergeMeshes } from "../src/mesh/primitives.ts";
import { computeBounds, type Mesh } from "../src/mesh/types.ts";
import { inspectMesh } from "../src/quality.ts";

test("mesh quality reports a closed manifold box", () => {
  const quality = inspectMesh(boxMesh({ size: [1, 1, 1] }));
  assert.equal(quality.components, 1);
  assert.equal(quality.boundaryEdges, 0);
  assert.equal(quality.nonManifoldEdges, 0);
  assert.equal(quality.degenerateTriangles, 0);
  assert.equal(quality.selfIntersections, 0);
});

test("mesh quality detects intersecting disconnected solids", () => {
  const mesh = mergeMeshes([
    boxMesh({ size: [1, 1, 1] }),
    boxMesh({ size: [1, 1, 1], at: [0.4, 0.3, 0.2] }),
  ]);
  const quality = inspectMesh(mesh);
  assert.ok(quality.components > 1);
  assert.ok((quality.selfIntersections ?? 0) > 0, JSON.stringify(quality));
});

test("mesh quality detects an open triangle", () => {
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const mesh: Mesh = {
    positions,
    indices: Uint32Array.from([0, 1, 2]),
    colors: new Float32Array(0),
    bounds: computeBounds(positions),
  };
  const quality = inspectMesh(mesh);
  assert.equal(quality.components, 1);
  assert.equal(quality.boundaryEdges, 3);
});
