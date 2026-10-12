import { useMemo, useState } from "react";
import { useProjectStore } from "../core/projectStore";
import {
  applyEdgeTreatment, featureAt, featureChildren, removeLastFeature, replaceFeatureAt,
  setFeature as setFeatureOp, setTransform, setMeshScale, renameObject, setColor,
} from "../core/objectManager";
import type { CadObject, Feature, SolidObject, Vec3 } from "../core/types";
import { capsOf } from "../core/types";
import { formatArea, formatLength, formatVolume } from "../core/units";
import { NumberField } from "./NumberField";
import { TextField } from "./TextField";
import { FeatureEditor } from "./FeatureEditor";
import { PALETTE } from "../core/factories";

const FEATURE_LABEL: Record<Feature["type"], string> = {
  box: "Box", cylinder: "Cylinder", sphere: "Sphere", cone: "Cone",
  extrude: "Extrude", revolve: "Revolve", boolean: "Boolean",
  hole: "Hole", fillet: "Fillet", chamfer: "Chamfer", "imported-step": "Imported solid",
};

export function PropertiesPanel() {
  const doc = useProjectStore((s) => s.doc);
  const selection = useProjectStore((s) => s.selection);
  const featurePath = useProjectStore((s) => s.featurePath);
  const geometry = useProjectStore((s) => s.geometry);
  const buildErrors = useProjectStore((s) => s.buildErrors);
  const commit = useProjectStore((s) => s.commit);
  const setFeaturePath = useProjectStore((s) => s.setFeaturePath);
  const unit = doc.displayUnit;
  const [edgeSize, setEdgeSize] = useState(3);

  const object = selection.length === 1 ? doc.objects[selection[0]] : null;

  if (selection.length === 0) {
    return (
      <aside className="panel panel--right">
        <header className="panel__header">Properties</header>
        <div className="panel__empty">
          Select an object in the viewport or the tree to edit its name, dimensions and placement.
        </div>
      </aside>
    );
  }

  if (!object) {
    return (
      <aside className="panel panel--right">
        <header className="panel__header">Properties</header>
        <div className="panel__empty">
          {selection.length} objects selected. Move or rotate them together with the gizmo, or select a
          single object to edit its dimensions.
        </div>
      </aside>
    );
  }

  const caps = capsOf(object);
  const stats = geometry[object.id];
  const buildError = buildErrors[object.id];

  return (
    <aside className="panel panel--right">
      <header className="panel__header">
        Properties
        <span className={`badge badge--${object.kind}`}>
          {object.kind === "solid" ? "CAD solid (B-rep)" : object.kind === "mesh" ? "Mesh (non-parametric)" : "Group"}
        </span>
      </header>

      <div className="panel__scroll">
        {buildError ? <div className="alert alert--error">Geometry build failed: {buildError}</div> : null}

        <Section title="Identity">
          <TextField
            label="Name"
            value={object.name}
            onCommit={(value) => commit("Rename object", (draft) => renameObject(draft, object.id, value))}
          />
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch${object.color === c ? " swatch--active" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => commit("Change colour", (draft) => setColor(draft, object.id, c))}
              />
            ))}
          </div>
        </Section>

        {object.kind === "solid" ? (
          <SolidDimensions object={object} featurePath={featurePath} onPickPath={setFeaturePath} />
        ) : null}

        {object.kind === "mesh" ? (
          <Section title="Size (mesh scale)">
            <p className="hint hint--warn">
              This is an imported triangle mesh. Scaling multiplies vertex coordinates — it is not a
              parametric dimension change, and it cannot be expressed as a CAD feature.
            </p>
            <div className="grid3">
              {(["X", "Y", "Z"] as const).map((axis, i) => (
                <NumberField
                  key={axis}
                  label={`Scale ${axis}`}
                  value={object.scale[i]}
                  step={0.1}
                  min={1e-4}
                  onCommit={(v) => commit("Scale mesh", (draft) => {
                    const next = [...object.scale] as Vec3;
                    next[i] = v;
                    setMeshScale(draft, object.id, next);
                  })}
                />
              ))}
            </div>
          </Section>
        ) : null}

        <Section title="Placement">
          <div className="grid3">
            {(["X", "Y", "Z"] as const).map((axis, i) => (
              <NumberField
                key={`p${axis}`}
                label={`Position ${axis}`}
                value={object.transform.position[i]}
                unit={unit}
                onCommit={(v) => commit("Move object", (draft) => {
                  const position = [...object.transform.position] as Vec3;
                  position[i] = v;
                  setTransform(draft, object.id, { ...object.transform, position });
                })}
              />
            ))}
          </div>
          <div className="grid3">
            {(["X", "Y", "Z"] as const).map((axis, i) => (
              <NumberField
                key={`r${axis}`}
                label={`Rotation ${axis}`}
                value={object.transform.rotation[i]}
                suffix="°"
                step={15}
                onCommit={(v) => commit("Rotate object", (draft) => {
                  const rotation = [...object.transform.rotation] as Vec3;
                  rotation[i] = v;
                  setTransform(draft, object.id, { ...object.transform, rotation });
                })}
              />
            ))}
          </div>
        </Section>

        {caps.booleans && object.kind === "solid" ? (
          <Section title="Edge treatment">
            <div className="row">
              <NumberField label="Size" value={edgeSize} unit={unit} min={1e-4} onCommit={setEdgeSize} />
              <button
                type="button"
                className="btn"
                onClick={() => commit("Fillet edges", (draft) => applyEdgeTreatment(draft, object.id, "fillet", edgeSize), {
                  log: `fillet r=${edgeSize}mm`, ids: [object.id],
                })}
              >
                Fillet all edges
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => commit("Chamfer edges", (draft) => applyEdgeTreatment(draft, object.id, "chamfer", edgeSize), {
                  log: `chamfer ${edgeSize}mm`, ids: [object.id],
                })}
              >
                Chamfer all edges
              </button>
            </div>
            {["fillet", "chamfer", "hole"].includes(object.feature.type) ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => commit("Remove last feature", (draft) => {
                  removeLastFeature(draft, object.id);
                })}
              >
                Remove last feature ({FEATURE_LABEL[object.feature.type]})
              </button>
            ) : null}
          </Section>
        ) : null}

        <Section title="Measurements">
          {object.kind === "solid" && stats ? (
            <dl className="stats">
              <div><dt>Volume</dt><dd>{formatVolume(stats.volume, unit)}</dd></div>
              <div><dt>Surface area</dt><dd>{formatArea(stats.area, unit)}</dd></div>
              <div><dt>Bounding box</dt><dd>{bboxText(stats.bbox, unit)}</dd></div>
              <div><dt>Display triangles</dt><dd>{stats.triangleCount.toLocaleString()}</dd></div>
            </dl>
          ) : null}
          {object.kind === "mesh" ? <MeshStats object={object} /> : null}
          {object.kind === "group" ? <p className="hint">Groups carry placement only.</p> : null}
        </Section>
      </div>
    </aside>
  );
}

