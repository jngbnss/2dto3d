// Throwaway smoke test: does the OCCT WASM kernel boot and do real B-rep work?
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const ocFactory = require("replicad-opencascadejs");
const wasmPath = path.resolve("node_modules/replicad-opencascadejs/dist/replicad_single.wasm");
const wasmBinary = fs.readFileSync(wasmPath);

const rc = await import("replicad");

const OC = await ocFactory({ wasmBinary });
rc.setOC(OC);

const box = rc.makeBaseBox(100, 80, 50);
console.log("box volume mm3 =", rc.measureVolume(box));

const cyl = rc.makeCylinder(10, 60, [50, 40, -5], [0, 0, 1]);
const drilled = box.clone().cut(cyl.clone());
console.log("drilled volume mm3 =", rc.measureVolume(drilled));
console.log("expected hole removal =", Math.PI * 100 * 50);

const mesh = drilled.mesh({ tolerance: 0.1, angularTolerance: 20 });
console.log("mesh verts =", mesh.vertices.length / 3, "tris =", mesh.triangles.length / 3);
const edges = drilled.meshEdges({ tolerance: 0.1 });
console.log("edge groups =", edges.lines.length / 3);

// cone via revolution (replicad has no makeCone)
const profile = rc.draw().hLine(20).lineTo([0, 40]).close();
const cone = profile.sketchOnPlane("XZ").revolve([0, 0, 1]);
console.log("cone volume mm3 =", rc.measureVolume(cone), "expected", (Math.PI * 400 * 40) / 3);

const step = rc.exportSTEP([{ shape: drilled, name: "plate" }]);
const stepText = await step.text();
console.log("STEP bytes =", stepText.length, "header ok =", stepText.startsWith("ISO-10303-21"));
console.log("STEP has ADVANCED_FACE =", stepText.includes("ADVANCED_FACE"));

const stl = drilled.blobSTL({ binary: true });
console.log("STL bytes =", (await stl.arrayBuffer()).byteLength);

const filleted = rc.makeBaseBox(40, 40, 40).fillet(4);
console.log("fillet volume =", rc.measureVolume(filleted));
const chamfered = rc.makeBaseBox(40, 40, 40).chamfer(4);
console.log("chamfer volume =", rc.measureVolume(chamfered));
console.log("OK");
