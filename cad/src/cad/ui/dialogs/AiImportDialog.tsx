import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import {
  classifyAsset, resolveAssetBytes,
  type AiModelDescriptor, type AiPipelineAdapter, type AssetClassification,
} from "../../ai/aiAdapter";

export interface AiImportResult {
  descriptor: AiModelDescriptor;
  classification: AssetClassification;
  payload: ArrayBuffer | string;
}

/**
 * Browser for 2D→3D generation results.
 *
 * The guard that matters: an entry that only has orthographic preview renders is
 * shown as NOT importable, with the reason spelled out. Six images are six
 * images — they are not a model, and pretending otherwise would put an empty
 * object in the user's assembly.
 */
export function AiImportDialog({
  adapters, onCancel, onImport,
}: {
  adapters: AiPipelineAdapter[];
  onCancel: () => void;
  onImport: (result: AiImportResult) => void;
}) {
  const [adapterId, setAdapterId] = useState(adapters[0]?.id ?? "");
  const [items, setItems] = useState<AiModelDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const adapter = adapters.find((a) => a.id === adapterId) ?? adapters[0];

  useEffect(() => {
    let cancelled = false;
    if (!adapter) return undefined;
    setLoading(true);
    setError(null);
    adapter
      .list()
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setSelectedId(list[0]?.id ?? null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const classification = selected ? classifyAsset(selected) : null;
  const importable = classification?.editable !== "none" && classification != null;

  const doImport = async () => {
    if (!selected || !selected.asset || !classification || !importable) return;
    setLoading(true);
    setError(null);
    try {
      const payload = await resolveAssetBytes(selected.asset);
      onImport({ descriptor: selected, classification, payload });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Import an AI 2D→3D result"
      width={760}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn--primary" disabled={!importable || loading} onClick={doImport}>
            {loading ? "Working…" : "Import into workspace"}
          </button>
        </>
      }
    >
      {adapters.length > 1 ? (
        <label className="field">
          <span className="field__label">Source</span>
          <span className="field__input">
            <select value={adapterId} onChange={(e) => setAdapterId(e.target.value)}>
              {adapters.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </span>
        </label>
      ) : null}
      <p className="hint">{adapter?.description}</p>
      {error ? <div className="alert alert--error">{error}</div> : null}

      <div className="ai-grid">
        <ul className="ai-list">
          {items.length === 0 && !loading ? <li className="ai-list__empty">No results available.</li> : null}
          {items.map((item) => {
            const c = classifyAsset(item);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`ai-list__item${selectedId === item.id ? " ai-list__item--active" : ""}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="ai-list__name">{item.name}</span>
                  <span className={`badge badge--${c.kind}`}>{badgeLabel(c)}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="ai-detail">
          {selected && classification ? (
            <>
              <h4>{selected.name}</h4>
              <div className={`alert alert--${classification.editable === "none" ? "error" : classification.editable === "mesh-only" ? "warn" : "ok"}`}>
                <strong>{badgeLabel(classification)}</strong>
                <div>{classification.reason}</div>
              </div>
              {selected.orthoViews && Object.keys(selected.orthoViews).length > 0 ? (
                <>
                  <h5>Preview renders ({Object.keys(selected.orthoViews).length})</h5>
                  <div className="ai-thumbs">
                    {Object.entries(selected.orthoViews).map(([view, src]) => (
                      <figure key={view}>
                        <img src={src} alt={view} />
                        <figcaption>{view}</figcaption>
                      </figure>
                    ))}
                  </div>
                  <p className="hint hint--warn">
                    Preview renders are images. They are never converted into geometry.
                  </p>
                </>
              ) : null}
              {selected.meta ? (
                <dl className="stats">
                  {Object.entries(selected.meta).map(([k, v]) => (
                    <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>
                  ))}
                </dl>
              ) : null}
              <h5>What you will be able to do</h5>
              <ul className="caps">
                <li className={classification.editable !== "none" ? "caps--yes" : "caps--no"}>Move / rotate / select / delete</li>
                <li className={classification.editable !== "none" ? "caps--yes" : "caps--no"}>STL and GLB export</li>
                <li className={classification.editable === "mesh-only" ? "caps--yes" : classification.editable === "parametric" ? "caps--yes" : "caps--no"}>Mesh analysis (triangles, volume, watertightness)</li>
                <li className={classification.editable === "parametric" ? "caps--yes" : "caps--no"}>Boolean operations, holes, STEP export</li>
                <li className={classification.editable === "parametric" ? "caps--yes" : "caps--no"}>Dimension-driven parametric editing</li>
              </ul>
            </>
          ) : (
            <p className="hint">Select a result to inspect what it actually contains.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function badgeLabel(c: AssetClassification): string {
  if (c.kind === "solid") return "CAD solid";
  if (c.kind === "mesh") return "Mesh only";
  if (c.kind === "images-only") return "Images only — not importable";
  return "No geometry";
}
