import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './tile-stack-common.mjs';

export const identityContract = 'vrf-renderer-execution-identity-v1';
const projectRelative = 'Misc/DotaOrthographicRender/DotaOrthographicRender.csproj';
const binaryRelative = 'Misc/DotaOrthographicRender/bin/Release';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').toUpperCase();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const slash = value => value.split(path.sep).join('/');

async function fileRecord(root, relative) {
  const target = path.resolve(root, relative);
  assert.ok(target.startsWith(path.resolve(root) + path.sep), 'Identity file escapes root');
  const info = await lstat(target);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Identity requires a regular file: ${relative}`);
  return { path: slash(relative), bytes: info.size, sha256: await sha256(target) };
}

async function treeRecords(root) {
  const result = [];
  async function visit(relative) {
    for (const name of (await readdir(path.join(root, relative))).sort(compare)) {
      const child = path.join(relative, name);
      const info = await lstat(path.join(root, child));
      assert.ok(!info.isSymbolicLink(), `Symlink/junction in renderer identity: ${child}`);
      if (info.isDirectory()) await visit(child);
      else result.push(await fileRecord(root, child));
    }
  }
  await visit('');
  assert.ok(result.length > 0, `Empty renderer identity tree: ${root}`);
  return result.sort((a, b) => compare(a.path, b.path));
}

export async function sourceSnapshot(vrfRoot) {
  const git = args => execFileSync('git', ['-C', vrfRoot, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort(compare);
  assert.ok(paths.includes(projectRelative), 'Renderer project missing from source snapshot');
  assert.ok(paths.includes('Misc/DotaOrthographicRender/Program.cs'), 'Renderer source missing');
  const files = [];
  for (const relative of paths) files.push(await fileRecord(vrfRoot, relative));
  return { commit: git(['rev-parse', 'HEAD']).trim(), files };
}

export async function runtimeSnapshot(vrfRoot, dotnetPath) {
  const binaryRoot = path.join(vrfRoot, binaryRelative);
  const binaries = await treeRecords(binaryRoot);
  for (const name of ['DotaOrthographicRender.dll', 'Renderer.dll', 'ValveResourceFormat.dll',
    'DotaOrthographicRender.deps.json', 'DotaOrthographicRender.runtimeconfig.json']) {
    assert.ok(binaries.some(file => file.path === name), `Renderer dependency missing: ${name}`);
  }
  const config = JSON.parse(await readFile(path.join(binaryRoot, 'DotaOrthographicRender.runtimeconfig.json'), 'utf8'));
  const framework = config.runtimeOptions?.framework;
  assert.equal(framework?.name, 'Microsoft.NETCore.App', 'Unsupported renderer framework');
  assert.match(framework.version, /^\d+\.\d+\.\d+$/);
  const dotnetRoot = path.dirname(dotnetPath);
  const frameworkRoot = path.join(dotnetRoot, 'shared', 'Microsoft.NETCore.App');
  const requested = framework.version.split('.').map(Number);
  const versions = (await readdir(frameworkRoot)).filter(version => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
    const parts = version.split('.').map(Number);
    return parts[0] === requested[0] && parts[1] === requested[1] && parts[2] >= requested[2];
  }).sort((a, b) => Number(a.split('.')[2]) - Number(b.split('.')[2]));
  assert.ok(versions.length, 'Matching .NET runtime missing');
  return {
    binaries,
    dotnetHost: await fileRecord(dotnetRoot, path.basename(dotnetPath)),
    // Hash every installed framework/fxr file: adding a runtime is also drift.
    frameworks: await treeRecords(frameworkRoot),
    hostFxr: await treeRecords(path.join(dotnetRoot, 'host', 'fxr')),
    frameworkVersion: versions.at(-1),
  };
}

export async function collectIdentity(vrfRoot, dotnetPath) {
  const source = await sourceSnapshot(vrfRoot);
  const runtime = await runtimeSnapshot(vrfRoot, dotnetPath);
  const payload = { contract: identityContract, source, runtime };
  return { ...payload, fingerprint: digest(payload) };
}

export async function verifyIdentity(identityPath, vrfRoot, dotnetPath, expectedHash) {
  if (expectedHash) assert.equal(await sha256(identityPath), expectedHash.toUpperCase(), 'Renderer receipt SHA256 drift');
  const receipt = JSON.parse(await readFile(identityPath, 'utf8'));
  assert.equal(receipt.contract, identityContract, 'Missing/unsupported renderer execution identity');
  assert.equal(receipt.build?.completed, true, 'Renderer identity has no completed build');
  assert.equal(receipt.build.incremental, false, 'Renderer identity requires a non-incremental build');
  const current = await collectIdentity(vrfRoot, dotnetPath);
  assert.equal(receipt.fingerprint, current.fingerprint, 'Renderer source, binary, dependency or runtime drift; build a new identity/run');
  assert.deepEqual(receipt.source, current.source, 'Renderer source receipt drift');
  assert.deepEqual(receipt.runtime, current.runtime, 'Renderer runtime receipt drift');
  return { contract: identityContract, receiptSha256: await sha256(identityPath),
    fingerprint: current.fingerprint, frameworkVersion: current.runtime.frameworkVersion };
}

export async function buildIdentity(identityPath, vrfRoot, dotnetPath) {
  // Never retrofit a new identity onto old images or overwrite a frozen receipt.
  await assert.rejects(lstat(identityPath), { code: 'ENOENT' }, 'Identity already exists; choose a new path');
  const output = path.resolve(identityPath);
  for (const inputRoot of [vrfRoot, path.dirname(dotnetPath)]) {
    assert.ok(!output.toLowerCase().startsWith((path.resolve(inputRoot) + path.sep).toLowerCase()),
      'Keep identity receipts outside renderer source/binary and .NET input directories');
  }
  const source = await sourceSnapshot(vrfRoot);
  const args = ['build', path.join(vrfRoot, projectRelative), '--configuration', 'Release', '--nologo', '--no-restore', '--no-incremental'];
  execFileSync(dotnetPath, args, { cwd: vrfRoot, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, DOTNET_ROOT: path.dirname(dotnetPath), DOTNET_MULTILEVEL_LOOKUP: '0',
      DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  const current = await collectIdentity(vrfRoot, dotnetPath);
  assert.deepEqual(current.source, source, 'Renderer source changed during build');
  const receipt = { ...current, build: { completed: true, configuration: 'Release', restore: false, incremental: false,
    completedAt: new Date().toISOString(), evidence: 'wrapper-observed-successful-build' } };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return verifyIdentity(output, vrfRoot, dotnetPath);
}

export function assertTileExecution(manifest, expectedHash) {
  assert.match(expectedHash, /^[A-Fa-f0-9]{64}$/);
  assert.equal(manifest.rendererExecution?.contract, identityContract, 'Raw tile has no execution identity; legacy evidence is read-only');
  assert.equal(manifest.rendererExecution.receiptSha256, expectedHash.toUpperCase(), 'Raw tile renderer identity mismatch');
}

export async function validateCapturedTileIdentity(planPath, plan, tile) {
  if (plan.route === 'vrf-strict-orthographic-tile-stack-v1') return;
  assert.equal(plan.route, 'vrf-strict-orthographic-tile-stack-v2');
  const raw = path.resolve(path.dirname(planPath), tile.rawImage);
  const manifest = JSON.parse(await readFile(raw + '.json', 'utf8'));
  assertTileExecution(manifest, plan.renderer.identity.sha256);
  const rawHash = await sha256(raw);
  assert.equal(manifest.image.sha256.toUpperCase(), rawHash, 'Raw tile hash mismatch');
  return rawHash;
}

async function main(args) {
  const [operation, identityPath, vrfRoot, dotnetPath, expectedHash] = args;
  assert.ok(['build', 'verify'].includes(operation) && identityPath && vrfRoot && dotnetPath,
    'Usage: renderer-identity.mjs build|verify <identity.json> <vrf-root> <dotnet> [receipt-sha256]');
  const result = operation === 'build'
    ? await buildIdentity(identityPath, vrfRoot, dotnetPath)
    : await verifyIdentity(identityPath, vrfRoot, dotnetPath, expectedHash);
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
