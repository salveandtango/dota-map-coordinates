import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? '<end>'}`);
    }
    values.set(key, value);
  }
  const required = (key) => values.get(key) ?? (() => { throw new Error(`Missing ${key}`); })();
  return {
    baseline: path.resolve(required('--baseline')),
    quality: path.resolve(required('--quality')),
    detail2k: path.resolve(required('--detail-2k')),
    detail4k: path.resolve(required('--detail-4k')),
    ultra: path.resolve(required('--ultra')),
    output: path.resolve(required('--output')),
    report: path.resolve(required('--report')),
    worldSpan: Number(values.get('--world-span') ?? 512),
    panelPixels: Number(values.get('--panel-pixels') ?? 1024),
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex').toUpperCase();
}

function assertSameBounds(samples) {
  const first = samples[0].manifest.worldBounds;
  for (const sample of samples.slice(1)) {
    const bounds = sample.manifest.worldBounds;
    for (const key of ['left', 'right', 'bottom', 'top']) {
      if (bounds[key] !== first[key]) {
        throw new Error(`${sample.id} has a different world bound ${key}`);
      }
    }
  }
  return first;
}

async function loadSample(id, label, imagePath) {
  const manifest = await readJson(`${imagePath}.json`);
  const metadata = await sharp(imagePath).metadata();
  if (metadata.width !== manifest.image.width || metadata.height !== manifest.image.height) {
    throw new Error(`${id} dimensions do not match its manifest`);
  }
  const imageHash = await sha256(imagePath);
  if (imageHash !== manifest.image.sha256) {
    throw new Error(`${id} hash does not match its manifest`);
  }
  return { id, label, imagePath, imageHash, manifest, metadata };
}

async function compareDecoded(first, second) {
  const a = await sharp(first).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(second).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height || a.info.channels !== b.info.channels) {
    throw new Error('Decoded comparison requires matching dimensions and channels');
  }
  let mismatchPixels = 0;
  let absoluteChannelDelta = 0;
  let maxChannelDelta = 0;
  for (let pixel = 0; pixel < a.info.width * a.info.height; pixel += 1) {
    let differs = false;
    for (let channel = 0; channel < a.info.channels; channel += 1) {
      const offset = pixel * a.info.channels + channel;
      const delta = Math.abs(a.data[offset] - b.data[offset]);
      absoluteChannelDelta += delta;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      differs ||= delta !== 0;
    }
    mismatchPixels += differs ? 1 : 0;
  }
  const totalPixels = a.info.width * a.info.height;
  return {
    width: a.info.width,
    height: a.info.height,
    totalPixels,
    mismatchPixels,
    mismatchRatio: mismatchPixels / totalPixels,
    meanAbsoluteRgbChannelDelta: absoluteChannelDelta / (totalPixels * a.info.channels),
    maxChannelDelta,
  };
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function makePanel(sample, worldSpan, panelPixels) {
  const unitsPerPixel = sample.manifest.worldBounds.unitsPerPixelX;
  if (unitsPerPixel !== sample.manifest.worldBounds.unitsPerPixelY) {
    throw new Error(`${sample.id} does not have square world pixels`);
  }
  const cropPixels = Math.round(worldSpan / unitsPerPixel);
  if (cropPixels <= 0 || cropPixels > sample.metadata.width || cropPixels > sample.metadata.height) {
    throw new Error(`${sample.id} cannot provide the requested ${worldSpan}-unit crop`);
  }
  const left = Math.floor((sample.metadata.width - cropPixels) / 2);
  const top = Math.floor((sample.metadata.height - cropPixels) / 2);
  return sharp(sample.imagePath)
    .extract({ left, top, width: cropPixels, height: cropPixels })
    .resize(panelPixels, panelPixels, { kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
}

const options = parseArgs(process.argv.slice(2));
if (!Number.isFinite(options.worldSpan) || options.worldSpan <= 0) {
  throw new Error('--world-span must be positive');
}
if (!Number.isInteger(options.panelPixels) || options.panelPixels <= 0) {
  throw new Error('--panel-pixels must be a positive integer');
}

const samples = await Promise.all([
  loadSample('baseline', '4 u/px | 1K textures | auto LOD', options.baseline),
  loadSample('quality', '4 u/px | 2K textures | highest LOD', options.quality),
  loadSample('detail2k', '1 u/px | 2K textures | highest LOD', options.detail2k),
  loadSample('detail4k', '1 u/px | 4K textures | highest LOD', options.detail4k),
  loadSample('ultra', '0.5 u/px | 2K textures | highest LOD', options.ultra),
]);
const bounds = assertSameBounds(samples);
const byId = Object.fromEntries(samples.map((sample) => [sample.id, sample]));

const detail2kMetadata = byId.detail2k.metadata;
const ultraDownsampled = await sharp(byId.ultra.imagePath)
  .resize(detail2kMetadata.width, detail2kMetadata.height, { kernel: sharp.kernel.lanczos3 })
  .png()
  .toBuffer();
const detail2kBuffer = await fs.readFile(byId.detail2k.imagePath);

const equivalence = {
  baselineVsQuality: await compareDecoded(byId.baseline.imagePath, byId.quality.imagePath),
  detail2kVsDetail4k: await compareDecoded(byId.detail2k.imagePath, byId.detail4k.imagePath),
  detail2kVsUltraLanczosDownsample: await compareDecoded(detail2kBuffer, ultraDownsampled),
};

const displayed = [byId.baseline, byId.detail2k, byId.ultra];
const labelHeight = 72;
const panels = await Promise.all(displayed.map((sample) => makePanel(sample, options.worldSpan, options.panelPixels)));
const composites = [];
for (let index = 0; index < displayed.length; index += 1) {
  const x = index * options.panelPixels;
  const labelSvg = Buffer.from(`
    <svg width="${options.panelPixels}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#111827"/>
      <text x="24" y="45" fill="#f9fafb" font-size="28" font-family="Segoe UI, Arial, sans-serif">${escapeXml(displayed[index].label)}</text>
    </svg>`);
  composites.push({ input: labelSvg, left: x, top: 0 });
  composites.push({ input: panels[index], left: x, top: labelHeight });
}

await fs.mkdir(path.dirname(options.output), { recursive: true });
await sharp({
  create: {
    width: options.panelPixels * displayed.length,
    height: options.panelPixels + labelHeight,
    channels: 3,
    background: '#111827',
  },
})
  .composite(composites)
  .png()
  .toFile(options.output);

const report = {
  schemaVersion: '1.0.0',
  route: 'vrf-orthographic-detail-comparison-v1',
  worldBounds: {
    left: bounds.left,
    right: bounds.right,
    bottom: bounds.bottom,
    top: bounds.top,
  },
  comparisonCropWorldSpan: options.worldSpan,
  panelPixels: options.panelPixels,
  contactSheet: { path: options.output, sha256: await sha256(options.output) },
  samples: Object.fromEntries(samples.map((sample) => [sample.id, {
    label: sample.label,
    path: sample.imagePath,
    sha256: sample.imageHash,
    width: sample.metadata.width,
    height: sample.metadata.height,
    unitsPerPixel: sample.manifest.worldBounds.unitsPerPixelX,
    renderingQuality: sample.manifest.renderingQuality,
  }])),
  equivalence,
  conclusions: {
    qualityOverridesChangeFourUnitsPerPixelImage: equivalence.baselineVsQuality.mismatchPixels !== 0,
    fourKTexturesChangeOneUnitPerPixelImage: equivalence.detail2kVsDetail4k.mismatchPixels !== 0,
    halfUnitRenderContainsDifferentSubpixelInformation: equivalence.detail2kVsUltraLanczosDownsample.mismatchPixels !== 0,
  },
};
await fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: options.output, report: options.report, conclusions: report.conclusions }, null, 2));
