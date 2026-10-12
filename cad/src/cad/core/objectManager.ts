import { makeId } from "./ids";
import { createGroup, identityTransform } from "./factories";
import { cloneTransform, relativeTransform, worldTransform } from "./transforms";
import type {
  BooleanOp, CadDocument, CadObject, Feature, GroupObject, HoleSpec,
  SolidObject, SolidRecipe, Transform, Vec3,
} from "./types";

/**
 * CADObjectManager — every structural change to the document lives here.
 *
 * All functions mutate a *draft* document (produced by `cloneDocument`) so the
 * store can snapshot the previous state for undo without any proxy machinery.
 */

export function childrenOf(doc: CadDocument, parentId: string | null): CadObject[] {
  return Object.values(doc.objects)
    .filter((o) => o.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function descendantsOf(doc: CadDocument, id: string, acc: string[] = []): string[] {
  for (const child of childrenOf(doc, id)) {
    acc.push(child.id);
    descendantsOf(doc, child.id, acc);
  }
  return acc;
}

/** True when `ancestorId` is `id` or sits above it. Guards against cycles. */
export function isAncestor(doc: CadDocument, ancestorId: string, id: string): boolean {
  let current: CadObject | undefined = doc.objects[id];
  const seen = new Set<string>();
  while (current) {
    if (current.id === ancestorId) return true;
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = current.parentId ? doc.objects[current.parentId] : undefined;
  }
  return false;
}

/** Visible in the viewport only if the object and every ancestor is visible. */
export function isEffectivelyVisible(doc: CadDocument, id: string): boolean {
  let current: CadObject | undefined = doc.objects[id];
  const seen = new Set<string>();
  while (current) {
    if (!current.visible) return false;
    if (seen.has(current.id)) return true;
    seen.add(current.id);
    current = current.parentId ? doc.objects[current.parentId] : undefined;
  }
  return true;
}

function nextOrder(doc: CadDocument, parentId: string | null): number {
  const siblings = childrenOf(doc, parentId);
  return siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0;
}

export function uniqueName(doc: CadDocument, base: string): string {
  const taken = new Set(Object.values(doc.objects).map((o) => o.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${makeId("x")}`;
}

export function addObject(doc: CadDocument, object: CadObject, parentId: string | null = null): CadObject {
  const placed = { ...object, parentId, order: nextOrder(doc, parentId) };
  placed.name = uniqueName(doc, placed.name);
  doc.objects[placed.id] = placed;
  return placed;
}

export function removeObjects(doc: CadDocument, ids: string[]): string[] {
  const doomed = new Set<string>();
  for (const id of ids) {
    if (!doc.objects[id]) continue;
    doomed.add(id);
    for (const d of descendantsOf(doc, id)) doomed.add(d);
  }
  for (const id of doomed) delete doc.objects[id];
  collectGarbageAssets(doc);
  return [...doomed];
}

/** Drops mesh assets nothing references any more, so projects do not bloat. */
export function collectGarbageAssets(doc: CadDocument) {
  const used = new Set<string>();
  for (const o of Object.values(doc.objects)) {
    if (o.kind === "mesh") used.add(o.assetId);
  }
  for (const id of Object.keys(doc.assets)) {
    if (!used.has(id)) delete doc.assets[id];
  }
}

export function renameObject(doc: CadDocument, id: string, name: string) {
  const o = doc.objects[id];
  if (!o) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  o.name = trimmed === o.name ? trimmed : uniqueName(doc, trimmed);
}

export function setVisible(doc: CadDocument, id: string, visible: boolean) {
  const o = doc.objects[id];
  if (o) o.visible = visible;
}

export function setColor(doc: CadDocument, id: string, color: string) {
  const o = doc.objects[id];
  if (o) o.color = color;
}

export function setTransform(doc: CadDocument, id: string, transform: Transform) {
  const o = doc.objects[id];
  if (o) o.transform = cloneTransform(transform);
}

export function setMeshScale(doc: CadDocument, id: string, scale: Vec3) {
  const o = doc.objects[id];
  if (o?.kind === "mesh") o.scale = [...scale] as Vec3;
}

/** Parametric edit: replaces the feature, which forces a kernel rebuild. */
export function setFeature(doc: CadDocument, id: string, feature: Feature) {
  const o = doc.objects[id];
  if (o?.kind === "solid") o.feature = feature;
}

/* ---------------------------------------------------------- feature tree edit */

/**
 * Replaces a nested feature node, addressed by a path of child indices.
 * `[]` is the root feature, `[0]` the first boolean operand, and so on. This is
 * what makes a union still editable after the fact.
 */
export function replaceFeatureAt(root: Feature, path: number[], next: Feature): Feature {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  const children = featureChildren(root);
  if (head < 0 || head >= children.length) return root;
  const updatedChild = replaceFeatureAt(children[head].feature, rest, next);
  return withFeatureChild(root, head, updatedChild);
}

export function featureAt(root: Feature, path: number[]): Feature | null {
  let current: Feature | null = root;
  for (const index of path) {
    if (!current) return null;
    const children = featureChildren(current);
    current = children[index]?.feature ?? null;
  }
  return current;
}

export function featureChildren(feature: Feature): SolidRecipe[] {
  switch (feature.type) {
    case "boolean":
      return feature.operands;
    case "hole":
    case "fillet":
    case "chamfer":
      return [feature.base];
    default:
      return [];
  }
}

function withFeatureChild(feature: Feature, index: number, child: Feature): Feature {
  switch (feature.type) {
    case "boolean": {
      const operands = feature.operands.map((op, i) => (i === index ? { ...op, feature: child } : op));
      return { ...feature, operands };
    }
    case "hole":
      return { ...feature, base: { ...feature.base, feature: child } };
    case "fillet":
    case "chamfer":
      return { ...feature, base: { ...feature.base, feature: child } };
    default:
      return feature;
  }
}

/* -------------------------------------------------------------- duplication */

export function duplicateObjects(doc: CadDocument, ids: string[], offset: Vec3 = [0, 0, 0]): string[] {
  const created: string[] = [];
  for (const id of ids) {
    const source = doc.objects[id];
    if (!source) continue;
    const copy = deepCopy(doc, source, source.parentId, offset);
    created.push(copy.id);
  }
  return created;
}

function deepCopy(doc: CadDocument, source: CadObject, parentId: string | null, offset: Vec3): CadObject {
  const clone = structuredClone(source) as CadObject;
  clone.id = makeId(source.kind === "solid" ? "sld" : source.kind === "mesh" ? "msh" : "grp");
  clone.parentId = parentId;
  clone.order = nextOrder(doc, parentId);
  clone.name = uniqueName(doc, stripCopySuffix(source.name) + " copy");
  clone.transform = {
    position: [
      source.transform.position[0] + offset[0],
      source.transform.position[1] + offset[1],
      source.transform.position[2] + offset[2],
    ],
    rotation: [...source.transform.rotation] as Vec3,
  };
  doc.objects[clone.id] = clone;
  for (const child of childrenOf(doc, source.id)) {
    deepCopy(doc, child, clone.id, [0, 0, 0]);
  }
  return clone;
}

function stripCopySuffix(name: string): string {
  return name.replace(/( copy)(\s\d+)?$/, "");
}

/* ------------------------------------------------------------------- groups */

/** Groups objects under a new group, preserving every world placement. */
export function groupObjects(doc: CadDocument, ids: string[], name = "Group"): GroupObject | null {
  const roots = topLevelOf(doc, ids);
  if (roots.length === 0) return null;
  const parentId = roots[0].parentId;
  const group = createGroup(uniqueName(doc, name), nextOrder(doc, parentId));
  group.parentId = parentId;
  doc.objects[group.id] = group;
  for (const o of roots) {
    reparent(doc, o.id, group.id);
  }
  return group;
}

export function ungroup(doc: CadDocument, groupId: string): string[] {
  const group = doc.objects[groupId];
  if (!group || group.kind !== "group") return [];
  const kids = childrenOf(doc, groupId);
  const movedIds: string[] = [];
  for (const child of kids) {
    reparent(doc, child.id, group.parentId);
    movedIds.push(child.id);
  }
  delete doc.objects[groupId];
  return movedIds;
}

/** Moves an object to a new parent while keeping its world placement fixed. */
export function reparent(doc: CadDocument, id: string, parentId: string | null) {
  const o = doc.objects[id];
  if (!o) return;
  if (parentId && (parentId === id || isAncestor(doc, id, parentId))) return;
  const world = worldTransform(doc, id);
  o.parentId = parentId;
  o.order = nextOrder(doc, parentId);
  o.transform = parentId ? relativeTransform(world, worldTransform(doc, parentId)) : world;
}

/** The subset of `ids` that has no selected ancestor (avoids double-moves). */
export function topLevelOf(doc: CadDocument, ids: string[]): CadObject[] {
  const set = new Set(ids);
  return ids
    .map((id) => doc.objects[id])
    .filter((o): o is CadObject => Boolean(o))
    .filter((o) => {
      let p = o.parentId;
      while (p) {
        if (set.has(p)) return false;
        p = doc.objects[p]?.parentId ?? null;
      }
      return true;
    });
}

/* --------------------------------------------------------- geometry features */

export function solidRecipeInWorld(doc: CadDocument, o: SolidObject): SolidRecipe {
  return { feature: o.feature, transform: worldTransform(doc, o.id) };
}

/**
 * Builds the boolean feature WITHOUT touching the document, so the kernel can be
 * asked "is this valid?" before any object is consumed. Returns null when there
 * are fewer than two solids selected.
 */
export function planBoolean(
  doc: CadDocument,
  op: BooleanOp,
  ids: string[],
  name?: string,
): { feature: Feature; name: string; parentId: string | null; color: string; sourceIds: string[] } | null {
  const solids = ids
    .map((id) => doc.objects[id])
    .filter((o): o is SolidObject => o?.kind === "solid");
  if (solids.length < 2) return null;

  const parentId = solids[0].parentId;
  const parentWorld = parentId ? worldTransform(doc, parentId) : null;
  const operands: SolidRecipe[] = solids.map((s) => ({
    feature: s.feature,
    transform: parentWorld
      ? relativeTransform(worldTransform(doc, s.id), parentWorld)
      : worldTransform(doc, s.id),
  }));

  const symbol = op === "union" ? "∪" : op === "cut" ? "−" : "∩";
  return {
    feature: { type: "boolean", op, operands },
    name: name ?? `${solids[0].name} ${symbol} ${solids[1].name}`,
    parentId,
    color: solids[0].color,
    sourceIds: solids.map((s) => s.id),
  };
}

/**
 * Boolean combine: consumes the operand objects and produces a single solid
 * whose feature keeps every operand (with baked world placement) as a child,
 * so the operation stays editable and undoable.
 */
export function booleanCombine(
  doc: CadDocument,
  op: BooleanOp,
  ids: string[],
  name?: string,
): SolidObject | null {
  const plan = planBoolean(doc, op, ids, name);
  if (!plan) return null;
  const result: SolidObject = {
    id: makeId("sld"),
    kind: "solid",
    name: uniqueName(doc, plan.name),
    parentId: plan.parentId,
    visible: true,
    color: plan.color,
    order: nextOrder(doc, plan.parentId),
    feature: plan.feature,
    transform: identityTransform(),
  };
  removeObjects(doc, plan.sourceIds);
  doc.objects[result.id] = result;
  return result;
}

/** Wraps a solid's feature in a hole feature (or appends to an existing one). */
export function addHoles(doc: CadDocument, id: string, holes: HoleSpec[]) {
  const o = doc.objects[id];
  if (o?.kind !== "solid" || holes.length === 0) return;
  if (o.feature.type === "hole") {
    o.feature = { ...o.feature, holes: [...o.feature.holes, ...holes] };
  } else {
    o.feature = { type: "hole", base: { feature: o.feature, transform: identityTransform() }, holes };
  }
}

export function applyEdgeTreatment(
  doc: CadDocument,
  id: string,
  kind: "fillet" | "chamfer",
  size: number,
) {
  const o = doc.objects[id];
  if (o?.kind !== "solid") return;
  const base: SolidRecipe = { feature: o.feature, transform: identityTransform() };
  o.feature = kind === "fillet"
    ? { type: "fillet", base, radius: size }
    : { type: "chamfer", base, distance: size };
}

/** Peels one feature layer off, undoing the most recent modifier. */
export function removeLastFeature(doc: CadDocument, id: string): boolean {
  const o = doc.objects[id];
  if (o?.kind !== "solid") return false;
  const f = o.feature;
  if (f.type === "fillet" || f.type === "chamfer" || f.type === "hole") {
    o.feature = f.base.feature;
    return true;
  }
  return false;
}

export function logOperation(doc: CadDocument, op: string, detail: string, objectIds: string[]) {
  doc.operationLog.push({ id: makeId("op"), at: Date.now(), op, detail, objectIds });
  if (doc.operationLog.length > 500) doc.operationLog.splice(0, doc.operationLog.length - 500);
}
