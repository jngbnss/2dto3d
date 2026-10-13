import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import sharp from "sharp";
import { VIEWS, VIEW_IDS, imageAxes, isViewId, type ViewId } from "../views.ts";
import { loadTransforms, restoreAutomaticPlacement, saveTransforms, updateTransform, type ViewTransform } from "../orientation.ts";
import { prepareViewSet } from "../preprocess.ts";
import { validate } from "../validation.ts";
import { reconstructFromViews, viewPathsFromDirectory, writePrepared, type ReconstructMethod } from "../pipeline.ts";
import type { ViewSetReport } from "../analyze/types.ts";
import { handleCadRequest } from "./cad.ts";

export interface ServerOptions {
  readonly port: number;
  /** Directory holding `front.png` … `top.png`, `views.json`, and every derived file. */
  readonly directory: string;
}

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** Saved after a successful build; cleared whenever an input or correction changes. */
const RESULT_FILE = "result.json";

interface StoredResult {
  readonly triangles: number;
  readonly resolution: number;
  readonly method: ReconstructMethod;
  readonly strategy?: string;
  readonly warning?: string;
  readonly score: number;
  readonly colourScore: number;
  readonly comparisons: ReadonlyArray<{ readonly id: ViewId; readonly iou: number; readonly colour: number }>;
  /** `ai` only: the generated shape fitted to the views, before silhouette correction. */
  readonly generated?: { readonly score: number; readonly colourScore: number; readonly yaw: number };
}

