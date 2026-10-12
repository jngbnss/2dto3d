/**
 * Canonical six-view geometry.
 *
 * Object frame (right-handed):
 *   +X -> object's right,  +Y -> object's up,  +Z -> toward the front camera.
 *
 * Every view is an orthographic projection, so each image axis measures exactly
 * one object axis. That mapping is what makes cross-view analysis possible:
 * four independent views measure each object extent, and they must agree.
 */

export const VIEW_IDS = ["front", "back", "left", "right", "top", "bottom"] as const;

export type ViewId = (typeof VIEW_IDS)[number];

/** Object extent measured by an image axis. */
export type Axis = "x" | "y" | "z";

export interface ViewSpec {
  readonly id: ViewId;
  /** Korean label used by the CLI/web surface. */
  readonly label: string;
  /** Camera azimuth in degrees around +Y, 0 = front, counter-clockwise. */
  readonly azimuth: number;
  /** Camera elevation in degrees, +90 = directly above. */
  readonly elevation: number;
  /** Object axis measured by the image's horizontal extent. */
  readonly widthAxis: Axis;
  /** Object axis measured by the image's vertical extent. */
  readonly heightAxis: Axis;
  /** View that should be this view's mirror image, and the mirror direction. */
  readonly mirror: { readonly of: ViewId; readonly axis: "horizontal" | "vertical" };
}

export const VIEWS: { readonly [K in ViewId]: ViewSpec } = {
  front: {
    id: "front",
    label: "정면",
    azimuth: 0,
    elevation: 0,
    widthAxis: "x",
    heightAxis: "y",
    mirror: { of: "back", axis: "horizontal" },
  },
  back: {
    id: "back",
    label: "배면",
    azimuth: 180,
    elevation: 0,
    widthAxis: "x",
    heightAxis: "y",
    mirror: { of: "front", axis: "horizontal" },
  },
  left: {
    id: "left",
    label: "좌측",
    azimuth: 270,
    elevation: 0,
    widthAxis: "z",
    heightAxis: "y",
    mirror: { of: "right", axis: "horizontal" },
  },
  right: {
    id: "right",
    label: "우측",
    azimuth: 90,
    elevation: 0,
    widthAxis: "z",
    heightAxis: "y",
    mirror: { of: "left", axis: "horizontal" },
  },
  top: {
    id: "top",
    label: "평면",
    azimuth: 0,
    elevation: 90,
    widthAxis: "x",
    heightAxis: "z",
    mirror: { of: "bottom", axis: "vertical" },
  },
  bottom: {
    id: "bottom",
    label: "저면",
    azimuth: 0,
    elevation: -90,
    widthAxis: "x",
    heightAxis: "z",
    mirror: { of: "top", axis: "vertical" },
  },
};

export const AXIS_LABEL: { readonly [K in Axis]: string } = {
  x: "폭(X)",
  y: "높이(Y)",
  z: "깊이(Z)",
};

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
