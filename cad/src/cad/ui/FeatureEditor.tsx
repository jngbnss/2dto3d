import type { Feature, PlaneName, Profile, UnitName } from "../core/types";
import { NumberField } from "./NumberField";
import { validateFeature } from "../core/validation";

interface Props {
  feature: Feature;
  unit: UnitName;
  disabled?: boolean;
  onChange: (next: Feature) => void;
}

/**
 * Parameter editor for one feature node.
 *
 * Editing here rewrites the feature, which makes the kernel rebuild the solid.
 * That is the whole point: this is a dimension change, not a display scale.
 */
export function FeatureEditor({ feature, unit, disabled, onChange }: Props) {
  const issues = validateFeature(feature);
  const errorFor = (field: string) => issues.find((i) => i.field === field)?.message ?? null;

  switch (feature.type) {
    case "box":
      return (
        <div className="grid3">
          <NumberField label="Width (X)" value={feature.width} unit={unit} min={1e-4} disabled={disabled}
            invalid={errorFor("width")} onCommit={(v) => onChange({ ...feature, width: v })} />
          <NumberField label="Depth (Y)" value={feature.depth} unit={unit} min={1e-4} disabled={disabled}
            invalid={errorFor("depth")} onCommit={(v) => onChange({ ...feature, depth: v })} />
          <NumberField label="Height (Z)" value={feature.height} unit={unit} min={1e-4} disabled={disabled}
            invalid={errorFor("height")} onCommit={(v) => onChange({ ...feature, height: v })} />
        </div>
      );
    case "cylinder":
      return (
        <div className="grid3">
          <NumberField label="Diameter" value={feature.radius * 2} unit={unit} min={1e-4} disabled={disabled}
            invalid={errorFor("radius")} onCommit={(v) => onChange({ ...feature, radius: v / 2 })} />
          <NumberField label="Radius" value={feature.radius} unit={unit} min={1e-4} disabled={disabled}
            onCommit={(v) => onChange({ ...feature, radius: v })} />
          <NumberField label="Height (Z)" value={feature.height} unit={unit} min={1e-4} disabled={disabled}
            invalid={errorFor("height")} onCommit={(v) => onChange({ ...feature, height: v })} />
        </div>
      );
    case "sphere":
      return (
        <div className="grid3">
          <NumberField label="Diameter" value={feature.radius * 2} unit={unit} min={1e-4} disabled={disabled}
            invalid={errorFor("radius")} onCommit={(v) => onChange({ ...feature, radius: v / 2 })} />
          <NumberField label="Radius" value={feature.radius} unit={unit} min={1e-4} disabled={disabled}
            onCommit={(v) => onChange({ ...feature, radius: v })} />
        </div>
      );
    case "cone":
      return (
        <div className="grid3">
          <NumberField label="Bottom R" value={feature.bottomRadius} unit={unit} min={0} disabled={disabled}
            invalid={errorFor("bottomRadius")} onCommit={(v) => onChange({ ...feature, bottomRadius: v })} />
          <NumberField label="Top R" value={feature.topRadius} unit={unit} min={0} disabled={disabled}
            invalid={errorFor("topRadius")} onCommit={(v) => onChange({ ...feature, topRadius: v })} />
          <NumberField label="Height (Z)" value={feature.height} unit={unit} min={1e-4} disabled={disabled}
            invalid={errorFor("height")} onCommit={(v) => onChange({ ...feature, height: v })} />
        </div>
      );
    case "extrude":
      return (
        <>
          <ProfileEditor profile={feature.profile} unit={unit} disabled={disabled}
            onChange={(profile) => onChange({ ...feature, profile })} />
          <div className="grid3">
            <NumberField label="Distance" value={feature.distance} unit={unit} min={1e-4} disabled={disabled}
              invalid={errorFor("distance")} onCommit={(v) => onChange({ ...feature, distance: v })} />
            <NumberField label="Twist" value={feature.twistAngle ?? 0} suffix="°" step={5} disabled={disabled}
              onCommit={(v) => onChange({ ...feature, twistAngle: v || undefined })} />
            <label className="field">
              <span className="field__label">Sketch plane</span>
              <span className="field__input">
                <select value={feature.plane} disabled={disabled}
                  onChange={(e) => onChange({ ...feature, plane: e.target.value as PlaneName })}>
                  <option value="XY">XY (top)</option>
                  <option value="XZ">XZ (front)</option>
                  <option value="YZ">YZ (right)</option>
                </select>
              </span>
            </label>
          </div>
        </>
      );
    case "revolve":
      return (
        <>
          <ProfileEditor profile={feature.profile} unit={unit} disabled={disabled}
            onChange={(profile) => onChange({ ...feature, profile })} />
          <div className="grid3">
            <NumberField label="Angle" value={feature.angle} suffix="°" min={0.1} max={360} step={15}
              disabled={disabled} invalid={errorFor("angle")}
              onCommit={(v) => onChange({ ...feature, angle: v })} />
          </div>
        </>
      );
    case "fillet":
      return (
        <div className="grid3">
          <NumberField label="Fillet radius" value={feature.radius} unit={unit} min={1e-4} disabled={disabled}
            invalid={errorFor("radius")} onCommit={(v) => onChange({ ...feature, radius: v })} />
        </div>
      );
    case "chamfer":
      return (
        <div className="grid3">
          <NumberField label="Chamfer size" value={feature.distance} unit={unit} min={1e-4} disabled={disabled}
            invalid={errorFor("distance")} onCommit={(v) => onChange({ ...feature, distance: v })} />
        </div>
      );
    case "hole":
      return (
        <div className="hole-list">
          {feature.holes.map((hole, index) => (
            <div className="hole-row" key={hole.id}>
              <div className="hole-row__title">Hole {index + 1}</div>
              <div className="grid3">
                <NumberField label="Diameter" value={hole.diameter} unit={unit} min={1e-4} disabled={disabled}
                  onCommit={(v) => onChange({
                    ...feature,
                    holes: feature.holes.map((h, i) => (i === index ? { ...h, diameter: v } : h)),
                  })} />
                <NumberField label="Depth" value={hole.depth === "through" ? 0 : hole.depth} unit={unit}
                  disabled={disabled || hole.depth === "through"}
                  onCommit={(v) => onChange({
                    ...feature,
                    holes: feature.holes.map((h, i) => (i === index ? { ...h, depth: v } : h)),
                  })} />
                <label className="field field--check">
                  <span className="field__label">Through</span>
                  <input type="checkbox" checked={hole.depth === "through"} disabled={disabled}
                    onChange={(e) => onChange({
                      ...feature,
                      holes: feature.holes.map((h, i) =>
                        i === index ? { ...h, depth: e.target.checked ? "through" : 20 } : h),
                    })} />
                </label>
              </div>
              <div className="grid3">
                {(["X", "Y", "Z"] as const).map((axis, axisIndex) => (
                  <NumberField key={axis} label={`Pos ${axis}`} value={hole.position[axisIndex]} unit={unit}
                    disabled={disabled}
                    onCommit={(v) => onChange({
                      ...feature,
                      holes: feature.holes.map((h, i) => {
                        if (i !== index) return h;
                        const position = [...h.position] as typeof h.position;
                        position[axisIndex] = v;
                        return { ...h, position };
                      }),
                    })} />
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    case "boolean":
      return (
        <p className="hint">
          Result of a boolean <strong>{feature.op}</strong> over {feature.operands.length} bodies.
          Pick an operand in the feature tree to edit its dimensions — the result rebuilds from the kernel.
        </p>
      );
    case "imported-step":
      return <p className="hint">Imported B-rep solid. Dimensions come from the STEP file, not from parameters.</p>;
    default:
      return null;
  }
}

function ProfileEditor({
  profile, unit, disabled, onChange,
}: { profile: Profile; unit: UnitName; disabled?: boolean; onChange: (p: Profile) => void }) {
  switch (profile.type) {
    case "rect":
      return (
        <div className="grid3">
          <NumberField label="Sketch W" value={profile.width} unit={unit} min={1e-4} disabled={disabled}
            onCommit={(v) => onChange({ ...profile, width: v })} />
          <NumberField label="Sketch H" value={profile.height} unit={unit} min={1e-4} disabled={disabled}
            onCommit={(v) => onChange({ ...profile, height: v })} />
          <NumberField label="Corner R" value={profile.cornerRadius ?? 0} unit={unit} min={0} disabled={disabled}
            onCommit={(v) => onChange({ ...profile, cornerRadius: v || undefined })} />
        </div>
      );
    case "circle":
      return (
        <div className="grid3">
          <NumberField label="Sketch R" value={profile.radius} unit={unit} min={1e-4} disabled={disabled}
            onCommit={(v) => onChange({ ...profile, radius: v })} />
        </div>
      );
    case "regular":
      return (
        <div className="grid3">
          <NumberField label="Sketch R" value={profile.radius} unit={unit} min={1e-4} disabled={disabled}
            onCommit={(v) => onChange({ ...profile, radius: v })} />
          <NumberField label="Sides" value={profile.sides} min={3} max={64} step={1} disabled={disabled}
            onCommit={(v) => onChange({ ...profile, sides: Math.round(v) })} />
        </div>
      );
    case "polygon":
      return <p className="hint">Custom sketch with {profile.points.length} points.</p>;
    default:
      return null;
  }
}
