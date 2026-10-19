@echo off
cd /d "%~dp0"
echo Starting MAINNET (real USDT) backend on port 8784 ...
node scripts\start-production-panel.mjs --mainnet
if errorlevel 1 (
  pause
  exit /b 1
)
start "" "http://127.0.0.1:8784/"
