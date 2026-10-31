@echo off
setlocal
cd /d "%~dp0"
title TAYL - First time setup
echo ==========================================
echo   TAYL - First time setup
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node.js 22 or newer from https://nodejs.org then run this file again.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
echo Node.js major version: %NODEMAJOR%
if %NODEMAJOR% LSS 22 (
  echo [ERROR] Node.js 22 or newer is required. Please upgrade.
  pause
  exit /b 1
)

echo.
echo [1/4] Installing dependencies...
call npm ci
if errorlevel 1 (
  echo [ERROR] npm ci failed. Check your internet connection and try again.
  pause
  exit /b 1
)

echo.
echo [2/4] Running self-tests...
call npm test >"%TEMP%\tayl-test.log" 2>&1
if errorlevel 1 (
  echo [ERROR] Self-tests failed. See: %TEMP%\tayl-test.log
  pause
  exit /b 1
)
echo Self-tests passed.

echo.
echo [3/4] Preparing data folder...
if not exist "data" mkdir "data"
if not exist "data\logs" mkdir "data\logs"

echo.
echo [4/4] Creating Desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\TAYL.lnk'); $s.TargetPath='%CD%\scripts\windows\TAYL-Start.vbs'; $s.WorkingDirectory='%CD%'; $s.IconLocation='%SystemRoot%\System32\shell32.dll,13'; $s.Description='TAYL'; $s.Save()"
if errorlevel 1 (echo Shortcut was not created. You can run scripts\windows\TAYL-Start.vbs directly.) else (echo Shortcut "TAYL" created on Desktop.)

echo.
echo ==========================================
echo   Setup complete. Double-click "TAYL" on your Desktop.
echo ==========================================
pause
