import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { VIEWS, VIEW_IDS } from "../views.ts";
import { viewPathsFromDirectory } from "../pipeline.ts";

/**
 * Bridge between the six-view pipeline and the browser CAD editor.
 *
 * Two jobs, and the second one matters more than the first:
 *
 *  1. serve the built CAD editor (`cad/dist`) under `/cad`;
 *  2. describe what the pipeline has actually produced — honestly.
 *
 * A run that stopped after view generation has six PNGs and no geometry. The
 * descriptor for that run carries `asset: null`, so the editor refuses to import
 * it instead of creating an empty part. Only a completed carve produces an
 * importable asset, and even then it is reported as a triangle mesh, never as a
 * parametric CAD solid: space carving yields a voxel surface, not a B-rep.
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

/** Geometry files the carve/render stages can leave behind, best first. */
const GEOMETRY_CANDIDATES: ReadonlyArray<{
  readonly file: string;
  readonly id: string;
  readonly format: "obj" | "glb" | "stl";
  readonly label: string;
  readonly note: string;
}> = [
  {
    file: "carved.obj",
    id: "carved",
    format: "obj",
    label: "공간 카빙 결과 (carved.obj)",
    note: "6면 실루엣 교집합으로 복원한 복셀 표면 메시입니다.",
  },
  {
    file: "model.glb",
    id: "model-glb",
    format: "glb",
    label: "생성 모델 (model.glb)",
    note: "공급자가 반환한 3D 자산입니다.",
  },
  {
    file: "model.obj",
    id: "model-obj",
    format: "obj",
    label: "생성 모델 (model.obj)",
    note: "공급자가 반환한 3D 자산입니다.",
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
        ...(score !== null ? { "6면 일관성 점수": Math.round(score * 1000) / 10 } : {}),
        ...(verdict !== null ? { 판정: verdict } : {}),
      },
    });
  }

  // The case the editor must refuse: renders exist, geometry does not.
  if (descriptors.length === 0 && availableViews.length > 0) {
    descriptors.push({
      id: "views-only",
      name: "6면 뷰만 생성됨 (3D 형상 없음)",
      createdAt: Date.now(),
      orthoViews,
      asset: null,
      meta: {
        파이프라인: "sixview",
        단계: "view generation",
        보유: `${availableViews.length}개 뷰 이미지`,
        안내: "carve 단계를 실행해야 3D 메시가 생깁니다. 미리보기 이미지는 형상이 아닙니다.",
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
 * Serves one file out of `cad/dist`, refusing anything that escapes it.
 * Returns false when the path is not a CAD asset so the caller can fall through.
 */
async function serveStatic(pathname: string, response: ServerResponse): Promise<boolean> {
  const relative = pathname === "/cad" || pathname === "/cad/" ? "index.html" : pathname.slice("/cad/".length);
  const target = resolve(join(CAD_DIST, normalize(relative)));
  if (target !== CAD_DIST && !target.startsWith(CAD_DIST + sep)) return false;

  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    // Unknown sub-path inside a single-page app: hand back index.html.
    const index = join(CAD_DIST, "index.html");
    const indexInfo = await stat(index).catch(() => null);
    if (!indexInfo?.isFile()) return false;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(await readFile(index));
    return true;
  }

  response.writeHead(200, {
    "Content-Type": STATIC_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": info.size,
    // Hashed bundle names make long caching safe; index.html must not be cached.
    "Cache-Control": target.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(target).pipe(response);
  return true;
}

export function cadEditorBuilt(): Promise<boolean> {
  return stat(join(CAD_DIST, "index.html"))
    .then((info) => info.isFile())
    .catch(() => false);
}

export const CAD_DIST_PATH = CAD_DIST;

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

  if (pathname === "/cad" || pathname.startsWith("/cad/")) {
    if (await serveStatic(pathname, response)) return true;
    response.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>CAD 편집기 미빌드</title>` +
        `<body style="font:14px/1.6 system-ui;background:#0f1115;color:#e6e9ef;padding:40px">` +
        `<h1>CAD 편집기가 아직 빌드되지 않았습니다</h1>` +
        `<p>다음을 실행한 뒤 새로고침하세요.</p>` +
        `<pre style="background:#171a21;border:1px solid #272c36;border-radius:6px;padding:14px">cd cad\nnpm install\nnpm run build</pre>` +
        `<p>개발 중에는 <code>cd cad &amp;&amp; npm run dev</code> 로 Vite 개발 서버를 쓰는 편이 빠릅니다.</p>` +
        `</body>`,
    );
    return true;
  }

  return false;
}
