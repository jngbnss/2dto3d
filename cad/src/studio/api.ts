import type { GenerateOptions, State, ViewId, ViewTransform } from "./types";

/**
 * Typed wrappers for the sixview server. Every call resolves to the new
 * `State`; non-2xx responses carry a plain-text Korean message, which becomes
 * the thrown `Error`'s message.
 */
async function request(path: string, init?: RequestInit): Promise<State> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new Error(`서버에 연결할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).trim();
    throw new Error(text || `요청 실패 (${res.status} ${res.statusText})`);
  }
  return (await res.json()) as State;
}

function postJson(path: string, body: unknown): Promise<State> {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getState(): Promise<State> {
  return request("/api/state", { cache: "no-store" });
}

export function uploadView(id: ViewId, file: Blob): Promise<State> {
  return request(`/api/upload/${id}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
}

export function clearView(id: ViewId): Promise<State> {
  return request(`/api/clear/${id}`, { method: "POST" });
}

export function setTransform(id: ViewId, patch: Partial<ViewTransform>): Promise<State> {
  return postJson(`/api/transform/${id}`, patch);
}

/** Exchanges two slots' images and corrections (e.g. side views named after the character's own side). */
export function swapViews(a: ViewId, b: ViewId): Promise<State> {
  return request(`/api/swap?a=${a}&b=${b}`, { method: "POST" });
}

/** Re-applies mask-based common scale and centre alignment to every uploaded view. */
export function autoAlign(): Promise<State> {
  return request("/api/auto-align", { method: "POST" });
}

export function generate(options: GenerateOptions): Promise<State> {
  return postJson("/api/generate", options);
}

export const FULL_RESET: ViewTransform = {
  rotation: 0,
  flip: false,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};
