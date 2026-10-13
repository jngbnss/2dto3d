import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { VIEW_IDS, VIEWS, type Axis, type ViewId } from "./views.ts";
import {
  glbHasSurfaceColor,
  loadMesh,
  parseGlb,
  parseMesh,
  scaleMesh,
  toObj,
  turnAround,
  wrapGlbRoot,
  writeGlb,
  type Mesh,
} from "./mesh/index.ts";
import { renderViews, type RenderedView, type RenderOptions } from "./render/ortho.ts";
import { analyzeViewSet, type ViewPaths } from "./analyze/report.ts";
import { outlinePng, prepareViewSet, type PreparedSet } from "./preprocess.ts";
import { maskIoU, validate } from "./validation.ts";
import { buildHullField, DEFAULT_RESOLUTION } from "./reconstruct/voxel-reconstruct.ts";
import { extractSurface, extractVoxels } from "./reconstruct/mesh-extract.ts";
import { postprocessMesh } from "./reconstruct/mesh-postprocess.ts";
import { paintFromViews, proportionScale, type PhotoConsistency } from "./reconstruct/finish.ts";
import { correctToHull, fitToViews, type Fit } from "./reconstruct/ai-correct.ts";
import type { Silhouette } from "./analyze/silhouette.ts";
import type { ViewTransforms } from "./orientation.ts";
import type { AxisEstimate, ViewSetReport } from "./analyze/types.ts";
import {
  aiProvider,
  resolveProvider,
  type GeneratedMesh,
  type SourceImage,
  type ViewImages,
} from "./generate/index.ts";

export interface RenderResult {
  readonly directory: string;
  readonly paths: ViewPaths;
}

export async function renderToDirectory(
  mesh: Mesh,
  directory: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  return writeRenders(renderViews(mesh, options), directory);
}

