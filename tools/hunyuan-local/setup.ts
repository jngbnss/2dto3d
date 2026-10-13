/**
 * One-time install of the local Hunyuan3D-2mv server (`npm run ai:setup`):
 * clones the Hunyuan3D-2 repository and builds a Python venv with CUDA PyTorch
 * under `local-ai/` (git-ignored). Every step is skipped when already done.
 * Model weights download on the server's first start.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PYTHON, REPO, VENV } from "./paths.ts";

if (process.env["SIXVIEW_ENABLE_HUNYUAN"] !== "1") {
  throw new Error(
    "설치 전 Hunyuan3D-2 공식 라이선스의 지역 제한을 확인하세요. " +
    "적용 지역에서만 SIXVIEW_ENABLE_HUNYUAN=1을 설정한 뒤 다시 실행하세요: " +
    "https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE",
  );
}

/**
 * Shape generation only; texture synthesis needs ~16 GB VRAM and compiled
 * extensions. transformers 5 renamed the DINOv2 weights the Hunyuan checkpoint
 * stores (load fails with missing `attention.q_proj` keys), so it stays on 4.x
 * with the diffusers release that matches its huggingface_hub.
 */
const PACKAGES = [
  "diffusers==0.31.0", "transformers==4.46.3", "accelerate", "huggingface_hub", "einops", "omegaconf", "tqdm",
  "opencv-python", "numpy", "scikit-image", "trimesh", "pygltflib", "pymeshlab",
];

function run(command: string, args: readonly string[]): void {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`실패: ${command} ${args.join(" ")}`);
}

if (!existsSync(REPO)) run("git", ["clone", "--depth", "1", "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git", REPO]);
if (!existsSync(PYTHON)) run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", VENV]);
run(PYTHON, ["-m", "pip", "install", "-q", "--upgrade", "pip"]);
run(PYTHON, ["-m", "pip", "install", "-q", "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cu124"]);
run(PYTHON, ["-m", "pip", "install", "-q", ...PACKAGES]);
run(PYTHON, ["-c", "import torch; assert torch.cuda.is_available(), 'CUDA GPU 없음'; print('GPU:', torch.cuda.get_device_name(0))"]);
console.log("설치 완료. 'npm run ai:local'로 서버를 켜세요.");
