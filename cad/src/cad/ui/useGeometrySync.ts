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
 *
 * Staleness is decided by the token, not by effect generation. A tessellation is
 * a pure function of its feature, so a result is applied whenever it still
 * matches the object's current token — even if several document edits landed
 * while it was in flight. Cancelling on every edit instead would drop results
 * whose token was already recorded, and the solid would never rebuild.
 */
export function useGeometrySync(
  renderer: CADRenderer | null,
  engine: CADGeometryEngine,
  kernelReady: boolean,
  doc: CadDocument,
) {
  /** objectId -> token of the build that is current (done or in flight). */
  const tokens = useRef(new Map<string, string>());
  const unmounted = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  useEffect(() => {
    if (!renderer) return;
    renderer.syncScene(doc);
  }, [renderer, doc]);

  useEffect(() => {
    if (!renderer || !kernelReady) return;

    const live = new Set(Object.keys(doc.objects));
    for (const id of [...tokens.current.keys()]) {
      if (!live.has(id)) tokens.current.delete(id);
    }

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

      const objectId = object.id;
      const objectName = object.name;
      useProjectStore.getState().setBusy(1);
      engine
        .tessellate(object.feature)
        .then((result) => {
          // A newer edit has superseded this build, or the editor is gone.
          if (unmounted.current || tokens.current.get(objectId) !== token) return;
          if (!useProjectStore.getState().doc.objects[objectId]) return;
          renderer.setSolidGeometry(objectId, result, token);
          useProjectStore.getState().setGeometry(objectId, {
            volume: result.volume,
            area: result.area,
            triangleCount: result.triangleCount,
            bbox: result.bbox,
          });
          useProjectStore.getState().setBuildError(objectId, null);
        })
        .catch((err: Error) => {
          // Forget the token so the next edit retries instead of caching a failure.
          if (tokens.current.get(objectId) === token) tokens.current.delete(objectId);
          if (unmounted.current) return;
          useProjectStore.getState().setBuildError(objectId, err.message);
          useProjectStore.getState().setStatus("error", `${objectName}: ${err.message}`);
        })
        .finally(() => {
          useProjectStore.getState().setBusy(-1);
        });
    }
  }, [renderer, engine, kernelReady, doc]);
}
