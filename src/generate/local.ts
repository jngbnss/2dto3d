import { ProviderError, type GenerateRequest, type GeneratedMesh, type MeshProvider } from "./provider.ts";

/** Where `tools/hunyuan-local/server.py` listens; override with `SIXVIEW_LOCAL_AI`. */
export function localAiUrl(): string {
  return (process.env["SIXVIEW_LOCAL_AI"]?.trim() || "http://127.0.0.1:8090").replace(/\/+$/, "");
}

const MODEL = "tencent/Hunyuan3D-2mv (local)";
/** Same decode settings as the Space provider so both produce comparable meshes. */
const SETTINGS = { seed: 1234, steps: 5, octree: 256, chunks: 8000 } as const;

/** True when the local server answers its health check within `timeoutMs`. */
export async function localAiAvailable(timeoutMs = 800): Promise<boolean> {
  try {
    const response = await fetch(`${localAiUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Hunyuan3D-2mv running on this machine's GPU (`tools/hunyuan-local`): the
 * model the Space serves, without its quota. Views are sent as the prepared
 * alpha cut-outs; left/right are swapped into Hunyuan's naming exactly as for
 * the Space (see `hunyuan.ts`). The mesh arrives facing +Z.
 */
export const localProvider: MeshProvider = {
  id: "local",
  label: "내 GPU · Hunyuan3D-2mv (무료·무제한, front/back/left/right 4장)",
  multiImage: true,

  async generate(request: GenerateRequest): Promise<GeneratedMesh> {
    const { front, back, left, right } = request.views;
    const encode = (image: typeof front | undefined) => (image ? Buffer.from(image.bytes).toString("base64") : undefined);
    const views = { front: encode(front), back: encode(back), left: encode(right), right: encode(left) };
    request.onProgress?.("내 GPU에서 형상 생성 중…");
    let response: Response;
    try {
      response = await fetch(`${localAiUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ views, ...SETTINGS }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch {
      throw new ProviderError(`로컬 AI 서버(${localAiUrl()})가 꺼져 있습니다. 'npm run ai:local'로 켜세요.`, "local");
    }
    if (!response.ok) {
      const detail = await response.text();
      let message = detail;
      try {
        const parsed: unknown = JSON.parse(detail);
        if (parsed && typeof parsed === "object" && "error" in parsed) message = String(parsed.error);
      } catch {
        // not JSON: keep the raw body
      }
      throw new ProviderError(`로컬 AI 실패 (${response.status}): ${message}`, "local");
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      format: "glb",
      provider: "local",
      model: MODEL,
      raw: SETTINGS,
    };
  },
};
