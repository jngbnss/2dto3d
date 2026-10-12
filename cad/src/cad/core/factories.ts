import { makeId } from "./ids";
import type {
  CadDocument, CadObject, Feature, GroupObject, MeshObject, PrimitiveType,
  SolidObject, Transform, Vec3,
} from "./types";
import { PROJECT_FORMAT, PROJECT_VERSION } from "./types";

export const PALETTE = [
  "#5aa9e6", "#f4a259", "#8bc34a", "#e26d5c", "#b388eb",
  "#4dd0c1", "#f2c14e", "#9aa5b1", "#ef7ab5", "#7ec4cf",
];

let colorCursor = 0;
export function nextColor(): string {
  const c = PALETTE[colorCursor % PALETTE.length];
  colorCursor += 1;
  return c;
}

export function identityTransform(position: Vec3 = [0, 0, 0]): Transform {
  return { position: [...position] as Vec3, rotation: [0, 0, 0] };
}

export const DEFAULT_PRIMITIVES: Record<PrimitiveType, Feature> = {
  box: { type: "box", width: 50, depth: 50, height: 50 },
  cylinder: { type: "cylinder", radius: 20, height: 60 },
  sphere: { type: "sphere", radius: 25 },
  cone: { type: "cone", bottomRadius: 25, topRadius: 0, height: 60 },
};

export const PRIMITIVE_LABEL: Record<PrimitiveType, string> = {
  box: "Box",
  cylinder: "Cylinder",
  sphere: "Sphere",
  cone: "Cone",
};

export function createSolid(
  feature: Feature,
  options: { name: string; position?: Vec3; color?: string; order?: number } ,
): SolidObject {
  return {
    id: makeId("sld"),
    kind: "solid",
    name: options.name,
    parentId: null,
    visible: true,
    color: options.color ?? nextColor(),
    order: options.order ?? 0,
    feature,
    transform: identityTransform(options.position),
  };
}

export function createMesh(
  assetId: string,
  options: {
    name: string;
    origin: MeshObject["origin"];
    position?: Vec3;
    color?: string;
    order?: number;
    provenance?: MeshObject["provenance"];
  },
): MeshObject {
  return {
    id: makeId("msh"),
    kind: "mesh",
    name: options.name,
    parentId: null,
    visible: true,
    color: options.color ?? nextColor(),
    order: options.order ?? 0,
    transform: identityTransform(options.position),
    scale: [1, 1, 1],
    assetId,
    origin: options.origin,
    provenance: options.provenance,
  };
}

export function createGroup(name: string, order = 0): GroupObject {
  return {
    id: makeId("grp"),
    kind: "group",
    name,
    parentId: null,
    visible: true,
    color: "#9aa5b1",
    order,
    transform: identityTransform(),
  };
}

export function createDocument(name = "Untitled project"): CadDocument {
  const now = Date.now();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name,
    displayUnit: "mm",
    objects: {},
    assets: {},
    operationLog: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Deep structural clone of the document for the undo stack. */
export function cloneDocument(doc: CadDocument): CadDocument {
  const objects: Record<string, CadObject> = {};
  for (const [id, o] of Object.entries(doc.objects)) {
    objects[id] = structuredClone(o);
  }
  return {
    ...doc,
    objects,
    // Mesh assets are immutable once created: share them by reference so that
    // undo snapshots of a 2M-triangle AI mesh stay cheap.
    assets: { ...doc.assets },
    operationLog: [...doc.operationLog],
  };
}
