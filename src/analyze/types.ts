import type { Axis, ViewId } from "../views.ts";
import type { Silhouette } from "./silhouette.ts";

export type Severity = "error" | "warn" | "info";

export interface Issue {
  readonly severity: Severity;
  /** Views the issue points at; empty when it concerns the whole set. */
  readonly views: readonly ViewId[];
  readonly message: string;
}

export interface Check {
  readonly id: string;
  readonly label: string;
  /** 0 = unusable, 1 = perfect. */
  readonly score: number;
  /** Contribution to the overall score. */
  readonly weight: number;
  /**
   * Critical checks measure geometry reconstruction depends on; a dead one fails
   * the whole set. Advisory checks (colour) only ever lower the score.
   */
  readonly critical: boolean;
  readonly detail: string;
  readonly issues: readonly Issue[];
}

export interface ViewSample {
  readonly id: ViewId;
  readonly path: string;
  readonly silhouette: Silhouette;
}

export interface AxisEstimate {
  readonly axis: Axis;
  /** Median extent across the four observing measurements, 0..1 of frame. */
  readonly extent: number;
  /** Mean relative deviation from the median, 0..1. */
  readonly deviation: number;
  readonly observations: ReadonlyArray<{
    readonly view: ViewId;
    readonly on: "width" | "height";
    readonly extent: number;
    readonly relativeError: number;
  }>;
}

export interface SixViewReport {
  readonly score: number;
  readonly verdict: "pass" | "review" | "fail";
  readonly checks: readonly Check[];
  readonly issues: readonly Issue[];
  readonly axes: readonly AxisEstimate[];
  /** Object proportions X:Y:Z, largest axis normalised to 1. */
  readonly proportions: { readonly x: number; readonly y: number; readonly z: number };
  readonly views: ReadonlyArray<{
    readonly id: ViewId;
    readonly path: string;
    readonly maskSource: Silhouette["source"];
    readonly extent: Silhouette["extent"];
    readonly center: Silhouette["center"];
    readonly fill: number;
    readonly largestBlob: number;
    readonly blobs: number;
    readonly meanColor: Silhouette["meanColor"];
  }>;
  readonly missing: readonly ViewId[];
}
