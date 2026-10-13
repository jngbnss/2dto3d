import { AXIS_LABEL, VIEW_IDS, VIEWS, type Axis, type ViewId } from "./views.ts";
import { BASES } from "./render/basis.ts";
import { renderViews } from "./render/ortho.ts";
import { describeObservation } from "./alignment.ts";
import { MIN_SOURCE_SIZE, type PreparedSet } from "./preprocess.ts";
import { buildHullField } from "./reconstruct/voxel-reconstruct.ts";
import { extractSurface } from "./reconstruct/mesh-extract.ts";
import { integrityCheck, mirrorCheck } from "./analyze/checks.ts";
import type { Silhouette } from "./analyze/silhouette.ts";
import type { AxisEstimate, Check, Issue, ViewSetReport } from "./analyze/types.ts";

/**
 * Alignment validation: before anything is carved, prove the views describe one
 * object in one frame. Every check reads the prepared views (oriented, aligned)
 * so a fix the user makes in the UI shows up here immediately.
 *
 * - scale   — after one free zoom per view, do the shared extents agree?
 *             (catches 90° rotations, wrong view in a slot, distorted art)
 * - center  — along every shared axis, does each view occupy the same span?
 *             (catches offsets and crops)
 * - symmetry— opposite views (front/back, left/right) must be mirror images
 * - agreement — carve a coarse hull and re-project it: how much of each
 *             silhouette survives the other views? This is the end-to-end test.
 * - input   — masks, missing / cut-off / tiny uploads
 */

const PASS = 0.8;
const REVIEW = 0.55;
const CHECK_FLOOR = 0.5;
/** Hull resolution used only for the agreement check. */
const AGREEMENT_RESOLUTION = 64;
/** 1D occupancy bins across one world unit, for the centre check. */
const PROFILE_BINS_PER_UNIT = 256;
/** Largest shift searched when lining profiles up, in world units. */
const PROFILE_SEARCH = 0.08;

export function validate(set: PreparedSet): ViewSetReport {
  const samples = new Map([...set.views].map(([id, view]) => [id, view] as const));
  const scale = scaleCheck(set);
  const checks: Check[] = [
    scale.check,
    agreementCheck(set),
    centerCheck(set),
    { ...mirrorCheck(samples), label: "실루엣 대칭", weight: 0.1, critical: false },
    inputCheck(set),
  ];

  const weight = checks.reduce((sum, c) => sum + c.weight, 0);
  const score = checks.reduce((sum, c) => sum + c.score * c.weight, 0) / Math.max(weight, Number.EPSILON);
  const issues = checks
    .flatMap((c) => c.issues)
    .sort((a, b) => rank(b.severity) - rank(a.severity));
  const missingRequired = set.missing.filter((id) => VIEWS[id].required);
  const dead = checks.some((c) => c.critical && c.score < CHECK_FLOOR);
  const verdict: ViewSetReport["verdict"] =
    score < REVIEW || dead || missingRequired.length > 0
      ? "fail"
      : score < PASS || issues.some((i) => i.severity === "error")
        ? "review"
        : "pass";

  const extent = set.alignment.extent;
  const largest = Math.max(extent.x, extent.y, extent.z, Number.EPSILON);
  return {
    score,
    verdict,
    checks,
    issues,
    axes: scale.axes,
    proportions: { x: extent.x / largest, y: extent.y / largest, z: extent.z / largest },
    views: [...set.views.values()].map((view) => ({
      id: view.id,
      path: view.path,
      maskSource: view.hadAlpha ? "alpha" : "background-key",
      extent: view.silhouette.extent,
      center: view.silhouette.center,
      fill: view.silhouette.fill,
      largestBlob: view.silhouette.largestBlob,
      blobs: view.silhouette.blobs,
      meanColor: view.silhouette.meanColor,
    })),
    missing: set.missing,
  };
}

