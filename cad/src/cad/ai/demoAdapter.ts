import type { AiModelDescriptor, AiPipelineAdapter } from "./aiAdapter";

/**
 * Stand-in for a 2D→3D generator, used when no pipeline URL is configured.
 *
 * It exists for one reason beyond convenience: entry `bracket-preview-only`
 * reproduces the failure mode this editor must handle correctly — a result that
 * has six orthographic renders and no geometry at all. Importing it is blocked,
 * which is the behaviour a real pipeline needs too.
 */

function svgDataUri(label: string, bg: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="${bg}"/><text x="80" y="64" font-family="monospace" font-size="16" fill="#dfe7f2" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const VIEWS = ["front", "back", "left", "right", "top", "bottom"] as const;

function orthoViews(label: string): AiModelDescriptor["orthoViews"] {
  return Object.fromEntries(VIEWS.map((v) => [v, svgDataUri(`${label} · ${v}`, "#232c3a")])) as AiModelDescriptor["orthoViews"];
}

/** Binary STL of an axis-aligned box, so the demo mesh is genuine geometry. */
function boxSTL(w: number, d: number, h: number): ArrayBuffer {
  const corners: [number, number, number][] = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ];
  const faces: [number, number, number][] = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buffer = new ArrayBuffer(84 + faces.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, faces.length, true);
  let offset = 84;
  for (const [a, b, c] of faces) {
    const [ax, ay, az] = corners[a];
    const [bx, by, bz] = corners[b];
    const [cx, cy, cz] = corners[c];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const value of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return buffer;
}

export function createDemoAdapter(): AiPipelineAdapter {
  const entries: AiModelDescriptor[] = [
    {
      id: "bracket-mesh",
      name: "Generated bracket (mesh)",
      createdAt: Date.now() - 60_000,
      orthoViews: orthoViews("bracket"),
      asset: { kind: "mesh", format: "stl", data: boxSTL(60, 40, 12) },
      meta: { generator: "demo-2d-to-3d", topology: "triangle mesh", triangles: 12 },
    },
    {
      id: "bracket-preview-only",
      name: "Generated bracket (previews only)",
      createdAt: Date.now() - 30_000,
      orthoViews: orthoViews("preview"),
      asset: null,
      meta: { generator: "demo-2d-to-3d", stage: "multi-view diffusion", note: "reconstruction not run" },
    },
  ];
  return {
    id: "demo",
    label: "Demo generator",
    description:
      "Sample 2D→3D results. No pipeline URL is configured (set VITE_AI_PIPELINE_URL to connect a real generator).",
    async list() {
      return entries;
    },
    async load(id) {
      const found = entries.find((e) => e.id === id);
      if (!found) throw new Error("Unknown demo result");
      return found;
    },
  };
}
