import type { MeshFormat } from "../mesh/types.ts";

export interface GenerateRequest {
  /** Source 2D image bytes. */
  readonly image: Uint8Array;
  /** MIME type of `image`, e.g. `image/png`. */
  readonly mime: string;
  /** Provider-specific model id; each provider documents its default. */
  readonly model?: string | undefined;
  /** Extra provider input fields merged into the request body. */
  readonly options?: Readonly<Record<string, unknown>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((message: string) => void) | undefined;
}

export interface GeneratedMesh {
  readonly bytes: Uint8Array;
  readonly format: MeshFormat;
  readonly provider: string;
  readonly model: string;
  /** Raw provider payload, kept for debugging and for the web surface. */
  readonly raw: unknown;
}

export interface MeshProvider {
  readonly id: string;
  readonly label: string;
  /** Environment variable holding the credential; omitted when none is needed. */
  readonly credentialEnv?: string;
  generate(request: GenerateRequest): Promise<GeneratedMesh>;
}

export class ProviderError extends Error {
  readonly provider: string;

  constructor(message: string, provider: string) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

export class MissingCredentialError extends ProviderError {
  constructor(provider: string, env: string) {
    super(
      `${provider} 공급자에 자격 증명이 없습니다. 환경 변수 ${env}를 설정하세요.`,
      provider,
    );
    this.name = "MissingCredentialError";
  }
}

export function requireCredential(provider: string, env: string): string {
  const value = process.env[env];
  if (!value) throw new MissingCredentialError(provider, env);
  return value;
}

export function dataUri(image: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(image).toString("base64")}`;
}

const MESH_EXTENSIONS: Record<string, MeshFormat> = {
  ".glb": "glb",
  ".gltf": "glb",
  ".obj": "obj",
};

/** Walks an arbitrary provider payload and returns the first mesh URL it finds. */
export function findMeshUrl(payload: unknown): { url: string; format: MeshFormat } | null {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const node = queue.shift();
    if (typeof node === "string") {
      const clean = node.split("?")[0] ?? node;
      const dot = clean.lastIndexOf(".");
      const format = dot >= 0 ? MESH_EXTENSIONS[clean.slice(dot).toLowerCase()] : undefined;
      if (format && /^https?:\/\//.test(node)) return { url: node, format };
    } else if (Array.isArray(node)) {
      queue.push(...node);
    } else if (node && typeof node === "object") {
      queue.push(...Object.values(node));
    }
  }
  return null;
}

export async function downloadMesh(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) {
    throw new Error(`메시 다운로드 실패 (${response.status} ${response.statusText}): ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function pollUntil<T>(
  poll: () => Promise<{ done: boolean; value?: T; status: string }>,
  options: { intervalMs: number; timeoutMs: number; signal?: AbortSignal | undefined; onProgress?: ((message: string) => void) | undefined },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let last = "";
  for (;;) {
    const result = await poll();
    if (result.status !== last) {
      last = result.status;
      options.onProgress?.(result.status);
    }
    if (result.done) return result.value as T;
    if (Date.now() > deadline) throw new Error(`작업이 ${options.timeoutMs / 1000}초 안에 끝나지 않았습니다 (마지막 상태: ${last}).`);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, options.intervalMs);
    options.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("작업이 취소되었습니다."));
      },
      { once: true },
    );
    await promise;
  }
}
