# Download the official tectonic 0.15 binary into src-tauri/resources/bin/.
# Needed when cloning the repo without the (large) binary, or to update it.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/download-tectonic.ps1
# Tectonic is MIT-licensed: https://github.com/tectonic-typesetting/tectonic

$ErrorActionPreference = "Stop"
$Version = "0.15.0"
$Url = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40$Version/tectonic-$Version-x86_64-pc-windows-msvc.zip"
# SHA-256 of the official tectonic 0.15.0 x86_64-pc-windows-msvc zip
# (verified 2026-08-04 against the GitHub release asset).
$ExpectedSha256 = "1D6BB76F049C8A3774F6E9D66E4B04E1A8C3DCB37527B6B41B7E894328E7BF29"
$DestDir = Join-Path $PSScriptRoot "..\src-tauri\resources\bin"
$Tmp = Join-Path $env:TEMP "tectonic-download"
$TimeoutSec = 600

Write-Host "Downloading tectonic $Version ..."
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Zip = Join-Path $Tmp "tectonic.zip"
Invoke-WebRequest -Uri $Url -OutFile $Zip -TimeoutSec $TimeoutSec

Write-Host "Verifying SHA-256 ..."
$Hash = (Get-FileHash -Path $Zip -Algorithm SHA256).Hash
if ($Hash -ne $ExpectedSha256) {
  throw "SHA-256 mismatch! expected $ExpectedSha256, got $Hash — refusing to install."
}
Write-Host "Hash OK: $Hash"

Write-Host "Extracting ..."
Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
Copy-Item (Join-Path $Tmp "tectonic.exe") (Join-Path $DestDir "tectonic.exe") -Force
Remove-Item -Recurse -Force $Tmp

Write-Host "Done: $DestDir\tectonic.exe"
& (Join-Path $DestDir "tectonic.exe") --version
