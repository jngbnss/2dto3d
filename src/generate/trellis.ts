import { VIEW_IDS } from "../views.ts";
import { asGradioFile, GradioSpace, huggingFaceToken, newSessionHash, type GradioFile } from "./gradio.ts";
import {
  downloadMesh,
  ProviderError,
  type GenerateRequest,
  type GeneratedMesh,
  type MeshProvider,
} from "./provider.ts";

const DEFAULT_SPACE = "trellis-community/TRELLIS";
const DEFAULT_SEED = 0;
/**
 * Space slider bounds: simplify 0.9–0.98 (fraction of faces removed), texture
 * 512–2048, steps 1–50. The Space defaults (0.95, 1024, 12) leave ~12k faces and
 * a blurred atlas, which reads as faceted clay; these take the detailed end.
 */
const DEFAULT_SIMPLIFY = 0.9;
const DEFAULT_TEXTURE_SIZE = 2048;
const DEFAULT_STEPS = 25;

/**
 * TRELLIS on a public Hugging Face Space: one or several views of a subject in,
 * a GLB with a baked colour texture out. Unlike vertex-coloured meshes, the
 * texture keeps print-sharp details (eyes, polka dots) instead of a clay blur.
 *
 * Several images go through the Space's "Multiple Images" mode. That mode is a
 * per-session `gr.State` the API listing hides: it is switched on by the tab's
 * select handler (`lambda_1`), and `generate_and_extract_glb` takes it as its
 * third input, so the data array must keep that slot.
 *
 * The GLB arrives Y-up with the subject facing -Z, hence `facing: "-z"`.
 */
export const trellisProvider: MeshProvider = {
  id: "trellis",
  label: "Hugging Face Space · TRELLIS (무료, 텍스처 GLB, 다중 이미지)",
  multiImage: true,

  async generate(request: GenerateRequest): Promise<GeneratedMesh> {
    const space = new GradioSpace(request.model ?? DEFAULT_SPACE, {
      token: huggingFaceToken(),
      signal: request.signal,
      onProgress: request.onProgress,
    });
    const session = newSessionHash();
    const seed = numberOption(request.options?.["seed"], DEFAULT_SEED);
    const textureSize = numberOption(request.options?.["textureSize"], DEFAULT_TEXTURE_SIZE);
    const simplify = numberOption(request.options?.["simplify"], DEFAULT_SIMPLIFY);
    const steps = numberOption(request.options?.["steps"], DEFAULT_STEPS);
    const sources = VIEW_IDS.flatMap((id) => request.views[id] ?? []);
    const multi = sources.length > 1;

    try {
      // Creates the per-session output directory the generate step writes into.
      await space.call("start_session", [], session);

      request.onProgress?.(`이미지 ${sources.length}장 업로드 중…`);
      const uploaded: GradioFile[] = [];
      for (const [index, source] of sources.entries()) {
        uploaded.push(await space.upload(source.bytes, `view-${index}.png`, source.mime));
      }

      let single: unknown = null;
      let gallery: unknown = [];
      if (multi) {
        [gallery] = await space.call("preprocess_images", [uploaded.map((image) => ({ image, caption: null }))], session);
        await space.call("lambda_1", [], session);
      } else {
        [single] = await space.call("preprocess_image", [uploaded[0]], session);
      }

      const outputs = await space.call(
        "generate_and_extract_glb",
        [single, gallery, multi, seed, 7.5, steps, 3, steps, "stochastic", simplify, textureSize],
        session,
      );
      // [state, video, model viewer GLB, download GLB]
      const glb = asGradioFile(outputs[3]) ?? asGradioFile(outputs[2]);
      if (!glb) throw new Error(`GLB 결과를 찾지 못했습니다: ${JSON.stringify(outputs).slice(0, 300)}`);

      const url = space.fileUrl(glb);
      request.onProgress?.(`GLB 다운로드: ${url}`);
      const video = outputs[1];
      const preview =
        video && typeof video === "object" && "video" in video ? asGradioFile(video.video) : null;

      return {
        bytes: await downloadMesh(url, request.signal),
        format: "glb",
        facing: "-z",
        provider: "trellis",
        model: request.model ?? DEFAULT_SPACE,
        raw: { glb: url, video: preview ? space.fileUrl(preview) : null, images: sources.length },
      };
    } catch (error) {
      throw new ProviderError(error instanceof Error ? error.message : String(error), "trellis");
    }
  },
};

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
