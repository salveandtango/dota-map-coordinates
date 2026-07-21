import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

function parseArgs(argv) {
  const result = {
    sampleSize: 1024,
    threshold: 8,
    minimumArea: 300,
    output: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      result.config = argv[++index];
    } else if (argument === "--image") {
      result.image = argv[++index];
    } else if (argument === "--output") {
      result.output = argv[++index];
    } else if (argument === "--sample-size") {
      result.sampleSize = Number(argv[++index]);
    } else if (argument === "--threshold") {
      result.threshold = Number(argv[++index]);
    } else if (argument === "--minimum-area") {
      result.minimumArea = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!result.config || !result.image) {
    throw new Error("--config and --image are required");
  }
  return result;
}

function canvasToWorld(config, canvasX, canvasY) {
  const projection = config.projection;
  return {
    x:
      (projection.worldOriginPixelY - canvasY) /
      projection.pixelsPerWorldUnit,
    y:
      (projection.worldOriginPixelX - canvasX) /
      projection.pixelsPerWorldUnit
  };
}

function finalToCanvas(config, finalX, finalY) {
  const output = config.finalOutput;
  return {
    x: output.cropLeft + (finalX * output.cropSize) / output.width,
    y: output.cropTop + (finalY * output.cropSize) / output.height
  };
}

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config);
const imagePath = path.resolve(args.image);
const config = JSON.parse(await readFile(configPath, "utf8"));
const sampled = await sharp(imagePath)
  .resize(args.sampleSize, args.sampleSize, {
    fit: "fill",
    kernel: "nearest"
  })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width, height } = sampled.info;
const black = new Uint8Array(width * height);
for (let index = 0; index < black.length; index += 1) {
  const source = index * 3;
  black[index] =
    sampled.data[source] <= args.threshold &&
    sampled.data[source + 1] <= args.threshold &&
    sampled.data[source + 2] <= args.threshold
      ? 1
      : 0;
}

const visited = new Uint8Array(width * height);
const components = [];
const queue = new Int32Array(width * height);
for (let seed = 0; seed < black.length; seed += 1) {
  if (!black[seed] || visited[seed]) {
    continue;
  }
  let head = 0;
  let tail = 0;
  queue[tail++] = seed;
  visited[seed] = 1;
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  let minimumX = width;
  let minimumY = height;
  let maximumX = 0;
  let maximumY = 0;
  let touchesBoundary = false;
  while (head < tail) {
    const current = queue[head++];
    const y = Math.floor(current / width);
    const x = current - y * width;
    area += 1;
    sumX += x;
    sumY += y;
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      touchesBoundary = true;
    }
    for (const neighbor of [
      current - 1,
      current + 1,
      current - width,
      current + width
    ]) {
      if (neighbor < 0 || neighbor >= black.length || visited[neighbor]) {
        continue;
      }
      const neighborY = Math.floor(neighbor / width);
      const neighborX = neighbor - neighborY * width;
      if (Math.abs(neighborX - x) + Math.abs(neighborY - y) !== 1) {
        continue;
      }
      if (black[neighbor]) {
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
  }
  if (!touchesBoundary && area >= args.minimumArea) {
    const sampleCentroid = { x: sumX / area, y: sumY / area };
    const finalCentroid = {
      x: (sampleCentroid.x * config.finalOutput.width) / width,
      y: (sampleCentroid.y * config.finalOutput.height) / height
    };
    const canvasCentroid = finalToCanvas(
      config,
      finalCentroid.x,
      finalCentroid.y
    );
    const worldCenter = canvasToWorld(
      config,
      canvasCentroid.x,
      canvasCentroid.y
    );
    components.push({
      areaAtSampleResolution: area,
      sampleBoundingBox: {
        left: minimumX,
        top: minimumY,
        right: maximumX,
        bottom: maximumY
      },
      finalCentroid,
      canvasCentroid,
      recommendedCameraCenter: {
        x: Math.round(worldCenter.x / 100) * 100,
        y: Math.round(worldCenter.y / 100) * 100,
        z: config.camera.z,
        pitch: config.camera.pitch,
        yaw: config.camera.yaw,
        roll: config.camera.roll
      }
    });
  }
}
components.sort(
  (left, right) =>
    right.areaAtSampleResolution - left.areaAtSampleResolution
);
const report = {
  schemaVersion: 1,
  imagePath,
  profileId: config.profileId,
  detection: {
    sampleWidth: width,
    sampleHeight: height,
    rgbThreshold: args.threshold,
    minimumArea: args.minimumArea,
    boundaryComponentsIgnored: true
  },
  internalVoidCount: components.length,
  internalVoids: components
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (args.output) {
  await writeFile(path.resolve(args.output), serialized, "utf8");
}
process.stdout.write(serialized);
