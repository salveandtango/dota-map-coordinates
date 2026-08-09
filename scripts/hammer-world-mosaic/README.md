# Dota 2 normal-world basemap pipelines

The production route for build `24266061` is now
`vrf-strict-orthographic-canonical-canvas-v1`. It renders the current compiled
map VPK through a strict vertical orthographic camera. The output is normal 3D
world geometry and textures, not a minimap. The older Hammer perspective mosaic
below remains reproducibility history and diagnostic evidence.

## Production VRF orthographic route

The versioned contract is
`profiles/build-24266061-vrf-orthographic-v1.json`. It freezes the current VPK
and GridNav hashes, renderer settings, H2/H3 canonical-canvas crop method, H4
full-map dimensions, and H5 landmark evidence.

The immutable H2-H5 evidence manifests were captured while the renderer still
used the internal route label `vrf-strict-orthographic-v1`. The profile records
that provenance explicitly; all new renderer manifests use the promoted
canonical route ID.

Render the complete GridNav extent at 4 world units per pixel:

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File .\Invoke-VrfOrthographicRender.ps1 `
  -OutputPath "<new-run>\dota-normal-world-full-5120x5248.png" `
  -Build
```

The wrapper refuses to overwrite either the PNG or its manifest. It fixes
warmup frames, exposure, MSAA, camera, and the full GridNav projection. The
renderer also disables dither, bloom, color correction, dynamic shadows, fog,
PVS/occlusion/compaction and suppresses `Tool Entities`, `Entity Connections`,
and `Particles`.

For exact-tile tests, render the canonical parent canvas twice independently,
then use `crop-canonical-canvas.mjs` to produce integer crops. Do not independently
re-rasterize neighboring projection windows: low-level rasterization and
screen-space sampling can differ by a few pixels even with a true orthographic
camera.

Build `24266061` canonical-parent command (run twice with two new output paths):

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File .\Invoke-VrfOrthographicRender.ps1 `
  -OutputPath "<new-run>\canonical-a.png" `
  -PixelWidth 1280 -PixelHeight 1024 `
  -CenterX 512 -CenterY 0 -SpanX 5120 -SpanY 4096
```

Crop the two tile windows from each independently repeated parent:

```powershell
node.exe .\crop-canonical-canvas.mjs --input "<new-run>\canonical-a.png" `
  --output "<new-run>\origin-a.png" --left 0 --top 0 --width 1024 --height 1024
node.exe .\crop-canonical-canvas.mjs --input "<new-run>\canonical-a.png" `
  --output "<new-run>\neighbor-a.png" --left 256 --top 0 --width 1024 --height 1024
```

Validate current compiled-map landmark coordinates with
`validate-world-landmarks.mjs`; H5 requires at least 20 distributed landmarks
and an explicit visual-review manifest. Re-run H2 through H5 whenever the Dota
build, VPK hash, or GridNav hash changes.

Audit every frozen input and H2-H5 artifact without writing files:

```powershell
npm.cmd run audit-vrf
```

## Engineering high-resolution tile-stack capture

Route `vrf-strict-orthographic-tile-stack-v1` captures small orthographic world
regions with overscan, validates their shared world-space pixels, crops a hard
core from each image, and only then permits stitching. It does not use minimap
assets or a moving perspective camera.

### Camera height versus image scale

In orthographic projection, camera height does **not** control zoom. Image scale
is exactly:

```text
unitsPerPixelX = spanX / pixelWidth
unitsPerPixelY = spanY / pixelHeight
```

`CameraZ`, `NearPlane`, and `FarPlane` are exposed for depth, clipping, LOD, and
view-dependent-material experiments. Reduce `spanX/spanY` or increase output
pixels to gain detail. Do not lower a perspective camera as a production zoom;
that reintroduces parallax and leaning trees.

Run a fixed-region camera-height sweep to test whether height changes encoded
pixels without changing orthographic scale:

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File .\Invoke-VrfOrthographicCameraSweep.ps1 `
  -ProfilePath .\profiles\build-24266061-vrf-tile-stack-smoke-v1.json `
  -OutputDirectory "<run>\camera-sweep" `
  -CenterX 0 -CenterY 0 -SpanX 2048 -SpanY 2048 `
  -PixelWidth 512 -PixelHeight 512 `
  -CameraZList '8192,16384,24576'
