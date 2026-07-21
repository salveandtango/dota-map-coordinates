import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
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
    return value;
  };
  const integer = (key) => {
    const value = Number.parseInt(required(key), 10);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${key} must be an integer`);
    }
    return value;
  };

  return {
    input: path.resolve(required("--input")),
    output: path.resolve(required("--output")),
    left: integer("--left"),
    top: integer("--top"),
    width: integer("--width"),
    height: integer("--height"),
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

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex").toUpperCase();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifestPath = `${options.output}.json`;
  if (!options.force && (await exists(options.output) || await exists(manifestPath))) {
    throw new Error(`Refusing to overwrite output: ${options.output}`);
  }
  if (options.left < 0 || options.top < 0 || options.width <= 0 || options.height <= 0) {
    throw new Error("Crop coordinates must be non-negative and dimensions must be positive");
  }

  const metadata = await sharp(options.input).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Could not read image dimensions: ${options.input}`);
  }
  if (options.left + options.width > metadata.width
      || options.top + options.height > metadata.height) {
    throw new Error(
      `Crop exceeds ${metadata.width}x${metadata.height}: `
      + `${options.left},${options.top},${options.width},${options.height}`
    );
  }

  await sharp(options.input)
    .extract({
      left: options.left,
      top: options.top,
      width: options.width,
      height: options.height,
    })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(options.output);

  const manifest = {
    schemaVersion: "1.0.0",
    route: "canonical-canvas-integer-crop-v1",
    input: {
      path: options.input,
      width: metadata.width,
      height: metadata.height,
      sha256: await sha256(options.input),
    },
    crop: {
      left: options.left,
      top: options.top,
      width: options.width,
      height: options.height,
    },
    output: {
      path: options.output,
      sha256: await sha256(options.output),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
