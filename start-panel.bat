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
if not exist "%~dp0ui.js" (
  echo [FAIL] ui.js not found next to this script.
  pause
  exit /b 1
)

set "OPENCODE_GO_UI_PORT=8790"
set "OPENCODE_GO_BRIDGE_PORT=8788"

echo.
echo   opencode Go control panel
echo   http://127.0.0.1:8790
echo   Closing this window stops the panel. The bridge keeps running
echo   until you stop it from the panel.
echo.
"%NODE%" ui.js %*

echo.
echo [panel exited]
pause
