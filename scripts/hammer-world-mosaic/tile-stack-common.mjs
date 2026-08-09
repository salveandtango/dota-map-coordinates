import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

export async function sha256(target) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(target);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

function finite(value, label) {
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  return value;
}

function positiveInteger(value, label) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

export function validateTileProfile(profile) {
  assert.equal(profile.schemaVersion, 4);
  assert.equal(profile.product, "normal-3d-world-render");
  assert.equal(profile.routeId, "vrf-strict-orthographic-tile-stack-v1");
  assert.equal(profile.projection.type, "orthographic-reverse-z");
  assert.equal(profile.projection.orientation.imageRight, "world +X");
  assert.equal(profile.projection.orientation.imageDown, "world -Y");

  positiveInteger(profile.renderingQuality.maxTextureSize, "renderingQuality.maxTextureSize");
  assert.equal(typeof profile.renderingQuality.forceHighestLod, "boolean",
    "renderingQuality.forceHighestLod must be boolean");

  const bounds = profile.projection.worldBounds;
  finite(bounds.left, "worldBounds.left");
  finite(bounds.right, "worldBounds.right");
  finite(bounds.bottom, "worldBounds.bottom");
  finite(bounds.top, "worldBounds.top");
  assert.ok(bounds.right > bounds.left, "world bounds must have positive width");
  assert.ok(bounds.top > bounds.bottom, "world bounds must have positive height");

  const unitsPerPixel = finite(profile.projection.unitsPerPixel, "unitsPerPixel");
  assert.ok(unitsPerPixel > 0, "unitsPerPixel must be positive");
  const exactWidth = (bounds.right - bounds.left) / unitsPerPixel;
  const exactHeight = (bounds.top - bounds.bottom) / unitsPerPixel;
  assert.ok(Math.abs(exactWidth - Math.round(exactWidth)) < 1e-9,
    "world width must be an integer number of pixels");
  assert.ok(Math.abs(exactHeight - Math.round(exactHeight)) < 1e-9,
    "world height must be an integer number of pixels");

  positiveInteger(profile.tiling.coreWidthPixels, "coreWidthPixels");
  positiveInteger(profile.tiling.coreHeightPixels, "coreHeightPixels");
  positiveInteger(profile.tiling.overscanPixels, "overscanPixels");
  assert.equal(profile.tiling.traversal, "row-major-top-left");
  assert.equal(profile.tiling.stitchMode, "hard-core-crop");

  const camera = profile.projection.camera;
  assert.ok(finite(camera.z, "camera.z") > 0, "camera.z must be positive");
  assert.ok(finite(camera.near, "camera.near") > 0, "camera.near must be positive");
  assert.ok(finite(camera.far, "camera.far") > camera.near, "camera.far must exceed near");
  positiveInteger(camera.warmupFrames, "camera.warmupFrames");
  positiveInteger(camera.msaaSamples, "camera.msaaSamples");
  assert.ok(finite(camera.exposure, "camera.exposure") > 0, "camera.exposure must be positive");

  assert.ok(profile.validation.maxOverlapMismatchRatio >= 0
    && profile.validation.maxOverlapMismatchRatio <= 1);
  assert.ok(profile.validation.maxMeanAbsoluteRgbChannelDelta >= 0);
  const minimumSignificantChannelDelta = profile.validation.minimumSignificantChannelDelta ?? 0;
  assert.ok(Number.isInteger(minimumSignificantChannelDelta)
    && minimumSignificantChannelDelta >= 0
    && minimumSignificantChannelDelta <= 255,
  "minimumSignificantChannelDelta must be an integer in [0, 255]");
  return profile;
}

