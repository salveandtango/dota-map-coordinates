import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildTilePlan, sha256 } from './tile-stack-common.mjs';
import { collectIdentity, verifyIdentity, buildIdentity, assertTileExecution,
  validateCapturedTileIdentity, identityContract } from './renderer-identity.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'dota-renderer-identity-'));
const fixture = path.join(root, 'fixture');
const vrf = path.join(fixture, 'vrf');
const bin = path.join(vrf, 'Misc/DotaOrthographicRender/bin/Release');
const dotnet = path.join(fixture, 'dotnet/dotnet.exe');
const receiptPath = path.join(fixture, 'identity.json');
const results = [];
const json = async (target, value) => writeFile(target, JSON.stringify(value, null, 2) + '\n');
async function file(target, content = 'fixture-only-not-executable') {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
async function check(name, body) { await body(); results.push({ name, passed: true }); }
const pwsh = process.env.PWSH_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/PowerShell/7/pwsh.exe' : 'pwsh');
function runScript(script, args) {
  return spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(scriptRoot, script), ...args],
    { cwd: scriptRoot, encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000 });
}
try {
  await file(path.join(vrf, '.gitignore'), '**/bin/\n');
  await file(path.join(vrf, 'Misc/DotaOrthographicRender/DotaOrthographicRender.csproj'), '<Project/>');
  const program = path.join(vrf, 'Misc/DotaOrthographicRender/Program.cs');
  await file(program, '// source fixture\n');
  for (const name of ['DotaOrthographicRender.dll', 'Renderer.dll', 'ValveResourceFormat.dll', 'dependency.dll', 'DotaOrthographicRender.deps.json']) {
    await file(path.join(bin, name));
  }
  await file(path.join(bin, 'DotaOrthographicRender.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { framework: { name: 'Microsoft.NETCore.App', version: '10.0.0' } } }));
  await file(dotnet);
  await file(path.join(fixture, 'dotnet/host/fxr/10.0.10/hostfxr.dll'));
  const clr = path.join(fixture, 'dotnet/shared/Microsoft.NETCore.App/10.0.10/coreclr.dll');
  await file(clr);
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'isolated identity fixture']]) {
    execFileSync('git', args, { cwd: vrf, stdio: 'pipe', windowsHide: true });
  }
  // Synthetic identity unit fixture, not a claim that these are renderable DLLs.
  const receipt = { ...await collectIdentity(vrf, dotnet), build: { completed: true, incremental: false } };
  await json(receiptPath, receipt);
  const expectedHash = await sha256(receiptPath);
  const execution = await verifyIdentity(receiptPath, vrf, dotnet, expectedHash);
  await check('unchanged-receipt', async () => assert.equal(execution.fingerprint, receipt.fingerprint));
  for (const [name, target] of [
    ['renderer-dll', path.join(bin, 'DotaOrthographicRender.dll')],
    ['dependency', path.join(bin, 'dependency.dll')],
    ['deps-json', path.join(bin, 'DotaOrthographicRender.deps.json')],
    ['source', program], ['runtime', clr], ['dotnet-host', dotnet],
  ]) {
    await check(`${name}-drift-rejected`, async () => {
      const original = await readFile(target);
      await writeFile(target, Buffer.concat([original, Buffer.from('changed')]));
      await assert.rejects(verifyIdentity(receiptPath, vrf, dotnet, expectedHash), /drift/);
      await writeFile(target, original);
    });
  }
  await check('added-dependency-rejected', async () => {
    const extra = path.join(bin, 'new.dll'); await file(extra);
    await assert.rejects(verifyIdentity(receiptPath, vrf, dotnet, expectedHash), /drift/);
    await rm(extra);
  });
  await check('receipt-tampering-rejected', async () => {
    await json(receiptPath, { ...receipt, fingerprint: '0'.repeat(64) });
    await assert.rejects(verifyIdentity(receiptPath, vrf, dotnet, expectedHash), /receipt SHA256 drift/);
    await json(receiptPath, receipt);
  });
  await check('receipt-overwrite-rejected-before-build', async () => {
    await assert.rejects(buildIdentity(receiptPath, vrf, dotnet), /Identity already exists/);
  });
  await check('legacy-tile-not-adopted', async () => assert.throws(() => assertTileExecution({}, expectedHash), /legacy evidence/));
  await check('wrong-tile-identity-rejected', async () => assert.throws(() => assertTileExecution({ rendererExecution: { ...execution, receiptSha256: '0'.repeat(64) } }, expectedHash), /mismatch/));

  const profile = JSON.parse(await readFile(path.join(scriptRoot, 'profiles/build-24266061-vrf-tile-stack-smoke-v1.json'), 'utf8'));
  Object.assign(profile, { schemaVersion: 5, routeId: 'vrf-strict-orthographic-tile-stack-v2', profileId: 'synthetic-identity-test-v2' });
  profile.renderer = { ...profile.renderer, vrfRoot: vrf, dotnetPath: dotnet,
    wrapperPath: path.join(scriptRoot, 'Invoke-VrfOrthographicRender.ps1'), identity: { path: receiptPath, sha256: expectedHash } };
  profile.projection.worldBounds = { left: 0, right: 32, bottom: 0, top: 32 };
  profile.projection.unitsPerPixel = 1;
  profile.tiling = { ...profile.tiling, coreWidthPixels: 16, coreHeightPixels: 16, overscanPixels: 4 };
  profile.validation.requireInputHashes = true;
  for (const name of ['mapVpk', 'gridNav']) {
    const input = path.join(fixture, name); await file(input);
    profile.inputs[name] = { path: input, sha256: await sha256(input) };
  }
  const profilePath = path.join(fixture, 'profile.json'); await json(profilePath, profile);
  const output = path.join(fixture, 'capture'); await mkdir(path.join(output, 'tiles/raw'), { recursive: true });
  await mkdir(path.join(output, 'tiles/core'), { recursive: true });
  const plan = buildTilePlan(profile);
  plan.profile = { path: profilePath, sha256: await sha256(profilePath) };
  const planPath = path.join(output, 'tile-plan.json'); await json(planPath, plan);
  const tile = plan.tiles[0];
  const raw = path.join(output, tile.rawImage); const core = path.join(output, tile.coreImage);
  await sharp({ create: { width: tile.render.pixelWidth, height: tile.render.pixelHeight, channels: 3, background: '#245e49' } }).png().toFile(raw);
  await sharp(raw).extract(tile.core.sourceRect).png().toFile(core);
  const rawHash = await sha256(raw);
  const manifest = {
    route: profile.renderer.manifestRoute, rendererExecution: execution,
    image: { width: tile.render.pixelWidth, height: tile.render.pixelHeight, sha256: rawHash },
    inputs: { vpk: profile.inputs.mapVpk, gridNav: profile.inputs.gridNav },
    camera: { ...profile.projection.camera, position: [0, 0, profile.projection.camera.z], projectionWindowCenter: [tile.render.centerX, tile.render.centerY] },
    renderingQuality: { ...profile.renderingQuality, forcedHighestLodModelCount: 1 },
    worldBounds: { ...tile.render.worldBounds, unitsPerPixelX: 1, unitsPerPixelY: 1 },
  };
  await json(raw + '.json', manifest);
  await json(core + '.json', { route: 'canonical-canvas-integer-crop-v1', input: { width: tile.render.pixelWidth, height: tile.render.pixelHeight, sha256: rawHash },
    output: { sha256: await sha256(core) }, crop: tile.core.sourceRect });
  const args = ['-ProfilePath', profilePath, '-OutputDirectory', output, '-Resume', '-MaxTiles', '1'];
  for (const batch of [false, true]) await check(`real-powershell-${batch ? 'batch' : 'sequential'}-resume`, async () => {
    const result = runScript('Invoke-VrfOrthographicTileStack.ps1', [...args, ...(batch ? ['-Batch'] : [])]);
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    const summary = JSON.parse(await readFile(path.join(output, 'capture-summary.json'), 'utf8'));
    assert.equal(summary.resumedTileCount, 1); assert.equal(summary.renderedTileCount, 0);
    assert.equal(summary.rendererIdentity.sha256, expectedHash);
  });
  await check('real-runner-rejects-legacy-raw', async () => {
    const legacy = { ...manifest }; delete legacy.rendererExecution; await json(raw + '.json', legacy);
    const result = runScript('Invoke-VrfOrthographicTileStack.ps1', args);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /incomplete or does not match/);
    await json(raw + '.json', manifest);
  });
  await check('new-profile-output-identity-validated-downstream', async () => assert.equal(await validateCapturedTileIdentity(planPath, plan, tile), rawHash));
  await check('downstream-rejects-wrong-raw-identity', async () => {
    await json(raw + '.json', { ...manifest, rendererExecution: { ...execution, receiptSha256: '0'.repeat(64) } });
    await assert.rejects(validateCapturedTileIdentity(planPath, plan, tile), /identity mismatch/);
    await json(raw + '.json', manifest);
  });
  await check('real-runner-rejects-rebuild-on-resume', async () => {
    const result = runScript('Invoke-VrfOrthographicTileStack.ps1', [...args, '-Build']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Never rebuild/);
  });
  const legacyProfile = { ...profile, schemaVersion: 4, routeId: 'vrf-strict-orthographic-tile-stack-v1' };
  const legacyProfilePath = path.join(fixture, 'legacy-profile.json'); await json(legacyProfilePath, legacyProfile);
  const legacyArgs = ['-ProfilePath', legacyProfilePath, '-OutputDirectory', path.join(fixture, 'legacy-run')];
  await check('legacy-profile-planning-remains-readable', async () => {
    const result = runScript('Invoke-VrfOrthographicTileStack.ps1', [...legacyArgs, '-PlanOnly']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
  await check('legacy-profile-capture-is-read-only', async () => {
    const result = runScript('Invoke-VrfOrthographicTileStack.ps1', legacyArgs);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Legacy tile profiles are read-only/);
  });
  await check('real-camera-sweep-resumes-off-origin-fixed-camera', async () => {
    const sweep = path.join(fixture, 'camera-sweep'); await mkdir(sweep);
    for (const height of [16384, 24576]) {
      const image = path.join(sweep, `camera-z-${height}.png`);
      await copyFile(raw, image);
      await json(image + '.json', { ...manifest, camera: { ...manifest.camera, position: [0, 0, height] } });
    }
    const result = runScript('Invoke-VrfOrthographicCameraSweep.ps1', ['-ProfilePath', profilePath,
      '-OutputDirectory', sweep, '-Resume', '-CenterX', String(tile.render.centerX), '-CenterY', String(tile.render.centerY),
      '-SpanX', String(tile.render.spanX), '-SpanY', String(tile.render.spanY),
      '-PixelWidth', String(tile.render.pixelWidth), '-PixelHeight', String(tile.render.pixelHeight), '-CameraZList', '16384,24576']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(await readFile(path.join(sweep, 'camera-sweep-summary.json'), 'utf8'));
    assert.equal(summary.rendererIdentity.sha256, expectedHash);
    assert.equal(summary.conclusion.scaleInvariantAcrossHeights, true);
  });
  await check('real-wrapper-rejects-drift-before-execution', async () => {
    await writeFile(path.join(bin, 'dependency.dll'), 'changed');
    const result = runScript('Invoke-VrfOrthographicRender.ps1', ['-OutputPath', path.join(fixture, 'not-rendered.png'),
      '-RendererIdentityPath', receiptPath, '-RendererIdentitySha256', expectedHash,
      '-VrfRoot', vrf, '-DotnetPath', dotnet, '-VpkPath', profile.inputs.mapVpk.path, '-GnvPath', profile.inputs.gridNav.path]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /verification failed before launch/);
  });
  const report = { passed: true, contract: identityContract, tests: results, testCount: results.length,
    gpuRenderingPerformed: false, syntheticFixtureOnly: true, tempRoot: root };
  await json(path.join(root, 'test-report.json'), report);
  console.log(JSON.stringify(report));
} finally {
  assert.ok(fixture.startsWith(root + path.sep));
  await rm(fixture, { recursive: true, force: true });
}
