import type { Raster } from "./analyze/raster.ts";
import type { Silhouette } from "./analyze/silhouette.ts";
import type { Mesh } from "./mesh/types.ts";
import { colourDistance } from "./reconstruct/finish.ts";
import type { RenderedView } from "./render/ortho.ts";

export interface ProjectionQuality {
  readonly iou: number;
  /** Symmetric mean contour distance, divided by image width. */
  readonly contourDistance: number;
  /** Distance between silhouette centroids, divided by image width. */
  readonly centerError: number;
  /** Mean relative bbox width/height error. */
  readonly ratioError: number;
  /** Direct source-pixel versus rerender colour agreement, 0..1. */
  readonly colourMatch: number;
}

export interface MeshQuality {
  readonly components: number;
  readonly boundaryEdges: number;
  readonly nonManifoldEdges: number;
  readonly degenerateTriangles: number;
  /** Null when the bounded broad-phase budget is exhausted. */
  readonly selfIntersections: number | null;
}

export function compareProjection(
  silhouette: Silhouette,
  source: Raster,
  rendered: RenderedView,
): ProjectionQuality {
  const renderMask = new Uint8Array(silhouette.mask.length);
  let intersection = 0;
  let union = 0;
  let sourceX = 0;
  let sourceY = 0;
  let sourceCount = 0;
  let renderX = 0;
  let renderY = 0;
  let renderCount = 0;
  let colour = 0;
  let colourCount = 0;
  for (let y = 0; y < silhouette.height; y++) {
    for (let x = 0; x < silhouette.width; x++) {
      const index = y * silhouette.width + x;
      const a = silhouette.mask[index] === 1;
      const b = (rendered.pixels[index * 4 + 3] ?? 0) >= 128;
      renderMask[index] = b ? 1 : 0;
      if (a) {
        sourceX += x + 0.5;
        sourceY += y + 0.5;
        sourceCount++;
      }
      if (b) {
        renderX += x + 0.5;
        renderY += y + 0.5;
        renderCount++;
      }
      if (a && b) {
        intersection++;
        const sourceIndex = pixelIndex(source, x, y, silhouette.width, silhouette.height);
        const sr = (source.data[sourceIndex] ?? 0) / 255;
        const sg = (source.data[sourceIndex + 1] ?? 0) / 255;
        const sb = (source.data[sourceIndex + 2] ?? 0) / 255;
        const rr = (rendered.pixels[index * 4] ?? 0) / 255;
        const rg = (rendered.pixels[index * 4 + 1] ?? 0) / 255;
        const rb = (rendered.pixels[index * 4 + 2] ?? 0) / 255;
        colour += colourDistance([sr, sg, sb], [rr, rg, rb]);
        colourCount++;
      }
      if (a || b) union++;
    }
  }
  const sourceBox = maskBounds(silhouette.mask, silhouette.width, silhouette.height);
  const renderBox = maskBounds(renderMask, silhouette.width, silhouette.height);
  const relative = (a: number, b: number): number => Math.abs(a - b) / Math.max(a, b, 1);
  const ratioError = sourceBox && renderBox
    ? (relative(sourceBox.x1 - sourceBox.x0, renderBox.x1 - renderBox.x0) + relative(sourceBox.y1 - sourceBox.y0, renderBox.y1 - renderBox.y0)) / 2
    : 1;
  const centerError = sourceCount > 0 && renderCount > 0
    ? Math.hypot(sourceX / sourceCount - renderX / renderCount, sourceY / sourceCount - renderY / renderCount) / silhouette.width
    : 1;
  return {
    iou: union > 0 ? intersection / union : 0,
    contourDistance: symmetricContourDistance(silhouette.mask, renderMask, silhouette.width, silhouette.height) / silhouette.width,
    centerError,
    ratioError,
    colourMatch: colourCount > 0 ? clamp01(1 - colour / colourCount / 0.35) : 0,
  };
}

