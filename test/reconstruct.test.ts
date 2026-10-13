import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { boxMesh, demoMesh, mergeMeshes } from "../src/mesh/primitives.ts";
import { parseGlb } from "../src/mesh/index.ts";
import { reconstructFromViews, renderToDirectory } from "../src/pipeline.ts";
import { colourDistance } from "../src/reconstruct/finish.ts";
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

test("default reconstruction preserves a unilateral product feature", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sixview-asymmetric-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = mergeMeshes([
    boxMesh({ size: [0.7, 1.4, 0.7] }),
    boxMesh({ size: [0.45, 0.28, 0.3], at: [0.52, 0.25, 0] }),
  ]);
  const paths = (await renderToDirectory(source, join(directory, "input"), { size: SIZE })).paths;

  const normal = await reconstructFromViews(paths, {}, {
    outputDirectory: join(directory, "normal"),
    resolution: RESOLUTION,
    smoothing: 0,
  });
  const forcedSymmetry = await reconstructFromViews(paths, {}, {
    outputDirectory: join(directory, "symmetric"),
    resolution: RESOLUTION,
    smoothing: 0,
    symmetry: true,
  });

  const front = normal.comparisons.find((view) => view.id === "front");
  const symmetricFront = forcedSymmetry.comparisons.find((view) => view.id === "front");
  assert.ok(front && symmetricFront);
  assert.ok(front.iou > 0.96, `default front IoU ${front.iou.toFixed(3)}`);
  assert.ok(front.iou > symmetricFront.iou + 0.08, `${front.iou.toFixed(3)} vs symmetric ${symmetricFront.iou.toFixed(3)}`);
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

test("views that agree on the surface score full colour agreement", async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await reconstructFromViews(paths, {}, { outputDirectory: directory, resolution: RESOLUTION });
  assert.ok(result.colourScore > 0.95, `colour ${result.colourScore.toFixed(3)}`);
});

test("a view painted in different colours keeps its outline but loses colour agreement", async (t) => {
  const { directory, paths } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Same silhouette, hue turned half way round: the left photo now disagrees with front, back and top.
  const left = paths.left;
  assert.ok(left);
  await writeFile(left, await sharp(await readFile(left)).modulate({ hue: 180, saturation: 2 }).png().toBuffer());

  const result = await reconstructFromViews(paths, {}, { outputDirectory: directory, resolution: RESOLUTION });
  const leftView = result.comparisons.find((c) => c.id === "left");
  assert.ok(leftView);
  assert.ok(leftView.iou > 0.93, `left IoU ${leftView.iou.toFixed(3)}`);
  assert.ok(leftView.colour < 0.6, `left colour ${leftView.colour.toFixed(3)}`);
  assert.ok(result.colourScore < 0.9, `colour ${result.colourScore.toFixed(3)}`);
});

test("colour distance tolerates shading but not a change of colour", () => {
  const white: [number, number, number] = [1, 1, 1];
  assert.ok(colourDistance(white, [0.78, 0.78, 0.78]) <= 0.15, "a shaded white is still white");
  assert.ok(colourDistance(white, [1, 0.41, 0.71]) > 0.15, "pink is not white");
  assert.ok(colourDistance([0.35, 0.2, 0.15], white) > 0.15, "brown is not white");
});
