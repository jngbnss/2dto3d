import { AXIS_LABEL, VIEWS, type Axis, type ViewId } from "./views.ts";

/**
 * Cross-view scale registration.
 *
 * Every image measures two world extents (front: X and Y, left: Z and Y, top: X
 * and Z, …) but each image may be framed at its own zoom — reference sheets and
 * renderers routinely fit every view to the canvas. Each view therefore gets one
 * unknown scale `s` (world units per image pixel), each axis one unknown length
 * `L`, and every measurement says `pixels * s = L`. In log space that is linear
 * least squares; alternating geometric means converges in a few rounds.
 *
 * One free scale per view absorbs framing, so what remains in the residuals is
 * genuine disagreement — a view whose aspect ratio cannot match the others,
 * most often because it is rotated by 90°.
 */

export interface ViewExtent {
  /** Silhouette bounding box of the oriented image, in pixels. */
  readonly width: number;
  readonly height: number;
}

export interface Observation {
  readonly view: ViewId;
  readonly axis: Axis;
  readonly on: "width" | "height";
  /** World length this view implies divided by the consensus length; 1 = perfect. */
  readonly ratio: number;
}

export interface Alignment {
  /** World units per oriented-image pixel, per view. */
  readonly scale: Readonly<Partial<Record<ViewId, number>>>;
  /** Consensus object extents in world units; the longest axis is 1. */
  readonly extent: Readonly<Record<Axis, number>>;
  /** Number of measurements behind each axis. */
  readonly observed: Readonly<Record<Axis, number>>;
  readonly observations: readonly Observation[];
  /** Views whose measurements fit far better with width and height swapped. */
  readonly rotationSuspects: readonly ViewId[];
}

const ROUNDS = 40;
/** Mean |log ratio| a view must exceed before a 90° swap is even considered. */
const SUSPECT_FLOOR = 0.12;

export function solveAlignment(extents: ReadonlyMap<ViewId, ViewExtent>): Alignment {
  const solved = solve(extents);
  const rotationSuspects: ViewId[] = [];
  for (const [view, extent] of extents) {
    const own = viewCost(solved.observations, view);
    if (own < SUSPECT_FLOOR) continue;
    const swapped = new Map(extents);
    swapped.set(view, { width: extent.height, height: extent.width });
    if (viewCost(solve(swapped).observations, view) < own * 0.35) rotationSuspects.push(view);
  }
  return { ...solved, rotationSuspects };
}

function solve(extents: ReadonlyMap<ViewId, ViewExtent>): Omit<Alignment, "rotationSuspects"> {
  const measurements: Array<{ view: ViewId; axis: Axis; on: "width" | "height"; log: number }> = [];
  for (const [view, extent] of extents) {
    const spec = VIEWS[view];
    if (extent.width > 0) measurements.push({ view, axis: spec.widthAxis, on: "width", log: Math.log(extent.width) });
    if (extent.height > 0) measurements.push({ view, axis: spec.heightAxis, on: "height", log: Math.log(extent.height) });
  }

  const logScale = new Map<ViewId, number>([...extents.keys()].map((view) => [view, 0]));
  const logLength: Record<Axis, number> = { x: 0, y: 0, z: 0 };
  const observed: Record<Axis, number> = { x: 0, y: 0, z: 0 };
  for (const m of measurements) observed[m.axis]++;

  for (let round = 0; round < ROUNDS; round++) {
    for (const axis of ["x", "y", "z"] as const) {
      const on = measurements.filter((m) => m.axis === axis);
      if (on.length > 0) logLength[axis] = mean(on.map((m) => m.log + (logScale.get(m.view) ?? 0)));
    }
    for (const view of logScale.keys()) {
      const on = measurements.filter((m) => m.view === view);
      if (on.length > 0) logScale.set(view, mean(on.map((m) => logLength[m.axis] - m.log)));
    }
  }

  // Gauge: the longest observed axis is 1 world unit.
  const axes = (["x", "y", "z"] as const).filter((axis) => observed[axis] > 0);
  const gauge = axes.length > 0 ? Math.max(...axes.map((axis) => logLength[axis])) : 0;
  const extent: Record<Axis, number> = { x: 0, y: 0, z: 0 };
  for (const axis of axes) extent[axis] = Math.exp(logLength[axis] - gauge);

  const scale: Partial<Record<ViewId, number>> = {};
  for (const [view, value] of logScale) scale[view] = Math.exp(value - gauge);

  const observations = measurements.map((m) => ({
    view: m.view,
    axis: m.axis,
    on: m.on,
    ratio: Math.exp(m.log + (logScale.get(m.view) ?? 0) - logLength[m.axis]),
  }));
  return { scale, extent, observed, observations };
}

function viewCost(observations: readonly Observation[], view: ViewId): number {
  const own = observations.filter((o) => o.view === view);
  return own.length > 0 ? mean(own.map((o) => Math.abs(Math.log(o.ratio)))) : 0;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

export function describeObservation(o: Observation): string {
  return `${VIEWS[o.view].label} 뷰의 ${o.on === "width" ? "가로" : "세로"}가 ${AXIS_LABEL[o.axis]} 기준과 ${(Math.abs(o.ratio - 1) * 100).toFixed(1)}% 어긋납니다`;
}
