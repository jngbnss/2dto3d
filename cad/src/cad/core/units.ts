import type { UnitName } from "./types";

/** Millimetres per one display unit. */
const PER_UNIT: Record<UnitName, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

export const UNIT_NAMES: UnitName[] = ["mm", "cm", "m", "in"];

/** Display value -> internal mm. */
export function toMm(value: number, unit: UnitName): number {
  return value * PER_UNIT[unit];
}

/** Internal mm -> display value. */
export function fromMm(mm: number, unit: UnitName): number {
  return mm / PER_UNIT[unit];
}

/** Sensible decimals so mm and inches both read well. */
export function unitPrecision(unit: UnitName): number {
  return unit === "mm" ? 3 : unit === "cm" ? 4 : unit === "m" ? 6 : 4;
}

export function formatLength(mm: number, unit: UnitName): string {
  const v = fromMm(mm, unit);
  const p = unit === "mm" ? 2 : unit === "cm" ? 3 : unit === "m" ? 5 : 4;
  return `${trimZeros(v.toFixed(p))} ${unit}`;
}

/** mm^3 -> a readable volume string in the display unit cubed. */
export function formatVolume(mm3: number, unit: UnitName): string {
  const f = PER_UNIT[unit] ** 3;
  return `${trimZeros((mm3 / f).toFixed(3))} ${unit}³`;
}

export function formatArea(mm2: number, unit: UnitName): string {
  const f = PER_UNIT[unit] ** 2;
  return `${trimZeros((mm2 / f).toFixed(3))} ${unit}²`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
