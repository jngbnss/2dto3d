import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import type { CadDocument, CadObject, Transform, Vec3 } from "./types";

const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3();
const _euler = new Euler();

export function cloneTransform(t: Transform): Transform {
  return { position: [...t.position] as Vec3, rotation: [...t.rotation] as Vec3 };
}

/** Transform -> Matrix4, matching three.js Euler order "XYZ". */
export function transformToMatrix(t: Transform, out = new Matrix4()): Matrix4 {
  _euler.set(
    MathUtils.degToRad(t.rotation[0]),
    MathUtils.degToRad(t.rotation[1]),
    MathUtils.degToRad(t.rotation[2]),
    "XYZ",
  );
  return out.compose(
    _pos.set(t.position[0], t.position[1], t.position[2]),
    _quat.setFromEuler(_euler),
    _scale.set(1, 1, 1),
  );
}

export function matrixToTransform(m: Matrix4): Transform {
  m.decompose(_pos, _quat, _scale);
  _euler.setFromQuaternion(_quat, "XYZ");
  return {
    position: [round(_pos.x), round(_pos.y), round(_pos.z)],
    rotation: [
      round(MathUtils.radToDeg(_euler.x)),
      round(MathUtils.radToDeg(_euler.y)),
      round(MathUtils.radToDeg(_euler.z)),
    ],
  };
}

/** 1e-9 mm / 1e-9 deg is far below any manufacturable tolerance. */
function round(v: number): number {
  return Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(9));
}

/**
 * Accumulated placement of an object, walking up through its groups. Groups add
 * rotation+translation only, so the result is always decomposable back to a
 * Transform without shear.
 */
export function worldTransform(doc: CadDocument, objectId: string): Transform {
  const chain: CadObject[] = [];
  let current: CadObject | undefined = doc.objects[objectId];
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    chain.push(current);
    current = current.parentId ? doc.objects[current.parentId] : undefined;
  }
  const m = new Matrix4();
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    m.multiply(transformToMatrix(chain[i].transform));
  }
  return matrixToTransform(m);
}

export function composeTransforms(parent: Transform, child: Transform): Transform {
  const m = transformToMatrix(parent).multiply(transformToMatrix(child, new Matrix4()));
  return matrixToTransform(m);
}

/** child transform expressed relative to a new parent frame. */
export function relativeTransform(world: Transform, parentWorld: Transform): Transform {
  const inv = transformToMatrix(parentWorld).invert();
  return matrixToTransform(inv.multiply(transformToMatrix(world, new Matrix4())));
}
