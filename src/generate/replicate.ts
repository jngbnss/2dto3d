import {
  dataUri,
  downloadMesh,
  findMeshUrl,
  pollUntil,
  ProviderError,
  requireCredential,
  type GenerateRequest,
  type GeneratedMesh,
  type MeshProvider,
} from "./provider.ts";

const API = "https://api.replicate.com/v1";
const DEFAULT_MODEL = "firtoz/trellis";
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000;

interface Prediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled" | string;
  output?: unknown;
  error?: string | null;
  urls?: { get?: string };
}

/**
 * Replicate predictions API. `model` is `owner/name` (uses the model's default
 * version) or `owner/name:versionHash` when a specific version is required.
 */
export const replicateProvider: MeshProvider = {
  id: "replicate",
  label: "Replicate (기본 모델 firtoz/trellis)",
  credentialEnv: "REPLICATE_API_TOKEN",

  async generate(request: GenerateRequest): Promise<GeneratedMesh> {
    const token = requireCredential("replicate", "REPLICATE_API_TOKEN");
    const model = request.model ?? DEFAULT_MODEL;
    const [name, version] = model.split(":");
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const input = {
      image: dataUri(request.views.front.bytes, request.views.front.mime),
      images: [dataUri(request.views.front.bytes, request.views.front.mime)],
      ...request.options,
    };

    const endpoint = version ? `${API}/predictions` : `${API}/models/${name}/predictions`;
    const body = version ? { version, input } : { input };
    const createResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!createResponse.ok) {
      throw new ProviderError(
        `Replicate 예측 생성 실패 (${createResponse.status}): ${await createResponse.text()}`,
        "replicate",
      );
    }
    let prediction = (await createResponse.json()) as Prediction;
    const pollUrl = prediction.urls?.get ?? `${API}/predictions/${prediction.id}`;
    request.onProgress?.(`Replicate 예측 ${prediction.id} 생성됨`);

    prediction = await pollUntil<Prediction>(
      async () => {
        const response = await fetch(pollUrl, {
          headers: { Authorization: `Bearer ${token}` },
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (!response.ok) {
          throw new ProviderError(`Replicate 상태 조회 실패 (${response.status})`, "replicate");
        }
        const current = (await response.json()) as Prediction;
        if (current.status === "failed" || current.status === "canceled") {
          throw new ProviderError(
            `Replicate 예측 ${current.status}: ${current.error ?? "사유 없음"}`,
            "replicate",
          );
        }
        return { done: current.status === "succeeded", value: current, status: current.status };
      },
      {
        intervalMs: POLL_INTERVAL_MS,
        timeoutMs: TIMEOUT_MS,
        signal: request.signal,
        onProgress: (status) => request.onProgress?.(`Replicate 상태: ${status}`),
      },
    );

    const mesh = findMeshUrl(prediction.output);
    if (!mesh) {
      throw new ProviderError(
        `Replicate 출력에서 메시 URL을 찾지 못했습니다: ${JSON.stringify(prediction.output).slice(0, 400)}`,
        "replicate",
      );
    }
    request.onProgress?.(`메시 다운로드: ${mesh.url}`);

    return {
      bytes: await downloadMesh(mesh.url, request.signal),
      format: mesh.format,
      provider: "replicate",
      model,
      raw: prediction,
    };
  },
};