/**
 * Studio backend: uploads, per-view corrections, live alignment validation, and
 * the visual-hull build, all against one view directory. The page itself is the
 * Vite build served by `cad.ts`; this module owns the JSON API and the files.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  // Mutations and builds touch the same files; run them one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  const server = createServer((request, response) => {
    handle(request, response, directory, serial).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        response.writeHead(error instanceof HttpError ? error.status : 500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      response.end(message);
    });
  });

  const { promise, resolve: ready, reject } = Promise.withResolvers<RunningServer>();
  server.once("error", reject);
  server.listen(options.port, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    ready({
      url: `http://127.0.0.1:${port}/`,
      close: async () => {
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        await closed.promise;
      },
    });
  });
  return promise;
}

type Serial = <T>(task: () => Promise<T>) => Promise<T>;

async function handle(request: IncomingMessage, response: ServerResponse, directory: string, serial: Serial): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const post = request.method === "POST";

  // `/`, `/viewer`, built assets, and the viewer's model listing.
  if (await handleCadRequest(request, response, directory)) return;

  if (path === "/api/state") return json(response, await serial(() => state(directory)));

  const mutation = /^\/api\/(upload|clear|transform)\/([a-z]+)$/.exec(path);
  if (mutation && post) {
    const [, action, id = ""] = mutation;
    if (!isViewId(id)) return text(response, 400, "알 수 없는 뷰 이름입니다.");
    const body = await readBody(request);
    return json(
      response,
      await serial(async () => {
        if (action === "upload") await upload(directory, id, body);
        else if (action === "clear") await clearView(directory, id);
        else await transform(directory, id, body);
        await rm(join(directory, RESULT_FILE), { force: true });
        return state(directory);
      }),
    );
  }

  if (path === "/api/swap" && post) {
    const a = url.searchParams.get("a") ?? "";
    const b = url.searchParams.get("b") ?? "";
    if (!isViewId(a) || !isViewId(b) || a === b) return text(response, 400, "서로 다른 두 뷰 이름이 필요합니다.");
    return json(
      response,
      await serial(async () => {
        await swapViews(directory, a, b);
        await rm(join(directory, RESULT_FILE), { force: true });
        return state(directory);
      }),
    );
  }

  if (path === "/api/auto-align" && post) {
    return json(
      response,
      await serial(async () => {
        const transforms = await loadTransforms(directory);
        await saveTransforms(
          directory,
          Object.fromEntries(VIEW_IDS.map((id) => [id, restoreAutomaticPlacement(transforms[id])])) as Record<ViewId, ViewTransform>,
        );
        await rm(join(directory, RESULT_FILE), { force: true });
        return state(directory);
      }),
    );
  }

  if (path === "/api/generate" && post) {
    const options = parseJson(await readBody(request));
    return json(response, await serial(() => generate(directory, options)));
  }

  const raw = /^\/views\/([a-z]+)\/raw$/.exec(path);
  if (raw) {
    const id = raw[1] ?? "";
    const file = isViewId(id) ? (await viewPathsFromDirectory(directory))[id] : undefined;
    return file ? sendFile(response, file, CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream") : notFound(response);
  }
  const derived = /^\/(prepared|outline|result|conflict)\/([a-z]+)$/.exec(path);
  if (derived) {
    const [, kind, id = ""] = derived;
    if (!isViewId(id)) return notFound(response);
    const file =
      kind === "prepared" ? join(directory, "prepared", `${id}.png`)
      : kind === "outline" ? join(directory, "prepared", `${id}.outline.png`)
      : kind === "conflict" ? join(directory, "result", `${id}.conflict.png`)
      : join(directory, "result", `${id}.png`);
    return sendFile(response, file, "image/png");
  }
  const download = {
    "/model.glb": "model/gltf-binary",
    "/voxels.glb": "model/gltf-binary",
    "/ai-raw.glb": "model/gltf-binary",
    "/model.obj": "model/obj",
  }[path];
  if (download) return sendFile(response, join(directory, path.slice(1)), download, path.slice(1));

  notFound(response);
}

async function upload(directory: string, id: ViewId, body: Buffer): Promise<void> {
  if (body.length === 0) throw new HttpError(400, "빈 파일입니다.");
  let png: Buffer;
  try {
    // Normalised to PNG so the slots stay one predictable format; alpha survives.
    png = await sharp(body).png().toBuffer();
  } catch {
    throw new HttpError(400, "이미지로 읽을 수 없는 파일입니다.");
  }
  await clearView(directory, id);
  await writeFile(join(directory, `${id}.png`), png);
  // A new image starts from the identity transform.
  const transforms = await loadTransforms(directory);
  await saveTransforms(directory, { ...transforms, [id]: updateTransform(transforms[id], { rotation: 0, flip: false, scale: 1, offsetX: 0, offsetY: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } }) });
}

async function clearView(directory: string, id: ViewId): Promise<void> {
  for (const extension of [".png", ".jpg", ".jpeg", ".webp"]) await rm(join(directory, `${id}${extension}`), { force: true });
  await rm(join(directory, "prepared", `${id}.png`), { force: true });
  await rm(join(directory, "prepared", `${id}.outline.png`), { force: true });
}

async function transform(directory: string, id: ViewId, body: Buffer): Promise<void> {
  const transforms = await loadTransforms(directory);
  await saveTransforms(directory, { ...transforms, [id]: updateTransform(transforms[id], parseJson(body)) });
}

/** Exchanges two slots: their uploads and their stored corrections move together. */
async function swapViews(directory: string, a: ViewId, b: ViewId): Promise<void> {
  const paths = await viewPathsFromDirectory(directory);
  const staged = join(directory, `.swap-${a}`);
  const pathA = paths[a];
  const pathB = paths[b];
  if (pathA) await rename(pathA, staged);
  if (pathB) await rename(pathB, join(directory, `${a}${extname(pathB)}`));
  if (pathA) await rename(staged, join(directory, `${b}${extname(pathA)}`));
  const transforms = await loadTransforms(directory);
  await saveTransforms(directory, { ...transforms, [a]: transforms[b], [b]: transforms[a] });
}

