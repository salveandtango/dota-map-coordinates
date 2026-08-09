import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

function parseArguments(argv) {
  const values = new Map();
  let enforce = false;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--enforce") {
      enforce = true;
      continue;
    }
    if (key === "--force") {
      force = true;
      continue;
    }
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
  const integer = (key, fallback = undefined) => {
    const raw = values.get(key);
    if (raw === undefined && fallback !== undefined) return fallback;
    const value = Number.parseInt(raw ?? required(key), 10);
    if (!Number.isSafeInteger(value)) throw new Error(`${key} must be an integer`);
    return value;
  };
  return {
    first: path.resolve(required("--first")),
    second: path.resolve(required("--second")),
    output: path.resolve(required("--output")),
    dx: integer("--dx", 0),
    dy: integer("--dy", 0),
    enforce,
    force,
  };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex").toUpperCase();
}

async function decodeRgb(target) {
  const { data, info } = await sharp(target, { limitInputPixels: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3, `${target} must decode to RGB`);
  return { data, width: info.width, height: info.height };
}

function compare(first, second, dx, dy) {
  const firstLeft = Math.max(0, -dx);
  const firstTop = Math.max(0, -dy);
  const firstRight = Math.min(first.width, second.width - dx);
  const firstBottom = Math.min(first.height, second.height - dy);
  const width = firstRight - firstLeft;
  const height = firstBottom - firstTop;
  if (width <= 0 || height <= 0) throw new Error("The translated images do not overlap");

  const firstBytes = Buffer.allocUnsafe(width * height * 3);
  const secondBytes = Buffer.allocUnsafe(width * height * 3);
  let mismatchPixels = 0;
  let absoluteRgbChannelDelta = 0;
  let outputOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const firstY = firstTop + row;
    const secondY = firstY + dy;
    for (let column = 0; column < width; column += 1) {
      const firstX = firstLeft + column;
      const secondX = firstX + dx;
      const firstOffset = (firstY * first.width + firstX) * 3;
      const secondOffset = (secondY * second.width + secondX) * 3;
      let differs = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const firstValue = first.data[firstOffset + channel];
        const secondValue = second.data[secondOffset + channel];
        firstBytes[outputOffset] = firstValue;
        secondBytes[outputOffset] = secondValue;
        outputOffset += 1;
        const delta = Math.abs(firstValue - secondValue);
        absoluteRgbChannelDelta += delta;
        differs ||= delta !== 0;
      }
      mismatchPixels += differs ? 1 : 0;
    }
  }
  const pixels = width * height;
  return {
    translationConvention: "first image content appears at (x + dx, y + dy) in second image",
    dx,
    dy,
    overlap: { width, height, pixels },
    firstOverlapSha256: sha256(firstBytes),
    secondOverlapSha256: sha256(secondBytes),
    mismatchPixels,
    mismatchRatio: mismatchPixels / pixels,
    meanAbsoluteRgbChannelDelta: absoluteRgbChannelDelta / (pixels * 3),
    identicalOverlap: mismatchPixels === 0,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.force && await exists(options.output)) {
    throw new Error(`Refusing to overwrite report: ${options.output}`);
  }
  const [firstFile, secondFile, first, second] = await Promise.all([
    readFile(options.first),
    readFile(options.second),
    decodeRgb(options.first),
    decodeRgb(options.second),
  ]);
  const comparison = compare(first, second, options.dx, options.dy);
  const report = {
    schemaVersion: "1.0.0",
    route: "vrf-orthographic-image-exact-comparison-v1",
    first: {
      path: options.first,
      width: first.width,
      height: first.height,
      fileSha256: sha256(firstFile),
      decodedContentSha256: sha256(first.data),
    },
    second: {
      path: options.second,
      width: second.width,
      height: second.height,
      fileSha256: sha256(secondFile),
      decodedContentSha256: sha256(second.data),
    },
    comparison,
    passed: comparison.identicalOverlap,
  };
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (options.enforce && !report.passed) process.exitCode = 2;
}

await main();
