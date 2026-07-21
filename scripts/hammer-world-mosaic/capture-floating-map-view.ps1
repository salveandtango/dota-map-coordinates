[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [long]$HammerWindowHandle,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [string]$WindowName = "Fullbright"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing.Common

$hammer = [System.Windows.Automation.AutomationElement]::FromHandle(
    [IntPtr]$HammerWindowHandle
)
if ($null -eq $hammer) {
    throw "Hammer window handle is invalid: $HammerWindowHandle"
}

$condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $WindowName
)
$view = $hammer.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
)
if ($null -eq $view) {
    throw "Floating map view was not found: $WindowName"
}

$bounds = $view.Current.BoundingRectangle
$width = [int]$bounds.Width
$height = [int]$bounds.Height
if ($width -le 0 -or $height -le 0) {
    throw "Floating map view has invalid bounds: ${width}x${height}"
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [System.IO.Path]::GetDirectoryName($resolvedOutput)
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$bitmap = [System.Drawing.Bitmap]::new(
    $width,
    $height,
    [System.Drawing.Imaging.PixelFormat]::Format24bppRgb
)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen(
        [int]$bounds.Left,
        [int]$bounds.Top,
        0,
        0,
        $bitmap.Size,
        [System.Drawing.CopyPixelOperation]::SourceCopy
    )
    $bitmap.Save(
        $resolvedOutput,
        [System.Drawing.Imaging.ImageFormat]::Png
    )
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedOutput).Hash
[pscustomobject]@{
    path = $resolvedOutput
    width = $width
    height = $height
    sha256 = $hash
} | ConvertTo-Json -Depth 3
