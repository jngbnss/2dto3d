import { useCallback, useEffect, useMemo, useState } from "react";
import { Toolbar } from "./Toolbar";
import { ObjectTree } from "./ObjectTree";
import { PropertiesPanel } from "./PropertiesPanel";
import { StatusBar } from "./StatusBar";
import { Viewport } from "./Viewport";
import { ExtrudeDialog } from "./dialogs/ExtrudeDialog";
import { HoleDialog } from "./dialogs/HoleDialog";
import { AiImportDialog, type AiImportResult } from "./dialogs/AiImportDialog";
import { WorkspaceContext } from "./WorkspaceContext";
import { useCadActions } from "./useCadActions";
import { useGeometrySync } from "./useGeometrySync";
import { getGeometryEngine } from "../engine/geometryEngine";
import type { CADRenderer } from "../render/renderer";
import { useProjectStore, flushAutosave } from "../core/projectStore";
import { loadAutosave } from "../core/persistence";
import { createDemoAdapter } from "../ai/demoAdapter";
import { createHttpAdapter, createSixviewAdapter, type AiPipelineAdapter } from "../ai/aiAdapter";
import { importGLTF, importOBJ, importSTL, normalizeAssetToMm } from "../file/fileManager";
import { ErrorBoundary } from "./ErrorBoundary";