function scaleCheck(set: PreparedSet): { check: Check; axes: AxisEstimate[] } {
  const { alignment } = set;
  const issues: Issue[] = [];
  for (const view of alignment.rotationSuspects) {
    issues.push({
      severity: "error",
      views: [view],
      message: `${VIEWS[view].label} 뷰가 90° 돌아가 있을 가능성이 큽니다. 가로·세로를 바꾸면 다른 뷰와 치수가 맞습니다 — 회전 버튼으로 맞추세요.`,
    });
  }
  for (const o of alignment.observations) {
    const error = Math.abs(o.ratio - 1);
    if (error < 0.08 || alignment.rotationSuspects.includes(o.view)) continue;
    issues.push({ severity: error >= 0.2 ? "error" : "warn", views: [o.view], message: `${describeObservation(o)}.` });
  }
  for (const [a, b] of [["front", "back"], ["left", "right"]] as const) {
    const pa = aspect(set, a);
    const pb = aspect(set, b);
    if (pa === null || pb === null) continue;
    const difference = Math.abs(pa / pb - 1);
    if (difference < 0.06) continue;
    issues.push({
      severity: difference >= 0.15 ? "error" : "warn",
      views: [a, b],
      message: `${a}/${b}의 가로세로 비율이 ${(difference * 100).toFixed(1)}% 다릅니다. 같은 물체의 반대편이면 같아야 합니다.`,
    });
  }

  const deviation = mean(alignment.observations.map((o) => Math.abs(Math.log(o.ratio))));
  const axes: AxisEstimate[] = (["x", "y", "z"] as const).map((axis) => {
    const on = alignment.observations.filter((o) => o.axis === axis);
    return {
      axis,
      extent: alignment.extent[axis],
      deviation: mean(on.map((o) => Math.abs(o.ratio - 1))),
      observations: on.map((o) => ({ view: o.view, on: o.on, extent: o.ratio * alignment.extent[axis], relativeError: Math.abs(o.ratio - 1) })),
    };
  });
  const penalty = alignment.rotationSuspects.length > 0 ? 0.4 : 1;
  return {
    check: {
      id: "scale",
      label: "축 비율 일관성",
      score: clamp01(1 - deviation / 0.2) * penalty,
      weight: 0.3,
      critical: true,
      detail: axes.map((a) => `${AXIS_LABEL[a.axis]} ${a.extent.toFixed(3)} (편차 ${(a.deviation * 100).toFixed(1)}%)`).join(" · "),
      issues,
    },
    axes,
  };
}

function aspect(set: PreparedSet, id: ViewId): number | null {
  const box = set.views.get(id)?.silhouette.bbox;
  return box ? (box.x1 - box.x0) / Math.max(1, box.y1 - box.y0) : null;
}

/**
 * The projection of a solid onto one world axis is the same from every view
 * that sees that axis. Each view's occupied span along the axis is compared to
 * the first observer's; the shift that best lines them up is the misalignment.
 */
function centerCheck(set: PreparedSet): Check {
  const issues: Issue[] = [];
  const parts: string[] = [];
  let worst = 0;
  for (const axis of ["x", "y", "z"] as const) {
    const profiles = [...set.views.values()].flatMap((view) => {
      const profile = occupancy(view.silhouette, view.id, axis, set.pixelsPerUnit);
      return profile ? [{ id: view.id, profile }] : [];
    });
    const reference = profiles[0];
    if (!reference) continue;
    let axisWorst = 0;
    for (const { id, profile } of profiles.slice(1)) {
      const shift = bestShift(reference.profile, profile) / PROFILE_BINS_PER_UNIT;
      axisWorst = Math.max(axisWorst, Math.abs(shift));
      if (Math.abs(shift) < 0.012) continue;
      issues.push({
        severity: Math.abs(shift) >= 0.04 ? "error" : "warn",
        views: [id, reference.id],
        message: `${VIEWS[id].label} 뷰가 ${VIEWS[reference.id].label} 대비 ${axis.toUpperCase()}축으로 ${(shift * 100).toFixed(1)}% 어긋나 있습니다. offset을 보정하세요.`,
      });
    }
    worst = Math.max(worst, axisWorst);
    parts.push(`${axis.toUpperCase()} ${(axisWorst * 100).toFixed(1)}%`);
  }
  return {
    id: "center",
    label: "중심 정렬",
    score: clamp01(1 - worst / 0.05),
    weight: 0.15,
    critical: false,
    detail: `축별 최대 어긋남 ${parts.join(" · ")}`,
    issues,
  };
}

