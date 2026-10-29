@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  Secure launcher (DPAPI credentials)
REM  Credential source (auto-detected, cipher preferred):
REM    1. %USERPROFILE%\.{APP_NAME}\secrets.dpapi  (DPAPI cipher)
REM    2. %USERPROFILE%\.{APP_NAME}\.env           (plain, transitional)
REM    3. path set via {APP_NAME_UPPER}_ENV_FILE
REM  First time: run  import-secrets.bat <path-to-plain.env>
REM  NOTE: keep this .bat file PURE ASCII (OEM codepage parsing).
REM ============================================================
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
  set "PY=.venv\Scripts\python.exe"
) else (
  set "PY=python"
)

"%PY%" tools\envload.py %*

if %errorlevel% neq 0 (
  echo.
  echo [ERROR] exited with code %errorlevel%. See message above.
  pause
)

endlocal
