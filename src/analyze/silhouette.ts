import type { Raster } from "./raster.ts";

export interface BBox {
  readonly x0: number;
  readonly y0: number;
  /** Exclusive. */
  readonly x1: number;
  /** Exclusive. */
  readonly y1: number;
}

export type MaskSource = "alpha" | "background-key";

export interface Silhouette {
  readonly width: number;
  readonly height: number;
  /** 1 = foreground, 0 = background. Length `width * height`. */
  readonly mask: Uint8Array;
  readonly source: MaskSource;
  /** Foreground pixel count. */
  readonly area: number;
  readonly bbox: BBox | null;
  /** Bounding-box extents as a fraction of the frame, 0..1. */
  readonly extent: { readonly width: number; readonly height: number };
  /** Bounding-box centre as a fraction of the frame, 0..1. */
  readonly center: { readonly x: number; readonly y: number };
  /** Foreground area divided by bounding-box area, 0..1. */
  readonly fill: number;
  /** Largest connected blob divided by total foreground area, 0..1. */
  readonly largestBlob: number;
  readonly blobs: number;
  /** Foreground pixels sitting on the frame border (object is cropped). */
  readonly borderPixels: number;
  readonly meanColor: { readonly r: number; readonly g: number; readonly b: number };
  /** Saturation-weighted hue histogram, 24 bins, normalised to sum 1. */
  readonly hueHistogram: Float64Array;
  /** Mean relative luminance of the foreground, 0..1. */
  readonly luminance: number;
}

const ALPHA_THRESHOLD = 128;
const BORDER_RING = 2;
const HUE_BINS = 24;
/** Minimum RGB distance from the keyed background colour, in 0..255 units. */
const MIN_KEY_DISTANCE = 28;
/** Width in pixels of a leak channel that gets sealed before masking. */
const LEAK_SEAL_RADIUS = 3;

export function extractSilhouette(raster: Raster): Silhouette {
  const { width, height, data } = raster;
  const mask = new Uint8Array(width * height);
  const source: MaskSource = raster.hadAlpha ? "alpha" : "background-key";

  if (source === "alpha") {
    for (let i = 0, p = 3; i < mask.length; i++, p += 4) {
      mask[i] = (data[p] ?? 0) >= ALPHA_THRESHOLD ? 1 : 0;
    }
  } else {
    floodBackground(raster, mask);
  }

  return describe(raster, mask, source);
}

/**
 * Background removal by flood fill from the frame border.
 *
 * Global colour keying cannot separate a white object on a white background —
 * the common case for product shots and rendered reference sheets. Filling
 * inward from the border instead stops at the first edge it meets, so the object
 * survives even when it shares the background's colour.
 */
function floodBackground(raster: Raster, mask: Uint8Array): void {
  const { width, height, data } = raster;
  const background = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let top = 0;

  const push = (index: number): void => {
    if (background[index] === 1) return;
    background[index] = 1;
    stack[top++] = index;
  };

  const bg = keyColor(raster);
  const tolerance = Math.max(MIN_KEY_DISTANCE, bg.spread * 3);
  const cut = tolerance * tolerance;

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  // Every candidate is compared against the seed background colour, never against
  // its own neighbour: a neighbour-relative test walks up a soft gradient and
  // leaks through anti-aliased outlines into a same-coloured object.
  while (top > 0) {
    const index = stack[--top] ?? 0;
    const x = index % width;
    const y = (index / width) | 0;

    const spread = (neighbour: number): void => {
      if (background[neighbour] === 1) return;
      const q = neighbour * 4;
      if ((data[q + 3] ?? 255) < ALPHA_THRESHOLD) {
        push(neighbour);
        return;
      }
      // no edge gate: panel frames would block the fill before it starts
      const dr = (data[q] ?? 0) - bg.r;
      const dg = (data[q + 1] ?? 0) - bg.g;
      const db = (data[q + 2] ?? 0) - bg.b;
      if (dr * dr + dg * dg + db * db <= cut) push(neighbour);
    };

    if (x > 0) spread(index - 1);
    if (x < width - 1) spread(index + 1);
    if (y > 0) spread(index - width);
    if (y < height - 1) spread(index + width);
  }

  sealLeaks(background, width, height);
  for (let i = 0; i < mask.length; i++) mask[i] = background[i] === 1 ? 0 : 1;
}

/**
 * Seals thin leaks in the flooded background.
 *
 * A soft outline lets the fill slip through a few pixels of gap and swallow the
 * object's interior. Eroding the background closes any channel narrower than
 * `LEAK_SEAL_RADIUS`; whatever is then cut off from the frame was never
 * background, so it is handed back to the object before the erosion is undone.
 */
function sealLeaks(background: Uint8Array, width: number, height: number): void {
  const radius = LEAK_SEAL_RADIUS;
  const eroded = new Uint8Array(background.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (background[i] !== 1) continue;
      let solid = 1;
      for (let dy = -radius; dy <= radius && solid === 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (background[ny * width + nx] !== 1) {
            solid = 0;
            break;
          }
        }
      }
      eroded[i] = solid;
    }
  }

  // Keep only the eroded background still reachable from the frame.
  const reachable = new Uint8Array(background.length);
  const stack = new Int32Array(background.length);
  let top = 0;
  const push = (index: number): void => {
    if (reachable[index] === 1 || eroded[index] !== 1) return;
    reachable[index] = 1;
    stack[top++] = index;
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (top > 0) {
    const i = stack[--top] ?? 0;
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }

  // Dilate the surviving background back, but never past the original fill.
  const sealed = new Uint8Array(background.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (background[i] !== 1) continue;
      for (let dy = -radius; dy <= radius && sealed[i] === 0; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (reachable[ny * width + nx] === 1) {
            sealed[i] = 1;
            break;
          }
        }
      }
    }
  }
  background.set(sealed);
}

