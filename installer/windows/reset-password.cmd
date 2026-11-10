@echo off
rem WorldFoundry: reset the password of the web interface (local only, administrator only).
rem Shows a new random password and signs out all existing sign-ins. The service does not have to be stopped.
rem The access token (AUTH_TOKEN) for scripts stays unchanged.
rem Installed: Start menu "Reset password". Portable (ZIP): run the file in the package folder.
setlocal
cd /d "%~dp0"
set "DATAROOT=%~dp0data"
if exist "%DATAROOT%\worldfoundry.env" (
  rem portable version: data is next to the script, no elevated rights needed
  set "CONFIG_FILE=%DATAROOT%\worldfoundry.env"
  goto run
)
set "CONFIG_FILE=%ProgramData%\WorldFoundry\worldfoundry.env"
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
:run
set "NODE_ENV=production"
"%~dp0node\node.exe" "%~dp0app\backend\dist\cli.js" reset-password %*
echo.
pause
