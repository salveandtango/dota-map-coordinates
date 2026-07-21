import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const result = { format: "text", output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      result.config = argv[++index];
    } else if (argument === "--format") {
      result.format = argv[++index];
    } else if (argument === "--output") {
      result.output = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!result.config) {
    throw new Error("--config is required");
  }
  if (!["text", "json", "csv"].includes(result.format)) {
    throw new Error("--format must be text, json, or csv");
  }
  return result;
}

function tileFileName(pattern, x, y) {
  return pattern.replace("{x}", String(x)).replace("{y}", String(y));
}

function buildPlan(config) {
  if (config.product !== "normal-3d-world-render") {
    throw new Error("Profile does not target a normal 3D world render");
  }
  const records = [];
  const xPositions = config.camera.xPositions;
  const yPositions = config.camera.yPositions;
  const orderedPairs =
    config.camera.captureOrder === "y-major"
      ? yPositions.flatMap((y) => xPositions.map((x) => ({ x, y })))
      : xPositions.flatMap((x) => yPositions.map((y) => ({ x, y })));

  for (const [offset, pair] of orderedPairs.entries()) {
    const { x, y } = pair;
    records.push({
      index: offset + 1,
      id: `${x},${y}`,
      x,
      y,
      z: config.camera.z,
      pitch: config.camera.pitch,
      yaw: config.camera.yaw,
      roll: config.camera.roll,
      command:
        `setpos ${x} ${y} ${config.camera.z}; ` +
        `setang ${config.camera.pitch} ${config.camera.yaw} ${config.camera.roll}`,
      outputFile: tileFileName(config.tileFiles.pattern, x, y)
    });
  }
  return records;
}

function renderText(config, plan) {
  const header = [
    `profile=${config.profileId}`,
    `build=${config.dotaBuildId}`,
    `product=${config.product}`,
    `tiles=${plan.length}`,
    ""
  ];
  const rows = plan.map(
    (tile) =>
      `${String(tile.index).padStart(2, "0")}/${plan.length} ` +
      `${tile.outputFile}\t${tile.command}`
  );
  return [...header, ...rows, ""].join("\n");
}

function renderCsv(plan) {
  const rows = [
    ["index", "id", "x", "y", "z", "pitch", "yaw", "roll", "output_file", "command"]
  ];
  for (const tile of plan) {
    rows.push([
      tile.index,
      tile.id,
      tile.x,
      tile.y,
      tile.z,
      tile.pitch,
      tile.yaw,
      tile.roll,
      tile.outputFile,
      tile.command
    ]);
  }
  return `${rows
    .map((row) =>
      row
        .map((value) => `"${String(value).replaceAll('"', '""')}"`)
        .join(",")
    )
    .join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config);
const config = JSON.parse(await readFile(configPath, "utf8"));
const plan = buildPlan(config);
let output;
if (args.format === "json") {
  output = `${JSON.stringify(
    {
      schemaVersion: 1,
      profileId: config.profileId,
      dotaBuildId: config.dotaBuildId,
      product: config.product,
      tiles: plan
    },
    null,
    2
  )}\n`;
} else if (args.format === "csv") {
  output = renderCsv(plan);
} else {
  output = renderText(config, plan);
}

if (args.output) {
  const outputPath = path.resolve(args.output);
  await writeFile(outputPath, output, "utf8");
  process.stdout.write(`${outputPath}\n`);
} else {
  process.stdout.write(output);
}
