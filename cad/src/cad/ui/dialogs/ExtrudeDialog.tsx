import { useState } from "react";
import { Modal } from "../Modal";
import { NumberField } from "../NumberField";
import type { Feature, PlaneName, Profile, UnitName } from "../../core/types";

type ProfileKind = "rect" | "circle" | "regular" | "polygon";

const L_PROFILE: [number, number][] = [[0, 0], [80, 0], [80, 20], [20, 20], [20, 60], [0, 60]];

/**
 * Creates a 2D sketch and extrudes it into a solid. This is a real
 * sketch → solid operation in the kernel, not a scaled box.
 */
export function ExtrudeDialog({
  unit, onCancel, onCreate,
}: { unit: UnitName; onCancel: () => void; onCreate: (feature: Feature, name: string) => void }) {
  const [kind, setKind] = useState<ProfileKind>("rect");
  const [plane, setPlane] = useState<PlaneName>("XY");
  const [distance, setDistance] = useState(20);
  const [width, setWidth] = useState(80);
  const [height, setHeight] = useState(50);
  const [cornerRadius, setCornerRadius] = useState(0);
  const [radius, setRadius] = useState(30);
  const [sides, setSides] = useState(6);
  const [twist, setTwist] = useState(0);

  const profile: Profile =
    kind === "rect" ? { type: "rect", width, height, cornerRadius: cornerRadius || undefined }
      : kind === "circle" ? { type: "circle", radius }
        : kind === "regular" ? { type: "regular", radius, sides }
          : { type: "polygon", points: L_PROFILE };

  return (
    <Modal
      title="Extrude a sketch"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onCreate(
              { type: "extrude", plane, profile, distance, twistAngle: twist || undefined },
              kind === "polygon" ? "L-profile extrude" : `${kind} extrude`,
            )}
          >
            Create solid
          </button>
        </>
      }
    >
      <div className="row">
        <label className="field">
          <span className="field__label">Sketch</span>
          <span className="field__input">
            <select value={kind} onChange={(e) => setKind(e.target.value as ProfileKind)}>
              <option value="rect">Rectangle</option>
              <option value="circle">Circle</option>
              <option value="regular">Regular polygon</option>
              <option value="polygon">L-shaped profile</option>
            </select>
          </span>
        </label>
        <label className="field">
          <span className="field__label">Plane</span>
          <span className="field__input">
            <select value={plane} onChange={(e) => setPlane(e.target.value as PlaneName)}>
              <option value="XY">XY (top)</option>
              <option value="XZ">XZ (front)</option>
              <option value="YZ">YZ (right)</option>
            </select>
          </span>
        </label>
      </div>

      {kind === "rect" ? (
        <div className="grid3">
          <NumberField label="Width" value={width} unit={unit} min={1e-4} onCommit={setWidth} />
          <NumberField label="Height" value={height} unit={unit} min={1e-4} onCommit={setHeight} />
          <NumberField label="Corner R" value={cornerRadius} unit={unit} min={0} onCommit={setCornerRadius} />
        </div>
      ) : null}
      {kind === "circle" || kind === "regular" ? (
        <div className="grid3">
          <NumberField label="Radius" value={radius} unit={unit} min={1e-4} onCommit={setRadius} />
          {kind === "regular" ? (
            <NumberField label="Sides" value={sides} min={3} max={64} step={1} onCommit={(v) => setSides(Math.round(v))} />
          ) : null}
        </div>
      ) : null}
      {kind === "polygon" ? (
        <p className="hint">A fixed 80 × 60 mm L profile — handy as a bracket starting point.</p>
      ) : null}

      <div className="grid3">
        <NumberField label="Distance" value={distance} unit={unit} min={1e-4} onCommit={setDistance} />
        <NumberField label="Twist" value={twist} suffix="°" step={5} onCommit={setTwist} />
      </div>
    </Modal>
  );
}
