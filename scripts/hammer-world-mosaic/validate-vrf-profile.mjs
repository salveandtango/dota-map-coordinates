import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function sha256(target) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(target);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

function assertExactComparison(report, label, expectedDx = 0, expectedDy = 0) {
  assert.equal(report.comparison.dx, expectedDx, `${label} dx`);
  assert.equal(report.comparison.dy, expectedDy, `${label} dy`);
  assert.equal(report.comparison.mismatch_pixels, 0, `${label} mismatch pixels`);
  assert.equal(report.comparison.identical_overlap, true, `${label} exact overlap`);
}

const profilePath = path.resolve(
  process.argv[2] ?? "profiles/build-24266061-vrf-orthographic-v1.json"
);
const profile = await readJson(profilePath);
assert.equal(profile.schemaVersion, 3);
assert.equal(profile.routeId, "vrf-strict-orthographic-canonical-canvas-v1");

const inputHashes = {};
for (const [name, input] of Object.entries({
  sourceVmap: profile.inputs.sourceVmap,
  mapVpk: profile.inputs.mapVpk,
  gridNav: profile.inputs.gridNav,
})) {
  const actual = await sha256(input.path);
  assert.equal(actual, input.sha256, `${name} SHA256 drift`);
  inputHashes[name] = actual;
}

const h2h3Reports = Object.fromEntries(
  await Promise.all(
    [
      "h2-canonical-repeat.json",
      "h2-origin-repeat.json",
      "h2-neighbor-repeat.json",
      "h3-a.json",
      "h3-b.json",
    ].map(async (name) => [name, await readJson(path.join(profile.h2h3.artifactDirectory, name))])
  )
);
assertExactComparison(h2h3Reports["h2-canonical-repeat.json"], "H2 canonical");
assertExactComparison(h2h3Reports["h2-origin-repeat.json"], "H2 origin");
assertExactComparison(h2h3Reports["h2-neighbor-repeat.json"], "H2 neighbor");
assertExactComparison(h2h3Reports["h3-a.json"], "H3 trial A", -256, 0);
assertExactComparison(h2h3Reports["h3-b.json"], "H3 trial B", -256, 0);

const imageHash = await sha256(profile.h4.image.path);
assert.equal(imageHash, profile.h4.image.fileSha256, "H4 image SHA256 drift");
const imageManifestHash = await sha256(profile.h4.imageManifest.path);
assert.equal(imageManifestHash, profile.h4.imageManifest.sha256, "H4 image manifest SHA256 drift");
const imageManifest = await readJson(profile.h4.imageManifest.path);
assert.equal(imageManifest.route, profile.renderer.manifestRoutes.evidenceCapturedAs);
assert.equal(imageManifest.image.sha256, imageHash);
const h4Repeat = await readJson(
  path.join(profile.h4.artifactDirectory, "h4-full-repeat-comparison.json")
);
assertExactComparison(h4Repeat, "H4 full repeat");
assert.equal(
  h4Repeat.first.content_sha256,
  profile.h4.image.decodedContentSha256,
  "H4 decoded content SHA256 drift"
);

const h5ReportHash = await sha256(profile.h5.reportPath);
assert.equal(h5ReportHash, profile.h5.reportSha256, "H5 report SHA256 drift");
const h5Report = await readJson(profile.h5.reportPath);
assert.equal(h5Report.route, profile.routeId);
assert.equal(h5Report.passed, true);
assert.equal(h5Report.automaticPassed, true);
assert.equal(h5Report.visualPassed, true);
assert.ok(h5Report.validation.landmarkCount >= profile.h5.requiredLandmarkCount);
assert.equal(h5Report.sources.vpkSha256, profile.inputs.mapVpk.sha256);
assert.equal(h5Report.sources.gridNavSha256, profile.inputs.gridNav.sha256);

const transform = await readJson(profile.h5.worldToPixelPath);
assert.equal(transform.route, profile.routeId);
assert.equal(transform.image.fileSha256, profile.h4.image.fileSha256);
assert.equal(transform.inputs.vpkSha256, profile.inputs.mapVpk.sha256);
assert.equal(transform.inputs.gridNavSha256, profile.inputs.gridNav.sha256);
assert.equal(transform.validation.passed, true);
assert.equal(transform.validation.reportSha256, h5ReportHash);

process.stdout.write(`${JSON.stringify({
  passed: true,
  profile: profile.profileId,
  route: profile.routeId,
  inputHashes,
  h2: { passed: true, mismatchPixels: 0 },
  h3: { passed: true, trials: 2, dx: -256, dy: 0, mismatchPixels: 0 },
  h4: {
    passed: true,
    width: profile.h4.image.width,
    height: profile.h4.image.height,
    imageSha256: imageHash,
    imageManifestSha256: imageManifestHash,
    mismatchPixels: h4Repeat.comparison.mismatch_pixels,
  },
  h5: {
    passed: true,
    landmarkCount: h5Report.validation.landmarkCount,
    maximumRoundedPixelWorldError: h5Report.validation.maximumRoundedPixelWorldError,
    reportSha256: h5ReportHash,
  },
}, null, 2)}\n`);
