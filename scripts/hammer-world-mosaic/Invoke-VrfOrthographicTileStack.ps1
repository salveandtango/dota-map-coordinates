[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ProfilePath,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputDirectory,

    [string[]]$TileId,

    [ValidateRange(0, 100000)]
    [int]$MaxTiles = 0,

    [switch]$PlanOnly,

    [switch]$Resume,

    [switch]$Batch,

    [switch]$Build
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-JsonFile {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [object]$Value
    )
    $json = $Value | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText(
        $Path,
        "$json`n",
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Test-NearlyEqual {
    param([double]$First, [double]$Second)
    return [Math]::Abs($First - $Second) -le 0.001
}

function Test-RawTileManifest {
    param(
        [Parameter(Mandatory)] [string]$ImagePath,
        [Parameter(Mandatory)] [object]$Tile,
        [Parameter(Mandatory)] [object]$Profile
    )
    $manifestPath = "$ImagePath.json"
    if (-not [System.IO.File]::Exists($ImagePath) -or -not [System.IO.File]::Exists($manifestPath)) {
        return $false
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -Depth 100
    $imageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ImagePath).Hash
    return $manifest.route -eq $Profile.renderer.manifestRoute `
        -and $manifest.image.width -eq $Tile.render.pixelWidth `
        -and $manifest.image.height -eq $Tile.render.pixelHeight `
        -and $manifest.image.sha256 -eq $imageHash `
        -and $manifest.inputs.vpk.sha256 -eq $Profile.inputs.mapVpk.sha256 `
        -and $manifest.inputs.gridNav.sha256 -eq $Profile.inputs.gridNav.sha256 `
        -and (Test-NearlyEqual $manifest.camera.position[0] 0) `
        -and (Test-NearlyEqual $manifest.camera.position[1] 0) `
        -and (Test-NearlyEqual $manifest.camera.position[2] $Profile.projection.camera.z) `
        -and (Test-NearlyEqual $manifest.camera.projectionWindowCenter[0] $Tile.render.centerX) `
        -and (Test-NearlyEqual $manifest.camera.projectionWindowCenter[1] $Tile.render.centerY) `
        -and (Test-NearlyEqual $manifest.camera.near $Profile.projection.camera.near) `
        -and (Test-NearlyEqual $manifest.camera.far $Profile.projection.camera.far) `
        -and (Test-NearlyEqual $manifest.camera.exposure $Profile.projection.camera.exposure) `
        -and $manifest.camera.warmupFrames -eq $Profile.projection.camera.warmupFrames `
        -and $manifest.camera.msaaSamples -eq $Profile.projection.camera.msaaSamples `
        -and $manifest.renderingQuality.maxTextureSize -eq $Profile.renderingQuality.maxTextureSize `
        -and $manifest.renderingQuality.forceHighestLod -eq $Profile.renderingQuality.forceHighestLod `
        -and (-not $Profile.renderingQuality.forceHighestLod -or $manifest.renderingQuality.forcedHighestLodModelCount -gt 0) `
        -and (Test-NearlyEqual $manifest.worldBounds.left $Tile.render.worldBounds.left) `
        -and (Test-NearlyEqual $manifest.worldBounds.right $Tile.render.worldBounds.right) `
        -and (Test-NearlyEqual $manifest.worldBounds.bottom $Tile.render.worldBounds.bottom) `
        -and (Test-NearlyEqual $manifest.worldBounds.top $Tile.render.worldBounds.top) `
        -and (Test-NearlyEqual $manifest.worldBounds.unitsPerPixelX $Profile.projection.unitsPerPixel) `
        -and (Test-NearlyEqual $manifest.worldBounds.unitsPerPixelY $Profile.projection.unitsPerPixel)
}

function Test-CoreTileManifest {
    param(
        [Parameter(Mandatory)] [string]$ImagePath,
        [Parameter(Mandatory)] [string]$RawImagePath,
        [Parameter(Mandatory)] [object]$Tile
    )
    $manifestPath = "$ImagePath.json"
    if (-not [System.IO.File]::Exists($ImagePath) -or -not [System.IO.File]::Exists($manifestPath)) {
        return $false
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -Depth 100
    if (-not [System.IO.File]::Exists($RawImagePath)) {
        return $false
    }
    $rawHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $RawImagePath).Hash
    $coreHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ImagePath).Hash
    return $manifest.route -eq 'canonical-canvas-integer-crop-v1' `
        -and $manifest.input.width -eq $Tile.render.pixelWidth `
        -and $manifest.input.height -eq $Tile.render.pixelHeight `
        -and $manifest.input.sha256 -eq $rawHash `
        -and $manifest.output.sha256 -eq $coreHash `
        -and $manifest.crop.left -eq $Tile.core.sourceRect.left `
        -and $manifest.crop.top -eq $Tile.core.sourceRect.top `
        -and $manifest.crop.width -eq $Tile.core.sourceRect.width `
        -and $manifest.crop.height -eq $Tile.core.sourceRect.height
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$resolvedProfile = [System.IO.Path]::GetFullPath($ProfilePath)
if (-not [System.IO.File]::Exists($resolvedProfile)) {
    throw "Tile profile not found: $resolvedProfile"
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not [System.IO.Directory]::Exists($resolvedOutput)) {
    [System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
}

$profile = Get-Content -LiteralPath $resolvedProfile -Raw | ConvertFrom-Json -Depth 100
$profileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedProfile).Hash
$planPath = Join-Path $resolvedOutput 'tile-plan.json'
$generator = Join-Path $scriptRoot 'generate-orthographic-tile-plan.mjs'
if (-not [System.IO.File]::Exists($planPath)) {
    & node.exe $generator --profile $resolvedProfile --output $planPath
    if ($LASTEXITCODE -ne 0) {
        throw "Tile-plan generation failed with exit code $LASTEXITCODE"
    }
}

$plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json -Depth 100
if ($plan.profile.sha256 -ne $profileHash) {
    throw 'Existing tile plan was generated from a different profile. Use a new output directory.'
}
if ($PlanOnly) {
    Write-Output "Plan: $planPath"
    Write-Output "Tiles: $($plan.mosaic.tileCount), mosaic: $($plan.mosaic.width)x$($plan.mosaic.height)"
    return
}

if ($profile.validation.requireInputHashes) {
    $vpkHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $profile.inputs.mapVpk.path).Hash
    $gnvHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $profile.inputs.gridNav.path).Hash
    if ($vpkHash -ne $profile.inputs.mapVpk.sha256) {
        throw "Map VPK hash drift: $vpkHash"
    }
    if ($gnvHash -ne $profile.inputs.gridNav.sha256) {
        throw "GridNav hash drift: $gnvHash"
    }
}

