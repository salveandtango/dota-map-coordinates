import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const readJson = async (target) => JSON.parse(await readFile(target, "utf8"));
const sha256 = (target) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(target);
  stream.on("error", reject);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
});

async function verifiedJson(evidence, label) {
  assert.equal(await sha256(evidence.path ?? evidence.reportPath), evidence.sha256 ?? evidence.reportSha256,
    `${label} SHA256 drift`);
  return readJson(evidence.path ?? evidence.reportPath);
}

function assertExact(report, label, dx, dy, pixels) {
  assert.equal(report.route, "vrf-orthographic-image-exact-comparison-v1", `${label} route`);
  assert.equal(report.passed, true, `${label} passed`);
  assert.equal(report.comparison.dx, dx, `${label} dx`);
  assert.equal(report.comparison.dy, dy, `${label} dy`);
  assert.equal(report.comparison.overlap.pixels, pixels, `${label} pixels`);
  assert.equal(report.comparison.mismatchPixels, 0, `${label} mismatch pixels`);
  assert.equal(report.comparison.identicalOverlap, true, `${label} exact overlap`);
}

const profilePath = path.resolve(process.argv[2] ?? "profiles/build-24503204-vrf-orthographic-v2.json");
const profile = await readJson(profilePath);
assert.equal(profile.schemaVersion, 4);
assert.equal(profile.routeId, "vrf-strict-orthographic-canonical-canvas-v1");
assert.equal(profile.product, "normal-3d-world-render");
assert.equal(profile.mapMode, "official-read-only");

const inputHashes = {};
for (const [label, input] of Object.entries(profile.inputs)) {
  inputHashes[label] = await sha256(input.path);
  assert.equal(inputHashes[label], input.sha256, `${label} SHA256 drift`);
}
assert.equal(await sha256(profile.renderer.programPath), profile.renderer.programSha256,
  "renderer Program.cs SHA256 drift");
assert.equal(profile.deterministicSettings.frustumCullingEnabled, false);

const h2 = await verifiedJson(profile.gates.h2, "H2");
assertExact(h2, "H2", 0, 0, profile.gates.h2.comparedPixels);
for (const [index, evidence] of profile.gates.h3.reports.entries()) {
  const report = await verifiedJson(evidence, `H3 trial ${index + 1}`);
  assertExact(report, `H3 trial ${index + 1}`, profile.gates.h3.dx, profile.gates.h3.dy,
    profile.gates.h3.overlapPixelsPerTrial);
}

const h4ImageHash = await sha256(profile.gates.h4.image.path);
assert.equal(h4ImageHash, profile.gates.h4.image.sha256, "H4 image SHA256 drift");
const h4Manifest = await verifiedJson(profile.gates.h4.imageManifest, "H4 manifest");
assert.equal(h4Manifest.route, profile.routeId);
assert.equal(h4Manifest.image.sha256, h4ImageHash);
assert.equal(h4Manifest.image.width, profile.gates.h4.image.width);
assert.equal(h4Manifest.image.height, profile.gates.h4.image.height);
assert.equal(h4Manifest.scene.pvsCullingEnabled, false);
assert.equal(h4Manifest.scene.occlusionCullingEnabled, false);
assert.equal(h4Manifest.scene.frustumCullingEnabled, false);
const h4Repeat = await verifiedJson(profile.gates.h4.repeatReport, "H4 repeat");
assertExact(h4Repeat, "H4", 0, 0, profile.gates.h4.image.width * profile.gates.h4.image.height);

const h5 = await verifiedJson(profile.gates.h5, "H5");
assert.equal(h5.route, profile.routeId);
assert.equal(h5.passed, true);
assert.equal(h5.automaticPassed, true);
assert.equal(h5.visualPassed, true);
assert.equal(h5.validation.landmarkCount, profile.gates.h5.landmarkCount);
assert.equal(h5.validation.maximumRoundedPixelWorldError,
  profile.gates.h5.maximumRoundedPixelWorldError);
assert.equal(await sha256(profile.gates.h5.visualReviewPath), profile.gates.h5.visualReviewSha256,
  "H5 visual review SHA256 drift");
const batch = await verifiedJson(profile.gates.batchEquivalence, "batch equivalence");
assert.equal(batch.passed, true);
assert.equal(batch.decodedAndEncodedExact, true);

process.stdout.write(`${JSON.stringify({
  passed: true,
  profileId: profile.profileId,
  dotaBuildId: profile.dotaBuildId,
  inputHashes,
  rendererProgramSha256: profile.renderer.programSha256,
  h2: { passed: true, mismatchPixels: 0 },
  h3: { passed: true, trials: profile.gates.h3.reports.length, mismatchPixels: 0 },
  h4: { passed: true, imageSha256: h4ImageHash, mismatchPixels: 0 },
  h5: {
    passed: true,
    landmarkCount: h5.validation.landmarkCount,
    maximumRoundedPixelWorldError: h5.validation.maximumRoundedPixelWorldError,
  },
  batchEquivalence: { passed: true },
}, null, 2)}\n`);
