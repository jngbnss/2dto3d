import type { MeshAsset } from "../core/types";

/**
 * Bridge between an AI 2D→3D generation pipeline and the CAD workspace.
 *
 * The single most important rule encoded here: *preview images are not geometry*.
 * A generator that has produced six orthographic renders has produced pictures,
 * not a model. `classifyAsset` makes that distinction explicit so the workspace
 * can refuse to "import" something that cannot be imported, instead of creating
 * an empty object and calling it a CAD part.
 */

export type AiAssetKind = "mesh" | "solid" | "images-only" | "missing";

export interface AiAssetRef {
  /** mesh = triangles, solid = B-rep (STEP). */
  kind: "mesh" | "solid";
  format: "stl" | "glb" | "gltf" | "obj" | "step";
  /** Either a fetchable URL or inline data. */
  url?: string;
  data?: ArrayBuffer | string;
  byteSize?: number;
  /**
   * Reconstruction output is unitless. When set, the importer scales the asset
   * so its longest bounding-box axis measures this many millimetres and tells
   * the user it did so. Omit when the asset already carries real dimensions.
   */
  normalizeToMm?: number;
}

export interface AiModelDescriptor {
  id: string;
  name: string;
  createdAt: number;
  /** Source 2D input(s) that drove the generation. */
  sourceImages?: string[];
  /** The six orthographic previews many pipelines emit. NOT geometry. */
  orthoViews?: Partial<Record<"front" | "back" | "left" | "right" | "top" | "bottom", string>>;
  asset?: AiAssetRef | null;
  /** Free-form generator metadata, surfaced read-only in the UI. */
  meta?: Record<string, string | number>;
}

export interface AiPipelineAdapter {
  id: string;
  label: string;
  /** Short description shown in the import dialog. */
  description: string;
  list(): Promise<AiModelDescriptor[]>;
  load(id: string): Promise<AiModelDescriptor>;
}

export interface AssetClassification {
  kind: AiAssetKind;
  /** What the editor can do once imported. */
  editable: "parametric" | "mesh-only" | "none";
  reason: string;
}

const MESH_FORMATS = new Set(["stl", "glb", "gltf", "obj"]);

/**
 * Decides what a descriptor actually contains. Never optimistic: an entry with
 * six beautiful preview renders and no asset is reported as `images-only`.
 */
export function classifyAsset(descriptor: AiModelDescriptor): AssetClassification {
  const asset = descriptor.asset;
  const viewCount = Object.keys(descriptor.orthoViews ?? {}).length;
  if (!asset || (!asset.url && asset.data == null)) {
    if (viewCount > 0) {
      return {
        kind: "images-only",
        editable: "none",
        reason: `This result contains ${viewCount} preview image(s) but no 3D geometry. Preview renders cannot be imported as a model.`,
      };
    }
    return { kind: "missing", editable: "none", reason: "This result has no 3D asset attached." };
  }
  if (asset.kind === "solid" && asset.format === "step") {
    return {
      kind: "solid",
      editable: "parametric",
      reason: "B-rep solid (STEP). Boolean operations and CAD edits are available.",
    };
  }
  if (asset.kind === "mesh" && MESH_FORMATS.has(asset.format)) {
    return {
      kind: "mesh",
      editable: "mesh-only",
      reason:
        "Triangle mesh. Move, rotate, scale, measure and export are available. Dimension-driven CAD editing is NOT — that would require solid reconstruction.",
    };
  }
  return { kind: "missing", editable: "none", reason: `Unsupported asset format: ${asset.format}` };
}

export async function resolveAssetBytes(asset: AiAssetRef): Promise<ArrayBuffer | string> {
  if (asset.data != null) return asset.data;
  if (!asset.url) throw new Error("Asset has neither inline data nor a URL");
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Could not fetch the asset (HTTP ${response.status})`);
  return asset.format === "step" ? response.text() : response.arrayBuffer();
}

/* --------------------------------------------------------- sixview adapter */

/**
 * The adapter for THIS project's pipeline.
 *
 * The CAD editor is served by the sixview preview server, so the endpoints are
 * same-origin and need no configuration. `/api/cad/models` reports what the
 * pipeline has on disk — including runs that produced only view images, which
 * come back with `asset: null` and are correctly refused by `classifyAsset`.
 */
export function createSixviewAdapter(): AiPipelineAdapter {
  return {
    id: "sixview",
    label: "sixview 파이프라인 결과",
    description:
      "현재 out 디렉터리의 2D→3D 결과입니다. carve 단계가 끝난 결과만 가져올 수 있고, 뷰 이미지만 있는 결과는 형상이 아니므로 차단됩니다.",
    async list() {
      const res = await fetch("/api/cad/models");
      if (!res.ok) throw new Error(`파이프라인 서버 응답 오류 (HTTP ${res.status})`);
      return (await res.json()) as AiModelDescriptor[];
    },
    async load(id: string) {
      const res = await fetch(`/api/cad/models/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`파이프라인 서버 응답 오류 (HTTP ${res.status})`);
      return (await res.json()) as AiModelDescriptor;
    },
  };
}

/* ------------------------------------------------------------- HTTP adapter */

/**
 * Adapter for a real pipeline. Point `VITE_AI_PIPELINE_URL` at a service that
 * implements:
 *
 *   GET {base}/models        -> AiModelDescriptor[]
 *   GET {base}/models/:id    -> AiModelDescriptor
 *
 * Asset URLs may be absolute or relative to {base}.
 */
export function createHttpAdapter(baseUrl: string): AiPipelineAdapter {
  const base = baseUrl.replace(/\/$/, "");
  const absolutise = (d: AiModelDescriptor): AiModelDescriptor => {
    if (d.asset?.url && !/^https?:|^data:|^blob:/.test(d.asset.url)) {
      return { ...d, asset: { ...d.asset, url: `${base}/${d.asset.url.replace(/^\//, "")}` } };
    }
    return d;
  };
  return {
    id: "http",
    label: "Connected generator",
    description: `2D→3D results served by ${base}`,
    async list() {
      const res = await fetch(`${base}/models`);
      if (!res.ok) throw new Error(`Generator responded with HTTP ${res.status}`);
      const data = (await res.json()) as AiModelDescriptor[];
      return data.map(absolutise);
    },
    async load(id: string) {
      const res = await fetch(`${base}/models/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`Generator responded with HTTP ${res.status}`);
      return absolutise((await res.json()) as AiModelDescriptor);
    },
  };
}

/* ------------------------------------------------------------ local adapter */

/**
 * Lets the user hand the workspace a file produced by any pipeline, with no
 * server involved. Registered descriptors live for the session only.
 */
export function createLocalAdapter(): AiPipelineAdapter & {
  register(descriptor: AiModelDescriptor): void;
} {
  const entries = new Map<string, AiModelDescriptor>();
  return {
    id: "local",
    label: "Local results",
    description: "2D→3D results you hand over from disk (STL, GLB or STEP).",
    register(descriptor) {
      entries.set(descriptor.id, descriptor);
    },
    async list() {
      return [...entries.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
    async load(id) {
      const found = entries.get(id);
      if (!found) throw new Error("That result is no longer available in this session");
      return found;
    },
  };
}

export interface ImportedAiModel {
  descriptor: AiModelDescriptor;
  classification: AssetClassification;
  meshes?: { name: string; asset: MeshAsset }[];
  stepText?: string;
}
