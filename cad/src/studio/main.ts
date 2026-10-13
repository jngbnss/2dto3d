import * as api from "./api";
import { h } from "./dom";
import { CHARACTER, renderGenerate, renderResult, renderValidation, type GenerateForm } from "./panel";
import { renderSlot } from "./slots";
import type { State, ViewId } from "./types";
import "./studio.css";

/**
 * Upload / alignment studio. The page holds no reconstruction logic: it
 * renders whatever `GET /api/state` (or a mutation response) returns, and the
 * only local state is UI-only (busy flags, open sections, form values).
 */

const ui = {
  stamp: Date.now(),
  busy: new Set<ViewId>(),
  showRaw: new Set<ViewId>(),
  tuneOpen: new Set<ViewId>(),
  generating: false,
  loadingAll: false,
  form: { resolution: 160, smoothing: 12, hybridAi: false, ...CHARACTER } as GenerateForm,
};

let current: State | null = null;
/** Responses are applied in request order so a slow reply cannot overwrite a newer state. */
let requestSeq = 0;
let appliedSeq = 0;

const root = document.getElementById("app")!;
const toastBox = h("div", { class: "toasts", "aria-live": "polite" });
document.body.append(toastBox);

function toast(message: string, kind: "error" | "ok" | "info" = "info"): void {
  const el = h(
    "div",
    { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" },
    h("span", {}, message),
    h("button", { type: "button", class: "btn-icon", "aria-label": "닫기", onClick: () => el.remove() }, "✕"),
  );
  toastBox.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 10000 : 4000);
}

/**
 * Runs one server call, marks `slot` busy meanwhile, and applies the returned
 * state. Errors surface as a toast; returns whether the call succeeded.
 */
async function mutate(call: () => Promise<State>, slot?: ViewId): Promise<boolean> {
  const seq = ++requestSeq;
  if (slot) ui.busy.add(slot);
  render(current);
  try {
    const state = await call();
    if (seq > appliedSeq) {
      appliedSeq = seq;
      current = state;
      ui.stamp = Date.now();
    }
    return true;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
    return false;
  } finally {
    if (slot) ui.busy.delete(slot);
    render(current);
  }
}

const slotActions = {
  upload: (id: ViewId, file: File) => void mutate(() => api.uploadView(id, file), id),
  clear: (id: ViewId) => void mutate(() => api.clearView(id), id),
  transform: (id: ViewId, patch: Parameters<typeof api.setTransform>[1]) => void mutate(() => api.setTransform(id, patch), id),
  setShowRaw(id: ViewId, on: boolean) {
    if (on) ui.showRaw.add(id);
    else ui.showRaw.delete(id);
    render(current);
  },
  setTuneOpen(id: ViewId, open: boolean) {
    // Only bookkeeping: <details> already toggled itself, so no re-render.
    if (open) ui.tuneOpen.add(id);
    else ui.tuneOpen.delete(id);
  },
};

const panelActions = {
  updateForm(patch: Partial<GenerateForm>) {
    Object.assign(ui.form, patch);
  },
  async generate() {
    ui.generating = true;
    const ok = await mutate(() => api.generate({ ...ui.form }));
    ui.generating = false;
    render(current);
    if (ok) toast("3D 모델을 생성했습니다.", "ok");
  },
};

async function reload(): Promise<void> {
  ui.loadingAll = true;
  await mutate(api.getState);
  ui.loadingAll = false;
  render(current);
}

async function clearAll(): Promise<void> {
  const filled = current?.views.filter((v) => v.hasImage) ?? [];
  if (!filled.length) {
    toast("비울 이미지가 없습니다.");
    return;
  }
  if (!confirm(`업로드된 이미지 ${filled.length}개를 모두 지울까요?`)) return;
  for (const view of filled) {
    if (!(await mutate(() => api.clearView(view.id), view.id))) break;
  }
}

async function autoAlign(): Promise<void> {
  const ids = current?.views.filter((view) => view.hasImage).map((view) => view.id) ?? [];
  for (const id of ids) ui.busy.add(id);
  render(current);
  const ok = await mutate(api.autoAlign);
  for (const id of ids) ui.busy.delete(id);
  render(current);
  if (ok) toast("크기와 중심을 자동 보정했습니다.", "ok");
}

function renderHeader(state: State | null): HTMLElement {
  const busy = ui.loadingAll || ui.generating || ui.busy.size > 0;
  return h(
    "header",
    { class: "topbar" },
    h("h1", {}, "5면 → 3D"),
    h("span", { class: "muted dir", title: state?.directory ?? "" }, state ? `데이터: ${state.directory}` : "불러오는 중…"),
    h("span", { class: "spacer" }),
    h("button", { type: "button", disabled: ui.loadingAll, onClick: () => void reload() }, "다시 불러오기"),
    h(
      "button",
      {
        type: "button",
        class: "is-on",
        title: "회전·반전·자르기는 유지하고, 각 뷰의 피사체 마스크에서 공통 XYZ 크기와 중심을 다시 계산합니다.",
        disabled: busy || !state?.views.some((view) => view.hasImage),
        onClick: () => void autoAlign(),
      },
      "크기·중심 자동 보정",
    ),
    h(
      "button",
      {
        type: "button",
        title: "left/right 슬롯의 이미지와 보정을 서로 바꿉니다. 이미지 이름이 캐릭터 자신의 왼쪽/오른쪽 기준일 때 사용하세요.",
        disabled: busy || !state?.views.some((v) => (v.id === "left" || v.id === "right") && v.hasImage),
        onClick: () => void mutate(() => api.swapViews("left", "right")),
      },
      "left ↔ right 교체",
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn-danger",
        disabled: busy || !state?.views.some((v) => v.hasImage),
        onClick: () => void clearAll(),
      },
      "전부 비우기",
    ),
    h("a", { class: "btn-link primary", href: "/viewer" }, "3D 뷰어 열기 →"),
  );
}

/** Rebuilds the whole page from `state` plus the UI-only flags. */
function render(state: State | null): void {
  const header = renderHeader(state);
  if (!state) {
    root.replaceChildren(header, h("p", { class: "muted loading" }, ui.loadingAll ? "상태를 불러오는 중…" : "상태를 불러오지 못했습니다. 다시 불러오기를 눌러 주세요."));
    return;
  }
  const slots = h("div", { class: "slots" }, ...state.views.map((v) => renderSlot(v, ui, slotActions)));
  const side = h(
    "aside",
    { class: "side" },
    renderValidation(state.validation),
    renderGenerate(state, ui, panelActions),
  );
  root.replaceChildren(
    header,
    h("main", { class: "layout" }, slots, side),
    ...(state.result ? [renderResult(state.result, ui.stamp)] : []),
  );
}

void reload();
