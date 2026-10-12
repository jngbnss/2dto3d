import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The editor is served by the sixview preview server under /cad, so the built
 * asset URLs must be /cad-relative. In dev, /api and /views are proxied to that
 * same server (`node src/cli.ts serve`) so the AI-result browser works without
 * a separate build.
 */
const SIXVIEW_SERVER = process.env.SIXVIEW_SERVER ?? "http://127.0.0.1:5173";

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
  },
  server: {
    port: 5174,
    host: "127.0.0.1",
    proxy: {
      "/api/cad": { target: SIXVIEW_SERVER, changeOrigin: true },
      "/views": { target: SIXVIEW_SERVER, changeOrigin: true },
    },
  },
});