async function generate(directory: string, body: unknown): Promise<unknown> {
  const options = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const resolution = typeof options["resolution"] === "number" ? Math.min(384, Math.max(32, Math.round(options["resolution"]))) : undefined;
  const smoothing = typeof options["smoothing"] === "number" ? Math.min(30, Math.max(0, Math.round(options["smoothing"]))) : undefined;
  const paths = await viewPathsFromDirectory(directory);
  const missing = VIEW_IDS.filter((id) => VIEWS[id].required && !paths[id]);
  if (missing.length > 0) throw new HttpError(400, `필수 뷰가 없습니다: ${missing.join(", ")}`);

  const result = await reconstructFromViews(paths, await loadTransforms(directory), {
    outputDirectory: directory,
    method: options["method"] === "ai" || options["method"] === "geometry" || options["method"] === "hybrid"
      ? options["method"]
      : "silhouette",
    ...(resolution === undefined ? {} : { resolution }),
    ...(smoothing === undefined ? {} : { smoothing }),
    symmetry: options["symmetry"] === true,
    rounding: typeof options["rounding"] === "number" ? Math.min(1, Math.max(0, options["rounding"])) : 0,
    onProgress: (message) => process.stdout.write(`· ${message}\n`),
  });
  if (result.method !== "ai") await rm(join(directory, "ai-raw.glb"), { force: true });
  const stored: StoredResult = {
    triangles: result.mesh.indices.length / 3,
    resolution: result.resolution,
    method: result.method,
    ...(result.strategy ? { strategy: result.strategy } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
    score: result.score,
    colourScore: result.colourScore,
    comparisons: result.comparisons,
    ...(result.generated
      ? { generated: { score: result.generated.score, colourScore: result.generated.colourScore, yaw: result.generated.yaw } }
      : {}),
  };
  await writeFile(join(directory, RESULT_FILE), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return state(directory);
}

/** The whole page state: views (prepared on the fly), validation, and the last build. */
async function state(directory: string): Promise<unknown> {
  const paths = await viewPathsFromDirectory(directory);
  const transforms = await loadTransforms(directory);
  const set = await prepareViewSet(paths, transforms);
  await writePrepared(set, directory);
  const validation: ViewSetReport = validate(set);
  const stamp = Date.now();

  const views = VIEW_IDS.map((id) => {
    const view = set.views.get(id);
    const box = view?.silhouette.bbox ?? null;
    const size = view?.silhouette.width ?? 1;
    return {
      id,
      label: VIEWS[id].label,
      required: VIEWS[id].required,
      axes: imageAxes(id),
      hasImage: view !== undefined,
      rawUrl: view ? `/views/${id}/raw?t=${stamp}` : null,
      preparedUrl: view ? `/prepared/${id}?t=${stamp}` : null,
      outlineUrl: view ? `/outline/${id}?t=${stamp}` : null,
      transform: transforms[id] satisfies ViewTransform,
      source: view?.source ?? null,
      bbox: box ? { x0: box.x0 / size, y0: box.y0 / size, x1: box.x1 / size, y1: box.y1 / size } : null,
    };
  });

  const blockers = set.missing
    .filter((id) => VIEWS[id].required)
    .map((id) =>
      id === "top"
        ? "top 뷰가 없습니다. 윗면이 없으면 길이·폭·윗면 형상을 제한할 수 없어 생성을 막습니다."
        : `${id} 뷰가 없습니다.`,
    );

  let result: unknown = null;
  try {
    const stored = JSON.parse(await readFile(join(directory, RESULT_FILE), "utf8")) as StoredResult;
    await stat(join(directory, "model.glb"));
    // Results saved before colour agreement existed are rebuilt rather than shown half-empty.
    if (typeof stored.colourScore !== "number") throw new Error("stale result");
    result = {
      glbUrl: `/model.glb?t=${stamp}`,
      objUrl: `/model.obj?t=${stamp}`,
      voxelUrl: `/voxels.glb?t=${stamp}`,
      triangles: stored.triangles,
      resolution: stored.resolution,
      method: stored.method ?? "silhouette",
      strategy: stored.strategy ?? null,
      warning: stored.warning ?? null,
      generated: stored.generated ? { ...stored.generated, glbUrl: `/ai-raw.glb?t=${stamp}` } : null,
      score: stored.score,
      colourScore: stored.colourScore,
      comparisons: stored.comparisons.map((c) => ({
        id: c.id,
        iou: c.iou,
        colour: c.colour,
        originalUrl: `/prepared/${c.id}?t=${stamp}`,
        renderUrl: `/result/${c.id}?t=${stamp}`,
        conflictUrl: `/conflict/${c.id}?t=${stamp}`,
      })),
    };
  } catch {
    // No build since the inputs last changed.
  }

  return {
    directory,
    views,
    validation: {
      score: validation.score,
      verdict: validation.verdict,
      checks: validation.checks.map((c) => ({ id: c.id, label: c.label, score: c.score, detail: c.detail })),
      issues: validation.issues,
    },
    canGenerate: blockers.length === 0,
    blockers,
    result,
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON 본문을 읽을 수 없습니다.");
  }
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function text(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

function notFound(response: ServerResponse): void {
  text(response, 404, "없음");
}

async function sendFile(response: ServerResponse, file: string, type: string, download?: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return notFound(response);
  }
  response.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...(download ? { "Content-Disposition": `attachment; filename="${download}"` } : {}),
  });
  response.end(bytes);
}

/** Collects a raw request body; uploads post the file bytes directly. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
