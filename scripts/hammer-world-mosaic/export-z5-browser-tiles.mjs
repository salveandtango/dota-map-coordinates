import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { exists, readJson, resolvePlanPath, sha256 } from "./tile-stack-common.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${key}`);
    }
    values.set(key, argv[++index]);
  }
  const required = (key) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing required argument ${key}`);
    return value;
  };
  return {
    planPath: path.resolve(required("--plan")),
    seamReportPath: path.resolve(required("--seam-report")),
    outputRoot: path.resolve(required("--output")),
    manifestPath: path.resolve(required("--manifest")),
    sourceRevision: required("--source-revision"),
    sourceVmapSha256: required("--source-vmap-sha256").toUpperCase(),
  };
}

function stableAggregate(entries) {
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(`${entry.x}/${entry.y}:${entry.sha256}\n`, "ascii");
  }
  return digest.digest("hex").toUpperCase();
}

async function validateInputs(planPath, plan, seamReportPath, seamReport) {
  assert.equal(plan.route, "vrf-strict-orthographic-tile-stack-v1");
  assert.equal(plan.projection.type, "orthographic-reverse-z");
  assert.equal(plan.projection.unitsPerPixel, 0.5);
  assert.equal(plan.projection.camera.z, 16384);
  assert.equal(plan.projection.camera.heightControlsScale, false);
  assert.equal(plan.tiling.stitchMode, "hard-core-crop");
  assert.equal(plan.mosaic.width, 40960);
  assert.equal(plan.mosaic.height, 41984);
  assert.equal(plan.mosaic.columns, 20);
  assert.equal(plan.mosaic.rows, 21);
  assert.equal(plan.tiles.length, 420);
  assert.equal(plan.validation.browserTileSizePixels, 512);
  assert.equal(plan.validation.expectedBrowserTileColumns, 80);
  assert.equal(plan.validation.expectedBrowserTileRows, 82);
  assert.equal(plan.validation.expectedBrowserTileCount, 6560);

  assert.equal(seamReport.route, "vrf-orthographic-tile-overlap-validation-v2");
  assert.equal(seamReport.complete, true, "The complete 799-pair seam Gate has not run");
  assert.equal(seamReport.passed, true, "The complete seam Gate failed");
  assert.equal(seamReport.comparedPairCount, plan.adjacency.length);
  assert.equal(seamReport.missingPairCount, 0);
  assert.equal(seamReport.plan.sha256, await sha256(planPath));
  assert.equal(path.resolve(seamReport.plan.path), planPath);

  if (!await exists(seamReportPath)) {
    throw new Error(`Missing seam report: ${seamReportPath}`);
  }
}

async function validateCore(planPath, tile) {
  const corePath = resolvePlanPath(planPath, tile.coreImage);
  const manifestPath = `${corePath}.json`;
  if (!await exists(corePath) || !await exists(manifestPath)) {
    throw new Error(`Missing core image or manifest for ${tile.id}`);
  }
  const metadata = await sharp(corePath, { limitInputPixels: false }).metadata();
  assert.equal(metadata.width, tile.core.destinationRect.width, `${tile.id} core width`);
  assert.equal(metadata.height, tile.core.destinationRect.height, `${tile.id} core height`);
  const manifest = await readJson(manifestPath);
  assert.equal(manifest.route, "canonical-canvas-integer-crop-v1");
  assert.equal(manifest.crop.width, tile.core.sourceRect.width);
  assert.equal(manifest.crop.height, tile.core.sourceRect.height);
  assert.equal(manifest.output.sha256, await sha256(corePath));
  return corePath;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (await exists(args.outputRoot)) {
    throw new Error(`Output already exists; use a new pending directory: ${args.outputRoot}`);
  }
  if (await exists(args.manifestPath)) {
    throw new Error(`Manifest already exists: ${args.manifestPath}`);
  }

  const plan = await readJson(args.planPath);
  const seamReport = await readJson(args.seamReportPath);
  await validateInputs(args.planPath, plan, args.seamReportPath, seamReport);

  const pendingRoot = `${args.outputRoot}.pending-${process.pid}`;
  if (await exists(pendingRoot)) {
    throw new Error(`Pending output already exists: ${pendingRoot}`);
  }
  await mkdir(pendingRoot, { recursive: false });

  const entries = [];
  try {
    for (let index = 0; index < plan.tiles.length; index += 1) {
      const tile = plan.tiles[index];
      const corePath = await validateCore(args.planPath, tile);
      const destination = tile.core.destinationRect;
      assert.equal(destination.left % 512, 0);
      assert.equal(destination.top % 512, 0);
      assert.equal(destination.width % 512, 0);
      assert.equal(destination.height % 512, 0);

      for (let localTop = 0; localTop < destination.height; localTop += 512) {
        for (let localLeft = 0; localLeft < destination.width; localLeft += 512) {
          const x = (destination.left + localLeft) / 512;
          const y = (destination.top + localTop) / 512;
          const outputPath = path.join(pendingRoot, String(x), `${y}.png`);
          await mkdir(path.dirname(outputPath), { recursive: true });
          await sharp(corePath, { limitInputPixels: false })
            .extract({ left: localLeft, top: localTop, width: 512, height: 512 })
            .removeAlpha()
            .png({ compressionLevel: 9, adaptiveFiltering: true })
            .toFile(outputPath);
          entries.push({ x, y, sha256: await sha256(outputPath) });
        }
      }
      if ((index + 1) % 20 === 0 || index + 1 === plan.tiles.length) {
        process.stdout.write(`Exported core ${index + 1}/${plan.tiles.length}; browser tiles ${entries.length}/6560\n`);
      }
    }

    entries.sort((first, second) => first.y - second.y || first.x - second.x);
    assert.equal(entries.length, 6560);
    assert.equal(new Set(entries.map((entry) => `${entry.x}:${entry.y}`)).size, 6560);
    assert.equal(entries[0].x, 0);
    assert.equal(entries[0].y, 0);
    assert.equal(entries.at(-1).x, 79);
    assert.equal(entries.at(-1).y, 81);

    const aggregateTileSha256 = stableAggregate(entries);
    const assetRevision = `dota-${plan.dotaBuildId}-z5-${aggregateTileSha256.slice(0, 16).toLowerCase()}`;
    const planSha256 = await sha256(args.planPath);
    const seamReportSha256 = await sha256(args.seamReportPath);
    const manifest = {
      schemaVersion: "1.0.0",
      route: "dota-normal-world-native-z5-release-v1",
      assetRevision,
      product: "normal-3d-world-render",
      notMinimap: true,
      dotaBuildId: plan.dotaBuildId,
      sourceRevision: args.sourceRevision,
      sources: {
        officialDotaVmap: { sha256: args.sourceVmapSha256 },
        compiledMapVpk: plan.inputs.mapVpk,
        gridNav: plan.inputs.gridNav,
        tilePlan: { path: args.planPath, sha256: planSha256 },
        seamReport: {
          path: args.seamReportPath,
          sha256: seamReportSha256,
          comparedPairCount: seamReport.comparedPairCount,
          passed: seamReport.passed,
        },
      },
      renderer: plan.renderer,
      renderingQuality: plan.renderingQuality,
      projection: plan.projection,
      worldBounds: plan.mosaic.worldBounds,
      orientation: plan.projection.orientation,
      worldToPixel: plan.mosaic.worldToPixel,
      level: {
        z: 5,
        unitsPerPixel: 0.5,
        coverage: "full",
        tileSize: 512,
        width: 40960,
        height: 41984,
        columns: 80,
        rows: 82,
        nativeTileCount: 6560,
        aggregateTileSha256,
      },
      tiles: entries,
    };

    const pendingManifest = `${args.manifestPath}.pending-${process.pid}`;
    await writeFile(pendingManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(pendingRoot, args.outputRoot);
    await rename(pendingManifest, args.manifestPath);
    process.stdout.write(`${JSON.stringify({ status: "ok", assetRevision, nativeTileCount: entries.length, aggregateTileSha256 }, null, 2)}\n`);
  } catch (error) {
    await rm(pendingRoot, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
