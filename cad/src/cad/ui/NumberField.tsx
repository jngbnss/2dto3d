import { useEffect, useRef, useState } from "react";
import type { UnitName } from "../core/types";
import { fromMm, toMm, unitPrecision } from "../core/units";

interface Props {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  /** When set, the field converts between display units and internal mm. */
  unit?: UnitName;
  /** Raw fields (angles, counts, factors) skip unit conversion. */
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  invalid?: string | null;
  title?: string;
}

/**
 * Numeric input that commits on Enter/blur, never per keystroke.
 *
 * Two reasons: a half-typed "1" in a 100 mm field must not rebuild the solid,
 * and the undo stack should hold one entry per edit, not one per character.
 */
export function NumberField({
  label, value, onCommit, unit, suffix, min, max, step = 1, disabled, invalid, title,
}: Props) {
  const display = unit ? fromMm(value, unit) : value;
  const [text, setText] = useState(() => formatValue(display, unit ? unitPrecision(unit) : 4));
  const [focused, setFocused] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focused) return;
    setText(formatValue(display, unit ? unitPrecision(unit) : 4));
    setLocalError(null);
  }, [display, unit, focused]);

  const commit = () => {
    const parsed = Number(text.trim().replace(",", "."));
    if (!Number.isFinite(parsed)) {
      setLocalError("Enter a number");
      setText(formatValue(display, unit ? unitPrecision(unit) : 4));
      return;
    }
    const internal = unit ? toMm(parsed, unit) : parsed;
    if (min != null && internal < min) {
      setLocalError(`Minimum ${unit ? fromMm(min, unit) : min}`);
      setText(formatValue(display, unit ? unitPrecision(unit) : 4));
      return;
    }
    if (max != null && internal > max) {
      setLocalError(`Maximum ${unit ? fromMm(max, unit) : max}`);
      setText(formatValue(display, unit ? unitPrecision(unit) : 4));
      return;
    }
    setLocalError(null);
    if (Math.abs(internal - value) > 1e-9) onCommit(internal);
  };

  const error = localError ?? invalid ?? null;

  return (
    <label className={`field${error ? " field--error" : ""}`} title={title}>
      <span className="field__label">{label}</span>
      <span className="field__input">
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              inputRef.current?.blur();
            } else if (e.key === "Escape") {
              setText(formatValue(display, unit ? unitPrecision(unit) : 4));
              setLocalError(null);
              inputRef.current?.blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const delta = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? step * 10 : step);
              const current = Number(text.trim().replace(",", ".")) || 0;
              const next = current + delta;
              setText(formatValue(next, unit ? unitPrecision(unit) : 4));
              const internal = unit ? toMm(next, unit) : next;
              if ((min == null || internal >= min) && (max == null || internal <= max)) onCommit(internal);
            }
          }}
        />
        <span className="field__suffix">{suffix ?? unit ?? ""}</span>
      </span>
      {error ? <span className="field__error">{error}</span> : null}
    </label>
  );
}

function formatValue(value: number, precision: number): string {
  if (!Number.isFinite(value)) return "0";
  const fixed = value.toFixed(precision);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
