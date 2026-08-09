import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { sha256 } from "./tile-stack-common.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${argv[index]}`);
    }
    values.set(argv[index], argv[index + 1]);
  }
  const required = (key) => {
    const value = values.get(key);
    if (!value) throw new Error(`Missing required argument ${key}`);
    return path.resolve(value);
  };
  return {
    planPath: required("--plan"),
    repairsPath: required("--repairs"),
    outputPlanPath: required("--output"),
  };
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

function contains(outer, inner) {
  return inner.left >= outer.left && inner.top >= outer.top
    && inner.left + inner.width <= outer.left + outer.width
    && inner.top + inner.height <= outer.top + outer.height;
}

async function cropWithManifest(input, inputHash, inputRect, targetRect, output, route) {
  if (!contains(inputRect, targetRect)) {
    throw new Error(`Crop ${JSON.stringify(targetRect)} lies outside ${JSON.stringify(inputRect)}`);
  }
  const crop = {
    left: targetRect.left - inputRect.left,
    top: targetRect.top - inputRect.top,
    width: targetRect.width,
    height: targetRect.height,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await sharp(input, { limitInputPixels: false })
    .extract(crop)
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(output);
  const manifest = {
    schemaVersion: "1.0.0",
    route,
    input: { path: input, sha256: inputHash, globalPixelRect: inputRect },
    crop,
    output: { path: output, sha256: await sha256(output) },
  };
  await writeFile(`${output}.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const options = parseArguments(process.argv.slice(2));
if (await exists(options.outputPlanPath)) {
  throw new Error(`Refusing to overwrite repaired plan: ${options.outputPlanPath}`);
}
const plan = JSON.parse(await readFile(options.planPath, "utf8"));
const repairConfig = JSON.parse(await readFile(options.repairsPath, "utf8"));
const tileById = new Map(plan.tiles.map((tile) => [tile.id, tile]));
const planDirectory = path.dirname(options.outputPlanPath);
const evidence = [];

for (const repair of repairConfig.repairs) {
  const input = path.resolve(repair.image);
  const metadata = await sharp(input, { limitInputPixels: false }).metadata();
  if (metadata.width !== repair.globalPixelRect.width || metadata.height !== repair.globalPixelRect.height) {
    throw new Error(`${repair.id} dimensions do not match its global pixel rectangle`);
  }
  const inputHash = await sha256(input);
  for (const tileId of repair.tileIds) {
    const tile = tileById.get(tileId);
    if (!tile) throw new Error(`Unknown repair tile ${tileId}`);
    const rawOutput = path.join(planDirectory, "tiles", "repaired", "raw", `${tileId}.png`);
    const coreOutput = path.join(planDirectory, "tiles", "repaired", "core", `${tileId}.png`);
    await cropWithManifest(
      input, inputHash, repair.globalPixelRect, tile.render.globalPixelRect, rawOutput,
      "vrf-orthographic-supertile-raw-crop-v1",
    );
    await cropWithManifest(
      input, inputHash, repair.globalPixelRect, tile.core.destinationRect, coreOutput,
      "vrf-orthographic-supertile-core-crop-v1",
    );
    tile.rawImage = path.relative(planDirectory, rawOutput).replaceAll("\\", "/");
    tile.coreImage = path.relative(planDirectory, coreOutput).replaceAll("\\", "/");
  }
  evidence.push({
    id: repair.id,
    image: input,
    sha256: inputHash,
    globalPixelRect: repair.globalPixelRect,
    tileIds: repair.tileIds,
  });
}

plan.schemaVersion = "1.1.0";
plan.route = "vrf-orthographic-tile-stack-supertile-repaired-v1";
plan.validation.minimumSignificantChannelDelta = 2;
plan.parentPlan = { path: options.planPath, sha256: await sha256(options.planPath) };
plan.supertileRepairs = evidence;
await writeFile(options.outputPlanPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output: options.outputPlanPath, repairs: evidence }, null, 2)}\n`);
