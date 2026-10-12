import sharp from "sharp";
import { readFile } from "node:fs/promises";

/** Decoded RGBA image resampled to the analysis resolution. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly data: Uint8Array;
  /** True when the source image carried a real (non-opaque) alpha channel. */
  readonly hadAlpha: boolean;
  readonly source: { readonly width: number; readonly height: number };
}

export const ANALYSIS_SIZE = 512;

/**
 * Views are compared as fractions of their own frame, so every image is resampled
 * to one square canvas. `fit: "fill"` would distort aspect ratio and corrupt the
 * extent measurements, so non-square sources are letterboxed instead.
 */
export async function loadRaster(input: string | Uint8Array, size = ANALYSIS_SIZE): Promise<Raster> {
  const bytes = typeof input === "string" ? await readFile(input) : input;
  const image = sharp(bytes, { failOn: "error" });
  const meta = await image.metadata();

  const { data, info } = await image
    .clone()
    .ensureAlpha()
    .resize(size, size, {
      fit: "contain",
      kernel: "lanczos3",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hadAlpha = meta.hasAlpha === true && (await hasTransparentPixel(bytes));

  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    hadAlpha,
    source: { width: meta.width ?? info.width, height: meta.height ?? info.height },
  };
}

/**
 * `metadata.hasAlpha` only reports that a channel exists; fully opaque alpha is
 * common in generated PNGs and must fall back to background-colour keying.
 */
async function hasTransparentPixel(bytes: Uint8Array): Promise<boolean> {
  const { data } = await sharp(bytes)
    .ensureAlpha()
    .resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a !== undefined && a < 250) return true;
  }
  return false;
}

export async function encodePng(raster: Raster): Promise<Buffer> {
  return sharp(Buffer.from(raster.data), {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  })
    .png()
    .toBuffer();
}
