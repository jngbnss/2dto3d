import { useState } from "react";
import { useProjectStore } from "../core/projectStore";
import { UNIT_NAMES } from "../core/units";
import type { PrimitiveType, UnitName } from "../core/types";
import type { CadActions } from "./useCadActions";

const PRIMITIVES: { type: PrimitiveType; label: string; glyph: string }[] = [
  { type: "box", label: "Box", glyph: "▭" },
  { type: "cylinder", label: "Cylinder", glyph: "⬭" },
  { type: "sphere", label: "Sphere", glyph: "◯" },
  { type: "cone", label: "Cone", glyph: "△" },
];

export function Toolbar({
  actions, onExtrude, onHole, onAiImport,
}: {
  actions: CadActions;
  onExtrude: () => void;
  onHole: () => void;
  onAiImport: () => void;
}) {
  const doc = useProjectStore((s) => s.doc);
  const canUndo = useProjectStore((s) => s.canUndo);
  const canRedo = useProjectStore((s) => s.canRedo);
  const undoLabel = useProjectStore((s) => s.undoLabel);
  const redoLabel = useProjectStore((s) => s.redoLabel);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const selection = useProjectStore((s) => s.selection);
  const setDisplayUnit = useProjectStore((s) => s.setDisplayUnit);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const [menu, setMenu] = useState<string | null>(null);

  const solidSelection = selection.filter((id) => doc.objects[id]?.kind === "solid");

  const toggle = (name: string) => setMenu((current) => (current === name ? null : name));
  const run = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  return (
    <header className="toolbar" onMouseLeave={() => setMenu(null)}>
      <div className="toolbar__brand">
        <span className="toolbar__logo">⬢</span>
        <input
          className="toolbar__name"
          value={doc.name}
          onChange={(e) => setProjectName(e.target.value)}
          title="Project name"
        />
      </div>

      <div className="toolbar__group">
        <button type="button" className="btn" onClick={run(actions.newProject)}>New</button>
        <button type="button" className="btn" onClick={run(actions.openProject)}>Open</button>
        <button type="button" className="btn" onClick={run(actions.saveProject)}>Save</button>
      </div>

      <div className="toolbar__group">
        <button type="button" className="btn" disabled={!canUndo} title={undoLabel ? `Undo: ${undoLabel}` : "Nothing to undo"} onClick={undo}>↶ Undo</button>
        <button type="button" className="btn" disabled={!canRedo} title={redoLabel ? `Redo: ${redoLabel}` : "Nothing to redo"} onClick={redo}>↷ Redo</button>
      </div>

      <div className="toolbar__group">
        {PRIMITIVES.map((p) => (
          <button key={p.type} type="button" className="btn btn--primitive" title={`Create ${p.label}`}
            onClick={run(() => actions.addPrimitive(p.type))}>
            <span className="btn__glyph">{p.glyph}</span>{p.label}
          </button>
        ))}
        <button type="button" className="btn btn--primitive" title="Extrude a 2D sketch into a solid" onClick={run(onExtrude)}>
          <span className="btn__glyph">⇪</span>Extrude
        </button>
      </div>

      <div className="toolbar__group">
        <Dropdown
          name="cad" label="CAD operations" open={menu === "cad"} onToggle={() => toggle("cad")}
          items={[
            { label: `Union (${solidSelection.length} selected)`, disabled: solidSelection.length < 2, onClick: run(() => actions.runBoolean("union")) },
            { label: "Cut (first minus the rest)", disabled: solidSelection.length < 2, onClick: run(() => actions.runBoolean("cut")) },
            { label: "Intersection", disabled: solidSelection.length < 2, onClick: run(() => actions.runBoolean("intersect")) },
            { separator: true },
            { label: "Hole…", disabled: solidSelection.length !== 1, onClick: run(onHole) },
            { separator: true },
            { label: "Group selection", disabled: selection.length === 0, onClick: run(actions.groupSelection) },
            { label: "Ungroup", disabled: selection.length === 0, onClick: run(actions.ungroupSelection) },
            { label: "Duplicate", disabled: selection.length === 0, onClick: run(actions.duplicateSelection) },
            { label: "Delete", disabled: selection.length === 0, onClick: run(actions.deleteSelection) },
          ]}
        />
        <Dropdown
          name="io" label="Import / export" open={menu === "io"} onToggle={() => toggle("io")}
          items={[
            { label: "Import STL / GLB…", onClick: run(actions.importMeshFile) },
            { label: "Import STEP… (B-rep solid)", onClick: run(actions.importStepFile) },
            { separator: true },
            { label: "Export STL", onClick: run(actions.exportSTL) },
            { label: "Export GLB", onClick: run(actions.exportGLB) },
            { label: "Export STEP (solids only)", onClick: run(actions.exportSTEP) },
          ]}
        />
        <button type="button" className="btn btn--accent" onClick={run(onAiImport)} title="Bring in a 2D→3D generation result">
          AI model…
        </button>
      </div>

      <div className="toolbar__spacer" />
      <label className="toolbar__unit">
        Unit
        <select value={doc.displayUnit} onChange={(e) => setDisplayUnit(e.target.value as UnitName)}>
          {UNIT_NAMES.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </label>
    </header>
  );
}

interface MenuItem {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

function Dropdown({
  label, open, onToggle, items,
}: { name: string; label: string; open: boolean; onToggle: () => void; items: MenuItem[] }) {
  return (
    <div className="dropdown">
      <button type="button" className={`btn${open ? " btn--active" : ""}`} onClick={onToggle}>
        {label} ▾
      </button>
      {open ? (
        <ul className="dropdown__menu">
          {items.map((item, index) =>
            item.separator ? (
              <li key={`sep${index}`} className="dropdown__sep" />
            ) : (
              <li key={item.label}>
                <button type="button" className="dropdown__item" disabled={item.disabled} onClick={item.onClick}>
                  {item.label}
                </button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
