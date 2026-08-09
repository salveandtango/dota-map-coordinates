import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { readJson } from "./tile-stack-common.mjs";

function argumentsOf(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  const required = (key) => {
    const value = values.get(key);
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  return {
    report: path.resolve(required("--report")),
    first: required("--first"),
    second: required("--second"),
    output: path.resolve(required("--output")),
  };
}

async function region(imagePath, imageRect, commonRect) {
  return sharp(imagePath, { limitInputPixels: false })
    .extract({
      left: commonRect.left - imageRect.left,
      top: commonRect.top - imageRect.top,
      width: commonRect.width,
      height: commonRect.height,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function deltaDistribution(first, second, sourceWidth, regionRect) {
  const histogram = Array.from({ length: 256 }, () => 0);
  for (let row = 0; row < regionRect.height; row += 1) {
    for (let column = 0; column < regionRect.width; column += 1) {
      const pixel = ((regionRect.top + row) * sourceWidth + regionRect.left + column) * 3;
      let maximum = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        maximum = Math.max(maximum, Math.abs(first[pixel + channel] - second[pixel + channel]));
      }
      histogram[maximum] += 1;
    }
  }
  const pixels = regionRect.width * regionRect.height;
  const thresholds = [0, 1, 2, 4, 8, 16, 32, 64, 128];
  return {
    pixels,
    exactMaximumChannelDeltaHistogram: Object.fromEntries(
      histogram.map((count, delta) => [String(delta), count]).filter(([, count]) => count > 0),
    ),
    pixelsAboveMaximumChannelDelta: Object.fromEntries(thresholds.map((threshold) => {
      const count = histogram.slice(threshold + 1).reduce((total, item) => total + item, 0);
      return [String(threshold), { count, ratio: count / pixels }];
    })),
  };
}

async function main() {
  const args = argumentsOf(process.argv.slice(2));
  const report = await readJson(args.report);
  const pair = report.pairs.find((item) => item.first === args.first && item.second === args.second);
  if (!pair) throw new Error(`Pair not found: ${args.first} -> ${args.second}`);
  const plan = await readJson(report.plan.path);
  const tiles = new Map(plan.tiles.map((tile) => [tile.id, tile]));
  const firstTile = tiles.get(pair.first);
  const secondTile = tiles.get(pair.second);
  const first = await region(pair.firstImage, firstTile.render.globalPixelRect, pair.commonGlobalPixelRect);
  const second = await region(pair.secondImage, secondTile.render.globalPixelRect, pair.commonGlobalPixelRect);
  const diff = Buffer.alloc(first.data.length);
  for (let index = 0; index < diff.length; index += 1) {
    diff[index] = Math.min(255, Math.abs(first.data[index] - second.data[index]) * 6);
  }
  await mkdir(args.output, { recursive: true });
  const width = pair.commonGlobalPixelRect.width;
  const height = pair.commonGlobalPixelRect.height;
  const seamBandRect = {
    left: pair.seamBandGlobalPixelRect.left - pair.commonGlobalPixelRect.left,
    top: pair.seamBandGlobalPixelRect.top - pair.commonGlobalPixelRect.top,
    width: pair.seamBandGlobalPixelRect.width,
    height: pair.seamBandGlobalPixelRect.height,
  };
  const diagnostic = {
    schemaVersion: "1.0.0",
    route: "vrf-orthographic-overlap-diagnostic-v1",
    pair: `${pair.first}->${pair.second}`,
    metrics: pair.metrics,
    seamBandMetrics: pair.seamBandMetrics,
    fullOverlapDeltaDistribution: deltaDistribution(
      first.data,
      second.data,
      width,
      { left: 0, top: 0, width, height },
    ),
    seamBandDeltaDistribution: deltaDistribution(
      first.data,
      second.data,
      width,
      seamBandRect,
    ),
  };
  await sharp(first.data, { raw: { width, height, channels: 3 } }).png().toFile(path.join(args.output, "first.png"));
  await sharp(second.data, { raw: { width, height, channels: 3 } }).png().toFile(path.join(args.output, "second.png"));
  await sharp(diff, { raw: { width, height, channels: 3 } }).png().toFile(path.join(args.output, "diff-6x.png"));
  const previewHeight = Math.min(height, 2304);
  await sharp({ create: { width: width * 3, height: previewHeight, channels: 3, background: "black" } })
    .composite([
      { input: first.data, raw: { width, height, channels: 3 }, left: 0, top: 0 },
      { input: second.data, raw: { width, height, channels: 3 }, left: width, top: 0 },
      { input: diff, raw: { width, height, channels: 3 }, left: width * 2, top: 0 },
    ])
    .png()
    .toFile(path.join(args.output, "comparison.png"));
  await writeFile(path.join(args.output, "diagnostic.json"), `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...diagnostic, output: args.output }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