$selectedTiles = @($plan.tiles)
if ($TileId -and $TileId.Count -gt 0) {
    $requested = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($idArgument in $TileId) {
        foreach ($id in $idArgument.Split(',', [System.StringSplitOptions]::RemoveEmptyEntries)) {
            [void]$requested.Add($id.Trim())
        }
    }
    $selectedTiles = @($selectedTiles | Where-Object { $requested.Contains($_.id) })
    if ($selectedTiles.Count -ne $requested.Count) {
        $found = [System.Collections.Generic.HashSet[string]]::new(
            [string[]]@($selectedTiles | ForEach-Object { $_.id }),
            [System.StringComparer]::Ordinal
        )
        $missing = @($requested | Where-Object { -not $found.Contains($_) })
        throw "Unknown tile id(s): $($missing -join ', ')"
    }
}
if ($MaxTiles -gt 0) {
    $selectedTiles = @($selectedTiles | Select-Object -First $MaxTiles)
}
if ($selectedTiles.Count -eq 0) {
    throw 'No tiles selected.'
}

$wrapper = [System.IO.Path]::GetFullPath($profile.renderer.wrapperPath)
$cropper = Join-Path $scriptRoot 'crop-canonical-canvas.mjs'
$buildPending = [bool]$Build
$results = [System.Collections.Generic.List[object]]::new()
$batchedTileIds = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
)

if ($Batch) {
    $pendingTiles = [System.Collections.Generic.List[object]]::new()
    foreach ($tile in $selectedTiles) {
        $rawPath = Join-Path $resolvedOutput ($tile.rawImage -replace '/', '\')
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $rawPath)) | Out-Null
        $rawValid = Test-RawTileManifest -ImagePath $rawPath -Tile $tile -Profile $profile
        $rawExists = [System.IO.File]::Exists($rawPath) -or [System.IO.File]::Exists("$rawPath.json")
        if ($rawExists -and -not $Resume) {
            throw "Raw tile already exists; use -Resume after validating it: $rawPath"
        }
        if ($rawExists -and -not $rawValid) {
            throw "Existing raw tile is incomplete or does not match the plan: $rawPath"
        }
        if (-not $rawValid) {
            $pendingTiles.Add($tile)
        }
    }

    if ($pendingTiles.Count -gt 0) {
        $batchDirectory = Join-Path $resolvedOutput 'diagnostics\batch-plans'
        [System.IO.Directory]::CreateDirectory($batchDirectory) | Out-Null
        $batchPlanPath = Join-Path $batchDirectory (
            'batch-render-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfffZ') + '.json'
        )
        $batchRequests = @($pendingTiles | ForEach-Object {
            $rawPath = Join-Path $resolvedOutput ($_.rawImage -replace '/', '\')
            [ordered]@{
                outputPath = $rawPath
                pixelWidth = [int]$_.render.pixelWidth
                pixelHeight = [int]$_.render.pixelHeight
                centerX = [double]$_.render.centerX
                centerY = [double]$_.render.centerY
                spanX = [double]$_.render.spanX
                spanY = [double]$_.render.spanY
            }
        })
        Write-JsonFile -Path $batchPlanPath -Value ([ordered]@{
            schemaVersion = '1.0.0'
            sourcePlan = [ordered]@{ path = $planPath; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $planPath).Hash }
            requests = $batchRequests
        })

        $batchParameters = @{
            BatchPlanPath = $batchPlanPath
            CameraZ = [double]$profile.projection.camera.z
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
        if ([bool]$profile.renderingQuality.forceHighestLod) {
            $batchParameters.ForceHighestLod = $true
        }
        if ($buildPending) {
            $batchParameters.Build = $true
        }
        & $wrapper @batchParameters
        if ($LASTEXITCODE -ne 0) {
            throw "Batch tile render failed with exit code $LASTEXITCODE"
        }
        $buildPending = $false

        foreach ($tile in $pendingTiles) {
            $rawPath = Join-Path $resolvedOutput ($tile.rawImage -replace '/', '\')
            if (-not (Test-RawTileManifest -ImagePath $rawPath -Tile $tile -Profile $profile)) {
                throw "Batch renderer produced an invalid tile: $($tile.id)"
            }
            [void]$batchedTileIds.Add([string]$tile.id)
        }
    }
}

