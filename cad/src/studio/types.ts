/** Mirrors the sixview server HTTP contract (`GET /api/state` and mutation responses). */

export type ViewId = "front" | "back" | "left" | "right" | "top";

export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ViewTransform {
  /** Clockwise degrees applied to the raw image. */
  rotation: 0 | 90 | 180 | 270;
  /** Horizontal mirror, applied after rotation. */
  flip: boolean;
  /** User multiplier on top of automatic scale, 0.5..2. */
  scale: number;
  /** Fractions of canvas, -0.25..0.25 (+x right, +y down). */
  offsetX: number;
  offsetY: number;
  /** Fractions 0..0.45 trimmed from the oriented image. */
  crop: Crop;
}

export interface ViewAxes {
  up: string;
  right: string;
  camera: string;
}

export interface ViewState {
  id: ViewId;
  label: string;
  required: boolean;
  axes: ViewAxes;
  hasImage: boolean;
  rawUrl: string | null;
  preparedUrl: string | null;
  outlineUrl: string | null;
  transform: ViewTransform;
  source: { width: number; height: number } | null;
  /** Fractions 0..1 of the prepared canvas. */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

export type Verdict = "pass" | "review" | "fail";

export interface ValidationCheck {
  id: string;
  label: string;
  score: number;
  detail: string;
}

export interface ValidationIssue {
  severity: "error" | "warn" | "info";
  views: string[];
  message: string;
}

export interface Validation {
  score: number;
  verdict: Verdict;
  checks: ValidationCheck[];
  issues: ValidationIssue[];
}

export interface Comparison {
  id: string;
  originalUrl: string;
  renderUrl: string;
  /** Result rendered grey with colour-conflict vertices in red. */
  conflictUrl: string;
  iou: number;
  /** 0..1 share of this view's jointly seen surface whose colour agrees with the other views. */
  colour: number;
}

export interface GenerateResult {
  glbUrl: string;
  objUrl: string;
  voxelUrl: string;
  triangles: number;
  resolution: number;
  /** 0..1 mean reprojection IoU. */
  score: number;
  /** 0..1 photo-consistency: do the views agree on the surface's colour? */
  colourScore: number;
  comparisons: Comparison[];
}

export interface State {
  directory: string;
  views: ViewState[];
  validation: Validation;
  canGenerate: boolean;
  blockers: string[];
  result: GenerateResult | null;
}

export type Resolution = 96 | 128 | 160 | 192 | 256;

export interface GenerateOptions {
  resolution?: Resolution;
  symmetry?: boolean;
  smoothing?: number;
  /** Rounded cross-section prior, 0 (plain hull) .. 1 (elliptical slices). */
  rounding?: number;
}
