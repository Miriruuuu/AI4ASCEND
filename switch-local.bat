@echo off
REM ===========================================================================
REM  Switch the project to LOCAL mode (frontend points at your own machine).
REM
REM  All logic lives in scripts\switch-mode.ps1 (UTF-8 safe).
REM
REM  What it does:
REM    1. pnpm sync:core        -> src\core copied into back\src\core
REM    2. build backend         -> back\dist
REM    3. build frontend with VITE_SERVER_URL = http://localhost:8787  -> dist\
REM    4. self-check            baked URL + target backend protocol version
REM
REM  The project ships as TWO artifacts (frontend and backend are deployed
REM  separately). This script refreshes both so they always match:
REM      back\dist   = the backend you run / copy to the server
REM      dist\       = the frontend you run locally / copy to the frontend folder
REM
REM  After this: back\start.bat (backend) + start.bat (frontend preview).
REM  Run switch-online.bat when you are ready to deploy to the server.
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
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode local %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode local %*
)

set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] switch-mode.ps1 exited with code %EXITCODE%
  pause
)
endlocal & exit /b %EXITCODE%
