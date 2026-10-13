import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { demoMesh } from "../src/mesh/primitives.ts";
import { scaleMesh, type Mesh } from "../src/mesh/index.ts";
import { renderToDirectory } from "../src/pipeline.ts";
import { analyzeViewSet, type ViewPaths } from "../src/analyze/report.ts";
import type { ViewSetReport } from "../src/analyze/types.ts";
import { IDENTITY_TRANSFORM } from "../src/orientation.ts";
import type { ViewId } from "../src/views.ts";

const SIZE = 256;

async function renderFixture(mesh: Mesh = demoMesh()): Promise<{ directory: string; paths: ViewPaths }> {
  const directory = await mkdtemp(join(tmpdir(), "sixview-"));
  const render = await renderToDirectory(mesh, directory, { size: SIZE });
  return { directory, paths: render.paths };
}

/** Rewrites one view, keeping the frame size so only the object changes. */
async function replaceView(paths: ViewPaths, id: ViewId, transform: (image: sharp.Sharp) => sharp.Sharp): Promise<void> {
  const path = paths[id];
  assert.ok(path, `fixture missing ${id}`);
  const source = await sharp(path).toBuffer();
  await writeFile(path, await transform(sharp(source)).png().toBuffer());
}

function check(report: ViewSetReport, id: string): number {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `missing check ${id}`);
  return found.score;
}

test("a clean five-view render passes and recovers the mesh proportions", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const report = await analyzeViewSet(paths);

  assert.equal(report.verdict, "pass");
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.issues.filter((issue) => issue.severity === "error"), []);
  // demoMesh spans X 1.00, Y 2.20, Z 1.10 world units.
  assert.ok(Math.abs(report.proportions.y - 1) < 0.01, `y=${report.proportions.y}`);
  assert.ok(Math.abs(report.proportions.x - 1.0 / 2.2) < 0.02, `x=${report.proportions.x}`);
  assert.ok(Math.abs(report.proportions.z - 1.1 / 2.2) < 0.02, `z=${report.proportions.z}`);
  assert.ok(check(report, "agreement") > 0.9);
});

test("a view framed at its own zoom is re-scaled into the common frame", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Views framed at different zooms, as reference sheets often are: shrink the front to 55%.
  const small = Math.round(SIZE * 0.55);
  const margin = (SIZE - small) / 2;
  await replaceView(paths, "front", (image) =>
    image.resize(small, small).extend({
      top: Math.floor(margin),
      bottom: Math.ceil(margin),
      left: Math.floor(margin),
      right: Math.ceil(margin),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }),
  );

  const report = await analyzeViewSet(paths);

  assert.equal(report.verdict, "pass", JSON.stringify(report.issues));
  assert.ok(Math.abs(report.proportions.x - 1.0 / 2.2) < 0.02, `x=${report.proportions.x}`);
  assert.ok(check(report, "scale") > 0.95);
});

test("a top view turned 90° is named as rotated, and the stored rotation fixes it", async (t) => {
  // Stretch Z so a 90° turn of the top view swaps clearly different extents (X 1.0 vs Z 2.2).
  const { directory, paths } = await renderFixture(scaleMesh(demoMesh(), [1, 1, 2]));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await replaceView(paths, "top", (image) => image.rotate(90));

  const rotated = await analyzeViewSet(paths);
  assert.notEqual(rotated.verdict, "pass");
  assert.ok(
    rotated.issues.some((issue) => issue.severity === "error" && issue.views.includes("top") && issue.message.includes("90°")),
    JSON.stringify(rotated.issues),
  );

  const corrected = await analyzeViewSet(paths, { top: { ...IDENTITY_TRANSFORM, rotation: 270 } });
  assert.equal(corrected.verdict, "pass", JSON.stringify(corrected.issues));
});

test("a view that contradicts the others fails agreement and is named", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  // The left view pasted into the back slot: a plausible image, the wrong object side.
  const left = paths.left;
  assert.ok(left);
  await replaceView(paths, "back", () => sharp(left));

  const report = await analyzeViewSet(paths);

  assert.equal(report.verdict, "fail");
  assert.ok(check(report, "agreement") < 0.8, `agreement=${check(report, "agreement")}`);
  assert.ok(report.issues.some((issue) => issue.severity === "error" && issue.views.includes("back")));
});

test("a fragmented silhouette is reported as a broken view", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Erase a horizontal band so the chair splits into two blobs. `dest-out` keys
  // on the eraser's alpha, so the band must be opaque.
  await replaceView(paths, "front", (image) =>
    image.composite([
      {
        input: { create: { width: SIZE, height: 24, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } } },
        top: Math.round(SIZE * 0.45),
        left: 0,
        blend: "dest-out",
      },
    ]),
  );

  const report = await analyzeViewSet(paths);

  assert.ok(check(report, "input") < 1);
  assert.ok(report.issues.some((issue) => issue.views.includes("front") && issue.message.includes("조각")));
});

test("a missing top view fails the set instead of scoring well on the rest", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const partial: ViewPaths = { ...paths };
  delete partial.top;
  const report = await analyzeViewSet(partial);

  assert.deepEqual(report.missing, ["top"]);
  assert.equal(report.verdict, "fail");
  assert.ok(report.issues.some((issue) => issue.severity === "error" && issue.views.includes("top")));
});
