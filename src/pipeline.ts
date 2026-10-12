import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { VIEW_IDS, type ViewId } from "./views.ts";
import { loadMesh, parseMesh, type Mesh } from "./mesh/index.ts";
import { renderSixViews, type RenderOptions } from "./render/ortho.ts";
import { analyzeViewSet, loadViewSamples, type ViewPaths } from "./analyze/report.ts";
import { carveVisualHull, type CarveOptions, type VoxelGrid } from "./reconstruct/carve.ts";
import { surfaceMesh, toObj } from "./reconstruct/surface.ts";
import type { SixViewReport } from "./analyze/types.ts";
import { resolveProvider } from "./generate/index.ts";

export interface RenderResult {
  readonly directory: string;
  readonly paths: ViewPaths;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function renderToDirectory(
  mesh: Mesh,
  directory: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  await mkdir(directory, { recursive: true });
  const rendered = renderSixViews(mesh, options);
  const paths: ViewPaths = {};

  await Promise.all(
    VIEW_IDS.map(async (id) => {
      const view = rendered[id];
      const path = join(directory, `${id}.png`);
      const png = await sharp(Buffer.from(view.pixels), {
        raw: { width: view.width, height: view.height, channels: 4 },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
      await writeFile(path, png);
      paths[id] = path;
    }),
  );

  return { directory, paths };
}

/** Maps a directory of `front.png`, `back.png`, … to view paths, ignoring absent files. */
export async function viewPathsFromDirectory(directory: string): Promise<ViewPaths> {
  const paths: ViewPaths = {};
  await Promise.all(
    VIEW_IDS.map(async (id) => {
      for (const extension of [".png", ".jpg", ".jpeg", ".webp"]) {
        const candidate = join(directory, `${id}${extension}`);
        try {
          await access(candidate);
          paths[id] = candidate;
          return;
        } catch {
          // try the next extension
        }
      }
    }),
  );
  return paths;
}

export interface RunOptions extends RenderOptions {
  readonly provider: string;
  readonly model?: string | undefined;
  readonly outputDirectory: string;
  readonly onProgress?: ((message: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RunResult {
  readonly meshPath: string;
  readonly render: RenderResult;
  readonly report: SixViewReport;
}

/** Single 2D image -> 3D asset (provider) -> six orthographic views -> analysis. */
export async function runFromImage(imagePath: string, options: RunOptions): Promise<RunResult> {
  const provider = resolveProvider(options.provider);
  const image = await readFile(imagePath);
  const extension = imagePath.slice(imagePath.lastIndexOf(".")).toLowerCase();

  options.onProgress?.(`${provider.label} 호출 중…`);
  const generated = await provider.generate({
    image,
    mime: MIME_BY_EXTENSION[extension] ?? "image/png",
    model: options.model,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  await mkdir(options.outputDirectory, { recursive: true });
  const meshPath = join(options.outputDirectory, `mesh.${generated.format}`);
  await writeFile(meshPath, generated.bytes);
  options.onProgress?.(`메시 저장: ${meshPath}`);

  const mesh = parseMesh(generated.bytes, generated.format);
  const render = await renderToDirectory(mesh, join(options.outputDirectory, "views"), options);
  options.onProgress?.("6면 렌더 완료, 분석 시작");

  return { meshPath, render, report: await analyzeViewSet(render.paths) };
}

export async function renderAndAnalyze(
  meshPath: string,
  outputDirectory: string,
  options: RenderOptions = {},
): Promise<{ render: RenderResult; report: SixViewReport }> {
  const mesh = await loadMesh(meshPath);
  const render = await renderToDirectory(mesh, outputDirectory, options);
  return { render, report: await analyzeViewSet(render.paths) };
}

export interface CarveResult {
  readonly objPath: string;
  readonly grid: VoxelGrid;
  readonly mesh: Mesh;
  readonly report: SixViewReport;
}

/**
 * Six views -> solid. The report is produced from the same decoded views, so a
 * set that fails analysis can be rejected before anyone trusts the geometry.
 */
export async function carveFromViews(
  paths: ViewPaths,
  objPath: string,
  options: CarveOptions = {},
): Promise<CarveResult> {
  const { samples, missing } = await loadViewSamples(paths);
  if (samples.size === 0) throw new Error("복원할 뷰가 없습니다.");

  const report = await analyzeViewSet(paths);
  const grid = carveVisualHull(samples, report.axes, options);
  const mesh = surfaceMesh(grid);

  await mkdir(dirname(resolve(objPath)), { recursive: true });
  const header = `views=${grid.views.join(",")}${missing.length > 0 ? ` missing=${missing.join(",")}` : ""}`;
  await writeFile(objPath, toObj(mesh, header), "utf8");

  return { objPath, grid, mesh, report };
}

export type { ViewId, ViewPaths, SixViewReport };
