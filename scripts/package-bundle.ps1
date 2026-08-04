# Package the warm tectonic cache into src-tauri/resources/bundle/bundle.zip
# so the installer can ship it and every user compiles offline (no network).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/package-bundle.ps1
#
# The zip contains the tectonic cache layout directly (files/, formats/, ...)
# and is unpacked by TeXButler into %LOCALAPPDATA%\TectonicProject\Tectonic
# on first compile. It is NOT committed to git (see .gitignore).
#
# NOTE: keep this file pure ASCII (PowerShell 5.1 reads scripts as ANSI).

$ErrorActionPreference = "Stop"

$cacheRoot = Join-Path $env:LOCALAPPDATA "TectonicProject\Tectonic"
$outDir = Join-Path $PSScriptRoot "..\src-tauri\resources\bundle"
$outZip = Join-Path $outDir "bundle.zip"

if (-not (Test-Path (Join-Path $cacheRoot "files"))) {
    Write-Error "Tectonic cache not warm: $cacheRoot`nCompile once with TeXButler first (or use the 'Pre-download bundle' button in Settings)."
    exit 1
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (Test-Path $outZip) { Remove-Item $outZip -Force }

$sw = [System.Diagnostics.Stopwatch]::StartNew()
# Compress the CONTENTS of the cache dir (files/, formats/, ... at zip root)
Compress-Archive -Path (Join-Path $cacheRoot "*") -DestinationPath $outZip -CompressionLevel Optimal
$sw.Stop()

$sizeMB = [math]::Round((Get-Item $outZip).Length / 1MB, 1)
$elapsed = [math]::Round($sw.Elapsed.TotalSeconds)
Write-Host "bundle.zip created: $outZip ($sizeMB MB, ${elapsed}s)"
Write-Host "Run 'npm run tauri build' - the installer will then bundle the offline bundle."