/** Median colour of the border ring, plus how much that ring varies. */
function keyColor(raster: Raster): { r: number; g: number; b: number; spread: number } {
  const { width, height, data } = raster;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = 0; y < height; y++) {
    const edgeRow = y < BORDER_RING || y >= height - BORDER_RING;
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x >= BORDER_RING && x < width - BORDER_RING) continue;
      const p = (y * width + x) * 4;
      if ((data[p + 3] ?? 255) < ALPHA_THRESHOLD) continue;
      rs.push(data[p] ?? 0);
      gs.push(data[p + 1] ?? 0);
      bs.push(data[p + 2] ?? 0);
    }
  }
  if (rs.length === 0) return { r: 0, g: 0, b: 0, spread: 0 };

  const r = median(rs);
  const g = median(gs);
  const b = median(bs);
  let sum = 0;
  for (let i = 0; i < rs.length; i++) {
    const dr = (rs[i] ?? 0) - r;
    const dg = (gs[i] ?? 0) - g;
    const db = (bs[i] ?? 0) - b;
    sum += Math.sqrt(dr * dr + dg * dg + db * db);
  }
  return { r, g, b, spread: sum / rs.length };
}

function median(values: number[]): number {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function describe(raster: Raster, mask: Uint8Array, source: MaskSource): Silhouette {
  const { width, height, data } = raster;
  let area = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let borderPixels = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const hue = new Float64Array(HUE_BINS);
  let hueWeight = 0;
  let sumLum = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] !== 1) continue;
      area++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) borderPixels++;

      const p = i * 4;
      const r = data[p] ?? 0;
      const g = data[p + 1] ?? 0;
      const b = data[p + 2] ?? 0;
      sumR += r;
      sumG += g;
      sumB += b;
      sumLum += 0.2126 * r + 0.7152 * g + 0.0722 * b;

      const { h, s } = hueSat(r, g, b);
      if (s > 0) {
        const bin = Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS));
        hue[bin] = (hue[bin] ?? 0) + s;
        hueWeight += s;
      }
    }
  }

  if (hueWeight > 0) for (let i = 0; i < hue.length; i++) hue[i] = (hue[i] ?? 0) / hueWeight;

  const empty = area === 0;
  const bbox: BBox | null = empty ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  const boxW = bbox ? bbox.x1 - bbox.x0 : 0;
  const boxH = bbox ? bbox.y1 - bbox.y0 : 0;
  const components = countBlobs(mask, width, height);

  return {
    width,
    height,
    mask,
    source,
    area,
    bbox,
    extent: { width: boxW / width, height: boxH / height },
    center: bbox
      ? { x: (bbox.x0 + bbox.x1) / 2 / width, y: (bbox.y0 + bbox.y1) / 2 / height }
      : { x: 0.5, y: 0.5 },
    fill: boxW * boxH > 0 ? area / (boxW * boxH) : 0,
    largestBlob: area > 0 ? components.largest / area : 0,
    blobs: components.count,
    borderPixels,
    meanColor: empty
      ? { r: 0, g: 0, b: 0 }
      : { r: sumR / area, g: sumG / area, b: sumB / area },
    hueHistogram: hue,
    luminance: empty ? 0 : sumLum / area / 255,
  };
}

function hueSat(r: number, g: number, b: number): { h: number; s: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0 || max === 0) return { h: 0, s: 0 };
  let h: number;
  if (max === r) h = 60 * (((g - b) / delta + 6) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  return { h, s: delta / max };
}

/**
 * 4-connected blob census. Generated views fail here when the model emits
 * speckle or splits an object into disconnected fragments.
 */
function countBlobs(
  mask: Uint8Array,
  width: number,
  height: number,
): { count: number; largest: number } {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let count = 0;
  let largest = 0;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || seen[start] === 1) continue;
    count++;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let size = 0;

    while (top > 0) {
      const i = stack[--top] ?? 0;
      size++;
      const x = i % width;
      const y = (i / width) | 0;
      if (x > 0 && mask[i - 1] === 1 && seen[i - 1] === 0) {
        seen[i - 1] = 1;
        stack[top++] = i - 1;
      }
      if (x < width - 1 && mask[i + 1] === 1 && seen[i + 1] === 0) {
        seen[i + 1] = 1;
        stack[top++] = i + 1;
      }
      if (y > 0 && mask[i - width] === 1 && seen[i - width] === 0) {
        seen[i - width] = 1;
        stack[top++] = i - width;
      }
      if (y < height - 1 && mask[i + width] === 1 && seen[i + width] === 0) {
        seen[i + width] = 1;
        stack[top++] = i + width;
      }
    }
    if (size > largest) largest = size;
  }
  return { count, largest };
}
