/**
 * View configuration: the one fixed world frame and the five input views.
 *
 * World frame (right-handed, fixed project-wide):
 *   +X = object's right   -X = object's left
 *   +Y = up               -Y = down
 *   +Z = object's front   -Z = object's back
 *
 * Each view is an orthographic image taken from outside the object, looking at
 * the origin. What the image's up and right edges mean in the world is fixed per
 * view (`render/basis.ts` holds the vectors; `axisName` prints them):
 *
 *   view   camera at   image up   image right
 *   front  +Z          +Y         +X
 *   back   -Z          +Y         -X
 *   left   -X          +Y         +Z
 *   right  +X          +Y         -Z
 *   top    +Y          -Z         +X      (front of the object at the image bottom)
 *
 * Adding a view (e.g. bottom: camera at -Y, up +Z, right +X) means one entry in
 * `VIEW_IDS`, `VIEWS`, and `BASES`; analysis, alignment, carving, rendering, and
 * the web surface iterate these tables and need no other change.
 */

import { BASES } from "./render/basis.ts";

export const VIEW_IDS = ["front", "back", "left", "right", "top"] as const;

export type ViewId = (typeof VIEW_IDS)[number];

/** Object extent measured by an image axis. */
export type Axis = "x" | "y" | "z";

export interface ViewSpec {
  readonly id: ViewId;
  /** Label shown by the CLI/web surface. */
  readonly label: string;
  /** Reconstruction refuses to run without this view. */
  readonly required: boolean;
  /** Object axis measured by the image's horizontal extent. */
  readonly widthAxis: Axis;
  /** Object axis measured by the image's vertical extent. */
  readonly heightAxis: Axis;
  /** View whose silhouette is this one mirrored left-right, when that view exists. */
  readonly mirror?: ViewId;
}

export const VIEWS: { readonly [K in ViewId]: ViewSpec } = {
  front: { id: "front", label: "front", required: true, widthAxis: "x", heightAxis: "y", mirror: "back" },
  back: { id: "back", label: "back", required: true, widthAxis: "x", heightAxis: "y", mirror: "front" },
  left: { id: "left", label: "left", required: true, widthAxis: "z", heightAxis: "y", mirror: "right" },
  right: { id: "right", label: "right", required: true, widthAxis: "z", heightAxis: "y", mirror: "left" },
  top: { id: "top", label: "top", required: true, widthAxis: "x", heightAxis: "z" },
};

export const AXIS_LABEL: { readonly [K in Axis]: string } = {
  x: "폭(X)",
  y: "높이(Y)",
  z: "깊이(Z)",
};

/** Signed axis name of a unit basis vector, e.g. `[0, 0, -1]` -> `"-Z"`. */
export function axisName(vector: readonly [number, number, number]): string {
  const index = vector.findIndex((component) => component !== 0);
  return `${(vector[index] ?? 0) > 0 ? "+" : "-"}${"XYZ"[index] ?? "?"}`;
}

/** World direction of each image edge, for orientation markers. */
export function imageAxes(id: ViewId): { readonly up: string; readonly right: string; readonly camera: string } {
  const basis = BASES[id];
  return {
    up: axisName(basis.up),
    right: axisName(basis.right),
    camera: axisName([-basis.forward[0], -basis.forward[1], -basis.forward[2]]),
  };
}

/** Image measurements that observe a given object axis, as (view, image-axis) pairs. */
export function observersOf(axis: Axis): ReadonlyArray<{ view: ViewId; on: "width" | "height" }> {
  const out: Array<{ view: ViewId; on: "width" | "height" }> = [];
  for (const id of VIEW_IDS) {
    const spec = VIEWS[id];
    if (spec.widthAxis === axis) out.push({ view: id, on: "width" });
    if (spec.heightAxis === axis) out.push({ view: id, on: "height" });
  }
  return out;
}

export function isViewId(value: string): value is ViewId {
  return (VIEW_IDS as readonly string[]).includes(value);
}
