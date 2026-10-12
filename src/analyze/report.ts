import { VIEW_IDS, VIEWS, AXIS_LABEL, type Axis, type ViewId } from "../views.ts";
import { loadRaster } from "./raster.ts";
import { extractSilhouette } from "./silhouette.ts";
import { colorCheck, dimensionCheck, integrityCheck, mirrorCheck } from "./checks.ts";
import type { Check, Issue, SixViewReport, ViewSample } from "./types.ts";

export type ViewPaths = Partial<Record<ViewId, string>>;

/** Score at or above which a view set is usable for reconstruction without edits. */
const PASS = 0.8;
/** Below this the set should be regenerated rather than repaired. */
const REVIEW = 0.55;
/** A single check this low means one necessary measurement is unrecoverable. */
const CHECK_FLOOR = 0.5;

export async function analyzeViewSet(paths: ViewPaths): Promise<SixViewReport> {
  const samples = new Map<ViewId, ViewSample>();
  const missing: ViewId[] = [];

  await Promise.all(
    VIEW_IDS.map(async (id) => {
      const path = paths[id];
      if (!path) {
        missing.push(id);
        return;
      }
      const raster = await loadRaster(path);
      samples.set(id, { id, path, silhouette: extractSilhouette(raster) });
    }),
  );
  missing.sort((a, b) => VIEW_IDS.indexOf(a) - VIEW_IDS.indexOf(b));

  const dimension = dimensionCheck(samples);
  const checks: Check[] = [
    dimension.check,
    mirrorCheck(samples),
    integrityCheck(samples, missing),
    colorCheck(samples),
  ];

  let weighted = 0;
  let weight = 0;
  for (const check of checks) {
    weighted += check.score * check.weight;
    weight += check.weight;
  }
  const score = weight > 0 ? weighted / weight : 0;

  const issues: Issue[] = checks
    .flatMap((c) => c.issues)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const extents: Record<Axis, number> = { x: 0, y: 0, z: 0 };
  for (const axis of dimension.axes) extents[axis.axis] = axis.extent;
  const largest = Math.max(extents.x, extents.y, extents.z, Number.EPSILON);

  return {
    score,
    verdict: verdictOf(score, checks, issues, missing),
    checks,
    issues,
    axes: dimension.axes,
    proportions: {
      x: extents.x / largest,
      y: extents.y / largest,
      z: extents.z / largest,
    },
    views: [...samples.values()]
      .sort((a, b) => VIEW_IDS.indexOf(a.id) - VIEW_IDS.indexOf(b.id))
      .map((s) => ({
        id: s.id,
        path: s.path,
        maskSource: s.silhouette.source,
        extent: s.silhouette.extent,
        center: s.silhouette.center,
        fill: s.silhouette.fill,
        largestBlob: s.silhouette.largestBlob,
        blobs: s.silhouette.blobs,
        meanColor: s.silhouette.meanColor,
      })),
    missing,
  };
}

function severityRank(severity: Issue["severity"]): number {
  return severity === "error" ? 2 : severity === "warn" ? 1 : 0;
}

/**
 * The weighted score alone is too forgiving: four checks averaging well can hide
 * one measurement that reconstruction cannot do without. Errors and dead checks
 * therefore gate the verdict directly.
 */
function verdictOf(
  score: number,
  checks: readonly Check[],
  issues: readonly Issue[],
  missing: readonly ViewId[],
): SixViewReport["verdict"] {
  const dead = checks.some((check) => check.critical && check.score < CHECK_FLOOR);
  if (score < REVIEW || dead || missing.length >= 2) return "fail";
  const errors = issues.some((issue) => issue.severity === "error");
  if (score < PASS || errors || missing.length > 0) return "review";
  return "pass";
}

export function formatReport(report: SixViewReport): string {
  const lines: string[] = [];
  const verdict = { pass: "통과", review: "검토 필요", fail: "재생성 권장" }[report.verdict];
  lines.push(`6면 분석 결과: ${(report.score * 100).toFixed(1)}점 — ${verdict}`);
  lines.push("");

  lines.push("항목별 점수");
  for (const check of report.checks) {
    lines.push(
      `  ${bar(check.score)} ${(check.score * 100).toFixed(1).padStart(5)}  ${check.label} (가중치 ${check.weight})`,
    );
    if (check.detail) lines.push(`         ${check.detail}`);
  }
  lines.push("");

  lines.push("추정 비율 (가장 긴 축 = 1.000)");
  lines.push(
    `  X ${report.proportions.x.toFixed(3)} : Y ${report.proportions.y.toFixed(3)} : Z ${report.proportions.z.toFixed(3)}`,
  );
  for (const axis of report.axes) {
    lines.push(
      `  ${AXIS_LABEL[axis.axis]} 기준 ${axis.extent.toFixed(3)} · 관측 ${axis.observations.length}개 · 평균 편차 ${(axis.deviation * 100).toFixed(1)}%`,
    );
  }
  lines.push("");

  lines.push("뷰별 측정");
  for (const view of report.views) {
    lines.push(
      `  ${VIEWS[view.id].label.padEnd(3)} ${view.extent.width.toFixed(3)} x ${view.extent.height.toFixed(3)} · 중심 (${view.center.x.toFixed(3)}, ${view.center.y.toFixed(3)}) · 덩어리 ${view.blobs} · 마스크 ${view.maskSource}`,
    );
  }

  if (report.issues.length > 0) {
    lines.push("");
    lines.push(`문제 ${report.issues.length}건`);
    for (const issue of report.issues) {
      const tag = issue.severity === "error" ? "[심각]" : issue.severity === "warn" ? "[경고]" : "[참고]";
      lines.push(`  ${tag} ${issue.message}`);
    }
  }
  return lines.join("\n");
}

function bar(score: number): string {
  const filled = Math.round(score * 10);
  return `${"█".repeat(filled)}${"·".repeat(10 - filled)}`;
}
