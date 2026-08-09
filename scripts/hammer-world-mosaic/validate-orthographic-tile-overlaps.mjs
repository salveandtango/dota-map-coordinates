import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import {
  exists,
  intersection,
  readJson,
  resolvePlanPath,
  sha256,
} from "./tile-stack-common.mjs";

function parseArguments(argv) {
  const values = new Map();
  let force = false;
  let allowPartial = false;
  let enforce = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--force") { force = true; continue; }
    if (key === "--allow-partial") { allowPartial = true; continue; }
    if (key === "--enforce") { enforce = true; continue; }
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${key}`);
    }
    values.set(key, argv[++index]);
  }
  const required = (key) => {
    const value = values.get(key);
    if (value === undefined) { throw new Error(`Missing required argument ${key}`); }
    return path.resolve(value);
  };
  return {
    planPath: required("--plan"),
    outputPath: required("--output"),
    force,
    allowPartial,
    enforce,
  };
}

async function readRegion(imagePath, tileRect, commonRect) {
  const result = await sharp(imagePath, { limitInputPixels: false })
    .extract({
      left: commonRect.left - tileRect.left,
      top: commonRect.top - tileRect.top,
      width: commonRect.width,
      height: commonRect.height,
    })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (result.info.channels !== 3) {
    throw new Error(`Expected RGB comparison buffer, got ${result.info.channels} channels`);
  }
  return result.data;
}

function compareBuffers(first, second, width, height, minimumSignificantChannelDelta) {
  if (first.length !== second.length) { throw new Error("Overlap buffers differ in length"); }
  let mismatchPixels = 0;
  let exactMismatchPixels = 0;
  let absoluteDelta = 0;
  let maxChannelDelta = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    let mismatch = false;
    let exactMismatch = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(first[pixel * 3 + channel] - second[pixel * 3 + channel]);
      absoluteDelta += delta;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      exactMismatch ||= delta !== 0;
      mismatch ||= delta > minimumSignificantChannelDelta;
    }
    exactMismatchPixels += exactMismatch ? 1 : 0;
    if (mismatch) {
      mismatchPixels += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const pixels = width * height;
  return {
    pixels,
    minimumSignificantChannelDelta,
    exactMismatchPixels,
    exactMismatchRatio: exactMismatchPixels / pixels,
    mismatchPixels,
    mismatchRatio: mismatchPixels / pixels,
    meanAbsoluteRgbChannelDelta: absoluteDelta / (pixels * 3),
    maxChannelDelta,
    mismatchBounds: mismatchPixels === 0 ? null : {
      left: minX,
      top: minY,
      rightExclusive: maxX + 1,
      bottomExclusive: maxY + 1,
    },
  };
}

function extractBufferRegion(buffer, sourceWidth, region) {
  const output = Buffer.alloc(region.width * region.height * 3);
  for (let row = 0; row < region.height; row += 1) {
    const sourceStart = ((region.top + row) * sourceWidth + region.left) * 3;
    const destinationStart = row * region.width * 3;
    buffer.copy(output, destinationStart, sourceStart, sourceStart + region.width * 3);
  }
  return output;
}

function seamBand(axis, commonRect, width) {
  if (axis === "horizontal") {
    return {
      left: Math.floor((commonRect.width - width) / 2),
      top: 0,
      width,
      height: commonRect.height,
    };
  }
  return {
    left: 0,
    top: Math.floor((commonRect.height - width) / 2),
    width: commonRect.width,
    height: width,
  };
}

const options = parseArguments(process.argv.slice(2));
if (!options.force && await exists(options.outputPath)) {
  throw new Error(`Refusing to overwrite overlap report: ${options.outputPath}`);
}
const plan = await readJson(options.planPath);
const planHash = await sha256(options.planPath);
const tileById = new Map(plan.tiles.map((tile) => [tile.id, tile]));
const pairs = [];
const missingPairs = [];

for (const adjacent of plan.adjacency) {
  const firstTile = tileById.get(adjacent.first);
  const secondTile = tileById.get(adjacent.second);
  const firstPath = resolvePlanPath(options.planPath, firstTile.rawImage);
  const secondPath = resolvePlanPath(options.planPath, secondTile.rawImage);
  if (!await exists(firstPath) || !await exists(secondPath)) {
    missingPairs.push(adjacent);
    if (!options.allowPartial) {
      throw new Error(`Missing adjacent tile(s): ${adjacent.first}, ${adjacent.second}`);
    }
    continue;
  }
  const commonRect = intersection(
    firstTile.render.globalPixelRect,
    secondTile.render.globalPixelRect
  );
  if (!commonRect) {
    throw new Error(`Adjacent tiles have no overscan intersection: ${adjacent.first}, ${adjacent.second}`);
  }
  const [firstBuffer, secondBuffer] = await Promise.all([
    readRegion(firstPath, firstTile.render.globalPixelRect, commonRect),
    readRegion(secondPath, secondTile.render.globalPixelRect, commonRect),
  ]);
  const metrics = compareBuffers(
    firstBuffer,
    secondBuffer,
    commonRect.width,
    commonRect.height,
    plan.validation.minimumSignificantChannelDelta ?? 0,
  );
  const seamBandPixels = plan.validation.seamBandPixels ?? 32;
  const band = seamBand(adjacent.axis, commonRect, seamBandPixels);
  const seamBandMetrics = compareBuffers(
    extractBufferRegion(firstBuffer, commonRect.width, band),
    extractBufferRegion(secondBuffer, commonRect.width, band),
    band.width,
    band.height,
    plan.validation.minimumSignificantChannelDelta ?? 0,
  );
  const seamBandPassed = seamBandMetrics.mismatchRatio <= (
    plan.validation.maxSeamMismatchRatio ?? plan.validation.maxOverlapMismatchRatio
  )
    && seamBandMetrics.meanAbsoluteRgbChannelDelta
      <= (plan.validation.maxSeamMeanAbsoluteRgbChannelDelta
        ?? plan.validation.maxMeanAbsoluteRgbChannelDelta);
  const fullOverlapPassed = metrics.mismatchRatio <= plan.validation.maxOverlapMismatchRatio
    && metrics.meanAbsoluteRgbChannelDelta <= plan.validation.maxMeanAbsoluteRgbChannelDelta;
  const fullOverlapMeanPassed = metrics.meanAbsoluteRgbChannelDelta <= (
    plan.validation.maxFullOverlapMeanAbsoluteRgbChannelDelta
      ?? plan.validation.maxMeanAbsoluteRgbChannelDelta
  );
  const passed = seamBandPassed && fullOverlapMeanPassed;
  pairs.push({
    ...adjacent,
    commonGlobalPixelRect: commonRect,
    firstImage: firstPath,
    secondImage: secondPath,
    metrics,
    seamBandPixels,
    seamBandGlobalPixelRect: {
      left: commonRect.left + band.left,
      top: commonRect.top + band.top,
      width: band.width,
      height: band.height,
    },
    seamBandMetrics,
    seamBandPassed,
    fullOverlapPassed,
    fullOverlapMeanPassed,
    passed,
  });
}

const complete = missingPairs.length === 0;
const passed = pairs.length > 0 && pairs.every((pair) => pair.passed)
  && (complete || options.allowPartial);
const report = {
  schemaVersion: "1.0.0",
  route: "vrf-orthographic-tile-overlap-validation-v2",
  plan: { path: options.planPath, sha256: planHash },
  thresholds: plan.validation,
  complete,
  comparedPairCount: pairs.length,
  missingPairCount: missingPairs.length,
  passed,
  pairs,
  missingPairs,
};
await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output: options.outputPath,
  complete,
  passed,
  comparedPairCount: pairs.length,
  maximumMismatchRatio: Math.max(0, ...pairs.map((pair) => pair.metrics.mismatchRatio)),
  maximumMeanAbsoluteRgbChannelDelta: Math.max(
    0,
    ...pairs.map((pair) => pair.metrics.meanAbsoluteRgbChannelDelta)
  ),
}, null, 2)}\n`);
if (options.enforce && !passed) {
  process.exitCode = 2;
}
