import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { VIEWS, VIEW_IDS } from "../views.ts";
import { viewPathsFromDirectory } from "../pipeline.ts";

/**
 * Serves the 3D viewer build (`cad/dist`, page `/viewer`) and describes what the
 * pipeline has actually produced — honestly — under `/api/cad/models`.
 *
 * The CAD editor that shares the build is intentionally unreachable here.
 *
 * A run that stopped before generation has view PNGs and no geometry. The
 * descriptor for that run carries `asset: null` instead of pretending a mesh
 * exists. Generated and carved results are reported as triangle meshes, never as
 * parametric CAD solids.
 */

/** Project root, derived from this module's location (src/web/cad.ts). */
const PROJECT_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CAD_DIST = join(PROJECT_ROOT, "cad", "dist");

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Geometry files a build leaves behind, best first. */
const GEOMETRY_CANDIDATES: ReadonlyArray<{
  readonly file: string;
  readonly id: string;
  readonly format: "obj" | "glb" | "stl";
  readonly label: string;
  readonly note: string;
}> = [
  {
    file: "model.glb",
    id: "model-glb",
    format: "glb",
    label: "복원 메시 (model.glb)",
    note: "5면 실루엣에 맞춘 최종 메시(실루엣 방식 또는 AI 형상 + 실루엣 보정)에 뷰 색을 투영했습니다.",
  },
  {
    file: "ai-raw.glb",
    id: "ai-raw",
    format: "glb",
    label: "AI 원본 (보정 전, ai-raw.glb)",
    note: "AI가 만든 형상을 5면에 맞춰 놓기만 하고 실루엣 보정은 하지 않은 상태입니다.",
  },
  {
    file: "voxels.glb",
    id: "voxels",
    format: "glb",
    label: "복셀 (voxels.glb)",
    note: "같은 실루엣 교집합을 표면화 전 복셀 그대로 보여 줍니다.",
  },
];

export interface CadModelDescriptor {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly orthoViews?: Readonly<Partial<Record<string, string>>>;
  readonly asset: {
    readonly kind: "mesh" | "solid";
    readonly format: "obj" | "glb" | "stl" | "step";
    readonly url: string;
    readonly byteSize: number;
    /**
     * Space carving works in a normalised frame — the output carries no physical
     * size at all. The editor scales the longest bounding-box axis to this many
     * millimetres on import and tells the user it did so, rather than silently
     * dropping a 0.5 mm part into the workspace.
     */
    readonly normalizeToMm?: number;
    /**
     * sixview's object frame is +Y up (see `src/views.ts`), while the CAD
     * workspace is Z-up like every mechanical CAD system. Declaring the axis
     * lets the importer reframe the geometry instead of leaving the part lying
     * on its side.
     */
    readonly upAxis?: "y" | "z";
  } | null;
  readonly meta?: Readonly<Record<string, string | number>>;
}

