import { create } from "zustand";
import { CADHistoryManager } from "./historyManager";
import { cloneDocument, createDocument } from "./factories";
import { logOperation } from "./objectManager";
import { createAutosaver } from "./persistence";
import type { CadDocument, UnitName, Vec3 } from "./types";

export type StatusLevel = "info" | "success" | "warn" | "error";

export interface StatusMessage {
  level: StatusLevel;
  text: string;
  at: number;
}

export interface GeometryStats {
  volume: number;
  area: number;
  triangleCount: number;
  bbox: { min: Vec3; max: Vec3 };
}

export type TransformMode = "translate" | "rotate" | "scale";
export type CameraMode = "perspective" | "orthographic";

interface ViewportPrefs {
  cameraMode: CameraMode;
  transformMode: TransformMode;
  showGrid: boolean;
  showEdges: boolean;
  showAxes: boolean;
  /** Translation snap in mm; 0 disables snapping. */
  snapTranslate: number;
  /** Rotation snap in degrees; 0 disables snapping. */
  snapRotate: number;
}

interface ProjectState {
  doc: CadDocument;
  selection: string[];
  /** Path into the selected solid's feature tree ([] = the root feature). */
  featurePath: number[];
  status: StatusMessage;
  busy: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Per-object kernel failures. Keeps a bad boolean from blanking the app. */
  buildErrors: Record<string, string>;
  geometry: Record<string, GeometryStats>;
  viewport: ViewportPrefs;
  dirty: boolean;

  commit: (label: string, mutate: (draft: CadDocument) => void, options?: { log?: string; ids?: string[] }) => void;
  /** Transient change (e.g. a gizmo drag) that must not spam the undo stack. */
  apply: (mutate: (draft: CadDocument) => void) => void;
  undo: () => void;
  redo: () => void;
  select: (ids: string[], featurePath?: number[]) => void;
  toggleSelect: (id: string, additive: boolean) => void;
  setFeaturePath: (path: number[]) => void;
  setStatus: (level: StatusLevel, text: string) => void;
  setBusy: (delta: number) => void;
  setBuildError: (id: string, message: string | null) => void;
  setGeometry: (id: string, stats: GeometryStats) => void;
  replaceDocument: (doc: CadDocument, label: string) => void;
  newProject: () => void;
  setDisplayUnit: (unit: UnitName) => void;
  setProjectName: (name: string) => void;
  setViewport: (patch: Partial<ViewportPrefs>) => void;
  markSaved: () => void;
}

export const history = new CADHistoryManager(100);
const autosaver = createAutosaver(700);

const INITIAL_STATUS: StatusMessage = { level: "info", text: "Ready", at: Date.now() };

export const useProjectStore = create<ProjectState>((set, get) => ({
  doc: createDocument(),
  selection: [],
  featurePath: [],
  status: INITIAL_STATUS,
  busy: 0,
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  buildErrors: {},
  geometry: {},
  dirty: false,
  viewport: {
    cameraMode: "perspective",
    transformMode: "translate",
    showGrid: true,
    showEdges: true,
    showAxes: true,
    snapTranslate: 0,
    snapRotate: 0,
  },

  commit(label, mutate, options) {
    const { doc, selection } = get();
    history.push(label, doc, selection);
    const draft = cloneDocument(doc);
    try {
      mutate(draft);
    } catch (err) {
      // A failed mutation must not leave a phantom undo step behind.
      history.undo(doc, selection);
      set({ status: { level: "error", text: err instanceof Error ? err.message : String(err), at: Date.now() } });
      return;
    }
    if (options?.log) logOperation(draft, label, options.log, options.ids ?? []);
    draft.updatedAt = Date.now();
    set({
      doc: draft,
      dirty: true,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    });
    autosaver.schedule(draft);
  },

  apply(mutate) {
    const draft = cloneDocument(get().doc);
    mutate(draft);
    draft.updatedAt = Date.now();
    set({ doc: draft, dirty: true });
    autosaver.schedule(draft);
  },

  undo() {
    const { doc, selection } = get();
    const entry = history.undo(doc, selection);
    if (!entry) return;
    set({
      doc: entry.doc,
      selection: entry.selection.filter((id) => entry.doc.objects[id]),
      featurePath: [],
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
      status: { level: "info", text: `Undo — ${entry.label}`, at: Date.now() },
      dirty: true,
    });
    autosaver.schedule(entry.doc);
  },

  redo() {
    const { doc, selection } = get();
    const entry = history.redo(doc, selection);
    if (!entry) return;
    set({
      doc: entry.doc,
      selection: entry.selection.filter((id) => entry.doc.objects[id]),
      featurePath: [],
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
      status: { level: "info", text: `Redo — ${entry.label}`, at: Date.now() },
      dirty: true,
    });
    autosaver.schedule(entry.doc);
  },

  select(ids, featurePath = []) {
    const existing = get().doc.objects;
    set({ selection: ids.filter((id) => existing[id]), featurePath });
  },

  toggleSelect(id, additive) {
    const { selection } = get();
    if (!additive) {
      set({ selection: [id], featurePath: [] });
      return;
    }
    set({
      selection: selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id],
      featurePath: [],
    });
  },

  setFeaturePath(path) {
    set({ featurePath: path });
  },

  setStatus(level, text) {
    set({ status: { level, text, at: Date.now() } });
  },

  setBusy(delta) {
    set({ busy: Math.max(0, get().busy + delta) });
  },

  setBuildError(id, message) {
    const next = { ...get().buildErrors };
    if (message) next[id] = message;
    else delete next[id];
    set({ buildErrors: next });
  },

  setGeometry(id, stats) {
    set({ geometry: { ...get().geometry, [id]: stats } });
  },

  replaceDocument(doc, label) {
    history.clear();
    set({
      doc,
      selection: [],
      featurePath: [],
      buildErrors: {},
      geometry: {},
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
      dirty: false,
      status: { level: "success", text: label, at: Date.now() },
    });
    autosaver.schedule(doc);
  },

  newProject() {
    get().replaceDocument(createDocument(), "New project created");
  },

  setDisplayUnit(unit) {
    get().apply((draft) => {
      draft.displayUnit = unit;
    });
  },

  setProjectName(name) {
    get().commit("Rename project", (draft) => {
      draft.name = name.trim() || "Untitled project";
    });
  },

  setViewport(patch) {
    set({ viewport: { ...get().viewport, ...patch } });
  },

  markSaved() {
    set({ dirty: false });
  },
}));

export function flushAutosave(): Promise<void> {
  return autosaver.flush();
}

autosaver.onError((err) => {
  useProjectStore.getState().setStatus("warn", `Autosave failed: ${err.message}`);
});
