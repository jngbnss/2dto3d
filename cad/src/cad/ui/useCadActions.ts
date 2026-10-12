import { useCallback } from "react";
import { useProjectStore } from "../core/projectStore";
import {
  addHoles, addObject, booleanCombine, descendantsOf, duplicateObjects,
  groupObjects, isEffectivelyVisible, planBoolean, removeObjects, solidRecipeInWorld, topLevelOf, ungroup,
} from "../core/objectManager";
import { createMesh, createSolid, DEFAULT_PRIMITIVES, PRIMITIVE_LABEL } from "../core/factories";
import type { BooleanOp, CadDocument, Feature, HoleSpec, MeshAsset, PrimitiveType, SolidObject } from "../core/types";
import {
  downloadBlob, exportProjectBlob, exportSceneGLB, exportSceneSTL, importGLTF, importSTL,
  pickFile, projectFromFile, sanitizeFilename,
} from "../file/fileManager";
import type { CADGeometryEngine } from "../engine/geometryEngine";
import type { CADRenderer } from "../render/renderer";

/** Where a new object lands so it does not sit inside the previous one. */
function spawnPosition(doc: CadDocument): [number, number, number] {
  const count = Object.values(doc.objects).filter((o) => o.kind !== "group").length;
  const ring = Math.floor(count / 6);
  const angle = (count % 6) * (Math.PI / 3);
  return [Math.cos(angle) * 80 * (ring + 1), Math.sin(angle) * 80 * (ring + 1), 30];
}

