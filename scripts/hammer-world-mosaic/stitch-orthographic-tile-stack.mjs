import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import {
  exists,
  readJson,
  resolvePlanPath,
  sha256,
} from "./tile-stack-common.mjs";

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
    planPath: required("--plan"),
    overlapReportPath: required("--overlap-report"),
    outputPath: required("--output"),
    force,
  };
}

const options = parseArguments(process.argv.slice(2));
const outputManifestPath = `${options.outputPath}.json`;
if (!options.force && (await exists(options.outputPath) || await exists(outputManifestPath))) {
  throw new Error(`Refusing to overwrite stitched output: ${options.outputPath}`);
}
const [plan, overlapReport] = await Promise.all([
  readJson(options.planPath),
  readJson(options.overlapReportPath),
]);
const planHash = await sha256(options.planPath);
if (overlapReport.plan.sha256 !== planHash) {
  throw new Error("Overlap report belongs to a different tile plan");
}
if (!overlapReport.passed || !overlapReport.complete) {
  throw new Error("A complete passing overlap report is required before stitching");
}

const composites = [];
const tileEvidence = [];
for (const tile of plan.tiles) {
  const corePath = resolvePlanPath(options.planPath, tile.coreImage);
  const coreManifestPath = `${corePath}.json`;
  if (!await exists(corePath) || !await exists(coreManifestPath)) {
    throw new Error(`Missing core tile or manifest: ${tile.id}`);
  }
  const [metadata, coreManifest, coreHash] = await Promise.all([
    sharp(corePath, { limitInputPixels: false }).metadata(),
    readJson(coreManifestPath),
    sha256(corePath),
  ]);
  if (metadata.width !== tile.core.destinationRect.width
      || metadata.height !== tile.core.destinationRect.height) {
    throw new Error(`Core dimensions do not match the plan: ${tile.id}`);
  }
  if (coreManifest.output.sha256 !== coreHash) {
    throw new Error(`Core SHA256 does not match its crop manifest: ${tile.id}`);
  }
  composites.push({
    input: corePath,
    left: tile.core.destinationRect.left,
    top: tile.core.destinationRect.top,
  });
  tileEvidence.push({ id: tile.id, path: corePath, sha256: coreHash });
}

sharp.cache({ memory: 512, files: 256, items: 512 });
sharp.concurrency(2);
await sharp({
  limitInputPixels: false,
  create: {
    width: plan.mosaic.width,
    height: plan.mosaic.height,
    channels: 3,
    background: "#000000",
  },
})
  .composite(composites)
  .png({ compressionLevel: 9, adaptiveFiltering: false })
  .toFile(options.outputPath);

const outputHash = await sha256(options.outputPath);
const manifest = {
  schemaVersion: "1.0.0",
  route: plan.route,
  plan: { path: options.planPath, sha256: planHash },
  overlapReport: {
    path: options.overlapReportPath,
    sha256: await sha256(options.overlapReportPath),
  },
  image: {
    path: options.outputPath,
    width: plan.mosaic.width,
    height: plan.mosaic.height,
    sha256: outputHash,
  },
  worldBounds: plan.mosaic.worldBounds,
  unitsPerPixel: plan.mosaic.unitsPerPixel,
  worldToPixel: plan.mosaic.worldToPixel,
  stitchMode: plan.tiling.stitchMode,
  tiles: tileEvidence,
};
await writeFile(outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output: options.outputPath,
  manifest: outputManifestPath,
  width: plan.mosaic.width,
  height: plan.mosaic.height,
  sha256: outputHash,
  tileCount: tileEvidence.length,
}, null, 2)}\n`);
