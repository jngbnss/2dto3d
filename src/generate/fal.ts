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

const QUEUE = "https://queue.fal.run";
const DEFAULT_MODEL = "fal-ai/hunyuan3d/v2";
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000;

interface QueueSubmit {
  request_id: string;
  status_url?: string;
  response_url?: string;
}

interface QueueStatus {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | string;
  queue_position?: number;
}

/**
 * fal.ai queue API. Image-to-3D endpoints return a mesh asset; the six canonical
 * views are rendered locally from it so that the projections are exactly
 * orthographic instead of whatever framing a diffusion model happened to pick.
 */
export const falProvider: MeshProvider = {
  id: "fal",
  label: "fal.ai (기본 모델 hunyuan3d/v2)",
  credentialEnv: "FAL_KEY",

  async generate(request: GenerateRequest): Promise<GeneratedMesh> {
    const key = requireCredential("fal", "FAL_KEY");
    const model = request.model ?? DEFAULT_MODEL;
    const headers = {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
    };

    const submitResponse = await fetch(`${QUEUE}/${model}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input_image_url: dataUri(request.image, request.mime),
        image_url: dataUri(request.image, request.mime),
        ...request.options,
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!submitResponse.ok) {
      throw new ProviderError(
        `fal 작업 제출 실패 (${submitResponse.status}): ${await submitResponse.text()}`,
        "fal",
      );
    }
    const submit = (await submitResponse.json()) as QueueSubmit;
    const statusUrl = submit.status_url ?? `${QUEUE}/${model}/requests/${submit.request_id}/status`;
    const resultUrl = submit.response_url ?? `${QUEUE}/${model}/requests/${submit.request_id}`;
    request.onProgress?.(`fal 요청 ${submit.request_id} 제출됨`);

    await pollUntil<void>(
      async () => {
        const response = await fetch(statusUrl, {
          headers: { Authorization: `Key ${key}` },
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (!response.ok) {
          throw new ProviderError(`fal 상태 조회 실패 (${response.status})`, "fal");
        }
        const status = (await response.json()) as QueueStatus;
        const label =
          status.status === "IN_QUEUE" && status.queue_position !== undefined
            ? `IN_QUEUE(${status.queue_position})`
            : status.status;
        return { done: status.status === "COMPLETED", status: label };
      },
      {
        intervalMs: POLL_INTERVAL_MS,
        timeoutMs: TIMEOUT_MS,
        signal: request.signal,
        onProgress: (status) => request.onProgress?.(`fal 상태: ${status}`),
      },
    );

    const resultResponse = await fetch(resultUrl, {
      headers: { Authorization: `Key ${key}` },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!resultResponse.ok) {
      throw new ProviderError(`fal 결과 조회 실패 (${resultResponse.status})`, "fal");
    }
    const payload = await resultResponse.json();
    const mesh = findMeshUrl(payload);
    if (!mesh) {
      throw new ProviderError(
        `fal 응답에서 메시 URL을 찾지 못했습니다: ${JSON.stringify(payload).slice(0, 400)}`,
        "fal",
      );
    }
    request.onProgress?.(`메시 다운로드: ${mesh.url}`);

    return {
      bytes: await downloadMesh(mesh.url, request.signal),
      format: mesh.format,
      provider: "fal",
      model,
      raw: payload,
    };
  },
};
