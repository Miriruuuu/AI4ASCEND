@echo off
REM ===========================================================================
REM  Switch the project to ONLINE mode (frontend points at the live server).
REM
REM  All logic lives in scripts\switch-mode.ps1 (UTF-8 safe).
REM
REM  What it does:
REM    1. pnpm sync:core        -> src\core copied into back\src\core
REM    2. build backend         -> back\dist
REM    3. build frontend with VITE_SERVER_URL = http://113.45.13.149:8787 -> dist\
REM    4. self-check            baked URL + live backend protocol version
REM
REM  Run this right before deploying, then copy BOTH artifacts:
REM      back\  (all files) -> server backend directory, then restart the process
REM      dist\  (all files) -> server frontend directory
REM
REM  Both artifacts come from the SAME run on purpose: the frontend bakes the
REM  backend address at build time, and their protocol versions must match.
REM
REM  Run switch-local.bat again to go back to local development.
REM ===========================================================================
setlocal
set "SCRIPT=%~dp0scripts\switch-mode.ps1"

if not exist "%SCRIPT%" (
  echo [ERROR] Cannot find "%SCRIPT%"
  pause
  exit /b 1
)

where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode online %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode online %*
)

set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] switch-mode.ps1 exited with code %EXITCODE%
  pause
)
endlocal & exit /b %EXITCODE%
