import { computeBounds, type Mesh } from "./types.ts";

/**
 * Wavefront OBJ reader: `v` (with optional trailing rgb) and `f` only. Polygons
 * are fan-triangulated; negative indices are relative to the current vertex count.
 */
export function parseObj(bytes: Uint8Array): Mesh {
  const text = new TextDecoder().decode(bytes);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let anyColor = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0];

    if (keyword === "v") {
      positions.push(Number(parts[1] ?? 0), Number(parts[2] ?? 0), Number(parts[3] ?? 0));
      if (parts.length >= 7) {
        anyColor = true;
        colors.push(Number(parts[4] ?? 1), Number(parts[5] ?? 1), Number(parts[6] ?? 1));
      } else {
        colors.push(1, 1, 1);
      }
    } else if (keyword === "f") {
      const corners: number[] = [];
      const vertexCount = positions.length / 3;
      for (let i = 1; i < parts.length; i++) {
        const token = parts[i]?.split("/")[0];
        if (!token) continue;
        const parsed = Number.parseInt(token, 10);
        if (!Number.isFinite(parsed)) continue;
        corners.push(parsed > 0 ? parsed - 1 : vertexCount + parsed);
      }
      for (let i = 1; i + 1 < corners.length; i++) {
        indices.push(corners[0] ?? 0, corners[i] ?? 0, corners[i + 1] ?? 0);
      }
    }
  }

  if (positions.length === 0 || indices.length === 0) {
    throw new Error("OBJ에서 삼각형 지오메트리를 찾지 못했습니다.");
  }
  const positionArray = Float32Array.from(positions);
  return {
    positions: positionArray,
    indices: Uint32Array.from(indices),
    colors: anyColor ? Float32Array.from(colors) : new Float32Array(0),
    bounds: computeBounds(positionArray),
  };
}