/** Occupied bins along `axis` (world units, origin-centred), or null when the view does not see that axis. */
function occupancy(silhouette: Silhouette, id: ViewId, axis: Axis, pixelsPerUnit: number): Uint8Array | null {
  const index = { x: 0, y: 1, z: 2 }[axis];
  const basis = BASES[id];
  const alongRight = basis.right[index] ?? 0;
  const alongUp = basis.up[index] ?? 0;
  if (!alongRight && !alongUp) return null;
  const { width, height, mask } = silhouette;
  const bins = new Uint8Array(PROFILE_BINS_PER_UNIT * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue;
      const world = alongRight
        ? ((x + 0.5 - width / 2) / pixelsPerUnit) * alongRight
        : (-(y + 0.5 - height / 2) / pixelsPerUnit) * alongUp;
      const bin = Math.floor(world * PROFILE_BINS_PER_UNIT + PROFILE_BINS_PER_UNIT);
      if (bin >= 0 && bin < bins.length) bins[bin] = 1;
    }
  }
  return bins;
}

function bestShift(reference: Uint8Array, profile: Uint8Array): number {
  const limit = Math.round(PROFILE_SEARCH * PROFILE_BINS_PER_UNIT);
  let best = 0;
  let bestScore = -1;
  for (let shift = -limit; shift <= limit; shift++) {
    let intersection = 0;
    let union = 0;
    for (let i = 0; i < reference.length; i++) {
      const a = reference[i] === 1;
      const b = profile[i + shift] === 1;
      if (a && b) intersection++;
      if (a || b) union++;
    }
    const score = union === 0 ? 0 : intersection / union;
    // Prefer the smallest shift among equals so aligned sets report 0.
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && Math.abs(shift) < Math.abs(best))) {
      bestScore = score;
      best = shift;
    }
  }
  // Positive: `profile` sits further along +axis than the reference.
  return best;
}

/** Coarse visual hull re-projected into every view: the share of each silhouette the other views allow. */
function agreementCheck(set: PreparedSet): Check {
  const silhouettes = new Map([...set.views].map(([id, view]) => [id, view.silhouette] as const));
  const ious = reprojectionIoU(set, silhouettes, AGREEMENT_RESOLUTION);
  const issues: Issue[] = [];
  for (const [id, iou] of ious) {
    if (iou >= 0.9) continue;
    issues.push({
      severity: iou < 0.75 ? "error" : "warn",
      views: [id],
      message: `${VIEWS[id].label} 실루엣의 ${((1 - iou) * 100).toFixed(1)}%가 다른 뷰와 모순되어 깎여 나갑니다. 방향·스케일·위치를 확인하세요.`,
    });
  }
  const values = [...ious.values()];
  // One contradicting view carves the others away, so the worst view sets the score.
  const worst = values.length > 0 ? Math.min(...values) : 0;
  return {
    id: "agreement",
    label: "뷰 일치도",
    score: clamp01((worst - 0.6) / 0.33),
    weight: 0.3,
    critical: true,
    detail: values.length > 0 ? [...ious].map(([id, iou]) => `${id} ${(iou * 100).toFixed(1)}%`).join(" · ") : "비교할 뷰 없음",
    issues,
  };
}

