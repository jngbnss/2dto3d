import { FULL_RESET } from "./api";
import { bust, h } from "./dom";
import type { ViewId, ViewState, ViewTransform } from "./types";

/** Per-slot UI state that must survive a full re-render. */
export interface SlotUi {
  stamp: number;
  busy: ReadonlySet<ViewId>;
  showRaw: ReadonlySet<ViewId>;
  tuneOpen: ReadonlySet<ViewId>;
}

export interface SlotActions {
  upload(id: ViewId, file: File): void;
  clear(id: ViewId): void;
  transform(id: ViewId, patch: Partial<ViewTransform>): void;
  setShowRaw(id: ViewId, on: boolean): void;
  setTuneOpen(id: ViewId, open: boolean): void;
}

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  digits: number;
  value(t: ViewTransform): number;
  patch(t: ViewTransform, v: number): Partial<ViewTransform>;
}

const cropSlider = (side: keyof ViewTransform["crop"], label: string): SliderSpec => ({
  label,
  min: 0,
  max: 0.45,
  step: 0.01,
  digits: 2,
  value: (t) => t.crop[side],
  patch: (t, v) => ({ crop: { ...t.crop, [side]: v } }),
});

const SLIDERS: SliderSpec[] = [
  { label: "크기", min: 0.5, max: 2, step: 0.01, digits: 2, value: (t) => t.scale, patch: (_, v) => ({ scale: v }) },
  {
    label: "가로 이동",
    min: -0.25,
    max: 0.25,
    step: 0.005,
    digits: 3,
    value: (t) => t.offsetX,
    patch: (_, v) => ({ offsetX: v }),
  },
  {
    label: "세로 이동",
    min: -0.25,
    max: 0.25,
    step: 0.005,
    digits: 3,
    value: (t) => t.offsetY,
    patch: (_, v) => ({ offsetY: v }),
  },
  cropSlider("left", "자르기 왼쪽"),
  cropSlider("top", "자르기 위"),
  cropSlider("right", "자르기 오른쪽"),
  cropSlider("bottom", "자르기 아래"),
];

/** "+Y" → "-Y", "-Z" → "+Z"; anything without a sign is returned unchanged. */
function opposite(axis: string): string {
  if (axis.startsWith("+")) return `-${axis.slice(1)}`;
  if (axis.startsWith("-")) return `+${axis.slice(1)}`;
  return axis;
}

function marker(edge: "top" | "right" | "bottom" | "left", axis: string): HTMLElement {
  const text = { top: `▲ ${axis}`, right: `${axis} ▶`, bottom: `▼ ${axis}`, left: `◀ ${axis}` }[edge];
  const front = axis === "+Z";
  return h(
    "span",
    { class: `marker marker-${edge}${front ? " is-front" : ""}`, title: front ? "물체의 앞면 방향" : undefined },
    text,
  );
}

function renderStage(view: ViewState, ui: SlotUi, actions: SlotActions): HTMLElement {
  const busy = ui.busy.has(view.id);
  const showRaw = ui.showRaw.has(view.id) && view.rawUrl !== null;
  const imageUrl = showRaw ? view.rawUrl : view.preparedUrl;
  const { up, right } = view.axes;

  const picker = h("input", {
    type: "file",
    accept: "image/*",
    hidden: true,
    onChange: () => {
      const file = picker.files?.[0];
      if (file) actions.upload(view.id, file);
      picker.value = "";
    },
  });

  const stage = h(
    "div",
    {
      class: `stage${view.hasImage ? "" : " is-empty"}`,
      role: "button",
      tabIndex: 0,
      title: "클릭하거나 이미지를 끌어다 놓아 교체",
      onClick: () => {
        if (!busy) picker.click();
      },
      onKeydown: (event: KeyboardEvent) => {
        if ((event.key === "Enter" || event.key === " ") && !busy) {
          event.preventDefault();
          picker.click();
        }
      },
      onDragover: (event: DragEvent) => {
        event.preventDefault();
        stage.classList.add("is-drop");
      },
      onDragleave: () => stage.classList.remove("is-drop"),
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        stage.classList.remove("is-drop");
        const file = Array.from(event.dataTransfer?.files ?? []).find((f) => f.type.startsWith("image/"));
        if (file && !busy) actions.upload(view.id, file);
      },
    },
    picker,
  );

  if (imageUrl) {
    stage.append(h("img", { class: "stage-img", src: bust(imageUrl, ui.stamp), alt: `${view.label} 이미지`, draggable: false }));
  } else {
    stage.append(
      h(
        "div",
        { class: "stage-empty" },
        view.required ? h("span", { class: "badge badge-required" }, "필수") : h("span", { class: "badge" }, "선택"),
        h("span", {}, "이미지를 끌어다 놓거나 클릭"),
      ),
    );
  }

  const overlay = h("div", { class: "overlay" }, h("div", { class: "center-v" }), h("div", { class: "center-h" }));
  // bbox / outline / axis markers describe the prepared canvas, so they are hidden over the raw upload.
  if (!showRaw) {
    if (view.bbox) {
      const { x0, y0, x1, y1 } = view.bbox;
      overlay.append(
        h("div", {
          class: "bbox",
          style: `left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%`,
        }),
      );
    }
    if (view.outlineUrl) {
      overlay.append(h("img", { class: "outline", src: bust(view.outlineUrl, ui.stamp), alt: "" }));
    }
    overlay.append(
      marker("top", up),
      marker("right", right),
      marker("bottom", opposite(up)),
      marker("left", opposite(right)),
      h("span", { class: "corner-tag" }, `${view.label} · top=${up} right=${right}`),
    );
  } else {
    overlay.append(h("span", { class: "corner-tag" }, `${view.label} · 원본 업로드`));
  }
  stage.append(overlay);

  if (busy) stage.append(h("div", { class: "busy" }, h("span", { class: "spinner" }), "처리 중…"));
  return stage;
}

