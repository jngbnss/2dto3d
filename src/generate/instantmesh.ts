import { GradioSpace, newSessionHash, type GradioFile } from "./gradio.ts";
import {
  downloadMesh,
  ProviderError,
  type GenerateRequest,
  type GeneratedMesh,
  type MeshProvider,
} from "./provider.ts";
import type { MeshFormat } from "../mesh/types.ts";

const DEFAULT_SPACE = "TencentARC/InstantMesh";
const DEFAULT_STEPS = 75;
const DEFAULT_SEED = 42;

/**
 * InstantMesh on a public Hugging Face Space: one photo in, a textured mesh out,
 * no credential required (`HF_TOKEN` only raises the shared GPU quota).
 *
 * The Space also exposes `generate_mvs`, but those six images sit at Zero123++
 * poses (azimuth 30°…330°, alternating elevation) — they are NOT the six
 * orthographic faces. Carving them directly would be wrong, so this provider
 * takes the mesh from `make3d` and lets the local renderer produce exact faces.
 */
export const instantMeshProvider: MeshProvider = {
  id: "instantmesh",
  label: "Hugging Face Space · InstantMesh (무료, 키 불필요)",

  async generate(request: GenerateRequest): Promise<GeneratedMesh> {
    const space = new GradioSpace(request.model ?? DEFAULT_SPACE, {
      token: process.env["HF_TOKEN"],
      signal: request.signal,
      onProgress: request.onProgress,
    });
    const session = newSessionHash();

    const steps = numberOption(request.options?.["steps"], DEFAULT_STEPS);
    const seed = numberOption(request.options?.["seed"], DEFAULT_SEED);

    try {
      request.onProgress?.("이미지 업로드 중…");
      const uploaded = await space.upload(request.image, "input.png", request.mime);

      const [processed] = await space.call("preprocess", [uploaded, true], session);
      const processedFile = asFile(processed);
      if (!processedFile) throw new Error("배경 제거 결과를 받지 못했습니다.");

      const mvs = await space.call("generate_mvs", [processedFile, steps, seed], session);
      const preview = mvs.map(asFile).find((file): file is GradioFile => file !== null);

      const outputs = await space.call("make3d", [null], session);
      const files = outputs.map(asFile).filter((file): file is GradioFile => file !== null);
      const chosen = files.find((file) => extensionOf(file) !== null);
      if (!chosen) {
        throw new Error(`3D 결과 파일을 찾지 못했습니다: ${JSON.stringify(outputs).slice(0, 300)}`);
      }
      const format = extensionOf(chosen);
      if (!format) throw new Error("알 수 없는 메시 형식입니다.");

      const url = space.fileUrl(chosen);
      request.onProgress?.(`메시 다운로드: ${url}`);

      return {
        bytes: await downloadMesh(url, request.signal),
        format,
        provider: "instantmesh",
        model: request.model ?? DEFAULT_SPACE,
        raw: {
          multiview: preview ? space.fileUrl(preview) : null,
          files: files.map((file) => space.fileUrl(file)),
        },
      };
    } catch (error) {
      throw new ProviderError(
        error instanceof Error ? error.message : String(error),
        "instantmesh",
      );
    }
  },
};

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asFile(value: unknown): GradioFile | null {
  if (!value || typeof value !== "object") return null;
  const path = (value as { path?: unknown }).path;
  if (typeof path !== "string") return null;
  return value as GradioFile;
}

function extensionOf(file: GradioFile): MeshFormat | null {
  const lower = file.path.toLowerCase();
  if (lower.endsWith(".obj")) return "obj";
  if (lower.endsWith(".glb") || lower.endsWith(".gltf")) return "glb";
  return null;
}
