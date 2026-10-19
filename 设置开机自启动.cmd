@echo off
rem Adds a small launcher to the current user's Startup folder. Run "取消开机自启动.cmd" to undo.
cd /d "%~dp0"
set "TARGET=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\escrow-mainnet-autostart.cmd"
> "%TARGET%" echo @echo off
>> "%TARGET%" echo call "%~dp0scripts\autostart-mainnet.cmd"
if exist "%TARGET%" (
  echo Autostart enabled: %TARGET%
) else (
  echo Failed to create %TARGET%
)
pause
