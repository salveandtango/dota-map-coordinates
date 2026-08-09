import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildTilePlan,
  exists,
  readJson,
  sha256,
} from "./tile-stack-common.mjs";

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
    profilePath: required("--profile"),
    outputPath: required("--output"),
    force,
  };
}

const options = parseArguments(process.argv.slice(2));
if (!options.force && await exists(options.outputPath)) {
  throw new Error(`Refusing to overwrite tile plan: ${options.outputPath}`);
}
const profile = await readJson(options.profilePath);
const plan = buildTilePlan(profile);
plan.profile = {
  path: options.profilePath,
  sha256: await sha256(options.profilePath),
};
await writeFile(options.outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output: options.outputPath,
  profile: profile.profileId,
  mosaic: plan.mosaic,
}, null, 2)}\n`);
