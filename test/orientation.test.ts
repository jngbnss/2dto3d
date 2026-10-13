import { strict as assert } from "node:assert";
import { test } from "node:test";
import { boxMesh } from "../src/mesh/primitives.ts";
import { renderViews } from "../src/render/ortho.ts";
import type { ViewId } from "../src/views.ts";

const SIZE = 128;
const SCALE = 30;

function alphaCenter(pixels: Uint8Array): { x: number; y: number } {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if ((pixels[(y * SIZE + x) * 4 + 3] ?? 0) < 128) continue;
      count++;
      sumX += x + 0.5;
      sumY += y + 0.5;
    }
  }
  assert.ok(count > 0);
  return { x: sumX / count, y: sumY / count };
}

test("all render views follow the canonical XYZ camera table", () => {
  const mesh = boxMesh({ size: [0.2, 0.2, 0.2], at: [0.45, 0.3, 0.2] });
  const views = renderViews(mesh, { size: SIZE, pixelsPerUnit: SCALE });
  const center = Object.fromEntries(
    Object.entries(views).map(([id, view]) => [id, alphaCenter(view.pixels)]),
  ) as Record<ViewId, { x: number; y: number }>;
  const mid = SIZE / 2;

  assert.ok(center.front.x > mid && center.front.y < mid, "front: +X right, +Y up");
  assert.ok(center.back.x < mid && center.back.y < mid, "back: +X left, +Y up");
  assert.ok(center.left.x > mid && center.left.y < mid, "left: +Z right, +Y up");
  assert.ok(center.right.x < mid && center.right.y < mid, "right: +Z left, +Y up");
  assert.ok(center.top.x > mid && center.top.y > mid, "top: +X right, +Z down");
});
