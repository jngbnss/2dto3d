import type { ViewId } from "../views.ts";

/**
 * Camera basis per view: `right` and `up` span the image plane, `forward` points
 * into the screen. Rendering and carving MUST agree on these vectors — they are
 * the same projection used in opposite directions.
 */
export interface Basis {
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
}

export const BASES: { readonly [K in ViewId]: Basis } = {
  front: { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] },
  back: { right: [-1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1] },
  left: { right: [0, 0, 1], up: [0, 1, 0], forward: [1, 0, 0] },
  right: { right: [0, 0, -1], up: [0, 1, 0], forward: [-1, 0, 0] },
  top: { right: [1, 0, 0], up: [0, 0, -1], forward: [0, -1, 0] },
};
