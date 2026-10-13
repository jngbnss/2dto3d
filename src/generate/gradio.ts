/**
 * Minimal Gradio Space client.
 *
 * The public `/gradio_api/call/...` REST shortcut starts a fresh session per
 * request, which breaks any Space whose later steps read `gr.State` written by
 * earlier ones. This client speaks the queue protocol instead: one `session_hash`
 * for the whole run, so state survives between calls.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Hugging Face token, resolved the way `huggingface_hub` does: `HF_TOKEN`, then
 * the file `huggingface-cli login` writes (`$HF_TOKEN_PATH`, else
 * `$HF_HOME/token`, else `~/.cache/huggingface/token`). A token raises the
 * shared ZeroGPU quota from the anonymous allowance to the account's.
 */
export function huggingFaceToken(): string | undefined {
  const fromEnv = process.env["HF_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;
  const path =
    process.env["HF_TOKEN_PATH"] ??
    join(process.env["HF_HOME"] ?? join(homedir(), ".cache", "huggingface"), "token");
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface GradioFile {
  readonly path: string;
  readonly url?: string;
  readonly orig_name?: string;
  readonly meta?: { readonly _type: string };
}

interface GradioDependency {
  id?: number;
  api_name?: string | null;
}

interface QueueMessage {
  msg: string;
  rank?: number;
  queue_size?: number;
  success?: boolean;
  output?: { data?: unknown[]; error?: string | null };
}

export interface GradioOptions {
  readonly token?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((message: string) => void) | undefined;
  /** Seconds to wait for one call, including queue time. */
  readonly timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 15 * 60;

export class GradioSpace {
  readonly host: string;
  readonly #options: GradioOptions;
  #functions: Map<string, number> | null = null;
  /** `/gradio_api` on Gradio 5+, empty on Gradio 4 (absent from its config). */
  #prefix = "";

  constructor(space: string, options: GradioOptions = {}) {
    this.#options = options;
    this.host = space.startsWith("http")
      ? space.replace(/\/$/, "")
      : `https://${space.replace("/", "-").toLowerCase()}.hf.space`;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.#options.token
      ? { ...extra, Authorization: `Bearer ${this.#options.token}` }
      : extra;
  }

  async #loadConfig(): Promise<Map<string, number>> {
    if (this.#functions) return this.#functions;
    const response = await fetch(`${this.host}/config`, { headers: this.#headers() });
    if (!response.ok) {
      throw new Error(`Space 설정을 읽지 못했습니다 (${response.status}): ${this.host}`);
    }
    const config = (await response.json()) as { dependencies?: GradioDependency[]; api_prefix?: string };
    this.#prefix = (config.api_prefix ?? "").replace(/\/$/, "");
    const map = new Map<string, number>();
    (config.dependencies ?? []).forEach((dependency, index) => {
      if (dependency.api_name) map.set(dependency.api_name, dependency.id ?? index);
    });
    this.#functions = map;
    return map;
  }

  /** Resolves an `api_name` to its queue function index from the Space config. */
  async functionIndex(apiName: string): Promise<number> {
    const functions = await this.#loadConfig();
    const found = functions.get(apiName);
    if (found === undefined) {
      throw new Error(
        `Space에 '${apiName}' 엔드포인트가 없습니다. 사용 가능: ${[...functions.keys()].join(", ")}`,
      );
    }
    return found;
  }

  async upload(bytes: Uint8Array, filename: string, mime: string): Promise<GradioFile> {
    await this.#loadConfig();
    const form = new FormData();
    form.append("files", new Blob([bytes], { type: mime }), filename);
    const response = await fetch(`${this.host}${this.#prefix}/upload`, {
      method: "POST",
      headers: this.#headers(),
      body: form,
      ...(this.#options.signal ? { signal: this.#options.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`이미지 업로드 실패 (${response.status}): ${await response.text()}`);
    }
    const paths = (await response.json()) as string[];
    const path = paths[0];
    if (!path) throw new Error("업로드 응답에 파일 경로가 없습니다.");
    return { path, orig_name: filename, meta: { _type: "gradio.FileData" } };
  }

  /** Runs one function and resolves with its output data. */
  async call(apiName: string, data: readonly unknown[], sessionHash: string): Promise<unknown[]> {
    const fnIndex = await this.functionIndex(apiName);
    const join = await fetch(`${this.host}${this.#prefix}/queue/join`, {
      method: "POST",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        data,
        event_data: null,
        fn_index: fnIndex,
        session_hash: sessionHash,
        trigger_id: null,
      }),
      ...(this.#options.signal ? { signal: this.#options.signal } : {}),
    });
    if (!join.ok) {
      throw new Error(`'${apiName}' 대기열 등록 실패 (${join.status}): ${await join.text()}`);
    }

    const timeout = AbortSignal.timeout((this.#options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000);
    const signal = this.#options.signal
      ? AbortSignal.any([this.#options.signal, timeout])
      : timeout;

    const stream = await fetch(`${this.host}${this.#prefix}/queue/data?session_hash=${sessionHash}`, {
      headers: this.#headers(),
      signal,
    });
    if (!stream.ok || !stream.body) {
      throw new Error(`'${apiName}' 결과 스트림 실패 (${stream.status}).`);
    }

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split = buffer.indexOf("\n\n");
        for (; split >= 0; split = buffer.indexOf("\n\n")) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const line = chunk.split("\n").find((candidate) => candidate.startsWith("data: "));
          if (!line) continue;
          const message = JSON.parse(line.slice(6)) as QueueMessage;

          if (message.msg === "estimation" && message.rank !== undefined) {
            this.#options.onProgress?.(
              `${apiName} 대기 중 (순번 ${message.rank + 1}/${message.queue_size ?? "?"})`,
            );
          }
          if (message.msg === "process_starts") this.#options.onProgress?.(`${apiName} 실행 중…`);
          if (message.msg === "process_completed") {
            if (message.success === false || message.output?.error) {
              throw new Error(`'${apiName}' 실행 실패: ${message.output?.error ?? "사유 없음"}`);
            }
            return message.output?.data ?? [];
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw new Error(`'${apiName}' 결과를 받지 못한 채 스트림이 끊겼습니다.`);
  }

  /** Turns a Space-relative file reference into an absolute download URL. Valid after any call. */
  fileUrl(file: GradioFile): string {
    if (file.url) return file.url;
    return `${this.host}${this.#prefix}/file=${file.path}`;
  }
}

export function newSessionHash(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/**
 * Narrows one entry of a Space's output data to a file reference. Handlers that
 * return `gr.update(value=...)` wrap the file as `{ value, __type__: "update" }`.
 */
export function asGradioFile(value: unknown): GradioFile | null {
  if (value && typeof value === "object" && "__type__" in value && "value" in value) return asGradioFile(value.value);
  if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string") return null;
  // Checked above: the only required field of GradioFile is a string `path`.
  const file: GradioFile = { ...value, path: value.path };
  return file;
}
