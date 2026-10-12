import { computeBounds, type Mesh } from "./types.ts";

/**
 * Minimal glTF 2.0 / GLB reader: triangle geometry, vertex colours, and node
 * transforms. Materials, textures, skins, and animation are ignored because the
 * six-view analysis only consumes silhouettes and flat vertex colour.
 */

const MAGIC_GLTF = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const MODE_TRIANGLES = 4;

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

interface GltfJson {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; mode?: number }> }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  buffers?: Array<{ byteLength: number; uri?: string }>;
}

type Mat4 = Float64Array;

export function parseGlb(bytes: Uint8Array): Mesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 4 && view.getUint32(0, true) === MAGIC_GLTF) {
    const { json, bin } = splitChunks(bytes, view);
    return buildMesh(json, bin);
  }
  // Plain .gltf: embedded data: URIs only, since external .bin paths are not
  // resolvable from a downloaded buffer.
  const json = JSON.parse(new TextDecoder().decode(bytes)) as GltfJson;
  return buildMesh(json, null);
}

function splitChunks(bytes: Uint8Array, view: DataView): { json: GltfJson; bin: Uint8Array | null } {
  const total = view.getUint32(8, true);
  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;

  while (offset + 8 <= Math.min(total, bytes.byteLength)) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.byteLength) break;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end))) as GltfJson;
    } else if (type === CHUNK_BIN) {
      bin = bytes.subarray(start, end);
    }
    offset = end + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error("GLB에 JSON 청크가 없습니다.");
  return { json, bin };
}

function buildMesh(json: GltfJson, bin: Uint8Array | null): Mesh {
  const buffers = (json.buffers ?? []).map((buffer, index) => {
    if (buffer.uri === undefined) {
      if (!bin) throw new Error(`버퍼 ${index}가 GLB BIN 청크를 참조하지만 청크가 없습니다.`);
      return bin;
    }
    const match = /^data:[^;]*;base64,(.*)$/.exec(buffer.uri);
    if (!match?.[1]) {
      throw new Error(`외부 버퍼 URI는 지원하지 않습니다 (${buffer.uri.slice(0, 40)}). GLB로 내보내세요.`);
    }
    return new Uint8Array(Buffer.from(match[1], "base64"));
  });

  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  let anyColor = false;

  const nodes = json.nodes ?? [];
  const sceneIndex = json.scene ?? 0;
  const roots = json.scenes?.[sceneIndex]?.nodes ?? nodes.map((_, i) => i);
  const visited = new Set<number>();

  const walk = (nodeIndex: number, parent: Mat4): void => {
    const node = nodes[nodeIndex];
    if (!node || visited.has(nodeIndex)) return;
    visited.add(nodeIndex);
    const world = multiply(parent, localMatrix(node));

    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      for (const primitive of mesh?.primitives ?? []) {
        if ((primitive.mode ?? MODE_TRIANGLES) !== MODE_TRIANGLES) continue;
        const positionAccessor = primitive.attributes["POSITION"];
        if (positionAccessor === undefined) continue;

        const verts = readAccessor(json, buffers, positionAccessor);
        const base = positions.length / 3;
        for (let i = 0; i + 2 < verts.length; i += 3) {
          const x = verts[i] ?? 0;
          const y = verts[i + 1] ?? 0;
          const z = verts[i + 2] ?? 0;
          positions.push(
            (world[0] ?? 1) * x + (world[4] ?? 0) * y + (world[8] ?? 0) * z + (world[12] ?? 0),
            (world[1] ?? 0) * x + (world[5] ?? 1) * y + (world[9] ?? 0) * z + (world[13] ?? 0),
            (world[2] ?? 0) * x + (world[6] ?? 0) * y + (world[10] ?? 1) * z + (world[14] ?? 0),
          );
        }

        const colorAccessor = primitive.attributes["COLOR_0"];
        const vertexCount = verts.length / 3;
        if (colorAccessor !== undefined) {
          anyColor = true;
          const raw = readAccessor(json, buffers, colorAccessor);
          const stride = (json.accessors?.[colorAccessor]?.type ?? "VEC3") === "VEC4" ? 4 : 3;
          for (let i = 0; i < vertexCount; i++) {
            colors.push(raw[i * stride] ?? 1, raw[i * stride + 1] ?? 1, raw[i * stride + 2] ?? 1);
          }
        } else {
          for (let i = 0; i < vertexCount; i++) colors.push(1, 1, 1);
        }

        if (primitive.indices === undefined) {
          for (let i = 0; i < vertexCount; i++) indices.push(base + i);
        } else {
          const raw = readAccessor(json, buffers, primitive.indices);
          for (let i = 0; i < raw.length; i++) indices.push(base + (raw[i] ?? 0));
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };

  for (const root of roots) walk(root, identity());

  if (positions.length === 0) throw new Error("GLB에서 삼각형 지오메트리를 찾지 못했습니다.");
  const positionArray = Float32Array.from(positions);
  return {
    positions: positionArray,
    indices: Uint32Array.from(indices),
    colors: anyColor ? Float32Array.from(colors) : new Float32Array(0),
    bounds: computeBounds(positionArray),
  };
}

function readAccessor(json: GltfJson, buffers: Uint8Array[], index: number): Float64Array {
  const accessor = json.accessors?.[index];
  if (!accessor) throw new Error(`accessor ${index}가 없습니다.`);
  const components = TYPE_COMPONENTS[accessor.type];
  const componentSize = COMPONENT_SIZE[accessor.componentType];
  if (!components || !componentSize) {
    throw new Error(`지원하지 않는 accessor 형식: ${accessor.type}/${accessor.componentType}`);
  }
  const out = new Float64Array(accessor.count * components);
  if (accessor.bufferView === undefined) return out;

  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`bufferView ${accessor.bufferView}가 없습니다.`);
  const buffer = buffers[bufferView.buffer];
  if (!buffer) throw new Error(`buffer ${bufferView.buffer}가 없습니다.`);

  const elementSize = components * componentSize;
  const stride = bufferView.byteStride && bufferView.byteStride > 0 ? bufferView.byteStride : elementSize;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) {
      const at = start + i * stride + c * componentSize;
      out[i * components + c] = readComponent(view, at, accessor.componentType, accessor.normalized === true);
    }
  }
  return out;
}

