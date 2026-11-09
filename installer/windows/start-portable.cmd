@echo off
rem Start WorldFoundry without installation and without a service (Windows, ZIP package).
rem Data, servers and configuration are in the folder "data" next to this script.
rem Older portable versions used the folder "daten": if that exists and "data" does not, it keeps being used.
rem Stop with Ctrl+C: Minecraft servers are stopped cleanly.
setlocal
cd /d "%~dp0"
set "DATAROOT=%~dp0data"
if not exist "%~dp0data\" if exist "%~dp0daten\" set "DATAROOT=%~dp0daten"
rem Older versions called the credentials file Zugangsdaten.txt: rename it (or drop it if credentials.txt already exists)
if exist "%DATAROOT%\Zugangsdaten.txt" (
  if exist "%DATAROOT%\credentials.txt" (
    del "%DATAROOT%\Zugangsdaten.txt"
  ) else (
    ren "%DATAROOT%\Zugangsdaten.txt" credentials.txt
  )
)
if not exist "%DATAROOT%\worldfoundry.env" (
  "%~dp0node\node.exe" "%~dp0tools\setup-config.mjs" --config "%DATAROOT%\worldfoundry.env" --data-dir "%DATAROOT%\data" --servers-dir "%DATAROOT%\servers" --host 127.0.0.1 --credentials-file "%DATAROOT%\credentials.txt"
  if errorlevel 1 exit /b 1
  echo.
  echo The access token is in "%DATAROOT%\credentials.txt".
  echo.
)
set "CONFIG_FILE=%DATAROOT%\worldfoundry.env"
set "NODE_ENV=production"
echo NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
echo.
echo The addresses are shown in the log in a moment. Port and address: %CONFIG_FILE%
:start
"%~dp0node\node.exe" "%~dp0app\backend\dist\index.js"
rem Exit code 75: restart from the web interface (System, Network and access); here it restarts by itself
if %errorlevel%==75 (
  echo.
  echo WorldFoundry is restarting ...
  goto start
)
