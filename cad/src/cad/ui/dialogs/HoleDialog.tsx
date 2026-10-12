import { useState } from "react";
import { Modal } from "../Modal";
import { NumberField } from "../NumberField";
import { makeId } from "../../core/ids";
import type { HoleSpec, UnitName, Vec3 } from "../../core/types";

const AXES: Record<string, Vec3> = { Z: [0, 0, 1], Y: [0, 1, 0], X: [1, 0, 0] };

/**
 * Creates a hole by cutting a cylinder out of the target solid. The result is a
 * real subtraction in the kernel, so the hole shows up in STL and STEP output.
 */
export function HoleDialog({
  unit, targetName, onCancel, onCreate,
}: {
  unit: UnitName;
  targetName: string;
  onCancel: () => void;
  onCreate: (hole: HoleSpec) => void;
}) {
  const [diameter, setDiameter] = useState(10);
  const [through, setThrough] = useState(true);
  const [depth, setDepth] = useState(20);
  const [axis, setAxis] = useState<keyof typeof AXES>("Z");
  const [position, setPosition] = useState<Vec3>([0, 0, 0]);
  const [counterbore, setCounterbore] = useState(false);
  const [cbDiameter, setCbDiameter] = useState(18);
  const [cbDepth, setCbDepth] = useState(4);

  return (
    <Modal
      title={`Hole in "${targetName}"`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onCreate({
              id: makeId("hol"),
              position,
              direction: AXES[axis],
              diameter,
              depth: through ? "through" : depth,
              counterbore: counterbore ? { diameter: cbDiameter, depth: cbDepth } : undefined,
            })}
          >
            Cut hole
          </button>
        </>
      }
    >
      <p className="hint">
        The position is given in the part's own coordinates; the origin is the part centre.
      </p>
      <div className="grid3">
        <NumberField label="Diameter" value={diameter} unit={unit} min={1e-4} onCommit={setDiameter} />
        <NumberField label="Depth" value={depth} unit={unit} min={1e-4} disabled={through} onCommit={setDepth} />
        <label className="field field--check">
          <span className="field__label">Through</span>
          <input type="checkbox" checked={through} onChange={(e) => setThrough(e.target.checked)} />
        </label>
      </div>
      <div className="grid3">
        {(["X", "Y", "Z"] as const).map((label, i) => (
          <NumberField
            key={label}
            label={`Position ${label}`}
            value={position[i]}
            unit={unit}
            onCommit={(v) => {
              const next = [...position] as Vec3;
              next[i] = v;
              setPosition(next);
            }}
          />
        ))}
      </div>
      <label className="field">
        <span className="field__label">Axis</span>
        <span className="field__input">
          <select value={axis} onChange={(e) => setAxis(e.target.value as keyof typeof AXES)}>
            <option value="Z">Z (vertical)</option>
            <option value="Y">Y</option>
            <option value="X">X</option>
          </select>
        </span>
      </label>
      <label className="field field--check">
        <span className="field__label">Counterbore</span>
        <input type="checkbox" checked={counterbore} onChange={(e) => setCounterbore(e.target.checked)} />
      </label>
      {counterbore ? (
        <div className="grid3">
          <NumberField label="C'bore Ø" value={cbDiameter} unit={unit} min={1e-4} onCommit={setCbDiameter} />
          <NumberField label="C'bore depth" value={cbDepth} unit={unit} min={1e-4} onCommit={setCbDepth} />
        </div>
      ) : null}
    </Modal>
  );
}
