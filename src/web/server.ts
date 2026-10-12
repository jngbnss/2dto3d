import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import sharp from "sharp";
import { VIEWS, VIEW_IDS, isViewId } from "../views.ts";
import { analyzeViewSet } from "../analyze/report.ts";
import { carveFromViews, renderToDirectory, viewPathsFromDirectory } from "../pipeline.ts";
import { CLIENT_HTML } from "./client.ts";
import { handleCadRequest } from "./cad.ts";

export interface ServerOptions {
  readonly port: number;
  /** Directory holding `front.png` … `bottom.png`. */
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



/**
 * Preview surface: the six views plus the live analysis of whatever currently
 * sits in `directory`, so a regenerated view set is one refresh away.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const directory = resolve(options.directory);

  const server = createServer((request, response) => {
    handle(request, response, directory).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: message }));
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

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  // CAD editor routes are additive: they claim only `/cad` and `/api/cad/...`,
  // and fall through untouched for every existing six-view route.
  if (await handleCadRequest(request, response, directory)) return;

  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(CLIENT_HTML);
    return;
  }

  if (url.pathname === "/api/report") {
    const paths = await viewPathsFromDirectory(directory);
    const report = await analyzeViewSet(paths);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        directory,
        labels: Object.fromEntries(VIEW_IDS.map((id) => [id, VIEWS[id].label])),
        available: Object.keys(paths),
        report,
      }),
    );
    return;
  }

  const viewMatch = /^\/views\/([a-z]+)$/.exec(url.pathname);
  if (viewMatch) {
    const id = viewMatch[1] ?? "";
    const paths = await viewPathsFromDirectory(directory);
    const path = isViewId(id) ? paths[id] : undefined;
    if (!path) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("뷰 없음");
      return;
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(await readFile(path));
    return;
  }

  const uploadMatch = /^\/api\/upload\/([a-z]+)$/.exec(url.pathname);
  if (uploadMatch && request.method === "POST") {
    const id = uploadMatch[1] ?? "";
    if (!isViewId(id)) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("알 수 없는 뷰 이름");
      return;
    }
    const body = await readBody(request);
    // Everything is normalised to PNG so the six slots stay one predictable format.
    const png = await sharp(body).png().toBuffer();
    await mkdir(directory, { recursive: true });
    for (const extension of [".jpg", ".jpeg", ".webp"]) {
      await rm(join(directory, `${id}${extension}`), { force: true });
    }
    await writeFile(join(directory, `${id}.png`), png);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ id, bytes: png.length }));
    return;
  }

  const clearMatch = /^\/api\/clear\/([a-z]+)$/.exec(url.pathname);
  if (clearMatch && request.method === "POST") {
    const id = clearMatch[1] ?? "";
    if (isViewId(id)) {
      for (const extension of [".png", ".jpg", ".jpeg", ".webp"]) {
        await rm(join(directory, `${id}${extension}`), { force: true });
      }
    }
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ id }));
    return;
  }

  if (url.pathname === "/api/carve" && request.method === "POST") {
    const resolution = Number.parseInt(url.searchParams.get("res") ?? "128", 10);
    const objPath = join(directory, "carved.obj");
    const carved = await carveFromViews(
      await viewPathsFromDirectory(directory),
      objPath,
      Number.isFinite(resolution) ? { resolution } : {},
    );
    // Re-render the carved solid so the page can show what was actually built.
    await renderToDirectory(carved.mesh, join(directory, "carved-views"), { size: 384 });

    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        obj: "/model.obj",
        voxels: { x: carved.grid.nx, y: carved.grid.ny, z: carved.grid.nz },
        filled: carved.grid.filled,
        triangles: carved.mesh.indices.length / 3,
        usedViews: carved.grid.views,
        score: carved.report.score,
        verdict: carved.report.verdict,
      }),
    );
    return;
  }

  if (url.pathname === "/model.obj") {
    const objPath = join(directory, "carved.obj");
    if (!existsSync(objPath)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("아직 3D를 만들지 않았습니다.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "model/obj",
      "Content-Disposition": 'attachment; filename="carved.obj"',
      "Cache-Control": "no-store",
    });
    response.end(await readFile(objPath));
    return;
  }

  const carvedMatch = /^\/carved-views\/([a-z]+)$/.exec(url.pathname);
  if (carvedMatch) {
    const path = join(directory, "carved-views", `${carvedMatch[1]}.png`);
    if (!existsSync(path)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("없음");
      return;
    }
    response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
    response.end(await readFile(path));
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("없음");
}

/** Collects a raw request body; uploads post the file bytes directly. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
