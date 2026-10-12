@echo off
REM ===========================================================================
REM  Connect Four 3D - quick launcher
REM  Builds the project, starts the preview server and opens the browser.
REM
REM  All logic lives in scripts\start.ps1 (UTF-8 safe).
REM  Options: pass them straight through, e.g.
REM      start.bat -Port 5200
REM      start.bat -NoBuild
REM      start.bat -Stop
REM ===========================================================================
setlocal
set "SCRIPT=%~dp0scripts\start.ps1"

if not exist "%SCRIPT%" (
  echo [ERROR] Cannot find "%SCRIPT%"
  pause
  exit /b 1
)

where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)

set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Launcher exited with code %EXITCODE%
  pause
)
endlocal & exit /b %EXITCODE%
