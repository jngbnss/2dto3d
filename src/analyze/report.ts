import { VIEW_IDS, VIEWS, AXIS_LABEL, type ViewId } from "../views.ts";
import { prepareViewSet } from "../preprocess.ts";
import { validate } from "../validation.ts";
import type { ViewTransforms } from "../orientation.ts";
import type { ViewSetReport } from "./types.ts";

export type ViewPaths = Partial<Record<ViewId, string>>;

/** Prepares the views (orientation, alignment) and validates them as one set. */
export async function analyzeViewSet(paths: ViewPaths, transforms: ViewTransforms = {}): Promise<ViewSetReport> {
  return validate(await prepareViewSet(paths, transforms));
}

export function formatReport(report: ViewSetReport): string {
  const lines: string[] = [];
  const verdict = { pass: "통과", review: "검토 필요", fail: "재생성 권장" }[report.verdict];
  lines.push(`${VIEW_IDS.length}면 정렬 품질: ${(report.score * 100).toFixed(1)}점 — ${verdict}`);
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
      `  ${AXIS_LABEL[axis.axis]} ${axis.extent.toFixed(3)} · 관측 ${axis.observations.length}개 · 평균 편차 ${(axis.deviation * 100).toFixed(1)}%`,
    );
  }
  lines.push("");

  lines.push("뷰별 측정 (정렬 후 캔버스 비율)");
  for (const view of report.views) {
    lines.push(
      `  ${VIEWS[view.id].label.padEnd(5)} ${view.extent.width.toFixed(3)} x ${view.extent.height.toFixed(3)} · 덩어리 ${view.blobs} · 마스크 ${view.maskSource}`,
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
  return "█".repeat(filled) + "·".repeat(10 - filled);
}
