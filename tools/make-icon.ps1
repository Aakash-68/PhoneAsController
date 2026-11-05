# Builds the app icon from testbench\public\icon.svg:
#   bridge\app.ico (16-256 px, PNG-compressed entries) and testbench\public\icon-{192,512}.png
#   powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$svg = Join-Path $repo 'testbench\public\icon.svg'
$tmp = Join-Path $env:TEMP 'pc-icon'
New-Item -ItemType Directory -Force $tmp | Out-Null
$master = Join-Path $tmp 'icon1024.png'

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge is needed to render the SVG' }
if (Test-Path $master) { Remove-Item $master }
$uri = 'file:///' + ($svg -replace '\\', '/')
Start-Process -FilePath $edge -Wait -WindowStyle Hidden -ArgumentList @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', "--user-data-dir=`"$tmp\profile`"", '--window-size=1024,1024', "--screenshot=`"$master`"", $uri)
for ($i = 0; $i -lt 40 -and -not (Test-Path $master); $i++) { Start-Sleep -Milliseconds 250 }
if (-not (Test-Path $master)) { throw 'icon render failed' }

Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($master)
function Resize([int]$n) {
  $bmp = New-Object System.Drawing.Bitmap $n, $n, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $n, $n)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return , $ms.ToArray()
}

# web icons
foreach ($n in 192, 512) { [IO.File]::WriteAllBytes((Join-Path $repo "testbench\public\icon-$n.png"), (Resize $n)) }

# .ico: header + directory + PNG payloads
$sizes = 16, 24, 32, 48, 64, 128, 256
$imgs = $sizes | ForEach-Object { , (Resize $_) }
$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $n = $sizes[$i]; $len = $imgs[$i].Length
  $w.Write([byte]($(if ($n -ge 256) { 0 } else { $n }))); $w.Write([byte]($(if ($n -ge 256) { 0 } else { $n })))
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$len); $w.Write([uint32]$offset)
  $offset += $len
}
foreach ($b in $imgs) { $w.Write($b) }
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $repo 'bridge\app.ico'), $ico.ToArray())
[IO.File]::WriteAllBytes((Join-Path $repo 'testbench\public\favicon.ico'), $ico.ToArray())
$src.Dispose()
Write-Host "Icon written: bridge\app.ico ($([math]::Round($ico.Length / 1KB)) KB), testbench\public\icon-192.png, icon-512.png, favicon.ico"
