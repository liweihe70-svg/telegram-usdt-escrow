@echo off
rem Started from the Windows Startup folder: launch the mainnet backend quietly, no browser window.
cd /d "%~dp0.."
node scripts\start-production-panel.mjs --mainnet >> data\production-mainnet-service\autostart.log 2>&1
