# Generates placeholder PWA icons (192x192, 512x512, 180x180 apple-touch).
# Style: dark-slate rounded square with a stylized QR-code finder-pattern motif
# in the app's cyan accent. Replace these with your own branding any time.

Add-Type -AssemblyName System.Drawing

$bgColor      = [System.Drawing.ColorTranslator]::FromHtml("#0f172a")
$accentColor  = [System.Drawing.ColorTranslator]::FromHtml("#22d3ee")
$accentDim    = [System.Drawing.ColorTranslator]::FromHtml("#0e7490")

$iconsDir = Join-Path $PSScriptRoot "icons"
if (-not (Test-Path $iconsDir)) { New-Item -ItemType Directory -Path $iconsDir | Out-Null }

function New-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Background — rounded square (also fine for maskable: padding handled by ~12% inset)
    $bgBrush = New-Object System.Drawing.SolidBrush $bgColor
    $g.FillRectangle($bgBrush, 0, 0, $size, $size)

    # Safe inner area: 12% padding on all sides so the design survives maskable icon crops
    $pad    = [int]($size * 0.12)
    $inner  = $size - (2 * $pad)
    $module = [int]($inner / 7) # 7x7 module grid

    $accentBrush = New-Object System.Drawing.SolidBrush $accentColor
    $dimBrush    = New-Object System.Drawing.SolidBrush $accentDim

    # Three QR finder patterns (top-left, top-right, bottom-left)
    function Draw-Finder([int]$gx, [int]$gy) {
        $x = $pad + ($gx * $module)
        $y = $pad + ($gy * $module)
        $outer = $module * 3
        $g.FillRectangle($accentBrush, $x, $y, $outer, $outer)
        $g.FillRectangle($bgBrush,     $x + $module,           $y + $module,           $module, $module)
        # Center solid square — leave outer 1 module around it of bg, then re-fill center
        $cx = $x + $module
        $cy = $y + $module
        $g.FillRectangle($bgBrush,     $cx, $cy, $module, $module)
        $g.FillRectangle($accentBrush, $cx + [int]($module * 0.25), $cy + [int]($module * 0.25), [int]($module * 0.5), [int]($module * 0.5))
    }

    Draw-Finder 0 0
    Draw-Finder 4 0
    Draw-Finder 0 4

    # A few scattered modules in the data area for visual texture
    $dataCells = @(
        @(4,4), @(5,4), @(6,5),
        @(5,5), @(4,6), @(6,6),
        @(3,5), @(5,6), @(6,4)
    )
    foreach ($cell in $dataCells) {
        $x = $pad + ($cell[0] * $module)
        $y = $pad + ($cell[1] * $module)
        $g.FillRectangle($dimBrush, $x, $y, $module, $module)
    }

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "Wrote $path"
}

New-Icon 192 (Join-Path $iconsDir "icon-192.png")
New-Icon 512 (Join-Path $iconsDir "icon-512.png")
New-Icon 180 (Join-Path $iconsDir "apple-touch-icon.png")