function bboxText(bbox: { min: Vec3; max: Vec3 }, unit: Parameters<typeof formatLength>[1]): string {
  const size: Vec3 = [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]];
  return size.map((v) => formatLength(v, unit).replace(` ${unit}`, "")).join(" × ") + ` ${unit}`;
}

function MeshStats({ object }: { object: Extract<CadObject, { kind: "mesh" }> }) {
  const doc = useProjectStore((s) => s.doc);
  const unit = doc.displayUnit;
  const asset = doc.assets[object.assetId];
  const analysis = useMemo(() => (asset ? analyseMesh(asset.positions, asset.indices) : null), [asset]);
  if (!asset || !analysis) return <p className="hint">Mesh data is missing.</p>;
  return (
    <dl className="stats">
      <div><dt>Triangles</dt><dd>{asset.triangleCount.toLocaleString()}</dd></div>
      <div><dt>Vertices</dt><dd>{(asset.positions.length / 3).toLocaleString()}</dd></div>
      <div><dt>Bounding box</dt><dd>{bboxText(analysis.bbox, unit)}</dd></div>
      <div><dt>Surface area</dt><dd>{formatArea(analysis.area, unit)}</dd></div>
      <div><dt>Volume (closed-surface estimate)</dt><dd>{formatVolume(Math.abs(analysis.volume), unit)}</dd></div>
      <div><dt>Watertight</dt><dd>{analysis.watertight ? "likely (no boundary edges)" : "no — open edges found"}</dd></div>
      <div><dt>Source</dt><dd>{object.provenance?.source ?? object.origin}</dd></div>
    </dl>
  );
}