/** IoU between each view's silhouette and the carved hull rendered back into that view. */
export function reprojectionIoU(
  set: PreparedSet,
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  resolution: number,
): Map<ViewId, number> {
  const out = new Map<ViewId, number>();
  if (silhouettes.size === 0) return out;
  let mesh;
  try {
    mesh = extractSurface(buildHullField(silhouettes, { pixelsPerUnit: set.pixelsPerUnit, extent: set.alignment.extent }, { resolution }));
  } catch {
    for (const id of silhouettes.keys()) out.set(id, 0);
    return out;
  }
  const first = [...silhouettes.values()][0];
  const renders = renderViews(mesh, { size: first?.width ?? 512, pixelsPerUnit: set.pixelsPerUnit });
  for (const [id, silhouette] of silhouettes) out.set(id, maskIoU(silhouette, renders[id].pixels));
  return out;
}

/** IoU of a silhouette mask against an RGBA render's alpha (same size). */
export function maskIoU(silhouette: Silhouette, rgba: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < silhouette.mask.length; i++) {
    const a = silhouette.mask[i] === 1;
    const b = (rgba[i * 4 + 3] ?? 0) >= 128;
    if (a && b) intersection++;
    if (a || b) union++;
  }
  return union === 0 ? 0 : intersection / union;
}

function inputCheck(set: PreparedSet): Check {
  const samples = new Map([...set.views].map(([id, view]) => [id, view] as const));
  const base = integrityCheck(samples, set.missing);
  const issues: Issue[] = base.issues.map((issue) =>
    issue.views.some((id) => set.missing.includes(id) && VIEWS[id].required)
      ? { ...issue, message: `${issue.message} 필수 뷰이므로 3D 생성을 할 수 없습니다.` }
      : issue,
  );
  for (const view of set.views.values()) {
    const label = VIEWS[view.id].label;
    if (Math.max(view.source.width, view.source.height) < MIN_SOURCE_SIZE) {
      issues.push({ severity: "warn", views: [view.id], message: `${label} 이미지가 너무 작습니다 (${view.source.width}×${view.source.height}). 실루엣이 거칠어집니다.` });
    }
    if (!view.hadAlpha) {
      issues.push({ severity: "warn", views: [view.id], message: `${label} 이미지에 투명 배경(alpha)이 없어 배경색 키잉으로 마스크를 만들었습니다. 배경 제거된 PNG를 권장합니다.` });
    }
    if (view.cutOffPixels > view.perimeter * 0.02) {
      issues.push({ severity: "error", views: [view.id], message: `${label} 이미지에서 피사체가 가장자리에 잘려 있습니다. 잘린 부분은 복원할 수 없습니다.` });
    }
    if (view.clipped > 0.01) {
      issues.push({ severity: "warn", views: [view.id], message: `${label} 뷰가 보정(scale/offset) 후 캔버스 밖으로 ${(view.clipped * 100).toFixed(1)}% 나갔습니다.` });
    }
    if (view.transform.flip) {
      issues.push({
        severity: "warn",
        views: [view.id],
        message:
          `${label} 뷰에 좌우 반전을 적용했습니다. 실루엣은 맞아도 꽃·글자 같은 비대칭 부위가 반대쪽에 찍힙니다.` +
          (view.id === "left" || view.id === "right"
            ? " 이미지 이름이 캐릭터 자신의 왼쪽/오른쪽 기준이라면 반전 대신 'left ↔ right 교체'를 쓰세요."
            : ""),
      });
    }
  }
  const penalty = issues.some((i) => i.severity === "error") ? 0.5 : issues.length > 0 ? 0.85 : 1;
  return {
    ...base,
    id: "input",
    label: "입력 상태",
    score: Math.min(base.score, penalty),
    weight: 0.15,
    detail: `유효 뷰 ${set.views.size}/${VIEW_IDS.length} · ${base.detail.split(" · ").slice(1).join(" · ")}`,
    issues,
  };
}

function rank(severity: Issue["severity"]): number {
  return severity === "error" ? 2 : severity === "warn" ? 1 : 0;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
