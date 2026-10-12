import {
  BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D,
} from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { makeId } from "../core/ids";
import type { CadDocument, MeshAsset } from "../core/types";
import { projectFromJSON, projectToJSON } from "../core/serialization";

/**
 * CADFileManager — all import/export.
 *
 * Deliberate rule: STEP is produced by the OCCT kernel from B-rep solids ONLY.
 * A triangle mesh is never written out with a .step extension, because that file
 * would be unusable in real CAD software even though it would open in a viewer.
 */

export interface ImportedMesh {
  name: string;
  asset: MeshAsset;
}

export class FileError extends Error {}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

/* ------------------------------------------------------------------ import */

export async function importSTL(file: File | Blob, name: string): Promise<ImportedMesh> {
  const buffer = await file.arrayBuffer();
  let geometry: BufferGeometry;
  try {
    geometry = new STLLoader().parse(buffer);
  } catch (err) {
    throw new FileError(`Could not read the STL file: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { name, asset: geometryToAsset(geometry, name) };
}

/** GLB/GLTF is Y-up by spec; the editor is Z-up, so rotate on the way in. */
const GLTF_TO_CAD = new Matrix4().makeRotationX(Math.PI / 2);
const CAD_TO_GLTF = new Matrix4().makeRotationX(-Math.PI / 2);

export async function importGLTF(file: File | Blob, baseName: string): Promise<ImportedMesh[]> {
  const buffer = await file.arrayBuffer();
  const gltf = await new Promise<any>((resolve, reject) => {
    new GLTFLoader().parse(buffer, "", resolve, (err) =>
      reject(new FileError(`Could not read the glTF/GLB file: ${describeError(err)}`)),
    );
  });
  const out: ImportedMesh[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.applyMatrix4(GLTF_TO_CAD);
    const name = mesh.name || `${baseName} part ${out.length + 1}`;
    out.push({ name, asset: geometryToAsset(geometry, name) });
    geometry.dispose();
  });
  if (out.length === 0) throw new FileError("The glTF/GLB file contains no mesh geometry");
  return out;
}

/**
 * OBJ is what the sixview space-carving stage writes. Every sub-object is merged
 * into one asset: a carved surface is a single body, and splitting it by OBJ
 * group would produce meaningless "parts".
 */
export async function importOBJ(file: File | Blob, name: string): Promise<ImportedMesh> {
  const text = await file.text();
  let group: Object3D;
  try {
    group = new OBJLoader().parse(text);
  } catch (err) {
    throw new FileError(`OBJ 파일을 읽지 못했습니다: ${describeError(err)}`);
  }
  group.updateMatrixWorld(true);
  const chunks: BufferGeometry[] = [];
  group.traverse((child) => {
    const mesh = child as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    chunks.push(geometry.index ? geometry.toNonIndexed() : geometry);
  });
  if (chunks.length === 0) throw new FileError("OBJ 파일에 삼각형 메시가 없습니다");

  const total = chunks.reduce((sum, g) => sum + (g.getAttribute("position")?.count ?? 0), 0);
  const positions = new Float32Array(total * 3);
  let offset = 0;
  for (const chunk of chunks) {
    const attr = chunk.getAttribute("position");
    if (attr) {
      positions.set(attr.array as ArrayLike<number>, offset);
      offset += attr.array.length;
    }
    chunk.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute("position", new BufferAttribute(positions, 3));
  merged.computeVertexNormals();
  const asset = geometryToAsset(merged, name);
  merged.dispose();
  return { name, asset };
}

export interface NormalizationResult {
  asset: MeshAsset;
  /** Multiplier applied to every coordinate. 1 means the asset was left alone. */
  factor: number;
  /** Bounding-box size before scaling, in the asset's own units. */
  sourceSize: [number, number, number];
}

/**
 * Scales an asset so its longest bounding-box axis measures `targetMm`.
 *
 * Reconstruction pipelines work in a normalised frame — the output has no
 * physical size. Dropping it in at 1 unit = 1 mm would put a 0.5 mm speck in the
 * workspace. Baking the scale into the vertices (rather than into the object's
 * scale factor) means the dimensions the panel reports are the real ones.
 */
export function normalizeAssetToMm(asset: MeshAsset, targetMm: number): NormalizationResult {
  const p = asset.positions;
  if (p.length < 3 || !(targetMm > 0)) return { asset, factor: 1, sourceSize: [0, 0, 0] };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const v = p[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const sourceSize: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longest = Math.max(...sourceSize);
  if (!(longest > 0)) return { asset, factor: 1, sourceSize };
  const factor = targetMm / longest;
  if (Math.abs(factor - 1) < 1e-9) return { asset, factor: 1, sourceSize };

  // Recentre on the bounding-box centre at the same time: the object's own
  // origin should be its centre, like every primitive this editor creates.
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const scaled = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    scaled[i] = (p[i] - cx) * factor;
    scaled[i + 1] = (p[i + 1] - cy) * factor;
    scaled[i + 2] = (p[i + 2] - cz) * factor;
  }
  return { asset: { ...asset, positions: scaled }, factor, sourceSize };
}

export function geometryToAsset(geometry: BufferGeometry, name: string): MeshAsset {
  const position = geometry.getAttribute("position");
  if (!position) throw new FileError("The mesh has no vertex positions");
  const positions = new Float32Array(position.array as ArrayLike<number>);
  const normalAttr = geometry.getAttribute("normal");
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;
  return {
    id: makeId("ast"),
    name,
    positions,
    normals: normalAttr ? new Float32Array(normalAttr.array as ArrayLike<number>) : undefined,
    indices: index ? new Uint32Array(index.array as ArrayLike<number>) : undefined,
    triangleCount,
  };
}

export function projectFromFile(text: string): CadDocument {
  return projectFromJSON(text);
}

/* ------------------------------------------------------------------ export */

/** Clones world-space geometry so exporters never mutate the live scene. */
function snapshotForExport(nodes: Object3D[]): Group {
  const group = new Group();
  for (const node of nodes) {
    node.updateWorldMatrix(true, true);
    node.traverse((child) => {
      const mesh = child as Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.geometry) return;
      if (!mesh.visible || !isVisibleInTree(mesh)) return;
      const geometry = mesh.geometry.clone();
      geometry.applyMatrix4(mesh.matrixWorld);
      const clone = new Mesh(geometry, new MeshStandardMaterial({
        color: (mesh.material as MeshStandardMaterial).color?.clone?.() ?? undefined,
      }));
      clone.name = mesh.name || mesh.parent?.name || "part";
      group.add(clone);
    });
  }
  return group;
}

function isVisibleInTree(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

export function disposeSnapshot(group: Group) {
  group.traverse((child) => {
    const mesh = child as Mesh;
    mesh.geometry?.dispose?.();
    (mesh.material as MeshStandardMaterial | undefined)?.dispose?.();
  });
}

/** Mesh-level STL, covering solids and imported meshes alike. */
export function exportSceneSTL(nodes: Object3D[], binary = true): Blob {
  const snapshot = snapshotForExport(nodes);
  if (snapshot.children.length === 0) throw new FileError("Nothing visible to export");
  const exporter = new STLExporter();
  const result = exporter.parse(snapshot, { binary }) as unknown;
  disposeSnapshot(snapshot);
  if (!binary) return new Blob([result as string], { type: "model/stl" });
  const view = result as DataView;
  return new Blob([view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer], {
    type: "model/stl",
  });
}

export async function exportSceneGLB(nodes: Object3D[]): Promise<Blob> {
  const snapshot = snapshotForExport(nodes);
  if (snapshot.children.length === 0) throw new FileError("Nothing visible to export");
  // glTF consumers expect Y-up; undo the import-time rotation on the way out.
  snapshot.applyMatrix4(CAD_TO_GLTF);
  snapshot.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  const result = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      snapshot,
      (gltf) => resolve(gltf as ArrayBuffer),
      (err) => reject(new FileError(`GLB export failed: ${describeError(err)}`)),
      { binary: true },
    );
  });
  disposeSnapshot(snapshot);
  return new Blob([result], { type: "model/gltf-binary" });
}

export function exportProjectBlob(doc: CadDocument): Blob {
  return new Blob([projectToJSON(doc)], { type: "application/json" });
}

/* ------------------------------------------------------------------- browser */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick so Firefox has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(input.files ? [...input.files] : []));
    // Cancelling a file dialog fires no event in most browsers; focus is the cue.
    window.addEventListener("focus", () => setTimeout(() => finish([]), 500), { once: true });
    input.click();
  });
}

export function sanitizeFilename(name: string, extension: string): string {
  const base = name.replace(/[^\w\-. ]+/g, "_").trim() || "model";
  return `${base}.${extension}`;
}
