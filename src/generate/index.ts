import { instantMeshProvider } from "./instantmesh.ts";
import { falProvider } from "./fal.ts";
import { replicateProvider } from "./replicate.ts";
import type { MeshProvider } from "./provider.ts";

/** First entry is the default: it needs no credential. */
export const PROVIDERS: Record<string, MeshProvider> = {
  instantmesh: instantMeshProvider,
  fal: falProvider,
  replicate: replicateProvider,
};

export const DEFAULT_PROVIDER = "instantmesh";

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