export function inspectMesh(mesh: Mesh, pairBudget = 2_000_000): MeshQuality {
  const vertexCount = mesh.positions.length / 3;
  const canonical = canonicalVertices(mesh);
  const parent = Int32Array.from({ length: vertexCount }, (_, index) => index);
  const find = (value: number): number => {
    let root = value;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    while (value !== root) {
      const next = parent[value] ?? value;
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const edges = new Map<string, number>();
  const used = new Set<number>();
  let degenerateTriangles = 0;
  for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
    const triangle = [
      canonical[mesh.indices[index] ?? 0] ?? 0,
      canonical[mesh.indices[index + 1] ?? 0] ?? 0,
      canonical[mesh.indices[index + 2] ?? 0] ?? 0,
    ] as const;
    triangle.forEach((vertex) => used.add(vertex));
    const root = find(triangle[0]);
    parent[find(triangle[1])] = root;
    parent[find(triangle[2])] = root;
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle[edge] ?? 0;
      const b = triangle[(edge + 1) % 3] ?? 0;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    if (triangleArea2(mesh.positions, triangle) <= 1e-12) degenerateTriangles++;
  }
  const counts = [...edges.values()];
  return {
    components: new Set([...used].map((index) => find(index))).size,
    boundaryEdges: counts.filter((count) => count === 1).length,
    nonManifoldEdges: counts.filter((count) => count > 2).length,
    degenerateTriangles,
    selfIntersections: selfIntersectionCount(mesh, canonical, pairBudget),
  };
}

function canonicalVertices(mesh: Mesh): Int32Array {
  const span = Math.max(
    mesh.bounds.max[0] - mesh.bounds.min[0],
    mesh.bounds.max[1] - mesh.bounds.min[1],
    mesh.bounds.max[2] - mesh.bounds.min[2],
    1,
  );
  const epsilon = span * 1e-7;
  const representatives = new Map<string, number>();
  const canonical = new Int32Array(mesh.positions.length / 3);
  for (let vertex = 0; vertex < canonical.length; vertex++) {
    const key = [0, 1, 2].map((axis) => Math.round((mesh.positions[vertex * 3 + axis] ?? 0) / epsilon)).join(":");
    const representative = representatives.get(key);
    if (representative === undefined) {
      representatives.set(key, vertex);
      canonical[vertex] = vertex;
    } else {
      canonical[vertex] = representative;
    }
  }
  return canonical;
}

function symmetricContourDistance(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const edgeA = boundary(a, width, height);
  const edgeB = boundary(b, width, height);
  const distanceA = chamfer(edgeA, width, height);
  const distanceB = chamfer(edgeB, width, height);
  let sum = 0;
  let count = 0;
  for (let index = 0; index < edgeA.length; index++) {
    if (edgeA[index] === 1) {
      sum += distanceB[index] ?? width;
      count++;
    }
    if (edgeB[index] === 1) {
      sum += distanceA[index] ?? width;
      count++;
    }
  }
  return count > 0 ? sum / count : width;
}

function boundary(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (mask[index] !== 1) continue;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || mask[index - 1] !== 1 || mask[index + 1] !== 1 || mask[index - width] !== 1 || mask[index + width] !== 1) out[index] = 1;
    }
  }
  return out;
}

function chamfer(edges: Uint8Array, width: number, height: number): Float32Array {
  const distance = new Float32Array(edges.length);
  distance.fill(width + height);
  for (let index = 0; index < edges.length; index++) if (edges[index] === 1) distance[index] = 0;
  const diagonal = Math.SQRT2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (x > 0) distance[i] = Math.min(distance[i] ?? 0, (distance[i - 1] ?? 0) + 1);
    if (y > 0) distance[i] = Math.min(distance[i] ?? 0, (distance[i - width] ?? 0) + 1);
    if (x > 0 && y > 0) distance[i] = Math.min(distance[i] ?? 0, (distance[i - width - 1] ?? 0) + diagonal);
    if (x + 1 < width && y > 0) distance[i] = Math.min(distance[i] ?? 0, (distance[i - width + 1] ?? 0) + diagonal);
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (x + 1 < width) distance[i] = Math.min(distance[i] ?? 0, (distance[i + 1] ?? 0) + 1);
    if (y + 1 < height) distance[i] = Math.min(distance[i] ?? 0, (distance[i + width] ?? 0) + 1);
    if (x + 1 < width && y + 1 < height) distance[i] = Math.min(distance[i] ?? 0, (distance[i + width + 1] ?? 0) + diagonal);
    if (x > 0 && y + 1 < height) distance[i] = Math.min(distance[i] ?? 0, (distance[i + width - 1] ?? 0) + diagonal);
  }
  return distance;
}

function maskBounds(mask: Uint8Array, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x] === 1) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + 1);
    y1 = Math.max(y1, y + 1);
  }
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