function renderTune(view: ViewState, ui: SlotUi, actions: SlotActions, disabled: boolean): HTMLElement {
  const t = view.transform;
  const details = h(
    "details",
    {
      class: "tune",
      open: ui.tuneOpen.has(view.id),
      onToggle: () => actions.setTuneOpen(view.id, details.open),
    },
    h("summary", {}, "정렬 보정"),
  );
  for (const spec of SLIDERS) {
    const current = spec.value(t);
    const out = h("output", {}, current.toFixed(spec.digits));
    const input = h("input", {
      type: "range",
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: String(current),
      disabled,
      onInput: () => {
        out.textContent = Number(input.value).toFixed(spec.digits);
      },
      onChange: () => actions.transform(view.id, spec.patch(t, Number(input.value))),
    });
    details.append(h("label", { class: "slider" }, h("span", {}, spec.label), input, out));
  }
  details.append(
    h(
      "button",
      { type: "button", class: "btn-small", disabled, onClick: () => actions.transform(view.id, FULL_RESET) },
      "보정 초기화",
    ),
  );
  return details;
}

export function renderSlot(view: ViewState, ui: SlotUi, actions: SlotActions): HTMLElement {
  const busy = ui.busy.has(view.id);
  const disabled = busy || !view.hasImage;
  const t = view.transform;

  const caption = h(
    "div",
    { class: "caption" },
    h("strong", {}, view.label),
    view.required ? h("span", { class: "badge badge-required" }, "필수") : null,
    h("span", { class: "muted" }, view.source ? `${view.source.width}×${view.source.height}px` : "이미지 없음"),
    h(
      "label",
      { class: "raw-toggle" },
      h("input", {
        type: "checkbox",
        checked: ui.showRaw.has(view.id),
        disabled: view.rawUrl === null,
        onChange: (event: Event) => actions.setShowRaw(view.id, (event.target as HTMLInputElement).checked),
      }),
      "원본 보기",
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn-icon",
        title: "이미지 지우기",
        "aria-label": `${view.label} 이미지 지우기`,
        disabled,
        onClick: () => actions.clear(view.id),
      },
      "✕",
    ),
  );

  const controls = h(
    "div",
    { class: "controls" },
    h(
      "button",
      {
        type: "button",
        disabled,
        onClick: () => actions.transform(view.id, { rotation: ((t.rotation + 270) % 360) as ViewTransform["rotation"] }),
      },
      "⟲ -90°",
    ),
    h(
      "button",
      {
        type: "button",
        disabled,
        onClick: () => actions.transform(view.id, { rotation: ((t.rotation + 90) % 360) as ViewTransform["rotation"] }),
      },
      "⟳ +90°",
    ),
    h(
      "button",
      { type: "button", disabled: disabled || t.rotation === 0, onClick: () => actions.transform(view.id, { rotation: 0 }) },
      "회전 초기화",
    ),
    h(
      "button",
      {
        type: "button",
        class: t.flip ? "is-on" : undefined,
        "aria-pressed": String(t.flip),
        disabled,
        onClick: () => actions.transform(view.id, { flip: !t.flip }),
      },
      "좌우 반전",
    ),
    h("span", { class: "muted rot" }, `${t.rotation}°${t.flip ? " · 반전" : ""}`),
  );

  return h(
    "section",
    { class: `slot${busy ? " is-busy" : ""}`, "data-view": view.id },
    caption,
    renderStage(view, ui, actions),
    controls,
    renderTune(view, ui, actions, disabled),
  );
}
