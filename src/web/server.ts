import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { VIEWS, VIEW_IDS, isViewId } from "../views.ts";
import { analyzeViewSet } from "../analyze/report.ts";
import { viewPathsFromDirectory } from "../pipeline.ts";
import { CLIENT_HTML } from "./client.ts";

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

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("없음");
}
