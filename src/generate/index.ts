import { hunyuanProvider } from "./hunyuan.ts";
import { localProvider } from "./local.ts";
import { trellisProvider } from "./trellis.ts";
import { instantMeshProvider } from "./instantmesh.ts";
import { falProvider } from "./fal.ts";
import { replicateProvider } from "./replicate.ts";
import type { MeshProvider } from "./provider.ts";

/**
 * TRELLIS is the default: multi-image, textured GLB, MIT-licensed upstream.
 * Hunyuan remains available only after explicit license acknowledgement because
 * its community license excludes several territories, including South Korea.
 */
export const PROVIDERS: Record<string, MeshProvider> = {
  hunyuan: hunyuanProvider,
  local: localProvider,
  trellis: trellisProvider,
  instantmesh: instantMeshProvider,
  fal: falProvider,
  replicate: replicateProvider,
};

export const DEFAULT_PROVIDER = "trellis";

/** Provider for the AI method when none is named. */
export async function aiProvider(): Promise<string> {
  const configured = process.env["SIXVIEW_AI_PROVIDER"]?.trim();
  if (configured) return configured;
  return DEFAULT_PROVIDER;
}

export function resolveProvider(id: string): MeshProvider {
  if ((id === "hunyuan" || id === "local") && process.env["SIXVIEW_ENABLE_HUNYUAN"] !== "1") {
    throw new Error(
      "Hunyuan3D-2는 공식 커뮤니티 라이선스의 지역 제한을 확인해야 합니다. " +
      "적용 지역에서만 SIXVIEW_ENABLE_HUNYUAN=1을 설정하세요: https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE",
    );
  }
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `알 수 없는 공급자 '${id}'. 사용 가능: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return provider;
}

export * from "./provider.ts";
