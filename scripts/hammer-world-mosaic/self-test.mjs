import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildTilePlan } from "./tile-stack-common.mjs";

const profilePath = path.resolve(
  process.argv[2] ?? "profiles/build-24204564-v1.json"
);
const config = JSON.parse(await readFile(profilePath, "utf8"));

assert.equal(config.product, "normal-3d-world-render");
if (config.schemaVersion === 1) {
  assert.equal(config.camera.xPositions.length, 7);
  assert.equal(config.camera.yPositions.length, 3);
  assert.equal(
    config.camera.xPositions.length * config.camera.yPositions.length,
    21
  );
  assert.equal(config.finalOutput.width, 4096);
  assert.equal(config.finalOutput.height, 4096);
  assert.equal(config.captureCrop.contentWidth, 1568);
  assert.ok(config.captureCrop.contentHeight > 0);
  assert.ok(config.projection.pixelsPerWorldUnit > 0);

  for (const x of config.camera.xPositions) {
    for (const y of config.camera.yPositions) {
      const left =
        -Math.round(config.projection.pixelsPerWorldUnit * y) +
        config.projection.canvasLeftAtY0;
      const top =
        -Math.round(config.projection.pixelsPerWorldUnit * x) +
        config.projection.canvasTopAtX0;
      assert.ok(left >= 0, `tile ${x},${y} starts before canvas`);
      assert.ok(top >= 0, `tile ${x},${y} starts before canvas`);
      assert.ok(
        left + config.captureCrop.contentWidth <= config.canvas.width,
        `tile ${x},${y} exceeds canvas width`
      );
      const height =
        config.captureCrop.tileOverrides?.[`${x},${y}`]?.contentHeight ??
        config.captureCrop.contentHeight;
      assert.ok(
        top + height <= config.canvas.height,
        `tile ${x},${y} exceeds canvas height`
      );
    }
  }
  process.stdout.write(
    `PASS ${config.profileId}: 21 tiles, ${config.canvas.width}x${config.canvas.height} canvas, 4096x4096 output\n`
  );
} else if (config.schemaVersion === 2) {
  assert.equal(config.baseProjection.outputWidth, 4096);
  assert.equal(config.baseProjection.outputHeight, 4096);
  assert.equal(config.capture.windowWidth, 1026);
  assert.equal(config.capture.windowHeight, 800);
  assert.equal(config.capture.contentWidth, 1024);
  assert.equal(config.capture.contentHeight, 768);
  assert.equal(config.repairs.length, 2);
  assert.deepEqual(
    config.repairs.map((repair) => repair.tileGridLayer).sort(),
    ["dire_base", "radiant_base"]
  );
  assert.ok(config.mask.featherSigma > 0);
  assert.ok(config.mask.minimumPatchCoverage >= 0.9);
  process.stdout.write(
    `PASS ${config.profileId}: 2 isolated base-layer repairs, 4096x4096 output\n`
  );
} else if (config.schemaVersion === 3) {
  assert.equal(config.routeId, "vrf-strict-orthographic-canonical-canvas-v1");
  assert.equal(config.mapMode, "official-read-only");
  assert.equal(config.inputs.gridNav.edgeSize, 64);
  assert.equal(config.inputs.gridNav.width, 320);
  assert.equal(config.inputs.gridNav.height, 328);
  assert.equal(config.deterministicSettings.projection, "orthographic-reverse-z");
  assert.equal(config.deterministicSettings.hdrColorFormat, "RGBA32F");
  assert.equal(config.deterministicSettings.ditheringEnabled, false);
  assert.equal(config.deterministicSettings.bloomEnabled, false);
  assert.equal(config.deterministicSettings.colorCorrectionEnabled, false);
  assert.equal(config.deterministicSettings.deterministicMaterialSortIds, true);
  assert.equal(
    config.renderer.manifestRoutes.current,
    "vrf-strict-orthographic-canonical-canvas-v1"
  );
  assert.equal(config.renderer.manifestRoutes.evidenceCapturedAs, "vrf-strict-orthographic-v1");
  assert.deepEqual(
    [...config.deterministicSettings.suppressedLayers].sort(),
    ["Entity Connections", "Particles", "Tool Entities"]
  );
  assert.equal(config.h2h3.h2.passed, true);
  assert.equal(config.h2h3.h2.mismatchPixels, 0);
  assert.equal(config.h2h3.h3.passed, true);
  assert.equal(config.h2h3.h3.dx, -256);
  assert.equal(config.h2h3.h3.dy, 0);
  assert.equal(config.h2h3.h3.mismatchPixelsPerTrial, 0);
  assert.equal(config.h4.passed, true);
  assert.equal(config.h4.image.width, 5120);
  assert.equal(config.h4.image.height, 5248);
  assert.equal(config.h4.worldBounds.unitsPerPixel, 4);
  assert.equal(config.h4.repeatMismatchPixels, 0);
  assert.equal(config.h5.passed, true);
  assert.ok(config.h5.landmarkCount >= config.h5.requiredLandmarkCount);
  assert.equal(config.h5.automaticPassed, true);
  assert.equal(config.h5.visualPassed, true);
  process.stdout.write(
    `PASS ${config.profileId}: exact H2/H3, 5120x5248 H4, ${config.h5.landmarkCount}-tower H5\n`
  );
} else if (config.schemaVersion === 4) {
  const plan = buildTilePlan(config);
  assert.equal(config.routeId, "vrf-strict-orthographic-tile-stack-v1");
  assert.equal(config.projection.camera.heightControlsScale, false);
  assert.equal(config.projection.camera.scaleControl,
    "projection span divided by output pixels");
  assert.equal(plan.mosaic.width,
    (config.projection.worldBounds.right - config.projection.worldBounds.left)
      / config.projection.unitsPerPixel);
  assert.equal(plan.mosaic.height,
    (config.projection.worldBounds.top - config.projection.worldBounds.bottom)
      / config.projection.unitsPerPixel);
  assert.equal(plan.tiles.length, plan.mosaic.rows * plan.mosaic.columns);
  assert.ok(plan.adjacency.length > 0);
  for (const tile of plan.tiles) {
    assert.equal(tile.render.pixelWidth,
      tile.core.sourceRect.width + config.tiling.overscanPixels * 2);
    assert.equal(tile.render.pixelHeight,
      tile.core.sourceRect.height + config.tiling.overscanPixels * 2);
    assert.equal(tile.core.sourceRect.left, config.tiling.overscanPixels);
    assert.equal(tile.core.sourceRect.top, config.tiling.overscanPixels);
  }
  process.stdout.write(
    `PASS ${config.profileId}: ${plan.tiles.length} tiles, ${plan.mosaic.width}x${plan.mosaic.height} at ${config.projection.unitsPerPixel} world units/pixel\n`
  );
} else {
  assert.fail(`Unsupported schemaVersion: ${config.schemaVersion}`);
}
