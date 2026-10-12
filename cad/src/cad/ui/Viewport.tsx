import { useEffect, useRef } from "react";
import { CADRenderer, type ViewPreset } from "../render/renderer";
import { useProjectStore } from "../core/projectStore";
import { capsOf } from "../core/types";
import { setMeshScale, setTransform, topLevelOf } from "../core/objectManager";

const VIEWS: { key: ViewPreset; label: string; hotkey: string }[] = [
  { key: "front", label: "Front", hotkey: "1" },
  { key: "back", label: "Back", hotkey: "2" },
  { key: "left", label: "Left", hotkey: "3" },
  { key: "right", label: "Right", hotkey: "4" },
  { key: "top", label: "Top", hotkey: "5" },
  { key: "bottom", label: "Bottom", hotkey: "6" },
  { key: "iso", label: "Iso", hotkey: "7" },
];

export function Viewport({ onReady }: { onReady: (renderer: CADRenderer | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<CADRenderer | null>(null);
  const viewport = useProjectStore((s) => s.viewport);
  const setViewport = useProjectStore((s) => s.setViewport);
  const selection = useProjectStore((s) => s.selection);

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const renderer = new CADRenderer(hostRef.current);
    rendererRef.current = renderer;

    renderer.onSelect = (id, additive) => {
      const store = useProjectStore.getState();
      if (!id) {
        if (!additive) store.select([]);
        return;
      }
      store.toggleSelect(id, additive);
    };

    renderer.onTransformCommit = (updates) => {
      const store = useProjectStore.getState();
      const mode = store.viewport.transformMode;
      store.commit(mode === "rotate" ? "Rotate (gizmo)" : mode === "scale" ? "Scale (gizmo)" : "Move (gizmo)", (draft) => {
        for (const update of updates) {
          const object = draft.objects[update.id];
          if (!object) continue;
          setTransform(draft, update.id, update.transform);
          if (object.kind === "mesh" && update.scale) setMeshScale(draft, update.id, update.scale);
        }
      }, { log: `gizmo ${mode}`, ids: updates.map((u) => u.id) });
    };

    onReady(renderer);
    return () => {
      onReady(null);
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [onReady]);

  useEffect(() => {
    rendererRef.current?.setCameraMode(viewport.cameraMode);
  }, [viewport.cameraMode]);

  useEffect(() => {
    rendererRef.current?.setGridVisible(viewport.showGrid);
    rendererRef.current?.setAxesVisible(viewport.showAxes);
    rendererRef.current?.setEdgesVisible(viewport.showEdges);
  }, [viewport.showGrid, viewport.showAxes, viewport.showEdges]);

  useEffect(() => {
    rendererRef.current?.setSnap(viewport.snapTranslate, viewport.snapRotate);
  }, [viewport.snapTranslate, viewport.snapRotate]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const doc = useProjectStore.getState().doc;
    // The scale gizmo is only meaningful for meshes: a solid's size is a
    // parameter, not a display transform.
    const allowScale =
      selection.length > 0 &&
      topLevelOf(doc, selection).every((o) => capsOf(o).meshScale);
    renderer.setSelection(selection, allowScale, viewport.transformMode);
  }, [selection, viewport.transformMode]);

  return (
    <div className="viewport">
      <div className="viewport__canvas" ref={hostRef} />
      <div className="viewport__overlay viewport__overlay--views">
        {VIEWS.map((v) => (
          <button key={v.key} type="button" className="btn btn--chip" title={`${v.label} view (${v.hotkey})`}
            onClick={() => rendererRef.current?.setView(v.key)}>
            {v.label}
          </button>
        ))}
        <button type="button" className="btn btn--chip" title="Zoom to fit (F)"
          onClick={() => rendererRef.current?.fit(useProjectStore.getState().selection)}>
          Fit
        </button>
      </div>
      <div className="viewport__overlay viewport__overlay--modes">
        <div className="segmented">
          {(["translate", "rotate", "scale"] as const).map((mode) => (
            <button key={mode} type="button"
              className={`segmented__btn${viewport.transformMode === mode ? " segmented__btn--active" : ""}`}
              onClick={() => setViewport({ transformMode: mode })}
              title={`${mode} gizmo (${mode === "translate" ? "W" : mode === "rotate" ? "E" : "R"})`}>
              {mode === "translate" ? "Move" : mode === "rotate" ? "Rotate" : "Scale"}
            </button>
          ))}
        </div>
        <div className="segmented">
          {(["perspective", "orthographic"] as const).map((mode) => (
            <button key={mode} type="button"
              className={`segmented__btn${viewport.cameraMode === mode ? " segmented__btn--active" : ""}`}
              onClick={() => setViewport({ cameraMode: mode })}>
              {mode === "perspective" ? "Persp" : "Ortho"}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={viewport.showGrid} onChange={(e) => setViewport({ showGrid: e.target.checked })} />
          Grid
        </label>
        <label className="toggle">
          <input type="checkbox" checked={viewport.showEdges} onChange={(e) => setViewport({ showEdges: e.target.checked })} />
          Edges
        </label>
      </div>
    </div>
  );
}
