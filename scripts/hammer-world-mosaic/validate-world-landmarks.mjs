import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

function parseArguments(argv) {
  const values = new Map();
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
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
    if (value === undefined) {
      throw new Error(`Missing required argument ${key}`);
    }
    return path.resolve(value);
  };
  return {
    image: required("--image"),
    imageManifest: required("--image-manifest"),
    entityManifest: required("--entity-manifest"),
    outputDirectory: required("--output-dir"),
    visualReview: values.has("--visual-review")
      ? path.resolve(values.get("--visual-review"))
      : null,
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

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex").toUpperCase();
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shortName(targetName) {
  return targetName.replace(/^\[PR#\]/, "");
}

function markerSvg(width, height, centerX, centerY, label = null) {
  const text = label === null
    ? ""
    : `<text x="${centerX}" y="${centerY + 5}" text-anchor="middle" `
      + 'font-family="Arial" font-size="14" font-weight="700" fill="white">'
      + `${escapeXml(label)}</text>`;
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="${centerX}" cy="${centerY}" r="15" fill="none" stroke="#ff1744" stroke-width="4"/>`
    + `<line x1="${centerX - 24}" y1="${centerY}" x2="${centerX + 24}" y2="${centerY}" stroke="#ff1744" stroke-width="2"/>`
    + `<line x1="${centerX}" y1="${centerY - 24}" x2="${centerX}" y2="${centerY + 24}" stroke="#ff1744" stroke-width="2"/>`
    + text
    + "</svg>"
  );
}

function labelSvg(width, height, firstLine, secondLine) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
    + '<rect width="100%" height="100%" fill="#111827"/>'
    + `<text x="10" y="20" font-family="Arial" font-size="14" font-weight="700" fill="white">${escapeXml(firstLine)}</text>`
    + `<text x="10" y="39" font-family="Arial" font-size="12" fill="#cbd5e1">${escapeXml(secondLine)}</text>`
    + "</svg>"
  );
}

async function buildContactSheet(image, landmarks, output) {
  const cropSize = 256;
  const labelHeight = 48;
  const cellWidth = cropSize;
  const cellHeight = cropSize + labelHeight;
  const columns = 4;
  const rows = Math.ceil(landmarks.length / columns);
  const composites = [];

  for (const landmark of landmarks) {
    const left = Math.round(landmark.pixel.x) - cropSize / 2;
    const top = Math.round(landmark.pixel.y) - cropSize / 2;
    const crop = await sharp(image)
      .extract({ left, top, width: cropSize, height: cropSize })
      .composite([{ input: markerSvg(cropSize, cropSize, cropSize / 2, cropSize / 2) }])
      .png()
      .toBuffer();
    const label = labelSvg(
      cellWidth,
      labelHeight,
      `${landmark.index}. ${landmark.id}`,
      `world ${landmark.world.x.toFixed(1)}, ${landmark.world.y.toFixed(1)} | px ${landmark.pixel.x.toFixed(2)}, ${landmark.pixel.y.toFixed(2)}`
    );
    const cell = await sharp({
      create: {
        width: cellWidth,
        height: cellHeight,
        channels: 3,
        background: "#111827",
      },
    })
      .composite([
        { input: label, left: 0, top: 0 },
        { input: crop, left: 0, top: labelHeight },
      ])
      .png()
      .toBuffer();
    composites.push({
      input: cell,
      left: (landmark.index - 1) % columns * cellWidth,
      top: Math.floor((landmark.index - 1) / columns) * cellHeight,
    });
  }

  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 3,
      background: "#0b1020",
    },
  }).composite(composites).png().toFile(output);
}

async function buildOverview(image, metadata, landmarks, output) {
  const width = 1280;
  const height = Math.round(metadata.height * width / metadata.width);
  const scale = width / metadata.width;
  const markers = landmarks.map((landmark) => ({
    input: markerSvg(
      width,
      height,
      landmark.pixel.x * scale,
      landmark.pixel.y * scale,
      landmark.index
    ),
    left: 0,
    top: 0,
  }));
  await sharp(image)
    .resize(width, height)
    .composite(markers)
    .png()
    .toFile(output);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const reportPath = path.join(options.outputDirectory, "validation-report.json");
  const landmarksPath = path.join(options.outputDirectory, "tower-landmarks.json");
  const overviewPath = path.join(options.outputDirectory, "tower-landmarks-overview.png");
  const contactSheetPath = path.join(options.outputDirectory, "tower-landmarks-contact-sheet.png");
  if (!options.force && await exists(reportPath)) {
    throw new Error(`Refusing to overwrite output: ${reportPath}`);
  }
  await mkdir(options.outputDirectory, { recursive: true });

  const [imageManifest, entityManifest, metadata] = await Promise.all([
    readJson(options.imageManifest),
    readJson(options.entityManifest),
    sharp(options.image).metadata(),
  ]);
  if (metadata.width !== imageManifest.image.width || metadata.height !== imageManifest.image.height) {
    throw new Error("Image dimensions do not match its manifest");
  }
  const actualImageHash = await sha256(options.image);
  if (actualImageHash !== imageManifest.image.sha256) {
    throw new Error("Image SHA256 does not match its manifest");
  }
  if (imageManifest.inputs.vpk.sha256 !== entityManifest.inputs.vpk.sha256
      || imageManifest.inputs.gridNav.sha256 !== entityManifest.inputs.gridNav.sha256) {
    throw new Error("Entity probe and final image do not use the same VPK/GridNav inputs");
  }

  const grid = imageManifest.inputs.gridNav;
  const bounds = imageManifest.worldBounds;
  const unitsPerPixelX = bounds.unitsPerPixelX;
  const unitsPerPixelY = bounds.unitsPerPixelY;
  const towerEntities = entityManifest.landmarkEntities
    .filter((entity) => entity.className === "npc_dota_tower")
    .sort((left, right) => shortName(left.targetName).localeCompare(shortName(right.targetName)));
  if (towerEntities.length < 20) {
    throw new Error(`Need at least 20 towers, found ${towerEntities.length}`);
  }

  const visualReview = options.visualReview ? await readJson(options.visualReview) : null;
  const reviewedIds = new Set(
    visualReview?.landmarks
      ?.filter((landmark) => landmark.status === "confirmed")
      .map((landmark) => landmark.id)
      ?? []
  );

  const landmarks = [];
  for (let offset = 0; offset < towerEntities.length; offset += 1) {
    const entity = towerEntities[offset];
    const [worldX, worldY, worldZ] = entity.origin;
    const pixelX = (worldX - bounds.left) / unitsPerPixelX;
    const pixelY = (bounds.top - worldY) / unitsPerPixelY;
    const roundedPixelX = Math.round(pixelX);
    const roundedPixelY = Math.round(pixelY);
    const roundTripWorldX = bounds.left + roundedPixelX * unitsPerPixelX;
    const roundTripWorldY = bounds.top - roundedPixelY * unitsPerPixelY;
    const gridX = Math.floor(worldX / grid.edgeSize);
    const gridY = Math.floor(worldY / grid.edgeSize);
    const gridColumn = gridX - grid.minX;
    const gridRowFromTop = grid.maxY - gridY;
    const inBounds = pixelX >= 0 && pixelX < metadata.width
      && pixelY >= 0 && pixelY < metadata.height
      && gridColumn >= 0 && gridColumn < grid.width
      && gridRowFromTop >= 0 && gridRowFromTop < grid.height;
    if (!inBounds) {
      throw new Error(`Landmark is outside image/GridNav bounds: ${entity.targetName}`);
    }

    const patchSize = 64;
    const patchLeft = Math.max(0, Math.min(metadata.width - patchSize, roundedPixelX - patchSize / 2));
    const patchTop = Math.max(0, Math.min(metadata.height - patchSize, roundedPixelY - patchSize / 2));
    const stats = await sharp(options.image)
      .extract({ left: patchLeft, top: patchTop, width: patchSize, height: patchSize })
      .stats();
    const rgbStandardDeviation = stats.channels.slice(0, 3)
      .reduce((sum, channel) => sum + channel.stdev, 0) / 3;
    const rgbMean = stats.channels.slice(0, 3)
      .reduce((sum, channel) => sum + channel.mean, 0) / 3;
    const roundedWorldError = Math.hypot(
      roundTripWorldX - worldX,
      roundTripWorldY - worldY
    );
    const id = shortName(entity.targetName);
    landmarks.push({
      index: offset + 1,
      id,
      className: entity.className,
      model: entity.model,
      world: { x: worldX, y: worldY, z: worldZ },
      gridNav: {
        cellX: gridX,
        cellY: gridY,
        columnFromLeft: gridColumn,
        rowFromTop: gridRowFromTop,
      },
      pixel: {
        x: pixelX,
        y: pixelY,
        roundedX: roundedPixelX,
        roundedY: roundedPixelY,
      },
      roundTrip: {
        worldX: roundTripWorldX,
        worldY: roundTripWorldY,
        errorWorldUnits: roundedWorldError,
      },
      localImageEvidence: {
        patchSize,
        rgbMean,
        rgbStandardDeviation,
        featureVariancePassed: rgbStandardDeviation >= 5,
      },
      visualReview: reviewedIds.has(id) ? "confirmed" : "pending",
      automaticPassed: roundedWorldError <= Math.SQRT2 * Math.max(unitsPerPixelX, unitsPerPixelY)
        && rgbStandardDeviation >= 5,
    });
  }

  const quadrantCounts = {
    northwest: landmarks.filter((item) => item.world.x < 0 && item.world.y >= 0).length,
    northeast: landmarks.filter((item) => item.world.x >= 0 && item.world.y >= 0).length,
    southwest: landmarks.filter((item) => item.world.x < 0 && item.world.y < 0).length,
    southeast: landmarks.filter((item) => item.world.x >= 0 && item.world.y < 0).length,
  };
  const maximumRoundTripError = Math.max(...landmarks.map((item) => item.roundTrip.errorWorldUnits));
  const automaticPassed = landmarks.length >= 20
    && Object.values(quadrantCounts).every((count) => count > 0)
    && landmarks.every((item) => item.automaticPassed);
  const visualPassed = landmarks.every((item) => item.visualReview === "confirmed");

  await Promise.all([
    buildOverview(options.image, metadata, landmarks, overviewPath),
    buildContactSheet(options.image, landmarks, contactSheetPath),
  ]);
  await writeFile(
    landmarksPath,
    `${JSON.stringify({ schemaVersion: "1.0.0", landmarks }, null, 2)}\n`,
    "utf8"
  );

  const report = {
    schemaVersion: "1.0.0",
    gate: "H5",
    route: "vrf-strict-orthographic-canonical-canvas-v1",
    passed: automaticPassed && visualPassed,
    automaticPassed,
    visualPassed,
    sources: {
      image: { path: options.image, sha256: actualImageHash },
      imageManifest: { path: options.imageManifest, sha256: await sha256(options.imageManifest) },
      entityManifest: { path: options.entityManifest, sha256: await sha256(options.entityManifest) },
      vpkSha256: imageManifest.inputs.vpk.sha256,
      gridNavSha256: imageManifest.inputs.gridNav.sha256,
    },
    transform: {
      imageWidth: metadata.width,
      imageHeight: metadata.height,
      left: bounds.left,
      top: bounds.top,
      unitsPerPixelX,
      unitsPerPixelY,
      pixelX: "(worldX - left) / unitsPerPixelX",
      pixelY: "(top - worldY) / unitsPerPixelY",
      gridCellX: "floor(worldX / edgeSize)",
      gridCellY: "floor(worldY / edgeSize)",
      edgeSize: grid.edgeSize,
    },
    validation: {
      landmarkClass: "npc_dota_tower",
      landmarkCount: landmarks.length,
      requiredLandmarkCount: 20,
      quadrantCounts,
      maximumRoundedPixelWorldError: maximumRoundTripError,
      allowedWorldError: grid.edgeSize,
      automaticFailureCount: landmarks.filter((item) => !item.automaticPassed).length,
      visualPendingCount: landmarks.filter((item) => item.visualReview !== "confirmed").length,
    },
    artifacts: {
      landmarks: landmarksPath,
      overview: overviewPath,
      contactSheet: contactSheetPath,
      visualReview: options.visualReview,
    },
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) {
    process.exitCode = 2;
  }
}

await main();
