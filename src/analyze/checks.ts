import { VIEW_IDS, VIEWS, type ViewId } from "../views.ts";
import type { Silhouette } from "./silhouette.ts";
import type { Check, Issue, ViewSample } from "./types.ts";

type Samples = ReadonlyMap<ViewId, ViewSample>;

/** Mirror IoU floor/ceiling; orthographic silhouettes of one solid are exact mirrors. */
const MIRROR_FLOOR = 0.45;
const MIRROR_TARGET = 0.9;

/**
 * Orthographic projections along opposite directions produce the same silhouette,
 * mirrored. Low IoU means the two views disagree about the object's shape, which
 * is the single strongest signal that a generated view set is unusable.
 */
export function mirrorCheck(samples: Samples): Check {
  const pairs = VIEW_IDS.flatMap((id): Array<[ViewId, ViewId]> => {
    const mirror = VIEWS[id].mirror;
    return mirror && VIEW_IDS.indexOf(id) < VIEW_IDS.indexOf(mirror) ? [[id, mirror]] : [];
  });
  const issues: Issue[] = [];
  const scores: number[] = [];
  const parts: string[] = [];

  for (const [a, b] of pairs) {
    const sa = samples.get(a);
    const sb = samples.get(b);
    if (!sa || !sb || sa.silhouette.area === 0 || sb.silhouette.area === 0) continue;
    const iou = mirroredIoU(sa.silhouette, sb.silhouette);
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
    detail: `유효 뷰 ${samples.size}/${VIEW_IDS.length} · 알파 마스크 ${samples.size - keyed} · 배경 키잉 ${keyed}`,
    issues,
  };
}

/** IoU of `a` against `b` mirrored left-right; every opposing view pair is a horizontal mirror. */
function mirroredIoU(a: Silhouette, b: Silhouette): number {
  if (!a.bbox || !b.bbox) return 0;
  const width = a.width;
  const height = a.height;

  // Mirror b, then align bbox centres with a so that pure framing offsets are
  // judged by the integrity check instead of being charged to shape agreement.
  const bw = b.bbox.x1 - b.bbox.x0;
  const mirroredX0 = b.width - b.bbox.x1;
  const dx = Math.round(a.bbox.x0 + (a.bbox.x1 - a.bbox.x0) / 2 - (mirroredX0 + bw / 2));
  const dy = Math.round(a.bbox.y0 + (a.bbox.y1 - a.bbox.y0) / 2 - (b.bbox.y0 + (b.bbox.y1 - b.bbox.y0) / 2));

  let intersection = 0;
  let union = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inA = a.mask[y * width + x] === 1;
      const sx = b.width - 1 - (x - dx);
      const sy = y - dy;
      const inB =
        sx >= 0 && sx < b.width && sy >= 0 && sy < b.height && b.mask[sy * b.width + sx] === 1;
      if (inA && inB) intersection++;
      if (inA || inB) union++;
    }
  }
  return union === 0 ? 0 : intersection / union;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
