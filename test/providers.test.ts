import { strict as assert } from "node:assert";
import { test } from "node:test";
import { aiProvider, DEFAULT_PROVIDER, resolveProvider } from "../src/generate/index.ts";

test("the default AI provider is the multi-image TRELLIS adapter", async () => {
  const previous = process.env["SIXVIEW_AI_PROVIDER"];
  delete process.env["SIXVIEW_AI_PROVIDER"];
  try {
    assert.equal(DEFAULT_PROVIDER, "trellis");
    assert.equal(await aiProvider(), "trellis");
    assert.equal(resolveProvider("trellis").multiImage, true);
  } finally {
    if (previous === undefined) delete process.env["SIXVIEW_AI_PROVIDER"];
    else process.env["SIXVIEW_AI_PROVIDER"] = previous;
  }
});

test("Hunyuan providers require explicit license acknowledgement", () => {
  const previous = process.env["SIXVIEW_ENABLE_HUNYUAN"];
  delete process.env["SIXVIEW_ENABLE_HUNYUAN"];
  try {
    assert.throws(() => resolveProvider("hunyuan"), /지역 제한/);
    assert.throws(() => resolveProvider("local"), /지역 제한/);
    process.env["SIXVIEW_ENABLE_HUNYUAN"] = "1";
    assert.equal(resolveProvider("hunyuan").id, "hunyuan");
    assert.equal(resolveProvider("local").id, "local");
  } finally {
    if (previous === undefined) delete process.env["SIXVIEW_ENABLE_HUNYUAN"];
    else process.env["SIXVIEW_ENABLE_HUNYUAN"] = previous;
  }
});
