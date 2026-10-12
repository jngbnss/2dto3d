import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { demoMesh } from "../src/mesh/primitives.ts";
import { renderToDirectory } from "../src/pipeline.ts";
import { analyzeViewSet, type ViewPaths } from "../src/analyze/report.ts";
import type { ViewId } from "../src/views.ts";

const SIZE = 256;

async function renderFixture(): Promise<{ directory: string; paths: ViewPaths }> {
  const directory = await mkdtemp(join(tmpdir(), "sixview-"));
  const render = await renderToDirectory(demoMesh(), directory, { size: SIZE });
  return { directory, paths: render.paths };
}

/** Rewrites one view, keeping the frame size so only the object changes. */
async function replaceView(
  paths: ViewPaths,
  id: ViewId,
  transform: (image: sharp.Sharp) => sharp.Sharp,
): Promise<void> {
  const path = paths[id];
  assert.ok(path, `fixture missing ${id}`);
  const source = await sharp(path).toBuffer();
  await writeFile(path, await transform(sharp(source)).png().toBuffer());
}

test("clean six-view render passes and recovers the mesh proportions", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const report = await analyzeViewSet(paths);

  assert.equal(report.verdict, "pass");
  assert.equal(report.missing.length, 0);
  assert.deepEqual(
    report.issues.filter((issue) => issue.severity === "error"),
    [],
  );

  // demoMesh spans X 1.00, Y 2.20, Z 1.10 world units.
  assert.ok(Math.abs(report.proportions.y - 1) < 0.01, `y=${report.proportions.y}`);
  assert.ok(Math.abs(report.proportions.x - 1.0 / 2.2) < 0.02, `x=${report.proportions.x}`);
  assert.ok(Math.abs(report.proportions.z - 1.1 / 2.2) < 0.02, `z=${report.proportions.z}`);

  const dimension = report.checks.find((check) => check.id === "dimension");
  assert.ok(dimension && dimension.score > 0.98);
});

test("a rescaled view breaks axis agreement and names the offending view", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  // The right view now claims a 30% wider object than top/bottom do. sharp applies
  // one resize per pipeline, so the stretch and the re-frame run as two passes.
  const rightPath = paths.right;
  assert.ok(rightPath);
  const stretched = await sharp(rightPath)
    .resize(Math.round(SIZE * 1.3), SIZE, { fit: "fill" })
    .png()
    .toBuffer();
  await writeFile(
    rightPath,
    await sharp(stretched)
      .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer(),
  );

  const report = await analyzeViewSet(paths);
  const dimension = report.checks.find((check) => check.id === "dimension");

  assert.ok(dimension && dimension.score < 0.85, `score=${dimension?.score}`);
  assert.ok(
    report.issues.some((issue) => issue.views.includes("right")),
    "expected an issue attributed to the right view",
  );
  assert.notEqual(report.verdict, "pass");
});

test("a view that disagrees with its opposite collapses the mirror check", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Paste the top view into the back slot: plausible on its own, impossible as
  // the mirror of the front view.
  const top = paths.top;
  assert.ok(top);
  await replaceView(paths, "back", () => sharp(top));

  const report = await analyzeViewSet(paths);
  const mirror = report.checks.find((check) => check.id === "mirror");

  assert.ok(mirror && mirror.score < 0.5, `score=${mirror?.score}`);
  assert.equal(report.verdict, "fail");
  assert.ok(
    report.issues.some(
      (issue) => issue.severity === "error" && issue.views.includes("back"),
    ),
    "expected an error naming the back view",
  );
});

test("a fragmented silhouette is reported as a broken view", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Erase a horizontal band so the chair splits into two blobs. `dest-out` keys
  // on the eraser's alpha, so the band must be opaque.
  await replaceView(paths, "front", (image) =>
    image.composite([
      {
        input: {
          create: {
            width: SIZE,
            height: 24,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 255 },
          },
        },
        top: Math.round(SIZE * 0.45),
        left: 0,
        blend: "dest-out",
      },
    ]),
  );

  const report = await analyzeViewSet(paths);
  const integrity = report.checks.find((check) => check.id === "integrity");

  assert.ok(integrity && integrity.score < 1);
  assert.ok(
    report.issues.some(
      (issue) => issue.views.includes("front") && issue.message.includes("조각"),
    ),
    "expected a fragmentation issue on the front view",
  );
});

test("missing views fail the verdict instead of scoring well on what is left", async (t) => {
  const { directory, paths } = await renderFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const partial: ViewPaths = { ...paths };
  delete partial.bottom;
  delete partial.top;

  const report = await analyzeViewSet(partial);

  assert.deepEqual(report.missing, ["top", "bottom"]);
  assert.equal(report.verdict, "fail");
  assert.equal(report.views.length, 4);
  assert.equal(
    report.issues.filter((issue) => issue.severity === "error").length,
    2,
    "one error per missing view",
  );
});
