import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildFromZ5 } from "./build-native-z5-map-package.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "dota-z5-package-edge-"));

try {
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "output");
  // A 1024x768 / 2u-per-pixel level consumes an 8x6 grid at native
  // 0.5u-per-pixel. Its last output row is only 256px high, reproducing the
  // production Z3 edge that previously failed inside a combined
  // composite+resize Sharp pipeline.
  for (let x = 0; x < 8; x += 1) {
    await mkdir(path.join(sourceRoot, String(x)), { recursive: true });
    for (let y = 0; y < 6; y += 1) {
      await sharp({
        create: {
          width: 512,
          height: 512,
          channels: 3,
          background: { r: 40 + x, g: 80 + y, b: 120 },
        },
      }).png().toFile(path.join(sourceRoot, String(x), `${y}.png`));
    }
  }

  const entries = await buildFromZ5(sourceRoot, outputRoot, {
    z: 3,
    unitsPerPixel: 2,
    width: 1024,
    height: 768,
    columns: 2,
    rows: 2,
  });
  assert.equal(entries.length, 4);
  const resumedEntries = await buildFromZ5(sourceRoot, outputRoot, {
    z: 3,
    unitsPerPixel: 2,
    width: 1024,
    height: 768,
    columns: 2,
    rows: 2,
  });
  assert.deepEqual(resumedEntries, entries, "validated tiles must be reusable after an interrupted build");

  const edgePath = path.join(outputRoot, "tiles", "3", "1", "1.png");
  const metadata = await sharp(edgePath).metadata();
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  const topBuffer = await sharp(edgePath).extract({ left: 0, top: 0, width: 512, height: 256 }).toBuffer();
  const paddingBuffer = await sharp(edgePath).extract({ left: 0, top: 256, width: 512, height: 256 }).toBuffer();
  const top = await sharp(topBuffer).stats();
  const padding = await sharp(paddingBuffer).stats();
  assert.ok(top.channels.slice(0, 3).some((channel) => channel.mean > 0), "edge content must survive downsampling");
  assert.ok(
    padding.channels.slice(0, 3).every((channel) => channel.max === 0),
    `partial edge padding must remain black: ${JSON.stringify(padding.channels)}`,
  );

  process.stdout.write(`${JSON.stringify({ status: "ok", tiles: entries.length, edge: "right-bottom", resume: true })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
