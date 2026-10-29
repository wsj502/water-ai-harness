#requires -Version 5.1
<#
.SYNOPSIS
  Build water-server as a Node SEA (single executable application).
.DESCRIPTION
  Steps: esbuild bundle (CJS) -> sea blob -> copy official node.exe -> postject inject.
  Output: apps/server/dist-sea/water-server.exe
          and a copy for Tauri externalBin:
          apps/desktop/src-tauri/binaries/water-server-x86_64-pc-windows-msvc.exe
  NOTE: pure ASCII on purpose (PS 5.1 parses BOM-less non-ASCII as ANSI).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\build-sea.ps1
#>
[CmdletBinding()]
param(
    [string]$NodeExe = ''   # official node.exe path; auto-download when empty
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)

$seaDir = 'apps\server\dist-sea'
New-Item -ItemType Directory -Force $seaDir | Out-Null

Write-Host '[1/4] bundle (esbuild -> CJS)'
npx tsc -b apps/server
if ($LASTEXITCODE -ne 0) { exit 1 }
npx esbuild apps/server/dist/index.js --bundle --platform=node --format=cjs --target=node22 --outfile="$seaDir/bundle.cjs"
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '[2/4] sea blob'
node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '[3/4] base node.exe'
if (-not $NodeExe) {
    $NodeExe = Join-Path $env:TEMP 'node-sea-base.exe'
    if (-not (Test-Path $NodeExe)) {
        $ver = (node --version).Trim()
        Write-Host "  downloading official node $ver ..."
        Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/win-x64/node.exe" -OutFile $NodeExe -UseBasicParsing
    }
}
$out = Join-Path $seaDir 'water-server.exe'
Copy-Item $NodeExe $out -Force

Write-Host '[4/4] inject blob (postject)'
# NOTE: the fuse sentinel changed across Node versions.
# Node v24 uses: NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
npx postject $out NODE_SEA_BLOB "$seaDir/sea-prep.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { exit 1 }

# Tauri externalBin slot
$binDir = 'apps\desktop\src-tauri\binaries'
New-Item -ItemType Directory -Force $binDir | Out-Null
Copy-Item $out (Join-Path $binDir 'water-server-x86_64-pc-windows-msvc.exe') -Force

Write-Host "OK -> $out"
Write-Host 'NOTE: the exe signature is invalidated by injection; re-sign before public distribution.'
