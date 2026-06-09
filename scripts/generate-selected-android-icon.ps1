$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$source = "C:\Users\PC\.codex\generated_images\019e8d60-5c83-7553-8148-e71d9a586aad\ig_06eed16ba2c5da0b016a20fc9b6fa8819180e8f40bb463a961.png"
$res = "D:\inkos-apk\packages\studio\android\app\src\main\res"
$preview = Join-Path $res "drawable\inkos_icon_option_4.png"

function New-BitmapFromCrop {
    param(
        [System.Drawing.Image] $Image,
        [int] $X,
        [int] $Y,
        [int] $Width,
        [int] $Height,
        [int] $Size
    )

    $crop = New-Object System.Drawing.Bitmap($Width, $Height)
    $cropGraphics = [System.Drawing.Graphics]::FromImage($crop)
    $cropGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $cropGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $cropGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $cropGraphics.DrawImage($Image, (New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)), (New-Object System.Drawing.Rectangle($X, $Y, $Width, $Height)), [System.Drawing.GraphicsUnit]::Pixel)
    $cropGraphics.Dispose()

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($crop, 0, 0, $Size, $Size)
    $graphics.Dispose()
    $crop.Dispose()

    return $bitmap
}

function Save-ResizedIcon {
    param(
        [System.Drawing.Image] $Image,
        [string] $Path,
        [int] $Size
    )

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($Image, 0, 0, $Size, $Size)
    $graphics.Dispose()
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

function Save-AdaptiveForeground {
    param(
        [System.Drawing.Image] $Image,
        [string] $Path,
        [int] $Size
    )

    $inner = [int]($Size * 0.88)
    $offset = [int](($Size - $inner) / 2)
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($Image, $offset, $offset, $inner, $inner)
    $graphics.Dispose()
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

$image = [System.Drawing.Image]::FromFile($source)
try {
    $icon = New-BitmapFromCrop -Image $image -X 120 -Y 526 -Width 380 -Height 380 -Size 1024
    try {
        $icon.Save($preview, [System.Drawing.Imaging.ImageFormat]::Png)

        $legacySizes = @{
            "mipmap-mdpi" = 48
            "mipmap-hdpi" = 72
            "mipmap-xhdpi" = 96
            "mipmap-xxhdpi" = 144
            "mipmap-xxxhdpi" = 192
        }
        $adaptiveSizes = @{
            "mipmap-mdpi" = 108
            "mipmap-hdpi" = 162
            "mipmap-xhdpi" = 216
            "mipmap-xxhdpi" = 324
            "mipmap-xxxhdpi" = 432
        }

        foreach ($entry in $legacySizes.GetEnumerator()) {
            $dir = Join-Path $res $entry.Key
            Save-ResizedIcon -Image $icon -Path (Join-Path $dir "ic_launcher.png") -Size $entry.Value
            Save-ResizedIcon -Image $icon -Path (Join-Path $dir "ic_launcher_round.png") -Size $entry.Value
        }

        foreach ($entry in $adaptiveSizes.GetEnumerator()) {
            $dir = Join-Path $res $entry.Key
            Save-AdaptiveForeground -Image $icon -Path (Join-Path $dir "ic_launcher_foreground.png") -Size $entry.Value
        }
    }
    finally {
        $icon.Dispose()
    }
}
finally {
    $image.Dispose()
}

Write-Host "Generated Android launcher icons from option 4."
