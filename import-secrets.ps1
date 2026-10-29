#requires -Version 5.1
<#
.SYNOPSIS
  Import secrets: plain .env -> DPAPI encrypted store.
.DESCRIPTION
  Cipher output: %USERPROFILE%\.{APP_NAME}\secrets.dpapi
  Only this Windows user on this machine can decrypt it.
  After a successful import, DELETE the plain source file.
  NOTE: keep this .ps1 PURE ASCII (or save as UTF-8 *with BOM*).
  Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI -> CJK breaks parsing.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\import-secrets.ps1 -Path C:\secrets\.env
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, HelpMessage = "Path to the plain .env file")]
    [ValidateNotNullOrEmpty()]
    [string]$Path
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }  # fallback: system Python 3.11+
if (-not (Test-Path $Path)) {
    Write-Host "[ERROR] Plain .env not found: $Path" -ForegroundColor Red
    exit 1
}

& $python tools\dpapi_env.py import --from $Path
exit $LASTEXITCODE
