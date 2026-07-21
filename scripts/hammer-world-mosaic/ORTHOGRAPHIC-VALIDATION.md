# Hammer orthographic top-view validation

## Result

UI verified on Dota build `24266061`:

- `2D Top (x/y)` is Hammer's orthographic XY editor projection.
- `2D View Shading > Fullbright` renders the official map's textured terrain,
  trees, cliffs, structures, and props inside that orthographic projection.
- Zooming the view changes one uniform map scale. Tree crowns remain top-down
  silhouettes and do not lean radially toward or away from a perspective camera
  center.

This is a different rendering path from `3D Fullbright` with
`setpos/setang/FOV`. It removes the moving-camera perspective and tree-parallax
problem in the v1 21-tile mosaic.

## Verified UI sequence

1. Open official `content/dota/maps/dota.vmap` in `[ READ ONLY ]` mode.
2. Change a pane to `2D Top (x/y)`.
3. Choose `2D View Shading > Fullbright`.
4. Choose `Open Floating Window`.
5. In the floating Top view, choose `2D View Shading > Fullbright` again.
6. Turn off `View > Show Editor Only Objects`.
7. Turn off `View > Show 2D Grid`.
8. Keep overlay shapes in the state that does not display the large white
   editor overlays.

## Probe artifacts

- `orthographic-top-fullbright-clean-probe.jpg`
  - size: `1026 x 800`
  - SHA256:
    `4C099663831D2DC0230F2F56FE95F66E52B52AFB532213A72F86E0C218A3DC61`
- `orthographic-top-fullbright-wide-probe.jpg`
  - size: `1026 x 800`
  - SHA256:
    `CAF40E0F934F30256A53090031089373E6EFB61D03EC7EB538957CF6FF021FCB`

The probes are Computer Use JPEG captures of the floating view. They prove the
UI projection and visual content but are not production basemap outputs.

## High-Res Screenshot H1 result

Rejected on the same Dota build `24266061`.

- The command was exposed temporarily as `Ctrl+F10` and loaded by restarting the
  complete Dota Workshop Tools process.
- It was invoked while the active floating view was `2D Top (x/y)` with
  `2D Fullbright`, editor-only objects hidden, and the 2D grid hidden.
- The dialog still exposed `Width`, `Height`, and the 3D-camera-only `FOV`
  parameter. Its preview was black rather than the visible orthographic pane.
- A real `1024 x 1024` TGA render completed, but validation found one sampled
  color only: RGB `(0, 0, 0)`, dominant ratio `1.0`, luminance standard deviation
  `0.0`.

Rejected artifacts:

- `orthographic-2dtop-highres-1024-a.tga`
  - size: `1024 x 1024`, `3,145,746` bytes
  - SHA256:
    `A8F1D44FF2441F44EB5F5ED4B55816D0526079A4E2BA7986AA4D1E621E3136AA`
- `orthographic-2dtop-highres-1024-a.png`
  - visual inspection: uniform black
  - SHA256:
    `63F7B9E39DB4EDCDFEA0E852B21C950F8A50EE1E7B516F89E91E08D6052E588F`

Conclusion: `ShowScreenshotDialog` is a 3D camera renderer. It does not capture
the active 2D editor pane and must not be used as the orthographic export path.

## Remaining production questions

1. Capture a deterministic orthographic tile grid by panning the 2D view at a
   fixed zoom and stitching by exact XY translation.
2. Prove that repeated captures at the same center and zoom have identical
   content, then derive the exact pixel translation for one pan step.
3. Recombine `defaultLayer`, `radiant_base`, and `dire_base` in the same
   orthographic projection. The official Tile Grid layer separation still
   leaves the two base high grounds absent from `defaultLayer`.
4. Remove editor chrome and capture compression before generating the final
   4096/8192 PNG and TGA.
