# AI reconstruction providers

Checked 2026-10-13. Provider adapters are real network/local integrations, not UI placeholders.
Generation quality and public Space availability remain external and are not guaranteed.

| Provider | Input used here | License / constraints | Runtime |
|---|---|---|---|
| TRELLIS | one or several prepared views | Models and most code: MIT; submodules have separate terms | Public HF Space by default. Official local setup requires Linux, NVIDIA GPU with at least 16 GB VRAM, CUDA toolkit, Python 3.8+ |
| InstantMesh | front image | Apache-2.0 | Public HF Space; official local install recommends Python 3.10+, PyTorch 2.1, CUDA 12.1 |
| Hunyuan3D-2mv | front/back/left/right | Tencent Hunyuan 3D 2.0 Community License. Territory excludes EU, UK, and South Korea; other distribution/use restrictions apply | Public HF Space or bundled local server. Disabled until `SIXVIEW_ENABLE_HUNYUAN=1` explicitly acknowledges review |
| fal / Replicate | provider-specific hosted models | Service/model terms apply | API credential and paid quota may apply |

Primary sources:

- TRELLIS official README: https://github.com/microsoft/TRELLIS/blob/main/README.md
- TRELLIS official license: https://github.com/microsoft/TRELLIS/blob/main/LICENSE
- InstantMesh official README: https://github.com/TencentARC/InstantMesh/blob/main/README.md
- InstantMesh official license: https://github.com/TencentARC/InstantMesh/blob/main/LICENSE
- Hunyuan3D-2 official README: https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/README.md
- Hunyuan3D-2 official license: https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE

## Selection

- Default AI provider: `trellis`.
- Override: `SIXVIEW_AI_PROVIDER=instantmesh|trellis|fal|replicate|hunyuan|local`.
- `ai`: calls the selected provider, fits its mesh to the five-view frame, then constrains overhangs with the visual hull.
- `hybrid`: compares silhouette and geometry candidates locally. “Include AI candidate” additionally calls the selected provider and accepts it only when every reprojection remains above the safety floor.
- Provider failure never masquerades as AI success. `ai` falls back to silhouette with a warning; hybrid retains the best local candidate with a warning.

## Local Hunyuan gate

Review the official license for the actual deployment territory first. Where permitted:

```powershell
$env:SIXVIEW_ENABLE_HUNYUAN = "1"
npm run ai:setup
npm run ai:local
```

No new AI dependency is installed by the standard application install.
