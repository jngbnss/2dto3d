import type { Feature, SolidRecipe, Transform } from "../core/types";

/** Deterministic JSON with sorted keys, so equal recipes produce equal keys. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stable(obj[k])).join(",") + "}";
}

/** Cache key for a full recipe (geometry + placement). */
export function recipeKey(recipe: SolidRecipe): string {
  return stable(recipe);
}

/** Cache key for geometry alone, ignoring placement. */
export function featureKey(feature: Feature): string {
  return stable(feature);
}

export function transformKey(t: Transform): string {
  return stable(t);
}
