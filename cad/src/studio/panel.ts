import { bust, grade, h } from "./dom";
import type { GenerateResult, Resolution, State, Validation, Verdict } from "./types";

export interface GenerateForm {
  resolution: Resolution;
  symmetry: boolean;
  smoothing: number;
  rounding: number;
}

export interface PanelUi {
  stamp: number;
  generating: boolean;
  form: GenerateForm;
}

export interface PanelActions {
  updateForm(patch: Partial<GenerateForm>): void;
  generate(): void;
}

const RESOLUTIONS: Resolution[] = [96, 128, 160, 192, 256];

const VERDICTS: Record<Verdict, { text: string; tone: "ok" | "warn" | "bad" }> = {
  pass: { text: "통과", tone: "ok" },
  review: { text: "검토 필요", tone: "warn" },
  fail: { text: "재생성 권장", tone: "bad" },
};

const SEVERITY_TEXT = { error: "오류", warn: "경고", info: "참고" } as const;

export function renderValidation(validation: Validation): HTMLElement {
  const verdict = VERDICTS[validation.verdict];
  const checks = h("ul", { class: "checks" });
  for (const check of validation.checks) {
    const tone = grade(check.score);
    checks.append(
      h(
        "li",
        {},
        h(
          "div",
          { class: "check-head" },
          h("span", {}, check.label),
          h("span", { class: `tone-${tone}` }, String(Math.round(check.score * 100))),
        ),
        h(
          "div",
          { class: "bar" },
          h("div", { class: `bar-fill fill-${tone}`, style: `width:${Math.max(0, Math.min(1, check.score)) * 100}%` }),
        ),
        check.detail ? h("p", { class: "muted small" }, check.detail) : null,
      ),
    );
  }

  const issues = h("ul", { class: "issues" });
  for (const issue of validation.issues) {
    issues.append(
      h(
        "li",
        { class: `issue issue-${issue.severity}` },
        h("span", { class: "issue-sev" }, SEVERITY_TEXT[issue.severity]),
        issue.views.length ? h("span", { class: "issue-views" }, issue.views.join(", ")) : null,
        h("span", {}, issue.message),
      ),
    );
  }

  return h(
    "section",
    { class: "panel" },
    h("h2", {}, "정렬 품질"),
    h(
      "div",
      { class: "score-row" },
      h("span", { class: `score tone-${verdict.tone}` }, String(Math.round(validation.score * 100))),
      h("span", { class: `chip chip-${verdict.tone}` }, verdict.text),
    ),
    validation.checks.length ? checks : null,
    validation.issues.length ? issues : h("p", { class: "muted small" }, "발견된 문제가 없습니다."),
  );
}

export function renderGenerate(state: State, ui: PanelUi, actions: PanelActions): HTMLElement {
  const { form } = ui;
  const blockers = state.blockers.length
    ? h("ul", { class: "blockers" }, ...state.blockers.map((b) => h("li", {}, b)))
    : null;

  const resolution = h(
    "select",
    {
      disabled: ui.generating,
      onChange: () => actions.updateForm({ resolution: Number(resolution.value) as Resolution }),
    },
    ...RESOLUTIONS.map((r) => h("option", { value: String(r), selected: r === form.resolution }, String(r))),
  );

  const smoothing = h("input", {
    type: "number",
    min: 0,
    max: 30,
    step: 1,
    value: String(form.smoothing),
    disabled: ui.generating,
    onChange: () => {
      const n = Math.round(Number(smoothing.value));
      const clamped = Number.isFinite(n) ? Math.min(30, Math.max(0, n)) : 12;
      smoothing.value = String(clamped);
      actions.updateForm({ smoothing: clamped });
    },
  });

  const roundingValue = h("span", { class: "muted" }, form.rounding.toFixed(2));
  const rounding = h("input", {
    type: "range",
    min: 0,
    max: 1,
    step: 0.05,
    value: String(form.rounding),
    disabled: ui.generating,
    onInput: () => (roundingValue.textContent = Number(rounding.value).toFixed(2)),
    onChange: () => actions.updateForm({ rounding: Number(rounding.value) }),
  });

  // Users pick what the object is; the reconstruction parameters follow from it.
  const kind = (label: string, hint: string, preset: Pick<GenerateForm, "rounding" | "symmetry">): HTMLElement =>
    h(
      "label",
      { class: "field check", title: hint },
      h("input", {
        type: "radio",
        name: "kind",
        checked: form.rounding === preset.rounding && form.symmetry === preset.symmetry,
        disabled: ui.generating,
        onChange: () => actions.updateForm(preset),
      }),
      h("span", {}, label),
    );

  return h(
    "section",
    { class: "panel" },
    h("h2", {}, "3D 생성"),
    blockers,
    h("div", { class: "muted" }, "물체 종류"),
    kind("캐릭터 · 인형 · 생물 (둥글게)", "단면을 타원으로 깎아 대각선 모서리를 둥글게 만듭니다.", CHARACTER),
    kind("자동차 · 제품 · 기계 (각지게)", "실루엣 교집합을 그대로 쓰고, 좌우 대칭으로 다듬습니다.", PRODUCT),
    h(
      "details",
      {},
      h("summary", {}, "고급 설정"),
      h("label", { class: "field" }, h("span", {}, "해상도"), resolution),
      h("label", { class: "field" }, h("span", {}, "스무딩 반복"), smoothing),
      h(
        "label",
        { class: "field", title: "0 = 실루엣 교집합 그대로, 1 = 단면을 타원으로." },
        h("span", {}, "곡면 보정"),
        rounding,
        roundingValue,
      ),
      h(
        "label",
        { class: "field check" },
        h("input", {
          type: "checkbox",
          checked: form.symmetry,
          disabled: ui.generating,
          onChange: (event: Event) => actions.updateForm({ symmetry: (event.target as HTMLInputElement).checked }),
        }),
        h("span", {}, "좌우 대칭 prior"),
      ),
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn-primary",
        disabled: !state.canGenerate || ui.generating,
        onClick: () => actions.generate(),
      },
      ui.generating ? h("span", { class: "spinner" }) : null,
      ui.generating ? "생성 중…" : "3D 생성",
    ),
  );
}

