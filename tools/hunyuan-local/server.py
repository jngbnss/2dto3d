"""Local Hunyuan3D-2mv shape server for sixview.

Runs the same model the public Space serves (Hunyuan3D-2mv, turbo checkpoint,
FlashVDM decoder) on this machine's GPU, so generation needs no Hugging Face
quota or token. Weights download once from the public repo into the Hugging
Face cache.

    POST /generate  {"views": {"front": <png base64>, "back": ..., "left": ..., "right": ...},
                     "seed": 1234, "steps": 5, "octree": 256, "chunks": 8000}
                    -> model/gltf-binary
    GET  /health    -> {"ready": true, "model": ..., "device": ...}

View keys use Hunyuan's naming (its "left" shows the subject facing image-left);
the Node client swaps sixview's left/right before sending. Images must carry an
alpha cut-out: no background removal runs here.

Usage: python server.py --repo <Hunyuan3D-2 checkout> [--port 8090] [--low-vram]
"""

import argparse
import base64
import io
import json
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MODEL = "tencent/Hunyuan3D-2mv"
SUBFOLDER = "hunyuan3d-dit-v2-mv-turbo"
VIEW_KEYS = ("front", "left", "back", "right")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True, help="Hunyuan3D-2 repository checkout (provides hy3dgen)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--low-vram", action="store_true", help="offload idle sub-models to CPU (slower, ~half the VRAM)")
    return parser.parse_args()


def load_pipeline(repo: str, low_vram: bool):
    sys.path.insert(0, str(Path(repo).resolve()))
    import torch
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

    if not torch.cuda.is_available():
        raise SystemExit("CUDA GPU를 찾지 못했습니다 (torch.cuda.is_available() == False).")
    pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(MODEL, subfolder=SUBFOLDER, variant="fp16")
    pipeline.enable_flashvdm()
    if low_vram:
        pipeline.enable_model_cpu_offload()
    return pipeline, torch.cuda.get_device_name(0)


def decode_views(payload: dict) -> dict:
    from PIL import Image

    views = payload.get("views") or {}
    images = {}
    for key in VIEW_KEYS:
        data = views.get(key)
        if not data:
            continue
        image = Image.open(io.BytesIO(base64.b64decode(data))).convert("RGBA")
        if image.getchannel("A").getextrema()[0] == 255:
            raise ValueError(f"'{key}' 이미지에 투명 배경(알파)이 없습니다.")
        images[key] = image
    if "front" not in images:
        raise ValueError("front 이미지가 필요합니다.")
    return images


def main() -> None:
    args = parse_args()
    print(f"[hunyuan-local] {MODEL}/{SUBFOLDER} 불러오는 중…", flush=True)
    pipeline, device = load_pipeline(args.repo, args.low_vram)
    import torch

    gpu = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def _json(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._json(200, {"ready": True, "model": f"{MODEL}/{SUBFOLDER}", "device": device})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/generate":
                self._json(404, {"error": "not found"})
                return
            try:
                payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                images = decode_views(payload)
            except Exception as error:  # malformed request
                self._json(400, {"error": str(error)})
                return
            try:
                with gpu:
                    started = time.time()
                    mesh = pipeline(
                        image=images,
                        num_inference_steps=int(payload.get("steps", 5)),
                        octree_resolution=int(payload.get("octree", 256)),
                        num_chunks=int(payload.get("chunks", 8000)),
                        generator=torch.manual_seed(int(payload.get("seed", 1234))),
                        output_type="trimesh",
                    )[0]
                    torch.cuda.empty_cache()
                with tempfile.TemporaryDirectory() as folder:
                    path = Path(folder) / "shape.glb"
                    mesh.export(str(path))
                    data = path.read_bytes()
                print(
                    f"[hunyuan-local] {'/'.join(images)} → {len(mesh.faces):,} 삼각형, {time.time() - started:.1f}s",
                    flush=True,
                )
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                self._json(507, {"error": "GPU 메모리가 부족합니다. --low-vram 으로 서버를 다시 켜 보세요."})
                return
            except Exception as error:
                self._json(500, {"error": str(error)})
                return
            self.send_response(200)
            self.send_header("Content-Type", "model/gltf-binary")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args) -> None:  # requests are logged by the handler itself
            pass

    server = HTTPServer((args.host, args.port), Handler)
    print(f"[hunyuan-local] 준비됨 · {device} · http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
