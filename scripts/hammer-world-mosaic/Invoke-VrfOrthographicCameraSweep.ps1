[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$ProfilePath,
    [Parameter(Mandatory)] [string]$OutputDirectory,
    [Parameter(Mandatory)] [double]$CenterX,
    [Parameter(Mandatory)] [double]$CenterY,
    [Parameter(Mandatory)] [ValidateRange(0.0001, 1048576.0)] [double]$SpanX,
    [Parameter(Mandatory)] [ValidateRange(0.0001, 1048576.0)] [double]$SpanY,
    [ValidateRange(1, 32768)] [int]$PixelWidth = 512,
    [ValidateRange(1, 32768)] [int]$PixelHeight = 512,
    [ValidateNotNullOrEmpty()] [string]$CameraZList = '8192,16384,24576',
    [switch]$Resume,
    [switch]$Build
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$profilePathResolved = [System.IO.Path]::GetFullPath($ProfilePath)
$outputResolved = [System.IO.Path]::GetFullPath($OutputDirectory)
$profile = Get-Content -LiteralPath $profilePathResolved -Raw | ConvertFrom-Json -Depth 100
$wrapper = [System.IO.Path]::GetFullPath($profile.renderer.wrapperPath)
[System.IO.Directory]::CreateDirectory($outputResolved) | Out-Null

function Assert-NearlyEqual {
    param(
        [Parameter(Mandatory)] [double]$Actual,
        [Parameter(Mandatory)] [double]$Expected,
        [Parameter(Mandatory)] [string]$Label,
        [double]$Tolerance = 0.000001
    )
    if ([Math]::Abs($Actual - $Expected) -gt $Tolerance) {
        throw "Resume manifest mismatch for ${Label}: expected $Expected, got $Actual"
    }
}

function Assert-ResumeManifest {
    param(
        [Parameter(Mandatory)] [object]$Manifest,
        [Parameter(Mandatory)] [string]$ImagePath,
        [Parameter(Mandatory)] [double]$ExpectedCameraZ
    )
    if ([string]$Manifest.route -cne [string]$profile.renderer.manifestRoute) {
        throw "Resume manifest route mismatch: $($Manifest.route)"
    }
    if ([int]$Manifest.image.width -ne $PixelWidth -or [int]$Manifest.image.height -ne $PixelHeight) {
        throw "Resume image dimensions mismatch for $ImagePath"
    }
    $actualImageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ImagePath).Hash
    if ($actualImageHash -cne [string]$Manifest.image.sha256) {
        throw "Resume image hash mismatch for $ImagePath"
    }

    $expectedVpkPath = [System.IO.Path]::GetFullPath([string]$profile.inputs.mapVpk.path)
    $expectedGnvPath = [System.IO.Path]::GetFullPath([string]$profile.inputs.gridNav.path)
    if (-not [System.IO.Path]::GetFullPath([string]$Manifest.inputs.vpk.path).Equals($expectedVpkPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Resume VPK path mismatch for $ImagePath"
    }
    if (-not [System.IO.Path]::GetFullPath([string]$Manifest.inputs.gridNav.path).Equals($expectedGnvPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Resume grid-nav path mismatch for $ImagePath"
    }
    if ([string]$Manifest.inputs.vpk.sha256 -cne [string]$profile.inputs.mapVpk.sha256) {
        throw "Resume VPK hash mismatch for $ImagePath"
    }
    if ([string]$Manifest.inputs.gridNav.sha256 -cne [string]$profile.inputs.gridNav.sha256) {
        throw "Resume grid-nav hash mismatch for $ImagePath"
    }

    Assert-NearlyEqual ([double]$Manifest.camera.position[0]) $CenterX 'camera.position.x'
    Assert-NearlyEqual ([double]$Manifest.camera.position[1]) $CenterY 'camera.position.y'
    Assert-NearlyEqual ([double]$Manifest.camera.position[2]) $ExpectedCameraZ 'camera.position.z'
    Assert-NearlyEqual ([double]$Manifest.camera.projectionWindowCenter[0]) $CenterX 'camera.projectionWindowCenter.x'
    Assert-NearlyEqual ([double]$Manifest.camera.projectionWindowCenter[1]) $CenterY 'camera.projectionWindowCenter.y'
    Assert-NearlyEqual ([double]$Manifest.camera.near) ([double]$profile.projection.camera.near) 'camera.near'
    Assert-NearlyEqual ([double]$Manifest.camera.far) ([double]$profile.projection.camera.far) 'camera.far'
    Assert-NearlyEqual ([double]$Manifest.camera.exposure) ([double]$profile.projection.camera.exposure) 'camera.exposure'
    if ([int]$Manifest.camera.warmupFrames -ne [int]$profile.projection.camera.warmupFrames) {
        throw "Resume warmup-frame mismatch for $ImagePath"
    }
    if ([int]$Manifest.camera.msaaSamples -ne [int]$profile.projection.camera.msaaSamples) {
        throw "Resume MSAA mismatch for $ImagePath"
    }
    if ([int]$Manifest.renderingQuality.maxTextureSize -ne [int]$profile.renderingQuality.maxTextureSize) {
        throw "Resume maximum-texture-size mismatch for $ImagePath"
    }
    if ([bool]$Manifest.renderingQuality.forceHighestLod -ne [bool]$profile.renderingQuality.forceHighestLod) {
        throw "Resume forced-LOD mismatch for $ImagePath"
    }
    if ([bool]$profile.renderingQuality.forceHighestLod -and [int]$Manifest.renderingQuality.forcedHighestLodModelCount -le 0) {
        throw "Resume manifest recorded no forced highest-LOD models for $ImagePath"
    }

    Assert-NearlyEqual ([double]$Manifest.worldBounds.left) ($CenterX - ($SpanX / 2.0)) 'worldBounds.left'
    Assert-NearlyEqual ([double]$Manifest.worldBounds.right) ($CenterX + ($SpanX / 2.0)) 'worldBounds.right'
    Assert-NearlyEqual ([double]$Manifest.worldBounds.bottom) ($CenterY - ($SpanY / 2.0)) 'worldBounds.bottom'
    Assert-NearlyEqual ([double]$Manifest.worldBounds.top) ($CenterY + ($SpanY / 2.0)) 'worldBounds.top'
    Assert-NearlyEqual ([double]$Manifest.worldBounds.unitsPerPixelX) ($SpanX / $PixelWidth) 'worldBounds.unitsPerPixelX'
    Assert-NearlyEqual ([double]$Manifest.worldBounds.unitsPerPixelY) ($SpanY / $PixelHeight) 'worldBounds.unitsPerPixelY'
}

$vpkPathResolved = [System.IO.Path]::GetFullPath([string]$profile.inputs.mapVpk.path)
$gnvPathResolved = [System.IO.Path]::GetFullPath([string]$profile.inputs.gridNav.path)
foreach ($inputSpec in @(
    [pscustomobject]@{ label = 'VPK'; path = $vpkPathResolved; sha256 = [string]$profile.inputs.mapVpk.sha256 },
    [pscustomobject]@{ label = 'grid-nav'; path = $gnvPathResolved; sha256 = [string]$profile.inputs.gridNav.sha256 }
)) {
    if (-not [System.IO.File]::Exists($inputSpec.path)) {
        throw "$($inputSpec.label) input does not exist: $($inputSpec.path)"
    }
    $actualInputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputSpec.path).Hash
    if ($actualInputHash -cne $inputSpec.sha256) {
        throw "$($inputSpec.label) input hash mismatch: expected $($inputSpec.sha256), got $actualInputHash"
    }
}

$cameraHeights = @(
    $CameraZList.Split(',', [System.StringSplitOptions]::RemoveEmptyEntries) |
        ForEach-Object {
            [double]::Parse($_.Trim(), [System.Globalization.NumberStyles]::Float, $invariant)
        }
)
if ($cameraHeights.Count -eq 0) {
    throw 'CameraZList must contain at least one numeric height.'
}

$buildPending = [bool]$Build
$renders = [System.Collections.Generic.List[object]]::new()
foreach ($height in $cameraHeights) {
    if ($height -le 0) { throw "CameraZ must be positive: $height" }
    $heightName = $height.ToString('0.###', $invariant).Replace('-', 'm').Replace('.', 'p')
    $output = Join-Path $outputResolved "camera-z-$heightName.png"
    $manifestPath = "$output.json"
    if ([System.IO.File]::Exists($output) -or [System.IO.File]::Exists($manifestPath)) {
        if (-not $Resume -or -not [System.IO.File]::Exists($output) -or -not [System.IO.File]::Exists($manifestPath)) {
            throw "Existing or incomplete sweep output: $output"
        }
    } else {
        $parameters = @{
            OutputPath = $output
            PixelWidth = $PixelWidth
            PixelHeight = $PixelHeight
            CenterX = $CenterX
            CenterY = $CenterY
            SpanX = $SpanX
            SpanY = $SpanY
            CameraZ = $height
            NearPlane = [double]$profile.projection.camera.near
            FarPlane = [double]$profile.projection.camera.far
            WarmupFrames = [int]$profile.projection.camera.warmupFrames
            Exposure = [double]$profile.projection.camera.exposure
            MsaaSamples = [int]$profile.projection.camera.msaaSamples
            MaxTextureSize = [int]$profile.renderingQuality.maxTextureSize
            VrfRoot = [string]$profile.renderer.vrfRoot
            VpkPath = [string]$profile.inputs.mapVpk.path
            GnvPath = [string]$profile.inputs.gridNav.path
            DotnetPath = [string]$profile.renderer.dotnetPath
        }
        if ([bool]$profile.renderingQuality.forceHighestLod) { $parameters.ForceHighestLod = $true }
        if ($buildPending) { $parameters.Build = $true }
        & $wrapper @parameters
        if ($LASTEXITCODE -ne 0) { throw "Camera sweep failed at z=$height" }
        $buildPending = $false
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -Depth 100
    Assert-ResumeManifest -Manifest $manifest -ImagePath $output -ExpectedCameraZ $height
    $renders.Add([pscustomobject]@{
        cameraZ = $height
        image = $output
        imageSha256 = $manifest.image.sha256
        worldBounds = $manifest.worldBounds
    })
}

$distinctHashes = @($renders.imageSha256 | Sort-Object -Unique)
$summary = [ordered]@{
    schemaVersion = '1.0.0'
    route = 'vrf-orthographic-camera-height-sweep-v1'
    profile = [ordered]@{
        path = $profilePathResolved
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $profilePathResolved).Hash
    }
    region = [ordered]@{
        centerX = $CenterX; centerY = $CenterY; spanX = $SpanX; spanY = $SpanY
        pixelWidth = $PixelWidth; pixelHeight = $PixelHeight
        unitsPerPixelX = $SpanX / $PixelWidth
        unitsPerPixelY = $SpanY / $PixelHeight
    }
    conclusion = [ordered]@{
        cameraHeightControlsOrthographicScale = $false
        allEncodedImagesIdentical = $distinctHashes.Count -eq 1
        distinctImageHashCount = $distinctHashes.Count
    }
    renders = $renders
}
$summaryPath = Join-Path $outputResolved 'camera-sweep-summary.json'
[System.IO.File]::WriteAllText(
    $summaryPath,
    "$(($summary | ConvertTo-Json -Depth 100))`n",
    [System.Text.UTF8Encoding]::new($false)
)
$comparisonPath = Join-Path $outputResolved 'camera-sweep-pixel-comparison.json'
$comparisonHelper = Join-Path (Split-Path -Parent $PSCommandPath) 'compare-camera-sweep.mjs'
& node.exe $comparisonHelper --summary $summaryPath --output $comparisonPath --force
if ($LASTEXITCODE -ne 0) {
    throw "Camera sweep pixel comparison failed with exit code $LASTEXITCODE"
}
$comparison = Get-Content -LiteralPath $comparisonPath -Raw | ConvertFrom-Json -Depth 100
$summary['pixelComparisonReport'] = $comparisonPath
$summary['conclusion']['scaleInvariantAcrossHeights'] = [bool]$comparison.scaleInvariant
$summary['conclusion']['maximumMismatchRatio'] = [double]$comparison.maximumMismatchRatio
$summary['conclusion']['maximumMeanAbsoluteRgbChannelDelta'] = [double]$comparison.maximumMeanAbsoluteRgbChannelDelta
[System.IO.File]::WriteAllText(
    $summaryPath,
    "$(($summary | ConvertTo-Json -Depth 100))`n",
    [System.Text.UTF8Encoding]::new($false)
)
Write-Output "Camera sweep summary: $summaryPath"
