[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputPath,

    [ValidateRange(1, 32768)]
    [int]$PixelWidth = 5120,

    [ValidateRange(1, 32768)]
    [int]$PixelHeight = 5248,

    [double]$CenterX,

    [double]$CenterY,

    [double]$SpanX,

    [double]$SpanY,

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
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$manifestPath = "$resolvedOutput.json"
if ([System.IO.File]::Exists($resolvedOutput) -or [System.IO.File]::Exists($manifestPath)) {
    throw "Refusing to overwrite output or manifest: $resolvedOutput"
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
if ($boundProjectionParameterCount -eq 4 -and ($SpanX -le 0 -or $SpanY -le 0)) {
    throw 'SpanX and SpanY must be positive.'
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

$outputDirectory = Split-Path -Parent $resolvedOutput
if ($outputDirectory -and -not [System.IO.Directory]::Exists($outputDirectory)) {
    [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}

$invariantCulture = [System.Globalization.CultureInfo]::InvariantCulture
$renderArguments = @(
    $rendererDll,
    '--vpk', $resolvedVpk,
    '--gnv', $resolvedGnv,
    '--output', $resolvedOutput,
    '--pixel-width', $PixelWidth.ToString($invariantCulture),
    '--pixel-height', $PixelHeight.ToString($invariantCulture),
    '--warmup-frames', '2',
    '--exposure', '1',
    '--msaa-samples', '1'
)
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

if (-not [System.IO.File]::Exists($resolvedOutput) -or -not [System.IO.File]::Exists($manifestPath)) {
    throw 'Renderer returned success without producing both the PNG and JSON manifest.'
}

Write-Output "Rendered: $resolvedOutput"
Write-Output "Manifest: $manifestPath"
