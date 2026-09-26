import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildPackage } from "./build-native-z5-map-package.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "dota-z5-resume-"));
try {
  const args = {
    z5Root: path.join(root, "native"), z5ManifestPath: path.join(root, "native.json"),
    base4uPath: path.join(root, "base.png"), outputRoot: path.join(root, "package"),
    mapProfile: "test-profile",
  };
  await mkdir(args.z5Root);
  await sharp({ create: { width: 5120, height: 5248, channels: 3, background: "black" } })
    .png().toFile(args.base4uPath);
  await writeFile(args.z5ManifestPath, JSON.stringify({
    route: "dota-normal-world-native-z5-release-v1", assetRevision: "test-revision",
    level: { coverage: "full", nativeTileCount: 6560 },
    tiles: Array.from({ length: 6560 }, (_, i) => ({ x: i % 80, y: Math.floor(i / 80), sha256: "0".repeat(64) })),
  }));
  await assert.rejects(buildPackage(args), /Missing native Z5 source/);
  const pending = `${args.outputRoot}.pending`;
  const tile = path.join(pending, "tiles", "2", "0", "0.png");
  const before = await stat(tile);
  const state = await readFile(path.join(pending, "build-state.json"), "utf8");
  await assert.rejects(buildPackage(args), /Missing native Z5 source/);
  assert.equal((await stat(tile)).mtimeMs, before.mtimeMs, "completed tile must be reused");
  await assert.rejects(buildPackage({ ...args, mapProfile: "wrong-profile" }), /identity mismatch/);
  assert.equal(await readFile(path.join(pending, "build-state.json"), "utf8"), state);
  assert.equal((await stat(tile)).mtimeMs, before.mtimeMs, "identity rejection must preserve progress");
  await assert.rejects(stat(args.outputRoot), { code: "ENOENT" });
  console.log(JSON.stringify({ status: "ok", interruptedBuildRetained: true, resumed: true, identityDriftRejected: true }));
} finally {
  // Only our fresh, resolved OS-temp directory is owned by this test.
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(root, { recursive: true, force: true });
}
