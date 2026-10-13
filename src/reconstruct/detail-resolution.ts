import type { Silhouette } from "../analyze/silhouette.ts";
import type { ViewId } from "../views.ts";
import type { HullFrame } from "./voxel-reconstruct.ts";
import { openMask } from "./voxel-reconstruct.ts";

export interface ResolutionAdvice {
  readonly requested: number;
  readonly resolution: number;
  readonly adjusted: boolean;
  readonly view?: ViewId;
  /** Foreground share removed by an opening sized to four requested voxels. */
  readonly thinRatio: number;
}

const MAX_ADAPTIVE_RESOLUTION = 384;
const MIN_MEANINGFUL_PIXELS = 12;
// Digital circles lose a few corner pixels under opening (~0.2% at 256 px).
// Require a wider margin so curvature aliasing does not trigger a costly rebuild.
const MIN_MEANINGFUL_RATIO = 0.005;

/**
 * Detects silhouette-supported structures too thin for the requested voxel grid.
 *
 * A morphological opening removes necks, wires and handle attachments narrower
 * than roughly four grid cells. When a non-trivial part of any view disappears,
 * the grid advances by one 1.5x tier. This is deliberately bounded: it protects
 * joints without silently turning every build into a maximum-cost build.
 */
export function adviseResolution(
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  frame: HullFrame,
  requested: number,
): ResolutionAdvice {
  const longest = Math.max(frame.extent.x, frame.extent.y, frame.extent.z);
  const pixelsPerCell = (frame.pixelsPerUnit * longest) / requested;
  const openingRadius = Math.max(2, Math.min(12, Math.ceil(pixelsPerCell * 2)));
  let thinRatio = 0;
  let view: ViewId | undefined;

  for (const [id, silhouette] of silhouettes) {
    if (silhouette.area <= 0) continue;
    const opened = openMask(silhouette, openingRadius);
    let removed = 0;
    for (let index = 0; index < silhouette.mask.length; index++) {
      if (silhouette.mask[index] === 1 && opened[index] !== 1) removed++;
    }
    const ratio = removed / silhouette.area;
    if (removed >= MIN_MEANINGFUL_PIXELS && ratio > thinRatio) {
      thinRatio = ratio;
      view = id;
    }
  }

  const adjusted = thinRatio >= MIN_MEANINGFUL_RATIO && requested < MAX_ADAPTIVE_RESOLUTION;
  const resolution = adjusted
    ? Math.min(MAX_ADAPTIVE_RESOLUTION, Math.ceil((requested * 1.5) / 32) * 32)
    : requested;
  return {
    requested,
    resolution,
    adjusted,
    thinRatio,
    ...(view ? { view } : {}),
  };
}
