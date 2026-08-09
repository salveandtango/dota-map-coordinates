import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { exists, readJson, sha256 } from "./tile-stack-common.mjs";

const TILE_SIZE = 512;
const BUILD_STATE_SCHEMA = "dota-native-z5-map-package-build-v2";
const LEVEL_SPECS = [
  { z: 0, unitsPerPixel: 16, width: 1280, height: 1312, source: "canonical-4u" },
  { z: 1, unitsPerPixel: 8, width: 2560, height: 2624, source: "canonical-4u" },
  { z: 2, unitsPerPixel: 4, width: 5120, height: 5248, source: "canonical-4u" },
  { z: 3, unitsPerPixel: 2, width: 10240, height: 10496, source: "native-z5" },
  { z: 4, unitsPerPixel: 1, width: 20480, height: 20992, source: "native-z5" },
  { z: 5, unitsPerPixel: 0.5, width: 40960, height: 41984, source: "native-z5" },
].map((level) => ({
  ...level,
  columns: Math.ceil(level.width / TILE_SIZE),
  rows: Math.ceil(level.height / TILE_SIZE),
}));

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Invalid argument: ${key}`);
    values.set(key, argv[++index]);
  }
  const requiredPath = (key) => path.resolve(required(key));
  const required = (key) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing required argument ${key}`);
    return value;
  };
  return {
    z5Root: requiredPath("--z5-root"),
    z5ManifestPath: requiredPath("--z5-manifest"),
    base4uPath: requiredPath("--base-4u"),
    outputRoot: requiredPath("--output"),
    mapProfile: required("--map-profile"),
    pendingRoot: values.has("--pending-root") ? path.resolve(values.get("--pending-root")) : null,
  };
}

function tilePath(root, z, x, y) {
  return path.join(root, "tiles", String(z), String(x), `${y}.png`);
}

function z5TilePath(root, x, y) {
  return path.join(root, String(x), `${y}.png`);
}

function aggregate(entries) {
  const digest = createHash("sha256");
  for (const entry of entries) digest.update(entry.sha256, "ascii");
  return digest.digest("hex").toUpperCase();
}

async function hardlinkOrCopy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await link(source, destination);
  } catch (error) {
    if (!["EXDEV", "EPERM", "ENOTSUP"].includes(error.code)) throw error;
    await copyFile(source, destination);
  }
}

async function reusableTile(output, expectedHash = null) {
  if (!await exists(output)) return null;
  try {
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, TILE_SIZE);
    assert.equal(metadata.height, TILE_SIZE);
    const hash = await sha256(output);
    if (expectedHash !== null) assert.equal(hash, expectedHash);
    return hash;
  } catch {
    await rm(output, { force: true });
    return null;
  }
}

async function writePaddedTile(input, extract, validWidth, validHeight, output) {
  let content = sharp(input, { limitInputPixels: false }).extract(extract).removeAlpha();
  if (extract.width !== validWidth || extract.height !== validHeight) {
    content = content.resize(validWidth, validHeight, { kernel: sharp.kernel.lanczos3 });
  }
  const buffer = await content.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  await mkdir(path.dirname(output), { recursive: true });
  if (validWidth === TILE_SIZE && validHeight === TILE_SIZE) {
    await writeFile(output, buffer);
  } else {
    await sharp({ create: { width: TILE_SIZE, height: TILE_SIZE, channels: 3, background: "black" } })
      .composite([{ input: buffer, left: 0, top: 0 }])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(output);
  }
}

async function buildFromBase4u(base4uPath, pendingRoot, level) {
  const sourceScale = level.unitsPerPixel / 4;
  const entries = [];
  for (let y = 0; y < level.rows; y += 1) {
    for (let x = 0; x < level.columns; x += 1) {
      const validWidth = Math.min(TILE_SIZE, level.width - x * TILE_SIZE);
      const validHeight = Math.min(TILE_SIZE, level.height - y * TILE_SIZE);
      const output = tilePath(pendingRoot, level.z, x, y);
      const reusableHash = await reusableTile(output);
      if (reusableHash !== null) {
        entries.push({ x, y, sha256: reusableHash });
        continue;
      }
      await writePaddedTile(
        base4uPath,
        {
          left: x * TILE_SIZE * sourceScale,
          top: y * TILE_SIZE * sourceScale,
          width: validWidth * sourceScale,
          height: validHeight * sourceScale,
        },
        validWidth,
        validHeight,
        output,
      );
      entries.push({ x, y, sha256: await sha256(output) });
    }
  }
  return entries;
}