function pixelIndex(raster: Raster, x: number, y: number, width: number, height: number): number {
  const px = Math.min(raster.width - 1, Math.max(0, Math.floor(((x + 0.5) / width) * raster.width)));
  const py = Math.min(raster.height - 1, Math.max(0, Math.floor(((y + 0.5) / height) * raster.height)));
  return (py * raster.width + px) * 4;
}

function triangleArea2(positions: Float32Array, triangle: readonly [number, number, number]): number {
  const a = triangle[0] * 3;
  const b = triangle[1] * 3;
  const c = triangle[2] * 3;
  const ux = (positions[b] ?? 0) - (positions[a] ?? 0);
  const uy = (positions[b + 1] ?? 0) - (positions[a + 1] ?? 0);
  const uz = (positions[b + 2] ?? 0) - (positions[a + 2] ?? 0);
  const vx = (positions[c] ?? 0) - (positions[a] ?? 0);
  const vy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0);
  const vz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0);
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

interface TriangleBox {
  readonly index: number;
  readonly vertices: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

function selfIntersectionCount(mesh: Mesh, canonical: Int32Array, budget: number): number | null {
  const triangles: TriangleBox[] = [];
  for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
    const vertices = [
      canonical[mesh.indices[index] ?? 0] ?? 0,
      canonical[mesh.indices[index + 1] ?? 0] ?? 0,
      canonical[mesh.indices[index + 2] ?? 0] ?? 0,
    ] as const;
    const points = vertices.map((vertex) => [mesh.positions[vertex * 3] ?? 0, mesh.positions[vertex * 3 + 1] ?? 0, mesh.positions[vertex * 3 + 2] ?? 0] as const);
    triangles.push({
      index: index / 3,
      vertices,
      min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.min(...points.map((p) => p[2]))],
      max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1])), Math.max(...points.map((p) => p[2]))],
    });
  }
  triangles.sort((a, b) => a.min[0] - b.min[0]);
  let checked = 0;
  let intersections = 0;
  for (let i = 0; i < triangles.length; i++) {
    const a = triangles[i]!;
    for (let j = i + 1; j < triangles.length; j++) {
      const b = triangles[j]!;
      if (b.min[0] > a.max[0]) break;
      if (++checked > budget) return null;
      if (a.vertices.some((vertex) => b.vertices.includes(vertex))) continue;
      if (a.min[1] > b.max[1] || b.min[1] > a.max[1] || a.min[2] > b.max[2] || b.min[2] > a.max[2]) continue;
      if (trianglesIntersect(mesh.positions, a.vertices, b.vertices)) intersections++;
    }
  }
  return intersections;
}

function trianglesIntersect(positions: Float32Array, a: readonly number[], b: readonly number[]): boolean {
  const point = (vertex: number): [number, number, number] => [positions[vertex * 3] ?? 0, positions[vertex * 3 + 1] ?? 0, positions[vertex * 3 + 2] ?? 0];
  const ap = a.map(point);
  const bp = b.map(point);
  for (let edge = 0; edge < 3; edge++) {
    if (segmentTriangle(ap[edge]!, ap[(edge + 1) % 3]!, bp[0]!, bp[1]!, bp[2]!)) return true;
    if (segmentTriangle(bp[edge]!, bp[(edge + 1) % 3]!, ap[0]!, ap[1]!, ap[2]!)) return true;
  }
  return false;
}

function segmentTriangle(p0: readonly number[], p1: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[]): boolean {
  const direction = [p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!] as const;
  const edge1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!] as const;
  const edge2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!] as const;
  const cross = (u: readonly number[], v: readonly number[]) => [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!] as const;
  const dot = (u: readonly number[], v: readonly number[]) => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
  const h = cross(direction, edge2);
  const determinant = dot(edge1, h);
  if (Math.abs(determinant) < 1e-10) return false;
  const inverse = 1 / determinant;
  const s = [p0[0]! - a[0]!, p0[1]! - a[1]!, p0[2]! - a[2]!] as const;
  const u = inverse * dot(s, h);
  if (u <= 1e-7 || u >= 1 - 1e-7) return false;
  const q = cross(s, edge1);
  const v = inverse * dot(direction, q);
  if (v <= 1e-7 || u + v >= 1 - 1e-7) return false;
  const t = inverse * dot(edge2, q);
  return t > 1e-7 && t < 1 - 1e-7;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
