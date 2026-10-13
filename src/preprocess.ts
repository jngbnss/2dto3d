import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { VIEW_IDS, type ViewId } from "./views.ts";
import { IDENTITY_TRANSFORM, type ViewTransform, type ViewTransforms } from "./orientation.ts";
import { solveAlignment, type Alignment } from "./alignment.ts";
import { ANALYSIS_SIZE, type Raster } from "./analyze/raster.ts";
import { extractSilhouette, type BBox, type Silhouette } from "./analyze/silhouette.ts";
import type { ViewSample } from "./analyze/types.ts";

/**
 * Image preprocessing: raw upload -> oriented cut-out -> aligned image on the
 * common square canvas that every later stage reads.
 *
 * 1. load, apply the user's rotation / flip / crop
 * 2. mask the subject (alpha, else border-flood background key) and cut it out
 * 3. measure its bounding box
 * 4. solve one common world scale across all views (`alignment.ts`)
 * 5. place every subject centred on a `PREPARED_SIZE` canvas at that scale,
 *    then apply the user's scale and offset
 * 6. re-measure the silhouette on the prepared canvas at `ANALYSIS_SIZE`
 *
 * After step 5 one world unit spans the same number of pixels in every view and
 * the world origin sits at every canvas centre — the contract carving relies on.
 */

/** Side of the prepared canvas written for display and colour sampling. */
export const PREPARED_SIZE = 1024;
/** Share of the prepared canvas the longest world axis spans. */
const FILL = 0.8;
/** Longest side oriented images are reduced to before masking. */
const WORK_SIZE = 1024;
/** Sources whose longest side is below this are flagged as too small. */
export const MIN_SOURCE_SIZE = 256;

export interface PreparedView extends ViewSample {
  readonly transform: ViewTransform;
  /** Original upload size in pixels. */
  readonly source: { readonly width: number; readonly height: number };
  /** False when the upload had no usable alpha and the background was keyed out. */
  readonly hadAlpha: boolean;
  /** Prepared canvas, PNG, `PREPARED_SIZE` square. */
  readonly png: Buffer;
  /** Prepared canvas pixels, for colour sampling. */
  readonly prepared: Raster;
  /** Fraction of the subject that fell outside the prepared canvas (0 = none). */
  readonly clipped: number;
  /** Subject pixels touching the edge of the (oriented, cropped) upload: the object is cut off. */
  readonly cutOffPixels: number;
  /** Perimeter of the oriented upload in pixels, to judge `cutOffPixels`. */
  readonly perimeter: number;
}

export interface PreparedSet {
  readonly views: ReadonlyMap<ViewId, PreparedView>;
  readonly missing: readonly ViewId[];
  readonly alignment: Alignment;
  /** Pixels per world unit on the `ANALYSIS_SIZE` silhouettes (`views[].silhouette`). */
  readonly pixelsPerUnit: number;
}

interface Oriented {
  readonly id: ViewId;
  readonly path: string;
  readonly transform: ViewTransform;
  readonly source: { readonly width: number; readonly height: number };
  readonly raster: Raster;
  readonly silhouette: Silhouette;
}

export async function prepareViewSet(
  paths: Readonly<Partial<Record<ViewId, string>>>,
  transforms: ViewTransforms = {},
): Promise<PreparedSet> {
  const oriented = new Map<ViewId, Oriented>();
  await Promise.all(
    VIEW_IDS.map(async (id) => {
      const path = paths[id];
      if (!path) return;
      oriented.set(id, await orient(id, path, transforms[id] ?? IDENTITY_TRANSFORM));
    }),
  );
  const missing = VIEW_IDS.filter((id) => !oriented.has(id));

  const extents = new Map(
    [...oriented].flatMap(([id, view]) => {
      const box = view.silhouette.bbox;
      return box ? [[id, { width: box.x1 - box.x0, height: box.y1 - box.y0 }] as const] : [];
    }),
  );
  const alignment = solveAlignment(extents);
  const pixelsPerUnit = PREPARED_SIZE * FILL;

  const views = new Map<ViewId, PreparedView>();
  await Promise.all(
    [...oriented.values()].map(async (view) => {
      const scale = alignment.scale[view.id];
      views.set(view.id, await place(view, scale === undefined ? 0 : scale * pixelsPerUnit));
    }),
  );
  return {
    views: new Map(VIEW_IDS.flatMap((id) => (views.has(id) ? [[id, views.get(id)!] as const] : []))),
    missing,
    alignment,
    pixelsPerUnit: (pixelsPerUnit * ANALYSIS_SIZE) / PREPARED_SIZE,
  };
}