export function CADWorkspace() {
  const engine = useMemo(() => getGeometryEngine(), []);
  const [renderer, setRenderer] = useState<CADRenderer | null>(null);
  const [kernelReady, setKernelReady] = useState(false);
  const [kernelError, setKernelError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"extrude" | "hole" | "ai" | null>(null);

  const doc = useProjectStore((s) => s.doc);
  const selection = useProjectStore((s) => s.selection);
  const setStatus = useProjectStore((s) => s.setStatus);
  const actions = useCadActions(renderer, engine);

  /* ------------------------------------------------------------ kernel boot */
  useEffect(() => {
    let cancelled = false;
    setStatus("info", "Starting the CAD kernel (OpenCascade / WASM)…");
    engine.onCrash = (message) => {
      setKernelReady(false);
      setKernelError(message);
      useProjectStore.getState().setStatus("error", `CAD kernel stopped: ${message}. Editing still works; geometry will rebuild on the next change.`);
    };
    engine
      .init()
      .then(() => {
        if (cancelled) return;
        setKernelReady(true);
        setKernelError(null);
        useProjectStore.getState().setStatus("success", "CAD kernel ready (OpenCascade B-rep)");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setKernelError(err.message);
        useProjectStore.getState().setStatus("error", `The CAD kernel could not start: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, setStatus]);

  /* ------------------------------------------------- restore after a refresh */
  useEffect(() => {
    let cancelled = false;
    loadAutosave()
      .then((restored) => {
        if (cancelled || !restored) return;
        if (Object.keys(restored.objects).length === 0) return;
        useProjectStore.getState().replaceDocument(restored, `Restored "${restored.name}" from the last session`);
      })
      .catch(() => {
        /* a missing or unreadable autosave is not worth interrupting the user */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const flush = () => {
      void flushAutosave();
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  useGeometrySync(renderer, engine, kernelReady, doc);

  /* -------------------------------------------------------------- shortcuts */
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable));
    };
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const store = useProjectStore.getState();
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        store.undo();
        return;
      }
      if (meta && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) {
        event.preventDefault();
        store.redo();
        return;
      }
      if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        actions.saveProject();
        return;
      }
      if (meta && event.key.toLowerCase() === "d") {
        event.preventDefault();
        actions.duplicateSelection();
        return;
      }
      if (meta && event.key.toLowerCase() === "g") {
        event.preventDefault();
        actions.groupSelection();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        actions.deleteSelection();
        return;
      }
      if (event.key === "Escape") {
        store.select([]);
        return;
      }
      const views = { "1": "front", "2": "back", "3": "left", "4": "right", "5": "top", "6": "bottom", "7": "iso" } as const;
      if (event.key in views) {
        renderer?.setView(views[event.key as keyof typeof views]);
        return;
      }
      if (event.key.toLowerCase() === "f") renderer?.fit(store.selection);
      if (event.key.toLowerCase() === "w") store.setViewport({ transformMode: "translate" });
      if (event.key.toLowerCase() === "e") store.setViewport({ transformMode: "rotate" });
      if (event.key.toLowerCase() === "r") store.setViewport({ transformMode: "scale" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, renderer]);

  /* ------------------------------------------------------------- AI adapters */
  const adapters = useMemo<AiPipelineAdapter[]>(() => {
    const configured = (import.meta.env.VITE_AI_PIPELINE_URL as string | undefined)?.trim();
    // The sixview adapter comes first: this editor ships inside that pipeline.
    return [
      createSixviewAdapter(),
      ...(configured ? [createHttpAdapter(configured)] : []),
      createDemoAdapter(),
    ];
  }, []);

  const handleAiImport = useCallback(async (result: AiImportResult) => {
    setDialog(null);
    const { descriptor, classification, payload } = result;
    try {
      if (classification.kind === "solid" && typeof payload === "string") {
        const { assetId } = await engine.importSTEP(payload);
        actions.addFeatureSolid({ type: "imported-step", assetId }, descriptor.name);
        setStatus("success", `"${descriptor.name}" imported as a B-rep CAD solid — full CAD editing available`);
        return;
      }
      const format = descriptor.asset?.format ?? "stl";
      const blob = new Blob([payload as ArrayBuffer]);
      const provenance = { source: `AI 2D→3D · ${descriptor.id}`, note: classification.reason };
      const meshes =
        format === "stl" ? [await importSTL(blob, descriptor.name)]
          : format === "obj" ? [await importOBJ(blob, descriptor.name)]
            : await importGLTF(blob, descriptor.name);

      // Reconstruction output has no physical scale; normalise and say so.
      const targetMm = descriptor.asset?.normalizeToMm;
      let scaleNote = "";
      const placed = meshes.map((m) => {
        if (!targetMm) return m;
        const { asset, factor, sourceSize } = normalizeAssetToMm(m.asset, targetMm);
        if (factor !== 1) {
          scaleNote = ` 원본은 무차원 좌표(최대 변 ${Math.max(...sourceSize).toFixed(3)})라 가장 긴 변을 ${targetMm} mm로 맞췄습니다(×${factor.toFixed(2)}). 실제 치수는 속성 패널에서 조정하세요.`;
        }
        return { ...m, asset };
      });

      actions.addMeshObjects(placed, "ai-generated", provenance);
      const triangles = placed.reduce((sum, m) => sum + m.asset.triangleCount, 0);
      setStatus(
        "warn",
        `"${descriptor.name}"을(를) 삼각형 메시로 가져왔습니다 (${triangles.toLocaleString()} 삼각형). 이동·회전·크기변경·메시 분석·STL/GLB 내보내기는 가능하지만, 치수 기반 편집·Boolean·STEP 내보내기는 불가합니다 — 솔리드 재구성이 필요합니다.${scaleNote}`,
      );
      setTimeout(() => renderer?.fit(useProjectStore.getState().selection), 200);
    } catch (err) {
      setStatus("error", `AI import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [actions, engine, renderer, setStatus]);

  const holeTarget = selection.length === 1 ? doc.objects[selection[0]] : null;

  return (
    <WorkspaceContext.Provider value={{ renderer, engine, kernelReady, kernelError }}>
      <div className="workspace">
        <Toolbar
          actions={actions}
          onExtrude={() => setDialog("extrude")}
          onHole={() => {
            if (holeTarget?.kind !== "solid") {
              setStatus("warn", "Select exactly one CAD solid to cut a hole in");
              return;
            }
            setDialog("hole");
          }}
          onAiImport={() => setDialog("ai")}
        />
        <div className="workspace__body">
          <ErrorBoundary label="Object tree"><ObjectTree actions={actions} /></ErrorBoundary>
          <ErrorBoundary label="Viewport"><Viewport onReady={setRenderer} /></ErrorBoundary>
          <ErrorBoundary label="Properties"><PropertiesPanel /></ErrorBoundary>
        </div>
        <StatusBar kernelReady={kernelReady} kernelError={kernelError} />

        {dialog === "extrude" ? (
          <ExtrudeDialog
            unit={doc.displayUnit}
            onCancel={() => setDialog(null)}
            onCreate={(feature, name) => {
              setDialog(null);
              actions.addFeatureSolid(feature, name);
            }}
          />
        ) : null}

        {dialog === "hole" && holeTarget?.kind === "solid" ? (
          <HoleDialog
            unit={doc.displayUnit}
            targetName={holeTarget.name}
            onCancel={() => setDialog(null)}
            onCreate={(hole) => {
              setDialog(null);
              void actions.applyHole(holeTarget.id, hole);
            }}
          />
        ) : null}

        {dialog === "ai" ? (
          <AiImportDialog adapters={adapters} onCancel={() => setDialog(null)} onImport={handleAiImport} />
        ) : null}
      </div>
    </WorkspaceContext.Provider>
  );
}
