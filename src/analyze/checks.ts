import { AXIS_LABEL, observersOf, VIEWS, type ViewId } from "../views.ts";
import type { Silhouette } from "./silhouette.ts";
import type { AxisEstimate, Check, Issue, ViewSample } from "./types.ts";

type Samples = ReadonlyMap<ViewId, ViewSample>;

/** Mean relative deviation that drives an axis score to zero. */
const DIMENSION_TOLERANCE = 0.25;
/** Per-observation deviations above these flag the view. */
const DIMENSION_WARN = 0.1;
const DIMENSION_ERROR = 0.22;
/** Mirror IoU floor/ceiling; orthographic silhouettes of one solid are exact mirrors. */
const MIRROR_FLOOR = 0.45;
const MIRROR_TARGET = 0.9;
/** Mean pairwise foreground colour distance (0..1) that drives the colour score to zero. */
const COLOR_TOLERANCE = 0.18;

export function dimensionCheck(samples: Samples): { check: Check; axes: AxisEstimate[] } {
  const axes: AxisEstimate[] = [];
  const issues: Issue[] = [];

  for (const axis of ["x", "y", "z"] as const) {
    const observations: AxisEstimate["observations"][number][] = [];
    const values: number[] = [];
    for (const observer of observersOf(axis)) {
      const sample = samples.get(observer.view);
      if (!sample || sample.silhouette.area === 0) continue;
      const extent = sample.silhouette.extent[observer.on];
      values.push(extent);
      observations.push({ view: observer.view, on: observer.on, extent, relativeError: 0 });
    }
    if (values.length === 0) {
      axes.push({ axis, extent: 0, deviation: 1, observations: [] });
      continue;
    }

    const center = median(values);
    let devSum = 0;
    const scored = observations.map((o) => {
      const relativeError = center > 0 ? Math.abs(o.extent - center) / center : 0;
      devSum += relativeError;
      return { ...o, relativeError };
    });
    const deviation = devSum / scored.length;
    axes.push({ axis, extent: center, deviation, observations: scored });

    for (const o of scored) {
      if (o.relativeError < DIMENSION_WARN) continue;
      issues.push({
        severity: o.relativeError >= DIMENSION_ERROR ? "error" : "warn",
        views: [o.view],
        message: `${VIEWS[o.view].label} 뷰의 ${o.on === "width" ? "가로" : "세로"} 길이가 ${AXIS_LABEL[axis]} 기준값과 ${(o.relativeError * 100).toFixed(1)}% 어긋납니다 (${o.extent.toFixed(3)} vs ${center.toFixed(3)}).`,
      });
    }
  }

  // Worst axis gates the score: reconstruction needs all three extents, so a
  // perfect X and Y cannot compensate for a Z that four views disagree about.
  const perAxis = axes.map((a) => clamp01(1 - a.deviation / DIMENSION_TOLERANCE));
  const score = perAxis.length > 0 ? Math.min(...perAxis) : 0;
  const detail = axes
    .map((a) => `${AXIS_LABEL[a.axis]} ${a.extent.toFixed(3)} (편차 ${(a.deviation * 100).toFixed(1)}%)`)
    .join(" · ");

  return {
    check: { id: "dimension", label: "축 치수 일관성", score, weight: 0.35, critical: true, detail, issues },
    axes,
  };
}

/**
 * Orthographic projections along opposite directions produce the same silhouette,
 * mirrored. Low IoU means the two views disagree about the object's shape, which
 * is the single strongest signal that a generated view set is unusable.
 */
