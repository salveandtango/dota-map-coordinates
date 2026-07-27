# High-ground black obstruction diagnosis and repair

## Scope

Keep the black out-of-bounds regions beyond the top-left and bottom-right bases.
Remove only the two interior black regions that cover the Radiant and Dire high
grounds.

## Reproduction

The boundary-aware analyzer found two large interior black components in the
4096 x 4096 v1 output:

| Output centroid | Diagnostic camera center |
| --- | --- |
| `(1128, 1104)` | `setpos 5200 4800 4000; setang 89.9 0 0` |
| `(3064, 3130)` | `setpos -5400 -5300 4000; setang 89.9 0 0` |

Moving the Hammer camera to these centers while `defaultLayer` is active leaves
the regions black. The obstruction is therefore present in the rendered scene
and is not caused by a gap between the 21 capture tiles.

## Confirmed root cause on build 24266061

The official map contains one `CMapDotaTileGrid` with five internal
`CDmeDotaTileGrid` layers:

- `defaultLayer`
- `radiant_base`
- `radiant_destruction`
- `dire_base`
- `dire_destruction`

All five grids are 74 x 74. `defaultLayer` renders the main map but leaves
black holes where the two normal base layers belong. Selecting `dire_base` or
`radiant_base` in Hammer's Tile Editor renders the corresponding normal
high-ground terrain. The destruction layers are not used for the normal-map
repair.

This proves that the missing terrain is an official Tile Grid layer separation,
not a minimap limitation, camera coverage gap, stitch seam, exposure failure,
or missing `dota.los` file.

## Safe repair sequence for v1.1

1. Open `dota.vmap` read-only.
2. Enter Tile Editor, switch to its pointer tool before clicking any viewport.
3. Select `dire_base`, center the floating Fullbright view on
   `(5200, 4800, 4000)`, and capture the 1026 x 800 window losslessly.
4. Select `radiant_base`, center on `(-5400, -5300, 4000)`, and capture again.
5. Detect black components in the v1 4096 x 4096 output, ignoring every
   component connected to the image boundary.
6. Match the two remaining large components to the camera centers, align the
   two layer captures using the frozen v1 projection, and feather only those
   masks.
7. Refuse output if either repair capture covers less than 97 percent of its
   target component.
8. Save PNG, top-left-origin 24-bit TGA, diagnostic masks, aligned regions, and
   SHA256 provenance under the immutable v1.1 profile.

Never save the official map. If a tile is accidentally painted in memory,
close Hammer, choose **No** at the save prompt, and reopen the map before
capturing.
