# P0/P1 reconstruction audit

Date: 2026-10-13

## Scope

Inspected preprocessing, alignment, canonical camera bases, silhouette extraction,
visual-hull field construction, Surface Nets extraction, postprocessing, colour
projection, result evaluation, AI provider adapters, web API, and Studio controls.
The five-view set then present in `out-studio/` served as regression input. A later
visual audit showed the current files are a robot, not Stanley; the original Stanley
images are no longer present, so the historical table below is not a reproducible
Stanley comparison with the current workspace.

## Implemented pipeline

1. Apply saved rotation, horizontal flip, crop, scale, and offset.
2. Build foreground mask from alpha; otherwise border-connected background keying.
3. Solve shared X/Y/Z extents and per-view scale from silhouette bounding boxes.
4. Place cut-outs on common centred canvases with one pixels-per-world-unit scale.
5. Validate extent consistency, coarse-hull reprojection, axis profiles, opposite-view
   agreement, and input integrity.
6. Build visual hull as minimum of per-view 2D signed-distance fields.
7. Extract zero surface with Surface Nets. Preserve silhouette-confirmed components; the former 2% deletion rule was removed.
   Apply bounded Taubin smoothing.
8. Project input colours onto visible, camera-facing vertices. Resolve detected colour
   conflicts by selecting strongest-facing view; flood unseen vertices from neighbours.
9. Export vertex-coloured GLB and OBJ, plus voxel debug GLB.
10. Orthographically render five canonical views. Report silhouette IoU and cross-view
    surface-colour consistency.

AI path is real adapter code, not UI-only: local/public Hunyuan3D-2mv, TRELLIS,
InstantMesh, fal, and Replicate providers exist. `ai` generation fits provider output
to view proportions and constrains overhang against visual hull. Availability and model
quality depend on local server, credentials, network, and upstream services; this audit
did not claim an AI-quality result.

## Coordinate audit

One shared basis table drives carving, orthographic rendering, paint projection, AI
fitting, and UI direction markers:

| View | Camera | Image right | Image up | Basis forward |
|---|---:|---:|---:|---:|
| front | +Z | +X | +Y | -Z |
| back | -Z | -X | +Y | +Z |
| left | -X | +Z | +Y | +X |
| right | +X | -Z | +Y | -X |
| top | +Y | +X | -Z | -Y |

Pixel mapping matches across carving and rendering: `x_px = W/2 + dot(p,right)*ppu`,
`y_px = H/2 - dot(p,up)*ppu`. New directional regression test checks all five views
with a point offset in +X/+Y/+Z.

## Historical stored-set root cause and measurements

Stored result used product preset with X symmetry prior. Product preset silently enabled
`symmetry=true`. Reconstruction then intersected every sample with its X-mirrored sample.
The subject was historically interpreted as having a unilateral handle, so the audit
attributed the loss to symmetry. Because that exact source set is unavailable, this
causal claim remains historical rather than a currently reproducible Stanley result.

Same input, resolution 160:

| Configuration | Mean silhouette IoU | Colour consistency | Front | Back | Left | Right | Top | Runtime |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Previous product preset: symmetry on, smoothing 12 | 78.27% | 80.70% | 68.62% | 68.48% | 94.34% | 95.21% | 64.68% | 3.64 s |
| Symmetry off, smoothing 12 | 98.31% | 89.16% | 99.00% | 98.77% | 96.89% | 97.78% | 99.12% | 3.86 s |
| Symmetry off, smoothing 0 | 98.32% | 89.46% | 98.98% | 98.78% | 96.90% | 97.75% | 99.21% | 3.47 s |

Conclusion: symmetry prior caused reported 78% outline result. Smoothing effect on this case
was negligible. Product preset now leaves symmetry off; explicit advanced toggle remains.

## Confirmed limitations

- Visual hull recovers only occupancy constrained by silhouettes. Opaque top-view pixels
  inside cup are foreground, not a cavity signal. Cup interior depth cannot be inferred by
  current binary masks.
- Handle hole survives only where background/alpha marks hole. Thin members below grid
  sampling scale can disappear. Surface resolution controls this limit.
- Round bodies remain visual-hull intersections unless rounded prior is explicitly used.
  Generic primitive/revolve fitting does not yet exist.
- GLB/OBJ use per-vertex colour. No UV atlas or texture image is generated. Fine logo edges
  blur with mesh density; conflicting views can still place details on wrong surfaces.
- Reported colour value is cross-view projection consistency, not pixel colour error between
  source and rerender. Naming should remain explicit in future UI work.
- Mesh validation currently lacks production checks for self-intersections, abnormal holes,
  and semantic part connectivity. Closed-edge manifold behavior has one automated test.
- Input validation's coarse-hull score measures mutual silhouette compatibility. It is not
  final mesh quality. High alignment score therefore does not imply faithful cavities,
  curved sections, or texture.

## Priority after this patch

1. P1: keep canonical-basis tests; expose exact reconstruction options in saved result;
   add contour-distance and component/topology metrics beside IoU.
2. P2: represent negative volumes/cavities separately from foreground silhouette; preserve
   thin components with adaptive resolution or narrow-band refinement.
3. P3: add scored candidates for revolve/cylinder, extrusion, box, and swept-handle parts;
   fall back to visual hull when evidence is weak.
4. P4: UV atlas, view ownership, seam optimisation, and photometric normalisation.
5. P5: benchmark licensed AI backends under fixed data/hardware before automatic hybrid use.