/** Writes one PNG per view as `<id><suffix>.png`. */
async function writeRenders(
  rendered: Readonly<Record<ViewId, RenderedView>>,
  directory: string,
  suffix = "",
): Promise<RenderResult> {
  await mkdir(directory, { recursive: true });
  const paths: ViewPaths = {};
  await Promise.all(
    VIEW_IDS.map(async (id) => {
      const view = rendered[id];
      const path = join(directory, `${id}${suffix}.png`);
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

/** Writes each prepared canvas and its silhouette outline under `<directory>/prepared/`. */
export async function writePrepared(set: PreparedSet, directory: string): Promise<void> {
  const target = join(directory, "prepared");
  await mkdir(target, { recursive: true });
  await Promise.all(
    [...set.views.values()].map(async (view) => {
      await writeFile(join(target, `${view.id}.png`), view.png);
      await writeFile(join(target, `${view.id}.outline.png`), await outlinePng(view.silhouette));
    }),
  );
}

/**
 * - `silhouette`: visual hull only — exact outlines, no inner relief. Best for
 *   cars, products, machines.
 * - `ai`: an image-to-3D model supplies the shape (cheeks, nose, protruding
 *   parts), then the silhouettes correct it. Best for characters.
 */
export type ReconstructMethod = "silhouette" | "ai";

export interface ReconstructOptions {
  readonly outputDirectory: string;
  readonly method?: ReconstructMethod;
  /** Image-to-3D provider for `method: "ai"`; defaults to the project default. */
  readonly provider?: string;
  /** Grid cells along the longest axis. */
  readonly resolution?: number;
  /** Intersect with the X-mirrored hull (left-right symmetric subjects). */
  readonly symmetry?: boolean;
  /** Rounded cross-section prior 0..1 (0 = plain hull, 1 = elliptical slices). `silhouette` only. */
  readonly rounding?: number;
  /** Taubin smoothing iterations, 0 = none. `silhouette` only. */
  readonly smoothing?: number;
  /** Proceed even when a required view is missing. */
  readonly allowMissing?: boolean;
  readonly onProgress?: ((message: string) => void) | undefined;
}

export interface ViewComparison {
  readonly id: ViewId;
  /** Input silhouette vs the result rendered back into this view. */
  readonly iou: number;
  /** Share of this view's jointly seen surface whose colour agrees with the other views. */
  readonly colour: number;
}

export interface Evaluation {
  readonly comparisons: readonly ViewComparison[];
  /** Mean silhouette IoU of `comparisons`. */
  readonly score: number;
  /**
   * Photo-consistency of the coloured surface, 0..1: where two photos see the
   * same point, do they agree on its colour? Silhouettes can match perfectly
   * while this is low — the outline is right but the surface inside is not.
   */
  readonly colourScore: number;
}

export interface ReconstructResult extends Evaluation {
  readonly report: ViewSetReport;
  readonly mesh: Mesh;
  readonly resolution: number;
  /** Method that produced `mesh` — `silhouette` when `ai` was asked for but the generator failed. */
  readonly method: ReconstructMethod;
  /** Why the requested method could not be used, if it could not. */
  readonly warning?: string;
  /** For `ai`: the generated shape fitted to the views, before silhouette correction. */
  readonly generated?: Evaluation & { readonly yaw: number; readonly glb: string };
  readonly files: { readonly glb: string; readonly obj: string; readonly voxels: string; readonly renders: string };
}

/**
 * Views -> validated, aligned silhouettes -> visual hull (signed distance field)
 * -> surface: either the hull itself (Surface Nets, clean-up, silhouette-bounded
 * smoothing) or a generated shape fitted to the views and corrected onto the
 * hull -> colour projected from the views -> GLB / OBJ / voxel GLB ->
 * re-rendered into every view at the input's exact scale and compared.
 */
export async function reconstructFromViews(
  paths: ViewPaths,
  transforms: ViewTransforms,
  options: ReconstructOptions,
): Promise<ReconstructResult> {
  const set = await prepareViewSet(paths, transforms);
  const report = validate(set);
  const missingRequired = set.missing.filter((id) => VIEWS[id].required);
  if (missingRequired.length > 0 && !options.allowMissing) {
    throw new Error(`필수 뷰가 없습니다: ${missingRequired.join(", ")}. top 뷰 없이는 길이·폭·윗면 형상을 제한할 수 없습니다.`);
  }

  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  const silhouettes = new Map([...set.views].map(([id, view]) => [id, view.silhouette] as const));
  const frame = { pixelsPerUnit: set.pixelsPerUnit, extent: set.alignment.extent };
  const symmetryX = options.symmetry ?? false;
  const out = options.outputDirectory;
  await mkdir(out, { recursive: true });
  await writePrepared(set, out);
  const rasters = new Map([...set.views].map(([id, view]) => [id, view.prepared] as const));

  let method: ReconstructMethod = options.method ?? "silhouette";
  let warning: string | undefined;
  let generated: ReconstructResult["generated"];
  let surface: Mesh | null = null;
  // The plain hull is the correction target for `ai` and the voxel export for both.
  const hull = buildHullField(silhouettes, frame, { resolution, symmetryX });

  if (method === "ai") {
    try {
      const fitted = await generateFitted(set, silhouettes, frame, options);
      const glb = join(out, "ai-raw.glb");
      const raw = paintFromViews(fitted.mesh, set.views, rasters, set.pixelsPerUnit);
      await writeFile(glb, writeGlb(raw.mesh));
      generated = { ...evaluate(set, raw.mesh, raw.consistency), yaw: fitted.yaw, glb };
      options.onProgress?.("실루엣 밖으로 나간 부분 보정 중…");
      surface = correctToHull(fitted.mesh, hull);
    } catch (error) {
      method = "silhouette";
      warning = `AI 형상 생성에 실패해 실루엣 방식으로 만들었습니다: ${error instanceof Error ? error.message : String(error)}`;
      options.onProgress?.(warning);
    }
  }
  if (!surface) {
    const field = (options.rounding ?? 0) > 0 ? buildHullField(silhouettes, frame, { resolution, symmetryX, rounding: options.rounding ?? 0 }) : hull;
    surface = postprocessMesh(extractSurface(field), {
      iterations: options.smoothing ?? 12,
      maxDisplacement: field.cell * 0.6,
    });
  }

  const painted = paintFromViews(surface, set.views, rasters, set.pixelsPerUnit);
  const mesh = painted.mesh;
  const voxels = paintFromViews(extractVoxels(hull), set.views, rasters, set.pixelsPerUnit).mesh;
  const files = {
    glb: join(out, "model.glb"),
    obj: join(out, "model.obj"),
    voxels: join(out, "voxels.glb"),
    renders: join(out, "result"),
  };
  await writeFile(files.glb, writeGlb(mesh));
  await writeFile(files.obj, toObj(mesh, `sixview ${method} · views=${hull.views.join(",")} · resolution=${resolution}`), "utf8");
  await writeFile(files.voxels, writeGlb(voxels));

  // Same scale and origin as the prepared silhouettes, so pixels line up for comparison.
  const size = [...set.views.values()][0]?.silhouette.width ?? 512;
  await writeRenders(renderViews(mesh, { size, pixelsPerUnit: set.pixelsPerUnit }), files.renders);
  await writeRenders(
    renderViews(markConflicts(mesh, painted.consistency.conflicts), { size, pixelsPerUnit: set.pixelsPerUnit }),
    files.renders,
    ".conflict",
  );
  return {
    report,
    mesh,
    resolution,
    method,
    ...(warning ? { warning } : {}),
    ...(generated ? { generated } : {}),
    files,
    ...evaluate(set, mesh, painted.consistency),
  };
}

/** The generated shape, turned and scaled into the views' frame. */
async function generateFitted(
  set: PreparedSet,
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  frame: { readonly pixelsPerUnit: number; readonly extent: Readonly<Record<Axis, number>> },
  options: ReconstructOptions,
): Promise<Fit> {
  const provider = resolveProvider(options.provider ?? (await aiProvider()));
  const images: Partial<Record<ViewId, SourceImage>> = Object.fromEntries(
    [...set.views].map(([id, view]) => [id, { bytes: new Uint8Array(view.png), mime: "image/png" }] as const),
  );
  if (!images.front) throw new Error("front 이미지가 필요합니다.");
  const views: ViewImages = provider.multiImage ? { ...images, front: images.front } : { front: images.front };
  options.onProgress?.(`${provider.label} 호출 중…`);
  const result = await provider.generate({ views, onProgress: options.onProgress });
  const authored = parseMesh(result.bytes, result.format);
  options.onProgress?.("생성된 형상을 5면에 맞추는 중…");
  return fitToViews(result.facing === "-z" ? turnAround(authored) : authored, silhouettes, frame);
}

/** Silhouette IoU per view against a render at the prepared scale, plus the paint's colour agreement. */
function evaluate(set: PreparedSet, mesh: Mesh, consistency: PhotoConsistency): Evaluation {
  const size = [...set.views.values()][0]?.silhouette.width ?? 512;
  const rendered = renderViews(mesh, { size, pixelsPerUnit: set.pixelsPerUnit });
  const comparisons = [...set.views.values()].map((view) => ({
    id: view.id,
    iou: maskIoU(view.silhouette, rendered[view.id].pixels),
    colour: consistency.perView.get(view.id) ?? 1,
  }));
  const score = comparisons.reduce((sum, c) => sum + c.iou, 0) / Math.max(comparisons.length, 1);
  return { comparisons, score, colourScore: consistency.score };
}

/** The mesh in muted grey with every colour-conflict vertex in red, for the conflict renders. */
function markConflicts(mesh: Mesh, conflicts: Uint8Array): Mesh {
  const colors = new Float32Array(mesh.positions.length);
  for (let v = 0; v < conflicts.length; v++) {
    if (conflicts[v] === 1) {
      colors.set([0.95, 0.15, 0.2], v * 3);
      continue;
    }
    const r = mesh.colors[v * 3] ?? 0.8;
    const g = mesh.colors[v * 3 + 1] ?? 0.8;
    const b = mesh.colors[v * 3 + 2] ?? 0.8;
    const grey = 0.45 + 0.4 * (0.299 * r + 0.587 * g + 0.114 * b);
    colors.set([grey, grey, grey], v * 3);
  }
  return { ...mesh, colors };
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
  /** The input views, prepared and validated. */
  readonly inputReport: ViewSetReport;
  /** Views rendered from the finished asset, in `<outputDirectory>/result`. */
  readonly render: RenderResult;
  readonly report: ViewSetReport;
}

/**
 * Generative alternative to `reconstructFromViews`: the prepared views go to an
 * image-to-3D provider; its asset is rescaled to the views' proportions and, if
 * untextured, coloured from them.
 */
export async function runFromViews(paths: ViewPaths, transforms: ViewTransforms, options: RunOptions): Promise<RunResult> {
  const provider = resolveProvider(options.provider);
  const set = await prepareViewSet(paths, transforms);
  const given = [...set.views.keys()];
  if (!set.views.has("front")) throw new Error("front 이미지가 필요합니다.");
  if (given.length > 1 && !provider.multiImage) {
    throw new Error(`'${provider.id}' 공급자는 front 1장만 받습니다 (${given.length}장 입력).`);
  }
  const inputReport = validate(set);

  const images: Partial<Record<ViewId, SourceImage>> = Object.fromEntries(
    [...set.views].map(([id, view]) => [id, { bytes: new Uint8Array(view.png), mime: "image/png" }] as const),
  );
  if (!images.front) throw new Error("front 이미지가 필요합니다.");
  const views: ViewImages = { ...images, front: images.front };

  options.onProgress?.(`${provider.label} 호출 중… (${given.join(", ")})`);
  const generated = await provider.generate({
    views,
    model: options.model,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  options.onProgress?.("입력 비율로 맞추고 색 입히는 중…");
  const bytes = finishAsset(generated, inputReport.axes, set);
  await mkdir(options.outputDirectory, { recursive: true });
  const meshPath = join(options.outputDirectory, "model.glb");
  await writeFile(meshPath, bytes);
  options.onProgress?.(`메시 저장: ${meshPath}`);

  const render = await renderToDirectory(parseGlb(bytes), join(options.outputDirectory, "result"), options);
  return { meshPath, inputReport, render, report: await analyzeViewSet(render.paths) };
}

/**
 * Turns the provider's asset into the delivered GLB: facing +Z, proportions of
 * the input views, and colour. A textured GLB keeps its texture untouched under
 * a root transform; anything else is rebuilt as a vertex-coloured mesh.
 */
function finishAsset(generated: GeneratedMesh, axes: readonly AxisEstimate[], set: PreparedSet): Uint8Array {
  const turn = generated.facing === "-z";
  if (generated.format === "glb" && glbHasSurfaceColor(generated.bytes)) {
    // A 180° turn about Y keeps every axis extent, so bounds before turning suffice.
    const scale = proportionScale(parseGlb(generated.bytes).bounds, axes);
    return wrapGlbRoot(generated.bytes, { ...(turn ? { rotation: [0, 1, 0, 0] } : {}), scale });
  }

  const authored = parseMesh(generated.bytes, generated.format);
  const facing = turn ? turnAround(authored) : authored;
  let mesh = scaleMesh(facing, proportionScale(facing.bounds, axes));
  if (mesh.colors.length === 0) {
    mesh = paintFromViews(mesh, set.views, new Map([...set.views].map(([id, view]) => [id, view.prepared] as const))).mesh;
  }
  return writeGlb(mesh);
}

export async function renderAndAnalyze(
  meshPath: string,
  outputDirectory: string,
  options: RenderOptions = {},
): Promise<{ render: RenderResult; report: ViewSetReport }> {
  const mesh = await loadMesh(meshPath);
  const render = await renderToDirectory(mesh, outputDirectory, options);
  return { render, report: await analyzeViewSet(render.paths) };
}

export type { ViewId, ViewPaths, ViewSetReport };
