import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { reconstructFromViews, renderToDirectory } from "../src/pipeline.ts";
import { normalizedChamferDistance } from "../src/quality.ts";
import { syntheticFixtures } from "../src/synthetic.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "tmp/regression" },
    size: { type: "string", default: "256" },
    res: { type: "string", default: "128" },
  },
});
const output = resolve(values.out ?? "tmp/regression");
const size = Number.parseInt(values.size ?? "256", 10);
const resolution = Number.parseInt(values.res ?? "128", 10);
if (!Number.isFinite(size) || size < 64) throw new Error("--size must be at least 64");
if (!Number.isFinite(resolution) || resolution < 32 || resolution > 384) throw new Error("--res must be 32..384");

await mkdir(output, { recursive: true });
const rows = [];
for (const [id, truth] of Object.entries(syntheticFixtures())) {
  const directory = join(output, id);
  const views = await renderToDirectory(truth, join(directory, "input"), { size });
  const started = performance.now();
  const result = await reconstructFromViews(views.paths, {}, {
    outputDirectory: join(directory, "result"),
    method: "hybrid",
    resolution,
  });
  const elapsedMs = performance.now() - started;
  rows.push({
    id,
    method: result.method,
    strategy: result.strategy ?? result.method,
    requestedResolution: result.requestedResolution,
    resolution: result.resolution,
    shapeScore: result.shapeScore,
    silhouetteIoU: result.score,
    textureScore: result.textureScore,
    chamfer: normalizedChamferDistance(truth, result.mesh),
    triangles: result.mesh.indices.length / 3,
    elapsedMs,
    meshQuality: result.meshQuality,
  });
  process.stdout.write(`${id}: shape ${(result.shapeScore * 100).toFixed(2)}%, chamfer ${rows.at(-1)?.chamfer.toFixed(4)}, ${elapsedMs.toFixed(0)} ms\n`);
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const markdown = [
  "# Synthetic reconstruction regression",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  `Settings: ${size}px orthographic inputs, requested voxel resolution ${resolution}, hybrid local candidates, AI network candidate disabled.`,
  "",
  "| Fixture | Strategy | Resolution | Shape | IoU | Texture | Chamfer | Components | Boundary/non-manifold | Time |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...rows.map((row) =>
    `| ${row.id} | ${row.strategy} | ${row.requestedResolution === row.resolution ? row.resolution : `${row.requestedResolution}→${row.resolution}`} | ${percent(row.shapeScore)} | ${percent(row.silhouetteIoU)} | ${percent(row.textureScore)} | ${row.chamfer.toFixed(4)} | ${row.meshQuality.components} | ${row.meshQuality.boundaryEdges}/${row.meshQuality.nonManifoldEdges} | ${(row.elapsedMs / 1000).toFixed(2)}s |`,
  ),
  "",
  "Lower Chamfer is better. Other scores are higher-is-better. Ground-truth meshes are written by `sixview synthetic` and generated directly by `src/synthetic.ts`.",
  "",
].join("\n");
await Promise.all([
  writeFile(join(output, "report.json"), `${JSON.stringify({ size, requestedResolution: resolution, rows }, null, 2)}\n`, "utf8"),
  writeFile(join(output, "report.md"), markdown, "utf8"),
]);