/** Divergence-theorem volume + edge-manifold check over the raw triangle soup. */
function analyseMesh(positions: Float32Array, indices?: Uint32Array) {
  const triCount = indices ? indices.length / 3 : positions.length / 9;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  let volume = 0;
  let area = 0;
  const edges = new Map<string, number>();
  const idx = (t: number, c: number) => (indices ? indices[t * 3 + c] : t * 3 + c);
  for (let t = 0; t < triCount; t += 1) {
    const a = idx(t, 0), b = idx(t, 1), c = idx(t, 2);
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (triCount <= 400000) {
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        const key = p < q ? `${p}_${q}` : `${q}_${p}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
  }
  let watertight = triCount <= 400000;
  if (watertight) {
    for (const count of edges.values()) {
      if (count !== 2) {
        watertight = false;
        break;
      }
    }
  }
  return { bbox: { min, max }, volume, area, watertight };
}

function SolidDimensions({
  object, featurePath, onPickPath,
}: { object: SolidObject; featurePath: number[]; onPickPath: (p: number[]) => void }) {
  const commit = useProjectStore((s) => s.commit);
  const unit = useProjectStore((s) => s.doc.displayUnit);
  const active = featureAt(object.feature, featurePath) ?? object.feature;
  const activePath = featureAt(object.feature, featurePath) ? featurePath : [];
  const hasTree = featureChildren(object.feature).length > 0;

  return (
    <Section title="Dimensions (parametric)">
      {hasTree ? (
        <div className="tree tree--feature">
          <FeatureNode
            feature={object.feature}
            path={[]}
            activePath={activePath}
            onPick={onPickPath}
          />
        </div>
      ) : null}
      <FeatureEditor
        feature={active}
        unit={unit}
        onChange={(next) => commit("Edit dimensions", (draft) => {
          const updated = replaceFeatureAt(object.feature, activePath, next);
          setFeatureOp(draft, object.id, updated);
        }, { log: `edit ${active.type}`, ids: [object.id] })}
      />
    </Section>
  );
}

function FeatureNode({
  feature, path, activePath, onPick,
}: { feature: Feature; path: number[]; activePath: number[]; onPick: (p: number[]) => void }) {
  const children = featureChildren(feature);
  const isActive = path.length === activePath.length && path.every((v, i) => activePath[i] === v);
  return (
    <div className="tree__node" style={{ marginLeft: path.length ? 12 : 0 }}>
      <button type="button" className={`tree__row${isActive ? " tree__row--active" : ""}`} onClick={() => onPick(path)}>
        <span className="tree__icon">{children.length ? "▾" : "•"}</span>
        <span className="tree__name">
          {FEATURE_LABEL[feature.type]}
          {feature.type === "boolean" ? ` (${feature.op})` : ""}
          {feature.type === "hole" ? ` ×${feature.holes.length}` : ""}
        </span>
      </button>
      {children.map((child, index) => (
        <FeatureNode
          key={`${path.join("-")}-${index}`}
          feature={child.feature}
          path={[...path, index]}
          activePath={activePath}
          onPick={onPick}
        />
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h3 className="section__title">{title}</h3>
      {children}
    </section>
  );
}
