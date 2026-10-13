import type { Silhouette } from "../analyze/silhouette.ts";
import { boxMesh } from "../mesh/primitives.ts";
import { computeBounds, type Mesh } from "../mesh/types.ts";
import { BASES } from "../render/basis.ts";
import { renderViews } from "../render/ortho.ts";
import type { Axis, ViewId } from "../views.ts";
import type { HullFrame } from "./voxel-reconstruct.ts";

export type GeometryKind = "box" | "elliptic-revolve";

export interface GeometryCandidate {
  readonly kind: GeometryKind;
  readonly mesh: Mesh;
  readonly score: number;
  readonly minimumViewScore: number;
  readonly perView: ReadonlyMap<ViewId, number>;
}

/** Builds generic primitive candidates and scores them against all supplied masks. */
export function geometryCandidates(
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  frame: HullFrame,
): readonly GeometryCandidate[] {
  const candidates: Array<{ kind: GeometryKind; mesh: Mesh }> = [
    { kind: "box", mesh: boxMesh({ size: [frame.extent.x, frame.extent.y, frame.extent.z] }) },
  ];
  const revolved = ellipticRevolveFromSilhouettes(silhouettes, frame);
  if (revolved) candidates.push({ kind: "elliptic-revolve", mesh: revolved });
  return candidates.map((candidate) => ({ ...candidate, ...scoreSilhouetteFit(candidate.mesh, silhouettes, frame.pixelsPerUnit) }));
}

export function bestGeometryCandidate(
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  frame: HullFrame,
): GeometryCandidate | null {
  const candidates = geometryCandidates(silhouettes, frame);
  return candidates.reduce<GeometryCandidate | null>((best, candidate) => !best || candidate.score > best.score ? candidate : best, null);
}

/** Closed Y-axis elliptical cylinder, also used as deterministic synthetic ground truth. */
export function ellipticCylinderMesh(radiusX: number, height: number, radiusZ: number, sectors = 64): Mesh {
  return loftEllipses(
    [
      { y: -height / 2, rx: radiusX, rz: radiusZ },
      { y: height / 2, rx: radiusX, rz: radiusZ },
    ],
    sectors,
    -height / 2,
    height / 2,
  );
}

export function scoreSilhouetteFit(
  mesh: Mesh,
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  pixelsPerUnit: number,
): Pick<GeometryCandidate, "score" | "minimumViewScore" | "perView"> {
  const size = [...silhouettes.values()][0]?.width ?? 512;
  const rendered = renderViews(mesh, { size, pixelsPerUnit });
  const perView = new Map<ViewId, number>();
  for (const [id, silhouette] of silhouettes) perView.set(id, maskIoU(silhouette, rendered[id].pixels));
  const values = [...perView.values()];
  return {
    score: values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1),
    minimumViewScore: values.length > 0 ? Math.min(...values) : 0,
    perView,
  };
}

/**
 * Fits a vertical elliptical profile. Each ring uses the symmetric core visible
 * around the shared origin, so one-sided handles and levers do not inflate the
 * body. Non-rotational objects fail multi-view scoring and are rejected.
 */
function ellipticRevolveFromSilhouettes(
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  frame: HullFrame,
): Mesh | null {
  const height = frame.extent.y;
  if (!(height > 0)) return null;
  const rings = 72;
  const sectors = 64;
  const profiles: Array<{ y: number; rx: number; rz: number }> = [];
  for (let ring = 0; ring < rings; ring++) {
    const y = -height / 2 + ((ring + 0.5) / rings) * height;
    const rx = symmetricRadius(silhouettes, frame.pixelsPerUnit, "x", y);
    const rz = symmetricRadius(silhouettes, frame.pixelsPerUnit, "z", y);
    if (rx === null || rz === null) return null;
    profiles.push({ y, rx, rz });
  }
  if (profiles.filter((profile) => profile.rx > 0 && profile.rz > 0).length < rings * 0.7) return null;
  return loftEllipses(profiles, sectors, -height / 2, height / 2);
}

function symmetricRadius(
  silhouettes: ReadonlyMap<ViewId, Silhouette>,
  pixelsPerUnit: number,
  axis: "x" | "z",
  y: number,
): number | null {
  const axisIndex = axis === "x" ? 0 : 2;
  const values: number[] = [];
  for (const [id, silhouette] of silhouettes) {
    const basis = BASES[id];
    if (basis.up[1] !== 1 || basis.right[axisIndex] === 0) continue;
    const row = Math.floor(silhouette.height / 2 - y * pixelsPerUnit);
    if (row < 0 || row >= silhouette.height) continue;
    const centre = silhouette.width / 2;
    let left = Math.floor(centre - 0.5);
    let right = Math.ceil(centre - 0.5);
    if (silhouette.mask[row * silhouette.width + Math.floor(centre)] !== 1) continue;
    while (left >= 0 && silhouette.mask[row * silhouette.width + left] === 1) left--;
    while (right < silhouette.width && silhouette.mask[row * silhouette.width + right] === 1) right++;
    const negative = centre - (left + 1);
    const positive = right - centre;
    values.push(Math.max(0, Math.min(negative, positive) / pixelsPerUnit));
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? null;
}

function loftEllipses(
  profiles: readonly { readonly y: number; readonly rx: number; readonly rz: number }[],
  sectors: number,
  bottom: number,
  top: number,
): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const profile of profiles) {
    for (let sector = 0; sector < sectors; sector++) {
      const angle = (sector / sectors) * Math.PI * 2;
      positions.push(profile.rx * Math.cos(angle), profile.y, profile.rz * Math.sin(angle));
    }
  }
  for (let ring = 0; ring + 1 < profiles.length; ring++) {
    for (let sector = 0; sector < sectors; sector++) {
      const next = (sector + 1) % sectors;
      const a = ring * sectors + sector;
      const b = ring * sectors + next;
      const c = (ring + 1) * sectors + next;
      const d = (ring + 1) * sectors + sector;
      indices.push(a, b, c, a, c, d);
    }
  }
  const bottomCenter = positions.length / 3;
  positions.push(0, bottom, 0);
  const topCenter = positions.length / 3;
  positions.push(0, top, 0);
  const last = (profiles.length - 1) * sectors;
  for (let sector = 0; sector < sectors; sector++) {
    const next = (sector + 1) % sectors;
    indices.push(bottomCenter, next, sector);
    indices.push(topCenter, last + sector, last + next);
  }
  const positionArray = Float32Array.from(positions);
  return {
    positions: positionArray,
    indices: Uint32Array.from(indices),
    colors: new Float32Array(0),
    bounds: computeBounds(positionArray),
  };
}

function maskIoU(silhouette: Silhouette, rgba: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < silhouette.mask.length; index++) {
    const source = silhouette.mask[index] === 1;
    const rendered = (rgba[index * 4 + 3] ?? 0) >= 128;
    if (source && rendered) intersection++;
    if (source || rendered) union++;
  }
  return union === 0 ? 0 : intersection / union;
}
