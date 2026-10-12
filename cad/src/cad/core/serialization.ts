import type { CadDocument, CadObject, MeshAsset } from "./types";
import { PROJECT_FORMAT, PROJECT_VERSION } from "./types";
import { createDocument } from "./factories";

/**
 * Project file format (.wcad / JSON).
 *
 * Everything the editor needs to reproduce the model is in here: the object
 * tree, every feature's parameters (so dimensions and boolean/hole history
 * survive a round trip), placements, mesh assets and the operation log.
 */

interface SerializedAsset {
  id: string;
  name: string;
  positions: string;
  normals?: string;
  indices?: string;
  triangleCount: number;
}

export interface SerializedProject {
  format: typeof PROJECT_FORMAT;
  version: number;
  name: string;
  displayUnit: CadDocument["displayUnit"];
  objects: CadObject[];
  assets: SerializedAsset[];
  operationLog: CadDocument["operationLog"];
  createdAt: number;
  updatedAt: number;
}

function toBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function serializeProject(doc: CadDocument): SerializedProject {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: doc.name,
    displayUnit: doc.displayUnit,
    objects: Object.values(doc.objects),
    assets: Object.values(doc.assets).map((a) => ({
      id: a.id,
      name: a.name,
      positions: toBase64(a.positions.buffer),
      normals: a.normals ? toBase64(a.normals.buffer) : undefined,
      indices: a.indices ? toBase64(a.indices.buffer) : undefined,
      triangleCount: a.triangleCount,
    })),
    operationLog: doc.operationLog,
    createdAt: doc.createdAt,
    updatedAt: Date.now(),
  };
}

export class ProjectParseError extends Error {}

export function deserializeProject(raw: unknown): CadDocument {
  if (!raw || typeof raw !== "object") throw new ProjectParseError("Not a project file");
  const p = raw as Partial<SerializedProject>;
  if (p.format !== PROJECT_FORMAT) {
    throw new ProjectParseError("Unrecognised file: this is not a Web CAD project");
  }
  if (typeof p.version !== "number" || p.version > PROJECT_VERSION) {
    throw new ProjectParseError(
      `This project was saved by a newer version (v${p.version}); this editor supports up to v${PROJECT_VERSION}`,
    );
  }
  const doc = createDocument(p.name || "Untitled project");
  doc.displayUnit = p.displayUnit ?? "mm";
  doc.createdAt = p.createdAt ?? Date.now();
  doc.updatedAt = p.updatedAt ?? Date.now();
  doc.operationLog = Array.isArray(p.operationLog) ? p.operationLog : [];

  for (const asset of p.assets ?? []) {
    const positions = new Float32Array(fromBase64(asset.positions));
    const parsed: MeshAsset = {
      id: asset.id,
      name: asset.name,
      positions,
      normals: asset.normals ? new Float32Array(fromBase64(asset.normals)) : undefined,
      indices: asset.indices ? new Uint32Array(fromBase64(asset.indices)) : undefined,
      triangleCount: asset.triangleCount ?? positions.length / 9,
    };
    doc.assets[parsed.id] = parsed;
  }

  for (const o of p.objects ?? []) {
    if (!o || typeof o.id !== "string") continue;
    doc.objects[o.id] = o;
  }

  // Drop dangling parent links rather than rendering an orphaned tree.
  for (const o of Object.values(doc.objects)) {
    if (o.parentId && !doc.objects[o.parentId]) o.parentId = null;
  }
  return doc;
}

export function projectToJSON(doc: CadDocument): string {
  return JSON.stringify(serializeProject(doc));
}

export function projectFromJSON(text: string): CadDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectParseError("The project file is not valid JSON");
  }
  return deserializeProject(parsed);
}
