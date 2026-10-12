import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoMesh } from "../src/mesh/primitives.ts";
import { carveFromViews, renderToDirectory } from "../src/pipeline.ts";
import { loadMesh } from "../src/mesh/index.ts";
import { renderSixViews } from "../src/render/ortho.ts";
import { extractSilhouette } from "../src/analyze/silhouette.ts";
import { VIEW_IDS } from "../src/views.ts";

const SIZE = 192;
const RESOLUTION = 128;

test("carving six views reproduces the solid they were rendered from", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sixview-carve-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const source = demoMesh();
  const render = await renderToDirectory(source, directory, { size: SIZE });
  const carved = await carveFromViews(render.paths, join(directory, "carved.obj"), {
    resolution: RESOLUTION,
  });

  assert.equal(carved.grid.views.length, 6);
  assert.ok(carved.grid.filled > 0);
  assert.ok(carved.mesh.indices.length > 0);

  // The carved solid must project back to the same outlines: it should cover the
  // original silhouette (a visual hull is an outer approximation) and not bulge
  // far past it. Both failing would mean the carve projection disagrees with the
  // renderer's basis.
  const original = renderSixViews(source, { size: SIZE });
  const reconstructed = renderSixViews(await loadMesh(carved.objPath), { size: SIZE });

  for (const id of VIEW_IDS) {
    const a = extractSilhouette({
      width: SIZE,
      height: SIZE,
      data: original[id].pixels,
      hadAlpha: true,
      source: { width: SIZE, height: SIZE },
    });
    const b = extractSilhouette({
      width: SIZE,
      height: SIZE,
      data: reconstructed[id].pixels,
      hadAlpha: true,
      source: { width: SIZE, height: SIZE },
    });
    let intersection = 0;
    let union = 0;
    let originalArea = 0;
    for (let i = 0; i < a.mask.length; i++) {
      const inA = a.mask[i] === 1;
      const inB = b.mask[i] === 1;
      if (inA) originalArea++;
      if (inA && inB) intersection++;
      if (inA || inB) union++;
    }
    const iou = union === 0 ? 0 : intersection / union;
    const coverage = originalArea === 0 ? 0 : intersection / originalArea;
    assert.ok(coverage > 0.95, `${id} coverage=${coverage.toFixed(4)}`);
    assert.ok(iou > 0.9, `${id} IoU=${iou.toFixed(4)}`);
  }
});

test("carving keeps the proportions measured from the views", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sixview-carve-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const render = await renderToDirectory(demoMesh(), directory, { size: SIZE });
  const carved = await carveFromViews(render.paths, join(directory, "carved.obj"), {
    resolution: RESOLUTION,
  });

  // demoMesh spans X 1.00, Y 2.20, Z 1.10 world units.
  const { min, max } = carved.mesh.bounds;
  const height = max[1] - min[1];
  assert.ok(Math.abs((max[0] - min[0]) / height - 1.0 / 2.2) < 0.03);
  assert.ok(Math.abs((max[2] - min[2]) / height - 1.1 / 2.2) < 0.03);
});

test("a missing view still carves, using the remaining constraints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sixview-carve-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const render = await renderToDirectory(demoMesh(), directory, { size: SIZE });
  const partial = { ...render.paths };
  delete partial.bottom;

  const full = await carveFromViews(render.paths, join(directory, "full.obj"), {
    resolution: RESOLUTION,
  });
  const reduced = await carveFromViews(partial, join(directory, "reduced.obj"), {
    resolution: RESOLUTION,
  });

  assert.equal(reduced.grid.views.length, 5);
  // Fewer constraints can only keep more voxels, never carve away more.
  assert.ok(
    reduced.grid.filled >= full.grid.filled,
    `reduced=${reduced.grid.filled} full=${full.grid.filled}`,
  );
  assert.equal(reduced.report.verdict, "review");
});
