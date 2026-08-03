# Download the official tectonic 0.15 binary into src-tauri/resources/bin/.
# Needed when cloning the repo without the (large) binary, or to update it.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/download-tectonic.ps1
# Tectonic is MIT-licensed: https://github.com/tectonic-typesetting/tectonic

$ErrorActionPreference = "Stop"
$Version = "0.15.0"
$Url = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40$Version/tectonic-$Version-x86_64-pc-windows-msvc.zip"
$DestDir = Join-Path $PSScriptRoot "..\src-tauri\resources\bin"
$Tmp = Join-Path $env:TEMP "tectonic-download"

Write-Host "Downloading tectonic $Version ..."
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Zip = Join-Path $Tmp "tectonic.zip"
Invoke-WebRequest -Uri $Url -OutFile $Zip

Write-Host "Extracting ..."
Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
Copy-Item (Join-Path $Tmp "tectonic.exe") (Join-Path $DestDir "tectonic.exe") -Force
Remove-Item -Recurse -Force $Tmp

Write-Host "Done: $DestDir\tectonic.exe"
& (Join-Path $DestDir "tectonic.exe") --version