function readComponent(view: DataView, at: number, componentType: number, normalized: boolean): number {
  switch (componentType) {
    case 5120: {
      const value = view.getInt8(at);
      return normalized ? Math.max(value / 127, -1) : value;
    }
    case 5121: {
      const value = view.getUint8(at);
      return normalized ? value / 255 : value;
    }
    case 5122: {
      const value = view.getInt16(at, true);
      return normalized ? Math.max(value / 32767, -1) : value;
    }
    case 5123: {
      const value = view.getUint16(at, true);
      return normalized ? value / 65535 : value;
    }
    case 5125:
      return view.getUint32(at, true);
    case 5126:
      return view.getFloat32(at, true);
    default:
      throw new Error(`알 수 없는 componentType ${componentType}`);
  }
}

function identity(): Mat4 {
  return Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
}

/** Column-major, matching glTF's node.matrix layout. */
function localMatrix(node: { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }): Mat4 {
  if (node.matrix && node.matrix.length === 16) return Float64Array.from(node.matrix);

  const [tx, ty, tz] = [node.translation?.[0] ?? 0, node.translation?.[1] ?? 0, node.translation?.[2] ?? 0];
  const [qx, qy, qz, qw] = [
    node.rotation?.[0] ?? 0,
    node.rotation?.[1] ?? 0,
    node.rotation?.[2] ?? 0,
    node.rotation?.[3] ?? 1,
  ];
  const [sx, sy, sz] = [node.scale?.[0] ?? 1, node.scale?.[1] ?? 1, node.scale?.[2] ?? 1];

  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  return Float64Array.of(
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  );
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