foreach ($tile in $selectedTiles) {
    $rawPath = Join-Path $resolvedOutput ($tile.rawImage -replace '/', '\')
    $corePath = Join-Path $resolvedOutput ($tile.coreImage -replace '/', '\')
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $rawPath)) | Out-Null
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $corePath)) | Out-Null

    $rawValid = Test-RawTileManifest -ImagePath $rawPath -Tile $tile -Profile $profile
    $rawExists = [System.IO.File]::Exists($rawPath) -or [System.IO.File]::Exists("$rawPath.json")
    if ($rawExists -and -not $Resume -and -not $batchedTileIds.Contains([string]$tile.id)) {
        throw "Raw tile already exists; use -Resume after validating it: $rawPath"
    }
    if ($rawExists -and -not $rawValid) {
        throw "Existing raw tile is incomplete or does not match the plan: $rawPath"
    }

    $rendered = $batchedTileIds.Contains([string]$tile.id)
    if (-not $rawValid) {
        $renderParameters = @{
            OutputPath = $rawPath
            PixelWidth = [int]$tile.render.pixelWidth
            PixelHeight = [int]$tile.render.pixelHeight
            CenterX = [double]$tile.render.centerX
            CenterY = [double]$tile.render.centerY
            SpanX = [double]$tile.render.spanX
            SpanY = [double]$tile.render.spanY
            CameraZ = [double]$profile.projection.camera.z
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
        if ([bool]$profile.renderingQuality.forceHighestLod) {
            $renderParameters.ForceHighestLod = $true
        }
        if ($buildPending) {
            $renderParameters.Build = $true
        }
        & $wrapper @renderParameters
        if ($LASTEXITCODE -ne 0) {
            throw "Tile render failed for $($tile.id) with exit code $LASTEXITCODE"
        }
        $buildPending = $false
        $rendered = $true
    }

    $coreValid = Test-CoreTileManifest -ImagePath $corePath -RawImagePath $rawPath -Tile $tile
    $coreExists = [System.IO.File]::Exists($corePath) -or [System.IO.File]::Exists("$corePath.json")
    if ($coreExists -and -not $Resume) {
        throw "Core tile already exists; use -Resume after validating it: $corePath"
    }
    if ($coreExists -and -not $coreValid) {
        throw "Existing core tile is incomplete or does not match the plan: $corePath"
    }
    if (-not $coreValid) {
        & node.exe $cropper `
            --input $rawPath `
            --output $corePath `
            --left $tile.core.sourceRect.left `
            --top $tile.core.sourceRect.top `
            --width $tile.core.sourceRect.width `
            --height $tile.core.sourceRect.height
        if ($LASTEXITCODE -ne 0) {
            throw "Core crop failed for $($tile.id) with exit code $LASTEXITCODE"
        }
    }

    $results.Add([pscustomobject]@{
        id = $tile.id
        status = if ($rendered) { 'rendered' } else { 'resumed' }
        rawImage = $rawPath
        coreImage = $corePath
        cameraZ = [double]$profile.projection.camera.z
        centerX = [double]$tile.render.centerX
        centerY = [double]$tile.render.centerY
        spanX = [double]$tile.render.spanX
        spanY = [double]$tile.render.spanY
    })
}

$summaryPath = Join-Path $resolvedOutput 'capture-summary.json'
Write-JsonFile -Path $summaryPath -Value ([ordered]@{
    schemaVersion = '1.0.0'
    route = $profile.routeId
    profile = [ordered]@{ path = $resolvedProfile; sha256 = $profileHash }
    plan = $planPath
    projectionSemantics = [ordered]@{
        cameraHeightControlsScale = $false
        scaleControl = 'projection span divided by output pixels'
        unitsPerPixel = [double]$profile.projection.unitsPerPixel
    }
    renderingQuality = [ordered]@{
        maxTextureSize = [int]$profile.renderingQuality.maxTextureSize
        forceHighestLod = [bool]$profile.renderingQuality.forceHighestLod
    }
    selectedTileCount = $selectedTiles.Count
    renderedTileCount = @($results | Where-Object { $_.status -eq 'rendered' }).Count
    resumedTileCount = @($results | Where-Object { $_.status -eq 'resumed' }).Count
    tiles = $results
})

Write-Output "Capture summary: $summaryPath"
