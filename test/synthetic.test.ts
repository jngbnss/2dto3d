import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconstructFromViews, renderToDirectory } from "../src/pipeline.ts";
import { normalizedChamferDistance } from "../src/quality.ts";
import { syntheticFixtures } from "../src/synthetic.ts";

test("synthetic regression catalog contains every required ground-truth shape", () => {
  const fixtures = syntheticFixtures();
  assert.deepEqual(Object.keys(fixtures), ["sphere", "cylinder", "cup-handle", "hole-box", "asymmetric"]);
  for (const [id, mesh] of Object.entries(fixtures)) {
    assert.ok(mesh.positions.length > 0, `${id} positions`);
    assert.ok(mesh.indices.length > 0, `${id} indices`);
  }
});

test("sphere geometry reconstruction stays close to ground truth", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sixview-sphere-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const truth = syntheticFixtures().sphere;
  const views = await renderToDirectory(truth, join(directory, "input"), { size: 256 });
  const result = await reconstructFromViews(views.paths, {}, {
    outputDirectory: join(directory, "result"),
    method: "geometry",
    resolution: 96,
  });

  assert.equal(result.method, "geometry", result.warning);
  assert.ok(result.shapeScore > 0.94, `shape ${result.shapeScore.toFixed(3)}`);
  assert.ok(normalizedChamferDistance(truth, result.mesh) < 0.04);
});

test("cup handle reconstruction preserves the visible loop", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sixview-cup-handle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const truth = syntheticFixtures()["cup-handle"];
  const views = await renderToDirectory(truth, join(directory, "input"), { size: 256 });
  const result = await reconstructFromViews(views.paths, {}, {
    outputDirectory: join(directory, "result"),
    method: "silhouette",
    resolution: 128,
    smoothing: 0,
  });

  const front = result.comparisons.find((comparison) => comparison.id === "front");
  assert.ok(front && front.iou > 0.95, `front ${front?.iou.toFixed(3)}`);
  assert.ok(result.shapeScore > 0.93, `shape ${result.shapeScore.toFixed(3)}`);
  assert.ok(normalizedChamferDistance(truth, result.mesh) < 0.13);
});
