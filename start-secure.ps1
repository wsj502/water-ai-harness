#requires -Version 5.1
<#
.SYNOPSIS
  Secure launcher (DPAPI credentials).
.DESCRIPTION
  Credential source (auto-detected, cipher preferred):
    1. %USERPROFILE%\.{APP_NAME}\secrets.dpapi  (DPAPI cipher)
    2. %USERPROFILE%\.{APP_NAME}\.env           (plain, transitional)
    3. path set via {APP_NAME_UPPER}_ENV_FILE
  First time: run  import-secrets.ps1 -Path <plain.env>
  NOTE: keep this .ps1 PURE ASCII (or save as UTF-8 *with BOM*).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\start-secure.ps1
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }  # fallback: system Python 3.11+

# Usage: start-secure.ps1 -- <command> [args...]
# Example: start-secure.ps1 -- npm run dev
& $python tools\envload.py @Rest
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host "`n[ERROR] exited with code $code. See message above." -ForegroundColor Red
    Read-Host 'Press Enter to exit'
}
exit $code