```

The summary records every image hash, decoded-pixel mismatch ratios, mean RGB
channel deltas, and whether scale stayed invariant across heights.

Build `24266061` camera-sweep evidence at a fixed `1024 x 1024` world span and
`256 x 256` output confirms scale invariance at camera Z `8192`, `16384`, and
`24576`. The images are not pixel-identical: adjacent-height mismatch ratios
were `9.7366%` and `4.3915%`, while mean absolute RGB-channel deltas remained
`0.10292` and `0.03188`. Camera Z therefore affects view-dependent rendering
and must be frozen; it is not a zoom control. Production freezes Z at `16384`.

### High-fidelity detail A/B

The renderer and wrapper expose two auditable quality controls:

- `-MaxTextureSize 2048` (renderer CLI `--max-texture-size`);
- `-ForceHighestLod` (renderer CLI `--force-highest-lod`).

The manifest records the requested texture cap, GPU maximum texture size,
forced-LOD policy, and number of frozen model nodes. On the build `24266061`
Radiant-jungle probe centered at `(-3000, -3000)` with a `2048 x 2048` world
span, forcing 6,317 model nodes to their highest populated LOD and increasing
the texture cap from 1K to 2K changed **zero** decoded pixels at `4` world
units per pixel. Increasing the texture cap from 2K to 4K changed **zero**
decoded pixels at `1` world unit per pixel. The active bottleneck was sampling
density, not those two quality ceilings.

The same world region was rendered at `4`, `1`, and `0.5` world units per
pixel. `1` world unit per pixel produced the decisive visual improvement.
Downsampling the `0.5` render to the `1`-unit dimensions still changed
`87.4002%` of pixels with a mean absolute RGB-channel delta of `1.51065`, so it
contains additional subpixel information, but the visual gain is much smaller
and a full-map product would cost four times as many pixels. Production
therefore uses `1` world unit per pixel, a 2K texture cap, and frozen highest
LOD. Reserve `0.5` for local detail regions.

Generate a fixed-world-span 100% comparison sheet and JSON report with
`create-orthographic-detail-comparison.mjs` (`npm.cmd run detail-compare --`
followed by its required image arguments). The comparison refuses images with
different world bounds or hashes that do not match their renderer manifests.

### Production profile

`profiles/build-24266061-vrf-tile-stack-v1.json` defines:

- world bounds `[-10240, 10240] x [-10752, 10240]`;
- 1 world unit per pixel, producing a `20480 x 20992` mosaic;
- `2048 x 2048` core tiles with 128-pixel overscan on every side;
- 10 columns x 11 rows = 110 sequential GPU captures;
- fixed camera Z, near/far, exposure, warmup, MSAA, VPK and GridNav hashes;
- 2K maximum texture size and highest populated model LOD frozen in every raw
  tile manifest;
- quantitative overlap thresholds and hard-core stitching without feature warp
  or feathering.

Generate a deterministic plan without rendering:

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File .\Invoke-VrfOrthographicTileStack.ps1 `
  -ProfilePath .\profiles\build-24266061-vrf-tile-stack-v1.json `
  -OutputDirectory "<run>" -PlanOnly
```

Render all tiles sequentially, or select a safe subset first:

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File .\Invoke-VrfOrthographicTileStack.ps1 `
  -ProfilePath .\profiles\build-24266061-vrf-tile-stack-v1.json `
  -OutputDirectory "<run>" -TileId r000-c000,r000-c001 -Build
```

Resume only outputs whose renderer and crop manifests still match the frozen
plan:

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File .\Invoke-VrfOrthographicTileStack.ps1 `
  -ProfilePath .\profiles\build-24266061-vrf-tile-stack-v1.json `
  -OutputDirectory "<run>" -Resume
```

Validate every adjacent raw overscan before stitching:

```powershell
node.exe .\validate-orthographic-tile-overlaps.mjs `
  --plan "<run>\tile-plan.json" `
  --output "<run>\overlap-report.json" --enforce
```

Stitch only after the complete overlap report passes:

```powershell
node.exe .\stitch-orthographic-tile-stack.mjs `
  --plan "<run>\tile-plan.json" `
  --overlap-report "<run>\overlap-report.json" `
  --output "<run>\dota-world-tile-stack.png"