export function mirrorCheck(samples: Samples): Check {
  const pairs: Array<[ViewId, ViewId]> = [
    ["front", "back"],
    ["left", "right"],
    ["top", "bottom"],
  ];
  const issues: Issue[] = [];
  const scores: number[] = [];
  const parts: string[] = [];

  for (const [a, b] of pairs) {
    const sa = samples.get(a);
    const sb = samples.get(b);
    if (!sa || !sb || sa.silhouette.area === 0 || sb.silhouette.area === 0) continue;
    const axis = VIEWS[a].mirror.axis;
    const iou = mirroredIoU(sa.silhouette, sb.silhouette, axis);
    scores.push(clamp01((iou - MIRROR_FLOOR) / (MIRROR_TARGET - MIRROR_FLOOR)));
    parts.push(`${VIEWS[a].label}↔${VIEWS[b].label} IoU ${iou.toFixed(3)}`);

    if (iou < MIRROR_TARGET) {
      issues.push({
        severity: iou < 0.7 ? "error" : "warn",
        views: [a, b],
        message: `${VIEWS[a].label}/${VIEWS[b].label} 실루엣이 거울상으로 일치하지 않습니다 (IoU ${iou.toFixed(3)}). 두 뷰가 서로 다른 형상을 그렸을 가능성이 큽니다.`,
      });
    }
  }

  // One disagreeing pair is enough to make the set unusable, so the worst pair
  // sets the score rather than being averaged away by two good ones.
  const score = scores.length > 0 ? Math.min(...scores) : 0;
  return {
    id: "mirror",
    label: "대면 실루엣 정합",
    score,
    weight: 0.3,
    critical: true,
    detail: parts.join(" · "),
    issues,
  };
}

export function colorCheck(samples: Samples): Check {
  const list = [...samples.values()].filter((s) => s.silhouette.area > 0);
  if (list.length < 2) {
    return {
      id: "color",
      label: "색상 일관성",
      score: 0,
      weight: 0.15,
      critical: false,
      detail: "비교 가능한 뷰 부족",
      issues: [],
    };
  }

  let pairCount = 0;
  let colorSum = 0;
  let worst = { a: list[0]!.id, b: list[0]!.id, distance: 0 };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const x = list[i]!;
      const y = list[j]!;
      const rgb = rgbDistance(x.silhouette.meanColor, y.silhouette.meanColor);
      const hue = histogramDistance(x.silhouette.hueHistogram, y.silhouette.hueHistogram);
      const distance = 0.6 * rgb + 0.4 * hue;
      colorSum += distance;
      pairCount++;
      if (distance > worst.distance) worst = { a: x.id, b: y.id, distance };
    }
  }

  const mean = colorSum / pairCount;
  const issues: Issue[] = [];
  if (worst.distance > COLOR_TOLERANCE) {
    issues.push({
      // Advisory only: a legitimately multi-coloured object (a painted box, a
      // two-tone product shot) differs per face without being wrong.
      severity: "warn",
      views: [worst.a, worst.b],
      message: `${VIEWS[worst.a].label}과 ${VIEWS[worst.b].label}의 재질/색상이 크게 다릅니다 (거리 ${worst.distance.toFixed(3)}). 텍스처 베이킹 시 이음새가 생깁니다.`,
    });
  }

  return {
    id: "color",
    label: "색상 일관성",
    score: clamp01(1 - mean / COLOR_TOLERANCE),
    weight: 0.15,
    critical: false,
    detail: `평균 색차 ${mean.toFixed(3)} · 최대 ${worst.distance.toFixed(3)} (${VIEWS[worst.a].label}/${VIEWS[worst.b].label})`,
    issues,
  };
}

