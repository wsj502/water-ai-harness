@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  Import secrets: plain .env -> DPAPI encrypted store
REM  Usage: import-secrets.bat <path-to-plain.env>
REM  NOTE: keep this .bat file PURE ASCII. cmd.exe parses batch
REM  files in the OEM codepage (GBK on zh-CN); UTF-8 CJK bytes
REM  in comments can break line parsing and execute fragments.
REM ============================================================
cd /d "%~dp0"

if "%~1"=="" (
  echo Usage: import-secrets.bat ^<path-to-plain.env^>
  echo Cipher output: %USERPROFILE%\.{APP_NAME}\secrets.dpapi
  pause
  exit /b 1
)

if exist ".venv\Scripts\python.exe" (
  set "PY=.venv\Scripts\python.exe"
) else (
  set "PY=python"
)

"%PY%" tools\dpapi_env.py import --from "%~1"
pause
endlocal
