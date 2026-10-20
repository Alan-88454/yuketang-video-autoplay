# Package this extension into dist/<name>-v<version>.zip
#
# The zip contains a single top-level folder, so whoever receives it can
# unzip it and point Edge at that folder via "Load unpacked".
#
# Usage:  pwsh -File .\build.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -Raw (Join-Path $proj 'manifest.json') | ConvertFrom-Json
$name = "yuketang-video-autoplay-v$($manifest.version)"
$dist = Join-Path $proj 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$zip = Join-Path $dist "$name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

$files = @(
  @{ src = Join-Path $proj 'manifest.json';        entry = "$name/manifest.json" },
  @{ src = Join-Path $proj 'README.md';            entry = "$name/README.md" },
  @{ src = Join-Path $proj 'src\background.js';    entry = "$name/src/background.js" },
  @{ src = Join-Path $proj 'src\content.js';       entry = "$name/src/content.js" },
  @{ src = Join-Path $proj 'src\main-world.js';    entry = "$name/src/main-world.js" }
)

$fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
$za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($f in $files) {
  $entry = $za.CreateEntry($f.entry, [System.IO.Compression.CompressionLevel]::Optimal)
  $out = $entry.Open()
  $in = [System.IO.File]::OpenRead($f.src)
  $in.CopyTo($out)
  $in.Dispose()
  $out.Dispose()
}
$za.Dispose()
$fs.Dispose()

$kb = [math]::Round((Get-Item -LiteralPath $zip).Length / 1KB, 1)
Write-Host "built: $zip ($kb KB)"
Write-Host 'Unzip it, then load the inner folder as an unpacked extension.'
