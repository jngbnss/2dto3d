import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The pages are served by the sixview preview server (studio at `/`, assets
 * under /cad), so the built asset URLs must be /cad-relative. In dev, the
 * server's API, image and model routes are proxied to that same server
 * (`node src/cli.ts serve`) so the pages work without a separate build.
 */
const SIXVIEW_SERVER = process.env.SIXVIEW_SERVER ?? "http://127.0.0.1:5173";
const PROXIED = ["/api", "/views", "/prepared", "/outline", "/result", "/model.glb", "/model.obj", "/voxels.glb", "/viewer"];

export default defineConfig({
  base: "/cad/",
  plugins: [react()],
  worker: {
    // The CAD kernel worker is an ES module (it imports replicad + the OCCT wasm).
    format: "es",
  },
  optimizeDeps: {
    // The OpenCascade glue is an Emscripten bundle: pre-bundling rewrites its
    // wasm URL handling and breaks instantiation.
    exclude: ["replicad-opencascadejs"],
  },
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      // Three pages: the CAD editor, the look-around viewer, and the 5-view upload studio.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        viewer: resolve(import.meta.dirname, "viewer.html"),
        studio: resolve(import.meta.dirname, "studio.html"),
      },
    },
  },
  server: {
    port: 5174,
    host: "127.0.0.1",
    proxy: Object.fromEntries(PROXIED.map((path) => [path, { target: SIXVIEW_SERVER, changeOrigin: true }])),
  },
});
