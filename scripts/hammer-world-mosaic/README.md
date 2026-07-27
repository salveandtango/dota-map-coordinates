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
