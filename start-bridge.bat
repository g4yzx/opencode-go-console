@echo off
cd /d "%~dp0"

set "NODE=C:\Users\yzx\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%NODE%" goto haveNode
set "NODE="
for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%d\node.exe" set "NODE=%%d\node.exe"
if exist "%NODE%" goto haveNode
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"

:haveNode
if not exist "%NODE%" (
  echo [FAIL] Node.js 20+ not found.
  echo        Install Node, or edit the NODE= line in this file.
  pause
  exit /b 1
)

set "OPENCODE_GO_BRIDGE_STATE_DIR=%~dp0.state"
if exist "%~dp0go_key.txt" for /f "usebackq delims=" %%k in ("%~dp0go_key.txt") do set "GO_KEY=%%k"

echo.
echo   port     from bridge-config.json (default 8788)
echo   Ctrl+C to stop.
echo.
"%NODE%" src\bridge.js
pause
