import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const ocFactory = require("replicad-opencascadejs");
const wasmBinary = fs.readFileSync(path.resolve("node_modules/replicad-opencascadejs/dist/replicad_single.wasm"));
const rc = await import("replicad");
rc.setOC(await ocFactory({ wasmBinary }));

const bb = (s) => {
  const [min, max] = s.boundingBox.bounds;
  return `min=${min.map((v) => v.toFixed(1))} max=${max.map((v) => v.toFixed(1))}`;
};
console.log("makeBaseBox(100,80,50) ", bb(rc.makeBaseBox(100, 80, 50)));
console.log("makeCylinder(10,60)    ", bb(rc.makeCylinder(10, 60)));
console.log("makeSphere(25)         ", bb(rc.makeSphere(25)));
const cone = rc.draw().hLine(20).lineTo([0, 40]).close().sketchOnPlane("XZ").revolve([0, 0, 1]);
console.log("revolved cone(20,40)   ", bb(cone));
const ext = rc.draw().hLine(30).vLine(20).hLine(-30).close().sketchOnPlane("XY").extrude(10);
console.log("extrude rect 30x20x10  ", bb(ext), "vol", rc.measureVolume(ext));
console.log("area", rc.measureArea(rc.makeBaseBox(10, 10, 10)));