export function integrityCheck(samples: Samples, missing: readonly ViewId[]): Check {
  const issues: Issue[] = [];
  const penalties: number[] = [];

  for (const view of missing) {
    issues.push({ severity: "error", views: [view], message: `${VIEWS[view].label} 뷰가 없습니다.` });
    penalties.push(0);
  }

  for (const sample of samples.values()) {
    const s = sample.silhouette;
    const label = VIEWS[sample.id].label;
    let penalty = 1;

    if (s.area === 0) {
      issues.push({ severity: "error", views: [sample.id], message: `${label} 뷰에서 피사체를 찾지 못했습니다 (배경만 존재).` });
      penalties.push(0);
      continue;
    }
    if (s.largestBlob < 0.9) {
      issues.push({
        severity: s.largestBlob < 0.7 ? "error" : "warn",
        views: [sample.id],
        message: `${label} 뷰 실루엣이 ${s.blobs}조각으로 끊겼습니다 (최대 덩어리 ${(s.largestBlob * 100).toFixed(1)}%).`,
      });
      penalty = Math.min(penalty, s.largestBlob);
    }
    const perimeter = 2 * (s.width + s.height);
    if (s.borderPixels > perimeter * 0.02) {
      issues.push({
        severity: "warn",
        views: [sample.id],
        message: `${label} 뷰에서 피사체가 프레임 밖으로 잘렸습니다 (경계 접촉 ${s.borderPixels}px).`,
      });
      penalty = Math.min(penalty, 0.6);
    }
    const off = Math.hypot(s.center.x - 0.5, s.center.y - 0.5);
    if (off > 0.08) {
      issues.push({
        severity: "warn",
        views: [sample.id],
        message: `${label} 뷰 중심이 프레임 중앙에서 ${(off * 100).toFixed(1)}% 벗어났습니다. 정렬 없이 보셀 카빙하면 형상이 깎입니다.`,
      });
      penalty = Math.min(penalty, 0.75);
    }
    if (s.extent.width < 0.2 && s.extent.height < 0.2) {
      issues.push({ severity: "warn", views: [sample.id], message: `${label} 뷰의 피사체가 너무 작습니다 (프레임의 ${(Math.max(s.extent.width, s.extent.height) * 100).toFixed(0)}%).` });
      penalty = Math.min(penalty, 0.7);
    }
    penalties.push(penalty);
  }

  const score = penalties.length > 0 ? penalties.reduce((a, b) => a + b, 0) / penalties.length : 0;
  const keyed = [...samples.values()].filter((s) => s.silhouette.source === "background-key").length;
  return {
    id: "integrity",
    label: "뷰 무결성",
    score,
    weight: 0.2,
    critical: true,
    detail: `유효 뷰 ${samples.size}/6 · 알파 마스크 ${samples.size - keyed} · 배경 키잉 ${keyed}`,
    issues,
  };
}

function mirroredIoU(a: Silhouette, b: Silhouette, axis: "horizontal" | "vertical"): number {
  if (!a.bbox || !b.bbox) return 0;
  const width = a.width;
  const height = a.height;

  // Mirror b, then align bbox centres with a so that pure framing offsets are
  // judged by the integrity check instead of being charged to shape agreement.
  const bw = b.bbox.x1 - b.bbox.x0;
  const bh = b.bbox.y1 - b.bbox.y0;
  const mirroredX0 = axis === "horizontal" ? b.width - b.bbox.x1 : b.bbox.x0;
  const mirroredY0 = axis === "vertical" ? b.height - b.bbox.y1 : b.bbox.y0;
  const dx = Math.round(a.bbox.x0 + (a.bbox.x1 - a.bbox.x0) / 2 - (mirroredX0 + bw / 2));
  const dy = Math.round(a.bbox.y0 + (a.bbox.y1 - a.bbox.y0) / 2 - (mirroredY0 + bh / 2));

  let intersection = 0;
  let union = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inA = a.mask[y * width + x] === 1;
      const sx = axis === "horizontal" ? b.width - 1 - (x - dx) : x - dx;
      const sy = axis === "vertical" ? b.height - 1 - (y - dy) : y - dy;
      const inB =
        sx >= 0 && sx < b.width && sy >= 0 && sy < b.height && b.mask[sy * b.width + sx] === 1;
      if (inA && inB) intersection++;
      if (inA || inB) union++;
    }
  }
  return union === 0 ? 0 : intersection / union;
}

function rgbDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) / (255 * Math.sqrt(3));
}

/** Half the L1 distance between two normalised histograms: 0 = identical, 1 = disjoint. */
function histogramDistance(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / 2;
}

function median(values: number[]): number {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
