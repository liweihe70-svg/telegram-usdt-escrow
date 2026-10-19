@echo off
set "TARGET=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\escrow-mainnet-autostart.cmd"
if exist "%TARGET%" (
  del "%TARGET%"
  echo Autostart removed.
) else (
  echo Autostart was not enabled.
)
pause
