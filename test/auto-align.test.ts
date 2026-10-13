import { strict as assert } from "node:assert";
import { test } from "node:test";
import { restoreAutomaticPlacement } from "../src/orientation.ts";

test("automatic placement reset preserves orientation and crop", () => {
  const transform = {
    rotation: 270 as const,
    flip: true,
    scale: 1.63,
    offsetX: -0.12,
    offsetY: 0.08,
    crop: { left: 0.03, top: 0.04, right: 0.05, bottom: 0.06 },
  };

  assert.deepEqual(restoreAutomaticPlacement(transform), {
    ...transform,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });
});
