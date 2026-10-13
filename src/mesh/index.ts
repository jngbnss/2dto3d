import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseGlb } from "./glb.ts";
import { parseObj } from "./obj.ts";
import type { Mesh, MeshFormat } from "./types.ts";

export * from "./types.ts";
export { glbHasSurfaceColor, parseGlb, wrapGlbRoot, writeGlb } from "./glb.ts";
export { parseObj, toObj } from "./obj.ts";

/** Returns geometry exactly as authored; the renderer owns centring and framing. */
export function parseMesh(bytes: Uint8Array, format: MeshFormat): Mesh {
  return format === "obj" ? parseObj(bytes) : parseGlb(bytes);
}

export async function loadMesh(path: string): Promise<Mesh> {
  const extension = extname(path).toLowerCase();
  const format: MeshFormat = extension === ".obj" ? "obj" : "glb";
  if (![".obj", ".glb", ".gltf"].includes(extension)) {
    throw new Error(`지원하지 않는 메시 확장자 '${extension}'. .glb, .gltf, .obj만 읽습니다.`);
  }
  return parseMesh(await readFile(path), format);
}