```

The production plan is intentionally not launched by default. First run the
two-tile smoke profile, inspect its overlap metrics, and adjust the versioned
profile only when evidence requires it. Independently shifted orthographic
projection windows can still differ at a small number of raster edges; overscan
validation makes that limitation measurable instead of hiding it.

The completed build `24266061` smoke run rendered two `320 x 320` raw tiles,
cropped two `256 x 256` cores, and stitched a `512 x 256` image. Its shared raw
overscan was `64 x 320` (`20,480` pixels): one pixel differed, for a mismatch
ratio of `0.000048828125`, mean absolute RGB-channel delta
`0.0000162760417`, and maximum channel delta `1`. This passes the frozen
`0.5%` / `0.25` thresholds. A second invocation with `-Resume` rendered zero
tiles and strictly validated/resumed both existing tiles.

## Build 24503204 full native Z5 release

The current full normal-world release uses profile
`build-24503204-vrf-z5-full-v3.json`. It keeps the camera fixed at
`(0, 0, 16384)`, disables frustum culling with an empty locked cull frustum,
and renders 420 guarded production cores. The official `dota.vmap` remains
read-only and no minimap/overview asset participates in this route.

The complete run is stored outside the Dota install under:

```text
artifacts/24503204/vrf/20260803-z5-full-v2-invariant-r1/
```

Its 799 adjacent raw-overlap checks pass profile v3. Channel deltas of at most
one are recorded as exact raster diagnostics but excluded from the significant
mismatch Gate. The retained v1 negative control still has a worst significant
seam mismatch above 39%, proving that this quantization allowance does not hide
real projection/culling failures.

Export the validated 420 cores to the browser's full `80 x 82` native Z5:

```powershell
node.exe .\export-z5-browser-tiles.mjs `
  --plan "<run>\tile-plan-gate-v3.json" `
  --seam-report "<run>\overlap-report-gate-v3.json" `
  --output "<run>\native-z5\5" `
  --manifest "<run>\native-z5-release.json" `
  --source-revision 10875429 `
  --source-vmap-sha256 D104CED56898670BB357BE767399738755D288EF34D87D855FEED07D2FAE9C51
```

Build the immutable six-level package:

```powershell
node.exe .\build-native-z5-map-package.mjs `
  --z5-root "<run>\native-z5\5" `
  --z5-manifest "<run>\native-z5-release.json" `
  --base-4u "<h2-h5-run>\full-a-5120x5248.png" `
  --output "<run>\map-package" `
  --map-profile dota-map-24503204
```

The builder writes `map-package.pending/build-state.json` before generating
tiles. The state binds the map profile, base image hash, native Z5 manifest
hash, asset revision, and packaging algorithm schema. A later invocation may
resume only that exact state. Existing tiles are reused only when they remain
valid 512x512 PNGs; native Z5 hardlinks must also match their expected hashes.
Partial/corrupt files are rebuilt. The final directory appears only through an
atomic rename after every level and index completes.

Run the edge/resume regression before a production package build:

```powershell
npm.cmd run self-test-tile-package-edge
```

This regression reproduces a bottom partial row, verifies non-black content and
black RGB padding, then repeats the build and requires identical tile entries.
It prevents the earlier Sharp lazy `composite + resize` ordering failure; the
production implementation now materializes the source mosaic before resizing.

Frozen release facts:

- asset revision: `dota-24503204-z5-46937540b0310374`;
- complete native Z5: `6560/6560` at `0.5u/px`;
- complete Z0-Z5 package: `8769` PNGs;
- package manifest SHA-256:
  `71D411A6B11A100C2E7B9F2CE21430ABDB0077062049D148043B5E2FFF8A00D6`;
- canonical 4u SHA-256:
  `27F8EEF2EF2B635C4A1329F2790F2E1A61C72A0F38B4EF081954593B500873B3`;
- tile payload bytes (excluding small manifest/index files): `2701620342`.

The map package is a browsable asset identity, not automatic authorization to
reuse an older vision formula. DataMetrix separately compares the formula's
Steam build, source revision, base-map hash, compiled VPK hash, and tree-state
contract, and hides old masks until a current-build oracle Gate passes.

## Legacy Hammer mosaic v1 and high-ground repair v1.1

