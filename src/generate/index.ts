import { hunyuanProvider } from "./hunyuan.ts";
import { trellisProvider } from "./trellis.ts";
import { instantMeshProvider } from "./instantmesh.ts";
import { falProvider } from "./fal.ts";
import { replicateProvider } from "./replicate.ts";
import type { MeshProvider } from "./provider.ts";

/**
 * First entry is the default: no credential, conditions on all four named views.
 * TRELLIS stays as the textured alternative.
 */
export const PROVIDERS: Record<string, MeshProvider> = {
  hunyuan: hunyuanProvider,
  trellis: trellisProvider,
  instantmesh: instantMeshProvider,
  fal: falProvider,
  replicate: replicateProvider,
};

export const DEFAULT_PROVIDER = "hunyuan";

export function resolveProvider(id: string): MeshProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `알 수 없는 공급자 '${id}'. 사용 가능: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return provider;
}

export * from "./provider.ts";