export async function buildFromZ5(z5Root, pendingRoot, level) {
  const downsample = level.unitsPerPixel / 0.5;
  const sourceSpan = TILE_SIZE * downsample;
  const entries = [];
  for (let y = 0; y < level.rows; y += 1) {
    for (let x = 0; x < level.columns; x += 1) {
      const validWidth = Math.min(TILE_SIZE, level.width - x * TILE_SIZE);
      const validHeight = Math.min(TILE_SIZE, level.height - y * TILE_SIZE);
      const validSourceWidth = validWidth * downsample;
      const validSourceHeight = validHeight * downsample;
      const sourceLeft = x * sourceSpan;
      const sourceTop = y * sourceSpan;
      const output = tilePath(pendingRoot, level.z, x, y);
      const reusableHash = await reusableTile(output);
      if (reusableHash !== null) {
        entries.push({ x, y, sha256: reusableHash });
        continue;
      }
      const firstX = Math.floor(sourceLeft / TILE_SIZE);
      const firstY = Math.floor(sourceTop / TILE_SIZE);
      const pieces = [];
      for (let sourceY = firstY; sourceY * TILE_SIZE < sourceTop + validSourceHeight; sourceY += 1) {
        for (let sourceX = firstX; sourceX * TILE_SIZE < sourceLeft + validSourceWidth; sourceX += 1) {
          const source = z5TilePath(z5Root, sourceX, sourceY);
          if (!await exists(source)) throw new Error(`Missing native Z5 source ${sourceX}/${sourceY}`);
          pieces.push({
            input: source,
            left: sourceX * TILE_SIZE - sourceLeft,
            top: sourceY * TILE_SIZE - sourceTop,
          });
        }
      }
      // Materialize the source mosaic before resizing it. Combining composite()
      // and resize() in one Sharp pipeline lets libvips reorder the operations
      // for partial edge rows, where a 512px source piece can then appear larger
      // than the resized destination canvas.
      const sourceMosaic = await sharp({
        create: { width: validSourceWidth, height: validSourceHeight, channels: 3, background: "black" },
      })
        .composite(pieces)
        .png({ compressionLevel: 1 })
        .toBuffer();
      const resized = await sharp(sourceMosaic, { limitInputPixels: false })
        .resize({
          width: validWidth,
          height: validHeight,
          fit: "fill",
          kernel: sharp.kernel.lanczos3,
        })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      const resizedMetadata = await sharp(resized).metadata();
      assert.equal(resizedMetadata.width, validWidth, `Unexpected Z${level.z} tile width at ${x}/${y}`);
      assert.equal(resizedMetadata.height, validHeight, `Unexpected Z${level.z} tile height at ${x}/${y}`);
      await mkdir(path.dirname(output), { recursive: true });
      if (validWidth === TILE_SIZE && validHeight === TILE_SIZE) {
        await writeFile(output, resized);
      } else {
        await sharp({ create: { width: TILE_SIZE, height: TILE_SIZE, channels: 3, background: "black" } })
          .composite([{ input: resized, left: 0, top: 0 }])
          .png({ compressionLevel: 9, adaptiveFiltering: true })
          .toFile(output);
      }
      entries.push({ x, y, sha256: await sha256(output) });
    }
    process.stdout.write(`Built Z${level.z} row ${y + 1}/${level.rows}\n`);
  }
  return entries;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (await exists(args.outputRoot)) throw new Error(`Output already exists: ${args.outputRoot}`);
  const manifestPath = path.join(args.outputRoot, "tile-manifest.json");
  const pendingRoot = args.pendingRoot ?? `${args.outputRoot}.pending`;

  const z5Manifest = await readJson(args.z5ManifestPath);
  assert.equal(z5Manifest.route, "dota-normal-world-native-z5-release-v1");
  assert.equal(z5Manifest.level.coverage, "full");
  assert.equal(z5Manifest.level.nativeTileCount, 6560);
  assert.equal(z5Manifest.tiles.length, 6560);
  const baseMetadata = await sharp(args.base4uPath, { limitInputPixels: false }).metadata();
  assert.equal(baseMetadata.width, 5120);
  assert.equal(baseMetadata.height, 5248);
  const baseMapSha256 = await sha256(args.base4uPath);
  const buildState = {
    schemaVersion: BUILD_STATE_SCHEMA,
    mapProfile: args.mapProfile,
    z5ManifestSha256: await sha256(args.z5ManifestPath),
    z5AssetRevision: z5Manifest.assetRevision,
    baseMapSha256,
  };
  const expectedZ5 = new Map(z5Manifest.tiles.map((entry) => [`${entry.x}:${entry.y}`, entry.sha256]));
  assert.equal(expectedZ5.size, 6560);

  const buildStatePath = path.join(pendingRoot, "build-state.json");
  if (await exists(pendingRoot)) {
    const existingState = await readJson(buildStatePath);
    assert.deepEqual(existingState, buildState, `Pending output identity mismatch: ${pendingRoot}`);
    process.stdout.write(`Resuming validated pending output ${pendingRoot}\n`);
  } else {
    await mkdir(pendingRoot, { recursive: false });
    await writeFile(buildStatePath, `${JSON.stringify(buildState, null, 2)}\n`, "utf8");
  }
  try {
    const levelEntries = [];
    for (const level of LEVEL_SPECS) {
      let entries;
      if (level.z === 5) {
        entries = [];
        for (let y = 0; y < level.rows; y += 1) {
          for (let x = 0; x < level.columns; x += 1) {
            const source = z5TilePath(args.z5Root, x, y);
            const expectedHash = expectedZ5.get(`${x}:${y}`);
            if (!expectedHash || await sha256(source) !== expectedHash) {
              throw new Error(`Native Z5 hash mismatch at ${x}/${y}`);
            }
            const output = tilePath(pendingRoot, 5, x, y);
            const reusableHash = await reusableTile(output, expectedHash);
            if (reusableHash === null) await hardlinkOrCopy(source, output);
            entries.push({ x, y, sha256: expectedHash });
          }
          if ((y + 1) % 10 === 0 || y + 1 === level.rows) {
            process.stdout.write(`Packaged Z5 row ${y + 1}/${level.rows}\n`);
          }
        }
      } else if (level.source === "canonical-4u") {
        entries = await buildFromBase4u(args.base4uPath, pendingRoot, level);
      } else {
        entries = await buildFromZ5(args.z5Root, pendingRoot, level);
      }
      assert.equal(entries.length, level.columns * level.rows);
      levelEntries.push({
        z: level.z,
        unitsPerPixel: level.unitsPerPixel,
        coverage: "full",
        source: level.source,
        width: level.width,
        height: level.height,
        columns: level.columns,
        rows: level.rows,
        nativeTileCount: entries.length,
        aggregateTileSha256: aggregate(entries),
      });
    }

    const assetRevision = z5Manifest.assetRevision;
    const manifest = {
      schemaVersion: "3.0.0",
      route: "dota-normal-world-multires-tiles-v3",
      mapProfile: args.mapProfile,
      assetRevision,
      dotaBuildId: z5Manifest.dotaBuildId,
      sourceRevision: z5Manifest.sourceRevision,
      baseMapSha256,
      product: "normal-3d-world-render",
      notMinimap: true,
      tileSize: TILE_SIZE,
      worldBounds: z5Manifest.worldBounds,
      orientation: z5Manifest.orientation,
      worldToPixel: z5Manifest.worldToPixel,
      levels: levelEntries,
      completeFullResolution: true,
      completeNativeZ5: true,
      treeState: "initial-static-preserved",
      tileUrlTemplate: `/assets/dota/maps/${args.mapProfile}/${assetRevision}/{z}/{x}/{y}.png`,
      sourceAssets: {
        canonical4u: { sha256: baseMapSha256 },
        nativeZ5Manifest: { sha256: await sha256(args.z5ManifestPath) },
        officialDotaVmap: z5Manifest.sources.officialDotaVmap,
        compiledMapVpk: z5Manifest.sources.compiledMapVpk,
        gridNav: z5Manifest.sources.gridNav,
        tilePlan: z5Manifest.sources.tilePlan,
        seamReport: z5Manifest.sources.seamReport,
      },
    };
    await writeFile(path.join(pendingRoot, "tile-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const packagedZ5 = levelEntries.find((level) => level.z === 5);
    assert.ok(packagedZ5, "Packaged Z5 level is missing");
    await writeFile(path.join(pendingRoot, "z5-tile-index.json"), `${JSON.stringify({
      schemaVersion: "1.0.0",
      assetRevision,
      aggregateTileSha256: packagedZ5.aggregateTileSha256,
      sourceNativeZ5AggregateSha256: z5Manifest.level.aggregateTileSha256,
      tiles: z5Manifest.tiles,
    }, null, 2)}\n`, "utf8");
    await rename(pendingRoot, args.outputRoot);
    process.stdout.write(`${JSON.stringify({ status: "ok", manifest: manifestPath, assetRevision, levels: levelEntries }, null, 2)}\n`);
  } catch (error) {
    await rm(pendingRoot, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