This directory freezes the successful Dota 2 Hammer normal-world capture from
build `24204564` into a versioned, repeatable pipeline. It does not use minimap
assets.

## What is stable in v1

- camera grid: 7 x 3, 21 captures;
- camera: `z=4000`, pitch `89.9`, yaw/roll `0`;
- coordinate commands and tile names generated from one profile;
- content crop that removes Hammer chrome, viewport border, and render-mode UI;
- overlap-based RGB exposure correction;
- deterministic feathering of horizontal and vertical overlaps;
- 4096 x 4096 PNG and uncompressed 24-bit top-left-origin TGA;
- a JSON report containing source/output SHA256 hashes and solved gains.

The official `content/dota/maps/dota.vmap` remains read-only. UI capture must be
performed through the `dota2-workshop-hammer` and `computer-use` skills with
fresh user authorization. These scripts deliberately do not inject global
keyboard input or bypass the Computer Use interruption/approval boundary.

The original v1 profile and output remain immutable. Profile
`build-24266061-v1.1.json` adds only the two normal base Tile Grid layers and
does not alter the v1 21-tile stitch.

## Install

```powershell
npm.cmd install
```

Run from this directory with Node.js 24 or newer.

## Generate the camera plan

```powershell
node.exe generate-camera-plan.mjs `
  --config profiles/build-24204564-v1.json `
  --format text `
  --output camera-plan.txt
```

Each plan row contains the exact Hammer `GotoCoords` command and expected output
file name.

## Stitch a capture

```powershell
node.exe stitch-world-mosaic.mjs `
  --config profiles/build-24204564-v1.json `
  --tiles "<run>\screenshots\manual-tiles" `
  --output "<run>\reproduced-v1"
```

The command refuses to overwrite outputs unless `--force` is provided.

## Validate the profile

```powershell
npm.cmd run self-test
```

Then validate the generated TGA with the Hammer skill:

```powershell
python "<skill-root>\scripts\validate_hammer_tga.py" "<output.tga>"
```

## Analyze internal black voids

```powershell
node.exe analyze-internal-voids.mjs `
  --config profiles/build-24204564-v1.json `
  --image "<output.png>" `
  --output "<run>\internal-voids.json"
```

The analyzer ignores black components connected to the image boundary. For each
remaining component it reports a world-space camera center for Hammer
diagnostics. A centered capture is not automatically a valid repair tile: on
build `24204564`, both high-ground centers remained black after recentering.

## Capture isolated high-ground layers

After selecting the correct layer and setting the floating Fullbright view to
the profile camera, capture it losslessly:

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File capture-floating-map-view.ps1 `
  -HammerWindowHandle <handle> `
  -OutputPath "<run>\captures\dire-base-setpos-5200-4800-z4000-clean.png"
```

Always select the Tile Editor pointer tool before clicking a viewport. A brush
click can paint a temporary tile even though the official map is read-only. If
that happens, close Hammer and choose **No** to discard the session.

## Repair the two high-ground holes

```powershell
node.exe repair-highgrounds.mjs `
  --config profiles/build-24266061-v1.1.json `
  --base "<v1>\dota-world-topdown-fullbright-manual-mosaic-4096.png" `
  --captures "<run>\captures" `
  --output "<run>\repaired-v1.1"
```

The repair command detects only black components that are not connected to the
4096 x 4096 boundary. It requires exactly two components, matches them to
`dire_base` and `radiant_base`, checks at least 97 percent patch coverage, and
writes diagnostic masks plus aligned regions. It deliberately leaves the black
geometry beyond both bases unchanged.

## High-ground black obstruction

The two black voids inside the Radiant and Dire high grounds are not accepted as
final. They are distinct from out-of-bounds black geometry beyond each base.

Hammer tests at the two reported world centers ruled out insufficient camera
coverage and normal exposure/blending failure. Fullbright, High Contrast, All
Lighting, Tools Materials, and Editor Only Objects did not restore the terrain.
Hammer also reported that `maps/dota.los` is unavailable and must be generated
by a local map build; no `dota.los` exists in the loose install or installed
VPKs.

Build `24266061` confirms the normal terrain is split into the official
`dire_base` and `radiant_base` Tile Grid layers. The destruction variants are
not part of the normal-map repair. See `HIGHGROUND-OCCLUSION.md`.