export function useCadActions(renderer: CADRenderer | null, engine: CADGeometryEngine) {
  const commit = useProjectStore((s) => s.commit);
  const select = useProjectStore((s) => s.select);
  const setStatus = useProjectStore((s) => s.setStatus);

  const addPrimitive = useCallback((type: PrimitiveType) => {
    const doc = useProjectStore.getState().doc;
    const object = createSolid(structuredClone(DEFAULT_PRIMITIVES[type]), {
      name: PRIMITIVE_LABEL[type],
      position: spawnPosition(doc),
    });
    commit(`Create ${PRIMITIVE_LABEL[type]}`, (draft) => {
      addObject(draft, object);
    }, { log: `create ${type}`, ids: [object.id] });
    select([object.id]);
    setStatus("success", `${PRIMITIVE_LABEL[type]} created — edit its dimensions on the right`);
  }, [commit, select, setStatus]);

  const addFeatureSolid = useCallback((feature: Feature, name: string) => {
    const doc = useProjectStore.getState().doc;
    const object = createSolid(feature, { name, position: spawnPosition(doc) });
    commit(`Create ${name}`, (draft) => {
      addObject(draft, object);
    }, { log: `create ${feature.type}`, ids: [object.id] });
    select([object.id]);
  }, [commit, select]);

  /**
   * Boolean operations are validated in the kernel BEFORE the operands are
   * consumed, so a failed cut leaves the document exactly as it was.
   */
  const runBoolean = useCallback(async (op: BooleanOp) => {
    const state = useProjectStore.getState();
    const { doc, selection } = state;
    const solids = selection.map((id) => doc.objects[id]).filter((o): o is SolidObject => o?.kind === "solid");
    if (solids.length < 2) {
      setStatus("warn", "Select at least two CAD solids (meshes cannot take part in boolean operations)");
      return;
    }
    const plan = planBoolean(doc, op, selection);
    if (!plan) {
      setStatus("warn", "Boolean needs at least two CAD solids");
      return;
    }
    state.setBusy(1);
    setStatus("info", `Running boolean ${op}…`);
    try {
      const measure = await engine.measure(plan.feature);
      if (!(measure.volume > 0)) throw new Error("the result is empty");
      let resultId: string | null = null;
      commit(`Boolean ${op}`, (draft) => {
        const result = booleanCombine(draft, op, selection);
        if (!result) throw new Error("Boolean failed");
        resultId = result.id;
      }, { log: `boolean ${op} over ${solids.length} bodies`, ids: selection });
      // Selection must be set AFTER the commit: `select` validates ids against
      // the committed document, and the result does not exist until then.
      if (resultId) select([resultId]);
      setStatus("success", `Boolean ${op} complete`);
    } catch (err) {
      setStatus("error", `Boolean ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      useProjectStore.getState().setBusy(-1);
    }
  }, [commit, engine, select, setStatus]);

  const applyHole = useCallback(async (targetId: string, hole: HoleSpec) => {
    const state = useProjectStore.getState();
    const object = state.doc.objects[targetId];
    if (object?.kind !== "solid") {
      setStatus("warn", "Select a CAD solid to cut a hole in");
      return;
    }
    const probe: Feature = object.feature.type === "hole"
      ? { ...object.feature, holes: [...object.feature.holes, hole] }
      : { type: "hole", base: { feature: object.feature, transform: { position: [0, 0, 0], rotation: [0, 0, 0] } }, holes: [hole] };
    state.setBusy(1);
    try {
      await engine.measure(probe);
      commit("Cut hole", (draft) => addHoles(draft, targetId, [hole]), {
        log: `hole Ø${hole.diameter}mm`, ids: [targetId],
      });
      setStatus("success", `Hole Ø${hole.diameter} mm cut in ${object.name}`);
    } catch (err) {
      setStatus("error", `Hole failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      useProjectStore.getState().setBusy(-1);
    }
  }, [commit, engine, setStatus]);

  const deleteSelection = useCallback(() => {
    const ids = [...useProjectStore.getState().selection];
    if (!ids.length) return;
    commit("Delete objects", (draft) => removeObjects(draft, ids), { log: `delete ${ids.length}`, ids });
    select([]);
  }, [commit, select]);

  const duplicateSelection = useCallback(() => {
    const { doc, selection } = useProjectStore.getState();
    if (!selection.length) return;
    const ids = topLevelOf(doc, selection).map((o) => o.id);
    let created: string[] = [];
    commit("Duplicate", (draft) => {
      created = duplicateObjects(draft, ids, [20, 0, 0]);
    }, { log: `duplicate ${ids.length}`, ids });
    if (created.length) select(created);
  }, [commit, select]);

  const groupSelection = useCallback(() => {
    const selection = useProjectStore.getState().selection;
    if (!selection.length) return;
    let groupId: string | null = null;
    commit("Group objects", (draft) => {
      const group = groupObjects(draft, selection);
      if (!group) throw new Error("Nothing to group");
      groupId = group.id;
    }, { log: `group ${selection.length}`, ids: selection });
    if (groupId) select([groupId]);
  }, [commit, select]);

  const ungroupSelection = useCallback(() => {
    const { doc, selection } = useProjectStore.getState();
    const groups = selection.filter((id) => doc.objects[id]?.kind === "group");
    if (!groups.length) {
      setStatus("warn", "Select a group first");
      return;
    }
    commit("Ungroup", (draft) => {
      for (const id of groups) ungroup(draft, id);
    }, { log: `ungroup ${groups.length}`, ids: groups });
  }, [commit, select, setStatus]);

  /* ----------------------------------------------------------------- files */

  const addMeshObjects = useCallback((
    meshes: { name: string; asset: MeshAsset }[],
    origin: "import-stl" | "import-glb" | "ai-generated",
    provenance?: { source: string; note?: string },
  ) => {
    const ids: string[] = [];
    commit(`Import ${meshes.length} mesh${meshes.length > 1 ? "es" : ""}`, (draft) => {
      // A multi-mesh glTF keeps its internal layout: only the first object is
      // offset onto a free spot, the rest stay relative to it.
      const anchor = spawnPosition(draft);
      for (const m of meshes) {
        draft.assets[m.asset.id] = m.asset;
        const object = createMesh(m.asset.id, { name: m.name, origin, position: anchor, provenance });
        addObject(draft, object);
        ids.push(object.id);
      }
    }, { log: `import ${origin}`, ids: [] });
    select(ids);
    return ids;
  }, [commit, select]);

  const importMeshFile = useCallback(async () => {
    const files = await pickFile(".stl,.glb,.gltf", true);
    if (!files.length) return;
    for (const file of files) {
      try {
        const lower = file.name.toLowerCase();
        if (lower.endsWith(".stl")) {
          const mesh = await importSTL(file, file.name.replace(/\.stl$/i, ""));
          addMeshObjects([mesh], "import-stl", { source: file.name });
          setStatus("success", `${file.name} imported (${mesh.asset.triangleCount.toLocaleString()} triangles, mesh — not a CAD solid)`);
        } else if (lower.endsWith(".glb") || lower.endsWith(".gltf")) {
          const meshes = await importGLTF(file, file.name.replace(/\.(glb|gltf)$/i, ""));
          addMeshObjects(meshes, "import-glb", { source: file.name });
          setStatus("success", `${file.name} imported as ${meshes.length} mesh object(s) — not CAD solids`);
        } else {
          setStatus("warn", `${file.name}: unsupported format`);
        }
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
      }
    }
  }, [addMeshObjects, setStatus]);

  const importStepFile = useCallback(async () => {
    const files = await pickFile(".step,.stp", false);
    if (!files.length) return;
    const file = files[0];
    try {
      setStatus("info", `Reading ${file.name}…`);
      useProjectStore.getState().setBusy(1);
      const text = await file.text();
      const { assetId } = await engine.importSTEP(text);
      const doc = useProjectStore.getState().doc;
      const object = createSolid({ type: "imported-step", assetId }, {
        name: file.name.replace(/\.(step|stp)$/i, ""),
        position: spawnPosition(doc),
      });
      commit("Import STEP", (draft) => {
        addObject(draft, object);
      }, { log: `import step ${file.name}`, ids: [object.id] });
      select([object.id]);
      setStatus("success", `${file.name} imported as a B-rep CAD solid`);
    } catch (err) {
      setStatus("error", `STEP import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      useProjectStore.getState().setBusy(-1);
    }
  }, [commit, engine, select, setStatus]);

  /** Objects to export: the selection when there is one, otherwise everything visible. */
  const exportScope = useCallback(() => {
    const { doc, selection } = useProjectStore.getState();
    const ids = selection.length
      ? [...new Set(selection.flatMap((id) => [id, ...descendantsOf(doc, id)]))]
      : Object.keys(doc.objects).filter((id) => isEffectivelyVisible(doc, id));
    return ids.map((id) => doc.objects[id]).filter(Boolean);
  }, []);

  const exportSTL = useCallback(async () => {
    const { doc } = useProjectStore.getState();
    const objects = exportScope();
    const geometryObjects = objects.filter((o) => o.kind !== "group");
    if (!geometryObjects.length) {
      setStatus("warn", "Nothing to export");
      return;
    }
    try {
      const allSolids = geometryObjects.every((o) => o.kind === "solid");
      if (allSolids) {
        // Straight from the B-rep at export quality, finer than the viewport mesh.
        useProjectStore.getState().setBusy(1);
        const items = (geometryObjects as SolidObject[]).map((o) => ({
          recipe: solidRecipeInWorld(doc, o),
          name: o.name,
        }));
        const buffer = await engine.exportSTL(items, 0.02);
        downloadBlob(new Blob([buffer], { type: "model/stl" }), sanitizeFilename(doc.name, "stl"));
        setStatus("success", `STL exported from the CAD kernel (${items.length} solid(s), 0.02 mm tolerance)`);
      } else {
        const nodes = geometryObjects.map((o) => renderer?.getNode(o.id)).filter(Boolean) as NonNullable<ReturnType<CADRenderer["getNode"]>>[];
        const blob = exportSceneSTL(nodes, true);
        downloadBlob(blob, sanitizeFilename(doc.name, "stl"));
        setStatus("success", `STL exported from display meshes (${geometryObjects.length} object(s))`);
      }
    } catch (err) {
      setStatus("error", `STL export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      useProjectStore.getState().setBusy(-1);
    }
  }, [engine, exportScope, renderer, setStatus]);

  const exportGLB = useCallback(async () => {
    const doc = useProjectStore.getState().doc;
    const objects = exportScope().filter((o) => o.kind !== "group");
    const nodes = objects.map((o) => renderer?.getNode(o.id)).filter(Boolean) as NonNullable<ReturnType<CADRenderer["getNode"]>>[];
    if (!nodes.length) {
      setStatus("warn", "Nothing to export");
      return;
    }
    try {
      const blob = await exportSceneGLB(nodes);
      downloadBlob(blob, sanitizeFilename(doc.name, "glb"));
      setStatus("success", `GLB exported (${nodes.length} object(s))`);
    } catch (err) {
      setStatus("error", `GLB export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [exportScope, renderer, setStatus]);

  const exportSTEP = useCallback(async () => {
    const doc = useProjectStore.getState().doc;
    const objects = exportScope().filter((o) => o.kind !== "group");
    const solids = objects.filter((o): o is SolidObject => o.kind === "solid");
    const meshes = objects.filter((o) => o.kind === "mesh");
    if (!solids.length) {
      setStatus("error", "STEP export needs CAD solids. Triangle meshes cannot be written as STEP — that file would not open as a solid in any CAD system.");
      return;
    }
    try {
      useProjectStore.getState().setBusy(1);
      const text = await engine.exportSTEP(solids.map((o) => ({ recipe: solidRecipeInWorld(doc, o), name: o.name })));
      downloadBlob(new Blob([text], { type: "application/step" }), sanitizeFilename(doc.name, "step"));
      setStatus(
        meshes.length ? "warn" : "success",
        meshes.length
          ? `STEP exported with ${solids.length} solid(s). ${meshes.length} mesh object(s) were skipped — meshes have no B-rep to write.`
          : `STEP exported with ${solids.length} solid(s)`,
      );
    } catch (err) {
      setStatus("error", `STEP export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      useProjectStore.getState().setBusy(-1);
    }
  }, [engine, exportScope, setStatus]);

  const saveProject = useCallback(() => {
    const doc = useProjectStore.getState().doc;
    try {
      downloadBlob(exportProjectBlob(doc), sanitizeFilename(doc.name, "wcad.json"));
      useProjectStore.getState().markSaved();
      setStatus("success", `Project saved (${Object.keys(doc.objects).length} objects, ${doc.operationLog.length} logged operations)`);
    } catch (err) {
      setStatus("error", `Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [setStatus]);

  const openProject = useCallback(async () => {
    const files = await pickFile(".json,.wcad", false);
    if (!files.length) return;
    try {
      const text = await files[0].text();
      const doc = projectFromFile(text);
      useProjectStore.getState().replaceDocument(doc, `Opened "${doc.name}"`);
      setTimeout(() => renderer?.fit(), 300);
    } catch (err) {
      setStatus("error", `Could not open the project: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [renderer, setStatus]);

  const newProject = useCallback(() => {
    useProjectStore.getState().newProject();
  }, []);

  return {
    addPrimitive, addFeatureSolid, runBoolean, applyHole,
    deleteSelection, duplicateSelection, groupSelection, ungroupSelection,
    addMeshObjects, importMeshFile, importStepFile,
    exportSTL, exportGLB, exportSTEP,
    saveProject, openProject, newProject,
    fit: () => renderer?.fit(useProjectStore.getState().selection),
  };
}

export type CadActions = ReturnType<typeof useCadActions>;