import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoMesh } from "../src/mesh/primitives.ts";
import { computeBounds, scaleMesh, type Mesh } from "../src/mesh/types.ts";
import { reconstructFromViews, renderToDirectory } from "../src/pipeline.ts";
import { prepareViewSet, type PreparedSet } from "../src/preprocess.ts";
import { buildHullField } from "../src/reconstruct/voxel-reconstruct.ts";
import { correctToHull, fitToViews, trilinear } from "../src/reconstruct/ai-correct.ts";

const SIZE = 256;

async function fixture(): Promise<{ directory: string; set: PreparedSet }> {
  const directory = await mkdtemp(join(tmpdir(), "sixview-ai-"));
  const render = await renderToDirectory(demoMesh(), directory, { size: SIZE });
  return { directory, set: await prepareViewSet(render.paths) };
}

/** Quarter turn about +Y plus a shift: how a generator may hand a subject back. */
function turnedAndShifted(mesh: Mesh): Mesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = mesh.positions[i] ?? 0;
    const z = mesh.positions[i + 2] ?? 0;
    positions[i] = z * 1.7 + 0.4;
    positions[i + 1] = (mesh.positions[i + 1] ?? 0) * 1.7 - 0.2;
    positions[i + 2] = -x * 1.7;
  }
  return { ...mesh, positions, bounds: computeBounds(positions) };
}

test("a generated shape handed back turned, scaled and shifted is put back into the views' frame", async (t) => {
  const { directory, set } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const silhouettes = new Map([...set.views].map(([id, view]) => [id, view.silhouette] as const));

  const fit = fitToViews(turnedAndShifted(demoMesh()), silhouettes, { pixelsPerUnit: set.pixelsPerUnit, extent: set.alignment.extent });

  assert.notEqual(fit.yaw, 0, "the quarter turn must be undone");
  assert.ok(fit.iou > 0.93, `fitted IoU ${fit.iou.toFixed(3)}`);
});

test("silhouette correction pulls an oversized shape back inside the hull", async (t) => {
  const { directory, set } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const silhouettes = new Map([...set.views].map(([id, view]) => [id, view.silhouette] as const));
  const frame = { pixelsPerUnit: set.pixelsPerUnit, extent: set.alignment.extent };
  const hull = buildHullField(silhouettes, frame, { resolution: 96 });
  // The right shape, fitted, then inflated 12%: everything overhangs.
  const fitted = fitToViews(demoMesh(), silhouettes, frame).mesh;
  const inflated = scaleMesh(fitted, [1.12, 1.12, 1.12]);

  const worst = (mesh: Mesh): number => {
    let min = Infinity;
    for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
      min = Math.min(min, trilinear(hull, mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0));
    }
    return min;
  };
  const corrected = correctToHull(inflated, hull);

  assert.ok(worst(inflated) < -hull.cell * 4, "the inflated shape overhangs the hull");
  // Allowed slack (2.5 cells) plus the final smoothing band (1 cell).
  assert.ok(worst(corrected) > -hull.cell * 3.6, `worst overhang ${(worst(corrected) / hull.cell).toFixed(2)} cells`);
});

test("the AI method falls back to silhouettes and says why when generation fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sixview-ai-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const render = await renderToDirectory(demoMesh(), directory, { size: SIZE });
  const saved = process.env["FAL_KEY"];
  delete process.env["FAL_KEY"];
  t.after(() => {
    if (saved !== undefined) process.env["FAL_KEY"] = saved;
  });

  // fal needs a key; without one the generator throws before any network call.
  const result = await reconstructFromViews(render.paths, {}, { outputDirectory: directory, method: "ai", provider: "fal", resolution: 96 });

  assert.equal(result.method, "silhouette");
  assert.match(result.warning ?? "", /AI 형상 생성에 실패/);
  assert.ok(result.score > 0.93);
});