export function buildTilePlan(profile) {
  validateTileProfile(profile);
  const bounds = profile.projection.worldBounds;
  const unitsPerPixel = profile.projection.unitsPerPixel;
  const mosaicWidth = Math.round((bounds.right - bounds.left) / unitsPerPixel);
  const mosaicHeight = Math.round((bounds.top - bounds.bottom) / unitsPerPixel);
  const coreWidth = profile.tiling.coreWidthPixels;
  const coreHeight = profile.tiling.coreHeightPixels;
  const overscan = profile.tiling.overscanPixels;
  const columns = Math.ceil(mosaicWidth / coreWidth);
  const rows = Math.ceil(mosaicHeight / coreHeight);
  const tiles = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const coreLeft = column * coreWidth;
      const coreTop = row * coreHeight;
      const actualCoreWidth = Math.min(coreWidth, mosaicWidth - coreLeft);
      const actualCoreHeight = Math.min(coreHeight, mosaicHeight - coreTop);
      const renderWidth = actualCoreWidth + overscan * 2;
      const renderHeight = actualCoreHeight + overscan * 2;
      const globalRenderLeft = coreLeft - overscan;
      const globalRenderTop = coreTop - overscan;
      const worldLeft = bounds.left + globalRenderLeft * unitsPerPixel;
      const worldTop = bounds.top - globalRenderTop * unitsPerPixel;
      const spanX = renderWidth * unitsPerPixel;
      const spanY = renderHeight * unitsPerPixel;
      const id = `r${String(row).padStart(3, "0")}-c${String(column).padStart(3, "0")}`;

      tiles.push({
        id,
        row,
        column,
        rawImage: `tiles/raw/${id}.png`,
        coreImage: `tiles/core/${id}.png`,
        render: {
          pixelWidth: renderWidth,
          pixelHeight: renderHeight,
          globalPixelRect: {
            left: globalRenderLeft,
            top: globalRenderTop,
            width: renderWidth,
            height: renderHeight,
          },
          centerX: worldLeft + spanX / 2,
          centerY: worldTop - spanY / 2,
          spanX,
          spanY,
          worldBounds: {
            left: worldLeft,
            right: worldLeft + spanX,
            bottom: worldTop - spanY,
            top: worldTop,
          },
        },
        core: {
          sourceRect: {
            left: overscan,
            top: overscan,
            width: actualCoreWidth,
            height: actualCoreHeight,
          },
          destinationRect: {
            left: coreLeft,
            top: coreTop,
            width: actualCoreWidth,
            height: actualCoreHeight,
          },
        },
      });
    }
  }

  const byPosition = new Map(tiles.map((tile) => [`${tile.row},${tile.column}`, tile]));
  const adjacency = [];
  for (const tile of tiles) {
    const right = byPosition.get(`${tile.row},${tile.column + 1}`);
    const down = byPosition.get(`${tile.row + 1},${tile.column}`);
    if (right) {
      adjacency.push({ axis: "horizontal", first: tile.id, second: right.id });
    }
    if (down) {
      adjacency.push({ axis: "vertical", first: tile.id, second: down.id });
    }
  }

  return {
    schemaVersion: "1.0.0",
    route: profile.routeId,
    profileId: profile.profileId,
    dotaBuildId: profile.dotaBuildId,
    inputs: profile.inputs,
    renderer: profile.renderer,
    renderingQuality: profile.renderingQuality,
    projection: profile.projection,
    tiling: profile.tiling,
    validation: profile.validation,
    mosaic: {
      width: mosaicWidth,
      height: mosaicHeight,
      columns,
      rows,
      tileCount: tiles.length,
      worldBounds: bounds,
      unitsPerPixel,
      worldToPixel: {
        pixelX: "(worldX - left) / unitsPerPixel",
        pixelY: "(top - worldY) / unitsPerPixel",
      },
    },
    tiles,
    adjacency,
  };
}

export function intersection(first, second) {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.left + first.width, second.left + second.width);
  const bottom = Math.min(first.top + first.height, second.top + second.height);
  if (right <= left || bottom <= top) {
    return null;
  }
  return { left, top, width: right - left, height: bottom - top };
}

export function resolvePlanPath(planPath, relativePath) {
  return path.resolve(path.dirname(planPath), relativePath);
}
