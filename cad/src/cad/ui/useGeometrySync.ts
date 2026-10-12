import { useEffect, useRef } from "react";
import type { CADGeometryEngine } from "../engine/geometryEngine";
import { featureKey } from "../engine/recipeKey";
import type { CADRenderer } from "../render/renderer";
import { useProjectStore } from "../core/projectStore";
import type { CadDocument } from "../core/types";

/**
 * Keeps the rendered scene in step with the document.
 *
 * Division of labour:
 *  - the kernel rebuilds a solid only when its FEATURE changes;
 *  - moving/rotating/regrouping is pure three.js and never touches the kernel;
 *  - a kernel failure is recorded against that one object and the rest of the
 *    scene keeps working.
 */
export function useGeometrySync(
  renderer: CADRenderer | null,
  engine: CADGeometryEngine,
  kernelReady: boolean,
  doc: CadDocument,
) {
  const tokens = useRef(new Map<string, string>());
  const generation = useRef(0);

  useEffect(() => {
    if (!renderer) return;
    renderer.syncScene(doc);
  }, [renderer, doc]);

  useEffect(() => {
    if (!renderer || !kernelReady) return;
    const store = useProjectStore.getState();
    const myGeneration = ++generation.current;
    let cancelled = false;

    const live = new Set(Object.keys(doc.objects));
    for (const id of [...tokens.current.keys()]) {
      if (!live.has(id)) tokens.current.delete(id);
    }

    const pending: Promise<void>[] = [];

    for (const object of Object.values(doc.objects)) {
      if (object.kind === "mesh") {
        const asset = doc.assets[object.assetId];
        if (asset) renderer.setMeshGeometry(object.id, asset);
        continue;
      }
      if (object.kind !== "solid") continue;

      const token = `${featureKey(object.feature)}@${engine.tolerance}`;
      if (tokens.current.get(object.id) === token) continue;
      tokens.current.set(object.id, token);

      store.setBusy(1);
      const job = engine
        .tessellate(object.feature)
        .then((result) => {
          if (cancelled || generation.current !== myGeneration) return;
          renderer.setSolidGeometry(object.id, result, token);
          useProjectStore.getState().setGeometry(object.id, {
            volume: result.volume,
            area: result.area,
            triangleCount: result.triangleCount,
            bbox: result.bbox,
          });
          useProjectStore.getState().setBuildError(object.id, null);
        })
        .catch((err: Error) => {
          // Retry on the next edit rather than caching a failed build.
          tokens.current.delete(object.id);
          if (cancelled) return;
          useProjectStore.getState().setBuildError(object.id, err.message);
          useProjectStore.getState().setStatus("error", `${object.name}: ${err.message}`);
        })
        .finally(() => {
          useProjectStore.getState().setBusy(-1);
        });
      pending.push(job);
    }

    void Promise.allSettled(pending);
    return () => {
      cancelled = true;
    };
  }, [renderer, engine, kernelReady, doc]);
}
