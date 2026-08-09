import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { exists, readJson } from "./tile-stack-common.mjs";

function parseArguments(argv) {
  const values = new Map();
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--force") { force = true; continue; }
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
    summaryPath: required("--summary"),
    outputPath: required("--output"),
    force,
  };
}

async function rawRgb(imagePath) {
  return sharp(imagePath, { limitInputPixels: false })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function compare(first, second) {
  if (first.info.width !== second.info.width
      || first.info.height !== second.info.height
      || first.info.channels !== 3
      || second.info.channels !== 3) {
    throw new Error("Camera sweep images must have equal RGB dimensions");
  }
  const pixelCount = first.info.width * first.info.height;
  let mismatchPixels = 0;
  let absoluteDelta = 0;
  let maxChannelDelta = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    let mismatch = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const offset = pixel * 3 + channel;
      const delta = Math.abs(first.data[offset] - second.data[offset]);
      mismatch ||= delta !== 0;
      absoluteDelta += delta;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    mismatchPixels += mismatch ? 1 : 0;
  }
  return {
    width: first.info.width,
    height: first.info.height,
    pixels: pixelCount,
    mismatchPixels,
    mismatchRatio: mismatchPixels / pixelCount,
    meanAbsoluteRgbChannelDelta: absoluteDelta / (pixelCount * 3),
    maxChannelDelta,
  };
}

const options = parseArguments(process.argv.slice(2));
if (!options.force && await exists(options.outputPath)) {
  throw new Error(`Refusing to overwrite camera comparison: ${options.outputPath}`);
}
const summary = await readJson(options.summaryPath);
if (!Array.isArray(summary.renders) || summary.renders.length < 2) {
  throw new Error("Camera sweep summary needs at least two renders");
}
const buffers = new Map();
for (const render of summary.renders) {
  buffers.set(render.cameraZ, await rawRgb(render.image));
}
const comparisons = [];
for (let index = 0; index + 1 < summary.renders.length; index += 1) {
  const first = summary.renders[index];
  const second = summary.renders[index + 1];
  comparisons.push({
    firstCameraZ: first.cameraZ,
    secondCameraZ: second.cameraZ,
    firstImage: first.image,
    secondImage: second.image,
    metrics: compare(buffers.get(first.cameraZ), buffers.get(second.cameraZ)),
  });
}
const report = {
  schemaVersion: "1.0.0",
  route: "vrf-orthographic-camera-height-pixel-comparison-v1",
  sourceSummary: options.summaryPath,
  scaleInvariant: summary.renders.every((render) =>
    render.worldBounds.unitsPerPixelX === summary.region.unitsPerPixelX
    && render.worldBounds.unitsPerPixelY === summary.region.unitsPerPixelY),
  maximumMismatchRatio: Math.max(...comparisons.map((item) => item.metrics.mismatchRatio)),
  maximumMeanAbsoluteRgbChannelDelta: Math.max(
    ...comparisons.map((item) => item.metrics.meanAbsoluteRgbChannelDelta)
  ),
  comparisons,
};
await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output: options.outputPath,
  scaleInvariant: report.scaleInvariant,
  maximumMismatchRatio: report.maximumMismatchRatio,
  maximumMeanAbsoluteRgbChannelDelta: report.maximumMeanAbsoluteRgbChannelDelta,
}, null, 2)}\n`);
