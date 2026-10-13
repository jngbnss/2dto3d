import { asGradioFile, GradioSpace, huggingFaceToken, newSessionHash } from "./gradio.ts";
import {
  downloadMesh,
  ProviderError,
  type GenerateRequest,
  type GeneratedMesh,
  type MeshProvider,
} from "./provider.ts";

const DEFAULT_SPACE = "tencent/Hunyuan3D-2mv";
const DEFAULT_SEED = 1234;
/** Turbo checkpoint: the Space's own default; 5 steps is its "Turbo" mode. */
const DEFAULT_STEPS = 5;
const DEFAULT_GUIDANCE = 5;
/**
 * Space slider 16–512; 256 is its "Standard" decode. "High" (384) returns ~2M
 * triangles, far past what the silhouette correction and the web viewer need.
 */
const DEFAULT_OCTREE_RESOLUTION = 256;
const DEFAULT_CHUNKS = 8000;

/**
 * Hunyuan3D-2mv on its public Space: up to four named views (front, back, left,
 * right) condition one shape. The Space ships shape generation only — texture
 * synthesis is disabled there — so the result is an untextured mesh; the
 * pipeline colours it from the input views.
 *
 * Hunyuan names side views after the subject's own side: its `left` shows the
 * subject facing image-left, which is this repo's drafting-layout `right`
 * (`src/views.ts`). The two are swapped on the way in.
 *
 * The mesh arrives facing +Z, matching `render/basis.ts`.
 */
export const hunyuanProvider: MeshProvider = {
  id: "hunyuan",
  label: "Hugging Face Space · Hunyuan3D-2mv (무료, front/back/left/right 4장)",
  multiImage: true,

  async generate(request: GenerateRequest): Promise<GeneratedMesh> {
    const space = new GradioSpace(request.model ?? DEFAULT_SPACE, {
      token: huggingFaceToken(),
      signal: request.signal,
      onProgress: request.onProgress,
    });
    const session = newSessionHash();
    const { front, back, left, right } = request.views;

    try {
      request.onProgress?.("이미지 업로드 중…");
      const upload = async (image: typeof front | undefined, name: string) =>
        image ? space.upload(image.bytes, `${name}.png`, image.mime) : null;
      const [frontFile, backFile, leftFile, rightFile] = await Promise.all([
        upload(front, "front"),
        upload(back, "back"),
        upload(left, "left"),
        upload(right, "right"),
      ]);

      const outputs = await space.call(
        "shape_generation",
        [
          null, // caption
          null, // single image
          frontFile,
          backFile,
          rightFile, // Hunyuan "left" = subject facing image-left = our right view
          leftFile,
          DEFAULT_STEPS,
          DEFAULT_GUIDANCE,
          DEFAULT_SEED,
          DEFAULT_OCTREE_RESOLUTION,
          true, // remove background
          DEFAULT_CHUNKS,
          false, // randomize seed
        ],
        session,
      );
      // [mesh file, viewer html, stats, seed]
      const glb = asGradioFile(outputs[0]);
      if (!glb) throw new Error(`GLB 결과를 찾지 못했습니다: ${JSON.stringify(outputs).slice(0, 300)}`);

      const url = space.fileUrl(glb);
      request.onProgress?.(`GLB 다운로드: ${url}`);
      return {
        bytes: await downloadMesh(url, request.signal),
        format: "glb",
        provider: "hunyuan",
        model: request.model ?? DEFAULT_SPACE,
        raw: { glb: url, stats: outputs[2] ?? null },
      };
    } catch (error) {
      throw new ProviderError(error instanceof Error ? error.message : String(error), "hunyuan");
    }
  },
};
