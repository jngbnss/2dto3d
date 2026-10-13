import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VIEW_IDS, type ViewId } from "./views.ts";

/**
 * Per-view correction the user applies before reconstruction. It is stored, not
 * baked into the upload: the original file stays untouched and every stage —
 * masking, alignment, carving, colouring — reads the image through this
 * transform, so changing it never compounds resampling loss.
 *
 * Order of application: rotate (clockwise) -> horizontal flip -> crop -> mask ->
 * automatic alignment (centre + common scale) -> user scale -> user offset.
 */
export interface ViewTransform {
  /** Clockwise quarter turns applied to the raw image, in degrees. */
  readonly rotation: 0 | 90 | 180 | 270;
  /** Mirror left-right after rotating. */
  readonly flip: boolean;
  /** Multiplier on the automatically solved scale, 0.5..2. */
  readonly scale: number;
  /** Shift on the prepared canvas, fractions of its size; +x right, +y down. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Fractions trimmed from each edge of the rotated image, 0..0.45. */
  readonly crop: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
}

export const IDENTITY_TRANSFORM: ViewTransform = {
  rotation: 0,
  flip: false,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

export type ViewTransforms = Readonly<Partial<Record<ViewId, ViewTransform>>>;

const STATE_FILE = "views.json";

/** Merges a partial update into `base`, clamping every field into its legal range. */
export function updateTransform(base: ViewTransform, patch: unknown): ViewTransform {
  const input = typeof patch === "object" && patch !== null ? (patch as Record<string, unknown>) : {};
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = input[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const rotationInput = input["rotation"];
  const rotation =
    typeof rotationInput === "number" && Number.isFinite(rotationInput)
      ? ((((Math.round(rotationInput / 90) * 90) % 360) + 360) % 360) as ViewTransform["rotation"]
      : base.rotation;
  const cropInput = typeof input["crop"] === "object" && input["crop"] !== null ? (input["crop"] as Record<string, unknown>) : {};
  const edge = (key: keyof ViewTransform["crop"]): number => {
    const value = cropInput[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(0.45, Math.max(0, value)) : base.crop[key];
  };
  return {
    rotation,
    flip: typeof input["flip"] === "boolean" ? input["flip"] : base.flip,
    scale: number("scale", base.scale, 0.5, 2),
    offsetX: number("offsetX", base.offsetX, -0.25, 0.25),
    offsetY: number("offsetY", base.offsetY, -0.25, 0.25),
    crop: { left: edge("left"), top: edge("top"), right: edge("right"), bottom: edge("bottom") },
  };
}

/** Reads `views.json` from a view directory; absent or malformed entries fall back to identity. */
export async function loadTransforms(directory: string): Promise<Record<ViewId, ViewTransform>> {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(await readFile(join(directory, STATE_FILE), "utf8")) as Record<string, unknown>;
  } catch {
    // No saved corrections yet.
  }
  return Object.fromEntries(
    VIEW_IDS.map((id) => [id, updateTransform(IDENTITY_TRANSFORM, stored[id])]),
  ) as Record<ViewId, ViewTransform>;
}

export async function saveTransforms(directory: string, transforms: Readonly<Record<ViewId, ViewTransform>>): Promise<void> {
  await writeFile(join(directory, STATE_FILE), `${JSON.stringify(transforms, null, 2)}\n`, "utf8");
}