async function readReport(directory: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(directory, "report.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Describes every importable (and every deliberately NON-importable) result. */
export async function listModels(directory: string): Promise<CadModelDescriptor[]> {
  const root = resolve(directory);
  const views = await viewPathsFromDirectory(root);
  const availableViews = VIEW_IDS.filter((id) => views[id] !== undefined);
  const orthoViews = Object.fromEntries(availableViews.map((id) => [VIEWS[id].label, `/views/${id}`]));
  const report = await readReport(root);
  const score = typeof report?.["score"] === "number" ? (report["score"] as number) : null;
  const verdict = typeof report?.["verdict"] === "string" ? (report["verdict"] as string) : null;

  const descriptors: CadModelDescriptor[] = [];

  for (const candidate of GEOMETRY_CANDIDATES) {
    const path = join(root, candidate.file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    descriptors.push({
      id: candidate.id,
      name: candidate.label,
      createdAt: info.mtimeMs,
      ...(availableViews.length > 0 ? { orthoViews } : {}),
      asset: {
        kind: "mesh",
        format: candidate.format,
        url: `/api/cad/asset/${candidate.id}`,
        byteSize: info.size,
        normalizeToMm: 100,
        upAxis: "y",
      },
      meta: {
        파이프라인: "sixview",
        단계: candidate.id === "carved" ? "space carving" : "provider generation",
        형식: "삼각형 메시 (B-rep 솔리드 아님)",
        설명: candidate.note,
        ...(score !== null ? { "4면 일관성 점수": Math.round(score * 1000) / 10 } : {}),
        ...(verdict !== null ? { 판정: verdict } : {}),
      },
    });
  }

  // The case the editor must refuse: renders exist, geometry does not.
  if (descriptors.length === 0 && availableViews.length > 0) {
    descriptors.push({
      id: "views-only",
      name: "4면 이미지만 있음 (3D 형상 없음)",
      createdAt: Date.now(),
      orthoViews,
      asset: null,
      meta: {
        파이프라인: "sixview",
        단계: "view generation",
        보유: `${availableViews.length}개 뷰 이미지`,
        안내: "3D 만들기를 실행해야 3D 메시가 생깁니다. 입력 이미지는 형상이 아닙니다.",
      },
    });
  }

  return descriptors;
}

export async function findModel(directory: string, id: string): Promise<CadModelDescriptor | null> {
  const all = await listModels(directory);
  return all.find((entry) => entry.id === id) ?? null;
}

/**
 * Serves one file of the viewer build out of `cad/dist`, refusing anything that
 * escapes it. Only the viewer page and the hashed bundle under `assets/` are
 * reachable; the CAD editor's `index.html` is deliberately not served.
 */
async function serveViewerFile(relative: string, response: ServerResponse): Promise<boolean> {
  const target = resolve(join(CAD_DIST, normalize(relative)));
  if (!target.startsWith(CAD_DIST + sep)) return false;
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return false;

  response.writeHead(200, {
    "Content-Type": STATIC_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": info.size,
    // Hashed bundle names make long caching safe; the HTML page must not be cached.
    "Cache-Control": target.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(target).pipe(response);
  return true;
}

/**
 * Handles every `/cad` and `/api/cad/...` request. Returns false when the
 * request is not ours, so the existing six-view routes stay untouched.
 */
export async function handleCadRequest(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/api/cad/models") {
    const models = await listModels(directory);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(models));
    return true;
  }

  const single = /^\/api\/cad\/models\/([\w-]+)$/.exec(pathname);
  if (single) {
    const model = await findModel(directory, single[1] ?? "");
    if (!model) {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "해당 결과를 찾을 수 없습니다" }));
      return true;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(model));
    return true;
  }

  const asset = /^\/api\/cad\/asset\/([\w-]+)$/.exec(pathname);
  if (asset) {
    const candidate = GEOMETRY_CANDIDATES.find((entry) => entry.id === (asset[1] ?? ""));
    const path = candidate ? join(resolve(directory), candidate.file) : null;
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !info?.isFile()) {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "자산 파일이 없습니다" }));
      return true;
    }
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store",
    });
    createReadStream(path).pipe(response);
    return true;
  }

  const page = pathname === "/" ? "studio.html" : pathname === "/viewer" ? "viewer.html" : null;
  if (page || pathname.startsWith("/cad/assets/")) {
    if (await serveViewerFile(page ?? pathname.slice("/cad/".length), response)) return true;
    response.writeHead(page ? 503 : 404, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      page
        ? `<!doctype html><meta charset="utf-8"><title>웹 화면 미빌드</title>` +
            `<body style="font:14px/1.6 system-ui;background:#0f1115;color:#e6e9ef;padding:40px">` +
            `<h1>웹 화면이 아직 빌드되지 않았습니다</h1>` +
            `<pre style="background:#171a21;border:1px solid #272c36;border-radius:6px;padding:14px">npm run cad:install\nnpm run cad:build</pre></body>`
        : "없음",
    );
    return true;
  }

  // The CAD editor is not offered from this web surface.
  if (pathname === "/cad" || pathname.startsWith("/cad/")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("없음");
    return true;
  }

  return false;
}