/** Steps 1–3: orientation, crop, cut-out, measurement. */
async function orient(id: ViewId, path: string, transform: ViewTransform): Promise<Oriented> {
  const bytes = await readFile(path);
  const meta = await sharp(bytes).metadata();
  let image = sharp(bytes).rotate(transform.rotation);
  if (transform.flip) image = image.flop();
  const turned = await image.png().toBuffer({ resolveWithObject: true });
  const { width, height } = turned.info;

  const left = Math.round(transform.crop.left * width);
  const top = Math.round(transform.crop.top * height);
  const cropWidth = Math.max(1, width - left - Math.round(transform.crop.right * width));
  const cropHeight = Math.max(1, height - top - Math.round(transform.crop.bottom * height));
  const { data, info } = await sharp(turned.data)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(WORK_SIZE, WORK_SIZE, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let hadAlpha = false;
  for (let p = 3; p < pixels.length; p += 4) {
    if ((pixels[p] ?? 255) < 250) {
      hadAlpha = true;
      break;
    }
  }
  const raster: Raster = {
    width: info.width,
    height: info.height,
    data: pixels,
    hadAlpha,
    source: { width: meta.width ?? info.width, height: meta.height ?? info.height },
  };
  const silhouette = extractSilhouette(raster);
  if (!hadAlpha) despill(raster, silhouette.mask);
  // Cut the subject out so every later stage sees clean alpha, keyed or not.
  for (let i = 0; i < silhouette.mask.length; i++) {
    if (silhouette.mask[i] !== 1) pixels[i * 4 + 3] = 0;
  }
  return { id, path, transform, source: raster.source, raster, silhouette };
}

/** Edge band, in pixels, where a keyed background bleeds into the subject. */
const SPILL_BAND = 3;
/** A background counts as a chroma key when one channel leads the others by this much. */
const KEY_DOMINANCE = 60;

/**
 * Removes chroma-key spill (green or blue fringes) from the subject's edge band:
 * the key's dominant channel is capped at the larger of the other two, the
 * standard keyer despill. White or grey backgrounds have no dominant channel and
 * are left alone.
 */
function despill(raster: Raster, mask: Uint8Array): void {
  const { width, height, data } = raster;
  const key = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1) continue;
    for (let c = 0; c < 3; c++) key[c] = (key[c] ?? 0) + (data[i * 4 + c] ?? 0);
    count++;
  }
  if (count === 0) return;
  const mean = key.map((value) => value / count);
  const dominant = mean.indexOf(Math.max(...mean));
  const others = [0, 1, 2].filter((c) => c !== dominant);
  if ((mean[dominant] ?? 0) - Math.max(...others.map((c) => mean[c] ?? 0)) < KEY_DOMINANCE) return;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] !== 1 || !nearBackground(mask, width, height, x, y, SPILL_BAND)) continue;
      const p = i * 4;
      const cap = Math.max(...others.map((c) => data[p + c] ?? 0));
      if ((data[p + dominant] ?? 0) > cap) data[p + dominant] = cap;
    }
  }
}

function nearBackground(mask: Uint8Array, width: number, height: number, x: number, y: number, radius: number): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || mask[ny * width + nx] !== 1) return true;
    }
  }
  return false;
}

/** Steps 5–6: place the cut-out on the common canvas and re-measure it. */
async function place(view: Oriented, canvasPixelsPerImagePixel: number): Promise<PreparedView> {
  const size = PREPARED_SIZE;
  const box = view.silhouette.bbox;
  const factor = canvasPixelsPerImagePixel * view.transform.scale;
  const layers: sharp.OverlayOptions[] = [];
  let clipped = 0;

  if (box && factor > 0) {
    const cutout = sharp(Buffer.from(view.raster.data), {
      raw: { width: view.raster.width, height: view.raster.height, channels: 4 },
    }).extract({ left: box.x0, top: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 });
    const width = Math.max(1, Math.round((box.x1 - box.x0) * factor));
    const height = Math.max(1, Math.round((box.y1 - box.y0) * factor));
    const left = Math.round(size / 2 + view.transform.offsetX * size - width / 2);
    const top = Math.round(size / 2 + view.transform.offsetY * size - height / 2);

    // sharp refuses overlays that leave the base image, so keep only the visible window.
    const visible = clip({ x0: left, y0: top, x1: left + width, y1: top + height }, size);
    if (visible) {
      clipped = 1 - ((visible.x1 - visible.x0) * (visible.y1 - visible.y0)) / (width * height);
      const scaled = await cutout.resize(width, height, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
      const window = await sharp(scaled)
        .extract({ left: visible.x0 - left, top: visible.y0 - top, width: visible.x1 - visible.x0, height: visible.y1 - visible.y0 })
        .png()
        .toBuffer();
      layers.push({ input: window, left: visible.x0, top: visible.y0 });
    } else {
      clipped = 1;
    }
  }

  const png = await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
  const prepared = await decode(png, size);
  const raster = await decode(png, ANALYSIS_SIZE);
  return {
    id: view.id,
    path: view.path,
    transform: view.transform,
    source: view.source,
    hadAlpha: view.raster.hadAlpha,
    png,
    prepared,
    raster,
    // Prepared canvases always carry real alpha: the cut-out made it so.
    silhouette: extractSilhouette(raster),
    clipped,
    cutOffPixels: view.silhouette.borderPixels,
    perimeter: 2 * (view.raster.width + view.raster.height),
  };
}

function clip(box: BBox, size: number): BBox | null {
  const x0 = Math.max(0, box.x0);
  const y0 = Math.max(0, box.y0);
  const x1 = Math.min(size, box.x1);
  const y1 = Math.min(size, box.y1);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

async function decode(png: Buffer, size: number): Promise<Raster> {
  const { data, info } = await sharp(png)
    .resize(size, size, { kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    hadAlpha: true,
    source: { width: size, height: size },
  };
}

/** Transparent PNG with the silhouette's boundary pixels drawn, for the alignment overlay. */
export async function outlinePng(silhouette: Silhouette): Promise<Buffer> {
  const { width, height, mask } = silhouette;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] !== 1) continue;
      const edge =
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        mask[i - 1] !== 1 || mask[i + 1] !== 1 || mask[i - width] !== 1 || mask[i + width] !== 1;
      if (!edge) continue;
      out.set([52, 211, 153, 255], i * 4);
    }
  }
  return sharp(Buffer.from(out), { raw: { width, height, channels: 4 } }).png().toBuffer();
}
