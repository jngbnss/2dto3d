import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoMesh } from "../src/mesh/primitives.ts";
import { parseGlb } from "../src/mesh/index.ts";
import { reconstructFromViews, renderToDirectory } from "../src/pipeline.ts";
import type { ViewPaths } from "../src/analyze/report.ts";

const SIZE = 256;
const RESOLUTION = 96;

async function fixture(): Promise<{ directory: string; paths: ViewPaths }> {
  const directory = await mkdtemp(join(tmpdir(), "sixview-build-"));
  const render = await renderToDirectory(demoMesh(), directory, { size: SIZE });
  return { directory, paths: render.paths };
}

test("the reconstructed mesh re-projects onto every input silhouette", async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await reconstructFromViews(paths, {}, { outputDirectory: directory, resolution: RESOLUTION });

  assert.equal(result.comparisons.length, 5);
  for (const { id, iou } of result.comparisons) assert.ok(iou > 0.93, `${id} IoU ${iou.toFixed(3)}`);

  // demoMesh spans X 1.00, Y 2.20, Z 1.10: the box-shaped chair is its own hull.
  const { min, max } = result.mesh.bounds;
  const height = max[1] - min[1];
  assert.ok(Math.abs((max[0] - min[0]) / height - 1.0 / 2.2) < 0.03);
  assert.ok(Math.abs((max[2] - min[2]) / height - 1.1 / 2.2) < 0.03);
});

test("the exported surface is closed: every edge is shared by exactly two triangles", async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await reconstructFromViews(paths, {}, { outputDirectory: directory, resolution: RESOLUTION });
  const mesh = parseGlb(await readFile(result.files.glb));

  const edges = new Map<string, number>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[i + k] ?? 0;
      const b = mesh.indices[i + ((k + 1) % 3)] ?? 0;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const open = [...edges.values()].filter((count) => count !== 2).length;
  assert.equal(open, 0, `${open} edges not shared by two triangles`);
});

test("building without the top view is refused", async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const partial: ViewPaths = { ...paths };
  delete partial.top;
  await assert.rejects(
    reconstructFromViews(partial, {}, { outputDirectory: directory, resolution: RESOLUTION }),
    /top/,
  );
});
