@echo off
rem AWS Tool Web - portable launcher for Windows.
rem Starts the bundled Node.js server and opens the app in the default browser.
rem Override any setting by defining it before running, e.g.: set PORT=9090
setlocal
cd /d "%~dp0"
title AWS Tool Web

if not defined PORT set "PORT=8080"
rem Localhost only: this app holds the power of your AWS credentials.
if not defined HOST set "HOST=127.0.0.1"
if not defined DATA_DIR set "DATA_DIR=%~dp0data"
set "NODE_ENV=production"
set "STATIC_DIR=%~dp0app\web\dist"

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

echo Starting AWS Tool Web on http://localhost:%PORT%
echo Close this window (or press Ctrl+C) to stop the server.
echo.

rem Open the browser once the server has had a moment to start.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:%PORT%"

"%~dp0runtime\node.exe" "%~dp0app\server\src\index.js"
if errorlevel 1 (
  echo.
  echo AWS Tool Web stopped with an error. If port %PORT% is in use, run: set PORT=9090
  pause
)
endlocal
