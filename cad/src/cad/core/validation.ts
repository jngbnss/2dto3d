import type { Feature, Profile } from "./types";

export interface FieldIssue {
  field: string;
  message: string;
}

const MIN = 1e-4;   // 0.1 µm — below any real manufacturing tolerance
const MAX = 1e6;    // 1 km — anything larger is a typo, not a part

export function checkPositive(value: number, label: string): string | null {
  if (!Number.isFinite(value)) return `${label}: enter a number`;
  if (value <= 0) return `${label}: must be greater than 0`;
  if (value < MIN) return `${label}: too small (minimum ${MIN} mm)`;
  if (value > MAX) return `${label}: too large (maximum ${MAX} mm)`;
  return null;
}

export function checkFinite(value: number, label: string): string | null {
  if (!Number.isFinite(value)) return `${label}: enter a number`;
  if (Math.abs(value) > MAX) return `${label}: out of range`;
  return null;
}

function validateProfile(p: Profile): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const push = (field: string, msg: string | null) => {
    if (msg) issues.push({ field, message: msg });
  };
  if (p.type === "rect") {
    push("width", checkPositive(p.width, "Width"));
    push("height", checkPositive(p.height, "Height"));
    if (p.cornerRadius != null && p.cornerRadius > 0) {
      if (p.cornerRadius >= Math.min(p.width, p.height) / 2) {
        issues.push({ field: "cornerRadius", message: "Corner radius must be under half the shortest side" });
      }
    }
  } else if (p.type === "circle") {
    push("radius", checkPositive(p.radius, "Radius"));
  } else if (p.type === "regular") {
    push("radius", checkPositive(p.radius, "Radius"));
    if (!Number.isFinite(p.sides) || p.sides < 3) {
      issues.push({ field: "sides", message: "A polygon needs at least 3 sides" });
    }
  } else if (p.type === "polygon") {
    if (p.points.length < 3) issues.push({ field: "points", message: "A sketch needs at least 3 points" });
  }
  return issues;
}

/** Cheap main-thread pre-flight. The kernel is still the final authority. */
export function validateFeature(feature: Feature): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const push = (field: string, msg: string | null) => {
    if (msg) issues.push({ field, message: msg });
  };
  switch (feature.type) {
    case "box":
      push("width", checkPositive(feature.width, "Width"));
      push("depth", checkPositive(feature.depth, "Depth"));
      push("height", checkPositive(feature.height, "Height"));
      break;
    case "cylinder":
      push("radius", checkPositive(feature.radius, "Radius"));
      push("height", checkPositive(feature.height, "Height"));
      break;
    case "sphere":
      push("radius", checkPositive(feature.radius, "Radius"));
      break;
    case "cone":
      push("height", checkPositive(feature.height, "Height"));
      push("bottomRadius", checkFinite(feature.bottomRadius, "Bottom radius"));
      push("topRadius", checkFinite(feature.topRadius, "Top radius"));
      if (feature.bottomRadius < 0 || feature.topRadius < 0) {
        issues.push({ field: "topRadius", message: "Radii cannot be negative" });
      }
      if (feature.bottomRadius <= 0 && feature.topRadius <= 0) {
        issues.push({ field: "bottomRadius", message: "At least one radius must be greater than 0" });
      }
      break;
    case "extrude":
      push("distance", checkPositive(feature.distance, "Extrude distance"));
      issues.push(...validateProfile(feature.profile));
      break;
    case "revolve":
      push("angle", checkPositive(feature.angle, "Revolve angle"));
      if (feature.angle > 360) issues.push({ field: "angle", message: "Angle cannot exceed 360°" });
      issues.push(...validateProfile(feature.profile));
      break;
    case "fillet":
      push("radius", checkPositive(feature.radius, "Fillet radius"));
      break;
    case "chamfer":
      push("distance", checkPositive(feature.distance, "Chamfer distance"));
      break;
    case "hole":
      feature.holes.forEach((h, i) => {
        push(`holes.${i}.diameter`, checkPositive(h.diameter, `Hole ${i + 1} diameter`));
        if (h.depth !== "through") {
          push(`holes.${i}.depth`, checkPositive(h.depth, `Hole ${i + 1} depth`));
        }
        if (Math.hypot(...h.direction) < 1e-9) {
          issues.push({ field: `holes.${i}.direction`, message: `Hole ${i + 1}: direction cannot be zero` });
        }
      });
      break;
    case "boolean":
      if (feature.operands.length < 2) {
        issues.push({ field: "operands", message: "A boolean needs at least two bodies" });
      }
      break;
    default:
      break;
  }
  return issues;
}