/**
 * Characters: round slices, no mirror prior (asymmetric parts such as a hair
 * flower would be cut off by it). Products: plain hull, mirrored.
 */
export const CHARACTER = { rounding: 1, symmetry: false } as const;
const PRODUCT = { rounding: 0, symmetry: true } as const;

export function renderResult(result: GenerateResult, stamp: number): HTMLElement {
  const rows = result.comparisons.map((c) =>
    h(
      "div",
      { class: "compare-row" },
      h(
        "div",
        { class: "compare-name" },
        h("strong", {}, c.id),
        h("span", { class: `iou tone-${grade(c.iou)}` }, `IoU ${(c.iou * 100).toFixed(1)}%`),
      ),
      h(
        "figure",
        {},
        h("img", { src: bust(c.originalUrl, stamp), alt: `${c.id} 원본` }),
        h("figcaption", {}, "원본"),
      ),
      h(
        "figure",
        {},
        h("img", { src: bust(c.renderUrl, stamp), alt: `${c.id} 재렌더` }),
        h("figcaption", {}, "재렌더"),
      ),
      h(
        "figure",
        {},
        h(
          "div",
          { class: "overlap" },
          h("img", { class: "overlap-original", src: bust(c.originalUrl, stamp), alt: "" }),
          h("img", { class: "overlap-render", src: bust(c.renderUrl, stamp), alt: `${c.id} 겹쳐보기` }),
        ),
        h("figcaption", {}, "겹쳐보기"),
      ),
    ),
  );

  return h(
    "section",
    { class: "panel result" },
    h("h2", {}, "생성 결과"),
    h(
      "div",
      { class: "result-summary" },
      h("span", {}, "삼각형 ", h("strong", {}, result.triangles.toLocaleString("ko-KR"))),
      h("span", {}, "해상도 ", h("strong", {}, String(result.resolution))),
      h(
        "span",
        {},
        "재투영 일치도 ",
        h("strong", { class: `tone-${grade(result.score)}` }, String(Math.round(result.score * 100))),
      ),
    ),
    h(
      "div",
      { class: "result-links" },
      h("a", { class: "btn-link primary", href: "/viewer" }, "3D 뷰어로 보기 →"),
      h("a", { class: "btn-link", href: result.glbUrl, download: "" }, "GLB 내려받기"),
      h("a", { class: "btn-link", href: result.objUrl, download: "" }, "OBJ 내려받기"),
      h("a", { class: "btn-link", href: result.voxelUrl, download: "" }, "복셀 GLB"),
    ),
    h("p", { class: "muted small" }, "겹쳐보기: 원본(50%) 위에 재렌더를 차이 합성 — 어긋난 부분이 밝게 보입니다."),
    h("div", { class: "compare" }, ...rows),
  );
}
