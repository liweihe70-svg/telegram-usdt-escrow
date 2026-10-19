@echo off
cd /d "%~dp0"
node scripts\manage-panel.mjs update
if errorlevel 1 (pause & exit /b 1)
start "" "http://127.0.0.1:8781/"
