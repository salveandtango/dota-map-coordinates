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
    } else if (argument === "--base") {
      result.base = argv[++index];
    } else if (argument === "--captures") {
      result.captures = argv[++index];
    } else if (argument === "--output") {
      result.output = argv[++index];
    } else if (argument === "--force") {
      result.force = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  for (const required of ["config", "base", "captures", "output"]) {
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

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
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

function worldToFinal(config, worldX, worldY) {
  const projection = config.baseProjection;
  const scale = projection.outputWidth / projection.cropSize;
  const canvasX =
    projection.worldOriginPixelX -
    projection.pixelsPerWorldUnit * worldY;
  const canvasY =
    projection.worldOriginPixelY -
    projection.pixelsPerWorldUnit * worldX;
  return {
    x: (canvasX - projection.cropLeft) * scale,
    y: (canvasY - projection.cropTop) * scale
  };
}

function detectInternalBlackComponents(
  data,
  width,
  height,
  threshold,
  minimumArea
) {
  const pixelCount = width * height;
  const black = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const source = index * 3;
    black[index] =
      data[source] <= threshold &&
      data[source + 1] <= threshold &&
      data[source + 2] <= threshold
        ? 1
        : 0;
  }

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const components = [];
  for (let seed = 0; seed < pixelCount; seed += 1) {
    if (!black[seed] || visited[seed]) {
      continue;
    }
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    const indices = [];
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
      indices.push(current);
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
        if (neighbor < 0 || neighbor >= pixelCount || visited[neighbor]) {
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
    if (!touchesBoundary && indices.length >= minimumArea) {
      components.push({
        indices,
        area: indices.length,
        centroid: {
          x: sumX / indices.length,
          y: sumY / indices.length
        },
        boundingBox: {
          left: minimumX,
          top: minimumY,
          right: maximumX,
          bottom: maximumY
        }
      });
    }
  }
  return components.sort((left, right) => right.area - left.area);
}

function componentDistance(component, target) {
  return Math.hypot(
    component.centroid.x - target.x,
    component.centroid.y - target.y
  );
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

async function createRepairOverlay({
  config,
  repair,
  component,
  capturePath,
  outputDirectory,
  width,
  height
}) {
  const captureMetadata = await sharp(capturePath).metadata();
  if (
    captureMetadata.width !== config.capture.windowWidth ||
    captureMetadata.height !== config.capture.windowHeight
  ) {
    throw new Error(
      `${repair.captureFile} is ${captureMetadata.width}x${captureMetadata.height}; ` +
        `profile expects ${config.capture.windowWidth}x${config.capture.windowHeight}`
    );
  }

  const outputScale =
    config.baseProjection.outputWidth / config.baseProjection.cropSize;
  const patchScale =
    (outputScale * config.baseProjection.referenceContentWidth) /
    config.capture.contentWidth;
  const resizedWidth = Math.round(config.capture.contentWidth * patchScale);
  const resizedHeight = Math.round(config.capture.contentHeight * patchScale);
  const resized = await sharp(capturePath)
    .extract({
      left: config.capture.contentLeft,
      top: config.capture.contentTop,
      width: config.capture.contentWidth,
      height: config.capture.contentHeight
    })
    .resize(resizedWidth, resizedHeight, { kernel: "lanczos3" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const targetCenter = worldToFinal(
    config,
    repair.camera.x,
    repair.camera.y
  );
  const placement = {
    left:
      Math.round(targetCenter.x - resizedWidth / 2) +
      (repair.outputOffset?.x ?? 0),
    top:
      Math.round(targetCenter.y - resizedHeight / 2) +
      (repair.outputOffset?.y ?? 0),
    width: resizedWidth,
    height: resizedHeight
  };

  const padding = Math.max(12, Math.ceil(config.mask.featherSigma * 4));
  const region = {
    left: clamp(component.boundingBox.left - padding, 0, width - 1),
    top: clamp(component.boundingBox.top - padding, 0, height - 1),
    right: clamp(component.boundingBox.right + padding, 0, width - 1),
    bottom: clamp(component.boundingBox.bottom + padding, 0, height - 1)
  };
  region.width = region.right - region.left + 1;
  region.height = region.bottom - region.top + 1;

  const regionRgb = Buffer.alloc(region.width * region.height * 3);
  for (let localY = 0; localY < region.height; localY += 1) {
    const globalY = region.top + localY;
    const sourceY = globalY - placement.top;
    if (sourceY < 0 || sourceY >= resizedHeight) {
      continue;
    }
    for (let localX = 0; localX < region.width; localX += 1) {
      const globalX = region.left + localX;
      const sourceX = globalX - placement.left;
      if (sourceX < 0 || sourceX >= resizedWidth) {
        continue;
      }
      const sourceIndex = (sourceY * resizedWidth + sourceX) * 3;
      const destinationIndex = (localY * region.width + localX) * 3;
      regionRgb[destinationIndex] = resized[sourceIndex];
      regionRgb[destinationIndex + 1] = resized[sourceIndex + 1];
      regionRgb[destinationIndex + 2] = resized[sourceIndex + 2];
    }
  }

  const binaryMask = Buffer.alloc(region.width * region.height);
  let covered = 0;
  for (const index of component.indices) {
    const globalY = Math.floor(index / width);
    const globalX = index - globalY * width;
    const localX = globalX - region.left;
    const localY = globalY - region.top;
    const localIndex = localY * region.width + localX;
    binaryMask[localIndex] = 255;
    const rgbIndex = localIndex * 3;
    if (
      regionRgb[rgbIndex] > config.mask.blackThreshold ||
      regionRgb[rgbIndex + 1] > config.mask.blackThreshold ||
      regionRgb[rgbIndex + 2] > config.mask.blackThreshold
    ) {
      covered += 1;
    }
  }
  const coverage = covered / component.area;
  if (coverage < config.mask.minimumPatchCoverage) {
    throw new Error(
      `${repair.id} patch coverage ${coverage.toFixed(4)} is below ` +
        `${config.mask.minimumPatchCoverage}`
    );
  }

  const blurredMask = await sharp(binaryMask, {
    raw: { width: region.width, height: region.height, channels: 1 }
  })
    .blur(config.mask.featherSigma)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = Buffer.alloc(region.width * region.height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] =
      blurredMask.data[index * blurredMask.info.channels];
  }
  const rgba = Buffer.alloc(region.width * region.height * 4);
  for (let index = 0; index < region.width * region.height; index += 1) {
    rgba[index * 4] = regionRgb[index * 3];
    rgba[index * 4 + 1] = regionRgb[index * 3 + 1];
    rgba[index * 4 + 2] = regionRgb[index * 3 + 2];
    rgba[index * 4 + 3] = alpha[index];
  }

  const maskPath = path.join(outputDirectory, `${repair.id}-mask.png`);
  const alignedPath = path.join(
    outputDirectory,
    `${repair.id}-aligned-region.png`
  );
  await sharp(binaryMask, {
    raw: { width: region.width, height: region.height, channels: 1 }
  })
    .png()
    .toFile(maskPath);
  await sharp(regionRgb, {
    raw: { width: region.width, height: region.height, channels: 3 }
  })
    .png()
    .toFile(alignedPath);

  return {
    overlay: {
      input: rgba,
      left: region.left,
      top: region.top,
      raw: {
        width: region.width,
        height: region.height,
        channels: 4
      }
    },
    report: {
      id: repair.id,
      tileGridLayer: repair.tileGridLayer,
      capturePath,
      captureSha256: await sha256File(capturePath),
      camera: repair.camera,
      targetCenter,
      detectedVoid: {
        area: component.area,
        centroid: component.centroid,
        boundingBox: component.boundingBox
      },
      patchScale,
      placement,
      coverage,
      featherSigma: config.mask.featherSigma,
      diagnostics: {
        maskPath,
        maskSha256: await sha256File(maskPath),
        alignedRegionPath: alignedPath,
        alignedRegionSha256: await sha256File(alignedPath)
      }
    }
  };
}

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config);
const basePath = path.resolve(args.base);
const capturesDirectory = path.resolve(args.captures);
const outputDirectory = path.resolve(args.output);
const configBytes = await readFile(configPath);
const config = JSON.parse(configBytes.toString("utf8"));
if (config.schemaVersion !== 2) {
  throw new Error("High-ground repair profile schemaVersion must be 2");
}
if (config.product !== "normal-3d-world-render") {
  throw new Error("Profile does not target a normal 3D world render");
}
await mkdir(outputDirectory, { recursive: true });

const pngPath = path.join(outputDirectory, config.finalOutput.pngName);
const tgaPath = path.join(outputDirectory, config.finalOutput.tgaName);
const reportPath = path.join(outputDirectory, config.finalOutput.reportName);
await ensureWritable([pngPath, tgaPath, reportPath], args.force);

const base = await sharp(basePath)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width, height } = base.info;
if (
  width !== config.baseProjection.outputWidth ||
  height !== config.baseProjection.outputHeight
) {
  throw new Error(
    `Base image is ${width}x${height}; profile expects ` +
      `${config.baseProjection.outputWidth}x${config.baseProjection.outputHeight}`
  );
}

const components = detectInternalBlackComponents(
  base.data,
  width,
  height,
  config.mask.blackThreshold,
  config.mask.minimumArea
);
if (components.length !== config.repairs.length) {
  throw new Error(
    `Expected ${config.repairs.length} internal black components, found ` +
      `${components.length}`
  );
}

const unassigned = new Set(components);
const overlays = [];
const repairReports = [];
for (const repair of config.repairs) {
  const target = worldToFinal(config, repair.camera.x, repair.camera.y);
  const component = [...unassigned].sort(
    (left, right) =>
      componentDistance(left, target) - componentDistance(right, target)
  )[0];
  unassigned.delete(component);
  const capturePath = path.join(capturesDirectory, repair.captureFile);
  const created = await createRepairOverlay({
    config,
    repair,
    component,
    capturePath,
    outputDirectory,
    width,
    height
  });
  overlays.push(created.overlay);
  repairReports.push(created.report);
}

await sharp(basePath)
  .removeAlpha()
  .composite(overlays)
  .png({ compressionLevel: 9 })
  .toFile(pngPath);

const finalRaw = await sharp(pngPath)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
await writeFile(tgaPath, encodeTga24(finalRaw.data, width, height));

const report = {
  schemaVersion: 2,
  toolVersion: "1.1.0",
  profileId: config.profileId,
  baseProfileId: config.baseProfileId,
  dotaBuildId: config.dotaBuildId,
  product: config.product,
  configPath,
  configSha256: sha256(configBytes),
  base: {
    path: basePath,
    sha256: await sha256File(basePath),
    width,
    height
  },
  detection: {
    blackThreshold: config.mask.blackThreshold,
    minimumArea: config.mask.minimumArea,
    boundaryComponentsIgnored: true,
    internalComponentCount: components.length
  },
  repairs: repairReports,
  outputs: {
    png: {
      path: pngPath,
      width,
      height,
      sha256: await sha256File(pngPath)
    },
    tga: {
      path: tgaPath,
      width,
      height,
      bitsPerPixel: 24,
      origin: "top-left",
      sha256: await sha256File(tgaPath)
    }
  },
  knownLimitations: config.knownLimitations
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report.outputs, null, 2)}\n`);
