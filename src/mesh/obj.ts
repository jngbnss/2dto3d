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

/** Wavefront OBJ with per-vertex colours, the form most viewers accept. */
export function toObj(mesh: Mesh, comment: string): string {
  const lines: string[] = [`# ${comment}`];
  const hasColor = mesh.colors.length === mesh.positions.length;

  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    const x = (mesh.positions[i] ?? 0).toFixed(5);
    const y = (mesh.positions[i + 1] ?? 0).toFixed(5);
    const z = (mesh.positions[i + 2] ?? 0).toFixed(5);
    if (hasColor) {
      const r = (mesh.colors[i] ?? 1).toFixed(4);
      const g = (mesh.colors[i + 1] ?? 1).toFixed(4);
      const b = (mesh.colors[i + 2] ?? 1).toFixed(4);
      lines.push(`v ${x} ${y} ${z} ${r} ${g} ${b}`);
    } else {
      lines.push(`v ${x} ${y} ${z}`);
    }
  }
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    lines.push(
      `f ${(mesh.indices[i] ?? 0) + 1} ${(mesh.indices[i + 1] ?? 0) + 1} ${(mesh.indices[i + 2] ?? 0) + 1}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
