@echo off
rem ===========================================================================
rem  Connect4 online backend - one click start (Windows)
rem  Pure ASCII file: do not put Chinese characters here.
rem ===========================================================================
setlocal
cd /d "%~dp0"

set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 (
  if exist "D:\nvm\nodejs\pnpm.cmd" (
    set "PNPM=D:\nvm\nodejs\pnpm.cmd"
  ) else (
    echo [start] pnpm not found in PATH. Please install pnpm or run: npm i -g pnpm
    exit /b 1
  )
)

if not exist ".env" (
  if exist ".env.example" (
    echo [start] .env not found, copying .env.example -^> .env
    copy /y ".env.example" ".env" >nul
  )
)

if not exist "node_modules" (
  echo [start] installing dependencies with pnpm...
  call "%PNPM%" install
  if errorlevel 1 goto :fail
)

rem ---------------------------------------------------------------------------
rem  Always rebuild before starting.
rem
rem  Why not "skip if dist exists": a stale dist\ keeps serving OLD protocol
rem  code, which shows up as "versionMismatch: server 1 / client 2" on your own
rem  machine even though the sources are already correct. A backend build takes
rem  only a couple of seconds, so rebuild unconditionally.
rem
rem  Also: dist\core\ is a COPY of ..\src\core (pnpm sync:core). Core changes
rem  must be synced first, otherwise the server runs an outdated engine.
rem ---------------------------------------------------------------------------
pushd ..
if exist "scripts\sync-core.mjs" (
  echo [start] syncing core ^(pnpm sync:core^)...
  call "%PNPM%" run sync:core
  if errorlevel 1 goto :fail_pop
)
popd

echo [start] building TypeScript to dist\...
call "%PNPM%" run build
if errorlevel 1 goto :fail

rem Print the protocol version that is actually about to run (sanity check).
for /f "delims=" %%V in ('powershell -NoProfile -Command "(Select-String -Path dist\protocol.js -Pattern ''PROTOCOL_VERSION = (\d+)'').Matches[0].Groups[1].Value"') do set "PV=%%V"
if not "%PV%"=="" echo [start] PROTOCOL_VERSION = %PV%  ^(client must match this^)

echo [start] launching server on http://127.0.0.1:8787
node dist\index.js
goto :eof

:fail_pop
popd
:fail
echo [start] FAILED. Please read the messages above.
exit /b 1
