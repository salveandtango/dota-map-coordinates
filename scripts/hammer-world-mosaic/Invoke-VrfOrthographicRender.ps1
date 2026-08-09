[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$OutputPath,

    [ValidateNotNullOrEmpty()]
    [string]$BatchPlanPath,

    [ValidateRange(1, 32768)]
    [int]$PixelWidth = 5120,

    [ValidateRange(1, 32768)]
    [int]$PixelHeight = 5248,

    [double]$CenterX,

    [double]$CenterY,

    [double]$SpanX,

    [double]$SpanY,

    [ValidateRange(1.0, 1048576.0)]
    [double]$CameraZ = 16384,

    [ValidateRange(0.0001, 1048576.0)]
    [double]$NearPlane = 1,

    [ValidateRange(0.0001, 4194304.0)]
    [double]$FarPlane = 65536,

    [ValidateRange(1, 1000)]
    [int]$WarmupFrames = 2,

    [ValidateRange(0.0001, 100.0)]
    [double]$Exposure = 1,

    [ValidateRange(1, 16)]
    [int]$MsaaSamples = 1,

    [ValidateRange(64, 16384)]
    [int]$MaxTextureSize = 1024,

    [switch]$ForceHighestLod,

    [ValidateNotNullOrEmpty()]
    [string]$VrfRoot = 'C:\Users\70681\Documents\Dota2 Analyze\ValveResourceFormat',

    [ValidateNotNullOrEmpty()]
    [string]$VpkPath = 'C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta\game\dota\maps\dota.vpk',

    [ValidateNotNullOrEmpty()]
    [string]$GnvPath = 'C:\Users\70681\Documents\Dota2 Analyze\dota-map-coordinates\artifacts\24266061\vrf\inputs\maps\dota.gnv',

    [ValidateNotNullOrEmpty()]
    [string]$DotnetPath = 'C:\Users\70681\Documents\Dota2 Analyze\.work\dotnet-sdk-10.0.302\dotnet.exe',

    [switch]$Build
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-ExistingFile {
    param(
        [Parameter(Mandatory)]
        [string]$LiteralPath,
        [Parameter(Mandatory)]
        [string]$Description
    )

    $resolved = [System.IO.Path]::GetFullPath($LiteralPath)
    if (-not [System.IO.File]::Exists($resolved)) {
        throw "$Description not found: $resolved"
    }
    return $resolved
}

$resolvedVrfRoot = [System.IO.Path]::GetFullPath($VrfRoot)
if (-not [System.IO.Directory]::Exists($resolvedVrfRoot)) {
    throw "ValveResourceFormat root not found: $resolvedVrfRoot"
}

$resolvedVpk = Resolve-ExistingFile -LiteralPath $VpkPath -Description 'Dota map VPK'
$resolvedGnv = Resolve-ExistingFile -LiteralPath $GnvPath -Description 'Dota GridNav file'
$resolvedDotnet = Resolve-ExistingFile -LiteralPath $DotnetPath -Description '.NET host'
$hasOutput = $PSBoundParameters.ContainsKey('OutputPath')
$hasBatch = $PSBoundParameters.ContainsKey('BatchPlanPath')
if ($hasOutput -eq $hasBatch) {
    throw 'Supply exactly one of OutputPath or BatchPlanPath.'
}

$resolvedOutputs = [System.Collections.Generic.List[string]]::new()
$resolvedBatchPlan = $null
if ($hasOutput) {
    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
    $resolvedOutputs.Add($resolvedOutput)
} else {
    $resolvedBatchPlan = Resolve-ExistingFile -LiteralPath $BatchPlanPath -Description 'Batch render plan'
    $batch = Get-Content -Raw -LiteralPath $resolvedBatchPlan | ConvertFrom-Json -Depth 100
    if ($batch.schemaVersion -ne '1.0.0' -or @($batch.requests).Count -eq 0) {
        throw 'Batch render plan must use schemaVersion 1.0.0 and contain at least one request.'
    }
    $batchDirectory = Split-Path -Parent $resolvedBatchPlan
    foreach ($request in @($batch.requests)) {
        if ([string]::IsNullOrWhiteSpace([string]$request.outputPath)) {
            throw 'Every batch render request must have an outputPath.'
        }
        $candidate = if ([System.IO.Path]::IsPathRooted([string]$request.outputPath)) {
            [string]$request.outputPath
        } else {
            Join-Path $batchDirectory ([string]$request.outputPath)
        }
        $resolvedOutputs.Add([System.IO.Path]::GetFullPath($candidate))
    }
    if (($resolvedOutputs | Sort-Object -Unique).Count -ne $resolvedOutputs.Count) {
        throw 'Batch render plan contains duplicate output paths.'
    }
}

foreach ($candidateOutput in $resolvedOutputs) {
    if ([System.IO.File]::Exists($candidateOutput) -or [System.IO.File]::Exists("$candidateOutput.json")) {
        throw "Refusing to overwrite output or manifest: $candidateOutput"
    }
}

$projectPath = Join-Path $resolvedVrfRoot 'Misc\DotaOrthographicRender\DotaOrthographicRender.csproj'
$rendererDll = Join-Path $resolvedVrfRoot 'Misc\DotaOrthographicRender\bin\Release\DotaOrthographicRender.dll'
if (-not [System.IO.File]::Exists($projectPath)) {
    throw "Orthographic renderer project not found: $projectPath"
}

$projectionParameters = @('CenterX', 'CenterY', 'SpanX', 'SpanY')
$boundProjectionParameterCount = @(
    $projectionParameters | Where-Object { $PSBoundParameters.ContainsKey($_) }
).Count
if ($boundProjectionParameterCount -ne 0 -and $boundProjectionParameterCount -ne 4) {
    throw 'CenterX, CenterY, SpanX, and SpanY must be supplied together.'
}
if ($hasBatch -and $boundProjectionParameterCount -ne 0) {
    throw 'CenterX, CenterY, SpanX, and SpanY are defined per request in batch mode.'
}
if ($boundProjectionParameterCount -eq 4 -and ($SpanX -le 0 -or $SpanY -le 0)) {
    throw 'SpanX and SpanY must be positive.'
}
if ($NearPlane -ge $FarPlane) {
    throw 'NearPlane must be smaller than FarPlane.'
}

$env:DOTNET_ROOT = Split-Path -Parent $resolvedDotnet
$env:DOTNET_MULTILEVEL_LOOKUP = '0'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'

if ($Build) {
    & $resolvedDotnet build $projectPath --configuration Release --nologo
    if ($LASTEXITCODE -ne 0) {
        throw "Renderer build failed with exit code $LASTEXITCODE"
    }
}

if (-not [System.IO.File]::Exists($rendererDll)) {
    throw "Renderer DLL not found. Re-run with -Build: $rendererDll"
}

foreach ($candidateOutput in $resolvedOutputs) {
    $outputDirectory = Split-Path -Parent $candidateOutput
    if ($outputDirectory -and -not [System.IO.Directory]::Exists($outputDirectory)) {
        [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
    }
}

$invariantCulture = [System.Globalization.CultureInfo]::InvariantCulture
$renderArguments = @(
    $rendererDll,
    '--vpk', $resolvedVpk,
    '--gnv', $resolvedGnv,
    '--camera-z', $CameraZ.ToString($invariantCulture),
    '--near', $NearPlane.ToString($invariantCulture),
    '--far', $FarPlane.ToString($invariantCulture),
    '--warmup-frames', $WarmupFrames.ToString($invariantCulture),
    '--exposure', $Exposure.ToString($invariantCulture),
    '--msaa-samples', $MsaaSamples.ToString($invariantCulture),
    '--max-texture-size', $MaxTextureSize.ToString($invariantCulture)
)
if ($hasOutput) {
    $renderArguments += @(
        '--output', $resolvedOutput,
        '--pixel-width', $PixelWidth.ToString($invariantCulture),
        '--pixel-height', $PixelHeight.ToString($invariantCulture)
    )
} else {
    $renderArguments += @('--batch-plan', $resolvedBatchPlan)
}
if ($ForceHighestLod) {
    $renderArguments += '--force-highest-lod'
}
if ($boundProjectionParameterCount -eq 4) {
    $renderArguments += @(
        '--center-x', $CenterX.ToString($invariantCulture),
        '--center-y', $CenterY.ToString($invariantCulture),
        '--span-x', $SpanX.ToString($invariantCulture),
        '--span-y', $SpanY.ToString($invariantCulture)
    )
}

& $resolvedDotnet @renderArguments
if ($LASTEXITCODE -ne 0) {
    throw "Orthographic render failed with exit code $LASTEXITCODE"
}

foreach ($candidateOutput in $resolvedOutputs) {
    if (-not [System.IO.File]::Exists($candidateOutput) -or -not [System.IO.File]::Exists("$candidateOutput.json")) {
        throw "Renderer returned success without producing both the PNG and JSON manifest: $candidateOutput"
    }
    Write-Output "Rendered: $candidateOutput"
    Write-Output "Manifest: $candidateOutput.json"
}
