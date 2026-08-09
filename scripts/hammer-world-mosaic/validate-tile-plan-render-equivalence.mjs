import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJson, sha256 } from "./tile-stack-common.mjs";

function argumentsOf(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const required = (key) => {
    const value = values.get(key);
    if (!value) throw new Error(`Missing ${key}`);
    return path.resolve(value);
  };
  return {
    source: required("--source"),
    candidate: required("--candidate"),
    output: required("--output"),
  };
}

function renderContract(plan) {
  return {
    route: plan.route,
    dotaBuildId: plan.dotaBuildId,
    inputs: plan.inputs,
    renderer: plan.renderer,
    renderingQuality: plan.renderingQuality,
    projection: plan.projection,
    tiling: plan.tiling,
    mosaic: plan.mosaic,
    tiles: plan.tiles,
    adjacency: plan.adjacency,
  };
}

const options = argumentsOf(process.argv.slice(2));
const [source, candidate] = await Promise.all([
  readJson(options.source),
  readJson(options.candidate),
]);
assert.deepEqual(
  renderContract(candidate),
  renderContract(source),
  "Candidate plan changes the captured render contract",
);
const report = {
  schemaVersion: "1.0.0",
  route: "vrf-orthographic-tile-plan-render-equivalence-v1",
  passed: true,
  source: { path: options.source, sha256: await sha256(options.source), profileId: source.profileId },
  candidate: {
    path: options.candidate,
    sha256: await sha256(options.candidate),
    profileId: candidate.profileId,
  },
  validationOnlyChange: true,
  sourceValidation: source.validation,
  candidateValidation: candidate.validation,
};
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
