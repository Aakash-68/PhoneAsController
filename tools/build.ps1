# Builds everything people download:
#   Install.exe                               one-file installer (committed, so GitHub's "Download ZIP" includes it)
#   release\PhoneController-win-x64.zip       Install.exe + readme, to attach to a GitHub Release
#   build\PhoneController\                    the installed app, unpacked, for testing
# Needs: .NET SDK 8+, Node.js, npm. The target PC needs nothing: Node is bundled and the rest ships in Windows.
#   powershell -ExecutionPolicy Bypass -File tools\build.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$build = Join-Path $repo 'build'
$out = Join-Path $build 'PhoneController'
$release = Join-Path $repo 'release'
$tb = Join-Path $repo 'testbench'

if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force "$out\runtime", "$out\app", "$out\vendor", $release | Out-Null

Write-Host '1/6 tests'
& node "$tb\tools\tablemouse-test.js" | Select-Object -Last 1
if ($LASTEXITCODE) { throw 'table mouse tests failed' }

Write-Host '2/6 PhoneController.exe (launcher, controller bridge, hotspot helper)'
& dotnet build "$repo\bridge\PhoneController.csproj" -c Release -o "$build\bridge" --nologo -v q | Out-Null
if ($LASTEXITCODE) { throw 'dotnet build failed' }
Copy-Item "$build\bridge\PhoneController.exe", "$build\bridge\PhoneController.exe.config", "$build\bridge\Nefarius.ViGEm.Client.dll" $out

Write-Host '3/6 Node.js runtime'
Copy-Item (Get-Command node).Source "$out\runtime\node.exe"

Write-Host '4/6 server + phone pages'
if (-not (Test-Path "$tb\node_modules")) { Push-Location $tb; & npm ci --omit=dev --no-audit --no-fund | Out-Null; Pop-Location; if ($LASTEXITCODE) { throw 'npm ci failed' } }
foreach ($f in 'server.js', 'paths.js', 'players.js', 'setup.js', 'vigem.js', 'network.js', 'hotspotname.js', 'package.json') { Copy-Item "$tb\$f" "$out\app\" }
Copy-Item -Recurse "$tb\public" "$out\app\public"
Copy-Item -Recurse "$tb\node_modules" "$out\app\node_modules"
# Native modules ship builds for every OS; keep only Windows x64.
Get-ChildItem "$out\app\node_modules\koffi\build\koffi" -Directory -ErrorAction SilentlyContinue |
  Where-Object Name -ne 'win32_x64' | Remove-Item -Recurse -Force

$drv = Join-Path $repo 'vendor\ViGEmBus_1.22.0_x64_x86_arm64.exe'
if ((Get-AuthenticodeSignature $drv).Status -ne 'Valid') { throw 'ViGEmBus installer signature is not valid' }
Copy-Item $drv "$out\vendor\"

# Marks this folder as the installed app: only a folder with this marker may be deleted by Uninstall.
Set-Content "$out\.portable" 'PhoneController installed build'

Add-Type -AssemblyName System.IO.Compression.FileSystem
function New-Zip($from, $to) {
  # Antivirus often holds freshly copied files for a moment; retry a few times.
  for ($try = 1; ; $try++) {
    try {
      if (Test-Path $to) { Remove-Item $to }
      [IO.Compression.ZipFile]::CreateFromDirectory($from, $to, [IO.Compression.CompressionLevel]::Optimal, $false)
      return
    } catch {
      if ($try -ge 5) { throw }
      Start-Sleep -Seconds 2
    }
  }
}

Write-Host '5/6 Install.exe'
$payload = Join-Path $build 'payload.zip'
New-Zip $out $payload
$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
& $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$repo\Install.exe" "/win32icon:$repo\bridge\app.ico" "/win32manifest:$repo\installer\Install.manifest" `
  "/resource:$payload,payload.zip" /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:Microsoft.CSharp.dll /r:System.Core.dll `
  "$repo\installer\Install.cs" | Where-Object { $_ -notmatch 'C# 5|csc-is-for|https://go.microsoft|This compiler' }
if ($LASTEXITCODE) { throw 'installer compile failed' }

Write-Host '6/6 release zip'
$pack = Join-Path $build 'release'
New-Item -ItemType Directory -Force $pack | Out-Null
Copy-Item "$repo\Install.exe" $pack
Copy-Item "$repo\docs\START-HERE.txt" $pack
New-Zip $pack "$release\PhoneController-win-x64.zip"

Write-Host ("Done. Install.exe {0:N0} MB, zip {1:N0} MB, installed size {2:N0} MB" -f ((Get-Item "$repo\Install.exe").Length / 1MB), ((Get-Item "$release\PhoneController-win-x64.zip").Length / 1MB), ((Get-ChildItem -Recurse $out | Measure-Object Length -Sum).Sum / 1MB))
