import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

function parseArgs(argv) {
  const result = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      result.config = argv[++index];
    } else if (argument === "--tiles") {
      result.tiles = argv[++index];
    } else if (argument === "--output") {
      result.output = argv[++index];
    } else if (argument === "--force") {
      result.force = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  for (const required of ["config", "tiles", "output"]) {
    if (!result[required]) {
      throw new Error(`--${required} is required`);
    }
  }
  return result;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

function tileFileName(pattern, x, y) {
  return pattern.replace("{x}", String(x)).replace("{y}", String(y));
}

function tileKey(x, y) {
  return `${x},${y}`;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function getCrop(config, key) {
  const base = config.captureCrop;
  const override = base.tileOverrides?.[key] ?? {};
  return {
    savedTileWidth: override.savedTileWidth ?? base.savedTileWidth,
    savedTileHeight: override.savedTileHeight ?? base.savedTileHeight,
    left: override.contentLeft ?? base.contentLeft,
    top: override.contentTop ?? base.contentTop,
    width: override.contentWidth ?? base.contentWidth,
    height: override.contentHeight ?? base.contentHeight
  };
}

function getPlacement(config, x, y) {
  const projection = config.projection;
  return {
    left:
      -Math.round(projection.pixelsPerWorldUnit * y) +
      projection.canvasLeftAtY0,
    top:
      -Math.round(projection.pixelsPerWorldUnit * x) +
      projection.canvasTopAtX0
  };
}

async function ensureWritable(outputs, force) {
  if (force) {
    return;
  }
  for (const output of outputs) {
    try {
      await stat(output);
      throw new Error(`Output exists; pass --force to replace it: ${output}`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function loadTiles(config, tilesDirectory) {
  const records = [];
  for (const x of config.camera.xPositions) {
    for (const y of config.camera.yPositions) {
      records.push({ x, y, distance: Math.abs(x) + Math.abs(y) });
    }
  }
  records.sort((left, right) => left.distance - right.distance);

  const loaded = [];
  for (const record of records) {
    const key = tileKey(record.x, record.y);
    const fileName =
      config.tileFiles.sourceOverrides?.[key] ??
      tileFileName(config.tileFiles.pattern, record.x, record.y);
    const filePath = path.join(tilesDirectory, fileName);
    const crop = getCrop(config, key);
    const metadata = await sharp(filePath).metadata();
    if (
      metadata.width !== crop.savedTileWidth ||
      metadata.height !== crop.savedTileHeight
    ) {
      throw new Error(
        `${fileName} is ${metadata.width}x${metadata.height}; ` +
          `profile expects ${crop.savedTileWidth}x${crop.savedTileHeight}`
      );
    }
    if (
      crop.left + crop.width > metadata.width ||
      crop.top + crop.height > metadata.height
    ) {
      throw new Error(`Content crop exceeds tile bounds: ${fileName}`);
    }
    const data = await sharp(filePath)
      .extract({
        left: crop.left,
        top: crop.top,
        width: crop.width,
        height: crop.height
      })
      .removeAlpha()
      .raw()
      .toBuffer();
    const placement = getPlacement(config, record.x, record.y);
    loaded.push({
      ...record,
      key,
      fileName,
      filePath,
      sourceSha256: await sha256File(filePath),
      left: placement.left,
      top: placement.top,
      width: crop.width,
      height: crop.height,
      data
    });
  }
  return loaded;
}

function computeOverlapDelta(config, leftTile, rightTile) {
  const left = Math.max(leftTile.left, rightTile.left);
  const top = Math.max(leftTile.top, rightTile.top);
  const right = Math.min(
    leftTile.left + leftTile.width,
    rightTile.left + rightTile.width
  );
  const bottom = Math.min(
    leftTile.top + leftTile.height,
    rightTile.top + rightTile.height
  );
  if (left >= right || top >= bottom) {
    throw new Error(
      `Expected overlap between ${leftTile.key} and ${rightTile.key}`
    );
  }

  const exposure = config.exposure;
  const sums = [0, 0, 0];
  let count = 0;
  for (let y = top; y < bottom; y += exposure.sampleStep) {
    for (let x = left; x < right; x += exposure.sampleStep) {
      const leftIndex =
        ((y - leftTile.top) * leftTile.width + (x - leftTile.left)) * 3;
      const rightIndex =
        ((y - rightTile.top) * rightTile.width + (x - rightTile.left)) * 3;
      const leftLuminance =
        (leftTile.data[leftIndex] +
          leftTile.data[leftIndex + 1] +
          leftTile.data[leftIndex + 2]) /
        3;
      const rightLuminance =
        (rightTile.data[rightIndex] +
          rightTile.data[rightIndex + 1] +
          rightTile.data[rightIndex + 2]) /
        3;
      if (
        leftLuminance > exposure.minLuminance &&
        rightLuminance > exposure.minLuminance &&
        leftLuminance < exposure.maxLuminance &&
        rightLuminance < exposure.maxLuminance
      ) {
        for (let channel = 0; channel < 3; channel += 1) {
          sums[channel] += Math.log(
            (leftTile.data[leftIndex + channel] + exposure.logEpsilon) /
              (rightTile.data[rightIndex + channel] + exposure.logEpsilon)
          );
        }
        count += 1;
      }
    }
  }
  if (count === 0) {
    throw new Error(
      `No usable exposure samples between ${leftTile.key} and ${rightTile.key}`
    );
  }
  return {
    a: leftTile.key,
    b: rightTile.key,
    count,
    delta: sums.map((sum) => sum / count),
    box: [left, top, right, bottom]
  };
}

function buildExposureEdges(config, tiles) {
  const tileMap = new Map(tiles.map((tile) => [tile.key, tile]));
  const xPositions = config.camera.xPositions;
  const yPositions = config.camera.yPositions;
  const xStep =
    xPositions.length > 1 ? Math.abs(xPositions[1] - xPositions[0]) : 0;
  const yStep =
    yPositions.length > 1 ? Math.abs(yPositions[1] - yPositions[0]) : 0;
  const edges = [];
  for (const tile of tiles) {
    for (const [dx, dy] of [
      [xStep, 0],
      [0, yStep]
    ]) {
      const neighbor = tileMap.get(tileKey(tile.x + dx, tile.y + dy));
      if (neighbor) {
        edges.push(computeOverlapDelta(config, tile, neighbor));
      }
    }
  }
  return { edges, tileMap, xStep, yStep };
}

function solveExposureGains(config, tiles, edges) {
  const gains = Object.fromEntries(tiles.map((tile) => [tile.key, [0, 0, 0]]));
  const exposure = config.exposure;
  for (let iteration = 0; iteration < exposure.iterationCount; iteration += 1) {
    for (const tile of tiles) {
      if (tile.key === exposure.anchorTile) {
        continue;
      }
      const sums = [0, 0, 0];
      let totalWeight = 0;
      for (const edge of edges) {
        const weight = Math.min(edge.count, exposure.edgeWeightCap);
        if (edge.a === tile.key) {
          for (let channel = 0; channel < 3; channel += 1) {
            sums[channel] +=
              weight * (gains[edge.b][channel] - edge.delta[channel]);
          }
          totalWeight += weight;
        } else if (edge.b === tile.key) {
          for (let channel = 0; channel < 3; channel += 1) {
            sums[channel] +=
              weight * (gains[edge.a][channel] + edge.delta[channel]);
          }
          totalWeight += weight;
        }
      }
      if (totalWeight > 0) {
        for (let channel = 0; channel < 3; channel += 1) {
          gains[tile.key][channel] = clamp(
            sums[channel] / totalWeight,
            -exposure.maxAbsoluteLogGain,
            exposure.maxAbsoluteLogGain
          );
        }
      }
    }
  }
  return gains;
}

function overlapAtLeft(tile, neighbor) {
  return neighbor ? neighbor.left + neighbor.width - tile.left : 0;
}

function overlapAtRight(tile, neighbor) {
  return neighbor ? tile.left + tile.width - neighbor.left : 0;
}

function overlapAtTop(tile, neighbor) {
  return neighbor ? neighbor.top + neighbor.height - tile.top : 0;
}

function overlapAtBottom(tile, neighbor) {
  return neighbor ? tile.top + tile.height - neighbor.top : 0;
}

function assembleMosaic(config, tiles, tileMap, gains, xStep, yStep) {
  const width = config.canvas.width;
  const height = config.canvas.height;
  const pixelCount = width * height;
  const red = new Float32Array(pixelCount);
  const green = new Float32Array(pixelCount);
  const blue = new Float32Array(pixelCount);
  const weights = new Float32Array(pixelCount);

  for (const tile of tiles) {
    const leftNeighbor = tileMap.get(tileKey(tile.x, tile.y + yStep));
    const rightNeighbor = tileMap.get(tileKey(tile.x, tile.y - yStep));
    const topNeighbor = tileMap.get(tileKey(tile.x + xStep, tile.y));
    const bottomNeighbor = tileMap.get(tileKey(tile.x - xStep, tile.y));
    const leftOverlap = overlapAtLeft(tile, leftNeighbor);
    const rightOverlap = overlapAtRight(tile, rightNeighbor);
    const topOverlap = overlapAtTop(tile, topNeighbor);
    const bottomOverlap = overlapAtBottom(tile, bottomNeighbor);
    const multipliers = gains[tile.key].map(Math.exp);

    for (let localY = 0; localY < tile.height; localY += 1) {
      let verticalWeight = 1;
      if (topOverlap > 0 && localY < topOverlap) {
        verticalWeight = Math.min(
          verticalWeight,
          (localY + 1) / topOverlap
        );
      }
      if (
        bottomOverlap > 0 &&
        localY >= tile.height - bottomOverlap
      ) {
        verticalWeight = Math.min(
          verticalWeight,
          (tile.height - localY) / bottomOverlap
        );
      }
      for (let localX = 0; localX < tile.width; localX += 1) {
        let horizontalWeight = 1;
        if (leftOverlap > 0 && localX < leftOverlap) {
          horizontalWeight = Math.min(
            horizontalWeight,
            (localX + 1) / leftOverlap
          );
        }
        if (
          rightOverlap > 0 &&
          localX >= tile.width - rightOverlap
        ) {
          horizontalWeight = Math.min(
            horizontalWeight,
            (tile.width - localX) / rightOverlap
          );
        }
        const weight = horizontalWeight * verticalWeight;
        const sourceIndex = (localY * tile.width + localX) * 3;
        const destinationIndex =
          (tile.top + localY) * width + tile.left + localX;
        red[destinationIndex] +=
          tile.data[sourceIndex] * multipliers[0] * weight;
        green[destinationIndex] +=
          tile.data[sourceIndex + 1] * multipliers[1] * weight;
        blue[destinationIndex] +=
          tile.data[sourceIndex + 2] * multipliers[2] * weight;
        weights[destinationIndex] += weight;
      }
    }
  }

  const output = Buffer.alloc(pixelCount * 3);
  for (let index = 0; index < pixelCount; index += 1) {
    const weight = weights[index];
    if (weight > 0) {
      output[index * 3] = clamp(Math.round(red[index] / weight), 0, 255);
      output[index * 3 + 1] = clamp(
        Math.round(green[index] / weight),
        0,
        255
      );
      output[index * 3 + 2] = clamp(
        Math.round(blue[index] / weight),
        0,
        255
      );
    }
  }
  return output;
}

function encodeTga24(rgb, width, height) {
  const bgr = Buffer.alloc(rgb.length);
  for (let index = 0; index < rgb.length; index += 3) {
    bgr[index] = rgb[index + 2];
    bgr[index + 1] = rgb[index + 1];
    bgr[index + 2] = rgb[index];
  }
  const header = Buffer.alloc(18);
  header[2] = 2;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 24;
  header[17] = 0x20;
  return Buffer.concat([header, bgr]);
}

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config);
const tilesDirectory = path.resolve(args.tiles);
const outputDirectory = path.resolve(args.output);
const configBytes = await readFile(configPath);
const config = JSON.parse(configBytes.toString("utf8"));
if (config.product !== "normal-3d-world-render") {
  throw new Error("Profile does not target a normal 3D world render");
}
await mkdir(outputDirectory, { recursive: true });

const normalizedPath = path.join(
  outputDirectory,
  config.finalOutput.normalizedName
);
const pngPath = path.join(outputDirectory, config.finalOutput.pngName);
const tgaPath = path.join(outputDirectory, config.finalOutput.tgaName);
const reportPath = path.join(outputDirectory, config.finalOutput.reportName);
await ensureWritable(
  [normalizedPath, pngPath, tgaPath, reportPath],
  args.force
);

const tiles = await loadTiles(config, tilesDirectory);
const { edges, tileMap, xStep, yStep } = buildExposureEdges(config, tiles);
const gains = solveExposureGains(config, tiles, edges);
const mosaic = assembleMosaic(
  config,
  tiles,
  tileMap,
  gains,
  xStep,
  yStep
);

await sharp(mosaic, {
  raw: {
    width: config.canvas.width,
    height: config.canvas.height,
    channels: 3
  }
})
  .png()
  .toFile(normalizedPath);

await sharp(normalizedPath)
  .extract({
    left: config.finalOutput.cropLeft,
    top: config.finalOutput.cropTop,
    width: config.finalOutput.cropSize,
    height: config.finalOutput.cropSize
  })
  .resize(config.finalOutput.width, config.finalOutput.height, {
    kernel: "lanczos3"
  })
  .removeAlpha()
  .png({ compressionLevel: 9 })
  .toFile(pngPath);

const finalRaw = await sharp(pngPath)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const tga = encodeTga24(
  finalRaw.data,
  config.finalOutput.width,
  config.finalOutput.height
);
await writeFile(tgaPath, tga);

const report = {
  schemaVersion: 1,
  toolVersion: "1.0.0",
  profileId: config.profileId,
  dotaBuildId: config.dotaBuildId,
  product: config.product,
  configPath,
  configSha256: sha256(configBytes),
  tileCount: tiles.length,
  tiles: tiles.map((tile) => ({
    id: tile.key,
    file: tile.fileName,
    sha256: tile.sourceSha256,
    placement: {
      left: tile.left,
      top: tile.top,
      width: tile.width,
      height: tile.height
    },
    logGain: gains[tile.key]
  })),
  exposureEdges: edges,
  outputs: {
    normalizedPng: {
      path: normalizedPath,
      width: config.canvas.width,
      height: config.canvas.height,
      sha256: await sha256File(normalizedPath)
    },
    png: {
      path: pngPath,
      width: config.finalOutput.width,
      height: config.finalOutput.height,
      sha256: await sha256File(pngPath)
    },
    tga: {
      path: tgaPath,
      width: config.finalOutput.width,
      height: config.finalOutput.height,
      bitsPerPixel: 24,
      origin: "top-left",
      sha256: await sha256File(tgaPath)
    }
  },
  knownLimitations: config.knownLimitations
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report.outputs, null, 2)}\n`);
